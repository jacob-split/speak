const DELIVERED_SMS_STATUSES = new Set(['delivered'])
const FAILED_SMS_STATUSES = new Set([
  'delivery_failed',
  'sending_failed',
  'failed',
  'rejected',
  'undeliverable',
  'undelivered',
])

export function createTelnyxSmsFinalizationTracker({
  readMessage = async () => null,
  timeoutMs = 30_000,
  pollIntervalMs = 1_000,
  cacheTtlMs = 10 * 60 * 1_000,
  now = () => Date.now(),
} = {}) {
  const cached = new Map()
  const waiters = new Map()
  const boundedTimeoutMs = boundedNumber(timeoutMs, 30_000, 1, 120_000)
  const boundedPollIntervalMs = boundedNumber(pollIntervalMs, 1_000, 1, 30_000)
  const boundedCacheTtlMs = boundedNumber(cacheTtlMs, 600_000, 1_000, 86_400_000)

  function observe(payload = {}, { eventType = '', source = 'webhook' } = {}) {
    const normalized = normalizeTelnyxSmsFinalization(payload, {
      eventType,
      source,
    })
    if (!normalized.message_id || !normalized.delivery_finalized) return normalized
    pruneCache()
    cached.set(normalized.message_id, {
      expiresAt: now() + boundedCacheTtlMs,
      outcome: normalized,
    })
    const listeners = waiters.get(normalized.message_id)
    if (listeners) {
      waiters.delete(normalized.message_id)
      for (const listener of listeners) listener(normalized)
    }
    return normalized
  }

  async function waitFor(providerResult = {}, options = {}) {
    const initial = normalizeTelnyxSmsFinalization(providerResult, {
      source: 'provider_acceptance',
    })
    if (initial.delivery_finalized) return initial
    if (!initial.message_id) {
      return acceptedUnverified(initial, {
        reason: 'provider_message_id_missing',
        error: 'Telnyx accepted the SMS request without a message ID for final delivery proof.',
      })
    }

    pruneCache()
    const alreadyFinal = cached.get(initial.message_id)?.outcome
    if (alreadyFinal) return alreadyFinal

    const waitTimeoutMs = boundedNumber(
      options.timeoutMs,
      boundedTimeoutMs,
      1,
      120_000,
    )
    const pollMs = boundedNumber(
      options.pollIntervalMs,
      boundedPollIntervalMs,
      1,
      30_000,
    )
    const startedAt = now()
    let latest = initial
    let lastReadError = ''

    return new Promise((resolve) => {
      let finished = false
      let pollTimer = null
      let timeoutTimer = null

      const finish = (outcome) => {
        if (finished) return
        finished = true
        if (pollTimer) clearTimeout(pollTimer)
        if (timeoutTimer) clearTimeout(timeoutTimer)
        const listeners = waiters.get(initial.message_id)
        if (listeners) {
          listeners.delete(finish)
          if (listeners.size === 0) waiters.delete(initial.message_id)
        }
        resolve(outcome)
      }

      const listeners = waiters.get(initial.message_id) || new Set()
      listeners.add(finish)
      waiters.set(initial.message_id, listeners)

      const poll = async () => {
        if (finished) return
        try {
          const payload = await readMessage(initial.message_id)
          if (finished) return
          const observed = normalizeTelnyxSmsFinalization(payload || {}, {
            source: 'readback',
          })
          if (observed.message_id) latest = observed
          if (observed.delivery_finalized) {
            observe(payload, { source: 'readback' })
            return
          }
        } catch (error) {
          lastReadError = sanitizeProviderText(errorMessage(error), 200)
        }
        if (finished) return
        const elapsed = Math.max(0, now() - startedAt)
        const remaining = Math.max(1, waitTimeoutMs - elapsed)
        pollTimer = setTimeout(poll, Math.min(pollMs, remaining))
      }

      timeoutTimer = setTimeout(() => {
        finish(
          acceptedUnverified(latest, {
            reason: 'delivery_finalization_timeout',
            error: lastReadError,
          }),
        )
      }, waitTimeoutMs)
      void poll()
    })
  }

  function pruneCache() {
    const timestamp = now()
    for (const [messageId, entry] of cached) {
      if (entry.expiresAt <= timestamp) cached.delete(messageId)
    }
  }

  return {
    observe,
    waitFor,
  }
}

export function normalizeTelnyxSmsFinalization(
  input = {},
  { eventType = '', source = 'provider' } = {},
) {
  const payload = input?.data && typeof input.data === 'object' ? input.data : input
  const recipients = Array.isArray(payload?.to) ? payload.to : []
  const statuses = [
    ...recipients.map((recipient) => normalizedStatus(recipient?.status)),
    normalizedStatus(payload?.status),
    normalizedStatus(payload?.delivery_status),
    normalizedStatus(payload?.message_status),
    normalizedStatus(payload?.state),
  ].filter(Boolean)
  const providerStatus =
    statuses.find((status) => FAILED_SMS_STATUSES.has(status)) ||
    statuses.find((status) => DELIVERED_SMS_STATUSES.has(status)) ||
    statuses[0] ||
    'unknown'
  const errors = normalizedErrors(payload, recipients)
  const messageId = String(payload?.id || payload?.message_id || payload?.messageId || '').trim()
  const delivered = DELIVERED_SMS_STATUSES.has(providerStatus)
  const failed = FAILED_SMS_STATUSES.has(providerStatus)
  const common = {
    message_id: messageId,
    provider_status: providerStatus,
    provider_accepted: Boolean(messageId),
    delivery_finalized: delivered || failed,
    event_type: String(eventType || '').trim(),
    source: String(source || 'provider').trim() || 'provider',
    errors,
  }

  if (delivered) {
    return {
      ...common,
      ok: true,
      sent: true,
      status: 'delivered',
    }
  }
  if (failed) {
    const firstError = errors[0] || {}
    const errorCode = String(firstError.code || '').trim()
    const errorTitle = String(firstError.title || '').trim()
    const summary = [errorCode, errorTitle].filter(Boolean).join(': ')
    return {
      ...common,
      ok: false,
      sent: false,
      status: 'failed',
      error_code: errorCode,
      error: `SMS delivery failed after provider acceptance${summary ? ` (${summary})` : ''}`,
    }
  }
  return {
    ...common,
    ok: false,
    sent: false,
    status: 'processing',
  }
}

function acceptedUnverified(input = {}, { reason = '', error = '' } = {}) {
  return {
    ...input,
    ok: false,
    sent: false,
    status: 'accepted_unverified',
    provider_accepted: Boolean(input.message_id),
    delivery_finalized: false,
    reason,
    error: sanitizeProviderText(error, 200),
    assistant_next_step:
      'Telnyx accepted the text message, but final delivery is not proven. Do not say it was sent and do not retry automatically; let the operator verify the provider record.',
  }
}

function normalizedErrors(payload = {}, recipients = []) {
  const values = [
    ...(Array.isArray(payload?.errors) ? payload.errors : []),
    ...recipients.flatMap((recipient) =>
      Array.isArray(recipient?.errors) ? recipient.errors : [],
    ),
  ]
  const seen = new Set()
  return values
    .map((error) => {
      const normalized = {
        code: sanitizeProviderText(error?.code, 40),
        title: sanitizeProviderText(error?.title || error?.reason, 160),
      }
      const key = `${normalized.code}\u0000${normalized.title}`
      if ((!normalized.code && !normalized.title) || seen.has(key)) return null
      seen.add(key)
      return normalized
    })
    .filter(Boolean)
    .slice(0, 5)
}

function sanitizeProviderText(value, limit) {
  return String(value || '')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\+?[0-9][0-9 ()-]{7,}[0-9]/g, '[phone]')
    .replace(/[A-Za-z0-9_=-]{48,}/g, '[redacted]')
    .trim()
    .slice(0, limit)
}

function normalizedStatus(value) {
  return String(value || '').trim().toLowerCase()
}

function boundedNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value)
  const normalized = Number.isFinite(parsed) ? parsed : fallback
  return Math.max(minimum, Math.min(maximum, normalized))
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || '')
}
