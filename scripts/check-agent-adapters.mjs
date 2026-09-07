import 'dotenv/config'
import {
  buildSpeakA2aAgentCard,
  buildSpeakA2uiManifest,
  buildSpeakAgUiManifest,
  buildSpeakAiSdkManifest,
  buildSpeakAgentContract,
  buildSpeakCopilotKitManifest,
  buildSpeakGenerativeUiManifest,
  buildSpeakJsonRenderManifest,
  buildSpeakMcpUiManifest,
  buildSpeakUiAdapterKit,
} from '../server/agent-contract.mjs'

const publicBaseUrl =
  process.env.PUBLIC_BASE_URL || 'https://speak.example.com/speak'
const placeholderEndpointPattern = /(?:^|\/\/)(?:your-public-host\.example\.com)(?:[:/]|$)/i
const options = {
  basePath: process.env.BASE_PATH || '/speak',
  publicBaseUrl,
}

const contract = buildSpeakAgentContract(options)
const generativeUi = buildSpeakGenerativeUiManifest(options)
const mcpUi = buildSpeakMcpUiManifest(options)
const agUi = buildSpeakAgUiManifest(options)
const a2ui = buildSpeakA2uiManifest(options)
const a2a = buildSpeakA2aAgentCard(options)
const aiSdk = buildSpeakAiSdkManifest(options)
const jsonRender = buildSpeakJsonRenderManifest(options)
const copilotKit = buildSpeakCopilotKitManifest(options)
const uiAdapterKit = buildSpeakUiAdapterKit(options)
const failures = []

requireEndpoint('capabilities', contract.agentAdapters.capabilities)
requireEndpoint('wellKnownSpeakAgent', contract.agentAdapters.wellKnownSpeakAgent)
requireEndpoint('mcp', contract.agentAdapters.mcp)
requireEndpoint('actionInvocation', contract.agentAdapters.actionInvocation)
requireEndpoint('hostClient', contract.agentAdapters.hostClient)
requireEndpoint('chatgptApp', contract.agentAdapters.chatgptApp)
requireEndpoint('readiness', contract.agentAdapters.readiness)
requireEndpoint('generativeUi', contract.agentAdapters.generativeUi)
requireEndpoint('uiAdapterKit', contract.agentAdapters.uiAdapterKit)
requireEndpoint('uiSnapshot', contract.agentAdapters.uiSnapshot)
requireEndpoint('mcpUi', contract.agentAdapters.mcpUi)
requireEndpoint('agUi', contract.agentAdapters.agUi)
requireEndpoint('a2ui', contract.agentAdapters.a2ui)
requireEndpoint('a2aAgentCard', contract.agentAdapters.a2aAgentCard)
requireEndpoint('a2aAgentJson', contract.agentAdapters.a2aAgentJson)
requireEndpoint('aiSdk', contract.agentAdapters.aiSdk)
requireEndpoint('jsonRender', contract.agentAdapters.jsonRender)
requireEndpoint('copilotKit', contract.agentAdapters.copilotKit)
requireNoPlaceholderEndpoints('agentAdapters', contract.agentAdapters)
requireNoPlaceholderEndpoints('generativeUi', generativeUi)
requireNoPlaceholderEndpoints('mcpUi', mcpUi)
requireNoPlaceholderEndpoints('agUi', agUi)
requireNoPlaceholderEndpoints('a2ui', a2ui)
requireNoPlaceholderEndpoints('a2a', a2a)
requireNoPlaceholderEndpoints('aiSdk', aiSdk)
requireNoPlaceholderEndpoints('jsonRender', jsonRender)
requireNoPlaceholderEndpoints('copilotKit', copilotKit)
requireNoPlaceholderEndpoints('uiAdapterKit', uiAdapterKit)

requireAdapter('mcp_apps', 'implemented')
requireAdapter('openai_chatgpt_apps', 'implemented')
requireAdapter('generic_iframe_or_web_component', 'implemented')
requireAdapter('mcp_ui', 'implemented-adapter-kit')
requireAdapter('ag_ui', 'implemented-adapter-kit')
requireAdapter('a2ui', 'implemented-adapter-kit')
requireAdapter('a2a', 'implemented-discovery')
requireAdapter('ai_sdk_generui', 'implemented-adapter-kit')
requireAdapter('vercel_json_render', 'implemented-adapter-kit')
requireAdapter('copilotkit', 'implemented-adapter-kit')

if (!generativeUi.adapters?.length || !generativeUi.endpoints?.chatgptApp) {
  failures.push('generative UI manifest missing adapters or ChatGPT endpoint')
}
if (generativeUi.adapterKit !== contract.agentAdapters.uiAdapterKit) {
  failures.push('generative UI manifest missing ui adapter kit endpoint')
}
if (generativeUi.actionContract?.invocation !== contract.agentAdapters.actionInvocation) {
  failures.push('generative UI manifest missing action invocation endpoint')
}
if (generativeUi.hostClient !== contract.agentAdapters.hostClient) {
  failures.push('generative UI manifest missing host client endpoint')
}
if (
  generativeUi.genericHostBridge?.schemaVersion !== 'speak.widget-postmessage.v1' ||
  !generativeUi.genericHostBridge?.inboundMessages?.includes('speak:hydrate') ||
  !generativeUi.genericHostBridge?.outboundMessages?.includes('speak:tool-call') ||
  !generativeUi.genericHostBridge?.securityRule?.includes('parent frame')
) {
  failures.push('generative UI manifest missing generic widget host bridge')
}
if (!agUi.tools?.some((tool) => tool.name === 'start_live_call')) {
  failures.push('AG-UI manifest missing start_live_call tool descriptor')
}
if (!agUi.transports?.some((transport) => transport.id === 'contract_action_invocation')) {
  failures.push('AG-UI manifest missing contract action invocation transport')
}
if (!agUi.eventMapping?.tools?.length || !agUi.eventMapping?.humanInLoop?.length) {
  failures.push('AG-UI manifest missing tool or human-in-loop event mapping')
}
if (!mcpUi.surfaces?.some((surface) => surface.surface === 'library')) {
  failures.push('MCP UI manifest missing library surface')
}
if (!a2ui.surfaces?.some((surface) => surface.surfaceId === 'speak-dialer')) {
  failures.push('A2UI manifest missing speak-dialer surface')
}
if (!a2ui.surfaces?.some((surface) => surface.surfaceId === 'speak-library')) {
  failures.push('A2UI manifest missing speak-library surface')
}
if (!a2ui.actions?.some((action) => action.eventName === 'start_queue')) {
  failures.push('A2UI manifest missing start_queue action mapping')
}
if (!a2a.skills?.some((skill) => skill.id === 'live-call-control')) {
  failures.push('A2A Agent Card missing live-call-control skill')
}
if (!a2a.xSpeak?.discoveryAliases?.includes(contract.agentAdapters.a2aAgentJson)) {
  failures.push('A2A Agent Card missing .well-known/agent.json discovery alias')
}
if (!a2a.supportedInterfaces?.some((item) => item.protocolBinding === 'MCP_STREAMABLE_HTTP')) {
  failures.push('A2A Agent Card missing MCP supported interface')
}
if (!a2a.supportedInterfaces?.some((item) => item.protocolBinding === 'SPEAK_ACTION_INVOCATION')) {
  failures.push('A2A Agent Card missing action invocation supported interface')
}
if (!a2a.supportedInterfaces?.some((item) => item.protocolBinding === 'ESM_HOST_CLIENT')) {
  failures.push('A2A Agent Card missing host client supported interface')
}
if (!aiSdk.components?.some((component) => component.renderTool === 'render_speak_dialer')) {
  failures.push('AI SDK manifest missing dialer component mapping')
}
if (!aiSdk.components?.some((component) => component.renderTool === 'render_speak_library')) {
  failures.push('AI SDK manifest missing library component mapping')
}
if (aiSdk.sourceContracts?.actionInvocation !== contract.agentAdapters.actionInvocation) {
  failures.push('AI SDK manifest missing action invocation source contract')
}
if (aiSdk.sourceContracts?.hostClient !== contract.agentAdapters.hostClient) {
  failures.push('AI SDK manifest missing host client source contract')
}
if (!aiSdk.tools?.some((tool) => tool.name === 'sync_speak_config')) {
  failures.push('AI SDK manifest missing sync_speak_config model tool mapping')
}
if (!jsonRender.surfaces?.some((surface) => surface.surface === 'library')) {
  failures.push('Vercel JSON Render manifest missing library surface')
}
if (!jsonRender.catalog?.components?.includes('SpeakSurface')) {
  failures.push('Vercel JSON Render manifest missing SpeakSurface catalog component')
}
if (!copilotKit.renderComponents?.some((component) => component.renderTool === 'render_speak_library')) {
  failures.push('CopilotKit manifest missing library render component')
}
if (!copilotKit.actions?.some((action) => action.name === 'start_live_call')) {
  failures.push('CopilotKit manifest missing start_live_call action mapping')
}
if (
  uiAdapterKit.surfaces?.length !== 3 ||
  !uiAdapterKit.surfaces?.every(
    (surface) =>
      surface.genericHost?.hydrateMessage?.type === 'speak:hydrate' &&
      surface.agUi?.eventSequence?.some((event) => event.type === 'StateSnapshot') &&
      surface.a2ui?.messages?.some((message) => message.type === 'updateDataModel') &&
      surface.aiSdk?.propsFrom === 'toolResult.structuredContent' &&
      surface.runtimeSnapshotUrl?.includes(`surface=${surface.surface}`),
  )
) {
  failures.push('UI adapter kit missing per-surface generic, AG-UI, A2UI, or AI SDK envelopes')
}
if (uiAdapterKit.runtimeSnapshot?.endpoint !== contract.agentAdapters.uiSnapshot) {
  failures.push('UI adapter kit missing runtime snapshot endpoint')
}
if (uiAdapterKit.sourceContracts?.actionInvocation !== contract.agentAdapters.actionInvocation) {
  failures.push('UI adapter kit missing action invocation source contract')
}
if (uiAdapterKit.sourceContracts?.hostClient !== contract.agentAdapters.hostClient) {
  failures.push('UI adapter kit missing host client source contract')
}

const playgroundRoute = contract.frontend?.routes?.find((route) => route.id === 'configs')
if (
  !playgroundRoute?.purpose?.includes('phone-quality tests') ||
  !playgroundRoute?.purpose?.includes('owner Smart Config')
) {
  failures.push('configs route purpose must describe current Playground phone-quality and Smart Config scope')
}
const playgroundRenderTool = contract.chatgptApp?.renderTools?.find(
  (tool) => tool.id === 'render_speak_configs',
)
if (
  playgroundRenderTool?.title !== 'Render Speak Playground widget' ||
  !playgroundRenderTool?.description?.includes('phone-quality tests') ||
  !playgroundRenderTool?.description?.includes('owner Smart Config')
) {
  failures.push('render_speak_configs must be documented as the current Playground widget')
}
if (!contract.product?.productionPlaygroundUrl?.endsWith('/configs')) {
  failures.push('product contract missing productionPlaygroundUrl for the /configs Playground route')
}

const libraryRoute = contract.frontend?.routes?.find((route) => route.id === 'library')
const dialerRoute = contract.frontend?.routes?.find((route) => route.id === 'dialer')
const libraryRenderTool = contract.chatgptApp?.renderTools?.find(
  (tool) => tool.id === 'render_speak_library',
)
const dialerRenderTool = contract.chatgptApp?.renderTools?.find(
  (tool) => tool.id === 'render_speak_dialer',
)
requireCurrentContactCopy('library route purpose', libraryRoute?.purpose, [
  'Contact library',
])
requireCurrentContactCopy('dialer route purpose', dialerRoute?.purpose, [
  'contact queue',
])
requireCurrentContactCopy('library render tool', libraryRenderTool?.description, [
  'contact library',
])
requireCurrentContactCopy('dialer render tool', dialerRenderTool?.description, [
  'contact queue',
])
requireCurrentContactCopy('A2A description', a2a.description, ['contact queues'])
for (const skill of a2a.skills || []) {
  requireCurrentContactCopy(`A2A skill ${skill.id}`, skill.description, [])
}

const highRiskTools = agUi.tools.filter(
  (tool) => tool.risk === 'high' || tool.externalSideEffect,
)
highRiskTools.forEach((tool) => {
  if (!tool.parameters?.properties?.authorizationMode) {
    failures.push(`${tool.name} missing authorizationMode in adapter input schema`)
  }
  if (!tool.proof?.length) {
    failures.push(`${tool.name} missing proof contract`)
  }
})

if (failures.length > 0) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        failures,
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
        adapters: contract.generativeUi.adapters.map((adapter) => ({
          id: adapter.id,
          status: adapter.status,
        })),
        endpoints: contract.agentAdapters,
        mcpUiSurfaces: mcpUi.surfaces.map((surface) => surface.surface),
        agUiTools: agUi.tools.length,
        a2uiSurfaces: a2ui.surfaces.map((surface) => surface.surfaceId),
        a2aSkills: a2a.skills.map((skill) => skill.id),
        aiSdkComponents: aiSdk.components.map((component) => component.id),
        jsonRenderSurfaces: jsonRender.surfaces.map((surface) => surface.surface),
        copilotKitComponents: copilotKit.renderComponents.map(
          (component) => component.name,
        ),
        uiAdapterKit: contract.agentAdapters.uiAdapterKit,
        uiSnapshot: contract.agentAdapters.uiSnapshot,
        actionInvocation: contract.agentAdapters.actionInvocation,
        hostClient: contract.agentAdapters.hostClient,
      },
      null,
      2,
    ),
  )
}

function requireEndpoint(name, value) {
  if (!value) failures.push(`missing adapter endpoint ${name}`)
  if (placeholderEndpointPattern.test(String(value || ''))) {
    failures.push(`adapter endpoint ${name} still uses placeholder host ${value}`)
  }
}

function requireAdapter(id, status) {
  const adapter = contract.generativeUi.adapters.find((item) => item.id === id)
  if (!adapter) {
    failures.push(`missing adapter ${id}`)
    return
  }
  if (adapter.status !== status) {
    failures.push(`adapter ${id} status ${adapter.status}; expected ${status}`)
  }
  if (!adapter.endpoints?.length) {
    failures.push(`adapter ${id} missing endpoint list`)
  }
}

function requireNoPlaceholderEndpoints(label, value) {
  const matches = collectStrings(value)
    .filter((item) => /^https?:\/\//i.test(item))
    .filter((item) => placeholderEndpointPattern.test(item))
  for (const match of new Set(matches)) {
    failures.push(`${label} contains placeholder endpoint ${match}`)
  }
}

function requireCurrentContactCopy(label, value, requiredTokens) {
  const text = String(value || '')
  const stalePattern = /\bLead library\b|\blead library\b|\blead queue\b|\blead queues\b|\bselected lead\b|leads \//i
  if (stalePattern.test(text)) {
    failures.push(`${label} contains stale lead-centric product copy: ${text}`)
  }
  for (const token of requiredTokens) {
    if (!text.includes(token)) {
      failures.push(`${label} missing current contact-centric token ${token}`)
    }
  }
}

function collectStrings(value, seen = new WeakSet()) {
  if (typeof value === 'string') return [value]
  if (!value || typeof value !== 'object') return []
  if (seen.has(value)) return []
  seen.add(value)
  if (Array.isArray(value)) return value.flatMap((item) => collectStrings(item, seen))
  return Object.values(value).flatMap((item) => collectStrings(item, seen))
}
