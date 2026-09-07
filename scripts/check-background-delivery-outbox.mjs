import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

import {
  BACKGROUND_DELIVERY_OUTBOX_SCHEMA,
  createBackgroundDeliveryFingerprint,
  createDurableBackgroundDeliveryOutbox,
} from '../server/background-delivery.mjs'
import * as delivery from '../server/delivery.mjs'
import * as telnyxNormalizer from '../server/telnyx-webhook-normalizer.mjs'

const root = process.cwd()
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'speak-delivery-outbox-'))

try {
  await verifyDurableAdmissionAndDeduplication()
  await verifyBoundedSafeRetry()
  await verifyAtMostOnceCrashFence()
  await verifyMutationPersistenceRecovery()
  await verifyProviderAcceptancePersistenceFailureFence()
  await verifyConfirmedProviderFailureRemainsFailed()
  await verifyTelnyxSmsFinalizationContract()
  verifyTelnyxFinalizationCommunicationProof()
  verifyPortalSmsBrandContract()
  await verifyCrashRecoveryBeforeProviderDispatch()
  await verifyVoiceToolCrashRecovery()
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      schemaVersion: BACKGROUND_DELIVERY_OUTBOX_SCHEMA,
      checks: [
        'durable_admission_before_processing',
        'stable_fingerprint_deduplication',
        'bounded_safe_retry',
        'at_most_once_dispatch_fence',
        'mutation_persistence_recovery',
        'provider_acceptance_persistence_failure_fence',
        'confirmed_provider_failure_terminal_status',
        'telnyx_finalized_delivery_proof',
        'telnyx_finalized_failure_proof',
        'telnyx_finalized_before_settlement',
        'telnyx_finalization_readback_recovery',
        'telnyx_finalization_timeout_unverified',
        'telnyx_finalization_communication_proof',
        'portal_sms_workspace_brand',
        'crash_restart_recovery',
        'voice_tool_crash_restart_recovery',
        'terminal_proof_persistence',
      ],
    })}\n`,
  )
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}

async function verifyDurableAdmissionAndDeduplication() {
  const persistencePath = path.join(tempRoot, 'admission.json')
  const scheduled = []
  const providerCalls = []
  const outbox = createDurableBackgroundDeliveryOutbox({
    persistencePath,
    schedule: (operation) => scheduled.push(operation),
    execute: async (job) => {
      providerCalls.push(job.requestId)
      return { id: 'provider-message-1', status: 'queued' }
    },
    settle: async (_job, outcome) => ({
      ...outcome,
      sent: true,
      proof: { message_id: outcome.providerResult.id },
    }),
  })
  await outbox.start()

  const fingerprintInput = {
    scope: 'call-1',
    channel: 'sms',
    provider: 'telnyx',
    destination: '+15550000002',
    content: 'Hello from Speak.',
  }
  const fingerprint = createBackgroundDeliveryFingerprint(fingerprintInput)
  assert.equal(
    fingerprint,
    createBackgroundDeliveryFingerprint({
      content: 'Hello from Speak.',
      destination: '+15550000002',
      provider: 'telnyx',
      channel: 'sms',
      scope: 'call-1',
    }),
    'delivery fingerprint must be stable across object insertion order',
  )

  const admitted = await outbox.admit({
    requestId: 'delivery-request-1',
    fingerprint,
    channel: 'sms',
    provider: 'telnyx',
    destination: '***0002',
    payload: { phone: '+15550000002', message: 'Hello from Speak.' },
    context: { callControlId: 'call-1' },
    safety: 'at_most_once',
    maxAttempts: 3,
  })
  assert.equal(providerCalls.length, 0, 'provider started before processing response returned')
  assert.equal(scheduled.length, 1, 'durably admitted job was not scheduled')
  assert.deepEqual(
    {
      ok: admitted.result.ok,
      pending: admitted.result.pending,
      sent: admitted.result.sent,
      status: admitted.result.status,
      request_id: admitted.result.request_id,
    },
    {
      ok: true,
      pending: true,
      sent: false,
      status: 'processing',
      request_id: 'delivery-request-1',
    },
    'admission did not return the fail-closed processing contract',
  )
  const admittedStore = JSON.parse(fs.readFileSync(persistencePath, 'utf8'))
  assert.equal(admittedStore.jobs[0].status, 'queued', 'processing returned before queued job persisted')
  assert.equal(admittedStore.jobs[0].fingerprint, fingerprint, 'stable fingerprint was not persisted')
  assert.equal(fs.statSync(persistencePath).mode & 0o077, 0, 'outbox file must not be group/world-readable')

  const duplicate = await outbox.admit({
    fingerprint,
    channel: 'sms',
    provider: 'telnyx',
    destination: '***0002',
    payload: { phone: '+15550000002', message: 'Hello from Speak.' },
    context: { callControlId: 'call-1' },
    safety: 'at_most_once',
  })
  assert.equal(duplicate.deduplicated, true, 'identical durable admission was not deduplicated')
  assert.equal(duplicate.result.request_id, 'delivery-request-1', 'duplicate changed request identity')
  assert.equal(scheduled.length, 1, 'duplicate admission scheduled a second provider operation')

  scheduled.shift()()
  const outcome = await admitted.completion
  assert.equal(outcome.sent, true, 'provider acceptance did not settle with sent proof')
  assert.equal(outcome.proof.message_id, 'provider-message-1')
  assert.equal(providerCalls.length, 1)
  const settledStore = JSON.parse(fs.readFileSync(persistencePath, 'utf8'))
  assert.equal(settledStore.jobs[0].status, 'accepted', 'accepted terminal status was not persisted')
  assert.equal(settledStore.jobs[0].outcome.proof.message_id, 'provider-message-1')
  await outbox.close({ drain: true })
}

async function verifyBoundedSafeRetry() {
  const persistencePath = path.join(tempRoot, 'retry.json')
  let attempts = 0
  const outbox = createDurableBackgroundDeliveryOutbox({
    persistencePath,
    retryBaseMs: 1,
    retryMaxMs: 2,
    execute: async () => {
      attempts += 1
      if (attempts === 1) {
        const error = new Error('provider rejected before accepting the request')
        error.safeToRetry = true
        throw error
      }
      return { id: 'provider-retry-proof', status: 'queued' }
    },
    settle: async (_job, outcome) => ({
      ...outcome,
      sent: outcome.ok,
      proof: outcome.ok ? { message_id: outcome.providerResult.id } : undefined,
    }),
  })
  await outbox.start()
  const queued = await outbox.admit({
    requestId: 'retry-request',
    fingerprint: createBackgroundDeliveryFingerprint({ scope: 'retry-request' }),
    channel: 'sms',
    provider: 'test',
    destination: '***0002',
    payload: { phone: '+15550000002', message: 'Retry me safely.' },
    safety: 'provider_idempotent',
    maxAttempts: 2,
  })
  const outcome = await queued.completion
  assert.equal(outcome.sent, true)
  assert.equal(attempts, 2, 'safe retry did not honor the bounded attempt count')
  const persisted = JSON.parse(fs.readFileSync(persistencePath, 'utf8')).jobs[0]
  assert.equal(persisted.attempts, 2)
  assert.equal(persisted.status, 'accepted')
  await outbox.close({ drain: true })
}

async function verifyAtMostOnceCrashFence() {
  const persistencePath = path.join(tempRoot, 'dispatching.json')
  const now = new Date().toISOString()
  fs.writeFileSync(
    persistencePath,
    `${JSON.stringify({
      schemaVersion: BACKGROUND_DELIVERY_OUTBOX_SCHEMA,
      revision: 1,
      updatedAt: now,
      jobs: [
        {
          requestId: 'indeterminate-email',
          fingerprint: createBackgroundDeliveryFingerprint({ scope: 'indeterminate-email' }),
          channel: 'email',
          provider: 'google_workspace',
          destination: 'c***@example.com',
          payload: { email: 'contact@example.com', subject: 'Subject', body: 'Body' },
          context: { callControlId: 'crashed-call' },
          safety: 'at_most_once',
          maxAttempts: 3,
          attempts: 1,
          status: 'dispatching',
          createdAt: now,
          updatedAt: now,
        },
      ],
    })}\n`,
    { mode: 0o600 },
  )
  let providerCalls = 0
  let failRecoveryPersistOnce = true
  const settled = []
  const outbox = createDurableBackgroundDeliveryOutbox({
    persistencePath,
    beforePersist: async (snapshot) => {
      if (
        failRecoveryPersistOnce &&
        snapshot.jobs.some((job) => job.status === 'accepted_unverified')
      ) {
        failRecoveryPersistOnce = false
        throw new Error('injected recovery fence persistence failure')
      }
    },
    execute: async () => {
      providerCalls += 1
      return { id: 'must-not-run' }
    },
    settle: async (_job, outcome) => {
      settled.push(outcome)
      return outcome
    },
  })
  await assert.rejects(outbox.start())
  assert.equal(
    outbox.snapshot().jobs.length,
    0,
    'failed startup recovery left an unscheduled in-memory job behind',
  )
  await outbox.start()
  await outbox.drain()
  assert.equal(providerCalls, 0, 'at-most-once recovery resent an indeterminate provider dispatch')
  assert.equal(settled[0]?.status, 'accepted_unverified')
  const persisted = JSON.parse(fs.readFileSync(persistencePath, 'utf8')).jobs[0]
  assert.equal(persisted.status, 'accepted_unverified')
  assert.equal(persisted.outcome.provider_accepted, true)
  assert.equal(persisted.outcome.sent, false)
  await outbox.close({ drain: true })
}

async function verifyProviderAcceptancePersistenceFailureFence() {
  const transientPath = path.join(tempRoot, 'provider-accepted-transient.json')
  let transientProviderCalls = 0
  let failAcceptancePersistOnce = true
  const transientOutbox = createDurableBackgroundDeliveryOutbox({
    persistencePath: transientPath,
    beforePersist: async (snapshot) => {
      if (
        failAcceptancePersistOnce &&
        snapshot.jobs.some((job) => job.status === 'provider_accepted')
      ) {
        failAcceptancePersistOnce = false
        throw new Error('injected provider acceptance persistence failure')
      }
    },
    execute: async () => {
      transientProviderCalls += 1
      return { id: 'transient-provider-proof', status: 'queued' }
    },
    settle: async (_job, outcome) => ({
      ...outcome,
      sent: true,
      proof: { message_id: outcome.providerResult.id },
    }),
    onError: () => {},
  })
  const transient = await transientOutbox.admit({
    requestId: 'provider-accepted-transient',
    fingerprint: createBackgroundDeliveryFingerprint({
      scope: 'provider-accepted-transient',
    }),
    channel: 'sms',
    provider: 'telnyx',
    destination: '***0002',
    payload: { phone: '+15550000002', message: 'Transient persistence failure.' },
    safety: 'at_most_once',
  })
  const transientOutcome = await transient.completion
  assert.equal(transientOutcome.sent, true)
  assert.equal(transientOutcome.proof.message_id, 'transient-provider-proof')
  assert.equal(transientProviderCalls, 1)
  assert.equal(
    JSON.parse(fs.readFileSync(transientPath, 'utf8')).jobs[0].status,
    'accepted',
    'a transient acceptance write failure did not recover through terminal proof persistence',
  )
  await transientOutbox.close({ drain: true })

  const persistentPath = path.join(tempRoot, 'provider-accepted-persistent.json')
  let persistentProviderCalls = 0
  const persistentOutbox = createDurableBackgroundDeliveryOutbox({
    persistencePath: persistentPath,
    beforePersist: async (snapshot) => {
      const status = snapshot.jobs[0]?.status
      if (
        persistentProviderCalls > 0 &&
        ['provider_accepted', 'accepted', 'accepted_unverified'].includes(status)
      ) {
        throw new Error('injected persistent terminal persistence failure')
      }
    },
    execute: async () => {
      persistentProviderCalls += 1
      return { id: 'persistent-provider-proof', status: 'queued' }
    },
    settle: async (_job, outcome) => ({
      ...outcome,
      sent: true,
      proof: { message_id: outcome.providerResult.id },
    }),
    onError: () => {},
  })
  const persistent = await persistentOutbox.admit({
    requestId: 'provider-accepted-persistent',
    fingerprint: createBackgroundDeliveryFingerprint({
      scope: 'provider-accepted-persistent',
    }),
    channel: 'email',
    provider: 'google_workspace',
    destination: 'c***@example.com',
    payload: {
      email: 'contact@example.com',
      subject: 'Persistence fence',
      body: 'Do not resend this accepted provider request.',
    },
    safety: 'at_most_once',
  })
  const persistentOutcome = await persistent.completion
  assert.equal(persistentOutcome.status, 'accepted_unverified')
  assert.equal(persistentOutcome.sent, false)
  assert.equal(persistentOutcome.provider_accepted, true)
  assert.equal(persistentProviderCalls, 1)
  assert.equal(
    JSON.parse(fs.readFileSync(persistentPath, 'utf8')).jobs[0].status,
    'dispatching',
    'the durable no-resend fence must remain dispatching when terminal persistence is unavailable',
  )
  assert.equal(persistentOutbox.snapshot().jobs[0].status, 'accepted_unverified')
  await Promise.race([
    persistentOutbox.drain(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('outbox drain wedged after persistence failure')), 500),
    ),
  ])
  await persistentOutbox.close({ drain: true })

  const recoveredOutbox = createDurableBackgroundDeliveryOutbox({
    persistencePath: persistentPath,
    execute: async () => {
      persistentProviderCalls += 1
      return { id: 'must-not-resend' }
    },
    settle: async (_job, outcome) => outcome,
  })
  await recoveredOutbox.start()
  await recoveredOutbox.drain()
  assert.equal(
    persistentProviderCalls,
    1,
    'restart resent a provider request after the terminal outbox persistence failure',
  )
  const recovered = JSON.parse(fs.readFileSync(persistentPath, 'utf8')).jobs[0]
  assert.equal(recovered.status, 'accepted_unverified')
  assert.equal(recovered.outcome.provider_accepted, true)
  await recoveredOutbox.close({ drain: true })
}

async function verifyMutationPersistenceRecovery() {
  const admissionPath = path.join(tempRoot, 'admission-persist-recovery.json')
  let admissionProviderCalls = 0
  let failAdmissionPersistOnce = true
  const admissionOutbox = createDurableBackgroundDeliveryOutbox({
    persistencePath: admissionPath,
    beforePersist: async (snapshot) => {
      if (
        failAdmissionPersistOnce &&
        snapshot.jobs.some((job) => job.requestId === 'admission-persist-recovery')
      ) {
        failAdmissionPersistOnce = false
        throw new Error('injected admission persistence failure')
      }
    },
    execute: async () => {
      admissionProviderCalls += 1
      return { id: 'admission-recovery-proof', status: 'queued' }
    },
    settle: async (_job, outcome) => ({
      ...outcome,
      sent: true,
      proof: { message_id: outcome.providerResult.id },
    }),
    onError: () => {},
  })
  const admissionInput = {
    requestId: 'admission-persist-recovery',
    fingerprint: createBackgroundDeliveryFingerprint({
      scope: 'admission-persist-recovery',
    }),
    channel: 'sms',
    provider: 'telnyx',
    destination: '***0002',
    payload: { phone: '+15550000002', message: 'Persist before admitting.' },
    safety: 'at_most_once',
  }
  await assert.rejects(admissionOutbox.admit(admissionInput))
  assert.equal(
    admissionOutbox.snapshot().jobs.length,
    0,
    'failed durable admission left an orphan queued job in memory',
  )
  assert.equal(admissionProviderCalls, 0)
  const admittedAfterRecovery = await admissionOutbox.admit(admissionInput)
  const admissionOutcome = await admittedAfterRecovery.completion
  assert.equal(admissionOutcome.sent, true)
  assert.equal(admissionOutcome.proof.message_id, 'admission-recovery-proof')
  assert.equal(admissionProviderCalls, 1)
  await admissionOutbox.close({ drain: true })

  const dispatchPath = path.join(tempRoot, 'dispatch-persist-recovery.json')
  let dispatchProviderCalls = 0
  let failDispatchPersistOnce = true
  const dispatchOutbox = createDurableBackgroundDeliveryOutbox({
    persistencePath: dispatchPath,
    retryBaseMs: 1,
    retryMaxMs: 2,
    beforePersist: async (snapshot) => {
      if (
        failDispatchPersistOnce &&
        snapshot.jobs.some((job) => job.status === 'dispatching')
      ) {
        failDispatchPersistOnce = false
        throw new Error('injected queued-to-dispatching persistence failure')
      }
    },
    execute: async () => {
      dispatchProviderCalls += 1
      return { id: 'dispatch-recovery-proof', status: 'queued' }
    },
    settle: async (_job, outcome) => ({
      ...outcome,
      sent: true,
      proof: { message_id: outcome.providerResult.id },
    }),
    onError: () => {},
  })
  const dispatch = await dispatchOutbox.admit({
    requestId: 'dispatch-persist-recovery',
    fingerprint: createBackgroundDeliveryFingerprint({
      scope: 'dispatch-persist-recovery',
    }),
    channel: 'sms',
    provider: 'telnyx',
    destination: '***0002',
    payload: { phone: '+15550000002', message: 'Recover before provider IO.' },
    safety: 'at_most_once',
  })
  const dispatchOutcome = await dispatch.completion
  assert.equal(dispatchOutcome.sent, true)
  assert.equal(dispatchOutcome.proof.message_id, 'dispatch-recovery-proof')
  assert.equal(dispatchProviderCalls, 1, 'dispatch persistence recovery duplicated provider IO')
  const dispatchPersisted = JSON.parse(fs.readFileSync(dispatchPath, 'utf8')).jobs[0]
  assert.equal(dispatchPersisted.status, 'accepted')
  assert.equal(dispatchPersisted.attempts, 1)
  await dispatchOutbox.close({ drain: true })

  const rejectionPath = path.join(tempRoot, 'rejection-persist-fence.json')
  let rejectionProviderCalls = 0
  const rejectionOutbox = createDurableBackgroundDeliveryOutbox({
    persistencePath: rejectionPath,
    beforePersist: async (snapshot) => {
      if (
        rejectionProviderCalls > 0 &&
        snapshot.jobs.some((job) => job.status === 'failed')
      ) {
        throw new Error('injected provider rejection persistence failure')
      }
    },
    execute: async () => {
      rejectionProviderCalls += 1
      throw new Error('provider rejected the delivery')
    },
    onError: () => {},
  })
  const rejection = await rejectionOutbox.admit({
    requestId: 'rejection-persist-fence',
    fingerprint: createBackgroundDeliveryFingerprint({
      scope: 'rejection-persist-fence',
    }),
    channel: 'email',
    provider: 'google_workspace',
    destination: 'c***@example.com',
    payload: {
      email: 'contact@example.com',
      subject: 'Rejected delivery',
      body: 'This provider operation must not be repeated.',
    },
    safety: 'at_most_once',
  })
  const rejectionOutcome = await rejection.completion
  assert.equal(rejectionOutcome.status, 'failed')
  assert.equal(rejectionOutcome.sent, false)
  assert.equal(rejectionProviderCalls, 1)
  assert.equal(
    JSON.parse(fs.readFileSync(rejectionPath, 'utf8')).jobs[0].status,
    'dispatching',
    'a rejected at-most-once request must retain its durable no-resend fence when failure proof cannot persist',
  )
  assert.equal(rejectionOutbox.snapshot().jobs[0].status, 'failed')
  await Promise.race([
    rejectionOutbox.drain(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('rejected delivery completion wedged')), 500),
    ),
  ])
  await rejectionOutbox.close({ drain: true })

  const recoveredOutbox = createDurableBackgroundDeliveryOutbox({
    persistencePath: rejectionPath,
    execute: async () => {
      rejectionProviderCalls += 1
      return { id: 'must-not-resend-rejected-operation' }
    },
  })
  await recoveredOutbox.start()
  await recoveredOutbox.drain()
  assert.equal(
    rejectionProviderCalls,
    1,
    'restart resent an at-most-once provider request after rejection proof persistence failed',
  )
  const recovered = JSON.parse(fs.readFileSync(rejectionPath, 'utf8')).jobs[0]
  assert.equal(recovered.status, 'accepted_unverified')
  await recoveredOutbox.close({ drain: true })
}

async function verifyConfirmedProviderFailureRemainsFailed() {
  const persistencePath = path.join(tempRoot, 'confirmed-provider-failure.json')
  const outbox = createDurableBackgroundDeliveryOutbox({
    persistencePath,
    execute: async () => ({
      id: 'provider-final-failure',
      status: 'queued',
      to: [{ status: 'queued' }],
    }),
    settle: async (_job, outcome) => ({
      ...outcome,
      ok: false,
      sent: false,
      status: 'failed',
      provider_accepted: true,
      delivery_finalized: true,
      error_code: '40002',
      error: 'SMS delivery failed after provider acceptance (40002: Blocked as spam - temporary)',
    }),
  })
  await outbox.start()
  const queued = await outbox.admit({
    requestId: 'confirmed-provider-failure',
    fingerprint: createBackgroundDeliveryFingerprint({
      scope: 'confirmed-provider-failure',
    }),
    channel: 'sms',
    provider: 'telnyx',
    destination: '***0002',
    payload: { phone: '+15550000002', message: 'Provider final failure.' },
    safety: 'at_most_once',
    maxAttempts: 1,
  })
  const outcome = await queued.completion
  assert.equal(outcome.status, 'failed')
  assert.equal(outcome.sent, false)
  assert.equal(outcome.provider_accepted, true)
  assert.equal(outcome.delivery_finalized, true)
  assert.equal(outcome.error_code, '40002')
  const terminal = JSON.parse(fs.readFileSync(persistencePath, 'utf8')).jobs[0]
  assert.equal(
    terminal.status,
    'failed',
    'confirmed final provider rejection was downgraded to accepted-unverified',
  )
  await outbox.close({ drain: true })
}

async function verifyTelnyxSmsFinalizationContract() {
  assert.equal(
    typeof delivery.createTelnyxSmsFinalizationTracker,
    'function',
    'Telnyx SMS finalization tracker is missing',
  )

  let deliveredReads = 0
  const deliveredTracker = delivery.createTelnyxSmsFinalizationTracker({
    readMessage: async () => {
      deliveredReads += 1
      return {
        id: 'sms-delivered-after-queue',
        to: [{ status: 'queued' }],
      }
    },
    timeoutMs: 100,
    pollIntervalMs: 5,
  })
  const deliveredPromise = deliveredTracker.waitFor({
    id: 'sms-delivered-after-queue',
    to: [{ status: 'queued' }],
  })
  await new Promise((resolve) => setImmediate(resolve))
  deliveredTracker.observe(
    {
      id: 'sms-delivered-after-queue',
      to: [{ status: 'delivered' }],
    },
    { eventType: 'message.finalized' },
  )
  const delivered = await deliveredPromise
  assert.equal(delivered.status, 'delivered')
  assert.equal(delivered.provider_status, 'delivered')
  assert.equal(delivered.sent, true)
  assert.equal(delivered.delivery_finalized, true)
  assert.equal(delivered.provider_accepted, true)
  assert.equal(deliveredReads >= 1, true)

  const failedTracker = delivery.createTelnyxSmsFinalizationTracker({
    readMessage: async () => ({
      id: 'sms-final-failure',
      to: [{ status: 'queued' }],
    }),
    timeoutMs: 100,
    pollIntervalMs: 5,
  })
  const failedPromise = failedTracker.waitFor({
    id: 'sms-final-failure',
    to: [{ status: 'queued' }],
  })
  await new Promise((resolve) => setImmediate(resolve))
  failedTracker.observe(
    {
      id: 'sms-final-failure',
      to: [
        {
          status: 'delivery_failed',
          errors: [
            {
              code: '40002',
              title: 'Blocked as spam - temporary',
              detail: 'The destination +15550000002 was not delivered.',
            },
          ],
        },
      ],
    },
    { eventType: 'message.finalized' },
  )
  const failed = await failedPromise
  assert.equal(failed.status, 'failed')
  assert.equal(failed.provider_status, 'delivery_failed')
  assert.equal(failed.sent, false)
  assert.equal(failed.delivery_finalized, true)
  assert.equal(failed.provider_accepted, true)
  assert.equal(failed.error_code, '40002')
  assert.equal(failed.errors[0].title, 'Blocked as spam - temporary')
  assert.equal(
    JSON.stringify(failed).includes('+15550000002'),
    false,
    'Telnyx final failure proof leaked the destination',
  )

  let cachedReads = 0
  const cachedTracker = delivery.createTelnyxSmsFinalizationTracker({
    readMessage: async () => {
      cachedReads += 1
      throw new Error('readback must not run after an early finalized webhook')
    },
    timeoutMs: 100,
    pollIntervalMs: 5,
  })
  cachedTracker.observe(
    {
      id: 'sms-finalized-before-settlement',
      to: [{ status: 'delivered' }],
    },
    { eventType: 'message.finalized' },
  )
  const cached = await cachedTracker.waitFor({
    id: 'sms-finalized-before-settlement',
    to: [{ status: 'queued' }],
  })
  assert.equal(cached.sent, true)
  assert.equal(cachedReads, 0)

  let readbackReads = 0
  const readbackTracker = delivery.createTelnyxSmsFinalizationTracker({
    readMessage: async (messageId) => {
      readbackReads += 1
      return {
        id: messageId,
        to: [{ status: 'delivered' }],
      }
    },
    timeoutMs: 100,
    pollIntervalMs: 5,
  })
  const readback = await readbackTracker.waitFor({
    id: 'sms-missed-webhook-readback',
    to: [{ status: 'queued' }],
  })
  assert.equal(readback.sent, true)
  assert.equal(readback.source, 'readback')
  assert.equal(readbackReads, 1)

  let timeoutReads = 0
  const timeoutTracker = delivery.createTelnyxSmsFinalizationTracker({
    readMessage: async (messageId) => {
      timeoutReads += 1
      return {
        id: messageId,
        to: [{ status: 'queued' }],
      }
    },
    timeoutMs: 25,
    pollIntervalMs: 5,
  })
  const unverified = await timeoutTracker.waitFor({
    id: 'sms-finalization-timeout',
    to: [{ status: 'queued' }],
  })
  assert.equal(unverified.status, 'accepted_unverified')
  assert.equal(unverified.provider_status, 'queued')
  assert.equal(unverified.sent, false)
  assert.equal(unverified.delivery_finalized, false)
  assert.equal(unverified.provider_accepted, true)
  assert.equal(timeoutReads >= 1, true)
}

function verifyPortalSmsBrandContract() {
  const previousSender = process.env.WORKSPACE_SMS_SENDER_NAME
  const previousLink = process.env.SPEAK_LINK_URL
  try {
    process.env.WORKSPACE_SMS_SENDER_NAME = 'Split Workspace'
    process.env.SPEAK_LINK_URL = 'https://example.test/portal'
    const body = delivery.buildPortalSmsBody()
    assert.equal(body.startsWith('Split Workspace:'), true)
    assert.equal(body.includes('https://example.test/portal'), true)
    assert.equal(body.includes('Reply STOP to opt out.'), true)
  } finally {
    if (previousSender === undefined) delete process.env.WORKSPACE_SMS_SENDER_NAME
    else process.env.WORKSPACE_SMS_SENDER_NAME = previousSender
    if (previousLink === undefined) delete process.env.SPEAK_LINK_URL
    else process.env.SPEAK_LINK_URL = previousLink
  }
}

function verifyTelnyxFinalizationCommunicationProof() {
  const normalized = telnyxNormalizer.buildTelnyxSmsCommunicationEvent({
    eventType: 'message.finalized',
    webhookEventId: 'webhook-finalized-check',
    occurredAt: '2026-07-15T10:53:34.174Z',
    payload: {
      id: 'sms-finalization-communication-proof',
      direction: 'outbound',
      from: { phone_number: '+15550000001' },
      to: [
        {
          phone_number: '+15550000002',
          status: 'delivery_failed',
          errors: [
            {
              code: '40002',
              title: 'Blocked as spam - temporary',
              detail: 'The destination +15550000002 was not delivered.',
            },
          ],
        },
      ],
    },
  })
  const communication = normalized?.communicationEvent?.event?.communication
  assert.equal(communication?.proof?.status, 'delivery_failed')
  assert.equal(communication?.proof?.error_code, '40002')
  assert.equal(communication?.proof?.errors?.[0]?.title, 'Blocked as spam - temporary')
  assert.equal(communication?.body.includes('delivery_failed'), true)
  assert.equal(
    JSON.stringify(communication?.proof).includes('+15550000002'),
    false,
    'finalized webhook proof leaked the destination',
  )
}

async function verifyCrashRecoveryBeforeProviderDispatch() {
  const persistencePath = path.join(tempRoot, 'crash-recovery.json')
  const providerCountPath = path.join(tempRoot, 'provider-count.txt')
  const firstChildPath = path.join(tempRoot, 'admit-and-crash.mjs')
  const secondChildPath = path.join(tempRoot, 'recover.mjs')
  const moduleUrl = pathToFileURL(path.join(root, 'server/background-delivery.mjs')).href

  fs.writeFileSync(
    firstChildPath,
    `import { createBackgroundDeliveryFingerprint, createDurableBackgroundDeliveryOutbox } from ${JSON.stringify(moduleUrl)}\n` +
      `const outbox = createDurableBackgroundDeliveryOutbox({ persistencePath: process.argv[2], schedule: () => {}, execute: async () => { throw new Error('provider must not run') } })\n` +
      `await outbox.start()\n` +
      `const queued = await outbox.admit({ requestId: 'crash-request', fingerprint: createBackgroundDeliveryFingerprint({ scope: 'crash-request' }), channel: 'sms', provider: 'telnyx', destination: '***0002', payload: { phone: '+15550000002', message: 'Crash recovery.' }, context: { callControlId: 'crash-call' }, safety: 'at_most_once' })\n` +
      `if (queued.result.status !== 'processing') process.exit(3)\n` +
      `process.kill(process.pid, 'SIGKILL')\n`,
  )
  const first = spawnSync(process.execPath, [firstChildPath, persistencePath], {
    encoding: 'utf8',
    timeout: 5_000,
  })
  assert.equal(first.signal, 'SIGKILL', `admission child did not simulate a crash: ${first.stderr}`)
  const admitted = JSON.parse(fs.readFileSync(persistencePath, 'utf8')).jobs[0]
  assert.equal(admitted.status, 'queued', 'crash happened before durable admission completed')
  assert.equal(fs.existsSync(providerCountPath), false, 'provider ran before the simulated crash')

  fs.writeFileSync(
    secondChildPath,
    `import fs from 'node:fs'\n` +
      `import { createDurableBackgroundDeliveryOutbox } from ${JSON.stringify(moduleUrl)}\n` +
      `const outbox = createDurableBackgroundDeliveryOutbox({ persistencePath: process.argv[2], execute: async () => { const count = Number(fs.existsSync(process.argv[3]) ? fs.readFileSync(process.argv[3], 'utf8') : 0) + 1; fs.writeFileSync(process.argv[3], String(count)); return { id: 'recovered-provider-proof', status: 'queued' } }, settle: async (_job, outcome) => ({ ...outcome, sent: true, proof: { message_id: outcome.providerResult.id } }) })\n` +
      `await outbox.start()\n` +
      `await outbox.drain()\n` +
      `await outbox.close({ drain: true })\n`,
  )
  const second = spawnSync(
    process.execPath,
    [secondChildPath, persistencePath, providerCountPath],
    { encoding: 'utf8', timeout: 5_000 },
  )
  assert.equal(second.status, 0, `recovery child failed: ${second.stderr || second.stdout}`)
  assert.equal(fs.readFileSync(providerCountPath, 'utf8'), '1', 'recovery did not execute exactly once')
  const recovered = JSON.parse(fs.readFileSync(persistencePath, 'utf8')).jobs[0]
  assert.equal(recovered.status, 'accepted')
  assert.equal(recovered.outcome.proof.message_id, 'recovered-provider-proof')
}

async function verifyVoiceToolCrashRecovery() {
  const integrationRoot = path.join(tempRoot, 'voice-tool-crash')
  const dataDir = path.join(integrationRoot, 'workspace-data')
  const callLogDir = path.join(integrationRoot, 'call-logs')
  const audioDir = path.join(integrationRoot, 'call-audio')
  const providerCountPath = path.join(integrationRoot, 'provider-count.txt')
  const wrapperPath = path.join(integrationRoot, 'gog-wrapper.cjs')
  const firstChildPath = path.join(integrationRoot, 'admit-and-crash.mjs')
  const secondChildPath = path.join(integrationRoot, 'recover-server.mjs')
  const outboxPath = path.join(dataDir, 'background-delivery-outbox.json')
  fs.mkdirSync(integrationRoot, { recursive: true })
  fs.writeFileSync(
    wrapperPath,
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs')",
      `const marker = ${JSON.stringify(providerCountPath)}`,
      "const count = Number(fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : 0) + 1",
      "fs.writeFileSync(marker, String(count))",
      "process.stdout.write(JSON.stringify({ result: { id: 'voice-recovery-message-proof', threadId: 'voice-recovery-thread-proof', ok: true } }) + '\\n')",
    ].join('\n'),
    { mode: 0o755 },
  )
  fs.chmodSync(wrapperPath, 0o755)

  const storeUrl = pathToFileURL(path.join(root, 'server/workspace-store.mjs')).href
  const runtimeUrl = pathToFileURL(path.join(root, 'server/index.mjs')).href
  fs.writeFileSync(
    firstChildPath,
    `const store = await import(${JSON.stringify(storeUrl)})\n` +
      `const initial = await store.createWorkspaceLead({ id: 'voice-crash-contact', name: 'Voice Crash Contact', email: 'old@example.com' })\n` +
      `const runtime = await import(${JSON.stringify(runtimeUrl)})\n` +
      `const state = { callControlId: 'voice-crash-call', callProvider: 'calltools', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), eventLog: [], lead: { ...initial }, config: { agentProfileId: 'voice-crash-agent', agentProfileName: 'Voice Crash Agent', dialerProvider: 'calltools', voiceRuntimeProvider: 'inworld', languageModelMode: 'inworld', inworldToolCallingEnabled: true }, productionContext: true, ending: false }\n` +
      `runtime.registerVoiceDeliveryTestState(state)\n` +
      `const delivery = (await runtime.executeSpeakToolCall(state, 'send_email', { destination_confirmed: true, email: 'new@example.com', subject: 'Crash recovery', body: 'Recover this delivery after admission.' })).result\n` +
      `if (delivery.status !== 'processing' || delivery.sent) process.exit(3)\n` +
      `process.kill(process.pid, 'SIGKILL')\n`,
  )

  const env = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: '0',
    BASE_PATH: '/speak',
    PUBLIC_BASE_URL: 'http://127.0.0.1',
    SPEAK_WORKSPACE_DATA_DIR: dataDir,
    BACKGROUND_DELIVERY_OUTBOX_PATH: outboxPath,
    SPEAK_CALL_LOG_DIR: callLogDir,
    SPEAK_CALL_AUDIO_DIR: audioDir,
    HUME_API_KEY: '',
    INWORLD_API_KEY: '',
    CALLTOOLS_API_KEY: '',
    TELNYX_API_KEY: '',
    WORKSPACE_EMAIL_ACCOUNT: 'speak@example.com',
    WORKSPACE_EMAIL_GOG_ACCOUNT: 'speak@example.com',
    WORKSPACE_EMAIL_SEND_GOG_ACCOUNT: 'speak@example.com',
    GOG_WRAPPER: wrapperPath,
    CALLTOOLS_DUTY_MONITOR_INTERVAL_MS: '600000',
  }
  const first = spawnSync(process.execPath, [firstChildPath], {
    cwd: root,
    env,
    encoding: 'utf8',
    // Importing the full voice runtime is intentionally part of this recovery
    // proof. Leave enough watchdog headroom for a loaded audit host; the child
    // still has to terminate itself with SIGKILL after durable admission.
    timeout: 30_000,
  })
  assert.equal(first.signal, 'SIGKILL', `voice admission child did not crash: ${first.stderr}`)
  assert.equal(
    fs.existsSync(providerCountPath),
    false,
    'voice provider started before the processing tool response was returned',
  )
  assert.equal(fs.existsSync(outboxPath), true, 'voice processing response was not durably admitted')
  assert.equal(JSON.parse(fs.readFileSync(outboxPath, 'utf8')).jobs[0].status, 'queued')

  fs.writeFileSync(
    secondChildPath,
    `import fs from 'node:fs'\n` +
      `await import(${JSON.stringify(runtimeUrl)})\n` +
      `const deadline = Date.now() + 10000\n` +
      `while (Date.now() < deadline) {\n` +
      `  const outbox = fs.existsSync(process.argv[2]) ? JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) : null\n` +
      `  const workspace = fs.existsSync(process.argv[3]) ? JSON.parse(fs.readFileSync(process.argv[3], 'utf8')) : null\n` +
      `  const accepted = outbox?.jobs?.find((job) => job.requestId === 'voice-crash-call-email-' + job.fingerprint) || outbox?.jobs?.find((job) => job.status === 'accepted')\n` +
      `  const contact = workspace?.leads?.find((lead) => lead.id === 'voice-crash-contact')\n` +
      `  const message = workspace?.communicationMessages?.find((item) => item?.proof?.message_id === 'voice-recovery-message-proof')\n` +
      `  if (accepted?.status === 'accepted' && accepted?.outcome?.proof?.message_id === 'voice-recovery-message-proof' && contact?.email === 'new@example.com' && message) { process.kill(process.pid, 'SIGTERM'); break }\n` +
      `  await new Promise((resolve) => setTimeout(resolve, 25))\n` +
      `}\n` +
      `setTimeout(() => process.exit(4), 100)\n`,
  )
  const second = spawnSync(
    process.execPath,
    [secondChildPath, outboxPath, path.join(dataDir, 'workspace.json')],
    { cwd: root, env, encoding: 'utf8', timeout: 15_000 },
  )
  assert.equal(second.status, 0, `voice recovery process failed: ${second.stderr || second.stdout}`)
  assert.equal(fs.readFileSync(providerCountPath, 'utf8'), '1', 'voice recovery sent more than once')
  const terminal = JSON.parse(fs.readFileSync(outboxPath, 'utf8')).jobs[0]
  assert.equal(terminal.status, 'accepted')
  assert.equal(terminal.outcome.proof.message_id, 'voice-recovery-message-proof')
}
