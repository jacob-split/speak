export const speakOperationalTimeZone = 'America/New_York'

export function operationalDateTimeFormatter(
  options: Intl.DateTimeFormatOptions,
) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: speakOperationalTimeZone,
    ...options,
  })
}

export function formatOperationalDateTime(
  value: Date | string | number,
  options: Intl.DateTimeFormatOptions,
  fallback = '',
) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return fallback
  return operationalDateTimeFormatter(options).format(date)
}
