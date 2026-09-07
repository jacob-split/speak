import { existsSync, readFileSync } from 'node:fs'
import {
  getCallToolsApiKey,
  getCallToolsBaseUrl,
  getCallToolsMediaGatewaySharedSecret,
  getCallToolsMediaGatewayUrl,
  boolEnv,
  cleanEmail,
  cleanObject,
  normalizeCallToolsAgentBinding,
  normalizePhone,
  safeLeadText,
  splitPersonName,
} from './runtime-config.mjs'
import { operationalDate } from './operational-time.mjs'

const DEFAULT_PAGE_SIZE = 100
const DEFAULT_CALLTOOLS_API_TIMEOUT_MS = 12_000
const DEFAULT_CALLTOOLS_READINESS_REQUEST_TIMEOUT_MS = 5_000
const DEFAULT_CALLTOOLS_AGENT_SESSION_PATCH_TIMEOUT_MS = 30_000
const DEFAULT_CALLTOOLS_PHONE_CREDENTIAL_TIMEOUT_MS = 20_000
const DEFAULT_CALLTOOLS_HISTORICAL_CALL_START_TOLERANCE_MS = 15 * 60 * 1000
const CALLTOOLS_AGENT_SESSION_BACKEND_PROOF = Object.freeze({
  backendOnly: true,
  headlessOnly: true,
  dashboardRequired: false,
  browserAutomation: false,
  establishPath: 'agentstatuses.patch',
  campaignStartPath: 'campaigns.patch',
  campaignAgentEstablishPath: 'campaignagents.patch',
  mutationEndpoint: '/agentstatuses/{app_user_id}/',
  campaignMutationEndpoint: '/campaigns/{campaign_id}/',
  campaignAgentMutationEndpoint: '/campaignagents/{app_user_id}/',
  proofSources: [
    'agentstatuses.read',
    'campaignagents.read',
    'campaignstatuses.read',
  ],
})
const CALLTOOLS_NEUTRAL_NON_CONTACT_DISPOSITION_MATCHERS = [
  /contact not available/i,
  /no contact/i,
]
const CALLTOOLS_NEUTRAL_COMPLETION_DISPOSITION_MATCHERS = [
  /customer hang up/i,
  ...CALLTOOLS_NEUTRAL_NON_CONTACT_DISPOSITION_MATCHERS,
]
const CALLTOOLS_OUTCOME_DISPOSITION_MATCHERS = {
  completed: CALLTOOLS_NEUTRAL_COMPLETION_DISPOSITION_MATCHERS,
  voicemail: [],
  'not-interested': [/not interested/i],
  callback: [/call back scheduled/i, /callback/i, /call back/i],
  'wrong-number': [/wrong number/i],
  'do-not-call': [/dnc this number/i, /dnc all numbers/i, /\bdnc\b/i],
  'no-answer': CALLTOOLS_NEUTRAL_NON_CONTACT_DISPOSITION_MATCHERS,
  skipped: CALLTOOLS_NEUTRAL_NON_CONTACT_DISPOSITION_MATCHERS,
  failed: CALLTOOLS_NEUTRAL_NON_CONTACT_DISPOSITION_MATCHERS,
  'operator-ended': CALLTOOLS_NEUTRAL_COMPLETION_DISPOSITION_MATCHERS,
}

export function callToolsConfigured() {
  return Boolean(getCallToolsApiKey())
}

export function callToolsMediaGatewayConfigured() {
  return Boolean(getCallToolsMediaGatewaySharedSecret())
}

export function applySharedCallToolsDutyBinding(profile = {}, profiles = []) {
  const profileConfig = profile?.config && typeof profile.config === 'object'
    ? profile.config
    : {}
  const ownBinding = normalizeCallToolsAgentBinding(profileConfig.calltoolsAgentBinding || {})
  const sharedProfile = callToolsDutyBindingReady(ownBinding)
    ? null
    : resolveSharedCallToolsDutyBindingProfile(profiles)
  const adoptedSharedBinding = Boolean(sharedProfile)
  const bindingSourceProfile = sharedProfile || profile
  const dutyBinding = callToolsDutyBindingReady(ownBinding)
    ? ownBinding
    : normalizeCallToolsAgentBinding(sharedProfile?.config?.calltoolsAgentBinding || {})
  return {
    ...profile,
    calltoolsBindingResolution: {
      selectedVoiceProfileId: safeLeadText(profile?.id),
      selectedVoiceProfileName: safeLeadText(profile?.name),
      adoptedSharedBinding,
      source: adoptedSharedBinding ? 'workspace-shared-seat' : 'selected-profile',
      bindingSourceProfileId: safeLeadText(bindingSourceProfile?.id),
      bindingSourceProfileName: safeLeadText(bindingSourceProfile?.name),
    },
    config: {
      ...profileConfig,
      dialerProvider: 'calltools',
      calltoolsAgentBinding: dutyBinding,
    },
  }
}

function resolveSharedCallToolsDutyBindingProfile(profiles = []) {
  const candidates = (Array.isArray(profiles) ? profiles : [])
    .map((profile) => ({
      profile,
      binding: normalizeCallToolsAgentBinding(
        profile?.config?.calltoolsAgentBinding || {},
      ),
    }))
    .filter(({ binding }) => callToolsDutyBindingReady(binding))
    .sort((left, right) => sharedCallToolsBindingProfileKey(left.profile).localeCompare(
      sharedCallToolsBindingProfileKey(right.profile),
    ))
  if (!candidates.length) return null

  const signatures = new Map()
  candidates.forEach((candidate) => {
    const signature = JSON.stringify(callToolsDutyBindingIdentity(candidate.binding))
    const matching = signatures.get(signature) || []
    matching.push(candidate)
    signatures.set(signature, matching)
  })
  if (signatures.size > 1) {
    throw callToolsSharedBindingAmbiguityError(candidates)
  }
  return candidates[0].profile
}

function sharedCallToolsBindingProfileKey(profile = {}) {
  const callToolsPriority =
    safeLeadText(profile?.config?.dialerProvider).toLowerCase() === 'calltools'
      ? '0'
      : '1'
  return [
    callToolsPriority,
    safeLeadText(profile?.id),
    safeLeadText(profile?.name).toLowerCase(),
  ].join(':')
}

function callToolsDutyBindingIdentity(binding = {}) {
  return {
    enabled: Boolean(binding.enabled),
    appUserId: safeLeadText(binding.appUserId || binding.userId),
    phoneId: safeLeadText(binding.phoneId),
    phoneSipUri: safeLeadText(binding.phoneSipUri),
    phoneWebSocketUrl: safeLeadText(binding.phoneWebSocketUrl),
    webCallbackId: safeLeadText(binding.webCallbackId),
    queueId: safeLeadText(binding.queueId),
    campaignId: safeLeadText(binding.campaignId),
    callerIdId: safeLeadText(binding.callerIdId),
    callerIdStrategyId: safeLeadText(binding.callerIdStrategyId),
    liveFilterId: safeLeadText(binding.liveFilterId),
    bucketId: safeLeadText(binding.bucketId),
  }
}

function callToolsSharedBindingAmbiguityError(candidates = []) {
  const identities = candidates.map(({ binding }) =>
    callToolsDutyBindingIdentity(binding),
  )
  const differingFields = Object.keys(identities[0] || {}).filter(
    (field) => new Set(identities.map((identity) => String(identity[field]))).size > 1,
  )
  return Object.assign(
    new Error(
      'Multiple complete CallTools bindings disagree. Assign one binding to the selected agent or make the shared bindings identical before going Available.',
    ),
    {
      status: 409,
      code: 'calltools_shared_binding_ambiguous',
      candidateProfileIds: candidates.map(({ profile }) =>
        safeLeadText(profile?.id || profile?.name),
      ).sort((left, right) => left.localeCompare(right)),
      differingFields,
    },
  )
}

function callToolsDutyBindingReady(binding = {}) {
  return Boolean(
    safeLeadText(binding.phoneId) &&
    safeLeadText(binding.appUserId || binding.userId) &&
    safeLeadText(binding.campaignId),
  )
}

function callToolsReadinessRequestOptions() {
  return {
    timeoutMs: positiveMilliseconds(
      process.env.CALLTOOLS_READINESS_REQUEST_TIMEOUT_MS,
      DEFAULT_CALLTOOLS_READINESS_REQUEST_TIMEOUT_MS,
    ),
    agentSessionPatchTimeoutMs: positiveMilliseconds(
      process.env.CALLTOOLS_AGENT_SESSION_PATCH_TIMEOUT_MS,
      DEFAULT_CALLTOOLS_AGENT_SESSION_PATCH_TIMEOUT_MS,
    ),
  }
}

function callToolsReadOptions(options = {}) {
  const timeoutMs = positiveMilliseconds(options.timeoutMs, 0)
  return timeoutMs ? { timeoutMs } : {}
}

function positiveMilliseconds(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

export async function callToolsRequest(path, options = {}) {
  const apiKey = getCallToolsApiKey()
  if (!apiKey) {
    throw Object.assign(new Error('CALLTOOLS_API_KEY is required'), {
      status: 503,
      code: 'calltools_auth_missing',
    })
  }

  const target = new URL(
    path.startsWith('http') ? path : `${getCallToolsBaseUrl()}/${path.replace(/^\/+/g, '')}`,
  )
  Object.entries(options.query || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      target.searchParams.set(key, String(value))
    }
  })

  const method = options.method || (options.body ? 'POST' : 'GET')
  const timeoutMs = Math.max(
    1_000,
    Number(options.timeoutMs || process.env.CALLTOOLS_API_TIMEOUT_MS || DEFAULT_CALLTOOLS_API_TIMEOUT_MS),
  )
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  let response
  try {
    response = await fetch(target, {
      method,
      headers: {
        Authorization: `Token ${apiKey}`,
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    })
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw Object.assign(new Error(`CallTools request timed out after ${timeoutMs}ms`), {
        status: 504,
        code: 'calltools_request_timeout',
      })
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }

  const contentType = response.headers.get('content-type') || ''
  const payload = contentType.includes('application/json')
    ? await response.json()
    : await response.text()

  if (!response.ok) {
    throw Object.assign(new Error(callToolsErrorMessage(payload, response.statusText)), {
      status: response.status,
      code: 'calltools_request_failed',
      payload: sanitizeCallToolsPayload(payload),
    })
  }

  return options.sanitize === false ? payload : sanitizeCallToolsPayload(payload)
}

export async function downloadCallToolsFilesystemFile(id, options = {}) {
  const fileId = safeLeadText(id)
  if (!fileId) {
    throw Object.assign(new Error('CallTools filesystem file id is required'), {
      status: 400,
      code: 'calltools_filesystem_file_id_missing',
    })
  }
  const apiKey = getCallToolsApiKey()
  if (!apiKey) {
    throw Object.assign(new Error('CALLTOOLS_API_KEY is required'), {
      status: 503,
      code: 'calltools_auth_missing',
    })
  }
  const target = new URL(
    `${getCallToolsBaseUrl()}/filesystemfiles/${encodeURIComponent(fileId)}/download/`,
  )
  const timeoutMs = Math.max(
    1_000,
    Number(options.timeoutMs || process.env.CALLTOOLS_API_TIMEOUT_MS || DEFAULT_CALLTOOLS_API_TIMEOUT_MS),
  )
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  let response
  try {
    response = await fetch(target, {
      method: 'GET',
      headers: {
        Authorization: `Token ${apiKey}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    })
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw Object.assign(new Error(`CallTools file download timed out after ${timeoutMs}ms`), {
        status: 504,
        code: 'calltools_request_timeout',
      })
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }

  const contentType = response.headers.get('content-type') || ''
  const buffer = Buffer.from(await response.arrayBuffer())
  if (!response.ok) {
    let payload = buffer.toString('utf8')
    if (contentType.includes('application/json')) {
      try {
        payload = JSON.parse(payload)
      } catch {
        // Keep the plain text body.
      }
    }
    throw Object.assign(new Error(callToolsErrorMessage(payload, response.statusText)), {
      status: response.status,
      code: 'calltools_request_failed',
      payload: sanitizeCallToolsPayload(payload),
    })
  }

  return {
    id: fileId,
    contentType,
    bytes: buffer.length,
    buffer,
  }
}

export async function listCallToolsOptions(options = {}) {
  const requestOptions = callToolsReadOptions(options)
  const [
    users,
    phones,
    queues,
    campaigns,
    callerIds,
    webCallbacks,
  ] = await Promise.all([
    safeListCallToolsCollection('users', requestOptions),
    safeListCallToolsCollection('phones', {
      ...requestOptions,
      fallbackItems: callToolsPhoneCredentialFallbacks().map(callToolsPhoneCredentialAsApiPhone),
    }),
    safeListCallToolsCollection('queues', requestOptions),
    safeListCallToolsCollection('campaigns', requestOptions),
    safeListCallToolsCollection('callerids', requestOptions),
    safeListCallToolsCollection('webcallbacks', requestOptions),
  ])

  return {
    configured: callToolsConfigured(),
    baseUrl: getCallToolsBaseUrl(),
    mediaGatewayConfigured: callToolsMediaGatewayConfigured(),
    mediaGatewayUrlConfigured: Boolean(getCallToolsMediaGatewayUrl()),
    readErrors: cleanObject({
      users: users.readError,
      phones: phones.readError,
      queues: queues.readError,
      campaigns: campaigns.readError,
      callerIds: callerIds.readError,
      webCallbacks: webCallbacks.readError,
    }),
    users: users.items.map(publicUser),
    phones: phones.items.map(publicPhone),
    queues: queues.items.map(publicQueue),
    campaigns: campaigns.items.map(publicCampaign),
    callerIds: callerIds.items.map(publicCallerId),
    webCallbacks: webCallbacks.items.map(publicWebCallback),
  }
}

export async function readCallToolsPhoneCredentials(phoneId) {
  const requestedPhoneId = safeLeadText(phoneId)
  if (!requestedPhoneId) {
    throw Object.assign(new Error('CALLTOOLS_PHONE_ID is required'), {
      status: 400,
      code: 'calltools_phone_id_missing',
    })
  }

  const fallback = callToolsPhoneCredentialFallback(requestedPhoneId)
  if (fallback && boolEnv('CALLTOOLS_PHONE_CREDENTIAL_FALLBACK_FIRST', false)) {
    return fallback
  }
  let phone
  try {
    const payload = await callToolsRequest(`/phones/${encodeURIComponent(requestedPhoneId)}/`, {
      sanitize: false,
      timeoutMs:
        process.env.CALLTOOLS_PHONE_CREDENTIAL_TIMEOUT_MS ||
        DEFAULT_CALLTOOLS_PHONE_CREDENTIAL_TIMEOUT_MS,
    })
    phone = payload?.data && typeof payload.data === 'object' ? payload.data : payload
  } catch (error) {
    if (fallback) return fallback
    throw error
  }
  if (!phone || safeLeadText(phone.id) !== requestedPhoneId) {
    if (fallback) return fallback
    throw Object.assign(new Error('CallTools phone not found'), {
      status: 404,
      code: 'calltools_phone_not_found',
    })
  }

  return {
    id: safeLeadText(phone.id),
    server: safeLeadText(phone.ws_url),
    uri: safeLeadText(phone.sip_uri),
    authorizationUsername: safeLeadText(phone.username),
    authorizationPassword: safeLeadText(phone.password),
    isWebRtc: Boolean(phone.is_webrtc),
    extension: safeLeadText(phone.extension),
  }
}

function callToolsPhoneCredentialFallback(requestedPhoneId = '') {
  const requested = safeLeadText(requestedPhoneId)
  return (
    callToolsPhoneCredentialFallbacks().find((phone) => {
      const id = safeLeadText(phone.id)
      return !requested || !id || id === requested
    }) || null
  )
}

function callToolsPhoneCredentialFallbacks() {
  const candidates = [
    ...callToolsPhoneCredentialFileCandidates(),
    ...callToolsPhoneCredentialJsonCandidates(),
    callToolsPhoneCredentialEnvCandidate(),
  ].filter(Boolean)
  const seen = new Set()
  return candidates
    .map(normalizeCallToolsPhoneCredential)
    .filter((phone) => {
      if (!phone) return false
      const key = [phone.id, phone.uri, phone.authorizationUsername].join('|')
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

function callToolsPhoneCredentialFileCandidates() {
  const filePath = safeLeadText(
    process.env.CALLTOOLS_PHONE_CREDENTIALS_FILE ||
      process.env.CALLTOOLS_GATEWAY_PHONE_CREDENTIALS_FILE,
  )
  if (!filePath || !existsSync(filePath)) return []
  try {
    return callToolsPhoneCredentialCandidatesFromParsedJson(
      JSON.parse(readFileSync(filePath, 'utf8')),
    )
  } catch {
    return []
  }
}

function callToolsPhoneCredentialJsonCandidates() {
  const raw = safeLeadText(
    process.env.CALLTOOLS_PHONE_CREDENTIALS_JSON ||
      process.env.CALLTOOLS_GATEWAY_PHONE_CREDENTIALS_JSON,
  )
  if (!raw) return []
  try {
    return callToolsPhoneCredentialCandidatesFromParsedJson(JSON.parse(raw))
  } catch {
    return []
  }
}

function callToolsPhoneCredentialCandidatesFromParsedJson(value) {
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value)) return value
  if (Array.isArray(value.phones)) return value.phones
  if (value.phones && typeof value.phones === 'object') return Object.values(value.phones)
  return [value]
}

function callToolsPhoneCredentialEnvCandidate() {
  return cleanObject({
    id: process.env.CALLTOOLS_GATEWAY_PHONE_ID || process.env.CALLTOOLS_PHONE_ID,
    ws_url:
      process.env.CALLTOOLS_GATEWAY_PHONE_WS_URL ||
      process.env.CALLTOOLS_GATEWAY_PHONE_SERVER,
    sip_uri: process.env.CALLTOOLS_GATEWAY_PHONE_SIP_URI,
    username: process.env.CALLTOOLS_GATEWAY_PHONE_USERNAME,
    password: process.env.CALLTOOLS_GATEWAY_PHONE_PASSWORD,
    is_webrtc: process.env.CALLTOOLS_GATEWAY_PHONE_IS_WEBRTC ?? true,
  })
}

function normalizeCallToolsPhoneCredential(value = {}) {
  if (!value || typeof value !== 'object') return null
  const id = safeLeadText(value.id || value.phoneId || value.phone_id)
  const server = safeLeadText(
    value.server || value.ws_url || value.webSocketUrl || value.web_socket_url,
  )
  const uri = safeLeadText(value.uri || value.sip_uri || value.sipUri)
  const authorizationUsername = safeLeadText(
    value.authorizationUsername || value.username || value.auth_username,
  )
  const authorizationPassword = safeLeadText(
    value.authorizationPassword || value.password || value.auth_password,
  )
  if (!server || !uri || !authorizationUsername || !authorizationPassword) return null
  return {
    id,
    server,
    uri,
    authorizationUsername,
    authorizationPassword,
    isWebRtc: value.isWebRtc ?? value.is_webrtc ?? true,
    extension: safeLeadText(value.extension),
    source: 'local_fallback',
  }
}

function callToolsPhoneCredentialAsApiPhone(phone = {}) {
  return {
    id: phone.id,
    ws_url: phone.server,
    sip_uri: phone.uri,
    username: phone.authorizationUsername,
    is_webrtc: phone.isWebRtc,
    name: 'Local CallTools gateway phone credential',
  }
}

export async function verifyCallToolsAgentBinding(config = {}, options = {}) {
  const binding = normalizeCallToolsAgentBinding(config.calltoolsAgentBinding || {})
  const callToolsOptions = await listCallToolsOptions(options)
  const requestOptions = callToolsReadOptions(options)
  const appUserId = binding.appUserId || binding.userId
  const user = appUserId
    ? callToolsOptions.users.find((item) => item.appUserId === appUserId || item.id === appUserId)
    : null
  const phone = binding.phoneId
    ? callToolsOptions.phones.find((item) => item.id === binding.phoneId)
    : null
  const listedCampaign = binding.campaignId
    ? callToolsOptions.campaigns.find((item) => item.id === binding.campaignId)
    : null
  let campaign = listedCampaign
  let campaignDetailReadError = ''
  if (binding.campaignId) {
    try {
      const campaignDetail = publicCampaign(
        await callToolsRequest(`/campaigns/${encodeURIComponent(binding.campaignId)}/`, {
          timeoutMs: requestOptions.timeoutMs,
        }),
      )
      if (campaignDetail.id) campaign = campaignDetail
    } catch (error) {
      campaignDetailReadError = callToolsErrorMessage(error?.payload || null, error?.message)
    }
  }
  const queue = binding.queueId
    ? callToolsOptions.queues.find((item) => item.id === binding.queueId)
    : null
  const webCallback = binding.webCallbackId
    ? callToolsOptions.webCallbacks.find((item) => item.id === binding.webCallbackId)
    : null

  const readErrors = {
    ...(callToolsOptions.readErrors || {}),
    campaignDetail: campaignDetailReadError,
  }
  const missing = []
  if (!callToolsOptions.configured) missing.push('CALLTOOLS_API_KEY')
  if (!appUserId) missing.push('CALLTOOLS_AGENT_USER_ID')
  if (appUserId && !user) {
    missing.push(readErrors.users ? 'CALLTOOLS_USERS_READ_FAILED' : 'CALLTOOLS_AGENT_USER_NOT_FOUND')
  }
  if (!binding.phoneId) missing.push('CALLTOOLS_PHONE_ID')
  if (binding.phoneId && !phone) {
    missing.push(readErrors.phones ? 'CALLTOOLS_PHONES_READ_FAILED' : 'CALLTOOLS_PHONE_NOT_FOUND')
  }
  if (binding.campaignId && !campaign) {
    missing.push(readErrors.campaigns ? 'CALLTOOLS_CAMPAIGNS_READ_FAILED' : 'CALLTOOLS_CAMPAIGN_NOT_FOUND')
  }
  if (binding.queueId && !queue) {
    missing.push(readErrors.queues ? 'CALLTOOLS_QUEUES_READ_FAILED' : 'CALLTOOLS_QUEUE_NOT_FOUND')
  }
  if (binding.webCallbackId && !webCallback) {
    missing.push(
      readErrors.webCallbacks
        ? 'CALLTOOLS_WEB_CALLBACKS_READ_FAILED'
        : 'CALLTOOLS_WEB_CALLBACK_NOT_FOUND',
    )
  }
  if (!callToolsMediaGatewayConfigured()) missing.push('CALLTOOLS_MEDIA_GATEWAY')

  return {
    ok: missing.length === 0,
    missing,
    binding: {
      ...binding,
      provisioningStatus: missing.length === 0 ? 'ready' : appUserId || binding.phoneId
          ? 'linked'
          : 'unconfigured',
      mediaGatewayStatus: callToolsMediaGatewayConfigured() ? 'configured' : 'unconfigured',
      lastVerifiedAt: new Date().toISOString(),
    },
    matched: {
      user,
      phone,
      campaign,
      queue,
      webCallback,
    },
    options: {
      ...callToolsOptions,
      readErrors: cleanObject(readErrors),
    },
  }
}

export async function buildCallToolsProvisioningPlan({ profile, apply = false } = {}) {
  const profileName = safeLeadText(profile?.name || profile?.config?.agentProfileName || 'Speak agent')
  const config = profile?.config || profile || {}
  const verification = await verifyCallToolsAgentBinding(config)
  const existingUser = verification.matched.user || verification.options.users[0] || null
  const existingPhone = verification.matched.phone || verification.options.phones[0] || null
  const existingCampaign = verification.matched.campaign || verification.options.campaigns[0] || null
  const existingQueue = verification.matched.queue || verification.options.queues[0] || null
  const existingWebCallback =
    verification.matched.webCallback ||
    selectCallToolsWebCallbackForPhone(verification.options.webCallbacks, existingPhone) ||
    verification.options.webCallbacks[0] ||
    null

  const nextBinding = normalizeCallToolsAgentBinding({
    ...config.calltoolsAgentBinding,
    enabled: true,
    appUserId: existingUser?.appUserId || existingUser?.id || '',
    userId: existingUser?.appUserId || existingUser?.id || '',
    phoneId: existingPhone?.id || '',
    phoneSipUri: existingPhone?.sipUri || '',
    phoneWebSocketUrl: existingPhone?.webSocketUrl || '',
    webCallbackId: existingWebCallback?.id || '',
    queueId: existingQueue?.id || '',
    campaignId: existingCampaign?.id || '',
    callerIdId: verification.options.callerIds[0]?.id || '',
    callerIdStrategyId: existingCampaign?.callerIdStrategyId || '',
    liveFilterId: existingCampaign?.liveFilterId || '',
    bucketId: existingCampaign?.bucketId || '',
    provisioningStatus: existingUser && existingPhone ? 'linked' : 'blocked',
    mediaGatewayStatus: callToolsMediaGatewayConfigured() ? 'configured' : 'unconfigured',
    lastVerifiedAt: new Date().toISOString(),
  })

  return {
    applied: false,
    applyRequested: Boolean(apply),
    mutationPerformed: false,
    profileName,
    binding: nextBinding,
    readiness: {
      ok: verification.missing.filter((item) => item !== 'CALLTOOLS_MEDIA_GATEWAY').length === 0,
      missing: verification.missing,
    },
    steps: [
      {
        key: 'agent-user',
        status: existingUser ? 'linked' : 'requires_create',
        label: existingUser ? 'Use existing CallTools agent user' : 'Create CallTools agent user',
      },
      {
        key: 'phone',
        status: existingPhone ? 'linked' : 'requires_create',
        label: existingPhone ? 'Use existing CallTools WebRTC/SIP phone' : 'Create CallTools phone',
      },
      {
        key: 'web-callback',
        status: existingWebCallback ? 'linked' : 'optional',
        label: existingWebCallback
          ? 'Record existing CallTools Web Call Back route'
          : 'Optional: record a CallTools Web Call Back route for PBX metadata only',
      },
      {
        key: 'campaign',
        status: existingCampaign ? 'linked' : 'requires_selection',
        label: existingCampaign ? 'Use existing CallTools campaign' : 'Select or create CallTools campaign',
      },
      {
        key: 'queue',
        status: existingQueue ? 'linked' : 'optional',
        label: existingQueue ? 'Use existing CallTools queue' : 'Attach a queue if inbound routing is needed',
      },
      {
        key: 'media-gateway',
        status: callToolsMediaGatewayConfigured() ? 'registered' : 'blocked',
        label: 'Register the Speak media gateway to the CallTools phone before live audio',
      },
    ],
  }
}

export async function auditCallToolsReadiness({ profile = {}, gatewayStatus = {} } = {}) {
  const config = profile?.config || profile || {}
  const readinessRequest = callToolsReadinessRequestOptions()
  const verification = await verifyCallToolsAgentBinding(config, readinessRequest)
  const binding = normalizeCallToolsAgentBinding({
    ...config.calltoolsAgentBinding,
    ...verification.binding,
  })
  const optionReadErrors = verification.options.readErrors || {}
  const campaign = verification.matched.campaign || null
  const phone = verification.matched.phone || null
  const user = verification.matched.user || null
  const webCallback = verification.matched.webCallback || null
  const liveFilterId = campaign?.id ? campaign.liveFilterId || '' : binding.liveFilterId || ''
  const bucketId = campaign?.id ? campaign.bucketId || '' : binding.bucketId || ''
  const sourceKind = liveFilterId ? 'live-filter' : bucketId ? 'bucket' : 'unconfigured'
  const [
    liveFilter,
    bucket,
    bucketMembership,
    sourceSelectable,
    dispositionsResult,
    liveCalls,
    agentStatus,
    campaignAgentStatus,
    campaignStatus,
  ] = await Promise.all([
    liveFilterId
      ? readCallToolsLiveFilter(liveFilterId, readinessRequest).catch((error) => ({
          id: liveFilterId,
          readError: callToolsErrorMessage(error?.payload || null, error?.message),
        }))
      : null,
    bucketId
      ? readCallToolsBucket(bucketId, readinessRequest).catch((error) => ({
          id: bucketId,
          readError: callToolsErrorMessage(error?.payload || null, error?.message),
        }))
      : null,
    bucketId
      ? readCallToolsBucketMembershipCount(bucketId, readinessRequest).catch((error) => ({
          bucketId,
          readError: callToolsErrorMessage(error?.payload || null, error?.message),
        }))
      : null,
    readCallToolsSourceSelectableContacts({
      sourceKind,
      liveFilterId,
      bucketId,
      ...readinessRequest,
    }).catch((error) => ({
      readError: callToolsErrorMessage(error?.payload || null, error?.message),
      selectableNowCount: 0,
      readyContactCount: 0,
      checkedContactCount: 0,
      suppressedContactCount: 0,
    })),
    listCallToolsDispositions(readinessRequest)
      .then((items) => ({ items, readError: '' }))
      .catch((error) => ({
        items: [],
        readError: callToolsErrorMessage(error?.payload || null, error?.message),
      })),
    listCallToolsLiveCalls(binding, readinessRequest).catch(() => []),
    readCallToolsAgentStatus(binding.appUserId || binding.userId, readinessRequest).catch((error) => ({
      appUser: binding.appUserId || binding.userId,
      readError: callToolsErrorMessage(error?.payload || null, error?.message),
    })),
    readCallToolsCampaignAgentStatus(binding.appUserId || binding.userId, readinessRequest)
      .catch((error) => ({
        appUser: binding.appUserId || binding.userId,
        readError: callToolsErrorMessage(error?.payload || null, error?.message),
      })),
    readCallToolsCampaignStatus(binding.campaignId, readinessRequest).catch((error) => ({
      campaignId: binding.campaignId,
      readError: callToolsErrorMessage(error?.payload || null, error?.message),
    })),
  ])
  const agentSessionProof = callToolsAgentSessionProof({
    agentStatus,
    campaignAgentStatus,
    campaignStatus,
    campaignId: binding.campaignId,
  })
  const directAgentSessionReady = Boolean(
    agentStatus?.appUser &&
      !agentStatus.readError &&
      agentStatus.ready &&
      callToolsWebPhoneRegistered(agentStatus.webPhoneStatus) &&
      agentStatus.webPhoneRegisteredOn,
  )
  const dispositions = dispositionsResult.items || []
  const dispositionsReadError = dispositionsResult.readError || ''
  const outcomeCoverage = callToolsDispositionCoverage(dispositions)
  const requiredOutcomeMissing = outcomeCoverage
    .filter((item) => item.required && !item.dispositionId)
    .map((item) => item.outcome)
  const campaignSelectableContactCount = Number(campaignStatus?.totalContactCount || 0)
  const sourceSelectableContactCount = Number(sourceSelectable?.selectableNowCount || 0)
  const sourceReadyContactCount = Number(sourceSelectable?.readyContactCount || 0)
  const effectiveSelectableContactCount = Math.max(
    campaignSelectableContactCount,
    sourceSelectableContactCount,
  )
  const campaignSelectableInventoryReady =
    Boolean(sourceSelectable?.readError)
      ? (!campaignStatus || campaignStatus.readError || campaignSelectableContactCount > 0)
      : effectiveSelectableContactCount > 0
  const campaignSelectableInventoryBlocker =
    !campaignSelectableInventoryReady
      ? 'CALLTOOLS_CAMPAIGN_NO_SELECTABLE_CONTACTS'
      : ''
  const liveFilterReportedCount = Number(liveFilter?.count || 0)
  const bucketReportedCount = Number(bucket?.count || 0)
  const bucketMembershipCount =
    bucketMembership && !bucketMembership.readError ? Number(bucketMembership.count || 0) : 0
  const liveFilterEffectiveCount = Math.max(
    liveFilterReportedCount,
    campaignSelectableContactCount,
    sourceReadyContactCount,
    sourceSelectableContactCount,
  )
  const bucketEffectiveCount = Math.max(
    bucketReportedCount,
    campaignSelectableContactCount,
    bucketMembershipCount,
    sourceReadyContactCount,
    sourceSelectableContactCount,
  )
  const checks = [
    readinessCheck({
      id: 'api-auth',
      label: 'CallTools API credentials',
      ready: verification.options.configured,
      blockers: verification.options.configured ? [] : ['CALLTOOLS_API_KEY'],
      proof: {
        baseUrl: verification.options.baseUrl,
      },
    }),
    readinessCheck({
      id: 'agent-user',
      label: 'CallTools agent user binding',
      ready: Boolean(user?.id && user?.isAgent),
      blockers: [
        !binding.appUserId && !binding.userId ? 'CALLTOOLS_AGENT_USER_ID' : '',
        (binding.appUserId || binding.userId) && !user
          ? optionReadErrors.users
            ? 'CALLTOOLS_USERS_READ_FAILED'
            : 'CALLTOOLS_AGENT_USER_NOT_FOUND'
          : '',
        user && !user.isAgent ? 'CALLTOOLS_USER_NOT_AGENT' : '',
      ],
      proof: user
        ? {
            appUserId: user.appUserId || user.id,
            name: user.name,
            isAgent: user.isAgent,
            isManager: user.isManager,
          }
        : cleanObject({ readError: optionReadErrors.users }),
    }),
    readinessCheck({
      id: 'webrtc-phone',
      label: 'CallTools WebRTC/SIP phone binding',
      ready: Boolean(phone?.id && phone?.isWebRtc && phone?.sipUri && phone?.webSocketUrl),
      blockers: [
        !binding.phoneId ? 'CALLTOOLS_PHONE_ID' : '',
        binding.phoneId && !phone
          ? optionReadErrors.phones
            ? 'CALLTOOLS_PHONES_READ_FAILED'
            : 'CALLTOOLS_PHONE_NOT_FOUND'
          : '',
        phone && !phone.isWebRtc ? 'CALLTOOLS_PHONE_NOT_WEBRTC' : '',
        phone && !phone.sipUri ? 'CALLTOOLS_PHONE_SIP_URI_MISSING' : '',
        phone && !phone.webSocketUrl ? 'CALLTOOLS_PHONE_WS_URL_MISSING' : '',
      ],
      proof: phone
        ? {
            phoneId: phone.id,
            name: phone.name,
            isWebRtc: phone.isWebRtc,
            sipUriConfigured: Boolean(phone.sipUri),
            webSocketUrlConfigured: Boolean(phone.webSocketUrl),
            callRecording: phone.callRecording,
          }
        : cleanObject({ readError: optionReadErrors.phones }),
    }),
    readinessCheck({
      id: 'agent-session',
      label: 'CallTools native agent session',
      ready: Boolean(
          agentStatus?.appUser &&
          !agentStatus.readError &&
          agentStatus.ready &&
          agentSessionProof.loggedIn &&
          callToolsWebPhoneRegistered(agentStatus.webPhoneStatus) &&
          agentStatus.webPhoneRegisteredOn,
      ),
      blockers: [
        (binding.appUserId || binding.userId) && !agentStatus ? 'CALLTOOLS_AGENT_STATUS_NOT_FOUND' : '',
        agentStatus?.readError ? 'CALLTOOLS_AGENT_STATUS_READ_FAILED' : '',
        agentStatus && !agentStatus.readError && !agentStatus.ready
          ? 'CALLTOOLS_AGENT_NOT_READY'
          : '',
        campaignAgentStatus?.readError ? 'CALLTOOLS_CAMPAIGN_AGENT_STATUS_READ_FAILED' : '',
        campaignAgentStatus &&
        !campaignAgentStatus.readError &&
        !agentSessionProof.campaignAgentReady
          ? 'CALLTOOLS_CAMPAIGN_AGENT_NOT_READY'
          : '',
        agentStatus && !agentStatus.readError && !agentSessionProof.loggedIn
          ? 'CALLTOOLS_AGENT_NOT_LOGGED_IN'
          : '',
        agentStatus && !agentStatus.readError && !callToolsWebPhoneRegistered(agentStatus.webPhoneStatus)
          ? 'CALLTOOLS_AGENT_WEB_PHONE_NOT_REGISTERED'
          : '',
        agentStatus &&
        !agentStatus.readError &&
        callToolsWebPhoneRegistered(agentStatus.webPhoneStatus) &&
        !agentStatus.webPhoneRegisteredOn
          ? 'CALLTOOLS_AGENT_WEB_PHONE_NATIVE_SESSION_MISSING'
          : '',
      ],
      proof: agentStatus
        ? {
            ...CALLTOOLS_AGENT_SESSION_BACKEND_PROOF,
            appUserId: agentStatus.appUser,
            name: agentStatus.fullName,
            ready: agentStatus.ready,
            loggedIn: agentSessionProof.loggedIn,
            nativeLoggedIn: agentSessionProof.nativeLoggedIn,
            campaignLoginProof: agentSessionProof.campaignLoginProof,
            campaignIdMatches: agentSessionProof.campaignIdMatches,
            campaignAgentProof: agentSessionProof.campaignAgentProof,
            campaignAgentReady: agentSessionProof.campaignAgentReady,
            campaignAgentCampaignIdMatches: agentSessionProof.campaignAgentCampaignIdMatches,
            campaignId: agentStatus.campaignId,
            campaignName: agentStatus.campaignName,
            webPhoneStatus: agentStatus.webPhoneStatus,
            webPhoneRegisteredOn: agentStatus.webPhoneRegisteredOn,
            psEndpointId: agentStatus.psEndpointId,
            liveCallsCount: agentStatus.liveCallsCount,
            campaignAgentReadError: campaignAgentStatus?.readError,
            campaignLoggedInAgents: agentSessionProof.campaignLoggedInAgents,
            campaignWaitingAgents: agentSessionProof.campaignWaitingAgents,
            campaignPhoneCallAgents: agentSessionProof.campaignPhoneCallAgents,
            readError: agentStatus.readError,
          }
        : {},
    }),
    readinessCheck({
      id: 'media-gateway',
      label: 'Speak CallTools media gateway registration',
      ready: Boolean(gatewayStatus.connected),
      blockers: [
        !callToolsMediaGatewayConfigured() ? 'CALLTOOLS_MEDIA_GATEWAY_SECRET_MISSING' : '',
        callToolsMediaGatewayConfigured() && !gatewayStatus.connected
          ? 'CALLTOOLS_MEDIA_GATEWAY_NOT_REGISTERED'
          : '',
      ],
      proof: {
        status: gatewayStatus.status || (gatewayStatus.connected ? 'registered' : 'unconfigured'),
        connectionCount: Number(gatewayStatus.connectionCount || 0),
        healthyConnectionCount: Number(gatewayStatus.healthyConnectionCount || 0),
        profileId: safeLeadText(gatewayStatus.gateway?.profileId),
        phoneId: safeLeadText(gatewayStatus.gateway?.phoneId),
        sampleRate: Number(gatewayStatus.gateway?.sampleRate || 0) || undefined,
        healthy: Boolean(gatewayStatus.gateway?.healthy),
        stale: Boolean(gatewayStatus.gateway?.stale),
        connectedAt: safeLeadText(gatewayStatus.gateway?.connectedAt),
        connectedAgeMs: Number.isFinite(Number(gatewayStatus.gateway?.connectedAgeMs))
          ? Number(gatewayStatus.gateway?.connectedAgeMs)
          : undefined,
        lastSeenAt: safeLeadText(gatewayStatus.gateway?.lastSeenAt),
        lastSeenAgeMs: Number.isFinite(Number(gatewayStatus.gateway?.lastSeenAgeMs))
          ? Number(gatewayStatus.gateway?.lastSeenAgeMs)
          : undefined,
        heartbeatStaleAfterMs: Number.isFinite(
          Number(gatewayStatus.gateway?.heartbeatStaleAfterMs || gatewayStatus.heartbeatStaleAfterMs),
        )
          ? Number(gatewayStatus.gateway?.heartbeatStaleAfterMs || gatewayStatus.heartbeatStaleAfterMs)
          : undefined,
        activeCallControlId: safeLeadText(gatewayStatus.gateway?.activeCallControlId),
      },
    }),
    readinessCheck({
      id: 'web-callback',
      label: 'CallTools Web Call Back route (not used for Speak live start)',
      ready: Boolean(!binding.webCallbackId || (webCallback?.id && webCallback?.active && webCallback?.nextDestination)),
      blockers: [
        binding.webCallbackId && !webCallback
          ? optionReadErrors.webCallbacks
            ? 'CALLTOOLS_WEB_CALLBACKS_READ_FAILED'
            : 'CALLTOOLS_WEB_CALLBACK_NOT_FOUND'
          : '',
        webCallback && !integerOrEmpty(webCallback.id) ? 'CALLTOOLS_WEB_CALLBACK_ID_INVALID' : '',
        webCallback && !webCallback.active ? 'CALLTOOLS_WEB_CALLBACK_INACTIVE' : '',
        webCallback && !webCallback.nextDestination ? 'CALLTOOLS_WEB_CALLBACK_DESTINATION_MISSING' : '',
      ],
      proof: webCallback
        ? {
            webCallbackId: webCallback.id,
            name: webCallback.name,
            active: webCallback.active,
            nextDestination: webCallback.nextDestination,
            callerIdStrategyId: webCallback.callerIdStrategyId,
            ringTime: webCallback.ringTime,
            retries: webCallback.retries,
          }
        : cleanObject({ readError: optionReadErrors.webCallbacks }),
    }),
    readinessCheck({
      id: 'campaign',
      label: 'CallTools campaign origination',
      ready: Boolean(campaign?.id && campaign?.active && campaign?.originateCalls),
      blockers: [
        !binding.campaignId ? 'CALLTOOLS_CAMPAIGN_ID' : '',
        binding.campaignId && !campaign
          ? optionReadErrors.campaigns
            ? 'CALLTOOLS_CAMPAIGNS_READ_FAILED'
            : 'CALLTOOLS_CAMPAIGN_NOT_FOUND'
          : '',
        campaign && !campaign.active ? 'CALLTOOLS_CAMPAIGN_INACTIVE' : '',
        campaign && !campaign.originateCalls ? 'CALLTOOLS_CAMPAIGN_ORIGINATION_DISABLED' : '',
      ],
      proof: campaign
        ? {
            campaignId: campaign.id,
            name: campaign.name,
            active: campaign.active,
            originateCalls: campaign.originateCalls,
            channelsPerAgent: campaign.channelsPerAgent,
            amdActive: campaign.amdActive,
            callRecording: campaign.callRecording,
            liveFilterId: campaign.liveFilterId,
            bucketId: campaign.bucketId,
            sourceKind,
            statusWarning: safeLeadText(campaignStatus?.warningMessage),
            loggedInAgents: campaignStatus?.loggedInAgents,
            waitingAgents: campaignStatus?.waitingAgents,
            phoneCallAgents: campaignStatus?.phoneCallAgents,
            totalContactCount: campaignStatus?.totalContactCount,
          }
        : cleanObject({ readError: optionReadErrors.campaigns }),
    }),
    readinessCheck({
      id: 'caller-id',
      label: 'CallTools caller ID strategy or campaign caller ID',
      ready: Boolean(
        binding.callerIdId ||
          binding.callerIdStrategyId ||
          campaign?.callerIdStrategyId ||
          verification.options.callerIds.length,
      ),
      blockers:
        binding.callerIdId ||
        binding.callerIdStrategyId ||
        campaign?.callerIdStrategyId ||
        verification.options.callerIds.length
          ? []
          : [
              optionReadErrors.callerIds
                ? 'CALLTOOLS_CALLER_IDS_READ_FAILED'
                : 'CALLTOOLS_CALLER_ID_OR_STRATEGY_REQUIRED',
            ],
      proof: {
        callerIdId: binding.callerIdId,
        callerIdStrategyId: binding.callerIdStrategyId || campaign?.callerIdStrategyId || '',
        callerIdCount: verification.options.callerIds.length,
        readError: optionReadErrors.callerIds,
      },
    }),
    readinessCheck({
      id: 'campaign-source',
      label: 'CallTools campaign source inventory',
      ready:
        sourceKind === 'live-filter'
          ? Boolean(
              liveFilter?.id &&
                liveFilter?.active &&
                liveFilterEffectiveCount > 0 &&
                campaignSelectableInventoryReady,
            )
          : sourceKind === 'bucket'
            ? Boolean(bucket?.id && bucketEffectiveCount > 0 && campaignSelectableInventoryReady)
            : false,
      blockers: [
        !liveFilterId && !bucketId ? 'CALLTOOLS_CAMPAIGN_SOURCE_ID' : '',
        liveFilterId && !liveFilter ? 'CALLTOOLS_LIVE_FILTER_NOT_FOUND' : '',
        bucketId && !bucket ? 'CALLTOOLS_BUCKET_NOT_FOUND' : '',
        liveFilter?.readError ? 'CALLTOOLS_LIVE_FILTER_READ_FAILED' : '',
        bucket?.readError ? 'CALLTOOLS_BUCKET_READ_FAILED' : '',
        liveFilter && !liveFilter.readError && !liveFilter.active
          ? 'CALLTOOLS_LIVE_FILTER_INACTIVE'
          : '',
        liveFilter && !liveFilter.readError && liveFilterEffectiveCount <= 0
          ? 'CALLTOOLS_LIVE_FILTER_EMPTY'
          : '',
        bucket && !bucket.readError && bucketEffectiveCount <= 0 ? 'CALLTOOLS_BUCKET_EMPTY' : '',
        campaignSelectableInventoryBlocker,
      ],
      proof:
        sourceKind === 'live-filter' && liveFilter
          ? {
              sourceKind,
              liveFilterId: liveFilter.id || liveFilterId,
              name: safeLeadText(liveFilter.name),
              active: Boolean(liveFilter.active),
              count: liveFilterEffectiveCount,
              reportedCount: liveFilterReportedCount,
              readyContactCount: sourceReadyContactCount,
              sourceSelectableContactCount,
              ignoreTimeZoneCount: Number(liveFilter.ignore_time_zone_count || 0),
              filterContactReady: Boolean(liveFilter.filter_contact_ready),
              suppressDnc: Boolean(liveFilter.suppress_dnc),
              filterFdncNumbers: Boolean(liveFilter.filter_fdnc_numbers_flag),
              respectSuppressUntil: Boolean(liveFilter.respect_suppress_until),
              warningMessage: safeLeadText(liveFilter.warning_message),
              selectableContactCount: effectiveSelectableContactCount,
              campaignStatusSelectableContactCount: campaignSelectableContactCount,
              checkedContactCount: Number(sourceSelectable?.checkedContactCount || 0),
              suppressedContactCount: Number(sourceSelectable?.suppressedContactCount || 0),
              campaignStatusWarning: safeLeadText(campaignStatus?.warningMessage),
              readError: liveFilter.readError || sourceSelectable?.readError,
            }
          : sourceKind === 'bucket' && bucket
            ? {
                sourceKind,
                bucketId: bucket.id || bucketId,
                name: safeLeadText(bucket.name),
                count: bucketEffectiveCount,
                reportedCount: bucketReportedCount,
                membershipCount: bucketMembershipCount,
                readyContactCount: sourceReadyContactCount,
                sourceSelectableContactCount,
                filterStateHoursHolidays: Boolean(bucket.filter_state_hours_holidays),
                warningMessage: safeLeadText(bucket.warning_message),
                selectableContactCount: effectiveSelectableContactCount,
                campaignStatusSelectableContactCount: campaignSelectableContactCount,
                checkedContactCount: Number(sourceSelectable?.checkedContactCount || 0),
                suppressedContactCount: Number(sourceSelectable?.suppressedContactCount || 0),
                campaignStatusWarning: safeLeadText(campaignStatus?.warningMessage),
                readError: bucket.readError || sourceSelectable?.readError,
              }
            : { sourceKind, liveFilterId, bucketId },
	    }),
    readinessCheck({
      id: 'dispositions',
      label: 'CallTools native disposition mapping',
      ready: !dispositionsReadError && requiredOutcomeMissing.length === 0,
      blockers: dispositionsReadError
        ? ['CALLTOOLS_DISPOSITIONS_READ_FAILED']
        : requiredOutcomeMissing.length
          ? requiredOutcomeMissing.map((outcome) => `CALLTOOLS_DISPOSITION_MISSING_${outcome.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`)
          : [],
      proof: {
        dispositionCount: dispositions.length,
        outcomeCoverage,
        readError: dispositionsReadError,
      },
    }),
    {
      id: 'live-calls',
      label: 'Current CallTools live calls',
      status: liveCalls.length ? 'ready' : 'not_applicable',
      blockers: [],
      warnings: liveCalls.length ? [] : ['CALLTOOLS_NO_ACTIVE_LIVE_CALLS'],
      proof: {
        activeLiveCallCount: liveCalls.length,
        liveCalls: liveCalls.slice(0, 5).map(publicLiveCall),
      },
    },
    {
      id: 'outcome-writeback',
      label: 'CallTools historical disposition writeback',
      status: callToolsOutcomeAutoSyncEnabled() ? 'ready' : 'not_applicable',
      blockers: [],
      warnings: callToolsOutcomeAutoSyncEnabled()
        ? []
        : ['CALLTOOLS_SYNC_OUTCOMES_FALSE_PROOF_ONLY'],
      proof: {
        syncOutcomes: callToolsOutcomeAutoSyncEnabled(),
        mode: callToolsOutcomeAutoSyncEnabled() ? 'writeback' : 'proof_only',
      },
    },
  ]
  const runtimeCheckIds = [
    'api-auth',
    'agent-user',
    'webrtc-phone',
    'media-gateway',
    'dispositions',
  ]
  const campaignCheckIds = ['agent-session', 'campaign', 'caller-id', 'campaign-source']
  const runtimeChecks = checks.filter((check) => runtimeCheckIds.includes(check.id))
  const campaignChecks = checks.filter((check) => campaignCheckIds.includes(check.id))
  const runtimeBlockers = [...new Set(runtimeChecks.flatMap((check) => check.blockers || []))]
  const campaignBlockers = [...new Set(campaignChecks.flatMap((check) => check.blockers || []))]
  const blockers = [...new Set([...runtimeBlockers, ...campaignBlockers])]
  const runtimeReady = runtimeCheckIds
    .every((id) => checks.find((check) => check.id === id)?.status === 'ready')
  const campaignReady = campaignCheckIds
    .every((id) => checks.find((check) => check.id === id)?.status === 'ready')
  const directStartReady = Boolean(runtimeReady && directAgentSessionReady)
  const ready = runtimeReady && campaignReady

  return {
    provider: 'calltools',
    profileId: safeLeadText(profile.id || profile.profileId),
    profileName: safeLeadText(profile.name || config.agentProfileName || 'CallTools profile'),
    bindingResolution:
      profile.calltoolsBindingResolution && typeof profile.calltoolsBindingResolution === 'object'
        ? profile.calltoolsBindingResolution
        : undefined,
    checkedAt: new Date().toISOString(),
    configured: Boolean(verification.options.configured),
    ready,
    runtimeReady,
    campaignReady,
    directStartReady,
    liveCallAttached: liveCalls.length > 0,
    mode: 'phone_as_agent',
    blockers,
    runtimeBlockers,
    campaignBlockers,
    warnings: [...new Set(checks.flatMap((check) => check.warnings || []))],
    binding: cleanObject({
      appUserId: binding.appUserId || binding.userId,
      phoneId: binding.phoneId,
      webCallbackId: binding.webCallbackId,
      campaignId: binding.campaignId,
      queueId: binding.queueId,
      callerIdId: binding.callerIdId,
      callerIdStrategyId: binding.callerIdStrategyId || campaign?.callerIdStrategyId,
      liveFilterId,
      bucketId,
      campaignSourceKind: sourceKind,
      contactMatchMode: binding.contactMatchMode,
      mediaGatewayStatus: gatewayStatus.status || binding.mediaGatewayStatus,
    }),
    checks,
    counts: {
      users: verification.options.users.length,
      phones: verification.options.phones.length,
      queues: verification.options.queues.length,
      campaigns: verification.options.campaigns.length,
      callerIds: verification.options.callerIds.length,
      webCallbacks: verification.options.webCallbacks.length,
      dispositions: dispositions.length,
      liveCalls: liveCalls.length,
    },
    readErrors: verification.options.readErrors || {},
    nextAction: ready
      ? 'CallTools native campaign routing is ready for Speak agent proof calls.'
      : callToolsReadinessNextAction(blockers),
  }
}

export async function readCallToolsDutyStatus({
  binding = {},
  includeSeatClaimProof = false,
} = {}) {
  const requestOptions = callToolsReadinessRequestOptions()
  const appUserId = safeLeadText(binding.appUserId || binding.userId)
  const campaignId = safeLeadText(binding.campaignId)
  const [agentStatus, campaignAgentStatus, campaignStatus, liveCallsResult] = await Promise.all([
    appUserId
      ? readCallToolsAgentStatus(appUserId, requestOptions).catch((error) => ({
          readError: callToolsErrorMessage(error?.payload || null, error?.message),
        }))
      : Promise.resolve({ readError: 'CALLTOOLS_AGENT_USER_ID' }),
    includeSeatClaimProof && appUserId
      ? readCallToolsCampaignAgentStatus(appUserId, requestOptions).catch((error) => ({
          readError: callToolsErrorMessage(error?.payload || null, error?.message),
        }))
      : Promise.resolve(null),
    campaignId
      ? readCallToolsCampaignStatus(campaignId, requestOptions).catch((error) => ({
          readError: callToolsErrorMessage(error?.payload || null, error?.message),
        }))
      : Promise.resolve({ readError: 'CALLTOOLS_CAMPAIGN_ID' }),
    includeSeatClaimProof && appUserId && campaignId
      ? listCallToolsLiveCalls(binding, requestOptions).catch((error) => ({
          readError: callToolsErrorMessage(error?.payload || null, error?.message),
        }))
      : Promise.resolve(null),
  ])
  const agentReadError = safeLeadText(agentStatus?.readError) ||
    (!agentStatus?.appUser
      ? 'CALLTOOLS_AGENT_STATUS_IDENTITY_MISSING'
      : agentStatus.appUser !== appUserId
        ? 'CALLTOOLS_AGENT_STATUS_IDENTITY_MISMATCH'
        : '')
  const campaignReadError = safeLeadText(campaignStatus?.readError) ||
    (!campaignStatus?.campaignId
      ? 'CALLTOOLS_CAMPAIGN_STATUS_IDENTITY_MISSING'
      : campaignStatus.campaignId !== campaignId
        ? 'CALLTOOLS_CAMPAIGN_STATUS_IDENTITY_MISMATCH'
        : '')
  const campaignAgentReadError = !includeSeatClaimProof
    ? ''
    : safeLeadText(campaignAgentStatus?.readError) ||
    (!campaignAgentStatus?.appUser
      ? 'CALLTOOLS_CAMPAIGN_AGENT_IDENTITY_MISSING'
      : campaignAgentStatus.appUser !== appUserId
        ? 'CALLTOOLS_CAMPAIGN_AGENT_IDENTITY_MISMATCH'
        : !campaignAgentStatus?.campaignId
          ? 'CALLTOOLS_CAMPAIGN_AGENT_CAMPAIGN_MISSING'
          : campaignAgentStatus.campaignId !== campaignId
            ? 'CALLTOOLS_CAMPAIGN_AGENT_CAMPAIGN_MISMATCH'
            : '')
  const liveCallsReadError = !includeSeatClaimProof
    ? ''
    : Array.isArray(liveCallsResult)
    ? ''
    : safeLeadText(liveCallsResult?.readError) || 'CALLTOOLS_LIVE_CALLS_READ_FAILED'
  const agentReady =
    agentReadError || typeof agentStatus?.ready !== 'boolean'
      ? null
      : agentStatus.ready
  const agentLoggedIn =
    agentReadError || typeof agentStatus?.loggedIn !== 'boolean'
      ? null
      : agentStatus.loggedIn
  const agentLiveCallsCount =
    agentReadError || !Number.isFinite(agentStatus?.liveCallsCount)
      ? null
      : agentStatus.liveCallsCount
  const campaignAgentReady =
    !includeSeatClaimProof || campaignAgentReadError || typeof campaignAgentStatus?.ready !== 'boolean'
      ? null
      : campaignAgentStatus.ready
  const liveCallsCount =
    !includeSeatClaimProof || liveCallsReadError ? null : liveCallsResult.length
  const humanSeatActive = Boolean(
    agentReady === true ||
      campaignAgentReady === true ||
      Number(agentLiveCallsCount || 0) > 0 ||
      Number(liveCallsCount || 0) > 0
  )
  const seatClaimSafe = Boolean(
    includeSeatClaimProof &&
    !agentReadError &&
      !campaignAgentReadError &&
      !liveCallsReadError &&
      agentReady === false &&
      campaignAgentReady === false &&
      agentLiveCallsCount === 0 &&
      liveCallsCount === 0
  )

  return {
    schemaVersion: 'speak.calltools-duty-status.v1',
    seatClaimProofRead: Boolean(includeSeatClaimProof),
    binding: {
      appUserId,
      campaignId,
    },
    agentReady,
    agentLoggedIn,
    agentLiveCallsCount,
    campaignAgentReady,
    liveCallsCount,
    humanSeatActive,
    seatClaimSafe,
    campaignActive:
      campaignReadError || typeof campaignStatus?.active !== 'boolean'
        ? null
        : campaignStatus.active,
    originateCalls:
      campaignReadError || typeof campaignStatus?.originateCalls !== 'boolean'
        ? null
        : campaignStatus.originateCalls,
    agentReadError,
    campaignAgentReadError,
    campaignReadError,
    liveCallsReadError,
  }
}

export async function ensureCallToolsCampaignStarted({
  binding = {},
  campaignId,
  apply = false,
} = {}) {
  const requestOptions = callToolsReadinessRequestOptions()
  const targetCampaignId = safeLeadText(campaignId || binding.campaignId)
  const patch = { active: true, originate_calls: true }
  const before = targetCampaignId
    ? await readCallToolsCampaign(targetCampaignId, requestOptions).catch((error) => ({
        id: targetCampaignId,
        readError: callToolsErrorMessage(error?.payload || null, error?.message),
      }))
    : null
  let patched = null
  let patchError = ''
  const shouldPatch = Boolean(
    targetCampaignId &&
      !before?.readError &&
      (before?.active !== true || before?.originateCalls !== true),
  )
  if (apply && shouldPatch) {
    try {
      patched = await callToolsRequest(
        `/campaigns/${encodeURIComponent(targetCampaignId)}/`,
        {
          method: 'PATCH',
          body: patch,
          timeoutMs: requestOptions.agentSessionPatchTimeoutMs,
        },
      )
    } catch (error) {
      patchError = callToolsErrorMessage(error?.payload || null, error?.message)
    }
  }
  const campaignStatus = targetCampaignId
    ? await readCallToolsCampaignStatus(targetCampaignId, requestOptions).catch((error) => ({
        campaignId: targetCampaignId,
        readError: callToolsErrorMessage(error?.payload || null, error?.message),
      }))
    : null
  const patchedCampaign = patched ? publicCampaign(patched) : null
  const active =
    typeof campaignStatus?.active === 'boolean'
      ? campaignStatus.active
      : patchedCampaign?.active ?? before?.active ?? null
  const originateCalls =
    typeof campaignStatus?.originateCalls === 'boolean'
      ? campaignStatus.originateCalls
      : patchedCampaign?.originateCalls ?? before?.originateCalls ?? null
  const ok = Boolean(targetCampaignId && active === true && originateCalls === true)
  const blockers = ok
    ? []
    : [
        !targetCampaignId ? 'CALLTOOLS_CAMPAIGN_ID' : '',
        before?.readError ? 'CALLTOOLS_CAMPAIGN_READ_FAILED' : '',
        patchError ? 'CALLTOOLS_CAMPAIGN_START_PATCH_FAILED' : '',
        active === false ? 'CALLTOOLS_CAMPAIGN_INACTIVE' : '',
        originateCalls === false ? 'CALLTOOLS_CAMPAIGN_ORIGINATION_DISABLED' : '',
        campaignStatus?.readError ? 'CALLTOOLS_CAMPAIGN_STATUS_READ_FAILED' : '',
      ].filter(Boolean)
  return {
    provider: 'calltools',
    schemaVersion: 'speak.calltools-campaign-start.v1',
    applyRequested: Boolean(apply),
    mutationPerformed: Boolean(patched),
    mutationEndpoint: '/campaigns/{campaign_id}/',
    ok,
    status: ok ? 'running' : apply ? 'blocked' : 'planned',
    blockers,
    campaignId: targetCampaignId,
    patch,
    patchError,
    before: before?.readError ? { id: targetCampaignId, readError: before.readError } : before,
    after: {
      active,
      originateCalls,
      readError: campaignStatus?.readError || '',
    },
  }
}

export async function ensureCallToolsAgentSessionReadiness({
  binding = {},
  appUserId,
  campaignId,
  agentStatusId,
  webPhoneStatus = 'Registered',
  ready = true,
  apply = false,
  requireCampaignReady = false,
} = {}) {
  const requestOptions = callToolsReadinessRequestOptions()
  const targetAppUserId = safeLeadText(appUserId || binding.appUserId || binding.userId)
  const targetCampaignId = safeLeadText(campaignId || binding.campaignId)
  const targetReady = ready !== false
  const blockers = []
  if (!targetAppUserId) blockers.push('CALLTOOLS_AGENT_USER_ID')
  if (requireCampaignReady && !targetCampaignId) blockers.push('CALLTOOLS_CAMPAIGN_ID')
  const campaignStart = targetReady && requireCampaignReady
    ? await ensureCallToolsCampaignStarted({
        campaignId: targetCampaignId,
        apply,
      })
    : null
  if (campaignStart && !campaignStart.ok) blockers.push(...campaignStart.blockers)

  const before = targetAppUserId
    ? await readCallToolsAgentStatus(targetAppUserId, requestOptions).catch((error) => ({
        appUser: targetAppUserId,
        readError: callToolsErrorMessage(error?.payload || null, error?.message),
      }))
    : null
  const readyStatus = targetReady
    ? await selectCallToolsReadyStatus(agentStatusId, requestOptions).catch(() => null)
    : await selectCallToolsNotReadyStatus(agentStatusId, requestOptions).catch(() => null)
  // Enabling follows a freshly confirmed SIP registration, so refresh the
  // native timestamp even when CallTools still reports an older Registered
  // value. Keeping the stale timestamp can leave ready=true but logged_in=false.
  const registeredAt = targetReady
    ? new Date().toISOString()
    : callToolsWebPhoneRegistered(before?.webPhoneStatus) && before?.webPhoneRegisteredOn
      ? before.webPhoneRegisteredOn
      : new Date().toISOString()
  const patch = cleanObject({
    agent_status: integerOrEmpty(readyStatus?.id || agentStatusId),
    // CallTools clears the selected campaign when AgentStatus is patched
    // without this field. Preserve the frozen duty binding across both
    // Available and Not Available transitions.
    campaign: integerOrEmpty(targetCampaignId || before?.campaignId),
    ready: targetReady,
    web_phone_status: safeLeadText(webPhoneStatus) || 'Registered',
    web_phone_registered_on: registeredAt,
  })
  const minimalPatch = cleanObject({
    agent_status: patch.agent_status,
    campaign: patch.campaign,
    ready: patch.ready,
    web_phone_status: patch.web_phone_status,
  })
  const patchAttempts = uniqueCallToolsPatchAttempts([
    { name: 'agent_session', body: patch },
    { name: 'agent_status_only', body: minimalPatch },
  ])

  let patched = null
  let patchError = ''
  const patchAttemptErrors = []
  if (!blockers.length && apply) {
    for (const attempt of patchAttempts) {
      try {
        patched = await callToolsRequest(`/agentstatuses/${encodeURIComponent(targetAppUserId)}/`, {
          method: 'PATCH',
          body: attempt.body,
          timeoutMs: requestOptions.agentSessionPatchTimeoutMs,
        })
        patchError = ''
        break
      } catch (error) {
        const message = callToolsErrorMessage(error?.payload || null, error?.message)
        patchError = message
        patchAttemptErrors.push(`${attempt.name}: ${message}`)
      }
    }
  }

  let after = targetAppUserId
    ? await readCallToolsAgentStatus(targetAppUserId, requestOptions).catch((error) => ({
        appUser: targetAppUserId,
        readError: callToolsErrorMessage(error?.payload || null, error?.message),
      }))
    : null
  let campaignAgentStatus = targetAppUserId
    ? await readCallToolsCampaignAgentStatus(targetAppUserId, requestOptions).catch((error) => ({
        appUser: targetAppUserId,
        readError: callToolsErrorMessage(error?.payload || null, error?.message),
      }))
    : null
  let campaignStatus = targetCampaignId
    ? await readCallToolsCampaignStatus(targetCampaignId, requestOptions).catch((error) => ({
        campaignId: targetCampaignId,
        readError: callToolsErrorMessage(error?.payload || null, error?.message),
      }))
    : null
  let campaignAgentPatched = null
  let campaignAgentPatchError = ''
  const campaignAgentPatch = cleanObject({
    campaign: integerOrEmpty(targetCampaignId),
    ready: targetReady,
  })
  const campaignAgentNeedsPatch = Boolean(
    apply &&
      targetAppUserId &&
      targetCampaignId &&
      !patchError &&
      (targetReady ? after?.ready === true : true) &&
      (targetReady
        ? requireCampaignReady &&
          (
            campaignAgentStatus?.ready !== true ||
            safeLeadText(campaignAgentStatus?.campaignId) !== targetCampaignId
          )
        : campaignAgentStatus?.ready === true),
  )
  if (campaignAgentNeedsPatch) {
    try {
      campaignAgentPatched = await callToolsRequest(
        `/campaignagents/${encodeURIComponent(targetAppUserId)}/`,
        {
          method: 'PATCH',
          body: campaignAgentPatch,
          timeoutMs: requestOptions.agentSessionPatchTimeoutMs,
        },
      )
    } catch (error) {
      campaignAgentPatchError = callToolsErrorMessage(
        error?.payload || null,
        error?.message,
      )
    }
    const refreshedSessionProof = await Promise.all([
      readCallToolsAgentStatus(targetAppUserId, requestOptions).catch((error) => ({
        appUser: targetAppUserId,
        readError: callToolsErrorMessage(error?.payload || null, error?.message),
      })),
      readCallToolsCampaignAgentStatus(targetAppUserId, requestOptions).catch((error) => ({
        appUser: targetAppUserId,
        readError: callToolsErrorMessage(error?.payload || null, error?.message),
      })),
      readCallToolsCampaignStatus(targetCampaignId, requestOptions).catch((error) => ({
        campaignId: targetCampaignId,
        readError: callToolsErrorMessage(error?.payload || null, error?.message),
      })),
    ])
    after = refreshedSessionProof[0]
    campaignAgentStatus = refreshedSessionProof[1]
    campaignStatus = refreshedSessionProof[2]
  }
  const proof = callToolsAgentSessionProof({
    agentStatus: after,
    campaignAgentStatus,
    campaignStatus,
    campaignId: targetCampaignId,
  })
  const directSessionReady = Boolean(
    after?.appUser &&
      !after.readError &&
      after.ready &&
      callToolsWebPhoneRegistered(after.webPhoneStatus) &&
      after.webPhoneRegisteredOn,
  )
  const campaignSessionReady = Boolean(
    directSessionReady &&
      proof.loggedIn &&
      campaignStatus?.active === true &&
      campaignStatus?.originateCalls === true,
  )
  const sessionReady = requireCampaignReady ? campaignSessionReady : directSessionReady
  const sessionPaused = Boolean(
    after?.appUser &&
      !after.readError &&
      after.ready === false &&
      callToolsWebPhoneRegistered(after.webPhoneStatus) &&
      after.webPhoneRegisteredOn,
  )
  const ok = targetReady ? sessionReady : sessionPaused
  const ensureBlockers = ok
    ? []
    : targetReady
      ? [
          ...blockers,
          after?.readError ? 'CALLTOOLS_AGENT_STATUS_READ_FAILED' : '',
          patchError ? 'CALLTOOLS_AGENT_STATUS_PATCH_FAILED' : '',
          after && !after.readError && !after.ready ? 'CALLTOOLS_AGENT_NOT_READY' : '',
          requireCampaignReady && campaignAgentStatus?.readError
            ? 'CALLTOOLS_CAMPAIGN_AGENT_STATUS_READ_FAILED'
            : '',
          requireCampaignReady &&
          campaignAgentStatus &&
          !campaignAgentStatus.readError &&
          !proof.campaignAgentReady
            ? 'CALLTOOLS_CAMPAIGN_AGENT_NOT_READY'
            : '',
          requireCampaignReady && after && !after.readError && !proof.loggedIn
            ? 'CALLTOOLS_AGENT_NOT_LOGGED_IN'
            : '',
          requireCampaignReady && campaignStatus?.active === false
            ? 'CALLTOOLS_CAMPAIGN_INACTIVE'
            : '',
          requireCampaignReady && campaignStatus?.originateCalls === false
            ? 'CALLTOOLS_CAMPAIGN_ORIGINATION_DISABLED'
            : '',
          campaignAgentPatchError ? 'CALLTOOLS_CAMPAIGN_AGENT_STATUS_PATCH_FAILED' : '',
          after && !after.readError && !callToolsWebPhoneRegistered(after.webPhoneStatus)
            ? 'CALLTOOLS_AGENT_WEB_PHONE_NOT_REGISTERED'
            : '',
          after && !after.readError && callToolsWebPhoneRegistered(after.webPhoneStatus) && !after.webPhoneRegisteredOn
            ? 'CALLTOOLS_AGENT_WEB_PHONE_NATIVE_SESSION_MISSING'
            : '',
        ]
      : [
          ...blockers,
          after?.readError ? 'CALLTOOLS_AGENT_STATUS_READ_FAILED' : '',
          patchError ? 'CALLTOOLS_AGENT_STATUS_PATCH_FAILED' : '',
          after && !after.readError && after.ready ? 'CALLTOOLS_AGENT_STILL_READY' : '',
          after && !after.readError && !callToolsWebPhoneRegistered(after.webPhoneStatus)
            ? 'CALLTOOLS_AGENT_WEB_PHONE_NOT_REGISTERED'
            : '',
          after && !after.readError && callToolsWebPhoneRegistered(after.webPhoneStatus) && !after.webPhoneRegisteredOn
            ? 'CALLTOOLS_AGENT_WEB_PHONE_NATIVE_SESSION_MISSING'
            : '',
        ].filter(Boolean)
  const filteredEnsureBlockers = ensureBlockers.filter(Boolean)
  const ensureBlocked = apply || filteredEnsureBlockers.some((blocker) =>
    /_READ_FAILED$|_PATCH_FAILED$|_ID$/.test(blocker),
  )

  return {
    provider: 'calltools',
    schemaVersion: 'speak.calltools-agent-session-ensure.v1',
    ...CALLTOOLS_AGENT_SESSION_BACKEND_PROOF,
    targetReady,
    requireCampaignReady: Boolean(requireCampaignReady),
    readinessMode: requireCampaignReady ? 'campaign-follow' : 'agent-status',
    applyRequested: Boolean(apply),
    mutationPerformed: Boolean(
      campaignStart?.mutationPerformed || patched || campaignAgentPatched,
    ),
    timeouts: {
      readMs: requestOptions.timeoutMs,
      patchMs: requestOptions.agentSessionPatchTimeoutMs,
    },
    ok,
    status: ok ? (targetReady ? 'ready' : 'not-ready') : ensureBlocked ? 'blocked' : 'planned',
    blockers: filteredEnsureBlockers,
    binding: cleanObject({
      appUserId: targetAppUserId,
      campaignId: targetCampaignId,
    }),
    readyStatus: readyStatus
      ? {
          id: safeLeadText(readyStatus.id),
          name: safeLeadText(readyStatus.name),
          campaignAction: safeLeadText(readyStatus.campaign_action),
          queueAction: safeLeadText(readyStatus.queue_action),
        }
      : null,
    patch,
    campaignStart,
    campaignAgentMutationEndpoint: '/campaignagents/{app_user_id}/',
    campaignAgentPatch,
    campaignAgentPatchError,
    patchAttempts: patchAttempts.map((attempt) => ({
      name: attempt.name,
      body: attempt.body,
    })),
    before: publicCallToolsAgentStatus(before),
    after: publicCallToolsAgentStatus(after),
    campaignAgentStatus: publicCallToolsCampaignAgentStatus(campaignAgentStatus),
    campaignStatus: campaignStatus
      ? {
          campaignId: campaignStatus.campaignId,
          active: campaignStatus.active,
          originateCalls: campaignStatus.originateCalls,
          loggedInAgents: campaignStatus.loggedInAgents,
          waitingAgents: campaignStatus.waitingAgents,
          phoneCallAgents: campaignStatus.phoneCallAgents,
          postCallWrapUpAgents: campaignStatus.postCallWrapUpAgents,
          readError: campaignStatus.readError,
        }
      : null,
    proof,
    patchError: [
      patchAttemptErrors.length ? patchAttemptErrors.join('; ') : patchError,
      campaignAgentPatchError,
    ].filter(Boolean).join('; '),
    note: ok
      ? targetReady
        ? requireCampaignReady
          ? 'CallTools campaign, AgentStatus, campaign-agent session, and SIP registration are ready through backend API state and native proof.'
          : 'CallTools AgentStatus is ready through backend API state and webphone registration proof.'
        : 'CallTools AgentStatus is unavailable through backend API state for the human-seat handoff.'
      : targetReady
        ? requireCampaignReady
          ? 'CallTools campaign and agent-session readiness could not be established through backend API state alone.'
          : 'CallTools AgentStatus readiness could not be established through backend API state alone.'
        : 'CallTools AgentStatus could not be paused through backend API state alone.',
  }
}

function uniqueCallToolsPatchAttempts(attempts = []) {
  const seen = new Set()
  return attempts.filter((attempt) => {
    const body = cleanObject(attempt?.body || {})
    if (!Object.keys(body).length) return false
    const key = JSON.stringify(body)
    if (seen.has(key)) return false
    seen.add(key)
    attempt.body = body
    return true
  })
}

export async function resolveCallToolsLiveCallContext({
  calltoolsCallId,
  from,
  to,
  config = {},
} = {}) {
  const binding = normalizeCallToolsAgentBinding(config.calltoolsAgentBinding || {})
  const liveCall = await findCallToolsLiveCall({
    calltoolsCallId,
    from,
    to,
    binding,
  })
  const contactId = safeLeadText(liveCall?.contact)
  const contact = contactId ? await readCallToolsContact(contactId).catch(() => null) : null
  const runtimeSource = callToolsRuntimeSourceFields({ binding, liveCall })
  const lead = contact
    ? {
        ...callToolsContactToRuntimeLead(contact),
        ...runtimeSource,
      }
    : runtimeSource

  return {
    provider: 'calltools',
    liveCall: liveCall
      ? cleanObject({
          callUuid: safeLeadText(liveCall.call_uuid),
          contactId,
          campaignId: safeLeadText(liveCall.campaign),
          queueId: safeLeadText(liveCall.queue),
          webCallbackId: safeLeadText(liveCall.web_call_back || binding.webCallbackId),
          appUserId: safeLeadText(liveCall.app_user),
          source: normalizePhone(liveCall.source) || safeLeadText(liveCall.source),
          destination: normalizePhone(liveCall.destination) || safeLeadText(liveCall.destination),
          inbound: Boolean(liveCall.inbound),
          callType: safeLeadText(liveCall.call_type),
          callPath: safeLeadText(liveCall.call_path),
          startedAt: safeLeadText(liveCall.start),
          answeredAt: safeLeadText(liveCall.answered_on),
        })
      : null,
    contact: contact
      ? cleanObject({
          id: contactId,
          uuid: safeLeadText(contact.uuid),
          systemDisposition: safeLeadText(contact.system_disposition),
          doNotContact: Boolean(contact.do_not_contact || contact.all_phone_numbers_fdnc),
        })
      : null,
    lead,
    providerIds: cleanObject({
      calltoolsCallId: safeLeadText(liveCall?.call_uuid || calltoolsCallId),
      calltoolsContactId: contactId,
      calltoolsCampaignId: safeLeadText(liveCall?.campaign || binding.campaignId),
      calltoolsWebCallbackId: safeLeadText(liveCall?.web_call_back || binding.webCallbackId),
      calltoolsPhoneId: safeLeadText(binding.phoneId),
      calltoolsQueueId: safeLeadText(liveCall?.queue || binding.queueId),
      calltoolsAppUserId: safeLeadText(liveCall?.app_user || binding.appUserId || binding.userId),
    }),
  }
}

export async function readCallToolsHistoricalCall({
  calltoolsCallId,
  contactId,
  to,
  startedAt,
  startToleranceMs,
  timeoutMs,
  config = {},
} = {}) {
  const binding = normalizeCallToolsAgentBinding(config.calltoolsAgentBinding || {})
  const callId = safeLeadText(calltoolsCallId)
  const destination = normalizePhone(to)
  const appUserId = safeLeadText(binding.appUserId || binding.userId)
  const maxStartDeltaMs = callToolsHistoricalCallStartToleranceMs(startToleranceMs)
  const dateCandidates = providerDateCandidates(startedAt)
  const totalTimeoutMs = positiveMilliseconds(timeoutMs, 0)
  const deadlineAt = totalTimeoutMs ? Date.now() + totalTimeoutMs : 0
  if (/^\d+$/.test(callId)) {
    const requestOptions = callToolsHistoricalRequestOptions(deadlineAt)
    if (!requestOptions) return null
    const direct = await readCallToolsCallById(callId, requestOptions)
    if (direct && callToolsHistoricalCallIsCurrent(direct, {
      startedAt,
      maxStartDeltaMs,
      destination,
      contactId,
      allowExactId: false,
      callId,
    })) {
      return normalizeCallToolsHistoricalCall(direct)
    }
  }

  const queries = []
  if (callId) {
    queries.push({
      query: { uuid: callId, page_size: 5 },
      allowNewestFallback: false,
    })
  }
  if (destination && appUserId) {
    for (const date of dateCandidates) {
      queries.push({
        query: cleanObject({
          destination,
          app_user_id: appUserId,
          start__date: date,
          ordering: '-start',
          page_size: 20,
        }),
        allowNewestFallback: true,
        match: { destination, startedAt },
      })
    }
    queries.push({
      query: cleanObject({
        destination,
        app_user_id: appUserId,
        ordering: '-start',
        page_size: 50,
      }),
      allowNewestFallback: true,
      match: { destination, startedAt },
    })
  }
  const fallbackQuery = cleanObject({
    contact_id: integerOrEmpty(contactId),
    app_user_id: appUserId,
    campaign_id: integerOrEmpty(binding.campaignId),
    queue_id:
      binding.webCallbackId || binding.campaignId ? '' : integerOrEmpty(binding.queueId),
    web_call_back_id: integerOrEmpty(binding.webCallbackId),
    ordering: '-start',
    page_size: 10,
  })
  const hasFallbackFilter = [
    'contact_id',
    'app_user_id',
    'campaign_id',
    'queue_id',
    'web_call_back_id',
  ].some((key) => safeLeadText(fallbackQuery[key]))
  if (hasFallbackFilter) {
    for (const date of dateCandidates) {
      queries.push({
        query: cleanObject({
          ...fallbackQuery,
          start__date: date,
        }),
        allowNewestFallback: true,
      })
    }
    queries.push({
      query: fallbackQuery,
      allowNewestFallback: true,
    })
  }
  if (appUserId) {
    queries.push({
      query: cleanObject({
        app_user_id: appUserId,
        ordering: '-start',
        page_size: 50,
      }),
      allowNewestFallback: true,
    })
  }

  for (const { query, allowNewestFallback, match: matchOptions = {} } of queries) {
    if (!Object.keys(query).length) continue
    const requestOptions = callToolsHistoricalRequestOptions(deadlineAt)
    if (!requestOptions) break
    const payload = await callToolsRequest('/calls/', {
      query,
      timeoutMs: requestOptions.timeoutMs,
    }).catch(() => null)
    if (!payload) continue
    const results = collectionResults(payload)
    const exactIdMatch = results.find((call) =>
      callToolsHistoricalCallIdMatches(call, { callId }),
    )
    const match =
      exactIdMatch ||
      (allowNewestFallback
        ? nearestCallToolsHistoricalCall(
            callToolsHistoricalCandidatePool(results, {
              contactId,
              destination: matchOptions.destination || destination,
            }),
            matchOptions.startedAt || startedAt,
            { maxStartDeltaMs },
          )
        : null)
    if (
      match &&
      callToolsHistoricalCallIsCurrent(match, {
        startedAt: matchOptions.startedAt || startedAt,
        maxStartDeltaMs,
        destination: matchOptions.destination || destination,
        contactId,
        allowExactId: Boolean(exactIdMatch),
        callId,
      })
    ) {
      return normalizeCallToolsHistoricalCall(match)
    }
  }

  return null
}

function callToolsHistoricalRequestOptions(deadlineAt = 0) {
  if (!deadlineAt) return {}
  const remainingMs = Math.floor(deadlineAt - Date.now())
  if (remainingMs < 1_000) return null
  return { timeoutMs: remainingMs }
}

export async function reconcileCallToolsCallOutcome({
  outcome,
  config = {},
  calltoolsContext = null,
  lead = {},
  apply = false,
  confirm = false,
} = {}) {
  const normalizedOutcome = safeLeadText(outcome || 'operator-ended') || 'operator-ended'
  const binding = normalizeCallToolsAgentBinding(config.calltoolsAgentBinding || {})
  const providerIds = cleanObject({
    ...(lead.providerIds || {}),
    ...(calltoolsContext?.providerIds || {}),
  })
  const dispositions = await listCallToolsDispositions()
  const disposition = selectCallToolsDisposition(normalizedOutcome, dispositions)
  const payload = callToolsHistoricalDispositionPayload({
    disposition,
    binding,
    providerIds,
    lead,
    calltoolsContext,
  })
  const blockers = []
  if (!disposition?.id) blockers.push('CALLTOOLS_DISPOSITION_NOT_FOUND')
  if (!payload.call_uuid && !payload.contact) {
    blockers.push('CALLTOOLS_CALL_OR_CONTACT_ID_REQUIRED')
  }
  const allowedToMutate = Boolean(apply && confirm && blockers.length === 0)
  const created = allowedToMutate
    ? await callToolsRequest('/historicalcalldispositions/', {
        method: 'POST',
        body: payload,
      })
    : null

  return {
    provider: 'calltools',
    applyRequested: Boolean(apply),
    confirmRequired: true,
    confirmed: Boolean(confirm),
    mutationPerformed: Boolean(created),
    action: created ? 'created' : blockers.length ? 'blocked' : 'planned',
    outcome: normalizedOutcome,
    disposition: disposition
      ? {
          id: safeLeadText(disposition.id),
          name: safeLeadText(disposition.name),
          indicateAnsweringMachine: Boolean(disposition.indicate_answering_machine),
          setContactDnc: Boolean(disposition.set_contact_dnc),
          setPhoneNumberDnc: Boolean(disposition.set_phone_number_dnc),
          noContact: Boolean(disposition.no_contact),
        }
      : null,
    payload,
    blockers,
    record: created,
  }
}

export function callToolsOutcomeAutoSyncEnabled() {
  return boolEnv('CALLTOOLS_SYNC_OUTCOMES', false)
}

async function listCallToolsCollection(path, options = {}) {
  const payload = await callToolsRequest(`/${path}/`, {
    query: { page_size: DEFAULT_PAGE_SIZE },
    timeoutMs: options.timeoutMs,
  })
  return Array.isArray(payload?.results)
    ? payload.results
    : Array.isArray(payload?.data?.results)
      ? payload.data.results
      : Array.isArray(payload)
        ? payload
        : []
}

async function safeListCallToolsCollection(path, { fallbackItems = [], timeoutMs } = {}) {
  try {
    return {
      items: await listCallToolsCollection(path, { timeoutMs }),
      readError: '',
    }
  } catch (error) {
    return {
      items: fallbackItems,
      readError: callToolsErrorMessage(error?.payload || null, error?.message),
    }
  }
}

async function listCallToolsDispositions(options = {}) {
  const payload = await callToolsRequest('/calldispositions/', {
    query: { page_size: DEFAULT_PAGE_SIZE, ordering: 'custom_ordering' },
    timeoutMs: options.timeoutMs,
  })
  return collectionResults(payload)
}

async function listCallToolsStatuses(options = {}) {
  const payload = await callToolsRequest('/statuses/', {
    query: { page_size: DEFAULT_PAGE_SIZE, ordering: 'name' },
    timeoutMs: options.timeoutMs,
  })
  return collectionResults(payload)
}

async function selectCallToolsReadyStatus(statusId, options = {}) {
  const statuses = await listCallToolsStatuses(options)
  const requested = safeLeadText(statusId)
  if (requested) {
    const match = statuses.find((status) => safeLeadText(status.id) === requested)
    if (match) return match
  }
  return (
    statuses.find((status) =>
      /^set ready$/i.test(safeLeadText(status.campaign_action)) &&
        status.agent_can_select !== false,
    ) ||
    statuses.find((status) => /\bavailable\b|\bready\b/i.test(safeLeadText(status.name))) ||
    null
  )
}

async function selectCallToolsNotReadyStatus(statusId, options = {}) {
  const statuses = await listCallToolsStatuses(options)
  const requested = safeLeadText(statusId)
  if (requested) {
    const match = statuses.find((status) => safeLeadText(status.id) === requested)
    if (match) return match
  }
  return (
    statuses.find((status) =>
      /^set not ready$/i.test(safeLeadText(status.campaign_action)) &&
        status.agent_can_select !== false &&
        /\bnot available\b/i.test(safeLeadText(status.name)),
    ) ||
    statuses.find((status) =>
      /^set not ready$/i.test(safeLeadText(status.campaign_action)) &&
        status.agent_can_select !== false,
    ) ||
    null
  )
}

async function listCallToolsLiveCalls(binding = {}, options = {}) {
  const payload = await callToolsRequest('/livephonecalls/', {
    query: cleanObject({
      page_size: 25,
      ordering: '-start',
      app_user_id: binding.appUserId || binding.userId,
      campaign_id: binding.webCallbackId ? '' : binding.campaignId,
      web_call_back_id: binding.webCallbackId,
      queue_id: binding.webCallbackId || binding.campaignId ? '' : binding.queueId,
    }),
    timeoutMs: options.timeoutMs,
  })
  return collectionResults(payload)
}

async function readCallToolsAgentStatus(appUserId, options = {}) {
  const id = safeLeadText(appUserId)
  if (!id) return null
  const payload = await callToolsRequest(`/agentstatuses/${encodeURIComponent(id)}/`, {
    timeoutMs: options.timeoutMs,
  })
  return {
    appUser: safeLeadText(payload.app_user),
    fullName: safeLeadText(payload.full_name),
    ready: typeof payload.ready === 'boolean' ? payload.ready : null,
    loggedIn: typeof payload.logged_in === 'boolean' ? payload.logged_in : null,
    readySince: safeLeadText(payload.ready_since),
    loggedInSince: safeLeadText(payload.logged_in_since),
    campaignId: safeLeadText(payload.campaign),
    campaignName: safeLeadText(payload.campaign_name),
    webPhoneStatus: safeLeadText(payload.web_phone_status),
    webPhoneRegisteredOn: safeLeadText(payload.web_phone_registered_on),
    psEndpointId: safeLeadText(payload.ps_endpoint_id),
    liveCallsCount: finiteCallToolsCount(payload.live_calls_count),
    liveCampaignCallsCount: finiteCallToolsCount(payload.live_campaign_calls_count),
    liveInboundCallsCount: finiteCallToolsCount(payload.live_inbound_calls_count),
    liveQueueCallsCount: finiteCallToolsCount(payload.live_queue_calls_count),
  }
}

async function readCallToolsCampaignAgentStatus(appUserId, options = {}) {
  const id = safeLeadText(appUserId)
  if (!id) return null
  const payload = await callToolsRequest(`/campaignagents/${encodeURIComponent(id)}/`, {
    timeoutMs: options.timeoutMs,
  })
  return publicCallToolsCampaignAgentStatus(payload)
}

async function readCallToolsCampaign(campaignId, options = {}) {
  const id = safeLeadText(campaignId)
  if (!id) return null
  const payload = await callToolsRequest(`/campaigns/${encodeURIComponent(id)}/`, {
    timeoutMs: options.timeoutMs,
  })
  return publicCampaign(payload)
}

async function readCallToolsCampaignStatus(campaignId, options = {}) {
  const id = safeLeadText(campaignId)
  if (!id) return null
  const payload = await callToolsRequest(`/campaignstatuses/${encodeURIComponent(id)}/`, {
    timeoutMs: options.timeoutMs,
  })
  return {
    campaignId: safeLeadText(payload.campaign || payload.id),
    name: safeLeadText(payload.name),
    active: typeof payload.active === 'boolean' ? payload.active : null,
    originateCalls:
      typeof payload.originate_calls === 'boolean' ? payload.originate_calls : null,
    autoPilot: Boolean(payload.auto_pilot),
    channelsPerAgent: Number(payload.channels_per_agent || 0),
    loggedInAgents: Number(payload.logged_in_agents || 0),
    waitingAgents: Number(payload.waiting_agents || 0),
    phoneCallAgents: Number(payload.phone_call_agents || 0),
    postCallWrapUpAgents: Number(payload.post_call_wrap_up_agents || 0),
    totalContactCount: Number(payload.total_contact_count || 0),
    warningMessage: safeLeadText(payload.warning_message),
  }
}

function callToolsDispositionCoverage(dispositions = []) {
  return [
    'completed',
    'not-interested',
    'callback',
    'wrong-number',
    'do-not-call',
    'no-answer',
    'operator-ended',
  ].map((outcome) => {
    const disposition = selectCallToolsDisposition(outcome, dispositions)
    return {
      outcome,
      required: true,
      dispositionId: safeLeadText(disposition?.id),
      dispositionName: safeLeadText(disposition?.name),
    }
  })
}

function selectCallToolsDisposition(outcome, dispositions = []) {
  const matchers =
    CALLTOOLS_OUTCOME_DISPOSITION_MATCHERS[outcome] ||
    CALLTOOLS_OUTCOME_DISPOSITION_MATCHERS['operator-ended']
  return (
    matchers
      .map((matcher) =>
        dispositions.find((item) => matcher.test(safeLeadText(item.name))),
      )
      .find(Boolean) || null
  )
}

function callToolsHistoricalDispositionPayload({
  disposition,
  binding = {},
  providerIds = {},
  lead = {},
  calltoolsContext = null,
} = {}) {
  return cleanObject({
    call_uuid: uuidOrEmpty(providerIds.calltoolsCallId),
    contact: integerOrEmpty(providerIds.calltoolsContactId),
    app_user: safeLeadText(providerIds.calltoolsAppUserId || binding.appUserId || binding.userId),
    queue: integerOrEmpty(providerIds.calltoolsQueueId || binding.queueId),
    campaign: integerOrEmpty(providerIds.calltoolsCampaignId || binding.campaignId),
    live_filter: integerOrEmpty(binding.liveFilterId),
    phone_number:
      normalizePhone(
        lead.phone ||
          calltoolsContext?.liveCall?.source ||
          calltoolsContext?.liveCall?.destination,
      ) || undefined,
    disposition: integerOrEmpty(disposition?.id),
  })
}

function uuidOrEmpty(value) {
  const text = safeLeadText(value)
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)
    ? text
    : ''
}

function integerOrEmpty(value) {
  const text = safeLeadText(value)
  if (!/^\d+$/.test(text)) return undefined
  return Number(text)
}

function readinessCheck({ id, label, ready = false, blockers = [], warnings = [], proof = {} }) {
  const cleanBlockers = blockers.filter(Boolean)
  return {
    id,
    label,
    status: ready && cleanBlockers.length === 0 ? 'ready' : 'blocked',
    blockers: cleanBlockers,
    warnings: warnings.filter(Boolean),
    proof: cleanObject(proof),
  }
}

function callToolsWebPhoneRegistered(status) {
  return /^registered$/i.test(safeLeadText(status))
}

function callToolsAgentSessionProof({
  agentStatus = {},
  campaignAgentStatus = {},
  campaignStatus = {},
  campaignId = '',
} = {}) {
  const selectedCampaignId = safeLeadText(campaignId)
  const agentCampaignId = safeLeadText(agentStatus?.campaignId)
  const campaignAgentCampaignId = safeLeadText(campaignAgentStatus?.campaignId)
  const campaignIdMatches = Boolean(
    selectedCampaignId &&
      agentCampaignId &&
      selectedCampaignId === agentCampaignId,
  )
  const campaignAgentCampaignIdMatches = Boolean(
    selectedCampaignId &&
      campaignAgentCampaignId &&
      selectedCampaignId === campaignAgentCampaignId,
  )
  const campaignAgentReady = Boolean(
    campaignAgentStatus?.appUser &&
      !campaignAgentStatus.readError &&
      campaignAgentStatus.ready &&
      campaignAgentCampaignIdMatches,
  )
  const campaignLoggedInAgents = Number(campaignStatus?.loggedInAgents || 0)
  const campaignWaitingAgents = Number(campaignStatus?.waitingAgents || 0)
  const campaignPhoneCallAgents = Number(campaignStatus?.phoneCallAgents || 0)
  const campaignPostCallWrapUpAgents = Number(campaignStatus?.postCallWrapUpAgents || 0)
  const campaignLoginProof = Boolean(
    campaignIdMatches &&
      campaignAgentReady &&
      (
        campaignLoggedInAgents > 0 ||
        campaignWaitingAgents > 0 ||
        campaignPhoneCallAgents > 0 ||
        campaignPostCallWrapUpAgents > 0
      ),
  )
  const nativeLoggedIn = Boolean(agentStatus?.loggedIn)
  const loggedIn = Boolean(campaignIdMatches && campaignAgentReady && (nativeLoggedIn || campaignLoginProof))
  return {
    loggedIn,
    nativeLoggedIn,
    campaignLoginProof: campaignLoginProof ? 'campaign_status_agent_counts' : '',
    campaignIdMatches,
    campaignAgentProof: campaignAgentReady ? 'campaignagents_app_user_ready' : '',
    campaignAgentReady,
    campaignAgentCampaignIdMatches,
    campaignLoggedInAgents,
    campaignWaitingAgents,
    campaignPhoneCallAgents,
    campaignPostCallWrapUpAgents,
  }
}

function publicCallToolsAgentStatus(status = {}) {
  if (!status) return null
  return cleanObject({
    appUserId: status.appUser,
    name: status.fullName,
    ready: status.ready,
    loggedIn: status.loggedIn,
    readySince: status.readySince,
    loggedInSince: status.loggedInSince,
    campaignId: status.campaignId,
    campaignName: status.campaignName,
    webPhoneStatus: status.webPhoneStatus,
    webPhoneRegisteredOn: status.webPhoneRegisteredOn,
    psEndpointId: status.psEndpointId,
    liveCallsCount: status.liveCallsCount,
    readError: status.readError,
  })
}

function publicCallToolsCampaignAgentStatus(status = {}) {
  if (!status) return null
  return cleanObject({
    appUser: safeLeadText(status.appUser || status.app_user),
    name: safeLeadText(status.fullName || status.full_name),
    agentStatusId: safeLeadText(status.agentStatusId || status.agent_status),
    campaignId: safeLeadText(status.campaignId || status.campaign),
    priority: Number(status.priority || 0),
    ready:
      typeof (status.ready ?? status.is_ready) === 'boolean'
        ? status.ready ?? status.is_ready
        : null,
    readySince: safeLeadText(status.readySince || status.ready_since),
    lastCallOn: safeLeadText(status.lastCallOn || status.last_call_on),
    readError: status.readError,
  })
}

function finiteCallToolsCount(value) {
  if (value === '' || value === null || value === undefined) return null
  const count = Number(value)
  return Number.isFinite(count) && count >= 0 ? count : null
}

function publicLiveCall(liveCall = {}) {
  return cleanObject({
    callUuid: safeLeadText(liveCall.call_uuid),
    contactId: safeLeadText(liveCall.contact),
    campaignId: safeLeadText(liveCall.campaign),
    queueId: safeLeadText(liveCall.queue),
    webCallbackId: safeLeadText(liveCall.web_call_back),
    appUserId: safeLeadText(liveCall.app_user),
    source: normalizePhone(liveCall.source) || safeLeadText(liveCall.source),
    destination: normalizePhone(liveCall.destination) || safeLeadText(liveCall.destination),
    callType: safeLeadText(liveCall.call_type),
    callPath: safeLeadText(liveCall.call_path),
    startedAt: safeLeadText(liveCall.start),
    answeredAt: safeLeadText(liveCall.answered_on),
  })
}

function callToolsReadinessNextAction(blockers = []) {
  if (blockers.some((blocker) => /_READ_FAILED$/.test(blocker))) {
    return 'Retry CallTools readiness after the API object reads respond; if this persists, verify the CallTools API account, silo, and object permissions.'
  }
  if (blockers.includes('CALLTOOLS_AGENT_WEB_PHONE_NOT_REGISTERED')) {
    return 'Register the CallTools web phone/SIP endpoint for the bound agent before live campaign routing.'
  }
  if (blockers.includes('CALLTOOLS_AGENT_WEB_PHONE_NATIVE_SESSION_MISSING')) {
    return 'Repair the bound CallTools AgentStatus webPhoneRegisteredOn proof through the backend readiness helper; raw SIP registration is not enough for native campaign routing.'
  }
  if (blockers.includes('CALLTOOLS_CAMPAIGN_INACTIVE')) {
    return 'Select Go available to activate and originate the bound CallTools campaign and establish the selected Speak agent session.'
  }
  if (blockers.includes('CALLTOOLS_CAMPAIGN_AGENT_NOT_READY')) {
    return 'Repair the bound CallTools campaign-agent readiness for the selected campaign.'
  }
  if (blockers.includes('CALLTOOLS_AGENT_NOT_LOGGED_IN')) {
    return 'Repair backend CallTools per-agent campaign proof and aggregate agent proof for the selected campaign.'
  }
  if (blockers.includes('CALLTOOLS_AGENT_NOT_READY')) {
    return 'Set the bound CallTools agent ready on the selected campaign.'
  }
  if (blockers.includes('CALLTOOLS_MEDIA_GATEWAY_NOT_REGISTERED')) {
    return 'Start or repair the Speak CallTools media gateway for this profile before live calls.'
  }
  if (blockers.includes('CALLTOOLS_WEB_CALLBACK_ID')) {
    return 'Optional Web Call Back metadata is unconfigured; Speak live starts use the registered gateway.'
  }
  if (blockers.includes('CALLTOOLS_WEB_CALLBACK_NOT_FOUND')) {
    return 'Refresh CallTools options and select an existing Web Call Back route.'
  }
  if (blockers.includes('CALLTOOLS_WEB_CALLBACK_INACTIVE')) {
    return 'Activate the selected CallTools Web Call Back route only if using the legacy contact-first callback helper; Speak live starts use the registered gateway.'
  }
  if (blockers.includes('CALLTOOLS_LIVE_FILTER_EMPTY')) {
    return 'Load contacts into the selected CallTools campaign/live filter, then sync the CallTools source in Library.'
  }
  if (blockers.includes('CALLTOOLS_BUCKET_EMPTY')) {
    return 'Load contacts into the selected CallTools campaign bucket, then sync the CallTools source in Library.'
  }
  if (blockers.includes('CALLTOOLS_CAMPAIGN_NO_SELECTABLE_CONTACTS')) {
    return 'Review CallTools campaign filters, dedupe, suppression, and calling-hour rules until the campaign reports selectable contacts.'
  }
  if (blockers.includes('CALLTOOLS_LIVE_FILTER_INACTIVE')) {
    return 'Activate or update the selected CallTools live filter after contacts are loaded.'
  }
  if (blockers.includes('CALLTOOLS_AGENT_USER_ID') || blockers.includes('CALLTOOLS_PHONE_ID')) {
    return 'Bind the Speak profile to a CallTools agent user and WebRTC phone.'
  }
  return 'Resolve the blocked CallTools readiness checks before starting a live campaign.'
}

async function readCallToolsContact(contactId, options = {}) {
  const id = safeLeadText(contactId)
  if (!id) return null
  try {
    return await callToolsRequest(`/contacts/${encodeURIComponent(id)}/`, {
      timeoutMs: options.timeoutMs,
    })
  } catch (error) {
    if (error?.status === 404) return null
    throw error
  }
}

async function findCallToolsLiveCall({ calltoolsCallId, from, to, binding = {} } = {}) {
  const callId = safeLeadText(calltoolsCallId)
  if (callId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(callId)) {
    const direct = await readCallToolsLiveCall(callId)
    if (direct) return direct
  }

  const phoneCandidates = [
    normalizePhone(from),
    normalizePhone(to),
  ].filter(Boolean)
  const baseQuery = cleanObject({
    page_size: 25,
    ordering: '-start',
    app_user_id: binding.appUserId || binding.userId,
    campaign_id: binding.webCallbackId ? '' : binding.campaignId,
    web_call_back_id: binding.webCallbackId,
    queue_id: binding.webCallbackId || binding.campaignId ? '' : binding.queueId,
  })
  const liveCalls = collectionResults(await callToolsRequest('/livephonecalls/', { query: baseQuery }))
  const exactMatch = liveCalls.find(
    (item) => callToolsLiveCallMatches(item, { callId, phoneCandidates }),
  )
  if (exactMatch) return exactMatch

  const boundCalls = liveCalls.filter((item) =>
    callToolsLiveCallMatchesBinding(item, binding),
  )
  return boundCalls.length === 1 ? boundCalls.at(0) : null
}

async function readCallToolsLiveCall(callUuid) {
  try {
    return await callToolsRequest(`/livephonecalls/${encodeURIComponent(callUuid)}/`)
  } catch (error) {
    if (error?.status === 404) return null
    throw error
  }
}

async function readCallToolsCallById(callId, options = {}) {
  try {
    return await callToolsRequest(`/calls/${encodeURIComponent(callId)}/`, {
      timeoutMs: options.timeoutMs,
    })
  } catch (error) {
    if (error?.status === 404) return null
    throw error
  }
}

function callToolsLiveCallMatches(liveCall = {}, { callId = '', phoneCandidates = [] } = {}) {
  if (callId && safeLeadText(liveCall.call_uuid) === callId) return true
  const values = [
    normalizePhone(liveCall.source),
    normalizePhone(liveCall.destination),
  ].filter(Boolean)
  return phoneCandidates.some((candidate) => values.includes(candidate))
}

function callToolsLiveCallMatchesBinding(liveCall = {}, binding = {}) {
  const appUserId = safeLeadText(binding.appUserId || binding.userId)
  const webCallbackId = safeLeadText(binding.webCallbackId)
  const campaignId = safeLeadText(binding.campaignId)
  const queueId = safeLeadText(binding.queueId)
  if (!appUserId || safeLeadText(liveCall.app_user) !== appUserId) return false
  if (webCallbackId) return safeLeadText(liveCall.web_call_back) === webCallbackId
  if (campaignId) return safeLeadText(liveCall.campaign) === campaignId
  if (queueId) return safeLeadText(liveCall.queue) === queueId
  return false
}

function normalizeCallToolsHistoricalCall(call = {}) {
  if (!call || typeof call !== 'object') return null
  return cleanObject({
    id: safeLeadText(call.id),
    uuid: safeLeadText(call.uuid),
    contactId: safeLeadText(call.contact),
    campaignId: safeLeadText(call.campaign),
    queueId: safeLeadText(call.queue),
    webCallbackId: safeLeadText(call.web_call_back),
    appUserId: safeLeadText(call.app_user),
    systemDisposition: safeLeadText(call.system_disposition),
    callDispositionId: safeLeadText(call.call_disposition),
    source: normalizePhone(call.source) || safeLeadText(call.source),
    destination: normalizePhone(call.destination) || safeLeadText(call.destination),
    inbound: Boolean(call.inbound),
    callType: safeLeadText(call.call_type),
    startedAt: safeLeadText(call.start),
    endedAt: safeLeadText(call.end),
    duration: Number(call.duration || 0) || undefined,
    billsec: Number(call.billsec || 0) || undefined,
    callRecordingFsFileId: safeLeadText(call.call_recording_fsfile_id),
  })
}

function callToolsHistoricalCallIdMatches(call = {}, { callId = '' } = {}) {
  const callIds = [safeLeadText(call.uuid), safeLeadText(call.id)].filter(Boolean)
  if (callId && callIds.includes(callId)) return true
  return false
}

function callToolsHistoricalCandidatePool(calls = [], { contactId = '', destination = '' } = {}) {
  const normalizedDestination = normalizePhone(destination)
  const scoped = calls.filter((call) => {
    if (contactId && safeLeadText(call.contact) === safeLeadText(contactId)) return true
    if (
      normalizedDestination &&
      (normalizePhone(call.destination) || safeLeadText(call.destination)) === normalizedDestination
    ) {
      return true
    }
    return false
  })
  return scoped.length ? scoped : calls
}

function nearestCallToolsHistoricalCall(calls = [], startedAt = '', { maxStartDeltaMs = Infinity } = {}) {
  const targetMs = Date.parse(startedAt)
  if (!Number.isFinite(targetMs)) return calls[0] || null
  const nearest = calls
    .map((call) => ({
      call,
      delta: Math.abs((Date.parse(call.start || call.call_datetime || '') || 0) - targetMs),
    }))
    .filter((item) => Number.isFinite(item.delta))
    .sort((left, right) => left.delta - right.delta)[0]
  if (!nearest) return null
  if (Number.isFinite(maxStartDeltaMs) && nearest.delta > maxStartDeltaMs) return null
  return nearest.call
}

function callToolsHistoricalCallIsCurrent(
  call = {},
  {
    startedAt = '',
    maxStartDeltaMs = Infinity,
    destination = '',
    contactId = '',
    allowExactId = false,
    callId = '',
  } = {},
) {
  if (!call || typeof call !== 'object') return false
  if (allowExactId && callToolsHistoricalCallIdMatches(call, { callId })) return true
  const targetMs = Date.parse(startedAt)
  if (Number.isFinite(targetMs)) {
    const callMs = Date.parse(call.start || call.call_datetime || '')
    if (!Number.isFinite(callMs)) return false
    const delta = Math.abs(callMs - targetMs)
    if (Number.isFinite(maxStartDeltaMs) && delta > maxStartDeltaMs) return false
  }
  const normalizedDestination = normalizePhone(destination)
  if (normalizedDestination) {
    return (normalizePhone(call.destination) || safeLeadText(call.destination)) === normalizedDestination
  }
  if (contactId) return safeLeadText(call.contact) === safeLeadText(contactId)
  return true
}

function callToolsHistoricalCallStartToleranceMs(value) {
  const configured = Number(
    value ||
      process.env.CALLTOOLS_HISTORICAL_CALL_START_TOLERANCE_MS ||
      DEFAULT_CALLTOOLS_HISTORICAL_CALL_START_TOLERANCE_MS,
  )
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_CALLTOOLS_HISTORICAL_CALL_START_TOLERANCE_MS
}

function dateOnly(value) {
  const text = safeLeadText(value)
  if (!text) return ''
  return operationalDate(text)
}

function providerDateCandidates(value) {
  return uniqueValues([
    utcDateOnly(value),
    dateOnly(value),
  ]).filter(Boolean)
}

function utcDateOnly(value) {
  const text = safeLeadText(value)
  if (!text) return ''
  const date = new Date(text)
  if (!Number.isFinite(date.getTime())) {
    return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : ''
  }
  return date.toISOString().slice(0, 10)
}

function uniqueValues(values = []) {
  return [...new Set(values.map((value) => safeLeadText(value)).filter(Boolean))]
}

function callToolsContactToRuntimeLead(contact = {}) {
  const firstName = safeLeadText(contact.first_name || contact.firstName)
  const lastName = safeLeadText(contact.last_name || contact.lastName)
  const company = safeLeadText(
    contact.company_name || contact.company || contact.business_name || contact.organization,
  )
  const name =
    safeLeadText(contact.name || [firstName, lastName].filter(Boolean).join(' ')) ||
    company ||
    'CallTools contact'
  return cleanObject({
    id: `calltools-${safeLeadText(contact.id || contact.uuid)}`,
    firstName,
    lastName,
    name,
    company: company || name,
    phone: firstCallToolsContactPhone(contact),
    email: firstCallToolsContactEmail(contact),
    state: safeLeadText(contact.state),
    status: contact.do_not_contact || contact.all_phone_numbers_fdnc ? 'do-not-call' : 'calling',
    lastCall: 'In progress',
    notes: '',
    context: {
      text: '',
      urls: [],
      files: [],
    },
    providerIds: cleanObject({
      calltoolsContactId: safeLeadText(contact.id),
      calltoolsContactUuid: safeLeadText(contact.uuid),
    }),
  })
}

function callToolsRuntimeSourceFields({ binding = {}, liveCall = null } = {}) {
  const campaignId = safeLeadText(liveCall?.campaign || binding.campaignId)
  const liveFilterId = safeLeadText(liveCall?.live_filter || binding.liveFilterId)
  const bucketId = safeLeadText(binding.bucketId)
  const sourceId =
    campaignId && liveFilterId
      ? `campaign:${campaignId}:live-filter:${liveFilterId}`
      : campaignId && bucketId
        ? `campaign:${campaignId}:bucket:${bucketId}`
        : campaignId
          ? `campaign:${campaignId}`
          : 'calltools'
  return {
    source: 'calltools',
    sourceId,
    sourceName: 'CallTools Contacts',
  }
}

function firstCallToolsContactPhone(contact = {}) {
  const direct = normalizePhone(
    contact.phone_number ||
      contact.phone ||
      contact.mobile_phone_number ||
      contact.office_phone_number,
  )
  if (direct) return direct
  const phones = Array.isArray(contact._phone_numbers)
    ? contact._phone_numbers
    : Array.isArray(contact.phone_numbers)
      ? contact.phone_numbers
      : []
  for (const phone of phones) {
    const normalized = normalizePhone(phone.phone_number || phone.number || phone.destination)
    if (normalized) return normalized
  }
  return ''
}

function firstCallToolsContactEmail(contact = {}) {
  const direct = cleanEmail(contact.email || contact.email_address)
  if (direct) return direct
  const emails = Array.isArray(contact._email_addresses)
    ? contact._email_addresses
    : Array.isArray(contact.email_addresses)
      ? contact.email_addresses
      : []
  for (const email of emails) {
    const normalized = cleanEmail(email.email || email.email_address || email.address)
    if (normalized) return normalized
  }
  return ''
}

async function readCallToolsLiveFilter(liveFilterId, options = {}) {
  const id = safeLeadText(liveFilterId)
  if (!id) return null
  const payload = await callToolsRequest(`/livefilters/${encodeURIComponent(id)}/`, {
    timeoutMs: options.timeoutMs,
  })
  return {
    ...payload,
    id: safeLeadText(payload.id || id),
  }
}

async function readCallToolsBucket(bucketId, options = {}) {
  const id = safeLeadText(bucketId)
  if (!id) return null
  const payload = await callToolsRequest(`/buckets/${encodeURIComponent(id)}/`, {
    timeoutMs: options.timeoutMs,
  })
  return {
    ...payload,
    id: safeLeadText(payload.id || id),
  }
}

async function readCallToolsBucketMembershipCount(bucketId, options = {}) {
  const id = safeLeadText(bucketId)
  if (!id) return { count: 0 }
  const payload = await callToolsRequest('/contactbuckets/', {
    query: {
      bucket_id: id,
      page_size: 1,
    },
    timeoutMs: options.timeoutMs,
  })
  return {
    bucketId: id,
    count: Number(payload?.count ?? collectionResults(payload).length ?? 0),
  }
}

async function findCallToolsContactBucket({ contactId, bucketId } = {}) {
  const contact = safeLeadText(contactId)
  const bucket = safeLeadText(bucketId)
  if (!contact || !bucket) return null
  const payload = await callToolsRequest('/contactbuckets/', {
    query: {
      contact_id: contact,
      bucket_id: bucket,
      page_size: 10,
    },
  })
  return collectionResults(payload).find((item) => {
    return safeLeadText(item.contact) === contact && safeLeadText(item.bucket) === bucket
  }) || null
}

async function readCallToolsSourceSelectableContacts({
  sourceKind = '',
  liveFilterId = '',
  bucketId = '',
  timeoutMs,
} = {}) {
  const query = {
    page_size: DEFAULT_PAGE_SIZE,
    ready: true,
    ordering: 'id',
  }
  if (sourceKind === 'live-filter' && liveFilterId) {
    query.live_filter_id = liveFilterId
  } else if (sourceKind === 'bucket' && bucketId) {
    query.buckets__id = bucketId
  } else {
    return {
      sourceKind: safeLeadText(sourceKind || 'unconfigured'),
      readyContactCount: 0,
      selectableNowCount: 0,
      checkedContactCount: 0,
      suppressedContactCount: 0,
    }
  }

  const payload = await callToolsRequest('/contacts/', { query, timeoutMs })
  const contacts = collectionResults(payload)
  const readyContactCount = Number(payload?.count ?? contacts.length ?? 0)
  let selectableNowCount = 0
  let suppressedContactCount = 0
  const candidates = await Promise.all(
    contacts.map((contact) => hydrateCallToolsContactForSelectability(contact, { timeoutMs })),
  )
  for (const candidate of candidates) {
    if (callToolsContactSuppressedNow(candidate)) suppressedContactCount += 1
    if (callToolsContactSelectableNow(candidate)) selectableNowCount += 1
  }
  return {
    sourceKind,
    queryKind: sourceKind === 'live-filter' ? 'live_filter_id' : 'buckets__id',
    liveFilterId: safeLeadText(liveFilterId),
    bucketId: safeLeadText(bucketId),
    readyContactCount,
    selectableNowCount,
    checkedContactCount: contacts.length,
    suppressedContactCount,
  }
}

async function hydrateCallToolsContactForSelectability(contact = {}, options = {}) {
  if (callToolsContactHasDialablePhone(contact)) return contact
  if (
    !contact?.id ||
    contact.ready === false ||
    callToolsTruthy(contact.do_not_contact) ||
    callToolsTruthy(contact.all_phone_numbers_fdnc) ||
    callToolsContactSuppressedNow(contact)
  ) {
    return contact
  }
  return readCallToolsContact(contact.id, options).catch(() => contact)
}

function callToolsContactSelectableNow(contact = {}) {
  return Boolean(
    contact &&
      contact.ready !== false &&
      !callToolsTruthy(contact.do_not_contact) &&
      !callToolsTruthy(contact.all_phone_numbers_fdnc) &&
      !callToolsContactSuppressedNow(contact) &&
      callToolsContactHasDialablePhone(contact),
  )
}

function callToolsContactSuppressedNow(contact = {}) {
  const value = safeLeadText(contact.suppress_until)
  if (!value) return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && timestamp > Date.now()
}

function callToolsContactHasDialablePhone(contact = {}) {
  return Boolean(firstCallToolsContactPhone(contact))
}

function callToolsTruthy(value) {
  if (value === true || value === 1) return true
  if (typeof value === 'string') {
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
  }
  return false
}

function collectionResults(payload) {
  return Array.isArray(payload?.results)
    ? payload.results
    : Array.isArray(payload?.data?.results)
      ? payload.data.results
      : Array.isArray(payload)
        ? payload
        : []
}

function publicUser(value = {}) {
  const appUserId = safeLeadText(value.app_user || value.appUserId || value.id)
  return {
    id: appUserId,
    appUserId,
    name: safeLeadText(value.full_name || [value.first_name, value.last_name].filter(Boolean).join(' ')),
    username: safeLeadText(value.username),
    email: safeLeadText(value.email),
    isAgent: Boolean(value.is_agent),
    isManager: Boolean(value.is_manager),
  }
}

function publicPhone(value = {}) {
  return {
    id: safeLeadText(value.id),
    appUserId: safeLeadText(value.app_user),
    name: safeLeadText(value.name),
    username: safeLeadText(value.username),
    sipUri: safeLeadText(value.sip_uri),
    webSocketUrl: safeLeadText(value.ws_url),
    isWebRtc: Boolean(value.is_webrtc),
    extension: safeLeadText(value.extension),
    serviceLevel: safeLeadText(value.service_level),
    callRecording: safeLeadText(value.call_recording),
    inboundRingTime: value.inbound_ring_time ?? null,
    outboundRingTime: value.outbound_ring_time ?? null,
  }
}

function publicQueue(value = {}) {
  return {
    id: safeLeadText(value.id),
    uuid: safeLeadText(value.uuid),
    name: safeLeadText(value.name),
    extension: safeLeadText(value.extension),
    autoAnswer: Boolean(value.auto_answer),
    callRecording: safeLeadText(value.call_recording),
    memberAgents: Array.isArray(value.member_agents) ? value.member_agents.map(String) : [],
  }
}

function publicCampaign(value = {}) {
  return {
    id: safeLeadText(value.id),
    uuid: safeLeadText(value.uuid),
    name: safeLeadText(value.name),
    active: Boolean(value.active),
    originateCalls: Boolean(value.originate_calls),
    channelsPerAgent: Number(value.channels_per_agent || 0),
    amdActive: Boolean(value.amd_active),
    callRecording: Boolean(value.call_recording),
    callerIdStrategyId: safeLeadText(value.caller_id_strategy),
    liveFilterId: safeLeadText(value.live_filter),
    bucketId: safeLeadText(value.bucket),
  }
}

function publicCallerId(value = {}) {
  return {
    id: safeLeadText(value.id),
    name: safeLeadText(value.name || value.label),
    campaignEnabled: Boolean(value.campaign_enabled),
    stiVerified: Boolean(value.sti_verified),
  }
}

function publicWebCallback(value = {}) {
  return cleanObject({
    id: safeLeadText(value.id),
    uuid: safeLeadText(value.uuid),
    name: safeLeadText(value.name),
    active: value.active !== false,
    nextDestination: safeLeadText(
      value.next_destination ||
        value.nextDestination ||
        value.destination ||
        value.phone_destination,
    ),
    callerIdStrategyId: safeLeadText(value.caller_id_strategy || value.callerIdStrategyId),
    ringTime: Number(value.ring_time ?? value.ringTime ?? 0) || undefined,
    retries: Number(value.retries ?? 0),
    retryDelay: Number(value.retry_delay ?? value.retryDelay ?? 0) || undefined,
    totalPending: Number(value.total_pending ?? value.totalPending ?? 0) || undefined,
  })
}

function selectCallToolsWebCallbackForPhone(webCallbacks = [], phone = null) {
  if (!phone?.id) return null
  const phoneId = safeLeadText(phone.id)
  return (
    webCallbacks.find((item) => safeLeadText(item.nextDestination).includes(phoneId)) ||
    null
  )
}

export function sanitizeCallToolsPayload(payload) {
  if (Array.isArray(payload)) return payload.map(sanitizeCallToolsPayload)
  if (!payload || typeof payload !== 'object') return payload
  return Object.fromEntries(
    Object.entries(payload).map(([key, value]) => [
      key,
      isSecretKey(key) ? '[redacted]' : sanitizeCallToolsPayload(value),
    ]),
  )
}

function isSecretKey(key) {
  return /password|token|api[_-]?key|secret|authorization/i.test(key)
}

function callToolsErrorMessage(payload, fallback) {
  if (!payload || typeof payload !== 'object') return String(payload || fallback || 'CallTools request failed')
  const directMessage = safeLeadText(payload.detail || payload.error || payload.message)
  if (directMessage) return directMessage
  const sanitized = sanitizeCallToolsPayload(payload)
  const fieldMessages = Object.entries(sanitized)
    .filter(([key]) => !isSecretKey(key))
    .map(([key, value]) => {
      const message = Array.isArray(value)
        ? value.map((item) => safeLeadText(item)).filter(Boolean).join(', ')
        : value && typeof value === 'object'
          ? safeLeadText(JSON.stringify(value))
          : safeLeadText(value)
      return message ? `${key}: ${message}` : ''
    })
    .filter(Boolean)
    .join('; ')
  return safeLeadText(fieldMessages || fallback || 'CallTools request failed')
}
