import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { AgentConfigProfile } from './agentConfigs'
import { apiUrl } from './api'
import { createId } from './ids'
import { formatOperationalDateTime } from './time'

export type SmartConfigRole = 'assistant' | 'system' | 'user'

export interface SmartConfigMessage {
  id: string
  at: string
  role: SmartConfigRole
  text: string
  tone?: 'attention' | 'neutral' | 'positive' | 'system'
}

export interface SmartConfigConversationSummary {
  createdAt: string
  id: string
  lastAssistantMessage?: string
  profileId: string
  profileName: string
  threadId: string
  title: string
  updatedAt: string
}

export interface SmartConfigProfileAppliedPayload {
  activeProfileId?: string
  changeSummary?: string[]
  ignoredConfigKeys?: string[]
  ok?: boolean
  profile?: AgentConfigProfile
  profiles?: AgentConfigProfile[]
  sync?: Record<string, unknown> | null
}

interface SmartConfigResponseMessage {
  content?: string
  createdAt?: string
  id?: string
  role?: SmartConfigRole
  text?: string
}

interface SmartConfigResponse {
  ok?: boolean
  conversations?: SmartConfigConversationSummary[]
  conversation?: SmartConfigConversationSummary
  messages?: SmartConfigResponseMessage[]
  error?: string
  loginUrl?: string
  message?: string
}

interface SmartConfigChatOptions {
  onProfileApplied?: (payload: SmartConfigProfileAppliedPayload) => void
  profileId: string
  profileName: string
}

interface SseEvent {
  event: string
  data: unknown
}

function timestamp() {
  return formatOperationalDateTime(new Date(), {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  })
}

function isoTimestamp() {
  return new Date().toISOString()
}

function smartConfigMessage(
  role: SmartConfigRole,
  text: string,
  tone: SmartConfigMessage['tone'] = 'neutral',
): SmartConfigMessage {
  return {
    id: createId('smart-config'),
    at: timestamp(),
    role,
    text,
    tone,
  }
}

function normalizeConversation(value: unknown): SmartConfigConversationSummary | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Partial<SmartConfigConversationSummary>
  const id = String(source.id || '')
  if (!id) return null
  return {
    createdAt: String(source.createdAt || source.updatedAt || isoTimestamp()),
    id,
    lastAssistantMessage: String(source.lastAssistantMessage || ''),
    profileId: String(source.profileId || ''),
    profileName: String(source.profileName || ''),
    threadId: String(source.threadId || ''),
    title: String(source.title || 'Smart Config'),
    updatedAt: String(source.updatedAt || source.createdAt || isoTimestamp()),
  }
}

function normalizeMessage(value: SmartConfigResponseMessage): SmartConfigMessage | null {
  const role = value?.role
  const text = String(value?.content || value?.text || '').trim()
  if (!text || (role !== 'assistant' && role !== 'system' && role !== 'user')) {
    return null
  }
  return {
    id: String(value.id || createId('smart-config')),
    at: value.createdAt ? timestamp() : timestamp(),
    role,
    text,
    tone: role === 'system' ? 'system' : 'neutral',
  } satisfies SmartConfigMessage
}

function smartConfigDisplayTitle(title: string) {
  return title.replace(/^Speak\s*\/\s*Main\s*\/\s*Smart Config\s*-\s*/i, '').trim()
}

function parseSseBlock(block: string): SseEvent | null {
  const lines = block.split(/\r?\n/)
  let event = 'message'
  const dataLines: string[] = []
  lines.forEach((line) => {
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart())
    }
  })

  if (!dataLines.length) return { event, data: {} }
  const dataText = dataLines.join('\n')
  try {
    return { event, data: JSON.parse(dataText) }
  } catch {
    return { event, data: dataText }
  }
}

async function readSseStream(
  response: Response,
  onEvent: (event: SseEvent) => void,
) {
  if (!response.body) throw new Error('Smart Config stream did not open.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let delimiter = buffer.match(/\r?\n\r?\n/)
    while (delimiter && delimiter.index !== undefined) {
      const block = buffer.slice(0, delimiter.index)
      buffer = buffer.slice(delimiter.index + delimiter[0].length)
      const event = parseSseBlock(block)
      if (event) onEvent(event)
      delimiter = buffer.match(/\r?\n\r?\n/)
    }
  }

  const finalBlock = buffer.trim()
  if (finalBlock) {
    const event = parseSseBlock(finalBlock)
    if (event) onEvent(event)
  }
}

export function useSmartConfigChat({
  onProfileApplied,
  profileId,
  profileName,
}: SmartConfigChatOptions) {
  const [activeConversationId, setActiveConversationId] = useState('')
  const [authChecking, setAuthChecking] = useState(true)
  const [authEmail, setAuthEmail] = useState('')
  const [authLoginUrl, setAuthLoginUrl] = useState('/api/smart-config/oauth/start')
  const [authRequired, setAuthRequired] = useState(false)
  const [conversations, setConversations] = useState<SmartConfigConversationSummary[]>([])
  const [loadingConversations, setLoadingConversations] = useState(false)
  const [messages, setMessages] = useState<SmartConfigMessage[]>([])
  const [sending, setSending] = useState(false)
  const [status, setStatus] = useState('Smart Config idle')
  const [activeTurnId, setActiveTurnId] = useState('')
  const activeStreamAbortRef = useRef<AbortController | null>(null)
  const profileScopeRef = useRef(profileId)

  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeConversationId) || null,
    [activeConversationId, conversations],
  )

  const refreshSession = useCallback(async () => {
    setAuthChecking(true)
    try {
      const response = await fetch(apiUrl('/smart-config/session'), {
        credentials: 'include',
      })
      const payload = (await response.json().catch(() => ({}))) as {
        authenticated?: boolean
        email?: string
        loginUrl?: string
      }
      setAuthRequired(!payload.authenticated)
      setAuthEmail(payload.email || '')
      setAuthLoginUrl(payload.loginUrl || '/api/smart-config/oauth/start')
      return payload
    } catch {
      setAuthRequired(true)
      setAuthEmail('')
      return null
    } finally {
      setAuthChecking(false)
    }
  }, [])

  const loadConversation = useCallback(async (
    conversationId: string,
    expectedProfileId = profileId,
  ) => {
    if (!conversationId) {
      if (profileScopeRef.current === expectedProfileId) setMessages([])
      return
    }

    const response = await fetch(
      apiUrl(`/smart-config/conversations/${encodeURIComponent(conversationId)}`),
      { credentials: 'include' },
    )
    const payload = (await response.json().catch(() => ({}))) as SmartConfigResponse
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.message || payload.error || 'Smart Config history failed')
    }
    const conversation = normalizeConversation(payload.conversation)
    if (conversation && conversation.profileId !== expectedProfileId) {
      throw new Error('Smart Config thread belongs to another agent.')
    }
    const nextMessages = (payload.messages || [])
      .map(normalizeMessage)
      .filter((message): message is SmartConfigMessage => Boolean(message))
    if (profileScopeRef.current !== expectedProfileId) return
    setMessages(nextMessages)
  }, [profileId])

  const refreshConversations = useCallback(async () => {
    if (!profileId) {
      setConversations([])
      setActiveConversationId('')
      setMessages([])
      return []
    }

    const expectedProfileId = profileId
    setLoadingConversations(true)
    try {
      const params = new URLSearchParams({ profileId })
      const response = await fetch(
        apiUrl(`/smart-config/conversations?${params.toString()}`),
        { credentials: 'include' },
      )
      const payload = (await response.json().catch(() => ({}))) as SmartConfigResponse
      if (!response.ok || payload.ok === false) {
        if (response.status === 401 || response.status === 403) {
          setAuthRequired(true)
          setAuthLoginUrl(payload.loginUrl || authLoginUrl)
        }
        throw new Error(payload.message || payload.error || 'Smart Config history failed')
      }

      const nextConversations = (payload.conversations || [])
        .map(normalizeConversation)
        .filter((conversation): conversation is SmartConfigConversationSummary =>
          Boolean(conversation),
        )
      if (profileScopeRef.current !== expectedProfileId) return []
      setConversations(nextConversations)
      const nextActive =
        nextConversations.find((conversation) => conversation.id === activeConversationId) ||
        nextConversations[0] ||
        null
      setActiveConversationId(nextActive?.id || '')
      if (nextActive) {
        await loadConversation(nextActive.id, expectedProfileId)
      } else {
        setMessages([])
      }
      setAuthRequired(false)
      return nextConversations
    } finally {
      if (profileScopeRef.current === expectedProfileId) {
        setLoadingConversations(false)
      }
    }
  }, [
    activeConversationId,
    authLoginUrl,
    loadConversation,
    profileId,
  ])

  useEffect(() => {
    profileScopeRef.current = profileId
    activeStreamAbortRef.current?.abort()
    activeStreamAbortRef.current = null
    const resetTimer = window.setTimeout(() => {
      setActiveConversationId('')
      setActiveTurnId('')
      setConversations([])
      setMessages([])
      setSending(false)
      setStatus(profileId ? 'Loading Smart Config history...' : 'Smart Config idle')
    }, 0)

    return () => window.clearTimeout(resetTimer)
  }, [profileId])

  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(() => {
      void (async () => {
        const session = await refreshSession()
        if (cancelled) return
        if (!session?.authenticated) {
          setConversations([])
          setActiveConversationId('')
          setMessages([])
          setStatus('Owner sign-in required')
          return
        }
        await refreshConversations().catch((error) => {
          if (cancelled) return
          setStatus(error instanceof Error ? error.message : 'Smart Config history failed')
        })
      })()
    }, 0)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [refreshConversations, refreshSession])

  useEffect(() => {
    return () => {
      activeStreamAbortRef.current?.abort()
      activeStreamAbortRef.current = null
    }
  }, [])

  const startGoogleSignIn = useCallback(() => {
    const returnTo =
      typeof window === 'undefined'
        ? '/'
        : `${window.location.pathname}${window.location.search}`
    const loginUrl = `${apiUrl('/smart-config/oauth/start')}?returnTo=${encodeURIComponent(returnTo)}`
    window.location.assign(loginUrl)
  }, [])

  const startNewConversation = useCallback(async () => {
    if (!profileId) return
    const expectedProfileId = profileId
    setLoadingConversations(true)
    try {
      const response = await fetch(apiUrl('/smart-config/conversations'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId, profileName }),
      })
      const payload = (await response.json().catch(() => ({}))) as SmartConfigResponse
      if (!response.ok || payload.ok === false || !payload.conversation) {
        if (response.status === 401 || response.status === 403) {
          setAuthRequired(true)
          setAuthLoginUrl(payload.loginUrl || authLoginUrl)
        }
        throw new Error(payload.message || payload.error || 'Smart Config conversation failed')
      }
      if (profileScopeRef.current !== expectedProfileId) return
      const conversation = normalizeConversation(payload.conversation)
      const nextConversations = (payload.conversations || [])
        .map(normalizeConversation)
        .filter((item): item is SmartConfigConversationSummary => Boolean(item))
      setConversations(conversation ? [conversation, ...nextConversations.filter((item) => item.id !== conversation.id)] : nextConversations)
      setActiveConversationId(conversation?.id || '')
      setMessages([])
      setStatus('New Smart Config thread')
    } catch (error) {
      if (profileScopeRef.current !== expectedProfileId) return
      setStatus(error instanceof Error ? error.message : 'Smart Config conversation failed')
    } finally {
      if (profileScopeRef.current === expectedProfileId) {
        setLoadingConversations(false)
      }
    }
  }, [authLoginUrl, profileId, profileName])

  const selectConversation = useCallback(
    async (conversationId: string) => {
      if (!conversationId || conversationId === activeConversationId) return
      const selectedConversation = conversations.find(
        (conversation) => conversation.id === conversationId,
      )
      if (!selectedConversation || selectedConversation.profileId !== profileId) return
      setActiveConversationId(conversationId)
      setStatus('Loading Smart Config thread...')
      try {
        await loadConversation(conversationId, profileId)
        setStatus('Smart Config idle')
      } catch (error) {
        if (profileScopeRef.current !== profileId) return
        setStatus(error instanceof Error ? error.message : 'Smart Config history failed')
      }
    },
    [activeConversationId, conversations, loadConversation, profileId],
  )

  const sendMessage = useCallback(
    async (text: string) => {
      const messageText = text.trim()
      const steeringActiveTurn = Boolean(sending && activeTurnId)
      if (!messageText || (!steeringActiveTurn && sending) || !profileId) return

      const userMessage = smartConfigMessage('user', messageText)
      const expectedProfileId = profileId
      const assistantDraftId = steeringActiveTurn
        ? ''
        : createId('smart-config-assistant')
      setMessages((current) => [...current, userMessage])
      if (!steeringActiveTurn) {
        setSending(true)
        setActiveTurnId('')
      }
      setStatus(
        steeringActiveTurn
          ? 'Steering Smart Config...'
          : 'Starting Smart Config...',
      )

      let abortController: AbortController | null = null
      try {
        abortController = steeringActiveTurn ? null : new AbortController()
        if (abortController) activeStreamAbortRef.current = abortController
        const response = await fetch(apiUrl('/smart-config/turns/stream'), {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          signal: abortController?.signal,
          body: JSON.stringify({
            conversationId: activeConversationId,
            expectedTurnId: steeringActiveTurn ? activeTurnId : undefined,
            message: messageText,
            profileId,
            steer: steeringActiveTurn,
          }),
        })

        const contentType = response.headers.get('content-type') || ''
        if (!response.ok || !contentType.includes('text/event-stream')) {
          const payload = (await response.json().catch(() => ({}))) as SmartConfigResponse
          if (response.status === 401 || response.status === 403) {
            setAuthRequired(true)
            setAuthLoginUrl(payload.loginUrl || authLoginUrl)
          }
          throw new Error(payload.message || payload.error || 'Smart Config turn failed')
        }

        let assistantStarted = false
        await readSseStream(response, ({ event, data }) => {
          if (profileScopeRef.current !== expectedProfileId) return
          const payload = data as Record<string, unknown>
          if (event === 'thread') {
            const conversation = normalizeConversation(payload.conversation)
            if (conversation) {
              setActiveConversationId(conversation.id)
              setConversations((current) => [
                conversation,
                ...current.filter((item) => item.id !== conversation.id),
              ])
            }
            return
          }

          if (event === 'turn') {
            const nextTurnId = String(payload.turnId || '')
            if (nextTurnId) setActiveTurnId(nextTurnId)
            return
          }

          if (event === 'user_message' && steeringActiveTurn) {
            setStatus('Smart Config steered')
            return
          }

          if (event === 'assistant_delta') {
            const nextTurnId = String(payload.turnId || '')
            if (nextTurnId) setActiveTurnId(nextTurnId)
            const delta = String(payload.delta || '')
            if (!delta) return
            setMessages((current) => {
              const existing = current.find((item) => item.id === assistantDraftId)
              if (!existing) {
                assistantStarted = true
                return [
                  ...current,
                  {
                    id: assistantDraftId,
                    at: timestamp(),
                    role: 'assistant',
                    text: delta,
                    tone: 'neutral',
                  },
                ]
              }
              return current.map((item) =>
                item.id === assistantDraftId
                  ? { ...item, text: `${item.text}${delta}` }
                  : item,
              )
            })
            setStatus('Smart Config responding...')
            return
          }

          if (event === 'assistant_final') {
            const finalText = String(payload.content || payload.text || '').trim()
            if (!finalText) return
            setMessages((current) => {
              const existing = current.find((item) => item.id === assistantDraftId)
              if (!existing && !assistantStarted) {
                return [
                  ...current,
                  smartConfigMessage('assistant', finalText, 'positive'),
                ]
              }
              return current.map((item) =>
                item.id === assistantDraftId
                  ? { ...item, text: finalText, tone: 'positive' }
                  : item,
              )
            })
            setStatus('Smart Config complete')
            return
          }

          if (event === 'tool_progress') {
            const label = String(payload.label || 'Smart Config working')
            const progressStatus = String(payload.status || '')
            setStatus(progressStatus ? `${label} / ${progressStatus}` : label)
            return
          }

          if (event === 'profile_applied') {
            onProfileApplied?.(payload as SmartConfigProfileAppliedPayload)
            const applied = payload as SmartConfigProfileAppliedPayload
            const summary =
              applied.changeSummary?.join(' ') ||
              `${applied.profile?.name || profileName} updated.`
            setMessages((current) => [
              ...current,
              smartConfigMessage('system', summary, 'positive'),
            ])
            return
          }

          if (event === 'error') {
            const errorText = String(payload.message || payload.error || 'Smart Config failed')
            setMessages((current) => [
              ...current,
              smartConfigMessage('system', errorText, 'attention'),
            ])
            setStatus(errorText)
            return
          }
        })

        setAuthRequired(false)
        void refreshConversations()
      } catch (error) {
        if (profileScopeRef.current !== expectedProfileId) return
        if (error instanceof DOMException && error.name === 'AbortError') {
          setStatus('Smart Config stopped')
          return
        }
        const errorText =
          error instanceof Error ? error.message : 'Smart Config turn failed'
        setMessages((current) => [
          ...current,
          smartConfigMessage('system', errorText, 'attention'),
        ])
        setStatus(errorText)
      } finally {
        if (!steeringActiveTurn && profileScopeRef.current === expectedProfileId) {
          if (abortController && activeStreamAbortRef.current === abortController) {
            activeStreamAbortRef.current = null
          }
          setSending(false)
          setActiveTurnId('')
        }
      }
    },
    [
      activeConversationId,
      activeTurnId,
      authLoginUrl,
      onProfileApplied,
      profileId,
      profileName,
      refreshConversations,
      sending,
    ],
  )

  const stopMessage = useCallback(() => {
    activeStreamAbortRef.current?.abort()
    activeStreamAbortRef.current = null
    setSending(false)
    setActiveTurnId('')
    setStatus('Smart Config stopped')
  }, [])

  const conversationSummaries = useMemo(
    () =>
      conversations.map((conversation) => ({
        ...conversation,
        title: smartConfigDisplayTitle(conversation.title) || conversation.profileName || 'Smart Config',
      })),
    [conversations],
  )

  return {
    activeConversation,
    activeConversationId,
    authChecking,
    authEmail,
    authLoginUrl,
    authRequired,
    conversations: conversationSummaries,
    loadingConversations,
    messages,
    refreshConversations,
    refreshSession,
    selectConversation,
    sendMessage,
    sending,
    startGoogleSignIn,
    startNewConversation,
    status,
    stopMessage,
    steerReady: Boolean(activeTurnId),
  }
}
