import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import {
  flushPersistedCallEvents,
  persistCallEvent,
  recentCallSummaries,
  transcriptEntry,
} from '../server/call-history.mjs'
import { createCallState, publicLeadContext } from '../server/call-state.mjs'
import {
  PERSONAL_PHONE_HANDOFF_SCHEMA,
  PERSONAL_PHONE_RESOLVE_SCHEMA,
  PersonalPhoneInboundHandoffRegistry,
  normalizePersonalPhoneInboundHandoffRequest,
  normalizePersonalPhoneInboundResolveRequest,
  personalPhoneInboundBearerAuthorized,
  personalPhoneInboundCorrelationId,
  personalPhoneVoicemailResponse,
  resolvePersonalPhoneInboundEligibility,
} from '../server/personal-phone-inbound.mjs'
import { assertPersonalPhoneInboundSourceCompatibility } from '../server/workspace-store.mjs'

const nowMs = Date.parse('2026-07-13T05:00:00.000Z')
const expectedDid = '+12025550143'
const sourceId = 'bluebubbles:contacts'
const personalPhoneConfigModule = await import(
  '../src/personalPhoneInboundConfig.ts'
).catch(() => ({}))

assert.deepEqual(
  personalPhoneConfigModule.personalPhoneInboundConfigForToggle?.(
    {
      enabled: false,
      eligibilityScope: 'selected',
      sourceId: '',
      contactIds: [],
      smartViewIds: [],
    },
    { enabled: true, sourceId },
  ),
  {
    enabled: true,
    eligibilityScope: 'source',
    sourceId,
    contactIds: [],
    smartViewIds: [],
  },
  'enabling an empty legacy Personal Phone policy must use the authoritative source default',
)

assert.deepEqual(
  personalPhoneConfigModule.personalPhoneInboundConfigForToggle?.(
    {
      enabled: false,
      eligibilityScope: 'selected',
      sourceId: 'legacy-source',
      contactIds: ['contact-1'],
      smartViewIds: [],
    },
    { enabled: true, sourceId },
  ),
  {
    enabled: true,
    eligibilityScope: 'selected',
    sourceId,
    contactIds: ['contact-1'],
    smartViewIds: [],
  },
  'enabling Personal Phone must preserve explicit caller selections',
)

assert.equal(
  assertPersonalPhoneInboundSourceCompatibility(
    [
      {
        name: 'Selected-contact Personal Phone agent',
        config: {
          personalPhoneInbound: {
            enabled: true,
            eligibilityScope: 'selected',
            sourceId: '',
            contactIds: ['contact-1'],
          },
        },
      },
    ],
    sourceId,
  ),
  true,
  'selected-contact Personal Phone eligibility must not block unrelated profile saves',
)
const baseRequest = {
  schemaVersion: PERSONAL_PHONE_HANDOFF_SCHEMA,
  eventId: 'event-1',
  callControlId: 'call-1',
  callSessionId: 'session-1',
  from: '+15555550101',
  to: expectedDid,
  status: 'no-answer',
  occurredAt: new Date(nowMs).toISOString(),
}
const validRequest = normalizePersonalPhoneInboundHandoffRequest(baseRequest, {
  expectedDid,
  now: nowMs,
})
assert.equal(validRequest.ok, true)
assert.equal(validRequest.value.status, 'no-answer')
assert.equal(
  personalPhoneInboundBearerAuthorized('Bearer shared-secret', 'shared-secret'),
  true,
)
assert.equal(
  personalPhoneInboundBearerAuthorized('Bearer wrong-secret', 'shared-secret'),
  false,
)

for (const [name, request, expectedReason] of [
  ['schema', { ...baseRequest, schemaVersion: 'wrong' }, 'invalid_request'],
  ['status', { ...baseRequest, status: 'answered' }, 'non_terminal_status'],
  [
    'stale',
    { ...baseRequest, occurredAt: new Date(nowMs - 120_001).toISOString() },
    'stale_request',
  ],
  ['event length', { ...baseRequest, eventId: 'e'.repeat(241) }, 'invalid_request'],
  [
    'call id length',
    { ...baseRequest, callControlId: 'c'.repeat(521) },
    'invalid_request',
  ],
]) {
  const result = normalizePersonalPhoneInboundHandoffRequest(request, {
    expectedDid,
    now: nowMs,
  })
  assert.equal(result.ok, false, `${name} request must fail`)
  assert.equal(result.reason, expectedReason)
}
assert.equal(
  normalizePersonalPhoneInboundHandoffRequest(baseRequest, {
    expectedDid: '',
    now: nowMs,
  }).reason,
  'personal_phone_did_not_configured',
)
for (const [reason, expectedReason] of [
  ['personal_phone_did_not_configured', 'disabled'],
  ['personal_phone_source_not_configured', 'disabled'],
  ['handoff_persistence_unavailable', 'disabled'],
  ['handoff_not_found_or_expired', 'replay_expired'],
  ['unknown_internal_reason', 'invalid_request'],
  ['unknown_contact', 'unknown_contact'],
]) {
  assert.equal(
    personalPhoneVoicemailResponse(reason, 'public-reason-check').reason,
    expectedReason,
    `${reason} must map to a frozen public reason`,
  )
}

const resolveRequest = {
  schemaVersion: PERSONAL_PHONE_RESOLVE_SCHEMA,
  eventId: baseRequest.eventId,
  callControlId: baseRequest.callControlId,
  connectStatus: 'stopped',
  occurredAt: new Date(nowMs).toISOString(),
}
assert.equal(
  normalizePersonalPhoneInboundResolveRequest(resolveRequest, {
    correlationId: 'correlation-1',
    now: nowMs,
  }).ok,
  true,
)
for (const request of [
  { ...resolveRequest, schemaVersion: 'wrong' },
  { ...resolveRequest, connectStatus: 'connected' },
  { ...resolveRequest, occurredAt: new Date(nowMs - 120_001).toISOString() },
  { ...resolveRequest, eventId: 'e'.repeat(241) },
]) {
  assert.equal(
    normalizePersonalPhoneInboundResolveRequest(request, {
      correlationId: 'correlation-1',
      now: nowMs,
    }).ok,
    false,
  )
}

const lead = {
  id: 'personal-contact-1',
  source: 'personal-phone',
  sourceId,
  phone: baseRequest.from,
  name: 'Personal contact',
}
const baseProfile = {
  id: 'profile-1',
  name: 'Personal Phone agent',
  config: {
    dialerProvider: 'calltools',
    humeConfigId: 'hume-config-1',
    humeConfigVersion: 4,
    personalPhoneInbound: {
      enabled: true,
      eligibilityScope: 'source',
      sourceId,
      contactIds: [],
      smartViewIds: [],
    },
  },
}
const eligibilityInput = {
  handoff: validRequest.value,
  leads: [lead],
  profiles: [baseProfile],
  smartViews: [],
  sourceId,
  profileReady: () => ({ ready: true, blockers: [] }),
}
const directDecision = resolvePersonalPhoneInboundEligibility(eligibilityInput)
assert.equal(directDecision.decision, 'connect')
assert.equal(directDecision.matchedBy, 'source')
assert.equal(
  directDecision.correlationId,
  personalPhoneInboundCorrelationId(validRequest.value),
)
assert.equal(
  resolvePersonalPhoneInboundEligibility({ ...eligibilityInput, sourceId: '' }).reason,
  'personal_phone_source_not_configured',
)
assert.equal(
  resolvePersonalPhoneInboundEligibility({ ...eligibilityInput, leads: [] }).reason,
  'unknown_contact',
)
assert.equal(
  resolvePersonalPhoneInboundEligibility({
    ...eligibilityInput,
    leads: [{ ...lead, source: 'manual' }],
  }).reason,
  'unknown_contact',
)
assert.equal(
  resolvePersonalPhoneInboundEligibility({
    ...eligibilityInput,
    leads: [{ ...lead, sourceId: 'bluebubbles:other-source' }],
  }).reason,
  'unknown_contact',
)
assert.equal(
  resolvePersonalPhoneInboundEligibility({
    ...eligibilityInput,
    handoff: {
      ...normalizePersonalPhoneInboundHandoffRequest(
        { ...baseRequest, from: '(555) 555-0101' },
        { expectedDid, now: nowMs },
      ).value,
    },
  }).decision,
  'connect',
)
assert.equal(
  resolvePersonalPhoneInboundEligibility({
    ...eligibilityInput,
    leads: [lead, { ...lead, id: 'duplicate-contact' }],
  }).reason,
  'ambiguous_contact',
)
assert.equal(
  resolvePersonalPhoneInboundEligibility({ ...eligibilityInput, profiles: [] }).reason,
  'disabled',
)
assert.equal(
  resolvePersonalPhoneInboundEligibility({
    ...eligibilityInput,
    profiles: [{ ...baseProfile, config: { ...baseProfile.config, dialerProvider: undefined } }],
  }).decision,
  'connect',
)
assert.equal(
  resolvePersonalPhoneInboundEligibility({
    ...eligibilityInput,
    profiles: [
      {
        ...baseProfile,
        config: {
          ...baseProfile.config,
          personalPhoneInbound: {
            enabled: true,
            eligibilityScope: 'selected',
            sourceId,
            contactIds: [],
            smartViewIds: [],
          },
        },
      },
    ],
  }).reason,
  'ineligible_contact',
)
assert.equal(
  resolvePersonalPhoneInboundEligibility({
    ...eligibilityInput,
    profiles: [
      {
        ...baseProfile,
        config: {
          ...baseProfile.config,
          personalPhoneInbound: {
            ...baseProfile.config.personalPhoneInbound,
            sourceId: 'bluebubbles:other-source',
          },
        },
      },
    ],
  }).reason,
  'ineligible_contact',
)
assert.equal(
  resolvePersonalPhoneInboundEligibility({
    ...eligibilityInput,
    profiles: [baseProfile, { ...baseProfile, id: 'profile-2' }],
  }).reason,
  'ambiguous_profile',
)
assert.equal(
  resolvePersonalPhoneInboundEligibility({
    ...eligibilityInput,
    profileReady: () => ({ ready: false, blockers: ['HUME_API_KEY'] }),
  }).reason,
  'profile_not_ready',
)
const smartViewDecision = resolvePersonalPhoneInboundEligibility({
  ...eligibilityInput,
  profiles: [
    {
      ...baseProfile,
      config: {
        ...baseProfile.config,
        personalPhoneInbound: {
          enabled: true,
          eligibilityScope: 'selected',
          sourceId,
          contactIds: [],
          smartViewIds: ['smart-view-1'],
        },
      },
    },
  ],
  smartViews: [{ id: 'smart-view-1', leadIds: [lead.id] }],
})
assert.equal(smartViewDecision.decision, 'connect')
assert.equal(smartViewDecision.matchedBy, 'smart_view')

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'speak-personal-phone-inbound-'))
try {
  const storePath = path.join(tempDir, 'handoffs.json')
  let clock = nowMs
  const registry = new PersonalPhoneInboundHandoffRegistry({
    persistencePath: storePath,
    now: () => clock,
  })
  assert.deepEqual(registry.readiness(), { durable: true, ready: true, error: '' })

  const voicemailHandoff = { ...validRequest.value, eventId: 'voicemail-event' }
  const voicemailDecision = resolvePersonalPhoneInboundEligibility({
    ...eligibilityInput,
    handoff: voicemailHandoff,
    leads: [],
  })
  const voicemailRecord = registry.recordVoicemail({
    handoff: voicemailHandoff,
    decision: voicemailDecision,
  })
  const reloadedVoicemailRegistry = new PersonalPhoneInboundHandoffRegistry({
    persistencePath: storePath,
    now: () => clock,
  })
  const replayedVoicemail = reloadedVoicemailRegistry.findByEvent(
    voicemailHandoff.eventId,
    voicemailHandoff.callControlId,
  )
  assert.equal(replayedVoicemail.correlationId, voicemailRecord.correlationId)
  assert.deepEqual(
    reloadedVoicemailRegistry.publicDecisionResponse(replayedVoicemail),
    registry.publicDecisionResponse(voicemailRecord),
  )
  clock = voicemailRecord.expiresAtMs + 1
  const expiredVoicemailReplay =
    reloadedVoicemailRegistry.publicDecisionResponse(replayedVoicemail)
  assert.equal(expiredVoicemailReplay.decision, 'voicemail')
  assert.equal(expiredVoicemailReplay.reason, 'replay_expired')
  assert.equal(expiredVoicemailReplay.correlationId, voicemailRecord.correlationId)
  clock = nowMs

  const prepared = prepareConnect(registry, 'prepared-event')
  const preparedResponse = registry.publicConnectResponse(prepared.record)
  assert.equal(preparedResponse.stream.codec, 'PCMU')
  assert.equal(preparedResponse.stream.samplingRate, 8000)
  const reloadedConnectRegistry = new PersonalPhoneInboundHandoffRegistry({
    persistencePath: storePath,
    now: () => clock,
  })
  const replayedConnect = reloadedConnectRegistry.findByEvent(
    prepared.handoff.eventId,
    prepared.handoff.callControlId,
  )
  assert.equal(replayedConnect.correlationId, prepared.record.correlationId)
  assert.deepEqual(
    reloadedConnectRegistry.publicConnectResponse(replayedConnect),
    preparedResponse,
  )
  const token = new URL(preparedResponse.stream.url).searchParams.get(
    'personalPhoneHandoff',
  )
  assert.ok(token)
  assert.ok(reloadedConnectRegistry.consume(token))
  assert.equal(reloadedConnectRegistry.consume(token), null)
  const consumedReplay = reloadedConnectRegistry.publicDecisionResponse(replayedConnect)
  assert.equal(consumedReplay.decision, 'voicemail')
  assert.equal(consumedReplay.reason, 'replay_expired')
  assert.equal(consumedReplay.correlationId, prepared.record.correlationId)

  const expiring = prepareConnect(registry, 'expiring-replay')
  clock = expiring.record.expiresAtMs + 1
  const expiredReplay = registry.publicDecisionResponse(expiring.record)
  assert.equal(expiredReplay.decision, 'voicemail')
  assert.equal(expiredReplay.reason, 'replay_expired')
  assert.equal(expiredReplay.correlationId, expiring.record.correlationId)

  const longConversation = prepareConnect(registry, 'long-conversation')
  registry.attach(longConversation.record.correlationId, {
    callControlId: longConversation.handoff.callControlId,
  })
  registry.markConversationStarted(longConversation.record.correlationId)
  clock += 2 * 60 * 60_000
  assert.equal(
    registry.findByEvent(
      longConversation.handoff.eventId,
      longConversation.handoff.callControlId,
    )?.correlationId,
    longConversation.record.correlationId,
  )
  assertResolution(
    registry.resolve(resolveInput(longConversation)),
    'completed',
    'hangup',
    'conversation_completed',
  )

  const preparedTerminal = prepareConnect(registry, 'terminal-prepared')
  assertResolution(
    registry.resolve(resolveInput(preparedTerminal)),
    'expired',
    'voicemail',
    'handoff_not_consumed',
  )

  const attachedTerminal = prepareConnect(registry, 'terminal-attached')
  registry.attach(attachedTerminal.record.correlationId, {
    callControlId: attachedTerminal.handoff.callControlId,
  })
  assertResolution(
    registry.resolve(resolveInput(attachedTerminal)),
    'stream_failed_before_conversation',
    'voicemail',
    'stream_ended_before_conversation',
  )

  const conversationTerminal = prepareConnect(registry, 'terminal-conversation')
  registry.attach(conversationTerminal.record.correlationId, {
    callControlId: conversationTerminal.handoff.callControlId,
  })
  registry.markConversationStarted(conversationTerminal.record.correlationId)
  const completed = registry.resolve(resolveInput(conversationTerminal))
  assertResolution(completed, 'completed', 'hangup', 'conversation_completed')
  assert.deepEqual(registry.resolve(resolveInput(conversationTerminal)), completed)

  for (const terminalState of ['completed', 'agent_hangup', 'caller_hangup']) {
    const terminal = prepareConnect(registry, `terminal-${terminalState}`)
    registry.markTerminal(terminal.record.correlationId, terminalState, terminalState)
    assertResolution(
      registry.resolve(resolveInput(terminal)),
      terminalState,
      'hangup',
      terminalState,
    )
  }

  const failedBeforeConversation = prepareConnect(
    registry,
    'terminal-failed-before-conversation',
  )
  registry.markTerminal(
    failedBeforeConversation.record.correlationId,
    'stream_failed_before_conversation',
    'stream_status_failed_before_conversation',
  )
  assertResolution(
    registry.resolve(resolveInput(failedBeforeConversation)),
    'stream_failed_before_conversation',
    'voicemail',
    'stream_status_failed_before_conversation',
  )

  const unknown = registry.resolve({
    correlationId: 'unknown-correlation',
    eventId: 'unknown-event',
    callControlId: 'unknown-call',
  })
  assertResolution(
    unknown,
    'expired',
    'voicemail',
    'handoff_not_found_or_expired',
  )
  assert.deepEqual(unknown.proof, {})

  const fileMode = (await stat(storePath)).mode & 0o777
  assert.equal(fileMode, 0o600)
  assert.equal(
    JSON.parse(await readFile(storePath, 'utf8')).schemaVersion,
    'speak.personal-phone.inbound-handoff-store.v1',
  )

  const corruptPath = path.join(tempDir, 'corrupt.json')
  await writeFile(corruptPath, '{not-json', { mode: 0o600 })
  const corruptRegistry = new PersonalPhoneInboundHandoffRegistry({
    persistencePath: corruptPath,
    now: () => clock,
  })
  assert.equal(corruptRegistry.readiness().ready, false)
  assert.equal(corruptRegistry.readiness().error, 'handoff_store_unreadable')

  const unwritableRegistry = new PersonalPhoneInboundHandoffRegistry({
    persistencePath: path.join(tempDir, 'unwritable.json'),
    now: () => clock,
  })
  unwritableRegistry.persist = () => {
    unwritableRegistry.persistenceError = 'handoff_store_unwritable'
    return false
  }
  const unwritableHandoff = {
    ...validRequest.value,
    eventId: 'unwritable-event',
    callControlId: 'call-unwritable-event',
    occurredAt: new Date(clock).toISOString(),
  }
  const unwritableDecision = resolvePersonalPhoneInboundEligibility({
    ...eligibilityInput,
    handoff: unwritableHandoff,
  })
  assert.equal(
    unwritableRegistry.prepare({
      handoff: unwritableHandoff,
      decision: unwritableDecision,
      lead: unwritableDecision.lead,
      profile: unwritableDecision.profile,
      runtimeConfig: unwritableDecision.runtimeConfig,
      runtimeContext: {
        lead: unwritableDecision.lead,
        profile: unwritableDecision.profile,
        profileContext: {},
      },
      streamUrl: 'wss://speak.example.com/speak/media-stream',
    }),
    null,
  )
  assert.equal(unwritableRegistry.byCorrelationId.size, 0)
  assert.equal(
    unwritableRegistry.findByEvent(
      unwritableHandoff.eventId,
      unwritableHandoff.callControlId,
    ),
    null,
  )

  function prepareConnect(targetRegistry, eventId) {
    clock += 1
    const handoff = {
      ...validRequest.value,
      eventId,
      callControlId: `call-${eventId}`,
      occurredAt: new Date(clock).toISOString(),
    }
    const decision = resolvePersonalPhoneInboundEligibility({
      ...eligibilityInput,
      handoff,
    })
    const runtimeContext = {
      lead: decision.lead,
      profile: decision.profile,
      profileContext: {},
    }
    const record = targetRegistry.prepare({
      handoff,
      decision,
      lead: decision.lead,
      profile: decision.profile,
      runtimeConfig: decision.runtimeConfig,
      runtimeContext,
      streamUrl: 'wss://speak.example.com/speak/media-stream',
    })
    assert.ok(record)
    return { handoff, decision, record }
  }
} finally {
  await rm(tempDir, { recursive: true, force: true })
}

const serverIndex = readFileSync('server/index.mjs', 'utf8')
const secrets = readFileSync('server/secrets.mjs', 'utf8')
const settingsPanel = readFileSync('src/SpeakSettingsPanel.tsx', 'utf8')
const uiContract = readFileSync('src/uiContract.ts', 'utf8')
const agentContract = readFileSync('server/agent-contract.mjs', 'utf8')
assert.match(serverIndex, /app\.post\('\/api\/personal-phone\/inbound\/handoffs'/)
assert.match(serverIndex, /normalizePersonalPhoneInboundResolveRequest\(request\.body/)
assert.match(serverIndex, /personalPhoneInboundHandoffs\.recordVoicemail/)
assert.match(serverIndex, /sourceId: personalPhoneContactSourceId\(\)/)
const personalPhoneHandoffRoute = serverIndex.slice(
  serverIndex.indexOf("app.post('/api/personal-phone/inbound/handoffs'"),
  serverIndex.indexOf("app.get('/api/personal-phone/inbound/readiness'"),
)
const personalPhoneProvisionalStarts = [
  ...personalPhoneHandoffRoute.matchAll(
    /prepareProvisionalVoiceSession\(\{[\s\S]{0,260}?requireBinding:\s*true[\s\S]{0,80}?\}\)/g,
  ),
]
assert.equal(
  personalPhoneProvisionalStarts.length,
  2,
  'new and replayed Personal Phone handoffs must keep provider prewarm blocked until Telnyx media binds',
)
const humePrewarmActivation = serverIndex.slice(
  serverIndex.indexOf('async function activatePrewarmedHumeSession('),
  serverIndex.indexOf('export function buildHumeSessionSettings('),
)
assert.ok(
  humePrewarmActivation.indexOf('await waitForVoicePrewarmBinding(state)') >= 0 &&
    humePrewarmActivation.indexOf('await waitForVoicePrewarmBinding(state)') <
      humePrewarmActivation.indexOf('buildHumeSessionSettings(state'),
  'Hume may open TLS and prewarm context, but session settings remain blocked until call binding',
)
assert.match(
  serverIndex,
  /function maybeSendInitialGreetingPrompt[\s\S]{0,500}isProvisionalVoiceSessionState\(state\)/,
  'Personal Phone provider prewarm must not emit a greeting before the Telnyx call binds',
)
const telnyxStartStateStart = serverIndex.indexOf(
  'const state =',
  serverIndex.indexOf('async function handleTelnyxMessage'),
)
const telnyxStartStateEnd = serverIndex.indexOf(
  'if (!state)',
  telnyxStartStateStart,
)
assert.ok(telnyxStartStateStart >= 0 && telnyxStartStateEnd > telnyxStartStateStart)
const telnyxStartStateSelection = serverIndex.slice(
  telnyxStartStateStart,
  telnyxStartStateEnd,
)
assert.ok(
  telnyxStartStateSelection.indexOf('createPersonalPhoneInboundCallState') <
    telnyxStartStateSelection.indexOf('getCallState(callControlId)'),
  'Personal Phone stream start must bind and mark the provisional handoff answered before generic call lookup can return the provisional state',
)
const resolveRouteStart = serverIndex.indexOf(
  "'/api/personal-phone/inbound/handoffs/:correlationId/resolve'",
)
const resolveRouteEnd = serverIndex.indexOf(
  "app.get('/api/calltools/campaign-contacts'",
  resolveRouteStart,
)
assert.ok(resolveRouteStart >= 0 && resolveRouteEnd > resolveRouteStart)
const resolveRoute = serverIndex.slice(resolveRouteStart, resolveRouteEnd)
assert.ok(
  resolveRoute.indexOf('normalizePersonalPhoneInboundResolveRequest(request.body') <
    resolveRoute.indexOf('personalPhoneInboundHandoffs.resolve(normalized.value)'),
  'resolve.v1 must be validated before durable handoff state is resolved',
)
assert.doesNotMatch(
  serverIndex,
  /PERSONAL_PHONE_CONTACTS_SOURCE_ID \|\| 'bluebubbles:contacts'/,
)
assert.doesNotMatch(serverIndex, /PERSONAL_PHONE_TELNYX_DID \|\|\s*process\.env\.PERSONAL_PHONE_NUMBER/)
assert.match(secrets, /getSecret\('PERSONAL_PHONE_SPEAK_HANDOFF_SECRET', 'personal-phone-speak-handoff-secret'\)/)
assert.doesNotMatch(secrets, /readMacKeychainSecret\('speak-personal-phone-handoff-secret'\)/)
assert.match(settingsPanel, /Answer missed Personal Phone calls/)
assert.match(settingsPanel, /Find Personal Phone contact/)
assert.match(settingsPanel, /All contacts from this Personal Phone source/)
assert.match(settingsPanel, /Selected contacts or Smart Views/)
assert.match(settingsPanel, /apiUrl\('\/personal-phone\/inbound\/readiness'\)/)
assert.match(settingsPanel, /cache:\s*'no-store'/)
assert.match(settingsPanel, /authoritativePersonalPhoneSourceId/)
assert.match(settingsPanel, /speakTestIds\.personalPhoneInboundReadiness/)
assert.match(uiContract, /personalPhoneInboundReadiness:\s*'speak-personal-phone-inbound-readiness'/)
assert.match(agentContract, /personalPhoneInbound/)
assert.match(agentContract, /eligibilityScope/)

await verifyPersonalPhoneCallHistoryAttribution()
await verifyHeadlessApiContract()

console.log('Personal Phone inbound handoff checks passed.')

function resolveInput(prepared) {
  return {
    correlationId: prepared.record.correlationId,
    eventId: prepared.handoff.eventId,
    callControlId: prepared.handoff.callControlId,
  }
}

function assertResolution(value, state, nextAction, reason) {
  assert.equal(value.schemaVersion, PERSONAL_PHONE_RESOLVE_SCHEMA)
  assert.equal(value.state, state)
  assert.equal(value.terminal, true)
  assert.equal(value.nextAction, nextAction)
  assert.equal(value.reason, reason)
}

async function verifyPersonalPhoneCallHistoryAttribution() {
  const callLogDir = await mkdtemp(
    path.join(os.tmpdir(), 'speak-personal-phone-call-history-'),
  )
  try {
    const callControlId = 'personal-phone-history-call'
    const state = createCallState(
      callControlId,
      lead,
      directDecision.runtimeConfig,
      [],
    )
    state.callProvider = 'telnyx_texml'
    state.answered = true
    state.answeredAt = state.createdAt

    for (const event of [
      { entry: transcriptEntry('Lead', 'Can you help with my missed call?') },
      { entry: transcriptEntry('AI', 'Yes, I can help you now.') },
      {
        patch: { phase: 'ended', outcome: 'completed' },
        outcome: 'completed',
      },
    ]) {
      state.eventLog.push(event)
      state.updatedAt = new Date().toISOString()
      await persistCallEvent({
        callLogDir,
        callControlId,
        state,
        event,
        leadForState: publicLeadContext,
      })
    }
    await flushPersistedCallEvents()

    const summaries = recentCallSummaries({
      callStates: [],
      callLogDir,
      limit: 10,
      leadForState: publicLeadContext,
    })
    assert.equal(summaries.length, 1)
    const [summary] = summaries
    assert.equal(summary.callControlId, callControlId)
    assert.equal(summary.provider, 'telnyx_texml')
    assert.equal(summary.agent?.id, baseProfile.id)
    assert.equal(summary.agent?.name, baseProfile.name)
    assert.equal(summary.lead?.id, lead.id)
    assert.equal(summary.lead?.source, lead.source)
    assert.equal(summary.lead?.sourceId, lead.sourceId)
    assert.equal(summary.lead?.phone_on_file, lead.phone)
    assert.equal(summary.phase, 'ended')
    assert.equal(summary.outcome, 'completed')
    assert.deepEqual(
      summary.transcript.map((turn) => [turn.speaker, turn.text]),
      [
        ['Lead', 'Can you help with my missed call?'],
        ['AI', 'Yes, I can help you now.'],
      ],
    )
  } finally {
    await rm(callLogDir, { recursive: true, force: true })
  }
}

async function verifyHeadlessApiContract() {
  const runtimeDir = await mkdtemp(
    path.join(os.tmpdir(), 'speak-personal-phone-api-'),
  )
  const port = await availablePort()
  const baseUrl = `http://127.0.0.1:${port}/speak/api`
  const bearer = 'qa-personal-phone-handoff-secret'
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      BASE_PATH: '/speak',
      PUBLIC_BASE_URL: 'https://speak.example.com/speak',
      VOICE_STREAM_URL: 'wss://speak.example.com/speak/media-stream',
      SPEAK_WORKSPACE_DATA_DIR: runtimeDir,
      PERSONAL_PHONE_TELNYX_DID: expectedDid,
      PERSONAL_PHONE_CONTACTS_SOURCE_ID: sourceId,
      PERSONAL_PHONE_SPEAK_HANDOFF_SECRET: bearer,
      PERSONAL_PHONE_SPEAK_STREAM_HOST: 'speak.example.com',
      HUME_API_KEY: 'qa-hume-api-key',
      HUME_CONFIG_ID: 'qa-hume-config',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  })

  try {
    await waitForApi(`${baseUrl}/health`, child)

    const createdLead = await requestJson(`${baseUrl}/leads`, {
      method: 'POST',
      body: {
        lead: {
          id: lead.id,
          source: lead.source,
          sourceId: lead.sourceId,
          phone: lead.phone,
          name: lead.name,
          status: 'ready',
        },
      },
    })
    assert.equal(createdLead.response.status, 200)
    assert.equal(createdLead.payload.lead?.id, lead.id)

    const createdProfile = await requestJson(`${baseUrl}/profiles`, {
      method: 'POST',
      body: {
        profile: {
          id: baseProfile.id,
          name: baseProfile.name,
          config: {
            ...baseProfile.config,
            instructions: 'Handle this Personal Phone caller.',
            personalPhoneInbound: {
              ...baseProfile.config.personalPhoneInbound,
              enabled: false,
            },
          },
        },
      },
    })
    assert.equal(createdProfile.response.status, 200)
    assert.equal(createdProfile.payload.profile?.id, baseProfile.id)
    assert.equal(createdProfile.payload.profile?.config?.speakConfigVersion, 4)
    assert.equal(
      createdProfile.payload.profile?.config?.personalPhoneInbound?.enabled,
      false,
    )
    assert.equal(
      createdProfile.payload.profile?.config?.personalPhoneInbound?.eligibilityScope,
      'source',
    )
    assert.equal(
      createdProfile.payload.profile?.config?.personalPhoneInbound?.sourceId,
      sourceId,
    )

    const defaultOffReadiness = await requestJson(
      `${baseUrl}/personal-phone/inbound/readiness`,
    )
    assert.equal(defaultOffReadiness.response.status, 200)
    assert.equal(defaultOffReadiness.payload.ready, false)
    assert.ok(
      defaultOffReadiness.payload.blockers?.includes(
        'PERSONAL_PHONE_INBOUND_PROFILE',
      ),
    )
    assert.equal(defaultOffReadiness.payload.contactSource?.sourceId, sourceId)

    const incompatibleSourceProfile = await requestJson(`${baseUrl}/profiles`, {
      method: 'POST',
      body: {
        profile: {
          ...createdProfile.payload.profile,
          id: 'profile-incompatible-personal-phone-source',
          name: 'Incompatible Personal Phone source',
          config: {
            ...createdProfile.payload.profile.config,
            personalPhoneInbound: {
              ...createdProfile.payload.profile.config.personalPhoneInbound,
              enabled: true,
              eligibilityScope: 'source',
              sourceId: 'legacy-personal-phone:contacts',
            },
          },
        },
      },
    })
    assert.equal(incompatibleSourceProfile.response.status, 409)
    assert.match(
      incompatibleSourceProfile.payload.error || '',
      /must use the configured Personal Phone contact source/,
    )

    const defaultOffHandoff = await requestJson(
      `${baseUrl}/personal-phone/inbound/handoffs`,
      {
        method: 'POST',
        bearer,
        body: runtimeHandoff('api-default-off'),
      },
    )
    assert.equal(defaultOffHandoff.payload.decision, 'voicemail')
    assert.equal(defaultOffHandoff.payload.reason, 'disabled')

    const enabledProfile = await requestJson(`${baseUrl}/profiles`, {
      method: 'POST',
      body: {
        profile: {
          ...createdProfile.payload.profile,
          config: {
            ...createdProfile.payload.profile.config,
            personalPhoneInbound: {
              ...createdProfile.payload.profile.config.personalPhoneInbound,
              enabled: true,
            },
          },
        },
      },
    })
    assert.equal(enabledProfile.response.status, 200)
    assert.equal(
      enabledProfile.payload.profile?.config?.personalPhoneInbound?.enabled,
      true,
    )
    const conflictingProfile = await requestJson(`${baseUrl}/profiles`, {
      method: 'POST',
      body: {
        profile: {
          ...enabledProfile.payload.profile,
          id: 'profile-conflicting-personal-phone-agent',
          name: 'Conflicting Personal Phone agent',
        },
      },
    })
    assert.equal(conflictingProfile.response.status, 409)
    assert.match(
      conflictingProfile.payload.error || '',
      /Personal Phone inbound source/,
    )

    const profiles = await requestJson(`${baseUrl}/profiles`)
    const publicProfile = profiles.payload.profiles?.find(
      (profile) => profile.id === baseProfile.id,
    )
    assert.equal(publicProfile?.config?.speakConfigVersion, 4)
    assert.equal(
      publicProfile?.config?.personalPhoneInbound?.eligibilityScope,
      'source',
    )
    assert.equal(publicProfile?.config?.personalPhoneInbound?.sourceId, sourceId)
    const roundTrippedProfile = await requestJson(`${baseUrl}/profiles`, {
      method: 'POST',
      body: { profile: publicProfile },
    })
    assert.equal(roundTrippedProfile.response.status, 200)
    assert.equal(roundTrippedProfile.payload.profile?.config?.speakConfigVersion, 4)

    const readiness = await requestJson(`${baseUrl}/personal-phone/inbound/readiness`)
    assert.equal(readiness.response.status, 200)
    assert.equal(readiness.payload.ready, true)
    assert.equal(readiness.payload.proof?.backendOnly, true)
    assert.equal(readiness.payload.proof?.headlessOnly, true)
    assert.equal(readiness.payload.proof?.policyNetworkCalls, false)
    assert.equal(readiness.payload.proof?.durableReplay, true)

    const unauthorized = await requestJson(
      `${baseUrl}/personal-phone/inbound/handoffs`,
      { method: 'POST', body: runtimeHandoff('api-unauthorized') },
    )
    assert.equal(unauthorized.response.status, 401)

    const unknown = await requestJson(
      `${baseUrl}/personal-phone/inbound/handoffs`,
      {
        method: 'POST',
        bearer,
        body: {
          ...runtimeHandoff('api-unknown'),
          from: '+15555550199',
        },
      },
    )
    assert.equal(unknown.response.status, 200)
    assert.equal(unknown.payload.decision, 'voicemail')
    assert.equal(unknown.payload.reason, 'unknown_contact')
    const unknownReplay = await requestJson(
      `${baseUrl}/personal-phone/inbound/handoffs`,
      {
        method: 'POST',
        bearer,
        body: {
          ...runtimeHandoff('api-unknown'),
          from: '+15555550199',
        },
      },
    )
    assert.equal(unknownReplay.payload.correlationId, unknown.payload.correlationId)
    assert.equal(unknownReplay.payload.reason, unknown.payload.reason)

    const eligibleRequest = runtimeHandoff('api-eligible')
    const eligible = await requestJson(
      `${baseUrl}/personal-phone/inbound/handoffs`,
      { method: 'POST', bearer, body: eligibleRequest },
    )
    assert.equal(eligible.response.status, 200)
    assert.equal(eligible.payload.decision, 'connect')
    assert.equal(eligible.payload.reason, 'eligible_profile_ready')
    assert.equal(eligible.payload.stream?.codec, 'PCMU')
    assert.equal(eligible.payload.stream?.samplingRate, 8000)
    assert.equal(new URL(eligible.payload.stream?.url).hostname, 'speak.example.com')
    const eligibleReplay = await requestJson(
      `${baseUrl}/personal-phone/inbound/handoffs`,
      { method: 'POST', bearer, body: eligibleRequest },
    )
    assert.equal(eligibleReplay.payload.decision, 'connect')
    assert.equal(eligibleReplay.payload.correlationId, eligible.payload.correlationId)
    assert.equal(eligibleReplay.payload.stream?.url, eligible.payload.stream?.url)

    const eligibleResolution = await resolveRuntimeHandoff({
      baseUrl,
      bearer,
      correlationId: eligible.payload.correlationId,
      request: eligibleRequest,
    })
    assertResolution(
      eligibleResolution.payload,
      'expired',
      'voicemail',
      'handoff_not_consumed',
    )
    const eligibleResolutionReplay = await resolveRuntimeHandoff({
      baseUrl,
      bearer,
      correlationId: eligible.payload.correlationId,
      request: eligibleRequest,
    })
    assert.deepEqual(eligibleResolutionReplay.payload, eligibleResolution.payload)

    const guardedRequest = runtimeHandoff('api-resolve-guard')
    const guarded = await requestJson(
      `${baseUrl}/personal-phone/inbound/handoffs`,
      { method: 'POST', bearer, body: guardedRequest },
    )
    assert.equal(guarded.payload.decision, 'connect')
    const malformedResolve = await requestJson(
      `${baseUrl}/personal-phone/inbound/handoffs/${encodeURIComponent(
        guarded.payload.correlationId,
      )}/resolve`,
      {
        method: 'POST',
        bearer,
        body: runtimeResolveRequest(guardedRequest, { schemaVersion: 'wrong' }),
      },
    )
    assertResolution(
      malformedResolve.payload,
      'expired',
      'voicemail',
      'handoff_not_found_or_expired',
    )
    const guardedReplay = await requestJson(
      `${baseUrl}/personal-phone/inbound/handoffs`,
      { method: 'POST', bearer, body: guardedRequest },
    )
    assert.equal(guardedReplay.payload.decision, 'connect')
    const guardedResolution = await resolveRuntimeHandoff({
      baseUrl,
      bearer,
      correlationId: guarded.payload.correlationId,
      request: guardedRequest,
    })
    assertResolution(
      guardedResolution.payload,
      'expired',
      'voicemail',
      'handoff_not_consumed',
    )
  } finally {
    child.kill('SIGTERM')
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ])
    if (child.exitCode === null) child.kill('SIGKILL')
    await rm(runtimeDir, { recursive: true, force: true })
  }
}

function runtimeHandoff(id) {
  return {
    schemaVersion: PERSONAL_PHONE_HANDOFF_SCHEMA,
    eventId: `event-${id}`,
    callControlId: `call-${id}`,
    callSessionId: `session-${id}`,
    from: baseRequest.from,
    to: expectedDid,
    status: 'no-answer',
    occurredAt: new Date().toISOString(),
  }
}

function runtimeResolveRequest(request, patch = {}) {
  return {
    schemaVersion: PERSONAL_PHONE_RESOLVE_SCHEMA,
    eventId: request.eventId,
    callControlId: request.callControlId,
    connectStatus: 'stopped',
    occurredAt: new Date().toISOString(),
    ...patch,
  }
}

function resolveRuntimeHandoff({ baseUrl, bearer, correlationId, request }) {
  return requestJson(
    `${baseUrl}/personal-phone/inbound/handoffs/${encodeURIComponent(
      correlationId,
    )}/resolve`,
    {
      method: 'POST',
      bearer,
      body: runtimeResolveRequest(request),
    },
  )
}

async function requestJson(url, { method = 'GET', bearer = '', body } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return {
    response,
    payload: await response.json(),
  }
}

async function waitForApi(url, child) {
  const maxAttempts = 300
  const pollIntervalMs = 50

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (child.exitCode !== null) break
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // Wait for the isolated backend to bind its port.
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }
  assert.fail('isolated Personal Phone backend did not become ready')
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => (error ? reject(error) : resolve(port)))
    })
  })
}
