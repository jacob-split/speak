import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))
const serverIndex = readFileSync('server/index.mjs', 'utf8')
const gateway = readFileSync('src/calltoolsGateway.ts', 'utf8')
const gatewayHtml = readFileSync('calltools-gateway.html', 'utf8')
const viteConfig = readFileSync('vite.config.ts', 'utf8')
const callAudio = readFileSync('server/call-audio.mjs', 'utf8')
const gatewayRunner = readFileSync('scripts/run-calltools-gateway.mjs', 'utf8')
const calltoolsClient = readFileSync('server/calltools-client.mjs', 'utf8')
const transportDiagnostics = readFileSync('server/transport-diagnostics.mjs', 'utf8')
const liveProof = readFileSync('scripts/check-calltools-live-proof.mjs', 'utf8')
const proofGates = readFileSync('scripts/calltools-proof-gates.mjs', 'utf8')
const gatewayService = readFileSync('ops/systemd/speak-calltools-gateway.service', 'utf8')
const watchdogSource = readFileSync('server/calltools-call-watchdog.mjs', 'utf8')

let callToolsFirstTurn
try {
  callToolsFirstTurn = await import('../server/calltools-first-turn.mjs')
} catch (error) {
  assert.fail(
    `CallTools first-turn gate module is required: ${error instanceof Error ? error.message : String(error)}`,
  )
}

let callToolsRuntimeConfig
try {
  callToolsRuntimeConfig = await import('../server/calltools-runtime-config.mjs')
} catch (error) {
  assert.fail(
    `CallTools runtime-config preservation module is required: ${error instanceof Error ? error.message : String(error)}`,
  )
}

let callToolsCallWatchdog
try {
  callToolsCallWatchdog = await import('../server/calltools-call-watchdog.mjs')
} catch (error) {
  assert.fail(
    `CallTools call watchdog module is required: ${error instanceof Error ? error.message : String(error)}`,
  )
}

const {
  advanceCallToolsFirstTurnGate,
  createCallToolsFirstTurnGate,
  shouldSuppressCallToolsAssistantOutput,
} = callToolsFirstTurn
const { withCallToolsRuntimeIdentity } = callToolsRuntimeConfig
const {
  auditCallToolsCallSummaries,
  createCallToolsCallWatchdog,
  reviewCallToolsTranscripts,
} = callToolsCallWatchdog

const watchdogNow = Date.parse('2026-07-17T01:00:00.000Z')
const watchdogIssues = auditCallToolsCallSummaries(
  [
    {
      callControlId: 'calltools-premature',
      createdAt: '2026-07-17T00:55:00.000Z',
      phase: 'ended',
      provider: 'calltools',
      transcript: [
        { speaker: 'AI', text: 'Hello?' },
        { speaker: 'Lead', text: 'Hello.' },
      ],
      diagnostics: {
        voice: {
          firstAudibleCallerStopToAssistantAudioMs: 3200,
          firstCallerStopToAssistantAudioMs: 400,
        },
      },
    },
    {
      callControlId: 'calltools-unanswered',
      createdAt: '2026-07-17T00:58:00.000Z',
      phase: 'live',
      provider: 'calltools',
      transcript: [{ speaker: 'Lead', text: 'Hello.' }],
      diagnostics: { counters: { calltoolsMediaOutPackets: 0 } },
    },
    {
      callControlId: 'calltools-silent-audio',
      createdAt: '2026-07-17T00:57:00.000Z',
      phase: 'ended',
      provider: 'calltools',
      transcript: [
        { speaker: 'Lead', text: 'Hello.' },
        { speaker: 'AI', text: 'Hi there.' },
      ],
      diagnostics: { counters: { calltoolsMediaOutPackets: 0 } },
    },
    {
      callControlId: 'calltools-healthy',
      createdAt: '2026-07-17T00:59:00.000Z',
      phase: 'ended',
      provider: 'calltools',
      transcript: [
        { speaker: 'Lead', text: 'Hello.' },
        { speaker: 'AI', text: 'Hi there.' },
      ],
      diagnostics: {
        counters: { calltoolsMediaOutPackets: 2 },
        voice: { firstCallerStopToAssistantAudioMs: 1100 },
      },
    },
    {
      callControlId: 'calltools-normal-provider-close',
      createdAt: '2026-07-17T00:59:30.000Z',
      phase: 'ended',
      provider: 'calltools',
      transcript: [
        { speaker: 'Lead', text: 'Hello.' },
        { speaker: 'AI', text: 'Hi there.' },
      ],
      diagnostics: {
        counters: { calltoolsMediaOutPackets: 2 },
        voice: { firstCallerStopToAssistantAudioMs: 900 },
      },
      latestEvents: ['Speak voice session disconnected (code 1005).'],
    },
    {
      callControlId: 'calltools-terminal-rejection',
      createdAt: '2026-07-17T00:59:35.000Z',
      outcome: 'not-interested',
      phase: 'ended',
      provider: 'calltools',
      transcript: [
        { speaker: 'Lead', text: 'Hello.' },
        { speaker: 'AI', text: 'Hi there.' },
        { speaker: 'Lead', text: 'No thanks, I am not interested.' },
      ],
      diagnostics: { counters: { calltoolsMediaOutPackets: 2 } },
    },
    {
      callControlId: 'calltools-ended-without-response',
      createdAt: '2026-07-17T00:59:40.000Z',
      outcome: 'no-answer',
      phase: 'ended',
      provider: 'calltools',
      transcript: [{ speaker: 'Lead', text: 'Hello, can you hear me?' }],
      diagnostics: { counters: { calltoolsMediaOutPackets: 0 } },
    },
  ],
  {
    missingResponseAfterMs: 10_000,
    nowMs: watchdogNow,
    slowResponseThresholdMs: 2_000,
  },
)
assert.deepEqual(
  new Set(watchdogIssues.map((issue) => issue.code)),
  new Set([
    'CALLTOOLS_ASSISTANT_BEFORE_CALLER',
    'CALLTOOLS_FIRST_RESPONSE_SLOW',
    'CALLTOOLS_CALLER_UNANSWERED',
    'CALLTOOLS_ASSISTANT_AUDIO_MISSING',
  ]),
  'the VM watchdog must detect premature speech, slow response, missing response, and missing audio',
)
assert.equal(
  watchdogIssues.some((issue) => issue.callControlId === 'calltools-healthy'),
  false,
  'healthy CallTools calls must not create watchdog incidents',
)
assert.equal(
  watchdogIssues.find(
    (issue) =>
      issue.callControlId === 'calltools-premature' &&
      issue.code === 'CALLTOOLS_FIRST_RESPONSE_SLOW',
  )?.metrics?.firstResponseMs,
  3200,
  'watchdog latency must prefer caller/assistant PCM timing over transcript-derived timing',
)
assert.equal(
  watchdogIssues.some(
    (issue) => issue.callControlId === 'calltools-normal-provider-close',
  ),
  false,
  'a normal provider WebSocket close after a completed two-sided call must not create a critical watchdog incident',
)
assert.equal(
  watchdogIssues.some(
    (issue) =>
      issue.callControlId === 'calltools-terminal-rejection' &&
      issue.code === 'CALLTOOLS_CALLER_UNANSWERED',
  ),
  false,
  'an explicit terminal caller rejection must not be misreported as an unanswered caller turn',
)
assert.equal(
  watchdogIssues.some(
    (issue) =>
      issue.callControlId === 'calltools-ended-without-response' &&
      issue.code === 'CALLTOOLS_CALLER_UNANSWERED',
  ),
  true,
  'an ended call with caller speech and no assistant response must remain actionable',
)

let semanticRequestBody
let semanticRequestUrl
const semanticReview = await reviewCallToolsTranscripts({
  agentInstructions: 'Ask for the owner, then follow the active conversation naturally.',
  calls: [
    {
      callControlId: 'calltools-semantic-drift',
      provider: 'calltools',
      transcript: [
        { speaker: 'Lead', text: 'No, Pedro is not here.' },
        { speaker: 'AI', text: 'What is your favorite color?' },
      ],
    },
  ],
  fetchImpl: async (url, options) => {
    semanticRequestUrl = url
    semanticRequestBody = JSON.parse(options.body)
    return {
      ok: true,
      async json() {
        return {
          model: 'gpt-5.6-sol',
          choices: [
            {
              message: {
                content: JSON.stringify({
                  reviews: [
                    {
                      callControlId: 'calltools-semantic-drift',
                      normal: false,
                      severity: 'critical',
                      codes: ['IGNORED_CALLER_INPUT', 'FLOW_DRIFT'],
                      summary: 'The assistant ignored the caller and changed topics.',
                      evidence: [{ turn: 2, excerpt: 'What is your favorite color?' }],
                      recommendedAction: 'Inspect the active runtime turn handling.',
                    },
                  ],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
        }
      },
    }
  },
  model: 'gpt-5.6-sol',
})
assert.equal(semanticRequestUrl, 'http://127.0.0.1:48765/v1/chat/completions')
assert.equal(semanticRequestBody.model, 'gpt-5.6-sol')
assert.equal(semanticRequestBody.reasoning_effort, 'xhigh')
assert.equal(semanticRequestBody.service_tier, 'priority')
assert.match(
  watchdogSource,
  /model = process\.env\.CALLTOOLS_WATCHDOG_MODEL \|\| 'gpt-5\.6-sol'/,
  'the VM watcher defaults to Codex-auth gpt-5.6-sol',
)
assert.match(
  watchdogSource,
  /DEFAULT_SEMANTIC_TIMEOUT_MS = 120_000/,
  'the xhigh semantic transcript review must have a bounded window long enough to finish before the five-minute cycle repeats',
)
assert.equal(semanticReview.reviews[0].normal, false)
assert.deepEqual(
  semanticReview.reviews[0].codes,
  ['IGNORED_CALLER_INPUT', 'FLOW_DRIFT'],
  'semantic transcript review must preserve actionable call-flow issue codes',
)

let watchdogPersistedState = {
  incidents: [
    {
      callControlId: 'calltools-retired-normal-close',
      code: 'CALLTOOLS_PROVIDER_RUNTIME_FAILURE',
      evidence: 'Speak voice session disconnected (code 1005).',
      observedAt: '2026-07-17T00:30:00.000Z',
      severity: 'critical',
    },
  ],
}
let watchdogRepairCount = 0
let watchdogReconcileCount = 0
let watchdogSemanticReviewCount = 0
const scheduledWatchdog = createCallToolsCallWatchdog({
  intervalMs: 5 * 60_000,
  now: () => new Date('2026-07-17T01:00:00.000Z'),
  readDuty: async () => ({
    binding: { appUserId: 'user-1', campaignId: 'campaign-1', phoneId: 'phone-1' },
    leaseId: 'lease-1',
    profileId: 'profile-1',
    status: 'on',
  }),
  readRecentCalls: async () => [
    {
      callControlId: 'calltools-watchdog-cycle',
      createdAt: '2026-07-17T00:55:00.000Z',
      phase: 'ended',
      provider: 'calltools',
      transcript: [
        { speaker: 'AI', text: 'Hello?' },
        { speaker: 'Lead', text: 'Hello.' },
      ],
      diagnostics: { counters: { calltoolsMediaOutPackets: 1 } },
    },
  ],
  reconcile: async () => {
    watchdogReconcileCount += 1
    return { ok: true, status: 'on' }
  },
  repair: async () => {
    watchdogRepairCount += 1
    return { action: 'reconciled', ok: true, status: 'on' }
  },
  reviewTranscripts: async ({ calls }) => {
    watchdogSemanticReviewCount += 1
    return {
      ok: true,
      reviews: calls.map((call) => ({
        callControlId: call.callControlId,
        normal: true,
        severity: 'info',
        codes: [],
      })),
    }
  },
  store: {
    async read() {
      return watchdogPersistedState
    },
    async write(value) {
      watchdogPersistedState = structuredClone(value)
    },
  },
})
await scheduledWatchdog.runNow()
await scheduledWatchdog.runNow()
const publicWatchdogState = await scheduledWatchdog.publicState()
assert.equal(watchdogRepairCount, 1, 'a new incident must trigger one idempotent repair')
assert.equal(watchdogReconcileCount, 1, 'an unchanged follow-up cycle only reconciles readiness')
assert.equal(
  watchdogSemanticReviewCount,
  1,
  'an unchanged transcript must not spend another semantic-review request',
)
assert.equal(watchdogPersistedState.runs.length, 2)
assert.equal(
  Object.hasOwn(publicWatchdogState.lastSemanticReview || {}, 'usage'),
  false,
  'public watchdog state must not expose token-shaped usage fields',
)
assert.equal(
  publicWatchdogState.recentIncidents.some(
    (incident) => incident.callControlId === 'calltools-retired-normal-close',
  ),
  false,
  'persisted normal 1005 closes from older watcher versions must be retired from current incident state',
)

let unansweredNow = new Date('2026-07-17T01:00:00.000Z')
let unansweredRepairs = 0
let unansweredState = {}
const unansweredWatchdog = createCallToolsCallWatchdog({
  now: () => unansweredNow,
  readDuty: async () => ({
    binding: { appUserId: 'user-1', campaignId: 'campaign-1', phoneId: 'phone-1' },
    leaseId: 'lease-1',
    profileId: 'profile-1',
    status: 'on',
  }),
  readRecentCalls: async () => [
    {
      callControlId: 'calltools-crossed-threshold',
      createdAt: '2026-07-17T00:59:55.000Z',
      phase: 'live',
      provider: 'calltools',
      transcript: [{ speaker: 'Lead', text: 'Hello.' }],
    },
  ],
  reconcile: async () => ({ ok: true, status: 'on' }),
  repair: async () => {
    unansweredRepairs += 1
    return { action: 'reconciled', ok: true, status: 'on' }
  },
  reviewTranscripts: async () => ({ ok: true, reviews: [], skipped: false }),
  store: {
    async read() {
      return unansweredState
    },
    async write(value) {
      unansweredState = structuredClone(value)
    },
  },
})
await unansweredWatchdog.runNow()
unansweredNow = new Date('2026-07-17T01:00:10.000Z')
await unansweredWatchdog.runNow()
assert.equal(
  unansweredRepairs,
  1,
  'an unchanged caller turn must be flagged after it crosses the missing-response threshold',
)
assert.equal(
  unansweredState.incidents.at(-1)?.code,
  'CALLTOOLS_CALLER_UNANSWERED',
)

const selectedRuntimeConfig = {
  promptExpansionEnabled: true,
  nudgesEnabled: true,
  nudgesIntervalSeconds: 4,
  voice: 'operator-selected-custom-voice',
  speakVoiceProvider: 'CUSTOM_VOICE',
  languageModelMode: 'speak',
  languageModelProvider: 'ANTHROPIC',
  languageModelResource: 'operator-selected-model',
  useConfigPrompt: true,
  useConfigTools: true,
  codexFastMode: true,
  webSearchEnabled: true,
}
const selectedProfile = {
  id: 'operator-selected-profile',
  name: 'Operator selected profile',
  config: selectedRuntimeConfig,
}
assert.deepEqual(
  withCallToolsRuntimeIdentity(selectedProfile),
  {
    ...selectedRuntimeConfig,
    agentProfileId: selectedProfile.id,
    agentProfileName: selectedProfile.name,
    dialerProvider: 'calltools',
  },
  'CallTools must preserve every operator-selected runtime setting and add only runtime identity',
)
assert.deepEqual(
  selectedProfile.config,
  selectedRuntimeConfig,
  'CallTools runtime preparation must not mutate the saved profile configuration',
)

const pendingFirstTurn = createCallToolsFirstTurnGate()
assert.equal(pendingFirstTurn.status, 'pending')
assert.equal(
  shouldSuppressCallToolsAssistantOutput(pendingFirstTurn),
  true,
  'CallTools assistant output stays closed until a caller turn is verified',
)

const configuredAssistantStart = createCallToolsFirstTurnGate({
  assistantStartsConversation: true,
})
assert.equal(configuredAssistantStart.status, 'open')
assert.equal(
  shouldSuppressCallToolsAssistantOutput(configuredAssistantStart),
  false,
  'CallTools must preserve an explicitly configured provider-started conversation',
)

const humanGreeting = advanceCallToolsFirstTurnGate(
  pendingFirstTurn,
  'Hello hello.',
)
assert.equal(humanGreeting.action, 'resume')
assert.equal(humanGreeting.gate.status, 'open')
assert.equal(
  shouldSuppressCallToolsAssistantOutput(humanGreeting.gate),
  false,
  'a verified human greeting opens the assistant response path immediately',
)

const recordedGreeting = advanceCallToolsFirstTurnGate(
  createCallToolsFirstTurnGate(),
  'Recorded for quality assurance purposes. Thank you for calling BPCS Evictions. How may I help you?',
)
assert.equal(recordedGreeting.action, 'hold')
assert.equal(recordedGreeting.gate.status, 'pending')

const recordedDisconnect = advanceCallToolsFirstTurnGate(
  recordedGreeting.gate,
  "I'll be disconnecting due to a recorded message.",
)
assert.equal(recordedDisconnect.action, 'end')
assert.equal(recordedDisconnect.outcome, 'voicemail')

const liveReceptionist = advanceCallToolsFirstTurnGate(
  createCallToolsFirstTurnGate(),
  'Thank you for calling Split, this is Sarah. How may I help you?',
)
assert.equal(
  liveReceptionist.action,
  'resume',
  'ordinary live receptionist language must not be mistaken for an automated greeting',
)

assert.ok(packageJson.dependencies?.['sip.js'], 'sip.js dependency is required')
assert.ok(
  packageJson.scripts?.['calltools:gateway'],
  'calltools gateway launch script must be exposed',
)
assert.ok(
  packageJson.scripts?.['qa:calltools-media-gateway'],
  'calltools media-gateway QA script must be exposed',
)
assert.match(gatewayHtml, /src\/calltoolsGateway\.ts/, 'gateway HTML loads TS entry')
assert.match(viteConfig, /calltools-gateway\.html/, 'Vite builds gateway HTML')
assert.match(gateway, /new UserAgent/, 'gateway uses SIP.js full UserAgent API')
assert.match(
  gateway,
  /defaultSessionDescriptionHandlerFactory/,
  'gateway injects a custom browser MediaStream factory',
)
assert.match(gateway, /new Registerer/, 'gateway registers the CallTools SIP phone')
assert.match(gateway, /RegistererState/, 'gateway tracks native SIP REGISTER state')
assert.match(
  gateway,
  /registrationEnabled\??:\s*boolean/,
  'gateway config carries the durable Speak availability decision',
)
assert.match(
  gateway,
  /const gatewayInstanceId = crypto\.randomUUID\(\)/,
  'each gateway process has a stable instance identity for the life of its page',
)
assert.match(
  sourceBetween(gateway, 'async function readGatewayConfig', '\nasync function setupSyntheticLocalAudio'),
  /instanceId[\s\S]{0,120}gatewayInstanceId/,
  'gateway config bootstrap sends the gateway instance identity',
)
assert.match(
  gateway,
  /gatewayInstanceId[\s\S]{0,500}gatewayHealthPayload/,
  'gateway health messages retain the instance identity used for ownership',
)
assert.match(
  gateway,
  /registrationDesired = config\.registrationEnabled === true[\s\S]{0,500}if \(registrationDesired\)[\s\S]{0,200}setSipPhoneRegistration\(true\)/,
  'gateway boot registers SIP only for an active Speak availability lease',
)
assert.doesNotMatch(
  sourceBetween(gateway, 'async function boot()', '\nasync function readGatewayConfig'),
  /await registerSipPhone\(\)/,
  'gateway boot must not unconditionally claim the shared SIP phone',
)
assert.match(gateway, /onInvite/, 'gateway answers inbound SIP invitations')
assert.doesNotMatch(
  gateway,
  /answer-bot|readQaAnswerGatewayConfig|calltools-qa-caller|call\.dial|dialOutboundCall|\bInviter\b/,
  'gateway supports only native campaign invitations and has no retired direct or answer-bot path',
)
assert.match(gateway, /remoteMediaStream/, 'gateway captures remote WebRTC audio')
assert.match(gateway, /createMediaStreamDestination/, 'gateway synthesizes local audio stream')
assert.match(gateway, /resetSyntheticLocalAudioForCall/, 'gateway refreshes synthetic local media per SIP call')
assert.match(
  gateway,
  /function resetActiveCall\(\)[\s\S]*restoreSyntheticLocalAudioAfterCall\('post-call'\)/,
  'gateway rebuilds synthetic local media after every completed SIP call',
)
assert.match(
  gateway,
  /async function restoreSyntheticLocalAudioAfterCall[\s\S]*if \(activeSession\) return[\s\S]*resetSyntheticLocalAudioForCall\(reason\)/,
  'post-call media recovery must not replace media owned by a newer SIP call',
)
assert.match(gateway, /local_audio_outbound_stats/, 'gateway reports outbound WebRTC audio stats for Speak output')
assert.match(
  gateway,
  /gateway\.registration\.set/,
  'gateway accepts explicit SIP registration handoff commands',
)
assert.match(
  gateway,
  /CALLTOOLS_CONTROL_LOSS_UNREGISTER_MS/,
  'gateway bounds how long SIP may stay registered without backend control',
)
assert.match(gateway, /function scheduleControlLossSipUnregister/, 'gateway has a control-loss SIP watchdog')
assert.match(
  sourceBetween(gateway, "socket.addEventListener('close'", '\n    })'),
  /scheduleControlLossSipUnregister/,
  'gateway starts the SIP release watchdog when backend control is lost',
)
assert.match(
  gateway,
  /reconcileRegistrationDesiredFromBackend/,
  'gateway refreshes the durable registration decision after control reconnect',
)
const gatewayReconnectControl = sourceBetween(
  gateway,
  'async function connectGatewaySocketOnce',
  '\nfunction sendGatewayReady',
)
assert.doesNotMatch(
  gatewayReconnectControl,
  /clearControlLossSipUnregister\(\)[\s\S]{0,800}reconcileRegistrationDesiredFromBackend/,
  'opening the control socket cannot cancel SIP release before desired registration is proven',
)
assert.match(
  sourceBetween(
    gateway,
    'async function reconcileRegistrationDesiredFromBackend',
    '\nfunction scheduleControlLossSipUnregister',
  ),
  /gatewayRegistrationReconciledSocket[\s\S]{0,300}clearControlLossSipUnregister/,
  'successful desired-state reconciliation cancels the SIP release watchdog',
)
assert.match(
  sourceBetween(
    gateway,
    'function scheduleControlLossSipUnregister',
    '\nfunction clearControlLossSipUnregister',
  ),
  /gatewayRegistrationReconciledSocket === gatewaySocket/,
  'an open but unreconciled control socket cannot suppress stale SIP release',
)
assert.match(gateway, /setSipPhoneRegistration/, 'gateway applies SIP registration handoffs')
assert.match(
  serverIndex,
  /gatewayOwnerInstanceId/,
  'the durable CallTools lease records its single gateway owner instance',
)
assert.match(
  sourceBetween(serverIndex, "app.get('/api/calltools/gateway-config'", "app.get('/api/calls/recent'"),
  /gatewayInstanceId[\s\S]{0,1000}gatewayOwnerInstanceId[\s\S]{0,1000}registrationEnabled/,
  'gateway bootstrap authorizes SIP registration only for the lease-owned gateway instance',
)
assert.match(
  sourceBetween(
    serverIndex,
    'async function setCallToolsGatewayRegistration',
    '\nasync function requestCallToolsGatewayRegistration',
  ),
  /gatewayOwnerInstanceId[\s\S]{0,1800}calltools_gateway_registration_ambiguous/,
  'registration handoff selects the durable owner and fails closed when ownership is ambiguous',
)
assert.match(
  sourceBetween(
    serverIndex,
    'function callToolsGatewayStatusForProfile',
    '\nasync function assertCallToolsSeatClaimAvailable',
  ),
  /registeredOwnerCount[\s\S]{0,900}duplicateRegisteredGateway/,
  'gateway health fails closed if more than one matching instance is SIP registered',
)
assert.match(
  gateway,
  /async function setSipPhoneRegistration[\s\S]{0,1200}if \(enabled\)[\s\S]{0,500}registerSipPhoneWithRecovery\(\)[\s\S]{0,500}else if[\s\S]{0,500}registerer\.unregister\(\)/,
  'gateway refreshes SIP in place for Speak and unregisters only for the human handoff',
)
assert.match(
  gateway,
  /async function registerSipPhoneWithRecovery[\s\S]*for \(let attempt = 0; attempt < 2; attempt \+= 1\)[\s\S]*resetSipPhoneRuntime\('registration_retry'\)/,
  'a stale SIP transport is rebuilt once before an Available handoff fails',
)
assert.match(
  sourceBetween(gateway, 'async function setSipPhoneRegistration', '\nfunction handleGatewayMessage'),
  /registrationDesired = enabled[\s\S]{0,300}activeSession/,
  'Unavailable records the release direction before an active call can defer SIP teardown',
)
assert.match(
  sourceBetween(gateway, 'async function answerInvitation', '\nfunction maskDialDestination'),
  /!registrationDesired[\s\S]{0,300}reject/,
  'gateway rejects new campaign invitations after Unavailable is requested',
)
assert.match(
  gateway,
  /expectedState[\s\S]{0,500}RegistererState\.Registered[\s\S]{0,500}RegistererState\.Unregistered[\s\S]{0,900}gateway\.registration\.changed/,
  'gateway acknowledges handoff only after the requested SIP registration state is confirmed',
)
assert.match(gateway, /outbound-rtp/, 'gateway verifies outbound RTP counters, not only local playback counters')
assert.match(gateway, /jitter:\s*finiteRtcMetric/, 'gateway reports bounded inbound RTP jitter')
assert.match(gateway, /jitterBufferDelay/, 'gateway reports bounded inbound RTP jitter-buffer delay')
assert.match(
  gateway,
  /jitterBufferEmittedCount/,
  'gateway reports bounded inbound RTP jitter-buffer output count',
)
assert.match(gateway, /packetsDiscarded/, 'gateway reports bounded inbound RTP discard counts')
assert.match(gateway, /summarizeRtcCodec/, 'gateway reports the negotiated audio codec')
assert.match(gateway, /roundTripTime/, 'gateway reports RTP or selected-path round-trip time')
assert.match(gateway, /speak-calltools-playback/, 'gateway uses AudioWorklet playback')
assert.match(gateway, /speak-calltools-recorder/, 'gateway uses AudioWorklet recorder')
assert.match(gateway, /CALLTOOLS_INPUT_FRAME_MS\s*=\s*20/, 'gateway packetizes caller audio into 20 ms frames')
assert.match(gateway, /createPcm16Packetizer/, 'gateway uses an input PCM packetizer')
assert.match(gateway, /frameMs:\s*CALLTOOLS_INPUT_FRAME_MS/, 'gateway annotates caller audio frame duration')
assert.match(gateway, /audio\.input/, 'gateway sends caller audio to Speak')
assert.match(gateway, /audio\.output/, 'gateway receives Speak audio output')
assert.doesNotMatch(gateway, /resolveDialDestination|call\.dial/, 'gateway never originates direct SIP calls')
assert.match(gateway, /activeCallEndedNotified/, 'gateway de-duplicates call end notifications')
assert.match(gateway, /session !== activeSession/, 'gateway ignores stale SIP session state events')
assert.match(gateway, /const session = activeSession/, 'gateway hangup uses a captured active SIP session')
assert.match(gateway, /gateway\.heartbeat/, 'gateway emits readiness heartbeats')
assert.match(
  gateway,
  /sipConnected[\s\S]*sipRegistered[\s\S]*audioContextState[\s\S]*localAudioTrackHealthy[\s\S]*localAudioTrackLive/,
  'gateway readiness reports SIP, audio-context, and local-track health',
)
assert.match(
  gateway,
  /function sendGatewayReady\([\s\S]*if \(!sipRegistered\) return/,
  'gateway does not publish ready before SIP REGISTER succeeds',
)
assert.match(
  gateway,
  /onDisconnect:[\s\S]*sipConnected = false[\s\S]*sipRegistered = false[\s\S]*sendGatewayHeartbeat/,
  'gateway publishes unhealthy readiness after SIP transport disconnects',
)
assert.match(gateway, /scheduleGatewayReconnect/, 'gateway reconnects after backend disconnects')
assert.match(gateway, /type: 'call\.prepare'/, 'gateway preconnects Speak on inbound SIP invite')
assert.match(
  gateway,
  /function answerInvitation[\s\S]{0,2800}waitForCallPreparation\(activeStreamId\)[\s\S]{0,300}announceCallPrepare\(invitation\)[\s\S]{0,300}await preparationPromise[\s\S]{0,1000}callPreparationAccepted\(preparation\)[\s\S]{0,1000}await invitation\.accept/,
  'gateway waits for stream-scoped backend preparation before answering the inbound SIP invite',
)
const preparationAckTimeoutMs = Number(
  gateway.match(/CALLTOOLS_PREPARE_ACK_TIMEOUT_MS\s*=\s*(\d+)/)?.[1] || Number.NaN,
)
assert.ok(
  Number.isFinite(preparationAckTimeoutMs) &&
    preparationAckTimeoutMs > 0 &&
    preparationAckTimeoutMs <= 1400,
  'gateway must reject an unacknowledged SIP invite inside a tight backend-preparation timeout',
)
const callToolsInviteSource = sourceBetween(
  serverIndex,
  'async function createCallToolsGatewayState',
  '\nfunction callToolsDutyAcceptsGatewayCall',
)
assert.ok(
  /assertCodexClmRuntimeReady\([\s\S]{0,180}callToolsCodexReadinessInviteOptions\(\)/.test(
    callToolsInviteSource,
  ),
  'backend invite readiness must consume the prewarmed CallTools Codex proof',
)
assert.ok(
  !/forceRefresh:\s*true/.test(callToolsInviteSource) &&
    !/timeoutMs:/.test(callToolsInviteSource),
  'backend invite readiness must perform no provider I/O inside the gateway acknowledgement window',
)
assert.match(
  sourceBetween(gateway, 'function handleGatewayMessage', '\nfunction isCurrentCallMessage'),
  /call\.prepared[\s\S]{0,350}settleCallPreparation\(message\)[\s\S]*call\.rejected[\s\S]{0,350}settleCallPreparation\(message\)/,
  'prepared/rejected acknowledgements settle only the active stream preparation gate',
)
const inboundIceGatheringTimeout = Number(
  gateway.match(/sessionDescriptionHandlerFactoryOptions:\s*\{[\s\S]{0,600}iceGatheringTimeout:\s*(\d+)/)?.[1] ||
    Number.NaN,
)
assert.ok(
  Number.isFinite(inboundIceGatheringTimeout) && inboundIceGatheringTimeout > 0,
  'gateway must bound WebRTC ICE gathering before sending the inbound SIP 200 response',
)
assert.ok(
  inboundIceGatheringTimeout <= 750,
  'gateway ICE gathering must finish inside the CallTools agent-leg answer window',
)
assert.ok(
  preparationAckTimeoutMs + inboundIceGatheringTimeout <= 1900,
  'backend preparation and WebRTC ICE must remain inside the native campaign answer budget',
)
const inboundAnswerPath = gateway.match(
  /async function answerInvitation[\s\S]*?\n}\n\nfunction maskDialDestination/,
)?.[0] || ''
assert.doesNotMatch(
  inboundAnswerPath,
  /resetSyntheticLocalAudioForCall/,
  'healthy post-call media is reused so audio graph recreation cannot delay SIP answer',
)
assert.match(
  gateway,
  /async function answerInvitation[\s\S]*if \(!gatewayTransportHealthy\(\)\)[\s\S]*await invitation\.reject\([\s\S]*return[\s\S]*activeSession = invitation/,
  'gateway rejects inbound SIP before claiming the session when the Speak backend transport is unhealthy',
)
assert.match(
  gateway,
  /CALLTOOLS_PRE_READY_AUDIO_MAX_MS/,
  'gateway bounds caller PCM retained before backend call.ready',
)
assert.match(
  gateway,
  /pre_ready_audio_flushed/,
  'gateway reports pre-ready PCM flush and drop metrics',
)
assert.match(
  gateway,
  /peerConnection\?\.addEventListener\('track'/,
  'gateway listens to the peer connection for the actual remote audio track',
)
assert.match(
  gateway,
  /CALLTOOLS_REMOTE_TRACK_RECHECK_MS\s*=\s*\d+/,
  'gateway performs a short remote-track recheck',
)
assert.doesNotMatch(
  gateway,
  /CALLTOOLS_REMOTE_TRACK_WAIT_MS|no-track-timeout/,
  'gateway must not wait five seconds and start an empty remote capture graph',
)
assert.match(gatewayRunner, /registerGatewayWithRetry/, 'gateway runner retries registration')
assert.match(
  gatewayRunner,
  /catch \(error\)[\s\S]*browser\.close\(\)/,
  'gateway runner closes Chromium when registration startup fails',
)
assert.match(
  gatewayRunner,
  /catch \(error\)[\s\S]*process\.kill\(process\.pid, 'SIGKILL'\)/,
  'gateway runner hard-exits when registration startup fails',
)
assert.match(gatewayRunner, /CALLTOOLS_GATEWAY_START_ATTEMPTS/, 'gateway runner exposes startup retry count')
assert.match(
  gatewayRunner,
  /CALLTOOLS_GATEWAY_PAGE_LOAD_TIMEOUT_MS/,
  'gateway runner exposes a bounded page-load timeout',
)
assert.match(
  gatewayRunner,
  /waitForGatewayPageShell/,
  'gateway runner preflights the hosted gateway page before launching Chromium',
)
assert.doesNotMatch(
  gatewayRunner,
  /throw new Error\('CALLTOOLS_GATEWAY_PROFILE_ID or profile id argument is required'\)/,
  'gateway runner may bootstrap from the persisted active Speak profile',
)
assert.match(
  gatewayRunner,
  /assertGatewayPageShellAvailable/,
  'gateway runner validates gateway page availability before browser startup',
)
assert.match(
  gatewayRunner,
  /fetch\(pageUrl\.href/,
  'gateway runner uses Node fetch for the page-shell preflight',
)
assert.match(
  gatewayRunner,
  /AbortSignal\.timeout\(pageLoadTimeoutMs\)/,
  'gateway runner bounds the page-shell preflight by page-load timeout',
)
assert.match(
  gatewayRunner,
  /Math\.min\(\s*readyTimeoutMs/,
  'gateway runner caps page-load timeout below the readiness timeout',
)
assert.match(
  gatewayRunner,
  /createGatewayPageFailureMonitor/,
  'gateway runner monitors gateway page responses',
)
assert.match(
  gatewayRunner,
  /waitForGatewayStep/,
  'gateway runner uses a shared race helper for startup steps',
)
assert.match(
  gatewayRunner,
  /document\.body\.dataset\.gatewayProcessReady === 'true'/,
  'gateway service accepts an intentionally unregistered off-duty process as started',
)
assert.match(
  gatewayRunner,
  /step\.catch\(\(\) => \{\}\)/,
  'gateway runner suppresses losing startup promise rejections',
)
assert.match(
  gatewayRunner,
  /writeSync\(2/,
  'gateway runner uses synchronous stderr writes for failure-path logs',
)
assert.match(
  gatewayRunner,
  /status < 500/,
  'gateway runner ignores non-5xx responses while watching gateway startup',
)
assert.match(
  gatewayRunner,
  /isSameOrigin\(responseUrl, pageOrigin\)/,
  'gateway runner only fails fast on same-origin gateway 5xx responses',
)
assert.match(
  gatewayRunner,
  /safeGatewayResponseUrl/,
  'gateway runner redacts gateway URLs before logging startup failures',
)
assert.match(gatewayRunner, /Gateway page returned HTTP/, 'gateway runner rejects stale 5xx gateway pages')
assert.match(serverIndex, /\/api\/calltools\/gateway-config/, 'backend exposes gateway config')
assert.match(
  sourceBetween(serverIndex, "app.get('/api/calltools/gateway-config'", "app.post('/api/calls/start'"),
  /readWorkspaceCallToolsDuty\(\)[\s\S]*isActiveCallToolsDuty[\s\S]*registrationEnabled/,
  'gateway bootstrap derives SIP registration from the durable server-owned duty lease',
)
assert.match(serverIndex, /\/api\/calltools\/media-gateway/, 'backend exposes gateway websocket')
assert.match(serverIndex, /readCallToolsPhoneCredentials/, 'backend reads SIP credentials privately')
assert.match(
  readFileSync('server/calltools-client.mjs', 'utf8'),
  /CALLTOOLS_GATEWAY_PHONE_PASSWORD/,
  'CallTools phone credential reader supports server-side gateway fallback credentials',
)
assert.match(serverIndex, /calltoolsGatewayRegistry/, 'backend tracks idle gateway registrations')
assert.match(serverIndex, /callToolsGatewayStatusForProfile/, 'backend reports profile-specific gateway readiness')
assert.match(
  serverIndex,
  /function bindCallToolsGatewayToProfile/,
  'backend can bind the idle shared CallTools phone to the selected Speak profile',
)
assert.match(
  serverIndex,
  /message\.type === 'gateway\.profile\.selected'/,
  'backend accepts explicit gateway profile-selection proof',
)
assert.match(
  gateway,
  /message\.type === 'gateway\.profile\.select'[\s\S]*activeSession[\s\S]*config\.phone\.id[\s\S]*gateway\.profile\.selected/,
  'gateway switches an idle shared phone to the selected Speak profile and acknowledges it',
)
assert.match(
  serverIndex,
  /targetReady && apply[\s\S]*bindCallToolsGatewayToProfile[\s\S]*ensureCallToolsAgentSessionReadiness/,
  'CallTools agent duty binds the selected Speak profile before making the native seat ready',
)
assert.match(
  serverIndex,
  /function callToolsGatewayMatchesBinding[\s\S]*gateway\.profileId !== profileId[\s\S]*gateway\.phoneId !== phoneId/,
  'gateway selection requires every configured profile and phone binding to match',
)
assert.match(serverIndex, /bindingMismatch/, 'gateway readiness reports profile-to-phone binding mismatch')
assert.match(
  serverIndex,
  /phoneId: safeLeadText\(existing\.phoneId \|\| metadata\.phoneId\)/,
  'gateway-reported physical phone identity remains immutable during per-call profile refresh',
)
assert.match(serverIndex, /CALLTOOLS_GATEWAY_STALE_AFTER_MS/, 'backend defines gateway heartbeat stale window')
assert.match(serverIndex, /lastSeenAgeMs/, 'backend reports gateway heartbeat age')
assert.match(serverIndex, /healthyConnectionCount/, 'backend reports healthy CallTools gateway count')
assert.match(serverIndex, /gateway\.stale[\s\S]*'stale'[\s\S]*'unhealthy'/, 'backend distinguishes stale and unhealthy gateway registrations')
assert.match(serverIndex, /message\.type === 'gateway\.heartbeat'/, 'backend receives gateway heartbeats')
assert.match(serverIndex, /message\.type === 'audio\.input'/, 'backend accepts gateway audio input')
assert.match(
  serverIndex,
  /type: 'call\.ready',[\s\S]*streamId: state\.streamId/,
  'backend binds call.ready to the active stream so stale readiness fails closed',
)
assert.match(
  serverIndex,
  /primeCallToolsVoiceContext\(state, message\)[\s\S]*connectVoiceSession\(state\)[\s\S]*return state/,
  'backend starts selected-profile context and voice preparation before authorizing SIP answer',
)
assert.doesNotMatch(
  callToolsInviteSource,
  /await waitForCallToolsVoiceInputReady\(state\)|await waitForHumeInputPrimerReady\(state\)/,
  'backend SIP admission must not wait for provider readiness because pre-ready caller audio is buffered',
)
assert.match(
  sourceBetween(
    serverIndex,
    'function prepareCallToolsStandbyVoiceSession',
    '\nfunction ensureCallToolsStandbyVoiceSession',
  ),
  /connectImmediately:\s*true/,
  'the selected CallTools profile must preconnect its voice socket while Speak is Available',
)
assert.match(
  serverIndex,
  /function rejectCallToolsGatewayPreparation[\s\S]*error\?\.gatewayRejected === true[\s\S]*function failCallToolsVoiceReadiness[\s\S]*readinessError\.gatewayRejected = gatewayRejected/,
  'backend sends only one CallTools rejection when pre-answer voice preparation fails',
)
assert.match(
  serverIndex,
  /message\.type === 'call\.prepare'/,
  'backend accepts the gateway preconnect message before SIP answer',
)
assert.match(
  serverIndex,
  /type: 'call\.rejected'/,
  'backend reports voice preconnect rejection to the gateway',
)
assert.match(
  gateway,
  /message\.type === 'call\.rejected'[\s\S]*hangupActiveCall\('failed'\)/,
  'gateway ends a SIP call when backend voice preparation fails',
)
assert.match(
  gateway,
  /function isCurrentCallMessage[\s\S]*callMessageMatchesActiveStream[\s\S]*messageStreamId === streamId/,
  'gateway ignores missing or stale per-call messages',
)
assert.match(
  serverIndex,
  /CALLTOOLS_VOICE_READY_TIMEOUT_MS[\s\S]*function scheduleCallToolsVoiceReadyTimeout[\s\S]*failCallToolsVoiceReadiness/,
  'backend bounds Hume/Inworld input readiness and fails closed',
)
assert.match(
  serverIndex,
  /function failCallToolsVoiceReadiness[\s\S]*type: 'call\.rejected',[\s\S]*streamId: state\.streamId/,
  'provider readiness failure is correlated to the active gateway stream',
)
assert.match(
  serverIndex,
  /function markVoiceInputReady[\s\S]*state\.ending[\s\S]*isCallEnded\(state\)/,
  'late provider readiness cannot revive an ended CallTools call',
)
const inworldCreatedBlock = serverIndex.slice(
  serverIndex.indexOf("if (message.type === 'session.created')"),
  serverIndex.indexOf("if (message.type === 'session.updated')"),
)
assert.doesNotMatch(
  inworldCreatedBlock,
  /markVoiceInputReady/,
  'Inworld must not release caller PCM before session.updated acknowledges settings',
)
assert.match(
  serverIndex,
  /if \(message\.type === 'session\.updated'\)[\s\S]*markVoiceInputReady\(state, 'inworld'\)/,
  'Inworld releases caller PCM only after session.updated',
)
assert.match(
  serverIndex,
  /messageQueue = messageQueue[\s\S]*handleCallToolsGatewayMessage/,
  'backend serializes gateway control/media messages per websocket',
)
assert.match(
  serverIndex,
  /ws\.on\('close'[\s\S]*messageQueue = messageQueue[\s\S]*handleCallToolsGatewayClose/,
  'gateway close cleanup drains queued preparation before reading the active state',
)
const gatewayCloseBlock = sourceSection(
  serverIndex,
  'async function handleCallToolsGatewayClose',
  "humanAudioWss.on('connection'",
)
const terminalPersistIndex = gatewayCloseBlock.indexOf('persistCallOutcome(state, state.outcome)')
const terminalEmitIndex = gatewayCloseBlock.indexOf('emitCallEvent(state.callControlId')
const historicalReconcileIndex = gatewayCloseBlock.indexOf(
  'reconcileCallToolsHistoricalCallAfterClose(state)',
)
assert.ok(terminalPersistIndex >= 0, 'gateway close must persist its terminal outcome')
assert.ok(terminalEmitIndex >= 0, 'gateway close must emit its terminal event')
assert.ok(
  historicalReconcileIndex > terminalPersistIndex && historicalReconcileIndex > terminalEmitIndex,
  'gateway close must persist and emit terminal state before detached historical reconciliation',
)
assert.doesNotMatch(
  gatewayCloseBlock,
  /await refreshCallToolsHistoricalCallForState/,
  'gateway close must not block terminal persistence on CallTools historical reads',
)
assert.match(
  serverIndex,
  /function reconcileCallToolsHistoricalCallAfterClose[\s\S]*timeoutMs: CALLTOOLS_GATEWAY_CLOSE_RECONCILE_TIMEOUT_MS/,
  'gateway close historical reconciliation must use a bounded lookup budget',
)
assert.match(
  calltoolsClient,
  /export async function readCallToolsHistoricalCall\([\s\S]*timeoutMs[\s\S]*callToolsHistoricalRequestOptions[\s\S]*callToolsRequest\('\/calls\/', \{[\s\S]*?query,[\s\S]*?timeoutMs: requestOptions\.timeoutMs/,
  'historical CallTools reads must enforce one total request budget across fallback queries',
)
assert.match(
  serverIndex,
  /function assertCallToolsGatewaySocketOpen[\s\S]*calltools_gateway_socket_closed/,
  'gateway preparation fails closed after its websocket starts closing',
)
assert.match(
  serverIndex,
  /function failCallToolsVoiceSession[\s\S]*voiceInputReady[\s\S]*requestCallToolsGatewayHangup/,
  'post-ready Hume or Inworld loss requests immediate CallTools SIP hangup',
)
assert.match(
  serverIndex,
  /calltools_inworld_disconnected_after_ready/,
  'Inworld post-ready disconnects use the CallTools voice-session failure path',
)
assert.match(
  serverIndex,
  /calltools_hume_disconnected_after_ready/,
  'Hume abnormal post-ready disconnects use the CallTools voice-session failure path',
)
assert.match(
  serverIndex,
  /resolveWorkspaceRuntimeSnapshot\(\{[\s\S]*agentProfileId: currentProfileId[\s\S]*calltools_agent_profile_not_found/,
  'campaign invites resolve the current cached profile and fail closed after deletion',
)
assert.match(
  serverIndex,
  /calltools_gateway_phone_binding_mismatch/,
  'campaign invites reject a gateway physically registered to the wrong CallTools phone',
)
assert.match(
  serverIndex,
  /queue\.droppedFrames = Math\.max/,
  'final audio quality preserves CallTools pre-ready frame drops',
)
for (const messageType of ['audio.output', 'audio.clear', 'call.end']) {
  const messagePattern = new RegExp(
    `type: '${messageType.replace('.', '\\.')}',[\\s\\S]{0,180}streamId: state\\.streamId`,
  )
  assert.match(serverIndex, messagePattern, `${messageType} must be bound to the active stream`)
}
assert.match(
  gateway,
  /Speak gateway disconnected[\s\S]*hangupActiveCall\('failed'\)/,
  'backend websocket loss ends any active SIP call before reconnect',
)
assert.match(
  gatewayService,
  /CALLTOOLS_GATEWAY_PAGE_URL=http:\/\/127\.0\.0\.1:8791\/speak\/calltools-gateway\.html/,
  'production gateway page uses the same-host loopback transport',
)
assert.match(
  gatewayService,
  /Wants=network-online\.target speak\.service/,
  'explicit gateway startup must pull in Speak without coupling Speak restarts back to SIP',
)
assert.match(
  gatewayService,
  /After=network-online\.target speak\.service/,
  'gateway startup must remain ordered after the Speak backend',
)
assert.doesNotMatch(
  gatewayService,
  /^(?:Requires|PartOf|BindsTo)=speak\.service$/m,
  'Speak restarts must never start, stop, or restart an inactive human-shift gateway',
)
assert.doesNotMatch(
  gatewayService,
  /agent-config-calltools-default/,
  'production gateway service must not pin the shared CallTools seat to one Speak profile',
)
assert.match(serverIndex, /inputFrameMs/, 'backend records CallTools input frame duration diagnostics')
assert.match(serverIndex, /outboundRtp/, 'backend preserves bounded outbound RTP diagnostics from the gateway')
assert.match(serverIndex, /firstAudioRtpStats/, 'backend normalizes gateway RTP diagnostics without storing raw browser stats')
assert.match(
  serverIndex,
  /resolveCallToolsLiveCallContext\(\{[\s\S]*?calltoolsCallId(?:: state\.calltoolsCallId)?,[\s\S]*?from: message\.from,[\s\S]*?to: message\.to,[\s\S]*?config: (?:runtimeConfig|state\.config),[\s\S]*?\}\)/,
  'CallTools campaign-follow attaches by resolving live CallTools call context',
)
assert.match(
  sourceBetween(
    serverIndex,
    'async function activatePrewarmedHumeSession',
    '\nexport function buildHumeSessionSettings',
  ),
  /buildHumeSessionSettings[\s\S]*armCallToolsFirstTurnGate\(state, 'hume'\)[\s\S]*markVoiceInputReady/,
  'Hume arms output-only first-turn verification before CallTools releases buffered caller audio',
)
assert.doesNotMatch(
  sourceBetween(
    serverIndex,
    'async function activatePrewarmedHumeSession',
    '\nexport function buildHumeSessionSettings',
  ),
  /pause_assistant_message/,
  'the normal Hume caller path must not pause response generation before the first turn',
)
assert.doesNotMatch(
  sourceBetween(
    serverIndex,
    'function armCallToolsFirstTurnGate',
    '\nfunction pauseCallToolsFirstTurnProvider',
  ),
  /pause_assistant_message|pauseCallToolsFirstTurnProvider/,
  'arming first-turn verification must remain an output-only gate on the normal caller path',
)
assert.match(
  sourceBetween(
    serverIndex,
    'function applyCallToolsFirstTurnTranscript',
    '\nasync function pauseVoiceAssistant',
  ),
  /decision\.action === 'resume'[\s\S]*resumeCallToolsFirstTurnProvider[\s\S]*decision\.action === 'hold'[\s\S]*pauseCallToolsFirstTurnProvider/,
  'provider pause and resume controls are reserved for a detected automated first turn',
)
assert.match(
  sourceBetween(
    serverIndex,
    'export function buildInworldSession',
    '\nfunction inworldReasoningEffort',
  ),
  /create_response:\s*callToolsFirstTurnAutoResponseEnabled\(state\)/,
  'Inworld begins response generation on the verified-turn event path without an extra round trip',
)
assert.match(
  sourceBetween(
    serverIndex,
    'async function createCallToolsGatewayState',
    '\nfunction callToolsDutyAcceptsGatewayCall',
  ),
  /createCallToolsFirstTurnGate\(\{[\s\S]*assistantStartsConversation:\s*runtimeConfig\.eviStartsConversation === true/,
  'CallTools preserves the selected Hume provider-start setting instead of stripping it',
)
assert.match(
  serverIndex,
  /applyCallToolsFirstTurnTranscript\(state, content, 'hume'\)/,
  'Hume final caller transcripts open the provider-neutral CallTools first-turn gate',
)
assert.match(
  serverIndex,
  /applyCallToolsFirstTurnTranscript\(state, normalized, provider\)/,
  'provider-neutral final caller transcripts open the CallTools first-turn gate',
)
assert.match(
  sourceBetween(serverIndex, 'function handleInworldMessage', '\nfunction inworldTranscriptKey'),
  /provider:\s*'inworld'/,
  'Inworld final caller transcripts identify their runtime before opening the shared CallTools first-turn gate',
)
assert.match(
  sourceBetween(serverIndex, 'function handleXaiMessage', '\nfunction xaiTranscriptKey'),
  /provider:\s*'xai'/,
  'xAI final caller transcripts identify their runtime before opening the shared CallTools first-turn gate',
)
assert.match(
  serverIndex,
  /const callToolsCallWatchdog = createCallToolsCallWatchdog\(\{[\s\S]*readDuty: readWorkspaceCallToolsDuty[\s\S]*readRecentCalls[\s\S]*readAgentInstructions[\s\S]*repair:/,
  'the VM backend owns a duty-scoped CallTools call-log and transcript watchdog',
)
assert.match(
  serverIndex,
  /CALLTOOLS_WATCHDOG_INTERVAL_MS[\s\S]{0,220}5 \* 60_000/,
  'the CallTools watchdog defaults to a five-minute cadence',
)
assert.match(
  serverIndex,
  /callToolsDutyMonitor\.start\(\)[\s\S]{0,180}callToolsCallWatchdog\.start\(\)/,
  'the CallTools watchdog starts with the VM Speak service',
)
assert.match(
  serverIndex,
  /callToolsCallWatchdog\.stop\(\)[\s\S]{0,180}callToolsDutyMonitor\.stop\(\)/,
  'the CallTools watchdog stops cleanly with the VM Speak service',
)
assert.match(
  serverIndex,
  /app\.get\('\/api\/calltools\/watchdog'[\s\S]*callToolsCallWatchdog\.publicState\(\)/,
  'watchdog status and flagged call IDs are available through a read-only backend endpoint',
)
assert.doesNotMatch(
  serverIndex,
  /CALLTOOLS_PENDING_START_TTL_MS|calltoolsPendingStarts|registerCallToolsPendingStart|takeMatchingCallToolsPendingStart|calltoolsPendingStart|pendingStartMatched/,
  'campaign-follow attach must not retain obsolete one-shot pending-start state',
)
assert.match(
  sourceBetween(
    serverIndex,
    'async function createCallToolsGatewayState',
    '\nfunction callToolsDutyAcceptsGatewayCall',
  ),
  /normalizeCampaignConfig\(\s*withCallToolsRuntimeIdentity\(profile\)/,
  'CallTools runtime preparation preserves the complete selected profile configuration',
)
assert.match(
  sourceBetween(
    serverIndex,
    'async function createCallToolsGatewayState',
    '\nfunction callToolsDutyAcceptsGatewayCall',
  ),
  /message\.operatorInstructions[\s\S]{0,3200}primeCallToolsVoiceContext\(state, message\)/,
  'campaign-follow attach keeps gateway instructions and pre-answer live context hydration',
)
assert.match(
  serverIndex,
  /function callToolsGatewaySourceFields/,
  'CallTools gateway leads preserve source identity fields',
)
assert.match(
  serverIndex,
  /contextLead\.sourceId[\s\S]*message\.lead\?\.sourceId[\s\S]*callToolsProviderSourceId\(providerIds\)/,
  'CallTools gateway source IDs prefer resolved live context before provider fallback',
)
assert.match(
  serverIndex,
  /\.\.\.sourceFields,[\s\S]*providerIds,/,
  'CallTools gateway lead includes source fields before workspace persistence',
)
assert.match(serverIndex, /type: 'audio\.output'/, 'backend emits gateway audio output')
assert.match(serverIndex, /type: 'call\.end'/, 'backend can request gateway hangup')
assert.doesNotMatch(
  closeCallSocketsBody(serverIndex),
  /calltoolsWs\?\.close/,
  'generic call cleanup must not unregister the persistent CallTools gateway',
)
assert.match(callAudio, /lead-calltools-input/, 'CallTools caller audio diagnostics are retained')
assert.match(callAudio, /ai-calltools-output/, 'CallTools agent audio diagnostics are retained')
assert.match(callAudio, /operator-calltools-output/, 'CallTools takeover audio diagnostics are retained')
assert.match(
  transportDiagnostics,
  /calltools:\s*compactObject/,
  'transport diagnostics expose a CallTools section',
)
assert.match(
  transportDiagnostics,
  /calltoolsDialToGatewayAttach/,
  'transport diagnostics expose CallTools dial-to-answer timing',
)
assert.match(
  transportDiagnostics,
  /firstCallToolsLeadAudioToFirstUserMessage/,
  'transport diagnostics expose CallTools caller-audio transcription timing',
)
assert.match(
  transportDiagnostics,
  /firstInworldAudioToFirstCallToolsAudio/,
  'transport diagnostics expose Inworld-to-CallTools audio output timing',
)
assert.match(liveProof, /buildCallToolsProofGates/, 'live proof enforces CallTools latency and quality gates')
assert.match(proofGates, /CALLTOOLS_PROOF_MAX_FIRST_USER_TO_ASSISTANT_MESSAGE_MS/, 'CallTools proof gates expose caller-to-assistant latency threshold')
assert.match(proofGates, /CALLTOOLS_PROOF_MAX_FIRST_USER_TO_ASSISTANT_AUDIO_MS/, 'CallTools proof gates measure caller transcript to assistant audio latency')
assert.match(proofGates, /CALLTOOLS_PROOF_MAX_PROVIDER_AUDIO_TO_CALLTOOLS_AUDIO_MS/, 'CallTools proof gates expose output transport latency threshold')
assert.match(proofGates, /CALLTOOLS_PROOF_MAX_INVITE_TO_VOICE_INPUT_READY_MS/, 'CallTools proof gates enforce campaign invite-to-provider readiness')
assert.match(proofGates, /CALLTOOLS_PROOF_MAX_DROPPED_FRAMES/, 'CallTools proof gates expose dropped-frame threshold')
assert.match(proofGates, /CALLTOOLS_PROOF_MAX_DECODE_ERRORS/, 'CallTools proof gates expose decode-error threshold')

const humeUserMessageHandler = sourceBetween(
  serverIndex,
  "if (message.type === 'user_message') {",
  "if (message.type === 'assistant_message') {",
)
assert.match(
  humeUserMessageHandler,
  /clearQueuedAssistantAudio\(state, 'hume_user_message'\)/,
  'every Hume user_message, including verbose interim speech, must clear queued assistant audio before transcript handling',
)
assert.ok(
  humeUserMessageHandler.indexOf("clearQueuedAssistantAudio(state, 'hume_user_message')") <
    humeUserMessageHandler.indexOf('if (message.interim)'),
  'Hume queued audio must clear before interim and final user-message branches diverge',
)
assert.doesNotMatch(
  humeUserMessageHandler,
  /scheduleStableInterimFinalizer|stable_interim_commit/,
  'verbose Hume interim transcripts must never be reinjected as synthetic user turns',
)
const inworldTranscriptionDeltaHandler = sourceBetween(
  serverIndex,
  "if (message.type === 'conversation.item.input_audio_transcription.delta') {",
  "if (message.type === 'conversation.item.input_audio_transcription.completed') {",
)
assert.doesNotMatch(
  inworldTranscriptionDeltaHandler,
  /scheduleStableInterimFinalizer|stable_interim_commit/,
  'partial Inworld transcription deltas must never be reinjected as synthetic user turns',
)

verifyPreReadyAudioBuffer(gateway)
await verifyRejectedPreparationNeverAccepts(gateway)

console.log('CallTools media gateway checks passed')

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  if (start < 0) return ''
  const end = source.indexOf(endMarker, start + startMarker.length)
  return source.slice(start, end < 0 ? source.length : end)
}

function closeCallSocketsBody(source) {
  const match = source.match(/function closeCallSockets\(state\) \{([\s\S]*?)\n\}/)
  return match?.[1] || ''
}

function sourceSection(source, start, end) {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  assert.ok(startIndex >= 0, `missing source section start: ${start}`)
  assert.ok(endIndex > startIndex, `missing source section end: ${end}`)
  return source.slice(startIndex, endIndex)
}

function verifyPreReadyAudioBuffer(source) {
  const implementation = markedSource(
    source,
    'CALLTOOLS_PRE_READY_AUDIO_BUFFER_START',
    'CALLTOOLS_PRE_READY_AUDIO_BUFFER_END',
  )
  const createBuffer = Function(`${implementation}\nreturn createPreReadyAudioBuffer`)()
  const streamMatcherImplementation = markedSource(
    source,
    'CALLTOOLS_ACTIVE_STREAM_MATCH_START',
    'CALLTOOLS_ACTIVE_STREAM_MATCH_END',
  )
  const callMessageMatchesActiveStream = Function(
    `${streamMatcherImplementation}\nreturn callMessageMatchesActiveStream`,
  )()
  const buffer = createBuffer(3)
  const frame = (value) => new Uint8Array([value, value + 10])

  buffer.push(frame(1))
  buffer.push(frame(2))
  buffer.push(frame(3))
  buffer.push(frame(4))
  assert.equal(
    callMessageMatchesActiveStream({ streamId: 'previous-call' }, true, 'active-call'),
    false,
    'a late ready/control message from the previous call must not unlock active-call PCM',
  )
  assert.deepEqual(
    buffer.snapshot(),
    {
      ready: false,
      bufferedFrames: 3,
      maxBufferedFrames: 3,
      droppedFrames: 1,
      flushedFrames: 0,
      flushCount: 0,
    },
    'pre-ready PCM buffer must remain bounded and report oldest-frame drops',
  )

  assert.equal(
    callMessageMatchesActiveStream({ streamId: 'active-call' }, true, 'active-call'),
    true,
    'the active campaign-follow stream may release buffered PCM after provider readiness',
  )
  const firstFlush = buffer.markReady()
  assert.deepEqual(
    firstFlush.map((item) => [...item]),
    [[2, 12], [3, 13], [4, 14]],
    'pre-ready PCM flush must preserve chronological frame order',
  )
  assert.deepEqual(buffer.markReady(), [], 'pre-ready PCM may flush only once per call')
  assert.equal(buffer.push(frame(5)), false, 'ready calls must bypass the pre-ready PCM buffer')
  assert.equal(
    callMessageMatchesActiveStream({ streamId: 'active-call' }, false, 'active-call'),
    false,
    'ended SIP sessions must reject late audio/clear/end controls even when stream IDs match',
  )
  assert.deepEqual(
    buffer.snapshot(),
    {
      ready: true,
      bufferedFrames: 0,
      maxBufferedFrames: 3,
      droppedFrames: 1,
      flushedFrames: 3,
      flushCount: 1,
    },
    'pre-ready PCM metrics must retain the completed flush proof',
  )

  buffer.clear()
  assert.deepEqual(
    buffer.snapshot(),
    {
      ready: false,
      bufferedFrames: 0,
      maxBufferedFrames: 0,
      droppedFrames: 0,
      flushedFrames: 0,
      flushCount: 0,
    },
    'pre-ready PCM state and metrics must clear between calls',
  )
}

async function verifyRejectedPreparationNeverAccepts(source) {
  const implementation = markedSource(
    source,
    'CALLTOOLS_PREPARATION_ACCEPTANCE_START',
    'CALLTOOLS_PREPARATION_ACCEPTANCE_END',
  )
  const callPreparationAccepted = Function(
    `${implementation}\nreturn callPreparationAccepted`,
  )()
  let acceptCalls = 0
  const warmThenProxyUnhealthy = await Promise.resolve({
    status: 'rejected',
    streamId: 'active-stream',
    code: 'codex_proxy_unavailable',
  })
  if (callPreparationAccepted(warmThenProxyUnhealthy)) acceptCalls += 1
  assert.equal(
    acceptCalls,
    0,
    'a warm standby followed by proxy-unhealthy call.rejected proof must never send SIP 200',
  )
  assert.equal(
    callPreparationAccepted({ status: 'prepared', streamId: 'active-stream' }),
    true,
    'only stream-scoped call.prepared proof may authorize SIP accept',
  )
}

function markedSource(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker)
  assert.ok(start >= 0 && end > start, `missing ${startMarker}/${endMarker} test markers`)
  return source.slice(source.indexOf('\n', start) + 1, source.lastIndexOf('\n', end))
}
