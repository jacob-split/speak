import { readFileSync } from 'node:fs'

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))
const fullAuditSource = readFileSync('scripts/check-full-e2e-audit.mjs', 'utf8')
const readme = readFileSync('README.md', 'utf8')
const docsIndex = readFileSync('docs/index.md', 'utf8')
const executableFullAuditSource = stripRecordSkipCalls(fullAuditSource)
const scripts = packageJson.scripts || {}

const requiredPrefixes = [
  'agent:',
  'audit:',
  'backfill:',
  'calltools:',
  'docs:',
  'qa:',
  'repair:',
  'sync:',
]
const requiredNames = new Set(['build:speak', 'lint'])

const classifications = {
  'agent:acp': {
    category: 'agent-manifest-emitter',
    coveredBy: ['qa:agent-adapters', 'qa:agent-readiness'],
    reason: 'Emitter output is validated through agent adapter/readiness checks.',
  },
  'agent:app': {
    category: 'agent-manifest-emitter',
    coveredBy: ['qa:mcp-app', 'qa:agent-adapters'],
    reason: 'ChatGPT app manifest is validated through MCP and adapter checks.',
  },
  'agent:contract': {
    category: 'agent-manifest-emitter',
    coveredBy: ['qa:agent-readiness', 'qa:action-invoke'],
    reason: 'Contract output is validated through readiness and action-invoke checks.',
  },
  'agent:genui': {
    category: 'agent-manifest-emitter',
    coveredBy: ['qa:agent-adapters', 'qa:widget-bridge'],
    reason: 'Generative UI output is validated through adapter and widget bridge checks.',
  },
  'agent:openapi': {
    category: 'agent-manifest-emitter',
    coveredBy: ['qa:agent-adapters', 'qa:action-invoke'],
    reason: 'OpenAPI/action contract output is validated through adapter and invocation checks.',
  },
  'agent:readiness': {
    category: 'agent-manifest-emitter',
    coveredBy: ['qa:agent-readiness'],
    reason: 'Readable readiness emitter is covered by the strict readiness verifier.',
  },
  'agent:ui-kit': {
    category: 'agent-manifest-emitter',
    coveredBy: ['qa:ui-adapter-kit'],
    reason: 'UI kit emitter is covered by the adapter-kit verifier.',
  },
  'agent:ui-snapshot': {
    category: 'agent-manifest-emitter',
    coveredBy: ['qa:ui-snapshot'],
    reason: 'Snapshot emitter is covered by the UI snapshot verifier.',
  },
  'backfill:communication-threads': {
    category: 'maintenance-dry-run',
    coveredBy: ['qa:communication-threads', 'qa:transcript-rendering'],
    reason: 'Backfill is an operator dry-run utility; automatic full-audit writes are not allowed.',
  },
  'backfill:communication-threads:apply': {
    category: 'maintenance-apply',
    coveredBy: ['backfill:communication-threads'],
    reason: 'Apply variant mutates workspace data and must remain explicit operator action.',
  },
  'backfill:transcript-emotions': {
    category: 'maintenance-dry-run',
    coveredBy: ['qa:transcript-emotions'],
    reason: 'Hume-only transcript emotion backfill is operator maintenance; full audit verifies provider gating and dry-run safety.',
  },
  'backfill:transcript-emotions:apply': {
    category: 'maintenance-apply',
    coveredBy: ['backfill:transcript-emotions'],
    reason: 'Apply variant mutates call-log JSONL files and must remain explicit operator action.',
  },
  'calltools:agent-session': {
    category: 'setup-helper',
    coveredBy: ['qa:calltools-readiness', 'qa:calltools-phone-agent'],
    reason: 'Backend AgentStatus setup helper is covered by CallTools readiness and phone-agent contract checks.',
  },
  'audit:calltools-recording-rhythm': {
    category: 'provider-behavior-audit',
    coveredBy: ['audit:calltools-recording-transcript', 'qa:production-calltools-s-tier'],
    reason: 'Rhythm audit is read-only provider behavior profiling; full audit enforces CallTools recording comparison through recording-derived review.',
  },
  'calltools:gateway': {
    category: 'long-running-runtime',
    coveredBy: ['qa:calltools-media-gateway', 'qa:calltools-readiness'],
    reason: 'Gateway launcher is long-running; full audit validates readiness/protocol instead.',
  },
  'calltools:transcribe-recording': {
    category: 'recording-derived-utility',
    coveredBy: ['qa:production-calltools-s-tier', 'audit:calltools-recording-transcript'],
    reason: 'Speak-generated recording-derived transcripts require CallTools recording audio and are invoked by recording-derived review when supplied.',
  },
  'docs:screenshots': {
    category: 'docs-artifact-emitter',
    coveredBy: ['qa:brand-marketing'],
    reason: 'Screenshot generation mutates docs assets; full audit validates the checked-in manifest, hashes, references, and published bytes through brand-marketing.',
  },
  'docs:check-screenshots': {
    category: 'docs-artifact-check',
    coveredBy: ['qa:brand-marketing'],
    reason: 'The screenshot checker is embedded in brand-marketing, which also verifies published screenshot links and asset byte parity.',
  },
  'qa:browser': {
    category: 'composite-alias',
    coveredBy: ['qa:browser:check'],
    reason: 'Full audit runs browser rendering check directly after controlling server startup.',
  },
  'qa:browser:install': {
    category: 'dependency-installer',
    coveredBy: ['qa:browser:check'],
    reason: 'Browser install is dependency setup, not a recurring full-audit action.',
  },
  'qa:build-base': {
    category: 'build-subcheck',
    coveredBy: ['build:speak'],
    reason: 'build:speak runs the base-path build guard after Vite build.',
  },
  'qa:full-audit': {
    category: 'self-runner',
    coveredBy: ['qa:full-audit-coverage'],
    reason: 'The full audit cannot recursively run itself.',
  },
  'qa:usb-c-agent-tier': {
    category: 'legacy-alias',
    coveredBy: ['qa:speak-agent-tier'],
    reason: 'Legacy command name retained for compatibility; full audit runs the canonical Speak agent-tier gate.',
  },
  'repair:communication-source-dedup': {
    category: 'maintenance-dry-run',
    coveredBy: ['qa:communication-threads', 'qa:transcript-rendering'],
    reason: 'Repair dry-run is operator maintenance and must not mutate during full audit.',
  },
  'repair:communication-source-dedup:apply': {
    category: 'maintenance-apply',
    coveredBy: ['repair:communication-source-dedup'],
    reason: 'Apply variant mutates workspace communication records and must remain explicit.',
  },
  'repair:default-off-inbound-calls': {
    category: 'maintenance-dry-run',
    coveredBy: ['qa:telnyx-source-routing'],
    reason: 'Repair dry-run is operator maintenance for inbound-call defaults.',
  },
  'repair:default-off-inbound-calls:apply': {
    category: 'maintenance-apply',
    coveredBy: ['repair:default-off-inbound-calls'],
    reason: 'Apply variant mutates workspace configuration and must remain explicit.',
  },
  'repair:workspace-email-sendas': {
    category: 'maintenance-dry-run',
    coveredBy: ['qa:workspace-email'],
    reason: 'Send-as repair is operator maintenance; full audit verifies configured state.',
  },
  'repair:workspace-email-sendas:apply': {
    category: 'maintenance-apply',
    coveredBy: ['repair:workspace-email-sendas'],
    reason: 'Apply variant changes Gmail/Workspace send-as state and must remain explicit.',
  },
  'repair:workspace-email-sendas:auth-complete': {
    category: 'oauth-helper',
    coveredBy: ['qa:workspace-email'],
    reason: 'OAuth completion is an interactive setup helper, not an automated full-audit step.',
  },
  'repair:workspace-email-sendas:auth-url': {
    category: 'oauth-helper',
    coveredBy: ['qa:workspace-email'],
    reason: 'OAuth URL generation is an interactive setup helper, not an automated full-audit step.',
  },
  'repair:workspace-email-thread-identity': {
    category: 'maintenance-dry-run',
    coveredBy: ['qa:workspace-email-source', 'qa:communication-threads'],
    reason: 'Repair dry-run is operator maintenance for email identity links.',
  },
  'repair:workspace-email-thread-identity:apply': {
    category: 'maintenance-apply',
    coveredBy: ['repair:workspace-email-thread-identity'],
    reason: 'Apply variant mutates workspace email thread identity data and must remain explicit.',
  },
  'sync:workspace-email': {
    category: 'maintenance-dry-run',
    coveredBy: ['qa:workspace-email-source', 'qa:communication-threads'],
    reason: 'Email sync is bounded operator import; full audit verifies source access and normalization.',
  },
  'sync:workspace-email:apply': {
    category: 'maintenance-apply',
    coveredBy: ['sync:workspace-email'],
    reason: 'Apply variant writes workspace threads/messages and must remain explicit.',
  },
}

const scriptNames = Object.keys(scripts).sort()
const relevant = scriptNames.filter((name) =>
  requiredNames.has(name) || requiredPrefixes.some((prefix) => name.startsWith(prefix)),
)

const direct = []
const classified = []
const failures = []

for (const name of relevant) {
  if (fullAuditInvokes(name)) {
    direct.push(name)
    continue
  }
  const classification = classifications[name]
  if (classification) {
    classified.push({ name, ...classification })
    continue
  }
  failures.push(`Package script ${name} is neither invoked by qa:full-audit nor classified as an intentional exception.`)
}

for (const [name, classification] of Object.entries(classifications)) {
  if (!scripts[name]) {
    failures.push(`Classification references missing package script ${name}.`)
  }
  for (const coveredBy of classification.coveredBy || []) {
    if (!scripts[coveredBy]) {
      failures.push(`Classification for ${name} references missing coveredBy script ${coveredBy}.`)
    }
  }
}

const directSet = new Set(direct)
for (const { name } of classified) {
  const unresolved = (classifications[name]?.coveredBy || []).filter(
    (coveredBy) => !coverageResolvesToFullAudit(coveredBy, [name]),
  )
  if (unresolved.length) {
    failures.push(
      `Classification for ${name} references coveredBy script(s) that do not resolve to a qa:full-audit-invoked check: ${unresolved.join(', ')}.`,
    )
  }
}

if (
  /The default `qa:full-audit` run is non-live[\s\S]*production provider\s+routing[\s\S]*explicit gated\s+skips/.test(readme) === false
) {
  failures.push('README must describe production provider routing as a gated skip in default qa:full-audit mode.')
}
failures.push(...verifyDocumentedDirectGates())

const payload = {
  ok: failures.length === 0,
  schemaVersion: 'speak.full-audit-coverage.v1',
  relevantCount: relevant.length,
  directCount: direct.length,
  classifiedCount: classified.length,
  direct,
  classified,
  failures,
}

console.log(JSON.stringify(payload, null, 2))

if (!payload.ok) process.exit(1)

function fullAuditInvokes(name) {
  const quoted = escapeRegExp(name)
  return new RegExp(`['"\`]${quoted}['"\`]`).test(executableFullAuditSource)
}

function coverageResolvesToFullAudit(name, stack = []) {
  if (directSet.has(name)) return true
  if (stack.includes(name)) return false
  const classification = classifications[name]
  if (!classification) return false
  return (classification.coveredBy || []).some((coveredBy) =>
    coverageResolvesToFullAudit(coveredBy, [...stack, name]),
  )
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function stripRecordSkipCalls(source) {
  let output = ''
  let index = 0
  while (index < source.length) {
    const start = source.indexOf('recordSkip(', index)
    if (start < 0) {
      output += source.slice(index)
      break
    }
    output += source.slice(index, start)
    let cursor = start + 'recordSkip('.length
    let depth = 1
    let quote = ''
    let escaped = false
    while (cursor < source.length && depth > 0) {
      const char = source[cursor]
      if (quote) {
        if (escaped) {
          escaped = false
        } else if (char === '\\') {
          escaped = true
        } else if (char === quote) {
          quote = ''
        }
        cursor += 1
        continue
      }
      if (char === '"' || char === "'" || char === '`') {
        quote = char
      } else if (char === '(') {
        depth += 1
      } else if (char === ')') {
        depth -= 1
      }
      cursor += 1
    }
    index = cursor
  }
  return output
}

function verifyDocumentedDirectGates() {
  const localFailures = []
  const sections = [
    {
      file: 'README.md',
      body: readme,
      start: 'Full-audit direct gates are part of the public continuity contract and are',
      end: '`npm run qa:build-base`',
    },
    {
      file: 'docs/index.md',
      body: docsIndex,
      start: '- Full-audit direct gates, checked against',
      end: '- Build-base subcheck:',
    },
  ]
  for (const { file, body, start, end } of sections) {
    const section = boundedSection(body, start, end)
    if (!section) {
      localFailures.push(`${file}: missing Full-audit direct gates section.`)
      continue
    }
    for (const name of direct) {
      const token = `npm run ${name}`
      if (!section.includes(token)) {
        localFailures.push(`${file}: Full-audit direct gates section missing ${token}.`)
      }
    }
    const documented = [...section.matchAll(/npm run ([a-z0-9:-]+)/g)].map((match) => match[1])
    for (const name of documented) {
      if (!directSet.has(name)) {
        localFailures.push(`${file}: Full-audit direct gates section lists ${name}, but qa:full-audit does not directly invoke it.`)
      }
    }
  }
  return localFailures
}

function boundedSection(body, start, end) {
  const startIndex = body.indexOf(start)
  if (startIndex < 0) return ''
  const endIndex = body.indexOf(end, startIndex + start.length)
  if (endIndex < 0) return body.slice(startIndex)
  return body.slice(startIndex, endIndex)
}
