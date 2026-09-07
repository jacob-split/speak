import 'dotenv/config'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  cleanEmail,
  getGogWrapper,
  getWorkspaceEmailAccount,
  getWorkspaceEmailSendGogAccount,
  numberEnv,
  safeLeadText,
} from '../server/runtime-config.mjs'

const account = cleanEmail(argValue('--account') || getWorkspaceEmailAccount())
const sendAuthAccount = cleanEmail(
  argValue('--send-auth-account') || getWorkspaceEmailSendGogAccount(),
)
const wrapper = argValue('--wrapper') || getGogWrapper()
const displayName = safeLeadText(argValue('--display-name') || 'Speak')
const apply = process.argv.includes('--apply')
const timeoutMs = boundedTimeout(argValue('--timeout-ms'))

const failures = []
const nextActions = []
const details = {
  account,
  sendAuthAccount,
  wrapper,
  apply,
  displayName,
  sendAs: null,
  scopes: [],
}
const checks = {
  accountConfigured: Boolean(account),
  sendAuthAccountConfigured: Boolean(sendAuthAccount),
  wrapperExecutable: existsSync(wrapper),
  sendAuthAccountHasGmail: false,
  sendAuthAccountCanSend: false,
  sendAuthAccountCanManageSendAs: false,
  sendAsConfigured: false,
  readyToCreate: false,
  createAttempted: false,
}

if (!checks.accountConfigured) failures.push('WORKSPACE_EMAIL_ACCOUNT is missing.')
if (!checks.sendAuthAccountConfigured) failures.push('WORKSPACE_EMAIL_SEND_GOG_ACCOUNT is missing.')
if (!checks.wrapperExecutable) failures.push(`GOG wrapper is unavailable: ${wrapper}`)

if (checks.wrapperExecutable && checks.sendAuthAccountConfigured) {
  try {
    const authAccounts = authAccountsFromOutput(runGog(['--json', '--no-input', 'auth', 'list']))
    const authRecord = authAccounts.find(
      (item) => cleanEmail(item.email || item.account) === sendAuthAccount,
    )
    const services = normalizeList(authRecord?.services)
    details.scopes = normalizeList(authRecord?.scopes)
    checks.sendAuthAccountHasGmail = services.includes('gmail')
    checks.sendAuthAccountCanSend = gmailScopesSupportSend(details.scopes)
    checks.sendAuthAccountCanManageSendAs = gmailScopesSupportSendAsManagement(details.scopes)
  } catch (error) {
    failures.push(`GOG auth list failed: ${safeError(error)}`)
  }
}

if (
  checks.wrapperExecutable &&
  checks.sendAuthAccountConfigured &&
  checks.accountConfigured &&
  checks.sendAuthAccountHasGmail
) {
  try {
    const currentSendAs = readSendAs()
    details.sendAs = summarizeSendAs(currentSendAs)
    checks.sendAsConfigured = isAcceptedSendAs(currentSendAs, account)
  } catch (error) {
    failures.push(`Gmail send-as list failed: ${safeError(error)}`)
  }
}

checks.readyToCreate =
  !checks.sendAsConfigured &&
  checks.sendAuthAccountHasGmail &&
  checks.sendAuthAccountCanSend &&
  checks.sendAuthAccountCanManageSendAs

if (!checks.sendAsConfigured && apply && checks.readyToCreate) {
  checks.createAttempted = true
  try {
    runGog([
      '--account',
      sendAuthAccount,
      '--json',
      '--results-only',
      '--no-input',
      'gmail',
      'settings',
      'sendas',
      'create',
      account,
      '--display-name',
      displayName,
      '--reply-to',
      account,
    ])
    const refreshed = readSendAs()
    details.sendAs = summarizeSendAs(refreshed)
    checks.sendAsConfigured = isAcceptedSendAs(refreshed, account)
    if (!checks.sendAsConfigured) {
      failures.push(`${account} send-as alias exists but is not accepted yet.`)
    }
  } catch (error) {
    failures.push(`Gmail send-as create failed: ${safeError(error)}`)
  }
}

if (!checks.sendAuthAccountHasGmail) {
  failures.push(`${sendAuthAccount || 'send auth account'} is not stored with Gmail auth.`)
}
if (!checks.sendAuthAccountCanSend) {
  failures.push(`${sendAuthAccount || 'send auth account'} is missing Gmail send/compose scope.`)
}
if (!checks.sendAsConfigured && !checks.sendAuthAccountCanManageSendAs) {
  failures.push(
    `${sendAuthAccount || 'send auth account'} is missing Gmail settings scope to create or verify ${account || 'workspace mailbox'} as a send-as alias.`,
  )
}
if (!checks.sendAsConfigured && checks.readyToCreate && !apply) {
  nextActions.push('Run npm run repair:workspace-email-sendas:apply to create the send-as alias.')
}
if (!checks.sendAuthAccountCanManageSendAs) {
  nextActions.push(
    `Run npm run repair:workspace-email-sendas:auth-url to reauthorize ${sendAuthAccount || 'the send auth account'} with Gmail settings scope, then complete it with npm run repair:workspace-email-sendas:auth-complete -- --auth-url '<redirected-localhost-url>'.`,
  )
  nextActions.push(
    `Equivalent raw GOG command: ${reauthorizeCommand(sendAuthAccount)}`,
  )
}
if (checks.createAttempted && !checks.sendAsConfigured) {
  nextActions.push(
    `Open the verification email delivered to ${account || 'the workspace mailbox'}, accept the send-as alias, then rerun npm run qa:workspace-email.`,
  )
}
if (!checks.sendAsConfigured) {
  nextActions.push('Rerun npm run qa:workspace-email after repair.')
}

const result = {
  ok: failures.length === 0 && checks.sendAsConfigured,
  schemaVersion: 'speak.workspace-email-sendas-repair.v1',
  mode: apply ? 'apply' : 'dry-run',
  checks,
  details,
  failures,
  note: apply
    ? 'Apply may create the workspace mailbox send-as alias when the configured auth account has the required Gmail scopes.'
    : 'Dry-run only. Re-run with --apply after reviewing send-as readiness and required scopes.',
  nextActions,
}

console.log(JSON.stringify(result, null, 2))
if (!result.ok) process.exitCode = 1

function readSendAs() {
  const payload = runGog([
    '--account',
    sendAuthAccount,
    '--json',
    '--results-only',
    '--no-input',
    'gmail',
    'settings',
    'sendas',
    'list',
  ])
  return workspaceEmailSendAsListFromOutput(payload)
}

function isAcceptedSendAs(items = [], email = '') {
  return items.some((item) => {
    const sendAsEmail = cleanEmail(item.sendAsEmail || item.email || item.address || item.value)
    const status = safeLeadText(item.verificationStatus || item.verification_status).toLowerCase()
    return sendAsEmail === email && (!status || ['accepted', 'verified'].includes(status))
  })
}

function summarizeSendAs(items = []) {
  return items.map((item) => {
    const sendAsEmail = cleanEmail(item.sendAsEmail || item.email || item.address || item.value)
    return {
      sendAsEmail,
      displayName: safeLeadText(item.displayName),
      verificationStatus:
        safeLeadText(item.verificationStatus || item.verification_status) || 'not-reported',
      isDefault: Boolean(item.isDefault || item.is_default),
      isPrimary: Boolean(item.isPrimary || item.is_primary),
    }
  })
}

function runGog(args) {
  const stdout = execFileSync(wrapper, args, {
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
  })
  const parsed = parseJsonOutput(stdout)
  if (!parsed) throw new Error('Unreadable JSON output')
  return parsed
}

function authAccountsFromOutput(output) {
  if (Array.isArray(output)) return output
  if (!output || typeof output !== 'object') return []
  if (Array.isArray(output.accounts)) return output.accounts
  if (Array.isArray(output.result)) return output.result
  if (Array.isArray(output.data)) return output.data
  return []
}

function workspaceEmailSendAsListFromOutput(output) {
  if (Array.isArray(output)) return output
  if (!output || typeof output !== 'object') return []
  const candidates = [
    output.result,
    output.results,
    output.sendAs,
    output.send_as,
    output.data,
    output.items,
  ]
  for (const candidate of candidates) {
    const nested = workspaceEmailSendAsListFromOutput(candidate)
    if (nested.length) return nested
  }
  if (output.sendAsEmail || output.email || output.address) return [output]
  return []
}

function parseJsonOutput(output) {
  const text = String(output || '').trim()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    const objectStart = text.indexOf('{')
    const objectEnd = text.lastIndexOf('}')
    const arrayStart = text.indexOf('[')
    const arrayEnd = text.lastIndexOf(']')
    const useArray = arrayStart >= 0 && arrayEnd > arrayStart && (objectStart < 0 || arrayStart < objectStart)
    const slice = useArray ? text.slice(arrayStart, arrayEnd + 1) : text.slice(objectStart, objectEnd + 1)
    if (!slice) return null
    try {
      return JSON.parse(slice)
    } catch {
      return null
    }
  }
}

function normalizeList(value) {
  return Array.isArray(value)
    ? value.map((item) => safeLeadText(item).toLowerCase()).filter(Boolean)
    : []
}

function gmailScopesSupportSend(scopes) {
  return normalizeList(scopes).some(
    (scope) =>
      scope === 'https://mail.google.com/' ||
      scope.endsWith('/auth/gmail.compose') ||
      scope.endsWith('/auth/gmail.send') ||
      scope.endsWith('/auth/gmail.modify'),
  )
}

function gmailScopesSupportSendAsManagement(scopes) {
  return normalizeList(scopes).some(
    (scope) =>
      scope === 'https://mail.google.com/' ||
      scope.endsWith('/auth/gmail.settings.basic') ||
      scope.endsWith('/auth/gmail.settings.sharing'),
  )
}

function boundedTimeout(value) {
  return Math.max(
    1000,
    Math.min(60_000, Number(value) || numberEnv('WORKSPACE_EMAIL_AUTH_CHECK_TIMEOUT_MS', 5_000)),
  )
}

function reauthorizeCommand(email) {
  return [
    'gog auth add',
    email || '<send-auth-account>',
    '--remote --step=1 --services=gmail --gmail-scope=full',
    '--extra-scopes=https://www.googleapis.com/auth/gmail.settings.basic,https://www.googleapis.com/auth/gmail.settings.sharing',
    '--force-consent',
  ].join(' ')
}

function argValue(name) {
  const index = process.argv.indexOf(name)
  if (index >= 0) return process.argv[index + 1] || ''
  const prefix = `${name}=`
  const item = process.argv.find((value) => value.startsWith(prefix))
  return item ? item.slice(prefix.length) : ''
}

function safeError(error) {
  return safeLeadText(error?.stderr || error?.message || error).slice(0, 500)
}
