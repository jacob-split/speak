import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'

export const SMART_CONFIG_AUTH_SCHEMA_VERSION = 'speak.smart-config-auth.v1'

const SESSION_COOKIE = 'speak_smart_config_session'
const OAUTH_STATE_COOKIE = 'speak_smart_config_oauth_state'
const OAUTH_STATE_TTL_SECONDS = 10 * 60
const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo'

function cleanText(value) {
  return String(value || '').trim()
}

function isLocalHost(hostname = '') {
  return /^(localhost|127\.0\.0\.1|\[?::1\]?)$/i.test(
    String(hostname).split(':')[0],
  )
}

function ownerToken() {
  return cleanText(
    process.env.SPEAK_SMART_CONFIG_TOKEN ||
      process.env.SPEAK_CODEX_DEBUG_TOKEN,
  )
}

function trustedOwnerMode() {
  const mode = cleanText(process.env.SPEAK_SMART_CONFIG_AUTH_MODE).toLowerCase()
  const enabled = cleanText(process.env.SPEAK_SMART_CONFIG_TRUST_OWNER).toLowerCase()
  return (
    ['trusted', 'trusted_owner', 'disabled', 'ownerless'].includes(mode) ||
    ['1', 'true', 'yes', 'on'].includes(enabled)
  )
}

function trustedOwnerSession() {
  if (!trustedOwnerMode()) return null
  return {
    email:
      cleanText(process.env.SPEAK_SMART_CONFIG_TRUSTED_EMAIL).toLowerCase() ||
      cleanText(process.env.WORKSPACE_EMAIL_ACCOUNT).toLowerCase() ||
      'owner@speak.local',
    name: cleanText(process.env.SPEAK_SMART_CONFIG_TRUSTED_NAME) || 'Owner',
    provider: 'trusted_owner',
  }
}

function sessionSecret() {
  return cleanText(process.env.SPEAK_SMART_CONFIG_SESSION_SECRET) || ownerToken()
}

function googleClientId() {
  return cleanText(
    process.env.SPEAK_GOOGLE_OAUTH_CLIENT_ID ||
      process.env.GOOGLE_OAUTH_CLIENT_ID ||
      process.env.GOOGLE_CLIENT_ID,
  )
}

function googleClientSecret() {
  return cleanText(
    process.env.SPEAK_GOOGLE_OAUTH_CLIENT_SECRET ||
      process.env.GOOGLE_OAUTH_CLIENT_SECRET ||
      process.env.GOOGLE_CLIENT_SECRET,
  )
}

function sessionTtlSeconds() {
  const days = Number(process.env.SPEAK_SMART_CONFIG_SESSION_DAYS || 30)
  const normalizedDays = Number.isFinite(days) && days > 0 ? days : 30
  return Math.round(normalizedDays * 24 * 60 * 60)
}

function configuredOwnerEmails() {
  const configured = cleanText(
    process.env.SPEAK_SMART_CONFIG_ALLOWED_EMAILS ||
      process.env.SPEAK_CODEX_DEBUG_ALLOWED_EMAILS,
  )
  const fallback = cleanText(process.env.WORKSPACE_EMAIL_ACCOUNT)
  return (configured || fallback || 'owner@example.com')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)
}

function configuredOwnerDomains() {
  return cleanText(
    process.env.SPEAK_SMART_CONFIG_ALLOWED_DOMAINS ||
      process.env.SPEAK_CODEX_DEBUG_ALLOWED_DOMAINS,
  )
    .split(',')
    .map((domain) => domain.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean)
}

function oauthConfigured() {
  return Boolean(googleClientId() && googleClientSecret())
}

function requestToken(request) {
  const auth = String(request.headers.authorization || '').trim()
  if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim()
  return cleanText(
    request.headers['x-speak-smart-config-token'] ||
      request.headers['x-speak-codex-token'],
  )
}

function parseCookies(request) {
  const cookies = new Map()
  for (const pair of String(request.headers.cookie || '').split(';')) {
    const index = pair.indexOf('=')
    if (index < 0) continue
    const key = pair.slice(0, index).trim()
    const value = pair.slice(index + 1).trim()
    if (!key) continue
    cookies.set(key, decodeURIComponent(value))
  }
  return cookies
}

function base64Url(value) {
  return Buffer.from(value).toString('base64url')
}

function signValue(payload) {
  const secret = sessionSecret()
  if (!secret) return ''
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

function signedCookieValue(payload) {
  const encoded = base64Url(JSON.stringify(payload))
  return `${encoded}.${signValue(encoded)}`
}

function verifySignedCookie(value) {
  const [encoded, signature] = String(value || '').split('.')
  if (!encoded || !signature) return null
  const expected = signValue(encoded)
  if (!expected) return null
  const actualBuffer = Buffer.from(signature)
  const expectedBuffer = Buffer.from(expected)
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    return null
  }
  try {
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

function requestIsSecure(request) {
  return (
    request.secure ||
    String(request.headers['x-forwarded-proto'] || '').split(',')[0] === 'https'
  )
}

function setCookie(response, request, name, value, maxAgeSeconds) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ]
  if (requestIsSecure(request)) parts.push('Secure')
  response.setHeader('Set-Cookie', parts.join('; '))
}

function clearCookie(response, request, name) {
  setCookie(response, request, name, '', 0)
}

function publicAppBaseUrl(request, basePath = '') {
  const configured = cleanText(
    process.env.SPEAK_SMART_CONFIG_PUBLIC_BASE_URL ||
      process.env.PUBLIC_BASE_URL,
  )
  if (configured) return configured.replace(/\/+$/g, '')
  const proto =
    String(request.headers['x-forwarded-proto'] || '').split(',')[0] ||
    (requestIsSecure(request) ? 'https' : 'http')
  const host = String(request.headers['x-forwarded-host'] || request.headers.host || '')
    .split(',')[0]
    .trim()
  return `${proto}://${host}${basePath}`.replace(/\/+$/g, '')
}

function oauthRedirectUri(request, basePath = '') {
  const configured = cleanText(process.env.SPEAK_GOOGLE_OAUTH_REDIRECT_URI)
  if (configured) return configured
  return `${publicAppBaseUrl(request, basePath)}/api/smart-config/oauth/callback`
}

function safeReturnTo(value, basePath = '') {
  const raw = cleanText(value)
  const fallback = `${basePath || ''}/configs` || '/'
  if (!raw.startsWith('/')) return fallback
  if (raw.startsWith('//')) return fallback
  return raw
}

function ownerAllowed(email, hostedDomain) {
  const normalizedEmail = cleanText(email).toLowerCase()
  if (!normalizedEmail) return false
  const emails = configuredOwnerEmails()
  if (emails.includes('*') || emails.includes(normalizedEmail)) return true
  const emailDomain = normalizedEmail.split('@')[1] || ''
  const domains = configuredOwnerDomains()
  return Boolean(
    domains.length &&
      (domains.includes('*') ||
        domains.includes(emailDomain) ||
        (hostedDomain && domains.includes(cleanText(hostedDomain).toLowerCase()))),
  )
}

export function smartConfigSession(request) {
  const trusted = trustedOwnerSession()
  if (trusted) return trusted

  const payload = verifySignedCookie(parseCookies(request).get(SESSION_COOKIE))
  if (!payload) return null
  const expiresAt = Number(payload.exp || 0)
  if (!expiresAt || expiresAt < Date.now()) return null
  const email = cleanText(payload.email).toLowerCase()
  if (!ownerAllowed(email, payload.hd)) return null
  return {
    email,
    name: cleanText(payload.name),
    provider: 'google',
  }
}

export function smartConfigSessionStatus(request) {
  const session = smartConfigSession(request)
  const local = !ownerToken() && isLocalHost(request.hostname)
  return {
    ok: true,
    authenticated: Boolean(session || local),
    authProvider: session?.provider || (local ? 'localhost' : null),
    email: session?.email || '',
    loginUrl: trustedOwnerMode() ? '' : '/api/smart-config/oauth/start',
    oauthConfigured: trustedOwnerMode() ? false : oauthConfigured(),
  }
}

export function assertSmartConfigAccess(request) {
  if (process.env.SPEAK_SMART_CONFIG_ENABLED === 'false') {
    return {
      ok: false,
      status: 404,
      error: 'smart_config_disabled',
      message: 'Smart Config is disabled.',
    }
  }

  const session = smartConfigSession(request)
  if (session) return { ok: true, session }

  const token = ownerToken()
  if (!token && isLocalHost(request.hostname)) return { ok: true }

  if (!token) {
    return {
      ok: false,
      status: 403,
      error: 'smart_config_token_required',
      message: 'Smart Config requires owner access on this host.',
    }
  }

  if (requestToken(request) === token) return { ok: true, authProvider: 'owner_token' }

  if (oauthConfigured()) {
    return {
      ok: false,
      status: 401,
      error: 'smart_config_sign_in_required',
      message: 'Sign in with Google to use Smart Config.',
      loginUrl: '/api/smart-config/oauth/start',
    }
  }

  return {
    ok: false,
    status: 401,
    error: 'smart_config_unauthorized',
    message: 'Owner token required.',
  }
}

export function startSmartConfigGoogleOAuth({ request, response, basePath = '' }) {
  if (trustedOwnerMode()) {
    response.redirect(safeReturnTo(request.query?.returnTo, basePath))
    return
  }

  if (!oauthConfigured()) {
    response.status(503).json({
      schemaVersion: SMART_CONFIG_AUTH_SCHEMA_VERSION,
      ok: false,
      error: 'google_oauth_not_configured',
      message: 'Google OAuth is not configured for Smart Config.',
    })
    return
  }

  const nonce = randomBytes(18).toString('base64url')
  const state = {
    nonce,
    returnTo: safeReturnTo(request.query?.returnTo, basePath),
    iat: Date.now(),
    exp: Date.now() + OAUTH_STATE_TTL_SECONDS * 1000,
  }
  setCookie(
    response,
    request,
    OAUTH_STATE_COOKIE,
    signedCookieValue(state),
    OAUTH_STATE_TTL_SECONDS,
  )

  const url = new URL(GOOGLE_AUTHORIZE_URL)
  url.searchParams.set('client_id', googleClientId())
  url.searchParams.set('redirect_uri', oauthRedirectUri(request, basePath))
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', 'openid email profile')
  url.searchParams.set('state', nonce)
  url.searchParams.set('include_granted_scopes', 'true')
  url.searchParams.set('access_type', 'online')
  response.redirect(url.toString())
}

export async function finishSmartConfigGoogleOAuth({
  request,
  response,
  basePath = '',
}) {
  const stateCookie = verifySignedCookie(
    parseCookies(request).get(OAUTH_STATE_COOKIE),
  )
  clearCookie(response, request, OAUTH_STATE_COOKIE)

  if (
    !stateCookie ||
    stateCookie.exp < Date.now() ||
    cleanText(request.query?.state) !== cleanText(stateCookie.nonce)
  ) {
    response.status(400).send('Invalid or expired Google sign-in state.')
    return
  }

  const code = cleanText(request.query?.code)
  if (!code) {
    response.status(400).send('Missing Google authorization code.')
    return
  }

  const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: googleClientId(),
      client_secret: googleClientSecret(),
      code,
      grant_type: 'authorization_code',
      redirect_uri: oauthRedirectUri(request, basePath),
    }),
  })
  const tokenPayload = await tokenResponse.json().catch(() => ({}))
  if (!tokenResponse.ok || !tokenPayload.id_token) {
    response.status(401).send('Google sign-in failed.')
    return
  }

  const tokenInfoResponse = await fetch(
    `${GOOGLE_TOKENINFO_URL}?id_token=${encodeURIComponent(tokenPayload.id_token)}`,
  )
  const identity = await tokenInfoResponse.json().catch(() => ({}))
  if (
    !tokenInfoResponse.ok ||
    identity.aud !== googleClientId() ||
    !['true', true].includes(identity.email_verified)
  ) {
    response.status(401).send('Google identity verification failed.')
    return
  }

  if (!ownerAllowed(identity.email, identity.hd)) {
    response.status(403).send('This Google account is not allowed for Smart Config.')
    return
  }

  setCookie(
    response,
    request,
    SESSION_COOKIE,
    signedCookieValue({
      email: cleanText(identity.email).toLowerCase(),
      hd: cleanText(identity.hd),
      name: cleanText(identity.name),
      iat: Date.now(),
      exp: Date.now() + sessionTtlSeconds() * 1000,
    }),
    sessionTtlSeconds(),
  )
  response.redirect(safeReturnTo(stateCookie.returnTo, basePath))
}

export function clearSmartConfigSession({ request, response }) {
  clearCookie(response, request, SESSION_COOKIE)
  response.json({
    schemaVersion: SMART_CONFIG_AUTH_SCHEMA_VERSION,
    ok: true,
    authenticated: false,
  })
}
