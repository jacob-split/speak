function schema(value) {
  if (value?.type !== 'object') return JSON.stringify(value)

  return JSON.stringify({
    ...value,
    required: Array.isArray(value.required) ? value.required : [],
    properties: value.properties || {},
  })
}

export const speakFunctionTools = [
  {
    name: 'send_text_message',
    description:
      'Send a text message to a confirmed phone number. The active agent instructions decide when to send, what to say, and whether sending is appropriate.',
    fallback_content:
      'The text message could not be sent. Do not say it was sent. Confirm the phone number or ask the operator for help.',
    parameters: schema({
      type: 'object',
      required: ['phone_number', 'message', 'destination_confirmed'],
      properties: {
        phone_number: {
          type: 'string',
          description: 'Confirmed destination phone number, preferably in E.164 format.',
        },
        message: {
          type: 'string',
          description: 'Exact text message body to send.',
        },
        destination_confirmed: {
          type: 'boolean',
          description:
            'True only after the recipient confirmed the exact phone number for this message.',
        },
      },
    }),
    version_description: 'Generic confirmed text messaging capability.',
  },
  {
    name: 'send_email',
    description:
      'Send an email to a confirmed email address. The active agent instructions decide when to send, subject, body, and whether sending is appropriate.',
    fallback_content:
      'The email could not be sent. Do not say it was sent. Confirm the email address or ask the operator for help.',
    parameters: schema({
      type: 'object',
      required: ['email', 'subject', 'body', 'destination_confirmed'],
      properties: {
        email: {
          type: 'string',
          description: 'Confirmed destination email address.',
        },
        subject: {
          type: 'string',
          description: 'Email subject line.',
        },
        body: {
          type: 'string',
          description: 'Plain-text email body.',
        },
        destination_confirmed: {
          type: 'boolean',
          description:
            'True only after the recipient confirmed the exact email address for this message.',
        },
      },
    }),
    version_description: 'Generic confirmed email capability.',
  },
  {
    name: 'send_portal_link',
    description:
      'Send the configured portal link by confirmed SMS, confirmed email, or both. The active agent instructions decide when portal delivery is appropriate.',
    fallback_content:
      'The portal link could not be sent. Do not say it was sent. Confirm the destination or ask the operator for help.',
    parameters: schema({
      type: 'object',
      required: ['delivery_method'],
      properties: {
        delivery_method: {
          type: 'string',
          enum: ['sms', 'email', 'both'],
          description: 'Delivery channel for the configured portal link.',
        },
        phone_number: {
          type: 'string',
          description: 'Confirmed SMS destination, required for sms or both delivery.',
        },
        email: {
          type: 'string',
          description: 'Confirmed email destination, required for email or both delivery.',
        },
        destination_confirmed: {
          type: 'boolean',
          description:
            'Compatibility confirmation for a single-channel sms or email delivery. Both-channel delivery requires phone_confirmed and email_confirmed separately.',
        },
        phone_confirmed: {
          type: 'boolean',
          description:
            'True only after the recipient confirmed the exact phone number. Required for both-channel delivery and accepted for sms delivery.',
        },
        email_confirmed: {
          type: 'boolean',
          description:
            'True only after the recipient confirmed the exact email address. Required for both-channel delivery and accepted for email delivery.',
        },
      },
    }),
    version_description: 'Generic confirmed portal link delivery capability.',
  },
  {
    name: 'update_contact',
    description:
      'Update the active contact context after the person confirms a better phone number, email address, name, or organization.',
    fallback_content:
      'The contact update could not be saved. Continue with the confirmed details and ask the operator for help if needed.',
    parameters: schema({
      type: 'object',
      required: ['details_confirmed'],
      properties: {
        details_confirmed: {
          type: 'boolean',
          description:
            'True only after the person confirmed the exact contact details being saved.',
        },
        phone_number: {
          type: 'string',
          description: 'Confirmed phone number.',
        },
        email: {
          type: 'string',
          description: 'Confirmed email address.',
        },
        first_name: {
          type: 'string',
          description: 'Confirmed first name.',
        },
        last_name: {
          type: 'string',
          description: 'Confirmed last name.',
        },
        full_name: {
          type: 'string',
          description: 'Confirmed full name.',
        },
        organization: {
          type: 'string',
          description: 'Confirmed organization, company, or account name.',
        },
      },
    }),
    version_description: 'Generic contact correction capability.',
  },
  {
    name: 'update_caller_identity',
    description:
      'Update the name or organization to use for the current conversation when the stored context is missing or wrong.',
    fallback_content:
      'The identity update could not be saved. Ask for the name again naturally if needed.',
    parameters: schema({
      type: 'object',
      properties: {
        first_name: {
          type: 'string',
          description: 'Correct first name to use during the conversation.',
        },
        last_name: {
          type: 'string',
          description: 'Correct last name, if provided.',
        },
        full_name: {
          type: 'string',
          description: 'Correct full name, if provided.',
        },
        organization: {
          type: 'string',
          description: 'Correct organization, company, or account name, if provided.',
        },
      },
    }),
    version_description: 'Generic caller identity correction capability.',
  },
  {
    name: 'get_contact_context',
    description:
      'Fetch the current contact context, including corrected identity, contact fields, lead notes, extracted URL and file contents, prior conversation memory, and agent-level context.',
    fallback_content:
      'The current contact context could not be fetched. Ask one focused clarification question and continue.',
    parameters: schema({
      type: 'object',
      properties: {},
    }),
    version_description: 'Generic current contact context lookup.',
  },
  {
    name: 'get_lead_context',
    description:
      'Compatibility alias for fetching the current contact context, agent-level context, attached notes, extracted URL and file contents, prior conversation memory, and configured portal URL before deciding what to use.',
    fallback_content:
      'The current contact context could not be fetched. Ask one focused clarification question and continue.',
    parameters: schema({
      type: 'object',
      properties: {},
    }),
    version_description: 'Legacy alias for current contact context lookup.',
  },
]

export function speakSessionToolDefinitions() {
  return speakFunctionTools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    fallback_content: tool.fallback_content,
    parameters: tool.parameters,
  }))
}

function parseToolParameters(value) {
  try {
    const parsed = JSON.parse(String(value || '{}'))
    return parsed && typeof parsed === 'object'
      ? parsed
      : { type: 'object', properties: {} }
  } catch {
    return { type: 'object', properties: {} }
  }
}

export function speakOpenAiToolDefinitions() {
  return [
    ...speakFunctionTools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: parseToolParameters(tool.parameters),
      },
    })),
    {
      type: 'function',
      function: {
        name: 'hang_up',
        description:
          'End the current phone call after the conversation has reached a clear stopping point.',
        parameters: {
          type: 'object',
          properties: {
            outcome: {
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
              description: 'Best final call outcome to record before ending the call.',
            },
          },
        },
      },
    },
  ]
}

export function speakInworldToolDefinitions() {
  return speakOpenAiToolDefinitions().map((tool) => {
    const definition = tool.function || tool
    return {
      type: 'function',
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters || { type: 'object', properties: {} },
    }
  })
}

export function speakConfigBuiltinTools(sourceBuiltinTools) {
  const names = new Set()
  const tools = []

  for (const tool of Array.isArray(sourceBuiltinTools) ? sourceBuiltinTools : []) {
    if (!tool?.name || names.has(tool.name)) continue
    names.add(tool.name)
    tools.push({ name: tool.name })
  }

  if (!names.has('hang_up')) {
    tools.push({ name: 'hang_up' })
  }

  return tools
}
