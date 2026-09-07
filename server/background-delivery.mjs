import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename } from 'node:fs/promises'
import path from 'node:path'

export const BACKGROUND_DELIVERY_OUTBOX_SCHEMA =
  'speak.background-delivery-outbox.v1'

const ACTIVE_DELIVERY_STATUSES = new Set([
  'queued',
  'retry_wait',
  'dispatching',
  'provider_accepted',
])
const SUCCESS_DELIVERY_STATUSES = new Set(['accepted', 'accepted_unverified'])
const TERMINAL_DELIVERY_STATUSES = new Set([
  ...SUCCESS_DELIVERY_STATUSES,
  'failed',
])

export function queueBackgroundDelivery({
  requestId = randomUUID(),
  channel,
  provider,
  destination,
  run,
  onSettled = () => {},
  onObserverError = (error) => {
    console.error('Background delivery completion observer failed:', error)
  },
  schedule = setImmediate,
} = {}) {
  if (typeof run !== 'function') {
    throw new Error('Background delivery requires a provider operation')
  }

  const normalizedChannel = String(channel || 'delivery').trim() || 'delivery'
  const normalizedProvider = String(provider || '').trim()
  const maskedDestination = String(destination || '').trim()
  const queuedAt = new Date().toISOString()
  let resolveCompletion
  const completion = new Promise((resolve) => {
    resolveCompletion = resolve
  })

  schedule(() => {
    Promise.resolve()
      .then(run)
      .then(
        (providerResult) => ({
          ok: true,
          status: 'accepted',
          request_id: requestId,
          channel: normalizedChannel,
          provider: normalizedProvider,
          destination: maskedDestination,
          queued_at: queuedAt,
          completed_at: new Date().toISOString(),
          providerResult,
        }),
        (error) => ({
          ok: false,
          status: 'failed',
          request_id: requestId,
          channel: normalizedChannel,
          provider: normalizedProvider,
          destination: maskedDestination,
          queued_at: queuedAt,
          completed_at: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error || 'Delivery failed'),
        }),
      )
      .then(async (outcome) => {
        try {
          const observed = await onSettled(outcome)
          return observed && typeof observed === 'object' ? observed : outcome
        } catch (error) {
          const observerError = error instanceof Error ? error : new Error(String(error))
          try {
            onObserverError(observerError, outcome)
          } catch {
            console.error('Background delivery observer-error reporter failed:', observerError)
          }
          const providerAccepted = Boolean(outcome.ok)
          return {
            ...outcome,
            ok: false,
            status: providerAccepted ? 'accepted_unverified' : 'failed',
            provider_accepted: providerAccepted,
            providerResult: undefined,
            pending: false,
            sent: false,
            observer_error: observerError.message,
            assistant_next_step: providerAccepted
              ? 'The provider may have accepted this delivery, but Speak could not retain completion proof. Do not say it was sent and do not retry automatically; let the operator verify the provider record.'
              : 'Delivery failed and Speak could not finish its failure proof. Do not say it was sent; let the operator verify the destination and provider record.',
          }
        }
      })
      .then(resolveCompletion)
  })

  return {
    result: {
      ok: true,
      queued: true,
      pending: true,
      sent: false,
      status: 'processing',
      request_id: requestId,
      channel: normalizedChannel,
      provider: normalizedProvider,
      destination: maskedDestination,
      queued_at: queuedAt,
      assistant_next_step:
        'Tell the caller the delivery is processing in the background and continue the conversation. Do not say it was sent until Speak supplies provider proof.',
    },
    completion,
  }
}

export function createBackgroundDeliveryFingerprint(input = {}) {
  return createHash('sha256').update(stableJson(input)).digest('hex')
}

export function createDurableBackgroundDeliveryOutbox(options = {}) {
  return new DurableBackgroundDeliveryOutbox(options)
}

class DurableBackgroundDeliveryOutbox {
  constructor({
    persistencePath,
    execute,
    settle = async (_job, outcome) => outcome,
    schedule = (operation) => setImmediate(operation),
    retrySchedule = (operation, delayMs) => setTimeout(operation, delayMs),
    now = () => Date.now(),
    retryBaseMs = 1_000,
    retryMaxMs = 30_000,
    dedupeTtlMs = 120_000,
    retentionMs = 7 * 24 * 60 * 60 * 1_000,
    maxJobs = 2_000,
    beforePersist = async () => {},
    onError = (error) => {
      console.error('Background delivery outbox failed:', error)
    },
  } = {}) {
    if (!String(persistencePath || '').trim()) {
      throw new Error('Durable background delivery outbox requires a persistence path')
    }
    if (typeof execute !== 'function') {
      throw new Error('Durable background delivery outbox requires a provider executor')
    }
    if (typeof settle !== 'function') {
      throw new Error('Durable background delivery outbox requires a settlement observer')
    }
    this.persistencePath = path.resolve(persistencePath)
    this.execute = execute
    this.settle = settle
    this.schedule = schedule
    this.retrySchedule = retrySchedule
    this.now = now
    this.retryBaseMs = Math.max(1, Number(retryBaseMs) || 1_000)
    this.retryMaxMs = Math.max(this.retryBaseMs, Number(retryMaxMs) || 30_000)
    this.dedupeTtlMs = Math.max(1, Number(dedupeTtlMs) || 120_000)
    this.retentionMs = Math.max(this.dedupeTtlMs, Number(retentionMs) || 604_800_000)
    this.maxJobs = Math.max(10, Number(maxJobs) || 2_000)
    this.beforePersist =
      typeof beforePersist === 'function' ? beforePersist : async () => {}
    this.onError = onError
    this.jobs = new Map()
    this.deferred = new Map()
    this.active = new Set()
    this.scheduled = new Set()
    this.revision = 0
    this.started = false
    this.accepting = true
    this.mutationQueue = Promise.resolve()
  }

  async start() {
    if (this.started) return this.snapshot()
    const store = await this.#readStore()
    this.revision = Number(store.revision || 0)
    for (const rawJob of store.jobs || []) {
      const job = normalizeStoredJob(rawJob)
      if (!job) continue
      this.jobs.set(job.requestId, job)
    }
    this.#pruneJobs()
    this.started = true

    let recoveryMutation = false
    for (const job of this.jobs.values()) {
      if (!ACTIVE_DELIVERY_STATUSES.has(job.status)) continue
      this.#ensureDeferred(job.requestId)
      if (job.status === 'dispatching' && job.safety !== 'provider_idempotent') {
        job.status = 'accepted_unverified'
        job.updatedAt = isoAt(this.now())
        job.completedAt = job.updatedAt
        job.outcome = acceptedUnverifiedOutcome(job, {
          reason: 'provider_dispatch_interrupted',
          error:
            'Speak restarted while this at-most-once provider request was in flight. The provider may have accepted it.',
        })
        recoveryMutation = true
        continue
      }
      if (job.status === 'dispatching') {
        job.status = 'queued'
        job.updatedAt = isoAt(this.now())
        recoveryMutation = true
      }
    }
    if (recoveryMutation) {
      try {
        await this.#persist()
      } catch (error) {
        // Do not leave a half-started outbox whose in-memory recovery state
        // was never durably fenced or scheduled. A later start/admission can
        // reread the unchanged disk state and retry recovery safely.
        this.started = false
        this.jobs.clear()
        this.deferred.clear()
        this.revision = 0
        throw error
      }
    }

    for (const job of this.jobs.values()) {
      if (job.status === 'accepted_unverified' && !job.settlementRecordedAt) {
        this.#scheduleSettlement(job.requestId)
      } else if (job.status === 'provider_accepted') {
        this.#scheduleSettlement(job.requestId)
      } else if (job.status === 'queued') {
        this.#scheduleProvider(job.requestId)
      } else if (job.status === 'retry_wait') {
        const delayMs = Math.max(0, Date.parse(job.nextAttemptAt || '') - this.now())
        this.#scheduleProvider(job.requestId, delayMs)
      }
    }
    return this.snapshot()
  }

  async admit({
    requestId = randomUUID(),
    fingerprint,
    channel,
    provider,
    destination,
    payload = {},
    context = {},
    safety = 'at_most_once',
    maxAttempts = 3,
  } = {}) {
    await this.start()
    if (!this.accepting) {
      return rejectedAdmission({ requestId, channel, provider, destination })
    }
    const cleanFingerprint = String(fingerprint || '').trim()
    if (!cleanFingerprint) throw new Error('Background delivery requires a fingerprint')
    const normalizedSafety =
      safety === 'provider_idempotent' ? 'provider_idempotent' : 'at_most_once'
    let admittedJob
    let duplicateJob
    await this.#mutate(
      () => {
        duplicateJob = this.#findDuplicate(cleanFingerprint)
        if (duplicateJob) return
        this.#pruneJobs()
        if (this.jobs.size >= this.maxJobs) {
          throw new Error('Background delivery outbox capacity reached')
        }
        const now = isoAt(this.now())
        admittedJob = {
          requestId: String(requestId || randomUUID()),
          fingerprint: cleanFingerprint,
          channel: normalizedText(channel, 'delivery'),
          provider: normalizedText(provider),
          destination: normalizedText(destination),
          payload: jsonClone(payload),
          context: jsonClone(context),
          safety: normalizedSafety,
          maxAttempts: Math.max(1, Math.min(10, Number(maxAttempts) || 3)),
          attempts: 0,
          status: 'queued',
          createdAt: now,
          updatedAt: now,
          nextAttemptAt: '',
          completedAt: '',
          settlementRecordedAt: '',
          outcome: null,
          providerResult: null,
          lastError: '',
        }
        this.jobs.set(admittedJob.requestId, admittedJob)
        this.#ensureDeferred(admittedJob.requestId)
      },
      { rollbackOnPersistenceFailure: true },
    )

    if (duplicateJob) {
      return {
        result: {
          ...publicResultForJob(duplicateJob),
          deduplicated: true,
          assistant_next_step: ACTIVE_DELIVERY_STATUSES.has(duplicateJob.status)
            ? 'The identical delivery is already processing in the background. Continue the conversation and do not call the tool again.'
            : duplicateJob.outcome?.assistant_next_step,
        },
        completion: this.#completionFor(duplicateJob),
        deduplicated: true,
      }
    }

    this.#scheduleProvider(admittedJob.requestId)
    return {
      result: processingResult(admittedJob),
      completion: this.#completionFor(admittedJob),
      deduplicated: false,
    }
  }

  async drain() {
    await this.start()
    while (true) {
      await this.mutationQueue
      const pending = [...this.jobs.values()]
        .filter(
          (job) =>
            ACTIVE_DELIVERY_STATUSES.has(job.status) ||
            (job.status === 'accepted_unverified' && !job.settlementRecordedAt),
        )
        .map((job) => this.#completionFor(job))
      if (!pending.length && this.active.size === 0 && this.scheduled.size === 0) return
      await Promise.allSettled(pending)
    }
  }

  async close({ drain = false } = {}) {
    this.accepting = false
    if (drain) await this.drain()
    await this.mutationQueue
  }

  snapshot() {
    return {
      schemaVersion: BACKGROUND_DELIVERY_OUTBOX_SCHEMA,
      revision: this.revision,
      updatedAt: isoAt(this.now()),
      jobs: [...this.jobs.values()].map((job) => jsonClone(job)),
    }
  }

  #findDuplicate(fingerprint) {
    const now = this.now()
    return [...this.jobs.values()]
      .filter((job) => job.fingerprint === fingerprint)
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
      .find((job) => {
        if (ACTIVE_DELIVERY_STATUSES.has(job.status)) return true
        if (!SUCCESS_DELIVERY_STATUSES.has(job.status)) return false
        return Date.parse(job.dedupeUntil || job.completedAt || '') > now
      })
  }

  #scheduleProvider(requestId, delayMs = 0) {
    const scheduleKey = `provider:${requestId}`
    if (this.scheduled.has(scheduleKey)) return
    this.scheduled.add(scheduleKey)
    const launch = () => {
      this.scheduled.delete(scheduleKey)
      void this.#processProvider(requestId).catch((error) => this.#report(error))
    }
    try {
      if (delayMs > 0) this.retrySchedule(launch, delayMs)
      else this.schedule(launch)
    } catch (error) {
      this.scheduled.delete(scheduleKey)
      this.#rejectDeferred(requestId, error)
      throw error
    }
  }

  #scheduleSettlement(requestId) {
    const scheduleKey = `settlement:${requestId}`
    if (this.scheduled.has(scheduleKey) || this.active.has(requestId)) return
    this.scheduled.add(scheduleKey)
    const launch = () => {
      this.scheduled.delete(scheduleKey)
      void this.#settleRecovered(requestId).catch((error) => this.#report(error))
    }
    try {
      this.schedule(launch)
    } catch (error) {
      this.scheduled.delete(scheduleKey)
      this.#rejectDeferred(requestId, error)
      throw error
    }
  }

  async #processProvider(requestId) {
    if (this.active.has(requestId)) return
    this.active.add(requestId)
    let retryDelayAfter = 0
    try {
      let job
      try {
        await this.#mutate(() => {
          job = this.jobs.get(requestId)
          if (!job || !['queued', 'retry_wait'].includes(job.status)) return
          job.status = 'dispatching'
          job.attempts += 1
          job.updatedAt = isoAt(this.now())
          job.nextAttemptAt = ''
          job.lastError = ''
        })
      } catch (error) {
        const current = this.jobs.get(requestId)
        if (current?.status === 'dispatching') {
          current.status = 'queued'
          current.attempts = Math.max(0, current.attempts - 1)
          current.updatedAt = isoAt(this.now())
          current.nextAttemptAt = ''
          current.lastError = `provider_dispatch_persistence_failed: ${errorMessage(error)}`
          retryDelayAfter = this.retryBaseMs
        }
        this.#report(error)
        return
      }
      if (!job || job.status !== 'dispatching') return

      let providerResult
      try {
        providerResult = await this.execute(jsonClone(job))
      } catch (error) {
        try {
          retryDelayAfter = await this.#handleProviderError(requestId, error)
        } catch (persistenceError) {
          this.#report(persistenceError)
          const current = this.jobs.get(requestId)
          if (current?.status === 'retry_wait') {
            retryDelayAfter = Math.max(
              1,
              Date.parse(current.nextAttemptAt || '') - this.now(),
            )
          } else if (current?.status === 'failed') {
            await this.#settleRecovered(requestId)
          }
        }
        return
      }

      try {
        await this.#mutate(() => {
          const current = this.jobs.get(requestId)
          if (!current || current.status !== 'dispatching') return
          current.status = 'provider_accepted'
          current.providerResult = jsonClone(providerResult)
          current.updatedAt = isoAt(this.now())
        })
      } catch (error) {
        // The provider has already accepted this at-most-once operation. Keep
        // progressing to settlement in memory so a transient outbox write
        // failure cannot wedge the completion or trigger a resend. If the
        // terminal write also fails, #settleRecovered installs an explicit
        // accepted-unverified fence; the on-disk dispatching state remains a
        // restart-safe no-resend fence.
        const current = this.jobs.get(requestId)
        if (current?.status === 'provider_accepted') {
          current.lastError = `provider_acceptance_persistence_failed: ${errorMessage(error)}`
        }
        this.#report(error)
      }
      await this.#settleRecovered(requestId)
    } finally {
      this.active.delete(requestId)
      if (retryDelayAfter > 0) this.#scheduleProvider(requestId, retryDelayAfter)
    }
  }

  async #handleProviderError(requestId, error) {
    let retryDelay = 0
    let shouldRetry = false
    await this.#mutate(() => {
      const job = this.jobs.get(requestId)
      if (!job || job.status !== 'dispatching') return
      const safeToRetry =
        job.safety === 'provider_idempotent' && error?.safeToRetry === true
      shouldRetry = safeToRetry && job.attempts < job.maxAttempts
      job.lastError = errorMessage(error)
      job.updatedAt = isoAt(this.now())
      if (shouldRetry) {
        retryDelay = Math.min(
          this.retryMaxMs,
          this.retryBaseMs * (2 ** Math.max(0, job.attempts - 1)),
        )
        job.status = 'retry_wait'
        job.nextAttemptAt = isoAt(this.now() + retryDelay)
      } else {
        job.status = 'failed'
        job.completedAt = job.updatedAt
        job.outcome = failedOutcome(job, error)
      }
    })
    if (shouldRetry) {
      return retryDelay
    }
    await this.#settleRecovered(requestId)
    return 0
  }

  async #settleRecovered(requestId) {
    if (!this.active.has(requestId)) this.active.add(requestId)
    const job = this.jobs.get(requestId)
    if (!job) return
    const rawOutcome = rawOutcomeForJob(job)
    let settled
    try {
      settled = await this.settle(jsonClone(job), jsonClone(rawOutcome))
    } catch (error) {
      settled = rawOutcome.ok
        ? acceptedUnverifiedOutcome(job, {
            reason: 'settlement_persistence_failed',
            error: errorMessage(error),
          })
        : {
            ...rawOutcome,
            ok: false,
            sent: false,
            status: rawOutcome.status === 'accepted_unverified'
              ? 'accepted_unverified'
              : 'failed',
            observer_error: errorMessage(error),
          }
      this.#report(error)
    }
    const terminalOutcome = normalizeTerminalOutcome(job, settled, rawOutcome)
    try {
      await this.#mutate(() => {
        const current = this.jobs.get(requestId)
        if (!current) return
        current.status = terminalOutcome.status
        current.outcome = jsonClone(terminalOutcome)
        current.providerResult = null
        current.updatedAt = isoAt(this.now())
        current.completedAt = current.updatedAt
        current.settlementRecordedAt = current.updatedAt
        current.dedupeUntil = SUCCESS_DELIVERY_STATUSES.has(current.status)
          ? isoAt(this.now() + this.dedupeTtlMs)
          : ''
      })
      this.#resolveDeferred(requestId, terminalOutcome)
      this.active.delete(requestId)
      return terminalOutcome
    } catch (error) {
      this.#report(error)
      const current = this.jobs.get(requestId)
      const persistenceOutcome = rawOutcome.ok
        ? acceptedUnverifiedOutcome(job, {
            reason: 'terminal_outbox_persistence_failed',
            error: errorMessage(error),
          })
        : {
            ...failedOutcome(job, error),
            reason: 'terminal_outbox_persistence_failed',
          }
      if (current) {
        current.status = persistenceOutcome.status
        current.outcome = jsonClone(persistenceOutcome)
        current.providerResult = null
        current.updatedAt = isoAt(this.now())
        current.completedAt = current.updatedAt
        current.settlementRecordedAt = current.updatedAt
        current.dedupeUntil = SUCCESS_DELIVERY_STATUSES.has(current.status)
          ? isoAt(this.now() + this.dedupeTtlMs)
          : ''
      }
      this.#resolveDeferred(requestId, persistenceOutcome)
      this.active.delete(requestId)
      return persistenceOutcome
    }
  }

  #ensureDeferred(requestId) {
    if (this.deferred.has(requestId)) return this.deferred.get(requestId)
    let resolve
    let reject
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    const deferred = { promise, resolve, reject, settled: false }
    this.deferred.set(requestId, deferred)
    return deferred
  }

  #completionFor(job) {
    if (
      TERMINAL_DELIVERY_STATUSES.has(job.status) &&
      job.outcome &&
      (job.status !== 'accepted_unverified' || job.settlementRecordedAt)
    ) {
      return Promise.resolve(jsonClone(job.outcome))
    }
    return this.#ensureDeferred(job.requestId).promise
  }

  #resolveDeferred(requestId, outcome) {
    const deferred = this.deferred.get(requestId)
    if (!deferred || deferred.settled) return
    deferred.settled = true
    deferred.resolve(jsonClone(outcome))
  }

  #rejectDeferred(requestId, error) {
    const deferred = this.deferred.get(requestId)
    if (!deferred || deferred.settled) return
    deferred.settled = true
    deferred.reject(error)
  }

  #pruneJobs() {
    const cutoff = this.now() - this.retentionMs
    for (const [requestId, job] of this.jobs) {
      if (
        TERMINAL_DELIVERY_STATUSES.has(job.status) &&
        Date.parse(job.completedAt || job.updatedAt || '') < cutoff
      ) {
        this.jobs.delete(requestId)
        this.deferred.delete(requestId)
      }
    }
    if (this.jobs.size < this.maxJobs) return
    const removable = [...this.jobs.values()]
      .filter((job) => TERMINAL_DELIVERY_STATUSES.has(job.status))
      .sort((left, right) => String(left.completedAt).localeCompare(String(right.completedAt)))
    while (this.jobs.size >= this.maxJobs && removable.length) {
      const job = removable.shift()
      this.jobs.delete(job.requestId)
      this.deferred.delete(job.requestId)
    }
  }

  #mutate(operation, { rollbackOnPersistenceFailure = false } = {}) {
    const mutation = this.mutationQueue.then(async () => {
      const previousJobs = rollbackOnPersistenceFailure
        ? new Map(
            [...this.jobs.entries()].map(([requestId, job]) => [
              requestId,
              jsonClone(job),
            ]),
          )
        : null
      const previousDeferred = rollbackOnPersistenceFailure
        ? new Map(this.deferred)
        : null
      const previousRevision = this.revision
      const result = operation()
      this.revision += 1
      try {
        await this.#persist()
      } catch (error) {
        if (rollbackOnPersistenceFailure) {
          this.jobs = previousJobs
          this.deferred = previousDeferred
          this.revision = previousRevision
        }
        throw error
      }
      return result
    })
    this.mutationQueue = mutation.catch(() => {})
    return mutation
  }

  async #persist() {
    await this.beforePersist(this.snapshot())
    const directory = path.dirname(this.persistencePath)
    await mkdir(directory, { recursive: true })
    const temporaryPath = `${this.persistencePath}.${process.pid}.${randomUUID()}.tmp`
    const body = `${JSON.stringify(this.snapshot(), null, 2)}\n`
    const handle = await open(temporaryPath, 'w', 0o600)
    try {
      await handle.writeFile(body)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporaryPath, this.persistencePath)
    await chmod(this.persistencePath, 0o600)
    try {
      const directoryHandle = await open(directory, 'r')
      try {
        await directoryHandle.sync()
      } finally {
        await directoryHandle.close()
      }
    } catch {
      // Some filesystems do not allow directory fsync; the atomic file is still valid.
    }
  }

  async #readStore() {
    try {
      const text = await readFile(this.persistencePath, 'utf8')
      const parsed = JSON.parse(text)
      if (parsed?.schemaVersion !== BACKGROUND_DELIVERY_OUTBOX_SCHEMA) {
        throw new Error('Unsupported background delivery outbox schema')
      }
      if (!Array.isArray(parsed.jobs)) {
        throw new Error('Background delivery outbox jobs are invalid')
      }
      return parsed
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return {
          schemaVersion: BACKGROUND_DELIVERY_OUTBOX_SCHEMA,
          revision: 0,
          jobs: [],
        }
      }
      throw error
    }
  }

  #report(error) {
    try {
      this.onError(error instanceof Error ? error : new Error(errorMessage(error)))
    } catch {
      console.error('Background delivery outbox error reporter failed')
    }
  }
}

function normalizeStoredJob(input = {}) {
  const requestId = String(input.requestId || '').trim()
  const fingerprint = String(input.fingerprint || '').trim()
  const status = String(input.status || '').trim()
  if (!requestId || !fingerprint || ![...ACTIVE_DELIVERY_STATUSES, ...TERMINAL_DELIVERY_STATUSES].includes(status)) {
    return null
  }
  return {
    requestId,
    fingerprint,
    channel: normalizedText(input.channel, 'delivery'),
    provider: normalizedText(input.provider),
    destination: normalizedText(input.destination),
    payload: jsonClone(input.payload || {}),
    context: jsonClone(input.context || {}),
    safety: input.safety === 'provider_idempotent' ? 'provider_idempotent' : 'at_most_once',
    maxAttempts: Math.max(1, Math.min(10, Number(input.maxAttempts) || 3)),
    attempts: Math.max(0, Number(input.attempts) || 0),
    status,
    createdAt: String(input.createdAt || new Date().toISOString()),
    updatedAt: String(input.updatedAt || input.createdAt || new Date().toISOString()),
    nextAttemptAt: String(input.nextAttemptAt || ''),
    completedAt: String(input.completedAt || ''),
    settlementRecordedAt: String(input.settlementRecordedAt || ''),
    dedupeUntil: String(input.dedupeUntil || ''),
    outcome: input.outcome ? jsonClone(input.outcome) : null,
    providerResult: input.providerResult ? jsonClone(input.providerResult) : null,
    lastError: String(input.lastError || ''),
  }
}

function rawOutcomeForJob(job) {
  const common = {
    request_id: job.requestId,
    channel: job.channel,
    provider: job.provider,
    destination: job.destination,
    queued_at: job.createdAt,
    completed_at: isoAt(Date.now()),
  }
  if (job.status === 'provider_accepted') {
    return {
      ...common,
      ok: true,
      status: 'accepted',
      providerResult: jsonClone(job.providerResult || {}),
    }
  }
  if (job.status === 'accepted_unverified') {
    return job.outcome || acceptedUnverifiedOutcome(job)
  }
  return job.outcome || {
    ...common,
    ok: false,
    status: 'failed',
    error: job.lastError || 'Delivery failed',
  }
}

function normalizeTerminalOutcome(job, settled, rawOutcome) {
  const candidate = settled && typeof settled === 'object' ? settled : rawOutcome
  const common = {
    ...candidate,
    request_id: job.requestId,
    channel: job.channel,
    provider: job.provider,
    destination: job.destination,
    queued_at: job.createdAt,
    completed_at: candidate.completed_at || isoAt(Date.now()),
    pending: false,
  }
  if (candidate.sent === true && candidate.proof && !candidate.observer_error) {
    return {
      ...common,
      ok: true,
      sent: true,
      status: 'accepted',
      providerResult: undefined,
    }
  }
  if (candidate.status === 'failed' && candidate.delivery_finalized === true) {
    return {
      ...common,
      ok: false,
      sent: false,
      status: 'failed',
      providerResult: undefined,
    }
  }
  if (
    candidate.status === 'accepted_unverified' ||
    candidate.provider_accepted === true ||
    rawOutcome.ok === true
  ) {
    return {
      ...common,
      ok: false,
      sent: false,
      status: 'accepted_unverified',
      provider_accepted: true,
      providerResult: undefined,
      assistant_next_step:
        candidate.assistant_next_step ||
        'The provider may have accepted this delivery, but Speak does not have retained completion proof. Do not say it was sent and do not retry automatically; let the operator verify the provider record.',
    }
  }
  return {
    ...common,
    ok: false,
    sent: false,
    status: 'failed',
    providerResult: undefined,
  }
}

function acceptedUnverifiedOutcome(job, { reason = 'provider_outcome_unknown', error = '' } = {}) {
  return {
    ok: false,
    status: 'accepted_unverified',
    provider_accepted: true,
    pending: false,
    sent: false,
    request_id: job.requestId,
    channel: job.channel,
    provider: job.provider,
    destination: job.destination,
    queued_at: job.createdAt,
    completed_at: isoAt(Date.now()),
    reason,
    error,
    assistant_next_step:
      'The provider may have accepted this delivery, but Speak cannot prove the outcome after restart. Do not say it was sent and do not retry automatically; let the operator verify the provider record.',
  }
}

function failedOutcome(job, error) {
  return {
    ok: false,
    status: 'failed',
    pending: false,
    sent: false,
    request_id: job.requestId,
    channel: job.channel,
    provider: job.provider,
    destination: job.destination,
    queued_at: job.createdAt,
    completed_at: isoAt(Date.now()),
    error: errorMessage(error),
  }
}

function processingResult(job) {
  return {
    ok: true,
    queued: true,
    pending: true,
    sent: false,
    status: 'processing',
    request_id: job.requestId,
    fingerprint: job.fingerprint,
    channel: job.channel,
    provider: job.provider,
    destination: job.destination,
    queued_at: job.createdAt,
    assistant_next_step:
      'Tell the caller the delivery is processing in the background and continue the conversation. Do not say it was sent until Speak supplies provider proof.',
  }
}

function publicResultForJob(job) {
  if (ACTIVE_DELIVERY_STATUSES.has(job.status)) return processingResult(job)
  return {
    ...(job.outcome || failedOutcome(job, new Error('Delivery proof is unavailable'))),
    fingerprint: job.fingerprint,
  }
}

function rejectedAdmission({ requestId, channel, provider, destination }) {
  const result = {
    ok: false,
    queued: false,
    pending: false,
    sent: false,
    status: 'failed',
    reason: 'service_shutting_down',
    request_id: String(requestId || randomUUID()),
    channel: normalizedText(channel, 'delivery'),
    provider: normalizedText(provider),
    destination: normalizedText(destination),
    assistant_next_step:
      'Speak is restarting and did not start this delivery. Do not say it was sent; ask the operator to retry after the service is ready.',
  }
  return {
    result,
    completion: Promise.resolve(result),
    deduplicated: false,
    rejected: true,
  }
}

function stableJson(value) {
  return JSON.stringify(sortJson(value))
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, sortJson(value[key])]),
  )
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value ?? null))
}

function normalizedText(value, fallback = '') {
  return String(value || fallback).trim() || fallback
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || 'Delivery failed')
}

function isoAt(timestamp) {
  return new Date(timestamp).toISOString()
}
