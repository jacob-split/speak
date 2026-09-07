import {
  AppearanceSwitch,
  GlobalSearchTrigger,
} from './AppTopbarControls'
import { speakTestIds } from './uiContract'
import type { ReactNode } from 'react'
import type { Appearance } from './useAppearance'

export type ControlBusy =
  | 'idle'
  | 'start'
  | 'next'
  | 'end'
  | 'takeover'
  | 'release'

export interface LeadQueueToolbarProps {
  appearance: Appearance
  callControl?: ReactNode
  onOpenGlobalSearch: () => void
  runControls?: ReactNode
  selectionControls?: ReactNode
  setAppearance: (appearance: Appearance) => void
}

export function LeadQueueToolbar({
  appearance,
  callControl,
  onOpenGlobalSearch,
  runControls,
  selectionControls,
  setAppearance,
}: LeadQueueToolbarProps) {
  return (
    <div
      className={[
        'lead-toolbar',
        'lead-toolbar-minimal',
        selectionControls ? 'has-selection-actions' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      data-testid={speakTestIds.leadToolbar}
    >
      <GlobalSearchTrigger onClick={onOpenGlobalSearch} />
      <AppearanceSwitch appearance={appearance} setAppearance={setAppearance} />
      {selectionControls}
      {!selectionControls && runControls}
      {callControl && (
        <div className="dialer-mobile-call-slot">
          {callControl}
        </div>
      )}
    </div>
  )
}
