import { AppPrimaryNavigation } from './AppTopbarControls'
import { speakTestIds } from './uiContract'
import type { ReactNode } from 'react'

interface DialerTopbarProps {
  basePath: string
  leadControls?: ReactNode
}

export function DialerTopbar({
  basePath,
  leadControls,
}: DialerTopbarProps) {
  return (
    <header className="topbar dialer-topbar" data-testid={speakTestIds.dialerTopbar}>
      <AppPrimaryNavigation
        active="dialer"
        basePath={basePath}
      />
      {leadControls && (
        <div className="topbar-middle topbar-lead-controls">{leadControls}</div>
      )}
    </header>
  )
}
