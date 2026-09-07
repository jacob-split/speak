import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import {
  getGogWrapper,
  getSpeakLinkUrl,
  getTelnyxSmsFrom,
  getWorkspaceEmailAccount,
  getWorkspaceEmailSendGogAccount,
  numberEnv,
  preferredFirstName,
} from './runtime-config.mjs'
import {
  TELNYX_API_BASE,
  providerError,
  readJson,
  telnyxHeaders,
} from './provider-http.mjs'
import {
  createTelnyxSmsFinalizationTracker,
  normalizeTelnyxSmsFinalization,
} from './telnyx-sms-finalization.mjs'

export {
  createTelnyxSmsFinalizationTracker,
  normalizeTelnyxSmsFinalization,
} from './telnyx-sms-finalization.mjs'

const execFileAsync = promisify(execFile)
const acceptedSmsStatuses = new Set([
  'success',
  'queued',
  'sending',
  'sent',
  'delivered',
  'accepted',
])
const telnyxSmsFinalizationTracker = createTelnyxSmsFinalizationTracker({
  readMessage: readTelnyxTextMessage,
  timeoutMs: numberEnv('TELNYX_SMS_FINALIZATION_TIMEOUT_MS', 30_000),
  pollIntervalMs: numberEnv('TELNYX_SMS_FINALIZATION_POLL_MS', 2_000),
})

export async function sendTextMessage(toPhone, message) {
  const from = getTelnyxSmsFrom()
  const missing = []
  if (!process.env.TELNYX_API_KEY) missing.push('TELNYX_API_KEY')
  if (!from) missing.push('TELNYX_SMS_NUMBER or TELNYX_FROM_NUMBER')
  if (!process.env.TELNYX_MESSAGING_PROFILE_ID) missing.push('TELNYX_MESSAGING_PROFILE_ID')
  if (missing.length > 0) throw new Error(`SMS is not configured: ${missing.join(', ')}`)

  const text = String(message || '').trim()
  if (!text) throw new Error('SMS message body is required')

  const response = await fetch(`${TELNYX_API_BASE}/messages`, {
    method: 'POST',
    headers: telnyxHeaders(),
    signal: AbortSignal.timeout(Math.max(1, numberEnv('TELNYX_SMS_TIMEOUT_MS', 15_000))),
    body: JSON.stringify({
      from,
      to: toPhone,
      text,
      messaging_profile_id: process.env.TELNYX_MESSAGING_PROFILE_ID,
    }),
  })
  const payload = await readJson(response)
  if (!response.ok) {
    throw new Error(providerError('SMS delivery failed', payload))
  }
  const result = payload?.data || payload
  const messageId = String(result?.id || result?.message_id || result?.messageId || '').trim()
  const status = String(result?.to?.[0]?.status || result?.status || '').trim().toLowerCase()
  if (!messageId || !status) {
    throw new Error('SMS provider response missing message ID/status proof')
  }
  if (!acceptedSmsStatuses.has(status)) {
    throw new Error(`SMS provider response has unsuccessful status proof: ${status}`)
  }
  return result
}

export function observeTelnyxSmsFinalization(payload, options = {}) {
  return telnyxSmsFinalizationTracker.observe(payload, options)
}

export function waitForTelnyxSmsFinalization(providerResult, options = {}) {
  return telnyxSmsFinalizationTracker.waitFor(providerResult, options)
}

export async function sendEmail(toEmail, subject, body) {
  const account = getWorkspaceEmailAccount()
  const authAccount = getWorkspaceEmailSendGogAccount()
  const wrapper = getGogWrapper()
  if (!account) throw new Error('Workspace email account is missing')
  if (!authAccount) throw new Error('Workspace email auth account is missing')
  if (!existsSync(wrapper)) throw new Error(`Workspace email sender is unavailable: ${wrapper}`)

  const cleanSubject = String(subject || '').trim()
  const cleanBody = String(body || '').trim()
  if (!cleanSubject) throw new Error('Email subject is required')
  if (!cleanBody) throw new Error('Email body is required')

  const { stdout, stderr } = await execFileAsync(
    wrapper,
    [
      '--account',
      authAccount,
      '--json',
      '--no-input',
      'gmail',
      'send',
      '--to',
      toEmail,
      '--subject',
      cleanSubject,
      '--body',
      cleanBody,
      '--from',
      account,
    ],
    {
      env: process.env,
      timeout: numberEnv('WORKSPACE_EMAIL_TIMEOUT_MS', 45_000),
      maxBuffer: 1024 * 1024,
    },
  )

  const parsed = parseJsonOutput(stdout)
  if (!parsed) {
    throw new Error(
      `Workspace email returned unreadable output: ${String(stderr || stdout).slice(0, 300)}`,
    )
  }
  const result = parsed.result || parsed.data || parsed
  if (result.error || result.ok === false) {
    throw new Error(result.error || result.message || 'Workspace email send failed')
  }
  const messageId = String(result.id || result.messageId || result.message_id || '').trim()
  if (!messageId) {
    throw new Error('Workspace email provider response missing message ID proof')
  }
  return result
}

export async function sendPortalSms(toPhone) {
  return sendTextMessage(toPhone, buildPortalSmsBody())
}

export async function sendPortalEmail(toEmail, state) {
  return sendEmail(toEmail, 'Your requested link', buildPortalEmailBody(state))
}

export function buildPortalSmsBody() {
  const linkUrl = configuredLinkUrl()
  const senderName = String(
    process.env.WORKSPACE_SMS_SENDER_NAME ||
      process.env.WORKSPACE_EMAIL_SENDER_NAME ||
      'Speak',
  )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'Speak'
  return `${senderName}: Here is the requested link: ${linkUrl} Open it while we're together and I can help if anything gets stuck. Reply STOP to opt out.`
}

export function buildPortalEmailBody(state) {
  const linkUrl = configuredLinkUrl()
  const firstName = preferredFirstName(state.lead) || 'there'
  const senderName = process.env.WORKSPACE_EMAIL_SENDER_NAME || 'Speak'
  return [
    `Hi ${firstName},`,
    '',
    'Here is the requested link:',
    linkUrl,
    '',
    "Please open it while we're together. If anything gets stuck, we can help.",
    '',
    'Thanks,',
    senderName,
  ].join('\n')
}

function configuredLinkUrl() {
  const linkUrl = getSpeakLinkUrl()
  if (!linkUrl) throw new Error('SPEAK_LINK_URL is required for requested link delivery')
  return linkUrl
}

async function readTelnyxTextMessage(messageId) {
  const cleanMessageId = String(messageId || '').trim()
  if (!cleanMessageId) throw new Error('Telnyx SMS message ID is required for final delivery proof')
  if (!process.env.TELNYX_API_KEY) throw new Error('TELNYX_API_KEY is required for SMS readback')
  const response = await fetch(
    `${TELNYX_API_BASE}/messages/${encodeURIComponent(cleanMessageId)}`,
    {
      method: 'GET',
      headers: telnyxHeaders(),
      signal: AbortSignal.timeout(
        Math.max(1, numberEnv('TELNYX_SMS_FINALIZATION_READ_TIMEOUT_MS', 8_000)),
      ),
    },
  )
  const payload = await readJson(response)
  if (!response.ok) {
    throw new Error(providerError('SMS delivery-status readback failed', payload))
  }
  return payload?.data || payload
}

function parseJsonOutput(output) {
  const text = String(output || '').trim()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    try {
      return JSON.parse(text.slice(start, end + 1))
    } catch {
      return null
    }
  }
}
