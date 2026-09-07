import { randomUUID } from 'node:crypto'

export const OPERATOR_CHAT_SCHEMA_VERSION = 'speak.operator-chat.v1'

const FUTURE_SCOPE_PATTERN =
  /\b(always|future|next calls?|every call|all calls|from now on|going forward|rest of (?:the )?campaign)\b/i
const CONFIG_REPLACE_PATTERN =
  /\b(?:replace|set|rewrite)\b[\s\S]{0,60}\b(?:prompt|system message|instructions?)\b(?:\s*(?:to|as|:|-)\s*)([\s\S]+)/i
const CONFIG_APPEND_PATTERN =
  /\b(?:add|append|include|tell|instruct|make|have|ask|say|avoid|never|always|when|if|do not|don't|dont)\b/i
const SAVE_PATTERN = /\b(save|sync)\b/i
const USE_PATTERN = /\b(use|activate|make active|set active)\b/i
const QUESTION_PATTERN =
  /(?:\?\s*$)|^\s*(?:what|why|how|when|where|who|which|can|could|should|would|is|are|do|does|did)\b/i
const SMALL_TALK_PATTERN =
  /^(?:hi|hello|hey|thanks|thank you|ok|okay|cool|nice|good|great|got it|test)\.?$/i

const BOOLEAN_SETTING_RULES = [
  {
    key: 'webSearchEnabled',
    subject: /\b(web search|search the web|web lookup)\b/i,
    label: 'web search',
  },
  {
    key: 'hangUpEnabled',
    subject: /\b(hang ?up|end the call|ending calls?)\b/i,
    label: 'hang up',
  },
  {
    key: 'allowShortResponses',
    subject: /\b(short responses?|concise|brief)\b/i,
    label: 'short responses',
  },
  {
    key: 'interruptionEnabled',
    subject: /\b(interruptions?|barge ?in|cut in)\b/i,
    label: 'interruption handling',
  },
  {
    key: 'turnDetectionEnabled',
    subject: /\b(turn detection|detect turns?|end of turn)\b/i,
    label: 'turn detection',
  },
  {
    key: 'nudgesEnabled',
    subject: /\b(nudges?|follow[- ]?up nudges?)\b/i,
    label: 'nudges',
  },
  {
    key: 'eviStartsConversation',
    subject: /\b(starts? conversation|opens? conversation|greeting|speak first)\b/i,
    label: 'assistant starts conversation',
  },
]

const TEST_VARIABLE_RULES = [
  {
    key: 'first_name',
    aliases: ['first name', 'first_name'],
  },
  {
    key: 'last_name',
    aliases: ['last name', 'last_name'],
  },
  {
    key: 'full_name',
    aliases: ['full name', 'full_name', 'name'],
  },
  {
    key: 'business_name',
    aliases: ['business name', 'business_name', 'company', 'business'],
  },
  {
    key: 'contact_phone',
    aliases: ['contact phone', 'contact_phone', 'phone'],
  },
  {
    key: 'contact_email',
    aliases: ['contact email', 'contact_email', 'email'],
  },
  {
    key: 'notes',
    aliases: ['notes', 'note'],
  },
]

function cleanText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ')
}

function appendInstruction(existing, instruction) {
  const base = String(existing || '').trim()
  const text = cleanText(instruction)
  if (!base) return text
  return `${base}\n\nOperator update: ${text}`
}

function wantsDisabled(message) {
  return /\b(disable|turn off|shut off|remove|stop|don't|dont|do not|no longer|without)\b/i.test(
    message,
  )
}

function wantsEnabled(message) {
  return /\b(enable|turn on|allow|use|include|with|start|resume)\b/i.test(message)
}

function parseBooleanSettings(message) {
  const patch = {}
  const labels = []

  BOOLEAN_SETTING_RULES.forEach((rule) => {
    if (!rule.subject.test(message)) return
    if (wantsDisabled(message)) {
      patch[rule.key] = false
      labels.push(`${rule.label} off`)
      return
    }
    if (wantsEnabled(message)) {
      patch[rule.key] = true
      labels.push(`${rule.label} on`)
    }
  })

  return { patch, labels }
}

function parseNumberSettings(message) {
  const patch = {}
  const labels = []
  const temperature = message.match(/\btemperature\b(?:\s*(?:to|at|=|:)\s*)(0(?:\.\d+)?|1(?:\.0+)?)/i)
  if (temperature) {
    patch.languageModelTemperature = Number(temperature[1])
    labels.push(`temperature ${temperature[1]}`)
  }

  const inactivity = message.match(/\binactivity\b[\s\S]{0,40}\b(\d{1,3})\s*(?:s|sec|seconds?)\b/i)
  if (inactivity) {
    patch.inactivityTimeoutEnabled = true
    patch.inactivityTimeoutSeconds = Number(inactivity[1])
    labels.push(`inactivity ${inactivity[1]}s`)
  }

  const maxDuration = message.match(/\b(max duration|maximum duration|call limit)\b[\s\S]{0,40}\b(\d{1,4})\s*(?:s|sec|seconds?)\b/i)
  if (maxDuration) {
    patch.maxDurationTimeoutEnabled = true
    patch.maxDurationTimeoutSeconds = Number(maxDuration[2])
    labels.push(`max duration ${maxDuration[2]}s`)
  }

  const silence = message.match(/\b(silence|end of turn|pause)\b[\s\S]{0,40}\b(\d{2,5})\s*(?:ms|milliseconds?)\b/i)
  if (silence) {
    patch.endOfTurnSilenceMs = Number(silence[2])
    labels.push(`silence ${silence[2]}ms`)
  }

  return { patch, labels }
}

function parseTestVariables(message) {
  const patch = {}

  TEST_VARIABLE_RULES.forEach((rule) => {
    for (const alias of rule.aliases) {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const match = message.match(
        new RegExp(`\\b${escaped}\\b\\s*(?:to|as|=|:|-)\\s*([^,;\\n]+)`, 'i'),
      )
      if (match?.[1]) {
        patch[rule.key] = match[1].trim()
        return
      }
    }
  })

  const testWith = message.match(/\btest with\s+([A-Za-z][A-Za-z' -]{1,60})(?:\s+at\s+([^,.;\n]+))?/i)
  if (testWith?.[1] && !patch.full_name) {
    const fullName = testWith[1].trim()
    patch.full_name = fullName
    const parts = fullName.split(/\s+/)
    if (parts[0] && !patch.first_name) patch.first_name = parts[0]
    if (parts.length > 1 && !patch.last_name) patch.last_name = parts.slice(1).join(' ')
  }
  if (testWith?.[2] && !patch.business_name) {
    patch.business_name = testWith[2].trim()
  }

  return patch
}

function parseProfileName(message) {
  const match = message.match(
    /\b(?:name|rename|call)\b\s+(?:this\s+)?(?:profile|agent|config)?\s*(?:to|as|:)?\s*["']?([^"'.\n]{2,60})["']?/i,
  )
  if (!match?.[1]) return ''
  return cleanText(match[1]).replace(/\b(profile|agent|config)$/i, '').trim()
}

function isReadbackTurn(message) {
  return QUESTION_PATTERN.test(message) || SMALL_TALK_PATTERN.test(cleanText(message))
}

function buildConfigReadbackMessage(context = {}) {
  const currentProfile = context.profile || context.draftProfile || {}
  const profileName = cleanText(currentProfile.name)
  if (profileName) {
    return `I'm with you on ${profileName}. I'll use the current draft, test state, and visible config context to turn plain-language requests into changes.`
  }
  return "I'm with you. I'll use the current Speak state as context and turn plain-language requests into changes."
}

function buildConfigTurn({ message, context = {} }) {
  const currentProfile = context.profile || context.draftProfile || {}
  const currentConfig = currentProfile.config || context.config || {}
  const configPatch = {}
  const testVariablesPatch = parseTestVariables(message)
  const profilePatch = {}
  const changes = []

  const profileName = parseProfileName(message)
  if (profileName) {
    profilePatch.name = profileName
    changes.push(`renamed profile to ${profileName}`)
  }

  const replacePrompt = message.match(CONFIG_REPLACE_PATTERN)
  if (replacePrompt?.[1]) {
    configPatch.instructions = replacePrompt[1].trim()
    changes.push('replaced instructions')
  } else if (CONFIG_APPEND_PATTERN.test(message)) {
    configPatch.instructions = appendInstruction(currentConfig.instructions, message)
    changes.push('updated instructions')
  }

  const booleanSettings = parseBooleanSettings(message)
  Object.assign(configPatch, booleanSettings.patch)
  changes.push(...booleanSettings.labels)

  const numberSettings = parseNumberSettings(message)
  Object.assign(configPatch, numberSettings.patch)
  changes.push(...numberSettings.labels)

  const testVariableKeys = Object.keys(testVariablesPatch)
  if (testVariableKeys.length > 0) {
    changes.push(`updated ${testVariableKeys.length} test variable${testVariableKeys.length === 1 ? '' : 's'}`)
  }

  const commands = []
  if (SAVE_PATTERN.test(message)) {
    commands.push({ id: USE_PATTERN.test(message) ? 'save_and_use_profile' : 'save_profile' })
  } else if (USE_PATTERN.test(message)) {
    commands.push({ id: 'save_and_use_profile' })
  }

  let hasPatches =
    Object.keys(configPatch).length > 0 ||
    Object.keys(profilePatch).length > 0 ||
    testVariableKeys.length > 0

  if (!hasPatches && commands.length === 0) {
    if (isReadbackTurn(message)) {
      return {
        intent: 'config_readback',
        assistantMessage: buildConfigReadbackMessage(context),
        patches: {},
        commands,
      }
    }

    configPatch.instructions = appendInstruction(currentConfig.instructions, message)
    changes.push('updated instructions')
    hasPatches = true
  }

  if (!hasPatches && commands.length === 0) {
    return {
      intent: 'config_readback',
      assistantMessage: buildConfigReadbackMessage(context),
      patches: {},
      commands,
    }
  }

  return {
    intent: commands.length > 0 ? 'config_patch_and_command' : 'config_patch',
    assistantMessage:
      changes.length > 0
        ? `Applied to the current draft: ${changes.join(', ')}.`
        : 'I will run that profile action on the current draft.',
    patches: {
      ...(Object.keys(configPatch).length > 0 ? { config: configPatch } : {}),
      ...(Object.keys(profilePatch).length > 0 ? { profile: profilePatch } : {}),
      ...(testVariableKeys.length > 0 ? { testVariables: testVariablesPatch } : {}),
    },
    commands,
  }
}

function buildQueueResponse(
  message,
  assistantMessage = "Got it. I'll keep that as operator guidance for the agent.",
) {
  return {
    intent: 'queued_instruction',
    assistantMessage,
    patches: {
      queueInstruction: {
        text: message,
      },
    },
  }
}

export async function buildOperatorChatTurn({
  appRoot,
  authorizationMode,
  context = {},
  contract,
  invokeAction,
  message,
  surface,
} = {}) {
  const normalizedMessage = String(message || '').trim()
  const normalizedSurface = surface === 'configs' ? 'configs' : 'dialer'
  const base = {
    schemaVersion: OPERATOR_CHAT_SCHEMA_VERSION,
    turnId: `operator-chat-${randomUUID()}`,
    surface: normalizedSurface,
    authorizationMode: authorizationMode || 'confirm_each',
    ok: true,
    actions: [],
    commands: [],
    patches: {},
  }

  if (!normalizedMessage) {
    return {
      ...base,
      ok: false,
      intent: 'empty_message',
      assistantMessage: 'Message text is required.',
    }
  }

  if (normalizedSurface === 'configs') {
    return {
      ...base,
      ...buildConfigTurn({ message: normalizedMessage, context }),
    }
  }

  const currentConfig = context.currentConfig || context.config || {}
  if (FUTURE_SCOPE_PATTERN.test(normalizedMessage)) {
    return {
      ...base,
      intent: 'future_instruction_patch',
      assistantMessage: 'Added that to the current campaign instructions for future calls.',
      patches: {
        campaignConfig: {
          instructions: appendInstruction(currentConfig.instructions, normalizedMessage),
        },
      },
    }
  }

  const callControlId = cleanText(context.callControlId)
  if (!callControlId) {
    return {
      ...base,
      ...buildQueueResponse(normalizedMessage),
    }
  }

  const actionResult = await invokeAction({
    contract,
    appRoot,
    actionId: 'send_live_instruction',
    path: { callControlId },
    body: {
      chatId: cleanText(context.chatId),
      instruction: normalizedMessage,
    },
    authorizationMode,
  })

  const action = {
    actionId: 'send_live_instruction',
    status: actionResult.ok ? 'executed' : 'failed',
    proofExpected: actionResult.proofExpected || [],
    proofReturned: actionResult.proofReturned || [],
    transport: actionResult.transport,
    error: actionResult.error,
  }

  if (actionResult.ok) {
    return {
      ...base,
      intent: 'live_instruction',
      assistantMessage: 'Sent that to the agent for the next response.',
      actions: [action],
    }
  }

  if (actionResult.transport?.status === 409) {
    return {
      ...base,
      actions: [action],
      ...buildQueueResponse(normalizedMessage),
    }
  }

  return {
    ...base,
    actions: [action],
    ...buildQueueResponse(
      normalizedMessage,
      "I couldn't confirm delivery, so I kept that as operator guidance for the agent.",
    ),
  }
}
