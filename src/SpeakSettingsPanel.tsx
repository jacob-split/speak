import { useEffect, useState } from 'react'
import {
  ChevronDown,
  SlidersHorizontal,
  X,
} from './SpeakIcons'
import { CopyAction } from './CopyAction'
import { apiUrl } from './api'
import type { AgentTestVariables } from './agentConfigs'
import type { ConfigTestVariableField } from './ConfigurationTestPanel'
import { contactSourceKey, parseContactSourceKey } from './contactSources'
import { normalizePhoneNumber } from './phoneNumbers'
import { personalPhoneInboundConfigForToggle } from './personalPhoneInboundConfig'
import { speakTestIds } from './uiContract'
import type {
  CampaignConfig,
  ContactSource,
  Lead,
  PhoneProviderOption,
  SmartView,
} from './types'
import type { VoiceConfigOptions } from './voiceConfigOptions'
import type {
  CodexAuthModelOption,
  VoiceLanguageModelOption,
} from './voiceConfigOptions'

function isSpeakLibraryVoiceProvider(provider?: string) {
  return provider === 'HUME_AI' || provider === 'SPEAK_LIBRARY'
}

function formatCallToolsHeartbeatAge(value?: number | null) {
  if (!Number.isFinite(value)) return 'No heartbeat'
  const ms = Math.max(0, Number(value))
  if (ms < 1_000) return 'Just now'
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1_000))}s ago`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`
  return `${Math.round(ms / 3_600_000)}h ago`
}

function personalPhoneContactLabel(contact: Lead) {
  const name = contact.name || [contact.firstName, contact.lastName].filter(Boolean).join(' ')
  const primary = name || contact.company || contact.phone || 'Personal Phone contact'
  const secondary = contact.phone && contact.phone !== primary ? ` / ${contact.phone}` : ''
  return `${primary}${secondary}`
}

type VoiceRuntimeProvider = 'hume' | 'inworld' | 'xai'

interface CallToolsOptionItem {
  id: string
  appUserId?: string
  name?: string
  username?: string
  sipUri?: string
  webSocketUrl?: string
  active?: boolean
  nextDestination?: string
}

interface CallToolsOptionsState {
  configured: boolean
  mediaGatewayConfigured: boolean
  mediaGatewayConnected: boolean
  mediaGatewayConnectionCount: number
  mediaGatewayHealthyConnectionCount: number
  mediaGatewayHeartbeatStaleAfterMs?: number
  mediaGatewayProfiles: Array<{
    profileId?: string
    profileName?: string
    phoneId?: string
    sampleRate?: number
    connectedAt?: string
    connectedAgeMs?: number | null
    lastSeenAt?: string
    lastSeenAgeMs?: number | null
    heartbeatStaleAfterMs?: number
    healthy?: boolean
    stale?: boolean
    activeCallControlId?: string
    activeStreamId?: string
  }>
  mediaGatewayUrlConfigured: boolean
  users: CallToolsOptionItem[]
  phones: CallToolsOptionItem[]
  webCallbacks: CallToolsOptionItem[]
  queues: CallToolsOptionItem[]
  campaigns: CallToolsOptionItem[]
}

interface PhoneProviderOptionsState {
  configured: boolean
  numbers: PhoneProviderOption[]
  defaultNumber?: PhoneProviderOption | null
  proof?: {
    source?: string
    readError?: string
  }
}

interface PersonalPhoneInboundReadinessProfile {
  profileId?: string
  profileName?: string
  ready?: boolean
  eligibleContactCount?: number
  blockers?: string[]
}

interface PersonalPhoneInboundReadinessPayload {
  ready?: boolean
  error?: string
  contactSource?: {
    configured?: boolean
    sourceId?: string
    present?: boolean
    contactCount?: number
  }
  profiles?: PersonalPhoneInboundReadinessProfile[]
  blockers?: string[]
}

interface PersonalPhoneInboundReadinessState {
  error: string
  loading: boolean
  payload: PersonalPhoneInboundReadinessPayload | null
}

const emptyCallToolsOptions: CallToolsOptionsState = {
  configured: false,
  mediaGatewayConfigured: false,
  mediaGatewayConnected: false,
  mediaGatewayConnectionCount: 0,
  mediaGatewayHealthyConnectionCount: 0,
  mediaGatewayProfiles: [],
  mediaGatewayUrlConfigured: false,
  users: [],
  phones: [],
  webCallbacks: [],
  queues: [],
  campaigns: [],
}

const emptyPhoneProviderOptions: PhoneProviderOptionsState = {
  configured: false,
  numbers: [],
  defaultNumber: null,
}

const personalPhoneReadinessBlockerMessages: Record<string, string> = {
  PERSONAL_PHONE_SPEAK_HANDOFF_SECRET: 'Missed-call handoff is not configured.',
  PERSONAL_PHONE_TELNYX_DID: 'The Personal Phone number is not configured.',
  PERSONAL_PHONE_CONTACTS_SOURCE_ID: 'The Personal Phone contact source is not configured.',
  PERSONAL_PHONE_CONTACT_SOURCE: 'The configured Personal Phone source has no contacts.',
  VOICE_STREAM_WSS_URL: 'The secure voice stream is not ready.',
  PERSONAL_PHONE_HANDOFF_STORE: 'Durable missed-call handoff storage is not ready.',
  PERSONAL_PHONE_INBOUND_PROFILE: 'No saved Personal Phone agent is ready.',
  PERSONAL_PHONE_INBOUND_SOURCE: 'This agent is assigned to the wrong Personal Phone source.',
  PERSONAL_PHONE_INBOUND_SELECTIONS: 'Choose at least one eligible contact or Smart View.',
}

function personalPhoneReadinessBlockerMessage(blockers: string[] = []) {
  const blocker = blockers.find(Boolean)
  if (!blocker) return 'Personal Phone readiness is blocked.'
  return personalPhoneReadinessBlockerMessages[blocker] || 'The voice runtime is not ready.'
}

const inworldDeliveryModeOptions = [
  { value: 'CREATIVE', label: 'Creative' },
  { value: 'BALANCED', label: 'Balanced' },
  { value: 'STABLE', label: 'Stable' },
]

const inworldSegmenterOptions = [
  { value: 'full_turn', label: 'Full turn' },
  { value: 'sentence', label: 'Sentence' },
  { value: 'fast_start', label: 'Fast start' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'per_segment_context', label: 'Per-segment context' },
  { value: 'auto', label: 'Auto' },
]

const inworldUserTurnModeOptions = [
  { value: 'both', label: 'Audio and text' },
  { value: 'audio_only', label: 'Audio only' },
  { value: 'text_only', label: 'Text only' },
  { value: 'none', label: 'None' },
]

const inworldTurnEagernessOptions = [
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
  { value: 'auto', label: 'Auto' },
]

const inworldSteeringHandlingOptions = [
  { value: 'emit_once', label: 'Emit once' },
  { value: 'repeat_each_chunk', label: 'Repeat each chunk' },
]

const inworldOutputRateOptions = [
  { value: 16000, label: '16 kHz' },
  { value: 24000, label: '24 kHz' },
]

const codexReasoningEffortOptions = [
  { value: 'none', label: 'None' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
] as const

type ModelChoice =
  | {
      description?: string
      label: string
      native: VoiceLanguageModelOption
      providerLabel?: string
      runtimeProvider: VoiceRuntimeProvider
      type: 'native'
      unavailable?: boolean
      value: string
    }
  | {
      codex: CodexAuthModelOption
      description?: string
      label: string
      providerLabel?: string
      runtimeProvider: VoiceRuntimeProvider
      type: 'codex'
      unavailable?: boolean
      value: string
    }

function languageModelRuntime(option: VoiceLanguageModelOption): VoiceRuntimeProvider {
  if (option.runtimeProvider === 'xai' || option.modelProvider === 'XAI_VOICE') return 'xai'
  return option.runtimeProvider === 'inworld' || option.modelProvider === 'INWORLD'
    ? 'inworld'
    : 'hume'
}

function codexModelRuntime(option: CodexAuthModelOption): VoiceRuntimeProvider {
  return option.runtimeProvider === 'inworld' ? 'inworld' : 'hume'
}

function isInworldCodexModelId(value?: string) {
  const model = String(value || '').trim()
  return model.startsWith('inworld/') || /^openai\/gpt-/i.test(model)
}

function isSupportedCodexAuthModel(option: CodexAuthModelOption) {
  if (codexModelRuntime(option) !== 'inworld') return true
  return (
    isInworldCodexModelId(option.value) ||
    isInworldCodexModelId(option.modelResource)
  )
}

function nativeModelChoiceValue(value: string) {
  return `native:${value}`
}

function codexModelChoiceValue(value: string) {
  return `codex:${value}`
}

interface SpeakSettingsPanelProps {
  backendDefaults: Partial<CampaignConfig>
  config: CampaignConfig
  expanded: boolean
  voiceOptions: VoiceConfigOptions
  loadingVoiceOptions: boolean
  onExpandedChange: (expanded: boolean) => void
  onCommitTestVariable?: (key: keyof AgentTestVariables) => void
  onUpdateProfileName: (value: string) => void
  onUpdateTestVariable: (key: keyof AgentTestVariables, value: string) => void
  onUpdateConfig: (patch: Partial<CampaignConfig>) => void
  profileName: string
  showAgentMessage?: boolean
  contactSources: ContactSource[]
  smartViews: SmartView[]
  testVariableFields: ConfigTestVariableField[]
  testVariables: AgentTestVariables
}

export function SpeakSettingsPanel({
  backendDefaults,
  config,
  expanded,
  voiceOptions: configOptions,
  loadingVoiceOptions,
  onExpandedChange,
  onCommitTestVariable,
  onUpdateProfileName,
  onUpdateTestVariable,
  onUpdateConfig,
  profileName,
  showAgentMessage = true,
  contactSources,
  smartViews,
  testVariableFields,
  testVariables,
}: SpeakSettingsPanelProps) {
  const voiceRuntimeProvider: VoiceRuntimeProvider =
    config.voiceRuntimeProvider === 'xai' || config.languageModelMode === 'xai'
      ? 'xai'
      : config.voiceRuntimeProvider === 'inworld' || config.languageModelMode === 'inworld'
        ? 'inworld'
        : 'hume'
  const languageModelMode =
    config.languageModelMode === 'codex'
      ? 'codex'
      : voiceRuntimeProvider === 'inworld'
        ? 'inworld'
        : voiceRuntimeProvider === 'xai'
          ? 'xai'
        : 'hume'
  const currentLanguageModelKey =
    config.languageModelProvider && config.languageModelResource
      ? `${config.languageModelProvider}:${config.languageModelResource}`
      : ''
  const allLanguageModelOptions = [...configOptions.languageModels]
  const languageModelOptions = allLanguageModelOptions.filter(
    (option) => languageModelRuntime(option) === voiceRuntimeProvider,
  )
  const currentLanguageModelMissing =
    languageModelMode !== 'codex' &&
    currentLanguageModelKey &&
    !languageModelOptions.some((option) => option.value === currentLanguageModelKey)
  if (currentLanguageModelMissing) {
    languageModelOptions.unshift({
      value: currentLanguageModelKey,
      label: `${config.supplementalLlm || config.languageModelResource || 'Current model'}${
        voiceRuntimeProvider !== 'hume' ? ' (unavailable)' : ''
      }`,
      modelProvider: config.languageModelProvider || '',
      modelResource: config.languageModelResource || '',
      providerLabel: config.languageModelProvider,
      description: 'Current model from this configuration.',
      runtimeProvider: voiceRuntimeProvider,
      reasoningEfforts:
        voiceRuntimeProvider === 'inworld' ? config.inworldReasoningEfforts : undefined,
      reasoningSupported:
        voiceRuntimeProvider === 'inworld' ? config.inworldReasoningSupported : undefined,
    })
  }
  const selectedLanguageModel = languageModelOptions.find(
    (option) => option.value === currentLanguageModelKey,
  )
  const allCodexAuthModelOptions = configOptions.codexAuthModels.filter(
    isSupportedCodexAuthModel,
  )
  const codexAuthModelOptions = allCodexAuthModelOptions.filter(
    (option) => codexModelRuntime(option) === voiceRuntimeProvider,
  )
  const currentCodexAuthModel =
    languageModelMode === 'codex'
      ? voiceRuntimeProvider === 'inworld'
        ? config.languageModelResource || config.inworldRealtimeModel || ''
        : config.codexAuthModel || codexAuthModelOptions[0]?.value || 'gpt-5.5'
      : ''
  const currentCodexAuthModelMissing =
    currentCodexAuthModel &&
    (voiceRuntimeProvider === 'hume' || isInworldCodexModelId(currentCodexAuthModel)) &&
    !codexAuthModelOptions.some((option) => option.value === currentCodexAuthModel)
  if (currentCodexAuthModelMissing) {
    codexAuthModelOptions.unshift({
      value: currentCodexAuthModel,
      label: `${currentCodexAuthModel}${
        voiceRuntimeProvider === 'inworld' ? ' (unavailable)' : ''
      }`,
      description:
        voiceRuntimeProvider === 'inworld'
          ? 'Current Inworld router or model selected for Codex-auth routing.'
          : 'Current Codex-auth model through the Hume CLM bridge.',
      modelProvider: voiceRuntimeProvider === 'inworld' ? 'INWORLD_CODEX' : undefined,
      modelResource: voiceRuntimeProvider === 'inworld' ? currentCodexAuthModel : undefined,
      reasoningEfforts:
        voiceRuntimeProvider === 'inworld' ? config.inworldReasoningEfforts : undefined,
      reasoningSupported:
        voiceRuntimeProvider === 'inworld' ? config.inworldReasoningSupported : undefined,
      runtimeProvider: voiceRuntimeProvider,
    })
  }
  const selectedCodexAuthModel = codexAuthModelOptions.find(
    (option) => option.value === currentCodexAuthModel,
  )
  const selectedInworldReasoningEfforts =
    voiceRuntimeProvider === 'inworld'
      ? selectedCodexAuthModel?.reasoningEfforts || config.inworldReasoningEfforts || ['none']
      : null
  const effectiveInworldReasoningEfforts =
    voiceRuntimeProvider === 'inworld' && config.inworldToolCallingEnabled !== false
      ? ['none']
      : selectedInworldReasoningEfforts
  const availableCodexReasoningEffortOptions = effectiveInworldReasoningEfforts
    ? codexReasoningEffortOptions.filter(
        (option) => !option.value || effectiveInworldReasoningEfforts.includes(option.value),
      )
    : codexReasoningEffortOptions
  const modelChoices: ModelChoice[] = [
    ...languageModelOptions.map((option) => ({
      description: option.description,
      label: option.label,
      native: option,
      providerLabel: option.providerLabel || option.modelProvider,
      runtimeProvider: languageModelRuntime(option),
      type: 'native' as const,
      unavailable:
        voiceRuntimeProvider !== 'hume' &&
        Boolean(currentLanguageModelMissing) &&
        option.value === currentLanguageModelKey,
      value: nativeModelChoiceValue(option.value),
    })),
    ...codexAuthModelOptions.map((option) => ({
      codex: option,
      description: option.description,
      label: option.label,
      providerLabel:
        voiceRuntimeProvider === 'inworld' ? 'Codex auth via Inworld' : 'Codex auth via Hume CLM',
      runtimeProvider: codexModelRuntime(option),
      type: 'codex' as const,
      unavailable:
        voiceRuntimeProvider === 'inworld' &&
        Boolean(currentCodexAuthModelMissing) &&
        option.value === currentCodexAuthModel,
      value: codexModelChoiceValue(option.value),
    })),
  ]
  const currentModelChoiceValue =
    languageModelMode === 'codex'
      ? codexModelChoiceValue(currentCodexAuthModel)
      : nativeModelChoiceValue(currentLanguageModelKey)
  const selectedModelChoice = modelChoices.find(
    (option) => option.value === currentModelChoiceValue,
  )
  const currentProviderModelUnavailable = Boolean(
    voiceRuntimeProvider !== 'hume' && selectedModelChoice?.unavailable,
  )
  const nativeModelChoices = modelChoices.filter((option) => option.type === 'native')
  const codexModelChoices = modelChoices.filter((option) => option.type === 'codex')
  const selectedModelLabel =
    selectedModelChoice?.label ||
    (languageModelMode === 'codex'
      ? selectedCodexAuthModel?.label || currentCodexAuthModel
      : selectedLanguageModel?.label || config.supplementalLlm)
  const selectedLanguageModelTools = new Set(selectedLanguageModel?.builtinTools || [])
  const modelSupportsWebSearch =
    (languageModelMode === 'hume' || languageModelMode === 'xai') &&
    (!selectedLanguageModel || selectedLanguageModelTools.has('web_search'))
  const modelSupportsHangUp =
    languageModelMode === 'codex' ||
    languageModelMode === 'inworld' ||
    languageModelMode === 'xai' ||
    !selectedLanguageModel ||
    selectedLanguageModelTools.has('hang_up')
  const webSearchChecked = Boolean(
    config.webSearchEnabled && modelSupportsWebSearch,
  )
  const hangUpChecked = Boolean(
    config.hangUpEnabled !== false && modelSupportsHangUp,
  )
  const testVariableCount = testVariableFields.filter((field) =>
    Boolean(testVariables[field.key]),
  ).length
  const selectedContactSourceKey = contactSourceKey(
    config.contactSource || '',
    config.contactSourceId || '',
  )
  const selectedContactSource = contactSources.find(
    (source) =>
      contactSourceKey(source.source, source.sourceId) === selectedContactSourceKey,
  )
  const contactSourceOptions = [
    ...contactSources,
    ...(selectedContactSourceKey && !selectedContactSource
      ? [{
          id: selectedContactSourceKey,
          source: config.contactSource || 'manual',
          sourceId: config.contactSourceId || '',
          sourceName: 'Saved source unavailable',
          leadCount: 0,
        } satisfies ContactSource]
      : []),
  ]
  const personalPhoneInbound = config.personalPhoneInbound || {}
  const personalPhoneEligibilityScope =
    personalPhoneInbound.eligibilityScope === 'source' ? 'source' : 'selected'
  const personalPhonePolicySourceId = personalPhoneInbound.sourceId || ''
  const personalPhoneContactIds = personalPhoneInbound.contactIds || []
  const personalPhoneSmartViewIds = personalPhoneInbound.smartViewIds || []
  const personalPhoneSources = contactSources.filter(
    (source) => source.source === 'personal-phone',
  )
  const [personalPhoneReadiness, setPersonalPhoneReadiness] =
    useState<PersonalPhoneInboundReadinessState>({
      error: '',
      loading: true,
      payload: null,
    })
  const authoritativePersonalPhoneSourceId =
    personalPhoneReadiness.payload?.contactSource?.sourceId || ''
  const authoritativePersonalPhoneSource = personalPhoneSources.find(
    (source) => source.sourceId === authoritativePersonalPhoneSourceId,
  )
  const savedPersonalPhoneSource = personalPhoneSources.find(
    (source) => source.sourceId === personalPhonePolicySourceId,
  )
  const personalPhoneSource =
    (authoritativePersonalPhoneSourceId
      ? authoritativePersonalPhoneSource
      : savedPersonalPhoneSource ||
        (!personalPhonePolicySourceId
          ? contactSources.find(
              (source) =>
                source.source === 'personal-phone' &&
                source.sourceId === config.contactSourceId,
            ) || personalPhoneSources[0]
          : undefined))
  const personalPhoneSourceId =
    authoritativePersonalPhoneSourceId ||
    personalPhonePolicySourceId ||
    personalPhoneSource?.sourceId ||
    ''
  const personalPhoneSourceAvailable = Boolean(personalPhoneSource)
  const personalPhoneContactIdsKey = personalPhoneContactIds.join(',')
  const personalPhoneSmartViewIdsKey = personalPhoneSmartViewIds.join(',')
  const personalPhoneSourceMismatch = Boolean(
    personalPhoneInbound.enabled &&
    authoritativePersonalPhoneSourceId &&
    personalPhonePolicySourceId !== authoritativePersonalPhoneSourceId,
  )
  const dialerProvider = config.dialerProvider === 'calltools' ? 'calltools' : 'speak'
  const calltoolsBinding: NonNullable<CampaignConfig['calltoolsAgentBinding']> =
    config.calltoolsAgentBinding || {}
  const [calltoolsOptions, setCalltoolsOptions] = useState<CallToolsOptionsState>(
    emptyCallToolsOptions,
  )
  const [calltoolsLoading, setCalltoolsLoading] = useState(false)
  const [calltoolsMessage, setCalltoolsMessage] = useState('')
  const [phoneProviderOptions, setPhoneProviderOptions] = useState<PhoneProviderOptionsState>(
    emptyPhoneProviderOptions,
  )
  const [phoneProviderLoading, setPhoneProviderLoading] = useState(false)
  const [phoneProviderMessage, setPhoneProviderMessage] = useState('')
  const [personalPhoneContactQuery, setPersonalPhoneContactQuery] = useState('')
  const [personalPhoneContactOptions, setPersonalPhoneContactOptions] = useState<Lead[]>([])
  const [personalPhoneContactsLoading, setPersonalPhoneContactsLoading] = useState(false)
  const selectedPersonalPhoneReadinessProfile = (
    personalPhoneReadiness.payload?.profiles || []
  ).find(
    (profile) =>
      (config.agentProfileId && profile.profileId === config.agentProfileId) ||
      (!config.agentProfileId && profile.profileName === profileName),
  )
  const personalPhoneGlobalBlockers = (
    personalPhoneReadiness.payload?.blockers || []
  ).filter((blocker) => blocker !== 'PERSONAL_PHONE_INBOUND_PROFILE')
  const personalPhoneReadinessBlockers = [
    ...(selectedPersonalPhoneReadinessProfile?.blockers || []),
    ...personalPhoneGlobalBlockers,
  ]
  const personalPhoneReadinessStatus = personalPhoneReadiness.loading
    ? {
        detail: 'Checking the backend route and contact source.',
        label: 'Checking',
        tone: 'checking',
      }
    : personalPhoneReadiness.error
      ? {
          detail: 'Personal Phone readiness is unavailable.',
          label: 'Unavailable',
          tone: 'blocked',
        }
      : !authoritativePersonalPhoneSourceId
        ? {
            detail: personalPhoneReadinessBlockerMessage(
              personalPhoneReadiness.payload?.blockers,
            ),
            label: 'Blocked',
            tone: 'blocked',
          }
        : !personalPhoneInbound.enabled
          ? {
              detail: `${personalPhoneSource?.sourceName || authoritativePersonalPhoneSourceId} is the backend source.`,
              label: 'Off',
              tone: 'off',
            }
          : personalPhoneSourceMismatch
            ? {
                detail: `Save to use ${personalPhoneSource?.sourceName || authoritativePersonalPhoneSourceId}.`,
                label: 'Source corrected',
                tone: 'checking',
              }
            : !selectedPersonalPhoneReadinessProfile
              ? {
                  detail: 'Save this agent to verify the missed-call route.',
                  label: 'Save to verify',
                  tone: 'checking',
                }
              : selectedPersonalPhoneReadinessProfile.ready &&
                  personalPhoneReadiness.payload?.ready
                ? {
                    detail: `${selectedPersonalPhoneReadinessProfile.eligibleContactCount || 0} eligible contacts.`,
                    label: 'Ready',
                    tone: 'ready',
                  }
                : {
                    detail: personalPhoneReadinessBlockerMessage(
                      personalPhoneReadinessBlockers,
                    ),
                    label: 'Blocked',
                    tone: 'blocked',
                  }
  const selectedCallToolsGateway = calltoolsOptions.mediaGatewayProfiles.find(
    (gateway) =>
      (config.agentProfileId && gateway.profileId === config.agentProfileId) ||
      (calltoolsBinding.phoneId && gateway.phoneId === calltoolsBinding.phoneId),
  )

  useEffect(() => {
    const controller = new AbortController()

    void fetch(apiUrl('/personal-phone/inbound/readiness'), {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = (await response.json().catch(() => ({}))) as
          PersonalPhoneInboundReadinessPayload
        if (!response.ok) {
          throw new Error(payload.error || 'Personal Phone readiness failed')
        }
        if (controller.signal.aborted) return
        setPersonalPhoneReadiness({
          error: '',
          loading: false,
          payload,
        })
      })
      .catch((error) => {
        if (controller.signal.aborted) return
        setPersonalPhoneReadiness({
          error:
            error instanceof Error
              ? error.message
              : 'Personal Phone readiness failed',
          loading: false,
          payload: null,
        })
      })

    return () => controller.abort()
  }, [
    config.agentProfileId,
    config.speakConfigVersion,
    personalPhoneContactIdsKey,
    personalPhoneEligibilityScope,
    personalPhoneInbound.enabled,
    personalPhonePolicySourceId,
    personalPhoneSmartViewIdsKey,
  ])

  useEffect(() => {
    if (
      !personalPhoneInbound.enabled ||
      !authoritativePersonalPhoneSourceId ||
      personalPhonePolicySourceId === authoritativePersonalPhoneSourceId
    ) return

    onUpdateConfig({
      personalPhoneInbound: {
        enabled: true,
        eligibilityScope: personalPhoneEligibilityScope,
        sourceId: authoritativePersonalPhoneSourceId,
        contactIds: [],
        smartViewIds: [],
      },
    })
  }, [
    authoritativePersonalPhoneSourceId,
    onUpdateConfig,
    personalPhoneEligibilityScope,
    personalPhoneInbound.enabled,
    personalPhonePolicySourceId,
  ])

  useEffect(() => {
    if (
      !personalPhoneInbound.enabled ||
      personalPhoneEligibilityScope !== 'selected' ||
      !personalPhoneSourceAvailable ||
      !personalPhoneSourceId
    ) return

    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({
        limit: '100',
        source: 'personal-phone',
        sourceId: personalPhoneSourceId,
      })
      if (personalPhoneContactQuery.trim()) {
        params.set('q', personalPhoneContactQuery.trim())
      }
      if (personalPhoneContactIdsKey) {
        params.set('includeIds', personalPhoneContactIdsKey)
      }
      setPersonalPhoneContactsLoading(true)
      void fetch(apiUrl(`/leads?${params.toString()}`), { signal: controller.signal })
        .then(async (response) => {
          const payload = (await response.json().catch(() => ({}))) as {
            error?: string
            leads?: Lead[]
          }
          if (!response.ok) throw new Error(payload.error || 'Personal Phone contacts failed')
          setPersonalPhoneContactOptions(payload.leads || [])
        })
        .catch((error) => {
          if (error instanceof DOMException && error.name === 'AbortError') return
          setPersonalPhoneContactOptions([])
        })
        .finally(() => {
          if (!controller.signal.aborted) setPersonalPhoneContactsLoading(false)
        })
    }, 150)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [
    personalPhoneContactIdsKey,
    personalPhoneContactQuery,
    personalPhoneEligibilityScope,
    personalPhoneSourceAvailable,
    personalPhoneSourceId,
    personalPhoneInbound.enabled,
  ])
  const personalPhoneContactById = new Map(
    personalPhoneContactOptions.map((contact) => [contact.id, contact]),
  )
  const selectedPersonalPhoneContacts = personalPhoneContactIds.map((contactId) => ({
    id: contactId,
    contact: personalPhoneContactById.get(contactId),
  }))
  const selectedPersonalPhoneSmartViews = personalPhoneSmartViewIds.map((smartViewId) => ({
    id: smartViewId,
    smartView: smartViews.find((item) => item.id === smartViewId),
  }))
  const calltoolsGatewayLabel = selectedCallToolsGateway
    ? selectedCallToolsGateway.healthy
      ? selectedCallToolsGateway.activeCallControlId
        ? 'Healthy live'
        : 'Healthy'
      : selectedCallToolsGateway.stale
        ? 'Stale'
        : 'Registered'
    : calltoolsOptions.mediaGatewayConfigured
      ? 'Configured'
      : calltoolsOptions.mediaGatewayUrlConfigured
        ? 'Secret missing'
        : 'Not registered'
  const calltoolsGatewayDetail = selectedCallToolsGateway
    ? [
        `Heartbeat ${formatCallToolsHeartbeatAge(selectedCallToolsGateway.lastSeenAgeMs)}`,
        selectedCallToolsGateway.sampleRate ? `${selectedCallToolsGateway.sampleRate} Hz` : '',
      ].filter(Boolean).join(' / ')
    : calltoolsOptions.mediaGatewayConnectionCount > 0
      ? `${calltoolsOptions.mediaGatewayHealthyConnectionCount}/${calltoolsOptions.mediaGatewayConnectionCount} healthy gateways`
      : calltoolsOptions.mediaGatewayConfigured
        ? 'No active heartbeat'
        : calltoolsOptions.mediaGatewayUrlConfigured
          ? 'Shared secret missing'
          : 'Start the profile gateway'
  const selectedPhoneNumber = normalizePhoneNumber(
    config.telnyxCallerId || config.phoneCallerId || '',
  )
  const phoneNumberOptions = [
    ...phoneProviderOptions.numbers,
    ...(selectedPhoneNumber &&
    !phoneProviderOptions.numbers.some((option) => option.phoneNumber === selectedPhoneNumber)
      ? [{
          id: selectedPhoneNumber,
          label: selectedPhoneNumber,
          phoneNumber: selectedPhoneNumber,
          connectionId: config.telnyxConnectionId || backendDefaults.telnyxConnectionId,
          source: 'profile',
        }]
      : []),
  ]
  const selectedPhoneProviderOption = phoneNumberOptions.find(
    (option) => option.phoneNumber === selectedPhoneNumber,
  )
  const phoneProviderStatus = phoneProviderLoading
    ? 'Loading'
    : phoneProviderOptions.configured
      ? `${phoneProviderOptions.numbers.length} number${phoneProviderOptions.numbers.length === 1 ? '' : 's'}`
      : 'Not connected'

  useEffect(() => {
    if (!expanded || dialerProvider !== 'speak') return
    let cancelled = false

    void Promise.resolve().then(async () => {
      if (cancelled) return
      setPhoneProviderLoading(true)
      try {
        const response = await fetch(apiUrl('/phone-provider/options'))
        const payload = await response.json()
        if (!response.ok) throw new Error(payload.error || 'Phone provider options failed')
        if (cancelled) return
        setPhoneProviderOptions({
          ...emptyPhoneProviderOptions,
          ...payload,
          numbers: payload.numbers || [],
        })
        setPhoneProviderMessage(payload.proof?.readError || '')
      } catch (error) {
        if (cancelled) return
        setPhoneProviderMessage(error instanceof Error ? error.message : 'Phone provider options failed')
      } finally {
        if (!cancelled) setPhoneProviderLoading(false)
      }
    })

    return () => {
      cancelled = true
    }
  }, [dialerProvider, expanded])

  useEffect(() => {
    if (!expanded || dialerProvider !== 'calltools') return
    let cancelled = false

    void Promise.resolve().then(async () => {
      if (cancelled) return
      setCalltoolsLoading(true)
      try {
        const response = await fetch(apiUrl('/calltools/options'))
        const payload = await response.json()
        if (!response.ok) throw new Error(payload.error || 'CallTools options failed')
        if (cancelled) return
        const nextOptions = payload as CallToolsOptionsState
        setCalltoolsOptions({
          ...emptyCallToolsOptions,
          ...nextOptions,
          mediaGatewayProfiles: nextOptions.mediaGatewayProfiles || [],
          users: nextOptions.users || [],
          phones: nextOptions.phones || [],
          webCallbacks: nextOptions.webCallbacks || [],
          queues: nextOptions.queues || [],
          campaigns: nextOptions.campaigns || [],
        })
        setCalltoolsMessage('')
      } catch (error) {
        if (cancelled) return
        setCalltoolsMessage(error instanceof Error ? error.message : 'CallTools options failed')
      } finally {
        if (!cancelled) setCalltoolsLoading(false)
      }
    })

    return () => {
      cancelled = true
    }
  }, [dialerProvider, expanded])

  const currentInworldVoiceValue =
    config.inworldVoiceId ||
    (config.inworldVoiceProvider === 'INWORLD_CUSTOM'
      ? config.voice || config.inworldVoiceName
      : config.inworldVoiceName || config.voice)
  const currentXaiVoiceValue = config.xaiVoiceId || config.xaiVoiceName || config.voice
  const currentVoiceKey =
    voiceRuntimeProvider === 'xai'
      ? config.xaiVoiceProvider && currentXaiVoiceValue
        ? `${config.xaiVoiceProvider}:${currentXaiVoiceValue.toLowerCase()}`
        : ''
      : voiceRuntimeProvider === 'inworld'
      ? config.inworldVoiceProvider && currentInworldVoiceValue
        ? `${config.inworldVoiceProvider}:${currentInworldVoiceValue}`
        : ''
      : config.humeVoiceProvider && (config.humeVoiceId || config.voice)
        ? `${config.humeVoiceProvider}:${config.humeVoiceId || config.voice}`
        : ''
  const voiceOptions = configOptions.voices.filter((option) => {
    const optionRuntime =
      option.runtimeProvider ||
      (option.provider.startsWith('XAI_')
        ? 'xai'
        : option.provider.startsWith('INWORLD_')
          ? 'inworld'
          : 'hume')
    return optionRuntime === voiceRuntimeProvider
  })
  const currentVoiceMissing =
    Boolean(currentVoiceKey) &&
    !voiceOptions.some((option) => option.value === currentVoiceKey)
  const currentVoiceLabel =
    voiceRuntimeProvider === 'xai'
      ? config.xaiVoiceName || config.voice
      : voiceRuntimeProvider === 'inworld'
      ? config.inworldVoiceName || config.voice
      : config.humeVoiceName || config.voice
  const currentVoiceUnavailable = currentVoiceMissing && voiceOptions.length > 0
  const customVoiceOptions = voiceOptions.filter(
    (option) => option.provider === 'CUSTOM_VOICE',
  )
  const humeLibraryVoiceOptions = voiceOptions.filter(
    (option) => isSpeakLibraryVoiceProvider(option.provider),
  )
  const inworldSystemVoiceOptions = voiceOptions.filter(
    (option) => option.provider === 'INWORLD_SYSTEM',
  )
  const inworldCustomVoiceOptions = voiceOptions.filter(
    (option) => option.provider === 'INWORLD_CUSTOM',
  )
  const xaiBuiltinVoiceOptions = voiceOptions.filter(
    (option) => option.provider === 'XAI_BUILTIN',
  )
  const xaiCustomVoiceOptions = voiceOptions.filter(
    (option) => option.provider === 'XAI_CUSTOM',
  )
  const selectedVoice = voiceOptions.find((option) => option.value === currentVoiceKey)
  const voiceSelectValue = selectedVoice ? currentVoiceKey : ''
  const runtimeVersionOptions = configOptions.eviVersions.filter((option) => {
    const optionRuntime = option.runtimeProvider || 'hume'
    return optionRuntime === voiceRuntimeProvider
  })
  const runtimeLabel =
    voiceRuntimeProvider === 'xai'
      ? 'xAI'
      : voiceRuntimeProvider === 'inworld'
        ? 'Inworld'
        : 'Hume'
  const providerSettingsTitle =
    voiceRuntimeProvider === 'xai'
      ? 'xAI Voice Agent'
      : voiceRuntimeProvider === 'inworld'
        ? 'Inworld realtime'
        : 'Hume EVI'
  const providerModelCountLabel = loadingVoiceOptions
    ? 'Loading voice options'
    : `${modelChoices.filter((option) => !option.unavailable).length} ${runtimeLabel} models`
  const selectedRuntimeVersion = runtimeVersionOptions.find(
    (option) => option.value === config.eviVersion,
  )
  const providerConfigVersion =
    voiceRuntimeProvider === 'xai'
      ? config.xaiConfigVersion || config.speakConfigVersion
      : voiceRuntimeProvider === 'inworld'
      ? config.inworldConfigVersion || config.humeConfigVersion
      : config.humeConfigVersion
  const showNativeVadTimingControls =
    voiceRuntimeProvider === 'hume' || voiceRuntimeProvider === 'xai'
  const showHumeQuickResponses = voiceRuntimeProvider === 'hume'
  const showWebSearchToggle =
    (voiceRuntimeProvider === 'hume' || voiceRuntimeProvider === 'xai') &&
    (modelSupportsWebSearch || Boolean(config.webSearchEnabled))

  function selectLanguageModel(value: string) {
    const selected = allLanguageModelOptions.find((option) => option.value === value)
    if (!selected) return
    const nextRuntime = languageModelRuntime(selected)

    onUpdateConfig({
      voiceRuntimeProvider: nextRuntime,
      languageModelMode: nextRuntime,
      voice:
        nextRuntime === 'xai'
          ? config.xaiVoiceId || config.xaiVoiceName?.toLowerCase() || 'eve'
          : nextRuntime === 'inworld'
            ? config.inworldVoiceId || config.inworldVoiceName || 'Dennis'
            : config.humeVoiceId || config.voice,
      languageModelProvider: selected.modelProvider,
      languageModelResource: selected.modelResource,
      inworldRealtimeModel:
        nextRuntime === 'inworld'
          ? selected.modelResource
          : config.inworldRealtimeModel,
      xaiRealtimeModel:
        nextRuntime === 'xai'
          ? selected.modelResource
          : config.xaiRealtimeModel,
      inworldReasoningEfforts:
        nextRuntime === 'inworld'
          ? selected.reasoningEfforts
          : config.inworldReasoningEfforts,
      inworldReasoningSupported:
        nextRuntime === 'inworld'
          ? selected.reasoningSupported
          : config.inworldReasoningSupported,
      eviVersion:
        nextRuntime === 'xai'
          ? 'xai-realtime'
          : nextRuntime === 'inworld'
            ? 'inworld-realtime'
            : config.eviVersion === 'inworld-realtime' || config.eviVersion === 'xai-realtime'
            ? '3'
            : config.eviVersion,
      supplementalLlm: selected.label,
      webSearchEnabled: selected.builtinTools?.includes('web_search')
        ? config.webSearchEnabled
        : false,
      hangUpEnabled: selected.builtinTools?.includes('hang_up')
        ? config.hangUpEnabled
        : false,
    })
  }

  function selectCodexAuthModel(value: string) {
    const selected = allCodexAuthModelOptions.find((option) => option.value === value)
    if (!selected) return
    const selectedRuntime = codexModelRuntime(selected)

    if (selectedRuntime === 'inworld') {
      const currentReasoningEffort = config.codexReasoningEffort
      const supportedReasoningEfforts = selected.reasoningEfforts || ['none']
      onUpdateConfig({
        voiceRuntimeProvider: 'inworld',
        languageModelMode: 'codex',
        languageModelProvider: selected.modelProvider || 'INWORLD_CODEX',
        languageModelResource: selected.modelResource || selected.value,
        inworldRealtimeModel: selected.modelResource || selected.value,
        inworldReasoningEfforts: selected.reasoningEfforts,
        inworldReasoningSupported: selected.reasoningSupported,
        codexReasoningEffort:
          config.inworldToolCallingEnabled !== false
            ? 'none'
            : currentReasoningEffort && supportedReasoningEfforts.includes(currentReasoningEffort)
            ? currentReasoningEffort
            : 'none',
        codexFastMode: config.codexFastMode ?? true,
        supplementalLlm: `Inworld Codex Auth ${selected.label}`,
        webSearchEnabled: false,
        hangUpEnabled: config.hangUpEnabled,
        promptExpansionEnabled: false,
      })
      return
    }

    onUpdateConfig({
      voiceRuntimeProvider: 'hume',
      languageModelMode: 'codex',
      languageModelProvider: 'CUSTOM_LANGUAGE_MODEL',
      languageModelResource: '',
      codexAuthModel: selected.value,
      codexReasoningEffort: config.codexReasoningEffort || 'none',
      codexFastMode: config.codexFastMode ?? true,
      supplementalLlm: `Codex Auth ${selected.label}`,
      webSearchEnabled: false,
      hangUpEnabled: config.hangUpEnabled,
      promptExpansionEnabled:
        voiceRuntimeProvider === 'hume' && languageModelMode === 'codex'
          ? Boolean(config.promptExpansionEnabled)
          : false,
    })
  }

  function selectModelChoice(value: string) {
    const selected = modelChoices.find((option) => option.value === value)
    if (!selected) return
    if (selected.type === 'codex') {
      selectCodexAuthModel(selected.codex.value)
      return
    }

    selectLanguageModel(selected.native.value)
  }

  function selectVoiceRuntimeProvider(mode: VoiceRuntimeProvider) {
    if (mode === voiceRuntimeProvider) return

    const nativeFallback = allLanguageModelOptions.find(
      (option) =>
        languageModelRuntime(option) === mode &&
        option.modelProvider !== 'CUSTOM_LANGUAGE_MODEL',
    )
    if (nativeFallback) {
      selectLanguageModel(nativeFallback.value)
      return
    }

    const codexFallback = allCodexAuthModelOptions.find(
      (option) => codexModelRuntime(option) === mode,
    )
    if (codexFallback) {
      selectCodexAuthModel(codexFallback.value)
    } else {
      onUpdateConfig({
        voiceRuntimeProvider: mode,
        languageModelMode: mode,
        eviVersion:
          mode === 'xai'
            ? 'xai-realtime'
            : mode === 'inworld'
              ? 'inworld-realtime'
              : '3',
      })
    }
  }

  function selectVoice(value: string) {
    if (!value) return
    const selected = voiceOptions.find((option) => option.value === value)
    if (!selected) return
    const nextRuntime =
      selected.runtimeProvider === 'xai' || selected.provider.startsWith('XAI_')
        ? 'xai'
        : selected.runtimeProvider === 'inworld' || selected.provider.startsWith('INWORLD_')
        ? 'inworld'
        : 'hume'

    if (nextRuntime === 'xai') {
      const voiceId = (selected.id || selected.name || '').toLowerCase()
      onUpdateConfig({
        voiceRuntimeProvider: 'xai',
        voice: voiceId,
        xaiVoiceId: voiceId,
        xaiVoiceName: selected.name || selected.label,
        xaiVoiceProvider: selected.provider,
      })
      return
    }

    if (nextRuntime === 'inworld') {
      const voiceId = selected.id || selected.name || ''
      onUpdateConfig({
        voiceRuntimeProvider: 'inworld',
        voice: voiceId,
        inworldVoiceId: voiceId,
        inworldVoiceName: selected.name || selected.label,
        inworldVoiceProvider: selected.provider,
      })
      return
    }

    const voiceId = selected.id || selected.name || ''
    onUpdateConfig({
      voiceRuntimeProvider: 'hume',
      voice: voiceId,
      humeVoiceId: voiceId,
      humeVoiceName: selected.name || selected.label,
      humeVoiceProvider: selected.provider,
    })
  }

  function selectTelnyxStreamCodec(value: string) {
    const telnyxStreamCodec = value === 'PCMU' ? 'PCMU' : 'L16'
    onUpdateConfig({
      phoneAudioMode: telnyxStreamCodec === 'PCMU' ? 'legacy' : 'optimized',
      telnyxStreamCodec,
      sampleRate: telnyxStreamCodec === 'PCMU' ? 8000 : 16000,
    })
  }

  function selectPhoneProviderNumber(value: string) {
    const phoneNumber = normalizePhoneNumber(value)
    const selected = phoneNumberOptions.find((option) => option.phoneNumber === phoneNumber)
    onUpdateConfig({
      telnyxCallerId: phoneNumber,
      phoneCallerId: phoneNumber,
      telnyxConnectionId:
        selected?.connectionId || backendDefaults.telnyxConnectionId || '',
      phoneConnectionId:
        selected?.connectionId || backendDefaults.telnyxConnectionId || '',
    })
  }

  function selectContactSource(value: string) {
    const selection = parseContactSourceKey(value)
    onUpdateConfig({
      contactSource: selection.source as CampaignConfig['contactSource'],
      contactSourceId: selection.sourceId,
    })
  }

  function updatePersonalPhoneInbound(
    patch: Partial<NonNullable<CampaignConfig['personalPhoneInbound']>>,
  ) {
    onUpdateConfig({
      personalPhoneInbound: {
        enabled: Boolean(personalPhoneInbound.enabled),
        eligibilityScope: personalPhoneEligibilityScope,
        sourceId: personalPhoneSourceId,
        contactIds: personalPhoneContactIds,
        smartViewIds: personalPhoneSmartViewIds,
        ...patch,
      },
    })
  }

  function addPersonalPhoneContact(contactId: string) {
    if (!contactId || personalPhoneContactIds.includes(contactId)) return
    updatePersonalPhoneInbound({
      contactIds: [...personalPhoneContactIds, contactId],
    })
  }

  function addPersonalPhoneSmartView(smartViewId: string) {
    if (!smartViewId || personalPhoneSmartViewIds.includes(smartViewId)) return
    updatePersonalPhoneInbound({
      smartViewIds: [...personalPhoneSmartViewIds, smartViewId],
    })
  }

  function updatePhoneConnectionId(value: string) {
    onUpdateConfig({
      telnyxConnectionId: value,
      phoneConnectionId: value,
    })
  }

  function updateCallToolsBinding(
    patch: Partial<NonNullable<CampaignConfig['calltoolsAgentBinding']>>,
  ) {
    onUpdateConfig({
      dialerProvider: 'calltools',
      calltoolsAgentBinding: {
        ...calltoolsBinding,
        ...patch,
        enabled: true,
        mode: 'phone_as_agent',
        contactMatchMode: 'calltools_contact_id_then_phone',
      },
    })
  }

  async function selectDialerProvider(value: string) {
    const nextProvider = value === 'calltools' ? 'calltools' : 'speak'
    if (dialerProvider === 'calltools' && nextProvider !== 'calltools') {
      setCalltoolsLoading(true)
      setCalltoolsMessage('Checking the current CallTools availability assignment...')
      try {
        const stateResponse = await fetch(apiUrl('/dialer-state'))
        const statePayload = (await stateResponse.json().catch(() => ({}))) as {
          dialerState?: {
            calltoolsDuty?: {
              leaseId?: string
              profileId?: string
              status?: string
              binding?: {
                appUserId?: string
                campaignId?: string
                phoneId?: string
              }
            }
          }
          error?: string
        }
        if (!stateResponse.ok) {
          throw new Error(statePayload.error || 'CallTools availability could not be read.')
        }
        const duty = statePayload.dialerState?.calltoolsDuty
        const dutyActive = Boolean(
          duty?.leaseId &&
            ['arming', 'attention', 'disarming', 'on'].includes(duty.status || ''),
        )
        const selectedProfileId = config.agentProfileId || ''
        if (dutyActive && !selectedProfileId) {
          throw new Error(
            'The active CallTools assignment could not be compared with this unsaved profile.',
          )
        }
        if (dutyActive && duty?.profileId === selectedProfileId) {
          setCalltoolsMessage('Making the shared CallTools agent Unavailable...')
          const response = await fetch(apiUrl('/calltools/agent-session'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              expectedLeaseId: duty.leaseId,
              profileId: duty.profileId,
              appUserId: duty.binding?.appUserId,
              campaignId: duty.binding?.campaignId,
              phoneId: duty.binding?.phoneId,
              mode: 'paused',
              ready: false,
              apply: true,
              confirmAgentSession: true,
            }),
          })
          const payload = (await response.json().catch(() => ({}))) as {
            after?: { ready?: boolean }
            error?: string
            patchError?: string
          }
          if (!response.ok || payload.after?.ready !== false) {
            throw new Error(
              payload.error ||
                payload.patchError ||
                'CallTools did not confirm the shared agent is Unavailable.',
            )
          }
          setCalltoolsMessage('Shared CallTools agent is Unavailable for the human handoff.')
        } else if (dutyActive) {
          setCalltoolsMessage(
            'Another configured agent remains Available in CallTools; its assignment was not changed.',
          )
        } else {
          setCalltoolsMessage('No active CallTools assignment needed to be released.')
        }
      } catch (error) {
        setCalltoolsMessage(
          error instanceof Error ? error.message : 'CallTools availability change failed.',
        )
        return
      } finally {
        setCalltoolsLoading(false)
      }
    }
    onUpdateConfig({
      dialerProvider: nextProvider,
      calltoolsAgentBinding: {
        ...calltoolsBinding,
        enabled: nextProvider === 'calltools',
        mode: 'phone_as_agent',
        contactMatchMode: 'calltools_contact_id_then_phone',
      },
    })
  }

  async function verifyCallToolsBinding() {
    setCalltoolsLoading(true)
    try {
      const response = await fetch(apiUrl('/calltools/verify-agent'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profileId: config.agentProfileId,
          profileName,
          config,
        }),
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error || 'CallTools verification failed')
      if (payload.binding && payload.bindingResolution?.adoptedSharedBinding !== true) {
        onUpdateConfig({
          dialerProvider: 'calltools',
          calltoolsAgentBinding: payload.binding,
        })
      }
      setCalltoolsMessage(
        payload.ok
          ? payload.bindingResolution?.adoptedSharedBinding
            ? `CallTools binding ready for ${payload.selectedVoiceProfile?.name || profileName || 'this agent'} via the workspace shared seat.`
            : 'CallTools binding ready.'
          : `Missing ${payload.missing?.join(', ')}`,
      )
    } catch (error) {
      setCalltoolsMessage(error instanceof Error ? error.message : 'CallTools verification failed')
    } finally {
      setCalltoolsLoading(false)
    }
  }

  async function linkCallToolsObjects() {
    setCalltoolsLoading(true)
    try {
      const response = await fetch(apiUrl('/calltools/provision-agent'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: { name: profileName, config } }),
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error || 'CallTools provisioning plan failed')
      if (payload.binding) {
        onUpdateConfig({
          dialerProvider: 'calltools',
          calltoolsAgentBinding: payload.binding,
        })
      }
      setCalltoolsMessage(
        payload.readiness?.ok
          ? 'CallTools account objects linked.'
          : `Linked available objects. Missing ${payload.readiness?.missing?.join(', ')}`,
      )
    } catch (error) {
      setCalltoolsMessage(error instanceof Error ? error.message : 'CallTools linking failed')
    } finally {
      setCalltoolsLoading(false)
    }
  }

  const phoneOutputGain = Number(
    config.phoneOutputGain ?? backendDefaults.phoneOutputGain ?? 0.72,
  )
  const phoneOutputPeak = Number(
    config.phoneOutputPeak ?? backendDefaults.phoneOutputPeak ?? 0.58,
  )

  return (
    <section
      className={[
        'config-settings-panel',
        expanded ? 'expanded' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <button
        className="config-settings-summary"
        type="button"
        aria-expanded={expanded}
        onClick={() => onExpandedChange(!expanded)}
      >
        <SlidersHorizontal size={16} />
        <span>
          <strong>Speak settings</strong>
          <em>
            {languageModelMode === 'codex'
              ? `${runtimeLabel} / Codex auth / ${selectedModelLabel}`
              : `${runtimeLabel} / ${selectedModelLabel || (voiceRuntimeProvider === 'hume' ? config.supplementalLlm : 'Realtime') || 'Language model not loaded'}`}
          </em>
        </span>
        <ChevronDown size={16} />
      </button>

      {expanded && (
        <div className="config-settings-grid">
          {showAgentMessage && (
            <section className="config-settings-section span-2 system-message-settings">
              <div className="settings-section-heading">
                <strong>Agent message</strong>
                <span>Profile name and system message</span>
              </div>
              <div className="settings-control-grid">
                <label className="config-field span-2">
                  <span>Agent name</span>
                  <input
                    value={profileName || ''}
                    onChange={(event) => onUpdateProfileName(event.target.value)}
                  />
                </label>
                <label className="config-field span-2 system-message-field">
                  <span>System message</span>
                  <textarea
                    value={config.instructions || ''}
                    onChange={(event) =>
                      onUpdateConfig({ instructions: event.target.value })
                    }
                  />
                </label>
              </div>
            </section>
          )}

          <section className="config-settings-section span-2">
            <div className="settings-section-heading">
              <strong>Contact routing</strong>
              <span>
                {selectedContactSource
                  ? `${selectedContactSource.sourceName} / ${selectedContactSource.leadCount}`
                  : 'No assigned source'}
              </span>
            </div>
            <div className="settings-control-grid">
              <label className="config-field span-2">
                <span>Contact source</span>
                <select
                  value={selectedContactSourceKey}
                  onChange={(event) => selectContactSource(event.target.value)}
                >
                  <option value="">No assigned source</option>
                  {contactSourceOptions.map((source) => {
                    const sourceKey = contactSourceKey(source.source, source.sourceId)
                    return (
                      <option key={source.id || sourceKey} value={sourceKey}>
                        {source.sourceName} ({source.leadCount})
                      </option>
                    )
                  })}
                </select>
              </label>
              <label className="config-field span-2">
                <span>Smart View</span>
                <select
                  value={config.smartViewId || ''}
                  onChange={(event) =>
                    onUpdateConfig({ smartViewId: event.target.value })
                  }
                >
                  <option value="">No assigned Smart View</option>
                  {smartViews.map((smartView) => (
                    <option key={smartView.id} value={smartView.id}>
                      {smartView.name} ({smartView.leadCount})
                    </option>
                  ))}
                </select>
              </label>

              <label className="config-toggle span-2 personal-phone-inbound-toggle">
                <input
                  type="checkbox"
                  checked={
                    Boolean(personalPhoneInbound.enabled)
                  }
                  disabled={
                    !personalPhoneInbound.enabled &&
                      (personalPhoneReadiness.loading ||
                        Boolean(personalPhoneReadiness.error) ||
                        !authoritativePersonalPhoneSourceId ||
                        !personalPhoneSourceAvailable)
                  }
                  onChange={(event) =>
                    onUpdateConfig({
                      personalPhoneInbound: personalPhoneInboundConfigForToggle(
                        personalPhoneInbound,
                        {
                          enabled: event.target.checked,
                          sourceId: personalPhoneSourceId,
                        },
                      ),
                    })
                  }
                />
                <span>Answer missed Personal Phone calls</span>
              </label>

              <div
                className={`personal-phone-inbound-readiness span-2 ${personalPhoneReadinessStatus.tone}`}
                data-testid={speakTestIds.personalPhoneInboundReadiness}
                data-state={personalPhoneReadinessStatus.tone}
                role="status"
                aria-live="polite"
              >
                <strong>{personalPhoneReadinessStatus.label}</strong>
                <span>{personalPhoneReadinessStatus.detail}</span>
              </div>

              {personalPhoneInbound.enabled && (
                <div className="personal-phone-inbound-routing span-2">
                  <div className="personal-phone-routing-pickers">
                    <label className="config-field">
                      <span>Personal Phone source</span>
                      <select
                        value={personalPhoneSourceId}
                        disabled
                        aria-readonly="true"
                        title="Managed by the Personal Phone backend"
                      >
                        <option value={personalPhoneSourceId}>
                          {personalPhoneSource
                            ? `${personalPhoneSource.sourceName} (${personalPhoneSource.leadCount})`
                            : personalPhoneSourceId
                              ? 'Configured Personal Phone source unavailable'
                              : 'Personal Phone source not configured'}
                        </option>
                      </select>
                    </label>
                    <label className="config-field">
                      <span>Eligible callers</span>
                      <select
                        value={personalPhoneEligibilityScope}
                        onChange={(event) =>
                          updatePersonalPhoneInbound({
                            eligibilityScope:
                              event.target.value === 'source'
                                ? 'source'
                                : 'selected',
                          })
                        }
                      >
                        <option value="source">
                          All contacts from this Personal Phone source
                        </option>
                        <option value="selected">
                          Selected contacts or Smart Views
                        </option>
                      </select>
                    </label>
                  </div>

                  {personalPhoneEligibilityScope === 'selected' && (
                    <>
                      <div className="personal-phone-routing-pickers">
                    <label className="config-field">
                      <span>Find Personal Phone contact</span>
                      <input
                        type="search"
                        value={personalPhoneContactQuery}
                        placeholder="Search contacts"
                        onChange={(event) =>
                          setPersonalPhoneContactQuery(event.target.value)
                        }
                      />
                    </label>
                    <label className="config-field">
                      <span>Add contact</span>
                      <select
                        value=""
                        disabled={personalPhoneContactsLoading || !personalPhoneSource}
                        onChange={(event) => addPersonalPhoneContact(event.target.value)}
                      >
                        <option value="">
                          {personalPhoneContactsLoading
                            ? 'Loading contacts'
                            : 'Select contact'}
                        </option>
                        {personalPhoneContactOptions
                          .filter(
                            (contact) => !personalPhoneContactIds.includes(contact.id),
                          )
                          .map((contact) => (
                            <option key={contact.id} value={contact.id}>
                              {personalPhoneContactLabel(contact)}
                            </option>
                          ))}
                      </select>
                    </label>
                    <label className="config-field">
                      <span>Add Smart View</span>
                      <select
                        value=""
                        onChange={(event) => addPersonalPhoneSmartView(event.target.value)}
                      >
                        <option value="">Select Smart View</option>
                        {smartViews
                          .filter(
                            (smartView) =>
                              !personalPhoneSmartViewIds.includes(smartView.id),
                          )
                          .map((smartView) => (
                            <option key={smartView.id} value={smartView.id}>
                              {smartView.name} ({smartView.leadCount})
                            </option>
                          ))}
                      </select>
                    </label>
                  </div>

                  {(selectedPersonalPhoneContacts.length > 0 ||
                    selectedPersonalPhoneSmartViews.length > 0) && (
                    <div className="personal-phone-routing-selections">
                      {selectedPersonalPhoneContacts.map(({ id, contact }) => (
                        <div className="personal-phone-routing-selection" key={id}>
                          <span>
                            {contact
                              ? personalPhoneContactLabel(contact)
                              : 'Unavailable selected contact'}
                          </span>
                          <button
                            type="button"
                            className="icon-button"
                            aria-label="Remove Personal Phone contact"
                            title="Remove contact"
                            onClick={() =>
                              updatePersonalPhoneInbound({
                                contactIds: personalPhoneContactIds.filter(
                                  (contactId) => contactId !== id,
                                ),
                              })
                            }
                          >
                            <X size={14} />
                          </button>
                        </div>
                      ))}
                      {selectedPersonalPhoneSmartViews.map(({ id, smartView }) => (
                        <div className="personal-phone-routing-selection" key={id}>
                          <span>{smartView?.name || 'Selected Smart View'}</span>
                          <button
                            type="button"
                            className="icon-button"
                            aria-label="Remove Personal Phone Smart View"
                            title="Remove Smart View"
                            onClick={() =>
                              updatePersonalPhoneInbound({
                                smartViewIds: personalPhoneSmartViewIds.filter(
                                  (smartViewId) => smartViewId !== id,
                                ),
                              })
                            }
                          >
                            <X size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                    </>
                  )}
                </div>
              )}
            </div>
          </section>

          <section className="config-settings-section span-2 runtime-provider-section">
            <div className="settings-section-heading">
              <strong>Voice provider</strong>
              <span>{runtimeLabel}</span>
            </div>
            <div className="settings-control-grid">
              <div className="config-field span-2">
                <span>Runtime provider</span>
                <div className="model-source-toggle" role="group" aria-label="Voice runtime">
                  <button
                    type="button"
                    className={voiceRuntimeProvider === 'hume' ? 'active' : ''}
                    aria-pressed={voiceRuntimeProvider === 'hume'}
                    disabled={loadingVoiceOptions}
                    onClick={() => selectVoiceRuntimeProvider('hume')}
                  >
                    Hume
                  </button>
                  <button
                    type="button"
                    className={voiceRuntimeProvider === 'inworld' ? 'active' : ''}
                    aria-pressed={voiceRuntimeProvider === 'inworld'}
                    disabled={loadingVoiceOptions}
                    onClick={() => selectVoiceRuntimeProvider('inworld')}
                  >
                    Inworld
                  </button>
                  <button
                    type="button"
                    className={voiceRuntimeProvider === 'xai' ? 'active' : ''}
                    aria-pressed={voiceRuntimeProvider === 'xai'}
                    disabled={loadingVoiceOptions}
                    onClick={() => selectVoiceRuntimeProvider('xai')}
                  >
                    xAI
                  </button>
                </div>
              </div>

              <div className="settings-option-detail">
                <strong>{providerSettingsTitle}</strong>
                <span>
                  {selectedRuntimeVersion?.label ||
                    (voiceRuntimeProvider === 'xai'
                      ? 'xAI Realtime'
                      : voiceRuntimeProvider === 'inworld'
                        ? 'Inworld Realtime'
                        : 'EVI')}{' '}
                  / {selectedModelLabel || 'Model not loaded'}
                </span>
              </div>

              <div className="settings-option-detail">
                <strong>
                  {selectedVoice?.providerLabel ||
                    (currentVoiceUnavailable
                      ? 'Saved voice unavailable'
                      : `${runtimeLabel} voice`)}
                </strong>
                <span>{selectedVoice?.label || currentVoiceLabel || 'No voice selected'}</span>
              </div>
            </div>
          </section>

          <section className="config-settings-section span-2 provider-model-section">
            <div className="settings-section-heading">
              <strong>{providerSettingsTitle}</strong>
              <span>{providerModelCountLabel}</span>
            </div>
            <div className="settings-control-grid provider-settings-grid">
              <label className="config-field">
                <span>{voiceRuntimeProvider === 'hume' ? 'EVI version' : 'Runtime'}</span>
                <select
                  value={config.eviVersion}
                  onChange={(event) => {
                    const selected = runtimeVersionOptions.find(
                      (option) => option.value === event.target.value,
                    )
                    onUpdateConfig({
                      eviVersion: event.target.value,
                      voiceRuntimeProvider:
                        selected?.runtimeProvider || voiceRuntimeProvider,
                    })
                  }}
                >
                  {runtimeVersionOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              {voiceRuntimeProvider !== 'xai' && (
                <label className="config-field">
                  <span>Temperature</span>
                  <input
                    type="number"
                    min="0"
                    max="2"
                    step="0.1"
                    value={config.languageModelTemperature ?? ''}
                    onChange={(event) =>
                      onUpdateConfig({
                        languageModelTemperature:
                          event.target.value === ''
                            ? undefined
                            : Number(event.target.value),
                      })
                    }
                  />
                </label>
              )}

              <label className="config-field span-2">
                <span>{runtimeLabel} voice</span>
                <select
                  value={voiceSelectValue}
                  onChange={(event) => selectVoice(event.target.value)}
                >
                  {!selectedVoice && (
                    <option value="" disabled>
                      {currentVoiceUnavailable
                        ? 'Saved voice unavailable'
                        : `Select ${runtimeLabel} voice`}
                    </option>
                  )}
                  {customVoiceOptions.length > 0 && (
                    <optgroup label="Custom voices">
                      {customVoiceOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {humeLibraryVoiceOptions.length > 0 && (
                    <optgroup label="Hume library">
                      {humeLibraryVoiceOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {inworldSystemVoiceOptions.length > 0 && (
                    <optgroup label="Inworld">
                      {inworldSystemVoiceOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {inworldCustomVoiceOptions.length > 0 && (
                    <optgroup label="Inworld custom">
                      {inworldCustomVoiceOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {xaiBuiltinVoiceOptions.length > 0 && (
                    <optgroup label="xAI">
                      {xaiBuiltinVoiceOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {xaiCustomVoiceOptions.length > 0 && (
                    <optgroup label="xAI custom">
                      {xaiCustomVoiceOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </label>

              <label className="config-field span-2">
                <span>{runtimeLabel} language model</span>
                <select
                  disabled={loadingVoiceOptions}
                  value={currentModelChoiceValue}
                  onChange={(event) => selectModelChoice(event.target.value)}
                >
                  {nativeModelChoices.length > 0 && (
                    <optgroup label={`${runtimeLabel} native`}>
                      {nativeModelChoices.map((option) => (
                        <option
                          key={option.value}
                          value={option.value}
                          disabled={option.unavailable}
                        >
                          {option.label} / {option.providerLabel}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {codexModelChoices.length > 0 && (
                    <optgroup label="Codex auth">
                      {codexModelChoices.map((option) => (
                        <option
                          key={option.value}
                          value={option.value}
                          disabled={option.unavailable}
                        >
                          {option.label} / {option.providerLabel}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </label>

              {currentProviderModelUnavailable && (
                <div className="settings-option-detail span-2">
                  <strong>Model unavailable</strong>
                  <span>
                    This saved model is no longer compatible with the live {runtimeLabel} catalogue.
                    Select an available model before starting a call.
                  </span>
                </div>
              )}

              <div className="settings-option-detail span-2">
                <strong>
                  {languageModelMode === 'codex'
                    ? `${runtimeLabel} Codex auth`
                    : voiceRuntimeProvider === 'xai'
                      ? 'xAI Voice Agent'
                      : voiceRuntimeProvider === 'inworld'
                        ? 'Inworld Realtime'
                        : selectedLanguageModel?.providerLabel ||
                          config.languageModelProvider ||
                          'Hume model'}
                </strong>
                <span>
                  {languageModelMode === 'codex'
                    ? selectedCodexAuthModel?.description ||
                      (voiceRuntimeProvider === 'inworld'
                        ? 'Inworld router or BYOK-backed model selected through Codex auth.'
                        : 'Hume custom language model bridge using Codex auth.')
                    : selectedLanguageModel?.description ||
                      selectedLanguageModel?.modelResource ||
                      config.languageModelResource ||
                      'Current language model'}
                </span>
              </div>

              {languageModelMode === 'codex' && (
                <div className="provider-settings-group span-2">
                  <div className="provider-settings-subheading">
                    <strong>Codex mode</strong>
                    <span>Reasoning and latency policy</span>
                  </div>

                  <label className="config-field">
                    <span>Reasoning effort</span>
                    <select
                      value={
                        voiceRuntimeProvider === 'inworld' &&
                        config.inworldToolCallingEnabled !== false
                          ? 'none'
                          : config.codexReasoningEffort || 'none'
                      }
                      disabled={
                        voiceRuntimeProvider === 'inworld' &&
                        config.inworldToolCallingEnabled !== false
                      }
                      onChange={(event) =>
                        onUpdateConfig({
                          codexReasoningEffort:
                            event.target.value as CampaignConfig['codexReasoningEffort'],
                        })
                      }
                    >
                      {availableCodexReasoningEffortOptions.map((option) => (
                        <option key={option.value || 'default'} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="config-toggle">
                    <input
                      type="checkbox"
                      checked={Boolean(config.codexFastMode)}
                      onChange={(event) => {
                        const enabled = event.target.checked
                        onUpdateConfig({
                          codexFastMode: enabled,
                          ...(voiceRuntimeProvider === 'inworld' && enabled
                            ? { inworldTtsConversationalEnabled: false }
                            : {}),
                        })
                      }}
                    />
                    <span>Fast mode</span>
                  </label>

                  <div className="settings-option-detail span-2">
                    <strong>Provider-aware fast path</strong>
                    <span>
                      {voiceRuntimeProvider === 'inworld'
                        ? 'Inworld keeps reasoning at None while shared tools are active; Fast mode starts speech from the first usable segment.'
                        : 'Hume requests priority Codex service.'}
                    </span>
                  </div>
                </div>
              )}

              {voiceRuntimeProvider === 'inworld' && (
                <div className="provider-settings-group span-2">
                  <div className="provider-settings-subheading">
                    <strong>Inworld speech</strong>
                    <span>TTS-2, turn handling, and responsiveness</span>
                  </div>

                  <div className="settings-option-detail">
                    <strong>TTS model</strong>
                    <span>Inworld TTS-2</span>
                  </div>

                  <label className="config-field">
                    <span>TTS delivery</span>
                    <select
                      value={config.inworldTtsDeliveryMode || 'CREATIVE'}
                      onChange={(event) =>
                        onUpdateConfig({ inworldTtsDeliveryMode: event.target.value })
                      }
                    >
                      {inworldDeliveryModeOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="config-field">
                    <span>TTS segmenting</span>
                    <select
                      disabled={
                        (languageModelMode === 'codex' && Boolean(config.codexFastMode)) ||
                        Boolean(config.inworldTtsConversationalEnabled)
                      }
                      value={
                        languageModelMode === 'codex' && config.codexFastMode
                          ? 'fast_start'
                          : config.inworldTtsConversationalEnabled
                            ? 'full_turn'
                          : config.inworldTtsSegmenterStrategy || 'full_turn'
                      }
                      onChange={(event) =>
                        onUpdateConfig({
                          inworldTtsSegmenterStrategy: event.target.value,
                        })
                      }
                    >
                      {inworldSegmenterOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="config-field">
                    <span>TTS user context</span>
                    <select
                      value={config.inworldTtsUserTurnMode || 'both'}
                      onChange={(event) =>
                        onUpdateConfig({
                          inworldTtsUserTurnMode: event.target.value,
                        })
                      }
                    >
                      {inworldUserTurnModeOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="config-field">
                    <span>Turn eagerness</span>
                    <select
                      value={config.inworldTurnEagerness || 'high'}
                      onChange={(event) =>
                        onUpdateConfig({ inworldTurnEagerness: event.target.value })
                      }
                    >
                      {inworldTurnEagernessOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="config-field">
                    <span>Steering handling</span>
                    <select
                      value={config.inworldTtsSteeringHandling || 'emit_once'}
                      onChange={(event) =>
                        onUpdateConfig({
                          inworldTtsSteeringHandling: event.target.value,
                        })
                      }
                    >
                      {inworldSteeringHandlingOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="config-field">
                    <span>Output rate</span>
                    <select
                      value={String(config.inworldOutputSampleRate || 16000)}
                      onChange={(event) =>
                        onUpdateConfig({
                          inworldOutputSampleRate: Number(event.target.value),
                        })
                      }
                    >
                      {inworldOutputRateOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="config-field">
                    <span>Responsiveness wait</span>
                    <input
                      type="number"
                      min="300"
                      max="2000"
                      step="50"
                      value={config.inworldResponsivenessInitialWaitMs ?? 600}
                      onChange={(event) =>
                        onUpdateConfig({
                          inworldResponsivenessInitialWaitMs: Number(event.target.value),
                        })
                      }
                    />
                  </label>

                  <label className="config-field">
                    <span>Filler deadline</span>
                    <input
                      type="number"
                      min="600"
                      max="3000"
                      step="50"
                      value={config.inworldResponsivenessHardDeadlineMs ?? 1200}
                      onChange={(event) =>
                        onUpdateConfig({
                          inworldResponsivenessHardDeadlineMs: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                </div>
              )}

              {voiceRuntimeProvider === 'xai' && (
                <div className="provider-settings-group span-2">
                  <div className="provider-settings-subheading">
                    <strong>xAI speech</strong>
                    <span>Native reasoning, transcription, and audio</span>
                  </div>

                  <label className="config-field">
                    <span>Reasoning effort</span>
                    <select
                      value={config.xaiReasoningEffort || 'none'}
                      onChange={(event) =>
                        onUpdateConfig({
                          xaiReasoningEffort: event.target.value === 'high' ? 'high' : 'none',
                        })
                      }
                    >
                      <option value="none">None · lowest latency</option>
                      <option value="high">High</option>
                    </select>
                  </label>

                  <label className="config-field">
                    <span>Voice speed</span>
                    <input
                      type="number"
                      min="0.7"
                      max="1.5"
                      step="0.05"
                      value={config.xaiVoiceSpeed ?? 1}
                      onChange={(event) =>
                        onUpdateConfig({ xaiVoiceSpeed: Number(event.target.value) })
                      }
                    />
                  </label>

                  <label className="config-field">
                    <span>Language hint</span>
                    <input
                      value={config.xaiLanguageHint || ''}
                      placeholder="en or es-MX"
                      onChange={(event) =>
                        onUpdateConfig({ xaiLanguageHint: event.target.value })
                      }
                    />
                  </label>

                  <label className="config-field">
                    <span>Output rate</span>
                    <select
                      value={String(config.xaiOutputSampleRate || 16000)}
                      onChange={(event) =>
                        onUpdateConfig({ xaiOutputSampleRate: Number(event.target.value) })
                      }
                    >
                      <option value="16000">16 kHz · phone optimized</option>
                      <option value="24000">24 kHz · higher fidelity</option>
                    </select>
                  </label>

                  <label className="config-field span-2">
                    <span>Transcription keyterms</span>
                    <input
                      value={(config.xaiKeyterms || []).join(', ')}
                      placeholder="Split, Payroc, merchant portal"
                      onChange={(event) =>
                        onUpdateConfig({
                          xaiKeyterms: event.target.value
                            .split(',')
                            .map((value) => value.trim())
                            .filter(Boolean)
                            .slice(0, 100),
                        })
                      }
                    />
                  </label>

                  <label className="config-toggle">
                    <input
                      type="checkbox"
                      checked={config.xaiResumptionEnabled !== false}
                      onChange={(event) =>
                        onUpdateConfig({ xaiResumptionEnabled: event.target.checked })
                      }
                    />
                    <span>Session resumption</span>
                  </label>

                  <label className="config-toggle">
                    <input
                      type="checkbox"
                      checked={config.xaiToolCallingEnabled !== false}
                      onChange={(event) =>
                        onUpdateConfig({ xaiToolCallingEnabled: event.target.checked })
                      }
                    />
                    <span>Speak function tools</span>
                  </label>
                </div>
              )}
            </div>
          </section>

          <section className="config-settings-section span-2">
            <div className="settings-section-heading">
              <strong>Default phone transport</strong>
              <span>{dialerProvider === 'calltools' ? 'CallTools campaign' : 'Speak/Telnyx direct'}</span>
            </div>
            <div className="settings-control-grid">
              <label className="config-field span-2">
                <span>Profile default</span>
                <select
                  value={dialerProvider}
                  disabled={calltoolsLoading}
                  onChange={(event) => void selectDialerProvider(event.target.value)}
                >
                  <option value="speak">Speak/Telnyx direct calls</option>
                  <option value="calltools">CallTools native campaign</option>
                </select>
              </label>

              <div className="settings-option-detail span-2">
                <strong>Transport-neutral profile</strong>
                <span>
                  This default never restricts the profile. Browser, Playground
                  Phone, Personal Phone, and CallTools all preserve this agent's
                  saved voice, model, prompt, tools, and provider settings.
                </span>
              </div>

              {dialerProvider === 'speak' && (
                <>
                  <label className="config-field">
                    <span>Speak/Telnyx caller ID</span>
                    <select
                      value={selectedPhoneNumber}
                      disabled={phoneProviderLoading}
                      onChange={(event) => selectPhoneProviderNumber(event.target.value)}
                    >
                      <option value="">Select number</option>
                      {phoneNumberOptions.map((option) => (
                        <option key={option.id || option.phoneNumber} value={option.phoneNumber}>
                          {option.label || option.phoneNumber}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="config-field">
                    <span>Call Control connection</span>
                    <input
                      disabled={Boolean(backendDefaults.telnyxConnectionId)}
                      value={
                        backendDefaults.telnyxConnectionId ||
                        selectedPhoneProviderOption?.connectionId ||
                        config.telnyxConnectionId ||
                        ''
                      }
                      onChange={(event) => updatePhoneConnectionId(event.target.value)}
                    />
                  </label>

                  <div className="config-runtime span-2">
                    <div>
                      <span>Phone provider</span>
                      <strong>{phoneProviderStatus}</strong>
                    </div>
                    <div>
                      <span>Selected number</span>
                      <strong>{selectedPhoneProviderOption?.label || selectedPhoneNumber || 'Unassigned'}</strong>
                      <small>{selectedPhoneNumber || ''}</small>
                    </div>
                    <div>
                      <span>Messaging profile</span>
                      <strong>
                        {selectedPhoneProviderOption?.messagingProfileId ||
                          'Unassigned'}
                      </strong>
                    </div>
                    <div>
                      <span>Source</span>
                      <strong>{selectedPhoneProviderOption?.source || 'Profile'}</strong>
                    </div>
                  </div>

                  {phoneProviderMessage && (
                    <div className="settings-option-detail span-2">
                      <strong>Phone provider status</strong>
                      <span>{phoneProviderMessage}</span>
                    </div>
                  )}
                </>
              )}

              {dialerProvider === 'calltools' && (
                <>
                  <label className="config-field">
                    <span>CallTools user</span>
                    <select
                      value={calltoolsBinding.appUserId || calltoolsBinding.userId || ''}
                      disabled={calltoolsLoading}
                      onChange={(event) =>
                        updateCallToolsBinding({
                          appUserId: event.target.value,
                          userId: event.target.value,
                        })
                      }
                    >
                      <option value="">Select user</option>
                      {calltoolsOptions.users.map((option) => (
                        <option key={option.appUserId || option.id} value={option.appUserId || option.id}>
                          {option.name || option.username || option.appUserId || option.id}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="config-field">
                    <span>CallTools phone</span>
                    <select
                      value={calltoolsBinding.phoneId || ''}
                      disabled={calltoolsLoading}
                      onChange={(event) => {
                        const phone = calltoolsOptions.phones.find(
                          (option) => option.id === event.target.value,
                        )
                        updateCallToolsBinding({
                          phoneId: event.target.value,
                          phoneSipUri: phone?.sipUri || '',
                          phoneWebSocketUrl: phone?.webSocketUrl || '',
                        })
                      }}
                    >
                      <option value="">Select phone</option>
                      {calltoolsOptions.phones.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.name || option.username || option.id}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="config-field">
                    <span>Web callback</span>
                    <select
                      value={calltoolsBinding.webCallbackId || ''}
                      disabled={calltoolsLoading}
                      onChange={(event) =>
                        updateCallToolsBinding({ webCallbackId: event.target.value })
                      }
                    >
                      <option value="">Select route</option>
                      {calltoolsOptions.webCallbacks.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.name || option.id}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="config-field">
                    <span>Campaign</span>
                    <select
                      value={calltoolsBinding.campaignId || ''}
                      disabled={calltoolsLoading}
                      onChange={(event) =>
                        updateCallToolsBinding({ campaignId: event.target.value })
                      }
                    >
                      <option value="">Select campaign</option>
                      {calltoolsOptions.campaigns.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.name || option.id}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="config-field">
                    <span>Queue</span>
                    <select
                      value={calltoolsBinding.queueId || ''}
                      disabled={calltoolsLoading}
                      onChange={(event) =>
                        updateCallToolsBinding({ queueId: event.target.value })
                      }
                    >
                      <option value="">No queue</option>
                      {calltoolsOptions.queues.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.name || option.id}
                        </option>
                      ))}
                    </select>
                  </label>

                  <div className="config-runtime span-2">
                    <div>
                      <span>Account</span>
                      <strong>{calltoolsOptions.configured ? 'Connected' : 'Not connected'}</strong>
                    </div>
                    <div>
                      <span>Media gateway</span>
                      <strong>{calltoolsGatewayLabel}</strong>
                      <small>{calltoolsGatewayDetail}</small>
                    </div>
                    <div>
                      <span>Provisioning</span>
                      <strong>{calltoolsBinding.provisioningStatus || 'Unconfigured'}</strong>
                    </div>
                    <div>
                      <span>Web callback</span>
                      <strong>{calltoolsBinding.webCallbackId ? 'Selected' : 'Unconfigured'}</strong>
                    </div>
                    <div>
                      <span>Audio path</span>
                      <strong>{calltoolsBinding.mediaGatewayStatus || 'Unconfigured'}</strong>
                    </div>
                  </div>

                  <div className="settings-action-row span-2">
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={calltoolsLoading}
                      onClick={linkCallToolsObjects}
                    >
                      Link account objects
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={calltoolsLoading}
                      onClick={verifyCallToolsBinding}
                    >
                      Verify
                    </button>
                  </div>

                  {calltoolsMessage && (
                    <div className="settings-option-detail span-2">
                      <strong>CallTools status</strong>
                      <span>{calltoolsMessage}</span>
                    </div>
                  )}
                </>
              )}
            </div>
          </section>

          <section className="config-settings-section span-2">
            <div className="settings-section-heading">
              <strong>Capabilities</strong>
              <span>{selectedModelLabel || 'Current model'}</span>
            </div>
            <div className="config-toggle-grid">
              {showHumeQuickResponses && (
                <label className="config-toggle">
                  <input
                    type="checkbox"
                    checked={Boolean(config.allowShortResponses)}
                    onChange={(event) =>
                      onUpdateConfig({
                        allowShortResponses: event.target.checked,
                      })
                    }
                  />
                  <span>Enable quick responses</span>
                </label>
              )}
              {voiceRuntimeProvider === 'hume' && (
                <label className="config-toggle">
                  <input
                    type="checkbox"
                    checked={Boolean(config.promptExpansionEnabled)}
                    onChange={(event) =>
                      onUpdateConfig({
                        promptExpansionEnabled: event.target.checked,
                      })
                    }
                  />
                  <span>Prompt expansion</span>
                </label>
              )}
              {voiceRuntimeProvider === 'inworld' && (
                <label className="config-toggle">
                  <input
                    type="checkbox"
                    checked={config.inworldVoiceSteeringEnabled !== false}
                    onChange={(event) =>
                      onUpdateConfig({
                        inworldVoiceSteeringEnabled: event.target.checked,
                        inworldTtsModel: 'inworld-tts-2',
                      })
                    }
                  />
                  <span>Voice steering</span>
                </label>
              )}
              {voiceRuntimeProvider === 'inworld' && (
                <label className="config-toggle">
                  <input
                    type="checkbox"
                    checked={Boolean(config.inworldTtsConversationalEnabled)}
                      onChange={(event) =>
                        onUpdateConfig({
                          inworldTtsConversationalEnabled: event.target.checked,
                          codexFastMode: event.target.checked ? false : config.codexFastMode,
                          inworldTtsModel: 'inworld-tts-2',
                      })
                    }
                  />
                  <span>TTS conversation context</span>
                </label>
              )}
              {voiceRuntimeProvider === 'inworld' && (
                <label className="config-toggle">
                  <input
                    type="checkbox"
                    checked={config.inworldVoiceProfileEnabled !== false}
                    onChange={(event) =>
                      onUpdateConfig({
                        inworldVoiceProfileEnabled: event.target.checked,
                      })
                    }
                  />
                  <span>Caller voice profile cues</span>
                </label>
              )}
              {voiceRuntimeProvider === 'inworld' && (
                <label className="config-toggle">
                  <input
                    type="checkbox"
                    checked={Boolean(config.inworldResponsivenessEnabled)}
                    onChange={(event) =>
                      onUpdateConfig({
                        inworldResponsivenessEnabled: event.target.checked,
                      })
                    }
                  />
                  <span>Responsiveness</span>
                </label>
              )}
              {voiceRuntimeProvider === 'inworld' && (
                <label className="config-toggle">
                  <input
                    type="checkbox"
                    checked={Boolean(config.inworldBackchannelEnabled)}
                    onChange={(event) =>
                      onUpdateConfig({
                        inworldBackchannelEnabled: event.target.checked,
                      })
                    }
                  />
                  <span>Backchannel</span>
                </label>
              )}
              {voiceRuntimeProvider === 'inworld' && (
                <label className="config-toggle">
                  <input
                    type="checkbox"
                    checked={Boolean(config.inworldMemoryEnabled)}
                    onChange={(event) =>
                      onUpdateConfig({
                        inworldMemoryEnabled: event.target.checked,
                      })
                    }
                  />
                  <span>Inworld memory</span>
                </label>
              )}
              {showWebSearchToggle && (
                <label className="config-toggle">
                  <input
                    type="checkbox"
                    checked={webSearchChecked}
                    disabled={!modelSupportsWebSearch}
                    onChange={(event) =>
                      onUpdateConfig({ webSearchEnabled: event.target.checked })
                    }
                  />
                  <span>Web search</span>
                </label>
              )}
              <label className="config-toggle">
                <input
                  type="checkbox"
                  checked={hangUpChecked}
                  disabled={!modelSupportsHangUp}
                  onChange={(event) =>
                    onUpdateConfig({ hangUpEnabled: event.target.checked })
                  }
                />
                <span>Hang up</span>
              </label>
            </div>
          </section>

          {testVariableFields.length > 0 && (
            <section className="config-settings-section span-2">
              <div className="settings-section-heading">
                <strong>Test variables</strong>
                <span>{testVariableCount} set</span>
              </div>
              <div className="test-variable-grid settings-test-variable-grid">
                {testVariableFields.map((field) => (
                  <label
                    className={[
                      'config-field',
                      field.control === 'textarea' ? 'span-2' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    key={field.key}
                  >
                    <span>{field.label}</span>
                    {field.control === 'textarea' ? (
                      <textarea
                        value={testVariables[field.key]}
                        onChange={(event) =>
                          onUpdateTestVariable(field.key, event.target.value)
                        }
                      />
                    ) : field.inputType === 'tel' ? (
                      <div
                        className={[
                          'phone-input-shell',
                          testVariables[field.key] &&
                          !normalizePhoneNumber(testVariables[field.key])
                            ? 'invalid'
                            : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                      >
                        <input
                          type="tel"
                          inputMode="tel"
                          value={testVariables[field.key]}
                          onBlur={() => onCommitTestVariable?.(field.key)}
                          onChange={(event) =>
                            onUpdateTestVariable(field.key, event.target.value)
                          }
                        />
                        <CopyAction
                          className="phone-input-action"
                          disabled={!String(testVariables[field.key] || '').trim()}
                          label="Copy phone"
                          value={
                            normalizePhoneNumber(testVariables[field.key]) ||
                            String(testVariables[field.key] || '').trim()
                          }
                        />
                      </div>
                    ) : (
                      <input
                        type={field.inputType || 'text'}
                        value={testVariables[field.key]}
                        onChange={(event) =>
                          onUpdateTestVariable(field.key, event.target.value)
                        }
                      />
                    )}
                  </label>
                ))}
              </div>
            </section>
          )}

          <section className="config-settings-section span-2">
            <div className="settings-section-heading">
              <strong>Speak tools</strong>
              <span>{configOptions.functionTools.length} function tools</span>
            </div>
            <div className="settings-chip-row">
              {configOptions.functionTools.map((tool) => (
                <span
                  className="settings-tool-chip"
                  key={tool.name}
                  title={tool.description}
                >
                  {tool.label || tool.name}
                </span>
              ))}
            </div>
          </section>

          <section className="config-settings-section span-2">
            <div className="settings-section-heading">
              <strong>Timing</strong>
              <span>
                {showNativeVadTimingControls
                  ? 'Timeouts, turns, interruption'
                  : 'Timeouts and Inworld response timing'}
              </span>
            </div>
            <div className="settings-control-grid">
              <label className="config-toggle">
                <input
                  type="checkbox"
                  checked={Boolean(config.inactivityTimeoutEnabled)}
                  onChange={(event) =>
                    onUpdateConfig({
                      inactivityTimeoutEnabled: event.target.checked,
                    })
                  }
                />
                <span>Inactivity timeout</span>
              </label>

              <label className="config-field">
                <span>Inactivity seconds</span>
                <input
                  type="number"
                  min="30"
                  max="1800"
                  step="30"
                  value={config.inactivityTimeoutSeconds ?? ''}
                  onChange={(event) =>
                    onUpdateConfig({
                      inactivityTimeoutSeconds:
                        event.target.value === ''
                          ? undefined
                          : Number(event.target.value),
                    })
                  }
                />
              </label>

              <label className="config-toggle">
                <input
                  type="checkbox"
                  checked={Boolean(config.maxDurationTimeoutEnabled)}
                  onChange={(event) =>
                    onUpdateConfig({
                      maxDurationTimeoutEnabled: event.target.checked,
                    })
                  }
                />
                <span>Maximum seconds</span>
              </label>

              <label className="config-field">
                <span>Maximum duration</span>
                <input
                  type="number"
                  min="30"
                  max="1800"
                  step="30"
                  value={config.maxDurationTimeoutSeconds ?? ''}
                  onChange={(event) =>
                    onUpdateConfig({
                      maxDurationTimeoutSeconds:
                        event.target.value === ''
                          ? undefined
                          : Number(event.target.value),
                    })
                  }
                />
              </label>

              {showNativeVadTimingControls && (
                <>
                  <label className="config-toggle">
                    <input
                      type="checkbox"
                      checked={config.turnDetectionEnabled !== false}
                      onChange={(event) =>
                        onUpdateConfig({
                          turnDetectionEnabled: event.target.checked,
                        })
                      }
                    />
                    <span>Turn detection</span>
                  </label>

                  <label className="config-field">
                    <span>Turn silence ms</span>
                    <input
                      type="number"
                      min={voiceRuntimeProvider === 'xai' ? 0 : 500}
                      max={voiceRuntimeProvider === 'xai' ? 10000 : 3000}
                      step="50"
                      value={config.endOfTurnSilenceMs}
                      onChange={(event) =>
                        onUpdateConfig({
                          endOfTurnSilenceMs: Number(event.target.value),
                        })
                      }
                    />
                  </label>

                  <label className="config-field">
                    <span>Speech threshold</span>
                    <input
                      type="number"
                      min={voiceRuntimeProvider === 'xai' ? 0.1 : 0}
                      max={voiceRuntimeProvider === 'xai' ? 0.9 : 1}
                      step="0.05"
                      value={config.speechDetectionThreshold}
                      onChange={(event) =>
                        onUpdateConfig({
                          speechDetectionThreshold: Number(event.target.value),
                        })
                      }
                    />
                  </label>

                  <label className="config-field">
                    <span>Prefix padding</span>
                    <input
                      type="number"
                      min="0"
                      max={voiceRuntimeProvider === 'xai' ? 10000 : 1000}
                      step="50"
                      value={config.prefixPaddingMs}
                      onChange={(event) =>
                        onUpdateConfig({
                          prefixPaddingMs: Number(event.target.value),
                        })
                      }
                    />
                  </label>

                  <label className="config-toggle">
                    <input
                      type="checkbox"
                      checked={config.interruptionEnabled !== false}
                      onChange={(event) =>
                        onUpdateConfig({
                          interruptionEnabled: event.target.checked,
                        })
                      }
                    />
                    <span>Interruption</span>
                  </label>

                  {voiceRuntimeProvider === 'hume' && (
                    <label className="config-field">
                      <span>Interrupt ms</span>
                      <input
                        type="number"
                        min="50"
                        max="2000"
                        step="50"
                        value={config.minInterruptionMs}
                        onChange={(event) =>
                          onUpdateConfig({
                            minInterruptionMs: Number(event.target.value),
                          })
                        }
                      />
                    </label>
                  )}

                  <label className="config-toggle">
                    <input
                      type="checkbox"
                      checked={Boolean(config.nudgesEnabled)}
                      onChange={(event) =>
                        onUpdateConfig({ nudgesEnabled: event.target.checked })
                      }
                    />
                    <span>Inactivity nudges</span>
                  </label>

                  <label className="config-field">
                    <span>Nudge interval</span>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={config.nudgesIntervalSeconds ?? ''}
                      onChange={(event) =>
                        onUpdateConfig({
                          nudgesIntervalSeconds:
                            event.target.value === ''
                              ? undefined
                              : Number(event.target.value),
                        })
                      }
                    />
                  </label>
                </>
              )}
            </div>
          </section>

          {voiceRuntimeProvider === 'hume' && (
            <section className="config-settings-section span-2">
              <div className="settings-section-heading">
                <strong>Hume conversation messages</strong>
                <span>Start, resume, timeout</span>
              </div>
              <div className="settings-control-grid">
                <label className="config-toggle">
                  <input
                    type="checkbox"
                    checked={Boolean(config.eviStartsConversation)}
                    onChange={(event) =>
                      onUpdateConfig({
                        eviStartsConversation: event.target.checked,
                      })
                    }
                  />
                  <span>EVI starts conversation</span>
                </label>
                <label className="config-toggle">
                  <input
                    type="checkbox"
                    checked={Boolean(config.resumeConversationMessageEnabled)}
                    onChange={(event) =>
                      onUpdateConfig({
                        resumeConversationMessageEnabled: event.target.checked,
                      })
                    }
                  />
                  <span>Resume conversation message</span>
                </label>
                <label className="config-toggle">
                  <input
                    type="checkbox"
                    checked={Boolean(config.inactivityMessageEnabled)}
                    onChange={(event) =>
                      onUpdateConfig({
                        inactivityMessageEnabled: event.target.checked,
                      })
                    }
                  />
                  <span>Inactivity text</span>
                </label>
                <label className="config-toggle">
                  <input
                    type="checkbox"
                    checked={Boolean(config.maxDurationMessageEnabled)}
                    onChange={(event) =>
                      onUpdateConfig({
                        maxDurationMessageEnabled: event.target.checked,
                      })
                    }
                  />
                  <span>Maximum duration text</span>
                </label>

                <label className="config-field span-2">
                  <span>Resume message</span>
                  <textarea
                    rows={2}
                    value={config.resumeConversationMessage || ''}
                    onChange={(event) =>
                      onUpdateConfig({
                        resumeConversationMessage: event.target.value,
                      })
                    }
                  />
                </label>

                <label className="config-field span-2">
                  <span>Inactivity message</span>
                  <textarea
                    rows={2}
                    value={config.inactivityMessage || ''}
                    onChange={(event) =>
                      onUpdateConfig({ inactivityMessage: event.target.value })
                    }
                  />
                </label>

                <label className="config-field span-2">
                  <span>Maximum duration message</span>
                  <textarea
                    rows={2}
                    value={config.maxDurationMessage || ''}
                    onChange={(event) =>
                      onUpdateConfig({
                        maxDurationMessage: event.target.value,
                      })
                    }
                  />
                </label>
              </div>
            </section>
          )}

          <section className="config-settings-section span-2">
            <div className="settings-section-heading">
              <strong>Runtime transport</strong>
              <span>Phone media bridge</span>
            </div>
            <div className="settings-control-grid">
              <label className="config-field">
                <span>Phone stream codec</span>
                <select
                  value={config.telnyxStreamCodec}
                  onChange={(event) => selectTelnyxStreamCodec(event.target.value)}
                >
                  <option value="L16">L16</option>
                  <option value="PCMU">PCMU</option>
                </select>
              </label>

              <label className="config-toggle">
                <input
                  type="checkbox"
                  checked={Boolean(config.verboseTranscription)}
                  onChange={(event) =>
                    onUpdateConfig({
                      verboseTranscription: event.target.checked,
                    })
                  }
                />
                <span>Verbose transcripts</span>
              </label>

              <div className="config-runtime span-2">
                <div>
                  <span>Audio</span>
                  <strong>
                    {config.telnyxStreamCodec} / {config.sampleRate / 1000} kHz
                  </strong>
                </div>
                <div>
                  <span>Output</span>
                  <strong>
                    {phoneOutputGain.toFixed(2)}x / peak{' '}
                    {phoneOutputPeak.toFixed(2)}
                  </strong>
                </div>
                <div>
                  <span>Config version</span>
                  <strong>{providerConfigVersion || 'Not loaded'}</strong>
                </div>
                <div>
                  <span>Speak/Telnyx caller ID</span>
                  <strong>
                    {backendDefaults.telnyxCallerId || config.telnyxCallerId}
                  </strong>
                </div>
                <div>
                  <span>Connection ID</span>
                  <strong>
                    {backendDefaults.telnyxConnectionId ||
                      config.telnyxConnectionId}
                  </strong>
                </div>
              </div>
            </div>
          </section>
        </div>
      )}
    </section>
  )
}
