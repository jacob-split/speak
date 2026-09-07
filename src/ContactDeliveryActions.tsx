import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from 'react'
import {
  BotMessageSquare,
  Mail,
  MessageSquareText,
  PhoneCall,
  Reply,
} from './SpeakIcons'
import { apiUrl } from './api'
import {
  normalizePhoneNumber,
  phoneTelHref,
} from './phoneNumbers'
import {
  cleanEmailAddress,
  sendCommunicationMessage,
  smsHref,
  type DeliveryChannel,
  type SendCommunicationMessageResult,
} from './ContactDeliveryUtils'
import type {
  Lead,
  VoiceBackendStatus,
} from './types'
import { speakTestIds } from './uiContract'

type SmsDeliveryMode = 'agent' | 'device'

interface ContactDeliveryComposerProps {
  channel: DeliveryChannel
  contactId?: string
  contactLabel?: string
  defaultBody?: string
  defaultSubject?: string
  email?: string
  hideHeading?: boolean
  lead?: Partial<Lead>
  messageId?: string
  onClose: () => void
  onSent?: (result: SendCommunicationMessageResult) => void
  phone?: string
  threadId?: string
}

interface SmsFieldActionsProps {
  contactLabel?: string
  disabled?: boolean
  iconSize?: number
  lead?: Partial<Lead>
  onOpenAgentSms: () => void
  phone: string
}

interface EmailFieldActionsProps {
  disabled?: boolean
  email: string
  iconSize?: number
  onOpenEmail: () => void
}

interface DeviceCallFieldActionProps {
  disabled?: boolean
  iconSize?: number
  label?: string
  phone: string
}

export function DeviceCallFieldAction({
  disabled = false,
  iconSize = 14,
  label = 'Call from this device',
  phone,
}: DeviceCallFieldActionProps) {
  const href = phoneTelHref(phone)
  const unavailable = disabled || !href
  return (
    <a
      className={[
        'phone-input-action',
        'phone-dial-action',
        unavailable ? 'disabled' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      href={unavailable ? undefined : href}
      title={label}
      aria-label={label}
      aria-disabled={unavailable}
      onClick={(event) => {
        if (unavailable) event.preventDefault()
      }}
    >
      <PhoneCall size={iconSize} />
    </a>
  )
}

export function SmsFieldActions({
  disabled = false,
  iconSize = 14,
  onOpenAgentSms,
  phone,
}: SmsFieldActionsProps) {
  const normalized = normalizePhoneNumber(phone)
  const unavailable = disabled || !normalized
  return (
    <>
      <a
        className={[
          'phone-input-action',
          'sms-device-action',
          unavailable ? 'disabled' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        href={unavailable ? undefined : smsHref(normalized)}
        title="Text from this device"
        aria-label="Text from this device"
        aria-disabled={unavailable}
        onClick={(event) => {
          if (unavailable) event.preventDefault()
        }}
      >
        <MessageSquareText size={iconSize} />
      </a>
      <button
        className="phone-input-action sms-agent-action"
        type="button"
        title="Text from the agent number"
        aria-label="Text from the agent number"
        disabled={unavailable}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          onOpenAgentSms()
        }}
      >
        <BotMessageSquare size={iconSize} />
      </button>
    </>
  )
}

export function EmailFieldAction({
  disabled = false,
  email,
  iconSize = 14,
  onOpenEmail,
}: EmailFieldActionsProps) {
  const unavailable = disabled || !cleanEmailAddress(email)
  return (
    <button
      className="phone-input-action email-compose-action"
      type="button"
      title="Send email from the workspace account"
      aria-label="Send email from the workspace account"
      disabled={unavailable}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onOpenEmail()
      }}
    >
      <Mail size={iconSize} />
    </button>
  )
}

export function ContactDeliveryComposer({
  channel,
  contactId,
  contactLabel,
  defaultBody = '',
  defaultSubject = '',
  email = '',
  hideHeading = false,
  lead,
  messageId,
  onClose,
  onSent,
  phone = '',
  threadId,
}: ContactDeliveryComposerProps) {
  const [subject, setSubject] = useState(defaultSubject)
  const [body, setBody] = useState(defaultBody)
  const [sending, setSending] = useState(false)
  const [notice, setNotice] = useState('')
  const deliveryReadiness = useDeliveryReadiness()
  const targetLabel = contactLabel || lead?.company || lead?.name || 'contact'
  const title = channel === 'sms'
    ? `Text ${targetLabel} from the agent number`
    : `Email ${targetLabel} from the workspace account`
  const deliveryReady = channel === 'sms'
    ? deliveryReadiness.smsConfigured
    : deliveryReadiness.emailConfigured && deliveryReadiness.emailSendAsConfigured !== false
  const deliveryUnavailable = deliveryUnavailableMessage(channel, deliveryReadiness)
  const canSendContent = channel === 'sms'
    ? Boolean(normalizePhoneNumber(phone) && body.trim())
    : Boolean(cleanEmailAddress(email) && subject.trim() && body.trim())
  const canSend = canSendContent && deliveryReady && !deliveryReadiness.loading

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!canSend || sending) {
      if (deliveryUnavailable) setNotice(deliveryUnavailable)
      return
    }
    setSending(true)
    setNotice('')
    try {
      const result = await sendCommunicationMessage({
        body,
        channel,
        contactId,
        email,
        lead,
        messageId,
        phone,
        subject,
        threadId,
      })
      onSent?.(result)
      setNotice(
        channel === 'sms' && result.provider_accepted === true && result.sent === false
          ? 'Text accepted; delivery pending.'
          : channel === 'sms'
            ? 'Text delivered.'
            : 'Email sent.',
      )
      setBody('')
      if (channel === 'email') setSubject('')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Message send failed')
    } finally {
      setSending(false)
    }
  }

  return (
    <form
      className="contact-delivery-composer"
      data-channel={channel}
      data-testid={speakTestIds.contactDeliveryComposer}
      onSubmit={(event) => void submit(event)}
    >
      {!hideHeading && (
        <div className="contact-delivery-composer-heading">
          <strong>{title}</strong>
          <button
            type="button"
            data-testid={speakTestIds.contactDeliveryCancel}
            onClick={onClose}
          >
            Close
          </button>
        </div>
      )}
      {channel === 'email' && (
        <input
          aria-label="Email subject"
          autoComplete="off"
          placeholder="Subject"
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
        />
      )}
      <textarea
        aria-label={channel === 'sms' ? 'Text message' : 'Email body'}
        placeholder={channel === 'sms' ? 'Message' : 'Body'}
        rows={channel === 'sms' ? 3 : 5}
        value={body}
        onChange={(event) => setBody(event.target.value)}
      />
      <div className="contact-delivery-composer-actions">
        <button
          className="secondary-button"
          type="button"
          data-testid={speakTestIds.contactDeliveryCancel}
          onClick={onClose}
        >
          Cancel
        </button>
        <button
          className="primary-button"
          type="submit"
          data-testid={speakTestIds.contactDeliverySend}
          disabled={!canSend || sending}
        >
          {sending ? 'Sending...' : channel === 'sms' ? 'Send text' : 'Send email'}
        </button>
      </div>
      {!notice && deliveryUnavailable && <p>{deliveryUnavailable}</p>}
      {notice && <p>{notice}</p>}
    </form>
  )
}

interface DeliveryReadinessState {
  emailConfigured: boolean
  emailSendAsConfigured?: boolean
  error: string
  loading: boolean
  smsConfigured: boolean
}

function useDeliveryReadiness() {
  const [state, setState] = useState<DeliveryReadinessState>({
    emailConfigured: false,
    error: '',
    loading: true,
    smsConfigured: false,
  })

  useEffect(() => {
    let mounted = true

    async function loadDeliveryReadiness() {
      try {
        const response = await fetch(apiUrl('/health'))
        if (!response.ok) throw new Error(`Health returned ${response.status}`)
        const payload = (await response.json()) as VoiceBackendStatus
        if (!mounted) return
        setState({
          emailConfigured: Boolean(payload.delivery?.emailConfigured),
          emailSendAsConfigured: payload.delivery?.emailSendAsConfigured,
          error: '',
          loading: false,
          smsConfigured: Boolean(payload.delivery?.smsConfigured),
        })
      } catch (error) {
        if (!mounted) return
        setState({
          emailConfigured: false,
          error: error instanceof Error ? error.message : 'Delivery status unavailable',
          loading: false,
          smsConfigured: false,
        })
      }
    }

    void loadDeliveryReadiness()

    return () => {
      mounted = false
    }
  }, [])

  return state
}

function deliveryUnavailableMessage(
  channel: DeliveryChannel,
  readiness: DeliveryReadinessState,
) {
  if (readiness.loading) return 'Checking delivery readiness.'
  if (readiness.error) return 'Delivery status unavailable.'
  if (channel === 'sms' && !readiness.smsConfigured) {
    return 'Agent SMS is not ready.'
  }
  if (channel === 'email') {
    if (readiness.emailSendAsConfigured === false) {
      return 'Workspace email send-as is not ready.'
    }
    if (!readiness.emailConfigured) return 'Workspace email is not ready.'
  }
  return ''
}

interface CommunicationReplyComposerProps extends ContactDeliveryComposerProps {
  smsMode?: SmsDeliveryMode
}

export function CommunicationReplyComposer({
  channel,
  phone = '',
  smsMode = 'agent',
  ...props
}: CommunicationReplyComposerProps) {
  const [mode, setMode] = useState<SmsDeliveryMode>(smsMode)
  const [deviceBody, setDeviceBody] = useState(props.defaultBody || '')
  const deviceHref = useMemo(() => smsHref(phone, deviceBody), [deviceBody, phone])

  if (channel !== 'sms') {
    return <ContactDeliveryComposer channel={channel} phone={phone} {...props} />
  }

  return (
    <div
      className="contact-delivery-composer communication-reply-composer"
      data-channel="sms"
      data-testid={speakTestIds.communicationReplyComposer}
    >
      <div className="contact-delivery-composer-heading">
        <strong>Reply by SMS</strong>
        <button
          type="button"
          data-testid={speakTestIds.contactDeliveryCancel}
          onClick={props.onClose}
        >
          Close
        </button>
      </div>
      <div className="sms-reply-mode" role="group" aria-label="SMS reply source">
        <button
          className={mode === 'agent' ? 'active' : ''}
          type="button"
          data-testid={speakTestIds.smsReplyAgentMode}
          aria-pressed={mode === 'agent'}
          onClick={() => setMode('agent')}
        >
          Agent number
        </button>
        <button
          className={mode === 'device' ? 'active' : ''}
          type="button"
          data-testid={speakTestIds.smsReplyDeviceMode}
          aria-pressed={mode === 'device'}
          onClick={() => setMode('device')}
        >
          Current device
        </button>
      </div>
      {mode === 'agent' ? (
        <ContactDeliveryComposer channel="sms" hideHeading phone={phone} {...props} />
      ) : (
        <>
          <textarea
            aria-label="Device SMS body"
            placeholder="Message"
            rows={3}
            value={deviceBody}
            onChange={(event) => setDeviceBody(event.target.value)}
          />
          <div className="contact-delivery-composer-actions">
            <button
              className="secondary-button"
              type="button"
              data-testid={speakTestIds.contactDeliveryCancel}
              onClick={props.onClose}
            >
              Cancel
            </button>
            <a
              className={[
                'primary-button',
                deviceHref && deviceBody.trim() ? '' : 'disabled',
              ]
                .filter(Boolean)
                .join(' ')}
              href={deviceHref && deviceBody.trim() ? deviceHref : undefined}
              data-testid={speakTestIds.contactDeliverySend}
              aria-disabled={!deviceHref || !deviceBody.trim()}
              onClick={(event) => {
                if (!deviceHref || !deviceBody.trim()) event.preventDefault()
              }}
            >
              Open SMS
            </a>
          </div>
        </>
      )}
    </div>
  )
}

export function ReplyActionButton({
  disabled = false,
  label = 'Reply',
  onClick,
}: {
  disabled?: boolean
  label?: string
  onClick: () => void
}) {
  return (
    <button
      className="chat-message-action reply-action"
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Reply size={14} />
      <span>Reply</span>
    </button>
  )
}
