import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HUME_API_BASE, providerError, readJson } from './provider-http.mjs'
import {
  CODEX_AUTH_LANGUAGE_MODEL_PROVIDER,
  DEFAULT_CODEX_AUTH_MODEL,
  cleanObject,
  getCodexAuthModel,
  getCodexClmPublicUrl,
  isCodexAuthLanguageModel,
  normalizeCampaignConfig,
} from './runtime-config.mjs'
import { humeProviderNudgeIntervalSeconds } from './voice-provider-sync-policy.mjs'
import { readCodexAuthModelOptions } from './codex-clm.mjs'
import { speakFunctionTools } from './hume-tools.mjs'
import { getHumeApiKey } from './secrets.mjs'
import {
  buildRuntimeSystemPrompt,
  extractProfileInstructionsFromRuntimePrompt,
} from './session-prompt.mjs'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const codexPromptStorePath = path.resolve(
  __dirname,
  '..',
  'data',
  'codex-clm-prompts.json',
)
const HUME_NATIVE_MODELS_WITHOUT_SPEAK_TOOL_SUPPORT = new Set([
  'ANTHROPIC:claude-opus-4-6',
])

export class HumeConfigSyncError extends Error {
  constructor(status, message, provider) {
    super(message)
    this.name = 'HumeConfigSyncError'
    this.status = status
    this.provider = provider
  }
}

export async function readHumeAgentConfig(configId) {
  if (!getHumeApiKey()) {
    throw new HumeConfigSyncError(503, 'Speak voice provider API key is required to read configs.')
  }

  if (!configId) {
    throw new HumeConfigSyncError(400, 'A Speak config ID is required.')
  }

  const config = await fetchLatestHumeConfig(configId)
  return humeConfigSnapshot(config)
}

export async function readHumeConfigOptions() {
  if (!getHumeApiKey()) {
    throw new HumeConfigSyncError(503, 'Speak voice provider API key is required to read options.')
  }

  const [languageModels, customVoices, humeVoices, codexAuthModels] = await Promise.all([
    fetchHumeLanguageModels(),
    fetchHumeVoices('CUSTOM_VOICE'),
    fetchHumeVoices('HUME_AI'),
    readCodexAuthModelOptions(),
  ])

  return {
    eviVersions: [
      {
        value: '3',
        label: 'EVI 3',
        description:
          'Flagship expressive voice model with highest fidelity and full voice clone support.',
      },
      {
        value: '4-mini',
        label: 'EVI 4 Mini',
        description: 'Speak-supported lightweight voice version for lower-latency tests.',
      },
    ],
    codexAuthModels,
    languageModels,
    voices: [...customVoices, ...humeVoices],
    functionTools: speakFunctionTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
    })),
  }
}

export async function syncHumeAgentConfig({
  profileName,
  config,
  createNew,
  ownedUpdates = {},
}) {
  if (!getHumeApiKey()) {
    throw new HumeConfigSyncError(503, 'Speak voice provider API key is required to sync configs.')
  }

  const runtimeConfig = normalizeCampaignConfig(config)
  const codexAuthConfig = isCodexAuthLanguageModel(runtimeConfig)
  assertHumeNativeModelSupportsSpeakTools(runtimeConfig)
  const requestedName = normalizeHumeConfigName(
    profileName || runtimeConfig.agentProfileName,
  )
  const sourceConfigId = runtimeConfig.humeConfigId || process.env.HUME_CONFIG_ID
  let shouldCreate = Boolean(createNew)

  if (!sourceConfigId && !shouldCreate) {
    throw new HumeConfigSyncError(400, 'A source Speak config ID is required.')
  }

  let updates = normalizeOwnedUpdates(ownedUpdates, shouldCreate)
  if (updates.settings && codexAuthConfig && !getCodexClmPublicUrl()) {
    throw new HumeConfigSyncError(400, 'A public Codex CLM URL is required.')
  }

  let sourceConfig = null
  if (!shouldCreate && sourceConfigId) {
    try {
      sourceConfig = await fetchLatestHumeConfig(sourceConfigId)
    } catch (error) {
      if (error instanceof HumeConfigSyncError && error.status === 404) {
        shouldCreate = true
        updates = normalizeOwnedUpdates(ownedUpdates, true)
      } else {
        throw error
      }
    }
  }
  if (!sourceConfig) sourceConfig = humeConfigTemplate(requestedName, runtimeConfig)

  const sourceLanguageModel = sourceConfig.language_model || {}
  assertHumeNativeModelSupportsSpeakTools({
    ...runtimeConfig,
    languageModelProvider: updates.settings
      ? runtimeConfig.languageModelProvider || sourceLanguageModel.model_provider
      : sourceLanguageModel.model_provider,
    languageModelResource: updates.settings
      ? runtimeConfig.languageModelResource || sourceLanguageModel.model_resource
      : sourceLanguageModel.model_resource,
  })

  const resolvedRuntimeConfig =
    shouldCreate || updates.voice
      ? await withAvailableHumeVoice(runtimeConfig)
      : runtimeConfig
  const name =
    shouldCreate || updates.name
      ? requestedName
      : normalizeHumeConfigName(sourceConfig.name || requestedName)
  const toolRefs = codexAuthConfig ? undefined : await ensureSpeakHumeToolRefs()
  const supportedBuiltinTools = updates.settings && !codexAuthConfig
    ? await supportedBuiltinToolsForModel(resolvedRuntimeConfig)
    : null
  const versionBody = buildHumeConfigVersionBody(
    sourceConfig,
    resolvedRuntimeConfig,
    name,
    toolRefs,
    updates,
    supportedBuiltinTools,
  )

  if (shouldCreate) {
    const created = await createHumeConfig({
      ...versionBody,
      name,
      version_description: `Created from Speak profile ${name}.`,
    })

    return humeSyncResult('created', created, resolvedRuntimeConfig)
  }

  let action = 'unchanged'
  if (updates.name && sourceConfig.name !== name) {
    await updateHumeConfigName(sourceConfig.id, name)
    sourceConfig = { ...sourceConfig, name }
    action = 'renamed'
  }

  if (!humeConfigVersionMatches(sourceConfig, versionBody)) {
    const updated = await createHumeConfigVersion(sourceConfig.id, {
      ...versionBody,
      version_description: `Synced from Speak profile ${name}.`,
    })
    action = action === 'renamed' ? 'renamed-and-versioned' : 'versioned'
    sourceConfig = updated
  }

  return humeSyncResult(action, sourceConfig, resolvedRuntimeConfig)
}

function humeConfigTemplate(name, runtimeConfig) {
  return cleanObject({
    id: runtimeConfig.humeConfigId || '',
    name,
    version: runtimeConfig.humeConfigVersion || 0,
    evi_version: runtimeConfig.eviVersion || '3',
  })
}

async function fetchLatestHumeConfig(configId) {
  const params = new URLSearchParams({
    page_number: '0',
    page_size: '1',
    restrict_to_most_recent: 'true',
  })
  const payload = await humeRequest(`/evi/configs/${encodeURIComponent(configId)}?${params}`)
  const config = payload?.configs_page?.[0] || payload

  if (!config?.id) {
    throw new HumeConfigSyncError(404, 'Speak source config was not found.', payload)
  }

  return config
}

async function createHumeConfig(body) {
  return humeRequest('/evi/configs', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

async function createHumeConfigVersion(configId, body) {
  return humeRequest(`/evi/configs/${encodeURIComponent(configId)}`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

async function updateHumeConfigName(configId, name) {
  return humeRequest(`/evi/configs/${encodeURIComponent(configId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  })
}

async function humeRequest(path, options = {}) {
  const apiKey = getHumeApiKey()
  const response = await fetch(`${HUME_API_BASE}${path}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Hume-Api-Key': apiKey,
      ...(options.headers || {}),
    },
  })
  const payload = await readJson(response)

  if (!response.ok) {
    throw new HumeConfigSyncError(
      response.status,
      providerError('Speak config sync failed', payload),
      payload,
    )
  }

  return payload
}

async function fetchHumeLanguageModels() {
  const payload = await humeRequest('/evi/language_models')
  const models = Array.isArray(payload.language_models) ? payload.language_models : []

  return models
    .map((model) =>
      cleanObject({
        value: `${model.model_provider}:${model.model_resource}`,
        label:
          model.display_name ||
          model.simple_name ||
          formatLanguageModel({
            model_provider: model.model_provider,
            model_resource: model.model_resource,
          }),
        modelProvider: model.model_provider,
        modelResource: model.model_resource,
        providerLabel: model.provider_display_name || model.model_provider,
        description: model.description,
        costEstimate: Number.isFinite(Number(model.cost_estimate))
          ? Number(model.cost_estimate)
          : undefined,
        builtinTools: Array.isArray(model.builtin_tools)
          ? model.builtin_tools.filter(Boolean)
          : [],
        deprecated: Boolean(model.deprecation),
        deprecation: model.deprecation || undefined,
      }),
    )
    .filter((model) => model.modelProvider && model.modelResource)
    .filter(humeNativeModelSupportsSpeakTools)
}

function assertHumeNativeModelSupportsSpeakTools(runtimeConfig) {
  if (
    isCodexAuthLanguageModel(runtimeConfig) ||
    humeNativeModelSupportsSpeakTools(runtimeConfig)
  ) {
    return
  }

  throw new HumeConfigSyncError(
    409,
    'Selected Hume native language model does not support Speak tools.',
    'hume',
  )
}

function humeNativeModelSupportsSpeakTools(model = {}) {
  const provider = String(
    model.modelProvider || model.languageModelProvider || model.model_provider || '',
  ).trim()
  const resource = String(
    model.modelResource || model.languageModelResource || model.model_resource || '',
  ).trim()
  if (!provider || !resource) return true
  return !HUME_NATIVE_MODELS_WITHOUT_SPEAK_TOOL_SUPPORT.has(`${provider}:${resource}`)
}

async function fetchHumeVoices(provider) {
  const voices = []
  const seenPageNumbers = new Set()
  let pageNumber = 0
  let totalPages = null

  do {
    const params = new URLSearchParams({
      provider,
      page_number: String(pageNumber),
      page_size: '100',
    })
    const payload = await humeRequest(`/tts/voices?${params}`)
    const returnedPageNumber = Number(payload?.page_number)
    const returnedTotalPages = Number(payload?.total_pages)
    if (
      !Number.isInteger(returnedPageNumber) ||
      returnedPageNumber < 0 ||
      !Number.isInteger(returnedTotalPages) ||
      returnedTotalPages <= 0 ||
      returnedPageNumber >= returnedTotalPages ||
      (totalPages !== null && returnedTotalPages !== totalPages)
    ) {
      throw new HumeConfigSyncError(
        502,
        'Speak voice catalog returned invalid pagination metadata.',
        'hume',
      )
    }
    if (
      returnedPageNumber !== pageNumber ||
      seenPageNumbers.has(returnedPageNumber)
    ) {
      throw new HumeConfigSyncError(
        502,
        'Speak voice catalog repeated or returned an unexpected page.',
        'hume',
      )
    }
    seenPageNumbers.add(returnedPageNumber)
    const page = Array.isArray(payload.voices_page) ? payload.voices_page : []
    voices.push(...page)
    totalPages = returnedTotalPages
    pageNumber += 1
  } while (pageNumber < totalPages)

  return voices
    .map((voice) =>
      cleanObject({
        value: `${voice.provider || provider}:${voice.id || voice.name}`,
        id: voice.id,
        name: voice.name,
        label: voice.name,
        provider: voice.provider || provider,
        providerLabel:
          (voice.provider || provider) === 'HUME_AI' ? 'Speak library' : 'Custom voice',
        tags: voice.tags || undefined,
        compatibleOctaveModels: Array.isArray(voice.compatible_octave_models)
          ? voice.compatible_octave_models
          : undefined,
      }),
    )
    .filter((voice) => voice.value && voice.label)
}

async function withAvailableHumeVoice(runtimeConfig) {
  const [customVoices, libraryVoices] = await Promise.all([
    fetchHumeVoices('CUSTOM_VOICE'),
    fetchHumeVoices('HUME_AI'),
  ])
  const voices = [...customVoices, ...libraryVoices]
  const selectedVoice = String(runtimeConfig.voice || '').trim()
  const selectedProvider = String(runtimeConfig.humeVoiceProvider || '').trim()
  const matched = voices.find((voice) => {
    if (!selectedVoice) return false
    if (selectedProvider && voice.provider !== selectedProvider) return false
    return voice.id === selectedVoice || voice.name === selectedVoice
  })
  if (selectedVoice && !matched) {
    throw new HumeConfigSyncError(
      409,
      'Selected Speak voice is unavailable for the active API key.',
      'hume',
    )
  }
  const voice = matched || libraryVoices[0] || customVoices[0]

  if (!voice) {
    throw new HumeConfigSyncError(
      503,
      'No Hume voices are available for the active API key.',
    )
  }

  const resolvedVoice = matched || voice
  return normalizeCampaignConfig({
    ...runtimeConfig,
    voice: resolvedVoice.id || resolvedVoice.name || '',
    humeVoiceName:
      resolvedVoice.name ||
      resolvedVoice.label ||
      runtimeConfig.humeVoiceName ||
      resolvedVoice.id ||
      '',
    humeVoiceProvider: resolvedVoice.provider || runtimeConfig.humeVoiceProvider || 'HUME_AI',
  })
}

function buildHumeConfigVersionBody(
  sourceConfig,
  runtimeConfig,
  name,
  toolRefs,
  updates,
  supportedBuiltinTools,
) {
  const body = cleanObject({
    evi_version:
      updates.settings && runtimeConfig.eviVersion
        ? String(runtimeConfig.eviVersion)
        : String(sourceConfig.evi_version || '3'),
    builtin_tools: isCodexAuthLanguageModel(runtimeConfig)
      ? undefined
      : buildBuiltinTools(
          sourceConfig.builtin_tools,
          runtimeConfig,
          updates,
          supportedBuiltinTools,
        ),
    ellm_model: buildEllmModel(sourceConfig.ellm_model, runtimeConfig, updates),
    event_messages: buildEventMessages(
      sourceConfig.event_messages,
      runtimeConfig,
      updates,
    ),
    interruption: buildInterruption(sourceConfig.interruption, runtimeConfig, updates),
    language_model: buildLanguageModel(
      sourceConfig.language_model,
      runtimeConfig,
      updates,
    ),
    nudges: buildNudges(sourceConfig.nudges, runtimeConfig, updates),
    prompt: isCodexAuthLanguageModel(runtimeConfig)
      ? undefined
      : buildPromptSpec(sourceConfig.prompt, runtimeConfig, name, updates),
    timeouts: buildTimeouts(sourceConfig.timeouts, runtimeConfig, updates),
    tools: isCodexAuthLanguageModel(runtimeConfig) ? undefined : toolRefs,
    turn_detection: buildTurnDetection(
      sourceConfig.turn_detection,
      runtimeConfig,
      updates,
    ),
    voice: buildVoiceSpec(sourceConfig.voice, runtimeConfig, updates),
  })

  return body
}

function buildPromptSpec(sourcePrompt, runtimeConfig, name, updates) {
  const promptExpansion =
    updates.settings && runtimeConfig.promptExpansionEnabled !== undefined
      ? { enabled: Boolean(runtimeConfig.promptExpansionEnabled) }
      : cloneJson(sourcePrompt?.prompt_expansion)

  return cleanObject({
    name: `${name} prompt`,
    text: buildRuntimeSystemPrompt(runtimeConfig.instructions),
    prompt_expansion: promptExpansion,
  })
}

function buildVoiceSpec(sourceVoice = {}, runtimeConfig, updates = {}) {
  if (!updates.voice) {
    return normalizeVoiceSpec(sourceVoice)
  }

  const selectedVoice = String(runtimeConfig.voice || '').trim()
  const provider = runtimeConfig.humeVoiceProvider || sourceVoice.provider || 'CUSTOM_VOICE'

  if (selectedVoice && UUID_PATTERN.test(selectedVoice)) {
    return { id: selectedVoice, provider }
  }

  if (selectedVoice) {
    return { name: selectedVoice, provider }
  }

  return normalizeVoiceSpec(sourceVoice)
}

function normalizeVoiceSpec(sourceVoice = {}) {
  const provider = sourceVoice.provider || 'CUSTOM_VOICE'

  if (sourceVoice.id) return { id: sourceVoice.id, provider }
  if (sourceVoice.name) return { name: sourceVoice.name, provider }
  return undefined
}

function buildTurnDetection(sourceTurnDetection, runtimeConfig, updates) {
  if (!updates.settings) return cloneJson(sourceTurnDetection)
  if (runtimeConfig.turnDetectionEnabled === false) return undefined

  const source = cloneJson(sourceTurnDetection) || {}

  return cleanObject({
    ...source,
    end_of_turn_silence_ms: finiteOrUndefined(runtimeConfig.endOfTurnSilenceMs),
    speech_detection_threshold: finiteOrUndefined(runtimeConfig.speechDetectionThreshold),
    prefix_padding_ms: finiteOrUndefined(runtimeConfig.prefixPaddingMs),
  })
}

function buildInterruption(sourceInterruption, runtimeConfig, updates) {
  if (!updates.settings) return cloneJson(sourceInterruption)
  if (runtimeConfig.interruptionEnabled === false) return undefined

  const source = cloneJson(sourceInterruption) || {}

  return cleanObject({
    ...source,
    min_interruption_ms: finiteOrUndefined(runtimeConfig.minInterruptionMs),
  })
}

function buildEllmModel(sourceEllmModel, runtimeConfig, updates) {
  if (!updates.settings) return cloneJson(sourceEllmModel)
  const source = cloneJson(sourceEllmModel) || {}

  return cleanObject({
    ...source,
    allow_short_responses:
      runtimeConfig.allowShortResponses === undefined
        ? source.allow_short_responses
        : Boolean(runtimeConfig.allowShortResponses),
  })
}

function buildLanguageModel(sourceLanguageModel, runtimeConfig, updates) {
  if (!updates.settings) return cloneJson(sourceLanguageModel)
  const source = cloneJson(sourceLanguageModel) || {}
  const {
    custom_language_model_model: _customLanguageModelModel,
    ...sourceWithoutCustomLanguageModel
  } = source

  if (isCodexAuthLanguageModel(runtimeConfig)) {
    return cleanObject({
      ...sourceWithoutCustomLanguageModel,
      model_provider: CODEX_AUTH_LANGUAGE_MODEL_PROVIDER,
      model_resource: getCodexClmPublicUrl(),
      custom_language_model_model: getCodexAuthModel(runtimeConfig),
      temperature:
        runtimeConfig.languageModelTemperature === undefined
          ? source.temperature
          : finiteOrUndefined(runtimeConfig.languageModelTemperature),
    })
  }

  return cleanObject({
    ...sourceWithoutCustomLanguageModel,
    model_provider: runtimeConfig.languageModelProvider || source.model_provider,
    model_resource: runtimeConfig.languageModelResource || source.model_resource,
    temperature:
      runtimeConfig.languageModelTemperature === undefined
        ? source.temperature
        : finiteOrUndefined(runtimeConfig.languageModelTemperature),
  })
}

function buildNudges(sourceNudges, runtimeConfig, updates) {
  if (!updates.settings) return cloneJson(sourceNudges)
  const source = cloneJson(sourceNudges) || {}

  return cleanObject({
    ...source,
    enabled:
      runtimeConfig.nudgesEnabled === undefined
        ? source.enabled
        : Boolean(runtimeConfig.nudgesEnabled),
    interval_secs:
      runtimeConfig.nudgesIntervalSeconds === undefined
        ? source.interval_secs
        : humeProviderNudgeIntervalSeconds(runtimeConfig.nudgesIntervalSeconds),
  })
}

function buildTimeouts(sourceTimeouts, runtimeConfig, updates) {
  if (!updates.settings) return cloneJson(sourceTimeouts)
  const source = cloneJson(sourceTimeouts) || {}

  return cleanObject({
    ...source,
    inactivity: cleanObject({
      ...(source.inactivity || {}),
      enabled:
        runtimeConfig.inactivityTimeoutEnabled === undefined
          ? source.inactivity?.enabled
          : Boolean(runtimeConfig.inactivityTimeoutEnabled),
      duration_secs:
        runtimeConfig.inactivityTimeoutSeconds === undefined
          ? source.inactivity?.duration_secs
          : finiteOrUndefined(runtimeConfig.inactivityTimeoutSeconds),
    }),
    max_duration: cleanObject({
      ...(source.max_duration || {}),
      enabled:
        runtimeConfig.maxDurationTimeoutEnabled === undefined
          ? source.max_duration?.enabled
          : Boolean(runtimeConfig.maxDurationTimeoutEnabled),
      duration_secs:
        runtimeConfig.maxDurationTimeoutSeconds === undefined
          ? source.max_duration?.duration_secs
          : finiteOrUndefined(runtimeConfig.maxDurationTimeoutSeconds),
    }),
  })
}

function buildEventMessages(sourceEventMessages, runtimeConfig, updates) {
  if (!updates.settings) return cloneJson(sourceEventMessages)
  const source = cloneJson(sourceEventMessages) || {}

  return cleanObject({
    ...source,
    on_new_chat: buildEventMessage(source.on_new_chat, {
      enabled: runtimeConfig.eviStartsConversation,
    }),
    on_resume_chat: buildEventMessage(source.on_resume_chat, {
      enabled: runtimeConfig.resumeConversationMessageEnabled,
      text: runtimeConfig.resumeConversationMessage,
    }),
    on_inactivity_timeout: buildEventMessage(source.on_inactivity_timeout, {
      enabled: runtimeConfig.inactivityMessageEnabled,
      text: runtimeConfig.inactivityMessage,
    }),
    on_max_duration_timeout: buildEventMessage(source.on_max_duration_timeout, {
      enabled: runtimeConfig.maxDurationMessageEnabled,
      text: runtimeConfig.maxDurationMessage,
    }),
  })
}

function buildEventMessage(sourceMessage = {}, patch = {}) {
  return cleanObject({
    ...sourceMessage,
    enabled:
      patch.enabled === undefined ? sourceMessage.enabled : Boolean(patch.enabled),
    text:
      patch.text === undefined
        ? sourceMessage.text
        : String(patch.text || '').trim() || null,
  })
}

async function supportedBuiltinToolsForModel(runtimeConfig) {
  if (isCodexAuthLanguageModel(runtimeConfig)) return new Set()

  const provider = String(runtimeConfig.languageModelProvider || '').trim()
  const resource = String(runtimeConfig.languageModelResource || '').trim()
  if (!provider || !resource) return null

  const models = await fetchHumeLanguageModels()
  const selectedModel = models.find(
    (model) => model.modelProvider === provider && model.modelResource === resource,
  )
  if (!selectedModel) return null

  return new Set(selectedModel.builtinTools || [])
}

function buildBuiltinTools(
  sourceBuiltinTools,
  runtimeConfig,
  updates,
  supportedBuiltinTools,
) {
  if (!updates.settings) return cloneBuiltinTools(sourceBuiltinTools)

  const requestedTools = []
  if (runtimeConfig.webSearchEnabled) requestedTools.push('web_search')
  if (runtimeConfig.hangUpEnabled !== false) requestedTools.push('hang_up')

  return requestedTools
    .filter((name) => !supportedBuiltinTools || supportedBuiltinTools.has(name))
    .map((name) => ({ name }))
}

function cloneToolRefs(tools) {
  if (!Array.isArray(tools)) return undefined
  const refs = tools
    .map((tool) =>
      cleanObject({
        id: tool?.id,
        version: Number.isFinite(Number(tool?.version))
          ? Number(tool.version)
          : undefined,
      }),
    )
    .filter((tool) => tool.id)
    .sort((left, right) => {
      const idOrder = left.id.localeCompare(right.id)
      if (idOrder !== 0) return idOrder
      return Number(left.version || 0) - Number(right.version || 0)
    })
  return refs.length > 0 ? refs : []
}

function cloneBuiltinTools(tools) {
  if (!Array.isArray(tools)) return []
  const names = new Set()
  const refs = []

  for (const tool of tools) {
    if (!tool?.name || names.has(tool.name)) continue
    names.add(tool.name)
    refs.push({ name: tool.name })
  }

  return refs
}

async function ensureSpeakHumeToolRefs() {
  const refs = []
  for (const spec of speakFunctionTools) {
    const tool = await ensureHumeTool(spec)
    refs.push({ id: tool.id, version: tool.version })
  }
  return refs
}

async function ensureHumeTool(spec) {
  const existing = await fetchLatestHumeToolByName(spec.name)
  if (!existing) return createHumeTool(spec)

  if (humeToolMatches(existing, spec)) {
    return existing
  }

  return createHumeToolVersion(existing.id, spec)
}

async function fetchLatestHumeToolByName(name) {
  const params = new URLSearchParams({
    page_number: '0',
    page_size: '1',
    restrict_to_most_recent: 'true',
    name,
  })
  try {
    const payload = await humeRequest(`/evi/tools?${params}`)
    return payload?.tools_page?.[0] || null
  } catch (error) {
    if (error instanceof HumeConfigSyncError && error.status === 404) {
      return null
    }
    throw error
  }
}

async function createHumeTool(spec) {
  return humeRequest('/evi/tools', {
    method: 'POST',
    body: JSON.stringify(spec),
  })
}

async function createHumeToolVersion(toolId, spec) {
  return humeRequest(`/evi/tools/${encodeURIComponent(toolId)}`, {
    method: 'POST',
    body: JSON.stringify({
      parameters: spec.parameters,
      description: spec.description,
      fallback_content: spec.fallback_content,
      version_description: spec.version_description,
    }),
  })
}

function humeToolMatches(tool, spec) {
  return (
    normalizeToolParameters(tool.parameters) ===
      normalizeToolParameters(spec.parameters) &&
    String(tool.description || '') === spec.description &&
    String(tool.fallback_content || '') === spec.fallback_content
  )
}

function normalizeToolParameters(value) {
  try {
    return stableJson(sortForCompare(JSON.parse(String(value || '{}'))))
  } catch {
    return String(value || '')
  }
}

function humeConfigVersionMatches(config, desiredBody) {
  return stableJson(comparableHumeConfig(config)) === stableJson(comparableBody(desiredBody))
}

function comparableHumeConfig(config) {
  return comparableBody({
    evi_version: config.evi_version,
    builtin_tools: cloneBuiltinTools(config.builtin_tools),
    ellm_model: config.ellm_model,
    event_messages: config.event_messages,
    interruption: config.interruption,
    language_model: config.language_model,
    nudges: config.nudges,
    prompt: {
      name: config.prompt?.name,
      text: config.prompt?.text,
      prompt_expansion: config.prompt?.prompt_expansion,
    },
    timeouts: config.timeouts,
    tools: cloneToolRefs(config.tools),
    turn_detection: config.turn_detection,
    voice: normalizeVoiceSpec(config.voice),
  })
}

function comparableBody(body) {
  const comparable = stripEmpty(cloneJson(body))

  if (comparable?.prompt) {
    delete comparable.prompt.name
    if (Object.keys(comparable.prompt).length === 0) {
      delete comparable.prompt
    }
  }

  if (Array.isArray(comparable?.tools)) {
    comparable.tools = cloneToolRefs(comparable.tools)
    if (comparable.tools.length === 0) {
      delete comparable.tools
    }
  }

  if (Array.isArray(comparable?.builtin_tools) && comparable.builtin_tools.length === 0) {
    delete comparable.builtin_tools
  }

  return sortForCompare(comparable)
}

function stripEmpty(value) {
  if (Array.isArray(value)) return value.map(stripEmpty)
  if (!value || typeof value !== 'object') return value

  return Object.fromEntries(
    Object.entries(value)
      .map(([key, nestedValue]) => [key, stripEmpty(nestedValue)])
      .filter(([, nestedValue]) => nestedValue !== undefined && nestedValue !== null),
  )
}

function sortForCompare(value) {
  if (Array.isArray(value)) return value.map(sortForCompare)
  if (!value || typeof value !== 'object') return value

  return Object.keys(value)
    .sort()
    .reduce((sorted, key) => {
      sorted[key] = sortForCompare(value[key])
      return sorted
    }, {})
}

function stableJson(value) {
  return JSON.stringify(value)
}

function cloneJson(value) {
  if (value === undefined || value === null) return undefined
  return JSON.parse(JSON.stringify(value))
}

function normalizeHumeConfigName(value) {
  const name = String(value || '').replace(/\s+/g, ' ').trim()
  return name || 'Untitled Speak config'
}

function humeSyncResult(action, config, runtimeConfig) {
  persistCodexPrompt(config.id, runtimeConfig)

  return {
    ok: true,
    action,
    humeConfigId: config.id,
    humeConfigName: config.name,
    humeConfigVersion: config.version,
    config: campaignConfigFromHume(config),
  }
}

function humeConfigSnapshot(config) {
  return {
    ok: true,
    humeConfigId: config.id,
    humeConfigName: config.name,
    humeConfigVersion: config.version,
    config: campaignConfigFromHume(config),
  }
}

function campaignConfigFromHume(config) {
  const builtinToolNames = new Set(
    Array.isArray(config.builtin_tools)
      ? config.builtin_tools.map((tool) => tool?.name).filter(Boolean)
      : [],
  )
  const languageModel = config.language_model || {}
  const voice = config.voice || {}
  const eventMessages = config.event_messages || {}
  const codexAuthModel = String(
    languageModel.custom_language_model_model || DEFAULT_CODEX_AUTH_MODEL,
  )
  const codexClmUrl = getCodexClmPublicUrl()
  const languageModelResource = String(languageModel.model_resource || '')
  const isCodexAuth =
    String(languageModel.model_provider || '') === CODEX_AUTH_LANGUAGE_MODEL_PROVIDER &&
    Boolean(codexClmUrl) &&
    languageModelResource === codexClmUrl
  const codexPromptRecord = isCodexAuth
    ? readPersistedCodexPromptRecord(config.id)
    : null
  const codexPrompt = String(codexPromptRecord?.instructions || '')
  const profileInstructions = extractProfileInstructionsFromRuntimePrompt(
    isCodexAuth ? codexPrompt : config.prompt?.text,
  )

  return cleanObject({
    instructions: profileInstructions,
    eviVersion: String(config.evi_version || '3'),
    humeConfigId: String(config.id || ''),
    humeConfigVersion: finiteOrUndefined(config.version),
    humeConfigSyncedAt: new Date().toISOString(),
    voice: String(voice.id || voice.name || ''),
    humeVoiceName: String(voice.name || ''),
    humeVoiceProvider: String(voice.provider || ''),
    supplementalLlm: formatLanguageModel(languageModel),
    languageModelMode: isCodexAuth ? 'codex' : 'hume',
    languageModelProvider: String(languageModel.model_provider || ''),
    languageModelResource: String(languageModel.model_resource || ''),
    languageModelTemperature: finiteOrUndefined(languageModel.temperature),
    codexAuthModel: isCodexAuth ? codexAuthModel : undefined,
    allowShortResponses: Boolean(config.ellm_model?.allow_short_responses),
    promptExpansionEnabled: isCodexAuth
      ? Boolean(codexPromptRecord?.promptExpansionEnabled)
      : Boolean(config.prompt?.prompt_expansion?.enabled),
    inactivityTimeoutEnabled: Boolean(config.timeouts?.inactivity?.enabled),
    inactivityTimeoutSeconds: finiteOrUndefined(
      config.timeouts?.inactivity?.duration_secs,
    ),
    maxDurationTimeoutEnabled: Boolean(config.timeouts?.max_duration?.enabled),
    maxDurationTimeoutSeconds: finiteOrUndefined(
      config.timeouts?.max_duration?.duration_secs,
    ),
    turnDetectionEnabled: Boolean(config.turn_detection),
    endOfTurnSilenceMs: finiteOrUndefined(
      config.turn_detection?.end_of_turn_silence_ms,
    ),
    speechDetectionThreshold: finiteOrUndefined(
      config.turn_detection?.speech_detection_threshold,
    ),
    prefixPaddingMs: finiteOrUndefined(config.turn_detection?.prefix_padding_ms),
    interruptionEnabled: Boolean(config.interruption),
    minInterruptionMs: finiteOrUndefined(config.interruption?.min_interruption_ms),
    nudgesEnabled: Boolean(config.nudges?.enabled),
    nudgesIntervalSeconds: finiteOrUndefined(config.nudges?.interval_secs),
    eviStartsConversation: Boolean(eventMessages.on_new_chat?.enabled),
    resumeConversationMessageEnabled: Boolean(
      eventMessages.on_resume_chat?.enabled,
    ),
    resumeConversationMessage: String(eventMessages.on_resume_chat?.text || ''),
    inactivityMessageEnabled: Boolean(
      eventMessages.on_inactivity_timeout?.enabled,
    ),
    inactivityMessage: String(eventMessages.on_inactivity_timeout?.text || ''),
    maxDurationMessageEnabled: Boolean(
      eventMessages.on_max_duration_timeout?.enabled,
    ),
    maxDurationMessage: String(eventMessages.on_max_duration_timeout?.text || ''),
    webSearchEnabled: isCodexAuth ? false : builtinToolNames.has('web_search'),
    hangUpEnabled: isCodexAuth ? true : builtinToolNames.has('hang_up'),
    useConfigPrompt: true,
    useConfigTools: true,
  })
}

function readCodexPromptStore() {
  try {
    const parsed = JSON.parse(readFileSync(codexPromptStorePath, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeCodexPromptStore(store) {
  mkdirSync(path.dirname(codexPromptStorePath), { recursive: true })
  const tmpPath = `${codexPromptStorePath}.${process.pid}.tmp`
  writeFileSync(tmpPath, `${JSON.stringify(store, null, 2)}\n`)
  renameSync(tmpPath, codexPromptStorePath)
}

function readPersistedCodexPromptRecord(configId) {
  const record = readCodexPromptStore()[String(configId || '')]
  return record && typeof record === 'object' ? record : null
}

function persistCodexPrompt(configId, runtimeConfig) {
  if (!configId || !runtimeConfig || !isCodexAuthLanguageModel(runtimeConfig)) return

  const instructions = String(runtimeConfig.instructions || '').trim()
  const store = readCodexPromptStore()

  store[String(configId)] = {
    instructions,
    model: getCodexAuthModel(runtimeConfig),
    promptExpansionEnabled: Boolean(runtimeConfig.promptExpansionEnabled),
    updatedAt: new Date().toISOString(),
  }
  writeCodexPromptStore(store)
}

function normalizeOwnedUpdates(ownedUpdates, createNew) {
  const arrayUpdates = Array.isArray(ownedUpdates)
    ? new Set(ownedUpdates.map((value) => String(value || '').trim()).filter(Boolean))
    : null
  const hasUpdate = (key) =>
    arrayUpdates ? arrayUpdates.has(key) : Boolean(ownedUpdates?.[key])

  return {
    name: createNew || hasUpdate('name'),
    prompt: createNew || hasUpdate('prompt'),
    settings: createNew || hasUpdate('settings'),
    voice: createNew || hasUpdate('voice'),
  }
}

function finiteOrUndefined(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function formatLanguageModel(languageModel = {}) {
  const provider = String(languageModel.model_provider || '').trim()
  const resource = String(languageModel.model_resource || '').trim()
  const customModel = String(languageModel.custom_language_model_model || '').trim()

  if (provider === CODEX_AUTH_LANGUAGE_MODEL_PROVIDER) {
    return `Codex Auth ${formatModelName(customModel || DEFAULT_CODEX_AUTH_MODEL)}`
  }

  if (!resource) return provider

  if (resource === 'claude-sonnet-4-6') return 'Claude Sonnet 4.6'
  if (resource === 'claude-sonnet-4-20250514') return 'Claude Sonnet 4'
  if (resource === 'hume-evi-3') return 'Speak EVI 3'
  if (resource === 'hume-evi-3-websearch') return 'Speak EVI 3 with Web Search'

  return formatModelName(resource)
}

function formatModelName(value) {
  return String(value || '')
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => {
      if (/^gpt$/i.test(part)) return 'GPT'
      return part.charAt(0).toUpperCase() + part.slice(1)
    })
    .join(' ')
}
