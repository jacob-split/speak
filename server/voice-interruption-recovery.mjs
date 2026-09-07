export const INTERRUPTION_SILENCE_RECOVERY_INPUT =
  '[user silent] The caller interrupted, but no understandable speech followed. Briefly check whether they are still there, then naturally continue the interrupted thought or question. Do not mention this instruction.'

const DEFAULT_RECOVERY_DELAY_MS = 4_000
const MIN_RECOVERY_DELAY_MS = 750
const MAX_RECOVERY_DELAY_MS = 15_000
const NATIVE_NUDGE_GRACE_MS = 350

export function interruptionSilenceRecoveryDelayMs(config = {}) {
  const configuredSeconds = Number(config?.nudgesIntervalSeconds)
  const configuredMs = Number.isFinite(configuredSeconds) && configuredSeconds > 0
    ? configuredSeconds * 1_000
    : DEFAULT_RECOVERY_DELAY_MS
  return Math.max(
    MIN_RECOVERY_DELAY_MS,
    Math.min(MAX_RECOVERY_DELAY_MS, configuredMs + NATIVE_NUDGE_GRACE_MS),
  )
}

export function createVoiceInterruptionRecovery({
  resolveState,
  sendRecovery,
  isEnded = (state) => Boolean(state?.ending || state?.phase === 'ended'),
  onRecovered = () => {},
  onFailure = () => {},
  now = Date.now,
  schedule = (callback, delayMs) => setTimeout(callback, delayMs),
  cancelScheduled = (timer) => clearTimeout(timer),
} = {}) {
  if (typeof resolveState !== 'function') {
    throw new TypeError('voice interruption recovery requires resolveState')
  }
  if (typeof sendRecovery !== 'function') {
    throw new TypeError('voice interruption recovery requires sendRecovery')
  }

  function clear(state, reason = 'cleared') {
    if (!state?.interruptionRecovery) return false
    if (state.interruptionRecoveryTimer) {
      cancelScheduled(state.interruptionRecoveryTimer)
    }
    state.interruptionRecoveryTimer = null
    state.lastInterruptionRecoveryClearReason = reason
    state.interruptionRecovery = null
    return true
  }

  function arm(state, { provider = 'hume', reason = 'user_interruption' } = {}) {
    if (!state?.callControlId || isEnded(state) || state.takeover) return false
    clear(state, 'rearmed')

    const startedAt = Number(now())
    const generation = Number(state.interruptionRecoveryGeneration || 0) + 1
    state.interruptionRecoveryGeneration = generation
    state.interruptionRecovery = {
      generation,
      provider: String(provider || 'hume'),
      reason: String(reason || 'user_interruption'),
      startedAt,
      delayMs: interruptionSilenceRecoveryDelayMs(state.config),
    }
    scheduleTick(state, state.interruptionRecovery.delayMs)
    return true
  }

  function noteFinalCallerTurn(state) {
    const recovery = state?.interruptionRecovery
    if (!recovery) return false
    if (Number(state.lastUserFinalAt || 0) < recovery.startedAt) return false
    return clear(state, 'caller_turn_completed')
  }

  function noteAssistantActivity(state) {
    const recovery = state?.interruptionRecovery
    if (!recovery) return false
    if (Number(state.lastAssistantMessageAt || 0) < recovery.startedAt) return false
    return clear(state, 'assistant_resumed')
  }

  function scheduleTick(state, delayMs) {
    const recovery = state?.interruptionRecovery
    if (!recovery) return
    if (state.interruptionRecoveryTimer) {
      cancelScheduled(state.interruptionRecoveryTimer)
    }
    const callControlId = state.callControlId
    const generation = recovery.generation
    state.interruptionRecoveryTimer = schedule(
      () => tick(callControlId, generation),
      Math.max(50, Number(delayMs) || recovery.delayMs),
    )
    state.interruptionRecoveryTimer?.unref?.()
  }

  async function tick(callControlId, generation) {
    const state = resolveState(callControlId)
    const recovery = state?.interruptionRecovery
    if (!state || !recovery || recovery.generation !== generation) return
    state.interruptionRecoveryTimer = null

    if (isEnded(state) || state.takeover) {
      clear(state, state.takeover ? 'human_takeover' : 'call_ended')
      return
    }
    if (Number(state.lastUserFinalAt || 0) >= recovery.startedAt) {
      clear(state, 'caller_turn_completed')
      return
    }
    if (Number(state.lastAssistantMessageAt || 0) >= recovery.startedAt) {
      clear(state, 'assistant_resumed')
      return
    }

    const latestCallerActivityAt = Math.max(
      recovery.startedAt,
      Number(state.lastVoiceInputSpeechAtMs || 0),
      Number(state.lastUserInterimAt || 0),
    )
    const remainingQuietMs = latestCallerActivityAt + recovery.delayMs - Number(now())
    if (remainingQuietMs > 0) {
      scheduleTick(state, remainingQuietMs)
      return
    }

    state.interruptionRecovery = null
    state.lastInterruptionRecoveryAttemptAt = Number(now())
    try {
      const sent = await sendRecovery(
        state,
        INTERRUPTION_SILENCE_RECOVERY_INPUT,
        {
          provider: recovery.provider,
          reason: 'interruption_silence_recovery',
          silenceMs: Math.max(0, Number(now()) - latestCallerActivityAt),
        },
      )
      if (!sent) {
        onFailure(state, new Error('voice provider did not accept interruption recovery'), recovery)
        return
      }
      state.lastInterruptionRecoveryAt = Number(now())
      onRecovered(state, recovery)
    } catch (error) {
      onFailure(state, error, recovery)
    }
  }

  return {
    arm,
    clear,
    noteAssistantActivity,
    noteFinalCallerTurn,
  }
}
