import {
  cleanObject,
  normalizePhone,
  safeLeadText,
} from './runtime-config.mjs'
import { maskPhone } from './call-state.mjs'
import { normalizeTelnyxSmsFinalization } from './telnyx-sms-finalization.mjs'

export function telnyxPayloadPhone(value) {
  if (!value) return ''
  if (Array.isArray(value)) {
    for (const item of value) {
      const phone = telnyxPayloadPhone(item)
      if (phone) return phone
    }
    return ''
  }
  if (typeof value === 'object') {
    return normalizePhone(
      value.phone_number ||
        value.phoneNumber ||
        value.number ||
        value.value ||
        value.e164 ||
        '',
    )
  }
  return normalizePhone(value)
}

export function telnyxPayloadTimestamp(payload = {}, occurredAt = '') {
  return (
    safeLeadText(
      payload.occurred_at ||
        payload.received_at ||
        payload.completed_at ||
        payload.sent_at ||
        payload.start_time ||
        payload.end_time ||
        occurredAt ||
        payload.created_at ||
        payload.updated_at ||
        '',
    ) || new Date().toISOString()
  )
}

export function isTelnyxInboundCallEvent(eventType, payload = {}) {
  const type = safeLeadText(eventType).toLowerCase()
  if (!type.startsWith('call.')) return false
  return isInboundDirection(payload)
}

export function isTelnyxSmsCommunicationEvent(eventType, payload = {}) {
  const type = safeLeadText(eventType).toLowerCase()
  if (!type.startsWith('message.')) return false
  if (safeLeadText(payload.text || payload.body || payload.message?.text)) return true
  return Boolean(payload.id || payload.message_id || payload.record_type)
}

export function telnyxMessageDirection(payload = {}) {
  const direction = safeLeadText(
    payload.direction ||
      payload.message_direction ||
      payload.direction_type ||
      payload.record_type,
  ).toLowerCase()
  if (['outbound', 'outgoing', 'sent'].includes(direction)) return 'outbound'
  if (['inbound', 'incoming', 'received'].includes(direction)) return 'inbound'
  return isInboundDirection(payload) ? 'inbound' : 'outbound'
}

export function buildTelnyxSmsCommunicationEvent({
  eventType,
  payload = {},
  occurredAt = '',
  webhookEventId = '',
} = {}) {
  if (!isTelnyxSmsCommunicationEvent(eventType, payload)) return null

  const direction = telnyxMessageDirection(payload)
  const fromPhone = telnyxPayloadPhone(payload.from) ||
    telnyxPayloadPhone(payload.from_number || payload.from_phone_number)
  const toPhone = telnyxPayloadPhone(payload.to) ||
    telnyxPayloadPhone(payload.to_number || payload.to_phone_number)
  const providerMessageId = safeLeadText(payload.id || payload.message_id)
  const providerEventId = providerMessageId || webhookEventId || safeLeadText(payload.record_type)
  const eventAt = telnyxPayloadTimestamp(payload, occurredAt)
  const contactPhone = direction === 'outbound' ? toPhone : fromPhone
  const textBody = safeLeadText(payload.text || payload.body || payload.message?.text)
  const body = textBody || telnyxSmsStatusBody({ direction, eventType, payload, contactPhone })

  return {
    communicationEvent: {
      channel: 'sms',
      createdAt: eventAt,
      event: {
        communication: {
          channel: 'sms',
          modality: textBody ? 'text' : 'status',
          direction,
          role: direction === 'outbound' ? 'agent' : 'contact',
          body,
          provider: 'telnyx',
          at: eventAt,
          sourceEventId: providerEventId,
          identity: {
            phone: contactPhone,
          },
          providerIds: cleanObject({
            messageId: providerMessageId,
            messagingProfileId: payload.messaging_profile_id,
            fromPhone,
            toPhone,
          }),
          providerLinks: providerMessageId
            ? [{ provider: 'telnyx', kind: 'message', id: providerMessageId }]
            : [],
          proof: telnyxCommunicationProof(eventType, payload, {
            fromPhone: maskPhone(fromPhone),
            toPhone: maskPhone(toPhone),
            direction,
            webhook_event_id: webhookEventId,
            occurred_at: eventAt,
            automation:
              direction === 'inbound'
                ? undefined
                : {
                    smsAutoResponse: 'none',
                    reason: 'outbox_source_record_only',
                  },
          }),
        },
      },
    },
    contactPhone,
    direction,
    eventAt,
    hasText: Boolean(textBody),
    providerMessageId,
  }
}

export function isTelnyxMissedInboundCallEvent(eventType, payload = {}) {
  const type = safeLeadText(eventType).toLowerCase()
  const status = safeLeadText(payload.status || payload.call_leg_status || payload.state).toLowerCase()
  const hangupCause = safeLeadText(payload.hangup_cause || payload.cause || payload.reason).toLowerCase()
  return (
    type === 'call.hangup' ||
    type === 'call.ended' ||
    type === 'call.completed' ||
    ['hangup', 'ended', 'completed', 'missed', 'no_answer'].includes(status) ||
    /no[_ ]?answer|missed|unanswered/.test(hangupCause)
  )
}

export function buildTelnyxInboundCallCommunicationEvent({
  eventType,
  payload = {},
  occurredAt = '',
  webhookEventId = '',
} = {}) {
  if (!isTelnyxInboundCallEvent(eventType, payload)) return null

  const fromPhone = telnyxPayloadPhone(
    payload.from || payload.from_number || payload.caller_id_number || payload.cli,
  )
  const toPhone = telnyxPayloadPhone(payload.to || payload.to_number || payload.called_number)
  const providerCallId = safeLeadText(payload.call_control_id)
  const callSessionId = safeLeadText(payload.call_session_id)
  const status = safeLeadText(eventType || payload.call_leg_status || payload.state)
  const missed = isTelnyxMissedInboundCallEvent(eventType, payload)
  const eventAt = telnyxPayloadTimestamp(payload, occurredAt)
  const body = [
    missed ? 'Missed inbound call' : 'Inbound call received',
    fromPhone ? `from ${maskPhone(fromPhone)}` : '',
    status ? `(${status})` : '',
  ]
    .filter(Boolean)
    .join(' ')
  const sourceEventId = safeLeadText(payload.id || webhookEventId || `${providerCallId}:${eventType}`)

  return {
    communicationEvent: {
      callControlId: providerCallId,
      channel: 'call',
      createdAt: eventAt,
      event: {
        communication: {
          channel: 'call',
          modality: 'voice',
          direction: 'inbound',
          role: 'contact',
          body,
          provider: 'telnyx',
          at: eventAt,
          sourceEventId,
          identity: {
            phone: fromPhone,
          },
          providerIds: cleanObject({
            callControlId: providerCallId,
            callSessionId,
            fromPhone,
            toPhone,
          }),
          providerLinks: [
            providerCallId ? { provider: 'telnyx', kind: 'call_control', id: providerCallId } : null,
            callSessionId ? { provider: 'telnyx', kind: 'call_session', id: callSessionId } : null,
          ].filter(Boolean),
          proof: telnyxCommunicationProof(eventType, payload, {
            fromPhone: maskPhone(fromPhone),
            toPhone: maskPhone(toPhone),
            action: missed ? 'missed_call' : 'inbound_call_received',
            webhook_event_id: webhookEventId,
            occurred_at: eventAt,
          }),
        },
      },
    },
    eventAt,
    fromPhone,
    missed,
    providerCallId,
    toPhone,
  }
}

export function telnyxCommunicationProof(eventType, payload = {}, extra = {}) {
  const smsFinalization = safeLeadText(eventType).toLowerCase().startsWith('message.')
    ? normalizeTelnyxSmsFinalization(payload, {
        eventType,
        source: 'webhook',
      })
    : null
  return cleanObject({
    provider: 'telnyx',
    event_type: safeLeadText(eventType),
    record_type: safeLeadText(payload.record_type),
    status:
      smsFinalization?.provider_status !== 'unknown'
        ? smsFinalization?.provider_status
        : safeLeadText(payload.status || payload.call_leg_status || payload.state),
    delivery_finalized: smsFinalization?.delivery_finalized,
    error_code: smsFinalization?.error_code,
    errors: smsFinalization?.errors?.length ? smsFinalization.errors : undefined,
    id: safeLeadText(payload.id || payload.message_id || payload.call_control_id),
    call_session_id: safeLeadText(payload.call_session_id),
    ...extra,
  })
}

function telnyxSmsStatusBody({ direction, eventType, payload = {}, contactPhone = '' } = {}) {
  const finalization = normalizeTelnyxSmsFinalization(payload, {
    eventType,
    source: 'webhook',
  })
  const status = finalization.provider_status !== 'unknown'
    ? finalization.provider_status
    : safeLeadText(payload.status || payload.message_status || payload.state)
  const parts = [
    direction === 'inbound' ? 'Inbound SMS provider event' : 'Outbound SMS provider event',
    contactPhone ? `${direction === 'inbound' ? 'from' : 'to'} ${maskPhone(contactPhone)}` : '',
    status || safeLeadText(eventType),
  ].filter(Boolean)
  return parts.join(' ')
}

function isInboundDirection(payload = {}) {
  const direction = safeLeadText(
    payload.direction ||
      payload.call_direction ||
      payload.message_direction ||
      payload.direction_type,
  ).toLowerCase()
  return ['inbound', 'incoming', 'received'].includes(direction)
}
