import 'dotenv/config'
import { readFileSync } from 'node:fs'

const args = parseArgs(process.argv.slice(2))
const baseUrl = normalizeBaseUrl(
  args.baseUrl ||
    process.env.SPEAK_BASE_URL ||
    process.env.PUBLIC_BASE_URL ||
    'https://speak.example.com/speak',
)
const requireReady = Boolean(args.requireReady)
const ensureAgentSession =
  requireReady && args.ensureAgentSession !== 'false' && !args.noEnsureAgentSession
const pauseAfterReady =
  requireReady && Boolean(args.pauseAfterReady || args.pauseAfter || args.leavePaused)
const timeoutMs = numberOption(args.timeoutMs || process.env.CALLTOOLS_AGENT_SESSION_TIMEOUT_MS, 180000)
const pollMs = numberOption(args.pollMs || process.env.CALLTOOLS_AGENT_SESSION_POLL_MS, 5000)
const campaignSettleMs = numberOption(
  args.campaignSettleMs || process.env.CALLTOOLS_CAMPAIGN_SETTLE_MS,
  10000,
)
let profileId =
  args.profileId ||
  process.env.CALLTOOLS_READINESS_PROFILE_ID ||
  process.env.CALLTOOLS_GATEWAY_PROFILE_ID ||
  ''
const target = new URL('api/calltools/readiness', `${baseUrl}/`)
if (profileId) target.searchParams.set('profileId', profileId)

assertHeadlessReadinessVerifier()
assertHeadlessAgentSessionHelper()

let payload = await readReadiness()
let agentSessionEnsure = null
let agentSessionFinalPause = null
let finalReadiness = null

if (ensureAgentSession && !agentSessionReady(payload)) {
  agentSessionEnsure = await ensureCallToolsAgentSessionReadiness({
    binding: payload.binding || {},
    appUserId: args.appUserId,
    campaignId: args.campaignId,
    agentStatusId: args.agentStatusId || args.statusId,
    webPhoneStatus: args.webPhoneStatus || 'Registered',
    ready: true,
    apply: true,
    requireCampaignReady: true,
  })
  payload = shouldPollAfterAgentSessionEnsure(agentSessionEnsure)
    ? await waitForReadinessReady(payload)
    : await readReadiness().catch(() => payload)
}

assertNoSecretKeys(payload)
assertType(payload.provider === 'calltools', 'provider must be calltools')
assertType(payload.mode === 'phone_as_agent', 'mode must be phone_as_agent')
assertType(typeof payload.ready === 'boolean', 'ready must be boolean')
assertType(typeof payload.runtimeReady === 'boolean', 'runtimeReady must be boolean')
assertType(typeof payload.directStartReady === 'boolean', 'directStartReady must be boolean')
assertType(typeof payload.campaignReady === 'boolean', 'campaignReady must be boolean')
assertType(Array.isArray(payload.checks), 'checks must be an array')
assertType(payload.checks.length >= 9, 'checks must cover core CallTools readiness')
assertType(Array.isArray(payload.blockers), 'blockers must be an array')
assertType(Array.isArray(payload.runtimeBlockers), 'runtimeBlockers must be an array')
assertType(Array.isArray(payload.campaignBlockers), 'campaignBlockers must be an array')
assertType(payload.counts && typeof payload.counts === 'object', 'counts must be present')
if (payload.ready) {
  assertType(payload.runtimeReady === true, 'ready requires runtimeReady')
  assertType(payload.campaignReady === true, 'ready requires campaignReady')
  assertType(payload.blockers.length === 0, 'ready requires no blockers')
}
if (!payload.runtimeReady) {
  assertType(payload.runtimeBlockers.length > 0, 'runtimeReady=false must expose runtimeBlockers')
}
if (!payload.campaignReady) {
  assertType(payload.campaignBlockers.length > 0, 'campaignReady=false must expose campaignBlockers')
}

const checkIds = new Set(payload.checks.map((check) => check.id))
for (const requiredId of [
  'api-auth',
  'agent-user',
  'webrtc-phone',
  'agent-session',
  'media-gateway',
  'web-callback',
  'campaign',
  'caller-id',
  'campaign-source',
  'dispositions',
  'live-calls',
  'outcome-writeback',
]) {
  assertType(checkIds.has(requiredId), `missing readiness check ${requiredId}`)
}

for (const check of payload.checks) {
  assertType(
    ['ready', 'blocked', 'warning', 'not_applicable'].includes(check.status),
    `invalid status for ${check.id}`,
  )
  assertType(Array.isArray(check.blockers), `${check.id} blockers must be an array`)
  assertType(check.proof && typeof check.proof === 'object', `${check.id} proof must exist`)
}

const mediaGatewayCheck = payload.checks.find((check) => check.id === 'media-gateway')
assertType(mediaGatewayCheck, 'media-gateway check must exist')
assertType(
  typeof mediaGatewayCheck.proof.connectionCount === 'number',
  'media-gateway proof must include connectionCount',
)
assertType(
  typeof mediaGatewayCheck.proof.healthyConnectionCount === 'number',
  'media-gateway proof must include healthyConnectionCount',
)
assertType(
  typeof mediaGatewayCheck.proof.healthy === 'boolean',
  'media-gateway proof must include healthy',
)
assertType(
  typeof mediaGatewayCheck.proof.stale === 'boolean',
  'media-gateway proof must include stale',
)
assertType(
  typeof mediaGatewayCheck.proof.heartbeatStaleAfterMs === 'number',
  'media-gateway proof must include heartbeatStaleAfterMs',
)
if (payload.runtimeReady) {
  assertType(mediaGatewayCheck.proof.healthy === true, 'runtime-ready gateway must be healthy')
  assertType(mediaGatewayCheck.proof.stale === false, 'runtime-ready gateway must not be stale')
  assertType(
    mediaGatewayCheck.proof.healthyConnectionCount > 0,
    'runtime-ready gateway must have a healthy connection',
  )
  assertType(
    mediaGatewayCheck.proof.lastSeenAgeMs <= mediaGatewayCheck.proof.heartbeatStaleAfterMs,
    'runtime-ready gateway heartbeat must be inside stale threshold',
  )
}

const webCallbackCheck = payload.checks.find((check) => check.id === 'web-callback')
assertType(webCallbackCheck, 'web-callback check must exist')
assertType(
  typeof webCallbackCheck.proof.active === 'boolean' ||
    webCallbackCheck.status === 'ready' ||
    webCallbackCheck.blockers.includes('CALLTOOLS_WEB_CALLBACK_ID') ||
    webCallbackCheck.blockers.includes('CALLTOOLS_WEB_CALLBACK_NOT_FOUND') ||
    webCallbackCheck.blockers.includes('CALLTOOLS_WEB_CALLBACKS_READ_FAILED'),
  'web-callback proof must include active state, readiness, or a route blocker',
)
if (payload.directStartReady) {
  assertType(mediaGatewayCheck.proof.healthy === true, 'direct-start-ready gateway must be healthy')
}

function normalizeBaseUrl(value) {
  return String(value || '').replace(/\/+$/g, '')
}

function parseArgs(argv) {
  const parsed = {}
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue
    const [key, value] = arg.slice(2).split('=')
    parsed[toCamel(key)] = value === undefined ? true : value
  }
  return parsed
}

function toCamel(value) {
  return String(value).replace(/-([a-z])/g, (_, char) => char.toUpperCase())
}

function assertType(condition, message) {
  if (!condition) throw new Error(message)
}

function assertNoSecretKeys(value, path = []) {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretKeys(item, [...path, String(index)]))
    return
  }
  for (const [key, child] of Object.entries(value)) {
    const nextPath = [...path, key]
    if (/password|token|api[_-]?key|secret|authorization/i.test(key)) {
      throw new Error(`Readiness payload exposes secret-shaped key: ${nextPath.join('.')}`)
    }
    assertNoSecretKeys(child, nextPath)
  }
}

function assertHeadlessReadinessVerifier() {
  const source = readFileSync(new URL('./check-calltools-readiness.mjs', import.meta.url), 'utf8')
  for (const token of [
    'ensureCallToolsAgentSessionReadiness',
    'api/calltools/agent-session',
    'confirmAgentSession',
    'api/calltools/readiness',
    'const ensureAgentSession',
    'pauseAfterReady',
    'function directAgentSessionReady',
    'campaignSettleMs',
    'directReadySince',
    'agentSessionFinalPause',
    'agentSessionProof.backendOnly === true',
    'agentSessionProof.headlessOnly === true',
    'agentSessionProof.browserAutomation === false',
    "agentSessionProof.establishPath === 'agentstatuses.patch'",
    "agentSessionProof.campaignStartPath === 'campaigns.patch'",
    "agentSessionProof.campaignAgentEstablishPath === 'campaignagents.patch'",
  ]) {
    assertType(source.includes(token), `readiness verifier must include backend/headless token ${token}`)
  }
  for (const token of [
    'prepare' + 'ProofContact',
    'api/calltools/' + 'prepare-lead',
    'ensure' + 'ProofContact',
  ]) {
    assertType(!source.includes(token), `readiness verifier must not mutate contact inventory: ${token}`)
  }
  for (const pattern of [
    new RegExp('\\bfrom\\s+[\'"]play' + 'wright[\'"]', 'i'),
    new RegExp('\\bimport\\([\'"]play' + 'wright[\'"]\\)', 'i'),
    /\bchromium\.launch\b/i,
    /\bfirefox\.launch\b/i,
    /\bwebkit\.launch\b/i,
    /\blaunchPersistentContext\b/,
    /\bpage\.goto\b/,
    /\bpage\.locator\b/,
    /\bgrantPermissions\b/,
    new RegExp('#user' + 'name|#pass' + 'word|Join\\s+' + 'Campaign|dashboard' + 'State'),
    new RegExp('process\\.env\\.CALLTOOLS_AGENT_SESSION_' + 'PASSWORD'),
  ]) {
    assertType(
      !pattern.test(source),
      `readiness verifier must not depend on browser/dashboard automation: ${pattern}`,
    )
  }
}

function assertHeadlessAgentSessionHelper() {
  const source = readFileSync(new URL('./ensure-calltools-agent-session.mjs', import.meta.url), 'utf8')
  for (const token of [
    'postAgentSession',
    'api/calltools/agent-session',
    'confirmAgentSession',
    'api/calltools/readiness',
    'agentSessionBackendProofReady',
    'headlessOnly: true',
    'backendOnly: true',
    'proof.dashboardRequired === false',
    'proof.browserAutomation === false',
    '--ready=false',
    '--dry-run',
    'assertBackendHeadlessOnlyHelper',
    'forbiddenAutomationPatterns',
  ]) {
    assertType(source.includes(token), `agent-session helper must include backend/headless token ${token}`)
  }
  for (const pattern of forbiddenAgentSessionAutomationPatterns()) {
    assertType(
      !pattern.test(source),
      `agent-session helper must not depend on browser/dashboard automation: ${pattern}`,
    )
  }
}

function forbiddenAgentSessionAutomationPatterns() {
  return [
    new RegExp('chro' + 'mium', 'i'),
    new RegExp('play' + 'wright', 'i'),
    new RegExp('launchPersistent' + 'Context'),
    new RegExp('grant' + 'Permissions'),
    new RegExp('#user' + 'name'),
    new RegExp('#pass' + 'word'),
    new RegExp('Join ' + 'Campaign'),
    new RegExp('dashboard' + 'State'),
    /--open\b/,
    /--keep-open\b/,
    new RegExp('CALLTOOLS_AGENT_SESSION_' + 'PASSWORD'),
  ]
}

const agentSessionCheck = payload.checks.find((check) => check.id === 'agent-session')
assertType(agentSessionCheck, 'agent-session check must exist')
const agentSessionProof = agentSessionCheck.proof || {}
assertType(
  agentSessionProof.backendOnly === true,
  'agent-session proof must declare backendOnly=true',
)
assertType(
  agentSessionProof.headlessOnly === true,
  'agent-session proof must declare headlessOnly=true',
)
assertType(
  agentSessionProof.dashboardRequired === false,
  'agent-session proof must not require a dashboard session',
)
assertType(
  agentSessionProof.browserAutomation === false,
  'agent-session proof must not require browser automation',
)
assertType(
  agentSessionProof.establishPath === 'agentstatuses.patch',
  'agent-session proof must use the CallTools AgentStatus PATCH path',
)
assertType(
  agentSessionProof.campaignStartPath === 'campaigns.patch',
  'agent-session proof must use the native CallTools campaign PATCH path',
)
assertType(
  agentSessionProof.campaignAgentEstablishPath === 'campaignagents.patch',
  'agent-session proof must use the native CallTools campaign-agent PATCH path',
)
for (const source of ['agentstatuses.read', 'campaignagents.read', 'campaignstatuses.read']) {
  assertType(
    Array.isArray(agentSessionProof.proofSources) && agentSessionProof.proofSources.includes(source),
    `agent-session proof must include ${source}`,
  )
}
assertType(
  typeof agentSessionProof.ready === 'boolean' ||
    agentSessionCheck.blockers.includes('CALLTOOLS_AGENT_STATUS_NOT_FOUND') ||
    agentSessionCheck.blockers.includes('CALLTOOLS_AGENT_STATUS_READ_FAILED'),
  'agent-session proof must include native ready state or a native read blocker',
)
if (payload.campaignReady) {
  assertType(agentSessionProof.ready === true, 'campaign-ready CallTools agent must be ready')
  assertType(agentSessionProof.loggedIn === true, 'campaign-ready CallTools agent must be logged in')
  assertType(
    /^registered$/i.test(agentSessionProof.webPhoneStatus || ''),
    'campaign-ready CallTools agent web phone must be registered',
  )
  assertType(
    Boolean(agentSessionProof.webPhoneRegisteredOn),
    'campaign-ready CallTools agent must include native webPhoneRegisteredOn proof',
  )
}
if (payload.directStartReady) {
  assertType(agentSessionProof.ready === true, 'direct-start-ready CallTools agent must be ready')
  assertType(
    /^registered$/i.test(agentSessionProof.webPhoneStatus || ''),
    'direct-start-ready CallTools agent web phone must be registered',
  )
  assertType(
    Boolean(agentSessionProof.webPhoneRegisteredOn),
    'direct-start-ready CallTools agent must include native webPhoneRegisteredOn proof',
  )
}
if (
  /^registered$/i.test(agentSessionProof.webPhoneStatus || '') &&
  !agentSessionProof.webPhoneRegisteredOn
) {
  assertType(
    agentSessionCheck.blockers.includes('CALLTOOLS_AGENT_WEB_PHONE_NATIVE_SESSION_MISSING'),
    'registered web phone without native session timestamp must be blocked',
  )
}

const campaignSourceCheck = payload.checks.find((check) => check.id === 'campaign-source')
assertType(campaignSourceCheck, 'campaign-source check must exist')
assertType(
  ['live-filter', 'bucket', 'unconfigured'].includes(campaignSourceCheck.proof.sourceKind),
  'campaign-source proof must declare sourceKind',
)
if (payload.campaignReady) {
  assertType(
    campaignSourceCheck.proof.sourceKind === 'live-filter' ||
      campaignSourceCheck.proof.sourceKind === 'bucket',
    'campaign-ready source must be a live filter or bucket',
  )
  assertType(
    Number(campaignSourceCheck.proof.count || 0) > 0,
    'campaign-ready source must have a positive count',
  )
  assertType(
    Number(campaignSourceCheck.proof.selectableContactCount || 0) > 0,
    'campaign-ready source must have positive effective selectable contacts',
  )
}

const dispositionsCheck = payload.checks.find((check) => check.id === 'dispositions')
assertType(dispositionsCheck, 'dispositions check must exist')
if (dispositionsCheck.blockers.includes('CALLTOOLS_DISPOSITIONS_READ_FAILED')) {
  assertType(
    typeof dispositionsCheck.proof.readError === 'string' && dispositionsCheck.proof.readError,
    'dispositions read failure must include readError proof',
  )
} else {
  assertType(Number(payload.counts.dispositions || 0) > 0, 'dispositions must be readable')
}
if (payload.runtimeReady) {
  assertType(dispositionsCheck.status === 'ready', 'runtime-ready CallTools requires dispositions')
}

if (pauseAfterReady && directAgentSessionReady(payload)) {
  agentSessionFinalPause = await ensureCallToolsAgentSessionReadiness({
    binding: payload.binding || {},
    appUserId: args.appUserId,
    campaignId: args.campaignId,
    agentStatusId: args.pauseStatusId || args.agentStatusId || args.statusId,
    webPhoneStatus: args.webPhoneStatus || 'Registered',
    ready: false,
    apply: true,
  })
  finalReadiness = shouldPollAfterAgentSessionEnsure(agentSessionFinalPause)
    ? await waitForAgentSessionNotReady(payload)
    : await readReadiness().catch(() => payload)
  assertType(
    agentSessionNotReady(finalReadiness),
    'pause-after-ready must leave native AgentStatus not-ready after proving readiness',
  )
}

if (requireReady && !payload.ready) {
  throw new Error(`CallTools readiness blocked: ${readinessFailureSummary(payload, {
    agentSessionCheck,
    campaignSourceCheck,
    mediaGatewayCheck,
  })}`)
}

console.log(
  JSON.stringify(
    {
      ok: true,
      endpoint: String(target),
      profileId,
      ready: payload.ready,
      runtimeReady: payload.runtimeReady,
      directStartReady: payload.directStartReady,
      campaignReady: payload.campaignReady,
      liveCallAttached: payload.liveCallAttached,
      blockers: payload.blockers,
      runtimeBlockers: payload.runtimeBlockers,
      campaignBlockers: payload.campaignBlockers,
      warnings: payload.warnings,
      counts: payload.counts,
      nextAction: payload.nextAction,
      agentSessionEnsure: summarizeEnsureResult(agentSessionEnsure),
      agentSessionFinalPause: summarizeEnsureResult(agentSessionFinalPause),
      pauseAfterReady,
      finalReadiness: finalReadiness ? summarizeReadiness(finalReadiness) : null,
    },
    null,
    2,
  ),
)

async function readReadiness() {
  const response = await fetch(target)
  const value = await response.json().catch(() => ({}))

  if (!response.ok) {
    throw new Error(
      `CallTools readiness endpoint failed: ${response.status} ${value.error || response.statusText}`,
    )
  }

  adoptResolvedCallToolsProfileId(value)

  return value
}

function adoptResolvedCallToolsProfileId(readiness = {}) {
  const resolvedProfileId = String(readiness?.profileId || '').trim()
  if (!profileId && resolvedProfileId) {
    profileId = resolvedProfileId
    target.searchParams.set('profileId', profileId)
  }
  return profileId
}

async function ensureCallToolsAgentSessionReadiness({
  binding = {},
  appUserId,
  campaignId,
  agentStatusId,
  webPhoneStatus = 'Registered',
  ready = true,
  apply = false,
  requireCampaignReady = false,
} = {}) {
  const endpoint = new URL('api/calltools/agent-session', `${baseUrl}/`)
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      profileId,
      appUserId: appUserId || binding.appUserId || binding.userId,
      campaignId: campaignId || binding.campaignId,
      agentStatusId,
      webPhoneStatus,
      ready,
      apply,
      confirmAgentSession: apply,
      requireCampaignReady,
    }),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(
      `CallTools agent-session endpoint failed: ${response.status} ${payload.error || response.statusText}`,
    )
  }
  return payload
}

async function waitForAgentSessionReady(latest) {
  const deadline = Date.now() + timeoutMs
  let current = latest
  while (Date.now() <= deadline) {
    current = await readReadiness().catch(() => current)
    if (agentSessionReady(current)) return current
    await delay(Math.min(pollMs, Math.max(250, deadline - Date.now())))
  }
  return current
}

async function waitForAgentSessionNotReady(latest) {
  const deadline = Date.now() + timeoutMs
  let current = latest
  while (Date.now() <= deadline) {
    current = await readReadiness().catch(() => current)
    if (agentSessionNotReady(current)) return current
    await delay(Math.min(pollMs, Math.max(250, deadline - Date.now())))
  }
  return current
}

async function waitForReadinessReady(latest) {
  const deadline = Date.now() + timeoutMs
  let current = latest
  let directReadySince = 0
  while (Date.now() <= deadline) {
    current = await readReadiness().catch(() => current)
    if (current?.ready) return current
    if (directAgentSessionReady(current)) {
      directReadySince ||= Date.now()
      if (Date.now() - directReadySince >= Math.min(campaignSettleMs, timeoutMs)) {
        return current
      }
    } else {
      directReadySince = 0
    }
    await delay(Math.min(pollMs, Math.max(250, deadline - Date.now())))
  }
  return current
}

function readinessFailureSummary(value = {}, {
  agentSessionCheck = {},
  campaignSourceCheck = {},
  mediaGatewayCheck = {},
} = {}) {
  const agentProof = agentSessionCheck.proof || {}
  const sourceProof = campaignSourceCheck.proof || {}
  const gatewayProof = mediaGatewayCheck.proof || {}
  const finalAgentProof = findAgentSessionCheck(finalReadiness)?.proof || {}
  return [
    `blockers=${(value.blockers || []).join(', ') || 'none'}`,
    `runtimeReady=${Boolean(value.runtimeReady)}`,
    `directStartReady=${Boolean(value.directStartReady)}`,
    `campaignReady=${Boolean(value.campaignReady)}`,
    `agentSession.ready=${Boolean(agentProof.ready)}`,
    `agentSession.loggedIn=${Boolean(agentProof.loggedIn)}`,
    `agentSession.webPhoneStatus=${agentProof.webPhoneStatus || 'unknown'}`,
    `agentSession.webPhoneRegisteredOn=${agentProof.webPhoneRegisteredOn || 'missing'}`,
    `campaignSource.count=${Number(sourceProof.count || 0)}`,
    `campaignSource.selectableContactCount=${Number(sourceProof.selectableContactCount || 0)}`,
    `mediaGateway.healthy=${Boolean(gatewayProof.healthy)}`,
    `nextAction=${value.nextAction || 'none'}`,
    agentSessionEnsure ? `agentSessionEnsure.status=${agentSessionEnsure.status || 'unknown'}` : '',
    agentSessionEnsure?.blockers?.length
      ? `agentSessionEnsure.blockers=${agentSessionEnsure.blockers.join(',')}`
      : '',
    agentSessionEnsure?.patchError ? `agentSessionEnsure.patchError=${agentSessionEnsure.patchError}` : '',
    agentSessionEnsure?.campaignAgentPatchError
      ? `agentSessionEnsure.campaignAgentPatchError=${agentSessionEnsure.campaignAgentPatchError}`
      : '',
    agentSessionFinalPause
      ? `agentSessionFinalPause.status=${agentSessionFinalPause.status || 'unknown'}`
      : '',
    agentSessionFinalPause?.patchError
      ? `agentSessionFinalPause.patchError=${agentSessionFinalPause.patchError}`
      : '',
    finalReadiness
      ? `finalReadiness.agentSession.ready=${Boolean(finalAgentProof.ready)}`
      : '',
  ].filter(Boolean).join('; ')
}

function agentSessionReady(readiness = {}) {
  const check = findAgentSessionCheck(readiness)
  const proof = check?.proof || {}
  return Boolean(
    check?.status === 'ready' &&
      agentSessionBackendProofReady(proof) &&
      proof.ready &&
      proof.loggedIn &&
      /^registered$/i.test(proof.webPhoneStatus || '') &&
      proof.webPhoneRegisteredOn,
  )
}

function directAgentSessionReady(readiness = {}) {
  const check = findAgentSessionCheck(readiness)
  const proof = check?.proof || {}
  return Boolean(
    readiness.directStartReady &&
      check &&
      agentSessionBackendProofReady(proof) &&
      proof.ready &&
      /^registered$/i.test(proof.webPhoneStatus || '') &&
      proof.webPhoneRegisteredOn,
  )
}

function agentSessionNotReady(readiness = {}) {
  const check = findAgentSessionCheck(readiness)
  const proof = check?.proof || {}
  return Boolean(
    check &&
      agentSessionBackendProofReady(proof) &&
      proof.ready === false &&
      /^registered$/i.test(proof.webPhoneStatus || '') &&
      proof.webPhoneRegisteredOn,
  )
}

function agentSessionBackendProofReady(proof = {}) {
  return Boolean(
    proof.backendOnly === true &&
      proof.headlessOnly === true &&
      proof.dashboardRequired === false &&
      proof.browserAutomation === false &&
      proof.establishPath === 'agentstatuses.patch' &&
      proof.campaignStartPath === 'campaigns.patch' &&
      proof.campaignAgentEstablishPath === 'campaignagents.patch' &&
      Array.isArray(proof.proofSources) &&
      proof.proofSources.includes('agentstatuses.read') &&
      proof.proofSources.includes('campaignagents.read') &&
      proof.proofSources.includes('campaignstatuses.read'),
  )
}

function findAgentSessionCheck(readiness = {}) {
  return Array.isArray(readiness.checks)
    ? readiness.checks.find((check) => check.id === 'agent-session')
    : null
}

function shouldPollAfterAgentSessionEnsure(result = {}) {
  return Boolean(
    result?.ok ||
      result?.mutationPerformed ||
      result?.patchError ||
      (Array.isArray(result?.blockers) &&
        result.blockers.includes('CALLTOOLS_AGENT_STATUS_PATCH_FAILED')),
  )
}

function summarizeEnsureResult(result = {}) {
  if (!result) return null
  return {
    schemaVersion: result.schemaVersion,
    ok: Boolean(result.ok),
    status: result.status || '',
    requireCampaignReady: Boolean(result.requireCampaignReady),
    readinessMode: result.readinessMode || '',
    backendOnly: Boolean(result.backendOnly),
    headlessOnly: Boolean(result.headlessOnly),
    dashboardRequired: Boolean(result.dashboardRequired),
    browserAutomation: Boolean(result.browserAutomation),
    establishPath: result.establishPath || '',
    mutationEndpoint: result.mutationEndpoint || '',
    proofSources: result.proofSources || [],
    applyRequested: Boolean(result.applyRequested),
    mutationPerformed: Boolean(result.mutationPerformed),
    timeouts: result.timeouts || {},
    blockers: result.blockers || [],
    binding: result.binding || {},
    readyStatus: result.readyStatus || null,
    patchError: result.patchError || '',
    after: result.after || null,
    campaignAgentStatus: result.campaignAgentStatus || null,
    campaignStatus: result.campaignStatus || null,
    proof: result.proof || {},
    note: result.note || '',
  }
}

function summarizeReadiness(readiness = {}) {
  const agentSessionCheck = findAgentSessionCheck(readiness)
  const campaignSourceCheck = Array.isArray(readiness.checks)
    ? readiness.checks.find((check) => check.id === 'campaign-source')
    : null
  const agentProof = agentSessionCheck?.proof || {}
  const sourceProof = campaignSourceCheck?.proof || {}
  return {
    ready: Boolean(readiness.ready),
    runtimeReady: Boolean(readiness.runtimeReady),
    directStartReady: Boolean(readiness.directStartReady),
    campaignReady: Boolean(readiness.campaignReady),
    blockers: readiness.blockers || [],
    campaignBlockers: readiness.campaignBlockers || [],
    agentSession: {
      status: agentSessionCheck?.status || 'missing',
      ready: Boolean(agentProof.ready),
      loggedIn: Boolean(agentProof.loggedIn),
      webPhoneStatus: agentProof.webPhoneStatus || '',
      webPhoneRegisteredOn: Boolean(agentProof.webPhoneRegisteredOn),
    },
    campaignSource: {
      status: campaignSourceCheck?.status || 'missing',
      sourceKind: sourceProof.sourceKind || '',
      count: Number(sourceProof.count || 0),
      selectableContactCount: Number(sourceProof.selectableContactCount || 0),
    },
  }
}

function numberOption(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
