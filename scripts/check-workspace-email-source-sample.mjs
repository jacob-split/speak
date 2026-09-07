import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_WORKSPACE_EMAIL_SYNC_LIMIT,
  fetchWorkspaceEmailSyncPayloads,
  workspaceEmailPayloadsFromGogOutput,
  workspaceEmailSourceProbeQuery,
} from '../server/workspace-email-sync.mjs'
import {
  cleanEmail,
  getWorkspaceEmailAccount,
  getWorkspaceEmailReadGogAccount,
  numberEnv,
  safeLeadText,
} from '../server/runtime-config.mjs'

const account = cleanEmail(argValue('--account') || getWorkspaceEmailAccount())
const authAccount = cleanEmail(
  argValue('--read-auth-account') ||
    argValue('--auth-account') ||
    getWorkspaceEmailReadGogAccount(),
)
const window = safeLeadText(argValue('--window') || process.env.WORKSPACE_EMAIL_SOURCE_SAMPLE_WINDOW || '90d')
const query = argValue('--query') || workspaceEmailSourceProbeQuery(account, { window })
const limit = boundedNumber(
  argValue('--limit') || process.env.WORKSPACE_EMAIL_SOURCE_SAMPLE_LIMIT,
  Math.min(DEFAULT_WORKSPACE_EMAIL_SYNC_LIMIT, 25),
  100,
)
const timeoutMs = boundedNumber(
  argValue('--timeout-ms') || process.env.WORKSPACE_EMAIL_SYNC_TIMEOUT_MS,
  numberEnv('WORKSPACE_EMAIL_SYNC_TIMEOUT_MS', 60_000),
  120_000,
)
const allowEmpty = process.argv.includes('--allow-empty')
const failures = []
const warnings = []

function makeTempDir(prefix) {
  fs.mkdirSync('.tmp', { recursive: true })
  return fs.mkdtempSync(path.join('.tmp', `${prefix}-`))
}

const nativeSource = await verifyNativeSourceNormalization(account)
failures.push(...nativeSource.failures)
const wrapperShape = verifyGogWrapperShapeNormalization(account)
failures.push(...wrapperShape.failures)
let payloads = []
let readSucceeded = false

try {
  payloads = await fetchWorkspaceEmailSyncPayloads({
    account,
    authAccount,
    limit,
    query,
    timeoutMs,
  })
  readSucceeded = true
} catch (error) {
  failures.push(`Workspace email source sample read failed: ${safeError(error)}`)
}

const inbound = payloads.filter((payload) => payload.direction === 'inbound').length
const outbound = payloads.filter((payload) => payload.direction === 'outbound').length
const withBody = payloads.filter((payload) => payload.body).length
const withThread = payloads.filter((payload) => payload.threadId).length

if (!account) failures.push('WORKSPACE_EMAIL_ACCOUNT is missing.')
if (!authAccount) failures.push('WORKSPACE_EMAIL_READ_GOG_ACCOUNT is missing.')
if (readSucceeded && payloads.length === 0 && !allowEmpty) {
  failures.push(
    `No bounded Gmail source sample involving ${account || 'the workspace mailbox'} was visible to ${authAccount || 'the auth account'}.`,
  )
}
if (readSucceeded && payloads.length > 0 && inbound === 0) {
  warnings.push(
    `No inbound Workspace email sample involving ${account || 'the workspace mailbox'} was visible in this bounded read; native inbound normalization passed, but live received-mail sampling is still unproven.`,
  )
}
if (readSucceeded && payloads.length > 0 && outbound === 0) {
  warnings.push(
    `No sent Workspace email sample involving ${account || 'the workspace mailbox'} was visible in this bounded read; native sent normalization passed, but live sent-mail sampling is still unproven.`,
  )
}

const result = {
  ok: failures.length === 0,
  schemaVersion: 'speak.workspace-email-source-sample-check.v1',
  checks: {
    accountConfigured: Boolean(account),
    authAccountConfigured: Boolean(authAccount),
    readSucceeded,
    observedWorkspaceParticipantSample: payloads.length > 0,
    observedInbound: inbound > 0,
    observedOutbound: outbound > 0,
    normalizedBodies: withBody,
    normalizedExternalThreads: withThread,
    nativeInboundEmailNormalized: nativeSource.checks.inboundEmailNormalized,
    nativeSentEmailNormalized: nativeSource.checks.sentEmailNormalized,
    nativeEmailThreadReconciled: nativeSource.checks.emailThreadReconciled,
    gogInboxMissingToNormalized: wrapperShape.checks.inboxMissingToNormalized,
  },
  details: {
    account,
    authAccount,
    query,
    limit,
    returned: payloads.length,
    inbound,
    outbound,
    nativeSource: nativeSource.details,
    wrapperShape: wrapperShape.details,
  },
  failures,
  warnings,
  nextActions: failures.length
    ? [
        'Authorize or configure WORKSPACE_EMAIL_READ_GOG_ACCOUNT as a Gmail/GOG auth account that can read the workspace mailbox.',
        'If the auth account differs from WORKSPACE_EMAIL_ACCOUNT, prove mailbox read access through this sample check before setting WORKSPACE_EMAIL_GOG_ACCOUNT_READS_MAILBOX=true.',
        'Run npm run qa:workspace-email-source on the production host before applying Workspace email sync.',
      ]
    : [],
}

console.log(JSON.stringify(result, null, 2))
if (!result.ok) process.exitCode = 1

function argValue(name) {
  const prefix = `${name}=`
  return process.argv
    .slice(2)
    .find((arg) => arg.startsWith(prefix))
    ?.slice(prefix.length)
}

function verifyGogWrapperShapeNormalization(account) {
  const workspaceAccount = account || 'operator@example.com'
  const payloads = workspaceEmailPayloadsFromGogOutput(
    {
      messages: [
        {
          id: 'gmail-wrapper-inbox-missing-to',
          threadId: 'gmail-wrapper-thread',
          from: 'Apps <mailbox@example.com>',
          subject: 'Speak QA inbound source probe',
          body: 'Speak automated QA inbound source probe.',
          labels: ['INBOX', 'UNREAD'],
          date: '2026-07-04 03:06',
        },
      ],
    },
    { account: workspaceAccount },
  )
  const first = payloads[0]
  const inboxMissingToNormalized =
    payloads.length === 1 &&
    first.direction === 'inbound' &&
    first.toEmails.includes(workspaceAccount) &&
    first.toEmail === workspaceAccount &&
    first.fromEmail === 'mailbox@example.com'
  return {
    checks: {
      inboxMissingToNormalized,
    },
    details: {
      payloadCount: payloads.length,
      firstDirection: first?.direction || '',
      firstToEmail: first?.toEmail || '',
    },
    failures: inboxMissingToNormalized
      ? []
      : ['GOG inbox messages without recipient headers must infer the workspace account as recipient.'],
  }
}

function boundedNumber(value, fallback, max) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.min(max, Math.floor(number))
}

function safeError(error) {
  return safeLeadText(error?.stderr || error?.message || error).slice(0, 500)
}

async function verifyNativeSourceNormalization(account) {
  const tempDataDir = makeTempDir('check-workspace-email-source-normalizer')
  const previousDataDir = process.env.SPEAK_WORKSPACE_DATA_DIR
  process.env.SPEAK_WORKSPACE_DATA_DIR = tempDataDir

  const localFailures = []
  const checks = {
    inboundEmailNormalized: false,
    sentEmailNormalized: false,
    emailThreadReconciled: false,
  }
  const details = {
    tempWorkspace: tempDataDir,
    channels: [],
    messageCount: 0,
    proofActions: [],
  }
  const workspaceAccount = account || 'operator@example.com'

  try {
    const normalizer = await import(`../server/workspace-email-normalizer.mjs?check=${Date.now()}`)
    const store = await import(`../server/workspace-store.mjs?check=${Date.now()}`)
    const lead = await store.createWorkspaceLead({
      id: 'lead-workspace-email-source-check',
      name: 'Casey Contact',
      company: 'Casey Coffee',
      email: 'casey@example.com',
    })

    const inbound = normalizer.buildWorkspaceEmailCommunicationEvent(
      {
        id: 'gmail-inbound-source-check',
        threadId: 'gmail-thread-source-check',
        from: 'Casey Contact <casey@example.com>',
        to: `Operator <${workspaceAccount}>`,
        subject: 'Quote',
        body: 'Can you send that over?',
        labels: ['INBOX'],
        date: '2026-07-02T16:00:00.000Z',
      },
      { allowAutomation: false, source: 'workspace_email_source_check' },
    )
    const sent = normalizer.buildWorkspaceEmailCommunicationEvent(
      {
        id: 'gmail-sent-source-check',
        threadId: 'gmail-thread-source-check',
        from: `Operator <${workspaceAccount}>`,
        to: [
          'Casey Contact <casey@example.com>',
          'Jordan Contact <jordan@example.com>',
        ],
        subject: 'Re: Quote',
        body: 'Here are the details.',
        labels: ['SENT'],
        date: '2026-07-02T16:01:00.000Z',
      },
      { allowAutomation: false, source: 'workspace_email_source_check' },
    )

    if (!inbound?.communicationEvent) {
      localFailures.push('Native Workspace inbound email payload did not normalize.')
    }
    if (!sent?.communicationEvent) {
      localFailures.push('Native Workspace sent email payload did not normalize.')
    }

    for (const source of [inbound, sent]) {
      if (!source?.communicationEvent) continue
      await store.recordCommunicationEvent(source.communicationEvent)
    }

    const threads = await store.listCommunicationThreads({
      contactId: lead.id,
      limit: 10,
    })
    const thread = threads.threads[0]
    const messages = thread
      ? await store.listCommunicationThreadMessages(thread.threadId, { limit: 10 })
      : { messages: [] }

    details.channels = thread?.channels || []
    details.messageCount = messages.messages.length
    details.proofActions = messages.messages
      .map((message) => message.proof?.automation?.reason)
      .filter(Boolean)

    checks.inboundEmailNormalized = messages.messages.some(
      (message) =>
        message.channel === 'email' &&
        message.direction === 'inbound' &&
        message.providerIds?.messageId === 'gmail-inbound-source-check' &&
        message.providerIds?.fromEmail === 'casey@example.com' &&
        message.proof?.automation?.reason === 'workspace_email_sync_record_only',
    )
    checks.sentEmailNormalized = messages.messages.some(
      (message) =>
        message.channel === 'email' &&
        message.direction === 'outbound' &&
        message.providerIds?.messageId === 'gmail-sent-source-check' &&
        message.providerIds?.toEmails?.includes('jordan@example.com') &&
        message.proof?.automation?.reason === 'sent_source_record_only',
    )
    checks.emailThreadReconciled =
      threads.threads.length === 1 &&
      thread?.contactId === lead.id &&
      details.channels.includes('email') &&
      messages.messages.length === 2

    if (!checks.inboundEmailNormalized) {
      localFailures.push('Native inbound Workspace email did not persist record-only proof.')
    }
    if (!checks.sentEmailNormalized) {
      localFailures.push('Native sent Workspace email did not persist sent-source proof.')
    }
    if (!checks.emailThreadReconciled) {
      localFailures.push('Native Workspace email source events did not reconcile into one contact thread.')
    }
  } catch (error) {
    localFailures.push(
      `Native Workspace email source normalization failed: ${
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
