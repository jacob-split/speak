import { PhoneCall } from './SpeakIcons'
import { phoneTelHref } from './phoneNumbers'
import type { Lead } from './types'
import { speakActionIds } from './uiContract'

function devicePhoneHref(phone: string) {
  return phoneTelHref(phone)
}

interface DeviceCallButtonProps {
  className?: string
  disabled?: boolean
  lead: Lead | null
}

export function DeviceCallButton({
  className = '',
  disabled = false,
  lead,
}: DeviceCallButtonProps) {
  const href = lead ? devicePhoneHref(lead.phone || '') : ''
  const label = lead
    ? `Call ${lead.company || lead.name} from this device`
    : 'Choose a contact before calling from this device'
  const unavailable = disabled || !href

  return (
    <a
      className={[
        'device-call-button',
        unavailable ? 'disabled' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      data-action-id={speakActionIds.callLeadFromDevice}
      href={unavailable ? undefined : href}
      title={label}
      aria-label={label}
      aria-disabled={unavailable}
      onClick={(event) => {
        if (unavailable) event.preventDefault()
      }}
    >
      <PhoneCall size={18} />
      <span>Device</span>
    </a>
  )
}
