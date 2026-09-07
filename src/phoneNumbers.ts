export function normalizePhoneNumber(value: string) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const digits = raw.replace(/\D/g, '')
  if (raw.startsWith('+') && /^\+[1-9]\d{7,14}$/.test(raw)) return raw
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  if (digits.length >= 8 && digits.length <= 15) return `+${digits}`
  return ''
}

export function isDialablePhoneNumber(value: string) {
  return Boolean(normalizePhoneNumber(value))
}

export function phoneTelHref(value: string) {
  const phone = normalizePhoneNumber(value)
  return phone ? `tel:${phone}` : ''
}

export function normalizePhoneOnCommit(value: string) {
  return normalizePhoneNumber(value) || String(value || '').trim()
}
