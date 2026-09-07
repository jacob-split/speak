import { randomUUID } from 'node:crypto'

export const CALLTOOLS_DUTY_STATUS = Object.freeze({
  ARMING: 'arming',
  ATTENTION: 'attention',
  DISARMING: 'disarming',
  OFF: 'off',
  ON: 'on',
})

const activeDutyStatuses = new Set([
  CALLTOOLS_DUTY_STATUS.ARMING,
  CALLTOOLS_DUTY_STATUS.ATTENTION,
  CALLTOOLS_DUTY_STATUS.DISARMING,
  CALLTOOLS_DUTY_STATUS.ON,
])

export function createCallToolsDutyMonitor({
  arm,
  createLeaseId = randomUUID,
  disarm,
  intervalMs = 5_000,
  logger = console,
  now = () => new Date().toISOString(),
  patchDuty,
  proveUnavailable,
  readDuty,
  readProviderStatus,
  verifiedPersistIntervalMs = 60_000,
} = {}) {
  assertFunction('arm', arm)
  assertFunction('disarm', disarm)
  assertFunction('patchDuty', patchDuty)
  if (proveUnavailable !== undefined) assertFunction('proveUnavailable', proveUnavailable)
  assertFunction('readDuty', readDuty)
  assertFunction('readProviderStatus', readProviderStatus)

  let operationQueue = Promise.resolve()
  let timer = null
  let started = false
  let runtime = {
    lastCheckedAt: '',
    lastError: '',
    lastResult: 'idle',
    lastVerifiedAt: '',
  }

  function runExclusive(operation) {
    const result = operationQueue.then(operation, operation)
    operationQueue = result.catch(() => undefined)
    return result
  }

  async function currentDuty() {
    return normalizeDutyState(await readDuty())
  }

  async function transition(expectedLeaseId, patch) {
    const result = await patchDuty({
      expectedLeaseId,
      patch: {
        ...patch,
        transitionAt: patch.transitionAt || now(),
      },
    })
    return {
      applied: result?.applied !== false,
      duty: normalizeDutyState(result?.calltoolsDuty || result?.dialerState?.calltoolsDuty),
    }
  }

  async function markAttention(duty, reason, blockers = []) {
    if (!isActiveCallToolsDuty(duty)) return duty
    const message = safeDutyMessage(
      reason || 'Speak is retaining Available while it repairs the CallTools connection.',
    )
    const result = await transition(duty.leaseId, {
      blockers: normalizeBlockers(blockers),
      message,
      profileId: duty.profileId,
      providerReadFailures: duty.providerReadFailures,
      reason: message,
      status: CALLTOOLS_DUTY_STATUS.ATTENTION,
    })
    return result.duty
  }

  async function markDisarmingRetry(duty, reason, blockers = []) {
    if (!isActiveCallToolsDuty(duty)) return duty
    const message = safeDutyMessage(
      reason || 'Speak is retaining the Unavailable request and retrying the CallTools handoff.',
    )
    const result = await transition(duty.leaseId, {
      blockers: normalizeBlockers(blockers),
      message,
      profileId: duty.profileId,
      providerReadFailures: duty.providerReadFailures + 1,
      reason: message,
      status: CALLTOOLS_DUTY_STATUS.DISARMING,
    })
    return result.duty
  }

  async function markOff(duty, reason) {
    const result = await transition(duty.leaseId, {
      blockers: [],
      gatewayOwnerInstanceId: '',
      lastVerifiedAt: now(),
      leaseId: '',
      message: safeDutyMessage(reason || 'Speak agent is confirmed Unavailable.'),
      providerReadFailures: 0,
      reason: safeDutyMessage(reason || 'operator_unavailable'),
      status: CALLTOOLS_DUTY_STATUS.OFF,
    })
    return result.duty
  }

  async function disarmLease(duty, reason) {
    const latest = await currentDuty()
    if (!sameActiveLease(duty, latest)) return latest

    const disarming = await transition(duty.leaseId, {
      blockers: [],
      message: 'Making the Speak agent Unavailable in CallTools...',
      reason: safeDutyMessage(reason || 'duty_disarm_requested'),
      status: CALLTOOLS_DUTY_STATUS.DISARMING,
    })
    if (!disarming.applied) return disarming.duty

    let session
    try {
      session = await disarm({
        binding: disarming.duty.binding,
        leaseId: duty.leaseId,
        profileId: disarming.duty.profileId,
      })
    } catch (error) {
      return markDisarmingRetry(
        disarming.duty,
        'Speak is retaining the Unavailable request while the CallTools handoff retries.',
        [error instanceof Error ? error.message : 'calltools_agent_disarm_failed'],
      )
    }

    if (session?.ok && session?.after?.ready === false) {
      const offReason = /campaign/i.test(reason || '')
        ? 'CallTools campaign paused. Speak is confirmed Unavailable.'
        : 'Speak agent is confirmed Unavailable.'
      return markOff(disarming.duty, offReason)
    }
    return markDisarmingRetry(
      disarming.duty,
      'Speak is retaining the Unavailable request while the CallTools handoff retries.',
      session?.blockers || [session?.patchError || 'calltools_agent_disarm_unproven'],
    )
  }

  async function rearmLease(duty, reason, blockers = []) {
    const latest = await currentDuty()
    if (!sameActiveLease(duty, latest)) return latest
    let session
    try {
      session = await arm({
        binding: latest.binding,
        leaseId: latest.leaseId,
        profileId: latest.profileId,
      })
    } catch (error) {
      session = {
        ok: false,
        blockers: [error instanceof Error ? error.message : 'calltools_agent_rearm_failed'],
      }
    }
    const verified = session?.ok && session?.after?.ready === true
    const retryBlockers = normalizeBlockers([
      ...blockers,
      ...(session?.blockers || []),
      verified ? '' : session?.patchError || 'CALLTOOLS_AGENT_REARM_PENDING',
    ])
    const result = await transition(latest.leaseId, {
      blockers: verified ? [] : retryBlockers,
      lastCheckedAt: now(),
      lastVerifiedAt: verified ? now() : latest.lastVerifiedAt,
      message: verified
        ? 'CallTools agent is Available and monitored by Speak.'
        : 'Speak is retaining Available and retrying the CallTools connection.',
      providerReadFailures: verified ? 0 : latest.providerReadFailures + 1,
      reason: safeDutyMessage(reason || 'calltools_available_reconcile'),
      status: CALLTOOLS_DUTY_STATUS.ON,
    })
    return result.duty
  }

  async function runAgentSessionMutation({
    binding = {},
    campaignFollow = false,
    dialerSourceId = '',
    expectedLeaseId = '',
    mutate,
    preflight,
    prepare,
    profileId = '',
    proveUnavailable: requestUnavailableProof,
    targetReady = true,
  } = {}) {
    assertFunction('mutate', mutate)
    if (preflight !== undefined) assertFunction('preflight', preflight)
    if (prepare !== undefined) assertFunction('prepare', prepare)
    if (requestUnavailableProof !== undefined) {
      assertFunction('proveUnavailable', requestUnavailableProof)
    }
    return runExclusive(async () => {
      const before = await currentDuty()
      const activeLease = isActiveCallToolsDuty(before)
      if (!targetReady && activeLease && !expectedLeaseId) {
        throw statusError(
          400,
          'A scoped CallTools release requires the exact active Speak lease.',
          'calltools_duty_release_scope_incomplete',
        )
      }
      if (!targetReady && expectedLeaseId && before.leaseId !== expectedLeaseId) {
        throw statusError(
          409,
          'CallTools availability changed before the scoped release could run.',
          'calltools_duty_release_scope_mismatch',
        )
      }
      const requestedBinding = normalizeDutyBinding(binding)
      if (!targetReady && !activeLease) {
        if (
          !profileId ||
          !requestedBinding.appUserId ||
          !requestedBinding.campaignId ||
          !requestedBinding.phoneId
        ) {
          throw statusError(
            400,
            'A CallTools Unavailable check requires the exact profile and frozen binding.',
            'calltools_duty_release_scope_incomplete',
          )
        }
        let unavailableProof = null
        try {
          const proofReader = requestUnavailableProof || proveUnavailable
          unavailableProof = proofReader
            ? await proofReader({ binding: requestedBinding, profileId })
            : null
        } catch {
          unavailableProof = null
        }
        if (!provesCallToolsSeatAlreadyUnavailable(unavailableProof, requestedBinding)) {
          throw statusError(
            409,
            'Speak has no active CallTools lease to release and will not change a potentially human-owned seat.',
            'calltools_duty_release_requires_active_lease',
          )
        }
        return {
          duty: before,
          session: {
            applyRequested: true,
            binding: requestedBinding,
            blockers: [],
            idempotent: true,
            mutationPerformed: false,
            note: 'CallTools was already proven Unavailable; no provider state was changed.',
            ok: true,
            provider: 'calltools',
            proof: unavailableProof,
            schemaVersion: 'speak.calltools-agent-session-ensure.v1',
            status: 'not-ready',
            targetReady: false,
          },
        }
      }
      if (
        activeLease &&
        !sameDutyAssignment(before, {
          binding: requestedBinding,
          profileId,
        })
      ) {
        throw statusError(
          409,
          targetReady
            ? 'CallTools availability is already assigned to another agent profile or phone binding.'
            : 'Only the agent profile assigned to the active CallTools lease can make it Unavailable.',
          targetReady
            ? 'calltools_duty_active'
            : 'calltools_duty_assignment_mismatch',
        )
      }
      const frozenBinding = activeLease
        ? normalizeDutyBinding(before.binding)
        : requestedBinding

      if (
        targetReady &&
        campaignFollow &&
        (!profileId || !frozenBinding.appUserId || !frozenBinding.campaignId)
      ) {
        throw statusError(
          400,
          'Making the CallTools agent Available requires a profile, agent user, and campaign binding.',
          'calltools_duty_binding_incomplete',
        )
      }

      if (targetReady && preflight) {
        await preflight({
          activeLease,
          binding: frozenBinding,
          duty: before,
          profileId,
        })
      }

      if (targetReady && activeLease) {
        if (prepare) {
          try {
            await prepare()
          } catch (error) {
            const duty = await rearmLease(
              before,
              'CallTools Available preparation is retrying',
              [error instanceof Error ? error.message : 'calltools_agent_prepare_failed'],
            )
            if (error && typeof error === 'object') error.calltoolsDuty = duty
            throw error
          }
        }
        const session = await mutate(frozenBinding)
        const duty = session?.ok && session?.after?.ready === true
          ? (await transition(before.leaseId, {
              blockers: [],
              lastCheckedAt: now(),
              lastVerifiedAt: now(),
              message: 'CallTools agent is Available and monitored by Speak.',
              providerReadFailures: 0,
              reason: 'operator_available_reaffirmed',
              status: CALLTOOLS_DUTY_STATUS.ON,
            })).duty
          : await rearmLease(before, 'operator_available_reaffirm_retry', session?.blockers)
        return { duty, session }
      }

      if (targetReady && campaignFollow) {
        const leaseId = createLeaseId()
        const armedAt = now()
        const arming = await transition(before.leaseId, {
          binding: frozenBinding,
          blockers: [],
          dialerSourceId,
          gatewayOwnerInstanceId: '',
          lastCheckedAt: '',
          lastVerifiedAt: '',
          leaseId,
          message: 'Making the CallTools agent Available...',
          profileId,
          providerReadFailures: 0,
          reason: 'operator_available',
          startedAt: armedAt,
          status: CALLTOOLS_DUTY_STATUS.ARMING,
        })
        if (!arming.applied || arming.duty.leaseId !== leaseId) {
          throw statusError(
            409,
            'CallTools availability changed before it could be enabled.',
            'calltools_duty_lease_conflict',
          )
        }

        if (prepare) {
          try {
            await prepare()
          } catch (error) {
            const duty = await rearmLease(
              arming.duty,
              'CallTools Available preparation is retrying',
              [error instanceof Error ? error.message : 'calltools_agent_prepare_failed'],
            )
            if (error && typeof error === 'object') error.calltoolsDuty = duty
            throw error
          }
        }

        let session
        try {
          session = await mutate(frozenBinding)
        } catch (error) {
          const duty = await rearmLease(
            arming.duty,
            'CallTools Available enable is retrying',
            [error instanceof Error ? error.message : 'calltools_agent_enable_failed'],
          )
          if (error && typeof error === 'object') error.calltoolsDuty = duty
          throw error
        }

        if (session?.ok && session?.after?.ready === true) {
          let providerStatus
          try {
            providerStatus = await readProviderStatus({
              binding: frozenBinding,
              leaseId,
              profileId,
            })
          } catch (error) {
            providerStatus = {
              agentReadError:
                error instanceof Error ? error.message : 'CallTools agent read failed',
              campaignReadError: 'CallTools campaign read failed',
            }
          }
          const verificationBlockers = normalizeBlockers([
            providerStatus?.agentReadError,
            providerStatus?.campaignReadError,
            providerStatus?.agentReady !== true ? 'CALLTOOLS_AGENT_NOT_READY' : '',
            providerStatus?.campaignActive !== true
              ? 'CALLTOOLS_CAMPAIGN_NOT_ACTIVE'
              : '',
            providerStatus?.originateCalls !== true
              ? 'CALLTOOLS_CAMPAIGN_ORIGINATION_DISABLED'
              : '',
            providerStatus?.gatewayHealthy !== true
              ? 'CALLTOOLS_MEDIA_GATEWAY_NOT_READY'
              : '',
          ])
          if (verificationBlockers.length) {
            const duty = await rearmLease(
              arming.duty,
              'CallTools campaign-follow verification is retrying',
              verificationBlockers,
            )
            return {
              duty,
              session: {
                ...session,
                blockers: normalizeBlockers([
                  ...(session.blockers || []),
                  ...verificationBlockers,
                ]),
                dutyCompensatedOff: false,
                ok: true,
              },
            }
          }
          const result = await transition(leaseId, {
            blockers: [],
            lastVerifiedAt: now(),
            message: 'CallTools agent is Available and monitored by Speak.',
            providerReadFailures: 0,
            reason: 'operator_available',
            status: CALLTOOLS_DUTY_STATUS.ON,
          })
          return { duty: result.duty, session }
        }

        const duty = await disarmLease(arming.duty, 'CallTools availability could not be proven')
        return { duty, session }
      }

      if (!targetReady) {
        const result = await transition(before.leaseId, {
          blockers: [],
          message: 'Making the Speak agent Unavailable in CallTools...',
          reason: 'operator_unavailable',
          status: CALLTOOLS_DUTY_STATUS.DISARMING,
        })
        if (
          !result.applied ||
          result.duty.leaseId !== before.leaseId ||
          result.duty.status !== CALLTOOLS_DUTY_STATUS.DISARMING
        ) {
          throw statusError(
            409,
            'CallTools availability changed before the scoped release could run.',
            'calltools_duty_release_scope_mismatch',
          )
        }
        const duty = result.duty

        let session
        try {
          session = await mutate(normalizeDutyBinding(duty.binding), {
            leaseId: duty.leaseId,
            profileId: duty.profileId,
            status: duty.status,
          })
        } catch (error) {
          if (isActiveCallToolsDuty(duty)) {
            const pending = await markDisarmingRetry(
              duty,
              'Speak is retaining the Unavailable request while the CallTools handoff retries.',
              [error instanceof Error ? error.message : 'calltools_agent_disarm_failed'],
            )
            if (error && typeof error === 'object') error.calltoolsDuty = pending
          }
          throw error
        }

        if (session?.ok && session?.after?.ready === false) {
          const offDuty = await markOff(duty, 'Speak agent is confirmed Unavailable.')
          return { duty: offDuty, session }
        }
        const attention = isActiveCallToolsDuty(duty)
          ? await markDisarmingRetry(
              duty,
              'Speak is retaining the Unavailable request while the CallTools handoff retries.',
              session?.blockers || [session?.patchError || 'calltools_agent_disarm_unproven'],
            )
          : duty
        return { duty: attention, session }
      }

      if (targetReady && prepare) await prepare()
      const session = await mutate(frozenBinding)
      return { duty: before, session }
    })
  }

  async function reconcileUnlocked() {
    const duty = await currentDuty()
    runtime = {
      ...runtime,
      lastCheckedAt: now(),
      lastError: '',
      lastResult: isActiveCallToolsDuty(duty) ? 'checking' : 'idle',
    }
    if (!isActiveCallToolsDuty(duty)) return duty

    if (duty.status === CALLTOOLS_DUTY_STATUS.DISARMING) {
      const result = await disarmLease(duty, `Recovered ${duty.status} CallTools availability lease`)
      runtime.lastResult = result.status
      return result
    }
    if (
      duty.status === CALLTOOLS_DUTY_STATUS.ARMING ||
      duty.status === CALLTOOLS_DUTY_STATUS.ATTENTION
    ) {
      const result = await rearmLease(duty, `Recovered ${duty.status} Available lease`)
      runtime.lastResult = result.status
      return result
    }

    let providerStatus
    try {
      providerStatus = await readProviderStatus({
        binding: duty.binding,
        leaseId: duty.leaseId,
        profileId: duty.profileId,
      })
    } catch (error) {
      providerStatus = {
        agentReadError: error instanceof Error ? error.message : 'CallTools agent read failed',
        campaignReadError: 'CallTools campaign read failed',
      }
    }

    if (providerStatus?.agentReady === false) {
      const result = await rearmLease(duty, 'CallTools agent became Unavailable unexpectedly')
      runtime.lastResult = result.status
      return result
    }

    if (
      providerStatus?.campaignActive === false ||
      providerStatus?.originateCalls === false
    ) {
      const result = await rearmLease(duty, 'CallTools campaign availability is being restored')
      runtime.lastResult = result.status
      return result
    }

    const nativeReadErrors = normalizeBlockers([
      providerStatus?.agentReadError,
      providerStatus?.campaignReadError,
      providerStatus?.agentReady !== true ? 'CALLTOOLS_AGENT_STATUS_UNPROVEN' : '',
      providerStatus?.campaignActive !== true ? 'CALLTOOLS_CAMPAIGN_STATUS_UNPROVEN' : '',
      providerStatus?.originateCalls !== true
        ? 'CALLTOOLS_CAMPAIGN_ORIGINATION_UNPROVEN'
        : '',
    ])
    const gatewayErrors = normalizeBlockers(
      providerStatus?.gatewayHealthy !== true
        ? `CALLTOOLS_MEDIA_GATEWAY_${safeText(providerStatus?.gatewayStatus || 'UNHEALTHY')
            .toUpperCase()
            .replace(/[^A-Z0-9]+/g, '_')}`
        : '',
    )
    const readErrors = normalizeBlockers([...nativeReadErrors, ...gatewayErrors])
    if (readErrors.length) {
      const pending = await rearmLease(
        duty,
        'CallTools Available verification is retrying',
        readErrors,
      )
      runtime.lastError = readErrors.join('; ')
      runtime.lastResult = 'retrying'
      return pending
    }

    const verifiedAt = now()
    runtime.lastResult = 'verified'
    runtime.lastVerifiedAt = verifiedAt
    const persistedVerifiedAt = Date.parse(duty.lastVerifiedAt || '') || 0
    if (
      duty.providerReadFailures > 0 ||
      !persistedVerifiedAt ||
      Date.parse(verifiedAt) - persistedVerifiedAt >= verifiedPersistIntervalMs
    ) {
      const result = await transition(duty.leaseId, {
        blockers: [],
        lastCheckedAt: verifiedAt,
        lastVerifiedAt: verifiedAt,
        message: 'CallTools agent is Available and monitored by Speak.',
        providerReadFailures: 0,
        reason: 'calltools_duty_verified',
        status: CALLTOOLS_DUTY_STATUS.ON,
      })
      return result.duty
    }
    return duty
  }

  function reconcileNow() {
    return runExclusive(async () => {
      try {
        return await reconcileUnlocked()
      } catch (error) {
        runtime = {
          ...runtime,
          lastCheckedAt: now(),
          lastError: error instanceof Error ? error.message : 'CallTools availability monitor failed',
          lastResult: 'error',
        }
        logger.warn?.('CallTools availability monitor failed:', runtime.lastError)
        throw error
      }
    })
  }

  function scheduleNext(delayMs) {
    timer = setTimeout(async () => {
      try {
        await reconcileNow()
      } catch {
        // The next bounded tick retries. Never arm from this path.
      } finally {
        if (started) scheduleNext(intervalMs)
      }
    }, delayMs)
    timer.unref?.()
  }

  function start() {
    if (started) return
    started = true
    scheduleNext(0)
  }

  function stop() {
    started = false
    if (timer) clearTimeout(timer)
    timer = null
  }

  async function publicState(requestedProfileId = '') {
    const duty = await currentDuty()
    return {
      appliesToRequestedProfile: Boolean(
        !requestedProfileId || !duty.profileId || requestedProfileId === duty.profileId,
      ),
      autoRearm: true,
      backendMonitored: true,
      binding: duty.binding,
      blockers: duty.blockers,
      gatewayOwnerInstanceId: duty.gatewayOwnerInstanceId,
      lastCheckedAt: runtime.lastCheckedAt || duty.lastCheckedAt,
      lastError: runtime.lastError,
      lastVerifiedAt: runtime.lastVerifiedAt || duty.lastVerifiedAt,
      leaseId: duty.leaseId,
      message: duty.message,
      profileId: duty.profileId,
      reason: duty.reason,
      status: duty.status,
    }
  }

  return {
    publicState,
    reconcileNow,
    runAgentSessionMutation,
    start,
    stop,
  }
}

export function isActiveCallToolsDuty(value = {}) {
  const duty = normalizeDutyState(value)
  return Boolean(duty.leaseId && activeDutyStatuses.has(duty.status))
}

function provesCallToolsSeatAlreadyUnavailable(proof = {}, expectedBinding = {}) {
  const actualBinding = normalizeDutyBinding(proof?.binding)
  const expected = normalizeDutyBinding(expectedBinding)
  return Boolean(
    proof?.seatClaimProofRead === true &&
      proof?.seatClaimSafe === true &&
      proof?.humanSeatActive === false &&
      proof?.agentReady === false &&
      proof?.agentLoggedIn === false &&
      proof?.campaignAgentReady === false &&
      proof?.agentLiveCallsCount === 0 &&
      proof?.liveCallsCount === 0 &&
      !safeText(proof?.agentReadError) &&
      !safeText(proof?.campaignAgentReadError) &&
      !safeText(proof?.liveCallsReadError) &&
      actualBinding.appUserId === expected.appUserId &&
      actualBinding.campaignId === expected.campaignId
  )
}

export function normalizeDutyState(value = {}) {
  const source = value?.dialerState?.calltoolsDuty || value?.calltoolsDuty || value || {}
  const status = Object.values(CALLTOOLS_DUTY_STATUS).includes(source.status)
    ? source.status
    : CALLTOOLS_DUTY_STATUS.OFF
  return {
    binding: normalizeDutyBinding(source.binding),
    blockers: normalizeBlockers(source.blockers),
    gatewayOwnerInstanceId: safeText(source.gatewayOwnerInstanceId),
    lastCheckedAt: safeText(source.lastCheckedAt),
    lastVerifiedAt: safeText(source.lastVerifiedAt),
    leaseId: safeText(source.leaseId),
    message: safeDutyMessage(source.message),
    profileId: safeText(source.profileId),
    providerReadFailures: Math.max(0, Number(source.providerReadFailures || 0)),
    reason: safeDutyMessage(source.reason),
    startedAt: safeText(source.startedAt),
    status,
    transitionAt: safeText(source.transitionAt),
  }
}

export function normalizeDutyBinding(value = {}) {
  return {
    appUserId: safeText(value.appUserId || value.userId),
    campaignId: safeText(value.campaignId),
    phoneId: safeText(value.phoneId),
  }
}

function sameActiveLease(left, right) {
  return Boolean(
    isActiveCallToolsDuty(left) &&
    isActiveCallToolsDuty(right) &&
    left.leaseId === right.leaseId,
  )
}

function sameDutyAssignment(duty, { binding = {}, profileId = '' } = {}) {
  const currentBinding = normalizeDutyBinding(duty?.binding)
  const requestedBinding = normalizeDutyBinding(binding)
  return Boolean(
    safeText(profileId) === safeText(duty?.profileId) &&
      currentBinding.appUserId === requestedBinding.appUserId &&
      currentBinding.campaignId === requestedBinding.campaignId &&
      currentBinding.phoneId === requestedBinding.phoneId,
  )
}

function safeText(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim()
}

function safeDutyMessage(value) {
  return safeText(value).slice(0, 320)
}

function normalizeBlockers(value) {
  return Array.from(
    new Set((Array.isArray(value) ? value : [value]).map(safeDutyMessage).filter(Boolean)),
  ).slice(0, 8)
}

function assertFunction(name, value) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`)
}

function statusError(status, message, code) {
  return Object.assign(new Error(message), { code, status })
}
