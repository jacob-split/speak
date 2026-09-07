interface PersonalPhoneInboundPolicy {
  enabled?: boolean
  eligibilityScope?: 'source' | 'selected'
  sourceId?: string
  contactIds?: string[]
  smartViewIds?: string[]
}

interface PersonalPhoneInboundToggle {
  enabled: boolean
  sourceId: string
}

function normalizeIds(value: unknown) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((entry) => String(entry || '').trim()).filter(Boolean))]
}

export function personalPhoneInboundConfigForToggle(
  current: PersonalPhoneInboundPolicy | null | undefined,
  toggle: PersonalPhoneInboundToggle,
) {
  const contactIds = normalizeIds(current?.contactIds)
  const smartViewIds = normalizeIds(current?.smartViewIds)
  const eligibilityScope: 'source' | 'selected' =
    current?.eligibilityScope === 'source' ? 'source' : 'selected'
  const shouldUseSourceDefault =
    toggle.enabled &&
    eligibilityScope === 'selected' &&
    contactIds.length === 0 &&
    smartViewIds.length === 0
  const nextEligibilityScope: 'source' | 'selected' = shouldUseSourceDefault
    ? 'source'
    : eligibilityScope

  return {
    enabled: Boolean(toggle.enabled),
    eligibilityScope: nextEligibilityScope,
    sourceId: String(toggle.sourceId || current?.sourceId || '').trim(),
    contactIds,
    smartViewIds,
  }
}
