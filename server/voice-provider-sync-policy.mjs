const DEFAULT_PROFILE_SYNC_GRACE_MS = 5_000
const HUME_MIN_NUDGE_INTERVAL_SECONDS = 3
const HUME_MAX_NUDGE_INTERVAL_SECONDS = 60

export function humeProviderNudgeIntervalSeconds(value) {
  if (value === undefined || value === null || value === '') return undefined
  const seconds = Number(value)
  if (!Number.isFinite(seconds)) return undefined
  return Math.max(
    HUME_MIN_NUDGE_INTERVAL_SECONDS,
    Math.min(HUME_MAX_NUDGE_INTERVAL_SECONDS, seconds),
  )
}

export function voiceProviderConfigSyncRequired(
  config = {},
  { graceMs = DEFAULT_PROFILE_SYNC_GRACE_MS } = {},
) {
  const runtimeProvider = String(config?.voiceRuntimeProvider || '').trim().toLowerCase()
  if (runtimeProvider === 'inworld' || runtimeProvider === 'xai') return false

  const profileUpdatedAt = parsedTimestamp(config?.agentProfileUpdatedAt)
  if (profileUpdatedAt === null) return false

  const providerSyncedAt = parsedTimestamp(
    config?.humeConfigSyncedAt || config?.speakConfigSyncedAt,
  )
  if (providerSyncedAt === null) return true

  const boundedGraceMs = Math.max(0, Number(graceMs) || 0)
  return profileUpdatedAt - providerSyncedAt > boundedGraceMs
}

function parsedTimestamp(value) {
  const timestamp = Date.parse(String(value || ''))
  return Number.isFinite(timestamp) ? timestamp : null
}
