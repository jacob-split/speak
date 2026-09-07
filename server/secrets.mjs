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
  const envValue = cleanSecret(process.env.XAI_API_KEY)
  if (envValue) return envValue
  if (process.platform !== 'darwin') return ''
  const cacheKey = 'xai-api-key'
  if (secretCache.has(cacheKey)) return secretCache.get(cacheKey)

  const value =
    readMacKeychainAccountSecret('Speak Production', 'XAI_API_KEY') ||
    readMacKeychainSecret(`${KEYCHAIN_SERVICE_PREFIX}-${cacheKey}`)
  secretCache.set(cacheKey, value)
  return value
}

export function getDeepgramApiKey() {
  const envValue = cleanSecret(process.env.DEEPGRAM_API_KEY)
  if (envValue) return envValue
  if (process.platform !== 'darwin') return ''
  const cacheKey = 'deepgram-api-key'
  if (secretCache.has(cacheKey)) return secretCache.get(cacheKey)

  const value =
    readMacKeychainAccountSecret('Speak Production', 'DEEPGRAM_API_KEY') ||
    readMacKeychainSecret(cacheKey)
  secretCache.set(cacheKey, value)
  return value
}

export function getPersonalPhoneSpeakHandoffSecret() {
  const envValue = cleanSecret(process.env.PERSONAL_PHONE_SPEAK_HANDOFF_SECRET)
  if (envValue) return envValue
  if (process.platform !== 'darwin') return ''
  const cacheKey = 'personal-phone-speak-handoff-secret'
  if (secretCache.has(cacheKey)) return secretCache.get(cacheKey)

  const value =
    readMacKeychainAccountSecret(
      'Speak Production',
      'PERSONAL_PHONE_SPEAK_HANDOFF_SECRET',
    ) || readMacKeychainSecret('personal-phone-speak-handoff-secret')
  secretCache.set(cacheKey, value)
  return value
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

function readMacKeychainAccountSecret(service, account) {
  try {
    return cleanSecret(
      execFileSync(
        'security',
        ['find-generic-password', '-s', service, '-a', account, '-w'],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      ),
    )
  } catch {
    return ''
  }
}

function cleanSecret(value) {
  return String(value || '').trim()
}
