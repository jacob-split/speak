export function buildCallToolsProofGates({ timingMs = {}, audioQuality = {}, options = {} } = {}) {
  const latency = buildLatencyGate(timingMs, options)
  const quality = buildAudioQualityGate(audioQuality, options)
  return {
    ok: latency.ok && quality.ok,
    latency,
    audioQuality: quality,
  }
}

function buildLatencyGate(timingMs = {}, options = {}) {
  const required = boolOption(
    options.requireLatency,
    process.env.CALLTOOLS_PROOF_REQUIRE_LATENCY,
    true,
  )
  const checks = [
    latencyCheck({
      id: 'calltoolsInviteToVoiceInputReady',
      value: timingMs.calltoolsInviteToVoiceInputReady,
      maxMs: thresholdOption(
        options.maxInviteToVoiceInputReadyMs,
        process.env.CALLTOOLS_PROOF_MAX_INVITE_TO_VOICE_INPUT_READY_MS,
        2000,
      ),
      required: required && Number.isFinite(timingMs.calltoolsInviteToVoiceInputReady),
    }),
    latencyCheck({
      id: 'calltoolsAttachToVoiceSession',
      value: firstFinite(
        timingMs.calltoolsAttachToInworldSession,
        timingMs.calltoolsAttachToHumeChat,
        timingMs.calltoolsAttachToInworldOpen,
        timingMs.calltoolsAttachToHumeOpen,
      ),
      maxMs: thresholdOption(
        options.maxAttachToVoiceSessionMs,
        process.env.CALLTOOLS_PROOF_MAX_ATTACH_TO_VOICE_SESSION_MS,
        2000,
      ),
      required,
    }),
    latencyCheck({
      id: 'firstUserMessageToFirstAssistantAudio',
      value: timingMs.firstUserMessageToFirstAssistantAudio,
      maxMs: thresholdOption(
        options.maxFirstUserToAssistantAudioMs,
        process.env.CALLTOOLS_PROOF_MAX_FIRST_USER_TO_ASSISTANT_AUDIO_MS ??
          process.env.CALLTOOLS_PROOF_MAX_FIRST_USER_TO_ASSISTANT_MESSAGE_MS,
        5000,
      ),
      required,
    }),
    latencyCheck({
      id: 'firstUserMessageToFirstAssistantMessage',
      value: timingMs.firstUserMessageToFirstAssistantMessage,
      maxMs: null,
      required: false,
    }),
    latencyCheck({
      id: 'calltoolsAttachToFirstAssistantAudio',
      value: timingMs.calltoolsAttachToFirstAssistantAudio,
      maxMs: thresholdOption(
        options.maxAttachToFirstAssistantAudioMs,
        process.env.CALLTOOLS_PROOF_MAX_ATTACH_TO_FIRST_ASSISTANT_AUDIO_MS,
        10000,
      ),
      required: false,
    }),
    latencyCheck({
      id: 'providerAudioToCallToolsOutput',
      value: firstFinite(
        timingMs.firstInworldAudioToFirstCallToolsAudio,
        timingMs.firstHumeAudioToFirstCallToolsAudio,
      ),
      maxMs: thresholdOption(
        options.maxProviderAudioToCallToolsAudioMs,
        process.env.CALLTOOLS_PROOF_MAX_PROVIDER_AUDIO_TO_CALLTOOLS_AUDIO_MS,
        1200,
      ),
      required,
    }),
    latencyCheck({
      id: 'firstCallToolsLeadAudioToFirstUserMessage',
      value: timingMs.firstCallToolsLeadAudioToFirstUserMessage,
      maxMs: thresholdOption(
        options.maxLeadAudioToUserMessageMs,
        process.env.CALLTOOLS_PROOF_MAX_LEAD_AUDIO_TO_USER_MESSAGE_MS,
        null,
      ),
      required: false,
    }),
    latencyCheck({
      id: 'calltoolsDialToGatewayAttach',
      value: timingMs.calltoolsDialToGatewayAttach,
      maxMs: thresholdOption(
        options.maxDialToGatewayAttachMs,
        process.env.CALLTOOLS_PROOF_MAX_DIAL_TO_GATEWAY_ATTACH_MS,
        null,
      ),
      required: false,
    }),
  ].filter(Boolean)

  return {
    ok: checks.every((check) => check.ok),
    required,
    checks,
  }
}

function buildAudioQualityGate(audioQuality = {}, options = {}) {
  const required = boolOption(
    options.requireAudioQuality,
    process.env.CALLTOOLS_PROOF_REQUIRE_AUDIO_QUALITY,
    true,
  )
  const inbound = audioQuality.inbound || {}
  const humeOutput = audioQuality.humeOutput || {}
  const telnyxOutput = audioQuality.telnyxOutput || {}
  const queue = audioQuality.queue || {}
  const checks = [
    qualityCheck({
      id: 'queueMaxMs',
      value: queue.maxMs,
      max: thresholdOption(options.maxQueueMs, process.env.CALLTOOLS_PROOF_MAX_QUEUE_MS, 250),
      required,
    }),
    qualityCheck({
      id: 'droppedFrames',
      value: queue.droppedFrames,
      max: thresholdOption(
        options.maxDroppedFrames,
        process.env.CALLTOOLS_PROOF_MAX_DROPPED_FRAMES,
        0,
      ),
      required,
    }),
    qualityCheck({
      id: 'inboundClippedFrames',
      value: inbound.clippedFrames,
      max: thresholdOption(
        options.maxInboundClippedFrames,
        process.env.CALLTOOLS_PROOF_MAX_INBOUND_CLIPPED_FRAMES,
        0,
      ),
      required,
    }),
    qualityCheck({
      id: 'outputClippedFrames',
      value: telnyxOutput.clippedFrames,
      max: thresholdOption(
        options.maxOutputClippedFrames,
        process.env.CALLTOOLS_PROOF_MAX_OUTPUT_CLIPPED_FRAMES,
        0,
      ),
      required,
    }),
    qualityCheck({
      id: 'oddBytePayloads',
      value: inbound.oddBytePayloads,
      max: thresholdOption(
        options.maxOddBytePayloads,
        process.env.CALLTOOLS_PROOF_MAX_ODD_BYTE_PAYLOADS,
        0,
      ),
      required,
    }),
    qualityCheck({
      id: 'decodeErrors',
      value: inbound.decodeErrors,
      max: thresholdOption(
        options.maxDecodeErrors,
        process.env.CALLTOOLS_PROOF_MAX_DECODE_ERRORS,
        0,
      ),
      required,
    }),
  ]

  return {
    ok: checks.every((check) => check.ok),
    required,
    codec: audioQuality.codec || '',
    sampleRate: audioQuality.sampleRate || null,
    diagnostics: {
      rawProviderClippedFrames: finiteOrNull(humeOutput.clippedFrames),
      rawProviderPeakRatioMax: finiteOrNull(humeOutput.peakRatioMax),
      finalOutputClippedFrames: finiteOrNull(telnyxOutput.clippedFrames),
      finalOutputPeakRatioMax: finiteOrNull(telnyxOutput.peakRatioMax),
    },
    checks,
  }
}

function latencyCheck({ id, value, maxMs, required }) {
  const normalized = finiteOrNull(value)
  if (maxMs === null) {
    return {
      id,
      valueMs: normalized,
      maxMs,
      ok: true,
      required: false,
    }
  }
  const ok = required ? normalized !== null && normalized <= maxMs : normalized === null || normalized <= maxMs
  return {
    id,
    valueMs: normalized,
    maxMs,
    ok,
    required,
    missing: normalized === null,
  }
}

function qualityCheck({ id, value, max, required }) {
  const normalized = finiteOrNull(value)
  const ok = required ? normalized !== null && normalized <= max : normalized === null || normalized <= max
  return {
    id,
    value: normalized,
    max,
    ok,
    required,
    missing: normalized === null,
  }
}

function firstFinite(...values) {
  for (const value of values) {
    const finite = finiteOrNull(value)
    if (finite !== null) return finite
  }
  return null
}

function finiteOrNull(value) {
  if (value === undefined || value === null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function thresholdOption(optionValue, envValue, fallback) {
  const raw = optionValue ?? envValue
  if (raw === undefined || raw === null || raw === '') return fallback
  if (String(raw).toLowerCase() === 'none') return null
  const number = Number(raw)
  return Number.isFinite(number) ? number : fallback
}

function boolOption(optionValue, envValue, fallback) {
  const raw = optionValue ?? envValue
  if (raw === undefined || raw === null || raw === '') return fallback
  return !['0', 'false', 'no', 'off'].includes(String(raw).toLowerCase())
}
