import { createHash } from 'node:crypto'
import {
  cleanObject,
  DEFAULT_CODEX_AUTH_MODEL,
  DEFAULT_CODEX_FAST_MODE,
  DEFAULT_CODEX_REASONING_EFFORT,
  getCodexAuthModel,
  isCodexAuthLanguageModel,
  isInworldRuntime,
} from './runtime-config.mjs'
import { speakOpenAiToolDefinitions } from './hume-tools.mjs'
import { stripHumeCodexPromptContext } from './hume-session.mjs'

const SESSION_CONTEXT_TTL_MS = 4 * 60 * 60 * 1000
const MAX_SESSION_CONTEXTS = 250
const MAX_TOOL_ROUNDS = 3
const MAX_LATEST_TURN_PROSODY_MEASURES = 6
const DEFAULT_STREAM_IDLE_AFTER_OUTPUT_MS = 2500
const DEFAULT_STREAM_INITIAL_RESPONSE_MS = 45000
const DEFAULT_CODEX_PROXY_READINESS_TIMEOUT_MS = 5000
const DEFAULT_CODEX_PROXY_READINESS_CACHE_MS = 30_000
const CODEX_CLM_COALESCING_TTL_MS = 60_000
const MAX_CODEX_CLM_COALESCED_REQUESTS = 128
const MAX_CODEX_CLM_REPLAY_BYTES = 512 * 1024
const codexSessionContexts = new Map()
const codexClmCoalescedRequests = new Map()
let codexClmToolExecutor = null
let codexClmTimingObserver = null
let codexClmRequestSequence = 0
const codexProxyReadinessCache = new Map()
const codexProxyReadinessInFlight = new Map()
const codexProxyReadinessGeneration = new Map()
const CODEX_CLM_DEVELOPER_INSTRUCTIONS = [
  'You are the language model inside a Speak voice session.',
  'The system prompt supplied by Speak is the active agent definition and highest-level task context. Follow it without assuming the agent is sales, support, test, or any specific workflow unless that prompt or the runtime context says so.',
  'Keep spoken responses concise, natural, and suitable for text-to-speech. Do not read internal tags, variable names, tool schemas, or implementation details aloud.',
  'Use the provided tool calls when an external action or lookup is required. Do not claim a text, email, portal link, contact update, or hang-up succeeded until the corresponding tool result says it did.',
  'If runtime context or contact data conflicts with prior conversation text, prefer the latest Speak runtime context.',
].join('\n')

const DEFAULT_CODEX_AUTH_MODELS = [
  {
    value: 'gpt-5.6-sol',
    label: 'GPT 5.6 Sol',
    description: 'Codex-auth GPT 5.6 Sol model.',
  },
  {
    value: 'gpt-5.6-terra',
    label: 'GPT 5.6 Terra',
    description: 'Codex-auth GPT 5.6 Terra model.',
  },
  {
    value: 'gpt-5.6-luna',
    label: 'GPT 5.6 Luna',
    description: 'Codex-auth GPT 5.6 Luna model.',
  },
  {
    value: 'gpt-5.5',
    label: 'GPT 5.5',
    description: 'Codex-auth frontier model.',
  },
  {
    value: 'gpt-5.4',
    label: 'GPT 5.4',
    description: 'Codex-auth general coding model.',
  },
  {
    value: 'gpt-5.4-mini',
    label: 'GPT 5.4 Mini',
    description: 'Codex-auth small model.',
  },
  {
    value: 'gpt-5.3-codex-spark',
    label: 'GPT 5.3 Codex Spark',
    description: 'Codex-auth fast coding model.',
  },
]

function codexProxyBaseUrl() {
  return (process.env.CODEX_AUTH_PROXY_BASE_URL || 'http://127.0.0.1:48765/v1')
    .replace(/\/+$/g, '')
}

export class CodexClmReadinessError extends Error {
  constructor(
    message,
    {
      code = 'readiness_unavailable',
      model = '',
      modelAvailable,
      resetAt = '',
      status = 503,
    } = {},
  ) {
    super(message)
    this.name = 'CodexClmReadinessError'
    this.code = code
    this.status = status
    this.dependency = 'codex_auth_proxy'
    this.retryable = true
    this.model = model
    if (typeof modelAvailable === 'boolean') {
      this.modelAvailable = modelAvailable
    }
    if (resetAt) this.resetAt = resetAt
  }
}

export async function assertCodexClmRuntimeReady(
  config = {},
  {
    cacheOnly = false,
    cacheTtlMs = codexProxyReadinessCacheMs(),
    fetchImpl = globalThis.fetch,
    forceRefresh = false,
    now = Date.now,
    timeoutMs = codexProxyReadinessTimeoutMs(),
  } = {},
) {
  if (!isCodexAuthLanguageModel(config) || isInworldRuntime(config)) {
    return {
      ok: true,
      required: false,
      dependency: 'codex_auth_proxy',
    }
  }

  const model = getCodexAuthModel(config)
  const baseUrl = codexProxyBaseUrl()
  const observedAt = typeof now === 'function' ? Number(now()) : Date.now()
  const normalizedCacheTtlMs = Math.max(0, Number(cacheTtlMs) || 0)
  const readinessKey = `${baseUrl}\u0000${model}`
  const cachedCandidate = codexProxyReadinessCache.get(readinessKey)
  const cachedReadiness =
    !forceRefresh &&
    normalizedCacheTtlMs > 0 &&
    cachedCandidate?.checkedAt + normalizedCacheTtlMs > observedAt
      ? cachedCandidate
      : null
  if (cachedReadiness) {
    return {
      ok: true,
      required: true,
      dependency: 'codex_auth_proxy',
      model,
      allowed: true,
      code: 'ready',
      modelAvailable: true,
      latencyMs: cachedReadiness.latencyMs,
      proxyCached: cachedReadiness.proxyCached,
      cached: true,
    }
  }
  if (cacheOnly) {
    throw new CodexClmReadinessError(
      'Codex-auth voice runtime is unavailable: Speak does not have a fresh local readiness proof. Retry after the background readiness monitor is healthy.',
      { model },
    )
  }

  const existingReadinessRequest = codexProxyReadinessInFlight.get(readinessKey)
  let readinessRequest =
    forceRefresh
      ? existingReadinessRequest?.forceRefresh === true
        ? existingReadinessRequest.promise
        : null
      : existingReadinessRequest?.promise || null
  let requestGeneration = readinessRequest
    ? existingReadinessRequest.generation
    : codexProxyReadinessGeneration.get(readinessKey) || 0
  if (!readinessRequest) {
    if (forceRefresh) {
      requestGeneration += 1
      codexProxyReadinessGeneration.set(readinessKey, requestGeneration)
      codexProxyReadinessCache.delete(readinessKey)
    }
    readinessRequest = readCodexProxyReadiness({
      baseUrl,
      fetchImpl,
      forceRefresh,
      model,
      timeoutMs,
    })
    codexProxyReadinessInFlight.set(readinessKey, {
      forceRefresh,
      generation: requestGeneration,
      promise: readinessRequest,
    })
  }

  let readiness
  try {
    readiness = await readinessRequest
  } finally {
    if (codexProxyReadinessInFlight.get(readinessKey)?.promise === readinessRequest) {
      codexProxyReadinessInFlight.delete(readinessKey)
    }
  }
  if (
    normalizedCacheTtlMs > 0 &&
    (codexProxyReadinessGeneration.get(readinessKey) || 0) === requestGeneration
  ) {
    const checkedAt = typeof now === 'function' ? Number(now()) : Date.now()
    codexProxyReadinessCache.set(readinessKey, {
      ...readiness,
      baseUrl,
      checkedAt,
      model,
    })
  }

  return {
    ok: true,
    required: true,
    dependency: 'codex_auth_proxy',
    model,
    allowed: true,
    code: 'ready',
    modelAvailable: true,
    latencyMs: readiness.latencyMs,
    proxyCached: readiness.proxyCached,
    cached: false,
  }
}

export function resetCodexClmReadinessCacheForTests() {
  codexProxyReadinessCache.clear()
  codexProxyReadinessInFlight.clear()
  codexProxyReadinessGeneration.clear()
}

export function resetCodexClmCoalescingForTests() {
  codexClmCoalescedRequests.clear()
}

async function readCodexProxyReadiness({
  baseUrl,
  fetchImpl,
  forceRefresh,
  model,
  timeoutMs,
}) {
  const startedAt = performance.now()
  const readinessUrl = new URL(`${baseUrl}/readiness`)
  readinessUrl.searchParams.set('model', model)
  if (forceRefresh) readinessUrl.searchParams.set('force', '1')
  let response
  try {
    response = await fetchImpl(readinessUrl, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(
        positiveNumber(timeoutMs, DEFAULT_CODEX_PROXY_READINESS_TIMEOUT_MS),
      ),
    })
  } catch (error) {
    const reason = error?.name === 'TimeoutError' ? 'timed out' : 'could not be reached'
    throw new CodexClmReadinessError(
      `Codex-auth voice runtime is unavailable: Speak's local Codex proxy ${reason}. Retry after the Codex proxy is healthy.`,
      { model },
    )
  }

  const payload = await response.json().catch(() => null)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new CodexClmReadinessError(
      `Codex-auth voice runtime is unavailable: Speak's local Codex proxy returned an invalid readiness response (HTTP ${response.status}). Retry after the Codex proxy is healthy.`,
      { model },
    )
  }

  const code = normalizeCodexProxyReadinessCode(payload.code, response.status)
  const resetAt = sanitizeCodexProxyResetAt(payload.reset_at)
  const payloadModel = normalizeCodexProxyModel(payload.model)
  const selectedModel = normalizeCodexProxyModel(model)
  const modelAvailable = payload.model_available === true

  if (code === 'usage_limit_reached') {
    const resetMessage = resetAt ? ` The provider reports a reset at ${resetAt}.` : ''
    throw new CodexClmReadinessError(
      `Codex-auth voice runtime has reached its usage limit.${resetMessage} Retry after usage is available.`,
      {
        code,
        model,
        modelAvailable,
        resetAt,
        status: 429,
      },
    )
  }

  if (code === 'codex_reauth_required') {
    throw new CodexClmReadinessError(
      'Codex-auth voice runtime authentication needs to be refreshed before a voice session can start.',
      { code, model, modelAvailable, status: 503 },
    )
  }

  if (
    code === 'model_unavailable' ||
    payload.model_available === false ||
    (payloadModel && payloadModel !== selectedModel)
  ) {
    throw new CodexClmReadinessError(
      `Codex-auth voice runtime is unavailable: Speak's local Codex proxy does not currently expose ${model}. Refresh the Codex proxy authentication or choose an available model.`,
      { code: 'model_unavailable', model, modelAvailable: false, status: 503 },
    )
  }

  if (
    !response.ok ||
    code !== 'ready' ||
    payload.ok !== true ||
    payload.allowed !== true ||
    !modelAvailable ||
    payloadModel !== selectedModel
  ) {
    throw new CodexClmReadinessError(
      `Codex-auth voice runtime is unavailable: Speak's local Codex proxy readiness check returned HTTP ${response.status}. Retry after the Codex proxy is healthy.`,
      { code: 'readiness_unavailable', model, modelAvailable, status: 503 },
    )
  }

  return {
    proxyCached: payload.cached === true,
    latencyMs: Number(Math.max(0, performance.now() - startedAt).toFixed(3)),
  }
}

function codexProxyReadinessTimeoutMs() {
  return positiveNumber(
    process.env.CODEX_AUTH_PROXY_READINESS_TIMEOUT_MS,
    DEFAULT_CODEX_PROXY_READINESS_TIMEOUT_MS,
  )
}

function codexProxyReadinessCacheMs() {
  return positiveNumber(
    process.env.CODEX_AUTH_PROXY_READINESS_CACHE_MS,
    DEFAULT_CODEX_PROXY_READINESS_CACHE_MS,
  )
}

function normalizeCodexProxyModel(value) {
  return String(value || '').trim().replace(/^openai\//, '')
}

function normalizeCodexProxyReadinessCode(value, status) {
  const code = String(value || '').trim().toLowerCase()
  if (
    [
      'ready',
      'usage_limit_reached',
      'codex_reauth_required',
      'model_unavailable',
      'readiness_unavailable',
    ].includes(code)
  ) {
    return code
  }
  if (Number(status) === 429) return 'usage_limit_reached'
  if ([401, 403].includes(Number(status))) return 'codex_reauth_required'
  return 'readiness_unavailable'
}

function sanitizeCodexProxyResetAt(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
}

export function setCodexClmToolExecutor(executor) {
  codexClmToolExecutor = typeof executor === 'function' ? executor : null
}

export function setCodexClmTimingObserver(observer) {
  codexClmTimingObserver = typeof observer === 'function' ? observer : null
}

function reportCodexClmTiming({
  customSessionId,
  name,
  requestStartedAt,
  observedAt = performance.now(),
  round = 0,
  requestSequence,
  forwardingOverheadMs,
}) {
  if (!codexClmTimingObserver) return
  const event = cleanObject({
    customSessionId,
    name,
    at: new Date().toISOString(),
    round,
    requestSequence,
    elapsedMs: Number(
      Math.max(0, observedAt - requestStartedAt).toFixed(3),
    ),
    forwardingOverheadMs: Number.isFinite(forwardingOverheadMs)
      ? Number(Math.max(0, forwardingOverheadMs).toFixed(3))
      : undefined,
  })
  try {
    codexClmTimingObserver(event)
  } catch {
    // Diagnostics must never interrupt a live voice response.
  }
}

export function rememberCodexClmSessionContext(
  customSessionId,
  {
    systemPrompt,
    context,
    variables,
    codexReasoningEffort,
    codexFastMode,
    promptExpansionEnabled,
  } = {},
) {
  const sessionId = String(customSessionId || '').trim()
  if (!sessionId) return

  pruneCodexSessionContexts()
  codexSessionContexts.set(sessionId, {
    systemPrompt: String(systemPrompt || '').trim(),
    context: String(context || '').trim(),
    variables:
      variables && typeof variables === 'object' && !Array.isArray(variables)
        ? { ...variables }
        : {},
    codexReasoningEffort:
      normalizeCodexReasoningEffort(codexReasoningEffort) ||
      DEFAULT_CODEX_REASONING_EFFORT,
    codexFastMode:
      typeof codexFastMode === 'boolean' ? codexFastMode : DEFAULT_CODEX_FAST_MODE,
    promptExpansionEnabled: Boolean(promptExpansionEnabled),
    expiresAt: Date.now() + SESSION_CONTEXT_TTL_MS,
  })

  while (codexSessionContexts.size > MAX_SESSION_CONTEXTS) {
    const oldestKey = codexSessionContexts.keys().next().value
    if (!oldestKey) break
    codexSessionContexts.delete(oldestKey)
  }
}

function pruneCodexSessionContexts() {
  const now = Date.now()
  for (const [sessionId, context] of codexSessionContexts.entries()) {
    if (!context?.expiresAt || context.expiresAt <= now) {
      codexSessionContexts.delete(sessionId)
    }
  }
}

function readCodexSessionContext(customSessionId) {
  pruneCodexSessionContexts()
  const sessionId = String(customSessionId || '').trim()
  if (!sessionId) return null

  const context = codexSessionContexts.get(sessionId)
  if (!context) return null

  context.expiresAt = Date.now() + SESSION_CONTEXT_TTL_MS
  return context
}

function formatModelLabel(value) {
  return String(value || '')
    .replace(/^openai\//, '')
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => {
      if (/^gpt$/i.test(part)) return 'GPT'
      if (/^\d+(\.\d+)?$/.test(part)) return part
      return part.charAt(0).toUpperCase() + part.slice(1)
    })
    .join(' ')
}

export function fallbackCodexAuthModelOptions() {
  return DEFAULT_CODEX_AUTH_MODELS.map((model) => ({ ...model }))
}

export async function readCodexAuthModelOptions() {
  const fallback = fallbackCodexAuthModelOptions()

  try {
    const response = await fetch(`${codexProxyBaseUrl()}/models`, {
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) return fallback

    const payload = await response.json().catch(() => ({}))
    const models = Array.isArray(payload.data) ? payload.data : []
    const options = models
      .map((model) => String(model?.id || '').trim())
      .filter(Boolean)
      .filter((id) => /^gpt-|^openai\/gpt-/i.test(id))
      .map((id) => ({
        value: id,
        label: formatModelLabel(id),
        description: 'Codex-auth model through the Speak CLM bridge.',
      }))

    const merged = new Map(fallback.map((option) => [option.value, option]))
    options.forEach((option) => merged.set(option.value, option))
    return [...merged.values()]
  } catch {
    return fallback
  }
}

function requestBearer(request) {
  const header = String(request.get('authorization') || '')
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || ''
}

function contentText(content) {
  if (content === null || content === undefined) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (typeof part?.text === 'string') return part.text
        if (typeof part?.content === 'string') return part.content
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return String(content)
}

function humeProsodyText(message) {
  const scores = message?.models?.prosody?.scores
  if (!scores || typeof scores !== 'object' || Array.isArray(scores)) return ''

  const measures = Object.entries(scores)
    .flatMap(([rawLabel, rawScore]) => {
      const score = Number(rawScore)
      const label = String(rawLabel || '')
        .replace(/[^a-zA-Z0-9 _-]/g, '')
        .trim()
        .slice(0, 48)
      if (!label || !Number.isFinite(score)) return []
      return [{ label, score: Math.max(0, Math.min(1, score)) }]
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_LATEST_TURN_PROSODY_MEASURES)

  if (!measures.length) return ''
  return [
    'Hume vocal-expression measures for this latest caller turn',
    '(likelihoods, not emotion certainty):',
    measures
      .map(({ label, score }) => `${label} ${score.toFixed(3)}`)
      .join('; '),
  ].join(' ')
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return []

  const latestUserProsodyIndex = messages.findLastIndex(
    (message) =>
      String(message?.role || 'user').trim() === 'user' &&
      Boolean(humeProsodyText(message)),
  )

  return messages
    .map((message, index) => {
      const role = String(message?.role || 'user').trim()
      const content = stripHumeCodexPromptContext(contentText(message?.content))
      const prosody = index === latestUserProsodyIndex ? humeProsodyText(message) : ''
      return cleanObject({
        role: ['system', 'developer', 'user', 'assistant', 'tool'].includes(role)
          ? role
          : 'user',
        content: prosody ? `${content}\n\n[${prosody}]` : content,
        name: typeof message?.name === 'string' ? message.name : undefined,
        tool_call_id:
          typeof message?.tool_call_id === 'string'
            ? message.tool_call_id
            : undefined,
        tool_calls: Array.isArray(message?.tool_calls)
          ? message.tool_calls
          : undefined,
      })
    })
    .filter((message) => message.content || message.tool_calls?.length)
}

function requestCustomSessionId(request, body) {
  return String(
    request.query?.custom_session_id ||
      body?.custom_session_id ||
      body?.customSessionId ||
      '',
  ).trim()
}

function stableJsonStringify(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJsonStringify(entry)).join(',')}]`
  }
  if (typeof value === 'object') {
    return `{${Object.keys(value)
      .filter((key) => {
        const type = typeof value[key]
        return type !== 'undefined' && type !== 'function' && type !== 'symbol'
      })
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(value[key])}`)
      .join(',')}}`
  }
  if (typeof value === 'bigint') return JSON.stringify(String(value))
  return JSON.stringify(value)
}

function codexClmRequestHash(body) {
  const canonicalBody = { ...(body && typeof body === 'object' ? body : {}) }
  delete canonicalBody.custom_session_id
  delete canonicalBody.customSessionId
  delete canonicalBody.stream
  return createHash('sha256')
    .update(stableJsonStringify(canonicalBody))
    .digest('hex')
}

function codexClmCoalescingKey(customSessionId, body) {
  if (!customSessionId) return ''
  return `${customSessionId}\u0000${codexClmRequestHash(body)}`
}

function stableCodexClmSessionContext(sessionContext) {
  if (!sessionContext) return null
  return {
    systemPrompt: sessionContext.systemPrompt,
    context: sessionContext.context,
    variables: sessionContext.variables,
    codexReasoningEffort: sessionContext.codexReasoningEffort,
    codexFastMode: sessionContext.codexFastMode,
    promptExpansionEnabled: sessionContext.promptExpansionEnabled,
  }
}

function renderPromptTemplate(prompt, variables = {}) {
  const values = {
    now: new Date().toISOString(),
    ...variables,
  }

  return String(prompt || '').replace(
    /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
    (match, key) => {
      if (!Object.prototype.hasOwnProperty.call(values, key)) return match
      const value = values[key]
      return value === undefined || value === null ? '' : String(value)
    },
  )
}

function messageText(message) {
  return contentText(message?.content)
}

function hasBridgeInstructions(messages) {
  return messages.some(
    (message) =>
      message.role === 'developer' &&
      messageText(message).includes('Speak voice session'),
  )
}

function hasSpeakRuntimeContext(messages) {
  return messages.some((message) =>
    /<current_contact>|<operator_instructions>|<configuration_test_context>|<temporary_agent_mode>|<conversation_style>/.test(
      messageText(message),
    ),
  )
}

function buildPromptedMessages(rawMessages, request, body) {
  const messages = normalizeMessages(rawMessages)
  const sessionContext = readCodexSessionContext(requestCustomSessionId(request, body))
  const prefixedMessages = []
  const systemMessages = messages.filter(
    (message) => message.role === 'system' && messageText(message).trim(),
  )
  const conversationMessages = messages.filter((message) => message.role !== 'system')

  if (sessionContext?.systemPrompt) {
    const renderedSessionPrompt = renderPromptTemplate(
      sessionContext.systemPrompt,
      sessionContext.variables,
    )
    const sessionPromptMessage = {
      role: 'system',
      content: renderedSessionPrompt,
    }
    if (sessionContext.promptExpansionEnabled && systemMessages.length) {
      const seenSystemContent = new Set()
      const providerSystemMessages = systemMessages.filter((message) => {
        const content = canonicalPromptText(messageText(message))
        if (!content || seenSystemContent.has(content)) return false
        seenSystemContent.add(content)
        return true
      })
      const canonicalSessionPrompt = canonicalPromptText(renderedSessionPrompt)
      const providerIncludesSessionPrompt = providerSystemMessages.some((message) =>
        canonicalPromptText(messageText(message)).includes(canonicalSessionPrompt),
      )
      if (!providerIncludesSessionPrompt) {
        prefixedMessages.push(sessionPromptMessage)
      }
      prefixedMessages.push(...providerSystemMessages)
    } else {
      prefixedMessages.push(sessionPromptMessage)
    }
  } else if (systemMessages.length) {
    prefixedMessages.push(...systemMessages)
  }

  if (!hasBridgeInstructions(messages)) {
    prefixedMessages.push({
      role: 'developer',
      content: CODEX_CLM_DEVELOPER_INSTRUCTIONS,
    })
  }

  if (sessionContext?.context && !hasSpeakRuntimeContext(messages)) {
    prefixedMessages.push({
      role: 'developer',
      content: `Current Speak runtime context:\n${sessionContext.context}`,
    })
  }

  return [...prefixedMessages, ...conversationMessages]
}

function canonicalPromptText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function normalizeRequestedModel(value) {
  const model = String(value || '').trim()
  if (!model || model === 'hume') {
    return process.env.CODEX_CLM_DEFAULT_MODEL || DEFAULT_CODEX_AUTH_MODEL
  }
  return model
}

function normalizeCodexReasoningEffort(value) {
  const effort = String(value || '').trim().toLowerCase()
  return ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(effort)
    ? effort
    : undefined
}

function parseParameters(value) {
  if (value && typeof value === 'object') return value
  try {
    const parsed = JSON.parse(String(value || '{}'))
    return parsed && typeof parsed === 'object'
      ? parsed
      : { type: 'object', properties: {} }
  } catch {
    return { type: 'object', properties: {} }
  }
}

function normalizeOpenAiTools(tools) {
  return (Array.isArray(tools) && tools.length > 0
    ? tools
    : speakOpenAiToolDefinitions()
  )
    .map((tool) => {
      if (tool?.type === 'function' && tool.function?.name) {
        return tool
      }
      if (tool?.name) {
        return {
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description || '',
            parameters: parseParameters(tool.parameters),
          },
        }
      }
      return null
    })
    .filter(Boolean)
}

function writeSse(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`)
  response.flush?.()
}

function writeClmSse(response, payload, customSessionId) {
  if (
    customSessionId &&
    payload &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    !payload.system_fingerprint
  ) {
    writeSse(response, {
      ...payload,
      system_fingerprint: customSessionId,
    })
    return
  }

  writeSse(response, payload)
}

function writeDone(response) {
  response.write('data: [DONE]\n\n')
  response.flush?.()
}

function setClmSseHeaders(response) {
  if (response.headersSent) return
  response.status(200)
  response.setHeader('Content-Type', 'text/event-stream')
  response.setHeader('Cache-Control', 'no-cache, no-transform')
  response.setHeader('Connection', 'keep-alive')
  response.setHeader('X-Accel-Buffering', 'no')
}

function pruneCodexClmCoalescedRequests(now = Date.now()) {
  for (const [key, entry] of codexClmCoalescedRequests) {
    if (entry.state === 'complete' && entry.expiresAt <= now) {
      codexClmCoalescedRequests.delete(key)
    }
  }

  while (codexClmCoalescedRequests.size > MAX_CODEX_CLM_COALESCED_REQUESTS) {
    const completedKey = [...codexClmCoalescedRequests].find(
      ([, entry]) => entry.state === 'complete',
    )?.[0]
    if (!completedKey) break
    codexClmCoalescedRequests.delete(completedKey)
  }
}

function readCodexClmCoalescedRequest(key) {
  if (!key) return null
  pruneCodexClmCoalescedRequests()
  return codexClmCoalescedRequests.get(key) || null
}

function createCodexClmCoalescedRequest(key) {
  if (!key) return null
  pruneCodexClmCoalescedRequests()
  while (codexClmCoalescedRequests.size >= MAX_CODEX_CLM_COALESCED_REQUESTS) {
    const completedKey = [...codexClmCoalescedRequests].find(
      ([, entry]) => entry.state === 'complete',
    )?.[0]
    if (!completedKey) break
    codexClmCoalescedRequests.delete(completedKey)
  }
  if (codexClmCoalescedRequests.size >= MAX_CODEX_CLM_COALESCED_REQUESTS) {
    return null
  }

  let resolveSettled
  const entry = {
    key,
    state: 'inflight',
    chunks: [],
    replayBytes: 0,
    replayOverflow: false,
    subscribers: new Set(),
    expiresAt: 0,
    settled: new Promise((resolve) => {
      resolveSettled = resolve
    }),
    resolveSettled,
  }
  codexClmCoalescedRequests.set(key, entry)
  return entry
}

function writeClmChunkToResponse(response, chunk) {
  if (response.writableEnded || response.destroyed) return false
  try {
    setClmSseHeaders(response)
    response.write(chunk)
    return true
  } catch {
    return false
  }
}

function flushClmResponse(response) {
  if (response.writableEnded || response.destroyed) return
  try {
    response.flush?.()
  } catch {
    // A disconnected duplicate must not interrupt the shared upstream turn.
  }
}

function endClmResponse(response) {
  if (response.writableEnded || response.destroyed) return
  try {
    response.end()
  } catch {
    // A disconnected duplicate must not interrupt the shared upstream turn.
  }
}

function sendCodexClmBridgeError(response, error) {
  if (response.headersSent) {
    endClmResponse(response)
    return
  }
  const status = Number(error?.status)
  const publicStatus = [429, 500, 502, 503, 504].includes(status) ? status : 502
  response.status(publicStatus).json({
    error: 'Codex auth model bridge failed.',
    detail: error instanceof Error ? error.message : String(error),
  })
}

function attachCodexClmResponse(entry, response) {
  if (entry.replayOverflow) {
    response.status(503).json({
      error: 'Codex CLM duplicate replay exceeded the safe buffer.',
    })
    return Promise.resolve()
  }

  if (entry.state === 'complete') {
    for (const chunk of entry.chunks) {
      if (!writeClmChunkToResponse(response, chunk)) break
      flushClmResponse(response)
    }
    endClmResponse(response)
    return Promise.resolve()
  }

  entry.subscribers.add(response)
  response.once?.('close', () => entry.subscribers.delete(response))
  for (const chunk of entry.chunks) {
    if (!writeClmChunkToResponse(response, chunk)) {
      entry.subscribers.delete(response)
      break
    }
    flushClmResponse(response)
  }
  return entry.settled
}

function publishCodexClmChunk(entry, chunk) {
  const serialized = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
  const chunkBytes = Buffer.byteLength(serialized)
  if (
    !entry.replayOverflow &&
    entry.replayBytes + chunkBytes <= MAX_CODEX_CLM_REPLAY_BYTES
  ) {
    entry.chunks.push(serialized)
    entry.replayBytes += chunkBytes
  } else if (!entry.replayOverflow) {
    entry.replayOverflow = true
    entry.chunks = []
    entry.replayBytes = 0
  }

  for (const subscriber of entry.subscribers) {
    if (!writeClmChunkToResponse(subscriber, serialized)) {
      entry.subscribers.delete(subscriber)
    }
  }
}

function createCodexClmMulticastResponse(entry) {
  return {
    write(chunk) {
      publishCodexClmChunk(entry, chunk)
    },
    flush() {
      for (const subscriber of entry.subscribers) flushClmResponse(subscriber)
    },
  }
}

function createDeferredCodexClmResponse(response) {
  return {
    write(chunk) {
      writeClmChunkToResponse(response, chunk)
    },
    flush() {
      flushClmResponse(response)
    },
  }
}

function completeCodexClmCoalescedRequest(entry, { meaningfulOutput }) {
  const replayable =
    meaningfulOutput &&
    !entry.replayOverflow &&
    entry.chunks.length > 0 &&
    entry.chunks.at(-1) === 'data: [DONE]\n\n'
  entry.state = replayable ? 'complete' : 'discarded'
  entry.expiresAt = replayable ? Date.now() + CODEX_CLM_COALESCING_TTL_MS : 0
  for (const subscriber of entry.subscribers) endClmResponse(subscriber)
  entry.subscribers.clear()
  entry.resolveSettled({ ok: true, replayable })
  if (!replayable && codexClmCoalescedRequests.get(entry.key) === entry) {
    codexClmCoalescedRequests.delete(entry.key)
  }
}

function failCodexClmCoalescedRequest(entry, error) {
  entry.state = 'failed'
  for (const subscriber of entry.subscribers) {
    sendCodexClmBridgeError(subscriber, error)
  }
  entry.subscribers.clear()
  entry.resolveSettled({ ok: false })
  if (codexClmCoalescedRequests.get(entry.key) === entry) {
    codexClmCoalescedRequests.delete(entry.key)
  }
}

function assistantToolMessage(toolCalls) {
  return {
    role: 'assistant',
    content: '',
    tool_calls: toolCalls.map((toolCall) => ({
      id: toolCall.id,
      type: 'function',
      function: {
        name: toolCall.function.name,
        arguments: toolCall.function.arguments || '{}',
      },
    })),
  }
}

function toolResultMessage(toolCall, result) {
  return {
    role: 'tool',
    tool_call_id: toolCall.id,
    name: toolCall.function.name,
    content: JSON.stringify(result),
  }
}

export function toolFollowUpText(toolCall, result = {}) {
  const name = toolCall.function.name

  if (result.observer_error || result.status === 'accepted_unverified') {
    return 'The provider may have accepted that, but I do not have retained delivery proof. I will not claim it was sent or retry it automatically; the operator can verify the provider record.'
  }

  if (!result.ok) {
    if (result.reason === 'configuration_test_delivery_disabled') {
      return 'This test cannot send real external messages. I can keep going without sending anything.'
    }
    return 'That did not go through. Let me verify the details and take the next best step.'
  }

  if (result.pending || result.status === 'processing') {
    if (name === 'send_text_message') {
      return "I'm sending the text message to the confirmed number in the background now, and we can keep going while it processes."
    }
    if (name === 'send_email') {
      return "I'm sending the email to the confirmed address in the background now, and we can keep going while it processes."
    }
    if (name === 'send_portal_link') {
      return "I'm sending the requested link to the confirmed destination in the background now, and we can keep going while it processes."
    }
  }

  const isDeliveryTool = [
    'send_text_message',
    'send_email',
    'send_portal_link',
  ].includes(name)
  const hasRetainedDeliveryProof =
    Boolean(result.proof) ||
    (Array.isArray(result.requests) &&
      result.requests.length > 0 &&
      result.requests.every((request) => request?.sent === true && Boolean(request.proof)))
  if (isDeliveryTool && result.sent && !hasRetainedDeliveryProof) {
    return 'I do not have retained delivery proof yet, so I will not claim success. The operator can verify the provider record.'
  }

  if (name === 'send_text_message') {
    return result.sent
      ? 'I sent the text message to the confirmed number.'
      : 'The text was not sent. Let me verify the number before trying again.'
  }

  if (name === 'send_email') {
    return result.sent
      ? 'I sent the email to the confirmed address.'
      : 'The email was not sent. Let me verify the address before trying again.'
  }

  if (name === 'send_portal_link') {
    if (result.sent && result.partial) {
      return 'I sent the portal link through the channel that worked. Please open it now while we are together.'
    }
    return result.sent
      ? 'I sent the portal link to the confirmed destination. Please open it now while we are together.'
      : 'The portal link was not sent. Let me verify the destination before trying again.'
  }

  if (name === 'update_contact' || name === 'update_lead_contact') {
    return 'Got it, I updated the contact details and will use that going forward.'
  }

  if (name === 'update_caller_identity') {
    return 'Got it, I updated that and will use the corrected identity going forward.'
  }

  if (name === 'get_contact_context' || name === 'get_lead_context') {
    return 'I have the current contact details now.'
  }

  if (name === 'hang_up' || name === 'hangup' || name === 'end_call') {
    return 'Thanks for your time. Goodbye.'
  }

  return 'Got it.'
}

function writeToolFollowUp(response, model, toolCalls, toolResults, customSessionId) {
  const content = toolCalls
    .map((toolCall, index) => toolFollowUpText(toolCall, toolResults[index]))
    .filter(Boolean)
    .join(' ')

  writeClmSse(
    response,
    {
      id: `codex-clm-tool-followup-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          delta: { content: content || 'Got it.' },
          finish_reason: null,
        },
      ],
    },
    customSessionId,
  )
}

function mergeToolCallDelta(toolCallMap, deltaToolCall) {
  const index = Number.isFinite(Number(deltaToolCall?.index))
    ? Number(deltaToolCall.index)
    : toolCallMap.size
  const current =
    toolCallMap.get(index) || {
      id: '',
      type: 'function',
      function: { name: '', arguments: '' },
    }

  if (deltaToolCall.id) current.id = deltaToolCall.id
  if (deltaToolCall.type) current.type = deltaToolCall.type
  if (deltaToolCall.function?.name) {
    current.function.name += String(deltaToolCall.function.name)
  }
  if (deltaToolCall.function?.arguments) {
    current.function.arguments += String(deltaToolCall.function.arguments)
  }

  toolCallMap.set(index, current)
}

function parseSseEventBuffer(buffer) {
  const events = []
  let remainder = buffer
  let delimiterIndex = remainder.search(/\r?\n\r?\n/)

  while (delimiterIndex >= 0) {
    const event = remainder.slice(0, delimiterIndex)
    const delimiterMatch = remainder.slice(delimiterIndex).match(/^\r?\n\r?\n/)
    remainder = remainder.slice(delimiterIndex + (delimiterMatch?.[0]?.length || 2))
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    if (data) events.push(data)
    delimiterIndex = remainder.search(/\r?\n\r?\n/)
  }

  return { events, remainder }
}

function positiveNumber(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function clmStreamIdleAfterOutputMs() {
  return positiveNumber(
    process.env.CODEX_CLM_STREAM_IDLE_AFTER_OUTPUT_MS,
    DEFAULT_STREAM_IDLE_AFTER_OUTPUT_MS,
  )
}

function clmStreamInitialResponseMs() {
  return positiveNumber(
    process.env.CODEX_CLM_STREAM_INITIAL_RESPONSE_MS,
    DEFAULT_STREAM_INITIAL_RESPONSE_MS,
  )
}

async function startUpstreamRequest(body, signal) {
  const upstream = await fetch(`${codexProxyBaseUrl()}/chat/completions`, {
    method: 'POST',
    headers: {
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  })

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '')
    const error = new Error('Codex auth model request failed.')
    error.status = upstream.status
    error.detail = detail.slice(0, 500)
    throw error
  }

  return upstream
}

function createTimeoutResult(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timeout: true }), ms)
    timer.unref?.()
  })
}

async function streamUpstreamRound({
  body,
  response,
  forwardContent,
  customSessionId,
  requestStartedAt,
  round,
  requestSequence,
}) {
  const abortController = new AbortController()
  reportCodexClmTiming({
    customSessionId,
    name: 'clm_upstream_started',
    requestStartedAt,
    round,
    requestSequence,
  })
  const upstream = await startUpstreamRequest(
    body,
    AbortSignal.any([
      abortController.signal,
      AbortSignal.timeout(600000),
    ]),
  )
  reportCodexClmTiming({
    customSessionId,
    name: 'clm_upstream_headers',
    requestStartedAt,
    round,
    requestSequence,
  })
  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  const toolCallMap = new Map()
  let buffer = ''
  let sawDone = false
  let finishReason = ''
  let sawOutput = false
  let sawContent = false
  let idleTimedOut = false
  let firstTokenReceivedAt = 0
  let firstTokenForwarded = false

  const processPayload = (payload) => {
    const choice = payload.choices?.[0]
    const deltaToolCalls = Array.isArray(choice?.delta?.tool_calls)
      ? choice.delta.tool_calls
      : []
    if (deltaToolCalls.length > 0) {
      deltaToolCalls.forEach((toolCall) => mergeToolCallDelta(toolCallMap, toolCall))
      sawOutput = true
    }

    if (choice?.finish_reason) finishReason = choice.finish_reason

    const hasContent = Boolean(choice?.delta?.content)
    if (hasContent) {
      sawOutput = true
      sawContent = true
      if (!firstTokenReceivedAt) {
        firstTokenReceivedAt = performance.now()
        reportCodexClmTiming({
          customSessionId,
          name: 'clm_first_token_received',
          requestStartedAt,
          observedAt: firstTokenReceivedAt,
          round,
          requestSequence,
        })
      }
    }

    if (
      forwardContent &&
      deltaToolCalls.length === 0 &&
      choice?.finish_reason !== 'tool_calls'
    ) {
      writeClmSse(response, payload, customSessionId)
      if (hasContent && !firstTokenForwarded) {
        const forwardedAt = performance.now()
        firstTokenForwarded = true
        reportCodexClmTiming({
          customSessionId,
          name: 'clm_first_token_forwarded',
          requestStartedAt,
          observedAt: forwardedAt,
          round,
          requestSequence,
          forwardingOverheadMs: forwardedAt - firstTokenReceivedAt,
        })
      }
    }
  }

  const processBuffer = () => {
    const parsed = parseSseEventBuffer(buffer)
    buffer = parsed.remainder

    for (const event of parsed.events) {
      if (event === '[DONE]') {
        sawDone = true
        continue
      }

      let payload
      try {
        payload = JSON.parse(event)
      } catch {
        continue
      }

      processPayload(payload)
    }
  }

  while (!sawDone && !finishReason) {
    const timeoutMs = sawOutput
      ? clmStreamIdleAfterOutputMs()
      : clmStreamInitialResponseMs()
    const result = await Promise.race([reader.read(), createTimeoutResult(timeoutMs)])
    if (result?.timeout) {
      if (!sawOutput) {
        abortController.abort()
        void reader.cancel().catch(() => {})
        const error = new Error('Codex auth model initial response timed out.')
        error.status = 504
        throw error
      }
      idleTimedOut = sawOutput
      break
    }
    if (result?.done) break
    buffer += decoder.decode(result.value, { stream: true })
    processBuffer()
    if (sawDone || finishReason) break
  }

  if (finishReason && !sawDone) {
    abortController.abort()
    void reader.cancel().catch(() => {})
  }

  if (idleTimedOut) {
    abortController.abort()
    void reader.cancel().catch(() => {})
    if (!finishReason) finishReason = toolCallMap.size > 0 ? 'tool_calls' : 'stop'
    console.warn('[codex-clm] closed upstream stream after output idle timeout', {
      customSessionId,
      finishReason,
    })
  }

  buffer += decoder.decode()
  processBuffer()

  return {
    finishReason,
    sawDone,
    sawContent,
    idleTimedOut,
    toolCalls: [...toolCallMap.values()]
      .filter((toolCall) => toolCall.id && toolCall.function?.name)
      .map((toolCall) => ({
        ...toolCall,
        type: toolCall.type || 'function',
        function: {
          name: toolCall.function.name,
          arguments: toolCall.function.arguments || '{}',
        },
      })),
  }
}

async function executeToolCalls(customSessionId, toolCalls) {
  const results = []

  for (const toolCall of toolCalls) {
    const name = toolCall.function.name
    let args = {}
    try {
      args = JSON.parse(toolCall.function.arguments || '{}')
    } catch {
      args = {}
    }

    if (!codexClmToolExecutor) {
      results.push({
        ok: false,
        error: 'Speak tool executor is not configured.',
        assistant_next_step:
          'Tell the caller the action could not be completed and ask the operator for help.',
      })
      continue
    }

    try {
      results.push(
        await codexClmToolExecutor({
          customSessionId,
          toolCallId: toolCall.id,
          name,
          args,
        }),
      )
    } catch (error) {
      results.push({
        ok: false,
        error: error instanceof Error ? error.message : 'Tool execution failed.',
        assistant_next_step:
          'Do not claim the action succeeded. Verify the needed details or let the operator help.',
      })
    }
  }

  return results
}

async function runCodexClmCompletion({
  upstreamBody,
  response,
  customSessionId,
  requestStartedAt,
  requestSequence,
}) {
  let roundBody = upstreamBody
  let meaningfulOutput = false
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
    const result = await streamUpstreamRound({
      body: roundBody,
      response,
      forwardContent: true,
      customSessionId,
      requestStartedAt,
      round,
      requestSequence,
    })
    meaningfulOutput ||= result.sawContent

    if (result.toolCalls.length === 0 || result.finishReason !== 'tool_calls') {
      writeDone(response)
      return { meaningfulOutput }
    }

    const toolResults = await executeToolCalls(customSessionId, result.toolCalls)
    if (process.env.CODEX_CLM_MODEL_FOLLOWUP_AFTER_TOOLS !== 'true') {
      writeToolFollowUp(
        response,
        upstreamBody.model,
        result.toolCalls,
        toolResults,
        customSessionId,
      )
      writeDone(response)
      return { meaningfulOutput: true }
    }

    roundBody = {
      ...roundBody,
      messages: [
        ...roundBody.messages,
        assistantToolMessage(result.toolCalls),
        ...result.toolCalls.map((toolCall, index) =>
          toolResultMessage(toolCall, toolResults[index]),
        ),
      ],
    }
  }

  writeClmSse(
    response,
    {
      id: `codex-clm-tool-limit-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: upstreamBody.model,
      choices: [
        {
          index: 0,
          delta: {
            content:
              'I need the operator to help with that action before I can continue.',
          },
          finish_reason: null,
        },
      ],
    },
    customSessionId,
  )
  writeDone(response)
  return { meaningfulOutput: true }
}

export async function handleCodexClmChatCompletion(request, response) {
  const expectedToken = String(process.env.CODEX_CLM_API_KEY || '').trim()
  if (!expectedToken) {
    response.status(503).json({ error: 'Codex CLM endpoint is not configured.' })
    return
  }

  if (requestBearer(request) !== expectedToken) {
    response.status(401).json({ error: 'Unauthorized.' })
    return
  }

  const body = request.body || {}
  const customSessionId = requestCustomSessionId(request, body)
  const requestStartedAt = performance.now()
  const requestSequence = ++codexClmRequestSequence
  reportCodexClmTiming({
    customSessionId,
    name: 'clm_request_received',
    requestStartedAt,
    requestSequence,
  })
  const sessionContext = readCodexSessionContext(customSessionId)
  const model = normalizeRequestedModel(body.model)
  const tools = normalizeOpenAiTools(body.tools)
  const reasoningEffort =
    sessionContext?.codexReasoningEffort ||
    normalizeCodexReasoningEffort(body.reasoning_effort) ||
    DEFAULT_CODEX_REASONING_EFFORT
  const serviceTier =
    sessionContext?.codexFastMode === true
      ? 'priority'
      : sessionContext?.codexFastMode === false
        ? 'default'
        : String(body.service_tier || '').trim() ||
          (DEFAULT_CODEX_FAST_MODE ? 'priority' : 'default')
  const coalescingKey = codexClmCoalescingKey(customSessionId, {
    ...body,
    model,
    tools,
    reasoning_effort: reasoningEffort,
    service_tier: serviceTier,
    speak_session_context: stableCodexClmSessionContext(sessionContext),
  })
  const existingRequest = readCodexClmCoalescedRequest(coalescingKey)
  if (existingRequest) {
    reportCodexClmTiming({
      customSessionId,
      name: 'clm_request_coalesced',
      requestStartedAt,
      requestSequence,
    })
    return attachCodexClmResponse(existingRequest, response)
  }

  const upstreamBody = {
    ...body,
    model,
    messages: buildPromptedMessages(body.messages, request, body),
    tools,
    reasoning_effort: reasoningEffort,
    service_tier: serviceTier,
    stream: true,
  }

  const coalescedRequest = createCodexClmCoalescedRequest(coalescingKey)
  if (coalescingKey && !coalescedRequest) {
    response.status(503).json({
      error: 'Codex CLM request coalescing is at capacity.',
    })
    return
  }
  const outputResponse = coalescedRequest
    ? createCodexClmMulticastResponse(coalescedRequest)
    : createDeferredCodexClmResponse(response)
  if (coalescedRequest) attachCodexClmResponse(coalescedRequest, response)

  try {
    const result = await runCodexClmCompletion({
      upstreamBody,
      response: outputResponse,
      customSessionId,
      requestStartedAt,
      requestSequence,
    })
    if (coalescedRequest) {
      completeCodexClmCoalescedRequest(coalescedRequest, result)
    } else {
      endClmResponse(response)
    }
  } catch (error) {
    if (coalescedRequest) {
      failCodexClmCoalescedRequest(coalescedRequest, error)
    } else {
      sendCodexClmBridgeError(response, error)
    }
  }
}
