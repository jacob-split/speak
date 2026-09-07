import { XAI_API_BASE, providerError, readJson } from './provider-http.mjs'
import { getXaiApiKey } from './secrets.mjs'
import {
  DEFAULT_XAI_CONFIG_ID,
  DEFAULT_XAI_REALTIME_MODEL,
  DEFAULT_XAI_VOICE,
  normalizeCampaignConfig,
} from './runtime-config.mjs'
import { speakFunctionTools } from './hume-tools.mjs'

const XAI_CATALOG_CACHE_MS = 5 * 60 * 1000
const XAI_CATALOG_STALE_MS = 30 * 60 * 1000
const XAI_CATALOG_TIMEOUT_MS = 5000
const XAI_REALTIME_MODELS = [
  {
    id: 'grok-voice-latest',
    label: 'Grok Voice latest',
    description: 'Current xAI Voice Agent alias, optimized for realtime conversation.',
  },
  {
    id: 'grok-voice-think-fast-1.0',
    label: 'Grok Voice Think Fast 1.0',
    description: 'Pinned xAI Voice Agent model with optional high reasoning.',
  },
]

let xaiCatalogCache = { expiresAt: 0, staleUntil: 0, voices: [] }
let xaiCatalogRequest = null

export class XaiConfigSyncError extends Error {
  constructor(status, message, provider = 'xai') {
    super(message)
    this.name = 'XaiConfigSyncError'
    this.status = status
    this.provider = provider
  }
}

export async function readXaiAgentConfig(configId) {
  const id = String(configId || DEFAULT_XAI_CONFIG_ID).trim()
  if (!id) {
    throw new XaiConfigSyncError(400, 'An xAI realtime config ID is required.')
  }
  return {
    xaiConfigId: id,
    speakConfigId: id,
    xaiConfigName: id,
    speakConfigName: id,
    config: normalizeCampaignConfig({
      voiceRuntimeProvider: 'xai',
      xaiConfigId: id,
      speakConfigId: id,
      languageModelMode: 'xai',
    }),
  }
}

export async function readXaiConfigOptions() {
  if (!getXaiApiKey()) {
    throw new XaiConfigSyncError(503, 'xAI API key is required to read Voice Agent options.')
  }
  const voices = await fetchXaiVoiceCatalog({ forceRefresh: true })
  if (voices.length === 0) {
    throw new XaiConfigSyncError(502, 'xAI voice catalog returned no voices.')
  }
  return {
    eviVersions: [
      {
        value: DEFAULT_XAI_CONFIG_ID,
        label: 'xAI Realtime',
        description: 'Native xAI Voice Agent session configured through session.update.',
        runtimeProvider: 'xai',
      },
    ],
    codexAuthModels: [],
    languageModels: XAI_REALTIME_MODELS.map(xaiModelOption),
    voices,
    functionTools: speakFunctionTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
    })),
  }
}

export async function syncXaiAgentConfig({ profileName, config, createNew }) {
  const runtimeConfig = await ensureXaiRuntimeConfigReady({
    ...config,
    voiceRuntimeProvider: 'xai',
    languageModelMode: 'xai',
  })
  const name = String(
    profileName || runtimeConfig.agentProfileName || 'xAI realtime agent',
  ).trim()
  const configId =
    runtimeConfig.xaiConfigId || runtimeConfig.speakConfigId || DEFAULT_XAI_CONFIG_ID
  const syncedAt = new Date().toISOString()
  const configVersion = Math.floor(Date.now() / 1000)
  return {
    action: createNew ? 'created' : 'synced',
    xaiConfigId: configId,
    speakConfigId: configId,
    xaiConfigName: name,
    speakConfigName: name,
    xaiConfigVersion: configVersion,
    speakConfigVersion: configVersion,
    config: {
      ...runtimeConfig,
      voiceRuntimeProvider: 'xai',
      languageModelMode: 'xai',
      eviVersion: DEFAULT_XAI_CONFIG_ID,
      xaiConfigId: configId,
      speakConfigId: configId,
      xaiConfigVersion: configVersion,
      speakConfigVersion: configVersion,
      xaiConfigSyncedAt: syncedAt,
      speakConfigSyncedAt: syncedAt,
      useConfigPrompt: true,
      useConfigTools: true,
    },
  }
}

export async function ensureXaiRuntimeConfigReady(
  config = {},
  { allowStale = false } = {},
) {
  if (!getXaiApiKey()) {
    throw new XaiConfigSyncError(503, 'xAI API key is required for Voice Agent sessions.')
  }
  const runtimeConfig = normalizeCampaignConfig({
    ...config,
    voiceRuntimeProvider: 'xai',
    languageModelMode: 'xai',
  })
  const selectedModel = String(runtimeConfig.xaiRealtimeModel || '').trim()
  if (!XAI_REALTIME_MODELS.some((model) => model.id === selectedModel)) {
    throw xaiCompatibilityError(
      409,
      'The selected xAI Voice Agent model is not supported by this runtime.',
      'xai_model_not_available',
    )
  }
  const voices = await fetchXaiVoiceCatalog({ allowStale })
  const selectedVoice = String(runtimeConfig.voice || DEFAULT_XAI_VOICE).trim().toLowerCase()
  const voice = voices.find((option) => option.id.toLowerCase() === selectedVoice)
  if (!voice) {
    throw xaiCompatibilityError(
      409,
      'The selected xAI voice is not available in the current provider catalog.',
      'xai_voice_not_available',
    )
  }
  return normalizeCampaignConfig({
    ...runtimeConfig,
    voice: voice.id,
    xaiVoiceName: voice.name,
    xaiVoiceProvider: voice.provider,
    languageModelResource: selectedModel,
    xaiRealtimeModel: selectedModel,
  })
}

export async function prewarmXaiVoiceCatalog() {
  if (!getXaiApiKey()) return false
  await fetchXaiVoiceCatalog({ forceRefresh: true })
  return true
}

export async function fetchXaiVoiceCatalog({ allowStale = false, forceRefresh = false } = {}) {
  const now = Date.now()
  if (!forceRefresh && xaiCatalogCache.voices.length > 0 && xaiCatalogCache.expiresAt > now) {
    return xaiCatalogCache.voices
  }
  if (
    !forceRefresh &&
    allowStale &&
    xaiCatalogCache.voices.length > 0 &&
    xaiCatalogCache.staleUntil > now
  ) {
    void requestXaiVoiceCatalog().catch(() => {})
    return xaiCatalogCache.voices
  }
  return requestXaiVoiceCatalog()
}

async function requestXaiVoiceCatalog() {
  if (xaiCatalogRequest) return xaiCatalogRequest
  const request = (async () => {
    const [builtinPayload, customVoices] = await Promise.all([
      xaiRequest('/v1/tts/voices'),
      fetchAllXaiCustomVoices(),
    ])
    const builtins = Array.isArray(builtinPayload?.voices)
      ? builtinPayload.voices
      : Array.isArray(builtinPayload)
        ? builtinPayload
        : null
    if (!builtins) {
      throw new XaiConfigSyncError(502, 'xAI voice catalog returned an invalid response.')
    }
    const voices = [
      ...builtins.map((voice) => xaiVoiceOption(voice, 'XAI_BUILTIN')),
      ...customVoices.map((voice) => xaiVoiceOption(voice, 'XAI_CUSTOM')),
    ]
      .filter(Boolean)
      .filter(uniqueOptionValue)
      .sort((left, right) => left.label.localeCompare(right.label))
    xaiCatalogCache = {
      expiresAt: Date.now() + XAI_CATALOG_CACHE_MS,
      staleUntil: Date.now() + XAI_CATALOG_STALE_MS,
      voices,
    }
    return voices
  })()
  xaiCatalogRequest = request
  try {
    return await request
  } finally {
    if (xaiCatalogRequest === request) xaiCatalogRequest = null
  }
}

async function fetchAllXaiCustomVoices() {
  const voices = []
  const seenTokens = new Set()
  let token = ''
  while (true) {
    if (seenTokens.has(token)) {
      throw new XaiConfigSyncError(502, 'xAI custom voice catalog repeated a page token.')
    }
    seenTokens.add(token)
    const params = new URLSearchParams({ limit: '1000' })
    if (token) params.set('pagination_token', token)
    const payload = await xaiRequest(`/v1/custom-voices?${params.toString()}`)
    const page = Array.isArray(payload?.voices) ? payload.voices : []
    voices.push(...page)
    const next = String(payload?.pagination_token || '').trim()
    if (!next) break
    token = next
  }
  return voices
}

async function xaiRequest(path) {
  const response = await fetch(`${XAI_API_BASE}${path}`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${getXaiApiKey()}`,
    },
    signal: AbortSignal.timeout(XAI_CATALOG_TIMEOUT_MS),
  })
  const payload = await readJson(response)
  if (!response.ok) {
    throw new XaiConfigSyncError(
      response.status,
      providerError('xAI Voice Agent request failed', payload),
    )
  }
  return payload
}

function xaiModelOption(model) {
  return {
    value: `XAI_VOICE:${model.id}`,
    label: model.label,
    modelProvider: 'XAI_VOICE',
    modelResource: model.id,
    providerLabel: 'xAI',
    description: model.description,
    builtinTools: ['web_search', 'hang_up'],
    functionCallingSupported: true,
    reasoningEfforts: ['none', 'high'],
    reasoningSupported: true,
    runtimeProvider: 'xai',
  }
}

function xaiVoiceOption(voice, provider) {
  const id = String(voice?.voice_id || voice?.id || '').trim().toLowerCase()
  if (!id) return null
  const name = String(voice?.name || voice?.display_name || id).trim()
  return {
    value: `${provider}:${id}`,
    id,
    name,
    label: name,
    description: String(voice?.description || '').trim(),
    provider,
    providerLabel: provider === 'XAI_CUSTOM' ? 'xAI custom' : 'xAI',
    runtimeProvider: 'xai',
  }
}

function xaiCompatibilityError(status, message, code) {
  const error = new XaiConfigSyncError(status, message)
  error.code = code
  return error
}

function uniqueOptionValue(option, index, options) {
  return options.findIndex((candidate) => candidate?.value === option?.value) === index
}
