export type LeadStatus =
  | 'ready'
  | 'calling'
  | 'follow-up'
  | 'no-answer'
  | 'voicemail'
  | 'not-interested'
  | 'skipped'
  | 'failed'
  | 'do-not-call'

export type CallOutcome =
  | 'completed'
  | 'no-answer'
  | 'voicemail'
  | 'not-interested'
  | 'do-not-call'
  | 'skipped'
  | 'operator-ended'
  | 'failed'

export type CallPhase = 'idle' | 'dialing' | 'live' | 'handoff' | 'ended'

export type Speaker = 'AI' | 'Lead' | 'You' | 'System' | 'Tool'

export interface Lead {
  id: string
  firstName: string
  lastName: string
  name: string
  company: string
  phone: string
  email: string
  state: string
  tags: string[]
  score: number
  status: LeadStatus
  lastCall: string
  notes: string
  context?: ContextFields
  providerIds?: Record<string, string>
  source?: LeadSource
  sourceId?: string
  sourceName?: string
  sourceUrl?: string
  externalUrl?: string
  sourceSyncedAt?: string
}

export interface ContextAttachment {
  id: string
  name: string
  type: string
  size: number
  uploadedAt: string
  url: string
  preview?: string
  extractedText?: string
  extractionStatus?: string
  extractionError?: string
  extractedAt?: string
  contentHash?: string
  contentChars?: number
}

export interface ContextFields {
  text: string
  urls: string[]
  urlSnapshots?: Array<{
    url: string
    title?: string
    text?: string
    status?: string
    error?: string
    contentType?: string
    fetchedAt?: string
    contentHash?: string
    contentChars?: number
  }>
  files: ContextAttachment[]
}

export interface LeadFilterSnapshot {
  query: string
  statusFilter: string
  stateFilter: string
  scoreFilter: string
  tagFilter: string
  sortField: string
  sortDirection: 'asc' | 'desc'
}

export interface DialerWorkspaceState {
  sourceId: string
  activeSmartViewId: string
  query: string
  statusFilter: string
  stateFilter: string
  scoreFilter: string
  selectedLeadId: string
  selectedLeadIds: string[]
  campaignQueueIds: string[]
  campaignRunning: boolean
  scheduledStartAt: string
  scheduledQueueActive: boolean
  controllerId?: string
  controllerHeartbeatAt?: string
  calltoolsDuty?: {
    binding?: {
      appUserId?: string
      campaignId?: string
      phoneId?: string
    }
    blockers?: string[]
    lastCheckedAt?: string
    lastVerifiedAt?: string
    leaseId?: string
    message?: string
    profileId?: string
    reason?: string
    status?: 'arming' | 'attention' | 'disarming' | 'off' | 'on'
    transitionAt?: string
  }
  updatedAt?: string
}

export type LeadSource = 'manual' | 'filters' | 'csv' | 'calltools' | 'personal-phone'

export type SmartViewSource = 'filters' | 'csv'

export interface ContactSource {
  id: string
  source: LeadSource
  sourceId: string
  sourceName: string
  sourceUrl?: string
  externalUrl?: string
  sourceSyncedAt?: string
  leadCount: number
}

export interface SmartView {
  id: string
  name: string
  source: SmartViewSource
  sourceId?: string
  sourceUrl?: string
  externalUrl?: string
  syncedAt?: string
  createdAt: string
  updatedAt: string
  filters?: Partial<LeadFilterSnapshot>
  leadIds: string[]
  leadCount: number
}

export type DialerProvider = 'speak' | 'calltools'

export interface PhoneProviderOption {
  id: string
  label: string
  phoneNumber: string
  connectionId?: string
  messagingProfileId?: string
  source?: string
  isDefault?: boolean
}

export interface CallToolsAgentBinding {
  enabled?: boolean
  mode?: 'phone_as_agent'
  appUserId?: string
  userId?: string
  phoneId?: string
  phoneSipUri?: string
  phoneWebSocketUrl?: string
  webCallbackId?: string
  queueId?: string
  campaignId?: string
  callerIdId?: string
  callerIdStrategyId?: string
  liveFilterId?: string
  bucketId?: string
  contactMatchMode?: 'calltools_contact_id_then_phone'
  provisioningStatus?: 'unconfigured' | 'linked' | 'ready' | 'blocked'
  mediaGatewayStatus?: 'unconfigured' | 'configured' | 'registered' | 'unverified' | 'verified' | 'failed'
  lastVerifiedAt?: string
}

export interface PersonalPhoneInboundConfig {
  enabled?: boolean
  eligibilityScope?: 'source' | 'selected'
  sourceId?: string
  contactIds?: string[]
  smartViewIds?: string[]
}

export interface CampaignConfig {
  instructions: string
  agentProfileId?: string
  agentProfileName?: string
  agentProfileUpdatedAt?: string
  contactSource?: LeadSource | ''
  contactSourceId?: string
  smartViewId?: string
  personalPhoneInbound?: PersonalPhoneInboundConfig
  dialerProvider?: DialerProvider
  calltoolsAgentBinding?: CallToolsAgentBinding
  voiceRuntimeProvider?: 'hume' | 'inworld' | 'xai'
  eviVersion: string
  humeConfigId: string
  speakConfigId?: string
  inworldConfigId?: string
  xaiConfigId?: string
  humeConfigVersion?: number
  inworldConfigVersion?: number
  xaiConfigVersion?: number
  speakConfigVersion?: number
  humeConfigSyncedAt?: string
  inworldConfigSyncedAt?: string
  xaiConfigSyncedAt?: string
  speakConfigSyncedAt?: string
  voice: string
  humeVoiceId?: string
  humeVoiceName?: string
  speakVoiceName?: string
  humeVoiceProvider?: string
  speakVoiceProvider?: string
  inworldVoiceName?: string
  inworldVoiceId?: string
  inworldVoiceProvider?: string
  xaiVoiceName?: string
  xaiVoiceId?: string
  xaiVoiceProvider?: string
  supplementalLlm: string
  languageModelMode?: 'hume' | 'inworld' | 'xai' | 'codex'
  languageModelProvider?: string
  languageModelResource?: string
  languageModelTemperature?: number
  codexAuthModel?: string
  codexReasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  inworldReasoningEfforts?: Array<
    'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  >
  inworldReasoningSupported?: boolean
  codexFastMode?: boolean
  allowShortResponses?: boolean
  promptExpansionEnabled?: boolean
  inactivityTimeoutEnabled?: boolean
  inactivityTimeoutSeconds?: number
  maxDurationTimeoutEnabled?: boolean
  maxDurationTimeoutSeconds?: number
  turnDetectionEnabled?: boolean
  endOfTurnSilenceMs: number
  speechDetectionThreshold: number
  prefixPaddingMs: number
  interruptionEnabled?: boolean
  minInterruptionMs: number
  nudgesEnabled?: boolean
  nudgesIntervalSeconds?: number
  eviStartsConversation?: boolean
  resumeConversationMessageEnabled?: boolean
  resumeConversationMessage?: string
  inactivityMessageEnabled?: boolean
  inactivityMessage?: string
  maxDurationMessageEnabled?: boolean
  maxDurationMessage?: string
  webSearchEnabled?: boolean
  hangUpEnabled?: boolean
  inworldRealtimeModel?: string
  inworldFallbackRealtimeModel?: string
  inworldSttModel?: string
  inworldTtsModel?: string
  inworldLanguage?: string
  inworldSttEndOfTurnConfidenceThreshold?: number
  inworldSttMinEndOfTurnSilenceMs?: number
  inworldSttMaxTurnSilenceMs?: number
  inworldSttVadThreshold?: number
  inworldTurnDetectionMode?: string
  inworldTurnEagerness?: string
  inworldTtsDeliveryMode?: string
  inworldTtsSegmenterStrategy?: string
  inworldTtsSteeringHandling?: string
  inworldTtsConversationalEnabled?: boolean
  inworldTtsUserTurnMode?: string
  inworldVoiceSteeringEnabled?: boolean
  inworldVoiceProfileEnabled?: boolean
  inworldResponsivenessInitialWaitMs?: number
  inworldResponsivenessHardDeadlineMs?: number
  inworldBackchannelEnabled?: boolean
  inworldResponsivenessEnabled?: boolean
  inworldMemoryEnabled?: boolean
  inworldToolCallingEnabled?: boolean
  inworldOutputSampleRate?: number
  xaiRealtimeModel?: string
  xaiReasoningEffort?: 'none' | 'high'
  xaiLanguageHint?: string
  xaiKeyterms?: string[]
  xaiVoiceSpeed?: number
  xaiResumptionEnabled?: boolean
  xaiToolCallingEnabled?: boolean
  xaiOutputSampleRate?: number
  verboseTranscription: boolean
  audioEncoding: 'linear16'
  phoneAudioMode?: 'optimized' | 'legacy'
  phoneOutputGain?: number
  phoneOutputPeak?: number
  sampleRate: number
  telnyxCallerId: string
  phoneCallerId?: string
  telnyxConnectionId: string
  phoneConnectionId?: string
  telnyxStreamCodec: 'L16' | 'PCMU'
  phoneStreamCodec?: 'L16' | 'PCMU'
  callWindow: string
  maxConcurrent: number
  useConfigPrompt?: boolean
  useConfigTools?: boolean
  autoStartGreeting?: boolean
  profileContext?: ContextFields
}

export interface TranscriptEntry {
  id: string
  at: string
  speaker: Speaker
  text: string
  tone?: 'neutral' | 'positive' | 'attention' | 'system'
  emotionScores?: Record<string, number>
  providerEventId?: string
}

export interface ActiveCall {
  leadId: string
  callControlId: string
  chatId?: string
  streamId?: string
  phase: CallPhase
  startedAt: number
  takeover: boolean
  outcome?: CallOutcome
  playgroundSupervisionToken?: string
}

export interface VoiceBackendStatus {
  ok: boolean
  configured: boolean
  missing: string[]
  message: string
  defaults?: Partial<CampaignConfig>
  delivery?: {
    smsConfigured: boolean
    emailConfigured: boolean
    emailAuthAccountConfigured?: boolean
    emailSendAsConfigured?: boolean
    smsFrom: string | null
    emailFrom: string | null
  }
  optimizations?: {
    codec: 'L16' | 'PCMU'
    sampleRate: number
    phoneOutputGain: number
    phoneOutputPeak: number
    verboseTranscription: boolean
    phoneMinimumHangupMs?: number
    endOfTurnSilenceMs: number
    speechDetectionThreshold: number
    prefixPaddingMs: number
    minInterruptionMs: number
  }
}
