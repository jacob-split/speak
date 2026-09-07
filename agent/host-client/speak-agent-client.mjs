export const speakHostClientSchemaVersion = 'speak.host-client.v1'

export function createSpeakAgentClient(options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl || inferBaseUrl())
  const fetchImpl = options.fetch || globalThis.fetch
  const credentials = options.credentials
  const staticHeaders = {
    Accept: 'application/json',
    ...(options.headers || {}),
  }
  let authorizationMode = options.authorizationMode || 'confirm_each'
  let capabilitiesCache = null

  const client = {
    schemaVersion: speakHostClientSchemaVersion,
    get baseUrl() {
      return baseUrl
    },
    endpoints: {
      capabilities: endpoint(baseUrl, '/api/agent/capabilities'),
      readiness: endpoint(baseUrl, '/api/agent/readiness.json'),
      chatgptApp: endpoint(baseUrl, '/api/agent/chatgpt-app.json'),
      generativeUi: endpoint(baseUrl, '/api/agent/generative-ui.json'),
      uiAdapterKit: endpoint(baseUrl, '/api/agent/ui-adapter-kit.json'),
      uiSnapshot: endpoint(baseUrl, '/api/agent/ui-snapshot.json'),
      mcpUi: endpoint(baseUrl, '/api/agent/mcp-ui.json'),
      agUi: endpoint(baseUrl, '/api/agent/ag-ui.json'),
      a2ui: endpoint(baseUrl, '/api/agent/a2ui.json'),
      actionInvocation: endpoint(baseUrl, '/api/agent/actions/{actionId}/invoke'),
      openapi: endpoint(baseUrl, '/api/agent/openapi.json'),
      acp: endpoint(baseUrl, '/api/agent/acp'),
      a2aAgentCard: endpoint(baseUrl, '/.well-known/agent-card.json'),
      a2aAgentJson: endpoint(baseUrl, '/.well-known/agent.json'),
      aiSdk: endpoint(baseUrl, '/api/agent/ai-sdk.json'),
      jsonRender: endpoint(baseUrl, '/api/agent/json-render.json'),
      copilotKit: endpoint(baseUrl, '/api/agent/copilotkit.json'),
      widgetHtml: endpoint(baseUrl, '/api/agent/widgets/speak-operator.html'),
      hostClient: endpoint(baseUrl, '/api/agent/host-client.mjs'),
    },
    get authorizationMode() {
      return authorizationMode
    },
    setAuthorizationMode(value) {
      authorizationMode = value || authorizationMode
      return authorizationMode
    },
    capabilities: () => cachedCapabilities(),
    readiness: () => getJson('/api/agent/readiness.json'),
    chatgptApp: () => getJson('/api/agent/chatgpt-app.json'),
    generativeUi: () => getJson('/api/agent/generative-ui.json'),
    uiAdapterKit: () => getJson('/api/agent/ui-adapter-kit.json'),
    mcpUi: () => getJson('/api/agent/mcp-ui.json'),
    agUi: () => getJson('/api/agent/ag-ui.json'),
    a2ui: () => getJson('/api/agent/a2ui.json'),
    openapi: () => getJson('/api/agent/openapi.json'),
    acp: () => getJson('/api/agent/acp'),
    a2aAgentCard: () => getJson('/.well-known/agent-card.json'),
    a2aAgentJson: () => getJson('/.well-known/agent.json'),
    aiSdk: () => getJson('/api/agent/ai-sdk.json'),
    jsonRender: () => getJson('/api/agent/json-render.json'),
    copilotKit: () => getJson('/api/agent/copilotkit.json'),
    async uiSnapshot({ surface = 'dialer', limit = 12, authorizationMode: mode } = {}) {
      const params = new URLSearchParams({
        surface,
        limit: String(limit),
        authorizationMode: mode || authorizationMode,
      })
      return getJson(`/api/agent/ui-snapshot.json?${params.toString()}`)
    },
    async invoke(actionId, payload = {}) {
      const body = await normalizeInvocationPayload({
        actionId,
        payload,
        authorizationMode,
        capabilities: cachedCapabilities,
      })
      return postJson(
        `/api/agent/actions/${encodeURIComponent(actionId)}/invoke`,
        body,
        { allowHttpError: true },
      )
    },
    invokeAction(actionId, payload = {}) {
      return this.invoke(actionId, payload)
    },
    action(actionId) {
      return {
        invoke: (payload = {}) => client.invoke(actionId, payload),
      }
    },
    async callTool(name, args = {}) {
      if (name === 'render_speak_dialer') {
        return client.uiSnapshot({ ...args, surface: 'dialer' })
      }
      if (name === 'render_speak_configs') {
        return client.uiSnapshot({ ...args, surface: 'configs' })
      }
      if (name === 'fetch') {
        return client.fetchItem(args.id || args.uri || '')
      }
      return client.invoke(name, args)
    },
    async fetchItem(id) {
      const contract = await cachedCapabilities()
      if (String(id).startsWith('action:')) {
        const actionId = String(id).slice('action:'.length)
        const action = contract.backend?.actions?.find((item) => item.id === actionId)
        return {
          id,
          title: action?.title || actionId,
          text: JSON.stringify(action || {}, null, 2),
          url: action?.url || '',
          metadata: { kind: 'action' },
        }
      }
      const workspace = await getJson('/api/workspace')
      if (String(id).startsWith('lead:')) {
        const leadId = String(id).slice('lead:'.length)
        const lead = workspace.leads?.find((item) => item.id === leadId)
        return {
          id,
          title: lead?.company || lead?.name || leadId,
          text: JSON.stringify(lead || {}, null, 2),
          url: contract.frontend?.routes?.find((route) => route.id === 'dialer')?.url || '',
          metadata: { kind: 'lead' },
        }
      }
      if (String(id).startsWith('profile:')) {
        const profileId = String(id).slice('profile:'.length)
        const profile = workspace.profiles?.find((item) => item.id === profileId)
        return {
          id,
          title: profile?.name || profileId,
          text: JSON.stringify(profile || {}, null, 2),
          url: contract.frontend?.routes?.find((route) => route.id === 'configs')?.url || '',
          metadata: { kind: 'profile' },
        }
      }
      return {
        id,
        title: id || 'Speak item',
        text: 'No Speak item matched this id.',
        url: client.endpoints.capabilities,
        metadata: { kind: 'unknown' },
      }
    },
    hydrateWidget(target, hydrateOptions = {}) {
      return hydrateSpeakWidget(target, client, hydrateOptions)
    },
    connectWidget(target, bridgeOptions = {}) {
      return connectSpeakWidget(target, client, bridgeOptions)
    },
  }

  async function cachedCapabilities() {
    if (!capabilitiesCache) capabilitiesCache = getJson('/api/agent/capabilities')
    return capabilitiesCache
  }

  function getJson(path) {
    return requestJson(path)
  }

  function postJson(path, body, requestOptions = {}) {
    return requestJson(path, {
      method: 'POST',
      body,
      allowHttpError: Boolean(requestOptions.allowHttpError),
    })
  }

  async function requestJson(path, requestOptions = {}) {
    if (typeof fetchImpl !== 'function') {
      throw new Error('Speak host client requires a fetch implementation.')
    }
    const headers = {
      ...staticHeaders,
      ...(requestOptions.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    }
    const response = await fetchImpl(endpoint(baseUrl, path), {
      method: requestOptions.method || 'GET',
      credentials,
      headers,
      body:
        requestOptions.body === undefined
          ? undefined
          : JSON.stringify(requestOptions.body),
    })
    const payload = await parseJsonResponse(response)
    if (!response.ok && !requestOptions.allowHttpError) {
      const error = new Error(payload?.error || response.statusText || 'Speak request failed')
      error.status = response.status
      error.payload = payload
      throw error
    }
    return payload
  }

  return client
}

export async function hydrateSpeakWidget(target, clientOrOptions = {}, options = {}) {
  const client = isSpeakClient(clientOrOptions)
    ? clientOrOptions
    : createSpeakAgentClient(clientOrOptions)
  const frame = resolveWidgetFrame(target, { create: true, widgetUrl: client.endpoints.widgetHtml })
  if (!frame) throw new Error('Unable to resolve Speak widget iframe target.')
  if (options.setSrc !== false && frame.src !== client.endpoints.widgetHtml) {
    frame.src = client.endpoints.widgetHtml
  }
  await waitForFrameLoad(frame, options.timeoutMs || 2000).catch(() => {})
  const snapshot =
    options.snapshot ||
    (await client.uiSnapshot({
      surface: options.surface || 'dialer',
      limit: options.limit || 12,
      authorizationMode: options.authorizationMode || client.authorizationMode,
    }))
  postToWidget(frame, snapshot.genericHost?.hydrateMessage || {
    type: 'speak:hydrate',
    source: 'host',
    schemaVersion: 'speak.widget-postmessage.v1',
    detail: {
      structuredContent: snapshot.structuredContent,
      _meta: snapshot._meta,
      authorizationMode: snapshot.authorizationMode,
    },
  }, client.baseUrl)
  return snapshot
}

export function connectSpeakWidget(target, clientOrOptions = {}, options = {}) {
  const client = isSpeakClient(clientOrOptions)
    ? clientOrOptions
    : createSpeakAgentClient(clientOrOptions)
  const frame = resolveWidgetFrame(target, { create: false })
  if (!frame) throw new Error('Unable to resolve Speak widget iframe target.')
  const scope = options.window || globalThis.window
  if (!scope?.addEventListener) {
    throw new Error('connectSpeakWidget requires a browser window or compatible event target.')
  }

  const listener = async (event) => {
    if (event.source !== frame.contentWindow) return
    const message = event.data || {}
    if (message.source !== 'speak-widget' || !String(message.type || '').startsWith('speak:')) {
      return
    }
    const detail = message.detail || {}
    if (message.type === 'speak:ready') options.onReady?.(detail, message)
    if (message.type === 'speak:state') options.onState?.(detail, message)
    if (message.type === 'speak:follow-up') options.onFollowUp?.(detail, message)
    if (message.type === 'speak:open-external') options.onOpenExternal?.(detail, message)
    if (message.type === 'speak:display-mode-request') {
      options.onDisplayModeRequest?.(detail, message)
    }
    if (message.type !== 'speak:tool-call') return

    try {
      const result = await client.callTool(detail.name, detail.arguments || {})
      postToolResult(frame, result, client.baseUrl)
      options.onToolResult?.(result, message)
    } catch (error) {
      const payload = {
        type: 'speak:tool-result',
        source: 'host',
        schemaVersion: 'speak.widget-postmessage.v1',
        detail: {
          error: error instanceof Error ? error.message : String(error),
        },
      }
      postToWidget(frame, payload, client.baseUrl)
      options.onToolError?.(error, message)
    }
  }

  scope.addEventListener('message', listener)
  return {
    dispose() {
      scope.removeEventListener('message', listener)
    },
    hydrate(hydrateOptions = {}) {
      return hydrateSpeakWidget(frame, client, hydrateOptions)
    },
  }
}

async function normalizeInvocationPayload({
  actionId,
  payload,
  authorizationMode,
  capabilities,
}) {
  const source = payload && typeof payload === 'object' ? { ...payload } : {}
  if (source.path || source.query || source.body) {
    return {
      path: source.path || {},
      query: source.query || {},
      body: source.body || {},
      authorizationMode: source.authorizationMode || authorizationMode,
    }
  }

  const contract = await capabilities()
  const action = contract.backend?.actions?.find((item) => item.id === actionId)
  const path = {}
  const query = {}
  const body = {}
  const pathKeys = new Set([
    ...(action?.pathSchema?.required || []),
    ...Object.keys(action?.pathSchema?.properties || {}),
  ])
  const queryKeys = new Set(Object.keys(action?.querySchema?.properties || {}))
  const auth = source.authorizationMode || authorizationMode
  delete source.authorizationMode

  Object.entries(source).forEach(([key, value]) => {
    if (pathKeys.has(key)) {
      path[key] = value
      return
    }
    if (queryKeys.has(key) || action?.method === 'GET') {
      query[key] = value
      return
    }
    body[key] = value
  })

  return {
    path,
    query,
    body,
    authorizationMode: auth,
  }
}

function postToolResult(frame, result, targetOrigin) {
  const isSnapshot = result?.schemaVersion === 'speak.ui-runtime-snapshot.v1'
  postToWidget(frame, {
    type: 'speak:tool-result',
    source: 'host',
    schemaVersion: 'speak.widget-postmessage.v1',
    detail: isSnapshot
      ? {
          structuredContent: result.structuredContent,
          _meta: result._meta,
          authorizationMode: result.authorizationMode,
        }
      : { result },
  }, targetOrigin)
}

function resolveWidgetFrame(target, { create, widgetUrl } = {}) {
  if (!target && !create) return null
  if (isIframe(target)) return target
  const root = typeof target === 'string' ? globalThis.document?.querySelector(target) : target
  if (!root) return null
  const existing = root.querySelector?.('iframe[data-speak-widget]')
  if (existing) return existing
  if (!create || !globalThis.document?.createElement) return null
  const frame = globalThis.document.createElement('iframe')
  frame.dataset.speakWidget = 'true'
  frame.title = 'Speak'
  frame.src = widgetUrl || ''
  frame.style.width = '100%'
  frame.style.minHeight = '520px'
  frame.style.border = '0'
  frame.setAttribute('allow', 'clipboard-read; clipboard-write')
  root.appendChild(frame)
  return frame
}

function postToWidget(frame, message, targetOrigin) {
  const origin = safeOrigin(targetOrigin) || '*'
  frame.contentWindow?.postMessage(message, origin)
}

function waitForFrameLoad(frame, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      frame.removeEventListener?.('load', done)
      resolve()
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      frame.removeEventListener?.('load', done)
      reject(new Error('Speak widget iframe load timed out.'))
    }, timeoutMs)
    frame.addEventListener?.('load', done, { once: true })
    if (frame.contentWindow && frame.src) setTimeout(done, 0)
  })
}

async function parseJsonResponse(response) {
  const text = await response.text()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return { text }
  }
}

function inferBaseUrl() {
  try {
    const url = new URL(import.meta.url)
    const marker = '/api/agent/host-client.mjs'
    if (url.pathname.endsWith(marker)) {
      return `${url.origin}${url.pathname.slice(0, -marker.length)}`
    }
  } catch {
    // Fall through to browser location.
  }
  return globalThis.location?.origin || ''
}

function normalizeBaseUrl(value) {
  const raw = String(value || '').replace(/\/+$/g, '')
  return raw.replace(/\/api\/agent\/host-client\.mjs$/g, '')
}

function endpoint(baseUrl, path) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${baseUrl}${normalizedPath}`
}

function isSpeakClient(value) {
  return value?.schemaVersion === speakHostClientSchemaVersion && typeof value.invoke === 'function'
}

function isIframe(value) {
  return Boolean(value?.contentWindow && String(value?.tagName || '').toUpperCase() === 'IFRAME')
}

function safeOrigin(value) {
  try {
    return new URL(value).origin
  } catch {
    return ''
  }
}

export default {
  schemaVersion: speakHostClientSchemaVersion,
  createSpeakAgentClient,
  hydrateSpeakWidget,
  connectSpeakWidget,
}
