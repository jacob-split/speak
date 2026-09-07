import { apiUrl } from './api'
import { normalizePhoneNumber } from './phoneNumbers'
import type { Lead } from './types'

export type DeliveryChannel = 'sms' | 'email'

export interface SendCommunicationMessageInput {
  body: string
  channel: DeliveryChannel
  contactId?: string
  email?: string
  lead?: Partial<Lead>
  messageId?: string
  phone?: string
  subject?: string
  threadId?: string
}

export interface SendCommunicationMessageResult {
  accepted?: boolean
  channel?: DeliveryChannel
  delivery_finalized?: boolean
  error?: string
  message?: string | {
    messageId?: string
    threadId?: string
  }
  ok?: boolean
  pending?: boolean
  proof?: Record<string, unknown>
  provider_accepted?: boolean
  sent?: boolean
  status?: string
}

export function smsHref(phone: string, body = '') {
  const normalized = normalizePhoneNumber(phone)
  if (!normalized) return ''
  const separator = /iPhone|iPad|Mac/i.test(navigator.userAgent || '') ? '&' : '?'
  return body.trim()
    ? `sms:${encodeURIComponent(normalized)}${separator}body=${encodeURIComponent(body.trim())}`
    : `sms:${encodeURIComponent(normalized)}`
}

export function mailtoHref(email: string, subject = '', body = '') {
  const target = cleanEmailAddress(email)
  if (!target) return ''
  const params = new URLSearchParams()
  if (subject.trim()) params.set('subject', subject.trim())
  if (body.trim()) params.set('body', body.trim())
  const query = params.toString()
  return `mailto:${encodeURIComponent(target)}${query ? `?${query}` : ''}`
}

export function cleanEmailAddress(value: string) {
  const email = String(value || '').trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : ''
}

export function replySubject(value: string) {
  const subject = String(value || '').trim()
  if (!subject) return ''
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`
}

export async function sendCommunicationMessage(input: SendCommunicationMessageInput) {
  const response = await fetch(apiUrl('/communication-messages/send'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  })
  const payload = (await response.json().catch(() => ({}))) as SendCommunicationMessageResult
  if (
    !response.ok ||
    payload.ok === false ||
    (payload.sent === false && payload.provider_accepted !== true)
  ) {
    throw new Error(
      typeof payload.message === 'string'
        ? payload.message
        : payload.error || 'Message send failed',
    )
  }
  return payload
}
