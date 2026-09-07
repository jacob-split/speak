import {
  useMemo,
  useState,
} from 'react'
import { ChatMessageBody } from './ChatMessageBody'
import { formatCallDate } from './calls'
import {
  CommunicationReplyComposer,
  ReplyActionButton,
} from './ContactDeliveryActions'
import {
  cleanEmailAddress,
  replySubject,
  type SendCommunicationMessageResult,
} from './ContactDeliveryUtils'
import { TranscriptEmotionScores } from './TranscriptEmotionScores'
import {
  communicationMessageLabel,
  communicationMessageSpeakerClass,
  mergeCommunicationMessages,
  useCommunicationThreadMessages,
  type CommunicationMessage,
} from './communicationThreadMessageUtils'

interface CommunicationThreadMessagesProps {
  className?: string
  emptyText?: string
  enabled?: boolean
  fallbackMessages?: CommunicationMessage[]
  initialMessages?: CommunicationMessage[]
  labels?: {
    agent?: string
    contact?: string
  }
  loading?: boolean
  loadingText?: string
  onMessageSent?: (context: {
    message: CommunicationMessage
    result: SendCommunicationMessageResult
  }) => void
  order?: 'asc' | 'desc'
  threadId: string
}

export function CommunicationThreadMessages({
  className = 'communication-thread-message-list',
  emptyText = 'No source messages are stored for this thread yet.',
  enabled = true,
  fallbackMessages = [],
  initialMessages,
  labels,
  loading: loadingOverride,
  loadingText = 'Loading source history...',
  onMessageSent,
  order = 'desc',
  threadId,
}: CommunicationThreadMessagesProps) {
  const [reloadKey, setReloadKey] = useState(0)
  const { error, loading, messages } = useCommunicationThreadMessages(threadId, {
    enabled,
    initialMessages,
    reloadKey,
  })
  const mergedMessages = useMemo(
    () =>
      fallbackMessages.length > 0
        ? mergeCommunicationMessages(fallbackMessages, messages)
        : messages,
    [fallbackMessages, messages],
  )
  const orderedMessages = useMemo(
    () =>
      [...mergedMessages].sort((left, right) => {
        const byTime = (left.at || '').localeCompare(right.at || '')
        const byId = left.messageId.localeCompare(right.messageId)
        const result = byTime || byId
        return order === 'asc' ? result : result * -1
      }),
    [mergedMessages, order],
  )

  return (
    <div className={className} data-thread-id={threadId}>
      {loadingOverride || loading ? (
        <div className="empty-transcript">{loadingText}</div>
      ) : error ? (
        <div className="empty-transcript">{error}</div>
      ) : orderedMessages.length === 0 ? (
        <div className="empty-transcript">{emptyText}</div>
      ) : (
        orderedMessages.map((message) => (
          <CommunicationThreadMessageItem
            key={message.messageId}
            labels={labels}
            message={message}
            onMessageSent={(context) => {
              setReloadKey((current) => current + 1)
              onMessageSent?.(context)
            }}
          />
        ))
      )}
    </div>
  )
}

function CommunicationThreadMessageItem({
  labels,
  message,
  onMessageSent,
}: {
  labels?: {
    agent?: string
    contact?: string
  }
  message: CommunicationMessage
  onMessageSent?: (context: {
    message: CommunicationMessage
    result: SendCommunicationMessageResult
  }) => void
}) {
  const [replyOpen, setReplyOpen] = useState(false)
  const timestamp = message.at ? formatCallDate(message.at) : ''
  const body = message.body || 'No message body captured.'
  const isSms = message.channel === 'sms'
  const isEmail = message.channel === 'email'
  const smsReceived = isSms && (
    message.direction === 'inbound' ||
    message.role === 'contact' ||
    message.role === 'user'
  )
  const smsSent = isSms && !smsReceived && (
    message.direction === 'outbound' ||
    message.role === 'agent' ||
    message.role === 'operator'
  )
  const received = communicationMessageReceived(message)
  const replyTarget = communicationMessageReplyTarget(message)
  const canReply = received && (isSms || isEmail)
  const parsedEmail = isEmail ? parseEmailMessageBody(body) : null
  const bodyContent = parsedEmail ? (
    <>
      <p className="communication-email-subject">
        <span>Subject</span>
        <strong>{parsedEmail.subject}</strong>
      </p>
      {parsedEmail.body && (
        <p className="communication-email-body">{parsedEmail.body}</p>
      )}
    </>
  ) : (
    <p>{body}</p>
  )
  const collapsedBody = parsedEmail ? (
    <p className="communication-email-subject">
      <span>Subject</span>
      <strong>{parsedEmail.subject}</strong>
    </p>
  ) : undefined
  const label = communicationMessageDisplayLabel(message, labels)
  return (
    <article
      className={[
        'transcript-entry',
        'communication-message-entry',
        communicationMessageSpeakerClass(message),
        isSms ? 'channel-sms' : '',
        isEmail ? 'channel-email' : '',
        smsReceived ? 'sms-received' : '',
        smsSent ? 'sms-sent' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      data-channel={message.channel || ''}
      data-direction={message.direction || ''}
      data-message-id={message.messageId}
      data-role={message.role || ''}
      key={message.messageId}
    >
      <div className="transcript-entry-heading">
        <strong>
          {label}
        </strong>
        <time>{timestamp}</time>
      </div>
      <ChatMessageBody
        collapseLabels={
          parsedEmail
            ? { collapsed: 'Read email', expanded: 'Hide email' }
            : undefined
        }
        collapsedChildren={collapsedBody}
        extraActions={
          canReply ? (
            <ReplyActionButton
              disabled={
                isSms
                  ? !replyTarget.phone
                  : !replyTarget.email
              }
              label={`Reply by ${isSms ? 'SMS' : 'email'}`}
              onClick={() => setReplyOpen((current) => !current)}
            />
          ) : null
        }
        forceCollapsible={Boolean(parsedEmail?.body)}
        text={body}
      >
        {bodyContent}
      </ChatMessageBody>
      {replyOpen && canReply && (
        <CommunicationReplyComposer
          channel={isSms ? 'sms' : 'email'}
          contactId={message.contactId}
          contactLabel={label}
          defaultSubject={parsedEmail ? replySubject(parsedEmail.subject) : ''}
          email={replyTarget.email}
          messageId={message.messageId}
          onClose={() => setReplyOpen(false)}
          onSent={(result) => {
            setReplyOpen(false)
            onMessageSent?.({
              message,
              result,
            })
          }}
          phone={replyTarget.phone}
          threadId={message.threadId}
        />
      )}
      <TranscriptEmotionScores scores={message.emotionScores} />
    </article>
  )
}

function communicationMessageDisplayLabel(
  message: CommunicationMessage,
  labels?: {
    agent?: string
    contact?: string
  },
) {
  if (message.role === 'contact' || message.direction === 'inbound') {
    return labels?.contact || communicationMessageLabel(message)
  }
  if (message.role === 'agent' || message.direction === 'outbound') {
    return labels?.agent || communicationMessageLabel(message)
  }
  return communicationMessageLabel(message)
}

function communicationMessageReceived(message: CommunicationMessage) {
  return (
    message.direction === 'inbound' ||
    message.role === 'contact' ||
    message.role === 'user'
  )
}

function communicationMessageReplyTarget(message: CommunicationMessage) {
  const providerIds = message.providerIds || {}
  const proof = message.proof || {}
  const inbound = communicationMessageReceived(message)
  const phone = String(
    inbound
      ? firstString(
          providerIds.fromPhones,
          providerIds.fromPhone,
          providerIds.from_phone,
          providerIds.from,
        )
      : firstString(
          providerIds.toPhones,
          providerIds.toPhone,
          providerIds.to_phone,
          providerIds.to,
        ),
  )
  const email = cleanEmailAddress(
    inbound
      ? firstString(
          providerIds.fromEmails,
          providerIds.fromEmail,
          providerIds.from_email,
          providerIds.from,
          proof.fromEmail,
          proof.from_email,
        )
      : firstString(
          providerIds.toEmails,
          providerIds.toEmail,
          providerIds.to_email,
          providerIds.to,
          proof.toEmail,
          proof.to_email,
        ),
  )
  return {
    email,
    phone,
  }
}

function parseEmailMessageBody(value: string) {
  const text = String(value || '').trim()
  if (!text) return null
  const subjectMatch = text.match(/^Subject:\s*([^\n\r]*)(?:\r?\n(?:\r?\n)?([\s\S]*))?$/i)
  if (subjectMatch) {
    return {
      subject: subjectMatch[1]?.trim() || 'No subject',
      body: subjectMatch[2]?.trim() || '',
    }
  }
  const lines = text.split(/\r?\n/)
  const subject = lines.shift()?.trim() || 'No subject'
  return {
    subject,
    body: lines.join('\n').trim(),
  }
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (Array.isArray(value)) {
      const nested = firstString(...value)
      if (nested) return nested
      continue
    }
    const text = String(value || '').trim()
    if (text) return text
  }
  return ''
}
