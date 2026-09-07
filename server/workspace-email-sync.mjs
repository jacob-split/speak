import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import {
  cleanEmail,
  getGogWrapper,
  getWorkspaceEmailAccount,
  getWorkspaceEmailReadGogAccount,
  numberEnv,
  safeLeadText,
} from './runtime-config.mjs'

const execFileAsync = promisify(execFile)

export const DEFAULT_WORKSPACE_EMAIL_SYNC_WINDOW = '30d'
export const DEFAULT_WORKSPACE_EMAIL_SYNC_QUERY = 'newer_than:30d -in:spam -in:trash'
export const DEFAULT_WORKSPACE_EMAIL_SYNC_LIMIT = 50
export const DEFAULT_WORKSPACE_EMAIL_SOURCE_SAMPLE_WINDOW = '90d'

export async function fetchWorkspaceEmailSyncPayloads({
  account = getWorkspaceEmailAccount(),
  authAccount = getWorkspaceEmailReadGogAccount(),
  query = process.env.WORKSPACE_EMAIL_SYNC_QUERY || '',
  limit = process.env.WORKSPACE_EMAIL_SYNC_LIMIT || DEFAULT_WORKSPACE_EMAIL_SYNC_LIMIT,
  wrapper = getGogWrapper(),
  timeoutMs = numberEnv('WORKSPACE_EMAIL_SYNC_TIMEOUT_MS', 60_000),
} = {}) {
  const cleanAccount = cleanEmail(account)
  const cleanAuthAccount = cleanEmail(authAccount || account)
  if (!cleanAccount) throw new Error('Workspace email account is missing')
  if (!cleanAuthAccount) throw new Error('Workspace email auth account is missing')
  if (!existsSync(wrapper)) throw new Error(`Workspace email sync is unavailable: ${wrapper}`)

  const boundedLimit = Math.max(1, Math.min(500, Number(limit) || DEFAULT_WORKSPACE_EMAIL_SYNC_LIMIT))
  const searchQuery = safeLeadText(query) || workspaceEmailDefaultSyncQuery(cleanAccount)
  let stdout = ''
  let stderr = ''
  try {
    const result = await execFileAsync(
      wrapper,
      [
        '--account',
        cleanAuthAccount,
        '--json',
        '--results-only',
        '--no-input',
        'gmail',
        'messages',
        'search',
        searchQuery,
        '--max',
        String(boundedLimit),
        '--include-body',
        '--body-format',
        'text',
      ],
      {
        env: process.env,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      },
    )
    stdout = result.stdout
    stderr = result.stderr
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).trim()
    throw new Error(`Workspace email sync read failed: ${detail.slice(0, 500)}`)
  }

  const parsed = parseJsonOutput(stdout)
  if (!parsed) {
    throw new Error(
      `Workspace email sync returned unreadable output: ${String(stderr || stdout).slice(0, 300)}`,
    )
  }
  return workspaceEmailPayloadsFromGogOutput(parsed, { account: cleanAccount })
}

export function workspaceEmailPayloadsFromGogOutput(output, { account = '' } = {}) {
  return primaryGogResultList(output)
    .map((message) => normalizeWorkspaceEmailSyncPayload(message, { account }))
    .filter((payload) => payload && workspaceEmailPayloadInvolvesAccount(payload, account))
}

export function workspaceEmailSourceProbeQuery(
  account = getWorkspaceEmailAccount(),
  { window = DEFAULT_WORKSPACE_EMAIL_SOURCE_SAMPLE_WINDOW } = {},
) {
  const cleanAccount = cleanEmail(account)
  if (!cleanAccount) return DEFAULT_WORKSPACE_EMAIL_SYNC_QUERY
  const cleanWindow = safeLeadText(window).replace(/[^0-9A-Za-z_:-]/g, '') ||
    DEFAULT_WORKSPACE_EMAIL_SOURCE_SAMPLE_WINDOW
  return `newer_than:${cleanWindow} (from:${cleanAccount} OR to:${cleanAccount} OR cc:${cleanAccount} OR bcc:${cleanAccount}) -in:spam -in:trash`
}

export function workspaceEmailDefaultSyncQuery(account = getWorkspaceEmailAccount()) {
  return workspaceEmailSourceProbeQuery(account, {
    window: process.env.WORKSPACE_EMAIL_SYNC_WINDOW || DEFAULT_WORKSPACE_EMAIL_SYNC_WINDOW,
  })
}

export function workspaceEmailPayloadInvolvesAccount(payload = {}, account = '') {
  const cleanAccount = cleanEmail(account)
  if (!cleanAccount) return true
  return [
    payload.fromEmail,
    payload.toEmail,
    ...(Array.isArray(payload.fromEmails) ? payload.fromEmails : []),
    ...(Array.isArray(payload.toEmails) ? payload.toEmails : []),
    ...(Array.isArray(payload.ccEmails) ? payload.ccEmails : []),
    ...(Array.isArray(payload.bccEmails) ? payload.bccEmails : []),
  ].some((email) => cleanEmail(email) === cleanAccount)
}

export function normalizeWorkspaceEmailSyncPayload(message = {}, { account = '' } = {}) {
  if (!message || typeof message !== 'object') return null
  const headers = headersByName(message)
  const cleanAccount = cleanEmail(account)
  const fromEmails = allEmails(
    message.from,
    message.fromEmail,
    message.fromEmails,
    message.sender,
    message.headers?.from,
    headers.from,
  )
  const toEmails = allEmails(
    message.to,
    message.toEmail,
    message.toEmails,
    message.recipient,
    message.headers?.to,
    headers.to,
  )
  const ccEmails = allEmails(
    message.cc,
    message.ccEmail,
    message.ccEmails,
    message.headers?.cc,
    headers.cc,
  )
  const bccEmails = allEmails(
    message.bcc,
    message.bccEmail,
    message.bccEmails,
    message.headers?.bcc,
    headers.bcc,
  )
  const subject = safeLeadText(message.subject || message.title || headers.subject)
  const body = safeLeadText(
    message.body ||
      message.text ||
      message.textBody ||
      message.plainText ||
      message.snippet ||
      bodyFromPayload(message.payload),
  )
  const labelIds = normalizeLabels(message.labelIds || message.labels || message.label_ids)
  const fromEmail = fromEmails[0] || ''
  const inferredToEmails =
    toEmails.length || !cleanAccount || fromEmail === cleanAccount || !labelIds.includes('INBOX')
      ? toEmails
      : [cleanAccount]
  const toEmail = firstNonAccountEmail(inferredToEmails, cleanAccount) || inferredToEmails[0] || ''
  const direction = workspaceEmailSyncDirection(message, {
    account: cleanAccount,
    fromEmail,
    labelIds,
    toEmail,
  })
  const messageId = safeLeadText(
    message.id ||
      message.messageId ||
      message.message_id ||
      message.gmailMessageId ||
      message.providerMessageId,
  )
  const threadId = safeLeadText(
    message.threadId ||
      message.thread_id ||
      message.gmailThreadId ||
      message.externalThreadId,
  )
  const date = workspaceEmailSyncDate(message, headers)

  return {
    id: messageId,
    messageId,
    message_id: messageId,
    threadId,
    thread_id: threadId,
    from: fromEmail,
    fromEmail,
    fromEmails,
    from_email: fromEmail,
    to: toEmail,
    toEmail,
    toEmails: inferredToEmails,
    to_email: toEmail,
    ccEmails,
    bccEmails,
    subject,
    body,
    text: body,
    direction,
    date,
    at: date,
    labels: labelIds,
    provider: 'google_workspace',
  }
}

function primaryGogResultList(output) {
  if (Array.isArray(output)) return output
  if (!output || typeof output !== 'object') return []
  const candidates = [
    output.result,
    output.results,
    output.messages,
    output.data,
    output.items,
  ]
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate
    if (candidate && typeof candidate === 'object') {
      const nested = primaryGogResultList(candidate)
      if (nested.length) return nested
    }
  }
  if (safeLeadText(output.id || output.messageId || output.message_id)) return [output]
  return []
}

function headersByName(message = {}) {
  const headers = {}
  const rawHeaders = Array.isArray(message.payload?.headers)
    ? message.payload.headers
    : Array.isArray(message.headers)
      ? message.headers
      : []
  rawHeaders.forEach((header) => {
    const name = safeLeadText(header?.name || header?.key).toLowerCase()
    if (!name) return
    headers[name] = safeLeadText(header?.value)
  })
  return headers
}

function allEmails(...values) {
  const emails = []
  const seen = new Set()
  for (const value of values) {
    for (const email of extractEmails(value)) {
      if (!email || seen.has(email)) continue
      seen.add(email)
      emails.push(email)
    }
  }
  return emails
}

function extractEmails(value) {
  if (Array.isArray(value)) {
    const emails = []
    for (const item of value) {
      emails.push(...extractEmails(item))
    }
    return emails
  }
  if (value && typeof value === 'object') {
    return extractEmails(value.email || value.address || value.value || value.name)
  }
  const text = String(value || '')
  return Array.from(text.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi))
    .map((match) => cleanEmail(match[0]))
    .filter(Boolean)
}

function firstNonAccountEmail(emails, account = '') {
  return emails.find((email) => email && email !== account) || ''
}

function normalizeLabels(value) {
  const labels = Array.isArray(value) ? value : String(value || '').split(/[,\s]+/)
  return labels.map((label) => safeLeadText(label).toUpperCase()).filter(Boolean)
}

function workspaceEmailSyncDirection(message, { account, fromEmail, labelIds, toEmail }) {
  const explicit = safeLeadText(message.direction || message.message_direction).toLowerCase()
  if (['outbound', 'sent', 'send', 'from_me'].includes(explicit)) return 'outbound'
  if (['inbound', 'received', 'incoming', 'inbox'].includes(explicit)) return 'inbound'
  if (labelIds.includes('SENT')) return 'outbound'
  if (labelIds.includes('INBOX')) return 'inbound'
  if (account && fromEmail === account && toEmail !== account) return 'outbound'
  return 'inbound'
}

function workspaceEmailSyncDate(message, headers) {
  const raw = safeLeadText(
    message.at ||
      message.date ||
      message.receivedAt ||
      message.received_at ||
      message.internalDate ||
      headers.date,
  )
  if (!raw) return new Date().toISOString()
  const epochMs = Number(raw)
  const date = Number.isFinite(epochMs) && epochMs > 1_000_000_000
    ? new Date(epochMs)
    : new Date(raw)
  if (Number.isNaN(date.getTime())) return new Date().toISOString()
  return date.toISOString()
}

function bodyFromPayload(payload = {}) {
  if (!payload || typeof payload !== 'object') return ''
  return bodyFromPart(payload)
}

function bodyFromParts(parts) {
  if (!Array.isArray(parts)) return ''
  const preferred = parts
    .map((part) => bodyFromPart(part, { preferPlainText: true }))
    .find(Boolean)
  if (preferred) return preferred
  return parts.map((part) => bodyFromPart(part)).find(Boolean) || ''
}

function bodyFromPart(part = {}, { preferPlainText = false } = {}) {
  if (!part || typeof part !== 'object') return ''
  const mimeType = safeLeadText(part.mimeType || part.mime_type).toLowerCase()
  if (preferPlainText && mimeType && mimeType !== 'text/plain') {
    const nested = bodyFromParts(part.parts)
    return nested || ''
  }
  const explicitText = safeLeadText(part.body?.text || part.text || part.plainText)
  if (explicitText) return explicitText
  const dataText = decodeGmailBodyData(part.body?.data || part.data)
  if (dataText) return mimeType === 'text/html' ? htmlToText(dataText) : dataText
  return bodyFromParts(part.parts)
}

function decodeGmailBodyData(value) {
  const text = safeLeadText(value)
  if (!text) return ''
  try {
    const base64 = text.replace(/-/g, '+').replace(/_/g, '/')
    return safeLeadText(Buffer.from(base64, 'base64').toString('utf8'))
  } catch {
    return ''
  }
}

function htmlToText(value) {
  return safeLeadText(
    String(value || '')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n'),
  )
}

function parseJsonOutput(output) {
  const text = String(output || '').trim()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    const arrayStart = text.indexOf('[')
    const arrayEnd = text.lastIndexOf(']')
    const useArray = arrayStart >= 0 && arrayEnd > arrayStart && (start < 0 || arrayStart < start)
    const slice = useArray ? text.slice(arrayStart, arrayEnd + 1) : text.slice(start, end + 1)
    if (!slice) return null
    try {
      return JSON.parse(slice)
    } catch {
      return null
    }
  }
}
