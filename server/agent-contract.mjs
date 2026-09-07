import { speakFunctionTools } from './hume-tools.mjs'
import { callableRestAgentActions } from './agent-action-invoker.mjs'

export const SPEAK_AGENT_CONTRACT_VERSION = '2026-07-18'

const contextAttachmentSchema = {
  type: 'object',
  required: ['id', 'name'],
  description:
    'Context file attachment metadata returned by POST /api/context-files. Store this object in lead.context.files or profile.context.files after upload.',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    type: { type: 'string', description: 'Original MIME type when known.' },
    size: { type: 'number' },
    uploadedAt: { type: 'string' },
    url: {
      type: 'string',
      description:
        'Download URL for the original attachment. Treat as private workspace data.',
    },
    preview: { type: 'string' },
    extractedText: {
      type: 'string',
      description:
        'Server-extracted text for supported file types. Runtime prompts receive compact inventory; full content is exposed through context tools when relevant.',
    },
    extractionStatus: {
      type: 'string',
      enum: ['ready', 'empty', 'unsupported', 'error'],
    },
    extractionError: { type: 'string' },
    extractedAt: { type: 'string' },
    contentHash: { type: 'string' },
    contentChars: { type: 'number' },
  },
}

const contextUrlSnapshotSchema = {
  type: 'object',
  required: ['url'],
  properties: {
    url: { type: 'string' },
    title: { type: 'string' },
    text: { type: 'string' },
    status: {
      type: 'string',
      enum: ['ready', 'empty', 'unsupported', 'error'],
    },
    error: { type: 'string' },
    contentType: { type: 'string' },
    fetchedAt: { type: 'string' },
    contentHash: { type: 'string' },
    contentChars: { type: 'number' },
  },
}

const contextFieldsSchema = {
  type: 'object',
  description:
    'Durable knowledge fields attached to a lead or agent profile. Text and URLs are JSON-editable; files are uploaded through /api/context-files, then attached by storing the returned metadata.',
  properties: {
    text: {
      type: 'string',
      description:
        'Operator-authored lead or agent knowledge. Keep secrets and raw credentials out of this field.',
    },
    urls: {
      type: 'array',
      items: { type: 'string' },
      description:
        'URLs refreshed into urlSnapshots before future sessions when reachable within runtime limits.',
    },
    urlSnapshots: {
      type: 'array',
      items: contextUrlSnapshotSchema,
    },
    files: {
      type: 'array',
      items: contextAttachmentSchema,
    },
  },
}

const leadSchema = {
  type: 'object',
  required: ['phone'],
  properties: {
    id: { type: 'string' },
    firstName: { type: 'string' },
    lastName: { type: 'string' },
    name: { type: 'string' },
    company: { type: 'string' },
    phone: {
      type: 'string',
      description: 'Dialable phone number. E.164 is preferred.',
    },
    email: { type: 'string' },
    state: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    score: { type: 'number' },
    status: { type: 'string' },
    lastCall: { type: 'string' },
    notes: { type: 'string' },
    context: contextFieldsSchema,
    providerIds: { type: 'object' },
    source: {
      type: 'string',
      enum: ['manual', 'filters', 'csv', 'calltools', 'personal-phone'],
    },
    sourceId: { type: 'string' },
    sourceName: { type: 'string' },
    sourceUrl: { type: 'string' },
    externalUrl: { type: 'string' },
    sourceSyncedAt: { type: 'string' },
  },
}

const communicationThreadSchema = {
  type: 'object',
  required: ['threadId', 'channels', 'status', 'createdAt', 'updatedAt'],
  description:
    'Speak-owned conversation thread. Calls, SMS, email, browser tests, tool proof, recordings, and provider events converge here for contact-scoped UI, memory, and agent readback.',
  properties: {
    threadId: { type: 'string' },
    contactId: {
      type: 'string',
      description:
        'Canonical Speak contact/lead ID. May be absent only while attribution is unresolved.',
    },
    agentProfileId: { type: 'string' },
    status: {
      type: 'string',
      enum: ['open', 'waiting', 'resolved', 'archived', 'unresolved_attribution'],
    },
    channels: {
      type: 'array',
      items: {
        type: 'string',
        enum: ['call', 'sms', 'email', 'browser_test', 'operator_chat', 'tool', 'system'],
      },
    },
    participants: { type: 'array', items: { type: 'object' } },
    topicIds: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    latestMessagePreview: { type: 'string' },
    lastMessageId: { type: 'string' },
    lastInboundAt: { type: 'string' },
    lastOutboundAt: { type: 'string' },
    messageCount: { type: 'number' },
    emotionScoreTurns: { type: 'number' },
    hasEmotionScores: { type: 'boolean' },
    identityConfidence: {
      type: 'string',
      enum: ['verified', 'probable', 'unresolved'],
    },
    providerLinks: { type: 'array', items: { type: 'object' } },
    latestChannel: {
      type: 'string',
      enum: ['call', 'sms', 'email', 'browser_test', 'operator_chat', 'tool', 'system'],
    },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
}

const communicationMessageSchema = {
  type: 'object',
  required: ['messageId', 'threadId', 'channel', 'modality', 'direction', 'role', 'at'],
  description:
    'Normalized message/event envelope for all contact communication channels.',
  properties: {
    messageId: { type: 'string' },
    threadId: { type: 'string' },
    contactId: { type: 'string' },
    agentProfileId: { type: 'string' },
    channel: {
      type: 'string',
      enum: ['call', 'sms', 'email', 'browser_test', 'operator_chat', 'tool', 'system'],
    },
    modality: {
      type: 'string',
      enum: ['voice', 'text', 'audio', 'tool', 'status', 'attachment'],
    },
    direction: {
      type: 'string',
      enum: ['inbound', 'outbound', 'internal', 'system'],
    },
    role: {
      type: 'string',
      enum: ['contact', 'agent', 'operator', 'tool', 'system'],
    },
    body: { type: 'string' },
    bodyStatus: {
      type: 'string',
      enum: ['partial', 'final', 'redacted', 'not_applicable'],
    },
    provider: { type: 'string' },
    providerIds: { type: 'object' },
    proof: { type: 'object' },
    attachments: { type: 'array', items: { type: 'object' } },
    emotionScores: {
      type: 'object',
      additionalProperties: { type: 'number' },
      description: 'Provider emotion score map when the source turn actually emitted scores.',
    },
    topicIds: { type: 'array', items: { type: 'string' } },
    at: { type: 'string' },
  },
}

const communicationTopicSchema = {
  type: 'object',
  required: ['topicId', 'threadId', 'contactId', 'label', 'summary', 'sourceMessageIds', 'updatedAt'],
  description:
    'Compact topic summary for search, inbox triage, and bounded runtime Contact Memory.',
  properties: {
    topicId: { type: 'string' },
    threadId: { type: 'string' },
    contactId: { type: 'string' },
    label: { type: 'string' },
    summary: { type: 'string' },
    status: { type: 'string' },
    confidence: { type: 'string' },
    sourceMessageIds: { type: 'array', items: { type: 'string' } },
    updatedAt: { type: 'string' },
  },
}

const contactIdentityLinkSchema = {
  type: 'object',
  required: ['contactId', 'kind', 'normalizedValue', 'source', 'confidence'],
  description:
    'Attribution link used before attaching inbound SMS, inbound calls, email, or provider threads to a contact.',
  properties: {
    contactId: { type: 'string' },
    kind: {
      type: 'string',
      enum: ['phone', 'email', 'provider_contact', 'external_thread'],
    },
    normalizedValue: { type: 'string' },
    source: { type: 'string' },
    confidence: {
      type: 'string',
      enum: ['verified', 'probable', 'unresolved'],
    },
    verifiedAt: { type: 'string' },
    supersededBy: { type: 'string' },
  },
}

const campaignConfigSchema = {
  type: 'object',
  properties: {
    instructions: { type: 'string' },
    agentProfileId: { type: 'string' },
    agentProfileName: { type: 'string' },
    contactSource: {
      type: 'string',
      enum: ['personal-phone', 'calltools'],
      description:
        'Exact Library contact source owned by this profile. This is source ownership, not a Smart View filter.',
    },
    contactSourceId: {
      type: 'string',
      description:
        'Provider source ID for the selected contact source, such as a BlueBubbles source or CallTools campaign/live-filter source.',
    },
    smartViewId: { type: 'string' },
    personalPhoneInbound: {
      type: 'object',
      description:
        'Fail-closed Personal Phone missed-call policy. Source scope covers every contact in one explicit Personal Phone source; selected scope uses exact contact IDs and selected Smart Views.',
      properties: {
        enabled: { type: 'boolean' },
        eligibilityScope: {
          type: 'string',
          enum: ['source', 'selected'],
        },
        sourceId: {
          type: 'string',
          description:
            'Exact Personal Phone contact source ID. Required when eligibilityScope is source.',
        },
        contactIds: {
          type: 'array',
          maxItems: 100,
          items: { type: 'string' },
        },
        smartViewIds: {
          type: 'array',
          maxItems: 50,
          items: { type: 'string' },
        },
      },
    },
    dialerProvider: {
      type: 'string',
      enum: ['speak', 'calltools'],
      description:
        'speak is the only direct-call transport accepted by /api/calls/start. calltools uses one-click native campaign activation plus a durable Available lease; CallTools remains the contact-selection and dialing authority.',
    },
    calltoolsAgentBinding: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        mode: { type: 'string', enum: ['phone_as_agent'] },
        appUserId: { type: 'string' },
        userId: { type: 'string' },
        phoneId: { type: 'string' },
        phoneSipUri: { type: 'string' },
        phoneWebSocketUrl: { type: 'string' },
        webCallbackId: { type: 'string' },
        queueId: { type: 'string' },
        campaignId: { type: 'string' },
        callerIdId: { type: 'string' },
        callerIdStrategyId: { type: 'string' },
        liveFilterId: { type: 'string' },
        bucketId: { type: 'string' },
        contactMatchMode: { type: 'string', enum: ['calltools_contact_id_then_phone'] },
        provisioningStatus: {
          type: 'string',
          enum: ['unconfigured', 'linked', 'ready', 'blocked'],
        },
        mediaGatewayStatus: {
          type: 'string',
          enum: ['unconfigured', 'configured', 'registered', 'unverified', 'verified', 'failed'],
        },
        lastVerifiedAt: { type: 'string' },
      },
    },
    speakConfigId: { type: 'string' },
    humeConfigId: { type: 'string' },
    inworldConfigId: { type: 'string' },
    xaiConfigId: { type: 'string' },
    voiceRuntimeProvider: { type: 'string', enum: ['hume', 'inworld', 'xai'] },
    voice: { type: 'string' },
    humeVoiceProvider: { type: 'string' },
    inworldVoiceProvider: { type: 'string' },
    xaiVoiceProvider: { type: 'string' },
    languageModelMode: { type: 'string', enum: ['hume', 'inworld', 'xai', 'codex'] },
    languageModelProvider: { type: 'string' },
    languageModelResource: { type: 'string' },
    codexAuthModel: { type: 'string' },
    codexReasoningEffort: {
      type: 'string',
      enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
    },
    inworldReasoningEfforts: {
      type: 'array',
      items: {
        type: 'string',
        enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
      },
    },
    inworldReasoningSupported: { type: 'boolean' },
    codexFastMode: { type: 'boolean' },
    inworldRealtimeModel: { type: 'string' },
    inworldFallbackRealtimeModel: { type: 'string' },
    inworldSttModel: { type: 'string' },
    inworldTtsModel: { type: 'string', enum: ['inworld-tts-2'] },
    inworldLanguage: { type: 'string' },
    inworldSttEndOfTurnConfidenceThreshold: { type: 'number' },
    inworldSttMinEndOfTurnSilenceMs: { type: 'number' },
    inworldSttMaxTurnSilenceMs: { type: 'number' },
    inworldSttVadThreshold: { type: 'number' },
    inworldTurnDetectionMode: { type: 'string', enum: ['semantic_vad', 'server_vad'] },
    inworldTurnEagerness: { type: 'string', enum: ['low', 'medium', 'high', 'auto'] },
    inworldTtsDeliveryMode: { type: 'string', enum: ['STABLE', 'BALANCED', 'CREATIVE'] },
    inworldTtsSegmenterStrategy: {
      type: 'string',
      enum: ['auto', 'balanced', 'sentence', 'full_turn', 'fast_start', 'per_segment_context'],
    },
    inworldTtsSteeringHandling: { type: 'string', enum: ['emit_once', 'repeat_each_chunk'] },
    inworldTtsConversationalEnabled: { type: 'boolean' },
    inworldTtsUserTurnMode: { type: 'string', enum: ['both', 'audio_only', 'text_only', 'none'] },
    inworldVoiceSteeringEnabled: { type: 'boolean' },
    inworldVoiceProfileEnabled: { type: 'boolean' },
    inworldResponsivenessInitialWaitMs: { type: 'number' },
    inworldResponsivenessHardDeadlineMs: { type: 'number' },
    inworldBackchannelEnabled: { type: 'boolean' },
    inworldResponsivenessEnabled: { type: 'boolean' },
    inworldMemoryEnabled: { type: 'boolean' },
    inworldToolCallingEnabled: { type: 'boolean' },
    inworldOutputSampleRate: { type: 'number' },
    sampleRate: { type: 'number' },
    phoneStreamCodec: { type: 'string', enum: ['L16', 'PCMU'] },
    phoneCallerId: { type: 'string' },
    phoneConnectionId: { type: 'string' },
    useConfigPrompt: { type: 'boolean' },
    useConfigTools: { type: 'boolean' },
    autoStartGreeting: { type: 'boolean' },
  },
}

const testVariablesSchema = {
  type: 'object',
  properties: {
    first_name: { type: 'string' },
    last_name: { type: 'string' },
    full_name: { type: 'string' },
    business_name: { type: 'string' },
    contact_phone: { type: 'string' },
    contact_email: { type: 'string' },
    notes: { type: 'string' },
    portal_url: { type: 'string' },
  },
}

const leadFilterSnapshotSchema = {
  type: 'object',
  properties: {
    query: { type: 'string' },
    statusFilter: { type: 'string' },
    stateFilter: { type: 'string' },
    scoreFilter: { type: 'string' },
    tagFilter: { type: 'string' },
    sortField: { type: 'string' },
    sortDirection: { type: 'string', enum: ['asc', 'desc'] },
  },
}

const smartViewSchema = {
  type: 'object',
  required: ['name'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    source: { type: 'string', enum: ['filters', 'csv'] },
    sourceId: { type: 'string' },
    sourceUrl: { type: 'string' },
    externalUrl: { type: 'string' },
    syncedAt: { type: 'string' },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
    filters: leadFilterSnapshotSchema,
    leadIds: { type: 'array', items: { type: 'string' } },
    leadCount: { type: 'number' },
  },
}

const dialerStateSchema = {
  type: 'object',
  properties: {
    sourceId: { type: 'string' },
    activeSmartViewId: { type: 'string' },
    query: { type: 'string' },
    statusFilter: { type: 'string' },
    stateFilter: { type: 'string' },
    scoreFilter: { type: 'string' },
    selectedLeadId: { type: 'string' },
    selectedLeadIds: { type: 'array', items: { type: 'string' } },
    campaignQueueIds: { type: 'array', items: { type: 'string' } },
    campaignRunning: { type: 'boolean' },
    scheduledStartAt: { type: 'string' },
    scheduledQueueActive: { type: 'boolean' },
    controllerId: { type: 'string' },
    controllerHeartbeatAt: { type: 'string' },
    calltoolsDuty: {
      type: 'object',
      readOnly: true,
      properties: {
        leaseId: { type: 'string' },
        status: {
          type: 'string',
          enum: ['arming', 'attention', 'disarming', 'off', 'on'],
        },
        profileId: { type: 'string' },
        binding: {
          type: 'object',
          properties: {
            appUserId: { type: 'string' },
            campaignId: { type: 'string' },
            phoneId: { type: 'string' },
          },
        },
        message: { type: 'string' },
        reason: { type: 'string' },
        blockers: { type: 'array', items: { type: 'string' } },
        lastCheckedAt: { type: 'string' },
        lastVerifiedAt: { type: 'string' },
      },
    },
    updatedAt: { type: 'string' },
  },
}

const profileSchema = {
  type: 'object',
  required: ['name', 'config'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    updatedAt: { type: 'string' },
    config: campaignConfigSchema,
    testVariables: testVariablesSchema,
    context: contextFieldsSchema,
  },
}

const ownedUpdatesSchema = {
  type: 'object',
  description:
    'Profile sections the caller intentionally changed. Omit a key or set it false when that section should be inherited from the existing Speak config.',
  properties: {
    name: { type: 'boolean' },
    prompt: { type: 'boolean' },
    settings: { type: 'boolean' },
    voice: { type: 'boolean' },
  },
}

const callOutcomeSchema = {
  type: 'string',
  enum: [
    'completed',
    'no-answer',
    'voicemail',
    'not-interested',
    'callback',
    'wrong-number',
    'do-not-call',
    'operator-ended',
    'skipped',
    'failed',
  ],
}

const SPEAK_WIDGET_VERSION = 'v1'
const SPEAK_WIDGET_RESOURCE_URI = `ui://speak/operator/${SPEAK_WIDGET_VERSION}.html`
const SPEAK_WIDGET_MIME_TYPE = 'text/html;profile=mcp-app'

const authorizationModeSchema = {
  type: 'string',
  enum: [
    'confirm_each',
    'session_preauthorized',
    'no_permission_needed',
    'yolo',
    'dangerously_approve_everything',
  ],
  default: 'confirm_each',
  description:
    'Host/operator authorization mode for high-risk Speak actions. This changes approval handling, not backend proof requirements.',
}

const authorizationModeContract = {
  argumentName: 'authorizationMode',
  default: 'confirm_each',
  modes: [
    {
      id: 'confirm_each',
      description:
        'Default. Ask for explicit current-user confirmation before high-risk live-world mutations.',
    },
    {
      id: 'session_preauthorized',
      description:
        'The current task/session explicitly preauthorizes the named class of high-risk actions.',
    },
    {
      id: 'no_permission_needed',
      description:
        'The host policy says no approval prompt is needed for this action. Use only when the host already granted that policy.',
    },
    {
      id: 'yolo',
      description:
        'Alias-style high-autonomy mode. Proceed under host/operator preapproval while preserving destructive/open-world hints and proof checks.',
    },
    {
      id: 'dangerously_approve_everything',
      description:
        'Most permissive mode. Intended for trusted operator sessions only; never waives backend success proof or failure contracts.',
    },
  ],
  aliases: {
    never: 'no_permission_needed',
    'no-permission-needed': 'no_permission_needed',
    '--yolo': 'yolo',
    '--dangerously-approve-everything': 'dangerously_approve_everything',
    '--dangerously-skip-permissions': 'dangerously_approve_everything',
  },
  invariant:
    'Authorization mode controls approval prompts only. Tools must still return backend proof and must not claim live-world success from intent alone.',
}

const uiActionIds = {
  addAgent: 'add_agent',
  addLead: 'add_lead',
  callLead: 'call_lead',
  callLeadFromDevice: 'call_lead_from_device',
  clearFilters: 'clear_filters',
  clearSelection: 'clear_selection',
  closeLeadDetails: 'close_lead_details',
  closeTranscript: 'close_transcript',
  configureDialer: 'configure_dialer',
  copyProfile: 'copy_profile',
  deleteProfile: 'delete_profile',
  createSmartView: 'create_smart_view',
  editLead: 'edit_lead',
  endCall: 'end_call',
  expandTranscript: 'expand_transcript',
  filterAgentProfiles: 'filter_agent_profiles',
  filterLeads: 'filter_leads',
  importSmartViewCsv: 'import_smart_view_csv',
  openGlobalSearch: 'open_global_search',
  openLeadDetails: 'open_lead_details',
  openProfileSettings: 'open_profile_settings',
  openSpeakPlayground: 'open_speak_playground',
  openSmartConfig: 'open_smart_config',
  openSmartConfigHistory: 'open_smart_config_history',
  openTranscript: 'open_transcript',
  refreshProfile: 'refresh_profile',
  routeToConfigs: 'route_to_configs',
  routeToDialer: 'route_to_dialer',
  routeToLibrary: 'route_to_library',
  saveProfile: 'save_profile',
  scheduleQueue: 'schedule_queue',
  selectAgentProfile: 'select_agent_profile',
  selectAppearance: 'select_appearance',
  selectContactSource: 'select_contact_source',
  selectLead: 'select_lead',
  selectSmartConfigConversation: 'select_smart_config_conversation',
  selectSmartView: 'select_smart_view',
  sendLiveInstruction: 'send_live_instruction',
  sendOperatorChatMessage: 'send_operator_chat_message',
  sendPlaygroundMessage: 'send_playground_message',
  sendSmartConfigMessage: 'send_smart_config_message',
  stopSmartConfigMessage: 'stop_smart_config_message',
  syncPersonalPhoneSource: 'sync_personal_phone_source',
  syncCallToolsSource: 'sync_calltools_source',
  skipToNextCall: 'skip_to_next_call',
  sortAndViewAgentProfiles: 'sort_and_view_agent_profiles',
  sortAndViewLeads: 'sort_and_view_leads',
  newSmartConfigConversation: 'new_smart_config_conversation',
  startConfigPhoneTest: 'start_config_phone_test',
  startConfigTest: 'start_config_test',
  stopConfigPhoneTest: 'stop_config_phone_test',
  startQueue: 'start_queue',
  stopConfigTest: 'stop_config_test',
  stopQueue: 'stop_queue',
  togglePrompt: 'toggle_prompt',
  toggleCallAudio: 'toggle_call_audio',
  togglePlaygroundAudioWhisper: 'toggle_playground_audio_whisper',
  togglePlaygroundBarge: 'toggle_playground_barge',
  togglePlaygroundSpy: 'toggle_playground_spy',
  toggleTakeover: 'toggle_takeover',
}

const uiTestIds = {
  activeAgentPill: 'speak-active-agent-pill',
  addAgentButton: 'speak-add-agent-button',
  addLeadButton: 'speak-add-lead-button',
  appearanceTrigger: 'speak-appearance-trigger',
  configActions: 'speak-config-actions',
  configLayout: 'speak-config-layout',
  configProfileFilterButton: 'speak-config-profile-filter-button',
  configProfileList: 'speak-config-profile-list',
  configProfileSortViewButton: 'speak-config-profile-sort-view-button',
  configSettingsDialog: 'speak-config-settings-dialog',
  configTestPanel: 'speak-config-test-panel',
  configTestToggle: 'speak-config-test-toggle',
  configTopbar: 'speak-config-topbar',
  configWorkPanel: 'speak-config-work-panel',
  communicationReplyComposer: 'speak-communication-reply-composer',
  contactDeliveryComposer: 'speak-contact-delivery-composer',
  contactDeliveryCancel: 'speak-contact-delivery-cancel',
  contactDeliverySend: 'speak-contact-delivery-send',
  dialerActions: 'speak-dialer-actions',
  dialerRunControls: 'speak-dialer-run-controls',
  dialerTopbar: 'speak-dialer-topbar',
  leadFilterButton: 'speak-lead-filter-button',
  leadQueue: 'speak-lead-queue',
  leadRow: 'speak-lead-row',
  leadSearch: 'speak-lead-search',
  leadSortViewButton: 'speak-lead-sort-view-button',
  leadToolbar: 'speak-lead-toolbar',
  libraryRoute: 'speak-route-library',
  libraryActivityTab: 'speak-library-activity-tab',
  libraryTopbar: 'speak-library-topbar',
  transcriptLibrary: 'speak-transcript-library',
  globalSearchDialog: 'speak-global-search-dialog',
  globalSearchTrigger: 'speak-global-search-trigger',
  operatorGrid: 'speak-operator-grid',
  personalPhoneInboundReadiness: 'speak-personal-phone-inbound-readiness',
  profilePicker: 'speak-profile-picker',
  profileUseButton: 'speak-profile-use-button',
  playgroundPhoneSupervision: 'speak-playground-phone-supervision',
  routeConfigs: 'speak-route-configs',
  routeDialer: 'speak-route-dialer',
  routeSwitch: 'speak-route-switch',
  smartConfigHistory: 'speak-smart-config-history',
  smartConfigPanel: 'speak-smart-config-panel',
  smsReplyAgentMode: 'speak-sms-reply-agent-mode',
  smsReplyDeviceMode: 'speak-sms-reply-device-mode',
  transcriptPanel: 'speak-transcript-panel',
}

export function buildSpeakAgentContract({
  basePath = '',
  publicBaseUrl = '',
  contractVersion = SPEAK_AGENT_CONTRACT_VERSION,
} = {}) {
  const root = appRoot({ basePath, publicBaseUrl })
  const action = (definition) => ({
    ...definition,
    path: definition.path,
    url: routeUrl(root, definition.path),
  })

  const actions = [
    action({
      id: 'read_runtime_health',
      title: 'Read runtime health',
      method: 'GET',
      path: '/api/health',
      kind: 'read',
      risk: 'low',
      callableByMcp: true,
      proof: ['ok', 'configured', 'missing', 'defaults', 'delivery', 'optimizations'],
      useFor: ['preflight', 'runtime-readback', 'deployment-verification'],
    }),
    action({
      id: 'read_recent_calls',
      title: 'Read recent call attempts',
      method: 'GET',
      path: '/api/calls/recent',
      kind: 'read',
      risk: 'low',
      callableByMcp: true,
      querySchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 12 },
        },
      },
      proof: [
        'calls[].callControlId',
        'calls[].provider',
        'calls[].providerIds',
        'calls[].lead.source',
        'calls[].lead.sourceId',
        'calls[].outcome',
        'calls[].transcript',
        'calls[].diagnostic',
      ],
      useFor: ['call-history', 'transcript-review', 'transport-diagnostics', 'calltools-follow-mode'],
    }),
    action({
      id: 'read_communication_threads',
      title: 'Read Speak communication threads',
      method: 'GET',
      path: '/api/communication-threads',
      kind: 'read',
      risk: 'low',
      callableByMcp: true,
      querySchema: {
        type: 'object',
        properties: {
          contactId: { type: 'string' },
          agentProfileId: { type: 'string' },
          channel: { type: 'string' },
          channels: {
            oneOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } },
            ],
          },
          status: { type: 'string' },
          updatedAfter: { type: 'string' },
          cursor: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
        },
      },
      proof: [
        'threads[].threadId',
        'threads[].channels',
        'threads[].summary',
        'threads[].providerLinks',
      ],
      useFor: ['communication-history', 'contact-memory', 'unified-inbox', 'agent-readback'],
    }),
    action({
      id: 'read_communication_thread',
      title: 'Read one Speak communication thread',
      method: 'GET',
      path: '/api/communication-threads/{threadId}',
      kind: 'read',
      risk: 'low',
      callableByMcp: true,
      pathSchema: {
        type: 'object',
        required: ['threadId'],
        properties: { threadId: { type: 'string' } },
      },
      proof: ['thread.threadId', 'thread.channels', 'thread.summary', 'thread.providerLinks'],
      useFor: ['communication-history', 'contact-memory', 'agent-readback'],
    }),
    action({
      id: 'read_communication_thread_messages',
      title: 'Read Speak communication thread messages',
      method: 'GET',
      path: '/api/communication-threads/{threadId}/messages',
      kind: 'read',
      risk: 'low',
      callableByMcp: true,
      pathSchema: {
        type: 'object',
        required: ['threadId'],
        properties: { threadId: { type: 'string' } },
      },
      querySchema: {
        type: 'object',
        properties: {
          cursor: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
        },
      },
      proof: [
        'messages[].messageId',
        'messages[].channel',
        'messages[].body',
        'messages[].proof',
      ],
      useFor: ['communication-history', 'transcript-review', 'agent-readback'],
    }),
    action({
      id: 'send_communication_message',
      title: 'Send SMS or email through Speak delivery',
      method: 'POST',
      path: '/api/communication-messages/send',
      kind: 'write',
      risk: 'high',
      callableByMcp: false,
      externalSideEffect: true,
      requiresHumanConfirmation:
        'Required. This route sends real SMS/email and must stay behind explicit operator UI confirmation.',
      reasonNotCallable:
        'This sends real SMS/email through Telnyx or the workspace mailbox and must stay behind explicit operator UI confirmation.',
      requestSchema: {
        type: 'object',
        required: ['channel', 'body'],
        properties: {
          channel: { type: 'string', enum: ['sms', 'email'] },
          threadId: { type: 'string' },
          messageId: { type: 'string' },
          contactId: { type: 'string' },
          phone: { type: 'string' },
          email: { type: 'string' },
          subject: { type: 'string' },
          body: { type: 'string' },
          lead: leadSchema,
        },
      },
      proof: ['sent', 'channel', 'deliveryMode', 'proof.message_id', 'message.messageId'],
      preconditions: [
        'Read /api/health before opening or invoking first-party delivery UI.',
        'SMS backend send requires delivery.smsConfigured=true; current-device sms: handoff is separate and does not return backend proof.',
        'Email backend send requires delivery.emailConfigured=true, including accepted workspace send-as proof via delivery.emailSendAsConfigured=true.',
      ],
      useFor: ['operator-reply', 'sms-reply', 'email-reply', 'contact-field-delivery'],
    }),
    action({
      id: 'read_contact_communication_memory',
      title: 'Read compact Contact Memory',
      method: 'GET',
      path: '/api/contacts/{contactId}/communication-memory',
      kind: 'read',
      risk: 'low',
      callableByMcp: true,
      pathSchema: {
        type: 'object',
        required: ['contactId'],
        properties: { contactId: { type: 'string' } },
      },
      querySchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 20, default: 3 },
        },
      },
      proof: ['memory[].threadId', 'memory[].summary', 'memory[].topics', 'memory[].recentMessages'],
      useFor: ['contact-memory', 'runtime-context', 'agent-readback'],
    }),
    action({
      id: 'rebuild_communication_thread_summary',
      title: 'Rebuild a communication thread summary',
      method: 'POST',
      path: '/api/communication-threads/{threadId}/summary/rebuild',
      kind: 'maintenance',
      risk: 'medium',
      callableByMcp: false,
      reasonNotCallable:
        'Summary rebuild mutates materialized state and is reserved for trusted maintenance or migration jobs.',
      pathSchema: {
        type: 'object',
        required: ['threadId'],
        properties: { threadId: { type: 'string' } },
      },
      proof: ['thread.threadId', 'thread.summary', 'topics[]'],
      useFor: ['communication-history', 'maintenance'],
    }),
    action({
      id: 'record_communication_event',
      title: 'Record a normalized communication event',
      method: 'POST',
      path: '/api/communication-events',
      kind: 'internal',
      risk: 'high',
      callableByMcp: false,
      reasonNotCallable:
        'This internal mirror accepts only trusted server/local event writes and must not be exposed as an operator tool.',
      requestSchema: {
        type: 'object',
        properties: {
          callControlId: { type: 'string' },
          event: { type: 'object' },
          lead: leadSchema,
          allowAutomation: {
            type: 'boolean',
            description:
              'Optional trusted-ingester opt-in. Defaults to false; inbound SMS/email/call events are recorded with no-auto proof unless this is true and explicit context policy authorizes a reply or answer.',
          },
        },
      },
      proof: ['thread.threadId', 'message.messageId', 'topics[]'],
      useFor: ['communication-history', 'provider-event-ingest'],
    }),
    action({
      id: 'sync_workspace_email',
      title: 'Sync Workspace email into communication threads',
      method: 'POST',
      path: '/api/workspace-email/sync',
      kind: 'internal',
      risk: 'high',
      callableByMcp: false,
      reasonNotCallable:
        'This bounded Gmail inbox/outbox sync is reserved for trusted server/local maintenance and can write real communication history.',
      requestSchema: {
        type: 'object',
        properties: {
          account: {
            type: 'string',
            description: 'Visible workspace mailbox identity. Defaults to WORKSPACE_EMAIL_ACCOUNT.',
          },
          authAccount: {
            type: 'string',
            description:
              'Optional GOG read auth account. Defaults to WORKSPACE_EMAIL_READ_GOG_ACCOUNT or the visible mailbox.',
          },
          query: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 500 },
          allowAutomation: { type: 'boolean' },
        },
      },
      preconditions: [
        'Read /api/health before applying source sync.',
        'Workspace email sync apply requires delivery.emailSourceReadConfigured=true.',
        'When authAccount differs from account, WORKSPACE_EMAIL_GOG_ACCOUNT_READS_MAILBOX must be set only after npm run qa:workspace-email-source proves mailbox participant visibility.',
      ],
      proof: ['scanned', 'recorded', 'skipped', 'records[].messageId'],
      useFor: ['communication-history', 'workspace-email-sync', 'provider-event-ingest'],
    }),
    action({
      id: 'read_workspace',
      title: 'Read the full server-owned workspace',
      method: 'GET',
      path: '/api/workspace',
      kind: 'read',
      risk: 'low',
      callableByMcp: true,
      proof: [
        'leads',
        'smartViews',
        'profiles',
        'activeProfileId',
        'dialerState',
        'communicationThreads',
        'communicationMessages',
        'communicationTopics',
        'contactIdentityLinks',
        'updatedAt',
      ],
      useFor: ['workspace-sync', 'headless-preflight'],
    }),
    action({
      id: 'search_workspace',
      title: 'Search workspace contacts, profiles, views, and threads',
      method: 'GET',
      path: '/api/search',
      kind: 'read',
      risk: 'low',
      callableByMcp: true,
      querySchema: {
        type: 'object',
        properties: {
          q: { type: 'string', description: 'Search text.' },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
      },
      proof: [
        'schemaVersion=speak.workspace-search.v1',
        'query',
        'limit',
        'totalCandidates',
        'results[]',
        'truncated',
      ],
      failureContract:
        'Use this bounded read for global search and large workspaces. Do not fetch the full workspace just to rank contact search results.',
      useFor: ['global-search', 'large-workspace-read', 'contact-source-navigation'],
    }),
    action({
      id: 'upload_context_file',
      title: 'Upload a contact or agent context file',
      method: 'POST',
      path: '/api/context-files',
      kind: 'binary-upload',
      risk: 'medium',
      callableByMcp: false,
      documentedInOpenApi: true,
      reasonNotCallable:
        'This route consumes a raw binary request body. Use direct REST upload, then attach the returned attachment metadata through update_lead or upsert_profile.',
      requestHeaders: {
        'x-speak-file-name': {
          type: 'string',
          required: true,
          description: 'Original filename to preserve in attachment metadata.',
        },
        'x-speak-file-type': {
          type: 'string',
          required: false,
          description: 'Optional MIME type when Content-Type is generic.',
        },
      },
      requestContentTypes: {
        'application/octet-stream': {
          schema: { type: 'string', format: 'binary' },
        },
      },
      proof: ['attachment.id', 'attachment.extractionStatus', 'attachment.contentChars'],
      failureContract:
        'Do not assume the agent can use uploaded file contents until the response attachment is persisted in lead.context.files or profile.context.files and extractionStatus/contentChars have been reviewed.',
      useFor: ['context-knowledge', 'headless-workspace', 'file-ingestion'],
    }),
    action({
      id: 'download_context_file',
      title: 'Download an attached context file',
      method: 'GET',
      path: '/api/context-files/{fileId}/download',
      kind: 'binary-download',
      risk: 'medium',
      callableByMcp: false,
      documentedInOpenApi: true,
      reasonNotCallable:
        'This route returns private binary workspace data. Use direct REST only when the user or trusted host is authorized to retrieve the original file.',
      pathSchema: {
        type: 'object',
        required: ['fileId'],
        properties: { fileId: { type: 'string' } },
      },
      proof: ['HTTP 200 file response or 404 JSON error'],
      useFor: ['context-knowledge', 'file-review'],
    }),
    action({
      id: 'delete_context_file',
      title: 'Delete a stored context file blob',
      method: 'DELETE',
      path: '/api/context-files/{fileId}',
      kind: 'binary-delete',
      risk: 'high',
      callableByMcp: false,
      documentedInOpenApi: true,
      requiresHumanConfirmation:
        'Required unless the current task explicitly authorizes deleting context files.',
      reasonNotCallable:
        'Delete the binary through direct REST only as part of a context cleanup flow, then remove the attachment metadata from contact/profile context through update_lead or upsert_profile.',
      pathSchema: {
        type: 'object',
        required: ['fileId'],
        properties: { fileId: { type: 'string' } },
      },
      proof: ['deleted=true'],
      useFor: ['context-knowledge', 'file-cleanup'],
    }),
    action({
      id: 'read_personal_phone_contacts_status',
      title: 'Read personal phone contacts source status',
      method: 'GET',
      path: '/api/personal-phone/contacts',
      kind: 'read',
      risk: 'low',
      callableByMcp: true,
      proof: ['configured', 'source=personal-phone', 'sourceId', 'helperConnected'],
      useFor: ['personal-phone-source-sync', 'workspace-sync', 'preflight'],
    }),
    action({
      id: 'read_calltools_campaign_contacts_status',
      title: 'Read CallTools campaign contacts source status',
      method: 'GET',
      path: '/api/calltools/campaign-contacts',
      kind: 'read',
      risk: 'low',
      callableByMcp: true,
      proof: ['configured', 'campaignId', 'liveFilterId', 'bucketId', 'sourceKind', 'source'],
      useFor: ['calltools-source-sync', 'workspace-sync', 'preflight'],
    }),
    action({
      id: 'read_calltools_readiness',
      title: 'Read CallTools Phone-as-Agent readiness',
      method: 'GET',
      path: '/api/calltools/readiness',
      kind: 'read',
      risk: 'low',
      callableByMcp: true,
      proof: [
        'ready',
        'runtimeReady',
        'directStartReady',
        'campaignReady',
        'liveCallAttached',
        'checks[]',
        'blockers[]',
        'counts.dispositions',
        'dutyMonitor.backendMonitored',
        'dutyMonitor.autoRearm=true',
        'dutyMonitor.status',
      ],
      failureContract:
        'Read-only production preflight for CallTools campaign following. campaignReady and liveCallAttached are the supported operational proofs. directStartReady is retained only as a legacy transport diagnostic and never authorizes /api/calls/start, which rejects CallTools transport before provider mutation. This action must not start, stop, activate, or mutate CallTools campaigns.',
      useFor: ['calltools-readiness', 'phone-as-agent-preflight', 'operations-health'],
    }),
    action({
      id: 'establish_calltools_agent_session',
      title: 'Start or release a CallTools campaign agent session',
      method: 'POST',
      path: '/api/calltools/agent-session',
      kind: 'maintenance',
      risk: 'medium',
      callableByMcp: false,
      documentedInOpenApi: true,
      externalSideEffect: true,
      requiresHumanConfirmation:
        'Required before activating the native campaign and mutating its agent session.',
      requestSchema: {
        type: 'object',
        properties: {
          profileId: { type: 'string' },
          ready: { type: 'boolean' },
          apply: { type: 'boolean' },
          confirmAgentSession: { type: 'boolean' },
          appUserId: { type: 'string' },
          campaignId: { type: 'string' },
          contactSourceKey: { type: 'string' },
          agentStatusId: { type: 'string' },
          webPhoneStatus: { type: 'string' },
        },
      },
      proof: [
        'backendOnly',
        'headlessOnly',
        'establishPath',
        'campaignStartPath',
        'campaignAgentEstablishPath',
        'mutationPerformed',
        'campaignStart.ok',
        'campaignAgentStatus.ready',
        'proof.loggedIn',
        'proof.proofSources[]',
        'dutyMonitor.backendMonitored',
        'dutyMonitor.status',
      ],
      failureContract:
        'Headless backend action for the durable CallTools Available/Unavailable handoff. ready=true activates/originates the frozen native campaign, establishes campaign-agent and AgentStatus state, and claims SIP without a human login. It rejects browser automation or dashboard session state. Apply mode requires confirmAgentSession=true and never direct-dials a contact.',
      useFor: ['calltools-readiness', 'campaign-start', 'campaign-follow-availability', 'human-agent-handoff'],
    }),
    action({
      id: 'read_dialer_state',
      title: 'Read server-owned dialer continuity state',
      method: 'GET',
      path: '/api/dialer-state',
      kind: 'read',
      risk: 'low',
      callableByMcp: true,
      proof: [
        'dialerState.sourceId',
        'dialerState.campaignQueueIds',
        'dialerState.controllerHeartbeatAt',
        'dialerState.calltoolsDuty.status',
      ],
      useFor: ['workspace-sync', 'queue-continuity', 'device-handoff'],
    }),
    action({
      id: 'update_dialer_state',
      title: 'Update server-owned dialer continuity state',
      method: 'PATCH',
      path: '/api/dialer-state',
      kind: 'mutation',
      risk: 'medium',
      callableByMcp: true,
      externalSideEffect: false,
      requestSchema: {
        type: 'object',
        properties: {
          dialerState: dialerStateSchema,
        },
      },
      proof: [
        'dialerState.updatedAt',
        'dialerState.sourceId',
        'dialerState.campaignRunning',
        'dialerState.calltoolsDuty.status',
      ],
      useFor: ['workspace-sync', 'queue-continuity', 'device-handoff'],
    }),
    action({
      id: 'list_leads',
      title: 'List server-owned contact records',
      method: 'GET',
      path: '/api/leads',
      kind: 'read',
      risk: 'low',
      callableByMcp: true,
      querySchema: {
        type: 'object',
        properties: {
          q: { type: 'string', description: 'Bounded contact search text.' },
          source: { type: 'string', description: 'Contact source key.' },
          sourceId: { type: 'string', description: 'Provider/source instance ID.' },
          smartViewId: { type: 'string', description: 'Filter contacts to a saved Smart View.' },
          ids: { type: 'string', description: 'Comma-separated contact IDs to return.' },
          includeIds: {
            type: 'string',
            description: 'Comma-separated selected IDs to include when they match the source/view.',
          },
          limit: { type: 'integer', minimum: 1, maximum: 500 },
        },
      },
      proof: [
        'leads[]',
        'deletedLeadIds',
        'deletedLeadFingerprints',
        'resultCount',
        'totalMatching',
        'truncated',
      ],
      useFor: ['lead-management', 'queue-planning', 'large-workspace-read'],
    }),
    action({
      id: 'replace_leads',
      title: 'Replace server-owned contact workspace',
      method: 'PUT',
      path: '/api/leads',
      kind: 'mutation',
      risk: 'high',
      callableByMcp: true,
      externalSideEffect: false,
      requiresHumanConfirmation:
        'Required unless the current task explicitly authorizes replacing the contact workspace.',
      requestSchema: {
        type: 'object',
        required: ['leads'],
        properties: {
          leads: { type: 'array', items: leadSchema },
          deletedLeadIds: { type: 'array', items: { type: 'string' } },
          deletedLeadFingerprints: { type: 'array', items: { type: 'string' } },
        },
      },
      proof: ['leads[]', 'updatedAt'],
      useFor: ['lead-migration', 'workspace-restore'],
    }),
    action({
      id: 'create_lead',
      title: 'Create one contact record',
      method: 'POST',
      path: '/api/leads',
      kind: 'mutation',
      risk: 'medium',
      callableByMcp: true,
      externalSideEffect: true,
      requestSchema: {
        type: 'object',
        required: ['lead'],
        properties: { lead: leadSchema },
      },
      proof: ['lead.id'],
      useFor: ['lead-management'],
    }),
    action({
      id: 'import_leads',
      title: 'Import contact records',
      method: 'POST',
      path: '/api/leads/import',
      kind: 'mutation',
      risk: 'medium',
      callableByMcp: true,
      requestSchema: {
        type: 'object',
        required: ['leads'],
        properties: {
          leads: { type: 'array', items: leadSchema },
        },
      },
      proof: ['imported[]', 'leads[]'],
      useFor: ['lead-import', 'csv-import-adapters'],
    }),
    action({
      id: 'list_smart_views',
      title: 'List saved Smart Views',
      method: 'GET',
      path: '/api/smart-views',
      kind: 'read',
      risk: 'low',
      callableByMcp: true,
      proof: ['contactSources[]', 'smartViews[]'],
      useFor: ['contact-source-routing', 'smart-view-management', 'queue-planning'],
    }),
    action({
      id: 'upsert_smart_view',
      title: 'Create or update a Smart View',
      method: 'POST',
      path: '/api/smart-views',
      kind: 'mutation',
      risk: 'medium',
      callableByMcp: true,
      requestSchema: {
        type: 'object',
        required: ['smartView'],
        properties: { smartView: smartViewSchema },
      },
      proof: ['smartView.id', 'smartViews[]'],
      useFor: ['smart-view-management', 'filter-snapshots'],
    }),
    action({
      id: 'import_smart_view_leads',
      title: 'Import contacts as a Smart View',
      method: 'POST',
      path: '/api/smart-views/import',
      kind: 'mutation',
      risk: 'medium',
      callableByMcp: true,
      requestSchema: {
        type: 'object',
        required: ['name', 'leads'],
        properties: {
          name: { type: 'string' },
          leads: { type: 'array', items: leadSchema },
        },
      },
      proof: ['smartView.id', 'imported[]', 'leads[]', 'smartViews[]'],
      useFor: ['smart-view-management', 'csv-import-adapters'],
    }),
    action({
      id: 'sync_personal_phone_contacts',
      title: 'Sync personal phone contacts as a contact source',
      method: 'POST',
      path: '/api/personal-phone/contacts/sync',
      kind: 'mutation',
      risk: 'medium',
      callableByMcp: true,
      externalSideEffect: false,
      proof: [
        'contactSource.id',
        'personalPhone.sourceId',
        'personalPhone.importedCount',
        'imported[]',
        'leads[]',
        'contactSources[]',
      ],
      useFor: ['contact-source-management', 'personal-phone-source-sync', 'queue-planning'],
    }),
    action({
      id: 'sync_calltools_campaign_contacts',
      title: 'Sync CallTools campaign contacts as a contact source',
      method: 'POST',
      path: '/api/calltools/campaign-contacts/sync',
      kind: 'mutation',
      risk: 'medium',
      callableByMcp: true,
      externalSideEffect: false,
      requestSchema: {
        type: 'object',
        properties: {
          profileId: { type: 'string' },
          profileName: { type: 'string' },
          config: campaignConfigSchema,
        },
      },
      proof: [
        'contactSource.id',
        'calltools.campaignId',
        'calltools.sourceKind',
        'calltools.liveFilterId',
        'calltools.bucketId',
        'calltools.queriedContactCount',
        'calltools.importedCount',
        'imported[]',
        'leads[]',
        'contactSources[]',
      ],
      failureContract:
        'This is a read/import sync only. It does not start, stop, or mutate a CallTools campaign.',
      useFor: ['contact-source-management', 'calltools-source-sync', 'queue-planning'],
    }),
    action({
      id: 'delete_smart_view',
      title: 'Delete a Smart View',
      method: 'DELETE',
      path: '/api/smart-views/{smartViewId}',
      kind: 'mutation',
      risk: 'medium',
      callableByMcp: true,
      requiresHumanConfirmation:
        'Required unless the current task explicitly authorizes deleting saved Smart Views.',
      pathSchema: {
        type: 'object',
        required: ['smartViewId'],
        properties: { smartViewId: { type: 'string' } },
      },
      proof: ['smartViews[]', 'profiles[]', 'activeProfileId'],
      useFor: ['smart-view-management'],
    }),
    action({
      id: 'update_lead',
      title: 'Update one contact record',
      method: 'PATCH',
      path: '/api/leads/{leadId}',
      kind: 'mutation',
      risk: 'medium',
      callableByMcp: true,
      pathSchema: {
        type: 'object',
        required: ['leadId'],
        properties: { leadId: { type: 'string' } },
      },
      requestSchema: {
        type: 'object',
        required: ['patch'],
        properties: { patch: leadSchema },
      },
      proof: ['lead.id'],
      useFor: ['lead-management', 'status-editing', 'contact-correction'],
    }),
    action({
      id: 'delete_lead',
      title: 'Delete one contact record',
      method: 'DELETE',
      path: '/api/leads/{leadId}',
      kind: 'mutation',
      risk: 'high',
      callableByMcp: true,
      requiresHumanConfirmation:
        'Required unless the current task explicitly authorizes deleting contacts.',
      pathSchema: {
        type: 'object',
        required: ['leadId'],
        properties: { leadId: { type: 'string' } },
      },
      proof: ['deleted[]', 'leads[]'],
      useFor: ['lead-management'],
    }),
    action({
      id: 'bulk_update_lead_status',
      title: 'Bulk update contact status',
      method: 'POST',
      path: '/api/leads/bulk-status',
      kind: 'mutation',
      risk: 'medium',
      callableByMcp: true,
      requestSchema: {
        type: 'object',
        required: ['ids', 'status'],
        properties: {
          ids: { type: 'array', items: { type: 'string' } },
          status: { type: 'string' },
        },
      },
      proof: ['patched[]', 'leads[]'],
      useFor: ['lead-management', 'bulk-workflows'],
    }),
    action({
      id: 'bulk_delete_leads',
      title: 'Bulk delete contacts',
      method: 'POST',
      path: '/api/leads/bulk-delete',
      kind: 'mutation',
      risk: 'high',
      callableByMcp: true,
      requiresHumanConfirmation:
        'Required unless the current task explicitly authorizes deleting contacts.',
      requestSchema: {
        type: 'object',
        required: ['ids'],
        properties: {
          ids: { type: 'array', items: { type: 'string' } },
        },
      },
      proof: ['deleted[]', 'leads[]'],
      useFor: ['lead-management', 'bulk-workflows'],
    }),
    action({
      id: 'list_profiles',
      title: 'List saved agent profiles',
      method: 'GET',
      path: '/api/profiles',
      kind: 'read',
      risk: 'low',
      callableByMcp: true,
      proof: ['profiles[]', 'activeProfileId'],
      useFor: ['profile-management'],
    }),
    action({
      id: 'replace_profiles',
      title: 'Replace saved profile workspace',
      method: 'PUT',
      path: '/api/profiles',
      kind: 'mutation',
      risk: 'high',
      callableByMcp: true,
      requiresHumanConfirmation:
        'Required unless the current task explicitly authorizes replacing saved profiles.',
      requestSchema: {
        type: 'object',
        required: ['profiles'],
        properties: {
          profiles: { type: 'array', items: profileSchema },
          activeProfileId: { type: 'string' },
        },
      },
      proof: ['profiles[]', 'activeProfileId'],
      useFor: ['profile-management', 'workspace-restore'],
    }),
    action({
      id: 'upsert_profile',
      title: 'Create or update a saved profile record',
      method: 'POST',
      path: '/api/profiles',
      kind: 'mutation',
      risk: 'medium',
      callableByMcp: true,
      requestSchema: {
        type: 'object',
        required: ['profile'],
        properties: { profile: profileSchema },
      },
      proof: ['profile.id'],
      useFor: ['profile-management'],
    }),
    action({
      id: 'set_active_profile',
      title: 'Set current agent profile pointer',
      method: 'PUT',
      path: '/api/profiles/active',
      kind: 'mutation',
      risk: 'medium',
      callableByMcp: true,
      requestSchema: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      proof: ['activeProfileId'],
      useFor: ['profile-management', 'workspace-current-profile'],
    }),
    action({
      id: 'delete_profile',
      title: 'Delete a saved profile record',
      method: 'DELETE',
      path: '/api/profiles/{profileId}',
      kind: 'mutation',
      risk: 'high',
      callableByMcp: true,
      requiresHumanConfirmation:
        'Required unless the current task explicitly authorizes deleting saved profiles.',
      pathSchema: {
        type: 'object',
        required: ['profileId'],
        properties: { profileId: { type: 'string' } },
      },
      proof: ['profiles[]', 'activeProfileId'],
      useFor: ['profile-management'],
    }),
    action({
      id: 'start_live_call',
      title: 'Start a real Speak/Telnyx outbound phone call',
      method: 'POST',
      path: '/api/calls/start',
      kind: 'mutation',
      risk: 'high',
      callableByMcp: true,
      externalSideEffect: true,
      requiresConfiguredRuntime: true,
      requiresHumanConfirmation:
        'Required unless the current task explicitly authorizes placing live calls.',
      requestSchema: {
        type: 'object',
        required: ['lead'],
        properties: {
          lead: leadSchema,
          config: campaignConfigSchema,
          operatorInstructions: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
      proof: ['callControlId'],
      failureContract:
        'Only Speak/Telnyx direct calls are supported. Any request whose resolved config uses dialerProvider=calltools fails before provider mutation with calltools_direct_start_disabled; use read_calltools_readiness plus the durable Available lease and live campaign events for CallTools. Do not claim a Speak/Telnyx call started unless the response includes callControlId and subsequent events confirm provider progress.',
      useFor: ['speak-telnyx-live-dialing'],
    }),
    action({
      id: 'start_phone_config_test',
      title: 'Start a real phone Playground test',
      method: 'POST',
      path: '/api/calls/start',
      kind: 'mutation',
      risk: 'high',
      callableByMcp: true,
      externalSideEffect: true,
      requiresConfiguredRuntime: true,
      requiresHumanConfirmation:
        'Required unless the current task explicitly authorizes placing a real phone test call.',
      requestSchema: {
        type: 'object',
        required: ['lead', 'config'],
        properties: {
          lead: leadSchema,
          config: campaignConfigSchema,
          operatorInstructions: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
      proof: ['callControlId'],
      failureContract:
        'This path places a real outbound phone call through Speak/Telnyx. The test config must use dialerProvider=speak even when the saved profile is assigned to CallTools; CallTools transport is rejected before provider mutation. Do not claim phone quality testing started unless callControlId is returned and call events confirm provider progress.',
      useFor: ['profile-testing', 'phone-quality-testing'],
    }),
    action({
      id: 'stream_call_events',
      title: 'Stream realtime call events',
      method: 'GET',
      path: '/api/calls/{callControlId}/events',
      kind: 'sse',
      risk: 'low',
      callableByMcp: false,
      reasonNotCallable:
        'ChatGPT MCP tools are request/response. Use read_communication_thread_messages or read_recent_calls for proof polling.',
      pathSchema: {
        type: 'object',
        required: ['callControlId'],
        properties: { callControlId: { type: 'string' } },
      },
      proof: ['event.patch.phase', 'event.entry', 'event.notice', 'event.diagnostic'],
      useFor: ['live-transcript', 'call-state', 'proof-after-mutation'],
    }),
    action({
      id: 'pause_agent_for_takeover',
      title: 'Pause Speak assistant for human takeover',
      method: 'POST',
      path: '/api/calls/{callControlId}/barge-in',
      kind: 'mutation',
      risk: 'high',
      callableByMcp: true,
      externalSideEffect: true,
      requiresHumanConfirmation:
        'Required unless the current task explicitly authorizes live-call takeover.',
      pathSchema: {
        type: 'object',
        required: ['callControlId'],
        properties: { callControlId: { type: 'string' } },
      },
      requestSchema: {
        type: 'object',
        properties: { chatId: { type: 'string' } },
      },
      proof: ['ok', 'event.patch.takeover=true'],
      useFor: ['human-takeover'],
    }),
    action({
      id: 'resume_agent_after_takeover',
      title: 'Resume Speak assistant after takeover',
      method: 'POST',
      path: '/api/calls/{callControlId}/resume',
      kind: 'mutation',
      risk: 'medium',
      callableByMcp: true,
      externalSideEffect: true,
      pathSchema: {
        type: 'object',
        required: ['callControlId'],
        properties: { callControlId: { type: 'string' } },
      },
      requestSchema: {
        type: 'object',
        properties: { chatId: { type: 'string' } },
      },
      proof: ['ok', 'event.patch.takeover=false'],
      useFor: ['human-takeover'],
    }),
    action({
      id: 'send_live_instruction',
      title: 'Send one-turn live instruction to the Speak agent',
      method: 'POST',
      path: '/api/calls/{callControlId}/instructions',
      kind: 'mutation',
      risk: 'medium',
      callableByMcp: true,
      externalSideEffect: true,
      pathSchema: {
        type: 'object',
        required: ['callControlId'],
        properties: { callControlId: { type: 'string' } },
      },
      requestSchema: {
        type: 'object',
        required: ['instruction'],
        properties: {
          chatId: { type: 'string' },
          instruction: {
            type: 'string',
            description: 'Temporary guidance for the next assistant response only.',
          },
        },
      },
      proof: ['ok', 'event.notice=Live instruction delivered to agent'],
      useFor: ['live-guidance'],
    }),
    action({
      id: 'send_operator_chat_message',
      title: 'Send a conversational Speak operator chat turn',
      method: 'POST',
      path: '/api/operator-chat/turns',
      kind: 'mutation',
      risk: 'medium',
      callableByMcp: true,
      requestSchema: {
        type: 'object',
        required: ['surface', 'message'],
        properties: {
          surface: { type: 'string', enum: ['dialer', 'configs'] },
          message: { type: 'string' },
          authorizationMode: authorizationModeSchema,
          context: {
            type: 'object',
            additionalProperties: true,
            description:
              'Surface-specific state such as callControlId, chatId, selected contact, current config, active profile, or test variables.',
          },
        },
      },
      proof: ['turnId', 'intent', 'assistantMessage', 'actions[]', 'patches'],
      failureContract:
        'Do not claim that a live instruction, profile mutation, or test action succeeded unless the returned turn includes executed action proof or an explicit draft patch.',
      useFor: ['operator-chat', 'live-guidance', 'profile-editing', 'generative-ui'],
    }),
    action({
      id: 'end_live_call',
      title: 'End a live call',
      method: 'POST',
      path: '/api/calls/{callControlId}/end',
      kind: 'mutation',
      risk: 'high',
      callableByMcp: true,
      externalSideEffect: true,
      requiresHumanConfirmation:
        'Required unless the current task explicitly authorizes ending the live call.',
      pathSchema: {
        type: 'object',
        required: ['callControlId'],
        properties: { callControlId: { type: 'string' } },
      },
      requestSchema: {
        type: 'object',
        properties: { outcome: callOutcomeSchema },
      },
      proof: ['ok', 'alreadyEnded', 'outcome', 'event.patch.phase=ended'],
      failureContract:
        'Speak waits for the phone minimum hangup duration; a 409 means hangup is already pending.',
      useFor: ['live-dialing', 'call-cleanup'],
    }),
    action({
      id: 'read_call_audio_link',
      title: 'Read call audio metadata or reconstruction status',
      method: 'GET',
      path: '/api/calls/{callControlId}/audio-link',
      kind: 'read',
      risk: 'low',
      callableByMcp: true,
      pathSchema: {
        type: 'object',
        required: ['callControlId'],
        properties: { callControlId: { type: 'string' } },
      },
      proof: ['status', 'url', 'source'],
      useFor: ['recording-review'],
    }),
    action({
      id: 'read_speak_config',
      title: 'Read a Speak config through the backend',
      method: 'GET',
      path: '/api/agent-configs/speak/{configId}',
      kind: 'read',
      risk: 'low',
      callableByMcp: true,
      pathSchema: {
        type: 'object',
        required: ['configId'],
        properties: { configId: { type: 'string' } },
      },
      proof: ['speakConfigId', 'name', 'version', 'prompt', 'voice', 'tools'],
      useFor: ['profile-readback', 'runtime-parity'],
    }),
    action({
      id: 'read_speak_options',
      title: 'Read Speak voice/model/config options',
      method: 'GET',
      path: '/api/agent-configs/speak-options',
      kind: 'read',
      risk: 'low',
      callableByMcp: true,
      proof: [
        'eviVersions',
        'voices',
        'languageModels',
        'codexAuthModels',
        'providerErrors',
      ],
      useFor: ['profile-editing'],
    }),
    action({
      id: 'sync_speak_config',
      title: 'Create or update a matching Speak config',
      method: 'POST',
      path: '/api/agent-configs/sync-speak',
      kind: 'mutation',
      risk: 'medium',
      callableByMcp: true,
      externalSideEffect: false,
      requestSchema: {
        type: 'object',
        properties: {
          profileId: { type: 'string' },
          profileName: { type: 'string' },
          createNew: { type: 'boolean' },
          ownedUpdates: ownedUpdatesSchema,
          config: campaignConfigSchema,
        },
      },
      proof: ['ok', 'action', 'speakConfigId', 'speakConfigVersion', 'config'],
      failureContract:
        'Do not claim a profile synced unless the backend returns config identity/version proof.',
      useFor: ['profile-editing', 'speak-sync'],
    }),
    action({
      id: 'read_browser_config_tests',
      title: 'Read recent browser Speak Playground tests',
      method: 'GET',
      path: '/api/config-tests/recent',
      kind: 'read',
      risk: 'low',
      callableByMcp: true,
      querySchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 24 },
          profileId: { type: 'string' },
          profileName: { type: 'string' },
        },
      },
      proof: ['tests[].callControlId', 'tests[].agent', 'tests[].transcript'],
      failureContract:
        'Use this read path to retrieve persisted browser playground attempts before claiming a test conversation is unavailable.',
      useFor: ['profile-testing', 'prompt-testing', 'transcript-review'],
    }),
    action({
      id: 'start_browser_config_test',
      title: 'Start a browser Speak Playground test',
      method: 'POST',
      path: '/api/config-tests/start',
      kind: 'mutation',
      risk: 'medium',
      callableByMcp: true,
      requestSchema: {
        type: 'object',
        properties: {
          config: campaignConfigSchema,
          lead: leadSchema,
          productionContext: {
            type: 'boolean',
            default: true,
            description:
              'Defaults to true so browser Playground tests use the selected contact and normal configured agent actions while still not placing a phone call. Set false only for a legacy sandboxed config-test API mode.',
          },
          testVariables: testVariablesSchema,
          testVariableKeys: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
      proof: ['testId', 'callControlId'],
      failureContract:
        'This path never places a real phone call. By default it uses production-style selected-contact context and configured agent actions; set productionContext=false only for a sandboxed browser test.',
      useFor: ['profile-testing', 'prompt-testing'],
    }),
    action({
      id: 'send_browser_config_message',
      title: 'Send a typed user message to a browser Speak playground test',
      method: 'POST',
      path: '/api/config-tests/{testId}/message',
      kind: 'mutation',
      risk: 'medium',
      callableByMcp: true,
      pathSchema: {
        type: 'object',
        required: ['testId'],
        properties: { testId: { type: 'string' } },
      },
      requestSchema: {
        type: 'object',
        required: ['text'],
        properties: {
          text: {
            type: 'string',
            description:
              'A test-contact/user turn. This is not hidden operator guidance and must not alter the profile prompt.',
          },
        },
      },
      proof: ['ok'],
      failureContract:
        'Do not claim the agent responded until the call-event stream returns the assistant transcript turn.',
      useFor: ['profile-testing', 'prompt-testing', 'chat-playground'],
    }),
    action({
      id: 'stream_browser_config_audio',
      title: 'Stream browser microphone audio to a Playground test',
      method: 'WEBSOCKET',
      path: '/api/config-tests/{testId}/audio',
      kind: 'websocket',
      risk: 'medium',
      callableByMcp: false,
      pathSchema: {
        type: 'object',
        required: ['testId'],
        properties: { testId: { type: 'string' } },
      },
      proof: ['binary PCM audio frames', 'audio_clear messages'],
      useFor: ['browser-audio-test'],
    }),
    action({
      id: 'end_browser_config_test',
      title: 'End a browser-only Speak Playground test',
      method: 'POST',
      path: '/api/config-tests/{testId}/end',
      kind: 'mutation',
      risk: 'medium',
      callableByMcp: true,
      pathSchema: {
        type: 'object',
        required: ['testId'],
        properties: { testId: { type: 'string' } },
      },
      proof: ['ok'],
      useFor: ['profile-testing', 'cleanup'],
    }),
    action({
      id: 'codex_clm_chat_completion',
      title: 'Internal Codex custom language model bridge',
      method: 'POST',
      path: '/api/codex-clm/chat/completions',
      kind: 'internal',
      risk: 'high',
      callableByMcp: false,
      reasonNotCallable:
        'This route is for Speak custom language model callbacks and uses backend session context.',
    }),
    action({
      id: 'phone_media_stream',
      title: 'Phone media WebSocket',
      method: 'WEBSOCKET',
      path: '/media-stream',
      kind: 'provider-websocket',
      risk: 'high',
      callableByMcp: false,
      reasonNotCallable:
        'This route is the phone media transport, not an operator or agent control surface.',
    }),
    action({
      id: 'phone_provider_webhook',
      title: 'Telnyx phone provider webhook receiver',
      method: 'POST',
      path: '/api/webhooks/telnyx',
      kind: 'provider-webhook',
      risk: 'high',
      callableByMcp: false,
      reasonNotCallable:
        'Provider webhooks must not be simulated by MCP tools except in isolated tests.',
    }),
    action({
      id: 'voice_provider_webhook',
      title: 'Hume voice provider webhook receiver',
      method: 'POST',
      path: '/api/webhooks/hume',
      kind: 'provider-webhook',
      risk: 'high',
      callableByMcp: false,
      reasonNotCallable:
        'Provider webhooks must not be simulated by MCP tools except in isolated tests.',
    }),
  ]

  return {
    schemaVersion: 'speak.agent.capabilities.v1',
    contractVersion,
    product: {
      name: 'Speak',
      purpose:
        'Voice-agent operations workspace for enterprises, startups, independent operators, and sole proprietors.',
      productionUrl: 'https://speak.example.com/speak/',
      productionPlaygroundUrl: 'https://speak.example.com/speak/configs',
      productionConfigUrl: 'https://speak.example.com/speak/configs',
      productionHealthUrl: 'https://speak.example.com/speak/api/health',
    },
    runtime: {
      appRoot: root || '/',
      basePath: normalizeBasePath(basePath),
      localUi: 'http://127.0.0.1:5173',
      localApi: 'http://127.0.0.1:8787',
      expectedLiveBaseline: {
        useConfigPrompt: true,
        useConfigTools: true,
        autoStartGreeting: false,
        phoneStreamCodec: 'L16',
        audioSampleRate: 16000,
        calleeSpeaksFirst: true,
        phoneMinimumHangupMs: 10000,
      },
      voiceRuntime: {
        providers: ['hume', 'inworld', 'xai'],
        modelDropdownGroups: ['provider-native', 'codex-auth'],
        modelSelectionInvariant:
          'Hume and Inworld expose provider-native models separately from Codex-auth models in the same model dropdown. xAI exposes only its native Voice Agent models because the realtime API has no external LLM hook. Hume Codex-auth options mirror the authenticated Codex catalogue. Inworld Codex-auth options are the live intersection of that catalogue with the Inworld model catalogue, and every selectable Inworld model must advertise function calling because production Speak sessions require shared tools. Advertised input and output modality lists must both include text. Native sessions send NONE only when the live model capability advertises EFFORT_NONE and otherwise omit reasoning configuration. Playground, direct-phone, CallTools duty, and native campaign-invite paths revalidate the saved selection through the short-lived provider catalogue cache before creating call state. Inworld Codex-auth reasoning is fixed to NONE while shared function tools are active because its chat-completions route rejects tools combined with nonzero reasoning. Fast mode applies to every returned Codex-auth selection in Hume and Inworld; on Inworld it disables conversational TTS context and uses fast_start.',
        transcriptPersistence:
          'Speak-owned communication threads/messages are the primary transcript and contact-memory read model for Hume, Inworld, and xAI sessions. Raw call logs remain durable audit/source records and provider-specific transcript history is optional readback only.',
        providerOnboarding: {
          playbook: 'docs/voice-provider-integration.md',
          requiredCoreFeatures: [
            'realtime speech-to-speech',
            'browser playground',
            'phone call path',
            'input audio',
            'output audio',
            'barge-in',
            'turn finalization',
            'transcript persistence',
            'recording/audio retrieval',
            'provider-native model catalogue',
            'Codex-auth model route audit',
            'voice catalogue',
            'tool/function calling',
            'prompt/session contract',
            'context injection',
            'live guidance/takeover',
            'provider config sync proof',
            'observability',
            'safe MCP/action boundary',
            'official MCP/CLI/SDK discovery',
          ],
          optimizationAudit: [
            'latency and streaming mode',
            'turn detection and interruption controls',
            'codec and sample-rate fit with browser, Telnyx, and CallTools gateway audio',
            'noise suppression, backchannel, and responsiveness settings',
            'STT/TTS model, voice steering, language, and pronunciation controls',
            'session resume, reconnect, and conversation replay',
            'tool-call streaming and confirmation hooks',
            'native transcript, recording, analytics, and quality signals',
            'rate limits, policy events, and safety controls',
            'official CLI, MCP, SDK debug tools, and simulator support',
          ],
          mcpDiscoveryRule:
            'Search installed Codex tools and official provider docs for MCP, CLI, SDK, examples, and debug servers before implementation. Install only official or provider-owned MCP servers, keep secrets outside the repo, and verify initialize plus tools/list.',
        },
      },
      communicationThreads: {
        playbook: 'docs/communication-thread-model.md',
        status: 'implemented',
        currentReadActions: [
          'read_communication_threads',
          'read_communication_thread',
          'read_communication_thread_messages',
          'read_contact_communication_memory',
          'read_recent_calls',
          'read_browser_config_tests',
        ],
        primaryObjects: [
          'communicationThread',
          'communicationMessage',
          'communicationTopic',
          'contactIdentityLink',
        ],
        channels: ['call', 'sms', 'email', 'browser_test', 'operator_chat', 'tool', 'system'],
        invariant:
          'Calls, SMS, email, browser tests, operator chat, tool proof, recordings, and provider events must normalize into contact-scoped communication threads/messages. Provider IDs stay metadata; ambiguous inbound attribution remains unresolved until verified.',
        memoryRule:
          'Runtime Contact Memory should use compact thread/topic summaries and bounded recent messages by contactId; full transcripts, SMS, or email bodies are retrieved only when relevant.',
        attributionRule:
          'Inbound SMS, inbound calls, and email must attach through verified contactIdentityLink records. Name/company-only matching is not sufficient.',
        sourceIngressRule:
          'Production Telnyx SMS and Call Control webhooks must require Ed25519 signature verification before source persistence.',
        automationRule:
          'Auto-reply and inbound call auto-answer are default-off/default-none. Explicit inbound call auto-answer must use Telnyx Call Control answer with Speak bidirectional media stream and backend proof.',
        productionValidationCommands: [
          'npm run qa:telnyx-source-routing',
          'npm run qa:workspace-email',
          'npm run qa:workspace-email-source',
        ],
      },
    },
    frontend: {
      routes: [
        {
          id: 'library',
          label: 'Library',
          path: '/library',
          url: routeUrl(root, '/library'),
          purpose:
            'Contact library, source selection, Smart Views, CSV/personal-phone/CallTools import, bulk record operations, agent reconciliation, and transcript history review.',
        },
        {
          id: 'dialer',
          label: 'Dialer',
          path: '/dialer',
          url: routeUrl(root, '/dialer'),
          purpose: 'Live contact queue, outbound call controls, transcript, and history.',
        },
        {
          id: 'configs',
          label: 'Playground',
          path: '/configs',
          url: routeUrl(root, '/configs'),
          purpose:
            'Playground profile editing, Speak sync, browser tests, phone-quality tests, and owner Smart Config.',
        },
      ],
      uiActions: buildUiActionContract(),
      automation: buildUiAutomationContract(),
      designSystem: buildUiDesignContract(),
      browserStateStores: [
        {
          key: 'speak:leads:v2',
          owns: 'browser migration/cache copy of contact queue rows',
        },
        {
          key: 'speak:deleted-lead-ids:v2',
          owns: 'deleted lead IDs that must not reappear from seeded defaults',
        },
        {
          key: 'speak:deleted-lead-fingerprints:v2',
          owns: 'deleted lead phone/email/name fingerprints that must not reappear',
        },
        {
          key: 'speak:agent-configs:v1',
          owns: 'browser migration/cache copy of saved profile definitions',
        },
        {
          key: 'speak:active-agent-config-id:v1',
          owns: 'browser migration/cache copy of selected profile ID',
        },
        {
          key: 'speak:lead-column-order:v1',
          owns: 'custom lead table column order',
        },
        {
          key: 'speak:appearance',
          owns: 'light/dark appearance preference',
        },
      ],
      automationNote:
        'Contact-record and profile CRUD are server-addressable. LocalStorage is now a migration/fallback cache for browser ergonomics, not the headless source of truth.',
    },
    dataSchemas: {
      lead: leadSchema,
      profile: profileSchema,
      contextFields: contextFieldsSchema,
      contextAttachment: contextAttachmentSchema,
      contextUrlSnapshot: contextUrlSnapshotSchema,
      smartView: smartViewSchema,
      communicationThread: communicationThreadSchema,
      communicationMessage: communicationMessageSchema,
      communicationTopic: communicationTopicSchema,
      contactIdentityLink: contactIdentityLinkSchema,
    },
    generativeUi: buildGenerativeUiContract(root),
    backend: {
      actions,
    },
    speakRuntimeTools: speakFunctionTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: parseSchema(tool.parameters),
      failClosed: true,
      proofRequired:
        tool.name.includes('send') ? 'Provider proof is required before claiming success.' : undefined,
    })),
    mcpGeneration: {
      sourceEndpoint: routeUrl(root, '/api/agent/capabilities'),
      runtimeEndpoint: routeUrl(root, '/mcp'),
      localCommand: 'npm run --silent agent:contract',
      localAppCheckCommand: 'npm run qa:mcp-app',
      localVoiceConfigCheckCommand: 'npm run qa:voice-configs',
      localWidgetBridgeCheckCommand: 'npm run qa:widget-bridge',
      localUiAdapterKitCheckCommand: 'npm run qa:ui-adapter-kit',
      localUiSnapshotCheckCommand: 'npm run qa:ui-snapshot',
      validationCommands: [
        'npm run qa:mcp-app',
        'npm run qa:voice-provider-process',
        'npm run qa:voice-configs',
        'npm run qa:communication-threads',
        'npm run qa:widget-bridge',
        'npm run qa:ui-adapter-kit',
        'npm run qa:ui-snapshot',
        'npm run qa:action-invoke',
        'npm run qa:host-client',
        'npm run qa:agent-adapters',
        'npm run qa:agent-readiness',
      ],
      toolSelectionRule:
        'Generate MCP tools only from backend.actions where callableByMcp is true. Preserve risk, proof, and failure metadata without adding extra confirmation gates to proof-only profile configuration writes.',
      blockedToolRule:
        'Do not expose provider webhooks, media sockets, or Codex CLM callbacks as general MCP tools.',
      mutationRule:
        'Mutating tools must return backend response proof and should also read communication-thread, SSE, or recent-call compatibility proof when the action changes live call state.',
      widgetRule:
        'Render tools attach _meta.ui.resourceUri and _meta["openai/outputTemplate"] to the registered Speak widget resource. Data/action tools stay decoupled from widget rendering.',
      authorizationMode: authorizationModeContract,
    },
    actionInvocation: buildActionInvocationContract(
      root,
      actions,
      authorizationModeContract,
    ),
    hostClient: buildHostClientContract(root),
    agentAdapters: buildAgentAdapterEndpoints(root),
    chatgptApp: {
      name: 'Speak',
      developerModeEndpoint: routeUrl(root, '/mcp'),
      archetype: 'interactive-decoupled',
      currentMode: 'mcp-app-widget',
      widgetNative: true,
      adapterRole:
        'First-class ChatGPT/OpenAI Apps adapter over the platform-neutral generativeUi contract.',
      resources: buildChatgptAppResources(root),
      renderTools: buildChatgptRenderTools(root),
      bridge: {
        baseline:
          'MCP Apps bridge: ui/notifications/tool-result, tools/call, ui/message, and ui/update-model-context.',
        chatgptCompatibility:
          'Optional window.openai support: toolOutput, toolResponseMetadata, widgetState, setWidgetState, callTool, sendFollowUpMessage, openExternal, and requestDisplayMode.',
      },
      statePattern:
        'Render tools return compact structuredContent with surface, stateVersion, health/workspace summaries, and safe action descriptors. Larger widget-only hydration belongs in _meta.',
      cspNote:
        'The widget has no third-party frame domains. Connect domains are restricted to the configured Speak app root and local development roots.',
    },
    openApi: {
      endpoint: routeUrl(root, '/api/agent/openapi.json'),
      localCommand: 'npm run --silent agent:openapi',
      description:
        'OpenAPI 3.1 document generated from the same action table for generic REST agents and SDK generation.',
    },
    acpDiscovery: {
      endpoint: routeUrl(root, '/api/agent/acp'),
      description:
        'ACP-style discovery manifest over the same REST action surface; use it for framework-agnostic agent routing.',
    },
    skill: {
      path: 'agent/skills/speak-operator/SKILL.md',
      references: ['agent/skills/speak-operator/references/workflows.md'],
      bootstrap:
        'Read this contract first, then use the skill to choose between backend API tools, browser QA, and code edits.',
    },
    safety: {
      noSecrets:
        'Never expose provider tokens, API keys, raw credentials, private call data, or secret env values through MCP, skill docs, screenshots, or client code.',
      failClosed:
        'Never claim SMS, email, portal delivery, profile sync, call start, call end, or Speak control succeeded without backend proof.',
      liveCampaign:
        'Do not stop, restart, place, or end live calls unless the user request explicitly authorizes that live action.',
      browserTests:
        'Browser Playground tests never place phone calls and block real external delivery. Phone-quality Playground tests are explicit real outbound calls and must use live-call proof.',
    },
    qualityGates: {
      speakAgentTier: {
        localCommand: 'npm run qa:speak-agent-tier',
        scope: [
          'ChatGPT MCP app preservation',
          'platform-neutral action invocation',
          'host client adapter',
          'widget-native bridge and runtime snapshots',
          'AG-UI, A2UI, A2A, AI SDK, MCP Apps, OpenAPI, and ACP manifests',
          'contact/profile context knowledge schemas and direct binary file lifecycle',
          'proof and unsafe-route boundaries',
          'agent-facing brand boundary',
          'repo-contained skill and docs coverage',
        ],
      },
    },
    knownGaps: [],
  }
}

export function buildSpeakChatGptAppManifest(options = {}) {
  const contract = buildSpeakAgentContract(options)
  return {
    schemaVersion: 'speak.chatgpt-app.v1',
    name: contract.chatgptApp.name,
    endpoint: contract.chatgptApp.developerModeEndpoint,
    archetype: contract.chatgptApp.archetype,
    currentMode: contract.chatgptApp.currentMode,
    resources: contract.chatgptApp.resources,
    renderTools: contract.chatgptApp.renderTools,
    bridge: contract.chatgptApp.bridge,
    generativeUi: contract.generativeUi,
    mcp: {
      endpoint: contract.mcpGeneration.runtimeEndpoint,
      source: contract.mcpGeneration.sourceEndpoint,
      validation: contract.mcpGeneration.localAppCheckCommand,
    },
    safety: contract.safety,
  }
}

export function buildSpeakGenerativeUiManifest(options = {}) {
  const contract = buildSpeakAgentContract(options)
  return {
    schemaVersion: 'speak.generative-ui.manifest.v1',
    name: 'Speak',
    description:
      'Platform-neutral widget and action contract for Speak voice operations.',
    sourceOfTruth: contract.generativeUi.sourceOfTruth,
    endpoints: contract.agentAdapters,
    adapterKit: contract.agentAdapters.uiAdapterKit,
    hostClient: contract.hostClient.endpoint,
    widget: contract.generativeUi.widget,
    bridgeCapabilities: contract.generativeUi.bridgeCapabilities,
    eventModel: contract.generativeUi.eventModel,
    genericHostBridge: contract.generativeUi.genericHostBridge,
    adapters: contract.generativeUi.adapters,
    actionContract: {
      capabilities: contract.mcpGeneration.sourceEndpoint,
      openapi: contract.openApi.endpoint,
      invocation: contract.actionInvocation.endpoint,
      hostClient: contract.hostClient.endpoint,
      mcp: contract.mcpGeneration.runtimeEndpoint,
      adapterKit: contract.agentAdapters.uiAdapterKit,
      authorizationMode: contract.mcpGeneration.authorizationMode,
    },
    safety: contract.safety,
  }
}

export function buildSpeakAgUiManifest(options = {}) {
  const contract = buildSpeakAgentContract(options)
  return {
    schemaVersion: 'speak.ag-ui.manifest.v1',
    protocol: {
      name: 'AG-UI',
      role: 'agent-user interaction runtime adapter',
      status: 'adapter-kit-implemented',
      documentation: 'https://docs.ag-ui.com/introduction',
    },
    name: 'Speak',
    description:
      'AG-UI adapter manifest for projecting Speak action calls, proof, widget state, and approval interrupts into event-based agent frontends.',
    sourceContracts: {
      capabilities: contract.mcpGeneration.sourceEndpoint,
      openapi: contract.openApi.endpoint,
      mcp: contract.mcpGeneration.runtimeEndpoint,
      generativeUi: contract.agentAdapters.generativeUi,
      adapterKit: contract.agentAdapters.uiAdapterKit,
      actionInvocation: contract.actionInvocation.endpoint,
      hostClient: contract.hostClient.endpoint,
    },
    transports: [
      {
        id: 'mcp_tools',
        kind: 'mcp',
        endpoint: contract.mcpGeneration.runtimeEndpoint,
        purpose:
          'Preferred tool execution transport for AG-UI hosts that can mount MCP tools.',
      },
      {
        id: 'rest_openapi',
        kind: 'rest',
        endpoint: contract.openApi.endpoint,
        purpose:
          'REST fallback for hosts that generate tools from OpenAPI instead of MCP.',
      },
      {
        id: 'contract_action_invocation',
        kind: 'rest',
        endpoint: contract.actionInvocation.endpoint,
        purpose:
          'Portable proof-preserving action execution for hosts that want one endpoint instead of route-specific REST glue.',
      },
      {
        id: 'live_call_sse',
        kind: 'sse',
        endpointPattern: routeUrl(contract.runtime.appRoot, '/api/calls/{callControlId}/events'),
        purpose:
          'Existing Speak live-call event stream. It maps to AG-UI state/tool-result events for active calls.',
      },
    ],
    eventMapping: {
      lifecycle: [
        {
          agUiEvent: 'RunStarted',
          speakSource: 'host starts a Speak task or tool chain',
        },
        {
          agUiEvent: 'RunFinished',
          speakSource: 'backend proof received and no follow-up action remains',
        },
        {
          agUiEvent: 'RunError',
          speakSource: 'failureContract returned or backend request fails closed',
        },
      ],
      text: [
        {
          agUiEvent: 'TextMessageStart/TextMessageContent/TextMessageEnd',
          speakSource: 'assistant/operator narration around tool results',
        },
      ],
      tools: [
        {
          agUiEvent: 'ToolCallStart/ToolCallArgs/ToolCallEnd',
          speakSource: 'MCP or REST action invocation',
        },
        {
          agUiEvent: 'ToolCallResult',
          speakSource:
            'backend response proof, communication-thread proof, recent-call compatibility proof, or widget render result',
        },
      ],
      state: [
        {
          agUiEvent: 'StateSnapshot',
          speakSource:
            'read_workspace, read_runtime_health, read_communication_threads, read_contact_communication_memory, read_recent_calls',
        },
        {
          agUiEvent: 'StateDelta',
          speakSource: 'call SSE phase, transcript, takeover, and delivery proof patches',
        },
      ],
      humanInLoop: [
        {
          agUiEvent: 'ToolCallStart with confirmation UI',
          speakSource:
            'high-risk actions using authorizationMode=confirm_each or host policy equivalent',
        },
      ],
    },
    tools: buildAgentToolDescriptors(contract),
    widgetState: {
      persistedKeys: [
        'surface',
        'authorizationMode',
        'selectedLeadId',
        'selectedProfileId',
        'filters',
      ],
      modelVisibleKeys: ['surface', 'authorizationMode', 'selectedLeadId', 'selectedProfileId'],
    },
    safety: contract.safety,
  }
}

export function buildSpeakA2uiManifest(options = {}) {
  const contract = buildSpeakAgentContract(options)
  return {
    schemaVersion: 'speak.a2ui.manifest.v1',
    protocol: {
      name: 'A2UI',
      role: 'declarative generative UI adapter',
      status: 'adapter-kit-implemented',
      targetVersion: 'v0.9.1-current',
      mimeType: 'application/a2ui+json',
      documentation: 'https://a2ui.org/specification/v0.9.1-a2ui/',
    },
    name: 'Speak',
    description:
      'A2UI adapter manifest for rendering Speak operator surfaces from the same backend action and widget contract.',
    sourceContracts: {
      generativeUi: contract.agentAdapters.generativeUi,
      capabilities: contract.mcpGeneration.sourceEndpoint,
      openapi: contract.openApi.endpoint,
      mcp: contract.mcpGeneration.runtimeEndpoint,
      adapterKit: contract.agentAdapters.uiAdapterKit,
      actionInvocation: contract.actionInvocation.endpoint,
      hostClient: contract.hostClient.endpoint,
    },
    transport: {
      preferred:
        'MCP Apps render tools or HTTP widget HTML; A2UI envelopes can be carried over MCP tool outputs, SSE, WebSocket, or REST according to host support.',
      messages: ['createSurface', 'updateComponents', 'updateDataModel', 'deleteSurface'],
      returnChannel: 'A2UI action events map back to the backend action IDs below.',
    },
    catalog: {
      id: 'speak-operator',
      posture: 'app-owned constrained component catalog',
      rule:
        'Hosts should validate generated UI against Speak component intents and must not execute arbitrary model-generated code.',
      componentIntents: [
        'Surface',
        'ActionBar',
        'SearchInput',
        'BusinessList',
        'CallHistory',
        'Transcript',
        'ProfileList',
        'SettingsGroup',
        'ProofBadge',
        'AuthorizationModeSelect',
      ],
    },
    surfaces: contract.generativeUi.widget.surfaces.map((surface) => ({
      surfaceId: `speak-${surface.id}`,
      renderTool: surface.renderTool,
      canonicalUrl: surface.canonicalUrl,
      rootComponentId: 'root',
      dataModelKeys:
        surface.id === 'library'
          ? [
              'health',
              'workspace',
              'leads',
              'smartViews',
              'profiles',
              'communicationThreads',
              'recentCalls',
              'authorizationMode',
            ]
          : surface.id === 'dialer'
          ? [
              'health',
              'workspace',
              'leads',
              'communicationThreads',
              'recentCalls',
              'authorizationMode',
            ]
          : [
              'health',
              'workspace',
              'profiles',
              'communicationThreads',
              'speakOptions',
              'authorizationMode',
            ],
      actionIds: contract.frontend.uiActions
        .filter((action) => action.surface === surface.id || action.surface === 'shared')
        .map((action) => action.id),
    })),
    actions: contract.frontend.uiActions.map((action) => ({
      eventName: action.id,
      surface: action.surface,
      backendActions: action.backendActions,
      proof: action.proof || [],
      requiresHumanConfirmation: action.requiresHumanConfirmation || '',
    })),
    safety: contract.safety,
  }
}

export function buildSpeakA2aAgentCard(options = {}) {
  const contract = buildSpeakAgentContract(options)
  return {
    name: 'Speak',
    description:
      'Remote voice-operations agent for managing Speak contact queues, live call control, call review, and agent profile configuration through MCP or REST.',
    version: contract.contractVersion,
    url: contract.mcpGeneration.runtimeEndpoint,
    protocolVersion: '1.0',
    documentationUrl: contract.mcpGeneration.sourceEndpoint,
    provider: {
      organization: 'Speak',
      url: 'https://speak.example.com/speak/',
    },
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: true,
      extensions: [
        {
          uri: contract.agentAdapters.generativeUi,
          description: 'Speak generative UI adapter manifest.',
          required: false,
        },
      ],
    },
    supportedInterfaces: [
      {
        url: contract.mcpGeneration.runtimeEndpoint,
        protocolBinding: 'MCP_STREAMABLE_HTTP',
        protocolVersion: '2025-06-18',
        description: 'Primary machine tool and widget interface.',
      },
      {
        url: contract.openApi.endpoint,
        protocolBinding: 'OPENAPI_3_1',
        protocolVersion: '3.1.0',
        description: 'REST fallback for tool generation.',
      },
      {
        url: contract.actionInvocation.endpoint,
        protocolBinding: 'SPEAK_ACTION_INVOCATION',
        protocolVersion: contract.actionInvocation.schemaVersion,
        description: 'Single proof-preserving REST action invocation endpoint.',
      },
      {
        url: contract.hostClient.endpoint,
        protocolBinding: 'ESM_HOST_CLIENT',
        protocolVersion: contract.hostClient.schemaVersion,
        description:
          'Dependency-free browser/server ESM client for discovery, snapshots, widget hydration, and action invocation.',
      },
      {
        url: contract.acpDiscovery.endpoint,
        protocolBinding: 'SPEAK_ACP_DISCOVERY',
        protocolVersion: '1.0',
        description: 'Speak ACP-style discovery over the same action table.',
      },
    ],
    defaultInputModes: ['application/json', 'text/plain'],
    defaultOutputModes: [
      'application/json',
      'text/plain',
      SPEAK_WIDGET_MIME_TYPE,
      'application/a2ui+json',
    ],
    skills: buildSpeakAgentSkills(contract),
    securitySchemes: {},
    security: [],
    xSpeak: {
      complianceNote:
        'This public Agent Card makes Speak discoverable to A2A-style clients while preserving MCP and REST as the implemented execution transports. It does not expose provider webhooks, media sockets, or raw credentials.',
      capabilities: contract.mcpGeneration.sourceEndpoint,
      chatgptApp: contract.agentAdapters.chatgptApp,
      generativeUi: contract.agentAdapters.generativeUi,
      uiAdapterKit: contract.agentAdapters.uiAdapterKit,
      uiSnapshot: contract.agentAdapters.uiSnapshot,
      actionInvocation: contract.actionInvocation.endpoint,
      hostClient: contract.hostClient.endpoint,
      discoveryAliases: [
        contract.agentAdapters.a2aAgentCard,
        contract.agentAdapters.a2aAgentJson,
      ],
      authorizationMode: contract.mcpGeneration.authorizationMode,
    },
  }
}

export function buildSpeakAiSdkManifest(options = {}) {
  const contract = buildSpeakAgentContract(options)
  return {
    schemaVersion: 'speak.ai-sdk.generative-ui.v1',
    protocol: {
      name: 'AI SDK UI compatible manifest',
      role: 'tool-result to component renderer mapping',
      status: 'adapter-kit-implemented',
      documentation: 'https://ai-sdk.dev/docs/ai-sdk-ui/generative-user-interfaces',
    },
    name: 'Speak',
    description:
      'Manifest for AI SDK-style hosts that expose Speak actions as model tools and render structuredContent through app-owned components.',
    sourceContracts: {
      capabilities: contract.mcpGeneration.sourceEndpoint,
      openapi: contract.openApi.endpoint,
      mcp: contract.mcpGeneration.runtimeEndpoint,
      generativeUi: contract.agentAdapters.generativeUi,
      adapterKit: contract.agentAdapters.uiAdapterKit,
      actionInvocation: contract.actionInvocation.endpoint,
      hostClient: contract.hostClient.endpoint,
    },
    tools: buildAgentToolDescriptors(contract).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters,
      method: tool.method,
      path: tool.path,
      risk: tool.risk,
      proof: tool.proof,
      externalSideEffect: tool.externalSideEffect,
    })),
    components: contract.chatgptApp.renderTools.map((tool) => ({
      id: speakComponentId(tool.surface),
      renderTool: tool.id,
      surface: tool.surface,
      propsFrom: 'toolResult.structuredContent',
      widgetOnlyMetaFrom: 'toolResult._meta',
      canonicalUrl: tool.canonicalUrl,
    })),
    integrationRules: [
      'Expose backend actions as model tools with the exact JSON schemas from this manifest or generated OpenAPI.',
      'Hosts that cannot mount MCP can invoke the same action IDs through the actionInvocation endpoint.',
      'Render only app-owned Speak components from returned structuredContent; do not execute arbitrary model-generated UI code.',
      'Use authorizationMode only when the host or operator has explicitly granted the policy.',
      'Require backend proof before rendering live-world action success.',
    ],
    safety: contract.safety,
  }
}

export function buildSpeakMcpUiManifest(options = {}) {
  const contract = buildSpeakAgentContract(options)
  return {
    schemaVersion: 'speak.mcp-ui.manifest.v1',
    protocol: {
      name: 'MCP UI',
      role: 'MCP resource-backed interactive component adapter',
      status: 'adapter-kit-implemented',
      documentation: 'https://mcpui.dev/',
    },
    name: 'Speak',
    description:
      'MCP UI adapter manifest for mounting Speak operator widgets from MCP render tools and the shared widget resource.',
    sourceContracts: {
      mcp: contract.mcpGeneration.runtimeEndpoint,
      chatgptApp: contract.agentAdapters.chatgptApp,
      generativeUi: contract.agentAdapters.generativeUi,
      adapterKit: contract.agentAdapters.uiAdapterKit,
      widgetHtml: contract.agentAdapters.widgetHtml,
      runtimeSnapshot: contract.agentAdapters.uiSnapshot,
      actionInvocation: contract.actionInvocation.endpoint,
      hostClient: contract.hostClient.endpoint,
    },
    resources: contract.chatgptApp.resources.map((resource) => ({
      uri: resource.uri,
      mimeType: resource.mimeType,
      httpUrl: contract.agentAdapters.widgetHtml,
      csp: resource._meta?.ui?.csp || {},
    })),
    surfaces: contract.chatgptApp.renderTools.map((tool) => ({
      surface: tool.surface,
      renderTool: tool.id,
      resourceUri: tool.resourceUri,
      outputTemplate: tool._meta?.['openai/outputTemplate'] || tool.resourceUri,
      runtimeSnapshot: `${contract.agentAdapters.uiSnapshot}?surface=${encodeURIComponent(tool.surface)}`,
      componentId: speakComponentId(tool.surface),
      canonicalUrl: tool.canonicalUrl,
    })),
    bridge: contract.generativeUi.genericHostBridge,
    safety: contract.safety,
  }
}

export function buildSpeakJsonRenderManifest(options = {}) {
  const contract = buildSpeakAgentContract(options)
  const componentCatalog = [
    'SpeakSurface',
    'SpeakRouteTabs',
    'SpeakContextStrip',
    'SpeakRecordList',
    'SpeakTranscriptWindow',
    'SpeakSettingsDrawer',
    'SpeakActionButton',
    'SpeakProofList',
  ]
  return {
    schemaVersion: 'speak.vercel-json-render.manifest.v1',
    protocol: {
      name: 'Vercel JSON Render',
      role: 'declarative JSON component tree adapter',
      status: 'adapter-kit-implemented',
      documentation: 'https://json-render.dev/',
    },
    name: 'Speak',
    description:
      'JSON Render adapter manifest for rendering Speak widget surfaces through a constrained component catalog without model-generated code execution.',
    sourceContracts: {
      generativeUi: contract.agentAdapters.generativeUi,
      adapterKit: contract.agentAdapters.uiAdapterKit,
      runtimeSnapshot: contract.agentAdapters.uiSnapshot,
      actionInvocation: contract.actionInvocation.endpoint,
      hostClient: contract.hostClient.endpoint,
    },
    catalog: {
      id: 'speak-json-render',
      components: componentCatalog,
      rule:
        'Render only catalog components backed by Speak structuredContent and adapter-kit action metadata; arbitrary generated HTML, script, and CSS are not allowed.',
    },
    surfaces: contract.chatgptApp.renderTools.map((tool) => ({
      surface: tool.surface,
      renderTool: tool.id,
      component: 'SpeakSurface',
      componentId: speakComponentId(tool.surface),
      propsFrom: 'runtimeSnapshot.structuredContent',
      metaFrom: 'runtimeSnapshot._meta',
      runtimeSnapshot: `${contract.agentAdapters.uiSnapshot}?surface=${encodeURIComponent(tool.surface)}`,
      treeTemplate: {
        type: 'SpeakSurface',
        props: {
          surface: tool.surface,
          routeTabs: ['library', 'dialer', 'configs'],
          contextSource: 'structuredContent',
          bodyComponent:
            tool.surface === 'library'
              ? 'SpeakRecordList'
              : tool.surface === 'configs'
                ? 'SpeakTranscriptWindow'
                : 'SpeakTranscriptWindow',
          actionPolicy: 'highRiskActionsUseFollowUp',
        },
      },
    })),
    safety: contract.safety,
  }
}

export function buildSpeakCopilotKitManifest(options = {}) {
  const contract = buildSpeakAgentContract(options)
  return {
    schemaVersion: 'speak.copilotkit.manifest.v1',
    protocol: {
      name: 'CopilotKit',
      role: 'React action/render adapter',
      status: 'adapter-kit-implemented',
      documentation: 'https://docs.copilotkit.ai/',
    },
    name: 'Speak',
    description:
      'CopilotKit adapter manifest for exposing Speak backend actions as Copilot actions and rendering tool results through predefined Speak components.',
    sourceContracts: {
      capabilities: contract.mcpGeneration.sourceEndpoint,
      openapi: contract.openApi.endpoint,
      mcp: contract.mcpGeneration.runtimeEndpoint,
      generativeUi: contract.agentAdapters.generativeUi,
      adapterKit: contract.agentAdapters.uiAdapterKit,
      runtimeSnapshot: contract.agentAdapters.uiSnapshot,
      actionInvocation: contract.actionInvocation.endpoint,
      hostClient: contract.hostClient.endpoint,
    },
    actions: buildAgentToolDescriptors(contract).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      invokeVia: contract.actionInvocation.endpoint,
      risk: tool.risk,
      externalSideEffect: tool.externalSideEffect,
      proof: tool.proof,
      authorizationMode:
        tool.risk === 'high' || tool.externalSideEffect
          ? contract.mcpGeneration.authorizationMode
          : undefined,
    })),
    renderComponents: contract.chatgptApp.renderTools.map((tool) => ({
      name: speakComponentId(tool.surface),
      surface: tool.surface,
      renderTool: tool.id,
      propsFrom: 'toolResult.structuredContent',
      metaFrom: 'toolResult._meta',
      runtimeSnapshot: `${contract.agentAdapters.uiSnapshot}?surface=${encodeURIComponent(tool.surface)}`,
      canonicalUrl: tool.canonicalUrl,
    })),
    integrationRules: [
      'Register only the Speak renderComponents listed here; do not render arbitrary model-supplied component names.',
      'Use actionInvocation or MCP for actions so proof, authorizationMode, risk, and failure contracts remain backend-owned.',
      'Render high-risk live-call, delete, delivery, and phone-test actions as approval-gated Copilot actions.',
    ],
    safety: contract.safety,
  }
}

export function buildSpeakUiAdapterKit(options = {}) {
  const contract = buildSpeakAgentContract(options)
  return {
    schemaVersion: 'speak.ui-adapter-kit.v1',
    name: 'Speak',
    contractVersion: contract.contractVersion,
    generatedAt: new Date().toISOString(),
    purpose:
      'Concrete event, message, and component envelopes for mounting Speak in non-ChatGPT generative UI hosts without forking the backend action model.',
    sourceContracts: {
      capabilities: contract.mcpGeneration.sourceEndpoint,
      generativeUi: contract.agentAdapters.generativeUi,
      chatgptApp: contract.agentAdapters.chatgptApp,
      openapi: contract.openApi.endpoint,
      mcp: contract.mcpGeneration.runtimeEndpoint,
      widgetHtml: contract.agentAdapters.widgetHtml,
      uiSnapshot: contract.agentAdapters.uiSnapshot,
      mcpUi: contract.agentAdapters.mcpUi,
      agUi: contract.agentAdapters.agUi,
      a2ui: contract.agentAdapters.a2ui,
      aiSdk: contract.agentAdapters.aiSdk,
      jsonRender: contract.agentAdapters.jsonRender,
      copilotKit: contract.agentAdapters.copilotKit,
      actionInvocation: contract.actionInvocation.endpoint,
      hostClient: contract.hostClient.endpoint,
    },
    invariants: [
      'ChatGPT and MCP Apps remain first-class through /mcp, registered widget resources, render tools, and _meta["openai/outputTemplate"].',
      'Generic hosts hydrate the same widget through speak.widget-postmessage.v1 instead of impersonating window.openai.',
      'MCP UI, AG-UI, A2UI, AI SDK, Vercel JSON Render, and CopilotKit hosts map from returned structuredContent and _meta; they do not invent new backend action names.',
      'Hosts without MCP can call the actionInvocation endpoint while preserving the same risk, authorization, proof, and failure metadata.',
      'Hosts can import the dependency-free hostClient ESM adapter instead of hand-rolling fetch and postMessage glue.',
      'High-risk live-world actions preserve authorizationMode, proof requirements, and failure contracts.',
    ],
    bridge: contract.generativeUi.genericHostBridge,
    widget: {
      resourceUri: contract.chatgptApp.resources[0]?.uri || '',
      mimeType: contract.chatgptApp.resources[0]?.mimeType || SPEAK_WIDGET_MIME_TYPE,
      htmlEndpoint: contract.agentAdapters.widgetHtml,
      csp: contract.chatgptApp.resources[0]?._meta?.ui?.csp || {},
    },
    adapters: {
      mcpApps: {
        endpoint: contract.mcpGeneration.runtimeEndpoint,
        renderTools: contract.chatgptApp.renderTools.map((tool) => tool.id),
        hydration: 'Use render tool structuredContent plus _meta.ui.resourceUri.',
      },
      mcpUi: {
        manifest: contract.agentAdapters.mcpUi,
        runtimeSnapshot: contract.agentAdapters.uiSnapshot,
        widgetHtml: contract.agentAdapters.widgetHtml,
        bridgeSchema: contract.generativeUi.genericHostBridge.schemaVersion,
      },
      genericHost: {
        endpoint: contract.agentAdapters.widgetHtml,
        runtimeSnapshot: contract.agentAdapters.uiSnapshot,
        actionInvocation: contract.actionInvocation.endpoint,
        hostClient: contract.hostClient.endpoint,
        bridgeSchema: contract.generativeUi.genericHostBridge.schemaVersion,
        inboundMessages: contract.generativeUi.genericHostBridge.inboundMessages,
        outboundMessages: contract.generativeUi.genericHostBridge.outboundMessages,
      },
      agUi: {
        manifest: contract.agentAdapters.agUi,
        runtimeSnapshot: contract.agentAdapters.uiSnapshot,
        eventTypes: [
          'RunStarted',
          'StateSnapshot',
          'ToolCallStart',
          'ToolCallArgs',
          'ToolCallEnd',
          'ToolCallResult',
          'StateDelta',
          'RunFinished',
          'RunError',
        ],
      },
      a2ui: {
        manifest: contract.agentAdapters.a2ui,
        runtimeSnapshot: contract.agentAdapters.uiSnapshot,
        messageTypes: ['createSurface', 'updateComponents', 'updateDataModel', 'deleteSurface'],
      },
      aiSdk: {
        manifest: contract.agentAdapters.aiSdk,
        runtimeSnapshot: contract.agentAdapters.uiSnapshot,
        componentIds: contract.chatgptApp.renderTools.map((tool) =>
          speakComponentId(tool.surface),
        ),
      },
      jsonRender: {
        manifest: contract.agentAdapters.jsonRender,
        runtimeSnapshot: contract.agentAdapters.uiSnapshot,
        componentCatalog: 'speak-json-render',
      },
      copilotKit: {
        manifest: contract.agentAdapters.copilotKit,
        runtimeSnapshot: contract.agentAdapters.uiSnapshot,
        actionInvocation: contract.actionInvocation.endpoint,
      },
    },
    surfaces: contract.chatgptApp.renderTools.map((tool) =>
      buildSurfaceAdapterKit(contract, tool),
    ),
    runtimeSnapshot: {
      endpoint: contract.agentAdapters.uiSnapshot,
      schemaVersion: 'speak.ui-runtime-snapshot.v1',
      query: {
        surface: ['library', 'dialer', 'configs'],
        limit: 'integer 1..50',
        authorizationMode: contract.mcpGeneration.authorizationMode.modes.map((mode) => mode.id),
      },
      returns:
        'Current structuredContent plus genericHost.hydrateMessage, agUi.events, a2ui.messages, aiSdk props, and manifest-compatible data for the requested surface.',
    },
    validation: {
      localCommands: [
        'npm run qa:mcp-app',
        'npm run qa:voice-provider-process',
        'npm run qa:voice-configs',
        'npm run qa:communication-threads',
        'npm run qa:widget-bridge',
        'npm run qa:ui-adapter-kit',
        'npm run qa:ui-snapshot',
        'npm run qa:action-invoke',
        'npm run qa:host-client',
        'npm run qa:agent-adapters',
        'npm run qa:agent-readiness',
      ],
    },
  }
}

export function buildSpeakAgentReadinessReport(options = {}) {
  const contract = buildSpeakAgentContract(options)
  const chatgptApp = buildSpeakChatGptAppManifest(options)
  const generativeUi = buildSpeakGenerativeUiManifest(options)
  const mcpUi = buildSpeakMcpUiManifest(options)
  const agUi = buildSpeakAgUiManifest(options)
  const a2ui = buildSpeakA2uiManifest(options)
  const a2a = buildSpeakA2aAgentCard(options)
  const aiSdk = buildSpeakAiSdkManifest(options)
  const jsonRender = buildSpeakJsonRenderManifest(options)
  const copilotKit = buildSpeakCopilotKitManifest(options)
  const uiAdapterKit = buildSpeakUiAdapterKit(options)
  const openapi = buildSpeakOpenApiDocument(options)
  const actionIds = new Set(contract.backend.actions.map((action) => action.id))
  const checks = []
  const pushCheck = (id, passed, evidence, details = {}) => {
    checks.push({
      id,
      status: passed ? 'pass' : 'fail',
      evidence,
      details,
    })
  }

  const renderTools = chatgptApp.renderTools || []
  const resource = chatgptApp.resources?.[0]
  pushCheck(
    'chatgpt_mcp_app_preserved',
    chatgptApp.endpoint === contract.mcpGeneration.runtimeEndpoint &&
      resource?.mimeType === SPEAK_WIDGET_MIME_TYPE &&
      renderTools.length >= 3 &&
      renderTools.every(
        (tool) =>
          tool._meta?.ui?.resourceUri === resource.uri &&
          tool._meta?.['openai/outputTemplate'] === resource.uri,
      ),
    'ChatGPT endpoint, MCP Apps widget resource, and render-tool metadata remain first-class.',
    {
      endpoint: chatgptApp.endpoint,
      resourceUri: resource?.uri || null,
      renderTools: renderTools.map((tool) => tool.id),
    },
  )

  const expectedAdapters = new Map([
    ['mcp_apps', 'implemented'],
    ['openai_chatgpt_apps', 'implemented'],
    ['generic_iframe_or_web_component', 'implemented'],
    ['mcp_ui', 'implemented-adapter-kit'],
    ['ag_ui', 'implemented-adapter-kit'],
    ['a2ui', 'implemented-adapter-kit'],
    ['a2a', 'implemented-discovery'],
    ['ai_sdk_generui', 'implemented-adapter-kit'],
    ['vercel_json_render', 'implemented-adapter-kit'],
    ['copilotkit', 'implemented-adapter-kit'],
  ])
  const adapterStatuses = new Map(
    contract.generativeUi.adapters.map((adapter) => [adapter.id, adapter.status]),
  )
  pushCheck(
    'platform_adapter_manifests',
    [...expectedAdapters].every(([id, status]) => adapterStatuses.get(id) === status) &&
      Boolean(contract.agentAdapters.a2aAgentCard) &&
      Boolean(contract.agentAdapters.a2aAgentJson),
    'All supported adapter families expose concrete discovery endpoints, including both common A2A Agent Card paths.',
    {
      adapters: Object.fromEntries(adapterStatuses),
      endpoints: contract.agentAdapters,
    },
  )

  pushCheck(
    'ui_adapter_kit',
    uiAdapterKit.surfaces?.length === contract.chatgptApp.renderTools.length &&
      uiAdapterKit.surfaces.every(
        (surface) =>
          surface.genericHost?.hydrateMessage?.type === 'speak:hydrate' &&
          surface.agUi?.eventSequence?.some((event) => event.type === 'StateSnapshot') &&
          surface.a2ui?.messages?.some((message) => message.type === 'updateDataModel') &&
          surface.aiSdk?.propsFrom === 'toolResult.structuredContent',
      ),
    'MCP UI, AG-UI, A2UI, AI SDK, Vercel JSON Render, CopilotKit, and generic iframe hosts have concrete adapter envelopes, not only prose manifests.',
    {
      endpoint: contract.agentAdapters.uiAdapterKit,
      surfaces: uiAdapterKit.surfaces?.map((surface) => surface.surface) || [],
    },
  )

  pushCheck(
    'ui_runtime_snapshot_contract',
    Boolean(contract.agentAdapters.uiSnapshot) &&
      uiAdapterKit.runtimeSnapshot?.schemaVersion === 'speak.ui-runtime-snapshot.v1' &&
      uiAdapterKit.runtimeSnapshot?.endpoint === contract.agentAdapters.uiSnapshot &&
      uiAdapterKit.validation?.localCommands?.includes('npm run qa:ui-snapshot'),
    'Non-ChatGPT hosts have a discoverable runtime snapshot endpoint that returns live adapter payloads.',
    {
      endpoint: contract.agentAdapters.uiSnapshot,
      schemaVersion: uiAdapterKit.runtimeSnapshot?.schemaVersion || '',
    },
  )

  const callableRestActionIds = callableRestAgentActions(contract).map((action) => action.id)
  pushCheck(
    'generic_action_invocation_contract',
    Boolean(contract.agentAdapters.actionInvocation) &&
      contract.actionInvocation?.schemaVersion === 'speak.action-invocation.v1' &&
      contract.actionInvocation?.endpoint === contract.agentAdapters.actionInvocation &&
      contract.actionInvocation?.callableActionIds?.length === callableRestActionIds.length &&
      callableRestActionIds.every((id) =>
        contract.actionInvocation.callableActionIds.includes(id),
      ) &&
      uiAdapterKit.validation?.localCommands?.includes('npm run qa:action-invoke'),
    'Non-MCP hosts have a single proof-preserving action invocation endpoint generated from the same callable REST actions.',
    {
      endpoint: contract.agentAdapters.actionInvocation,
      callableActionCount: callableRestActionIds.length,
    },
  )

  pushCheck(
    'host_client_adapter_contract',
    Boolean(contract.agentAdapters.hostClient) &&
      contract.hostClient?.schemaVersion === 'speak.host-client.v1' &&
      contract.hostClient?.endpoint === contract.agentAdapters.hostClient &&
      contract.hostClient?.exports?.includes('createSpeakAgentClient') &&
      uiAdapterKit.sourceContracts?.hostClient === contract.agentAdapters.hostClient &&
      uiAdapterKit.validation?.localCommands?.includes('npm run qa:host-client'),
    'Generic hosts have a dependency-free ESM client for discovery, runtime snapshots, widget hydration, and proof-preserving action invocation.',
    {
      endpoint: contract.agentAdapters.hostClient,
      exports: contract.hostClient?.exports || [],
    },
  )

  const voiceRuntime = contract.runtime.voiceRuntime
  const providerOnboarding = voiceRuntime?.providerOnboarding
  pushCheck(
    'voice_runtime_model_catalog_contract',
    voiceRuntime?.providers?.includes('hume') &&
      voiceRuntime?.providers?.includes('inworld') &&
      voiceRuntime?.providers?.includes('xai') &&
      voiceRuntime?.modelDropdownGroups?.includes('provider-native') &&
      voiceRuntime?.modelDropdownGroups?.includes('codex-auth') &&
      /live intersection/i.test(voiceRuntime?.modelSelectionInvariant || '') &&
      /reasoning is fixed to NONE while shared function tools are active/i.test(
        voiceRuntime?.modelSelectionInvariant || '',
      ) &&
      providerOnboarding?.playbook === 'docs/voice-provider-integration.md' &&
      providerOnboarding?.requiredCoreFeatures?.length >= 20 &&
      providerOnboarding?.optimizationAudit?.length >= 8 &&
      providerOnboarding?.mcpDiscoveryRule?.includes('official') &&
      contract.mcpGeneration?.validationCommands?.includes('npm run qa:voice-provider-process') &&
      uiAdapterKit.validation?.localCommands?.includes('npm run qa:voice-provider-process') &&
      contract.mcpGeneration?.validationCommands?.includes('npm run qa:voice-configs') &&
      uiAdapterKit.validation?.localCommands?.includes('npm run qa:voice-configs'),
    'Hume, Inworld, and xAI preserve runtime-scoped model choices, and future providers must follow the SDK/docs/MCP/optimization intake process.',
    {
      providers: voiceRuntime?.providers || [],
      modelDropdownGroups: voiceRuntime?.modelDropdownGroups || [],
      validationCommands: contract.mcpGeneration?.validationCommands || [],
      providerOnboarding: providerOnboarding?.playbook || '',
    },
  )

  const missingUiBackendActions = []
  const uncoveredUiActions = []
  contract.frontend.uiActions.forEach((uiAction) => {
    ;(uiAction.backendActions || []).forEach((backendAction) => {
      if (!actionIds.has(backendAction)) {
        missingUiBackendActions.push({ uiAction: uiAction.id, backendAction })
      }
    })
    if (
      !(uiAction.backendActions || []).length &&
      !uiAction.headlessEquivalent &&
      uiAction.frequency !== 'secondary'
    ) {
      uncoveredUiActions.push(uiAction.id)
    }
  })
  pushCheck(
    'ui_action_to_backend_parity',
    missingUiBackendActions.length === 0 && uncoveredUiActions.length === 0,
    'Every visible UI action maps to existing backend actions or has an explicit browser/headless explanation.',
    {
      missingUiBackendActions,
      uncoveredUiActions,
      uiActionCount: contract.frontend.uiActions.length,
    },
  )

  const mutatingWithoutProof = contract.backend.actions.filter(
    (action) =>
      action.callableByMcp &&
      action.method !== 'GET' &&
      !(action.proof || []).length,
  )
  const unsafeCallable = contract.backend.actions.filter(
    (action) =>
      action.callableByMcp &&
      ['internal', 'provider-webhook', 'provider-websocket', 'websocket'].includes(
        action.kind,
      ),
  )
  pushCheck(
    'proof_and_unsafe_boundary',
    mutatingWithoutProof.length === 0 && unsafeCallable.length === 0,
    'Callable mutations carry proof fields and unsafe provider/internal routes are not MCP-callable.',
    {
      mutatingWithoutProof: mutatingWithoutProof.map((action) => action.id),
      unsafeCallable: unsafeCallable.map((action) => action.id),
    },
  )

  const requiredWorkspaceActions = [
    'read_workspace',
    'upload_context_file',
    'download_context_file',
    'delete_context_file',
    'list_leads',
    'create_lead',
    'import_leads',
    'list_smart_views',
    'upsert_smart_view',
    'import_smart_view_leads',
    'update_lead',
    'bulk_update_lead_status',
    'bulk_delete_leads',
    'list_profiles',
    'upsert_profile',
    'set_active_profile',
    'delete_profile',
  ]
  pushCheck(
    'headless_workspace_coverage',
    requiredWorkspaceActions.every((id) => actionIds.has(id)),
    'Contact-record, Smart View, profile, and context-file workflows have backend-owned actions for headless agents.',
    { requiredWorkspaceActions },
  )

  const contextActions = ['upload_context_file', 'download_context_file', 'delete_context_file']
  const leadContextSchema = contract.dataSchemas?.lead?.properties?.context
  const profileContextSchema = contract.dataSchemas?.profile?.properties?.context
  const contextFields = contract.dataSchemas?.contextFields
  pushCheck(
    'context_knowledge_contract',
    Boolean(leadContextSchema) &&
      Boolean(profileContextSchema) &&
      contextFields?.properties?.files?.items?.properties?.extractionStatus?.enum?.includes('ready') &&
      contextActions.every((id) => actionIds.has(id)) &&
      contextActions.every((id) => {
        const action = contract.backend.actions.find((candidate) => candidate.id === id)
        return Boolean(action && openapi.paths?.[action.path]?.[action.method.toLowerCase()])
      }),
    'Contact-record and profile context knowledge, extracted file metadata, and binary file lifecycle routes are discoverable for headless agents.',
    {
      contextActions,
      leadContextSchema: Boolean(leadContextSchema),
      profileContextSchema: Boolean(profileContextSchema),
      fileStatusEnum: contextFields?.properties?.files?.items?.properties?.extractionStatus?.enum || [],
    },
  )

  const communicationThreads = contract.runtime?.communicationThreads || {}
  const threadSchema = contract.dataSchemas?.communicationThread
  const messageSchema = contract.dataSchemas?.communicationMessage
  const topicSchema = contract.dataSchemas?.communicationTopic
  const identitySchema = contract.dataSchemas?.contactIdentityLink
  pushCheck(
    'communication_thread_contract',
    communicationThreads.playbook === 'docs/communication-thread-model.md' &&
      communicationThreads.channels?.includes('call') &&
      communicationThreads.channels?.includes('sms') &&
      communicationThreads.channels?.includes('email') &&
      /contact-scoped communication threads\/messages/i.test(communicationThreads.invariant || '') &&
      /signature verification before source persistence/i.test(communicationThreads.sourceIngressRule || '') &&
      communicationThreads.productionValidationCommands?.includes('npm run qa:telnyx-source-routing') &&
      threadSchema?.properties?.channels?.items?.enum?.includes('sms') &&
      threadSchema?.properties?.channels?.items?.enum?.includes('email') &&
      messageSchema?.properties?.channel?.enum?.includes('call') &&
      messageSchema?.properties?.channel?.enum?.includes('sms') &&
      messageSchema?.properties?.channel?.enum?.includes('email') &&
      topicSchema?.properties?.sourceMessageIds &&
      identitySchema?.properties?.kind?.enum?.includes('phone') &&
      identitySchema?.properties?.kind?.enum?.includes('email') &&
      contract.mcpGeneration?.validationCommands?.includes('npm run qa:communication-threads') &&
      uiAdapterKit.validation?.localCommands?.includes('npm run qa:communication-threads'),
    'Communication history has a provider-neutral thread/message/topic/identity-link contract for calls, SMS, email, widgets, agents, and Contact Memory.',
    {
      playbook: communicationThreads.playbook || '',
      channels: communicationThreads.channels || [],
      validationCommands: contract.mcpGeneration?.validationCommands || [],
    },
  )

  const renderSurfaces = new Set(renderTools.map((tool) => tool.surface))
  const routeIds = new Set(contract.frontend.routes.map((route) => route.id))
  pushCheck(
    'widget_surface_route_coverage',
    [...routeIds].every((routeId) => renderSurfaces.has(routeId)),
    'Widget render tools cover every primary frontend route.',
    {
      routes: [...routeIds],
      renderSurfaces: [...renderSurfaces],
    },
  )

  pushCheck(
    'adapter_manifest_shape',
    generativeUi.adapters?.length === expectedAdapters.size &&
      mcpUi.surfaces?.length >= 3 &&
      agUi.tools?.length > 0 &&
      a2ui.surfaces?.length >= 3 &&
      a2a.skills?.length >= 5 &&
      aiSdk.components?.length >= 3 &&
      jsonRender.surfaces?.length >= 3 &&
      copilotKit.renderComponents?.length >= 3,
    'Generated adapter manifests expose tools, surfaces, skills, and components from the same contract.',
    {
      generativeUiAdapters: generativeUi.adapters?.length || 0,
      mcpUiSurfaces: mcpUi.surfaces?.map((surface) => surface.surface) || [],
      agUiTools: agUi.tools?.length || 0,
      a2uiSurfaces: a2ui.surfaces?.map((surface) => surface.surfaceId) || [],
      a2aSkills: a2a.skills?.map((skill) => skill.id) || [],
      aiSdkComponents: aiSdk.components?.map((component) => component.id) || [],
      jsonRenderSurfaces: jsonRender.surfaces?.map((surface) => surface.surface) || [],
      copilotKitComponents:
        copilotKit.renderComponents?.map((component) => component.name) || [],
    },
  )

  const genericHostBridge = contract.generativeUi.genericHostBridge
  pushCheck(
    'generic_widget_host_bridge',
    genericHostBridge?.schemaVersion === 'speak.widget-postmessage.v1' &&
      genericHostBridge.inboundMessages?.includes('speak:hydrate') &&
      genericHostBridge.inboundMessages?.includes('speak:request-state') &&
      genericHostBridge.outboundMessages?.includes('speak:tool-call') &&
      genericHostBridge.outboundMessages?.includes('speak:ready') &&
      genericHostBridge.securityRule?.includes('parent frame'),
    'Generic iframe/custom-element hosts have an explicit postMessage bridge instead of needing ChatGPT-only APIs.',
    {
      schemaVersion: genericHostBridge?.schemaVersion || '',
      inboundMessages: genericHostBridge?.inboundMessages || [],
      outboundMessages: genericHostBridge?.outboundMessages || [],
    },
  )

  const generatedPayload = JSON.stringify({
    contract,
    chatgptApp,
    generativeUi,
    agUi,
    a2ui,
    a2a,
    aiSdk,
    mcpUi,
    jsonRender,
    copilotKit,
  })
  pushCheck(
    'agent_facing_brand_boundary',
    !/HUME_API_KEY|INWORLD_API_KEY|\/evi\/(?:configs|chat|tools|language_models)|hume-session/.test(
      generatedPayload,
    ),
    'Agent-facing generated manifests may name supported runtimes but do not expose raw provider secrets, webhooks, private session modules, or deployment-specific internals.',
  )

  const failed = checks.filter((check) => check.status !== 'pass')
  return {
    schemaVersion: 'speak.agent-readiness.v1',
    name: 'Speak',
    contractVersion: contract.contractVersion,
    generatedAt: new Date().toISOString(),
    readinessLevel: failed.length === 0 ? 's-class-candidate' : 'needs-work',
    overallStatus: failed.length === 0 ? 'pass' : 'fail',
    summary: {
      passed: checks.length - failed.length,
      failed: failed.length,
      checks: checks.length,
    },
    checks,
    evidenceCommands: [
      'npm run qa:mcp-app',
      'npm run qa:voice-provider-process',
      'npm run qa:voice-configs',
      'npm run qa:communication-threads',
      'npm run qa:widget-bridge',
      'npm run qa:ui-adapter-kit',
      'npm run qa:ui-snapshot',
      'npm run qa:action-invoke',
      'npm run qa:host-client',
      'npm run qa:agent-adapters',
      'npm run qa:agent-readiness',
      'npm run qa:speak-agent-tier',
      'npm run lint',
      'npm run build:speak',
    ],
    sourceContracts: {
      capabilities: contract.agentAdapters.capabilities,
      chatgptApp: contract.agentAdapters.chatgptApp,
      readiness: contract.agentAdapters.readiness,
      actionInvocation: contract.agentAdapters.actionInvocation,
      hostClient: contract.agentAdapters.hostClient,
      generativeUi: contract.agentAdapters.generativeUi,
      mcpUi: contract.agentAdapters.mcpUi,
      agUi: contract.agentAdapters.agUi,
      a2ui: contract.agentAdapters.a2ui,
      a2aAgentCard: contract.agentAdapters.a2aAgentCard,
      a2aAgentJson: contract.agentAdapters.a2aAgentJson,
      aiSdk: contract.agentAdapters.aiSdk,
      jsonRender: contract.agentAdapters.jsonRender,
      copilotKit: contract.agentAdapters.copilotKit,
    },
  }
}

export function buildSpeakOpenApiDocument(options = {}) {
  const contract = buildSpeakAgentContract(options)
  const paths = {}
  const restMethods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

  contract.backend.actions
    .filter(
      (action) =>
        (action.callableByMcp || action.documentedInOpenApi) &&
        restMethods.has(action.method),
    )
    .forEach((action) => {
      paths[action.path] ||= {}
      paths[action.path][action.method.toLowerCase()] = {
        operationId: action.id,
        summary: action.title,
        description: [
          action.useFor?.length ? `Use for: ${action.useFor.join(', ')}.` : '',
          action.risk ? `Risk: ${action.risk}.` : '',
          action.callableByMcp === false
            ? `Not callable through MCP/actionInvocation: ${action.reasonNotCallable || 'Use the documented route directly.'}`
            : '',
          action.requiresHumanConfirmation
            ? `Confirmation: ${action.requiresHumanConfirmation}`
            : '',
          action.failureContract ? `Failure contract: ${action.failureContract}` : '',
        ]
          .filter(Boolean)
          .join(' '),
        tags: [action.kind],
        parameters: [
          ...schemaParameters(action.pathSchema, 'path'),
          ...schemaParameters(action.querySchema, 'query'),
          ...headerParameters(action.requestHeaders),
        ],
        requestBody: buildOpenApiRequestBody(action),
        responses: {
          200: {
            description: `Success proof: ${(action.proof || ['ok']).join(', ')}`,
          },
          400: { description: 'Bad request' },
          500: { description: 'Server error' },
        },
      }
    })

  paths['/api/agent/actions/{actionId}/invoke'] = {
    post: {
      operationId: 'invoke_speak_agent_action',
      summary: 'Invoke one contract-callable Speak action',
      description:
        'Platform-neutral action executor for hosts that cannot mount MCP and prefer one proof-preserving invocation endpoint over route-specific REST glue.',
      tags: ['agent-adapter'],
      parameters: [
        {
          name: 'actionId',
          in: 'path',
          required: true,
          schema: {
            type: 'string',
            enum: contract.actionInvocation.callableActionIds,
          },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                path: {
                  type: 'object',
                  additionalProperties: true,
                },
                query: {
                  type: 'object',
                  additionalProperties: true,
                },
                body: {
                  type: 'object',
                  additionalProperties: true,
                },
                authorizationMode: authorizationModeSchema,
              },
            },
          },
        },
      },
      responses: {
        200: {
          description:
            'Action invocation envelope with backend result and proof metadata.',
        },
        400: { description: 'Bad request or invalid authorization mode' },
        403: { description: 'Action is not callable through this endpoint' },
        404: { description: 'Unknown action ID or backend route not found' },
        500: { description: 'Server error' },
      },
    },
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Speak Headless Agent API',
      version: contract.contractVersion,
      description:
        'REST API for headless Speak agents, MCP adapters, ACP routing, A2A Agent Card discovery, and platform-neutral skill execution.',
    },
    servers: [{ url: contract.runtime.appRoot }],
    paths,
  }
}

function buildOpenApiRequestBody(action) {
  if (action.requestSchema) {
    return {
      required: true,
      content: {
        'application/json': {
          schema: action.requestSchema,
        },
      },
    }
  }
  if (!action.requestContentTypes) return undefined
  return {
    required: true,
    content: action.requestContentTypes,
  }
}

function headerParameters(headers = {}) {
  return Object.entries(headers).map(([name, definition]) => ({
    name,
    in: 'header',
    required: Boolean(definition.required),
    schema: {
      type: definition.type || 'string',
    },
    description: definition.description || '',
  }))
}

export function buildSpeakAcpManifest(options = {}) {
  const contract = buildSpeakAgentContract(options)
  return {
    schemaVersion: 'speak.acp.discovery.v1',
    name: 'Speak',
    description: contract.product.purpose,
    protocols: {
      rest: {
        openapi: contract.openApi.endpoint,
        capabilities: contract.mcpGeneration.sourceEndpoint,
        actionInvocation: contract.actionInvocation.endpoint,
      },
      mcp: {
        source: contract.mcpGeneration.sourceEndpoint,
        guidance: contract.mcpGeneration.toolSelectionRule,
      },
      acp: {
        style: 'RESTful JSON discovery with streaming call-event resources',
        endpoint: contract.acpDiscovery.endpoint,
      },
      generativeUi: contract.agentAdapters,
    },
    ui: {
      actions: contract.frontend.uiActions,
      automation: contract.frontend.automation,
      designSystem: contract.frontend.designSystem,
      widgets: contract.chatgptApp.resources,
      renderTools: contract.chatgptApp.renderTools,
    },
    capabilities: contract.backend.actions
      .filter((action) => action.callableByMcp)
      .map((action) => ({
        id: action.id,
        title: action.title,
        method: action.method,
        path: action.path,
        risk: action.risk,
        proof: action.proof || [],
        requiresHumanConfirmation: action.requiresHumanConfirmation || '',
      })),
  }
}

function buildChatgptAppResources(root) {
  const appOrigin = originForRoot(root) || 'https://speak.example.com'
  return [
    {
      id: 'speak_operator_widget',
      title: 'Speak operator widget',
      uri: SPEAK_WIDGET_RESOURCE_URI,
      mimeType: SPEAK_WIDGET_MIME_TYPE,
      version: SPEAK_WIDGET_VERSION,
      description:
        'Native MCP Apps widget for reviewing Speak queue, calls, and agent profiles inside an agent host.',
      _meta: {
        'openai/widgetDescription':
          'A compact Speak control surface for reviewing the outbound queue, unified communication history, and agent profiles. High-risk live actions require explicit user authorization and backend proof.',
        'openai/widgetPrefersBorder': true,
        ui: {
          prefersBorder: true,
          domain: appOrigin,
          csp: {
            connectDomains: [
              appOrigin,
              'http://127.0.0.1:8787',
              'http://127.0.0.1:5173',
            ],
            resourceDomains: [appOrigin],
          },
        },
      },
    },
  ]
}

function buildGenerativeUiContract(root) {
  const resource = buildChatgptAppResources(root)[0]
  const renderTools = buildChatgptRenderTools(root)
  const endpoints = buildAgentAdapterEndpoints(root)
  return {
    schemaVersion: 'speak.generative-ui.v1',
    posture: 'platform-agnostic-first',
    sourceOfTruth:
      'Backend action contract plus neutral widget descriptor. ChatGPT/OpenAI Apps metadata is one adapter, not the canonical product model.',
    widget: {
      id: resource.id,
      title: resource.title,
      resourceUri: resource.uri,
      mimeType: resource.mimeType,
      httpUrl: routeUrl(root, '/api/agent/widgets/speak-operator.html'),
      version: resource.version,
      surfaces: renderTools.map((tool) => ({
        id: tool.surface,
        renderTool: tool.id,
        canonicalUrl: tool.canonicalUrl,
      })),
    },
    manifests: endpoints,
    bridgeCapabilities: [
      'receive_tool_result',
      'component_initiated_tool_call',
      'invoke_contract_action',
      'send_follow_up_intent',
      'update_model_visible_context',
      'persist_widget_state',
      'request_display_mode',
      'open_external_url',
    ],
    eventModel: {
      toolResult: 'structuredContent plus widget-only _meta hydration',
      toolCall:
        'named tool or actionInvocation request plus JSON arguments including optional authorizationMode',
      followUpIntent:
        'text intent for high-risk live-world actions when the host should mediate approval or planning',
      widgetState:
        'small persisted state such as authorizationMode, selected surface, selected contact/profile, and filters',
    },
    genericHostBridge: {
      schemaVersion: 'speak.widget-postmessage.v1',
      purpose:
        'Portable iframe/custom-element bridge for hosts that do not implement ChatGPT window.openai or the MCP Apps JSON-RPC bridge.',
      inboundMessages: [
        'speak:hydrate',
        'speak:tool-result',
        'speak:set-authorization-mode',
        'speak:request-state',
      ],
      outboundMessages: [
        'speak:ready',
        'speak:state',
        'speak:tool-call',
        'speak:follow-up',
        'speak:open-external',
        'speak:display-mode-request',
      ],
      payloadRule:
        'Hydration accepts structuredContent/toolOutput plus optional _meta/toolResponseMetadata. Outbound tool-call payloads use { name, arguments } with authorizationMode filled when absent.',
      securityRule:
        'The widget accepts generic bridge messages only from its parent frame. Hosts should verify source, source="speak-widget", and schemaVersion before acting on outbound messages.',
    },
    adapters: [
      {
        id: 'mcp_apps',
        label: 'MCP Apps compatible hosts',
        status: 'implemented',
        value:
          'Registered MCP resource with text/html;profile=mcp-app plus render tools using _meta.ui.resourceUri.',
        endpoints: [routeUrl(root, '/mcp')],
      },
      {
        id: 'openai_chatgpt_apps',
        label: 'ChatGPT Apps SDK',
        status: 'implemented',
        value:
          'Uses MCP Apps metadata and OpenAI compatibility alias _meta["openai/outputTemplate"]; widget can use optional window.openai APIs.',
        endpoints: [routeUrl(root, '/mcp'), routeUrl(root, '/api/agent/chatgpt-app.json')],
      },
      {
        id: 'generic_iframe_or_web_component',
        label: 'Generic iframe/custom-element hosts',
        status: 'implemented',
        value:
          'Same widget is available as HTML over HTTP and can hydrate from host-provided structuredContent or direct tool calls.',
        endpoints: [routeUrl(root, '/api/agent/widgets/speak-operator.html')],
      },
      {
        id: 'mcp_ui',
        label: 'MCP UI hosts',
        status: 'implemented-adapter-kit',
        value:
          'Concrete manifest maps Speak MCP render tools and widget resource HTML to MCP UI-style remote DOM/iframe hosts while preserving the same postMessage bridge.',
        endpoints: [endpoints.mcpUi, routeUrl(root, '/mcp'), endpoints.uiAdapterKit],
      },
      {
        id: 'ag_ui',
        label: 'AG-UI style agent-user event streams',
        status: 'implemented-adapter-kit',
        value:
          'Concrete manifest and adapter kit map Speak tool results, follow-up intents, widget state, interrupts, and approvals to AG-UI event envelopes.',
        endpoints: [endpoints.agUi, endpoints.uiAdapterKit],
      },
      {
        id: 'a2ui',
        label: 'A2UI-style declarative generative UI',
        status: 'implemented-adapter-kit',
        value:
          'Concrete manifest and adapter kit map widget.surfaces and uiActions to A2UI-style component intents while keeping Speak backend actions authoritative.',
        endpoints: [endpoints.a2ui, endpoints.uiAdapterKit],
      },
      {
        id: 'a2a',
        label: 'A2A agent discovery/delegation',
        status: 'implemented-discovery',
        value:
          'A2A-style Agent Card discovery maps Speak skills to MCP, REST, and ACP endpoints without exposing unsafe provider internals.',
        endpoints: [
          endpoints.a2aAgentCard,
          endpoints.a2aAgentJson,
          routeUrl(root, '/api/agent/acp'),
          routeUrl(root, '/api/agent/openapi.json'),
        ],
      },
      {
        id: 'ai_sdk_generui',
        label: 'Vercel AI SDK / React generative UI hosts',
        status: 'implemented-adapter-kit',
        value:
          'Concrete manifest and adapter kit map OpenAPI/MCP tools to model tools and structuredContent to app-owned React-style components.',
        endpoints: [endpoints.aiSdk, endpoints.uiAdapterKit],
      },
      {
        id: 'vercel_json_render',
        label: 'Vercel JSON Render declarative hosts',
        status: 'implemented-adapter-kit',
        value:
          'Concrete manifest maps Speak structuredContent to a constrained JSON component tree using Speak-owned route, context, list, transcript, and action primitives.',
        endpoints: [endpoints.jsonRender, endpoints.uiAdapterKit],
      },
      {
        id: 'copilotkit',
        label: 'CopilotKit generative UI hosts',
        status: 'implemented-adapter-kit',
        value:
          'Concrete manifest maps Speak render tools to predefined CopilotKit render components and backend actions to proof-preserving Copilot actions.',
        endpoints: [endpoints.copilotKit, endpoints.uiAdapterKit],
      },
    ],
  }
}

function buildChatgptRenderTools(root) {
  const resourceUri = SPEAK_WIDGET_RESOURCE_URI
  return [
    {
      id: 'render_speak_library',
      title: 'Render Speak library widget',
      surface: 'library',
      resourceUri,
      description:
        'Use this when the user needs an interactive widget for Speak contact library records, Smart Views, agent reconciliation, and transcript-history review.',
      dataTools: [
        'read_runtime_health',
        'read_workspace',
        'read_communication_threads',
        'read_communication_thread_messages',
        'read_recent_calls',
      ],
      componentActions: [
        'read_workspace',
        'list_leads',
        'list_smart_views',
        'list_profiles',
        'read_communication_threads',
        'read_communication_thread_messages',
        'read_recent_calls',
        'fetch',
      ],
      highRiskActionsUseFollowUp: [
        'bulk_delete_leads',
        'delete_profile',
        'import_leads',
        'import_smart_view_leads',
        'sync_personal_phone_contacts',
        'sync_calltools_campaign_contacts',
      ],
      _meta: {
        ui: { resourceUri },
        'openai/outputTemplate': resourceUri,
      },
      canonicalUrl: routeUrl(root, '/library'),
    },
    {
      id: 'render_speak_dialer',
      title: 'Render Speak dialer widget',
      surface: 'dialer',
      resourceUri,
      description:
        'Use this when the user needs an interactive widget for the Speak contact queue, unified communication history, and live-call proof review.',
      dataTools: [
        'read_runtime_health',
        'read_workspace',
        'read_communication_threads',
        'read_communication_thread_messages',
        'read_recent_calls',
      ],
      componentActions: [
        'read_workspace',
        'read_communication_threads',
        'read_communication_thread_messages',
        'read_recent_calls',
        'fetch',
      ],
      highRiskActionsUseFollowUp: ['start_live_call', 'end_live_call', 'pause_agent_for_takeover'],
      _meta: {
        ui: { resourceUri },
        'openai/outputTemplate': resourceUri,
      },
      canonicalUrl: routeUrl(root, '/dialer'),
    },
    {
      id: 'render_speak_configs',
      title: 'Render Speak Playground widget',
      surface: 'configs',
      resourceUri,
      description:
        'Use this when the user needs an interactive Playground widget for Speak agent profiles, Smart View assignment, current profile selection, browser tests, phone-quality tests, and owner Smart Config.',
      dataTools: ['read_runtime_health', 'read_workspace', 'read_speak_options'],
      componentActions: [
        'read_workspace',
        'list_profiles',
        'list_smart_views',
        'read_speak_options',
        'fetch',
      ],
      highRiskActionsUseFollowUp: ['delete_profile', 'start_phone_config_test'],
      _meta: {
        ui: { resourceUri },
        'openai/outputTemplate': resourceUri,
      },
      canonicalUrl: routeUrl(root, '/configs'),
    },
  ]
}

function buildSurfaceAdapterKit(contract, tool) {
  const surfaceId = `speak-${tool.surface}`
  const componentId = speakComponentId(tool.surface)
  const dataModelKeysBySurface = {
    library: [
      'surface',
      'stateVersion',
      'generatedAt',
      'authorizationMode',
      'health',
      'library',
      'queue',
      'profiles',
      'communicationThreads',
      'recentCalls',
    ],
    dialer: [
      'surface',
      'stateVersion',
      'generatedAt',
      'authorizationMode',
      'health',
      'queue',
      'profiles',
      'communicationThreads',
      'recentCalls',
    ],
    configs: [
      'surface',
      'stateVersion',
      'generatedAt',
      'authorizationMode',
      'health',
      'profiles',
      'queue',
      'communicationThreads',
      'recentCalls',
    ],
  }
  const dataModelKeys = dataModelKeysBySurface[tool.surface] || [
    'surface',
    'stateVersion',
    'generatedAt',
    'authorizationMode',
  ]
  const actionIds = contract.frontend.uiActions
    .filter((action) => action.surface === tool.surface || action.surface === 'shared')
    .map((action) => action.id)
  const toolCallId = `${tool.id}-call`

  return {
    surface: tool.surface,
    surfaceId,
    title: tool.title,
    canonicalUrl: tool.canonicalUrl,
    renderTool: tool.id,
    resourceUri: tool.resourceUri,
    dataTools: tool.dataTools,
    componentActions: tool.componentActions,
    highRiskActionsUseFollowUp: tool.highRiskActionsUseFollowUp,
    actionIds,
    structuredContent: {
      source: `${tool.id}.structuredContent`,
      requiredFields: dataModelKeys,
      widgetOnlyMetaSource: `${tool.id}._meta`,
    },
    runtimeSnapshotUrl: `${contract.agentAdapters.uiSnapshot}?surface=${encodeURIComponent(tool.surface)}`,
    mcpApps: {
      renderTool: tool.id,
      outputTemplate: tool._meta?.['openai/outputTemplate'] || tool.resourceUri,
      resourceUri: tool._meta?.ui?.resourceUri || tool.resourceUri,
    },
    genericHost: {
      hydrateMessage: {
        type: 'speak:hydrate',
        source: 'host',
        schemaVersion: contract.generativeUi.genericHostBridge.schemaVersion,
        detail: {
          structuredContentRef: `${tool.id}.structuredContent`,
          metaRef: `${tool.id}._meta`,
          authorizationMode: contract.mcpGeneration.authorizationMode.default,
        },
      },
      requestStateMessage: {
        type: 'speak:request-state',
        source: 'host',
        schemaVersion: contract.generativeUi.genericHostBridge.schemaVersion,
      },
      expectedOutbound: ['speak:ready', 'speak:state', 'speak:tool-call', 'speak:follow-up'],
    },
    agUi: {
      eventSequence: [
        {
          type: 'RunStarted',
          threadId: surfaceId,
          runId: `${tool.id}-{stateVersion}`,
          input: { renderTool: tool.id },
        },
        {
          type: 'ToolCallStart',
          toolCallId,
          toolCallName: tool.id,
        },
        {
          type: 'ToolCallArgs',
          toolCallId,
          delta: JSON.stringify({
            limit: 12,
            authorizationMode: contract.mcpGeneration.authorizationMode.default,
          }),
        },
        {
          type: 'ToolCallEnd',
          toolCallId,
        },
        {
          type: 'ToolCallResult',
          messageId: `${tool.id}-message`,
          toolCallId,
          role: 'tool',
          contentRef: `${tool.id}.structuredContent`,
        },
        {
          type: 'StateSnapshot',
          snapshotRef: `${tool.id}.structuredContent`,
        },
        {
          type: 'RunFinished',
          outcome: { type: 'success' },
          resultRef: `${tool.id}.structuredContent`,
        },
      ],
      liveUpdateRule:
        'Map /api/calls/{callControlId}/events patches to StateDelta events and backend proof payloads to ToolCallResult events.',
    },
    a2ui: {
      messages: [
        {
          type: 'createSurface',
          surfaceId,
          title: tool.title,
          metadata: { renderTool: tool.id, canonicalUrl: tool.canonicalUrl },
        },
        {
          type: 'updateComponents',
          surfaceId,
          components: [
            {
              id: 'root',
              component: 'Surface',
              props: {
                surface: tool.surface,
                componentId,
                actionIds,
              },
            },
          ],
        },
        {
          type: 'updateDataModel',
          surfaceId,
          path: '/',
          valueRef: `${tool.id}.structuredContent`,
        },
      ],
      actionReturnChannel:
        'Client action events map back to frontend.uiActions[].backendActions or follow-up intent when high-risk confirmation is required.',
    },
    aiSdk: {
      componentId,
      renderTool: tool.id,
      propsFrom: 'toolResult.structuredContent',
      metaFrom: 'toolResult._meta',
      toolResultPart: {
        type: `tool-${tool.id}`,
        state: 'output-available',
        outputRef: `${tool.id}.structuredContent`,
      },
    },
  }
}

function speakComponentId(surface) {
  const componentIdBySurface = {
    library: 'SpeakLibraryWidget',
    dialer: 'SpeakDialerWidget',
    configs: 'SpeakPlaygroundWidget',
  }
  return componentIdBySurface[surface] || 'SpeakOperatorWidget'
}

function buildAgentAdapterEndpoints(root) {
  return {
    capabilities: routeUrl(root, '/api/agent/capabilities'),
    wellKnownSpeakAgent: routeUrl(root, '/.well-known/speak-agent.json'),
    openapi: routeUrl(root, '/api/agent/openapi.json'),
    acp: routeUrl(root, '/api/agent/acp'),
    actionInvocation: routeUrl(root, '/api/agent/actions/{actionId}/invoke'),
    mcp: routeUrl(root, '/mcp'),
    chatgptApp: routeUrl(root, '/api/agent/chatgpt-app.json'),
    readiness: routeUrl(root, '/api/agent/readiness.json'),
    widgetHtml: routeUrl(root, '/api/agent/widgets/speak-operator.html'),
    hostClient: routeUrl(root, '/api/agent/host-client.mjs'),
    generativeUi: routeUrl(root, '/api/agent/generative-ui.json'),
    uiAdapterKit: routeUrl(root, '/api/agent/ui-adapter-kit.json'),
    uiSnapshot: routeUrl(root, '/api/agent/ui-snapshot.json'),
    mcpUi: routeUrl(root, '/api/agent/mcp-ui.json'),
    agUi: routeUrl(root, '/api/agent/ag-ui.json'),
    a2ui: routeUrl(root, '/api/agent/a2ui.json'),
    a2aAgentCard: routeUrl(root, '/.well-known/agent-card.json'),
    a2aAgentJson: routeUrl(root, '/.well-known/agent.json'),
    aiSdk: routeUrl(root, '/api/agent/ai-sdk.json'),
    jsonRender: routeUrl(root, '/api/agent/json-render.json'),
    copilotKit: routeUrl(root, '/api/agent/copilotkit.json'),
  }
}

function buildHostClientContract(root) {
  return {
    schemaVersion: 'speak.host-client.v1',
    endpoint: routeUrl(root, '/api/agent/host-client.mjs'),
    moduleFormat: 'ESM',
    dependencyPolicy: 'no runtime dependencies',
    purpose:
      'Drop-in host adapter for browsers, web components, iframes, server-side JavaScript agents, and framework-specific wrappers.',
    exports: [
      'speakHostClientSchemaVersion',
      'createSpeakAgentClient',
      'hydrateSpeakWidget',
      'connectSpeakWidget',
      'default',
    ],
    covers: [
      'capabilities discovery',
      'readiness discovery',
      'ChatGPT app manifest readback',
      'OpenAPI/ACP/A2A/AI SDK/generative UI discovery',
      'runtime UI snapshots',
      'proof-preserving action invocation',
      'generic widget iframe creation and hydration',
      'generic speak.widget-postmessage.v1 event handling',
    ],
    hostRule:
      'Use the host client when a platform cannot mount MCP directly but still needs native Speak widgets, structured runtime state, and action execution without platform-specific glue.',
    securityRule:
      'The host client does not broaden backend authorization or CORS. Hosts must run it same-origin, through an approved proxy, or from a trusted environment and must preserve action proof/failure contracts.',
    validationCommand: 'npm run qa:host-client',
  }
}

function buildActionInvocationContract(root, actions, authorizationMode) {
  const callableActions = callableRestAgentActions({ backend: { actions } })
  return {
    schemaVersion: 'speak.action-invocation.v1',
    endpoint: routeUrl(root, '/api/agent/actions/{actionId}/invoke'),
    method: 'POST',
    purpose:
      'Platform-neutral execution endpoint for hosts that do not mount MCP but still need proof-preserving Speak action calls.',
    allowedActionRule:
      'Only backend.actions with callableByMcp=true, a REST method, and a non-provider/non-internal kind can be invoked.',
    callableActionCount: callableActions.length,
    callableActionIds: callableActions.map((action) => action.id),
    blockedKinds: ['internal', 'provider-webhook', 'provider-websocket', 'sse', 'websocket'],
    request: {
      contentType: 'application/json',
      body: {
        path: 'Object of path parameters for templates such as {leadId}.',
        query: 'Object of query parameters.',
        body: 'JSON request body for POST/PUT/PATCH actions.',
        authorizationMode:
          'Optional host/operator approval policy. Aliases are normalized before forwarding.',
      },
    },
    response: {
      envelope:
        'Always returns schemaVersion, actionId, method, path, risk, externalSideEffect, requiresHumanConfirmation, authorizationMode, proofExpected, proofReturned, failureContract, transport, and result or error.',
      proofRule:
        'The endpoint preserves expected proof metadata and shallow proof presence checks; callers must still honor failureContract and read follow-up state for live-call mutations.',
    },
    authorizationMode,
  }
}

function buildAgentToolDescriptors(contract) {
  return contract.backend.actions
    .filter((action) => action.callableByMcp)
    .map((action) => ({
      name: action.id,
      title: action.title,
      description: [
        action.title,
        action.useFor?.length ? `Use for: ${action.useFor.join(', ')}.` : '',
        action.risk ? `Risk: ${action.risk}.` : '',
        action.externalSideEffect ? 'External side effect: yes.' : '',
        action.requiresHumanConfirmation
          ? `Confirmation: ${action.requiresHumanConfirmation}`
          : '',
        action.failureContract ? `Failure contract: ${action.failureContract}` : '',
      ]
        .filter(Boolean)
        .join(' '),
      method: action.method,
      path: action.path,
      kind: action.kind,
      risk: action.risk,
      externalSideEffect: Boolean(action.externalSideEffect),
      requiresHumanConfirmation: action.requiresHumanConfirmation || '',
      proof: action.proof || [],
      parameters: buildActionToolInputSchema(action),
      annotations: {
        readOnlyHint: action.method === 'GET',
        destructiveHint: action.risk === 'high' || action.method === 'DELETE',
        openWorldHint: Boolean(action.externalSideEffect),
      },
    }))
}

function buildActionToolInputSchema(action) {
  const properties = {}
  const required = []

  if (action.pathSchema) {
    properties.path = action.pathSchema
    required.push('path')
  }
  if (action.querySchema) {
    properties.query = action.querySchema
  }
  if (action.requestSchema) {
    properties.body = action.requestSchema
    if (action.method !== 'GET') required.push('body')
  }
  if (action.risk === 'high' || action.externalSideEffect) {
    properties.authorizationMode = authorizationModeSchema
  }

  return {
    type: 'object',
    additionalProperties: false,
    properties,
    required,
  }
}

function buildSpeakAgentSkills(contract) {
  const skill = ({
    id,
    name,
    description,
    tags,
    examples,
    actionIds,
    outputModes = ['application/json', 'text/plain'],
  }) => ({
    id,
    name,
    description,
    tags,
    examples,
    inputModes: ['application/json', 'text/plain'],
    outputModes,
    xSpeakActionIds: actionIds,
  })

  return [
    skill({
      id: 'runtime-preflight',
      name: 'Runtime Preflight',
      description:
        'Check Speak runtime health, provider readiness, delivery configuration, and expected call-path settings before live actions.',
      tags: ['health', 'runtime', 'preflight'],
      examples: ['Check whether Speak is configured for live calls.'],
      actionIds: ['read_runtime_health'],
    }),
    skill({
      id: 'workspace-management',
      name: 'Workspace Management',
      description:
        'List, create, import, update, bulk edit, and delete Speak contact records, Smart Views, saved profiles, and contact/profile context knowledge through backend-owned state.',
      tags: ['contacts', 'smart-views', 'profiles', 'workspace', 'context'],
      examples: ['Import these contacts, attach context files, and mark the selected contacts ready.'],
      actionIds: [
        'read_workspace',
        'upload_context_file',
        'download_context_file',
        'delete_context_file',
        'list_leads',
        'replace_leads',
        'create_lead',
        'import_leads',
        'list_smart_views',
        'upsert_smart_view',
        'import_smart_view_leads',
        'delete_smart_view',
        'update_lead',
        'bulk_update_lead_status',
        'bulk_delete_leads',
        'list_profiles',
        'upsert_profile',
        'set_active_profile',
        'delete_profile',
      ],
    }),
    skill({
      id: 'live-call-control',
      name: 'Live Call Control',
      description:
        'Start, instruct, pause, resume, and end authorized calls while preserving backend proof requirements. Speak/Telnyx uses direct call start; CallTools uses one-click native campaign/session establishment and campaign invite following.',
      tags: ['calls', 'operator', 'live'],
      examples: ['Start a call to this authorized contact and verify communication-thread proof.'],
      actionIds: [
        'start_live_call',
        'send_live_instruction',
        'send_operator_chat_message',
        'pause_agent_for_takeover',
        'resume_agent_after_takeover',
        'end_live_call',
      ],
    }),
    skill({
      id: 'call-review',
      name: 'Call Review',
      description:
        'Review Speak communication threads, call transcripts, SMS/email/tool proof, outcomes, playback metadata, and live state events.',
      tags: ['calls', 'transcripts', 'history', 'communication-threads'],
      examples: ['Review the latest communication thread for this business.'],
      actionIds: [
        'read_communication_threads',
        'read_communication_thread',
        'read_communication_thread_messages',
        'read_contact_communication_memory',
        'read_recent_calls',
        'read_call_audio_link',
        'stream_call_events',
      ],
    }),
    skill({
      id: 'profile-configuration',
      name: 'Profile Configuration',
      description:
        'Read Speak options, edit agent profiles, assign Smart Views, sync Speak configs, select current profiles, and run browser or real-phone Playground tests.',
      tags: ['configs', 'profiles', 'testing'],
      examples: ['Create a new agent profile and run a browser or phone Playground test.'],
      actionIds: [
        'read_speak_options',
        'read_speak_config',
        'list_smart_views',
        'sync_speak_config',
        'send_operator_chat_message',
        'start_browser_config_test',
        'start_phone_config_test',
        'end_browser_config_test',
      ],
    }),
    skill({
      id: 'generative-ui-rendering',
      name: 'Generative UI Rendering',
      description:
        'Render the Speak dialer or Playground widget in ChatGPT, MCP Apps, iframe/custom-element, AG-UI, A2UI, A2A, or AI SDK-style hosts.',
      tags: ['widget', 'generative-ui', 'mcp-apps'],
      examples: ['Render the Speak dialer widget for reviewing the current queue.'],
      actionIds: [
        'render_speak_dialer',
        'render_speak_configs',
        'send_operator_chat_message',
      ],
      outputModes: [
        'application/json',
        'text/html',
        SPEAK_WIDGET_MIME_TYPE,
        'application/a2ui+json',
      ],
    }),
  ]
}

function buildUiActionContract() {
  return [
    {
      id: uiActionIds.configureDialer,
      surface: 'dialer',
      testId: uiTestIds.dialerRunControls,
      backendActions: ['read_dialer_state', 'update_dialer_state', 'list_profiles', 'list_smart_views'],
      headlessEquivalent:
        'Read profiles, Smart Views, and dialerState, then update_dialer_state with selected source, agent/list, filters, and queue continuity fields.',
      proof: ['dialerState.sourceId', 'dialerState.selectedLeadIds', 'dialerState.updatedAt'],
      frequency: 'primary',
    },
    {
      id: uiActionIds.scheduleQueue,
      surface: 'dialer',
      testId: uiTestIds.dialerRunControls,
      backendActions: ['read_dialer_state', 'update_dialer_state'],
      headlessEquivalent:
        'Persist scheduledStartAt and scheduledQueueActive through update_dialer_state; a browser controller or trusted host owns the actual timer/runner.',
      proof: ['dialerState.scheduledStartAt', 'dialerState.scheduledQueueActive', 'dialerState.updatedAt'],
      frequency: 'secondary',
    },
    {
      id: uiActionIds.startQueue,
      surface: 'dialer',
      testId: uiTestIds.dialerRunControls,
      backendActions: ['read_runtime_health', 'read_workspace', 'read_dialer_state', 'update_dialer_state', 'start_live_call', 'establish_calltools_agent_session'],
      headlessEquivalent:
        'For Speak-owned sources, filter ready contacts through read_workspace/list_leads, then call start_live_call for each authorized contact through Speak/Telnyx. For CallTools campaign sources, sync/select the source and invoke establish_calltools_agent_session with ready=true and explicit confirmation; it activates/originates the native campaign and establishes the selected agent without browser login. Never call start_live_call for a CallTools profile; follow native campaign invites after readiness is proved.',
      proof: ['dialerState.campaignQueueIds', 'callControlId when Speak/Telnyx starts a direct call', 'establish_calltools_agent_session.campaignStart.ok and proof.loggedIn', 'read_calltools_readiness.campaignReady and liveCallAttached for CallTools follow mode', 'communication thread/message proof'],
      frequency: 'primary',
    },
    {
      id: uiActionIds.stopQueue,
      surface: 'dialer',
      testId: uiTestIds.dialerRunControls,
      backendActions: [
        'update_dialer_state',
        'end_live_call',
        'read_communication_threads',
        'read_communication_thread_messages',
        'read_recent_calls',
      ],
      headlessEquivalent:
        'Stop queue progression client-side; if a live call exists, call end_live_call and verify communication-thread or recent-call proof.',
      proof: ['dialerState.campaignRunning=false', 'event.patch.phase=ended', 'communication thread outcome'],
      frequency: 'primary',
    },
    {
      id: uiActionIds.addLead,
      surface: 'dialer',
      testId: uiTestIds.addLeadButton,
      backendActions: ['create_lead'],
      proof: ['lead.id'],
      frequency: 'primary',
    },
    {
      id: uiActionIds.importSmartViewCsv,
      surface: 'library',
      backendActions: ['import_smart_view_leads'],
      headlessEquivalent:
        'Parse CSV outside the browser, normalize rows, then call import_smart_view_leads to create a saved Smart View and import its leads.',
      proof: ['smartView.id', 'imported[]', 'leads[]'],
      frequency: 'secondary',
    },
    {
      id: uiActionIds.syncPersonalPhoneSource,
      surface: 'library',
      backendActions: ['sync_personal_phone_contacts'],
      headlessEquivalent:
        'Call sync_personal_phone_contacts to pull BlueBubbles personal-phone contacts into the personal-phone contact source, then filter list_leads by lead.source/sourceId for queue planning.',
      proof: ['contactSource.id', 'personalPhone.sourceId', 'leads[]'],
      frequency: 'secondary',
    },
    {
      id: uiActionIds.syncCallToolsSource,
      surface: 'library',
      backendActions: ['sync_calltools_campaign_contacts'],
      headlessEquivalent:
        'Call sync_calltools_campaign_contacts to pull the selected CallTools campaign source contacts into the CallTools contact source, then filter list_leads by lead.source/sourceId for queue planning.',
      proof: ['contactSource.id', 'calltools.campaignId', 'calltools.sourceKind', 'calltools.liveFilterId', 'calltools.bucketId', 'leads[]'],
      frequency: 'secondary',
    },
    {
      id: uiActionIds.selectContactSource,
      surface: 'library',
      backendActions: ['read_workspace', 'list_leads', 'read_dialer_state', 'update_dialer_state'],
      headlessEquivalent:
        'Read available contact sources and contacts, filter by lead.source/sourceId, then persist only the selected source/list context in dialerState. This must not mutate provider campaigns or start dialers.',
      proof: ['contactSource.id', 'lead.source/sourceId', 'dialerState.sourceId', 'filtered contact count'],
      frequency: 'primary',
    },
    {
      id: uiActionIds.createSmartView,
      surface: 'dialer',
      backendActions: ['upsert_smart_view'],
      headlessEquivalent:
        'Compute filtered contact IDs from list_leads/read_communication_threads/read_recent_calls output, then call upsert_smart_view with the filter snapshot and legacy leadIds field.',
      proof: ['smartView.id', 'smartViews[]'],
      frequency: 'secondary',
    },
    {
      id: uiActionIds.selectSmartView,
      surface: 'dialer',
      backendActions: ['list_smart_views', 'list_leads'],
      headlessEquivalent:
        'Read list_smart_views, choose the Smart View ID, then filter list_leads to the Smart View leadIds.',
      proof: ['smartView.id', 'filtered contact IDs in agent client'],
      frequency: 'primary',
    },
    {
      id: uiActionIds.filterLeads,
      surface: 'dialer',
      testId: uiTestIds.leadFilterButton,
      backendActions: [
        'list_leads',
        'list_smart_views',
        'read_communication_threads',
        'read_recent_calls',
      ],
      headlessEquivalent:
        'Apply equivalent filters or Smart View leadIds in the agent client over list_leads/read_communication_threads/read_recent_calls output.',
      proof: ['filtered contact IDs in agent client', 'smartView.id when selected'],
      frequency: 'primary',
    },
    {
      id: uiActionIds.sortAndViewLeads,
      surface: 'dialer',
      testId: uiTestIds.leadSortViewButton,
      backendActions: ['list_leads', 'bulk_update_lead_status', 'bulk_delete_leads'],
      proof: ['leads[]', 'patched[]', 'deleted[]'],
      frequency: 'primary',
    },
    {
      id: uiActionIds.callLead,
      surface: 'shared',
      testId: uiTestIds.transcriptPanel,
      backendActions: [],
      headlessEquivalent:
        'Use the selected contact phone number to open a tel: URL on the user device. This does not mutate Speak backend state or start an agent-backed call.',
      proof: ['selected contact phone', 'href starts with tel:'],
      frequency: 'primary',
      requiresHumanConfirmation:
        'The current browser/device owns the final phone-call confirmation; Speak does not place this call through the backend.',
    },
    {
      id: uiActionIds.callLeadFromDevice,
      surface: 'shared',
      testId: uiTestIds.transcriptPanel,
      backendActions: [],
      headlessEquivalent:
        'Use the selected contact phone number to open a tel: URL on the user device. This does not mutate Speak backend state or start an agent-backed call.',
      proof: ['selected contact phone', 'href starts with tel:'],
      frequency: 'primary',
      requiresHumanConfirmation:
        'The current browser/device owns the final phone-call confirmation; Speak does not place this call through the backend.',
    },
    {
      id: uiActionIds.editLead,
      surface: 'dialer',
      testId: uiTestIds.leadRow,
      backendActions: ['update_lead'],
      proof: ['lead.id'],
      frequency: 'primary',
    },
    {
      id: uiActionIds.openTranscript,
      surface: 'dialer',
      testId: uiTestIds.transcriptPanel,
      backendActions: [
        'read_communication_threads',
        'read_communication_thread_messages',
        'read_recent_calls',
        'read_call_audio_link',
      ],
      proof: ['messages[].body', 'messages[].proof', 'calls[].transcript', 'status/url/source'],
      frequency: 'primary',
    },
    {
      id: uiActionIds.sendLiveInstruction,
      surface: 'dialer',
      testId: uiTestIds.transcriptPanel,
      backendActions: ['send_live_instruction'],
      proof: ['ok', 'event.notice=Live instruction delivered to agent'],
      frequency: 'secondary',
    },
    {
      id: uiActionIds.sendOperatorChatMessage,
      surface: 'shared',
      backendActions: ['send_operator_chat_message'],
      headlessEquivalent:
        'Call send_operator_chat_message with the active surface and context from an agent host; apply returned proof, patches, or commands exactly.',
      proof: ['turnId', 'intent', 'assistantMessage', 'actions[]', 'patches'],
      frequency: 'primary',
    },
    {
      id: uiActionIds.openGlobalSearch,
      surface: 'shared',
      testId: uiTestIds.globalSearchTrigger,
      backendActions: ['search_workspace', 'read_recent_calls'],
      headlessEquivalent:
        'Call search_workspace with a bounded limit for contacts, profiles, Smart Views, and communication threads; call read_recent_calls only when transcript history is needed.',
      proof: ['search dialog open in browser or search_workspace.results[] ranked IDs'],
      frequency: 'primary',
    },
    {
      id: uiActionIds.toggleTakeover,
      surface: 'dialer',
      testId: uiTestIds.transcriptPanel,
      backendActions: ['pause_agent_for_takeover', 'resume_agent_after_takeover'],
      proof: ['event.patch.takeover'],
      frequency: 'secondary',
      requiresHumanConfirmation:
        'Required before pausing the assistant or bridging a human into a live call.',
    },
    {
      id: uiActionIds.startConfigTest,
      surface: 'configs',
      testId: uiTestIds.configTestToggle,
      backendActions: ['start_browser_config_test'],
      headlessEquivalent:
        'Choose a saved contact from list_leads or provide an ad hoc contact payload, then call start_browser_config_test with the selected profile config and productionContext=true unless the task explicitly requests a sandboxed browser test.',
      proof: ['testId', 'callControlId'],
      frequency: 'primary',
    },
    {
      id: uiActionIds.startConfigPhoneTest,
      surface: 'configs',
      testId: uiTestIds.configTestPanel,
      backendActions: ['start_phone_config_test'],
      headlessEquivalent:
        'Choose a saved contact from list_leads or provide an ad hoc contact payload, then call start_phone_config_test with the selected profile voice/model config plus dialerProvider=speak and the selected Speak/Telnyx caller ID and workspace Call Control connection. Do not use or mutate the profile CallTools campaign transport for a Playground Phone test.',
      proof: ['callControlId', 'communication thread/message proof'],
      frequency: 'secondary',
      requiresHumanConfirmation:
        'Required unless the current task explicitly authorizes placing a real phone test call.',
    },
    {
      id: uiActionIds.stopConfigPhoneTest,
      surface: 'configs',
      testId: uiTestIds.configTestPanel,
      backendActions: [
        'end_live_call',
        'read_communication_threads',
        'read_communication_thread_messages',
        'read_recent_calls',
      ],
      proof: ['event.patch.phase=ended', 'communication thread outcome'],
      frequency: 'secondary',
    },
    {
      id: uiActionIds.stopConfigTest,
      surface: 'configs',
      testId: uiTestIds.configTestToggle,
      backendActions: ['end_browser_config_test'],
      proof: ['ok', 'event.patch.phase=ended'],
      frequency: 'primary',
    },
    {
      id: uiActionIds.sendPlaygroundMessage,
      surface: 'configs',
      testId: uiTestIds.configTestPanel,
      backendActions: ['send_browser_config_message', 'send_live_instruction'],
      headlessEquivalent:
        'For Browser, call send_browser_config_message with the running test ID and exact contact/user message. For an active Playground Phone call, call send_live_instruction with the exact private coaching text; it steers the agent and is never spoken to the contact.',
      proof: [
        'Browser: event.patch.transcript and assistant transcript event',
        'Phone: event.notice=Live instruction delivered to agent',
      ],
      frequency: 'primary',
    },
    {
      id: uiActionIds.togglePlaygroundSpy,
      surface: 'configs',
      testId: uiTestIds.playgroundPhoneSupervision,
      backendActions: [],
      headlessEquivalent:
        'Browser-only live media monitoring for an active Playground Phone call. It cannot attach to Browser, Device, Personal Phone, or CallTools sessions.',
      proof: ['supervision monitor.updated enabled=true', 'caller and agent PCM received'],
      frequency: 'secondary',
      publicMcpCallable: false,
      requiresHumanConfirmation:
        'Required before playing a live caller and agent conversation through the operator browser.',
    },
    {
      id: uiActionIds.togglePlaygroundBarge,
      surface: 'configs',
      testId: uiTestIds.playgroundPhoneSupervision,
      backendActions: ['pause_agent_for_takeover', 'resume_agent_after_takeover'],
      proof: ['event.patch.takeover', 'human microphone socket attached'],
      frequency: 'secondary',
      requiresHumanConfirmation:
        'Required before pausing the agent and bridging the operator microphone into a live Playground Phone call.',
    },
    {
      id: uiActionIds.togglePlaygroundAudioWhisper,
      surface: 'configs',
      testId: uiTestIds.playgroundPhoneSupervision,
      backendActions: ['send_live_instruction'],
      headlessEquivalent:
        'Use send_live_instruction for text-equivalent private coaching. Browser microphone capture and transcription remain an explicit operator action.',
      proof: [
        'whisper.delivered transcript',
        'event.notice=Voice whisper delivered to agent',
      ],
      frequency: 'secondary',
      publicMcpCallable: false,
      requiresHumanConfirmation:
        'Required before opening the operator microphone for a private voice whisper.',
    },
    {
      id: uiActionIds.openSmartConfig,
      surface: 'configs',
      testId: uiTestIds.smartConfigPanel,
      backendActions: [],
      headlessEquivalent:
        'Owner/admin-only Smart Config Codex project chat. Not MCP-callable; use private /api/smart-config routes only from an authenticated owner session.',
      ownerOnly: true,
      publicMcpCallable: false,
      proof: ['Smart Config panel visible for selected profile'],
      frequency: 'secondary',
    },
    {
      id: uiActionIds.sendSmartConfigMessage,
      surface: 'configs',
      testId: uiTestIds.smartConfigPanel,
      backendActions: [],
      headlessEquivalent:
        'Owner/admin-only private Codex app-server turn. Successful profile changes are schema-normalized and synced through the existing Speak config path.',
      ownerOnly: true,
      publicMcpCallable: false,
      proof: [
        'SSE assistant_delta or assistant_final',
        'profile_applied when a profile patch is accepted',
        'Speak config sync proof when provider-backed fields changed',
      ],
      frequency: 'primary',
    },
    {
      id: uiActionIds.stopSmartConfigMessage,
      surface: 'configs',
      testId: uiTestIds.smartConfigPanel,
      backendActions: [],
      headlessEquivalent:
        'Owner/admin-only Smart Config stream cancellation. Aborts the active browser stream and leaves any received partial transcript visible.',
      ownerOnly: true,
      publicMcpCallable: false,
      proof: ['Smart Config stopped status visible'],
      frequency: 'primary',
    },
    {
      id: uiActionIds.openSmartConfigHistory,
      surface: 'configs',
      testId: uiTestIds.smartConfigHistory,
      backendActions: [],
      headlessEquivalent:
        'Owner/admin-only browser history picker backed by Codex app-server thread metadata.',
      ownerOnly: true,
      publicMcpCallable: false,
      proof: ['profile-scoped Smart Config thread list visible'],
      frequency: 'secondary',
    },
    {
      id: uiActionIds.newSmartConfigConversation,
      surface: 'configs',
      testId: uiTestIds.smartConfigPanel,
      backendActions: [],
      headlessEquivalent:
        'Owner/admin-only creation of a profile-scoped Smart Config conversation record; the Codex thread is created on first turn.',
      ownerOnly: true,
      publicMcpCallable: false,
      proof: ['new profile-scoped Smart Config conversation selected'],
      frequency: 'secondary',
    },
    {
      id: uiActionIds.selectSmartConfigConversation,
      surface: 'configs',
      testId: uiTestIds.smartConfigHistory,
      backendActions: [],
      headlessEquivalent:
        'Owner/admin-only selection of an existing profile-scoped Codex Smart Config thread.',
      ownerOnly: true,
      publicMcpCallable: false,
      proof: ['selected Smart Config transcript loaded from Codex thread history'],
      frequency: 'secondary',
    },
    {
      id: uiActionIds.openSpeakPlayground,
      surface: 'configs',
      testId: uiTestIds.configTestPanel,
      backendActions: ['start_browser_config_test', 'send_browser_config_message'],
      headlessEquivalent:
        'Use the selected profile and browser Playground test actions for the Speak playground. For conversational edits, use send_operator_chat_message directly from the agent host.',
      proof: ['Speak playground visible in browser or browser Playground test proof in agent client'],
      frequency: 'primary',
    },
    {
      id: uiActionIds.togglePrompt,
      surface: 'configs',
      testId: uiTestIds.configTestPanel,
      backendActions: [],
      headlessEquivalent:
        'Browser presentation only; headless agents should read or update the selected profile instructions directly.',
      proof: ['prompt editor visible in playground body'],
      frequency: 'secondary',
    },
    {
      id: uiActionIds.addAgent,
      surface: 'configs',
      testId: uiTestIds.profilePicker,
      backendActions: ['upsert_profile', 'sync_speak_config'],
      proof: ['profile.id', 'speakConfigId', 'speakConfigVersion'],
      frequency: 'primary',
    },
    {
      id: uiActionIds.copyProfile,
      surface: 'configs',
      testId: uiTestIds.profilePicker,
      backendActions: ['list_profiles', 'upsert_profile', 'sync_speak_config'],
      headlessEquivalent:
        'Read the source profile, create a new profile ID/name with copied prompt, settings, voice, and context, then sync the copied profile to a distinct Speak config.',
      proof: ['profile.id', 'speakConfigId', 'speakConfigVersion'],
      frequency: 'secondary',
    },
    {
      id: uiActionIds.deleteProfile,
      surface: 'configs',
      testId: uiTestIds.profilePicker,
      backendActions: ['delete_profile'],
      headlessEquivalent:
        'Call delete_profile for the selected saved profile only after explicit authorization, then verify the returned profile list and activeProfileId.',
      proof: ['profiles[]', 'activeProfileId'],
      frequency: 'secondary',
      requiresHumanConfirmation:
        'Required unless the current task explicitly authorizes deleting the selected saved profile.',
    },
    {
      id: uiActionIds.refreshProfile,
      surface: 'configs',
      backendActions: ['read_speak_config'],
      proof: ['speakConfigId', 'version', 'config'],
      frequency: 'secondary',
    },
    {
      id: uiActionIds.saveProfile,
      surface: 'configs',
      testId: uiTestIds.profilePicker,
      backendActions: ['upsert_profile', 'sync_speak_config'],
      proof: ['profile.id', 'speakConfigId', 'speakConfigVersion'],
      frequency: 'primary',
    },
    {
      id: uiActionIds.clearFilters,
      surface: 'dialer',
      backendActions: ['list_leads', 'read_communication_threads', 'read_recent_calls'],
      headlessEquivalent:
        'Drop client-side filter predicates and use the unfiltered list_leads/read_communication_threads/read_recent_calls result.',
      proof: ['unfiltered contact IDs in agent client'],
      frequency: 'secondary',
    },
    {
      id: uiActionIds.selectLead,
      surface: 'dialer',
      testId: uiTestIds.leadRow,
      backendActions: ['read_communication_threads', 'read_recent_calls'],
      headlessEquivalent:
        'Track the selected contact ID in the agent client and read communication threads when transcript context is needed.',
      proof: ['selected contact ID in client state'],
      frequency: 'primary',
    },
    {
      id: uiActionIds.clearSelection,
      surface: 'dialer',
      backendActions: [],
      headlessEquivalent:
        'Clear the agent client selected-contact set; no backend mutation is required.',
      proof: ['empty selected contact set in client state'],
      frequency: 'secondary',
    },
    {
      id: uiActionIds.openLeadDetails,
      surface: 'dialer',
      testId: uiTestIds.leadRow,
      backendActions: ['list_leads'],
      headlessEquivalent:
        'Read the contact record through legacy list_leads and use update_lead for any field edits.',
      proof: ['lead.id'],
      frequency: 'primary',
    },
    {
      id: uiActionIds.closeLeadDetails,
      surface: 'dialer',
      backendActions: [],
      headlessEquivalent:
        'Dismiss the client details panel; no backend mutation is required.',
      proof: ['contact details panel closed in client state'],
      frequency: 'secondary',
    },
    {
      id: uiActionIds.endCall,
      surface: 'dialer',
      testId: uiTestIds.leadRow,
      backendActions: [
        'end_live_call',
        'read_communication_threads',
        'read_communication_thread_messages',
        'read_recent_calls',
      ],
      proof: ['ok', 'event.patch.phase=ended', 'communication thread outcome'],
      frequency: 'primary',
      requiresHumanConfirmation:
        'Required unless the current task explicitly authorizes ending the active live call.',
    },
    {
      id: uiActionIds.expandTranscript,
      surface: 'dialer',
      testId: uiTestIds.transcriptPanel,
      backendActions: ['read_communication_thread_messages', 'read_recent_calls'],
      headlessEquivalent:
        'Use read_communication_thread_messages or read_recent_calls output directly; fullscreen expansion is browser presentation state.',
      proof: ['fullscreen transcript state in browser or messages[].body/calls[].transcript headlessly'],
      frequency: 'primary',
    },
    {
      id: uiActionIds.closeTranscript,
      surface: 'dialer',
      testId: uiTestIds.transcriptPanel,
      backendActions: [],
      headlessEquivalent:
        'Clear selected transcript state in the client; no backend mutation is required.',
      proof: ['transcript panel closed in client state'],
      frequency: 'secondary',
    },
    {
      id: uiActionIds.toggleCallAudio,
      surface: 'dialer',
      testId: uiTestIds.transcriptPanel,
      backendActions: ['read_call_audio_link'],
      headlessEquivalent:
        'Read the call audio link and decide playback/download behavior in the agent host.',
      proof: ['status', 'url', 'source'],
      frequency: 'secondary',
    },
    {
      id: uiActionIds.skipToNextCall,
      surface: 'dialer',
      testId: uiTestIds.transcriptPanel,
      backendActions: ['end_live_call', 'read_workspace', 'start_live_call'],
      headlessEquivalent:
        'For a Speak/Telnyx queue, end the live call with a skipped/operator-ended outcome, then select the next authorized ready lead and call start_live_call. For CallTools campaign following, end only the attached call and wait for CallTools to route the next campaign call; never direct-start it.',
      proof: ['event.patch.phase=ended', 'callControlId for next call when started'],
      frequency: 'primary',
      requiresHumanConfirmation:
        'Required unless the current task explicitly authorizes ending the current call and dialing the next ready lead.',
    },
    {
      id: uiActionIds.routeToConfigs,
      surface: 'shared',
      testId: uiTestIds.routeSwitch,
      backendActions: [],
      headlessEquivalent:
        'Use the Playground (`configs`) route contract or render_speak_configs; no backend mutation is required.',
      proof: ['routeId=configs'],
      frequency: 'primary',
    },
    {
      id: uiActionIds.routeToDialer,
      surface: 'shared',
      testId: uiTestIds.routeSwitch,
      backendActions: [],
      headlessEquivalent:
        'Use the dialer route contract or render_speak_dialer; no backend mutation is required.',
      proof: ['routeId=dialer'],
      frequency: 'primary',
    },
    {
      id: uiActionIds.routeToLibrary,
      surface: 'shared',
      testId: uiTestIds.routeSwitch,
      backendActions: [],
      headlessEquivalent:
        'Use the library route contract or read workspace/list actions for large contact-data workflows; no backend mutation is required.',
      proof: ['routeId=library'],
      frequency: 'primary',
    },
    {
      id: uiActionIds.selectAgentProfile,
      surface: 'configs',
      testId: uiTestIds.profilePicker,
      backendActions: ['list_profiles', 'set_active_profile', 'read_speak_config'],
      headlessEquivalent:
        'Choose a profile ID from list_profiles, persist it as the current profile with set_active_profile when needed, and read_speak_config before editing or syncing it.',
      proof: ['profile.id', 'activeProfileId', 'speakConfigId when present'],
      frequency: 'primary',
    },
    {
      id: uiActionIds.filterAgentProfiles,
      surface: 'configs',
      testId: uiTestIds.configProfileFilterButton,
      backendActions: ['list_profiles'],
      headlessEquivalent:
        'Read list_profiles and filter by current/non-current profile ID in the agent client.',
      proof: ['filtered profile IDs in agent client'],
      frequency: 'secondary',
    },
    {
      id: uiActionIds.sortAndViewAgentProfiles,
      surface: 'configs',
      testId: uiTestIds.configProfileSortViewButton,
      backendActions: ['list_profiles'],
      headlessEquivalent:
        'Read list_profiles and sort profile records by name, active status, or updatedAt in the agent client.',
      proof: ['sorted profile IDs in agent client'],
      frequency: 'secondary',
    },
    {
      id: uiActionIds.openProfileSettings,
      surface: 'configs',
      backendActions: ['read_speak_options', 'read_speak_config', 'list_smart_views'],
      headlessEquivalent:
        'Read Speak options, Smart Views, and the selected profile config; settings panel visibility is browser presentation state.',
      proof: ['configs', 'voices', 'smartViews[]', 'speakConfigId when present'],
      frequency: 'secondary',
    },
    {
      id: uiActionIds.selectAppearance,
      surface: 'shared',
      testId: uiTestIds.appearanceTrigger,
      backendActions: [],
      headlessEquivalent:
        'Browser preference only; not required for headless operation.',
      proof: ['document appearance attribute'],
      frequency: 'secondary',
    },
  ]
}

function buildUiAutomationContract() {
  return {
    attributes: {
      route: 'data-route-id',
      testId: 'data-testid',
      action: 'data-action-id',
    },
    stableTestIds: Object.values(uiTestIds),
    routeContracts: [
      {
        routeId: 'dialer',
        path: '/dialer',
        rootTestId: uiTestIds.routeDialer,
        topbarTestId: uiTestIds.dialerTopbar,
        criticalTestIds: [
          uiTestIds.leadToolbar,
          uiTestIds.globalSearchTrigger,
          uiTestIds.routeSwitch,
          uiTestIds.appearanceTrigger,
          uiTestIds.leadQueue,
        ],
        desktopOnlyTestIds: [
          uiTestIds.transcriptPanel,
        ],
      },
      {
        routeId: 'configs',
        path: '/configs',
        rootTestId: uiTestIds.routeConfigs,
        topbarTestId: uiTestIds.configTopbar,
        criticalTestIds: [
          uiTestIds.globalSearchTrigger,
          uiTestIds.configTestToggle,
          uiTestIds.routeSwitch,
          uiTestIds.appearanceTrigger,
          uiTestIds.configTestPanel,
        ],
        desktopOnlyTestIds: [
          uiTestIds.profilePicker,
        ],
      },
      {
        routeId: 'library',
        path: '/library',
        rootTestId: uiTestIds.libraryRoute,
        topbarTestId: uiTestIds.libraryTopbar,
        criticalTestIds: [
          uiTestIds.globalSearchTrigger,
          uiTestIds.routeSwitch,
          uiTestIds.appearanceTrigger,
          uiTestIds.libraryActivityTab,
          uiTestIds.addLeadButton,
          uiTestIds.leadQueue,
        ],
        desktopOnlyTestIds: [],
      },
    ],
    layoutChecks: [
      {
        id: 'no_horizontal_overflow',
        selector: 'document.documentElement',
        assertion: 'scrollWidth <= clientWidth',
        viewports: ['desktop', 'phone'],
      },
      {
        id: 'phone_uses_icon_navigation',
        selector: '.app-primary-nav [aria-current="page"]',
        assertion: 'active route icon remains visible at 390x844',
        viewports: ['phone'],
      },
      {
        id: 'desktop_uses_icon_navigation',
        selector: '.app-primary-nav [aria-current="page"]',
        assertion: 'active route icon remains visible at desktop viewport',
        viewports: ['desktop'],
      },
      {
        id: 'shared_primary_navigation',
        selector: '.app-primary-nav',
        assertion:
          'Library, Dialer, and Playground route controls remain visible',
        viewports: ['desktop', 'phone'],
      },
      {
        id: 'persistent_left_chrome',
        selector: '.topbar',
        assertion:
          'Library, Dialer, Playground, Search, and Appearance remain in compact chrome without reserving right-side topbar space',
        viewports: ['desktop', 'phone'],
      },
      {
        id: 'primary_work_panels_visible',
        selector: `[data-testid="${uiTestIds.transcriptPanel}"], [data-testid="${uiTestIds.configTestPanel}"]`,
        assertion: 'route primary panel is visible and has non-zero geometry',
        viewports: ['desktop', 'phone'],
      },
    ],
    localCheckCommand:
      'SPEAK_QA_BASE_URL=http://127.0.0.1:5173/speak npm run qa:ui-contract',
  }
}

function buildUiDesignContract() {
  return {
    visualAuthority: 'BRANDING.md',
    cssTokenSource: 'src/index.css',
    componentStyleSource: 'src/App.css',
    automationSource: 'src/uiContract.ts',
    designMdCompatibility:
      'Do not maintain a separate manual DESIGN.md. Derive DESIGN.md-style context from BRANDING.md, src/index.css, and this frontend.designSystem contract when a host requires it.',
    cssTokens: {
      pageBackground: '--bg',
      surface: '--surface',
      raisedSurface: '--surface-raised',
      subtleSurface: '--surface-subtle',
      mutedSurface: '--surface-muted',
      hoverSurface: '--surface-hover',
      selectedSurface: '--surface-selected',
      activeSurface: '--surface-active',
      strongText: '--text-strong',
      bodyText: '--text',
      mutedText: '--muted',
      border: '--border',
      strongBorder: '--border-strong',
      softDivider: '--divider-soft',
      accent: '--accent',
      accentHover: '--accent-hover',
      accentStrong: '--accent-strong',
      accentContrast: '--accent-contrast',
      accentSoft: '--accent-soft',
      accentBorder: '--accent-border',
      focusBorder: '--focus-border',
      focusRing: '--focus-ring',
      success: '--success',
      danger: '--danger',
      warning: '--warning',
      info: '--info',
      popoutBackground: '--speak-popout-bg',
      popoutInner: '--speak-popout-inner',
      popoutBorder: '--speak-popout-border',
      popoutDivider: '--speak-popout-divider',
      popoutShadow: '--speak-popout-shadow',
      popoutRadius: '--speak-popout-radius',
      menuRadius: '--speak-menu-radius',
      popoutRowRadius: '--speak-popout-row-radius',
      desktopControlHeight: '--speak-control-height-desktop',
      phoneControlHeight: '--speak-control-height-phone',
      denseIconSize: '--speak-dense-icon-size',
      phoneIconSize: '--speak-phone-icon-size',
      panelRadius: '--speak-radius-panel',
      controlRadius: '--speak-radius-control',
      topbarSearchWidth: '--speak-topbar-search-width',
      leftPanelWidth: '--speak-left-panel-width',
      phoneTranscriptMinHeight: '--speak-phone-transcript-min-height',
      phoneBreakpoint: '--speak-phone-breakpoint',
      fontSans: '--font-sans',
      fontMono: '--mono',
    },
    sharedControlGrammar: [
      'AppPrimaryNavigation',
      'AppearanceSwitch',
      'TopbarOverflowMenu',
      'unified-campaign-control',
      'AgentProfilePicker',
    ],
    componentRecipes: [
      'Primary navigation and topbar icons use fixed hit areas, icon-first labels, and active state through surface/text contrast.',
      'Global search and appearance form one compact chrome band aligned across Library, Dialer, and Playground.',
      'Call/Stop/End is one stateful repeated-action control in the work surface or phone command row, not every list row.',
      'Device call opens tel: and must not imply backend call proof or call /api/calls/start.',
      'Popovers, menus, sheets, drawers, and modal popouts use only --speak-popout-* tokens.',
      'Transcript and chat bubbles use participant labels from call context, bottom composers, and saved history before active attempts.',
    ],
    principle:
      'The UI is one client of the backend action contract. Prefer backend actions for headless work and browser automation only for visual QA or browser-only preferences.',
  }
}

function parseSchema(value) {
  if (!value) return { type: 'object', properties: {} }
  if (typeof value === 'object') return value
  try {
    return JSON.parse(String(value))
  } catch {
    return { type: 'object', properties: {} }
  }
}

function schemaParameters(schema, location) {
  if (!schema?.properties) return []
  return Object.entries(schema.properties).map(([name, value]) => ({
    name,
    in: location,
    required: location === 'path' || schema.required?.includes(name),
    schema: value,
  }))
}

function normalizeBasePath(value) {
  if (!value || value === '/') return ''
  return `/${String(value).replace(/^\/+|\/+$/g, '')}`
}

function appRoot({ basePath, publicBaseUrl }) {
  const publicRoot = String(publicBaseUrl || '').replace(/\/+$/g, '')
  if (publicRoot) return publicRoot
  return normalizeBasePath(basePath)
}

function routeUrl(root, route) {
  const normalizedRoute = route.startsWith('/') ? route : `/${route}`
  if (!root) return normalizedRoute
  if (root === '/') return normalizedRoute
  return `${root}${normalizedRoute === '/' ? '/' : normalizedRoute}`
}

function originForRoot(root) {
  if (!/^https?:\/\//i.test(String(root || ''))) return ''
  try {
    return new URL(root).origin
  } catch {
    return ''
  }
}
