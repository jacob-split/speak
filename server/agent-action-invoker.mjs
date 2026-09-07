const ACTION_INVOCATION_SCHEMA_VERSION = 'speak.action-invocation.v1'
const REST_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
const BLOCKED_KINDS = new Set([
  'internal',
  'provider-webhook',
  'provider-websocket',
  'sse',
  'websocket',
])

export function callableRestAgentActions(contract) {
  return (contract?.backend?.actions || []).filter(isCallableRestAction)
}

export async function invokeSpeakAgentAction({
  contract,
  appRoot,
  actionId,
  path = {},
  query = {},
  body = {},
  authorizationMode,
  fetchImpl = globalThis.fetch,
} = {}) {
  const resolved = resolveSpeakActionRequest({
    contract,
    appRoot,
    actionId,
    path,
    query,
    body,
    authorizationMode,
  })

  if (!resolved.ok) {
    return resolved.envelope
  }

  const { action, request, authorizationMode: normalizedAuthorizationMode } = resolved
  try {
    const response = await fetchImpl(request.url, request.init)
    const payload = await parseFetchPayload(response)
    const proof = buildProofStatus(action.proof || [], payload)
    const envelope = baseInvocationEnvelope({
      action,
      authorizationMode: normalizedAuthorizationMode,
      request,
      status: response.status,
      contentType: response.headers?.get?.('content-type') || '',
    })
    return {
      ...envelope,
      ok: response.ok,
      proofExpected: action.proof || [],
      proofReturned: proof,
      ...(response.ok ? { result: payload } : { error: payload }),
    }
  } catch (error) {
    return {
      ...baseInvocationEnvelope({
        action,
        authorizationMode: normalizedAuthorizationMode,
        request,
        status: 502,
      }),
      ok: false,
      proofExpected: action.proof || [],
      proofReturned: buildProofStatus(action.proof || [], undefined),
      error: {
        error: 'action_invocation_failed',
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

export function resolveSpeakActionRequest({
  contract,
  appRoot,
  actionId,
  path = {},
  query = {},
  body = {},
  authorizationMode,
} = {}) {
  const action = (contract?.backend?.actions || []).find((candidate) => candidate.id === actionId)
  if (!action) {
    return invocationResolveError({
      status: 404,
      actionId,
      reason: 'unknown_action',
      message: `Unknown Speak action: ${actionId || '(missing)'}`,
    })
  }

  const authorization = normalizeAuthorizationMode(contract, authorizationMode)
  if (!authorization.ok) {
    return invocationResolveError({
      status: 400,
      actionId,
      action,
      reason: 'invalid_authorization_mode',
      message: authorization.message,
      details: {
        supportedModes: authorization.supportedModes,
        aliases: authorization.aliases,
      },
    })
  }

  if (!isCallableRestAction(action)) {
    return invocationResolveError({
      status: 403,
      actionId,
      action,
      authorizationMode: authorization.value,
      reason: 'action_not_callable',
      message:
        action.reasonNotCallable ||
        'This Speak action is not exposed through the generic action invoker.',
    })
  }

  const pathResult = resolvePathTemplate(action.path, path, action.pathSchema)
  if (!pathResult.ok) {
    return invocationResolveError({
      status: 400,
      actionId,
      action,
      authorizationMode: authorization.value,
      reason: 'missing_path_parameters',
      message: `Missing required path parameter(s): ${pathResult.missing.join(', ')}`,
      details: { missing: pathResult.missing },
    })
  }

  const root = normalizeRoot(appRoot || contract?.runtime?.appRoot || '')
  if (!root) {
    return invocationResolveError({
      status: 500,
      actionId,
      action,
      authorizationMode: authorization.value,
      reason: 'missing_app_root',
      message: 'Generic action invocation requires an appRoot.',
    })
  }

  const url = new URL(`${root}${pathResult.path}`)
  appendQuery(url, query)

  const init = {
    method: action.method,
    headers: {
      Accept: 'application/json',
    },
  }

  if (!['GET', 'DELETE'].includes(action.method)) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(enrichBodyWithAuthorization(body, authorization.value))
  }

  return {
    ok: true,
    action,
    authorizationMode: authorization.value,
    request: {
      method: action.method,
      url: url.toString(),
      path: pathResult.path,
      init,
      query: normalizePlainObject(query),
      body: init.body ? JSON.parse(init.body) : undefined,
    },
  }
}

function isCallableRestAction(action) {
  return (
    Boolean(action?.callableByMcp) &&
    REST_METHODS.has(action.method) &&
    !BLOCKED_KINDS.has(action.kind)
  )
}

function invocationResolveError({
  status,
  actionId,
  action,
  authorizationMode = 'confirm_each',
  reason,
  message,
  details = {},
}) {
  return {
    ok: false,
    envelope: {
      schemaVersion: ACTION_INVOCATION_SCHEMA_VERSION,
      ok: false,
      actionId: action?.id || actionId || '',
      method: action?.method || '',
      path: action?.path || '',
      risk: action?.risk || '',
      kind: action?.kind || '',
      externalSideEffect: Boolean(action?.externalSideEffect),
      requiresHumanConfirmation: action?.requiresHumanConfirmation || '',
      authorizationMode,
      proofExpected: action?.proof || [],
      proofReturned: buildProofStatus(action?.proof || [], undefined),
      failureContract: action?.failureContract || '',
      error: {
        error: reason,
        message,
        ...details,
      },
      transport: {
        kind: 'speak-contract-rest',
        status,
      },
    },
  }
}

function baseInvocationEnvelope({
  action,
  authorizationMode,
  request,
  status,
  contentType = '',
}) {
  return {
    schemaVersion: ACTION_INVOCATION_SCHEMA_VERSION,
    actionId: action.id,
    title: action.title,
    method: action.method,
    path: action.path,
    resolvedPath: request.path,
    url: request.url,
    kind: action.kind,
    risk: action.risk,
    externalSideEffect: Boolean(action.externalSideEffect),
    requiresHumanConfirmation: action.requiresHumanConfirmation || '',
    authorizationMode,
    failureContract: action.failureContract || '',
    transport: {
      kind: 'speak-contract-rest',
      status,
      contentType,
    },
  }
}

function normalizeAuthorizationMode(contract, authorizationMode) {
  const modeContract = contract?.mcpGeneration?.authorizationMode || {}
  const defaultMode = modeContract.default || 'confirm_each'
  const supportedModes = (modeContract.modes || []).map((mode) => mode.id)
  const modeSet = new Set(supportedModes)
  const aliases = modeContract.aliases || {}
  const raw = typeof authorizationMode === 'string' ? authorizationMode.trim() : ''
  if (!raw) {
    return { ok: true, value: defaultMode }
  }
  const normalized = aliases[raw] || raw
  if (!modeSet.has(normalized)) {
    return {
      ok: false,
      supportedModes,
      aliases,
      message: `Unsupported authorizationMode: ${raw}`,
    }
  }
  return { ok: true, value: normalized }
}

function resolvePathTemplate(template, pathParams, pathSchema) {
  const missing = new Set()
  ;(pathSchema?.required || []).forEach((key) => {
    if (pathParams?.[key] === undefined || pathParams?.[key] === null || pathParams?.[key] === '') {
      missing.add(key)
    }
  })
  const resolved = String(template || '').replace(/\{([^}]+)\}/g, (_match, key) => {
    const value = pathParams?.[key]
    if (value === undefined || value === null || value === '') {
      missing.add(key)
      return ''
    }
    return encodeURIComponent(String(value))
  })
  return missing.size > 0
    ? { ok: false, missing: [...missing] }
    : { ok: true, path: resolved }
}

function normalizeRoot(root) {
  const value = String(root || '').trim()
  if (!value) return ''
  return value.endsWith('/') ? value.slice(0, -1) : value
}

function appendQuery(url, query) {
  Object.entries(normalizePlainObject(query)).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      value
        .filter((item) => item !== undefined && item !== null)
        .forEach((item) => url.searchParams.append(key, String(item)))
      return
    }
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value))
    }
  })
}

function normalizePlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function enrichBodyWithAuthorization(body, authorizationMode) {
  const source = normalizePlainObject(body)
  return {
    ...source,
    authorizationMode,
  }
}

async function parseFetchPayload(response) {
  const contentType = response.headers?.get?.('content-type') || ''
  if (contentType.includes('application/json')) {
    return response.json()
  }
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    return { text }
  }
}

function buildProofStatus(proofFields, payload) {
  return proofFields.map((field) => ({
    field,
    present: hasProofField(payload, field),
  }))
}

function hasProofField(payload, field) {
  if (payload === undefined || payload === null) return false
  const path = String(field || '').split('=')[0].trim()
  if (!path || /\s/.test(path)) return false
  return hasPath(payload, path.split('.'))
}

function hasPath(value, parts) {
  if (parts.length === 0) {
    return value !== undefined && value !== null
  }
  const [part, ...rest] = parts
  const isArray = part.endsWith('[]')
  const key = isArray ? part.slice(0, -2) : part
  const next = key ? value?.[key] : value
  if (isArray) {
    return Array.isArray(next) && next.some((item) => hasPath(item, rest))
  }
  return hasPath(next, rest)
}
