import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))
const scripts = packageJson.scripts || {}

const dryRunApplyPairs = [
  {
    base: 'backfill:communication-threads',
    apply: 'backfill:communication-threads:apply',
    file: 'scripts/backfill-communication-threads.mjs',
    required: ['recordCommunicationCallSummary', 'if (apply)', 'dry-run'],
  },
  {
    base: 'backfill:transcript-emotions',
    apply: 'backfill:transcript-emotions:apply',
    file: 'scripts/backfill-transcript-emotions.mjs',
    required: [
      'Hume-only maintenance utility',
      'if (apply)',
      'isHumeBackfillCandidate',
      'skippedInworld',
    ],
  },
  {
    base: 'sync:workspace-email',
    apply: 'sync:workspace-email:apply',
    file: 'scripts/sync-workspace-email.mjs',
    required: ['if (!apply)', "method: 'POST'", 'allowAutomation = args.has'],
    forbiddenApplyCommand: ['--allow-automation'],
  },
  {
    base: 'repair:workspace-email-sendas',
    apply: 'repair:workspace-email-sendas:apply',
    file: 'scripts/repair-workspace-email-sendas.mjs',
    required: ['mode: apply ? ', 'readyToCreate', 'Dry-run only'],
  },
  {
    base: 'repair:workspace-email-thread-identity',
    apply: 'repair:workspace-email-thread-identity:apply',
    file: 'scripts/repair-workspace-email-thread-identity.mjs',
    required: ['repairWorkspaceEmailMailboxThreadIdentity', 'apply,', 'Dry-run only'],
  },
  {
    base: 'repair:communication-source-dedup',
    apply: 'repair:communication-source-dedup:apply',
    file: 'scripts/repair-communication-source-dedup.mjs',
    required: ['repairDuplicateCommunicationSourceMessages', '{ apply }', 'Dry-run only'],
  },
  {
    base: 'repair:default-off-inbound-calls',
    apply: 'repair:default-off-inbound-calls:apply',
    file: 'scripts/repair-default-off-inbound-calls.mjs',
    required: ['repairDefaultOffInboundCallMessages', '{ apply }', 'Dry-run only'],
  },
]

const oauthHelpers = [
  {
    name: 'repair:workspace-email-sendas:auth-url',
    file: 'scripts/complete-workspace-email-sendas-auth.mjs',
    requiredCommand: ['--step=1'],
    forbiddenCommand: ['--apply', '--auth-url'],
    requiredSource: ['requiresUserAction', 'completionCommand'],
  },
  {
    name: 'repair:workspace-email-sendas:auth-complete',
    file: 'scripts/complete-workspace-email-sendas-auth.mjs',
    requiredCommand: ['--step=2'],
    forbiddenCommand: ['--apply', '--auth-url='],
    requiredSource: ['--auth-url is required for step 2.', "'--apply'", 'runNodeJson'],
  },
]

const failures = []
const checked = []
const syntaxChecked = new Set()

for (const item of dryRunApplyPairs) {
  const baseCommand = scripts[item.base] || ''
  const applyCommand = scripts[item.apply] || ''
  const source = readScript(item.file)

  requireCommand(item.base, baseCommand, item.file)
  requireCommand(item.apply, applyCommand, item.file)
  if (baseCommand.includes('--apply')) {
    failures.push(`${item.base} must not include --apply.`)
  }
  if (!applyCommand.includes('--apply')) {
    failures.push(`${item.apply} must include --apply.`)
  }
  for (const forbidden of item.forbiddenApplyCommand || []) {
    if (applyCommand.includes(forbidden)) {
      failures.push(`${item.apply} must not include ${forbidden}; keep that as a separate explicit operator flag.`)
    }
  }
  requireSource(item.file, source, [
    '--apply',
    ...item.required,
  ])
  checkSyntax(item.file)
  checked.push({
    script: item.base,
    applyScript: item.apply,
    file: item.file,
    mode: 'dry-run-apply-pair',
  })
}

for (const item of oauthHelpers) {
  const command = scripts[item.name] || ''
  const source = readScript(item.file)
  requireCommand(item.name, command, item.file)
  requireCommandSnippets(item.name, command, item.requiredCommand || [])
  for (const forbidden of item.forbiddenCommand || []) {
    if (command.includes(forbidden)) {
      failures.push(`${item.name} package command must not include ${forbidden}.`)
    }
  }
  requireSource(item.file, source, item.requiredSource || [])
  checkSyntax(item.file)
  checked.push({
    script: item.name,
    file: item.file,
    mode: 'oauth-helper',
  })
}

checkLegacyCampaignRunner()

const payload = {
  ok: failures.length === 0,
  schemaVersion: 'speak.maintenance-script-safety.v1',
  checked,
  failures,
}

console.log(JSON.stringify(payload, null, 2))
if (!payload.ok) process.exit(1)

function requireCommand(name, command, file) {
  if (!command) {
    failures.push(`Missing package script ${name}.`)
    return
  }
  if (!command.includes(file)) {
    failures.push(`${name} must invoke ${file}.`)
  }
}

function requireCommandSnippets(name, command, snippets) {
  for (const snippet of snippets) {
    if (!command.includes(snippet)) {
      failures.push(`${name} command must include ${snippet}.`)
    }
  }
}

function requireSource(file, source, snippets) {
  for (const snippet of snippets) {
    if (!source.includes(snippet)) {
      failures.push(`${file} must include ${snippet}.`)
    }
  }
}

function readScript(file) {
  if (!existsSync(file)) {
    failures.push(`Missing script file ${file}.`)
    return ''
  }
  return readFileSync(file, 'utf8')
}

function checkSyntax(file) {
  if (syntaxChecked.has(file)) return
  syntaxChecked.add(file)
  if (!existsSync(file)) return
  const result = spawnSync(process.execPath, ['--check', file], {
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    failures.push(`${file} failed node --check: ${String(result.stderr || result.stdout).trim()}`)
  }
}

function checkLegacyCampaignRunner() {
  const file = 'server/campaign-runner.mjs'
  checkSyntax(file)
  const result = spawnSync(process.execPath, [file, '--check-leads'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    failures.push(`${file} --check-leads failed: ${String(result.stderr || result.stdout).trim()}`)
  }
  checked.push({
    script: 'server/campaign-runner.mjs --check-leads',
    file,
    mode: 'legacy-manual-runner',
  })
}
