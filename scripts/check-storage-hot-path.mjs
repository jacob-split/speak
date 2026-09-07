import assert from 'node:assert/strict'
import {
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const rootDir = await mkdtemp(path.join(os.tmpdir(), 'speak-storage-hot-path-'))
const workspaceDir = path.join(rootDir, 'workspace')
const callLogDir = path.join(rootDir, 'call-logs')
const workspaceFilePath = path.join(workspaceDir, 'workspace.json')
process.env.SPEAK_WORKSPACE_DATA_DIR = workspaceDir

const baseLead = {
  id: 'lead-exact',
  name: 'Exact Contact',
  company: 'Exact Company',
  phone: '+1 (555) 555-0101',
  email: 'EXACT@example.com',
  context: {
    text: 'Cached contact context',
    urls: ['https://example.com/context'],
    urlSnapshots: [{ url: 'https://example.com/context', text: 'Existing snapshot' }],
  },
}
const baseProfile = {
  id: 'profile-selected',
  name: 'Selected Agent',
  config: {
    agentProfileId: 'profile-selected',
    speakConfigId: 'speak-selected',
    voiceRuntimeProvider: 'inworld',
  },
  context: { text: 'Cached profile context' },
}

const fillerLeads = Array.from({ length: 1_000 }, (_, index) => ({
  id: `lead-filler-${index}`,
  name: `Filler ${index}`,
  company: `Filler Company ${index}`,
  phone: `+15556${String(index).padStart(5, '0')}`,
  email: `filler-${index}@example.com`,
}))

const fixture = {
  version: 6,
  updatedAt: '2026-07-14T12:00:00.000Z',
  leads: [
    baseLead,
    {
      id: 'lead-phone-duplicate-a',
      name: 'Duplicate A',
      company: 'Duplicate A Company',
      phone: '+15555550102',
      email: 'duplicate-a@example.com',
    },
    {
      id: 'lead-phone-duplicate-b',
      name: 'Duplicate B',
      company: 'Duplicate B Company',
      phone: '+15555550102',
      email: 'unique-email@example.com',
    },
    {
      id: 'lead-phone-unique',
      name: 'Phone Unique',
      company: 'Phone Unique Company',
      phone: '+15555550103',
      email: 'phone-unique@example.com',
    },
    ...fillerLeads,
  ],
  profiles: [baseProfile],
  activeProfileId: baseProfile.id,
}

try {
  await writeWorkspaceFixture(fixture)
  assert.doesNotMatch(
    readFileSync(new URL('../server/call-history.mjs', import.meta.url), 'utf8'),
    /\bappendFileSync\b/,
    'realtime call-event persistence must not reintroduce synchronous append IO',
  )
  assert.match(
    readFileSync(new URL('../server/call-history.mjs', import.meta.url), 'utf8'),
    /!pending\.written/,
    'events already appended to disk must not also appear as queued readback records',
  )

  const workspaceStore = await import('../server/workspace-store.mjs')
  const callHistory = await import('../server/call-history.mjs')
  const {
    resolveWorkspaceRuntimeSnapshot,
    recordCommunicationEvents,
    workspaceSnapshot,
    workspaceStorageDiagnostics,
  } = workspaceStore
  const {
    callEventPersistenceDiagnostics,
    deletePersistedCallSummaries,
    flushPersistedCallEvents,
    persistCallEvent,
    recentCallSummaries,
  } = callHistory

  assert.equal(typeof resolveWorkspaceRuntimeSnapshot, 'function')
  assert.equal(typeof workspaceStorageDiagnostics, 'function')
  assert.equal(typeof flushPersistedCallEvents, 'function')
  assert.equal(typeof callEventPersistenceDiagnostics, 'function')
  assert.equal(typeof recordCommunicationEvents, 'function')

  const initialDiagnostics = workspaceStorageDiagnostics()
  const firstSnapshot = await workspaceSnapshot()
  const afterFirstRead = workspaceStorageDiagnostics()
  assert.equal(afterFirstRead.diskReads - initialDiagnostics.diskReads, 1)
  assert.equal(firstSnapshot.leads.length, fixture.leads.length)

  firstSnapshot.leads[0].name = 'Caller mutation must not reach cache'
  firstSnapshot.profiles[0].context.text = 'Caller profile mutation must not reach cache'
  const secondSnapshot = await workspaceSnapshot()
  const afterSecondRead = workspaceStorageDiagnostics()
  assert.equal(secondSnapshot.leads[0].name, baseLead.name)
  assert.equal(secondSnapshot.profiles[0].context.text, baseProfile.context.text)
  assert.equal(afterSecondRead.diskReads, afterFirstRead.diskReads)
  assert.ok(afterSecondRead.cacheHits > afterFirstRead.cacheHits)

  const beforeRuntimeBytes = await readFile(workspaceFilePath, 'utf8')
  const beforeRuntimeStat = await stat(workspaceFilePath)
  const exact = await resolveWorkspaceRuntimeSnapshot({
    lead: {
      id: baseLead.id,
      phone: '+19999999999',
      email: 'wrong@example.com',
    },
    config: { agentProfileId: baseProfile.id },
  })
  assert.equal(exact.lead.id, baseLead.id, 'exact stored id must take precedence')
  assert.equal(exact.lead.name, baseLead.name)
  assert.equal(exact.profile.id, baseProfile.id)
  assert.equal(exact.profileContext.text, baseProfile.context.text)

  exact.lead.name = 'Runtime caller mutation'
  exact.profile.context.text = 'Runtime profile caller mutation'
  const exactReadback = await resolveWorkspaceRuntimeSnapshot({
    lead: { id: baseLead.id },
    config: { speakConfigId: 'speak-selected' },
  })
  assert.equal(exactReadback.lead.name, baseLead.name)
  assert.equal(exactReadback.profile.context.text, baseProfile.context.text)

  const profileContextFallback = await resolveWorkspaceRuntimeSnapshot({
    lead: { id: baseLead.id },
    config: {
      agentProfileId: 'profile-not-persisted',
      profileContext: { text: 'Runtime config profile context' },
    },
  })
  assert.equal(profileContextFallback.profile, null)
  assert.equal(profileContextFallback.profileContext.text, 'Runtime config profile context')

  const uniquePhone = await resolveWorkspaceRuntimeSnapshot({
    lead: { phone: '+1 (555) 555-0103', company: 'Incoming Company' },
    config: { agentProfileId: baseProfile.id },
  })
  assert.equal(uniquePhone.lead.id, 'lead-phone-unique')

  const uniqueEmail = await resolveWorkspaceRuntimeSnapshot({
    lead: { phone: '+15555550102', email: 'UNIQUE-EMAIL@example.com' },
    config: { agentProfileId: baseProfile.id },
  })
  assert.equal(uniqueEmail.lead.id, 'lead-phone-duplicate-b')

  const conflictingUniqueIdentities = await resolveWorkspaceRuntimeSnapshot({
    lead: {
      id: 'incoming-conflicting-identities',
      phone: '+15555550103',
      email: 'unique-email@example.com',
      company: 'Incoming Conflict Company',
    },
    config: { agentProfileId: baseProfile.id },
  })
  assert.equal(conflictingUniqueIdentities.lead.id, 'incoming-conflicting-identities')
  assert.equal(conflictingUniqueIdentities.lead.company, 'Incoming Conflict Company')

  const ambiguousPhone = await resolveWorkspaceRuntimeSnapshot({
    lead: {
      id: 'incoming-not-stored',
      phone: '+15555550102',
      company: 'Incoming Ambiguous Company',
    },
    config: { agentProfileId: baseProfile.id },
  })
  assert.equal(ambiguousPhone.lead.id, 'incoming-not-stored')
  assert.equal(ambiguousPhone.lead.company, 'Incoming Ambiguous Company')

  const afterRuntimeBytes = await readFile(workspaceFilePath, 'utf8')
  const afterRuntimeStat = await stat(workspaceFilePath)
  assert.equal(afterRuntimeBytes, beforeRuntimeBytes)
  assert.equal(afterRuntimeStat.mtimeMs, beforeRuntimeStat.mtimeMs)
  assert.equal(
    workspaceStorageDiagnostics().writes,
    0,
    'read-only runtime snapshots must not refresh URLs or mutate workspace storage',
  )

  const externalFixture = structuredClone(fixture)
  externalFixture.updatedAt = '2026-07-14T12:01:00.000Z'
  externalFixture.leads[0].name = 'Externally Updated Contact'
  await writeWorkspaceFixture(externalFixture, { atomicReplace: true })
  const externalReadback = await resolveWorkspaceRuntimeSnapshot({
    lead: { id: baseLead.id },
    config: { agentProfileId: baseProfile.id },
  })
  const afterExternalRead = workspaceStorageDiagnostics()
  assert.equal(externalReadback.lead.name, 'Externally Updated Contact')
  assert.ok(afterExternalRead.externalInvalidations >= 1)
  assert.equal(afterExternalRead.diskReads, afterSecondRead.diskReads + 1)

  const invalidTempPath = `${workspaceFilePath}.invalid.tmp`
  await writeFile(invalidTempPath, '{ invalid workspace json')
  await rename(invalidTempPath, workspaceFilePath)
  const lastKnownGoodReadback = await resolveWorkspaceRuntimeSnapshot({
    lead: { id: baseLead.id },
    config: { agentProfileId: baseProfile.id },
  })
  assert.equal(
    lastKnownGoodReadback.lead.name,
    'Externally Updated Contact',
    'a corrupt or unstable workspace read must preserve the last known-good cache',
  )

  const recoveredFixture = structuredClone(externalFixture)
  recoveredFixture.updatedAt = '2026-07-14T12:02:00.000Z'
  recoveredFixture.leads[0].name = 'Recovered Contact'
  await writeWorkspaceFixture(recoveredFixture, { atomicReplace: true })
  const recoveredReadback = await resolveWorkspaceRuntimeSnapshot({
    lead: { id: baseLead.id },
    config: { agentProfileId: baseProfile.id },
  })
  assert.equal(recoveredReadback.lead.name, 'Recovered Contact')

  const beforeCommunicationBatch = workspaceStorageDiagnostics()
  const communicationState = {
    callControlId: 'call-batched-communication',
    lead: recoveredFixture.leads[0],
    config: baseProfile.config,
  }
  const communicationBatch = await recordCommunicationEvents(
    ['Caller turn', 'Agent turn', 'Call ended'].map((text, index) => ({
      callControlId: communicationState.callControlId,
      state: communicationState,
      lead: communicationState.lead,
      createdAt: `2026-07-14T12:03:0${index}.000Z`,
      event: {
        entry: {
          id: `batch-entry-${index}`,
          at: `2026-07-14T12:03:0${index}.000Z`,
          speaker: index === 0 ? 'Lead' : index === 1 ? 'AI' : 'System',
          text,
        },
        patch: index === 2 ? { phase: 'ended', outcome: 'completed' } : undefined,
      },
    })),
  )
  const afterCommunicationBatch = workspaceStorageDiagnostics()
  assert.equal(communicationBatch.events.length, 3)
  assert.equal(
    afterCommunicationBatch.writes - beforeCommunicationBatch.writes,
    1,
    'deferred call communication events must commit in one workspace write',
  )

  const callState = {
    lead: baseLead,
    config: {
      agentProfileId: baseProfile.id,
      agentProfileName: baseProfile.name,
      voiceRuntimeProvider: 'inworld',
    },
  }
  const beforeQueue = callEventPersistenceDiagnostics()
  const writes = Array.from({ length: 80 }, (_, index) => persistCallEvent({
    callLogDir,
    callControlId: 'call-ordered',
    state: callState,
    event: { sequence: index, notice: `event-${index}` },
    leadForState: (state) => state.lead,
  }))
  const queued = callEventPersistenceDiagnostics()
  assert.equal(queued.enqueued - beforeQueue.enqueued, 80)
  assert.equal(queued.pending - beforeQueue.pending, 80)
  assert.equal(
    queued.completed,
    beforeQueue.completed,
    'event persistence must be queued without blocking the realtime caller',
  )
  assert.ok(writes.every((write) => write && typeof write.then === 'function'))

  const immediateSummary = recentCallSummaries({
    callStates: [],
    callLogDir,
    limit: 10,
    leadForState: (state) => state.lead,
  }).find((summary) => summary.callControlId === 'call-ordered')
  assert.ok(immediateSummary, 'queued events must remain readable before disk flush')

  await Promise.all(writes)
  await flushPersistedCallEvents()
  const afterFlush = callEventPersistenceDiagnostics()
  assert.equal(afterFlush.pending, beforeQueue.pending)
  assert.equal(afterFlush.completed - beforeQueue.completed, 80)
  assert.equal(afterFlush.failed - beforeQueue.failed, 0)

  assert.ok(existsSync(callLogDir))
  const eventFiles = readdirSync(callLogDir)
    .filter((name) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
  assert.equal(eventFiles.length, 1)
  const records = readFileSync(path.join(callLogDir, eventFiles[0]), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.deepEqual(records.map((record) => record.event.sequence), [...Array(80).keys()])

  const flushedSummary = recentCallSummaries({
    callStates: [],
    callLogDir,
    limit: 10,
    leadForState: (state) => state.lead,
  }).find((summary) => summary.callControlId === 'call-ordered')
  assert.ok(flushedSummary)
  assert.deepEqual(flushedSummary.latestEvents, [
    'event-72',
    'event-73',
    'event-74',
    'event-75',
    'event-76',
    'event-77',
    'event-78',
    'event-79',
  ])

  const canceledWrites = Array.from({ length: 3 }, (_, index) => persistCallEvent({
    callLogDir,
    callControlId: 'call-canceled-before-flush',
    state: callState,
    event: { sequence: index, notice: `canceled-${index}` },
    leadForState: (state) => state.lead,
  }))
  const deletion = deletePersistedCallSummaries({
    callLogDir,
    callControlIds: ['call-canceled-before-flush'],
  })
  assert.deepEqual(deletion.deleted, ['call-canceled-before-flush'])
  await Promise.all(canceledWrites)
  await flushPersistedCallEvents()
  const deletedSummary = recentCallSummaries({
    callStates: [],
    callLogDir,
    limit: 10,
    leadForState: (state) => state.lead,
  }).find((summary) => summary.callControlId === 'call-canceled-before-flush')
  assert.equal(deletedSummary, undefined)

  const largeRacePayload = 'x'.repeat(8 * 1024 * 1024)
  const unrelatedRaceWrite = persistCallEvent({
    callLogDir,
    callControlId: 'call-unrelated-during-delete',
    state: callState,
    event: { notice: 'unrelated-race-event', payload: largeRacePayload },
    leadForState: (state) => state.lead,
  })
  const deletedRaceWrite = persistCallEvent({
    callLogDir,
    callControlId: 'call-deleted-during-append',
    state: callState,
    event: { notice: 'deleted-race-event' },
    leadForState: (state) => state.lead,
  })
  await new Promise((resolve) => setImmediate(resolve))
  deletePersistedCallSummaries({
    callLogDir,
    callControlIds: ['call-deleted-during-append'],
  })
  await Promise.all([unrelatedRaceWrite, deletedRaceWrite])
  await flushPersistedCallEvents()

  const raceRecords = readPersistedRecords(callLogDir)
  assert.equal(
    raceRecords.filter((record) => (
      record.callControlId === 'call-unrelated-during-delete'
    )).length,
    1,
    'a synchronous delete during async append must retain one copy of unrelated events',
  )
  assert.equal(
    raceRecords.some((record) => record.callControlId === 'call-deleted-during-append'),
    false,
    'a canceled event must not reappear after an in-flight append completes',
  )

  const quiescentFirst = persistCallEvent({
    callLogDir,
    callControlId: 'call-quiescent-flush',
    state: callState,
    event: { sequence: 1, notice: 'quiescent-1' },
    leadForState: (state) => state.lead,
  })
  const quiescentFlush = flushPersistedCallEvents()
  const quiescentSecond = Promise.resolve().then(() => persistCallEvent({
    callLogDir,
    callControlId: 'call-quiescent-flush',
    state: callState,
    event: { sequence: 2, notice: 'quiescent-2' },
    leadForState: (state) => state.lead,
  }))
  await Promise.all([quiescentFirst, quiescentSecond, quiescentFlush])
  assert.deepEqual(
    readPersistedRecords(callLogDir)
      .filter((record) => record.callControlId === 'call-quiescent-flush')
      .map((record) => record.event.sequence),
    [1, 2],
    'flush must wait until the append queue is quiescent',
  )

  const blockedCallLogDir = path.join(rootDir, 'blocked-call-log-dir')
  await writeFile(blockedCallLogDir, 'not a directory')
  const beforeFailure = callEventPersistenceDiagnostics()
  const persistenceWarnings = []
  const originalWarn = console.warn
  try {
    console.warn = (...args) => persistenceWarnings.push(args)
    await assert.rejects(
      persistCallEvent({
        callLogDir: blockedCallLogDir,
        callControlId: 'call-write-failure',
        state: callState,
        event: { notice: 'must-fail' },
        leadForState: (state) => state.lead,
      }),
      (error) => ['EEXIST', 'ENOTDIR'].includes(error?.code),
    )
    await assert.rejects(
      flushPersistedCallEvents(),
      (error) => {
        assert.ok(error instanceof AggregateError)
        assert.equal(error.errors.length, 1)
        return true
      },
      'flush must surface queued persistence failures',
    )
  } finally {
    console.warn = originalWarn
  }
  const afterFailure = callEventPersistenceDiagnostics()
  assert.equal(afterFailure.failed - beforeFailure.failed, 1)
  assert.equal(afterFailure.pending, 0)
  assert.equal(afterFailure.unreportedFailures, 0)
  assert.equal(persistenceWarnings.length, 1)

  await persistCallEvent({
    callLogDir,
    callControlId: 'call-after-write-failure',
    state: callState,
    event: { notice: 'queue-recovered' },
    leadForState: (state) => state.lead,
  })
  await flushPersistedCallEvents()
  assert.ok(
    readPersistedRecords(callLogDir)
      .some((record) => record.callControlId === 'call-after-write-failure'),
    'a failed append must not poison later queue work',
  )

  console.log(JSON.stringify({
    ok: true,
    schemaVersion: 'speak.storage-hot-path.v1',
    workspace: workspaceStorageDiagnostics(),
    callEvents: callEventPersistenceDiagnostics(),
    checks: {
      cacheReuse: true,
      externalStatInvalidation: true,
      lastKnownGoodReadFallback: true,
      mutationIsolation: true,
      readOnlyRuntimeSnapshot: true,
      orderedAsyncCallEventPersistence: true,
      atomicDeleteAppendSerialization: true,
      quiescentFailureSurfacing: true,
      batchedCommunicationPersistence: true,
    },
  }, null, 2))
} finally {
  await rm(rootDir, { recursive: true, force: true })
}

async function writeWorkspaceFixture(value, { atomicReplace = false } = {}) {
  await mkdir(workspaceDir, { recursive: true })
  const destination = atomicReplace ? `${workspaceFilePath}.external.tmp` : workspaceFilePath
  await writeFile(destination, `${JSON.stringify(value, null, 2)}\n`)
  if (atomicReplace) await rename(destination, workspaceFilePath)
}

function readPersistedRecords(directory) {
  return readdirSync(directory)
    .filter((name) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .flatMap((name) => readFileSync(path.join(directory, name), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line)))
}
