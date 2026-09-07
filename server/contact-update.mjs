import { normalizeLead } from './call-state.mjs'
import { patchWorkspaceLeadWithProof } from './workspace-store.mjs'

export async function executeContactUpdatePersistence({
  lead,
  patch = {},
  transient = false,
} = {}) {
  const nextLead = normalizeLead({ ...lead, ...patch })
  const contactId = String(nextLead.id || '').trim()

  if (transient) {
    return {
      ok: false,
      reason: 'contact_persistence_unavailable',
      assistant_next_step:
        'Do not claim the contact was updated because durable persistence is unavailable.',
    }
  }
  if (!contactId) {
    return {
      ok: false,
      reason: 'contact_id_missing',
      assistant_next_step:
        'Do not claim the contact was updated because no durable contact ID is available.',
    }
  }

  try {
    const persisted = await patchWorkspaceLeadWithProof(contactId, nextLead)
    return {
      ok: true,
      lead: persisted.lead,
      proof: persisted.proof,
    }
  } catch {
    return {
      ok: false,
      reason: 'contact_persistence_failed',
      assistant_next_step:
        'Do not claim the contact was updated because durable persistence failed.',
    }
  }
}
