import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  buildRuntimeSystemPrompt,
  shouldSendHumeSessionSystemPrompt,
} from '../server/session-prompt.mjs'
import {
  CODEX_AUTH_LANGUAGE_MODEL_PROVIDER,
  normalizeCampaignConfig,
} from '../server/runtime-config.mjs'

const customInstructions =
  'You are a bakery appointment setter. Ask whether Friday morning works, then stop.'

const runtimePrompt = buildRuntimeSystemPrompt(customInstructions)
assert.match(runtimePrompt, /Keep turns short/)
assert.match(runtimePrompt, /<profile_instructions>/)
assert.match(runtimePrompt, /bakery appointment setter/)
assert.doesNotMatch(runtimePrompt, /portal\/signin/)

const blankRuntimePrompt = buildRuntimeSystemPrompt('')
assert.match(blankRuntimePrompt, /Keep turns short/)
assert.doesNotMatch(blankRuntimePrompt, /<agent_instructions>|<profile_instructions>/)
assert.doesNotMatch(
  blankRuntimePrompt,
  /card-processing|portal\/signin/,
)

assert.equal(normalizeCampaignConfig({}).instructions, '')
assert.equal(
  normalizeCampaignConfig({ instructions: customInstructions }).instructions,
  customInstructions,
)
assert.equal(
  shouldSendHumeSessionSystemPrompt(
    normalizeCampaignConfig({ useConfigPrompt: false }),
  ),
  true,
)
assert.equal(
  shouldSendHumeSessionSystemPrompt(
    normalizeCampaignConfig({ useConfigPrompt: true }),
  ),
  false,
)
assert.equal(
  shouldSendHumeSessionSystemPrompt(
    normalizeCampaignConfig({ useConfigPrompt: true }),
    { hasTemporarySystemPrompt: true },
  ),
  true,
)
assert.equal(
  shouldSendHumeSessionSystemPrompt(
    normalizeCampaignConfig({
      languageModelMode: 'codex',
      languageModelProvider: CODEX_AUTH_LANGUAGE_MODEL_PROVIDER,
    }),
  ),
  false,
)
assert.equal(
  shouldSendHumeSessionSystemPrompt(
    normalizeCampaignConfig({
      languageModelMode: 'codex',
      languageModelProvider: CODEX_AUTH_LANGUAGE_MODEL_PROVIDER,
      useConfigPrompt: true,
    }),
    { hasTemporarySystemPrompt: true },
  ),
  false,
)

const dataSource = await readFile(new URL('../src/data.ts', import.meta.url), 'utf8')
assert.doesNotMatch(dataSource, /Add the role, offer, workflow/)

const serverSource = await readFile(new URL('../server/index.mjs', import.meta.url), 'utf8')
const configOptionsDoc = await readFile(
  new URL('../docs/configuration-options.md', import.meta.url),
  'utf8',
)
assert.match(serverSource, /const JONATHAN_ECHO_MODE = 'jonathan_echo'/)
assert.match(configOptionsDoc, /HUME_TEMP_AGENT_MODE[\s\S]*jonathan_echo/)
assert.match(configOptionsDoc, /HUME_TEMP_AGENT_MODE[\s\S]*Leave unset in production/)
assert.match(
  serverSource,
  /function resolveHumeSessionPrompts\(state\)[\s\S]*shouldSendHumeSessionSystemPrompt\(state\.config,[\s\S]*\? systemPrompt\s*:\s*undefined[\s\S]*return \{ systemPrompt, humeSystemPrompt \}/,
  'Hume must resolve the exact selected runtime prompt once for session, quick-response context, and CLM parity',
)
assert.match(
  serverSource,
  /buildHumeSessionSettings[\s\S]*resolveHumeSessionPrompts\(state\)[\s\S]*system_prompt:\s*humeSystemPrompt/,
  'native Hume session settings may repeat the selected runtime prompt before audio',
)
assert.match(
  serverSource,
  /const providerContext = codexAuthSession[\s\S]*buildHumeCodexPromptContext\(systemPrompt, context\)[\s\S]*text: providerContext/,
  'Hume Codex-auth quick responses must receive the exact selected runtime prompt before audio',
)
assert.match(
  serverSource,
  /function buildInworldInstructions\(state\)[\s\S]*buildRuntimeSystemPrompt\(state\.config\.instructions\)[\s\S]*return \[\s*systemPrompt,/,
  'Inworld native and Codex-auth sessions must use the exact selected profile instructions',
)

assert.match(
  serverSource,
  /function endBrowserTestForOutcome\(state, outcome\)/,
  'Assistant hangup in Playground tests must end the local test session, not a phone provider call',
)
assert.match(
  serverSource,
  /if \(state\.browserTest\) \{\s*endBrowserTestForOutcome\(state, finalOutcome\)\s*return\s*\}/,
  'Automatic hangup must short-circuit browser tests before provider hangup',
)
assert.match(
  serverSource,
  /alreadyEnded:\s*true[\s\S]*outcome:\s*state\.outcome \|\| 'operator-ended'/,
  'Manual Playground stop must preserve assistant-ended test outcomes',
)
assert.match(
  serverSource,
  /requestCallToolsGatewayHangup\(state, finalOutcome\)/,
  'CallTools automatic hangup must still use the global Speak gateway hangup path',
)

console.log('Session prompt contract ok')
