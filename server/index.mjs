import 'dotenv/config'
import express from 'express'
import http from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket, WebSocketServer } from 'ws'
import {
  analyzePcm16,
  bufferToInt16LE,
  decodeTelnyxPayload,
  decodeWavPcm16,
  encodePcm16LeToUlaw,
  int16ToBufferLE,
  levelPcm16ForPhone,
  normalizeAudioCodec,
  pcm16IsAudible,
  resamplePcm16,
} from './audio.mjs'
import {
  callAudioDiagnosticFilePath,
  callAudioFilePath,
  finalizeCallAudio,
  localCallAudioMetadata,
  recordCallAudioBuffer,
  recordCallAudioSamples,
  recordCallStageAudioBuffer,
  recordCallStageAudioSamples,
} from './call-audio.mjs'
import {
  deletePersistedCallSummaries,
  flushPersistedCallEvents,
  persistCallEvent as persistCallEventToLog,
  recentCallSummaries as collectRecentCallSummaries,
  transcriptEntry,
} from './call-history.mjs'
import { extractHumeEmotionScores } from './hume-emotion-scores.mjs'
import {
  callOutcomeSummary,
  configurationTestVariableKeySet,
  contactPatchSummary,
  createCallState,
  createStateFromStreamStart,
  decodeClientState,
  inferHangupOutcome,
  inferStreamStopOutcome,
  inferTelnyxMachineOutcome,
  inferTranscriptOutcome,
  isCallEnded,
  isTelnyxAlreadyEnded,
  maskEmail,
  maskPhone,
  normalizeCallOutcome,
  normalizeConfigurationTestVariableKeys,
  normalizeConfigurationTestVariables,
  normalizeDeliveryMethod,
  normalizeLead,
  publicLeadContext,
  resolveToolHangupOutcome,
  setCallOutcome,
  shouldDeferToolHangup,
  shouldEndImmediately,
  statusForOutcome,
  truthy,
} from './call-state.mjs'
import {
  buildPortalEmailBody,
  buildPortalSmsBody,
  observeTelnyxSmsFinalization,
  sendEmail,
  sendTextMessage,
  waitForTelnyxSmsFinalization,
} from './delivery.mjs'
import {
  createBackgroundDeliveryFingerprint,
  createDurableBackgroundDeliveryOutbox,
} from './background-delivery.mjs'
import { executeContactUpdatePersistence } from './contact-update.mjs'
import {
  conversationMemoryContactIdForLead,
  isTransientWorkspaceLead,
} from './transient-workspace-lead.mjs'
import { buildWorkspaceEmailCommunicationEvent } from './workspace-email-normalizer.mjs'
import { fetchWorkspaceEmailSyncPayloads } from './workspace-email-sync.mjs'
import { operationalDate } from './operational-time.mjs'
import {
  applySharedCallToolsDutyBinding,
  auditCallToolsReadiness,
  buildCallToolsProvisioningPlan,
  callToolsOutcomeAutoSyncEnabled,
  callToolsMediaGatewayConfigured,
  ensureCallToolsAgentSessionReadiness,
  listCallToolsOptions,
  readCallToolsDutyStatus,
  readCallToolsHistoricalCall,
  readCallToolsPhoneCredentials,
  reconcileCallToolsCallOutcome,
  resolveCallToolsLiveCallContext,
  verifyCallToolsAgentBinding,
} from './calltools-client.mjs'
import {
  createCallToolsDutyMonitor,
  isActiveCallToolsDuty,
  normalizeDutyBinding,
} from './calltools-duty-monitor.mjs'
import {
  createCallToolsCallWatchdog,
  createCallToolsWatchdogStore,
} from './calltools-call-watchdog.mjs'
import { assertCallToolsSeatClaimSafe } from './calltools-seat-claim.mjs'
import { withCallToolsRuntimeIdentity } from './calltools-runtime-config.mjs'
import {
  advanceCallToolsFirstTurnGate,
  createCallToolsFirstTurnGate,
  shouldSuppressCallToolsAssistantOutput,
} from './calltools-first-turn.mjs'
import {
  callToolsVoiceStandbyRuntimeFingerprint,
  createCallToolsVoiceStandbyCoordinator,
} from './calltools-voice-standby.mjs'
import {
  callToolsCampaignContactsStatus,
  syncCallToolsCampaignContactsToWorkspace,
} from './calltools-contacts.mjs'
import { listPhoneProviderOptions } from './phone-provider-options.mjs'
import {
  automationProof,
  resolveInboundAutomationPolicy,
} from './communication-automation.mjs'
import {
  CodexClmReadinessError,
  assertCodexClmRuntimeReady,
  handleCodexClmChatCompletion,
  rememberCodexClmSessionContext,
  setCodexClmTimingObserver,
  setCodexClmToolExecutor,
} from './codex-clm.mjs'
import {
  buildSpeakA2aAgentCard,
  buildSpeakA2uiManifest,
  buildSpeakAcpManifest,
  buildSpeakAgUiManifest,
  buildSpeakAgentContract,
  buildSpeakAgentReadinessReport,
  buildSpeakAiSdkManifest,
  buildSpeakChatGptAppManifest,
  buildSpeakCopilotKitManifest,
  buildSpeakGenerativeUiManifest,
  buildSpeakJsonRenderManifest,
  buildSpeakMcpUiManifest,
  buildSpeakOpenApiDocument,
  buildSpeakUiAdapterKit,
} from './agent-contract.mjs'
import { invokeSpeakAgentAction } from './agent-action-invoker.mjs'
import {
  assertSmartConfigAccess,
  clearSmartConfigSession,
  finishSmartConfigGoogleOAuth,
  smartConfigSessionStatus,
  startSmartConfigGoogleOAuth,
} from './smart-config-auth.mjs'
import {
  SMART_CONFIG_SCHEMA_VERSION,
  createSmartConfigConversation,
  listSmartConfigConversations,
  readSmartConfigConversation,
  streamSmartConfigTurn,
} from './smart-config-chat.mjs'
import { buildOperatorChatTurn } from './operator-chat.mjs'
import {
  speakInworldToolDefinitions,
  speakSessionToolDefinitions,
} from './hume-tools.mjs'
import {
  HUME_INPUT_PRIMER_CHUNK_MS,
  applyHumeHandshakeSessionSettings,
  buildHumeCodexPromptContext,
  humeAudioSessionSettings,
  humeInputPrimerFrame,
} from './hume-session.mjs'
import {
  readHumeAgentConfig,
  readHumeConfigOptions,
  syncHumeAgentConfig,
} from './hume-configs.mjs'
import {
  isVoiceConfigSyncError,
  readInworldAgentConfig,
  readInworldConfigOptions,
  readXaiAgentConfig,
  readXaiConfigOptions,
  readSpeakAgentConfig,
  readSpeakConfigOptions,
  syncInworldAgentConfig,
  syncXaiAgentConfig,
  syncSpeakAgentConfig,
} from './speak-configs.mjs'
import {
  ensureInworldRuntimeConfigReady,
  prewarmInworldModelCatalog,
  resolveInworldReasoningEffort,
} from './inworld-configs.mjs'
import {
  ensureXaiRuntimeConfigReady,
  prewarmXaiVoiceCatalog,
} from './xai-configs.mjs'
import {
  buildContextToolPayload,
  deleteContextFile,
  readContextFile,
  renderRuntimeContext,
  saveContextFileFromRequest,
} from './context-fields.mjs'
import {
  getDeepgramApiKey,
  getHumeApiKey,
  getInworldApiKey,
  getXaiApiKey,
  getPersonalPhoneSpeakHandoffSecret,
} from './secrets.mjs'
import { createPlaygroundCallSupervision } from './playground-call-supervision.mjs'
import {
  PERSONAL_PHONE_HANDOFF_SCHEMA,
  PERSONAL_PHONE_READINESS_SCHEMA,
  PERSONAL_PHONE_RESOLVE_SCHEMA,
  PersonalPhoneInboundHandoffRegistry,
  normalizePersonalPhoneInboundHandoffRequest,
  normalizePersonalPhoneInboundResolveRequest,
  personalPhoneInboundBearerAuthorized,
  personalPhoneInboundCorrelationId,
  personalPhoneVoicemailResponse,
  personalPhoneVoicemailResolution,
  resolvePersonalPhoneInboundEligibility,
} from './personal-phone-inbound.mjs'
import {
  createProvisionalVoiceSessionRegistry,
  drainProvisionalVoiceSessionEvents,
  isProvisionalVoiceSessionState,
  queueProvisionalVoiceSessionEvent,
} from './provisional-voice-session.mjs'
import {
  createPlaygroundStartRequestRegistry,
  normalizePlaygroundStartRequestId,
} from './playground-start-requests.mjs'
import {
  HUME_API_BASE,
  INWORLD_API_BASE,
  XAI_API_BASE,
  TELNYX_API_BASE,
  providerError,
  readJson,
  telnyxHeaders,
} from './provider-http.mjs'
import {
  buildRuntimeSystemPrompt,
  shouldSendHumeSessionSystemPrompt,
} from './session-prompt.mjs'
import {
  boolEnv,
  cleanEmail,
  cleanName,
  cleanObject,
  DEFAULT_INWORLD_STT_MODEL,
  DEFAULT_INWORLD_VOICE,
  DEFAULT_INWORLD_REALTIME_MODEL,
  DEFAULT_SAMPLE_RATE,
  getCallToolsMediaGatewaySharedSecret,
  getCodexAuthModel,
  getCodexClmPublicUrl,
  getSpeakLinkUrl,
  getStreamUrl,
  getTelnyxSmsFrom,
  getTelnyxWebhookUrl,
  getTelnyxWebhookPublicKeys,
  getWorkspaceEmailAccount,
  isCallToolsDialer,
  isInworldRuntime,
  isXaiRuntime,
  isCodexAuthLanguageModel,
  isEmailConfigured,
  isSmsConfigured,
  missingForCall,
  missingForVoiceSession,
  missingRuntimeEnv,
  normalizeBasePath,
  normalizeCampaignConfig,
  normalizePhone,
  numberEnv,
  preferredFirstName,
  refreshWorkspaceEmailReadiness,
  safeLeadText,
  splitPersonName,
  stripBasePathFromPathname,
  workspaceEmailGmailAuthConfigured,
  workspaceEmailGmailReadConfigured,
  workspaceEmailSendAsConfigured,
  workspaceEmailSourceReadConfigured,
  telnyxWebhookSignatureRequired,
} from './runtime-config.mjs'
import {
  addTransportCounter,
  buildTransportDiagnosticSnapshot,
  markTransportTimestamp,
  recordTransportMilestone,
  recordTransportMilestoneAt,
  setTransportDiagnosticValue,
} from './transport-diagnostics.mjs'
import {
  assistantTurnHasAudio,
  bufferBrowserAudioBeforeAttach,
  bufferVoiceInputBeforeReady,
  clearBrowserAudioBeforeAttach,
  clearVoiceInputBeforeReady,
  conditionPhoneVoiceInputPcm,
  consumeSyntheticUserInput,
  drainBrowserAudioBeforeAttach,
  drainVoiceInputBeforeReady,
  noteCallerSpeechStopped,
  noteFinalUserTurn,
  noteFirstAssistantAudio,
  noteVoiceInputPcmActivity,
  selectHumeUserInputTransport,
  shouldEmitFinalUserTranscript,
} from './voice-turn-transport.mjs'
import { createVoiceInterruptionRecovery } from './voice-interruption-recovery.mjs'
import { voiceProviderConfigSyncRequired } from './voice-provider-sync-policy.mjs'
import {
  clearTelnyxOutboundQueue,
  enqueuePcmToTelnyx,
  flushTelnyxOutboundRemainder,
} from './telnyx-audio-queue.mjs'
import {
  buildTelnyxInboundCallCommunicationEvent,
  buildTelnyxSmsCommunicationEvent,
  telnyxPayloadPhone,
} from './telnyx-webhook-normalizer.mjs'
import { verifyTelnyxWebhookRequest } from './telnyx-webhook-signature.mjs'
import {
  bulkPatchWorkspaceLeads,
  createWorkspaceLead,
  deleteWorkspaceSmartView,
  deleteWorkspaceLeads,
  deleteWorkspaceProfile,
  importWorkspaceSmartViewLeads,
  importWorkspaceLeads,
  listWorkspaceLeads,
  listWorkspaceProfiles,
  listWorkspaceSmartViews,
  listCommunicationThreadMessages,
  listCommunicationThreads,
  patchWorkspaceDialerState,
  patchWorkspaceLead,
  readCommunicationThread,
  readContactCommunicationMemory,
  readWorkspaceCallToolsDuty,
  readWorkspaceDialerState,
  rebuildCommunicationThreadSummary,
  recordCommunicationEvent,
  recordCommunicationEvents,
  resolveCommunicationEventContext,
  replaceWorkspaceLeads,
  replaceWorkspaceProfiles,
  resolveWorkspaceRuntimeContext,
  resolveWorkspaceRuntimeSnapshot,
  searchWorkspace,
  setActiveWorkspaceProfile,
  transitionWorkspaceCallToolsDuty,
  upsertWorkspaceSmartView,
  upsertWorkspaceProfile,
  workspaceSnapshot,
} from './workspace-store.mjs'
import {
  personalPhoneContactsStatus,
  syncPersonalPhoneContactsToWorkspace,
} from './personal-phone-contacts.mjs'
import {
  handleSpeakMcpOptions,
  handleSpeakMcpRequest,
  renderSpeakUiSnapshot,
  speakWidgetDocument,
} from './speak-mcp.mjs'

const PORT = Number(process.env.PORT || 8787)
const CALLTOOLS_CODEX_READINESS_PROOF_TTL_MS = Math.max(
  5_000,
  numberEnv('CALLTOOLS_CODEX_READINESS_PROOF_TTL_MS', 15_000),
)
const TEMP_AGENT_MODE = process.env.HUME_TEMP_AGENT_MODE || ''
const JONATHAN_ECHO_MODE = 'jonathan_echo'

function callToolsCodexReadinessRefreshOptions() {
  return {
    cacheTtlMs: CALLTOOLS_CODEX_READINESS_PROOF_TTL_MS,
    forceRefresh: true,
  }
}

function callToolsCodexReadinessInviteOptions() {
  return {
    cacheOnly: true,
    cacheTtlMs: CALLTOOLS_CODEX_READINESS_PROOF_TTL_MS,
  }
}

const JONATHAN_ECHO_SYSTEM_PROMPT = [
  'You are on a live outbound phone call.',
  'Your only job is this:',
  '1. Open by asking: "Hi, can I speak to Jonathan?"',
  '2. If someone other than Jonathan answers, ask for Jonathan again naturally.',
  '3. Once Jonathan begins speaking, repeat exactly what Jonathan says, word for word, matching his tone and emotion as closely as possible.',
  '4. Keep mirroring Jonathan verbatim until Jonathan hangs up.',
  'Do not mention testing, debugging, instructions, prompts, internal business context, applications, portals, SMS, email, or tools.',
  'Do not explain what you are doing. Do not add commentary. Do not answer questions normally. If Jonathan asks a question, repeat the question verbatim.',
  'Do not break character.',
].join('\n')
const BASE_PATH = normalizeBasePath(process.env.BASE_PATH || '')
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distPath = path.resolve(__dirname, '..', 'dist')
const callLogDir = path.resolve(
  __dirname,
  '..',
  process.env.SPEAK_CALL_LOG_DIR || 'call-logs',
)
const callAudioDir = path.resolve(__dirname, '..', 'call-audio')
const workspaceDataDir = path.resolve(
  __dirname,
  '..',
  process.env.SPEAK_WORKSPACE_DATA_DIR || 'workspace-data',
)
const backgroundDeliveryOutboxPath = path.resolve(
  process.env.BACKGROUND_DELIVERY_OUTBOX_PATH ||
    path.join(workspaceDataDir, 'background-delivery-outbox.json'),
)
const callToolsWatchdogStatePath = path.resolve(
  process.env.CALLTOOLS_WATCHDOG_STATE_PATH ||
    path.join(workspaceDataDir, 'calltools-watchdog.json'),
)
const TELNYX_MIN_HANGUP_DURATION_MS = 10_000
const HANGUP_WAIT_TICK_MS = 1_000
const CALLTOOLS_GATEWAY_STALE_AFTER_MS = Number(
  process.env.CALLTOOLS_GATEWAY_STALE_AFTER_MS || 45_000,
)
const CALLTOOLS_GATEWAY_PROFILE_BIND_TIMEOUT_MS = Number(
  process.env.CALLTOOLS_GATEWAY_PROFILE_BIND_TIMEOUT_MS || 2_500,
)
const CALLTOOLS_GATEWAY_REGISTRATION_TIMEOUT_MS = Number(
  process.env.CALLTOOLS_GATEWAY_REGISTRATION_TIMEOUT_MS || 10_000,
)
const CALLTOOLS_VOICE_READY_TIMEOUT_MS = Number(
  process.env.CALLTOOLS_VOICE_READY_TIMEOUT_MS || 8_000,
)
const CALLTOOLS_CONTEXT_PRELOAD_TIMEOUT_MS = 750
const HUME_INPUT_PRIMER_MIN_READY_MS = 1_000
const HUME_INPUT_PRIMER_MAX_MS = 10_000
const CALLTOOLS_GATEWAY_CLOSE_RECONCILE_TIMEOUT_MS = Math.max(
  1_000,
  Math.min(
    10_000,
    Number.isFinite(Number(process.env.CALLTOOLS_GATEWAY_CLOSE_RECONCILE_TIMEOUT_MS || 2_500))
      ? Number(process.env.CALLTOOLS_GATEWAY_CLOSE_RECONCILE_TIMEOUT_MS || 2_500)
      : 2_500,
  ),
)
const CALLTOOLS_RECORDING_RECONCILE_DELAYS_MS = String(
  process.env.CALLTOOLS_RECORDING_RECONCILE_DELAYS_MS ||
    '15000,60000,180000,600000,1800000,3600000',
)
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0)
const ASSISTANT_RESPONSE_IDLE_MS = Number(
  process.env.HUME_ASSISTANT_RESPONSE_IDLE_MS || 4500,
)
const PLAYGROUND_PENDING_INPUT_RECHECK_MS = Number(
  process.env.HUME_PLAYGROUND_PENDING_INPUT_RECHECK_MS || 1200,
)
const VOICE_PROVIDER_SYNC_SECTIONS = Object.freeze({
  name: true,
  prompt: true,
  settings: true,
  voice: true,
})

const app = express()
const server = http.createServer(app)
const telnyxMediaWss = new WebSocketServer({ noServer: true })
const calltoolsMediaGatewayWss = new WebSocketServer({ noServer: true })
const humanAudioWss = new WebSocketServer({ noServer: true })
const playgroundSupervisionWss = new WebSocketServer({ noServer: true })
const browserTestWss = new WebSocketServer({ noServer: true })
const calltoolsGatewayRegistry = new Map()
let callToolsGatewayLeaseOwner = {
  gatewayOwnerInstanceId: '',
  leaseId: '',
  phoneId: '',
  profileId: '',
}
const calltoolsGatewayPreparations = new WeakMap()
const calltoolsGatewayDrainPromises = new Set()
const personalPhoneInboundHandoffs = new PersonalPhoneInboundHandoffRegistry()
const calls = new Map()
const playgroundCallSupervision = createPlaygroundCallSupervision({
  getDeepgramApiKey,
  sendInstruction: (state, instruction) => sendVoiceInstruction(state, instruction),
  onWhisperDelivered: (state, instruction) => {
    emitCallEvent(state.callControlId, {
      entry: transcriptEntry(
        'You',
        `Voice whisper to agent: ${instruction}`,
        'system',
      ),
      notice: 'Voice whisper delivered to agent',
    })
  },
})
const voiceInterruptionRecovery = createVoiceInterruptionRecovery({
  resolveState: (callControlId) => getCallState(callControlId),
  sendRecovery: (state, text, metadata) =>
    sendVoiceUserInput(state, text, { reason: metadata.reason }),
  isEnded: (state) => Boolean(state?.ending || isCallEnded(state)),
  onRecovered: (state, recovery) => {
    addTransportCounter(state, 'interruptionSilenceRecoveries')
    recordTransportMilestone(state, 'interruption_silence_recovery', {
      provider: recovery.provider,
      silenceMs: recovery.delayMs,
    })
    emitCallEvent(state.callControlId, {
      diagnostic: buildTransportDiagnosticSnapshot(state),
      entry: transcriptEntry(
        'System',
        'Caller silence followed an interruption; the configured agent was prompted to resume naturally.',
        'system',
      ),
      notice: 'Agent resumed after silent interruption',
    })
  },
  onFailure: (state, error, recovery) => {
    recordTransportMilestone(state, 'interruption_silence_recovery_failed', {
      provider: recovery.provider,
      reason: error instanceof Error ? error.message : String(error),
    })
    emitCallEvent(state.callControlId, {
      diagnostic: buildTransportDiagnosticSnapshot(state),
      entry: transcriptEntry(
        'System',
        'The voice provider did not accept the silent-interruption recovery turn.',
        'attention',
      ),
      notice: 'Silent interruption recovery failed',
    })
  },
})
const playgroundStartRequests = createPlaygroundStartRequestRegistry({
  // Keep tombstones longer than every bounded provider/readiness request so a
  // severely delayed start can never outlive the client's cancellation proof.
  ttlMs: numberEnv('PLAYGROUND_START_REQUEST_TTL_MS', 15 * 60_000),
  maxEntries: numberEnv('PLAYGROUND_START_REQUEST_MAX_ENTRIES', 2_048),
})
const voiceProviderSessionAliases = new Map()
const provisionalVoiceSessions = createProvisionalVoiceSessionRegistry({
  ttlMs: numberEnv('VOICE_SESSION_PRECONNECT_TTL_MS', 15_000),
  closeState: (state, reason) => {
    state.resolveVoicePrewarmBinding?.()
    state.resolveVoicePrewarmBinding = null
    recordTransportMilestone(state, 'voice_preconnect_canceled', { reason })
    closeCallSockets(state)
    forgetVoiceProviderSessionAlias(state)
  },
})
const callToolsVoiceStandby = createCallToolsVoiceStandbyCoordinator({
  prepare: prepareCallToolsStandbyVoiceSession,
  cancel: cancelProvisionalVoiceSession,
  get: (key) => provisionalVoiceSessions.get(key),
  isHealthy: callToolsStandbyVoiceSessionHealthy,
})
const sseClients = new Map()
const deliveryDrainPromises = new Set()
let shutdownStarted = false
const backgroundDeliveryOutbox = createDurableBackgroundDeliveryOutbox({
  persistencePath: backgroundDeliveryOutboxPath,
  execute: executeDurableBackgroundDelivery,
  settle: settleDurableBackgroundDelivery,
  retryBaseMs: numberEnv('BACKGROUND_DELIVERY_RETRY_BASE_MS', 1_000),
  retryMaxMs: numberEnv('BACKGROUND_DELIVERY_RETRY_MAX_MS', 30_000),
  dedupeTtlMs: numberEnv('BACKGROUND_DELIVERY_DEDUPE_TTL_MS', 120_000),
  retentionMs: numberEnv(
    'BACKGROUND_DELIVERY_RETENTION_MS',
    7 * 24 * 60 * 60 * 1_000,
  ),
  maxJobs: numberEnv('BACKGROUND_DELIVERY_MAX_JOBS', 2_000),
})
const callToolsDutyMonitor = createCallToolsDutyMonitor({
  arm: async ({ binding, leaseId, profileId }) => {
    const profile = await resolveCallToolsSourceProfileInput({ profileId })
    let config
    try {
      config = await ensureVoiceRuntimeReady(
        normalizeCampaignConfig({
          ...(profile.config || {}),
          agentProfileId: profile.id,
          agentProfileName: profile.name,
        }),
        { codexReadiness: callToolsCodexReadinessRefreshOptions() },
      )
    } catch (error) {
      callToolsVoiceStandby.cancel('voice_runtime_unavailable')
      throw error
    }
    config.profileContext = profile.context || config.profileContext
    await assertCallToolsSeatClaimAvailable(profile, binding, { leaseId })
    const gatewayRegistration = await setCallToolsGatewayRegistration(
      profile,
      binding,
      true,
    )
    await bindCallToolsGatewayToProfile(
      { ...profile, config },
      binding,
    )
    const session = await ensureCallToolsAgentSessionReadiness({
      apply: true,
      binding,
      ready: true,
      requireCampaignReady: true,
      webPhoneStatus: 'Registered',
    })
    if (session?.ok && session?.after?.ready === true) {
      ensureCallToolsStandbyVoiceSession({
        binding,
        config,
        leaseId,
        profile,
      })
    }
    return { ...session, gatewayRegistration }
  },
  disarm: async ({ binding, profileId }) => {
    callToolsVoiceStandby.cancel('unavailable')
    const session = await ensureCallToolsAgentSessionReadiness({
      apply: true,
      binding,
      ready: false,
      requireCampaignReady: false,
      webPhoneStatus: 'Registered',
    })
    if (!session?.ok || session?.after?.ready !== false) return session
    const gatewayRegistration = await setCallToolsGatewayRegistration(
      { id: profileId },
      binding,
      false,
    )
    return { ...session, gatewayRegistration }
  },
  intervalMs: Number.isFinite(Number(process.env.CALLTOOLS_DUTY_MONITOR_INTERVAL_MS))
    ? Math.max(2_000, Number(process.env.CALLTOOLS_DUTY_MONITOR_INTERVAL_MS))
    : 5_000,
  patchDuty: transitionWorkspaceCallToolsDuty,
  readDuty: readWorkspaceCallToolsDuty,
  readProviderStatus: async ({ binding, leaseId, profileId }) => {
    const providerStatus = await readCallToolsDutyStatus({ binding })
    const gatewayStatus = callToolsGatewayStatusForProfile({ id: profileId }, binding)
    if (
      providerStatus.agentReady === true &&
      providerStatus.campaignActive === true &&
      providerStatus.originateCalls === true &&
      gatewayStatus.connected &&
      !safeLeadText(gatewayStatus.gateway?.activeCallControlId)
    ) {
      const profile = await resolveCallToolsSourceProfileInput({ profileId })
      let config
      try {
        config = await ensureVoiceRuntimeReady(
          normalizeCampaignConfig({
            ...(profile.config || {}),
            agentProfileId: profile.id,
            agentProfileName: profile.name,
          }),
          { codexReadiness: callToolsCodexReadinessRefreshOptions() },
        )
      } catch (error) {
        callToolsVoiceStandby.cancel('voice_runtime_unavailable')
        throw error
      }
      config.profileContext = profile.context || config.profileContext
      await bindCallToolsGatewayToProfile({ ...profile, config }, binding)
      ensureCallToolsStandbyVoiceSession({
        binding,
        config,
        leaseId,
        profile,
      })
    }
    return {
      ...providerStatus,
      gatewayHealthy: gatewayStatus.connected,
      gatewayStatus: gatewayStatus.status,
    }
  },
})

const callToolsCallWatchdog = createCallToolsCallWatchdog({
  intervalMs: Number.isFinite(Number(process.env.CALLTOOLS_WATCHDOG_INTERVAL_MS))
    ? Math.max(60_000, Number(process.env.CALLTOOLS_WATCHDOG_INTERVAL_MS))
    : 5 * 60_000,
  store: createCallToolsWatchdogStore({ filePath: callToolsWatchdogStatePath }),
  readDuty: readWorkspaceCallToolsDuty,
  readRecentCalls: async ({ limit = 50 } = {}) =>
    collectRecentCallSummaries({
      callStates: Array.from(calls.values()),
      callLogDir,
      limit,
      leadForState: publicLeadContext,
    }),
  readAgentInstructions: async ({ duty } = {}) => {
    const profile = await resolveCallToolsSourceProfileInput({
      profileId: duty?.profileId,
    })
    return safeLeadText(profile?.config?.instructions)
  },
  repair: async ({ incidents = [] } = {}) => {
    const liveCallAttached = Array.from(calls.values()).some(
      (state) =>
        state?.callProvider === 'calltools' &&
        !state.ending &&
        !isCallEnded(state),
    )
    const transportRepairRequired = incidents.some((incident) =>
      [
        'CALLTOOLS_ASSISTANT_BEFORE_CALLER',
        'CALLTOOLS_ASSISTANT_AUDIO_MISSING',
        'CALLTOOLS_CALLER_UNANSWERED',
        'CALLTOOLS_FIRST_RESPONSE_SLOW',
        'CALLTOOLS_PROVIDER_RUNTIME_FAILURE',
      ].includes(incident.code),
    )
    const standbyReset = Boolean(
      transportRepairRequired &&
      !liveCallAttached &&
      callToolsVoiceStandby.cancel('watchdog_transport_repair'),
    )
    try {
      const duty = await callToolsDutyMonitor.reconcileNow()
      return {
        action: standbyReset ? 'standby_reset_and_reconciled' : 'reconciled',
        ok: true,
        standbyReset,
        status: duty?.status,
      }
    } catch (error) {
      return {
        action: standbyReset ? 'standby_reset_reconcile_pending' : 'reconcile_pending',
        error: error instanceof Error ? error.message : 'CallTools repair failed',
        ok: false,
        standbyReset,
        status: 'attention',
      }
    }
  },
  reconcile: async () => {
    try {
      const duty = await callToolsDutyMonitor.reconcileNow()
      return { action: 'reconciled', ok: true, status: duty?.status }
    } catch (error) {
      return {
        action: 'reconcile_pending',
        error: error instanceof Error ? error.message : 'CallTools reconcile failed',
        ok: false,
        status: 'attention',
      }
    }
  },
  onIncidents: async ({ incidents = [] } = {}) => {
    for (const incident of incidents) {
      console.warn(
        'CallTools watchdog incident',
        JSON.stringify({
          callControlId: incident.callControlId,
          categoryCodes: incident.categoryCodes || [],
          code: incident.code,
          severity: incident.severity,
        }),
      )
      const state = calls.get(incident.callControlId)
      if (!state) continue
      state.calltoolsWatchdogIncidentKeys ||= new Set()
      const key = `${incident.code}:${(incident.categoryCodes || []).join(',')}`
      if (state.calltoolsWatchdogIncidentKeys.has(key)) continue
      state.calltoolsWatchdogIncidentKeys.add(key)
      const category = (incident.categoryCodes || []).join(', ') || incident.code
      emitCallEvent(state.callControlId, {
        entry: transcriptEntry(
          'System',
          `Call watchdog flagged conversation quality: ${category}. Review the VM watchdog report.`,
          'attention',
        ),
        notice: 'Call watchdog incident',
      })
    }
  },
})

function blockSandboxedPlaygroundDelivery(state, name) {
  if (
    !isBrowserTestSandbox(state) ||
    !['send_text_message', 'send_email', 'send_portal_link'].includes(name)
  ) {
    return null
  }

  emitCallEvent(state.callControlId, {
    entry: transcriptEntry(
      'Tool',
      `${name} blocked during browser Playground test.`,
      'attention',
    ),
    notice: 'Test delivery blocked',
  })
  return {
    ok: false,
    sent: false,
    reason: 'configuration_test_delivery_disabled',
    assistant_next_step:
      'Do not say the message was sent. Say the test cannot send real external messages.',
  }
}

setCodexClmTimingObserver((event) => {
  const state = getCallState(event?.customSessionId)
  if (!state || !event?.name || !event?.at) return
  const requestSequence = Number(event.requestSequence)
  if (!Number.isFinite(requestSequence)) return
  const activeRequestSequence = Number(
    state.lastCodexClmTimingRequestSequence || 0,
  )
  if (event.name === 'clm_request_received') {
    if (requestSequence < activeRequestSequence) return
    state.lastCodexClmTimingRequestSequence = requestSequence
  } else if (requestSequence !== activeRequestSequence) {
    return
  }

  recordTransportMilestoneAt(state, event.name, event.at, {
    round: event.round,
    requestSequence,
    elapsedMs: event.elapsedMs,
    forwardingOverheadMs: event.forwardingOverheadMs,
  })

  if (event.name === 'clm_first_token_forwarded') {
    setTransportDiagnosticValue(
      state,
      'hume',
      'lastClmRequestToFirstTokenMs',
      event.elapsedMs,
    )
    setTransportDiagnosticValue(
      state,
      'hume',
      'lastClmFirstTokenForwardingOverheadMs',
      event.forwardingOverheadMs,
    )
  }
})

setCodexClmToolExecutor(async ({ customSessionId, name, args }) => {
  const state = getCallState(customSessionId)
  if (!state) {
    return {
      ok: false,
      reason: 'session_not_found',
      assistant_next_step:
        'Tell the caller the action could not be completed and continue without claiming success.',
    }
  }

  const sandboxDeliveryBlock = blockSandboxedPlaygroundDelivery(state, name)
  if (sandboxDeliveryBlock) return sandboxDeliveryBlock

  emitCallEvent(state.callControlId, {
    entry: transcriptEntry('Tool', `Tool requested: ${name}`, 'attention'),
    notice: `Tool requested: ${name}`,
  })

  const { result, afterResponse } = await executeSpeakToolCall(state, name, args)
  if (afterResponse) {
    setTimeout(() => {
      void afterResponse()
    }, 1500)
  }
  return result
})

app.use(stripBasePath)
app.set('trust proxy', true)
app.use((request, response, next) => {
  if (!shutdownStarted) {
    next()
    return
  }
  response.set('Connection', 'close').status(503).json({
    error: 'service_shutting_down',
    message: 'Speak is restarting. Retry after the service is ready.',
  })
})

function captureRawJsonBody(request, _response, buffer) {
  request.rawBody = Buffer.isBuffer(buffer) ? Buffer.from(buffer) : Buffer.from(buffer || '')
}

app.post('/api/context-files', async (request, response) => {
  try {
    const attachment = await saveContextFileFromRequest(request, {
      basePath: BASE_PATH,
    })
    response.json({ attachment })
  } catch (error) {
    response.status(413).json({
      error: error instanceof Error ? error.message : 'Context file upload failed',
    })
  }
})

app.post(
  '/api/codex-clm/chat/completions',
  express.json({ limit: '8mb' }),
  handleCodexClmChatCompletion,
)

const HERE_NOW_API_BASE = 'https://here.now'
const hereNowProxyOrigins = [
  process.env.SPEAK_HERE_NOW_PROXY_ORIGINS,
  process.env.SPEAK_FILE_WAREHOUSE_ORIGINS,
]
  .filter(Boolean)
  .join(',')
const HERE_NOW_PROXY_ALLOWED_ORIGINS = new Set([
  ...hereNowProxyOrigins
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  'http://localhost:8792',
  'http://127.0.0.1:8792',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
])

function applyHereNowProxyCors(request, response) {
  const origin = request.get('origin')
  if (HERE_NOW_PROXY_ALLOWED_ORIGINS.has(origin)) {
    response.setHeader('Access-Control-Allow-Origin', origin)
    response.setHeader('Vary', 'Origin')
  }
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
  response.setHeader(
    'Access-Control-Allow-Headers',
    'authorization,content-type,if-match,x-herenow-client',
  )
  response.setHeader('Access-Control-Max-Age', '600')
}

function validHereNowUploadUrl(value) {
  try {
    const url = new URL(String(value || ''))
    return url.protocol === 'https:' &&
      url.hostname.endsWith('.r2.cloudflarestorage.com') &&
      url.pathname.startsWith('/herenow/drives/')
  } catch {
    return false
  }
}

app.options('/api/here-now/upload-proxy', (request, response) => {
  applyHereNowProxyCors(request, response)
  response.status(204).end()
})

app.put('/api/here-now/upload-proxy', express.raw({ type: '*/*', limit: '100mb' }), async (request, response) => {
  applyHereNowProxyCors(request, response)
  const uploadUrl = request.query.url
  if (!validHereNowUploadUrl(uploadUrl)) {
    response.status(400).json({ error: 'Invalid here.now upload URL.' })
    return
  }
  try {
    const upstream = await fetch(String(uploadUrl), {
      method: 'PUT',
      headers: {
        'content-type': request.get('content-type') || 'application/octet-stream',
      },
      body: request.body,
    })
    response.status(upstream.status).send(Buffer.from(await upstream.arrayBuffer()))
  } catch (error) {
    response.status(502).json({
      error: error instanceof Error ? error.message : 'here.now upload proxy failed',
    })
  }
})

app.use(express.json({ limit: '5mb', verify: captureRawJsonBody }))

app.use('/api/here-now', async (request, response) => {
  applyHereNowProxyCors(request, response)
  if (request.method === 'OPTIONS') {
    response.status(204).end()
    return
  }

  const targetUrl = new URL(request.url || '/', HERE_NOW_API_BASE)
  if (!targetUrl.pathname.startsWith('/api/v1/')) {
    response.status(400).json({ error: 'Only here.now v1 API paths can be proxied.' })
    return
  }

  const outboundHeaders = {
    'x-herenow-client': request.get('x-herenow-client') || 'speak-here-now/proxy',
  }
  ;['authorization', 'content-type', 'if-match'].forEach((headerName) => {
    const value = request.get(headerName)
    if (value) outboundHeaders[headerName] = value
  })

  try {
    const hasBody =
      request.body &&
      typeof request.body === 'object' &&
      Object.keys(request.body).length > 0
    const upstream = await fetch(targetUrl, {
      method: request.method,
      headers: outboundHeaders,
      body: ['GET', 'HEAD'].includes(request.method) || !hasBody
        ? undefined
        : JSON.stringify(request.body),
    })
    const contentType = upstream.headers.get('content-type')
    if (contentType) response.setHeader('content-type', contentType)
    response.status(upstream.status).send(Buffer.from(await upstream.arrayBuffer()))
  } catch (error) {
    response.status(502).json({
      error: error instanceof Error ? error.message : 'here.now proxy failed',
    })
  }
})

app.get('/api/health', (_request, response) => {
  const missing = missingRuntimeEnv()
  const publicMissing = missing.map(publicRuntimeConfigName)
  const configured = missing.length === 0
  const defaultRuntimeConfig = normalizeCampaignConfig({})

  response.json({
    ok: true,
    configured,
    missing: publicMissing,
    message: configured
      ? 'Voice backend configured'
      : `Missing ${publicMissing.join(', ')}`,
    defaults: cleanObject({
      speakConfigId: defaultRuntimeConfig.humeConfigId,
      dialerProvider: defaultRuntimeConfig.dialerProvider,
      voice: defaultRuntimeConfig.voice,
      phoneCallerId: defaultRuntimeConfig.telnyxCallerId,
      smsFrom: getTelnyxSmsFrom(),
      telnyxWebhookSignatureConfigured: getTelnyxWebhookPublicKeys().length > 0,
      telnyxWebhookSignatureRequired: telnyxWebhookSignatureRequired(),
      workspaceEmailConfigured: isEmailConfigured(),
      workspaceEmailReadConfigured: workspaceEmailGmailReadConfigured(),
      workspaceEmailSourceReadConfigured: workspaceEmailSourceReadConfigured(),
      workspaceEmailSendConfigured: workspaceEmailGmailAuthConfigured(),
      speakLinkConfigured: Boolean(getSpeakLinkUrl()),
      phoneConnectionId: defaultRuntimeConfig.telnyxConnectionId,
      phoneStreamCodec: defaultRuntimeConfig.telnyxStreamCodec,
      phoneMinimumHangupMs: TELNYX_MIN_HANGUP_DURATION_MS,
      sampleRate: defaultRuntimeConfig.sampleRate,
      phoneOutputGain: defaultRuntimeConfig.phoneOutputGain,
      phoneOutputPeak: defaultRuntimeConfig.phoneOutputPeak,
      endOfTurnSilenceMs: defaultRuntimeConfig.endOfTurnSilenceMs,
      speechDetectionThreshold: defaultRuntimeConfig.speechDetectionThreshold,
      prefixPaddingMs: defaultRuntimeConfig.prefixPaddingMs,
      minInterruptionMs: defaultRuntimeConfig.minInterruptionMs,
      verboseTranscription: defaultRuntimeConfig.verboseTranscription,
      useConfigPrompt: boolEnv('HUME_USE_CONFIG_PROMPT', false),
      useConfigTools: boolEnv('HUME_USE_CONFIG_TOOLS', false),
      autoStartGreeting: boolEnv('HUME_AUTO_START_GREETING', false),
      temporaryAgentMode: TEMP_AGENT_MODE || null,
    }),
    codexAuth: {
      clmConfigured: Boolean(getCodexClmPublicUrl() && process.env.CODEX_CLM_API_KEY),
      defaultModel: getCodexAuthModel(),
      publicEndpoint: Boolean(getCodexClmPublicUrl()),
    },
    delivery: {
      smsConfigured: isSmsConfigured(),
      linkConfigured: Boolean(getSpeakLinkUrl()),
      telnyxWebhookSignatureConfigured: getTelnyxWebhookPublicKeys().length > 0,
      telnyxWebhookSignatureRequired: telnyxWebhookSignatureRequired(),
      emailConfigured: isEmailConfigured(),
      emailAuthAccountConfigured: workspaceEmailGmailAuthConfigured(),
      emailSendAuthAccountConfigured: workspaceEmailGmailAuthConfigured(),
      emailReadAuthAccountConfigured: workspaceEmailGmailReadConfigured(),
      emailSourceReadConfigured: workspaceEmailSourceReadConfigured(),
      smsFrom: getTelnyxSmsFrom() || null,
      emailFromConfigured: Boolean(getWorkspaceEmailAccount()),
      emailSendAsConfigured: workspaceEmailSendAsConfigured(),
    },
    optimizations: {
      codec: defaultRuntimeConfig.telnyxStreamCodec,
      sampleRate: defaultRuntimeConfig.sampleRate,
      phoneMinimumHangupMs: TELNYX_MIN_HANGUP_DURATION_MS,
      phoneOutputGain: defaultRuntimeConfig.phoneOutputGain,
      phoneOutputPeak: defaultRuntimeConfig.phoneOutputPeak,
      verboseTranscription: defaultRuntimeConfig.verboseTranscription,
      endOfTurnSilenceMs: defaultRuntimeConfig.endOfTurnSilenceMs,
      speechDetectionThreshold: defaultRuntimeConfig.speechDetectionThreshold,
      prefixPaddingMs: defaultRuntimeConfig.prefixPaddingMs,
      minInterruptionMs: defaultRuntimeConfig.minInterruptionMs,
    },
  })
})

app.get('/api/phone-provider/options', async (_request, response) => {
  try {
    response.json(await listPhoneProviderOptions())
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : 'Phone provider options failed',
    })
  }
})

app.get('/api/context-files/:fileId/download', async (request, response) => {
  try {
    const stored = await readContextFile(request.params.fileId)
    if (!stored) {
      response.status(404).json({ error: 'Context file not found' })
      return
    }
    response.type(stored.metadata.type || 'application/octet-stream')
    response.download(stored.filePath, stored.metadata.name || 'context-file')
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : 'Context file download failed',
    })
  }
})

app.delete('/api/context-files/:fileId', async (request, response) => {
  try {
    const deleted = await deleteContextFile(request.params.fileId)
    if (!deleted) {
      response.status(404).json({ error: 'Context file not found' })
      return
    }
    response.json({ deleted: true })
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : 'Context file delete failed',
    })
  }
})

app.get(['/api/agent/capabilities', '/.well-known/speak-agent.json'], (_request, response) => {
  response.json(
    buildSpeakAgentContract({
      basePath: BASE_PATH,
      publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
    }),
  )
})

app.get('/api/agent/openapi.json', (_request, response) => {
  response.json(
    buildSpeakOpenApiDocument({
      basePath: BASE_PATH,
      publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
    }),
  )
})

app.get('/api/agent/acp', (_request, response) => {
  response.json(
    buildSpeakAcpManifest({
      basePath: BASE_PATH,
      publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
    }),
  )
})

app.get('/api/agent/chatgpt-app.json', (_request, response) => {
  response.json(
    buildSpeakChatGptAppManifest({
      basePath: BASE_PATH,
      publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
    }),
  )
})

app.get('/api/agent/generative-ui.json', (_request, response) => {
  response.json(
    buildSpeakGenerativeUiManifest({
      basePath: BASE_PATH,
      publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
    }),
  )
})

app.get('/api/agent/ui-adapter-kit.json', (_request, response) => {
  response.json(
    buildSpeakUiAdapterKit({
      basePath: BASE_PATH,
      publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
    }),
  )
})

app.get('/api/agent/ui-snapshot.json', async (request, response) => {
  try {
    const surface =
      request.query.surface === 'configs'
        ? 'configs'
        : request.query.surface === 'library'
          ? 'library'
          : 'dialer'
    const parsedLimit = Number(request.query.limit || 12)
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(50, Math.max(1, Math.floor(parsedLimit)))
      : 12
    const authorizationMode =
      typeof request.query.authorizationMode === 'string'
        ? request.query.authorizationMode
        : undefined
    response.json(
      await renderSpeakUiSnapshot({
        apiRoot: `http://127.0.0.1:${PORT}${BASE_PATH}/api`,
        basePath: BASE_PATH,
        publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
        surface,
        limit,
        authorizationMode,
      }),
    )
  } catch (error) {
    response.status(500).json({
      error: 'Failed to render Speak UI snapshot',
      message: error instanceof Error ? error.message : String(error),
    })
  }
})

app.post('/api/agent/actions/:actionId/invoke', async (request, response) => {
  const result = await invokeSpeakAgentAction({
    contract: buildSpeakAgentContract({
      basePath: BASE_PATH,
      publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
    }),
    appRoot: `http://127.0.0.1:${PORT}${BASE_PATH}`,
    actionId: request.params.actionId,
    path: request.body?.path,
    query: request.body?.query,
    body: request.body?.body,
    authorizationMode: request.body?.authorizationMode,
  })
  response.status(result.transport?.status || (result.ok ? 200 : 400)).json(result)
})

app.post('/api/operator-chat/turns', async (request, response) => {
  try {
    const result = await buildOperatorChatTurn({
      contract: buildSpeakAgentContract({
        basePath: BASE_PATH,
        publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
      }),
      appRoot: `http://127.0.0.1:${PORT}${BASE_PATH}`,
      authorizationMode: request.body?.authorizationMode,
      context: request.body?.context || {},
      invokeAction: invokeSpeakAgentAction,
      message: request.body?.message,
      surface: request.body?.surface,
    })
    response.status(result.ok ? 200 : 400).json(result)
  } catch (error) {
    response.status(500).json({
      schemaVersion: 'speak.operator-chat.v1',
      ok: false,
      error: 'operator_chat_failed',
      assistantMessage:
        error instanceof Error ? error.message : 'Operator chat turn failed.',
    })
  }
})

app.get('/api/smart-config/conversations', async (request, response) => {
  const access = assertSmartConfigAccess(request)
  if (!access.ok) {
    response.status(access.status).json({
      schemaVersion: SMART_CONFIG_SCHEMA_VERSION,
      ok: false,
      error: access.error,
      message: access.message,
      loginUrl: access.loginUrl,
    })
    return
  }

  try {
    response.json(
      await listSmartConfigConversations({
        profileId: String(request.query.profileId || ''),
      }),
    )
  } catch (error) {
    response.status(500).json({
      schemaVersion: SMART_CONFIG_SCHEMA_VERSION,
      ok: false,
      error: 'smart_config_conversation_list_failed',
      message:
        error instanceof Error
          ? error.message
          : 'Smart Config conversations failed.',
    })
  }
})

app.get('/api/smart-config/conversations/:conversationId', async (request, response) => {
  const access = assertSmartConfigAccess(request)
  if (!access.ok) {
    response.status(access.status).json({
      schemaVersion: SMART_CONFIG_SCHEMA_VERSION,
      ok: false,
      error: access.error,
      message: access.message,
      loginUrl: access.loginUrl,
    })
    return
  }

  try {
    const result = await readSmartConfigConversation({
      conversationId: request.params.conversationId,
    })
    response.status(result.ok ? 200 : 404).json(result)
  } catch (error) {
    response.status(500).json({
      schemaVersion: SMART_CONFIG_SCHEMA_VERSION,
      ok: false,
      error: 'smart_config_conversation_read_failed',
      message:
        error instanceof Error
          ? error.message
          : 'Smart Config conversation read failed.',
    })
  }
})

app.post('/api/smart-config/conversations', async (request, response) => {
  const access = assertSmartConfigAccess(request)
  if (!access.ok) {
    response.status(access.status).json({
      schemaVersion: SMART_CONFIG_SCHEMA_VERSION,
      ok: false,
      error: access.error,
      message: access.message,
      loginUrl: access.loginUrl,
    })
    return
  }

  try {
    response.json(
      await createSmartConfigConversation({
        profileId: request.body?.profileId,
        profileName: request.body?.profileName,
      }),
    )
  } catch (error) {
    response.status(error?.status || 500).json({
      schemaVersion: SMART_CONFIG_SCHEMA_VERSION,
      ok: false,
      error: error?.code || 'smart_config_conversation_create_failed',
      message:
        error instanceof Error
          ? error.message
          : 'Smart Config conversation creation failed.',
    })
  }
})

app.post('/api/smart-config/turns/stream', async (request, response) => {
  const access = assertSmartConfigAccess(request)
  if (!access.ok) {
    response.status(access.status).json({
      schemaVersion: SMART_CONFIG_SCHEMA_VERSION,
      ok: false,
      error: access.error,
      message: access.message,
      loginUrl: access.loginUrl,
    })
    return
  }

  await streamSmartConfigTurn({
    conversationId: request.body?.conversationId,
    expectedTurnId: request.body?.expectedTurnId,
    message: request.body?.message,
    profileId: request.body?.profileId,
    response,
    steer: Boolean(request.body?.steer),
  })
})

app.get('/api/smart-config/session', (request, response) => {
  response.json(smartConfigSessionStatus(request))
})

app.post('/api/smart-config/logout', (request, response) => {
  clearSmartConfigSession({ request, response })
})

app.get('/api/smart-config/oauth/start', (request, response) => {
  startSmartConfigGoogleOAuth({ request, response, basePath: BASE_PATH })
})

app.get('/api/smart-config/oauth/callback', async (request, response) => {
  try {
    await finishSmartConfigGoogleOAuth({
      request,
      response,
      basePath: BASE_PATH,
    })
  } catch (error) {
    response.status(500).send(
      error instanceof Error ? error.message : 'Google sign-in failed.',
    )
  }
})

app.get('/api/agent/ag-ui.json', (_request, response) => {
  response.json(
    buildSpeakAgUiManifest({
      basePath: BASE_PATH,
      publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
    }),
  )
})

app.get('/api/agent/mcp-ui.json', (_request, response) => {
  response.json(
    buildSpeakMcpUiManifest({
      basePath: BASE_PATH,
      publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
    }),
  )
})

app.get('/api/agent/a2ui.json', (_request, response) => {
  response.json(
    buildSpeakA2uiManifest({
      basePath: BASE_PATH,
      publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
    }),
  )
})

app.get(
  [
    '/api/agent/a2a-agent-card.json',
    '/.well-known/agent-card.json',
    '/.well-known/agent.json',
  ],
  (_request, response) => {
    response
      .set('Cache-Control', 'public, max-age=300')
      .json(
        buildSpeakA2aAgentCard({
          basePath: BASE_PATH,
          publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
        }),
      )
  },
)

app.get('/api/agent/readiness.json', (_request, response) => {
  response.json(
    buildSpeakAgentReadinessReport({
      basePath: BASE_PATH,
      publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
    }),
  )
})

app.get('/api/agent/ai-sdk.json', (_request, response) => {
  response.json(
    buildSpeakAiSdkManifest({
      basePath: BASE_PATH,
      publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
    }),
  )
})

app.get('/api/agent/json-render.json', (_request, response) => {
  response.json(
    buildSpeakJsonRenderManifest({
      basePath: BASE_PATH,
      publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
    }),
  )
})

app.get('/api/agent/copilotkit.json', (_request, response) => {
  response.json(
    buildSpeakCopilotKitManifest({
      basePath: BASE_PATH,
      publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
    }),
  )
})

app.get('/api/agent/widgets/speak-operator.html', (_request, response) => {
  response
    .type('text/html; charset=utf-8')
    .send(
      speakWidgetDocument({
        basePath: BASE_PATH,
        publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
      }),
    )
})

app.get('/api/agent/host-client.mjs', (_request, response) => {
  response
    .type('text/javascript; charset=utf-8')
    .sendFile('speak-agent-client.mjs', {
      root: path.resolve(__dirname, '..', 'agent/host-client'),
    })
})

app.options('/mcp', handleSpeakMcpOptions)

app.all('/mcp', async (request, response) => {
  await handleSpeakMcpRequest(request, response, {
    apiRoot: `http://127.0.0.1:${PORT}${BASE_PATH}/api`,
    basePath: BASE_PATH,
    publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
  })
})

app.get('/api/workspace', async (_request, response) => {
  try {
    response.json(publicSpeakPayload(await workspaceSnapshot()))
  } catch (error) {
    sendWorkspaceError(response, error)
  }
})

app.get('/api/search', async (request, response) => {
  try {
    response.json(publicSpeakPayload(await searchWorkspace(request.query || {})))
  } catch (error) {
    sendWorkspaceError(response, error)
  }
})

app.get('/api/personal-phone/contacts', async (_request, response) => {
  try {
    response.json(publicSpeakPayload(await personalPhoneContactsStatus()))
  } catch (error) {
    sendWorkspaceError(response, error)
  }
})

app.post('/api/personal-phone/contacts/sync', async (_request, response) => {
  try {
    response.json(publicSpeakPayload(await syncPersonalPhoneContactsToWorkspace()))
  } catch (error) {
    sendWorkspaceError(response, error)
  }
})

app.post('/api/personal-phone/inbound/handoffs', async (request, response) => {
  const handoffSecret = getPersonalPhoneSpeakHandoffSecret()
  if (!handoffSecret) {
    response.status(503).json({
      schemaVersion: PERSONAL_PHONE_HANDOFF_SCHEMA,
      error: 'personal_phone_handoff_not_configured',
    })
    return
  }
  if (!personalPhoneInboundBearerAuthorized(request.get('authorization'), handoffSecret)) {
    response.status(401).json({
      schemaVersion: PERSONAL_PHONE_HANDOFF_SCHEMA,
      error: 'personal_phone_handoff_unauthorized',
    })
    return
  }

  const normalized = normalizePersonalPhoneInboundHandoffRequest(request.body, {
    expectedDid: personalPhoneTelnyxDid(),
  })
  if (!normalized.ok) {
    response.json(personalPhoneVoicemailResponse(normalized.reason))
    return
  }

  const handoff = normalized.value
  const existing = personalPhoneInboundHandoffs.findByEvent(
    handoff.eventId,
    handoff.callControlId,
  )
  if (existing) {
    const existingResponse = personalPhoneInboundHandoffs.publicDecisionResponse(existing)
    if (existingResponse.decision === 'connect') {
      prepareProvisionalVoiceSession({
        key: existing.correlationId,
        requireBinding: true,
        state: createPersonalPhoneInboundProvisionalState(existing),
      })
    } else {
      cancelProvisionalVoiceSession(
        existing.correlationId,
        'voicemail_or_ineligible',
      )
    }
    response.json(existingResponse)
    return
  }

  try {
    const registryReadiness = personalPhoneInboundHandoffs.readiness()
    if (!registryReadiness.ready) {
      response.json(
        personalPhoneVoicemailResponse(
          'handoff_persistence_unavailable',
          personalPhoneInboundCorrelationId(handoff),
        ),
      )
      return
    }

    const workspace = await workspaceSnapshot()
    const streamUrl = getStreamUrl()
    const decision = resolvePersonalPhoneInboundEligibility({
      handoff,
      leads: workspace.leads,
      profiles: workspace.profiles,
      smartViews: workspace.smartViews,
      sourceId: personalPhoneContactSourceId(),
      profileReady: ({ runtimeConfig }) => {
        const blockers = missingForVoiceSession(runtimeConfig)
        if (!isSecurePersonalPhoneStreamUrl(streamUrl)) blockers.push('VOICE_STREAM_WSS_URL')
        return { ready: blockers.length === 0, blockers }
      },
    })
    if (decision.decision !== 'connect') {
      cancelProvisionalVoiceSession(
        decision.correlationId,
        'voicemail_or_ineligible',
      )
      const record = personalPhoneInboundHandoffs.recordVoicemail({ handoff, decision })
      response.json(
        record
          ? personalPhoneInboundHandoffs.publicDecisionResponse(record)
          : personalPhoneVoicemailResponse(
              'handoff_persistence_unavailable',
              decision.correlationId,
            ),
      )
      return
    }

    const runtimeContext = {
      lead: decision.lead,
      profile: decision.profile,
      profileContext: decision.profile.context || {},
    }
    let runtimeConfig = normalizeCampaignConfig({
      ...decision.runtimeConfig,
      phoneAudioMode: 'legacy',
      telnyxStreamCodec: 'PCMU',
      sampleRate: 8000,
    })
    try {
      runtimeConfig = await ensureVoiceRuntimeReady(runtimeConfig, {
        syncProvider: isInworldRuntime(runtimeConfig) || isXaiRuntime(runtimeConfig),
      })
    } catch {
      const unavailableDecision = {
        ...decision,
        decision: 'voicemail',
        reason: 'profile_not_ready',
      }
      const record = personalPhoneInboundHandoffs.recordVoicemail({
        handoff,
        decision: unavailableDecision,
      })
      response.json(
        record
          ? personalPhoneInboundHandoffs.publicDecisionResponse(record)
          : personalPhoneVoicemailResponse(
              'handoff_persistence_unavailable',
              decision.correlationId,
            ),
      )
      return
    }
    runtimeConfig.profileContext = runtimeContext.profileContext
    runtimeConfig.autoStartGreeting = true
    const record = personalPhoneInboundHandoffs.prepare({
      handoff,
      decision,
      lead: runtimeContext.lead,
      profile: decision.profile,
      runtimeConfig,
      runtimeContext,
      streamUrl,
    })
    if (record) {
      prepareProvisionalVoiceSession({
        key: record.correlationId,
        requireBinding: true,
        state: createPersonalPhoneInboundProvisionalState(record),
      })
    }
    response.json(
      record
        ? personalPhoneInboundHandoffs.publicConnectResponse(record)
        : personalPhoneVoicemailResponse(
            'handoff_persistence_unavailable',
            decision.correlationId,
          ),
    )
  } catch (error) {
    console.warn(
      'Personal Phone inbound handoff failed:',
      error instanceof Error ? error.message : String(error),
    )
    response.status(500).json({
      schemaVersion: PERSONAL_PHONE_HANDOFF_SCHEMA,
      error: 'personal_phone_handoff_failed',
    })
  }
})

app.get('/api/personal-phone/inbound/readiness', async (_request, response) => {
  try {
    response.json(await personalPhoneInboundReadiness())
  } catch (error) {
    response.status(500).json({
      schemaVersion: PERSONAL_PHONE_READINESS_SCHEMA,
      ready: false,
      error: 'personal_phone_inbound_readiness_failed',
    })
  }
})

app.post(
  '/api/personal-phone/inbound/handoffs/:correlationId/resolve',
  async (request, response) => {
    const handoffSecret = getPersonalPhoneSpeakHandoffSecret()
    if (!handoffSecret) {
      response.status(503).json({
        schemaVersion: PERSONAL_PHONE_RESOLVE_SCHEMA,
        error: 'personal_phone_handoff_not_configured',
      })
      return
    }
    if (!personalPhoneInboundBearerAuthorized(request.get('authorization'), handoffSecret)) {
      response.status(401).json({
        schemaVersion: PERSONAL_PHONE_RESOLVE_SCHEMA,
        error: 'personal_phone_handoff_unauthorized',
      })
      return
    }

    const normalized = normalizePersonalPhoneInboundResolveRequest(request.body, {
      correlationId: request.params.correlationId,
    })
    if (!normalized.ok) {
      response.json(personalPhoneVoicemailResolution(request.params.correlationId))
      return
    }

    const resolution = personalPhoneInboundHandoffs.resolve(normalized.value)
    cancelProvisionalVoiceSession(
      normalized.value.correlationId,
      'handoff_resolved',
    )
    response.json(resolution)
  },
)

app.get('/api/calltools/campaign-contacts', async (request, response) => {
  try {
    const profile = profileWithCallToolsSourceOverride(
      await resolveCallToolsSourceProfileInput(request.query || {}),
      request.query || {},
    )
    response.json(publicSpeakPayload(await callToolsCampaignContactsStatus(profile)))
  } catch (error) {
    response.status(error.statusCode || error.status || 502).json({
      error: error instanceof Error ? error.message : 'CallTools campaign contacts status failed',
      code: error.code || 'calltools_campaign_contacts_status_failed',
    })
  }
})

app.post('/api/calltools/campaign-contacts/sync', async (request, response) => {
  try {
    const profile = profileWithCallToolsSourceOverride(
      await resolveCallToolsSourceProfileInput(request.body || {}),
      request.body || {},
    )
    response.json(
      publicSpeakPayload(await syncCallToolsCampaignContactsToWorkspace({ profile })),
    )
  } catch (error) {
    response.status(error.statusCode || error.status || 502).json({
      error: error instanceof Error ? error.message : 'CallTools campaign contacts sync failed',
      code: error.code || 'calltools_campaign_contacts_sync_failed',
    })
  }
})

app.get('/api/dialer-state', async (_request, response) => {
  try {
    response.json(publicSpeakPayload(await readWorkspaceDialerState()))
  } catch (error) {
    sendWorkspaceError(response, error)
  }
})

app.patch('/api/dialer-state', async (request, response) => {
  try {
    response.json(
      publicSpeakPayload(await patchWorkspaceDialerState(request.body?.dialerState || request.body)),
    )
  } catch (error) {
    sendWorkspaceError(response, error)
  }
})

app.get('/api/leads', async (request, response) => {
  try {
    response.json(await listWorkspaceLeads(request.query || {}))
  } catch (error) {
    sendWorkspaceError(response, error)
  }
})

app.put('/api/leads', async (request, response) => {
  try {
    response.json(
      await replaceWorkspaceLeads({
        leads: request.body?.leads,
        deletedLeadIds: request.body?.deletedLeadIds,
        deletedLeadFingerprints: request.body?.deletedLeadFingerprints,
      }),
    )
  } catch (error) {
    sendWorkspaceError(response, error)
  }
})

app.post('/api/leads', async (request, response) => {
  try {
    response.json({ lead: await createWorkspaceLead(request.body?.lead || request.body) })
  } catch (error) {
    sendWorkspaceError(response, error)
  }
})

app.post('/api/leads/import', async (request, response) => {
  try {
    response.json(await importWorkspaceLeads(request.body?.leads))
  } catch (error) {
    sendWorkspaceError(response, error)
  }
})

app.get('/api/smart-views', async (_request, response) => {
  try {
    response.json(publicSpeakPayload(await listWorkspaceSmartViews()))
  } catch (error) {
    sendWorkspaceError(response, error)
  }
})

app.post('/api/smart-views', async (request, response) => {
  try {
    response.json(
      publicSpeakPayload(
        await upsertWorkspaceSmartView(request.body?.smartView || request.body),
      ),
    )
  } catch (error) {
    sendWorkspaceError(response, error)
  }
})

app.post('/api/smart-views/import', async (request, response) => {
  try {
    response.json(
      publicSpeakPayload(
        await importWorkspaceSmartViewLeads({
          name: request.body?.name,
          leads: request.body?.leads,
        }),
      ),
    )
  } catch (error) {
    sendWorkspaceError(response, error)
  }
})

app.delete('/api/smart-views/:smartViewId', async (request, response) => {
  try {
    response.json(
      publicSpeakPayload(await deleteWorkspaceSmartView(request.params.smartViewId)),
    )
  } catch (error) {
    sendWorkspaceError(response, error)
  }
})

app.patch('/api/leads/:leadId', async (request, response) => {
  try {
    response.json({
      lead: await patchWorkspaceLead(request.params.leadId, request.body?.patch || request.body),
    })
  } catch (error) {
    sendWorkspaceError(response, error)
  }
})

app.delete('/api/leads/:leadId', async (request, response) => {
  try {
    response.json(await deleteWorkspaceLeads([request.params.leadId]))
  } catch (error) {
    sendWorkspaceError(response, error)
  }
})

app.post('/api/leads/bulk-status', async (request, response) => {
  try {
    response.json(
      await bulkPatchWorkspaceLeads(request.body?.ids, {
        status: request.body?.status,
      }),
    )
  } catch (error) {
    sendWorkspaceError(response, error)
  }
})

app.post('/api/leads/bulk-delete', async (request, response) => {
  try {
    response.json(await deleteWorkspaceLeads(request.body?.ids))
  } catch (error) {
    sendWorkspaceError(response, error)
  }
})

app.get('/api/profiles', async (_request, response) => {
  response.set('Cache-Control', 'no-store')
  try {
    response.json(publicSpeakPayload(await listWorkspaceProfiles()))
  } catch (error) {
    sendWorkspaceError(response, error)
  }
})

app.put('/api/profiles', async (request, response) => {
  try {
    response.json(
      publicSpeakPayload(
        await replaceWorkspaceProfiles({
          profiles: request.body?.profiles,
          activeProfileId: request.body?.activeProfileId,
          preserveActiveProfile: true,
        }),
      ),
    )
  } catch (error) {
    sendWorkspaceError(response, error)
  }
})

app.post('/api/profiles', async (request, response) => {
  try {
    response.json(
      publicSpeakPayload({
        profile: await upsertWorkspaceProfile(request.body?.profile || request.body),
      }),
    )
  } catch (error) {
    sendWorkspaceError(response, error)
  }
})

app.put('/api/profiles/active', async (request, response) => {
  try {
    response.json(
      publicSpeakPayload(
        await setActiveWorkspaceProfile(request.body?.id || request.body?.activeProfileId),
      ),
    )
  } catch (error) {
    sendWorkspaceError(response, error)
  }
})

app.delete('/api/profiles/:profileId', async (request, response) => {
  try {
    response.json(publicSpeakPayload(await deleteWorkspaceProfile(request.params.profileId)))
  } catch (error) {
    sendWorkspaceError(response, error)
  }
})

app.get('/api/calltools/status', async (_request, response) => {
  try {
    const options = await listCallToolsOptions()
    const mediaGatewayProfiles = callToolsGatewaySummaries()
    const mediaGatewayConnectionCount = mediaGatewayProfiles.length
    const mediaGatewayHealthyConnectionCount =
      mediaGatewayProfiles.filter((item) => item.healthy).length
    response.json(
      publicSpeakPayload({
        configured: options.configured,
        baseUrl: options.baseUrl,
        mediaGatewayConfigured: options.mediaGatewayConfigured,
        mediaGatewayUrlConfigured: options.mediaGatewayUrlConfigured,
        mediaGatewayConnected: mediaGatewayHealthyConnectionCount > 0,
        mediaGatewayConnectionCount,
        mediaGatewayHealthyConnectionCount,
        mediaGatewayHeartbeatStaleAfterMs: CALLTOOLS_GATEWAY_STALE_AFTER_MS,
        mediaGatewayProfiles,
        counts: {
          users: options.users.length,
          phones: options.phones.length,
          queues: options.queues.length,
          campaigns: options.campaigns.length,
          callerIds: options.callerIds.length,
          webCallbacks: options.webCallbacks.length,
        },
      }),
    )
  } catch (error) {
    response.status(error.status || 502).json({
      error: error instanceof Error ? error.message : 'CallTools status failed',
      code: error.code || 'calltools_status_failed',
    })
  }
})

app.get('/api/calltools/options', async (_request, response) => {
  try {
    const options = await listCallToolsOptions()
    const mediaGatewayProfiles = callToolsGatewaySummaries()
    const mediaGatewayConnectionCount = mediaGatewayProfiles.length
    const mediaGatewayHealthyConnectionCount =
      mediaGatewayProfiles.filter((item) => item.healthy).length
    response.json(
      publicSpeakPayload({
        ...options,
        mediaGatewayConnected: mediaGatewayHealthyConnectionCount > 0,
        mediaGatewayConnectionCount,
        mediaGatewayHealthyConnectionCount,
        mediaGatewayHeartbeatStaleAfterMs: CALLTOOLS_GATEWAY_STALE_AFTER_MS,
        mediaGatewayProfiles,
      }),
    )
  } catch (error) {
    response.status(error.status || 502).json({
      error: error instanceof Error ? error.message : 'CallTools options failed',
      code: error.code || 'calltools_options_failed',
    })
  }
})

app.get('/api/calltools/readiness', async (request, response) => {
  try {
    const profile = await resolveCallToolsSourceProfileInput({
      profileId: request.query?.profileId,
      profileName: request.query?.profileName,
    })
    const config = normalizeCampaignConfig(profile.config || {})
    const gatewayStatus = callToolsGatewayStatusForProfile(profile, config.calltoolsAgentBinding)
    const readiness = await auditCallToolsReadiness({
      profile: {
        ...profile,
        config,
      },
      gatewayStatus,
    })
    const dutyMonitor = await callToolsDutyMonitor.publicState(profile.id)
    const callWatchdog = await callToolsCallWatchdog.publicState()
    response.json(publicSpeakPayload({
      ...readiness,
      bindingResolution: profile.calltoolsBindingResolution,
      selectedVoiceProfile: { id: profile.id, name: profile.name },
      dutyMonitor,
      callWatchdog,
    }))
  } catch (error) {
    response.status(error.status || 502).json({
      error: error instanceof Error ? error.message : 'CallTools readiness failed',
      code: error.code || 'calltools_readiness_failed',
    })
  }
})

app.get('/api/calltools/watchdog', async (_request, response) => {
  try {
    response.json(publicSpeakPayload(await callToolsCallWatchdog.publicState()))
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : 'CallTools watchdog status failed',
      code: 'calltools_watchdog_status_failed',
    })
  }
})

app.post('/api/calltools/agent-session', async (request, response) => {
  try {
    const rawReady = request.body?.ready ?? request.body?.targetReady
    const mode = safeLeadText(request.body?.mode).toLowerCase()
    const targetReady = !(
      rawReady === false ||
      rawReady === 'false' ||
      mode === 'not-ready' ||
      mode === 'paused'
    )
    const persistedDutyState = targetReady ? null : await readWorkspaceCallToolsDuty()
    const persistedDuty =
      persistedDutyState?.calltoolsDuty || persistedDutyState?.dialerState?.calltoolsDuty || {}
    const expectedLeaseId = safeLeadText(request.body?.expectedLeaseId)
    if (!targetReady && isActiveCallToolsDuty(persistedDuty)) {
      assertCallToolsDutyReleaseScope(persistedDuty, request.body || {})
    }
    const releasingActiveDuty = !targetReady && isActiveCallToolsDuty(persistedDuty)
    const workspaceProfiles = releasingActiveDuty ? await listWorkspaceProfiles() : null
    const leasedProfile = releasingActiveDuty
      ? workspaceProfiles?.profiles?.find((item) => item.id === persistedDuty.profileId) || null
      : null
    const profile = releasingActiveDuty
      ? {
          ...(leasedProfile || {}),
          id: safeLeadText(persistedDuty.profileId),
          name: safeLeadText(leasedProfile?.name || persistedDuty.profileId || 'CallTools agent'),
          config: normalizeCampaignConfig({
            ...(leasedProfile?.config || {}),
            dialerProvider: 'calltools',
            calltoolsAgentBinding: normalizeDutyBinding(persistedDuty.binding),
          }),
        }
      : await resolveCallToolsSourceProfileInput(request.body || {})
    const sourceConfig = profile.config || request.body?.config || {}
    let config = normalizeCampaignConfig({
      ...sourceConfig,
      agentProfileId: profile.id || sourceConfig.agentProfileId,
      agentProfileName: profile.name || sourceConfig.agentProfileName,
    })
    config.profileContext = profile.context || config.profileContext
    const apply = Boolean(request.body?.apply && request.body?.confirmAgentSession)
    const contactSourceKey = safeLeadText(request.body?.contactSourceKey)
    const dialerSourceId = /^calltools(?:$|::)/.test(contactSourceKey)
      ? `source:${contactSourceKey}`
      : ''
    const requireCampaignReady = Boolean(
      request.body?.requireCampaignReady === true ||
        request.body?.requireCampaignReady === 'true' ||
        request.body?.requireTopLevelReady === true ||
        request.body?.requireTopLevelReady === 'true' ||
        mode === 'campaign-follow' ||
        mode === 'campaign',
    )
    const binding = releasingActiveDuty
      ? normalizeDutyBinding(persistedDuty.binding)
      : {
          ...(config.calltoolsAgentBinding || {}),
          appUserId:
            request.body?.appUserId ||
            config.calltoolsAgentBinding?.appUserId ||
            config.calltoolsAgentBinding?.userId,
          campaignId:
            request.body?.campaignId || config.calltoolsAgentBinding?.campaignId,
        }
    let gatewayRegistration = null
    const preflightAgentSession = targetReady && apply
      ? async ({ binding: frozenBinding = binding, duty = {} } = {}) => {
          try {
            config = await ensureVoiceRuntimeReady(config, {
              codexReadiness: callToolsCodexReadinessRefreshOptions(),
            })
          } catch (error) {
            callToolsVoiceStandby.cancel('voice_runtime_unavailable')
            throw error
          }
          config.profileContext = profile.context || config.profileContext
          return assertCallToolsSeatClaimAvailable(profile, frozenBinding, {
            leaseId: duty.leaseId,
          })
        }
      : undefined
    const prepareAgentSession = targetReady && apply
      ? async () => {
          if (profile.id) await setActiveWorkspaceProfile(profile.id)
          gatewayRegistration = await setCallToolsGatewayRegistration(
            profile,
            binding,
            true,
          )
          await bindCallToolsGatewayToProfile(
            {
              ...profile,
              config,
            },
            binding,
          )
        }
      : undefined
    const mutateAgentSession = async (frozenBinding = binding, dutyContext = {}) => {
      const session = await ensureCallToolsAgentSessionReadiness({
        binding: frozenBinding,
        agentStatusId: request.body?.agentStatusId || request.body?.statusId,
        webPhoneStatus: request.body?.webPhoneStatus || 'Registered',
        ready: targetReady,
        apply,
        requireCampaignReady,
      })
      if (apply && !targetReady && session?.ok && session?.after?.ready === false) {
        gatewayRegistration = await setCallToolsGatewayRegistration(
          { id: safeLeadText(dutyContext.profileId || profile.id) },
          frozenBinding,
          false,
        )
      }
      return session
    }
    if (apply && !targetReady && releasingActiveDuty) {
      callToolsVoiceStandby.cancel('unavailable')
    }
    const result = apply
      ? await callToolsDutyMonitor.runAgentSessionMutation({
          binding,
          campaignFollow:
            requireCampaignReady || mode === 'campaign-follow' || mode === 'campaign',
          dialerSourceId,
          expectedLeaseId,
          mutate: mutateAgentSession,
          preflight: preflightAgentSession,
          prepare: prepareAgentSession,
          profileId: profile.id,
          proveUnavailable: !targetReady
            ? ({ binding: frozenBinding }) =>
                readCallToolsDutyStatus({
                  binding: frozenBinding,
                  includeSeatClaimProof: true,
                })
            : undefined,
          targetReady,
        })
      : {
          duty: null,
          session: await mutateAgentSession(),
        }
    if (
      apply &&
      targetReady &&
      result.session?.ok &&
      result.session?.after?.ready === true &&
      isActiveCallToolsDuty(result.duty)
    ) {
      ensureCallToolsStandbyVoiceSession({
        binding: result.duty.binding,
        config,
        leaseId: result.duty.leaseId,
        profile: { ...profile, config },
      })
    }
    response.json(
      publicSpeakPayload({
        ...result.session,
        selectedVoiceProfile: { id: profile.id, name: profile.name },
        bindingResolution: profile.calltoolsBindingResolution,
        gatewayRegistration,
        dutyMonitor: await callToolsDutyMonitor.publicState(profile.id),
      }),
    )
  } catch (error) {
    response.status(error.status || 502).json({
      error: error instanceof Error ? error.message : 'CallTools agent session failed',
      code: error.code || 'calltools_agent_session_failed',
    })
  }
})

app.post('/api/calltools/verify-agent', async (request, response) => {
  try {
    const profile = await resolveCallToolsSourceProfileInput(request.body)
    const verification = await verifyCallToolsAgentBinding(profile.config || profile)
    const gatewayStatus = callToolsGatewayStatusForProfile(profile, verification.binding)
    response.json(
      publicSpeakPayload({
        ...verification,
        selectedVoiceProfile: { id: profile.id, name: profile.name },
        bindingResolution: profile.calltoolsBindingResolution,
        mediaGatewayConnected: gatewayStatus.connected,
        mediaGatewayConnectionCount: gatewayStatus.connectionCount,
        mediaGatewayProfile: gatewayStatus.gateway,
        binding: {
          ...verification.binding,
          mediaGatewayStatus: gatewayStatus.connected
            ? 'registered'
            : verification.binding?.mediaGatewayStatus || gatewayStatus.status,
        },
      }),
    )
  } catch (error) {
    response.status(error.status || 502).json({
      error: error instanceof Error ? error.message : 'CallTools verification failed',
      code: error.code || 'calltools_verification_failed',
    })
  }
})

app.post('/api/calltools/provision-agent', async (request, response) => {
  try {
    const profile = await resolveCallToolsProfileInput(request.body)
    const apply = Boolean(request.body?.apply && request.body?.confirmProvision)
    const plan = await buildCallToolsProvisioningPlan({ profile, apply })
    const gatewayStatus = callToolsGatewayStatusForProfile(profile, plan.binding)
    response.json(
      publicSpeakPayload({
        ...plan,
        binding: {
          ...plan.binding,
          mediaGatewayStatus: gatewayStatus.status,
        },
        mediaGatewayConnected: gatewayStatus.connected,
        mediaGatewayConnectionCount: gatewayStatus.connectionCount,
        mediaGatewayProfile: gatewayStatus.gateway,
        steps: plan.steps.map((step) =>
          step.key === 'media-gateway'
            ? {
                ...step,
                status: gatewayStatus.connected
                  ? 'registered'
                  : gatewayStatus.status === 'configured'
                    ? 'configured'
                    : step.status,
              }
            : step,
        ),
      }),
    )
  } catch (error) {
    response.status(error.status || 502).json({
      error: error instanceof Error ? error.message : 'CallTools provisioning plan failed',
      code: error.code || 'calltools_provisioning_failed',
    })
  }
})

app.get('/api/calltools/gateway-config', async (request, response) => {
  try {
    assertCallToolsGatewaySecret(request.query?.token || request.get('x-calltools-gateway-token'))
    const dutyState = await readWorkspaceCallToolsDuty()
    const duty = dutyState.calltoolsDuty || dutyState.dialerState?.calltoolsDuty || {}
    cacheCallToolsGatewayLeaseOwner(duty)
    const activeDuty = isActiveCallToolsDuty(duty)
    const profile = await resolveCallToolsSourceProfileInput({
      profileId: activeDuty ? duty.profileId : request.query?.profileId,
    })
    const config = normalizeCampaignConfig({
      ...profile.config,
      dialerProvider: 'calltools',
    })
    const binding = activeDuty
      ? normalizeDutyBinding(duty.binding)
      : config.calltoolsAgentBinding || {}
    const dutyRequestsRegistration = Boolean(
      activeDuty && ['arming', 'attention', 'on'].includes(safeLeadText(duty.status)),
    )
    const gatewayInstanceId = safeLeadText(request.query?.instanceId)
    const gatewayOwnerInstanceId = safeLeadText(duty.gatewayOwnerInstanceId)
    const registrationEnabled = Boolean(
      dutyRequestsRegistration &&
      gatewayInstanceId &&
      gatewayInstanceId === gatewayOwnerInstanceId &&
      safeLeadText(duty.profileId) === safeLeadText(profile.id) &&
      safeLeadText(binding.appUserId || binding.userId) &&
      safeLeadText(binding.campaignId) &&
      safeLeadText(binding.phoneId)
    )
    const phone = await readCallToolsPhoneCredentials(binding.phoneId)
    const gatewayBase = callToolsGatewayConnectionBase(request)
    const gatewayWebSocketUrl = `${gatewayBase
      .replace(/^http/i, 'ws')
      .replace(/\/+$/g, '')}/api/calltools/media-gateway?token=${encodeURIComponent(
      getCallToolsMediaGatewaySharedSecret(),
    )}`

    response.json({
      gatewayInstanceId,
      profileId: profile.id,
      profileName: profile.name,
      registrationEnabled,
      sampleRate: config.sampleRate,
      phone,
      gatewayWebSocketUrl,
      gatewayTransport: isLoopbackGatewayRequest(request) ? 'loopback' : 'public',
    })
  } catch (error) {
    response.status(error.status || 403).json({
      error: error instanceof Error ? error.message : 'CallTools gateway config failed',
      code: error.code || 'calltools_gateway_config_failed',
    })
  }
})

function callToolsGatewayConnectionBase(request) {
  if (isLoopbackGatewayRequest(request)) {
    return `${request.protocol}://${request.get('host')}${BASE_PATH}`
  }
  return process.env.PUBLIC_BASE_URL || `${request.protocol}://${request.get('host')}${BASE_PATH}`
}

function isLoopbackGatewayRequest(request) {
  const hostname = safeLeadText(request.hostname).toLowerCase()
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
}

function beginPlaygroundStartRequest({ startRequestId: suppliedId, mode }) {
  const rawId = String(suppliedId || '').trim()
  const startRequestId = rawId
    ? normalizePlaygroundStartRequestId(rawId)
    : `playground-${randomUUID()}`
  if (!startRequestId) {
    return {
      accepted: false,
      reason: 'invalid',
      record: null,
      startRequestId: rawId,
    }
  }
  return {
    ...playgroundStartRequests.begin({ id: startRequestId, mode }),
    startRequestId,
  }
}

function respondToRejectedPlaygroundStart(response, registration) {
  const reason = registration?.reason || 'invalid'
  const status = reason === 'invalid' ? 400 : reason === 'capacity' ? 503 : 409
  const code =
    reason === 'canceled'
      ? 'playground_start_cancelled'
      : reason === 'duplicate'
        ? 'playground_start_duplicate'
        : reason === 'capacity'
          ? 'playground_start_capacity'
          : 'playground_start_request_invalid'
  const error =
    reason === 'canceled'
      ? 'Playground start was canceled before provider activation.'
      : reason === 'duplicate'
        ? 'This Playground start request was already accepted.'
        : reason === 'capacity'
          ? 'Playground start tracking is temporarily at capacity.'
          : 'A valid Playground start request ID is required.'
  response.status(status).json({
    error,
    code,
    startRequestId: registration?.startRequestId || undefined,
  })
}

function playgroundStartRequestCanceled(startRequestId) {
  return Boolean(playgroundStartRequests.get(startRequestId)?.canceled)
}

function cancelPlaygroundStartRequest(startRequestId, reason) {
  return playgroundStartRequests.cancel(startRequestId, reason)
}

function respondToCanceledPlaygroundStart(response, startRequestId, extra = {}) {
  playgroundStartRequests.finish(startRequestId, 'canceled')
  response.status(409).json({
    error: 'Playground start was canceled before provider activation.',
    code: 'playground_start_cancelled',
    canceled: true,
    startRequestId,
    ...extra,
  })
}

function finishPlaygroundStartForState(state, status = 'finished') {
  if (state?.playgroundStartRequestId) {
    playgroundStartRequests.finish(state.playgroundStartRequestId, status)
  }
}

app.post('/api/calls/start', async (request, response) => {
  const { lead, config, operatorInstructions } = request.body || {}
  const origin = request.body?.origin === 'playground_phone' ? 'playground_phone' : ''
  const playgroundStartRegistration = beginPlaygroundStartRequest({
    startRequestId: request.body?.startRequestId,
    mode: 'phone',
  })
  if (!playgroundStartRegistration.accepted) {
    respondToRejectedPlaygroundStart(response, playgroundStartRegistration)
    return
  }
  const { startRequestId } = playgroundStartRegistration
  let runtimeConfig
  try {
    runtimeConfig = await resolveStartRuntimeConfig({
      ...(config && typeof config === 'object' ? config : {}),
      // This route is itself the explicit Speak/Telnyx transport choice. A
      // saved profile's legacy dialer default must not restrict where its
      // voice/model/tool configuration can run.
      dialerProvider: 'speak',
    })
    if (isCallToolsDialer(runtimeConfig)) {
      playgroundStartRequests.finish(startRequestId, 'rejected')
      response.status(409).json({
        error: 'Direct CallTools calls are disabled. Use Go available to start the selected native campaign and agent session instead.',
        code: 'calltools_direct_start_disabled',
        provider: 'calltools',
      })
      return
    }
    runtimeConfig = await ensureVoiceRuntimeReady(runtimeConfig, {
      // Direct Phone calls use the provider config saved on the profile. Keep
      // the dial path free of Hume configuration writes; Inworld retains its
      // cached model/tool compatibility validation.
      syncProvider: isInworldRuntime(runtimeConfig) || isXaiRuntime(runtimeConfig),
    })
  } catch (error) {
    if (playgroundStartRequestCanceled(startRequestId)) {
      respondToCanceledPlaygroundStart(response, startRequestId)
      return
    }
    playgroundStartRequests.finish(startRequestId, 'failed')
    response.status(error.status || 502).json({
      error:
        error instanceof Error
          ? error.message
          : 'Voice provider configuration reconciliation failed',
      code: error.code || 'voice_provider_config_reconciliation_failed',
      dependency: error.dependency,
      retryable: error.retryable,
    })
    return
  }
  if (playgroundStartRequestCanceled(startRequestId)) {
    respondToCanceledPlaygroundStart(response, startRequestId)
    return
  }
  const missing = missingForCall(runtimeConfig)

  if (missing.length > 0) {
    playgroundStartRequests.finish(startRequestId, 'failed')
    const publicMissing = missing.map(publicRuntimeConfigName)
    response.status(503).json({
      error: `Voice backend is not configured: ${publicMissing.join(', ')}`,
      missing: publicMissing,
    })
    return
  }

  let provisionalVoiceSessionId = ''
  try {
    const runtimeContext = await resolveWorkspaceRuntimeContext({
      lead,
      config: runtimeConfig,
    })
    if (playgroundStartRequestCanceled(startRequestId)) {
      respondToCanceledPlaygroundStart(response, startRequestId)
      return
    }
    const normalizedLead = normalizeLead(runtimeContext.lead)
    runtimeConfig.profileContext = runtimeContext.profileContext
    if (!normalizedLead.phone) {
      playgroundStartRequests.finish(startRequestId, 'failed')
      response.status(400).json({ error: 'Lead phone is required' })
      return
    }
    provisionalVoiceSessionId = `preconnect-${randomUUID()}`
    const provisionalState = prepareProvisionalVoiceSession({
      key: provisionalVoiceSessionId,
      callControlId: provisionalVoiceSessionId,
      lead: normalizedLead,
      runtimeConfig,
      operatorInstructions,
      origin,
      requireBinding: true,
    })
    provisionalState.callProvider = 'telnyx_texml'
    const clientState = Buffer.from(
      JSON.stringify({
        provisionalVoiceSessionId,
        lead: {
          id: normalizedLead.id,
          firstName: normalizedLead.firstName,
          lastName: normalizedLead.lastName,
          name: normalizedLead.name,
          company: normalizedLead.company,
          phone: normalizedLead.phone,
          email: normalizedLead.email,
        },
        config: {
          voiceRuntimeProvider: runtimeConfig.voiceRuntimeProvider,
          agentProfileId: runtimeConfig.agentProfileId,
          agentProfileName: runtimeConfig.agentProfileName,
          humeConfigId: runtimeConfig.humeConfigId,
          inworldConfigId: runtimeConfig.inworldConfigId,
          sampleRate: runtimeConfig.sampleRate,
          telnyxStreamCodec: runtimeConfig.telnyxStreamCodec,
          verboseTranscription: runtimeConfig.verboseTranscription,
        },
      }),
    ).toString('base64')

    const telnyxResponse = await fetch(`${TELNYX_API_BASE}/calls`, {
      method: 'POST',
      headers: telnyxHeaders(),
      body: JSON.stringify({
        connection_id: runtimeConfig.telnyxConnectionId,
        to: normalizedLead.phone,
        from: runtimeConfig.telnyxCallerId,
        stream_url: getStreamUrl(),
        stream_track: 'inbound_track',
        stream_codec: runtimeConfig.telnyxStreamCodec,
        stream_bidirectional_mode: 'rtp',
        stream_bidirectional_codec: runtimeConfig.telnyxStreamCodec,
        stream_bidirectional_sampling_rate: runtimeConfig.sampleRate,
        stream_bidirectional_target_legs: 'self',
        stream_establish_before_call_originate: true,
        send_silence_when_idle: true,
        webhook_url: getTelnyxWebhookUrl(),
        webhook_url_method: 'POST',
        client_state: clientState,
      }),
    })
    const payload = await readJson(telnyxResponse)

    if (!telnyxResponse.ok) {
      cancelProvisionalVoiceSession(provisionalVoiceSessionId, 'dial_failed')
      if (playgroundStartRequestCanceled(startRequestId)) {
        respondToCanceledPlaygroundStart(response, startRequestId)
        return
      }
      playgroundStartRequests.finish(startRequestId, 'failed')
      const errorMessage = providerError('Phone dial failed', payload)
      const failedCallControlId = `failed-${randomUUID()}`
      const failedState = createCallState(
        failedCallControlId,
        normalizedLead,
        runtimeConfig,
        operatorInstructions,
      )
      failedState.callProvider = 'telnyx_texml'
      failedState.origin = origin
      calls.set(failedCallControlId, failedState)
      emitCallEvent(failedCallControlId, {
        entry: transcriptEntry('System', errorMessage, 'attention'),
        notice: errorMessage,
      })
      emitCallEvent(
        failedCallControlId,
        setCallOutcome(failedState, 'failed', errorMessage),
      )
      persistCallOutcome(failedState, 'failed')
      emitCallEvent(failedCallControlId, {
        patch: { phase: 'ended' },
        notice: 'Dial start failed before a live call was created.',
      })
      response.status(telnyxResponse.status).json({
        error: errorMessage,
        callControlId: failedCallControlId,
        provider: publicSpeakPayload(payload),
      })
      return
    }

    const callControlId = payload?.data?.call_control_id
    if (!callControlId) {
      cancelProvisionalVoiceSession(
        provisionalVoiceSessionId,
        'missing_call_control_id',
      )
      playgroundStartRequests.finish(startRequestId, 'failed')
      response.status(502).json({
        error: 'Phone provider response did not include call_control_id',
        provider: publicSpeakPayload(payload),
      })
      return
    }

    const state =
      bindProvisionalVoiceSession(
        provisionalVoiceSessionId,
        callControlId,
        provisionalState,
      ) ||
      prepareBoundVoiceSessionFallback({
        callControlId,
        lead: normalizedLead,
        runtimeConfig,
        operatorInstructions,
        origin,
        reason: 'preconnect_ttl_elapsed',
      })
    state.callProvider = 'telnyx_texml'
    state.callSessionId = payload?.data?.call_session_id
    state.playgroundSupervisionToken =
      origin === 'playground_phone' ? randomUUID() : ''
    state.playgroundStartRequestId = startRequestId
    playgroundStartRequests.bind(startRequestId, {
      mode: 'phone',
      sessionId: callControlId,
    })
    if (playgroundStartRequestCanceled(startRequestId)) {
      await hangupCanceledPlaygroundPhoneStart(state, startRequestId)
      respondToCanceledPlaygroundStart(response, startRequestId, { callControlId })
      return
    }
    recordTransportMilestone(state, 'telnyx_call_accepted', {
      callSessionId: state.callSessionId,
      voicePreconnected: Boolean(state.voiceConnectStarted),
    })
    persistWorkspaceLeadPatch(state, {
      ...normalizedLead,
      status: 'calling',
      lastCall: 'In progress',
    })
    emitCallEvent(callControlId, {
      diagnostic: buildTransportDiagnosticSnapshot(state),
      entry: transcriptEntry(
        'System',
        `Phone provider accepted the call request for ${normalizedLead.name}.`,
        'system',
      ),
      notice: 'Call request accepted',
    })

    response.json({
      callControlId,
      chatId: null,
      streamId: null,
      startRequestId,
      playgroundSupervisionToken: state.playgroundSupervisionToken || undefined,
    })
  } catch (error) {
    if (provisionalVoiceSessionId) {
      cancelProvisionalVoiceSession(provisionalVoiceSessionId, 'dial_exception')
    }
    if (playgroundStartRequestCanceled(startRequestId)) {
      respondToCanceledPlaygroundStart(response, startRequestId)
      return
    }
    playgroundStartRequests.finish(startRequestId, 'failed')
    if (error instanceof CodexClmReadinessError) {
      response.status(error.status).json({
        error: error.message,
        code: error.code,
        dependency: error.dependency,
        retryable: error.retryable,
        resetAt: error.resetAt,
      })
      return
    }
    response.status(500).json({
      error: error instanceof Error ? error.message : 'Call request failed',
    })
  }
})

app.post('/api/calls/:callControlId/barge-in', async (request, response) => {
  const state = getCallState(request.params.callControlId)
  const chatId = request.body?.chatId || state?.chatId

  if (!state?.streamId) {
    response.status(409).json({ error: 'Phone media stream is not attached yet' })
    return
  }

  if (!chatId) {
    response.status(409).json({ error: 'Speak voice session is not attached yet' })
    return
  }

  try {
    await pauseVoiceAssistant(state)
    state.takeover = true
    clearPhoneAssistantAudio(state)
    emitCallEvent(state.callControlId, {
      patch: { phase: 'handoff', takeover: true },
      entry: transcriptEntry('System', 'Assistant paused for human takeover.', 'system'),
      notice: 'Assistant paused',
    })
    response.json({
      ok: true,
      ...(state.outcome ? { outcome: state.outcome } : {}),
    })
  } catch (error) {
    response.status(502).json({
      error: error instanceof Error ? error.message : 'Barge-in failed',
    })
  }
})

app.post('/api/calls/:callControlId/resume', async (request, response) => {
  const state = getCallState(request.params.callControlId)
  const chatId = request.body?.chatId || state?.chatId

  if (!state || !chatId) {
    response.status(409).json({ error: 'Speak voice session is not attached yet' })
    return
  }

  if (isJonathanEchoMode()) {
    emitCallEvent(state.callControlId, {
      entry: transcriptEntry(
        'System',
        'Operator instruction held because temporary Jonathan echo mode is active.',
        'system',
      ),
      notice: 'Temporary Jonathan echo mode active',
    })
    response.json({ ok: true, ignored: true })
    return
  }

  try {
    await resumeVoiceAssistant(state)
    state.takeover = false
    emitCallEvent(state.callControlId, {
      patch: { phase: 'live', takeover: false },
      entry: transcriptEntry('System', 'Assistant resumed after takeover.', 'system'),
      notice: 'Assistant resumed',
    })
    response.json({ ok: true })
  } catch (error) {
    response.status(502).json({
      error: error instanceof Error ? error.message : 'Resume failed',
    })
  }
})

app.post('/api/calls/:callControlId/instructions', async (request, response) => {
  const state = getCallState(request.params.callControlId)
  const chatId = request.body?.chatId || state?.chatId
  const instruction = String(request.body?.instruction || '').trim()

  if (!instruction) {
    response.status(400).json({ error: 'Instruction text is required' })
    return
  }

  if (!state || !chatId) {
    response.status(409).json({ error: 'Speak voice session is not attached yet' })
    return
  }

  try {
    await sendVoiceInstruction(state, instruction)
    const playgroundTextWhisper = state.origin === 'playground_phone'
    emitCallEvent(state.callControlId, {
      entry: transcriptEntry(
        'You',
        playgroundTextWhisper
          ? `Text whisper to agent: ${instruction}`
          : `Live instruction to agent: ${instruction}`,
        'system',
      ),
      notice: playgroundTextWhisper
        ? 'Text whisper delivered to agent'
        : 'Live instruction delivered to agent',
    })
    response.json({
      ok: true,
      ...(playgroundTextWhisper
        ? { delivery: 'temporary_agent_guidance', visibility: 'agent_only' }
        : {}),
    })
  } catch (error) {
    response.status(502).json({
      error: error instanceof Error ? error.message : 'Instruction send failed',
    })
  }
})

app.post('/api/calls/:callControlId/end', async (request, response) => {
  const callControlId = request.params.callControlId
  const state = getCallState(callControlId)
  const requestedOutcome = normalizeCallOutcome(request.body?.outcome) || 'operator-ended'

  if (state && isCallEnded(state)) {
    const finalOutcome = state.outcome || requestedOutcome
    const outcomeEvent = setCallOutcome(state, finalOutcome)
    if (outcomeEvent) emitCallEvent(state.callControlId, outcomeEvent)
    persistCallOutcome(state, finalOutcome)
    emitCallEvent(state.callControlId, {
      patch: { phase: 'ended', takeover: false, outcome: state.outcome || finalOutcome },
      entry: transcriptEntry('System', 'Call was already ended; operator action acknowledged.', 'system'),
      notice: 'Call already ended',
    })
    closeCallSockets(state)
    finishPlaygroundStartForState(state)
    response.json({
      ok: true,
      alreadyEnded: true,
      outcome: state.outcome || finalOutcome,
    })
    return
  }

  if (state?.ending) {
    response.status(409).json({
      error: 'Call hangup is already waiting for the phone minimum duration',
      outcome: state.outcome || requestedOutcome,
    })
    return
  }

  if (state) {
    state.ending = true
    state.hangupRequestedAt = new Date().toISOString()
  }

  try {
    if (state) {
      const waitResult = await waitForMinimumTelnyxHangupDuration(
        state,
        'operator hangup',
      )
      if (waitResult.alreadyEnded || isCallEnded(state)) {
        const finalOutcome = state.outcome || requestedOutcome
        const outcomeEvent = setCallOutcome(state, finalOutcome)
        if (outcomeEvent) emitCallEvent(state.callControlId, outcomeEvent)
        closeCallSockets(state)
        persistCallOutcome(state, finalOutcome)
        finishPlaygroundStartForState(state)
        response.json({
          ok: true,
          alreadyEnded: true,
          outcome: state.outcome || finalOutcome,
        })
        return
      }
    }

    clearPhoneAssistantAudio(state, 'operator_hangup')
    if (isCallToolsGatewayCall(state)) {
      if (!requestCallToolsGatewayHangup(state, requestedOutcome)) {
        if (state) state.ending = false
        response.status(409).json({
          error: 'CallTools media gateway is not attached',
          provider: 'calltools',
        })
        return
      }
      emitCallEvent(state.callControlId, {
        entry: transcriptEntry('System', 'CallTools gateway hangup requested.', 'system'),
        notice: 'CallTools hangup requested',
      })
      response.json({
        ok: true,
        provider: 'calltools',
        pending: true,
        outcome: requestedOutcome,
      })
      return
    }
    const { response: telnyxResponse, payload } =
      await hangupPhoneProviderCall(state, callControlId)

    if (!telnyxResponse.ok) {
      if (isTelnyxAlreadyEnded(telnyxResponse.status, payload)) {
        if (state) {
          closeCallSockets(state)
          const outcomeEvent = setCallOutcome(state, state.outcome || requestedOutcome)
          if (outcomeEvent) emitCallEvent(state.callControlId, outcomeEvent)
          persistCallOutcome(state, state.outcome || requestedOutcome)
          emitCallEvent(state.callControlId, {
            patch: {
              phase: 'ended',
              takeover: false,
              outcome: state.outcome || requestedOutcome,
            },
            entry: transcriptEntry(
              'System',
              'Phone provider reported the call was already ended.',
              'system',
            ),
            notice: 'Call already ended',
          })
          finishPlaygroundStartForState(state)
        }
        response.json({
          ok: true,
          alreadyEnded: true,
          outcome: state?.outcome || requestedOutcome,
          provider: publicSpeakPayload(payload),
        })
        return
      }

      if (state) state.ending = false
      response.status(telnyxResponse.status).json({
        error: providerError('Phone hangup failed', payload),
        provider: publicSpeakPayload(payload),
      })
      return
    }

    closeCallSockets(state)
    if (state) {
      if (state.personalPhoneInboundCorrelationId) {
        personalPhoneInboundHandoffs.markTerminal(
          state.personalPhoneInboundCorrelationId,
          'agent_hangup',
          'agent_hangup',
        )
      }
      const outcomeEvent = setCallOutcome(state, requestedOutcome)
      if (outcomeEvent) emitCallEvent(state.callControlId, outcomeEvent)
      persistCallOutcome(state, state.outcome || requestedOutcome)
      emitCallEvent(state.callControlId, {
        patch: {
          phase: 'ended',
          takeover: false,
          outcome: state.outcome || requestedOutcome || 'operator-ended',
        },
        entry: transcriptEntry('System', 'Call ended through phone provider.', 'system'),
        notice: 'Call ended',
      })
      finishPlaygroundStartForState(state)
    }
    response.json({ ok: true })
  } catch (error) {
    if (state && !isCallEnded(state)) state.ending = false
    response.status(500).json({
      error: error instanceof Error ? error.message : 'End call failed',
    })
  }
})

app.get('/api/calls/:callControlId/events', (request, response) => {
  const callControlId = request.params.callControlId
  response.writeHead(200, {
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Content-Type': 'text/event-stream',
  })
  response.write('\n')

  const clients = getSseClients(callControlId)
  clients.add(response)
  const state = getCallState(callControlId)
  state?.eventLog.forEach((event) => {
    response.write(`data: ${JSON.stringify(publicSpeakPayload(event))}\n\n`)
  })

  request.on('close', () => {
    clients.delete(response)
  })
})

app.get('/api/calls/recent', (request, response) => {
  const limit = Math.max(1, Math.min(500, Number(request.query.limit || 12)))
  response.json(
    publicSpeakPayload({
      calls: collectRecentCallSummaries({
        callStates: Array.from(calls.values()),
        callLogDir,
        limit,
        leadForState: publicLeadContext,
      }),
    }),
  )
})

app.get('/api/communication-threads', async (request, response) => {
  try {
    response.json(
      publicSpeakPayload(
        await listCommunicationThreads({
          contactId: request.query.contactId,
          agentProfileId: request.query.agentProfileId,
          channel: request.query.channel,
          channels: request.query.channels,
          status: request.query.status,
          updatedAfter: request.query.updatedAfter,
          cursor: request.query.cursor,
          limit: request.query.limit,
        }),
      ),
    )
  } catch (error) {
    response.status(500).json({
      error: 'communication_threads_failed',
      message: error instanceof Error ? error.message : String(error),
    })
  }
})

app.get('/api/communication-threads/:threadId/messages', async (request, response) => {
  try {
    response.json(
      publicSpeakPayload(
        await listCommunicationThreadMessages(request.params.threadId, {
          cursor: request.query.cursor,
          limit: request.query.limit,
        }),
      ),
    )
  } catch (error) {
    response.status(500).json({
      error: 'communication_messages_failed',
      message: error instanceof Error ? error.message : String(error),
    })
  }
})

app.post('/api/communication-messages/send', async (request, response) => {
  const body = request.body || {}
  const channel = safeLeadText(body.channel).toLowerCase()
  const threadId = safeLeadText(body.threadId)
  const messageId = safeLeadText(body.messageId)
  const contactId = safeLeadText(body.contactId)
  const lead = body.lead && typeof body.lead === 'object' ? body.lead : {}

  if (!['sms', 'email'].includes(channel)) {
    response.status(400).json({ error: 'unsupported_channel' })
    return
  }

  if (channel === 'sms' && !isSmsConfigured()) {
    response.status(503).json(
      publicSpeakPayload({
        ok: false,
        sent: false,
        error: 'sms_not_configured',
        message: 'Agent SMS is not ready.',
        delivery: {
          smsConfigured: false,
        },
      }),
    )
    return
  }

  if (channel === 'email') {
    const emailAuthReady = workspaceEmailGmailAuthConfigured()
    const emailSendAsReady = workspaceEmailSendAsConfigured()
    if (!emailAuthReady || !emailSendAsReady) {
      response.status(503).json(
        publicSpeakPayload({
          ok: false,
          sent: false,
          error: 'workspace_email_not_ready',
          message: emailAuthReady
            ? 'Workspace email send-as is not ready.'
            : 'Workspace email is not ready.',
          delivery: {
            emailConfigured: false,
            emailAuthAccountConfigured: emailAuthReady,
            emailSendAuthAccountConfigured: emailAuthReady,
            emailSendAsConfigured: emailSendAsReady,
          },
        }),
      )
      return
    }
  }

  const deliveryAdmission = beginDeliveryAdmission()
  try {
    let sourceMessage = null
    let sourceThread = null
    if (threadId) {
      const [threadResult, messagesResult] = await Promise.all([
        readCommunicationThread(threadId),
        listCommunicationThreadMessages(threadId, { limit: 500 }),
      ])
      sourceThread = threadResult?.thread || null
      sourceMessage = (messagesResult.messages || []).find((message) => message.messageId === messageId) ||
        null
    }

    if (channel === 'sms') {
      const text = safeLeadText(body.body || body.message || body.text)
      const phone = normalizePhone(
        body.phone ||
          body.toPhone ||
          body.to ||
          communicationMessageTargetValue(sourceMessage, 'sms'),
      )
      if (!phone) {
        response.status(400).json({ error: 'invalid_phone' })
        return
      }
      if (!text) {
        response.status(400).json({ error: 'missing_message' })
        return
      }

      const { eventResult, proof } = await trackDeliveryOperation(
        (async () => {
          const sms = await sendTextMessage(phone, text)
          const proof = smsProviderAcceptanceProof({ phone, sms })
          const eventResult = await recordCommunicationEvent({
            channel: 'sms',
            lead,
            event: {
              communication: {
                threadId,
                contactId: contactId || sourceThread?.contactId || '',
                channel: 'sms',
                modality: 'text',
                direction: 'outbound',
                role: 'agent',
                body: text,
                provider: 'telnyx',
                at: new Date().toISOString(),
                identity: {
                  phone,
                },
                providerIds: cleanObject({
                  messageId: proof.message_id,
                  fromPhone: getTelnyxSmsFrom(),
                  toPhone: phone,
                  replyToMessageId: messageId,
                }),
                proof,
              },
            },
          })
          queueSmsDeliveryFinalizationRecord({
            agentProfileId: sourceThread?.agentProfileId || '',
            contactId: contactId || sourceThread?.contactId || '',
            lead,
            phone,
            replyToMessageId: messageId,
            sms,
            text,
            threadId: eventResult?.thread?.threadId || threadId,
          })
          return { eventResult, proof }
        })(),
      )
      response.json(
        publicSpeakPayload({
          accepted: true,
          delivery_finalized: false,
          ok: true,
          pending: true,
          provider_accepted: true,
          sent: false,
          status: 'provider_accepted',
          channel: 'sms',
          deliveryMode: 'agent',
          message: eventResult?.message,
          proof,
          thread: eventResult?.thread,
        }),
      )
      return
    }

    const email = cleanEmail(
      body.email ||
        body.toEmail ||
        body.to ||
        communicationMessageTargetValue(sourceMessage, 'email'),
    )
    const subject = safeLeadText(body.subject)
    const text = safeLeadText(body.body || body.message || body.text)
    if (!email) {
      response.status(400).json({ error: 'invalid_email' })
      return
    }
    if (!subject || !text) {
      response.status(400).json({ error: 'missing_email_content' })
      return
    }

    const { eventResult, proof } = await trackDeliveryOperation(
      (async () => {
        const emailResult = await sendEmail(email, subject, text)
        const proof = {
          provider: 'google_workspace',
          to: maskEmail(email),
          from: getWorkspaceEmailAccount(),
          message_id: emailResult.id || emailResult.messageId || emailResult.message_id || '',
          thread_id: emailResult.threadId || emailResult.thread_id || '',
        }
        const eventResult = await recordCommunicationEvent({
          channel: 'email',
          lead,
          event: {
            communication: {
              threadId,
              contactId: contactId || sourceThread?.contactId || '',
              channel: 'email',
              modality: 'text',
              direction: 'outbound',
              role: 'agent',
              body: `Subject: ${subject}\n\n${text}`,
              provider: 'google_workspace',
              at: new Date().toISOString(),
              identity: {
                email,
                externalThreadId: proof.thread_id,
              },
              providerIds: cleanObject({
                messageId: proof.message_id,
                emailThreadId: proof.thread_id,
                fromEmail: getWorkspaceEmailAccount(),
                toEmail: email,
                replyToMessageId: messageId,
              }),
              proof,
            },
          },
        })
        return { eventResult, proof }
      })(),
    )
    response.json(
      publicSpeakPayload({
        ok: true,
        sent: true,
        channel: 'email',
        deliveryMode: 'workspace',
        message: eventResult?.message,
        proof,
        thread: eventResult?.thread,
      }),
    )
  } catch (error) {
    response.status(502).json({
      error: 'message_send_failed',
      message: error instanceof Error ? error.message : String(error),
    })
  } finally {
    deliveryAdmission.finish()
  }
})

app.get('/api/communication-threads/:threadId', async (request, response) => {
  try {
    const result = await readCommunicationThread(request.params.threadId)
    if (!result) {
      response.status(404).json({ error: 'communication_thread_not_found' })
      return
    }
    response.json(publicSpeakPayload(result))
  } catch (error) {
    response.status(500).json({
      error: 'communication_thread_failed',
      message: error instanceof Error ? error.message : String(error),
    })
  }
})

app.get('/api/contacts/:contactId/communication-memory', async (request, response) => {
  try {
    response.json(
      publicSpeakPayload({
        schemaVersion: 'speak.contact-communication-memory.v1',
        contactId: request.params.contactId,
        memory: await readContactCommunicationMemory({
          contactId: request.params.contactId,
          limit: request.query.limit,
        }),
      }),
    )
  } catch (error) {
    response.status(500).json({
      error: 'communication_memory_failed',
      message: error instanceof Error ? error.message : String(error),
    })
  }
})

app.post('/api/communication-threads/:threadId/summary/rebuild', async (request, response) => {
  try {
    const result = await rebuildCommunicationThreadSummary(request.params.threadId)
    if (!result) {
      response.status(404).json({ error: 'communication_thread_not_found' })
      return
    }
    response.json(publicSpeakPayload(result))
  } catch (error) {
    response.status(500).json({
      error: 'communication_thread_rebuild_failed',
      message: error instanceof Error ? error.message : String(error),
    })
  }
})

app.post('/api/communication-events', async (request, response) => {
  if (!isInternalCommunicationRequest(request)) {
    response.status(403).json({ error: 'communication_events_internal_only' })
    return
  }

  try {
    response.json(publicSpeakPayload(await recordTrustedCommunicationEvent(request.body || {})))
  } catch (error) {
    response.status(500).json({
      error: 'communication_event_failed',
      message: error instanceof Error ? error.message : String(error),
    })
  }
})

async function recordTrustedCommunicationEvent(body = {}) {
  const allowAutomation = truthy(body.allowAutomation)
  const communication = body?.event?.communication || {}
  const channel = safeLeadText(body.channel || communication.channel).toLowerCase()
  const direction = safeLeadText(communication.direction).toLowerCase()
  const inboundAutomatable =
    ['sms', 'email', 'call'].includes(channel) && direction === 'inbound'
  const subject = emailSubjectFromCommunicationBody(communication.body)

  if (!inboundAutomatable) {
    return recordCommunicationEvent(body)
  }

  if (!allowAutomation) {
    const recordOnlyPolicy = {
      action: channel === 'call' ? 'missed_call' : 'none',
      channel,
      enabled: false,
      reason: 'internal_event_record_only',
      source: 'communication_events',
    }
    return recordCommunicationEvent(communicationEventWithAutomationProof(body, recordOnlyPolicy))
  }

  const inboundAutomation = await resolveInboundAutomationForCommunicationEvent(body, {
    channel,
    subject,
  })
  const policy = inboundAutomation.policy
  const recorded = await recordCommunicationEvent(
    communicationEventWithAutomationProof(inboundAutomation.communicationEvent, policy),
  )
  const shouldApply =
    policy?.enabled &&
    !(channel === 'call' && isMissedInboundCommunicationEvent(body, recorded.message))
  const automationResult = shouldApply
    ? await applyInboundAutomationPolicy({
        channel,
        context: inboundAutomation.context,
        eventType: safeLeadText(body.eventType || body.event_type),
        policy,
        providerPayload: genericProviderPayloadFromCommunicationEvent(body),
        recorded,
        subject,
        target: communicationEventTargetValue(body, recorded.message, channel),
      })
    : null
  return {
    ...recorded,
    automation: policy ? automationProof(policy) : null,
    automationMessage: automationResult?.message,
  }
}

app.post('/api/webhooks/workspace-email', async (request, response) => {
  if (!isInternalCommunicationRequest(request)) {
    response.status(403).json({ error: 'workspace_email_webhook_internal_only' })
    return
  }

  try {
    const body = request.body || {}
    const allowAutomation = truthy(body.allowAutomation || request.query.allowAutomation)
    response.json(
      publicSpeakPayload(
        await recordWorkspaceEmailPayload(body, {
          allowAutomation,
          source: 'workspace_email_webhook',
        }),
      ),
    )
  } catch (error) {
    response.status(error.statusCode || 500).json({
      error: 'workspace_email_webhook_failed',
      message: error instanceof Error ? error.message : String(error),
    })
  }
})

app.post('/api/workspace-email/sync', async (request, response) => {
  if (!isInternalCommunicationRequest(request)) {
    response.status(403).json({ error: 'workspace_email_sync_internal_only' })
    return
  }

  const body = request.body || {}
  const allowAutomation = truthy(body.allowAutomation || request.query.allowAutomation)
  const account = body.account || request.query.account
  const authAccount = body.authAccount || request.query.authAccount
  const emailReadAuthReady = workspaceEmailGmailReadConfigured({ account: authAccount })
  if (!workspaceEmailSourceReadConfigured({ account, authAccount })) {
    response.status(503).json(
      publicSpeakPayload({
        ok: false,
        error: 'workspace_email_source_read_not_ready',
        message:
          'Workspace email source read is not ready. Run npm run qa:workspace-email-source and configure WORKSPACE_EMAIL_GOG_ACCOUNT_READS_MAILBOX only after the read account can see the workspace mailbox.',
        delivery: {
          emailReadAuthAccountConfigured: emailReadAuthReady,
          emailSourceReadConfigured: false,
        },
      }),
    )
    return
  }
  try {
    const payloads = await fetchWorkspaceEmailSyncPayloads({
      account,
      authAccount,
      query: body.query || request.query.query,
      limit: body.limit || request.query.limit,
    })
    const records = []
    const skipped = []
    for (const payload of payloads) {
      try {
        const result = await recordWorkspaceEmailPayload(payload, {
          allowAutomation,
          source: 'workspace_email_sync',
        })
        records.push(safeWorkspaceEmailRecordResult(result))
      } catch (error) {
        skipped.push({
          messageId: safeLeadText(payload.messageId || payload.message_id || payload.id),
          threadId: safeLeadText(payload.threadId || payload.thread_id),
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }
    response.json(
      publicSpeakPayload({
        schemaVersion: 'speak.workspace-email-sync.v1',
        ok: true,
        allowAutomation,
        scanned: payloads.length,
        recorded: records.length,
        skipped: skipped.length,
        records,
        skippedMessages: skipped,
      }),
    )
  } catch (error) {
    response.status(500).json({
      error: 'workspace_email_sync_failed',
      message: error instanceof Error ? error.message : String(error),
    })
  }
})

async function recordWorkspaceEmailPayload(payload = {}, {
  allowAutomation = false,
  source = 'workspace_email_webhook',
} = {}) {
  const {
    communicationEvent,
    contactEmail,
    direction,
    inboundSyncNoAutomation,
    subject,
  } = buildWorkspaceEmailCommunicationEvent(payload, { allowAutomation, source })
  const inboundAutomation =
    direction === 'inbound' && allowAutomation
      ? await resolveInboundAutomationForCommunicationEvent(communicationEvent, {
          channel: 'email',
          subject,
        })
      : { policy: null, communicationEvent }
  const policy = inboundAutomation.policy
  const recorded = await recordCommunicationEvent(
    communicationEventWithAutomationProof(inboundAutomation.communicationEvent, policy),
  )
  const automationResult =
    direction === 'inbound' && allowAutomation
      ? await applyInboundAutomationPolicy({
          channel: 'email',
          policy,
          recorded,
          subject,
          target: contactEmail,
        })
      : null

  return {
    ...recorded,
    automation: policy ? automationProof(policy) : inboundSyncNoAutomation,
    automationMessage: automationResult?.message,
  }
}

function safeWorkspaceEmailRecordResult(result = {}) {
  const message = result.message || {}
  const thread = result.thread || {}
  return {
    messageId: message.messageId || '',
    threadId: thread.threadId || message.threadId || '',
    contactId: thread.contactId || message.contactId || '',
    direction: message.direction || '',
    channel: message.channel || 'email',
    providerMessageId: message.providerIds?.messageId || '',
    providerThreadId: message.providerIds?.emailThreadId || '',
    automation: result.automation || message.proof?.automation,
  }
}

app.get('/api/config-tests/recent', (request, response) => {
  const limit = Math.max(1, Math.min(100, Number(request.query.limit || 24)))
  const scanLimit = Math.max(100, limit * 5)
  const profileId = String(request.query.profileId || '').trim()
  const profileName = String(request.query.profileName || '').trim().toLowerCase()
  const tests = collectRecentCallSummaries({
    callStates: Array.from(calls.values()),
    callLogDir,
    limit: scanLimit,
    leadForState: publicLeadContext,
  })
    .filter(isPlaygroundTestSummary)
    .filter((summary) => configTestMatchesProfile(summary, profileId, profileName))
    .slice(0, limit)

  response.json(publicSpeakPayload({ tests }))
})

app.post('/api/calls/delete', (request, response) => {
  const ids = normalizeCallDeleteIds(request.body?.ids || request.body?.callControlIds)
  const activeIds = ids.filter((id) => {
    const state = calls.get(id)
    return state && !isCallEnded(state)
  })
  const pendingDeliveryIds = ids.filter((id) =>
    hasPendingBackgroundDelivery(calls.get(id)),
  )
  if (activeIds.length || pendingDeliveryIds.length) {
    response.status(409).json({
      error: pendingDeliveryIds.length
        ? 'Cannot delete call transcripts while message delivery is processing.'
        : 'Cannot delete active call transcripts.',
      activeIds,
      pendingDeliveryIds,
    })
    return
  }

  const result = deletePersistedCallSummaries({
    callLogDir,
    callControlIds: ids,
  })
  const memoryDeleted = ids.filter((id) => calls.has(id))
  ids.forEach((id) => calls.delete(id))
  response.json(
    publicSpeakPayload({
      ...result,
      deleted: Array.from(new Set([...result.deleted, ...memoryDeleted])),
    }),
  )
})

app.delete('/api/calls/:callControlId', (request, response) => {
  const callControlId = String(request.params.callControlId || '').trim()
  if (!callControlId) {
    response.status(400).json({ error: 'Call ID is required' })
    return
  }
  const state = calls.get(callControlId)
  if (state && !isCallEnded(state)) {
    response.status(409).json({ error: 'Cannot delete an active call transcript.' })
    return
  }
  if (hasPendingBackgroundDelivery(state)) {
    response.status(409).json({
      error: 'Cannot delete call transcript while message delivery is processing.',
      pendingDeliveryIds: [callControlId],
    })
    return
  }
  const result = deletePersistedCallSummaries({
    callLogDir,
    callControlIds: [callControlId],
  })
  const memoryDeleted = calls.has(callControlId) ? [callControlId] : []
  calls.delete(callControlId)
  response.json(
    publicSpeakPayload({
      ...result,
      deleted: Array.from(new Set([...result.deleted, ...memoryDeleted])),
    }),
  )
})

app.get('/api/agent-configs/speak/:configId', async (request, response) => {
  response.set('Cache-Control', 'no-store')
  try {
    response.json(publicSpeakPayload(await readSpeakAgentConfig(request.params.configId)))
  } catch (error) {
    if (isVoiceConfigSyncError(error)) {
      response.status(error.status || 502).json({
        error: publicSpeakString(error.message),
        provider: publicSpeakString(error.provider),
      })
      return
    }

    response.status(502).json({
      error: error instanceof Error ? error.message : 'Speak config read failed',
    })
  }
})

app.get('/api/agent-configs/hume/:configId', async (request, response) => {
  response.set('Cache-Control', 'no-store')
  try {
    response.json(publicSpeakPayload(await readHumeAgentConfig(request.params.configId)))
  } catch (error) {
    if (isVoiceConfigSyncError(error)) {
      response.status(error.status || 502).json({
        error: publicSpeakString(error.message),
        provider: publicSpeakString(error.provider),
      })
      return
    }

    response.status(502).json({
      error: error instanceof Error ? error.message : 'Speak config read failed',
    })
  }
})

app.get('/api/agent-configs/inworld/:configId', async (request, response) => {
  response.set('Cache-Control', 'no-store')
  try {
    response.json(publicSpeakPayload(await readInworldAgentConfig(request.params.configId)))
  } catch (error) {
    if (isVoiceConfigSyncError(error)) {
      response.status(error.status || 502).json({
        error: publicSpeakString(error.message),
        provider: publicSpeakString(error.provider),
      })
      return
    }

    response.status(502).json({
      error: error instanceof Error ? error.message : 'Speak config read failed',
    })
  }
})

app.get('/api/agent-configs/xai/:configId', async (request, response) => {
  response.set('Cache-Control', 'no-store')
  try {
    response.json(publicSpeakPayload(await readXaiAgentConfig(request.params.configId)))
  } catch (error) {
    if (isVoiceConfigSyncError(error)) {
      response.status(error.status || 502).json({
        error: publicSpeakString(error.message),
        provider: publicSpeakString(error.provider),
      })
      return
    }
    response.status(502).json({
      error: error instanceof Error ? error.message : 'xAI config read failed',
    })
  }
})

app.get('/api/agent-configs/speak-options', async (request, response) => {
  response.set('Cache-Control', 'no-store')
  try {
    response.json(publicSpeakPayload(await readSpeakConfigOptions()))
  } catch (error) {
    if (isVoiceConfigSyncError(error)) {
      response.status(error.status || 502).json({
        error: publicSpeakString(error.message),
        provider: publicSpeakString(error.provider),
      })
      return
    }

    response.status(502).json({
      error: error instanceof Error ? error.message : 'Speak options read failed',
    })
  }
})

app.get('/api/agent-configs/hume-options', async (request, response) => {
  response.set('Cache-Control', 'no-store')
  try {
    response.json(publicSpeakPayload(await readHumeConfigOptions()))
  } catch (error) {
    if (isVoiceConfigSyncError(error)) {
      response.status(error.status || 502).json({
        error: publicSpeakString(error.message),
        provider: publicSpeakString(error.provider),
      })
      return
    }

    response.status(502).json({
      error: error instanceof Error ? error.message : 'Speak options read failed',
    })
  }
})

app.get('/api/agent-configs/inworld-options', async (request, response) => {
  response.set('Cache-Control', 'no-store')
  try {
    response.json(publicSpeakPayload(await readInworldConfigOptions()))
  } catch (error) {
    if (isVoiceConfigSyncError(error)) {
      response.status(error.status || 502).json({
        error: publicSpeakString(error.message),
        provider: publicSpeakString(error.provider),
      })
      return
    }

    response.status(502).json({
      error: error instanceof Error ? error.message : 'Speak options read failed',
    })
  }
})

app.get('/api/agent-configs/xai-options', async (request, response) => {
  response.set('Cache-Control', 'no-store')
  try {
    response.json(publicSpeakPayload(await readXaiConfigOptions()))
  } catch (error) {
    if (isVoiceConfigSyncError(error)) {
      response.status(error.status || 502).json({
        error: publicSpeakString(error.message),
        provider: publicSpeakString(error.provider),
      })
      return
    }
    response.status(502).json({
      error: error instanceof Error ? error.message : 'xAI options read failed',
    })
  }
})

app.post('/api/agent-configs/sync-speak', async (request, response) => {
  try {
    const config = request.body?.config
    const result = await syncSpeakAgentConfig({
      profileName: request.body?.profileName,
      config,
      createNew: await shouldCreateNewSpeakConfig({
        requestedCreateNew: Boolean(request.body?.createNew),
        profileId: request.body?.profileId,
        config,
      }),
      ownedUpdates: request.body?.ownedUpdates,
    })
    response.json(publicSpeakPayload(result))
  } catch (error) {
    if (isVoiceConfigSyncError(error)) {
      response.status(error.status || 502).json({
        error: publicSpeakString(error.message),
        provider: publicSpeakString(error.provider),
      })
      return
    }

    response.status(502).json({
      error: error instanceof Error ? error.message : 'Speak config sync failed',
    })
  }
})

app.post('/api/agent-configs/sync-hume', async (request, response) => {
  try {
    const config = request.body?.config
    const result = await syncHumeAgentConfig({
      profileName: request.body?.profileName,
      config,
      createNew: await shouldCreateNewSpeakConfig({
        requestedCreateNew: Boolean(request.body?.createNew),
        profileId: request.body?.profileId,
        config,
      }),
      ownedUpdates: request.body?.ownedUpdates,
    })
    response.json(publicSpeakPayload(result))
  } catch (error) {
    if (isVoiceConfigSyncError(error)) {
      response.status(error.status || 502).json({
        error: publicSpeakString(error.message),
        provider: publicSpeakString(error.provider),
      })
      return
    }

    response.status(502).json({
      error: error instanceof Error ? error.message : 'Speak config sync failed',
    })
  }
})

app.post('/api/agent-configs/sync-inworld', async (request, response) => {
  try {
    const config = request.body?.config
    const result = await syncInworldAgentConfig({
      profileName: request.body?.profileName,
      config,
      createNew: await shouldCreateNewSpeakConfig({
        requestedCreateNew: Boolean(request.body?.createNew),
        profileId: request.body?.profileId,
        config,
      }),
      ownedUpdates: request.body?.ownedUpdates,
    })
    response.json(publicSpeakPayload(result))
  } catch (error) {
    if (isVoiceConfigSyncError(error)) {
      response.status(error.status || 502).json({
        error: publicSpeakString(error.message),
        provider: publicSpeakString(error.provider),
      })
      return
    }

    response.status(502).json({
      error: error instanceof Error ? error.message : 'Speak config sync failed',
    })
  }
})

app.post('/api/agent-configs/sync-xai', async (request, response) => {
  try {
    const config = request.body?.config
    const result = await syncXaiAgentConfig({
      profileName: request.body?.profileName,
      config,
      createNew: await shouldCreateNewSpeakConfig({
        requestedCreateNew: Boolean(request.body?.createNew),
        profileId: request.body?.profileId,
        config,
      }),
      ownedUpdates: request.body?.ownedUpdates,
    })
    response.json(publicSpeakPayload(result))
  } catch (error) {
    if (isVoiceConfigSyncError(error)) {
      response.status(error.status || 502).json({
        error: publicSpeakString(error.message),
        provider: publicSpeakString(error.provider),
      })
      return
    }
    response.status(502).json({
      error: error instanceof Error ? error.message : 'xAI config sync failed',
    })
  }
})

app.get('/api/calls/:callControlId/audio-link', async (request, response) => {
  const callControlId = request.params.callControlId
  const localAudio = localCallAudioMetadata(callAudioDir, callControlId, BASE_PATH)
  if (localAudio) {
    response.json(publicSpeakPayload(localAudio))
    return
  }

  const summary = findCallSummary(callControlId)
  const activeState = getCallState(callControlId)
  if (activeState && (isInworldRuntime(activeState.config) || isXaiRuntime(activeState.config))) {
    response.status(404).json({ error: 'No local call audio is available for this realtime session.' })
    return
  }
  if (
    !activeState &&
    ['inworld', 'xai'].includes(summary?.agent?.voiceRuntimeProvider)
  ) {
    response.status(404).json({ error: 'No local call audio is available for this realtime session.' })
    return
  }
  const chatId = summary?.chatId || activeState?.chatId
  if (!chatId) {
    response.status(404).json({ error: 'No call audio or Speak session history is available.' })
    return
  }

  try {
    const humeAudio = await fetchHumeAudioReconstruction(chatId)
    const statusCode = humeAudio.status === 'ready' ? 200 : 202
    response.status(statusCode).json(publicSpeakPayload(humeAudio))
  } catch (error) {
    response.status(502).json({
      error: error instanceof Error ? error.message : 'Speak audio reconstruction failed',
    })
  }
})

app.get('/api/calls/:callControlId/audio', (request, response) => {
  const callControlId = request.params.callControlId
  const localAudio = localCallAudioMetadata(callAudioDir, callControlId, BASE_PATH)
  if (!localAudio) {
    response.status(404).json({ error: 'Local call audio is not available.' })
    return
  }

  response.type('audio/wav')
  response.sendFile(callAudioFilePath(callAudioDir, callControlId))
})

app.get('/api/calls/:callControlId/audio/diagnostics/:stage', (request, response) => {
  const filePath = callAudioDiagnosticFilePath(
    callAudioDir,
    request.params.callControlId,
    request.params.stage,
  )

  if (!filePath || !existsSync(filePath)) {
    response.status(404).json({ error: 'Diagnostic call audio is not available.' })
    return
  }

  response.type('audio/wav')
  response.sendFile(filePath)
})

async function hangupCanceledPlaygroundPhoneStart(state, startRequestId) {
  if (!state) return { ok: false, pending: true }
  if (isCallEnded(state)) {
    finishPlaygroundStartForState(state, 'canceled')
    return { ok: true, ended: true, alreadyEnded: true }
  }
  if (state.playgroundStartCancellationPromise) {
    return state.playgroundStartCancellationPromise
  }

  state.ending = true
  state.hangupRequestedAt = new Date().toISOString()
  const cancellationPromise = (async () => {
    clearPhoneAssistantAudio(state, 'playground_start_cancelled')
    let lastError = ''
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const { response: providerResponse, payload } =
          await hangupPhoneProviderCall(state, state.callControlId)
        if (
          providerResponse.ok ||
          isTelnyxAlreadyEnded(providerResponse.status, payload)
        ) {
          closeCallSockets(state)
          const outcomeEvent = setCallOutcome(
            state,
            state.outcome || 'operator-ended',
            'Playground Phone start canceled before activation',
          )
          if (outcomeEvent) emitCallEvent(state.callControlId, outcomeEvent)
          persistCallOutcome(state, state.outcome || 'operator-ended')
          emitCallEvent(state.callControlId, {
            patch: {
              phase: 'ended',
              takeover: false,
              outcome: state.outcome || 'operator-ended',
            },
            entry: transcriptEntry(
              'System',
              'Playground Phone start was canceled and the provider call was ended.',
              'system',
            ),
            notice: 'Phone test start canceled',
          })
          playgroundStartRequests.finish(startRequestId, 'canceled')
          if (state.playgroundStartCancellationRetryTimer) {
            clearTimeout(state.playgroundStartCancellationRetryTimer)
            state.playgroundStartCancellationRetryTimer = null
          }
          return { ok: true, ended: true }
        }
        lastError = providerError('Canceled Phone test hangup failed', payload)
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Phone hangup failed'
      }
      if (attempt < 3) await wait(250 * (attempt + 1))
    }

    state.ending = false
    emitCallEvent(state.callControlId, {
      entry: transcriptEntry(
        'System',
        `Canceled Phone test hangup needs retry: ${publicSpeakString(lastError)}`,
        'attention',
      ),
      notice: 'Canceled Phone test hangup needs retry',
    })
    return { ok: false, retryable: true }
  })()
  state.playgroundStartCancellationPromise = cancellationPromise
  const result = await cancellationPromise
  if (!result.ok) {
    state.playgroundStartCancellationPromise = null
    state.playgroundStartCancellationRounds =
      Number(state.playgroundStartCancellationRounds || 0) + 1
    if (
      state.playgroundStartCancellationRounds < 6 &&
      !state.playgroundStartCancellationRetryTimer
    ) {
      const retryDelayMs = Math.min(
        5_000,
        state.playgroundStartCancellationRounds * 1_000,
      )
      state.playgroundStartCancellationRetryTimer = setTimeout(() => {
        state.playgroundStartCancellationRetryTimer = null
        void hangupCanceledPlaygroundPhoneStart(state, startRequestId)
      }, retryDelayMs)
      state.playgroundStartCancellationRetryTimer.unref?.()
    }
  }
  return result
}

async function cancelAttachedPlaygroundStart(record) {
  if (!record?.sessionId) return { ok: true, pending: true }
  const state = getCallState(record.sessionId)
  if (!state) return { ok: true, pending: true }

  if (record.mode === 'browser' || state.browserTest) {
    if (!isCallEnded(state)) {
      closeCallSockets(state)
      const outcomeEvent = setCallOutcome(
        state,
        state.outcome || 'operator-ended',
        'Playground Browser start canceled before activation',
      )
      if (outcomeEvent) emitCallEvent(state.callControlId, outcomeEvent)
      persistCallOutcome(state, state.outcome || 'operator-ended')
      emitCallEvent(state.callControlId, {
        patch: {
          phase: 'ended',
          takeover: false,
          outcome: state.outcome || 'operator-ended',
        },
        entry: transcriptEntry(
          'System',
          'Playground Browser start was canceled before activation.',
          'system',
        ),
        notice: 'Playground test start canceled',
      })
    }
    playgroundStartRequests.finish(record.id, 'canceled')
    return { ok: true, ended: true }
  }

  return hangupCanceledPlaygroundPhoneStart(state, record.id)
}

app.post('/api/playground-starts/:startRequestId/cancel', async (request, response) => {
  const startRequestId = normalizePlaygroundStartRequestId(
    request.params.startRequestId,
  )
  if (!startRequestId) {
    response.status(400).json({
      error: 'A valid Playground start request ID is required.',
      code: 'playground_start_request_invalid',
    })
    return
  }

  const record = cancelPlaygroundStartRequest(
    startRequestId,
    request.body?.reason || 'client_cancelled',
  )
  if (!record) {
    response.status(503).json({
      error: 'Playground start tracking is temporarily at capacity.',
      code: 'playground_start_capacity',
    })
    return
  }

  const result = await cancelAttachedPlaygroundStart(record)
  response.json({
    ok: true,
    canceled: true,
    pending: Boolean(result.pending || result.retryable),
    startRequestId,
  })
})

app.post('/api/config-tests/start', async (request, response) => {
  const playgroundStartRegistration = beginPlaygroundStartRequest({
    startRequestId: request.body?.startRequestId,
    mode: 'browser',
  })
  if (!playgroundStartRegistration.accepted) {
    respondToRejectedPlaygroundStart(response, playgroundStartRegistration)
    return
  }
  const { startRequestId } = playgroundStartRegistration
  let runtimeConfig
  try {
    runtimeConfig = await resolveStartRuntimeConfig(request.body?.config)
  } catch (error) {
    if (playgroundStartRequestCanceled(startRequestId)) {
      respondToCanceledPlaygroundStart(response, startRequestId)
      return
    }
    playgroundStartRequests.finish(startRequestId, 'failed')
    response.status(502).json({
      error: error instanceof Error ? error.message : 'Playground config resolution failed',
    })
    return
  }

  const missing = missingForVoiceSession(runtimeConfig)

  if (missing.length > 0) {
    playgroundStartRequests.finish(startRequestId, 'failed')
    const publicMissing = missing.map(publicRuntimeConfigName)
    response.status(503).json({
      error: `Speak test is not configured: ${publicMissing.join(', ')}`,
      missing: publicMissing,
    })
    return
  }

  try {
    runtimeConfig = await ensureVoiceRuntimeReady(runtimeConfig, {
      // A saved Hume profile already points at the exact provider config to
      // run. Re-syncing it here adds a blocking provider round trip and makes
      // a healthy test depend on an unrelated configuration write. Inworld
      // still performs its cached capability validation before connecting.
      syncProvider: isInworldRuntime(runtimeConfig) || isXaiRuntime(runtimeConfig),
    })
  } catch (error) {
    if (playgroundStartRequestCanceled(startRequestId)) {
      respondToCanceledPlaygroundStart(response, startRequestId)
      return
    }
    playgroundStartRequests.finish(startRequestId, 'failed')
    if (isVoiceConfigSyncError(error)) {
      response.status(error.status || 502).json({
        error: publicSpeakString(error.message),
        provider: publicSpeakString(error.provider),
      })
      return
    }

    response.status(error.status || 502).json({
      error: error instanceof Error ? error.message : 'Playground voice config sync failed',
      code: error.code,
      dependency: error.dependency,
      retryable: error.retryable,
    })
    return
  }

  if (playgroundStartRequestCanceled(startRequestId)) {
    respondToCanceledPlaygroundStart(response, startRequestId)
    return
  }

  try {
  const testId = `test-${randomUUID()}`
  const rawTestLeadSource =
    request.body?.lead ||
    request.body?.testLead ||
    request.body?.testVariables ||
    {}
  const rawTestLead =
    rawTestLeadSource && typeof rawTestLeadSource === 'object'
      ? rawTestLeadSource
      : {}
  const testVariables = normalizeConfigurationTestVariables(
    request.body?.testVariables || rawTestLead,
  )
  const testVariableKeys = normalizeConfigurationTestVariableKeys(
    request.body?.testVariableKeys,
    request.body?.testVariables || request.body?.testLead,
  )
  const initialTestLead = normalizeLead({
      ...rawTestLead,
      id: rawTestLead.id || testId,
      firstName: rawTestLead.firstName || testVariables.firstName,
      lastName: rawTestLead.lastName || testVariables.lastName,
      name: rawTestLead.name || testVariables.name,
      company: rawTestLead.company || testVariables.company,
      phone: rawTestLead.phone || testVariables.phone,
      email: rawTestLead.email || testVariables.email,
      notes: rawTestLead.notes || testVariables.notes,
      status: rawTestLead.status || 'ready',
  })
  const runtimeContext = await resolveWorkspaceRuntimeContext({
    lead: initialTestLead,
    config: runtimeConfig,
  })
  if (playgroundStartRequestCanceled(startRequestId)) {
    respondToCanceledPlaygroundStart(response, startRequestId)
    return
  }
  runtimeConfig.profileContext = runtimeContext.profileContext
  const state = createCallState(
    testId,
    runtimeContext.lead,
    runtimeConfig,
    [],
  )
  state.callProvider = 'browser'
  state.contactConversationMemory = await readVoiceContactConversationMemory(
    runtimeContext.lead,
  )
  if (playgroundStartRequestCanceled(startRequestId)) {
    closeCallSockets(state)
    respondToCanceledPlaygroundStart(response, startRequestId)
    return
  }
  state.browserTest = true
  state.browserAudioAttachPending = true
  state.origin = 'playground_browser'
  state.playgroundStartRequestId = startRequestId
  state.productionContext = request.body?.productionContext !== false
  state.testVariables = testVariables
  state.testVariableKeys = testVariableKeys
  calls.set(testId, state)
  playgroundStartRequests.bind(startRequestId, {
    mode: 'browser',
    sessionId: testId,
  })
  emitCallEvent(testId, {
    patch: { phase: 'live' },
    entry: transcriptEntry('System', 'Playground test started.', 'system'),
    notice: 'Playground test started',
  })
  connectVoiceSession(state)
  response.json({ testId, callControlId: testId, startRequestId })
  } catch (error) {
    if (playgroundStartRequestCanceled(startRequestId)) {
      respondToCanceledPlaygroundStart(response, startRequestId)
      return
    }
    playgroundStartRequests.finish(startRequestId, 'failed')
    response.status(error.status || 500).json({
      error: error instanceof Error ? error.message : 'Playground test failed to start',
      code: error.code || 'playground_start_failed',
    })
  }
})

app.post('/api/config-tests/:testId/end', (request, response) => {
  const state = getCallState(request.params.testId)
  if (!state) {
    const persistedSummary = findCallSummary(request.params.testId)
    if (isBrowserConfigTestSummary(persistedSummary)) {
      if (persistedSummary.phase === 'ended') {
        response.json({
          ok: true,
          alreadyEnded: true,
          recoveredPersisted: true,
          outcome: persistedSummary.outcome || 'operator-ended',
        })
        return
      }
      emitCallEvent(request.params.testId, {
        patch: { phase: 'ended', outcome: 'operator-ended' },
        entry: transcriptEntry(
          'System',
          'Playground test reconciled as ended after backend restart.',
          'system',
        ),
        notice: 'Playground test ended',
        persistCommunication: false,
      })
      response.json({ ok: true, recoveredPersisted: true })
      return
    }
  }
  if (!state?.browserTest) {
    response.status(404).json({ error: 'Playground test session not found' })
    return
  }

  if (isCallEnded(state)) {
    closeCallSockets(state)
    finishPlaygroundStartForState(state)
    response.json({
      ok: true,
      alreadyEnded: true,
      outcome: state.outcome || 'operator-ended',
    })
    return
  }

  closeCallSockets(state)
  emitCallEvent(state.callControlId, {
    patch: { phase: 'ended', outcome: 'operator-ended' },
    entry: transcriptEntry('System', 'Playground test ended.', 'system'),
    notice: 'Playground test ended',
  })
  finishPlaygroundStartForState(state)
  response.json({ ok: true })
})

app.post('/api/config-tests/:testId/message', async (request, response) => {
  const state = getCallState(request.params.testId)
  const text = String(request.body?.text || request.body?.message || '').trim()

  if (!state?.browserTest) {
    response.status(404).json({ error: 'Playground session not found' })
    return
  }

  if (!text) {
    response.status(400).json({ error: 'Message text is required' })
    return
  }

  if (!isVoiceSessionOpen(state)) {
    response.status(409).json({ error: 'Speak voice session is not attached yet' })
    return
  }

  try {
    const normalizedText = normalizeTranscriptContent(text)
    const assistantActive = shouldDeferPlaygroundUserInput(state)
    if (assistantActive) {
      queuePlaygroundUserInput(state, normalizedText)
    } else {
      await sendPlaygroundUserInputToVoiceProvider(
        state,
        normalizedText,
        'playground_input',
      )
    }
    emitCallEvent(state.callControlId, {
      entry: transcriptEntry('Lead', normalizedText),
      notice: 'Playground message sent',
    })
    response.json({ ok: true })
  } catch (error) {
    response.status(502).json({
      error: error instanceof Error ? error.message : 'Playground message failed',
    })
  }
})

app.post('/api/webhooks/telnyx', async (request, response) => {
  const signatureResult = verifyTelnyxWebhookRequest(request)
  if (!signatureResult.ok) {
    response.status(signatureResult.status || 401).json({ error: signatureResult.error })
    return
  }

  const eventType = request.body?.data?.event_type
  const eventOccurredAt = safeLeadText(request.body?.data?.occurred_at)
  const webhookEventId = safeLeadText(request.body?.data?.id)
  const payload = request.body?.data?.payload || {}
  const callControlId = payload.call_control_id

  if (safeLeadText(eventType).toLowerCase().startsWith('message.')) {
    observeTelnyxSmsFinalization(payload, { eventType })
  }

  const state = callControlId ? getCallState(callControlId) : null

  if (callControlId) {
    const providerEvent = publicTelnyxEventSummary(eventType, payload)
    const patch = {}
    if (state && eventType === 'call.answered') {
      state.answered = true
      state.answeredAt ||= new Date().toISOString()
      state.minimumHangupAt = minimumTelnyxHangupAt(state)
      patch.phase = 'live'
      patch.answeredAt = state.answeredAt
      patch.minimumHangupAt = state.minimumHangupAt
      maybeSendInitialGreetingPrompt(state)
    }

    const outcome =
      state && eventType === 'call.hangup'
        ? inferHangupOutcome(state, payload)
        : inferTelnyxMachineOutcome(eventType, payload)
    const outcomeEvent = outcome && state ? setCallOutcome(state, outcome) : null

    if (state && eventType === 'call.hangup') {
      patch.phase = 'ended'
      patch.takeover = false
      patch.outcome = state.outcome || outcome || inferStreamStopOutcome(state)
      closeCallSockets(state)
      persistCallOutcome(state, patch.outcome)
    }

    emitCallEvent(callControlId, {
      patch: Object.keys(patch).length > 0 ? patch : undefined,
      providerEvent,
      entry: transcriptEntry(
        'System',
        phoneEventTranscriptText(eventType, providerEvent),
        'system',
      ),
      notice: eventType,
    })
    if (outcomeEvent) emitCallEvent(callControlId, outcomeEvent)
  }

  await recordTelnyxProviderCommunicationEvent({
    eventType,
    payload,
    state,
    occurredAt: eventOccurredAt,
    webhookEventId,
  }).catch((error) => {
    console.warn(
      'Failed to persist Telnyx communication webhook:',
      error instanceof Error ? error.message : error,
    )
  })

  response.json({ ok: true })
})

function publicTelnyxEventSummary(eventType, payload = {}) {
  return publicSpeakPayload({
    type: eventType,
    hangup_cause: payload.hangup_cause,
    hangup_source: payload.hangup_source,
    cause: payload.cause,
    reason: payload.reason,
    sip_hangup_cause: payload.sip_hangup_cause,
    sip_hangup_phrase: payload.sip_hangup_phrase,
    call_session_id: payload.call_session_id,
    stream_id: payload.stream_id,
  })
}

function telnyxWebhookAutomationAllowed() {
  return truthy(process.env.SPEAK_TELNYX_WEBHOOK_ALLOW_AUTOMATION)
}

function telnyxWebhookRecordOnlyPolicy(channel, reason = 'telnyx_webhook_record_only') {
  return {
    action: channel === 'call' ? 'missed_call' : 'none',
    channel,
    enabled: false,
    reason,
    source: 'telnyx_webhook',
  }
}

async function recordTelnyxProviderCommunicationEvent({
  eventType,
  payload = {},
  state = null,
  occurredAt = '',
  webhookEventId = '',
  allowAutomation = telnyxWebhookAutomationAllowed(),
} = {}) {
  const smsSource = buildTelnyxSmsCommunicationEvent({
    eventType,
    payload,
    occurredAt,
    webhookEventId,
  })
  if (smsSource) {
    const { communicationEvent, contactPhone, direction, hasText } = smsSource
    if (direction === 'inbound' && !allowAutomation) {
      const inboundRecordOnly = await resolveInboundAutomationForCommunicationEvent(communicationEvent, {
        channel: 'sms',
      })
      return recordCommunicationEvent(
        communicationEventWithAutomationProof(
          inboundRecordOnly.communicationEvent,
          telnyxWebhookRecordOnlyPolicy('sms'),
        ),
      )
    }
    const inboundAutomation =
      direction === 'inbound' && hasText
        ? await resolveInboundAutomationForCommunicationEvent(communicationEvent, {
            channel: 'sms',
          })
        : { policy: null, communicationEvent }
    const policy = inboundAutomation.policy
    const recorded = await recordCommunicationEvent(
      communicationEventWithAutomationProof(inboundAutomation.communicationEvent, policy),
    )
    if (direction === 'inbound') {
      void applyInboundAutomationPolicy({
        channel: 'sms',
        policy,
        recorded,
        target: contactPhone,
      }).catch((error) => {
        console.warn(
          'Inbound SMS automation failed after webhook persistence:',
          error instanceof Error ? error.message : error,
        )
      })
    }
    return recorded
  }

  const inboundCallSource = state
    ? null
    : buildTelnyxInboundCallCommunicationEvent({
        eventType,
        payload,
        occurredAt,
        webhookEventId,
      })
  if (inboundCallSource) {
    const { communicationEvent, fromPhone, missed } = inboundCallSource
    if (!allowAutomation) {
      const inboundRecordOnly = await resolveInboundAutomationForCommunicationEvent(communicationEvent, {
        channel: 'call',
      })
      return recordCommunicationEvent(
        communicationEventWithAutomationProof(
          inboundRecordOnly.communicationEvent,
          telnyxWebhookRecordOnlyPolicy(
            'call',
            missed ? 'telnyx_webhook_missed_call_record_only' : 'telnyx_webhook_record_only',
          ),
        ),
      )
    }
    const inboundAutomation = await resolveInboundAutomationForCommunicationEvent(communicationEvent, {
      channel: 'call',
    })
    const policy = inboundAutomation.policy
    const recorded = await recordCommunicationEvent(
      communicationEventWithAutomationProof(inboundAutomation.communicationEvent, policy),
    )
    if (!missed) {
      await applyInboundAutomationPolicy({
        channel: 'call',
        policy,
        recorded,
        target: fromPhone,
        context: inboundAutomation.context,
        eventType,
        providerPayload: payload,
      })
    }
    return recorded
  }

  return null
}

async function resolveInboundAutomationForCommunicationEvent(communicationEvent, {
  channel,
  subject = '',
} = {}) {
  const context = await resolveCommunicationEventContext(communicationEvent).catch(() => null)
  const communicationEventWithProfile = communicationEventWithAgentProfile(
    communicationEvent,
    context?.profile,
  )
  let policy = resolveInboundAutomationPolicy({
    channel,
    direction: 'inbound',
    lead: context?.lead,
    profile: context?.profile,
    subject,
  })
  if (policy.enabled && !context?.communication?.contactId) {
    policy = {
      action: channel === 'call' ? 'missed_call' : 'none',
      channel,
      enabled: false,
      reason: 'unresolved_attribution_auto_response_blocked',
      source: policy.source,
    }
  }
  return {
    communicationEvent: communicationEventWithProfile,
    context,
    policy,
  }
}

async function resolveInboundPolicyForCommunicationEvent(communicationEvent, options = {}) {
  return (await resolveInboundAutomationForCommunicationEvent(communicationEvent, options)).policy
}

function communicationEventWithAgentProfile(communicationEvent, profile) {
  const profileId = safeLeadText(
    profile?.id ||
      profile?.config?.agentProfileId ||
      profile?.config?.speakConfigId ||
      profile?.config?.humeConfigId ||
      profile?.config?.inworldConfigId,
  )
  if (!profileId) return communicationEvent

  const communication = communicationEvent?.event?.communication || {}
  if (communication.agentProfileId) return communicationEvent
  const config = profile?.config || {}
  return {
    ...communicationEvent,
    agent: cleanObject({
      id: profileId,
      name: safeLeadText(profile?.name || config.agentProfileName || config.name),
      voiceRuntimeProvider: safeLeadText(config.voiceRuntimeProvider),
    }),
    event: {
      ...communicationEvent.event,
      communication: {
        ...communication,
        agentProfileId: profileId,
      },
    },
  }
}

function communicationEventWithAutomationProof(communicationEvent, policy) {
  if (!policy) return communicationEvent
  const communication = communicationEvent?.event?.communication || {}
  const missedInboundCall =
    policy.channel === 'call' &&
    policy.action === 'missed_call' &&
    safeLeadText(communication.direction).toLowerCase() === 'inbound'
  const proofPatch = cleanObject({
    ...(communication.proof || {}),
    ...(missedInboundCall ? { action: 'missed_call' } : {}),
    automation: automationProof(policy),
  })
  return {
    ...communicationEvent,
    event: {
      ...communicationEvent.event,
      communication: {
        ...communication,
        ...(missedInboundCall
          ? { body: missedInboundCallRecordBody(communication) }
          : {}),
        proof: proofPatch,
      },
    },
  }
}

function missedInboundCallRecordBody(communication = {}) {
  const body = safeLeadText(communication.body)
  if (/\b(missed|no[_ -]?answer|unanswered)\b/i.test(body)) return body
  if (/^inbound call received\b/i.test(body)) {
    return body.replace(/^inbound call received\b/i, 'Missed inbound call')
  }
  if (/^inbound call\b/i.test(body)) {
    return body.replace(/^inbound call\b/i, 'Missed inbound call')
  }
  const identity = communication.identity && typeof communication.identity === 'object'
    ? communication.identity
    : {}
  const providerIds = communication.providerIds && typeof communication.providerIds === 'object'
    ? communication.providerIds
    : {}
  const proof = communication.proof && typeof communication.proof === 'object'
    ? communication.proof
    : {}
  const phone = normalizePhone(
    firstSafeValue(
      identity.phone,
      identity.fromPhone,
      identity.from_phone,
      identity.fromPhones,
      identity.from_phones,
      communication.fromPhone,
      communication.from_phone,
      communication.fromPhones,
      communication.from_phones,
      communication.from,
      providerIds.fromPhone,
      providerIds.from_phone,
      providerIds.fromPhones,
      providerIds.from_phones,
      providerIds.from,
      proof.fromPhone,
      proof.from_phone,
      proof.fromPhones,
      proof.from_phones,
      proof.from,
    ),
  )
  const status = safeLeadText(communication.status || proof.status || proof.event_type)
  return [
    'Missed inbound call',
    phone ? `from ${maskPhone(phone)}` : '',
    status ? `(${status})` : '',
  ]
    .filter(Boolean)
    .join(' ')
}

async function applyInboundAutomationPolicy({
  channel,
  context = null,
  eventType = '',
  policy,
  providerPayload = {},
  recorded,
  subject = '',
  target = '',
} = {}) {
  if (!policy?.enabled || !recorded?.thread?.contactId || !recorded?.message?.messageId) {
    return null
  }
  if (shutdownStarted) return null
  if (channel === 'sms' && policy.action === 'send_sms') {
    return trackDeliveryOperation(recordAutomatedSmsReply({ policy, recorded, target }))
  }
  if (channel === 'email' && policy.action === 'send_email') {
    return trackDeliveryOperation(
      recordAutomatedEmailReply({ policy, recorded, subject, target }),
    )
  }
  if (channel === 'call' && policy.action === 'answer_call') {
    return trackDeliveryOperation(
      answerInboundCallWithAutomation({
        context,
        eventType,
        policy,
        providerPayload,
        recorded,
        target,
      }),
    )
  }
  return null
}

async function answerInboundCallWithAutomation({
  context = null,
  eventType = '',
  policy,
  providerPayload = {},
  recorded,
  target = '',
} = {}) {
  const callControlId = safeLeadText(providerPayload.call_control_id)
  if (!callControlId || calls.has(callControlId)) return null

  const sourceLead = context?.lead || {}
  const sourceProfile = context?.profile || {}
  const profileConfig = sourceProfile?.config || {}
  let runtimeConfig = normalizeCampaignConfig({
    ...profileConfig,
    agentProfileId:
      sourceProfile?.id ||
      profileConfig.agentProfileId ||
      recorded?.thread?.agentProfileId,
    agentProfileName:
      sourceProfile?.name ||
      profileConfig.agentProfileName ||
      profileConfig.name,
  })
  try {
    runtimeConfig = await ensureVoiceRuntimeReady(runtimeConfig, {
      syncProvider: isInworldRuntime(runtimeConfig) || isXaiRuntime(runtimeConfig),
    })
  } catch (error) {
    return recordAutomationFailure({
      channel: 'call',
      error,
      policy,
      recorded,
    })
  }
  const missing = missingForCall(runtimeConfig)
  const streamUrl = getStreamUrl()
  if (missing.length > 0 || !streamUrl) {
    const missingNames = [
      ...missing.map(publicRuntimeConfigName),
      ...(!streamUrl ? ['VOICE_STREAM_URL'] : []),
    ]
    return recordAutomationFailure({
      channel: 'call',
      error: new Error(`Voice backend is not configured: ${missingNames.join(', ')}`),
      policy,
      recorded,
    })
  }

  const contactPhone = normalizePhone(
    target ||
      providerPayload.from ||
      providerPayload.from_number ||
      providerPayload.caller_id_number ||
      providerPayload.cli ||
      sourceLead.phone,
  )
  const normalizedLead = normalizeLead({
    ...sourceLead,
    id: recorded.thread.contactId || sourceLead.id,
    phone: contactPhone || sourceLead.phone,
  })
  const runtimeContext = await resolveWorkspaceRuntimeContext({
    lead: normalizedLead,
    config: runtimeConfig,
  })
  const leadForCall = normalizeLead(runtimeContext.lead)
  runtimeConfig.profileContext = runtimeContext.profileContext
  const clientState = Buffer.from(
    JSON.stringify({
      lead: {
        id: leadForCall.id,
        firstName: leadForCall.firstName,
        lastName: leadForCall.lastName,
        name: leadForCall.name,
        company: leadForCall.company,
        phone: leadForCall.phone,
        email: leadForCall.email,
      },
      config: {
        voiceRuntimeProvider: runtimeConfig.voiceRuntimeProvider,
        agentProfileId: runtimeConfig.agentProfileId,
        agentProfileName: runtimeConfig.agentProfileName,
        humeConfigId: runtimeConfig.humeConfigId,
        inworldConfigId: runtimeConfig.inworldConfigId,
        sampleRate: runtimeConfig.sampleRate,
        telnyxStreamCodec: runtimeConfig.telnyxStreamCodec,
        verboseTranscription: runtimeConfig.verboseTranscription,
      },
    }),
  ).toString('base64')

  try {
    const telnyxResponse = await fetch(
      `${TELNYX_API_BASE}/calls/${encodeURIComponent(callControlId)}/actions/answer`,
      {
        method: 'POST',
        headers: telnyxHeaders(),
        body: JSON.stringify({
          stream_url: streamUrl,
          stream_track: 'inbound_track',
          stream_codec: runtimeConfig.telnyxStreamCodec,
          stream_bidirectional_mode: 'rtp',
          stream_bidirectional_codec: runtimeConfig.telnyxStreamCodec,
          stream_bidirectional_sampling_rate: runtimeConfig.sampleRate,
          stream_bidirectional_target_legs: 'self',
          send_silence_when_idle: true,
          webhook_url: getTelnyxWebhookUrl(),
          webhook_url_method: 'POST',
          client_state: clientState,
        }),
      },
    )
    const payload = await readJson(telnyxResponse)
    if (!telnyxResponse.ok) {
      return recordAutomationFailure({
        channel: 'call',
        error: new Error(providerError('Inbound call auto-answer failed', payload)),
        policy,
        recorded,
      })
    }

    const state = createCallState(callControlId, leadForCall, runtimeConfig, [])
    state.callProvider = 'telnyx_texml'
    state.callSessionId = safeLeadText(payload?.data?.call_session_id || providerPayload.call_session_id)
    state.inbound = true
    state.contactConversationMemory = await readVoiceContactConversationMemory(
      leadForCall,
    )
    recordTransportMilestone(state, 'telnyx_inbound_answer_accepted', {
      callSessionId: state.callSessionId,
      eventType: safeLeadText(eventType),
    })
    calls.set(callControlId, state)
    connectVoiceSession(state)
    persistWorkspaceLeadPatch(state, {
      ...leadForCall,
      status: 'calling',
      lastCall: 'Inbound in progress',
    })
    emitCallEvent(callControlId, {
      diagnostic: buildTransportDiagnosticSnapshot(state),
      entry: transcriptEntry(
        'System',
        `Phone provider accepted the inbound call answer for ${leadForCall.name}.`,
        'system',
      ),
      notice: 'Inbound call answer accepted',
    })

    return recordCommunicationEvent({
      callControlId,
      channel: 'call',
      createdAt: new Date().toISOString(),
      event: {
        communication: {
          threadId: recorded.thread.threadId,
          contactId: recorded.thread.contactId,
          agentProfileId: recorded.thread.agentProfileId,
          channel: 'call',
          modality: 'status',
          direction: 'system',
          role: 'system',
          body: 'Inbound call auto-answer started.',
          provider: 'telnyx',
          at: new Date().toISOString(),
          providerIds: cleanObject({
            callControlId,
            callSessionId: state.callSessionId,
            automationSourceMessageId: recorded.message.messageId,
          }),
          proof: cleanObject({
            provider: 'telnyx',
            call_control_id: callControlId,
            call_session_id: state.callSessionId,
            status: payload?.data?.status || payload?.status || 'accepted',
            automation: {
              ...automationProof(policy),
              action: 'auto_answer_started',
              originMessageId: recorded.message.messageId,
            },
          }),
        },
      },
    })
  } catch (error) {
    return recordAutomationFailure({ channel: 'call', error, policy, recorded })
  }
}

async function recordAutomatedSmsReply({ policy, recorded, target }) {
  const phone = normalizePhone(target)
  if (!phone || !policy.body) return null
  try {
    const sms = await sendTextMessage(phone, policy.body)
    const messageId = safeLeadText(sms.id || sms.message_id || sms.messageId)
    const automation = {
      ...automationProof(policy),
      action: 'auto_reply_provider_accepted',
      originMessageId: recorded.message.messageId,
    }
    const result = await recordCommunicationEvent({
      channel: 'sms',
      createdAt: new Date().toISOString(),
      event: {
        communication: {
          threadId: recorded.thread.threadId,
          contactId: recorded.thread.contactId,
          agentProfileId: recorded.thread.agentProfileId,
          channel: 'sms',
          modality: 'text',
          direction: 'outbound',
          role: 'agent',
          body: policy.body,
          provider: 'telnyx',
          at: new Date().toISOString(),
          identity: {
            phone,
          },
          providerIds: cleanObject({
            messageId,
            fromPhone: getTelnyxSmsFrom(),
            toPhone: phone,
            replyToMessageId: recorded.message.messageId,
            automationSourceMessageId: recorded.message.messageId,
          }),
          proof: cleanObject({
            ...smsProviderAcceptanceProof({ phone, sms }),
            automation,
          }),
        },
      },
    })
    queueSmsDeliveryFinalizationRecord({
      agentProfileId: recorded.thread.agentProfileId,
      automation,
      contactId: recorded.thread.contactId,
      phone,
      replyToMessageId: recorded.message.messageId,
      sms,
      text: policy.body,
      threadId: recorded.thread.threadId,
    })
    return result
  } catch (error) {
    return recordAutomationFailure({ channel: 'sms', error, policy, recorded })
  }
}

function smsProviderAcceptanceProof({ phone, sms } = {}) {
  const messageId = safeLeadText(sms?.id || sms?.message_id || sms?.messageId)
  const providerStatus = safeLeadText(sms?.to?.[0]?.status || sms?.status || 'queued')
    .toLowerCase()
  return cleanObject({
    provider: 'telnyx',
    to: maskPhone(phone),
    from: getTelnyxSmsFrom(),
    message_id: messageId,
    status: 'provider_accepted',
    provider_status: providerStatus,
    provider_accepted: true,
    delivery_finalized: false,
    sent: false,
  })
}

function queueSmsDeliveryFinalizationRecord({
  agentProfileId = '',
  automation = null,
  contactId = '',
  lead = {},
  phone = '',
  replyToMessageId = '',
  sms = {},
  text = '',
  threadId = '',
} = {}) {
  const messageId = safeLeadText(sms.id || sms.message_id || sms.messageId)
  const operation = waitForTelnyxSmsFinalization(sms)
    .catch(() => ({
      delivery_finalized: false,
      error: 'Final SMS delivery proof could not be verified.',
      message_id: messageId,
      provider_accepted: Boolean(messageId),
      provider_status: safeLeadText(sms?.to?.[0]?.status || sms?.status || 'queued'),
      sent: false,
      status: 'accepted_unverified',
    }))
    .then((finalization) => {
      const automationAction = automation
        ? finalization.sent
          ? 'auto_reply_delivered'
          : finalization.status === 'failed'
            ? 'auto_reply_failed'
            : 'auto_reply_accepted_unverified'
        : ''
      const proof = cleanObject({
        provider: 'telnyx',
        to: maskPhone(phone),
        from: getTelnyxSmsFrom(),
        message_id: messageId,
        status: finalization.status,
        provider_status: finalization.provider_status,
        provider_accepted: finalization.provider_accepted,
        delivery_finalized: finalization.delivery_finalized,
        sent: finalization.sent,
        error_code: finalization.error_code,
        errors: finalization.errors,
        reason: finalization.reason,
        error: finalization.error,
        automation: automation
          ? {
              ...automation,
              action: automationAction,
            }
          : undefined,
      })
      return recordCommunicationEvent({
        channel: 'sms',
        lead,
        createdAt: new Date().toISOString(),
        event: {
          communication: {
            threadId,
            contactId,
            agentProfileId,
            channel: 'sms',
            modality: 'text',
            direction: 'outbound',
            role: 'agent',
            body: text,
            provider: 'telnyx',
            at: new Date().toISOString(),
            identity: {
              phone,
            },
            providerIds: cleanObject({
              messageId,
              fromPhone: getTelnyxSmsFrom(),
              toPhone: phone,
              replyToMessageId,
              automationSourceMessageId: automation?.originMessageId,
            }),
            proof,
          },
        },
      })
    })
  trackDeliveryOperation(operation)
  return operation
}

async function recordAutomatedEmailReply({ policy, recorded, target }) {
  const email = cleanEmail(target)
  if (!email || !policy.body || !policy.subject) return null
  try {
    const emailResult = await sendEmail(email, policy.subject, policy.body)
    const messageId = safeLeadText(
      emailResult.id || emailResult.messageId || emailResult.message_id,
    )
    const emailThreadId = safeLeadText(emailResult.threadId || emailResult.thread_id)
    return recordCommunicationEvent({
      channel: 'email',
      createdAt: new Date().toISOString(),
      event: {
        communication: {
          threadId: recorded.thread.threadId,
          contactId: recorded.thread.contactId,
          agentProfileId: recorded.thread.agentProfileId,
          channel: 'email',
          modality: 'text',
          direction: 'outbound',
          role: 'agent',
          body: `Subject: ${policy.subject}\n\n${policy.body}`,
          provider: 'google_workspace',
          at: new Date().toISOString(),
          identity: {
            email,
            externalThreadId: emailThreadId,
          },
          providerIds: cleanObject({
            messageId,
            emailThreadId,
            fromEmail: getWorkspaceEmailAccount(),
            toEmail: email,
            replyToMessageId: recorded.message.messageId,
            automationSourceMessageId: recorded.message.messageId,
          }),
          proof: cleanObject({
            provider: 'google_workspace',
            to: maskEmail(email),
            from: getWorkspaceEmailAccount(),
            message_id: messageId,
            thread_id: emailThreadId,
            automation: {
              ...automationProof(policy),
              action: 'auto_reply_sent',
              originMessageId: recorded.message.messageId,
            },
          }),
        },
      },
    })
  } catch (error) {
    return recordAutomationFailure({ channel: 'email', error, policy, recorded })
  }
}

async function recordAutomationFailure({ channel, error, policy, recorded }) {
  const provider = channel === 'email' ? 'google_workspace' : 'telnyx'
  const action = channel === 'call' ? 'auto_answer_failed' : 'auto_reply_failed'
  const body =
    channel === 'call'
      ? 'Inbound call auto-answer failed.'
      : `${channel.toUpperCase()} auto-response failed.`
  return recordCommunicationEvent({
    channel,
    createdAt: new Date().toISOString(),
    event: {
      communication: {
        threadId: recorded.thread.threadId,
        contactId: recorded.thread.contactId,
        agentProfileId: recorded.thread.agentProfileId,
        channel,
        modality: 'status',
        direction: 'system',
        role: 'system',
        body,
        provider,
        at: new Date().toISOString(),
        providerIds: cleanObject({
          automationSourceMessageId: recorded.message.messageId,
        }),
        proof: {
          automation: {
            ...automationProof(policy),
            action,
            error: safeLeadText(error instanceof Error ? error.message : String(error)).slice(0, 240),
            originMessageId: recorded.message.messageId,
          },
        },
      },
    },
  })
}

function isMissedInboundCommunicationEvent(input = {}, message = {}) {
  const communication = input?.event?.communication || {}
  const proof = communication.proof && typeof communication.proof === 'object'
    ? communication.proof
    : {}
  const messageProof = message.proof && typeof message.proof === 'object'
    ? message.proof
    : {}
  const text = [
    input.eventType,
    input.event_type,
    communication.body,
    communication.status,
    communication.action,
    proof.action,
    proof.status,
    proof.reason,
    proof.hangup_cause,
    message.body,
    messageProof.action,
    messageProof.status,
    messageProof.reason,
    messageProof.hangup_cause,
  ]
    .map((item) => safeLeadText(item).toLowerCase())
    .filter(Boolean)
    .join(' ')
  return /\b(missed|no[_ -]?answer|unanswered|hangup|ended|completed)\b/.test(text)
}

function genericProviderPayloadFromCommunicationEvent(input = {}) {
  const communication = input?.event?.communication || {}
  const providerIds = communication.providerIds && typeof communication.providerIds === 'object'
    ? communication.providerIds
    : {}
  const proof = communication.proof && typeof communication.proof === 'object'
    ? communication.proof
    : {}
  return cleanObject({
    call_control_id:
      input.callControlId ||
      input.call_control_id ||
      providerIds.callControlId ||
      providerIds.call_control_id ||
      proof.call_control_id,
    call_session_id:
      input.callSessionId ||
      input.call_session_id ||
      providerIds.callSessionId ||
      providerIds.call_session_id ||
      proof.call_session_id,
    from: firstSafeValue(
      communication.identity?.phone,
      communication.identity?.fromPhone,
      communication.identity?.from_phone,
      communication.identity?.fromPhones,
      communication.identity?.from_phones,
      providerIds.fromPhone,
      providerIds.from_phone,
      providerIds.fromPhones,
      providerIds.from_phones,
      proof.fromPhone,
      proof.fromPhones,
      proof.from,
    ),
    to: firstSafeValue(
      providerIds.toPhone,
      providerIds.to_phone,
      providerIds.toPhones,
      providerIds.to_phones,
      proof.toPhone,
      proof.toPhones,
      proof.to,
    ),
  })
}

function communicationEventTargetValue(input = {}, message = null, channel = '') {
  const communication = input?.event?.communication || {}
  const providerIds = communication.providerIds && typeof communication.providerIds === 'object'
    ? communication.providerIds
    : {}
  const proof = communication.proof && typeof communication.proof === 'object'
    ? communication.proof
    : {}
  const identity = communication.identity && typeof communication.identity === 'object'
    ? communication.identity
    : {}
  const normalizedChannel = safeLeadText(channel || input.channel || communication.channel).toLowerCase()
  const inbound =
    safeLeadText(communication.direction || message?.direction).toLowerCase() === 'inbound' ||
    message?.direction === 'inbound' ||
    message?.role === 'contact' ||
    message?.role === 'user'

  if (normalizedChannel === 'sms' || normalizedChannel === 'call') {
    const value = inbound
      ? firstSafeValue(
          identity.phone,
          identity.phones,
          identity.fromPhone,
          identity.from_phone,
          identity.fromPhones,
          identity.from_phones,
          communication.phone,
          communication.phones,
          communication.fromPhone,
          communication.from_phone,
          communication.fromPhones,
          communication.from_phones,
          communication.from,
          providerIds.fromPhone,
          providerIds.from_phone,
          providerIds.fromPhones,
          providerIds.from_phones,
          providerIds.from,
          proof.fromPhone,
          proof.from_phone,
          proof.fromPhones,
          proof.from_phones,
          proof.from,
        )
      : firstSafeValue(
          identity.phone,
          identity.phones,
          identity.toPhone,
          identity.to_phone,
          identity.toPhones,
          identity.to_phones,
          communication.phone,
          communication.phones,
          communication.toPhone,
          communication.to_phone,
          communication.toPhones,
          communication.to_phones,
          communication.to,
          providerIds.toPhone,
          providerIds.to_phone,
          providerIds.toPhones,
          providerIds.to_phones,
          providerIds.to,
          proof.toPhone,
          proof.to_phone,
          proof.toPhones,
          proof.to_phones,
          proof.to,
        )
    return value || communicationMessageTargetValue(message, normalizedChannel)
  }

  if (normalizedChannel === 'email') {
    const value = inbound
      ? firstCleanEmail(
          identity.email,
          identity.emails,
          identity.fromEmail,
          identity.from_email,
          identity.fromEmails,
          identity.from_emails,
          communication.email,
          communication.emails,
          communication.fromEmail,
          communication.from_email,
          communication.fromEmails,
          communication.from_emails,
          communication.from,
          providerIds.fromEmail,
          providerIds.from_email,
          providerIds.fromEmails,
          providerIds.from_emails,
          providerIds.from,
          proof.fromEmail,
          proof.from_email,
          proof.fromEmails,
          proof.from_emails,
          proof.from,
        )
      : firstCleanEmail(
          identity.email,
          identity.emails,
          identity.toEmail,
          identity.to_email,
          identity.toEmails,
          identity.to_emails,
          communication.email,
          communication.emails,
          communication.toEmail,
          communication.to_email,
          communication.toEmails,
          communication.to_emails,
          communication.to,
          providerIds.toEmail,
          providerIds.to_email,
          providerIds.toEmails,
          providerIds.to_emails,
          providerIds.to,
          proof.toEmail,
          proof.to_email,
          proof.toEmails,
          proof.to_emails,
          proof.to,
        )
    return value || communicationMessageTargetValue(message, normalizedChannel)
  }

  return communicationMessageTargetValue(message, normalizedChannel)
}

function emailSubjectFromCommunicationBody(body) {
  const text = safeLeadText(body)
  const match = text.match(/^\s*Subject:\s*(.+?)\s*(?:\n|$)/i)
  return safeLeadText(match?.[1])
}

function workspaceEmailList(...values) {
  const emails = []
  const seen = new Set()
  values.forEach((value) => {
    extractWorkspaceEmails(value).forEach((email) => {
      if (!email || seen.has(email)) return
      seen.add(email)
      emails.push(email)
    })
  })
  return emails
}

function extractWorkspaceEmails(value) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => extractWorkspaceEmails(item))
  }
  if (value && typeof value === 'object') {
    return extractWorkspaceEmails(
      value.email ||
        value.address ||
        value.value ||
        value.name,
    )
  }
  return Array.from(
    String(value || '').matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi),
  )
    .map((match) => cleanEmail(match[0]))
    .filter(Boolean)
}

function communicationMessageTargetValue(message = null, channel = '') {
  if (!message || typeof message !== 'object') return ''
  const providerIds = message.providerIds && typeof message.providerIds === 'object'
    ? message.providerIds
    : {}
  const proof = message.proof && typeof message.proof === 'object' ? message.proof : {}
  const inbound =
    message.direction === 'inbound' ||
    message.role === 'contact' ||
    message.role === 'user'
  if (channel === 'sms') {
    return inbound
      ? firstSafeValue(
          providerIds.fromPhone,
          providerIds.from_phone,
          providerIds.fromPhones,
          providerIds.from_phones,
          providerIds.from,
          proof.fromPhone,
          proof.from_phone,
          proof.fromPhones,
          proof.from_phones,
          proof.from,
        )
      : firstSafeValue(
          providerIds.toPhone,
          providerIds.to_phone,
          providerIds.toPhones,
          providerIds.to_phones,
          providerIds.to,
          proof.toPhone,
          proof.to_phone,
          proof.toPhones,
          proof.to_phones,
          proof.to,
        )
  }
  if (channel === 'email') {
    return inbound
      ? firstCleanEmail(
          providerIds.fromEmail,
          providerIds.from_email,
          providerIds.fromEmails,
          providerIds.from_emails,
          providerIds.from,
          proof.fromEmail,
          proof.from_email,
          proof.fromEmails,
          proof.from_emails,
          proof.from,
        )
      : firstCleanEmail(
          providerIds.toEmail,
          providerIds.to_email,
          providerIds.toEmails,
          providerIds.to_emails,
          providerIds.to,
          proof.toEmail,
          proof.to_email,
          proof.toEmails,
          proof.to_emails,
          proof.to,
        )
  }
  return ''
}

function firstSafeValue(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      const nested = firstSafeValue(...value)
      if (nested) return nested
      continue
    }
    if (value && typeof value === 'object') {
      const nested = firstSafeValue(
        value.phone,
        value.phoneNumber,
        value.phone_number,
        value.number,
        value.address,
        value.email,
        value.value,
      )
      if (nested) return nested
      continue
    }
    const text = safeLeadText(value)
    if (text) return text
  }
  return ''
}

function firstCleanEmail(...values) {
  return workspaceEmailList(
    ...values.filter((value) => {
      if (Array.isArray(value) || (value && typeof value === 'object')) return true
      return !/[*•…]/.test(safeLeadText(value))
    }),
  )[0] || ''
}

function phoneEventTranscriptText(eventType, providerEvent = {}) {
  const detail = [
    providerEvent.hangup_cause,
    providerEvent.hangup_source,
    providerEvent.cause,
    providerEvent.reason,
    providerEvent.sip_hangup_cause,
    providerEvent.sip_hangup_phrase,
  ]
    .filter(Boolean)
    .join(' / ')

  return detail ? `Phone event: ${eventType} (${detail})` : `Phone event: ${eventType}`
}

app.post('/api/webhooks/hume', (_request, response) => {
  response.json({ ok: true })
})

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '/', `http://${request.headers.host}`)
  const pathname = stripBasePathFromPathname(url.pathname)
  const humanMatch = pathname.match(/^\/api\/calls\/(.+)\/human-audio$/)
  const supervisionMatch = pathname.match(/^\/api\/calls\/(.+)\/supervision$/)
  const browserTestMatch = pathname.match(/^\/api\/config-tests\/(.+)\/audio$/)

  if (pathname === '/media-stream') {
    const personalPhoneHandoffToken = url.searchParams.get('personalPhoneHandoff') || ''
    if (personalPhoneHandoffToken) {
      const handoff = personalPhoneInboundHandoffs.consume(personalPhoneHandoffToken)
      if (!handoff) {
        socket.destroy()
        return
      }
      request.personalPhoneInboundHandoff = handoff
    }
    telnyxMediaWss.handleUpgrade(request, socket, head, (ws) => {
      telnyxMediaWss.emit('connection', ws, request)
    })
    return
  }

  if (pathname === '/api/calltools/media-gateway') {
    try {
      assertCallToolsGatewaySecret(url.searchParams.get('token') || request.headers['x-calltools-gateway-token'])
    } catch (_error) {
      socket.destroy()
      return
    }
    calltoolsMediaGatewayWss.handleUpgrade(request, socket, head, (ws) => {
      calltoolsMediaGatewayWss.emit('connection', ws, request)
    })
    return
  }

  if (humanMatch) {
    request.callControlId = decodeURIComponent(humanMatch[1])
    request.playgroundSupervisionToken = url.searchParams.get('token') || ''
    const state = getCallState(request.callControlId)
    if (
      state?.origin === 'playground_phone' &&
      request.playgroundSupervisionToken !== state.playgroundSupervisionToken
    ) {
      socket.destroy()
      return
    }
    humanAudioWss.handleUpgrade(request, socket, head, (ws) => {
      humanAudioWss.emit('connection', ws, request)
    })
    return
  }

  if (supervisionMatch) {
    request.callControlId = decodeURIComponent(supervisionMatch[1])
    request.playgroundSupervisionToken = url.searchParams.get('token') || ''
    const state = getCallState(request.callControlId)
    if (
      !playgroundCallSupervision.canAttach(
        state,
        request.playgroundSupervisionToken,
      )
    ) {
      socket.destroy()
      return
    }
    playgroundSupervisionWss.handleUpgrade(request, socket, head, (ws) => {
      playgroundSupervisionWss.emit('connection', ws, request)
    })
    return
  }

  if (browserTestMatch) {
    request.testId = decodeURIComponent(browserTestMatch[1])
    browserTestWss.handleUpgrade(request, socket, head, (ws) => {
      browserTestWss.emit('connection', ws, request)
    })
    return
  }

  socket.destroy()
})

telnyxMediaWss.on('connection', (ws, request) => {
  let state = null
  const personalPhoneInboundHandoff = request.personalPhoneInboundHandoff || null

  ws.on('message', (raw) => {
    void handleTelnyxMessage(
      ws,
      raw,
      (nextState) => {
        state = nextState
      },
      personalPhoneInboundHandoff,
    )
  })

  ws.on('close', () => {
    if (!state) return
    const outcomeEvent = state.outcome
      ? null
      : setCallOutcome(state, inferStreamStopOutcome(state))
    clearTelnyxOutboundQueue(state, { sendClear: false })
    state.telnyxWs = null
    if (state.personalPhoneInboundCorrelationId) {
      if (state.ending || state.hangupRequestedAt) {
        personalPhoneInboundHandoffs.markTerminal(
          state.personalPhoneInboundCorrelationId,
          'agent_hangup',
          'agent_hangup',
        )
      } else if (
        state.leadUtteranceCount > 0 ||
        state.assistantUtteranceCount > 0
      ) {
        personalPhoneInboundHandoffs.markTerminal(
          state.personalPhoneInboundCorrelationId,
          'caller_hangup',
          'caller_hangup',
        )
      }
    }
    if (outcomeEvent) emitCallEvent(state.callControlId, outcomeEvent)
    persistCallOutcome(state, state.outcome)
    emitCallEvent(state.callControlId, {
      patch: { phase: 'ended', takeover: false, outcome: state.outcome },
      entry: transcriptEntry('System', 'Phone media stream disconnected.', 'system'),
      notice: 'Phone stream disconnected',
    })
  })
})

calltoolsMediaGatewayWss.on('connection', (ws) => {
  let state = null
  let messageQueue = Promise.resolve()

  ws.on('message', (raw) => {
    messageQueue = messageQueue
      .then(() => handleCallToolsGatewayMessage(ws, raw, (nextState) => {
        state = nextState
      }))
      .catch((error) => {
        if (ws.readyState !== WebSocket.OPEN) return
        ws.send(
          JSON.stringify({
            type: 'error',
            error: error instanceof Error ? error.message : 'CallTools gateway message failed',
          }),
        )
      })
  })

  ws.on('close', () => {
    ws.speakClosing = true
    const closeDrain = messageQueue
      .then(() => handleCallToolsGatewayClose(ws, state))
      .catch((error) => {
        console.warn(
          'CallTools gateway close cleanup failed:',
          error instanceof Error ? error.message : String(error),
        )
      })
    messageQueue = closeDrain
    calltoolsGatewayDrainPromises.add(closeDrain)
    void closeDrain.then(() => {
      calltoolsGatewayDrainPromises.delete(closeDrain)
    })
  })
})

async function handleCallToolsGatewayClose(ws, state) {
  removeCallToolsGatewayRegistry(ws)
  if (!state) return
  state.calltoolsWs = null
  if (state.calltoolsGatewayEnded) return
  const outcomeEvent = state.outcome
    ? null
    : setCallOutcome(state, inferStreamStopOutcome(state))
  state.ending = true
  closeCallSockets(state)
  persistCallOutcome(state, state.outcome)
  emitCallEvent(state.callControlId, {
    patch: { phase: 'ended', takeover: false, outcome: state.outcome },
    communication: callToolsCommunicationMetadata(state, {}, state.calltoolsContext),
    entry: transcriptEntry('System', 'CallTools media gateway disconnected.', 'system'),
    notice: 'CallTools media gateway disconnected',
  })
  if (outcomeEvent) emitCallEvent(state.callControlId, outcomeEvent)
  reconcileCallToolsHistoricalCallAfterClose(state)
  scheduleCallToolsRecordingReconciliation(state)
}

humanAudioWss.on('connection', (ws, request) => {
  const state = getCallState(request.callControlId)

  if (
    state?.origin === 'playground_phone' &&
    request.playgroundSupervisionToken !== state.playgroundSupervisionToken
  ) {
    ws.close(1008, 'Playground Phone authorization failed')
    return
  }

  if (
    !(
      state?.telnyxWs?.readyState === WebSocket.OPEN ||
      state?.calltoolsWs?.readyState === WebSocket.OPEN
    )
  ) {
    ws.close(1011, 'Phone stream is not attached')
    return
  }

  state.humanWs = ws
  emitCallEvent(state.callControlId, {
    entry: transcriptEntry('System', 'Human microphone stream connected.', 'system'),
    notice: 'Human microphone connected',
  })

  ws.on('message', (raw) => {
    if (!state.takeover) return
    sendHumanPcmToPhone(state, Buffer.from(raw))
  })

  ws.on('close', () => {
    if (state.humanWs === ws) {
      state.humanWs = null
    }
  })
})

playgroundSupervisionWss.on('connection', (ws, request) => {
  playgroundCallSupervision.attach(
    ws,
    getCallState(request.callControlId),
    request.playgroundSupervisionToken,
  )
})

browserTestWss.on('connection', (ws, request) => {
  const state = getCallState(request.testId)

  if (!state?.browserTest || !state.browserAudioAttachPending) {
    ws.close(1011, 'Playground test session is not available')
    return
  }

  state.browserWs = ws
  state.browserAudioAttachPending = false
  flushBrowserAudioBeforeAttach(state, ws)
  emitCallEvent(state.callControlId, {
    entry: transcriptEntry('System', 'Test microphone stream connected.', 'system'),
    notice: 'Test microphone connected',
  })

  ws.on('message', (raw) => {
    sendAudioToVoiceProvider(state, Buffer.from(raw))
  })

  ws.on('close', () => {
    if (state.browserWs === ws) state.browserWs = null
    closeCallSockets(state)
    persistCallOutcome(state, state.outcome)
    emitCallEvent(state.callControlId, {
      patch: { phase: 'ended', outcome: state.outcome || 'operator-ended' },
      entry: transcriptEntry('System', 'Test microphone stream closed.', 'system'),
      notice: 'Test microphone closed',
    })
  })
})

app.use(express.static(distPath))
app.get(/^\/(?!api\/).*/, (_request, response) => {
  response.sendFile(path.join(distPath, 'index.html'))
})

await backgroundDeliveryOutbox.start()

server.listen(PORT, () => {
  console.log(`Voice backend listening on http://127.0.0.1:${PORT}${BASE_PATH}`)
  callToolsDutyMonitor.start()
  callToolsCallWatchdog.start()
  if (process.env.NODE_ENV !== 'test') {
    void refreshWorkspaceEmailReadiness({ force: true })
      .then((readiness) => {
        if (!readiness.emailConfigured) {
          console.warn('Workspace email readiness is unavailable; background retry remains enabled.')
        }
      })
      .catch((error) => {
        console.warn(
          'Workspace email readiness refresh failed:',
          error instanceof Error ? error.message : String(error),
        )
      })
    void prewarmCodexVoiceRuntimeReadiness().catch((error) => {
      console.warn(
        'Codex voice runtime prewarm failed:',
        error instanceof Error ? error.message : String(error),
      )
    })
    void prewarmInworldModelCatalog().catch((error) => {
      console.warn(
        'Inworld model catalog prewarm failed:',
        error instanceof Error ? error.message : String(error),
      )
    })
    void prewarmXaiVoiceCatalog().catch((error) => {
      console.warn(
        'xAI voice catalog prewarm failed:',
        error instanceof Error ? error.message : String(error),
      )
    })
  }
})

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    void shutdownVoiceBackend(signal)
  })
}

async function shutdownVoiceBackend(signal) {
  if (shutdownStarted) return
  shutdownStarted = true
  callToolsVoiceStandby.cancel('shutdown')
  provisionalVoiceSessions.cancelAll('shutdown')
  callToolsCallWatchdog.stop()
  callToolsDutyMonitor.stop()
  const deliveryFlushTimeoutMs = Math.max(
    60_000,
    Math.max(
      numberEnv('WORKSPACE_EMAIL_TIMEOUT_MS', 45_000),
      numberEnv('TELNYX_SMS_TIMEOUT_MS', 15_000),
    ) + 15_000,
  )
  const forcedExit = setTimeout(() => {
    console.error(`Voice backend ${signal} flush timed out`)
    process.exit(1)
  }, deliveryFlushTimeoutMs)
  const httpServerClosed = beginHttpServerShutdown()
  try {
    await quiesceVoiceBackendWebSockets()
    await backgroundDeliveryOutbox.close({ drain: true })
    await drainDeliveryOperations()
    await httpServerClosed
    await drainDeliveryOperations()
    await Promise.allSettled(Array.from(calltoolsGatewayDrainPromises))
    await Promise.all([
      flushPendingCallCommunicationEvents(),
      flushPersistedCallEvents(),
    ])
    clearTimeout(forcedExit)
    process.exit(0)
  } catch (error) {
    clearTimeout(forcedExit)
    console.error(
      'Voice backend shutdown flush failed:',
      error instanceof Error ? error.message : error,
    )
    process.exit(1)
  }
}

function beginHttpServerShutdown() {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
    server.closeIdleConnections?.()
  })
}

async function quiesceVoiceBackendWebSockets() {
  for (const clients of sseClients.values()) {
    for (const response of clients) {
      try {
        response.end()
      } catch {
        // The client already closed while shutdown was quiescing streams.
      }
    }
  }
  sseClients.clear()
  const servers = [
    telnyxMediaWss,
    calltoolsMediaGatewayWss,
    humanAudioWss,
    playgroundSupervisionWss,
    browserTestWss,
  ]
  const closes = []
  for (const websocketServer of servers) {
    for (const ws of websocketServer.clients) {
      if (ws.readyState === WebSocket.CLOSED) continue
      closes.push(
        new Promise((resolve) => {
          ws.once('close', resolve)
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close(1012, 'Speak service restart')
          }
        }),
      )
    }
  }
  if (!closes.length) {
    await new Promise((resolve) => setImmediate(resolve))
    return
  }
  await Promise.race([
    Promise.allSettled(closes),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ])
  for (const websocketServer of servers) {
    for (const ws of websocketServer.clients) {
      if (ws.readyState !== WebSocket.CLOSED) ws.terminate()
    }
  }
  await new Promise((resolve) => setImmediate(resolve))
}

async function drainDeliveryOperations() {
  while (deliveryDrainPromises.size > 0) {
    await Promise.allSettled(Array.from(deliveryDrainPromises))
  }
}

function stripBasePath(request, _response, next) {
  if (BASE_PATH) {
    request.url = stripBasePathFromPathname(request.url)
  }
  next()
}

function cacheCallToolsGatewayLeaseOwner(duty = {}) {
  const binding = normalizeDutyBinding(duty.binding)
  callToolsGatewayLeaseOwner = isActiveCallToolsDuty(duty)
    ? {
        gatewayOwnerInstanceId: safeLeadText(duty.gatewayOwnerInstanceId),
        leaseId: safeLeadText(duty.leaseId),
        phoneId: binding.phoneId,
        profileId: safeLeadText(duty.profileId),
      }
    : {
        gatewayOwnerInstanceId: '',
        leaseId: '',
        phoneId: '',
        profileId: '',
      }
  return callToolsGatewayLeaseOwner
}

function callToolsGatewayOwnerInstanceId(profileId = '', phoneId = '') {
  if (
    safeLeadText(profileId) !== callToolsGatewayLeaseOwner.profileId ||
    safeLeadText(phoneId) !== callToolsGatewayLeaseOwner.phoneId
  ) return ''
  return callToolsGatewayLeaseOwner.gatewayOwnerInstanceId
}

function assertCallToolsGatewayInstance(ws, message = {}) {
  const gatewayInstanceId = safeLeadText(message.gatewayInstanceId)
  if (!gatewayInstanceId) {
    throw Object.assign(new Error('CallTools gateway instance identity is required'), {
      code: 'calltools_gateway_instance_required',
    })
  }
  const existing = calltoolsGatewayRegistry.get(ws)
  if (
    existing?.gatewayInstanceId &&
    existing.gatewayInstanceId !== gatewayInstanceId
  ) {
    throw Object.assign(new Error('CallTools gateway instance identity changed'), {
      code: 'calltools_gateway_instance_changed',
    })
  }
  return gatewayInstanceId
}

function updateCallToolsGatewayRegistry(ws, metadata = {}) {
  const now = new Date().toISOString()
  const existing = calltoolsGatewayRegistry.get(ws) || {}
  const next = {
    gatewayInstanceId: safeLeadText(
      existing.gatewayInstanceId || metadata.gatewayInstanceId,
    ),
    profileId: safeLeadText(metadata.profileId || existing.profileId),
    profileName: safeLeadText(metadata.profileName || existing.profileName),
    phoneId: safeLeadText(existing.phoneId || metadata.phoneId),
    sampleRate: Number(metadata.sampleRate || existing.sampleRate || DEFAULT_SAMPLE_RATE),
    connectedAt: existing.connectedAt || now,
    lastSeenAt: now,
    activeCallControlId: safeLeadText(
      Object.prototype.hasOwnProperty.call(metadata, 'activeCallControlId')
        ? metadata.activeCallControlId
        : existing.activeCallControlId,
    ),
    activeStreamId: safeLeadText(
      Object.prototype.hasOwnProperty.call(metadata, 'activeStreamId')
        ? metadata.activeStreamId
        : existing.activeStreamId,
    ),
    sipConnected: gatewayBooleanMetadata(metadata, existing, 'sipConnected'),
    sipRegistered: gatewayBooleanMetadata(metadata, existing, 'sipRegistered'),
    audioContextState: safeLeadText(
      Object.prototype.hasOwnProperty.call(metadata, 'audioContextState')
        ? metadata.audioContextState
        : existing.audioContextState,
    ),
    localAudioTrackLive: gatewayBooleanMetadata(
      metadata,
      existing,
      'localAudioTrackLive',
    ),
    playbackMode: safeLeadText(
      Object.prototype.hasOwnProperty.call(metadata, 'playbackMode')
        ? metadata.playbackMode
        : existing.playbackMode,
    ),
    captureMode: safeLeadText(
      Object.prototype.hasOwnProperty.call(metadata, 'captureMode')
        ? metadata.captureMode
        : existing.captureMode,
    ),
    runtimeProfile:
      metadata.runtimeProfile && typeof metadata.runtimeProfile === 'object'
        ? metadata.runtimeProfile
        : existing.runtimeProfile,
    registrationRequestId: safeLeadText(
      Object.prototype.hasOwnProperty.call(metadata, 'registrationRequestId')
        ? metadata.registrationRequestId
        : existing.registrationRequestId,
    ),
    registrationEnabled: gatewayBooleanMetadata(
      metadata,
      existing,
      'registrationEnabled',
    ),
    registrationOk: gatewayBooleanMetadata(metadata, existing, 'registrationOk'),
    registrationError: safeLeadText(
      Object.prototype.hasOwnProperty.call(metadata, 'registrationError')
        ? metadata.registrationError
        : existing.registrationError,
    ),
  }
  calltoolsGatewayRegistry.set(ws, next)
  return next
}

function gatewayBooleanMetadata(metadata, existing, key) {
  return Object.prototype.hasOwnProperty.call(metadata, key)
    ? Boolean(metadata[key])
    : Boolean(existing[key])
}

function clearCallToolsGatewayActiveCall(ws, state) {
  const existing = calltoolsGatewayRegistry.get(ws)
  if (!existing) return
  updateCallToolsGatewayRegistry(ws, {
    ...existing,
    activeCallControlId:
      existing.activeCallControlId === state?.callControlId ? '' : existing.activeCallControlId,
    activeStreamId: existing.activeStreamId === state?.streamId ? '' : existing.activeStreamId,
  })
}

function removeCallToolsGatewayRegistry(ws) {
  calltoolsGatewayRegistry.delete(ws)
}

function callToolsGatewaySummaries() {
  const summaries = []
  const nowMs = Date.now()
  for (const [ws, gateway] of calltoolsGatewayRegistry.entries()) {
    if (ws.readyState !== WebSocket.OPEN) {
      calltoolsGatewayRegistry.delete(ws)
      continue
    }
    const connectedAtMs = Date.parse(gateway.connectedAt || '')
    const lastSeenAtMs = Date.parse(gateway.lastSeenAt || '')
    const connectedAgeMs = Number.isFinite(connectedAtMs)
      ? Math.max(0, nowMs - connectedAtMs)
      : null
    const lastSeenAgeMs = Number.isFinite(lastSeenAtMs)
      ? Math.max(0, nowMs - lastSeenAtMs)
      : null
    const stale = lastSeenAgeMs === null || lastSeenAgeMs > CALLTOOLS_GATEWAY_STALE_AFTER_MS
    const sipHealthy = Boolean(gateway.sipConnected && gateway.sipRegistered)
    const audioHealthy =
      gateway.audioContextState === 'running' && Boolean(gateway.localAudioTrackLive)
    const healthy = !stale && sipHealthy && audioHealthy
    summaries.push({
      gatewayInstanceId: gateway.gatewayInstanceId,
      profileId: gateway.profileId,
      profileName: gateway.profileName,
      phoneId: gateway.phoneId,
      sampleRate: gateway.sampleRate,
      connectedAt: gateway.connectedAt,
      connectedAgeMs,
      lastSeenAt: gateway.lastSeenAt,
      lastSeenAgeMs,
      heartbeatStaleAfterMs: CALLTOOLS_GATEWAY_STALE_AFTER_MS,
      healthy,
      stale,
      sipConnected: Boolean(gateway.sipConnected),
      sipRegistered: Boolean(gateway.sipRegistered),
      sipHealthy,
      audioContextState: gateway.audioContextState || 'unknown',
      localAudioTrackLive: Boolean(gateway.localAudioTrackLive),
      audioHealthy,
      playbackMode: gateway.playbackMode || 'unknown',
      captureMode: gateway.captureMode || 'unknown',
      activeCallControlId: gateway.activeCallControlId,
      activeStreamId: gateway.activeStreamId,
    })
  }
  return summaries.sort((left, right) =>
    `${left.profileName || left.profileId}`.localeCompare(`${right.profileName || right.profileId}`),
  )
}

function callToolsGatewayStatusForProfile(profile = {}, binding = {}) {
  const summaries = callToolsGatewaySummaries()
  const profileId = safeLeadText(profile.id || profile.profileId)
  const phoneId = safeLeadText(binding.phoneId)
  const matchingGateways = summaries.filter((item) =>
    callToolsGatewayMatchesBinding(item, profileId, phoneId),
  )
  const gatewayOwnerInstanceId = callToolsGatewayOwnerInstanceId(profileId, phoneId)
  const ownerGateway = matchingGateways.find(
    (item) => item.gatewayInstanceId === gatewayOwnerInstanceId,
  ) || null
  const registeredGateways = matchingGateways.filter((item) => item.sipRegistered)
  const registeredOwnerCount = registeredGateways.filter(
    (item) => item.gatewayInstanceId === gatewayOwnerInstanceId,
  ).length
  const duplicateRegisteredGateway = Boolean(
    registeredGateways.length > 1 ||
      registeredGateways.some(
        (item) => !gatewayOwnerInstanceId || item.gatewayInstanceId !== gatewayOwnerInstanceId,
      ),
  )
  const gateway = ownerGateway || matchingGateways[0] || null
  const profileGateway = summaries.find((item) => profileId && item.profileId === profileId) || null
  const bindingMismatch = Boolean(
    !gateway &&
    profileGateway &&
    phoneId &&
    profileGateway.phoneId !== phoneId,
  )
  const connected = Boolean(
    ownerGateway?.healthy &&
      registeredOwnerCount === 1 &&
      !duplicateRegisteredGateway,
  )
  return {
    connected,
    connectionCount: summaries.length,
    matchingConnectionCount: matchingGateways.length,
    healthyConnectionCount: summaries.filter((item) => item.healthy).length,
    heartbeatStaleAfterMs: CALLTOOLS_GATEWAY_STALE_AFTER_MS,
    gateway,
    gatewayOwnerInstanceId,
    registeredOwnerCount,
    duplicateRegisteredGateway,
    bindingMismatch,
    expectedPhoneId: bindingMismatch ? maskId(phoneId) : undefined,
    registeredPhoneId: bindingMismatch ? maskId(profileGateway.phoneId) : undefined,
    status: duplicateRegisteredGateway
      ? 'duplicate-registration'
      : gatewayOwnerInstanceId && !ownerGateway
        ? 'owner-disconnected'
        : gateway
      ? connected
        ? 'registered'
        : gateway.stale
          ? 'stale'
          : 'unhealthy'
      : bindingMismatch
        ? 'binding-mismatch'
      : callToolsMediaGatewayConfigured()
        ? 'configured'
        : 'unconfigured',
  }
}

async function assertCallToolsSeatClaimAvailable(
  profile = {},
  binding = {},
  { leaseId = '' } = {},
) {
  const gatewayStatus = callToolsGatewayStatusForProfile(profile, binding)
  if (leaseId) {
    const dutyState = await readWorkspaceCallToolsDuty()
    const duty = dutyState.calltoolsDuty || dutyState.dialerState?.calltoolsDuty || {}
    const dutyBinding = normalizeDutyBinding(duty.binding)
    if (
      isActiveCallToolsDuty(duty) &&
      safeLeadText(duty.leaseId) === safeLeadText(leaseId) &&
      safeLeadText(duty.profileId) === safeLeadText(profile.id || profile.profileId) &&
      dutyBinding.appUserId === safeLeadText(binding.appUserId || binding.userId) &&
      dutyBinding.campaignId === safeLeadText(binding.campaignId) &&
      dutyBinding.phoneId === safeLeadText(binding.phoneId)
    ) {
      cacheCallToolsGatewayLeaseOwner(duty)
      return {
        nativeAgentReady: null,
        ownershipProven: true,
        reason: 'matching_speak_durable_lease',
      }
    }
  }
  return assertCallToolsSeatClaimSafe({
    gatewayStatus,
    readNativeStatus: () => readCallToolsDutyStatus({
      binding,
      includeSeatClaimProof: true,
    }),
  })
}

function assertCallToolsDutyReleaseScope(duty = {}, expected = {}) {
  const expectedBinding = normalizeDutyBinding({
    appUserId: expected.appUserId,
    campaignId: expected.campaignId,
    phoneId: expected.phoneId,
  })
  const expectedScope = {
    leaseId: safeLeadText(expected.expectedLeaseId),
    profileId: safeLeadText(expected.profileId),
    binding: expectedBinding,
  }
  if (
    !expectedScope.leaseId ||
    !expectedScope.profileId ||
    !expectedBinding.appUserId ||
    !expectedBinding.campaignId ||
    !expectedBinding.phoneId
  ) {
    throw Object.assign(new Error('A scoped CallTools release requires the exact lease and binding.'), {
      status: 400,
      code: 'calltools_duty_release_scope_incomplete',
    })
  }
  const actualBinding = normalizeDutyBinding(duty.binding)
  if (
    !isActiveCallToolsDuty(duty) ||
    safeLeadText(duty.leaseId) !== expectedScope.leaseId ||
    safeLeadText(duty.profileId) !== expectedScope.profileId ||
    actualBinding.appUserId !== expectedBinding.appUserId ||
    actualBinding.campaignId !== expectedBinding.campaignId ||
    actualBinding.phoneId !== expectedBinding.phoneId
  ) {
    throw Object.assign(new Error('CallTools availability changed before the scoped release.'), {
      status: 409,
      code: 'calltools_duty_release_scope_mismatch',
    })
  }
}

async function bindCallToolsGatewayToProfile(profile = {}, binding = {}) {
  const profileId = safeLeadText(profile.id || profile.profileId)
  const profileName = safeLeadText(profile.name || profile.profileName || profileId)
  const phoneId = safeLeadText(binding.phoneId)
  if (!profileId || !phoneId) {
    throw Object.assign(new Error('Selected profile is missing its CallTools phone binding'), {
      status: 503,
      code: 'calltools_gateway_profile_binding_missing',
    })
  }

  const current = callToolsGatewayStatusForProfile(profile, binding)
  if (current.gateway?.activeCallControlId || current.gateway?.activeStreamId) {
    throw Object.assign(new Error('The CallTools gateway profile cannot change during a call'), {
      status: 409,
      code: 'calltools_gateway_profile_busy',
    })
  }
  const currentRuntimeFingerprint = callToolsVoiceStandbyRuntimeFingerprint({
    config: current.gateway?.runtimeProfile?.config,
    generation: current.gateway?.runtimeProfile?.updatedAt,
  })
  const requestedRuntimeFingerprint = callToolsVoiceStandbyRuntimeFingerprint({
    config: profile.config,
    generation: profile.updatedAt,
  })
  const requestedSampleRate = Number(profile.config?.sampleRate || DEFAULT_SAMPLE_RATE)
  if (
    current.connected &&
    currentRuntimeFingerprint &&
    currentRuntimeFingerprint === requestedRuntimeFingerprint
  ) return current

  let selectedSocket = null
  let selectedGateway = null
  for (const [ws, gateway] of calltoolsGatewayRegistry.entries()) {
    if (!callToolsGatewayEntryHealthy(ws, gateway)) continue
    if (gateway.phoneId !== phoneId) continue
    selectedSocket = ws
    selectedGateway = gateway
    break
  }
  if (!selectedSocket || !selectedGateway) {
    throw Object.assign(new Error('The assigned CallTools phone gateway is not registered'), {
      status: 503,
      code: 'calltools_gateway_not_registered',
    })
  }
  if (selectedGateway.activeCallControlId || selectedGateway.activeStreamId) {
    throw Object.assign(new Error('The CallTools gateway profile cannot change during a call'), {
      status: 409,
      code: 'calltools_gateway_profile_busy',
    })
  }

  if (
    current.connected &&
    Number(selectedGateway.sampleRate || DEFAULT_SAMPLE_RATE) === requestedSampleRate
  ) {
    updateCallToolsGatewayRegistry(selectedSocket, {
      runtimeProfile: profile,
      sampleRate: requestedSampleRate,
    })
    return callToolsGatewayStatusForProfile(profile, binding)
  }

  selectedSocket.send(
    JSON.stringify({
      type: 'gateway.profile.select',
      profileId,
      profileName,
      phoneId,
      sampleRate: requestedSampleRate,
    }),
  )
  const deadline = Date.now() + Math.max(250, CALLTOOLS_GATEWAY_PROFILE_BIND_TIMEOUT_MS)
  while (Date.now() <= deadline) {
    const status = callToolsGatewayStatusForProfile(profile, binding)
    if (
      status.connected &&
      Number(status.gateway?.sampleRate || DEFAULT_SAMPLE_RATE) === requestedSampleRate
    ) {
      updateCallToolsGatewayRegistry(selectedSocket, {
        runtimeProfile: profile,
        sampleRate: requestedSampleRate,
      })
      return callToolsGatewayStatusForProfile(profile, binding)
    }
    if (selectedSocket.readyState !== WebSocket.OPEN) break
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw Object.assign(new Error('The CallTools gateway did not confirm the selected profile'), {
    status: 503,
    code: 'calltools_gateway_profile_bind_timeout',
  })
}

async function setCallToolsGatewayRegistration(profile = {}, binding = {}, enabled = true) {
  const phoneId = safeLeadText(binding.phoneId)
  const profileId = safeLeadText(profile.id || profile.profileId)
  const dutyState = await readWorkspaceCallToolsDuty()
  let duty = dutyState.calltoolsDuty || dutyState.dialerState?.calltoolsDuty || {}
  cacheCallToolsGatewayLeaseOwner(duty)
  let gatewayOwnerInstanceId = safeLeadText(duty.gatewayOwnerInstanceId)
  if (!phoneId) {
    throw Object.assign(new Error('The assigned CallTools phone binding is missing'), {
      status: 503,
      code: 'calltools_gateway_phone_binding_missing',
    })
  }
  const matchingGateways = []
  for (const [ws, gateway] of calltoolsGatewayRegistry.entries()) {
    if (ws.readyState !== WebSocket.OPEN) continue
    if (gateway.phoneId !== phoneId) continue
    matchingGateways.push({ gateway, ws })
  }
  if (matchingGateways.length === 0) {
    throw Object.assign(new Error('The assigned CallTools phone gateway is not connected'), {
      status: 503,
      code: 'calltools_gateway_not_connected',
    })
  }
  const dutyBinding = normalizeDutyBinding(duty.binding)
  if (
    enabled &&
    (!isActiveCallToolsDuty(duty) ||
      !['arming', 'attention', 'on'].includes(safeLeadText(duty.status)) ||
      safeLeadText(duty.profileId) !== profileId ||
      dutyBinding.appUserId !== safeLeadText(binding.appUserId || binding.userId) ||
      dutyBinding.campaignId !== safeLeadText(binding.campaignId) ||
      dutyBinding.phoneId !== phoneId)
  ) {
    throw Object.assign(new Error('CallTools gateway registration requires the exact active lease.'), {
      status: 409,
      code: 'calltools_gateway_registration_lease_mismatch',
    })
  }
  let owner = matchingGateways.find(
    ({ gateway }) => gateway.gatewayInstanceId === gatewayOwnerInstanceId,
  ) || null
  if (
    enabled &&
    !owner &&
    (matchingGateways.length !== 1 || !matchingGateways[0].gateway.gatewayInstanceId)
  ) {
    throw Object.assign(
      new Error('CallTools phone registration has more than one possible gateway owner'),
      {
        status: 409,
        code: 'calltools_gateway_registration_ambiguous',
      },
    )
  }
  if (enabled && !owner) {
    gatewayOwnerInstanceId = matchingGateways[0].gateway.gatewayInstanceId
    const ownership = await transitionWorkspaceCallToolsDuty({
      expectedLeaseId: safeLeadText(duty.leaseId),
      patch: { gatewayOwnerInstanceId },
    })
    duty = ownership.calltoolsDuty || ownership.dialerState?.calltoolsDuty || {}
    if (
      ownership.applied === false ||
      !isActiveCallToolsDuty(duty) ||
      safeLeadText(duty.gatewayOwnerInstanceId) !== gatewayOwnerInstanceId
    ) {
      throw Object.assign(new Error('CallTools gateway ownership changed before registration.'), {
        status: 409,
        code: 'calltools_gateway_registration_owner_conflict',
      })
    }
    cacheCallToolsGatewayLeaseOwner(duty)
    owner = matchingGateways[0]
  }
  if (
    matchingGateways.some(
      ({ gateway }) => gateway.activeCallControlId || gateway.activeStreamId,
    )
  ) {
    throw Object.assign(new Error('The CallTools phone registration cannot change during a call'), {
      status: 409,
      code: 'calltools_gateway_registration_busy',
    })
  }

  const selectedGateways = enabled ? [owner] : matchingGateways
  const duplicateGateways = enabled
    ? matchingGateways.filter(
        ({ gateway }) => gateway.gatewayInstanceId !== gatewayOwnerInstanceId,
      )
    : []
  const duplicateAcknowledgements = await Promise.all(
    duplicateGateways.map(({ ws }) =>
      requestCallToolsGatewayRegistration(ws, {
        enabled: false,
        phoneId,
        profileId,
      }),
    ),
  )
  const acknowledgements = await Promise.all(
    selectedGateways.map(({ ws }) =>
      requestCallToolsGatewayRegistration(ws, {
        enabled,
        phoneId,
        profileId,
      }),
    ),
  )
  if (!enabled && isActiveCallToolsDuty(duty)) {
    const released = await transitionWorkspaceCallToolsDuty({
      expectedLeaseId: safeLeadText(duty.leaseId),
      patch: { gatewayOwnerInstanceId: '' },
    })
    if (released.applied === false) {
      throw Object.assign(new Error('CallTools gateway ownership changed during release.'), {
        status: 409,
        code: 'calltools_gateway_registration_owner_conflict',
      })
    }
    cacheCallToolsGatewayLeaseOwner(
      released.calltoolsDuty || released.dialerState?.calltoolsDuty || {},
    )
  }
  return {
    connected: true,
    connectionCount: matchingGateways.length,
    duplicateReleaseCount: duplicateAcknowledgements.length,
    enabled,
    gatewayOwnerInstanceId: enabled ? gatewayOwnerInstanceId : '',
    ok: [...duplicateAcknowledgements, ...acknowledgements].every((item) => item.ok),
    requestIds: [...duplicateAcknowledgements, ...acknowledgements].map(
      (item) => item.requestId,
    ),
  }
}

async function requestCallToolsGatewayRegistration(
  selectedSocket,
  { enabled, phoneId, profileId },
) {
  const requestId = randomUUID()
  updateCallToolsGatewayRegistry(selectedSocket, {
    registrationRequestId: '',
    registrationEnabled: enabled,
    registrationOk: false,
    registrationError: '',
  })
  selectedSocket.send(JSON.stringify({
    type: 'gateway.registration.set',
    requestId,
    enabled,
    profileId,
    phoneId,
  }))
  const deadline = Date.now() + Math.max(1_000, CALLTOOLS_GATEWAY_REGISTRATION_TIMEOUT_MS)
  while (Date.now() <= deadline) {
    const current = calltoolsGatewayRegistry.get(selectedSocket) || {}
    if (current.registrationRequestId === requestId) {
      if (current.registrationOk && current.sipRegistered === enabled) {
        return { enabled, ok: true, requestId }
      }
      throw Object.assign(
        new Error(current.registrationError || 'CallTools phone registration handoff failed'),
        { status: 503, code: 'calltools_gateway_registration_failed' },
      )
    }
    if (selectedSocket.readyState !== WebSocket.OPEN) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw Object.assign(new Error('CallTools phone registration handoff timed out'), {
    status: 503,
    code: 'calltools_gateway_registration_timeout',
  })
}

function callToolsGatewayEntryHealthy(ws, gateway = {}) {
  if (ws.readyState !== WebSocket.OPEN) return false
  const lastSeenAtMs = Date.parse(gateway.lastSeenAt || '')
  const lastSeenAgeMs = Number.isFinite(lastSeenAtMs)
    ? Math.max(0, Date.now() - lastSeenAtMs)
    : Number.POSITIVE_INFINITY
  return Boolean(
    lastSeenAgeMs <= CALLTOOLS_GATEWAY_STALE_AFTER_MS &&
    gateway.sipConnected === true &&
    gateway.sipRegistered === true &&
    gateway.audioContextState === 'running' &&
    gateway.localAudioTrackLive === true
  )
}

function callToolsGatewayMatchesBinding(gateway = {}, profileId = '', phoneId = '') {
  if (!profileId && !phoneId) return false
  if (profileId && gateway.profileId !== profileId) return false
  if (phoneId && gateway.phoneId !== phoneId) return false
  return true
}

function maskId(value = '') {
  const text = safeLeadText(value)
  if (!text) return ''
  if (text.length <= 4) return '****'
  return `${'*'.repeat(Math.max(0, text.length - 4))}${text.slice(-4)}`
}

async function resolveStartRuntimeConfig(config = {}) {
  const source = config && typeof config === 'object' ? config : {}
  const profile = await resolveSavedProfileForRuntimeConfig(source)
  if (!profile) return normalizeCampaignConfig(source)

  const profileConfig = normalizeCampaignConfig(profile.config || {})
  const explicitBinding =
    source.calltoolsAgentBinding && typeof source.calltoolsAgentBinding === 'object'
      ? source.calltoolsAgentBinding
      : null
  return normalizeCampaignConfig({
    ...profileConfig,
    ...source,
    agentProfileId: source.agentProfileId || profileConfig.agentProfileId || profile.id,
    agentProfileName: source.agentProfileName || profileConfig.agentProfileName || profile.name,
    agentProfileUpdatedAt: profile.updatedAt,
    calltoolsAgentBinding: explicitBinding
      ? {
          ...(profileConfig.calltoolsAgentBinding || {}),
          ...explicitBinding,
        }
      : profileConfig.calltoolsAgentBinding,
  })
}

async function ensureVoiceRuntimeReady(
  runtimeConfig,
  { codexReadiness, syncProvider = true } = {},
) {
  await assertCodexClmRuntimeReady(runtimeConfig, codexReadiness)
  if (!syncProvider && !voiceProviderConfigSyncRequired(runtimeConfig)) {
    return runtimeConfig
  }
  return ensureVoiceProviderConfigReady(runtimeConfig)
}

async function prewarmCodexVoiceRuntimeReadiness() {
  const workspace = await listWorkspaceProfiles()
  const configsByModel = new Map()
  for (const profile of workspace.profiles || []) {
    const config = normalizeCampaignConfig({
      ...(profile.config || {}),
      agentProfileId: profile.id,
      agentProfileName: profile.name,
    })
    if (!isCodexAuthLanguageModel(config) || isInworldRuntime(config)) continue
    configsByModel.set(getCodexAuthModel(config), config)
  }
  const results = await Promise.allSettled(
    Array.from(configsByModel.values(), (config) =>
      assertCodexClmRuntimeReady(config),
    ),
  )
  const failed = results.filter((result) => result.status === 'rejected').length
  if (failed > 0) {
    console.warn(
      `Codex voice runtime prewarm unavailable for ${failed} of ${results.length} configured model(s).`,
    )
  }
  return { checked: results.length, failed }
}

async function ensureVoiceProviderConfigReady(runtimeConfig) {
  if (isXaiRuntime(runtimeConfig)) {
    return ensureXaiRuntimeConfigReady(runtimeConfig, { allowStale: true })
  }
  if (isInworldRuntime(runtimeConfig)) {
    return ensureInworldRuntimeConfigReady(runtimeConfig)
  }

  const syncResult = await syncSpeakAgentConfig({
    profileName: runtimeConfig.agentProfileName,
    config: runtimeConfig,
    createNew: false,
    ownedUpdates: VOICE_PROVIDER_SYNC_SECTIONS,
  })
  const syncedConfig = mergeSyncedSpeakRuntimeConfig(
    runtimeConfig,
    syncResult.config || {},
  )
  await persistRecoveredVoiceConfig(runtimeConfig, syncedConfig, syncResult)
  return syncedConfig
}

function mergeSyncedSpeakRuntimeConfig(runtimeConfig, providerConfig = {}) {
  return normalizeCampaignConfig({
    ...runtimeConfig,
    ...providerConfig,
    agentProfileId: runtimeConfig.agentProfileId,
    agentProfileName: runtimeConfig.agentProfileName,
    smartViewId: runtimeConfig.smartViewId,
    dialerProvider: runtimeConfig.dialerProvider,
    calltoolsAgentBinding: runtimeConfig.calltoolsAgentBinding,
    telnyxCallerId: runtimeConfig.telnyxCallerId,
    phoneCallerId: runtimeConfig.phoneCallerId,
    telnyxConnectionId: runtimeConfig.telnyxConnectionId,
    phoneConnectionId: runtimeConfig.phoneConnectionId,
    telnyxStreamCodec: runtimeConfig.telnyxStreamCodec,
    phoneStreamCodec: runtimeConfig.phoneStreamCodec,
  })
}

async function persistRecoveredVoiceConfig(
  originalConfig,
  syncedConfig,
  syncResult = {},
) {
  const syncedConfigId = safeLeadText(syncedConfig.humeConfigId)
  if (!syncedConfigId) return
  if (!voiceProviderProofChanged(originalConfig, syncedConfig, syncResult)) return

  const profile = await resolveSavedProfileForRuntimeConfig(originalConfig)
  if (!profile) return

  await upsertWorkspaceProfile({
    ...profile,
    updatedAt: new Date().toISOString(),
    config: normalizeCampaignConfig({
      ...profile.config,
      ...syncedConfig,
      agentProfileId: profile.id,
      agentProfileName: profile.name,
      smartViewId: profile.config?.smartViewId,
      dialerProvider: profile.config?.dialerProvider,
      calltoolsAgentBinding: profile.config?.calltoolsAgentBinding,
    }),
  })
}

function voiceProviderProofChanged(originalConfig, syncedConfig, syncResult) {
  return (
    safeLeadText(originalConfig.humeConfigId) !==
      safeLeadText(syncedConfig.humeConfigId) ||
    Number(originalConfig.humeConfigVersion || 0) !==
      Number(syncedConfig.humeConfigVersion || 0) ||
    syncResult.action === 'created' ||
    syncResult.action === 'versioned' ||
    syncResult.action === 'renamed-and-versioned'
  )
}

async function resolveSavedProfileForRuntimeConfig(config = {}) {
  const source = config && typeof config === 'object' ? config : {}
  const idCandidates = [
    source.agentProfileId,
    source.speakConfigId,
    source.humeConfigId,
    source.inworldConfigId,
  ]
    .map((value) => safeLeadText(value).toLowerCase())
    .filter(Boolean)
  const nameCandidate = safeLeadText(source.agentProfileName).toLowerCase()
  if (!idCandidates.length && !nameCandidate) return null

  const workspace = await listWorkspaceProfiles()
  const profiles = Array.isArray(workspace.profiles) ? workspace.profiles : []
  const idMatch = idCandidates.length
    ? profiles.find((profile) => {
        const values = [
          profile.id,
          profile.config?.agentProfileId,
          profile.config?.speakConfigId,
          profile.config?.humeConfigId,
          profile.config?.inworldConfigId,
        ]
          .map((value) => safeLeadText(value).toLowerCase())
          .filter(Boolean)
        return values.some((value) => idCandidates.includes(value))
      })
    : null
  if (idMatch) return idMatch

  if (!nameCandidate) return null
  const nameMatches = profiles.filter((profile) => {
    const values = [profile.name, profile.config?.agentProfileName]
      .map((value) => safeLeadText(value).toLowerCase())
      .filter(Boolean)
    return values.includes(nameCandidate)
  })
  return nameMatches.length === 1 ? nameMatches[0] : null
}

async function resolveCallToolsProfileInput(body = {}) {
  if (body.profile && typeof body.profile === 'object') return body.profile
  if (body.config && typeof body.config === 'object') {
    const profileId = safeLeadText(
      body.profileId ||
        body.id ||
        body.config.agentProfileId ||
        body.config.speakConfigId ||
        body.config.humeConfigId ||
        body.config.inworldConfigId,
    )
    return {
      id: profileId,
      name: safeLeadText(body.profileName || body.config.agentProfileName),
      config: normalizeCampaignConfig(body.config),
    }
  }

  const profileId = safeLeadText(body.profileId || body.id)
  if (!profileId) {
    return {
      id: '',
      name: 'Unsaved profile',
      config: normalizeCampaignConfig({}),
    }
  }

  const workspace = await listWorkspaceProfiles()
  const profile = (workspace.profiles || []).find((item) => item.id === profileId)
  if (!profile) {
    throw Object.assign(new Error('Profile not found'), {
      status: 404,
      code: 'profile_not_found',
    })
  }
  return profile
}

async function resolveCallToolsSourceProfileInput(body = {}) {
  const workspace = await listWorkspaceProfiles()
  if (body.profile || body.config || body.profileId || body.id) {
    const selected = await resolveCallToolsProfileInput(body)
    return applySharedCallToolsDutyBinding(selected, workspace.profiles || [])
  }
  const profiles = workspace.profiles || []
  const profile =
    profiles.find((item) => item.id === workspace.activeProfileId) ||
    profiles.find((item) => isCallToolsDialer(item.config || {}))
  if (!profile) {
    throw Object.assign(new Error('No CallTools-enabled profile found'), {
      status: 404,
      code: 'calltools_profile_not_found',
    })
  }
  return applySharedCallToolsDutyBinding(profile, profiles)
}

function profileWithCallToolsSourceOverride(profile = {}, body = {}) {
  const source =
    body.calltoolsSource && typeof body.calltoolsSource === 'object'
      ? body.calltoolsSource
      : body.source && typeof body.source === 'object'
        ? body.source
        : body
  const campaignId = safeLeadText(source.campaignId || source.campaign_id)
  const liveFilterId = safeLeadText(source.liveFilterId || source.live_filter_id)
  const bucketId = safeLeadText(source.bucketId || source.bucket_id)
  if (!campaignId && !liveFilterId && !bucketId) return profile

  const config = normalizeCampaignConfig(profile.config || {})
  return {
    ...profile,
    config: normalizeCampaignConfig({
      ...config,
      calltoolsAgentBinding: {
        ...(config.calltoolsAgentBinding || {}),
        ...(campaignId ? { campaignId } : {}),
        ...(liveFilterId ? { liveFilterId } : {}),
        ...(bucketId ? { bucketId } : {}),
      },
    }),
  }
}

function assertCallToolsGatewaySecret(value) {
  const expected = getCallToolsMediaGatewaySharedSecret()
  if (!expected) {
    throw Object.assign(new Error('CALLTOOLS_MEDIA_GATEWAY_SHARED_SECRET is required'), {
      status: 503,
      code: 'calltools_gateway_secret_missing',
    })
  }
  if (safeLeadText(value) !== expected) {
    throw Object.assign(new Error('Invalid CallTools media gateway token'), {
      status: 401,
      code: 'calltools_gateway_token_invalid',
    })
  }
}

function sendWorkspaceError(response, error, fallback = 'Workspace request failed') {
  const statusCode =
    error instanceof Error && Number.isInteger(error.statusCode)
      ? error.statusCode
      : 500
  response.status(statusCode).json({
    error: error instanceof Error ? error.message : fallback,
  })
}

function logWorkspaceError(error) {
  console.error(
    `Workspace persistence failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  )
}

function persistWorkspaceLeadPatch(state, patch = {}) {
  if (isBrowserTestSandbox(state)) return
  const lead = state?.lead || {}
  const leadId = patch.id || lead.id
  if (!leadId) return
  const nextLead = {
    ...lead,
    ...patch,
    id: leadId,
  }
  if (isTransientWorkspaceLead(nextLead)) return

  void patchWorkspaceLead(leadId, nextLead).catch(logWorkspaceError)
}

function persistCallOutcome(state, outcome) {
  if (!state || state.browserTest) return
  const finalOutcome = normalizeCallOutcome(outcome) || state.outcome || 'operator-ended'
  persistWorkspaceLeadPatch(state, {
    status: statusForOutcome(finalOutcome),
    lastCall: workspaceLastCallLabel(),
  })
  if (isCallToolsGatewayCall(state)) {
    void reconcileCallToolsOutcomeForState(state, finalOutcome).catch((error) => {
      console.warn(
        'CallTools outcome reconciliation failed:',
        error instanceof Error ? error.message : String(error),
      )
    })
  }
}

async function reconcileCallToolsOutcomeForState(state, outcome) {
  if (!state || state.calltoolsOutcomeReconciled) return
  state.calltoolsOutcomeReconciled = true
  const apply = callToolsOutcomeAutoSyncEnabled()
  const result = await reconcileCallToolsCallOutcome({
    outcome,
    config: state.config,
    calltoolsContext: state.calltoolsContext,
    lead: state.lead,
    apply,
    confirm: apply,
  })
  state.calltoolsOutcomeSync = result
  emitCallEvent(state.callControlId, {
    calltools: { outcomeSync: result },
    communication: callToolsCommunicationMetadata(state, {}, state.calltoolsContext),
    entry: transcriptEntry(
      'System',
      result.mutationPerformed
        ? `CallTools disposition synced: ${result.disposition?.name || outcome}.`
        : result.blockers?.length
          ? `CallTools disposition sync blocked: ${result.blockers.join(', ')}.`
          : `CallTools disposition ready: ${result.disposition?.name || outcome}.`,
      result.blockers?.length ? 'attention' : 'system',
    ),
    notice: result.mutationPerformed
      ? 'CallTools disposition synced'
      : result.blockers?.length
        ? 'CallTools disposition blocked'
        : 'CallTools disposition ready',
  })
}

async function refreshCallToolsHistoricalCallForState(state, { timeoutMs } = {}) {
  if (
    !state ||
    !isCallToolsGatewayCall(state) ||
    state.calltoolsHistoricalCall?.callRecordingFsFileId ||
    state.calltoolsHistoricalCallLookupInFlight
  ) {
    return null
  }
  state.calltoolsHistoricalCallLookupInFlight = true
  try {
    const contactId =
      state.calltoolsContext?.providerIds?.calltoolsContactId ||
      state.calltoolsContext?.contact?.id ||
      state.lead?.providerIds?.calltoolsContactId
    const historicalCall = await readCallToolsHistoricalCall({
      calltoolsCallId: state.calltoolsCallId,
      contactId,
      to: state.calltoolsContext?.lead?.phone || state.lead?.phone || state.to,
      startedAt: state.answeredAt || state.createdAt,
      config: state.config,
      timeoutMs,
    }).catch((error) => {
      console.warn(
        'CallTools historical call lookup failed:',
        error instanceof Error ? error.message : String(error),
      )
      return null
    })
    if (!historicalCall) return null
    state.calltoolsHistoricalCall = historicalCall
    if (historicalCall.callRecordingFsFileId) {
      setTransportDiagnosticValue(
        state,
        'calltools',
        'callRecordingFsFileId',
        historicalCall.callRecordingFsFileId,
      )
      recordTransportMilestone(state, 'calltools_recording_reference_resolved', {
        callRecordingFsFileId: historicalCall.callRecordingFsFileId,
      })
    }
    return historicalCall
  } finally {
    state.calltoolsHistoricalCallLookupInFlight = false
  }
}

function reconcileCallToolsHistoricalCallAfterClose(state) {
  void refreshCallToolsHistoricalCallForState(state, {
    timeoutMs: CALLTOOLS_GATEWAY_CLOSE_RECONCILE_TIMEOUT_MS,
  })
    .then((historicalCall) => {
      if (!historicalCall) return
      const recordingResolved = Boolean(historicalCall.callRecordingFsFileId)
      emitCallEvent(state.callControlId, {
        communication: callToolsCommunicationMetadata(state, {}, state.calltoolsContext),
        entry: transcriptEntry(
          'System',
          recordingResolved
            ? 'CallTools recording reference resolved.'
            : 'CallTools historical call reference resolved.',
          'system',
        ),
        notice: recordingResolved
          ? 'CallTools recording ready'
          : 'CallTools call reference ready',
      })
    })
    .catch((error) => {
      console.warn(
        'Detached CallTools historical call reconciliation failed:',
        error instanceof Error ? error.message : String(error),
      )
    })
}

function scheduleCallToolsRecordingReconciliation(state, message = {}) {
  if (
    !state ||
    !isCallToolsGatewayCall(state) ||
    state.calltoolsRecordingReconcileScheduled ||
    !CALLTOOLS_RECORDING_RECONCILE_DELAYS_MS.length
  ) {
    return
  }
  state.calltoolsRecordingReconcileScheduled = true
  CALLTOOLS_RECORDING_RECONCILE_DELAYS_MS.forEach((delayMs) => {
    const timer = setTimeout(async () => {
      if (state.calltoolsHistoricalCall?.callRecordingFsFileId) return
      const historicalCall = await refreshCallToolsHistoricalCallForState(state)
      if (!historicalCall?.callRecordingFsFileId) return
      emitCallEvent(state.callControlId, {
        communication: callToolsCommunicationMetadata(state, message, state.calltoolsContext),
        entry: transcriptEntry('System', 'CallTools recording reference resolved.', 'system'),
        notice: 'CallTools recording ready',
      })
    }, delayMs)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

function createPersonalPhoneInboundCallState(message, handoff) {
  const callControlId = safeLeadText(message.start?.call_control_id)
  if (!callControlId || handoff.callControlId !== callControlId) return null

  const state =
    bindProvisionalVoiceSession(
      handoff.correlationId,
      callControlId,
    ) || createPersonalPhoneInboundProvisionalState(handoff)
  state.callControlId = callControlId
  calls.set(callControlId, state)
  state.inbound = true
  state.answered = true
  state.answeredAt ||= new Date().toISOString()
  state.minimumHangupAt = minimumTelnyxHangupAt(state)
  state.callProvider = 'telnyx_texml'
  state.callSessionId = safeLeadText(
    message.start?.call_session_id || handoff.callSessionId,
  )
  state.personalPhoneInboundCorrelationId = handoff.correlationId
  state.personalPhoneInboundEventId = handoff.eventId
  return state
}

function createPersonalPhoneInboundProvisionalState(handoff) {
  const state = createCallState(
    handoff.callControlId,
    handoff.runtimeContext?.lead || handoff.lead,
    handoff.runtimeConfig,
    [],
  )
  state.inbound = true
  state.answered = false
  state.callProvider = 'telnyx_texml'
  state.callSessionId = safeLeadText(handoff.callSessionId)
  state.personalPhoneInboundCorrelationId = handoff.correlationId
  state.personalPhoneInboundEventId = handoff.eventId
  return state
}

function markPersonalPhoneInboundConversationStarted(state) {
  if (!state?.personalPhoneInboundCorrelationId) return
  personalPhoneInboundHandoffs.markConversationStarted(
    state.personalPhoneInboundCorrelationId,
  )
}

function markPersonalPhoneOutboundConversationStarted(state, samples) {
  if (!state?.personalPhoneInboundCorrelationId || !samples?.length) return
  if (analyzePcm16(samples).peakRatio >= 0.005) {
    markPersonalPhoneInboundConversationStarted(state)
  }
}

function workspaceLastCallLabel() {
  const date = operationalDate()
  if (!date) return ''
  const [, month, day] = date.split('-')
  const dateForLabel = new Date(Date.UTC(2000, Number(month) - 1, Number(day)))
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
  }).format(dateForLabel)
}

async function handleTelnyxMessage(
  ws,
  raw,
  setState,
  personalPhoneInboundHandoff = null,
) {
  const message = JSON.parse(raw.toString())

  if (message.event === 'connected') {
    return
  }

  if (message.event === 'start') {
    const callControlId = message.start?.call_control_id
    if (!callControlId) return
    const decodedClientState = decodeClientState(message.start?.client_state)
    const provisionalVoiceSessionId = safeLeadText(
      decodedClientState.provisionalVoiceSessionId,
    )

    const state = personalPhoneInboundHandoff
      ? createPersonalPhoneInboundCallState(message, personalPhoneInboundHandoff)
      : getCallState(callControlId) ||
        (provisionalVoiceSessionId
          ? bindProvisionalVoiceSession(
              provisionalVoiceSessionId,
              callControlId,
            )
          : null) ||
        createStateFromStreamStart(message)
    if (!state) {
      ws.close(1008, 'Personal Phone handoff mismatch')
      return
    }
    state.telnyxWs = ws
    state.streamId = message.stream_id
    const mediaFormat = message.start?.media_format || {}
    const observedCodec = mediaFormat.encoding || state.config.telnyxStreamCodec
    state.telnyxCodec = normalizeAudioCodec(observedCodec) || observedCodec
    state.sampleRate = Number(mediaFormat.sample_rate || state.config.sampleRate)
    state.telnyxChannels = Number(mediaFormat.channels || 1)
    updateAudioQualityTransport(state)
    setTransportDiagnosticValue(state, 'telnyx', 'observedCodec', state.telnyxCodec)
    setTransportDiagnosticValue(state, 'telnyx', 'observedSampleRate', state.sampleRate)
    setTransportDiagnosticValue(state, 'telnyx', 'observedChannels', state.telnyxChannels)
    setTransportDiagnosticValue(state, 'telnyx', 'streamId', state.streamId)
    setTransportDiagnosticValue(state, 'hume', 'requestedSampleRate', state.sampleRate)
    recordTransportMilestone(state, 'telnyx_stream_attached', {
      codec: state.telnyxCodec,
      sampleRate: state.sampleRate,
    })
    calls.set(callControlId, state)
    setState(state)

    if (state.personalPhoneInboundCorrelationId) {
      const attached = personalPhoneInboundHandoffs.attach(
        state.personalPhoneInboundCorrelationId,
        {
          callControlId,
          callSessionId: state.callSessionId,
        },
      )
      if (!attached) {
        calls.delete(callControlId)
        ws.close(1011, 'Personal Phone handoff persistence failed')
        return
      }
      state.contactConversationMemory = await readVoiceContactConversationMemory(
        state.lead,
      )
      persistWorkspaceLeadPatch(state, {
        ...state.lead,
        status: 'calling',
        lastCall: 'Inbound in progress',
      })
    }

    emitCallEvent(callControlId, {
      patch: cleanObject({
        streamId: state.streamId,
        phase: state.answered ? 'live' : undefined,
      }),
      diagnostic: buildTransportDiagnosticSnapshot(state),
      entry: transcriptEntry(
        'System',
        `Phone media attached as ${state.telnyxCodec} at ${state.sampleRate} Hz.`,
        'system',
      ),
      notice: 'Phone media stream attached',
    })

    emitTelnyxMediaFormatWarnings(state, mediaFormat)
    connectVoiceSession(state)
    maybeSendInitialGreetingPrompt(state)
    return
  }

  const callControlId = message.start?.call_control_id || message.stop?.call_control_id
  const state = getCallState(callControlId) || findStateByStreamId(message.stream_id)
  if (!state) return

  if (message.event === 'media') {
    const track = message.media?.track
    if (track && track !== 'inbound') return
    const payload = Buffer.from(message.media?.payload || '', 'base64')
    let pcm
    try {
      if (normalizeAudioCodec(state.telnyxCodec) === 'L16' && payload.length % 2 !== 0) {
        incrementAudioQualityCounter(state, 'inbound', 'oddBytePayloads')
      }
      pcm = decodeTelnyxPayload(payload, state.telnyxCodec)
    } catch (error) {
      incrementAudioQualityCounter(state, 'inbound', 'decodeErrors')
      emitCallEvent(state.callControlId, {
        entry: transcriptEntry(
          'System',
          `Audio decode failed: ${error instanceof Error ? error.message : 'unknown error'}`,
          'attention',
        ),
        notice: 'Audio decode failed',
      })
      return
    }
    addTransportCounter(state, 'telnyxMediaInPackets')
    addTransportCounter(state, 'telnyxMediaInBytes', payload.length)
    addTransportCounter(state, 'telnyxPcmInBytes', pcm.length)
    recordTransportMilestone(state, 'first_telnyx_media_in', {
      codec: state.telnyxCodec,
      sampleRate: state.sampleRate,
    })
    recordCallAudioBuffer(state, {
      source: 'lead',
      pcmLittleEndian: pcm,
      sampleRate: state.sampleRate,
    })
    recordCallStageAudioBuffer(state, {
      stage: 'lead-hume-input',
      pcmLittleEndian: pcm,
      sampleRate: state.sampleRate,
    })
    trackAudioQualityBuffer(state, 'inbound', pcm)
    playgroundCallSupervision.publishAudio(
      state,
      'contact',
      pcm,
      state.sampleRate,
    )
    if (state.personalPhoneInboundCorrelationId) {
      const audioStats = analyzePcm16(bufferToInt16LE(pcm))
      if (audioStats.peakRatio >= 0.005) {
        markPersonalPhoneInboundConversationStarted(state)
      }
    }
    sendAudioToVoiceProvider(state, pcm)
    return
  }

  if (message.event === 'dtmf') {
    emitCallEvent(state.callControlId, {
      entry: transcriptEntry('Lead', `DTMF ${message.dtmf?.digit}`, 'system'),
    })
    return
  }

  if (message.event === 'mark') {
    addTransportCounter(state, 'telnyxMarksReceived')
    emitCallEvent(state.callControlId, {
      entry: transcriptEntry(
        'System',
        `Phone playback mark received: ${message.mark?.name || 'unnamed'}.`,
        'system',
      ),
      notice: 'Phone playback mark received',
    })
    return
  }

  if (message.event === 'error') {
    emitCallEvent(state.callControlId, {
      entry: transcriptEntry(
        'System',
        `Phone stream error: ${message.payload?.detail || message.payload?.title}`,
        'attention',
      ),
      notice: 'Phone stream error',
    })
    return
  }

  if (message.event === 'stop') {
    const outcomeEvent = state.outcome
      ? null
      : setCallOutcome(state, inferStreamStopOutcome(state))
    closeCallSockets(state)
    persistCallOutcome(state, state.outcome)
    emitCallEvent(state.callControlId, {
      patch: { phase: 'ended', takeover: false, outcome: state.outcome },
      entry: transcriptEntry('System', 'Phone provider reported stream stop.', 'system'),
      notice: 'Call stream stopped',
    })
    if (outcomeEvent) emitCallEvent(state.callControlId, outcomeEvent)
  }
}

async function handleCallToolsGatewayMessage(ws, raw, setState) {
  const message = JSON.parse(raw.toString())
  const gatewayInstanceId = assertCallToolsGatewayInstance(ws, message)
  updateCallToolsGatewayRegistry(ws, { gatewayInstanceId })

  if (message.type === 'gateway.ready') {
    const profile = await resolveCallToolsSourceProfileInput({
      profileId: message.profileId,
    })
    const config = normalizeCampaignConfig(profile.config || {})
    const binding = config.calltoolsAgentBinding || {}
    const reportedPhoneId = safeLeadText(message.phoneId)
    const requiredPhoneId = safeLeadText(binding.phoneId)
    if (!reportedPhoneId || (requiredPhoneId && reportedPhoneId !== requiredPhoneId)) {
      throw Object.assign(new Error('CallTools gateway phone does not match the selected profile'), {
        code: 'calltools_gateway_phone_binding_mismatch',
      })
    }
    const gateway = updateCallToolsGatewayRegistry(ws, {
      profileId: profile.id,
      profileName: profile.name || message.profileName,
      phoneId: reportedPhoneId,
      sampleRate: message.sampleRate || config.sampleRate || DEFAULT_SAMPLE_RATE,
      sipConnected: message.sipConnected,
      sipRegistered: message.sipRegistered,
      audioContextState: message.audioContextState,
      localAudioTrackLive:
        message.localAudioTrackLive ?? message.localAudioTrackHealthy,
      playbackMode: message.playbackMode,
      captureMode: message.captureMode,
      runtimeProfile: profile,
    })
    ws.send(
      JSON.stringify({
        type: 'gateway.ack',
        profileId: gateway.profileId,
        sampleRate: gateway.sampleRate,
      }),
    )
    return
  }

  if (message.type === 'gateway.profile.selected') {
    if (message.ok !== true) return
    const existing = calltoolsGatewayRegistry.get(ws)
    if (!existing || existing.activeCallControlId || existing.activeStreamId) {
      throw Object.assign(new Error('CallTools gateway profile cannot change during a call'), {
        code: 'calltools_gateway_profile_busy',
      })
    }
    const profile = await resolveCallToolsSourceProfileInput({
      profileId: message.profileId,
    })
    const config = normalizeCampaignConfig(profile.config || {})
    const requiredPhoneId = safeLeadText(config.calltoolsAgentBinding?.phoneId)
    const reportedPhoneId = safeLeadText(message.phoneId)
    if (
      !requiredPhoneId ||
      requiredPhoneId !== existing.phoneId ||
      reportedPhoneId !== existing.phoneId
    ) {
      throw Object.assign(new Error('Selected profile does not use the registered CallTools phone'), {
        code: 'calltools_gateway_phone_binding_mismatch',
      })
    }
    updateCallToolsGatewayRegistry(ws, {
      profileId: profile.id,
      profileName: profile.name,
      sampleRate: message.sampleRate || config.sampleRate || existing.sampleRate,
      sipConnected: message.sipConnected,
      sipRegistered: message.sipRegistered,
      audioContextState: message.audioContextState,
      localAudioTrackLive:
        message.localAudioTrackLive ?? message.localAudioTrackHealthy,
      playbackMode: message.playbackMode,
      captureMode: message.captureMode,
      runtimeProfile: profile,
    })
    return
  }

  if (message.type === 'gateway.registration.changed') {
    const existing = calltoolsGatewayRegistry.get(ws)
    if (!existing) {
      throw Object.assign(new Error('Unknown CallTools gateway registration response'), {
        code: 'calltools_gateway_registration_unknown',
      })
    }
    updateCallToolsGatewayRegistry(ws, {
      sipConnected: message.sipConnected,
      sipRegistered: message.sipRegistered,
      audioContextState: message.audioContextState,
      localAudioTrackLive:
        message.localAudioTrackLive ?? message.localAudioTrackHealthy,
      registrationRequestId: message.requestId,
      registrationEnabled: message.enabled,
      registrationOk: message.ok,
      registrationError: message.error,
    })
    return
  }

  if (message.type === 'gateway.heartbeat') {
    const gateway = updateCallToolsGatewayRegistry(ws, {
      phoneId: message.phoneId,
      sampleRate: message.sampleRate,
      sipConnected: message.sipConnected,
      sipRegistered: message.sipRegistered,
      audioContextState: message.audioContextState,
      localAudioTrackLive:
        message.localAudioTrackLive ?? message.localAudioTrackHealthy,
      playbackMode: message.playbackMode,
      captureMode: message.captureMode,
    })
    ws.send(
      JSON.stringify({
        type: 'gateway.heartbeat.ack',
        profileId: gateway.profileId,
        sampleRate: gateway.sampleRate,
      }),
    )
    return
  }

  if (message.type === 'call.prepare') {
    try {
      const state = await prepareCallToolsGatewayState({ ws, message, setState })
      ws.send(
        JSON.stringify({
          type: 'call.prepared',
          callControlId: state.callControlId,
          streamId: state.streamId,
        }),
      )
    } catch (error) {
      rejectCallToolsGatewayPreparation(ws, error, message)
    }
    return
  }

  if (message.type === 'call.start') {
    const messageCallControlId = safeLeadText(message.callControlId)
    let state =
      (messageCallControlId ? getCallState(messageCallControlId) : null) ||
      findStateByStreamId(message.streamId)
    try {
      if (state?.callProvider !== 'calltools') {
        state = await prepareCallToolsGatewayState({ ws, message, setState })
      }
      attachPreparedCallToolsGatewayState(state, ws, message, setState)
    } catch (error) {
      rejectCallToolsGatewayPreparation(ws, error, message)
    }
    return
  }

  const callControlId = safeLeadText(message.callControlId)
  const state = getCallState(callControlId) || findStateByStreamId(message.streamId)
  if (!state) {
    ws.send(JSON.stringify({ type: 'error', error: 'Call state not found' }))
    return
  }

  if (message.type === 'audio.input') {
    if (state.ending || isCallEnded(state)) return
    const payload = Buffer.from(message.audio || message.data || '', 'base64')
    const sourceRate = Number(message.sampleRate || state.sampleRate || DEFAULT_SAMPLE_RATE)
    const pcm = alignGatewayPcmToState(payload, sourceRate, state.sampleRate)
    const frameMs = Number(message.frameMs || Math.round(((pcm.length / 2) / state.sampleRate) * 1000))
    addTransportCounter(state, 'calltoolsMediaInPackets')
    addTransportCounter(state, 'calltoolsMediaInBytes', payload.length)
    addTransportCounter(state, 'calltoolsPcmInBytes', pcm.length)
    setTransportDiagnosticValue(state, 'calltools', 'inputFrameMs', frameMs)
    recordTransportMilestone(state, 'first_calltools_media_in', {
      sampleRate: state.sampleRate,
      frameMs,
    })
    recordCallAudioBuffer(state, {
      source: 'lead',
      pcmLittleEndian: pcm,
      sampleRate: state.sampleRate,
    })
    recordCallStageAudioBuffer(state, {
      stage: 'lead-calltools-input',
      pcmLittleEndian: pcm,
      sampleRate: state.sampleRate,
    })
    trackAudioQualityBuffer(state, 'inbound', pcm)
    sendAudioToVoiceProvider(state, pcm)
    return
  }

  if (message.type === 'audio.diagnostic') {
    const diagnostic = normalizeCallToolsGatewayAudioDiagnostic(message.diagnostic)
    if (diagnostic.event) {
      setTransportDiagnosticValue(state, 'calltools', 'remoteAudio', diagnostic)
      if (diagnostic.event === 'pre_ready_audio_flushed') {
        setTransportDiagnosticValue(state, 'calltools', 'readyBuffer', diagnostic)
        state.audioQuality.queue.maxFrames = Math.max(
          Number(state.audioQuality.queue.maxFrames || 0),
          Number(diagnostic.maxBufferedFrames || 0),
        )
        state.audioQuality.queue.maxMs = Math.max(
          Number(state.audioQuality.queue.maxMs || 0),
          Number(diagnostic.maxBufferedFrames || 0) * Number(diagnostic.frameMs || 0),
        )
        state.audioQuality.queue.droppedFrames = Math.max(
          Number(state.audioQuality.queue.droppedFrames || 0),
          Number(diagnostic.droppedFrames || 0),
        )
        addTransportCounter(state, 'calltoolsReadyBufferedFrames', diagnostic.maxBufferedFrames || 0)
        addTransportCounter(state, 'calltoolsReadyFlushedFrames', diagnostic.flushedFrames || 0)
        addTransportCounter(state, 'calltoolsReadyDroppedFrames', diagnostic.droppedFrames || 0)
        recordTransportMilestone(state, 'calltools_ready_audio_flushed', {
          bufferedFrames: diagnostic.maxBufferedFrames,
          flushedFrames: diagnostic.flushedFrames,
          droppedFrames: diagnostic.droppedFrames,
        })
      }
      if (diagnostic.event === 'remote_audio_nonzero') {
        recordTransportMilestone(state, 'first_calltools_remote_audio_nonzero', {
          peak: diagnostic.peak,
          packetCount: diagnostic.packetCount,
          trackId: diagnostic.trackId,
        })
      }
      if (diagnostic.event === 'remote_audio_still_silent') {
        addTransportCounter(state, 'calltoolsRemoteStillSilent')
      }
      emitCallEvent(state.callControlId, {
        diagnostic: buildTransportDiagnosticSnapshot(state),
        notice: 'CallTools audio diagnostic',
      })
    }
    return
  }

  if (message.type === 'call.ended') {
    const outcomeEvent = state.outcome
      ? null
      : setCallOutcome(state, normalizeCallOutcome(message.outcome) || inferStreamStopOutcome(state))
    state.calltoolsGatewayEnded = true
    state.ending = true
    clearCallToolsVoiceReadyTimeout(state)
    closeCallSockets(state)
    clearCallToolsGatewayActiveCall(ws, state)
    persistCallOutcome(state, state.outcome)
    emitCallEvent(state.callControlId, {
      patch: { phase: 'ended', takeover: false, outcome: state.outcome },
      communication: callToolsCommunicationMetadata(state, message, state.calltoolsContext),
      entry: transcriptEntry('System', 'CallTools media gateway reported call end.', 'system'),
      notice: 'CallTools call ended',
    })
    if (outcomeEvent) emitCallEvent(state.callControlId, outcomeEvent)
    scheduleCallToolsRecordingReconciliation(state, message)
  }
}

function prepareCallToolsGatewayState({ ws, message = {}, setState }) {
  const key = callToolsGatewayPreparationKey(message)
  let preparations = calltoolsGatewayPreparations.get(ws)
  if (!preparations) {
    preparations = new Map()
    calltoolsGatewayPreparations.set(ws, preparations)
  }
  if (preparations.has(key)) return preparations.get(key)
  while (preparations.size >= 50) {
    preparations.delete(preparations.keys().next().value)
  }

  const preparation = createCallToolsGatewayState({ ws, message, setState })
  preparations.set(key, preparation)
  return preparation
}

function callToolsGatewayPreparationKey(message = {}) {
  return safeLeadText(
    message.streamId ||
      message.calltoolsCallId ||
      message.callToolsCallId ||
      message.callId ||
      message.id ||
      message.callControlId,
  ) || randomUUID()
}

async function createCallToolsGatewayState({ ws, message = {}, setState }) {
  assertCallToolsGatewaySocketOpen(ws)
  const gatewayRegistration = calltoolsGatewayRegistry.get(ws) || {}
  const dutyState = await readWorkspaceCallToolsDuty()
  const duty = dutyState.calltoolsDuty || dutyState.dialerState?.calltoolsDuty || {}
  cacheCallToolsGatewayLeaseOwner(duty)
  if (!callToolsDutyAcceptsGatewayCall(duty, gatewayRegistration)) {
    throw Object.assign(
      new Error('CallTools campaign call rejected because Speak is not Available on this frozen lease.'),
      { code: 'calltools_duty_lease_required' },
    )
  }
  const registeredProfile = calltoolsGatewayRegistry.get(ws)?.runtimeProfile
  const currentProfileId = safeLeadText(registeredProfile?.id || message.profileId)
  const currentProfile = registeredProfile || (currentProfileId
    ? (
        await resolveWorkspaceRuntimeSnapshot({
          config: { agentProfileId: currentProfileId },
        })
      ).profile
    : null)
  if (currentProfileId && !currentProfile) {
    throw Object.assign(new Error('The active CallTools agent profile no longer exists'), {
      code: 'calltools_agent_profile_not_found',
    })
  }
  assertCallToolsGatewaySocketOpen(ws)
  const resolvedProfile = currentProfile || await resolveCallToolsProfileInput({
    profileId: message.profileId,
    config: message.config,
    profile: message.profile,
  })
  const profile = applySharedCallToolsDutyBinding(
    resolvedProfile,
    registeredProfile ? [registeredProfile] : [],
  )
  let runtimeConfig = normalizeCampaignConfig(
    withCallToolsRuntimeIdentity(profile),
  )
  const profileContext = profile.context || runtimeConfig.profileContext
  const registeredPhoneId = safeLeadText(calltoolsGatewayRegistry.get(ws)?.phoneId)
  const requiredPhoneId = safeLeadText(runtimeConfig.calltoolsAgentBinding?.phoneId)
  if (!registeredPhoneId || (requiredPhoneId && registeredPhoneId !== requiredPhoneId)) {
    throw Object.assign(new Error('CallTools gateway phone binding does not match the active profile'), {
      code: 'calltools_gateway_phone_binding_mismatch',
    })
  }
  if (isInworldRuntime(runtimeConfig)) {
    runtimeConfig = await ensureInworldRuntimeConfigReady(runtimeConfig, {
      allowStale: true,
    })
  } else if (isXaiRuntime(runtimeConfig)) {
    runtimeConfig = await ensureXaiRuntimeConfigReady(runtimeConfig, {
      allowStale: true,
    })
  }
  try {
    await assertCodexClmRuntimeReady(
      runtimeConfig,
      callToolsCodexReadinessInviteOptions(),
    )
  } catch (error) {
    callToolsVoiceStandby.cancel('voice_runtime_unavailable')
    throw error
  }
  runtimeConfig.profileContext = profileContext
  const missing = missingForCall(runtimeConfig)
  if (missing.length > 0) {
    throw Object.assign(new Error('CallTools voice runtime is not ready'), {
      code: 'calltools_voice_runtime_not_ready',
      missing,
    })
  }

  const calltoolsCallId = safeLeadText(
    message.calltoolsCallId || message.callToolsCallId || message.callId || message.id,
  )
  const callControlId = `calltools-${calltoolsCallId || randomUUID()}`

  const initialLead = normalizeLead(
    callToolsGatewayLead(message, callControlId),
  )
  const state =
    claimCallToolsStandbyVoiceSession({
      binding: duty.binding,
      callControlId,
      duty,
      initialLead,
      message,
      profile,
      runtimeConfig,
    }) || createCallState(
      callControlId,
      initialLead,
      runtimeConfig,
      message.operatorInstructions,
    )
  state.calltoolsFirstTurnGate ||= createCallToolsFirstTurnGate({
    assistantStartsConversation: runtimeConfig.eviStartsConversation === true,
  })
  state.calltoolsWs = ws
  state.calltoolsCallId = calltoolsCallId
  state.calltoolsWebCallbackId =
    runtimeConfig.calltoolsAgentBinding?.webCallbackId
  state.calltoolsWebCallbackRequestId = safeLeadText(
    message.calltoolsWebCallbackRequestId || message.callToolsWebCallbackRequestId,
  )
  state.calltoolsContext = null
  state.calltoolsDutyLease = {
    binding: normalizeDutyBinding(duty.binding),
    gatewayOwnerInstanceId: safeLeadText(duty.gatewayOwnerInstanceId),
    leaseId: safeLeadText(duty.leaseId),
    profileId: safeLeadText(duty.profileId),
  }
  state.calltoolsProfile = { id: profile.id, name: profile.name }
  state.calltoolsPrepared = true
  state.callProvider = 'calltools'
  state.streamId = safeLeadText(message.streamId || calltoolsCallId || callControlId)
  state.telnyxCodec = 'L16'
  state.sampleRate = Number(message.sampleRate || runtimeConfig.sampleRate || DEFAULT_SAMPLE_RATE)
  updateAudioQualityTransport(state)
  setTransportDiagnosticValue(state, 'calltools', 'streamId', state.streamId)
  setTransportDiagnosticValue(state, 'calltools', 'sampleRate', state.sampleRate)
  setTransportDiagnosticValue(state, 'hume', 'requestedSampleRate', state.sampleRate)
  recordTransportMilestoneAt(
    state,
    'calltools_gateway_invite_received',
    message.preparedAt || message.inviteReceivedAt || new Date().toISOString(),
    {
      calltoolsCallId,
      campaignFollow: true,
      sampleRate: state.sampleRate,
    },
  )
  updateCallToolsGatewayRegistry(ws, {
    profileId: profile.id || message.profileId,
    profileName: profile.name || message.profileName,
    sampleRate: state.sampleRate,
    activeCallControlId: callControlId,
    activeStreamId: state.streamId,
    runtimeProfile: profile,
  })
  calls.set(callControlId, state)
  setState(state)
  primeCallToolsVoiceContext(state, message)
  connectVoiceSession(state)
  assertCallToolsGatewaySocketOpen(ws)
  return state
}

function callToolsDutyAcceptsGatewayCall(duty = {}, gateway = {}) {
  if (!isActiveCallToolsDuty(duty)) return false
  if (!['arming', 'attention', 'on'].includes(safeLeadText(duty.status))) return false
  const binding = normalizeDutyBinding(duty.binding)
  return Boolean(
    safeLeadText(duty.profileId) &&
      safeLeadText(duty.profileId) === safeLeadText(gateway.profileId) &&
      binding.appUserId &&
      binding.campaignId &&
      binding.phoneId &&
      binding.phoneId === safeLeadText(gateway.phoneId) &&
      safeLeadText(duty.gatewayOwnerInstanceId) &&
      safeLeadText(duty.gatewayOwnerInstanceId) === safeLeadText(gateway.gatewayInstanceId) &&
      gateway.sipRegistered === true
  )
}

function assertCallToolsGatewaySocketOpen(ws) {
  if (ws?.readyState === WebSocket.OPEN && ws.speakClosing !== true) return
  throw Object.assign(new Error('CallTools gateway socket closed during call preparation'), {
    code: 'calltools_gateway_socket_closed',
  })
}

function attachPreparedCallToolsGatewayState(state, ws, message = {}, setState) {
  if (!state) throw new Error('Prepared CallTools state is missing')
  const calltoolsCallId = safeLeadText(
    message.calltoolsCallId ||
      message.callToolsCallId ||
      message.callId ||
      message.id ||
      state.calltoolsCallId,
  )
  state.calltoolsWs = ws
  state.calltoolsCallId = calltoolsCallId
  state.streamId = safeLeadText(
    message.streamId || state.streamId || calltoolsCallId || state.callControlId,
  )
  state.telnyxCodec = 'L16'
  state.sampleRate = Number(
    message.sampleRate || state.config?.sampleRate || state.sampleRate || DEFAULT_SAMPLE_RATE,
  )
  state.answered = true
  state.answeredAt = safeLeadText(message.answeredAt) || new Date().toISOString()
  state.minimumHangupAt = minimumTelnyxHangupAt(state)
  state.calltoolsAttachMessage = message
  state.calltoolsAttachEventPending = true
  updateAudioQualityTransport(state)
  setTransportDiagnosticValue(state, 'calltools', 'streamId', state.streamId)
  setTransportDiagnosticValue(state, 'calltools', 'sampleRate', state.sampleRate)
  setTransportDiagnosticValue(state, 'hume', 'requestedSampleRate', state.sampleRate)
  recordTransportMilestoneAt(
    state,
    'calltools_gateway_attached',
    state.answeredAt,
    {
      calltoolsCallId,
      preconnected: Boolean(state.voiceConnectStarted),
      sampleRate: state.sampleRate,
    },
  )
  updateCallToolsGatewayRegistry(ws, {
    profileId: state.config?.agentProfileId || state.calltoolsProfile?.id || message.profileId,
    profileName: state.config?.agentProfileName || state.calltoolsProfile?.name || message.profileName,
    sampleRate: state.sampleRate,
    activeCallControlId: state.callControlId,
    activeStreamId: state.streamId,
  })
  calls.set(state.callControlId, state)
  setState(state)
  beginCallToolsContextHydration(state, message)
  signalCallToolsGatewayReady(state)
  finalizeCallToolsGatewayAttach(state)
}

function finalizeCallToolsGatewayAttach(state) {
  if (
    !state?.calltoolsAttachEventPending ||
    !state.voiceInputReady ||
    !state.answered ||
    state.ending ||
    isCallEnded(state)
  ) return
  state.calltoolsAttachEventPending = false
  const message = state.calltoolsAttachMessage || {}
  if (!state.calltoolsPrepared || state.calltoolsContextHydrated) {
    persistWorkspaceLeadPatch(state, {
      ...state.lead,
      status: 'calling',
      lastCall: 'In progress',
    })
  }
  emitCallEvent(state.callControlId, {
    persistCommunication: false,
    patch: {
      phase: 'live',
      streamId: state.streamId,
      answeredAt: state.answeredAt,
      minimumHangupAt: state.minimumHangupAt,
    },
    communication: callToolsCommunicationMetadata(state, message, state.calltoolsContext),
    diagnostic: buildTransportDiagnosticSnapshot(state),
    entry: transcriptEntry('System', 'CallTools media gateway attached and voice input is ready.', 'system'),
    notice: 'CallTools voice input ready',
  })
  maybeSendInitialGreetingPrompt(state)
}

function beginCallToolsContextHydration(state, message = {}) {
  if (!state) return Promise.resolve()
  if (state.calltoolsContextHydrationPromise) {
    return state.calltoolsContextHydrationPromise
  }
  state.calltoolsContextPromise ||= resolveCallToolsLiveCallContextWithRetry(
    state,
    message,
  ).catch((error) => {
    console.warn(
      'CallTools live-call context lookup failed:',
      error instanceof Error ? error.message : String(error),
    )
    return null
  })
  state.calltoolsContextHydrationPromise = hydrateCallToolsContext(state, message).catch((error) => {
    console.warn(
      'CallTools background context hydration failed:',
      error instanceof Error ? error.message : String(error),
    )
  })
  return state.calltoolsContextHydrationPromise
}

function primeCallToolsVoiceContext(state, message = {}) {
  const initialContextPromise = state.voicePrewarmContextPromise ||
    readVoiceContactConversationMemory(state.lead)
      .then((memory) => {
        state.contactConversationMemory = memory
        return memory
      })
      .catch(() => {
        state.contactConversationMemory = []
        return []
      })
  const hydrationPromise = beginCallToolsContextHydration(state, message)
  state.voicePrewarmContextPromise = Promise.all([
    initialContextPromise,
    waitForCallToolsContextPreload(state, hydrationPromise),
  ])
}

function waitForCallToolsContextPreload(state, hydrationPromise) {
  const timeoutMs = Math.max(
    100,
    Math.min(5_000, Number(CALLTOOLS_CONTEXT_PRELOAD_TIMEOUT_MS) || 750),
  )
  return new Promise((resolve) => {
    let settled = false
    const finish = (status) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      recordTransportMilestone(state, 'calltools_context_preload_settled', {
        status,
        timeoutMs,
      })
      resolve(status)
    }
    const timer = setTimeout(() => finish('background'), timeoutMs)
    timer.unref?.()
    Promise.resolve(hydrationPromise).then(
      () => finish('hydrated'),
      () => finish('unavailable'),
    )
  })
}

async function resolveCallToolsLiveCallContextWithRetry(state, message = {}) {
  const retryDelaysMs = [0, 250, 500, 1_000, 1_500, 2_000]
  let calltoolsContext = null
  for (const delayMs of retryDelaysMs) {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
    calltoolsContext = await resolveCallToolsLiveCallContext({
      calltoolsCallId: state.calltoolsCallId,
      from: message.from,
      to: message.to,
      config: state.config,
    })
    if (calltoolsContext?.liveCall || calltoolsContext?.contact) return calltoolsContext
    if (state.ending || isCallEnded(state)) break
  }
  return calltoolsContext
}

async function hydrateCallToolsContext(state, message = {}) {
  const calltoolsContext = await state.calltoolsContextPromise
  const currentDutyState = await readWorkspaceCallToolsDuty()
  const currentDuty =
    currentDutyState.calltoolsDuty || currentDutyState.dialerState?.calltoolsDuty || {}
  const calltoolsProviderIdentity = buildCallToolsProviderIdentity(
    state,
    calltoolsContext,
    currentDuty,
  )
  state.calltoolsProviderIdentity = calltoolsProviderIdentity
  emitCallEvent(state.callControlId, {
    calltoolsProviderIdentity,
    communication: callToolsCommunicationMetadata(state, message, calltoolsContext),
  })
  const runtimeContext = await resolveWorkspaceRuntimeSnapshot({
    lead: callToolsGatewayLead(
      message,
      state.callControlId,
      calltoolsContext,
    ),
    config: state.config,
  })
  const normalizedLead = normalizeLead(runtimeContext.lead)
  state.calltoolsContext = calltoolsContext
  state.lead = normalizedLead
  state.config.profileContext = runtimeContext.profileContext
  state.contactConversationMemory = await readVoiceContactConversationMemory(
    normalizedLead,
  )
  state.calltoolsContextHydrated = true
  recordTransportMilestone(state, 'calltools_context_enriched', {
    calltoolsContextResolved: Boolean(calltoolsContext?.liveCall || calltoolsContext?.contact),
    contactIdResolved: Boolean(normalizedLead.id),
  })
  if (state.voiceInputReady) refreshVoiceLeadContext(state)
  if (state.answered && !isCallEnded(state)) {
    emitCallEvent(state.callControlId, {
      leadPatch: {
        leadId: normalizedLead.id,
        patch: normalizedLead,
      },
      diagnostic: buildTransportDiagnosticSnapshot(state),
    })
    if (calltoolsContext?.contact || message.contactId || message.lead?.id) {
      persistWorkspaceLeadPatch(state, {
        ...normalizedLead,
        status: 'calling',
        lastCall: 'In progress',
      })
    }
  }
}

function buildCallToolsProviderIdentity(state, calltoolsContext = null, currentDuty = {}) {
  const expectedLease = state.calltoolsDutyLease || {}
  const expectedBinding = normalizeDutyBinding(expectedLease.binding)
  const currentBinding = normalizeDutyBinding(currentDuty.binding)
  const liveCall = calltoolsContext?.liveCall || null
  const providerCallId = safeLeadText(liveCall?.callUuid)
  const providerAppUserId = safeLeadText(liveCall?.appUserId)
  const providerCampaignId = safeLeadText(liveCall?.campaignId)
  const gatewayInstanceId = safeLeadText(
    calltoolsGatewayRegistry.get(state.calltoolsWs)?.gatewayInstanceId,
  )
  const expected = {
    leaseId: safeLeadText(expectedLease.leaseId),
    profileId: safeLeadText(expectedLease.profileId),
    appUserId: expectedBinding.appUserId,
    campaignId: expectedBinding.campaignId,
    phoneId: expectedBinding.phoneId,
  }
  const errors = []
  if (
    !expected.leaseId ||
    !expected.profileId ||
    !expected.appUserId ||
    !expected.campaignId ||
    !expected.phoneId
  ) errors.push('frozen lease scope is incomplete')
  if (!isActiveCallToolsDuty(currentDuty)) errors.push('active lease is missing')
  if (safeLeadText(currentDuty.leaseId) !== expected.leaseId) errors.push('lease changed')
  if (safeLeadText(currentDuty.profileId) !== expected.profileId) errors.push('profile changed')
  if (currentBinding.appUserId !== expected.appUserId) errors.push('lease app user changed')
  if (currentBinding.campaignId !== expected.campaignId) errors.push('lease campaign changed')
  if (currentBinding.phoneId !== expected.phoneId) errors.push('lease phone changed')
  if (
    !gatewayInstanceId ||
    gatewayInstanceId !== safeLeadText(expectedLease.gatewayOwnerInstanceId) ||
    gatewayInstanceId !== safeLeadText(currentDuty.gatewayOwnerInstanceId)
  ) errors.push('gateway owner changed')
  if (!liveCall) errors.push('provider live call is missing')
  if (!providerCallId) errors.push('provider call ID is missing')
  if (!providerAppUserId) errors.push('provider app user is missing')
  if (!providerCampaignId) errors.push('provider campaign is missing')
  if (providerAppUserId && providerAppUserId !== expected.appUserId) {
    errors.push('provider app user does not match lease')
  }
  if (providerCampaignId && providerCampaignId !== expected.campaignId) {
    errors.push('provider campaign does not match lease')
  }
  const authoritative = Boolean(
    liveCall && providerCallId && providerAppUserId && providerCampaignId,
  )
  return {
    ok: authoritative && errors.length === 0,
    authoritative,
    provider: 'calltools',
    verifiedAt: new Date().toISOString(),
    leaseId: expected.leaseId,
    profileId: expected.profileId,
    appUserId: providerAppUserId,
    campaignId: providerCampaignId,
    phoneId: expected.phoneId,
    providerCallId,
    gatewayCallId: safeLeadText(state.calltoolsCallId),
    expected,
    errors,
  }
}

function rejectCallToolsGatewayPreparation(ws, error, message = {}) {
  if (error?.gatewayRejected === true || ws?.readyState !== WebSocket.OPEN) return
  const streamId = safeLeadText(message.streamId)
  ws.send(
    JSON.stringify({
      type: 'call.rejected',
      callControlId: safeLeadText(error?.callControlId || message.callControlId),
      streamId,
      code: error?.code || 'calltools_gateway_prepare_failed',
      error: error instanceof Error ? error.message : 'CallTools gateway preparation failed',
      missing: Array.isArray(error?.missing)
        ? error.missing.map(publicRuntimeConfigName)
        : undefined,
    }),
  )
}

function normalizeCallToolsGatewayAudioDiagnostic(input = {}) {
  if (!input || typeof input !== 'object') return {}
  const source = input
  const outboundRtp = firstAudioRtpStats(source.webrtc?.outbound)
  const inboundRtp = firstAudioRtpStats(source.webrtc?.inbound)
  return compactPlainObject({
    event: safeLeadText(source.event).slice(0, 80),
    label: safeLeadText(source.label).slice(0, 80),
    reason: safeLeadText(source.reason).slice(0, 80),
    trackId: safeLeadText(source.trackId).slice(0, 140),
    readyState: safeLeadText(source.readyState).slice(0, 40),
    muted: typeof source.muted === 'boolean' ? source.muted : undefined,
    trackCount: finiteNumber(source.trackCount),
    localTrackCount: finiteNumber(source.localTrackCount),
    packetCount: finiteNumber(source.packetCount),
    ready: typeof source.ready === 'boolean' ? source.ready : undefined,
    frameMs: finiteNumber(source.frameMs),
    maxBufferMs: finiteNumber(source.maxBufferMs),
    bufferedFrames: finiteNumber(source.bufferedFrames),
    maxBufferedFrames: finiteNumber(source.maxBufferedFrames),
    droppedFrames: finiteNumber(source.droppedFrames),
    flushedFrames: finiteNumber(source.flushedFrames),
    flushCount: finiteNumber(source.flushCount),
    outputPacket: finiteNumber(source.outputPacket),
    delayMs: finiteNumber(source.delayMs),
    streamSerial: finiteNumber(source.streamSerial),
    peak: finiteNumber(source.peak),
    outboundRtp,
    inboundRtp,
    tracks: Array.isArray(source.tracks)
      ? source.tracks.slice(0, 4).map((track) =>
          compactPlainObject({
            id: safeLeadText(track?.id).slice(0, 140),
            enabled: typeof track?.enabled === 'boolean' ? track.enabled : undefined,
            muted: typeof track?.muted === 'boolean' ? track.muted : undefined,
            readyState: safeLeadText(track?.readyState).slice(0, 40),
          }),
        )
      : undefined,
    localTracks: Array.isArray(source.localTracks)
      ? source.localTracks.slice(0, 4).map((track) =>
          compactPlainObject({
            id: safeLeadText(track?.id).slice(0, 140),
            enabled: typeof track?.enabled === 'boolean' ? track.enabled : undefined,
            muted: typeof track?.muted === 'boolean' ? track.muted : undefined,
            readyState: safeLeadText(track?.readyState).slice(0, 40),
          }),
        )
      : undefined,
  })
}

function firstAudioRtpStats(stats = []) {
  if (!Array.isArray(stats) || !stats.length) return undefined
  const stat = stats.find((item) => item && typeof item === 'object') || {}
  return compactPlainObject({
    id: safeLeadText(stat.id).slice(0, 140),
    packetsSent: finiteNumber(stat.packetsSent),
    bytesSent: finiteNumber(stat.bytesSent),
    retransmittedPacketsSent: finiteNumber(stat.retransmittedPacketsSent),
    retransmittedBytesSent: finiteNumber(stat.retransmittedBytesSent),
    packetsReceived: finiteNumber(stat.packetsReceived),
    packetsLost: finiteNumber(stat.packetsLost),
    packetsDiscarded: finiteNumber(stat.packetsDiscarded),
    bytesReceived: finiteNumber(stat.bytesReceived),
    jitter: finiteNumber(stat.jitter),
    jitterBufferDelay: finiteNumber(stat.jitterBufferDelay),
    jitterBufferEmittedCount: finiteNumber(stat.jitterBufferEmittedCount),
    roundTripTime: finiteNumber(stat.roundTripTime),
    codecId: safeLeadText(stat.codecId).slice(0, 140),
    codec:
      stat.codec && typeof stat.codec === 'object'
        ? compactPlainObject({
            mimeType: safeLeadText(stat.codec.mimeType).slice(0, 80),
            clockRate: finiteNumber(stat.codec.clockRate),
            channels: finiteNumber(stat.codec.channels),
            payloadType: finiteNumber(stat.codec.payloadType),
          })
        : undefined,
    audioLevel: finiteNumber(stat.audioLevel),
    totalAudioEnergy: finiteNumber(stat.totalAudioEnergy),
    totalSamplesDuration: finiteNumber(stat.totalSamplesDuration),
    concealedSamples: finiteNumber(stat.concealedSamples),
    silentConcealedSamples: finiteNumber(stat.silentConcealedSamples),
  })
}

function finiteNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function compactPlainObject(source = {}) {
  return Object.fromEntries(
    Object.entries(source).filter(([, value]) => {
      if (value === undefined || value === null || value === '') return false
      if (Array.isArray(value) && value.length === 0) return false
      return true
    }),
  )
}

function readVoiceContactConversationMemory(lead, limit = 3) {
  const contactId = conversationMemoryContactIdForLead(lead)
  if (!contactId) return Promise.resolve([])
  return readContactCommunicationMemory({ contactId, limit })
}

function prepareProvisionalVoiceSession({
  key,
  state: suppliedState = null,
  callControlId = '',
  lead = {},
  runtimeConfig = {},
  operatorInstructions = [],
  origin = '',
  requireBinding = false,
  connectImmediately = true,
  ttlMs,
} = {}) {
  const existing = provisionalVoiceSessions.get(key)
  if (existing) return existing.state

  const state = suppliedState || createCallState(
    callControlId,
    lead,
    runtimeConfig,
    operatorInstructions,
  )
  state.origin = origin || state.origin || ''
  state.voiceProviderSessionKey ||= state.callControlId
  if (requireBinding && !state.voicePrewarmBindingPromise) {
    state.voicePrewarmBindingPromise = new Promise((resolve) => {
      state.resolveVoicePrewarmBinding = resolve
    })
  }
  state.voicePrewarmContextPromise ||= readVoiceContactConversationMemory(
    state.lead,
  )
    .then((memory) => {
      state.contactConversationMemory = memory
      return memory
    })
    .catch((error) => {
      state.contactConversationMemory = []
      setTransportDiagnosticValue(
        state,
        'voice',
        'prewarmContextError',
        error instanceof Error ? error.message : 'contact_context_unavailable',
      )
      return []
    })
  provisionalVoiceSessions.prepare({ key, state, ttlMs })
  voiceProviderSessionAliases.set(state.voiceProviderSessionKey, state)
  recordTransportMilestone(state, 'voice_preconnect_started', {
    provider: isXaiRuntime(state.config)
      ? 'xai'
      : isInworldRuntime(state.config)
        ? 'inworld'
        : 'hume',
  })
  if (connectImmediately) connectVoiceSession(state)
  return state
}

function prepareCallToolsStandbyVoiceSession({ key, scope = {} } = {}) {
  const profile = scope.profile || {}
  const sourceConfig = scope.config || profile.config || {}
  const runtimeConfig = {
    ...sourceConfig,
    profileContext: profile.context || sourceConfig.profileContext,
  }
  const runtimeGeneration = safeLeadText(
    scope.runtimeGeneration || profile.updatedAt,
  )
  const runtimeFingerprint = callToolsVoiceStandbyRuntimeFingerprint({
    config: runtimeConfig,
    generation: runtimeGeneration,
  })
  const state = createCallState(
    `calltools-standby-${randomUUID()}`,
    {
      id: `calltools-standby-${safeLeadText(scope.profileId)}`,
      name: 'Pending CallTools contact',
      company: '',
      phone: '',
      email: '',
      status: 'ready',
    },
    runtimeConfig,
    [],
  )
  state.calltoolsStandby = true
  state.calltoolsStandbyScope = {
    leaseId: safeLeadText(scope.leaseId),
    profileId: safeLeadText(scope.profileId),
    binding: normalizeDutyBinding(scope.binding),
    runtimeFingerprint,
    runtimeGeneration,
  }
  return prepareProvisionalVoiceSession({
    key,
    state,
    origin: 'calltools_standby',
    requireBinding: true,
    connectImmediately: true,
    ttlMs: numberEnv('CALLTOOLS_VOICE_STANDBY_TTL_MS', 5 * 60_000),
  })
}

function ensureCallToolsStandbyVoiceSession({
  binding,
  config,
  leaseId,
  profile,
} = {}) {
  const runtimeConfig = {
    ...(config || {}),
    profileContext: profile?.context || config?.profileContext,
  }
  return callToolsVoiceStandby.ensure({
    binding: normalizeDutyBinding(binding),
    config: runtimeConfig,
    leaseId,
    profile,
    profileId: profile?.id,
    runtimeGeneration: profile?.updatedAt,
  })
}

function callToolsStandbyVoiceSessionHealthy(state) {
  if (!state || state.ending || state.calltoolsStandby !== true) return false
  if (!state.voiceConnectStarted) return true
  const socket = isXaiRuntime(state.config)
    ? state.xaiWs
    : isInworldRuntime(state.config)
      ? state.inworldWs
      : state.humeWs
  return Boolean(
    socket && [WebSocket.CONNECTING, WebSocket.OPEN].includes(socket.readyState),
  )
}

function scheduleCallToolsStandbyReplenishment(state) {
  if (
    !state ||
    state.calltoolsStandby ||
    state.calltoolsStandbyReplenishmentScheduled
  ) return
  state.calltoolsStandbyReplenishmentScheduled = true
  const timer = setTimeout(async () => {
    try {
      const dutyState = await readWorkspaceCallToolsDuty()
      const duty = dutyState.calltoolsDuty || dutyState.dialerState?.calltoolsDuty || {}
      if (
        !isActiveCallToolsDuty(duty) ||
        duty.status === 'disarming' ||
        safeLeadText(duty.profileId) !== safeLeadText(state.calltoolsProfile?.id)
      ) return
      const binding = normalizeDutyBinding(duty.binding)
      const stateBinding = normalizeDutyBinding(state.config?.calltoolsAgentBinding)
      if (
        binding.appUserId !== stateBinding.appUserId ||
        binding.campaignId !== stateBinding.campaignId ||
        binding.phoneId !== stateBinding.phoneId
      ) return
      const profile = await resolveCallToolsSourceProfileInput({
        profileId: duty.profileId,
      })
      const config = await ensureVoiceRuntimeReady(
        normalizeCampaignConfig({
          ...(profile.config || {}),
          agentProfileId: profile.id,
          agentProfileName: profile.name,
        }),
        { codexReadiness: callToolsCodexReadinessRefreshOptions() },
      )
      config.profileContext = profile.context || config.profileContext
      await bindCallToolsGatewayToProfile({ ...profile, config }, binding)
      ensureCallToolsStandbyVoiceSession({
        binding,
        config,
        leaseId: duty.leaseId,
        profile,
      })
    } catch (error) {
      callToolsVoiceStandby.cancel('voice_runtime_unavailable')
      console.warn(
        'CallTools standby replenishment failed:',
        error instanceof Error ? error.message : String(error),
      )
    }
  }, 0)
  timer.unref?.()
}

function claimCallToolsStandbyVoiceSession({
  binding,
  callControlId,
  duty,
  initialLead,
  message = {},
  profile,
  runtimeConfig,
} = {}) {
  return callToolsVoiceStandby.claim(
    {
      binding: normalizeDutyBinding(binding),
      config: runtimeConfig,
      leaseId: duty?.leaseId,
      profile,
      profileId: profile?.id,
      runtimeGeneration: profile?.updatedAt,
    },
    ({ key, state }) => {
      const claimedAt = new Date().toISOString()
      state.calltoolsStandby = false
      state.calltoolsStandbyClaimedAt = claimedAt
      state.lead = normalizeLead(initialLead)
      state.callTargetPhone = normalizePhone(initialLead?.phone || '')
      state.operatorInstructions = Array.isArray(message.operatorInstructions)
        ? message.operatorInstructions
            .map((instruction) => safeLeadText(instruction))
            .filter(Boolean)
            .slice(-10)
        : []
      state.createdAt = claimedAt
      state.updatedAt = claimedAt
      state.voicePrewarmContextPromise = readVoiceContactConversationMemory(
        state.lead,
      )
        .then((memory) => {
          state.contactConversationMemory = memory
          return memory
        })
        .catch(() => {
          state.contactConversationMemory = []
          return []
        })
      recordTransportMilestone(state, 'calltools_voice_standby_claimed', {
        leaseId: safeLeadText(duty?.leaseId),
        profileId: safeLeadText(profile?.id),
      })
      return bindProvisionalVoiceSession(key, callControlId, state)
    },
  )
}

function bindProvisionalVoiceSession(key, callControlId, expectedState = null) {
  if (
    expectedState &&
    expectedState.callControlId === callControlId &&
    !isProvisionalVoiceSessionState(expectedState)
  ) {
    return expectedState
  }
  const bound = provisionalVoiceSessions.bind(key, { callControlId })
  if (!bound) return calls.get(callControlId) || null

  const state = bound.state
  state.resolveVoicePrewarmBinding?.()
  state.resolveVoicePrewarmBinding = null
  calls.set(callControlId, state)
  voiceProviderSessionAliases.set(state.voiceProviderSessionKey || callControlId, state)
  recordTransportMilestone(state, 'voice_preconnect_bound', {
    provisionalCallControlId: bound.provisionalCallControlId,
    callControlId,
    elapsedMs: Math.max(0, Date.now() - bound.createdAtMs),
  })
  for (const event of drainProvisionalVoiceSessionEvents(state)) {
    emitCallEvent(callControlId, event)
  }
  return state
}

function cancelProvisionalVoiceSession(key, reason) {
  return provisionalVoiceSessions.cancel(key, reason)
}

function prepareBoundVoiceSessionFallback({
  callControlId,
  lead,
  runtimeConfig,
  operatorInstructions = [],
  origin = '',
  reason = '',
} = {}) {
  const state = createCallState(
    callControlId,
    lead,
    runtimeConfig,
    operatorInstructions,
  )
  state.origin = origin
  state.voiceProviderSessionKey = callControlId
  state.voicePrewarmContextPromise = readVoiceContactConversationMemory(
    state.lead,
  )
    .then((memory) => {
      state.contactConversationMemory = memory
      return memory
    })
    .catch(() => {
      state.contactConversationMemory = []
      return []
    })
  calls.set(callControlId, state)
  voiceProviderSessionAliases.set(callControlId, state)
  recordTransportMilestone(state, 'voice_preconnect_fallback', { reason })
  connectVoiceSession(state)
  return state
}

function forgetVoiceProviderSessionAlias(state) {
  const key = safeLeadText(state?.voiceProviderSessionKey)
  if (key && voiceProviderSessionAliases.get(key) === state) {
    voiceProviderSessionAliases.delete(key)
  }
}

async function waitForVoicePrewarmContext(state) {
  if (!state?.voicePrewarmContextPromise) return
  await state.voicePrewarmContextPromise
}

async function waitForVoicePrewarmBinding(state) {
  if (!state?.voicePrewarmBindingPromise) return
  await state.voicePrewarmBindingPromise
}

function connectVoiceSession(state) {
  scheduleCallToolsVoiceReadyTimeout(state)
  if (!state.voiceConnectStarted) {
    state.voiceConnectStarted = true
    recordTransportMilestone(state, 'voice_connect_started', {
      provider: isXaiRuntime(state.config)
        ? 'xai'
        : isInworldRuntime(state.config)
          ? 'inworld'
          : 'hume',
    })
  }
  if (isXaiRuntime(state.config)) {
    connectXai(state)
    return
  }
  if (isInworldRuntime(state.config)) {
    connectInworld(state)
    return
  }

  connectHume(state)
}

function waitForCallToolsVoiceInputReady(state) {
  if (!isCallToolsGatewayCall(state) || state.voiceInputReady) {
    return Promise.resolve(state)
  }
  if (state.calltoolsVoiceReadyFailed) {
    return Promise.reject(callToolsVoiceReadinessError(state))
  }
  if (!state.calltoolsVoiceReadyPromise) {
    state.calltoolsVoiceReadyPromise = new Promise((resolve, reject) => {
      state.resolveCallToolsVoiceReady = resolve
      state.rejectCallToolsVoiceReady = reject
    })
  }
  return state.calltoolsVoiceReadyPromise
}

function callToolsVoiceReadinessError(state, code = '') {
  return Object.assign(
    new Error('Speak voice input did not become ready before CallTools SIP answer.'),
    {
      callControlId: state?.callControlId,
      code: code || state?.calltoolsVoiceReadyFailureCode || 'calltools_voice_input_unavailable',
    },
  )
}

function markVoiceInputReady(state, provider) {
  if (
    !state ||
    state.voiceInputReady ||
    state.calltoolsVoiceReadyFailed ||
    state.ending ||
    isCallEnded(state)
  ) return
  clearCallToolsVoiceReadyTimeout(state)
  state.voiceInputReady = true
  recordTransportMilestone(state, 'voice_input_ready', { provider })
  flushVoiceInputPreReadyBuffer(state, provider)
  state.resolveVoiceInputReady?.()
  state.resolveVoiceInputReady = null
  state.resolveCallToolsVoiceReady?.(state)
  state.resolveCallToolsVoiceReady = null
  state.rejectCallToolsVoiceReady = null
  signalCallToolsGatewayReady(state)
  finalizeCallToolsGatewayAttach(state)
}

function scheduleCallToolsVoiceReadyTimeout(state) {
  if (
    !isCallToolsGatewayCall(state) ||
    state.voiceInputReady ||
    state.calltoolsVoiceReadyTimer
  ) return
  const timeoutMs = Math.max(1_000, Math.min(60_000, CALLTOOLS_VOICE_READY_TIMEOUT_MS))
  state.calltoolsVoiceReadyTimer = setTimeout(() => {
    state.calltoolsVoiceReadyTimer = null
    failCallToolsVoiceReadiness(
      state,
      'calltools_voice_input_ready_timeout',
      `Voice input was not ready within ${timeoutMs} ms`,
    )
  }, timeoutMs)
}

function clearCallToolsVoiceReadyTimeout(state) {
  if (!state?.calltoolsVoiceReadyTimer) return
  clearTimeout(state.calltoolsVoiceReadyTimer)
  state.calltoolsVoiceReadyTimer = null
}

function failCallToolsVoiceReadiness(state, code, detail = '') {
  if (
    !state ||
    !isCallToolsGatewayCall(state) ||
    state.voiceInputReady ||
    state.calltoolsVoiceReadyFailed ||
    isCallEnded(state)
  ) return false

  state.calltoolsVoiceReadyFailed = true
  state.calltoolsVoiceReadyFailureCode = code
  state.ending = true
  clearCallToolsVoiceReadyTimeout(state)
  state.humeWs?.close(1011, 'Voice input unavailable')
  state.inworldWs?.close(1011, 'Voice input unavailable')
  state.xaiWs?.close(1011, 'Voice input unavailable')
  let gatewayRejected = false
  if (state.calltoolsWs?.readyState === WebSocket.OPEN) {
    state.calltoolsWs.send(
      JSON.stringify({
        type: 'call.rejected',
        callControlId: state.callControlId,
        streamId: state.streamId,
        code,
        error: 'Speak voice input is unavailable',
      }),
    )
    gatewayRejected = true
  }
  const readinessError = callToolsVoiceReadinessError(state, code)
  readinessError.gatewayRejected = gatewayRejected
  state.rejectCallToolsVoiceReady?.(readinessError)
  state.resolveCallToolsVoiceReady = null
  state.rejectCallToolsVoiceReady = null
  const outcomeEvent = setCallOutcome(state, 'failed', safeLeadText(detail || code))
  if (outcomeEvent) emitCallEvent(state.callControlId, outcomeEvent)
  emitCallEvent(state.callControlId, {
    patch: { phase: 'ended', takeover: false, outcome: state.outcome || 'failed' },
    entry: transcriptEntry(
      'System',
      'Speak voice input did not become ready; the CallTools call was ended.',
      'attention',
    ),
    notice: 'CallTools voice input unavailable',
  })
  return true
}

function failCallToolsVoiceSession(state, code, detail = '') {
  if (
    !state ||
    !isCallToolsGatewayCall(state) ||
    !state.voiceInputReady ||
    state.calltoolsVoiceSessionFailed ||
    state.ending ||
    isCallEnded(state)
  ) return false

  state.calltoolsVoiceSessionFailed = true
  state.ending = true
  state.hangupRequestedAt = new Date().toISOString()
  clearCallToolsVoiceReadyTimeout(state)
  const outcomeEvent = setCallOutcome(state, 'failed', safeLeadText(detail || code))
  if (outcomeEvent) emitCallEvent(state.callControlId, outcomeEvent)
  if (state.humeWs?.readyState === WebSocket.OPEN) {
    state.humeWs.close(1011, 'Voice session unavailable')
  }
  if (state.inworldWs?.readyState === WebSocket.OPEN) {
    state.inworldWs.close(1011, 'Voice session unavailable')
  }
  if (state.xaiWs?.readyState === WebSocket.OPEN) {
    state.xaiWs.close(1011, 'Voice session unavailable')
  }
  const hangupRequested = requestCallToolsGatewayHangup(
    state,
    'failed',
    code || 'voice_provider_disconnected',
  )
  emitCallEvent(state.callControlId, {
    ...(hangupRequested
      ? {}
      : { patch: { phase: 'ended', takeover: false, outcome: state.outcome || 'failed' } }),
    entry: transcriptEntry(
      'System',
      hangupRequested
        ? 'The voice provider disconnected; Speak requested immediate CallTools hangup.'
        : 'The voice provider and CallTools gateway disconnected; the call was ended.',
      'attention',
    ),
    notice: 'CallTools voice session unavailable',
  })
  if (!hangupRequested) {
    closeCallSockets(state)
    persistCallOutcome(state, state.outcome || 'failed')
  }
  return true
}

function signalCallToolsGatewayReady(state) {
  if (
    !state ||
    state.calltoolsGatewayReadySent ||
    !state.voiceInputReady ||
    !state.answered ||
    state.ending ||
    isCallEnded(state) ||
    !isCallToolsGatewayCall(state) ||
    state.calltoolsWs?.readyState !== WebSocket.OPEN
  ) {
    return false
  }

  state.calltoolsGatewayReadySent = true
  state.calltoolsWs.send(
    JSON.stringify({
      type: 'call.ready',
      callControlId: state.callControlId,
      streamId: state.streamId,
      sampleRate: state.sampleRate,
    }),
  )
  recordTransportMilestone(state, 'calltools_gateway_ready_sent', {
    provider: isXaiRuntime(state.config)
      ? 'xai'
      : isInworldRuntime(state.config)
        ? 'inworld'
        : 'hume',
    sampleRate: state.sampleRate,
  })
  return true
}

function callToolsGatewayLead(message = {}, fallbackId = '', calltoolsContext = null) {
  const contextLead = calltoolsContext?.lead && typeof calltoolsContext.lead === 'object'
    ? calltoolsContext.lead
    : {}
  const providerIds = cleanObject({
    ...(contextLead.providerIds || {}),
    ...(calltoolsContext?.providerIds || {}),
  })
  const sourceFields = callToolsGatewaySourceFields({
    contextLead,
    message,
    providerIds,
  })
  return {
    id: safeLeadText(contextLead.id || message.contactId || message.lead?.id || fallbackId),
    firstName: safeLeadText(contextLead.firstName || message.firstName || message.lead?.firstName),
    lastName: safeLeadText(contextLead.lastName || message.lastName || message.lead?.lastName),
    name: safeLeadText(
      contextLead.name ||
        message.name ||
        message.fullName ||
        message.lead?.name ||
        message.fromName ||
        message.from ||
        'CallTools contact',
    ),
    company: safeLeadText(contextLead.company || message.company || message.lead?.company || 'CallTools'),
    phone: normalizePhone(
      contextLead.phone || message.phone || message.fromPhone || message.from || message.lead?.phone || '',
    ),
    email: cleanEmail(contextLead.email || message.email || message.lead?.email || ''),
    state: safeLeadText(contextLead.state || message.state || message.lead?.state),
    tags: Array.isArray(contextLead.tags)
      ? contextLead.tags
      : Array.isArray(message.tags)
        ? message.tags
        : message.lead?.tags || [],
    score: Number(contextLead.score || message.score || message.lead?.score || 0),
    status: 'calling',
    lastCall: 'In progress',
    notes: safeLeadText(contextLead.notes || message.notes || message.lead?.notes),
    context: contextLead.context || message.lead?.context,
    ...sourceFields,
    providerIds,
  }
}

function callToolsGatewaySourceFields({
  contextLead = {},
  message = {},
  providerIds = {},
} = {}) {
  const source = safeLeadText(
    contextLead.source ||
      message.lead?.source ||
      (providerIds.calltoolsContactId || providerIds.calltoolsCampaignId || providerIds.calltoolsCallId
        ? 'calltools'
        : ''),
  )
  const sourceId = safeLeadText(
    contextLead.sourceId ||
      message.lead?.sourceId ||
      callToolsProviderSourceId(providerIds),
  )
  const sourceName =
    safeLeadText(contextLead.sourceName || message.lead?.sourceName) ||
    (source === 'calltools' ? 'CallTools Contacts' : '')

  return cleanObject({
    source,
    sourceId,
    sourceName,
    sourceUrl: safeLeadText(contextLead.sourceUrl || message.lead?.sourceUrl),
    externalUrl: safeLeadText(contextLead.externalUrl || message.lead?.externalUrl),
    sourceSyncedAt: safeLeadText(
      contextLead.sourceSyncedAt || message.lead?.sourceSyncedAt,
    ),
  })
}

function callToolsProviderSourceId(providerIds = {}) {
  const campaignId = safeLeadText(providerIds.calltoolsCampaignId)
  return campaignId ? `campaign:${campaignId}` : ''
}

function callToolsCommunicationMetadata(state, message = {}, calltoolsContext = null) {
  const historicalCall = state.calltoolsHistoricalCall || calltoolsContext?.historicalCall || null
  const calltoolsCallId =
    state.calltoolsCallId ||
    message.calltoolsCallId ||
    message.callToolsCallId ||
    message.callId ||
    calltoolsContext?.providerIds?.calltoolsCallId ||
    historicalCall?.uuid
  const calltoolsRecordingFsFileId =
    historicalCall?.callRecordingFsFileId ||
    message.calltoolsRecordingFsFileId ||
    message.callToolsRecordingFsFileId ||
    message.calltools_recording_fsfile_id
  return {
    provider: 'calltools',
    channel: 'call',
    providerIds: cleanObject({
      calltoolsCallId,
      ...(calltoolsContext?.providerIds || {}),
      calltoolsHistoricalCallId: historicalCall?.id,
      calltoolsRecordingFsFileId,
      calltoolsContactId: firstCallToolsProviderId(
        calltoolsContext?.providerIds?.calltoolsContactId,
        historicalCall?.contactId,
        message.calltoolsContactId,
        message.callToolsContactId,
        message.contactId,
        message.lead?.providerIds?.calltoolsContactId,
        message.lead?.providerIds?.calltools_contact_id,
        message.lead?.id,
      ),
      calltoolsCampaignId:
        calltoolsContext?.providerIds?.calltoolsCampaignId ||
        message.calltoolsCampaignId ||
        message.callToolsCampaignId ||
        state.config?.calltoolsAgentBinding?.campaignId,
      calltoolsWebCallbackId:
        state.calltoolsWebCallbackId ||
        calltoolsContext?.providerIds?.calltoolsWebCallbackId ||
        message.calltoolsWebCallbackId ||
        message.callToolsWebCallbackId ||
        state.config?.calltoolsAgentBinding?.webCallbackId,
      calltoolsWebCallbackRequestId:
        state.calltoolsWebCallbackRequestId ||
        message.calltoolsWebCallbackRequestId ||
        message.callToolsWebCallbackRequestId,
      calltoolsPhoneId: state.config?.calltoolsAgentBinding?.phoneId,
      calltoolsAppUserId:
        calltoolsContext?.providerIds?.calltoolsAppUserId ||
        state.calltoolsDutyLease?.binding?.appUserId,
      calltoolsQueueId:
        calltoolsContext?.providerIds?.calltoolsQueueId ||
        message.calltoolsQueueId ||
        message.callToolsQueueId ||
        state.config?.calltoolsAgentBinding?.queueId,
    }),
    attachments: callToolsCommunicationAttachments({
      calltoolsCallId,
      historicalCall,
      calltoolsRecordingFsFileId,
    }),
  }
}

function callToolsCommunicationAttachments({
  calltoolsCallId,
  historicalCall,
  calltoolsRecordingFsFileId,
} = {}) {
  if (!calltoolsRecordingFsFileId) return []
  return [
    cleanObject({
      id: `calltools-recording-${calltoolsRecordingFsFileId}`,
      provider: 'calltools',
      source: 'calltools',
      kind: 'call_recording',
      status: 'provider_reference',
      label: 'CallTools recording',
      message: 'CallTools recording metadata is available; playback should resolve through a backend-controlled provider URL when exposed.',
      calltoolsCallId,
      calltoolsHistoricalCallId: historicalCall?.id,
      calltoolsRecordingFsFileId,
      startedAt: historicalCall?.startedAt,
      endedAt: historicalCall?.endedAt,
      duration: historicalCall?.duration,
      billsec: historicalCall?.billsec,
    }),
  ]
}

function firstCallToolsProviderId(...values) {
  for (const value of values) {
    const normalized = normalizeCallToolsProviderId(value)
    if (normalized) return normalized
  }
  return ''
}

function normalizeCallToolsProviderId(value = '') {
  const text = safeLeadText(value)
  if (!text) return ''
  const prefixed = text.match(/^calltools-(.+)$/i)
  return safeLeadText(prefixed?.[1] || text)
}

function alignGatewayPcmToState(pcmLittleEndian, sourceRate, targetRate) {
  if (!pcmLittleEndian?.length) return Buffer.alloc(0)
  const aligned = pcmLittleEndian.length % 2
    ? pcmLittleEndian.subarray(0, pcmLittleEndian.length - 1)
    : pcmLittleEndian
  if (Number(sourceRate) === Number(targetRate)) return aligned
  return int16ToBufferLE(resamplePcm16(bufferToInt16LE(aligned), sourceRate, targetRate))
}

function connectXai(state, { resume = false } = {}) {
  if (
    state.xaiWs &&
    [WebSocket.CONNECTING, WebSocket.OPEN].includes(state.xaiWs.readyState)
  ) return

  const apiKey = getXaiApiKey()
  if (!apiKey) {
    emitCallEvent(state.callControlId, {
      entry: transcriptEntry('System', 'xAI API key is required for this realtime voice session.', 'attention'),
      notice: 'xAI not configured',
    })
    return
  }

  const url = new URL(`${XAI_API_BASE.replace('https:', 'wss:')}/v1/realtime`)
  url.searchParams.set(
    'model',
    state.config.xaiRealtimeModel || state.config.languageModelResource || 'grok-voice-latest',
  )
  if (resume && state.xaiConversationId) {
    url.searchParams.set('conversation_id', state.xaiConversationId)
  }
  const ws = new WebSocket(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  state.xaiWs = ws

  ws.on('open', () => {
    state.xaiReconnecting = false
    recordTransportMilestone(state, 'xai_ws_open', { resumed: resume })
    emitCallEvent(state.callControlId, {
      diagnostic: buildTransportDiagnosticSnapshot(state),
      entry: transcriptEntry(
        'System',
        resume ? 'xAI realtime voice session reconnected.' : 'xAI realtime voice socket connected.',
        'system',
      ),
      notice: resume ? 'xAI reconnected' : 'xAI connected',
    })
    void activatePrewarmedXaiSession(state, ws)
  })

  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      handleXaiAudioDelta(state, Buffer.from(raw))
      return
    }
    try {
      handleXaiMessage(state, JSON.parse(raw.toString()))
    } catch (error) {
      emitCallEvent(state.callControlId, {
        entry: transcriptEntry(
          'System',
          `xAI realtime event could not be processed: ${error instanceof Error ? error.message : String(error)}`,
          'attention',
        ),
        notice: 'xAI event error',
      })
    }
  })

  ws.on('close', (code, reason) => {
    if (state.xaiWs !== ws) return
    state.xaiWs = null
    state.voiceInputReady = false
    if (state.provisionalVoiceSession?.canceledReason || state.ending || isCallEnded(state)) {
      discardVoiceInputPreReadyBuffer(state, 'xai_session_closed')
      return
    }
    const detail = [code ? `code ${code}` : '', reason?.toString() || '']
      .filter(Boolean)
      .join(', ')
    if (
      code !== 1000 &&
      state.config.xaiResumptionEnabled !== false &&
      state.xaiConversationId &&
      Number(state.xaiReconnectAttempts || 0) < 2
    ) {
      state.xaiReconnectAttempts = Number(state.xaiReconnectAttempts || 0) + 1
      state.xaiReconnecting = true
      recordTransportMilestone(state, 'xai_reconnect_scheduled', {
        attempt: state.xaiReconnectAttempts,
        code,
      })
      setTimeout(() => {
        if (!state.ending && !isCallEnded(state)) connectXai(state, { resume: true })
      }, 250 * state.xaiReconnectAttempts).unref?.()
      return
    }
    discardVoiceInputPreReadyBuffer(state, 'xai_session_closed')
    if (state.calltoolsStandby) {
      callToolsVoiceStandby.cancel('provider_disconnected')
      return
    }
    emitCallEvent(state.callControlId, {
      entry: transcriptEntry(
        'System',
        `xAI realtime voice session disconnected${detail ? ` (${detail})` : ''}.`,
        'system',
      ),
      notice: 'xAI disconnected',
    })
    const failedBeforeReady = failCallToolsVoiceReadiness(
      state,
      'calltools_xai_disconnected_before_ready',
      'xAI disconnected before voice input became ready',
    )
    if (!failedBeforeReady && code !== 1000) {
      failCallToolsVoiceSession(
        state,
        'calltools_xai_disconnected_after_ready',
        'xAI disconnected after voice input became ready',
      )
    }
    if (state.personalPhoneInboundCorrelationId && code !== 1000 && !state.ending) {
      state.telnyxWs?.close(1011, 'Voice session disconnected')
    }
  })

  ws.on('error', (error) => {
    if (state.provisionalVoiceSession?.canceledReason || state.ending) return
    recordTransportMilestone(state, 'xai_ws_error', {
      message: safeLeadText(error?.message),
    })
  })
}

async function activatePrewarmedXaiSession(state, ws) {
  await waitForVoicePrewarmBinding(state)
  await waitForVoicePrewarmContext(state)
  if (
    state.ending ||
    state.xaiWs !== ws ||
    ws.readyState !== WebSocket.OPEN ||
    isCallEnded(state)
  ) return
  sendXaiSessionUpdate(state, { includeTools: true })
  armCallToolsFirstTurnGate(state, 'xai')
}

function handleXaiMessage(state, message = {}) {
  if (message.type === 'session.created') {
    state.chatId = message.session?.id || message.session_id || state.chatId || state.callControlId
    recordTransportMilestone(state, 'xai_session_attached', { chatId: state.chatId })
    emitCallEvent(state.callControlId, {
      patch: cleanObject({
        chatId: state.chatId,
        phase: state.browserTest || state.answered ? 'live' : undefined,
      }),
      diagnostic: buildTransportDiagnosticSnapshot(state),
      entry: transcriptEntry('System', `xAI realtime session ${state.chatId} attached.`, 'system'),
      notice: 'xAI session attached',
    })
    return
  }
  if (message.type === 'conversation.created') {
    state.xaiConversationId = safeLeadText(message.conversation?.id || message.conversation_id)
    setTransportDiagnosticValue(state, 'xai', 'conversationIdAttached', Boolean(state.xaiConversationId))
    return
  }
  if (message.type === 'session.updated') {
    state.xaiReconnectAttempts = 0
    recordTransportMilestone(state, 'xai_session_updated')
    markVoiceInputReady(state, 'xai')
    maybeSendInitialGreetingPrompt(state)
    return
  }
  if (message.type === 'response.created') {
    state.xaiResponseActive = true
    state.assistantResponseActive = true
    return
  }
  if (
    message.type === 'response.output_audio.delta' ||
    message.type === 'response.audio.delta'
  ) {
    handleXaiAudioDelta(state, Buffer.from(message.delta || message.audio || '', 'base64'))
    return
  }
  if (message.type === 'response.done') {
    clearAssistantResponseIdleGuard(state)
    state.assistantResponseActive = false
    state.xaiResponseActive = false
    if (!state.browserTest && !isCallToolsGatewayCall(state)) flushTelnyxOutboundRemainder(state)
    if (state.xaiTemporaryInstruction) {
      state.xaiTemporaryInstruction = ''
      sendXaiSessionUpdate(state, { includeTools: false })
    }
    if (state.xaiPendingToolCalls?.size) {
      void flushXaiToolCalls(state)
    } else {
      void sendPendingPlaygroundUserInput(state, 'xai_response_done').catch((error) =>
        emitPlaygroundUserInputFailure(state, error),
      )
    }
    return
  }
  if (message.type === 'input_audio_buffer.speech_started') {
    const interruptedAssistant = Boolean(state.assistantResponseActive || state.xaiResponseActive)
    state.xaiUserSpeechActive = true
    state.lastInterruptionAt = Date.now()
    recordTransportMilestone(state, 'first_xai_speech_started')
    clearAssistantResponseIdleGuard(state)
    state.assistantResponseActive = false
    addTransportCounter(state, 'xaiInterruptions')
    cancelXaiResponse(state, { clearInput: false })
    clearQueuedAssistantAudio(state, 'xai_speech_started')
    schedulePendingPlaygroundUserInput(state, 150, 'xai_speech_started')
    if (interruptedAssistant) {
      voiceInterruptionRecovery.arm(state, {
        provider: 'xai',
        reason: 'speech_started_during_assistant_response',
      })
    }
    return
  }
  if (message.type === 'input_audio_buffer.speech_stopped') {
    state.xaiUserSpeechActive = false
    noteCallerSpeechStopped(state, { provider: 'xai' })
    recordTransportMilestone(state, 'first_xai_speech_stopped')
    return
  }
  if (message.type === 'conversation.item.input_audio_transcription.updated') {
    const transcript = normalizeTranscriptContent(message.transcript || message.text || '')
    if (!transcript) return
    state.xaiUserTranscriptText = transcript
    state.lastUserInterimAt = Date.now()
    state.lastUserInterimText = transcript
    recordTransportMilestone(state, 'first_interim_user_message')
    emitCallEvent(state.callControlId, {
      entry: transcriptEntry('Lead', `${transcript} ...`, 'system'),
    })
    return
  }
  if (message.type === 'conversation.item.input_audio_transcription.completed') {
    const content = normalizeTranscriptContent(
      message.transcript || state.xaiUserTranscriptText || '',
    )
    state.xaiUserTranscriptText = ''
    handleFinalUserTranscript(state, content, {
      provider: 'xai',
      providerEventId: message.item_id || message.itemId,
    })
    return
  }
  if (message.type === 'response.output_audio_transcript.delta') {
    const key = xaiTranscriptKey(message)
    const current = state.xaiAssistantTranscriptBuffers.get(key) || ''
    state.xaiAssistantTranscriptBuffers.set(
      key,
      normalizeTranscriptContent(`${current} ${message.delta || ''}`),
    )
    return
  }
  if (message.type === 'response.output_audio_transcript.done') {
    const key = xaiTranscriptKey(message)
    const content = normalizeTranscriptContent(
      message.transcript || state.xaiAssistantTranscriptBuffers.get(key) || '',
    )
    state.xaiAssistantTranscriptBuffers.delete(key)
    handleAssistantTranscript(state, content, {
      provider: 'xai',
      providerEventId: message.item_id || message.itemId || message.response_id,
    })
    return
  }
  if (message.type === 'response.output_text.delta' || message.type === 'response.text.delta') {
    const key = xaiTranscriptKey(message)
    const current = state.xaiAssistantTranscriptBuffers.get(key) || ''
    state.xaiAssistantTranscriptBuffers.set(
      key,
      normalizeTranscriptContent(`${current} ${message.delta || ''}`),
    )
    return
  }
  if (message.type === 'response.output_text.done') {
    const key = xaiTranscriptKey(message)
    const content = normalizeTranscriptContent(
      message.text || state.xaiAssistantTranscriptBuffers.get(key) || '',
    )
    state.xaiAssistantTranscriptBuffers.delete(key)
    handleAssistantTranscript(state, content, {
      provider: 'xai',
      providerEventId: message.item_id || message.itemId || message.response_id,
    })
    return
  }
  if (message.type === 'response.function_call_arguments.done') {
    queueXaiToolCall(state, message)
    return
  }
  if (message.type === 'error') {
    const detail = safeLeadText(message.error?.message || message.message || 'xAI realtime error')
    emitCallEvent(state.callControlId, {
      entry: transcriptEntry('System', `xAI realtime error: ${detail}`, 'attention'),
      notice: 'xAI error',
    })
  }
}

export function buildXaiSession(state, { includeTools = true } = {}) {
  const tools =
    includeTools &&
    state.config.xaiToolCallingEnabled !== false &&
    !isJonathanEchoMode()
      ? xaiToolDefinitions(state)
      : undefined
  return cleanObject({
    instructions: buildXaiInstructions(state),
    reasoning: {
      effort: state.config.xaiReasoningEffort === 'high' ? 'high' : 'none',
    },
    voice: xaiVoiceId(state),
    tools,
    tool_choice: tools?.length ? 'auto' : undefined,
    turn_detection:
      state.config.turnDetectionEnabled === false
        ? null
        : cleanObject({
            type: 'server_vad',
            threshold: Math.min(0.9, Math.max(0.1, Number(state.config.speechDetectionThreshold) || 0.58)),
            silence_duration_ms: Math.min(10_000, Math.max(0, Number(state.config.endOfTurnSilenceMs) || 500)),
            prefix_padding_ms: Math.min(10_000, Math.max(0, Number(state.config.prefixPaddingMs) || 300)),
            idle_timeout_ms:
              state.config.nudgesEnabled === true && Number(state.config.nudgesIntervalSeconds) > 0
                ? Math.min(60_000, Math.max(1_000, Number(state.config.nudgesIntervalSeconds) * 1_000))
                : undefined,
            create_response: callToolsFirstTurnAutoResponseEnabled(state),
            interrupt_response: state.config.interruptionEnabled !== false,
          }),
    resumption: { enabled: state.config.xaiResumptionEnabled !== false },
    audio: {
      input: {
        format: { type: 'audio/pcm', rate: Number(state.sampleRate) || 16000 },
        transport: 'json',
        transcription: cleanObject({
          model: 'grok-transcribe',
          language_hint: state.config.xaiLanguageHint || undefined,
          keyterms: Array.isArray(state.config.xaiKeyterms) && state.config.xaiKeyterms.length
            ? state.config.xaiKeyterms
            : undefined,
        }),
      },
      output: {
        format: {
          type: 'audio/pcm',
          rate: Number(state.config.xaiOutputSampleRate) || 16000,
        },
        transport: 'json',
        speed: Number(state.config.xaiVoiceSpeed) || 1,
      },
    },
  })
}

function sendXaiSessionUpdate(state, { includeTools = true } = {}) {
  if (!state.xaiWs || state.xaiWs.readyState !== WebSocket.OPEN) return
  state.xaiWs.send(
    JSON.stringify({ type: 'session.update', session: buildXaiSession(state, { includeTools }) }),
  )
}

function buildXaiInstructions(state) {
  const systemPrompt =
    temporaryAgentSystemPrompt() || buildRuntimeSystemPrompt(state.config.instructions)
  const temporaryInstruction = state.xaiTemporaryInstruction
    ? `Live operator guidance for the next response only: ${state.xaiTemporaryInstruction}`
    : ''
  return [
    systemPrompt,
    '<runtime_context>',
    buildSessionContext(state),
    '</runtime_context>',
    'Spoken delivery: sound natural, concise, warm, and direct. Do not use markdown, bullets, emojis, or meta-commentary in speech.',
    temporaryInstruction,
  ].filter(Boolean).join('\n\n')
}

function xaiToolDefinitions(state) {
  const tools = speakInworldToolDefinitions().filter((tool) => {
    if (tool.name === 'hang_up' && state.config.hangUpEnabled === false) return false
    return true
  })
  if (state.config.webSearchEnabled === true) tools.push({ type: 'web_search' })
  return tools
}

function xaiVoiceId(state) {
  return safeLeadText(
    state.config?.voice ||
      state.config?.xaiVoiceName ||
      process.env.XAI_VOICE_ID ||
      'eve',
  ).toLowerCase()
}

function xaiTranscriptKey(message = {}) {
  return String(
    message.item_id || message.itemId || message.output_index || message.response_id || 'default',
  )
}

function handleXaiAudioDelta(state, bytes) {
  if (!bytes?.length || state.takeover || state.ending) return
  if (recordSuppressedCallToolsAssistantOutput(state, 'xai', 'audio')) return
  const audible = pcm16IsAudible(bufferToInt16LE(bytes))
  state.assistantResponseActive = true
  state.audioPacketsSent += 1
  state.audioBytesSent += bytes.length
  state.lastAssistantAudioAt = Date.now()
  if (audible) {
    recordVoiceTurnLatency(
      state,
      noteFirstAssistantAudio(state, { provider: 'xai', atMs: state.lastAssistantAudioAt }),
    )
  }
  scheduleAssistantResponseIdleGuard(state, 'xai_audio')
  addTransportCounter(state, 'xaiAudioOutputs')
  addTransportCounter(state, 'xaiAudioOutputBytes', bytes.length)
  recordTransportMilestone(state, 'first_xai_audio_output')
  if (state.browserTest) {
    sendRealtimePcmAudioToBrowser(state, bytes, 'xai')
  } else if (isCallToolsGatewayCall(state)) {
    sendRealtimePcmAudioToCallToolsGateway(state, bytes, 'xai')
  } else {
    sendRealtimePcmAudioToTelnyx(state, bytes, 'xai')
  }
  if (state.audioPacketsSent === 1 && !state.browserTest) {
    sendPhonePlaybackMark(state, 'assistant-audio-start')
    emitCallEvent(state.callControlId, {
      entry: transcriptEntry('System', 'Assistant audio is streaming to the phone call.', 'system'),
      notice: 'Assistant audio streaming',
    })
  }
}

function queueXaiToolCall(state, message) {
  const callId = safeLeadText(message.call_id || message.callId)
  const name = safeLeadText(message.name)
  if (!callId || !name || state.xaiPendingToolCalls.has(callId)) return
  emitCallEvent(state.callControlId, {
    entry: transcriptEntry('Tool', `Tool requested: ${name}`, 'attention'),
    notice: `Tool requested: ${name}`,
  })
  const promise = executeSpeakToolCall(state, name, parseToolParameters(message.arguments))
    .then((value) => ({ ok: true, name, ...value }))
    .catch((error) => ({
      ok: false,
      name,
      result: {
        ok: false,
        error: error instanceof Error ? error.message : 'Tool failed',
        assistant_next_step: 'Do not claim the action succeeded. Verify details or let the operator take over.',
      },
      afterResponse: null,
    }))
  state.xaiPendingToolCalls.set(callId, promise)
}

async function flushXaiToolCalls(state) {
  if (state.xaiToolFlushInProgress || !state.xaiPendingToolCalls?.size) return
  state.xaiToolFlushInProgress = true
  const entries = [...state.xaiPendingToolCalls.entries()]
  try {
    const results = await Promise.all(entries.map(([, promise]) => promise))
    if (!state.xaiWs || state.xaiWs.readyState !== WebSocket.OPEN || state.ending) return
    results.forEach((value, index) => {
      const [callId] = entries[index]
      state.xaiWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output: JSON.stringify(value.result),
        },
      }))
      if (!value.ok) {
        emitCallEvent(state.callControlId, {
          entry: transcriptEntry('Tool', `${value.name} failed: ${value.result.error}`, 'attention'),
          notice: `${value.name} failed`,
        })
      }
    })
    await waitForXaiPlaybackDrain(state)
    if (!state.xaiWs || state.xaiWs.readyState !== WebSocket.OPEN || state.ending) return
    state.xaiWs.send(JSON.stringify({ type: 'response.create' }))
    results.forEach((value) => {
      if (value.afterResponse) setTimeout(() => void value.afterResponse(), 250)
    })
  } finally {
    entries.forEach(([callId]) => state.xaiPendingToolCalls.delete(callId))
    state.xaiToolFlushInProgress = false
  }
}

async function waitForXaiPlaybackDrain(state) {
  if (state.browserTest || isCallToolsGatewayCall(state)) {
    await new Promise((resolve) => setTimeout(resolve, 120))
    return
  }
  const deadline = Date.now() + 10_000
  while ((state.telnyxOutboundQueue?.length || state.telnyxOutboundRemainder?.length) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
}

function cancelXaiResponse(state, { clearInput = false } = {}) {
  if (!state?.xaiWs || state.xaiWs.readyState !== WebSocket.OPEN) return
  state.xaiWs.send(JSON.stringify({ type: 'response.cancel' }))
  if (clearInput) state.xaiWs.send(JSON.stringify({ type: 'input_audio_buffer.clear' }))
}

function connectInworld(state) {
  if (
    state.inworldWs &&
    [WebSocket.CONNECTING, WebSocket.OPEN].includes(state.inworldWs.readyState)
  ) {
    return
  }

  const inworldApiKey = getInworldApiKey()
  if (!inworldApiKey) {
    emitCallEvent(state.callControlId, {
      entry: transcriptEntry('System', 'Inworld API key is required for this realtime voice session.', 'attention'),
      notice: 'Inworld not configured',
    })
    return
  }

  const url = new URL(`${INWORLD_API_BASE.replace('https:', 'wss:')}/api/v1/realtime/session`)
  url.searchParams.set(
    'key',
    state.voiceProviderSessionKey || state.callControlId,
  )
  url.searchParams.set('protocol', 'realtime')

  const ws = new WebSocket(url, {
    headers: {
      Authorization: `Basic ${inworldApiKey}`,
    },
  })
  state.inworldWs = ws

  ws.on('open', () => {
    recordTransportMilestone(state, 'inworld_ws_open')
    emitCallEvent(state.callControlId, {
      diagnostic: buildTransportDiagnosticSnapshot(state),
      entry: transcriptEntry('System', 'Inworld realtime voice socket connected.', 'system'),
      notice: 'Inworld connected',
    })
  })

  ws.on('message', (raw) => {
    handleInworldMessage(state, JSON.parse(raw.toString()))
  })

  ws.on('close', (code, reason) => {
    discardVoiceInputPreReadyBuffer(state, 'inworld_session_closed')
    if (state.provisionalVoiceSession?.canceledReason) return
    if (state.calltoolsStandby) {
      callToolsVoiceStandby.cancel('provider_disconnected')
      return
    }
    const detail = [code ? `code ${code}` : '', reason?.toString() || '']
      .filter(Boolean)
      .join(', ')
    emitCallEvent(state.callControlId, {
      entry: transcriptEntry(
        'System',
        `Inworld realtime voice session disconnected${detail ? ` (${detail})` : ''}.`,
        'system',
      ),
      notice: 'Inworld disconnected',
    })
    const failedBeforeReady = failCallToolsVoiceReadiness(
      state,
      'calltools_inworld_disconnected_before_ready',
      'Inworld disconnected before voice input became ready',
    )
    if (!failedBeforeReady) {
      failCallToolsVoiceSession(
        state,
        'calltools_inworld_disconnected_after_ready',
        'Inworld disconnected after voice input became ready',
      )
    }
    if (state.personalPhoneInboundCorrelationId && !state.ending) {
      state.telnyxWs?.close(1011, 'Voice session disconnected')
    }
  })

  ws.on('error', (error) => {
    if (state.provisionalVoiceSession?.canceledReason) return
    if (state.calltoolsStandby) {
      callToolsVoiceStandby.cancel('provider_error')
      return
    }
    emitCallEvent(state.callControlId, {
      entry: transcriptEntry('System', `Inworld realtime voice error: ${error.message}`, 'attention'),
      notice: 'Inworld error',
    })
    const failedBeforeReady = failCallToolsVoiceReadiness(
      state,
      'calltools_inworld_error_before_ready',
      'Inworld failed before voice input became ready',
    )
    if (!failedBeforeReady) {
      failCallToolsVoiceSession(
        state,
        'calltools_inworld_error_after_ready',
        'Inworld failed after voice input became ready',
      )
    }
  })
}

function handleInworldMessage(state, message) {
  if (message.type === 'session.created') {
    state.chatId = message.session?.id || message.session_id || state.callControlId
    recordTransportMilestone(state, 'inworld_session_attached', {
      chatId: state.chatId,
    })
    emitCallEvent(state.callControlId, {
      patch: cleanObject({
        chatId: state.chatId,
        phase: state.browserTest || state.answered ? 'live' : undefined,
      }),
      diagnostic: buildTransportDiagnosticSnapshot(state),
      entry: transcriptEntry('System', `Inworld realtime session ${state.chatId} attached.`, 'system'),
      notice: 'Inworld session attached',
    })
    void activatePrewarmedInworldSession(state)
    return
  }

  if (message.type === 'session.updated') {
    recordTransportMilestone(state, 'inworld_session_updated')
    markVoiceInputReady(state, 'inworld')
    return
  }

  if (
    message.type === 'response.output_audio.delta' ||
    message.type === 'response.backchannel.audio.delta'
  ) {
    handleInworldAudioDelta(state, message.delta)
    return
  }

  if (message.type === 'response.created') {
    state.inworldResponseActive = true
    return
  }

  if (message.type === 'response.done') {
    clearAssistantResponseIdleGuard(state)
    state.assistantResponseActive = false
    state.inworldResponseActive = false
    if (!state.browserTest && !isCallToolsGatewayCall(state)) flushTelnyxOutboundRemainder(state)
    if (state.inworldTemporaryInstruction) {
      if (state.inworldInstructionWaitForFollowingResponse) {
        state.inworldInstructionWaitForFollowingResponse = false
      } else {
        state.inworldTemporaryInstruction = ''
        sendInworldSessionUpdate(state, { includeTools: false })
      }
    }
    void sendPendingPlaygroundUserInput(state, 'inworld_response_done').catch((error) =>
      emitPlaygroundUserInputFailure(state, error),
    )
    return
  }

  if (message.type === 'input_audio_buffer.speech_started') {
    const interruptedAssistant = Boolean(
      state.assistantResponseActive || state.inworldResponseActive,
    )
    state.inworldUserSpeechActive = true
    state.lastInterruptionAt = Date.now()
    recordTransportMilestone(state, 'first_inworld_speech_started')
    clearAssistantResponseIdleGuard(state)
    state.assistantResponseActive = false
    addTransportCounter(state, 'inworldInterruptions')
    cancelInworldResponse(state, { clearInput: false })
    clearQueuedAssistantAudio(state, 'inworld_speech_started')
    schedulePendingPlaygroundUserInput(state, 150, 'inworld_speech_started')
    emitCallEvent(state.callControlId, {
      diagnostic: buildTransportDiagnosticSnapshot(state),
      entry: transcriptEntry('System', 'Caller speech detected; Inworld assistant audio was cleared.', 'attention'),
      notice: 'Caller speech detected',
    })
    if (interruptedAssistant) {
      voiceInterruptionRecovery.arm(state, {
        provider: 'inworld',
        reason: 'speech_started_during_assistant_response',
      })
    }
    return
  }

  if (message.type === 'input_audio_buffer.speech_stopped') {
    state.inworldUserSpeechActive = false
    noteCallerSpeechStopped(state, { provider: 'inworld' })
    recordTransportMilestone(state, 'first_inworld_speech_stopped')
    return
  }

  if (message.type === 'conversation.item.input_audio_transcription.delta') {
    recordInworldVoiceProfile(state, message)
    const delta = normalizeTranscriptContent(message.delta || '')
    if (!delta) return
    state.inworldUserTranscriptText = normalizeTranscriptContent(
      `${state.inworldUserTranscriptText || ''} ${delta}`,
    )
    state.lastUserInterimAt = Date.now()
    state.lastUserInterimText = state.inworldUserTranscriptText
    recordTransportMilestone(state, 'first_interim_user_message')
    emitCallEvent(state.callControlId, {
      entry: transcriptEntry('Lead', `${state.inworldUserTranscriptText} ...`, 'system'),
    })
    return
  }

  if (message.type === 'conversation.item.input_audio_transcription.completed') {
    recordInworldVoiceProfile(state, message)
    const content = normalizeTranscriptContent(
      message.transcript || state.inworldUserTranscriptText || '',
    )
    state.inworldUserTranscriptText = ''
    handleFinalUserTranscript(state, content, {
      provider: 'inworld',
      providerEventId: message.item_id || message.itemId,
    })
    return
  }

  if (message.type === 'conversation.item.added' || message.type === 'conversation.item.done') {
    handleInworldConversationItem(state, message.item, message)
    return
  }

  if (message.type === 'response.output_audio_transcript.delta') {
    const key = inworldTranscriptKey(message)
    const current = state.inworldAssistantTranscriptBuffers.get(key) || ''
    state.inworldAssistantTranscriptBuffers.set(
      key,
      normalizeTranscriptContent(`${current} ${message.delta || ''}`),
    )
    return
  }

  if (message.type === 'response.output_audio_transcript.done') {
    const key = inworldTranscriptKey(message)
    const content = normalizeTranscriptContent(
      message.transcript || state.inworldAssistantTranscriptBuffers.get(key) || '',
    )
    state.inworldAssistantTranscriptBuffers.delete(key)
    handleAssistantTranscript(state, content, {
      providerEventId: message.item_id || message.itemId || message.response_id,
    })
    return
  }

  if (message.type === 'response.output_text.done') {
    handleAssistantTranscript(state, message.text || message.content || '', {
      providerEventId: message.item_id || message.itemId || message.response_id,
    })
    return
  }

  if (message.type === 'response.function_call_arguments.done') {
    void handleInworldToolCall(state, message)
    return
  }

  if (message.type === 'error') {
    const text = message.error?.message || message.message || 'Inworld realtime error'
    emitCallEvent(state.callControlId, {
      entry: transcriptEntry('System', `Inworld realtime error: ${text}`, 'attention'),
      notice: 'Inworld error',
    })
    if (recoverInworldToolPlanRestriction(state, text)) return
    recoverInworldModelPlanRestriction(state, text)
  }
}

async function activatePrewarmedInworldSession(state) {
  await waitForVoicePrewarmBinding(state)
  await waitForVoicePrewarmContext(state)
  if (
    state.ending ||
    state.inworldWs?.readyState !== WebSocket.OPEN ||
    isCallEnded(state)
  ) return
  sendInworldSessionUpdate(state, { includeTools: true })
  armCallToolsFirstTurnGate(state, 'inworld')
  maybeSendInitialGreetingPrompt(state)
}

function handleInworldAudioDelta(state, audioBase64) {
  if (!audioBase64 || state.takeover || state.ending) return
  if (recordSuppressedCallToolsAssistantOutput(state, 'inworld', 'audio')) return

  const bytes = Buffer.from(audioBase64, 'base64')
  const audible = pcm16IsAudible(bufferToInt16LE(bytes))
  state.assistantResponseActive = true
  state.audioPacketsSent += 1
  state.audioBytesSent += bytes.length
  state.lastAssistantAudioAt = Date.now()
  if (audible) {
    recordVoiceTurnLatency(
      state,
      noteFirstAssistantAudio(state, {
        provider: 'inworld',
        atMs: state.lastAssistantAudioAt,
      }),
    )
  }
  scheduleAssistantResponseIdleGuard(state, 'inworld_audio')
  addTransportCounter(state, 'inworldAudioOutputs')
  addTransportCounter(state, 'inworldAudioOutputBytes', bytes.length)
  recordTransportMilestone(state, 'first_inworld_audio_output')

  if (state.browserTest) {
    sendInworldAudioToBrowser(state, bytes)
  } else if (isCallToolsGatewayCall(state)) {
    sendInworldAudioToCallToolsGateway(state, bytes)
  } else {
    sendInworldAudioToTelnyx(state, bytes)
  }

  if (state.audioPacketsSent === 1 && !state.browserTest) {
    sendPhonePlaybackMark(state, 'assistant-audio-start')
    emitCallEvent(state.callControlId, {
      entry: transcriptEntry('System', 'Assistant audio is streaming to the phone call.', 'system'),
      notice: 'Assistant audio streaming',
    })
  }
}

function sendInworldSessionUpdate(state, { includeTools = true } = {}) {
  if (!state.inworldWs || state.inworldWs.readyState !== WebSocket.OPEN) return
  state.inworldWs.send(
    JSON.stringify({
      type: 'session.update',
      session: buildInworldSession(state, { includeTools }),
    }),
  )
}

export function buildInworldSession(state, { includeTools = true } = {}) {
  const outputSampleRate =
    Number(state.config.inworldOutputSampleRate) || Number(state.sampleRate) || 16000
  const turnDetectionMode = state.config.inworldTurnDetectionMode || 'semantic_vad'
  const semanticVadEagerness = state.config.inworldTurnEagerness || 'high'
  const inworldFastMode =
    isCodexAuthLanguageModel(state.config) && state.config.codexFastMode === true
  const inworldConversational =
    Boolean(state.config.inworldTtsConversationalEnabled) && !inworldFastMode
  const reasoningEffort = inworldReasoningEffort(state.config)
  const tools =
    includeTools &&
    inworldSessionToolsEnabled(state) &&
    !isJonathanEchoMode()
      ? inworldToolDefinitions(state)
      : undefined

  return cleanObject({
    type: 'realtime',
    model:
      state.config.inworldRealtimeModel ||
      state.config.languageModelResource ||
      'google-ai-studio/gemini-2.5-flash',
    instructions: buildInworldInstructions(state),
    output_modalities: ['audio', 'text'],
    temperature: state.config.languageModelTemperature,
    text_generation_config: reasoningEffort
      ? {
          reasoning: {
            effort: reasoningEffort,
          },
        }
      : undefined,
    audio: {
      input: {
        format: {
          type: 'audio/pcm',
          rate: Number(state.sampleRate) || 16000,
        },
        transcription: cleanObject({
          model: state.config.inworldSttModel || DEFAULT_INWORLD_STT_MODEL,
          language: languageRoot(state.config.inworldLanguage),
          prompt: inworldTranscriptionPrompt(state),
        }),
        turn_detection: cleanObject({
          type: turnDetectionMode,
          eagerness:
            turnDetectionMode === 'semantic_vad'
              ? semanticVadEagerness
              : undefined,
          threshold:
            turnDetectionMode === 'server_vad'
              ? state.config.speechDetectionThreshold
              : undefined,
          prefix_padding_ms:
            turnDetectionMode === 'server_vad' ? state.config.prefixPaddingMs : undefined,
          silence_duration_ms:
            turnDetectionMode === 'server_vad'
              ? state.config.endOfTurnSilenceMs
              : undefined,
          create_response: callToolsFirstTurnAutoResponseEnabled(state),
          interrupt_response: state.config.interruptionEnabled !== false,
        }),
      },
      output: {
        format: {
          type: 'audio/pcm',
          rate: outputSampleRate,
        },
        voice: inworldVoiceId(state),
        model: 'inworld-tts-2',
        speed: 1,
      },
    },
    tools,
    tool_choice: tools?.length ? 'auto' : undefined,
    providerData: cleanObject({
      stt: cleanObject({
        language_hints: state.config.inworldLanguage
          ? [state.config.inworldLanguage]
          : undefined,
        voice_profile: state.config.inworldVoiceProfileEnabled !== false,
        end_of_turn_confidence_threshold: state.config.inworldSttEndOfTurnConfidenceThreshold,
        min_end_of_turn_silence: state.config.inworldSttMinEndOfTurnSilenceMs,
        max_turn_silence: state.config.inworldSttMaxTurnSilenceMs,
        vad_threshold: state.config.inworldSttVadThreshold,
      }),
      tts: cleanObject({
        segmenter_strategy:
          inworldFastMode
            ? 'fast_start'
            : inworldConversational
              ? 'full_turn'
            : state.config.inworldTtsSegmenterStrategy || 'full_turn',
        steering_handling: state.config.inworldTtsSteeringHandling || 'emit_once',
        language: state.config.inworldLanguage || 'en-US',
        delivery_mode: state.config.inworldTtsDeliveryMode || 'CREATIVE',
        conversational: inworldConversational,
        user_turn_mode: state.config.inworldTtsUserTurnMode || 'both',
      }),
      memory: cleanObject({
        enabled: Boolean(state.config.inworldMemoryEnabled),
      }),
      backchannel: cleanObject({
        enabled: Boolean(state.config.inworldBackchannelEnabled),
      }),
      responsiveness: cleanObject({
        enabled: Boolean(state.config.inworldResponsivenessEnabled),
        initial_wait_timeout_ms:
          Number(state.config.inworldResponsivenessInitialWaitMs) || 600,
        hard_deadline_ms:
          Number(state.config.inworldResponsivenessHardDeadlineMs) || 1200,
        max_tokens: 6,
        min_filler_gap_ms: 6000,
        max_initial_per_turn: 1,
        enable_filler_on_first_assistant_reply: false,
        prompt_template:
          'Generate one brief spoken acknowledgement while the main answer is prepared. Reply with exactly one of: "Yeah.", "Okay.", "Right.", or "Mm-hm." Do not say "one moment", "just a sec", or answer the caller.',
        pause_text: '',
      }),
    }),
  })
}

function inworldReasoningEffort(config = {}) {
  if (!isCodexAuthLanguageModel(config)) {
    return config.inworldReasoningSupported === true &&
      Array.isArray(config.inworldReasoningEfforts) &&
      config.inworldReasoningEfforts.includes('none')
      ? 'NONE'
      : ''
  }
  return resolveInworldReasoningEffort({
    model: config.inworldRealtimeModel || config.languageModelResource,
    requested: config.codexReasoningEffort,
    supportedEfforts: config.inworldReasoningEfforts,
    toolsEnabled: config.inworldToolCallingEnabled !== false,
  })
}

function buildInworldInstructions(state) {
  const temporarySystemPrompt = temporaryAgentSystemPrompt()
  const systemPrompt =
    temporarySystemPrompt || buildRuntimeSystemPrompt(state.config.instructions)
  const context = buildSessionContext(state)
  const temporaryInstruction = state.inworldTemporaryInstruction
    ? `Live operator guidance for the next response only: ${state.inworldTemporaryInstruction}`
    : ''

  return [
    systemPrompt,
    inworldVoiceSteeringInstructions(state),
    '<runtime_context>',
    context,
    '</runtime_context>',
    temporaryInstruction,
  ]
    .filter(Boolean)
    .join('\n\n')
}

function inworldVoiceSteeringInstructions(state) {
  if (state.config.inworldVoiceSteeringEnabled === false) return ''
  return [
    'Inworld speech output rules:',
    'This block controls spoken delivery only. Preserve the active agent role, business instructions, tools, and call objective.',
    'Your responses are spoken through inworld-tts-2, which can render bracketed nonverbals and interpret one natural-language [speak ...] steering tag at the beginning of a turn.',
    'Speak like a real person on a live phone call: short, warm, direct, and conversational. Default to 5 to 10 spoken words; go longer only when the caller asks for detail.',
    'A short turn still has to do real conversational work. Acknowledge the caller, answer what they just asked, or move to the next role-specific step. Do not repeat standalone one-word replies such as "Great." or "Okay." after the caller has already responded or asked a question.',
    'Tiny backchannels such as "yeah", "mm-hm", "right", or "okay" are only for active listening or caller pauses; they should not replace an actual answer when the caller is waiting for one.',
    'For full answer turns, usually begin with one [speak ...] tag that describes delivery, especially on the first reply after the caller speaks or when the emotional register changes. Skip the tag only for tiny backchannels or when the previous tone clearly still fits.',
    'The tag must be English, first in the turn, free-form, specific, and not conflict with the words being spoken. Layer mood, pace, pitch, volume, and vocal manner like a voice actor direction.',
    'Match the caller emotion without changing the role: default phone tone uses [speak warmly, conversationally, with relaxed pacing and natural pitch variation], frustrated callers get [speak evenly, slower, lower volume, no defensiveness], excited callers get [speak with bright energy, faster, warmer], uncertain callers get [speak clearly, reassuringly, with a measured pace], and vulnerable callers get [speak softly, slower, with warmth].',
    'You may use one natural nonverbal tag from [laugh], [breathe], [sigh], [cough], [clear throat], or [yawn] only where a person would actually make that sound; often use none.',
    'Small spoken disfluencies such as "um", "uh", "hmm", "well", "yeah", "okay", or "so" are allowed zero to two times per turn, often none, but never use delay fillers such as "one moment", "just a sec", or "let me think".',
    'Write numbers, dates, URLs, and abbreviations in natural spoken form when they will be read aloud.',
    'Do not use markdown, bullets, emojis, or special formatting in spoken replies.',
  ].join('\n')
}

function inworldToolDefinitions(state) {
  return speakInworldToolDefinitions().filter((tool) => {
    if (tool.name === 'hang_up' && state.config.hangUpEnabled === false) return false
    return true
  })
}

function inworldTranscriptionPrompt(state) {
  const lead = normalizeLead(state.lead)
  return [
    safeLeadText(lead.name),
    safeLeadText(lead.company),
    getSpeakLinkUrl(),
  ]
    .filter(Boolean)
    .join(', ')
}

function recordInworldVoiceProfile(state, message = {}) {
  if (state.config?.inworldVoiceProfileEnabled === false) return
  const profile = message.providerData?.voiceProfile || message.providerData?.voice_profile
  const normalized = normalizeInworldVoiceProfile(profile)
  if (!normalized) return
  state.lastInworldVoiceProfile = normalized
  setTransportDiagnosticValue(state, 'inworld', 'lastVoiceProfile', normalized)
}

function normalizeInworldVoiceProfile(profile = {}) {
  if (!profile || typeof profile !== 'object') return null
  const normalized = cleanObject({
    emotion: firstVoiceProfileLabel(profile.emotion),
    vocalStyle: firstVoiceProfileLabel(profile.vocal_style || profile.vocalStyle),
    accent: firstVoiceProfileLabel(profile.accent),
    age: firstVoiceProfileLabel(profile.age),
    gender: firstVoiceProfileLabel(profile.gender),
  })
  return Object.keys(normalized).length ? normalized : null
}

function firstVoiceProfileLabel(values = []) {
  const list = Array.isArray(values) ? values : []
  const first = list.find((item) => item && typeof item === 'object' && item.label)
  if (!first) return undefined
  return cleanObject({
    label: safeLeadText(first.label).slice(0, 80),
    confidence: finiteNumber(first.confidence),
  })
}

function languageRoot(value) {
  return String(value || '').split('-')[0] || undefined
}

function inworldTranscriptKey(message = {}) {
  return String(
    message.item_id ||
      message.itemId ||
      message.output_index ||
      message.response_id ||
      'default',
  )
}

function handleInworldConversationItem(state, item = {}, message = {}) {
  if (!item || item.type !== 'message') return
  const content = inworldConversationItemText(item)
  if (!content) return
  const providerEventId = item.id || message.item_id || message.itemId || message.event_id
  if (item.role === 'user') {
    handleFinalUserTranscript(state, content, { provider: 'inworld', providerEventId })
    return
  }
  if (item.role === 'assistant') {
    handleAssistantTranscript(state, content, { provider: 'inworld', providerEventId })
  }
}

function inworldConversationItemText(item = {}) {
  const content = Array.isArray(item.content) ? item.content : []
  return normalizeTranscriptContent(
    content
      .map((part) =>
        safeLeadText(
          part?.transcript ||
            part?.text ||
            part?.content ||
            part?.input_text ||
            part?.audio_transcript ||
            '',
        ),
      )
      .filter(Boolean)
      .join(' '),
  )
}

function connectHume(state) {
  if (
    state.humeWs &&
    [WebSocket.CONNECTING, WebSocket.OPEN].includes(state.humeWs.readyState)
  ) {
    return
  }

  const url = new URL(`${HUME_API_BASE.replace('https:', 'wss:')}/evi/chat`)
  url.searchParams.set('config_id', state.config.humeConfigId)
  url.searchParams.set('api_key', getHumeApiKey())
  url.searchParams.set('allow_connection', 'true')
  url.searchParams.set('verbose_transcription', String(state.config.verboseTranscription))
  if (state.config.voice) url.searchParams.set('voice_id', state.config.voice)
  applyHumeHandshakeSessionSettings(url, {
    custom_session_id: state.callControlId,
  })

  const ws = new WebSocket(url)
  state.humeWs = ws

  ws.on('open', () => {
    recordTransportMilestone(state, 'hume_ws_open')
    void activatePrewarmedHumeSession(state, ws)
  })

  ws.on('message', (raw) => {
    handleHumeMessage(state, JSON.parse(raw.toString()))
  })

  ws.on('close', (code, reason) => {
    stopHumeInputPrimer(state, 'provider_closed')
    discardVoiceInputPreReadyBuffer(state, 'hume_session_closed')
    if (state.provisionalVoiceSession?.canceledReason) return
    if (state.calltoolsStandby) {
      callToolsVoiceStandby.cancel('provider_disconnected')
      return
    }
    const detail = [code ? `code ${code}` : '', reason?.toString() || '']
      .filter(Boolean)
      .join(', ')
    emitCallEvent(state.callControlId, {
      entry: transcriptEntry(
        'System',
        `Speak voice session disconnected${detail ? ` (${detail})` : ''}.`,
        'system',
      ),
      notice: 'Speak disconnected',
    })
    const failedBeforeReady = failCallToolsVoiceReadiness(
      state,
      'calltools_hume_disconnected_before_ready',
      'Hume disconnected before voice input became ready',
    )
    if (!failedBeforeReady && code !== 1000) {
      failCallToolsVoiceSession(
        state,
        'calltools_hume_disconnected_after_ready',
        'Hume disconnected after voice input became ready',
      )
    }
    if (
      state.personalPhoneInboundCorrelationId &&
      code !== 1000 &&
      !state.ending
    ) {
      state.telnyxWs?.close(1011, 'Voice session disconnected')
    }
    if (code === 1000 && !state.ending && !isCallEnded(state)) {
      const outcomeEvent = setCallOutcome(
        state,
        state.outcome || 'completed',
        'Speak hang_up closed the voice socket',
      )
      if (outcomeEvent) emitCallEvent(state.callControlId, outcomeEvent)
      void endCallForOutcome(state, state.outcome || 'completed')
    }
  })

  ws.on('error', (error) => {
    if (state.provisionalVoiceSession?.canceledReason) return
    if (state.calltoolsStandby) {
      callToolsVoiceStandby.cancel('provider_error')
      return
    }
    emitCallEvent(state.callControlId, {
      entry: transcriptEntry('System', `Speak voice error: ${error.message}`, 'attention'),
      notice: 'Speak error',
    })
    const failedBeforeReady = failCallToolsVoiceReadiness(
      state,
      'calltools_hume_error_before_ready',
      'Hume failed before voice input became ready',
    )
    if (!failedBeforeReady) {
      failCallToolsVoiceSession(
        state,
        'calltools_hume_error_after_ready',
        'Hume failed after voice input became ready',
      )
    }
  })
}

async function activatePrewarmedHumeSession(state, ws) {
  await waitForVoicePrewarmBinding(state)
  await waitForVoicePrewarmContext(state)
  if (
    state.ending ||
    state.humeWs !== ws ||
    ws.readyState !== WebSocket.OPEN ||
    isCallEnded(state)
  ) return
  ws.send(JSON.stringify(buildHumeSessionSettings(state, { includeAudio: true })))
  startHumeInputPrimer(state)
  armCallToolsFirstTurnGate(state, 'hume')
  markVoiceInputReady(state, 'hume')
  emitCallEvent(state.callControlId, {
    diagnostic: buildTransportDiagnosticSnapshot(state),
    entry: transcriptEntry('System', 'Speak voice session connected.', 'system'),
    notice: 'Speak connected',
  })
}

export function buildHumeSessionSettings(
  state,
  { includeAudio = false, includeTools = true } = {},
) {
  const { systemPrompt, humeSystemPrompt } = resolveHumeSessionPrompts(state)
  const codexAuthSession = isCodexAuthLanguageModel(state.config)
  const context = buildSessionContext(state)
  const providerContext = codexAuthSession
    ? buildHumeCodexPromptContext(systemPrompt, context)
    : context
  const variables = buildHumeVariables(state)

  if (codexAuthSession) {
    rememberCodexClmSessionContext(state.callControlId, {
      systemPrompt,
      context,
      variables,
      codexReasoningEffort: state.config.codexReasoningEffort,
      codexFastMode: state.config.codexFastMode,
      promptExpansionEnabled: state.config.promptExpansionEnabled,
    })
  }

  return cleanObject({
    type: 'session_settings',
    custom_session_id: state.callControlId,
    language_model_api_key: codexAuthSession
      ? process.env.CODEX_CLM_API_KEY
      : undefined,
    system_prompt: humeSystemPrompt,
    audio: includeAudio
      ? humeAudioSessionSettings(state.sampleRate)
      : undefined,
    tools:
      isBrowserTestSandbox(state) || isJonathanEchoMode() || codexAuthSession
        ? undefined
        : includeTools && !state.config.useConfigTools
          ? humeToolDefinitions()
          : undefined,
    context: {
      type: 'persistent',
      text: providerContext,
    },
    variables,
  })
}

function resolveHumeSessionPrompts(state) {
  const temporarySystemPrompt = temporaryAgentSystemPrompt()
  const systemPrompt =
    temporarySystemPrompt || buildRuntimeSystemPrompt(state.config.instructions)
  const humeSystemPrompt =
    shouldSendHumeSessionSystemPrompt(state.config, {
      hasTemporarySystemPrompt: Boolean(temporarySystemPrompt),
    })
      ? systemPrompt
      : undefined

  return { systemPrompt, humeSystemPrompt }
}

function buildHumeVariables(state) {
  const lead = normalizeLead(state.lead)
  if (isJonathanEchoMode()) {
    return {
      first_name: 'Jonathan',
      last_name: '',
      full_name: 'Jonathan',
      business_name: safeLeadText(lead.company),
      contact_phone: normalizePhone(lead.phone) || '',
      contact_email: cleanEmail(lead.email),
      portal_url: getSpeakLinkUrl(),
    }
  }

  if (isBrowserTestSandbox(state)) {
    const contact = normalizeConfigurationTestVariables(state.testVariables)
    const keys = configurationTestVariableKeySet(state)
    return cleanObject({
      first_name: keys.has('first_name') ? safeLeadText(contact.firstName) : undefined,
      last_name: keys.has('last_name') ? safeLeadText(contact.lastName) : undefined,
      full_name: keys.has('full_name') ? safeLeadText(contact.name) : undefined,
      business_name: keys.has('business_name')
        ? safeLeadText(contact.company)
        : undefined,
      contact_phone: keys.has('contact_phone') ? contact.phone : undefined,
      contact_email: keys.has('contact_email') ? contact.email : undefined,
      portal_url: keys.has('portal_url')
        ? contact.portalUrl || getSpeakLinkUrl()
        : undefined,
    })
  }

  return {
    first_name: safeLeadText(lead.firstName),
    last_name: safeLeadText(lead.lastName),
    full_name: safeLeadText(lead.name),
    business_name: safeLeadText(lead.company),
    contact_phone: normalizePhone(lead.phone) || '',
    contact_email: cleanEmail(lead.email),
    portal_url: getSpeakLinkUrl(),
  }
}

function humeToolDefinitions() {
  return speakSessionToolDefinitions()
}

function isBrowserTestSandbox(state) {
  return Boolean(state?.browserTest && !state.productionContext)
}

function handleHumeMessage(state, message) {
  if (message.type === 'chat_metadata') {
    state.chatId = message.chat_id
    recordTransportMilestone(state, 'hume_chat_attached', {
      chatId: state.chatId,
    })
    emitCallEvent(state.callControlId, {
      patch: cleanObject({
        chatId: state.chatId,
        phase: state.browserTest || state.answered ? 'live' : undefined,
      }),
      diagnostic: buildTransportDiagnosticSnapshot(state),
      entry: transcriptEntry('System', `Speak session ${message.chat_id} attached.`, 'system'),
      notice: 'Speak session attached',
    })
    maybeSendInitialGreetingPrompt(state)
    return
  }

  if (message.type === 'audio_output' && message.data) {
    if (recordSuppressedCallToolsAssistantOutput(state, 'hume', 'audio')) return
    if (!state.takeover && !state.ending) {
      const humeAudio = Buffer.from(message.data, 'base64')
      const audible = pcm16IsAudible(
        decodeWavPcm16(humeAudio, state.sampleRate).samples,
      )
      state.assistantResponseActive = true
      state.audioPacketsSent += 1
      state.audioBytesSent += humeAudio.length
      state.lastAssistantAudioAt = Date.now()
      if (audible) {
        recordVoiceTurnLatency(
          state,
          noteFirstAssistantAudio(state, {
            provider: 'hume',
            atMs: state.lastAssistantAudioAt,
          }),
        )
      }
      scheduleAssistantResponseIdleGuard(state, 'assistant_audio')
      addTransportCounter(state, 'humeAudioOutputs')
      addTransportCounter(
        state,
        'humeAudioOutputBytes',
        humeAudio.length,
      )
      recordTransportMilestone(state, 'first_hume_audio_output')
      if (state.browserTest) {
        sendHumeAudioToBrowser(state, message.data)
      } else if (isCallToolsGatewayCall(state)) {
        sendHumeAudioToCallToolsGateway(state, message.data)
      } else {
        sendHumeAudioToTelnyx(state, message.data)
      }
      if (state.audioPacketsSent === 1 && !state.browserTest) {
        sendPhonePlaybackMark(state, 'assistant-audio-start')
        emitCallEvent(state.callControlId, {
          entry: transcriptEntry('System', 'Assistant audio is streaming to the phone call.', 'system'),
          notice: 'Assistant audio streaming',
        })
      }
    }
    return
  }

  if (message.type === 'assistant_end') {
    clearAssistantResponseIdleGuard(state)
    state.assistantResponseActive = false
    if (!state.browserTest && !isCallToolsGatewayCall(state)) flushTelnyxOutboundRemainder(state)
    void sendPendingPlaygroundUserInput(state, 'assistant_end').catch((error) =>
      emitPlaygroundUserInputFailure(state, error),
    )
    return
  }

  if (message.type === 'user_interruption') {
    state.lastInterruptionAt = Date.now()
    clearAssistantResponseIdleGuard(state)
    state.assistantResponseActive = false
    addTransportCounter(state, 'humeInterruptions')
    clearQueuedAssistantAudio(state, 'user_interruption')
    schedulePendingPlaygroundUserInput(state, 150, 'user_interruption')
    emitCallEvent(state.callControlId, {
      diagnostic: buildTransportDiagnosticSnapshot(state),
      entry: transcriptEntry('System', 'Lead interrupted the assistant.', 'attention'),
      notice: 'Lead interruption detected',
    })
    voiceInterruptionRecovery.arm(state, {
      provider: 'hume',
      reason: 'user_interruption',
    })
    return
  }

  if (message.type === 'user_message') {
    const content = normalizeTranscriptContent(message.message?.content || '')
    if (!content.trim()) return
    clearQueuedAssistantAudio(state, 'hume_user_message')
    if (consumeSyntheticUserInput(state, content)) return
    addTransportCounter(state, 'humeUserMessages')
    if (message.interim) {
      state.lastUserInterimAt = Date.now()
      state.lastUserInterimText = content
      addTransportCounter(state, 'humeInterimUserMessages')
      recordTransportMilestone(state, 'first_interim_user_message')
    } else {
      state.lastUserFinalAt = Date.now()
      noteFinalUserTurn(state, {
        provider: 'hume',
        atMs: state.lastUserFinalAt,
        configuredTurnSilenceMs: state.config.endOfTurnSilenceMs,
      })
      state.lastUserInterimText = ''
      voiceInterruptionRecovery.noteFinalCallerTurn(state)
      recordTransportMilestone(state, 'first_user_message')
    }
    if (!message.interim) {
      state.leadUtteranceCount += 1
      applyCallToolsFirstTurnTranscript(state, content, 'hume')
      const outcome = inferTranscriptOutcome(content)
      if (outcome) {
        const outcomeEvent = setCallOutcome(state, outcome)
        if (outcomeEvent) emitCallEvent(state.callControlId, outcomeEvent)
        if (shouldEndImmediately(outcome)) {
          void endCallForOutcome(state, outcome)
        }
      }
    }
    emitCallEvent(state.callControlId, {
      entry: transcriptEntry(
        'Lead',
        message.interim ? `${content} ...` : content,
        message.interim ? 'system' : 'neutral',
        {
          emotionScores: extractHumeEmotionScores(message),
          providerEventId: humeMessageEventId(message),
        },
      ),
    })
    return
  }

  if (message.type === 'assistant_message') {
    const content = normalizeTranscriptContent(message.message?.content || '')
    if (!content.trim()) return
    if (recordSuppressedCallToolsAssistantOutput(state, 'hume', 'transcript')) return
    state.assistantResponseActive = true
    state.lastAssistantMessageAt = Date.now()
    voiceInterruptionRecovery.noteAssistantActivity(state)
    scheduleAssistantResponseIdleGuard(state, 'assistant_message')
    const providerEventId = humeMessageEventId(message)
    const pendingScores = providerEventId
      ? state.pendingAssistantProsodyScores.get(providerEventId)
      : null
    if (providerEventId) state.pendingAssistantProsodyScores.delete(providerEventId)
    state.assistantUtteranceCount += 1
    recordTransportMilestone(state, 'first_assistant_message')
    scheduleAssistantAudioWatchdog(
      state,
      state.assistantUtteranceCount,
    )
    emitCallEvent(state.callControlId, {
      entry: transcriptEntry('AI', content, 'neutral', {
        emotionScores: extractHumeEmotionScores(message) || pendingScores,
        providerEventId,
      }),
    })
    return
  }

  if (message.type === 'assistant_prosody') {
    const emotionScores = extractHumeEmotionScores(message)
    const relatedEventId = humeRelatedEventId(message)
    if (!emotionScores || !relatedEventId) return

    const matchingEvent = [...state.eventLog]
      .reverse()
      .find((event) => event?.entry?.providerEventId === relatedEventId)

    if (matchingEvent?.entry) {
      emitCallEvent(state.callControlId, {
        entry: {
          ...matchingEvent.entry,
          emotionScores,
        },
      })
      return
    }

    state.pendingAssistantProsodyScores.set(relatedEventId, emotionScores)
    return
  }

  if (message.type === 'tool_call') {
    void handleHumeToolCall(state, message)
    return
  }

  if (message.type === 'error') {
    emitCallEvent(state.callControlId, {
      entry: transcriptEntry('System', `Speak voice error: ${message.message}`, 'attention'),
      notice: 'Speak error',
    })
  }
}

function recordVoiceTurnLatency(state, timing) {
  if (!state || !timing) return

  const section = timing.provider
  const providerDiagnostics = state.transportDiagnostics?.[section] || {}
  const finalSamples = Array.isArray(providerDiagnostics.responseLatencySamplesMs)
    ? providerDiagnostics.responseLatencySamplesMs
    : []
  const callerStopSamples = Array.isArray(providerDiagnostics.callerStopLatencySamplesMs)
    ? providerDiagnostics.callerStopLatencySamplesMs
    : []

  const finalUserToAssistantAudioMs = Number(timing.finalUserToAssistantAudioMs)
  if (Number.isFinite(finalUserToAssistantAudioMs)) {
    setTransportDiagnosticValue(
      state,
      section,
      'lastFinalUserToAssistantAudioMs',
      finalUserToAssistantAudioMs,
    )
    setTransportDiagnosticValue(
      state,
      section,
      'responseLatencySamplesMs',
      [...finalSamples, finalUserToAssistantAudioMs].slice(-12),
    )
  }

  if (Number.isFinite(timing.audibleCallerStopToAssistantAudioMs)) {
    const voiceDiagnostics = state.transportDiagnostics?.voice || {}
    const audibleSamples = Array.isArray(voiceDiagnostics.audibleResponseLatencySamplesMs)
      ? voiceDiagnostics.audibleResponseLatencySamplesMs
      : []
    setTransportDiagnosticValue(
      state,
      section,
      'lastAudibleCallerStopToAssistantAudioMs',
      timing.audibleCallerStopToAssistantAudioMs,
    )
    setTransportDiagnosticValue(
      state,
      'voice',
      'lastAudibleCallerStopToAssistantAudioMs',
      timing.audibleCallerStopToAssistantAudioMs,
    )
    setTransportDiagnosticValue(
      state,
      'voice',
      'audibleCallerStopSource',
      timing.audibleCallerStopSource,
    )
    setTransportDiagnosticValue(
      state,
      'voice',
      'audibleResponseLatencySamplesMs',
      [...audibleSamples, timing.audibleCallerStopToAssistantAudioMs].slice(-12),
    )
    if (
      !Object.hasOwn(
        state.transportDiagnostics?.voice || {},
        'firstAudibleCallerStopToAssistantAudioMs',
      )
    ) {
      setTransportDiagnosticValue(
        state,
        'voice',
        'firstAudibleCallerStopToAssistantAudioMs',
        timing.audibleCallerStopToAssistantAudioMs,
      )
    }
  }

  if (Number.isFinite(timing.callerStopToAssistantAudioMs)) {
    setTransportDiagnosticValue(
      state,
      section,
      'lastCallerStopToAssistantAudioMs',
      timing.callerStopToAssistantAudioMs,
    )
    setTransportDiagnosticValue(
      state,
      section,
      'callerStopSource',
      timing.callerStopSource,
    )
    setTransportDiagnosticValue(
      state,
      section,
      'callerStopLatencySamplesMs',
      [...callerStopSamples, timing.callerStopToAssistantAudioMs].slice(-12),
    )
    setTransportDiagnosticValue(
      state,
      'voice',
      'lastCallerStopToAssistantAudioMs',
      timing.callerStopToAssistantAudioMs,
    )
    setTransportDiagnosticValue(
      state,
      'voice',
      'lastCallerStopSource',
      timing.callerStopSource,
    )
    if (
      !Object.hasOwn(
        state.transportDiagnostics?.voice || {},
        'firstCallerStopToAssistantAudioMs',
      )
    ) {
      setTransportDiagnosticValue(
        state,
        'voice',
        'firstCallerStopToAssistantAudioMs',
        timing.callerStopToAssistantAudioMs,
      )
      setTransportDiagnosticValue(
        state,
        'voice',
        'firstCallerStopSource',
        timing.callerStopSource,
      )
    }
  }

  if (section === 'hume') {
    setTransportDiagnosticValue(
      state,
      'hume',
      'configuredTurnSilenceMs',
      timing.configuredTurnSilenceMs,
    )
    setTransportDiagnosticValue(
      state,
      'hume',
      'estimatedLastCallerStopToAssistantAudioMs',
      timing.callerStopToAssistantAudioMs,
    )
  } else if (section === 'inworld') {
    setTransportDiagnosticValue(
      state,
      'inworld',
      'lastSpeechStoppedToAssistantAudioMs',
      timing.callerStopToAssistantAudioMs,
    )
  } else if (section === 'xai') {
    setTransportDiagnosticValue(
      state,
      'xai',
      'lastSpeechStoppedToAssistantAudioMs',
      timing.callerStopToAssistantAudioMs,
    )
  }

  recordTransportMilestone(
    state,
    `first_${section}_caller_stop_to_assistant_audio`,
    {
      callerStopToAssistantAudioMs: timing.callerStopToAssistantAudioMs,
      finalUserToAssistantAudioMs: timing.finalUserToAssistantAudioMs,
      callerStopSource: timing.callerStopSource,
    },
  )
}

function humeMessageEventId(message = {}) {
  return String(
    message.id ||
      message.message?.id ||
      message.event_id ||
      message.eventId ||
      '',
  ).trim()
}

function humeRelatedEventId(message = {}) {
  return String(
    message.related_event_id ||
      message.relatedEventId ||
      message.message?.related_event_id ||
      message.message?.relatedEventId ||
      '',
  ).trim()
}

function handleFinalUserTranscript(
  state,
  content,
  { provider = 'inworld', providerEventId = '' } = {},
) {
  const normalized = normalizeTranscriptContent(content)
  if (!normalized) return
  if (!shouldEmitFinalUserTranscript(state, normalized, { providerEventId })) return

  state.lastUserFinalAt = Date.now()
  voiceInterruptionRecovery.noteFinalCallerTurn(state)
  noteFinalUserTurn(state, {
    provider,
    atMs: state.lastUserFinalAt,
  })
  state.lastUserInterimText = ''
  state.leadUtteranceCount += 1
  addTransportCounter(state, `${provider}UserMessages`)
  recordTransportMilestone(state, 'first_user_message')

  applyCallToolsFirstTurnTranscript(state, normalized, provider)

  const outcome = inferTranscriptOutcome(normalized)
  if (outcome) {
    const outcomeEvent = setCallOutcome(state, outcome)
    if (outcomeEvent) emitCallEvent(state.callControlId, outcomeEvent)
    if (shouldEndImmediately(outcome)) {
      void endCallForOutcome(state, outcome)
    }
  }

  emitCallEvent(state.callControlId, {
    entry: transcriptEntry('Lead', normalized, 'neutral', {
      providerEventId,
    }),
  })
}

function handleAssistantTranscript(
  state,
  content,
  { provider = 'inworld', providerEventId = '' } = {},
) {
  const normalized = normalizeTranscriptContent(
    provider === 'inworld' ? stripInworldVoiceDirectives(content) : content,
  )
  if (!normalized) return
  if (recordSuppressedCallToolsAssistantOutput(state, provider, 'transcript')) return

  const idKey = `${provider}AssistantTranscriptIds`
  state[idKey] ||= new Set()
  const dedupeKey = providerEventId || normalized
  if (state[idKey].has(dedupeKey)) return
  state[idKey].add(dedupeKey)
  if (state[idKey].size > 40) {
    state[idKey] = new Set(
      [...state[idKey]].slice(-20),
    )
  }

  state.assistantResponseActive = true
  state.lastAssistantMessageAt = Date.now()
  voiceInterruptionRecovery.noteAssistantActivity(state)
  scheduleAssistantResponseIdleGuard(state, `${provider}_assistant_message`)
  state.assistantUtteranceCount += 1
  recordTransportMilestone(state, 'first_assistant_message')
  scheduleAssistantAudioWatchdog(
    state,
    state.assistantUtteranceCount,
  )
  emitCallEvent(state.callControlId, {
    entry: transcriptEntry('AI', normalized, 'neutral', {
      providerEventId,
    }),
  })
}

function stripInworldVoiceDirectives(value) {
  return String(value || '')
    .replace(/\[(?:speak|say|sound|very|quietly|slow|fast|articulate|whisper|give|overwhelmed|clear throat|laugh|breathe|sigh|cough|yawn)[^\]]*]/gi, ' ')
    .replace(/([.!?])(?=[A-Z])/g, '$1 ')
    .replace(/\s+/g, ' ')
    .trim()
}

export async function handleHumeToolCall(state, message) {
  const name = String(message.name || '').trim()
  const args = parseToolParameters(message.parameters)

  emitCallEvent(state.callControlId, {
    entry: transcriptEntry('Tool', `Tool requested: ${name}`, 'attention'),
    notice: `Tool requested: ${name}`,
  })

  try {
    const { result, afterResponse } = await executeSpeakToolCall(state, name, args)
    sendHumeToolResponse(state, message, result)
    if (afterResponse) {
      setTimeout(() => {
        void afterResponse()
      }, 250)
    }
  } catch (error) {
    const messageText = error instanceof Error ? error.message : 'Tool failed'
    sendHumeToolError(state, message, messageText)
    emitCallEvent(state.callControlId, {
      entry: transcriptEntry('Tool', `${name} failed: ${messageText}`, 'attention'),
      notice: `${name} failed`,
    })
  }
}

export async function handleInworldToolCall(state, message) {
  const name = String(message.name || '').trim()
  const args = parseToolParameters(message.arguments)

  emitCallEvent(state.callControlId, {
    entry: transcriptEntry('Tool', `Tool requested: ${name}`, 'attention'),
    notice: `Tool requested: ${name}`,
  })

  try {
    const { result, afterResponse } = await executeSpeakToolCall(state, name, args)
    sendInworldToolResponse(state, message.call_id || message.callId, result)
    if (afterResponse) {
      setTimeout(() => {
        void afterResponse()
      }, 250)
    }
  } catch (error) {
    const messageText = error instanceof Error ? error.message : 'Tool failed'
    sendInworldToolError(state, message.call_id || message.callId, messageText)
    emitCallEvent(state.callControlId, {
      entry: transcriptEntry('Tool', `${name} failed: ${messageText}`, 'attention'),
      notice: `${name} failed`,
    })
  }
}

export async function executeSpeakToolCall(state, name, args) {
  const sandboxDeliveryBlock = blockSandboxedPlaygroundDelivery(state, name)
  if (sandboxDeliveryBlock) {
    return { result: sandboxDeliveryBlock, afterResponse: null }
  }

  let result
  let afterResponse = null
  if (name === 'send_text_message') {
    result = await handleSendTextMessageTool(state, args)
  } else if (name === 'send_email') {
    result = await handleSendEmailTool(state, args)
  } else if (name === 'send_portal_link') {
    result = await handleSendPortalLinkTool(state, args)
  } else if (name === 'update_contact' || name === 'update_lead_contact') {
    result = await handleUpdateContactTool(state, args)
    refreshVoiceLeadContext(state)
  } else if (name === 'update_caller_identity') {
    result = handleUpdateCallerIdentityTool(state, args)
    refreshVoiceLeadContext(state)
  } else if (name === 'get_contact_context') {
    const conversationMemory = buildContactConversationMemory(state, { limit: 5 })
    result = {
      ok: true,
      contact: publicLeadContext(state),
      context: buildContextToolPayload({
        leadContext: state.lead?.context,
        profileContext: state.config?.profileContext,
        legacyNotes: state.lead?.notes,
      }),
      conversation_memory: conversationMemory,
      latest_delivery: state.latestBackgroundDelivery || null,
      messaging_rule:
        'Only send text messages or email after the recipient confirms the exact destination. Only say a message was sent after the tool returns provider proof.',
    }
  } else if (name === 'get_lead_context') {
    const conversationMemory = buildContactConversationMemory(state, { limit: 5 })
    result = {
      ok: true,
      lead: publicLeadContext(state),
      context: buildContextToolPayload({
        leadContext: state.lead?.context,
        profileContext: state.config?.profileContext,
        legacyNotes: state.lead?.notes,
      }),
      conversation_memory: conversationMemory,
      latest_delivery: state.latestBackgroundDelivery || null,
      portal_url: getSpeakLinkUrl(),
      delivery_rule:
        'Verify the exact phone or email with the contact before sending. Only say delivery succeeded after the send tool returns provider proof.',
    }
  } else if (name === 'hang_up' || name === 'hangup' || name === 'end_call') {
    if (shouldDeferToolHangup(state)) {
      result = {
        ok: false,
        ended: false,
        action: 'hang_up',
        reason: 'caller_speaking',
        message:
          'The caller is speaking. Continue listening and request hang_up again only after the caller finishes.',
      }
      return { result, afterResponse }
    }
    const requestedOutcome = resolveToolHangupOutcome(state, args)
    const outcomeEvent = setCallOutcome(
      state,
      requestedOutcome,
      'Speak hang_up requested',
    )
    if (outcomeEvent) emitCallEvent(state.callControlId, outcomeEvent)
    result = {
      ok: true,
      action: 'hang_up',
      outcome: state.outcome || requestedOutcome,
      message:
        'Ending the phone call after the 10-second phone minimum duration is met.',
    }
    afterResponse = () => endCallForOutcome(state, state.outcome || requestedOutcome)
  } else {
    throw new Error(`Unsupported tool: ${name}`)
  }

  return { result, afterResponse }
}

async function handleSendPortalLinkTool(state, args) {
  const method = normalizeDeliveryMethod(args.delivery_method)
  const needsSms = method === 'sms' || method === 'both'
  const needsEmail = method === 'email' || method === 'both'

  if (!needsSms && !needsEmail) {
    return {
      ok: false,
      sent: false,
      reason: 'invalid_delivery_method',
      assistant_next_step: 'Ask whether the contact wants the link by text, email, or both.',
    }
  }

  const legacySingleChannelConfirmation = truthy(args.destination_confirmed)
  const phoneConfirmed =
    truthy(args.phone_confirmed) ||
    (method === 'sms' && legacySingleChannelConfirmation)
  const emailConfirmed =
    truthy(args.email_confirmed) ||
    (method === 'email' && legacySingleChannelConfirmation)
  const unconfirmedChannels = [
    needsSms && !phoneConfirmed ? 'sms' : '',
    needsEmail && !emailConfirmed ? 'email' : '',
  ].filter(Boolean)

  if (unconfirmedChannels.length > 0) {
    return {
      ok: false,
      sent: false,
      reason: 'destination_not_confirmed',
      unconfirmed_channels: unconfirmedChannels,
      assistant_next_step:
        'Ask the contact to say each destination, repeat each one back, and confirm it before sending.',
    }
  }

  const phone = needsSms ? normalizePhone(args.phone_number || args.phone || '') : ''
  const email = needsEmail ? cleanEmail(args.email || args.email_address || '') : ''
  const validationErrors = []

  if (needsSms && !phone) validationErrors.push('A valid confirmed SMS phone number is required.')
  if (needsEmail && !email) validationErrors.push('A valid confirmed email address is required.')

  if (validationErrors.length > 0) {
    return {
      ok: false,
      sent: false,
      reason: 'invalid_destination',
      errors: validationErrors,
      assistant_next_step:
        'Get the missing or corrected destination from the contact and confirm it before sending.',
    }
  }

  let smsBody = ''
  let emailBody = ''
  try {
    if (needsSms) smsBody = buildPortalSmsBody()
    if (needsEmail) emailBody = buildPortalEmailBody(state)
  } catch (error) {
    const messageText = error instanceof Error ? error.message : 'Portal delivery is not configured'
    const proof = {
      sms: null,
      email: null,
      failures: [{ channel: needsSms ? 'sms' : 'email', error: messageText }],
    }
    emitCallEvent(state.callControlId, {
      entry: transcriptEntry(
        'Tool',
        'Portal link delivery failed before any provider accepted it.',
        'attention',
      ),
      notice: 'Portal delivery failed',
      communication: {
        channel: needsSms && !needsEmail ? 'sms' : needsEmail && !needsSms ? 'email' : 'tool',
        modality: 'tool',
        direction: 'internal',
        role: 'tool',
        body: 'Portal link delivery failed before any provider accepted it.',
        provider: 'speak',
        proof,
      },
    })
    return {
      ok: false,
      sent: false,
      delivery_method: method,
      proof,
      assistant_next_step:
        'Tell the contact delivery did not go through. Do not claim the link was sent.',
    }
  }

  const requests = []
  if (needsSms) {
    const queuedSms = await queueVoiceBackgroundDelivery(state, {
      channel: 'sms',
      provider: 'telnyx',
      destination: maskPhone(phone),
      dedupeDestination: phone,
      dedupeContent: smsBody,
      payload: {
        phone,
        message: smsBody,
        label: 'Portal link',
      },
    })
    requests.push(queuedSms.result)
  }
  if (needsEmail) {
    const queuedEmail = await queueVoiceBackgroundDelivery(state, {
      channel: 'email',
      provider: 'google_workspace',
      destination: maskEmail(email),
      dedupeDestination: email,
      dedupeContent: `Your requested link\n${emailBody}`,
      payload: {
        email,
        subject: 'Your requested link',
        body: emailBody,
        label: 'Portal link',
      },
    })
    requests.push(queuedEmail.result)
  }

  if (requests.some((request) => request.queued !== false && !request.deduplicated)) {
    emitCallEvent(state.callControlId, {
      entry: transcriptEntry(
        'Tool',
        `Portal link delivery started in the background by ${method}.`,
        'neutral',
      ),
      notice: 'Portal delivery processing',
    })
  }

  const pending = requests.some((request) => request.pending !== false)
  const sent = !pending && requests.every((request) => request.sent === true)
  const acceptedUnverified = requests.some(
    (request) => request.provider_accepted && !request.sent,
  )
  return {
    ok: requests.every((request) => request.ok !== false),
    queued: pending,
    pending,
    sent,
    status: pending
      ? 'processing'
      : sent
        ? 'accepted'
        : acceptedUnverified
          ? 'accepted_unverified'
          : 'failed',
    deduplicated: requests.every((request) => request.deduplicated === true),
    delivery_method: method,
    portal_url: getSpeakLinkUrl(),
    requests,
    assistant_next_step: sent
      ? 'Provider acceptance proof already exists for this identical request. You may say it was sent.'
      : pending
        ? 'Tell the contact the requested delivery is processing and continue the conversation. Do not say it was sent until Speak supplies provider proof.'
        : acceptedUnverified
          ? 'The provider may have accepted the delivery, but Speak does not have retained proof. Do not say it was sent and do not retry automatically; let the operator verify the provider record.'
          : 'The requested delivery was not started or accepted. Do not say it was sent; verify readiness before retrying.',
  }
}

async function handleSendTextMessageTool(state, args) {
  if (!truthy(args.destination_confirmed)) {
    return {
      ok: false,
      sent: false,
      reason: 'destination_not_confirmed',
      assistant_next_step:
        'Ask the recipient to confirm the exact phone number before sending a text message.',
    }
  }

  const phone = normalizePhone(args.phone_number || args.phone || args.to || '')
  const message = String(args.message || args.text || args.body || '').trim()

  if (!phone) {
    return {
      ok: false,
      sent: false,
      reason: 'invalid_phone',
      assistant_next_step: 'Ask the recipient to repeat the phone number with area code.',
    }
  }

  if (!message) {
    return {
      ok: false,
      sent: false,
      reason: 'missing_message',
      assistant_next_step:
        'Prepare the exact text message body from the active agent instructions before sending.',
    }
  }

  const queued = await queueVoiceBackgroundDelivery(state, {
    channel: 'sms',
    provider: 'telnyx',
    destination: maskPhone(phone),
    dedupeDestination: phone,
    dedupeContent: message,
    payload: {
      phone,
      message,
      label: 'Text message',
    },
  })
  if (queued.result.queued !== false && !queued.deduplicated) {
    emitCallEvent(state.callControlId, {
      entry: transcriptEntry(
        'Tool',
        `Text message delivery started in the background for ${maskPhone(phone)}.`,
        'neutral',
      ),
      notice: 'Text message processing',
    })
  }
  return queued.result
}

async function handleSendEmailTool(state, args) {
  if (!truthy(args.destination_confirmed)) {
    return {
      ok: false,
      sent: false,
      reason: 'destination_not_confirmed',
      assistant_next_step:
        'Ask the recipient to confirm the exact email address before sending email.',
    }
  }

  const email = cleanEmail(args.email || args.email_address || args.to || '')
  const subject = String(args.subject || '').trim()
  const body = String(args.body || args.message || '').trim()

  if (!email) {
    return {
      ok: false,
      sent: false,
      reason: 'invalid_email',
      assistant_next_step: 'Ask the recipient to spell the email address again.',
    }
  }

  if (!subject || !body) {
    return {
      ok: false,
      sent: false,
      reason: 'missing_email_content',
      assistant_next_step:
        'Prepare both the subject and body from the active agent instructions before sending.',
    }
  }

  const queued = await queueVoiceBackgroundDelivery(state, {
    channel: 'email',
    provider: 'google_workspace',
    destination: maskEmail(email),
    dedupeDestination: email,
    dedupeContent: `${subject}\n${body}`,
    payload: {
      email,
      subject,
      body,
      label: 'Email',
    },
  })
  if (queued.result.queued !== false && !queued.deduplicated) {
    emitCallEvent(state.callControlId, {
      entry: transcriptEntry(
        'Tool',
        `Email delivery started in the background for ${maskEmail(email)}.`,
        'neutral',
      ),
      notice: 'Email processing',
    })
  }
  return queued.result
}

async function settleSmsBackgroundDelivery(state, outcome, { phone, message, label }) {
  let finalization = null
  if (outcome.ok) {
    finalization = await waitForTelnyxSmsFinalization(outcome.providerResult || {})
    if (!finalization.sent) {
      outcome = {
        ...outcome,
        ok: false,
        sent: false,
        status: finalization.status,
        provider_accepted: finalization.provider_accepted,
        provider_status: finalization.provider_status,
        delivery_finalized: finalization.delivery_finalized,
        message_id: finalization.message_id,
        error_code: finalization.error_code,
        errors: finalization.errors,
        error: finalization.error,
        reason: finalization.reason,
        providerResult: undefined,
      }
    }
  }

  if (outcome.ok) {
    const sms = outcome.providerResult || {}
    const contactUpdate = await persistBackgroundDeliveryContact(state, { phone })
    const proof = {
      provider: 'telnyx',
      to: maskPhone(phone),
      from: getTelnyxSmsFrom(),
      message_id:
        finalization?.message_id || sms.id || sms.message_id || sms.messageId || '',
      status: finalization?.provider_status || 'delivered',
      provider_status: finalization?.provider_status || 'delivered',
      delivery_finalized: true,
      request_id: outcome.request_id,
      contact_update: contactUpdate,
    }
    const eventText =
      label === 'Portal link'
        ? `Portal link sent by text to ${maskPhone(phone)}.`
        : `Text message sent to ${maskPhone(phone)}.`
    emitCallEvent(state.callControlId, {
      entry: transcriptEntry('Tool', eventText, 'positive'),
      notice: label === 'Portal link' ? 'Portal link sent' : 'Text message sent',
      communication: {
        channel: 'sms',
        modality: 'text',
        direction: 'outbound',
        role: 'agent',
        body: message,
        provider: 'telnyx',
        identity: {
          phone,
        },
        providerIds: cleanObject({
          messageId: proof.message_id,
          fromPhone: getTelnyxSmsFrom(),
          toPhone: phone,
        }),
        providerLinks: proof.message_id
          ? [{ provider: 'telnyx', kind: 'message', id: proof.message_id }]
          : [],
        proof,
      },
    })
    outcome = {
      ...outcome,
      providerResult: undefined,
      pending: false,
      sent: true,
      proof,
      assistant_next_step:
        'Final Telnyx delivery proof is available. You may say the text message was delivered to the confirmed phone number.',
    }
  } else if (
    outcome.status === 'accepted_unverified' ||
    (outcome.provider_accepted && !outcome.delivery_finalized)
  ) {
    const messageText =
      outcome.error ||
      'Speak restarted during provider dispatch, so the text-message outcome is unverified.'
    const proof = {
      provider_accepted: true,
      outcome_unverified: true,
      delivery_finalized: false,
      provider_status: outcome.provider_status,
      message_id: outcome.message_id,
      error: messageText,
      to: maskPhone(phone),
      request_id: outcome.request_id,
    }
    emitCallEvent(state.callControlId, {
      entry: transcriptEntry(
        'Tool',
        `${label} provider outcome requires operator verification.`,
        'attention',
      ),
      notice: label === 'Portal link' ? 'Portal delivery unverified' : 'Text message unverified',
      communication: {
        channel: 'sms',
        modality: 'text',
        direction: 'outbound',
        role: 'tool',
        body: `${label} provider outcome requires operator verification.`,
        provider: 'telnyx',
        identity: { phone },
        providerIds: cleanObject({
          messageId: outcome.message_id,
          fromPhone: getTelnyxSmsFrom(),
          toPhone: phone,
        }),
        providerLinks: outcome.message_id
          ? [{ provider: 'telnyx', kind: 'message', id: outcome.message_id }]
          : [],
        proof,
      },
    })
    outcome = {
      ...outcome,
      ok: false,
      status: 'accepted_unverified',
      provider_accepted: true,
      pending: false,
      sent: false,
      providerResult: undefined,
      proof,
      assistant_next_step:
        'Do not say the text was sent and do not retry automatically. Let the operator verify the Telnyx provider record.',
    }
  } else {
    const messageText = outcome.error || 'Text message send failed'
    const proof = {
      provider_accepted: Boolean(outcome.provider_accepted),
      delivery_finalized: Boolean(outcome.delivery_finalized),
      provider_status: outcome.provider_status,
      message_id: outcome.message_id,
      error_code: outcome.error_code,
      errors: outcome.errors,
      error: messageText,
      to: maskPhone(phone),
      request_id: outcome.request_id,
    }
    emitCallEvent(state.callControlId, {
      entry: transcriptEntry('Tool', `${label} failed: ${messageText}`, 'attention'),
      notice: label === 'Portal link' ? 'Portal delivery failed' : 'Text message failed',
      communication: {
        channel: 'sms',
        modality: 'text',
        direction: 'outbound',
        role: 'tool',
        body: `${label} failed: ${messageText}`,
        provider: 'telnyx',
        identity: {
          phone,
        },
        providerIds: cleanObject({
          messageId: outcome.message_id,
          fromPhone: getTelnyxSmsFrom(),
          toPhone: phone,
        }),
        providerLinks: outcome.message_id
          ? [{ provider: 'telnyx', kind: 'message', id: outcome.message_id }]
          : [],
        proof,
      },
    })
    outcome = {
      ...outcome,
      pending: false,
      sent: false,
      providerResult: undefined,
      proof,
      assistant_next_step:
        outcome.delivery_finalized
          ? 'Telnyx confirmed the text was not delivered. Do not claim it was sent or retry automatically; let the operator review the provider error.'
          : 'Do not say the text was sent. Ask to confirm the number again or let the operator help.',
    }
  }
  rememberBackgroundDeliveryResult(state, outcome)
  notifyVoiceOfBackgroundDelivery(state, outcome)
  return outcome
}

async function settleEmailBackgroundDelivery(state, outcome, { email, subject, body, label }) {
  if (outcome.ok) {
    const emailResult = outcome.providerResult || {}
    const contactUpdate = await persistBackgroundDeliveryContact(state, { email })
    const proof = {
      provider: 'google_workspace',
      to: maskEmail(email),
      from: getWorkspaceEmailAccount(),
      message_id: emailResult.id || emailResult.messageId || emailResult.message_id || '',
      thread_id: emailResult.threadId || emailResult.thread_id || '',
      request_id: outcome.request_id,
      contact_update: contactUpdate,
    }
    const eventText =
      label === 'Portal link'
        ? `Portal link sent by email to ${maskEmail(email)}.`
        : `Email sent to ${maskEmail(email)}.`
    emitCallEvent(state.callControlId, {
      entry: transcriptEntry('Tool', eventText, 'positive'),
      notice: label === 'Portal link' ? 'Portal link sent' : 'Email sent',
      communication: {
        channel: 'email',
        modality: 'text',
        direction: 'outbound',
        role: 'agent',
        body: `Subject: ${subject}\n\n${body}`,
        provider: 'google_workspace',
        identity: {
          email,
          externalThreadId: proof.thread_id,
        },
        providerIds: cleanObject({
          messageId: proof.message_id,
          emailThreadId: proof.thread_id,
          fromEmail: getWorkspaceEmailAccount(),
          toEmail: email,
        }),
        providerLinks: [
          proof.message_id
            ? { provider: 'google_workspace', kind: 'message', id: proof.message_id }
            : null,
          proof.thread_id
            ? { provider: 'google_workspace', kind: 'external_thread', id: proof.thread_id }
            : null,
        ].filter(Boolean),
        proof,
      },
    })
    outcome = {
      ...outcome,
      providerResult: undefined,
      pending: false,
      sent: true,
      proof,
      assistant_next_step:
        'Provider acceptance proof is available. You may say the email was sent to the confirmed email address.',
    }
  } else if (outcome.provider_accepted) {
    const messageText =
      outcome.error ||
      'Speak restarted during provider dispatch, so the email outcome is unverified.'
    emitCallEvent(state.callControlId, {
      entry: transcriptEntry(
        'Tool',
        `${label} provider outcome requires operator verification.`,
        'attention',
      ),
      notice: label === 'Portal link' ? 'Portal delivery unverified' : 'Email unverified',
      communication: {
        channel: 'email',
        modality: 'text',
        direction: 'outbound',
        role: 'tool',
        body: `${label} provider outcome requires operator verification.`,
        provider: 'google_workspace',
        identity: { email },
        providerIds: cleanObject({
          fromEmail: getWorkspaceEmailAccount(),
          toEmail: email,
        }),
        proof: {
          provider_accepted: true,
          outcome_unverified: true,
          error: messageText,
          to: maskEmail(email),
          request_id: outcome.request_id,
        },
      },
    })
    outcome = {
      ...outcome,
      ok: false,
      status: 'accepted_unverified',
      provider_accepted: true,
      pending: false,
      sent: false,
      assistant_next_step:
        'Do not say the email was sent and do not retry automatically. Let the operator verify the Workspace provider record.',
    }
  } else {
    const messageText = outcome.error || 'Email send failed'
    emitCallEvent(state.callControlId, {
      entry: transcriptEntry('Tool', `${label} failed: ${messageText}`, 'attention'),
      notice: label === 'Portal link' ? 'Portal delivery failed' : 'Email failed',
      communication: {
        channel: 'email',
        modality: 'text',
        direction: 'outbound',
        role: 'tool',
        body: `${label} failed: ${messageText}`,
        provider: 'google_workspace',
        identity: {
          email,
        },
        providerIds: cleanObject({
          fromEmail: getWorkspaceEmailAccount(),
          toEmail: email,
        }),
        proof: {
          error: messageText,
          to: maskEmail(email),
          request_id: outcome.request_id,
        },
      },
    })
    outcome = {
      ...outcome,
      pending: false,
      sent: false,
      assistant_next_step:
        'Do not say the email was sent. Ask to confirm the email address again or let the operator help.',
    }
  }
  rememberBackgroundDeliveryResult(state, outcome)
  notifyVoiceOfBackgroundDelivery(state, outcome)
  return outcome
}

async function persistBackgroundDeliveryContact(state, patch) {
  const result = await queueStateContactPersistence(state, () =>
    executeContactUpdatePersistence({
      lead: state.lead,
      patch,
      transient:
        state.backgroundDeliveryTransient === true ||
        isBrowserTestSandbox(state) ||
        isTransientWorkspaceLead(state?.lead),
    }),
  )
  applyStateLead(state, result.ok ? result.lead : { ...state.lead, ...patch })
  refreshVoiceLeadContext(state)
  return result.ok
    ? {
        ok: true,
        persisted: true,
        proof: result.proof,
      }
    : {
        ok: false,
        persisted: false,
        reason: result.reason || 'contact_persistence_failed',
      }
}

function queueStateContactPersistence(state, operation) {
  const queued = Promise.resolve(state.contactPersistenceQueue)
    .catch(() => {})
    .then(operation)
  state.contactPersistenceQueue = queued
  return queued
}

function rememberBackgroundDeliveryResult(state, outcome) {
  const result = cleanObject({
    ok: Boolean(outcome.ok),
    status: outcome.status,
    sent: Boolean(outcome.sent),
    request_id: outcome.request_id,
    channel: outcome.channel,
    provider: outcome.provider,
    destination: outcome.destination,
    queued_at: outcome.queued_at,
    completed_at: outcome.completed_at,
    error: outcome.error,
    observer_error: outcome.observer_error,
    provider_accepted: outcome.provider_accepted,
    provider_status: outcome.provider_status,
    delivery_finalized: outcome.delivery_finalized,
    error_code: outcome.error_code,
    errors: outcome.errors,
    proof: outcome.proof,
    assistant_next_step: outcome.assistant_next_step,
  })
  state.backgroundDeliveryResults = [
    ...(Array.isArray(state.backgroundDeliveryResults) ? state.backgroundDeliveryResults : []),
    result,
  ].slice(-8)
  state.latestBackgroundDelivery = result
}

function trackBackgroundDelivery(queued) {
  trackDeliveryOperation(queued.completion)
  return queued
}

function trackDeliveryOperation(operation) {
  const result = Promise.resolve(operation)
  let tracked
  tracked = result
    .then(
      () => undefined,
      () => undefined,
    )
    .finally(() => {
      deliveryDrainPromises.delete(tracked)
    })
  deliveryDrainPromises.add(tracked)
  return result
}

function beginDeliveryAdmission() {
  let finished = false
  let resolveCompletion
  const completion = new Promise((resolve) => {
    resolveCompletion = resolve
  })
  trackDeliveryOperation(completion)
  return {
    finish() {
      if (finished) return
      finished = true
      resolveCompletion()
    },
  }
}

async function queueVoiceBackgroundDelivery(
  state,
  { dedupeContent = '', dedupeDestination = '', ...options },
) {
  const fingerprint = createBackgroundDeliveryFingerprint({
    scope: state.callControlId,
    channel: options.channel,
    provider: options.provider,
    destination: dedupeDestination,
    content: dedupeContent,
  })
  state.backgroundDeliveryRequests ||= new Map()

  if (shutdownStarted) {
    const result = {
      ok: false,
      queued: false,
      pending: false,
      sent: false,
      status: 'failed',
      reason: 'service_shutting_down',
      request_id: options.requestId || randomUUID(),
      channel: options.channel,
      provider: options.provider,
      destination: options.destination,
      assistant_next_step:
        'Speak is restarting and did not start this delivery. Do not say it was sent; ask the operator to retry after the service is ready.',
    }
    return {
      result,
      completion: Promise.resolve(result),
      deduplicated: false,
      rejected: true,
    }
  }

  const queued = trackBackgroundDelivery(
    await backgroundDeliveryOutbox.admit({
      requestId: options.requestId,
      fingerprint,
      channel: options.channel,
      provider: options.provider,
      destination: options.destination,
      payload: options.payload,
      context: durableBackgroundDeliveryContext(state),
      safety: 'at_most_once',
      maxAttempts: 1,
    }),
  )
  const entry = {
    status: queued.result.pending ? 'processing' : queued.result.status,
    expiresAt: queued.result.pending ? Number.POSITIVE_INFINITY : Date.now() + 120_000,
    result: queued.result,
    completion: queued.completion,
  }
  state.backgroundDeliveryRequests.set(fingerprint, entry)
  void queued.completion.then((outcome) => {
    const deliveryProven =
      outcome.sent === true && Boolean(outcome.proof) && !outcome.observer_error
    entry.status = outcome.status
    entry.result = {
      ...outcome,
      ok: outcome.observer_error ? false : Boolean(outcome.ok),
      providerResult: undefined,
      pending: false,
      sent: deliveryProven,
    }
    if (outcome.ok || outcome.provider_accepted) {
      entry.expiresAt = Date.now() + 120_000
    } else {
      state.backgroundDeliveryRequests.delete(fingerprint)
    }
  })
  return {
    ...queued,
    deduplicated: Boolean(queued.deduplicated),
  }
}

function durableBackgroundDeliveryContext(state) {
  return {
    callControlId: String(state?.callControlId || ''),
    transient:
      isBrowserTestSandbox(state) ||
      isTransientWorkspaceLead(state?.lead),
    state: {
      callControlId: String(state?.callControlId || ''),
      callProvider: safeLeadText(state?.callProvider),
      origin: safeLeadText(state?.origin),
      createdAt: state?.createdAt || new Date().toISOString(),
      updatedAt: state?.updatedAt || new Date().toISOString(),
      productionContext: Boolean(state?.productionContext),
      lead: JSON.parse(JSON.stringify(state?.lead || {})),
      config: cleanObject({
        agentProfileId: state?.config?.agentProfileId,
        agentProfileName: state?.config?.agentProfileName,
        speakConfigId: state?.config?.speakConfigId,
        voiceRuntimeProvider: state?.config?.voiceRuntimeProvider,
        languageModelMode: state?.config?.languageModelMode,
        dialerProvider: state?.config?.dialerProvider,
      }),
    },
  }
}

async function executeDurableBackgroundDelivery(job) {
  const payload = job?.payload || {}
  if (job?.channel === 'sms' && job?.provider === 'telnyx') {
    return sendTextMessage(payload.phone, payload.message)
  }
  if (job?.channel === 'email' && job?.provider === 'google_workspace') {
    return sendEmail(payload.email, payload.subject, payload.body)
  }
  throw new Error(
    `Unsupported background delivery provider: ${job?.channel || 'delivery'}/${job?.provider || 'unknown'}`,
  )
}

async function settleDurableBackgroundDelivery(job, outcome) {
  const callControlId = safeLeadText(job?.context?.callControlId)
  let state = callControlId ? calls.get(callControlId) : null
  let recovered = false
  if (!state) {
    const snapshot = job?.context?.state || {}
    state = {
      ...snapshot,
      callControlId: callControlId || safeLeadText(snapshot.callControlId) || job.requestId,
      lead: snapshot.lead && typeof snapshot.lead === 'object' ? snapshot.lead : {},
      config: snapshot.config && typeof snapshot.config === 'object' ? snapshot.config : {},
      eventLog: [{ patch: { phase: 'ended' } }],
      ending: true,
      backgroundDeliveryTransient: Boolean(job?.context?.transient),
      pendingCommunicationEvents: [],
      contactPersistenceQueue: Promise.resolve(),
    }
    calls.set(state.callControlId, state)
    recovered = true
  }

  try {
    let settled
    if (job.channel === 'sms') {
      settled = await settleSmsBackgroundDelivery(state, outcome, {
        phone: job.payload?.phone,
        message: job.payload?.message,
        label: job.payload?.label || 'Text message',
      })
    } else if (job.channel === 'email') {
      settled = await settleEmailBackgroundDelivery(state, outcome, {
        email: job.payload?.email,
        subject: job.payload?.subject,
        body: job.payload?.body,
        label: job.payload?.label || 'Email',
      })
    } else {
      throw new Error(`Unsupported background delivery channel: ${job.channel}`)
    }
    if (recovered || state.pendingCommunicationEvents?.length) {
      await flushStateCallCommunicationEvents(state)
    }
    return settled
  } finally {
    if (recovered && calls.get(state.callControlId) === state) {
      calls.delete(state.callControlId)
    }
  }
}

function backgroundDeliveryObserverFailure(outcome, error) {
  const observerError = error instanceof Error ? error.message : String(error || '')
  const providerAccepted = Boolean(outcome?.ok)
  return {
    ...outcome,
    ok: false,
    status: providerAccepted ? 'accepted_unverified' : 'failed',
    provider_accepted: providerAccepted,
    providerResult: undefined,
    pending: false,
    sent: false,
    observer_error: observerError,
    assistant_next_step: providerAccepted
      ? 'The provider may have accepted this delivery, but Speak could not retain completion proof. Do not say it was sent and do not retry automatically; let the operator verify the provider record.'
      : 'Delivery failed and Speak could not finish its failure proof. Do not say it was sent; let the operator verify the destination and provider record.',
  }
}

function hasPendingBackgroundDelivery(state) {
  return (
    state?.backgroundDeliveryRequests instanceof Map &&
    Array.from(state.backgroundDeliveryRequests.values()).some(
      (entry) => entry.status === 'processing',
    )
  )
}

function notifyVoiceOfBackgroundDelivery(state, outcome) {
  if (!state || state.ending || isCallEnded(state)) return
  const instruction = outcome.observer_error
    ? `The ${outcome.channel} provider may have accepted the background delivery to ${outcome.destination}, but Speak could not retain proof. Do not say it was sent and do not retry automatically; continue naturally and let the operator verify the provider record.`
    : outcome.sent
      ? `Background ${outcome.channel} delivery to ${outcome.destination} now has provider acceptance proof. You may acknowledge that it was sent if relevant, without interrupting the caller.`
      : `Background ${outcome.channel} delivery to ${outcome.destination} failed. Do not say it was sent; continue naturally and offer to verify the destination or retry if relevant.`
  void sendVoiceInstruction(state, instruction).catch((error) => {
    console.warn(
      'Failed to notify voice session of background delivery completion:',
      error instanceof Error ? error.message : error,
    )
  })
}

export async function handleUpdateContactTool(state, args) {
  if (!truthy(args.details_confirmed)) {
    return {
      ok: false,
      reason: 'details_not_confirmed',
      assistant_next_step:
        'Repeat the exact contact details back and get confirmation before saving them.',
    }
  }

  const patch = {}
  const phone = normalizePhone(args.phone_number || args.phone || '')
  const email = cleanEmail(args.email || args.email_address || '')
  const providedFullName = cleanName(args.full_name || args.name || '')
  const firstFromArgs = cleanName(args.first_name || '')
  const lastFromArgs = cleanName(args.last_name || '')
  const derived = splitPersonName(providedFullName)
  const firstName = firstFromArgs || derived.firstName
  const lastName = lastFromArgs || derived.lastName
  const organization = safeLeadText(
    args.organization || args.business_name || args.company || '',
  )

  if (args.phone_number || args.phone) {
    if (!phone) {
      return {
        ok: false,
        reason: 'invalid_phone',
        assistant_next_step: 'Ask the contact to repeat the phone number with area code.',
      }
    }
    patch.phone = phone
  }

  if (args.email || args.email_address) {
    if (!email) {
      return {
        ok: false,
        reason: 'invalid_email',
        assistant_next_step: 'Ask the contact to spell the email address again.',
      }
    }
    patch.email = email
  }

  if (firstName) patch.firstName = firstName
  if (lastName) patch.lastName = lastName
  if (firstName || lastName) patch.name = [firstName, lastName].filter(Boolean).join(' ')
  if (organization) patch.company = organization

  if (Object.keys(patch).length === 0) {
    return {
      ok: false,
      reason: 'nothing_to_update',
      assistant_next_step:
        'Continue the conversation and only update contact details after the contact confirms them.',
    }
  }

  const persistedUpdate = await queueStateContactPersistence(state, () =>
    executeContactUpdatePersistence({
      lead: state.lead,
      patch,
      transient:
        isBrowserTestSandbox(state) ||
        isTransientWorkspaceLead(state?.lead),
    }),
  )
  if (!persistedUpdate.ok) return persistedUpdate
  applyStateLead(state, persistedUpdate.lead)
  const persistenceProof = persistedUpdate.proof
  emitCallEvent(state.callControlId, {
    entry: transcriptEntry('Tool', `Contact updated: ${contactPatchSummary(patch)}.`, 'positive'),
    notice: 'Lead contact updated',
    communication: {
      channel: 'tool',
      modality: 'tool',
      direction: 'internal',
      role: 'tool',
      body: `Contact updated: ${contactPatchSummary(patch)}.`,
      proof: {
        patch: Object.keys(patch),
        contact: publicLeadContext(state),
        persistence: persistenceProof,
      },
    },
  })

  return {
    ok: true,
    contact: publicLeadContext(state),
    proof: {
      ...persistenceProof,
      patch: Object.keys(patch),
    },
    assistant_next_step:
      'Use the updated contact details for the rest of the conversation and any later messaging.',
  }
}

function handleUpdateCallerIdentityTool(state, args) {
  const providedFullName = cleanName(args.full_name || args.name || '')
  const firstFromArgs = cleanName(args.first_name || '')
  const lastFromArgs = cleanName(args.last_name || '')
  const derived = splitPersonName(providedFullName)
  const firstName = firstFromArgs || derived.firstName
  const lastName = lastFromArgs || derived.lastName
  const businessName = safeLeadText(
    args.organization || args.business_name || args.company || '',
  )

  if (!firstName && !lastName && !businessName) {
    return {
      ok: false,
      reason: 'invalid_identity',
      assistant_next_step:
        'Ask for the correct name naturally, then use that name for the rest of the conversation.',
    }
  }

  const patch = {}
  if (firstName) patch.firstName = firstName
  if (lastName) patch.lastName = lastName
  if (firstName || lastName) patch.name = [firstName, lastName].filter(Boolean).join(' ')
  if (businessName) patch.company = businessName

  updateStateLead(state, patch)
  emitCallEvent(state.callControlId, {
    entry: transcriptEntry(
      'Tool',
      `Caller context updated: ${publicLeadContext(state).name}.`,
      'positive',
    ),
    notice: 'Caller name updated',
    communication: {
      channel: 'tool',
      modality: 'tool',
      direction: 'internal',
      role: 'tool',
      body: `Caller context updated: ${publicLeadContext(state).name}.`,
      proof: {
        patch: Object.keys(patch),
        contact: publicLeadContext(state),
      },
    },
  })

  return {
    ok: true,
    lead: publicLeadContext(state),
    assistant_next_step:
      'Use this corrected identity for natural references during the rest of the conversation.',
  }
}

function sendHumeToolResponse(state, request, result) {
  if (!state.humeWs || state.humeWs.readyState !== WebSocket.OPEN) return
  state.humeWs.send(
    JSON.stringify({
      type: 'tool_response',
      tool_call_id: request.tool_call_id,
      tool_name: request.name,
      tool_type: request.tool_type || 'function',
      content: JSON.stringify(result),
    }),
  )
}

function sendHumeToolError(state, request, error) {
  if (!state.humeWs || state.humeWs.readyState !== WebSocket.OPEN) return
  state.humeWs.send(
    JSON.stringify({
      type: 'tool_error',
      tool_call_id: request.tool_call_id,
      tool_type: request.tool_type || 'function',
      error,
      code: 'tool_execution_failed',
      level: 'warn',
      content:
        'The tool failed. Do not claim the action succeeded. Verify the needed details or let the operator take over.',
    }),
  )
}

function sendInworldToolResponse(state, callId, result) {
  if (!callId || !state.inworldWs || state.inworldWs.readyState !== WebSocket.OPEN) return
  state.inworldWs.send(
    JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify(result),
      },
    }),
  )
  state.inworldWs.send(JSON.stringify({ type: 'response.create' }))
}

function sendInworldToolError(state, callId, error) {
  sendInworldToolResponse(state, callId, {
    ok: false,
    error,
    assistant_next_step:
      'The tool failed. Do not claim the action succeeded. Verify the needed details or let the operator take over.',
  })
}

function parseToolParameters(value) {
  if (!value) return {}
  if (typeof value === 'object') return value
  try {
    return JSON.parse(String(value))
  } catch {
    return {}
  }
}

function refreshVoiceLeadContext(state) {
  if (isXaiRuntime(state?.config || {})) {
    sendXaiSessionUpdate(state, { includeTools: false })
    return
  }
  if (isInworldRuntime(state?.config || {})) {
    sendInworldSessionUpdate(state, { includeTools: false })
    return
  }

  if (!state.humeWs || state.humeWs.readyState !== WebSocket.OPEN) return
  state.humeWs.send(
    JSON.stringify(buildHumeSessionSettings(state, { includeTools: false })),
  )
}

function updateAudioQualityTransport(state) {
  if (!state?.audioQuality) return
  state.audioQuality.codec = state.telnyxCodec
  state.audioQuality.sampleRate = state.sampleRate
}

function incrementAudioQualityCounter(state, bucket, key, amount = 1) {
  if (!state?.audioQuality?.[bucket]) return
  state.audioQuality[bucket][key] = Number(state.audioQuality[bucket][key] || 0) + amount
}

function trackAudioQualityBuffer(state, bucket, pcmLittleEndian) {
  if (!pcmLittleEndian?.length) return
  trackAudioQualitySamples(state, bucket, bufferToInt16LE(pcmLittleEndian))
}

function trackAudioQualitySamples(state, bucket, samples) {
  const target = state?.audioQuality?.[bucket]
  if (!target || !samples?.length) return

  const stats = analyzePcm16(samples)
  target.peakRatioMax = Math.max(target.peakRatioMax || 0, stats.peakRatio)
  target.clippedSamples = Number(target.clippedSamples || 0) + stats.clipped
  if (stats.clipped > 0) {
    target.clippedFrames = Number(target.clippedFrames || 0) + 1
  }
}

function audioQualitySnapshot(state) {
  if (!state?.audioQuality) return null
  updateAudioQualityTransport(state)
  if (state.audioQuality.queue) {
    const telnyxDroppedFrames = Number(state.telnyxDroppedOutboundFrames || 0)
    state.audioQuality.queue.telnyxDroppedFrames = telnyxDroppedFrames
    state.audioQuality.queue.droppedFrames = Math.max(
      Number(state.audioQuality.queue.droppedFrames || 0),
      telnyxDroppedFrames,
    )
  }
  return state.audioQuality
}

function emitTelnyxMediaFormatWarnings(state, mediaFormat = {}) {
  const codec = normalizeAudioCodec(state.telnyxCodec)
  const sampleRate = Number(state.sampleRate)
  const channels = Number(mediaFormat.channels || state.telnyxChannels || 1)
  const warnings = []

  if (!codec) {
    warnings.push(`Unsupported phone media codec: ${state.telnyxCodec || 'missing'}.`)
  } else if (codec === 'L16' && sampleRate !== 16000) {
    warnings.push(`Unexpected L16 sample rate from phone provider: ${sampleRate}. Expected 16000.`)
  } else if (codec === 'PCMU' && sampleRate !== 8000) {
    warnings.push(`Unexpected PCMU sample rate from phone provider: ${sampleRate}. Expected 8000.`)
  }

  if (channels !== 1) {
    warnings.push(`Unexpected phone channel count: ${channels}. Expected 1.`)
  }

  warnings.forEach((warning) => {
    emitCallEvent(state.callControlId, {
      entry: transcriptEntry('System', warning, 'attention'),
      notice: 'Unexpected phone media format',
    })
  })
}

function isVoiceSessionOpen(state) {
  if (!state) return false
  if (isXaiRuntime(state.config)) {
    return state.voiceInputReady && state.xaiWs?.readyState === WebSocket.OPEN
  }
  if (isInworldRuntime(state.config)) {
    return state.voiceInputReady && state.inworldWs?.readyState === WebSocket.OPEN
  }
  return state.voiceInputReady && state.humeWs?.readyState === WebSocket.OPEN
}

function startHumeInputPrimer(state) {
  if (
    !state ||
    isInworldRuntime(state.config) ||
    isXaiRuntime(state.config) ||
    state.humeInputPrimerStartedAt ||
    state.voiceInputMediaStarted ||
    state.ending ||
    state.humeWs?.readyState !== WebSocket.OPEN
  ) return false

  const configuredMinimumReadyMs = Math.max(
    250,
    Math.min(3_000, Number(HUME_INPUT_PRIMER_MIN_READY_MS) || 1_000),
  )
  const nudgeIntervalMs = Number(state.config?.nudgesIntervalSeconds) * 1_000
  const nudgeSafeDurationMs =
    state.config?.nudgesEnabled === true && Number.isFinite(nudgeIntervalMs) && nudgeIntervalMs > 0
      ? Math.max(250, nudgeIntervalMs - 500)
      : Number.POSITIVE_INFINITY
  const minimumReadyMs = Math.min(configuredMinimumReadyMs, nudgeSafeDurationMs)
  const maximumDurationMs = Math.max(
    minimumReadyMs,
    Math.min(
      30_000,
      Number(HUME_INPUT_PRIMER_MAX_MS) || 10_000,
      nudgeSafeDurationMs,
    ),
  )
  const frame = humeInputPrimerFrame(state.sampleRate, HUME_INPUT_PRIMER_CHUNK_MS)
  state.humeInputPrimerStartedAt = Date.now()
  state.humeInputPrimerReadyPromise = new Promise((resolve) => {
    state.resolveHumeInputPrimerReady = resolve
  })

  const sendPrimerFrame = () => {
    if (
      state.voiceInputMediaStarted ||
      state.ending ||
      state.humeWs?.readyState !== WebSocket.OPEN
    ) {
      stopHumeInputPrimer(state, 'unavailable')
      return
    }
    state.humeWs.send(
      JSON.stringify({ type: 'audio_input', data: frame.toString('base64') }),
    )
    addTransportCounter(state, 'humeInputPrimerPackets')
    addTransportCounter(state, 'humeInputPrimerBytes', frame.length)
    recordTransportMilestone(state, 'first_hume_input_primer', {
      chunkMs: HUME_INPUT_PRIMER_CHUNK_MS,
    })
  }

  sendPrimerFrame()
  state.humeInputPrimerInterval = setInterval(
    sendPrimerFrame,
    HUME_INPUT_PRIMER_CHUNK_MS,
  )
  state.humeInputPrimerInterval.unref?.()
  state.humeInputPrimerReadyTimer = setTimeout(() => {
    state.humeInputPrimerReadyTimer = null
    state.resolveHumeInputPrimerReady?.(true)
    state.resolveHumeInputPrimerReady = null
    recordTransportMilestone(state, 'hume_input_primer_ready', {
      minimumReadyMs,
    })
  }, minimumReadyMs)
  state.humeInputPrimerReadyTimer.unref?.()
  state.humeInputPrimerMaxTimer = setTimeout(
    () => stopHumeInputPrimer(state, 'max_duration'),
    maximumDurationMs,
  )
  state.humeInputPrimerMaxTimer.unref?.()
  return true
}

function stopHumeInputPrimer(state, reason = 'stopped') {
  if (!state) return false
  const active = Boolean(
    state.humeInputPrimerInterval ||
      state.humeInputPrimerReadyTimer ||
      state.humeInputPrimerMaxTimer,
  )
  clearInterval(state.humeInputPrimerInterval)
  clearTimeout(state.humeInputPrimerReadyTimer)
  clearTimeout(state.humeInputPrimerMaxTimer)
  state.humeInputPrimerInterval = null
  state.humeInputPrimerReadyTimer = null
  state.humeInputPrimerMaxTimer = null
  state.resolveHumeInputPrimerReady?.(true)
  state.resolveHumeInputPrimerReady = null
  if (active) {
    recordTransportMilestone(state, 'hume_input_primer_stopped', {
      reason,
      durationMs: Math.max(0, Date.now() - Number(state.humeInputPrimerStartedAt || Date.now())),
    })
  }
  return active
}

async function waitForHumeInputPrimerReady(state) {
  if (
    !isCallToolsGatewayCall(state) ||
    isInworldRuntime(state.config) ||
    isXaiRuntime(state.config) ||
    state.config?.eviStartsConversation === true
  ) return
  await state.humeInputPrimerReadyPromise
}

function sendAudioToVoiceProvider(state, pcmLittleEndian) {
  state.voiceInputMediaStarted = true
  stopHumeInputPrimer(state, 'media_started')
  const sampleRate = state?.sampleRate || state?.config?.sampleRate
  let voiceInputPcm = pcmLittleEndian
  if (state?.browserTest) {
    noteVoiceInputPcmActivity(state, pcmLittleEndian, { sampleRate })
  } else {
    const conditioned = conditionPhoneVoiceInputPcm(state, pcmLittleEndian, {
      sampleRate,
    })
    voiceInputPcm = conditioned.pcm
    if (conditioned.suppressed) {
      addTransportCounter(state, 'voiceInputNoiseSuppressedFrames')
      addTransportCounter(
        state,
        'voiceInputNoiseSuppressedBytes',
        voiceInputPcm.length,
      )
      setTransportDiagnosticValue(state, 'voice', 'inputConditioning', {
        mode: 'post_speech_carrier_silence',
        suppressedBytes: state.phoneVoiceInputConditioner?.suppressedBytes || 0,
        suppressedFrames: state.phoneVoiceInputConditioner?.suppressedFrames || 0,
      })
    }
  }
  if (!isVoiceSessionOpen(state)) {
    if (shouldBufferVoiceInputBeforeReady(state, voiceInputPcm)) {
      const previousDroppedFrames = Number(state.voiceInputPreReadyDroppedFrames || 0)
      const previousDroppedBytes = Number(state.voiceInputPreReadyDroppedBytes || 0)
      const snapshot = bufferVoiceInputBeforeReady(state, voiceInputPcm)
      addTransportCounter(state, 'voiceInputPreReadyBufferedFrames')
      addTransportCounter(state, 'voiceInputPreReadyBufferedBytes', voiceInputPcm.length)
      addTransportCounter(
        state,
        'voiceInputPreReadyDroppedFrames',
        Math.max(0, snapshot.droppedFrames - previousDroppedFrames),
      )
      addTransportCounter(
        state,
        'voiceInputPreReadyDroppedBytes',
        Math.max(0, snapshot.droppedBytes - previousDroppedBytes),
      )
      setTransportDiagnosticValue(state, 'voice', 'preReadyBuffer', snapshot)
      recordTransportMilestone(state, 'first_voice_input_buffered_before_ready', {
        provider: isXaiRuntime(state.config)
          ? 'xai'
          : isInworldRuntime(state.config)
            ? 'inworld'
            : 'hume',
        bufferedFrames: snapshot.bufferedFrames,
        bufferedDurationMs: snapshot.bufferedDurationMs,
        maxDurationMs: snapshot.maxDurationMs,
      })
    }
    return
  }

  if (isXaiRuntime(state?.config || {})) {
    sendAudioToXai(state, voiceInputPcm)
    return
  }

  if (isInworldRuntime(state?.config || {})) {
    sendAudioToInworld(state, voiceInputPcm)
    return
  }

  sendAudioToHume(state, voiceInputPcm)
}

function shouldBufferVoiceInputBeforeReady(state, pcmLittleEndian) {
  return Boolean(
    state &&
      pcmLittleEndian?.length &&
      !state.browserTest &&
      (!isCallToolsGatewayCall(state) || state.xaiReconnecting) &&
      !state.ending &&
      !isCallEnded(state) &&
      state.telnyxWs?.readyState === WebSocket.OPEN,
  )
}

function flushVoiceInputPreReadyBuffer(state, provider) {
  const drained = drainVoiceInputBeforeReady(state)
  if (!drained.frames.length) return

  const bufferedBytes = drained.frames.reduce((total, frame) => total + frame.length, 0)
  addTransportCounter(state, 'voiceInputPreReadyFlushedFrames', drained.frames.length)
  addTransportCounter(state, 'voiceInputPreReadyFlushedBytes', bufferedBytes)
  setTransportDiagnosticValue(state, 'voice', 'preReadyBufferFlush', {
    bufferedFrames: drained.bufferedFrames,
    bufferedBytes: drained.bufferedBytes,
    bufferedDurationMs: drained.bufferedDurationMs,
    speechFrames: drained.speechFrames,
    speechBytes: drained.speechBytes,
    droppedFrames: drained.droppedFrames,
    droppedBytes: drained.droppedBytes,
    droppedSpeechFrames: drained.droppedSpeechFrames,
    droppedSilenceFrames: drained.droppedSilenceFrames,
    maxDurationMs: drained.maxDurationMs,
  })
  recordTransportMilestone(state, 'voice_input_pre_ready_flushed', {
    provider,
    bufferedFrames: drained.bufferedFrames,
    bufferedDurationMs: drained.bufferedDurationMs,
    droppedFrames: drained.droppedFrames,
  })

  for (const frame of drained.frames) {
    if (provider === 'xai') sendAudioToXai(state, frame)
    else if (provider === 'inworld') sendAudioToInworld(state, frame)
    else sendAudioToHume(state, frame)
  }
}

function discardVoiceInputPreReadyBuffer(state, reason) {
  const discarded = clearVoiceInputBeforeReady(state)
  if (!discarded.bufferedFrames) return

  setTransportDiagnosticValue(state, 'voice', 'preReadyBufferDiscard', {
    reason,
    bufferedFrames: discarded.bufferedFrames,
    bufferedBytes: discarded.bufferedBytes,
    bufferedDurationMs: discarded.bufferedDurationMs,
    speechFrames: discarded.speechFrames,
    speechBytes: discarded.speechBytes,
    droppedFrames: discarded.droppedFrames,
    droppedBytes: discarded.droppedBytes,
    droppedSpeechFrames: discarded.droppedSpeechFrames,
    droppedSilenceFrames: discarded.droppedSilenceFrames,
  })
  recordTransportMilestone(state, 'voice_input_pre_ready_discarded', {
    reason,
    bufferedFrames: discarded.bufferedFrames,
    bufferedDurationMs: discarded.bufferedDurationMs,
  })
}

function sendAudioToInworld(state, pcmLittleEndian) {
  if (!isVoiceSessionOpen(state)) return

  addTransportCounter(state, 'inworldAudioInputs')
  addTransportCounter(state, 'inworldAudioInputBytes', pcmLittleEndian.length)
  recordTransportMilestone(state, 'first_inworld_audio_input')
  state.inworldWs.send(
    JSON.stringify({
      type: 'input_audio_buffer.append',
      audio: pcmLittleEndian.toString('base64'),
    }),
  )
}

function sendAudioToXai(state, pcmLittleEndian) {
  if (!isVoiceSessionOpen(state)) return
  addTransportCounter(state, 'xaiAudioInputs')
  addTransportCounter(state, 'xaiAudioInputBytes', pcmLittleEndian.length)
  recordTransportMilestone(state, 'first_xai_audio_input')
  state.xaiWs.send(
    JSON.stringify({
      type: 'input_audio_buffer.append',
      audio: pcmLittleEndian.toString('base64'),
    }),
  )
}

function sendAudioToHume(state, pcmLittleEndian) {
  if (!isVoiceSessionOpen(state)) return

  addTransportCounter(state, 'humeAudioInputs')
  addTransportCounter(state, 'humeAudioInputBytes', pcmLittleEndian.length)
  recordTransportMilestone(state, 'first_hume_audio_input')
  state.humeWs.send(
    JSON.stringify({
      type: 'audio_input',
      data: pcmLittleEndian.toString('base64'),
    }),
  )
}

function sendInitialGreetingPrompt(state) {
  if (state.initialGreetingSent) return false
  if (!isVoiceSessionOpen(state)) return false

  state.initialGreetingSent = true
  const firstName = preferredFirstName(state.lead)
  const organization = safeLeadText(state.lead?.company) || 'the organization'
  const prompt = state.inbound
    ? [
        'An inbound Personal Phone call is connected now.',
        firstName
          ? `Greet ${firstName} according to the active agent instructions.`
          : `Greet the caller according to the active agent instructions for ${organization}.`,
        'Keep the first spoken turn short.',
      ].join(' ')
    : [
        'The outbound phone call is connected now.',
        firstName
          ? `Begin according to the active agent instructions by asking for ${firstName}.`
          : `Begin according to the active agent instructions and confirm you reached the right contact for ${organization}.`,
        'Keep the first spoken turn short.',
      ].join(' ')
  state.syntheticUserInputs.add(normalizeTranscriptContent(prompt))
  recordTransportMilestone(state, 'initial_greeting_requested')
  void sendVoiceUserInput(state, prompt, { reason: 'initial_greeting' })
  emitCallEvent(state.callControlId, {
    entry: transcriptEntry('System', 'Initial agent greeting requested.', 'system'),
    notice: 'Initial greeting requested',
  })
  return true
}

function maybeSendInitialGreetingPrompt(state) {
  if (isCallToolsGatewayCall(state)) return false
  if (!state?.config?.autoStartGreeting) return false
  if (isProvisionalVoiceSessionState(state)) return false
  if (!state.browserTest && !state.answered) return false
  if (
    !state.browserTest &&
    (!state.streamId || state.telnyxWs?.readyState !== WebSocket.OPEN)
  ) return false
  return sendInitialGreetingPrompt(state)
}

function sendHumeAudioToTelnyx(state, humeAudioBase64) {
  const wav = Buffer.from(humeAudioBase64, 'base64')
  const decoded = decodeWavPcm16(wav, state.sampleRate)
  recordCallStageAudioSamples(state, {
    stage: 'ai-hume-output',
    samples: decoded.samples,
    sampleRate: decoded.sampleRate,
  })
  trackAudioQualitySamples(state, 'humeOutput', decoded.samples)
  const target = resamplePcm16(decoded.samples, decoded.sampleRate, state.sampleRate)
  const leveled = levelPcm16ForPhone(target, {
    gain: state.config.phoneOutputGain,
    peakRatio: state.config.phoneOutputPeak,
  })
  recordCallStageAudioSamples(state, {
    stage: 'ai-telnyx-output',
    samples: leveled,
    sampleRate: state.sampleRate,
  })
  trackAudioQualitySamples(state, 'telnyxOutput', leveled)
  recordCallAudioSamples(state, {
    source: 'ai',
    samples: leveled,
    sampleRate: state.sampleRate,
  })
  markPersonalPhoneOutboundConversationStarted(state, leveled)
  enqueueAssistantPcmToTelnyx(state, int16ToBufferLE(leveled))
}

function sendHumeAudioToBrowser(state, humeAudioBase64) {
  const decoded = decodeWavPcm16(Buffer.from(humeAudioBase64, 'base64'), state.sampleRate)
  const target = resamplePcm16(decoded.samples, decoded.sampleRate, state.sampleRate)
  const leveled = levelPcm16ForPhone(target, {
    gain: state.config.phoneOutputGain,
    peakRatio: state.config.phoneOutputPeak,
  })

  sendAssistantPcmToBrowser(state, int16ToBufferLE(leveled))
}

function sendHumeAudioToCallToolsGateway(state, humeAudioBase64) {
  if (state.calltoolsWs?.readyState !== WebSocket.OPEN) return
  const decoded = decodeWavPcm16(Buffer.from(humeAudioBase64, 'base64'), state.sampleRate)
  recordCallStageAudioSamples(state, {
    stage: 'ai-hume-output',
    samples: decoded.samples,
    sampleRate: decoded.sampleRate,
  })
  trackAudioQualitySamples(state, 'humeOutput', decoded.samples)
  const target = resamplePcm16(decoded.samples, decoded.sampleRate, state.sampleRate)
  const leveled = levelPcm16ForPhone(target, {
    gain: state.config.phoneOutputGain,
    peakRatio: state.config.phoneOutputPeak,
  })
  sendPcmToCallToolsGateway(state, int16ToBufferLE(leveled), 'hume')
}

function sendInworldAudioToTelnyx(state, pcmLittleEndian) {
  const sourceRate = Number(state.config.inworldOutputSampleRate || state.sampleRate || 16000)
  const aligned = pcmLittleEndian.length % 2
    ? pcmLittleEndian.subarray(0, pcmLittleEndian.length - 1)
    : pcmLittleEndian
  const samples = bufferToInt16LE(aligned)
  recordCallStageAudioSamples(state, {
    stage: 'ai-inworld-output',
    samples,
    sampleRate: sourceRate,
  })
  trackAudioQualitySamples(state, 'humeOutput', samples)
  const target = resamplePcm16(samples, sourceRate, state.sampleRate)
  const leveled = levelPcm16ForPhone(target, {
    gain: state.config.phoneOutputGain,
    peakRatio: state.config.phoneOutputPeak,
  })
  recordCallStageAudioSamples(state, {
    stage: 'ai-telnyx-output',
    samples: leveled,
    sampleRate: state.sampleRate,
  })
  trackAudioQualitySamples(state, 'telnyxOutput', leveled)
  recordCallAudioSamples(state, {
    source: 'ai',
    samples: leveled,
    sampleRate: state.sampleRate,
  })
  markPersonalPhoneOutboundConversationStarted(state, leveled)
  enqueueAssistantPcmToTelnyx(state, int16ToBufferLE(leveled))
}

function sendInworldAudioToBrowser(state, pcmLittleEndian) {
  const sourceRate = Number(state.config.inworldOutputSampleRate || state.sampleRate || 16000)
  const aligned = pcmLittleEndian.length % 2
    ? pcmLittleEndian.subarray(0, pcmLittleEndian.length - 1)
    : pcmLittleEndian
  const samples = bufferToInt16LE(aligned)
  const target = resamplePcm16(samples, sourceRate, state.sampleRate)
  const leveled = levelPcm16ForPhone(target, {
    gain: state.config.phoneOutputGain,
    peakRatio: state.config.phoneOutputPeak,
  })

  sendAssistantPcmToBrowser(state, int16ToBufferLE(leveled))
}

function sendAssistantPcmToBrowser(state, pcmLittleEndian) {
  if (!state?.browserTest || state.ending || !pcmLittleEndian?.length) return false
  if (state.browserWs?.readyState === WebSocket.OPEN) {
    sendBrowserAudioFrame(state.browserWs, pcmLittleEndian, state.sampleRate)
    return true
  }
  if (!state.browserAudioAttachPending) return false
  bufferBrowserAudioBeforeAttach(state, pcmLittleEndian)
  return false
}

function flushBrowserAudioBeforeAttach(state, ws = state?.browserWs) {
  if (ws?.readyState !== WebSocket.OPEN) return 0
  const drained = drainBrowserAudioBeforeAttach(state)
  for (const frame of drained.frames) {
    if (state.browserWs !== ws || ws.readyState !== WebSocket.OPEN) break
    sendBrowserAudioFrame(ws, frame, state.sampleRate)
  }
  return drained.frames.length
}

function sendBrowserAudioFrame(ws, pcmLittleEndian, sampleRate) {
  ws.send(
    JSON.stringify({
      type: 'audio',
      data: Buffer.from(pcmLittleEndian).toString('base64'),
      sampleRate,
    }),
  )
}

function sendInworldAudioToCallToolsGateway(state, pcmLittleEndian) {
  if (state.calltoolsWs?.readyState !== WebSocket.OPEN) return
  const sourceRate = Number(state.config.inworldOutputSampleRate || state.sampleRate || 16000)
  const aligned = pcmLittleEndian.length % 2
    ? pcmLittleEndian.subarray(0, pcmLittleEndian.length - 1)
    : pcmLittleEndian
  const samples = bufferToInt16LE(aligned)
  recordCallStageAudioSamples(state, {
    stage: 'ai-inworld-output',
    samples,
    sampleRate: sourceRate,
  })
  trackAudioQualitySamples(state, 'humeOutput', samples)
  const target = resamplePcm16(samples, sourceRate, state.sampleRate)
  const leveled = levelPcm16ForPhone(target, {
    gain: state.config.phoneOutputGain,
    peakRatio: state.config.phoneOutputPeak,
  })
  sendPcmToCallToolsGateway(state, int16ToBufferLE(leveled), 'inworld')
}

function realtimePcmSourceRate(state, provider) {
  return Number(
    provider === 'xai'
      ? state.config.xaiOutputSampleRate
      : state.config.inworldOutputSampleRate,
  ) || Number(state.sampleRate) || 16000
}

function normalizedRealtimePcm(state, pcmLittleEndian, provider) {
  const sourceRate = realtimePcmSourceRate(state, provider)
  const aligned = pcmLittleEndian.length % 2
    ? pcmLittleEndian.subarray(0, pcmLittleEndian.length - 1)
    : pcmLittleEndian
  const samples = bufferToInt16LE(aligned)
  recordCallStageAudioSamples(state, {
    stage: `ai-${provider}-output`,
    samples,
    sampleRate: sourceRate,
  })
  trackAudioQualitySamples(state, 'humeOutput', samples)
  const target = resamplePcm16(samples, sourceRate, state.sampleRate)
  return levelPcm16ForPhone(target, {
    gain: state.config.phoneOutputGain,
    peakRatio: state.config.phoneOutputPeak,
  })
}

function sendRealtimePcmAudioToTelnyx(state, pcmLittleEndian, provider) {
  const leveled = normalizedRealtimePcm(state, pcmLittleEndian, provider)
  recordCallStageAudioSamples(state, {
    stage: 'ai-telnyx-output',
    samples: leveled,
    sampleRate: state.sampleRate,
  })
  trackAudioQualitySamples(state, 'telnyxOutput', leveled)
  recordCallAudioSamples(state, {
    source: 'ai',
    samples: leveled,
    sampleRate: state.sampleRate,
  })
  markPersonalPhoneOutboundConversationStarted(state, leveled)
  enqueueAssistantPcmToTelnyx(state, int16ToBufferLE(leveled))
}

function sendRealtimePcmAudioToBrowser(state, pcmLittleEndian, provider) {
  const leveled = normalizedRealtimePcm(state, pcmLittleEndian, provider)
  sendAssistantPcmToBrowser(state, int16ToBufferLE(leveled))
}

function sendRealtimePcmAudioToCallToolsGateway(state, pcmLittleEndian, provider) {
  if (state.calltoolsWs?.readyState !== WebSocket.OPEN) return
  const leveled = normalizedRealtimePcm(state, pcmLittleEndian, provider)
  sendPcmToCallToolsGateway(state, int16ToBufferLE(leveled), provider)
}

function sendPcmToCallToolsGateway(state, pcmLittleEndian, source) {
  if (state.calltoolsWs?.readyState !== WebSocket.OPEN) return
  const samples = bufferToInt16LE(pcmLittleEndian)
  const audioSource = source === 'human' ? 'operator' : 'ai'
  if (audioSource === 'ai') {
    recordCallStageAudioSamples(state, {
      stage: 'ai-calltools-output',
      samples,
      sampleRate: state.sampleRate,
    })
  }
  if (audioSource === 'ai') trackAudioQualitySamples(state, 'telnyxOutput', samples)
  recordCallAudioSamples(state, {
    source: audioSource,
    samples,
    sampleRate: state.sampleRate,
  })
  addTransportCounter(state, 'calltoolsMediaOutPackets')
  addTransportCounter(state, 'calltoolsMediaOutBytes', pcmLittleEndian.length)
  recordTransportMilestone(state, 'first_calltools_media_out', {
    source,
    sampleRate: state.sampleRate,
  })
  state.calltoolsWs.send(
    JSON.stringify({
      type: 'audio.output',
      callControlId: state.callControlId,
      streamId: state.streamId,
      audio: pcmLittleEndian.toString('base64'),
      sampleRate: state.sampleRate,
      source: audioSource,
    }),
  )
}

function sendHumanPcmToPhone(state, pcmLittleEndian) {
  if (isCallToolsGatewayCall(state)) {
    sendPcmToCallToolsGateway(state, pcmLittleEndian, 'human')
    return
  }
  sendPcmToTelnyx(state, pcmLittleEndian)
}

function sendPcmToTelnyx(state, pcmLittleEndian) {
  if (!state.telnyxWs || state.telnyxWs.readyState !== WebSocket.OPEN) return

  markPersonalPhoneOutboundConversationStarted(
    state,
    bufferToInt16LE(pcmLittleEndian),
  )

  const payload =
    normalizeAudioCodec(state.telnyxCodec) === 'PCMU'
      ? encodePcm16LeToUlaw(pcmLittleEndian)
      : pcmLittleEndian

  addTransportCounter(state, 'telnyxMediaOutPackets')
  addTransportCounter(state, 'telnyxMediaOutBytes', payload.length)
  addTransportCounter(state, 'telnyxPcmOutBytes', pcmLittleEndian.length)
  recordTransportMilestone(state, 'first_telnyx_media_out', {
    codec: state.telnyxCodec,
    sampleRate: state.sampleRate,
  })
  state.telnyxWs.send(
    JSON.stringify({
      event: 'media',
      media: {
        payload: payload.toString('base64'),
      },
    }),
  )
}

function enqueueAssistantPcmToTelnyx(state, pcmLittleEndian) {
  enqueuePcmToTelnyx(state, pcmLittleEndian, {
    onFrameSent: (frame, sampleRate) => {
      playgroundCallSupervision.publishAudio(
        state,
        'agent',
        frame,
        sampleRate,
      )
    },
  })
}

function clearTelnyxAudio(state) {
  clearTelnyxOutboundQueue(state, { sendClear: false })
  if (state?.telnyxWs?.readyState === WebSocket.OPEN) {
    addTransportCounter(state, 'telnyxClearMessages')
    state.telnyxWs.send(JSON.stringify({ event: 'clear' }))
  }
}

function clearCallToolsGatewayAudio(state, reason) {
  if (state?.calltoolsWs?.readyState !== WebSocket.OPEN) return
  addTransportCounter(state, 'calltoolsClearMessages')
  state.calltoolsWs.send(
    JSON.stringify({
      type: 'audio.clear',
      callControlId: state.callControlId,
      streamId: state.streamId,
      reason: safeLeadText(reason || 'clear'),
    }),
  )
}

function clearPhoneAssistantAudio(state, reason = 'operator_clear') {
  playgroundCallSupervision.clearAudio(state, 'agent', reason)
  if (isCallToolsGatewayCall(state)) {
    clearCallToolsGatewayAudio(state, reason)
    return
  }
  clearTelnyxAudio(state)
}

function clearQueuedAssistantAudio(state, reason) {
  const now = Date.now()
  if (
    state.lastAudioClearReason === reason &&
    state.lastAudioClearAt &&
    now - state.lastAudioClearAt < 900
  ) {
    return
  }
  state.lastAudioClearAt = now
  state.lastAudioClearReason = reason

  if (state.browserTest) {
    sendBrowserAudioClear(state, reason)
    return
  }

  clearPhoneAssistantAudio(state, reason)
}

function scheduleAssistantAudioWatchdog(
  state,
  assistantUtteranceCount,
) {
  if (assistantTurnHasAudio(state)) return
  const callControlId = state.callControlId
  setTimeout(() => {
    const current = getCallState(callControlId)
    if (
      !current ||
      current.ending ||
      isCallEnded(current) ||
      current.assistantUtteranceCount !== assistantUtteranceCount ||
      assistantTurnHasAudio(current)
    ) {
      return
    }

    emitCallEvent(callControlId, {
      diagnostic: buildTransportDiagnosticSnapshot(current),
      entry: transcriptEntry(
        'System',
        'Assistant text arrived without voice audio. Session remains live; waiting for the next turn.',
        'attention',
      ),
      notice: 'Assistant audio missing',
    })
  }, 1800)
}

function normalizeTranscriptContent(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function shouldDeferPlaygroundUserInput(state) {
  if (!state?.browserTest) return false
  if (!state.assistantResponseActive) return false
  if (state.ending || isCallEnded(state)) return false
  return true
}

function queuePlaygroundUserInput(state, text) {
  const content = normalizeTranscriptContent(text)
  if (!content) return
  state.pendingPlaygroundInputText = content
  schedulePendingPlaygroundUserInput(
    state,
    PLAYGROUND_PENDING_INPUT_RECHECK_MS,
    'playground_input_recheck',
  )
}

function schedulePendingPlaygroundUserInput(state, delayMs, reason) {
  if (!state?.pendingPlaygroundInputText) return
  if (state.pendingPlaygroundInputTimer) clearTimeout(state.pendingPlaygroundInputTimer)

  state.pendingPlaygroundInputTimer = setTimeout(() => {
    void sendPendingPlaygroundUserInput(state, reason).catch((error) =>
      emitPlaygroundUserInputFailure(state, error),
    )
  }, Math.max(0, Number(delayMs) || 0))
}

async function sendPendingPlaygroundUserInput(state, reason) {
  if (!state?.pendingPlaygroundInputText) return
  if (!isVoiceSessionOpen(state)) return
  if (state.assistantResponseActive && !state.ending && !isCallEnded(state)) {
    schedulePendingPlaygroundUserInput(
      state,
      PLAYGROUND_PENDING_INPUT_RECHECK_MS,
      'playground_input_waiting_for_assistant_end',
    )
    return
  }
  if (state.pendingPlaygroundInputTimer) {
    clearTimeout(state.pendingPlaygroundInputTimer)
    state.pendingPlaygroundInputTimer = null
  }

  const text = state.pendingPlaygroundInputText
  state.pendingPlaygroundInputText = ''
  await sendPlaygroundUserInputToVoiceProvider(state, text, reason)
}

function emitPlaygroundUserInputFailure(state, error) {
  if (!state) return
  emitCallEvent(state.callControlId, {
    diagnostic: buildTransportDiagnosticSnapshot(state),
    entry: transcriptEntry(
      'System',
      `Playground message delivery failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      'attention',
    ),
    notice: 'Playground message delivery failed',
  })
}

async function sendPlaygroundUserInputToVoiceProvider(
  state,
  text,
  reason = 'playground_input',
) {
  return sendVoiceUserInput(state, text, { reason })
}

async function sendVoiceUserInput(state, text, { reason = 'user_input' } = {}) {
  if (isXaiRuntime(state?.config || {})) {
    return sendXaiUserInput(state, text, { reason })
  }
  if (isInworldRuntime(state?.config || {})) {
    return sendInworldUserInput(state, text, { reason })
  }

  return sendHumeUserInput(state, text, { reason })
}

async function sendXaiUserInput(state, text, { reason = 'user_input' } = {}) {
  const content = normalizeTranscriptContent(text)
  if (!content) return false
  if (!state?.xaiWs || state.xaiWs.readyState !== WebSocket.OPEN) return false
  state.syntheticUserInputs.add(content)
  state.xaiWs.send(
    JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: content }],
      },
    }),
  )
  state.xaiWs.send(JSON.stringify({ type: 'response.create' }))
  recordTransportMilestone(state, 'xai_user_input_sent', {
    reason,
    transport: 'websocket',
  })
  return true
}

async function sendInworldUserInput(state, text, { reason = 'user_input' } = {}) {
  const content = normalizeTranscriptContent(text)
  if (!content) return false
  if (!state?.inworldWs || state.inworldWs.readyState !== WebSocket.OPEN) return false

  state.lastInworldUserInputText = content
  state.lastInworldUserInputReason = reason
  state.syntheticUserInputs.add(content)
  state.inworldWs.send(
    JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: content }],
      },
    }),
  )
  state.inworldWs.send(
    JSON.stringify({
      type: 'response.create',
      response: { output_modalities: ['audio', 'text'] },
    }),
  )
  recordTransportMilestone(state, 'inworld_user_input_sent', {
    reason,
    transport: 'websocket',
  })
  return true
}

function recoverInworldToolPlanRestriction(state, text = '') {
  if (!inworldToolPlanRestriction(text)) return false
  if (state.inworldToolsDisabledByProvider) return false

  state.inworldToolsDisabledByProvider = true
  setTransportDiagnosticValue(state, 'inworld', 'toolsDisabledReason', 'provider_plan_restriction')
  recordTransportMilestone(state, 'inworld_tools_disabled', {
    reason: 'provider_plan_restriction',
  })
  emitCallEvent(state.callControlId, {
    diagnostic: buildTransportDiagnosticSnapshot(state),
    entry: transcriptEntry(
      'System',
      'Inworld tool calling is restricted for this account; continuing this voice session without provider tools.',
      'attention',
    ),
    notice: 'Inworld tools disabled',
  })

  setTimeout(() => {
    if (!state?.inworldWs || state.inworldWs.readyState !== WebSocket.OPEN) return
    if (state.ending || isCallEnded(state)) return
    sendInworldSessionUpdate(state, { includeTools: false })
    if (!state.lastInworldUserInputText || state.inworldRecoveryResponseRequested) return
    state.inworldRecoveryResponseRequested = true
    state.inworldWs.send(
      JSON.stringify({
        type: 'response.create',
        response: { output_modalities: ['audio', 'text'] },
      }),
    )
    recordTransportMilestone(state, 'inworld_recovery_response_requested', {
      reason: 'tool_calling_restricted',
      source: state.lastInworldUserInputReason || 'user_input',
    })
    emitCallEvent(state.callControlId, {
      diagnostic: buildTransportDiagnosticSnapshot(state),
      entry: transcriptEntry(
        'System',
        'Inworld response retried without provider tools.',
        'system',
      ),
      notice: 'Inworld response retried',
    })
  }, 150)

  return true
}

function inworldToolPlanRestriction(text = '') {
  return /tool calling .*restricted|tool calling .*plan|tool.*restricted on your plan/i.test(
    safeLeadText(text),
  )
}

function recoverInworldModelPlanRestriction(state, text = '') {
  if (!inworldModelPlanRestriction(text)) return false
  if (state.inworldModelFallbackApplied) return false

  const fallbackModel = inworldFallbackRealtimeModel(state)
  const currentModel = safeLeadText(
    state.config?.inworldRealtimeModel ||
      state.config?.languageModelResource ||
      DEFAULT_INWORLD_REALTIME_MODEL,
  )
  if (!fallbackModel || fallbackModel === currentModel) return false

  state.inworldModelFallbackApplied = true
  state.inworldModelFallbackFrom = currentModel
  state.config = {
    ...state.config,
    languageModelMode: 'inworld',
    languageModelProvider: 'INWORLD',
    languageModelResource: fallbackModel,
    inworldRealtimeModel: fallbackModel,
  }
  setTransportDiagnosticValue(state, 'inworld', 'requestedModel', fallbackModel)
  setTransportDiagnosticValue(state, 'inworld', 'modelFallbackFrom', currentModel)
  setTransportDiagnosticValue(state, 'inworld', 'modelFallbackReason', 'provider_plan_restriction')
  recordTransportMilestone(state, 'inworld_model_fallback', {
    from: currentModel,
    to: fallbackModel,
    reason: 'provider_plan_restriction',
  })
  emitCallEvent(state.callControlId, {
    diagnostic: buildTransportDiagnosticSnapshot(state),
    entry: transcriptEntry(
      'System',
      'Inworld selected model is unavailable for this account; continuing this voice session with the configured native fallback model.',
      'attention',
    ),
    notice: 'Inworld model fallback',
  })

  setTimeout(() => {
    if (!state?.inworldWs || state.inworldWs.readyState !== WebSocket.OPEN) return
    if (state.ending || isCallEnded(state)) return
    void (async () => {
      try {
        state.config = await ensureInworldRuntimeConfigReady(state.config, {
          allowStale: true,
        })
      } catch (error) {
        recordTransportMilestone(state, 'inworld_model_fallback_validation_failed', {
          reason: error?.code || 'inworld_fallback_model_not_ready',
        })
        emitCallEvent(state.callControlId, {
          diagnostic: buildTransportDiagnosticSnapshot(state),
          entry: transcriptEntry(
            'System',
            'Inworld fallback model is not compatible with the required Speak tools.',
            'attention',
          ),
          notice: 'Inworld model fallback unavailable',
        })
        return
      }
      if (!state?.inworldWs || state.inworldWs.readyState !== WebSocket.OPEN) return
      if (state.ending || isCallEnded(state)) return
      sendInworldSessionUpdate(state)
      if (!state.lastInworldUserInputText || state.inworldModelFallbackResponseRequested) return
      state.inworldModelFallbackResponseRequested = true
      state.inworldWs.send(
        JSON.stringify({
          type: 'response.create',
          response: { output_modalities: ['audio', 'text'] },
        }),
      )
      recordTransportMilestone(state, 'inworld_model_fallback_response_requested', {
        source: state.lastInworldUserInputReason || 'user_input',
      })
      emitCallEvent(state.callControlId, {
        diagnostic: buildTransportDiagnosticSnapshot(state),
        entry: transcriptEntry(
          'System',
          'Inworld response retried with the native fallback model and shared tools.',
          'system',
        ),
        notice: 'Inworld model fallback retried',
      })
    })()
  }, 150)

  return true
}

function inworldModelPlanRestriction(text = '') {
  return /model .*not available.*plan|model .*currently not available|not available on your plan/i.test(
    safeLeadText(text),
  )
}

function inworldFallbackRealtimeModel(state) {
  return safeLeadText(
    state.config?.inworldFallbackRealtimeModel ||
      process.env.INWORLD_FALLBACK_REALTIME_MODEL ||
      DEFAULT_INWORLD_REALTIME_MODEL,
  )
}

function inworldVoiceId(state) {
  const provider = safeLeadText(state.config?.inworldVoiceProvider).toUpperCase()
  const genericVoice = safeLeadText(state.config?.voice)
  if (provider === 'INWORLD_CUSTOM' && genericVoice) return genericVoice

  const explicit =
    state.config?.inworldVoiceId ||
    state.config?.inworldVoiceName ||
    state.config?.speakVoiceName
  if (explicit) return safeLeadText(explicit)
  if (genericVoice && !looksLikeUuid(genericVoice)) return genericVoice
  return process.env.INWORLD_VOICE_ID || DEFAULT_INWORLD_VOICE
}

function looksLikeUuid(value = '') {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    safeLeadText(value),
  )
}

async function sendHumeUserInput(state, text, { reason = 'user_input' } = {}) {
  const content = normalizeTranscriptContent(text)
  if (!content) return false
  const transport = selectHumeUserInputTransport({
    webSocketOpen: state?.humeWs?.readyState === WebSocket.OPEN,
    chatId: state?.chatId,
  })
  if (!transport) return false

  state.syntheticUserInputs.add(content)

  if (transport === 'websocket') {
    state.humeWs.send(JSON.stringify({ type: 'user_input', text: content }))
    recordTransportMilestone(state, 'hume_user_input_sent', {
      reason,
      transport,
    })
    return true
  }

  await sendHumeControl(state.chatId, {
    type: 'user_input',
    text: content,
  })
  recordTransportMilestone(state, 'hume_user_input_sent', {
    reason,
    transport,
  })
  return true
}

async function sendPlaygroundBargeInInput(state, text) {
  const content = normalizeTranscriptContent(text)
  if (!content || !state?.chatId) return

  await pauseVoiceAssistant(state)
  clearQueuedAssistantAudio(state, 'playground_text_input')
  state.assistantResponseActive = false
  await sendVoiceUserInput(state, content, { reason: 'paused_assistant' })
  await resumeVoiceAssistant(state)
  recordTransportMilestone(state, 'playground_assistant_resumed', {
    reason: 'playground_text_input',
  })
}

function clearAssistantResponseIdleGuard(state) {
  if (!state?.assistantIdleTimer) return
  clearTimeout(state.assistantIdleTimer)
  state.assistantIdleTimer = null
}

function scheduleAssistantResponseIdleGuard(state, reason) {
  if (!state || state.ending || isCallEnded(state)) return
  clearAssistantResponseIdleGuard(state)
  state.assistantIdleTimer = setTimeout(() => {
    const current = getCallState(state.callControlId)
    if (!current || current.ending || isCallEnded(current)) return
    if (!current.assistantResponseActive) return

    const latestAssistantAt = Math.max(
      Number(current.lastAssistantAudioAt || 0),
      Number(current.lastAssistantMessageAt || 0),
    )
    const elapsed = latestAssistantAt ? Date.now() - latestAssistantAt : 0
    if (latestAssistantAt && elapsed < ASSISTANT_RESPONSE_IDLE_MS) {
      scheduleAssistantResponseIdleGuard(current, reason)
      return
    }

    current.assistantResponseActive = false
    current.assistantIdleTimer = null
    recordTransportMilestone(current, 'assistant_response_idle_timeout', {
      reason,
      idleMs: Math.max(0, elapsed),
    })
    void sendPendingPlaygroundUserInput(
      current,
      'assistant_response_idle_timeout',
    ).catch((error) => emitPlaygroundUserInputFailure(current, error))
  }, Math.max(250, ASSISTANT_RESPONSE_IDLE_MS))
  state.assistantIdleTimer.unref?.()
}

function sendBrowserAudioClear(state, reason) {
  clearBrowserAudioBeforeAttach(state)
  if (state.browserWs?.readyState !== WebSocket.OPEN) return

  addTransportCounter(state, 'browserAudioClears')
  state.browserWs.send(
    JSON.stringify({
      type: 'audio_clear',
      reason,
    }),
  )
}

function sendTelnyxMark(state, name) {
  if (state?.telnyxWs?.readyState === WebSocket.OPEN) {
    addTransportCounter(state, 'telnyxMarksSent')
    state.telnyxWs.send(
      JSON.stringify({
        event: 'mark',
        mark: { name },
      }),
    )
  }
}

function sendPhonePlaybackMark(state, name) {
  if (isCallToolsGatewayCall(state)) {
    if (state?.calltoolsWs?.readyState !== WebSocket.OPEN) return
    addTransportCounter(state, 'calltoolsMarksSent')
      state.calltoolsWs.send(
      JSON.stringify({
        type: 'mark',
        callControlId: state.callControlId,
        streamId: state.streamId,
        name,
      }),
    )
    return
  }
  sendTelnyxMark(state, name)
}

function requestCallToolsGatewayHangup(state, outcome, reason = 'hangup') {
  if (state?.calltoolsWs?.readyState !== WebSocket.OPEN) return false
  addTransportCounter(state, 'calltoolsHangupRequests')
  state.calltoolsWs.send(
    JSON.stringify({
      type: 'call.end',
      callControlId: state.callControlId,
      streamId: state.streamId,
      outcome,
      reason,
    }),
  )
  return true
}

function isCallToolsGatewayCall(state) {
  if (state?.calltoolsStandby === true) return false
  return (
    state?.callProvider === 'calltools' ||
    Boolean(state?.calltoolsWs)
  )
}

function callToolsFirstTurnGatePending(state) {
  return Boolean(
    isCallToolsGatewayCall(state) &&
      state.calltoolsFirstTurnGate?.status === 'pending',
  )
}

function callToolsFirstTurnAutoResponseEnabled(state) {
  if (!isCallToolsGatewayCall(state)) return true
  return state.calltoolsFirstTurnGate?.providerPaused !== true
}

function recordSuppressedCallToolsAssistantOutput(state, provider, kind) {
  if (!shouldSuppressCallToolsAssistantOutput(state?.calltoolsFirstTurnGate)) return false
  addTransportCounter(state, 'calltoolsFirstTurnOutputsSuppressed')
  pauseCallToolsFirstTurnProvider(state, provider, 'unverified_assistant_output')
  if (!state.calltoolsFirstTurnSuppressionRecorded) {
    state.calltoolsFirstTurnSuppressionRecorded = true
    recordTransportMilestone(state, 'calltools_first_turn_output_suppressed', {
      provider,
      kind,
    })
  }
  return true
}

function armCallToolsFirstTurnGate(state, provider) {
  if (!callToolsFirstTurnGatePending(state)) return false
  recordTransportMilestone(state, 'calltools_first_turn_gate_armed', {
    provider,
    mode: 'output_only',
  })
  return true
}

function pauseCallToolsFirstTurnProvider(state, provider, reason) {
  if (!callToolsFirstTurnGatePending(state)) return false
  if (state.calltoolsFirstTurnGate?.providerPaused === true) return false

  state.calltoolsFirstTurnGate = {
    ...state.calltoolsFirstTurnGate,
    providerPaused: true,
  }
  if (provider === 'hume' && state.humeWs?.readyState === WebSocket.OPEN) {
    state.humeWs.send(JSON.stringify({ type: 'pause_assistant_message' }))
  } else if (provider === 'inworld' && state.inworldWs?.readyState === WebSocket.OPEN) {
    cancelInworldResponse(state, { clearInput: false })
    sendInworldSessionUpdate(state, { includeTools: true })
  } else if (provider === 'xai' && state.xaiWs?.readyState === WebSocket.OPEN) {
    cancelXaiResponse(state, { clearInput: false })
    sendXaiSessionUpdate(state, { includeTools: true })
  }
  recordTransportMilestone(state, 'calltools_first_turn_provider_paused', {
    provider,
    reason,
  })
  return true
}

function resumeCallToolsFirstTurnProvider(state, provider) {
  if (state.calltoolsFirstTurnGate?.providerPaused !== true) return false

  state.calltoolsFirstTurnGate = {
    ...state.calltoolsFirstTurnGate,
    providerPaused: false,
  }
  if (provider === 'hume' && state.humeWs?.readyState === WebSocket.OPEN) {
    state.humeWs.send(JSON.stringify({ type: 'resume_assistant_message' }))
  } else if (provider === 'inworld' && state.inworldWs?.readyState === WebSocket.OPEN) {
    sendInworldSessionUpdate(state, { includeTools: true })
    state.inworldWs.send(
      JSON.stringify({
        type: 'response.create',
        response: { output_modalities: ['audio', 'text'] },
      }),
    )
  } else if (provider === 'xai' && state.xaiWs?.readyState === WebSocket.OPEN) {
    sendXaiSessionUpdate(state, { includeTools: true })
    state.xaiWs.send(JSON.stringify({ type: 'response.create' }))
  }
  return true
}

function applyCallToolsFirstTurnTranscript(state, content, provider) {
  if (!callToolsFirstTurnGatePending(state)) return { action: 'none' }
  const decision = advanceCallToolsFirstTurnGate(
    state.calltoolsFirstTurnGate,
    content,
  )
  state.calltoolsFirstTurnGate = decision.gate
  recordTransportMilestone(state, 'calltools_first_turn_classified', {
    provider,
    action: decision.action,
    reason: decision.gate.reason,
    heldTurnCount: decision.gate.heldTurnCount,
  })

  if (decision.action === 'resume') {
    const providerResumeRequired = resumeCallToolsFirstTurnProvider(state, provider)
    recordTransportMilestone(state, 'calltools_first_turn_response_resumed', {
      provider,
      providerResumeRequired,
    })
  }

  if (decision.action === 'hold') {
    pauseCallToolsFirstTurnProvider(state, provider, decision.gate.reason)
  }

  if (decision.action === 'end') {
    const outcomeEvent = setCallOutcome(state, decision.outcome || 'voicemail')
    if (outcomeEvent) emitCallEvent(state.callControlId, outcomeEvent)
    void endCallForOutcome(state, decision.outcome || 'voicemail')
  }

  return decision
}

async function pauseVoiceAssistant(state) {
  if (isXaiRuntime(state?.config || {})) {
    cancelXaiResponse(state, { clearInput: false })
    return
  }
  if (isInworldRuntime(state?.config || {})) {
    cancelInworldResponse(state, { clearInput: false })
    return
  }

  if (!state?.chatId) throw new Error('Speak voice session is not attached yet')
  await sendHumeControl(state.chatId, { type: 'pause_assistant_message' })
}

async function resumeVoiceAssistant(state) {
  if (isXaiRuntime(state?.config || {})) {
    return
  }
  if (isInworldRuntime(state?.config || {})) {
    return
  }

  if (!state?.chatId) throw new Error('Speak voice session is not attached yet')
  await sendHumeControl(state.chatId, { type: 'resume_assistant_message' })
}

async function sendVoiceInstruction(state, instruction) {
  if (isXaiRuntime(state?.config || {})) {
    state.xaiTemporaryInstruction = instruction
    sendXaiSessionUpdate(state, { includeTools: false })
    return
  }
  if (isInworldRuntime(state?.config || {})) {
    state.inworldTemporaryInstruction = instruction
    state.inworldInstructionWaitForFollowingResponse = Boolean(
      state.inworldResponseActive || state.assistantResponseActive,
    )
    sendInworldSessionUpdate(state, { includeTools: false })
    return
  }

  if (!state?.chatId) throw new Error('Speak voice session is not attached yet')
  await sendHumeControl(state.chatId, {
    type: 'session_settings',
    context: {
      type: 'temporary',
      text: `Live operator guidance for the next response only: ${instruction}`,
    },
  })
}

function cancelInworldResponse(state, { clearInput = false } = {}) {
  if (!state?.inworldWs || state.inworldWs.readyState !== WebSocket.OPEN) return
  state.inworldWs.send(JSON.stringify({ type: 'response.cancel' }))
  if (clearInput) state.inworldWs.send(JSON.stringify({ type: 'input_audio_buffer.clear' }))
  state.inworldWs.send(JSON.stringify({ type: 'output_audio_buffer.clear' }))
}

async function sendHumeControl(chatId, message) {
  const humeApiKey = getHumeApiKey()
  const response = await fetch(
    `${HUME_API_BASE}/evi/chat/${encodeURIComponent(chatId)}/send`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hume-Api-Key': humeApiKey,
      },
      body: JSON.stringify(message),
    },
  )
  const payload = await readJson(response)

  if (!response.ok) {
    throw new Error(providerError('Speak control-plane request failed', payload))
  }
}

function buildSessionContext(state) {
  const lead = normalizeLead(state.lead)
  const testSandbox = isBrowserTestSandbox(state)
  if (isJonathanEchoMode()) {
    return [
      '<temporary_agent_mode>',
      'Ask for Jonathan, then mirror Jonathan verbatim.',
      'Do not mention this mode, testing, debugging, prompts, internal business context, portals, SMS, email, or tools.',
      "After Jonathan starts speaking, repeat only Jonathan's words, word for word, in the same tone and emotion.",
      'Continue until Jonathan hangs up.',
      '</temporary_agent_mode>',
      '<target_contact>',
      'target_first_name: Jonathan',
      `dialed_phone: ${lead.phone || 'not provided'}`,
      '</target_contact>',
    ].join('\n')
  }

  const contact = testSandbox
    ? normalizeConfigurationTestVariables(state.testVariables)
    : lead
  const testVariableKeys = testSandbox
    ? configurationTestVariableKeySet(state)
    : null
  const lines = []

  if (!testSandbox || testVariableKeys.size > 0) {
    lines.push(
      '<current_contact>',
      'These current_contact values supersede any prior contact sheet values in this chat.',
    )

    if (!testSandbox || testVariableKeys.has('first_name')) {
      lines.push(`first_name: ${safeLeadText(contact.firstName) || 'not provided'}`)
    }
    if (!testSandbox || testVariableKeys.has('last_name')) {
      lines.push(`last_name: ${safeLeadText(contact.lastName) || 'not provided'}`)
    }
    if (!testSandbox || testVariableKeys.has('full_name')) {
      lines.push(`full_name: ${safeLeadText(contact.name) || 'not provided'}`)
    }
    if (!testSandbox || testVariableKeys.has('business_name')) {
      lines.push(`organization: ${safeLeadText(contact.company) || 'not provided'}`)
    }
    if (!testSandbox || testVariableKeys.has('contact_phone')) {
      lines.push(`phone_on_file: ${contact.phone || 'not provided'}`)
    }
    if (!testSandbox || testVariableKeys.has('contact_email')) {
      lines.push(`email_on_file: ${contact.email || 'not provided'}`)
    }
    if ((!testSandbox || testVariableKeys.has('notes')) && contact.notes) {
      lines.push(`notes: ${contact.notes}`)
    }
    lines.push('</current_contact>')
  }

  const runtimeContext = renderRuntimeContext({
    leadContext: lead.context,
    profileContext: state.config?.profileContext,
    legacyNotes: lead.notes,
    conversationMemory: buildContactConversationMemory(state),
  })
  if (runtimeContext) lines.push(runtimeContext)

  lines.push(
    '<conversation_style>',
    'Use the active agent instructions as context and guardrails, not as a verbatim script. Paraphrase naturally, keep turns short, and adapt to the person instead of reading lines in order. Preserve required facts, flow, verification, and tool-use rules from the active instructions. Short answers must still answer the caller or move the conversation forward; do not use repeated one-word acknowledgements as full turns.',
    '</conversation_style>',
  )

  if (
    !testSandbox ||
    testVariableKeys?.has('contact_phone') ||
    testVariableKeys?.has('contact_email')
  ) {
    lines.push(
      '<messaging_rule>',
      'The phone and email above are only context. Verify the exact destination before any text or email. If the destination differs from the contact sheet, call update_contact first. Use send_text_message for text messages and send_email for email. Do not say a message was sent unless the relevant send tool returns provider proof.',
      '</messaging_rule>',
    )
  }

  if (
    !testSandbox ||
    testVariableKeys?.has('first_name') ||
    testVariableKeys?.has('last_name') ||
    testVariableKeys?.has('full_name')
  ) {
    lines.push(
      '<placeholder_rule>',
      'Never say placeholder words such as contact name, unknown, not provided, syntax, brackets, or variable names. If a name is missing or wrong, ask naturally who you are speaking with, then call update_caller_identity and use the corrected name.',
      '</placeholder_rule>',
    )
  }

  if (testSandbox) {
    lines.push(
      '<configuration_test_context>',
      testVariableKeys.size > 0
        ? 'This is a Speak Playground browser test. Treat blank listed current_contact values as missing. Do not invent or reuse contact identity values outside current_contact.'
        : 'This is a Speak Playground browser test. The active prompt does not reference runtime contact variables, so no test contact variables were supplied.',
      '</configuration_test_context>',
    )
  }

  if (state.operatorInstructions?.length) {
    lines.push(
      '<operator_instructions>',
      'The operator provided these instructions before this call. Treat them as high-priority steering context for this call, but do not quote this block aloud.',
      ...state.operatorInstructions.map((instruction) => `- ${instruction}`),
      '</operator_instructions>',
    )
  }

  if (isInworldRuntime(state.config) && !inworldSessionToolsEnabled(state)) {
    lines.push(
      '<tool_availability>',
      'Inworld provider tool calling is unavailable for this session. Do not claim SMS, email, contact updates, portal-link sends, or hangups succeeded through tools. Ask the operator to handle those actions when needed.',
      '</tool_availability>',
    )
  }

  return lines.join('\n')
}

function inworldSessionToolsEnabled(state) {
  if (!state || state.inworldToolsDisabledByProvider) return false
  if (state.config?.inworldToolCallingEnabled === false) return false
  return Boolean(state.config?.inworldToolCallingEnabled)
}

function isJonathanEchoMode() {
  return TEMP_AGENT_MODE === JONATHAN_ECHO_MODE
}

function temporaryAgentSystemPrompt() {
  return isJonathanEchoMode() ? JONATHAN_ECHO_SYSTEM_PROMPT : ''
}

function updateStateLead(state, patch) {
  applyStateLead(state, {
    ...state.lead,
    ...patch,
  })
  if (!isBrowserTestSandbox(state)) {
    persistWorkspaceLeadPatch(state, state.lead)
  }
}

function applyStateLead(state, lead) {
  state.lead = normalizeLead(lead)
  emitCallEvent(state.callControlId, {
    leadPatch: {
      leadId: state.lead.id,
      patch: state.lead,
    },
  })
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function minimumTelnyxHangupAnchorMs(state) {
  const parsed = Date.parse(state?.answeredAt || state?.createdAt || '')
  return Number.isFinite(parsed) ? parsed : Date.now()
}

function minimumTelnyxHangupAt(state) {
  if (!state || state.browserTest) return null
  return new Date(
    minimumTelnyxHangupAnchorMs(state) + TELNYX_MIN_HANGUP_DURATION_MS,
  ).toISOString()
}

function remainingMinimumTelnyxHangupMs(state) {
  if (!state || state.browserTest) return 0
  return Math.max(
    0,
    minimumTelnyxHangupAnchorMs(state) +
      TELNYX_MIN_HANGUP_DURATION_MS -
      Date.now(),
  )
}

async function waitForMinimumTelnyxHangupDuration(state, source) {
  if (!state || state.browserTest) {
    return { alreadyEnded: Boolean(state && isCallEnded(state)), waitedMs: 0 }
  }

  let waitedMs = 0
  while (!isCallEnded(state)) {
    const remainingMs = remainingMinimumTelnyxHangupMs(state)
    if (remainingMs <= 0) {
      state.minimumHangupAt = minimumTelnyxHangupAt(state)
      return {
        alreadyEnded: false,
        waitedMs,
        minimumHangupAt: state.minimumHangupAt,
      }
    }

    const nextMinimumHangupAt = minimumTelnyxHangupAt(state)
    state.minimumHangupAt = nextMinimumHangupAt
    if (state.minimumHangupNoticeAt !== nextMinimumHangupAt) {
      state.minimumHangupNoticeAt = nextMinimumHangupAt
      emitCallEvent(state.callControlId, {
        patch: { minimumHangupAt: nextMinimumHangupAt },
        entry: transcriptEntry(
          'System',
          `Holding ${source} for ${Math.ceil(
            remainingMs / 1000,
          )}s to satisfy the phone 10-second minimum duration.`,
          'system',
        ),
        notice: 'Waiting for phone minimum duration',
      })
    }

    const startedAt = Date.now()
    await wait(Math.min(remainingMs, HANGUP_WAIT_TICK_MS))
    waitedMs += Date.now() - startedAt
  }

  return {
    alreadyEnded: true,
    waitedMs,
    minimumHangupAt: state.minimumHangupAt || minimumTelnyxHangupAt(state),
  }
}

async function hangupPhoneProviderCall(state, callControlId) {
  if (state?.personalPhoneInboundCorrelationId) {
    personalPhoneInboundHandoffs.markTerminal(
      state.personalPhoneInboundCorrelationId,
      'agent_hangup',
      'agent_hangup',
    )
    state.telnyxWs?.close(1000, 'Agent ended call')
    return {
      response: { ok: true, status: 200 },
      payload: {
        data: {
          result: 'personal_phone_stream_closed',
        },
      },
    }
  }

  const response = await fetch(
    `${TELNYX_API_BASE}/calls/${encodeURIComponent(callControlId)}/actions/hangup`,
    {
      method: 'POST',
      headers: telnyxHeaders(),
      body: JSON.stringify({}),
    },
  )
  return { response, payload: await readJson(response) }
}

async function endCallForOutcome(state, outcome) {
  if (!state || state.ending) return
  state.ending = true
  state.hangupRequestedAt = new Date().toISOString()
  const finalOutcome = normalizeCallOutcome(outcome) || state.outcome || 'completed'

  if (state.browserTest) {
    endBrowserTestForOutcome(state, finalOutcome)
    return
  }

  emitCallEvent(state.callControlId, {
    entry: transcriptEntry(
      'System',
      `Ending call after ${statusForOutcome(
        finalOutcome,
      )} disposition once the phone minimum duration is met.`,
      'system',
    ),
    notice: 'Auto-ending call',
  })

  try {
    const waitResult = await waitForMinimumTelnyxHangupDuration(
      state,
      'automatic hangup',
    )
    if (waitResult.alreadyEnded || isCallEnded(state)) return
    clearPhoneAssistantAudio(state, 'automatic_hangup')
    if (isCallToolsGatewayCall(state)) {
      if (!requestCallToolsGatewayHangup(state, finalOutcome)) {
        emitCallEvent(state.callControlId, {
          entry: transcriptEntry(
            'System',
            'Auto hangup failed: CallTools media gateway is not attached.',
            'attention',
          ),
          notice: 'Auto hangup failed',
        })
        state.ending = false
      }
      return
    }
    const { response: telnyxResponse, payload } =
      await hangupPhoneProviderCall(state, state.callControlId)
    if (!telnyxResponse.ok) {
      emitCallEvent(state.callControlId, {
        entry: transcriptEntry(
          'System',
          providerError('Auto hangup failed', payload),
          'attention',
        ),
        notice: 'Auto hangup failed',
      })
      state.ending = false
      return
    }
  } catch (error) {
    emitCallEvent(state.callControlId, {
      entry: transcriptEntry(
        'System',
        `Auto hangup failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        'attention',
      ),
      notice: 'Auto hangup failed',
    })
    state.ending = false
    return
  }

  if (state.personalPhoneInboundCorrelationId) {
    personalPhoneInboundHandoffs.markTerminal(
      state.personalPhoneInboundCorrelationId,
      'agent_hangup',
      'agent_hangup',
    )
  }
  closeCallSockets(state)
  persistCallOutcome(state, state.outcome || finalOutcome)
  emitCallEvent(state.callControlId, {
    patch: { phase: 'ended', takeover: false, outcome: state.outcome || finalOutcome },
    entry: transcriptEntry('System', 'Call ended automatically.', 'system'),
    notice: 'Call ended',
  })
}

function endBrowserTestForOutcome(state, outcome) {
  const finalOutcome = normalizeCallOutcome(outcome) || state.outcome || 'completed'
  const outcomeEvent = setCallOutcome(
    state,
    finalOutcome,
    'Speak hang_up ended the Playground test',
  )
  if (outcomeEvent) emitCallEvent(state.callControlId, outcomeEvent)

  closeCallSockets(state)
  persistCallOutcome(state, state.outcome || finalOutcome)
  emitCallEvent(state.callControlId, {
    patch: {
      phase: 'ended',
      takeover: false,
      outcome: state.outcome || finalOutcome,
    },
    entry: transcriptEntry(
      'System',
      'Playground test ended automatically by assistant hangup.',
      'system',
    ),
    notice: 'Playground test ended',
  })
}

function findCallSummary(callControlId) {
  return collectRecentCallSummaries({
    callStates: Array.from(calls.values()),
    callLogDir,
    limit: 500,
    leadForState: publicLeadContext,
  }).find((summary) => summary.callControlId === callControlId)
}

function isBrowserConfigTestSummary(summary) {
  return (
    String(summary?.callControlId || '').startsWith('test-') ||
    String(summary?.lead?.id || '').startsWith('test-')
  )
}

function isPlaygroundTestSummary(summary) {
  return (
    isBrowserConfigTestSummary(summary) ||
    summary?.origin === 'playground_browser' ||
    summary?.origin === 'playground_phone'
  )
}

function configTestMatchesProfile(summary, profileId, profileName) {
  if (!profileId && !profileName) return true

  const agent = summary?.agent || {}
  const agentId = String(agent.id || '').trim()
  const agentName = String(agent.name || '').trim().toLowerCase()
  if (profileId && agentId === profileId) return true
  if (profileName && agentName === profileName) return true
  return false
}

async function fetchHumeAudioReconstruction(chatId) {
  const humeApiKey = getHumeApiKey()
  const humeResponse = await fetch(
    `${HUME_API_BASE}/evi/chats/${encodeURIComponent(chatId)}/audio`,
    {
      headers: {
        Accept: 'application/json',
        'X-Hume-Api-Key': humeApiKey,
      },
    },
  )
  const payload = await readJson(humeResponse)

  if (!humeResponse.ok) {
    throw new Error(providerError('Speak audio reconstruction failed', payload))
  }

  const providerStatus = String(payload.status || '').toLowerCase()
  if (providerStatus === 'complete' && payload.signed_audio_url) {
    return {
      status: 'ready',
      source: 'hume',
      contentType: 'audio/mp4',
      url: payload.signed_audio_url,
      expiresAt: payload.signed_url_expiration_timestamp_millis
        ? new Date(payload.signed_url_expiration_timestamp_millis).toISOString()
        : undefined,
    }
  }

  return {
    status: providerStatus || 'queued',
    source: 'hume',
    providerStatus: payload.status || null,
    message:
      providerStatus === 'error'
        ? 'Speak could not reconstruct this call audio.'
        : 'Speak is preparing reconstructed call audio.',
  }
}

function publicSpeakPayload(value, rawText = false) {
  if (Array.isArray(value)) return value.map((item) => publicSpeakPayload(item, rawText))
  if (typeof value === 'string') return rawText ? value : publicSpeakString(value)
  if (!value || typeof value !== 'object') return value

  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => [
      publicSpeakKey(key),
      publicSpeakPayload(nestedValue, rawText || isRawContextPayloadKey(key)),
    ]),
  )
}

function buildContactConversationMemory(state, { limit = 3 } = {}) {
  if (!state?.lead) return []
  if (Array.isArray(state.contactConversationMemory) && state.contactConversationMemory.length) {
    return state.contactConversationMemory.slice(0, Math.max(0, Number(limit) || 0))
  }

  const currentLead = normalizeLead(state.lead)
  const summaries = collectRecentCallSummaries({
    callStates: Array.from(calls.values()),
    callLogDir,
    limit: 120,
    leadForState: publicLeadContext,
  })

  return summaries
    .filter((summary) => summary.callControlId !== state.callControlId)
    .filter((summary) => callSummaryMatchesLead(summary, currentLead))
    .slice(0, Math.max(0, Number(limit) || 0))
    .map((summary) => ({
      callControlId: summary.callControlId,
      chatId: summary.chatId || '',
      date: summary.updatedAt || summary.createdAt || '',
      agent: safeLeadText(summary.agent?.name || summary.agent?.id),
      outcome: safeLeadText(summary.outcome || summary.phase),
      insight: safeLeadText(summary.insight),
      turns: (Array.isArray(summary.transcript) ? summary.transcript : [])
        .slice(-6)
        .map((turn) => ({
          speaker: safeLeadText(turn.speaker),
          at: safeLeadText(turn.at),
          text: safeLeadText(turn.text),
        }))
        .filter((turn) => turn.text),
    }))
}

function callSummaryMatchesLead(summary, lead) {
  const summaryLead = summary?.lead || {}
  const left = leadIdentityTokens(summaryLead)
  const right = leadIdentityTokens(lead)
  if (!left.length || !right.length) return false

  const rightSet = new Set(right)
  return left.some((token) => rightSet.has(token))
}

function leadIdentityTokens(lead) {
  const source = lead && typeof lead === 'object' ? lead : {}
  const phone = String(
    source.phone ||
      source.contact_phone ||
      source.phone_on_file ||
      source.called_phone ||
      '',
  )
    .replace(/\D/g, '')
    .replace(/^1(?=\d{10}$)/, '')
  const email = String(source.email || source.contact_email || source.email_on_file || '')
    .trim()
    .toLowerCase()
  const id = String(source.id || source.leadId || '').trim()
  const business = normalizeIdentityToken(
    source.company || source.business_name || source.organization || '',
  )
  const name = normalizeIdentityToken(
    source.name ||
      source.full_name ||
      [source.firstName || source.first_name, source.lastName || source.last_name]
        .filter(Boolean)
        .join(' '),
  )

  return [
    id ? `id:${id}` : '',
    phone ? `phone:${phone}` : '',
    email ? `email:${email}` : '',
    business ? `business:${business}` : '',
    name ? `name:${name}` : '',
  ].filter(Boolean)
}

function normalizeIdentityToken(value) {
  const text = String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  if (/^importedlead\d*$/.test(text) || /^unknown(contact|lead)?$/.test(text)) return ''
  return text
}

function isRawContextPayloadKey(key) {
  return [
    'context',
    'profileContext',
    'leadContext',
    'agentContext',
    'lead_context',
    'agent_context',
    'text',
    'urls',
    'urlSnapshots',
    'url_snapshots',
    'files',
    'preview',
    'extractedText',
    'content',
    'conversation_memory',
    'legacy_notes',
  ].includes(String(key || ''))
}

function normalizeCallDeleteIds(value) {
  return [
    ...new Set(
      (Array.isArray(value) ? value : [])
        .map((id) => String(id || '').trim())
        .filter(Boolean),
    ),
  ]
}

function publicSpeakKey(key) {
  const replacements = {
    humeConfigId: 'speakConfigId',
    humeConfigName: 'speakConfigName',
    humeConfigVersion: 'speakConfigVersion',
    humeConfigSyncedAt: 'speakConfigSyncedAt',
    humeVoiceName: 'speakVoiceName',
    humeVoiceProvider: 'speakVoiceProvider',
    telnyxCallerId: 'phoneCallerId',
    telnyxConnectionId: 'phoneConnectionId',
    telnyxStreamCodec: 'phoneStreamCodec',
    telnyxMinimumHangupMs: 'phoneMinimumHangupMs',
  }
  if (replacements[key]) return replacements[key]
  return String(key)
    .replace(/^hume\b/, 'speak')
    .replace(/^telnyx\b/, 'phone')
    .replace(/Hume/g, 'Speak')
    .replace(/hume/g, 'speak')
    .replace(/TELNYX/g, 'PHONE')
    .replace(/Telnyx/g, 'Phone')
    .replace(/telnyx/g, 'phone')
}

function publicRuntimeConfigName(value) {
  const name = String(value || '')
  const replacements = {
    HUME_API_KEY: 'Speak voice API key',
    HUME_CONFIG_ID: 'Speak config ID',
    HUME_VOICE_ID: 'Speak voice ID',
    INWORLD_API_KEY: 'Inworld API key',
    INWORLD_CODEX_ROUTER_MODEL: 'Inworld Codex router model',
    TELNYX_API_KEY: 'phone API key',
    TELNYX_CONNECTION_ID: 'phone connection ID',
    TELNYX_CALLER_ID: 'phone caller ID',
    TELNYX_FROM_NUMBER: 'phone caller ID',
    TELNYX_SMS_NUMBER: 'SMS number',
    TELNYX_MESSAGING_PROFILE_ID: 'SMS messaging profile',
    VOICE_STREAM_URL: 'phone media stream URL',
    CALLTOOLS_API_KEY: 'CallTools API key',
    CALLTOOLS_AGENT_USER_ID: 'CallTools agent user',
    CALLTOOLS_PHONE_ID: 'CallTools phone',
    CALLTOOLS_WEB_CALLBACK_ID: 'CallTools Web callback',
    CALLTOOLS_CAMPAIGN_ID: 'CallTools campaign',
    CALLTOOLS_MEDIA_GATEWAY: 'CallTools media gateway',
    CALLTOOLS_MEDIA_GATEWAY_URL: 'CallTools media gateway URL',
    CALLTOOLS_MEDIA_GATEWAY_SHARED_SECRET: 'CallTools media gateway secret',
    WORKSPACE_EMAIL_ACCOUNT: 'workspace email account',
    GOG_WRAPPER: 'workspace email sender',
  }
  return replacements[name] || publicSpeakString(name)
}

function isInternalCommunicationRequest(request) {
  const expectedToken = String(process.env.SPEAK_INTERNAL_EVENT_TOKEN || '').trim()
  if (expectedToken) {
    const headerToken = String(
      request.get('x-speak-internal-token') ||
        request.get('authorization')?.replace(/^Bearer\s+/i, '') ||
        '',
    ).trim()
    return headerToken === expectedToken
  }

  const ip = String(request.ip || request.socket?.remoteAddress || '')
  const host = String(request.get('host') || request.hostname || '').toLowerCase()
  const isLocalHost =
    /^localhost(?::\d+)?$/.test(host) ||
    /^127\.0\.0\.1(?::\d+)?$/.test(host) ||
    /^\[?::1\]?(?::\d+)?$/.test(host)
  return (
    isLocalHost &&
    (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1')
  )
}

function publicSpeakString(value) {
  const text = String(value)
  if (text === 'hume') return 'speak'
  if (text === 'HUME_AI') return 'SPEAK_LIBRARY'
  if (text.startsWith('HUME_AI:')) return text.replace(/^HUME_AI:/, 'SPEAK_LIBRARY:')
  if (/^\+?1?\s*your\s+telnyx\s+number$/i.test(text)) return '+1 your phone number'
  if (/^telnyx\s+connection\s+id$/i.test(text)) return 'Phone connection ID'
  if (/^telnyx\s+call\s+control\s+connection_id$/i.test(text)) {
    return 'Phone connection ID'
  }
  return text
    .replace(/\bHume\b/g, 'Speak')
    .replace(/\bhume\b/g, 'speak')
    .replace(/\bTelnyx\b/g, 'phone provider')
    .replace(/\btelnyx\b/g, 'phoneProvider')
}

async function shouldCreateNewSpeakConfig({ requestedCreateNew, profileId, config }) {
  if (requestedCreateNew) return true

  const profileKey = String(profileId || '').trim()
  if (!profileKey) return false

  const runtimeConfig = normalizeCampaignConfig(config)
  const requestedConfigId = String(
    isXaiRuntime(runtimeConfig)
      ? runtimeConfig.xaiConfigId || runtimeConfig.speakConfigId || ''
      : isInworldRuntime(runtimeConfig)
      ? runtimeConfig.inworldConfigId || runtimeConfig.speakConfigId || ''
      : runtimeConfig.humeConfigId || runtimeConfig.speakConfigId || '',
  ).trim()
  if (!requestedConfigId) return false

  const workspace = await listWorkspaceProfiles()
  return (workspace.profiles || []).some((profile) => {
    if (profile.id === profileKey) return false
    const profileConfigId = String(
      isXaiRuntime(runtimeConfig)
        ? profile.config?.xaiConfigId || profile.config?.speakConfigId || ''
        : isInworldRuntime(runtimeConfig)
        ? profile.config?.inworldConfigId || profile.config?.speakConfigId || ''
        : profile.config?.humeConfigId || profile.config?.speakConfigId || '',
    ).trim()
    return profileConfigId && profileConfigId === requestedConfigId
  })
}

function personalPhoneTelnyxDid() {
  return normalizePhone(process.env.PERSONAL_PHONE_TELNYX_DID || '')
}

function personalPhoneContactSourceId() {
  return safeLeadText(process.env.PERSONAL_PHONE_CONTACTS_SOURCE_ID)
}

function isSecurePersonalPhoneStreamUrl(value) {
  try {
    const url = new URL(value)
    const expectedHost = safeLeadText(
      process.env.PERSONAL_PHONE_SPEAK_STREAM_HOST || 'speak.example.com',
    ).toLowerCase()
    return (
      url.protocol === 'wss:' &&
      url.hostname.toLowerCase() === expectedHost &&
      !url.username &&
      !url.password &&
      !url.hash
    )
  } catch {
    return false
  }
}

async function personalPhoneInboundReadiness() {
  const workspace = await workspaceSnapshot()
  const sourceId = personalPhoneContactSourceId()
  const streamUrl = getStreamUrl()
  const registry = personalPhoneInboundHandoffs.readiness()
  const personalPhoneLeadIds = new Set(
    (workspace.leads || [])
      .filter(
        (lead) =>
          lead.source === 'personal-phone' &&
          sourceId &&
          lead.sourceId === sourceId,
      )
      .map((lead) => lead.id),
  )
  const smartViewById = new Map(
    (workspace.smartViews || []).map((smartView) => [smartView.id, smartView]),
  )
  const profiles = (workspace.profiles || [])
    .filter((profile) => profile.config?.personalPhoneInbound?.enabled === true)
    .map((profile) => {
      const policy = profile.config.personalPhoneInbound
      const eligibilityScope =
        policy.eligibilityScope === 'source' ? 'source' : 'selected'
      const policySourceId = safeLeadText(policy.sourceId)
      const selectedContactIds = [...new Set(policy.contactIds || [])]
      const selectedSmartViewIds = [...new Set(policy.smartViewIds || [])]
      const eligibleIds = new Set()
      if (eligibilityScope === 'source' && policySourceId === sourceId) {
        personalPhoneLeadIds.forEach((contactId) => eligibleIds.add(contactId))
      } else if (eligibilityScope === 'selected') {
        selectedContactIds.forEach((contactId) => {
          if (personalPhoneLeadIds.has(contactId)) eligibleIds.add(contactId)
        })
        selectedSmartViewIds.forEach((smartViewId) => {
          ;(smartViewById.get(smartViewId)?.leadIds || []).forEach((contactId) => {
            if (personalPhoneLeadIds.has(contactId)) eligibleIds.add(contactId)
          })
        })
      }
      const blockers = missingForVoiceSession(
        normalizeCampaignConfig({
          ...profile.config,
          agentProfileId: profile.id,
          agentProfileName: profile.name,
        }),
      )
      if (eligibilityScope === 'source' && policySourceId !== sourceId) {
        blockers.push('PERSONAL_PHONE_INBOUND_SOURCE')
      }
      if (eligibilityScope === 'selected' && eligibleIds.size === 0) {
        blockers.push('PERSONAL_PHONE_INBOUND_SELECTIONS')
      }
      return {
        profileId: profile.id,
        profileName: profile.name,
        ready: blockers.length === 0,
        eligibilityScope,
        sourceBound: eligibilityScope !== 'source' || policySourceId === sourceId,
        selectedContactCount: selectedContactIds.length,
        selectedSmartViewCount: selectedSmartViewIds.length,
        eligibleContactCount: eligibleIds.size,
        blockers: [...new Set(blockers)],
      }
    })

  const blockers = []
  if (!getPersonalPhoneSpeakHandoffSecret()) {
    blockers.push('PERSONAL_PHONE_SPEAK_HANDOFF_SECRET')
  }
  if (!personalPhoneTelnyxDid()) blockers.push('PERSONAL_PHONE_TELNYX_DID')
  if (!sourceId) blockers.push('PERSONAL_PHONE_CONTACTS_SOURCE_ID')
  if (sourceId && personalPhoneLeadIds.size === 0) {
    blockers.push('PERSONAL_PHONE_CONTACT_SOURCE')
  }
  if (!isSecurePersonalPhoneStreamUrl(streamUrl)) blockers.push('VOICE_STREAM_WSS_URL')
  if (!registry.ready) blockers.push('PERSONAL_PHONE_HANDOFF_STORE')
  if (!profiles.some((profile) => profile.ready)) {
    blockers.push('PERSONAL_PHONE_INBOUND_PROFILE')
  }

  return {
    schemaVersion: PERSONAL_PHONE_READINESS_SCHEMA,
    ready: blockers.length === 0,
    configured: {
      handoffSecret: Boolean(getPersonalPhoneSpeakHandoffSecret()),
      personalPhoneDid: Boolean(personalPhoneTelnyxDid()),
      contactSourceId: Boolean(sourceId),
      secureStream: isSecurePersonalPhoneStreamUrl(streamUrl),
      durableReplay: registry.ready,
    },
    contactSource: {
      configured: Boolean(sourceId),
      sourceId,
      present: personalPhoneLeadIds.size > 0,
      contactCount: personalPhoneLeadIds.size,
    },
    profiles,
    blockers: [...new Set(blockers)],
    proof: {
      backendOnly: true,
      headlessOnly: true,
      policyNetworkCalls: false,
      durableReplay: registry.ready,
      persistenceError: registry.error || '',
    },
  }
}

function getCallState(callControlId) {
  return (
    calls.get(callControlId) ||
    voiceProviderSessionAliases.get(callControlId) ||
    provisionalVoiceSessions.findByStateId(callControlId)?.state ||
    null
  )
}

export function registerVoiceDeliveryTestState(state) {
  const callControlId = String(state?.callControlId || '').trim()
  if (!callControlId) throw new Error('Voice delivery test state requires a callControlId')
  calls.set(callControlId, state)
  return () => calls.delete(callControlId)
}

function findStateByStreamId(streamId) {
  return Array.from(calls.values()).find((state) => state.streamId === streamId)
}

function closeCallSockets(state) {
  if (!state) return
  state.takeover = false
  voiceInterruptionRecovery.clear(state, 'call_closed')
  stopHumeInputPrimer(state, 'call_closed')
  state.browserAudioAttachPending = false
  clearBrowserAudioBeforeAttach(state)
  discardVoiceInputPreReadyBuffer(state, 'call_closed')
  clearCallToolsVoiceReadyTimeout(state)
  if (state.pendingPlaygroundInputTimer) {
    clearTimeout(state.pendingPlaygroundInputTimer)
    state.pendingPlaygroundInputTimer = null
  }
  clearAssistantResponseIdleGuard(state)
  clearTelnyxOutboundQueue(state, { sendClear: false })
  playgroundCallSupervision.close(state)
  state.humanWs?.close()
  state.browserWs?.close()
  state.humeWs?.close()
  state.inworldWs?.close()
  state.xaiWs?.close()
  state.telnyxWs?.close()
  forgetVoiceProviderSessionAlias(state)
}

function emitCallEvent(callControlId, event) {
  const state = getCallState(callControlId)
  if (state && queueProvisionalVoiceSessionEvent(state, event)) return
  const nextEvent = { ...event }
  const communicationPersistenceDisabled = nextEvent.persistCommunication === false
  delete nextEvent.persistCommunication
  const emittedAt = new Date().toISOString()
  if (
    state?.personalPhoneInboundCorrelationId &&
    nextEvent.entry &&
    ['Lead', 'AI', 'Agent', 'Assistant'].includes(nextEvent.entry.speaker) &&
    safeLeadText(nextEvent.entry.text)
  ) {
    markPersonalPhoneInboundConversationStarted(state)
  }
  if (state && nextEvent.patch?.phase === 'ended') {
    markTransportTimestamp(state, 'finalized')
    nextEvent.diagnostic =
      nextEvent.diagnostic || buildTransportDiagnosticSnapshot(state)
    nextEvent.audioQuality =
      nextEvent.audioQuality || audioQualitySnapshot(state)
    const localAudio = finalizeCallAudio(callAudioDir, state, BASE_PATH)
    if (localAudio) {
      nextEvent.audio = localAudio
    } else if (
      state.chatId &&
      !isInworldRuntime(state.config) &&
      !isXaiRuntime(state.config)
    ) {
      nextEvent.audio = {
        status: 'requestable',
        source: 'hume',
      }
    }
    if (isCallToolsGatewayCall(state)) {
      scheduleCallToolsStandbyReplenishment(state)
    }
  }
  const persistCommunication =
    !communicationPersistenceDisabled && shouldPersistCallCommunication(nextEvent)

  if (state) {
    state.updatedAt = emittedAt
    state.eventLog.push(nextEvent)
    state.eventLog = state.eventLog.slice(-200)
  }
  persistCallEventToLog({
    callLogDir,
    callControlId,
    state,
    event: nextEvent,
    leadForState: publicLeadContext,
  })
  if (state && persistCommunication) {
    persistCallCommunicationRecord(state, nextEvent, emittedAt)
  }

  const clients = getSseClients(callControlId)
  const publicEvent = publicSpeakPayload(nextEvent)
  clients.forEach((client) => {
    client.write(`data: ${JSON.stringify(publicEvent)}\n\n`)
  })
}

function persistCallCommunicationRecord(state, event, createdAt) {
  const record = {
    callControlId: state.callControlId,
    state,
    lead: publicLeadContext(state),
    event,
    createdAt,
  }
  if (shouldDeferCallCommunicationRecord(state, event)) {
    state.pendingCommunicationEvents ||= []
    state.pendingCommunicationEvents.push(record)
    return
  }

  if (!isTerminalCommunicationEvent(event, state)) {
    void recordCommunicationEvent(record).catch((error) => {
      console.warn(
        'Failed to persist communication event:',
        error instanceof Error ? error.message : error,
      )
    })
    return
  }

  state.pendingCommunicationEvents ||= []
  state.pendingCommunicationEvents.push(record)
  void flushStateCallCommunicationEvents(state).catch((error) => {
    console.warn(
      'Failed to persist communication event batch:',
      error instanceof Error ? error.message : error,
    )
  })
}

function flushStateCallCommunicationEvents(state) {
  if (state.communicationPersistenceInFlight) {
    return state.communicationPersistenceInFlight
  }
  const records = Array.isArray(state.pendingCommunicationEvents)
    ? state.pendingCommunicationEvents.slice()
    : []
  if (!records.length) return Promise.resolve()

  const write = records.length > 1
    ? recordCommunicationEvents(records)
    : recordCommunicationEvent(records[0])
  const tracked = write.then(() => {
    const unchanged = records.every(
      (record, index) => state.pendingCommunicationEvents?.[index] === record,
    )
    if (unchanged) state.pendingCommunicationEvents.splice(0, records.length)
  })
  state.communicationPersistenceInFlight = tracked
  tracked.then(
    () => {
      if (state.communicationPersistenceInFlight === tracked) {
        state.communicationPersistenceInFlight = null
      }
      if (state.pendingCommunicationEvents?.length && isCallEnded(state)) {
        void flushStateCallCommunicationEvents(state).catch((error) => {
          console.warn(
            'Failed to persist trailing communication event batch:',
            error instanceof Error ? error.message : error,
          )
        })
      }
    },
    () => {
      if (state.communicationPersistenceInFlight === tracked) {
        state.communicationPersistenceInFlight = null
      }
    },
  )
  return tracked
}

async function flushPendingCallCommunicationEvents() {
  for (let pass = 0; pass < 5; pass += 1) {
    const states = Array.from(calls.values())
    await Promise.allSettled(
      states
        .map((state) => state.communicationPersistenceInFlight)
        .filter(Boolean),
    )
    const pendingStates = states.filter(
      (state) => Array.isArray(state.pendingCommunicationEvents) &&
        state.pendingCommunicationEvents.length > 0,
    )
    if (!pendingStates.length) return
    await Promise.all(pendingStates.map((state) => flushStateCallCommunicationEvents(state)))
    await new Promise((resolve) => setImmediate(resolve))
  }
  const remaining = Array.from(calls.values()).reduce(
    (count, state) => count + Number(state.pendingCommunicationEvents?.length || 0),
    0,
  )
  if (remaining > 0) {
    throw new Error(`Communication event flush did not quiesce (${remaining} records remain)`)
  }
}

function shouldPersistCallCommunication(event = {}) {
  if (event.persistCommunication === false) return false
  if (event.communication && typeof event.communication === 'object') return true
  if (isTerminalCommunicationEvent(event) || event.providerEvent) return true
  return ['Lead', 'AI', 'Agent', 'Assistant', 'Tool', 'System'].includes(event.entry?.speaker)
}

function shouldDeferCallCommunicationRecord(state, event = {}) {
  if (!state || isTerminalCommunicationEvent(event, state)) return false
  const channel = safeLeadText(event.communication?.channel).toLowerCase()
  if (channel && !['call', 'browser_test'].includes(channel)) return false
  return event.entry?.speaker !== 'Tool'
}

function isTerminalCommunicationEvent(event = {}, state = null) {
  return (
    event.patch?.phase === 'ended' ||
    Boolean(event.patch?.outcome || event.outcome || event.audio) ||
    Boolean(state && isCallEnded(state))
  )
}

function getSseClients(callControlId) {
  if (!sseClients.has(callControlId)) {
    sseClients.set(callControlId, new Set())
  }
  return sseClients.get(callControlId)
}
