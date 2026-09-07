import { safeLeadText } from './runtime-config.mjs'

export function isTransientWorkspaceLead(lead = {}) {
  const id = safeLeadText(lead.id)
  const sourceId = safeLeadText(lead.sourceId)
  return (
    id === 'config-phone-test-ad-hoc' ||
    id.startsWith('calltools-contact-proof-') ||
    id.startsWith('real-calltools-proof-') ||
    sourceId.startsWith('calltools:proof:')
  )
}

export function conversationMemoryContactIdForLead(lead = {}) {
  return isTransientWorkspaceLead(lead) ? '' : safeLeadText(lead.id)
}
