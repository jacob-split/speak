import { createHash } from 'node:crypto'

export function callToolsVoiceStandbyRuntimeFingerprint({
  config = {},
  generation = '',
} = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return ''
  if (!Object.keys(config).some((key) => config[key] !== undefined)) return ''
  try {
    return createHash('sha256')
      .update(stableJson({ config, generation: normalizePart(generation) }))
      .digest('hex')
  } catch {
    return ''
  }
}

export function callToolsVoiceStandbyScopeKey(scope = {}) {
  const binding = scope.binding || {}
  const runtimeFingerprint = callToolsVoiceStandbyRuntimeFingerprint({
    config: scope.config,
    generation: scope.runtimeGeneration || scope.profile?.updatedAt,
  })
  const parts = [
    scope.leaseId,
    scope.profileId,
    binding.appUserId || binding.userId,
    binding.campaignId,
    binding.phoneId,
    runtimeFingerprint,
  ].map(normalizePart)
  return parts.every(Boolean) ? parts.join('\u0000') : ''
}

export function createCallToolsVoiceStandbyCoordinator({
  prepare,
  cancel,
  get,
  isHealthy,
} = {}) {
  assertFunction(prepare, 'prepare')
  assertFunction(cancel, 'cancel')
  assertFunction(get, 'get')
  assertFunction(isHealthy, 'isHealthy')

  let active = null

  function ensure(scope = {}) {
    const key = callToolsVoiceStandbyScopeKey(scope)
    if (!key) throw new Error('CallTools standby requires a complete frozen lease scope')

    if (active && active.key !== key) cancelActive('scope_changed')

    const existing = get(key)
    if (existing?.state && isHealthy(existing.state)) {
      active = { key, scope, state: existing.state }
      return existing.state
    }
    if (existing) cancel(key, 'standby_unhealthy')
    if (active?.key === key) active = null

    const state = prepare({ key, scope })
    active = { key, scope, state }
    return state
  }

  function claim(scope = {}, bind) {
    assertFunction(bind, 'bind')
    const key = callToolsVoiceStandbyScopeKey(scope)
    if (!key || (active && active.key !== key)) return null

    const record = get(key)
    if (!record?.state || !isHealthy(record.state)) {
      if (record) cancel(key, 'standby_unhealthy')
      if (active?.key === key) active = null
      return null
    }

    const result = bind({ key, scope, state: record.state })
    active = null
    return result
  }

  function cancelActive(reason = 'canceled') {
    if (!active) return false
    const { key } = active
    active = null
    return cancel(key, reason)
  }

  return {
    ensure,
    claim,
    cancel: cancelActive,
    get active() {
      return active
    },
  }
}

function normalizePart(value) {
  return String(value || '').trim()
}

function assertFunction(value, name) {
  if (typeof value !== 'function') {
    throw new TypeError(`CallTools standby ${name} must be a function`)
  }
}

function stableJson(value) {
  return JSON.stringify(sortJson(value))
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, sortJson(value[key])]),
  )
}
