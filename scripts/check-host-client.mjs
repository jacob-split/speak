import fs from 'node:fs'
import {
  createSpeakAgentClient,
  speakHostClientSchemaVersion,
} from '../agent/host-client/speak-agent-client.mjs'
import {
  buildSpeakAgentContract,
  buildSpeakAgentReadinessReport,
} from '../server/agent-contract.mjs'

const failures = []
const requests = []
const options = {
  basePath: '/speak',
  publicBaseUrl: 'https://speak.example.com/speak',
}
const contract = buildSpeakAgentContract(options)
const readiness = buildSpeakAgentReadinessReport(options)

const client = createSpeakAgentClient({
  baseUrl: 'https://speak.example.com/speak',
  authorizationMode: 'yolo',
  fetch: async (url, init = {}) => {
    const parsed = new URL(url)
    const body = init.body ? JSON.parse(init.body) : undefined
    requests.push({ method: init.method || 'GET', path: parsed.pathname, search: parsed.search, body })

    if (parsed.pathname === '/speak/api/agent/capabilities') {
      return jsonResponse(contract)
    }
    if (parsed.pathname === '/speak/api/agent/readiness.json') {
      return jsonResponse(readiness)
    }
    if (parsed.pathname === '/speak/api/agent/ui-snapshot.json') {
      return jsonResponse({
        schemaVersion: 'speak.ui-runtime-snapshot.v1',
        surface: parsed.searchParams.get('surface') || 'dialer',
        authorizationMode: parsed.searchParams.get('authorizationMode') || 'confirm_each',
        structuredContent: {
          surface: parsed.searchParams.get('surface') || 'dialer',
          stateVersion: 1,
          generatedAt: '2026-06-22T12:00:00.000Z',
        },
        _meta: {},
        genericHost: {
          hydrateMessage: {
            type: 'speak:hydrate',
            source: 'host',
            schemaVersion: 'speak.widget-postmessage.v1',
            detail: {},
          },
        },
      })
    }
    if (parsed.pathname === '/speak/api/agent/mcp-ui.json') {
      return jsonResponse({ schemaVersion: 'speak.mcp-ui.manifest.v1' })
    }
    if (parsed.pathname === '/speak/api/agent/ag-ui.json') {
      return jsonResponse({ schemaVersion: 'speak.ag-ui.manifest.v1' })
    }
    if (parsed.pathname === '/speak/api/agent/a2ui.json') {
      return jsonResponse({ schemaVersion: 'speak.a2ui.manifest.v1' })
    }
    if (parsed.pathname === '/speak/.well-known/agent.json') {
      return jsonResponse({ protocolVersion: '0.3.0', name: 'Speak' })
    }
    if (parsed.pathname === '/speak/api/agent/json-render.json') {
      return jsonResponse({ schemaVersion: 'speak.vercel-json-render.manifest.v1' })
    }
    if (parsed.pathname === '/speak/api/agent/copilotkit.json') {
      return jsonResponse({ schemaVersion: 'speak.copilotkit.manifest.v1' })
    }
    if (parsed.pathname === '/speak/api/agent/actions/read_communication_threads/invoke') {
      return jsonResponse({
        schemaVersion: 'speak.action-invocation.v1',
        ok: true,
        actionId: 'read_communication_threads',
        authorizationMode: body?.authorizationMode,
        proofExpected: ['threads[].threadId'],
        proofReturned: [{ field: 'threads[].threadId', present: true }],
        transport: { status: 200 },
        result: {
          threads: [{ threadId: 'thread-host-client', channels: ['call'] }],
        },
      })
    }
    if (parsed.pathname === '/speak/api/workspace') {
      return jsonResponse({
        leads: [{ id: 'lead-host', name: 'Host Lead', company: 'Host Co' }],
        profiles: [{ id: 'profile-host', name: 'Host Profile' }],
      })
    }
    return jsonResponse({ error: 'not found' }, { status: 404 })
  },
})

if (speakHostClientSchemaVersion !== 'speak.host-client.v1') {
  failures.push(`unexpected host client schema ${speakHostClientSchemaVersion}`)
}
if (client.endpoints.hostClient !== contract.agentAdapters.hostClient) {
  failures.push('host client endpoint does not match contract adapter endpoint')
}
;[
  'mcpUi',
  'agUi',
  'a2ui',
  'a2aAgentJson',
  'aiSdk',
  'jsonRender',
  'copilotKit',
].forEach((key) => {
  if (client.endpoints[key] !== contract.agentAdapters[key]) {
    failures.push(`host client endpoint ${key} does not match contract adapter endpoint`)
  }
  if (typeof client[key] !== 'function') {
    failures.push(`host client missing ${key} convenience reader`)
  }
})

const loadedContract = await client.capabilities()
if (loadedContract.hostClient?.schemaVersion !== 'speak.host-client.v1') {
  failures.push('capabilities readback missing hostClient contract')
}

const loadedReadiness = await client.readiness()
if (loadedReadiness.overallStatus !== 'pass') {
  failures.push(`readiness readback status ${loadedReadiness.overallStatus}`)
}

const snapshot = await client.uiSnapshot({ surface: 'configs', limit: 2 })
if (snapshot.schemaVersion !== 'speak.ui-runtime-snapshot.v1' || snapshot.surface !== 'configs') {
  failures.push('uiSnapshot did not return the requested configs surface')
}
const adapterReads = await Promise.all([
  client.mcpUi(),
  client.agUi(),
  client.a2ui(),
  client.a2aAgentJson(),
  client.jsonRender(),
  client.copilotKit(),
])
;[
  'speak.mcp-ui.manifest.v1',
  'speak.ag-ui.manifest.v1',
  'speak.a2ui.manifest.v1',
  '0.3.0',
  'speak.vercel-json-render.manifest.v1',
  'speak.copilotkit.manifest.v1',
].forEach((expected, index) => {
  const payload = adapterReads[index] || {}
  if (payload.schemaVersion !== expected && payload.protocolVersion !== expected) {
    failures.push(`host client adapter reader ${index} returned unexpected schema`)
  }
})

const threads = await client.invoke('read_communication_threads', { limit: 1 })
if (!threads.ok || threads.result?.threads?.[0]?.threadId !== 'thread-host-client') {
  failures.push('invoke did not return communication-thread proof payload')
}
const invokeRequest = requests.find((request) =>
  request.path.endsWith('/api/agent/actions/read_communication_threads/invoke'),
)
if (invokeRequest?.body?.query?.limit !== 1 || invokeRequest?.body?.authorizationMode !== 'yolo') {
  failures.push('invoke did not normalize convenience args into query plus authorizationMode')
}

const rendered = await client.callTool('render_speak_configs', { limit: 2 })
if (rendered.surface !== 'configs') {
  failures.push('callTool did not map render_speak_configs to configs snapshot')
}

const lead = await client.fetchItem('lead:lead-host')
if (lead.title !== 'Host Co' || lead.metadata?.kind !== 'lead') {
  failures.push('fetchItem did not resolve lead from workspace')
}

const source = fs.readFileSync('agent/host-client/speak-agent-client.mjs', 'utf8')
;[
  'createSpeakAgentClient',
  'hydrateSpeakWidget',
  'connectSpeakWidget',
  'speak.widget-postmessage.v1',
  '/api/agent/actions/{actionId}/invoke',
  '/api/agent/mcp-ui.json',
  '/api/agent/ag-ui.json',
  '/api/agent/a2ui.json',
  '/.well-known/agent.json',
  '/api/agent/json-render.json',
  '/api/agent/copilotkit.json',
].forEach((needle) => {
  if (!source.includes(needle)) failures.push(`host client source missing ${needle}`)
})
if (/\bHume\b|\bhume\b|HUME/.test(source)) {
  failures.push('host client source leaks upstream provider branding')
}

const documentedHostClientExamples = [
  {
    file: 'docs/agent-integration.md',
    required: [
      "createSpeakAgentClient({ baseUrl: '/speak' })",
      "client.hydrateWidget('#speak-widget'",
      "client.connectWidget('#speak-widget')",
      "client.invoke('read_workspace')",
      'widget-originated tool calls',
    ],
  },
  {
    file: 'docs/backend-api-reference.md',
    required: [
      "baseUrl: 'https://speak.example.com/speak'",
      "client.hydrateWidget('#speak-widget'",
      "client.connectWidget('#speak-widget')",
      "client.invoke('read_workspace')",
    ],
  },
  {
    file: 'README.md',
    required: [
      'createSpeakAgentClient',
      'client.hydrateWidget()',
      'client.connectWidget()',
      'instead of writing platform-specific fetch and postMessage handling',
    ],
  },
  {
    file: 'agent/skills/speak-operator/references/workflows.md',
    required: [
      'createSpeakAgentClient',
      'client.hydrateWidget()',
      'client.connectWidget()',
    ],
  },
]

for (const { file, required } of documentedHostClientExamples) {
  const text = fs.readFileSync(file, 'utf8')
  for (const token of required) {
    if (!text.includes(token)) {
      failures.push(`${file}: host client example missing ${token}`)
    }
  }
  for (const token of [
    'apiRoot:',
    'widgetOrigin:',
    'client.hydrateSpeakWidget(',
    'use `createSpeakAgentClient()`, `hydrateSpeakWidget()`, or `connectSpeakWidget()`',
    'for `createSpeakAgentClient`, `hydrateSpeakWidget`, and `connectSpeakWidget`',
  ]) {
    if (text.includes(token)) {
      failures.push(`${file}: host client example contains stale token ${token}`)
    }
  }
}

if (failures.length > 0) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2))
  process.exitCode = 1
} else {
  console.log(
    JSON.stringify(
      {
        ok: true,
        schemaVersion: speakHostClientSchemaVersion,
        endpoint: contract.agentAdapters.hostClient,
        requests: requests.map((request) => ({
          method: request.method,
          path: request.path,
          search: request.search,
        })),
      },
      null,
      2,
    ),
  )
}

function jsonResponse(payload, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
    async text() {
      return JSON.stringify(payload)
    },
  }
}
