import 'dotenv/config'
import {
  DEFAULT_WORKSPACE_EMAIL_SYNC_LIMIT,
  fetchWorkspaceEmailSyncPayloads,
  workspaceEmailDefaultSyncQuery,
} from '../server/workspace-email-sync.mjs'

const args = new Set(process.argv.slice(2))
const apply = args.has('--apply')
const allowAutomation = args.has('--allow-automation')
const account = argValue('--account') || process.env.WORKSPACE_EMAIL_ACCOUNT || undefined
const authAccount =
  argValue('--read-auth-account') ||
  argValue('--auth-account') ||
  process.env.WORKSPACE_EMAIL_READ_GOG_ACCOUNT ||
  process.env.GMAIL_READ_GOG_ACCOUNT ||
  process.env.WORKSPACE_EMAIL_GOG_ACCOUNT ||
  process.env.GMAIL_GOG_ACCOUNT ||
  undefined
const query = argValue('--query') || process.env.WORKSPACE_EMAIL_SYNC_QUERY || workspaceEmailDefaultSyncQuery(account)
const limit = boundedNumber(
  argValue('--limit') || process.env.WORKSPACE_EMAIL_SYNC_LIMIT,
  DEFAULT_WORKSPACE_EMAIL_SYNC_LIMIT,
  500,
)

if (!apply) {
  try {
    const payloads = await fetchWorkspaceEmailSyncPayloads({
      account,
      authAccount,
      query,
      limit,
    })
    print({
      ok: true,
      mode: 'dry-run',
      query,
      limit,
      scanned: payloads.length,
      eligible: payloads.filter((payload) => payload.body && (payload.fromEmail || payload.toEmail)).length,
      inbound: payloads.filter((payload) => payload.direction === 'inbound').length,
      outbound: payloads.filter((payload) => payload.direction === 'outbound').length,
      note: 'Dry-run does not write communication threads or send auto-replies.',
    })
  } catch (error) {
    print({
      ok: false,
      mode: 'dry-run',
      query,
      limit,
      error: 'workspace_email_sync_read_failed',
      message: error instanceof Error ? error.message : String(error),
    })
    process.exitCode = 1
  }
} else {
  const baseUrl = normalizeBaseUrl(
    argValue('--base-url') ||
      process.env.SPEAK_API_BASE_URL ||
      `http://127.0.0.1:${process.env.PORT || 8787}${process.env.BASE_PATH || ''}`,
  )
  const headers = {
    'content-type': 'application/json',
  }
  const token = argValue('--token') || process.env.SPEAK_INTERNAL_EVENT_TOKEN || ''
  if (token) headers['x-speak-internal-token'] = token

  const response = await fetch(`${baseUrl}/api/workspace-email/sync`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      account,
      allowAutomation,
      authAccount,
      limit,
      query,
    }),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    print({
      ok: false,
      mode: 'apply',
      status: response.status,
      error: payload?.error || 'workspace_email_sync_failed',
      message: payload?.message || response.statusText,
    })
    process.exitCode = 1
  } else {
    print({
      ok: true,
      mode: 'apply',
      query,
      limit,
      allowAutomation,
      scanned: payload?.scanned || 0,
      recorded: payload?.recorded || 0,
      skipped: payload?.skipped || 0,
      note: allowAutomation
        ? 'Inbound email auto-replies can run only when explicit policy exists.'
        : 'Apply recorded messages only; inbound auto-replies were disabled for sync.',
    })
  }
}

function argValue(name) {
  const prefix = `${name}=`
  return process.argv
    .slice(2)
    .find((arg) => arg.startsWith(prefix))
    ?.slice(prefix.length)
}

function boundedNumber(value, fallback, max) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.min(max, Math.floor(number))
}

function normalizeBaseUrl(value) {
  return String(value || '').replace(/\/+$/, '')
}

function print(payload) {
  console.log(JSON.stringify(payload, null, 2))
}
