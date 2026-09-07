import 'dotenv/config'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  callToolsRequest,
  downloadCallToolsFilesystemFile,
} from '../server/calltools-client.mjs'
import { callLogFileName, operationalDate } from '../server/operational-time.mjs'
import { transcribeAudioWithInworldStt } from './transcribe-calltools-recording.mjs'
import {
  analyzeWavFile,
  audioStatsSummary,
  readCallToolsAudioEvidence,
} from './calltools-audio-evidence.mjs'

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

const callControlId = safeText(options.callControlId || options.call || '')
const explicitLogFile = options.log || process.env.SPEAK_CALLTOOLS_PROOF_LOG || ''
const logFile =
  explicitLogFile ||
  findRecentCallLogByCallControlId(callControlId) ||
  path.join(
    process.env.CALL_LOG_DIR || process.env.SPEAK_CALL_LOG_DIR || 'call-logs',
    callLogFileName(new Date()),
  )
const callAudioDir = options.callAudioDir || process.env.CALL_AUDIO_DIR || 'call-audio'
const requireClean = flags.has('--require-clean')
const json = flags.has('--json')
const transcribeRecordingRequested = flags.has('--transcribeRecording')
const recordingLagGraceMs = positiveNumber(
  options.recordingLagGraceMs ||
    options.providerArtifactGraceMs ||
    process.env.CALLTOOLS_RECORDING_LAG_GRACE_MS ||
    process.env.CALLTOOLS_PROVIDER_ARTIFACT_GRACE_MS,
  60 * 60 * 1000,
)
const historicalCallStartToleranceMs = positiveNumber(
  options.historicalCallStartToleranceMs ||
    process.env.CALLTOOLS_HISTORICAL_CALL_START_TOLERANCE_MS,
  15 * 60 * 1000,
)

const records = readLogRecords(logFile)
const selected = selectCallToolsCall(records, callControlId)
if (!selected) {
  finish(
    {
      ok: false,
      status: 'not_found',
      logFile,
      callControlId,
      error: 'calltools_call_not_found',
    },
    1,
  )
}

const speak = summarizeSpeakCall(selected.id, selected.events)
const providerArtifactLag = buildProviderArtifactLagStatus(speak, recordingLagGraceMs)
const audioEvidence = readCallToolsAudioEvidence({
  callControlId: selected.id,
  callAudioDir,
})
const calltoolsCall = await readCallToolsCallEvidence(speak)
const downloadedRecording = await maybeDownloadCallToolsRecording(calltoolsCall)
const recordingFile = safeText(
  options.recordingFile ||
    options.calltoolsRecordingFile ||
    downloadedRecording?.filePath,
)
const calltoolsRecordingAudio = recordingFile
  ? analyzeWavFile(recordingFile)
  : null
const generatedRecordingTranscript = await maybeGenerateRecordingTranscript({
  recordingFile,
  calltoolsRecordingAudio,
})
const comparison = compareTranscriptText({
  speakTurns: speak.transcript.turns,
  recordingTurns: generatedRecordingTranscript.turns || [],
})
const recordingTranscript = buildRecordingTranscriptStatus({
  calltoolsCall,
  calltoolsRecordingAudio,
  generatedRecordingTranscript,
  providerArtifactLag,
})
const findings = buildFindings({
  speak,
  audioEvidence,
  calltoolsCall,
  recordingTranscript,
  comparison,
  providerArtifactLag,
})
const hasWarnings = findings.some((finding) => finding.severity === 'warn')
const hasPending = findings.some((finding) => /PENDING/.test(finding.code || ''))
const ok =
  !findings.some((finding) => finding.severity === 'error') &&
  (!requireClean || !hasWarnings)
const payload = {
  ok,
  status: ok ? (hasWarnings ? 'clean_or_warn' : hasPending ? 'clean_pending' : 'clean') : 'needs_review',
  checkedAt: new Date().toISOString(),
  logFile,
  callAudioDir,
  identity: {
    speakCallControlId: selected.id,
    firstEventAt: speak.firstEventAt,
    lastEventAt: speak.lastEventAt,
    lead: speak.lead,
    agent: speak.agent,
    providerIds: speak.providerIds,
  },
  providerArtifactLag,
  calltoolsCall,
  recordingTranscript,
  generatedRecordingTranscript,
  downloadedRecording: downloadedRecording
    ? {
        source: downloadedRecording.source,
        callRecordingFsFileId: downloadedRecording.callRecordingFsFileId,
        contentType: downloadedRecording.contentType,
        bytes: downloadedRecording.bytes,
      }
    : null,
  speakTranscript: speak.transcript,
  audio: {
    speakLocal: {
      mixed: audioStatsSummary(audioEvidence.mixed),
      leadCallToolsInput: audioStatsSummary(audioEvidence.diagnostics['lead-calltools-input']),
      aiCallToolsOutput: audioStatsSummary(audioEvidence.diagnostics['ai-calltools-output']),
      operatorCallToolsOutput: audioStatsSummary(audioEvidence.diagnostics['operator-calltools-output']),
    },
    calltoolsRecordingFile: calltoolsRecordingAudio
      ? audioStatsSummary(calltoolsRecordingAudio)
      : null,
  },
  transport: speak.transport,
  comparison,
  findings,
}

finish(payload, ok ? 0 : 2)

function readLogRecords(filePath) {
  if (!existsSync(filePath)) return []
  return readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

function findRecentCallLogByCallControlId(requestedCallControlId = '') {
  const id = safeText(requestedCallControlId)
  const dir = process.env.CALL_LOG_DIR || process.env.SPEAK_CALL_LOG_DIR || 'call-logs'
  if (!id || !existsSync(dir)) return ''
  const files = readdirSync(dir)
    .filter((file) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(file))
    .sort()
    .reverse()
    .slice(0, 30)
  for (const file of files) {
    const filePath = path.join(dir, file)
    try {
      if (readFileSync(filePath, 'utf8').includes(id)) return filePath
    } catch {
      // Keep scanning recent logs if one rotated file is unreadable.
    }
  }
  return ''
}

function selectCallToolsCall(records, requestedCallControlId = '') {
  const byCall = new Map()
  for (const record of records) {
    const id = safeText(record.callControlId)
    if (!id) continue
    if (requestedCallControlId && id !== requestedCallControlId) continue
    const provider = safeText(record.event?.communication?.provider)
    const hasCallToolsDiagnostic = Boolean(record.event?.diagnostic?.calltools)
    const providerIds = record.event?.communication?.providerIds || {}
    const isCallTools =
      id.startsWith('calltools-') ||
      provider === 'calltools' ||
      hasCallToolsDiagnostic ||
      Object.keys(providerIds).some((key) => /^calltools/i.test(key))
    if (!isCallTools) continue
    if (!byCall.has(id)) byCall.set(id, [])
    byCall.get(id).push(record)
  }
  return [...byCall.entries()]
    .map(([id, events]) => ({ id, events }))
    .sort((left, right) => latestMs(right.events) - latestMs(left.events))[0]
}

function summarizeSpeakCall(id, records = []) {
  const events = records.map((record) => record.event || {})
  const diagnostics = events.map((event) => event.diagnostic).filter(Boolean)
  const timestamps = Object.assign({}, ...diagnostics.map((item) => item.timestamps || {}))
  const timingMs = Object.assign({}, ...diagnostics.map((item) => item.timingMs || {}))
  const counters = Object.assign({}, ...diagnostics.map((item) => item.counters || {}))
  const providerIds = aggregateProviderIds(records)
  const transcriptTurns = transcriptFromEvents(events)
  const notices = events
    .map((event) => safeText(event.notice || event.entry?.text))
    .filter(Boolean)
  const firstAt = records
    .map((record) => safeText(record.at))
    .filter(Boolean)
    .sort()[0] || ''
  const lastAt = records
    .map((record) => safeText(record.at))
    .filter(Boolean)
    .sort()
    .at(-1) || ''
  const firstRecord = records[0] || {}
  const lead = publicLead(firstRecord.lead)
  const leadPhone = normalizePhoneForCallTools(
    firstText(
      firstRecord.lead?.called_phone,
      firstRecord.lead?.phone_on_file,
      firstRecord.lead?.phone,
      firstRecord.lead?.phone_number,
    ),
  )
  const finalPatch = [...events].reverse().find((event) => event.patch?.phase === 'ended')?.patch || {}

  return {
    callControlId: id,
    firstEventAt: firstAt,
    lastEventAt: lastAt,
    calltoolsDate: safeText(options.calltoolsDate || operationalDate(firstAt)),
    calltoolsUtcDate: utcDate(firstAt),
    calltoolsDateCandidates: providerDateCandidates(firstAt, options.calltoolsDate),
    lead,
    leadPhone,
    agent: publicAgent(firstRecord.agent),
    providerIds,
    outcome: safeText(finalPatch.outcome),
    notices,
    transcript: {
      turns: transcriptTurns,
      leadTurns: transcriptTurns.filter((turn) => turn.role === 'lead'),
      agentTurns: transcriptTurns.filter((turn) => turn.role === 'agent'),
      systemTurns: transcriptTurns.filter((turn) => turn.role === 'system'),
      turnCount: transcriptTurns.length,
      leadTurnCount: transcriptTurns.filter((turn) => turn.role === 'lead').length,
      agentTurnCount: transcriptTurns.filter((turn) => turn.role === 'agent').length,
      text: transcriptTurns.map((turn) => turn.text).filter(Boolean).join('\n'),
    },
    transport: {
      timestamps,
      timingMs,
      counters,
      calltoolsMediaInPackets: Number(counters.calltoolsMediaInPackets || 0),
      calltoolsMediaOutPackets: Number(counters.calltoolsMediaOutPackets || 0),
      calltoolsPcmInBytes: Number(counters.calltoolsPcmInBytes || 0),
      calltoolsMediaInTransportSeen:
        Number(counters.calltoolsMediaInPackets || 0) > 0 ||
        Boolean(timestamps.first_calltools_media_in),
      calltoolsMediaOutTransportSeen:
        Number(counters.calltoolsMediaOutPackets || 0) > 0 ||
        Boolean(timestamps.first_calltools_media_out),
      inworldAudioOutputSeen: Boolean(timestamps.first_inworld_audio_output),
      initialGreetingRequested: Boolean(timestamps.initial_greeting_requested),
      gatewayAttached: Boolean(timestamps.calltools_gateway_attached),
    },
  }
}

async function readCallToolsCallEvidence(speak) {
  const providerIds = speak.providerIds || {}
  const explicitHistoricalId = numericId(
    options.calltoolsHistoricalCallId ||
      options.historicalCallId ||
      providerIds.calltoolsHistoricalCallId,
  )
  const liveCallId = safeText(options.calltoolsCallId || providerIds.calltoolsCallId)
  const contactId = numericId(options.calltoolsContactId || providerIds.calltoolsContactId)
  const appUserId = safeText(options.calltoolsAppUserId || providerIds.calltoolsAppUserId)
  const campaignId = numericId(options.calltoolsCampaignId || providerIds.calltoolsCampaignId)
  const queueId = numericId(options.calltoolsQueueId || providerIds.calltoolsQueueId)
  const destination = normalizePhoneForCallTools(options.destination || options.phone || speak.leadPhone)
  const dateCandidates = speak.calltoolsDateCandidates?.length
    ? speak.calltoolsDateCandidates
    : providerDateCandidates(speak.firstEventAt, speak.calltoolsDate)
  const queries = []
  const attempted = []

  if (explicitHistoricalId) {
    const direct = await safeCallToolsRequest(`/calls/${encodeURIComponent(explicitHistoricalId)}/`)
    attempted.push({ label: 'calls_read', query: { id: explicitHistoricalId }, status: direct.status })
    if (direct.ok) {
      const normalized = normalizeCallToolsCall(direct.payload, {
        status: 'available',
        lookup: 'calls_read',
        attempted,
      })
      if (callToolsCallMatchesCurrent(normalized, {
        liveCallId,
        contactId,
        destination,
        firstEventAt: speak.firstEventAt,
        allowExactLiveId: false,
      })) {
        return normalized
      }
      attempted[attempted.length - 1].warning = 'stale_historical_call_ignored'
    } else if (!liveCallId && !destination && !contactId && !appUserId && !campaignId && !queueId) {
      return {
        status: direct.status,
        lookup: 'calls_read',
        error: direct.error,
        query: { id: explicitHistoricalId },
        attempted,
      }
    }
  }

  if (uuidLike(liveCallId)) {
    queries.push({
      label: 'calls_uuid',
      query: { uuid: liveCallId, page_size: 5 },
    })
  }
  if (destination) {
    for (const date of dateCandidates) {
      queries.push({
        label: date === speak.calltoolsUtcDate
          ? 'calls_destination_app_user_utc_date'
          : 'calls_destination_app_user_operational_date',
        query: cleanObject({
          destination,
          app_user_id: appUserId,
          start__date: date,
          ordering: '-start',
          page_size: 20,
        }),
      })
    }
    queries.push({
      label: 'calls_destination_app_user_any_date',
      query: cleanObject({
        destination,
        app_user_id: appUserId,
        ordering: '-start',
        page_size: 50,
      }),
    })
  }
  for (const date of dateCandidates) {
    const fallbackQuery = cleanObject({
      contact_id: contactId,
      app_user_id: appUserId,
      campaign_id: campaignId,
      queue_id: queueId,
      start__date: date,
      ordering: '-start',
      page_size: 20,
    })
    if (Object.keys(fallbackQuery).some((key) => key !== 'ordering' && key !== 'page_size')) {
      queries.push({
        label: date === speak.calltoolsUtcDate
          ? 'calls_scoped_utc_date'
          : 'calls_scoped_operational_date',
        query: fallbackQuery,
      })
    }
  }
  const appUserFallbackQuery = cleanObject({
    app_user_id: appUserId,
    ordering: '-start',
    page_size: 50,
  })
  if (appUserId) {
    queries.push({
      label: 'calls_app_user_any_date',
      query: appUserFallbackQuery,
    })
  }

  for (const item of queries) {
    const result = await safeCallToolsRequest('/calls/', { query: item.query })
    attempted.push({ label: item.label, query: publicQuery(item.query), status: result.status })
    if (!result.ok) continue
    const results = collectionResults(result.payload)
    const match = selectBestCallToolsCall(results, {
      liveCallId,
      contactId,
      destination,
      firstEventAt: speak.firstEventAt,
    })
    if (match) {
      return normalizeCallToolsCall(match, {
        status: 'available',
        lookup: item.label,
        attempted,
      })
    }
  }

  return {
    status: attempted.length ? 'missing' : 'not_queried',
    lookup: attempted.length ? 'calls_list' : 'insufficient_identifiers',
    attempted,
    recordingReference: {
      available: false,
      fields: {},
    },
  }
}

async function safeCallToolsRequest(target, requestOptions = {}) {
  try {
    return {
      ok: true,
      status: 'ok',
      payload: await callToolsRequest(target, requestOptions),
    }
  } catch (error) {
    return {
      ok: false,
      status: error?.status || error?.code || 'error',
      error: error instanceof Error ? error.message : String(error),
      payload: error?.payload,
    }
  }
}

function transcriptFromEvents(events = []) {
  const turns = []
  const indexById = new Map()
  const indexByFallbackKey = new Map()
  for (const event of events) {
    const entry = event?.entry
    if (!entry || entry.tone === 'system') continue
    const text = safeText(entry.text)
    if (!text) continue
    const role = speakRole(entry.speaker)
    if (!role) continue
    const next = {
      role,
      speaker: safeText(entry.speaker),
      at: safeText(entry.at),
      text,
      providerEventId: safeText(entry.providerEventId),
    }
    const id = safeText(entry.providerEventId || entry.id)
    const fallbackKey = `${role}|${safeText(entry.at)}|${text}`
    const dedupeKey = id || fallbackKey
    const existingIndex = id ? indexById.get(id) : indexByFallbackKey.get(fallbackKey)
    if (existingIndex !== undefined) {
      turns[existingIndex] = {
        ...turns[existingIndex],
        ...next,
        text: next.text || turns[existingIndex].text,
      }
      continue
    }
    if (id && indexById.has(id)) {
      const index = indexById.get(id)
      turns[index] = {
        ...turns[index],
        ...next,
        text: next.text || turns[index].text,
      }
      continue
    }
    if (id) indexById.set(id, turns.length)
    if (dedupeKey) indexByFallbackKey.set(fallbackKey, turns.length)
    turns.push(next)
  }
  return turns
}

function speakRole(speaker) {
  const value = safeText(speaker).toLowerCase()
  if (['lead', 'contact', 'user', 'caller'].includes(value)) return 'lead'
  if (['ai', 'assistant', 'agent'].includes(value)) return 'agent'
  if (value === 'you') return 'operator'
  return ''
}

function aggregateProviderIds(records = []) {
  const providerIds = {}
  for (const record of records) {
    Object.assign(providerIds, cleanObject(record.lead?.providerIds || {}))
    Object.assign(providerIds, cleanObject(record.event?.communication?.providerIds || {}))
  }
  return cleanObject(providerIds)
}

function normalizeCallToolsCall(call = {}, extras = {}) {
  const recordingFields = extractRecordingFields(call)
  return cleanObject({
    status: extras.status || 'available',
    lookup: extras.lookup,
    attempted: extras.attempted,
    id: safeText(call.id),
    uuid: safeText(call.uuid),
    contactId: safeText(call.contact),
    campaignId: safeText(call.campaign),
    queueId: safeText(call.queue),
    webCallbackId: safeText(call.web_call_back),
    appUserId: safeText(call.app_user),
    callDispositionId: safeText(call.call_disposition),
    systemDisposition: safeText(call.system_disposition),
    startedAt: safeText(call.start),
    endedAt: safeText(call.end),
    duration: numberOrNull(call.duration),
    billsec: numberOrNull(call.billsec),
    recordingReference: {
      available: Object.keys(recordingFields).length > 0,
      fields: recordingFields,
      callRecordingFsFileId: safeText(call.call_recording_fsfile_id),
    },
  })
}

function extractRecordingFields(value = {}) {
  const fields = {}
  for (const [key, raw] of Object.entries(value || {})) {
    if (!/record|fsfile|audio/i.test(key)) continue
    const text = safeText(raw)
    if (!text && typeof raw !== 'number' && typeof raw !== 'boolean') continue
    fields[key] = maskPossiblySensitiveUrl(raw)
  }
  return cleanObject(fields)
}

function compareTranscriptText({ speakTurns = [], recordingTurns = [] } = {}) {
  const speakText = speakTurns.map((turn) => turn.text).join('\n')
  const recordingText = recordingTurns.map((turn) => turn.text).join('\n')
  const speakTokens = tokenSet(speakText)
  const recordingTokens = tokenSet(recordingText)
  const intersection = [...speakTokens].filter((token) => recordingTokens.has(token)).length
  const union = new Set([...speakTokens, ...recordingTokens]).size
  const recordingFull = normalizeText(recordingText)
  const missingSpeakTurns = []
  const recordingBackedLiveCorrections = []
  for (const turn of speakTurns
    .filter((turn) => normalizeText(turn.text).length > 12)
  ) {
    const coverage = classifyRecordingCoverage(turn.text, recordingFull, recordingTokens)
    if (coverage.covered) continue
    const item = {
      role: turn.role,
      text: snippet(turn.text),
    }
    if (coverage.recordingBackedCorrection) {
      recordingBackedLiveCorrections.push({
        ...item,
        matchedTokens: coverage.matchedTokens,
        missingTokens: coverage.missingTokens,
      })
    } else {
      missingSpeakTurns.push(item)
    }
  }
  const recordingTranscriptAvailable = recordingTurns.length > 0 || Boolean(recordingText)
  return {
    recordingTranscriptAvailable,
    speakTurnCount: speakTurns.length,
    recordingTranscriptTurnCount: recordingTurns.length,
    speakLeadTurnCount: speakTurns.filter((turn) => turn.role === 'lead').length,
    speakAgentTurnCount: speakTurns.filter((turn) => turn.role === 'agent').length,
    recordingTranscriptLeadTurnCount: recordingTurns.filter((turn) => turn.role === 'lead').length,
    recordingTranscriptAgentTurnCount: recordingTurns.filter((turn) => turn.role === 'agent').length,
    providerAvailable: recordingTranscriptAvailable,
    providerTurnCount: recordingTurns.length,
    providerLeadTurnCount: recordingTurns.filter((turn) => turn.role === 'lead').length,
    providerAgentTurnCount: recordingTurns.filter((turn) => turn.role === 'agent').length,
    tokenJaccard: union ? round(intersection / union, 4) : null,
    missingSpeakTurns,
    recordingBackedLiveCorrections,
  }
}

function buildProviderArtifactLagStatus(speak, graceMs) {
  const lastEventMs = Date.parse(speak?.lastEventAt || speak?.firstEventAt || '')
  const ageMs = Number.isFinite(lastEventMs) ? Math.max(0, Date.now() - lastEventMs) : null
  return {
    graceMs,
    ageMs,
    pending: ageMs !== null && ageMs < graceMs,
    referenceAt: speak?.lastEventAt || speak?.firstEventAt || '',
  }
}

function buildRecordingTranscriptStatus({
  calltoolsCall,
  calltoolsRecordingAudio,
  generatedRecordingTranscript,
  providerArtifactLag,
} = {}) {
  if (generatedRecordingTranscript?.status === 'available') {
    return {
      status: 'generated',
      source: generatedRecordingTranscript.source,
      reason: 'provider_recording_transcribed_by_speak',
      turnCount: generatedRecordingTranscript.turnCount,
      textPreview: snippet(generatedRecordingTranscript.text || '', 240),
    }
  }
  const hasCallToolsRecording =
    Boolean(calltoolsCall?.recordingReference?.available) ||
    Boolean(calltoolsRecordingAudio?.ok)
  if (hasCallToolsRecording) {
    return {
      status: 'needed',
      source: calltoolsRecordingAudio?.ok ? 'calltools_recording_file' : 'calltools_recording_reference',
      reason: 'provider_recording_transcription_not_generated',
      nextAction:
        calltoolsRecordingAudio?.ok
          ? 'Rerun this audit with --transcribeRecording, or run npm run calltools:transcribe-recording -- --recordingFile=<file>, to generate the recording-derived transcript.'
          : 'Rerun this audit with --transcribeRecording so it can download CallTools /filesystemfiles/{call_recording_fsfile_id}/download/ and compare the recording-derived transcript against Speak turns.',
    }
  }
  if (providerArtifactLag?.pending) {
    return {
      status: 'pending',
      reason: 'calltools_recording_metadata_delayed',
      ageMs: providerArtifactLag.ageMs,
      graceMs: providerArtifactLag.graceMs,
      nextAction:
        'Wait for CallTools to publish the historical recording metadata, then rerun this audit or let the production reconciliation attach the provider link.',
    }
  }
  return {
    status: 'blocked',
    reason: 'no_calltools_recording_reference',
    nextAction:
      'Wait for CallTools recording metadata, rerun with --transcribeRecording after call_recording_fsfile_id appears, or provide an override recording with --recordingFile.',
  }
}

function buildFindings({
  speak,
  audioEvidence,
  calltoolsCall,
  recordingTranscript,
  comparison,
  providerArtifactLag,
} = {}) {
  const findings = []
  const leadAudio = audioEvidence.diagnostics['lead-calltools-input']
  const aiAudio = audioEvidence.diagnostics['ai-calltools-output']
  const transport = speak.transport || {}
  const notices = speak.notices || []
  const providerPending = Boolean(providerArtifactLag?.pending)
  const localTwoSidedAudioProven = Boolean(leadAudio?.audible && aiAudio?.audible)
  const speakTwoSidedTranscriptProven =
    Number(speak.transcript.leadTurnCount || 0) > 0 &&
    Number(speak.transcript.agentTurnCount || 0) > 0

  if (recordingTranscript?.status === 'needed') {
    findings.push({
      severity: 'warn',
      code: 'CALLTOOLS_RECORDING_TRANSCRIPT_NEEDED',
      message:
        'A CallTools recording reference/file exists and should be transcribed for recording comparison.',
    })
  }
  if (recordingTranscript?.status === 'generated') {
    findings.push({
      severity: 'info',
      code: 'CALLTOOLS_RECORDING_TRANSCRIPT_GENERATED',
      message:
        'Speak generated the recording-derived transcript from CallTools recording audio.',
    })
  }
  if (recordingTranscript?.status === 'pending') {
    findings.push({
      severity: 'info',
      code: 'CALLTOOLS_RECORDING_REFERENCE_PENDING',
      message:
        'CallTools has not published the recording reference yet; this is expected for fresh calls and does not block Speak live proof.',
    })
  }
  if (recordingTranscript?.status === 'blocked') {
    findings.push({
      severity: 'warn',
      code: 'CALLTOOLS_RECORDING_REFERENCE_MISSING_FOR_TRANSCRIPT',
      message:
        'No CallTools recording reference is available yet, so the Speak-generated recording transcript cannot be generated.',
    })
  }
  if (!calltoolsCall?.recordingReference?.available && !options.recordingFile) {
    findings.push({
      severity: providerPending ? 'info' : 'warn',
      code: providerPending
        ? 'CALLTOOLS_RECORDING_REFERENCE_PENDING'
        : 'CALLTOOLS_RECORDING_REFERENCE_MISSING',
      message: providerPending
        ? 'No CallTools historical recording reference is available yet; provider recording generation is still inside the configured lag grace window.'
        : 'No CallTools historical recording reference was found on the native /calls record.',
    })
  }
  if (speak.transcript.leadTurnCount === 0) {
    findings.push({
      severity: 'error',
      code: 'SPEAK_LEAD_TRANSCRIPT_MISSING',
      message: 'Speak captured no lead/contact transcript turns.',
    })
  }
  if (speak.transcript.agentTurnCount === 0) {
    findings.push({
      severity: 'warn',
      code: 'SPEAK_AGENT_TRANSCRIPT_MISSING',
      message: 'Speak captured no agent transcript turns.',
    })
  }
  if (transport.calltoolsMediaInTransportSeen && leadAudio && !leadAudio.audible) {
    findings.push({
      severity: 'error',
      code: 'CALLTOOLS_INBOUND_PACKETS_BUT_SILENT_WAV',
      message:
        'CallTools inbound media packets were seen, but Speak local lead-calltools-input.wav is silent.',
    })
  }
  if (transport.calltoolsMediaOutTransportSeen && aiAudio && !aiAudio.audible) {
    findings.push({
      severity: 'error',
      code: 'CALLTOOLS_OUTBOUND_PACKETS_BUT_SILENT_WAV',
      message:
        'Speak sent CallTools outbound packets, but ai-calltools-output.wav is silent.',
    })
  }
  if (
    (transport.calltoolsMediaOutTransportSeen || transport.inworldAudioOutputSeen) &&
    aiAudio?.audible &&
    recordingTranscript?.status !== 'generated'
  ) {
    findings.push({
      severity: providerPending ? 'info' : 'warn',
      code: providerPending
        ? 'CALLTOOLS_HANDSET_EVIDENCE_PENDING'
        : 'ASSISTANT_AUDIO_ONLY_PROVEN_INSIDE_SPEAK',
      message: providerPending
        ? 'Speak generated non-silent assistant output audio; CallTools recording evidence is pending provider artifact generation.'
        : 'Speak generated non-silent assistant output audio, but the recording-derived transcript has not confirmed it reached the handset.',
    })
  }
  if (notices.some((notice) => /assistant audio missing/i.test(notice))) {
    const assistantAudioProven =
      Boolean(aiAudio?.audible) &&
      (transport.calltoolsMediaOutTransportSeen || transport.inworldAudioOutputSeen)
    findings.push({
      severity: assistantAudioProven ? 'info' : 'error',
      code: assistantAudioProven
        ? 'STALE_ASSISTANT_TEXT_WITHOUT_VOICE_AUDIO_NOTICE'
        : 'ASSISTANT_TEXT_WITHOUT_VOICE_AUDIO_NOTICE',
      message: assistantAudioProven
        ? 'The call log contains an assistant-audio warning, but finalized local assistant audio is audible.'
        : 'The call log contains the assistant-text-without-voice-audio warning.',
    })
  }
  if (notices.some((notice) => /disposition sync blocked/i.test(notice))) {
    findings.push({
      severity: 'warn',
      code: 'CALLTOOLS_DISPOSITION_SYNC_BLOCKED',
      message: 'CallTools disposition writeback was blocked for this call.',
    })
  }
  if (notices.some((notice) => /disconnected/i.test(notice))) {
    const completedAudioProof = localTwoSidedAudioProven && speakTwoSidedTranscriptProven
    findings.push({
      severity: completedAudioProof ? 'info' : 'warn',
      code: completedAudioProof
        ? 'VOICE_PROVIDER_DISCONNECTED_AFTER_PROOF'
        : 'VOICE_PROVIDER_DISCONNECTED',
      message: completedAudioProof
        ? 'The voice provider disconnected after Speak had already captured two-sided transcript turns and audible local CallTools WAV proof.'
        : 'The voice provider disconnected during the call.',
    })
  }
  if (comparison.recordingTranscriptAvailable && comparison.speakTurnCount > 0) {
    if (comparison.tokenJaccard !== null && comparison.tokenJaccard < 0.65) {
      findings.push({
        severity: 'warn',
        code: 'TRANSCRIPT_TEXT_LOW_OVERLAP',
        message: `Speak transcript and recording-derived comparison transcript have low token overlap (${comparison.tokenJaccard}).`,
      })
    }
    if (comparison.missingSpeakTurns.length) {
      findings.push({
        severity: 'warn',
        code: 'SPEAK_TURNS_NOT_FOUND_IN_PROVIDER_RECORDING_TRANSCRIPT',
        message: `${comparison.missingSpeakTurns.length} Speak transcript turn(s) were not found in the Speak-generated transcript from CallTools recording audio.`,
        examples: comparison.missingSpeakTurns.slice(0, 3),
      })
    }
    if (comparison.recordingBackedLiveCorrections?.length) {
      findings.push({
        severity: 'info',
        code: 'LIVE_SPEAK_STT_CORRECTED_BY_PROVIDER_RECORDING',
        message: `${comparison.recordingBackedLiveCorrections.length} short live Speak transcript turn(s) appear corrected by the CallTools recording-derived transcript.`,
        examples: comparison.recordingBackedLiveCorrections.slice(0, 3),
      })
    }
  }
  if (!findings.length) {
    findings.push({
      severity: 'info',
      code: 'NO_PARITY_ISSUES_DETECTED',
      message: 'No recording-derived transcript comparison issues were detected by the available evidence.',
    })
  }
  return findings
}

async function maybeGenerateRecordingTranscript({
  recordingFile,
  calltoolsRecordingAudio,
} = {}) {
  const recordingTranscriptFile = safeText(
    options.recordingTranscriptFile ||
      options.calltoolsRecordingTranscriptFile ||
      options.generatedTranscriptFile ||
      options.transcriptFile,
  )
  if (recordingTranscriptFile) {
    const transcript = readRecordingTranscriptFile(recordingTranscriptFile)
    return {
      status: transcript.text ? 'available' : 'empty',
      source: 'recording_transcript_file',
      path: recordingTranscriptFile,
      text: transcript.text,
      turns: transcript.turns,
      turnCount: transcript.turns.length || (transcript.text ? 1 : 0),
    }
  }
  if (!transcribeRecordingRequested) {
    return {
      status: 'not_requested',
      reason: 'pass_--transcribeRecording_to_download_or_generate_from_provider_recording',
      turns: [],
      text: '',
    }
  }
  if (!recordingFile || !calltoolsRecordingAudio?.ok) {
    return {
      status: 'blocked',
      reason: 'provider_recording_download_or_recording_file_required_for_recording_transcription',
      turns: [],
      text: '',
    }
  }
  const transcript = await transcribeAudioWithInworldStt({
    filePath: recordingFile,
    modelId: options.sttModel || process.env.CALLTOOLS_RECORDING_STT_MODEL,
    language: options.language || process.env.CALLTOOLS_RECORDING_STT_LANGUAGE,
    audioEncoding: options.audioEncoding,
  })
  const text = firstText(
    transcript.text,
    transcript.transcript,
    transcript.payload?.text,
    transcript.payload?.transcript,
    transcript.payload?.results?.[0]?.text,
    transcript.payload?.results?.[0]?.transcript,
  )
  return {
    status: text ? 'available' : 'empty',
    source: 'provider_recording_speak_inworld_stt',
    modelId: transcript.modelId,
    language: transcript.language,
    audioEncoding: transcript.audioEncoding,
    text,
    turns: text ? [{ role: 'unknown', speaker: 'Recording-derived transcript', text }] : [],
    turnCount: text ? 1 : 0,
    rawKeys: transcript.payload && typeof transcript.payload === 'object'
      ? Object.keys(transcript.payload).sort()
      : [],
  }
}

async function maybeDownloadCallToolsRecording(calltoolsCall = {}) {
  if (!transcribeRecordingRequested) return null
  if (safeText(options.recordingFile || options.calltoolsRecordingFile)) return null
  const callRecordingFsFileId = safeText(
    options.calltoolsRecordingFsFileId ||
      calltoolsCall?.recordingReference?.callRecordingFsFileId ||
      calltoolsCall?.recordingReference?.fields?.call_recording_fsfile_id,
  )
  if (!callRecordingFsFileId) return null
  const file = await downloadCallToolsFilesystemFile(callRecordingFsFileId)
  const dir = mkdtempSync(path.join(tmpdir(), 'speak-calltools-recording-'))
  const extension = /mpeg|mp3/i.test(file.contentType)
    ? 'mp3'
    : /flac/i.test(file.contentType)
      ? 'flac'
      : /ogg|opus/i.test(file.contentType)
        ? 'ogg'
        : 'wav'
  const filePath = path.join(dir, `calltools-recording-${callRecordingFsFileId}.${extension}`)
  writeFileSync(filePath, file.buffer)
  return {
    source: 'calltools_filesystemfiles_download',
    callRecordingFsFileId,
    filePath,
    contentType: file.contentType,
    bytes: file.bytes,
  }
}

function readRecordingTranscriptFile(filePath) {
  if (!existsSync(filePath)) {
    return { text: '', turns: [] }
  }
  const raw = readFileSync(filePath, 'utf8')
  try {
    const parsed = JSON.parse(raw)
    const turns = normalizeTranscriptTurnArray(
      parsed.turns ||
        parsed.segments ||
        parsed.utterances ||
        parsed.messages ||
        parsed.items,
    )
    const text = firstText(
      parsed.text,
      parsed.transcript,
      parsed.transcript_text,
      parsed.payload?.text,
      parsed.payload?.transcript,
    ) || turns.map((turn) => turn.text).join('\n')
    return { text, turns: turns.length ? turns : text ? [{ role: 'unknown', speaker: 'Recording-derived transcript', text }] : [] }
  } catch {
    const text = safeText(raw)
    return {
      text,
      turns: text ? [{ role: 'unknown', speaker: 'Recording-derived transcript', text }] : [],
    }
  }
}

function collectionResults(payload) {
  if (Array.isArray(payload?.results)) return payload.results
  if (Array.isArray(payload?.data?.results)) return payload.data.results
  if (Array.isArray(payload?.data)) return payload.data
  if (Array.isArray(payload)) return payload
  if (payload && typeof payload === 'object' && payload.id) return [payload]
  return []
}

function selectBestCallToolsCall(results = [], {
  liveCallId = '',
  contactId = '',
  destination = '',
  firstEventAt = '',
} = {}) {
  if (!results.length) return null
  const normalizedDestination = normalizePhoneForCallTools(destination)
  const exactLiveId = results.find((item) => {
    const ids = [safeText(item.uuid), safeText(item.id)]
    return liveCallId && ids.includes(liveCallId)
  })
  if (exactLiveId) return exactLiveId
  const pool = results.filter((item) => callToolsCallMatchesCurrent(item, {
    liveCallId,
    contactId,
    destination: normalizedDestination,
    firstEventAt,
    allowExactLiveId: false,
  }))
  return nearestByDate(pool, firstEventAt, 'start', historicalCallStartToleranceMs)
}

function callToolsCallMatchesCurrent(
  call = {},
  {
    liveCallId = '',
    contactId = '',
    destination = '',
    firstEventAt = '',
    allowExactLiveId = true,
  } = {},
) {
  if (!call || typeof call !== 'object') return false
  const ids = [safeText(call.uuid), safeText(call.id)].filter(Boolean)
  if (allowExactLiveId && liveCallId && ids.includes(liveCallId)) return true
  if (!callToolsProviderArtifactWithinWindow(call, firstEventAt, 'start')) return false
  const normalizedDestination = normalizePhoneForCallTools(destination)
  if (
    normalizedDestination &&
    normalizePhoneForCallTools(call.destination || call.phone_number) === normalizedDestination
  ) {
    return true
  }
  if (contactId && safeText(call.contact || call.contact_id) === safeText(contactId)) return true
  return !normalizedDestination && !contactId
}

function callToolsProviderArtifactWithinWindow(item = {}, targetAt = '', key = 'start') {
  const targetMs = Date.parse(targetAt)
  if (!Number.isFinite(targetMs)) return true
  const itemMs = Date.parse(item[key] || item.start || item.call_datetime || '')
  if (!Number.isFinite(itemMs)) return false
  return Math.abs(itemMs - targetMs) <= historicalCallStartToleranceMs
}

function providerDateCandidates(value = '', override = '') {
  return uniqueValues([
    utcDate(value),
    safeText(override),
    operationalDate(value),
  ]).filter(Boolean)
}

function utcDate(value = '') {
  const date = value instanceof Date ? value : new Date(value || Date.now())
  if (!Number.isFinite(date.getTime())) {
    const text = safeText(value)
    return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : ''
  }
  return date.toISOString().slice(0, 10)
}

function uniqueValues(values = []) {
  return [...new Set(values.map((value) => safeText(value)).filter(Boolean))]
}

function nearestByDate(results = [], targetAt = '', key = 'start', maxDeltaMs = Infinity) {
  const targetMs = Date.parse(targetAt)
  if (!Number.isFinite(targetMs)) return null
  const nearest = results
    .map((item) => ({
      item,
      delta: Math.abs((Date.parse(item[key] || item.start || item.call_datetime || '') || 0) - targetMs),
    }))
    .filter((item) => Number.isFinite(item.delta))
    .sort((left, right) => left.delta - right.delta)[0]
  if (!nearest) return null
  if (Number.isFinite(maxDeltaMs) && nearest.delta > maxDeltaMs) return null
  return nearest.item
}

function tokenSet(value) {
  return new Set(tokenList(value))
}

function tokenList(value) {
  return normalizeText(value)
    .split(/\s+/)
    .filter((token) => token.length > 2)
}

function classifyRecordingCoverage(turnText, recordingFull, recordingTokens) {
  const normalizedTurn = normalizeText(turnText)
  if (!normalizedTurn) return { covered: true }
  if (recordingFull.includes(normalizedTurn)) return { covered: true }

  const tokens = tokenList(normalizedTurn)
  if (tokens.length < 5) {
    const uniqueTokens = [...new Set(tokens)]
    const matchedTokens = uniqueTokens.filter((token) => recordingTokens.has(token))
    const missingTokens = uniqueTokens.filter((token) => !recordingTokens.has(token))
    const recordingBackedCorrection =
      uniqueTokens.length >= 3 &&
      matchedTokens.length >= 2 &&
      missingTokens.length <= 1 &&
      !hasCorrectionUnsafeNegation(normalizedTurn)
    return {
      covered: false,
      recordingBackedCorrection,
      matchedTokens,
      missingTokens,
    }
  }
  const uniqueTokens = [...new Set(tokens)]
  const matched = uniqueTokens.filter((token) => recordingTokens.has(token)).length
  const overlap = matched / uniqueTokens.length

  return {
    covered: overlap >= 0.72 || (uniqueTokens.length <= 8 && uniqueTokens.length - matched <= 1),
  }
}

function hasCorrectionUnsafeNegation(value) {
  return /\b(no|not|never|none|without|cannot|can't|wont|won't|dont|don't)\b/i.test(value)
}

function normalizeText(value) {
  return safeText(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function publicLead(lead = {}) {
  return cleanObject({
    id: safeText(lead?.id),
    name: safeText(lead?.name),
    company: safeText(lead?.company || lead?.business_name),
  })
}

function publicQuery(query = {}) {
  const redacted = {}
  for (const [key, value] of Object.entries(query || {})) {
    redacted[key] = /phone|destination|source/i.test(key)
      ? maskPhone(value)
      : value
  }
  return redacted
}

function maskPhone(value) {
  const text = safeText(value)
  if (!text) return text
  const digits = text.replace(/\D/g, '')
  if (digits.length < 4) return '***'
  return `${text.startsWith('+') ? '+' : ''}${'*'.repeat(Math.max(3, digits.length - 4))}${digits.slice(-4)}`
}

function publicAgent(agent = {}) {
  return cleanObject({
    id: safeText(agent?.id),
    name: safeText(agent?.name),
    voiceRuntimeProvider: safeText(agent?.voiceRuntimeProvider),
  })
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' || typeof value === 'number') {
      const text = safeText(value)
      if (text) return text
    }
  }
  return ''
}

function numericId(value) {
  const text = safeText(value)
  return /^\d+$/.test(text) ? text : ''
}

function uuidLike(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(safeText(value))
}

function normalizePhoneForCallTools(value) {
  const text = safeText(value)
  if (!text) return ''
  const digits = text.replace(/\D/g, '')
  if (!digits) return ''
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return text.startsWith('+') ? `+${digits}` : digits
}

function numberOrNull(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function cleanObject(value = {}) {
  return Object.fromEntries(
    Object.entries(value || {}).filter(([, item]) => {
      if (item === undefined || item === null || item === '') return false
      if (Array.isArray(item) && item.length === 0) return false
      if (typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length === 0) return false
      return true
    }),
  )
}

function maskPossiblySensitiveUrl(value) {
  const text = safeText(value)
  if (!/^https?:\/\//i.test(text)) return value
  try {
    const url = new URL(text)
    return `${url.origin}${url.pathname}${url.search ? '?...' : ''}`
  } catch {
    return '[url]'
  }
}

function latestMs(events) {
  return Math.max(0, ...events.map((event) => Date.parse(event.at || '') || 0))
}

function snippet(value, max = 180) {
  const text = safeText(value)
  return text.length > max ? `${text.slice(0, max - 1)}...` : text
}

function round(value, places = 2) {
  const multiplier = 10 ** places
  return Math.round(Number(value || 0) * multiplier) / multiplier
}

function formatMs(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 'unknown'
  if (number >= 60_000) return `${round(number / 60_000, 1)}m`
  return `${Math.round(number)}ms`
}

function safeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function finish(payload, exitCode = 0) {
  if (json) {
    console.log(JSON.stringify(payload, null, 2))
  } else {
    printReport(payload)
  }
  process.exit(payload.ok ? 0 : (requireClean ? exitCode || 1 : 0))
}

function printReport(payload) {
  console.log(`CallTools/Speak recording transcript review: ${payload.status}`)
  console.log(`Speak call: ${payload.identity.speakCallControlId}`)
  console.log(`Window: ${payload.identity.firstEventAt || 'unknown'} -> ${payload.identity.lastEventAt || 'unknown'}`)
  console.log(`CallTools call: ${payload.calltoolsCall?.status || 'unknown'} (${payload.calltoolsCall?.lookup || 'not_queried'})`)
  console.log(`Recording-derived transcript: ${payload.recordingTranscript?.status || 'unknown'} - ${payload.recordingTranscript?.reason || ''}`)
  if (payload.providerArtifactLag?.pending) {
    console.log(
      `CallTools provider artifacts: pending (${formatMs(payload.providerArtifactLag.ageMs)} elapsed, ${formatMs(payload.providerArtifactLag.graceMs)} grace)`,
    )
  }
  if (payload.recordingTranscript?.textPreview) {
    console.log(`Recording transcript text: ${payload.recordingTranscript.textPreview}`)
  }
  console.log(
    `Speak turns: agent=${payload.speakTranscript.agentTurnCount} lead=${payload.speakTranscript.leadTurnCount}`,
  )
  console.log(
    `Audio: lead=${audioLabel(payload.audio.speakLocal.leadCallToolsInput)} ai=${audioLabel(payload.audio.speakLocal.aiCallToolsOutput)} mixed=${audioLabel(payload.audio.speakLocal.mixed)}`,
  )
  console.log('Findings:')
  for (const finding of payload.findings || []) {
    console.log(`- [${finding.severity}] ${finding.code}: ${finding.message}`)
  }
}

function audioLabel(stats) {
  if (!stats) return 'missing'
  if (!stats.ok) return `unreadable:${stats.error || 'error'}`
  return `${stats.audible ? 'audible' : 'silent'} peak=${stats.peak} rmsDbfs=${stats.rmsDbfs} duration=${stats.durationSeconds}s`
}
