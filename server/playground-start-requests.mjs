const START_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/
const START_REQUEST_MODES = new Set(['browser', 'phone'])

export function normalizePlaygroundStartRequestId(value) {
  const normalized = String(value || '').trim()
  return START_REQUEST_ID_PATTERN.test(normalized) ? normalized : ''
}

export function createPlaygroundStartRequestRegistry({
  ttlMs = 15 * 60_000,
  maxEntries = 2_048,
  now = Date.now,
} = {}) {
  const records = new Map()
  const retentionMs = Math.max(1_000, Number(ttlMs) || 15 * 60_000)
  const capacity = Math.max(16, Number(maxEntries) || 2_048)

  function prune() {
    const currentTime = now()
    for (const [id, record] of records) {
      if (record.expiresAt <= currentTime) records.delete(id)
    }
  }

  function makeRoom() {
    prune()
    if (records.size < capacity) return true

    for (const [id, record] of records) {
      if (record.status !== 'pending' && record.status !== 'started') {
        records.delete(id)
        if (records.size < capacity) return true
      }
    }
    return false
  }

  function refresh(record) {
    record.updatedAt = now()
    record.expiresAt = record.updatedAt + retentionMs
    return record
  }

  function begin({ id, mode }) {
    const normalizedId = normalizePlaygroundStartRequestId(id)
    const normalizedMode = START_REQUEST_MODES.has(mode) ? mode : ''
    if (!normalizedId || !normalizedMode) {
      return { accepted: false, reason: 'invalid', record: null }
    }

    prune()
    const existing = records.get(normalizedId)
    if (existing) {
      return {
        accepted: false,
        reason: existing.canceled ? 'canceled' : 'duplicate',
        record: existing,
      }
    }
    if (!makeRoom()) {
      return { accepted: false, reason: 'capacity', record: null }
    }

    const createdAt = now()
    const record = {
      id: normalizedId,
      mode: normalizedMode,
      sessionId: '',
      status: 'pending',
      canceled: false,
      cancelReason: '',
      createdAt,
      updatedAt: createdAt,
      expiresAt: createdAt + retentionMs,
    }
    records.set(normalizedId, record)
    return { accepted: true, reason: '', record }
  }

  function cancel(id, reason = 'client_cancelled') {
    const normalizedId = normalizePlaygroundStartRequestId(id)
    if (!normalizedId) return null

    prune()
    let record = records.get(normalizedId)
    if (!record) {
      if (!makeRoom()) return null
      const createdAt = now()
      record = {
        id: normalizedId,
        mode: '',
        sessionId: '',
        status: 'canceled',
        canceled: true,
        cancelReason: String(reason || 'client_cancelled'),
        createdAt,
        updatedAt: createdAt,
        expiresAt: createdAt + retentionMs,
      }
      records.set(normalizedId, record)
      return record
    }

    record.canceled = true
    record.cancelReason = String(reason || 'client_cancelled')
    record.status = 'canceled'
    return refresh(record)
  }

  function bind(id, { mode, sessionId }) {
    const normalizedId = normalizePlaygroundStartRequestId(id)
    if (!normalizedId) return null

    prune()
    const record = records.get(normalizedId)
    if (!record) return null
    if (START_REQUEST_MODES.has(mode)) record.mode = mode
    record.sessionId = String(sessionId || '').trim()
    if (!record.canceled) record.status = 'started'
    return refresh(record)
  }

  function finish(id, status = 'finished') {
    const normalizedId = normalizePlaygroundStartRequestId(id)
    if (!normalizedId) return null

    prune()
    const record = records.get(normalizedId)
    if (!record) return null
    record.status = record.canceled ? 'canceled' : String(status || 'finished')
    return refresh(record)
  }

  function get(id) {
    const normalizedId = normalizePlaygroundStartRequestId(id)
    if (!normalizedId) return null
    prune()
    return records.get(normalizedId) || null
  }

  return {
    begin,
    bind,
    cancel,
    finish,
    get,
    get size() {
      prune()
      return records.size
    },
  }
}
