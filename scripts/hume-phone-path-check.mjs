import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { checkPlaygroundSessionLifecycle } from './check-playground-session-lifecycle.mjs'
import {
  analyzePcm16,
  bufferToInt16LE,
  decodeTelnyxPayload,
  decodeWavPcm16,
  encodePcm16LeToUlaw,
  int16ToBufferLE,
  levelPcm16ForPhone,
  pcm16IsAudible,
  resamplePcm16,
} from '../server/audio.mjs'
import { recentCallSummaries } from '../server/call-history.mjs'
import {
  HUME_INPUT_PRIMER_CHUNK_MS,
  applyHumeHandshakeSessionSettings,
  buildHumeCodexPromptContext,
  humeAudioSessionSettings,
  humeInputPrimerFrame,
  stripHumeCodexPromptContext,
} from '../server/hume-session.mjs'
import {
  DEFAULT_END_OF_TURN_SILENCE_MS,
  missingForCall,
  normalizeCampaignConfig,
} from '../server/runtime-config.mjs'
import {
  clearTelnyxOutboundQueue,
  enqueuePcmToTelnyx,
  queueTelnyxPcmFrames,
  TELNYX_FRAME_MS,
  TELNYX_MAX_QUEUE_MS,
} from '../server/telnyx-audio-queue.mjs'
import {
  addTransportCounter,
  buildTransportDiagnosticSnapshot,
  createTransportDiagnostics,
  recordTransportMilestone,
  recordTransportMilestoneAt,
  setTransportDiagnosticValue,
} from '../server/transport-diagnostics.mjs'
import {
  bufferBrowserAudioBeforeAttach,
  bufferVoiceInputBeforeReady,
  clearBrowserAudioBeforeAttach,
  clearVoiceInputBeforeReady,
  drainBrowserAudioBeforeAttach,
  drainVoiceInputBeforeReady,
  noteCallerSpeechStopped,
  noteFinalUserTurn,
  noteFirstAssistantAudio,
  noteVoiceInputPcmActivity,
  selectHumeUserInputTransport,
} from '../server/voice-turn-transport.mjs'
import * as voiceTurnTransport from '../server/voice-turn-transport.mjs'

let provisionalVoiceSessionModule = null
try {
  provisionalVoiceSessionModule = await import('../server/provisional-voice-session.mjs')
} catch {
  // The assertion below turns a missing lifecycle module into an intentional RED test.
}
assert.ok(
  provisionalVoiceSessionModule,
  'provisional voice-session lifecycle module must exist',
)
const {
  createProvisionalVoiceSessionRegistry,
  drainProvisionalVoiceSessionEvents,
  queueProvisionalVoiceSessionEvent,
} = provisionalVoiceSessionModule

let callToolsVoiceStandbyModule = null
try {
  callToolsVoiceStandbyModule = await import('../server/calltools-voice-standby.mjs')
} catch {
  // The assertion below turns a missing standby coordinator into an intentional RED test.
}
assert.ok(
  callToolsVoiceStandbyModule,
  'CallTools voice standby coordinator must exist',
)
const {
  callToolsVoiceStandbyRuntimeFingerprint,
  callToolsVoiceStandbyScopeKey,
  createCallToolsVoiceStandbyCoordinator,
} = callToolsVoiceStandbyModule

let playgroundStartRequestsModule = null
try {
  playgroundStartRequestsModule = await import('../server/playground-start-requests.mjs')
} catch {
  // The assertion below turns a missing cancellation registry into an intentional RED test.
}
assert.ok(
  playgroundStartRequestsModule,
  'Playground start cancellation registry must exist',
)
const {
  createPlaygroundStartRequestRegistry,
  normalizePlaygroundStartRequestId,
} = playgroundStartRequestsModule

let voiceInterruptionRecoveryModule = null
try {
  voiceInterruptionRecoveryModule = await import('../server/voice-interruption-recovery.mjs')
} catch {
  // The assertion below turns a missing silence-recovery controller into an intentional RED test.
}
assert.ok(
  voiceInterruptionRecoveryModule,
  'voice interruption silence-recovery controller must exist',
)
const {
  INTERRUPTION_SILENCE_RECOVERY_INPUT,
  createVoiceInterruptionRecovery,
} = voiceInterruptionRecoveryModule

let voiceProviderSyncPolicyModule = null
try {
  voiceProviderSyncPolicyModule = await import('../server/voice-provider-sync-policy.mjs')
} catch {
  // The assertion below turns provider/profile drift into an intentional RED test.
}
assert.ok(
  voiceProviderSyncPolicyModule,
  'voice provider sync policy must exist',
)
const {
  humeProviderNudgeIntervalSeconds,
  voiceProviderConfigSyncRequired,
} = voiceProviderSyncPolicyModule

const sampleRate = 16000
const playgroundSessionLifecycle = await checkPlaygroundSessionLifecycle()

assert.equal(
  voiceProviderConfigSyncRequired({
    voiceRuntimeProvider: 'speak',
    agentProfileUpdatedAt: '2026-07-17T17:45:08.384Z',
    humeConfigSyncedAt: '2026-07-17T00:25:12.702Z',
  }),
  true,
  'a Hume profile changed long after its provider sync must reconcile before the next session',
)
assert.equal(
  voiceProviderConfigSyncRequired({
    voiceRuntimeProvider: 'speak',
    agentProfileUpdatedAt: '2026-07-17T17:45:08.384Z',
    humeConfigSyncedAt: '2026-07-17T17:45:06.000Z',
  }),
  false,
  'profile persistence immediately following provider sync must not trigger a second sync',
)
assert.equal(
  voiceProviderConfigSyncRequired({
    voiceRuntimeProvider: 'speak',
    humeConfigSyncedAt: '2026-07-17T00:25:12.702Z',
  }),
  false,
  'an ad hoc runtime without saved-profile revision proof must not gain a blocking provider write',
)
assert.equal(humeProviderNudgeIntervalSeconds(1), 3)
assert.equal(humeProviderNudgeIntervalSeconds(4), 4)
assert.equal(humeProviderNudgeIntervalSeconds(90), 60)
assert.equal(humeProviderNudgeIntervalSeconds(undefined), undefined)

let interruptionRecoveryNow = 1_000
let interruptionRecoverySequence = 0
const interruptionRecoveryTimers = []
const scheduleInterruptionRecovery = (callback, delayMs) => {
  const timer = {
    callback,
    canceled: false,
    dueAt: interruptionRecoveryNow + delayMs,
    id: ++interruptionRecoverySequence,
    unref() {},
  }
  interruptionRecoveryTimers.push(timer)
  return timer
}
const cancelInterruptionRecovery = (timer) => {
  if (timer) timer.canceled = true
}
const runNextInterruptionRecoveryTimer = async () => {
  const timer = interruptionRecoveryTimers
    .filter((candidate) => !candidate.canceled)
    .sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)[0]
  assert.ok(timer, 'expected a pending interruption recovery timer')
  timer.canceled = true
  interruptionRecoveryNow = timer.dueAt
  await timer.callback()
}
const interruptionRecoveryStates = new Map()
const interruptionRecoverySends = []
const interruptionRecovery = createVoiceInterruptionRecovery({
  resolveState: (callControlId) => interruptionRecoveryStates.get(callControlId) || null,
  sendRecovery: async (state, text, metadata) => {
    interruptionRecoverySends.push({ state, text, metadata, at: interruptionRecoveryNow })
    return true
  },
  now: () => interruptionRecoveryNow,
  schedule: scheduleInterruptionRecovery,
  cancelScheduled: cancelInterruptionRecovery,
})
const falseInterruptionState = {
  callControlId: 'false-interruption-silence',
  config: { nudgesIntervalSeconds: 1 },
  eventLog: [],
  ending: false,
  outcome: '',
}
interruptionRecoveryStates.set(falseInterruptionState.callControlId, falseInterruptionState)
assert.equal(
  interruptionRecovery.arm(falseInterruptionState, {
    provider: 'hume',
    reason: 'user_interruption',
  }),
  true,
)
await runNextInterruptionRecoveryTimer()
assert.equal(interruptionRecoverySends.length, 1)
assert.equal(interruptionRecoverySends[0].text, INTERRUPTION_SILENCE_RECOVERY_INPUT)
assert.equal(interruptionRecoverySends[0].metadata.reason, 'interruption_silence_recovery')
assert.equal(
  interruptionRecoverySends[0].at,
  2_350,
  'Speak fallback must give Hume native nudges a short cancellation window',
)

interruptionRecoveryNow = 10_000
const realInterruptionState = {
  callControlId: 'real-interruption-caller-continues',
  config: { nudgesIntervalSeconds: 1 },
  eventLog: [],
  ending: false,
  outcome: '',
}
interruptionRecoveryStates.set(realInterruptionState.callControlId, realInterruptionState)
assert.equal(interruptionRecovery.arm(realInterruptionState, { provider: 'hume' }), true)
realInterruptionState.lastVoiceInputSpeechAtMs = 10_800
await runNextInterruptionRecoveryTimer()
assert.equal(interruptionRecoverySends.length, 1)
realInterruptionState.lastUserFinalAt = 11_200
interruptionRecovery.noteFinalCallerTurn(realInterruptionState)
assert.equal(
  interruptionRecoveryTimers.filter((candidate) => !candidate.canceled).length,
  0,
)
assert.equal(interruptionRecoverySends.length, 1)

let playgroundStartNow = 1_000
const playgroundStartRequests = createPlaygroundStartRequestRegistry({
  ttlMs: 100,
  maxEntries: 3,
  now: () => playgroundStartNow,
})
const browserStartRequestId = 'playground-browser-request-0001'
assert.equal(normalizePlaygroundStartRequestId(` ${browserStartRequestId} `), browserStartRequestId)
assert.equal(normalizePlaygroundStartRequestId('bad id'), '')
assert.equal(
  playgroundStartRequests.begin({ id: browserStartRequestId, mode: 'browser' }).accepted,
  true,
)
assert.equal(
  playgroundStartRequests.begin({ id: browserStartRequestId, mode: 'browser' }).reason,
  'duplicate',
)
const canceledBeforeStartId = 'playground-phone-request-0002'
assert.equal(playgroundStartRequests.cancel(canceledBeforeStartId).canceled, true)
assert.equal(
  playgroundStartRequests.begin({ id: canceledBeforeStartId, mode: 'phone' }).reason,
  'canceled',
)
assert.equal(
  playgroundStartRequests.bind(canceledBeforeStartId, {
    mode: 'phone',
    sessionId: 'telnyx-call-after-cancel',
  }).sessionId,
  'telnyx-call-after-cancel',
)
playgroundStartNow += 1_001
assert.equal(playgroundStartRequests.get(browserStartRequestId), null)
assert.equal(
  playgroundSessionLifecycle.ok,
  true,
  `Playground Browser session lifecycle failed: ${playgroundSessionLifecycle.failures?.join('; ')}`,
)
const samples = sineWave({ frequency: 440, sampleRate, seconds: 0.32 })
const pcm = int16ToBufferLE(samples)

const sessionAudio = humeAudioSessionSettings(sampleRate)
assert.deepEqual(sessionAudio, {
  encoding: 'linear16',
  sample_rate: sampleRate,
  channels: 1,
})
assert.equal(Object.hasOwn(sessionAudio, 'format'), false)
assert.equal(DEFAULT_END_OF_TURN_SILENCE_MS, 500)
assert.equal(HUME_INPUT_PRIMER_CHUNK_MS, 100)
const humePrimerFrame = humeInputPrimerFrame(sampleRate)
assert.equal(humePrimerFrame.length, 3_200)
assert.equal(
  humePrimerFrame.every((byte) => byte === 0),
  true,
  'Hume input priming must use 100 ms of digital silence without altering caller audio',
)
const humeHandshakePrompt = 'Exact selected profile prompt\nwith runtime guardrails.'
const humeHandshakeUrl = new URL('wss://api.hume.ai/v0/evi/chat')
applyHumeHandshakeSessionSettings(humeHandshakeUrl, {
  system_prompt: humeHandshakePrompt,
  custom_session_id: 'profile-scoped-call-id',
  language_model_api_key: 'must-not-enter-the-url',
})
assert.equal(
  humeHandshakeUrl.searchParams.get('session_settings[system_prompt]'),
  humeHandshakePrompt,
)
assert.equal(
  humeHandshakeUrl.searchParams.get('session_settings[custom_session_id]'),
  'profile-scoped-call-id',
)
assert.equal(humeHandshakeUrl.searchParams.has('session_settings'), false)
assert.equal(
  humeHandshakeUrl.toString().includes('must-not-enter-the-url'),
  false,
  'Hume handshake settings must never put the supplemental LLM credential in the URL',
)
const humeCodexPromptContext = buildHumeCodexPromptContext(
  humeHandshakePrompt,
  '<current_contact>Vapi Test</current_contact>',
)
assert.match(humeCodexPromptContext, /<active_profile_instructions>/)
assert.match(humeCodexPromptContext, /Exact selected profile prompt/)
assert.match(humeCodexPromptContext, /<current_contact>Vapi Test<\/current_contact>/)
assert.equal(
  stripHumeCodexPromptContext(humeCodexPromptContext),
  '<current_contact>Vapi Test</current_contact>',
  'the Codex bridge must remove Hume\'s mirrored prompt because its correlated system copy is authoritative',
)

const phoneReadinessEnvKeys = [
  'GOG_WRAPPER',
  'HUME_API_KEY',
  'PUBLIC_BASE_URL',
  'TELNYX_API_KEY',
  'TELNYX_CONNECTION_ID',
  'TELNYX_FROM_NUMBER',
  'TELNYX_MESSAGING_PROFILE_ID',
  'TELNYX_SMS_FROM',
  'TELNYX_SMS_NUMBER',
  'TELNYX_WEBHOOK_SIGNATURE_REQUIRED',
  'WORKSPACE_EMAIL_ACCOUNT',
]
const savedPhoneReadinessEnv = Object.fromEntries(
  phoneReadinessEnvKeys.map((key) => [key, process.env[key]]),
)
for (const key of phoneReadinessEnvKeys) delete process.env[key]
Object.assign(process.env, {
  HUME_API_KEY: 'transport-test-hume-key',
  PUBLIC_BASE_URL: 'https://speak.example.test/speak',
  TELNYX_API_KEY: 'transport-test-telnyx-key',
  TELNYX_CONNECTION_ID: 'transport-test-call-control',
  TELNYX_FROM_NUMBER: '+12125550100',
  TELNYX_WEBHOOK_SIGNATURE_REQUIRED: 'false',
})
const voiceOnlyPhoneConfig = normalizeCampaignConfig({
  humeConfigId: 'transport-test-hume-config',
  languageModelMode: 'hume',
  telnyxCallerId: '+12125550100',
  telnyxConnectionId: 'transport-test-call-control',
  voiceRuntimeProvider: 'hume',
})
assert.deepEqual(
  missingForCall(voiceOnlyPhoneConfig),
  [],
  'Browser and Phone voice transport must not be blocked by optional SMS or Workspace email connector readiness',
)
for (const key of phoneReadinessEnvKeys) {
  if (savedPhoneReadinessEnv[key] === undefined) delete process.env[key]
  else process.env[key] = savedPhoneReadinessEnv[key]
}

const preReadyState = { sampleRate }
const preReadyFrames = [1, 2, 3].map((value) => Buffer.alloc(640, value))
for (const frame of preReadyFrames) {
  bufferVoiceInputBeforeReady(preReadyState, frame, { maxDurationMs: 40 })
}
const preReadyDrain = drainVoiceInputBeforeReady(preReadyState)
assert.equal(preReadyDrain.frames.length, 2)
assert.equal(Buffer.compare(preReadyDrain.frames[0], preReadyFrames[1]), 0)
assert.equal(Buffer.compare(preReadyDrain.frames[1], preReadyFrames[2]), 0)
assert.equal(preReadyDrain.droppedFrames, 1)
assert.equal(preReadyDrain.bufferedDurationMs, 40)
assert.equal(drainVoiceInputBeforeReady(preReadyState).frames.length, 0)

const browserAudioAttachState = { sampleRate }
const browserAudioFrames = [1, 2, 3].map((value) => Buffer.alloc(640, value))
for (const frame of browserAudioFrames) {
  bufferBrowserAudioBeforeAttach(browserAudioAttachState, frame, {
    maxDurationMs: 40,
  })
}
const browserAudioDrain = drainBrowserAudioBeforeAttach(browserAudioAttachState)
assert.equal(browserAudioDrain.frames.length, 2)
assert.equal(Buffer.compare(browserAudioDrain.frames[0], browserAudioFrames[0]), 0)
assert.equal(Buffer.compare(browserAudioDrain.frames[1], browserAudioFrames[1]), 0)
assert.equal(browserAudioDrain.bufferedDurationMs, 40)
assert.equal(browserAudioDrain.droppedFrames, 1)
assert.equal(browserAudioDrain.droppedBytes, 640)
assert.equal(drainBrowserAudioBeforeAttach(browserAudioAttachState).frames.length, 0)

bufferBrowserAudioBeforeAttach(browserAudioAttachState, browserAudioFrames[0], {
  maxDurationMs: 40,
})
assert.equal(clearBrowserAudioBeforeAttach(browserAudioAttachState).bufferedFrames, 1)
assert.equal(drainBrowserAudioBeforeAttach(browserAudioAttachState).frames.length, 0)

const immediateSpeechFrame = int16ToBufferLE(
  Int16Array.from({ length: 320 }, (_, index) =>
    Math.round(Math.sin((index / 320) * Math.PI * 8) * 9_000),
  ),
)
const silenceFrame = Buffer.alloc(640)
const speechAwareState = { sampleRate }
bufferVoiceInputBeforeReady(speechAwareState, immediateSpeechFrame, {
  maxDurationMs: 60,
})
for (let index = 0; index < 5; index += 1) {
  bufferVoiceInputBeforeReady(speechAwareState, silenceFrame, {
    maxDurationMs: 60,
  })
}
const speechAwareDrain = drainVoiceInputBeforeReady(speechAwareState)
assert.equal(speechAwareDrain.bufferedDurationMs, 60)
assert.equal(speechAwareDrain.frames.length, 3)
assert.equal(
  Buffer.compare(speechAwareDrain.frames[0], immediateSpeechFrame),
  0,
  'bounded pre-ready retention must preserve the immediate spoken hello before silence',
)
assert.equal(speechAwareDrain.speechFrames, 1)
assert.equal(speechAwareDrain.droppedSpeechFrames, 0)
assert.equal(speechAwareDrain.droppedSilenceFrames, 3)

const scheduled = []
const canceledTimers = []
const closedProvisionalSessions = []
let lifecycleNow = 1_000
const provisionalRegistry = createProvisionalVoiceSessionRegistry({
  ttlMs: 2_000,
  now: () => lifecycleNow,
  schedule: (callback, delayMs) => {
    const timer = { callback, delayMs, unref() {} }
    scheduled.push(timer)
    return timer
  },
  cancelScheduled: (timer) => canceledTimers.push(timer),
  closeState: (state, reason) => {
    closedProvisionalSessions.push({ state, reason })
  },
})
const provisionalConfig = {
  voiceRuntimeProvider: 'inworld',
  inworldRealtimeModel: 'inworld/voice-runtime',
  promptExpansionEnabled: false,
}
const provisionalState = {
  callControlId: 'provisional-outbound-1',
  config: provisionalConfig,
}
provisionalRegistry.prepare({ key: 'outbound-1', state: provisionalState })
assert.equal(provisionalRegistry.size, 1)
assert.equal(scheduled[0].delayMs, 2_000)
assert.equal(
  queueProvisionalVoiceSessionEvent(provisionalState, { notice: 'provider ready' }),
  true,
)
const boundSession = provisionalRegistry.bind('outbound-1', {
  callControlId: 'telnyx-call-1',
})
assert.equal(boundSession.state, provisionalState)
assert.equal(provisionalState.callControlId, 'telnyx-call-1')
assert.equal(provisionalState.config, provisionalConfig)
assert.deepEqual(provisionalState.config, provisionalConfig)
assert.equal(provisionalRegistry.size, 0)
assert.equal(canceledTimers.length, 1)
assert.deepEqual(drainProvisionalVoiceSessionEvents(provisionalState), [
  { notice: 'provider ready' },
])

const failedDialState = {
  callControlId: 'provisional-outbound-failed',
  config: { voiceRuntimeProvider: 'hume', humeConfigId: 'hume-config' },
}
provisionalRegistry.prepare({ key: 'outbound-failed', state: failedDialState })
assert.equal(provisionalRegistry.cancel('outbound-failed', 'dial_failed'), true)
assert.equal(closedProvisionalSessions.at(-1)?.state, failedDialState)
assert.equal(closedProvisionalSessions.at(-1)?.reason, 'dial_failed')
assert.equal(failedDialState.ending, true)

const expiredState = {
  callControlId: 'personal-phone-call',
  config: { voiceRuntimeProvider: 'hume', humeConfigId: 'hume-config' },
}
provisionalRegistry.prepare({ key: 'personal-phone-correlation', state: expiredState })
lifecycleNow = 3_100
scheduled.at(-1).callback()
assert.equal(closedProvisionalSessions.at(-1)?.state, expiredState)
assert.equal(closedProvisionalSessions.at(-1)?.reason, 'ttl_expired')
assert.equal(provisionalRegistry.size, 0)

const shutdownState = {
  callControlId: 'provisional-shutdown',
  config: { voiceRuntimeProvider: 'inworld' },
}
provisionalRegistry.prepare({ key: 'shutdown', state: shutdownState })
assert.equal(provisionalRegistry.cancelAll('shutdown'), 1)
assert.equal(closedProvisionalSessions.at(-1)?.reason, 'shutdown')

const longLivedStandbyState = {
  callControlId: 'calltools-long-lived-standby',
  config: { voiceRuntimeProvider: 'hume' },
}
provisionalRegistry.prepare({
  key: 'long-lived-standby',
  state: longLivedStandbyState,
  ttlMs: 5 * 60_000,
})
assert.equal(
  scheduled.at(-1)?.delayMs,
  5 * 60_000,
  'CallTools standby must support a longer bounded lifetime than direct dial preconnect',
)
provisionalRegistry.cancel('long-lived-standby', 'test_complete')

const overlongStandbyState = {
  callControlId: 'calltools-overlong-standby',
  config: { voiceRuntimeProvider: 'hume' },
}
provisionalRegistry.prepare({
  key: 'overlong-standby',
  state: overlongStandbyState,
  ttlMs: 60 * 60_000,
})
assert.equal(
  scheduled.at(-1)?.delayMs,
  10 * 60_000,
  'provider preconnect lifetime must remain bounded even when misconfigured',
)
provisionalRegistry.cancel('overlong-standby', 'test_complete')

const standbyRecords = new Map()
const standbyPrepared = []
const standbyCanceled = []
const standbyCoordinator = createCallToolsVoiceStandbyCoordinator({
  prepare: ({ key, scope }) => {
    const state = { key, scope, socketReady: true }
    standbyRecords.set(key, { state })
    standbyPrepared.push(state)
    return state
  },
  cancel: (key, reason) => {
    standbyRecords.delete(key)
    standbyCanceled.push({ key, reason })
    return true
  },
  get: (key) => standbyRecords.get(key) || null,
  isHealthy: (state) => state.socketReady === true,
})
const standbyHumeConfig = {
  voiceRuntimeProvider: 'hume',
  humeConfigId: 'hume-config-a',
  voice: 'hume-voice-a',
  codexFastMode: true,
  instructions: 'Use the current saved profile instructions.',
}
const standbyHumeFingerprint = callToolsVoiceStandbyRuntimeFingerprint({
  config: standbyHumeConfig,
  generation: 'profile-generation-1',
})
assert.match(standbyHumeFingerprint, /^[a-f0-9]{64}$/)
assert.equal(
  callToolsVoiceStandbyRuntimeFingerprint({
    config: {
      instructions: standbyHumeConfig.instructions,
      codexFastMode: true,
      voice: 'hume-voice-a',
      humeConfigId: 'hume-config-a',
      voiceRuntimeProvider: 'hume',
    },
    generation: 'profile-generation-1',
  }),
  standbyHumeFingerprint,
  'standby runtime fingerprint must be stable across object key order',
)
const standbyScope = {
  leaseId: 'lease-a',
  profileId: 'profile-a',
  config: standbyHumeConfig,
  runtimeGeneration: 'profile-generation-1',
  binding: {
    appUserId: 'user-a',
    campaignId: 'campaign-a',
    phoneId: 'phone-a',
  },
}
assert.equal(
  callToolsVoiceStandbyScopeKey({
    leaseId: standbyScope.leaseId,
    profileId: standbyScope.profileId,
    binding: standbyScope.binding,
  }),
  '',
  'standby scope must fail closed when its operational runtime config is absent',
)
assert.equal(
  callToolsVoiceStandbyScopeKey(standbyScope),
  `lease-a\u0000profile-a\u0000user-a\u0000campaign-a\u0000phone-a\u0000${standbyHumeFingerprint}`,
)
assert.equal(
  callToolsVoiceStandbyScopeKey({
    ...standbyScope,
    runtimeGeneration: '',
    profile: { updatedAt: 'profile-generation-1' },
  }),
  callToolsVoiceStandbyScopeKey(standbyScope),
  'saved profile updatedAt must provide the standby runtime generation when one is not explicit',
)
const standbyA = standbyCoordinator.ensure(standbyScope)
assert.equal(standbyCoordinator.ensure(standbyScope), standbyA)
assert.equal(standbyPrepared.length, 1)
const regeneratedStandby = standbyCoordinator.ensure({
  ...standbyScope,
  runtimeGeneration: 'profile-generation-2',
})
assert.notEqual(regeneratedStandby, standbyA)
assert.equal(standbyCanceled.at(-1)?.reason, 'scope_changed')
const reconfiguredStandby = standbyCoordinator.ensure({
  ...standbyScope,
  runtimeGeneration: 'profile-generation-2',
  config: { ...standbyHumeConfig, voice: 'hume-voice-b' },
})
assert.notEqual(reconfiguredStandby, regeneratedStandby)
assert.equal(standbyCanceled.at(-1)?.reason, 'scope_changed')
const inworldStandbyScope = {
  ...standbyScope,
  runtimeGeneration: 'profile-generation-3',
  config: {
    voiceRuntimeProvider: 'inworld',
    inworldConfigId: 'inworld-config-a',
    inworldRealtimeModel: 'inworld/model-a',
    voice: 'inworld-voice-a',
    codexFastMode: true,
    instructions: standbyHumeConfig.instructions,
  },
}
const inworldStandby = standbyCoordinator.ensure(inworldStandbyScope)
assert.notEqual(inworldStandby, reconfiguredStandby)
assert.equal(standbyCanceled.at(-1)?.reason, 'scope_changed')
let staleStandbyBindCalled = false
assert.equal(
  standbyCoordinator.claim(standbyScope, () => {
    staleStandbyBindCalled = true
  }),
  null,
  'a native invite must not claim a standby created for an older runtime/config generation',
)
assert.equal(staleStandbyBindCalled, false)
const claimedInworldStandby = standbyCoordinator.claim(
  inworldStandbyScope,
  ({ state }) => ({ state, claimed: true }),
)
assert.equal(claimedInworldStandby.claimed, true)
assert.equal(claimedInworldStandby.state, inworldStandby)
assert.equal(claimedInworldStandby.state.scope.config.voiceRuntimeProvider, 'inworld')
const changedStandby = standbyCoordinator.ensure({
  ...standbyScope,
  binding: { ...standbyScope.binding, phoneId: 'phone-b' },
})
assert.notEqual(changedStandby, standbyA)
assert.equal(standbyCanceled.at(-1)?.reason, 'scope_changed')
changedStandby.socketReady = false
const replenishedStandby = standbyCoordinator.ensure({
  ...standbyScope,
  binding: { ...standbyScope.binding, phoneId: 'phone-b' },
})
assert.notEqual(replenishedStandby, changedStandby)
assert.equal(standbyCanceled.at(-1)?.reason, 'standby_unhealthy')
const claimedStandby = standbyCoordinator.claim(
  {
    ...standbyScope,
    binding: { ...standbyScope.binding, phoneId: 'phone-b' },
  },
  ({ key, state }) => ({ key, state, claimed: true }),
)
assert.equal(claimedStandby.claimed, true)
assert.equal(claimedStandby.state, replenishedStandby)
assert.equal(standbyCoordinator.active, null)
standbyCoordinator.ensure(standbyScope)
assert.equal(standbyCoordinator.cancel('unavailable'), true)
assert.equal(standbyCanceled.at(-1)?.reason, 'unavailable')

const serverIndex = readFileSync(
  new URL('../server/index.mjs', import.meta.url),
  'utf8',
)
const humeConnector = sourceBetween(
  serverIndex,
  'function connectHume',
  'async function activatePrewarmedHumeSession',
)
assertOrdered(
  humeConnector,
  [
    'applyHumeHandshakeSessionSettings',
    'const ws = new WebSocket(url)',
  ],
  'Hume must receive the call-scoped custom session ID before its WebSocket opens',
)
assert.match(
  serverIndex,
  /const providerContext = codexAuthSession[\s\S]*buildHumeCodexPromptContext\(systemPrompt, context\)[\s\S]*text: providerContext/,
  'Hume Codex-auth quick responses must receive the exact selected profile prompt through persistent session context',
)
assert.match(
  serverIndex,
  /async function ensureVoiceRuntimeReady[\s\S]{0,600}!voiceProviderConfigSyncRequired\(runtimeConfig\)[\s\S]{0,300}ensureVoiceProviderConfigReady\(runtimeConfig\)/,
  'a stale saved Hume profile must reconcile once before the next voice session',
)
assert.match(
  serverIndex,
  /message\.type === 'user_interruption'[\s\S]{0,1200}voiceInterruptionRecovery\.arm\(state, \{[\s\S]{0,180}provider: 'hume'/,
  'a Hume interruption must arm provider-independent silence recovery',
)
assert.match(
  serverIndex,
  /function handleFinalUserTranscript[\s\S]{0,500}voiceInterruptionRecovery\.noteFinalCallerTurn\(state\)/,
  'a completed caller turn must cancel Inworld silence recovery',
)
const voiceInputSender = sourceBetween(
  serverIndex,
  'function sendAudioToVoiceProvider',
  'function shouldBufferVoiceInputBeforeReady',
)
assert.match(
  voiceInputSender,
  /state\.voiceInputMediaStarted\s*=\s*true[\s\S]*stopHumeInputPrimer\(state, 'media_started'\)/,
  'the first real Browser or phone frame must replace Hume input priming immediately',
)
assert.match(
  voiceInputSender,
  /conditionPhoneVoiceInputPcm\(state, pcmLittleEndian/,
  'non-browser Hume and Inworld phone input must share carrier-noise conditioning',
)
assert.match(
  voiceInputSender,
  /sendAudioToInworld\(state, voiceInputPcm\)/,
  'Inworld phone input must receive the conditioned PCM stream',
)
assert.match(
  voiceInputSender,
  /sendAudioToHume\(state, voiceInputPcm\)/,
  'Hume phone input must receive the conditioned PCM stream',
)
assert.match(
  serverIndex,
  /recordCallStageAudioBuffer\(state, \{[\s\S]{0,180}stage: 'lead-calltools-input'[\s\S]{0,320}sendAudioToVoiceProvider\(state, pcm\)/,
  'CallTools must retain raw caller audio before conditioning the provider input',
)
assert.match(
  serverIndex,
  /function handleInworldAudioDelta[\s\S]{0,700}const audible = pcm16IsAudible[\s\S]{0,500}if \(audible\) \{[\s\S]{0,300}noteFirstAssistantAudio/,
  'Inworld latency must start on audible PCM rather than its first output packet',
)
assert.match(
  serverIndex,
  /message\.type === 'audio_output'[\s\S]{0,700}const audible = pcm16IsAudible[\s\S]{0,500}if \(audible\) \{[\s\S]{0,300}noteFirstAssistantAudio/,
  'Hume latency must start on audible decoded PCM rather than its first output packet',
)
const outboundStartRoute = sourceBetween(
  serverIndex,
  "app.post('/api/calls/start'",
  "app.post('/api/calls/:callControlId/barge-in'",
)
assert.match(
  outboundStartRoute,
  /beginPlaygroundStartRequest\([\s\S]*startRequestId/,
  'Playground Phone must register its client start request before provider work',
)
assert.match(
  outboundStartRoute,
  /playgroundStartRequestCanceled\([\s\S]*hangupCanceledPlaygroundPhoneStart\(/,
  'a canceled Phone start accepted by Telnyx must be hung up immediately',
)
assert.match(
  outboundStartRoute,
  /ensureVoiceRuntimeReady\(runtimeConfig,[\s\S]{0,500}syncProvider: isInworldRuntime\(runtimeConfig\)/,
  'direct Phone starts must use the already-saved Hume config instead of synchronously resyncing Hume',
)
assertOrdered(
  outboundStartRoute,
  [
    'prepareProvisionalVoiceSession(',
    `fetch(\`${'${TELNYX_API_BASE}'}/calls\``,
    'bindProvisionalVoiceSession(',
  ],
  'outbound Phone and Playground Phone must start voice preconnect before waiting for Telnyx and bind it after acceptance',
)
assert.match(outboundStartRoute, /provisionalVoiceSessionId/)
assert.match(outboundStartRoute, /cancelProvisionalVoiceSession\([\s\S]*dial_failed/)
assert.match(outboundStartRoute, /cancelProvisionalVoiceSession\([\s\S]*missing_call_control_id/)

const browserStartRoute = sourceBetween(
  serverIndex,
  "app.post('/api/config-tests/start'",
  "app.post('/api/config-tests/:testId/end'",
)
assert.match(
  browserStartRoute,
  /beginPlaygroundStartRequest\([\s\S]*playgroundStartRequestCanceled\(/,
  'Browser tests must register and recheck the client cancellation tombstone',
)
assert.match(
  browserStartRoute,
  /ensureVoiceRuntimeReady\(runtimeConfig,[\s\S]{0,500}syncProvider: isInworldRuntime\(runtimeConfig\)/,
  'Browser starts must use the already-saved Hume config instead of synchronously resyncing Hume',
)
assert.match(
  browserStartRoute,
  /state\.browserAudioAttachPending\s*=\s*true[\s\S]*connectVoiceSession\(state\)/,
  'Browser starts must arm assistant-audio retention before the provider can emit a greeting',
)

const playgroundCancellationRoute = sourceBetween(
  serverIndex,
  "app.post('/api/playground-starts/:startRequestId/cancel'",
  "app.post('/api/config-tests/start'",
)
assert.match(playgroundCancellationRoute, /cancelPlaygroundStartRequest\(/)
assert.match(playgroundCancellationRoute, /cancelAttachedPlaygroundStart\(/)

const playgroundSessionHook = readFileSync(
  new URL('../src/useConfigurationTestSession.ts', import.meta.url),
  'utf8',
)
assert.match(playgroundSessionHook, /pendingStartRequestRef/)
assert.match(playgroundSessionHook, /startRequestId/)
assert.match(
  playgroundSessionHook,
  /sendBeacon|keepalive:\s*true/,
  'Playground unmount must send a keepalive cancellation for a pending start',
)

const browserAudioSocketHandler = sourceBetween(
  serverIndex,
  "browserTestWss.on('connection'",
  "app.use(express.static(distPath))",
)
assert.match(
  browserAudioSocketHandler,
  /state\.browserAudioAttachPending\s*=\s*false[\s\S]*flushBrowserAudioBeforeAttach\(state, ws\)/,
  'Browser audio attach must synchronously flush retained assistant audio in order',
)

const humeBrowserAudioSender = sourceBetween(
  serverIndex,
  'function sendHumeAudioToBrowser',
  'function sendHumeAudioToCallToolsGateway',
)
assert.match(
  humeBrowserAudioSender,
  /sendAssistantPcmToBrowser\(state, int16ToBufferLE\(leveled\)\)/,
  'Hume Browser output must use the shared pre-attach retention path',
)
const inworldBrowserAudioSender = sourceBetween(
  serverIndex,
  'function sendInworldAudioToBrowser',
  'function sendInworldAudioToCallToolsGateway',
)
assert.match(
  inworldBrowserAudioSender,
  /sendAssistantPcmToBrowser\(state, int16ToBufferLE\(leveled\)\)/,
  'Inworld Browser output must use the shared pre-attach retention path',
)
const browserAudioClearSender = sourceBetween(
  serverIndex,
  'function sendBrowserAudioClear',
  'function sendTelnyxMark',
)
assert.match(
  browserAudioClearSender,
  /clearBrowserAudioBeforeAttach\(state\)/,
  'an interruption before Browser audio attach must discard stale retained output',
)
const closeCallSocketsSource = sourceBetween(
  serverIndex,
  'function closeCallSockets',
  'function emitCallEvent',
)
assert.match(
  closeCallSocketsSource,
  /state\.browserAudioAttachPending\s*=\s*false[\s\S]*clearBrowserAudioBeforeAttach\(state\)/,
  'ending a Browser test must close and clear the pre-attach assistant-audio buffer',
)
assert.match(
  closeCallSocketsSource,
  /stopHumeInputPrimer\(state, 'call_closed'\)/,
  'ending any call must stop its bounded Hume input primer',
)
assert.match(
  closeCallSocketsSource,
  /voiceInterruptionRecovery\.clear\(state, 'call_closed'\)/,
  'ending any call must cancel its interruption recovery timer',
)

const personalPhoneHandoffRoute = sourceBetween(
  serverIndex,
  "app.post('/api/personal-phone/inbound/handoffs'",
  "app.get('/api/personal-phone/inbound/readiness'",
)
assertOrdered(
  personalPhoneHandoffRoute,
  ['personalPhoneInboundHandoffs.prepare(', 'prepareProvisionalVoiceSession(', 'publicConnectResponse(record)'],
  'eligible Personal Phone handoffs must preconnect voice before returning the stream instruction',
)
assert.match(
  serverIndex,
  /function createPersonalPhoneInboundCallState[\s\S]*bindProvisionalVoiceSession/,
)
assert.match(
  serverIndex,
  /shutdownVoiceBackend[\s\S]*provisionalVoiceSessions\.cancelAll\('shutdown'\)/,
)
const callToolsPreparation = sourceBetween(
  serverIndex,
  'async function createCallToolsGatewayState',
  'function callToolsDutyAcceptsGatewayCall',
)
assertOrdered(
  callToolsPreparation,
  [
    'primeCallToolsVoiceContext(state, message)',
    'connectVoiceSession(state)',
    'return state',
  ],
  'CallTools must begin selected-profile/contact context and voice preparation before authorizing SIP answer',
)
assert.doesNotMatch(
  callToolsPreparation,
  /await waitForCallToolsVoiceInputReady\(state\)|await waitForHumeInputPrimerReady\(state\)/,
  'CallTools must answer inside the native SIP deadline while the bounded pre-ready audio path waits for voice input',
)
assert.match(
  serverIndex,
  /async function activatePrewarmedHumeSession[\s\S]*ws\.send\(JSON\.stringify\(buildHumeSessionSettings[\s\S]*startHumeInputPrimer\(state\)[\s\S]*markVoiceInputReady\(state, 'hume'\)/,
  'Hume must receive session context followed by a live silent input stream before caller audio can arrive',
)
assert.match(
  callToolsPreparation,
  /claimCallToolsStandbyVoiceSession/,
  'CallTools native invite must claim the matching Available-lease voice standby',
)
assert.doesNotMatch(
  callToolsPreparation,
  /fetch\([\s\S]*TELNYX_API_BASE|prepareProvisionalVoiceSession/,
  'CallTools invite handling must not dial or create a second standby',
)
assert.match(
  serverIndex,
  /callToolsDutyMonitor = createCallToolsDutyMonitor\([\s\S]*ensureCallToolsStandbyVoiceSession\([\s\S]*callToolsVoiceStandby\.cancel\('unavailable'\)/,
)
assert.match(
  serverIndex,
  /shutdownVoiceBackend[\s\S]*callToolsVoiceStandby\.cancel\('shutdown'\)/,
)
assert.match(
  serverIndex,
  /function emitCallEvent[\s\S]*scheduleCallToolsStandbyReplenishment\(state\)/,
)
const callToolsStandbyClaim = sourceBetween(
  serverIndex,
  'function claimCallToolsStandbyVoiceSession',
  'function bindProvisionalVoiceSession',
)
assert.match(
  callToolsStandbyClaim,
  /config:\s*runtimeConfig/,
  'CallTools standby claim scope must use the current operational runtime config fingerprint',
)
assert.doesNotMatch(
  callToolsStandbyClaim,
  /state\.config\s*=\s*runtimeConfig/,
  'claiming a preconnected standby must preserve the config that created its provider socket',
)
bufferVoiceInputBeforeReady(preReadyState, preReadyFrames[0], { maxDurationMs: 40 })
assert.equal(clearVoiceInputBeforeReady(preReadyState).bufferedFrames, 1)
assert.equal(drainVoiceInputBeforeReady(preReadyState).frames.length, 0)

assert.equal(
  selectHumeUserInputTransport({ webSocketOpen: true, chatId: 'chat-1' }),
  'websocket',
)
assert.equal(
  selectHumeUserInputTransport({ webSocketOpen: false, chatId: 'chat-1' }),
  'control_plane',
)
assert.equal(
  selectHumeUserInputTransport({ webSocketOpen: false, chatId: '' }),
  '',
)

assert.equal(
  typeof voiceTurnTransport.shouldEmitFinalUserTranscript,
  'function',
  'voice transport must expose final-user transcript admission for provider duplicate suppression',
)
assert.equal(
  typeof voiceTurnTransport.consumeSyntheticUserInput,
  'function',
  'the live Hume callback must import the shared synthetic-input suppressor instead of referencing a private helper',
)
const syntheticTranscriptState = {
  finalUserTranscriptDedupe: new Map(),
  syntheticUserInputs: new Set(['Typed playground turn.']),
}
assert.equal(
  voiceTurnTransport.shouldEmitFinalUserTranscript(
    syntheticTranscriptState,
    'Typed playground turn.',
    { nowMs: 1_000, providerEventId: 'inworld-item-1' },
  ),
  false,
  'the first provider echo of a typed Playground turn must stay suppressed',
)
assert.equal(
  voiceTurnTransport.shouldEmitFinalUserTranscript(
    syntheticTranscriptState,
    'Typed playground turn.',
    { nowMs: 1_001, providerEventId: 'inworld-item-1' },
  ),
  false,
  'Inworld conversation.item.done must not re-emit a consumed synthetic turn',
)
assert.equal(
  voiceTurnTransport.shouldEmitFinalUserTranscript(
    syntheticTranscriptState,
    'Real caller turn.',
    { nowMs: 2_000, providerEventId: 'inworld-item-2' },
  ),
  true,
  'a real provider transcript must still emit once',
)
assert.equal(
  voiceTurnTransport.shouldEmitFinalUserTranscript(
    syntheticTranscriptState,
    'Real caller turn.',
    { nowMs: 2_001, providerEventId: 'inworld-item-2' },
  ),
  false,
  'repeated provider lifecycle events for the same real turn must dedupe',
)

const humeTurnState = {}
noteFinalUserTurn(humeTurnState, {
  provider: 'hume',
  atMs: 1_000,
  configuredTurnSilenceMs: DEFAULT_END_OF_TURN_SILENCE_MS,
})
const humeTurnLatency = noteFirstAssistantAudio(humeTurnState, {
  provider: 'hume',
  atMs: 1_325,
})
assert.deepEqual(humeTurnLatency, {
  sequence: 1,
  provider: 'hume',
  finalUserToAssistantAudioMs: 325,
  callerStopToAssistantAudioMs: 825,
  callerStopSource: 'configured_turn_silence_estimate',
  configuredTurnSilenceMs: 500,
})
assert.equal(
  noteFirstAssistantAudio(humeTurnState, { provider: 'hume', atMs: 1_350 }),
  null,
)

const measuredHumeTurnState = {}
const measuredSpeechFrame = Buffer.alloc(640)
for (let offset = 0; offset < measuredSpeechFrame.length; offset += 2) {
  measuredSpeechFrame.writeInt16LE(offset < 480 ? 4_000 : 0, offset)
}
const measuredActivity = noteVoiceInputPcmActivity(
  measuredHumeTurnState,
  measuredSpeechFrame,
  { atMs: 3_020, sampleRate: 16_000 },
)
assert.equal(measuredActivity.active, true)
assert.equal(Math.round(measuredActivity.speechAtMs), 3_015)
noteVoiceInputPcmActivity(measuredHumeTurnState, Buffer.alloc(640), {
  atMs: 3_040,
  sampleRate: 16_000,
})
noteFinalUserTurn(measuredHumeTurnState, {
  provider: 'hume',
  atMs: 3_600,
  configuredTurnSilenceMs: DEFAULT_END_OF_TURN_SILENCE_MS,
})
assert.deepEqual(
  noteFirstAssistantAudio(measuredHumeTurnState, {
    provider: 'hume',
    atMs: 3_700,
  }),
  {
    sequence: 1,
    provider: 'hume',
    finalUserToAssistantAudioMs: 100,
    callerStopToAssistantAudioMs: 685,
    callerStopSource: 'local_pcm_activity_estimate',
    configuredTurnSilenceMs: 500,
  },
)

const carrierNoiseState = {}
const carrierNoiseFrame = Buffer.alloc(640)
for (let offset = 0; offset < carrierNoiseFrame.length; offset += 2) {
  const sampleIndex = offset / 2
  carrierNoiseFrame.writeInt16LE(
    sampleIndex % 8 === 0 ? 400 : sampleIndex % 2 === 0 ? 60 : -60,
    offset,
  )
}
const carrierNoiseActivity = noteVoiceInputPcmActivity(
  carrierNoiseState,
  carrierNoiseFrame,
  { atMs: 5_000, sampleRate: 16_000 },
)
assert.equal(
  carrierNoiseActivity.active,
  false,
  'phone-line comfort noise must not overwrite the last confirmed caller-speech boundary',
)
noteFinalUserTurn(carrierNoiseState, {
  provider: 'hume',
  atMs: 5_500,
  configuredTurnSilenceMs: DEFAULT_END_OF_TURN_SILENCE_MS,
})
assert.deepEqual(
  noteFirstAssistantAudio(carrierNoiseState, {
    provider: 'hume',
    atMs: 6_500,
  }),
  {
    sequence: 1,
    provider: 'hume',
    finalUserToAssistantAudioMs: 1_000,
    callerStopToAssistantAudioMs: 1_500,
    callerStopSource: 'configured_turn_silence_estimate',
    configuredTurnSilenceMs: 500,
  },
  'unconfirmed carrier noise must fall back to the configured turn-silence boundary',
)

assert.equal(
  typeof voiceTurnTransport.conditionPhoneVoiceInputPcm,
  'function',
  'phone voice transport must expose a provider-neutral input conditioner',
)

const phoneConditioningState = { sampleRate: 16_000 }
const quietCarrierFrame = Buffer.alloc(640)
for (let offset = 0; offset < quietCarrierFrame.length; offset += 2) {
  const sampleIndex = offset / 2
  quietCarrierFrame.writeInt16LE(
    sampleIndex % 8 === 0 ? 300 : sampleIndex % 2 === 0 ? 55 : -55,
    offset,
  )
}
const quietSpeechFrame = Buffer.alloc(640)
for (let offset = 0; offset < quietSpeechFrame.length; offset += 2) {
  quietSpeechFrame.writeInt16LE((offset / 2) % 2 === 0 ? 600 : -600, offset)
}

const initialCarrier = voiceTurnTransport.conditionPhoneVoiceInputPcm(
  phoneConditioningState,
  quietCarrierFrame,
  { atMs: 10_000, sampleRate: 16_000 },
)
assert.equal(initialCarrier.suppressed, false)
assert.deepEqual(
  initialCarrier.pcm,
  quietCarrierFrame,
  'conditioning must pass the line unchanged until it has confirmed caller speech',
)

const detectedQuietSpeech = voiceTurnTransport.conditionPhoneVoiceInputPcm(
  phoneConditioningState,
  quietSpeechFrame,
  { atMs: 10_020, sampleRate: 16_000 },
)
assert.equal(detectedQuietSpeech.activity.active, true)
assert.equal(detectedQuietSpeech.suppressed, false)
assert.deepEqual(
  detectedQuietSpeech.pcm,
  quietSpeechFrame,
  'quiet but real speech must pass without attenuation or delay',
)

const carrierInsideHangover = voiceTurnTransport.conditionPhoneVoiceInputPcm(
  phoneConditioningState,
  quietCarrierFrame,
  { atMs: 10_160, sampleRate: 16_000 },
)
assert.equal(
  carrierInsideHangover.suppressed,
  false,
  'short natural gaps must remain untouched',
)

const carrierAfterHangover = voiceTurnTransport.conditionPhoneVoiceInputPcm(
  phoneConditioningState,
  quietCarrierFrame,
  { atMs: 10_220, sampleRate: 16_000 },
)
assert.equal(carrierAfterHangover.suppressed, true)
assert.equal(carrierAfterHangover.pcm.length, quietCarrierFrame.length)
assert.equal(
  carrierAfterHangover.pcm.every((sample) => sample === 0),
  true,
  'steady carrier noise after caller speech must become digital silence without changing timing',
)
assert.notDeepEqual(
  quietCarrierFrame,
  carrierAfterHangover.pcm,
  'conditioning must not mutate the raw frame retained for recording proof',
)

voiceTurnTransport.conditionPhoneVoiceInputPcm(
  phoneConditioningState,
  quietCarrierFrame,
  { atMs: 10_540, sampleRate: 16_000 },
)
const audiblePhoneTiming = noteFirstAssistantAudio(phoneConditioningState, {
  provider: 'hume',
  atMs: 11_620,
})
assert.deepEqual(
  audiblePhoneTiming,
  {
    provider: 'hume',
    audibleCallerStopToAssistantAudioMs: 1_600,
    audibleCallerStopSource: 'conditioned_phone_pcm_activity',
  },
  'audible response latency must be measured from caller PCM, not transcript timestamps',
)
voiceTurnTransport.conditionPhoneVoiceInputPcm(
  phoneConditioningState,
  quietCarrierFrame,
  { atMs: 11_640, sampleRate: 16_000 },
)
assert.equal(
  noteFirstAssistantAudio(phoneConditioningState, {
    provider: 'hume',
    atMs: 11_660,
  }),
  null,
  'one audible caller turn must produce one latency sample even while later assistant chunks stream',
)

const resumedQuietSpeech = voiceTurnTransport.conditionPhoneVoiceInputPcm(
  phoneConditioningState,
  quietSpeechFrame,
  { atMs: 12_000, sampleRate: 16_000 },
)
assert.equal(resumedQuietSpeech.suppressed, false)
assert.deepEqual(
  resumedQuietSpeech.pcm,
  quietSpeechFrame,
  'new speech after a gated interval must pass on its first detected frame',
)
assert.equal(
  pcm16IsAudible(bufferToInt16LE(quietCarrierFrame)),
  false,
  'carrier noise must not count as audible assistant speech',
)
assert.equal(
  pcm16IsAudible(bufferToInt16LE(quietSpeechFrame)),
  true,
  'quiet spoken audio must count as audible assistant speech',
)

const inworldTurnState = {}
noteCallerSpeechStopped(inworldTurnState, { provider: 'inworld', atMs: 2_000 })
noteFinalUserTurn(inworldTurnState, { provider: 'inworld', atMs: 2_075 })
assert.deepEqual(
  noteFirstAssistantAudio(inworldTurnState, { provider: 'inworld', atMs: 2_250 }),
  {
    sequence: 1,
    provider: 'inworld',
    finalUserToAssistantAudioMs: 175,
    callerStopToAssistantAudioMs: 250,
    callerStopSource: 'provider_speech_stopped',
  },
)

assert.equal(Buffer.compare(decodeTelnyxPayload(pcm, 'L16'), pcm), 0)
assert.throws(
  () => decodeTelnyxPayload(Buffer.alloc(3), 'L16'),
  /Invalid L16 payload byte length/,
)

const ulaw = encodePcm16LeToUlaw(pcm)
const decodedUlaw = bufferToInt16LE(decodeTelnyxPayload(ulaw, 'PCMU'))
assert.ok(meanAbsoluteError(samples, decodedUlaw) < 350)

const pcMuSamples = sineWave({ frequency: 1000, sampleRate: 8000, seconds: 1 })
const pcMuPcm = int16ToBufferLE(pcMuSamples)
const pcMuEncoded = encodePcm16LeToUlaw(pcMuPcm)
const pcMuDecodedPcm = decodeTelnyxPayload(pcMuEncoded, 'MU-LAW')
const pcMuReencoded = encodePcm16LeToUlaw(pcMuDecodedPcm)
const pcMuRoundTrip = bufferToInt16LE(
  decodeTelnyxPayload(pcMuReencoded, 'PCMU'),
)
assert.equal(pcMuRoundTrip.length, pcMuSamples.length)
assert.ok(rms(pcMuRoundTrip) > 1000)

const decodedWav = decodeWavPcm16(writeWavPcm16Mono(pcm, sampleRate), 8000)
assert.equal(decodedWav.sampleRate, sampleRate)
assert.equal(decodedWav.samples.length, samples.length)

const resampled = resamplePcm16(decodedWav.samples, sampleRate, 8000)
assert.ok(Math.abs(resampled.length - samples.length / 2) <= 1)

const leveled = levelPcm16ForPhone(decodedWav.samples, {
  gain: 0.72,
  peakRatio: 0.58,
})
assert.ok(peakAbs(leveled) <= Math.ceil(32767 * 0.58))

const oneSecondSamples = sineWave({ frequency: 1000, sampleRate, seconds: 1 })
const oneSecondLeveled = levelPcm16ForPhone(oneSecondSamples, {
  gain: 0.72,
  peakRatio: 0.58,
})
const queueState = {
  sampleRate,
  telnyxCodec: 'L16',
  telnyxOutboundRemainder: Buffer.alloc(0),
}
const queuedFrames = queueTelnyxPcmFrames(queueState, int16ToBufferLE(oneSecondLeveled))
assert.equal(queuedFrames.length, 50)
assert.equal(queueState.telnyxOutboundRemainder.length, 0)
assert.ok(queuedFrames.every((frame) => frame.length === 640))
const queuedStats = analyzePcm16(bufferToInt16LE(Buffer.concat(queuedFrames)))
assert.equal(queuedStats.clipped, 0)
assert.ok(queuedStats.peakRatio <= 0.58 + 1 / 32767)

assert.ok(
  TELNYX_MAX_QUEUE_MS >= 30_000,
  'Phone output must retain a normal spoken turn instead of truncating after six seconds',
)
const boundedQueueFrameSamples = Math.round(sampleRate * TELNYX_FRAME_MS / 1000)
const boundedQueueFrames = Math.ceil(TELNYX_MAX_QUEUE_MS / TELNYX_FRAME_MS) + 10
const boundedQueueSamples = new Int16Array(
  boundedQueueFrameSamples * boundedQueueFrames,
)
boundedQueueSamples.fill(2000)
boundedQueueSamples.fill(1000, 0, boundedQueueFrameSamples)
const boundedQueueState = {
  sampleRate,
  telnyxCodec: 'L16',
  telnyxWs: { readyState: 1, send() {} },
  telnyxOutboundRemainder: Buffer.alloc(0),
  audioQuality: { queue: {} },
}
enqueuePcmToTelnyx(
  boundedQueueState,
  int16ToBufferLE(boundedQueueSamples),
)
assert.equal(
  boundedQueueState.telnyxOutboundQueue.length,
  Math.ceil(TELNYX_MAX_QUEUE_MS / TELNYX_FRAME_MS),
)
assert.equal(
  Buffer.from(boundedQueueState.telnyxOutboundQueue[0], 'base64').readInt16LE(0),
  1000,
  'Queue pressure must retain the earliest unsent speech instead of jumping to a later fragment',
)
assert.equal(boundedQueueState.telnyxDroppedOutboundFrames, 10)
clearTelnyxOutboundQueue(boundedQueueState, { sendClear: false })

const state = {
  transportDiagnostics: createTransportDiagnostics({
    sampleRate,
    telnyxStreamCodec: 'L16',
    verboseTranscription: true,
  }),
}
setTransportDiagnosticValue(state, 'telnyx', 'observedCodec', 'L16')
setTransportDiagnosticValue(state, 'telnyx', 'observedSampleRate', sampleRate)
recordTransportMilestone(state, 'telnyx_stream_attached', {
  codec: 'L16',
  sampleRate,
})
recordTransportMilestone(state, 'hume_ws_open')
recordTransportMilestone(state, 'hume_chat_attached')
recordTransportMilestone(state, 'first_telnyx_media_in')
recordTransportMilestone(state, 'first_hume_audio_input')
recordTransportMilestone(state, 'first_hume_audio_output')
recordTransportMilestone(state, 'first_telnyx_media_out')
addTransportCounter(state, 'telnyxMediaInPackets')
addTransportCounter(state, 'telnyxMediaInBytes', pcm.length)
addTransportCounter(state, 'telnyxPcmInBytes', pcm.length)
addTransportCounter(state, 'humeAudioInputs')
addTransportCounter(state, 'humeAudioInputBytes', pcm.length)
addTransportCounter(state, 'humeAudioOutputs')
addTransportCounter(state, 'humeAudioOutputBytes', writeWavPcm16Mono(pcm, sampleRate).length)
addTransportCounter(state, 'telnyxMediaOutPackets')
addTransportCounter(state, 'telnyxMediaOutBytes', pcm.length)
addTransportCounter(state, 'telnyxPcmOutBytes', pcm.length)
addTransportCounter(state, 'telnyxClearMessages')

const diagnostic = buildTransportDiagnosticSnapshot(state)
assert.equal(diagnostic.telnyx.requestedCodec, 'L16')
assert.equal(diagnostic.telnyx.observedCodec, 'L16')
assert.equal(diagnostic.hume.audioEncoding, 'linear16')
assert.equal(diagnostic.hume.audioChannels, 1)
assert.equal(diagnostic.voice.preReadyBufferMaxMs, 3000)
assert.equal(diagnostic.counters.telnyxClearMessages, 1)
assert.equal(diagnostic.counters.voiceInputPreReadyDroppedFrames, 0)

const preconnectTimingState = {
  transportDiagnostics: createTransportDiagnostics({ sampleRate }),
}
recordTransportMilestoneAt(
  preconnectTimingState,
  'voice_preconnect_started',
  '2026-07-15T12:00:00.000Z',
)
recordTransportMilestoneAt(
  preconnectTimingState,
  'hume_ws_open',
  '2026-07-15T12:00:00.180Z',
)
recordTransportMilestoneAt(
  preconnectTimingState,
  'voice_preconnect_bound',
  '2026-07-15T12:00:00.420Z',
)
recordTransportMilestoneAt(
  preconnectTimingState,
  'telnyx_call_accepted',
  '2026-07-15T12:00:00.450Z',
)
recordTransportMilestoneAt(
  preconnectTimingState,
  'telnyx_stream_attached',
  '2026-07-15T12:00:00.700Z',
)
recordTransportMilestoneAt(
  preconnectTimingState,
  'calltools_gateway_invite_received',
  '2026-07-15T12:00:00.600Z',
)
recordTransportMilestoneAt(
  preconnectTimingState,
  'calltools_voice_standby_claimed',
  '2026-07-15T12:00:00.610Z',
)
recordTransportMilestoneAt(
  preconnectTimingState,
  'voice_input_ready',
  '2026-07-15T12:00:00.650Z',
)
const preconnectTiming = buildTransportDiagnosticSnapshot(preconnectTimingState)
assert.equal(preconnectTiming.timingMs.voicePreconnectToProviderOpen, 180)
assert.equal(preconnectTiming.timingMs.voicePreconnectToBound, 420)
assert.equal(preconnectTiming.timingMs.voicePreconnectToTelnyxAccepted, 450)
assert.equal(preconnectTiming.timingMs.providerOpenLeadBeforeTelnyxStream, 520)
assert.equal(preconnectTiming.timingMs.providerOpenLeadBeforeCallToolsInvite, 420)
assert.equal(preconnectTiming.timingMs.calltoolsStandbyClaimToVoiceInputReady, 40)

const liveState = {
  callControlId: 'sim-live-diagnostics',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  eventLog: [],
  chatId: '',
  outcome: '',
  config: {},
  transportDiagnostics: createTransportDiagnostics({
    sampleRate,
    telnyxStreamCodec: 'L16',
    verboseTranscription: true,
  }),
}
addTransportCounter(liveState, 'telnyxMediaInPackets', 7)
const [liveSummary] = recentCallSummaries({
  callStates: [liveState],
  callLogDir: path.join(tmpdir(), `hume-phone-path-check-${Date.now()}`),
  limit: 1,
  leadForState: () => ({ id: 'sim', name: 'Simulated Lead' }),
})
assert.equal(liveSummary.diagnostics.counters.telnyxMediaInPackets, 7)

const lateHumeState = {
  ...liveState,
  callControlId: 'sim-late-hume-metadata',
  outcome: 'no-answer',
  eventLog: [
    { patch: { phase: 'live' }, notice: 'Telnyx media stream attached' },
    { patch: { phase: 'ended', outcome: 'no-answer' }, notice: 'Call stream stopped' },
    { patch: { phase: 'live', chatId: 'late-chat' }, notice: 'Hume chat attached' },
  ],
}
const [lateHumeSummary] = recentCallSummaries({
  callStates: [lateHumeState],
  callLogDir: path.join(tmpdir(), `hume-phone-path-check-late-${Date.now()}`),
  limit: 1,
  leadForState: () => ({ id: 'sim', name: 'Simulated Lead' }),
})
assert.equal(lateHumeSummary.phase, 'ended')

console.log(
  JSON.stringify(
    {
      ok: true,
      checks: [
        'hume-linear16-session-settings',
        'playground-browser-session-lifecycle',
        'playground-pending-start-cancellation',
        'hume-500ms-turn-silence-floor',
        'voice-start-independent-of-delivery-connectors',
        'voice-pre-ready-input-buffer',
        'voice-pre-ready-speech-aware-retention',
        'browser-assistant-audio-pre-attach-retention',
        'provisional-voice-session-lifecycle',
        'telnyx-and-personal-phone-voice-preconnect-ordering',
        'calltools-native-invite-standby-preconnect-isolation',
        'hume-user-input-data-plane-priority',
        'stale-hume-profile-reconciled-before-session',
        'interruption-silence-natural-recovery',
        'caller-stop-to-first-assistant-audio-timing',
        'telnyx-l16-pass-through',
        'telnyx-l16-odd-byte-rejection',
        'telnyx-20ms-output-frame-queue',
        'pcmu-legacy-conversion',
        'hume-wav-output-decode',
        'phone-output-leveling',
        'transport-diagnostic-snapshot',
        'live-recent-call-diagnostic-freshness',
        'ended-phase-stable-after-late-hume-metadata',
      ],
      pcm: {
        sampleRate,
        bytes: pcm.length,
        durationMs: Math.round((samples.length / sampleRate) * 1000),
        pcMuMeanAbsoluteError: Math.round(meanAbsoluteError(samples, decodedUlaw)),
        leveledPeak: peakAbs(leveled),
        queuedFrames: queuedFrames.length,
        queuedPeakRatio: Number(queuedStats.peakRatio.toFixed(4)),
      },
      diagnostic: {
        telnyx: diagnostic.telnyx,
        hume: diagnostic.hume,
        voice: diagnostic.voice,
        counters: diagnostic.counters,
      },
      playgroundSessionLifecycle,
    },
    null,
    2,
  ),
)

function sourceBetween(source, startToken, endToken) {
  const start = source.indexOf(startToken)
  const end = source.indexOf(endToken, start + startToken.length)
  assert.ok(start >= 0, `Missing source token: ${startToken}`)
  assert.ok(end > start, `Missing source token after ${startToken}: ${endToken}`)
  return source.slice(start, end)
}

function assertOrdered(source, tokens, message) {
  let previous = -1
  tokens.forEach((token) => {
    const index = source.indexOf(token, previous + 1)
    assert.ok(index > previous, `${message}; missing or out of order: ${token}`)
    previous = index
  })
}

function sineWave({ frequency, sampleRate, seconds }) {
  const length = Math.round(sampleRate * seconds)
  const output = new Int16Array(length)
  for (let index = 0; index < length; index += 1) {
    output[index] = Math.round(Math.sin((index / sampleRate) * frequency * Math.PI * 2) * 12000)
  }
  return output
}

function meanAbsoluteError(left, right) {
  const length = Math.min(left.length, right.length)
  let total = 0
  for (let index = 0; index < length; index += 1) {
    total += Math.abs(left[index] - right[index])
  }
  return total / length
}

function peakAbs(value) {
  return value.reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0)
}

function rms(value) {
  let total = 0
  for (const sample of value) total += sample * sample
  return Math.sqrt(total / Math.max(1, value.length))
}

function writeWavPcm16Mono(pcmData, rate) {
  const header = Buffer.alloc(44)
  const dataSize = pcmData.length

  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataSize, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataSize, 40)

  return Buffer.concat([header, pcmData])
}
