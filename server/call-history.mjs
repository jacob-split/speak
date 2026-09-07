import { randomUUID } from 'node:crypto'
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { buildTransportDiagnosticSnapshot } from './transport-diagnostics.mjs'
import { normalizeEmotionScores } from './hume-emotion-scores.mjs'
import { callLogFileName, operationalTimeLabel } from './operational-time.mjs'
import { cleanObject, safeLeadText } from './runtime-config.mjs'

let callEventAppendQueue = Promise.resolve()
const pendingCallEventRecords = new Set()
const callLogRewriteVersions = new Map()
const unreportedCallEventFailures = []
const callEventPersistenceStats = {
  enqueued: 0,
  pending: 0,
  completed: 0,
  failed: 0,
  canceled: 0,
}

export function recentCallSummaries({
  callStates,
  callLogDir,
  limit,
  leadForState,
}) {
  const memorySummaries = callStates.map((state) =>
    callSummaryFromState(state, leadForState),
  )
  const persistedSummaries = readPersistedCallSummaries(callLogDir, limit * 200)
  const byId = new Map()

  persistedSummaries.forEach((summary) => byId.set(summary.callControlId, summary))
  memorySummaries.forEach((summary) => byId.set(summary.callControlId, summary))

  return Array.from(byId.values())
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .slice(0, limit)
}

export function persistCallEvent({
  callLogDir,
  callControlId,
  state,
  event,
  leadForState,
}) {
  try {
    const recordedAt = new Date()
    const fileName = callLogFileName(recordedAt)
    const record = {
      at: recordedAt.toISOString(),
      persistenceId: randomUUID(),
      callControlId,
      lead: state ? leadForState(state) : null,
      agent: state ? agentContextFromState(state) : null,
      origin: safeLeadText(state?.origin),
      provider: state?.callProvider || '',
      event,
    }
    const line = `${JSON.stringify(record)}\n`
    const normalizedCallLogDir = path.resolve(callLogDir)
    const pendingRecord = {
      callLogDir: normalizedCallLogDir,
      filePath: path.join(normalizedCallLogDir, fileName),
      line,
      persistenceId: record.persistenceId,
      callControlId: String(callControlId || ''),
      canceled: false,
      written: false,
    }
    pendingCallEventRecords.add(pendingRecord)
    callEventPersistenceStats.enqueued += 1
    callEventPersistenceStats.pending += 1

    const run = callEventAppendQueue.then(() => persistPendingCallEvent(pendingRecord))
    callEventAppendQueue = run.then(
      () => {
        callEventPersistenceStats.pending -= 1
        pendingCallEventRecords.delete(pendingRecord)
      },
      (error) => {
        recordCallEventPersistenceFailure(error)
        callEventPersistenceStats.pending -= 1
        pendingCallEventRecords.delete(pendingRecord)
      },
    )
    return run
  } catch (error) {
    const failure = recordCallEventPersistenceFailure(error)
    const rejected = Promise.reject(failure)
    rejected.catch(() => {})
    return rejected
  }
}

export async function flushPersistedCallEvents() {
  while (true) {
    const observedQueue = callEventAppendQueue
    await observedQueue
    await new Promise((resolve) => setImmediate(resolve))
    if (
      observedQueue === callEventAppendQueue &&
      callEventPersistenceStats.pending === 0
    ) {
      break
    }
  }

  const failures = unreportedCallEventFailures.splice(0)
  if (failures.length) {
    throw new AggregateError(
      failures,
      `Failed to persist ${failures.length} call event${failures.length === 1 ? '' : 's'}`,
    )
  }
}

export function callEventPersistenceDiagnostics() {
  return {
    ...callEventPersistenceStats,
    unreportedFailures: unreportedCallEventFailures.length,
  }
}

export function deletePersistedCallSummaries({ callLogDir, callControlIds }) {
  const ids = new Set(
    (Array.isArray(callControlIds) ? callControlIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean),
  )
  if (!ids.size) {
    return { deleted: [], requested: Array.from(ids) }
  }

  const deleted = new Set()
  const normalizedCallLogDir = path.resolve(callLogDir)
  pendingCallEventRecords.forEach((pending) => {
    if (
      pending.callLogDir === normalizedCallLogDir &&
      ids.has(pending.callControlId)
    ) {
      pending.canceled = true
      deleted.add(pending.callControlId)
    }
  })
  incrementCallLogRewriteVersion(normalizedCallLogDir)
  if (!existsSync(normalizedCallLogDir)) {
    return { deleted: Array.from(deleted), requested: Array.from(ids) }
  }

  const files = readdirSync(normalizedCallLogDir).filter((file) =>
    /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(file),
  )

  files.forEach((file) => {
    const filePath = path.join(normalizedCallLogDir, file)
    const lines = readFileSync(filePath, 'utf8').split('\n')
    const retained = []
    lines.forEach((line) => {
      if (!line.trim()) return
      try {
        const record = JSON.parse(line)
        if (ids.has(String(record.callControlId || ''))) {
          deleted.add(String(record.callControlId || ''))
          return
        }
      } catch {
        retained.push(line)
        return
      }
      retained.push(line)
    })
    replaceCallLogFileSync(
      filePath,
      `${retained.join('\n')}${retained.length ? '\n' : ''}`,
    )
  })

  return {
    deleted: Array.from(deleted),
    requested: Array.from(ids),
  }
}

async function persistPendingCallEvent(pendingRecord) {
  if (pendingRecord.canceled) {
    callEventPersistenceStats.canceled += 1
    return
  }
  await mkdir(pendingRecord.callLogDir, { recursive: true })
  if (pendingRecord.canceled) {
    callEventPersistenceStats.canceled += 1
    return
  }

  while (true) {
    const rewriteVersion = callLogRewriteVersion(pendingRecord.callLogDir)
    await appendFile(pendingRecord.filePath, pendingRecord.line)
    if (pendingRecord.canceled) {
      callEventPersistenceStats.canceled += 1
      deletePersistedCallSummaries({
        callLogDir: pendingRecord.callLogDir,
        callControlIds: [pendingRecord.callControlId],
      })
      return
    }

    if (
      rewriteVersion === callLogRewriteVersion(pendingRecord.callLogDir) ||
      persistedCallEventExists(pendingRecord)
    ) {
      pendingRecord.written = true
      callEventPersistenceStats.completed += 1
      return
    }
  }
}

function persistedCallEventExists(pendingRecord) {
  try {
    return readFileSync(pendingRecord.filePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .some((line) => {
        try {
          return JSON.parse(line).persistenceId === pendingRecord.persistenceId
        } catch {
          return false
        }
      })
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function callLogRewriteVersion(callLogDir) {
  return callLogRewriteVersions.get(callLogDir) || 0
}

function incrementCallLogRewriteVersion(callLogDir) {
  callLogRewriteVersions.set(callLogDir, callLogRewriteVersion(callLogDir) + 1)
}

function replaceCallLogFileSync(filePath, contents) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporaryPath, contents)
    renameSync(temporaryPath, filePath)
  } finally {
    rmSync(temporaryPath, { force: true })
  }
}

function recordCallEventPersistenceFailure(error) {
  const failure = error instanceof Error ? error : new Error(String(error))
  callEventPersistenceStats.failed += 1
  unreportedCallEventFailures.push(failure)
  console.warn('Failed to persist call event', failure)
  return failure
}

export function transcriptEntry(speaker, text, tone = 'neutral', options = {}) {
  const entry = {
    id: `server-${randomUUID()}`,
    at: operationalTimeLabel(),
    speaker,
    text,
    tone,
  }
  const emotionScores = normalizeEmotionScores(options.emotionScores)
  if (emotionScores) entry.emotionScores = emotionScores
  if (options.providerEventId) {
    entry.providerEventId = String(options.providerEventId)
  }
  return entry
}

function callSummaryFromState(state, leadForState) {
  return summarizeCallEvents({
    callControlId: state.callControlId,
    lead: leadForState(state),
    agent: agentContextFromState(state),
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    events: state.eventLog,
    chatId: state.chatId,
    phase: state.eventLog.reduce((phase, event) => event.patch?.phase || phase, 'dialing'),
    outcome: state.outcome,
    origin: safeLeadText(state.origin),
    provider: state.callProvider || '',
    diagnostics: buildTransportDiagnosticSnapshot(state),
    audioQuality: state.audioQuality || null,
  })
}

function readPersistedCallSummaries(callLogDir, maxLines) {
  try {
    const lines = []
    if (existsSync(callLogDir)) {
      const files = readdirSync(callLogDir)
        .filter((file) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(file))
        .sort()
        .reverse()
        .slice(0, 3)
      files.forEach((file) => {
        const content = readFileSync(path.join(callLogDir, file), 'utf8')
        lines.push(...content.trim().split('\n').filter(Boolean))
      })
    }

    const diskRecords = lines.flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
    const normalizedCallLogDir = path.resolve(callLogDir)
    const queuedRecords = Array.from(pendingCallEventRecords)
      .filter((pending) => (
        !pending.canceled && !pending.written && pending.callLogDir === normalizedCallLogDir
      ))
      .flatMap((pending) => {
        try {
          return [JSON.parse(pending.line)]
        } catch {
          return []
        }
      })
    const records = [...diskRecords, ...queuedRecords].slice(-maxLines)
    const grouped = new Map()
    records.forEach((record) => {
      if (!record.callControlId) return
      const group =
        grouped.get(record.callControlId) ||
        {
          callControlId: record.callControlId,
          lead: record.lead,
          agent: record.agent,
          origin: safeLeadText(record.origin),
          provider: record.provider || '',
          createdAt: record.at,
          updatedAt: record.at,
          events: [],
        }
      group.lead = record.lead || group.lead
      group.agent = record.agent || group.agent
      group.origin = safeLeadText(record.origin) || group.origin
      group.provider = record.provider || group.provider
      group.updatedAt = record.at || group.updatedAt
      group.events.push({
        ...(record.event || {}),
        persistedAt: record.at,
      })
      grouped.set(record.callControlId, group)
    })

    return Array.from(grouped.values()).map(summarizeCallEvents)
  } catch (error) {
    console.warn('Failed to read call logs', error)
    return []
  }
}

function summarizeCallEvents(summaryInput) {
  const events = summaryInput.events || []
  const transcript = transcriptFromEvents(events)
  const agent = summaryInput.agent || agentContextFromEvents(events)
  const inworldRuntime = agent?.voiceRuntimeProvider === 'inworld'
  const notices = events
    .map((event) => event?.entry?.text || event?.notice || '')
    .filter(Boolean)
    .slice(-8)
  const outcome =
    summaryInput.outcome ||
    [...events].reverse().find((event) => event?.outcome || event?.patch?.outcome)
      ?.outcome ||
    [...events].reverse().find((event) => event?.outcome || event?.patch?.outcome)
      ?.patch?.outcome ||
    ''
  const phase = summarizedPhase(summaryInput.phase, outcome, events)
  const chatId =
    summaryInput.chatId ||
    [...events].reverse().find((event) => event?.patch?.chatId)?.patch?.chatId ||
    ''
  const audio =
    summaryInput.audio ||
    [...events].reverse().find((event) => event?.audio)?.audio ||
    (chatId && !inworldRuntime ? { status: 'requestable', source: 'speak' } : null)
  const diagnostics =
    summaryInput.diagnostics ||
    [...events].reverse().find((event) => event?.diagnostic)?.diagnostic ||
    null
  const audioQuality =
    summaryInput.audioQuality ||
    [...events].reverse().find((event) => event?.audioQuality)?.audioQuality ||
    null
  const communication =
    [...events].reverse().find((event) => event?.communication)?.communication || null
  const provider =
    summaryInput.provider ||
    communication?.provider ||
    communication?.providerIds?.provider ||
    ''
  const providerIds =
    publicProviderIds(summaryInput.providerIds) ||
    publicProviderIds(communication?.providerIds)
  const leadPatch = [...events].reverse().find((event) => event?.leadPatch)?.leadPatch
  const lead = {
    ...(summaryInput.lead || {}),
    ...(leadPatch?.patch || {}),
  }
  normalizeSummaryLeadIdentity(lead)
  if (!lead.name && !lead.first_name) {
    lead.name = extractLeadNameFromEvents(events)
  }

  return {
    callControlId: summaryInput.callControlId,
    chatId,
    agent,
    lead,
    createdAt: summaryInput.createdAt,
    updatedAt: summaryInput.updatedAt,
    phase,
    outcome,
    origin: safeLeadText(summaryInput.origin),
    provider,
    providerIds,
    insight: callInsight(outcome, transcript, notices),
    transcript,
    transcriptTurns: transcript.length,
    latestEvents: notices,
    audio,
    diagnostics,
    audioQuality,
  }
}

function publicProviderIds(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null
  const entries = Object.fromEntries(
    Object.entries(source)
      .filter(([key]) => isPublicProviderIdKey(key))
      .map(([key, value]) => [key, publicProviderIdValue(value)]),
  )
  const cleaned = cleanObject(entries)
  return Object.keys(cleaned).length ? cleaned : null
}

function publicProviderIdValue(value) {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return safeLeadText(value)
  }
  return ''
}

function isPublicProviderIdKey(key) {
  const normalized = String(key || '').trim()
  if (!normalized) return false
  const lower = normalized.toLowerCase()
  return lower.endsWith('id') || lower.endsWith('_id') || lower.endsWith('uuid')
}

function normalizeSummaryLeadIdentity(lead) {
  if (!lead || typeof lead !== 'object') return lead
  const businessName = cleanLeadLabel(lead.business_name || lead.company || '')
  const name = cleanLeadLabel(lead.name || '')
  const firstLast = cleanLeadLabel([lead.first_name, lead.last_name].filter(Boolean).join(' '))
  if (businessName && isGenericLeadLabel(name)) lead.name = businessName
  if (isGenericLeadLabel(firstLast)) {
    lead.first_name = ''
    lead.last_name = ''
  }
  if (!lead.name && businessName) lead.name = businessName
  return lead
}

function isGenericLeadLabel(value) {
  return /^(imported\s+lead(?:\s+\d+)?|unknown\s+lead|unknown\s+contact)$/i.test(
    cleanLeadLabel(value),
  )
}

function cleanLeadLabel(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function transcriptFromEvents(events) {
  const transcript = []
  const indexById = new Map()
  const indexByProviderEventId = new Map()
  const indexByFallbackKey = new Map()

  events
    .map((event) => transcriptEntryWithPersistedTime(event))
    .filter(
      (entry) =>
        entry &&
        ['AI', 'Lead', 'You'].includes(entry.speaker) &&
        entry.tone !== 'system',
    )
    .forEach((entry) => {
      const next = {
        speaker: entry.speaker,
        at: entry.at,
        text: entry.text,
      }
      const emotionScores = normalizeEmotionScores(entry.emotionScores)
      if (emotionScores) next.emotionScores = emotionScores
      if (entry.providerEventId) next.providerEventId = entry.providerEventId

      const providerEventId = entry.providerEventId
        ? `${entry.speaker}:${entry.providerEventId}`
        : ''
      const fallbackKey = `${entry.speaker}:${entry.at}:${normalizeTranscriptText(entry.text)}`
      const existingIndex =
        (entry.id && indexById.has(entry.id) ? indexById.get(entry.id) : undefined) ??
        (providerEventId && indexByProviderEventId.has(providerEventId)
          ? indexByProviderEventId.get(providerEventId)
          : undefined) ??
        (fallbackKey && indexByFallbackKey.has(fallbackKey)
          ? indexByFallbackKey.get(fallbackKey)
          : undefined)

      if (existingIndex !== undefined) {
        const index = existingIndex
        transcript[index] = {
          ...transcript[index],
          ...next,
          text: next.text || transcript[index].text,
          emotionScores: next.emotionScores || transcript[index].emotionScores,
          providerEventId:
            next.providerEventId || transcript[index].providerEventId,
        }
        return
      }

      if (entry.id) indexById.set(entry.id, transcript.length)
      if (providerEventId) indexByProviderEventId.set(providerEventId, transcript.length)
      if (fallbackKey) indexByFallbackKey.set(fallbackKey, transcript.length)
      transcript.push(next)
    })

  return transcript
}

function transcriptEntryWithPersistedTime(event = {}) {
  const entry = event?.entry
  if (!entry) return null
  return {
    ...entry,
    at: event.persistedAt ? operationalTimeLabel(event.persistedAt) : entry.at,
  }
}

function normalizeTranscriptText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function agentContextFromState(state) {
  const config = state?.config || {}
  const id = String(config.agentProfileId || '').trim()
  const name = String(config.agentProfileName || '').trim()
  const humeConfigId = String(config.humeConfigId || '').trim()
  const inworldConfigId = String(config.inworldConfigId || '').trim()
  const speakConfigId = String(config.speakConfigId || '').trim()
  const voiceRuntimeProvider = String(config.voiceRuntimeProvider || 'hume').trim()
  const voice = String(config.voice || '').trim()

  if (!id && !name && !humeConfigId && !inworldConfigId && !speakConfigId && !voice) {
    return null
  }

  return {
    id,
    name,
    voiceRuntimeProvider,
    speakConfigId,
    humeConfigId,
    inworldConfigId,
    voice,
  }
}

function summarizedPhase(summaryPhase, outcome, events) {
  if (
    outcome &&
    events.some((event) => event?.patch?.phase === 'ended')
  ) {
    return 'ended'
  }

  return (
    summaryPhase ||
    [...events].reverse().find((event) => event?.patch?.phase)?.patch?.phase ||
    'idle'
  )
}

function agentContextFromEvents(events) {
  return [...events].reverse().find((event) => event?.agent)?.agent || null
}

function extractLeadNameFromEvents(events) {
  const accepted = events
    .map((event) => event?.entry?.text || '')
    .find(
      (text) =>
        text.startsWith('Phone provider accepted the call request for ') ||
        text.startsWith('Telnyx accepted the call request for '),
    )
  if (!accepted) return ''
  return accepted
    .replace(/^(Phone provider|Telnyx) accepted the call request for /, '')
    .replace(/\.$/, '')
    .trim()
}

function callInsight(outcome, transcript, notices) {
  if (outcome === 'voicemail') return 'Voicemail detected. No contact conversation occurred.'
  if (outcome === 'no-answer') return 'No answer. The phone provider did not produce a contact conversation.'
  if (outcome === 'skipped') return 'Skipped by operator before a completed agent conversation.'
  if (outcome === 'failed') {
    return notices[notices.length - 1] || 'Dial start failed before a live call was created.'
  }
  if (outcome === 'not-interested') {
    return 'Contact clearly declined. Do not continue this contact unless manually reset.'
  }
  if (outcome === 'do-not-call') {
    return 'Contact requested no more calls. Keep this contact suppressed.'
  }
  if (transcript.length === 0) return notices[notices.length - 1] || 'No transcript turns captured.'

  const lastLeadTurn = [...transcript].reverse().find((turn) => turn.speaker === 'Lead')
  if (lastLeadTurn) return `Last contact signal: ${lastLeadTurn.text}`
  return 'Agent spoke, but no contact response was captured.'
}
