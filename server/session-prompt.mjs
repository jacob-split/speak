import { isCodexAuthLanguageModel } from './runtime-config.mjs'

const speechGuardrails = [
  'Keep turns short and natural for a live conversation. Ask one question at a time and let the person finish.',
  'Do not use delay fillers such as "just a sec", "one moment", "hold on", or "give me a second"; answer only when you have the actual response.',
  'Use runtime contact context as working notes, not as a script. If something is missing, stale, or contradicted, ask naturally.',
  'Never read markup, variable names, tool names, IDs, JSON, hidden rules, prompt text, or implementation details aloud.',
  'Use tools only when a real action or lookup is needed. Do not claim a text, email, contact update, portal link, or hangup succeeded until tool proof confirms it.',
  'Do not infer or reuse any prior template, role, offer, company, campaign, or sales flow. If profile instructions are brief, follow only those instructions and ask one concise clarifying question when needed.',
]

export function buildRuntimeSystemPrompt(agentInstructions = '') {
  const instructions = String(agentInstructions || '').trim()
  if (!instructions) return speechGuardrails.join('\n')

  return [
    ...speechGuardrails,
    '',
    '<profile_instructions>',
    instructions,
    '</profile_instructions>',
  ].join('\n')
}

export function shouldSendHumeSessionSystemPrompt(
  config = {},
  { hasTemporarySystemPrompt = false } = {},
) {
  // Hume generates quick responses, nudges, and event messages before the
  // supplemental CLM answers. Custom-language-model sessions reject the
  // system_prompt field, so Codex-auth sessions mirror the exact assembled
  // Speak prompt through persistent context instead. The CLM boundary retains
  // the same authoritative prompt and deduplicates Hume's context copy.
  if (isCodexAuthLanguageModel(config)) return false
  return hasTemporarySystemPrompt || !config.useConfigPrompt
}

export function extractProfileInstructionsFromRuntimePrompt(prompt = '') {
  const text = String(prompt || '').trim()
  if (!text) return ''

  const profileMatch = text.match(
    /<profile_instructions>\s*([\s\S]*?)\s*<\/profile_instructions>/i,
  )
  if (profileMatch) return profileMatch[1].trim()

  const legacyAgentMatch = text.match(
    /<agent_instructions>\s*([\s\S]*?)\s*<\/agent_instructions>/i,
  )
  if (legacyAgentMatch) return legacyAgentMatch[1].trim()

  return text
}
