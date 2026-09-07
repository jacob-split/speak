import {
  HUME_AUDIO_CHANNELS,
  HUME_AUDIO_ENCODING,
} from './hume-session.mjs'
import { DEFAULT_VOICE_PRE_READY_BUFFER_MS } from './voice-turn-transport.mjs'

export function createTransportDiagnostics(config = {}) {
  return {
    createdAt: new Date().toISOString(),
    telnyx: compactObject({
      requestedCodec: config.telnyxStreamCodec,
      requestedSampleRate: config.sampleRate,
      requestedTrack: 'inbound_track',
      bidirectionalMode: 'rtp',
      bidirectionalCodec: config.telnyxStreamCodec,
      bidirectionalSampleRate: config.sampleRate,
    }),
    hume: compactObject({
      audioEncoding: HUME_AUDIO_ENCODING,
      audioChannels: HUME_AUDIO_CHANNELS,
      requestedSampleRate: config.sampleRate,
      verboseTranscription: Boolean(config.verboseTranscription),
    }),
    inworld: compactObject({
      requestedModel: config.inworldRealtimeModel,
      requestedSttModel: config.inworldSttModel,
      requestedTtsModel: config.inworldTtsModel,
      sttEndOfTurnConfidenceThreshold: config.inworldSttEndOfTurnConfidenceThreshold,
      sttMinEndOfTurnSilenceMs: config.inworldSttMinEndOfTurnSilenceMs,
      sttMaxTurnSilenceMs: config.inworldSttMaxTurnSilenceMs,
      sttVadThreshold: config.inworldSttVadThreshold,
      requestedVoice: config.inworldVoiceName || config.voice,
      requestedOutputSampleRate: config.inworldOutputSampleRate,
      requestedTtsDeliveryMode: config.inworldTtsDeliveryMode,
      requestedTtsSegmenterStrategy: config.inworldTtsSegmenterStrategy,
      requestedTtsSteeringHandling: config.inworldTtsSteeringHandling,
      requestedTtsConversational: config.inworldTtsConversationalEnabled,
      requestedTtsUserTurnMode: config.inworldTtsUserTurnMode,
      turnDetection: config.inworldTurnDetectionMode,
      turnEagerness: config.inworldTurnEagerness,
      voiceSteeringEnabled: config.inworldVoiceSteeringEnabled,
      voiceProfileEnabled: config.inworldVoiceProfileEnabled,
      responsivenessEnabled: config.inworldResponsivenessEnabled,
      responsivenessInitialWaitMs: config.inworldResponsivenessInitialWaitMs,
      responsivenessHardDeadlineMs: config.inworldResponsivenessHardDeadlineMs,
      toolCallingEnabled: config.inworldToolCallingEnabled,
    }),
    xai: compactObject({
      requestedModel: config.xaiRealtimeModel,
      requestedVoice: config.xaiVoiceName || config.voice,
      requestedReasoningEffort: config.xaiReasoningEffort,
      requestedLanguageHint: config.xaiLanguageHint,
      requestedKeytermCount: Array.isArray(config.xaiKeyterms)
        ? config.xaiKeyterms.length
        : 0,
      requestedOutputSampleRate: config.xaiOutputSampleRate,
      requestedVoiceSpeed: config.xaiVoiceSpeed,
      resumptionEnabled: config.xaiResumptionEnabled,
      toolCallingEnabled: config.xaiToolCallingEnabled,
      turnDetection: config.turnDetectionEnabled === false ? 'manual' : 'server_vad',
      vadThreshold: config.speechDetectionThreshold,
      silenceDurationMs: config.endOfTurnSilenceMs,
      prefixPaddingMs: config.prefixPaddingMs,
    }),
    voice: {
      preReadyBufferMaxMs: DEFAULT_VOICE_PRE_READY_BUFFER_MS,
    },
    calltools: compactObject({
      requestedSampleRate: config.sampleRate,
      inputFrameMs: undefined,
    }),
    counters: {
      browserAudioClears: 0,
      humeAudioInputBytes: 0,
      humeAudioInputs: 0,
      humeAudioOutputBytes: 0,
      humeAudioOutputs: 0,
      humeInterimUserMessages: 0,
      humeInterruptions: 0,
      humeUserMessages: 0,
      inworldAudioInputBytes: 0,
      inworldAudioInputs: 0,
      inworldAudioOutputBytes: 0,
      inworldAudioOutputs: 0,
      inworldInterruptions: 0,
      inworldUserMessages: 0,
      xaiAudioInputBytes: 0,
      xaiAudioInputs: 0,
      xaiAudioOutputBytes: 0,
      xaiAudioOutputs: 0,
      xaiInterruptions: 0,
      xaiUserMessages: 0,
      interruptionSilenceRecoveries: 0,
      telnyxClearMessages: 0,
      telnyxMarksReceived: 0,
      telnyxMarksSent: 0,
      telnyxMediaInBytes: 0,
      telnyxMediaInPackets: 0,
      telnyxMediaOutBytes: 0,
      telnyxMediaOutPackets: 0,
      telnyxPcmInBytes: 0,
      telnyxPcmOutBytes: 0,
      voiceInputPreReadyBufferedBytes: 0,
      voiceInputPreReadyBufferedFrames: 0,
      voiceInputPreReadyDroppedBytes: 0,
      voiceInputPreReadyDroppedFrames: 0,
      voiceInputPreReadyFlushedBytes: 0,
      voiceInputPreReadyFlushedFrames: 0,
      voiceInputNoiseSuppressedBytes: 0,
      voiceInputNoiseSuppressedFrames: 0,
    },
    timestamps: {},
    milestones: [],
  }
}

export function addTransportCounter(state, key, amount = 1) {
  const diagnostics = state?.transportDiagnostics
  if (!diagnostics?.counters) return
  diagnostics.counters[key] = Number(diagnostics.counters[key] || 0) + amount
}

export function setTransportDiagnosticValue(state, section, key, value) {
  const diagnostics = state?.transportDiagnostics
  if (!diagnostics) return
  if (!diagnostics[section]) diagnostics[section] = {}
  diagnostics[section][key] = value
}

export function markTransportTimestamp(state, key) {
  return markTransportTimestampAt(state, key, new Date().toISOString())
}

export function markTransportTimestampAt(state, key, value) {
  const diagnostics = state?.transportDiagnostics
  if (!diagnostics?.timestamps) return ''
  if (!diagnostics.timestamps[key]) {
    const timestamp = new Date(value || Date.now())
    diagnostics.timestamps[key] = Number.isFinite(timestamp.getTime())
      ? timestamp.toISOString()
      : new Date().toISOString()
  }
  return diagnostics.timestamps[key]
}

export function recordTransportMilestone(state, name, details = {}) {
  return recordTransportMilestoneAt(
    state,
    name,
    new Date().toISOString(),
    details,
  )
}

export function recordTransportMilestoneAt(state, name, value, details = {}) {
  const diagnostics = state?.transportDiagnostics
  if (!diagnostics) return

  const alreadyMarked = Boolean(diagnostics.timestamps?.[name])
  const at = markTransportTimestampAt(state, name, value) || new Date().toISOString()
  if (alreadyMarked && name.startsWith('first_')) return

  diagnostics.milestones.push(compactObject({ at, name, ...details }))
  diagnostics.milestones = diagnostics.milestones.slice(-40)
}

export function buildTransportDiagnosticSnapshot(state) {
  const diagnostics = state?.transportDiagnostics
  if (!diagnostics) return null

  const timestamps = diagnostics.timestamps || {}
  return compactObject({
    createdAt: diagnostics.createdAt,
    updatedAt: new Date().toISOString(),
    telnyx: compactObject(diagnostics.telnyx || {}),
    calltools: compactObject(diagnostics.calltools || {}),
    hume: compactObject(diagnostics.hume || {}),
    inworld: compactObject(diagnostics.inworld || {}),
    xai: compactObject(diagnostics.xai || {}),
    voice: compactObject(diagnostics.voice || {}),
    counters: compactObject(diagnostics.counters || {}),
    timingMs: compactObject({
      voicePreconnectToProviderOpen: elapsedMs(
        timestamps.voice_preconnect_started,
        timestamps.hume_ws_open || timestamps.inworld_ws_open || timestamps.xai_ws_open,
      ),
      voicePreconnectToBound: elapsedMs(
        timestamps.voice_preconnect_started,
        timestamps.voice_preconnect_bound,
      ),
      voicePreconnectToTelnyxAccepted: elapsedMs(
        timestamps.voice_preconnect_started,
        timestamps.telnyx_call_accepted,
      ),
      providerOpenLeadBeforeTelnyxStream: elapsedMs(
        timestamps.hume_ws_open || timestamps.inworld_ws_open || timestamps.xai_ws_open,
        timestamps.telnyx_stream_attached,
      ),
      providerOpenLeadBeforeCallToolsInvite: elapsedMs(
        timestamps.hume_ws_open || timestamps.inworld_ws_open || timestamps.xai_ws_open,
        timestamps.calltools_gateway_invite_received,
      ),
      telnyxStreamToHumeOpen: elapsedMs(
        timestamps.telnyx_stream_attached,
        timestamps.hume_ws_open,
      ),
      telnyxStreamToInworldOpen: elapsedMs(
        timestamps.telnyx_stream_attached,
        timestamps.inworld_ws_open,
      ),
      telnyxStreamToXaiOpen: elapsedMs(
        timestamps.telnyx_stream_attached,
        timestamps.xai_ws_open,
      ),
      telnyxStreamToHumeChat: elapsedMs(
        timestamps.telnyx_stream_attached,
        timestamps.hume_chat_attached,
      ),
      telnyxStreamToInworldSession: elapsedMs(
        timestamps.telnyx_stream_attached,
        timestamps.inworld_session_attached,
      ),
      firstLeadAudioToFirstInterimTranscript: elapsedMs(
        timestamps.first_telnyx_media_in,
        timestamps.first_interim_user_message,
      ),
      firstLeadAudioToFirstUserMessage: elapsedMs(
        timestamps.first_telnyx_media_in,
        timestamps.first_user_message,
      ),
      firstUserMessageToFirstAssistantMessage: elapsedMs(
        timestamps.first_user_message,
        timestamps.first_assistant_message,
      ),
      firstUserMessageToFirstAssistantAudio: elapsedMs(
        timestamps.first_user_message,
        timestamps.first_calltools_media_out ||
          timestamps.first_telnyx_media_out ||
          timestamps.first_inworld_audio_output ||
          timestamps.first_xai_audio_output ||
          timestamps.first_hume_audio_output,
      ),
      firstCallToolsLeadAudioToFirstAssistantAudio: elapsedMs(
        timestamps.first_calltools_media_in,
        timestamps.first_calltools_media_out ||
          timestamps.first_inworld_audio_output ||
          timestamps.first_xai_audio_output ||
          timestamps.first_hume_audio_output,
      ),
      firstInworldSpeechStoppedToFirstAssistantAudio: elapsedMs(
        timestamps.first_inworld_speech_stopped,
        timestamps.first_calltools_media_out ||
          timestamps.first_telnyx_media_out ||
          timestamps.first_inworld_audio_output ||
          timestamps.first_hume_audio_output,
      ),
      firstInworldSpeechStartedToFirstInworldSpeechStopped: elapsedMs(
        timestamps.first_inworld_speech_started,
        timestamps.first_inworld_speech_stopped,
      ),
      firstAssistantMessageToFirstHumeAudio: elapsedMs(
        timestamps.first_assistant_message,
        timestamps.first_hume_audio_output,
      ),
      firstAssistantMessageToFirstInworldAudio: elapsedMs(
        timestamps.first_assistant_message,
        timestamps.first_inworld_audio_output,
      ),
      firstAssistantMessageToFirstXaiAudio: elapsedMs(
        timestamps.first_assistant_message,
        timestamps.first_xai_audio_output,
      ),
      firstHumeAudioToFirstTelnyxAudio: elapsedMs(
        timestamps.first_hume_audio_output,
        timestamps.first_telnyx_media_out,
      ),
      firstInworldAudioToFirstTelnyxAudio: elapsedMs(
        timestamps.first_inworld_audio_output,
        timestamps.first_telnyx_media_out,
      ),
      firstXaiAudioToFirstTelnyxAudio: elapsedMs(
        timestamps.first_xai_audio_output,
        timestamps.first_telnyx_media_out,
      ),
      telnyxStreamToFirstAssistantAudio: elapsedMs(
        timestamps.telnyx_stream_attached,
        timestamps.first_telnyx_media_out,
      ),
      calltoolsDialToGatewayAttach: elapsedMs(
        timestamps.calltools_gateway_dial_requested,
        timestamps.calltools_gateway_attached,
      ),
      calltoolsInviteToGatewayAttach: elapsedMs(
        timestamps.calltools_gateway_invite_received,
        timestamps.calltools_gateway_attached,
      ),
      calltoolsInviteToHumeOpen: elapsedMs(
        timestamps.calltools_gateway_invite_received,
        timestamps.hume_ws_open,
      ),
      calltoolsInviteToHumeChat: elapsedMs(
        timestamps.calltools_gateway_invite_received,
        timestamps.hume_chat_attached,
      ),
      calltoolsInviteToInworldOpen: elapsedMs(
        timestamps.calltools_gateway_invite_received,
        timestamps.inworld_ws_open,
      ),
      calltoolsInviteToInworldSession: elapsedMs(
        timestamps.calltools_gateway_invite_received,
        timestamps.inworld_session_attached,
      ),
      calltoolsInviteToXaiOpen: elapsedMs(
        timestamps.calltools_gateway_invite_received,
        timestamps.xai_ws_open,
      ),
      calltoolsInviteToXaiSession: elapsedMs(
        timestamps.calltools_gateway_invite_received,
        timestamps.xai_session_attached,
      ),
      calltoolsInviteToVoiceInputReady: elapsedMs(
        timestamps.calltools_gateway_invite_received,
        timestamps.voice_input_ready,
      ),
      calltoolsStandbyClaimToVoiceInputReady: elapsedMs(
        timestamps.calltools_voice_standby_claimed,
        timestamps.voice_input_ready,
      ),
      calltoolsAttachToVoiceInputReady: elapsedMsFromAttach(
        timestamps.calltools_gateway_attached,
        timestamps.voice_input_ready,
      ),
      voiceConnectToInputReady: elapsedMs(
        timestamps.voice_connect_started,
        timestamps.voice_input_ready,
      ),
      calltoolsAttachToContextEnriched: elapsedMs(
        timestamps.calltools_gateway_attached,
        timestamps.calltools_context_enriched,
      ),
      calltoolsAttachToHumeOpen: elapsedMsFromAttach(
        timestamps.calltools_gateway_attached,
        timestamps.hume_ws_open,
      ),
      calltoolsAttachToInworldOpen: elapsedMsFromAttach(
        timestamps.calltools_gateway_attached,
        timestamps.inworld_ws_open,
      ),
      calltoolsAttachToHumeChat: elapsedMsFromAttach(
        timestamps.calltools_gateway_attached,
        timestamps.hume_chat_attached,
      ),
      calltoolsAttachToInworldSession: elapsedMsFromAttach(
        timestamps.calltools_gateway_attached,
        timestamps.inworld_session_attached,
      ),
      calltoolsAttachToXaiOpen: elapsedMsFromAttach(
        timestamps.calltools_gateway_attached,
        timestamps.xai_ws_open,
      ),
      calltoolsAttachToXaiSession: elapsedMsFromAttach(
        timestamps.calltools_gateway_attached,
        timestamps.xai_session_attached,
      ),
      calltoolsAttachToInitialGreetingRequest: elapsedMs(
        timestamps.calltools_gateway_attached,
        timestamps.initial_greeting_requested,
      ),
      firstCallToolsLeadAudioToFirstInterimTranscript: elapsedMs(
        timestamps.first_calltools_media_in,
        timestamps.first_interim_user_message,
      ),
      firstCallToolsLeadAudioToFirstUserMessage: elapsedMs(
        timestamps.first_calltools_media_in,
        timestamps.first_user_message,
      ),
      firstHumeAudioToFirstCallToolsAudio: elapsedMs(
        timestamps.first_hume_audio_output,
        timestamps.first_calltools_media_out,
      ),
      firstInworldAudioToFirstCallToolsAudio: elapsedMs(
        timestamps.first_inworld_audio_output,
        timestamps.first_calltools_media_out,
      ),
      firstXaiAudioToFirstCallToolsAudio: elapsedMs(
        timestamps.first_xai_audio_output,
        timestamps.first_calltools_media_out,
      ),
      calltoolsAttachToFirstAssistantAudio: elapsedMs(
        timestamps.calltools_gateway_attached,
        timestamps.first_calltools_media_out,
      ),
    }),
    timestamps: compactObject(timestamps),
    milestones: diagnostics.milestones?.slice(-12) || [],
  })
}

function elapsedMs(start, end) {
  const startMs = Date.parse(start || '')
  const endMs = Date.parse(end || '')
  if (!startMs || !endMs || endMs < startMs) return undefined
  return endMs - startMs
}

function elapsedMsFromAttach(start, end) {
  const startMs = Date.parse(start || '')
  const endMs = Date.parse(end || '')
  if (!startMs || !endMs) return undefined
  return Math.max(0, endMs - startMs)
}

function compactObject(object) {
  if (!object || typeof object !== 'object') return object

  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => {
      if (value === undefined || value === null || value === '') return false
      if (Array.isArray(value)) return value.length > 0
      return true
    }),
  )
}
