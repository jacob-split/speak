import fs from 'node:fs'
import {
  buildSpeakA2aAgentCard,
  buildSpeakA2uiManifest,
  buildSpeakAgUiManifest,
  buildSpeakAiSdkManifest,
  buildSpeakAgentContract,
  buildSpeakCopilotKitManifest,
  buildSpeakAgentReadinessReport,
  buildSpeakChatGptAppManifest,
  buildSpeakGenerativeUiManifest,
  buildSpeakJsonRenderManifest,
  buildSpeakMcpUiManifest,
  buildSpeakOpenApiDocument,
  buildSpeakUiAdapterKit,
} from '../server/agent-contract.mjs'
import { speakWidgetDocument } from '../server/speak-mcp.mjs'

const publicBaseUrl =
  process.env.PUBLIC_BASE_URL || 'https://speak.example.com/speak'
const options = {
  basePath: process.env.BASE_PATH || '/speak',
  publicBaseUrl,
}

const failures = []
const contract = buildSpeakAgentContract(options)
const readiness = buildSpeakAgentReadinessReport(options)
const chatgptApp = buildSpeakChatGptAppManifest(options)
const generativeUi = buildSpeakGenerativeUiManifest(options)
const openapi = buildSpeakOpenApiDocument(options)
const mcpUi = buildSpeakMcpUiManifest(options)
const agUi = buildSpeakAgUiManifest(options)
const a2ui = buildSpeakA2uiManifest(options)
const a2a = buildSpeakA2aAgentCard(options)
const aiSdk = buildSpeakAiSdkManifest(options)
const jsonRender = buildSpeakJsonRenderManifest(options)
const copilotKit = buildSpeakCopilotKitManifest(options)
const uiKit = buildSpeakUiAdapterKit(options)
const widgetHtml = speakWidgetDocument(options)
const hostClientSource = fs.readFileSync('agent/host-client/speak-agent-client.mjs', 'utf8')
const serverSource = fs.readFileSync('server/index.mjs', 'utf8')
const docs = {
  agents: fs.readFileSync('AGENTS.md', 'utf8'),
  readme: fs.readFileSync('README.md', 'utf8'),
  agentReference: fs.readFileSync('docs/agent-reference.md', 'utf8'),
  agentIntegration: fs.readFileSync('docs/agent-integration.md', 'utf8'),
  backendApiReference: fs.readFileSync('docs/backend-api-reference.md', 'utf8'),
  communicationThreadModel: fs.readFileSync('docs/communication-thread-model.md', 'utf8'),
  configurationOptions: fs.readFileSync('docs/configuration-options.md', 'utf8'),
  publishedIndex: fs.readFileSync('docs/index.html', 'utf8'),
  publishedMarkdown: fs.readFileSync('docs/index.md', 'utf8'),
  generativeUiWidgets: fs.readFileSync('docs/generative-ui-widgets.md', 'utf8'),
  voiceProviderIntegration: fs.readFileSync('docs/voice-provider-integration.md', 'utf8'),
  uiReference: fs.readFileSync('docs/ui-reference.md', 'utf8'),
  skill: fs.readFileSync('agent/skills/speak-operator/SKILL.md', 'utf8'),
  workflows: fs.readFileSync('agent/skills/speak-operator/references/workflows.md', 'utf8'),
}
const screenshotFiles = [
  'docs/assets/screenshots/library-contacts-light.png',
  'docs/assets/screenshots/library-contacts-dark.png',
  'docs/assets/screenshots/library-agents-light.png',
  'docs/assets/screenshots/library-agents-dark.png',
  'docs/assets/screenshots/library-activity-light.png',
  'docs/assets/screenshots/library-activity-dark.png',
  'docs/assets/screenshots/dialer-light.png',
  'docs/assets/screenshots/dialer-dark.png',
  'docs/assets/screenshots/playground-light.png',
  'docs/assets/screenshots/playground-dark.png',
]

requireReadiness()
requireChatGptPreserved()
requirePlatformAdapterCoverage()
requireActionAndProofCoverage()
requireContextKnowledgeCoverage()
requireCommunicationThreadCoverage()
requireWidgetNativeCoverage()
requireHostClientCoverage()
requireDocsAndSkillCoverage()
requireBrandAndSafetyBoundary()

if (failures.length > 0) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        failures,
        summary: auditSummary(),
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
        grade: 's-tier-candidate',
        summary: auditSummary(),
      },
      null,
      2,
    ),
  )
}

function requireReadiness() {
  if (readiness.overallStatus !== 'pass') {
    failures.push(`readiness overall status ${readiness.overallStatus}`)
  }
  if (readiness.summary.failed !== 0 || readiness.summary.checks < 13) {
    failures.push(`readiness checks insufficient: ${JSON.stringify(readiness.summary)}`)
  }
  if ((contract.knownGaps || []).length > 0) {
    failures.push(`contract knownGaps is not empty: ${contract.knownGaps.join(', ')}`)
  }
}

function requireChatGptPreserved() {
  const resource = chatgptApp.resources?.[0]
  if (chatgptApp.endpoint !== contract.mcpGeneration.runtimeEndpoint) {
    failures.push('ChatGPT app endpoint is not the MCP runtime endpoint')
  }
  if (resource?.mimeType !== 'text/html;profile=mcp-app') {
    failures.push('ChatGPT widget resource MIME is not MCP Apps HTML')
  }
  ;['render_speak_library', 'render_speak_dialer', 'render_speak_configs'].forEach((toolId) => {
    const tool = chatgptApp.renderTools?.find((item) => item.id === toolId)
    if (!tool) failures.push(`ChatGPT render tool missing ${toolId}`)
    if (tool?._meta?.ui?.resourceUri !== resource?.uri) {
      failures.push(`${toolId} missing _meta.ui.resourceUri`)
    }
    if (tool?._meta?.['openai/outputTemplate'] !== resource?.uri) {
      failures.push(`${toolId} missing OpenAI output template alias`)
    }
  })
  ;['window.openai', 'tools/call'].forEach((needle) => {
    if (!widgetHtml.includes(needle)) failures.push(`widget missing ChatGPT path ${needle}`)
  })
}

function requirePlatformAdapterCoverage() {
  const requiredEndpoints = [
    'capabilities',
    'openapi',
    'acp',
    'actionInvocation',
    'mcp',
    'chatgptApp',
    'readiness',
    'widgetHtml',
    'hostClient',
    'generativeUi',
    'uiAdapterKit',
    'uiSnapshot',
    'mcpUi',
    'agUi',
    'a2ui',
    'a2aAgentCard',
    'a2aAgentJson',
    'aiSdk',
    'jsonRender',
    'copilotKit',
  ]
  requiredEndpoints.forEach((key) => {
    if (!contract.agentAdapters[key]) failures.push(`missing agent adapter endpoint ${key}`)
  })

  const requiredAdapters = new Map([
    ['mcp_apps', 'implemented'],
    ['openai_chatgpt_apps', 'implemented'],
    ['generic_iframe_or_web_component', 'implemented'],
    ['mcp_ui', 'implemented-adapter-kit'],
    ['ag_ui', 'implemented-adapter-kit'],
    ['a2ui', 'implemented-adapter-kit'],
    ['a2a', 'implemented-discovery'],
    ['ai_sdk_generui', 'implemented-adapter-kit'],
    ['vercel_json_render', 'implemented-adapter-kit'],
    ['copilotkit', 'implemented-adapter-kit'],
  ])
  const adapters = new Map(contract.generativeUi.adapters.map((item) => [item.id, item.status]))
  requiredAdapters.forEach((status, id) => {
    if (adapters.get(id) !== status) {
      failures.push(`adapter ${id} status ${adapters.get(id) || 'missing'} expected ${status}`)
    }
  })

  if (generativeUi.hostClient !== contract.agentAdapters.hostClient) {
    failures.push('generative UI manifest does not advertise host client')
  }
  if (!a2a.supportedInterfaces?.some((item) => item.protocolBinding === 'ESM_HOST_CLIENT')) {
    failures.push('A2A card does not advertise ESM host client')
  }
  if (agUi.transports?.filter((item) => item.kind === 'rest').length < 2) {
    failures.push('AG-UI manifest does not expose both REST/OpenAPI and action invocation transports')
  }
  if (mcpUi.surfaces?.length !== 3) {
    failures.push('MCP UI manifest does not expose all Speak surfaces')
  }
  if (a2ui.surfaces?.length !== 3) {
    failures.push('A2UI manifest does not expose all Speak surfaces')
  }
  if (aiSdk.components?.length !== 3) {
    failures.push('AI SDK manifest does not expose all Speak components')
  }
  if (jsonRender.surfaces?.length !== 3) {
    failures.push('Vercel JSON Render manifest does not expose all Speak surfaces')
  }
  if (copilotKit.renderComponents?.length !== 3) {
    failures.push('CopilotKit manifest does not expose all Speak components')
  }
}

function requireActionAndProofCoverage() {
  const restMethods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
  const callable = contract.backend.actions.filter(
    (action) => action.callableByMcp && restMethods.has(action.method),
  )
  if (callable.length < 25) failures.push(`callable REST action count too low: ${callable.length}`)
  if (contract.actionInvocation.callableActionIds.length !== callable.length) {
    failures.push('actionInvocation callable IDs do not match callable REST actions')
  }
  callable.forEach((action) => {
    if (!openapi.paths?.[action.path]?.[action.method.toLowerCase()]) {
      failures.push(`OpenAPI missing callable action ${action.id}`)
    }
    if (action.method !== 'GET' && !(action.proof || []).length) {
      failures.push(`mutating action missing proof ${action.id}`)
    }
  })
  if (!openapi.paths?.['/api/agent/actions/{actionId}/invoke']?.post) {
    failures.push('OpenAPI missing generic action invocation endpoint')
  }
  const unsafeCallable = contract.backend.actions.filter(
    (action) =>
      action.callableByMcp &&
      ['internal', 'provider-webhook', 'provider-websocket', 'websocket', 'sse'].includes(
        action.kind,
      ),
  )
  if (unsafeCallable.length > 0) {
    failures.push(`unsafe actions callable: ${unsafeCallable.map((action) => action.id).join(', ')}`)
  }
}

function requireContextKnowledgeCoverage() {
  const contextActions = ['upload_context_file', 'download_context_file', 'delete_context_file']
  const actionById = new Map(contract.backend.actions.map((action) => [action.id, action]))
  contextActions.forEach((id) => {
    const action = actionById.get(id)
    if (!action) {
      failures.push(`missing context lifecycle action ${id}`)
      return
    }
    if (!action.documentedInOpenApi) {
      failures.push(`context lifecycle action not documented in OpenAPI ${id}`)
    }
    if (action.callableByMcp) {
      failures.push(`binary context action should not be MCP/actionInvocation callable ${id}`)
    }
    if (!openapi.paths?.[action.path]?.[action.method.toLowerCase()]) {
      failures.push(`OpenAPI missing context lifecycle route ${id}`)
    }
  })

  const leadContext = contract.dataSchemas?.lead?.properties?.context
  const profileContext = contract.dataSchemas?.profile?.properties?.context
  const contextFields = contract.dataSchemas?.contextFields
  const extractionStatuses =
    contextFields?.properties?.files?.items?.properties?.extractionStatus?.enum || []
  if (!leadContext) failures.push('lead schema missing context fields')
  if (!profileContext) failures.push('profile schema missing context fields')
  ;['ready', 'empty', 'unsupported', 'error'].forEach((status) => {
    if (!extractionStatuses.includes(status)) {
      failures.push(`context extraction status enum missing ${status}`)
    }
  })
}

function requireCommunicationThreadCoverage() {
  const runtime = contract.runtime?.communicationThreads || {}
  const threadSchema = contract.dataSchemas?.communicationThread
  const messageSchema = contract.dataSchemas?.communicationMessage
  const topicSchema = contract.dataSchemas?.communicationTopic
  const identitySchema = contract.dataSchemas?.contactIdentityLink
  if (runtime.playbook !== 'docs/communication-thread-model.md') {
    failures.push('communication thread playbook missing from runtime contract')
  }
  if (runtime.status !== 'implemented') {
    failures.push(`communication thread runtime status is ${runtime.status || 'missing'}`)
  }
  ;[
    'read_communication_threads',
    'read_communication_thread',
    'read_communication_thread_messages',
    'read_contact_communication_memory',
  ].forEach((actionId) => {
    if (!runtime.currentReadActions?.includes(actionId)) {
      failures.push(`communication thread currentReadActions missing ${actionId}`)
    }
    if (!contract.backend?.actions?.some((action) => action.id === actionId && action.callableByMcp)) {
      failures.push(`communication thread backend action missing callable ${actionId}`)
    }
  })
  ;['call', 'sms', 'email', 'browser_test', 'operator_chat', 'tool', 'system'].forEach((channel) => {
    if (!runtime.channels?.includes(channel)) {
      failures.push(`communication thread channel missing ${channel}`)
    }
  })
  if (!threadSchema?.properties?.channels?.items?.enum?.includes('sms')) {
    failures.push('communicationThread schema missing SMS channel')
  }
  if (!messageSchema?.properties?.channel?.enum?.includes('email')) {
    failures.push('communicationMessage schema missing email channel')
  }
  if (!topicSchema?.properties?.sourceMessageIds) {
    failures.push('communicationTopic schema missing sourceMessageIds')
  }
  if (!identitySchema?.properties?.kind?.enum?.includes('phone')) {
    failures.push('contactIdentityLink schema missing phone identity kind')
  }
  if (!contract.mcpGeneration?.validationCommands?.includes('npm run qa:communication-threads')) {
    failures.push('contract validation commands missing qa:communication-threads')
  }
  if (!uiKit.validation?.localCommands?.includes('npm run qa:communication-threads')) {
    failures.push('UI adapter kit validation commands missing qa:communication-threads')
  }
}

function requireWidgetNativeCoverage() {
  if (uiKit.surfaces?.length !== chatgptApp.renderTools?.length) {
    failures.push('UI adapter kit surface count does not match ChatGPT render tools')
  }
  uiKit.surfaces?.forEach((surface) => {
    if (surface.genericHost?.hydrateMessage?.type !== 'speak:hydrate') {
      failures.push(`${surface.surface} missing generic hydrate message`)
    }
    if (!surface.agUi?.eventSequence?.some((event) => event.type === 'StateSnapshot')) {
      failures.push(`${surface.surface} missing AG-UI StateSnapshot`)
    }
    if (!surface.a2ui?.messages?.some((message) => message.type === 'updateDataModel')) {
      failures.push(`${surface.surface} missing A2UI data model update`)
    }
    if (surface.aiSdk?.propsFrom !== 'toolResult.structuredContent') {
      failures.push(`${surface.surface} missing AI SDK structuredContent props mapping`)
    }
  })
  ;['speak:hydrate', 'speak:tool-call', 'speak:follow-up', 'speak:ready'].forEach((needle) => {
    if (!widgetHtml.includes(needle)) failures.push(`widget missing generic bridge ${needle}`)
  })
}

function requireHostClientCoverage() {
  if (contract.hostClient?.schemaVersion !== 'speak.host-client.v1') {
    failures.push('hostClient contract has wrong schema')
  }
  if (uiKit.sourceContracts?.hostClient !== contract.agentAdapters.hostClient) {
    failures.push('UI adapter kit sourceContracts missing host client')
  }
  ;[
    'createSpeakAgentClient',
    'hydrateSpeakWidget',
    'connectSpeakWidget',
    'uiSnapshot',
    'mcpUi',
    'agUi',
    'a2ui',
    'invoke',
    'callTool',
    'a2aAgentJson',
    'jsonRender',
    'copilotKit',
    'speak.widget-postmessage.v1',
  ].forEach((needle) => {
    if (!hostClientSource.includes(needle)) failures.push(`host client source missing ${needle}`)
  })
}

function requireDocsAndSkillCoverage() {
  const combinedDocs = Object.values(docs).join('\n')
  ;[
    'docs/ui-reference.md',
    'docs/backend-api-reference.md',
    'docs/communication-thread-model.md',
    'docs/configuration-options.md',
    'docs/agent-integration.md',
    '/api/agent/host-client.mjs',
    '/api/agent/actions/{actionId}/invoke',
    '/api/agent/ui-snapshot.json',
    '/speak/mcp',
    'ChatGPT',
    'AG-UI',
    'A2UI',
    'A2A',
    'AI SDK',
    'context files',
    'lead.context',
    'profile.context',
    'communicationThread',
    'communicationMessage',
    'contactIdentityLink',
    'unresolved-attribution',
    'qa:communication-threads',
    'upload_context_file',
    'SPEAK_CONTEXT_FILE_UPLOAD_MAX_BYTES',
    'SPEAK_SMART_CONFIG_ENABLED',
    'VITE_BASE_PATH',
    'responsive UI reference',
    'qa:ui-contract',
    'https://speak.split-llc.com/',
    'Documentation',
    'Backend API',
    'UI reference',
    'Agent integration',
    'Generative UI widgets',
    'Provider integration',
    'Communication thread model',
    'Configuration',
    'docs/assets/screenshots/dialer-light.png',
    'docs/assets/screenshots/dialer-dark.png',
    'docs/assets/screenshots/library-contacts-light.png',
    'docs/assets/screenshots/library-contacts-dark.png',
    'docs/assets/screenshots/library-activity-light.png',
    'docs/assets/screenshots/library-activity-dark.png',
    'docs/assets/screenshots/playground-light.png',
    'docs/assets/screenshots/playground-dark.png',
    'qa:brand-marketing',
    'SPEAK_PRODUCT_PAGE_URL',
    'qa:speak-agent-tier',
  ].forEach((needle) => {
    if (!combinedDocs.includes(needle)) failures.push(`docs missing ${needle}`)
  })
  screenshotFiles.forEach((filePath) => {
    if (!fs.existsSync(filePath)) failures.push(`screenshot fixture missing ${filePath}`)
  })
}

function requireBrandAndSafetyBoundary() {
  const generatedPayload = JSON.stringify({
    contract,
    readiness,
    chatgptApp,
    generativeUi,
    agUi,
    a2ui,
    a2a,
    aiSdk,
    uiKit,
  })
  if (/HUME_API_KEY|INWORLD_API_KEY|\/evi\/(?:configs|chat|tools|language_models)|hume-session/.test(generatedPayload)) {
    failures.push('generated agent-facing payload leaks raw provider internals')
  }
  if (!contract.safety?.failClosed?.includes('backend proof')) {
    failures.push('safety contract does not require backend proof')
  }
  if (!contract.actionInvocation.blockedKinds?.includes('provider-webhook')) {
    failures.push('action invocation does not document provider webhook blocking')
  }
  if (!contract.hostClient.securityRule?.includes('does not broaden backend authorization')) {
    failures.push('host client security rule does not preserve backend authorization boundary')
  }

}

function auditSummary() {
  return {
    readiness: readiness.summary,
    chatgptEndpoint: chatgptApp.endpoint,
    hostClient: contract.agentAdapters.hostClient,
    actionInvocation: contract.agentAdapters.actionInvocation,
    adapters: contract.generativeUi.adapters.map((adapter) => ({
      id: adapter.id,
      status: adapter.status,
    })),
    callableRestActions: contract.actionInvocation.callableActionCount,
    uiSurfaces: uiKit.surfaces.map((surface) => surface.surface),
  }
}
