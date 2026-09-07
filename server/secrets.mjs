import { execFileSync } from 'node:child_process'

const KEYCHAIN_SERVICE_PREFIX = 'speak'
const secretCache = new Map()

export function getInworldApiKey() {
  return getSecret('INWORLD_API_KEY', 'inworld-api-key')
}

export function getHumeApiKey() {
  return getSecret('HUME_API_KEY', 'hume-api-key')
}

export function getXaiApiKey() {
  return getSecret('XAI_API_KEY', 'xai-api-key')
}

export function getDeepgramApiKey() {
  return getSecret('DEEPGRAM_API_KEY', 'deepgram-api-key')
}

export function getPersonalPhoneSpeakHandoffSecret() {
  return getSecret('PERSONAL_PHONE_SPEAK_HANDOFF_SECRET', 'personal-phone-speak-handoff-secret')
}

export function getBlueBubblesPassword() {
  const envValue = cleanSecret(process.env.BLUEBUBBLES_PASSWORD)
  if (envValue) return envValue
  if (process.platform !== 'darwin') return ''
  const cacheKey = 'bluebubbles-password'
  if (secretCache.has(cacheKey)) return secretCache.get(cacheKey)

  const value =
    readMacKeychainSecret('bluebubbles-password') ||
    readMacKeychainSecret(`${KEYCHAIN_SERVICE_PREFIX}-bluebubbles-password`)
  secretCache.set(cacheKey, value)
  return value
}

function getSecret(envName, keychainName) {
  const envValue = cleanSecret(process.env[envName])
  if (envValue) return envValue
  if (process.platform !== 'darwin') return ''
  if (secretCache.has(keychainName)) return secretCache.get(keychainName)

  const value = readMacKeychainSecret(`${KEYCHAIN_SERVICE_PREFIX}-${keychainName}`)
  secretCache.set(keychainName, value)
  return value
}

function readMacKeychainSecret(service) {
  for (const args of [
    ['find-generic-password', '-a', process.env.USER || '', '-s', service, '-w'],
    ['find-generic-password', '-s', service, '-w'],
  ]) {
    try {
      const value = cleanSecret(
        execFileSync('security', args, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }),
      )
      if (value) return value
    } catch {
      // Try the next known Keychain lookup shape.
    }
  }
  return ''
}

function cleanSecret(value) {
  return String(value || '').trim()
}
