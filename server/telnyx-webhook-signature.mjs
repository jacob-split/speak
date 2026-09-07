import { createPublicKey, verify as verifySignature } from 'node:crypto'
import {
  getTelnyxWebhookPublicKeys,
  numberEnv,
  safeLeadText,
  telnyxWebhookSignatureRequired,
} from './runtime-config.mjs'

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

export function telnyxWebhookSignedPayload(timestamp, payload) {
  const cleanTimestamp = safeLeadText(timestamp)
  const payloadBuffer = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload || {}))
  return Buffer.concat([Buffer.from(`${cleanTimestamp}|`), payloadBuffer])
}

export function telnyxWebhookPublicKeyObject(value) {
  const text = safeLeadText(value)
  if (!text) throw new Error('Telnyx webhook public key is missing.')
  if (/-----BEGIN PUBLIC KEY-----/.test(text)) return createPublicKey(text)

  const compact = text.replace(/\s+/g, '')
  const raw = /^[0-9a-f]{64}$/i.test(compact)
    ? Buffer.from(compact, 'hex')
    : Buffer.from(compact, 'base64')
  if (raw.length !== 32) {
    throw new Error('Telnyx webhook public key must be PEM, 32-byte base64, or 64-character hex.')
  }
  return createPublicKey({
    format: 'der',
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    type: 'spki',
  })
}

export function verifyTelnyxWebhookSignature({
  payload,
  publicKeys = getTelnyxWebhookPublicKeys(),
  signature,
  timestamp,
  toleranceSeconds = numberEnv('TELNYX_WEBHOOK_SIGNATURE_TOLERANCE_SECONDS', 300),
} = {}) {
  const cleanTimestamp = safeLeadText(timestamp)
  const cleanSignature = safeLeadText(signature)
  const keys = Array.isArray(publicKeys)
    ? publicKeys.map(safeLeadText).filter(Boolean)
    : [safeLeadText(publicKeys)].filter(Boolean)
  if (keys.length === 0) {
    return { ok: false, error: 'telnyx_webhook_signature_key_missing', status: 503 }
  }
  if (!cleanSignature || !cleanTimestamp) {
    return { ok: false, error: 'telnyx_webhook_signature_missing', status: 401 }
  }

  const timestampSeconds = Number(cleanTimestamp)
  if (!Number.isFinite(timestampSeconds)) {
    return { ok: false, error: 'telnyx_webhook_timestamp_invalid', status: 401 }
  }
  if (Number.isFinite(toleranceSeconds) && toleranceSeconds > 0) {
    const ageSeconds = Math.abs(Date.now() / 1000 - timestampSeconds)
    if (ageSeconds > toleranceSeconds) {
      return { ok: false, error: 'telnyx_webhook_timestamp_outside_tolerance', status: 401 }
    }
  }

  const signatureBytes = Buffer.from(cleanSignature, 'base64')
  if (!signatureBytes.length) {
    return { ok: false, error: 'telnyx_webhook_signature_invalid', status: 401 }
  }

  const signedPayload = telnyxWebhookSignedPayload(cleanTimestamp, payload)
  for (const key of keys) {
    try {
      if (verifySignature(null, signedPayload, telnyxWebhookPublicKeyObject(key), signatureBytes)) {
        return { ok: true, verified: true }
      }
    } catch (error) {
      if (keys.length === 1) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : 'telnyx_webhook_public_key_invalid',
          status: 503,
        }
      }
    }
  }
  return { ok: false, error: 'telnyx_webhook_signature_invalid', status: 401 }
}

export function verifyTelnyxWebhookRequest(request) {
  const required = telnyxWebhookSignatureRequired()
  const publicKeys = getTelnyxWebhookPublicKeys()
  if (!required) {
    return { ok: true, required, skipped: true, configured: publicKeys.length > 0 }
  }
  const rawPayload = Buffer.isBuffer(request.rawBody)
    ? request.rawBody
    : Buffer.from(JSON.stringify(request.body || {}))
  return {
    required,
    configured: publicKeys.length > 0,
    ...verifyTelnyxWebhookSignature({
      payload: rawPayload,
      publicKeys,
      signature: request.get('telnyx-signature-ed25519'),
      timestamp: request.get('telnyx-timestamp'),
    }),
  }
}
