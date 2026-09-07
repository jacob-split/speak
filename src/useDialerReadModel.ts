import { useMemo } from 'react'
import {
  callDurationSeconds,
  callMatchesLead,
  formatCallDate,
  isActiveCallLive,
  isLiveRecentCall,
  recentAgentName,
  recentBusinessName,
} from './calls'
import type { RecentCallSummary } from './calls'
import { leadMatchesContactSourceKey } from './contactSources'
import {
  filterAndSortLeads,
  isCampaignDialable,
} from './leads'
import type { ScoreFilter, SortField, StatusFilter } from './leads'
import type {
  ActiveCall,
  CallPhase,
  Lead,
  LeadStatus,
  TranscriptEntry,
} from './types'

const workedStatuses = new Set<LeadStatus>([
  'follow-up',
  'no-answer',
  'voicemail',
  'not-interested',
  'skipped',
  'failed',
])

interface UseDialerReadModelOptions {
  leads: Lead[]
  activeAgentName: string
  activeCall: ActiveCall | null
  campaignQueueIds: string[]
  activeSmartViewId: string
  query: string
  recentCalls: RecentCallSummary[]
  scoreFilter: ScoreFilter
  selectedIds: Set<string>
  selectedLeadId: string | null
  sortDirection: 'asc' | 'desc'
  sortField: SortField
  sourceKey?: string
  stateFilter: string
  statusFilter: StatusFilter
  smartViewLeadIds?: Set<string>
  transcript: TranscriptEntry[]
}

interface LiveInstructionTarget {
  callControlId: string
  chatId?: string
  phase?: CallPhase | string
}

export function useDialerReadModel({
  leads,
  activeAgentName,
  activeCall,
  activeSmartViewId,
  campaignQueueIds,
  query,
  recentCalls,
  scoreFilter,
  selectedIds,
  selectedLeadId,
  sortDirection,
  sortField,
  sourceKey = '',
  stateFilter,
  statusFilter,
  smartViewLeadIds,
  transcript,
}: UseDialerReadModelOptions) {
  const activeCallLeadId = activeCall?.leadId
  const activeLead = useMemo(
    () => leads.find((lead) => lead.id === activeCallLeadId) ?? null,
    [activeCallLeadId, leads],
  )
  const activeCallIsLive = isActiveCallLive(activeCall)
  const liveActiveLead = activeCallIsLive ? activeLead : null

  const conversationTranscript = useMemo(
    () =>
      transcript.filter(
        (entry) =>
          (entry.speaker === 'AI' ||
            entry.speaker === 'Lead' ||
            entry.speaker === 'You') &&
          entry.tone !== 'system',
      ),
    [transcript],
  )

  const activeHistoryCall = useMemo(
    () => recentCalls.find(isLiveRecentCall) ?? null,
    [recentCalls],
  )

  const selectedLead = useMemo(
    () => leads.find((lead) => lead.id === selectedLeadId) ?? null,
    [leads, selectedLeadId],
  )

  const transcriptLead = selectedLead || liveActiveLead

  const selectedLeadCalls = useMemo(
    () =>
      transcriptLead
        ? recentCalls
            .filter((call) => callMatchesLead(call, transcriptLead))
            .filter(
              (call) =>
                !activeCallIsLive || call.callControlId !== activeCall?.callControlId,
            )
            .sort(
              (left, right) =>
                (Date.parse(left.createdAt || left.updatedAt || '') || 0) -
                (Date.parse(right.createdAt || right.updatedAt || '') || 0),
            )
        : [],
    [activeCall?.callControlId, activeCallIsLive, recentCalls, transcriptLead],
  )

  const calltimeByLeadId = useMemo(() => {
    const totals = new Map<string, number>()

    recentCalls.forEach((call) => {
      const seconds = callDurationSeconds(call)
      if (!seconds) return

      const leadId =
        call.lead?.id ||
        leads.find((lead) => callMatchesLead(call, lead))?.id
      if (!leadId) return

      totals.set(leadId, (totals.get(leadId) || 0) + seconds)
    })

    return totals
  }, [leads, recentCalls])

  const agentNameByLeadId = useMemo(() => {
    const names = new Map<string, string>()

    if (activeCallLeadId && activeAgentName) {
      names.set(activeCallLeadId, activeAgentName)
    }

    recentCalls.forEach((call) => {
      const agentName = recentAgentName(call)
      if (!agentName) return

      const leadId =
        call.lead?.id ||
        leads.find((lead) => callMatchesLead(call, lead))?.id
      if (!leadId || names.has(leadId)) return

      names.set(leadId, agentName)
    })

    return names
  }, [activeAgentName, activeCallLeadId, leads, recentCalls])

  const lastCallByLeadId = useMemo(() => {
    const labels = new Map<string, string>()
    const newestByLeadId = new Map<string, number>()

    recentCalls.forEach((call) => {
      const leadId =
        call.lead?.id ||
        leads.find((lead) => callMatchesLead(call, lead))?.id
      if (!leadId) return

      const timestampMs = Date.parse(call.createdAt || call.updatedAt || '')
      if (!timestampMs) return
      const currentNewest = newestByLeadId.get(leadId) || 0
      if (timestampMs <= currentNewest) return

      newestByLeadId.set(leadId, timestampMs)
      labels.set(leadId, formatCallDate(call.createdAt || call.updatedAt))
    })

    return labels
  }, [leads, recentCalls])

  const liveTranscriptBelongsToSelectedLead = Boolean(
    liveActiveLead && transcriptLead && liveActiveLead.id === transcriptLead.id,
  )
  const displayedHistoryCall = activeHistoryCall
  const displayedTranscript = conversationTranscript
  const displayedBusinessName =
    liveActiveLead?.company || recentBusinessName(displayedHistoryCall)
  const displayedPhase = activeCallIsLive
    ? activeCall?.phase
    : displayedHistoryCall?.phase || 'idle'
  const liveInstructionTarget: LiveInstructionTarget | null =
    activeCall && activeCallIsLive
      ? {
          callControlId: activeCall.callControlId,
          chatId: activeCall.chatId,
          phase: activeCall.phase,
        }
      : activeHistoryCall && isLiveRecentCall(activeHistoryCall)
        ? {
            callControlId: activeHistoryCall.callControlId,
            chatId: activeHistoryCall.chatId,
            phase: activeHistoryCall.phase,
          }
        : null

  const states = useMemo(() => {
    return Array.from(new Set(leads.map((lead) => lead.state))).sort()
  }, [leads])

  const filteredLeads = useMemo(
    () => {
      const contactSource = sourceKey
        ? leads.filter((lead) => leadMatchesContactSourceKey(lead, sourceKey))
        : []
      const smartViewSource =
        activeSmartViewId && smartViewLeadIds
          ? contactSource.filter((lead) => smartViewLeadIds.has(lead.id))
          : contactSource
      return filterAndSortLeads(smartViewSource, {
        query,
        statusFilter,
        stateFilter,
        scoreFilter,
        sortField,
        sortDirection,
        sortValue: (lead, field) =>
          field === 'calltime'
            ? calltimeByLeadId.get(lead.id) || 0
            : field === 'agent'
              ? agentNameByLeadId.get(lead.id) || ''
              : undefined,
      })
    },
    [
      activeSmartViewId,
      agentNameByLeadId,
      calltimeByLeadId,
      leads,
      query,
      scoreFilter,
      sourceKey,
      smartViewLeadIds,
      sortDirection,
      sortField,
      stateFilter,
      statusFilter,
    ],
  )

  const campaignReadyCount = useMemo(() => {
    const source =
      selectedIds.size > 0
        ? filteredLeads.filter((lead) => selectedIds.has(lead.id))
        : filteredLeads

    return source.filter(isCampaignDialable).length
  }, [filteredLeads, selectedIds])

  const campaignRemaining = useMemo(() => {
    const queuedIds = new Set(campaignQueueIds)
    return leads.filter((lead) => queuedIds.has(lead.id) && isCampaignDialable(lead))
      .length
  }, [campaignQueueIds, leads])

  const stats = useMemo(
    () => ({
      total: leads.length,
      ready: leads.filter((lead) => lead.status === 'ready').length,
      calling: leads.filter((lead) => lead.status === 'calling').length,
      worked: leads.filter((lead) => workedStatuses.has(lead.status)).length,
      dnc: leads.filter((lead) => lead.status === 'do-not-call').length,
    }),
    [leads],
  )

  const activeFilterCount = [
    sourceKey !== '',
    activeSmartViewId !== '',
    statusFilter !== 'all',
    stateFilter !== 'all',
    scoreFilter !== 'all',
  ].filter(Boolean).length

  return {
    activeCallIsLive,
    activeFilterCount,
    activeHistoryCall,
    activeLead,
    agentNameByLeadId,
    calltimeByLeadId,
    campaignReadyCount,
    campaignRemaining,
    conversationTranscript,
    displayedBusinessName,
    displayedHistoryCall,
    displayedPhase,
    displayedTranscript,
    filteredLeads,
    lastCallByLeadId,
    liveActiveLead,
    liveInstructionTarget,
    liveTranscriptBelongsToSelectedLead,
    selectedLead,
    selectedLeadCalls,
    states,
    stats,
    transcriptLead,
  }
}
