import { INWORLD_API_BASE, providerError, readJson } from './provider-http.mjs'
import { getInworldApiKey } from './secrets.mjs'
import {
  DEFAULT_INWORLD_CONFIG_ID,
  DEFAULT_INWORLD_REALTIME_MODEL,
  normalizeCampaignConfig,
} from './runtime-config.mjs'
import { readCodexAuthModelOptions } from './codex-clm.mjs'
import { speakFunctionTools } from './hume-tools.mjs'

const SPEAK_REQUIRES_INWORLD_FUNCTION_TOOLS = true
const INWORLD_MODEL_CATALOG_CACHE_MS = 5 * 60 * 1000
const INWORLD_MODEL_CATALOG_STALE_MS = 30 * 60 * 1000
const INWORLD_MODEL_CATALOG_TIMEOUT_MS = 1500
const INWORLD_OPTIONS_CATALOG_TIMEOUT_MS = 5000
const INWORLD_OPTIONS_CATALOG_ATTEMPTS = 2
let inworldModelCatalogCache = { expiresAt: 0, models: [], staleUntil: 0 }
const inworldModelCatalogRequests = {
  refresh: null,
  runtime: null,
}
let inworldVoiceCatalogRequest = null

export class InworldConfigSyncError extends Error {
  constructor(status, message, provider) {
    super(message)
    this.name = 'InworldConfigSyncError'
    this.status = status
    this.provider = provider
  }
}

export async function readInworldAgentConfig(configId) {
  const id = String(configId || DEFAULT_INWORLD_CONFIG_ID).trim()
  if (!id) {
    throw new InworldConfigSyncError(400, 'An Inworld realtime config ID is required.')
  }

  return {
    inworldConfigId: id,
    speakConfigId: id,
    inworldConfigName: id,
    speakConfigName: id,
    config: normalizeCampaignConfig({
      voiceRuntimeProvider: 'inworld',
      inworldConfigId: id,
      speakConfigId: id,
      languageModelMode: 'inworld',
    }),
  }
}

export async function readInworldConfigOptions() {
  const providerConfigured = Boolean(getInworldApiKey())
  const [modelCatalog, voices] = await Promise.all([
    fetchInworldModelCatalog({ forceRefresh: true }),
    refreshInworldVoices(),
  ])
  const models = buildInworldNativeModelOptions(modelCatalog)
  if (providerConfigured && modelCatalog.length === 0) {
    throw new InworldConfigSyncError(
      502,
      'Inworld model catalog returned no models.',
      'inworld',
    )
  }
  if (providerConfigured && models.length === 0) {
    throw new InworldConfigSyncError(
      502,
      'Inworld model catalog returned no models compatible with Speak tools.',
      'inworld',
    )
  }
  const languageModels = providerConfigured ? models : defaultInworldModelOptions()
  const codexAuthModels = modelCatalog.length
    ? await readInworldCodexAuthModelOptions(modelCatalog)
    : []

  return {
    eviVersions: [
      {
        value: DEFAULT_INWORLD_CONFIG_ID,
        label: 'Inworld Realtime',
        description:
          'Realtime speech-to-speech session configured through session.update.',
        runtimeProvider: 'inworld',
      },
    ],
    codexAuthModels,
    languageModels,
    voices,
    functionTools: speakFunctionTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
    })),
  }
}

export async function syncInworldAgentConfig({
  profileName,
  config,
  createNew,
}) {
  const requestedMode = config?.languageModelMode === 'codex' ? 'codex' : 'inworld'
  const runtimeConfig = normalizeCampaignConfig({
    ...config,
    voiceRuntimeProvider: 'inworld',
    languageModelMode: requestedMode,
  })
  const name = normalizeInworldConfigName(
    profileName || runtimeConfig.agentProfileName || 'Inworld realtime agent',
  )
  const configId =
    runtimeConfig.inworldConfigId ||
    runtimeConfig.speakConfigId ||
    stableInworldConfigId(runtimeConfig.agentProfileId || name)
  const syncedAt = new Date().toISOString()
  const configVersion = Math.floor(Date.now() / 1000)

  return {
    action: createNew ? 'created' : 'synced',
    inworldConfigId: configId,
    speakConfigId: configId,
    inworldConfigName: name,
    speakConfigName: name,
    inworldConfigVersion: configVersion,
    speakConfigVersion: configVersion,
    config: {
      ...runtimeConfig,
      voiceRuntimeProvider: 'inworld',
      languageModelMode: runtimeConfig.languageModelMode,
      eviVersion: DEFAULT_INWORLD_CONFIG_ID,
      inworldConfigId: configId,
      speakConfigId: configId,
      inworldConfigSyncedAt: syncedAt,
      speakConfigSyncedAt: syncedAt,
      useConfigPrompt: true,
      useConfigTools: true,
    },
  }
}

async function fetchInworldModelCatalog({
  allowStale = false,
  forceRefresh = false,
} = {}) {
  if (!getInworldApiKey()) return []
  const now = Date.now()
  if (
    !forceRefresh &&
    inworldModelCatalogCache.models.length > 0 &&
    inworldModelCatalogCache.expiresAt > now
  ) {
    return inworldModelCatalogCache.models
  }
  if (
    !forceRefresh &&
    allowStale &&
    inworldModelCatalogCache.models.length > 0 &&
    inworldModelCatalogCache.staleUntil > now
  ) {
    void requestInworldModelCatalog({ mode: 'refresh' }).catch(() => {})
    return inworldModelCatalogCache.models
  }
  return requestInworldModelCatalog({
    mode: forceRefresh ? 'refresh' : 'runtime',
  })
}

async function requestInworldModelCatalog({ mode = 'runtime' } = {}) {
  const requestMode = mode === 'refresh' ? 'refresh' : 'runtime'
  const existingRequest = inworldModelCatalogRequests[requestMode]
  if (existingRequest) return existingRequest

  const request = (async () => {
    const refresh = requestMode === 'refresh'
    const payload = await requestInworldCatalogPayload(
      '/llm/v1alpha/models',
      {
        attempts: refresh ? INWORLD_OPTIONS_CATALOG_ATTEMPTS : 1,
        timeoutMs: refresh
          ? INWORLD_OPTIONS_CATALOG_TIMEOUT_MS
          : INWORLD_MODEL_CATALOG_TIMEOUT_MS,
        unavailableMessage:
          'Inworld model catalog validation timed out or was unavailable.',
      },
    )
    const models = Array.isArray(payload?.models)
      ? payload.models
      : Array.isArray(payload)
        ? payload
        : null
    if (!models) {
      throw new InworldConfigSyncError(
        502,
        'Inworld model catalog returned an invalid response.',
        'inworld',
      )
    }
    if (models.length === 0) {
      throw new InworldConfigSyncError(
        502,
        'Inworld model catalog returned no models.',
        'inworld',
      )
    }
    const validatedModels = validatedInworldModelCatalog(models)
    if (validatedModels.length === 0) {
      throw new InworldConfigSyncError(
        502,
        'Inworld model catalog returned no models compatible with Speak tools.',
        'inworld',
      )
    }
    inworldModelCatalogCache = {
      expiresAt: Date.now() + INWORLD_MODEL_CATALOG_CACHE_MS,
      models: validatedModels,
      staleUntil: Date.now() + INWORLD_MODEL_CATALOG_STALE_MS,
    }
    return validatedModels
  })()
  inworldModelCatalogRequests[requestMode] = request

  try {
    return await request
  } finally {
    if (inworldModelCatalogRequests[requestMode] === request) {
      inworldModelCatalogRequests[requestMode] = null
    }
  }
}

export async function prewarmInworldModelCatalog() {
  if (!getInworldApiKey()) return false
  await fetchInworldModelCatalog({ forceRefresh: true })
  return true
}

export async function ensureInworldRuntimeConfigReady(
  config = {},
  { allowStale = false } = {},
) {
  if (!getInworldApiKey()) {
    throw new InworldConfigSyncError(
      503,
      'Inworld API key is required to validate the selected model.',
      'inworld',
    )
  }
  const modelCatalog = await fetchInworldModelCatalog({ allowStale })
  return validateInworldRuntimeConfig(config, modelCatalog)
}

export function validateInworldRuntimeConfig(config = {}, modelCatalog = []) {
  const runtimeConfig = normalizeCampaignConfig({
    ...config,
    voiceRuntimeProvider: 'inworld',
  })
  const requestedModel = normalizeInworldRuntimeModelResource(
    runtimeConfig.inworldRealtimeModel || runtimeConfig.languageModelResource,
  )
  const selectedModel = modelCatalog.find(
    (model) => inworldCatalogModelResource(model) === requestedModel,
  )

  if (!selectedModel || selectedModel.isSupported !== true) {
    throw inworldRuntimeCompatibilityError(
      409,
      'The selected Inworld model is not available in the current provider catalog.',
      'inworld_model_not_available',
    )
  }
  if (!inworldModelSupportsFunctionCalling(selectedModel)) {
    throw inworldRuntimeCompatibilityError(
      409,
      'The selected Inworld model does not support the shared Speak tools.',
      'inworld_model_not_tool_compatible',
    )
  }
  if (!inworldModelSupportsTextSession(selectedModel)) {
    throw inworldRuntimeCompatibilityError(
      409,
      'The selected Inworld model does not support realtime text input and output.',
      'inworld_model_not_text_compatible',
    )
  }

  return normalizeCampaignConfig({
    ...runtimeConfig,
    languageModelResource: requestedModel,
    inworldRealtimeModel: requestedModel,
    inworldReasoningEfforts: inworldModelReasoningEfforts(selectedModel),
    inworldReasoningSupported: inworldModelSupportsReasoning(selectedModel),
  })
}

function inworldRuntimeCompatibilityError(status, message, code) {
  const error = new InworldConfigSyncError(status, message, 'inworld')
  error.code = code
  return error
}

async function refreshInworldVoices() {
  if (!getInworldApiKey()) return []
  if (inworldVoiceCatalogRequest) return inworldVoiceCatalogRequest

  const request = (async () => {
    const voices = await fetchPaginatedInworldVoices()

    return voices
      .map(inworldVoiceOption)
      .filter(Boolean)
      .filter(uniqueOptionValue)
      .sort((left, right) => left.label.localeCompare(right.label))
  })()
  inworldVoiceCatalogRequest = request

  try {
    return await request
  } finally {
    if (inworldVoiceCatalogRequest === request) {
      inworldVoiceCatalogRequest = null
    }
  }
}

async function fetchPaginatedInworldVoices() {
  const voices = []
  const seenPageTokens = new Set()
  let pageToken = ''

  while (true) {
    if (seenPageTokens.has(pageToken)) {
      throw new InworldConfigSyncError(
        502,
        'Inworld voice catalog repeated a page token.',
        'inworld',
      )
    }
    seenPageTokens.add(pageToken)
    const params = new URLSearchParams({
      pageSize: '2000',
      orderBy: 'display_name asc',
    })
    if (pageToken) params.set('pageToken', pageToken)

    const payload = await requestInworldCatalogPayload(
      `/voices/v1/voices?${params.toString()}`,
      {
        attempts: INWORLD_OPTIONS_CATALOG_ATTEMPTS,
        timeoutMs: INWORLD_OPTIONS_CATALOG_TIMEOUT_MS,
        unavailableMessage:
          'Inworld voice catalog validation timed out or was unavailable.',
      },
    )
    const pageVoices = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.voices)
        ? payload.voices
        : null
    if (!pageVoices) {
      throw new InworldConfigSyncError(
        502,
        'Inworld voice catalog returned an invalid page.',
        'inworld',
      )
    }
    voices.push(...pageVoices)

    const rawNextPageToken = Array.isArray(payload) ? undefined : payload?.nextPageToken
    if (
      rawNextPageToken !== undefined &&
      rawNextPageToken !== null &&
      typeof rawNextPageToken !== 'string'
    ) {
      throw new InworldConfigSyncError(
        502,
        'Inworld voice catalog returned an invalid page token.',
        'inworld',
      )
    }
    const nextPageToken = String(rawNextPageToken || '').trim()
    if (!nextPageToken) break
    pageToken = nextPageToken
  }

  return voices
}

async function requestInworldCatalogPayload(
  path,
  { attempts = 1, timeoutMs, unavailableMessage } = {},
) {
  const boundedAttempts = Math.max(1, Number(attempts) || 1)
  let lastError = null

  for (let attempt = 1; attempt <= boundedAttempts; attempt += 1) {
    try {
      return await inworldRequest(path, {
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      lastError = error
      if (
        attempt >= boundedAttempts ||
        !isRetryableInworldCatalogError(error)
      ) {
        break
      }
    }
  }

  if (lastError instanceof InworldConfigSyncError) throw lastError
  throw new InworldConfigSyncError(
    504,
    unavailableMessage || 'Inworld provider catalog timed out or was unavailable.',
    'inworld',
  )
}

function isRetryableInworldCatalogError(error) {
  if (!(error instanceof InworldConfigSyncError)) return true
  const status = Number(error.status)
  return status === 408 || status === 429 || status >= 500
}

async function inworldRequest(path, options = {}) {
  const apiKey = getInworldApiKey()
  const response = await fetch(`${INWORLD_API_BASE}${path}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Basic ${apiKey}`,
      ...(options.headers || {}),
    },
  })
  const payload = await readJson(response)

  if (!response.ok) {
    throw new InworldConfigSyncError(
      response.status,
      providerError('Inworld config request failed', payload),
      'inworld',
    )
  }

  return payload
}

function inworldModelOption(model) {
  const provider = stringValue(model.provider || model.modelProvider || model.vendor)
  const modelId = inworldCatalogModelResource(model)
  if (!modelId) return null

  const capabilities = model.capabilities || model.spec?.capabilities || {}
  return {
    value: `INWORLD:${modelId}`,
    label: model.displayName || model.label || modelId,
    modelProvider: 'INWORLD',
    modelResource: modelId,
    providerLabel: formatInworldProviderLabel(provider),
    description:
      model.description ||
      `Inworld Realtime LLM model ${modelId}.`,
    builtinTools: capabilities.functionCalling === false ? [] : ['hang_up'],
    functionCallingSupported: inworldModelSupportsFunctionCalling(model),
    reasoningEfforts: inworldModelReasoningEfforts(model),
    reasoningSupported: inworldModelSupportsReasoning(model),
    runtimeProvider: 'inworld',
  }
}

export function buildInworldNativeModelOptions(modelCatalog = []) {
  return validatedInworldModelCatalog(modelCatalog)
    .map(inworldModelOption)
    .filter(Boolean)
    .filter(uniqueOptionValue)
    .sort((left, right) => left.label.localeCompare(right.label))
}

function validatedInworldModelCatalog(modelCatalog = []) {
  return modelCatalog
    .filter((model) => model?.isSupported === true)
    .filter(
      (model) =>
        !SPEAK_REQUIRES_INWORLD_FUNCTION_TOOLS ||
        inworldModelSupportsFunctionCalling(model),
    )
    .filter(inworldModelSupportsTextSession)
}

function inworldVoiceOption(voice) {
  const id = stringValue(voice.voiceId || voice.id || voice.name)
  if (!id) return null
  const source = stringValue(voice.source || voice.provider).toUpperCase()
  const provider = source && source !== 'SYSTEM' ? 'INWORLD_CUSTOM' : 'INWORLD_SYSTEM'
  return {
    value: `${provider}:${id}`,
    id,
    name: voice.displayName || voice.name || id,
    label: voice.displayName || voice.name || id,
    description: voice.description || '',
    provider,
    providerLabel: provider === 'INWORLD_CUSTOM' ? 'Inworld custom' : 'Inworld',
    tags: voice.tags || undefined,
    gender: voice.gender || undefined,
    ageGroup: voice.ageGroup || voice.age_group || undefined,
    promptLanguages: voice.promptLanguages || undefined,
    runtimeProvider: 'inworld',
  }
}

function defaultInworldModelOptions() {
  return [
    {
      value: `INWORLD:${DEFAULT_INWORLD_REALTIME_MODEL}`,
      label: DEFAULT_INWORLD_REALTIME_MODEL,
      modelProvider: 'INWORLD',
      modelResource: DEFAULT_INWORLD_REALTIME_MODEL,
      providerLabel: 'Inworld',
      description:
        'Default Inworld Realtime LLM model. Live workspace catalogs load when INWORLD_API_KEY is configured.',
      builtinTools: ['hang_up'],
      functionCallingSupported: true,
      reasoningEfforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
      reasoningSupported: true,
      runtimeProvider: 'inworld',
    },
  ]
}

async function readInworldCodexAuthModelOptions(modelCatalog) {
  const configured = [
    process.env.INWORLD_CODEX_ROUTER_MODEL,
    ...(process.env.INWORLD_CODEX_ROUTER_MODELS || '')
      .split(',')
      .map((item) => item.trim()),
  ]
    .map((item) => stringValue(item))
    .map((item) => inworldCodexModelResource(item))
    .filter(Boolean)
  const codexModels = await readCodexAuthModelOptions().catch(() => [])
  const configuredModels = configured.map((value) => ({
    value,
    label: formatInworldCodexLabel(value),
  }))

  return buildInworldCodexAuthModelOptions(
    [...configuredModels, ...codexModels].filter(uniqueOptionValue),
    modelCatalog,
  ).sort((left, right) => left.label.localeCompare(right.label))
}

export function buildInworldCodexAuthModelOptions(codexModels = [], modelCatalog = []) {
  const catalogByResource = new Map(
    modelCatalog
      .filter((model) => model?.isSupported === true)
      .filter(
        (model) =>
          !SPEAK_REQUIRES_INWORLD_FUNCTION_TOOLS ||
          inworldModelSupportsFunctionCalling(model),
      )
      .filter(inworldModelSupportsTextSession)
      .map((model) => [inworldCatalogModelResource(model), model])
      .filter(([resource]) => Boolean(resource)),
  )

  return codexModels
    .map((option) => {
      const modelResource = inworldCodexModelResource(option?.value || option?.modelResource)
      const catalogModel = catalogByResource.get(modelResource)
      if (!modelResource || !catalogModel) return null
      return {
        value: modelResource,
        label: option.label || formatInworldCodexLabel(modelResource),
        description:
          `Codex-auth model selected for an Inworld Realtime profile as ${modelResource}.`,
        modelProvider: 'INWORLD_CODEX',
        modelResource,
        functionCallingSupported: inworldModelSupportsFunctionCalling(catalogModel),
        reasoningEfforts: inworldModelReasoningEfforts(catalogModel),
        reasoningSupported: inworldModelSupportsReasoning(catalogModel),
        runtimeProvider: 'inworld',
      }
    })
    .filter(Boolean)
    .filter(uniqueOptionValue)
}

export function resolveInworldReasoningEffort({
  model,
  requested,
  supportedEfforts,
  toolsEnabled,
} = {}) {
  const requestedEffort = stringValue(requested).toLowerCase()
  const allowed = Array.isArray(supportedEfforts)
    ? normalizeReasoningEffortList(supportedEfforts)
    : KNOWN_INWORLD_CODEX_REASONING_EFFORTS[stringValue(model)] || []
  if (toolsEnabled !== false) return allowed.includes('none') ? 'NONE' : ''
  return requestedEffort && allowed.includes(requestedEffort)
    ? requestedEffort.toUpperCase()
    : ''
}

function inworldModelReasoningEfforts(model) {
  const capabilities = model?.capabilities || model?.spec?.capabilities || {}
  const capability = capabilities.reasoningCapability
  if (capability?.supported === false || capabilities.reasoning === false) {
    return []
  }
  const levels = normalizeReasoningEffortList(capability?.supportedLevels)
  return levels
}

function inworldModelSupportsFunctionCalling(model) {
  const capabilities = model?.capabilities || model?.spec?.capabilities || {}
  return capabilities.functionCalling === true
}

function inworldModelSupportsReasoning(model) {
  const capabilities = model?.capabilities || model?.spec?.capabilities || {}
  const capability = capabilities.reasoningCapability
  return capability?.supported === true || capabilities.reasoning === true
}

function inworldModelSupportsTextSession(model) {
  const spec = model?.spec || {}
  return (
    inworldModalitiesIncludeText(spec.inputModalities) &&
    inworldModalitiesIncludeText(spec.outputModalities)
  )
}

function inworldModalitiesIncludeText(modalities) {
  if (!Array.isArray(modalities) || modalities.length === 0) return false
  return modalities.some((modality) => stringValue(modality).toLowerCase() === 'text')
}

function normalizeReasoningEffortList(value) {
  if (!Array.isArray(value)) return []
  return [
    ...new Set(
      value
        .map((effort) => stringValue(effort).toLowerCase().replace(/^effort_/, ''))
        .filter((effort) =>
          ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(effort),
        ),
    ),
  ]
}

function inworldCatalogModelResource(model) {
  const provider = stringValue(model?.provider || model?.modelProvider || model?.vendor)
  const name = stringValue(
    model?.model || model?.name || model?.id || model?.modelName || model?.modelId,
  )
  if (!name || !provider || name.startsWith(`${provider}/`)) return name
  return `${provider}/${name}`
}

function normalizeInworldRuntimeModelResource(value) {
  return stringValue(value).replace(/^INWORLD:/i, '')
}

const KNOWN_INWORLD_CODEX_REASONING_EFFORTS = Object.freeze({
  'openai/gpt-5.4': ['none', 'low', 'high', 'xhigh'],
  'openai/gpt-5.4-mini': ['none', 'low', 'medium', 'xhigh'],
  'openai/gpt-5.5': ['none', 'low', 'medium', 'high', 'xhigh'],
  'openai/gpt-5.6-luna': ['none', 'low', 'medium', 'high', 'xhigh'],
  'openai/gpt-5.6-sol': ['none', 'low', 'medium', 'high', 'xhigh'],
  'openai/gpt-5.6-terra': ['none', 'low', 'medium', 'high', 'xhigh'],
})

function inworldCodexModelResource(value) {
  const raw = stringValue(value)
  if (!raw) return ''
  if (raw.startsWith('openai/') || raw.startsWith('inworld/')) return raw
  if (/^gpt-/i.test(raw)) return `openai/${raw}`
  return ''
}

function formatInworldCodexLabel(value) {
  const model = stringValue(value)
  if (model.startsWith('inworld/')) {
    return model.replace(/^inworld\//, 'Inworld router / ')
  }

  return model
    .replace(/^openai\//, '')
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => {
      if (/^gpt$/i.test(part)) return 'GPT'
      return part.charAt(0).toUpperCase() + part.slice(1)
    })
    .join(' ')
}

function formatInworldProviderLabel(value) {
  const provider = stringValue(value).toLowerCase()
  if (!provider) return 'Inworld'
  if (provider === 'openai') return 'OpenAI via Inworld'
  if (provider === 'anthropic') return 'Anthropic via Inworld'
  if (provider === 'google-ai-studio') return 'Google AI Studio via Inworld'
  if (provider === 'google-vertex-ai') return 'Google Vertex AI via Inworld'
  if (provider === 'xai') return 'xAI via Inworld'
  if (provider === 'groq') return 'Groq via Inworld'
  if (provider === 'mistral') return 'Mistral via Inworld'
  if (provider === 'fireworks') return 'Fireworks via Inworld'
  if (provider === 'deepinfra') return 'DeepInfra via Inworld'
  if (provider === 'cerebras') return 'Cerebras via Inworld'
  return `${provider} via Inworld`
}

function normalizeInworldConfigName(value) {
  return stringValue(value).replace(/\s+/g, ' ').trim() || 'Inworld realtime agent'
}

function stableInworldConfigId(value) {
  const slug =
    stringValue(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'agent'
  return `inworld-${slug}`
}

function stringValue(value) {
  return String(value || '').trim()
}

function uniqueOptionValue(option, index, options) {
  return options.findIndex((candidate) => candidate?.value === option?.value) === index
}
