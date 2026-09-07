import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { apiUrl } from './api'
import {
  normalizeRecentCallLiveness,
  recentCallHistoryLimit,
} from './calls'
import type { RecentCallSummary } from './calls'

export interface CommunicationProviderLink {
  id?: string
  kind?: string
  provider?: string
}

export interface CommunicationParticipant {
  contactId?: string
  label?: string
  role?: string
}

export interface CommunicationThreadSummary {
  channels?: string[]
  contactId?: string
  emotionScoreTurns?: number
  hasEmotionScores?: boolean
  latestChannel?: string
  latestMessagePreview?: string
  messageCount?: number
  participants?: CommunicationParticipant[]
  providerLinks?: CommunicationProviderLink[]
  status?: string
  summary?: string
  threadId: string
  updatedAt?: string
}

interface RefreshRecentCallsOptions {
  recoverCampaign?: boolean
}

interface CallsRefreshedOptions {
  recoverCampaign: boolean
}

interface UseRecentCallsOptions {
  onCallsRefreshed?: (
    calls: RecentCallSummary[],
    options: CallsRefreshedOptions,
  ) => void
  pollMs?: number
}

const defaultRecentCallPollMs = 5000

export function useRecentCalls({
  onCallsRefreshed,
  pollMs = defaultRecentCallPollMs,
}: UseRecentCallsOptions = {}) {
  const [recentCalls, setRecentCalls] = useState<RecentCallSummary[]>([])
  const [communicationThreads, setCommunicationThreads] = useState<
    CommunicationThreadSummary[]
  >([])
  const [recentCallsLoaded, setRecentCallsLoaded] = useState(false)
  const onCallsRefreshedRef = useRef(onCallsRefreshed)

  useEffect(() => {
    onCallsRefreshedRef.current = onCallsRefreshed
  }, [onCallsRefreshed])

  const refreshRecentCalls = useCallback(
    async (options: RefreshRecentCallsOptions = {}) => {
      const recoverCampaign = options.recoverCampaign ?? true

      try {
        const [response, threadsResponse] = await Promise.all([
          fetch(apiUrl(`/calls/recent?limit=${recentCallHistoryLimit}`)),
          fetch(apiUrl(`/communication-threads?limit=${recentCallHistoryLimit}`)).catch(
            () => null,
          ),
        ])
        if (!response.ok) return []

        const payload = (await response.json()) as { calls?: RecentCallSummary[] }
        const threadsPayload = ((await threadsResponse?.json().catch(() => ({}))) ||
          {}) as {
          threads?: CommunicationThreadSummary[]
        }
        const nowMs = Date.now()
        const calls = (payload.calls || []).map((call) =>
          normalizeRecentCallLiveness(call, nowMs),
        )
        setRecentCalls(calls)
        setCommunicationThreads(threadsPayload.threads || [])
        onCallsRefreshedRef.current?.(calls, { recoverCampaign })
        return calls
      } catch {
        // Recent call history is supplemental; live calling should not depend on it.
        return []
      } finally {
        setRecentCallsLoaded(true)
      }
    },
    [],
  )

  useEffect(() => {
    const initialRefresh = window.setTimeout(() => {
      void refreshRecentCalls()
    }, 0)
    const interval = window.setInterval(() => {
      void refreshRecentCalls()
    }, pollMs)

    return () => {
      window.clearTimeout(initialRefresh)
      window.clearInterval(interval)
    }
  }, [pollMs, refreshRecentCalls])

  return {
    communicationThreads,
    recentCalls,
    recentCallsLoaded,
    refreshRecentCalls,
  }
}
