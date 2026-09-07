import {
  Check,
  Trash2,
} from './SpeakIcons'
import type { ChangeEvent } from 'react'
import { statusLabels } from './leads'
import type { LeadStatus } from './types'
import { speakActionIds } from './uiContract'

interface LeadBulkActionBarProps {
  allVisibleSelected: boolean
  bulkDelete: () => void
  bulkStatus: (status: LeadStatus) => void
  bulkStatusOptions?: LeadStatus[]
  clearSelectedLeads: () => void
  itemLabel?: string
  showSelectControl?: boolean
  someVisibleSelected: boolean
  selectedCount: number
  showIdleCount?: boolean
  toggleAllVisible: () => void
  totalVisibleCount: number
}

const defaultBulkStatusOptions: LeadStatus[] = [
  'ready',
  'follow-up',
  'do-not-call',
]

export function LeadBulkActionBar({
  allVisibleSelected,
  bulkDelete,
  bulkStatus,
  bulkStatusOptions = defaultBulkStatusOptions,
  clearSelectedLeads,
  itemLabel = 'contacts',
  showSelectControl = true,
  someVisibleSelected,
  selectedCount,
  showIdleCount = true,
  toggleAllVisible,
  totalVisibleCount,
}: LeadBulkActionBarProps) {
  const hasSelection = selectedCount > 0
  const selectionState = allVisibleSelected
    ? 'selected'
    : someVisibleSelected
      ? 'mixed'
      : ''
  const selectActionLabel = hasSelection
    ? `Clear selected ${itemLabel}`
    : allVisibleSelected
      ? `Clear visible ${itemLabel}`
      : `Select visible ${itemLabel}`

  if (!hasSelection && (!showIdleCount || totalVisibleCount === 0)) return null

  function applyBulkStatus(event: ChangeEvent<HTMLSelectElement>) {
    const status = event.currentTarget.value as LeadStatus | ''
    if (!status) return
    bulkStatus(status)
    event.currentTarget.value = ''
  }

  return (
    <div className={['bulk-bar', hasSelection ? 'has-selection' : ''].filter(Boolean).join(' ')}>
      {showSelectControl ? (
        <button
          className={[
            'bulk-select-all',
            selectionState,
          ]
            .filter(Boolean)
            .join(' ')}
          type="button"
          data-action-id={hasSelection ? speakActionIds.clearSelection : speakActionIds.selectLead}
          disabled={totalVisibleCount === 0}
          onClick={hasSelection ? clearSelectedLeads : toggleAllVisible}
          aria-pressed={
            allVisibleSelected ? 'true' : someVisibleSelected ? 'mixed' : 'false'
          }
          aria-label={selectActionLabel}
        >
          <span
            className={[
              'selection-toggle',
              selectionState,
            ]
              .filter(Boolean)
              .join(' ')}
            data-action-id={speakActionIds.selectLead}
            aria-hidden="true"
          >
            <Check size={13} />
          </span>
          {!hasSelection && <strong>{`${totalVisibleCount} ${itemLabel}`}</strong>}
        </button>
      ) : (
        <div className="bulk-selection-summary" aria-live="polite">
          <span
            className={[
              'selection-toggle',
              selectionState || 'selected',
            ]
              .filter(Boolean)
              .join(' ')}
            aria-hidden="true"
          >
            <Check size={13} />
          </span>
          <strong>{`${selectedCount} selected`}</strong>
        </div>
      )}
      {hasSelection && (
        <div className="bulk-actions" aria-label={`Selected ${itemLabel} actions`}>
          <select
            className="bulk-status-select"
            defaultValue=""
            onChange={applyBulkStatus}
            aria-label={`Set selected ${itemLabel} status`}
          >
            <option value="" disabled>
              Status
            </option>
            {bulkStatusOptions.map((status) => (
              <option key={status} value={status}>
                {statusLabels[status]}
              </option>
            ))}
          </select>
          <button
            className="bulk-action-button danger-button"
            type="button"
            onClick={bulkDelete}
            title={`Delete selected ${itemLabel}`}
            aria-label={`Delete selected ${itemLabel}`}
          >
            <Trash2 size={14} />
            <span>{selectedCount}</span>
          </button>
        </div>
      )}
    </div>
  )
}
