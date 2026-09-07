import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useEffect,
} from 'react'
import { apiUrl } from './api'
import { appendTranscriptEntry } from './calls'
import type {
  ActiveCall,
  CallOutcome,
  Lead,
  TranscriptEntry,
} from './types'

interface ActiveCallEventPayload {
  entry?: TranscriptEntry
  patch?: Partial<ActiveCall>
  leadPatch?: {
    leadId: string
    patch: Partial<Lead>
  }
  outcome?: CallOutcome
  notice?: string
}

interface UseActiveCallEventsOptions {
  activeCallControlId?: string
  activeCallRef: MutableRefObject<ActiveCall | null>
  setActiveCall: Dispatch<SetStateAction<ActiveCall | null>>
  setNotice: (message: string) => void
  setTranscript: Dispatch<SetStateAction<TranscriptEntry[]>>
  updateLead: (id: string, patch: Partial<Lead>) => void
}

export function useActiveCallEvents({
  activeCallControlId,
  activeCallRef,
  setActiveCall,
  setNotice,
  setTranscript,
  updateLead,
}: UseActiveCallEventsOptions) {
  useEffect(() => {
    if (!activeCallControlId) return undefined

    const events = new EventSource(
      apiUrl(`/calls/${encodeURIComponent(activeCallControlId)}/events`),
    )

    events.onmessage = (event) => {
      const payload = JSON.parse(event.data) as ActiveCallEventPayload

      if (payload.entry) {
        setTranscript((current) =>
          appendTranscriptEntry(current, payload.entry as TranscriptEntry),
        )
      }

      if (payload.patch) {
        setActiveCall((current) => {
          if (!current) return current
          const next = { ...current, ...payload.patch }
          activeCallRef.current = next
          return next
        })
      }

      if (payload.outcome) {
        setActiveCall((current) => {
          if (!current) return current
          const next = { ...current, outcome: payload.outcome }
          activeCallRef.current = next
          return next
        })
      }

      if (payload.leadPatch) {
        updateLead(payload.leadPatch.leadId, payload.leadPatch.patch)
      }

      if (payload.notice) {
        setNotice(payload.notice)
      }
    }

    events.onerror = () => {
      setNotice('Live event stream disconnected')
    }

    return () => events.close()
  }, [
    activeCallControlId,
    activeCallRef,
    setActiveCall,
    setNotice,
    setTranscript,
    updateLead,
  ])
}
