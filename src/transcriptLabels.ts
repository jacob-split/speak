import type { AgentTestVariables } from './agentConfigs'
import type { RecentCallSummary } from './calls'
import type { Lead } from './types'

export interface TranscriptSpeakerLabels {
  agent?: string
  lead?: string
  you?: string
}

interface TranscriptSpeakerOptions {
  treatYouAsLead?: boolean
}

export function transcriptSpeakerClass(speaker: string) {
  const normalized = normalizedSpeaker(speaker)
  if (normalized === 'ai' || normalized === 'assistant' || normalized === 'agent') {
    return 'speaker-lead'
  }
  if (normalized === 'lead' || normalized === 'user' || normalized === 'contact') {
    return 'speaker-ai'
  }
  if (normalized === 'you' || normalized === 'operator') return 'speaker-lead'
  return `speaker-${normalized || 'system'}`
}

export function transcriptSpeakerLabel(
  speaker: string,
  labels: TranscriptSpeakerLabels = {},
  options: TranscriptSpeakerOptions = {},
) {
  const normalized = normalizedSpeaker(speaker)
  if (normalized === 'ai' || normalized === 'assistant' || normalized === 'agent') {
    return cleanLabel(labels.agent) || 'Agent'
  }
  if (
    normalized === 'lead' ||
    normalized === 'user' ||
    normalized === 'contact' ||
    (normalized === 'you' && options.treatYouAsLead)
  ) {
    return cleanLabel(labels.lead) || 'Contact'
  }
  if (normalized === 'you') return cleanLabel(labels.you) || 'You'
  if (normalized === 'tool') return 'Tool'
  if (normalized === 'system') return 'System'
  return cleanLabel(speaker) || 'Call'
}

export function leadTranscriptLabel(lead?: Lead | null) {
  if (!lead) return ''
  const name = cleanLabel(lead.name)
  const firstLast = cleanLabel([lead.firstName, lead.lastName].filter(Boolean).join(' '))
  return (
    (!isGenericLeadLabel(name) ? name : '') ||
    (!isGenericLeadLabel(firstLast) ? firstLast : '') ||
    cleanLabel(lead.company) ||
    ''
  )
}

export function callLeadTranscriptLabel(call?: RecentCallSummary | null) {
  if (!call) return ''
  const lead = call.lead || {}
  const name = cleanLabel(lead.name)
  const firstLast = cleanLabel([lead.first_name, lead.last_name].filter(Boolean).join(' '))
  return (
    (!isGenericLeadLabel(name) ? name : '') ||
    (!isGenericLeadLabel(firstLast) ? firstLast : '') ||
    cleanLabel(lead.business_name) ||
    ''
  )
}

export function callAgentTranscriptLabel(call?: RecentCallSummary | null) {
  if (!call) return ''
  return cleanLabel(call.agent?.name)
}

export function testVariablesTranscriptLabel(
  values?: Partial<AgentTestVariables> | null,
) {
  if (!values) return ''
  return (
    cleanLabel(values.full_name) ||
    cleanLabel([values.first_name, values.last_name].filter(Boolean).join(' ')) ||
    cleanLabel(values.business_name) ||
    ''
  )
}

function normalizedSpeaker(speaker: string) {
  return String(speaker || '').trim().toLowerCase()
}

function cleanLabel(value?: string | null) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function isGenericLeadLabel(value?: string | null) {
  return /^(imported\s+lead(?:\s+\d+)?|unknown\s+lead|unknown\s+contact)$/i.test(
    cleanLabel(value),
  )
}
