export const TELNYX_API_BASE = process.env.TELNYX_API_BASE || 'https://api.telnyx.com/v2'
export const HUME_API_BASE = 'https://api.hume.ai/v0'
export const INWORLD_API_BASE = 'https://api.inworld.ai'
export const XAI_API_BASE = 'https://api.x.ai'

export function telnyxHeaders() {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
    'Content-Type': 'application/json',
  }
}

export async function readJson(response) {
  const text = await response.text()
  if (!text) return {}

  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

export function providerError(prefix, payload) {
  const firstError = payload?.errors?.[0]
  if (firstError?.detail) return `${prefix}: ${firstError.detail}`
  if (firstError?.title) return `${prefix}: ${firstError.title}`
  if (payload?.message) return `${prefix}: ${payload.message}`
  return prefix
}
