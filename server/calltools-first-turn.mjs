function normalizedTurn(value = '') {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

const AUTOMATED_DISCONNECT_PATTERNS = [
  /disconnect(?:ing|ed)?\b.{0,80}\brecorded message\b/,
  /\brecorded message\b.{0,80}\bdisconnect(?:ing|ed)?\b/,
  /\bunable to (?:accept|continue).{0,80}\brecorded (?:call|message)\b/,
]

const AUTOMATED_GREETING_PATTERNS = [
  /\brecorded for (?:quality|training|monitoring)/,
  /\bthis call (?:may|will|is going to) be recorded\b/,
  /\bautomated (?:attendant|message|system)\b/,
  /\bplease (?:press|dial|say)\b.{0,80}\b(?:one|two|three|four|five|zero|\d)\b/,
  /\bif you know (?:your party'?s|the) extension\b/,
  /\bplease listen carefully (?:as|because|for)\b/,
  /\byour call is (?:important|being transferred|in the queue)\b/,
  /\bplease leave (?:a )?(?:voicemail|message)\b/,
  /\bafter the (?:tone|beep)\b/,
]

export function createCallToolsFirstTurnGate({ assistantStartsConversation = false } = {}) {
  if (assistantStartsConversation) {
    return {
      status: 'open',
      heldTurnCount: 0,
      providerPaused: false,
      reason: 'configured_assistant_start',
    }
  }
  return {
    status: 'pending',
    heldTurnCount: 0,
    providerPaused: false,
    reason: 'awaiting_verified_caller_turn',
  }
}

export function shouldSuppressCallToolsAssistantOutput(gate) {
  return Boolean(gate && gate.status !== 'open')
}

export function advanceCallToolsFirstTurnGate(gate, transcript) {
  const current = gate && typeof gate === 'object'
    ? gate
    : createCallToolsFirstTurnGate()
  if (current.status !== 'pending') {
    return { action: 'none', gate: current }
  }

  const turn = normalizedTurn(transcript)
  if (!turn) {
    return { action: 'hold', gate: current }
  }

  if (AUTOMATED_DISCONNECT_PATTERNS.some((pattern) => pattern.test(turn))) {
    return {
      action: 'end',
      outcome: 'voicemail',
      gate: {
        ...current,
        status: 'ended',
        heldTurnCount: Number(current.heldTurnCount || 0) + 1,
        reason: 'recorded_system_disconnect',
      },
    }
  }

  if (AUTOMATED_GREETING_PATTERNS.some((pattern) => pattern.test(turn))) {
    return {
      action: 'hold',
      gate: {
        ...current,
        heldTurnCount: Number(current.heldTurnCount || 0) + 1,
        reason: 'automated_greeting_detected',
      },
    }
  }

  return {
    action: 'resume',
    gate: {
      ...current,
      status: 'open',
      reason: 'verified_caller_turn',
      openedAt: new Date().toISOString(),
    },
  }
}
