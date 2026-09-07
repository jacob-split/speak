import 'dotenv/config'
import { readFileSync } from 'node:fs'

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  printUsage()
  process.exit(0)
}

const baseUrl = normalizeBaseUrl(
  args.baseUrl ||
    process.env.SPEAK_BASE_URL ||
    process.env.PUBLIC_BASE_URL ||
    'https://speak.example.com/speak',
)
let profileId =
  args.profileId ||
  process.env.CALLTOOLS_AGENT_SESSION_PROFILE_ID ||
  process.env.CALLTOOLS_GATEWAY_PROFILE_ID ||
  ''
const timeoutMs = numberOption(args.timeoutMs || process.env.CALLTOOLS_AGENT_SESSION_TIMEOUT_MS, 180000)
const pollMs = numberOption(args.pollMs || process.env.CALLTOOLS_AGENT_SESSION_POLL_MS, 5000)
const apply = !Boolean(args.dryRun || args.planOnly || args.apply === 'false')
const requireCampaignReady = Boolean(
  args.requireCampaignReady ||
    args.requireReady ||
    args.requireTopLevelReady ||
    args.mode === 'campaign-follow' ||
    args.mode === 'campaign',
)
const targetReady = !(
  args.ready === 'false' ||
  args.targetReady === 'false' ||
  args.mode === 'not-ready' ||
  args.mode === 'paused' ||
  args.pause
)

let initial = null
let ensureResult = null
let finalReadiness = null
let finalPayload = null
let exitCode = 1

try {
  assertBackendHeadlessOnlyHelper()
  initial = await readReadiness()
  if (targetReady && targetAgentSessionReady(initial)) {
    finalReadiness = initial
    finalPayload = {
      ok: true,
      status: 'ready',
      requireCampaignReady,
      readiness: summarizeReadiness(initial),
    }
    exitCode = 0
  } else if (!targetReady && agentSessionNotReady(initial) && !args.expectedLeaseId) {
    finalReadiness = initial
    finalPayload = {
      ok: true,
      status: 'not-ready',
      requireCampaignReady,
      readiness: summarizeReadiness(initial),
    }
    exitCode = 0
  } else {
    ensureResult = await postAgentSession({
      appUserId: args.appUserId,
      campaignId: args.campaignId,
      expectedLeaseId: args.expectedLeaseId,
      agentStatusId: args.agentStatusId || args.statusId,
      phoneId: args.phoneId,
      webPhoneStatus: args.webPhoneStatus || 'Registered',
      ready: targetReady,
      apply,
      requireCampaignReady,
    })
    finalReadiness = apply ? await waitForAgentSessionState() : await readReadiness().catch(() => initial)
    const ready = targetReady ? targetAgentSessionReady(finalReadiness) : agentSessionNotReady(finalReadiness)
    finalPayload = {
      ok: ready,
      status: ready
        ? targetReady ? 'ready' : 'not-ready'
        : ensureResult?.status === 'blocked' ? 'blocked' : apply ? 'blocked' : 'planned',
      apply,
      requireCampaignReady,
      readiness: summarizeReadiness(finalReadiness),
      ensure: summarizeEnsureResult(ensureResult),
      nextActions: ready ? [] : sessionNextActions(finalReadiness, ensureResult, { targetReady }),
    }
    exitCode = ready ? 0 : 1
  }
} catch (error) {
  finalPayload = {
    ok: false,
    status: 'blocked',
    apply,
    error: String(error?.message || error),
    readiness: summarizeReadiness(finalReadiness || initial || {}),
    ensure: summarizeEnsureResult(ensureResult),
    nextActions: ['Repair the backend CallTools AgentStatus API path, then rerun this helper.'],
  }
  exitCode = 1
} finally {
  finalPayload = {
    ...(finalPayload || {}),
    leaseOwnership: summarizeLeaseOwnership({
      initial,
      finalReadiness,
      ensureResult,
    }),
  }
  printResult(finalPayload)
}

process.exit(exitCode)

async function waitForAgentSessionState() {
  const deadline = Date.now() + timeoutMs
  let latest = initial || null
  while (Date.now() <= deadline) {
    latest = await readReadiness().catch(() => latest)
    if (targetReady ? targetAgentSessionReady(latest) : agentSessionNotReady(latest)) return latest
    await delay(Math.min(pollMs, Math.max(250, deadline - Date.now())))
  }
  return latest
}

async function readReadiness() {
  const target = new URL('api/calltools/readiness', `${baseUrl}/`)
  if (profileId) target.searchParams.set('profileId', profileId)
  const response = await fetch(target)
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(
      `CallTools readiness endpoint failed: ${response.status} ${payload.error || response.statusText}`,
    )
  }
  adoptResolvedCallToolsProfileId(payload)
  return payload
}

function adoptResolvedCallToolsProfileId(readiness = {}) {
  const resolvedProfileId = String(readiness?.profileId || '').trim()
  if (!profileId && resolvedProfileId) profileId = resolvedProfileId
  return profileId
}

async function postAgentSession({
  appUserId,
  campaignId,
  expectedLeaseId,
  agentStatusId,
  phoneId,
  webPhoneStatus = 'Registered',
  ready = true,
  apply: shouldApply = false,
} = {}) {
  const target = new URL('api/calltools/agent-session', `${baseUrl}/`)
  const response = await fetch(target, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      profileId,
      appUserId,
      campaignId,
      expectedLeaseId,
      agentStatusId,
      phoneId,
      webPhoneStatus,
      ready,
      apply: shouldApply,
      confirmAgentSession: shouldApply,
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

function agentSessionReady(readiness = {}) {
  const check = agentSessionCheck(readiness)
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
  const check = agentSessionCheck(readiness)
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

function targetAgentSessionReady(readiness = {}) {
  return requireCampaignReady ? agentSessionReady(readiness) : directAgentSessionReady(readiness)
}

function agentSessionNotReady(readiness = {}) {
  const check = agentSessionCheck(readiness)
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

function agentSessionCheck(readiness = {}) {
  return Array.isArray(readiness.checks)
    ? readiness.checks.find((check) => check.id === 'agent-session')
    : null
}

function assertBackendHeadlessOnlyHelper() {
  const source = readFileSync(new URL('./ensure-calltools-agent-session.mjs', import.meta.url), 'utf8')
  for (const token of [
    'postAgentSession',
    'api/calltools/agent-session',
    'confirmAgentSession',
    'api/calltools/readiness',
    'agentSessionBackendProofReady',
    'backendOnly: true',
    'headlessOnly: true',
    'proof.dashboardRequired === false',
    'proof.browserAutomation === false',
    '--ready=false',
    '--dry-run',
  ]) {
    assertType(source.includes(token), `agent-session helper must include backend/headless token ${token}`)
  }
  for (const pattern of forbiddenAutomationPatterns()) {
    assertType(
      !pattern.test(source),
      `agent-session helper must not depend on browser/dashboard automation: ${pattern}`,
    )
  }
}

function forbiddenAutomationPatterns() {
  return [
    new RegExp('chro' + 'mium', 'i'),
    new RegExp('play' + 'wright', 'i'),
    new RegExp('launchPersistent' + 'Context'),
    new RegExp('grant' + 'Permissions'),
    new RegExp('#user' + 'name'),
    new RegExp('#pass' + 'word'),
    new RegExp('Join ' + 'Campaign'),
    new RegExp('dashboard' + 'State'),
    new RegExp('--' + 'open\\b'),
    new RegExp('--keep-' + 'open\\b'),
    new RegExp('CALLTOOLS_AGENT_SESSION_' + 'PASSWORD'),
  ]
}

function summarizeReadiness(readiness = {}) {
  const check = agentSessionCheck(readiness)
  const proof = check?.proof || {}
  return {
    ready: Boolean(readiness.ready),
    runtimeReady: Boolean(readiness.runtimeReady),
    directStartReady: Boolean(readiness.directStartReady),
    campaignReady: Boolean(readiness.campaignReady),
    blockers: readiness.blockers || [],
    campaignBlockers: readiness.campaignBlockers || [],
    nextAction: readiness.nextAction || '',
    dutyMonitor: summarizeDutyMonitor(readiness.dutyMonitor),
    agentSession: {
      status: check?.status || 'missing',
      blockers: check?.blockers || [],
      backendOnly: Boolean(proof.backendOnly),
      headlessOnly: Boolean(proof.headlessOnly),
      dashboardRequired: Boolean(proof.dashboardRequired),
      browserAutomation: Boolean(proof.browserAutomation),
      establishPath: proof.establishPath || '',
      campaignStartPath: proof.campaignStartPath || '',
      campaignAgentEstablishPath: proof.campaignAgentEstablishPath || '',
      proofSources: proof.proofSources || [],
      appUserId: proof.appUserId || '',
      name: proof.name || '',
      ready: Boolean(proof.ready),
      loggedIn: Boolean(proof.loggedIn),
      nativeLoggedIn: Boolean(proof.nativeLoggedIn),
      campaignLoginProof: proof.campaignLoginProof || '',
      campaignAgentProof: proof.campaignAgentProof || '',
      campaignAgentReady: Boolean(proof.campaignAgentReady),
      campaignId: proof.campaignId || '',
      campaignName: proof.campaignName || '',
      webPhoneStatus: proof.webPhoneStatus || '',
      webPhoneRegisteredOn: proof.webPhoneRegisteredOn || '',
      psEndpointId: proof.psEndpointId || '',
    },
  }
}

function summarizeEnsureResult(result = {}) {
  if (!result) return null
  return {
    schemaVersion: result.schemaVersion,
    ok: Boolean(result.ok),
    status: result.status || '',
    targetReady: result.targetReady !== false,
    requireCampaignReady: Boolean(result.requireCampaignReady),
    readinessMode: result.readinessMode || '',
    backendOnly: Boolean(result.backendOnly),
    headlessOnly: Boolean(result.headlessOnly),
    dashboardRequired: Boolean(result.dashboardRequired),
    browserAutomation: Boolean(result.browserAutomation),
    establishPath: result.establishPath || '',
    campaignStartPath: result.campaignStartPath || '',
    campaignAgentEstablishPath: result.campaignAgentEstablishPath || '',
    mutationEndpoint: result.mutationEndpoint || '',
    proofSources: result.proofSources || [],
    applyRequested: Boolean(result.applyRequested),
    mutationPerformed: Boolean(result.mutationPerformed),
    timeouts: result.timeouts || {},
    blockers: result.blockers || [],
    binding: result.binding || {},
    readyStatus: result.readyStatus || null,
    patch: result.patch || {},
    campaignStart: result.campaignStart || null,
    campaignAgentMutationEndpoint: result.campaignAgentMutationEndpoint || '',
    campaignAgentPatchError: result.campaignAgentPatchError || '',
    patchError: result.patchError || '',
    before: result.before || null,
    after: result.after || null,
    campaignAgentStatus: result.campaignAgentStatus || null,
    campaignStatus: result.campaignStatus || null,
    proof: result.proof || {},
    note: result.note || '',
    dutyMonitor: summarizeDutyMonitor(result.dutyMonitor),
  }
}

function summarizeLeaseOwnership({ initial = {}, finalReadiness = {}, ensureResult = null } = {}) {
  const initialDuty = summarizeDutyMonitor(initial?.dutyMonitor)
  const finalDuty = summarizeDutyMonitor(
    ensureResult?.dutyMonitor || finalReadiness?.dutyMonitor,
  )
  const initialLeaseId = initialDuty.leaseId
  const leaseId = finalDuty.leaseId
  const owned = Boolean(
    targetReady &&
      apply &&
      ensureResult?.ok &&
      !initialLeaseId &&
      leaseId &&
      finalDuty.reason === 'operator_available',
  )
  return {
    owned,
    initialLeaseId,
    leaseId,
    profileId: finalDuty.profileId,
    binding: finalDuty.binding,
    status: finalDuty.status,
    reason: finalDuty.reason,
  }
}

function summarizeDutyMonitor(duty = {}) {
  return {
    leaseId: String(duty?.leaseId || '').trim(),
    profileId: String(duty?.profileId || '').trim(),
    status: String(duty?.status || '').trim(),
    reason: String(duty?.reason || '').trim(),
    binding: {
      appUserId: String(duty?.binding?.appUserId || '').trim(),
      campaignId: String(duty?.binding?.campaignId || '').trim(),
      phoneId: String(duty?.binding?.phoneId || '').trim(),
    },
  }
}

function sessionNextActions(readiness = {}, ensure = {}, { targetReady: desiredReady = true } = {}) {
  const summary = summarizeReadiness(readiness)
  const actions = []
  const ensureBlockers = Array.isArray(ensure?.blockers) ? ensure.blockers : []
  const readBlocked = ensureBlockers.some((blocker) => /_READ_FAILED$/.test(blocker))
  if (!ensure?.applyRequested && ensure?.status !== 'blocked') {
    actions.push('Rerun npm run calltools:agent-session without --dry-run to start the selected campaign and agent session.')
  }
  if (readBlocked) {
    actions.push('Retry after the native CallTools AgentStatus and campaign-agent API reads respond.')
  }
  if (!readBlocked) {
    if (!desiredReady) {
      if (summary.agentSession.ready) {
        actions.push('Set native AgentStatus.ready=false through the CallTools API before proof-contact preparation.')
      }
    } else if (!summary.agentSession.ready) {
      actions.push('Set native AgentStatus.ready=true through the CallTools API.')
    }
    if (!/^registered$/i.test(summary.agentSession.webPhoneStatus || '')) {
      actions.push('Set native AgentStatus.web_phone_status=Registered through the CallTools API.')
    }
    if (!summary.agentSession.webPhoneRegisteredOn) {
      actions.push('Set native AgentStatus.web_phone_registered_on through the CallTools API.')
    }
    if (requireCampaignReady && !summary.agentSession.loggedIn) {
      actions.push('Verify CallTools campaign status reports a logged-in, waiting, or on-call agent for the selected campaign.')
    }
  }
  actions.push(
    desiredReady && requireCampaignReady
      ? 'Rerun npm run qa:calltools-readiness -- --require-ready after the backend campaign-agent ensure step.'
      : desiredReady
        ? 'Rerun npm run calltools:agent-session -- --require-campaign-ready only when certifying CallTools campaign-follow readiness.'
      : 'Rerun npm run calltools:agent-session -- --ready=false before proof-contact preparation; after preparation, rerun it with --ready=true.',
  )
  return actions
}

function normalizeBaseUrl(value) {
  return String(value || '').replace(/\/+$/g, '')
}

function numberOption(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
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

function printUsage() {
  console.log([
    'Usage: node scripts/ensure-calltools-agent-session.mjs [options]',
    '',
    'Backend/headless-only CallTools campaign-agent helper.',
    '',
    'Options:',
    '  --base-url=<url>              Speak base URL. Defaults to SPEAK_BASE_URL or production.',
    '  --profile-id=<id>             Optional Speak profile pin. Defaults to the backend-selected active profile.',
    '  --expected-lease-id=<id>       Release only this exact Speak-owned duty lease.',
    '  --app-user-id=<id>             Exact CallTools user for a scoped release.',
    '  --campaign-id=<id>             Exact CallTools campaign for a scoped release.',
    '  --phone-id=<id>                Exact CallTools phone for a scoped release.',
    '  --ready=false                 Keep the webphone registered while pausing native campaign readiness.',
    '  --require-campaign-ready      Require full CallTools campaign-follow readiness.',
    '  --dry-run                     Plan native campaign and agent-session mutations without applying them.',
    '  --timeout-ms=<ms>             Poll timeout after an applied patch.',
    '  --poll-ms=<ms>                Poll interval after an applied patch.',
    '  --help                        Print this message without reading or mutating provider state.',
  ].join('\n'))
}

function toCamel(value) {
  return String(value).replace(/-([a-z])/g, (_, char) => char.toUpperCase())
}

function assertType(condition, message) {
  if (!condition) throw new Error(message)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function printResult(payload) {
  console.log(JSON.stringify({
    schemaVersion: 'speak.calltools-agent-session-helper.v1',
    profileId,
    backendOnly: true,
    headlessOnly: true,
    targetReady,
    ...payload,
  }, null, 2))
}
