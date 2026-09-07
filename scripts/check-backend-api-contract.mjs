import { readFileSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  buildSpeakAgentContract,
  buildSpeakOpenApiDocument,
} from '../server/agent-contract.mjs'

const rawArgs = process.argv.slice(2)
const flags = new Set(rawArgs.filter((arg) => arg.startsWith('--') && !arg.includes('=')))
const options = Object.fromEntries(
  rawArgs
    .filter((arg) => arg.startsWith('--') && arg.includes('='))
    .map((arg) => {
      const [key, ...rest] = arg.slice(2).split('=')
      return [key, rest.join('=')]
    }),
)

const json = flags.has('--json')
const baseUrl = safeText(
  options.baseUrl ||
    process.env.SPEAK_BACKEND_API_BASE_URL ||
    process.env.SPEAK_QA_BASE_URL ||
    '',
).replace(/\/+$/, '')

const apiReference = readFileSync('docs/backend-api-reference.md', 'utf8')
const normalizedApiReference = apiReference.replace(/\s+/g, ' ')
const serverSource = readFileSync('server/index.mjs', 'utf8')
const contractSource = readFileSync('server/agent-contract.mjs', 'utf8')
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))
const serverRoutes = extractServerRoutes(serverSource)
const contract = buildSpeakAgentContract({
  basePath: '/speak',
  publicBaseUrl: baseUrl || 'https://speak.example.com/speak',
})
const agentContractLatestCommitDate = latestGitCommitDate('server/agent-contract.mjs')
const openApi = buildSpeakOpenApiDocument({
  basePath: '/speak',
  publicBaseUrl: baseUrl || 'https://speak.example.com/speak',
})
const actions = contract.backend?.actions || []
const matrixRows = parseActionMatrix(apiReference)
const matrixById = new Map(matrixRows.map((row) => [row.id, row]))
const failures = []
const liveChecks = []
const profileActivationFailures = []
const bulkProfilesRouteSource = serverSource.slice(
  serverSource.indexOf("app.put('/api/profiles'"),
  serverSource.indexOf("app.post('/api/profiles'"),
)

if (!/preserveActiveProfile:\s*true/.test(bulkProfilesRouteSource)) {
  const failure = 'PUT /api/profiles must preserve the server active profile; only PUT /api/profiles/active may switch it'
  failures.push(failure)
  profileActivationFailures.push(failure)
}

if (!isIsoDate(contract.contractVersion)) {
  failures.push(`agent contract version must be an ISO date, got ${contract.contractVersion || 'missing'}`)
}
if (
  agentContractLatestCommitDate &&
  isIsoDate(contract.contractVersion) &&
  compareIsoDate(contract.contractVersion, agentContractLatestCommitDate) < 0
) {
  failures.push(
    `agent contract version ${contract.contractVersion} is older than latest committed agent-contract date ${agentContractLatestCommitDate}`,
  )
}

for (const action of actions) {
  const row = matrixById.get(action.id)
  if (!row) {
    failures.push(`backend API reference is missing action ${action.id}`)
    continue
  }
  if (row.method !== action.method) {
    failures.push(`backend API reference method drift for ${action.id}: docs=${row.method} contract=${action.method}`)
  }
  if (row.path !== action.path) {
    failures.push(`backend API reference path drift for ${action.id}: docs=${row.path} contract=${action.path}`)
  }
  if (row.kind !== action.kind) {
    failures.push(`backend API reference kind drift for ${action.id}: docs=${row.kind} contract=${action.kind}`)
  }
  if (row.risk !== action.risk) {
    failures.push(`backend API reference risk drift for ${action.id}: docs=${row.risk} contract=${action.risk}`)
  }
  if (row.callableByMcp !== Boolean(action.callableByMcp)) {
    failures.push(
      `backend API reference callable drift for ${action.id}: docs=${row.callableByMcp ? 'yes' : 'no'} contract=${Boolean(action.callableByMcp) ? 'yes' : 'no'}`,
    )
  }
  if (!serverRouteExists(action)) {
    failures.push(`server/index.mjs does not expose ${action.method} ${action.path} for ${action.id}`)
  }
  if (action.callableByMcp) {
    for (const proof of action.proof || []) {
      const proofPath = safeText(proof).split('=')[0].trim()
      if (!proofPath || /\s/.test(proofPath)) {
        failures.push(`callable action ${action.id} has non-machine-checkable proof field: ${proof}`)
      }
    }
  }
}

for (const row of matrixRows) {
  if (actions.some((action) => action.id === row.id)) continue
  failures.push(`backend API reference action matrix includes non-contract route ${row.id}; document ${row.method} ${row.path} under First-Party And Compatibility REST Routes instead`)
}

for (const stalePath of ['/api/webhooks/phone-provider', '/api/webhooks/voice-provider']) {
  if (apiReference.includes(stalePath) || contractSource.includes(stalePath)) {
    failures.push(`stale generic provider webhook path is still documented or contracted: ${stalePath}`)
  }
}

if (/\|\s*Well-known agent card\s*\|\s*`https:\/\/support-origin\.split-llc\.com\/speak\/\.well-known\/speak-agent\.json`/.test(apiReference)) {
  failures.push('backend API reference mislabels .well-known/speak-agent.json as the A2A Agent Card')
}
if (/https:\/\/(?:sales|support-origin)\.split-llc\.com\/speak\/api(?:[`<\s|)]|$)/.test(apiReference)) {
  failures.push('backend API reference lists directory-style /api root; document exact implemented endpoints instead')
}
for (const requiredDiscoveryRow of [
  '| Backend health | `https://speak.example.com/speak/api/health` |',
  '| Well-known Speak capabilities | `https://speak.example.com/speak/.well-known/speak-agent.json` |',
  '| A2A Agent Card | `https://speak.example.com/speak/.well-known/agent-card.json` |',
  '| A2A Agent JSON alias | `https://speak.example.com/speak/.well-known/agent.json` |',
]) {
  if (!apiReference.includes(requiredDiscoveryRow)) {
    failures.push(`backend API reference missing production discovery row: ${requiredDiscoveryRow}`)
  }
}

for (const requiredManifestRow of [
  '| Agent capabilities | `https://speak.example.com/speak/api/agent/capabilities` |',
  '| Well-known Speak capabilities alias | `https://speak.example.com/speak/.well-known/speak-agent.json` |',
  '| Action invocation | `https://speak.example.com/speak/api/agent/actions/{actionId}/invoke` |',
  '| ChatGPT app manifest | `https://speak.example.com/speak/api/agent/chatgpt-app.json` |',
  '| Agent readiness | `https://speak.example.com/speak/api/agent/readiness.json` |',
  '| Widget HTML | `https://speak.example.com/speak/api/agent/widgets/speak-operator.html` |',
  '| Host client | `https://speak.example.com/speak/api/agent/host-client.mjs` |',
  '| Generative UI | `https://speak.example.com/speak/api/agent/generative-ui.json` |',
  '| UI adapter kit | `https://speak.example.com/speak/api/agent/ui-adapter-kit.json` |',
  '| UI snapshot | `https://speak.example.com/speak/api/agent/ui-snapshot.json` |',
  '| MCP UI | `https://speak.example.com/speak/api/agent/mcp-ui.json` |',
  '| AG-UI | `https://speak.example.com/speak/api/agent/ag-ui.json` |',
  '| A2UI | `https://speak.example.com/speak/api/agent/a2ui.json` |',
  '| Vercel AI SDK UI | `https://speak.example.com/speak/api/agent/ai-sdk.json` |',
  '| Vercel JSON Render | `https://speak.example.com/speak/api/agent/json-render.json` |',
  '| CopilotKit | `https://speak.example.com/speak/api/agent/copilotkit.json` |',
]) {
  if (!apiReference.includes(requiredManifestRow)) {
    failures.push(`backend API reference missing agent adapter manifest row: ${requiredManifestRow}`)
  }
}

for (const requiredReadinessToken of [
  'speak.agent-readiness.v1',
  'readinessLevel=s-class-candidate',
  'overallStatus=pass',
  'summary.failed=0',
]) {
  if (!apiReference.includes(requiredReadinessToken)) {
    failures.push(`backend API reference missing readiness token: ${requiredReadinessToken}`)
  }
}

for (const requiredMcpTransportToken of [
  'MCP Streamable HTTP',
  '`406 Not Acceptable`',
  '`text/event-stream`',
]) {
  if (!apiReference.includes(requiredMcpTransportToken)) {
    failures.push(`backend API reference missing MCP transport token: ${requiredMcpTransportToken}`)
  }
}

if (!openApi.paths?.['/api/calltools/agent-session']?.post) {
  failures.push('OpenAPI must document POST /api/calltools/agent-session for backend/headless CallTools readiness establishment')
}

if (
  safeText(openApi.paths?.['/api/calltools/agent-session']?.post?.operationId) !==
  'establish_calltools_agent_session'
) {
  failures.push('OpenAPI POST /api/calltools/agent-session must use operationId establish_calltools_agent_session')
}

const callToolsAgentSessionAction = actions.find((action) => action.id === 'establish_calltools_agent_session')
if (!callToolsAgentSessionAction) {
  failures.push('agent contract must expose establish_calltools_agent_session for backend/headless CallTools readiness establishment')
} else {
  for (const requiredProof of [
    'backendOnly',
    'headlessOnly',
    'establishPath',
    'campaignStartPath',
    'campaignAgentEstablishPath',
    'mutationPerformed',
    'campaignStart.ok',
    'campaignAgentStatus.ready',
    'proof.loggedIn',
    'proof.proofSources[]',
  ]) {
    if (!callToolsAgentSessionAction.proof?.includes(requiredProof)) {
      failures.push(`CallTools agent-session contract missing proof field ${requiredProof}`)
    }
  }
  if (callToolsAgentSessionAction.callableByMcp) {
    failures.push('CallTools agent-session action must not be callable by MCP because it mutates native AgentStatus')
  }
  if (!/browser automation or dashboard session state/i.test(safeText(callToolsAgentSessionAction.failureContract))) {
    failures.push('CallTools agent-session contract must reject browser automation and dashboard session state')
  }
  if (!/confirmAgentSession=true/.test(safeText(callToolsAgentSessionAction.failureContract))) {
    failures.push('CallTools agent-session contract must require confirmAgentSession=true for apply mode')
  }
}

for (const requiredCallToolsAgentSessionDoc of [
  '`POST /api/calltools/agent-session` is the backend/headless establishment path',
  '`campaigns/{campaignId}` PATCH',
  '`active=true`',
  '`originate_calls=true`',
  '`/campaignagents/{appUserId}` PATCH',
  '`agentstatuses/{appUserId}` PATCH',
  '`web_phone_status=Registered`',
  '`web_phone_registered_on`',
  '`backendOnly=true`',
  '`headlessOnly=true`',
  '`campaignStartPath=campaigns.patch`',
  '`campaignAgentEstablishPath=campaignagents.patch`',
  '`establishPath=agentstatuses.patch`',
  '`agentstatuses.read` / `campaignagents.read` / `campaignstatuses.read`',
  'Apply mode requires both `apply=true` and `confirmAgentSession=true`',
  'Browser automation, dashboard login state, and browser-held webphone sessions are not accepted',
]) {
  if (!normalizedApiReference.includes(requiredCallToolsAgentSessionDoc.replace(/\s+/g, ' '))) {
    failures.push(`backend API reference missing CallTools agent-session contract token: ${requiredCallToolsAgentSessionDoc}`)
  }
}

for (const requiredRouteToken of [
  'frontend.routes',
  'operator-facing labels',
  '`Library`, `Dialer`, and `Playground`',
]) {
  if (!apiReference.includes(requiredRouteToken)) {
    failures.push(`backend API reference missing frontend route-label token: ${requiredRouteToken}`)
  }
}

for (const requiredFirstPartyRouteDoc of [
  '## First-Party And Compatibility REST Routes',
  '| GET | `/api/agent-configs/hume/{configId}` | Direct Hume config readback',
  '| GET | `/api/agent-configs/inworld/{configId}` | Direct Inworld config readback',
  '| GET | `/api/agent-configs/hume-options` | Hume-native model and voice option catalog',
  '| GET | `/api/agent-configs/inworld-options` | Inworld-native model and voice option catalog',
  '| POST | `/api/agent-configs/sync-hume` | Direct Hume profile sync compatibility route.',
  '| POST | `/api/agent-configs/sync-inworld` | Direct Inworld profile sync compatibility route.',
  '| POST | `/api/calls/delete` | First-party bulk delete for ended call or Playground test transcripts.',
  '| DELETE | `/api/calls/{callControlId}` | First-party single-record delete for ended call or Playground test transcripts.',
  '| GET | `/api/calls/{callControlId}/audio` | Local retained mixed WAV stream',
  '| GET | `/api/calls/{callControlId}/audio/diagnostics/{stage}` | Local retained diagnostic WAV stream',
  '| WS | `/api/calls/{callControlId}/supervision` | Token-bound first-party Playground Phone media/control socket',
  '| GET | `/api/calltools/status` | First-party CallTools account, binding, media-gateway, readiness, and proof summary',
  '| GET | `/api/calltools/options` | First-party CallTools user, phone, campaign, queue, caller ID, status, and source-option catalog',
  '| GET | `/api/phone-provider/options` | First-party Telnyx phone-number catalog',
  '| POST | `/api/calltools/verify-agent` | First-party backend verifier for a proposed CallTools user/phone/campaign binding.',
  '| POST | `/api/calltools/provision-agent` | First-party dry-run provisioning planner for CallTools Phone-as-Agent bindings.',
  '| GET | `/api/calltools/gateway-config` | Protected CallTools WebRTC/SIP phone credential read',
  '| WS | `/api/calltools/media-gateway` | Protected Speak-owned WebRTC/SIP media-gateway socket.',
  '| POST | `/api/webhooks/workspace-email` | Trusted Workspace/Gmail sent/received event normalizer.',
  '| OPTIONS | `/api/here-now/upload-proxy` | CORS preflight for the here.now signed-upload proxy.',
  '| PUT | `/api/here-now/upload-proxy?url={signedR2Url}` | Raw upload proxy for signed here.now R2 drive URLs',
  '| ANY | `/api/here-now/api/v1/*` | Narrow here.now v1 CORS proxy.',
]) {
  if (!apiReference.includes(requiredFirstPartyRouteDoc)) {
    failures.push(`backend API reference missing first-party route doc: ${requiredFirstPartyRouteDoc}`)
  }
}

for (const requiredScript of ['qa:backend-api', 'agent:openapi', 'agent:contract']) {
  if (!packageJson.scripts?.[requiredScript]) {
    failures.push(`package.json is missing required backend API script ${requiredScript}`)
  }
}

if (
  !/path:\s*\{\s*leadId:\s*'lead-orion'\s*\}/.test(apiReference) ||
  !/const contact = proof\.result\.lead/.test(apiReference) ||
  !/console\.log\(contact\.status\)/.test(apiReference)
) {
  failures.push('backend API reference action invocation example must use path/body envelope and contact alias for the legacy proof.result.lead payload')
}

if (/console\.log\(proof\.result\.lead\.status\)/.test(apiReference)) {
  failures.push('backend API reference action invocation example must not expose legacy lead naming as the user-facing result variable')
}

if (baseUrl) {
  for (const probe of liveReadProbes(baseUrl)) {
    liveChecks.push(await runLiveProbe(probe))
  }
  for (const check of liveChecks) {
    if (!check.ok) failures.push(check.failure)
  }
}

const profileActivationCheck = await verifyProfileActivationIsolation()
if (!profileActivationCheck.ok) {
  failures.push(profileActivationCheck.failure)
  profileActivationFailures.push(profileActivationCheck.failure)
}
const reportedFailures = flags.has('--profile-activation-only')
  ? profileActivationFailures
  : failures

const payload = {
  ok: reportedFailures.length === 0,
  schemaVersion: 'speak.backend-api-contract.v1',
  actionCount: actions.length,
  documentedActionCount: matrixRows.length,
  contractVersion: contract.contractVersion,
  agentContractLatestCommitDate,
  baseUrl: baseUrl || '',
  liveProbeCount: liveChecks.length,
  liveChecks: liveChecks.map(({ failure, ...check }) => check),
  profileActivationCheck: {
    ok: profileActivationCheck.ok,
    bulkPreservedActiveProfile: profileActivationCheck.bulkPreservedActiveProfile,
    explicitEndpointChangedActiveProfile: profileActivationCheck.explicitEndpointChangedActiveProfile,
  },
  failures: reportedFailures,
}

if (json || !payload.ok) {
  console.log(JSON.stringify(payload, null, 2))
} else {
  console.log('Backend API contract checks passed.')
}

if (!payload.ok) process.exit(1)

function parseActionMatrix(markdown) {
  return [...markdown.matchAll(/^\| `([^`]+)` \| ([A-Z]+) \| `([^`]+)` \| ([^|]+) \| ([^|]+) \| ([^|]+) \|/gm)]
    .map((match) => ({
      id: match[1],
      method: match[2],
      path: match[3],
      kind: safeText(match[4]),
      risk: safeText(match[5]),
      callableByMcp: /^yes\b/i.test(safeText(match[6])),
    }))
}

function serverRouteExists(action) {
  const method = safeText(action.method).toUpperCase()
  const path = safeText(action.path)
  if (!method || !path) return false
  if (method === 'WEBSOCKET' || method === 'WS') return websocketRouteExists(path)
  const expressPath = toExpressPath(path)
  return serverRoutes.some((route) => route.method === method && route.path === expressPath)
}

function extractServerRoutes(source) {
  const routes = []
  const pattern = /app\.(get|post|put|patch|delete)\s*\(/g
  let match = null
  while ((match = pattern.exec(source))) {
    const method = match[1].toUpperCase()
    const firstArgument = readFirstArgument(source, pattern.lastIndex)
    for (const routePath of routePathsFromFirstArgument(firstArgument)) {
      routes.push({ method, path: routePath })
    }
  }
  return routes
}

function readFirstArgument(source, startIndex) {
  let cursor = startIndex
  let depth = 0
  let quote = ''
  let escaped = false
  while (cursor < source.length) {
    const char = source[cursor]
    if (quote) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === quote) {
        quote = ''
      }
      cursor += 1
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      cursor += 1
      continue
    }
    if (char === '[' || char === '(' || char === '{') {
      depth += 1
      cursor += 1
      continue
    }
    if (char === ']' || char === ')' || char === '}') {
      if (depth === 0) return source.slice(startIndex, cursor).trim()
      depth -= 1
      cursor += 1
      continue
    }
    if (char === ',' && depth === 0) {
      return source.slice(startIndex, cursor).trim()
    }
    cursor += 1
  }
  return ''
}

function routePathsFromFirstArgument(argument) {
  if (!argument) return []
  return [...argument.matchAll(/['"`](\/[^'"`]+)['"`]/g)].map((match) => match[1])
}

function websocketRouteExists(path) {
  if (path === '/media-stream') {
    return serverSource.includes("pathname === '/media-stream'") &&
      serverSource.includes('telnyxMediaWss.handleUpgrade')
  }
  if (path === '/api/calltools/media-gateway') {
    return serverSource.includes("pathname === '/api/calltools/media-gateway'") &&
      serverSource.includes('calltoolsMediaGatewayWss.handleUpgrade')
  }
  if (/^\/api\/config-tests\/\{[^}]+\}\/audio$/.test(path)) {
    return serverSource.includes('browserTestMatch') &&
      serverSource.includes('browserTestWss.handleUpgrade') &&
      serverSource.includes('config-tests') &&
      serverSource.includes('audio')
  }
  return false
}

function toExpressPath(path) {
  return safeText(path).replace(/\{([^}]+)\}/g, ':$1')
}

function liveReadProbes(root) {
  return [
    {
      name: 'health',
      url: joinUrl(root, '/api/health'),
      validate: (payload) => payload?.ok === true && Object.prototype.hasOwnProperty.call(payload, 'configured'),
    },
    {
      name: 'agent-readiness',
      url: joinUrl(root, '/api/agent/readiness.json'),
      validate: (payload) => ({
        ok: payload?.schemaVersion === 'speak.agent-readiness.v1' &&
          contractVersionMatches(payload) &&
          payload?.readinessLevel === 's-class-candidate' &&
          payload?.overallStatus === 'pass' &&
          Number(payload?.summary?.failed) === 0,
        details: contractVersionDetails(payload),
      }),
    },
    {
      name: 'agent-capabilities',
      url: joinUrl(root, '/api/agent/capabilities'),
      validate: (payload) => {
        const drift = [
          ...liveAgentAdapterDrift(payload),
          ...liveFrontendDrift(payload),
          ...liveActionDrift(payload),
        ]
        return {
          ok: Array.isArray(payload?.backend?.actions) &&
            contractVersionMatches(payload) &&
            payload.backend.actions.length >= actions.length &&
            payload?.agentAdapters &&
            typeof payload.agentAdapters === 'object' &&
            Array.isArray(payload?.frontend?.routes) &&
            Array.isArray(payload?.frontend?.uiActions) &&
            drift.length === 0,
          details: {
            liveAgentAdapterCount: payload?.agentAdapters && typeof payload.agentAdapters === 'object'
              ? Object.keys(payload.agentAdapters).length
              : 0,
            liveRouteCount: Array.isArray(payload?.frontend?.routes) ? payload.frontend.routes.length : 0,
            liveUiActionCount: Array.isArray(payload?.frontend?.uiActions) ? payload.frontend.uiActions.length : 0,
            liveActionCount: Array.isArray(payload?.backend?.actions) ? payload.backend.actions.length : 0,
            ...contractVersionDetails(payload),
            drift,
          },
        }
      },
    },
    {
      name: 'well-known-speak-agent',
      url: joinUrl(root, '/.well-known/speak-agent.json'),
      validate: (payload) => ({
        ok: payload?.schemaVersion === 'speak.agent.capabilities.v1' &&
          contractVersionMatches(payload) &&
          Array.isArray(payload?.backend?.actions) &&
          Boolean(payload?.agentAdapters),
        details: contractVersionDetails(payload),
      }),
    },
    {
      name: 'openapi',
      url: joinUrl(root, '/api/agent/openapi.json'),
      validate: (payload) => {
        const drift = liveOpenApiDrift(payload)
        return {
          ok: Boolean(payload?.openapi && payload?.paths?.['/api/health']?.get) &&
            drift.length === 0,
          details: {
            livePathCount: payload?.paths && typeof payload.paths === 'object'
              ? Object.keys(payload.paths).length
              : 0,
            localPathCount: Object.keys(openApi.paths || {}).length,
            drift,
          },
        }
      },
    },
    {
      name: 'acp',
      url: joinUrl(root, '/api/agent/acp'),
      validate: (payload) =>
        payload?.schemaVersion === 'speak.acp.discovery.v1' &&
        payload?.name === 'Speak' &&
        Boolean(payload?.protocols?.mcp) &&
        Boolean(payload?.protocols?.generativeUi?.widgetHtml) &&
        Array.isArray(payload?.ui?.actions),
    },
    {
      name: 'chatgpt-app',
      url: joinUrl(root, '/api/agent/chatgpt-app.json'),
      validate: (payload) =>
        payload?.schemaVersion === 'speak.chatgpt-app.v1' &&
        payload?.name === 'Speak' &&
        Array.isArray(payload?.resources) &&
        payload.resources.length > 0 &&
        Boolean(payload?.bridge),
    },
    {
      name: 'mcp-streamable-http-plain-get',
      url: joinUrl(root, '/mcp'),
      expectedStatus: 406,
      validate: (payload) =>
        payload?.jsonrpc === '2.0' &&
        Number(payload?.error?.code) === -32000 &&
        /text\/event-stream/i.test(safeText(payload?.error?.message)),
    },
    {
      name: 'generative-ui',
      url: joinUrl(root, '/api/agent/generative-ui.json'),
      validate: (payload) =>
        payload?.schemaVersion === 'speak.generative-ui.manifest.v1' &&
        payload?.name === 'Speak' &&
        Boolean(payload?.endpoints?.actionInvocation) &&
        Boolean(payload?.adapterKit) &&
        Boolean(payload?.hostClient) &&
        Boolean(payload?.widget),
    },
    {
      name: 'ui-adapter-kit',
      url: joinUrl(root, '/api/agent/ui-adapter-kit.json'),
      validate: (payload) => validateSurfaceManifest(payload, 'speak.ui-adapter-kit.v1'),
    },
    ...['library', 'dialer', 'configs'].map((surface) => ({
      name: `ui-snapshot-${surface}`,
      url: joinUrl(root, `/api/agent/ui-snapshot.json?surface=${surface}`),
      validate: (payload) => validateUiSnapshot(payload, surface),
    })),
    {
      name: 'mcp-ui',
      url: joinUrl(root, '/api/agent/mcp-ui.json'),
      validate: (payload) =>
        validateSurfaceManifest(payload, 'speak.mcp-ui.manifest.v1').ok &&
        Array.isArray(payload?.resources) &&
        payload.resources.length > 0,
    },
    {
      name: 'ag-ui',
      url: joinUrl(root, '/api/agent/ag-ui.json'),
      validate: (payload) =>
        payload?.schemaVersion === 'speak.ag-ui.manifest.v1' &&
        Array.isArray(payload?.tools) &&
        payload.tools.some((tool) => safeText(tool?.name || tool?.id) === 'start_live_call') &&
        Array.isArray(payload?.transports) &&
        payload.transports.some((transport) => safeText(transport?.id) === 'contract_action_invocation'),
    },
    {
      name: 'a2ui',
      url: joinUrl(root, '/api/agent/a2ui.json'),
      validate: (payload) =>
        validateSurfaceManifest(payload, 'speak.a2ui.manifest.v1').ok &&
        Array.isArray(payload?.actions) &&
        payload.actions.some((action) => safeText(action?.eventName || action?.id || action?.name) === 'start_queue'),
    },
    {
      name: 'ai-sdk',
      url: joinUrl(root, '/api/agent/ai-sdk.json'),
      validate: (payload) =>
        payload?.schemaVersion === 'speak.ai-sdk.generative-ui.v1' &&
        Array.isArray(payload?.tools) &&
        Array.isArray(payload?.components) &&
        payload.components.some((component) => safeText(component?.surface || component?.id) === 'dialer'),
    },
    {
      name: 'json-render',
      url: joinUrl(root, '/api/agent/json-render.json'),
      validate: (payload) => validateSurfaceManifest(payload, 'speak.vercel-json-render.manifest.v1'),
    },
    {
      name: 'copilotkit',
      url: joinUrl(root, '/api/agent/copilotkit.json'),
      validate: (payload) =>
        payload?.schemaVersion === 'speak.copilotkit.manifest.v1' &&
        Array.isArray(payload?.actions) &&
        Array.isArray(payload?.renderComponents) &&
        payload.renderComponents.some((component) => safeText(component?.surface || component?.id) === 'dialer'),
    },
    {
      name: 'widget-html',
      url: joinUrl(root, '/api/agent/widgets/speak-operator.html'),
      accept: 'text/html',
      responseType: 'text',
      validate: (text) =>
        /^<!doctype html>/i.test(safeText(text)) &&
        safeText(text).includes('<title>Speak</title>') &&
        safeText(text).includes('Library') &&
        safeText(text).includes('Dialer') &&
        safeText(text).includes('Playground') &&
        safeText(text).includes('render_speak_library'),
    },
    {
      name: 'host-client',
      url: joinUrl(root, '/api/agent/host-client.mjs'),
      accept: 'text/javascript',
      responseType: 'text',
      validate: (text) =>
        safeText(text).includes('speak.host-client.v1') &&
        safeText(text).includes('createSpeakAgentClient'),
    },
    {
      name: 'a2a-agent-card',
      url: joinUrl(root, '/.well-known/agent-card.json'),
      validate: validateA2aAgentCard,
    },
    {
      name: 'a2a-agent-json',
      url: joinUrl(root, '/.well-known/agent.json'),
      validate: validateA2aAgentCard,
    },
    {
      name: 'recent-calls',
      url: joinUrl(root, '/api/calls/recent?limit=1'),
      validate: (payload) => Array.isArray(payload?.calls),
    },
    {
      name: 'communication-threads',
      url: joinUrl(root, '/api/communication-threads?limit=1'),
      validate: (payload) => Array.isArray(payload?.threads),
    },
    {
      name: 'speak-options',
      url: joinUrl(root, '/api/agent-configs/speak-options'),
      validate: validateProviderOptions,
    },
    {
      name: 'hume-options',
      url: joinUrl(root, '/api/agent-configs/hume-options'),
      optionalLocal: true,
      validate: validateProviderOptions,
    },
    {
      name: 'inworld-options',
      url: joinUrl(root, '/api/agent-configs/inworld-options'),
      validate: validateProviderOptions,
    },
    {
      name: 'calltools-readiness',
      url: joinUrl(root, '/api/calltools/readiness'),
      optionalLocal: true,
      validate: (payload) =>
        payload?.provider === 'calltools' &&
        Object.prototype.hasOwnProperty.call(payload, 'runtimeReady') &&
        Object.prototype.hasOwnProperty.call(payload, 'campaignReady'),
    },
  ]
}

function validateA2aAgentCard(payload) {
  return Boolean(
    payload?.name === 'Speak' &&
      typeof payload?.url === 'string' &&
      payload.url.endsWith('/mcp') &&
      Array.isArray(payload?.skills) &&
      payload.skills.length > 0 &&
      Array.isArray(payload?.supportedInterfaces) &&
      payload.supportedInterfaces.some((item) => item?.protocolBinding === 'MCP_STREAMABLE_HTTP') &&
      Array.isArray(payload?.xSpeak?.discoveryAliases) &&
      payload.xSpeak.discoveryAliases.some((alias) => safeText(alias).endsWith('/.well-known/agent-card.json')),
  )
}

function liveAgentAdapterDrift(payload) {
  const drift = []
  const liveAdapters = payload?.agentAdapters && typeof payload.agentAdapters === 'object'
    ? payload.agentAdapters
    : {}
  for (const [key, expected] of Object.entries(contract.agentAdapters || {})) {
    const actual = safeText(liveAdapters[key])
    if (actual !== safeText(expected)) {
      drift.push(`agentAdapters.${key} ${actual || 'missing'} != ${safeText(expected)}`)
    }
  }
  return drift
}

function liveFrontendDrift(payload) {
  const drift = []
  const liveRoutes = Array.isArray(payload?.frontend?.routes) ? payload.frontend.routes : []
  const liveRouteById = new Map(liveRoutes.map((route) => [safeText(route?.id), route]))
  for (const route of contract.frontend?.routes || []) {
    const live = liveRouteById.get(route.id)
    if (!live) {
      drift.push(`frontend.routes.${route.id}:missing`)
      continue
    }
    for (const field of ['label', 'path', 'url', 'purpose']) {
      if (safeText(live?.[field]) !== safeText(route?.[field])) {
        drift.push(`frontend.routes.${route.id}:${field} ${safeText(live?.[field])} != ${safeText(route?.[field])}`)
      }
    }
  }

  const liveUiActions = Array.isArray(payload?.frontend?.uiActions) ? payload.frontend.uiActions : []
  const liveUiActionById = new Map(liveUiActions.map((action) => [safeText(action?.id), action]))
  for (const action of contract.frontend?.uiActions || []) {
    const live = liveUiActionById.get(action.id)
    if (!live) {
      drift.push(`frontend.uiActions.${action.id}:missing`)
      continue
    }
    for (const field of [
      'surface',
      'testId',
      'headlessEquivalent',
      'frequency',
      'requiresHumanConfirmation',
    ]) {
      if (safeText(live?.[field]) !== safeText(action?.[field])) {
        drift.push(`frontend.uiActions.${action.id}:${field} ${safeText(live?.[field])} != ${safeText(action?.[field])}`)
      }
    }
    for (const field of ['backendActions', 'proof']) {
      if (canonicalJson(live?.[field] || []) !== canonicalJson(action?.[field] || [])) {
        drift.push(`frontend.uiActions.${action.id}:${field} drift`)
      }
    }
  }
  return drift
}

async function runLiveProbe(probe) {
  try {
    const response = await fetch(probe.url, {
      headers: { Accept: probe.accept || 'application/json' },
    })
    const payload = probe.responseType === 'text'
      ? await response.text().catch(() => '')
      : await response.json().catch(() => null)
    const validation = normalizeProbeValidation(probe.validate(payload))
    const statusOk = probe.expectedStatus
      ? response.status === probe.expectedStatus
      : response.ok
    const ok = statusOk && validation.ok
    if (!ok && shouldSkipOptionalLocalProbe(probe)) {
      return {
        name: probe.name,
        ok: true,
        skippedOptional: true,
        status: response.status,
        url: probe.url,
        details: {
          reason: 'local provider-authenticated probe unavailable',
        },
        failure: '',
      }
    }
    return {
      name: probe.name,
      ok,
      status: response.status,
      url: probe.url,
      ...(validation.details ? { details: validation.details } : {}),
      failure: ok
        ? ''
        : validation.failure ||
          `live backend API probe failed for ${probe.name}: ${response.status} ${probe.url}`,
    }
  } catch (error) {
    if (shouldSkipOptionalLocalProbe(probe)) {
      return {
        name: probe.name,
        ok: true,
        skippedOptional: true,
        status: 0,
        url: probe.url,
        details: {
          reason: 'local provider-authenticated probe unavailable',
        },
        failure: '',
      }
    }
    return {
      name: probe.name,
      ok: false,
      status: 0,
      url: probe.url,
      failure: `live backend API probe failed for ${probe.name}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

function shouldSkipOptionalLocalProbe(probe) {
  if (!probe.optionalLocal) return false
  try {
    const url = new URL(probe.url)
    return ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
  } catch {
    return false
  }
}

function normalizeProbeValidation(value) {
  if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'ok')) {
    return {
      ok: Boolean(value.ok),
      failure: safeText(value.failure),
      details: value.details,
    }
  }
  return { ok: Boolean(value), failure: '', details: undefined }
}

function validateSurfaceManifest(payload, schemaVersion) {
  const surfaces = manifestSurfaceIds(payload)
  const missingSurfaces = ['library', 'dialer', 'configs'].filter((surface) => !surfaces.includes(surface))
  return {
    ok: payload?.schemaVersion === schemaVersion && missingSurfaces.length === 0,
    details: {
      schemaVersion: safeText(payload?.schemaVersion),
      surfaces,
      missingSurfaces,
    },
  }
}

function validateUiSnapshot(payload, surface) {
  const expectedRoute = contract.frontend?.routes?.find((route) => route.id === surface)
  const expectedCanonicalUrl = safeText(expectedRoute?.url)
  return {
    ok: payload?.schemaVersion === 'speak.ui-runtime-snapshot.v1' &&
      safeText(payload?.surface) === surface &&
      safeText(payload?.canonicalUrl) === expectedCanonicalUrl,
    details: {
      schemaVersion: safeText(payload?.schemaVersion),
      surface: safeText(payload?.surface),
      canonicalUrl: safeText(payload?.canonicalUrl),
      expectedCanonicalUrl,
    },
  }
}

function manifestSurfaceIds(payload) {
  const raw = Array.isArray(payload?.surfaces)
    ? payload.surfaces
    : Array.isArray(payload?.components)
      ? payload.components
      : Array.isArray(payload?.renderComponents)
        ? payload.renderComponents
        : []
  return raw
    .map((item) => safeText(
      typeof item === 'string'
        ? item
        : item?.surface || item?.surfaceId || item?.id || item?.name,
    ))
    .map((surface) => surface.replace(/^speak-/, ''))
    .filter(Boolean)
}

function liveActionDrift(payload) {
  const liveActions = Array.isArray(payload?.backend?.actions) ? payload.backend.actions : []
  const liveById = new Map(liveActions.map((action) => [safeText(action?.id), action]))
  const drift = []
  for (const action of actions) {
    const live = liveById.get(action.id)
    if (!live) {
      drift.push(`${action.id}:missing`)
      continue
    }
    if (safeText(live.method).toUpperCase() !== safeText(action.method).toUpperCase()) {
      drift.push(`${action.id}:method ${safeText(live.method)} != ${action.method}`)
    }
    if (safeText(live.path) !== safeText(action.path)) {
      drift.push(`${action.id}:path ${safeText(live.path)} != ${action.path}`)
    }
    drift.push(...liveActionMetadataDrift(action, live))
  }
  return drift
}

function liveActionMetadataDrift(local, live) {
  const drift = []
  for (const field of ['kind', 'risk', 'reasonNotCallable', 'requiresHumanConfirmation', 'failureContract']) {
    if (safeText(live?.[field]) !== safeText(local?.[field])) {
      drift.push(`${local.id}:${field} ${safeText(live?.[field])} != ${safeText(local?.[field])}`)
    }
  }
  if (Boolean(live?.callableByMcp) !== Boolean(local?.callableByMcp)) {
    drift.push(`${local.id}:callableByMcp ${Boolean(live?.callableByMcp)} != ${Boolean(local?.callableByMcp)}`)
  }
  if (Boolean(live?.externalSideEffect) !== Boolean(local?.externalSideEffect)) {
    drift.push(`${local.id}:externalSideEffect ${Boolean(live?.externalSideEffect)} != ${Boolean(local?.externalSideEffect)}`)
  }
  if (Boolean(live?.requiresConfiguredRuntime) !== Boolean(local?.requiresConfiguredRuntime)) {
    drift.push(`${local.id}:requiresConfiguredRuntime ${Boolean(live?.requiresConfiguredRuntime)} != ${Boolean(local?.requiresConfiguredRuntime)}`)
  }
  if (Boolean(live?.documentedInOpenApi) !== Boolean(local?.documentedInOpenApi)) {
    drift.push(`${local.id}:documentedInOpenApi ${Boolean(live?.documentedInOpenApi)} != ${Boolean(local?.documentedInOpenApi)}`)
  }
  for (const field of ['proof', 'preconditions']) {
    if (canonicalJson(live?.[field] || []) !== canonicalJson(local?.[field] || [])) {
      drift.push(`${local.id}:${field} drift`)
    }
  }
  for (const field of ['requestSchema', 'querySchema', 'responseSchema']) {
    if (canonicalJson(live?.[field] || null) !== canonicalJson(local?.[field] || null)) {
      drift.push(`${local.id}:${field} drift`)
    }
  }
  return drift
}

function liveOpenApiDrift(payload) {
  const livePaths = payload?.paths && typeof payload.paths === 'object' ? payload.paths : {}
  const localPaths = openApi.paths || {}
  const drift = []
  for (const [path, localMethods] of Object.entries(localPaths)) {
    const liveMethods = livePaths[path]
    if (!liveMethods || typeof liveMethods !== 'object') {
      drift.push(`${path}:missing`)
      continue
    }
    for (const [method, localOperation] of Object.entries(localMethods || {})) {
      const liveOperation = liveMethods[method]
      if (!liveOperation) {
        drift.push(`${method.toUpperCase()} ${path}:missing`)
        continue
      }
      if (safeText(liveOperation.operationId) !== safeText(localOperation?.operationId)) {
        drift.push(
          `${method.toUpperCase()} ${path}:operationId ${safeText(liveOperation.operationId)} != ${safeText(localOperation?.operationId)}`,
        )
      }
    }
  }
  return drift
}

function validateProviderOptions(payload) {
  return {
    ok: Array.isArray(payload?.eviVersions) &&
      Array.isArray(payload?.codexAuthModels) &&
      Array.isArray(payload?.languageModels) &&
      Array.isArray(payload?.voices) &&
      Array.isArray(payload?.functionTools),
    details: {
      eviVersions: Array.isArray(payload?.eviVersions) ? payload.eviVersions.length : 0,
      codexAuthModels: Array.isArray(payload?.codexAuthModels) ? payload.codexAuthModels.length : 0,
      languageModels: Array.isArray(payload?.languageModels) ? payload.languageModels.length : 0,
      voices: Array.isArray(payload?.voices) ? payload.voices.length : 0,
      functionTools: Array.isArray(payload?.functionTools) ? payload.functionTools.length : 0,
    },
  }
}

function contractVersionMatches(payload) {
  return safeText(payload?.contractVersion) === safeText(contract.contractVersion)
}

function contractVersionDetails(payload) {
  return {
    contractVersion: safeText(payload?.contractVersion),
    expectedContractVersion: safeText(contract.contractVersion),
  }
}

function joinUrl(root, suffix) {
  const cleanRoot = safeText(root).replace(/\/+$/, '')
  const cleanSuffix = safeText(suffix)
  if (!cleanSuffix) return cleanRoot
  if (cleanSuffix.startsWith('/')) return `${cleanRoot}${cleanSuffix}`
  return `${cleanRoot}/${cleanSuffix}`
}

function safeText(value) {
  return String(value ?? '').trim()
}

function latestGitCommitDate(file) {
  try {
    return safeText(
      execFileSync('git', ['log', '-1', '--format=%cs', '--', file], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    )
  } catch {
    return ''
  }
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(safeText(value))
}

function compareIsoDate(left, right) {
  return safeText(left).localeCompare(safeText(right))
}

async function verifyProfileActivationIsolation() {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), 'speak-profile-activation-'))
  const port = await availablePort()
  const base = `http://127.0.0.1:${port}`
  let output = ''
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      SPEAK_WORKSPACE_DATA_DIR: runtimeDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => {
    output = `${output}${chunk}`.slice(-4000)
  })
  child.stderr.on('data', (chunk) => {
    output = `${output}${chunk}`.slice(-4000)
  })

  try {
    await waitForIsolatedServer(`${base}/api/health`, child)
    const profiles = [
      profileFixture('profile-active-a', 'Active A'),
      profileFixture('profile-active-b', 'Active B'),
    ]

    await requestJson(`${base}/api/profiles`, {
      method: 'PUT',
      body: JSON.stringify({ profiles, activeProfileId: 'profile-active-a' }),
    })
    const explicitlyActivatedA = await requestJson(`${base}/api/profiles/active`, {
      method: 'PUT',
      body: JSON.stringify({ id: 'profile-active-a' }),
    })
    const staleBulkWrite = await requestJson(`${base}/api/profiles`, {
      method: 'PUT',
      body: JSON.stringify({
        profiles: [profiles[1]],
        activeProfileId: 'profile-active-b',
      }),
    })
    const afterStaleBulkWrite = await requestJson(`${base}/api/profiles`)
    const explicitlyActivatedB = await requestJson(`${base}/api/profiles/active`, {
      method: 'PUT',
      body: JSON.stringify({ id: 'profile-active-b' }),
    })
    const finalRead = await requestJson(`${base}/api/profiles`)

    const bulkPreservedActiveProfile =
      explicitlyActivatedA.activeProfileId === 'profile-active-a' &&
      staleBulkWrite.activeProfileId === 'profile-active-a' &&
      staleBulkWrite.profiles.some((profile) => profile.id === 'profile-active-a') &&
      afterStaleBulkWrite.activeProfileId === 'profile-active-a' &&
      afterStaleBulkWrite.profiles.some((profile) => profile.id === 'profile-active-a')
    const explicitEndpointChangedActiveProfile =
      explicitlyActivatedB.activeProfileId === 'profile-active-b' &&
      finalRead.activeProfileId === 'profile-active-b'

    return {
      ok: bulkPreservedActiveProfile && explicitEndpointChangedActiveProfile,
      bulkPreservedActiveProfile,
      explicitEndpointChangedActiveProfile,
      failure: bulkPreservedActiveProfile && explicitEndpointChangedActiveProfile
        ? ''
        : 'Profile activation isolation failed: stale bulk profile state changed activeProfileId or the explicit active endpoint did not persist',
    }
  } catch (error) {
    return {
      ok: false,
      bulkPreservedActiveProfile: false,
      explicitEndpointChangedActiveProfile: false,
      failure: `Profile activation isolation verifier failed: ${error instanceof Error ? error.message : String(error)}${output ? ` (${output.trim()})` : ''}`,
    }
  } finally {
    child.kill('SIGTERM')
    await waitForChildExit(child)
    await rm(runtimeDir, { force: true, recursive: true })
  }
}

function profileFixture(id, name) {
  return {
    id,
    name,
    updatedAt: '2026-07-14T23:00:00.000Z',
    config: { instructions: `${name} instructions` },
    testVariables: {},
  }
}

async function availablePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolve) => server.close(resolve))
  if (!port) throw new Error('Unable to reserve isolated backend port')
  return port
}

async function waitForIsolatedServer(url, child) {
  const startedAt = Date.now()
  const startupTimeoutMs = Number(
    process.env.SPEAK_QA_ISOLATED_BACKEND_START_TIMEOUT_MS || 60_000,
  )
  const deadline = startedAt + startupTimeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`isolated backend exited with code ${child.exitCode}`)
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) })
      if (response.ok) return
    } catch {
      // Continue until the bounded deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(
    `isolated backend did not become ready within ${Date.now() - startedAt}ms`,
  )
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(5000),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${new URL(url).pathname} failed (${response.status}): ${payload.error || 'unknown error'}`)
  }
  return payload
}

async function waitForChildExit(child) {
  if (child.exitCode !== null) return
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ])
  if (child.exitCode === null) child.kill('SIGKILL')
}

function canonicalJson(value) {
  return JSON.stringify(sortJson(value))
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!value || typeof value !== 'object') return value
  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      result[key] = sortJson(value[key])
      return result
    }, {})
}
