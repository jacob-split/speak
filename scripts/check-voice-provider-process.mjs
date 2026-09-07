import fs from 'node:fs'
import { buildSpeakAgentContract } from '../server/agent-contract.mjs'

const failures = []
const playbookPath = 'docs/voice-provider-integration.md'
const playbook = fs.readFileSync(playbookPath, 'utf8')
const readme = fs.readFileSync('README.md', 'utf8')
const docsIndex = fs.readFileSync('docs/index.md', 'utf8')
const contract = buildSpeakAgentContract({
  basePath: process.env.BASE_PATH || '/speak',
  publicBaseUrl: process.env.PUBLIC_BASE_URL || 'https://speak.example.com/speak',
})

const requiredPlaybookSections = [
  'Acceptance Standard',
  'Required Discovery',
  'Core Feature Matrix',
  'Optimization Audit',
  'Implementation Shape',
  'Intake Record Template',
  'Verification',
]

const requiredFeatureTerms = [
  'Realtime speech-to-speech',
  'Browser playground',
  'Phone call path',
  'Input audio',
  'Output audio',
  'Barge-in',
  'Turn finalization',
  'Transcript persistence',
  'Recording/audio retrieval',
  'Model catalogue',
  'Codex-auth route',
  'Voice catalogue',
  'Tools/function calls',
  'Prompt contract',
  'Context injection',
  'Live guidance/takeover',
  'Provider config sync',
  'Observability',
  'Safety boundary',
  'MCP/CLI tooling',
]

const requiredProcessTerms = [
  'SDK',
  'MCP',
  'CLI',
  'official docs',
  'guides',
  'sample rates',
  'VAD',
  'interruptions',
  'Telnyx media streams',
  'CallTools SIP/WebRTC media gateway',
  'CallTools remains a dialer/origination provider, not a voice runtime',
  'tool calling',
  'transcript events',
  'recordings',
  'webhooks',
  'optimizations',
  'production verification',
  'src/voiceConfigOptions.ts',
]

requiredPlaybookSections.forEach((section) => {
  if (!playbook.includes(`## ${section}`)) {
    failures.push(`${playbookPath} missing section ${section}`)
  }
})

requiredFeatureTerms.forEach((term) => {
  if (!playbook.includes(term)) {
    failures.push(`${playbookPath} missing core feature term ${term}`)
  }
})

requiredProcessTerms.forEach((term) => {
  if (!new RegExp(escapeRegExp(term), 'i').test(playbook)) {
    failures.push(`${playbookPath} missing process term ${term}`)
  }
})

const voiceRuntime = contract.runtime?.voiceRuntime || {}
const onboarding = voiceRuntime.providerOnboarding || {}

if (onboarding.playbook !== playbookPath) {
  failures.push('agent contract voice provider onboarding playbook path mismatch')
}

if (!readme.includes(playbookPath)) {
  failures.push('README missing voice provider integration playbook link')
}

if (!docsIndex.includes('voice-provider-integration.md')) {
  failures.push('docs index missing voice provider integration playbook link')
}

if (!Array.isArray(onboarding.requiredCoreFeatures) ||
    onboarding.requiredCoreFeatures.length < requiredFeatureTerms.length) {
  failures.push('agent contract missing required core feature inventory')
}

for (const term of onboarding.requiredCoreFeatures || []) {
  if (!includesCaseInsensitive(playbook, term)) {
    failures.push(`${playbookPath} missing generated contract core feature term ${term}`)
  }
}

if (!Array.isArray(onboarding.optimizationAudit) || onboarding.optimizationAudit.length < 8) {
  failures.push('agent contract missing provider optimization audit inventory')
}

for (const term of onboarding.optimizationAudit || []) {
  if (!includesCaseInsensitive(playbook, term)) {
    failures.push(`${playbookPath} missing generated contract optimization audit term ${term}`)
  }
}

if (!onboarding.mcpDiscoveryRule?.includes('official')) {
  failures.push('agent contract missing official MCP discovery rule')
}

if (!contract.mcpGeneration?.validationCommands?.includes('npm run qa:voice-provider-process')) {
  failures.push('agent contract validation commands missing npm run qa:voice-provider-process')
}

if (!contract.runtime?.voiceRuntime?.providers?.includes('hume') ||
    !contract.runtime?.voiceRuntime?.providers?.includes('inworld') ||
    !contract.runtime?.voiceRuntime?.providers?.includes('xai')) {
  failures.push('agent contract lost current Hume/Inworld/xAI providers')
}

if (failures.length > 0) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        failures,
        playbook: playbookPath,
      },
      null,
      2,
    ),
  )
  process.exitCode = 1
} else {
  console.log(
    JSON.stringify(
      {
        ok: true,
        playbook: playbookPath,
        coreFeatureCount: onboarding.requiredCoreFeatures.length,
        optimizationAuditCount: onboarding.optimizationAudit.length,
        providers: voiceRuntime.providers,
      },
      null,
      2,
    ),
  )
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function includesCaseInsensitive(body, term) {
  return String(body || '').toLowerCase().includes(String(term || '').toLowerCase())
}
