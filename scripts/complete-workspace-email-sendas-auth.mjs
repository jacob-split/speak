import 'dotenv/config'
import { execFileSync, spawnSync } from 'node:child_process'
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
const authUrl = argValue('--auth-url') || argValue('--redirect-url')
const step = safeLeadText(argValue('--step') || (authUrl ? '2' : '1'))
const timeoutMs = boundedTimeout(argValue('--timeout-ms'))
const extraScopes = [
  'https://www.googleapis.com/auth/gmail.settings.basic',
  'https://www.googleapis.com/auth/gmail.settings.sharing',
].join(',')

const failures = []
if (!account) failures.push('WORKSPACE_EMAIL_ACCOUNT is missing.')
if (!sendAuthAccount) failures.push('WORKSPACE_EMAIL_SEND_GOG_ACCOUNT is missing.')
if (!existsSync(wrapper)) failures.push(`GOG wrapper is unavailable: ${wrapper}`)

let result
if (failures.length === 0 && step === '1') {
  result = runStepOne()
} else if (failures.length === 0 && step === '2') {
  result = runStepTwo()
} else if (failures.length === 0) {
  failures.push('--step must be 1 or 2.')
}

if (!result) {
  result = {
    ok: false,
    schemaVersion: 'speak.workspace-email-sendas-auth.v1',
    step,
    account,
    sendAuthAccount,
    failures,
    nextActions: [
      'Run npm run repair:workspace-email-sendas:auth-url on the production host, complete Google consent, then run npm run repair:workspace-email-sendas:auth-complete with the redirected localhost URL.',
    ],
  }
}

console.log(JSON.stringify(result, null, 2))
if (!result.ok && !result.requiresUserAction) process.exitCode = 1

function runStepOne() {
  const output = runGogAuth([
    'auth',
    'add',
    sendAuthAccount,
    '--remote',
    '--step=1',
    '--services=gmail',
    '--gmail-scope=full',
    `--extra-scopes=${extraScopes}`,
    '--force-consent',
  ])
  const consentUrl = extractAuthUrl(output)
  const localFailures = []
  if (!consentUrl) {
    localFailures.push('GOG did not return a Google consent URL.')
  }
  return {
    ok: localFailures.length === 0,
    requiresUserAction: localFailures.length === 0,
    schemaVersion: 'speak.workspace-email-sendas-auth.v1',
    step: '1',
    account,
    sendAuthAccount,
    authUrl: consentUrl || '',
    scopes: extraScopes.split(','),
    failures: localFailures,
    nextActions: localFailures.length
      ? ['Rerun the command on the production host and inspect the GOG auth output.']
      : [
          'Open authUrl, complete Google consent for the send auth account, copy the full redirected http://127.0.0.1/... URL, then run the completion command.',
        ],
    completionCommand:
      "npm run repair:workspace-email-sendas:auth-complete -- --auth-url '<redirected-localhost-url>'",
  }
}

function runStepTwo() {
  if (!authUrl) {
    return {
      ok: false,
      schemaVersion: 'speak.workspace-email-sendas-auth.v1',
      step: '2',
      account,
      sendAuthAccount,
      failures: ['--auth-url is required for step 2.'],
      nextActions: [
        'After Google consent redirects to localhost, copy the full redirected URL and pass it as --auth-url.',
      ],
    }
  }

  const authExchange = runCommand(wrapper, [
    'auth',
    'add',
    sendAuthAccount,
    '--remote',
    '--step=2',
    `--auth-url=${authUrl}`,
  ])
  const repair = runNodeJson('scripts/repair-workspace-email-sendas.mjs', [
    '--apply',
    '--account',
    account,
    '--send-auth-account',
    sendAuthAccount,
    '--wrapper',
    wrapper,
    '--display-name',
    displayName,
  ])
  const readiness = runNodeJson('scripts/check-workspace-email.mjs', [
    '--account',
    account,
    '--send-auth-account',
    sendAuthAccount,
    '--wrapper',
    wrapper,
  ])

  const localFailures = []
  if (!authExchange.ok) {
    localFailures.push(`GOG OAuth completion failed: ${safeCommandError(authExchange)}`)
  }
  if (!repair.ok) {
    localFailures.push(`Workspace send-as repair failed: ${safeCommandError(repair)}`)
  }
  if (!readiness.ok) {
    localFailures.push('Workspace email readiness still fails after auth repair.')
  }

  return {
    ok: localFailures.length === 0,
    schemaVersion: 'speak.workspace-email-sendas-auth.v1',
    step: '2',
    account,
    sendAuthAccount,
    authExchange: {
      ok: authExchange.ok,
      status: authExchange.status,
    },
    repair: compactJsonResult(repair),
    readiness: compactJsonResult(readiness),
    failures: localFailures,
    nextActions: localFailures.length
      ? [
          'Run npm run repair:workspace-email-sendas and npm run qa:workspace-email on the production host for the exact remaining failure.',
        ]
      : [],
  }
}

function runGogAuth(args) {
  return execFileSync(wrapper, args, {
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
  })
}

function runCommand(command, args) {
  const result = spawnSync(command, args, {
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    timeout: timeoutMs,
  })
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: safeLeadText(result.stdout).slice(0, 1000),
    stderr: safeLeadText(result.stderr).slice(0, 1000),
  }
}

function runNodeJson(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    timeout: timeoutMs,
  })
  return {
    ok: result.status === 0,
    status: result.status,
    json: parseJsonOutput(result.stdout),
    stdout: safeLeadText(result.stdout).slice(0, 1000),
    stderr: safeLeadText(result.stderr).slice(0, 1000),
  }
}

function extractAuthUrl(output) {
  const parsed = parseJsonOutput(output)
  const parsedUrl = firstString(
    parsed?.auth_url,
    parsed?.authUrl,
    parsed?.url,
    parsed?.result?.auth_url,
    parsed?.result?.authUrl,
    parsed?.data?.auth_url,
    parsed?.data?.authUrl,
  )
  if (parsedUrl) return parsedUrl
  const match = String(output || '').match(/https?:\/\/[^\s"'<>]+/i)
  return match?.[0] || ''
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

function compactJsonResult(result = {}) {
  const json = result.json || {}
  return {
    ok: result.ok,
    status: result.status,
    checks: json.checks || undefined,
    failures: Array.isArray(json.failures) ? json.failures.slice(0, 5) : undefined,
    nextActions: Array.isArray(json.nextActions) ? json.nextActions.slice(0, 5) : undefined,
  }
}

function safeCommandError(result = {}) {
  const jsonFailures = result.json?.failures
  if (Array.isArray(jsonFailures) && jsonFailures.length > 0) {
    return jsonFailures.join('; ').slice(0, 500)
  }
  return safeLeadText(result.stderr || result.stdout || `exit ${result.status}`).slice(0, 500)
}

function firstString(...values) {
  for (const value of values) {
    const text = safeLeadText(value)
    if (text) return text
  }
  return ''
}

function boundedTimeout(value) {
  return Math.max(
    1000,
    Math.min(120_000, Number(value) || numberEnv('WORKSPACE_EMAIL_AUTH_CHECK_TIMEOUT_MS', 60_000)),
  )
}

function argValue(name) {
  const index = process.argv.indexOf(name)
  if (index >= 0) return process.argv[index + 1] || ''
  const prefix = `${name}=`
  const item = process.argv.find((value) => value.startsWith(prefix))
  return item ? item.slice(prefix.length) : ''
}
