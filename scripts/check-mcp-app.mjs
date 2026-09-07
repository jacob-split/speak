import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildSpeakAgentContract } from '../server/agent-contract.mjs'
import { createSpeakMcpServer } from '../server/speak-mcp.mjs'

const publicBaseUrl =
  process.env.PUBLIC_BASE_URL || 'https://speak.example.com/speak'
const qaApiRoot = process.env.SPEAK_QA_API_ROOT || 'http://127.0.0.1:8787/api'
const contract = buildSpeakAgentContract({
  basePath: process.env.BASE_PATH || '/speak',
  publicBaseUrl,
})
const fixtureApiEnabled = !process.env.SPEAK_QA_API_ROOT
const restoreFetch = fixtureApiEnabled ? installFixtureFetch(qaApiRoot) : () => {}
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
const server = createSpeakMcpServer({
  apiRoot: qaApiRoot,
  basePath: process.env.BASE_PATH || '/speak',
  publicBaseUrl,
})
const client = new Client({
  name: 'speak-mcp-app-qa',
  version: contract.contractVersion,
})

const failures = []

try {
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ])

  const toolsResult = await client.listTools()
  const tools = toolsResult.tools || []
  const toolByName = new Map(tools.map((tool) => [tool.name, tool]))
  const resourcesResult = await client.listResources()
  const resources = resourcesResult.resources || []
  const resource = contract.chatgptApp.resources[0]
  const widgetResource = resources.find((item) => item.uri === resource.uri)

  const searchTool = requireTool(toolByName, 'search')
  const fetchTool = requireTool(toolByName, 'fetch')
  if (!/recent calls/i.test(searchTool?.description || '')) {
    failures.push('search tool description no longer advertises recent-call lookup')
  }
  if (!/call:/.test(fetchTool?.inputSchema?.properties?.id?.description || '')) {
    failures.push('fetch tool schema missing call: result id guidance')
  }
  contract.chatgptApp.renderTools.forEach((renderTool) => {
    const tool = requireTool(toolByName, renderTool.id)
    if (tool?._meta?.ui?.resourceUri !== resource.uri) {
      failures.push(`${renderTool.id} missing _meta.ui.resourceUri`)
    }
    if (tool?._meta?.['openai/outputTemplate'] !== resource.uri) {
      failures.push(`${renderTool.id} missing openai/outputTemplate`)
    }
    if (tool?.annotations?.readOnlyHint !== true) {
      failures.push(`${renderTool.id} should be read-only render tool`)
    }
  })

  const startCallTool = requireTool(toolByName, 'start_live_call')
  if (!startCallTool?.inputSchema?.properties?.authorizationMode) {
    failures.push('start_live_call missing optional authorizationMode input')
  }
  if (startCallTool?.annotations?.openWorldHint !== true) {
    failures.push('start_live_call should advertise openWorldHint')
  }
  const endCallTool = requireTool(toolByName, 'end_live_call')
  if (endCallTool?.annotations?.destructiveHint !== true) {
    failures.push('end_live_call should advertise destructiveHint')
  }

  if (!widgetResource) {
    failures.push(`missing widget resource ${resource.uri}`)
  } else {
    if (widgetResource.mimeType !== resource.mimeType) {
      failures.push(`widget resource mime mismatch: ${widgetResource.mimeType}`)
    }
    if (!widgetResource._meta?.ui?.csp?.connectDomains?.length) {
      failures.push('widget resource missing CSP connect domains')
    }
    const resourceDomains = widgetResource._meta?.ui?.csp?.resourceDomains || []
    if (
      resourceDomains.some((domain) =>
        /fonts\.googleapis\.com|fonts\.gstatic\.com/i.test(domain),
      )
    ) {
      failures.push('widget resource CSP still allows old remote Google font domains')
    }
  }

  const widget = await client.readResource({ uri: resource.uri })
  const widgetHtml = widget.contents?.[0]?.text || ''
  const speakMcpSource = readFileSync(new URL('../server/speak-mcp.mjs', import.meta.url), 'utf8')
  if (!widgetHtml.includes('window.openai')) {
    failures.push('widget HTML missing window.openai compatibility path')
  }
  if (!widgetHtml.includes('tools/call')) {
    failures.push('widget HTML missing MCP Apps tools/call bridge path')
  }
  if (!widgetHtml.includes('authorizationMode')) {
    failures.push('widget HTML missing authorizationMode control')
  }
  if (!widgetHtml.includes('Communication threads')) {
    failures.push('widget HTML missing communication threads section')
  }
  if (!widgetHtml.includes('Helvetica Neue')) {
    failures.push('widget HTML missing Helvetica Neue font')
  }
  if (/Google Sans|Google\+Sans|fonts\.googleapis\.com|fonts\.gstatic\.com/i.test(widgetHtml)) {
    failures.push('widget HTML still loads old remote Google font')
  }
  ;['Library', 'Dialer', 'Playground'].forEach((label) => {
    if (!widgetHtml.includes(label)) {
      failures.push(`widget HTML missing route label ${label}`)
    }
  })
  if (!widgetHtml.includes('Contact library')) {
    failures.push('widget HTML missing current Contact library title')
  }
  if (!widgetHtml.includes('contacts /')) {
    failures.push('widget HTML missing current contacts count label')
  }
  if (/\bLead library\b|\blead library\b|\blead queue\b|\bselected lead\b|leads \//i.test(widgetHtml)) {
    failures.push('widget HTML contains stale lead-centric product copy')
  }
  if (/lead\.company \|\| lead\.name \|\| 'Lead'|title:\s*lead\.name \|\| 'Lead'|metadata:\s*\{\s*type:\s*'lead'/.test(speakMcpSource)) {
    failures.push('MCP search/fetch surface contains stale Lead fallback copy or metadata')
  }
  if (!/apiJson\(apiRoot, ['"]\/calls\/recent\?limit=500['"]\)/.test(speakMcpSource)) {
    failures.push('MCP search must hydrate the same bounded recent-call window as call fetch')
  }
  if (/Search leads|<h2>Leads<\/h2>|No leads loaded|<span>Leads<\/span>/i.test(widgetHtml)) {
    failures.push('widget HTML contains stale lead search/list copy')
  }
  if (!widgetHtml.includes('Search contacts, profiles, threads')) {
    failures.push('widget HTML missing current contact search placeholder')
  }
  if (!widgetHtml.includes('<span>Contacts</span>')) {
    failures.push('widget HTML missing current Contacts metric label')
  }
  ;[
    'speak.widget-postmessage.v1',
    'speak:hydrate',
    'speak:tool-result',
    'speak:tool-call',
    'speak:follow-up',
    'speak:ready',
    'speak:state',
    'event.source !== window.parent',
  ].forEach((snippet) => {
    if (!widgetHtml.includes(snippet)) {
      failures.push(`widget HTML missing generic host bridge snippet ${snippet}`)
    }
  })

  if (!contract.generativeUi?.widget?.httpUrl) {
    failures.push('contract missing platform-neutral widget HTTP URL')
  }
  if (!contract.mcpGeneration?.validationCommands?.includes('npm run qa:voice-configs')) {
    failures.push('contract missing voice config validation command')
  }
  if (!contract.mcpGeneration?.validationCommands?.includes('npm run qa:voice-provider-process')) {
    failures.push('contract missing voice provider process validation command')
  }
  if (!contract.mcpGeneration?.validationCommands?.includes('npm run qa:communication-threads')) {
    failures.push('contract missing communication thread validation command')
  }
  if (!contract.runtime?.voiceRuntime?.providers?.includes('hume') ||
      !contract.runtime?.voiceRuntime?.providers?.includes('inworld')) {
    failures.push('contract missing hume/inworld voice runtime providers')
  }
  if (contract.runtime?.voiceRuntime?.providerOnboarding?.playbook !== 'docs/voice-provider-integration.md') {
    failures.push('contract missing voice provider onboarding playbook')
  }
  if (
    !contract.generativeUi?.adapters?.some(
      (adapter) => adapter.id === 'openai_chatgpt_apps' && adapter.status === 'implemented',
    )
  ) {
    failures.push('contract missing implemented ChatGPT adapter')
  }
  if (
    !contract.generativeUi?.adapters?.some(
      (adapter) => adapter.id === 'generic_iframe_or_web_component' && adapter.status === 'implemented',
    )
  ) {
    failures.push('contract missing implemented generic widget adapter')
  }
  ;[
    'mcp_ui',
    'ag_ui',
    'a2ui',
    'a2a',
    'ai_sdk_generui',
    'vercel_json_render',
    'copilotkit',
  ].forEach((adapterId) => {
    if (!contract.generativeUi?.adapters?.some((adapter) => adapter.id === adapterId)) {
      failures.push(`contract missing ${adapterId} adapter guidance`)
    }
  })

  if (!toolByName.has('render_speak_library')) {
    failures.push('missing render_speak_library tool')
  }

  const rendered = await client.callTool({
    name: 'render_speak_dialer',
    arguments: {
      limit: 1,
      authorizationMode: 'yolo',
    },
  })
  if (rendered.structuredContent?.surface !== 'dialer') {
    failures.push('render_speak_dialer did not return dialer structuredContent')
  }
  if (rendered.structuredContent?.authorizationMode !== 'yolo') {
    failures.push('render_speak_dialer did not preserve authorizationMode')
  }
  if (!rendered.structuredContent?.communicationThreads) {
    failures.push('render_speak_dialer did not include communicationThreads')
  }
  if (rendered._meta?.ui?.resourceUri !== resource.uri) {
    failures.push('render_speak_dialer result missing widget resourceUri')
  }

  const renderedLibrary = await client.callTool({
    name: 'render_speak_library',
    arguments: {
      limit: 1,
      authorizationMode: 'yolo',
    },
  })
  if (renderedLibrary.structuredContent?.surface !== 'library') {
    failures.push('render_speak_library did not return library structuredContent')
  }
  if (!renderedLibrary.structuredContent?.communicationThreads) {
    failures.push('render_speak_library did not include communicationThreads')
  }

  if (fixtureApiEnabled) {
    const searchResult = await client.callTool({
      name: 'search',
      arguments: { query: 'Orion' },
    })
    const searchResults = searchResult.structuredContent?.results || []
    if (!searchResults.some((item) => item.id === 'call:call-docs-001')) {
      failures.push('search did not return recent call result call:call-docs-001')
    }
    const fetchedCall = await client.callTool({
      name: 'fetch',
      arguments: { id: 'call:call-docs-001' },
    })
    if (fetchedCall.structuredContent?.metadata?.type !== 'recentCall') {
      failures.push('fetch did not identify call: result as recentCall')
    }
    if (!String(fetchedCall.structuredContent?.url || '').includes('#transcript=call-docs-001')) {
      failures.push('fetch did not link recent call to Library transcript hash')
    }
    if (!String(fetchedCall.structuredContent?.text || '').includes('call-docs-001')) {
      failures.push('fetch did not include recent call payload text')
    }
  }

  if (failures.length > 0) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          failures,
          tools: tools.map((tool) => tool.name).sort(),
          resources: resources.map((item) => item.uri).sort(),
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
          toolCount: tools.length,
          widgetResource: resource.uri,
          renderTools: contract.chatgptApp.renderTools.map((tool) => tool.id),
          authorizationModes: contract.mcpGeneration.authorizationMode.modes.map(
            (mode) => mode.id,
          ),
        },
        null,
        2,
      ),
    )
  }
} finally {
  await Promise.allSettled([client.close(), server.close()])
  restoreFetch()
}

function requireTool(toolByName, name) {
  const tool = toolByName.get(name)
  if (!tool) failures.push(`missing tool ${name}`)
  return tool
}

function installFixtureFetch(apiRoot) {
  const originalFetch = globalThis.fetch
  const apiBase = apiRoot.replace(/\/+$/g, '')
  const apiBasePath = new URL(apiBase).pathname.replace(/\/+$/g, '')
  const fixtureWorkspace = {
    activeProfileId: 'agent-config-customer-follow-up',
    leads: [
      {
        id: 'contact-orion',
        name: 'Maya Chen',
        company: 'Orion Systems Group',
        phone: '+17045550118',
        email: 'maya@orion.example',
        status: 'Ready',
      },
    ],
    profiles: [
      {
        id: 'agent-config-customer-follow-up',
        name: 'Customer Follow Up',
        updatedAt: '2026-06-27T14:00:00.000Z',
        config: { voice: 'voice-speak-fixture' },
      },
    ],
    smartViews: [],
  }
  const fixtureThread = {
    threadId: 'thread-contact-orion',
    contactId: 'contact-orion',
    participants: [{ role: 'contact', label: 'Maya Chen' }],
    channels: ['call'],
    status: 'open',
    summary: 'Implementation checklist follow up',
    latestMessagePreview: 'Maya confirmed the upload path.',
    updatedAt: '2026-06-27T14:32:10.000Z',
  }
  const fixtureMessages = [
    {
      id: 'message-call-docs-001',
      threadId: fixtureThread.threadId,
      channel: 'call',
      body: 'Maya confirmed the upload path.',
      providerIds: { callControlId: 'call-docs-001' },
    },
  ]
  const fixtureCall = {
    callControlId: 'call-docs-001',
    chatId: 'chat-docs-001',
    lead: {
      id: 'contact-orion',
      name: 'Maya Chen',
      business_name: 'Orion Systems Group',
      phone_on_file: '+17045550118',
      email_on_file: 'maya@orion.example',
    },
    agent: {
      id: 'agent-config-customer-follow-up',
      name: 'Customer Follow Up',
    },
    createdAt: '2026-06-27T14:31:02.000Z',
    updatedAt: '2026-06-27T14:32:10.000Z',
    outcome: 'completed',
    phase: 'ended',
    insight: 'Confirmed the implementation checklist upload path.',
    transcript: [
      {
        speaker: 'AI',
        at: '10:31:02 AM',
        text: 'This is Speak calling about the Orion onboarding file.',
      },
      {
        speaker: 'Lead',
        at: '10:31:19 AM',
        text: 'I can send the implementation checklist today.',
      },
    ],
  }

  globalThis.fetch = async (input, init) => {
    const href = typeof input === 'string' ? input : input?.url
    if (href && href.startsWith(`${apiBase}/`)) {
      const url = new URL(href)
      const path = url.pathname.slice(apiBasePath.length) || '/'
      if (path === '/health') return jsonFixture({ ok: true })
      if (path === '/workspace') return jsonFixture(fixtureWorkspace)
      if (path === '/communication-threads') return jsonFixture({ threads: [fixtureThread] })
      if (path === `/communication-threads/${encodeURIComponent(fixtureThread.threadId)}`) {
        return jsonFixture({ thread: fixtureThread })
      }
      if (path === `/communication-threads/${encodeURIComponent(fixtureThread.threadId)}/messages`) {
        return jsonFixture({ messages: fixtureMessages })
      }
      if (path === '/calls/recent') return jsonFixture({ calls: [fixtureCall] })
      if (path === '/agent-configs/speak-options') return jsonFixture({ profiles: [] })
      return jsonFixture({ error: 'fixture route not found' }, 404)
    }
    return originalFetch(input, init)
  }

  return () => {
    globalThis.fetch = originalFetch
  }
}

function jsonFixture(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
