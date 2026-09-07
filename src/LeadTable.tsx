import {
  type CSSProperties,
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import {
  Check,
  SlidersHorizontal,
  X,
} from './SpeakIcons'
import { CopyAction } from './CopyAction'
import {
  ContactDeliveryComposer,
  DeviceCallFieldAction,
  EmailFieldAction,
  SmsFieldActions,
} from './ContactDeliveryActions'
import { cleanEmailAddress } from './ContactDeliveryUtils'
import { formatCallDurationClock } from './calls'
import {
  isValidPhoneNumber,
  splitLeadName,
  statusLabels,
  statusOptions,
} from './leads'
import {
  normalizePhoneNumber,
  normalizePhoneOnCommit,
} from './phoneNumbers'
import type {
  ActiveCall,
  Lead,
  LeadStatus,
} from './types'
import { speakActionIds, speakTestIds } from './uiContract'
import { useDismissibleLayer } from './useDismissibleLayer'

interface LeadTableProps {
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

const contactListRenderBatchSize = 250

function leadBusinessName(lead: Lead) {
  return lead.company.trim() || lead.name.trim() || 'Unknown business'
}

function leadContactName(lead: Lead) {
  return lead.name.trim() || [lead.firstName, lead.lastName].filter(Boolean).join(' ')
}

interface ViewportPopoverPosition {
  top: number
  left: number
  width: number
  maxHeight: number
}

function anchoredLeadDetailPosition(anchor: HTMLElement): ViewportPopoverPosition | null {
  if (window.matchMedia('(max-width: 760px)').matches) return null

  const rect = anchor.getBoundingClientRect()
  const viewport = window.visualViewport
  const viewportWidth = viewport?.width ?? window.innerWidth
  const viewportHeight = viewport?.height ?? window.innerHeight
  const viewportLeft = viewport?.offsetLeft ?? 0
  const viewportTop = viewport?.offsetTop ?? 0
  const margin = 14
  const desktopChromeClearance = 64
  const minTop = viewportTop + desktopChromeClearance
  const width = Math.min(480, Math.max(340, viewportWidth - margin * 2))
  const maxHeight = Math.min(
    760,
    Math.max(300, viewportHeight - desktopChromeClearance - margin),
  )
  const panelRect = anchor
    .closest('.lead-panel, .lead-contact-workspace')
    ?.getBoundingClientRect()
  const preferredLeft = panelRect ? panelRect.right + 12 : rect.right + 10
  const maxLeft = viewportLeft + viewportWidth - width - margin
  const maxTop = viewportTop + viewportHeight - maxHeight - margin

  return {
    top: Math.max(minTop, Math.min(rect.top - 12, maxTop)),
    left: Math.max(viewportLeft + margin, Math.min(preferredLeft, maxLeft)),
    width,
    maxHeight,
  }
}

export function LeadTable({
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
}: LeadTableProps) {
  const [detailLeadId, setDetailLeadId] = useState<string | null>(null)
  const [detailPosition, setDetailPosition] = useState<ViewportPopoverPosition | null>(null)
  const [renderLimit, setRenderLimit] = useState(contactListRenderBatchSize)
  const detailLead = detailLeadId
    ? filteredLeads.find((lead) => lead.id === detailLeadId) || null
    : null
  const detailPopoverRef = useRef<HTMLElement | null>(null)
  const renderedLeads = filteredLeads.slice(0, renderLimit)
  const remainingLeadCount = Math.max(0, filteredLeads.length - renderedLeads.length)

  useEffect(() => {
    const resetTimer = window.setTimeout(() => {
      setRenderLimit(contactListRenderBatchSize)
    }, 0)
    return () => window.clearTimeout(resetTimer)
  }, [filteredLeads])

  const closeDetailLead = useCallback(() => {
    setDetailLeadId(null)
    setDetailPosition(null)
  }, [])

  function openLeadDetails(leadId: string, anchor: HTMLElement) {
    setDetailLeadId(leadId)
    setDetailPosition(anchoredLeadDetailPosition(anchor))
  }

  useDismissibleLayer({
    enabled: Boolean(detailLead),
    onDismiss: closeDetailLead,
    refs: [detailPopoverRef],
  })

  return (
    <div className="lead-contact-workspace">
      <div className="lead-contact-list" role="list" aria-label="Business contacts">
        {filteredLeads.length > 0 &&
          renderedLeads.map((lead) => (
            <LeadContactRow
              key={lead.id}
              activeCall={activeCall}
              activeCallIsLive={activeCallIsLive}
              agentName={agentNameByLeadId.get(lead.id) || 'Not recorded'}
              calltime={formatCallDurationClock(calltimeByLeadId.get(lead.id) || 0)}
              lead={lead}
              lastCallLabel={lastCallByLeadId.get(lead.id) || lead.lastCall || 'Never'}
              onOpenDetails={(anchor) => openLeadDetails(lead.id, anchor)}
              onOpenTranscript={() => onOpenTranscript(lead.id)}
              selected={selectedIds.has(lead.id)}
              setSelectedLeadId={setSelectedLeadId}
              toggleRow={toggleRow}
              transcriptLead={transcriptLead}
            />
          ))}
        {remainingLeadCount > 0 && (
          <button
            className="contact-list-load-more"
            type="button"
            onClick={() =>
              setRenderLimit((current) =>
                Math.min(current + contactListRenderBatchSize, filteredLeads.length),
              )
            }
          >
            <span>
              Show {Math.min(contactListRenderBatchSize, remainingLeadCount)} more
            </span>
            <strong>
              {renderedLeads.length}/{filteredLeads.length}
            </strong>
          </button>
        )}
        {filteredLeads.length === 0 && (emptyStateText || emptyStateActionLabel) && (
          <div className="empty-table-state">
            <span>{emptyStateText}</span>
            {emptyStateActionLabel && onEmptyStateAction && (
              <button
                className="secondary-button"
                type="button"
                onClick={onEmptyStateAction}
              >
                {emptyStateActionLabel}
              </button>
            )}
          </div>
        )}
      </div>

      {detailLead && typeof document !== 'undefined' && createPortal(
        <div
          className="lead-detail-backdrop"
          role="presentation"
        >
          <LeadDetailEditor
            agentName={agentNameByLeadId.get(detailLead.id) || 'Not recorded'}
            calltime={formatCallDurationClock(
              calltimeByLeadId.get(detailLead.id) || 0,
            )}
            lead={detailLead}
            onClose={closeDetailLead}
            position={detailPosition}
            rootRef={detailPopoverRef}
            updateLead={updateLead}
          />
        </div>,
        document.body,
      )}
    </div>
  )
}

interface LeadContactRowProps {
  activeCall: ActiveCall | null
  activeCallIsLive: boolean
  agentName: string
  calltime: string
  lead: Lead
  lastCallLabel: string
  onOpenDetails: (anchor: HTMLElement) => void
  onOpenTranscript: () => void
  selected: boolean
  setSelectedLeadId: Dispatch<SetStateAction<string | null>>
  toggleRow: (id: string) => void
  transcriptLead: Lead | null
}

function LeadContactRow({
  activeCall,
  activeCallIsLive,
  agentName,
  calltime,
  lead,
  lastCallLabel,
  onOpenDetails,
  onOpenTranscript,
  selected,
  setSelectedLeadId,
  toggleRow,
  transcriptLead,
}: LeadContactRowProps) {
  const isActive = transcriptLead?.id === lead.id
  const isLiveLead = activeCallIsLive && activeCall?.leadId === lead.id
  const businessName = leadBusinessName(lead)

  function selectLead() {
    setSelectedLeadId(lead.id)
  }

  function activateLead() {
    selectLead()
    if (window.matchMedia('(max-width: 1180px)').matches) {
      onOpenTranscript()
    }
  }

  return (
    <article
      className={[
        'lead-contact-row',
        isActive ? 'lead-active' : '',
        isLiveLead ? 'lead-live' : '',
        selected ? 'row-selected' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      role="listitem"
      data-lead-id={lead.id}
      data-action-id={speakActionIds.selectLead}
      data-testid={speakTestIds.leadRow}
      tabIndex={0}
      aria-current={isActive ? 'true' : undefined}
      onClick={activateLead}
      onFocus={selectLead}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        activateLead()
      }}
    >
      <button
        className="icon-button lead-detail-trigger lead-field-popout-trigger"
        type="button"
        data-action-id={speakActionIds.openLeadDetails}
        title={`View and edit ${businessName}`}
        aria-label={`View and edit ${businessName}`}
        onClick={(event) => {
          event.stopPropagation()
          onOpenDetails(event.currentTarget)
        }}
      >
        <SlidersHorizontal size={14} />
      </button>
      <button
        className={[
          'selection-toggle',
          'row-selection-toggle',
          'lead-row-selection-toggle',
          selected ? 'selected' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        type="button"
        data-action-id={speakActionIds.selectLead}
        aria-pressed={selected}
        title={selected ? `Unselect ${businessName}` : `Select ${businessName}`}
        aria-label={selected ? `Unselect ${businessName}` : `Select ${businessName}`}
        onClick={(event) => {
          event.stopPropagation()
          toggleRow(lead.id)
        }}
      >
        <Check size={14} />
      </button>
      <div className="lead-contact-copy">
        <div className="lead-contact-title-line">
          <strong title={businessName}>{businessName}</strong>
        </div>
        <p title={lastCallLabel}>{lastCallLabel}</p>
        <div className="lead-contact-meta">
          <span>{calltime}</span>
          <span title={agentName}>{agentName}</span>
        </div>
      </div>
    </article>
  )
}

interface LeadDetailEditorProps {
  agentName: string
  calltime: string
  lead: Lead
  onClose: () => void
  position: ViewportPopoverPosition | null
  rootRef: RefObject<HTMLElement | null>
  updateLead: (id: string, patch: Partial<Lead>) => void
}

function LeadDetailEditor({
  agentName,
  calltime,
  lead,
  onClose,
  position,
  rootRef,
  updateLead,
}: LeadDetailEditorProps) {
  const businessName = leadBusinessName(lead)
  const phoneReady = isValidPhoneNumber(lead.phone)
  const copyPhone = normalizePhoneNumber(lead.phone) || lead.phone.trim()
  const copyEmail = cleanEmailAddress(lead.email) || lead.email.trim()
  const emailReady = Boolean(cleanEmailAddress(lead.email))
  const [deliveryComposer, setDeliveryComposer] = useState<'sms' | 'email' | null>(null)

  function commitPhone(value: string) {
    const nextPhone = normalizePhoneOnCommit(value)
    if (nextPhone && nextPhone !== lead.phone) {
      updateLead(lead.id, { phone: nextPhone })
    }
  }

  return (
    <section
      className="lead-detail-editor lead-detail-popout"
      data-action-id={speakActionIds.editLead}
      aria-label={`${businessName} details`}
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      style={
        position
          ? ({
              position: 'fixed',
              top: position.top,
              left: position.left,
              width: position.width,
              maxHeight: position.maxHeight,
            } satisfies CSSProperties)
          : undefined
      }
    >
      <div className="lead-detail-header">
        <div className="lead-detail-title">
          <strong title={businessName}>{businessName}</strong>
          <span>{lead.phone || leadContactName(lead) || 'No contact name'}</span>
        </div>
        <div className="lead-detail-actions">
          <button
            className="icon-button"
            type="button"
            data-action-id={speakActionIds.closeLeadDetails}
            title="Close contact details"
            aria-label="Close contact details"
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </div>
      </div>

      <div className="lead-detail-grid">
        <label className="config-field span-2">
          <span>Business</span>
          <input
            value={lead.company}
            data-action-id={speakActionIds.editLead}
            onChange={(event) =>
              updateLead(lead.id, {
                company: event.target.value,
              })
            }
          />
        </label>
        <label className="config-field span-2">
          <span>Contact</span>
          <input
            value={lead.name}
            data-action-id={speakActionIds.editLead}
            onChange={(event) => {
              const name = event.target.value
              updateLead(lead.id, {
                name,
                ...splitLeadName(name),
              })
            }}
          />
        </label>
        <label className="config-field span-2">
          <span>Phone</span>
          <div
            className={[
              'phone-input-shell',
              phoneReady || !lead.phone.trim() ? '' : 'invalid',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <input
              data-action-id={speakActionIds.editLead}
              inputMode="tel"
              type="tel"
              value={lead.phone}
              onBlur={(event) => commitPhone(event.target.value)}
              onChange={(event) =>
                updateLead(lead.id, {
                  phone: event.target.value,
                })
              }
            />
            <CopyAction
              className="phone-input-action"
              disabled={!copyPhone}
              label="Copy phone"
              value={copyPhone}
            />
            <DeviceCallFieldAction
              disabled={!phoneReady}
              label={`Call ${businessName} from this device`}
              phone={copyPhone}
            />
            <SmsFieldActions
              disabled={!phoneReady}
              lead={lead}
              onOpenAgentSms={() => setDeliveryComposer('sms')}
              phone={copyPhone}
            />
          </div>
          {deliveryComposer === 'sms' && (
            <ContactDeliveryComposer
              channel="sms"
              contactId={lead.id}
              contactLabel={businessName}
              lead={lead}
              onClose={() => setDeliveryComposer(null)}
              phone={copyPhone}
            />
          )}
        </label>
        <label className="config-field span-2">
          <span>Email</span>
          <div className="phone-input-shell email-input-shell">
            <input
              inputMode="email"
              data-action-id={speakActionIds.editLead}
              spellCheck={false}
              type="email"
              value={lead.email}
              onChange={(event) =>
                updateLead(lead.id, {
                  email: event.target.value,
                })
              }
            />
            <CopyAction
              className="phone-input-action"
              disabled={!copyEmail}
              label="Copy email"
              value={copyEmail}
            />
            <EmailFieldAction
              disabled={!emailReady}
              email={copyEmail}
              onOpenEmail={() => setDeliveryComposer('email')}
            />
          </div>
          {deliveryComposer === 'email' && (
            <ContactDeliveryComposer
              channel="email"
              contactId={lead.id}
              contactLabel={businessName}
              email={copyEmail}
              lead={lead}
              onClose={() => setDeliveryComposer(null)}
            />
          )}
        </label>
        <label className="config-field">
          <span>State</span>
          <input
            value={lead.state}
            data-action-id={speakActionIds.editLead}
            onChange={(event) =>
              updateLead(lead.id, {
                state: event.target.value.toUpperCase(),
              })
            }
          />
        </label>
        <label className="config-field">
          <span>Score</span>
          <input
            type="number"
            data-action-id={speakActionIds.editLead}
            min="0"
            max="100"
            inputMode="numeric"
            value={lead.score}
            onChange={(event) =>
              updateLead(lead.id, {
                score: Number(event.target.value),
              })
            }
          />
        </label>
        <label className="config-field span-2">
          <span>Status</span>
          <select
            value={lead.status}
            data-action-id={speakActionIds.editLead}
            onChange={(event) =>
              updateLead(lead.id, {
                status: event.target.value as LeadStatus,
              })
            }
          >
            {statusOptions.map((status) => (
              <option key={status} value={status}>
                {statusLabels[status]}
              </option>
            ))}
          </select>
        </label>
        <label className="config-field span-2">
          <span>Notes</span>
          <textarea
            value={lead.notes}
            data-action-id={speakActionIds.editLead}
            onChange={(event) =>
              updateLead(lead.id, {
                notes: event.target.value,
              })
            }
          />
        </label>
      </div>

      <div className="lead-detail-facts">
        <div>
          <span>Last call</span>
          <strong>{lead.lastCall}</strong>
        </div>
        <div>
          <span>Call time</span>
          <strong>{calltime}</strong>
        </div>
        <div>
          <span>Agent</span>
          <strong title={agentName}>{agentName}</strong>
        </div>
      </div>
    </section>
  )
}
