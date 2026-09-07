import 'dotenv/config'
import {
  buildSpeakAgentContract,
  buildSpeakUiAdapterKit,
} from '../server/agent-contract.mjs'

const publicBaseUrl =
  process.env.PUBLIC_BASE_URL || 'https://speak.example.com/speak'
const options = {
  basePath: process.env.BASE_PATH || '/speak',
  publicBaseUrl,
}

const contract = buildSpeakAgentContract(options)
const kit = buildSpeakUiAdapterKit(options)
const failures = []

if (kit.schemaVersion !== 'speak.ui-adapter-kit.v1') {
  failures.push(`unexpected schemaVersion ${kit.schemaVersion}`)
}
if (kit.sourceContracts?.mcp !== contract.mcpGeneration.runtimeEndpoint) {
  failures.push('adapter kit MCP source contract does not match generated contract')
}
if (kit.sourceContracts?.widgetHtml !== contract.agentAdapters.widgetHtml) {
  failures.push('adapter kit widget endpoint does not match generated contract')
}
if (kit.sourceContracts?.uiSnapshot !== contract.agentAdapters.uiSnapshot) {
  failures.push('adapter kit snapshot endpoint does not match generated contract')
}
;['mcpUi', 'agUi', 'a2ui', 'aiSdk', 'jsonRender', 'copilotKit'].forEach((key) => {
  if (kit.sourceContracts?.[key] !== contract.agentAdapters[key]) {
    failures.push(`adapter kit ${key} source contract does not match generated contract`)
  }
})
if (kit.sourceContracts?.actionInvocation !== contract.agentAdapters.actionInvocation) {
  failures.push('adapter kit action invocation endpoint does not match generated contract')
}
if (kit.sourceContracts?.hostClient !== contract.agentAdapters.hostClient) {
  failures.push('adapter kit host client endpoint does not match generated contract')
}
if (kit.bridge?.schemaVersion !== 'speak.widget-postmessage.v1') {
  failures.push('adapter kit missing generic widget bridge')
}

const renderToolIds = new Set(contract.chatgptApp.renderTools.map((tool) => tool.id))
const componentIds = new Set([
  'SpeakLibraryWidget',
  'SpeakDialerWidget',
  'SpeakPlaygroundWidget',
])

if (kit.surfaces?.length !== contract.chatgptApp.renderTools.length) {
  failures.push('adapter kit surface count does not match render tools')
}
;['library', 'dialer', 'configs'].forEach((surfaceId) => {
  if (!kit.surfaces?.some((surface) => surface.surface === surfaceId)) {
    failures.push(`adapter kit missing ${surfaceId} surface`)
  }
})

for (const surface of kit.surfaces || []) {
  if (!renderToolIds.has(surface.renderTool)) {
    failures.push(`${surface.surface} references unknown render tool ${surface.renderTool}`)
  }
  if (!surface.runtimeSnapshotUrl?.includes(`surface=${surface.surface}`)) {
    failures.push(`${surface.surface} missing prefilled runtime snapshot URL`)
  }
  if (surface.mcpApps?.outputTemplate !== surface.resourceUri) {
    failures.push(`${surface.surface} MCP Apps outputTemplate does not match resourceUri`)
  }
  if (surface.genericHost?.hydrateMessage?.type !== 'speak:hydrate') {
    failures.push(`${surface.surface} missing generic hydrate message`)
  }
  if (
    surface.genericHost?.hydrateMessage?.schemaVersion !==
    kit.bridge?.schemaVersion
  ) {
    failures.push(`${surface.surface} generic hydrate message schema mismatch`)
  }
  ;['RunStarted', 'ToolCallStart', 'ToolCallArgs', 'ToolCallEnd', 'ToolCallResult', 'StateSnapshot', 'RunFinished'].forEach(
    (type) => {
      if (!surface.agUi?.eventSequence?.some((event) => event.type === type)) {
        failures.push(`${surface.surface} AG-UI sequence missing ${type}`)
      }
    },
  )
  ;['createSurface', 'updateComponents', 'updateDataModel'].forEach((type) => {
    if (!surface.a2ui?.messages?.some((message) => message.type === type)) {
      failures.push(`${surface.surface} A2UI messages missing ${type}`)
    }
  })
  if (!componentIds.has(surface.aiSdk?.componentId)) {
    failures.push(`${surface.surface} AI SDK component id is not recognized`)
  }
  if (surface.aiSdk?.propsFrom !== 'toolResult.structuredContent') {
    failures.push(`${surface.surface} AI SDK props source is not structuredContent`)
  }
}

if (!kit.validation?.localCommands?.includes('npm run qa:ui-adapter-kit')) {
  failures.push('adapter kit validation commands omit qa:ui-adapter-kit')
}
if (!kit.validation?.localCommands?.includes('npm run qa:ui-snapshot')) {
  failures.push('adapter kit validation commands omit qa:ui-snapshot')
}
if (!kit.validation?.localCommands?.includes('npm run qa:action-invoke')) {
  failures.push('adapter kit validation commands omit qa:action-invoke')
}
if (!kit.validation?.localCommands?.includes('npm run qa:host-client')) {
  failures.push('adapter kit validation commands omit qa:host-client')
}
if (kit.adapters?.mcpUi?.manifest !== contract.agentAdapters.mcpUi) {
  failures.push('adapter kit missing MCP UI adapter manifest')
}
if (kit.adapters?.jsonRender?.manifest !== contract.agentAdapters.jsonRender) {
  failures.push('adapter kit missing Vercel JSON Render adapter manifest')
}
if (kit.adapters?.copilotKit?.manifest !== contract.agentAdapters.copilotKit) {
  failures.push('adapter kit missing CopilotKit adapter manifest')
}

if (failures.length > 0) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2))
  process.exitCode = 1
} else {
  console.log(
    JSON.stringify(
      {
        ok: true,
        schemaVersion: kit.schemaVersion,
        endpoint: contract.agentAdapters.uiAdapterKit,
        surfaces: kit.surfaces.map((surface) => ({
          surface: surface.surface,
          renderTool: surface.renderTool,
          componentId: surface.aiSdk.componentId,
        })),
      },
      null,
      2,
    ),
  )
}
