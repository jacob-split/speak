import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  Activity,
  Check,
  Copy,
  Ear,
  FileText,
  Mic,
  Monitor,
  Phone,
  Plus,
  RefreshCw,
  Save,
  SlidersHorizontal,
  Trash2,
  X,
} from './SpeakIcons'
import {
  AgentProfilePicker,
  AppPrimaryNavigation,
  AppearanceSwitch,
  CodexAppIcon,
  GlobalSearchTrigger,
} from './AppTopbarControls'
import { SpeakLogoMark } from './SpeakLogoMark'
import { DeviceCallButton } from './DeviceCallButton'
import { GlobalSearchOverlay } from './GlobalSearchOverlay'
import {
  clearActiveAgentProfileId,
  createAgentConfigId,
  loadActiveAgentProfileId,
  loadActiveAgentProfile,
  loadAgentProfiles,
  normalizeAgentTestVariables,
  normalizeAgentProfile,
  normalizeCampaignProfileConfig,
  resolveCallConfig,
  saveActiveAgentProfileId,
  saveAgentProfiles,
  seededSpeakDemoProfileId,
} from './agentConfigs'
import type { AgentConfigProfile, AgentTestVariables } from './agentConfigs'
import { apiBase, apiUrl } from './api'
import { ConfigurationTestPanel } from './ConfigurationTestPanel'
import {
  ContactDeliveryComposer,
  SmsFieldActions,
} from './ContactDeliveryActions'
import type {
  ConfigTestThread,
  ConfigTestVariableField,
} from './ConfigurationTestPanel'
import { CopyAction } from './CopyAction'
import { SmartConfigPanel } from './SmartConfigPanel'
import { formatCallDate } from './calls'
import type { RecentCallSummary } from './calls'
import { defaultCampaignConfig } from './data'
import { SpeakSettingsPanel } from './SpeakSettingsPanel'
import {
  fallbackVoiceOptions,
} from './voiceConfigOptions'
import type {
  VoiceConfigOptionsPayload,
  VoiceConfigPayload,
} from './voiceConfigOptions'
import {
  isValidPhoneNumber,
  splitLeadName,
} from './leads'
import {
  normalizePhoneNumber,
  normalizePhoneOnCommit,
} from './phoneNumbers'
import type {
  CampaignConfig,
  ContactSource,
  Lead,
  SmartView,
  TranscriptEntry,
  VoiceBackendStatus,
} from './types'
import {
  callAgentTranscriptLabel,
  callLeadTranscriptLabel,
  leadTranscriptLabel,
  testVariablesTranscriptLabel,
} from './transcriptLabels'
import {
  readPlaygroundPhoneLeadId,
  readPlaygroundPhoneSmartViewId,
  writePlaygroundPhoneLeadId,
  writePlaygroundPhoneSmartViewId,
} from './playgroundLeadSelection'
import { useConfigurationTestSession } from './useConfigurationTestSession'
import { usePhoneProviderOptions } from './usePhoneProviderOptions'
import { useHumanTakeover } from './useHumanTakeover'
import { usePlaygroundCallSupervision } from './usePlaygroundCallSupervision'
import type { CommunicationThreadSummary } from './useRecentCalls'
import {
  useSmartConfigChat,
  type SmartConfigProfileAppliedPayload,
} from './useSmartConfigChat'
import { useDismissibleLayer } from './useDismissibleLayer'
import { useAppearance } from './useAppearance'
import { formatOperationalDateTime } from './time'
import { speakActionIds, speakRouteIds, speakTestIds } from './uiContract'

interface ConfigDirtySections {
  name: boolean
  prompt: boolean
  settings: boolean
  test: boolean
  voice: boolean
}

const cleanDirtySections: ConfigDirtySections = {
  name: false,
  prompt: false,
  settings: false,
  test: false,
  voice: false,
}

const playgroundContactOptionLimit = 250

function isPhoneConfigPlaceholder(value?: string) {
  const text = String(value || '').trim()
  return (
    !text ||
    /your\s+(phone|telnyx)\s+number/i.test(text) ||
    /^phone connection id$/i.test(text) ||
    /^telnyx connection id$/i.test(text) ||
    /^telnyx call control connection_id$/i.test(text)
  )
}

function profilePhoneConfigValue(value: string | undefined, fallback: string | undefined) {
  return isPhoneConfigPlaceholder(value) ? fallback || value || '' : value || ''
}

const fullProviderSyncSections: ConfigDirtySections = {
  name: true,
  prompt: true,
  settings: true,
  test: false,
  voice: true,
}

interface TestVariableField extends ConfigTestVariableField {
  aliases: string[]
}

interface ProfilePersistenceResult {
  profiles: AgentConfigProfile[]
  activeProfileId: string
}

interface SaveProfileOptions {
  forceProviderSync?: boolean
  status?: string
}

type ConfigOptionRuntimeProvider = 'hume' | 'inworld' | 'xai'

interface RuntimeScopedOption {
  modelProvider?: string
  provider?: string
  runtimeProvider?: ConfigOptionRuntimeProvider
  value: string
}

function optionRuntimeProvider(option: RuntimeScopedOption): ConfigOptionRuntimeProvider {
  if (option.runtimeProvider === 'xai') return 'xai'
  if (option.modelProvider === 'XAI_VOICE') return 'xai'
  if (option.provider?.startsWith('XAI_')) return 'xai'
  if (option.runtimeProvider === 'inworld') return 'inworld'
  if (option.modelProvider === 'INWORLD') return 'inworld'
  if (option.provider?.startsWith('INWORLD_')) return 'inworld'
  return 'hume'
}

function mergeMissingVoiceFallback<T extends RuntimeScopedOption>(
  payloadOptions: T[] | undefined,
  fallbackOptions: T[],
) {
  const merged = Array.isArray(payloadOptions) ? [...payloadOptions] : []
  const hasHumeRuntimeOption = merged.some(
    (option) => optionRuntimeProvider(option) === 'hume',
  )
  if (hasHumeRuntimeOption) return merged

  const existingValues = new Set(merged.map((option) => option.value))
  const humeFallbacks = fallbackOptions.filter(
    (option) =>
      optionRuntimeProvider(option) === 'hume' && !existingValues.has(option.value),
  )

  return [...humeFallbacks, ...merged]
}

function retainFailedRuntimeOptions<T extends RuntimeScopedOption>(
  payloadOptions: T[] | undefined,
  currentOptions: T[],
  failedRuntimes: ConfigOptionRuntimeProvider[],
) {
  const incoming = Array.isArray(payloadOptions) ? payloadOptions : []
  if (!failedRuntimes.length) return incoming
  const retained = currentOptions.filter(
    (option) => failedRuntimes.includes(optionRuntimeProvider(option)),
  )
  const successful = incoming.filter(
    (option) => !failedRuntimes.includes(optionRuntimeProvider(option)),
  )
  const values = new Set(successful.map((option) => option.value))
  return [...successful, ...retained.filter((option) => !values.has(option.value))]
}

const testVariableFields: TestVariableField[] = [
  {
    key: 'first_name',
    label: 'first_name',
    aliases: ['first_name', 'firstName', 'first name'],
  },
  {
    key: 'last_name',
    label: 'last_name',
    aliases: ['last_name', 'lastName', 'last name'],
  },
  {
    key: 'full_name',
    label: 'full_name',
    aliases: ['full_name', 'fullName', 'full name'],
  },
  {
    key: 'business_name',
    label: 'business_name',
    aliases: ['business_name', 'businessName', 'business name', 'organization', 'company'],
  },
  {
    key: 'contact_phone',
    label: 'contact_phone',
    inputType: 'tel',
    aliases: [
      'contact_phone',
      'contact phone',
      'phone_on_file',
      'phone number',
      'cell number',
    ],
  },
  {
    key: 'contact_email',
    label: 'contact_email',
    inputType: 'email',
    aliases: [
      'contact_email',
      'contact email',
      'email_on_file',
      'email address',
    ],
  },
  {
    key: 'notes',
    label: 'notes',
    control: 'textarea',
    aliases: ['notes', 'lead notes', 'contact notes'],
  },
]

const emptyAdHocTestLead: AgentTestVariables = {
  first_name: '',
  last_name: '',
  full_name: '',
  business_name: '',
  contact_phone: '',
  contact_email: '',
  notes: '',
}

const naturalTextVariableAliases = new Set(['organization', 'company'])
const lowSignalTextVariableAliases = new Set(['notes'])

function communicationThreadsByCallId(threads: CommunicationThreadSummary[]) {
  const next = new Map<string, CommunicationThreadSummary>()
  threads.forEach((thread) => {
    thread.providerLinks?.forEach((link) => {
      if (link.kind === 'call_control' && link.id) next.set(link.id, thread)
    })
  })
  return next
}

function configTestThreadFromSummary(
  call: RecentCallSummary,
  linkedThread?: CommunicationThreadSummary,
): ConfigTestThread {
  const agentName = callAgentTranscriptLabel(call)
  const context =
    call.insight ||
    linkedThread?.summary ||
    linkedThread?.latestMessagePreview ||
    call.lead?.business_name ||
    call.lead?.name ||
    'Browser test'
  const subtitle = [agentName, context].filter(Boolean).join(' / ')

  return {
    id: call.callControlId,
    title: formatCallDate(call.createdAt || call.updatedAt),
    subtitle,
    createdAt: call.createdAt,
    updatedAt: call.updatedAt,
    outcome: call.outcome || '',
    phase: call.phase,
    transcriptTurns: call.transcriptTurns || call.transcript?.length || 0,
    agentLabel: agentName,
    leadLabel: callLeadTranscriptLabel(call),
    communicationThreadId: linkedThread?.threadId,
    communicationThreadChannels: linkedThread?.channels || [],
    communicationThreadStatus: linkedThread?.status,
    communicationThreadSummary: linkedThread?.summary || linkedThread?.latestMessagePreview,
    transcript: (call.transcript || []).map((entry, index) => ({
      id: `${call.callControlId}-${index}`,
      at: entry.at || '',
      speaker: (entry.speaker === 'You' ? 'Lead' : entry.speaker) as TranscriptEntry['speaker'],
      text: entry.text,
      emotionScores: entry.emotionScores,
      providerEventId: entry.providerEventId,
    })),
  }
}

function configTestThreadTime(thread: ConfigTestThread) {
  return Date.parse(thread.createdAt || thread.updatedAt || '') || 0
}

async function fetchConfigTestThreads(profileId: string, profileName = '') {
  const params = new URLSearchParams({
    limit: '24',
    profileId,
  })
  if (profileName.trim()) params.set('profileName', profileName.trim())
  const [response, threadsResponse] = await Promise.all([
    fetch(apiUrl(`/config-tests/recent?${params}`)),
    fetch(
      apiUrl(
        `/communication-threads?limit=100&agentProfileId=${encodeURIComponent(profileId)}`,
      ),
    ),
  ])
  const payload = (await response.json().catch(() => ({}))) as {
    tests?: RecentCallSummary[]
    error?: string
  }
  const threadsPayload = (await threadsResponse.json().catch(() => ({}))) as {
    threads?: CommunicationThreadSummary[]
  }
  if (!response.ok) {
    throw new Error(payload.error || 'Test history failed')
  }
  const threadByCallId = communicationThreadsByCallId(threadsPayload.threads || [])
  return (payload.tests || [])
    .map((call) => configTestThreadFromSummary(call, threadByCallId.get(call.callControlId)))
    .sort((left, right) => configTestThreadTime(left) - configTestThreadTime(right))
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function promptReferencesTestVariable(prompt: string, field: TestVariableField) {
  return field.aliases.some((alias) => {
    const escaped = escapeRegExp(alias)
    const explicitReference = new RegExp(
      `(?:\\{\\{\\s*${escaped}\\s*\\}\\}|\\$\\{?\\s*${escaped}\\s*\\}?)`,
      'i',
    )
    if (explicitReference.test(prompt)) return true
    if (lowSignalTextVariableAliases.has(alias)) return false
    if (
      !/[_A-Z]/.test(alias) &&
      !alias.includes(' ') &&
      !naturalTextVariableAliases.has(alias)
    ) {
      return false
    }
    return new RegExp(`\\b${escaped}\\b`, 'i').test(prompt)
  })
}

function normalizeProfilePayload(profiles: AgentConfigProfile[] = []) {
  return profiles.map((profile) => normalizeAgentProfile(profile))
}

const promptConfigKeys = new Set<keyof CampaignConfig>(['instructions'])

const voiceConfigKeys = new Set<keyof CampaignConfig>([
  'voiceRuntimeProvider',
  'voice',
  'humeVoiceId',
  'humeVoiceName',
  'humeVoiceProvider',
  'inworldVoiceName',
  'inworldVoiceId',
  'inworldVoiceProvider',
  'xaiVoiceName',
  'xaiVoiceId',
  'xaiVoiceProvider',
])

const speakSettingsConfigKeys = new Set<keyof CampaignConfig>([
  'contactSource',
  'contactSourceId',
  'smartViewId',
  'personalPhoneInbound',
  'voiceRuntimeProvider',
  'eviVersion',
  'languageModelMode',
  'languageModelProvider',
  'languageModelResource',
  'languageModelTemperature',
  'codexAuthModel',
  'codexReasoningEffort',
  'inworldReasoningEfforts',
  'inworldReasoningSupported',
  'codexFastMode',
  'inworldRealtimeModel',
  'inworldSttModel',
  'inworldTtsModel',
  'inworldLanguage',
  'inworldSttEndOfTurnConfidenceThreshold',
  'inworldSttMinEndOfTurnSilenceMs',
  'inworldSttMaxTurnSilenceMs',
  'inworldSttVadThreshold',
  'inworldTurnDetectionMode',
  'inworldTurnEagerness',
  'inworldTtsDeliveryMode',
  'inworldTtsSegmenterStrategy',
  'inworldTtsSteeringHandling',
  'inworldTtsConversationalEnabled',
  'inworldTtsUserTurnMode',
  'inworldVoiceSteeringEnabled',
  'inworldVoiceProfileEnabled',
  'inworldResponsivenessInitialWaitMs',
  'inworldResponsivenessHardDeadlineMs',
  'inworldBackchannelEnabled',
  'inworldResponsivenessEnabled',
  'inworldMemoryEnabled',
  'inworldToolCallingEnabled',
  'inworldOutputSampleRate',
  'xaiRealtimeModel',
  'xaiReasoningEffort',
  'xaiLanguageHint',
  'xaiKeyterms',
  'xaiVoiceSpeed',
  'xaiResumptionEnabled',
  'xaiToolCallingEnabled',
  'xaiOutputSampleRate',
  'allowShortResponses',
  'promptExpansionEnabled',
  'inactivityTimeoutEnabled',
  'inactivityTimeoutSeconds',
  'maxDurationTimeoutEnabled',
  'maxDurationTimeoutSeconds',
  'turnDetectionEnabled',
  'endOfTurnSilenceMs',
  'speechDetectionThreshold',
  'prefixPaddingMs',
  'interruptionEnabled',
  'minInterruptionMs',
  'nudgesEnabled',
  'nudgesIntervalSeconds',
  'eviStartsConversation',
  'resumeConversationMessageEnabled',
  'resumeConversationMessage',
  'inactivityMessageEnabled',
  'inactivityMessage',
  'maxDurationMessageEnabled',
  'maxDurationMessage',
  'webSearchEnabled',
  'hangUpEnabled',
])

export function AgentConfigWorkspace() {
  const basePath = apiBase().replace(/\/api$/, '')
  const { appearance, setAppearance } = useAppearance()
  const agentNameInputRef = useRef<HTMLInputElement | null>(null)
  const playgroundSourceMenuRef = useRef<HTMLDivElement | null>(null)
  const playgroundSessionActiveRef = useRef(false)
  const stopPhoneTestHumanAudioStreamRef = useRef<() => void>(() => undefined)
  const speakOptionsRequestRef = useRef<AbortController | null>(null)
  const [profiles, setProfiles] = useState<AgentConfigProfile[]>(loadAgentProfiles)
  const [selectedProfileIds, setSelectedProfileIds] = useState<Set<string>>(new Set())
  const [activeId, setActiveId] = useState(
    () => loadActiveAgentProfileId() || seededSpeakDemoProfileId,
  )
  const [backendDefaults, setBackendDefaults] = useState<Partial<CampaignConfig>>({})
  const [voiceOptions, setVoiceOptions] = useState(fallbackVoiceOptions)
  const [loadingVoiceOptions, setLoadingVoiceOptions] = useState(false)
  const [notice, setNotice] = useState('')
  const [savingProfile, setSavingProfile] = useState(false)
  const [loadingVoiceConfig, setLoadingVoiceConfig] = useState(false)
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [serverProfilesHydrated, setServerProfilesHydrated] = useState(false)
  const [contactSources, setContactSources] = useState<ContactSource[]>([])
  const [smartViews, setSmartViews] = useState<SmartView[]>([])
  const [workspaceLeads, setWorkspaceLeads] = useState<Lead[]>([])
  const [phoneTestLeadMatchedCount, setPhoneTestLeadMatchedCount] = useState(0)
  const [phoneTestLeadsLoading, setPhoneTestLeadsLoading] = useState(false)
  const [phoneTestMode, setPhoneTestMode] = useState<'saved' | 'adHoc'>('saved')
  const [phoneTestPickerOpen, setPhoneTestPickerOpen] = useState(false)
  const [phoneTestSmartViewId, setPhoneTestSmartViewId] = useState('')
  const [phoneTestLeadId, setPhoneTestLeadId] = useState('')
  const [phoneTestLeadQuery, setPhoneTestLeadQuery] = useState('')
  const [adHocTestLead, setAdHocTestLead] =
    useState<AgentTestVariables>(emptyAdHocTestLead)
  const [adHocSmsComposerOpen, setAdHocSmsComposerOpen] = useState(false)
  const [phoneTestTakeoverBusy, setPhoneTestTakeoverBusy] =
    useState<'idle' | 'takeover' | 'release'>('idle')
  const [playgroundHistoryLoading, setPlaygroundHistoryLoading] = useState(false)
  const [playgroundThreads, setPlaygroundThreads] = useState<ConfigTestThread[]>([])
  const [visibleLiveTestId, setVisibleLiveTestId] = useState('')
  const [mobilePromptOpen, setMobilePromptOpen] = useState(false)
  const [playgroundMode, setPlaygroundMode] = useState<'test' | 'smart'>('test')
  const [playgroundSourceMenuOpen, setPlaygroundSourceMenuOpen] = useState(false)
  const [dirtySections, setDirtySections] =
    useState<ConfigDirtySections>(cleanDirtySections)
  const phoneTestMenuRef = useRef<HTMLDivElement | null>(null)
  const settingsPopoverRef = useRef<HTMLElement | null>(null)
  const saveProfilePromiseRef = useRef<Promise<AgentConfigProfile | null> | null>(null)
  const nextSessionProfileRef = useRef<AgentConfigProfile | null>(null)
  const [draft, setDraft] = useState<AgentConfigProfile>(() => {
    const activeProfile = loadActiveAgentProfile()
    if (activeProfile) return activeProfile
    return normalizeAgentProfile({
      name: 'Split default',
      config: resolveCallConfig(defaultCampaignConfig),
    })
  })
  const profileContextIdRef = useRef(draft.id)

  const dismissSettings = useCallback(() => {
    setSettingsOpen(false)
  }, [setSettingsOpen])

  useDismissibleLayer({
    enabled: settingsOpen,
    onDismiss: dismissSettings,
    refs: [settingsPopoverRef],
  })

  const dismissPhoneTestPicker = useCallback(() => {
    setPhoneTestPickerOpen(false)
  }, [])

  useDismissibleLayer({
    enabled: phoneTestPickerOpen,
    onDismiss: dismissPhoneTestPicker,
    refs: [phoneTestMenuRef],
  })

  const dismissPlaygroundSourceMenu = useCallback(() => {
    setPlaygroundSourceMenuOpen(false)
  }, [])

  useDismissibleLayer({
    enabled: playgroundSourceMenuOpen,
    onDismiss: dismissPlaygroundSourceMenu,
    refs: [playgroundSourceMenuRef],
  })

  const fetchPlaygroundLeads = useCallback(async ({
    includeLeadId = '',
    query = '',
    smartViewId = '',
  }: {
    includeLeadId?: string
    query?: string
    smartViewId?: string
  } = {}) => {
    setPhoneTestLeadsLoading(true)
    try {
      const params = new URLSearchParams({
        limit: String(playgroundContactOptionLimit),
      })
      const trimmedQuery = query.trim()
      if (trimmedQuery) params.set('q', trimmedQuery)
      if (smartViewId) params.set('smartViewId', smartViewId)
      if (includeLeadId) params.set('includeIds', includeLeadId)
      const response = await fetch(apiUrl(`/leads?${params.toString()}`))
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string
        leads?: Lead[]
        totalMatching?: number
      }
      if (!response.ok) throw new Error(payload.error || 'Contacts failed')
      const nextLeads = payload.leads || []
      setWorkspaceLeads(nextLeads)
      setPhoneTestLeadMatchedCount(payload.totalMatching ?? nextLeads.length)
      setPhoneTestLeadId((current) => {
        if (current && nextLeads.some((lead) => lead.id === current)) return current
        if (includeLeadId && nextLeads.some((lead) => lead.id === includeLeadId)) {
          return includeLeadId
        }
        return nextLeads[0]?.id || ''
      })
    } finally {
      setPhoneTestLeadsLoading(false)
    }
  }, [])

  useEffect(() => {
    let mounted = true

    async function hydrateWorkspaceLists() {
      try {
        const response = await fetch(apiUrl('/smart-views'))
        const payload = (await response.json().catch(() => ({}))) as {
          contactSources?: ContactSource[]
          smartViews?: SmartView[]
          error?: string
        }
        if (!response.ok) throw new Error(payload.error || 'Smart Views failed')
        if (!mounted) return
        setContactSources(payload.contactSources || [])
        const nextSmartViews = payload.smartViews || []
        const preferredLeadId = readPlaygroundPhoneLeadId()
        const storedSmartViewId = readPlaygroundPhoneSmartViewId()
        const preferredSmartViewId = nextSmartViews.some(
          (view) => view.id === storedSmartViewId,
        )
          ? storedSmartViewId
          : ''
        setSmartViews(nextSmartViews)
        setPhoneTestSmartViewId(preferredSmartViewId)
        setPhoneTestLeadId(preferredLeadId)
        await fetchPlaygroundLeads({
          includeLeadId: preferredLeadId,
          query: '',
          smartViewId: preferredSmartViewId,
        })
      } catch (error) {
        if (mounted) {
          setNotice(error instanceof Error ? error.message : 'Workspace lists failed')
        }
      }
    }

    void hydrateWorkspaceLists()

    return () => {
      mounted = false
    }
  }, [fetchPlaygroundLeads])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetchPlaygroundLeads({
        includeLeadId: phoneTestLeadId,
        query: phoneTestLeadQuery,
        smartViewId: phoneTestSmartViewId,
      }).catch((error) => {
        setNotice(error instanceof Error ? error.message : 'Contacts failed')
      })
    }, 150)
    return () => window.clearTimeout(timer)
  }, [
    fetchPlaygroundLeads,
    phoneTestLeadId,
    phoneTestLeadQuery,
    phoneTestSmartViewId,
  ])

  const persistProfiles = useCallback(async (
    nextProfiles: AgentConfigProfile[],
    nextActiveId = activeId,
  ): Promise<ProfilePersistenceResult> => {
    try {
      const response = await fetch(apiUrl('/profiles'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profiles: nextProfiles,
          activeProfileId: nextActiveId,
        }),
      })
      const payload = (await response.json().catch(() => ({}))) as {
        profiles?: AgentConfigProfile[]
        activeProfileId?: string
        error?: string
      }
      if (!response.ok) throw new Error(payload.error || 'Profile workspace sync failed')
      const persistedProfiles = payload.profiles?.length
        ? normalizeProfilePayload(payload.profiles)
        : normalizeProfilePayload(nextProfiles)
      const persistedActiveId = payload.activeProfileId || nextActiveId

      saveAgentProfiles(persistedProfiles)
      if (persistedActiveId) {
        saveActiveAgentProfileId(persistedActiveId)
      } else {
        clearActiveAgentProfileId()
      }

      setProfiles(persistedProfiles)
      setActiveId(persistedActiveId)
      return {
        profiles: persistedProfiles,
        activeProfileId: persistedActiveId,
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Profile workspace sync failed')
      throw error
    }
  }, [activeId])

  useEffect(() => {
    if (serverProfilesHydrated) return undefined
    let mounted = true

    async function hydrateServerProfiles() {
      const localProfiles = loadAgentProfiles()
      const localActiveId =
        loadActiveAgentProfileId() || seededSpeakDemoProfileId

      try {
        const response = await fetch(apiUrl('/profiles'))
        const payload = (await response.json().catch(() => ({}))) as {
          profiles?: AgentConfigProfile[]
          activeProfileId?: string
          error?: string
        }
        if (!response.ok) throw new Error(payload.error || 'Profile workspace failed')
        if (!mounted) return

        if (Array.isArray(payload.profiles)) {
          const hydratedProfiles = normalizeProfilePayload(payload.profiles)
          const serverActiveId = payload.activeProfileId || ''
          const resolvedActiveId =
            hydratedProfiles.some((profile) => profile.id === serverActiveId)
              ? serverActiveId
              : hydratedProfiles[0]?.id || ''
          setProfiles(hydratedProfiles)
          setActiveId(resolvedActiveId)
          saveAgentProfiles(hydratedProfiles)
          if (resolvedActiveId) {
            saveActiveAgentProfileId(resolvedActiveId)
          } else {
            clearActiveAgentProfileId()
          }
          const activeProfile = hydratedProfiles.find(
            (profile) => profile.id === resolvedActiveId,
          )
          if (activeProfile) {
            setDraft(activeProfile)
          } else {
            setDraft(
              normalizeAgentProfile({
                name: 'New agent config',
                config: { ...defaultCampaignConfig, ...backendDefaults },
              }),
            )
          }
          setDirtySections(cleanDirtySections)
          setServerProfilesHydrated(true)
          return
        }

        await persistProfiles(localProfiles, localActiveId)
        if (mounted) setServerProfilesHydrated(true)
      } catch (error) {
        if (mounted) {
          setNotice(error instanceof Error ? error.message : 'Profile workspace failed')
        }
      }
    }

    void hydrateServerProfiles()

    return () => {
      mounted = false
    }
  }, [backendDefaults, persistProfiles, serverProfilesHydrated])

  useEffect(() => {
    let mounted = true

    async function loadDefaults() {
      try {
        const response = await fetch(apiUrl('/health'))
        if (!response.ok) throw new Error('Backend health failed')
        const status = (await response.json()) as VoiceBackendStatus
        if (!mounted) return

        const defaults = normalizeCampaignProfileConfig(status.defaults || {})
        setBackendDefaults(defaults)
        setDraft((current) => ({
          ...current,
          config: normalizeCampaignProfileConfig({
            ...current.config,
            telnyxCallerId:
              profilePhoneConfigValue(current.config.telnyxCallerId, defaults.telnyxCallerId),
            telnyxConnectionId:
              profilePhoneConfigValue(current.config.telnyxConnectionId, defaults.telnyxConnectionId),
          }),
        }))
      } catch {
        if (mounted) setNotice('Backend defaults could not be loaded.')
      }
    }

    void loadDefaults()

    return () => {
      mounted = false
    }
  }, [])

  const loadSpeakOptions = useCallback(async () => {
    const controller = new AbortController()
    speakOptionsRequestRef.current?.abort()
    speakOptionsRequestRef.current = controller
    setLoadingVoiceOptions(true)
    try {
      const response = await fetch(apiUrl('/agent-configs/speak-options'), {
        cache: 'no-store',
        signal: controller.signal,
      })
      const payload = (await response.json().catch(() => ({}))) as VoiceConfigOptionsPayload
      if (!response.ok) {
        throw new Error(payload.error || 'Speak options could not be loaded')
      }
      if (speakOptionsRequestRef.current !== controller) return
      const failedRuntimes = (['hume', 'inworld', 'xai'] as const).filter(
        (runtime) => Boolean(payload.providerErrors?.[runtime]),
      )
      setVoiceOptions((current) => ({
        eviVersions: mergeMissingVoiceFallback(
          retainFailedRuntimeOptions(payload.eviVersions, current.eviVersions, failedRuntimes),
          fallbackVoiceOptions.eviVersions,
        ),
        functionTools:
          payload.functionTools?.length
            ? payload.functionTools
            : current.functionTools.length
              ? current.functionTools
              : fallbackVoiceOptions.functionTools,
        codexAuthModels: mergeMissingVoiceFallback(
          retainFailedRuntimeOptions(
            payload.codexAuthModels,
            current.codexAuthModels,
            failedRuntimes,
          ),
          fallbackVoiceOptions.codexAuthModels,
        ),
        languageModels: mergeMissingVoiceFallback(
          retainFailedRuntimeOptions(
            payload.languageModels,
            current.languageModels,
            failedRuntimes,
          ),
          fallbackVoiceOptions.languageModels,
        ),
        voices: retainFailedRuntimeOptions(payload.voices, current.voices, failedRuntimes),
      }))
      if (failedRuntimes.length) {
        setNotice(
          `${failedRuntimes.map((runtime) => runtime === 'xai' ? 'xAI' : runtime === 'inworld' ? 'Inworld' : 'Hume').join(' and ')} provider options could not be refreshed. Showing the last available catalogue; retry from Settings.`,
        )
      }
    } catch {
      if (!controller.signal.aborted) {
        setVoiceOptions((current) => ({
          ...current,
          eviVersions: mergeMissingVoiceFallback(
            current.eviVersions,
            fallbackVoiceOptions.eviVersions,
          ),
          codexAuthModels: mergeMissingVoiceFallback(
            current.codexAuthModels,
            fallbackVoiceOptions.codexAuthModels,
          ),
          languageModels: mergeMissingVoiceFallback(
            current.languageModels,
            fallbackVoiceOptions.languageModels,
          ),
        }))
        setNotice('Provider options could not be refreshed. Showing the last available catalogue.')
      }
    } finally {
      if (speakOptionsRequestRef.current === controller) {
        speakOptionsRequestRef.current = null
        setLoadingVoiceOptions(false)
      }
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void Promise.resolve().then(() => {
      if (!cancelled) void loadSpeakOptions()
    })
    return () => {
      cancelled = true
      speakOptionsRequestRef.current?.abort()
    }
  }, [loadSpeakOptions])

  useEffect(() => {
    let cancelled = false
    void Promise.resolve().then(() => {
      if (!cancelled) {
        if (settingsOpen) void loadSpeakOptions()
      }
    })
    return () => {
      cancelled = true
    }
  }, [loadSpeakOptions, settingsOpen])

  useEffect(() => {
    const refreshSpeakOptions = () => void loadSpeakOptions()
    const refreshVisibleSpeakOptions = () => {
      if (document.visibilityState === 'visible') void loadSpeakOptions()
    }
    window.addEventListener('focus', refreshSpeakOptions)
    document.addEventListener('visibilitychange', refreshVisibleSpeakOptions)
    return () => {
      window.removeEventListener('focus', refreshSpeakOptions)
      document.removeEventListener('visibilitychange', refreshVisibleSpeakOptions)
    }
  }, [loadSpeakOptions])

  function updateDraftConfig(patch: Partial<CampaignConfig>, markDirty = true) {
    if (markDirty) {
      const keys = Object.keys(patch) as Array<keyof CampaignConfig>
      setDirtySections((current) => ({
        name: current.name,
        prompt:
          current.prompt || keys.some((key) => promptConfigKeys.has(key)),
        settings:
          current.settings || keys.some((key) => speakSettingsConfigKeys.has(key)),
        test: current.test,
        voice: current.voice || keys.some((key) => voiceConfigKeys.has(key)),
      }))
    }

    setDraft((current) => ({
      ...current,
      updatedAt: new Date().toISOString(),
      config: normalizeCampaignProfileConfig({
        ...current.config,
        ...patch,
        telnyxCallerId:
          profilePhoneConfigValue(
            patch.telnyxCallerId || current.config.telnyxCallerId,
            backendDefaults.telnyxCallerId,
          ),
        telnyxConnectionId:
          profilePhoneConfigValue(
            patch.telnyxConnectionId || current.config.telnyxConnectionId,
            backendDefaults.telnyxConnectionId,
          ),
      }),
    }))
  }

  function updateTestVariable(key: keyof AgentTestVariables, value: string) {
    setDirtySections((current) => ({
      ...current,
      test: true,
    }))
    setDraft((current) => ({
      ...current,
      updatedAt: new Date().toISOString(),
      testVariables: normalizeAgentTestVariables({
        ...current.testVariables,
        [key]: value,
      }),
    }))
  }

  function commitTestVariable(key: keyof AgentTestVariables) {
    if (key !== 'contact_phone') return
    setDraft((current) => {
      const currentValue = current.testVariables.contact_phone || ''
      const nextValue = normalizePhoneOnCommit(currentValue)
      if (nextValue === currentValue) return current
      return {
        ...current,
        updatedAt: new Date().toISOString(),
        testVariables: normalizeAgentTestVariables({
          ...current.testVariables,
          contact_phone: nextValue,
        }),
      }
    })
  }

  function updateDraftName(name: string) {
    const savedProfile = profiles.find((profile) => profile.id === draft.id)
    const baselineName = savedProfile?.name ?? draft.name
    const updatedAt = new Date().toISOString()
    setDirtySections((current) => ({
      ...current,
      name: current.name || name !== baselineName,
    }))
    setDraft((current) => ({
      ...current,
      name,
      updatedAt,
    }))
    setProfiles((current) =>
      current.map((profile) =>
        profile.id === draft.id
          ? normalizeAgentProfile({
              ...profile,
              name,
              updatedAt,
            })
          : profile,
      ),
    )
  }

  const focusAgentNameInput = useCallback(() => {
    window.requestAnimationFrame(() => {
      const input = agentNameInputRef.current
      if (!input) return
      input.focus()
      input.select()
    })
  }, [])

  function mergeVoicePayloadIntoProfile(
    profile: AgentConfigProfile,
    payload: VoiceConfigPayload,
  ) {
    const voiceConfig = payload.config || {}
    const inworldRuntime =
      voiceConfig.voiceRuntimeProvider === 'inworld' ||
      voiceConfig.languageModelMode === 'inworld' ||
      profile.config.voiceRuntimeProvider === 'inworld'
    const xaiRuntime =
      voiceConfig.voiceRuntimeProvider === 'xai' ||
      voiceConfig.languageModelMode === 'xai' ||
      profile.config.voiceRuntimeProvider === 'xai'
    const providerConfigId =
      payload.speakConfigId ||
      payload.humeConfigId ||
      payload.inworldConfigId ||
      payload.xaiConfigId ||
      voiceConfig.speakConfigId ||
      voiceConfig.humeConfigId ||
      voiceConfig.inworldConfigId ||
      voiceConfig.xaiConfigId

    return normalizeAgentProfile({
      ...profile,
      name: profile.name,
      updatedAt: new Date().toISOString(),
      config: {
        ...profile.config,
        ...voiceConfig,
        instructions:
          voiceConfig.languageModelMode === 'codex' && !voiceConfig.instructions
            ? profile.config.instructions
            : voiceConfig.instructions || profile.config.instructions,
        humeConfigId: inworldRuntime || xaiRuntime
          ? profile.config.humeConfigId
          : providerConfigId || profile.config.humeConfigId,
        inworldConfigId: inworldRuntime
          ? providerConfigId || profile.config.inworldConfigId
          : profile.config.inworldConfigId,
        xaiConfigId: xaiRuntime
          ? providerConfigId || profile.config.xaiConfigId
          : profile.config.xaiConfigId,
        speakConfigId:
          providerConfigId ||
          voiceConfig.speakConfigId ||
          profile.config.speakConfigId,
        humeConfigVersion:
          inworldRuntime || xaiRuntime
            ? profile.config.humeConfigVersion
            : payload.speakConfigVersion ??
              payload.humeConfigVersion ??
              voiceConfig.speakConfigVersion ??
              voiceConfig.humeConfigVersion ??
              profile.config.humeConfigVersion,
        inworldConfigVersion:
          inworldRuntime
            ? payload.speakConfigVersion ??
              payload.inworldConfigVersion ??
              voiceConfig.speakConfigVersion ??
              voiceConfig.inworldConfigVersion ??
              profile.config.inworldConfigVersion
            : profile.config.inworldConfigVersion,
        xaiConfigVersion:
          xaiRuntime
            ? payload.speakConfigVersion ??
              payload.xaiConfigVersion ??
              voiceConfig.speakConfigVersion ??
              voiceConfig.xaiConfigVersion ??
              profile.config.xaiConfigVersion
            : profile.config.xaiConfigVersion,
        telnyxCallerId:
          profilePhoneConfigValue(profile.config.telnyxCallerId, backendDefaults.telnyxCallerId),
        telnyxConnectionId:
          profilePhoneConfigValue(profile.config.telnyxConnectionId, backendDefaults.telnyxConnectionId),
        useConfigPrompt: true,
        useConfigTools: true,
      },
    })
  }

  const handleSmartConfigProfileApplied = useCallback(
    (payload: SmartConfigProfileAppliedPayload) => {
      const appliedProfile = payload.profile
        ? normalizeAgentProfile(payload.profile)
        : null
      const nextProfiles = payload.profiles?.length
        ? normalizeProfilePayload(payload.profiles)
        : appliedProfile
          ? [
              appliedProfile,
              ...profiles.filter((profile) => profile.id !== appliedProfile.id),
            ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
          : profiles
      const nextActiveId = payload.activeProfileId ?? activeId
      const nextDraft =
        (appliedProfile &&
          nextProfiles.find((profile) => profile.id === appliedProfile.id)) ||
        nextProfiles.find((profile) => profile.id === draft.id) ||
        appliedProfile

      saveAgentProfiles(nextProfiles)
      if (nextActiveId) {
        saveActiveAgentProfileId(nextActiveId)
      } else {
        clearActiveAgentProfileId()
      }
      setProfiles(nextProfiles)
      setActiveId(nextActiveId)
      if (nextDraft) setDraft(nextDraft)
      setDirtySections(cleanDirtySections)
      setNotice(
        `${nextDraft?.name || appliedProfile?.name || 'Profile'} updated by Smart Config.`,
      )
    },
    [activeId, draft.id, profiles, setDraft],
  )

  const smartConfigChat = useSmartConfigChat({
    onProfileApplied: handleSmartConfigProfileApplied,
    profileId: draft.id,
    profileName: draft.name,
  })

  async function refreshProfileFromHume(
    profile = draft,
    options: { silent?: boolean } = {},
  ) {
    const configId = String(
      profile.config?.voiceRuntimeProvider === 'xai'
        ? profile.config?.xaiConfigId || profile.config?.speakConfigId || ''
        : profile.config?.voiceRuntimeProvider === 'inworld'
          ? profile.config?.inworldConfigId || profile.config?.speakConfigId || ''
          : profile.config?.humeConfigId || profile.config?.speakConfigId || '',
    ).trim()
    if (!configId) {
      if (!options.silent) setNotice('Add a Speak config ID first.')
      return null
    }

    setLoadingVoiceConfig(true)
    if (!options.silent) setNotice('Loading latest Speak configuration...')

    try {
      const response = await fetch(
        apiUrl(`/agent-configs/speak/${encodeURIComponent(configId)}`),
      )
      const payload = (await response.json().catch(() => ({}))) as VoiceConfigPayload
      if (!response.ok || !(payload.speakConfigId || payload.humeConfigId || payload.inworldConfigId || payload.xaiConfigId)) {
        throw new Error(payload.error || 'Speak configuration could not be loaded')
      }

      const hydrated = mergeVoicePayloadIntoProfile(profile, payload)
      const profileExists = profiles.some((saved) => saved.id === hydrated.id)
      if (profileExists) {
        const next = [
          hydrated,
          ...profiles.filter((saved) => saved.id !== hydrated.id),
        ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        const persisted = await persistProfiles(next)
        const persistedProfile = persisted.profiles.find(
          (profile) => profile.id === hydrated.id,
        )
        setDraft(persistedProfile || hydrated)
      } else {
        setDraft(hydrated)
      }
      setDirtySections(cleanDirtySections)
      if (!options.silent) {
        setNotice(
          `${hydrated.name} loaded from Speak version ${
            payload.speakConfigVersion ?? payload.humeConfigVersion
          }.`,
        )
      }
      return hydrated
    } catch (error) {
      if (!options.silent) {
        setNotice(error instanceof Error ? error.message : 'Speak refresh failed.')
      }
      return null
    } finally {
      setLoadingVoiceConfig(false)
    }
  }

  async function refreshProfileAndOptions() {
    await Promise.all([refreshProfileFromHume(draft), loadSpeakOptions()])
  }

  function selectProfile(profile: AgentConfigProfile) {
    if (playgroundSessionActiveRef.current) {
      setNotice('Stop the Playground test before switching agents.')
      return
    }
    setDraft(profile)
    setDirtySections(cleanDirtySections)
    setNotice(`${profile.name} selected.`)
  }

  const newProfile = useCallback(() => {
    if (playgroundSessionActiveRef.current) {
      setNotice('Stop the Playground test before creating another agent.')
      return
    }
    setDraft(
      normalizeAgentProfile({
        name: 'New agent config',
        config: {
          ...defaultCampaignConfig,
          ...backendDefaults,
          telnyxCallerId:
            backendDefaults.telnyxCallerId || defaultCampaignConfig.telnyxCallerId,
          telnyxConnectionId:
            backendDefaults.telnyxConnectionId ||
            defaultCampaignConfig.telnyxConnectionId,
        },
      }),
    )
    setDirtySections(cleanDirtySections)
    setNotice('Name the new agent configuration.')
    focusAgentNameInput()
  }, [backendDefaults, focusAgentNameInput, setDraft])

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1))
    const wantsNewAgent =
      window.location.hash === '#new-agent' ||
      params.has('new-agent') ||
      params.get('agent') === 'new'
    if (wantsNewAgent) {
      const nextUrl = `${window.location.pathname}${window.location.search}`
      window.history.replaceState(null, '', nextUrl)
      const newTimer = window.setTimeout(() => newProfile(), 0)
      return () => window.clearTimeout(newTimer)
    }
    const profileId = params.get('profile')
    if (!profileId || draft.id === profileId) return
    const profile = profiles.find((item) => item.id === profileId)
    if (!profile) return
    const selectTimer = window.setTimeout(() => {
      setDraft(profile)
      setDirtySections(cleanDirtySections)
      setNotice(`${profile.name} selected.`)
    }, 0)
    return () => window.clearTimeout(selectTimer)
  }, [draft.id, newProfile, persistProfiles, profiles])

  async function saveProfile(
    options: SaveProfileOptions = {},
  ): Promise<AgentConfigProfile | null> {
    if (saveProfilePromiseRef.current) return saveProfilePromiseRef.current

    const savePromise = (async () => {
      const targetProfile = draft
      const ownedUpdates = options.forceProviderSync
        ? fullProviderSyncSections
        : dirtySections
      let workspaceSaved = false
      setSavingProfile(true)
      setNotice(options.status || 'Syncing Speak configuration...')

      try {
        const profileExists = profiles.some((profile) => profile.id === targetProfile.id)
        const prepared = normalizeAgentProfile({
          ...targetProfile,
          updatedAt: new Date().toISOString(),
          config: {
            ...targetProfile.config,
            telnyxCallerId:
              profilePhoneConfigValue(
                targetProfile.config.telnyxCallerId,
                backendDefaults.telnyxCallerId,
              ),
            telnyxConnectionId:
              profilePhoneConfigValue(
                targetProfile.config.telnyxConnectionId,
                backendDefaults.telnyxConnectionId,
              ),
          },
        })
        const provisionalProfiles = [
          prepared,
          ...profiles.filter((profile) => profile.id !== prepared.id),
        ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        const provisionalPersisted = await persistProfiles(provisionalProfiles, activeId)
        const workspaceProfile =
          provisionalPersisted.profiles.find((profile) => profile.id === prepared.id) ||
          prepared
        workspaceSaved = true
        setDraft(workspaceProfile)

        const response = await fetch(apiUrl('/agent-configs/sync-speak'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            profileId: workspaceProfile.id,
            profileName: workspaceProfile.name,
            config: workspaceProfile.config,
            createNew: !profileExists,
            ownedUpdates,
          }),
        })
        const payload = (await response.json().catch(() => ({}))) as VoiceConfigPayload

        if (!response.ok || !(payload.speakConfigId || payload.humeConfigId || payload.inworldConfigId)) {
          throw new Error(payload.error || 'Speak configuration sync failed')
        }

        const saved = mergeVoicePayloadIntoProfile(workspaceProfile, payload)

        const next = [
          saved,
          ...provisionalPersisted.profiles.filter((profile) => profile.id !== saved.id),
        ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))

        const persisted = await persistProfiles(next, activeId)
        const persistedProfile =
          persisted.profiles.find((profile) => profile.id === saved.id) || saved
        setDraft(persistedProfile)
        setDirtySections(cleanDirtySections)
        setNotice(`${saved.name} saved and Speak ${payload.action || 'synced'}.`)
        return persistedProfile
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Configuration save failed.'
        setNotice(
          workspaceSaved
            ? `Profile saved. Speak sync failed: ${message}`
            : message,
        )
        return null
      } finally {
        setSavingProfile(false)
        saveProfilePromiseRef.current = null
      }
    })()

    saveProfilePromiseRef.current = savePromise
    return savePromise
  }

  const promptTestVariableFields = testVariableFields.filter((field) =>
    promptReferencesTestVariable(draft.config.instructions, field),
  )

  function saveCurrentProfileFromControl() {
    if (!serverProfilesHydrated) {
      setNotice('Wait for saved agents to finish loading before saving.')
      return
    }
    void saveProfile({
      forceProviderSync: true,
      status: 'Saving Speak configuration...',
    })
  }

  function renderSaveProfileButton(className = '') {
    const saving = savingProfile || loadingVoiceConfig
    const disabled = saving || !serverProfilesHydrated
    return (
      <button
        className={[
          'icon-button',
          'config-profile-save-button',
          className,
        ]
          .filter(Boolean)
          .join(' ')}
        type="button"
        data-action-id={speakActionIds.saveProfile}
        disabled={disabled}
        title={
          !serverProfilesHydrated
            ? 'Loading saved agents'
            : savingProfile
              ? 'Saving profile'
              : 'Save profile'
        }
        aria-label={
          !serverProfilesHydrated
            ? 'Loading saved agents'
            : savingProfile
              ? 'Saving profile'
              : 'Save profile'
        }
        onClick={saveCurrentProfileFromControl}
      >
        {savingProfile ? <Activity size={15} /> : <Save size={15} />}
      </button>
    )
  }

  async function saveProfileForNextSession(label: string) {
    if (!serverProfilesHydrated) {
      setNotice(`${label} not started; saved agents are still loading.`)
      return null
    }

    const persistedProfile = profiles.find((profile) => profile.id === draft.id)
    const hasUnsavedChanges = Object.values(dirtySections).some(Boolean)
    if (persistedProfile && !hasUnsavedChanges) {
      return draft
    }

    const savedProfile = await saveProfile({
      status: `Saving ${draft.name || 'agent'} for ${label}...`,
    })
    if (!savedProfile) {
      setNotice(`${label} not started; profile save failed.`)
      return null
    }
    return savedProfile
  }

  function buildConfigurationTestConfig(profile = nextSessionProfileRef.current || draft) {
    return {
      ...profile.config,
      agentProfileId: profile.id,
      agentProfileName: profile.name,
      smartViewId:
        phoneTestMode === 'saved' && phoneTestSmartViewId
          ? phoneTestSmartViewId
          : profile.config.smartViewId,
      telnyxCallerId:
        profilePhoneConfigValue(profile.config.telnyxCallerId, backendDefaults.telnyxCallerId),
      telnyxConnectionId:
        profilePhoneConfigValue(profile.config.telnyxConnectionId, backendDefaults.telnyxConnectionId),
    }
  }

  function buildConfigurationPhoneTestConfig(
    profile: AgentConfigProfile,
    phoneNumber: string,
    connectionId: string,
  ) {
    return {
      ...buildConfigurationTestConfig(profile),
      // CallTools is campaign-follow transport only. Playground phone tests use
      // the explicitly selected Speak/Telnyx Call Control number without
      // changing the saved profile's campaign assignment.
      dialerProvider: 'speak' as const,
      phoneCallerId: phoneNumber,
      phoneConnectionId: connectionId,
      telnyxCallerId: phoneNumber,
      telnyxConnectionId: connectionId,
    }
  }

  function buildConfigurationTestVariables() {
    const selectedLead = selectedPlaygroundLead()
    return selectedLead ? leadToTestVariables(selectedLead) : normalizeAgentTestVariables({})
  }

  const {
    activeCall: phoneTestActiveCall,
    activeCallRef: phoneTestActiveCallRef,
    attemptId: testAttemptId,
    end: endPlaygroundTest,
    ending: testEnding,
    leadLabel: sessionLeadLabel,
    messageSending: playgroundMessageSending,
    mode: testMode,
    reset: resetPlaygroundTest,
    running: testRunning,
    sendMessage: sendPlaygroundMessage,
    sessionId: testSessionId,
    setActiveCall: setPhoneTestActiveCall,
    setStatus: setTestStatus,
    start: startBrowserTest,
    startPhone: startPhoneTest,
    startedAt: testStartedAt,
    starting: testStarting,
    status: testStatus,
    transcript: testTranscript,
  } = useConfigurationTestSession({
    buildStartPayload: () => {
      return {
        config: buildConfigurationTestConfig(),
        lead: selectedPlaygroundLead() || undefined,
        productionContext: true,
        testVariables: buildConfigurationTestVariables(),
        testVariableKeys: testVariableFields.map((field) => field.key),
      }
    },
    onPhoneEnded: () => stopPhoneTestHumanAudioStreamRef.current(),
  })
  const {
    error: phoneProviderError,
    loading: phoneProviderLoading,
    options: phoneProviderOptions,
  } = usePhoneProviderOptions(phoneTestPickerOpen)

  const missingTestVariableCount = promptTestVariableFields.filter(
    (field) => !String(buildConfigurationTestVariables()[field.key] || '').trim(),
  ).length
  const browserTestStatus =
    !testRunning &&
    !testStarting &&
    testStatus === 'Test idle' &&
    missingTestVariableCount
      ? `${missingTestVariableCount} test variables unset`
      : testStatus
  const browserTestCanStop =
    testMode === 'browser' && (testRunning || Boolean(testSessionId))
  const phoneTestActive =
    testMode === 'phone' && (testRunning || testStarting || Boolean(testSessionId))
  const playgroundSessionActive =
    testRunning || testStarting || testEnding || Boolean(testSessionId)
  useEffect(() => {
    playgroundSessionActiveRef.current = playgroundSessionActive
  }, [playgroundSessionActive])
  const testStartDisabled = !serverProfilesHydrated || playgroundSessionActive
  const testToggleDisabled = browserTestCanStop ? false : testStartDisabled
  const profileSwitchDisabled = !serverProfilesHydrated || playgroundSessionActive
  const phoneTestLeadOptions = workspaceLeads
  const selectedPhoneTestSmartView =
    smartViews.find((view) => view.id === phoneTestSmartViewId) || null
  const selectedPhoneTestLead =
    phoneTestLeadOptions.find((lead) => lead.id === phoneTestLeadId) ||
    phoneTestLeadOptions[0] ||
    null
  const phoneTestLeadSelectState = useMemo(() => {
    const visibleLeads = phoneTestLeadOptions.slice(0, playgroundContactOptionLimit)
    if (
      selectedPhoneTestLead &&
      !visibleLeads.some((lead) => lead.id === selectedPhoneTestLead.id)
    ) {
      visibleLeads.unshift(selectedPhoneTestLead)
    }
    return {
      hiddenCount: Math.max(
        0,
        phoneTestLeadMatchedCount - playgroundContactOptionLimit,
      ),
      leads: visibleLeads,
      matchedCount: Math.max(phoneTestLeadMatchedCount, visibleLeads.length),
    }
  }, [phoneTestLeadMatchedCount, phoneTestLeadOptions, selectedPhoneTestLead])
  const phoneTestMissingSavedLead = phoneTestMode === 'saved' && !selectedPhoneTestLead
  const phoneTestCandidate =
    phoneTestMode === 'saved' ? selectedPhoneTestLead : adHocVariablesToLead(adHocTestLead)
  const phoneTestHasDestination = Boolean(
    phoneTestCandidate && isValidPhoneNumber(phoneTestCandidate.phone),
  )
  const configuredPhoneNumber = normalizePhoneNumber(
    profilePhoneConfigValue(
      draft.config.telnyxCallerId || draft.config.phoneCallerId,
      backendDefaults.telnyxCallerId || backendDefaults.phoneCallerId,
    ),
  )
  const selectedPhoneProviderOption =
    phoneProviderOptions.numbers.find(
      (option) => normalizePhoneNumber(option.phoneNumber) === configuredPhoneNumber,
    ) ||
    phoneProviderOptions.defaultNumber ||
    phoneProviderOptions.numbers[0] ||
    null
  const selectedPhoneNumber = normalizePhoneNumber(
    selectedPhoneProviderOption?.phoneNumber || configuredPhoneNumber,
  )
  const selectedPhoneConnectionId = String(
    selectedPhoneProviderOption?.connectionId ||
      backendDefaults.telnyxConnectionId ||
      '',
  ).trim()
  const phoneTestReadiness = (() => {
    if (!phoneTestHasDestination) {
      return { ready: false, message: 'Choose a contact with a valid phone number.' }
    }
    if (phoneProviderLoading) {
      return { ready: false, message: 'Loading Speak outbound numbers…' }
    }
    if (!phoneProviderOptions.configured || phoneProviderOptions.numbers.length === 0) {
      return {
        ready: false,
        message: phoneProviderError || 'No Speak/Telnyx outbound number is available.',
      }
    }
    if (!selectedPhoneNumber) {
      return { ready: false, message: 'Choose a Speak/Telnyx outbound number.' }
    }
    if (!selectedPhoneConnectionId) {
      return {
        ready: false,
        message: 'The workspace Call Control connection is not configured.',
      }
    }
    return {
      ready: true,
      message: `Phone tests call from ${selectedPhoneNumber} through Speak/Telnyx.`,
    }
  })()
  const phoneTestCanStart = serverProfilesHydrated && phoneTestReadiness.ready
  const phoneTestLiveControlReady = Boolean(
    phoneTestActiveCall?.callControlId &&
      phoneTestActiveCall.chatId &&
      phoneTestActiveCall.streamId,
  )
  const {
    bargeIn: bargeInPhoneTest,
    stopHumanAudioStream: stopPhoneTestHumanAudioStream,
  } = useHumanTakeover({
    activeCall: phoneTestActiveCall,
    activeCallRef: phoneTestActiveCallRef,
    activeLead: phoneTestCandidate,
    controlsLocked: phoneTestTakeoverBusy !== 'idle',
    sampleRate: Number(
      draft.config.sampleRate ||
        backendDefaults.sampleRate ||
        defaultCampaignConfig.sampleRate,
    ),
    setActiveCall: setPhoneTestActiveCall,
    setBusy: setPhoneTestTakeoverBusy,
    setNotice: setTestStatus,
    updateLead: () => undefined,
  })
  useEffect(() => {
    stopPhoneTestHumanAudioStreamRef.current = stopPhoneTestHumanAudioStream
  }, [stopPhoneTestHumanAudioStream])
  const {
    audioWhisperAvailable,
    cancelAudioWhisper,
    connected: phoneSupervisionConnected,
    ensureSpy: ensurePhoneTestSpy,
    spyBusy: phoneTestSpyBusy,
    spyEnabled: phoneTestSpyEnabled,
    toggleAudioWhisper,
    toggleSpy: togglePhoneTestSpy,
    whisperState: phoneTestWhisperState,
  } = usePlaygroundCallSupervision({
    activeCall: phoneTestActiveCall,
    enabled: phoneTestActive,
    setNotice: setTestStatus,
  })

  async function togglePhoneTestBarge() {
    if (!phoneTestActiveCall?.takeover) {
      cancelAudioWhisper()
      if (!(await ensurePhoneTestSpy())) return
    }
    await bargeInPhoneTest()
  }
  const visibleTestStatus = testMode === 'idle' ? browserTestStatus : testStatus
  const visibleTestTranscript = testTranscript
  const visibleTestAgentLabel = draft.name || 'Agent'
  const visibleTestLeadLabel =
    testMode === 'phone'
      ? sessionLeadLabel ||
        (phoneTestCandidate ? leadTranscriptLabel(phoneTestCandidate) : '') ||
        'Test contact'
      : sessionLeadLabel ||
        testVariablesTranscriptLabel(buildConfigurationTestVariables()) ||
        testVariablesTranscriptLabel(draft.testVariables) ||
        'Test contact'
  const currentVisibleLiveTestId = testSessionId || testAttemptId || visibleLiveTestId
  const visibleHistoryThreads = playgroundThreads.filter(
    (thread) =>
      !currentVisibleLiveTestId ||
      visibleTestTranscript.length === 0 ||
      thread.id !== currentVisibleLiveTestId,
  )
  const playgroundSubtitle = playgroundHistoryLoading
    ? 'Loading test history'
    : [
        visibleTestStatus,
        `${visibleHistoryThreads.length} saved tests`,
        `${visibleHistoryThreads.filter((thread) => thread.communicationThreadId).length} threaded`,
        notice,
      ]
        .filter(Boolean)
        .join(' / ')

  useEffect(() => {
    if (profileContextIdRef.current === draft.id) return
    profileContextIdRef.current = draft.id

    const resetTimer = window.setTimeout(() => {
      setPhoneTestPickerOpen(false)
      setPlaygroundThreads([])
      setVisibleLiveTestId('')

      if (playgroundSessionActive) {
        void endPlaygroundTest()
      } else {
        resetPlaygroundTest()
      }
    }, 0)

    return () => window.clearTimeout(resetTimer)
  }, [
    draft.id,
    endPlaygroundTest,
    playgroundSessionActive,
    resetPlaygroundTest,
  ])

  const refreshPlaygroundThreads = useCallback(async () => {
    setPlaygroundHistoryLoading(true)
    try {
      setPlaygroundThreads(await fetchConfigTestThreads(draft.id, draft.name))
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Test history failed')
    } finally {
      setPlaygroundHistoryLoading(false)
    }
  }, [draft.id, draft.name])

  async function deletePlaygroundThreads(ids: string[]) {
    const callControlIds = Array.from(new Set(ids.filter(Boolean)))
    if (callControlIds.length === 0) return
    setPlaygroundThreads((current) =>
      current.filter((thread) => !callControlIds.includes(thread.id)),
    )
    try {
      const response = await fetch(apiUrl('/calls/delete'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: callControlIds }),
      })
      const payload = (await response.json().catch(() => ({}))) as {
        deleted?: string[]
        error?: string
      }
      if (!response.ok) throw new Error(payload.error || 'Saved test delete failed')
      const deleted = payload.deleted || callControlIds
      setPlaygroundThreads((current) =>
        current.filter((thread) => !deleted.includes(thread.id)),
      )
      setNotice(`${deleted.length} saved test${deleted.length === 1 ? '' : 's'} deleted.`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Saved test delete failed.')
      void refreshPlaygroundThreads()
    }
  }

  useEffect(() => {
    let mounted = true

    async function hydratePlaygroundThreads() {
      try {
        const nextThreads = await fetchConfigTestThreads(draft.id, draft.name)
        if (mounted) setPlaygroundThreads(nextThreads)
      } catch (error) {
        if (mounted) {
          setNotice(error instanceof Error ? error.message : 'Test history failed')
        }
      }
    }

    void hydratePlaygroundThreads()
    return () => {
      mounted = false
    }
  }, [draft.id, draft.name])

  function adHocVariablesToLead(values: AgentTestVariables): Lead {
    const fullName =
      values.full_name ||
      [values.first_name, values.last_name].filter(Boolean).join(' ') ||
      'Ad hoc test contact'
    const nameParts = splitLeadName(fullName)
    return {
      id: 'config-phone-test-ad-hoc',
      firstName: values.first_name || nameParts.firstName,
      lastName: values.last_name || nameParts.lastName,
      name: fullName,
      company: values.business_name || fullName,
      phone: values.contact_phone,
      email: values.contact_email,
      state: 'NA',
      tags: ['config-test'],
      score: 70,
      status: 'ready',
      lastCall: 'Never',
      notes: values.notes,
    }
  }

  function selectedPlaygroundLead(): Lead | null {
    const savedLead =
      workspaceLeads.find((lead) => lead.id === phoneTestLeadId) ||
      workspaceLeads[0] ||
      null
    return phoneTestMode === 'saved' ? savedLead : adHocVariablesToLead(adHocTestLead)
  }

  function leadToTestVariables(lead: Lead): AgentTestVariables {
    return normalizeAgentTestVariables({
      first_name: lead.firstName,
      last_name: lead.lastName,
      full_name: lead.name,
      business_name: lead.company,
      contact_phone: lead.phone,
      contact_email: lead.email,
      notes: lead.notes,
    })
  }

  async function endPhoneConfigTest() {
    const activeTestId = testSessionId || testAttemptId || visibleLiveTestId
    if (activeTestId) setVisibleLiveTestId(activeTestId)
    stopPhoneTestHumanAudioStream()
    await endPlaygroundTest()
    void refreshPlaygroundThreads()
  }

  async function endConfigBrowserTest() {
    const activeTestId = testSessionId || testAttemptId || visibleLiveTestId
    if (activeTestId) setVisibleLiveTestId(activeTestId)
    await endPlaygroundTest()
    void refreshPlaygroundThreads()
  }

  async function startConfigPhoneTest() {
    if (!serverProfilesHydrated) {
      setTestStatus('Wait for saved agents to finish loading before starting a phone test.')
      return
    }
    if (playgroundSessionActive) return

    const lead = selectedPlaygroundLead()
    if (!lead) {
      setTestStatus('Choose a saved contact before starting the phone test.')
      return
    }
    if (phoneTestMode === 'saved') {
      writePlaygroundPhoneSmartViewId(phoneTestSmartViewId)
      if (selectedPhoneTestLead) {
        writePlaygroundPhoneLeadId(selectedPhoneTestLead.id)
      }
    }

    if (!isValidPhoneNumber(lead.phone)) {
      setTestStatus('Enter a valid E.164 phone number for the phone test.')
      return
    }
    if (!phoneTestReadiness.ready) {
      setTestStatus(phoneTestReadiness.message)
      return
    }

    const savedProfile = await saveProfileForNextSession('phone test')
    if (!savedProfile) return
    const nextTestId = await startPhoneTest({
      lead,
      config: buildConfigurationPhoneTestConfig(
        savedProfile,
        selectedPhoneNumber,
        selectedPhoneConnectionId,
      ),
    })
    if (nextTestId) setVisibleLiveTestId(nextTestId)
  }

  async function startConfigBrowserTest() {
    if (!serverProfilesHydrated) {
      setNotice('Wait for saved agents to finish loading before starting a browser test.')
      setPhoneTestPickerOpen(false)
      return
    }
    const lead = selectedPlaygroundLead()
    if (!lead) {
      setNotice('Choose a saved contact before starting the browser test.')
      setPhoneTestPickerOpen(false)
      return
    }
    setPhoneTestPickerOpen(false)
    if (phoneTestActive) await endPhoneConfigTest()
    const savedProfile = await saveProfileForNextSession('browser test')
    if (!savedProfile) return
    nextSessionProfileRef.current = savedProfile
    if (missingTestVariableCount) {
      setNotice(
        `${missingTestVariableCount} test variables blank; starting with blank values.`,
      )
    }
    try {
      const nextTestId = await startBrowserTest()
      if (nextTestId) {
        setVisibleLiveTestId(nextTestId)
      }
    } finally {
      nextSessionProfileRef.current = null
    }
  }
  const dirtyLabels = [
    dirtySections.name ? 'name' : '',
    dirtySections.prompt ? 'prompt' : '',
    dirtySections.settings ? 'settings' : '',
    dirtySections.test && promptTestVariableFields.length ? 'test variables' : '',
    dirtySections.voice ? 'voice' : '',
  ].filter(Boolean)
  const hasUnsavedProfileChanges = dirtyLabels.length > 0

  function commitAgentName() {
    const trimmedName = draft.name.trim()
    if (!trimmedName) {
      updateDraftName('Untitled agent')
      setNotice('Agent name required.')
      return
    }
    if (hasUnsavedProfileChanges) {
      setNotice('Unsaved profile changes')
    }
  }

  const visibleProfiles = useMemo(() => {
    return [...profiles].sort((left, right) => {
      if (left.id === draft.id) return -1
      if (right.id === draft.id) return 1
      return right.updatedAt.localeCompare(left.updatedAt)
    })
  }, [draft.id, profiles])
  const promptAgentProfiles = useMemo(() => {
    if (visibleProfiles.some((profile) => profile.id === draft.id)) {
      return visibleProfiles
    }
    return [draft, ...visibleProfiles]
  }, [draft, visibleProfiles])

  async function selectGlobalPromptProfile(profile: AgentConfigProfile) {
    if (!profile) return
    selectProfile(profile)
  }

  const selectedVisibleProfileCount = visibleProfiles.filter((profile) =>
    selectedProfileIds.has(profile.id),
  ).length
  const allVisibleProfilesSelected =
    visibleProfiles.length > 0 &&
    selectedVisibleProfileCount === visibleProfiles.length
  const someVisibleProfilesSelected = selectedVisibleProfileCount > 0
  const profileSelectionState = allVisibleProfilesSelected
    ? 'selected'
    : someVisibleProfilesSelected
      ? 'mixed'
      : ''

  function toggleProfileSelection(id: string) {
    setSelectedProfileIds((current) => {
      const next = new Set(current)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  function toggleAllVisibleProfiles() {
    setSelectedProfileIds((current) => {
      const visibleIds = visibleProfiles.map((profile) => profile.id)
      const next = new Set(current)
      visibleIds.forEach((id) => {
        if (allVisibleProfilesSelected) {
          next.delete(id)
        } else {
          next.add(id)
        }
      })
      return next
    })
  }

  function clearSelectedProfiles() {
    setSelectedProfileIds(new Set())
  }

  async function duplicateSelectedProfiles() {
    if (savingProfile || loadingVoiceConfig) return
    if (playgroundSessionActiveRef.current) {
      setNotice('Stop the Playground test before copying agents.')
      return
    }

    const selectedProfiles = profiles.filter((profile) => selectedProfileIds.has(profile.id))
    if (selectedProfiles.length === 0) return
    const copies = selectedProfiles.map((profile) =>
      normalizeAgentProfile({
        ...profile,
        id: createAgentConfigId(),
        name: `${profile.name} copy`,
        updatedAt: new Date().toISOString(),
      }),
    )
    const next = [...copies, ...profiles].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    )
    setSavingProfile(true)
    setNotice(`Copying ${copies.length} agent${copies.length === 1 ? '' : 's'}...`)

    try {
      const persisted = await persistProfiles(next)
      setSelectedProfileIds(new Set(copies.map((profile) => profile.id)))
      setDraft(
        persisted.profiles.find((profile) => profile.id === copies[0].id) || copies[0],
      )
      setDirtySections(cleanDirtySections)
      setNotice(`${copies.length} agent${copies.length === 1 ? '' : 's'} copied.`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Profile copy failed.')
    } finally {
      setSavingProfile(false)
    }
  }

  async function deleteSelectedProfiles() {
    if (savingProfile || loadingVoiceConfig) return
    if (playgroundSessionActiveRef.current) {
      setNotice('Stop the Playground test before deleting agents.')
      return
    }

    const selectedIds = new Set(selectedProfileIds)
    if (selectedIds.size === 0) {
      setNotice('Select an agent to delete.')
      return
    }

    const next = profiles.filter((profile) => !selectedIds.has(profile.id))
    const nextActiveId =
      selectedIds.has(activeId) || selectedIds.has(draft.id)
        ? next[0]?.id || ''
        : activeId
    setSavingProfile(true)
    setNotice(`Deleting ${selectedIds.size} agent${selectedIds.size === 1 ? '' : 's'}...`)

    try {
      const persisted = await persistProfiles(next, nextActiveId)
      setSelectedProfileIds(new Set())
      if (selectedIds.has(draft.id)) {
        const nextDraft =
          persisted.profiles.find(
            (profile) => profile.id === persisted.activeProfileId,
          ) ||
          persisted.profiles[0] ||
          normalizeAgentProfile({
            name: 'New agent config',
            config: { ...defaultCampaignConfig, ...backendDefaults },
          })
        setDraft(nextDraft)
        setDirtySections(cleanDirtySections)
      }
      setNotice(`${selectedIds.size} agent${selectedIds.size === 1 ? '' : 's'} deleted.`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Profile delete failed.')
    } finally {
      setSavingProfile(false)
    }
  }

  function renderPromptPanel(extraClassName = '') {
    const inlinePrompt = extraClassName.includes('config-prompt-panel-inline')

    return (
      <section
        className={[
          'config-prompt-panel',
          extraClassName,
        ]
          .filter(Boolean)
          .join(' ')}
        aria-label="Agent prompt"
      >
        {!inlinePrompt && (
          <div className="panel-heading compact-heading config-prompt-heading">
            <div className="transcript-heading-copy config-prompt-title">
              <h2>Prompt</h2>
            </div>
          </div>
        )}
        <textarea
          aria-label="System message"
          autoCapitalize="sentences"
          autoComplete="off"
          autoCorrect="on"
          enterKeyHint="enter"
          inputMode="text"
          disabled={!serverProfilesHydrated || savingProfile || loadingVoiceConfig}
          placeholder="Tell the agent exactly how to handle this call flow..."
          value={draft.config.instructions || ''}
          onChange={(event) =>
            updateDraftConfig({ instructions: event.target.value })
          }
        />
      </section>
    )
  }

  const activePlaygroundSource =
    mobilePromptOpen ? 'prompt' : playgroundMode === 'smart' ? 'smart' : 'speak'
  const activePlaygroundSourceLabel =
    activePlaygroundSource === 'prompt'
      ? 'Prompt'
      : activePlaygroundSource === 'smart'
        ? 'Smart Config'
        : 'Speak'

  function selectPlaygroundSource(source: 'speak' | 'smart' | 'prompt') {
    if (!serverProfilesHydrated) {
      setNotice('Wait for saved agents to finish loading.')
      return
    }
    setPlaygroundSourceMenuOpen(false)
    setPhoneTestPickerOpen(false)
    if (source === 'prompt') {
      setMobilePromptOpen(true)
      return
    }

    setMobilePromptOpen(false)
    setPlaygroundMode(source === 'smart' ? 'smart' : 'test')
  }

  function playgroundSourceIcon(source: 'speak' | 'smart' | 'prompt') {
    if (source === 'smart') return <CodexAppIcon />
    if (source === 'prompt') return <FileText size={16} />
    return <SpeakLogoMark />
  }

  const playgroundSourceAccessory = (
    <div
      className="playground-source-switch"
      ref={playgroundSourceMenuRef}
      data-current-source={activePlaygroundSource}
      data-source-menu-open={playgroundSourceMenuOpen ? 'true' : 'false'}
    >
      <button
        className={[
          'playground-source-trigger',
          activePlaygroundSource,
          playgroundSourceMenuOpen ? 'active' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        type="button"
        disabled={!serverProfilesHydrated}
        data-action-id={
          activePlaygroundSource === 'smart'
            ? speakActionIds.openSmartConfig
            : activePlaygroundSource === 'prompt'
              ? speakActionIds.togglePrompt
              : speakActionIds.openSpeakPlayground
        }
        title={`Choose console source: ${activePlaygroundSourceLabel}`}
        aria-label={`Choose console source: ${activePlaygroundSourceLabel}`}
        aria-haspopup="menu"
        aria-expanded={playgroundSourceMenuOpen}
        onClick={() => {
          setPhoneTestPickerOpen(false)
          setPlaygroundSourceMenuOpen((current) => !current)
        }}
      >
        {playgroundSourceIcon(activePlaygroundSource)}
        <span className="visually-hidden">{activePlaygroundSourceLabel}</span>
      </button>
      {playgroundSourceMenuOpen && (
        <div
          className="playground-source-menu"
          role="menu"
          aria-label="Select console source"
        >
          <button
            className={[
              'playground-source-option',
              activePlaygroundSource === 'speak' ? 'active' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            type="button"
            role="menuitemradio"
            data-action-id={speakActionIds.openSpeakPlayground}
            aria-checked={activePlaygroundSource === 'speak'}
            title="Show Speak playground"
            aria-label="Show Speak playground"
            onClick={() => selectPlaygroundSource('speak')}
          >
            {playgroundSourceIcon('speak')}
            <span className="visually-hidden">Speak</span>
          </button>
          <button
            className={[
              'playground-source-option',
              'smart',
              activePlaygroundSource === 'smart' ? 'active' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            type="button"
            role="menuitemradio"
            data-action-id={speakActionIds.openSmartConfig}
            aria-checked={activePlaygroundSource === 'smart'}
            title="Show Smart Config"
            aria-label="Show Smart Config"
            onClick={() => selectPlaygroundSource('smart')}
          >
            {playgroundSourceIcon('smart')}
            <span className="visually-hidden">Smart Config</span>
          </button>
          <button
            className={[
              'playground-source-option',
              'prompt',
              activePlaygroundSource === 'prompt' ? 'active' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            type="button"
            role="menuitemradio"
            data-action-id={speakActionIds.togglePrompt}
            aria-checked={activePlaygroundSource === 'prompt'}
            title="Show prompt"
            aria-label="Show prompt"
            onClick={() => selectPlaygroundSource('prompt')}
          >
            {playgroundSourceIcon('prompt')}
            <span className="visually-hidden">Prompt</span>
          </button>
        </div>
      )}
    </div>
  )

  const playgroundAgentPicker = (
    <AgentProfilePicker
      className="config-playground-agent-picker"
      disabled={savingProfile || loadingVoiceConfig || profileSwitchDisabled}
      onNewProfile={() => {
        setPhoneTestPickerOpen(false)
        setPlaygroundSourceMenuOpen(false)
        newProfile()
      }}
      onSelectProfile={(profile) => {
        setPhoneTestPickerOpen(false)
        setPlaygroundSourceMenuOpen(false)
        void selectGlobalPromptProfile(profile)
      }}
      profiles={promptAgentProfiles}
      searchable={false}
      selectedId={draft.id}
      value={draft.name}
    />
  )

  const playgroundHeaderActions = (
    <>
      <div className="config-test-mode-group" aria-label="Test mode controls">
        <DeviceCallButton
          className="config-device-call-button"
          lead={phoneTestCandidate}
          disabled={!phoneTestHasDestination}
        />
        <div className="config-call-test-menu" ref={phoneTestMenuRef}>
          <button
            className={[
              'icon-button',
              'transcript-action-button',
              'config-test-action-button',
              'config-call-action-button',
              browserTestCanStop || phoneTestActive ? 'active' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            type="button"
            data-action-id={
              phoneTestActive
                ? speakActionIds.stopConfigPhoneTest
                : browserTestCanStop
                  ? speakActionIds.stopConfigTest
                  : speakActionIds.startConfigTest
            }
            disabled={
              phoneTestActive || browserTestCanStop
                ? false
                : !serverProfilesHydrated ||
                  testStarting ||
                  testEnding ||
                  savingProfile ||
                  loadingVoiceConfig
            }
            title={
              phoneTestActive
                ? 'Stop phone test'
                : browserTestCanStop
                  ? 'Stop browser test'
                  : 'Choose call test'
            }
            aria-label={
              phoneTestActive
                ? 'Stop phone test'
                : browserTestCanStop
                  ? 'Stop browser test'
                  : 'Choose call test'
            }
            aria-expanded={phoneTestPickerOpen}
            aria-pressed={browserTestCanStop || phoneTestActive}
            data-testid={speakTestIds.configTestToggle}
            onClick={() => {
              setMobilePromptOpen(false)
              setPlaygroundMode('test')
              setPlaygroundSourceMenuOpen(false)
              if (phoneTestActive) {
                setPhoneTestPickerOpen(false)
                void endPhoneConfigTest()
                return
              }
              if (browserTestCanStop) {
                setPhoneTestPickerOpen(false)
                void endConfigBrowserTest()
                return
              }
              setPhoneTestPickerOpen((current) => !current)
            }}
          >
            <Phone
              className={phoneTestActive || browserTestCanStop ? 'call-button-icon-hangup' : ''}
              size={18}
            />
            <span>{phoneTestActive || browserTestCanStop ? 'Stop' : 'Call'}</span>
          </button>
          {phoneTestPickerOpen && !phoneTestActive && !browserTestCanStop && (
            <div
              className="config-phone-test-popover"
              role="menu"
              aria-label="Call test options"
            >
              <div
                className="config-phone-test-mode"
                role="group"
                aria-label="Phone test contact mode"
              >
                <button
                  type="button"
                  className={phoneTestMode === 'saved' ? 'active' : ''}
                  aria-pressed={phoneTestMode === 'saved'}
                  onClick={() => setPhoneTestMode('saved')}
                >
                  Saved
                </button>
                <button
                  type="button"
                  className={phoneTestMode === 'adHoc' ? 'active' : ''}
                  aria-pressed={phoneTestMode === 'adHoc'}
                  onClick={() => setPhoneTestMode('adHoc')}
                >
                  New
                </button>
              </div>
              {phoneTestMode === 'saved' ? (
                <div className="config-phone-test-saved">
                  <label className="config-field config-phone-test-smart-view">
                    <span>Smart View</span>
                    <select
                      value={phoneTestSmartViewId}
                      onChange={(event) => {
                        const nextSmartViewId = event.target.value
                        setPhoneTestSmartViewId(nextSmartViewId)
                        setPhoneTestLeadQuery('')
                        writePlaygroundPhoneSmartViewId(nextSmartViewId)
                        setPhoneTestLeadId('')
                        writePlaygroundPhoneLeadId('')
                      }}
                    >
                      <option value="">All saved contacts</option>
                      {smartViews.map((smartView) => (
                        <option key={smartView.id} value={smartView.id}>
                          {smartView.name} / {smartView.leadCount || smartView.leadIds.length} contacts
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="config-field config-phone-test-lead">
                    <span>Contact</span>
                    <input
                      autoCapitalize="words"
                      autoComplete="off"
                      autoCorrect="off"
                      enterKeyHint="search"
                      inputMode="search"
                      placeholder="Find contact"
                      type="search"
                      value={phoneTestLeadQuery}
                      onChange={(event) => setPhoneTestLeadQuery(event.target.value)}
                    />
                    <select
                      value={selectedPhoneTestLead?.id || ''}
                      disabled={phoneTestLeadOptions.length === 0}
                      onChange={(event) => {
                        setPhoneTestLeadId(event.target.value)
                        writePlaygroundPhoneLeadId(event.target.value)
                      }}
                    >
                      {phoneTestLeadOptions.length === 0 && (
                        <option value="">
                          {selectedPhoneTestSmartView
                            ? 'No contacts in this Smart View'
                            : phoneTestLeadsLoading
                              ? 'Loading contacts'
                              : 'No saved contacts'}
                        </option>
                      )}
                      {phoneTestLeadSelectState.leads.map((lead) => (
                        <option key={lead.id} value={lead.id}>
                          {lead.company || lead.name} / {lead.phone || 'No phone'}
                        </option>
                      ))}
                    </select>
                    {phoneTestLeadSelectState.hiddenCount > 0 && (
                      <em className="config-phone-test-result-count">
                        {phoneTestLeadSelectState.leads.length}/{phoneTestLeadSelectState.matchedCount}
                      </em>
                    )}
                  </label>
                </div>
              ) : (
                <div className="config-phone-test-ad-hoc">
                  <label className="config-field">
                    <span>Business</span>
                    <input
                      autoCapitalize="words"
                      autoComplete="organization"
                      autoCorrect="on"
                      enterKeyHint="next"
                      inputMode="text"
                      value={adHocTestLead.business_name}
                      onChange={(event) =>
                        setAdHocTestLead((current) => ({
                          ...current,
                          business_name: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <label className="config-field">
                    <span>Contact</span>
                    <input
                      autoCapitalize="words"
                      autoComplete="name"
                      autoCorrect="on"
                      enterKeyHint="next"
                      inputMode="text"
                      value={adHocTestLead.full_name}
                      onChange={(event) =>
                        setAdHocTestLead((current) => ({
                          ...current,
                          full_name: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <label className="config-field">
                    <span>Phone</span>
                    <div
                      className={[
                        'phone-input-shell',
                        adHocTestLead.contact_phone &&
                        !isValidPhoneNumber(adHocTestLead.contact_phone)
                          ? 'invalid'
                          : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      <input
                        autoComplete="tel"
                        enterKeyHint="done"
                        inputMode="tel"
                        type="tel"
                        value={adHocTestLead.contact_phone}
                        onBlur={() =>
                          setAdHocTestLead((current) => ({
                            ...current,
                            contact_phone: normalizePhoneOnCommit(current.contact_phone),
                          }))
                        }
                        onChange={(event) =>
                          setAdHocTestLead((current) => ({
                            ...current,
                            contact_phone: event.target.value,
                          }))
                        }
                      />
                      <CopyAction
                        className="phone-input-action"
                        disabled={!adHocTestLead.contact_phone.trim()}
                        label="Copy phone"
                        value={
                          normalizePhoneNumber(adHocTestLead.contact_phone) ||
                          adHocTestLead.contact_phone.trim()
                        }
                      />
                      <SmsFieldActions
                        disabled={!isValidPhoneNumber(adHocTestLead.contact_phone)}
                        onOpenAgentSms={() => setAdHocSmsComposerOpen(true)}
                        phone={
                          normalizePhoneNumber(adHocTestLead.contact_phone) ||
                          adHocTestLead.contact_phone.trim()
                        }
                      />
                    </div>
                    {adHocSmsComposerOpen && (
                      <ContactDeliveryComposer
                        channel="sms"
                        contactLabel={
                          adHocTestLead.business_name ||
                          adHocTestLead.full_name ||
                          'Ad hoc test contact'
                        }
                        lead={adHocVariablesToLead(adHocTestLead)}
                        onClose={() => setAdHocSmsComposerOpen(false)}
                        phone={
                          normalizePhoneNumber(adHocTestLead.contact_phone) ||
                          adHocTestLead.contact_phone.trim()
                        }
                      />
                    )}
                  </label>
                </div>
              )}
              <label className="config-field config-phone-test-from">
                <span>Speak/Telnyx phone-test caller ID</span>
                <select
                  aria-label="Speak/Telnyx phone-test caller ID"
                  value={selectedPhoneNumber}
                  disabled={phoneProviderLoading || phoneProviderOptions.numbers.length === 0}
                  onChange={(event) => {
                    const selected = phoneProviderOptions.numbers.find(
                      (option) =>
                        normalizePhoneNumber(option.phoneNumber) === event.target.value,
                    )
                    if (!selected) return
                    const phoneNumber = normalizePhoneNumber(selected.phoneNumber)
                    const connectionId = String(
                      selected.connectionId ||
                        backendDefaults.telnyxConnectionId ||
                        '',
                    ).trim()
                    updateDraftConfig({
                      phoneCallerId: phoneNumber,
                      phoneConnectionId: connectionId,
                      telnyxCallerId: phoneNumber,
                      telnyxConnectionId: connectionId,
                    })
                  }}
                >
                  {phoneProviderOptions.numbers.length === 0 && (
                    <option value="">
                      {phoneProviderLoading ? 'Loading numbers' : 'No numbers available'}
                    </option>
                  )}
                  {phoneProviderOptions.numbers.map((option) => {
                    const phoneNumber = normalizePhoneNumber(option.phoneNumber)
                    return (
                      <option key={option.id || phoneNumber} value={phoneNumber}>
                        {option.label || phoneNumber}
                      </option>
                    )
                  })}
                </select>
                <small>
                  Used only for Playground Phone and Speak/Telnyx direct calls.
                  CallTools uses its native campaign caller-ID strategy.
                </small>
              </label>
              <p
                className={[
                  'config-phone-test-readiness',
                  phoneTestReadiness.ready ? 'ready' : 'blocked',
                ].join(' ')}
                role="status"
              >
                {phoneTestReadiness.message}
              </p>
              <div className="config-call-option-row">
                <button
                  className="secondary-button config-call-option-button"
                  type="button"
                  role="menuitem"
                  data-action-id={speakActionIds.startConfigTest}
                  disabled={
                    phoneTestMissingSavedLead ||
                    testToggleDisabled ||
                    savingProfile ||
                    loadingVoiceConfig
                  }
                  onClick={() => {
                    setPlaygroundMode('test')
                    setPhoneTestPickerOpen(false)
                    if (phoneTestMode === 'saved') {
                      writePlaygroundPhoneSmartViewId(phoneTestSmartViewId)
                      if (selectedPhoneTestLead) {
                        writePlaygroundPhoneLeadId(selectedPhoneTestLead.id)
                      }
                    }
                    void startConfigBrowserTest()
                  }}
                >
                  <Monitor size={15} />
                  <span>Browser</span>
                </button>
                <button
                  className="primary-button config-call-option-button"
                  type="button"
                  role="menuitem"
                  data-action-id={speakActionIds.startConfigPhoneTest}
                  disabled={
                    !phoneTestCanStart ||
                    phoneTestMissingSavedLead ||
                    testStarting ||
                    testEnding ||
                    savingProfile ||
                    loadingVoiceConfig
                  }
                  title={phoneTestReadiness.message}
                  aria-label={`Phone test. ${phoneTestReadiness.message}`}
                  onClick={() => {
                    setPlaygroundMode('test')
                    setPhoneTestPickerOpen(false)
                    if (phoneTestMode === 'saved' && selectedPhoneTestLead) {
                      writePlaygroundPhoneSmartViewId(phoneTestSmartViewId)
                      writePlaygroundPhoneLeadId(selectedPhoneTestLead.id)
                    }
                    void startConfigPhoneTest()
                  }}
                >
                  <Phone size={17} />
                  <span>Phone</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )

  const playgroundPhoneSupervisionControls = phoneTestActive ? (
    <div
      className="playground-phone-supervision"
      data-testid={speakTestIds.playgroundPhoneSupervision}
      aria-label="Phone call supervision"
    >
      <button
        className={[
          'playground-supervision-control',
          phoneTestSpyEnabled ? 'active' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        type="button"
        data-action-id={speakActionIds.togglePlaygroundSpy}
        disabled={
          phoneTestSpyBusy ||
          !phoneTestLiveControlReady ||
          !phoneSupervisionConnected
        }
        aria-pressed={phoneTestSpyEnabled}
        title={
          !phoneTestLiveControlReady || !phoneSupervisionConnected
            ? 'Waiting for live phone audio'
            : phoneTestSpyEnabled
              ? 'Stop hearing the contact and agent'
              : 'Hear the contact and agent without joining the call'
        }
        onClick={() => {
          void togglePhoneTestSpy()
        }}
      >
        {phoneTestSpyBusy ? <Activity size={15} /> : <Ear size={16} />}
        <span>Spy</span>
      </button>
      <button
        className={[
          'playground-supervision-control',
          'barge',
          phoneTestActiveCall?.takeover ? 'active' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        type="button"
        data-action-id={speakActionIds.togglePlaygroundBarge}
        disabled={
          phoneTestTakeoverBusy !== 'idle' ||
          phoneTestSpyBusy ||
          !phoneTestLiveControlReady ||
          (!phoneTestActiveCall?.takeover && !phoneSupervisionConnected) ||
          phoneTestWhisperState === 'starting' ||
          phoneTestWhisperState === 'processing'
        }
        aria-pressed={Boolean(phoneTestActiveCall?.takeover)}
        title={
          !phoneTestLiveControlReady
            ? 'Waiting for Speak and phone media before Barge'
            : phoneTestActiveCall?.takeover
              ? 'Release your microphone and resume the agent'
              : 'Replace the agent immediately with your microphone'
        }
        onClick={() => {
          void togglePhoneTestBarge()
        }}
      >
        {phoneTestTakeoverBusy !== 'idle' ? (
          <Activity size={15} />
        ) : (
          <Mic size={16} />
        )}
        <span>{phoneTestActiveCall?.takeover ? 'Resume' : 'Barge'}</span>
      </button>
    </div>
  ) : null

  const playgroundAudioWhisperControl = phoneTestActive ? (
    <button
      className={[
        'playground-audio-whisper',
        phoneTestWhisperState === 'recording' ? 'active' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      type="button"
      data-action-id={speakActionIds.togglePlaygroundAudioWhisper}
      disabled={
        !phoneTestLiveControlReady ||
        !phoneSupervisionConnected ||
        !audioWhisperAvailable ||
        Boolean(phoneTestActiveCall?.takeover) ||
        phoneTestWhisperState === 'starting' ||
        phoneTestWhisperState === 'processing'
      }
      aria-pressed={phoneTestWhisperState === 'recording'}
      title={
        !audioWhisperAvailable
          ? 'Audio Whisper transcription is unavailable'
          : phoneTestActiveCall?.takeover
            ? 'Release Barge before coaching the agent'
            : phoneTestWhisperState === 'recording'
              ? 'Stop and deliver this private voice whisper'
              : 'Whisper by voice; only the agent receives the transcript'
      }
      onClick={toggleAudioWhisper}
    >
      {phoneTestWhisperState === 'starting' ||
      phoneTestWhisperState === 'processing' ? (
        <Activity size={16} />
      ) : (
        <Mic size={17} />
      )}
      <span className="visually-hidden">
        {phoneTestWhisperState === 'recording'
          ? 'Stop audio whisper'
          : 'Start audio whisper'}
      </span>
    </button>
  ) : null

  return (
    <div className="app-shell" data-route-id={speakRouteIds.configs}>
      <main
        className={[
          'workspace',
          'config-workspace',
        ]
          .filter(Boolean)
          .join(' ')}
        data-route-id={speakRouteIds.configs}
        data-testid={speakTestIds.routeConfigs}
      >
        <header className="topbar config-topbar" data-testid={speakTestIds.configTopbar}>
          <AppPrimaryNavigation
            active="configs"
            basePath={basePath}
          />
          <div className="topbar-middle config-topbar-profile">
            <GlobalSearchTrigger onClick={() => setGlobalSearchOpen(true)} />
            <AppearanceSwitch appearance={appearance} setAppearance={setAppearance} />
          </div>
          <div className="topbar-agent-control">
            <AgentProfilePicker
              className="global-agent-picker"
              disabled={savingProfile || loadingVoiceConfig || profileSwitchDisabled}
              editableName
              inputRef={agentNameInputRef}
              onCommitName={commitAgentName}
              onNewProfile={newProfile}
              onOpenSettings={() => setSettingsOpen(true)}
              onRenameProfile={updateDraftName}
              onSelectProfile={(profile) => {
                void selectGlobalPromptProfile(profile)
              }}
              profiles={promptAgentProfiles}
              selectedId={draft.id}
              settingsDisabled={savingProfile || loadingVoiceConfig || profileSwitchDisabled}
              value={draft.name}
            />
            {renderSaveProfileButton('config-topbar-save-button')}
          </div>
        </header>

        <div className="config-layout" data-testid={speakTestIds.configLayout}>
          <aside className="config-profile-sidebar" aria-label="Agent profiles">
            <div
              className={[
                'bulk-bar',
                'profile-bulk-bar',
                selectedProfileIds.size > 0 ? 'has-selection' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <button
                className="bulk-action-button profile-new-button"
                type="button"
                data-action-id={speakActionIds.addAgent}
                data-testid={speakTestIds.addAgentButton}
                disabled={savingProfile || loadingVoiceConfig || profileSwitchDisabled}
                onClick={newProfile}
                title="New agent"
                aria-label="New agent"
              >
                <Plus size={14} />
                <span>New</span>
              </button>
              <button
                className={[
                  'bulk-select-all',
                  profileSelectionState,
                ]
                  .filter(Boolean)
                  .join(' ')}
                type="button"
                disabled={visibleProfiles.length === 0}
                onClick={toggleAllVisibleProfiles}
                aria-pressed={
                  allVisibleProfilesSelected
                    ? 'true'
                    : someVisibleProfilesSelected
                      ? 'mixed'
                      : 'false'
                }
                aria-label={
                  allVisibleProfilesSelected
                    ? 'Clear visible agents'
                    : 'Select visible agents'
                }
              >
                <span
                  className={[
                    'selection-toggle',
                    profileSelectionState,
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  data-action-id={speakActionIds.selectAgentProfile}
                  aria-hidden="true"
                >
                  <Check size={13} />
                </span>
                <strong>
                  {selectedProfileIds.size > 0
                    ? `${selectedProfileIds.size} selected`
                    : `${visibleProfiles.length} agent${
                        visibleProfiles.length === 1 ? '' : 's'
                      }`}
                </strong>
              </button>
              {selectedProfileIds.size > 0 && (
                <div className="bulk-actions" aria-label="Selected agent actions">
                  <button
                    className="bulk-action-button"
                    type="button"
                    data-action-id={speakActionIds.copyProfile}
                    disabled={savingProfile || loadingVoiceConfig || profileSwitchDisabled}
                    onClick={duplicateSelectedProfiles}
                    title="Copy selected agents"
                    aria-label="Copy selected agents"
                  >
                    <Copy size={14} />
                    <span>Copy</span>
                  </button>
                  <button
                    className="bulk-action-button danger-link"
                    type="button"
                    data-action-id={speakActionIds.deleteProfile}
                    disabled={savingProfile || loadingVoiceConfig || profileSwitchDisabled}
                    onClick={deleteSelectedProfiles}
                    title="Delete selected agents"
                    aria-label="Delete selected agents"
                  >
                    <Trash2 size={14} />
                    <span>Delete</span>
                  </button>
                  <button
                    className="bulk-action-button clear-selection"
                    type="button"
                    data-action-id={speakActionIds.clearSelection}
                    onClick={clearSelectedProfiles}
                    title="Clear selected agents"
                    aria-label="Clear selected agents"
                  >
                    <X size={15} />
                    <span>Clear</span>
                  </button>
                </div>
              )}
            </div>
            <div
              className="config-profile-list"
              data-testid={speakTestIds.configProfileList}
              role="listbox"
              aria-label="Agent profiles"
            >
              {visibleProfiles.length === 0 && (
                <div className="empty-table-state">
                  <span>No agents match this view.</span>
                </div>
              )}
              {visibleProfiles.map((profile) => {
                const profileDisabled =
                  savingProfile || loadingVoiceConfig || profileSwitchDisabled
                const selectThisProfile = () => {
                  if (profileDisabled) return
                  selectProfile(profile)
                }

                return (
                  <article
                    key={profile.id}
                    className={[
                      'config-profile-row',
                      profile.id === draft.id ? 'selected' : '',
                      selectedProfileIds.has(profile.id) ? 'row-selected' : '',
                      profileDisabled ? 'disabled' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    role="option"
                    data-action-id={speakActionIds.selectAgentProfile}
                    data-testid={
                      profile.id === draft.id
                        ? speakTestIds.profileUseButton
                        : undefined
                    }
                    aria-selected={profile.id === draft.id}
                    aria-disabled={profileDisabled}
                    tabIndex={profileDisabled ? -1 : 0}
                    onClick={selectThisProfile}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return
                      event.preventDefault()
                      selectThisProfile()
                    }}
                  >
                    <button
                      className={[
                        'selection-toggle',
                        'row-selection-toggle',
                        'profile-selection-toggle',
                        selectedProfileIds.has(profile.id) ? 'selected' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      type="button"
                      data-action-id={speakActionIds.selectAgentProfile}
                      aria-pressed={selectedProfileIds.has(profile.id)}
                      title={
                        selectedProfileIds.has(profile.id)
                          ? `Unselect ${profile.name}`
                          : `Select ${profile.name}`
                      }
                      aria-label={
                        selectedProfileIds.has(profile.id)
                          ? `Unselect ${profile.name}`
                          : `Select ${profile.name}`
                      }
                      disabled={profileDisabled}
                      onClick={(event) => {
                        event.stopPropagation()
                        toggleProfileSelection(profile.id)
                      }}
                    >
                      <Check size={14} />
                    </button>
                    <span>
                      <strong>{profile.name}</strong>
                      <em>{formatOperationalDateTime(profile.updatedAt, {
                        month: 'numeric',
                        day: 'numeric',
                        year: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit',
                        second: '2-digit',
                      })}</em>
                    </span>
                    <div className="config-profile-row-actions">
                      <button
                        className="icon-button config-profile-settings-button"
                        type="button"
                        data-action-id={speakActionIds.openProfileSettings}
                        title={`Open settings for ${profile.name}`}
                        aria-label={`Open settings for ${profile.name}`}
                        disabled={profileDisabled}
                        onClick={(event) => {
                          event.stopPropagation()
                          selectThisProfile()
                          setSettingsOpen(true)
                        }}
                      >
                        <SlidersHorizontal size={14} />
                      </button>
                    </div>
                  </article>
                )
              })}
            </div>
          </aside>

          <section
            className="panel config-editor-panel"
            data-testid={speakTestIds.configWorkPanel}
          >
            <div className="config-editor-grid">
              <div className="config-focus-grid">
                {renderPromptPanel()}
                {playgroundMode === 'smart' ? (
                  <SmartConfigPanel
                    activeConversationId={smartConfigChat.activeConversationId}
                    authChecking={smartConfigChat.authChecking}
                    authEmail={smartConfigChat.authEmail}
                    authRequired={smartConfigChat.authRequired}
                    bodyHeader={playgroundAgentPicker}
                    composerLeadingAccessory={playgroundSourceAccessory}
                    conversations={smartConfigChat.conversations}
                    loadingConversations={smartConfigChat.loadingConversations}
                    messages={smartConfigChat.messages}
                    onNewConversation={smartConfigChat.startNewConversation}
                    onSelectConversation={smartConfigChat.selectConversation}
                    onSendMessage={smartConfigChat.sendMessage}
                    onStartGoogleSignIn={smartConfigChat.startGoogleSignIn}
                    onStopMessage={smartConfigChat.stopMessage}
                    profileName={draft.name}
                    promptOpen={mobilePromptOpen}
                    promptPanel={renderPromptPanel('config-prompt-panel-inline')}
                    sending={smartConfigChat.sending}
                    status={smartConfigChat.status}
                    steerReady={smartConfigChat.steerReady}
                  />
                ) : (
                  <ConfigurationTestPanel
                    activeThreadTitle={
                      testMode === 'phone'
                        ? 'Live phone test'
                        : 'Live browser test'
                    }
                    bodyHeader={playgroundAgentPicker}
                    composerControls={playgroundPhoneSupervisionControls}
                    composerLeadingAccessory={playgroundSourceAccessory}
                    composerTrailingAccessory={playgroundAudioWhisperControl}
                    headerActions={playgroundHeaderActions}
                    agentLabel={visibleTestAgentLabel}
                    historyThreads={visibleHistoryThreads}
                    onDeleteHistoryThreads={deletePlaygroundThreads}
                    leadLabel={visibleTestLeadLabel}
                    liveStartedAt={testStartedAt}
                    onEnd={endConfigBrowserTest}
                    onSendMessage={sendPlaygroundMessage}
                    onStart={startConfigBrowserTest}
                    composerPlaceholder={
                      testMode === 'phone'
                        ? `Whisper to ${draft.name || 'agent'} privately…`
                        : `Message ${draft.name || 'agent'}…`
                    }
                    messageSending={playgroundMessageSending}
                    messageProgressLabel={
                      testMode === 'phone'
                        ? 'Delivering private text whisper'
                        : 'Waiting for the test agent response'
                    }
                    promptOpen={mobilePromptOpen}
                    promptPanel={renderPromptPanel('config-prompt-panel-inline')}
                    running={testRunning}
                    showControls={false}
                    sendButtonTitle={
                      testMode === 'phone'
                        ? 'Send private text whisper to agent'
                        : 'Send test message'
                    }
                    sessionId={testSessionId}
                    startTitle={
                      missingTestVariableCount
                        ? 'Start test with blank variables'
                        : undefined
                    }
                    starting={testStarting || testEnding}
                    status={visibleTestStatus}
                    subtitle={playgroundSubtitle}
                    title={draft.name || 'Playground'}
                    transcript={visibleTestTranscript}
                  />
                )}
              </div>
            </div>
          </section>

        </div>

        {settingsOpen && (
          <div
            className="config-settings-backdrop"
            role="presentation"
          >
            <aside
              className="config-settings-popout"
              data-testid={speakTestIds.configSettingsDialog}
              role="dialog"
              aria-modal="true"
              aria-label={`${draft.name} settings`}
              ref={settingsPopoverRef}
            >
              <div className="config-settings-popout-heading">
                <div>
                  <strong>{draft.name}</strong>
                  <span>Settings</span>
                </div>
                <div className="config-settings-popout-actions">
                  {renderSaveProfileButton()}
                  <button
                    className="icon-button"
                    type="button"
                    data-action-id={speakActionIds.refreshProfile}
                    title="Refresh from Speak"
                    aria-label="Refresh from Speak"
                    disabled={savingProfile || loadingVoiceConfig || profileSwitchDisabled}
                    onClick={() => void refreshProfileAndOptions()}
                  >
                    {loadingVoiceConfig ? <Activity size={15} /> : <RefreshCw size={15} />}
                  </button>
                  <button
                    className="icon-button"
                    type="button"
                    title="Close settings"
                    aria-label="Close settings"
                    onClick={() => setSettingsOpen(false)}
                  >
                    <X size={15} />
                  </button>
                </div>
              </div>
              <SpeakSettingsPanel
                backendDefaults={backendDefaults}
                config={draft.config}
                expanded
                voiceOptions={voiceOptions}
                loadingVoiceOptions={loadingVoiceOptions}
                onExpandedChange={(expanded) => {
                  if (!expanded) setSettingsOpen(false)
                }}
                onCommitTestVariable={commitTestVariable}
                onUpdateProfileName={updateDraftName}
                onUpdateTestVariable={updateTestVariable}
                onUpdateConfig={updateDraftConfig}
                profileName={draft.name}
                showAgentMessage={false}
                contactSources={contactSources}
                smartViews={smartViews}
                testVariableFields={promptTestVariableFields}
                testVariables={draft.testVariables}
              />
            </aside>
          </div>
        )}
        <GlobalSearchOverlay
          activeRoute="configs"
          onClose={() => setGlobalSearchOpen(false)}
          onSelectProfile={selectProfile}
          open={globalSearchOpen}
        />
      </main>
    </div>
  )
}
