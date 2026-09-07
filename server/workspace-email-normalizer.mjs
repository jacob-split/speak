import {
  cleanEmail,
  cleanObject,
  getWorkspaceEmailAccount,
  safeLeadText,
} from './runtime-config.mjs'
import { maskEmail } from './call-state.mjs'

export function buildWorkspaceEmailCommunicationEvent(payload = {}, {
  allowAutomation = false,
  source = 'workspace_email_webhook',
} = {}) {
  const fromEmails = workspaceEmailList(
    payload.from_emails ||
      payload.fromEmails ||
      payload.fromEmail ||
      payload.from_email ||
      payload.from ||
      payload.sender ||
      payload.headers?.from,
  )
  const toEmails = workspaceEmailList(
    payload.to_emails ||
      payload.toEmails ||
      payload.toEmail ||
      payload.to_email ||
      payload.to ||
      payload.recipient ||
      payload.headers?.to,
  )
  const ccEmails = workspaceEmailList(
    payload.cc_emails || payload.ccEmails || payload.cc || payload.headers?.cc,
  )
  const bccEmails = workspaceEmailList(
    payload.bcc_emails || payload.bccEmails || payload.bcc || payload.headers?.bcc,
  )
  const fromEmail = fromEmails[0] || ''
  const outboundRecipients = [...toEmails, ...ccEmails, ...bccEmails]
  const primaryToEmail = firstNonWorkspaceEmail(outboundRecipients) || toEmails[0] || ''
  const subject = safeLeadText(payload.subject)
  const body = safeLeadText(payload.body || payload.text || payload.snippet || subject)
  const messageId = safeLeadText(payload.message_id || payload.messageId || payload.id)
  const threadId = safeLeadText(payload.thread_id || payload.threadId)
  const eventAt = safeLeadText(payload.at || payload.date || payload.received_at)
  const direction = workspaceEmailDirection(payload, fromEmail, primaryToEmail)
  const contactEmail =
    direction === 'outbound'
      ? firstNonWorkspaceEmail(outboundRecipients) || primaryToEmail
      : fromEmail
  const externalThreadId = threadId || messageId

  if (!body) {
    const error = new Error('Workspace email events require body text or a subject.')
    error.statusCode = 400
    throw error
  }
  if (!contactEmail && !externalThreadId) {
    const error = new Error(
      'Workspace email events require a contact email or provider thread/message identity.',
    )
    error.statusCode = 400
    throw error
  }

  const inboundSyncNoAutomation =
    direction === 'inbound' && !allowAutomation
      ? {
          emailAutoReply: 'none',
          reason: 'workspace_email_sync_record_only',
          source,
        }
      : undefined

  return {
    communicationEvent: {
      channel: 'email',
      createdAt: eventAt,
      event: {
        communication: {
          channel: 'email',
          modality: 'text',
          direction,
          role: direction === 'outbound' ? 'agent' : 'contact',
          body: subject ? `Subject: ${subject}\n\n${body}` : body,
          provider: 'google_workspace',
          at: eventAt,
          sourceEventId: messageId || threadId,
          identity: {
            email: contactEmail || undefined,
            externalThreadId,
          },
          providerIds: cleanObject({
            messageId,
            emailThreadId: threadId,
            fromEmail,
            fromEmails: nonEmptyArray(fromEmails),
            toEmail: primaryToEmail,
            toEmails: nonEmptyArray(toEmails),
            ccEmails: nonEmptyArray(ccEmails),
            bccEmails: nonEmptyArray(bccEmails),
            source,
          }),
          providerLinks: [
            messageId ? { provider: 'google_workspace', kind: 'message', id: messageId } : null,
            threadId ? { provider: 'google_workspace', kind: 'external_thread', id: threadId } : null,
          ].filter(Boolean),
          proof: cleanObject({
            provider: 'google_workspace',
            message_id: messageId,
            thread_id: threadId,
            from: maskEmail(fromEmail),
            from_all: maskedEmailList(fromEmails),
            to: maskEmail(primaryToEmail),
            to_all: maskedEmailList(toEmails),
            cc_all: maskedEmailList(ccEmails),
            bcc_all: maskedEmailList(bccEmails),
            direction,
            source,
            automation:
              inboundSyncNoAutomation ||
              (direction === 'inbound'
                ? undefined
                : {
                    emailAutoReply: 'none',
                    reason: 'sent_source_record_only',
                  }),
          }),
        },
      },
    },
    contactEmail,
    direction,
    inboundSyncNoAutomation,
    messageId,
    subject,
    threadId,
  }
}

export function workspaceEmailDirection(payload = {}, fromEmail = '', toEmail = '') {
  const directionText = safeLeadText(
    payload.direction ||
      payload.message_direction ||
      payload.mailbox ||
      payload.folder ||
      payload.label ||
      (Array.isArray(payload.labels) ? payload.labels.join(' ') : ''),
  ).toLowerCase()
  if (/sent|outbound|outgoing/.test(directionText)) return 'outbound'
  if (/inbox|inbound|incoming|received/.test(directionText)) return 'inbound'

  const workspaceEmail = cleanEmail(getWorkspaceEmailAccount())
  if (workspaceEmail && fromEmail === workspaceEmail && toEmail && toEmail !== workspaceEmail) {
    return 'outbound'
  }
  return 'inbound'
}

export function workspaceEmailList(...values) {
  const emails = []
  const seen = new Set()
  values.forEach((value) => {
    extractWorkspaceEmails(value).forEach((email) => {
      if (!email || seen.has(email)) return
      seen.add(email)
      emails.push(email)
    })
  })
  return emails
}

function extractWorkspaceEmails(value) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => extractWorkspaceEmails(item))
  }
  if (value && typeof value === 'object') {
    return extractWorkspaceEmails(
      value.email ||
        value.address ||
        value.value ||
        value.name,
    )
  }
  return Array.from(
    String(value || '').matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi),
  )
    .map((match) => cleanEmail(match[0]))
    .filter(Boolean)
}

function firstNonWorkspaceEmail(emails = []) {
  const workspaceEmail = cleanEmail(getWorkspaceEmailAccount())
  return emails.find((email) => email && email !== workspaceEmail) || ''
}

function maskedEmailList(values = []) {
  const masked = values.map((email) => maskEmail(email)).filter(Boolean)
  return masked.length > 0 ? masked : undefined
}

function nonEmptyArray(values = []) {
  return values.length > 0 ? values : undefined
}
