export function normalizePhoneNumber(value: string) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (!/^[+\d\s()./-]+$/.test(raw)) return ''
  if ((raw.match(/\+/g) || []).length > 1 || (raw.includes('+') && !raw.startsWith('+'))) {
    return ''
  }
  const digits = raw.replace(/\D/g, '')
  const normalized = !raw.startsWith('+') && digits.length === 10
    ? `+1${digits}`
    : `+${digits}`
  return /^\+[1-9]\d{7,14}$/.test(normalized) ? normalized : ''
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
