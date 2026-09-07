import type {
  Dispatch,
  SetStateAction,
} from 'react'
import {
  MessageSquareText,
} from './SpeakIcons'
import { LeadTable } from './LeadTable'
import type {
  ActiveCall,
  Lead,
} from './types'
import { speakTestIds } from './uiContract'

interface LeadQueuePanelProps {
  activeCall: ActiveCall | null
  activeCallIsLive: boolean
  agentNameByLeadId: Map<string, string>
  calltimeByLeadId: Map<string, number>
  emptyStateActionLabel?: string
  emptyStateText: string
  filteredLeads: Lead[]
  lastCallByLeadId: Map<string, string>
  onEmptyStateAction?: () => void
  onOpenTranscript: (leadId: string) => void
  selectedIds: Set<string>
  setSelectedLeadId: Dispatch<SetStateAction<string | null>>
  toggleRow: (id: string) => void
  transcriptLead: Lead | null
  updateLead: (id: string, patch: Partial<Lead>) => void
}

export function LeadQueuePanel({
  activeCall,
  activeCallIsLive,
  agentNameByLeadId,
  calltimeByLeadId,
  emptyStateActionLabel,
  emptyStateText,
  filteredLeads,
  lastCallByLeadId,
  onEmptyStateAction,
  onOpenTranscript,
  selectedIds,
  setSelectedLeadId,
  toggleRow,
  transcriptLead,
  updateLead,
}: LeadQueuePanelProps) {
  const liveLead = activeCallIsLive && activeCall
    ? filteredLeads.find((lead) => lead.id === activeCall.leadId) || null
    : null
  const viewingLiveLead = Boolean(
    liveLead && transcriptLead && liveLead.id === transcriptLead.id,
  )

  return (
    <section
      id="lead-queue"
      className="panel lead-panel"
      data-testid={speakTestIds.leadQueue}
      aria-label="Contact workspace"
    >
      {liveLead && !viewingLiveLead && (
        <button
          className="lead-live-return"
          type="button"
          onClick={() => onOpenTranscript(liveLead.id)}
        >
          <MessageSquareText size={15} />
          <span>Live call</span>
          <strong title={leadBusinessName(liveLead)}>{leadBusinessName(liveLead)}</strong>
        </button>
      )}

      <LeadTable
        activeCall={activeCall}
        activeCallIsLive={activeCallIsLive}
        agentNameByLeadId={agentNameByLeadId}
        calltimeByLeadId={calltimeByLeadId}
        emptyStateActionLabel={emptyStateActionLabel}
        emptyStateText={emptyStateText}
        filteredLeads={filteredLeads}
        lastCallByLeadId={lastCallByLeadId}
        onEmptyStateAction={onEmptyStateAction}
        onOpenTranscript={onOpenTranscript}
        selectedIds={selectedIds}
        setSelectedLeadId={setSelectedLeadId}
        toggleRow={toggleRow}
        transcriptLead={transcriptLead}
        updateLead={updateLead}
      />
    </section>
  )
}

function leadBusinessName(lead: Lead) {
  return lead.company.trim() || lead.name.trim() || 'Unknown business'
}
