import { createId } from './ids'
import { normalizeKey, statusForOutcome, statusLabels } from './leads'
import { formatOperationalDateTime } from './time'
import type { ActiveCall, CallOutcome, Lead, TranscriptEntry } from './types'

export const recentCallHistoryLimit = 300
const staleLiveRecentCallMs = 35 * 60 * 1000
const autoAdvanceOutcomes = new Set<CallOutcome>([
  'completed',
  'no-answer',
  'voicemail',
  'not-interested',
  'do-not-call',
  'skipped',
  'failed',
])
const autoEndOutcomes = new Set<CallOutcome>([
  'voicemail',
  'not-interested',
  'do-not-call',
])

export interface RecentCallSummary {
  callControlId: string
  chatId?: string
  audio?: CallAudioMetadata | null
  origin?: 'playground_browser' | 'playground_phone' | string
  provider?: string
  providerIds?: Record<string, string>
  agent?: {
    id?: string
    name?: string
    voiceRuntimeProvider?: 'hume' | 'inworld' | string
    speakConfigId?: string
    humeConfigId?: string
    inworldConfigId?: string
    voice?: string
  } | null
  lead?: {
    id?: string
    name?: string
    first_name?: string
    last_name?: string
    business_name?: string
    phone_on_file?: string
    email_on_file?: string
    called_phone?: string
    source?: string
    sourceId?: string
    sourceName?: string
    sourceUrl?: string
    externalUrl?: string
    sourceSyncedAt?: string
    status?: string
    lastCall?: string
  }
  createdAt?: string
  updatedAt?: string
  outcome?: CallOutcome | ''
  phase?: string
  insight?: string
  transcriptTurns?: number
  transcript?: Array<{
    speaker: string
    at?: string
    text: string
    emotionScores?: Record<string, number>
    providerEventId?: string
  }>
}

export interface CallAudioMetadata {
  status?: string
  source?: 'local' | 'speak' | 'hume' | string
  contentType?: string
  url?: string
  expiresAt?: string
  bytes?: number
  durationSeconds?: number
  providerStatus?: string | null
  message?: string
}

export function todayLabel() {
  return formatOperationalDateTime(new Date(), {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function callTimeLabel(value?: string) {
  const date = value ? new Date(value) : new Date()
  if (Number.isNaN(date.getTime())) return todayLabel()

  return formatOperationalDateTime(date, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function isLiveRecentCall(call: RecentCallSummary) {
  return Boolean(call.phase && call.phase !== 'ended' && call.phase !== 'idle')
}

export function normalizeRecentCallLiveness(
  call: RecentCallSummary,
  nowMs: number,
) {
  if (!isLiveRecentCall(call)) return call

  const updatedMs = Date.parse(call.updatedAt || call.createdAt || '')
  if (!updatedMs || nowMs - updatedMs <= staleLiveRecentCallMs) return call

  return {
    ...call,
    phase: 'idle',
  }
}

export function isActiveCallLive(call?: ActiveCall | null) {
  return Boolean(call && call.phase !== 'ended' && call.phase !== 'idle')
}

export function shouldAutoAdvanceForOutcome(outcome?: CallOutcome | '') {
  return Boolean(outcome && autoAdvanceOutcomes.has(outcome))
}

export function shouldAutoEndForOutcome(outcome?: CallOutcome | '') {
  return Boolean(outcome && autoEndOutcomes.has(outcome))
}

export function recentLeadName(call?: RecentCallSummary | null) {
  if (!call) return ''
  const name = call.lead?.name || ''
  const firstLast = [call.lead?.first_name, call.lead?.last_name]
    .filter(Boolean)
    .join(' ')
  if (name && !isGenericRecentLeadName(name)) return name
  if (firstLast && !isGenericRecentLeadName(firstLast)) return firstLast
  return call.lead?.business_name || 'Unknown contact'
}

export function recentBusinessName(call?: RecentCallSummary | null) {
  if (!call) return ''
  const name = call.lead?.name || ''
  return (
    call.lead?.business_name ||
    (name && !isGenericRecentLeadName(name) ? name : '') ||
    'Unknown business'
  )
}

function isGenericRecentLeadName(value: string) {
  return /^(imported\s+lead(?:\s+\d+)?|unknown\s+lead|unknown\s+contact)$/i.test(
    value.trim(),
  )
}

export function recentPhone(call?: RecentCallSummary | null) {
  if (!call) return ''
  return call.lead?.phone_on_file || ''
}

export function recentOutcomeLabel(call: RecentCallSummary) {
  if (call.outcome) return statusLabels[statusForOutcome(call.outcome as CallOutcome)]
  return call.phase ? call.phase : 'Live'
}

export function recentAgentName(call?: RecentCallSummary | null) {
  if (!call) return ''
  return (
    call.agent?.name ||
    call.agent?.speakConfigId ||
    call.agent?.humeConfigId ||
    call.agent?.inworldConfigId ||
    ''
  )
}

export function callMatchesLead(call: RecentCallSummary, lead: Lead) {
  if (call.lead?.id && call.lead.id === lead.id) return true

  const leadPhone = phoneDigits(lead.phone)
  const callPhones = [call.lead?.phone_on_file, call.lead?.called_phone]
    .map(phoneDigits)
    .filter(Boolean)
  if (leadPhone && callPhones.includes(leadPhone)) return true

  const leadEmail = lead.email.trim().toLowerCase()
  const callEmail = call.lead?.email_on_file?.trim().toLowerCase()
  if (leadEmail && callEmail && leadEmail === callEmail) return true

  const leadName = normalizeKey(lead.name)
  const callName = normalizeKey(recentLeadName(call))
  const leadCompany = normalizeKey(lead.company)
  const callCompany = normalizeKey(recentBusinessName(call))
  return Boolean(leadName && callName && leadCompany && callCompany) &&
    leadName === callName &&
    leadCompany === callCompany
}

export function canRequestCallAudio(call?: RecentCallSummary | null) {
  const audioStatus = call?.audio?.status?.toLowerCase()
  const provider = call?.agent?.voiceRuntimeProvider
  return Boolean(
    call?.audio?.url ||
      audioStatus === 'ready' ||
      audioStatus === 'requestable' ||
      (call?.chatId && provider !== 'inworld'),
  )
}

export function callMeetsAudioPlaybackStandards(
  call?: RecentCallSummary | null,
) {
  if (!call || isLiveRecentCall(call)) return false
  if (!canRequestCallAudio(call)) return false

  return true
}

export function formatCallDate(value?: string) {
  if (!value) return 'Time unavailable'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Time unavailable'

  return formatOperationalDateTime(date, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function formatCallTime(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''

  return formatOperationalDateTime(date, {
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function callDuration(call: RecentCallSummary) {
  const totalSeconds = callDurationSeconds(call)
  if (!totalSeconds) return ''

  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes === 0) return `${seconds}s`
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`
}

export function callDurationSeconds(call: RecentCallSummary) {
  const audioSeconds = Number(call.audio?.durationSeconds)
  if (Number.isFinite(audioSeconds) && audioSeconds > 0) {
    return Math.round(audioSeconds)
  }

  const start = Date.parse(call.createdAt || '')
  const end = Date.parse(call.updatedAt || '')
  if (!start || !end || end <= start) return 0

  return Math.round((end - start) / 1000)
}

export function formatCallDurationClock(totalSeconds: number) {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '0:00'

  const roundedSeconds = Math.round(totalSeconds)
  const minutes = Math.floor(roundedSeconds / 60)
  const seconds = roundedSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

export function makeTranscriptEntry(
  entry: Omit<TranscriptEntry, 'id' | 'at'>,
): TranscriptEntry {
  return {
    ...entry,
    id: createId('event'),
    at: timestamp(),
  }
}

const transcriptCoalesceWindow = 8

export function appendTranscriptEntry(
  current: TranscriptEntry[],
  incoming: TranscriptEntry,
) {
  if (incoming.id) {
    const existingIndex = current.findIndex((entry) => entry.id === incoming.id)
    if (existingIndex >= 0) {
      return mergeTranscriptEntry(current, existingIndex, incoming)
    }
  }
  if (incoming.providerEventId) {
    const existingProviderIndex = current.findIndex(
      (entry) =>
        entry.providerEventId === incoming.providerEventId &&
        entry.speaker === incoming.speaker,
    )
    if (existingProviderIndex >= 0) {
      return mergeTranscriptEntry(current, existingProviderIndex, incoming)
    }
  }
  if (!incoming.text.trim()) return current

  const windowStart = Math.max(0, current.length - transcriptCoalesceWindow)
  const recent = current.slice(windowStart)
  const incomingIsInterim = isInterimTranscriptEntry(incoming)

  if (incomingIsInterim) {
    const interimIndex = findRecentTranscriptIndex(recent, windowStart, (entry) =>
      entry.speaker === incoming.speaker && isInterimTranscriptEntry(entry),
    )
    if (interimIndex >= 0) {
      return replaceTranscriptEntry(current, interimIndex, incoming)
    }
  }

  const matchingInterimIndex = findRecentTranscriptIndex(
    recent,
    windowStart,
    (entry) =>
      entry.speaker === incoming.speaker &&
      isInterimTranscriptEntry(entry),
  )
  if (!incomingIsInterim && matchingInterimIndex >= 0) {
    return replaceTranscriptEntry(current, matchingInterimIndex, incoming)
  }

  const last = current[current.length - 1]
  if (
    last &&
    !incomingIsInterim &&
    !isInterimTranscriptEntry(last) &&
    last.speaker === incoming.speaker &&
    last.tone === incoming.tone &&
    transcriptEntryKey(last) === transcriptEntryKey(incoming)
  ) {
    return current
  }

  return [...current, incoming]
}

function timestamp() {
  return formatOperationalDateTime(new Date(), {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  })
}

function phoneDigits(value?: string) {
  return String(value || '').replace(/\D/g, '')
}

function isInterimTranscriptEntry(entry: TranscriptEntry) {
  return entry.tone === 'system' && /\.\.\.$/.test(entry.text.trim())
}

function transcriptEntryKey(entry: TranscriptEntry) {
  return `${entry.speaker}:${entry.text
    .replace(/\s*\.\.\.$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()}`
}

function findRecentTranscriptIndex(
  recent: TranscriptEntry[],
  windowStart: number,
  predicate: (entry: TranscriptEntry) => boolean,
) {
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    if (predicate(recent[index])) return windowStart + index
  }
  return -1
}

function replaceTranscriptEntry(
  current: TranscriptEntry[],
  index: number,
  incoming: TranscriptEntry,
) {
  const next = [...current]
  next[index] = incoming
  return next
}

function mergeTranscriptEntry(
  current: TranscriptEntry[],
  index: number,
  incoming: TranscriptEntry,
) {
  const existing = current[index]
  const next = [...current]
  next[index] = {
    ...existing,
    ...incoming,
    text: incoming.text.trim() ? incoming.text : existing.text,
    emotionScores: incoming.emotionScores || existing.emotionScores,
    providerEventId: incoming.providerEventId || existing.providerEventId,
  }
  return next
}
