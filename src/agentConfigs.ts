import { defaultCampaignConfig } from './data'
import type { CampaignConfig, ContextFields } from './types'
import { getBrowserStorage } from './browserStorage'
import { normalizeContextFields } from './contextFields'

const agentConfigStorageKey = 'speak:agent-configs:v1'
export const activeAgentConfigStorageKey = 'speak:active-agent-config-id:v1'
const phoneTransportMigrationStorageKey =
  'speak:phone-transport-l16-migration:v1'
export const seededSpeakDemoProfileId = 'agent-config-speak-demo-agent-v1'

export interface AgentConfigProfile {
  id: string
  name: string
  updatedAt: string
  config: CampaignConfig
  testVariables: AgentTestVariables
  context?: ContextFields
}

export interface AgentTestVariables {
  first_name: string
  last_name: string
  full_name: string
  business_name: string
  contact_phone: string
  contact_email: string
  notes: string
}

function createProfileId(prefix: string) {
  if (globalThis.crypto?.randomUUID) {
    return `${prefix}-${globalThis.crypto.randomUUID()}`
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function normalizeTelnyxStreamCodec(value: Partial<CampaignConfig>['telnyxStreamCodec']) {
  return value === 'PCMU' || value === 'L16'
    ? value
    : defaultCampaignConfig.telnyxStreamCodec
}

function normalizePhoneAudioMode(value: Partial<CampaignConfig>) {
  if (value.phoneAudioMode === 'legacy' && value.telnyxStreamCodec === 'PCMU') {
    return 'legacy'
  }
  return 'optimized'
}

function normalizePhonePlaceholder(value: unknown, fallback: string) {
  const text = String(value || '').trim()
  if (!text) return fallback
  if (/^\+?1?\s*your\s+telnyx\s+number$/i.test(text)) return '+1 your phone number'
  if (/^telnyx\s+connection\s+id$/i.test(text)) return 'Phone connection ID'
  if (/^telnyx\s+call\s+control\s+connection_id$/i.test(text)) {
    return 'Phone connection ID'
  }
  return text
}

function sampleRateForTelnyxStreamCodec(codec: CampaignConfig['telnyxStreamCodec']) {
  return codec === 'PCMU' ? 8000 : 16000
}

function normalizeVoiceRuntimeProvider(value: unknown) {
  const provider = String(value || '').trim()
  if (provider === 'inworld' || provider === 'xai') return provider
  return 'hume'
}

function normalizeDialerProvider(value: unknown) {
  return String(value || '').trim() === 'calltools' ? 'calltools' : 'speak'
}

function normalizeContactSource(value: unknown): CampaignConfig['contactSource'] {
  const source = String(value || '').trim()
  if (source === 'personal_phone' || source === 'personal phone') return 'personal-phone'
  if (source === 'personal-phone' || source === 'calltools') return source
  return ''
}

function normalizePersonalPhoneInboundConfig(
  value: Partial<CampaignConfig>['personalPhoneInbound'],
): NonNullable<CampaignConfig['personalPhoneInbound']> {
  const source =
    value && typeof value === 'object'
      ? value
      : defaultCampaignConfig.personalPhoneInbound || {}
  return {
    enabled: Boolean(source.enabled),
    eligibilityScope:
      source.eligibilityScope === 'source' ? 'source' : 'selected',
    sourceId: String(source.sourceId || '').trim(),
    contactIds: normalizeIdList(source.contactIds, 100),
    smartViewIds: normalizeIdList(source.smartViewIds, 50),
  }
}

function normalizeCallToolsAgentBinding(
  value: Partial<CampaignConfig>['calltoolsAgentBinding'],
) {
  const source = value && typeof value === 'object' ? value : {}
  const provisioningStatus: NonNullable<
    CampaignConfig['calltoolsAgentBinding']
  >['provisioningStatus'] =
    source.provisioningStatus === 'linked' ||
    source.provisioningStatus === 'ready' ||
    source.provisioningStatus === 'blocked'
      ? source.provisioningStatus
      : 'unconfigured'
  const mediaGatewayStatus: NonNullable<
    CampaignConfig['calltoolsAgentBinding']
  >['mediaGatewayStatus'] =
    source.mediaGatewayStatus === 'registered' ||
    source.mediaGatewayStatus === 'configured' ||
    source.mediaGatewayStatus === 'unverified' ||
    source.mediaGatewayStatus === 'verified' ||
    source.mediaGatewayStatus === 'failed'
      ? source.mediaGatewayStatus
      : 'unconfigured'
  return {
    enabled: Boolean(source.enabled),
    mode: 'phone_as_agent' as const,
    appUserId: String(source.appUserId || source.userId || '').trim(),
    userId: String(source.userId || source.appUserId || '').trim(),
    phoneId: String(source.phoneId || '').trim(),
    phoneSipUri: String(source.phoneSipUri || '').trim(),
    phoneWebSocketUrl: String(source.phoneWebSocketUrl || '').trim(),
    webCallbackId: String(source.webCallbackId || '').trim(),
    queueId: String(source.queueId || '').trim(),
    campaignId: String(source.campaignId || '').trim(),
    callerIdId: String(source.callerIdId || '').trim(),
    callerIdStrategyId: String(source.callerIdStrategyId || '').trim(),
    liveFilterId: String(source.liveFilterId || '').trim(),
    bucketId: String(source.bucketId || '').trim(),
    contactMatchMode: 'calltools_contact_id_then_phone' as const,
    provisioningStatus,
    mediaGatewayStatus,
    lastVerifiedAt: String(source.lastVerifiedAt || '').trim(),
  }
}

function migrateLegacyPhoneTransportProfile(
  value: Partial<AgentConfigProfile>,
): Partial<AgentConfigProfile> {
  const config = value.config
  if (!config) return value

  const migratedConfig: Partial<CampaignConfig> = { ...config }
  const codec = normalizeTelnyxStreamCodec(config.telnyxStreamCodec)
  if (
    config.phoneAudioMode !== 'legacy' &&
    (codec === 'PCMU' || Number(config.sampleRate) === 8000)
  ) {
    migratedConfig.phoneAudioMode = 'optimized'
    migratedConfig.telnyxStreamCodec = 'L16'
    migratedConfig.sampleRate = 16000
  }

  if (
    Number(config.endOfTurnSilenceMs) === 800 ||
    Number(config.endOfTurnSilenceMs) === 650
  ) {
    migratedConfig.endOfTurnSilenceMs = defaultCampaignConfig.endOfTurnSilenceMs
  }
  if (
    Number(config.speechDetectionThreshold) === 0.5 ||
    Number(config.speechDetectionThreshold) === 0.55
  ) {
    migratedConfig.speechDetectionThreshold =
      defaultCampaignConfig.speechDetectionThreshold
  }
  if (
    Number(config.minInterruptionMs) === 800 ||
    Number(config.minInterruptionMs) === 250
  ) {
    migratedConfig.minInterruptionMs = defaultCampaignConfig.minInterruptionMs
  }

  return { ...value, config: migratedConfig as CampaignConfig }
}

export function createAgentConfigId() {
  return createProfileId('agent-config')
}

export function normalizeCampaignProfileConfig(
  value: Partial<CampaignConfig> = {},
): CampaignConfig {
  const phoneAudioMode = normalizePhoneAudioMode(value)
  const dialerProvider = normalizeDialerProvider(value.dialerProvider)
  const voiceRuntimeProvider = normalizeVoiceRuntimeProvider(
    value.voiceRuntimeProvider ||
      (value.languageModelMode === 'inworld' || value.languageModelMode === 'xai'
        ? value.languageModelMode
        : 'hume'),
  )
  const rawLanguageModelMode =
    String(value.languageModelMode || '') === 'speak'
      ? 'hume'
      : value.languageModelMode
  const languageModelMode =
    rawLanguageModelMode === 'codex'
      ? 'codex'
      : rawLanguageModelMode === 'inworld' || voiceRuntimeProvider === 'inworld'
        ? 'inworld'
        : rawLanguageModelMode === 'xai' || voiceRuntimeProvider === 'xai'
          ? 'xai'
        : rawLanguageModelMode
  const telnyxStreamCodec =
    phoneAudioMode === 'legacy'
      ? 'PCMU'
      : normalizeTelnyxStreamCodec(
          value.telnyxStreamCodec === 'PCMU' || value.phoneStreamCodec === 'PCMU'
            ? 'L16'
            : value.telnyxStreamCodec || value.phoneStreamCodec,
        )
  const codexReasoningEffort =
    value.codexReasoningEffort === 'none' ||
    value.codexReasoningEffort === 'minimal' ||
    value.codexReasoningEffort === 'low' ||
    value.codexReasoningEffort === 'medium' ||
    value.codexReasoningEffort === 'high' ||
    value.codexReasoningEffort === 'xhigh'
      ? value.codexReasoningEffort
      : defaultCampaignConfig.codexReasoningEffort
  return {
    ...defaultCampaignConfig,
    ...value,
    dialerProvider,
    calltoolsAgentBinding: normalizeCallToolsAgentBinding(value.calltoolsAgentBinding),
    contactSource: normalizeContactSource(value.contactSource),
    contactSourceId: String(value.contactSourceId || '').trim(),
    personalPhoneInbound: normalizePersonalPhoneInboundConfig(
      value.personalPhoneInbound,
    ),
    voiceRuntimeProvider,
    languageModelMode,
    codexReasoningEffort,
    codexFastMode:
      typeof value.codexFastMode === 'boolean'
        ? value.codexFastMode
        : defaultCampaignConfig.codexFastMode,
    smartViewId: String(value.smartViewId || '').trim(),
    eviVersion: value.eviVersion || defaultCampaignConfig.eviVersion,
    humeConfigId:
      value.humeConfigId || value.speakConfigId || defaultCampaignConfig.humeConfigId,
    inworldConfigId:
      value.inworldConfigId ||
      (voiceRuntimeProvider === 'inworld' ? value.speakConfigId : '') ||
      defaultCampaignConfig.inworldConfigId,
    xaiConfigId:
      value.xaiConfigId ||
      (voiceRuntimeProvider === 'xai' ? value.speakConfigId : '') ||
      defaultCampaignConfig.xaiConfigId,
    humeConfigVersion: value.humeConfigVersion ?? value.speakConfigVersion,
    humeConfigSyncedAt: value.humeConfigSyncedAt || value.speakConfigSyncedAt,
    humeVoiceId:
      value.humeVoiceId ||
      (voiceRuntimeProvider === 'hume' ? value.voice : '') ||
      defaultCampaignConfig.humeVoiceId,
    humeVoiceName:
      value.humeVoiceName || value.speakVoiceName || defaultCampaignConfig.humeVoiceName,
    humeVoiceProvider:
      value.humeVoiceProvider ||
      value.speakVoiceProvider ||
      defaultCampaignConfig.humeVoiceProvider,
    inworldVoiceName:
      value.inworldVoiceName ||
      (voiceRuntimeProvider === 'inworld' ? value.speakVoiceName : '') ||
      defaultCampaignConfig.inworldVoiceName,
    inworldVoiceId:
      value.inworldVoiceId ||
      (voiceRuntimeProvider === 'inworld' ? value.voice : '') ||
      defaultCampaignConfig.inworldVoiceId,
    inworldVoiceProvider:
      value.inworldVoiceProvider ||
      (voiceRuntimeProvider === 'inworld' ? value.speakVoiceProvider : '') ||
      defaultCampaignConfig.inworldVoiceProvider,
    xaiVoiceName:
      value.xaiVoiceName ||
      (voiceRuntimeProvider === 'xai' ? value.speakVoiceName : '') ||
      defaultCampaignConfig.xaiVoiceName,
    xaiVoiceId:
      value.xaiVoiceId ||
      (voiceRuntimeProvider === 'xai' ? value.voice : '') ||
      defaultCampaignConfig.xaiVoiceId,
    xaiVoiceProvider:
      value.xaiVoiceProvider ||
      (voiceRuntimeProvider === 'xai' ? value.speakVoiceProvider : '') ||
      defaultCampaignConfig.xaiVoiceProvider,
    inworldRealtimeModel:
      value.inworldRealtimeModel ||
      (voiceRuntimeProvider === 'inworld' ? value.languageModelResource : '') ||
      defaultCampaignConfig.inworldRealtimeModel,
    xaiRealtimeModel:
      value.xaiRealtimeModel ||
      (voiceRuntimeProvider === 'xai' ? value.languageModelResource : '') ||
      defaultCampaignConfig.xaiRealtimeModel,
    xaiKeyterms: [...new Set(
      (Array.isArray(value.xaiKeyterms) ? value.xaiKeyterms : [])
        .map((item) => String(item || '').trim())
        .filter(Boolean),
    )].slice(0, 100),
    audioEncoding: 'linear16',
    phoneAudioMode,
    telnyxStreamCodec,
    telnyxCallerId: normalizePhonePlaceholder(
      value.telnyxCallerId || value.phoneCallerId,
      defaultCampaignConfig.telnyxCallerId,
    ),
    telnyxConnectionId: normalizePhonePlaceholder(
      value.telnyxConnectionId || value.phoneConnectionId,
      defaultCampaignConfig.telnyxConnectionId,
    ),
    endOfTurnSilenceMs: Number(
      Number(value.endOfTurnSilenceMs) === 650
        ? defaultCampaignConfig.endOfTurnSilenceMs
        : value.endOfTurnSilenceMs || defaultCampaignConfig.endOfTurnSilenceMs,
    ),
    speechDetectionThreshold: Number(
      value.speechDetectionThreshold ||
        defaultCampaignConfig.speechDetectionThreshold,
    ),
    prefixPaddingMs: Number(
      value.prefixPaddingMs || defaultCampaignConfig.prefixPaddingMs,
    ),
    minInterruptionMs: Number(
      value.minInterruptionMs || defaultCampaignConfig.minInterruptionMs,
    ),
    sampleRate: sampleRateForTelnyxStreamCodec(telnyxStreamCodec),
    maxConcurrent: Number(value.maxConcurrent || defaultCampaignConfig.maxConcurrent),
  }
}

function normalizeIdList(value: unknown, maxItems: number) {
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  )].slice(0, maxItems)
}

export function normalizeAgentTestVariables(
  value: Partial<AgentTestVariables> = {},
): AgentTestVariables {
  return {
    first_name: String(value.first_name || '').trim(),
    last_name: String(value.last_name || '').trim(),
    full_name: String(value.full_name || '').trim(),
    business_name: String(value.business_name || '').trim(),
    contact_phone: String(value.contact_phone || '').trim(),
    contact_email: String(value.contact_email || '').trim(),
    notes: String(value.notes || '').trim(),
  }
}

export function normalizeAgentProfile(value: Partial<AgentConfigProfile>) {
  return {
    id: value.id || createAgentConfigId(),
    name: String(value.name || 'Untitled config').trim() || 'Untitled config',
    updatedAt: value.updatedAt || new Date().toISOString(),
    config: normalizeCampaignProfileConfig(value.config),
    testVariables: normalizeAgentTestVariables(value.testVariables),
    context: normalizeContextFields(value.context),
  } satisfies AgentConfigProfile
}

export function seededSpeakDemoProfile() {
  return normalizeAgentProfile({
    id: seededSpeakDemoProfileId,
    name: 'Speak demo agent',
    updatedAt: '2026-06-19T00:00:00.000Z',
    config: { ...defaultCampaignConfig },
  })
}

function readCachedProfileValue(storageKey: string) {
  try {
    const storage = getBrowserStorage()
    if (!storage) return ''
    return storage.getItem(storageKey) || ''
  } catch {
    return ''
  }
}

function writeCachedProfileValue(storageKey: string, value: string) {
  try {
    getBrowserStorage()?.setItem(storageKey, value)
  } catch {
    // Server workspace state remains authoritative when browser storage is unavailable.
  }
}

function removeCachedProfileValue(storageKey: string) {
  try {
    getBrowserStorage()?.removeItem(storageKey)
  } catch {
    // Server workspace state remains authoritative when browser storage is unavailable.
  }
}

export function loadAgentProfiles() {
  try {
    const storage = getBrowserStorage()
    const storedProfiles = storage?.getItem(agentConfigStorageKey)
    if (!storedProfiles) return [seededSpeakDemoProfile()]

    const parsed = JSON.parse(storedProfiles)
    if (!Array.isArray(parsed)) return [seededSpeakDemoProfile()]
    const shouldMigratePhoneTransport =
      storage?.getItem(phoneTransportMigrationStorageKey) !== 'true'
    const profiles = shouldMigratePhoneTransport
      ? parsed.map((profile) => migrateLegacyPhoneTransportProfile(profile))
      : parsed
    const normalizedProfiles = profiles
      .map((profile) => normalizeAgentProfile(profile))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))

    if (shouldMigratePhoneTransport) {
      storage?.setItem(agentConfigStorageKey, JSON.stringify(normalizedProfiles))
      storage?.setItem(phoneTransportMigrationStorageKey, 'true')
    }

    return normalizedProfiles
  } catch {
    return [seededSpeakDemoProfile()]
  }
}

export function saveAgentProfiles(profiles: AgentConfigProfile[]) {
  writeCachedProfileValue(agentConfigStorageKey, JSON.stringify(profiles))
}

export function loadActiveAgentProfileId() {
  return readCachedProfileValue(activeAgentConfigStorageKey)
}

export function loadActiveAgentProfile() {
  const activeId = loadActiveAgentProfileId()
  const profiles = loadAgentProfiles()
  if (activeId) {
    const activeProfile = profiles.find((profile) => profile.id === activeId)
    if (activeProfile) return activeProfile
  }
  return profiles.find((profile) => profile.id === seededSpeakDemoProfileId) || null
}

export function saveActiveAgentProfileId(id: string) {
  writeCachedProfileValue(activeAgentConfigStorageKey, id)
}

export function clearActiveAgentProfileId() {
  removeCachedProfileValue(activeAgentConfigStorageKey)
}

export function resolveCallConfig(fallback: CampaignConfig) {
  const activeProfile = loadActiveAgentProfile()
  if (!activeProfile) return fallback

  return {
    ...fallback,
    ...activeProfile.config,
    agentProfileId: activeProfile.id,
    agentProfileName: activeProfile.name,
    telnyxCallerId: activeProfile.config.telnyxCallerId || fallback.telnyxCallerId,
    telnyxConnectionId:
      activeProfile.config.telnyxConnectionId || fallback.telnyxConnectionId,
  }
}
