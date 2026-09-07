import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  listPhoneProviderOptions,
  parseConfiguredPhoneOptions,
} from '../server/phone-provider-options.mjs'
import { normalizeCampaignConfig } from '../server/runtime-config.mjs'

const envSnapshot = { ...process.env }

try {
  resetEnv()
  process.env.TELNYX_FROM_NUMBER = '+15555551882'
  process.env.TELNYX_CONNECTION_ID = 'telnyx-connection-env'
  process.env.TELNYX_MESSAGING_PROFILE_ID = 'messaging-profile-env'
  const envPayload = await listPhoneProviderOptions({ fetchImpl: null })
  assert.equal(envPayload.provider, 'telnyx')
  assert.equal(envPayload.configured, true)
  assert.equal(envPayload.defaultNumber.phoneNumber, '+15555551882')
  assert.equal(envPayload.defaultNumber.label, 'Personal Phone')
  assert.equal(envPayload.defaultNumber.connectionId, 'telnyx-connection-env')
  assert.equal(envPayload.defaultNumber.messagingProfileId, 'messaging-profile-env')

  const parsed = parseConfiguredPhoneOptions(JSON.stringify([
    {
      id: 'number-a',
      phone_number: '+15555550101',
      label: 'Main Desk',
      connection_id: 'connection-a',
      messaging_profile_id: 'message-a',
      default: true,
    },
    {
      number: '+15555550102',
    },
  ]))
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0].label, 'Main Desk')
  assert.equal(parsed[0].connectionId, 'connection-a')
  assert.equal(parsed[1].phoneNumber, '+15555550102')

  resetEnv()
  process.env.TELNYX_API_KEY = 'telnyx-secret-do-not-leak'
  process.env.TELNYX_FROM_NUMBER = '+15555550199'
  process.env.TELNYX_CONNECTION_ID = 'env-connection'
  let fetchedUrl = ''
  let authorizationHeader = ''
  const telnyxPayload = await listPhoneProviderOptions({
    fetchImpl: async (url, options = {}) => {
      fetchedUrl = url
      authorizationHeader = options.headers?.Authorization || ''
      return {
        ok: true,
        text: async () => JSON.stringify({
          data: [
            {
              id: 'telnyx-number-1',
              phone_number: '+15555550199',
              name: 'Primary Speak',
              connection_id: 'telnyx-native-connection',
              messaging_profile_id: 'telnyx-native-messaging',
            },
            {
              id: 'telnyx-number-2',
              phone_number: '+15555551882',
            },
          ],
        }),
      }
    },
  })
  assert.match(fetchedUrl, /\/phone_numbers\?page\[size\]=100$/)
  assert.equal(authorizationHeader, 'Bearer telnyx-secret-do-not-leak')
  assert.equal(telnyxPayload.proof.source, 'telnyx')
  assert.equal(telnyxPayload.numbers.length, 2)
  assert.equal(telnyxPayload.defaultNumber.phoneNumber, '+15555550199')
  assert.equal(telnyxPayload.defaultNumber.connectionId, 'env-connection')
  assert.equal(telnyxPayload.numbers[1].connectionId, 'env-connection')
  assert.equal(
    JSON.stringify(telnyxPayload).includes('telnyx-secret-do-not-leak'),
    false,
  )

  resetEnv()
  process.env.TELNYX_API_KEY = 'telnyx-secret-do-not-leak'
  const inboundOnlyPayload = await listPhoneProviderOptions({
    fetchImpl: async () => ({
      ok: true,
      text: async () => JSON.stringify({
        data: [{
          id: 'telnyx-inbound-only',
          phone_number: '+15555550177',
          connection_id: 'texml-or-sip-inbound-connection',
        }],
      }),
    }),
  })
  assert.equal(
    Object.hasOwn(inboundOnlyPayload.numbers[0], 'connectionId'),
    false,
    'Telnyx inbound number assignments must never become outbound Call Control IDs',
  )

  resetEnv()
  process.env.TELNYX_API_KEY = 'telnyx-secret-do-not-leak'
  process.env.TELNYX_FROM_NUMBER = '+15555551882'
  const fallbackPayload = await listPhoneProviderOptions({
    fetchImpl: async () => ({
      ok: false,
      text: async () => JSON.stringify({ errors: [{ detail: 'upstream unavailable' }] }),
    }),
  })
  assert.equal(fallbackPayload.proof.source, 'env_after_telnyx_error')
  assert.equal(fallbackPayload.defaultNumber.label, 'Personal Phone')
  assert.match(fallbackPayload.proof.readError, /upstream unavailable/)
  assert.equal(
    JSON.stringify(fallbackPayload).includes('telnyx-secret-do-not-leak'),
    false,
  )

  resetEnv()
  process.env.TELNYX_FROM_NUMBER = '+15555550000'
  process.env.TELNYX_CONNECTION_ID = 'env-connection'
  const profileRuntime = normalizeCampaignConfig({
    telnyxCallerId: '+15555551111',
    telnyxConnectionId: 'profile-connection',
  })
  assert.equal(profileRuntime.telnyxCallerId, '+15555551111')
  assert.equal(profileRuntime.telnyxConnectionId, 'env-connection')

  delete process.env.TELNYX_CONNECTION_ID
  const staleProfileRuntime = normalizeCampaignConfig({
    telnyxConnectionId: 'native-inbound-texml-connection',
  })
  assert.equal(
    staleProfileRuntime.telnyxConnectionId,
    undefined,
    'a saved native phone assignment must not substitute for the workspace Call Control app',
  )
  process.env.TELNYX_CONNECTION_ID = 'env-connection'

  const placeholderRuntime = normalizeCampaignConfig({
    telnyxCallerId: '+1 your phone number',
    telnyxConnectionId: 'Phone connection ID',
  })
  assert.equal(placeholderRuntime.telnyxCallerId, '+15555550000')
  assert.equal(placeholderRuntime.telnyxConnectionId, 'env-connection')

  const serverIndex = readFileSync('server/index.mjs', 'utf8')
  const settingsPanel = readFileSync('src/SpeakSettingsPanel.tsx', 'utf8')
  const workspace = readFileSync('src/AgentConfigWorkspace.tsx', 'utf8')
  const app = readFileSync('src/App.tsx', 'utf8')
  const agentConfigs = readFileSync('src/agentConfigs.ts', 'utf8')
  assert.match(serverIndex, /import \{ listPhoneProviderOptions \} from '\.\/phone-provider-options\.mjs'/)
  assert.match(serverIndex, /app\.get\('\/api\/phone-provider\/options'/)
  assert.match(settingsPanel, /apiUrl\('\/phone-provider\/options'\)/)
  assert.match(settingsPanel, /Speak\/Telnyx caller ID/)
  assert.match(
    settingsPanel,
    /Call Control connection[\s\S]{0,500}disabled=\{Boolean\(backendDefaults\.telnyxConnectionId\)\}/,
  )
  assert.match(
    settingsPanel,
    /Call Control connection[\s\S]{0,500}backendDefaults\.telnyxConnectionId \|\|/,
  )
  const phoneNumberSelection = settingsPanel.slice(
    settingsPanel.indexOf('function selectPhoneProviderNumber'),
    settingsPanel.indexOf('function selectContactSource'),
  )
  assert.doesNotMatch(
    phoneNumberSelection,
    /config\.telnyxConnectionId/,
    'selecting a caller ID must not restore a stale saved Call Control connection',
  )
  assert.match(workspace, /profilePhoneConfigValue/)
  const phoneConnectionReadiness = workspace.slice(
    workspace.indexOf('const selectedPhoneConnectionId'),
    workspace.indexOf('const phoneTestReadiness'),
  )
  assert.doesNotMatch(
    phoneConnectionReadiness,
    /draft\.config\.telnyxConnectionId/,
    'Playground Phone readiness must not accept a stale saved connection ID',
  )
  assert.match(app, /profilePhoneConfigValue/)
  assert.match(agentConfigs, /activeProfile\.config\.telnyxCallerId \|\| fallback\.telnyxCallerId/)

  console.log('Phone provider option checks passed.')
} finally {
  restoreEnv()
}

function resetEnv() {
  for (const key of Object.keys(process.env)) {
    if (
      key.startsWith('TELNYX_') ||
      key.startsWith('SPEAK_PHONE_NUMBER_OPTIONS')
    ) {
      delete process.env[key]
    }
  }
}

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!Object.prototype.hasOwnProperty.call(envSnapshot, key)) {
      delete process.env[key]
    }
  }
  Object.assign(process.env, envSnapshot)
}
