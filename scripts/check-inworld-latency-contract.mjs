import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import {
  buildInworldCodexAuthModelOptions,
  buildInworldNativeModelOptions,
  resolveInworldReasoningEffort,
  validateInworldRuntimeConfig,
} from '../server/inworld-configs.mjs'
import { normalizeCampaignConfig } from '../server/runtime-config.mjs'
import {
  assistantTurnHasAudio,
  noteFinalUserTurn,
} from '../server/voice-turn-transport.mjs'

const failures = []
const rawArgs = process.argv.slice(2)
const options = Object.fromEntries(
  rawArgs
    .filter((arg) => arg.startsWith('--') && arg.includes('='))
    .map((arg) => {
      const [key, ...rest] = arg.slice(2).split('=')
      return [key, rest.join('=')]
    }),
)
const liveBaseUrl = normalizeBaseUrl(
  options.baseUrl || process.env.SPEAK_INWORLD_LATENCY_CHECK_BASE_URL || '',
)
const liveProfileId =
  options.profileId ||
  process.env.SPEAK_INWORLD_LATENCY_CHECK_PROFILE_ID ||
  ''
const runtime = normalizeCampaignConfig({
  voiceRuntimeProvider: 'inworld',
  languageModelMode: 'inworld',
})
const indexSource = readFileSync('server/index.mjs', 'utf8')
const sessionPromptSource = readFileSync('server/session-prompt.mjs', 'utf8')
const diagnosticsSource = readFileSync('server/transport-diagnostics.mjs', 'utf8')
const runtimeSource = readFileSync('server/runtime-config.mjs', 'utf8')
const settingsSource = readFileSync('src/SpeakSettingsPanel.tsx', 'utf8')
const docs = readFileSync('docs/configuration-options.md', 'utf8')
const readme = readFileSync('README.md', 'utf8')
const agentManual = readFileSync('AGENTS.md', 'utf8')

verifyInworldVoiceResolution()
verifyInworldFeatureCompatibility()
verifyLiveProfileSelection()
verifyAssistantAudioWatchdogOrdering()

function verifyAssistantAudioWatchdogOrdering() {
  const audioBeforeText = { audioPacketsSent: 0 }
  noteFinalUserTurn(audioBeforeText, { provider: 'inworld', atMs: 1_000 })
  audioBeforeText.audioPacketsSent += 1
  if (!assistantTurnHasAudio(audioBeforeText)) {
    failures.push(
      'Inworld watchdog must recognize current-turn audio that arrives before assistant text',
    )
  }

  const textBeforeAudio = { audioPacketsSent: 0 }
  noteFinalUserTurn(textBeforeAudio, { provider: 'inworld', atMs: 1_000 })
  if (assistantTurnHasAudio(textBeforeAudio)) {
    failures.push('Inworld watchdog must not invent audio before the current turn emits it')
  }
  textBeforeAudio.audioPacketsSent += 1
  if (!assistantTurnHasAudio(textBeforeAudio)) {
    failures.push(
      'Inworld watchdog must recognize current-turn audio that arrives after assistant text',
    )
  }
}

if (runtime.inworldTurnDetectionMode !== 'semantic_vad') {
  failures.push(`Expected Inworld turn detection default semantic_vad, got ${runtime.inworldTurnDetectionMode}`)
}
if (runtime.inworldSttModel !== 'inworld/inworld-stt-1') {
  failures.push(`Expected Inworld live-call STT default inworld/inworld-stt-1, got ${runtime.inworldSttModel}`)
}
if (runtime.inworldTurnEagerness !== 'high') {
  failures.push(`Expected Inworld semantic VAD eagerness high, got ${runtime.inworldTurnEagerness}`)
}
if (runtime.inworldTtsSegmenterStrategy !== 'full_turn') {
  failures.push(`Expected Inworld TTS segmenter full_turn, got ${runtime.inworldTtsSegmenterStrategy}`)
}
if (runtime.inworldTtsModel !== 'inworld-tts-2') {
  failures.push(`Expected Inworld TTS model to normalize to inworld-tts-2, got ${runtime.inworldTtsModel}`)
}
if (runtime.inworldTtsDeliveryMode !== 'CREATIVE') {
  failures.push(`Expected Inworld TTS-2 delivery CREATIVE, got ${runtime.inworldTtsDeliveryMode}`)
}
if (runtime.inworldTtsConversationalEnabled !== false) {
  failures.push(`Expected Inworld TTS conversational context disabled by default, got ${runtime.inworldTtsConversationalEnabled}`)
}
if (runtime.inworldTtsUserTurnMode !== 'both') {
  failures.push(`Expected Inworld TTS user turn mode both, got ${runtime.inworldTtsUserTurnMode}`)
}
if (runtime.inworldVoiceSteeringEnabled !== true) {
  failures.push(`Expected Inworld TTS-2 voice steering enabled by default, got ${runtime.inworldVoiceSteeringEnabled}`)
}
if (runtime.inworldVoiceProfileEnabled !== true) {
  failures.push(`Expected Inworld voice profile cues enabled by default, got ${runtime.inworldVoiceProfileEnabled}`)
}
if (runtime.inworldResponsivenessEnabled !== false) {
  failures.push(`Expected Inworld responsiveness disabled by default, got ${runtime.inworldResponsivenessEnabled}`)
}
if (runtime.inworldResponsivenessInitialWaitMs !== 600) {
  failures.push(`Expected Inworld responsiveness initial wait 600, got ${runtime.inworldResponsivenessInitialWaitMs}`)
}
if (runtime.inworldResponsivenessHardDeadlineMs !== 1200) {
  failures.push(`Expected Inworld responsiveness hard deadline 1200, got ${runtime.inworldResponsivenessHardDeadlineMs}`)
}
if (runtime.inworldOutputSampleRate !== 16000) {
  failures.push(`Expected Inworld output sample rate 16000, got ${runtime.inworldOutputSampleRate}`)
}

for (const field of [
  'inworldSttEndOfTurnConfidenceThreshold',
  'inworldSttMinEndOfTurnSilenceMs',
  'inworldSttMaxTurnSilenceMs',
  'inworldSttVadThreshold',
]) {
  if (runtime[field] !== undefined) {
    failures.push(`Expected ${field} to be unset by default so Inworld eagerness remains native`)
  }
}

const forbiddenDefaultOverrides = [
  "turnDetectionMode === 'semantic_vad' ? 0.7",
  'min_end_of_turn_silence: state.config.endOfTurnSilenceMs',
  'vad_threshold: state.config.speechDetectionThreshold',
]
for (const forbidden of forbiddenDefaultOverrides) {
  if (indexSource.includes(forbidden)) {
    failures.push(`Inworld session still has default Hume-style STT override: ${forbidden}`)
  }
}

const requiredSourceSnippets = [
  'const reasoningEffort = inworldReasoningEffort(state.config)',
  "config.inworldReasoningEfforts.includes('none')",
  "? 'fast_start'",
  "model: 'inworld-tts-2'",
  "model: state.config.inworldSttModel || DEFAULT_INWORLD_STT_MODEL",
  ": state.config.inworldTtsSegmenterStrategy || 'full_turn'",
  "delivery_mode: state.config.inworldTtsDeliveryMode || 'CREATIVE'",
  'conversational: inworldConversational',
  "user_turn_mode: state.config.inworldTtsUserTurnMode || 'both'",
  'voice_profile: state.config.inworldVoiceProfileEnabled !== false',
  'inworldVoiceSteeringInstructions(state)',
  'recordInworldVoiceProfile(state, message)',
  'stripInworldVoiceDirectives(content)',
  'initial_wait_timeout_ms:',
  'enable_filler_on_first_assistant_reply: false',
  'Do not say "one moment", "just a sec"',
  'This block controls spoken delivery only',
  'short, warm, direct, and conversational',
  'Default to 5 to 10 spoken words',
  'A short turn still has to do real conversational work',
  'Do not repeat standalone one-word replies such as "Great."',
  'usually begin with one [speak ...] tag',
  '[laugh], [breathe], [sigh], [cough], [clear throat], or [yawn]',
  'zero to two times per turn',
  'Write numbers, dates, URLs, and abbreviations in natural spoken form',
  "recordTransportMilestone(state, 'first_inworld_speech_stopped')",
  'if (assistantTurnHasAudio(state)) return',
  'assistantTurnHasAudio(current)',
  'end_of_turn_confidence_threshold: state.config.inworldSttEndOfTurnConfidenceThreshold',
  'min_end_of_turn_silence: state.config.inworldSttMinEndOfTurnSilenceMs',
  'max_turn_silence: state.config.inworldSttMaxTurnSilenceMs',
  'vad_threshold: state.config.inworldSttVadThreshold',
  "cancelInworldResponse(state, { clearInput: false })",
  'if (clearInput) state.inworldWs.send(JSON.stringify({ type: \'input_audio_buffer.clear\' }))',
]
for (const snippet of requiredSourceSnippets) {
  if (!indexSource.includes(snippet)) {
    failures.push(`Inworld session missing latency contract source snippet: ${snippet}`)
  }
}

if (!sessionPromptSource.includes('Do not use delay fillers such as "just a sec"')) {
  failures.push('Runtime speech prompt must ban delay fillers such as "just a sec"')
}
if (!runtimeSource.includes('export function normalizeInworldTtsModel(_value)')) {
  failures.push('Runtime config must normalize Inworld TTS model selections')
}
if (settingsSource.includes('inworld-tts-1.5')) {
  failures.push('Settings UI must not expose older Inworld TTS models')
}
for (const snippet of [
  "config.inworldVoiceProvider === 'INWORLD_CUSTOM'",
  '? config.voice || config.inworldVoiceName',
  ': config.inworldVoiceName || config.voice',
  '`${config.inworldVoiceProvider}:${currentInworldVoiceValue}`',
]) {
  if (!settingsSource.includes(snippet)) {
    failures.push(
      `Inworld voice selection must use custom IDs and system names: missing ${snippet}`,
    )
  }
}
for (const snippet of [
  'selectedCodexAuthModel?.reasoningEfforts',
  'config.inworldToolCallingEnabled !== false',
  'inworldReasoningEfforts: selected.reasoningEfforts',
  'inworldReasoningSupported: selected.reasoningSupported',
  'inworldTtsConversationalEnabled: false',
  'codexFastMode: event.target.checked ? false : config.codexFastMode',
  'currentProviderModelUnavailable',
  'Select an available model before starting a call.',
]) {
  if (!settingsSource.includes(snippet)) {
    failures.push(`Inworld feature compatibility UI missing source snippet: ${snippet}`)
  }
}

const capabilityProbeSource = readFileSync('scripts/probe-inworld-tool-capability.mjs', 'utf8')
for (const snippet of [
  "process.argv.includes('--audio-smoke')",
  "argumentValue('voice')",
  "process.argv.includes('--omit-reasoning')",
  "message.type === 'response.output_audio.delta'",
  "message.type === 'response.done'",
  'audioBytes',
]) {
  if (!capabilityProbeSource.includes(snippet)) {
    failures.push(`Inworld audio smoke probe missing source snippet: ${snippet}`)
  }
}
if (
  capabilityProbeSource.includes(
    "message.type === 'conversation.item.done' && inputSent && !responseRequested",
  )
) {
  failures.push(
    'Inworld audio smoke probe must request the response immediately instead of waiting for conversation.item.done',
  )
}

for (const snippet of [
  'requestedTtsDeliveryMode: config.inworldTtsDeliveryMode',
  'requestedTtsSegmenterStrategy: config.inworldTtsSegmenterStrategy',
  'requestedTtsSteeringHandling: config.inworldTtsSteeringHandling',
  'requestedTtsConversational: config.inworldTtsConversationalEnabled',
  'requestedTtsUserTurnMode: config.inworldTtsUserTurnMode',
  'voiceSteeringEnabled: config.inworldVoiceSteeringEnabled',
  'voiceProfileEnabled: config.inworldVoiceProfileEnabled',
  'responsivenessEnabled: config.inworldResponsivenessEnabled',
  'responsivenessInitialWaitMs: config.inworldResponsivenessInitialWaitMs',
  'sttEndOfTurnConfidenceThreshold: config.inworldSttEndOfTurnConfidenceThreshold',
  'firstCallToolsLeadAudioToFirstAssistantAudio: elapsedMs',
  'firstInworldSpeechStoppedToFirstAssistantAudio: elapsedMs',
]) {
  if (!diagnosticsSource.includes(snippet)) {
    failures.push(`Inworld diagnostics missing naturalness setting: ${snippet}`)
  }
}

if (
  /input_audio_buffer\.speech_started[\s\S]{0,900}input_audio_buffer\.clear/.test(indexSource)
) {
  failures.push(
    'Inworld speech_started path must not clear input_audio_buffer; that deletes caller audio before STT can finalize',
  )
}
if (indexSource.includes('Lead speech detected')) {
  failures.push('Inworld speech_started operator notice must use caller/contact wording, not stale lead wording')
}
if (!indexSource.includes('Caller speech detected; Inworld assistant audio was cleared.')) {
  failures.push('Inworld speech_started operator notice must explain caller speech and cleared assistant audio')
}

const requiredDocs = [
  '`INWORLD_TURN_EAGERNESS` | backend env/profile | `high`',
  '`INWORLD_STT_MODEL` | backend env/profile | `inworld/inworld-stt-1`',
  '`INWORLD_TTS_SEGMENTER_STRATEGY` | backend env/profile | `full_turn`',
  '`INWORLD_TTS_CONVERSATIONAL_ENABLED` | backend env/profile | `false`',
  '`INWORLD_TTS_USER_TURN_MODE` | backend env/profile | `both`',
  '`INWORLD_TTS_DELIVERY_MODE` | backend env/profile | `CREATIVE`',
  '`inworldTtsModel` | `inworld-tts-2` | `inworld-tts-2`',
  '`INWORLD_VOICE_STEERING_ENABLED` | backend env/profile | `true`',
  '`INWORLD_VOICE_PROFILE_ENABLED` | backend env/profile | `true`',
  '`INWORLD_RESPONSIVENESS_ENABLED` | backend env/profile | `false`',
  '`INWORLD_RESPONSIVENESS_INITIAL_WAIT_MS` | backend env/profile | `600`',
  '`INWORLD_RESPONSIVENESS_HARD_DEADLINE_MS` | backend env/profile | `1200`',
  '`INWORLD_OUTPUT_SAMPLE_RATE` | backend env/profile | `16000`',
  'Advanced Inworld semantic VAD override',
]
for (const snippet of requiredDocs) {
  if (!docs.includes(snippet)) {
    failures.push(`Configuration reference missing Inworld latency documentation: ${snippet}`)
  }
}

for (const [name, source] of [
  ['README.md', readme],
  ['AGENTS.md', agentManual],
]) {
  for (const snippet of [
    'semantic_vad',
    'inworld/inworld-stt-1',
    'full_turn',
    'CREATIVE',
    'inworld-tts-2',
    'voice steering',
    'provider-native TTS-2 steering prompts',
    '600 ms initial wait',
    'text_generation_config.reasoning.effort=NONE',
    'Fast mode',
    'providerData.stt',
  ]) {
    if (!source.includes(snippet)) {
      failures.push(`${name} missing Inworld latency contract snippet: ${snippet}`)
    }
  }
}

if (liveBaseUrl) {
  await checkLiveProfileContract({ baseUrl: liveBaseUrl, profileId: liveProfileId })
}

if (failures.length) {
  console.error(`Inworld latency contract check failed (${failures.length}):`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log(
  JSON.stringify(
    {
      ok: true,
      schemaVersion: 'speak.inworld.latency-contract.v1',
      defaults: {
        turnDetection: runtime.inworldTurnDetectionMode,
        eagerness: runtime.inworldTurnEagerness,
        ttsSegmenter: runtime.inworldTtsSegmenterStrategy,
        ttsDelivery: runtime.inworldTtsDeliveryMode,
        ttsConversational: runtime.inworldTtsConversationalEnabled,
        ttsUserTurnMode: runtime.inworldTtsUserTurnMode,
        voiceSteering: runtime.inworldVoiceSteeringEnabled,
        voiceProfile: runtime.inworldVoiceProfileEnabled,
        responsivenessEnabled: runtime.inworldResponsivenessEnabled,
        responsivenessInitialWaitMs: runtime.inworldResponsivenessInitialWaitMs,
        responsivenessHardDeadlineMs: runtime.inworldResponsivenessHardDeadlineMs,
        outputSampleRate: runtime.inworldOutputSampleRate,
        reasoningEffort: 'NONE',
        sttModel: runtime.inworldSttModel,
        sttOverridesDefaultUnset: true,
      },
    },
    null,
    2,
  ),
)

async function checkLiveProfileContract({ baseUrl, profileId }) {
  const response = await fetchWithRetries(`${baseUrl}/api/profiles`, {
    attempts: 12,
    delayMs: 2500,
    timeoutMs: 2000,
  })
  if (!response.ok) {
    failures.push(`Unable to read live profile contract from ${baseUrl}/api/profiles (${response.status} ${response.statusText})`)
    return
  }

  const payload = await response.json().catch(() => ({}))
  const profiles = Array.isArray(payload.profiles)
    ? payload.profiles
    : Array.isArray(payload.data?.profiles)
      ? payload.data.profiles
      : []
  const selection = selectLiveInworldProfiles(profiles, profileId)
  if (selection.error) {
    failures.push(selection.error)
    return
  }

  for (const profile of selection.profiles) checkLiveInworldProfile(profile)
}

function checkLiveInworldProfile(profile) {
  const config = normalizeCampaignConfig({
    ...(profile.config || {}),
    voiceRuntimeProvider: 'inworld',
  })
  if (config.inworldSttModel !== 'inworld/inworld-stt-1') {
    failures.push(`Live profile ${profile.id} must use native Inworld STT inworld/inworld-stt-1`)
  }
  if (/^(assemblyai|soniox)\//i.test(String(config.inworldSttModel || ''))) {
    failures.push(`Live profile ${profile.id} must not use third-party STT model ${config.inworldSttModel}`)
  }
  if (config.inworldTtsModel && config.inworldTtsModel !== 'inworld-tts-2') {
    failures.push(`Live profile ${profile.id} uses unsupported Inworld TTS model ${config.inworldTtsModel}`)
  }
  if (config.inworldTtsDeliveryMode !== 'CREATIVE') {
    failures.push(`Live profile ${profile.id} must use Inworld TTS-2 CREATIVE delivery`)
  }
  if (config.inworldTtsSegmenterStrategy !== 'full_turn') {
    failures.push(`Live profile ${profile.id} must keep full_turn as its quality baseline`)
  }
  if (config.inworldTtsSteeringHandling !== 'emit_once') {
    failures.push(`Live profile ${profile.id} must use emit_once steering for Inworld TTS-2`)
  }
  if (config.inworldTtsConversationalEnabled !== false) {
    failures.push(`Live profile ${profile.id} must keep conversational TTS opt-in disabled by default`)
  }
  if (config.inworldVoiceSteeringEnabled !== true) {
    failures.push(`Live profile ${profile.id} must keep Inworld voice steering enabled`)
  }
  if (config.inworldVoiceProfileEnabled !== true) {
    failures.push(`Live profile ${profile.id} must keep Inworld voice profile enabled`)
  }
  if (config.inworldResponsivenessEnabled !== false) {
    failures.push(`Live profile ${profile.id} must keep Inworld responsiveness fillers disabled`)
  }
  if (config.inworldOutputSampleRate !== 16000) {
    failures.push(`Live profile ${profile.id} must use 16 kHz phone output`)
  }
  if (config.inworldToolCallingEnabled !== true) {
    failures.push(`Live profile ${profile.id} must keep shared Speak tools enabled`)
  }
  for (const field of [
    'inworldSttEndOfTurnConfidenceThreshold',
    'inworldSttMinEndOfTurnSilenceMs',
    'inworldSttMaxTurnSilenceMs',
    'inworldSttVadThreshold',
  ]) {
    if (config[field] !== undefined && config[field] !== null && config[field] !== '') {
      failures.push(`Live profile ${profile.id} must not set risky Inworld STT override ${field}`)
    }
  }
}

function selectLiveInworldProfiles(profiles, requestedProfileId) {
  const requested = String(requestedProfileId || '').trim()
  if (requested) {
    const profile = profiles.find((item) => item?.id === requested)
    if (!profile) {
      return { error: `Live Inworld latency profile not found: ${requested}`, profiles: [] }
    }
    if (!isInworldProfile(profile)) {
      return {
        error: `Live Inworld latency profile ${requested} is not configured for the Inworld runtime`,
        profiles: [],
      }
    }
    return { error: '', profiles: [profile] }
  }

  const inworldProfiles = profiles.filter(isInworldProfile)
  return inworldProfiles.length
    ? { error: '', profiles: inworldProfiles }
    : { error: 'No live Inworld runtime profiles were found', profiles: [] }
}

function isInworldProfile(profile) {
  const config = profile?.config || {}
  return (
    String(config.voiceRuntimeProvider || config.runtimeProvider || '').toLowerCase() ===
      'inworld' ||
    String(config.languageModelMode || '').toLowerCase() === 'inworld'
  )
}

function verifyInworldFeatureCompatibility() {
  const catalog = [
    {
      provider: 'openai',
      model: 'gpt-5.4',
      isSupported: true,
      spec: {
        inputModalities: ['text'],
        outputModalities: ['text'],
        capabilities: {
          functionCalling: true,
          reasoningCapability: {
            supported: true,
            supportedLevels: ['EFFORT_NONE', 'EFFORT_LOW', 'EFFORT_HIGH', 'EFFORT_XHIGH'],
          },
        },
      },
    },
    {
      provider: 'openai',
      model: 'gpt-4.1',
      isSupported: true,
      spec: {
        inputModalities: ['text'],
        outputModalities: ['text'],
        capabilities: { functionCalling: true, reasoning: false },
      },
    },
    {
      provider: 'deepinfra',
      model: 'NousResearch/Hermes-3-Llama-3.1-70B',
      isSupported: true,
      spec: {
        inputModalities: ['text'],
        outputModalities: ['text'],
        capabilities: { functionCalling: false, reasoning: false },
      },
    },
    {
      provider: 'inworld',
      model: 'models/deepseek-v4-pro',
      isSupported: true,
      spec: {
        inputModalities: ['text'],
        outputModalities: ['text'],
        capabilities: { functionCalling: true, reasoning: false },
      },
    },
    {
      provider: 'deepinfra',
      model: 'Qwen/Qwen2.5-72B-Instruct',
      isSupported: true,
      spec: {
        inputModalities: ['text'],
        outputModalities: ['text'],
        capabilities: { functionCalling: true, reasoning: false },
      },
    },
    {
      provider: 'qa',
      model: 'image-input-only',
      isSupported: true,
      spec: {
        inputModalities: ['image'],
        outputModalities: ['text'],
        capabilities: { functionCalling: true, reasoning: false },
      },
    },
    {
      provider: 'qa',
      model: 'image-output-only',
      isSupported: true,
      spec: {
        inputModalities: ['text'],
        outputModalities: ['image'],
        capabilities: { functionCalling: true, reasoning: false },
      },
    },
  ]
  const nativeOptions = buildInworldNativeModelOptions(catalog)
  const nativeGpt41 = nativeOptions.find(
    (option) => option.modelResource === 'openai/gpt-4.1',
  )
  if (
    nativeOptions.length !== 4 ||
    !nativeGpt41 ||
    nativeGpt41.functionCallingSupported !== true ||
    nativeGpt41.reasoningSupported !== false ||
    nativeOptions.some((option) =>
      option.modelResource.includes('Hermes-3-Llama-3.1-70B'),
    ) ||
    !nativeOptions.some(
      (option) => option.modelResource === 'inworld/models/deepseek-v4-pro',
    ) ||
    !nativeOptions.some(
      (option) => option.modelResource === 'deepinfra/Qwen/Qwen2.5-72B-Instruct',
    ) ||
    nativeOptions.some((option) => option.modelResource.startsWith('qa/image-'))
  ) {
    failures.push(
      `Inworld native options must filter models without shared tool support and preserve reasoning capability: ${JSON.stringify(nativeOptions)}`,
    )
  }
  const options = buildInworldCodexAuthModelOptions(
    [
      { value: 'gpt-5.4', label: 'GPT 5.4' },
      { value: 'gpt-5.3-codex-spark', label: 'GPT 5.3 Codex Spark' },
    ],
    catalog,
  )
  if (
    options.length !== 1 ||
    options[0]?.value !== 'openai/gpt-5.4' ||
    JSON.stringify(options[0]?.reasoningEfforts) !== JSON.stringify(['none', 'low', 'high', 'xhigh'])
  ) {
    failures.push(`Inworld Codex options must intersect the live model/effort catalog: ${JSON.stringify(options)}`)
  }
  if (
    resolveInworldReasoningEffort({
      model: 'openai/gpt-5.4',
      requested: 'high',
      supportedEfforts: ['none', 'low', 'high', 'xhigh'],
      toolsEnabled: false,
    }) !== 'HIGH' ||
    resolveInworldReasoningEffort({
      model: 'openai/gpt-5.4',
      requested: 'high',
      supportedEfforts: ['none', 'low', 'high', 'xhigh'],
      toolsEnabled: true,
    }) !== 'NONE' ||
    resolveInworldReasoningEffort({
      model: 'openai/gpt-5.4',
      requested: 'medium',
      supportedEfforts: ['none', 'low', 'high', 'xhigh'],
      toolsEnabled: false,
    }) !== '' ||
    resolveInworldReasoningEffort({
      model: 'openai/gpt-5-mini',
      requested: 'none',
      supportedEfforts: ['low', 'medium', 'high'],
      toolsEnabled: true,
    }) !== ''
  ) {
    failures.push('Inworld reasoning must serialize only efforts advertised by the selected model')
  }

  const compatible = validateInworldRuntimeConfig(
    {
      voiceRuntimeProvider: 'inworld',
      languageModelMode: 'codex',
      languageModelProvider: 'INWORLD_CODEX',
      languageModelResource: 'openai/gpt-5.4',
      inworldRealtimeModel: 'openai/gpt-5.4',
      inworldToolCallingEnabled: true,
    },
    catalog,
  )
  if (
    compatible.inworldReasoningSupported !== true ||
    JSON.stringify(compatible.inworldReasoningEfforts) !==
      JSON.stringify(['none', 'low', 'high', 'xhigh'])
  ) {
    failures.push('Inworld preflight must attach live capability metadata to runtime config')
  }
  for (const [model, expectedCode] of [
    ['deepinfra/NousResearch/Hermes-3-Llama-3.1-70B', 'inworld_model_not_tool_compatible'],
    ['qa/image-input-only', 'inworld_model_not_text_compatible'],
    ['openai/not-in-catalog', 'inworld_model_not_available'],
  ]) {
    try {
      validateInworldRuntimeConfig(
        {
          voiceRuntimeProvider: 'inworld',
          languageModelMode: 'inworld',
          languageModelResource: model,
          inworldRealtimeModel: model,
          inworldToolCallingEnabled: true,
        },
        catalog,
      )
      failures.push(`Inworld preflight must reject incompatible model ${model}`)
    } catch (error) {
      if (error?.code !== expectedCode) {
        failures.push(
          `Inworld preflight returned the wrong proof for ${model}: ${error?.code || error?.message}`,
        )
      }
    }
  }
}

function verifyLiveProfileSelection() {
  const profiles = [
    {
      id: 'hume-with-stale-good-fields',
      config: {
        voiceRuntimeProvider: 'hume',
        inworldResponsivenessEnabled: false,
        inworldTtsDeliveryMode: 'CREATIVE',
      },
    },
    {
      id: 'real-inworld-profile',
      config: {
        voiceRuntimeProvider: 'inworld',
        inworldResponsivenessEnabled: true,
      },
    },
  ]
  const all = selectLiveInworldProfiles(profiles, '')
  const rejectedHume = selectLiveInworldProfiles(profiles, 'hume-with-stale-good-fields')
  if (
    all.error ||
    all.profiles.length !== 1 ||
    all.profiles[0]?.id !== 'real-inworld-profile' ||
    !rejectedHume.error
  ) {
    failures.push('Live Inworld checker must ignore stale Hume fields and reject explicit non-Inworld profiles')
  }
}

function normalizeBaseUrl(value) {
  return String(value || '').replace(/\/+$/, '')
}

function verifyInworldVoiceResolution() {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      [
        "const runtime = await import('./server/index.mjs')",
        "const base = { sampleRate: 16000, lead: {}, config: { voiceRuntimeProvider: 'inworld', languageModelMode: 'inworld', inworldRealtimeModel: 'google-ai-studio/gemini-3.5-flash', inworldSttModel: 'inworld/inworld-stt-1', inworldOutputSampleRate: 16000, inworldVoiceSteeringEnabled: true, inworldVoiceProfileEnabled: true, inworldResponsivenessEnabled: false } }",
        "const custom = runtime.buildInworldSession({ ...base, config: { ...base.config, voice: 'workspace__jai', inworldVoiceName: 'Jai', inworldVoiceProvider: 'INWORLD_CUSTOM' } }, { includeTools: false }).audio.output.voice",
        "const system = runtime.buildInworldSession({ ...base, config: { ...base.config, voice: '910e3ac8-d303-45b0-bd0e-b9200cc28203', inworldVoiceName: 'Sarah', inworldVoiceProvider: 'INWORLD_SYSTEM' } }, { includeTools: false }).audio.output.voice",
        "const validReasoning = runtime.buildInworldSession({ ...base, config: { ...base.config, languageModelMode: 'codex', languageModelProvider: 'INWORLD_CODEX', languageModelResource: 'openai/gpt-5.4', inworldRealtimeModel: 'openai/gpt-5.4', inworldReasoningEfforts: ['none', 'low', 'high', 'xhigh'], codexReasoningEffort: 'high', inworldToolCallingEnabled: false } }, { includeTools: false }).text_generation_config.reasoning.effort",
        "const toolsAndReasoning = runtime.buildInworldSession({ ...base, config: { ...base.config, languageModelMode: 'codex', languageModelProvider: 'INWORLD_CODEX', languageModelResource: 'openai/gpt-5.4', inworldRealtimeModel: 'openai/gpt-5.4', inworldReasoningEfforts: ['none', 'low', 'high', 'xhigh'], codexReasoningEffort: 'high', inworldToolCallingEnabled: true } }).text_generation_config.reasoning.effort",
        "const invalidReasoning = runtime.buildInworldSession({ ...base, config: { ...base.config, languageModelMode: 'codex', languageModelProvider: 'INWORLD_CODEX', languageModelResource: 'openai/gpt-5.4', inworldRealtimeModel: 'openai/gpt-5.4', inworldReasoningEfforts: ['none', 'low', 'high', 'xhigh'], codexReasoningEffort: 'medium', inworldToolCallingEnabled: false } }, { includeTools: false }).text_generation_config",
        "const nativeWithoutReasoning = runtime.buildInworldSession({ ...base, config: { ...base.config, languageModelMode: 'inworld', languageModelProvider: 'INWORLD', languageModelResource: 'openai/gpt-4.1', inworldRealtimeModel: 'openai/gpt-4.1', inworldReasoningSupported: false } }).text_generation_config",
        "const nativeWithReasoning = runtime.buildInworldSession({ ...base, config: { ...base.config, languageModelMode: 'inworld', languageModelProvider: 'INWORLD', languageModelResource: 'anthropic/claude-sonnet-5', inworldRealtimeModel: 'anthropic/claude-sonnet-5', inworldReasoningSupported: true, inworldReasoningEfforts: ['none', 'low', 'high'] } }).text_generation_config.reasoning.effort",
        "const fast = runtime.buildInworldSession({ ...base, config: { ...base.config, languageModelMode: 'codex', languageModelProvider: 'INWORLD_CODEX', languageModelResource: 'openai/gpt-5.4', inworldRealtimeModel: 'openai/gpt-5.4', codexFastMode: true, inworldTtsConversationalEnabled: true } }, { includeTools: false }).providerData.tts",
        "console.log(JSON.stringify({ custom, system, validReasoning, toolsAndReasoning, invalidReasoning, nativeWithoutReasoning, nativeWithReasoning, fast }))",
        "process.exit(custom === 'workspace__jai' && system === 'Sarah' && validReasoning === 'HIGH' && toolsAndReasoning === 'NONE' && invalidReasoning === undefined && nativeWithoutReasoning === undefined && nativeWithReasoning === 'NONE' && fast.segmenter_strategy === 'fast_start' && fast.conversational === false ? 0 : 1)",
      ].join('; '),
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        PORT: '0',
        CALLTOOLS_DUTY_MONITOR_ENABLED: 'false',
      },
    },
  )
  if (result.status !== 0) {
    failures.push(
      `Inworld session must send custom voice IDs and system voice names: ${result.stdout || result.stderr}`,
    )
  }
}

async function fetchWithRetries(
  url,
  { attempts = 3, delayMs = 1000, timeoutMs = 5000 } = {},
) {
  let lastResponse = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    lastResponse = await fetch(url, {
      signal: AbortSignal.timeout(Math.max(250, Number(timeoutMs) || 5000)),
    }).catch((error) => ({
      ok: false,
      status: 0,
      statusText: error instanceof Error ? error.message : String(error),
      json: async () => ({}),
    }))
    if (lastResponse.ok || (lastResponse.status >= 400 && lastResponse.status < 500)) {
      return lastResponse
    }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  return lastResponse
}
