import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { operationalDate } from '../server/operational-time.mjs'

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

const localBaseUrl = options.baseUrl || process.env.SPEAK_FULL_AUDIT_BASE_URL || 'http://127.0.0.1:5173/speak'
const productionBaseUrl =
  options.productionBaseUrl ||
  process.env.SPEAK_FULL_AUDIT_PRODUCTION_BASE_URL ||
  process.env.PUBLIC_BASE_URL ||
  'https://speak.example.com/speak'
const renderedBaseUrl = String(
  options.renderedBaseUrl ||
    process.env.SPEAK_FULL_AUDIT_RENDERED_BASE_URL ||
    (flags.has('--production') || flags.has('--include-production') || options.sshHost || process.env.SPEAK_FULL_AUDIT_SSH_HOST
      ? productionBaseUrl
      : localBaseUrl),
).replace(/\/+$/, '')
const devHealthUrl = options.devHealthUrl || process.env.SPEAK_FULL_AUDIT_DEV_HEALTH_URL || 'http://127.0.0.1:8787/api/health'
const sshHost = options.sshHost || process.env.SPEAK_FULL_AUDIT_SSH_HOST || ''
const remoteCwd = options.remoteCwd || process.env.SPEAK_FULL_AUDIT_REMOTE_CWD || '/opt/speak'
const includeProduction = flags.has('--production') || flags.has('--include-production') || Boolean(sshHost)
const includeLive = flags.has('--include-live')
const certificationRequired =
  flags.has('--certify') ||
  flags.has('--require-certification') ||
  process.env.SPEAK_FULL_AUDIT_CERTIFY === 'true'
const requireCallToolsReady = includeLive
const calltoolsAgentSessionTimeoutMs = numberOption(
  options.calltoolsAgentSessionTimeoutMs ||
    process.env.CALLTOOLS_AGENT_SESSION_TIMEOUT_MS,
  180000,
)
const calltoolsProfileId = String(
  options.calltoolsProfileId ||
    options.profileId ||
    process.env.CALLTOOLS_AGENT_SESSION_PROFILE_ID ||
    process.env.CALLTOOLS_READINESS_PROFILE_ID ||
    process.env.CALLTOOLS_PROFILE_ID ||
    process.env.CALLTOOLS_GATEWAY_PROFILE_ID ||
    '',
).trim()
const calltoolsCampaignId = String(
  options.calltoolsCampaignId ||
    options.campaignId ||
    process.env.CALLTOOLS_READINESS_CAMPAIGN_ID ||
    process.env.CALLTOOLS_CAMPAIGN_ID ||
    '',
).trim()
const campaignProofWaitMs = numberOption(
  options.campaignProofWaitMs ||
    options.liveProofWaitMs ||
    process.env.CALLTOOLS_CAMPAIGN_PROOF_WAIT_MS,
  180_000,
)
const campaignProofPollMs = numberOption(
  options.campaignProofPollMs ||
    options.liveProofPollMs ||
    process.env.CALLTOOLS_CAMPAIGN_PROOF_POLL_MS,
  2_000,
)
const skipBuild = flags.has('--skip-build')
const skipRendered = flags.has('--skip-rendered-ui')
const json = flags.has('--json')
const allowPendingCallToolsRecordingTranscript = flags.has(
  '--allow-pending-calltools-recording-transcript',
)
const liveProofMaxAgeMs = numberOption(
  options.liveProofMaxAgeMs ||
    process.env.SPEAK_FULL_AUDIT_LIVE_PROOF_MAX_AGE_MS,
  60 * 60 * 1000,
)
const calltoolsRecordingTranscriptWaitMs = numberOption(
  options.calltoolsRecordingTranscriptWaitMs ||
    process.env.CALLTOOLS_FULL_AUDIT_RECORDING_TRANSCRIPT_WAIT_MS,
  20 * 60 * 1000,
)
const calltoolsRecordingTranscriptPollMs = numberOption(
  options.calltoolsRecordingTranscriptPollMs ||
    process.env.CALLTOOLS_FULL_AUDIT_RECORDING_TRANSCRIPT_POLL_MS,
  60 * 1000,
)
const calltoolsRecordingFile =
  options.calltoolsRecordingFile ||
  options.recordingFile ||
  process.env.CALLTOOLS_FULL_AUDIT_RECORDING_FILE ||
  ''
const calltoolsRecordingTranscriptLogFile =
  options.calltoolsRecordingLog ||
  options.log ||
  process.env.CALLTOOLS_FULL_AUDIT_RECORDING_TRANSCRIPT_LOG ||
  process.env.SPEAK_CALLTOOLS_PROOF_LOG ||
  ''
const calltoolsRecordingTranscriptAudioDir =
  options.calltoolsRecordingAudioDir ||
  options.callAudioDir ||
  process.env.CALLTOOLS_FULL_AUDIT_RECORDING_AUDIO_DIR ||
  process.env.CALL_AUDIO_DIR ||
  ''
const explicitLiveProofPath =
  options.liveProof ||
  options.proof ||
  process.env.CALLTOOLS_S_TIER_LIVE_PROOF_JSON ||
  process.env.CALLTOOLS_PRODUCTION_LIVE_PROOF_JSON ||
  ''
let liveProofPath = explicitLiveProofPath
let generatedLiveProofDir = ''
let generatedLiveProofPath = ''
let liveProofPayload = null
let liveProofValidation = null
let calltoolsRecordingTranscriptTask = null
let calltoolsAgentSessionProcess = null
let calltoolsAgentSessionPayload = null
let calltoolsOwnedLease = null
const calltoolsPreflightCommands = [
  ['qa:calltools-media-gateway'],
  ['qa:calltools-live-proof-contract'],
  ['qa:calltools-phone-agent'],
]
const calltoolsReadinessCommand = [
  'qa:calltools-readiness',
  `--baseUrl=${productionBaseUrl}`,
  ...(calltoolsProfileId ? [`--profileId=${calltoolsProfileId}`] : []),
  ...(requireCallToolsReady ? ['--require-ready', '--no-ensure-agent-session'] : []),
]

const devServers = new Set()
const startedAt = new Date()
const results = []

try {
  recordCertificationModeFlagFailures()

  if (shouldEnsureLocalRenderedServer(renderedBaseUrl)) {
    await ensureLocalDevServer()
  }

  if (requireCallToolsReady) {
    await runCallToolsPreflightGroup()
  }
  await runGroup('static-build', [
    ['lint'],
    ...(skipBuild ? [] : [['build:speak']]),
    ['qa:brand-marketing'],
    ['qa:speak-icons'],
    ['qa:full-audit-coverage'],
    ['qa:maintenance-safety'],
  ])
  await runGroup('voice-and-communication', [
    ['qa:voice-provider-process'],
    ['qa:voice-configs'],
    ['qa:xai-voice-runtime'],
    ['qa:inworld-latency'],
    ['qa:storage-hot-path'],
    ['qa:communication-threads'],
    ['qa:background-delivery-outbox'],
    [
      'qa:transcript-rendering',
      ...(includeProduction ? [`--baseUrl=${productionBaseUrl}`] : []),
    ],
    ['qa:transcript-emotions'],
    ['qa:lead-identity'],
    ['qa:source-import-merge'],
    ['qa:phone-provider-options'],
    ['qa:playground-phone-supervision'],
    ['qa:personal-phone-inbound'],
    ['qa:context-runtime'],
    ['qa:session-prompt'],
    ['qa:transport'],
  ])
  if (!requireCallToolsReady) {
    await runCallToolsPreflightGroup()
  }
  if (includeLive) {
    if (callToolsPreflightReady()) {
      const generatedProof = await runLiveProofGroup()
      generatedLiveProofPath = generatedProof || ''
      if (!liveProofPath && generatedProof) liveProofPath = generatedProof
    } else {
      recordFailure('live-proof-gated', [
        'qa:calltools-live-proof',
      ], 'Native campaign proof was not awaited because campaign-follow availability/readiness preflight failed.')
    }
  } else if (liveProofPath) {
    await recordSuppliedLiveProofArtifact()
  } else if (certificationRequired) {
    recordFailure('live-proof-required', [
      'qa:calltools-live-proof',
    ], 'Certification mode requires --include-live or --liveProof=<campaign-proof.json> so a lease-authorized native CallTools campaign call is proven.')
  } else {
    recordSkip('live-proof-gated', [
      'qa:calltools-live-proof',
    ], 'Pass --include-live to arm campaign-follow and wait for the next answered human call routed by the active CallTools campaign.')
  }
  if (includeLive || liveProofPath || explicitLiveProofPath) {
    if (callToolsPreflightReady() && liveProofPath) {
      calltoolsRecordingTranscriptTask = startCallToolsRecordingTranscriptForLiveProof()
    } else {
      recordFailure('calltools-recording-transcript-review', [
        'audit:calltools-recording-transcript',
      ], liveProofPath
        ? 'CallTools native agent-session/readiness preflight failed before recording-derived review.'
        : 'Recording-derived review requires a successful live proof artifact from an active CallTools agent session.')
    }
  } else if (certificationRequired) {
    recordFailure('calltools-recording-transcript-review', [
      'audit:calltools-recording-transcript',
    ], 'Certification mode requires a successful live proof artifact before recording-derived review can run.')
  } else {
    recordSkip('calltools-recording-transcript-review', [
      'audit:calltools-recording-transcript',
    ], 'Requires --include-live or --liveProof=<proof.json>; non-live audits keep recording-derived review gated.')
  }
  if (shouldEnsureLocalRenderedServer(renderedBaseUrl)) {
    await ensureLocalDevServer()
  }
  await runGroup('agent-and-widget-contracts', [
    ['qa:mcp-app'],
    ['qa:widget-bridge'],
    ['qa:ui-adapter-kit'],
    ['qa:ui-snapshot'],
    ['qa:action-invoke'],
    ['qa:backend-api', `--baseUrl=${renderedBaseUrl}`],
    ['qa:host-client'],
    ['qa:agent-adapters'],
    ['qa:agent-readiness'],
    ['qa:speak-agent-tier'],
  ])
  if (!skipRendered) {
    if (shouldEnsureLocalRenderedServer(renderedBaseUrl)) {
      await ensureLocalDevServer()
    }
    await runRenderedUiGroup()
  }
  if (includeProduction) {
    await runProductionGroup()
  } else if (certificationRequired) {
    recordFailure('production-provider-routing', [
      'qa:workspace-email',
      'qa:workspace-email-source',
      'qa:telnyx-source-routing',
    ], 'Certification mode requires production provider routing checks via --production or --sshHost=<host>.')
  } else {
    recordSkip('production-provider-routing', [
      'qa:workspace-email',
      'qa:workspace-email-source',
      'qa:telnyx-source-routing',
    ], 'Pass --production on the production host or --sshHost=<host> from local.')
  }
  if (calltoolsRecordingTranscriptTask) {
    await calltoolsRecordingTranscriptTask
  }
} finally {
  if (calltoolsOwnedLease) {
    await releaseCallToolsAuditLease()
  }
  for (const devServer of devServers) {
    devServer.kill('SIGTERM')
  }
  if (calltoolsAgentSessionProcess) {
    calltoolsAgentSessionProcess.kill('SIGTERM')
  }
}

if (!liveProofPayload && liveProofPath) {
  const loaded = await readLiveProofPayload(liveProofPath)
  liveProofPayload = loaded.payload
}

const failed = results.filter((result) => result.status === 'failed')
const skipped = results.filter((result) => result.status === 'skipped')
const liveProofInfo = buildLiveProofInfo()
const payload = {
  ok: failed.length === 0,
  schemaVersion: 'speak.full-e2e-audit.v1',
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  localBaseUrl,
  renderedBaseUrl,
  productionMode: includeProduction
    ? (sshHost ? 'ssh' : 'local-production-host')
    : 'not-requested',
  coverageMode: certificationRequired ? 'certification' : 'regression',
  certificationRequired,
  includeLive,
  liveProof: liveProofInfo,
  liveProofPath,
  generatedLiveProofDir,
  generatedLiveProofPath,
  summary: {
    passed: results.filter((result) => result.status === 'passed').length,
    failed: failed.length,
    skipped: skipped.length,
    total: results.length,
  },
  results,
}

function buildLiveProofInfo() {
  const supplied = Boolean(explicitLiveProofPath)
  const generated = Boolean(generatedLiveProofPath)
  const required = certificationRequired || includeLive || supplied
  const accepted = liveProofValidation
    ? Boolean(liveProofValidation.ok)
    : Boolean(liveProofPayload?.ok)
  const checked = results.some((result) =>
    result.group === 'live-proof-gated' &&
    result.status === 'passed' &&
    (result.command === 'supplied-live-proof' || result.command === 'qa:calltools-live-proof'),
  ) && accepted
  return {
    required,
    checked,
    mode: supplied && includeLive
      ? (generated ? 'supplied_and_generated' : 'supplied_with_generation_attempt')
      : supplied
        ? 'supplied'
        : includeLive
          ? (generated ? 'generated' : 'generation_attempted')
          : 'not_requested',
    sourcePath: liveProofPath,
    generatedPath: generatedLiveProofPath,
    callControlId: liveProofCallControlId(liveProofPayload),
    ok: accepted,
    validation: liveProofValidation
      ? {
          ok: Boolean(liveProofValidation.ok),
          note: liveProofValidation.note || '',
          errors: liveProofValidation.errors || [],
        }
      : null,
  }
}

function recordCertificationModeFlagFailures() {
  if (!certificationRequired) return
  if (skipBuild) {
    recordFailure('certification-mode', [
      'build:speak',
    ], 'Certification mode cannot use --skip-build; no-caveat release certification must prove the production build.')
  }
  if (skipRendered) {
    recordFailure('certification-mode', [
      'rendered-ui',
    ], 'Certification mode cannot use --skip-rendered-ui; no-caveat release certification must prove rendered browser UI.')
  }
  if (allowPendingCallToolsRecordingTranscript) {
    recordFailure('certification-mode', [
      'audit:calltools-recording-transcript',
    ], 'Certification mode cannot use --allow-pending-calltools-recording-transcript; recording-derived transcript comparison must be complete.')
  }
}

if (json) {
  console.log(JSON.stringify(payload, null, 2))
} else {
  console.log(`Speak full E2E audit: ${payload.ok ? 'passed' : 'failed'}`)
  console.log(`Checks: ${payload.summary.passed} passed, ${payload.summary.failed} failed, ${payload.summary.skipped} skipped`)
  for (const result of results) {
    const marker = result.status === 'passed' ? 'PASS' : result.status === 'skipped' ? 'SKIP' : 'FAIL'
    console.log(`[${marker}] ${result.group} / ${result.command}${result.note ? ` - ${result.note}` : ''}`)
  }
}

process.exit(payload.ok ? 0 : 1)

async function ensureLocalDevServer() {
  const uiReady = await canFetch(renderedBaseUrl)
  const apiReady = await canFetch(devHealthUrl)
  if (uiReady && apiReady) return

  if (!apiReady) startLocalDevProcess('dev:api')
  if (!uiReady) startLocalDevProcess('dev:ui')

  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if ((await canFetch(renderedBaseUrl)) && (await canFetch(devHealthUrl))) return
    await delay(500)
  }
  throw new Error(`Local dev server did not become ready at ${renderedBaseUrl}`)
}

function startLocalDevProcess(script) {
  const devServer = spawn('npm', ['run', script], {
    cwd: process.cwd(),
    env: localDevServerEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  devServers.add(devServer)
  devServer.stdout.on('data', () => {})
  devServer.stderr.on('data', () => {})
  devServer.once('close', () => devServers.delete(devServer))
  return devServer
}

async function runGroup(group, commands) {
  let ok = true
  for (const [script, ...extraArgs] of commands) {
    const started = Date.now()
    const result = await runAuditScript(group, script, extraArgs)
    if (result.code !== 0) ok = false
    results.push({
      group,
      command: script,
      status: result.code === 0 ? 'passed' : 'failed',
      durationMs: Date.now() - started,
      exitCode: result.code,
      note: result.code === 0 ? '' : snippet(result.output),
    })
  }
  return ok
}

async function runCallToolsPreflightGroup() {
  const setupOk = await runGroup('calltools-preflight', calltoolsPreflightCommands)
  if (!setupOk) return false
  if (includeLive) {
    const sessionOk = await runCallToolsAgentSessionForAudit({ ready: true })
    if (!sessionOk) return false
  }
  return runGroup('calltools-preflight', [calltoolsReadinessCommand])
}

function callToolsPreflightReady() {
  if (!requireCallToolsReady) return true
  return !results.some((result) =>
    result.status === 'failed' &&
    (
      result.group === 'calltools-preflight' ||
      (result.group === 'live-proof-gated' && result.command === 'calltools:agent-session')
    ),
  )
}

function runCallToolsAgentSessionForAudit({ ready = true, releaseScope = null } = {}) {
  const started = Date.now()
  const scopedProfileId = firstText(releaseScope?.profileId, calltoolsProfileId)
  const args = [
    'run',
    'calltools:agent-session',
    '--',
    '--apply',
    `--ready=${ready ? 'true' : 'false'}`,
    `--baseUrl=${productionBaseUrl}`,
    ...(scopedProfileId ? [`--profileId=${scopedProfileId}`] : []),
    ...(releaseScope?.leaseId ? [`--expectedLeaseId=${releaseScope.leaseId}`] : []),
    ...(releaseScope?.appUserId ? [`--appUserId=${releaseScope.appUserId}`] : []),
    ...(releaseScope?.campaignId ? [`--campaignId=${releaseScope.campaignId}`] : []),
    ...(releaseScope?.phoneId ? [`--phoneId=${releaseScope.phoneId}`] : []),
    ...(ready ? ['--require-campaign-ready'] : []),
    `--timeoutMs=${calltoolsAgentSessionTimeoutMs}`,
  ]
  return new Promise((resolve) => {
    const child = spawn('npm', args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        VITE_BASE_PATH: process.env.VITE_BASE_PATH || '/speak/',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    calltoolsAgentSessionProcess = child
    let output = ''
    let settled = false
    const settle = (code, payload = null) => {
      if (settled) return
      settled = true
      const ok = code === 0 && Boolean(payload?.ok)
      if (ok && ready) {
        calltoolsAgentSessionPayload = payload
        const ownedLease = callToolsOwnedLeaseFromPayload(payload)
        if (ownedLease) calltoolsOwnedLease = ownedLease
      }
      results.push({
        group: releaseScope ? 'calltools-cleanup' : 'calltools-preflight',
        command: ready ? 'calltools:agent-session' : 'calltools:agent-session:release',
        status: ok ? 'passed' : 'failed',
        durationMs: Date.now() - started,
        exitCode: ok ? 0 : (code || 1),
        note: ok
          ? callToolsAgentSessionSummary(payload, { ready })
          : callToolsAgentSessionFailureSummary(payload, output),
      })
      resolve(ok)
    }
    const handleOutput = (chunk, stderr = false) => {
      const text = chunk.toString()
      output += text
      if (json || stderr) {
        process.stderr.write(text)
      } else {
        process.stdout.write(text)
      }
      const payload = extractJsonPayload(output)
      if (payload?.schemaVersion === 'speak.calltools-agent-session-helper.v1') {
        settle(payload.ok ? 0 : 1, payload)
      }
    }
    child.stdout.on('data', (chunk) => handleOutput(chunk, false))
    child.stderr.on('data', (chunk) => handleOutput(chunk, true))
    child.on('close', (code) => {
      const payload = extractJsonPayload(output)
      settle(code ?? 1, payload)
      if (calltoolsAgentSessionProcess === child) calltoolsAgentSessionProcess = null
    })
    child.on('error', (error) => {
      output += `${error.message}\n`
      settle(1, null)
      if (calltoolsAgentSessionProcess === child) calltoolsAgentSessionProcess = null
    })
  })
}

function callToolsOwnedLeaseFromPayload(payload = {}) {
  const ownership = payload?.leaseOwnership || {}
  const binding = ownership.binding || {}
  if (ownership.owned !== true) return null
  const scope = {
    leaseId: firstText(ownership.leaseId),
    profileId: firstText(ownership.profileId, payload.profileId),
    appUserId: firstText(binding.appUserId),
    campaignId: firstText(binding.campaignId),
    phoneId: firstText(binding.phoneId),
  }
  return Object.values(scope).every(Boolean) ? scope : null
}

async function releaseCallToolsAuditLease() {
  const ownedLease = calltoolsOwnedLease
  if (!ownedLease) return true
  const released = await runCallToolsAgentSessionForAudit({
    ready: false,
    releaseScope: ownedLease,
  })
  if (released) calltoolsOwnedLease = null
  return released
}

function callToolsAgentSessionSummary(payload = {}, { ready = true } = {}) {
  const session = payload?.readiness?.agentSession || {}
  return [
    ready ? 'backend AgentStatus ensured' : 'backend AgentStatus paused',
    session.name ? `agent: ${session.name}` : '',
    `loggedIn=${Boolean(session.loggedIn)}`,
    `nativeLoggedIn=${Boolean(session.nativeLoggedIn)}`,
    session.campaignLoginProof ? `campaignLoginProof=${session.campaignLoginProof}` : '',
    session.campaignAgentProof ? `campaignAgentProof=${session.campaignAgentProof}` : '',
    `ready=${Boolean(session.ready)}`,
    session.webPhoneStatus ? `webPhoneStatus=${session.webPhoneStatus}` : '',
    session.webPhoneRegisteredOn ? `webPhoneRegisteredOn=${session.webPhoneRegisteredOn}` : '',
  ].filter(Boolean).join('; ')
}

function callToolsAgentSessionFailureSummary(payload = {}, output = '') {
  const session = payload?.readiness?.agentSession || {}
  return [
    payload?.status ? `status=${payload.status}` : '',
    payload?.readiness?.campaignBlockers?.length
      ? `campaignBlockers=${payload.readiness.campaignBlockers.join(',')}`
      : '',
    session.webPhoneStatus ? `webPhoneStatus=${session.webPhoneStatus}` : '',
    session.webPhoneRegisteredOn ? `webPhoneRegisteredOn=${session.webPhoneRegisteredOn}` : '',
    payload?.nextActions?.length ? `nextActions=${payload.nextActions.join(' ')}` : '',
    !payload ? snippet(output) : '',
  ].filter(Boolean).join('; ') || snippet(output)
}

async function runAuditScript(group, script, extraArgs = []) {
  return runCommand('npm', ['run', script, ...(extraArgs.length ? ['--', ...extraArgs] : [])], {
    group,
    command: script,
  })
}

async function runLiveProofGroup() {
  const script = 'qa:calltools-live-proof'
  const selectedProfileId = firstText(calltoolsAgentSessionPayload?.profileId, calltoolsProfileId)
  const selectedCampaignId = firstText(
    calltoolsAgentSessionPayload?.readiness?.agentSession?.campaignId,
    calltoolsCampaignId,
  )
  const liveProofArgs = [
    `--startedAfter=${startedAt.toISOString()}`,
    `--waitMs=${campaignProofWaitMs}`,
    `--pollMs=${campaignProofPollMs}`,
    ...(selectedProfileId ? [`--profileId=${selectedProfileId}`] : []),
    ...(selectedCampaignId ? [`--campaignId=${selectedCampaignId}`] : []),
    ...(calltoolsRecordingTranscriptLogFile
      ? [`--log=${calltoolsRecordingTranscriptLogFile}`]
      : []),
    ...(calltoolsRecordingTranscriptAudioDir
      ? [`--callAudioDir=${calltoolsRecordingTranscriptAudioDir}`]
      : []),
    ...(options.recordingReview ? [`--recordingReview=${options.recordingReview}`] : []),
  ]
  const proofStartedAt = Date.now()
  const result = await runLiveProofCommand(script, liveProofArgs)
  const proof = extractJsonPayload(result.output)
  const artifactPath = proof ? writeLiveProofArtifact(script, proof) : ''
  const passed = result.code === 0 && proof?.ok === true
  if (proof) liveProofPayload = proof
  results.push({
    group: 'live-proof-gated',
    command: script,
    status: passed ? 'passed' : 'failed',
    durationMs: Date.now() - proofStartedAt,
    exitCode: passed ? 0 : (result.code || 1),
    note: passed
      ? `artifact: ${artifactPath}`
      : [
          proof?.error ? `error: ${proof.error}` : snippet(result.output),
          proof?.operatorAction ||
            'Keep the selected CallTools campaign active and the Speak agent Available until one answered human call is routed to Speak, then rerun --include-live.',
          artifactPath ? `artifact: ${artifactPath}` : '',
        ].filter(Boolean).join(' | '),
  })
  return passed ? artifactPath : ''
}

async function recordSuppliedLiveProofArtifact() {
  const started = Date.now()
  const loaded = await readLiveProofPayload(liveProofPath)
  liveProofPayload = loaded.payload
  const callControlId = liveProofCallControlId(liveProofPayload)
  const validation = loaded.payload
    ? await validateSuppliedLiveProofArtifact(liveProofPayload)
    : { ok: false, note: loaded.error || 'Live proof artifact was not readable.' }
  liveProofValidation = validation
  const status = validation.ok ? 'passed' : 'failed'
  results.push({
    group: 'live-proof-gated',
    command: 'supplied-live-proof',
    status,
    durationMs: Date.now() - started,
    exitCode: status === 'passed' ? 0 : 1,
    note: status === 'passed'
      ? [
          `artifact: ${liveProofPath}`,
          callControlId ? `callControlId: ${callControlId}` : '',
          validation.note,
        ].filter(Boolean).join(' | ')
      : [
          loaded.error,
          validation.note,
          validation.errors?.length ? `errors: ${validation.errors.join('; ')}` : '',
        ].filter(Boolean).join(' | ') || `Live proof artifact was not accepted: ${liveProofPath}`,
  })
}

async function validateSuppliedLiveProofArtifact(payload = {}) {
  const errors = []
  const callControlId = liveProofCallControlId(payload)
  const subject = liveProofSubject(payload)
  if (!payload?.ok) errors.push('artifact ok=false')
  if (!callControlId) errors.push('callControlId missing')
  if (!subject?.ok) errors.push('live proof subject ok=false')
  if (subject?.callControlId && callControlId && subject.callControlId !== callControlId) {
    errors.push(`subject callControlId mismatch: ${subject.callControlId}`)
  }
  const campaignProofArtifact = payload?.schemaVersion === 'speak.calltools.campaign-proof.v1'
  if (certificationRequired && !campaignProofArtifact) {
    errors.push('certification mode requires speak.calltools.campaign-proof.v1 supplied proof')
  }
  if (campaignProofArtifact) {
    if (payload.accepted !== true || payload.nativeInviteReceived !== true) {
      errors.push('campaign proof is missing lease-authorized native invite acceptance')
    }
    if (payload.nativeGatewayAttached !== true || payload.answered !== true) {
      errors.push('campaign proof is missing native gateway attach/answer proof')
    }
    if (payload.identity?.ok !== true) {
      errors.push('campaign proof profile/campaign/provider identity failed')
    }
    if (
      payload.identity?.authoritative !== true ||
      !payload.identity?.leaseId ||
      !payload.identity?.appUserId ||
      !payload.identity?.phoneId ||
      !Number.isFinite(Date.parse(payload.identity?.verifiedAt || ''))
    ) {
      errors.push('campaign proof is missing lease-bound provider-authoritative identity')
    }
    if (calltoolsProfileId && payload.identity?.profileId !== calltoolsProfileId) {
      errors.push(`campaign proof profile mismatch: ${payload.identity?.profileId || 'missing'}`)
    }
    if (calltoolsCampaignId && payload.identity?.campaignId !== calltoolsCampaignId) {
      errors.push(`campaign proof campaign mismatch: ${payload.identity?.campaignId || 'missing'}`)
    }
    if (payload.recordingTranscriptReview && payload.recordingTranscriptOk !== true) {
      errors.push('campaign proof recording-derived transcript review failed')
    }
  }
  if (certificationRequired && payload?.recordingTranscriptOk !== true) {
    errors.push('certification mode requires recordingTranscriptOk=true for supplied campaign proof')
  }
  const age = liveProofArtifactAgeStatus(payload)
  if (!age.ok) errors.push(age.error)
  const replay = callControlId
    ? await replaySuppliedLiveProofArtifact(callControlId, payload)
    : { ok: false, note: 'replay skipped without callControlId' }
  if (!replay.ok) errors.push(replay.note || 'live proof replay failed')
  return {
    ok: errors.length === 0,
    errors,
    note: [
      age.note,
      replay.note,
    ].filter(Boolean).join(' | '),
  }
}

function liveProofSubject(payload = {}) {
  return payload?.calltools && typeof payload.calltools === 'object'
    ? payload.calltools
    : payload
}

function liveProofArtifactAgeStatus(payload = {}) {
  const timestamps = [
    payload?.identity?.verifiedAt,
    payload?.startedAt,
    payload?.finishedAt,
    payload?.transcriptParity?.identity?.firstEventAt,
    payload?.transcriptParity?.identity?.lastEventAt,
    ...Object.values(payload?.timestamps || {}),
    ...Object.values(payload?.calltools?.timestamps || {}),
    ...Object.values(payload?.preFinalizeCalltools?.timestamps || {}),
  ]
    .map((value) => Date.parse(String(value || '')))
    .filter(Number.isFinite)
  if (!timestamps.length) {
    return { ok: false, error: 'live proof artifact has no parseable event timestamp' }
  }
  const newestMs = Math.max(...timestamps)
  const ageMs = Date.now() - newestMs
  if (ageMs < -5 * 60 * 1000) {
    return {
      ok: false,
      error: `live proof artifact timestamp is in the future by ${formatDuration(Math.abs(ageMs))}`,
    }
  }
  if (liveProofMaxAgeMs > 0 && ageMs > liveProofMaxAgeMs) {
    return {
      ok: false,
      error: `live proof artifact is stale: ${formatDuration(ageMs)} old`,
    }
  }
  return {
    ok: true,
    note: `artifact age: ${formatDuration(Math.max(0, ageMs))}`,
  }
}

async function replaySuppliedLiveProofArtifact(callControlId, payload = {}) {
  const proofLogFile = callToolsRecordingTranscriptLogFromLiveProof(payload)
  const args = [
    `--callControlId=${callControlId}`,
    ...(proofLogFile ? [`--log=${proofLogFile}`] : []),
    ...(calltoolsRecordingTranscriptAudioDir ? [`--callAudioDir=${calltoolsRecordingTranscriptAudioDir}`] : []),
  ]
  const result = sshHost
    ? await runCapturedCommand('ssh', [
        sshHost,
        `cd ${shellQuote(remoteCwd)} && npm run ${shellQuote('qa:calltools-live-proof')} -- ${args.map(shellQuote).join(' ')}`,
      ])
    : await runCapturedCommand('npm', [
        'run',
        'qa:calltools-live-proof',
        '--',
        ...args,
      ])
  const replay = extractJsonPayload(result.output)
  const replayCallControlId = liveProofCallControlId(replay)
  const ok =
    result.code === 0 &&
    Boolean(replay?.ok) &&
    replayCallControlId === callControlId
  return {
    ok,
    note: ok
      ? `replayed proof from log${proofLogFile ? `: ${proofLogFile}` : ''}`
      : [
          `proof replay failed${proofLogFile ? ` from ${proofLogFile}` : ''}`,
          result.code ? `exit ${result.code}` : '',
          replayCallControlId && replayCallControlId !== callControlId
            ? `replay callControlId mismatch: ${replayCallControlId}`
            : '',
          replay?.error ? `error: ${replay.error}` : '',
          !replay ? snippet(result.output) : '',
        ].filter(Boolean).join(' | '),
  }
}

function startCallToolsRecordingTranscriptForLiveProof() {
  return runCallToolsRecordingTranscriptForLiveProof().catch((error) => {
    results.push({
      group: 'calltools-recording-transcript-review',
      command: 'audit:calltools-recording-transcript',
      status: 'failed',
      exitCode: 1,
      note: error instanceof Error ? error.message : String(error),
    })
  })
}

async function runCallToolsRecordingTranscriptForLiveProof() {
  const started = Date.now()
  if (!liveProofPayload && liveProofPath) {
    const loaded = await readLiveProofPayload(liveProofPath)
    liveProofPayload = loaded.payload
  }
  if (liveProofPayload?.recordingTranscriptReview?.ok === true) {
    results.push({
      group: 'calltools-recording-transcript-review',
      command: 'audit:calltools-recording-transcript',
      status: 'passed',
      durationMs: Date.now() - started,
      exitCode: 0,
      note: [
        'status: proof-embedded-clean-review',
        liveProofPayload.recordingTranscriptReview.status
          ? `reviewStatus: ${liveProofPayload.recordingTranscriptReview.status}`
          : '',
        liveProofPayload.recordingTranscriptReview.logFile
          ? `log: ${liveProofPayload.recordingTranscriptReview.logFile}`
          : '',
      ].filter(Boolean).join(' | '),
    })
    return
  }
  const callControlId = liveProofCallControlId(liveProofPayload)
  if (!callControlId) {
    results.push({
      group: 'calltools-recording-transcript-review',
      command: 'audit:calltools-recording-transcript',
      status: 'failed',
      durationMs: Date.now() - started,
      exitCode: 1,
      note: 'Live proof artifact does not include a callControlId for recording-derived transcript review.',
    })
    return
  }
  const deadline = Date.now() + calltoolsRecordingTranscriptWaitMs
  const attempts = []
  let result = null
  let payload = null
  let recordingComparisonReady = false
  do {
    result = await runCallToolsRecordingTranscriptCommand(callControlId)
    payload = extractJsonPayload(result.output)
    recordingComparisonReady = callToolsRecordingTranscriptComparisonReady(payload)
    attempts.push({
      status: payload?.status || 'unknown',
      recordingEvidence: callToolsRecordingTranscriptEvidenceLabel(payload),
      exitCode: result.code,
      elapsedMs: Date.now() - started,
    })
    if (recordingComparisonReady) break
    if (Date.now() >= deadline) break
    await delay(Math.min(calltoolsRecordingTranscriptPollMs, Math.max(0, deadline - Date.now())))
  } while (Date.now() < deadline)
  const findings = Array.isArray(payload?.findings)
    ? payload.findings.map((finding) => `${finding.severity}:${finding.code}`).slice(0, 6).join(', ')
    : ''
  const transcriptStatusOk =
    result?.code === 0 &&
    Boolean(payload?.ok) &&
    (recordingComparisonReady || (allowPendingCallToolsRecordingTranscript && !certificationRequired))
  results.push({
    group: 'calltools-recording-transcript-review',
    command: 'audit:calltools-recording-transcript',
    status: transcriptStatusOk ? 'passed' : 'failed',
    durationMs: Date.now() - started,
    exitCode: transcriptStatusOk ? 0 : (result?.code || 1),
    note: transcriptStatusOk
      ? [
          payload?.status ? `status: ${payload.status}` : '',
          `recordingEvidence: ${callToolsRecordingTranscriptEvidenceLabel(payload)}`,
          attempts.length > 1 ? `attempts: ${attempts.length}` : '',
          findings,
        ].filter(Boolean).join(' | ')
      : [
          result?.code !== 0 ? snippet(result.output) : '',
          recordingComparisonReady ? '' : `recording-derived comparison unavailable after ${formatDuration(Date.now() - started)} (${attempts.length} attempts)`,
          `last recordingEvidence: ${callToolsRecordingTranscriptEvidenceLabel(payload)}`,
          findings,
        ].filter(Boolean).join(' | '),
  })
}

function runCallToolsRecordingTranscriptCommand(callControlId) {
  const proofLogFile = calltoolsRecordingTranscriptLogFile || callToolsRecordingTranscriptLogFromLiveProof(liveProofPayload)
  const auditArgs = [
    `--callControlId=${callControlId}`,
    '--json',
    ...(proofLogFile ? [`--log=${proofLogFile}`] : []),
    ...(calltoolsRecordingTranscriptAudioDir ? [`--callAudioDir=${calltoolsRecordingTranscriptAudioDir}`] : []),
    ...(calltoolsRecordingFile ? [`--recordingFile=${calltoolsRecordingFile}`] : []),
    '--transcribeRecording',
    '--require-clean',
  ]
  if (sshHost) {
    return runCapturedCommand('ssh', [
      sshHost,
      `cd ${shellQuote(remoteCwd)} && npm run ${shellQuote('audit:calltools-recording-transcript')} -- ${auditArgs.map(shellQuote).join(' ')}`,
    ])
  }
  return runCapturedCommand('npm', [
    'run',
    'audit:calltools-recording-transcript',
    '--',
    ...auditArgs,
  ])
}

function callToolsRecordingTranscriptComparisonReady(payload = {}) {
  const recordingReferenceReady =
    Boolean(payload?.calltoolsCall?.recordingReference?.available) ||
    Boolean(payload?.downloadedRecording?.callRecordingFsFileId)
  const recordingTranscriptReady =
    payload?.recordingTranscript?.status === 'generated' ||
    payload?.generatedRecordingTranscript?.status === 'available'
  return recordingReferenceReady && recordingTranscriptReady
}

function callToolsRecordingTranscriptEvidenceLabel(payload = {}) {
  if (
    payload?.recordingTranscript?.status === 'generated' ||
    payload?.generatedRecordingTranscript?.status === 'available'
  ) {
    return 'recording-derived-transcript'
  }
  if (payload?.recordingTranscript?.status) return `recording-${payload.recordingTranscript.status}`
  return 'unknown'
}

function callToolsRecordingTranscriptLogFromLiveProof(payload = {}) {
  const existingReviewLog = firstText(payload?.transcriptParity?.logFile)
  if (existingReviewLog) return existingReviewLog
  const date = dateOnly(firstText(
    payload?.timestamps?.inviteReceived,
    payload?.timestamps?.dialRequested,
    payload?.timestamps?.gatewayAttached,
    payload?.timestamps?.firstCallerAudio,
    payload?.timestamps?.firstUserMessage,
    payload?.calltools?.timestamps?.inviteReceived,
    payload?.calltools?.timestamps?.dialRequested,
    payload?.calltools?.timestamps?.gatewayAttached,
    payload?.calltools?.timestamps?.firstCallerAudio,
    payload?.calltools?.timestamps?.firstUserMessage,
    payload?.preFinalizeCalltools?.timestamps?.dialRequested,
    payload?.preFinalizeCalltools?.timestamps?.gatewayAttached,
    payload?.preFinalizeCalltools?.timestamps?.firstCallerAudio,
    payload?.preFinalizeCalltools?.timestamps?.firstUserMessage,
    payload?.transcriptParity?.identity?.firstEventAt,
    payload?.transcriptParity?.identity?.lastEventAt,
    payload?.startedAt,
  ))
  if (date) return path.join(callToolsLogDir(), `events-${date}.jsonl`)
  const callControlId = liveProofCallControlId(payload)
  return callControlId ? findCallToolsLogByCallControlId(callControlId) : ''
}

function findCallToolsLogByCallControlId(callControlId) {
  const id = firstText(callControlId)
  const dir = callToolsLogDir()
  if (!id || !existsSync(dir)) return ''
  const files = readdirSync(dir)
    .filter((file) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(file))
    .sort()
    .reverse()
    .slice(0, 14)
  for (const file of files) {
    const filePath = path.join(dir, file)
    try {
      if (readFileSync(filePath, 'utf8').includes(id)) return filePath
    } catch {
      // Ignore unreadable rotated logs and keep scanning recent candidates.
    }
  }
  return ''
}

function callToolsLogDir() {
  return process.env.CALL_LOG_DIR || process.env.SPEAK_CALL_LOG_DIR || 'call-logs'
}

async function runLiveProofCommand(script, extraArgs = []) {
  if (sshHost) {
    const argSuffix = extraArgs.length ? ` -- ${extraArgs.map(shellQuote).join(' ')}` : ''
    return runCommand(
      'ssh',
      [sshHost, `cd ${shellQuote(remoteCwd)} && npm run ${shellQuote(script)}${argSuffix}`],
      {
        group: 'live-proof-gated',
        command: script,
      },
    )
  }
  return runCommand('npm', ['run', script, ...(extraArgs.length ? ['--', ...extraArgs] : [])], {
    group: 'live-proof-gated',
    command: script,
  })
}

async function runProductionGroup() {
  const commands = [
    'qa:workspace-email',
    'qa:workspace-email-source',
    'qa:telnyx-source-routing',
    'qa:transport',
  ]
  for (const script of commands) {
    const started = Date.now()
    const result = sshHost
      ? await runCommand('ssh', [sshHost, `cd ${shellQuote(remoteCwd)} && npm run ${shellQuote(script)}`], {
          group: 'production-provider-routing',
          command: script,
        })
      : await runCommand('npm', ['run', script], {
          group: 'production-provider-routing',
          command: script,
        })
    results.push({
      group: 'production-provider-routing',
      command: script,
      status: result.code === 0 ? 'passed' : 'failed',
      durationMs: Date.now() - started,
      exitCode: result.code,
      note: result.code === 0 ? '' : snippet(result.output),
    })
  }
}

async function runRenderedUiGroup() {
  const previousBaseUrl = process.env.SPEAK_QA_BASE_URL
  const previousFailConsole = process.env.SPEAK_QA_FAIL_CONSOLE
  process.env.SPEAK_QA_BASE_URL = renderedBaseUrl
  process.env.SPEAK_QA_FAIL_CONSOLE = '1'
  try {
    await runGroup('rendered-ui', [
      ['qa:browser:check'],
      ['qa:ui-contract'],
    ])
  } finally {
    if (previousBaseUrl === undefined) {
      delete process.env.SPEAK_QA_BASE_URL
    } else {
      process.env.SPEAK_QA_BASE_URL = previousBaseUrl
    }
    if (previousFailConsole === undefined) {
      delete process.env.SPEAK_QA_FAIL_CONSOLE
    } else {
      process.env.SPEAK_QA_FAIL_CONSOLE = previousFailConsole
    }
  }
}

function shouldEnsureLocalRenderedServer(value) {
  try {
    const url = new URL(value)
    return ['127.0.0.1', 'localhost'].includes(url.hostname)
  } catch {
    return false
  }
}

function localDevServerEnv() {
  const env = {
    ...process.env,
    VITE_BASE_PATH: process.env.VITE_BASE_PATH || '/speak/',
  }
  if (shouldEnsureLocalRenderedServer(renderedBaseUrl)) {
    env.PUBLIC_BASE_URL = renderedBaseUrl
  }
  return env
}

function writeLiveProofArtifact(script, payload) {
  const dir = liveProofArtifactDir()
  const file = path.join(dir, `${script.replace(/[^a-z0-9-]+/gi, '-')}.json`)
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`)
  return file
}

function liveProofArtifactDir() {
  if (generatedLiveProofDir) return generatedLiveProofDir
  if (options.liveProofDir || process.env.SPEAK_FULL_AUDIT_LIVE_PROOF_DIR) {
    generatedLiveProofDir = options.liveProofDir || process.env.SPEAK_FULL_AUDIT_LIVE_PROOF_DIR
    mkdirSync(generatedLiveProofDir, { recursive: true })
  } else {
    generatedLiveProofDir = mkdtempSync(path.join(tmpdir(), 'speak-full-audit-'))
  }
  return generatedLiveProofDir
}

function extractJsonPayload(output) {
  const clean = stripAnsi(String(output || '')).trim()
  const end = clean.lastIndexOf('}')
  if (end < 0) return null
  let parsed = null
  let start = clean.indexOf('{')
  while (start >= 0 && start < end) {
    try {
      parsed = JSON.parse(clean.slice(start, end + 1))
      break
    } catch {
      start = clean.indexOf('{', start + 1)
    }
  }
  return parsed
}

async function readLiveProofPayload(filePath) {
  if (!filePath) return { payload: null, error: 'No live proof artifact path was provided.' }
  let raw = ''
  if (existsSync(filePath)) {
    raw = readFileSync(filePath, 'utf8')
  } else if (sshHost) {
    const result = await runCapturedCommand('ssh', [sshHost, `cat ${shellQuote(filePath)}`])
    if (result.code !== 0) {
      return {
        payload: null,
        error: `Live proof artifact was not readable on ${sshHost}: ${filePath}`,
      }
    }
    raw = result.output
  } else {
    return { payload: null, error: `Live proof artifact was not found: ${filePath}` }
  }
  try {
    return { payload: JSON.parse(raw), error: '' }
  } catch (error) {
    return {
      payload: null,
      error: `Live proof artifact is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

function liveProofCallControlId(payload = {}) {
  return String(
    payload?.callControlId ||
      payload?.identity?.speakCallControlId ||
      payload?.calltools?.callControlId ||
      payload?.proof?.callControlId ||
      '',
  ).trim()
}

function stripAnsi(value) {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
}

function recordSkip(group, commands, note) {
  for (const command of commands) {
    results.push({
      group,
      command,
      status: 'skipped',
      note,
    })
  }
}

function recordFailure(group, commands, note) {
  for (const command of commands) {
    results.push({
      group,
      command,
      status: 'failed',
      exitCode: 1,
      note,
    })
  }
}

function runCommand(command, args, { group, command: script }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        VITE_BASE_PATH: process.env.VITE_BASE_PATH || '/speak/',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString()
      output += text
      if (json) {
        process.stderr.write(text)
      } else {
        process.stdout.write(text)
      }
    })
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString()
      output += text
      process.stderr.write(chunk)
    })
    child.on('close', (code) => resolve({ code: code ?? 1, output }))
    child.on('error', (error) => {
      output += `${error.message}\n`
      console.error(`[${group}/${script}] ${error.message}`)
      resolve({ code: 1, output })
    })
  })
}

function runCapturedCommand(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        VITE_BASE_PATH: process.env.VITE_BASE_PATH || '/speak/',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      output += chunk.toString()
    })
    child.on('close', (code) => resolve({ code: code ?? 1, output }))
    child.on('error', (error) => {
      output += `${error.message}\n`
      resolve({ code: 1, output })
    })
  })
}

async function canFetch(url) {
  try {
    const response = await fetch(url, { method: 'GET' })
    return response.ok || response.status < 500
  } catch {
    return false
  }
}

function shellQuote(value = '') {
  return `'${String(value).replace(/'/g, "'\\''")}'`
}

function snippet(value, max = 420) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}...` : text
}

function numberOption(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : fallback
}

function firstText(...values) {
  for (const value of values) {
    const text = String(value || '').trim()
    if (text) return text
  }
  return ''
}

function dateOnly(value) {
  const text = firstText(value)
  if (!text) return ''
  return operationalDate(text)
}

function formatDuration(ms) {
  const number = Number(ms)
  if (!Number.isFinite(number)) return 'unknown'
  if (number >= 60_000) return `${Math.round(number / 60_000)}m`
  return `${Math.round(number)}ms`
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
