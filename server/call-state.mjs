import { randomUUID } from 'node:crypto'
import { transcriptEntry } from './call-history.mjs'
import { contextCounts, normalizeContextFields } from './context-fields.mjs'
import { createTransportDiagnostics } from './transport-diagnostics.mjs'
import {
  cleanEmail,
  cleanName,
  getSpeakLinkUrl,
  normalizeCampaignConfig,
  normalizePhone,
  safeLeadText,
} from './runtime-config.mjs'

const CONFIGURATION_TEST_VARIABLE_KEYS = new Set([
  'first_name',
  'last_name',
  'full_name',
  'business_name',
  'contact_phone',
  'contact_email',
  'notes',
  'portal_url',
])

export function normalizeLead(lead = {}) {
  const company =
    safeLeadText(lead.company || lead.business_name || lead.businessName || '') ||
    'Unknown business'
  const rawName = cleanName(lead.name || lead.full_name || lead.fullName || '')
  const rawFirstName = cleanName(lead.firstName || lead.first_name || '')
  const rawLastName = cleanName(lead.lastName || lead.last_name || '')
  const rawFirstLast = [rawFirstName, rawLastName].filter(Boolean).join(' ')
  const nameIsCompany =
    normalizeLeadIdentityKey(rawName) &&
    normalizeLeadIdentityKey(rawName) === normalizeLeadIdentityKey(company)
  const nameIsContact = rawName && !isGenericLeadName(rawName) && !nameIsCompany
  const firstLastIsGeneric = isGenericLeadName(rawFirstLast)
  const parts = nameIsContact ? rawName.split(/\s+/).filter(Boolean) : []
  const firstName = firstLastIsGeneric
    ? ''
    : cleanName(rawFirstName || parts[0] || '')
  const lastName = firstLastIsGeneric
    ? ''
    : cleanName(rawLastName || parts.slice(1).join(' '))
  const displayName = [firstName, lastName].filter(Boolean).join(' ')
  const contactName = nameIsContact ? rawName : displayName

  return {
    id: String(lead.id || randomUUID()),
    firstName,
    lastName,
    name: contactName || (company !== 'Unknown business' ? company : '') || 'Unknown contact',
    company,
    phone: normalizePhone(
      lead.phone || lead.contact_phone || lead.phone_on_file || lead.called_phone || '',
    ),
    email: cleanEmail(lead.email || lead.contact_email || lead.email_on_file || ''),
    state: String(lead.state || '').trim(),
    tags: Array.isArray(lead.tags) ? lead.tags : [],
    score: Number(lead.score || 0),
    status: lead.status || 'ready',
    lastCall: lead.lastCall || 'Never',
    notes: String(lead.notes || '').trim(),
    context: normalizeContextFields(lead.context),
    source: safeLeadText(lead.source),
    sourceId: safeLeadText(lead.sourceId),
    sourceName: safeLeadText(lead.sourceName),
    sourceUrl: safeLeadText(lead.sourceUrl),
    externalUrl: safeLeadText(lead.externalUrl),
    sourceSyncedAt: safeLeadText(lead.sourceSyncedAt),
    providerIds: lead.providerIds && typeof lead.providerIds === 'object' ? { ...lead.providerIds } : {},
  }
}

function isGenericLeadName(value) {
  const name = cleanName(value || '')
  return /^(imported\s+lead(?:\s+\d+)?|unknown\s+contact)$/i.test(name)
}

function normalizeLeadIdentityKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function normalizeConfigurationTestVariables(value = {}) {
  const source = value && typeof value === 'object' ? value : {}
  const firstName = cleanName(source.first_name || source.firstName || '')
  const lastName = cleanName(source.last_name || source.lastName || '')
  const explicitName = cleanName(
    source.full_name || source.fullName || source.name || '',
  )
  const displayName = explicitName || [firstName, lastName].filter(Boolean).join(' ')

  return {
    firstName,
    lastName,
    name: displayName,
    company: safeLeadText(
      source.business_name || source.businessName || source.company || '',
    ),
    phone: normalizePhone(source.contact_phone || source.phone || ''),
    email: cleanEmail(source.contact_email || source.email || ''),
    notes: safeLeadText(source.notes || ''),
    portalUrl:
      safeLeadText(source.portal_url || source.portalUrl || '') ||
      getSpeakLinkUrl(),
  }
}

export function normalizeConfigurationTestVariableKeys(value, source = {}) {
  const requested = Array.isArray(value)
    ? value
    : source && typeof source === 'object'
      ? Object.keys(source)
      : []

  return [...new Set(requested.map((key) => String(key || '').trim()))].filter(
    (key) => CONFIGURATION_TEST_VARIABLE_KEYS.has(key),
  )
}

export function configurationTestVariableKeySet(state) {
  return new Set(
    Array.isArray(state?.testVariableKeys)
      ? state.testVariableKeys.filter((key) =>
          CONFIGURATION_TEST_VARIABLE_KEYS.has(key),
        )
      : [],
  )
}

export function createCallState(callControlId, lead, config, operatorInstructions = []) {
  const now = new Date().toISOString()

  return {
    callControlId,
    lead: normalizeLead(lead),
    callTargetPhone: normalizePhone(lead?.phone || ''),
    config,
    createdAt: now,
    updatedAt: now,
    sampleRate: config.sampleRate,
    telnyxCodec: config.telnyxStreamCodec,
    chatId: null,
    streamId: null,
    eventLog: [],
    audioPacketsSent: 0,
    audioBytesSent: 0,
    audioQuality: createAudioQualitySummary(config),
    assistantResponseActive: false,
    transportDiagnostics: createTransportDiagnostics(config),
    answered: false,
    answeredAt: null,
    minimumHangupAt: null,
    hangupRequestedAt: null,
    leadUtteranceCount: 0,
    assistantUtteranceCount: 0,
    outcome: null,
    ending: false,
    initialGreetingSent: false,
    syntheticUserInputs: new Set(),
    pendingAssistantProsodyScores: new Map(),
    assistantIdleTimer: null,
    pendingPlaygroundInputText: '',
    pendingPlaygroundInputTimer: null,
    interimFinalizerTimer: null,
    interimFinalizerGeneration: 0,
    lastAssistantMessageAt: 0,
    lastAudioClearAt: 0,
    lastAudioClearReason: '',
    lastAssistantAudioAt: 0,
    lastCodexClmTimingRequestSequence: 0,
    lastInterruptionAt: 0,
    lastUserFinalAt: 0,
    lastUserInterimAt: 0,
    lastUserInterimText: '',
    voiceInputPreReadyFrames: [],
    voiceInputPreReadyFrameMeta: [],
    voiceInputPreReadyBytes: 0,
    voiceInputPreReadyDroppedFrames: 0,
    voiceInputPreReadyDroppedBytes: 0,
    voiceInputPreReadyDroppedSpeechFrames: 0,
    voiceInputPreReadyDroppedSilenceFrames: 0,
    voiceTurnSequence: 0,
    pendingCallerSpeechStop: null,
    pendingVoiceTurnTiming: null,
    lastVoiceTurnLatency: null,
    takeover: false,
    callProvider: '',
    telnyxWs: null,
    calltoolsWs: null,
    calltoolsCallId: '',
    humeWs: null,
    inworldWs: null,
    xaiWs: null,
    inworldAssistantTranscriptBuffers: new Map(),
    inworldTemporaryInstruction: '',
    xaiAssistantTranscriptBuffers: new Map(),
    xaiTemporaryInstruction: '',
    xaiPendingToolCalls: new Map(),
    xaiConversationId: '',
    xaiReconnectAttempts: 0,
    humanWs: null,
    browserWs: null,
    browserTest: false,
    testVariables: null,
    testVariableKeys: [],
    operatorInstructions: normalizeOperatorInstructions(operatorInstructions),
  }
}

export function createAudioQualitySummary(config = {}) {
  return {
    inbound: {
      peakRatioMax: 0,
      clippedFrames: 0,
      clippedSamples: 0,
      oddBytePayloads: 0,
      decodeErrors: 0,
    },
    humeOutput: {
      peakRatioMax: 0,
      clippedFrames: 0,
      clippedSamples: 0,
    },
    telnyxOutput: {
      peakRatioMax: 0,
      clippedFrames: 0,
      clippedSamples: 0,
    },
    queue: {
      maxFrames: 0,
      maxMs: 0,
      droppedFrames: 0,
    },
    codec: config.telnyxStreamCodec || '',
    sampleRate: config.sampleRate || null,
  }
}

export function normalizeOperatorInstructions(value) {
  if (!Array.isArray(value)) return []

  return value
    .map((instruction) => String(instruction || '').trim())
    .filter(Boolean)
    .slice(-10)
}

export function publicLeadContext(state) {
  const lead = normalizeLead(state.lead)
  if (state.browserTest) {
    const contact = normalizeConfigurationTestVariables(state.testVariables)
    const keys = configurationTestVariableKeySet(state)
    return {
      id: lead.id,
      first_name: keys.has('first_name') ? safeLeadText(contact.firstName) : '',
      last_name: keys.has('last_name') ? safeLeadText(contact.lastName) : '',
      name: keys.has('full_name') ? safeLeadText(contact.name) : '',
      business_name: keys.has('business_name') ? safeLeadText(contact.company) : '',
      phone_on_file: keys.has('contact_phone') ? contact.phone : '',
      email_on_file: keys.has('contact_email') ? contact.email : '',
      called_phone: '',
      context_counts: contextCounts(lead.context),
    }
  }

  return {
    id: lead.id,
    first_name: safeLeadText(lead.firstName),
    last_name: safeLeadText(lead.lastName),
    name: safeLeadText(lead.name),
    business_name: safeLeadText(lead.company),
    phone_on_file: lead.phone,
    email_on_file: lead.email,
    called_phone: state.callTargetPhone,
    ...publicLeadSourceContext(state.lead),
    context_counts: contextCounts(lead.context),
  }
}

function publicLeadSourceContext(lead = {}) {
  const source = safeLeadText(lead.source)
  const sourceId = safeLeadText(lead.sourceId)
  const sourceName = safeLeadText(lead.sourceName)
  const sourceUrl = safeLeadText(lead.sourceUrl)
  const externalUrl = safeLeadText(lead.externalUrl)
  const sourceSyncedAt = safeLeadText(lead.sourceSyncedAt)
  return {
    ...(source ? { source } : {}),
    ...(sourceId ? { sourceId } : {}),
    ...(sourceName ? { sourceName } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(externalUrl ? { externalUrl } : {}),
    ...(sourceSyncedAt ? { sourceSyncedAt } : {}),
  }
}

export function setCallOutcome(state, outcome, detail = '') {
  if (!state || !outcome) return null
  if (state.outcome === outcome) return null
  if (state.outcome) return null

  state.outcome = outcome
  const status = statusForOutcome(outcome)
  const summary = callOutcomeSummary(outcome, detail)

  return {
    patch: { outcome },
    outcome,
    leadPatch: {
      leadId: state.lead.id,
      patch: {
        status,
        lastCall: callTimeLabel(),
      },
    },
    entry: transcriptEntry(
      'System',
      summary,
      outcome === 'completed' ? 'system' : 'attention',
    ),
    notice: summary,
  }
}

export function statusForOutcome(outcome) {
  if (outcome === 'no-answer') return 'no-answer'
  if (outcome === 'voicemail') return 'voicemail'
  if (outcome === 'not-interested') return 'not-interested'
  if (outcome === 'do-not-call') return 'do-not-call'
  if (outcome === 'skipped') return 'skipped'
  if (outcome === 'failed') return 'failed'
  return 'follow-up'
}

export function normalizeCallOutcome(value) {
  const outcome = String(value || '').trim().toLowerCase().replaceAll('_', '-')
  return [
    'completed',
    'no-answer',
    'voicemail',
    'not-interested',
    'callback',
    'wrong-number',
    'do-not-call',
    'skipped',
    'operator-ended',
    'failed',
  ].includes(outcome)
    ? outcome
    : ''
}

export function resolveToolHangupOutcome(state, args = {}) {
  const existingOutcome = normalizeCallOutcome(state?.outcome)
  if (existingOutcome) return existingOutcome

  const requestedOutcome = normalizeCallOutcome(args?.outcome)
  if (requestedOutcome) {
    if (
      requestedOutcome === 'no-answer' &&
      Number(state?.leadUtteranceCount || 0) > 0
    ) {
      return 'operator-ended'
    }
    return requestedOutcome
  }

  if (Number(state?.leadUtteranceCount || 0) === 0) return 'no-answer'
  return 'operator-ended'
}

export function shouldDeferToolHangup(state, { nowMs = Date.now() } = {}) {
  if (!state || state.ending || isCallEnded(state)) return false
  if (state.inworldUserSpeechActive === true) return true
  if (state.xaiUserSpeechActive === true) return true

  const interim = String(state.lastUserInterimText || '').trim()
  const interimAt = Number(state.lastUserInterimAt || 0)
  if (!interim || !Number.isFinite(interimAt) || interimAt <= 0) return false

  const configuredTurnSilenceMs = Number(state.config?.endOfTurnSilenceMs || 500)
  const guardMs = Math.max(
    1_500,
    Math.min(5_000, configuredTurnSilenceMs + 1_500),
  )
  return nowMs - interimAt <= guardMs
}

export function isCallEnded(state) {
  if (!state) return false
  return state.eventLog.some((event) => event?.patch?.phase === 'ended')
}

export function isTelnyxAlreadyEnded(status, payload) {
  const text = JSON.stringify(payload || {}).toLowerCase()
  return (
    status === 404 ||
    /already.*ended|call.*ended|not.*active|not.*found|cannot.*find|does not exist|no call/.test(
      text,
    )
  )
}

export function shouldEndImmediately(outcome) {
  return ['no-answer', 'voicemail', 'not-interested', 'do-not-call'].includes(
    outcome,
  )
}

export function callOutcomeSummary(outcome, detail = '') {
  const suffix = detail ? ` (${detail})` : ''
  if (outcome === 'no-answer') return `Call outcome: no answer${suffix}`
  if (outcome === 'voicemail') return `Call outcome: voicemail${suffix}`
  if (outcome === 'not-interested') return `Call outcome: not interested${suffix}`
  if (outcome === 'do-not-call') return `Call outcome: do not call${suffix}`
  if (outcome === 'skipped') return `Call outcome: skipped${suffix}`
  if (outcome === 'operator-ended') return `Call outcome: operator ended${suffix}`
  if (outcome === 'failed') return `Call outcome: failed${suffix}`
  return `Call outcome: completed${suffix}`
}

export function callTimeLabel() {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date())
}

export function inferHangupOutcome(state, payload = {}) {
  if (state.outcome) return state.outcome

  const cause = [
    payload.hangup_cause,
    payload.cause,
    payload.reason,
    payload.sip_hangup_cause,
    payload.sip_hangup_phrase,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  if (/voicemail|machine|amd/.test(cause)) return 'voicemail'
  if (
    /busy|no[\s_-]?answer|timeout|rejected|declined|cancel|unallocated|unreachable/.test(
      cause,
    )
  ) {
    return 'no-answer'
  }
  if (
    !state.answered &&
    state.leadUtteranceCount === 0 &&
    state.assistantUtteranceCount === 0
  ) {
    return 'no-answer'
  }
  if (/fail|error|forbidden|invalid|blocked/.test(cause)) return 'failed'
  if (endedBeforeConversation(state, payload)) return 'no-answer'
  if (state.callProvider === 'calltools') return 'operator-ended'

  return 'completed'
}

export function inferStreamStopOutcome(state) {
  if (state.outcome) return state.outcome
  if (
    state.callProvider === 'calltools' &&
    state.leadUtteranceCount === 0 &&
    state.assistantUtteranceCount === 0
  ) {
    return 'no-answer'
  }
  if (
    !state.answered &&
    state.leadUtteranceCount === 0 &&
    state.assistantUtteranceCount === 0
  ) {
    return 'no-answer'
  }
  if (endedBeforeConversation(state)) return 'no-answer'
  if (state.callProvider === 'calltools') return 'operator-ended'
  return 'completed'
}

export function inferTelnyxMachineOutcome(eventType = '', payload = {}) {
  const text = [eventType, payload.result, payload.status, payload.reason]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  if (/machine|voicemail|amd/.test(text)) return 'voicemail'
  return null
}

export function inferTranscriptOutcome(content) {
  const text = String(content || '').toLowerCase()

  if (
    /\b(remove me|take me off|stop calling|do not call|don't call|dont call|no more calls)\b/.test(
      text,
    )
  ) {
    return 'do-not-call'
  }

  const compact = text.replace(/[^a-z0-9]+/g, ' ').trim()
  if (
    /\b(voicemail|voice mail|voice messaging system|automated voice messaging system|mailbox|mail box|buz[oó]n|deje su mensaje|mensaje despu[eé]s del tono|you'?ve reached|you have reached|sorry i missed your call|leave (me )?a message|leave (a )?(brief )?message|leave your message|after the tone|at the tone|record your message|record a message|please record|not available|isn'?t available|unavailable|not available to take your call|can't take your call|cannot take your call|has not been set up|not been set up|mailbox is full|buz[oó]n est[aá] lleno)\b/.test(text) ||
    /\brecord\s+(your|a)?\s*message\b/.test(compact) ||
    /\b(person|party).{0,50}(trying to reach|called).{0,50}(not available|unavailable|isn'?t available)\b/.test(
      text,
    )
  ) {
    return 'voicemail'
  }

  if (
    /\b(not able to take (the )?call|unable to take (the )?call|can'?t take (the )?call|cannot take (the )?call|not able to answer|unable to answer|person you'?re trying to reach can'?t come to the phone|they'?re not able to take the call)\b/.test(
      text,
    )
  ) {
    return 'no-answer'
  }

  if (
    /\b(not interested|no thanks|no thank you|not looking|no longer interested|already got it|already have it|don't need it|dont need it)\b/.test(
      text,
    )
  ) {
    return 'not-interested'
  }

  return null
}

export function normalizeDeliveryMethod(value) {
  const method = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (['sms', 'text', 'text_message'].includes(method)) return 'sms'
  if (['email', 'mail'].includes(method)) return 'email'
  if (
    [
      'both',
      'sms_and_email',
      'email_and_sms',
      'text_and_email',
      'email_and_text',
    ].includes(method)
  ) {
    return 'both'
  }
  return method
}

export function truthy(value) {
  return (
    value === true ||
    ['true', 'yes', 'confirmed', '1'].includes(String(value || '').toLowerCase())
  )
}

export function contactPatchSummary(patch) {
  return [
    patch.phone ? `phone ${maskPhone(patch.phone)}` : '',
    patch.email ? `email ${maskEmail(patch.email)}` : '',
  ]
    .filter(Boolean)
    .join(', ')
}

export function maskPhone(value) {
  const phone = normalizePhone(value)
  if (!phone) return ''
  return `${phone.slice(0, 3)}***${phone.slice(-4)}`
}

export function maskEmail(value) {
  const email = cleanEmail(value)
  if (!email) return ''
  const [user, domain] = email.split('@')
  const visibleUser =
    user.length <= 2 ? `${user[0] || ''}*` : `${user.slice(0, 2)}***`
  return `${visibleUser}@${domain}`
}

export function createStateFromStreamStart(message) {
  const callControlId = message.start.call_control_id
  const decoded = decodeClientState(message.start.client_state)
  return createCallState(
    callControlId,
    decoded.lead || {
      id: callControlId,
      firstName: '',
      lastName: '',
      name: message.start.to || 'Lead',
      company: 'Unknown',
      phone: message.start.to || '',
      email: '',
    },
    normalizeCampaignConfig(decoded.config || {}),
  )
}

export function decodeClientState(value) {
  if (!value) return {}
  try {
    return JSON.parse(Buffer.from(value, 'base64').toString('utf8'))
  } catch {
    return {}
  }
}

function endedBeforeConversation(state, payload = {}) {
  if (!state?.answered) return false
  if (state.leadUtteranceCount > 0 || state.assistantUtteranceCount > 0) return false

  const elapsedMs = callElapsedMs(state, payload)
  return elapsedMs == null || elapsedMs < 8000
}

function callElapsedMs(state, payload = {}) {
  const answeredAt =
    parseTime(payload.answer_time) ||
    parseTime(payload.answered_at) ||
    parseTime(state.answeredAt)
  const startedAt =
    answeredAt ||
    parseTime(payload.start_time) ||
    parseTime(payload.started_at) ||
    parseTime(state.createdAt)
  if (!startedAt) return null

  const endedAt =
    parseTime(payload.end_time) ||
    parseTime(payload.ended_at) ||
    parseTime(payload.hangup_time) ||
    Date.now()
  if (!endedAt) return null

  return Math.max(0, endedAt - startedAt)
}

function parseTime(value) {
  const parsed = Date.parse(value || '')
  return Number.isFinite(parsed) ? parsed : 0
}
