export const DEFAULT_VOICE_PRE_READY_BUFFER_MS = 3_000
export const DEFAULT_BROWSER_AUDIO_ATTACH_BUFFER_MS = 5_000
export const DEFAULT_VOICE_ACTIVITY_PEAK_THRESHOLD_RATIO = 0.02
export const DEFAULT_VOICE_ACTIVITY_RMS_THRESHOLD_RATIO = 0.007
export const DEFAULT_PHONE_INPUT_SILENCE_GATE_HANGOVER_MS = 160
export const DEFAULT_PHONE_INPUT_RESPONSE_BOUNDARY_MS = 500
export const DEFAULT_PHONE_INPUT_ACTIVITY_PEAK_THRESHOLD_RATIO = 0.012
export const DEFAULT_PHONE_INPUT_ACTIVITY_RMS_THRESHOLD_RATIO = 0.0025

export function bufferBrowserAudioBeforeAttach(
  state,
  pcmLittleEndian,
  { maxDurationMs = DEFAULT_BROWSER_AUDIO_ATTACH_BUFFER_MS } = {},
) {
  if (!state || !pcmLittleEndian?.length) return browserAudioBufferSnapshot(state)

  const sampleRate = positiveNumber(state.sampleRate || state.config?.sampleRate, 16_000)
  const boundedDurationMs = Math.max(
    20,
    positiveNumber(maxDurationMs, DEFAULT_BROWSER_AUDIO_ATTACH_BUFFER_MS),
  )
  const maxBytes = Math.max(
    2,
    Math.floor((sampleRate * 2 * boundedDurationMs) / 1_000 / 2) * 2,
  )
  const alignedLength = pcmLittleEndian.length - (pcmLittleEndian.length % 2)
  if (!alignedLength) return browserAudioBufferSnapshot(state)

  state.browserAudioAttachFrames ||= []
  state.browserAudioAttachBytes = Number(state.browserAudioAttachBytes || 0)
  state.browserAudioAttachDroppedFrames ||= 0
  state.browserAudioAttachDroppedBytes ||= 0
  state.browserAudioAttachMaxDurationMs = boundedDurationMs

  const availableBytes = Math.max(0, maxBytes - state.browserAudioAttachBytes)
  const retainedBytes = Math.min(alignedLength, availableBytes)
  if (retainedBytes > 0) {
    state.browserAudioAttachFrames.push(
      Buffer.from(pcmLittleEndian.subarray(0, retainedBytes)),
    )
    state.browserAudioAttachBytes += retainedBytes
  }

  const droppedBytes = alignedLength - retainedBytes
  if (droppedBytes > 0) {
    state.browserAudioAttachDroppedFrames += 1
    state.browserAudioAttachDroppedBytes += droppedBytes
  }

  return browserAudioBufferSnapshot(state)
}

export function drainBrowserAudioBeforeAttach(state) {
  const snapshot = browserAudioBufferSnapshot(state)
  const frames = Array.isArray(state?.browserAudioAttachFrames)
    ? state.browserAudioAttachFrames
    : []
  resetBrowserAudioBuffer(state)
  return { ...snapshot, frames }
}

export function clearBrowserAudioBeforeAttach(state) {
  const snapshot = browserAudioBufferSnapshot(state)
  resetBrowserAudioBuffer(state)
  return snapshot
}

export function bufferVoiceInputBeforeReady(
  state,
  pcmLittleEndian,
  { maxDurationMs = DEFAULT_VOICE_PRE_READY_BUFFER_MS } = {},
) {
  if (!state || !pcmLittleEndian?.length) return voiceInputBufferSnapshot(state)

  const sampleRate = positiveNumber(state.sampleRate || state.config?.sampleRate, 16_000)
  const boundedDurationMs = Math.max(20, positiveNumber(maxDurationMs, DEFAULT_VOICE_PRE_READY_BUFFER_MS))
  const maxBytes = Math.max(2, Math.floor((sampleRate * 2 * boundedDurationMs) / 1_000))
  const frame = Buffer.from(pcmLittleEndian.subarray(0, pcmLittleEndian.length - (pcmLittleEndian.length % 2)))
  if (!frame.length) return voiceInputBufferSnapshot(state)

  state.voiceInputPreReadyFrames ||= []
  state.voiceInputPreReadyFrameMeta ||= []
  state.voiceInputPreReadyFrames.push(frame)
  state.voiceInputPreReadyFrameMeta.push({ speech: pcmFrameContainsSpeech(frame) })
  state.voiceInputPreReadyBytes = Number(state.voiceInputPreReadyBytes || 0) + frame.length
  state.voiceInputPreReadyDroppedFrames ||= 0
  state.voiceInputPreReadyDroppedBytes ||= 0
  state.voiceInputPreReadyDroppedSpeechFrames ||= 0
  state.voiceInputPreReadyDroppedSilenceFrames ||= 0
  state.voiceInputPreReadyMaxDurationMs = boundedDurationMs

  while (state.voiceInputPreReadyBytes > maxBytes && state.voiceInputPreReadyFrames.length) {
    const dropIndex = preferredPreReadyDropIndex(state)
    const oldest = state.voiceInputPreReadyFrames[dropIndex]
    const metadata = state.voiceInputPreReadyFrameMeta[dropIndex] || {
      speech: pcmFrameContainsSpeech(oldest),
    }
    const overflowBytes = state.voiceInputPreReadyBytes - maxBytes
    if (oldest.length <= overflowBytes) {
      state.voiceInputPreReadyFrames.splice(dropIndex, 1)
      state.voiceInputPreReadyFrameMeta.splice(dropIndex, 1)
      state.voiceInputPreReadyBytes -= oldest.length
      state.voiceInputPreReadyDroppedFrames += 1
      state.voiceInputPreReadyDroppedBytes += oldest.length
      if (metadata.speech) state.voiceInputPreReadyDroppedSpeechFrames += 1
      else state.voiceInputPreReadyDroppedSilenceFrames += 1
      continue
    }

    const trimBytes = Math.min(oldest.length, Math.ceil(overflowBytes / 2) * 2)
    state.voiceInputPreReadyFrames[dropIndex] = oldest.subarray(trimBytes)
    state.voiceInputPreReadyBytes -= trimBytes
    state.voiceInputPreReadyDroppedBytes += trimBytes
  }

  return voiceInputBufferSnapshot(state)
}

export function drainVoiceInputBeforeReady(state) {
  const snapshot = voiceInputBufferSnapshot(state)
  const frames = Array.isArray(state?.voiceInputPreReadyFrames)
    ? state.voiceInputPreReadyFrames
    : []

  if (state) {
    state.voiceInputPreReadyFrames = []
    state.voiceInputPreReadyFrameMeta = []
    state.voiceInputPreReadyBytes = 0
    state.voiceInputPreReadyDroppedFrames = 0
    state.voiceInputPreReadyDroppedBytes = 0
    state.voiceInputPreReadyDroppedSpeechFrames = 0
    state.voiceInputPreReadyDroppedSilenceFrames = 0
  }

  return { ...snapshot, frames }
}

export function clearVoiceInputBeforeReady(state) {
  const snapshot = voiceInputBufferSnapshot(state)
  if (state) {
    state.voiceInputPreReadyFrames = []
    state.voiceInputPreReadyFrameMeta = []
    state.voiceInputPreReadyBytes = 0
    state.voiceInputPreReadyDroppedFrames = 0
    state.voiceInputPreReadyDroppedBytes = 0
    state.voiceInputPreReadyDroppedSpeechFrames = 0
    state.voiceInputPreReadyDroppedSilenceFrames = 0
  }
  return snapshot
}

export function selectHumeUserInputTransport({ webSocketOpen = false, chatId = '' } = {}) {
  if (webSocketOpen) return 'websocket'
  if (String(chatId || '').trim()) return 'control_plane'
  return ''
}

export function shouldEmitFinalUserTranscript(
  state,
  content,
  { nowMs = Date.now(), providerEventId = '' } = {},
) {
  const normalized = normalizeTranscriptText(content)
  if (!state || !normalized) return false

  state.finalUserTranscriptDedupe ||= new Map()
  const normalizedProviderEventId = String(providerEventId || '').trim()
  const dedupeKey = normalizedProviderEventId
    ? `provider:${normalizedProviderEventId}`
    : `text:${normalized.toLowerCase()}`
  const now = timestamp(nowMs) ?? Date.now()
  const lastSeenAt = state.finalUserTranscriptDedupe.get(dedupeKey)
  if (
    lastSeenAt !== undefined &&
    (normalizedProviderEventId || now - lastSeenAt < 2_000)
  ) {
    return false
  }

  state.finalUserTranscriptDedupe.set(dedupeKey, now)
  if (state.finalUserTranscriptDedupe.size > 80) {
    state.finalUserTranscriptDedupe = new Map(
      [...state.finalUserTranscriptDedupe.entries()].slice(-40),
    )
  }

  if (consumeSyntheticUserInput(state, normalized)) return false
  return true
}

export function noteCallerSpeechStopped(
  state,
  { provider, atMs = Date.now() } = {},
) {
  const normalizedProvider = normalizeProvider(provider)
  const normalizedAtMs = timestamp(atMs)
  if (!state || !normalizedProvider || normalizedAtMs === null) return null

  state.pendingCallerSpeechStop = {
    provider: normalizedProvider,
    atMs: normalizedAtMs,
  }
  return state.pendingCallerSpeechStop
}

export function noteVoiceInputPcmActivity(
  state,
  pcmLittleEndian,
  {
    atMs = Date.now(),
    sampleRate,
    peakThresholdRatio = DEFAULT_VOICE_ACTIVITY_PEAK_THRESHOLD_RATIO,
    rmsThresholdRatio = DEFAULT_VOICE_ACTIVITY_RMS_THRESHOLD_RATIO,
  } = {},
) {
  const normalizedAtMs = timestamp(atMs)
  const normalizedSampleRate = positiveNumber(
    sampleRate || state?.sampleRate || state?.config?.sampleRate,
    16_000,
  )
  const evenLength = Number(pcmLittleEndian?.length || 0) -
    (Number(pcmLittleEndian?.length || 0) % 2)
  if (!state || normalizedAtMs === null || evenLength < 2) return null

  const sampleCount = evenLength / 2
  const minimumPeak = Math.max(1, Math.round(32767 * peakThresholdRatio))
  const minimumRms = Math.max(1, Math.round(32767 * rmsThresholdRatio))
  let peak = 0
  let sumSquares = 0
  let lastActiveSample = -1
  for (let offset = 0; offset < evenLength; offset += 2) {
    const magnitude = Math.abs(pcmLittleEndian.readInt16LE(offset))
    peak = Math.max(peak, magnitude)
    sumSquares += magnitude * magnitude
    if (magnitude >= minimumPeak) lastActiveSample = offset / 2
  }
  const rms = Math.sqrt(sumSquares / sampleCount)
  const active = lastActiveSample >= 0 && peak >= minimumPeak && rms >= minimumRms
  const frameDurationMs = (sampleCount / normalizedSampleRate) * 1_000
  const activity = {
    active,
    atMs: normalizedAtMs,
    frameDurationMs,
    peakRatio: peak / 32767,
    rmsRatio: rms / 32767,
    peakThresholdRatio,
    rmsThresholdRatio,
  }
  state.lastVoiceInputActivity = activity
  if (!active) return activity

  const trailingSamples = sampleCount - lastActiveSample - 1
  const speechAtMs = Math.max(
    0,
    normalizedAtMs - (trailingSamples / normalizedSampleRate) * 1_000,
  )
  state.lastVoiceInputSpeechAtMs = Math.max(
    Number(state.lastVoiceInputSpeechAtMs || 0),
    speechAtMs,
  )
  state.lastVoiceInputActivity = {
    ...activity,
    speechAtMs: state.lastVoiceInputSpeechAtMs,
  }
  return state.lastVoiceInputActivity
}

export function conditionPhoneVoiceInputPcm(
  state,
  pcmLittleEndian,
  {
    atMs = Date.now(),
    sampleRate,
    hangoverMs = DEFAULT_PHONE_INPUT_SILENCE_GATE_HANGOVER_MS,
    responseBoundaryMs = DEFAULT_PHONE_INPUT_RESPONSE_BOUNDARY_MS,
    peakThresholdRatio = DEFAULT_PHONE_INPUT_ACTIVITY_PEAK_THRESHOLD_RATIO,
    rmsThresholdRatio = DEFAULT_PHONE_INPUT_ACTIVITY_RMS_THRESHOLD_RATIO,
  } = {},
) {
  const normalizedAtMs = timestamp(atMs)
  const activity = noteVoiceInputPcmActivity(state, pcmLittleEndian, {
    atMs,
    sampleRate,
    peakThresholdRatio,
    rmsThresholdRatio,
  })
  if (!state || normalizedAtMs === null || !pcmLittleEndian?.length || !activity) {
    return {
      activity,
      pcm: pcmLittleEndian,
      suppressed: false,
    }
  }

  const conditioner =
    state.phoneVoiceInputConditioner ||
    {
      pendingCallerStopAtMs: null,
      speechSeen: false,
      suppressedBytes: 0,
      suppressedFrames: 0,
    }
  state.phoneVoiceInputConditioner = conditioner

  if (activity.active) {
    conditioner.speechSeen = true
    conditioner.lastSpeechAtMs = timestamp(activity.speechAtMs) ?? normalizedAtMs
    conditioner.lastActivityAtMs = normalizedAtMs
    return {
      activity,
      pcm: pcmLittleEndian,
      suppressed: false,
    }
  }

  const lastSpeechAtMs = timestamp(conditioner.lastSpeechAtMs)
  if (!conditioner.speechSeen || lastSpeechAtMs === null) {
    return {
      activity,
      pcm: pcmLittleEndian,
      suppressed: false,
    }
  }

  const silenceDurationMs = Math.max(0, normalizedAtMs - lastSpeechAtMs)
  const boundedResponseBoundaryMs = Math.max(
    250,
    positiveNumber(responseBoundaryMs, DEFAULT_PHONE_INPUT_RESPONSE_BOUNDARY_MS),
  )
  const lastRespondedCallerStopAtMs = optionalTimestamp(
    conditioner.lastRespondedCallerStopAtMs,
  )
  if (
    silenceDurationMs >= boundedResponseBoundaryMs &&
    optionalTimestamp(conditioner.pendingCallerStopAtMs) === null &&
    (lastRespondedCallerStopAtMs === null || lastSpeechAtMs > lastRespondedCallerStopAtMs)
  ) {
    conditioner.pendingCallerStopAtMs = lastSpeechAtMs
  }

  const boundedHangoverMs = Math.max(
    40,
    positiveNumber(hangoverMs, DEFAULT_PHONE_INPUT_SILENCE_GATE_HANGOVER_MS),
  )
  if (silenceDurationMs <= boundedHangoverMs || isDigitalSilence(pcmLittleEndian)) {
    return {
      activity,
      pcm: pcmLittleEndian,
      suppressed: false,
    }
  }

  const conditioned = Buffer.alloc(pcmLittleEndian.length)
  conditioner.suppressedFrames += 1
  conditioner.suppressedBytes += conditioned.length
  conditioner.lastSuppressedAtMs = normalizedAtMs
  return {
    activity,
    pcm: conditioned,
    suppressed: true,
  }
}

export function noteFinalUserTurn(
  state,
  {
    provider,
    atMs = Date.now(),
    configuredTurnSilenceMs,
  } = {},
) {
  const normalizedProvider = normalizeProvider(provider)
  const normalizedAtMs = timestamp(atMs)
  if (!state || !normalizedProvider || normalizedAtMs === null) return null

  const configuredSilenceMs = nonNegativeNumber(configuredTurnSilenceMs)
  const providerSpeechStop = state.pendingCallerSpeechStop
  const hasProviderSpeechStop = Boolean(
    providerSpeechStop?.provider === normalizedProvider &&
      providerSpeechStop.atMs <= normalizedAtMs + 1_000 &&
      normalizedAtMs - providerSpeechStop.atMs <= 30_000,
  )
  const localSpeechStopAtMs = timestamp(state.lastVoiceInputSpeechAtMs)
  const previousFinalUserAtMs = timestamp(state.lastVoiceTurnFinalAtMs)
  const hasLocalSpeechStop = Boolean(
    localSpeechStopAtMs !== null &&
      localSpeechStopAtMs <= normalizedAtMs + 1_000 &&
      normalizedAtMs - localSpeechStopAtMs <= 30_000 &&
      (previousFinalUserAtMs === null || localSpeechStopAtMs > previousFinalUserAtMs),
  )
  const callerStopAtMs = hasProviderSpeechStop
    ? providerSpeechStop.atMs
    : hasLocalSpeechStop
      ? localSpeechStopAtMs
      : configuredSilenceMs === null
        ? null
        : normalizedAtMs - configuredSilenceMs
  const callerStopSource = hasProviderSpeechStop
    ? 'provider_speech_stopped'
    : hasLocalSpeechStop
      ? 'local_pcm_activity_estimate'
      : configuredSilenceMs === null
        ? ''
        : 'configured_turn_silence_estimate'
  const sequence = Number(state.voiceTurnSequence || 0) + 1
  const audioPacketsAtFinalUserTurn = Math.max(
    0,
    Math.floor(Number(state.audioPacketsSent || 0)),
  )

  state.voiceTurnSequence = sequence
  state.lastVoiceTurnFinalAtMs = normalizedAtMs
  state.assistantAudioPacketsAtLastUserTurn = audioPacketsAtFinalUserTurn
  state.pendingVoiceTurnTiming = {
    sequence,
    provider: normalizedProvider,
    finalUserAtMs: normalizedAtMs,
    callerStopAtMs,
    callerStopSource,
    configuredTurnSilenceMs: configuredSilenceMs,
    audioPacketsAtFinalUserTurn,
    assistantAudioRecorded: false,
  }
  if (hasProviderSpeechStop) state.pendingCallerSpeechStop = null
  return state.pendingVoiceTurnTiming
}

export function assistantTurnHasAudio(state) {
  if (!state) return false
  const audioPacketsSent = Math.max(0, Math.floor(Number(state.audioPacketsSent || 0)))
  const audioPacketsAtLastUserTurn = Math.max(
    0,
    Math.floor(Number(state.assistantAudioPacketsAtLastUserTurn || 0)),
  )
  return audioPacketsSent > audioPacketsAtLastUserTurn
}

export function noteFirstAssistantAudio(
  state,
  { provider, atMs = Date.now() } = {},
) {
  const normalizedProvider = normalizeProvider(provider)
  const normalizedAtMs = timestamp(atMs)
  const audibleTiming = consumeConditionedCallerResponseTiming(state, {
    provider: normalizedProvider,
    atMs: normalizedAtMs,
  })
  const turn = state?.pendingVoiceTurnTiming
  if (
    !turn ||
    !normalizedProvider ||
    normalizedAtMs === null ||
    turn.provider !== normalizedProvider ||
    turn.assistantAudioRecorded ||
    normalizedAtMs < turn.finalUserAtMs
  ) {
    return audibleTiming
  }

  turn.assistantAudioRecorded = true
  const result = {
    sequence: turn.sequence,
    provider: turn.provider,
    finalUserToAssistantAudioMs: normalizedAtMs - turn.finalUserAtMs,
    ...(turn.callerStopAtMs === null
      ? {}
      : { callerStopToAssistantAudioMs: normalizedAtMs - turn.callerStopAtMs }),
    ...(turn.callerStopSource ? { callerStopSource: turn.callerStopSource } : {}),
    ...(turn.configuredTurnSilenceMs === null
      ? {}
      : { configuredTurnSilenceMs: turn.configuredTurnSilenceMs }),
    ...(audibleTiming || {}),
  }
  state.lastVoiceTurnLatency = result
  return result
}

function consumeConditionedCallerResponseTiming(
  state,
  { provider, atMs } = {},
) {
  const conditioner = state?.phoneVoiceInputConditioner
  const callerStopAtMs = optionalTimestamp(conditioner?.pendingCallerStopAtMs)
  if (!provider || atMs === null || callerStopAtMs === null || atMs < callerStopAtMs) {
    return null
  }

  conditioner.pendingCallerStopAtMs = null
  conditioner.lastRespondedCallerStopAtMs = callerStopAtMs
  conditioner.lastAssistantAudioAtMs = atMs
  return {
    provider,
    audibleCallerStopToAssistantAudioMs: atMs - callerStopAtMs,
    audibleCallerStopSource: 'conditioned_phone_pcm_activity',
  }
}

function voiceInputBufferSnapshot(state) {
  const sampleRate = positiveNumber(state?.sampleRate || state?.config?.sampleRate, 16_000)
  const bufferedBytes = Number(state?.voiceInputPreReadyBytes || 0)
  const frames = Array.isArray(state?.voiceInputPreReadyFrames)
    ? state.voiceInputPreReadyFrames
    : []
  const metadata = Array.isArray(state?.voiceInputPreReadyFrameMeta)
    ? state.voiceInputPreReadyFrameMeta
    : []
  let speechFrames = 0
  let speechBytes = 0
  frames.forEach((frame, index) => {
    const speech = metadata[index]?.speech ?? pcmFrameContainsSpeech(frame)
    if (!speech) return
    speechFrames += 1
    speechBytes += frame.length
  })
  return {
    bufferedFrames: frames.length,
    bufferedBytes,
    bufferedDurationMs: Math.round((bufferedBytes / (sampleRate * 2)) * 1_000),
    speechFrames,
    speechBytes,
    droppedFrames: Number(state?.voiceInputPreReadyDroppedFrames || 0),
    droppedBytes: Number(state?.voiceInputPreReadyDroppedBytes || 0),
    droppedSpeechFrames: Number(state?.voiceInputPreReadyDroppedSpeechFrames || 0),
    droppedSilenceFrames: Number(state?.voiceInputPreReadyDroppedSilenceFrames || 0),
    maxDurationMs: positiveNumber(
      state?.voiceInputPreReadyMaxDurationMs,
      DEFAULT_VOICE_PRE_READY_BUFFER_MS,
    ),
  }
}

function browserAudioBufferSnapshot(state) {
  const sampleRate = positiveNumber(state?.sampleRate || state?.config?.sampleRate, 16_000)
  const frames = Array.isArray(state?.browserAudioAttachFrames)
    ? state.browserAudioAttachFrames
    : []
  const bufferedBytes = Number(state?.browserAudioAttachBytes || 0)
  return {
    bufferedFrames: frames.length,
    bufferedBytes,
    bufferedDurationMs: Math.round((bufferedBytes / (sampleRate * 2)) * 1_000),
    droppedFrames: Number(state?.browserAudioAttachDroppedFrames || 0),
    droppedBytes: Number(state?.browserAudioAttachDroppedBytes || 0),
    maxDurationMs: positiveNumber(
      state?.browserAudioAttachMaxDurationMs,
      DEFAULT_BROWSER_AUDIO_ATTACH_BUFFER_MS,
    ),
  }
}

function resetBrowserAudioBuffer(state) {
  if (!state) return
  state.browserAudioAttachFrames = []
  state.browserAudioAttachBytes = 0
  state.browserAudioAttachDroppedFrames = 0
  state.browserAudioAttachDroppedBytes = 0
}

function preferredPreReadyDropIndex(state) {
  const frames = state.voiceInputPreReadyFrames || []
  const metadata = state.voiceInputPreReadyFrameMeta || []
  const silenceIndex = frames.findIndex((frame, index) => {
    const speech = metadata[index]?.speech ?? pcmFrameContainsSpeech(frame)
    return !speech
  })
  return silenceIndex >= 0 ? silenceIndex : 0
}

function pcmFrameContainsSpeech(frame, threshold = 0.003) {
  if (!frame?.length) return false
  const evenLength = frame.length - (frame.length % 2)
  const minimumPeak = Math.max(1, Math.round(32767 * threshold))
  for (let offset = 0; offset < evenLength; offset += 2) {
    if (Math.abs(frame.readInt16LE(offset)) >= minimumPeak) return true
  }
  return false
}

function isDigitalSilence(frame) {
  if (!frame?.length) return true
  for (const sample of frame) {
    if (sample !== 0) return false
  }
  return true
}

function normalizeProvider(value) {
  const provider = String(value || '').trim().toLowerCase()
  return provider === 'hume' || provider === 'inworld' ? provider : ''
}

function timestamp(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

function optionalTimestamp(value) {
  if (value === undefined || value === null || value === '') return null
  return timestamp(value)
}

function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function nonNegativeNumber(value) {
  if (value === undefined || value === null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

export function consumeSyntheticUserInput(state, normalized) {
  if (!state?.syntheticUserInputs || !normalized) return false
  if (state.syntheticUserInputs.has(normalized)) {
    state.syntheticUserInputs.delete(normalized)
    return true
  }
  for (const synthetic of state.syntheticUserInputs) {
    const normalizedSynthetic = normalizeTranscriptText(synthetic)
    if (!normalizedSynthetic) continue
    if (
      normalized.startsWith(normalizedSynthetic.slice(0, 80)) ||
      normalizedSynthetic.startsWith(normalized.slice(0, 80))
    ) {
      state.syntheticUserInputs.delete(synthetic)
      return true
    }
  }
  return /^the outbound phone call is connected now\./i.test(normalized)
}

function normalizeTranscriptText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}
