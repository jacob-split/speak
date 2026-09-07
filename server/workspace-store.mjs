import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  normalizeConfigurationTestVariables,
  normalizeLead,
} from './call-state.mjs'
import {
  contextHasContent,
  normalizeContextFields,
  prepareRuntimeContextFields,
} from './context-fields.mjs'
import {
  cleanEmail,
  cleanName,
  cleanObject,
  normalizeCallToolsAgentBinding,
  normalizeCampaignConfig,
  normalizePhone,
  safeLeadText,
} from './runtime-config.mjs'
import { normalizeEmotionScores } from './hume-emotion-scores.mjs'
import { isTransientWorkspaceLead } from './transient-workspace-lead.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const workspaceDataDir = path.resolve(
  __dirname,
  '..',
  process.env.SPEAK_WORKSPACE_DATA_DIR || 'workspace-data',
)
const workspaceFilePath = path.join(workspaceDataDir, 'workspace.json')
const workspaceVersion = 7
let workspaceMutationQueue = Promise.resolve()
let workspaceCache = null
const workspaceStorageStats = {
  cacheHits: 0,
  cacheMisses: 0,
  diskReads: 0,
  normalizations: 0,
  externalInvalidations: 0,
  writes: 0,
}

const leadStatuses = new Set([
  'ready',
  'calling',
  'follow-up',
  'no-answer',
  'voicemail',
  'not-interested',
  'skipped',
  'failed',
  'do-not-call',
])

const communicationChannels = new Set([
  'call',
  'sms',
  'email',
  'browser_test',
  'operator_chat',
  'tool',
  'system',
])
const communicationModalities = new Set(['voice', 'text', 'audio', 'tool', 'status', 'attachment'])
const communicationDirections = new Set(['inbound', 'outbound', 'internal', 'system'])
const communicationRoles = new Set(['contact', 'agent', 'operator', 'tool', 'system'])
const communicationThreadStatuses = new Set([
  'open',
  'waiting',
  'resolved',
  'archived',
  'unresolved_attribution',
])
const communicationIdentityKinds = new Set([
  'phone',
  'email',
  'provider_contact',
  'external_thread',
])
const communicationIdentityConfidence = new Set(['verified', 'probable', 'unresolved'])

export async function workspaceSnapshot() {
  return publicWorkspace(await readWorkspace())
}

export function workspaceStorageDiagnostics() {
  return {
    ...workspaceStorageStats,
    cached: Boolean(workspaceCache),
    fingerprint: workspaceCache?.fingerprint?.key || '',
  }
}

export async function searchWorkspace(filters = {}) {
  const workspace = await readWorkspace()
  const query = safeLeadText(filters.q || filters.query).trim().toLowerCase()
  const limit = boundedLimit(filters.limit, 24, 100)
  const leadById = new Map(workspace.leads.map((lead) => [lead.id, lead]))
  const threads = [...workspace.communicationThreads]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  const leadCandidates = query ? workspace.leads : workspace.leads.slice(0, limit)
  const threadCandidates = query ? threads : threads.slice(0, Math.min(limit, 24))

  const results = [
    ...leadCandidates.flatMap((lead) => {
      const score = workspaceSearchScore(
        [
          lead.company,
          lead.name,
          lead.email,
          lead.state,
          lead.status,
          lead.lastCall,
          lead.notes,
          workspaceContextSearchText(lead.context),
          lead.tags?.join(' '),
          lead.source,
          lead.sourceName,
        ].join(' '),
        query,
      )
      if (!score) return []
      return [{
        id: `lead:${lead.id}`,
        kind: 'lead',
        leadId: lead.id,
        title: lead.company || lead.name || 'Unknown business',
        subtitle: lead.name && lead.name !== lead.company ? lead.name : lead.status,
        detail: lead.sourceName || lead.lastCall || 'No calls yet',
        score,
      }]
    }),
    ...workspace.profiles.flatMap((profile) => {
      const score = workspaceSearchScore(
        [
          profile.name,
          profile.config?.voice,
          profile.config?.humeConfigId,
          profile.config?.speakConfigId,
          profile.config?.smartViewId,
          profile.config?.instructions,
          workspaceContextSearchText(profile.context),
        ].join(' '),
        query,
      )
      if (!score) return []
      return [{
        id: `profile:${profile.id}`,
        kind: 'profile',
        profileId: profile.id,
        title: profile.name || 'Untitled agent',
        subtitle: profile.config?.smartViewId ? 'Assigned Smart View' : 'Agent profile',
        detail: profile.updatedAt,
        score,
        profile,
      }]
    }),
    ...workspace.smartViews.flatMap((smartView) => {
      const score = workspaceSearchScore(
        [
          smartView.name,
          smartView.source,
          smartView.sourceId,
          smartView.sourceUrl,
          smartView.externalUrl,
          smartView.syncedAt,
          smartView.filters?.query,
          smartView.filters?.statusFilter,
          smartView.filters?.stateFilter,
          smartView.filters?.tagFilter,
        ].join(' '),
        query,
      )
      if (!score) return []
      return [{
        id: `smart-view:${smartView.id}`,
        kind: 'smart-view',
        smartViewId: smartView.id,
        title: smartView.name,
        subtitle: smartView.source === 'csv' ? 'CSV Smart View' : 'Filtered Smart View',
        detail: `${smartView.leadCount} contacts`,
        score,
      }]
    }),
    ...threadCandidates.flatMap((thread) => {
      const lead = thread.contactId ? leadById.get(thread.contactId) : null
      const contactLabel =
        thread.participants?.find((participant) => participant.role === 'contact')?.label ||
        lead?.company ||
        lead?.name ||
        thread.contactId ||
        'Communication thread'
      const channelLabel = thread.channels?.join(', ') || 'communication'
      const score = workspaceSearchScore(
        [
          contactLabel,
          thread.threadId,
          thread.contactId,
          channelLabel,
          thread.status,
          thread.summary,
          thread.latestMessagePreview,
          lead?.company,
          lead?.name,
          lead?.email,
          workspaceContextSearchText(lead?.context),
        ].join(' '),
        query,
      )
      if (!score) return []
      return [{
        id: `thread:${thread.threadId}`,
        kind: 'thread',
        threadId: thread.threadId,
        title: contactLabel,
        subtitle: `${channelLabel} / ${thread.updatedAt || 'Communication thread'}`,
        detail: thread.summary || thread.latestMessagePreview || channelLabel,
        score,
      }]
    }),
  ].sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))

  return {
    schemaVersion: 'speak.workspace-search.v1',
    query,
    limit,
    totalCandidates: {
      leads: workspace.leads.length,
      profiles: workspace.profiles.length,
      smartViews: workspace.smartViews.length,
      threads: workspace.communicationThreads.length,
    },
    resultCount: Math.min(results.length, limit),
    truncated: results.length > limit,
    results: results.slice(0, limit),
  }
}

export async function readWorkspaceDialerState() {
  const workspace = await readWorkspace()
  return {
    dialerState: workspace.dialerState,
  }
}

export async function patchWorkspaceDialerState(patch = {}) {
  return mutateWorkspace(async (workspace) => {
    workspace.dialerState = applyWorkspaceDialerStatePatch(
      workspace.dialerState,
      patch,
    )
    return {
      dialerState: workspace.dialerState,
    }
  })
}

export async function readWorkspaceCallToolsDuty() {
  const workspace = await readWorkspace()
  return {
    calltoolsDuty: workspace.dialerState.calltoolsDuty,
    dialerState: workspace.dialerState,
  }
}

export async function transitionWorkspaceCallToolsDuty({
  expectedLeaseId,
  patch = {},
} = {}) {
  return mutateWorkspace(async (workspace) => {
    const currentState = normalizeWorkspaceDialerState(workspace.dialerState)
    const currentDuty = currentState.calltoolsDuty
    if (
      expectedLeaseId !== undefined &&
      safeLeadText(expectedLeaseId) !== currentDuty.leaseId
    ) {
      return {
        applied: false,
        calltoolsDuty: currentDuty,
        dialerState: currentState,
      }
    }

    const dutyPatch = patch && typeof patch === 'object' ? { ...patch } : {}
    const requestedDialerSourceId = safeLeadText(dutyPatch.dialerSourceId)
    delete dutyPatch.dialerSourceId
    const calltoolsDuty = normalizeWorkspaceCallToolsDuty({
      ...currentDuty,
      ...dutyPatch,
    })
    const active = workspaceCallToolsDutyActive(calltoolsDuty)
    const dialerSourceId =
      active && workspaceDialerStateUsesCallTools(requestedDialerSourceId)
        ? requestedDialerSourceId
        : currentState.sourceId
    workspace.dialerState = normalizeWorkspaceDialerState({
      ...currentState,
      calltoolsDuty,
      campaignRunning: active,
      controllerHeartbeatAt: active ? currentState.controllerHeartbeatAt : '',
      controllerId: active ? currentState.controllerId : '',
      sourceId: dialerSourceId,
      updatedAt: new Date().toISOString(),
    })
    return {
      applied: true,
      calltoolsDuty: workspace.dialerState.calltoolsDuty,
      dialerState: workspace.dialerState,
    }
  })
}

export async function listCommunicationThreads(filters = {}) {
  const workspace = await readWorkspace()
  const limit = boundedLimit(filters.limit, 50, 500)
  const cursor = safeLeadText(filters.cursor)
  const channels = normalizeFlexibleStringList(filters.channels || filters.channel)
  const channelSet = new Set(channels)
  let threads = workspace.communicationThreads
    .map((thread) => hydrateCommunicationThreadMetrics(workspace, thread))
    .filter((thread) => !filters.contactId || thread.contactId === safeLeadText(filters.contactId))
    .filter((thread) => !filters.agentProfileId || thread.agentProfileId === safeLeadText(filters.agentProfileId))
    .filter((thread) => !filters.status || thread.status === safeLeadText(filters.status))
    .filter((thread) => !filters.updatedAfter || thread.updatedAt > safeLeadText(filters.updatedAfter))
    .filter((thread) => {
      if (!channelSet.size) return true
      return thread.channels.some((channel) => channelSet.has(channel))
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  const startIndex = cursor
    ? Math.max(0, threads.findIndex((thread) => thread.threadId === cursor) + 1)
    : 0
  threads = threads.slice(startIndex, startIndex + limit + 1)
  const nextCursor = threads.length > limit ? threads[limit - 1]?.threadId || '' : ''
  return {
    schemaVersion: 'speak.communication-threads.v1',
    threads: threads.slice(0, limit),
    nextCursor,
    total: workspace.communicationThreads.length,
  }
}

export async function readCommunicationThread(threadId) {
  const workspace = await readWorkspace()
  const id = safeLeadText(threadId)
  const thread = workspace.communicationThreads.find((item) => item.threadId === id)
  if (!thread) return null
  return {
    schemaVersion: 'speak.communication-thread.v1',
    thread: hydrateCommunicationThreadMetrics(workspace, thread),
  }
}

export async function listCommunicationThreadMessages(threadId, filters = {}) {
  const workspace = await readWorkspace()
  const id = safeLeadText(threadId)
  const limit = boundedLimit(filters.limit, 100, 500)
  const cursor = safeLeadText(filters.cursor)
  let messages = workspace.communicationMessages
    .filter((message) => message.threadId === id)
    .sort((left, right) => left.at.localeCompare(right.at) || left.messageId.localeCompare(right.messageId))
  const startIndex = cursor
    ? Math.max(0, messages.findIndex((message) => message.messageId === cursor) + 1)
    : 0
  messages = messages.slice(startIndex, startIndex + limit + 1)
  const nextCursor = messages.length > limit ? messages[limit - 1]?.messageId || '' : ''
  return {
    schemaVersion: 'speak.communication-messages.v1',
    threadId: id,
    messages: messages.slice(0, limit),
    nextCursor,
  }
}

export async function readContactCommunicationMemory({ contactId, limit = 3 } = {}) {
  const workspace = await readWorkspace()
  const id = safeLeadText(contactId)
  if (!id) return []
  return communicationMemoryForWorkspace(workspace, id, limit)
}

export async function resolveCommunicationEventContext(event = {}) {
  const workspace = await readWorkspace()
  const normalized = normalizeCommunicationEvent(event, workspace)
  if (!normalized) return null
  const existingThread = workspace.communicationThreads.find(
    (thread) => thread.threadId === normalized.threadId,
  )
  const lead = workspace.leads.find((item) => item.id === normalized.contactId) ||
    normalized.lead ||
    {}
  const agentProfileId =
    normalized.agentProfileId ||
    existingThread?.agentProfileId ||
    workspace.activeProfileId ||
    ''
  const profile =
    resolveWorkspaceProfileForAgentProfileId(workspace.profiles, agentProfileId) ||
    workspace.profiles[0] ||
    null
  return {
    communication: normalized,
    lead,
    profile,
    thread: existingThread || null,
  }
}

export async function recordCommunicationEvent(event = {}) {
  const result = await recordCommunicationEvents([event])
  return result.events[0] || null
}

export async function recordCommunicationEvents(events = []) {
  const candidates = Array.isArray(events) ? events : []
  return mutateWorkspace(async (workspace) => {
    const applied = []
    for (const event of candidates) {
      const normalized = normalizeCommunicationEvent(event, workspace)
      if (!normalized) continue
      upsertContactIdentityLinks(workspace, normalized)
      const thread = upsertCommunicationThread(workspace, normalized)
      const { message, removedThreadIds } = upsertCommunicationMessage(workspace, normalized, thread)
      const topics = rebuildThreadMaterializedState(workspace, thread.threadId)
      removedThreadIds.forEach((threadId) => rebuildOrRemoveCommunicationThread(workspace, threadId))
      applied.push({
        schemaVersion: 'speak.communication-event.v1',
        thread: workspace.communicationThreads.find((item) => item.threadId === thread.threadId),
        message,
        topics,
      })
    }
    return {
      schemaVersion: 'speak.communication-event-batch.v1',
      events: applied,
    }
  })
}

export async function recordCommunicationCallSummary(summary = {}) {
  const transcript = Array.isArray(summary.transcript) ? summary.transcript : []
  const summaryCallControlId = safeLeadText(summary.callControlId)
  const summaryLeadId = safeLeadText(summary.lead?.id)
  const summaryOrigin = safeLeadText(summary.origin)
  const channel =
    summary.agent?.browserTest ||
    summaryOrigin === 'playground_browser' ||
    summaryOrigin === 'playground_phone' ||
    summaryCallControlId.startsWith('test-') ||
    summaryLeadId.startsWith('test-')
      ? 'browser_test'
      : 'call'
  let latest = null
  for (const turn of transcript) {
    latest = await recordCommunicationEvent({
      callControlId: summary.callControlId,
      chatId: summary.chatId,
      channel,
      lead: summary.lead,
      agent: summary.agent,
      createdAt: summary.createdAt,
      event: {
        entry: {
          id: turn.id || stableCommunicationId('backfill', summary.callControlId, turn.at, turn.speaker, turn.text),
          at: turn.at || summary.updatedAt || summary.createdAt,
          speaker: turn.speaker,
          text: turn.text,
          tone: turn.tone || 'neutral',
          emotionScores: turn.emotionScores,
          providerEventId: turn.providerEventId,
        },
        patch: {
          phase: summary.phase,
          outcome: summary.outcome,
          chatId: summary.chatId,
        },
      },
    })
  }
  return latest
}

export async function rebuildCommunicationThreadSummary(threadId) {
  return mutateWorkspace(async (workspace) => {
    const id = safeLeadText(threadId)
    const thread = workspace.communicationThreads.find((item) => item.threadId === id)
    if (!thread) return null
    const topics = rebuildThreadMaterializedState(workspace, id)
    return {
      schemaVersion: 'speak.communication-thread-rebuild.v1',
      thread: workspace.communicationThreads.find((item) => item.threadId === id),
      topics,
    }
  })
}

export async function repairWorkspaceEmailMailboxThreadIdentity({
  apply = false,
  mailboxEmail = '',
} = {}) {
  const normalizedMailboxEmail = cleanEmail(mailboxEmail)
  if (!normalizedMailboxEmail) {
    return {
      schemaVersion: 'speak.workspace-email-thread-identity-repair.v1',
      ok: false,
      mode: apply ? 'apply' : 'dry-run',
      mailboxEmail: '',
      scannedThreads: 0,
      repairableThreads: 0,
      movedMessages: 0,
      repairs: [],
      failures: ['mailboxEmail is required.'],
    }
  }

  if (!apply) {
    const workspace = await readWorkspace()
    return workspaceEmailMailboxThreadIdentityRepairReport(workspace, normalizedMailboxEmail, {
      mode: 'dry-run',
    })
  }

  return mutateWorkspace(async (workspace) => {
    const report = workspaceEmailMailboxThreadIdentityRepairReport(workspace, normalizedMailboxEmail, {
      mode: 'apply',
    })
    if (report.failures.length) return report
    applyWorkspaceEmailMailboxThreadIdentityRepair(workspace, report.repairs)
    const appliedReport = workspaceEmailMailboxThreadIdentityRepairReport(workspace, normalizedMailboxEmail, {
      mode: 'apply',
    })
    return {
      ...report,
      ok: appliedReport.repairableThreads === 0,
      applied: report.repairableThreads,
      remainingRepairableThreads: appliedReport.repairableThreads,
      failures: appliedReport.repairableThreads === 0
        ? []
        : ['Workspace email mailbox-thread identity repair left repairable threads behind.'],
    }
  })
}

export async function repairDuplicateCommunicationSourceMessages({
  apply = false,
} = {}) {
  if (!apply) {
    const workspace = await readWorkspace()
    return communicationSourceDedupRepairReport(workspace, { mode: 'dry-run' })
  }

  return mutateWorkspace(async (workspace) => {
    const report = communicationSourceDedupRepairReport(workspace, { mode: 'apply' })
    if (report.failures.length) return report
    applyCommunicationSourceDedupRepair(workspace, report.repairs)
    const appliedReport = communicationSourceDedupRepairReport(workspace, { mode: 'apply' })
    return {
      ...report,
      ok: appliedReport.duplicateGroups === 0,
      applied: report.removedMessages,
      remainingDuplicateGroups: appliedReport.duplicateGroups,
      failures: appliedReport.duplicateGroups === 0
        ? []
        : ['Communication source dedup repair left duplicate provider source messages behind.'],
    }
  })
}

export async function repairDefaultOffInboundCallMessages({
  apply = false,
} = {}) {
  if (!apply) {
    const workspace = await readWorkspace()
    return defaultOffInboundCallRepairReport(workspace, { mode: 'dry-run' })
  }

  return mutateWorkspace(async (workspace) => {
    const report = defaultOffInboundCallRepairReport(workspace, { mode: 'apply' })
    if (report.failures.length) return report
    applyDefaultOffInboundCallRepair(workspace, report.repairs)
    const appliedReport = defaultOffInboundCallRepairReport(workspace, { mode: 'apply' })
    return {
      ...report,
      ok: appliedReport.repairableMessages === 0,
      applied: report.repairableMessages,
      remainingRepairableMessages: appliedReport.repairableMessages,
      failures: appliedReport.repairableMessages === 0
        ? []
        : ['Default-off inbound call repair left repairable messages behind.'],
    }
  })
}

export async function replaceWorkspaceLeads({
  leads,
  deletedLeadIds,
  deletedLeadFingerprints,
} = {}) {
  return mutateWorkspace(async (workspace) => {
    workspace.leads = normalizeLeadList(leads)
    workspace.deletedLeadIds = normalizeStringList(deletedLeadIds)
    workspace.deletedLeadFingerprints = normalizeStringList(deletedLeadFingerprints)
  })
}

export async function listWorkspaceLeads(filters = {}) {
  const workspace = await readWorkspace()
  const hasFilters = Object.keys(filters || {}).some((key) => filters[key] !== undefined)
  if (!hasFilters) {
    return {
      leads: workspace.leads,
      deletedLeadIds: workspace.deletedLeadIds,
      deletedLeadFingerprints: workspace.deletedLeadFingerprints,
    }
  }

  const query = safeLeadText(filters.q || filters.query).trim().toLowerCase()
  const source = safeLeadText(filters.source).trim()
  const sourceId = safeLeadText(filters.sourceId).trim()
  const smartViewId = safeLeadText(filters.smartViewId).trim()
  const limit = boundedLimit(filters.limit, 100, 500)
  const requestedIds = parseLeadIdFilter(filters.ids)
  const includeIds = parseLeadIdFilter(filters.includeIds)
  const requestedIdSet = new Set(requestedIds)
  const includeIdSet = new Set(includeIds)
  const smartView = smartViewId
    ? workspace.smartViews.find((view) => view.id === smartViewId)
    : null
  const smartViewLeadIds = smartView ? new Set(smartView.leadIds || []) : null
  const leadById = new Map(workspace.leads.map((lead) => [lead.id, lead]))
  const sourceCandidates = workspace.leads.filter((lead) => {
    if (requestedIdSet.size > 0 && !requestedIdSet.has(lead.id)) return false
    if (source && lead.source !== source) return false
    if (sourceId && lead.sourceId !== sourceId) return false
    if (smartViewLeadIds && !smartViewLeadIds.has(lead.id)) return false
    return true
  })
  const matchedLeads = query
    ? sourceCandidates.filter((lead) => workspaceLeadMatchesQuery(lead, query))
    : sourceCandidates
  const leads = matchedLeads.slice(0, limit)

  if (includeIdSet.size > 0) {
    includeIds.forEach((id) => {
      if (leads.some((lead) => lead.id === id)) return
      const lead = leadById.get(id)
      if (!lead) return
      if (source && lead.source !== source) return
      if (sourceId && lead.sourceId !== sourceId) return
      if (smartViewLeadIds && !smartViewLeadIds.has(lead.id)) return
      leads.unshift(lead)
    })
  }

  return {
    leads,
    deletedLeadIds: workspace.deletedLeadIds,
    deletedLeadFingerprints: workspace.deletedLeadFingerprints,
    limit,
    resultCount: leads.length,
    totalMatching: matchedLeads.length,
    totalLeads: workspace.leads.length,
    truncated: matchedLeads.length > limit,
  }
}

export async function createWorkspaceLead(lead = {}) {
  return mutateWorkspace(async (workspace) => {
    const source = normalizeLeadSource(lead.source)
    const generatedIdPrefix = source && source !== 'manual' ? source : 'manual'
    const created = normalizeWorkspaceLead({
      id: lead.id || `${generatedIdPrefix}-${randomUUID()}`,
      firstName: 'New',
      lastName: 'lead',
      name: 'New lead',
      company: 'Business name',
      phone: '+1',
      email: '',
      state: 'NC',
      tags: [],
      score: 70,
      status: 'ready',
      lastCall: 'Never',
      notes: '',
      context: {},
      ...lead,
    })
    workspace.leads = [
      created,
      ...workspace.leads.filter((item) => item.id !== created.id),
    ]
    return created
  })
}

export async function importWorkspaceLeads(leads = []) {
  return mutateWorkspace(async (workspace) => {
    const imported = normalizeLeadList(leads).filter(
      (lead) => !isDeletedLead(lead, workspace),
    )
    const importedIds = new Set(imported.map((lead) => lead.id))
    workspace.leads = [
      ...imported,
      ...workspace.leads.filter((lead) => !importedIds.has(lead.id)),
    ]
    return { imported, leads: workspace.leads }
  })
}

export async function listWorkspaceSmartViews() {
  const workspace = await readWorkspace()
  return {
    contactSources: summarizeWorkspaceContactSources(workspace),
    smartViews: workspace.smartViews,
  }
}

export async function upsertWorkspaceSmartView(smartView = {}) {
  return mutateWorkspace(async (workspace) => {
    const nextSmartView = normalizeWorkspaceSmartView(smartView)
    workspace.smartViews = [
      nextSmartView,
      ...workspace.smartViews.filter((item) => item.id !== nextSmartView.id),
    ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    return {
      smartView: nextSmartView,
      smartViews: workspace.smartViews,
    }
  })
}

export async function importWorkspaceSmartViewLeads({ name, leads } = {}) {
  const smartViewName = name || 'Imported Smart View'
  const sourceId = `csv:${stableSourceKey(smartViewName || new Date().toISOString()) || randomUUID()}`
  const result = await importWorkspaceSourceLeads({
    name: smartViewName,
    source: 'csv',
    sourceId,
    leads,
  })
  const smartViewResult = await upsertWorkspaceSmartView({
    name: smartViewName,
    source: 'filters',
    sourceId,
    leadIds: result.imported.map((lead) => lead.id),
    filters: {
      query: '',
      statusFilter: 'all',
      stateFilter: 'all',
      scoreFilter: 'all',
      tagFilter: 'all',
      sortField: 'score',
      sortDirection: 'desc',
    },
  })
  return {
    ...result,
    smartView: smartViewResult.smartView,
    smartViews: smartViewResult.smartViews,
  }
}

export async function importWorkspaceSourceLeads({
  name,
  source = 'filters',
  sourceId = '',
  sourceUrl = '',
  externalUrl = '',
  syncedAt = '',
  leads,
} = {}) {
  return mutateWorkspace(async (workspace) => {
    const normalizedSource = normalizeLeadSource(source) || 'manual'
    const sourceSyncedAt = syncedAt || new Date().toISOString()
    const sourceName = safeLeadText(name || 'Imported Smart View')
    const existingById = new Map(workspace.leads.map((lead) => [lead.id, lead]))
    const imported = normalizeLeadList(leads)
      .filter((lead) => !isDeletedLead(lead, workspace))
      .map((lead) => {
        const existing = existingById.get(lead.id)
        return mergeSourceLead(
          existing,
          normalizeWorkspaceLead({
            ...lead,
            source: normalizedSource,
            sourceId,
            sourceName,
            sourceUrl,
            externalUrl,
            sourceSyncedAt,
          }),
        )
      })
    const importedIds = new Set(imported.map((lead) => lead.id))
    workspace.leads = [
      ...imported,
      ...workspace.leads.filter((lead) => !importedIds.has(lead.id)),
    ]
    const contactSource = normalizeWorkspaceContactSource({
      source: normalizedSource,
      sourceId,
      sourceName,
      sourceUrl,
      externalUrl,
      sourceSyncedAt,
      leadIds: imported.map((lead) => lead.id),
    })
    return {
      imported,
      leads: workspace.leads,
      contactSource: publicWorkspaceContactSource(contactSource),
      contactSources: summarizeWorkspaceContactSources(workspace),
      smartViews: workspace.smartViews,
    }
  })
}

export async function deleteWorkspaceSmartView(smartViewId) {
  return mutateWorkspace(async (workspace) => {
    workspace.smartViews = workspace.smartViews.filter(
      (smartView) => smartView.id !== smartViewId,
    )
    workspace.profiles = workspace.profiles.map((profile) => {
      if (profile.config?.smartViewId !== smartViewId) return profile
      return normalizeWorkspaceProfile({
        ...profile,
        config: {
          ...profile.config,
          smartViewId: '',
        },
      })
    })
    return {
      smartViews: workspace.smartViews,
      profiles: workspace.profiles,
      activeProfileId: workspace.activeProfileId,
    }
  })
}

export async function patchWorkspaceLead(leadId, patch = {}) {
  return mutateWorkspace(async (workspace) => {
    const previous = workspace.leads.find((lead) => lead.id === leadId) || null
    let patched = null
    workspace.leads = workspace.leads.map((lead) => {
      if (lead.id !== leadId) return lead
      patched = normalizeWorkspaceLead({ ...lead, ...patch, id: lead.id })
      return patched
    })
    if (!patched) {
      patched = normalizeWorkspaceLead({ id: leadId, ...patch })
      workspace.leads = [patched, ...workspace.leads]
    }
    reconcileWorkspaceLeadIdentityLinks(workspace, previous, patched)
    return patched
  })
}

export async function patchWorkspaceLeadWithProof(leadId, patch = {}) {
  const patched = await patchWorkspaceLead(leadId, patch)
  const snapshot = await workspaceSnapshot()
  const readback = snapshot.leads.find((lead) => lead.id === patched.id)
  if (!readback) {
    throw new Error(`Workspace contact ${patched.id} was not found after persistence`)
  }

  const fields = Object.keys(patch).filter((field) => field !== 'id')
  const mismatchedFields = fields.filter(
    (field) => JSON.stringify(readback[field]) !== JSON.stringify(patched[field]),
  )
  if (mismatchedFields.length > 0) {
    throw new Error(
      `Workspace contact ${patched.id} readback mismatch: ${mismatchedFields.join(', ')}`,
    )
  }

  return {
    lead: readback,
    proof: {
      contactId: readback.id,
      persisted: true,
      fields,
      workspaceUpdatedAt: snapshot.updatedAt,
    },
  }
}

export async function bulkPatchWorkspaceLeads(ids = [], patch = {}) {
  return mutateWorkspace(async (workspace) => {
    const idSet = new Set(normalizeStringList(ids))
    const patched = []
    workspace.leads = workspace.leads.map((lead) => {
      if (!idSet.has(lead.id)) return lead
      const next = normalizeWorkspaceLead({ ...lead, ...patch, id: lead.id })
      patched.push(next)
      return next
    })
    return { patched, leads: workspace.leads }
  })
}

export async function deleteWorkspaceLeads(ids = []) {
  return mutateWorkspace(async (workspace) => {
    const idSet = new Set(normalizeStringList(ids))
    const deleted = workspace.leads.filter((lead) => idSet.has(lead.id))
    const deletedIds = new Set(workspace.deletedLeadIds)
    const deletedFingerprints = new Set(workspace.deletedLeadFingerprints)
    deleted.forEach((lead) => {
      deletedIds.add(lead.id)
      leadFingerprints(lead).forEach((fingerprint) => {
        deletedFingerprints.add(fingerprint)
      })
    })
    workspace.deletedLeadIds = Array.from(deletedIds)
    workspace.deletedLeadFingerprints = Array.from(deletedFingerprints)
    workspace.leads = workspace.leads.filter((lead) => !idSet.has(lead.id))
    workspace.smartViews = workspace.smartViews.map((smartView) =>
      normalizeWorkspaceSmartView({
        ...smartView,
        leadIds: smartView.leadIds.filter((leadId) => !idSet.has(leadId)),
      }),
    )
    return { deleted, leads: workspace.leads }
  })
}

export async function listWorkspaceProfiles() {
  const workspace = await readWorkspace()
  return {
    profiles: workspace.profiles,
    activeProfileId: workspace.activeProfileId,
  }
}

export async function replaceWorkspaceProfiles({
  profiles,
  activeProfileId,
  preserveActiveProfile = false,
} = {}) {
  return mutateWorkspace(async (workspace) => {
    const currentActiveProfileId = workspace.activeProfileId
    const currentActiveProfile = workspace.profiles.find(
      (profile) => profile.id === currentActiveProfileId,
    )
    const nextProfiles = normalizeProfileList(profiles)
    if (
      preserveActiveProfile &&
      currentActiveProfile &&
      !nextProfiles.some((profile) => profile.id === currentActiveProfileId)
    ) {
      nextProfiles.push(currentActiveProfile)
    }
    assertActiveCallToolsProfileMutationAllowed(workspace, nextProfiles, {
      operation: 'replace profiles',
    })
    assertUniqueProfileAssignments(nextProfiles)
    workspace.profiles = nextProfiles
    workspace.activeProfileId = normalizeActiveProfileId(
      preserveActiveProfile ? currentActiveProfileId : activeProfileId,
      workspace.profiles,
    )
    return {
      profiles: workspace.profiles,
      activeProfileId: workspace.activeProfileId,
    }
  })
}

export async function upsertWorkspaceProfile(profile = {}) {
  return mutateWorkspace(async (workspace) => {
    const nextProfile = normalizeWorkspaceProfile(profile)
    const nextProfiles = [
      nextProfile,
      ...workspace.profiles.filter((item) => item.id !== nextProfile.id),
    ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    assertActiveCallToolsProfileMutationAllowed(workspace, nextProfiles, {
      operation: 'update profile',
    })
    assertUniqueProfileAssignments(nextProfiles)
    workspace.profiles = nextProfiles
    if (!workspace.activeProfileId) workspace.activeProfileId = nextProfile.id
    return nextProfile
  })
}

export async function deleteWorkspaceProfile(profileId) {
  return mutateWorkspace(async (workspace) => {
    const nextProfiles = workspace.profiles.filter((profile) => profile.id !== profileId)
    assertActiveCallToolsProfileMutationAllowed(workspace, nextProfiles, {
      operation: 'delete profile',
    })
    workspace.profiles = nextProfiles
    if (workspace.activeProfileId === profileId) {
      workspace.activeProfileId = workspace.profiles[0]?.id || ''
    }
    return {
      profiles: workspace.profiles,
      activeProfileId: workspace.activeProfileId,
    }
  })
}

export function assertActiveCallToolsProfileMutationAllowed(
  workspace = {},
  nextProfiles = [],
  { operation = 'change profile' } = {},
) {
  const duty = normalizeWorkspaceCallToolsDuty(
    workspace?.dialerState?.calltoolsDuty || {},
  )
  if (!workspaceCallToolsDutyActive(duty)) return true

  const leasedProfileId = safeLeadText(duty.profileId)
  const currentProfile = (Array.isArray(workspace.profiles) ? workspace.profiles : [])
    .find((profile) => safeLeadText(profile?.id) === leasedProfileId)
  const nextProfile = (Array.isArray(nextProfiles) ? nextProfiles : [])
    .find((profile) => safeLeadText(profile?.id) === leasedProfileId)
  if (!leasedProfileId || !currentProfile || !nextProfile) {
    throw activeCallToolsProfileLockError({
      changedFields: ['profile'],
      leasedProfileId,
      operation,
    })
  }

  const currentAssignment = protectedCallToolsProfileAssignment(currentProfile)
  const nextAssignment = protectedCallToolsProfileAssignment(nextProfile)
  const changedFields = []
  Object.keys(currentAssignment.calltoolsAgentBinding).forEach((field) => {
    if (
      currentAssignment.calltoolsAgentBinding[field] !==
      nextAssignment.calltoolsAgentBinding[field]
    ) {
      changedFields.push(`calltoolsAgentBinding.${field}`)
    }
  })
  if (changedFields.length) {
    throw activeCallToolsProfileLockError({
      changedFields,
      leasedProfileId,
      operation,
    })
  }
  return true
}

function protectedCallToolsProfileAssignment(profile = {}) {
  const config = profile?.config && typeof profile.config === 'object'
    ? profile.config
    : {}
  const binding = normalizeCallToolsAgentBinding(config.calltoolsAgentBinding || {})
  return {
    calltoolsAgentBinding: {
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
    },
  }
}

function activeCallToolsProfileLockError({
  changedFields = [],
  leasedProfileId = '',
  operation = 'change profile',
} = {}) {
  return Object.assign(
    new Error(
      `The active CallTools agent profile cannot ${operation} while it is Available. Go unavailable first.`,
    ),
    {
      status: 409,
      code: 'calltools_active_profile_locked',
      profileId: safeLeadText(leasedProfileId),
      changedFields: [...new Set(changedFields.map((field) => safeLeadText(field)))],
    },
  )
}

export async function setActiveWorkspaceProfile(profileId) {
  return mutateWorkspace(async (workspace) => {
    workspace.activeProfileId = normalizeActiveProfileId(profileId, workspace.profiles)
    return {
      profiles: workspace.profiles,
      activeProfileId: workspace.activeProfileId,
    }
  })
}

function assertUniqueProfileAssignments(profiles = []) {
  assertPersonalPhoneInboundSourceCompatibility(profiles)
  const assigned = new Map()
  profiles.forEach((profile) => {
    profileAssignmentKeys(profile).forEach((assignment) => {
      const existing = assigned.get(assignment.key)
      if (!existing) {
        assigned.set(assignment.key, { assignment, profile })
        return
      }
      throw profileAssignmentConflictError({
        assignment,
        existing: existing.profile,
        next: profile,
      })
    })
  })
}

export function assertPersonalPhoneInboundSourceCompatibility(
  profiles = [],
  configuredSourceId = process.env.PERSONAL_PHONE_CONTACTS_SOURCE_ID,
) {
  const authoritativeSourceId = safeLeadText(configuredSourceId)
  if (!authoritativeSourceId) return true

  for (const profile of profiles) {
    const policy = profile?.config?.personalPhoneInbound || {}
    if (policy.enabled !== true) continue
    // Only source-scoped eligibility is coupled to the configured Personal
    // Phone source. Selected contacts and Smart Views are explicit profile
    // assignments and must not make the entire profile workspace unsavable.
    if (policy.eligibilityScope !== 'source') continue
    const sourceId = safeLeadText(policy.sourceId)
    if (sourceId === authoritativeSourceId) continue
    const profileName = safeLeadText(profile?.name || profile?.id) || 'This agent'
    throw Object.assign(
      new Error(
        `${profileName} must use the configured Personal Phone contact source ${authoritativeSourceId}.`,
      ),
      {
        statusCode: 409,
        code: 'personal_phone_inbound_source_mismatch',
      },
    )
  }

  return true
}

function profileAssignmentKeys(profile = {}) {
  const config = profile.config || {}
  const assignments = []
  const contactSource = normalizeLeadSource(config.contactSource)
  const contactSourceId = safeLeadText(config.contactSourceId)
  if (isSelectableContactSource(contactSource)) {
    assignments.push({
      key: `source:contact-source:${contactSource}:${contactSourceId || '*'}`,
      label: `${contactSourceLabel(contactSource)} source`,
      value: contactSourceId || contactSource,
    })
  }

  const smartViewId = safeLeadText(config.smartViewId)
  if (smartViewId) {
    assignments.push({
      key: `source:smart-view:${smartViewId}`,
      label: 'Smart View source',
      value: smartViewId,
    })
  }

  const personalPhoneInbound = config.personalPhoneInbound || {}
  if (personalPhoneInbound.enabled === true) {
    if (personalPhoneInbound.eligibilityScope === 'source') {
      const personalPhoneSourceId = safeLeadText(personalPhoneInbound.sourceId)
      if (personalPhoneSourceId) {
        assignments.push({
          key: `personal-phone:inbound-source:${personalPhoneSourceId}`,
          label: 'Personal Phone inbound source',
          value: personalPhoneSourceId,
        })
      }
    } else {
      normalizeStringList(personalPhoneInbound.contactIds).forEach((contactId) => {
        assignments.push({
          key: `personal-phone:inbound-contact:${contactId}`,
          label: 'Personal Phone inbound contact',
          value: contactId,
        })
      })
      normalizeStringList(personalPhoneInbound.smartViewIds).forEach((viewId) => {
        assignments.push({
          key: `personal-phone:inbound-smart-view:${viewId}`,
          label: 'Personal Phone inbound Smart View',
          value: viewId,
        })
      })
    }
  }

  const callToolsBinding = config.calltoolsAgentBinding || {}
  if (callToolsBinding.enabled === true) {
    const binding = callToolsBinding
    const phoneId = safeLeadText(binding.phoneId)
    const campaignId = safeLeadText(binding.campaignId)
    const liveFilterId = safeLeadText(binding.liveFilterId)
    const bucketId = safeLeadText(binding.bucketId)
    if (phoneId) {
      assignments.push({
        key: `calltools:phone:${phoneId}`,
        label: 'CallTools phone',
        value: phoneId,
      })
    }
    if (liveFilterId) {
      assignments.push({
        key: `calltools:live-filter:${liveFilterId}`,
        label: 'CallTools live filter source',
        value: liveFilterId,
      })
    } else if (bucketId) {
      assignments.push({
        key: `calltools:bucket:${bucketId}`,
        label: 'CallTools bucket source',
        value: bucketId,
      })
    } else if (campaignId) {
      assignments.push({
        key: `calltools:campaign:${campaignId}`,
        label: 'CallTools campaign source',
        value: campaignId,
      })
    }
    return assignments
  }

  // Speak/Telnyx caller IDs belong to the workspace Call Control app and may be
  // selected by multiple profiles. Only profile-owned sources and CallTools SIP
  // phone bindings are exclusive assignments.
  return assignments
}

function profileAssignmentConflictError({ assignment, existing, next }) {
  const existingName = safeLeadText(existing?.name || existing?.id) || 'another agent'
  const nextName = safeLeadText(next?.name || next?.id) || 'this agent'
  return Object.assign(
    new Error(
      `${assignment.label} ${assignment.value} is already assigned to ${existingName}; ${nextName} needs a different source or phone assignment.`,
    ),
    {
      statusCode: 409,
      code: 'profile_assignment_conflict',
      assignment: cleanObject({
        label: assignment.label,
        value: assignment.value,
        existingProfileId: existing?.id,
        nextProfileId: next?.id,
      }),
    },
  )
}

export function normalizeWorkspaceLead(value = {}) {
  const normalized = normalizeLead({
    ...value,
    status: normalizeLeadStatus(value.status),
  })
  const source = normalizeLeadSource(value.source)
  const { providerIds, ...normalizedLead } = normalized
  return {
    ...normalizedLead,
    ...(source === 'personal-phone' ? {} : { providerIds }),
    tags: normalizeStringList(normalized.tags),
    score: Number.isFinite(Number(normalized.score)) ? Number(normalized.score) : 0,
    status: normalizeLeadStatus(normalized.status),
    context: normalizeContextFields(value.context || normalized.context),
    ...(source ? { source } : {}),
    sourceId: safeLeadText(value.sourceId),
    sourceName: safeLeadText(value.sourceName),
    sourceUrl: safeLeadText(value.sourceUrl),
    externalUrl: safeLeadText(value.externalUrl),
    sourceSyncedAt: safeLeadText(value.sourceSyncedAt),
  }
}

export function normalizeWorkspaceProfile(value = {}) {
  const source = value && typeof value === 'object' ? value : {}
  return {
    id: String(source.id || `agent-config-${randomUUID()}`),
    name: cleanName(source.name || 'Untitled config') || 'Untitled config',
    updatedAt: source.updatedAt || new Date().toISOString(),
    config: normalizeWorkspaceProfileConfig(source.config || {}),
    testVariables: normalizeAgentTestVariables(source.testVariables),
    context: normalizeContextFields(source.context),
  }
}

function normalizeWorkspaceProfileConfig(config = {}) {
  const source = config && typeof config === 'object' ? config : {}
  const normalized = normalizeCampaignConfig(source)
  const hasExplicitSpeakPhone = Boolean(
    normalizePhone(source.telnyxCallerId || source.phoneCallerId),
  )
  const hasExplicitSpeakConnection = Boolean(
    safeLeadText(source.telnyxConnectionId || source.phoneConnectionId),
  )

  return {
    ...normalized,
    telnyxCallerId: hasExplicitSpeakPhone ? normalized.telnyxCallerId : '',
    telnyxConnectionId: hasExplicitSpeakConnection ? normalized.telnyxConnectionId : '',
  }
}

export async function resolveWorkspaceRuntimeContext({ lead, config } = {}) {
  const initialWorkspace = await readWorkspace()
  const initialLead = resolveRuntimeLeadFromWorkspace(initialWorkspace, lead)
  const initialProfileIndex = resolveWorkspaceProfileIndexForConfig(
    initialWorkspace.profiles,
    config,
  )
  const initialProfile =
    initialProfileIndex >= 0 ? initialWorkspace.profiles[initialProfileIndex] : null
  const prepared = await prepareRuntimeContextFields({
    leadContext: initialLead.context,
    profileContext: initialProfile?.context,
  })

  if (!prepared.leadChanged && !prepared.profileChanged) {
    return {
      lead: initialLead,
      profile: initialProfile,
      profileContext: normalizeContextFields(initialProfile?.context),
    }
  }

  return mutateWorkspace(async (workspace) => {
    const normalizedLead = normalizeWorkspaceLead(lead || {})
    const leadIndex = isTransientWorkspaceLead(normalizedLead)
      ? -1
      : workspace.leads.findIndex((item) => item.id === normalizedLead.id)
    let runtimeLead = resolveRuntimeLeadFromWorkspace(workspace, lead)
    const profileIndex = resolveWorkspaceProfileIndexForConfig(workspace.profiles, config)
    let profile = profileIndex >= 0 ? workspace.profiles[profileIndex] : null

    if (prepared.leadChanged) {
      if (leadIndex >= 0) {
        const mergedContext = mergeRuntimeUrlSnapshots(
          workspace.leads[leadIndex].context,
          prepared.leadContext,
        )
        workspace.leads[leadIndex] = normalizeWorkspaceLead({
          ...workspace.leads[leadIndex],
          context: mergedContext,
        })
        runtimeLead = normalizeWorkspaceLead({
          ...normalizedLead,
          ...workspace.leads[leadIndex],
          id: workspace.leads[leadIndex].id,
          context: workspace.leads[leadIndex].context,
        })
      } else {
        runtimeLead = normalizeWorkspaceLead({
          ...runtimeLead,
          context: prepared.leadContext,
        })
      }
    }

    if (profile && prepared.profileChanged) {
      const mergedContext = mergeRuntimeUrlSnapshots(
        profile.context,
        prepared.profileContext,
      )
      profile = normalizeWorkspaceProfile({
        ...profile,
        context: mergedContext,
      })
      workspace.profiles[profileIndex] = profile
    }

    return {
      lead: runtimeLead,
      profile,
      profileContext: normalizeContextFields(profile?.context),
    }
  })
}

export async function resolveWorkspaceRuntimeSnapshot({ lead, config } = {}) {
  const cache = await readCachedWorkspaceEntry()
  const storedLead = resolveCachedRuntimeLead(cache, lead)
  const runtimeLead = storedLead
    ? normalizeWorkspaceLead({
        ...normalizeWorkspaceLead(lead || {}),
        ...storedLead,
        id: storedLead.id,
        context: storedLead.context,
      })
    : normalizeWorkspaceLead(lead || {})
  const profileIndex = resolveWorkspaceProfileIndexForConfig(
    cache.workspace.profiles,
    config,
  )
  const storedProfile = profileIndex >= 0
    ? cache.workspace.profiles[profileIndex]
    : null
  const profile = storedProfile ? structuredClone(storedProfile) : null

  return {
    lead: runtimeLead,
    profile,
    profileContext: normalizeContextFields(profile?.context || config?.profileContext),
  }
}

function resolveCachedRuntimeLead(cache, lead = {}) {
  const source = lead && typeof lead === 'object' ? lead : {}
  if (isTransientWorkspaceLead(source)) return null
  const id = safeLeadText(source.id)
  if (id && cache.leadById.has(id)) return cache.leadById.get(id)

  const phone = normalizePhone(
    source.phone || source.contact_phone || source.phone_on_file || source.called_phone || '',
  )
  const email = cleanEmail(
    source.email || source.contact_email || source.email_on_file || '',
  )
  const phoneMatch = uniqueCachedLead(cache.uniqueLeadByPhone, phone)
  const emailMatch = uniqueCachedLead(cache.uniqueLeadByEmail, email)

  if (phoneMatch && emailMatch && phoneMatch.id !== emailMatch.id) return null
  return phoneMatch || emailMatch || null
}

function uniqueCachedLead(index, key) {
  if (!key || !index.has(key)) return null
  return index.get(key) || null
}

function resolveRuntimeLeadFromWorkspace(workspace, lead) {
  const normalizedLead = normalizeWorkspaceLead(lead || {})
  if (isTransientWorkspaceLead(normalizedLead)) return normalizedLead
  const storedLead = workspace.leads.find((item) => item.id === normalizedLead.id)
  return storedLead
    ? normalizeWorkspaceLead({
        ...normalizedLead,
        ...storedLead,
        id: storedLead.id,
        context: storedLead.context,
      })
    : normalizedLead
}

function resolveWorkspaceProfileForAgentProfileId(profiles = [], agentProfileId = '') {
  const id = safeLeadText(agentProfileId)
  if (!id) return null
  return profiles.find((profile) => {
    const config = profile.config || {}
    return [
      profile.id,
      config.agentProfileId,
      config.speakConfigId,
      config.humeConfigId,
      config.inworldConfigId,
    ]
      .map((value) => safeLeadText(value))
      .includes(id)
  }) || null
}

function mergeRuntimeUrlSnapshots(currentContext, preparedContext) {
  const current = normalizeContextFields(currentContext)
  const prepared = normalizeContextFields(preparedContext)
  if (current.urls.join('\n') !== prepared.urls.join('\n')) return current
  return normalizeContextFields({
    ...current,
    urlSnapshots: prepared.urlSnapshots,
  })
}

export function normalizeAgentTestVariables(value = {}) {
  const source = value && typeof value === 'object' ? value : {}
  const normalized = normalizeConfigurationTestVariables(source)
  return {
    first_name: safeLeadText(source.first_name || normalized.firstName),
    last_name: safeLeadText(source.last_name || normalized.lastName),
    full_name: safeLeadText(source.full_name || normalized.name),
    business_name: safeLeadText(source.business_name || normalized.company),
    contact_phone: normalizePhone(source.contact_phone || normalized.phone),
    contact_email: cleanEmail(source.contact_email || normalized.email),
    notes: safeLeadText(source.notes || normalized.notes),
  }
}

function normalizeLeadList(value) {
  const seen = new Set()
  return (Array.isArray(value) ? value : [])
    .map(normalizeWorkspaceLead)
    .filter((lead) => {
      if (!lead.id || seen.has(lead.id)) return false
      seen.add(lead.id)
      return true
    })
}

function normalizeProfileList(value) {
  const seen = new Set()
  return (Array.isArray(value) ? value : [])
    .map(normalizeWorkspaceProfile)
    .filter((profile) => {
      if (!profile.id || seen.has(profile.id)) return false
      seen.add(profile.id)
      return true
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

function normalizeSmartViewList(value) {
  const seen = new Set()
  return (Array.isArray(value) ? value : [])
    .map(normalizeWorkspaceSmartView)
    .filter((smartView) => {
      if (!smartView.id || seen.has(smartView.id)) return false
      seen.add(smartView.id)
      return true
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

function normalizeWorkspaceSmartView(value = {}) {
  const source = value && typeof value === 'object' ? value : {}
  const now = new Date().toISOString()
  const leadIds = normalizeStringList(source.leadIds)
  const name = safeLeadText(source.name || 'Untitled smart view') || 'Untitled smart view'
  const sourceType = normalizeSmartViewSource(source.source)
  return {
    id: String(source.id || `smart-view-${randomUUID()}`),
    name,
    source: sourceType,
    sourceId: safeLeadText(source.sourceId),
    sourceUrl: safeLeadText(source.sourceUrl),
    externalUrl: safeLeadText(source.externalUrl),
    syncedAt: safeLeadText(source.syncedAt),
    createdAt: source.createdAt || source.updatedAt || now,
    updatedAt: source.updatedAt || now,
    filters: normalizeSmartViewFilters(source.filters),
    leadIds,
    leadCount: leadIds.length,
  }
}

function normalizeSmartViewSource(value) {
  const source = String(value || '').trim()
  if (source === 'csv') return source
  return 'filters'
}

function normalizeLeadSource(value) {
  const source = String(value || '').trim()
  if (source === 'personal_phone' || source === 'personal phone') return 'personal-phone'
  if (
    source === 'manual' ||
    source === 'filters' ||
    source === 'csv' ||
    source === 'calltools' ||
    source === 'personal-phone'
  ) {
    return source
  }
  return ''
}

function normalizeWorkspaceContactSource(value = {}) {
  const source = normalizeLeadSource(value.source) || 'manual'
  const sourceId = safeLeadText(value.sourceId || source)
  const sourceName =
    safeLeadText(value.sourceName || value.name) || contactSourceLabel(source)
  const leadIds = normalizeStringList(value.leadIds)
  return cleanObject({
    id: contactSourceKey(source, sourceId),
    source,
    sourceId,
    sourceName,
    sourceUrl: safeLeadText(value.sourceUrl),
    externalUrl: safeLeadText(value.externalUrl),
    sourceSyncedAt: safeLeadText(value.sourceSyncedAt || value.syncedAt),
    leadIds,
    leadCount: leadIds.length,
  })
}

function summarizeWorkspaceContactSources(workspace = {}) {
  const sources = new Map()
  for (const lead of workspace.leads || []) {
    const source = normalizeLeadSource(lead.source) || 'manual'
    if (!isSelectableContactSource(source)) continue
    const sourceId = safeLeadText(lead.sourceId || source)
    const key = contactSourceKey(source, sourceId)
    const existing =
      sources.get(key) ||
      normalizeWorkspaceContactSource({
        source,
        sourceId,
        sourceName: lead.sourceName || contactSourceLabel(source),
        sourceUrl: lead.sourceUrl,
        externalUrl: lead.externalUrl,
        sourceSyncedAt: lead.sourceSyncedAt,
        leadIds: [],
      })
    existing.leadIds.push(lead.id)
    existing.leadCount = existing.leadIds.length
    if (lead.sourceSyncedAt && lead.sourceSyncedAt > (existing.sourceSyncedAt || '')) {
      existing.sourceSyncedAt = lead.sourceSyncedAt
    }
    sources.set(key, existing)
  }
  return Array.from(sources.values())
    .map(publicWorkspaceContactSource)
    .sort((left, right) =>
      left.sourceName.localeCompare(right.sourceName, undefined, { sensitivity: 'base' }),
    )
}

function publicWorkspaceContactSource(source = {}) {
  const { leadIds: _leadIds, ...publicSource } = source
  return publicSource
}

function isSelectableContactSource(source) {
  return source && source !== 'manual' && source !== 'filters' && source !== 'csv'
}

function contactSourceKey(source, sourceId) {
  return [source || 'manual', sourceId || source || 'manual'].join('::')
}

function contactSourceLabel(source) {
  if (source === 'personal-phone') return 'Personal Phone'
  if (source === 'calltools') return 'CallTools'
  if (source === 'csv') return 'CSV Import'
  if (source === 'manual') return 'Manual Contacts'
  return 'Contacts'
}

function normalizeSmartViewFilters(value = {}) {
  const source = value && typeof value === 'object' ? value : {}
  return {
    query: safeLeadText(source.query),
    statusFilter: safeLeadText(source.statusFilter || 'all') || 'all',
    stateFilter: safeLeadText(source.stateFilter || 'all') || 'all',
    scoreFilter: safeLeadText(source.scoreFilter || 'all') || 'all',
    tagFilter: safeLeadText(source.tagFilter || 'all') || 'all',
    sortField: safeLeadText(source.sortField || 'score') || 'score',
    sortDirection: source.sortDirection === 'asc' ? 'asc' : 'desc',
  }
}

export function applyWorkspaceDialerStatePatch(currentValue = {}, patchValue = {}) {
  const current = normalizeWorkspaceDialerState(currentValue)
  const patch = patchValue && typeof patchValue === 'object'
    ? { ...patchValue }
    : {}
  delete patch.calltoolsDuty

  const activeCallToolsDuty = workspaceCallToolsDutyActive(current.calltoolsDuty)
  if (
    activeCallToolsDuty &&
    patch.sourceId !== undefined &&
    safeLeadText(patch.sourceId) !== current.sourceId
  ) {
    delete patch.sourceId
    delete patch.activeSmartViewId
  }

  const next = normalizeWorkspaceDialerState({
    ...current,
    ...patch,
    calltoolsDuty: current.calltoolsDuty,
    updatedAt: new Date().toISOString(),
  })
  if (activeCallToolsDuty) {
    next.campaignRunning = true
  } else if (workspaceDialerStateUsesCallTools(next.sourceId)) {
    next.campaignRunning = false
    next.controllerHeartbeatAt = ''
    next.controllerId = ''
  }
  return next
}

export function normalizeWorkspaceDialerState(value = {}) {
  const source = value && typeof value === 'object' ? value : {}
  const sourceId = safeLeadText(source.sourceId)
  return {
    sourceId: sourceId === 'all' ? '' : sourceId,
    activeSmartViewId: safeLeadText(source.activeSmartViewId),
    query: safeLeadText(source.query),
    statusFilter: safeLeadText(source.statusFilter || 'all') || 'all',
    stateFilter: safeLeadText(source.stateFilter || 'all') || 'all',
    scoreFilter: safeLeadText(source.scoreFilter || 'all') || 'all',
    selectedLeadId: safeLeadText(source.selectedLeadId),
    selectedLeadIds: normalizeStringList(source.selectedLeadIds),
    campaignQueueIds: normalizeStringList(source.campaignQueueIds),
    campaignRunning: Boolean(source.campaignRunning),
    scheduledStartAt: safeLeadText(source.scheduledStartAt),
    scheduledQueueActive: Boolean(source.scheduledQueueActive),
    controllerId: safeLeadText(source.controllerId),
    controllerHeartbeatAt: safeLeadText(source.controllerHeartbeatAt),
    calltoolsDuty: normalizeWorkspaceCallToolsDuty(source.calltoolsDuty),
    updatedAt: safeLeadText(source.updatedAt),
  }
}

function normalizeWorkspaceCallToolsDuty(value = {}) {
  const source = value && typeof value === 'object' ? value : {}
  const supportedStatuses = new Set(['arming', 'attention', 'disarming', 'off', 'on'])
  const status = supportedStatuses.has(source.status) ? source.status : 'off'
  const binding = source.binding && typeof source.binding === 'object'
    ? source.binding
    : {}
  return {
    leaseId: safeLeadText(source.leaseId),
    status,
    profileId: safeLeadText(source.profileId),
    gatewayOwnerInstanceId: safeLeadText(source.gatewayOwnerInstanceId),
    binding: {
      appUserId: safeLeadText(binding.appUserId || binding.userId),
      campaignId: safeLeadText(binding.campaignId),
      phoneId: safeLeadText(binding.phoneId),
    },
    startedAt: safeLeadText(source.startedAt),
    lastCheckedAt: safeLeadText(source.lastCheckedAt),
    lastVerifiedAt: safeLeadText(source.lastVerifiedAt),
    transitionAt: safeLeadText(source.transitionAt),
    providerReadFailures: Math.max(0, Number(source.providerReadFailures || 0)),
    reason: safeLeadText(source.reason).slice(0, 320),
    message: safeLeadText(source.message).slice(0, 320),
    blockers: normalizeStringList(source.blockers).slice(0, 8),
  }
}

function workspaceCallToolsDutyActive(value = {}) {
  return Boolean(
    safeLeadText(value.leaseId) &&
    ['arming', 'attention', 'disarming', 'on'].includes(value.status),
  )
}

function workspaceDialerStateUsesCallTools(sourceId = '') {
  return /^source:calltools(?:$|::)/.test(safeLeadText(sourceId))
}

function normalizeCommunicationThread(value = {}) {
  const source = value && typeof value === 'object' ? value : {}
  const now = new Date().toISOString()
  const status = safeLeadText(source.status)
  return {
    threadId: safeLeadText(source.threadId || `thread-${randomUUID()}`),
    contactId: safeLeadText(source.contactId),
    agentProfileId: safeLeadText(source.agentProfileId),
    status: communicationThreadStatuses.has(status) ? status : 'open',
    channels: normalizeCommunicationChannelList(source.channels),
    participants: Array.isArray(source.participants) ? source.participants.filter(isPlainObject) : [],
    topicIds: normalizeStringList(source.topicIds),
    summary: safeLeadText(source.summary),
    latestChannel: normalizeCommunicationChannel(source.latestChannel, ''),
    latestMessagePreview: safeLeadText(source.latestMessagePreview),
    lastMessageId: safeLeadText(source.lastMessageId),
    lastInboundAt: safeLeadText(source.lastInboundAt),
    lastOutboundAt: safeLeadText(source.lastOutboundAt),
    messageCount: Math.max(0, Number(source.messageCount || 0)),
    emotionScoreTurns: Math.max(0, Number(source.emotionScoreTurns || 0)),
    hasEmotionScores: Boolean(source.hasEmotionScores || Number(source.emotionScoreTurns || 0) > 0),
    identityConfidence: normalizeIdentityConfidence(source.identityConfidence),
    providerLinks: normalizeProviderLinks(source.providerLinks),
    createdAt: safeLeadText(source.createdAt) || safeLeadText(source.updatedAt) || now,
    updatedAt: safeLeadText(source.updatedAt) || now,
  }
}

function normalizeCommunicationMessage(value = {}) {
  const source = value && typeof value === 'object' ? value : {}
  const now = new Date().toISOString()
  return {
    messageId: safeLeadText(source.messageId || `message-${randomUUID()}`),
    threadId: safeLeadText(source.threadId),
    contactId: safeLeadText(source.contactId),
    agentProfileId: safeLeadText(source.agentProfileId),
    channel: normalizeCommunicationChannel(source.channel, 'system'),
    modality: normalizeCommunicationModality(source.modality, 'status'),
    direction: normalizeCommunicationDirection(source.direction, 'system'),
    role: normalizeCommunicationRole(source.role, 'system'),
    body: safeLeadText(source.body),
    bodyStatus: normalizeBodyStatus(source.bodyStatus),
    provider: safeLeadText(source.provider || 'speak'),
    providerIds: isPlainObject(source.providerIds) ? { ...source.providerIds } : {},
    proof: isPlainObject(source.proof) ? { ...source.proof } : {},
    attachments: Array.isArray(source.attachments) ? source.attachments.filter(isPlainObject) : [],
    emotionScores: normalizeEmotionScores(source.emotionScores) || undefined,
    topicIds: normalizeStringList(source.topicIds),
    at: safeLeadText(source.at) || now,
  }
}

function normalizeCommunicationTopic(value = {}) {
  const source = value && typeof value === 'object' ? value : {}
  return {
    topicId: safeLeadText(source.topicId || `topic-${randomUUID()}`),
    threadId: safeLeadText(source.threadId),
    contactId: safeLeadText(source.contactId),
    label: safeLeadText(source.label || 'Recent conversation') || 'Recent conversation',
    summary: safeLeadText(source.summary),
    status: safeLeadText(source.status || 'open') || 'open',
    confidence: safeLeadText(source.confidence || 'materialized') || 'materialized',
    sourceMessageIds: normalizeStringList(source.sourceMessageIds),
    updatedAt: safeLeadText(source.updatedAt) || new Date().toISOString(),
  }
}

function normalizeContactIdentityLink(value = {}) {
  const source = value && typeof value === 'object' ? value : {}
  const kind = safeLeadText(source.kind)
  return {
    contactId: safeLeadText(source.contactId),
    kind: communicationIdentityKinds.has(kind) ? kind : 'provider_contact',
    normalizedValue: safeLeadText(source.normalizedValue),
    source: safeLeadText(source.source || 'speak'),
    confidence: normalizeIdentityConfidence(source.confidence),
    verifiedAt: safeLeadText(source.verifiedAt),
    supersededBy: safeLeadText(source.supersededBy),
  }
}

function normalizeCommunicationThreadList(value) {
  const seen = new Set()
  return (Array.isArray(value) ? value : [])
    .map(normalizeCommunicationThread)
    .filter((thread) => {
      if (!thread.threadId || seen.has(thread.threadId)) return false
      seen.add(thread.threadId)
      return true
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

function normalizeCommunicationMessageList(value) {
  const seen = new Set()
  return (Array.isArray(value) ? value : [])
    .map(normalizeCommunicationMessage)
    .filter((message) => {
      if (!message.messageId || !message.threadId || seen.has(message.messageId)) return false
      seen.add(message.messageId)
      return true
    })
    .sort((left, right) => left.at.localeCompare(right.at) || left.messageId.localeCompare(right.messageId))
}

function normalizeCommunicationTopicList(value) {
  const seen = new Set()
  return (Array.isArray(value) ? value : [])
    .map(normalizeCommunicationTopic)
    .filter((topic) => {
      if (!topic.topicId || !topic.threadId || seen.has(topic.topicId)) return false
      seen.add(topic.topicId)
      return true
    })
}

function normalizeContactIdentityLinkList(value) {
  const seen = new Set()
  return (Array.isArray(value) ? value : [])
    .map(normalizeContactIdentityLink)
    .filter((link) => {
      const key = identityLinkKey(link)
      if (!link.contactId || !link.normalizedValue || seen.has(key)) return false
      seen.add(key)
      return true
    })
}

function resolveCommunicationAttribution(workspace, input = {}, communication = {}) {
  const explicitContactId = safeLeadText(communication.contactId)
  if (explicitContactId) {
    return {
      contactId: explicitContactId,
      lead: findWorkspaceLeadById(workspace, explicitContactId),
      confidence: 'verified',
      identityLinks: communicationIdentityLinks(communication, explicitContactId),
      identityKey: explicitContactId,
    }
  }

  const explicitLeadSource = firstPlainObject(input.lead, input.state?.lead)
  const explicitLead = hasLeadIdentitySource(explicitLeadSource)
    ? normalizeWorkspaceLead(explicitLeadSource)
    : null
  if (explicitLead?.id) {
    return {
      contactId: explicitLead.id,
      lead: explicitLead,
      confidence: 'verified',
      identityLinks: communicationIdentityLinks(communication, explicitLead.id),
      identityKey: explicitLead.id,
    }
  }

  const identities = communicationIdentityCandidates(communication, {
    direction: communicationDirectionForIdentityCandidates(communication),
  })
  for (const identity of identities) {
    const linkMatches = verifiedIdentityLinkMatches(workspace, identity)
    if (linkMatches.length === 1) {
      const contactId = linkMatches[0].contactId
      return {
        contactId,
        lead: findWorkspaceLeadById(workspace, contactId),
        confidence: 'verified',
        identityLinks: communicationIdentityLinks(communication, contactId),
        identityKey: identity.key,
      }
    }
    if (linkMatches.length > 1) {
      return unresolvedAttribution(identities)
    }

    if (identity.kind === 'phone' || identity.kind === 'email') {
      const leadMatches = workspaceLeadIdentityMatches(workspace, identity)
      if (leadMatches.length === 1) {
        return {
          contactId: leadMatches[0].id,
          lead: leadMatches[0],
          confidence: 'verified',
          identityLinks: communicationIdentityLinks(communication, leadMatches[0].id),
          identityKey: identity.key,
        }
      }
      if (leadMatches.length > 1) {
        return unresolvedAttribution(identities)
      }
    }
  }

  return unresolvedAttribution(identities)
}

function unresolvedAttribution(identities) {
  return {
    contactId: '',
    lead: null,
    confidence: 'unresolved',
    identityLinks: [],
    identityKey: identities.map((identity) => identity.key).filter(Boolean).join('-'),
  }
}

function communicationIdentityCandidates(communication = {}, {
  direction = communicationDirectionForIdentityCandidates(communication),
} = {}) {
  const identity = isPlainObject(communication.identity) ? communication.identity : {}
  const providerIds = isPlainObject(communication.providerIds) ? communication.providerIds : {}
  const proof = isPlainObject(communication.proof) ? communication.proof : {}
  const contactSide = direction === 'outbound'
    ? 'to'
    : direction === 'inbound'
      ? 'from'
      : 'any'
  const contactPhoneValues = contactSide === 'to'
    ? [
        identity.phone,
        identity.phones,
        communication.phone,
        communication.phones,
        identity.toPhone,
        identity.to_phone,
        identity.toPhones,
        identity.to_phones,
        communication.toPhone,
        communication.to_phone,
        communication.toPhones,
        communication.to_phones,
        providerIds.toPhone,
        providerIds.to_phone,
        providerIds.toPhones,
        providerIds.to_phones,
        proof.toPhone,
        proof.to_phone,
      ]
    : contactSide === 'from'
      ? [
          identity.phone,
          identity.phones,
          communication.phone,
          communication.phones,
          identity.fromPhone,
          identity.from_phone,
          identity.fromPhones,
          identity.from_phones,
          communication.fromPhone,
          communication.from_phone,
          communication.fromPhones,
          communication.from_phones,
          providerIds.fromPhone,
          providerIds.from_phone,
          providerIds.fromPhones,
          providerIds.from_phones,
          providerIds.from,
          proof.fromPhone,
          proof.from_phone,
          proof.from,
        ]
      : [
          identity.phone,
          identity.phones,
          communication.phone,
          communication.phones,
          identity.fromPhone,
          identity.from_phone,
          identity.fromPhones,
          identity.from_phones,
          identity.toPhone,
          identity.to_phone,
          identity.toPhones,
          identity.to_phones,
          communication.fromPhone,
          communication.from_phone,
          communication.fromPhones,
          communication.from_phones,
          communication.toPhone,
          communication.to_phone,
          communication.toPhones,
          communication.to_phones,
          providerIds.fromPhone,
          providerIds.from_phone,
          providerIds.fromPhones,
          providerIds.from_phones,
          providerIds.toPhone,
          providerIds.to_phone,
          providerIds.toPhones,
          providerIds.to_phones,
          providerIds.from,
          proof.fromPhone,
          proof.from_phone,
          proof.from,
          proof.toPhone,
          proof.to_phone,
        ]
  const contactEmailValues = contactSide === 'to'
    ? [
        identity.email,
        identity.emails,
        communication.email,
        communication.emails,
        identity.toEmail,
        identity.to_email,
        identity.toEmails,
        identity.to_emails,
        communication.toEmail,
        communication.to_email,
        communication.toEmails,
        communication.to_emails,
        providerIds.toEmail,
        providerIds.to_email,
        providerIds.toEmails,
        providerIds.to_emails,
        proof.toEmail,
        proof.to_email,
      ]
    : contactSide === 'from'
      ? [
          identity.email,
          identity.emails,
          communication.email,
          communication.emails,
          identity.fromEmail,
          identity.from_email,
          identity.fromEmails,
          identity.from_emails,
          communication.fromEmail,
          communication.from_email,
          communication.fromEmails,
          communication.from_emails,
          providerIds.fromEmail,
          providerIds.from_email,
          providerIds.fromEmails,
          providerIds.from_emails,
          providerIds.from,
          proof.fromEmail,
          proof.from_email,
          proof.from,
        ]
      : [
          identity.email,
          identity.emails,
          communication.email,
          communication.emails,
          identity.fromEmail,
          identity.from_email,
          identity.fromEmails,
          identity.from_emails,
          identity.toEmail,
          identity.to_email,
          identity.toEmails,
          identity.to_emails,
          communication.fromEmail,
          communication.from_email,
          communication.fromEmails,
          communication.from_emails,
          communication.toEmail,
          communication.to_email,
          communication.toEmails,
          communication.to_emails,
          providerIds.fromEmail,
          providerIds.from_email,
          providerIds.fromEmails,
          providerIds.from_emails,
          providerIds.toEmail,
          providerIds.to_email,
          providerIds.toEmails,
          providerIds.to_emails,
          providerIds.from,
          proof.fromEmail,
          proof.from_email,
          proof.from,
          proof.toEmail,
          proof.to_email,
        ]
  const candidates = [
    {
      kind: 'phone',
      normalizedValue: normalizedPhoneValues(...contactPhoneValues)[0] || '',
    },
    {
      kind: 'email',
      normalizedValue: normalizedEmailValues(...contactEmailValues)[0] || '',
    },
    {
      kind: 'external_thread',
      normalizedValue: safeLeadText(
        firstSafeText(
          identity.externalThreadId,
          identity.external_thread_id,
          communication.emailThreadId,
          providerIds.emailThreadId,
          providerIds.email_thread_id,
          proof.thread_id,
          proof.emailThreadId,
        ),
      ),
    },
    {
      kind: 'provider_contact',
      normalizedValue: safeLeadText(
        firstSafeText(
          identity.providerContactId,
          identity.provider_contact_id,
          providerIds.providerContactId,
          providerIds.provider_contact_id,
          providerIds.contactId,
          proof.provider_contact_id,
        ),
      ),
    },
  ].filter((candidate) => candidate.normalizedValue)

  const seen = new Set()
  return candidates
    .map((candidate) => ({
      ...candidate,
      key: `${candidate.kind}:${candidate.normalizedValue}`,
    }))
    .filter((candidate) => {
      if (seen.has(candidate.key)) return false
      seen.add(candidate.key)
      return true
    })
}

function communicationDirectionForIdentityCandidates(communication = {}) {
  const role = normalizeCommunicationRole(communication.role, 'system')
  return normalizeCommunicationDirection(
    communication.direction,
    directionForRole(role),
  )
}

function communicationIdentityProviderIds({
  communication = {},
  direction = 'inbound',
} = {}) {
  const identity = isPlainObject(communication.identity) ? communication.identity : {}
  const inbound = direction === 'inbound'
  const genericPhones = normalizedPhoneValues(
    identity.phone,
    identity.phones,
    communication.phone,
    communication.phones,
  )
  const genericEmails = normalizedEmailValues(
    identity.email,
    identity.emails,
    communication.email,
    communication.emails,
  )
  const explicitFromPhones = normalizedPhoneValues(
    identity.fromPhone,
    identity.from_phone,
    identity.fromPhones,
    identity.from_phones,
    communication.fromPhone,
    communication.from_phone,
    communication.fromPhones,
    communication.from_phones,
  )
  const explicitToPhones = normalizedPhoneValues(
    identity.toPhone,
    identity.to_phone,
    identity.toPhones,
    identity.to_phones,
    communication.toPhone,
    communication.to_phone,
    communication.toPhones,
    communication.to_phones,
  )
  const explicitFromEmails = normalizedEmailValues(
    identity.fromEmail,
    identity.from_email,
    identity.fromEmails,
    identity.from_emails,
    communication.fromEmail,
    communication.from_email,
    communication.fromEmails,
    communication.from_emails,
  )
  const explicitToEmails = normalizedEmailValues(
    identity.toEmail,
    identity.to_email,
    identity.toEmails,
    identity.to_emails,
    communication.toEmail,
    communication.to_email,
    communication.toEmails,
    communication.to_emails,
  )
  const fromPhones = explicitFromPhones.length ? explicitFromPhones : inbound ? genericPhones : []
  const toPhones = explicitToPhones.length ? explicitToPhones : inbound ? [] : genericPhones
  const fromEmails = explicitFromEmails.length ? explicitFromEmails : inbound ? genericEmails : []
  const toEmails = explicitToEmails.length ? explicitToEmails : inbound ? [] : genericEmails
  const emailThreadId = safeLeadText(
    firstSafeText(
      identity.externalThreadId,
      identity.external_thread_id,
      communication.externalThreadId,
      communication.external_thread_id,
      communication.emailThreadId,
    ),
  )

  return cleanObject({
    fromPhone: fromPhones[0] || '',
    fromPhones: fromPhones.length ? fromPhones : undefined,
    toPhone: toPhones[0] || '',
    toPhones: toPhones.length ? toPhones : undefined,
    fromEmail: fromEmails[0] || '',
    fromEmails: fromEmails.length ? fromEmails : undefined,
    toEmail: toEmails[0] || '',
    toEmails: toEmails.length ? toEmails : undefined,
    emailThreadId,
  })
}

function normalizedPhoneValues(...values) {
  const seen = new Set()
  return flattenCommunicationIdentityValues(values)
    .map((value) => normalizePhone(value))
    .filter((phone) => {
      if (!phone || seen.has(phone)) return false
      seen.add(phone)
      return true
    })
}

function normalizedEmailValues(...values) {
  const seen = new Set()
  return flattenCommunicationIdentityValues(values)
    .map((value) => cleanEmail(value))
    .filter((email) => {
      if (!email || seen.has(email)) return false
      seen.add(email)
      return true
    })
}

function flattenCommunicationIdentityValues(values = []) {
  const flattened = []
  values.forEach((value) => {
    if (Array.isArray(value)) {
      flattened.push(...flattenCommunicationIdentityValues(value))
      return
    }
    if (isPlainObject(value)) {
      flattened.push(
        ...flattenCommunicationIdentityValues([
          value.phone,
          value.phoneNumber,
          value.phone_number,
          value.email,
          value.address,
          value.value,
        ]),
      )
      return
    }
    const text = safeLeadText(value)
    if (text) flattened.push(text)
  })
  return flattened
}

function communicationIdentityLinks(communication = {}, contactId) {
  const provider = safeLeadText(communication.provider || 'speak')
  const verifiedAt = new Date().toISOString()
  return communicationIdentityCandidates(communication, {
    direction: communicationDirectionForIdentityCandidates(communication),
  }).map((identity) => ({
    contactId,
    kind: identity.kind,
    normalizedValue: identity.normalizedValue,
    source: provider,
    confidence: 'verified',
    verifiedAt,
  }))
}

function verifiedIdentityLinkMatches(workspace, identity) {
  return (workspace?.contactIdentityLinks || [])
    .filter((link) => !link.supersededBy)
    .filter((link) => link.confidence === 'verified')
    .filter((link) => link.kind === identity.kind)
    .filter((link) => link.normalizedValue === identity.normalizedValue)
    .filter((link, index, links) => (
      links.findIndex((candidate) => candidate.contactId === link.contactId) === index
    ))
}

function workspaceLeadIdentityMatches(workspace, identity) {
  return (workspace?.leads || [])
    .filter((lead) => {
      if (identity.kind === 'phone') return normalizePhone(lead.phone || '') === identity.normalizedValue
      if (identity.kind === 'email') return cleanEmail(lead.email || '') === identity.normalizedValue
      return false
    })
    .filter((lead, index, leads) => leads.findIndex((candidate) => candidate.id === lead.id) === index)
}

function findWorkspaceLeadById(workspace, contactId) {
  const id = safeLeadText(contactId)
  return (workspace?.leads || []).find((lead) => lead.id === id) || null
}

function hasLeadIdentitySource(value) {
  if (!isPlainObject(value)) return false
  return Boolean(
    safeLeadText(value.id) ||
      normalizePhone(value.phone || value.contact_phone || value.phone_on_file || '') ||
      cleanEmail(value.email || value.contact_email || value.email_on_file || '') ||
      safeLeadText(value.name || value.company),
  )
}

function firstPlainObject(...values) {
  return values.find(isPlainObject) || null
}

function firstSafeText(...values) {
  return values.map((value) => safeLeadText(value)).find(Boolean) || ''
}

function normalizeCommunicationEvent(input = {}, workspace) {
  const event = input.event && typeof input.event === 'object' ? input.event : {}
  const communication = event.communication && typeof event.communication === 'object'
    ? event.communication
    : {}
  const entry = event.entry && typeof event.entry === 'object' ? event.entry : {}
  const attribution = resolveCommunicationAttribution(workspace, input, communication)
  const leadSource = firstPlainObject(input.lead, input.state?.lead, attribution.lead)
  const lead = hasLeadIdentitySource(leadSource) ? normalizeWorkspaceLead(leadSource) : {}
  const contactId = safeLeadText(communication.contactId || lead.id || attribution.contactId)
  const callControlId = safeLeadText(input.callControlId || input.state?.callControlId)
  const chatId = safeLeadText(input.chatId || input.state?.chatId || event.patch?.chatId)
  const agent = input.agent && typeof input.agent === 'object'
    ? input.agent
    : agentContextFromConfig(input.state?.config || input.config || {})
  const agentProfileId = safeLeadText(
    communication.agentProfileId ||
      agent.id ||
      input.state?.config?.agentProfileId ||
      input.state?.config?.speakConfigId,
  )
  const runtimeProvider = safeLeadText(
    input.state?.config?.voiceRuntimeProvider ||
      input.config?.voiceRuntimeProvider ||
      agent.voiceRuntimeProvider ||
      'speak',
  )
  const channel = normalizeCommunicationChannel(
    communication.channel ||
      input.channel ||
      event.channel ||
      (input.state?.browserTest ||
      input.state?.origin === 'playground_browser' ||
      input.state?.origin === 'playground_phone'
        ? 'browser_test'
        : 'call'),
    'call',
  )
  const body = safeLeadText(
    communication.body ||
      entry.text ||
      event.notice ||
      event.patch?.phase ||
      event.outcome ||
      '',
  )
  if (!body && !event.patch && !event.leadPatch && !event.audio) return null

  const role = normalizeCommunicationRole(
    communication.role || roleForTranscriptSpeaker(entry.speaker),
    'system',
  )
  const direction = normalizeCommunicationDirection(
    communication.direction || directionForRole(role),
    'system',
  )
  const modality = normalizeCommunicationModality(
    communication.modality || modalityForEvent(channel, role, event),
    'status',
  )
  const at = normalizeCommunicationTimestamp(communication.at || entry.at || input.createdAt)
  const threadId = safeLeadText(communication.threadId) ||
    (contactId
      ? stableCommunicationId('thread-contact', contactId)
      : stableCommunicationId(
          'thread-unresolved',
          channel,
          attribution.identityKey || callControlId || chatId || communication.sourceEventId,
        ))
  const communicationProviderIds = isPlainObject(communication.providerIds)
    ? communication.providerIds
    : {}
  const identityProviderIds = communicationIdentityProviderIds({
    communication,
    direction,
  })
  const providerIds = cleanObject({
    ...identityProviderIds,
    ...communicationProviderIds,
    callControlId,
    chatId,
    providerEventId:
      communicationProviderIds.providerEventId ||
      communication.providerEventId ||
      entry.providerEventId,
    sourceEventId:
      communicationProviderIds.sourceEventId ||
      communication.sourceEventId ||
      entry.id,
    messageId:
      communicationProviderIds.messageId ||
      communication.providerMessageId ||
      communication.proof?.message_id,
    emailThreadId:
      communicationProviderIds.emailThreadId ||
      communication.emailThreadId ||
      communication.proof?.thread_id ||
      identityProviderIds.emailThreadId,
  })
  const messageId = safeLeadText(communication.messageId) ||
    stableCommunicationId(
      'message',
      threadId,
      providerIds.sourceEventId || providerIds.messageId || entry.id || at,
      body,
    )

  return {
    threadId,
    messageId,
    contactId,
    agentProfileId,
    channel,
    modality,
    direction,
    role,
    body,
    bodyStatus: communication.bodyStatus || (body ? 'final' : 'not_applicable'),
    provider: safeLeadText(communication.provider || providerForChannel(channel, runtimeProvider)),
    providerIds,
    proof: communication.proof || event.proof || {},
    attachments: attachmentListForCommunicationEvent(communication, event),
    emotionScores: entry.emotionScores,
    at,
    threadStatus: threadStatusForEvent(event, contactId),
    identityConfidence: contactId ? attribution.confidence || 'verified' : 'unresolved',
    identityLinks: attribution.identityLinks,
    lead,
    agent,
    providerLinks: providerLinksForEvent({ callControlId, chatId, runtimeProvider, communication }),
    channels: channelsForEvent(channel, communication.proof || event.proof || {}),
  }
}

function upsertCommunicationThread(workspace, event) {
  const existing = workspace.communicationThreads.find((thread) => thread.threadId === event.threadId)
  const channelSet = new Set([...(existing?.channels || []), ...event.channels])
  const providerLinks = mergeProviderLinks(existing?.providerLinks || [], event.providerLinks)
  const participants = mergeParticipants(existing?.participants || [], participantsForEvent(event))
  const thread = normalizeCommunicationThread({
    ...existing,
    threadId: event.threadId,
    contactId: event.contactId || existing?.contactId || '',
    agentProfileId: event.agentProfileId || existing?.agentProfileId || '',
    status: event.threadStatus || existing?.status || 'open',
    channels: Array.from(channelSet),
    participants,
    identityConfidence: event.identityConfidence || existing?.identityConfidence || 'unresolved',
    providerLinks,
    createdAt: existing?.createdAt || event.at,
    updatedAt: event.at,
  })
  workspace.communicationThreads = [
    thread,
    ...workspace.communicationThreads.filter((item) => item.threadId !== thread.threadId),
  ]
  return thread
}

function hydrateCommunicationThreadMetrics(workspace, thread = {}) {
  const messages = workspace.communicationMessages.filter(
    (message) => message.threadId === thread.threadId,
  ).sort((left, right) => left.at.localeCompare(right.at) || left.messageId.localeCompare(right.messageId))
  const emotionScoreTurns = messages.filter((message) =>
    Boolean(normalizeEmotionScores(message.emotionScores)),
  ).length
  const latest = messages[messages.length - 1]
  const summary = messages.length ? summarizeCommunicationMessages(messages) : thread.summary
  return normalizeCommunicationThread({
    ...thread,
    messageCount: messages.length || thread.messageCount,
    emotionScoreTurns: emotionScoreTurns || thread.emotionScoreTurns,
    hasEmotionScores: emotionScoreTurns > 0 || thread.hasEmotionScores,
    summary,
    latestChannel: latest?.channel || thread.latestChannel,
    latestMessagePreview: communicationMessagePreview(latest) || thread.latestMessagePreview,
  })
}

function upsertCommunicationMessage(workspace, event, thread) {
  const message = normalizeCommunicationMessage({
    messageId: event.messageId,
    threadId: thread.threadId,
    contactId: event.contactId,
    agentProfileId: event.agentProfileId,
    channel: event.channel,
    modality: event.modality,
    direction: event.direction,
    role: event.role,
    body: event.body,
    bodyStatus: event.bodyStatus,
    provider: event.provider,
    providerIds: event.providerIds,
    proof: event.proof,
    attachments: event.attachments,
    emotionScores: event.emotionScores,
    at: event.at,
  })
  const sourceDedupKey = communicationProviderSourceDedupKey(message)
  const removedThreadIds = new Set()
  workspace.communicationMessages = [
    ...workspace.communicationMessages.filter((item) => {
      const sameMessageId = item.messageId === message.messageId
      const sameProviderSource =
        sourceDedupKey &&
        communicationProviderSourceDedupKey(item) === sourceDedupKey
      if ((sameMessageId || sameProviderSource) && item.threadId !== message.threadId) {
        removedThreadIds.add(item.threadId)
      }
      return !sameMessageId && !sameProviderSource
    }),
    message,
  ].sort((left, right) => left.at.localeCompare(right.at) || left.messageId.localeCompare(right.messageId))
  return { message, removedThreadIds: Array.from(removedThreadIds) }
}

function rebuildThreadMaterializedState(workspace, threadId) {
  const messages = workspace.communicationMessages
    .filter((message) => message.threadId === threadId)
    .sort((left, right) => left.at.localeCompare(right.at) || left.messageId.localeCompare(right.messageId))
  const threadIndex = workspace.communicationThreads.findIndex((thread) => thread.threadId === threadId)
  if (threadIndex < 0) return []
  const thread = workspace.communicationThreads[threadIndex]
  const latest = messages[messages.length - 1]
  const summary = summarizeCommunicationMessages(messages)
  const topic = normalizeCommunicationTopic({
    topicId: stableCommunicationId('topic', threadId, 'summary'),
    threadId,
    contactId: thread.contactId,
    label: 'Recent conversation',
    summary,
    status: thread.status,
    confidence: 'materialized',
    sourceMessageIds: messages.slice(-8).map((message) => message.messageId),
    updatedAt: latest?.at || thread.updatedAt,
  })
  const topicIds = topic.summary ? [topic.topicId] : []
  workspace.communicationTopics = [
    ...workspace.communicationTopics.filter((item) => item.topicId !== topic.topicId),
    ...(topic.summary ? [topic] : []),
  ]
  workspace.communicationThreads[threadIndex] = normalizeCommunicationThread({
    ...thread,
    topicIds,
    messageCount: messages.length,
    emotionScoreTurns: messages.filter((message) =>
      Boolean(normalizeEmotionScores(message.emotionScores)),
    ).length,
    hasEmotionScores: messages.some((message) =>
      Boolean(normalizeEmotionScores(message.emotionScores)),
    ),
    summary,
    latestChannel: latest?.channel || thread.latestChannel,
    latestMessagePreview: communicationMessagePreview(latest) || thread.latestMessagePreview,
    lastMessageId: latest?.messageId || thread.lastMessageId,
    lastInboundAt: latest?.direction === 'inbound' ? latest.at : thread.lastInboundAt,
    lastOutboundAt: latest?.direction === 'outbound' ? latest.at : thread.lastOutboundAt,
    updatedAt: latest?.at || thread.updatedAt,
  })
  return topic.summary ? [topic] : []
}

function rebuildOrRemoveCommunicationThread(workspace, threadId) {
  const id = safeLeadText(threadId)
  if (!id) return []
  const hasMessages = workspace.communicationMessages.some((message) => message.threadId === id)
  if (hasMessages) return rebuildThreadMaterializedState(workspace, id)
  workspace.communicationThreads = workspace.communicationThreads.filter((thread) => thread.threadId !== id)
  workspace.communicationTopics = workspace.communicationTopics.filter((topic) => topic.threadId !== id)
  return []
}

function workspaceEmailMailboxThreadIdentityRepairReport(workspace, mailboxEmail, {
  mode = 'dry-run',
} = {}) {
  const mailboxSlug = stableCommunicationSlug(mailboxEmail)
  const oldPrefix = `thread-unresolved-email-email-${mailboxSlug}-external-thread-`
  const groups = new Map()

  for (const thread of workspace.communicationThreads) {
    const threadId = safeLeadText(thread.threadId)
    if (!threadId.startsWith(oldPrefix)) continue
    if (thread.contactId) continue
    if (thread.status !== 'unresolved_attribution') continue
    if (!thread.channels.includes('email')) continue

    const externalThreadSlug = threadId.slice(oldPrefix.length)
    if (!externalThreadSlug) continue
    const newThreadId = `thread-unresolved-email-external-thread-${externalThreadSlug}`
    const messageCount = workspace.communicationMessages
      .filter((message) => message.threadId === threadId)
      .length
    const topicCount = workspace.communicationTopics
      .filter((topic) => topic.threadId === threadId)
      .length
    const existing = groups.get(newThreadId) || {
      oldThreadIds: [],
      newThreadId,
      targetExists: workspace.communicationThreads.some((item) => item.threadId === newThreadId),
      messageCount: 0,
      topicCount: 0,
    }
    existing.oldThreadIds.push(threadId)
    existing.messageCount += messageCount
    existing.topicCount += topicCount
    groups.set(newThreadId, existing)
  }

  const repairs = Array.from(groups.values()).map((repair) => ({
    ...repair,
    oldThreadIds: repair.oldThreadIds.sort(),
  }))
  const movedMessages = repairs.reduce((total, repair) => total + repair.messageCount, 0)
  return {
    schemaVersion: 'speak.workspace-email-thread-identity-repair.v1',
    ok: true,
    mode,
    mailboxEmail,
    mailboxSlug,
    scannedThreads: workspace.communicationThreads.length,
    repairableThreads: repairs.reduce((total, repair) => total + repair.oldThreadIds.length, 0),
    movedMessages,
    repairs,
    failures: [],
  }
}

function applyWorkspaceEmailMailboxThreadIdentityRepair(workspace, repairs = []) {
  for (const repair of repairs) {
    const oldThreadIds = new Set(repair.oldThreadIds || [])
    const newThreadId = safeLeadText(repair.newThreadId)
    if (!oldThreadIds.size || !newThreadId) continue

    const mergedThreads = workspace.communicationThreads.filter(
      (thread) => oldThreadIds.has(thread.threadId) || thread.threadId === newThreadId,
    )
    if (!mergedThreads.length) continue

    workspace.communicationMessages = workspace.communicationMessages.map((message) => (
      oldThreadIds.has(message.threadId)
        ? normalizeCommunicationMessage({ ...message, threadId: newThreadId })
        : message
    ))
    workspace.communicationTopics = workspace.communicationTopics.filter(
      (topic) => !oldThreadIds.has(topic.threadId) && topic.threadId !== newThreadId,
    )
    workspace.communicationThreads = workspace.communicationThreads.filter(
      (thread) => !oldThreadIds.has(thread.threadId) && thread.threadId !== newThreadId,
    )
    workspace.communicationThreads.unshift(mergedCommunicationThreadForRepair(mergedThreads, newThreadId))
    rebuildThreadMaterializedState(workspace, newThreadId)
  }
}

function communicationSourceDedupRepairReport(workspace, {
  mode = 'dry-run',
} = {}) {
  const groups = new Map()
  for (const message of workspace.communicationMessages) {
    const dedupKey = communicationProviderSourceDedupKey(message)
    if (!dedupKey) continue
    const messages = groups.get(dedupKey) || []
    messages.push(message)
    groups.set(dedupKey, messages)
  }

  const repairs = Array.from(groups.entries())
    .filter(([, messages]) => messages.length > 1)
    .map(([dedupKey, messages]) => {
      const keep = preferredCommunicationSourceMessage(messages)
      const removed = messages
        .filter((message) => message.messageId !== keep.messageId)
        .sort((left, right) => left.messageId.localeCompare(right.messageId))
      const affectedThreadIds = Array.from(new Set(messages.map((message) => message.threadId).filter(Boolean))).sort()
      return {
        dedupKey,
        keepMessageId: keep.messageId,
        keepThreadId: keep.threadId,
        provider: keep.provider,
        channel: keep.channel,
        sourceEventId: firstSafeText(
          keep.providerIds?.sourceEventId,
          keep.providerIds?.providerEventId,
          keep.providerIds?.messageId,
        ),
        removedMessageIds: removed.map((message) => message.messageId),
        affectedThreadIds,
      }
    })
  const removedMessages = repairs.reduce((total, repair) => total + repair.removedMessageIds.length, 0)
  return {
    schemaVersion: 'speak.communication-source-dedup-repair.v1',
    ok: true,
    mode,
    scannedMessages: workspace.communicationMessages.length,
    duplicateGroups: repairs.length,
    removedMessages,
    repairs,
    failures: [],
  }
}

function applyCommunicationSourceDedupRepair(workspace, repairs = []) {
  const removedMessageIds = new Set()
  const affectedThreadIds = new Set()
  repairs.forEach((repair) => {
    repair.removedMessageIds?.forEach((messageId) => removedMessageIds.add(messageId))
    repair.affectedThreadIds?.forEach((threadId) => affectedThreadIds.add(threadId))
  })
  if (!removedMessageIds.size) return
  workspace.communicationMessages = workspace.communicationMessages.filter(
    (message) => !removedMessageIds.has(message.messageId),
  )
  affectedThreadIds.forEach((threadId) => rebuildOrRemoveCommunicationThread(workspace, threadId))
}

function defaultOffInboundCallRepairReport(workspace, {
  mode = 'dry-run',
} = {}) {
  const repairs = workspace.communicationMessages
    .filter(defaultOffInboundCallRepairCandidate)
    .map((message) => {
      const previousBody = safeLeadText(message.body)
      const nextBody = defaultOffInboundCallRepairBody(message)
      const proof = isPlainObject(message.proof) ? message.proof : {}
      return {
        messageId: message.messageId,
        threadId: message.threadId,
        provider: message.provider,
        channel: message.channel,
        previousBody,
        nextBody,
        previousAction: safeLeadText(proof.action),
        nextAction: 'missed_call',
      }
    })

  return {
    schemaVersion: 'speak.default-off-inbound-call-repair.v1',
    ok: true,
    mode,
    scannedMessages: workspace.communicationMessages.length,
    repairableMessages: repairs.length,
    repairedMessages: mode === 'apply' ? repairs.length : 0,
    repairs,
    failures: [],
  }
}

function applyDefaultOffInboundCallRepair(workspace, repairs = []) {
  const repairByMessageId = new Map(
    repairs.map((repair) => [safeLeadText(repair.messageId), repair]),
  )
  if (!repairByMessageId.size) return
  const affectedThreadIds = new Set()

  workspace.communicationMessages = workspace.communicationMessages.map((message) => {
    const repair = repairByMessageId.get(message.messageId)
    if (!repair) return message
    affectedThreadIds.add(message.threadId)
    const proof = isPlainObject(message.proof) ? message.proof : {}
    const automation = isPlainObject(proof.automation) ? proof.automation : {}
    return normalizeCommunicationMessage({
      ...message,
      body: repair.nextBody,
      proof: cleanObject({
        ...proof,
        action: 'missed_call',
        automation: cleanObject({
          ...automation,
          inboundCallAutoAnswer: false,
        }),
      }),
    })
  })

  affectedThreadIds.forEach((threadId) => rebuildOrRemoveCommunicationThread(workspace, threadId))
}

function defaultOffInboundCallRepairCandidate(message = {}) {
  if (normalizeCommunicationChannel(message.channel, '') !== 'call') return false
  if (safeLeadText(message.direction).toLowerCase() !== 'inbound') return false
  const body = safeLeadText(message.body)
  if (!body || /\b(missed|no[_ -]?answer|unanswered)\b/i.test(body)) return false
  const proof = isPlainObject(message.proof) ? message.proof : {}
  const automation = isPlainObject(proof.automation) ? proof.automation : {}
  const reason = safeLeadText(automation.reason).toLowerCase()
  const autoAnswerWasOff =
    automation.inboundCallAutoAnswer === false ||
    /\b(record_only|default_off|no_explicit_context_policy)\b/i.test(reason)
  if (!autoAnswerWasOff) return false
  return /^inbound call(?:\s+received)?\b/i.test(body)
}

function defaultOffInboundCallRepairBody(message = {}) {
  const body = safeLeadText(message.body)
  if (/\b(missed|no[_ -]?answer|unanswered)\b/i.test(body)) {
    return body || 'Missed inbound call'
  }
  if (/^inbound call received\b/i.test(body)) {
    return body.replace(/^inbound call received\b/i, 'Missed inbound call')
  }
  if (/^inbound call\b/i.test(body)) {
    return body.replace(/^inbound call\b/i, 'Missed inbound call')
  }
  return body ? `Missed inbound call (${body})` : 'Missed inbound call'
}

function preferredCommunicationSourceMessage(messages = []) {
  return [...messages].sort(compareCommunicationSourceMessages).at(-1) || messages[0]
}

function compareCommunicationSourceMessages(left = {}, right = {}) {
  const leftScore = communicationSourceMessageScore(left)
  const rightScore = communicationSourceMessageScore(right)
  for (let index = 0; index < leftScore.length; index += 1) {
    const comparison = leftScore[index].localeCompare(rightScore[index])
    if (comparison !== 0) return comparison
  }
  return 0
}

function communicationSourceMessageScore(message = {}) {
  return [
    message.contactId ? '1' : '0',
    message.messageId === canonicalCommunicationProviderMessageId(message) ? '1' : '0',
    String(safeLeadText(message.body).length).padStart(8, '0'),
    safeLeadText(message.at),
    safeLeadText(message.messageId),
  ]
}

function canonicalCommunicationProviderMessageId(message = {}) {
  const providerIds = isPlainObject(message.providerIds) ? message.providerIds : {}
  const sourceId = firstSafeText(
    providerIds.sourceEventId,
    providerIds.providerEventId,
    providerIds.messageId,
  )
  const threadId = safeLeadText(message.threadId)
  if (!threadId || !sourceId) return ''
  return stableCommunicationId('message', threadId, sourceId, message.body)
}

function communicationProviderSourceDedupKey(message = {}) {
  const providerIds = isPlainObject(message.providerIds) ? message.providerIds : {}
  const channel = normalizeCommunicationChannel(message.channel, '')
  const provider = safeLeadText(message.provider || providerIds.provider)
  const sourceId = firstSafeText(
    providerIds.sourceEventId,
    providerIds.providerEventId,
    providerIds.messageId,
  )
  if (!channel || !sourceId) return ''
  return stableCommunicationId('provider-source', channel, provider, sourceId)
}

function mergedCommunicationThreadForRepair(threads, newThreadId) {
  const ordered = [...threads].sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
  const first = ordered[0] || {}
  const latest = ordered[ordered.length - 1] || {}
  const channels = new Set()
  const topicIds = new Set()
  for (const thread of ordered) {
    for (const channel of thread.channels || []) channels.add(channel)
    for (const topicId of thread.topicIds || []) topicIds.add(topicId)
  }
  return normalizeCommunicationThread({
    ...first,
    ...latest,
    threadId: newThreadId,
    contactId: latest.contactId || first.contactId || '',
    status: latest.status || first.status || 'unresolved_attribution',
    channels: Array.from(channels),
    participants: mergeParticipantsForRepair(ordered),
    topicIds: Array.from(topicIds),
    providerLinks: mergeProviderLinksForRepair(ordered),
    createdAt: ordered
      .map((thread) => thread.createdAt)
      .filter(Boolean)
      .sort()[0] || first.createdAt,
    updatedAt: ordered
      .map((thread) => thread.updatedAt)
      .filter(Boolean)
      .sort()
      .at(-1) || latest.updatedAt,
  })
}

function mergeParticipantsForRepair(threads) {
  const seen = new Set()
  const participants = []
  for (const thread of threads) {
    for (const participant of thread.participants || []) {
      const key = JSON.stringify(participant)
      if (seen.has(key)) continue
      seen.add(key)
      participants.push(participant)
    }
  }
  return participants
}

function mergeProviderLinksForRepair(threads) {
  let links = []
  for (const thread of threads) {
    links = mergeProviderLinks(links, thread.providerLinks || [])
  }
  return links
}

function upsertContactIdentityLinks(workspace, event) {
  if (!event.contactId) return
  const links = [
    ...identityLinksForLead(event.lead, event.contactId),
    ...(Array.isArray(event.identityLinks) ? event.identityLinks : []),
  ]
  links.forEach((link) => {
    const key = identityLinkKey(link)
    workspace.contactIdentityLinks = [
      normalizeContactIdentityLink(link),
      ...workspace.contactIdentityLinks.filter((item) => identityLinkKey(item) !== key),
    ]
  })
}

function communicationMemoryForWorkspace(workspace, contactId, limit = 3) {
  const threads = workspace.communicationThreads
    .filter((thread) => thread.contactId === contactId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, Math.max(0, Number(limit) || 0))
  return threads.map((thread) => {
    const topicIds = new Set(thread.topicIds)
    const topics = workspace.communicationTopics
      .filter((topic) => topicIds.has(topic.topicId))
      .map((topic) => ({
        topicId: topic.topicId,
        label: topic.label,
        summary: topic.summary,
        status: topic.status,
      }))
    const messages = workspace.communicationMessages
      .filter((message) => message.threadId === thread.threadId)
      .sort((left, right) => right.at.localeCompare(left.at))
      .slice(0, 6)
      .reverse()
      .map((message) => ({
        messageId: message.messageId,
        channel: message.channel,
        role: message.role,
        direction: message.direction,
        at: message.at,
        text: message.body,
      }))
    return {
      threadId: thread.threadId,
      status: thread.status,
      channels: thread.channels,
      updatedAt: thread.updatedAt,
      summary: thread.summary,
      topics,
      recentMessages: messages,
    }
  })
}

function summarizeCommunicationMessages(messages) {
  return messages
    .filter((message) => message.body && !['system'].includes(message.role))
    .slice(-5)
    .map((message) => `${message.role}: ${communicationMessagePreview(message)}`)
    .join(' | ')
    .slice(0, 1200)
}

function communicationMessagePreview(message = {}) {
  const body = safeLeadText(message?.body)
  if (!body) return ''
  if (message?.channel !== 'email') return body
  return emailSubjectPreview(body)
}

function emailSubjectPreview(value) {
  const text = safeLeadText(value)
  if (!text) return ''
  const subjectMatch = text.match(/^Subject:\s*([^\n\r]*)(?:\r?\n\r?\n[\s\S]*)?$/i)
  if (subjectMatch) return subjectMatch[1]?.trim() || 'No subject'
  return text.split(/\r?\n/)[0]?.trim() || 'No subject'
}

function channelsForEvent(channel, proof = {}) {
  const channels = new Set([channel])
  if (proof?.sms) channels.add('sms')
  if (proof?.email) channels.add('email')
  return Array.from(channels).filter((item) => communicationChannels.has(item))
}

function normalizeCommunicationChannel(value, fallback) {
  const channel = safeLeadText(value)
  return communicationChannels.has(channel) ? channel : fallback
}

function normalizeCommunicationChannelList(value) {
  const channels = normalizeStringList(value).filter((channel) => communicationChannels.has(channel))
  return Array.from(new Set(channels.length ? channels : ['system']))
}

function normalizeCommunicationModality(value, fallback) {
  const modality = safeLeadText(value)
  return communicationModalities.has(modality) ? modality : fallback
}

function normalizeCommunicationDirection(value, fallback) {
  const direction = safeLeadText(value)
  return communicationDirections.has(direction) ? direction : fallback
}

function normalizeCommunicationRole(value, fallback) {
  const role = safeLeadText(value)
  return communicationRoles.has(role) ? role : fallback
}

function normalizeIdentityConfidence(value) {
  const confidence = safeLeadText(value)
  return communicationIdentityConfidence.has(confidence) ? confidence : 'unresolved'
}

function normalizeBodyStatus(value) {
  const status = safeLeadText(value)
  if (['partial', 'final', 'redacted', 'not_applicable'].includes(status)) return status
  return 'final'
}

function normalizeCommunicationTimestamp(value) {
  const text = safeLeadText(value)
  if (!text) return new Date().toISOString()
  const date = new Date(text)
  if (!Number.isNaN(date.getTime())) return date.toISOString()
  return new Date().toISOString()
}

function boundedLimit(value, fallback, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(1, Math.min(max, Math.floor(number)))
}

function workspaceSearchScore(value, query) {
  if (!query) return 1
  const haystack = safeLeadText(value).toLowerCase()
  const index = haystack.indexOf(query)
  if (index === -1) return 0
  return index === 0 ? 4 : haystack.includes(` ${query}`) ? 3 : 2
}

function parseLeadIdFilter(value) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => parseLeadIdFilter(item))
  }
  return safeLeadText(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function workspaceLeadMatchesQuery(lead, query) {
  if (!query) return true
  return [
    lead.company,
    lead.name,
    lead.firstName,
    lead.lastName,
    lead.phone,
    lead.email,
    lead.state,
    lead.status,
    lead.lastCall,
    lead.notes,
    lead.tags?.join(' '),
    lead.source,
    lead.sourceName,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .includes(query)
}

function workspaceContextSearchText(context = {}) {
  return [
    context?.text,
    context?.urls?.join(' '),
    context?.urlSnapshots
      ?.map((snapshot) =>
        [
          snapshot.url,
          snapshot.title,
          snapshot.text,
          snapshot.status,
          snapshot.error,
          snapshot.contentType,
        ].join(' '),
      )
      .join(' '),
    context?.files
      ?.map((file) =>
        [
          file.name,
          file.type,
          file.preview,
          file.extractedText,
          file.extractionStatus,
          file.extractionError,
        ].join(' '),
      )
      .join(' '),
  ].filter(Boolean).join(' ')
}

function roleForTranscriptSpeaker(value) {
  const speaker = String(value || '').trim().toLowerCase()
  if (['lead', 'caller', 'contact', 'customer', 'user'].includes(speaker)) return 'contact'
  if (['ai', 'agent', 'assistant'].includes(speaker)) return 'agent'
  if (speaker === 'tool') return 'tool'
  if (speaker === 'operator' || speaker === 'you') return 'operator'
  return 'system'
}

function directionForRole(role) {
  if (role === 'contact') return 'inbound'
  if (role === 'agent') return 'outbound'
  if (role === 'operator' || role === 'tool') return 'internal'
  return 'system'
}

function modalityForEvent(channel, role, event = {}) {
  if (channel === 'sms' || channel === 'email' || channel === 'operator_chat') return 'text'
  if (role === 'tool') return 'tool'
  if (event.audio) return 'audio'
  if (channel === 'call') return 'voice'
  return 'status'
}

function providerForChannel(channel, runtimeProvider) {
  if (channel === 'sms') return 'telnyx'
  if (channel === 'email') return 'google_workspace'
  if (channel === 'call' || channel === 'browser_test') return runtimeProvider || 'speak'
  return 'speak'
}

function threadStatusForEvent(event, contactId) {
  if (!contactId) return 'unresolved_attribution'
  const phase = safeLeadText(event.patch?.phase)
  const outcome = safeLeadText(event.patch?.outcome || event.outcome)
  if (phase === 'ended' || outcome) return 'resolved'
  return 'open'
}

function attachmentListForCommunicationEvent(communication = {}, event = {}) {
  const attachments = []
  if (Array.isArray(communication.attachments)) {
    attachments.push(...communication.attachments.filter(isPlainObject))
  }
  if (Array.isArray(event.attachments)) {
    attachments.push(...event.attachments.filter(isPlainObject))
  }
  if (event.audio && typeof event.audio === 'object') {
    attachments.push(event.audio)
  }
  return dedupeAttachments(attachments)
}

function dedupeAttachments(attachments = []) {
  const seen = new Set()
  return attachments.filter((attachment) => {
    const key = [
      safeLeadText(attachment.provider),
      safeLeadText(attachment.source),
      safeLeadText(attachment.kind || attachment.type),
      safeLeadText(attachment.id || attachment.callRecordingFsFileId || attachment.url),
    ].join(':')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function providerLinksForEvent({ callControlId, chatId, runtimeProvider, communication = {} }) {
  const links = Array.isArray(communication.providerLinks) ? [...communication.providerLinks] : []
  const communicationProviderIds = isPlainObject(communication.providerIds)
    ? communication.providerIds
    : {}
  const communicationProvider = safeLeadText(communication.provider)
  const linkedCallControlId =
    callControlId ||
    communicationProviderIds.callControlId ||
    communicationProviderIds.call_control_id
  if (linkedCallControlId) {
    links.push({
      provider: communicationProvider === 'calltools' ? 'calltools' : 'telnyx',
      kind: communicationProvider === 'calltools' ? 'call' : 'call_control',
      id: linkedCallControlId,
    })
  }
  const callToolsCallId =
    communicationProviderIds.calltoolsCallId ||
    communicationProviderIds.callToolsCallId ||
    communicationProviderIds.calltools_call_id
  if (callToolsCallId) {
    links.push({ provider: 'calltools', kind: 'call', id: callToolsCallId })
  }
  const callToolsRecordingFsFileId =
    communicationProviderIds.calltoolsRecordingFsFileId ||
    communicationProviderIds.callToolsRecordingFsFileId ||
    communicationProviderIds.calltools_recording_fsfile_id
  if (callToolsRecordingFsFileId) {
    links.push({
      provider: 'calltools',
      kind: 'recording',
      id: callToolsRecordingFsFileId,
    })
  }
  const callToolsContactId =
    communicationProviderIds.calltoolsContactId ||
    communicationProviderIds.callToolsContactId ||
    communicationProviderIds.calltools_contact_id
  if (callToolsContactId) {
    links.push({ provider: 'calltools', kind: 'contact', id: callToolsContactId })
  }
  const callToolsCampaignId =
    communicationProviderIds.calltoolsCampaignId ||
    communicationProviderIds.callToolsCampaignId ||
    communicationProviderIds.calltools_campaign_id
  if (callToolsCampaignId) {
    links.push({ provider: 'calltools', kind: 'campaign', id: callToolsCampaignId })
  }
  const callToolsWebCallbackId =
    communicationProviderIds.calltoolsWebCallbackId ||
    communicationProviderIds.callToolsWebCallbackId ||
    communicationProviderIds.calltools_web_callback_id
  if (callToolsWebCallbackId) {
    links.push({ provider: 'calltools', kind: 'web_callback', id: callToolsWebCallbackId })
  }
  const callToolsWebCallbackRequestId =
    communicationProviderIds.calltoolsWebCallbackRequestId ||
    communicationProviderIds.callToolsWebCallbackRequestId ||
    communicationProviderIds.calltools_web_callback_request_id
  if (callToolsWebCallbackRequestId) {
    links.push({
      provider: 'calltools',
      kind: 'web_callback_request',
      id: callToolsWebCallbackRequestId,
    })
  }
  if (chatId) {
    links.push({ provider: runtimeProvider || 'speak', kind: 'voice_session', id: chatId })
  }
  return normalizeProviderLinks(links)
}

function normalizeProviderLinks(value) {
  return (Array.isArray(value) ? value : [])
    .filter(isPlainObject)
    .map((link) => ({
      provider: safeLeadText(link.provider || 'speak'),
      kind: safeLeadText(link.kind || link.type || 'provider_link'),
      id: safeLeadText(link.id || link.value),
    }))
    .filter((link) => link.id)
    .filter(uniqueProviderLink)
}

function mergeProviderLinks(left, right) {
  return normalizeProviderLinks([...(left || []), ...(right || [])])
}

function uniqueProviderLink(link, index, links) {
  const key = `${link.provider}:${link.kind}:${link.id}`
  return links.findIndex((candidate) => `${candidate.provider}:${candidate.kind}:${candidate.id}` === key) === index
}

function participantsForEvent(event) {
  const participants = []
  if (event.contactId) {
    participants.push({
      role: 'contact',
      contactId: event.contactId,
      label: safeLeadText(event.lead?.name || event.lead?.company || event.contactId),
    })
  }
  if (event.agentProfileId) {
    participants.push({
      role: 'agent',
      agentProfileId: event.agentProfileId,
      label: safeLeadText(event.agent?.name || event.agentProfileId),
    })
  }
  if (event.provider) {
    participants.push({
      role: 'provider',
      provider: event.provider,
      label: event.provider,
    })
  }
  return participants
}

function mergeParticipants(left, right) {
  const merged = []
  const seen = new Set()
  ;[...(left || []), ...(right || [])].filter(isPlainObject).forEach((participant) => {
    const key = [
      participant.role,
      participant.contactId,
      participant.agentProfileId,
      participant.provider,
      participant.label,
    ].map((item) => safeLeadText(item)).join(':')
    if (seen.has(key)) return
    seen.add(key)
    merged.push(participant)
  })
  return merged
}

function identityLinksForLead(lead, contactId) {
  const links = []
  const phone = normalizePhone(lead?.phone || lead?.contact_phone || lead?.phone_on_file || '')
  const email = cleanEmail(lead?.email || lead?.contact_email || lead?.email_on_file || '')
  const verifiedAt = new Date().toISOString()
  if (phone) {
    links.push({
      contactId,
      kind: 'phone',
      normalizedValue: phone,
      source: 'speak',
      confidence: 'verified',
      verifiedAt,
    })
  }
  if (email) {
    links.push({
      contactId,
      kind: 'email',
      normalizedValue: email,
      source: 'speak',
      confidence: 'verified',
      verifiedAt,
    })
  }
  return links
}

function reconcileWorkspaceLeadIdentityLinks(workspace, previousLead, nextLead) {
  const contactId = safeLeadText(nextLead?.id)
  if (!contactId) return

  const previousValues = {
    phone: normalizePhone(previousLead?.phone || ''),
    email: cleanEmail(previousLead?.email || ''),
  }
  const nextValues = {
    phone: normalizePhone(nextLead?.phone || ''),
    email: cleanEmail(nextLead?.email || ''),
  }

  for (const kind of ['phone', 'email']) {
    const previousValue = previousValues[kind]
    const nextValue = nextValues[kind]
    if (previousValue === nextValue) continue

    const replacement = nextValue
      ? normalizeContactIdentityLink({
          contactId,
          kind,
          normalizedValue: nextValue,
          source: 'speak',
          confidence: 'verified',
          verifiedAt: new Date().toISOString(),
        })
      : null
    const supersededBy = replacement
      ? identityLinkKey(replacement)
      : `${kind}:cleared:${contactId}:speak`

    workspace.contactIdentityLinks = workspace.contactIdentityLinks.map((link) => {
      if (
        link.contactId !== contactId ||
        link.kind !== kind ||
        link.source !== 'speak' ||
        link.confidence !== 'verified' ||
        link.supersededBy ||
        link.normalizedValue !== previousValue
      ) {
        return link
      }
      return normalizeContactIdentityLink({ ...link, supersededBy })
    })

    if (replacement) {
      const replacementKey = identityLinkKey(replacement)
      workspace.contactIdentityLinks = [
        replacement,
        ...workspace.contactIdentityLinks.filter(
          (link) => identityLinkKey(link) !== replacementKey,
        ),
      ]
    }
  }
}

function identityLinkKey(link) {
  return [link.kind, link.normalizedValue, link.contactId, link.source]
    .map((item) => safeLeadText(item))
    .join(':')
}

function stableCommunicationId(prefix, ...parts) {
  const key = stableCommunicationSlug(...parts)
  return `${prefix}-${key || randomUUID()}`
}

function stableCommunicationSlug(...parts) {
  return parts
    .map((part) => safeLeadText(part))
    .filter(Boolean)
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)
}

function agentContextFromConfig(config = {}) {
  const source = config && typeof config === 'object' ? config : {}
  return {
    id: safeLeadText(source.agentProfileId || source.speakConfigId || source.humeConfigId || source.inworldConfigId),
    name: safeLeadText(source.agentProfileName || source.name),
    voiceRuntimeProvider: safeLeadText(source.voiceRuntimeProvider),
  }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function normalizeLeadStatus(value) {
  const status = String(value || '').trim()
  return leadStatuses.has(status) ? status : 'ready'
}

function mergeSourceLead(existing, imported) {
  if (!existing) return imported
  const merged = { ...imported }

  if (!contextHasContent(imported.context) && contextHasContent(existing.context)) {
    merged.context = normalizeContextFields(existing.context)
  }
  if (isDefaultSourceStatus(imported.status) && !isDefaultSourceStatus(existing.status)) {
    merged.status = existing.status
  }
  if (isDefaultLastCall(imported.lastCall) && !isDefaultLastCall(existing.lastCall)) {
    merged.lastCall = existing.lastCall
  }
  if (!safeLeadText(imported.notes) && safeLeadText(existing.notes)) {
    merged.notes = existing.notes
  }
  if (imported.tags.length === 0 && existing.tags.length > 0) {
    merged.tags = existing.tags
  }
  merged.providerIds = {
    ...(existing.providerIds || {}),
    ...(imported.providerIds || {}),
  }
  if (
    (isGenericLeadName(imported.name) || nameMatchesCompany(imported)) &&
    !isGenericLeadName(existing.name) &&
    !nameMatchesCompany(existing)
  ) {
    merged.name = existing.name
    merged.firstName = existing.firstName
    merged.lastName = existing.lastName
  }
  if (isUnknownBusiness(imported.company) && !isUnknownBusiness(existing.company)) {
    merged.company = existing.company
  }

  return normalizeWorkspaceLead(merged)
}

function isDefaultSourceStatus(value) {
  return normalizeLeadStatus(value) === 'ready'
}

function isDefaultLastCall(value) {
  const lastCall = safeLeadText(value).toLowerCase()
  return !lastCall || lastCall === 'never'
}

function isGenericLeadName(value) {
  return /^(imported\s+lead(?:\s+\d+)?|unknown\s+contact)$/i.test(
    cleanName(value || ''),
  )
}

function isUnknownBusiness(value) {
  const business = safeLeadText(value).toLowerCase()
  return !business || business === 'unknown business'
}

function nameMatchesCompany(lead) {
  const name = normalizeKey(lead?.name)
  const company = normalizeKey(lead?.company)
  return Boolean(name && company && name === company)
}

function resolveWorkspaceProfileForConfig(profiles = [], config = {}) {
  const index = resolveWorkspaceProfileIndexForConfig(profiles, config)
  return index >= 0 ? profiles[index] : null
}

function resolveWorkspaceProfileIndexForConfig(profiles = [], config = {}) {
  const source = config && typeof config === 'object' ? config : {}
  const candidates = [
    source.agentProfileId,
    source.speakConfigId,
    source.humeConfigId,
    source.inworldConfigId,
  ]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)

  const matchedIndex = candidates.length
    ? profiles.findIndex((profile) => {
      const values = [
        profile.id,
        profile.config?.agentProfileId,
        profile.config?.speakConfigId,
        profile.config?.humeConfigId,
        profile.config?.inworldConfigId,
      ]
        .map((value) => String(value || '').trim().toLowerCase())
        .filter(Boolean)
      return values.some((value) => candidates.includes(value))
    })
    : -1

  if (matchedIndex >= 0) return matchedIndex

  const nameCandidate = String(source.agentProfileName || '').trim().toLowerCase()
  if (!nameCandidate) return -1

  const nameMatches = profiles
    .map((profile, index) => {
      const values = [profile.name, profile.config?.agentProfileName]
        .map((value) => String(value || '').trim().toLowerCase())
        .filter(Boolean)
      return values.includes(nameCandidate) ? index : -1
    })
    .filter((index) => index >= 0)

  return nameMatches.length === 1 ? nameMatches[0] : -1
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return []
  return value.map((item) => String(item || '').trim()).filter(Boolean)
}

function normalizeFlexibleStringList(value) {
  if (Array.isArray(value)) return normalizeStringList(value)
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function normalizeActiveProfileId(value, profiles) {
  const id = String(value || '').trim()
  if (id && profiles.some((profile) => profile.id === id)) return id
  return profiles[0]?.id || ''
}

function leadFingerprints(lead) {
  const phone = String(lead.phone || '').replace(/\D/g, '')
  const email = String(lead.email || '').trim().toLowerCase()
  const name = normalizeKey(lead.name)
  const company = normalizeKey(lead.company)

  return [
    phone ? `phone:${phone}` : '',
    email ? `email:${email}` : '',
    name && company ? `name-company:${name}:${company}` : '',
  ].filter(Boolean)
}

function normalizeKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

function stableSourceKey(value) {
  return normalizeKey(value).slice(0, 64) || randomUUID()
}

function isDeletedLead(lead, workspace) {
  const deletedIds = new Set(workspace.deletedLeadIds)
  const deletedFingerprints = new Set(workspace.deletedLeadFingerprints)
  return (
    deletedIds.has(lead.id) ||
    leadFingerprints(lead).some((fingerprint) => deletedFingerprints.has(fingerprint))
  )
}

async function readWorkspace() {
  const cache = await readCachedWorkspaceEntry()
  return structuredClone(cache.workspace)
}

async function readCachedWorkspaceEntry() {
  let observedFingerprint
  let lastReadError = null
  try {
    observedFingerprint = await workspaceFileFingerprint()
  } catch (error) {
    workspaceStorageStats.cacheMisses += 1
    if (workspaceCache) return workspaceCache
    throw error
  }

  if (workspaceCache?.fingerprint?.key === observedFingerprint.key) {
    workspaceStorageStats.cacheHits += 1
    return workspaceCache
  }

  workspaceStorageStats.cacheMisses += 1
  if (workspaceCache) workspaceStorageStats.externalInvalidations += 1

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!observedFingerprint.exists) {
      workspaceCache = createWorkspaceCacheEntry(emptyWorkspace(), observedFingerprint)
      return workspaceCache
    }

    try {
      workspaceStorageStats.diskReads += 1
      const contents = await readFile(workspaceFilePath, 'utf8')
      const readbackFingerprint = await workspaceFileFingerprint()
      if (readbackFingerprint.key !== observedFingerprint.key) {
        observedFingerprint = readbackFingerprint
        continue
      }
      let parsed
      try {
        parsed = JSON.parse(contents)
      } catch (error) {
        throw Object.assign(new Error('Speak workspace JSON is invalid'), {
          cause: error,
          code: 'workspace_json_invalid',
        })
      }
      workspaceStorageStats.normalizations += 1
      workspaceCache = createWorkspaceCacheEntry(
        normalizeWorkspace(parsed),
        readbackFingerprint,
      )
      return workspaceCache
    } catch (error) {
      lastReadError = error
      try {
        observedFingerprint = await workspaceFileFingerprint()
      } catch {
        break
      }
    }
  }

  if (workspaceCache) return workspaceCache
  throw lastReadError || new Error('Speak workspace could not be read consistently')
}

function mutateWorkspace(mutator) {
  const run = workspaceMutationQueue.then(async () => {
    const workspace = await readWorkspace()
    const result = await mutator(workspace)
    const snapshot = await writeWorkspace(workspace)
    return result === undefined ? snapshot : result
  })
  workspaceMutationQueue = run.catch(() => undefined)
  return run
}

async function writeWorkspace(workspace) {
  const normalized = normalizeWorkspace({
    ...workspace,
    updatedAt: new Date().toISOString(),
  })
  await mkdir(workspaceDataDir, { recursive: true })
  const tempPath = `${workspaceFilePath}.${process.pid}.tmp`
  await writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`)
  const tempFingerprint = await workspaceFileFingerprint(tempPath)
  await rename(tempPath, workspaceFilePath)
  const fingerprint = await workspaceFileFingerprint()
  workspaceStorageStats.writes += 1
  workspaceStorageStats.normalizations += 1
  workspaceCache = sameWorkspaceFileIdentity(tempFingerprint, fingerprint)
    ? createWorkspaceCacheEntry(structuredClone(normalized), fingerprint)
    : null
  return publicWorkspace(structuredClone(normalized))
}

async function workspaceFileFingerprint(filePath = workspaceFilePath) {
  try {
    const fileStat = await stat(filePath)
    return {
      exists: true,
      dev: fileStat.dev,
      ino: fileStat.ino,
      size: fileStat.size,
      key: [
        fileStat.dev,
        fileStat.ino,
        fileStat.size,
        fileStat.mtimeMs,
        fileStat.ctimeMs,
      ].join(':'),
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { exists: false, key: 'missing' }
    }
    throw error
  }
}

function sameWorkspaceFileIdentity(left, right) {
  return Boolean(
    left?.exists &&
    right?.exists &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size
  )
}

function createWorkspaceCacheEntry(workspace, fingerprint) {
  const normalized = deepFreeze(workspace)
  const leadById = new Map()
  const uniqueLeadByPhone = new Map()
  const uniqueLeadByEmail = new Map()

  normalized.leads.forEach((lead) => {
    if (lead.id) leadById.set(lead.id, lead)
    indexUniqueLead(uniqueLeadByPhone, normalizePhone(lead.phone), lead)
    indexUniqueLead(uniqueLeadByEmail, cleanEmail(lead.email), lead)
  })

  return {
    fingerprint,
    workspace: normalized,
    leadById,
    uniqueLeadByPhone,
    uniqueLeadByEmail,
  }
}

function indexUniqueLead(index, key, lead) {
  if (!key) return
  if (!index.has(key)) {
    index.set(key, lead)
    return
  }
  index.set(key, null)
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  Object.values(value).forEach((item) => deepFreeze(item, seen))
  return Object.freeze(value)
}

function normalizeWorkspace(value = {}) {
  const profiles = normalizeProfileList(value.profiles)
  return {
    version: workspaceVersion,
    updatedAt: value.updatedAt || new Date().toISOString(),
    leads: normalizeLeadList(value.leads),
    deletedLeadIds: normalizeStringList(value.deletedLeadIds),
    deletedLeadFingerprints: normalizeStringList(value.deletedLeadFingerprints),
    smartViews: normalizeSmartViewList(value.smartViews),
    profiles,
    activeProfileId: normalizeActiveProfileId(value.activeProfileId, profiles),
    dialerState: normalizeWorkspaceDialerState(value.dialerState),
    communicationThreads: normalizeCommunicationThreadList(value.communicationThreads),
    communicationMessages: normalizeCommunicationMessageList(value.communicationMessages),
    communicationTopics: normalizeCommunicationTopicList(value.communicationTopics),
    contactIdentityLinks: normalizeContactIdentityLinkList(value.contactIdentityLinks),
  }
}

function publicWorkspace(workspace) {
  return {
    version: workspace.version,
    updatedAt: workspace.updatedAt,
    leads: workspace.leads,
    deletedLeadIds: workspace.deletedLeadIds,
    deletedLeadFingerprints: workspace.deletedLeadFingerprints,
    contactSources: summarizeWorkspaceContactSources(workspace),
    smartViews: workspace.smartViews,
    profiles: workspace.profiles,
    activeProfileId: workspace.activeProfileId,
    dialerState: workspace.dialerState,
    communicationThreads: workspace.communicationThreads,
    communicationMessages: workspace.communicationMessages,
    communicationTopics: workspace.communicationTopics,
    contactIdentityLinks: workspace.contactIdentityLinks,
  }
}

function emptyWorkspace() {
  return normalizeWorkspace({})
}
