export const DEFAULT_PROVISIONAL_VOICE_SESSION_TTL_MS = 15_000
export const MAX_PROVISIONAL_VOICE_SESSION_TTL_MS = 10 * 60_000

export function createProvisionalVoiceSessionRegistry({
  ttlMs = DEFAULT_PROVISIONAL_VOICE_SESSION_TTL_MS,
  now = () => Date.now(),
  schedule = (callback, delayMs) => setTimeout(callback, delayMs),
  cancelScheduled = (timer) => clearTimeout(timer),
  closeState = () => {},
} = {}) {
  const records = new Map()
  const stateIds = new Map()
  const boundedTtlMs = Math.min(
    MAX_PROVISIONAL_VOICE_SESSION_TTL_MS,
    positiveInteger(ttlMs, DEFAULT_PROVISIONAL_VOICE_SESSION_TTL_MS),
  )

  function prepare({ key, state, ttlMs: recordTtlMs } = {}) {
    const normalizedKey = normalizeKey(key)
    if (!normalizedKey) throw new Error('Provisional voice session key is required')
    if (!state || typeof state !== 'object') {
      throw new Error('Provisional voice session state is required')
    }
    if (records.has(normalizedKey)) return records.get(normalizedKey)

    const provisionalCallControlId = normalizeKey(state.callControlId)
    if (!provisionalCallControlId) {
      throw new Error('Provisional voice session state requires a callControlId')
    }
    const createdAtMs = Number(now())
    const boundedRecordTtlMs = Math.min(
      MAX_PROVISIONAL_VOICE_SESSION_TTL_MS,
      positiveInteger(recordTtlMs, boundedTtlMs),
    )
    const record = {
      key: normalizedKey,
      state,
      provisionalCallControlId,
      createdAtMs,
      expiresAtMs: createdAtMs + boundedRecordTtlMs,
      timer: null,
    }
    state.provisionalVoiceSession = {
      active: true,
      key: normalizedKey,
      provisionalCallControlId,
      createdAtMs,
      expiresAtMs: record.expiresAtMs,
      events: [],
    }
    records.set(normalizedKey, record)
    stateIds.set(provisionalCallControlId, normalizedKey)
    record.timer = schedule(() => expire(normalizedKey), boundedRecordTtlMs)
    record.timer?.unref?.()
    return record
  }

  function get(key) {
    return records.get(normalizeKey(key)) || null
  }

  function findByStateId(callControlId) {
    const key = stateIds.get(normalizeKey(callControlId))
    return key ? records.get(key) || null : null
  }

  function bind(key, { callControlId } = {}) {
    const normalizedKey = normalizeKey(key)
    const normalizedCallControlId = normalizeKey(callControlId)
    const record = records.get(normalizedKey)
    if (!record || !normalizedCallControlId) return null

    removeRecord(record)
    record.state.callControlId = normalizedCallControlId
    if (record.state.provisionalVoiceSession) {
      record.state.provisionalVoiceSession.active = false
      record.state.provisionalVoiceSession.boundCallControlId = normalizedCallControlId
      record.state.provisionalVoiceSession.boundAtMs = Number(now())
    }
    return record
  }

  function cancel(key, reason = 'canceled') {
    const record = records.get(normalizeKey(key))
    if (!record) return false
    removeRecord(record)
    closeRecord(record, reason)
    return true
  }

  function expire(key) {
    const record = records.get(normalizeKey(key))
    if (!record) return false
    removeRecord(record, { timerFired: true })
    closeRecord(record, 'ttl_expired')
    return true
  }

  function cancelAll(reason = 'shutdown') {
    const pending = [...records.values()]
    pending.forEach((record) => {
      removeRecord(record)
      closeRecord(record, reason)
    })
    return pending.length
  }

  function removeRecord(record, { timerFired = false } = {}) {
    records.delete(record.key)
    stateIds.delete(record.provisionalCallControlId)
    if (record.timer && !timerFired) cancelScheduled(record.timer)
    record.timer = null
  }

  function closeRecord(record, reason) {
    record.state.ending = true
    if (record.state.provisionalVoiceSession) {
      record.state.provisionalVoiceSession.active = false
      record.state.provisionalVoiceSession.canceledReason = normalizeKey(reason) || 'canceled'
      record.state.provisionalVoiceSession.canceledAtMs = Number(now())
    }
    closeState(record.state, normalizeKey(reason) || 'canceled')
  }

  return {
    prepare,
    get,
    findByStateId,
    bind,
    cancel,
    cancelAll,
    get size() {
      return records.size
    },
  }
}

export function isProvisionalVoiceSessionState(state) {
  return Boolean(state?.provisionalVoiceSession?.active)
}

export function queueProvisionalVoiceSessionEvent(state, event) {
  if (!isProvisionalVoiceSessionState(state)) return false
  state.provisionalVoiceSession.events ||= []
  state.provisionalVoiceSession.events.push(event)
  state.provisionalVoiceSession.events = state.provisionalVoiceSession.events.slice(-50)
  return true
}

export function drainProvisionalVoiceSessionEvents(state) {
  const events = Array.isArray(state?.provisionalVoiceSession?.events)
    ? state.provisionalVoiceSession.events.slice()
    : []
  if (state?.provisionalVoiceSession) state.provisionalVoiceSession.events = []
  return events
}

function normalizeKey(value) {
  return String(value || '').trim()
}

function positiveInteger(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback
}
