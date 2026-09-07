import 'dotenv/config'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  cleanEmail,
  getGogWrapper,
  getWorkspaceEmailAccount,
  getWorkspaceEmailReadGogAccount,
  getWorkspaceEmailSendGogAccount,
  numberEnv,
  safeLeadText,
} from '../server/runtime-config.mjs'

const account = cleanEmail(argValue('--account') || getWorkspaceEmailAccount())
const sharedAuthAccount = cleanEmail(argValue('--auth-account'))
const readAuthAccount = cleanEmail(
  argValue('--read-auth-account') ||
    sharedAuthAccount ||
    getWorkspaceEmailReadGogAccount(),
)
const sendAuthAccount = cleanEmail(
  argValue('--send-auth-account') ||
    sharedAuthAccount ||
    getWorkspaceEmailSendGogAccount(),
)
const wrapper = argValue('--wrapper') || getGogWrapper()
const timeoutMs = boundedTimeout(argValue('--timeout-ms'))
const delegatedMailboxRead = truthyEnv('WORKSPACE_EMAIL_GOG_ACCOUNT_READS_MAILBOX')

const checks = {
  accountConfigured: Boolean(account),
  authAccountConfigured: Boolean(readAuthAccount || sendAuthAccount),
  readAuthAccountConfigured: Boolean(readAuthAccount),
  sendAuthAccountConfigured: Boolean(sendAuthAccount),
  wrapperExecutable: existsSync(wrapper),
  authAccountMatchesMailbox: Boolean(
    account &&
      readAuthAccount &&
      sendAuthAccount &&
      account === readAuthAccount &&
      account === sendAuthAccount,
  ),
  readAuthAccountMatchesMailbox: Boolean(account && readAuthAccount && account === readAuthAccount),
  sendAuthAccountMatchesMailbox: Boolean(account && sendAuthAccount && account === sendAuthAccount),
  delegatedMailboxReadConfigured: delegatedMailboxRead,
  authAccountHasGmail: false,
  authAccountCanRead: false,
  authAccountCanSend: false,
  authAccountCanManageSendAs: false,
  readAuthAccountHasGmail: false,
  readAuthAccountCanRead: false,
  sendAuthAccountHasGmail: false,
  sendAuthAccountCanSend: false,
  sendAuthAccountCanManageSendAs: false,
  sourceReadConfigured: false,
  sendAsConfigured: false,
}
const details = {
  account,
  authAccount: readAuthAccount === sendAuthAccount ? readAuthAccount : '',
  readAuthAccount,
  sendAuthAccount,
  authCandidates: [],
  wrapper,
  sendAs: null,
}
const failures = []

if (!checks.accountConfigured) failures.push('WORKSPACE_EMAIL_ACCOUNT is missing.')
if (!checks.readAuthAccountConfigured) failures.push('WORKSPACE_EMAIL_READ_GOG_ACCOUNT is missing.')
if (!checks.sendAuthAccountConfigured) failures.push('WORKSPACE_EMAIL_SEND_GOG_ACCOUNT is missing.')
if (!checks.wrapperExecutable) failures.push(`GOG wrapper is unavailable: ${wrapper}`)

if (checks.wrapperExecutable && checks.authAccountConfigured) {
  try {
    const authPayload = runGog(['--json', '--no-input', 'auth', 'list'])
    const authAccounts = authAccountsFromOutput(authPayload)
    details.authCandidates = authAccounts.map((item) => ({
      email: cleanEmail(item.email || item.account),
      services: normalizeList(item.services),
      canRead: gmailScopesSupportRead(item.scopes),
      canSend: gmailScopesSupportSend(item.scopes),
      canManageSendAs: gmailScopesSupportSendAsManagement(item.scopes),
    }))
    const readAuthRecord = authAccounts.find(
      (item) => cleanEmail(item.email || item.account) === readAuthAccount,
    )
    const sendAuthRecord = authAccounts.find(
      (item) => cleanEmail(item.email || item.account) === sendAuthAccount,
    )
    const readServices = normalizeList(readAuthRecord?.services)
    const sendServices = normalizeList(sendAuthRecord?.services)
    checks.readAuthAccountHasGmail = readServices.includes('gmail')
    checks.readAuthAccountCanRead = gmailScopesSupportRead(readAuthRecord?.scopes)
    checks.sendAuthAccountHasGmail = sendServices.includes('gmail')
    checks.sendAuthAccountCanSend = gmailScopesSupportSend(sendAuthRecord?.scopes)
    checks.sendAuthAccountCanManageSendAs = gmailScopesSupportSendAsManagement(sendAuthRecord?.scopes)
    checks.authAccountHasGmail = checks.readAuthAccountHasGmail || checks.sendAuthAccountHasGmail
    checks.authAccountCanRead = checks.readAuthAccountCanRead
    checks.authAccountCanSend = checks.sendAuthAccountCanSend
    checks.authAccountCanManageSendAs = checks.sendAuthAccountCanManageSendAs
    checks.sourceReadConfigured =
      checks.accountConfigured &&
      checks.readAuthAccountConfigured &&
      checks.wrapperExecutable &&
      checks.readAuthAccountHasGmail &&
      checks.readAuthAccountCanRead &&
      (checks.readAuthAccountMatchesMailbox || checks.delegatedMailboxReadConfigured)
  } catch (error) {
    failures.push(`GOG auth list failed: ${safeError(error)}`)
  }
}

if (checks.wrapperExecutable && checks.sendAuthAccountConfigured && checks.accountConfigured) {
  if (account === sendAuthAccount) {
    checks.sendAsConfigured = checks.sendAuthAccountHasGmail && checks.sendAuthAccountCanSend
    details.sendAs = {
      sendAsEmail: account,
      verificationStatus: 'primary-auth-account',
    }
  } else if (checks.sendAuthAccountHasGmail) {
    try {
      const sendAsPayload = runGog([
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
      const sendAs = workspaceEmailSendAsListFromOutput(sendAsPayload).find((item) => {
        const sendAsEmail = cleanEmail(item.sendAsEmail || item.email || item.address || item.value)
        return sendAsEmail === account
      })
      const status = safeLeadText(
        sendAs?.verificationStatus || sendAs?.verification_status || '',
      ).toLowerCase()
      checks.sendAsConfigured = Boolean(sendAs) && (!status || ['accepted', 'verified'].includes(status))
      details.sendAs = sendAs
        ? {
            displayName: sendAs.displayName || '',
            sendAsEmail: sendAs.sendAsEmail || sendAs.email || '',
            verificationStatus: status || 'not-reported',
          }
        : null
    } catch (error) {
      failures.push(`Gmail send-as list failed: ${safeError(error)}`)
    }
  }
}

if (!checks.readAuthAccountHasGmail) failures.push(`${readAuthAccount || 'read auth account'} is not stored with Gmail auth.`)
if (!checks.readAuthAccountCanRead) {
  failures.push(`${readAuthAccount || 'read auth account'} is missing Gmail read scope for source sync.`)
}
if (
  checks.readAuthAccountCanRead &&
  !checks.readAuthAccountMatchesMailbox &&
  !checks.delegatedMailboxReadConfigured
) {
  failures.push(`${readAuthAccount || 'read auth account'} has Gmail read scope, but delegated read access to ${account || 'workspace mailbox'} is not configured or proven.`)
}
if (
  !checks.sendAuthAccountHasGmail &&
  sendAuthAccount !== readAuthAccount
) {
  failures.push(`${sendAuthAccount || 'send auth account'} is not stored with Gmail auth.`)
}
if (!checks.sendAuthAccountCanSend) {
  failures.push(`${sendAuthAccount || 'send auth account'} is missing Gmail send/compose scope.`)
}
if (!checks.sendAsConfigured) {
  failures.push(`${account || 'workspace mailbox'} is not an accepted send-as identity for ${sendAuthAccount || 'send auth account'}.`)
  if (account !== sendAuthAccount && !checks.sendAuthAccountCanManageSendAs) {
    failures.push(`${sendAuthAccount || 'send auth account'} is missing Gmail settings scope to create or verify the ${account || 'workspace mailbox'} send-as identity.`)
  }
}

const nextActions = []
if (!checks.sourceReadConfigured) {
  nextActions.push(
    'For source-only email intake, authorize WORKSPACE_EMAIL_READ_GOG_ACCOUNT with readonly/modify scope and prove it can read the workspace mailbox.',
  )
  if (readAuthAccount !== account) {
    nextActions.push(
      'When WORKSPACE_EMAIL_READ_GOG_ACCOUNT differs from WORKSPACE_EMAIL_ACCOUNT, set WORKSPACE_EMAIL_GOG_ACCOUNT_READS_MAILBOX=true only after verifying that read account actually sees mailbox messages through delegation, routing, or a broker.',
    )
  }
}
if (!checks.sendAuthAccountCanSend) {
  nextActions.push(
    'For email replies, authorize WORKSPACE_EMAIL_SEND_GOG_ACCOUNT with compose/send scope.',
  )
}
if (!checks.sendAsConfigured) {
  nextActions.push(
    'If WORKSPACE_EMAIL_SEND_GOG_ACCOUNT differs from WORKSPACE_EMAIL_ACCOUNT, add and verify WORKSPACE_EMAIL_ACCOUNT as a Gmail send-as alias on that send account; the send account needs gmail.settings.basic/sharing or full mail scope to manage that alias.',
  )
}
if (failures.length) {
  nextActions.push('Rerun npm run qa:workspace-email before enabling Workspace email replies or sync apply in production.')
}

const result = {
  ok: failures.length === 0,
  schemaVersion: 'speak.workspace-email-check.v1',
  checks,
  details,
  failures,
  nextActions,
}

console.log(JSON.stringify(result, null, 2))
if (!result.ok) process.exitCode = 1

function argValue(name) {
  const index = process.argv.indexOf(name)
  if (index >= 0) return process.argv[index + 1] || ''
  const prefix = `${name}=`
  const item = process.argv.find((value) => value.startsWith(prefix))
  return item ? item.slice(prefix.length) : ''
}

function boundedTimeout(value) {
  return Math.max(
    1000,
    Math.min(60_000, Number(value) || numberEnv('WORKSPACE_EMAIL_AUTH_CHECK_TIMEOUT_MS', 60_000)),
  )
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

function gmailScopesSupportRead(scopes) {
  return normalizeList(scopes).some(
    (scope) =>
      scope === 'https://mail.google.com/' ||
      scope.endsWith('/auth/gmail.readonly') ||
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

function truthyEnv(name) {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env[name] || '').trim().toLowerCase())
}

function safeError(error) {
  return safeLeadText(error?.stderr || error?.message || error).slice(0, 300)
}
