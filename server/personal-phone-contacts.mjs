import { importWorkspaceSourceLeads } from './workspace-store.mjs'
import { getBlueBubblesPassword } from './secrets.mjs'
import {
  cleanEmail,
  cleanName,
  cleanObject,
  normalizePhone,
  safeLeadText,
} from './runtime-config.mjs'

const defaultBlueBubblesBaseUrl = 'http://127.0.0.1:1234'
const defaultSourceId = 'bluebubbles:contacts'

export async function personalPhoneContactsStatus() {
  const config = personalPhoneContactsConfig()
  let server = null
  let readError = ''

  if (config.password) {
    try {
      const payload = await blueBubblesJson('/api/v1/server/info', config)
      server = payload.data || payload
    } catch (error) {
      readError = error instanceof Error ? error.message : 'BlueBubbles status read failed'
    }
  }

  return cleanObject({
    configured: Boolean(config.password && config.baseUrl),
    missing: [
      config.baseUrl ? '' : 'BLUEBUBBLES_SERVER_URL',
      config.password ? '' : 'BLUEBUBBLES_PASSWORD',
    ].filter(Boolean),
    source: 'personal-phone',
    sourceId: config.sourceId,
    sourceUrl: config.sourceUrl,
    externalUrl: config.externalUrl,
    title: config.title,
    serverUrl: config.baseUrl,
    passwordSource: config.passwordSource,
    helperConnected: server ? Boolean(server.helper_connected) : undefined,
    privateApi: server ? Boolean(server.private_api) : undefined,
    serverVersion: safeLeadText(server?.server_version),
    readError,
  })
}

export async function syncPersonalPhoneContactsToWorkspace() {
  const config = personalPhoneContactsConfig()
  if (!config.password) {
    const error = new Error('BLUEBUBBLES_PASSWORD is not configured')
    error.statusCode = 503
    throw error
  }

  const payload = await blueBubblesJson('/api/v1/contact', config)
  const contacts = Array.isArray(payload.data) ? payload.data : []
  const leads = contacts
    .map((contact, index) => blueBubblesContactToLead(contact, index))
    .filter(Boolean)
  const syncedAt = new Date().toISOString()
  const result = await importWorkspaceSourceLeads({
    name: config.title,
    source: 'personal-phone',
    sourceId: config.sourceId,
    sourceUrl: config.sourceUrl,
    externalUrl: config.externalUrl,
    syncedAt,
    leads,
  })

  return {
    ...result,
    personalPhone: {
      source: 'personal-phone',
      sourceId: config.sourceId,
      totalContactCount: contacts.length,
      importedCount: result.imported?.length || 0,
      skippedWithoutPhone: contacts.length - leads.length,
      syncedAt,
    },
  }
}

function personalPhoneContactsConfig() {
  const envPassword = safeLeadText(process.env.BLUEBUBBLES_PASSWORD)
  const password = envPassword || getBlueBubblesPassword()
  const baseUrl = safeLeadText(
    process.env.BLUEBUBBLES_SERVER_URL ||
      process.env.BLUEBUBBLES_API_URL ||
      defaultBlueBubblesBaseUrl,
  ).replace(/\/+$/g, '')
  const sourceId = safeLeadText(
    process.env.PERSONAL_PHONE_CONTACTS_SOURCE_ID || defaultSourceId,
  )
  return {
    baseUrl,
    externalUrl:
      safeLeadText(process.env.PERSONAL_PHONE_CONTACTS_EXTERNAL_URL) ||
      'bluebubbles://contacts',
    password,
    passwordSource: password ? (envPassword ? 'env' : 'keychain:bluebubbles-password') : '',
    sourceId,
    sourceUrl:
      safeLeadText(process.env.PERSONAL_PHONE_CONTACTS_SOURCE_URL) ||
      'bluebubbles://contacts',
    title:
      safeLeadText(process.env.PERSONAL_PHONE_CONTACTS_TITLE) ||
      'Personal Phone Contacts',
  }
}

async function blueBubblesJson(path, config) {
  const url = new URL(path, `${config.baseUrl}/`)
  url.searchParams.set('password', config.password)
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message =
      typeof payload.message === 'string'
        ? payload.message
        : `BlueBubbles request failed (${response.status})`
    const error = new Error(message)
    error.statusCode = response.status
    throw error
  }
  return payload
}

function blueBubblesContactToLead(contact = {}, index = 0) {
  const phone = firstPhone(contact)
  if (!phone) return null

  const firstName = cleanName(contact.firstName || contact.first_name || '')
  const lastName = cleanName(contact.lastName || contact.last_name || '')
  const displayName = cleanName(
    contact.displayName ||
      contact.name ||
      [firstName, lastName].filter(Boolean).join(' '),
  )
  const company = safeLeadText(
    contact.companyName || contact.company || contact.organization || '',
  )
  const blueBubblesContactId = safeLeadText(contact.id || contact.identifier)

  return cleanObject({
    id: `personal-phone-${stableContactKey(blueBubblesContactId || phone || index)}`,
    firstName,
    lastName,
    name: displayName || company || phone,
    company: company || displayName || 'Personal Phone Contact',
    phone,
    email: firstEmail(contact),
    state: '',
    tags: ['personal-phone', 'bluebubbles'],
    score: 50,
    status: 'ready',
    lastCall: 'Never',
    notes: '',
    context: { text: '', urls: [], files: [] },
  })
}

function firstPhone(contact = {}) {
  const phones = Array.isArray(contact.phoneNumbers)
    ? contact.phoneNumbers
    : Array.isArray(contact.phone_numbers)
      ? contact.phone_numbers
      : []
  for (const item of phones) {
    const normalized = normalizePhone(item?.address || item?.phone || item?.number)
    if (normalized) return normalized
  }
  return normalizePhone(contact.phone || contact.phoneNumber || contact.mobilePhone)
}

function firstEmail(contact = {}) {
  const emails = Array.isArray(contact.emails)
    ? contact.emails
    : Array.isArray(contact.emailAddresses)
      ? contact.emailAddresses
      : []
  for (const item of emails) {
    const normalized = cleanEmail(item?.address || item?.email)
    if (normalized) return normalized
  }
  return cleanEmail(contact.email || contact.emailAddress)
}

function stableContactKey(value) {
  return (
    String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 96) || 'contact'
  )
}
