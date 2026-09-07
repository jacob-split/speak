export const DEFAULT_OPERATIONAL_TIME_ZONE = 'America/New_York'

export function operationalTimeZone() {
  return process.env.SPEAK_OPERATIONAL_TIME_ZONE || DEFAULT_OPERATIONAL_TIME_ZONE
}

export function operationalDate(value = new Date(), options = {}) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  const date = value instanceof Date ? value : new Date(value || Date.now())
  if (!Number.isFinite(date.getTime())) {
    return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : ''
  }
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: options.timeZone || operationalTimeZone(),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

export function operationalTimeLabel(value = new Date(), options = {}) {
  const date = value instanceof Date ? value : new Date(value || Date.now())
  if (!Number.isFinite(date.getTime())) return ''
  return new Intl.DateTimeFormat('en-US', {
    timeZone: options.timeZone || operationalTimeZone(),
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }).format(date)
}

export function callLogFileName(value = new Date(), options = {}) {
  return `events-${operationalDate(value, options)}.jsonl`
}
