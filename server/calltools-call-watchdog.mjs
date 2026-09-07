import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { isActiveCallToolsDuty, normalizeDutyState } from './calltools-duty-monitor.mjs'

const DEFAULT_INTERVAL_MS = 5 * 60_000
const DEFAULT_MISSING_RESPONSE_AFTER_MS = 10_000
const DEFAULT_SLOW_RESPONSE_THRESHOLD_MS = 1_680
const DEFAULT_SEMANTIC_TIMEOUT_MS = 120_000
const MAX_CALLS_PER_REVIEW = 16
const MAX_TURNS_PER_CALL = 24
const MAX_INCIDENT_HISTORY = 200
const MAX_RUN_HISTORY = 100
const MAX_CHECKPOINTS = 2_000

const NORMAL_SEVERITIES = new Set(['info', 'warning', 'critical'])

export function auditCallToolsCallSummaries(
  summaries = [],
  {
    missingResponseAfterMs = DEFAULT_MISSING_RESPONSE_AFTER_MS,
    nowMs = Date.now(),
    slowResponseThresholdMs = DEFAULT_SLOW_RESPONSE_THRESHOLD_MS,
  } = {},
) {
  const issues = []
  for (const summary of Array.isArray(summaries) ? summaries : []) {
    if (String(summary?.provider || '').toLowerCase() !== 'calltools') continue
    const callControlId = cleanText(summary?.callControlId)
    if (!callControlId) continue

    const turns = participantTurns(summary?.transcript)
    const firstTurn = turns[0]
    const firstLeadIndex = turns.findIndex((turn) => turn.speaker === 'Lead')
    const firstAssistantIndex = turns.findIndex((turn) => turn.speaker === 'AI')
    const lastLeadIndex = findLastIndex(turns, (turn) => turn.speaker === 'Lead')
    const hasAssistantAfterLastLead =
      lastLeadIndex >= 0 && turns.slice(lastLeadIndex + 1).some((turn) => turn.speaker === 'AI')
    const terminalCallerRejection = ['not-interested', 'do-not-call'].includes(
      cleanText(summary?.outcome).toLowerCase().replaceAll('_', '-'),
    )
    const observedAt = new Date(Number(nowMs) || Date.now()).toISOString()

    if (firstTurn?.speaker === 'AI') {
      issues.push(
        issueFor(summary, {
          code: 'CALLTOOLS_ASSISTANT_BEFORE_CALLER',
          observedAt,
          severity: 'critical',
          summary: 'Assistant speech appeared before the first caller turn.',
          evidence: firstTurn.text,
        }),
      )
    }

    if (
      lastLeadIndex >= 0 &&
      !hasAssistantAfterLastLead &&
      !terminalCallerRejection &&
      callAgeMs(summary, nowMs) >= Math.max(1_000, Number(missingResponseAfterMs) || 0)
    ) {
      issues.push(
        issueFor(summary, {
          code: 'CALLTOOLS_CALLER_UNANSWERED',
          observedAt,
          severity: 'critical',
          summary: 'The caller completed a turn without a following assistant response.',
          evidence: turns[lastLeadIndex]?.text,
        }),
      )
    }

    const mediaOutPackets = finiteNumber(summary?.diagnostics?.counters?.calltoolsMediaOutPackets)
    if (firstAssistantIndex >= 0 && mediaOutPackets === 0) {
      issues.push(
        issueFor(summary, {
          code: 'CALLTOOLS_ASSISTANT_AUDIO_MISSING',
          observedAt,
          severity: 'critical',
          summary: 'Assistant text was produced but no CallTools audio packets were sent.',
          evidence: turns[firstAssistantIndex]?.text,
        }),
      )
    }

    const firstAudibleResponseMs = firstFiniteNumber([
      summary?.diagnostics?.voice?.firstAudibleCallerStopToAssistantAudioMs,
      summary?.diagnostics?.voice?.audibleResponseLatencySamplesMs?.[0],
    ])
    const firstResponseMs = firstFiniteNumber([
      firstAudibleResponseMs,
      summary?.diagnostics?.voice?.firstCallerStopToAssistantAudioMs,
      summary?.diagnostics?.speak?.callerStopLatencySamplesMs?.[0],
      summary?.diagnostics?.hume?.callerStopLatencySamplesMs?.[0],
      summary?.diagnostics?.timingMs?.firstUserMessageToFirstAssistantAudio,
    ])
    if (
      firstResponseMs !== null &&
      firstResponseMs > Math.max(250, Number(slowResponseThresholdMs) || 0)
    ) {
      issues.push(
        issueFor(summary, {
          code: 'CALLTOOLS_FIRST_RESPONSE_SLOW',
          observedAt,
          severity: 'warning',
          summary: `First assistant audio arrived ${Math.round(firstResponseMs)} ms after caller turn completion.`,
          evidence: '',
          metrics: {
            firstResponseMs: Math.round(firstResponseMs),
            source:
              firstAudibleResponseMs === null
                ? 'provider_or_transcript_timing'
                : 'conditioned_phone_pcm_activity',
          },
        }),
      )
    }

    const providerFailure = (Array.isArray(summary?.latestEvents) ? summary.latestEvents : [])
      .map(cleanText)
      .find((event) => {
        if (/voice session disconnected \(code (?:1000|1005)\)/i.test(event)) return false
        return /voice (?:error|session disconnected)|assistant audio missing|media gateway (?:failed|disconnected)|provider unavailable/i.test(
          event,
        )
      })
    if (providerFailure) {
      issues.push(
        issueFor(summary, {
          code: 'CALLTOOLS_PROVIDER_RUNTIME_FAILURE',
          observedAt,
          severity: 'critical',
          summary: 'The call log contains a voice-provider or media-gateway failure.',
          evidence: providerFailure,
        }),
      )
    }
  }

  return dedupeIssues(issues)
}

export async function reviewCallToolsTranscripts({
  agentInstructions = '',
  baseUrl = process.env.CODEX_AUTH_PROXY_BASE_URL || 'http://127.0.0.1:48765/v1',
  calls = [],
  fetchImpl = globalThis.fetch,
  model = process.env.CALLTOOLS_WATCHDOG_MODEL || 'gpt-5.6-sol',
  timeoutMs = DEFAULT_SEMANTIC_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('Transcript review requires fetch')
  const reviewCalls = (Array.isArray(calls) ? calls : [])
    .filter((summary) => String(summary?.provider || '').toLowerCase() === 'calltools')
    .map(publicReviewCall)
    .filter((summary) => summary.turns.length > 0)
    .slice(0, MAX_CALLS_PER_REVIEW)
  if (!reviewCalls.length) return { ok: true, model, reviews: [], skipped: true }

  const response = await fetchImpl(
    `${String(baseUrl || '').replace(/\/+$/g, '')}/chat/completions`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        reasoning_effort: 'xhigh',
        service_tier: 'priority',
        stream: false,
        max_completion_tokens: 8_000,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: transcriptReviewSystemPrompt(),
          },
          {
            role: 'user',
            content: JSON.stringify({
              agentInstructions: cleanMultiline(agentInstructions).slice(0, 16_000),
              calls: reviewCalls,
            }),
          },
        ],
      }),
      signal: AbortSignal.timeout(Math.max(5_000, Number(timeoutMs) || 0)),
    },
  )
  if (!response?.ok) {
    const detail = cleanText(await response?.text?.().catch(() => '')).slice(0, 240)
    throw new Error(
      `CallTools transcript review failed (HTTP ${Number(response?.status) || 0})${detail ? `: ${detail}` : ''}`,
    )
  }
  const payload = await response.json()
  const content = completionText(payload)
  const parsed = parseJsonObject(content)
  const allowedIds = new Set(reviewCalls.map((call) => call.callControlId))
  const normalizedReviews = (Array.isArray(parsed?.reviews) ? parsed.reviews : [])
    .map((review) => normalizeSemanticReview(review, allowedIds))
    .filter(Boolean)
  const reviewById = new Map(normalizedReviews.map((review) => [review.callControlId, review]))
  if (reviewById.size !== reviewCalls.length) {
    throw new Error('CallTools transcript review omitted one or more supplied calls')
  }
  const reviews = reviewCalls.map((call) => reviewById.get(call.callControlId))

  return {
    ok: true,
    model: cleanText(payload?.model || model),
    reviews,
    skipped: false,
    usage: normalizeUsage(payload?.usage),
  }
}

export function createCallToolsCallWatchdog({
  intervalMs = DEFAULT_INTERVAL_MS,
  logger = console,
  now = () => new Date(),
  onIncidents,
  readAgentInstructions,
  readDuty,
  readRecentCalls,
  reconcile,
  repair,
  reviewTranscripts = reviewCallToolsTranscripts,
  store,
} = {}) {
  assertFunction(readDuty, 'readDuty')
  assertFunction(readRecentCalls, 'readRecentCalls')
  assertFunction(reconcile, 'reconcile')
  if (onIncidents !== undefined) assertFunction(onIncidents, 'onIncidents')
  if (readAgentInstructions !== undefined) {
    assertFunction(readAgentInstructions, 'readAgentInstructions')
  }
  if (repair !== undefined) assertFunction(repair, 'repair')
  assertFunction(reviewTranscripts, 'reviewTranscripts')
  if (!store || typeof store.read !== 'function' || typeof store.write !== 'function') {
    throw new TypeError('CallTools watchdog requires a durable store')
  }

  const cadenceMs = Math.max(60_000, Number(intervalMs) || DEFAULT_INTERVAL_MS)
  let persisted = null
  let timer = null
  let started = false
  let operationQueue = Promise.resolve()
  let runtime = {
    active: false,
    intervalMs: cadenceMs,
    lastCheckedAt: '',
    lastError: '',
    lastIssueCount: 0,
    lastRepair: null,
    lastSemanticReview: null,
    status: 'idle',
  }

  async function loadPersisted() {
    if (persisted) return persisted
    persisted = normalizePersistedState(await store.read())
    return persisted
  }

  function runExclusive(operation) {
    const result = operationQueue.then(operation, operation)
    operationQueue = result.catch(() => undefined)
    return result
  }

  async function runNow() {
    return runExclusive(async () => {
      const checkedAtDate = normalizeDate(now())
      const checkedAt = checkedAtDate.toISOString()
      const state = await loadPersisted()
      const duty = normalizeDutyState(await readDuty())
      if (!isActiveCallToolsDuty(duty)) {
        runtime = {
          ...runtime,
          active: false,
          lastCheckedAt: checkedAt,
          lastError: '',
          lastIssueCount: 0,
          status: 'idle',
        }
        return publicRunResult(runtime)
      }

      runtime = {
        ...runtime,
        active: true,
        lastCheckedAt: checkedAt,
        lastError: '',
        status: 'checking',
      }
      const recentCalls = (await readRecentCalls({ duty, limit: 50 }))
        .filter((summary) => String(summary?.provider || '').toLowerCase() === 'calltools')
      const fingerprints = new Map(
        recentCalls.map((summary) => [summary.callControlId, callFingerprint(summary)]),
      )
      // Deterministic checks are intentionally cheap and run on every cycle.
      // A live caller turn may cross the missing-response threshold without its
      // transcript changing, and transport diagnostics may arrive after text.
      const deterministicCandidates = recentCalls
      const semanticCandidates = recentCalls.filter(
        (summary) =>
          participantTurns(summary.transcript).length > 0 &&
          state.semanticReviewed[summary.callControlId] !== fingerprints.get(summary.callControlId),
      )
      const semanticBatch = semanticCandidates.slice(0, MAX_CALLS_PER_REVIEW)
      const deterministicIssues = auditCallToolsCallSummaries(deterministicCandidates, {
        missingResponseAfterMs: numberEnv(
          'CALLTOOLS_WATCHDOG_MISSING_RESPONSE_MS',
          DEFAULT_MISSING_RESPONSE_AFTER_MS,
        ),
        nowMs: checkedAtDate.getTime(),
        slowResponseThresholdMs: numberEnv(
          'CALLTOOLS_WATCHDOG_SLOW_RESPONSE_MS',
          DEFAULT_SLOW_RESPONSE_THRESHOLD_MS,
        ),
      })

      let semanticResult = { ok: true, reviews: [], skipped: true }
      if (semanticBatch.length) {
        try {
          const agentInstructions = readAgentInstructions
            ? await readAgentInstructions({ duty })
            : ''
          semanticResult = await reviewTranscripts({
            agentInstructions,
            calls: semanticBatch,
            timeoutMs: numberEnv(
              'CALLTOOLS_WATCHDOG_SEMANTIC_TIMEOUT_MS',
              DEFAULT_SEMANTIC_TIMEOUT_MS,
            ),
          })
          for (const summary of semanticBatch) {
            state.semanticReviewed[summary.callControlId] = fingerprints.get(summary.callControlId)
          }
        } catch (error) {
          semanticResult = {
            ok: false,
            error: error instanceof Error ? error.message : 'Transcript review failed',
            reviews: [],
            skipped: false,
          }
        }
      }

      for (const summary of deterministicCandidates) {
        state.audited[summary.callControlId] = fingerprints.get(summary.callControlId)
      }
      const semanticIssues = semanticResult.reviews
        .filter((review) => review.normal === false)
        .map((review) => semanticReviewIssue(review, checkedAt))
      const incidents = dedupeNewIncidents(
        [...deterministicIssues, ...semanticIssues],
        state.incidentKeys,
      )

      let repairResult
      if (incidents.length && repair) {
        repairResult = await repair({ calls: recentCalls, duty, incidents })
      } else {
        repairResult = await reconcile({ duty })
      }
      if (incidents.length && onIncidents) {
        await onIncidents({ duty, incidents })
      }

      const run = {
        active: true,
        callCount: recentCalls.length,
        checkedAt,
        incidentCount: incidents.length,
        incidents,
        profileId: duty.profileId,
        repair: normalizeRepairResult(repairResult),
        semanticReview: normalizeSemanticRunResult(semanticResult),
      }
      state.incidents = [...state.incidents, ...incidents].slice(-MAX_INCIDENT_HISTORY)
      state.runs = [...state.runs, run].slice(-MAX_RUN_HISTORY)
      state.audited = trimCheckpointMap(state.audited)
      state.semanticReviewed = trimCheckpointMap(state.semanticReviewed)
      state.incidentKeys = trimCheckpointMap(state.incidentKeys)
      state.updatedAt = checkedAt
      await store.write(state)

      runtime = {
        ...runtime,
        active: true,
        lastCheckedAt: checkedAt,
        lastError: semanticResult.ok === false ? semanticResult.error : '',
        lastIssueCount: incidents.length,
        lastRepair: run.repair,
        lastSemanticReview: run.semanticReview,
        status:
          semanticResult.ok === false || run.repair.ok === false
            ? 'attention'
            : incidents.length
              ? 'issues_found'
              : 'healthy',
      }
      return publicRunResult(runtime)
    }).catch((error) => {
      runtime = {
        ...runtime,
        lastCheckedAt: normalizeDate(now()).toISOString(),
        lastError: error instanceof Error ? error.message : 'CallTools watchdog failed',
        status: 'error',
      }
      logger.warn?.('CallTools call watchdog failed:', runtime.lastError)
      throw error
    })
  }

  function scheduleNext(delayMs) {
    timer = setTimeout(async () => {
      const startedAt = Date.now()
      try {
        await runNow()
      } catch {
        // The next bounded cycle retries without changing operator-owned settings.
      } finally {
        if (started) scheduleNext(Math.max(1_000, cadenceMs - (Date.now() - startedAt)))
      }
    }, Math.max(0, Number(delayMs) || 0))
    timer.unref?.()
  }

  function start() {
    if (started) return
    started = true
    scheduleNext(0)
  }

  function stop() {
    started = false
    if (timer) clearTimeout(timer)
    timer = null
  }

  async function publicState() {
    const state = await loadPersisted()
    return {
      ...runtime,
      lastSemanticReview: publicSemanticRunResult(runtime.lastSemanticReview),
      backendOwned: true,
      recentIncidents: state.incidents.slice(-10).map(publicIncident),
      runCount: state.runs.length,
      vmResident: true,
    }
  }

  return { publicState, runNow, start, stop }
}

export function createCallToolsWatchdogStore({ filePath } = {}) {
  const resolvedPath = path.resolve(String(filePath || 'workspace-data/calltools-watchdog.json'))
  return {
    async read() {
      try {
        return JSON.parse(await readFile(resolvedPath, 'utf8'))
      } catch (error) {
        if (error?.code === 'ENOENT') return normalizePersistedState()
        throw error
      }
    },
    async write(value) {
      await mkdir(path.dirname(resolvedPath), { recursive: true })
      const temporaryPath = `${resolvedPath}.tmp-${randomUUID()}`
      await writeFile(temporaryPath, `${JSON.stringify(normalizePersistedState(value), null, 2)}\n`)
      await rename(temporaryPath, resolvedPath)
    },
  }
}

function transcriptReviewSystemPrompt() {
  return [
    'You are a strict quality watchdog for live outbound CallTools phone conversations.',
    'Evaluate the transcript against ordinary human turn-taking and the supplied active agent instructions.',
    'Do not assume a sales, support, or campaign flow unless the supplied instructions establish it.',
    'Flag only agent/runtime problems, not normal caller rejection, accents, short answers, background noise, or an ordinary hangup.',
    'Do not repeat phone numbers, email addresses, or personal names in summaries or evidence.',
    'Look for assistant speech before the caller, self-dialogue, ignored caller input, incoherent or unrelated replies, repeated loops, identity misuse, false tool-success claims, premature hangup, and drift from the instructed flow.',
    'Return JSON only with this shape: {"reviews":[{"callControlId":"...","normal":true,"severity":"info|warning|critical","codes":["UPPER_SNAKE_CASE"],"summary":"brief reason","evidence":[{"turn":1,"excerpt":"short excerpt"}],"recommendedAction":"brief action"}]}.',
    'Include exactly one review for each supplied call. A normal call must use normal=true, severity=info, empty codes, and a concise summary.',
  ].join(' ')
}

function publicReviewCall(summary = {}) {
  return {
    callControlId: cleanText(summary.callControlId),
    outcome: cleanText(summary.outcome),
    phase: cleanText(summary.phase),
    turns: participantTurns(summary.transcript)
      .slice(-MAX_TURNS_PER_CALL)
      .map((turn, index) => ({
        turn: index + 1,
        speaker: turn.speaker,
        text: turn.text.slice(0, 1_000),
      })),
  }
}

function normalizeSemanticReview(review = {}, allowedIds = new Set()) {
  const callControlId = cleanText(review.callControlId)
  if (!callControlId || !allowedIds.has(callControlId)) return null
  const normal = review.normal === true
  return {
    callControlId,
    normal,
    severity: normal
      ? 'info'
      : NORMAL_SEVERITIES.has(cleanText(review.severity).toLowerCase())
        ? cleanText(review.severity).toLowerCase()
        : 'warning',
    codes: normal
      ? []
      : [...new Set((Array.isArray(review.codes) ? review.codes : [])
          .map((code) => cleanText(code).toUpperCase().replace(/[^A-Z0-9]+/g, '_'))
          .filter(Boolean))].slice(0, 8),
    summary: cleanText(review.summary).slice(0, 400),
    evidence: (Array.isArray(review.evidence) ? review.evidence : [])
      .map((item) => ({
        turn: Math.max(0, Number(item?.turn) || 0),
        excerpt: cleanText(item?.excerpt).slice(0, 240),
      }))
      .filter((item) => item.turn || item.excerpt)
      .slice(0, 4),
    recommendedAction: cleanText(review.recommendedAction).slice(0, 300),
  }
}

function semanticReviewIssue(review, observedAt = new Date().toISOString()) {
  return {
    callControlId: review.callControlId,
    categoryCodes: review.codes,
    code: 'CALLTOOLS_TRANSCRIPT_ABNORMAL',
    evidence: review.evidence,
    observedAt,
    recommendedAction: review.recommendedAction,
    severity: review.severity,
    summary: review.summary || 'Semantic transcript review flagged abnormal call flow.',
  }
}

function issueFor(summary, issue) {
  return {
    callControlId: cleanText(summary?.callControlId),
    code: issue.code,
    evidence: cleanText(issue.evidence).slice(0, 240),
    metrics: issue.metrics || undefined,
    observedAt: issue.observedAt,
    severity: issue.severity,
    summary: issue.summary,
  }
}

function dedupeIssues(issues) {
  const seen = new Set()
  return issues.filter((issue) => {
    const key = `${issue.callControlId}\u0000${issue.code}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function dedupeNewIncidents(issues, incidentKeys) {
  return dedupeIssues(issues).filter((issue) => {
    const key = incidentKey(issue)
    if (incidentKeys[key]) return false
    incidentKeys[key] = issue.observedAt || new Date().toISOString()
    return true
  })
}

function incidentKey(issue) {
  const categories = Array.isArray(issue.categoryCodes) ? issue.categoryCodes.join(',') : ''
  return createHash('sha256')
    .update(`${issue.callControlId}\u0000${issue.code}\u0000${categories}\u0000${issue.summary || ''}`)
    .digest('hex')
}

function callFingerprint(summary) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        callControlId: cleanText(summary?.callControlId),
        outcome: cleanText(summary?.outcome),
        phase: cleanText(summary?.phase),
        transcript: participantTurns(summary?.transcript),
      }),
    )
    .digest('hex')
}

function participantTurns(transcript) {
  return (Array.isArray(transcript) ? transcript : [])
    .map((turn) => ({
      speaker: normalizeSpeaker(turn?.speaker),
      text: cleanText(turn?.text),
    }))
    .filter((turn) => turn.speaker && turn.text)
}

function normalizeSpeaker(value) {
  const speaker = cleanText(value).toLowerCase()
  if (['lead', 'caller', 'user', 'contact'].includes(speaker)) return 'Lead'
  if (['ai', 'assistant', 'agent'].includes(speaker)) return 'AI'
  return ''
}

function callAgeMs(summary, nowMs) {
  const timestamp = Date.parse(summary?.updatedAt || summary?.createdAt || '')
  if (!Number.isFinite(timestamp)) return Number.POSITIVE_INFINITY
  return Math.max(0, (Number(nowMs) || Date.now()) - timestamp)
}

function completionText(payload = {}) {
  const content = payload?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((item) => cleanText(item?.text || item?.content)).filter(Boolean).join('\n')
  }
  return ''
}

function parseJsonObject(value) {
  const text = String(value || '').trim()
  if (!text) throw new Error('CallTools transcript review returned no JSON')
  try {
    return JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) throw new Error('CallTools transcript review returned invalid JSON')
    return JSON.parse(text.slice(start, end + 1))
  }
}

function normalizePersistedState(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return {
    schemaVersion: 'speak.calltools-call-watchdog.v1',
    updatedAt: cleanText(source.updatedAt),
    audited: normalizeStringMap(source.audited),
    semanticReviewed: normalizeStringMap(source.semanticReviewed),
    incidentKeys: normalizeStringMap(source.incidentKeys),
    incidents: (Array.isArray(source.incidents) ? source.incidents : [])
      .filter((incident) => !isRetiredNormalCloseIncident(incident))
      .slice(-MAX_INCIDENT_HISTORY),
    runs: (Array.isArray(source.runs) ? source.runs : []).slice(-MAX_RUN_HISTORY),
  }
}

function isRetiredNormalCloseIncident(incident = {}) {
  return (
    cleanText(incident.code) === 'CALLTOOLS_PROVIDER_RUNTIME_FAILURE' &&
    /voice session disconnected \(code (?:1000|1005)\)/i.test(
      cleanText(incident.evidence),
    )
  )
}

function trimCheckpointMap(value) {
  return Object.fromEntries(Object.entries(normalizeStringMap(value)).slice(-MAX_CHECKPOINTS))
}

function normalizeStringMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, nested]) => [cleanText(key), cleanText(nested)])
      .filter(([key, nested]) => key && nested)
      .slice(-MAX_CHECKPOINTS),
  )
}

function normalizeSemanticRunResult(value = {}) {
  return {
    error: value.ok === false ? cleanText(value.error).slice(0, 300) : '',
    model: cleanText(value.model),
    ok: value.ok !== false,
    reviewCount: Array.isArray(value.reviews) ? value.reviews.length : 0,
    skipped: value.skipped === true,
    usage: normalizeUsage(value.usage),
  }
}

function publicSemanticRunResult(value) {
  if (!value || typeof value !== 'object') return null
  return {
    error: cleanText(value.error).slice(0, 300),
    model: cleanText(value.model),
    ok: value.ok !== false,
    reviewCount: Math.max(0, Number(value.reviewCount) || 0),
    skipped: value.skipped === true,
  }
}

function normalizeUsage(value = {}) {
  if (!value || typeof value !== 'object') return undefined
  return {
    completionTokens: Math.max(0, Number(value.completion_tokens) || Number(value.completionTokens) || 0),
    promptTokens: Math.max(0, Number(value.prompt_tokens) || Number(value.promptTokens) || 0),
    totalTokens: Math.max(0, Number(value.total_tokens) || Number(value.totalTokens) || 0),
  }
}

function normalizeRepairResult(value = {}) {
  if (!value || typeof value !== 'object') return { ok: value !== false }
  return {
    action: cleanText(value.action),
    error: value.ok === false ? cleanText(value.error).slice(0, 300) : '',
    ok: value.ok !== false,
    standbyReset: value.standbyReset === true,
    status: cleanText(value.status),
  }
}

function publicIncident(issue = {}) {
  return {
    callControlId: cleanText(issue.callControlId),
    categoryCodes: Array.isArray(issue.categoryCodes) ? issue.categoryCodes.slice(0, 8) : undefined,
    code: cleanText(issue.code),
    observedAt: cleanText(issue.observedAt),
    severity: cleanText(issue.severity),
  }
}

function publicRunResult(value = {}) {
  return {
    active: value.active === true,
    intervalMs: value.intervalMs,
    lastCheckedAt: value.lastCheckedAt,
    lastError: value.lastError,
    lastIssueCount: value.lastIssueCount,
    status: value.status,
  }
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function cleanMultiline(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim()
}

function normalizeDate(value) {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime()) ? date : new Date()
}

function finiteNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function firstFiniteNumber(values) {
  for (const value of values) {
    const number = finiteNumber(value)
    if (number !== null) return number
  }
  return null
}

function findLastIndex(values, predicate) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index], index)) return index
  }
  return -1
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function assertFunction(value, name) {
  if (typeof value !== 'function') {
    throw new TypeError(`CallTools watchdog requires ${name}`)
  }
}
