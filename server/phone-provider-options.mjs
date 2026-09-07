import { TELNYX_API_BASE, providerError, readJson, telnyxHeaders } from './provider-http.mjs'
import { cleanObject, normalizePhone, safeLeadText } from './runtime-config.mjs'

export const PHONE_PROVIDER_OPTIONS_SCHEMA_VERSION = 'speak.phone-provider-options.v1'

export async function listPhoneProviderOptions({ fetchImpl = globalThis.fetch } = {}) {
  const fallbackNumbers = envPhoneProviderOptions()
  const readProof = {
    apiConfigured: Boolean(process.env.TELNYX_API_KEY),
    source: fallbackNumbers.length ? 'env' : 'none',
  }

  if (!process.env.TELNYX_API_KEY || !fetchImpl) {
    return phoneProviderOptionsPayload(fallbackNumbers, readProof)
  }

  try {
    const response = await fetchImpl(`${TELNYX_API_BASE}/phone_numbers?page[size]=100`, {
      headers: telnyxHeaders(),
    })
    const payload = await readJson(response)
    if (!response.ok) {
      return phoneProviderOptionsPayload(fallbackNumbers, {
        ...readProof,
        source: fallbackNumbers.length ? 'env_after_telnyx_error' : 'telnyx_error',
        readError: providerError('Telnyx phone-number catalog failed', payload),
      })
    }

    const nativeNumbers = collectionResults(payload).map(telnyxPhoneNumberToOption)
    return phoneProviderOptionsPayload(
      mergePhoneProviderOptions(nativeNumbers, fallbackNumbers),
      {
        ...readProof,
        source: 'telnyx',
        nativeCount: nativeNumbers.length,
      },
    )
  } catch (error) {
    return phoneProviderOptionsPayload(fallbackNumbers, {
      ...readProof,
      source: fallbackNumbers.length ? 'env_after_telnyx_error' : 'telnyx_error',
      readError: error instanceof Error ? error.message : 'Telnyx phone-number catalog failed',
    })
  }
}

export function envPhoneProviderOptions() {
  return mergePhoneProviderOptions([
    ...parseConfiguredPhoneOptions(process.env.SPEAK_PHONE_NUMBER_OPTIONS),
    ...parseConfiguredPhoneOptions(process.env.TELNYX_PHONE_NUMBER_OPTIONS),
    phoneProviderOption({
      id: process.env.TELNYX_PHONE_NUMBER_ID || 'env:telnyx-from-number',
      phoneNumber: process.env.TELNYX_FROM_NUMBER,
      label: process.env.TELNYX_FROM_NUMBER_LABEL || '',
      connectionId: process.env.TELNYX_CONNECTION_ID,
      messagingProfileId: process.env.TELNYX_MESSAGING_PROFILE_ID,
      source: 'env',
      isDefault: true,
    }),
    phoneProviderOption({
      id: process.env.TELNYX_SMS_NUMBER ? 'env:telnyx-sms-number' : '',
      phoneNumber: process.env.TELNYX_SMS_NUMBER || process.env.TELNYX_SMS_FROM,
      label: process.env.TELNYX_SMS_NUMBER_LABEL || '',
      connectionId: process.env.TELNYX_CONNECTION_ID,
      messagingProfileId: process.env.TELNYX_MESSAGING_PROFILE_ID,
      source: 'env',
      isDefault: false,
    }),
  ])
}

export function parseConfiguredPhoneOptions(value) {
  const text = safeLeadText(value)
  if (!text) return []
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text)
      return (Array.isArray(parsed) ? parsed : []).map((item) =>
        phoneProviderOption({
          id: item.id,
          phoneNumber: item.phoneNumber || item.phone_number || item.number,
          label: item.label || item.name,
          connectionId: item.connectionId || item.connection_id,
          messagingProfileId: item.messagingProfileId || item.messaging_profile_id,
          source: 'env',
          isDefault: Boolean(item.isDefault || item.default),
        }),
      )
    } catch {
      return []
    }
  }

  return text
    .split(',')
    .map((item) =>
      phoneProviderOption({
        phoneNumber: item.trim(),
        source: 'env',
      }),
    )
}

export function phoneProviderOption(value = {}) {
  const phoneNumber = normalizePhone(value.phoneNumber || value.phone_number || value.number)
  if (!phoneNumber) return null
  const id = safeLeadText(value.id) || phoneNumber
  const label = phoneProviderLabel({
    label: value.label || value.name,
    phoneNumber,
  })
  return cleanObject({
    id,
    label,
    phoneNumber,
    connectionId: safeLeadText(value.connectionId || value.connection_id),
    messagingProfileId: safeLeadText(value.messagingProfileId || value.messaging_profile_id),
    source: safeLeadText(value.source || 'telnyx'),
    isDefault: Boolean(value.isDefault || value.default),
  })
}

function telnyxPhoneNumberToOption(item = {}) {
  return phoneProviderOption({
    id: item.id,
    phoneNumber: item.phone_number,
    label: item.name || item.friendly_name || item.description,
    // Telnyx phone-number `connection_id` identifies the number's inbound
    // assignment and is not necessarily a Call Control application. Outbound
    // `/calls` must use the configured Call Control app for every caller ID.
    connectionId: process.env.TELNYX_CONNECTION_ID,
    messagingProfileId: item.messaging_profile_id || item.messaging_profile?.id,
    source: 'telnyx',
    isDefault: normalizePhone(item.phone_number) === normalizePhone(process.env.TELNYX_FROM_NUMBER),
  })
}

function phoneProviderOptionsPayload(numbers, proof = {}) {
  const merged = mergePhoneProviderOptions(numbers)
  return {
    schemaVersion: PHONE_PROVIDER_OPTIONS_SCHEMA_VERSION,
    provider: 'telnyx',
    configured: Boolean(process.env.TELNYX_API_KEY || merged.length),
    numbers: merged,
    defaultNumber:
      merged.find((number) => number.isDefault) ||
      merged.find((number) => number.phoneNumber === normalizePhone(process.env.TELNYX_FROM_NUMBER)) ||
      merged[0] ||
      null,
    proof,
  }
}

function mergePhoneProviderOptions(...groups) {
  const byNumber = new Map()
  groups.flat().filter(Boolean).forEach((option) => {
    const existing = byNumber.get(option.phoneNumber) || {}
    byNumber.set(option.phoneNumber, cleanObject({
      ...existing,
      ...option,
      id: existing.id || option.id,
      label: existing.label && existing.label !== option.phoneNumber ? existing.label : option.label,
      connectionId: existing.connectionId || option.connectionId,
      messagingProfileId: existing.messagingProfileId || option.messagingProfileId,
      isDefault: Boolean(existing.isDefault || option.isDefault),
    }))
  })
  return Array.from(byNumber.values()).sort((left, right) => {
    if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1
    return left.label.localeCompare(right.label, undefined, { sensitivity: 'base' })
  })
}

function collectionResults(payload) {
  if (Array.isArray(payload?.data)) return payload.data
  if (payload?.data && typeof payload.data === 'object') return [payload.data]
  return []
}

function phoneProviderLabel({ label, phoneNumber }) {
  const explicit = safeLeadText(label)
  if (explicit) return explicit
  if (phoneNumber.endsWith('1882')) return 'Personal Phone'
  return phoneNumber
}
