import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import {
  getTelnyxWebhookPublicKeys,
  getTelnyxSmsFrom,
  getTelnyxWebhookUrl,
  normalizePhone,
  safeLeadText,
  telnyxWebhookSignatureRequired,
} from '../server/runtime-config.mjs'
import { telnyxWebhookPublicKeyObject } from '../server/telnyx-webhook-signature.mjs'

const apiKey = safeLeadText(process.env.TELNYX_API_KEY)
const messagingProfileId = safeLeadText(process.env.TELNYX_MESSAGING_PROFILE_ID)
const connectionId = safeLeadText(process.env.TELNYX_CONNECTION_ID)
const expectedWebhookUrl = safeLeadText(getTelnyxWebhookUrl())
const smsFrom = safeLeadText(getTelnyxSmsFrom())
const callerId = normalizePhone(process.env.TELNYX_FROM_NUMBER || '')
const phoneNumber = smsFrom || callerId
const webhookPublicKeys = getTelnyxWebhookPublicKeys()
const webhookSignatureRequired = telnyxWebhookSignatureRequired()
const failures = []
const webhookSignatureKeyProof = verifyWebhookSignatureKeys(webhookPublicKeys)

function makeTempDir(prefix) {
  fs.mkdirSync('.tmp', { recursive: true })
  return fs.mkdtempSync(path.join('.tmp', `${prefix}-`))
}

function verifyWebhookSignatureKeys(keys = []) {
  const result = {
    parseable: keys.length > 0,
    usableKeyCount: 0,
    failures: [],
  }
  keys.forEach((key, index) => {
    try {
      telnyxWebhookPublicKeyObject(key)
      result.usableKeyCount += 1
    } catch (error) {
      result.parseable = false
      result.failures.push(
        `TELNYX_WEBHOOK_PUBLIC_KEY #${index + 1} is not parseable by the production verifier: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  })
  if (keys.length > 0 && result.usableKeyCount === 0) result.parseable = false
  return result
}

if (!apiKey) failures.push('TELNYX_API_KEY is missing.')
if (!messagingProfileId) failures.push('TELNYX_MESSAGING_PROFILE_ID is missing.')
if (!connectionId) failures.push('TELNYX_CONNECTION_ID is missing.')
if (!expectedWebhookUrl) failures.push('TELNYX_WEBHOOK_URL is missing.')
if (!phoneNumber) failures.push('TELNYX_SMS_NUMBER or TELNYX_FROM_NUMBER is missing.')
if (webhookPublicKeys.length === 0) {
  failures.push('TELNYX_WEBHOOK_PUBLIC_KEY or TELNYX_WEBHOOK_PUBLIC_KEYS is missing.')
}
failures.push(...webhookSignatureKeyProof.failures)
if (!webhookSignatureRequired) {
  failures.push('TELNYX_WEBHOOK_SIGNATURE_REQUIRED must be true for production source routing.')
}

const nativeSource = await verifyNativeSourceNormalization()
failures.push(...nativeSource.failures)

const details = {
  expectedWebhookUrl,
  phoneNumber,
  messagingProfileId,
  connectionId,
  webhookSignature: {
    configured: webhookPublicKeys.length > 0,
    keyCount: webhookPublicKeys.length,
    parseable: webhookSignatureKeyProof.parseable,
    usableKeyCount: webhookSignatureKeyProof.usableKeyCount,
    required: webhookSignatureRequired,
  },
  phone: null,
  messagingProfile: null,
  callControlApplication: null,
  nativeSource: nativeSource.details,
}

if (failures.length === 0) {
  const [phoneResult, profileResult, profileNumbersResult, connectionResult] =
    await Promise.all([
      telnyxGet(`/phone_numbers?filter[phone_number]=${encodeURIComponent(phoneNumber)}`),
      telnyxGet(`/messaging_profiles/${encodeURIComponent(messagingProfileId)}`),
      telnyxGet(`/messaging_profiles/${encodeURIComponent(messagingProfileId)}/phone_numbers`),
      telnyxGet(`/call_control_applications/${encodeURIComponent(connectionId)}`),
    ])

  const phone = Array.isArray(phoneResult.data) ? phoneResult.data[0] : phoneResult.data
  const profile = profileResult.data || {}
  const profileNumbers = Array.isArray(profileNumbersResult.data)
    ? profileNumbersResult.data
    : []
  const connection = connectionResult.data || {}

  details.phone = phoneResult.ok
    ? {
        found: Boolean(phone),
        phoneNumber: phone?.phone_number || '',
        messagingProfileId: phone?.messaging_profile_id || phone?.messaging_profile?.id || '',
        connectionId: phone?.connection_id || phone?.connection?.id || '',
      }
    : telnyxErrorSummary(phoneResult)
  details.messagingProfile = profileResult.ok
    ? {
        id: profile.id || '',
        name: profile.name || '',
        enabled: profile.enabled ?? profile.active ?? null,
        webhookUrl: profile.webhook_url || '',
        containsPhoneNumber: profileNumbers.some((item) => item.phone_number === phoneNumber),
      }
    : telnyxErrorSummary(profileResult)
  details.callControlApplication = connectionResult.ok
    ? {
        id: connection.id || '',
        active: connection.active ?? connection.enabled ?? null,
        webhookEventUrl: connection.webhook_event_url || '',
        webhookApiVersion: connection.webhook_api_version || '',
      }
    : telnyxErrorSummary(connectionResult)

  if (!phoneResult.ok) failures.push(`Telnyx phone lookup failed: ${details.phone.error}`)
  if (!profileResult.ok) {
    failures.push(`Telnyx messaging profile lookup failed: ${details.messagingProfile.error}`)
  }
  if (!profileNumbersResult.ok) {
    failures.push(
      `Telnyx messaging profile phone-number lookup failed: ${
        telnyxErrorSummary(profileNumbersResult).error
      }`,
    )
  }
  if (!connectionResult.ok) {
    failures.push(`Telnyx Call Control app lookup failed: ${details.callControlApplication.error}`)
  }

  if (phoneResult.ok && !phone) failures.push(`${phoneNumber} is not present in Telnyx phone numbers.`)
  if (phone && details.phone.messagingProfileId !== messagingProfileId) {
    failures.push(
      `${phoneNumber} is attached to messaging profile ${
        details.phone.messagingProfileId || 'none'
      }, not TELNYX_MESSAGING_PROFILE_ID ${messagingProfileId}.`,
    )
  }
  if (profileResult.ok && details.messagingProfile.webhookUrl !== expectedWebhookUrl) {
    failures.push(
      `Telnyx messaging profile webhook is ${
        details.messagingProfile.webhookUrl || 'empty'
      }, expected ${expectedWebhookUrl}.`,
    )
  }
  if (profileNumbersResult.ok && !details.messagingProfile.containsPhoneNumber) {
    failures.push(`${phoneNumber} is not in TELNYX_MESSAGING_PROFILE_ID ${messagingProfileId}.`)
  }
  if (phone && details.phone.connectionId !== connectionId) {
    failures.push(
      `${phoneNumber} is attached to connection ${details.phone.connectionId || 'none'}, not TELNYX_CONNECTION_ID ${connectionId}.`,
    )
  }
  if (
    connectionResult.ok &&
    details.callControlApplication.webhookEventUrl !== expectedWebhookUrl
  ) {
    failures.push(
      `Telnyx Call Control webhook is ${
        details.callControlApplication.webhookEventUrl || 'empty'
      }, expected ${expectedWebhookUrl}.`,
    )
  }
}

const result = {
  ok: failures.length === 0,
  schemaVersion: 'speak.telnyx-source-routing-check.v1',
  checks: {
    phoneConfigured: Boolean(phoneNumber),
    messagingProfileConfigured: Boolean(messagingProfileId),
    connectionConfigured: Boolean(connectionId),
    expectedWebhookConfigured: Boolean(expectedWebhookUrl),
    webhookSignatureConfigured: webhookPublicKeys.length > 0,
    webhookSignatureKeysParseable: webhookSignatureKeyProof.parseable,
    webhookSignatureRequired,
    phoneUsesMessagingProfile:
      Boolean(details.phone?.messagingProfileId) &&
      details.phone.messagingProfileId === messagingProfileId,
    phoneUsesConnection:
      Boolean(details.phone?.connectionId) && details.phone.connectionId === connectionId,
    messagingWebhookConfigured:
      Boolean(details.messagingProfile?.webhookUrl) &&
      details.messagingProfile.webhookUrl === expectedWebhookUrl,
    callControlWebhookConfigured:
      Boolean(details.callControlApplication?.webhookEventUrl) &&
      details.callControlApplication.webhookEventUrl === expectedWebhookUrl,
    nativeInboundSmsNormalized: nativeSource.checks.inboundSmsNormalized,
    nativeOutboxSmsNormalized: nativeSource.checks.outboxSmsNormalized,
    nativeMissedInboundCallNormalized: nativeSource.checks.missedInboundCallNormalized,
    nativeContactThreadReconciled: nativeSource.checks.contactThreadReconciled,
  },
  details,
  failures,
  nextActions: failures.length
    ? [
        'Attach TELNYX_SMS_NUMBER/TELNYX_FROM_NUMBER to TELNYX_MESSAGING_PROFILE_ID.',
        'Set the Telnyx messaging profile webhook_url to TELNYX_WEBHOOK_URL.',
        'Attach the phone number to TELNYX_CONNECTION_ID for inbound Call Control events.',
        'Set the Telnyx Call Control application webhook_event_url to TELNYX_WEBHOOK_URL.',
        'Set TELNYX_WEBHOOK_PUBLIC_KEYS and TELNYX_WEBHOOK_SIGNATURE_REQUIRED=true.',
        'Rerun npm run qa:telnyx-source-routing on the production host.',
      ]
    : [],
}

console.log(JSON.stringify(result, null, 2))
if (!result.ok) process.exitCode = 1

async function telnyxGet(path) {
  let lastResult = null
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(`https://api.telnyx.com/v2${path}`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
    })
    const payload = await response.json().catch(() => ({}))
    lastResult = {
      ok: response.ok,
      status: response.status,
      data: payload?.data ?? payload,
      errors: payload?.errors || [],
      attempts: attempt,
    }
    if (response.ok || ![429, 500, 502, 503, 504].includes(response.status)) {
      return lastResult
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 300))
  }
  return lastResult
}

function telnyxErrorSummary(result) {
  return {
    ok: false,
    status: result.status,
    error:
      result.errors
        ?.map((error) => error.detail || error.title || error.code)
        .filter(Boolean)
        .join('; ') || `Telnyx request failed with ${result.status}`,
  }
}

async function verifyNativeSourceNormalization() {
  const tempDataDir = makeTempDir('check-telnyx-source-routing-normalizer')
  const previousDataDir = process.env.SPEAK_WORKSPACE_DATA_DIR
  process.env.SPEAK_WORKSPACE_DATA_DIR = tempDataDir
  const localFailures = []
  const checks = {
    inboundSmsNormalized: false,
    outboxSmsNormalized: false,
    missedInboundCallNormalized: false,
    contactThreadReconciled: false,
  }
  const details = {
    tempWorkspace: tempDataDir,
    channels: [],
    messageCount: 0,
    proofActions: [],
  }

  try {
    const telnyx = await import(`../server/telnyx-webhook-normalizer.mjs?check=${Date.now()}`)
    const store = await import(`../server/workspace-store.mjs?check=${Date.now()}`)
    const lead = await store.createWorkspaceLead({
      id: 'lead-telnyx-source-routing-check',
      name: 'Taylor Contact',
      company: 'Taylor Source Check',
      phone: '+15551234567',
    })

    const inboundSms = telnyx.buildTelnyxSmsCommunicationEvent({
      eventType: 'message.received',
      occurredAt: '2026-07-02T15:00:00.000Z',
      webhookEventId: 'evt-sms-inbound-source-routing-check',
      payload: {
        id: 'msg-inbound-source-routing-check',
        direction: 'inbound',
        from: { phone_number: '+15551234567' },
        to: [{ phone_number: phoneNumber || '+12025550141' }],
        text: 'Can you send that over?',
      },
    })
    const outboxSms = telnyx.buildTelnyxSmsCommunicationEvent({
      eventType: 'message.finalized',
      occurredAt: '2026-07-02T15:01:00.000Z',
      webhookEventId: 'evt-sms-outbox-source-routing-check',
      payload: {
        id: 'msg-outbox-source-routing-check',
        direction: 'outbound',
        from: { phone_number: phoneNumber || '+12025550141' },
        to: [{ phone_number: '+15551234567' }],
        completed_at: '2026-07-02T15:01:05.000Z',
        text: 'Here are the details.',
      },
    })
    const missedCall = telnyx.buildTelnyxInboundCallCommunicationEvent({
      eventType: 'call.hangup',
      occurredAt: '2026-07-02T15:02:00.000Z',
      webhookEventId: 'evt-call-missed-source-routing-check',
      payload: {
        call_control_id: 'call-missed-source-routing-check',
        call_session_id: 'session-missed-source-routing-check',
        call_direction: 'incoming',
        from: { phone_number: '+15551234567' },
        to: [{ phone_number: phoneNumber || '+12025550141' }],
        hangup_cause: 'no_answer',
      },
    })

    if (!inboundSms?.communicationEvent) {
      localFailures.push('Native Telnyx inbound SMS payload did not normalize.')
    }
    if (!outboxSms?.communicationEvent) {
      localFailures.push('Native Telnyx outbox SMS payload did not normalize.')
    }
    if (!missedCall?.communicationEvent) {
      localFailures.push('Native Telnyx missed inbound-call payload did not normalize.')
    }

    const recorded = []
    for (const source of [inboundSms, outboxSms, missedCall]) {
      if (!source?.communicationEvent) continue
      recorded.push(await store.recordCommunicationEvent(source.communicationEvent))
    }

    const threads = await store.listCommunicationThreads({
      contactId: lead.id,
      limit: 10,
    })
    const thread = threads.threads[0]
    const messages = thread
      ? await store.listCommunicationThreadMessages(thread.threadId, { limit: 20 })
      : { messages: [] }

    details.channels = thread?.channels || []
    details.messageCount = messages.messages.length
    details.proofActions = messages.messages
      .map((message) => message.proof?.action || message.proof?.automation?.reason)
      .filter(Boolean)

    checks.inboundSmsNormalized = messages.messages.some(
      (message) =>
        message.channel === 'sms' &&
        message.direction === 'inbound' &&
        message.providerIds?.messageId === 'msg-inbound-source-routing-check' &&
        message.providerIds?.fromPhone === '+15551234567',
    )
    checks.outboxSmsNormalized = messages.messages.some(
      (message) =>
        message.channel === 'sms' &&
        message.direction === 'outbound' &&
        message.providerIds?.messageId === 'msg-outbox-source-routing-check' &&
        message.providerIds?.toPhone === '+15551234567' &&
        message.proof?.automation?.reason === 'outbox_source_record_only',
    )
    checks.missedInboundCallNormalized = messages.messages.some(
      (message) =>
        message.channel === 'call' &&
        message.direction === 'inbound' &&
        message.providerIds?.callControlId === 'call-missed-source-routing-check' &&
        message.proof?.action === 'missed_call',
    )
    checks.contactThreadReconciled =
      threads.threads.length === 1 &&
      thread?.contactId === lead.id &&
      details.channels.includes('sms') &&
      details.channels.includes('call') &&
      messages.messages.length === 3

    if (!checks.inboundSmsNormalized) {
      localFailures.push('Native inbound SMS did not persist with from-phone identity.')
    }
    if (!checks.outboxSmsNormalized) {
      localFailures.push('Native outbox SMS did not persist record-only proof.')
    }
    if (!checks.missedInboundCallNormalized) {
      localFailures.push('Native missed inbound call did not persist missed-call proof.')
    }
    if (!checks.contactThreadReconciled) {
      localFailures.push('Native Telnyx source events did not reconcile into one contact thread.')
    }
  } catch (error) {
    localFailures.push(
      `Native Telnyx source normalization failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  } finally {
    if (previousDataDir === undefined) {
      delete process.env.SPEAK_WORKSPACE_DATA_DIR
    } else {
      process.env.SPEAK_WORKSPACE_DATA_DIR = previousDataDir
    }
    fs.rmSync(tempDataDir, { recursive: true, force: true })
  }

  return {
    checks,
    details,
    failures: localFailures,
  }
}
