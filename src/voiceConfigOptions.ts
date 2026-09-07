import type { CampaignConfig } from './types'

export interface VoiceConfigPayload {
  action?: string
  config?: Partial<CampaignConfig>
  error?: string
  humeConfigId?: string
  inworldConfigId?: string
  xaiConfigId?: string
  speakConfigId?: string
  humeConfigName?: string
  inworldConfigName?: string
  xaiConfigName?: string
  speakConfigName?: string
  humeConfigVersion?: number
  inworldConfigVersion?: number
  xaiConfigVersion?: number
  speakConfigVersion?: number
  ok?: boolean
}

export interface VoiceRuntimeOption {
  description?: string
  label: string
  runtimeProvider?: 'hume' | 'inworld' | 'xai'
  value: string
}

export interface VoiceLanguageModelOption {
  builtinTools?: string[]
  costEstimate?: number
  deprecated?: boolean
  deprecation?: string
  description?: string
  label: string
  modelProvider: string
  modelResource: string
  functionCallingSupported?: boolean
  providerLabel?: string
  reasoningEfforts?: NonNullable<CampaignConfig['inworldReasoningEfforts']>
  reasoningSupported?: boolean
  runtimeProvider?: 'hume' | 'inworld' | 'xai'
  value: string
}

export interface CodexAuthModelOption {
  description?: string
  label: string
  modelProvider?: string
  modelResource?: string
  functionCallingSupported?: boolean
  reasoningEfforts?: NonNullable<CampaignConfig['inworldReasoningEfforts']>
  reasoningSupported?: boolean
  runtimeProvider?: 'hume' | 'inworld' | 'xai'
  value: string
}

export interface VoiceOption {
  compatibleOctaveModels?: string[]
  id?: string
  label: string
  name?: string
  provider: string
  providerLabel?: string
  runtimeProvider?: 'hume' | 'inworld' | 'xai'
  tags?: Record<string, string[]>
  value: string
}

export interface VoiceFunctionToolOption {
  description?: string
  label?: string
  name: string
}

export interface VoiceConfigOptionsPayload {
  error?: string
  codexAuthModels?: CodexAuthModelOption[]
  eviVersions?: VoiceRuntimeOption[]
  functionTools?: VoiceFunctionToolOption[]
  languageModels?: VoiceLanguageModelOption[]
  providerErrors?: Partial<
    Record<'hume' | 'inworld' | 'xai', { message: string }>
  >
  voices?: VoiceOption[]
}

export type VoiceConfigOptions = Required<
  Pick<
    VoiceConfigOptionsPayload,
    | 'codexAuthModels'
    | 'eviVersions'
    | 'functionTools'
    | 'languageModels'
    | 'voices'
  >
>

function humeNativeModel(
  value: string,
  label: string,
  providerLabel: string,
  builtinTools: string[] = ['web_search', 'hang_up'],
): VoiceLanguageModelOption {
  const [modelProvider, modelResource] = value.split(':')
  return {
    value,
    label,
    modelProvider,
    modelResource,
    providerLabel,
    description: 'Hume-supported native language model. Does not use the CLM bridge.',
    builtinTools,
    runtimeProvider: 'hume',
  }
}

export const fallbackVoiceOptions: VoiceConfigOptions = {
  eviVersions: [
    {
      value: '3',
      label: 'EVI 3',
      description: 'Flagship expressive voice model.',
    },
  ],
  functionTools: [
    { name: 'send_text_message', label: 'Text message' },
    { name: 'send_email', label: 'Email' },
    { name: 'update_contact', label: 'Update contact' },
    { name: 'update_caller_identity', label: 'Update identity' },
    { name: 'get_contact_context', label: 'Contact context' },
  ],
  codexAuthModels: [
    {
      value: 'gpt-5.6-sol',
      label: 'GPT 5.6 Sol',
      description: 'Codex-auth model through the Hume CLM bridge.',
      runtimeProvider: 'hume',
    },
    {
      value: 'gpt-5.6-terra',
      label: 'GPT 5.6 Terra',
      description: 'Codex-auth model through the Hume CLM bridge.',
      runtimeProvider: 'hume',
    },
    {
      value: 'gpt-5.6-luna',
      label: 'GPT 5.6 Luna',
      description: 'Codex-auth model through the Hume CLM bridge.',
      runtimeProvider: 'hume',
    },
    {
      value: 'gpt-5.5',
      label: 'GPT 5.5',
      description: 'Codex-auth model through the Hume CLM bridge.',
      runtimeProvider: 'hume',
    },
    {
      value: 'gpt-5.4',
      label: 'GPT 5.4',
      description: 'Codex-auth model through the Hume CLM bridge.',
      runtimeProvider: 'hume',
    },
    {
      value: 'gpt-5.4-mini',
      label: 'GPT 5.4 Mini',
      description: 'Codex-auth model through the Hume CLM bridge.',
      runtimeProvider: 'hume',
    },
    {
      value: 'gpt-5.3-codex-spark',
      label: 'GPT 5.3 Codex Spark',
      description: 'Codex-auth model through the Hume CLM bridge.',
      runtimeProvider: 'hume',
    },
  ],
  languageModels: [
    humeNativeModel('GOOGLE:gemini-2.5-flash', 'Gemini 2.5 Flash', 'Google'),
    humeNativeModel('OPEN_AI:gpt-4.1', 'GPT 4.1', 'OpenAI'),
    humeNativeModel('OPEN_AI:gpt-4.1-priority', 'GPT 4.1 (priority)', 'OpenAI'),
    humeNativeModel('ANTHROPIC:claude-sonnet-4-6', 'Claude Sonnet 4.6', 'Anthropic'),
    humeNativeModel(
      'ANTHROPIC:claude-sonnet-4-5-20250929',
      'Claude Sonnet 4.5',
      'Anthropic',
    ),
    humeNativeModel(
      'ANTHROPIC:claude-haiku-4-5-20251001',
      'Claude Haiku 4.5',
      'Anthropic',
    ),
    humeNativeModel('OPEN_AI:gpt-5', 'GPT 5', 'OpenAI'),
    humeNativeModel('OPEN_AI:gpt-5-priority', 'GPT 5 (priority)', 'OpenAI'),
    humeNativeModel('OPEN_AI:gpt-5-mini', 'GPT 5 Mini', 'OpenAI'),
    humeNativeModel('OPEN_AI:gpt-5-mini-priority', 'GPT 5 Mini (priority)', 'OpenAI'),
    humeNativeModel('OPEN_AI:gpt-5-nano', 'GPT 5 Nano', 'OpenAI'),
    humeNativeModel('OPEN_AI:gpt-5-nano-priority', 'GPT 5 Nano (priority)', 'OpenAI'),
    humeNativeModel('OPEN_AI:gpt-5.1', 'GPT 5.1', 'OpenAI'),
    humeNativeModel('OPEN_AI:gpt-5.1-priority', 'GPT 5.1 (priority)', 'OpenAI'),
    humeNativeModel('OPEN_AI:gpt-5.2', 'GPT 5.2', 'OpenAI'),
    humeNativeModel('OPEN_AI:gpt-5.2-priority', 'GPT 5.2 (priority)', 'OpenAI'),
    humeNativeModel(
      'SAMBANOVA:Llama-4-Maverick-17B-128E-Instruct',
      'Llama 4 Maverick (17Bx128E)',
      'SambaNova',
      [],
    ),
    humeNativeModel('OPEN_AI:gpt-4o', 'GPT 4o', 'OpenAI'),
    humeNativeModel('OPEN_AI:gpt-4o-priority', 'GPT 4o (priority)', 'OpenAI'),
    humeNativeModel('SAMBANOVA:Qwen3-32B', 'Qwen3 32B', 'SambaNova', []),
    humeNativeModel(
      'SAMBANOVA:DeepSeek-R1-Distill-Llama-70B',
      'DeepSeek R1-Distill (Llama 3.3 70B Instruct)',
      'SambaNova',
      [],
    ),
    humeNativeModel('CEREBRAS:gpt-oss-120b', 'Cerebras OpenAI GPT OSS', 'Cerebras'),
    humeNativeModel(
      'X_AI:grok-4-fast-non-reasoning-latest',
      'Grok 4 Fast (Non-Reasoning) (latest)',
      'xAI',
    ),
  ],
  voices: [],
}
