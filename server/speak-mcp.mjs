import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import {
  buildSpeakAgentContract,
  buildSpeakUiAdapterKit,
} from './agent-contract.mjs'

const restMethods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

export async function handleSpeakMcpRequest(request, response, options = {}) {
  setMcpCorsHeaders(response)

  const server = createSpeakMcpServer(options)
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })

  response.on('close', () => {
    void transport.close()
    void server.close()
  })

  try {
    await server.connect(transport)
    await transport.handleRequest(request, response, request.body)
  } catch (error) {
    console.error(
      `Speak MCP request failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    if (!response.headersSent) {
      response.status(500).json({ error: 'Speak MCP request failed' })
    }
  }
}

export function handleSpeakMcpOptions(_request, response) {
  setMcpCorsHeaders(response)
  response.status(204).end()
}

export function speakWidgetDocument(options = {}) {
  const contract = buildSpeakAgentContract(options)
  return speakWidgetHtml({
    contract,
    resource: contract.chatgptApp.resources[0],
  })
}

export function createSpeakMcpServer({
  apiRoot = 'http://127.0.0.1:8787/api',
  basePath = '',
  publicBaseUrl = '',
} = {}) {
  const contract = buildSpeakAgentContract({ basePath, publicBaseUrl })
  const server = new McpServer(
    {
      name: 'Speak',
      version: contract.contractVersion,
    },
    {
      instructions: [
        'Speak controls a live voice-agent operations workspace. Read health and workspace before mutating state.',
        'Live calls, deletes, and external delivery require explicit current-user authorization.',
        'Speak profile sync is a proof-gated configuration write and should proceed when the user asks to create or update profiles.',
        'Never claim calls, SMS, email, profile sync, hangup, or delivery succeeded without backend proof.',
        'After live-call mutations, read communication threads, call events, or recent-call compatibility proof before summarizing.',
      ].join(' '),
    },
  )

  registerSearchTools(server, contract, apiRoot)
  registerSpeakWidgetResources(server, contract)
  registerSpeakRenderTools(server, contract, apiRoot)
  contract.backend.actions
    .filter((action) => action.callableByMcp && restMethods.has(action.method))
    .forEach((action) => {
      registerContractActionTool(server, action, apiRoot)
    })

  return server
}

export async function renderSpeakUiSnapshot({
  apiRoot = 'http://127.0.0.1:8787/api',
  basePath = '',
  publicBaseUrl = '',
  surface = 'dialer',
  limit = 12,
  authorizationMode,
  providerOptionsTimeoutMs = 2_000,
} = {}) {
  const contract = buildSpeakAgentContract({ basePath, publicBaseUrl })
  const renderTool =
    contract.chatgptApp.renderTools.find((tool) => tool.surface === surface) ||
    contract.chatgptApp.renderTools[0]
  const result = await renderSpeakWidgetTool(contract, renderTool, apiRoot, {
    limit,
    authorizationMode,
    providerOptionsTimeoutMs,
  })
  const kit = buildSpeakUiAdapterKit({ basePath, publicBaseUrl })
  const surfaceKit = kit.surfaces.find((item) => item.surface === renderTool.surface)

  return buildUiRuntimeSnapshot({
    contract,
    kit,
    surfaceKit,
    renderTool,
    renderResult: result,
    limit,
  })
}

function registerSpeakWidgetResources(server, contract) {
  contract.chatgptApp.resources.forEach((resource) => {
    server.registerResource(
      resource.id,
      resource.uri,
      {
        title: resource.title,
        description: resource.description,
        mimeType: resource.mimeType,
        _meta: resource._meta,
      },
      async () => ({
        contents: [
          {
            uri: resource.uri,
            mimeType: resource.mimeType,
            text: speakWidgetHtml({ contract, resource }),
          },
        ],
      }),
    )
  })
}

function registerSpeakRenderTools(server, contract, apiRoot) {
  contract.chatgptApp.renderTools.forEach((renderTool) => {
    server.registerTool(
      renderTool.id,
      {
        title: renderTool.title,
        description: renderTool.description,
        inputSchema: {
          limit: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .describe('Maximum contacts, communication threads, or recent calls to hydrate into the widget.'),
          authorizationMode: z
            .enum(
              contract.mcpGeneration.authorizationMode.modes.map((mode) => mode.id),
            )
            .optional()
            .describe('Widget default approval policy for high-risk actions.'),
        },
        outputSchema: {
          surface: z.enum(['library', 'dialer', 'configs']),
          stateVersion: z.number(),
          generatedAt: z.string(),
          health: z.unknown().optional(),
          library: z.unknown().optional(),
          queue: z.unknown().optional(),
          profiles: z.unknown().optional(),
          communicationThreads: z.unknown().optional(),
          recentCalls: z.unknown().optional(),
          authorizationMode: z.string(),
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
          idempotentHint: true,
        },
        _meta: {
          ...renderTool._meta,
          'openai/toolInvocation/invoking': 'Opening Speak',
          'openai/toolInvocation/invoked': 'Opened Speak',
        },
      },
      async (args) => renderSpeakWidgetTool(contract, renderTool, apiRoot, args),
    )
  })
}

async function renderSpeakWidgetTool(contract, renderTool, apiRoot, args = {}) {
  const limit = boundedSnapshotLimit(args.limit)
  const authorizationMode = args.authorizationMode || contract.mcpGeneration.authorizationMode.default
  const [health, workspace, communicationThreads, recentCalls, speakOptions] = await Promise.all([
    apiJson(apiRoot, '/health').catch((error) => ({ ok: false, error: error.message })),
    apiJson(apiRoot, '/workspace').catch((error) => ({ error: error.message })),
    apiJson(apiRoot, `/communication-threads?limit=${encodeURIComponent(String(limit))}`).catch(
      (error) => ({ threads: [], error: error.message }),
    ),
    apiJson(apiRoot, `/calls/recent?limit=${encodeURIComponent(String(limit))}`).catch(
      (error) => ({ calls: [], error: error.message }),
    ),
    renderTool.surface === 'configs'
      ? apiJson(apiRoot, '/agent-configs/speak-options', {
          timeoutMs: boundedSnapshotSourceTimeout(args.providerOptionsTimeoutMs),
        }).catch((error) => ({
          error: error.message,
        }))
      : Promise.resolve(null),
  ])

  const leads = Array.isArray(workspace?.leads) ? workspace.leads : []
  const profiles = Array.isArray(workspace?.profiles) ? workspace.profiles : []
  const smartViews = Array.isArray(workspace?.smartViews) ? workspace.smartViews : []
  const threads = Array.isArray(communicationThreads?.threads)
    ? communicationThreads.threads
    : []
  const calls = Array.isArray(recentCalls?.calls) ? recentCalls.calls : []
  const activeProfile = profiles.find((profile) => profile.id === workspace?.activeProfileId)

  const structuredContent = brandForAgent({
    surface: renderTool.surface,
    stateVersion: Date.now(),
    generatedAt: new Date().toISOString(),
    authorizationMode,
    health: summarizeHealth(health),
    library: {
      leadCount: leads.length,
      smartViewCount: smartViews.length,
      profileCount: profiles.length,
      communicationThreadCount: threads.length,
      recentCallCount: calls.length,
      smartViews: smartViews.slice(0, limit).map((view) => ({
        id: view.id || '',
        name: view.name || '',
        leadCount: Array.isArray(view.leadIds) ? view.leadIds.length : 0,
        updatedAt: view.updatedAt || '',
      })),
    },
    queue: {
      total: leads.length,
      ready: leads.filter((lead) => normalizeSearchText(lead.status || 'Ready') === 'ready')
        .length,
      leads: leads.slice(0, limit).map(summarizeLead),
    },
    profiles: {
      total: profiles.length,
      activeProfileId: workspace?.activeProfileId || '',
      activeProfileName: activeProfile?.name || '',
      items: profiles.slice(0, limit).map((profile) => ({
        ...summarizeProfile(profile),
        active: profile.id === workspace?.activeProfileId,
      })),
      optionsAvailable: Boolean(speakOptions && !speakOptions.error),
    },
    communicationThreads: {
      total: threads.length,
      items: threads.slice(0, limit).map(summarizeCommunicationThread),
    },
    recentCalls: {
      total: calls.length,
      items: calls.slice(0, limit).map(summarizeCall),
    },
  })

  return {
    structuredContent,
    content: [
      {
        type: 'text',
        text:
          renderTool.surface === 'library'
            ? `Rendered Speak library widget for ${structuredContent.queue.total} contacts.`
            : renderTool.surface === 'configs'
              ? `Rendered Speak Playground widget for ${structuredContent.profiles.total} profiles.`
              : `Rendered Speak dialer widget for ${structuredContent.queue.total} contacts.`,
      },
    ],
    _meta: {
      ui: { resourceUri: renderTool.resourceUri },
      'openai/outputTemplate': renderTool.resourceUri,
      app: {
        canonicalUrl: renderTool.canonicalUrl,
        authorizationModes: contract.mcpGeneration.authorizationMode,
        actionMap: contract.frontend.uiActions,
      },
      hydration: buildBoundedWidgetHydration({
        workspace,
        communicationThreads,
        recentCalls,
        speakOptions,
        limit,
      }),
    },
  }
}

function boundedSnapshotLimit(value, fallback = 12) {
  const parsed = Number(value || fallback)
  return Number.isFinite(parsed)
    ? Math.min(50, Math.max(1, Math.floor(parsed)))
    : fallback
}

function boundedSnapshotSourceTimeout(value, fallback = 2_000) {
  const parsed = Number(value ?? fallback)
  return Number.isFinite(parsed)
    ? Math.min(10_000, Math.max(10, Math.floor(parsed)))
    : fallback
}

function buildBoundedWidgetHydration({
  workspace = {},
  communicationThreads = {},
  recentCalls = {},
  speakOptions = null,
  limit = 12,
} = {}) {
  return brandForAgent({
    workspace: summarizeWorkspaceHydration(workspace, limit),
    communicationThreads: summarizeCommunicationThreadsHydration(communicationThreads, limit),
    recentCalls: summarizeRecentCallsHydration(recentCalls, limit),
    speakOptions: summarizeSpeakOptionsHydration(speakOptions),
  })
}

function summarizeWorkspaceHydration(workspace = {}, limit = 12) {
  if (workspace?.error) return { error: workspace.error }
  const leads = Array.isArray(workspace?.leads) ? workspace.leads : []
  const profiles = Array.isArray(workspace?.profiles) ? workspace.profiles : []
  const smartViews = Array.isArray(workspace?.smartViews) ? workspace.smartViews : []
  return {
    version: workspace.version || 0,
    updatedAt: workspace.updatedAt || '',
    activeProfileId: workspace.activeProfileId || '',
    leadCount: leads.length,
    profileCount: profiles.length,
    smartViewCount: smartViews.length,
    leads: leads.slice(0, limit).map(summarizeLead),
    profiles: profiles.slice(0, limit).map(summarizeProfile),
    smartViews: smartViews.slice(0, limit).map((view) => ({
      id: view.id || '',
      name: view.name || '',
      leadCount: Array.isArray(view.leadIds) ? view.leadIds.length : 0,
      updatedAt: view.updatedAt || '',
    })),
  }
}

function summarizeCommunicationThreadsHydration(payload = {}, limit = 12) {
  if (payload?.error) return { error: payload.error, threads: [] }
  const threads = Array.isArray(payload?.threads) ? payload.threads : []
  return {
    schemaVersion: payload.schemaVersion || '',
    total: threads.length,
    threads: threads.slice(0, limit).map(summarizeCommunicationThread),
  }
}

function summarizeRecentCallsHydration(payload = {}, limit = 12) {
  if (payload?.error) return { error: payload.error, calls: [] }
  const calls = Array.isArray(payload?.calls) ? payload.calls : []
  return {
    total: calls.length,
    calls: calls.slice(0, limit).map(summarizeCall),
  }
}

function summarizeSpeakOptionsHydration(payload = null) {
  if (!payload) return null
  if (payload.error) return { error: payload.error }
  return {
    eviVersions: Array.isArray(payload.eviVersions) ? payload.eviVersions.length : 0,
    codexAuthModels: Array.isArray(payload.codexAuthModels) ? payload.codexAuthModels.length : 0,
    languageModels: Array.isArray(payload.languageModels) ? payload.languageModels.length : 0,
    voices: Array.isArray(payload.voices) ? payload.voices.length : 0,
    functionTools: Array.isArray(payload.functionTools) ? payload.functionTools.length : 0,
  }
}

function buildUiRuntimeSnapshot({
  contract,
  kit,
  surfaceKit,
  renderTool,
  renderResult,
  limit,
}) {
  const structuredContent = renderResult.structuredContent || {}
  const meta = renderResult._meta || {}
  const authorizationMode =
    structuredContent.authorizationMode || contract.mcpGeneration.authorizationMode.default
  const runId = `${renderTool.id}-${structuredContent.stateVersion || Date.now()}`
  const toolCallId = `${renderTool.id}-call`

  return {
    schemaVersion: 'speak.ui-runtime-snapshot.v1',
    contractVersion: contract.contractVersion,
    generatedAt: structuredContent.generatedAt || new Date().toISOString(),
    surface: renderTool.surface,
    renderTool: renderTool.id,
    resourceUri: renderTool.resourceUri,
    canonicalUrl: renderTool.canonicalUrl,
    authorizationMode,
    structuredContent,
    _meta: meta,
    content: renderResult.content || [],
    adapterKit: contract.agentAdapters.uiAdapterKit,
    genericHost: {
      hydrateMessage: {
        type: 'speak:hydrate',
        source: 'host',
        schemaVersion: contract.generativeUi.genericHostBridge.schemaVersion,
        detail: {
          structuredContent,
          _meta: meta,
          authorizationMode,
        },
      },
      requestStateMessage: surfaceKit?.genericHost?.requestStateMessage || {
        type: 'speak:request-state',
        source: 'host',
        schemaVersion: contract.generativeUi.genericHostBridge.schemaVersion,
      },
      expectedOutbound: surfaceKit?.genericHost?.expectedOutbound || [],
    },
    agUi: {
      events: materializeAgUiEvents({
        surfaceKit,
        renderTool,
        structuredContent,
        meta,
        limit,
        authorizationMode,
        runId,
        toolCallId,
      }),
      liveUpdateRule: surfaceKit?.agUi?.liveUpdateRule || '',
    },
    a2ui: {
      messages: materializeA2uiMessages(surfaceKit, structuredContent),
      actionReturnChannel: surfaceKit?.a2ui?.actionReturnChannel || '',
    },
    aiSdk: {
      componentId: surfaceKit?.aiSdk?.componentId || '',
      renderTool: renderTool.id,
      props: structuredContent,
      meta,
      toolResultPart: {
        ...(surfaceKit?.aiSdk?.toolResultPart || {}),
        output: structuredContent,
      },
    },
    mcpUi: {
      resourceUri: renderTool.resourceUri,
      widgetHtml: contract.agentAdapters.widgetHtml,
      bridgeSchema: contract.generativeUi.genericHostBridge.schemaVersion,
      hydrateMessageType: 'speak:hydrate',
    },
    jsonRender: {
      component: 'SpeakSurface',
      componentId: surfaceKit?.aiSdk?.componentId || '',
      props: structuredContent,
      meta,
    },
    copilotKit: {
      componentName: surfaceKit?.aiSdk?.componentId || '',
      renderTool: renderTool.id,
      props: structuredContent,
      meta,
      actionInvocation: contract.actionInvocation.endpoint,
    },
    safety: contract.safety,
    validation: {
      localCommand: 'npm run qa:ui-snapshot',
    },
    kit,
  }
}

function materializeAgUiEvents({
  surfaceKit,
  renderTool,
  structuredContent,
  meta,
  limit,
  authorizationMode,
  runId,
  toolCallId,
}) {
  const template = surfaceKit?.agUi?.eventSequence || []
  return template.map((event) => {
    if (event.type === 'RunStarted') {
      return { ...event, runId, input: { renderTool: renderTool.id, limit, authorizationMode } }
    }
    if (event.type === 'ToolCallStart') {
      return { ...event, toolCallId, toolCallName: renderTool.id }
    }
    if (event.type === 'ToolCallArgs') {
      return { ...event, toolCallId, delta: JSON.stringify({ limit, authorizationMode }) }
    }
    if (event.type === 'ToolCallEnd') {
      return { ...event, toolCallId }
    }
    if (event.type === 'ToolCallResult') {
      return {
        ...event,
        toolCallId,
        content: JSON.stringify(structuredContent),
        rawEvent: { _meta: meta },
      }
    }
    if (event.type === 'StateSnapshot') {
      return { ...event, snapshot: structuredContent }
    }
    if (event.type === 'RunFinished') {
      return { ...event, result: structuredContent }
    }
    return event
  })
}

function materializeA2uiMessages(surfaceKit, structuredContent) {
  return (surfaceKit?.a2ui?.messages || []).map((message) => {
    if (message.type === 'updateDataModel') {
      return { ...message, value: structuredContent }
    }
    return message
  })
}

function speakWidgetHtml({ contract, resource }) {
  const config = safeScriptJson({
    appName: contract.product.name,
    productionUrl: contract.product.productionUrl,
    productionLibraryUrl: contract.frontend.routes.find((route) => route.id === 'library')?.url || contract.product.productionUrl,
    productionPlaygroundUrl: contract.product.productionPlaygroundUrl || contract.product.productionConfigUrl,
    productionConfigUrl: contract.product.productionConfigUrl,
    resourceUri: resource.uri,
    authorizationModes: contract.mcpGeneration.authorizationMode,
    renderTools: contract.chatgptApp.renderTools.map((tool) => ({
      id: tool.id,
      title: tool.title,
      surface: tool.surface,
      canonicalUrl: tool.canonicalUrl,
    })),
  })

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Speak</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #151517;
      --surface: #1d1d20;
      --surface-raised: #232327;
      --surface-subtle: #19191c;
      --surface-muted: #222226;
      --surface-hover: #2a2a2f;
      --surface-selected: #2b2e34;
      --surface-active: #25262b;
      --text: #d6d6dc;
      --text-strong: #f3f3f5;
      --muted: #9a9aa2;
      --border: #333337;
      --border-strong: #49494f;
      --divider-soft: #2c2c31;
      --accent: #f3f3f5;
      --accent-hover: #ffffff;
      --accent-strong: #ffffff;
      --accent-contrast: #111315;
      --accent-soft: #2c2d32;
      --accent-border: #4b4d55;
      --focus-border: #777b88;
      --success: #8ed39a;
      --success-surface: #1e2c22;
      --success-border: #365b40;
      --danger: #f0aaa5;
      --danger-surface: #34201f;
      --danger-border: #69423f;
      --warning: #e3c784;
      --warning-surface: #332a19;
      --warning-border: #625335;
      --control: 38px;
      font-family: "Helvetica Neue", -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", Inter, ui-sans-serif, system-ui, "Segoe UI", sans-serif;
    }
    :root[data-theme="light"] {
      color-scheme: light;
      --bg: #f4f4f2;
      --surface: #ffffff;
      --surface-raised: #ffffff;
      --surface-subtle: #fafafa;
      --surface-muted: #f3f3f1;
      --surface-hover: #ededeb;
      --surface-selected: #eceff3;
      --surface-active: #f6f7f8;
      --text: #303236;
      --text-strong: #111315;
      --muted: #70737a;
      --border: #ddddda;
      --border-strong: #c8c8c4;
      --divider-soft: #ececea;
      --accent: #1d1d20;
      --accent-hover: #000000;
      --accent-strong: #111315;
      --accent-contrast: #ffffff;
      --accent-soft: #eceff3;
      --accent-border: #cfd3dc;
      --focus-border: #8c98ad;
      --success: #2f6b3f;
      --success-surface: #edf6ef;
      --success-border: #c9e3cf;
      --danger: #b0443e;
      --danger-surface: #f9eeee;
      --danger-border: #e7c7c5;
      --warning: #7a5a1e;
      --warning-surface: #f8f3e7;
      --warning-border: #e2d4b3;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-size: 14px;
      letter-spacing: 0;
    }
    button, select, input {
      min-width: 0;
      min-height: var(--control);
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface);
      color: var(--text-strong);
      font: inherit;
    }
    button {
      padding: 0 12px;
      font-weight: 530;
      cursor: pointer;
    }
    button:hover, input:focus, select:focus {
      border-color: var(--border-strong);
      outline: 0;
    }
    button.icon {
      width: 38px;
      padding: 0;
      display: inline-grid;
      place-items: center;
      font-size: 15px;
    }
    button.primary {
      background: var(--accent);
      color: var(--accent-contrast);
      border-color: var(--accent);
    }
    button.subtle {
      background: var(--surface-muted);
    }
    button.danger {
      border-color: var(--danger-border);
      background: var(--danger-surface);
      color: var(--danger);
    }
    select, input { padding: 0 10px; width: 100%; }
    .shell {
      width: 100%;
      max-width: 100vw;
      min-height: 100vh;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      grid-template-rows: auto auto 1fr auto;
      overflow-x: hidden;
      background: var(--bg);
    }
    .command, .searchbar, .footer {
      grid-column: 1 / -1;
      min-width: 0;
      width: 100%;
      max-width: 100vw;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      background: var(--surface-muted);
    }
    .command { justify-content: space-between; }
    .routes, .utilities, .compact-actions { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .routes { flex: 1; }
    .route {
      min-width: 88px;
      background: transparent;
      border-color: transparent;
      color: var(--muted);
    }
    .route[aria-pressed="true"] {
      background: var(--surface-selected);
      border-color: var(--accent-border);
      color: var(--accent-strong);
    }
    .searchbar { display: none; background: var(--surface); }
    .searchbar[data-open="true"] { display: flex; }
    .footer {
      grid-column: 1 / -1;
      border-top: 1px solid var(--border);
      border-bottom: 0;
      color: var(--muted);
      font-size: 12px;
    }
    .context {
      grid-column: 1 / -1;
      min-width: 0;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      padding: 12px;
      border-bottom: 1px solid var(--border);
      background: var(--surface);
    }
    .context-main {
      min-width: 0;
      display: grid;
      gap: 6px;
    }
    .context-title {
      min-width: 0;
      font-size: 16px;
      line-height: 1.2;
      font-weight: 540;
      color: var(--text-strong);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .context-meta {
      display: flex;
      gap: 6px;
      min-width: 0;
      flex-wrap: wrap;
    }
    .primary-actions {
      min-width: 168px;
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
    }
    .content {
      grid-column: 1 / -1;
      min-width: 0;
      width: 100%;
      max-width: 100vw;
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(260px, 0.72fr);
      min-height: 0;
    }
    .pane {
      min-width: 0;
      border-right: 1px solid var(--border);
      overflow: auto;
      background: var(--surface);
    }
    .pane:last-child { border-right: 0; background: var(--surface-subtle); }
    .section {
      padding: 12px;
      border-bottom: 1px solid var(--border);
    }
    .section h2 {
      margin: 0 0 10px;
      font-size: 13px;
      color: var(--muted);
      font-weight: 560;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 8px;
    }
    .section-header h2 { margin: 0; }
    .item {
      display: grid;
      gap: 5px;
      padding: 10px 0;
      border-top: 1px solid var(--divider-soft);
    }
    .item[data-select-lead], .item[data-select-profile] { cursor: pointer; }
    .item:first-of-type { border-top: 0; }
    .item[data-selected="true"] {
      margin: 0 -6px;
      padding: 10px 6px;
      border-radius: 8px;
      background: var(--surface-selected);
    }
    .row {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
      min-width: 0;
    }
    .row > * { min-width: 0; }
    .main { color: var(--text-strong); font-weight: 520; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sub { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pill {
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 4px 8px;
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .pill.ready {
      border-color: var(--success-border);
      background: var(--success-surface);
      color: var(--success);
    }
    .pill.warn {
      border-color: var(--warning-border);
      background: var(--warning-surface);
      color: var(--warning);
    }
    .empty { color: var(--muted); padding: 18px 0; text-align: center; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
    .notice { color: var(--muted); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .transcript {
      display: grid;
      gap: 10px;
      min-height: 360px;
      align-content: start;
    }
    .turn {
      max-width: 88%;
      padding: 10px 11px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface);
    }
    .turn.user {
      margin-left: auto;
      background: var(--accent);
      color: var(--accent-contrast);
      border-color: var(--accent);
    }
    .turn .label {
      font-size: 12px;
      color: var(--muted);
      margin-bottom: 3px;
    }
    .turn.user .label { color: color-mix(in srgb, var(--accent-contrast) 70%, transparent); }
    .settings {
      position: fixed;
      inset: 0 0 0 auto;
      width: min(360px, 100vw);
      background: var(--surface-raised);
      border-left: 1px solid var(--border-strong);
      transform: translateX(100%);
      transition: transform 160ms ease;
      z-index: 10;
      display: grid;
      grid-template-rows: auto 1fr;
      box-shadow: 0 14px 32px color-mix(in srgb, #000000 22%, transparent);
    }
    .settings[data-open="true"] { transform: translateX(0); }
    .settings-head {
      min-width: 0;
      padding: 12px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .settings-body { padding: 12px; display: grid; gap: 12px; align-content: start; overflow: auto; }
    .field { display: grid; gap: 6px; }
    .field label { color: var(--muted); font-size: 12px; font-weight: 540; }
    .metric-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
    }
    .metric {
      min-width: 0;
      padding: 9px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface-muted);
    }
    .metric strong { display: block; color: var(--text-strong); font-size: 16px; }
    .metric span { display: block; color: var(--muted); font-size: 12px; margin-top: 2px; }
    [hidden] { display: none !important; }
    @media (max-width: 720px) {
      :root { --control: 42px; }
      .command { align-items: flex-start; gap: 4px; padding: 8px; }
      .routes { gap: 4px; overflow-x: visible; }
      .route { min-width: auto; padding: 0 9px; }
      button.icon { width: 38px; }
      .utilities { gap: 4px; }
      .utilities { flex: 0 0 auto; }
      .context { grid-template-columns: 1fr; padding: 10px; }
      .primary-actions { min-width: 0; justify-content: stretch; }
      .primary-actions button { flex: 1; }
      .content { grid-template-columns: 1fr; }
      .pane { border-right: 0; border-bottom: 1px solid var(--border); max-height: none; }
      .pane:last-child { min-height: 420px; }
      .section { padding: 10px; }
      .metric-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    }
  </style>
</head>
<body>
  <div class="shell">
    <nav class="command" aria-label="Speak widget routes">
      <div class="routes" id="routes"></div>
      <div class="utilities">
        <button id="searchToggle" class="icon" type="button" title="Search" aria-label="Search">⌕</button>
        <button id="themeToggle" class="icon" type="button" title="Appearance" aria-label="Appearance">◐</button>
        <button id="settingsToggle" class="icon" type="button" title="Settings" aria-label="Settings">⚙</button>
      </div>
    </nav>
    <div class="searchbar" id="searchbar">
      <input id="searchInput" type="search" enterkeyhint="search" placeholder="Search contacts, profiles, threads" aria-label="Search Speak widget data">
    </div>
    <section class="context" id="context"></section>
    <main class="content">
      <section class="pane" id="primary"></section>
      <aside class="pane" id="secondary"></aside>
    </main>
    <aside class="settings" id="settingsPanel" aria-label="Widget settings" aria-hidden="true">
      <div class="settings-head">
        <strong>Settings</strong>
        <button id="settingsClose" class="icon" type="button" title="Close settings" aria-label="Close settings">×</button>
      </div>
      <div class="settings-body">
        <div class="field">
          <label for="authorizationMode">Authorization mode</label>
          <select id="authorizationMode" aria-label="Authorization mode"></select>
        </div>
        <div class="metric-grid">
          <div class="metric"><strong id="metricLeads">0</strong><span>Contacts</span></div>
          <div class="metric"><strong id="metricProfiles">0</strong><span>Agents</span></div>
          <div class="metric"><strong id="metricCalls">0</strong><span>Threads</span></div>
        </div>
        <button id="refresh" class="primary" type="button">Refresh</button>
        <button id="openApp" class="subtle" type="button">Open current surface</button>
      </div>
    </aside>
    <footer class="footer">
      <span class="notice" id="notice">Ready.</span>
    </footer>
  </div>
  <script>
    const speakConfig = ${config};
    const routeLabels = { library: 'Library', dialer: 'Dialer', configs: 'Playground' };
    const state = {
      output: window.openai?.toolOutput || null,
      meta: window.openai?.toolResponseMetadata || {},
      authorizationMode:
        window.openai?.widgetState?.authorizationMode ||
        speakConfig.authorizationModes.default ||
        'confirm_each',
      surface: window.openai?.widgetState?.surface || window.openai?.toolOutput?.surface || 'dialer',
      selectedLeadId: window.openai?.widgetState?.selectedLeadId || '',
      selectedProfileId: window.openai?.widgetState?.selectedProfileId || '',
      query: '',
      theme: window.openai?.widgetState?.theme || 'dark',
      settingsOpen: false
    };

    const $ = (id) => document.getElementById(id);

    function setNotice(text) {
      $('notice').textContent = text;
      if (window.openai?.notifyIntrinsicHeight) {
        window.openai.notifyIntrinsicHeight(document.body.scrollHeight);
      }
    }

    function escapeText(value) {
      return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      })[char]);
    }

    function currentSurface() {
      return state.surface || state.output?.surface || 'dialer';
    }

    function toolsBySurface(surface) {
      return speakConfig.renderTools.reduce((acc, tool) => {
        acc[tool.surface] = tool;
        return acc;
      }, {})[surface] || speakConfig.renderTools[0];
    }

    function saveWidgetState(extra = {}) {
      if (window.openai?.setWidgetState) {
        window.openai.setWidgetState({
          authorizationMode: state.authorizationMode,
          surface: currentSurface(),
          selectedLeadId: state.selectedLeadId,
          selectedProfileId: state.selectedProfileId,
          theme: state.theme,
          ...extra
        });
      }
    }

    function postBridge(method, params) {
      window.parent?.postMessage({
        jsonrpc: '2.0',
        id: Date.now(),
        method,
        params
      }, '*');
    }

    function postGeneric(type, detail = {}) {
      window.parent?.postMessage({
        type,
        source: 'speak-widget',
        schemaVersion: 'speak.widget-postmessage.v1',
        detail
      }, '*');
    }

    function widgetSnapshot() {
      return {
        surface: currentSurface(),
        authorizationMode: state.authorizationMode,
        selectedLeadId: state.selectedLeadId,
        selectedProfileId: state.selectedProfileId,
        output: state.output,
        meta: state.meta
      };
    }

    function announceState(type = 'speak:state') {
      postGeneric(type, widgetSnapshot());
    }

    function hydrateFromPayload(payload = {}) {
      const structuredContent =
        payload.structuredContent ||
        payload.toolOutput ||
        payload.output ||
        payload.result?.structuredContent ||
        payload.result?.content?.structuredContent;
      if (structuredContent) state.output = structuredContent;
      state.meta =
        payload._meta ||
        payload.toolResponseMetadata ||
        payload.meta ||
        payload.result?._meta ||
        state.meta;
      if (structuredContent?.surface) state.surface = structuredContent.surface;
      if (payload.authorizationMode) persistMode(payload.authorizationMode);
      render();
      announceState();
    }

    async function callTool(name, args = {}) {
      const payload = { ...args };
      if (!payload.authorizationMode) payload.authorizationMode = state.authorizationMode;
      try {
        if (window.openai?.callTool) {
          const result = await window.openai.callTool(name, payload);
          setNotice(name + ' returned.');
          return result;
        }
        postBridge('tools/call', { name, arguments: payload });
        postGeneric('speak:tool-call', { name, arguments: payload });
        setNotice(name + ' requested through MCP Apps bridge.');
        return null;
      } catch (error) {
        setNotice(name + ' failed: ' + (error?.message || error));
        return null;
      }
    }

    function followUp(prompt) {
      const body = prompt + '\\n\\nUse authorizationMode: "' + state.authorizationMode + '". Preserve Speak proof requirements.';
      if (window.openai?.sendFollowUpMessage) {
        window.openai.sendFollowUpMessage({ prompt: body, scrollToBottom: true });
        setNotice('Follow-up intent sent.');
        return;
      }
      postBridge('ui/message', { type: 'text', text: body, prompt: body });
      postGeneric('speak:follow-up', { prompt: body, text: body, authorizationMode: state.authorizationMode });
      setNotice('Follow-up intent sent through bridge.');
    }

    function openExternal(url) {
      if (window.openai?.openExternal) {
        window.openai.openExternal({ href: url, redirectUrl: false });
        return;
      }
      postGeneric('speak:open-external', { href: url });
      window.open(url, '_blank', 'noopener,noreferrer');
    }

    function persistMode(value) {
      state.authorizationMode = value;
      saveWidgetState();
      announceState();
    }

    function setSurface(surface) {
      state.surface = surface;
      if (state.output) state.output.surface = surface;
      saveWidgetState();
      render();
      const tool = toolsBySurface(surface);
      if (tool?.id) callTool(tool.id, { limit: 12 });
    }

    function filtered(items = [], fields = []) {
      const query = normalize(state.query);
      if (!query) return items;
      return items.filter((item) => fields.some((field) => normalize(item[field]).includes(query)));
    }

    function normalize(value) {
      return String(value || '').toLowerCase().trim();
    }

    function surfaceUrl(surface) {
      if (surface === 'library') return speakConfig.productionLibraryUrl;
      if (surface === 'configs') return speakConfig.productionPlaygroundUrl || speakConfig.productionConfigUrl;
      return speakConfig.productionUrl;
    }

    function selectLead(id) {
      state.selectedLeadId = id || '';
      saveWidgetState();
      render();
      announceState();
    }

    function selectProfile(id) {
      state.selectedProfileId = id || '';
      saveWidgetState();
      render();
      announceState();
    }

    function activeLead(queue) {
      const leads = queue?.leads || [];
      return leads.find((lead) => lead.id === state.selectedLeadId) || leads[0] || null;
    }

    function activeProfile(profiles) {
      const items = profiles?.items || [];
      return items.find((profile) => profile.id === state.selectedProfileId) ||
        items.find((profile) => profile.active) ||
        items[0] ||
        null;
    }

    function renderModes() {
      const select = $('authorizationMode');
      select.innerHTML = speakConfig.authorizationModes.modes.map((mode) =>
        '<option value="' + escapeText(mode.id) + '">' + escapeText(mode.id) + '</option>'
      ).join('');
      select.value = state.authorizationMode;
      select.addEventListener('change', () => persistMode(select.value));
    }

    function itemRows(items, empty, renderItem) {
      if (!items || items.length === 0) return '<div class="empty">' + escapeText(empty) + '</div>';
      return items.map(renderItem).join('');
    }

    function renderLead(lead, selected) {
      return '<article class="item" role="button" tabindex="0" data-select-lead="' + escapeText(lead.id || '') + '" data-selected="' + (selected ? 'true' : 'false') + '">' +
        '<div class="row"><span class="main">' + escapeText(lead.company || lead.name || 'Contact') + '</span><span class="pill">' + escapeText(lead.status || 'Ready') + '</span></div>' +
        '<div class="sub">' + escapeText([lead.name, lead.phone].filter(Boolean).join(' / ')) + '</div>' +
        '<div class="actions"><button type="button" data-fetch="lead:' + escapeText(lead.id || '') + '">Details</button></div>' +
      '</article>';
    }

    function renderProfile(profile, selected) {
      return '<article class="item" role="button" tabindex="0" data-select-profile="' + escapeText(profile.id || '') + '" data-selected="' + (selected ? 'true' : 'false') + '">' +
        '<div class="row"><span class="main">' + escapeText(profile.name || 'Profile') + '</span><span class="pill">' + escapeText(profile.active ? 'Active' : 'Saved') + '</span></div>' +
        '<div class="sub">' + escapeText(profile.voice || profile.updatedAt || '') + '</div>' +
        '<div class="actions"><button type="button" data-fetch="profile:' + escapeText(profile.id || '') + '">Details</button></div>' +
      '</article>';
    }

    function renderCall(call) {
      return '<article class="item">' +
        '<div class="row"><span class="main">' + escapeText(call.leadName || call.callControlId || 'Call') + '</span><span class="pill">' + escapeText(call.outcome || call.phase || 'Review') + '</span></div>' +
        '<div class="sub">' + escapeText([call.startedAt, call.duration].filter(Boolean).join(' / ')) + '</div>' +
      '</article>';
    }

    function renderThread(thread) {
      return '<article class="item">' +
        '<div class="row"><span class="main">' + escapeText(thread.contactLabel || thread.threadId || 'Thread') + '</span><span class="pill">' + escapeText(thread.status || 'Open') + '</span></div>' +
        '<div class="sub">' + escapeText([thread.channels, thread.summary || thread.latestMessagePreview].filter(Boolean).join(' / ')) + '</div>' +
      '</article>';
    }

    function renderRoutes() {
      $('routes').innerHTML = ['library', 'dialer', 'configs'].map((surface) =>
        '<button type="button" class="route" data-route="' + surface + '" aria-pressed="' + (currentSurface() === surface ? 'true' : 'false') + '">' + routeLabels[surface] + '</button>'
      ).join('');
      document.querySelectorAll('[data-route]').forEach((button) => {
        button.addEventListener('click', () => setSurface(button.getAttribute('data-route')));
      });
    }

    function renderContext(output, queue, profiles, communicationThreads, recentCalls) {
      const surface = currentSurface();
      const lead = activeLead(queue);
      const profile = activeProfile(profiles);
      const health = output.health || {};
      const title =
        surface === 'library'
          ? 'Contact library'
          : surface === 'configs'
            ? (profile?.name || 'Playground')
            : (lead?.company || lead?.name || 'Dialer queue');
      const subtitle =
        surface === 'library'
          ? (queue.total || 0) + ' contacts / ' + (profiles.total || 0) + ' agents / ' + (communicationThreads.total || 0) + ' threads'
          : surface === 'configs'
            ? [profile?.voice || 'Saved profile', lead?.company || lead?.name || 'No test contact'].filter(Boolean).join(' / ')
            : [lead?.name, lead?.phone, profile?.name || profiles.activeProfileName].filter(Boolean).join(' / ');
      const actionLabel = surface === 'library' ? 'Open' : surface === 'configs' ? 'Start test' : 'Call';
      const actionPrompt =
        surface === 'library'
          ? ''
          : surface === 'configs'
            ? 'Start a Speak browser Playground test for profile ' + (profile?.name || profiles.activeProfileName || 'the selected profile') + ' using contact ' + (lead?.company || lead?.name || 'the selected contact') + '. Preserve backend proof.'
            : 'Start a Speak live call for ' + (lead?.company || lead?.name || 'the selected contact') + ' with agent profile ' + (profile?.name || profiles.activeProfileName || 'the selected profile') + '. Preserve backend proof.';

      $('context').innerHTML =
        '<div class="context-main">' +
          '<div class="context-title" title="' + escapeText(title) + '">' + escapeText(title) + '</div>' +
          '<div class="sub" title="' + escapeText(subtitle) + '">' + escapeText(subtitle || 'No context selected') + '</div>' +
          '<div class="context-meta">' +
            '<span class="pill ' + (health.configured === false ? 'warn' : 'ready') + '">' + escapeText(health.configured === false ? 'Needs config' : 'Ready') + '</span>' +
            '<span class="pill">' + escapeText(state.authorizationMode) + '</span>' +
            '<span class="pill">' + escapeText(routeLabels[surface] || surface) + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="primary-actions">' +
          (surface === 'dialer' && lead?.phone ? '<button type="button" data-device-call="' + escapeText(lead.phone) + '">Device</button>' : '') +
          '<button type="button" class="primary" id="primaryAction">' + escapeText(actionLabel) + '</button>' +
        '</div>';

      $('primaryAction')?.addEventListener('click', () => {
        if (surface === 'library') {
          openExternal(surfaceUrl(surface));
        } else {
          followUp(actionPrompt);
        }
      });
      document.querySelectorAll('[data-device-call]').forEach((button) => {
        button.addEventListener('click', () => openExternal('tel:' + encodeURIComponent(button.getAttribute('data-device-call') || '')));
      });
    }

    function renderHistorySection(communicationThreads, recentCalls, title) {
      const threads = filtered(communicationThreads.items || [], ['contactLabel', 'summary', 'channels', 'status']);
      if (threads.length || communicationThreads.total) {
        return '<div class="section"><div class="section-header"><h2>' + escapeText(title || 'Communication threads') + '</h2><span class="pill">' + escapeText(String(communicationThreads.total || threads.length || 0)) + '</span></div>' +
          itemRows(threads, 'No communication threads loaded.', renderThread) +
        '</div>';
      }
      return '<div class="section"><div class="section-header"><h2>Recent call compatibility</h2><span class="pill">' + escapeText(String(recentCalls.total || 0)) + '</span></div>' +
        itemRows(filtered(recentCalls.items || [], ['leadName', 'outcome', 'phase']), 'No recent calls loaded.', renderCall) +
      '</div>';
    }

    function renderLibrary(queue, profiles, communicationThreads, recentCalls) {
      const leads = filtered(queue.leads || [], ['company', 'name', 'phone', 'email', 'status']);
      const profileItems = filtered(profiles.items || [], ['name', 'voice']);
      $('primary').innerHTML =
        '<div class="section">' +
          '<div class="section-header"><h2>Contacts</h2><span class="pill">' + escapeText(String(queue.total || 0)) + '</span></div>' +
          itemRows(leads, 'No contacts loaded.', (lead) => renderLead(lead, lead.id === state.selectedLeadId)) +
        '</div>';
      $('secondary').innerHTML =
        '<div class="section"><div class="section-header"><h2>Agents</h2><span class="pill">' + escapeText(String(profiles.total || 0)) + '</span></div>' +
          itemRows(profileItems, 'No profiles loaded.', (profile) => renderProfile(profile, profile.id === state.selectedProfileId || profile.active)) +
        '</div>' +
        renderHistorySection(communicationThreads, recentCalls, 'Communication threads');
    }

    function renderDialer(queue, profiles, communicationThreads, recentCalls) {
      const leads = filtered(queue.leads || [], ['company', 'name', 'phone', 'email', 'status']);
      const lead = activeLead(queue);
      const profile = activeProfile(profiles);
      $('primary').innerHTML =
        '<div class="section">' +
          '<div class="section-header"><h2>Queue</h2><span class="pill">' + escapeText((queue.ready || 0) + ' ready') + '</span></div>' +
          itemRows(leads, 'No contacts loaded.', (item) => renderLead(item, item.id === (lead?.id || state.selectedLeadId))) +
        '</div>';
      $('secondary').innerHTML =
        '<div class="section">' +
          '<div class="section-header"><h2>Transcript</h2><span class="pill">' + escapeText(profile?.name || profiles.activeProfileName || 'Agent') + '</span></div>' +
          '<div class="transcript">' +
            '<div class="empty">No live transcript loaded.</div>' +
          '</div>' +
        '</div>' +
        renderHistorySection(communicationThreads, recentCalls, 'Communication threads');
    }

    function renderConfigs(queue, profiles, communicationThreads, recentCalls) {
      const profile = activeProfile(profiles);
      const lead = activeLead(queue);
      $('primary').innerHTML =
        '<div class="section">' +
          '<div class="section-header"><h2>Agent profile</h2><span class="pill">' + escapeText(profiles.activeProfileName || profile?.name || 'Saved') + '</span></div>' +
          itemRows(filtered(profiles.items || [], ['name', 'voice']), 'No profiles loaded.', (item) => renderProfile(item, item.id === (profile?.id || state.selectedProfileId))) +
        '</div>';
      $('secondary').innerHTML =
        '<div class="section">' +
          '<div class="section-header"><h2>Playground</h2><span class="pill">' + escapeText(lead?.company || lead?.name || 'No contact') + '</span></div>' +
          '<div class="transcript">' +
            '<div class="empty">No test transcript loaded.</div>' +
          '</div>' +
          '<div class="actions"><button type="button" data-followup="' + escapeText('Open Speak profile ' + (profile?.name || profiles.activeProfileName || 'the selected profile') + ' in the Playground.') + '">Open Playground</button><button type="button" data-tool="read_speak_options">Settings</button></div>' +
        '</div>' +
        renderHistorySection(communicationThreads, recentCalls, 'Communication threads');
    }

    function render() {
      const output = state.output || {};
      if (output.surface) state.surface = output.surface;
      const queue = output.queue || { leads: [] };
      const profiles = output.profiles || { items: [] };
      const communicationThreads = output.communicationThreads || { items: [] };
      const recentCalls = output.recentCalls || { items: [] };
      document.documentElement.dataset.theme = state.theme;
      renderRoutes();
      renderContext(output, queue, profiles, communicationThreads, recentCalls);
      $('metricLeads').textContent = String(queue.total || 0);
      $('metricProfiles').textContent = String(profiles.total || 0);
      $('metricCalls').textContent = String(communicationThreads.total || recentCalls.total || 0);

      if (currentSurface() === 'library') renderLibrary(queue, profiles, communicationThreads, recentCalls);
      if (currentSurface() === 'dialer') renderDialer(queue, profiles, communicationThreads, recentCalls);
      if (currentSurface() === 'configs') renderConfigs(queue, profiles, communicationThreads, recentCalls);

      document.querySelectorAll('[data-followup]').forEach((button) => {
        button.addEventListener('click', () => followUp(button.getAttribute('data-followup')));
      });
      document.querySelectorAll('[data-fetch]').forEach((button) => {
        button.addEventListener('click', () => callTool('fetch', { id: button.getAttribute('data-fetch') }));
      });
      document.querySelectorAll('[data-tool]').forEach((button) => {
        button.addEventListener('click', () => callTool(button.getAttribute('data-tool'), { limit: 12 }));
      });
      document.querySelectorAll('[data-select-lead]').forEach((button) => {
        button.addEventListener('click', () => selectLead(button.getAttribute('data-select-lead')));
      });
      document.querySelectorAll('[data-select-profile]').forEach((button) => {
        button.addEventListener('click', () => selectProfile(button.getAttribute('data-select-profile')));
      });
    }

    window.addEventListener('message', (event) => {
      if (event.source !== window.parent) return;
      const message = event.data || {};
      if (message.method === 'ui/notifications/tool-result') {
        hydrateFromPayload(message.params || {});
      }
      if (message.method === 'ui/notifications/tool-input') {
        state.input = message.params || {};
      }
      if (message.type === 'speak:hydrate' || message.method === 'speak/hydrate') {
        hydrateFromPayload(message.detail || message.params || message.payload || {});
      }
      if (message.type === 'speak:tool-result' || message.method === 'speak/tool-result') {
        hydrateFromPayload(message.detail || message.params || message.payload || {});
      }
      if (
        message.type === 'speak:set-authorization-mode' ||
        message.method === 'speak/set-authorization-mode'
      ) {
        const value =
          message.detail?.authorizationMode ||
          message.params?.authorizationMode ||
          message.payload?.authorizationMode;
        if (value) persistMode(value);
      }
      if (message.type === 'speak:request-state' || message.method === 'speak/request-state') {
        announceState();
      }
    });

    $('refresh').addEventListener('click', () => {
      const renderTool = toolsBySurface(currentSurface())?.id || 'render_speak_dialer';
      callTool(renderTool, { limit: 12 });
    });
    $('openApp').addEventListener('click', () => openExternal(surfaceUrl(currentSurface())));
    $('searchToggle').addEventListener('click', () => {
      const next = $('searchbar').dataset.open !== 'true';
      $('searchbar').dataset.open = next ? 'true' : 'false';
      if (next) $('searchInput').focus();
    });
    $('searchInput').addEventListener('input', (event) => {
      state.query = event.target.value;
      render();
    });
    $('themeToggle').addEventListener('click', () => {
      state.theme = state.theme === 'dark' ? 'light' : 'dark';
      saveWidgetState();
      render();
    });
    $('settingsToggle').addEventListener('click', () => {
      state.settingsOpen = true;
      $('settingsPanel').dataset.open = 'true';
      $('settingsPanel').setAttribute('aria-hidden', 'false');
    });
    $('settingsClose').addEventListener('click', () => {
      state.settingsOpen = false;
      $('settingsPanel').dataset.open = 'false';
      $('settingsPanel').setAttribute('aria-hidden', 'true');
    });

    renderModes();
    render();
    announceState('speak:ready');
  </script>
</body>
</html>`
}

function safeScriptJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

function summarizeHealth(health) {
  return {
    ok: Boolean(health?.ok),
    configured: Boolean(health?.configured),
    missing: Array.isArray(health?.missing) ? health.missing : [],
    message: health?.message || '',
    delivery: {
      smsConfigured: Boolean(health?.delivery?.smsConfigured),
      emailConfigured: Boolean(health?.delivery?.emailConfigured),
      emailFromConfigured: Boolean(health?.delivery?.emailFromConfigured),
      emailReadAuthAccountConfigured: Boolean(
        health?.delivery?.emailReadAuthAccountConfigured,
      ),
      emailSourceReadConfigured: Boolean(health?.delivery?.emailSourceReadConfigured),
      emailSendAuthAccountConfigured: Boolean(
        health?.delivery?.emailSendAuthAccountConfigured,
      ),
      emailSendAsConfigured: Boolean(health?.delivery?.emailSendAsConfigured),
    },
  }
}

function summarizeLead(lead) {
  return {
    id: lead.id || '',
    name: lead.name || [lead.firstName, lead.lastName].filter(Boolean).join(' '),
    company: lead.company || '',
    phone: lead.phone || '',
    email: lead.email || '',
    status: lead.status || 'Ready',
    lastCall: lead.lastCall || '',
  }
}

function summarizeProfile(profile) {
  return {
    id: profile.id || '',
    name: profile.name || '',
    updatedAt: profile.updatedAt || '',
    voice: profile.config?.voice || '',
  }
}

function summarizeCall(call) {
  return {
    callControlId: call.callControlId || '',
    leadName: callLeadName(call),
    startedAt: call.startedAt || call.createdAt || '',
    duration: call.duration || call.calltime || '',
    outcome: call.outcome || '',
    phase: call.phase || '',
  }
}

function callLeadName(call) {
  return (
    call.lead?.name ||
    call.lead?.business_name ||
    [call.lead?.first_name, call.lead?.last_name].filter(Boolean).join(' ') ||
    call.leadName ||
    call.name ||
    ''
  )
}

function summarizeCommunicationThread(thread) {
  const contactLabel =
    thread.participants?.find?.((participant) => participant.role === 'contact')?.label ||
    thread.contactId ||
    thread.threadId ||
    ''
  return {
    threadId: thread.threadId || '',
    contactId: thread.contactId || '',
    contactLabel,
    status: thread.status || '',
    channels: Array.isArray(thread.channels) ? thread.channels.join(', ') : '',
    summary: thread.summary || '',
    latestMessagePreview: thread.latestMessagePreview || '',
    updatedAt: thread.updatedAt || '',
  }
}

function productionLibraryUrl(contract) {
  return (
    contract.frontend?.routes?.find?.((route) => route.id === 'library')?.url ||
    contract.product?.productionUrl ||
    ''
  )
}

function registerSearchTools(server, contract, apiRoot) {
  server.registerTool(
    'search',
    {
      title: 'Search Speak',
      description:
        'Use this when you need to find relevant Speak actions, contacts, profiles, communication threads, or recent calls before choosing a more specific tool.',
      inputSchema: {
        query: z.string().min(1).describe('Search text, such as a contact name, thread summary, tool name, profile name, call id, or workflow.'),
      },
      outputSchema: {
        results: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            url: z.string(),
          }),
        ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
    },
    async ({ query }) => {
      const structuredContent = {
        results: await searchSpeak(contract, apiRoot, query),
      }
      return jsonToolResult(structuredContent, `Found ${structuredContent.results.length} Speak results.`)
    },
  )

  server.registerTool(
    'fetch',
    {
      title: 'Fetch Speak item',
      description:
        'Use this when you need the full text for a Speak search result by id.',
      inputSchema: {
        id: z.string().min(1).describe('Result id returned by search, such as action:list_leads, lead:abc, thread:thread-contact-abc, or call:call-control-id.'),
      },
      outputSchema: {
        id: z.string(),
        title: z.string(),
        text: z.string(),
        url: z.string(),
        metadata: z.record(z.string(), z.string()).optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
    },
    async ({ id }) => {
      const structuredContent = await fetchSpeakItem(contract, apiRoot, id)
      return jsonToolResult(structuredContent, structuredContent.title)
    },
  )
}

function registerContractActionTool(server, action, apiRoot) {
  server.registerTool(
    action.id,
    {
      title: action.title,
      description: actionDescription(action),
      inputSchema: actionInputShape(action),
      outputSchema: {
        ok: z.boolean(),
        status: z.number(),
        result: z.unknown().optional(),
        error: z.string().optional(),
      },
      annotations: actionAnnotations(action),
      _meta: {
        'openai/toolInvocation/invoking': actionInvocationText(action, 'Running'),
        'openai/toolInvocation/invoked': actionInvocationText(action, 'Done'),
      },
    },
    async (args) => invokeContractAction(action, apiRoot, args),
  )
}

async function invokeContractAction(action, apiRoot, args = {}) {
  const url = actionUrl(action, apiRoot, args)
  const init = {
    method: action.method,
    headers: { Accept: 'application/json' },
  }

  if (!['GET', 'DELETE'].includes(action.method)) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(requestBodyFromArgs(action, args))
  }

  const response = await fetch(url, init)
  const result = brandForAgent(await readResponsePayload(response))
  const structuredContent = {
    ok: response.ok,
    status: response.status,
    result: response.ok ? result : undefined,
    error: response.ok ? undefined : result?.error || response.statusText,
  }

  return {
    structuredContent,
    content: [
      {
        type: 'text',
        text: response.ok
          ? JSON.stringify(result)
          : `Speak ${action.id} failed: ${structuredContent.error}`,
      },
    ],
    isError: !response.ok,
  }
}

function actionUrl(action, apiRoot, args) {
  const apiPath = action.path
    .replace(/^\/api/, '')
    .replace(/\{([^}]+)\}/g, (_match, key) => encodeURIComponent(String(args[key] || '')))
  const url = new URL(`${apiRoot.replace(/\/+$/g, '')}${apiPath}`)
  Object.keys(action.querySchema?.properties || {}).forEach((key) => {
    if (args[key] !== undefined && args[key] !== null && args[key] !== '') {
      url.searchParams.set(key, String(args[key]))
    }
  })
  return url
}

function requestBodyFromArgs(action, args) {
  const properties = action.requestSchema?.properties || {}
  return Object.fromEntries(
    Object.keys(properties)
      .filter((key) => args[key] !== undefined)
      .map((key) => [key, args[key]]),
  )
}

async function readResponsePayload(response) {
  const text = await response.text()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return { text }
  }
}

function actionInputShape(action) {
  const fields = new Map()
  const addFields = (schema, { requiredAll = false } = {}) => {
    const required = new Set(schema?.required || [])
    Object.entries(schema?.properties || {}).forEach(([key, propertySchema]) => {
      const current = fields.get(key)
      fields.set(key, {
        schema: propertySchema,
        required: Boolean(current?.required || requiredAll || required.has(key)),
      })
    })
  }

  addFields(action.pathSchema, { requiredAll: true })
  addFields(action.querySchema)
  addFields(action.requestSchema)

  if (actionSupportsAuthorizationMode(action)) {
    fields.set('authorizationMode', {
      schema: {
        type: 'string',
        enum: [
          'confirm_each',
          'session_preauthorized',
          'no_permission_needed',
          'yolo',
          'dangerously_approve_everything',
        ],
        description:
          'Approval policy for this high-risk action. This does not waive backend proof requirements.',
      },
      required: false,
    })
  }

  return Object.fromEntries(
    Array.from(fields.entries()).map(([key, field]) => {
      const zodSchema = zodFromJsonSchema(field.schema)
      return [key, field.required ? zodSchema : zodSchema.optional()]
    }),
  )
}

function zodFromJsonSchema(schema = {}) {
  if (schema.enum?.length) {
    return z.enum(schema.enum.map(String)).describe(schema.description || '')
  }

  if (schema.type === 'integer') return z.number().int().describe(schema.description || '')
  if (schema.type === 'number') return z.number().describe(schema.description || '')
  if (schema.type === 'boolean') return z.boolean().describe(schema.description || '')
  if (schema.type === 'array') {
    return z.array(zodFromJsonSchema(schema.items || {})).describe(schema.description || '')
  }
  if (schema.type === 'object') {
    const shape = Object.fromEntries(
      Object.entries(schema.properties || {}).map(([key, value]) => [
        key,
        zodFromJsonSchema(value).optional(),
      ]),
    )
    return z.object(shape).passthrough().describe(schema.description || '')
  }
  return z.string().describe(schema.description || '')
}

function actionDescription(action) {
  return [
    `Use this when ${sentenceLower(action.title)}.`,
    action.useFor?.length ? `Workflows: ${action.useFor.join(', ')}.` : '',
    action.proof?.length ? `Success proof fields: ${action.proof.join(', ')}.` : '',
    action.requiresHumanConfirmation
      ? `Requires explicit user authorization: ${action.requiresHumanConfirmation}`
      : '',
    actionSupportsAuthorizationMode(action)
      ? 'Optional authorizationMode values: confirm_each, session_preauthorized, no_permission_needed, yolo, dangerously_approve_everything. Use permissive modes only when the host/operator already granted that policy. Backend proof is still required.'
      : '',
    action.failureContract ? `Failure contract: ${action.failureContract}` : '',
  ]
    .filter(Boolean)
    .join(' ')
}

function actionSupportsAuthorizationMode(action) {
  return Boolean(
    action.requiresHumanConfirmation ||
      action.externalSideEffect ||
      destructiveAction(action),
  )
}

function actionAnnotations(action) {
  const readOnly = action.kind === 'read'
  return {
    readOnlyHint: readOnly,
    destructiveHint: !readOnly && destructiveAction(action),
    openWorldHint: Boolean(action.externalSideEffect),
    idempotentHint: readOnly || ['PUT', 'PATCH', 'DELETE'].includes(action.method),
  }
}

function destructiveAction(action) {
  return (
    action.id.includes('delete') ||
    action.id.includes('replace') ||
    action.id.includes('end_live_call')
  )
}

function actionInvocationText(action, fallback) {
  const text = action.kind === 'read' ? 'Reading Speak' : `${fallback} Speak`
  return text.slice(0, 64)
}

function sentenceLower(value) {
  const text = String(value || '').trim()
  return text ? `${text.charAt(0).toLowerCase()}${text.slice(1)}` : 'use Speak'
}

async function searchSpeak(contract, apiRoot, query) {
  const normalizedQuery = normalizeSearchText(query)
  const actionResults = contract.backend.actions
    .filter((action) => action.callableByMcp)
    .map((action) => ({
      id: `action:${action.id}`,
      title: action.title,
      url: `${contract.mcpGeneration.sourceEndpoint}#${action.id}`,
      haystack: normalizeSearchText([
        action.id,
        action.title,
        action.path,
        action.useFor?.join(' '),
      ].join(' ')),
    }))
    .filter((item) => item.haystack.includes(normalizedQuery))

  const [workspace, communicationThreads, recentCalls] = await Promise.all([
    apiJson(apiRoot, '/workspace').catch(() => null),
    apiJson(apiRoot, '/communication-threads?limit=50').catch(() => null),
    apiJson(apiRoot, '/calls/recent?limit=500').catch(() => null),
  ])
  const leadResults = (workspace?.leads || [])
    .slice(0, 250)
    .map((lead) => ({
      id: `lead:${lead.id}`,
      title: `${lead.name || 'Contact'}${lead.company ? ` - ${lead.company}` : ''}`,
      url: `${contract.product.productionUrl}#lead-${encodeURIComponent(lead.id)}`,
      haystack: normalizeSearchText([
        lead.id,
        lead.name,
        lead.company,
        lead.phone,
        lead.email,
        lead.status,
        lead.notes,
      ].join(' ')),
    }))
    .filter((item) => item.haystack.includes(normalizedQuery))

  const profileResults = (workspace?.profiles || [])
    .map((profile) => ({
      id: `profile:${profile.id}`,
      title: profile.name || 'Agent profile',
      url: `${contract.product.productionPlaygroundUrl || contract.product.productionConfigUrl}#profile-${encodeURIComponent(profile.id)}`,
      haystack: normalizeSearchText([
        profile.id,
        profile.name,
        profile.config?.humeConfigId,
        profile.config?.voice,
      ].join(' ')),
    }))
    .filter((item) => item.haystack.includes(normalizedQuery))

  const threadResults = (communicationThreads?.threads || [])
    .map((thread) => {
      const summary = summarizeCommunicationThread(thread)
      return {
        id: `thread:${thread.threadId}`,
        title: summary.contactLabel || thread.threadId || 'Communication thread',
        url: `${productionLibraryUrl(contract)}#thread=${encodeURIComponent(thread.threadId)}`,
        haystack: normalizeSearchText([
          thread.threadId,
          thread.contactId,
          summary.contactLabel,
          summary.channels,
          thread.status,
          thread.summary,
          thread.latestMessagePreview,
        ].join(' ')),
      }
    })
    .filter((item) => item.haystack.includes(normalizedQuery))

  const callResults = (recentCalls?.calls || [])
    .slice(0, 250)
    .map((call) => {
      const summary = summarizeCall(call)
      return {
        id: `call:${call.callControlId}`,
        title: summary.leadName || summary.callControlId || 'Recent call',
        url: `${productionLibraryUrl(contract)}#transcript=${encodeURIComponent(call.callControlId)}`,
        haystack: normalizeSearchText([
          call.callControlId,
          call.chatId,
          summary.leadName,
          call.lead?.id,
          call.lead?.business_name,
          call.lead?.phone_on_file,
          call.lead?.called_phone,
          call.lead?.email_on_file,
          call.agent?.name,
          call.agent?.id,
          call.outcome,
          call.phase,
          call.insight,
          call.transcript?.map?.((entry) => `${entry.speaker || ''} ${entry.text || ''}`).join(' '),
        ].join(' ')),
      }
    })
    .filter((item) => item.id !== 'call:' && item.haystack.includes(normalizedQuery))

  return [...actionResults, ...leadResults, ...profileResults, ...threadResults, ...callResults]
    .slice(0, 20)
    .map(stripHaystack)
}

async function fetchSpeakItem(contract, apiRoot, id) {
  if (id.startsWith('action:')) {
    const actionId = id.slice('action:'.length)
    const action = contract.backend.actions.find((item) => item.id === actionId)
    if (!action) return missingFetchResult(id)
    return {
      id,
      title: action.title,
      text: JSON.stringify(action, null, 2),
      url: `${contract.mcpGeneration.sourceEndpoint}#${action.id}`,
      metadata: { type: 'action', risk: action.risk || '' },
    }
  }

  if (id.startsWith('call:')) {
    const callControlId = id.slice('call:'.length)
    const recentCalls = await apiJson(apiRoot, '/calls/recent?limit=500').catch(() => null)
    const call = (recentCalls?.calls || []).find(
      (item) => item.callControlId === callControlId,
    )
    if (!call) return missingFetchResult(id)
    const summary = summarizeCall(call)
    return {
      id,
      title: summary.leadName || summary.callControlId || 'Recent call',
      text: JSON.stringify(brandForAgent({ call, summary }), null, 2),
      url: `${productionLibraryUrl(contract)}#transcript=${encodeURIComponent(call.callControlId)}`,
      metadata: { type: 'recentCall', outcome: summary.outcome || '', phase: summary.phase || '' },
    }
  }

  const workspace = await apiJson(apiRoot, '/workspace')
  if (id.startsWith('lead:')) {
    const leadId = id.slice('lead:'.length)
    const lead = (workspace.leads || []).find((item) => item.id === leadId)
    if (!lead) return missingFetchResult(id)
    return {
      id,
      title: lead.name || lead.company || 'Contact',
      text: JSON.stringify(lead, null, 2),
      url: `${contract.product.productionUrl}#lead-${encodeURIComponent(lead.id)}`,
      metadata: { type: 'contact', status: lead.status || '' },
    }
  }

  if (id.startsWith('profile:')) {
    const profileId = id.slice('profile:'.length)
    const profile = (workspace.profiles || []).find((item) => item.id === profileId)
    if (!profile) return missingFetchResult(id)
    return {
      id,
      title: profile.name || 'Agent profile',
      text: JSON.stringify(brandForAgent(profile), null, 2),
      url: `${contract.product.productionPlaygroundUrl || contract.product.productionConfigUrl}#profile-${encodeURIComponent(profile.id)}`,
      metadata: { type: 'profile', active: String(workspace.activeProfileId === profile.id) },
    }
  }

  if (id.startsWith('thread:')) {
    const threadId = id.slice('thread:'.length)
    const [thread, messages] = await Promise.all([
      apiJson(apiRoot, `/communication-threads/${encodeURIComponent(threadId)}`).catch(() => null),
      apiJson(
        apiRoot,
        `/communication-threads/${encodeURIComponent(threadId)}/messages?limit=25`,
      ).catch(() => null),
    ])
    if (!thread?.thread) return missingFetchResult(id)
    return {
      id,
      title:
        summarizeCommunicationThread(thread.thread).contactLabel ||
        thread.thread.threadId ||
        'Communication thread',
      text: JSON.stringify(
        brandForAgent({
          thread: thread.thread,
          messages: messages?.messages || [],
        }),
        null,
        2,
      ),
      url: `${productionLibraryUrl(contract)}#thread=${encodeURIComponent(thread.thread.threadId)}`,
      metadata: { type: 'communicationThread', status: thread.thread.status || '' },
    }
  }

  return missingFetchResult(id)
}

function missingFetchResult(id) {
  return {
    id,
    title: 'Not found',
    text: `No Speak item found for ${id}.`,
    url: 'https://speak.example.com/speak/',
    metadata: { type: 'missing' },
  }
}

async function apiJson(apiRoot, path, { timeoutMs } = {}) {
  const response = await fetch(`${apiRoot.replace(/\/+$/g, '')}${path}`, {
    signal: Number.isFinite(Number(timeoutMs))
      ? AbortSignal.timeout(Number(timeoutMs))
      : undefined,
  })
  if (!response.ok) throw new Error(`Speak API ${path} failed: ${response.status}`)
  return response.json()
}

function normalizeSearchText(value) {
  return String(value || '').trim().toLowerCase()
}

function stripHaystack({ haystack: _haystack, ...item }) {
  return item
}

function jsonToolResult(structuredContent, text) {
  const brandedContent = brandForAgent(structuredContent)
  return {
    structuredContent: brandedContent,
    content: [{ type: 'text', text: JSON.stringify(brandedContent) || text }],
  }
}

function brandForAgent(value) {
  if (Array.isArray(value)) return value.map(brandForAgent)
  if (typeof value === 'string') return brandStringForAgent(value)
  if (!value || typeof value !== 'object') return value

  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => [
      brandKeyForAgent(key),
      brandForAgent(nestedValue),
    ]),
  )
}

function brandKeyForAgent(key) {
  const replacements = {
    humeConfigId: 'speakConfigId',
    humeConfigName: 'speakConfigName',
    humeConfigVersion: 'speakConfigVersion',
    humeConfigSyncedAt: 'speakConfigSyncedAt',
    humeVoiceName: 'speakVoiceName',
    humeVoiceProvider: 'speakVoiceProvider',
    telnyxCallerId: 'phoneCallerId',
    telnyxConnectionId: 'phoneConnectionId',
    telnyxStreamCodec: 'phoneStreamCodec',
    telnyxMinimumHangupMs: 'phoneMinimumHangupMs',
  }
  if (replacements[key]) return replacements[key]
  return String(key)
    .replace(/^hume\b/, 'speak')
    .replace(/^telnyx\b/, 'phone')
    .replace(/Hume/g, 'Speak')
    .replace(/hume/g, 'speak')
    .replace(/TELNYX/g, 'PHONE')
    .replace(/Telnyx/g, 'Phone')
    .replace(/telnyx/g, 'phone')
}

function brandStringForAgent(value) {
  const raw = String(value)
  if (raw === 'hume') return 'speak'
  if (raw === 'HUME_AI') return 'SPEAK_LIBRARY'
  if (raw.startsWith('HUME_AI:')) return raw.replace(/^HUME_AI:/, 'SPEAK_LIBRARY:')
  if (/^\+?1?\s*your\s+telnyx\s+number$/i.test(raw)) return '+1 your phone number'
  if (/^telnyx\s+connection\s+id$/i.test(raw)) return 'Phone connection ID'
  if (/^telnyx\s+call\s+control\s+connection_id$/i.test(raw)) {
    return 'Phone connection ID'
  }
  const text = raw
    .replace(/\bHume\b/g, 'Speak')
    .replace(/\bhume\b/g, 'speak')
    .replace(/\bTelnyx\b/g, 'phone provider')
    .replace(/\btelnyx\b/g, 'phoneProvider')

  return text
}

function setMcpCorsHeaders(response) {
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS')
  response.setHeader(
    'Access-Control-Allow-Headers',
    'content-type, mcp-session-id, mcp-protocol-version, authorization',
  )
  response.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id')
}
