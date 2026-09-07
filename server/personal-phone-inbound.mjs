import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  normalizeCampaignConfig,
  normalizePhone,
  safeLeadText,
} from './runtime-config.mjs'

export const PERSONAL_PHONE_HANDOFF_SCHEMA = 'speak.personal-phone.inbound-handoff.v1'
export const PERSONAL_PHONE_RESOLVE_SCHEMA =
  'speak.personal-phone.inbound-handoff-resolve.v1'
export const PERSONAL_PHONE_READINESS_SCHEMA =
  'speak.personal-phone.inbound-readiness.v1'

const HANDOFF_STORE_SCHEMA = 'speak.personal-phone.inbound-handoff-store.v1'
const TERMINAL_STATUSES = new Set(['no-answer', 'busy', 'failed', 'canceled'])
const CONNECT_STATUSES = new Set(['stopped', 'failed'])
const PUBLIC_VOICEMAIL_REASONS = new Set([
  'disabled',
  'invalid_request',
  'stale_request',
  'non_terminal_status',
  'unknown_contact',
  'ambiguous_contact',
  'ineligible_contact',
  'ambiguous_profile',
  'profile_not_ready',
  'replay_expired',
])
const DISABLED_INTERNAL_REASONS = new Set([
  'personal_phone_did_not_configured',
  'personal_phone_source_not_configured',
  'handoff_persistence_unavailable',
])
const COMPLETED_HANDOFF_STATES = new Set([
  'completed',
  'agent_hangup',
  'caller_hangup',
])
const VOICEMAIL_HANDOFF_STATES = new Set([
  'expired',
  'stream_failed_before_conversation',
])
const __dirname = path.dirname(fileURLToPath(import.meta.url))

export function personalPhoneInboundBearerAuthorized(header = '', secret = '') {
  const expected = Buffer.from(safeLeadText(secret))
  const match = safeLeadText(header).match(/^Bearer\s+(.+)$/i)
  const received = Buffer.from(safeLeadText(match?.[1]))
  return (
    expected.length > 0 &&
    expected.length === received.length &&
    timingSafeEqual(expected, received)
  )
}

export function normalizePersonalPhoneInboundHandoffRequest(
  body = {},
  { expectedDid = '', maxAgeMs = 120_000, now = Date.now() } = {},
) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  const eventId = strictBoundedString(source.eventId, 240)
  const callControlId = strictBoundedString(source.callControlId, 520)
  const callSessionId = optionalBoundedString(source.callSessionId, 240)
  const from = typeof source.from === 'string' ? normalizePhone(source.from) : ''
  const to = typeof source.to === 'string' ? normalizePhone(source.to) : ''
  const status = normalizeTerminalStatus(source.status)
  const occurredAt = strictBoundedString(source.occurredAt, 80)
  const occurredAtMs = Date.parse(occurredAt)
  const expectedPhone = normalizePhone(expectedDid)

  if (!expectedPhone) return invalidHandoffRequest('personal_phone_did_not_configured')
  if (
    source.schemaVersion !== PERSONAL_PHONE_HANDOFF_SCHEMA ||
    !eventId ||
    !callControlId ||
    callSessionId === null ||
    !from ||
    !to ||
    !occurredAt ||
    !Number.isFinite(occurredAtMs)
  ) {
    return invalidHandoffRequest('invalid_request')
  }
  if (!status) return invalidHandoffRequest('non_terminal_status')
  if (to !== expectedPhone) return invalidHandoffRequest('invalid_request')
  if (occurredAtMs < now - maxAgeMs || occurredAtMs > now + 30_000) {
    return invalidHandoffRequest('stale_request')
  }

  return {
    ok: true,
    value: {
      schemaVersion: PERSONAL_PHONE_HANDOFF_SCHEMA,
      eventId,
      callControlId,
      callSessionId,
      from,
      to,
      status,
      occurredAt: new Date(occurredAtMs).toISOString(),
    },
  }
}

export function normalizePersonalPhoneInboundResolveRequest(
  body = {},
  { correlationId = '', maxAgeMs = 120_000, now = Date.now() } = {},
) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  const normalizedCorrelationId = strictBoundedString(correlationId, 120)
  const eventId = strictBoundedString(source.eventId, 240)
  const callControlId = strictBoundedString(source.callControlId, 520)
  const connectStatus = strictBoundedString(source.connectStatus, 16)
  const occurredAt = strictBoundedString(source.occurredAt, 80)
  const occurredAtMs = Date.parse(occurredAt)

  if (
    source.schemaVersion !== PERSONAL_PHONE_RESOLVE_SCHEMA ||
    !normalizedCorrelationId ||
    !eventId ||
    !callControlId ||
    !CONNECT_STATUSES.has(connectStatus) ||
    !occurredAt ||
    !Number.isFinite(occurredAtMs)
  ) {
    return invalidHandoffRequest('invalid_resolve_request')
  }
  if (occurredAtMs < now - maxAgeMs || occurredAtMs > now + 30_000) {
    return invalidHandoffRequest('stale_resolve_request')
  }

  return {
    ok: true,
    value: {
      schemaVersion: PERSONAL_PHONE_RESOLVE_SCHEMA,
      correlationId: normalizedCorrelationId,
      eventId,
      callControlId,
      connectStatus,
      occurredAt: new Date(occurredAtMs).toISOString(),
    },
  }
}

export function resolvePersonalPhoneInboundEligibility({
  handoff,
  leads = [],
  profiles = [],
  smartViews = [],
  sourceId = '',
  profileReady = () => ({ ready: true, blockers: [] }),
} = {}) {
  const correlationId = personalPhoneInboundCorrelationId(handoff)
  if (!sourceId) {
    return voicemailDecision('personal_phone_source_not_configured', correlationId)
  }
  const personalPhoneMatches = leads.filter(
    (lead) =>
      safeLeadText(lead?.source) === 'personal-phone' &&
      safeLeadText(lead?.sourceId) === sourceId &&
      normalizePhone(lead?.phone) === handoff?.from,
  )

  if (personalPhoneMatches.length === 0) {
    return voicemailDecision('unknown_contact', correlationId)
  }
  if (personalPhoneMatches.length > 1) {
    return voicemailDecision('ambiguous_contact', correlationId)
  }

  const lead = personalPhoneMatches[0]
  const smartViewById = new Map(
    smartViews.map((smartView) => [safeLeadText(smartView?.id), smartView]),
  )
  const enabledProfiles = profiles.filter(
    (profile) => profile?.config?.personalPhoneInbound?.enabled === true,
  )
  if (enabledProfiles.length === 0) {
    return voicemailDecision('disabled', correlationId, { contactId: lead.id })
  }

  const matches = enabledProfiles.flatMap((profile) => {
    const policy = profile.config?.personalPhoneInbound || {}
    if (safeLeadText(policy.eligibilityScope) === 'source') {
      return safeLeadText(policy.sourceId) === sourceId
        ? [{ profile, matchedBy: 'source' }]
        : []
    }
    const contactIds = new Set(stringList(policy.contactIds, 100))
    const smartViewIds = stringList(policy.smartViewIds, 50)
    if (contactIds.has(lead.id)) return [{ profile, matchedBy: 'contact' }]
    const matchedSmartView = smartViewIds.find((smartViewId) =>
      stringList(smartViewById.get(smartViewId)?.leadIds, 100_000).includes(lead.id),
    )
    return matchedSmartView
      ? [{ profile, matchedBy: 'smart_view', smartViewId: matchedSmartView }]
      : []
  })

  if (matches.length === 0) {
    return voicemailDecision('ineligible_contact', correlationId, { contactId: lead.id })
  }
  if (matches.length > 1) {
    return voicemailDecision('ambiguous_profile', correlationId, { contactId: lead.id })
  }

  const match = matches[0]
  const runtimeConfig = normalizeCampaignConfig({
    ...match.profile.config,
    agentProfileId: match.profile.id,
    agentProfileName: match.profile.name,
    phoneAudioMode: 'legacy',
    telnyxStreamCodec: 'PCMU',
    sampleRate: 8000,
  })
  const readiness = profileReady({ profile: match.profile, runtimeConfig }) || {}
  if (!readiness.ready) {
    return voicemailDecision('profile_not_ready', correlationId, {
      contactId: lead.id,
      profileId: match.profile.id,
    })
  }

  return {
    correlationId,
    decision: 'connect',
    reason: 'eligible_profile_ready',
    lead,
    matchedBy: match.matchedBy,
    profile: match.profile,
    proof: cleanProof({
      contactId: lead.id,
      profileId: match.profile.id,
      matchedBy: match.matchedBy,
      smartViewId: match.smartViewId,
      sourceId: lead.sourceId,
    }),
    runtimeConfig,
  }
}

export function personalPhoneHandoffStreamUrl(streamUrl, token) {
  const url = new URL(streamUrl)
  url.searchParams.set('personalPhoneHandoff', token)
  return url.toString()
}

export class PersonalPhoneInboundHandoffRegistry {
  constructor({
    ttlMs = 60_000,
    retentionMs = 24 * 60 * 60_000,
    now = () => Date.now(),
    persistencePath = defaultHandoffStorePath(),
  } = {}) {
    this.ttlMs = ttlMs
    this.retentionMs = retentionMs
    this.now = now
    this.persistencePath = persistencePath ? path.resolve(persistencePath) : ''
    this.persistenceError = this.persistencePath ? '' : 'handoff_store_not_configured'
    this.byCorrelationId = new Map()
    this.byEventKey = new Map()
    this.byTokenHash = new Map()
    this.load()
  }

  readiness() {
    return {
      durable: Boolean(this.persistencePath),
      ready: Boolean(this.persistencePath) && !this.persistenceError,
      error: this.persistenceError,
    }
  }

  findByEvent(eventId, callControlId) {
    this.prune()
    if (!this.readiness().ready) return null
    const correlationId = this.byEventKey.get(eventKey(eventId, callControlId))
    return correlationId ? this.byCorrelationId.get(correlationId) || null : null
  }

  prepare({ handoff, decision, lead, profile, runtimeConfig, runtimeContext, streamUrl }) {
    this.prune()
    const existing = this.findByEvent(handoff.eventId, handoff.callControlId)
    if (existing) return existing
    if (!this.readiness().ready) return null

    const createdAtMs = this.now()
    const token = randomBytes(32).toString('base64url')
    const record = {
      correlationId: decision.correlationId,
      eventId: handoff.eventId,
      callControlId: handoff.callControlId,
      callSessionId: handoff.callSessionId,
      from: handoff.from,
      to: handoff.to,
      decision: 'connect',
      status: 'prepared',
      reason: 'eligible_profile_ready',
      createdAt: new Date(createdAtMs).toISOString(),
      updatedAt: new Date(createdAtMs).toISOString(),
      expiresAt: new Date(createdAtMs + this.ttlMs).toISOString(),
      expiresAtMs: createdAtMs + this.ttlMs,
      token,
      tokenHash: hashToken(token),
      tokenConsumedAt: '',
      streamAttachedAt: '',
      conversationStartedAt: '',
      lead,
      profile,
      proof: decision.proof,
      runtimeConfig,
      runtimeContext,
      streamUrl,
      terminalResolution: null,
    }
    return this.storeRecord(record) ? record : null
  }

  recordVoicemail({ handoff, decision }) {
    this.prune()
    const existing = this.findByEvent(handoff.eventId, handoff.callControlId)
    if (existing) return existing
    if (!this.readiness().ready) return null

    const createdAtMs = this.now()
    const record = {
      correlationId: decision.correlationId,
      eventId: handoff.eventId,
      callControlId: handoff.callControlId,
      callSessionId: handoff.callSessionId,
      from: handoff.from,
      to: handoff.to,
      decision: 'voicemail',
      status: 'voicemail',
      reason: decision.reason,
      createdAt: new Date(createdAtMs).toISOString(),
      updatedAt: new Date(createdAtMs).toISOString(),
      expiresAt: new Date(createdAtMs + this.ttlMs).toISOString(),
      expiresAtMs: createdAtMs + this.ttlMs,
      proof: decision.proof,
      terminalResolution: null,
    }
    return this.storeRecord(record) ? record : null
  }

  consume(token) {
    this.prune()
    if (!this.readiness().ready) return null
    const tokenHash = hashToken(token)
    const correlationId = this.byTokenHash.get(tokenHash)
    const record = correlationId ? this.byCorrelationId.get(correlationId) : null
    if (
      !record ||
      record.decision !== 'connect' ||
      record.tokenConsumedAt ||
      record.expiresAtMs < this.now()
    ) {
      return null
    }
    record.tokenConsumedAt = new Date(this.now()).toISOString()
    record.updatedAt = record.tokenConsumedAt
    return this.persist() ? record : null
  }

  attach(correlationId, { callControlId = '', callSessionId = '' } = {}) {
    const record = this.byCorrelationId.get(correlationId)
    if (
      !record ||
      record.decision !== 'connect' ||
      isTerminalState(record.status) ||
      (callControlId && record.callControlId !== callControlId)
    ) {
      return null
    }
    record.status = 'stream_attached'
    record.callSessionId = safeLeadText(callSessionId || record.callSessionId)
    record.streamAttachedAt ||= new Date(this.now()).toISOString()
    record.updatedAt = record.streamAttachedAt
    return this.persist() ? record : null
  }

  markConversationStarted(correlationId) {
    const record = this.byCorrelationId.get(correlationId)
    if (!record || record.decision !== 'connect' || isTerminalState(record.status)) {
      return record || null
    }
    record.status = 'conversation_started'
    record.conversationStartedAt ||= new Date(this.now()).toISOString()
    record.updatedAt = record.conversationStartedAt
    return this.persist() ? record : null
  }

  markTerminal(correlationId, state, reason = '') {
    const record = this.byCorrelationId.get(correlationId)
    if (!record || record.decision !== 'connect' || isTerminalState(record.status)) {
      return record || null
    }
    if (!COMPLETED_HANDOFF_STATES.has(state) && !VOICEMAIL_HANDOFF_STATES.has(state)) {
      return record
    }
    record.status = state
    record.reason = safeLeadText(reason || state)
    record.updatedAt = new Date(this.now()).toISOString()
    return this.persist() ? record : null
  }

  resolve({ correlationId, eventId, callControlId }) {
    this.prune()
    if (!this.readiness().ready) {
      return missingResolution(correlationId, 'handoff_not_found_or_expired', this.now())
    }
    const record = this.byCorrelationId.get(correlationId)
    if (
      !record ||
      record.decision !== 'connect' ||
      record.eventId !== safeLeadText(eventId) ||
      record.callControlId !== safeLeadText(callControlId)
    ) {
      return missingResolution(correlationId, 'handoff_not_found_or_expired', this.now())
    }
    if (record.terminalResolution) return record.terminalResolution

    if (record.status === 'prepared' || record.status === 'expired') {
      record.status = 'expired'
      record.reason = 'handoff_not_consumed'
    } else if (record.status === 'stream_attached') {
      record.status = 'stream_failed_before_conversation'
      record.reason = 'stream_ended_before_conversation'
    } else if (record.status === 'conversation_started') {
      record.status = 'completed'
      record.reason = 'conversation_completed'
    }
    record.updatedAt = new Date(this.now()).toISOString()
    record.terminalResolution = resolutionForRecord(record)
    return this.persist()
      ? record.terminalResolution
      : missingResolution(correlationId, 'handoff_not_found_or_expired', this.now())
  }

  publicDecisionResponse(record) {
    if (record && Number(record.expiresAtMs) <= this.now()) {
      return personalPhoneVoicemailResponse(
        'replay_expired',
        record.correlationId,
        record.proof,
      )
    }
    if (record?.decision === 'voicemail') {
      return personalPhoneVoicemailResponse(
        record.reason,
        record.correlationId,
        record.proof,
      )
    }
    return this.publicConnectResponse(record)
  }

  publicConnectResponse(record) {
    if (!record || record.decision !== 'connect') {
      return personalPhoneVoicemailResponse('handoff_not_found_or_expired')
    }
    if (record.tokenConsumedAt || Number(record.expiresAtMs) <= this.now()) {
      return personalPhoneVoicemailResponse(
        'replay_expired',
        record.correlationId,
        record.proof,
      )
    }
    return {
      schemaVersion: PERSONAL_PHONE_HANDOFF_SCHEMA,
      decision: 'connect',
      reason: 'eligible_profile_ready',
      correlationId: record.correlationId,
      expiresAt: record.expiresAt,
      stream: {
        url: personalPhoneHandoffStreamUrl(record.streamUrl, record.token),
        codec: 'PCMU',
        bidirectionalMode: 'rtp',
        samplingRate: 8000,
        track: 'inbound_track',
        enableReconnect: false,
      },
      proof: record.proof,
    }
  }

  prune({ persist = true } = {}) {
    const cutoff = this.now() - this.retentionMs
    let changed = false
    for (const [correlationId, record] of this.byCorrelationId.entries()) {
      const retentionAnchor = Date.parse(record.updatedAt || record.expiresAt || '')
      if (Number.isFinite(retentionAnchor) && retentionAnchor >= cutoff) continue
      this.byCorrelationId.delete(correlationId)
      this.byEventKey.delete(eventKey(record.eventId, record.callControlId))
      if (record.tokenHash) this.byTokenHash.delete(record.tokenHash)
      changed = true
    }
    if (changed && persist) this.persist()
  }

  storeRecord(record) {
    const priorCorrelationRecord = this.byCorrelationId.get(record.correlationId)
    const recordEventKey = eventKey(record.eventId, record.callControlId)
    const priorEventCorrelation = this.byEventKey.get(recordEventKey)
    const priorTokenCorrelation = record.tokenHash
      ? this.byTokenHash.get(record.tokenHash)
      : undefined
    this.byCorrelationId.set(record.correlationId, record)
    this.byEventKey.set(recordEventKey, record.correlationId)
    if (record.tokenHash) this.byTokenHash.set(record.tokenHash, record.correlationId)
    if (this.persist()) return true

    restoreMapValue(this.byCorrelationId, record.correlationId, priorCorrelationRecord)
    restoreMapValue(this.byEventKey, recordEventKey, priorEventCorrelation)
    if (record.tokenHash) {
      restoreMapValue(this.byTokenHash, record.tokenHash, priorTokenCorrelation)
    }
    return false
  }

  load() {
    if (!this.persistencePath) return
    try {
      mkdirSync(path.dirname(this.persistencePath), { recursive: true })
      if (!existsSync(this.persistencePath)) {
        this.persist()
        return
      }
      const payload = JSON.parse(readFileSync(this.persistencePath, 'utf8'))
      if (payload?.schemaVersion !== HANDOFF_STORE_SCHEMA || !Array.isArray(payload.records)) {
        throw new Error('invalid handoff store schema')
      }
      for (const record of payload.records) {
        if (!validStoredRecord(record)) continue
        this.byCorrelationId.set(record.correlationId, record)
        this.byEventKey.set(eventKey(record.eventId, record.callControlId), record.correlationId)
        if (record.tokenHash) this.byTokenHash.set(record.tokenHash, record.correlationId)
      }
      this.prune({ persist: false })
    } catch {
      this.persistenceError = 'handoff_store_unreadable'
    }
  }

  persist() {
    if (!this.persistencePath || this.persistenceError) return false
    const tempPath = `${this.persistencePath}.${process.pid}.tmp`
    try {
      writeFileSync(
        tempPath,
        `${JSON.stringify({
          schemaVersion: HANDOFF_STORE_SCHEMA,
          records: [...this.byCorrelationId.values()],
        })}\n`,
        { encoding: 'utf8', mode: 0o600 },
      )
      renameSync(tempPath, this.persistencePath)
      chmodSync(this.persistencePath, 0o600)
      return true
    } catch {
      this.persistenceError = 'handoff_store_unwritable'
      return false
    }
  }
}

export function personalPhoneVoicemailResponse(
  reason,
  correlationId = randomUUID(),
  proof = {},
) {
  return {
    schemaVersion: PERSONAL_PHONE_HANDOFF_SCHEMA,
    decision: 'voicemail',
    reason: publicVoicemailReason(reason),
    correlationId,
    proof: cleanProof(proof),
  }
}

function publicVoicemailReason(reason) {
  const value = strictBoundedString(reason, 80).toLowerCase()
  if (PUBLIC_VOICEMAIL_REASONS.has(value)) return value
  if (DISABLED_INTERNAL_REASONS.has(value)) return 'disabled'
  if (value === 'handoff_not_found_or_expired') return 'replay_expired'
  return 'invalid_request'
}

export function personalPhoneVoicemailResolution(
  correlationId,
  reason = 'handoff_not_found_or_expired',
  now = Date.now(),
) {
  return missingResolution(correlationId, reason, now)
}

function defaultHandoffStorePath() {
  const workspaceDataDir = path.resolve(
    __dirname,
    '..',
    process.env.SPEAK_WORKSPACE_DATA_DIR || 'workspace-data',
  )
  return path.join(workspaceDataDir, 'personal-phone-inbound-handoffs.json')
}

function invalidHandoffRequest(reason) {
  return { ok: false, reason }
}

function normalizeTerminalStatus(value) {
  if (typeof value !== 'string') return ''
  const status = value.trim().toLowerCase().replace(/_/g, '-')
  if (status === 'cancelled') return 'canceled'
  return TERMINAL_STATUSES.has(status) ? status : ''
}

function voicemailDecision(reason, correlationId, proof = {}) {
  return {
    correlationId,
    decision: 'voicemail',
    reason,
    proof: cleanProof(proof),
  }
}

function cleanProof(value = {}) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''),
  )
}

function strictBoundedString(value, maxLength) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  return text && text.length <= maxLength ? text : ''
}

function optionalBoundedString(value, maxLength) {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text.length <= maxLength ? text : null
}

function stringList(value, maxItems) {
  return [...new Set((Array.isArray(value) ? value : []).map(safeLeadText).filter(Boolean))]
    .slice(0, maxItems)
}

export function personalPhoneInboundCorrelationId(handoff = {}) {
  const digest = createHash('sha256')
    .update(PERSONAL_PHONE_HANDOFF_SCHEMA)
    .update('\u0000')
    .update(safeLeadText(handoff.eventId))
    .update('\u0000')
    .update(safeLeadText(handoff.callControlId))
    .digest('base64url')
    .slice(0, 40)
  return `pph_${digest}`
}

function eventKey(eventId, callControlId) {
  return `${safeLeadText(eventId)}\u0000${safeLeadText(callControlId)}`
}

function hashToken(value) {
  return createHash('sha256').update(safeLeadText(value)).digest('hex')
}

function isTerminalState(value) {
  return COMPLETED_HANDOFF_STATES.has(value) || VOICEMAIL_HANDOFF_STATES.has(value)
}

function resolutionForRecord(record) {
  const voicemail = VOICEMAIL_HANDOFF_STATES.has(record.status)
  return {
    schemaVersion: PERSONAL_PHONE_RESOLVE_SCHEMA,
    correlationId: record.correlationId,
    state: record.status,
    terminal: true,
    nextAction: voicemail ? 'voicemail' : 'hangup',
    reason: record.reason || (voicemail ? 'handoff_failed' : 'conversation_completed'),
    proof: cleanProof({
      profileId: record.proof?.profileId,
      contactId: record.proof?.contactId,
      streamAttached: Boolean(record.streamAttachedAt),
      conversationStarted: Boolean(record.conversationStartedAt),
    }),
    updatedAt: record.updatedAt,
  }
}

function missingResolution(correlationId, reason, now) {
  return {
    schemaVersion: PERSONAL_PHONE_RESOLVE_SCHEMA,
    correlationId: safeLeadText(correlationId).slice(0, 120),
    state: 'expired',
    terminal: true,
    nextAction: 'voicemail',
    reason,
    proof: {},
    updatedAt: new Date(now).toISOString(),
  }
}

function validStoredRecord(record) {
  return Boolean(
    record &&
      typeof record === 'object' &&
      strictBoundedString(record.correlationId, 120) &&
      strictBoundedString(record.eventId, 240) &&
      strictBoundedString(record.callControlId, 520) &&
      Number.isFinite(Number(record.expiresAtMs)) &&
      ['connect', 'voicemail'].includes(record.decision),
  )
}

function restoreMapValue(map, key, value) {
  if (value === undefined) map.delete(key)
  else map.set(key, value)
}
