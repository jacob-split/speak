import { getBrowserStorage } from './browserStorage'
import { createId } from './ids'
import {
  isDialablePhoneNumber,
  normalizePhoneNumber,
} from './phoneNumbers'
import type { CallOutcome, Lead, LeadStatus } from './types'

export type StatusFilter = LeadStatus | 'all'
export type ScoreFilter = 'all' | '70' | '85' | '90'
export type SortField =
  | 'name'
  | 'company'
  | 'agent'
  | 'calltime'
  | 'status'
  | 'lastCall'
  | 'phone'
  | 'email'
  | 'state'
  | 'tags'
  | 'score'

type SortValue = number | string

const leadStorageKey = 'speak:leads:v2'
const deletedLeadStorageKey = 'speak:deleted-lead-ids:v2'
const deletedLeadFingerprintStorageKey = 'speak:deleted-lead-fingerprints:v2'

export const statusLabels: Record<LeadStatus, string> = {
  ready: 'Ready',
  calling: 'Calling',
  'follow-up': 'Follow-up',
  'no-answer': 'No answer',
  voicemail: 'Voicemail',
  'not-interested': 'Not interested',
  skipped: 'Skipped',
  failed: 'Failed',
  'do-not-call': 'Do not call',
}

export const statusOptions = Object.keys(statusLabels) as LeadStatus[]

export function normalizeKey(key: string) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function loadDeletedLeadIds() {
  try {
    const storage = getBrowserStorage()
    const value = storage?.getItem(deletedLeadStorageKey) || '[]'
    const parsed = JSON.parse(value)
    return new Set(Array.isArray(parsed) ? parsed.filter(Boolean).map(String) : [])
  } catch {
    return new Set<string>()
  }
}

function saveDeletedLeadIds(ids: Set<string>) {
  try {
    getBrowserStorage()?.setItem(
      deletedLeadStorageKey,
      JSON.stringify(Array.from(ids)),
    )
  } catch {
    // Deleted-lead markers are a local fallback cache; server state remains authoritative.
  }
}

export function loadDeletedLeadFingerprints() {
  try {
    const storage = getBrowserStorage()
    const value = storage?.getItem(deletedLeadFingerprintStorageKey) || '[]'
    const parsed = JSON.parse(value)
    return new Set(Array.isArray(parsed) ? parsed.filter(Boolean).map(String) : [])
  } catch {
    return new Set<string>()
  }
}

function saveDeletedLeadFingerprints(fingerprints: Set<string>) {
  try {
    getBrowserStorage()?.setItem(
      deletedLeadFingerprintStorageKey,
      JSON.stringify(Array.from(fingerprints)),
    )
  } catch {
    // Deleted-lead markers are a local fallback cache; server state remains authoritative.
  }
}

function leadFingerprints(lead: Lead) {
  const phone = lead.phone.replace(/\D/g, '')
  const email = lead.email.trim().toLowerCase()
  const name = normalizeKey(lead.name)
  const company = normalizeKey(lead.company)

  return [
    phone ? `phone:${phone}` : '',
    email ? `email:${email}` : '',
    name && company ? `name-company:${name}:${company}` : '',
  ].filter(Boolean)
}

export function isDeletedLead(
  lead: Lead,
  deletedIds = loadDeletedLeadIds(),
  deletedFingerprints = loadDeletedLeadFingerprints(),
) {
  return (
    deletedIds.has(lead.id) ||
    leadFingerprints(lead).some((fingerprint) =>
      deletedFingerprints.has(fingerprint),
    )
  )
}

function rememberDeletedLeadIds(ids: Iterable<string>) {
  const deleted = loadDeletedLeadIds()
  Array.from(ids).forEach((id) => deleted.add(id))
  saveDeletedLeadIds(deleted)
}

export function rememberDeletedLeads(leads: Lead[]) {
  rememberDeletedLeadIds(leads.map((lead) => lead.id))
  const deletedFingerprints = loadDeletedLeadFingerprints()
  leads
    .flatMap(leadFingerprints)
    .forEach((fingerprint) => deletedFingerprints.add(fingerprint))
  saveDeletedLeadFingerprints(deletedFingerprints)
}

export function loadStoredLeadState() {
  const deleted = loadDeletedLeadIds()
  const deletedFingerprints = loadDeletedLeadFingerprints()
  let stored: Lead[] = []

  try {
    const storage = getBrowserStorage()
    const value = storage?.getItem(leadStorageKey) || '[]'
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed)) {
      stored = parsed.filter((lead): lead is Lead => Boolean(lead?.id))
    }
  } catch {
    stored = []
  }

  return stored
    .map(sanitizeStoredLead)
    .filter(isLead)
    .filter((lead) => !isDeletedLead(lead, deleted, deletedFingerprints))
}

export function saveStoredLeadState(leads: Lead[]) {
  try {
    const retained = leads.map(sanitizeStoredLead).filter(isLead)
    getBrowserStorage()?.setItem(leadStorageKey, JSON.stringify(retained))
  } catch {
    // Lead storage is a migration/fallback cache; backend workspace state owns durability.
  }
}

function isLead(lead: Lead | null): lead is Lead {
  return Boolean(lead)
}

function sanitizeStoredLead(lead: Lead): Lead | null {
  if (isTemplateLead(lead)) return null
  if (!isSelectableStoredSource(lead.source)) return null

  const contextText = lead.context?.text || ''
  const cleanedContextText = contextText
    .split(/\r?\n/)
    .filter((line) => !isImportedMetadataContextLine(line))
    .join('\n')
    .trim()

  if (cleanedContextText === contextText.trim()) return lead
  return {
    ...lead,
    context: {
      text: cleanedContextText,
      urls: lead.context?.urls || [],
      urlSnapshots: lead.context?.urlSnapshots,
      files: lead.context?.files || [],
    },
  }
}

function isSelectableStoredSource(source: Lead['source']) {
  return source === 'calltools' || source === 'personal-phone'
}

function isTemplateLead(lead: Lead) {
  const email = lead.email.trim().toLowerCase()
  const tags = lead.tags.map((tag) => tag.trim().toLowerCase())
  return (
    lead.id.startsWith('demo-') ||
    email.endsWith('.example') ||
    tags.includes('demo-request') ||
    tags.includes('proof')
  )
}

function isImportedMetadataContextLine(line: string) {
  return /^(source\s+provider|source\s+id|provider\s+contact\s+id|bluebubbles\s+contact\s+id|blue\s+bubbles\s+contact\s+id)\s*:/i.test(
    line.trim(),
  )
}

function pick(row: Record<string, string>, aliases: string[]) {
  const normalizedAliases = aliases.map(normalizeKey)
  const match = Object.keys(row).find((key) =>
    normalizedAliases.includes(normalizeKey(key)),
  )
  return match ? String(row[match] ?? '').trim() : ''
}

function parseTags(value: string) {
  return value
    .split(/[;,|]/)
    .map((tag) => tag.trim())
    .filter(Boolean)
}

function parseStatus(value: string): LeadStatus {
  const key = normalizeKey(value)
  if (key.includes('donotcall') || key === 'dnc') return 'do-not-call'
  if (key.includes('noanswer')) return 'no-answer'
  if (key.includes('voicemail')) return 'voicemail'
  if (key.includes('notinterested')) return 'not-interested'
  if (key.includes('skipped')) return 'skipped'
  if (key.includes('failed') || key.includes('blocked')) return 'failed'
  if (key.includes('follow')) return 'follow-up'
  if (key.includes('calling')) return 'calling'
  return 'ready'
}

function isGenericLeadName(value: string) {
  return /^(imported\s+lead(?:\s+\d+)?|unknown\s+contact)$/i.test(
    value.trim(),
  )
}

export function isValidPhoneNumber(value: string) {
  return isDialablePhoneNumber(value)
}

export function isCampaignDialable(lead: Lead) {
  return lead.status === 'ready' && isValidPhoneNumber(lead.phone)
}

export function statusForOutcome(outcome: CallOutcome): LeadStatus {
  if (outcome === 'no-answer') return 'no-answer'
  if (outcome === 'voicemail') return 'voicemail'
  if (outcome === 'not-interested') return 'not-interested'
  if (outcome === 'do-not-call') return 'do-not-call'
  if (outcome === 'skipped') return 'skipped'
  if (outcome === 'failed') return 'failed'
  return 'follow-up'
}

export function splitLeadName(value: string) {
  const parts = value.trim().split(/\s+/).filter(Boolean)
  return {
    firstName: parts[0] || '',
    lastName: parts.slice(1).join(' '),
  }
}

export function filterAndSortLeads(
  sourceLeads: Lead[],
  options: {
    query: string
    statusFilter: StatusFilter
    stateFilter: string
    tagFilter?: string
    scoreFilter: ScoreFilter
    sortField: SortField
    sortDirection: 'asc' | 'desc'
    sortValue?: (lead: Lead, field: SortField) => SortValue | undefined
  },
) {
  const minScore =
    options.scoreFilter === 'all' ? 0 : Number(options.scoreFilter)
  const terms = options.query.trim().toLowerCase()
  const tagFilter = (options.tagFilter || 'all').trim().toLowerCase()

  return sourceLeads
    .filter((lead) => {
      const haystack = [
        lead.firstName,
        lead.lastName,
        lead.name,
        lead.company,
        lead.phone,
        lead.email,
        lead.state,
        lead.status,
        lead.notes,
        lead.tags.join(' '),
      ]
        .join(' ')
        .toLowerCase()

      return (
        (!terms || haystack.includes(terms)) &&
        (options.statusFilter === 'all' || lead.status === options.statusFilter) &&
        (options.stateFilter === 'all' || lead.state === options.stateFilter) &&
        (tagFilter === 'all' ||
          lead.tags.some((tag) => tag.trim().toLowerCase() === tagFilter)) &&
        lead.score >= minScore
      )
    })
    .sort((left, right) => {
      const leftValue =
        options.sortValue?.(left, options.sortField) ??
        sortableLeadValue(left, options.sortField)
      const rightValue =
        options.sortValue?.(right, options.sortField) ??
        sortableLeadValue(right, options.sortField)
      const direction = options.sortDirection === 'asc' ? 1 : -1

      if (typeof leftValue === 'number' && typeof rightValue === 'number') {
        return (leftValue - rightValue) * direction
      }

      return String(leftValue).localeCompare(String(rightValue)) * direction
    })
}

function sortableLeadValue(lead: Lead, field: SortField): SortValue {
  if (field === 'tags') return lead.tags.join(' ')
  if (field === 'calltime') return 0
  if (field === 'agent') return ''
  return lead[field]
}

export function csvRowToLead(row: Record<string, string>, index: number): Lead {
  const firstName = pick(row, ['first name', 'firstname', 'first'])
  const lastName = pick(row, ['last name', 'lastname', 'last'])
  const company = pick(row, ['company', 'business', 'business name', 'organization'])
  const pickedName =
    pick(row, ['name', 'full name', 'contact name']) ||
    [firstName, lastName].filter(Boolean).join(' ')
  const combinedName = isGenericLeadName(pickedName) ? '' : pickedName
  const derivedName = splitLeadName(combinedName)

  return {
    id: createId(`csv-${index}`),
    firstName: firstName || derivedName.firstName,
    lastName: lastName || derivedName.lastName,
    name: combinedName || company || `Imported lead ${index + 1}`,
    company: company || 'Unknown business',
    phone:
      normalizePhoneNumber(pick(row, ['phone', 'mobile', 'cell', 'telephone', 'number'])) ||
      pick(row, ['phone', 'mobile', 'cell', 'telephone', 'number']),
    email: pick(row, ['email', 'email address', 'contact email']),
    state: pick(row, ['state', 'region', 'province']) || 'NA',
    tags: parseTags(pick(row, ['tags', 'category', 'vertical', 'industry'])),
    score: Number(pick(row, ['score', 'lead score', 'fit score'])) || 50,
    status: parseStatus(pick(row, ['status', 'call status', 'stage'])),
    lastCall: pick(row, ['last call', 'last contacted']) || 'Never',
    notes: pick(row, ['notes', 'note', 'memo']) || '',
  }
}
