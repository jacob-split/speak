import {
  useEffect,
  useState,
} from 'react'
import { apiUrl } from './api'
import type { RecentCallSummary } from './calls'

export interface CommunicationMessage {
  agentProfileId?: string
  at?: string
  body?: string
  channel?: string
  contactId?: string
  direction?: string
  emotionScores?: Record<string, number>
  messageId: string
  modality?: string
  provider?: string
  providerIds?: Record<string, unknown>
  proof?: Record<string, unknown>
  role?: string
  threadId: string
}

export interface TranscriptMessageEntry {
  at?: string
  emotionScores?: Record<string, number>
  providerEventId?: string
  speaker?: string
  text?: string
}

interface CommunicationMessagesForTranscriptOptions {
  agentProfileId?: string
  callControlId?: string
  channel?: string
  chatId?: string
  contactId?: string
  createdAt?: string
  provider?: string
  threadId: string
  updatedAt?: string
}

interface CommunicationMessagesPayload {
  messages?: CommunicationMessage[]
}

interface UseCommunicationThreadMessagesOptions {
  enabled?: boolean
  initialMessages?: CommunicationMessage[]
  limit?: number
  reloadKey?: number
}

export function communicationChannelLabel(value?: string) {
  if (value === 'sms') return 'SMS'
  if (value === 'email') return 'Email'
  if (value === 'browser_test') return 'Playground'
  if (value === 'operator_chat') return 'Operator'
  if (value === 'tool') return 'Tool'
  if (value === 'system') return 'System'
  return 'Phone'
}

export function recentCallChannel(call: RecentCallSummary) {
  return call.callControlId.startsWith('test-') ||
    call.origin === 'playground_browser' ||
    call.origin === 'playground_phone'
    ? 'browser_test'
    : 'call'
}

function transcriptSpeakerRole(channel: string, speaker?: string) {
  const normalized = String(speaker || '').trim().toLowerCase()
  if (normalized === 'lead' || normalized === 'caller' || normalized === 'user' || normalized === 'contact' || normalized === 'customer') {
    return 'contact'
  }
  if (normalized === 'you') {
    return channel === 'browser_test' ? 'contact' : 'operator'
  }
  if (normalized === 'ai' || normalized === 'assistant' || normalized === 'agent') {
    return 'agent'
  }
  if (normalized === 'tool') return 'tool'
  if (normalized === 'operator') return 'operator'
  return 'system'
}

function directionForRole(role: string) {
  if (role === 'contact') return 'inbound'
  if (role === 'agent') return 'outbound'
  if (role === 'operator' || role === 'tool') return 'internal'
  return 'system'
}

function transcriptMessageTimestamp(
  entry: TranscriptMessageEntry,
  index: number,
  createdAt = '',
  updatedAt = '',
) {
  const rawTime = String(entry.at || '')
  if (/^\d{4}-\d{2}-\d{2}T/.test(rawTime) && !Number.isNaN(Date.parse(rawTime))) {
    return rawTime
  }
  const baseMs = Date.parse(createdAt || updatedAt || '')
  if (!baseMs) return updatedAt || createdAt || ''
  return new Date(baseMs + index * 1000).toISOString()
}

function slugMessageSegment(value: string) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function transcriptSourceEventId(
  callControlId: string,
  entry: TranscriptMessageEntry,
) {
  const sourceParts = [
    'backfill',
    callControlId,
    slugMessageSegment(entry.at || ''),
    slugMessageSegment(entry.text || ''),
  ].filter(Boolean)
  return sourceParts.length >= 3 ? sourceParts.join('-') : ''
}

export function communicationMessagesForTranscriptEntries(
  entries: TranscriptMessageEntry[] = [],
  {
    agentProfileId = '',
    callControlId = '',
    channel = 'call',
    chatId = '',
    contactId = '',
    createdAt = '',
    provider = 'speak',
    threadId,
    updatedAt = '',
  }: CommunicationMessagesForTranscriptOptions,
): CommunicationMessage[] {
  return entries
    .filter((entry) => String(entry.text || '').trim())
    .map((entry, index) => {
      const role = transcriptSpeakerRole(channel, entry.speaker)
      const direction = directionForRole(role)
      const eventKey = String(entry.providerEventId || entry.at || index)
        .replace(/[^a-zA-Z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
      return {
        agentProfileId,
        at: transcriptMessageTimestamp(entry, index, createdAt, updatedAt),
        body: String(entry.text || ''),
        channel,
        contactId,
        direction,
        emotionScores: entry.emotionScores,
        messageId: `${threadId}-turn-${eventKey || index}`,
        modality: 'voice',
        provider,
        providerIds: {
          callControlId,
          chatId,
          providerEventId: entry.providerEventId || '',
          sourceEventId: transcriptSourceEventId(callControlId, entry),
        },
        role,
        threadId,
      }
    })
}

export function communicationMessagesForRecentCall(
  call: RecentCallSummary,
  threadId: string,
) {
  const channel = recentCallChannel(call)
  return communicationMessagesForTranscriptEntries(call.transcript || [], {
    agentProfileId: call.agent?.id || '',
    callControlId: call.callControlId,
    channel,
    chatId: call.chatId || '',
    contactId: call.lead?.id || '',
    createdAt: call.createdAt,
    provider: call.agent?.voiceRuntimeProvider || 'speak',
    threadId,
    updatedAt: call.updatedAt,
  })
}

export function communicationMessagesForRecentCalls(
  calls: RecentCallSummary[],
  threadId: string,
) {
  return calls.flatMap((call) => communicationMessagesForRecentCall(call, threadId))
}

function communicationMessageDedupeKey(message: CommunicationMessage) {
  const providerIds = message.providerIds || {}
  const callControlId = String(providerIds.callControlId || '')
  const providerEventId = String(providerIds.providerEventId || '')
  const sourceEventId = String(providerIds.sourceEventId || '')
  const providerMessageId = String(
    providerIds.messageId ||
      providerIds.message_id ||
      providerIds.providerMessageId ||
      '',
  )
  const providerSourceId = providerEventId || sourceEventId || providerMessageId
  const keys = [
    message.messageId,
    [
      message.threadId,
      message.channel || '',
      message.provider || '',
      message.at || '',
      message.role || '',
      message.direction || '',
      callControlId,
      providerSourceId,
      message.body || '',
    ].join('|'),
  ].filter(Boolean)

  if (providerSourceId) {
    const providerKey = [
      message.threadId,
      message.channel || '',
      message.provider || '',
      callControlId,
      providerSourceId,
    ]
      .filter(Boolean)
      .join('|')
    const callProviderKey = [
      message.threadId,
      message.channel || '',
      callControlId,
      providerSourceId,
    ]
      .filter(Boolean)
      .join('|')
    keys.push(providerKey)
    if (callControlId) keys.push(callProviderKey)
  }

  return keys
}

export function mergeCommunicationMessages(
  ...messageGroups: CommunicationMessage[][]
) {
  const seen = new Set<string>()
  const messages: CommunicationMessage[] = []
  messageGroups.flat().forEach((message) => {
    const keys = communicationMessageDedupeKey(message)
    if (keys.some((key) => seen.has(key))) return
    keys.forEach((key) => seen.add(key))
    messages.push(message)
  })
  return messages.sort(
    (left, right) =>
      (left.at || '').localeCompare(right.at || '') ||
      left.messageId.localeCompare(right.messageId),
  )
}

export function communicationMessageSpeakerClass(message: CommunicationMessage) {
  if (message.channel === 'sms') return ''
  if (message.role === 'contact' || message.direction === 'inbound') return 'speaker-ai'
  if (message.role === 'agent' || message.direction === 'outbound') return 'speaker-lead'
  if (message.role === 'operator') return 'speaker-you'
  if (message.role === 'tool') return 'speaker-tool'
  return 'speaker-system'
}

export function communicationMessageLabel(message: CommunicationMessage) {
  if (message.role === 'contact' || message.role === 'user' || message.direction === 'inbound') {
    return 'Contact'
  }
  if (message.role === 'agent' || message.direction === 'outbound') return 'Agent'
  if (message.role === 'operator') return 'Operator'
  if (message.role === 'tool') return 'Tool'
  if (message.role === 'system') return 'System'
  return communicationChannelLabel(message.channel)
}

export function useCommunicationThreadMessages(
  threadId: string,
  {
    enabled = true,
    initialMessages,
    limit = 200,
    reloadKey = 0,
  }: UseCommunicationThreadMessagesOptions = {},
) {
  const [messages, setMessages] = useState<CommunicationMessage[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const hasInitialMessages = Array.isArray(initialMessages)

  useEffect(() => {
    if (hasInitialMessages || !enabled || !threadId) return undefined

    let cancelled = false

    async function loadMessages() {
      setLoading(true)
      setError('')
      try {
        const response = await fetch(
          apiUrl(`/communication-threads/${encodeURIComponent(threadId)}/messages?limit=${limit}`),
        )
        const payload = (await response.json().catch(() => ({}))) as CommunicationMessagesPayload
        if (!response.ok) throw new Error('Thread messages failed')
        if (!cancelled) setMessages(payload.messages || [])
      } catch (loadError) {
        if (cancelled) return
        setError(loadError instanceof Error ? loadError.message : 'Thread messages failed')
        setMessages([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void loadMessages()

    return () => {
      cancelled = true
    }
  }, [enabled, hasInitialMessages, limit, reloadKey, threadId])

  return {
    error: hasInitialMessages || !enabled || !threadId ? '' : error,
    loading: hasInitialMessages || !enabled || !threadId ? false : loading,
    messages: hasInitialMessages ? initialMessages || [] : enabled && threadId ? messages : [],
  }
}
