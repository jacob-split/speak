import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
} from 'react'
import {
  callTimeLabel,
  shouldAutoAdvanceForOutcome,
} from './calls'
import type { RecentCallSummary } from './calls'
import {
  statusForOutcome,
} from './leads'
import type {
  ActiveCall,
  CallOutcome,
  Lead,
} from './types'

interface UseRecentCallRecoveryOptions {
  activeCallRef: MutableRefObject<ActiveCall | null>
  autoAdvanceKeyRef: MutableRefObject<string>
  autoDialTimerRef: MutableRefObject<number | null>
  campaignRunningRef: MutableRefObject<boolean>
  leadsRef: MutableRefObject<Lead[]>
  scheduleNextCampaignCall: (afterLeadId: string, outcome: CallOutcome) => void
  setActiveCall: Dispatch<SetStateAction<ActiveCall | null>>
  setLeadsState: (updater: SetStateAction<Lead[]>) => void
  setNotice: (message: string) => void
}

interface CallsRefreshedOptions {
  recoverCampaign: boolean
}

export function useRecentCallRecovery({
  activeCallRef,
  autoAdvanceKeyRef,
  autoDialTimerRef,
  campaignRunningRef,
  leadsRef,
  scheduleNextCampaignCall,
  setActiveCall,
  setLeadsState,
  setNotice,
}: UseRecentCallRecoveryOptions) {
  const applyRecentCallDispositions = useCallback((calls: RecentCallSummary[]) => {
    const latestByLeadId = new Map<string, RecentCallSummary>()

    calls.forEach((call) => {
      const leadId = call.lead?.id
      const outcome = call.outcome as CallOutcome | ''
      if (!leadId || !outcome) return
      if (
        !shouldAutoAdvanceForOutcome(outcome) &&
        outcome !== 'operator-ended'
      ) {
        return
      }

      const existing = latestByLeadId.get(leadId)
      const existingTime = Date.parse(existing?.updatedAt || '') || 0
      const callTime = Date.parse(call.updatedAt || '') || 0
      if (!existing || callTime >= existingTime) {
        latestByLeadId.set(leadId, call)
      }
    })

    if (latestByLeadId.size === 0) return

    setLeadsState((current) => {
      let changed = false
      const next = current.map((lead) => {
        const call = latestByLeadId.get(lead.id)
        if (!call || lead.status === 'calling') return lead

        const outcome = call.outcome as CallOutcome
        const nextStatus = statusForOutcome(outcome)
        const nextLastCall = callTimeLabel(call.updatedAt)
        if (lead.status === nextStatus && lead.lastCall === nextLastCall) {
          return lead
        }

        changed = true
        return {
          ...lead,
          status: nextStatus,
          lastCall: nextLastCall,
        }
      })

      if (changed) leadsRef.current = next
      return changed ? next : current
    })
  }, [leadsRef, setLeadsState])

  const recoverCampaignFromRecentCalls = useCallback((calls: RecentCallSummary[]) => {
    const active = activeCallRef.current
    if (!campaignRunningRef.current || !active) return

    const summary = calls.find((call) => call.callControlId === active.callControlId)
    const outcome = summary?.outcome as CallOutcome | ''
    if (!summary || !outcome || !shouldAutoAdvanceForOutcome(outcome)) return
    if (summary.phase !== 'ended' && summary.phase !== 'idle') return

    setActiveCall((current) => {
      if (!current || current.callControlId !== active.callControlId) return current
      const next = {
        ...current,
        phase: 'ended' as const,
        takeover: false,
        outcome,
      }
      activeCallRef.current = next
      return next
    })

    const key = `${active.callControlId}:${outcome}`
    if (autoAdvanceKeyRef.current === key || autoDialTimerRef.current) return

    autoAdvanceKeyRef.current = key
    setNotice('Recovered ended call from backend history; moving to the next contact')
    scheduleNextCampaignCall(active.leadId, outcome)
  }, [
    activeCallRef,
    autoAdvanceKeyRef,
    autoDialTimerRef,
    campaignRunningRef,
    scheduleNextCampaignCall,
    setActiveCall,
    setNotice,
  ])

  return useCallback((
    calls: RecentCallSummary[],
    options: CallsRefreshedOptions,
  ) => {
    applyRecentCallDispositions(calls)
    if (options.recoverCampaign) {
      recoverCampaignFromRecentCalls(calls)
    }
  }, [applyRecentCallDispositions, recoverCampaignFromRecentCalls])
}
