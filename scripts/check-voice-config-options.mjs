import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import * as codexClmModule from '../server/codex-clm.mjs'
import {
  fallbackCodexAuthModelOptions,
  handleCodexClmChatCompletion,
  readCodexAuthModelOptions,
  rememberCodexClmSessionContext,
  setCodexClmTimingObserver,
  setCodexClmToolExecutor,
} from '../server/codex-clm.mjs'
import {
  readHumeAgentConfig,
  readHumeConfigOptions,
  syncHumeAgentConfig,
} from '../server/hume-configs.mjs'
import {
  ensureInworldRuntimeConfigReady,
  readInworldConfigOptions,
  resolveInworldReasoningEffort,
} from '../server/inworld-configs.mjs'
import { buildSpeakAgentContract } from '../server/agent-contract.mjs'
import {
  speakFunctionTools,
  speakInworldToolDefinitions,
} from '../server/hume-tools.mjs'
import {
  getInworldCodexRouterModel,
  isCodexAuthLanguageModel,
  missingForVoiceSession,
  normalizeCampaignConfig,
} from '../server/runtime-config.mjs'
import { getHumeApiKey } from '../server/secrets.mjs'

const failures = []

const humeConfigSource = fs.readFileSync('src/voiceConfigOptions.ts', 'utf8')
const humeConfigServerSource = fs.readFileSync('server/hume-configs.mjs', 'utf8')
const serverIndexSource = fs.readFileSync('server/index.mjs', 'utf8')
const agentConfigWorkspaceSource = fs.readFileSync('src/AgentConfigWorkspace.tsx', 'utf8')
const agentConfigsSource = fs.readFileSync('src/agentConfigs.ts', 'utf8')
const speakSettingsSource = fs.readFileSync('src/SpeakSettingsPanel.tsx', 'utf8')
const inworldConfigSource = fs.readFileSync('server/inworld-configs.mjs', 'utf8')
const configOptionsDoc = fs.readFileSync('docs/configuration-options.md', 'utf8')
const fallbackCodexOptions = fallbackCodexAuthModelOptions()
const codexOptions = await readCodexAuthModelOptions()
const humeOptions = getHumeApiKey() ? await readHumeConfigOptions() : null
const inworldOptions = await readInworldConfigOptions()
const contract = buildSpeakAgentContract({
  basePath: process.env.BASE_PATH || '/speak',
  publicBaseUrl: process.env.PUBLIC_BASE_URL || 'https://speak.example.com/speak',
})
const agentManual = fs.readFileSync('AGENTS.md', 'utf8')

verifyBrowserVoiceOnlyReadiness()

function verifyBrowserVoiceOnlyReadiness() {
  const envNames = [
    'HUME_API_KEY',
    'CALLTOOLS_API_KEY',
    'CALLTOOLS_MEDIA_GATEWAY_SHARED_SECRET',
    'TELNYX_API_KEY',
    'TELNYX_CONNECTION_ID',
    'TELNYX_FROM_NUMBER',
    'WORKSPACE_EMAIL_ACCOUNT',
  ]
  const original = Object.fromEntries(envNames.map((name) => [name, process.env[name]]))
  try {
    process.env.HUME_API_KEY = 'qa-hume-key'
    envNames.slice(1).forEach((name) => delete process.env[name])
    const missing = missingForVoiceSession(
      normalizeCampaignConfig({
        voiceRuntimeProvider: 'hume',
        languageModelMode: 'hume',
        humeConfigId: 'qa-hume-config',
        dialerProvider: 'calltools',
        calltoolsAgentBinding: {},
      }),
    )
    if (missing.length > 0) {
      failures.push(
        `Browser Playground must not require CallTools, Telnyx, SMS, or email readiness: ${missing.join(', ')}`,
      )
    }
  } finally {
    envNames.forEach((name) => restoreEnvironmentValue(name, original[name]))
  }
}

const expectedHumeNativeModels = [
  'GOOGLE:gemini-2.5-flash',
  'OPEN_AI:gpt-4.1',
  'OPEN_AI:gpt-4.1-priority',
  'ANTHROPIC:claude-sonnet-4-6',
  'ANTHROPIC:claude-sonnet-4-5-20250929',
  'ANTHROPIC:claude-haiku-4-5-20251001',
  'OPEN_AI:gpt-5',
  'OPEN_AI:gpt-5-priority',
  'OPEN_AI:gpt-5-mini',
  'OPEN_AI:gpt-5-mini-priority',
  'OPEN_AI:gpt-5-nano',
  'OPEN_AI:gpt-5-nano-priority',
  'OPEN_AI:gpt-5.1',
  'OPEN_AI:gpt-5.1-priority',
  'OPEN_AI:gpt-5.2',
  'OPEN_AI:gpt-5.2-priority',
  'SAMBANOVA:Llama-4-Maverick-17B-128E-Instruct',
  'OPEN_AI:gpt-4o',
  'OPEN_AI:gpt-4o-priority',
  'SAMBANOVA:Qwen3-32B',
  'SAMBANOVA:DeepSeek-R1-Distill-Llama-70B',
  'CEREBRAS:gpt-oss-120b',
  'X_AI:grok-4-fast-non-reasoning-latest',
]
const knownHumeNativeToolIncompatibleModels = [
  'ANTHROPIC:claude-opus-4-6',
]
const expectedFallbackCodexModels = fallbackCodexOptions.map((option) => option.value)
const expectedCodexModels = codexOptions.map((option) => option.value)
const inworldNativeModelResources = new Set(
  inworldOptions.languageModels.map((option) => option.modelResource).filter(Boolean),
)
const expectedInworldCodexModels = expectedCodexModels
  .map(inworldCodexModelResource)
  .filter((model) => inworldNativeModelResources.has(model))

expectedHumeNativeModels.forEach((model) => {
  if (!humeConfigSource.includes(`'${model}'`)) {
    failures.push(`Hume fallback native options missing ${model}`)
  }
})

knownHumeNativeToolIncompatibleModels.forEach((model) => {
  if (humeConfigSource.includes(`'${model}'`)) {
    failures.push(`Hume fallback native options expose tool-incompatible model ${model}`)
  }
  if (humeOptions?.languageModels.some((option) => option.value === model)) {
    failures.push(`Hume live native options expose tool-incompatible model ${model}`)
  }
})

expectedFallbackCodexModels.forEach((model) => {
  if (!humeConfigSource.includes(`value: '${model}'`)) {
    failures.push(`Hume Codex-auth fallback options missing ${model}`)
  }
})

const inworldCodexValues = new Set(inworldOptions.codexAuthModels.map((option) => option.value))
expectedInworldCodexModels.forEach((model) => {
  if (!inworldCodexValues.has(model)) {
    failures.push(`Inworld Codex-auth options missing ${model}`)
  }
})

inworldOptions.codexAuthModels.forEach((option) => {
  if (option.runtimeProvider !== 'inworld') {
    failures.push(`Inworld Codex option ${option.value} missing runtimeProvider=inworld`)
  }
  if (option.modelProvider !== 'INWORLD_CODEX') {
    failures.push(`Inworld Codex option ${option.value} missing modelProvider=INWORLD_CODEX`)
  }
  if (option.value !== option.modelResource) {
    failures.push(`Inworld Codex option ${option.value} value/modelResource mismatch`)
  }
  if (!isInworldCodexModelResource(option.value)) {
    failures.push(`Inworld Codex option ${option.value} is not a valid routed model ID`)
  }
  if (!inworldNativeModelResources.has(option.value)) {
    failures.push(`Inworld Codex option ${option.value} is absent from the live Inworld catalog`)
  }
  if (!Array.isArray(option.reasoningEfforts) || !option.reasoningEfforts.includes('none')) {
    failures.push(`Inworld Codex option ${option.value} is missing provider reasoning efforts`)
  }
  if (option.functionCallingSupported !== true) {
    failures.push(`Inworld Codex option ${option.value} cannot support required shared tools`)
  }
  if (option.reasoningSupported !== true) {
    failures.push(`Inworld Codex option ${option.value} is missing reasoning capability proof`)
  }
})

const inworldNativeValues = inworldOptions.languageModels.map((option) => option.value)
if (!inworldNativeValues.some((value) => value.startsWith('INWORLD:'))) {
  failures.push('Inworld native options missing INWORLD:* model entries')
}
if (inworldNativeValues.some((value) => value.startsWith('openai/gpt-'))) {
  failures.push('Inworld native options must keep INWORLD: prefix distinct from Codex auth')
}
inworldOptions.languageModels.forEach((option) => {
  if (option.functionCallingSupported !== true) {
    failures.push(`Inworld native option ${option.value} cannot support required shared tools`)
  }
  if (typeof option.reasoningSupported !== 'boolean') {
    failures.push(`Inworld native option ${option.value} is missing reasoning capability metadata`)
  }
  if (!Array.isArray(option.reasoningEfforts)) {
    failures.push(`Inworld native option ${option.value} is missing reasoning effort metadata`)
  }
})

for (const snippet of [
  'buildInworldNativeModelOptions',
  'inworldModelSupportsFunctionCalling(model)',
  'inworldModelSupportsTextSession',
  'inworldModelSupportsReasoning(model)',
  'SPEAK_REQUIRES_INWORLD_FUNCTION_TOOLS',
  'INWORLD_MODEL_CATALOG_TIMEOUT_MS',
  'INWORLD_OPTIONS_CATALOG_TIMEOUT_MS',
  'INWORLD_OPTIONS_CATALOG_ATTEMPTS',
  'AbortSignal.timeout(timeoutMs)',
  'INWORLD_MODEL_CATALOG_STALE_MS',
  'validatedInworldModelCatalog',
]) {
  if (!inworldConfigSource.includes(snippet)) {
    failures.push(`Inworld native capability filtering missing source snippet: ${snippet}`)
  }
}
for (const snippet of [
  'prewarmInworldModelCatalog()',
  'allowStale: true',
]) {
  if (!serverIndexSource.includes(snippet)) {
    failures.push(`Inworld call hot path missing bounded catalogue prewarm guard: ${snippet}`)
  }
}
if (
  !/createCallToolsGatewayState[\s\S]*ensureInworldRuntimeConfigReady\(\s*runtimeConfig[\s\S]*createCallState\(/.test(
    serverIndexSource,
  )
) {
  failures.push(
    'Native CallTools campaign invites must preflight the selected Inworld model before creating call state',
  )
}
for (const [pattern, label] of [
  [
    /personal-phone\/inbound\/handoffs[\s\S]*ensureVoiceRuntimeReady\(runtimeConfig[\s\S]*personalPhoneInboundHandoffs\.prepare/,
    'Personal Phone inbound handoff',
  ],
  [
    /answerInboundCallWithAutomation[\s\S]*ensureVoiceRuntimeReady\(runtimeConfig(?:,\s*\{[\s\S]{0,180}\})?\)[\s\S]*actions\/answer/,
    'Telnyx inbound automation',
  ],
]) {
  if (!pattern.test(serverIndexSource)) {
    failures.push(`${label} must preflight the selected Inworld model before provider mutation`)
  }
}

const inboundAutomationSource = serverIndexSource.slice(
  serverIndexSource.indexOf('async function answerInboundCallWithAutomation('),
  serverIndexSource.indexOf('async function recordAutomationFailure('),
)
const inboundRuntimeReadyIndex = inboundAutomationSource.indexOf(
  'runtimeConfig = await ensureVoiceRuntimeReady(runtimeConfig',
)
const inboundMissingIndex = inboundAutomationSource.indexOf(
  'const missing = missingForCall(runtimeConfig)',
)
const inboundAnswerIndex = inboundAutomationSource.indexOf('/actions/answer`')
if (
  inboundRuntimeReadyIndex < 0 ||
  inboundMissingIndex < 0 ||
  inboundAnswerIndex < 0 ||
  inboundRuntimeReadyIndex > inboundMissingIndex ||
  inboundRuntimeReadyIndex > inboundAnswerIndex
) {
  failures.push(
    'Default-off inbound Telnyx automation must prove shared voice readiness before missing checks and answer mutation',
  )
}
if (
  !/recoverInworldModelPlanRestriction[\s\S]*ensureInworldRuntimeConfigReady\(state\.config[\s\S]*sendInworldSessionUpdate\(state\)/.test(
    serverIndexSource,
  )
) {
  failures.push(
    'Inworld model-plan recovery must validate the fallback and preserve shared tools before retrying',
  )
}

if (!inworldConfigSource.includes('nextPageToken')) {
  failures.push('Inworld voice options must follow List Voices pagination')
}
if (!inworldConfigSource.includes("pageSize: '2000'")) {
  failures.push('Inworld voice options must request the List Voices max page size')
}
if (inworldConfigSource.includes('defaultInworldVoiceOptions')) {
  failures.push('Inworld selectable voice options must not use static fallback voices')
}
for (const snippet of [
  "cache: 'no-store'",
  'speakOptionsRequestRef.current?.abort()',
  'if (settingsOpen) void loadSpeakOptions()',
  "window.addEventListener('focus', refreshSpeakOptions)",
  "document.addEventListener('visibilitychange', refreshVisibleSpeakOptions)",
  'await Promise.all([refreshProfileFromHume(draft), loadSpeakOptions()])',
  'retainFailedRuntimeOptions',
  'Showing the last available catalogue',
]) {
  if (!agentConfigWorkspaceSource.includes(snippet)) {
    failures.push(`Playground provider options missing freshness guard: ${snippet}`)
  }
}
for (const route of ['speak-options', 'hume-options', 'inworld-options']) {
  const routeSource = exactExpressRouteSource(
    serverIndexSource,
    'get',
    `/api/agent-configs/${route}`,
  )
  if (!routeSource.includes("response.set('Cache-Control', 'no-store')")) {
    failures.push(`${route} response must disable catalog caching`)
  }
}
for (const route of [
  '/api/profiles',
  '/api/agent-configs/speak/:configId',
  '/api/agent-configs/hume/:configId',
  '/api/agent-configs/inworld/:configId',
]) {
  const routeSource = exactExpressRouteSource(serverIndexSource, 'get', route)
  if (!routeSource.includes("response.set('Cache-Control', 'no-store')")) {
    failures.push(`${route} response must disable saved-config caching`)
  }
}
for (const snippet of [
  'error instanceof HumeConfigSyncError && error.status === 404',
  'humeConfigTemplate(requestedName, runtimeConfig)',
  'withAvailableHumeVoice(runtimeConfig)',
  'humeVoiceProvider: resolvedVoice.provider',
  "No Hume voices are available for the active API key.",
]) {
  if (!humeConfigServerSource.includes(snippet)) {
    failures.push(`Hume config sync missing account-switch recovery guard: ${snippet}`)
  }
}
for (const snippet of [
  'runtimeConfig = await ensureVoiceRuntimeReady(runtimeConfig',
  'async function ensureVoiceProviderConfigReady(runtimeConfig)',
  'if (isInworldRuntime(runtimeConfig))',
  'ensureInworldRuntimeConfigReady(runtimeConfig)',
  'syncSpeakAgentConfig({',
  'ownedUpdates: VOICE_PROVIDER_SYNC_SECTIONS',
  'persistRecoveredVoiceConfig(runtimeConfig, syncedConfig, syncResult)',
]) {
  if (!serverIndexSource.includes(snippet)) {
    failures.push(`Playground start missing Hume account-switch recovery guard: ${snippet}`)
  }
}
for (const snippet of [
  'rememberCodexClmSessionContext(state.callControlId',
  'custom_session_id: state.callControlId',
]) {
  if (!serverIndexSource.includes(snippet)) {
    failures.push(`Hume Codex session correlation missing shared call ID: ${snippet}`)
  }
}
for (const snippet of [
  'const VOICE_PROVIDER_SYNC_SECTIONS = Object.freeze({',
  'name: true',
  'prompt: true',
  'settings: true',
  'voice: true',
]) {
  if (!serverIndexSource.includes(snippet)) {
    failures.push(`Playground provider reconciliation missing full sync section: ${snippet}`)
  }
}
if (/if \(workspaceSaved && workspaceProfile\) return workspaceProfile/.test(agentConfigWorkspaceSource)) {
  failures.push('Playground must not start from a workspace-only profile after provider sync fails')
}
if (
  !/Profile saved\. Speak sync failed:[\s\S]{0,500}return null/.test(
    agentConfigWorkspaceSource,
  )
) {
  failures.push('Playground profile save must fail closed after provider sync fails')
}
if (
  /syncResult\.action !== 'created' && syncedConfigId === originalConfigId/.test(
    serverIndexSource,
  )
) {
  failures.push('Playground must persist versioned provider proof when the config ID is unchanged')
}
for (const snippet of [
  'function voiceProviderProofChanged(originalConfig, syncedConfig, syncResult)',
  'originalConfig.humeConfigVersion',
  'syncedConfig.humeConfigVersion',
  "syncResult.action === 'versioned'",
]) {
  if (!serverIndexSource.includes(snippet)) {
    failures.push(`Playground recovered provider proof missing persistence guard: ${snippet}`)
  }
}
const providerProofChangedSource = serverIndexSource.slice(
  serverIndexSource.indexOf('function voiceProviderProofChanged'),
  serverIndexSource.indexOf('async function resolveSavedProfileForRuntimeConfig'),
)
if (providerProofChangedSource.includes('humeConfigSyncedAt')) {
  failures.push(
    'Voice-provider read timestamps must not rewrite the saved profile after every unchanged sync',
  )
}
if (
  !/runtimeConfig = await ensureVoiceRuntimeReady\(runtimeConfig[\s\S]*createCallState\(/.test(
    serverIndexSource,
  )
) {
  failures.push('Playground start must recover stale provider config before creating a test session')
}
const callsStartRoute = exactExpressRouteSource(serverIndexSource, 'post', '/api/calls/start')
const callStartSyncIndex = callsStartRoute.indexOf(
  'runtimeConfig = await ensureVoiceRuntimeReady(runtimeConfig',
)
const callStartTelnyxMutationIndex = callsStartRoute.indexOf(
  "fetch(`${TELNYX_API_BASE}/calls`,",
)
if (
  callStartSyncIndex < 0 ||
  callStartTelnyxMutationIndex < 0 ||
  callStartSyncIndex > callStartTelnyxMutationIndex
) {
  failures.push('Phone call start must reconcile the selected voice provider before Telnyx mutation')
}
if (
  !callsStartRoute.includes('error instanceof CodexClmReadinessError') ||
  !callsStartRoute.includes('response.status(error.status)') ||
  !callsStartRoute.includes('code: error.code')
) {
  failures.push(
    'Phone call start must preserve fail-closed Codex readiness 429/503 proof instead of flattening it to 500',
  )
}
if (
  callsStartRoute.includes('ensureCallToolsAgentSessionReadiness({') ||
  !/isCallToolsDialer\(runtimeConfig\)[\s\S]*calltools_direct_start_disabled/.test(callsStartRoute)
) {
  failures.push(
    'Direct CallTools starts must fail before provider mutation; campaign availability owns the CallTools path',
  )
}
const callToolsAgentSessionRoute = exactExpressRouteSource(
  serverIndexSource,
  'post',
  '/api/calltools/agent-session',
)
const dutySyncIndex = callToolsAgentSessionRoute.indexOf(
  'config = await ensureVoiceRuntimeReady(config,',
)
const dutyMutationIndex = callToolsAgentSessionRoute.indexOf(
  'ensureCallToolsAgentSessionReadiness({',
)
if (
  !callToolsAgentSessionRoute.includes('const prepareAgentSession = targetReady && apply') ||
  !callToolsAgentSessionRoute.includes('prepare: prepareAgentSession') ||
  !callToolsAgentSessionRoute.includes('mutate: mutateAgentSession') ||
  !callToolsAgentSessionRoute.includes('agentProfileId: profile.id') ||
  !callToolsAgentSessionRoute.includes('agentProfileName: profile.name') ||
  !callToolsAgentSessionRoute.includes('callToolsCodexReadinessRefreshOptions()') ||
  dutySyncIndex < 0 ||
  dutyMutationIndex < 0 ||
  dutySyncIndex > dutyMutationIndex
) {
  failures.push(
    'CallTools Go available must reconcile the identified profile before arming AgentStatus',
  )
}
if (
  !configOptionsDoc.includes('/api/config-tests/start') ||
  !configOptionsDoc.includes('persists the replacement config back to the saved profile')
) {
  failures.push('configuration docs must document Playground stale Hume config recovery')
}
if (!humeConfigSource.includes('voices: []')) {
  failures.push('Hume frontend fallback options must not synthesize static voice choices')
}
for (const snippet of [
  'const currentVoiceUnavailable = currentVoiceMissing && voiceOptions.length > 0',
  'const voiceSelectValue = selectedVoice ? currentVoiceKey :',
  'if (!value) return',
  'Saved voice unavailable',
]) {
  if (!speakSettingsSource.includes(snippet)) {
    failures.push(`Speak settings voice dropdown missing stale-voice guard: ${snippet}`)
  }
}
if (humeOptions) {
  const humeLibraryVoices = humeOptions.voices.filter((option) => option.provider === 'HUME_AI')
  const humeCustomVoices = humeOptions.voices.filter((option) => option.provider === 'CUSTOM_VOICE')
  if (humeLibraryVoices.length < 100) {
    failures.push(`Hume library options unexpectedly low: ${humeLibraryVoices.length}`)
  }
  if (humeOptions.voices.some((option) => !['HUME_AI', 'CUSTOM_VOICE'].includes(option.provider))) {
    failures.push('Hume voice options must preserve HUME_AI or CUSTOM_VOICE provider values')
  }
  if (humeCustomVoices.some((option) => !option.id && !option.name)) {
    failures.push('Hume custom voice options must be selectable by id or name')
  }
}
const inworldVoiceValues = new Set(inworldOptions.voices.map((option) => option.value))
if (process.env.INWORLD_API_KEY && !inworldVoiceValues.has('INWORLD_SYSTEM:Dennis')) {
  failures.push('Inworld authenticated voice options missing Dennis system voice')
}
if (inworldOptions.voices.some((option) => option.runtimeProvider !== 'inworld')) {
  failures.push('Inworld voice options must include runtimeProvider=inworld')
}
verifyNoCredentialVoiceFallback()
verifyInworldToolCallingDefaults()
verifyCodexModeControlContract()
verifyHumeLatencyDiagnosticsContract()
await verifyCodexClmModeForwarding()
await verifyCodexClmPromptExpansionToggle()
await verifyCodexClmUpstreamFailureStatus()
await verifyCodexClmInitialResponseTimeout()
await verifyCodexClmTerminalFinishLatency()
await verifyCodexClmConcurrentDuplicateCoalescing()
await verifyCodexClmStartReadiness()
await verifyMockedHumeCodexToolExecution()
await verifyMockedHumeNativeToolCompatibility()
await verifyMockedHumeNativeToolSync()
await verifyMockedHumeCodexToolSync()
await verifyMockedHumeVoicePagination()
await verifyMockedInworldVoicePagination()

const voiceRuntime = contract.runtime?.voiceRuntime
if (!voiceRuntime?.providers?.includes('hume') || !voiceRuntime.providers.includes('inworld')) {
  failures.push('agent contract runtime voice providers missing hume/inworld')
}
if (!voiceRuntime?.modelSelectionInvariant?.includes('native') ||
    !voiceRuntime?.modelSelectionInvariant?.includes('Codex')) {
  failures.push('agent contract missing native/Codex model selection invariant')
}
if (!contract.mcpGeneration?.validationCommands?.includes('npm run qa:voice-configs')) {
  failures.push('agent contract validation commands missing npm run qa:voice-configs')
}

if (agentManual.includes('baseline EVI settings')) {
  failures.push('AGENTS.md must describe profile sync with runtime-specific baseline settings, not Hume-only EVI settings')
}
verifyDocumentedCodexModelCatalogue({
  codexModels: expectedCodexModels,
  inworldCodexModels: expectedInworldCodexModels,
})

if (failures.length > 0) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        failures,
        codexOptions: expectedCodexModels,
        inworldCodexOptions: inworldOptions.codexAuthModels.map((option) => option.value),
      },
      null,
      2,
    ),
  )
  process.exitCode = 1
} else {
  console.log(
    JSON.stringify(
      {
        ok: true,
        humeNativeFallbacks: expectedHumeNativeModels,
        humeVoices: humeOptions
          ? {
              total: humeOptions.voices.length,
              library: humeOptions.voices.filter((option) => option.provider === 'HUME_AI').length,
              custom: humeOptions.voices.filter((option) => option.provider === 'CUSTOM_VOICE').length,
            }
          : null,
        codexAuthModels: expectedCodexModels,
        inworldCodexAuthModels: inworldOptions.codexAuthModels.map((option) => option.value),
        inworldNativeModels: inworldOptions.languageModels.length,
        inworldVoices: inworldOptions.voices.length,
      },
      null,
      2,
    ),
  )
}

function inworldCodexModelResource(value) {
  const model = String(value || '').trim()
  if (!model) return ''
  if (model.startsWith('openai/') || model.startsWith('inworld/')) return model
  if (/^gpt-/i.test(model)) return `openai/${model}`
  return model
}

function isInworldCodexModelResource(value) {
  const model = String(value || '').trim()
  return /^openai\/gpt-/i.test(model) || model.startsWith('inworld/')
}

function verifyDocumentedCodexModelCatalogue() {
}

function verifyNoCredentialVoiceFallback() {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      [
        "import { readInworldConfigOptions } from './server/inworld-configs.mjs';",
        'const options = await readInworldConfigOptions();',
        'console.log(JSON.stringify({ voices: options.voices.length }));',
      ].join(' '),
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        INWORLD_API_KEY: '',
        PATH: '',
        USER: '__speak-no-keychain-user__',
      },
    },
  )
  if (result.status !== 0) {
    failures.push(`Inworld no-credential voice fallback check failed: ${result.stderr || result.stdout}`)
    return
  }
  const payload = JSON.parse(result.stdout || '{}')
  if (payload.voices !== 0) {
    failures.push(`Inworld no-credential voice options must be empty, saw ${payload.voices}`)
  }
}

function verifyInworldToolCallingDefaults() {
  const original = process.env.INWORLD_TOOL_CALLING_ENABLED
  delete process.env.INWORLD_TOOL_CALLING_ENABLED
  try {
    const defaultConfig = normalizeCampaignConfig({
      voiceRuntimeProvider: 'inworld',
    })
    if (defaultConfig.inworldToolCallingEnabled !== true) {
      failures.push('Inworld profiles must enable shared Speak tools when the setting is unset')
    }
    const defaultToolNames = defaultConfig.inworldToolCallingEnabled
      ? speakInworldToolDefinitions().map((tool) => tool.name)
      : []
    for (const name of ['send_text_message', 'send_email']) {
      if (!defaultToolNames.includes(name)) {
        failures.push(`Default Inworld sessions missing shared Speak tool ${name}`)
      }
    }

    const explicitlyDisabled = normalizeCampaignConfig({
      voiceRuntimeProvider: 'inworld',
      inworldToolCallingEnabled: false,
    })
    if (explicitlyDisabled.inworldToolCallingEnabled !== false) {
      failures.push('Inworld profiles must preserve an explicit tool-calling disable override')
    }
    const explicitlyDisabledToolNames = explicitlyDisabled.inworldToolCallingEnabled
      ? speakInworldToolDefinitions().map((tool) => tool.name)
      : []
    if (explicitlyDisabledToolNames.length > 0) {
      failures.push('Explicitly disabled Inworld sessions must not receive shared Speak tools')
    }
  } finally {
    restoreEnvironmentValue('INWORLD_TOOL_CALLING_ENABLED', original)
  }
}

function verifyCodexModeControlContract() {
  for (const [label, legacyControls] of [
    ['missing', {}],
    [
      'legacy',
      {
        codexReasoningEffort: '',
        codexFastMode: '',
      },
    ],
  ]) {
    for (const voiceRuntimeProvider of ['hume', 'inworld']) {
      const normalized = normalizeCampaignConfig({
        voiceRuntimeProvider,
        languageModelMode: 'codex',
        ...(voiceRuntimeProvider === 'inworld'
          ? {
              languageModelProvider: 'INWORLD_CODEX',
              languageModelResource: 'openai/gpt-5.4',
              inworldRealtimeModel: 'openai/gpt-5.4',
            }
          : {}),
        ...legacyControls,
      })
      if (
        normalized.codexReasoningEffort !== 'none' ||
        normalized.codexFastMode !== true
      ) {
        failures.push(
          `${voiceRuntimeProvider} Codex ${label} controls must normalize to reasoning none plus Fast mode`,
        )
      }
    }
  }

  const explicitControls = normalizeCampaignConfig({
    voiceRuntimeProvider: 'hume',
    languageModelMode: 'codex',
    codexReasoningEffort: 'low',
    codexFastMode: false,
  })
  if (
    explicitControls.codexReasoningEffort !== 'low' ||
    explicitControls.codexFastMode !== false
  ) {
    failures.push('Codex normalization must preserve explicit nonzero reasoning and Fast=false overrides')
  }

  const defaultInworldToolsReasoning = resolveInworldReasoningEffort({
    model: 'openai/gpt-5.4',
    requested: normalizeCampaignConfig({
      voiceRuntimeProvider: 'inworld',
      languageModelMode: 'codex',
      languageModelProvider: 'INWORLD_CODEX',
      languageModelResource: 'openai/gpt-5.4',
    }).codexReasoningEffort,
    supportedEfforts: ['none', 'low', 'high'],
    toolsEnabled: true,
  })
  if (defaultInworldToolsReasoning !== 'NONE') {
    failures.push('Inworld Codex sessions with shared tools must keep reasoning at NONE')
  }

  for (const model of expectedCodexModels) {
    const humeConfig = normalizeCampaignConfig({
      voiceRuntimeProvider: 'hume',
      languageModelMode: 'codex',
      codexAuthModel: model,
      codexReasoningEffort: 'xhigh',
      codexFastMode: true,
    })
    if (
      !isCodexAuthLanguageModel(humeConfig) ||
      humeConfig.codexAuthModel !== model ||
      humeConfig.codexReasoningEffort !== 'xhigh' ||
      humeConfig.codexFastMode !== true
    ) {
      failures.push(`Hume Codex controls did not survive normalization for ${model}`)
    }

    const inworldModel = inworldCodexModelResource(model)
    const inworldConfig = normalizeCampaignConfig({
      voiceRuntimeProvider: 'inworld',
      languageModelMode: 'codex',
      languageModelProvider: 'INWORLD_CODEX',
      languageModelResource: inworldModel,
      inworldRealtimeModel: inworldModel,
      codexReasoningEffort: 'xhigh',
      codexFastMode: true,
    })
    if (
      !isCodexAuthLanguageModel(inworldConfig) ||
      inworldConfig.languageModelResource !== inworldModel ||
      getInworldCodexRouterModel(inworldConfig) !== inworldModel ||
      inworldConfig.codexReasoningEffort !== 'xhigh' ||
      inworldConfig.codexFastMode !== true
    ) {
      failures.push(`Inworld Codex controls did not survive normalization for ${inworldModel}`)
    }
  }

  for (const snippet of [
    'Reasoning effort',
    'Fast mode',
    "languageModelMode === 'codex' && (",
    'codexReasoningEffort',
    'codexFastMode',
    'Hume requests priority Codex service.',
    'Inworld keeps reasoning at None while shared tools are active',
  ]) {
    if (!speakSettingsSource.includes(snippet)) {
      failures.push(`Speak settings missing Codex mode control: ${snippet}`)
    }
  }

  for (const snippet of [
    'inworldReasoningEffort(state.config)',
    "config.inworldReasoningEfforts.includes('none')",
    "? 'fast_start'",
    'codexReasoningEffort: state.config.codexReasoningEffort',
    'codexFastMode: state.config.codexFastMode',
  ]) {
    if (!serverIndexSource.includes(snippet)) {
      failures.push(`Voice runtime missing Codex mode forwarding: ${snippet}`)
    }
  }

  for (const snippet of [
    '`codexReasoningEffort`',
    '`codexFastMode`',
    'priority service tier',
    '`fast_start`',
  ]) {
    if (!configOptionsDoc.includes(snippet)) {
      failures.push(`Configuration reference missing Codex mode documentation: ${snippet}`)
    }
  }
}

async function verifyCodexClmStartReadiness() {
  const assertReady = codexClmModule.assertCodexClmRuntimeReady
  const resetReadinessCache = codexClmModule.resetCodexClmReadinessCacheForTests
  if (typeof assertReady !== 'function') {
    failures.push(
      'Hume Codex Browser/Phone starts are missing a fail-closed local Codex proxy readiness preflight',
    )
    return
  }
  if (typeof resetReadinessCache !== 'function') {
    failures.push('Codex proxy readiness is missing a deterministic cache reset for regression tests')
    return
  }

  const originalProxyBaseUrl = process.env.CODEX_AUTH_PROXY_BASE_URL
  process.env.CODEX_AUTH_PROXY_BASE_URL = 'http://127.0.0.1:48765/v1'
  const requestedUrls = []
  const unavailableFetch = async (input) => {
    requestedUrls.push(String(input))
    return new Response(JSON.stringify({
      ok: false,
      allowed: false,
      code: 'codex_reauth_required',
      model: 'gpt-5.6-sol',
      model_available: true,
      cached: false,
    }), {
      headers: { 'Content-Type': 'application/json' },
      status: 503,
    })
  }

  try {
    let unavailableError = null
    try {
      await assertReady(
        {
          voiceRuntimeProvider: 'hume',
          languageModelMode: 'codex',
          codexAuthModel: 'gpt-5.6-sol',
        },
        { fetchImpl: unavailableFetch, forceRefresh: true },
      )
    } catch (error) {
      unavailableError = error
    }
    if (
      unavailableError?.status !== 503 ||
      unavailableError?.code !== 'codex_reauth_required' ||
      unavailableError?.dependency !== 'codex_auth_proxy' ||
      !/Codex-auth.*authentication/i.test(String(unavailableError?.message || '')) ||
      requestedUrls[0] !==
        'http://127.0.0.1:48765/v1/readiness?model=gpt-5.6-sol&force=1'
    ) {
      failures.push(
        `Hume Codex start readiness must fail closed with an actionable 503 before provider start: ${JSON.stringify({
          code: unavailableError?.code,
          dependency: unavailableError?.dependency,
          message: unavailableError?.message,
          requestedUrls,
          status: unavailableError?.status,
        })}`,
      )
    }

    let quotaError = null
    try {
      await assertReady(
        {
          voiceRuntimeProvider: 'hume',
          languageModelMode: 'codex',
          codexAuthModel: 'gpt-5.6-sol',
        },
        {
          fetchImpl: async () => new Response(JSON.stringify({
            ok: false,
            allowed: false,
            code: 'usage_limit_reached',
            model: 'gpt-5.6-sol',
            model_available: true,
            cached: false,
            reset_at: '2026-07-16T04:00:00.000Z\nunsafe-detail',
          }), {
            headers: { 'Content-Type': 'application/json' },
            status: 503,
          }),
          forceRefresh: true,
        },
      )
    } catch (error) {
      quotaError = error
    }
    if (
      quotaError?.status !== 429 ||
      quotaError?.code !== 'usage_limit_reached' ||
      quotaError?.resetAt !== '2026-07-16T04:00:00.000Z unsafe-detail' ||
      !/usage limit/i.test(String(quotaError?.message || '')) ||
      !/2026-07-16T04:00:00.000Z unsafe-detail/.test(
        String(quotaError?.message || ''),
      )
    ) {
      failures.push(
        `Codex quota exhaustion must fail closed as a sanitized actionable 429: ${JSON.stringify({
          code: quotaError?.code,
          message: quotaError?.message,
          resetAt: quotaError?.resetAt,
          status: quotaError?.status,
        })}`,
      )
    }

    let missingModelError = null
    try {
      await assertReady(
        {
          voiceRuntimeProvider: 'hume',
          languageModelMode: 'codex',
          codexAuthModel: 'gpt-5.6-sol',
        },
        {
          fetchImpl: async () => new Response(JSON.stringify({
            ok: false,
            allowed: false,
            code: 'model_unavailable',
            model: 'gpt-5.6-sol',
            model_available: false,
            cached: false,
          }), {
            headers: { 'Content-Type': 'application/json' },
            status: 503,
          }),
          forceRefresh: true,
        },
      )
    } catch (error) {
      missingModelError = error
    }
    if (
      missingModelError?.status !== 503 ||
      missingModelError?.code !== 'model_unavailable' ||
      missingModelError?.modelAvailable !== false ||
      !/does not currently expose gpt-5.6-sol/i.test(
        String(missingModelError?.message || ''),
      )
    ) {
      failures.push(
        `Missing selected Codex model must fail closed before provider start: ${JSON.stringify({
          code: missingModelError?.code,
          message: missingModelError?.message,
          modelAvailable: missingModelError?.modelAvailable,
          status: missingModelError?.status,
        })}`,
      )
    }

    let skippedFetches = 0
    const shouldNotFetch = async () => {
      skippedFetches += 1
      throw new Error('native/provider-hosted runtime touched the local Codex proxy')
    }
    for (const config of [
      { voiceRuntimeProvider: 'hume', languageModelMode: 'hume' },
      { voiceRuntimeProvider: 'inworld', languageModelMode: 'inworld' },
      {
        voiceRuntimeProvider: 'inworld',
        languageModelMode: 'codex',
        inworldRealtimeModel: 'openai/gpt-5.6-sol',
      },
    ]) {
      const result = await assertReady(config, {
        fetchImpl: shouldNotFetch,
        forceRefresh: true,
      })
      if (result?.required !== false) {
        failures.push(
          `Local Codex proxy readiness must not gate ${config.voiceRuntimeProvider}/${config.languageModelMode}`,
        )
      }
    }
    if (skippedFetches !== 0) {
      failures.push(
        `Native/Inworld runtime readiness touched the local Codex proxy ${skippedFetches} time(s)`,
      )
    }

    const available = await assertReady(
      {
        voiceRuntimeProvider: 'hume',
        languageModelMode: 'codex',
        codexAuthModel: 'gpt-5.6-sol',
      },
      {
        fetchImpl: async () => new Response(
          JSON.stringify({
            ok: true,
            allowed: true,
            code: 'ready',
            model: 'gpt-5.6-sol',
            model_available: true,
            cached: false,
          }),
          { headers: { 'Content-Type': 'application/json' }, status: 200 },
        ),
        forceRefresh: true,
      },
    )
    if (
      available?.ok !== true ||
      available?.required !== true ||
      available?.model !== 'gpt-5.6-sol' ||
      available?.allowed !== true ||
      available?.code !== 'ready' ||
      available?.modelAvailable !== true
    ) {
      failures.push(
        `Healthy Hume Codex proxy readiness proof is incomplete: ${JSON.stringify(available)}`,
      )
    }

    resetReadinessCache()
    const coldReadinessStartedAt = performance.now()
    const coldReadinessProof = await assertReady(
      {
        voiceRuntimeProvider: 'hume',
        languageModelMode: 'codex',
        codexAuthModel: 'gpt-5.6-sol',
      },
      {
        fetchImpl: (_input, init = {}) => new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            resolve(new Response(
              JSON.stringify({
                ok: true,
                allowed: true,
                code: 'ready',
                model: 'gpt-5.6-sol',
                model_available: true,
                cached: false,
              }),
              { headers: { 'Content-Type': 'application/json' }, status: 200 },
            ))
          }, 1_750)
          init.signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(init.signal.reason)
          }, { once: true })
        }),
      },
    )
    const coldReadinessElapsedMs = performance.now() - coldReadinessStartedAt
    if (
      coldReadinessProof?.ok !== true ||
      coldReadinessElapsedMs < 1_700
    ) {
      failures.push(
        `A healthy cold Codex readiness proof must survive normal VM latency: ${JSON.stringify({
          elapsedMs: Number(coldReadinessElapsedMs.toFixed(1)),
          ok: coldReadinessProof?.ok,
        })}`,
      )
    }

    resetReadinessCache()
    let cachedFetches = 0
    const cachedFetch = async () => {
      cachedFetches += 1
      return new Response(
        JSON.stringify({
          ok: true,
          allowed: true,
          code: 'ready',
          model: 'gpt-5.6-sol',
          model_available: true,
          cached: false,
        }),
        { headers: { 'Content-Type': 'application/json' }, status: 200 },
      )
    }
    const cachedConfig = {
      voiceRuntimeProvider: 'hume',
      languageModelMode: 'codex',
      codexAuthModel: 'gpt-5.6-sol',
    }
    const firstCachedProof = await assertReady(cachedConfig, {
      cacheTtlMs: 5_000,
      fetchImpl: cachedFetch,
    })
    const secondCachedProof = await assertReady(cachedConfig, {
      cacheTtlMs: 5_000,
      fetchImpl: cachedFetch,
    })
    if (
      cachedFetches !== 1 ||
      firstCachedProof?.cached === true ||
      secondCachedProof?.cached !== true
    ) {
      failures.push(
        `Healthy Codex proxy readiness must use a short success cache: ${JSON.stringify({
          cachedFetches,
          firstCached: firstCachedProof?.cached,
          secondCached: secondCachedProof?.cached,
        })}`,
      )
    }

    resetReadinessCache()
    let freshnessClock = 1_000
    let freshnessFetches = 0
    const freshnessFetch = async () => {
      freshnessFetches += 1
      return new Response(
        JSON.stringify({
          ok: true,
          allowed: true,
          code: 'ready',
          model: 'gpt-5.6-sol',
          model_available: true,
          cached: false,
        }),
        { headers: { 'Content-Type': 'application/json' }, status: 200 },
      )
    }
    await assertReady(cachedConfig, {
      cacheTtlMs: 30_000,
      fetchImpl: freshnessFetch,
      now: () => freshnessClock,
    })
    freshnessClock += 10_001
    const boundedFreshnessProof = await assertReady(cachedConfig, {
      cacheTtlMs: 10_000,
      fetchImpl: freshnessFetch,
      now: () => freshnessClock,
    })
    if (
      freshnessFetches !== 2 ||
      boundedFreshnessProof?.cached === true
    ) {
      failures.push(
        `Codex readiness callers must be able to require a fresher proof than the cache that created it: ${JSON.stringify({
          cached: boundedFreshnessProof?.cached,
          freshnessFetches,
        })}`,
      )
    }

    resetReadinessCache()
    let perModelFetches = 0
    const perModelFetch = async (input) => {
      perModelFetches += 1
      const model = new URL(String(input)).searchParams.get('model')
      return new Response(
        JSON.stringify({
          ok: true,
          allowed: true,
          code: 'ready',
          model,
          model_available: true,
          cached: false,
        }),
        { headers: { 'Content-Type': 'application/json' }, status: 200 },
      )
    }
    await assertReady(cachedConfig, { fetchImpl: perModelFetch })
    await assertReady(
      { ...cachedConfig, codexAuthModel: 'gpt-5.5' },
      { fetchImpl: perModelFetch },
    )
    const firstModelAgain = await assertReady(cachedConfig, {
      fetchImpl: perModelFetch,
    })
    if (perModelFetches !== 2 || firstModelAgain?.cached !== true) {
      failures.push(
        `Codex readiness must retain independent proof for every configured model: ${JSON.stringify({
          cached: firstModelAgain?.cached,
          perModelFetches,
        })}`,
      )
    }

    resetReadinessCache()
    await assertReady(cachedConfig, {
      cacheTtlMs: 5_000,
      fetchImpl: cachedFetch,
    })
    if (cachedFetches !== 2) {
      failures.push(
        `Resetting Codex readiness must deterministically clear the Speak cache: ${JSON.stringify({
          cachedFetches,
        })}`,
      )
    }

    let warmedThenUnavailableError = null
    try {
      await assertReady(cachedConfig, {
        cacheTtlMs: 5_000,
        fetchImpl: unavailableFetch,
        forceRefresh: true,
      })
    } catch (error) {
      warmedThenUnavailableError = error
    }
    if (warmedThenUnavailableError?.code !== 'codex_reauth_required') {
      failures.push(
        'A forced voice-runtime readiness check must reject a newly unhealthy proxy despite a warm success cache',
      )
    }

    let cacheOnlyFetchesAfterFailure = 0
    let cacheOnlyErrorAfterFailure = null
    try {
      await assertReady(cachedConfig, {
        cacheOnly: true,
        fetchImpl: async () => {
          cacheOnlyFetchesAfterFailure += 1
          throw new Error('cache-only readiness performed provider IO')
        },
      })
    } catch (error) {
      cacheOnlyErrorAfterFailure = error
    }
    if (
      cacheOnlyFetchesAfterFailure !== 0 ||
      cacheOnlyErrorAfterFailure?.code !== 'readiness_unavailable'
    ) {
      failures.push(
        `A failed forced readiness refresh must invalidate the hot-path proof without provider IO: ${JSON.stringify({
          code: cacheOnlyErrorAfterFailure?.code,
          fetches: cacheOnlyFetchesAfterFailure,
        })}`,
      )
    }

    resetReadinessCache()
    await assertReady(cachedConfig, {
      cacheTtlMs: 15_000,
      fetchImpl: cachedFetch,
      forceRefresh: true,
    })
    let healthyCacheOnlyFetches = 0
    const healthyCacheOnlyProof = await assertReady(cachedConfig, {
      cacheOnly: true,
      cacheTtlMs: 15_000,
      fetchImpl: async () => {
        healthyCacheOnlyFetches += 1
        throw new Error('cache-only readiness performed provider IO')
      },
    })
    if (
      healthyCacheOnlyFetches !== 0 ||
      healthyCacheOnlyProof?.cached !== true
    ) {
      failures.push(
        `A healthy forced readiness refresh must provide a zero-IO hot-path proof: ${JSON.stringify({
          cached: healthyCacheOnlyProof?.cached,
          fetches: healthyCacheOnlyFetches,
        })}`,
      )
    }

    resetReadinessCache()
    let releaseOlderReadiness
    let olderReadinessStarted
    const olderReadinessStartedPromise = new Promise((resolve) => {
      olderReadinessStarted = resolve
    })
    const olderReadinessPromise = assertReady(cachedConfig, {
      fetchImpl: async () => {
        olderReadinessStarted()
        return new Promise((resolve) => {
          releaseOlderReadiness = () => resolve(new Response(
            JSON.stringify({
              ok: true,
              allowed: true,
              code: 'ready',
              model: 'gpt-5.6-sol',
              model_available: true,
              cached: false,
            }),
            { headers: { 'Content-Type': 'application/json' }, status: 200 },
          ))
        })
      },
    })
    await olderReadinessStartedPromise
    try {
      await assertReady(cachedConfig, {
        fetchImpl: unavailableFetch,
        forceRefresh: true,
      })
    } catch {
      // The forced failure is expected; it must invalidate the older request.
    }
    releaseOlderReadiness()
    await olderReadinessPromise
    let resurrectedProofError = null
    try {
      await assertReady(cachedConfig, {
        cacheOnly: true,
        fetchImpl: async () => {
          throw new Error('cache-only readiness performed provider IO')
        },
      })
    } catch (error) {
      resurrectedProofError = error
    }
    if (resurrectedProofError?.code !== 'readiness_unavailable') {
      failures.push(
        'An older readiness request must not resurrect proof invalidated by a newer forced failure',
      )
    }

    const sharedReadySource = serverIndexSource.slice(
      serverIndexSource.indexOf('async function ensureVoiceRuntimeReady('),
      serverIndexSource.indexOf('function mergeSyncedSpeakRuntimeConfig('),
    )
    if (
      !sharedReadySource.includes('await assertCodexClmRuntimeReady(runtimeConfig, codexReadiness)') ||
      !sharedReadySource.includes('ensureVoiceProviderConfigReady(runtimeConfig)')
    ) {
      failures.push(
        'Shared voice runtime readiness must gate Hume Codex proxy health before provider reconciliation',
      )
    }
    const codexPrewarmSource = serverIndexSource.slice(
      serverIndexSource.indexOf('async function prewarmCodexVoiceRuntimeReadiness('),
      serverIndexSource.indexOf('async function ensureVoiceProviderConfigReady('),
    )
    const serverListenSource = serverIndexSource.slice(
      serverIndexSource.indexOf('server.listen(PORT'),
      serverIndexSource.indexOf("for (const signal of ['SIGTERM', 'SIGINT'])"),
    )
    if (
      !codexPrewarmSource.includes('await listWorkspaceProfiles()') ||
      !codexPrewarmSource.includes('assertCodexClmRuntimeReady(config)') ||
      !serverListenSource.includes('void prewarmCodexVoiceRuntimeReadiness()')
    ) {
      failures.push(
        'Speak startup must asynchronously prewarm every saved Hume Codex runtime without delaying server listen',
      )
    }

for (const [routePath, label] of [
      ['/api/config-tests/start', 'Browser Playground'],
      ['/api/calls/start', 'Phone Playground'],
    ]) {
      const routeSource = exactExpressRouteSource(serverIndexSource, 'post', routePath)
      const readinessIndex = routeSource.indexOf('await ensureVoiceRuntimeReady(runtimeConfig')
      const providerStartIndex = routePath === '/api/calls/start'
        ? routeSource.indexOf('fetch(`${TELNYX_API_BASE}/calls`')
        : routeSource.indexOf('connectVoiceSession(state)')
      if (
        readinessIndex < 0 ||
        providerStartIndex < 0 ||
        readinessIndex > providerStartIndex
      ) {
        failures.push(
          `${label} start must prove Hume Codex proxy readiness before provider mutation/session connect`,
        )
      }
      if (!routeSource.includes('syncProvider: isInworldRuntime(runtimeConfig)')) {
        failures.push(
          `${label} start must not block a saved Hume session on a configuration rewrite`,
        )
      }
    }

    const browserStartSource = exactExpressRouteSource(
      serverIndexSource,
      'post',
      '/api/config-tests/start',
    )
    if (
      !browserStartSource.includes('const missing = missingForVoiceSession(runtimeConfig)') ||
      browserStartSource.includes('missingForCall(runtimeConfig)')
    ) {
      failures.push(
        'Browser Playground must use voice-session readiness and ignore CallTools/Telnyx/delivery dependencies',
      )
    }

    const personalPhoneRoute = exactExpressRouteSource(
      serverIndexSource,
      'post',
      '/api/personal-phone/inbound/handoffs',
    )
    if (
      personalPhoneRoute.indexOf('await ensureVoiceRuntimeReady(runtimeConfig') < 0 ||
      personalPhoneRoute.indexOf('await ensureVoiceRuntimeReady(runtimeConfig') >
        personalPhoneRoute.indexOf('personalPhoneInboundHandoffs.prepare({')
    ) {
      failures.push(
        'Personal Phone must prove shared voice runtime readiness before accepting a Speak handoff',
      )
    }

    const dutyMonitorSource = serverIndexSource.slice(
      serverIndexSource.indexOf('const callToolsDutyMonitor = createCallToolsDutyMonitor({'),
      serverIndexSource.indexOf('function blockSandboxedPlaygroundDelivery('),
    )
    if (
      !dutyMonitorSource.includes('await ensureVoiceRuntimeReady(') ||
      !dutyMonitorSource.includes('callToolsCodexReadinessRefreshOptions()') ||
      dutyMonitorSource.indexOf('await ensureVoiceRuntimeReady(') >
        dutyMonitorSource.indexOf('ensureCallToolsAgentSessionReadiness({')
    ) {
      failures.push(
        'CallTools duty readiness must prove the selected voice runtime before native AgentStatus is armed',
      )
    }

    const callToolsAgentSessionRoute = exactExpressRouteSource(
      serverIndexSource,
      'post',
      '/api/calltools/agent-session',
    )
    if (
      callToolsAgentSessionRoute.indexOf('await ensureVoiceRuntimeReady(config,') < 0 ||
      callToolsAgentSessionRoute.indexOf('await ensureVoiceRuntimeReady(config,') >
        callToolsAgentSessionRoute.indexOf('setCallToolsGatewayRegistration(')
    ) {
      failures.push(
        'CallTools Available must fail closed on shared voice readiness before gateway/native mutation',
      )
    }

    const standbyReplenishmentSource = serverIndexSource.slice(
      serverIndexSource.indexOf('function scheduleCallToolsStandbyReplenishment('),
      serverIndexSource.indexOf('function claimCallToolsStandbyVoiceSession('),
    )
    if (
      !standbyReplenishmentSource.includes('await ensureVoiceRuntimeReady(') ||
      !standbyReplenishmentSource.includes('callToolsCodexReadinessRefreshOptions()')
    ) {
      failures.push('CallTools standby replenishment must recheck shared voice runtime readiness')
    }

    const callToolsInviteSource = serverIndexSource.slice(
      serverIndexSource.indexOf('async function createCallToolsGatewayState('),
      serverIndexSource.indexOf('function callToolsDutyAcceptsGatewayCall('),
    )
    const cacheOnlyInviteReadinessIndex = callToolsInviteSource.indexOf(
      'await assertCodexClmRuntimeReady(\n      runtimeConfig,\n      callToolsCodexReadinessInviteOptions(),\n    )',
    )
    const standbyCancelIndex = callToolsInviteSource.indexOf(
      "callToolsVoiceStandby.cancel('voice_runtime_unavailable')",
    )
    const standbyClaimIndex = callToolsInviteSource.indexOf(
      'claimCallToolsStandbyVoiceSession({',
    )
    if (
      cacheOnlyInviteReadinessIndex < 0 ||
      standbyCancelIndex < 0 ||
      standbyClaimIndex < 0 ||
      cacheOnlyInviteReadinessIndex > standbyClaimIndex ||
      standbyCancelIndex > standbyClaimIndex
    ) {
      failures.push(
        'CallTools invites must consume a fresh zero-IO Codex proof and cancel standby before claim/audio when readiness is unavailable',
      )
    }
    if (/forceRefresh:\s*true/.test(callToolsInviteSource)) {
      failures.push('CallTools native invites must never force provider readiness on the SIP hot path')
    }

    const callToolsReadinessHelpersSource = serverIndexSource.slice(
      serverIndexSource.indexOf('const CALLTOOLS_CODEX_READINESS_PROOF_TTL_MS'),
      serverIndexSource.indexOf('function blockSandboxedPlaygroundDelivery('),
    )
    if (
      !/function callToolsCodexReadinessRefreshOptions\(\)[\s\S]{0,220}forceRefresh:\s*true/.test(
        callToolsReadinessHelpersSource,
      ) ||
      !/function callToolsCodexReadinessInviteOptions\(\)[\s\S]{0,220}cacheOnly:\s*true/.test(
        callToolsReadinessHelpersSource,
      )
    ) {
      failures.push(
        'CallTools must separate background forced readiness refresh from cache-only native-invite proof',
      )
    }

    const normalizedConfigOptionsDoc = configOptionsDoc.replace(/\s+/g, ' ')
    for (const snippet of [
      '`GET /v1/readiness?model={model}`',
      'authenticated model availability and current usage allowance',
      'five-second request bound and a 30-second successful-result cache',
      'native invite consumes only a fresh local proof and performs no provider I/O',
      '`usage_limit_reached` becomes a sanitized HTTP `429`',
      'Hume-native and every Inworld runtime bypass this local proxy check',
    ]) {
      if (!normalizedConfigOptionsDoc.includes(snippet)) {
        failures.push(`Configuration reference missing Codex readiness contract: ${snippet}`)
      }
    }
  } finally {
    resetReadinessCache()
    restoreEnvironmentValue('CODEX_AUTH_PROXY_BASE_URL', originalProxyBaseUrl)
  }
}

function verifyHumeLatencyDiagnosticsContract() {
  for (const snippet of [
    'setCodexClmTimingObserver',
    'lastClmRequestToFirstTokenMs',
    'lastClmFirstTokenForwardingOverheadMs',
    'lastCodexClmTimingRequestSequence',
    'lastFinalUserToAssistantAudioMs',
    'estimatedLastCallerStopToAssistantAudioMs',
    'configuredTurnSilenceMs',
    'responseLatencySamplesMs',
    'callerStopLatencySamplesMs',
    'firstCallerStopToAssistantAudioMs',
    'noteFinalUserTurn(state',
    'noteFirstAssistantAudio(state',
    'noteCallerSpeechStopped(state',
    'bufferVoiceInputBeforeReady(state',
    'voice_input_pre_ready_flushed',
    'selectHumeUserInputTransport({',
    "transport === 'websocket'",
  ]) {
    if (!serverIndexSource.includes(snippet)) {
      failures.push(`Hume latency diagnostics missing runtime proof: ${snippet}`)
    }
  }
  if (serverIndexSource.includes('state.lastAssistantMessageAt >= state.lastUserFinalAt')) {
    failures.push(
      'Hume first-audio latency proof must not wait for assistant_message ordering',
    )
  }
  if (
    !/endOfTurnSilenceMs:\s*Number\(\s*Number\(value\.endOfTurnSilenceMs\)\s*===\s*650\s*\?\s*defaultCampaignConfig\.endOfTurnSilenceMs/.test(
      agentConfigsSource,
    )
  ) {
    failures.push(
      'Server-loaded Playground profiles must migrate the legacy 650 ms Hume turn silence to the 500 ms default',
    )
  }
}

async function verifyCodexClmModeForwarding() {
  const originalFetch = globalThis.fetch
  const originalToken = process.env.CODEX_CLM_API_KEY
  const upstreamBodies = []
  process.env.CODEX_CLM_API_KEY = 'qa-codex-token'

  try {
    globalThis.fetch = async (_input, options = {}) => {
      upstreamBodies.push(JSON.parse(String(options.body || '{}')))
      return new Response(
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        },
      )
    }

    for (const [index, model] of expectedCodexModels.entries()) {
      const sessionId = `qa-codex-mode-session-${index}`
      rememberCodexClmSessionContext(sessionId, {
        systemPrompt: 'QA system prompt',
      })
      const request = {
        body: {
          custom_session_id: sessionId,
          messages: [
            ...(index === 0
              ? [
                  {
                    role: 'user',
                    content: 'Earlier QA',
                    models: {
                      prosody: { scores: { OldTone: 0.99 } },
                    },
                  },
                ]
              : []),
            {
              role: 'user',
              content: 'QA',
              ...(index === 0
                ? {
                    models: {
                      prosody: {
                        scores: {
                          Overflow: 1.5,
                          '<Acting>': 0.91,
                          Interest: 0.72,
                          Concentration: 0.64,
                          Calmness: 0.55,
                          Surprise: 0.5,
                          Realization: 0.45,
                          Contemplation: 0.4,
                          Invalid: 'not-a-number',
                        },
                      },
                    },
                  }
                : {}),
            },
          ],
          model,
        },
        get(name) {
          return String(name).toLowerCase() === 'authorization'
            ? 'Bearer qa-codex-token'
            : ''
        },
        query: {},
      }
      await handleCodexClmChatCompletion(request, createMockClmResponse())

      const upstreamBody = upstreamBodies.at(-1)
      if (upstreamBody?.model !== model) {
        failures.push(`Hume Codex CLM changed selected model ${model} to ${upstreamBody?.model}`)
      }
      if (upstreamBody?.reasoning_effort !== 'none') {
        failures.push(
          `Hume Codex CLM ${model} default must forward reasoning_effort=none, saw ${upstreamBody?.reasoning_effort}`,
        )
      }
      if (upstreamBody?.service_tier !== 'priority') {
        failures.push(
          `Hume Codex CLM ${model} fast mode must forward service_tier=priority, saw ${upstreamBody?.service_tier}`,
        )
      }
      if (index === 0) {
        const userMessages = (upstreamBody?.messages || []).filter(
          (message) => message?.role === 'user',
        )
        const userMessage = userMessages.at(-1)
        const content = String(userMessage?.content || '')
        const measureText = content.match(
          /Hume vocal-expression measures[^:]+:\s*([^\]]+)/,
        )?.[1]
        const measures = String(measureText || '')
          .split(';')
          .map((value) => value.trim())
          .filter(Boolean)
        if (
          !content.includes('Hume vocal-expression measures') ||
          !content.includes('Overflow 1.000') ||
          !content.includes('Acting 0.910') ||
          !content.includes('Interest 0.720') ||
          !content.includes('Concentration 0.640') ||
          content.includes('<Acting>') ||
          content.includes('Invalid') ||
          content.includes('Realization') ||
          measures.length !== 6 ||
          String(userMessages[0]?.content || '').includes(
            'Hume vocal-expression measures',
          ) ||
          String(userMessages[0]?.content || '').includes('OldTone')
        ) {
          failures.push(
            'Hume Codex CLM must preserve bounded latest-turn prosody without prompt expansion',
          )
        }
      }
    }

    const explicitSessionId = 'qa-codex-mode-explicit-overrides'
    rememberCodexClmSessionContext(explicitSessionId, {
      systemPrompt: 'QA explicit override prompt',
      codexReasoningEffort: 'low',
      codexFastMode: false,
    })
    await handleCodexClmChatCompletion(
      {
        body: {
          custom_session_id: explicitSessionId,
          messages: [{ role: 'user', content: 'QA explicit override' }],
          model: expectedCodexModels[0],
        },
        get(name) {
          return String(name).toLowerCase() === 'authorization'
            ? 'Bearer qa-codex-token'
            : ''
        },
        query: {},
      },
      createMockClmResponse(),
    )
    const explicitUpstreamBody = upstreamBodies.at(-1)
    if (
      explicitUpstreamBody?.reasoning_effort !== 'low' ||
      explicitUpstreamBody?.service_tier !== 'default'
    ) {
      failures.push(
        `Hume Codex CLM must preserve explicit low/default overrides, saw ${explicitUpstreamBody?.reasoning_effort}/${explicitUpstreamBody?.service_tier}`,
      )
    }
  } finally {
    globalThis.fetch = originalFetch
    restoreEnvironmentValue('CODEX_CLM_API_KEY', originalToken)
  }
}

async function verifyCodexClmPromptExpansionToggle() {
  const originalFetch = globalThis.fetch
  const originalToken = process.env.CODEX_CLM_API_KEY
  const upstreamBodies = []
  process.env.CODEX_CLM_API_KEY = 'qa-codex-token'

  try {
    globalThis.fetch = async (_input, options = {}) => {
      upstreamBodies.push(JSON.parse(String(options.body || '{}')))
      return new Response(
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        },
      )
    }

    for (const promptExpansionEnabled of [false, true]) {
      const sessionId = `qa-codex-prompt-expansion-${promptExpansionEnabled}`
      rememberCodexClmSessionContext(sessionId, {
        systemPrompt: 'QA Speak\nsystem prompt.',
        promptExpansionEnabled,
      })
      const providerExpandedPrompt =
        'QA Speak system prompt.\n\nQA Hume supplemental voice expansion.'
      await handleCodexClmChatCompletion(
        {
          body: {
            custom_session_id: sessionId,
            model: expectedCodexModels[0],
            messages: [
              ...(promptExpansionEnabled
                ? [
                    { role: 'system', content: providerExpandedPrompt },
                    { role: 'system', content: providerExpandedPrompt },
                  ]
                : [{ role: 'system', content: providerExpandedPrompt }]),
              { role: 'user', content: 'QA prompt expansion toggle.' },
            ],
          },
          get(name) {
            return String(name).toLowerCase() === 'authorization'
              ? 'Bearer qa-codex-token'
              : ''
          },
          query: {},
        },
        createMockClmResponse(),
      )
    }

    const [disabledBody, enabledBody] = upstreamBodies
    const disabledSystemMessages = (disabledBody?.messages || [])
      .filter((message) => message?.role === 'system')
      .map((message) => String(message?.content || ''))
    const enabledSystemMessages = (enabledBody?.messages || [])
      .filter((message) => message?.role === 'system')
      .map((message) => String(message?.content || ''))
    if (
      disabledSystemMessages.filter(
        (content) => content === 'QA Speak\nsystem prompt.',
      ).length !== 1 ||
      disabledSystemMessages.some((content) =>
        content.includes('QA Hume supplemental voice expansion.'),
      )
    ) {
      failures.push(
        `Disabled Hume Codex prompt expansion must keep only the Speak prompt: ${JSON.stringify(disabledSystemMessages)}`,
      )
    }
    if (
      enabledSystemMessages.length !== 1 ||
      enabledSystemMessages[0] !==
        'QA Speak system prompt.\n\nQA Hume supplemental voice expansion.'
    ) {
      failures.push(
        `Enabled Hume Codex prompt expansion must merge provider-supplied system context once: ${JSON.stringify(enabledSystemMessages)}`,
      )
    }
    if (
      disabledBody?.model !== expectedCodexModels[0] ||
      enabledBody?.model !== expectedCodexModels[0]
    ) {
      failures.push('Hume Codex prompt expansion toggle must not change the selected model')
    }
  } finally {
    globalThis.fetch = originalFetch
    restoreEnvironmentValue('CODEX_CLM_API_KEY', originalToken)
  }

  if (
    speakSettingsSource.includes(
      "voiceRuntimeProvider === 'hume' && languageModelMode !== 'codex'",
    )
  ) {
    failures.push('Prompt expansion control must be available for Hume Codex profiles')
  }
  for (const snippet of [
    "voiceRuntimeProvider === 'hume' && languageModelMode === 'codex'",
    '? Boolean(config.promptExpansionEnabled)',
  ]) {
    if (!speakSettingsSource.includes(snippet)) {
      failures.push(`Hume Codex model changes must preserve an explicit prompt expansion choice: ${snippet}`)
    }
  }
  if (
    !serverIndexSource.includes(
      'promptExpansionEnabled: state.config.promptExpansionEnabled',
    )
  ) {
    failures.push('Hume Codex session correlation must forward prompt expansion state')
  }
  for (const snippet of [
    'In Codex-auth mode the selected assembled runtime prompt is supplied through persistent Hume session context before audio',
    "independently retained as the CLM's authoritative correlated system prompt",
    '`false` for new profiles; existing saved/provider values remain until changed',
    'never enabled automatically as a latency change',
  ]) {
    if (!configOptionsDoc.includes(snippet)) {
      failures.push(`Configuration reference missing Hume Codex prompt expansion behavior: ${snippet}`)
    }
  }
}

async function verifyCodexClmTerminalFinishLatency() {
  const originalFetch = globalThis.fetch
  const originalToken = process.env.CODEX_CLM_API_KEY
  const originalIdleTimeout = process.env.CODEX_CLM_STREAM_IDLE_AFTER_OUTPUT_MS
  const encoder = new TextEncoder()
  const timingEvents = []
  let streamCancelled = false
  process.env.CODEX_CLM_API_KEY = 'qa-codex-token'
  process.env.CODEX_CLM_STREAM_IDLE_AFTER_OUTPUT_MS = '2000'
  setCodexClmTimingObserver((event) => timingEvents.push(event))

  try {
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{"content":"Ready."},"finish_reason":"stop"}]}\n\n',
              ),
            )
          },
          cancel() {
            streamCancelled = true
            return new Promise(() => {})
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        },
      )

    const request = {
      body: {
        custom_session_id: 'qa-terminal-finish-session',
        messages: [{ role: 'user', content: 'QA' }],
        model: expectedCodexModels[0] || 'gpt-5.6-sol',
      },
      get(name) {
        return String(name).toLowerCase() === 'authorization'
          ? 'Bearer qa-codex-token'
          : ''
      },
      query: {},
    }

    const startedAt = performance.now()
    let timeoutId
    const completed = await Promise.race([
      handleCodexClmChatCompletion(request, createMockClmResponse()).then(
        () => true,
      ),
      new Promise((resolve) => {
        timeoutId = setTimeout(() => resolve(false), 600)
      }),
    ])
    clearTimeout(timeoutId)
    const elapsedMs = performance.now() - startedAt
    if (!completed) {
      failures.push(
        'Hume Codex CLM must not await an unresolved upstream stream cancellation',
      )
    } else if (elapsedMs > 400) {
      failures.push(
        `Hume Codex CLM waited ${Math.round(elapsedMs)}ms after upstream finish_reason=stop`,
      )
    }
    if (!streamCancelled) {
      failures.push('Hume Codex CLM must close an upstream stream after its terminal finish reason')
    }
    const timingNames = new Set(timingEvents.map((event) => event.name))
    for (const name of [
      'clm_request_received',
      'clm_upstream_started',
      'clm_upstream_headers',
      'clm_first_token_received',
      'clm_first_token_forwarded',
    ]) {
      if (!timingNames.has(name)) {
        failures.push(`Hume Codex CLM timing proof missing ${name}`)
      }
    }
    const forwarded = timingEvents.find(
      (event) => event.name === 'clm_first_token_forwarded',
    )
    if (!Number.isFinite(forwarded?.forwardingOverheadMs)) {
      failures.push('Hume Codex CLM timing proof missing first-token forwarding overhead')
    }
    const requestSequences = new Set(
      timingEvents.map((event) => event.requestSequence),
    )
    if (
      requestSequences.size !== 1 ||
      !Number.isFinite([...requestSequences][0])
    ) {
      failures.push('Hume Codex CLM timing proof missing a stable request sequence')
    }
  } finally {
    setCodexClmTimingObserver(null)
    globalThis.fetch = originalFetch
    restoreEnvironmentValue('CODEX_CLM_API_KEY', originalToken)
    restoreEnvironmentValue(
      'CODEX_CLM_STREAM_IDLE_AFTER_OUTPUT_MS',
      originalIdleTimeout,
    )
  }
}

async function verifyCodexClmUpstreamFailureStatus() {
  const originalFetch = globalThis.fetch
  const originalToken = process.env.CODEX_CLM_API_KEY
  process.env.CODEX_CLM_API_KEY = 'qa-codex-token'

  try {
    for (const [upstreamStatus, expectedStatus] of [
      [429, 429],
      [500, 500],
      [502, 502],
      [503, 503],
      [504, 504],
      [418, 502],
    ]) {
      globalThis.fetch = async () =>
        new Response('{"error":"unavailable"}', {
          status: upstreamStatus,
          headers: { 'Content-Type': 'application/json' },
        })
      const response = createMockClmResponse()
      await handleCodexClmChatCompletion(
        {
          body: {
            custom_session_id: `qa-upstream-failure-session-${upstreamStatus}`,
            messages: [{ role: 'user', content: 'QA' }],
            model: expectedCodexModels[0] || 'gpt-5.6-sol',
          },
          get(name) {
            return String(name).toLowerCase() === 'authorization'
              ? 'Bearer qa-codex-token'
              : ''
          },
          query: {},
        },
        response,
      )
      if (
        response.statusCode !== expectedStatus ||
        response.jsonBody?.error !== 'Codex auth model bridge failed.'
      ) {
        failures.push(
          `Hume Codex CLM upstream HTTP ${upstreamStatus} must map to sanitized HTTP ${expectedStatus}: ${JSON.stringify({
            statusCode: response.statusCode,
            jsonBody: response.jsonBody,
          })}`,
        )
      }
    }
  } finally {
    globalThis.fetch = originalFetch
    restoreEnvironmentValue('CODEX_CLM_API_KEY', originalToken)
  }
}

async function verifyCodexClmInitialResponseTimeout() {
  const originalFetch = globalThis.fetch
  const originalToken = process.env.CODEX_CLM_API_KEY
  const originalInitialTimeout = process.env.CODEX_CLM_STREAM_INITIAL_RESPONSE_MS
  let streamCancelled = false
  process.env.CODEX_CLM_API_KEY = 'qa-codex-token'
  process.env.CODEX_CLM_STREAM_INITIAL_RESPONSE_MS = '25'

  try {
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          cancel() {
            streamCancelled = true
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        },
      )
    const response = createMockClmResponse()
    let guardTimer
    const completed = await Promise.race([
      handleCodexClmChatCompletion(
        {
          body: {
            custom_session_id: 'qa-initial-timeout-session',
            messages: [{ role: 'user', content: 'QA' }],
            model: expectedCodexModels[0] || 'gpt-5.6-sol',
          },
          get(name) {
            return String(name).toLowerCase() === 'authorization'
              ? 'Bearer qa-codex-token'
              : ''
          },
          query: {},
        },
        response,
      ).then(() => true),
      new Promise((resolve) => {
        guardTimer = setTimeout(() => resolve(false), 600)
      }),
    ])
    clearTimeout(guardTimer)
    if (
      !completed ||
      response.statusCode !== 504 ||
      response.jsonBody?.error !== 'Codex auth model bridge failed.' ||
      !streamCancelled
    ) {
      failures.push(
        `Hume Codex CLM initial response timeout must fail closed: ${JSON.stringify({
          completed,
          statusCode: response.statusCode,
          jsonBody: response.jsonBody,
          streamCancelled,
        })}`,
      )
    }
  } finally {
    globalThis.fetch = originalFetch
    restoreEnvironmentValue('CODEX_CLM_API_KEY', originalToken)
    restoreEnvironmentValue(
      'CODEX_CLM_STREAM_INITIAL_RESPONSE_MS',
      originalInitialTimeout,
    )
  }
}

async function verifyCodexClmConcurrentDuplicateCoalescing() {
  const originalFetch = globalThis.fetch
  const originalToken = process.env.CODEX_CLM_API_KEY
  const originalModelFollowUp = process.env.CODEX_CLM_MODEL_FOLLOWUP_AFTER_TOOLS
  let releaseFetch
  const fetchBarrier = new Promise((resolve) => {
    releaseFetch = resolve
  })
  let upstreamFetches = 0
  let toolExecutions = 0
  process.env.CODEX_CLM_API_KEY = 'qa-codex-token'
  delete process.env.CODEX_CLM_MODEL_FOLLOWUP_AFTER_TOOLS
  codexClmModule.resetCodexClmCoalescingForTests?.()

  try {
    globalThis.fetch = async () => {
      upstreamFetches += 1
      await fetchBarrier
      return new Response(
        [
          'data: {"id":"qa-shared-completion","object":"chat.completion.chunk","created":1,"model":"gpt-5.6-sol","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"qa-shared-sms","type":"function","function":{"name":"send_text_message","arguments":"{\\"phone_number\\":\\"+12025550199\\",\\"message\\":\\"QA shared text\\",\\"destination_confirmed\\":true}"}}]},"finish_reason":"tool_calls"}]}',
          '',
          'data: [DONE]',
          '',
        ].join('\n'),
        {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        },
      )
    }
    setCodexClmToolExecutor(async () => {
      toolExecutions += 1
      return {
        ok: true,
        sent: true,
        proof: {
          provider: 'telnyx',
          message_id: 'qa-shared-provider-message',
        },
      }
    })

    const sessionId = 'qa-concurrent-duplicate-session'
    rememberCodexClmSessionContext(sessionId, {
      systemPrompt: 'QA dynamic prompt rendered at {{now}}.',
      context: '<configuration_test_context>stable</configuration_test_context>',
      variables: { campaign: 'qa' },
      codexReasoningEffort: 'none',
      codexFastMode: true,
    })
    const firstRequest = {
      body: {
        custom_session_id: sessionId,
        model: 'gpt-5.6-sol',
        messages: [{ role: 'user', content: 'Send the confirmed QA text.' }],
      },
      get(name) {
        return String(name).toLowerCase() === 'authorization'
          ? 'Bearer qa-codex-token'
          : ''
      },
      query: {},
    }
    const duplicateRequest = {
      body: {
        messages: [{ content: 'Send the confirmed QA text.', role: 'user' }],
        model: 'gpt-5.6-sol',
        custom_session_id: sessionId,
      },
      get(name) {
        return String(name).toLowerCase() === 'authorization'
          ? 'Bearer qa-codex-token'
          : ''
      },
      query: {},
    }
    const firstResponse = createMockClmResponse()
    const duplicateResponse = createMockClmResponse()
    const firstCompletion = handleCodexClmChatCompletion(firstRequest, firstResponse)
    await new Promise((resolve) => setTimeout(resolve, 10))
    const duplicateCompletion = handleCodexClmChatCompletion(
      duplicateRequest,
      duplicateResponse,
    )
    await new Promise((resolve) => setImmediate(resolve))
    releaseFetch()
    await Promise.all([firstCompletion, duplicateCompletion])

    const firstSse = firstResponse.writes.join('')
    const duplicateSse = duplicateResponse.writes.join('')
    const completedReplayResponse = createMockClmResponse()
    await handleCodexClmChatCompletion(duplicateRequest, completedReplayResponse)
    const completedReplaySse = completedReplayResponse.writes.join('')

    rememberCodexClmSessionContext(sessionId, {
      systemPrompt: 'QA changed dynamic prompt rendered at {{now}}.',
      context: '<configuration_test_context>changed</configuration_test_context>',
      variables: { campaign: 'qa' },
      codexReasoningEffort: 'none',
      codexFastMode: true,
    })
    const changedContextResponse = createMockClmResponse()
    await handleCodexClmChatCompletion(duplicateRequest, changedContextResponse)
    if (
      upstreamFetches !== 2 ||
      toolExecutions !== 2 ||
      !firstResponse.ended ||
      !duplicateResponse.ended ||
      !completedReplayResponse.ended ||
      !changedContextResponse.ended ||
      !firstSse.includes('data: [DONE]') ||
      firstSse !== duplicateSse ||
      firstSse !== completedReplaySse ||
      !changedContextResponse.writes.join('').includes('data: [DONE]')
    ) {
      failures.push(
        `Concurrent/completed Hume CLM retries with {{now}} must share one logical turn, replay byte-identically, and execute tools once while changed session context starts a new turn: ${JSON.stringify({
          changedContextEnded: changedContextResponse.ended,
          completedReplayEnded: completedReplayResponse.ended,
          duplicateEnded: duplicateResponse.ended,
          identicalSse: firstSse === duplicateSse,
          identicalCompletedReplay: firstSse === completedReplaySse,
          firstEnded: firstResponse.ended,
          firstSseBytes: firstSse.length,
          toolExecutions,
          upstreamFetches,
        })}`,
      )
    }
  } finally {
    releaseFetch?.()
    codexClmModule.resetCodexClmCoalescingForTests?.()
    setCodexClmToolExecutor(null)
    globalThis.fetch = originalFetch
    restoreEnvironmentValue('CODEX_CLM_API_KEY', originalToken)
    restoreEnvironmentValue(
      'CODEX_CLM_MODEL_FOLLOWUP_AFTER_TOOLS',
      originalModelFollowUp,
    )
  }
}

async function verifyMockedHumeCodexToolExecution() {
  const originalFetch = globalThis.fetch
  const originalToken = process.env.CODEX_CLM_API_KEY
  const toolExecutions = []
  let upstreamBody = null
  process.env.CODEX_CLM_API_KEY = 'qa-codex-token'

  rememberCodexClmSessionContext('qa-hume-codex-tool-session', {
    systemPrompt: 'QA jAI system prompt',
    context: '<current_contact>\nphone_on_file: +12025550199\nemail_on_file: qa@example.test\n</current_contact>',
  })
  setCodexClmToolExecutor(async (input) => {
    toolExecutions.push(input)
    return {
      ok: true,
      sent: true,
      proof: {
        provider: input.name === 'send_text_message' ? 'telnyx' : 'google_workspace',
        message_id: `qa-${input.toolCallId}`,
      },
    }
  })

  try {
    globalThis.fetch = async (_input, options = {}) => {
      upstreamBody = JSON.parse(String(options.body || '{}'))
      return new Response(
        [
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"qa-sms","type":"function","function":{"name":"send_text_message","arguments":"{\\"phone_number\\":\\"+12025550199\\",\\"message\\":\\"QA text\\",\\"destination_confirmed\\":true}"}},{"index":1,"id":"qa-email","type":"function","function":{"name":"send_email","arguments":"{\\"email\\":\\"qa@example.test\\",\\"subject\\":\\"QA\\",\\"body\\":\\"QA email\\",\\"destination_confirmed\\":true}"}}]},"finish_reason":"tool_calls"}]}',
          '',
          'data: [DONE]',
          '',
        ].join('\n'),
        {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        },
      )
    }

    const request = {
      body: {
        messages: [{ role: 'user', content: 'Send both confirmed QA messages.' }],
        model: 'gpt-5.6-sol',
      },
      get(name) {
        return String(name).toLowerCase() === 'authorization'
          ? 'Bearer qa-codex-token'
          : ''
      },
      query: { custom_session_id: 'qa-hume-codex-tool-session' },
    }
    const response = createMockClmResponse()
    await handleCodexClmChatCompletion(request, response)

    const upstreamToolNames = new Set(
      (upstreamBody?.tools || []).map((tool) => tool.function?.name),
    )
    for (const name of ['send_text_message', 'send_email', 'update_contact']) {
      if (!upstreamToolNames.has(name)) {
        failures.push(`Hume Codex CLM request missing shared Speak tool ${name}`)
      }
    }
    const runtimeContext = (upstreamBody?.messages || [])
      .map((message) => String(message.content || ''))
      .join('\n')
    if (
      !runtimeContext.includes('QA jAI system prompt') ||
      !runtimeContext.includes('phone_on_file: +12025550199') ||
      !runtimeContext.includes('email_on_file: qa@example.test')
    ) {
      failures.push('Hume Codex CLM request missing correlated jAI session context')
    }
    if (
      toolExecutions.length !== 2 ||
      toolExecutions.some(
        (execution) => execution.customSessionId !== 'qa-hume-codex-tool-session',
      ) ||
      toolExecutions[0]?.args?.destination_confirmed !== true ||
      toolExecutions[1]?.args?.destination_confirmed !== true
    ) {
      failures.push(
        `Hume Codex CLM tool execution lost session or confirmation proof: ${JSON.stringify(toolExecutions)}`,
      )
    }
  } finally {
    setCodexClmToolExecutor(null)
    globalThis.fetch = originalFetch
    restoreEnvironmentValue('CODEX_CLM_API_KEY', originalToken)
  }
}

function createMockClmResponse() {
  return {
    headersSent: false,
    statusCode: 200,
    headers: {},
    writes: [],
    jsonBody: null,
    ended: false,
    status(code) {
      this.statusCode = code
      return this
    },
    setHeader(name, value) {
      this.headers[name] = value
    },
    flushHeaders() {
      this.headersSent = true
    },
    write(chunk) {
      this.headersSent = true
      this.writes.push(String(chunk || ''))
    },
    flush() {},
    end() {
      this.ended = true
    },
    json(payload) {
      this.headersSent = true
      this.jsonBody = payload
    },
  }
}

function exactExpressRouteSource(source, method, routePath) {
  const marker = `app.${method}('${routePath}'`
  const start = source.indexOf(marker)
  if (start < 0) return ''
  const nextRoute = source.indexOf('\napp.', start + marker.length)
  return source.slice(start, nextRoute < 0 ? source.length : nextRoute)
}

async function verifyMockedHumeNativeToolCompatibility() {
  const originalFetch = globalThis.fetch
  const originalApiKey = process.env.HUME_API_KEY
  process.env.HUME_API_KEY = 'qa-hume-tool-capability-key'

  try {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input))
      if (url.hostname === '127.0.0.1' && url.pathname.endsWith('/models')) {
        return jsonResponse({ data: [] })
      }
      if (url.pathname === '/v0/evi/language_models') {
        return jsonResponse({
          language_models: [
            {
              model_provider: 'ANTHROPIC',
              model_resource: 'claude-sonnet-4-6',
              display_name: 'Claude Sonnet 4.6',
              builtin_tools: ['web_search', 'hang_up'],
            },
            {
              model_provider: 'ANTHROPIC',
              model_resource: 'claude-opus-4-6',
              display_name: 'Claude Opus 4.6',
              builtin_tools: ['web_search', 'hang_up'],
            },
          ],
        })
      }
      if (url.pathname === '/v0/tts/voices') {
        const provider = url.searchParams.get('provider')
        return jsonResponse({
          page_number: 0,
          total_pages: 1,
          voices_page: [mockHumeVoice(provider, 0)],
        })
      }
      throw new Error(`Unexpected mocked Hume capability request: ${url.pathname}`)
    }

    const options = await readHumeConfigOptions()
    const optionValues = new Set(options.languageModels.map((option) => option.value))
    if (!optionValues.has('ANTHROPIC:claude-sonnet-4-6')) {
      failures.push('Hume native tool filtering must preserve compatible Claude Sonnet 4.6')
    }
    if (optionValues.has('ANTHROPIC:claude-opus-4-6')) {
      failures.push('Hume native tool filtering must exclude observed-incompatible Claude Opus 4.6')
    }

    let syncRequests = 0
    globalThis.fetch = async () => {
      syncRequests += 1
      throw new Error('Tool-incompatible Hume native sync reached the provider')
    }
    let syncError = null
    try {
      await syncHumeAgentConfig({
        profileName: 'Tool-incompatible native sync QA',
        config: {
          humeConfigId: '00000000-0000-4000-8000-000000000015',
          voiceRuntimeProvider: 'hume',
          languageModelMode: 'hume',
          languageModelProvider: 'ANTHROPIC',
          languageModelResource: 'claude-opus-4-6',
          instructions: 'Use shared Speak tools.',
        },
        createNew: false,
        ownedUpdates: { settings: true },
      })
    } catch (error) {
      syncError = error
    }
    if (
      syncError?.name !== 'HumeConfigSyncError' ||
      syncError?.status !== 409 ||
      syncError?.provider !== 'hume' ||
      !String(syncError?.message || '').includes('does not support Speak tools')
    ) {
      failures.push(
        `Hume native sync must reject tool-incompatible models with stable proof: ${JSON.stringify({
          name: syncError?.name,
          status: syncError?.status,
          provider: syncError?.provider,
          message: syncError?.message,
        })}`,
      )
    }
    if (syncRequests !== 0) {
      failures.push(
        `Hume native sync must reject tool-incompatible models before provider IO, saw ${syncRequests} request(s)`,
      )
    }

    const sourceConfigId = '00000000-0000-4000-8000-000000000016'
    let sourceModelToolRequests = 0
    globalThis.fetch = async (input, options = {}) => {
      const url = new URL(String(input))
      const method = String(options.method || 'GET').toUpperCase()
      if (url.pathname === `/v0/evi/configs/${sourceConfigId}` && method === 'GET') {
        return jsonResponse({
          configs_page: [
            {
              id: sourceConfigId,
              name: 'Existing incompatible native model QA',
              version: 1,
              evi_version: '3',
              language_model: {
                model_provider: 'ANTHROPIC',
                model_resource: 'claude-opus-4-6',
              },
              prompt: { text: 'Existing prompt' },
              tools: [],
              voice: { id: 'voice-opus', name: 'Opus QA', provider: 'HUME_AI' },
            },
          ],
        })
      }
      sourceModelToolRequests += 1
      throw new Error('Existing tool-incompatible Hume config reached tool sync')
    }
    let sourceModelError = null
    try {
      await syncHumeAgentConfig({
        profileName: 'Existing incompatible native model QA',
        config: {
          humeConfigId: sourceConfigId,
          voiceRuntimeProvider: 'hume',
          languageModelMode: 'hume',
          instructions: 'Change only this prompt.',
        },
        createNew: false,
        ownedUpdates: { prompt: true },
      })
    } catch (error) {
      sourceModelError = error
    }
    if (
      sourceModelError?.name !== 'HumeConfigSyncError' ||
      sourceModelError?.status !== 409 ||
      sourceModelError?.provider !== 'hume'
    ) {
      failures.push(
        `Hume sync must reject an incompatible model inherited from its source config: ${JSON.stringify({
          name: sourceModelError?.name,
          status: sourceModelError?.status,
          provider: sourceModelError?.provider,
          message: sourceModelError?.message,
        })}`,
      )
    }
    if (sourceModelToolRequests !== 0) {
      failures.push(
        `Hume sync must reject an incompatible source model before tool sync, saw ${sourceModelToolRequests} request(s)`,
      )
    }
  } finally {
    globalThis.fetch = originalFetch
    restoreEnvironmentValue('HUME_API_KEY', originalApiKey)
  }
}

async function verifyMockedHumeNativeToolSync() {
  const originalFetch = globalThis.fetch
  const originalApiKey = process.env.HUME_API_KEY
  process.env.HUME_API_KEY = 'qa-hume-native-key'
  const configId = '00000000-0000-4000-8000-000000000014'
  let postedConfigBody = null

  try {
    globalThis.fetch = async (input, options = {}) => {
      const url = new URL(String(input))
      const method = String(options.method || 'GET').toUpperCase()

      if (url.pathname === `/v0/evi/configs/${configId}` && method === 'GET') {
        return jsonResponse({
          configs_page: [
            {
              id: configId,
              name: 'Native tool sync QA',
              version: 1,
              evi_version: '3',
              language_model: {
                model_provider: 'ANTHROPIC',
                model_resource: 'claude-sonnet-4-6',
              },
              prompt: { text: 'Old native prompt' },
              tools: [],
              builtin_tools: [],
              voice: { id: 'voice-native', name: 'Native', provider: 'HUME_AI' },
            },
          ],
        })
      }

      if (url.pathname === '/v0/evi/tools' && method === 'GET') {
        const name = url.searchParams.get('name') || ''
        const spec = speakFunctionTools.find((tool) => tool.name === name)
        return jsonResponse({
          tools_page: spec
            ? [{ ...spec, id: `tool-${name}`, version: 7 }]
            : [],
        })
      }

      if (url.pathname === `/v0/evi/configs/${configId}` && method === 'POST') {
        postedConfigBody = JSON.parse(String(options.body || '{}'))
        return jsonResponse({
          id: configId,
          name: 'Native tool sync QA',
          version: 2,
          ...postedConfigBody,
        })
      }

      throw new Error(`Unexpected mocked Hume native sync request: ${method} ${url.pathname}`)
    }

    const result = await syncHumeAgentConfig({
      profileName: 'Native tool sync QA',
      config: {
        humeConfigId: configId,
        voiceRuntimeProvider: 'hume',
        languageModelMode: 'hume',
        languageModelProvider: 'ANTHROPIC',
        languageModelResource: 'claude-sonnet-4-6',
        instructions: 'Use shared Speak tools.',
      },
      createNew: false,
      ownedUpdates: { prompt: true },
    })

    if (result.config?.languageModelMode !== 'hume') {
      failures.push('Hume-native sync must keep Codex auth off')
    }

    const postedToolIds = new Set(
      (postedConfigBody?.tools || []).map((tool) => tool?.id).filter(Boolean),
    )
    for (const toolName of ['send_text_message', 'send_email']) {
      if (!postedToolIds.has(`tool-${toolName}`)) {
        failures.push(`Hume-native sync missing posted ${toolName} tool reference`)
      }
    }
  } finally {
    globalThis.fetch = originalFetch
    restoreEnvironmentValue('HUME_API_KEY', originalApiKey)
  }
}

async function verifyMockedHumeCodexToolSync() {
  const originalFetch = globalThis.fetch
  const originalApiKey = process.env.HUME_API_KEY
  const originalPublicBaseUrl = process.env.PUBLIC_BASE_URL
  process.env.HUME_API_KEY = 'qa-hume-key'
  process.env.PUBLIC_BASE_URL = 'https://speak.example.test/speak'
  const configId = '00000000-0000-4000-8000-000000000013'
  const voiceId = '00000000-0000-4000-8000-000000000099'
  const promptStorePath = 'data/codex-clm-prompts.json'
  const promptStoreExisted = fs.existsSync(promptStorePath)
  const originalPromptStore = promptStoreExisted
    ? JSON.parse(fs.readFileSync(promptStorePath, 'utf8'))
    : {}
  const originalPromptRecord = originalPromptStore[configId]
  let postedConfigBody = null

  try {
    globalThis.fetch = async (input, options = {}) => {
      const url = new URL(String(input))
      const method = String(options.method || 'GET').toUpperCase()

      if (url.pathname === `/v0/evi/configs/${configId}` && method === 'GET') {
        return jsonResponse({
          configs_page: [
            postedConfigBody
              ? {
                  id: configId,
                  name: 'jAI-Stan',
                  version: 14,
                  ...postedConfigBody,
                }
              : {
              id: configId,
              name: 'jAI-Stan',
              version: 13,
              evi_version: '3',
              language_model: {
                model_provider: 'ANTHROPIC',
                model_resource: 'claude-sonnet-4-6',
              },
              prompt: { text: 'stale native provider prompt' },
              tools: [],
              builtin_tools: [],
              voice: { id: voiceId, name: 'jai-stan', provider: 'CUSTOM_VOICE' },
                },
          ],
        })
      }

      if (url.pathname === '/v0/tts/voices') {
        const provider = url.searchParams.get('provider')
        return jsonResponse({
          page_number: 0,
          total_pages: 1,
          voices_page:
            provider === 'CUSTOM_VOICE'
              ? [{ id: voiceId, name: 'jai-stan', provider }]
              : [{ id: 'hume-library-voice', name: 'Library voice', provider }],
        })
      }

      if (url.pathname === '/v0/evi/tools' && method === 'GET') {
        const name = url.searchParams.get('name') || ''
        const spec = speakFunctionTools.find((tool) => tool.name === name)
        return jsonResponse({
          tools_page: spec
            ? [{ ...spec, id: `tool-${name}`, version: 1 }]
            : [],
        })
      }

      if (url.pathname === `/v0/evi/configs/${configId}` && method === 'POST') {
        postedConfigBody = JSON.parse(String(options.body || '{}'))
        return jsonResponse({
          id: configId,
          name: 'jAI-Stan',
          version: 14,
          ...postedConfigBody,
        })
      }

      throw new Error(`Unexpected mocked Hume Codex sync request: ${method} ${url.pathname}`)
    }

    const result = await syncHumeAgentConfig({
      profileName: 'jAI-Stan',
      config: {
        humeConfigId: configId,
        voiceRuntimeProvider: 'hume',
        languageModelMode: 'codex',
        codexAuthModel: 'gpt-5.6-sol',
        instructions: 'Use shared Speak tools and require provider proof.',
        promptExpansionEnabled: true,
        voice: voiceId,
        humeVoiceProvider: 'CUSTOM_VOICE',
      },
      createNew: false,
      ownedUpdates: {
        name: true,
        prompt: true,
        settings: true,
        voice: true,
      },
    })

    if (result.config?.languageModelMode !== 'codex') {
      failures.push('jAI Hume sync must return a Codex-auth provider configuration')
    }
    const refreshed = await readHumeAgentConfig(configId)
    if (
      result.config?.promptExpansionEnabled !== true ||
      refreshed?.config?.promptExpansionEnabled !== true
    ) {
      failures.push(
        'Hume Codex prompt expansion choice must survive sync and provider refresh',
      )
    }
    if (
      postedConfigBody?.language_model?.model_provider !== 'CUSTOM_LANGUAGE_MODEL' ||
      postedConfigBody?.language_model?.model_resource !==
        'https://speak.example.test/speak/api/codex-clm/chat/completions' ||
      postedConfigBody?.language_model?.custom_language_model_model !== 'gpt-5.6-sol'
    ) {
      failures.push('jAI Hume sync must write the selected Codex CLM endpoint and model')
    }
    if (postedConfigBody?.prompt !== undefined) {
      failures.push(
        'Hume rejects Prompt resources on CUSTOM_LANGUAGE_MODEL configs; Codex-auth prompt parity must use the correlated CLM system prompt and persistent Hume session context',
      )
    }
    if (postedConfigBody?.tools !== undefined) {
      failures.push(
        'jAI Hume Codex sync must keep shared tool execution inside the CLM bridge',
      )
    }

    let missingVoiceError = null
    try {
      await syncHumeAgentConfig({
        profileName: 'jAI-Stan',
        config: {
          humeConfigId: configId,
          voiceRuntimeProvider: 'hume',
          languageModelMode: 'codex',
          codexAuthModel: 'gpt-5.6-sol',
          instructions: 'Use shared Speak tools and require provider proof.',
          voice: '00000000-0000-4000-8000-000000000404',
          humeVoiceProvider: 'CUSTOM_VOICE',
        },
        createNew: false,
        ownedUpdates: {
          name: true,
          prompt: true,
          settings: true,
          voice: true,
        },
      })
    } catch (error) {
      missingVoiceError = error
    }
    if (
      missingVoiceError?.name !== 'HumeConfigSyncError' ||
      !String(missingVoiceError.message).includes('Selected Speak voice is unavailable')
    ) {
      failures.push(
        'Hume reconciliation must fail closed instead of replacing an unavailable selected voice',
      )
    }
  } finally {
    globalThis.fetch = originalFetch
    restoreEnvironmentValue('HUME_API_KEY', originalApiKey)
    restoreEnvironmentValue('PUBLIC_BASE_URL', originalPublicBaseUrl)
    const currentPromptStore = fs.existsSync(promptStorePath)
      ? JSON.parse(fs.readFileSync(promptStorePath, 'utf8'))
      : {}
    if (originalPromptRecord === undefined) {
      delete currentPromptStore[configId]
    } else {
      currentPromptStore[configId] = originalPromptRecord
    }
    if (promptStoreExisted || Object.keys(currentPromptStore).length > 0) {
      fs.mkdirSync('data', { recursive: true })
      fs.writeFileSync(
        promptStorePath,
        `${JSON.stringify(currentPromptStore, null, 2)}\n`,
      )
    } else {
      fs.rmSync(promptStorePath, { force: true })
      try {
        fs.rmdirSync('data')
      } catch {
        // Keep a pre-existing or concurrently used data directory.
      }
    }
  }
}

async function verifyMockedHumeVoicePagination() {
  const originalFetch = globalThis.fetch
  const originalApiKey = process.env.HUME_API_KEY
  process.env.HUME_API_KEY = 'qa-hume-key'

  let scenario = 'multi-page'
  let languageModelReads = 0
  const voicePageReads = {
    CUSTOM_VOICE: 0,
    HUME_AI: 0,
  }
  try {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input))
      if (url.hostname === '127.0.0.1' && url.pathname.endsWith('/models')) {
        return jsonResponse({ data: [] })
      }
      if (url.pathname === '/v0/evi/language_models') {
        languageModelReads += 1
        return jsonResponse({
          language_models:
            scenario === 'fresh-custom'
              ? [
                  {
                    model_provider: 'QA',
                    model_resource: 'fresh-model',
                    display_name: 'Fresh model',
                  },
                ]
              : [],
        })
      }
      if (url.pathname !== '/v0/tts/voices') {
        throw new Error(`Unexpected mocked Hume request: ${url.pathname}`)
      }

      const provider = url.searchParams.get('provider')
      const requestedPage = Number(url.searchParams.get('page_number'))
      voicePageReads[provider] = (voicePageReads[provider] || 0) + 1
      if (scenario === 'multi-page') {
        const totalPages = provider === 'CUSTOM_VOICE' ? 12 : 1
        return jsonResponse({
          page_number: requestedPage,
          total_pages: totalPages,
          voices_page: [mockHumeVoice(provider, requestedPage)],
        })
      }
      if (scenario === 'fresh-custom') {
        return jsonResponse({
          page_number: requestedPage,
          total_pages: 1,
          voices_page:
            provider === 'CUSTOM_VOICE'
              ? [
                  mockHumeVoice(provider, requestedPage),
                  {
                    id: 'newly-created-custom-voice',
                    name: 'Newly created custom voice',
                    provider,
                  },
                ]
              : [mockHumeVoice(provider, requestedPage)],
        })
      }
      if (scenario === 'repeated-page') {
        return jsonResponse({
          page_number: requestedPage === 0 ? 0 : 0,
          total_pages: 2,
          voices_page: [mockHumeVoice(provider, requestedPage)],
        })
      }
      if (scenario === 'missing-total-pages') {
        return jsonResponse({
          page_number: requestedPage,
          voices_page: [mockHumeVoice(provider, requestedPage)],
        })
      }
      if (scenario === 'inconsistent-total-pages') {
        return jsonResponse({
          page_number: requestedPage,
          total_pages: requestedPage === 0 ? 2 : 3,
          voices_page: [mockHumeVoice(provider, requestedPage)],
        })
      }
      if (scenario === 'fractional-page-number') {
        return jsonResponse({
          page_number: requestedPage + 0.5,
          total_pages: 2,
          voices_page: [mockHumeVoice(provider, requestedPage)],
        })
      }
      return jsonResponse({
        page_number: requestedPage,
        total_pages: 0,
        voices_page: [],
      })
    }

    const options = await readHumeConfigOptions()
    const customVoices = options.voices.filter((voice) => voice.provider === 'CUSTOM_VOICE')
    if (customVoices.length !== 12 || !customVoices.some((voice) => voice.id === 'custom_voice-11')) {
      failures.push('Hume mocked pagination must read every page beyond the legacy ten-page cap')
    }
    if (
      languageModelReads !== 1 ||
      voicePageReads.CUSTOM_VOICE !== 12 ||
      voicePageReads.HUME_AI !== 1
    ) {
      failures.push(
        `Hume Settings refresh must read every model and voice page: ${JSON.stringify({
          languageModelReads,
          voicePageReads,
        })}`,
      )
    }

    scenario = 'fresh-custom'
    languageModelReads = 0
    voicePageReads.CUSTOM_VOICE = 0
    voicePageReads.HUME_AI = 0
    const refreshedOptions = await readHumeConfigOptions()
    if (
      languageModelReads !== 1 ||
      voicePageReads.CUSTOM_VOICE !== 1 ||
      voicePageReads.HUME_AI !== 1 ||
      !refreshedOptions.languageModels.some(
        (model) => model.modelResource === 'fresh-model',
      ) ||
      !refreshedOptions.voices.some(
        (voice) => voice.id === 'newly-created-custom-voice',
      )
    ) {
      failures.push(
        'A second Hume Settings refresh must bypass old options and surface newly created models/custom voices',
      )
    }

    scenario = 'repeated-page'
    await expectProviderCatalogError({
      run: readHumeConfigOptions,
      name: 'HumeConfigSyncError',
      provider: 'hume',
      message: 'Speak voice catalog repeated or returned an unexpected page.',
      label: 'Hume repeated-page metadata',
    })

    for (const malformedScenario of [
      'missing-total-pages',
      'zero-total-pages',
      'inconsistent-total-pages',
      'fractional-page-number',
    ]) {
      scenario = malformedScenario
      await expectProviderCatalogError({
        run: readHumeConfigOptions,
        name: 'HumeConfigSyncError',
        provider: 'hume',
        message: 'Speak voice catalog returned invalid pagination metadata.',
        label: `Hume ${malformedScenario} metadata`,
      })
    }
  } finally {
    globalThis.fetch = originalFetch
    restoreEnvironmentValue('HUME_API_KEY', originalApiKey)
  }
}

async function verifyMockedInworldVoicePagination() {
  const originalFetch = globalThis.fetch
  const originalApiKey = process.env.INWORLD_API_KEY
  process.env.INWORLD_API_KEY = 'qa-inworld-key'

  let modelScenario = 'supported'
  let modelScenarioReads = 0
  let voiceScenario = 'multi-page'
  let voiceScenarioReads = 0
  let modelCatalogReads = 0
  let releaseBlockedModelRefresh = null
  const supportedToolModelRecord = {
    provider: 'qa',
    name: 'supported-tool-model',
    isSupported: true,
    spec: {
      inputModalities: ['text'],
      outputModalities: ['text'],
      capabilities: {
        functionCalling: true,
        reasoning: false,
        reasoningCapability: { supported: false, supportedLevels: [] },
      },
    },
  }
  try {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input))
      if (url.hostname === '127.0.0.1' && url.pathname.endsWith('/models')) {
        return jsonResponse({ data: [] })
      }
      if (url.pathname === '/llm/v1alpha/models') {
        modelCatalogReads += 1
        modelScenarioReads += 1
        if (
          (modelScenario === 'timeout-once' && modelScenarioReads === 1) ||
          modelScenario === 'timeout-always'
        ) {
          throw new DOMException('QA Inworld model timeout', 'TimeoutError')
        }
        if (modelScenario === 'provider-unavailable') {
          return new Response(JSON.stringify({ message: 'QA provider unavailable' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        if (modelScenario === 'blocked-refresh') {
          return new Promise((resolve) => {
            releaseBlockedModelRefresh = () => {
              resolve(jsonResponse({ models: [supportedToolModelRecord] }))
            }
          })
        }
        if (modelScenario === 'unsupported-only') {
          return jsonResponse({
            models: [
              {
                provider: 'qa',
                name: 'unsupported-stale-model',
                isSupported: false,
                spec: {
                  inputModalities: ['text'],
                  outputModalities: ['text'],
                  capabilities: { functionCalling: false },
                },
              },
            ],
          })
        }
        return jsonResponse({
          models: [
            {
              provider: 'qa',
              name: 'nested-capability-model',
              isSupported: true,
              spec: {
                inputModalities: ['text'],
                outputModalities: ['text'],
                capabilities: { functionCalling: false },
              },
            },
            supportedToolModelRecord,
          ],
        })
      }
      if (url.pathname !== '/voices/v1/voices') {
        throw new Error(`Unexpected mocked Inworld request: ${url.pathname}`)
      }

      voiceScenarioReads += 1
      if (voiceScenario === 'timeout-once' && voiceScenarioReads === 1) {
        throw new DOMException('QA Inworld voice timeout', 'TimeoutError')
      }
      const pageToken = url.searchParams.get('pageToken') || ''
      if (voiceScenario === 'multi-page') {
        const page = pageToken ? Number(pageToken.replace('page-', '')) : 0
        return jsonResponse({
          voices: [mockInworldVoice(page)],
          ...(page < 20 ? { nextPageToken: `page-${page + 1}` } : {}),
        })
      }
      if (voiceScenario === 'repeated-token') {
        return jsonResponse({
          voices: [mockInworldVoice(pageToken ? 1 : 0)],
          nextPageToken: 'repeat',
        })
      }
      if (voiceScenario === 'invalid-page') {
        return jsonResponse({ voices: { id: 'not-an-array' } })
      }
      if (voiceScenario === 'single-page' || voiceScenario === 'timeout-once') {
        return jsonResponse({ voices: [mockInworldVoice(0)] })
      }
      return jsonResponse({
        voices: [mockInworldVoice(0)],
        nextPageToken: { opaque: 'not-a-string' },
      })
    }

    const options = await readInworldConfigOptions()
    if (options.voices.length !== 21 || !options.voices.some((voice) => voice.id === 'voice-20')) {
      failures.push('Inworld mocked pagination must read every page beyond the legacy twenty-page cap')
    }
    const nestedCapabilityModel = options.languageModels.find(
      (model) => model.modelResource === 'qa/nested-capability-model',
    )
    const supportedToolModel = options.languageModels.find(
      (model) => model.modelResource === 'qa/supported-tool-model',
    )
    if (
      nestedCapabilityModel ||
      !supportedToolModel ||
      supportedToolModel.functionCallingSupported !== true ||
      supportedToolModel.reasoningSupported !== false ||
      supportedToolModel.reasoningEfforts.length !== 0
    ) {
      failures.push(
        'Inworld mocked model options must exclude missing function tools and preserve reasoning capability metadata',
      )
    }
    const preparedConfig = await ensureInworldRuntimeConfigReady({
      voiceRuntimeProvider: 'inworld',
      languageModelMode: 'inworld',
      languageModelResource: 'qa/supported-tool-model',
      inworldRealtimeModel: 'qa/supported-tool-model',
      inworldToolCallingEnabled: true,
    })
    if (
      modelCatalogReads !== 1 ||
      preparedConfig.inworldRealtimeModel !== 'qa/supported-tool-model' ||
      preparedConfig.inworldReasoningSupported !== false
    ) {
      failures.push(
        'Inworld start preflight must reuse the fresh option catalog without adding a provider round trip',
      )
    }

    modelScenario = 'timeout-once'
    modelScenarioReads = 0
    voiceScenario = 'timeout-once'
    voiceScenarioReads = 0
    let retriedOptions = null
    try {
      retriedOptions = await readInworldConfigOptions()
    } catch (error) {
      failures.push(
        `Inworld Settings refresh must retry one transient model/voice timeout: ${error?.message}`,
      )
    }
    if (
      modelScenarioReads !== 2 ||
      voiceScenarioReads !== 2 ||
      !retriedOptions?.languageModels?.some(
        (model) => model.modelResource === 'qa/supported-tool-model',
      ) ||
      !retriedOptions?.voices?.some((voice) => voice.id === 'voice-0')
    ) {
      failures.push(
        `Inworld Settings timeout retry contract drifted: ${JSON.stringify({
          modelScenarioReads,
          voiceScenarioReads,
          languageModels: retriedOptions?.languageModels?.length,
          voices: retriedOptions?.voices?.length,
        })}`,
      )
    }
    const readsAfterSettingsRefresh = modelCatalogReads
    const cachedPreparedConfig = await ensureInworldRuntimeConfigReady({
      voiceRuntimeProvider: 'inworld',
      languageModelMode: 'inworld',
      languageModelResource: 'qa/supported-tool-model',
      inworldRealtimeModel: 'qa/supported-tool-model',
      inworldToolCallingEnabled: true,
    })
    if (
      modelCatalogReads !== readsAfterSettingsRefresh ||
      cachedPreparedConfig.inworldRealtimeModel !== 'qa/supported-tool-model'
    ) {
      failures.push(
        'Inworld call start must reuse the validated short-lived Settings cache without provider IO',
      )
    }

    modelScenario = 'timeout-always'
    modelScenarioReads = 0
    voiceScenario = 'single-page'
    voiceScenarioReads = 0
    await expectProviderCatalogError({
      run: readInworldConfigOptions,
      name: 'InworldConfigSyncError',
      status: 504,
      provider: 'inworld',
      message: 'Inworld model catalog validation timed out or was unavailable.',
      label: 'Inworld exhausted model refresh retry',
    })
    if (modelScenarioReads !== 2) {
      failures.push(
        `Inworld Settings model refresh must use exactly two bounded attempts, saw ${modelScenarioReads}`,
      )
    }
    const readsAfterFailedRefresh = modelCatalogReads
    const cachedAfterFailedRefresh = await ensureInworldRuntimeConfigReady({
      voiceRuntimeProvider: 'inworld',
      languageModelMode: 'inworld',
      languageModelResource: 'qa/supported-tool-model',
      inworldRealtimeModel: 'qa/supported-tool-model',
      inworldToolCallingEnabled: true,
    })
    if (
      modelCatalogReads !== readsAfterFailedRefresh ||
      cachedAfterFailedRefresh.inworldRealtimeModel !== 'qa/supported-tool-model'
    ) {
      failures.push(
        'A failed Settings force-refresh must retain the last validated short-lived call-start cache',
      )
    }

    modelScenario = 'provider-unavailable'
    modelScenarioReads = 0
    await expectProviderCatalogError({
      run: readInworldConfigOptions,
      name: 'InworldConfigSyncError',
      status: 503,
      provider: 'inworld',
      message: 'Inworld config request failed: QA provider unavailable',
      label: 'Inworld provider refresh visibility',
    })
    if (modelScenarioReads !== 2) {
      failures.push(
        `Inworld retryable provider failure must use exactly two bounded attempts, saw ${modelScenarioReads}`,
      )
    }

    const originalDateNow = Date.now
    try {
      Date.now = () => originalDateNow() + 10 * 60 * 1000
      modelScenario = 'blocked-refresh'
      modelScenarioReads = 0
      voiceScenario = 'single-page'
      voiceScenarioReads = 0
      releaseBlockedModelRefresh = null
      const blockedSettingsRefresh = readInworldConfigOptions()
      for (let tick = 0; tick < 10 && !releaseBlockedModelRefresh; tick += 1) {
        await new Promise((resolve) => setImmediate(resolve))
      }

      modelScenario = 'supported'
      const runtimeWhileSettingsRefreshes = await Promise.race([
        ensureInworldRuntimeConfigReady({
          voiceRuntimeProvider: 'inworld',
          languageModelMode: 'inworld',
          languageModelResource: 'qa/supported-tool-model',
          inworldRealtimeModel: 'qa/supported-tool-model',
          inworldToolCallingEnabled: true,
        }).then((config) => ({ config, timedOut: false })),
        new Promise((resolve) => {
          setTimeout(() => resolve({ config: null, timedOut: true }), 100)
        }),
      ])
      releaseBlockedModelRefresh?.()
      await blockedSettingsRefresh
      if (
        runtimeWhileSettingsRefreshes.timedOut ||
        runtimeWhileSettingsRefreshes.config?.inworldRealtimeModel !==
          'qa/supported-tool-model' ||
        modelScenarioReads !== 2
      ) {
        failures.push(
          'A runtime cache miss must use its own short request instead of joining a longer Settings refresh',
        )
      }
    } finally {
      releaseBlockedModelRefresh?.()
      Date.now = originalDateNow
    }

    modelScenario = 'unsupported-only'
    modelScenarioReads = 0
    await expectProviderCatalogError({
      run: readInworldConfigOptions,
      name: 'InworldConfigSyncError',
      status: 502,
      provider: 'inworld',
      message: 'Inworld model catalog returned no models compatible with Speak tools.',
      label: 'Inworld unsupported Settings refresh',
    })
    const readsAfterUnsupportedRefresh = modelCatalogReads
    let cachedAfterUnsupportedRefresh = null
    try {
      cachedAfterUnsupportedRefresh = await ensureInworldRuntimeConfigReady({
        voiceRuntimeProvider: 'inworld',
        languageModelMode: 'inworld',
        languageModelResource: 'qa/supported-tool-model',
        inworldRealtimeModel: 'qa/supported-tool-model',
        inworldToolCallingEnabled: true,
      })
    } catch (error) {
      failures.push(
        `Unsupported Settings results must not replace the validated call-start cache: ${error?.message}`,
      )
    }
    if (
      modelCatalogReads !== readsAfterUnsupportedRefresh ||
      cachedAfterUnsupportedRefresh?.inworldRealtimeModel !== 'qa/supported-tool-model'
    ) {
      failures.push(
        'Unsupported refreshed models must never become stale selectable or call-start cache entries',
      )
    }

    modelScenario = 'supported'
    modelScenarioReads = 0
    voiceScenario = 'repeated-token'
    voiceScenarioReads = 0
    await expectProviderCatalogError({
      run: readInworldConfigOptions,
      name: 'InworldConfigSyncError',
      provider: 'inworld',
      message: 'Inworld voice catalog repeated a page token.',
      label: 'Inworld repeated page token',
    })

    voiceScenario = 'invalid-page'
    voiceScenarioReads = 0
    await expectProviderCatalogError({
      run: readInworldConfigOptions,
      name: 'InworldConfigSyncError',
      provider: 'inworld',
      message: 'Inworld voice catalog returned an invalid page.',
      label: 'Inworld malformed voice page',
    })

    voiceScenario = 'invalid-token'
    voiceScenarioReads = 0
    await expectProviderCatalogError({
      run: readInworldConfigOptions,
      name: 'InworldConfigSyncError',
      provider: 'inworld',
      message: 'Inworld voice catalog returned an invalid page token.',
      label: 'Inworld malformed page token',
    })
  } finally {
    globalThis.fetch = originalFetch
    restoreEnvironmentValue('INWORLD_API_KEY', originalApiKey)
  }
}

async function expectProviderCatalogError({
  run,
  name,
  status = 502,
  provider,
  message,
  label,
}) {
  try {
    await run()
    failures.push(`${label} must fail closed`)
  } catch (error) {
    if (
      error?.name !== name ||
      error?.status !== status ||
      error?.provider !== provider ||
      error?.message !== message
    ) {
      failures.push(
        `${label} returned unstable error proof: ${JSON.stringify({
          name: error?.name,
          status: error?.status,
          provider: error?.provider,
          message: error?.message,
        })}`,
      )
    }
  }
}

function mockHumeVoice(provider, page) {
  const stem = String(provider || 'voice').toLowerCase()
  return {
    id: `${stem}-${page}`,
    name: `${provider} ${page}`,
    provider,
  }
}

function mockInworldVoice(page) {
  return {
    id: `voice-${page}`,
    displayName: `Voice ${page}`,
    source: 'SYSTEM',
  }
}

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function restoreEnvironmentValue(name, value) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
