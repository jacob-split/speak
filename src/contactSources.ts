import type { Lead } from './types'

export interface ContactSourceOption {
  key: string
  label: string
  count: number
  source: string
  sourceId?: string
  sourceName?: string
}

export function contactSourceLabel(source = '') {
  if (source === 'personal-phone') return 'Personal Phone'
  if (source === 'calltools') return 'CallTools'
  if (source === 'csv') return 'CSV'
  if (source === 'manual') return 'Manual'
  return 'Contacts'
}

export function isSelectableContactSource(source = '') {
  return Boolean(source && source !== 'manual' && source !== 'filters' && source !== 'csv')
}

export function contactSourceKey(source = '', sourceId = '') {
  const normalizedSource = String(source || '').trim()
  if (!isSelectableContactSource(normalizedSource)) return ''
  const normalizedSourceId = String(sourceId || '').trim()
  return normalizedSourceId
    ? `${normalizedSource}::${encodeURIComponent(normalizedSourceId)}`
    : normalizedSource
}

export function parseContactSourceKey(key = '') {
  const value = String(key || '').trim()
  const separatorIndex = value.indexOf('::')
  const source = separatorIndex >= 0 ? value.slice(0, separatorIndex) : value
  if (!isSelectableContactSource(source)) return { source: '', sourceId: '' }
  const encodedSourceId = separatorIndex >= 0 ? value.slice(separatorIndex + 2) : ''
  if (!encodedSourceId) return { source, sourceId: '' }
  try {
    return { source, sourceId: decodeURIComponent(encodedSourceId) }
  } catch {
    return { source, sourceId: encodedSourceId }
  }
}

export function contactSourceKeyFromDialerSourceId(sourceId = '') {
  return sourceId.startsWith('source:') ? sourceId.slice('source:'.length) : ''
}

export function dialerSourceIdFromContactSourceKey(key = '') {
  return key ? `source:${key}` : ''
}

export function isContactSourceKeyForSource(key = '', source = '') {
  return parseContactSourceKey(key).source === source
}

export function leadContactSourceKey(lead: Pick<Lead, 'source' | 'sourceId'>) {
  return contactSourceKey(lead.source || '', lead.sourceId || '')
}

export function leadMatchesContactSourceKey(
  lead: Pick<Lead, 'source' | 'sourceId'>,
  key = '',
) {
  const selection = parseContactSourceKey(key)
  if (!selection.source || lead.source !== selection.source) return false
  return selection.sourceId ? lead.sourceId === selection.sourceId : true
}

export function contactSourceLabelForLead(lead: Pick<Lead, 'source' | 'sourceName'>) {
  return lead.sourceName || contactSourceLabel(lead.source || 'manual')
}

export function buildContactSourceOptionsFromLeads(leads: Lead[]) {
  const byKey = new Map<string, ContactSourceOption>()

  leads.forEach((lead) => {
    const source = lead.source || ''
    if (!isSelectableContactSource(source)) return
    const key = leadContactSourceKey(lead)
    if (!key) return
    const existing =
      byKey.get(key) || {
        key,
        label: contactSourceLabelForLead(lead),
        count: 0,
        source,
        sourceId: lead.sourceId,
        sourceName: lead.sourceName,
      }
    existing.count += 1
    if (!existing.sourceId && lead.sourceId) existing.sourceId = lead.sourceId
    if (!existing.sourceName && lead.sourceName) existing.sourceName = lead.sourceName
    if (lead.sourceName) existing.label = lead.sourceName
    byKey.set(key, existing)
  })

  const defaultSources = ['personal-phone', 'calltools']
  defaultSources.forEach((source) => {
    if (Array.from(byKey.values()).some((option) => option.source === source)) return
    const key = contactSourceKey(source)
    byKey.set(key, {
      key,
      label: contactSourceLabel(source),
      count: 0,
      source,
    })
  })

  return Array.from(byKey.values()).sort((left, right) =>
    left.label.localeCompare(right.label, undefined, { sensitivity: 'base' }),
  )
}

export function resolveContactSourceOptionKey(
  options: ContactSourceOption[],
  requestedKey = '',
  preferredSource = 'personal-phone',
) {
  if (options.some((option) => option.key === requestedKey)) return requestedKey
  const requested = parseContactSourceKey(requestedKey)
  if (requested.source) {
    const sourceMatch = options.find((option) => option.source === requested.source)
    if (sourceMatch) return sourceMatch.key
  }
  const preferred = options.find((option) => option.source === preferredSource)
  return preferred?.key || options[0]?.key || ''
}
