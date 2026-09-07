import { execFile, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { getHumeApiKey, getInworldApiKey, getXaiApiKey } from './secrets.mjs'

export const DEFAULT_SAMPLE_RATE = 16000
export const DEFAULT_CODEC = 'L16'
export const DEFAULT_END_OF_TURN_SILENCE_MS = 500
export const DEFAULT_SPEECH_DETECTION_THRESHOLD = 0.58
export const DEFAULT_PREFIX_PADDING_MS = 300
export const DEFAULT_MIN_INTERRUPTION_MS = 550
export const LEGACY_DEFAULT_END_OF_TURN_SILENCE_MS = 650
export const LEGACY_DEFAULT_SPEECH_DETECTION_THRESHOLD = 0.55
export const LEGACY_DEFAULT_MIN_INTERRUPTION_MS = 250
export const DEFAULT_PHONE_OUTPUT_GAIN = 0.72
export const DEFAULT_PHONE_OUTPUT_PEAK = 0.58
export const DEFAULT_CODEX_AUTH_MODEL = 'gpt-5.5'
export const DEFAULT_CODEX_REASONING_EFFORT = 'none'
export const DEFAULT_CODEX_FAST_MODE = true
export const CODEX_AUTH_LANGUAGE_MODEL_PROVIDER = 'CUSTOM_LANGUAGE_MODEL'
export const VOICE_RUNTIME_HUME = 'hume'
export const VOICE_RUNTIME_INWORLD = 'inworld'
export const VOICE_RUNTIME_XAI = 'xai'
export const DIALER_PROVIDER_SPEAK = 'speak'
export const DIALER_PROVIDER_CALLTOOLS = 'calltools'
export const DEFAULT_INWORLD_CONFIG_ID = 'inworld-realtime'
export const DEFAULT_INWORLD_REALTIME_MODEL = 'google-ai-studio/gemini-2.5-flash'
export const DEFAULT_INWORLD_STT_MODEL = 'inworld/inworld-stt-1'
export const DEFAULT_INWORLD_TTS_MODEL = 'inworld-tts-2'
export const DEFAULT_INWORLD_VOICE = 'Dennis'
export const DEFAULT_INWORLD_OUTPUT_SAMPLE_RATE = 16000
export const DEFAULT_XAI_CONFIG_ID = 'xai-realtime'
export const DEFAULT_XAI_REALTIME_MODEL = 'grok-voice-latest'
export const DEFAULT_XAI_VOICE = 'eve'
export const DEFAULT_XAI_REASONING_EFFORT = 'none'
export const DEFAULT_XAI_OUTPUT_SAMPLE_RATE = 16000
const DEFAULT_SPEAK_LINK_URL = ''

const DEFAULT_WORKSPACE_EMAIL_ACCOUNT = 'operator@example.com'
const DEFAULT_GOG_WRAPPER = '/usr/local/bin/split-speak-gog'
const execFileAsync = promisify(execFile)
const workspaceEmailAuthCache = new Map()
const workspaceEmailSendAsCache = new Map()

export function stripBasePathFromPathname(value, basePath = normalizedBasePath()) {
  if (!basePath || value === basePath) return value === basePath ? '/' : value
  if (value.startsWith(`${basePath}/`)) {
    return value.slice(basePath.length) || '/'
  }
  return value
}

export function normalizeBasePath(value) {
  if (!value || value === '/') return ''
  return `/${value.replace(/^\/+|\/+$/g, '')}`
}

export function normalizeTelnyxStreamCodec(value) {
  const codec = String(value || '').trim().toUpperCase()
  return codec === 'PCMU' ? 'PCMU' : 'L16'
}

export function sampleRateForTelnyxStreamCodec(value) {
  return normalizeTelnyxStreamCodec(value) === 'PCMU' ? 8000 : 16000
}

export function normalizeInworldTtsModel(_value) {
  return DEFAULT_INWORLD_TTS_MODEL
}

export function normalizeCodexReasoningEffort(value) {
  const effort = stringConfig(value).toLowerCase()
  return ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(effort)
    ? effort
    : ''
}

export function normalizeCodexReasoningEfforts(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map(normalizeCodexReasoningEffort).filter(Boolean))]
}

export function normalizeAudioSampleRate(_value, codec) {
  return sampleRateForTelnyxStreamCodec(codec)
}

export function normalizeVoiceRuntimeProvider(value) {
  const provider = stringConfig(value).toLowerCase()
  if (provider === VOICE_RUNTIME_XAI) return VOICE_RUNTIME_XAI
  return provider === VOICE_RUNTIME_INWORLD ? VOICE_RUNTIME_INWORLD : VOICE_RUNTIME_HUME
}

export function normalizeDialerProvider(value) {
  const provider = stringConfig(value).toLowerCase()
  return provider === DIALER_PROVIDER_CALLTOOLS
    ? DIALER_PROVIDER_CALLTOOLS
    : DIALER_PROVIDER_SPEAK
}

export function normalizeContactSource(value) {
  const source = stringConfig(value).toLowerCase()
  if (source === 'personal_phone' || source === 'personal phone') return 'personal-phone'
  if (source === 'personal-phone' || source === 'calltools') return source
  return ''
}

export function normalizePersonalPhoneInboundConfig(value = {}) {
  const source = value && typeof value === 'object' ? value : {}
  return {
    enabled: Boolean(source.enabled),
    eligibilityScope:
      stringConfig(source.eligibilityScope).toLowerCase() === 'source'
        ? 'source'
        : 'selected',
    sourceId: stringConfig(source.sourceId),
    contactIds: normalizeIdList(source.contactIds, 100),
    smartViewIds: normalizeIdList(source.smartViewIds, 50),
  }
}

export function normalizeCallToolsAgentBinding(value = {}) {
  const source = value && typeof value === 'object' ? value : {}
  const provisioningStatus = [
    'linked',
    'ready',
    'blocked',
    'unconfigured',
  ].includes(source.provisioningStatus)
    ? source.provisioningStatus
    : 'unconfigured'
  const mediaGatewayStatus = [
    'registered',
    'configured',
    'unverified',
    'verified',
    'failed',
    'unconfigured',
  ].includes(source.mediaGatewayStatus)
    ? source.mediaGatewayStatus
    : 'unconfigured'

  return cleanObject({
    enabled: Boolean(source.enabled),
    mode: 'phone_as_agent',
    appUserId: stringConfig(source.appUserId || source.userId),
    userId: stringConfig(source.userId || source.appUserId),
    phoneId: stringConfig(source.phoneId),
    phoneSipUri: stringConfig(source.phoneSipUri),
    phoneWebSocketUrl: stringConfig(source.phoneWebSocketUrl),
    webCallbackId: stringConfig(source.webCallbackId || source.web_call_back),
    queueId: stringConfig(source.queueId),
    campaignId: stringConfig(source.campaignId),
    callerIdId: stringConfig(source.callerIdId),
    callerIdStrategyId: stringConfig(source.callerIdStrategyId),
    liveFilterId: stringConfig(source.liveFilterId),
    bucketId: stringConfig(source.bucketId),
    contactMatchMode: 'calltools_contact_id_then_phone',
    provisioningStatus,
    mediaGatewayStatus,
    lastVerifiedAt: stringConfig(source.lastVerifiedAt),
  })
}

export function isCallToolsDialer(config = {}) {
  return normalizeDialerProvider(config.dialerProvider) === DIALER_PROVIDER_CALLTOOLS
}

export function isInworldRuntime(config = {}) {
  const requestedMode = stringConfig(config.languageModelMode).toLowerCase()
  return (
    normalizeVoiceRuntimeProvider(
      config.voiceRuntimeProvider ||
        config.runtimeProvider ||
        config.voiceProvider ||
        (requestedMode === VOICE_RUNTIME_INWORLD ? VOICE_RUNTIME_INWORLD : ''),
    ) === VOICE_RUNTIME_INWORLD
  )
}

export function isXaiRuntime(config = {}) {
  const requestedMode = stringConfig(config.languageModelMode).toLowerCase()
  return (
    normalizeVoiceRuntimeProvider(
      config.voiceRuntimeProvider ||
        config.runtimeProvider ||
        config.voiceProvider ||
        (requestedMode === VOICE_RUNTIME_XAI ? VOICE_RUNTIME_XAI : ''),
    ) === VOICE_RUNTIME_XAI
  )
}

export function normalizeCampaignConfig(config = {}) {
  const requestedLanguageModelMode = stringConfig(config.languageModelMode).toLowerCase()
  const dialerProvider = normalizeDialerProvider(
    config.dialerProvider || process.env.DIALER_PROVIDER,
  )
  const calltoolsAgentBinding = normalizeCallToolsAgentBinding(config.calltoolsAgentBinding)
  const voiceRuntimeProvider = normalizeVoiceRuntimeProvider(
    config.voiceRuntimeProvider ||
      config.runtimeProvider ||
      config.voiceProvider ||
      process.env.VOICE_RUNTIME_PROVIDER ||
      ([VOICE_RUNTIME_INWORLD, VOICE_RUNTIME_XAI].includes(requestedLanguageModelMode)
        ? requestedLanguageModelMode
        : ''),
  )
  const inworldRuntime = voiceRuntimeProvider === VOICE_RUNTIME_INWORLD
  const xaiRuntime = voiceRuntimeProvider === VOICE_RUNTIME_XAI
  const codexAuthConfig = !xaiRuntime && isCodexAuthLanguageModel(config)
  const inworldCodexModel = getInworldCodexRouterModel(config)
  const hasUnmarkedLegacyPhoneTransport =
    config.phoneAudioMode === undefined &&
    (normalizeTelnyxStreamCodec(config.telnyxStreamCodec) === 'PCMU' ||
      Number(config.sampleRate) === 8000)
  const profileCodec =
    config.phoneAudioMode === 'legacy'
      ? config.telnyxStreamCodec || config.phoneStreamCodec
      : hasUnmarkedLegacyPhoneTransport ||
          config.telnyxStreamCodec === 'PCMU' ||
          config.phoneStreamCodec === 'PCMU'
        ? DEFAULT_CODEC
        : config.telnyxStreamCodec || config.phoneStreamCodec
  const forcedTelnyxStreamCodec = boolEnv('TELNYX_STREAM_CODEC_FORCE', false)
    ? process.env.TELNYX_STREAM_CODEC
    : ''
  const telnyxStreamCodec = normalizeTelnyxStreamCodec(
    forcedTelnyxStreamCodec || profileCodec || process.env.TELNYX_STREAM_CODEC || DEFAULT_CODEC,
  )
  const sampleRate = normalizeAudioSampleRate(
    process.env.HUME_AUDIO_SAMPLE_RATE || config.sampleRate || DEFAULT_SAMPLE_RATE,
    telnyxStreamCodec,
  )
  const configEndOfTurnSilenceMs =
    hasUnmarkedLegacyPhoneTransport && Number(config.endOfTurnSilenceMs) === 800
      ? DEFAULT_END_OF_TURN_SILENCE_MS
      : config.endOfTurnSilenceMs
  const configSpeechDetectionThreshold =
    hasUnmarkedLegacyPhoneTransport && Number(config.speechDetectionThreshold) === 0.5
      ? DEFAULT_SPEECH_DETECTION_THRESHOLD
      : config.speechDetectionThreshold
  const configMinInterruptionMs =
    hasUnmarkedLegacyPhoneTransport && Number(config.minInterruptionMs) === 800
      ? DEFAULT_MIN_INTERRUPTION_MS
      : config.minInterruptionMs
  const normalizedConfigEndOfTurnSilenceMs =
    Number(configEndOfTurnSilenceMs) === LEGACY_DEFAULT_END_OF_TURN_SILENCE_MS
      ? undefined
      : configEndOfTurnSilenceMs
  const normalizedConfigSpeechDetectionThreshold =
    Number(configSpeechDetectionThreshold) ===
    LEGACY_DEFAULT_SPEECH_DETECTION_THRESHOLD
      ? undefined
      : configSpeechDetectionThreshold
  const normalizedConfigMinInterruptionMs =
    Number(configMinInterruptionMs) === LEGACY_DEFAULT_MIN_INTERRUPTION_MS
      ? undefined
      : configMinInterruptionMs
  const normalizedCodexReasoningEffort = normalizeCodexReasoningEffort(
    config.codexReasoningEffort,
  )
  const configuredCodexFastMode =
    typeof config.codexFastMode === 'string' && !config.codexFastMode.trim()
      ? undefined
      : optionalBoolean(config.codexFastMode)
  const codexReasoningEffort = codexAuthConfig
    ? normalizedCodexReasoningEffort || DEFAULT_CODEX_REASONING_EFFORT
    : normalizedCodexReasoningEffort
  const codexFastMode = codexAuthConfig
    ? configuredCodexFastMode ?? DEFAULT_CODEX_FAST_MODE
    : configuredCodexFastMode
  const requestedInworldTtsConversationalEnabled = boolConfig(
    config.inworldTtsConversationalEnabled,
    'INWORLD_TTS_CONVERSATIONAL_ENABLED',
    false,
  )
  const inworldTtsConversationalEnabled =
    inworldRuntime && codexAuthConfig && codexFastMode === true
      ? false
      : requestedInworldTtsConversationalEnabled
  return {
    instructions: stringConfig(config.instructions),
    agentProfileId: stringConfig(config.agentProfileId),
    agentProfileName: stringConfig(config.agentProfileName),
    agentProfileUpdatedAt: stringConfig(config.agentProfileUpdatedAt),
    contactSource: normalizeContactSource(config.contactSource),
    contactSourceId: stringConfig(config.contactSourceId),
    smartViewId: stringConfig(config.smartViewId),
    personalPhoneInbound: normalizePersonalPhoneInboundConfig(
      config.personalPhoneInbound,
    ),
    dialerProvider,
    calltoolsAgentBinding,
    voiceRuntimeProvider,
    eviVersion: stringConfig(
      config.eviVersion ||
        (inworldRuntime
          ? DEFAULT_INWORLD_CONFIG_ID
          : xaiRuntime
            ? DEFAULT_XAI_CONFIG_ID
            : '3'),
    ),
    speakConfigId:
      config.speakConfigId ||
      (xaiRuntime
        ? config.xaiConfigId || DEFAULT_XAI_CONFIG_ID
        : inworldRuntime
        ? config.inworldConfigId || process.env.INWORLD_CONFIG_ID || DEFAULT_INWORLD_CONFIG_ID
        : config.humeConfigId || process.env.HUME_CONFIG_ID),
    humeConfigId: config.humeConfigId || config.speakConfigId || process.env.HUME_CONFIG_ID,
    humeConfigVersion: optionalNumber(
      config.humeConfigVersion ?? config.speakConfigVersion,
    ),
    humeConfigSyncedAt: stringConfig(config.humeConfigSyncedAt || config.speakConfigSyncedAt),
    inworldConfigId: stringConfig(
      config.inworldConfigId ||
        (inworldRuntime ? config.speakConfigId : '') ||
        process.env.INWORLD_CONFIG_ID ||
        DEFAULT_INWORLD_CONFIG_ID,
    ),
    inworldConfigSyncedAt: stringConfig(
      config.inworldConfigSyncedAt || config.speakConfigSyncedAt,
    ),
    xaiConfigId: stringConfig(
      config.xaiConfigId ||
        (xaiRuntime ? config.speakConfigId : '') ||
        DEFAULT_XAI_CONFIG_ID,
    ),
    xaiConfigVersion: optionalNumber(
      config.xaiConfigVersion ?? (xaiRuntime ? config.speakConfigVersion : undefined),
    ),
    xaiConfigSyncedAt: stringConfig(
      config.xaiConfigSyncedAt || (xaiRuntime ? config.speakConfigSyncedAt : ''),
    ),
    voice:
      (xaiRuntime
        ? config.xaiVoiceId
        : inworldRuntime
          ? config.inworldVoiceId
          : config.humeVoiceId) ||
      config.voice ||
      (xaiRuntime
        ? process.env.XAI_VOICE_ID || DEFAULT_XAI_VOICE
        : inworldRuntime
        ? process.env.INWORLD_VOICE_ID || DEFAULT_INWORLD_VOICE
        : process.env.HUME_VOICE_ID || ''),
    humeVoiceName: stringConfig(config.humeVoiceName || config.speakVoiceName),
    humeVoiceId: stringConfig(config.humeVoiceId),
    humeVoiceProvider: normalizeVoiceProviderAlias(
      config.humeVoiceProvider || config.speakVoiceProvider,
    ),
    inworldVoiceName: stringConfig(config.inworldVoiceName || config.speakVoiceName),
    inworldVoiceId: stringConfig(config.inworldVoiceId),
    inworldVoiceProvider: stringConfig(config.inworldVoiceProvider || 'INWORLD_SYSTEM'),
    xaiVoiceName: stringConfig(config.xaiVoiceName || config.speakVoiceName),
    xaiVoiceId: stringConfig(config.xaiVoiceId),
    xaiVoiceProvider: stringConfig(config.xaiVoiceProvider || 'XAI_BUILTIN'),
    supplementalLlm: config.supplementalLlm || '',
    languageModelMode: codexAuthConfig
      ? 'codex'
      : inworldRuntime
        ? VOICE_RUNTIME_INWORLD
        : xaiRuntime
          ? VOICE_RUNTIME_XAI
        : VOICE_RUNTIME_HUME,
    languageModelProvider: xaiRuntime
      ? 'XAI_VOICE'
      : inworldRuntime
      ? stringConfig(
          codexAuthConfig
            ? config.languageModelProvider || 'INWORLD_CODEX'
            : config.languageModelProvider || 'INWORLD',
        )
      : stringConfig(config.languageModelProvider),
    languageModelResource: xaiRuntime
      ? stringConfig(
          config.xaiRealtimeModel ||
            config.languageModelResource ||
            process.env.XAI_REALTIME_MODEL ||
            DEFAULT_XAI_REALTIME_MODEL,
        )
      : inworldRuntime
      ? stringConfig(
          (codexAuthConfig ? inworldCodexModel : '') ||
            config.languageModelResource ||
            config.inworldRealtimeModel ||
            process.env.INWORLD_REALTIME_MODEL ||
            DEFAULT_INWORLD_REALTIME_MODEL,
        )
      : stringConfig(config.languageModelResource),
    languageModelTemperature: optionalNumber(config.languageModelTemperature),
    codexAuthModel: stringConfig(
      config.codexAuthModel ||
        process.env.CODEX_CLM_DEFAULT_MODEL ||
        DEFAULT_CODEX_AUTH_MODEL,
    ),
    codexReasoningEffort,
    inworldReasoningEfforts: normalizeCodexReasoningEfforts(
      config.inworldReasoningEfforts,
    ),
    inworldReasoningSupported: optionalBoolean(config.inworldReasoningSupported),
    codexFastMode,
    allowShortResponses: optionalBoolean(config.allowShortResponses),
    promptExpansionEnabled: optionalBoolean(config.promptExpansionEnabled),
    inactivityTimeoutEnabled: optionalBoolean(config.inactivityTimeoutEnabled),
    inactivityTimeoutSeconds: optionalNumber(config.inactivityTimeoutSeconds),
    maxDurationTimeoutEnabled: optionalBoolean(config.maxDurationTimeoutEnabled),
    maxDurationTimeoutSeconds: optionalNumber(config.maxDurationTimeoutSeconds),
    turnDetectionEnabled: optionalBoolean(config.turnDetectionEnabled),
    endOfTurnSilenceMs: Number(
      normalizedConfigEndOfTurnSilenceMs ??
        numberEnv('HUME_END_OF_TURN_SILENCE_MS', undefined) ??
        DEFAULT_END_OF_TURN_SILENCE_MS,
    ),
    speechDetectionThreshold: Number(
      normalizedConfigSpeechDetectionThreshold ??
        numberEnv('HUME_SPEECH_DETECTION_THRESHOLD', undefined) ??
        DEFAULT_SPEECH_DETECTION_THRESHOLD,
    ),
    prefixPaddingMs: Number(
      config.prefixPaddingMs ??
        numberEnv('HUME_PREFIX_PADDING_MS', undefined) ??
        DEFAULT_PREFIX_PADDING_MS,
    ),
    interruptionEnabled: optionalBoolean(config.interruptionEnabled),
    minInterruptionMs: Number(
      normalizedConfigMinInterruptionMs ??
        numberEnv('HUME_MIN_INTERRUPTION_MS', undefined) ??
        DEFAULT_MIN_INTERRUPTION_MS,
    ),
    nudgesEnabled: optionalBoolean(config.nudgesEnabled),
    nudgesIntervalSeconds: optionalNumber(config.nudgesIntervalSeconds),
    eviStartsConversation: optionalBoolean(config.eviStartsConversation),
    resumeConversationMessageEnabled: optionalBoolean(
      config.resumeConversationMessageEnabled,
    ),
    resumeConversationMessage: stringConfig(config.resumeConversationMessage),
    inactivityMessageEnabled: optionalBoolean(config.inactivityMessageEnabled),
    inactivityMessage: stringConfig(config.inactivityMessage),
    maxDurationMessageEnabled: optionalBoolean(config.maxDurationMessageEnabled),
    maxDurationMessage: stringConfig(config.maxDurationMessage),
    webSearchEnabled: optionalBoolean(config.webSearchEnabled),
    hangUpEnabled: optionalBoolean(config.hangUpEnabled),
    inworldRealtimeModel: stringConfig(
      (inworldRuntime && codexAuthConfig ? inworldCodexModel : '') ||
        config.inworldRealtimeModel ||
        (inworldRuntime ? config.languageModelResource : '') ||
        process.env.INWORLD_REALTIME_MODEL ||
        DEFAULT_INWORLD_REALTIME_MODEL,
    ),
    inworldFallbackRealtimeModel: stringConfig(
      config.inworldFallbackRealtimeModel ||
        process.env.INWORLD_FALLBACK_REALTIME_MODEL ||
        DEFAULT_INWORLD_REALTIME_MODEL,
    ),
    inworldSttModel: stringConfig(
      config.inworldSttModel ||
        process.env.INWORLD_STT_MODEL ||
        DEFAULT_INWORLD_STT_MODEL,
    ),
    inworldTtsModel: normalizeInworldTtsModel(
      config.inworldTtsModel || process.env.INWORLD_TTS_MODEL,
    ),
    inworldLanguage: stringConfig(
      config.inworldLanguage || process.env.INWORLD_LANGUAGE || 'en-US',
    ),
    inworldSttEndOfTurnConfidenceThreshold: optionalNumber(
      config.inworldSttEndOfTurnConfidenceThreshold ??
        numberEnv('INWORLD_STT_END_OF_TURN_CONFIDENCE_THRESHOLD', undefined),
    ),
    inworldSttMinEndOfTurnSilenceMs: optionalNumber(
      config.inworldSttMinEndOfTurnSilenceMs ??
        numberEnv('INWORLD_STT_MIN_END_OF_TURN_SILENCE_MS', undefined),
    ),
    inworldSttMaxTurnSilenceMs: optionalNumber(
      config.inworldSttMaxTurnSilenceMs ??
        numberEnv('INWORLD_STT_MAX_TURN_SILENCE_MS', undefined),
    ),
    inworldSttVadThreshold: optionalNumber(
      config.inworldSttVadThreshold ??
        numberEnv('INWORLD_STT_VAD_THRESHOLD', undefined),
    ),
    inworldTurnDetectionMode: stringConfig(
      config.inworldTurnDetectionMode || process.env.INWORLD_TURN_DETECTION || 'semantic_vad',
    ),
    inworldTurnEagerness: stringConfig(
      config.inworldTurnEagerness || process.env.INWORLD_TURN_EAGERNESS || 'high',
    ),
    inworldTtsDeliveryMode: stringConfig(
      config.inworldTtsDeliveryMode || process.env.INWORLD_TTS_DELIVERY_MODE || 'CREATIVE',
    ),
    inworldTtsSegmenterStrategy: stringConfig(
      config.inworldTtsSegmenterStrategy ||
        process.env.INWORLD_TTS_SEGMENTER_STRATEGY ||
        'full_turn',
    ),
    inworldTtsSteeringHandling: stringConfig(
      config.inworldTtsSteeringHandling ||
        process.env.INWORLD_TTS_STEERING_HANDLING ||
        'emit_once',
    ),
    inworldTtsConversationalEnabled,
    inworldTtsUserTurnMode: stringConfig(
      config.inworldTtsUserTurnMode ||
        process.env.INWORLD_TTS_USER_TURN_MODE ||
        'both',
    ),
    inworldVoiceSteeringEnabled: boolConfig(
      config.inworldVoiceSteeringEnabled,
      'INWORLD_VOICE_STEERING_ENABLED',
      true,
    ),
    inworldVoiceProfileEnabled: boolConfig(
      config.inworldVoiceProfileEnabled,
      'INWORLD_VOICE_PROFILE_ENABLED',
      true,
    ),
    inworldResponsivenessInitialWaitMs: numberEnv(
      'INWORLD_RESPONSIVENESS_INITIAL_WAIT_MS',
      numberConfig(config.inworldResponsivenessInitialWaitMs, 600),
    ),
    inworldResponsivenessHardDeadlineMs: numberEnv(
      'INWORLD_RESPONSIVENESS_HARD_DEADLINE_MS',
      numberConfig(config.inworldResponsivenessHardDeadlineMs, 1200),
    ),
    inworldBackchannelEnabled: boolConfig(
      config.inworldBackchannelEnabled,
      'INWORLD_BACKCHANNEL_ENABLED',
      false,
    ),
    inworldResponsivenessEnabled: boolConfig(
      config.inworldResponsivenessEnabled,
      'INWORLD_RESPONSIVENESS_ENABLED',
      false,
    ),
    inworldMemoryEnabled: boolConfig(
      config.inworldMemoryEnabled,
      'INWORLD_MEMORY_ENABLED',
      false,
    ),
    inworldToolCallingEnabled: boolConfig(
      config.inworldToolCallingEnabled,
      'INWORLD_TOOL_CALLING_ENABLED',
      true,
    ),
    inworldOutputSampleRate: numberEnv(
      'INWORLD_OUTPUT_SAMPLE_RATE',
      numberConfig(config.inworldOutputSampleRate, DEFAULT_INWORLD_OUTPUT_SAMPLE_RATE),
    ),
    xaiRealtimeModel: stringConfig(
      config.xaiRealtimeModel ||
        (xaiRuntime ? config.languageModelResource : '') ||
        process.env.XAI_REALTIME_MODEL ||
        DEFAULT_XAI_REALTIME_MODEL,
    ),
    xaiReasoningEffort:
      stringConfig(config.xaiReasoningEffort || process.env.XAI_REASONING_EFFORT).toLowerCase() ===
      'high'
        ? 'high'
        : DEFAULT_XAI_REASONING_EFFORT,
    xaiLanguageHint: stringConfig(
      config.xaiLanguageHint || process.env.XAI_LANGUAGE_HINT || 'en',
    ),
    xaiKeyterms: [...new Set(
      (Array.isArray(config.xaiKeyterms)
        ? config.xaiKeyterms
        : String(config.xaiKeyterms || process.env.XAI_KEYTERMS || '').split(','))
        .map((value) => stringConfig(value))
        .filter(Boolean),
    )].slice(0, 100),
    xaiVoiceSpeed: Math.min(
      1.5,
      Math.max(0.7, numberConfig(config.xaiVoiceSpeed, numberEnv('XAI_VOICE_SPEED', 1))),
    ),
    xaiResumptionEnabled: boolConfig(
      config.xaiResumptionEnabled,
      'XAI_RESUMPTION_ENABLED',
      true,
    ),
    xaiToolCallingEnabled: boolConfig(
      config.xaiToolCallingEnabled,
      'XAI_TOOL_CALLING_ENABLED',
      true,
    ),
    xaiOutputSampleRate: numberEnv(
      'XAI_OUTPUT_SAMPLE_RATE',
      numberConfig(config.xaiOutputSampleRate, DEFAULT_XAI_OUTPUT_SAMPLE_RATE),
    ),
    verboseTranscription: Boolean(config.verboseTranscription ?? true),
    audioEncoding: 'linear16',
    phoneAudioMode: telnyxStreamCodec === 'PCMU' ? 'legacy' : 'optimized',
    phoneOutputGain: numberEnv(
      'HUME_PHONE_OUTPUT_GAIN',
      numberConfig(config.phoneOutputGain, DEFAULT_PHONE_OUTPUT_GAIN),
    ),
    phoneOutputPeak: numberEnv(
      'HUME_PHONE_OUTPUT_PEAK',
      numberConfig(config.phoneOutputPeak, DEFAULT_PHONE_OUTPUT_PEAK),
    ),
    sampleRate,
    telnyxCallerId:
      profilePhoneValue(config.telnyxCallerId, config.phoneCallerId) ||
      process.env.TELNYX_FROM_NUMBER,
    // Outbound calls must use the workspace Call Control application. Saved
    // profile values can be stale phone-number inbound TeXML/SIP assignments.
    telnyxConnectionId: process.env.TELNYX_CONNECTION_ID,
    telnyxStreamCodec,
    callWindow: config.callWindow || '',
    maxConcurrent: Number(config.maxConcurrent || 1),
    useConfigPrompt: boolConfig(config.useConfigPrompt, 'HUME_USE_CONFIG_PROMPT', false),
    useConfigTools: boolConfig(config.useConfigTools, 'HUME_USE_CONFIG_TOOLS', false),
    autoStartGreeting: boolConfig(
      config.autoStartGreeting,
      'HUME_AUTO_START_GREETING',
      false,
    ),
  }
}

function normalizeIdList(value, maxItems) {
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .map((item) => stringConfig(item))
      .filter(Boolean),
  )].slice(0, maxItems)
}

export function missingRuntimeEnv() {
  const defaultRuntimeConfig = normalizeCampaignConfig({})
  const phoneRuntimeValues = requiredPhoneRuntimeValues(defaultRuntimeConfig)
  if (normalizeVoiceRuntimeProvider(process.env.VOICE_RUNTIME_PROVIDER) === VOICE_RUNTIME_XAI) {
    return requiredXaiRuntimeValues(phoneRuntimeValues)
  }
  if (normalizeVoiceRuntimeProvider(process.env.VOICE_RUNTIME_PROVIDER) === VOICE_RUNTIME_INWORLD) {
    return requiredInworldRuntimeValues(phoneRuntimeValues)
  }

  return requiredHumeRuntimeValues(
    process.env.HUME_CONFIG_ID,
    phoneRuntimeValues,
  )
}

export function missingForCall(config) {
  const phoneRuntimeValues = requiredPhoneRuntimeValues(config)
  const missing = isXaiRuntime(config)
    ? requiredXaiRuntimeValues(phoneRuntimeValues)
    : isInworldRuntime(config)
      ? requiredInworldRuntimeValues(phoneRuntimeValues)
      : requiredHumeRuntimeValues(
          config.humeConfigId,
          phoneRuntimeValues,
        )

  if (isCodexAuthLanguageModel(config) && isInworldRuntime(config)) {
    if (!getInworldCodexRouterModel(config)) missing.push('INWORLD_CODEX_ROUTER_MODEL')
  } else if (isCodexAuthLanguageModel(config)) {
    if (!getCodexClmPublicUrl()) missing.push('CODEX_CLM_PUBLIC_URL')
    if (!process.env.CODEX_CLM_API_KEY) missing.push('CODEX_CLM_API_KEY')
  }

  return missing
}

export function missingForVoiceSession(config) {
  const missing = isXaiRuntime(config)
    ? requiredXaiRuntimeValues([])
    : isInworldRuntime(config)
      ? requiredInworldRuntimeValues([])
      : requiredHumeRuntimeValues(config.humeConfigId, [])

  if (isCodexAuthLanguageModel(config) && isInworldRuntime(config)) {
    if (!getInworldCodexRouterModel(config)) missing.push('INWORLD_CODEX_ROUTER_MODEL')
  } else if (isCodexAuthLanguageModel(config)) {
    if (!getCodexClmPublicUrl()) missing.push('CODEX_CLM_PUBLIC_URL')
    if (!process.env.CODEX_CLM_API_KEY) missing.push('CODEX_CLM_API_KEY')
  }

  return missing
}

export function getStreamUrl() {
  if (process.env.VOICE_STREAM_URL) return process.env.VOICE_STREAM_URL
  if (!process.env.PUBLIC_BASE_URL) return ''
  return `${process.env.PUBLIC_BASE_URL.replace(/^http/, 'ws').replace(/\/$/, '')}/media-stream`
}

export function getCallToolsBaseUrl() {
  return (process.env.CALLTOOLS_BASE_URL || 'https://east-2.calltools.io/api').replace(/\/+$/g, '')
}

export function getCallToolsApiKey() {
  const direct = stringConfig(process.env.CALLTOOLS_API_KEY || process.env.CALLTOOLS_TOKEN)
  if (direct) return direct
  for (const args of [
    ['find-generic-password', '-s', 'calltools-api-key', '-w'],
    ['find-generic-password', '-a', 'calltools-api-key', '-w'],
  ]) {
    try {
      const key = String(
        execFileSync('security', args, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }),
      ).trim()
      if (key) return key
    } catch {
      // Continue through known keychain lookup shapes.
    }
  }
  return ''
}

export function getCallToolsMediaGatewayUrl() {
  const configured = stringConfig(process.env.CALLTOOLS_MEDIA_GATEWAY_URL).replace(/\/+$/g, '')
  if (configured) return configured
  const publicBase = stringConfig(process.env.PUBLIC_BASE_URL).replace(/\/+$/g, '')
  return publicBase ? `${publicBase}/calltools-gateway.html` : ''
}

export function getCallToolsMediaGatewaySharedSecret() {
  return stringConfig(process.env.CALLTOOLS_MEDIA_GATEWAY_SHARED_SECRET)
}

export function getTelnyxWebhookUrl() {
  if (process.env.TELNYX_WEBHOOK_URL) return process.env.TELNYX_WEBHOOK_URL
  if (!process.env.PUBLIC_BASE_URL) return undefined
  return `${process.env.PUBLIC_BASE_URL.replace(/\/$/, '')}/api/webhooks/telnyx`
}

export function getTelnyxWebhookPublicKeys() {
  return [
    process.env.TELNYX_WEBHOOK_PUBLIC_KEYS,
    process.env.TELNYX_WEBHOOK_PUBLIC_KEY,
    process.env.TELNYX_PUBLIC_KEY,
  ]
    .flatMap((value) =>
      String(value || '')
        .split(/[\n,]+/)
        .map((item) => item.trim()),
    )
    .filter(Boolean)
}

export function telnyxWebhookSignatureRequired() {
  return boolEnv('TELNYX_WEBHOOK_SIGNATURE_REQUIRED', false)
}

export function getCodexClmPublicUrl() {
  if (process.env.CODEX_CLM_PUBLIC_URL) {
    return process.env.CODEX_CLM_PUBLIC_URL.replace(/\/+$/g, '')
  }
  if (!process.env.PUBLIC_BASE_URL) return ''
  return `${process.env.PUBLIC_BASE_URL.replace(/\/+$/g, '')}/api/codex-clm/chat/completions`
}

export function getCodexAuthModel(config = {}) {
  return (
    stringConfig(config.codexAuthModel) ||
    stringConfig(process.env.CODEX_CLM_DEFAULT_MODEL) ||
    DEFAULT_CODEX_AUTH_MODEL
  )
}

export function getInworldCodexRouterModel(config = {}) {
  return normalizeInworldCodexModelResource(
    config.inworldCodexRouterModel ||
      (stringConfig(config.languageModelProvider) === 'INWORLD_CODEX'
        ? config.languageModelResource
        : '') ||
      process.env.INWORLD_CODEX_ROUTER_MODEL ||
      process.env.INWORLD_CODEX_MODEL,
  )
}

function normalizeInworldCodexModelResource(value) {
  const model = stringConfig(value)
  if (/^gpt-/i.test(model)) return `openai/${model}`
  return model
}

export function isCodexAuthLanguageModel(config = {}) {
  const mode = stringConfig(config.languageModelMode).toLowerCase()
  if (mode === 'codex') return true
  if (mode === 'hume' || mode === 'speak') return false

  const provider = stringConfig(config.languageModelProvider)
  const resource = normalizeUrlForRuntimeMatch(config.languageModelResource)
  const codexClmUrl = normalizeUrlForRuntimeMatch(getCodexClmPublicUrl())
  if (!codexClmUrl) return false

  if (resource === codexClmUrl) return true

  return (
    provider === CODEX_AUTH_LANGUAGE_MODEL_PROVIDER &&
    resource === codexClmUrl
  )
}

function normalizeUrlForRuntimeMatch(value) {
  return stringConfig(value).replace(/\/+$/g, '')
}

export function normalizeVoiceProviderAlias(value) {
  const provider = stringConfig(value)
  if (provider === 'SPEAK_LIBRARY') return 'HUME_AI'
  return provider
}

export function getTelnyxSmsFrom() {
  return normalizePhone(
    process.env.TELNYX_SMS_NUMBER ||
      process.env.TELNYX_SMS_FROM ||
      process.env.TELNYX_FROM_NUMBER ||
      '',
  )
}

export function getWorkspaceEmailAccount() {
  return cleanEmail(
    process.env.WORKSPACE_EMAIL_ACCOUNT ||
      DEFAULT_WORKSPACE_EMAIL_ACCOUNT,
  )
}

export function getWorkspaceEmailGogAccount() {
  return cleanEmail(
    process.env.WORKSPACE_EMAIL_GOG_ACCOUNT ||
      process.env.GMAIL_GOG_ACCOUNT ||
      getWorkspaceEmailAccount(),
  )
}

export function getWorkspaceEmailReadGogAccount() {
  return cleanEmail(
    process.env.WORKSPACE_EMAIL_READ_GOG_ACCOUNT ||
      process.env.GMAIL_READ_GOG_ACCOUNT ||
      getWorkspaceEmailGogAccount(),
  )
}

export function getWorkspaceEmailSendGogAccount() {
  return cleanEmail(
    process.env.WORKSPACE_EMAIL_SEND_GOG_ACCOUNT ||
      process.env.GMAIL_SEND_GOG_ACCOUNT ||
      getWorkspaceEmailGogAccount(),
  )
}

export function getSpeakLinkUrl() {
  return stringConfig(
    process.env.SPEAK_LINK_URL ||
      process.env.PORTAL_URL ||
      DEFAULT_SPEAK_LINK_URL,
  )
}

export function getGogWrapper() {
  return process.env.GOG_WRAPPER || DEFAULT_GOG_WRAPPER
}

export function isSmsConfigured() {
  return Boolean(
    process.env.TELNYX_API_KEY &&
      getTelnyxSmsFrom() &&
      process.env.TELNYX_MESSAGING_PROFILE_ID,
  )
}

export function isEmailConfigured() {
  return workspaceEmailGmailAuthConfigured() && workspaceEmailSendAsConfigured()
}

export function workspaceEmailGmailAuthConfigured({
  account = getWorkspaceEmailSendGogAccount(),
  wrapper = getGogWrapper(),
} = {}) {
  return workspaceEmailGmailAuthConfiguredFor({ account, wrapper, access: 'send' })
}

export function workspaceEmailGmailReadConfigured({
  account = getWorkspaceEmailReadGogAccount(),
  wrapper = getGogWrapper(),
} = {}) {
  return workspaceEmailGmailAuthConfiguredFor({ account, wrapper, access: 'read' })
}

export function workspaceEmailSourceReadConfigured({
  account = getWorkspaceEmailAccount(),
  authAccount = getWorkspaceEmailReadGogAccount(),
  wrapper = getGogWrapper(),
} = {}) {
  const cleanAccount = cleanEmail(account)
  const cleanAuthAccount = cleanEmail(authAccount || account)
  if (!cleanAccount || !cleanAuthAccount) return false
  const readAuthReady = workspaceEmailGmailReadConfigured({
    account: cleanAuthAccount,
    wrapper,
  })
  return (
    readAuthReady &&
    (cleanAccount === cleanAuthAccount ||
      boolEnv('WORKSPACE_EMAIL_GOG_ACCOUNT_READS_MAILBOX', false))
  )
}

function workspaceEmailGmailAuthConfiguredFor({
  account = getWorkspaceEmailGogAccount(),
  wrapper = getGogWrapper(),
  access = 'send',
} = {}) {
  const cleanAccount = cleanEmail(account)
  if (!cleanAccount || !existsSync(wrapper)) return false
  const cacheKey = workspaceEmailAuthCacheKey(wrapper, cleanAccount)
  const entry = workspaceEmailAuthCache.get(cacheKey)
  if (!workspaceEmailCacheEntryFresh(entry)) {
    void refreshWorkspaceEmailAuthCatalog({ account: cleanAccount, wrapper })
  }
  return workspaceEmailAuthProof(entry?.accounts, cleanAccount, access)
}

export function workspaceEmailSendAsConfigured({
  account = getWorkspaceEmailAccount(),
  authAccount = getWorkspaceEmailSendGogAccount(),
  wrapper = getGogWrapper(),
} = {}) {
  const cleanAccount = cleanEmail(account)
  const cleanAuthAccount = cleanEmail(authAccount || account)
  if (!cleanAccount || !cleanAuthAccount || !existsSync(wrapper)) return false
  if (cleanAccount === cleanAuthAccount) {
    return workspaceEmailGmailAuthConfigured({ account: cleanAuthAccount, wrapper })
  }

  const cacheKey = `${wrapper}:${cleanAuthAccount}:${cleanAccount}`
  const entry = workspaceEmailSendAsCache.get(cacheKey)
  if (!workspaceEmailCacheEntryFresh(entry)) {
    void refreshWorkspaceEmailSendAs({
      account: cleanAccount,
      authAccount: cleanAuthAccount,
      wrapper,
    })
  }
  return Boolean(entry?.value)
}

export async function refreshWorkspaceEmailReadiness({
  account = getWorkspaceEmailAccount(),
  sendAuthAccount = getWorkspaceEmailSendGogAccount(),
  readAuthAccount = getWorkspaceEmailReadGogAccount(),
  wrapper = getGogWrapper(),
  sourceReadDelegated = boolEnv('WORKSPACE_EMAIL_GOG_ACCOUNT_READS_MAILBOX', false),
  force = false,
} = {}) {
  const cleanAccount = cleanEmail(account)
  const cleanSendAuthAccount = cleanEmail(sendAuthAccount || account)
  const cleanReadAuthAccount = cleanEmail(readAuthAccount || sendAuthAccount || account)
  const [sendAuthConfigured, readAuthConfigured, sendAsConfigured] = await Promise.all([
    refreshWorkspaceEmailAuthCatalog({
      account: cleanSendAuthAccount,
      wrapper,
      access: 'send',
      force,
    }),
    refreshWorkspaceEmailAuthCatalog({
      account: cleanReadAuthAccount,
      wrapper,
      access: 'read',
      force,
    }),
    cleanAccount === cleanSendAuthAccount
      ? refreshWorkspaceEmailAuthCatalog({
          account: cleanSendAuthAccount,
          wrapper,
          access: 'send',
          force,
        })
      : refreshWorkspaceEmailSendAs({
          account: cleanAccount,
          authAccount: cleanSendAuthAccount,
          wrapper,
          force,
        }),
  ])
  const sourceReadConfigured = Boolean(
    readAuthConfigured &&
      (cleanAccount === cleanReadAuthAccount || sourceReadDelegated),
  )
  return {
    emailConfigured: Boolean(sendAuthConfigured && sendAsConfigured),
    sendAuthConfigured: Boolean(sendAuthConfigured),
    readAuthConfigured: Boolean(readAuthConfigured),
    sourceReadConfigured,
    sendAsConfigured: Boolean(sendAsConfigured),
    checkedAt: new Date().toISOString(),
  }
}

function workspaceEmailAuthCacheKey(wrapper) {
  // `gog auth list` returns the complete account catalog and accepts no account
  // selector, so one wrapper-scoped probe can prove every read/send identity.
  return wrapper
}

function workspaceEmailCacheEntryFresh(entry) {
  const cacheMs = entry?.probeSucceeded === false
    ? numberEnv('WORKSPACE_EMAIL_AUTH_CHECK_RETRY_MS', 5_000)
    : numberEnv('WORKSPACE_EMAIL_AUTH_CHECK_CACHE_MS', 300_000)
  return Boolean(
    entry?.checkedAt &&
      Date.now() - entry.checkedAt < cacheMs,
  )
}

function workspaceEmailAuthProof(accounts, account, access) {
  const cleanAccount = cleanEmail(account)
  return (Array.isArray(accounts) ? accounts : []).some((item) => {
    const email = cleanEmail(item.email)
    const services = Array.isArray(item.services)
      ? item.services.map((service) => safeLeadText(service).toLowerCase())
      : []
    const scopeReady =
      access === 'read'
        ? gmailScopesSupportRead(item.scopes)
        : gmailScopesSupportSend(item.scopes)
    return email === cleanAccount && services.includes('gmail') && scopeReady
  })
}

async function refreshWorkspaceEmailAuthCatalog({
  account,
  wrapper,
  access = 'send',
  force = false,
} = {}) {
  const cleanAccount = cleanEmail(account)
  if (!cleanAccount || !existsSync(wrapper)) return false
  const cacheKey = workspaceEmailAuthCacheKey(wrapper, cleanAccount)
  let entry = workspaceEmailAuthCache.get(cacheKey)
  if (!entry) {
    entry = { checkedAt: 0, accounts: [], refreshPromise: null }
    workspaceEmailAuthCache.set(cacheKey, entry)
  }
  if (!force && workspaceEmailCacheEntryFresh(entry)) {
    return workspaceEmailAuthProof(entry.accounts, cleanAccount, access)
  }
  if (!entry.refreshPromise) {
    const refreshPromise = (async () => {
      const startedAt = Date.now()
      let accounts = []
      let probeSucceeded = false
      try {
        const { stdout } = await execFileAsync(
          wrapper,
          ['--json', '--no-input', 'auth', 'list'],
          workspaceEmailProbeOptions(),
        )
        const parsed = JSON.parse(stdout || '{}')
        accounts = Array.isArray(parsed.accounts) ? parsed.accounts : []
        probeSucceeded = true
      } catch {
        accounts = []
      }
      entry.accounts = accounts
      entry.checkedAt = Date.now()
      entry.lastProbeDurationMs = entry.checkedAt - startedAt
      entry.lastProbeOutcome = probeSucceeded ? 'completed' : 'failed'
      entry.probeSucceeded = probeSucceeded
      return accounts
    })().finally(() => {
      if (entry.refreshPromise === refreshPromise) entry.refreshPromise = null
    })
    entry.refreshPromise = refreshPromise
  }
  const accounts = await entry.refreshPromise
  return workspaceEmailAuthProof(accounts, cleanAccount, access)
}

async function refreshWorkspaceEmailSendAs({
  account,
  authAccount,
  wrapper,
  force = false,
} = {}) {
  const cleanAccount = cleanEmail(account)
  const cleanAuthAccount = cleanEmail(authAccount || account)
  if (!cleanAccount || !cleanAuthAccount || !existsSync(wrapper)) return false
  if (cleanAccount === cleanAuthAccount) {
    return refreshWorkspaceEmailAuthCatalog({
      account: cleanAuthAccount,
      wrapper,
      access: 'send',
      force,
    })
  }
  const cacheKey = `${wrapper}:${cleanAuthAccount}:${cleanAccount}`
  let entry = workspaceEmailSendAsCache.get(cacheKey)
  if (!entry) {
    entry = { checkedAt: 0, value: false, refreshPromise: null }
    workspaceEmailSendAsCache.set(cacheKey, entry)
  }
  if (!force && workspaceEmailCacheEntryFresh(entry)) return Boolean(entry.value)
  if (!entry.refreshPromise) {
    const refreshPromise = (async () => {
      const startedAt = Date.now()
      let configured = false
      let probeSucceeded = false
      try {
        const { stdout } = await execFileAsync(
          wrapper,
          [
            '--account',
            cleanAuthAccount,
            '--json',
            '--results-only',
            '--no-input',
            'gmail',
            'settings',
            'sendas',
            'list',
          ],
          workspaceEmailProbeOptions(),
        )
        configured = workspaceEmailSendAsListFromOutput(JSON.parse(stdout || '{}')).some(
          (item) => {
            const sendAsEmail = cleanEmail(
              item.sendAsEmail || item.email || item.address || item.value,
            )
            const status = safeLeadText(
              item.verificationStatus || item.verification_status || '',
            ).toLowerCase()
            return (
              sendAsEmail === cleanAccount &&
              (!status || ['accepted', 'verified'].includes(status))
            )
          },
        )
        probeSucceeded = true
      } catch {
        configured = false
      }
      entry.value = configured
      entry.checkedAt = Date.now()
      entry.lastProbeDurationMs = entry.checkedAt - startedAt
      entry.lastProbeOutcome = probeSucceeded ? 'completed' : 'failed'
      entry.probeSucceeded = probeSucceeded
      return configured
    })().finally(() => {
      if (entry.refreshPromise === refreshPromise) entry.refreshPromise = null
    })
    entry.refreshPromise = refreshPromise
  }
  return entry.refreshPromise
}

function workspaceEmailProbeOptions() {
  return {
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: numberEnv('WORKSPACE_EMAIL_AUTH_CHECK_TIMEOUT_MS', 60_000),
  }
}

function workspaceEmailSendAsListFromOutput(output) {
  if (Array.isArray(output)) return output
  if (!output || typeof output !== 'object') return []
  const candidates = [
    output.result,
    output.results,
    output.sendAs,
    output.send_as,
    output.data,
    output.items,
  ]
  for (const candidate of candidates) {
    const nested = workspaceEmailSendAsListFromOutput(candidate)
    if (nested.length) return nested
  }
  if (output.sendAsEmail || output.email || output.address) return [output]
  return []
}

function gmailScopesSupportSend(scopes) {
  const normalized = Array.isArray(scopes)
    ? scopes.map((scope) => safeLeadText(scope).toLowerCase()).filter(Boolean)
    : []
  if (normalized.length === 0) return false
  return normalized.some(
    (scope) =>
      scope === 'https://mail.google.com/' ||
      scope.endsWith('/auth/gmail.compose') ||
      scope.endsWith('/auth/gmail.send') ||
      scope.endsWith('/auth/gmail.modify'),
  )
}

function gmailScopesSupportRead(scopes) {
  const normalized = Array.isArray(scopes)
    ? scopes.map((scope) => safeLeadText(scope).toLowerCase()).filter(Boolean)
    : []
  if (normalized.length === 0) return false
  return normalized.some(
    (scope) =>
      scope === 'https://mail.google.com/' ||
      scope.endsWith('/auth/gmail.readonly') ||
      scope.endsWith('/auth/gmail.modify'),
  )
}

export function splitPersonName(value) {
  const parts = cleanName(value).split(/\s+/).filter(Boolean)
  return {
    firstName: parts[0] || '',
    lastName: parts.slice(1).join(' '),
  }
}

export function preferredFirstName(lead) {
  return safeLeadText(lead?.firstName || splitPersonName(lead?.name || '').firstName)
}

export function cleanName(value) {
  const text = String(value || '').replace(/[[\]{}<>]/g, ' ').replace(/\s+/g, ' ').trim()
  return safeLeadText(text)
}

export function safeLeadText(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  const normalized = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const blocked = new Set([
    'lead',
    'unknown',
    'unknown contact',
    'unknown business',
    'customer',
    'customer name',
    'business name',
    'not provided',
    'n a',
    'na',
    'null',
    'undefined',
  ])
  if (blocked.has(normalized)) return ''
  return text
}

export function normalizePhone(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const digits = raw.replace(/\D/g, '')
  if (raw.startsWith('+') && /^\+[1-9]\d{7,14}$/.test(raw)) return raw
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  if (digits.length >= 8 && digits.length <= 15) return `+${digits}`
  return ''
}

export function cleanEmail(value) {
  const email = String(value || '').trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : ''
}

export function cleanObject(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined && value !== ''),
  )
}

export function numberEnv(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  return Number.isFinite(value) ? value : fallback
}

export function boolEnv(name, fallback) {
  if (process.env[name] === undefined) return fallback
  return process.env[name] === 'true'
}

function requiredHumeRuntimeValues(humeConfigId, phoneRuntimeValues) {
  return [
    ['HUME_API_KEY', getHumeApiKey()],
    ['HUME_CONFIG_ID', humeConfigId],
    ...phoneRuntimeValues,
  ]
    .filter(([, value]) => !value || isPlaceholder(value))
    .map(([name]) => name)
}

function requiredInworldRuntimeValues(phoneRuntimeValues) {
  return [
    ['INWORLD_API_KEY', getInworldApiKey()],
    ...phoneRuntimeValues,
  ]
    .filter(([, value]) => !value || isPlaceholder(value))
    .map(([name]) => name)
}

function requiredXaiRuntimeValues(phoneRuntimeValues) {
  return [
    ['XAI_API_KEY', getXaiApiKey()],
    ...phoneRuntimeValues,
  ]
    .filter(([, value]) => !value || isPlaceholder(value))
    .map(([name]) => name)
}

function requiredPhoneRuntimeValues(config = {}) {
  return isCallToolsDialer(config)
    ? requiredCallToolsPhoneRuntimeValues(config.calltoolsAgentBinding)
    : requiredSharedPhoneRuntimeValues(config.telnyxConnectionId, config.telnyxCallerId)
}

function requiredCallToolsPhoneRuntimeValues(binding = {}) {
  return [
    ['CALLTOOLS_API_KEY', getCallToolsApiKey()],
    ['CALLTOOLS_AGENT_USER_ID', binding.appUserId || binding.userId],
    ['CALLTOOLS_PHONE_ID', binding.phoneId],
    ['CALLTOOLS_MEDIA_GATEWAY_SHARED_SECRET', getCallToolsMediaGatewaySharedSecret()],
  ]
}

function requiredSharedPhoneRuntimeValues(telnyxConnectionId, telnyxCallerId) {
  return [
    ['TELNYX_API_KEY', process.env.TELNYX_API_KEY],
    ['TELNYX_CONNECTION_ID', telnyxConnectionId],
    ['TELNYX_FROM_NUMBER', telnyxCallerId],
    [
      'TELNYX_WEBHOOK_PUBLIC_KEY',
      telnyxWebhookSignatureRequired() ? getTelnyxWebhookPublicKeys()[0] : 'optional',
    ],
    ['VOICE_STREAM_URL', getStreamUrl()],
  ]
}

function numberConfig(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function boolConfig(value, envName, fallback) {
  if (value !== undefined) return Boolean(value)
  return boolEnv(envName, fallback)
}

function stringConfig(value) {
  return String(value || '').trim()
}

function optionalNumber(value) {
  if (value === undefined || value === null || value === '') return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function optionalBoolean(value) {
  if (value === undefined || value === null) return undefined
  return Boolean(value)
}

function profilePhoneValue(...values) {
  for (const value of values) {
    const text = stringConfig(value)
    if (text && !isPlaceholder(text)) return text
  }
  return ''
}

function isPlaceholder(value) {
  const text = String(value || '').trim()
  return (
    text.includes('your ') ||
    text.includes('phase-one') ||
    /^phone connection id$/i.test(text) ||
    /^telnyx connection id$/i.test(text) ||
    /^telnyx call control connection_id$/i.test(text)
  )
}

function normalizedBasePath() {
  return normalizeBasePath(process.env.BASE_PATH || '')
}
