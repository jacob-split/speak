import { callToolsRequest, verifyCallToolsAgentBinding } from './calltools-client.mjs'
import { importWorkspaceSourceLeads } from './workspace-store.mjs'
import {
  cleanEmail,
  cleanObject,
  normalizeCampaignConfig,
  normalizePhone,
  safeLeadText,
} from './runtime-config.mjs'

const DEFAULT_CALLTOOLS_CONTACT_SYNC_PAGE_SIZE = 100
const DEFAULT_CALLTOOLS_CONTACT_SYNC_MAX_PAGES = 250
const DEFAULT_CALLTOOLS_PHONE_NUMBER_SYNC_PAGE_SIZE = 500
const DEFAULT_CALLTOOLS_PHONE_NUMBER_SYNC_MAX_PAGES = 250

export async function callToolsCampaignContactsStatus(profile = {}) {
  const config = normalizeCampaignConfig(profile.config || profile)
  const binding = config.calltoolsAgentBinding || {}
  const verification = await verifyCallToolsAgentBinding(config)
  const campaign = verification.matched.campaign || {}
  const campaignId = safeLeadText(binding.campaignId || campaign.id)
  const liveFilterId = safeLeadText(campaign.id ? campaign.liveFilterId : binding.liveFilterId)
  const bucketId = safeLeadText(campaign.id ? campaign.bucketId : binding.bucketId)
  return {
    configured: Boolean(campaignId),
    missing: [campaignId ? '' : 'CALLTOOLS_CAMPAIGN_ID'].filter(Boolean),
    profileId: safeLeadText(profile.id),
    profileName: safeLeadText(profile.name || config.agentProfileName),
    campaignId,
    campaignName: safeLeadText(campaign.name),
    liveFilterId,
    bucketId,
    sourceKind: liveFilterId ? 'live-filter' : bucketId ? 'bucket' : 'campaign',
    source: 'calltools',
  }
}

export async function syncCallToolsCampaignContactsToWorkspace({ profile } = {}) {
  const config = normalizeCampaignConfig(profile?.config || profile || {})
  const binding = config.calltoolsAgentBinding || {}
  const verification = await verifyCallToolsAgentBinding(config)
  const campaign = verification.matched.campaign
  const campaignId = safeLeadText(binding.campaignId || campaign?.id)
  const liveFilterId = safeLeadText(campaign?.id ? campaign.liveFilterId : binding.liveFilterId)
  const bucketId = safeLeadText(campaign?.id ? campaign.bucketId : binding.bucketId)
  const sourceKind = liveFilterId ? 'live-filter' : bucketId ? 'bucket' : ''

  if (!campaignId) {
    throw callToolsSyncError('CALLTOOLS_CAMPAIGN_ID is required', 400, 'calltools_campaign_missing')
  }
  if (!campaign) {
    throw callToolsSyncError('CallTools campaign not found', 404, 'calltools_campaign_not_found')
  }
  if (!sourceKind) {
    throw callToolsSyncError(
      'CallTools campaign does not have a live filter or bucket to sync',
      409,
      'calltools_campaign_source_missing',
    )
  }

  const { source, contacts, readProof } =
    sourceKind === 'live-filter'
      ? await readCallToolsLiveFilterContacts(liveFilterId)
      : await readCallToolsBucketContacts(bucketId)
  const enrichedContactsResult = await enrichCallToolsContactsWithPhoneNumbers(contacts)
  const leads = enrichedContactsResult.contacts.map((contact, index) =>
    callToolsContactToLead(contact, {
      campaign,
      source,
      sourceKind,
      index,
    }),
  )
  const syncedAt = new Date().toISOString()
  const sourceId =
    sourceKind === 'live-filter'
      ? `campaign:${campaignId}:live-filter:${liveFilterId}`
      : `campaign:${campaignId}:bucket:${bucketId}`
  const result = await importWorkspaceSourceLeads({
    name: `CallTools ${safeLeadText(campaign.name) || 'Campaign'} Contacts`,
    source: 'calltools',
    sourceId,
    sourceUrl:
      sourceKind === 'live-filter'
        ? `calltools://campaigns/${campaignId}/live-filters/${liveFilterId}`
        : `calltools://campaigns/${campaignId}/buckets/${bucketId}`,
    syncedAt,
    leads,
  })

  return {
    ...result,
    calltools: {
      profileId: safeLeadText(profile?.id),
      profileName: safeLeadText(profile?.name || config.agentProfileName),
      campaignId,
      campaignName: safeLeadText(campaign.name),
      campaignActive: Boolean(campaign.active),
      originateCalls: Boolean(campaign.originateCalls),
      sourceKind,
      liveFilterId,
      liveFilterName: sourceKind === 'live-filter' ? safeLeadText(source?.name) : '',
      liveFilterActive: sourceKind === 'live-filter' ? Boolean(source?.active) : false,
      liveFilterCount: sourceKind === 'live-filter' ? Number(source?.count ?? 0) : 0,
      bucketId,
      bucketName: sourceKind === 'bucket' ? safeLeadText(source?.name) : '',
      bucketCount: sourceKind === 'bucket' ? Number(source?.count ?? 0) : 0,
      queriedContactCount: readProof.totalCount ?? contacts.length,
      importedCount: result.imported?.length || 0,
      pageSize: readProof.pageSize,
      pagesRead: readProof.pagesRead,
      truncated: readProof.truncated,
      maxPages: readProof.maxPages,
      ...enrichedContactsResult.readProof,
      syncedAt,
    },
  }
}

async function readCallToolsLiveFilterContacts(liveFilterId) {
  const [liveFilter, contactsResult] = await Promise.all([
    callToolsRequest(`/livefilters/${encodeURIComponent(liveFilterId)}/`),
    readPaginatedCallToolsContacts({
      live_filter_id: liveFilterId,
    }),
  ])
  return {
    source: liveFilter,
    contacts: contactsResult.contacts,
    readProof: contactsResult.readProof,
  }
}

async function readCallToolsBucketContacts(bucketId) {
  const [bucket, contactsResult] = await Promise.all([
    callToolsRequest(`/buckets/${encodeURIComponent(bucketId)}/`),
    readPaginatedCallToolsContacts({
      buckets__id: bucketId,
    })
  ])
  return {
    source: bucket,
    contacts: contactsResult.contacts,
    readProof: contactsResult.readProof,
  }
}

async function readPaginatedCallToolsContacts(sourceQuery = {}) {
  const pageSize = boundedPositiveInteger(
    process.env.CALLTOOLS_CONTACT_SYNC_PAGE_SIZE,
    DEFAULT_CALLTOOLS_CONTACT_SYNC_PAGE_SIZE,
    1,
    500,
  )
  const maxPages = boundedPositiveInteger(
    process.env.CALLTOOLS_CONTACT_SYNC_MAX_PAGES,
    DEFAULT_CALLTOOLS_CONTACT_SYNC_MAX_PAGES,
    1,
    1000,
  )
  const contacts = []
  const seen = new Set()
  let totalCount = null
  let truncated = false
  let page = 1

  while (page <= maxPages) {
    const payload = await callToolsRequest('/contacts/', {
      query: {
        ...sourceQuery,
        ordering: 'id',
        page,
        page_size: pageSize,
      },
    })
    const results = collectionResults(payload)
    if (Number.isFinite(Number(payload?.count))) {
      totalCount = Number(payload.count)
    }
    for (const contact of results) {
      const id = safeLeadText(contact.id)
      const key = id || JSON.stringify(contact)
      if (seen.has(key)) continue
      seen.add(key)
      contacts.push(contact)
    }
    if (!payload?.next || results.length === 0) break
    page += 1
  }

  if (page > maxPages) truncated = true
  if (truncated) {
    throw callToolsSyncError(
      `CallTools contact source exceeded ${maxPages} pages; increase CALLTOOLS_CONTACT_SYNC_MAX_PAGES before syncing`,
      413,
      'calltools_contact_sync_page_limit',
    )
  }

  return {
    contacts,
    readProof: {
      pageSize,
      maxPages,
      pagesRead: page,
      totalCount,
      truncated,
    },
  }
}

export async function enrichCallToolsContactsWithPhoneNumbers(
  contacts = [],
  { request = callToolsRequest } = {},
) {
  const contactIds = new Set()
  const missingPhoneIds = new Set()
  for (const contact of contacts) {
    const contactId = safeLeadText(contact.id)
    if (!contactId) continue
    contactIds.add(contactId)
    if (!firstPhone(contact)) missingPhoneIds.add(contactId)
  }

  const pageSize = boundedPositiveInteger(
    process.env.CALLTOOLS_PHONE_NUMBER_SYNC_PAGE_SIZE ||
      process.env.CALLTOOLS_CONTACT_SYNC_PAGE_SIZE,
    DEFAULT_CALLTOOLS_PHONE_NUMBER_SYNC_PAGE_SIZE,
    1,
    500,
  )
  const maxPages = boundedPositiveInteger(
    process.env.CALLTOOLS_PHONE_NUMBER_SYNC_MAX_PAGES ||
      process.env.CALLTOOLS_CONTACT_SYNC_MAX_PAGES,
    DEFAULT_CALLTOOLS_PHONE_NUMBER_SYNC_MAX_PAGES,
    1,
    1000,
  )

  if (contactIds.size === 0 || missingPhoneIds.size === 0) {
    return {
      contacts,
      readProof: {
        phoneNumbersPageSize: pageSize,
        phoneNumbersMaxPages: maxPages,
        phoneNumbersPagesRead: 0,
        phoneNumbersTotalCount: null,
        phoneNumbersTruncated: false,
        phoneNumberCandidateContactCount: contactIds.size,
        phoneNumberMissingBeforeCount: missingPhoneIds.size,
        phoneNumberMatchedContactCount: 0,
        phoneNumberHydratedContactCount: 0,
        phoneNumberMissingContactCount: missingPhoneIds.size,
      },
    }
  }

  const phoneNumbersByContactId = new Map()
  const matchedContactIds = new Set()
  const remainingMissingIds = new Set(missingPhoneIds)
  let totalCount = null
  let truncated = false
  let page = 1
  let pagesRead = 0

  while (page <= maxPages) {
    const payload = await request('/phonenumbers/', {
      query: {
        page,
        page_size: pageSize,
      },
    })
    pagesRead = page
    const results = collectionResults(payload)
    if (Number.isFinite(Number(payload?.count))) {
      totalCount = Number(payload.count)
    }
    for (const phoneNumber of results) {
      const contactId = callToolsPhoneNumberContactId(phoneNumber)
      if (!contactIds.has(contactId)) continue
      matchedContactIds.add(contactId)
      const normalized = firstPhone({ _phone_numbers: [phoneNumber] })
      if (!normalized) continue
      const existing = phoneNumbersByContactId.get(contactId) || []
      existing.push(phoneNumber)
      phoneNumbersByContactId.set(contactId, existing)
      remainingMissingIds.delete(contactId)
    }
    if (remainingMissingIds.size === 0 || !payload?.next || results.length === 0) break
    page += 1
  }

  if (page > maxPages) truncated = true
  if (truncated) {
    throw callToolsSyncError(
      `CallTools phone-number source exceeded ${maxPages} pages; increase CALLTOOLS_PHONE_NUMBER_SYNC_MAX_PAGES before syncing`,
      413,
      'calltools_phone_number_sync_page_limit',
    )
  }

  let hydratedContactCount = 0
  let missingAfterCount = 0
  const enrichedContacts = contacts.map((contact) => {
    const contactId = safeLeadText(contact.id)
    const extraPhoneNumbers = phoneNumbersByContactId.get(contactId) || []
    const enrichedContact = mergeCallToolsPhoneNumbers(contact, extraPhoneNumbers)
    if (missingPhoneIds.has(contactId) && firstPhone(enrichedContact)) hydratedContactCount += 1
    if (missingPhoneIds.has(contactId) && !firstPhone(enrichedContact)) missingAfterCount += 1
    return enrichedContact
  })

  return {
    contacts: enrichedContacts,
    readProof: {
      phoneNumbersPageSize: pageSize,
      phoneNumbersMaxPages: maxPages,
      phoneNumbersPagesRead: pagesRead,
      phoneNumbersTotalCount: totalCount,
      phoneNumbersTruncated: truncated,
      phoneNumberCandidateContactCount: contactIds.size,
      phoneNumberMissingBeforeCount: missingPhoneIds.size,
      phoneNumberMatchedContactCount: matchedContactIds.size,
      phoneNumberHydratedContactCount: hydratedContactCount,
      phoneNumberMissingContactCount: missingAfterCount,
    },
  }
}

function callToolsContactToLead(
  contact = {},
  { campaign = {}, source = {}, sourceKind = 'live-filter', index = 0 } = {},
) {
  const id = safeLeadText(contact.id)
  const firstName = safeLeadText(contact.first_name || contact.firstName)
  const lastName = safeLeadText(contact.last_name || contact.lastName)
  const company = safeLeadText(
    contact.company_name || contact.company || contact.business_name || contact.organization,
  )
  const name =
    safeLeadText(contact.name || [firstName, lastName].filter(Boolean).join(' ')) ||
    company ||
    `CallTools contact ${index + 1}`
  const doNotContact = Boolean(contact.do_not_contact || contact.all_phone_numbers_fdnc)

  return cleanObject({
    id: `calltools-${id || index}`,
    firstName,
    lastName,
    name,
    company: company || name,
    phone: firstPhone(contact),
    email: firstEmail(contact),
    state: safeLeadText(contact.state),
    tags: callToolsContactTags(contact),
    score: 50,
    status: doNotContact ? 'do-not-call' : 'ready',
    lastCall: safeLeadText(contact.last_call || contact.last_called || contact.updated_on) || 'Never',
    notes: '',
    context: { text: '', urls: [], files: [] },
    providerIds: cleanObject({
      calltoolsContactId: id,
      calltoolsCampaignId: safeLeadText(campaign.id),
      calltoolsSourceKind: sourceKind,
      calltoolsSourceId: safeLeadText(source.id),
      calltoolsSystemDisposition: safeLeadText(contact.system_disposition),
      calltoolsDisposition: safeLeadText(contact.disposition_name || contact.disposition),
      calltoolsCallDisposition: safeLeadText(contact.call_disposition_name || contact.call_disposition),
      calltoolsOwner: safeLeadText(contact.owned_by_name || contact.owned_by),
    }),
  })
}

function firstPhone(contact = {}) {
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

function callToolsPhoneNumberContactId(phoneNumber = {}) {
  return safeLeadText(
    phoneNumber.contact?.id ||
      phoneNumber.contact_id ||
      phoneNumber.contact ||
      phoneNumber.contactId,
  )
}

function mergeCallToolsPhoneNumbers(contact = {}, phoneNumbers = []) {
  if (!phoneNumbers.length) return contact
  const existingPhoneNumbers = Array.isArray(contact._phone_numbers)
    ? contact._phone_numbers
    : Array.isArray(contact.phone_numbers)
      ? contact.phone_numbers
      : []
  const seen = new Set()
  const mergedPhoneNumbers = []
  for (const phoneNumber of [...existingPhoneNumbers, ...phoneNumbers]) {
    const normalized = firstPhone({ _phone_numbers: [phoneNumber] })
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    mergedPhoneNumbers.push(phoneNumber)
  }
  if (!mergedPhoneNumbers.length) return contact
  return {
    ...contact,
    _phone_numbers: mergedPhoneNumbers,
  }
}

function firstEmail(contact = {}) {
  const direct = cleanEmail(contact.email || contact.email_address)
  if (direct) return direct
  const emails = Array.isArray(contact.email_addresses) ? contact.email_addresses : []
  for (const email of emails) {
    const normalized = cleanEmail(email.email || email.email_address || email.address)
    if (normalized) return normalized
  }
  return ''
}

function callToolsContactTags(contact = {}) {
  const tags = Array.isArray(contact.tags) ? contact.tags : []
  return [
    'CallTools',
    ...tags
      .map((tag) => safeLeadText(tag.name || tag.label || tag))
      .filter(Boolean),
  ]
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

function boundedPositiveInteger(value, fallback, min, max) {
  const number = Number(value || fallback)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, Math.floor(number)))
}

function callToolsSyncError(message, statusCode, code) {
  return Object.assign(new Error(message), { statusCode, code })
}
