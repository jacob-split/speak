import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'speak-calltools-live-proof-contract-'))

try {
  const noAudio = runScenario({ scenario: 'no-audio', withAudio: false })
  const withAudio = runScenario({ scenario: 'native-invite', withAudio: true })
  const humeWithAudio = runScenario({
    scenario: 'hume-native-invite',
    withAudio: true,
    voiceProvider: 'hume',
  })
  const providerIdTransition = runScenario({
    scenario: 'provider-id-transition',
    withAudio: true,
    callControlProviderCallId: 'sip-leg-call-id',
    eventProviderCallId: 'sip-leg-call-id',
  })
  const slowPreconnect = runScenario({
    scenario: 'slow-preconnect',
    withAudio: true,
    inviteToReadyMs: 3000,
  })
  const legacyDialing = runScenario({
    scenario: 'legacy-dialing',
    withAudio: true,
    nativeInvite: false,
  })
  const mismatchedIdentity = runScenario({
    scenario: 'identity-mismatch',
    withAudio: true,
    actualCampaignId: '99999',
  })
  const missingProviderAuthority = runScenario({
    scenario: 'missing-provider-authority',
    withAudio: true,
    authoritativeIdentity: false,
  })
  const mismatchedProviderAppUser = runScenario({
    scenario: 'provider-app-user-mismatch',
    withAudio: true,
    authoritativeAppUserId: 'another-app-user',
  })
  const staleArtifact = runScenario({
    scenario: 'stale-artifact',
    withAudio: true,
    startedAfter: '2026-07-04T13:00:05.000Z',
  })
  const recordingReview = runScenario({
    scenario: 'recording-review',
    withAudio: true,
    recordingReview: { ok: true, status: 'clean', findings: [] },
  })
  const failures = []

  if (noAudio.status === 0) {
    failures.push('transport-only proof unexpectedly passed without diagnostic WAV evidence')
  }
  if (noAudio.payload?.callerAudioAudible !== false || noAudio.payload?.assistantAudioAudible !== false) {
    failures.push('transport-only proof did not report missing audible caller/assistant audio')
  }
  if (!noAudio.payload?.callerAudioTransport || !noAudio.payload?.assistantAudioTransport) {
    failures.push('transport-only proof fixture did not exercise transport packet counters')
  }
  if (withAudio.status !== 0 || !withAudio.payload?.ok) {
    failures.push('WAV-backed proof did not pass the live proof checker')
  }
  if (humeWithAudio.status !== 0 || !humeWithAudio.payload?.ok) {
    failures.push('Hume-backed native invite did not pass the provider-neutral live proof checker')
  }
  if (providerIdTransition.status !== 0 || !providerIdTransition.payload?.identity?.ok) {
    failures.push('authoritative CallTools call correlation did not tolerate the expected SIP-leg ID transition')
  }
  if (withAudio.payload?.schemaVersion !== 'speak.calltools.campaign-proof.v1') {
    failures.push('native invite proof did not emit the campaign-proof schema')
  }
  if (!withAudio.payload?.accepted || !withAudio.payload?.identity?.ok) {
    failures.push('native invite proof did not require a matching campaign/profile/provider identity')
  }
  if (!withAudio.payload?.timestamps?.inviteReceived) {
    failures.push('native invite proof did not expose its invite timestamp')
  }
  if (withAudio.payload?.gates?.audioQuality?.diagnostics?.rawProviderClippedFrames !== 1) {
    failures.push('WAV-backed proof did not preserve raw provider clipping diagnostics')
  }
  if (!withAudio.payload?.callerAudioAudible || !withAudio.payload?.assistantAudioAudible) {
    failures.push('WAV-backed proof did not report audible caller/assistant audio')
  }
  const slowInviteGate = slowPreconnect.payload?.gates?.latency?.checks?.find(
    (check) => check.id === 'calltoolsInviteToVoiceInputReady',
  )
  if (slowPreconnect.status === 0 || slowInviteGate?.ok !== false) {
    failures.push('slow campaign preconnect did not fail the invite-to-voice-ready latency gate')
  }
  if (legacyDialing.status === 0 || legacyDialing.payload?.accepted !== false) {
    failures.push('legacy gateway-dialing event was incorrectly accepted without a native invite')
  }
  if (mismatchedIdentity.status === 0 || mismatchedIdentity.payload?.identity?.ok !== false) {
    failures.push('campaign identity mismatch was incorrectly accepted')
  }
  if (missingProviderAuthority.status === 0 || missingProviderAuthority.payload?.identity?.ok !== false) {
    failures.push('configured lease fallbacks were accepted without provider-authoritative live-call identity')
  }
  if (mismatchedProviderAppUser.status === 0 || mismatchedProviderAppUser.payload?.identity?.ok !== false) {
    failures.push('provider live-call app user mismatch was accepted')
  }
  if (staleArtifact.status === 0 || staleArtifact.payload?.error !== 'native_campaign_call_artifact_not_found') {
    failures.push('startedAfter allowed an older campaign call artifact')
  }
  if (
    recordingReview.status !== 0 ||
    recordingReview.payload?.recordingTranscriptOk !== true ||
    recordingReview.payload?.recordingTranscriptReview?.status !== 'clean'
  ) {
    failures.push('recording review was not embedded in the campaign artifact')
  }

  const fullAudit = readFileSync('scripts/check-full-e2e-audit.mjs', 'utf8')
  const readiness = readFileSync('scripts/check-calltools-readiness.mjs', 'utf8')
  const agentSessionHelper = readFileSync('scripts/ensure-calltools-agent-session.mjs', 'utf8')
  const serverIndex = readFileSync('server/index.mjs', 'utf8')
  if (/qa:calltools-contact-proof|calltools:prepare-proof-contact/.test(fullAudit)) {
    failures.push('full audit still auto-runs legacy direct/contact proof')
  }
  if (!/qa:calltools-live-proof/.test(fullAudit) || !/--startedAfter=/.test(fullAudit)) {
    failures.push('full audit does not wait for a run-bound native campaign proof')
  }
  if (!/includeLive[\s\S]{0,1200}runCallToolsAgentSessionForAudit/.test(fullAudit)) {
    failures.push('campaign-follow arming is not explicitly gated by include-live')
  }
  if (
    !/let calltoolsOwnedLease = null/.test(fullAudit) ||
    !/finally \{[\s\S]{0,300}await releaseCallToolsAuditLease\(\)/.test(fullAudit) ||
    !/leaseId:[\s\S]{0,200}profileId:[\s\S]{0,200}appUserId:[\s\S]{0,200}campaignId:[\s\S]{0,200}phoneId:/.test(fullAudit) ||
    !/--expectedLeaseId=/.test(fullAudit)
  ) {
    failures.push('full audit does not release only the exact campaign lease it acquired')
  }
  if (!/leaseOwnership/.test(agentSessionHelper) || !/initialLeaseId/.test(agentSessionHelper)) {
    failures.push('agent-session helper does not distinguish acquired from pre-existing duty leases')
  }
  if (!/expectedLeaseId/.test(serverIndex) || !/calltools_duty_release_scope_mismatch/.test(serverIndex)) {
    failures.push('backend does not fail closed on a mismatched scoped duty release')
  }
  if (/prepareProofContact|api\/calltools\/prepare-lead|ensureProofContact/.test(readiness)) {
    failures.push('strict readiness still mutates proof-contact inventory')
  }
  if (/24 \* 60 \* 60 \* 1000/.test(fullAudit)) {
    failures.push('CallTools certification proof freshness still permits a 24-hour artifact')
  }
  if (!/60 \* 60 \* 1000/.test(fullAudit)) {
    failures.push('CallTools certification proof freshness is not bounded to one hour')
  }

  const result = {
    ok: failures.length === 0,
    schemaVersion: 'speak.calltools-live-proof-contract.v1',
    scenarios: {
      transportOnly: scenarioSummary(noAudio),
      wavBacked: scenarioSummary(withAudio),
      humeWavBacked: scenarioSummary(humeWithAudio),
      providerIdTransition: scenarioSummary(providerIdTransition),
      slowPreconnect: scenarioSummary(slowPreconnect),
      legacyDialing: scenarioSummary(legacyDialing),
      mismatchedIdentity: scenarioSummary(mismatchedIdentity),
      missingProviderAuthority: scenarioSummary(missingProviderAuthority),
      mismatchedProviderAppUser: scenarioSummary(mismatchedProviderAppUser),
      staleArtifact: scenarioSummary(staleArtifact),
      recordingReview: scenarioSummary(recordingReview),
    },
    failures,
  }
  console.log(JSON.stringify(result, null, 2))
  process.exit(result.ok ? 0 : 1)
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function runScenario({
  scenario,
  withAudio,
  inviteToReadyMs = 600,
    nativeInvite = true,
    actualCampaignId = '12345',
  authoritativeIdentity = true,
  authoritativeAppUserId = 'agent-user-id',
  voiceProvider = 'inworld',
  callControlProviderCallId = '',
  eventProviderCallId = '',
  startedAfter = '',
  recordingReview = null,
}) {
  const providerCallId = `provider-${scenario}`
  const id = `calltools-${callControlProviderCallId || providerCallId}`
  const scenarioDir = path.join(tempRoot, id)
  const audioDir = path.join(scenarioDir, 'call-audio')
  const logFile = path.join(scenarioDir, 'events.jsonl')
  const recordingReviewFile = path.join(scenarioDir, 'recording-review.json')
  mkdirSync(scenarioDir, { recursive: true })
  if (withAudio) {
    const diagnosticDir = path.join(audioDir, id)
    mkdirSync(diagnosticDir, { recursive: true })
    writeSineWav(path.join(diagnosticDir, 'lead-calltools-input.wav'))
    writeSineWav(path.join(diagnosticDir, 'ai-calltools-output.wav'))
    writeSineWav(path.join(audioDir, `${id}.wav`), { seconds: 2 })
  }
  writeFileSync(logFile, syntheticLog(id, {
    actualCampaignId,
    inviteToReadyMs,
    nativeInvite,
    providerCallId,
    authoritativeIdentity,
    authoritativeAppUserId,
    voiceProvider,
    eventProviderCallId,
  }))
  if (recordingReview) {
    writeFileSync(recordingReviewFile, JSON.stringify(recordingReview))
  }
  const result = spawnSync(process.execPath, [
    'scripts/check-calltools-live-proof.mjs',
    '--require-complete',
    `--callControlId=${id}`,
    '--profileId=profile-jai-stan',
    '--campaignId=12345',
    `--providerCallId=${providerCallId}`,
    ...(startedAfter ? [`--startedAfter=${startedAfter}`] : []),
    ...(recordingReview ? [`--recordingReview=${recordingReviewFile}`] : []),
    '--minCallerTurns=2',
    '--minAssistantTurns=2',
    `--log=${logFile}`,
    `--callAudioDir=${audioDir}`,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
  return {
    status: result.status,
    payload: parseJson(result.stdout),
    stderr: result.stderr,
  }
}

function scenarioSummary(result) {
  return {
    status: result.status,
    ok: Boolean(result.payload?.ok),
    callerAudioTransport: Boolean(result.payload?.callerAudioTransport),
    callerAudioAudible: Boolean(result.payload?.callerAudioAudible),
    assistantAudioTransport: Boolean(result.payload?.assistantAudioTransport),
    assistantAudioAudible: Boolean(result.payload?.assistantAudioAudible),
    accepted: Boolean(result.payload?.accepted),
    identityOk: Boolean(result.payload?.identity?.ok),
    error: result.payload?.error || '',
  }
}

function syntheticLog(
  callControlId,
  {
    actualCampaignId = '12345',
    inviteToReadyMs = 600,
    nativeInvite = true,
    providerCallId = '',
    authoritativeIdentity = true,
    authoritativeAppUserId = 'agent-user-id',
    voiceProvider = 'inworld',
    eventProviderCallId = '',
  } = {},
) {
  const t = (ms) => new Date(Date.UTC(2026, 6, 4, 13, 0, 0, ms)).toISOString()
  const inviteTimestamps = nativeInvite
    ? { calltools_gateway_invite_received: t(0) }
    : { calltools_gateway_dial_requested: t(0) }
  const voiceTimestamps = voiceProvider === 'hume'
    ? {
        hume_chat_attached: t(300),
        first_hume_audio_output: t(1000),
      }
    : {
        inworld_session_attached: t(300),
        first_inworld_audio_output: t(1000),
      }
  const records = [
    record(callControlId, t(0), { notice: 'CallTools gateway dialing' }),
    record(callControlId, t(100), { patch: { answeredAt: t(100) } }),
    record(callControlId, t(200), {
      diagnostic: {
        calltools: true,
        timestamps: {
          ...inviteTimestamps,
          calltools_gateway_attached: t(100),
          voice_input_ready: t(inviteToReadyMs),
          first_calltools_media_in: t(200),
          ...voiceTimestamps,
          first_user_message: t(500),
          first_assistant_message: t(900),
          first_calltools_media_out: t(1100),
        },
        timingMs: {
          calltoolsInviteToVoiceInputReady: inviteToReadyMs,
          calltoolsAttachToInworldSession: 200,
          firstCallToolsLeadAudioToFirstUserMessage: 300,
          firstUserMessageToFirstAssistantMessage: 400,
          firstUserMessageToFirstAssistantAudio: 600,
          firstInworldAudioToFirstCallToolsAudio: 100,
          calltoolsAttachToFirstAssistantAudio: 1000,
        },
        counters: {
          calltoolsMediaInPackets: 12,
          calltoolsMediaOutPackets: 16,
        },
      },
      audioQuality: {
        codec: 'L16',
        sampleRate: 16000,
        inbound: {
          clippedFrames: 0,
          oddBytePayloads: 0,
          decodeErrors: 0,
        },
        humeOutput: {
          clippedFrames: 1,
          peakRatioMax: 0.9999,
        },
        telnyxOutput: {
          clippedFrames: 0,
          peakRatioMax: 0.56,
        },
        queue: {
          maxMs: 20,
          droppedFrames: 0,
        },
      },
      audio: {
        status: 'ready',
        sources: ['lead', 'ai'],
        durationSeconds: 2,
      },
    }),
    record(callControlId, t(500), {
      entry: { speaker: 'lead', text: 'Hello, can you hear me?', providerEventId: 'lead-1' },
    }),
    record(callControlId, t(900), {
      entry: { speaker: 'ai', text: 'Yes, I can hear you.', providerEventId: 'ai-1' },
    }),
    record(callControlId, t(1300), {
      entry: { speaker: 'lead', text: 'How does the audio sound?', providerEventId: 'lead-2' },
    }),
    record(callControlId, t(1700), {
      entry: { speaker: 'ai', text: 'The audio path is clear.', providerEventId: 'ai-2' },
    }),
    record(callControlId, t(1900), { patch: { phase: 'ended', outcome: 'completed' } }),
  ]
  for (const item of records) {
    item.event.communication.providerIds.calltoolsCampaignId = actualCampaignId
    item.event.communication.providerIds.calltoolsCallId = providerCallId
  }
  if (eventProviderCallId) {
    records[0].event.communication.providerIds.calltoolsCallId = eventProviderCallId
    records[1].event.communication.providerIds.calltoolsCallId = eventProviderCallId
  }
  if (authoritativeIdentity) {
    records[2].event.calltoolsProviderIdentity = {
      ok: true,
      authoritative: true,
      provider: 'calltools',
      verifiedAt: t(210),
      leaseId: 'lease-jai-stan',
      profileId: 'profile-jai-stan',
      appUserId: authoritativeAppUserId,
      campaignId: actualCampaignId,
      phoneId: 'phone-shared-seat',
      providerCallId,
      expected: {
        leaseId: 'lease-jai-stan',
        profileId: 'profile-jai-stan',
        appUserId: 'agent-user-id',
        campaignId: '12345',
        phoneId: 'phone-shared-seat',
      },
    }
  }
  return `${records.map((item) => JSON.stringify(item)).join('\n')}\n`
}

function record(callControlId, at, event) {
  const providerCallId = callControlId.replace(/^calltools-/, '')
  return {
    callControlId,
    at,
    provider: 'calltools',
    agent: {
      id: 'profile-jai-stan',
      name: 'Jai Stan',
      voiceRuntimeProvider: 'hume',
    },
    event: {
      ...event,
      communication: {
        ...(event.communication || {}),
        provider: 'calltools',
        providerIds: {
          calltoolsCallId: providerCallId,
          calltoolsCampaignId: '12345',
          calltoolsPhoneId: 'phone-shared-seat',
          ...(event.communication?.providerIds || {}),
        },
      },
    },
  }
}

function writeSineWav(filePath, { sampleRate = 16000, seconds = 1, frequency = 440 } = {}) {
  const samples = sampleRate * seconds
  const dataBytes = samples * 2
  const buffer = Buffer.alloc(44 + dataBytes)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataBytes, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataBytes, 40)
  for (let index = 0; index < samples; index += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 4000)
    buffer.writeInt16LE(sample, 44 + index * 2)
  }
  writeFileSync(filePath, buffer)
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
