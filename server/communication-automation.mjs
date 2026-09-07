import { normalizeContextFields } from './context-fields.mjs'
import {
  cleanName,
  safeLeadText,
} from './runtime-config.mjs'

const DISABLED_VALUES = new Set(['', '0', 'false', 'off', 'none', 'no', 'disabled'])
const ENABLED_VALUES = new Set(['1', 'true', 'on', 'yes', 'enabled'])

export function resolveInboundAutomationPolicy({
  channel,
  direction = 'inbound',
  lead = {},
  profile = {},
  subject = '',
} = {}) {
  const normalizedChannel = safeLeadText(channel).toLowerCase()
  if (direction !== 'inbound') {
    return disabledPolicy(normalizedChannel, 'not_inbound', 'event')
  }

  const sources = automationSources({ lead, profile })
  for (const source of sources) {
    const policy = policyFromSource(source, {
      channel: normalizedChannel,
      lead,
      subject,
    })
    if (policy) return policy
  }

  if (normalizedChannel === 'call') {
    return disabledPolicy(normalizedChannel, 'default_off_no_explicit_context_policy', 'default')
  }
  return disabledPolicy(normalizedChannel, 'default_none_no_explicit_context_policy', 'default')
}

export function automationProof(policy) {
  const base = {
    source: policy?.source || 'default',
    reason: policy?.reason || 'default_none_no_explicit_context_policy',
  }
  if (policy?.channel === 'sms') {
    return {
      smsAutoResponse: policy.enabled ? 'fixed_reply' : 'none',
      ...base,
    }
  }
  if (policy?.channel === 'email') {
    return {
      emailAutoReply: policy.enabled ? 'fixed_reply' : 'none',
      ...base,
    }
  }
  if (policy?.channel === 'call') {
    return {
      inboundCallAutoAnswer: Boolean(policy?.enabled && policy?.action === 'answer_call'),
      ...base,
    }
  }
  return base
}

function automationSources({ lead = {}, profile = {} } = {}) {
  const safeLead = lead && typeof lead === 'object' ? lead : {}
  const safeProfile = profile && typeof profile === 'object' ? profile : {}
  return [
    {
      source: 'contact_context',
      text: contextText(safeLead.context),
    },
    {
      source: 'agent_context',
      text: contextText(safeProfile.context),
    },
    {
      source: 'system_env',
      text: systemAutomationText(),
    },
  ].filter((item) => item.text)
}

function contextText(value) {
  return normalizeContextFields(value).text
}

function systemAutomationText() {
  return [
    process.env.SPEAK_COMMUNICATION_AUTOMATION_POLICY,
    process.env.SPEAK_SMS_AUTO_REPLY_BODY
      ? `sms_auto_reply_body=${process.env.SPEAK_SMS_AUTO_REPLY_BODY}`
      : '',
    process.env.SPEAK_EMAIL_AUTO_REPLY_BODY
      ? [
          `email_auto_reply_subject=${process.env.SPEAK_EMAIL_AUTO_REPLY_SUBJECT || ''}`,
          `email_auto_reply_body=${process.env.SPEAK_EMAIL_AUTO_REPLY_BODY}`,
        ].join('\n')
      : '',
    process.env.SPEAK_INBOUND_CALL_AUTO_ANSWER
      ? `inbound_call_auto_answer=${process.env.SPEAK_INBOUND_CALL_AUTO_ANSWER}`
      : '',
  ]
    .map((item) => safeLeadText(item))
    .filter(Boolean)
    .join('\n')
}

function policyFromSource(source, context) {
  const directives = {
    ...jsonDirectives(source.text),
    ...lineDirectives(source.text),
  }
  if (Object.keys(directives).length === 0) return null

  if (context.channel === 'sms') {
    return smsPolicyFromDirectives(source.source, directives, context)
  }
  if (context.channel === 'email') {
    return emailPolicyFromDirectives(source.source, directives, context)
  }
  if (context.channel === 'call') {
    return callPolicyFromDirectives(source.source, directives)
  }
  return null
}

function smsPolicyFromDirectives(source, directives, context) {
  const explicit = firstDirective(
    directives,
    'smsautoresponse',
    'smsautoreply',
    'speaksmsautoresponse',
    'speaksmsautoreply',
  )
  const enabled = boolDirective(
    firstDirective(directives, 'smsautoresponseenabled', 'smsautoreplyenabled'),
  )
  const body = firstDirective(
    directives,
    'smsautoresponsebody',
    'smsautoreplybody',
    'speaksmsautoresponsebody',
    'speaksmsautoreplybody',
  )

  if (explicit !== undefined && isDisabled(explicit)) {
    return disabledPolicy('sms', 'explicit_none', source)
  }
  const replyBody = safeLeadText(body || (explicit && !isEnabledWord(explicit) ? explicit : ''))
  if (enabled === false) return disabledPolicy('sms', 'explicit_none', source)
  if (!replyBody) return null
  return {
    action: 'send_sms',
    body: renderTemplate(replyBody, context),
    channel: 'sms',
    enabled: true,
    reason: 'explicit_fixed_reply_policy',
    source,
  }
}

function emailPolicyFromDirectives(source, directives, context) {
  const explicit = firstDirective(
    directives,
    'emailautoresponse',
    'emailautoreply',
    'speakemailautoresponse',
    'speakemailautoreply',
  )
  const enabled = boolDirective(
    firstDirective(directives, 'emailautoresponseenabled', 'emailautoreplyenabled'),
  )
  const subject = firstDirective(
    directives,
    'emailautoresponsesubject',
    'emailautoreplysubject',
    'speakemailautoresponsesubject',
    'speakemailautoreplysubject',
  )
  const body = firstDirective(
    directives,
    'emailautoresponsebody',
    'emailautoreplybody',
    'speakemailautoresponsebody',
    'speakemailautoreplybody',
  )

  if (explicit !== undefined && isDisabled(explicit)) {
    return disabledPolicy('email', 'explicit_none', source)
  }
  const replyBody = safeLeadText(body || (explicit && !isEnabledWord(explicit) ? explicit : ''))
  if (enabled === false) return disabledPolicy('email', 'explicit_none', source)
  if (!replyBody) return null
  return {
    action: 'send_email',
    body: renderTemplate(replyBody, context),
    channel: 'email',
    enabled: true,
    reason: 'explicit_fixed_reply_policy',
    source,
    subject: renderTemplate(safeLeadText(subject) || defaultReplySubject(context.subject), context),
  }
}

function callPolicyFromDirectives(source, directives) {
  const explicit = firstDirective(
    directives,
    'inboundcallautoanswer',
    'callautoanswer',
    'speakinboundcallautoanswer',
    'speakcallautoanswer',
  )
  const enabled = boolDirective(explicit)
  if (enabled === false || (explicit !== undefined && isDisabled(explicit))) {
    return disabledPolicy('call', 'explicit_off', source)
  }
  if (enabled === true) {
    return {
      action: 'answer_call',
      channel: 'call',
      enabled: true,
      reason: 'explicit_auto_answer_policy',
      source,
    }
  }
  return null
}

function jsonDirectives(text) {
  const results = {}
  const blocks = [text]
  const fenced = String(text || '').matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)
  for (const match of fenced) blocks.push(match[1])

  for (const block of blocks) {
    const parsed = parseJsonObject(block)
    if (!parsed) continue
    flattenAutomationObject(
      parsed.speakAutomation ||
        parsed.speak_automation ||
        parsed.communicationAutomation ||
        parsed.communication_automation ||
        parsed,
      '',
      results,
    )
  }
  return results
}

function lineDirectives(text) {
  const directives = {}
  String(text || '')
    .split(/\r?\n/)
    .forEach((line) => {
      const match = line.match(/^\s*([A-Za-z0-9_.-]+)\s*[:=]\s*(.+?)\s*$/)
      if (!match) return
      directives[directiveKey(match[1])] = unquote(match[2])
    })
  return directives
}

function flattenAutomationObject(value, prefix, out) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  Object.entries(value).forEach(([key, child]) => {
    const nextPrefix = `${prefix}${key}`
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      flattenAutomationObject(child, nextPrefix, out)
      return
    }
    out[directiveKey(nextPrefix)] = String(child ?? '')
  })
}

function parseJsonObject(text) {
  const raw = String(text || '').trim()
  if (!raw || !raw.startsWith('{')) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function firstDirective(directives, ...keys) {
  for (const key of keys) {
    const value = directives[directiveKey(key)]
    if (value !== undefined) return value
  }
  return undefined
}

function boolDirective(value) {
  if (value === undefined) return undefined
  const normalized = safeLeadText(value).toLowerCase()
  if (ENABLED_VALUES.has(normalized)) return true
  if (DISABLED_VALUES.has(normalized)) return false
  return undefined
}

function isDisabled(value) {
  return DISABLED_VALUES.has(safeLeadText(value).toLowerCase())
}

function isEnabledWord(value) {
  return ENABLED_VALUES.has(safeLeadText(value).toLowerCase())
}

function disabledPolicy(channel, reason, source) {
  return {
    action: channel === 'call' ? 'missed_call' : 'none',
    channel,
    enabled: false,
    reason,
    source,
  }
}

function directiveKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

function unquote(value) {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '')
}

function renderTemplate(template, { lead = {}, subject = '' } = {}) {
  const name = cleanName(lead.name || [lead.firstName, lead.lastName].filter(Boolean).join(' '))
  const firstName = cleanName(lead.firstName || name.split(/\s+/)[0] || '')
  const company = cleanName(lead.company || '')
  return safeLeadText(template)
    .replaceAll('{firstName}', firstName || 'there')
    .replaceAll('{name}', name || firstName || 'there')
    .replaceAll('{company}', company)
    .replaceAll('{subject}', safeLeadText(subject))
}

function defaultReplySubject(subject) {
  const cleanSubject = safeLeadText(subject)
  if (!cleanSubject) return 'Re: your message'
  return /^re:/i.test(cleanSubject) ? cleanSubject : `Re: ${cleanSubject}`
}
