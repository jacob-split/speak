import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useEffect,
  useRef,
} from 'react'
import { resolveCallConfig } from './agentConfigs'
import { apiUrl } from './api'
import {
  isActiveCallLive,
  isLiveRecentCall,
  makeTranscriptEntry,
  shouldAutoAdvanceForOutcome,
  shouldAutoEndForOutcome,
  todayLabel,
} from './calls'
import type { RecentCallSummary } from './calls'
import { isContactSourceKeyForSource } from './contactSources'
import {
  isCampaignDialable,
  isValidPhoneNumber,
  statusLabels,
  statusForOutcome,
} from './leads'
import type {
  ActiveCall,
  CallOutcome,
  CampaignConfig,
  DialerWorkspaceState,
  Lead,
  TranscriptEntry,
  VoiceBackendStatus,
} from './types'

export type ControlBusy =
  | 'idle'
  | 'start'
  | 'next'
  | 'end'
  | 'takeover'
  | 'release'

interface RefreshRecentCallsOptions {
  recoverCampaign?: boolean
}

interface UseDialerCallControllerOptions {
  activeCall: ActiveCall | null
  activeCallIsLive: boolean
  activeCallRef: MutableRefObject<ActiveCall | null>
  activeHistoryCall: RecentCallSummary | null
  activeLead: Lead | null
  autoAdvanceKeyRef: MutableRefObject<string>
  autoDialTimerRef: MutableRefObject<number | null>
  autoEndingOutcomeRef: MutableRefObject<string>
  campaignConfig: CampaignConfig
  callToolsDuty?: DialerWorkspaceState['calltoolsDuty']
  campaignQueueIds: string[]
  campaignQueueIdsRef: MutableRefObject<string[]>
  campaignRunning: boolean
  campaignRunningRef: MutableRefObject<boolean>
  controlBusy: ControlBusy
  controlsLocked: boolean
  contactSourceKey: string
  filteredLeads: Lead[]
  leads: Lead[]
  leadsRef: MutableRefObject<Lead[]>
  markQueuedInstructionsAttached: (count: number) => void
  queuedInstructionTexts: string[]
  recentCallsLoaded: boolean
  refreshActiveAgentCallConfig?: () => Promise<CampaignConfig>
  refreshRecentCalls: (options?: RefreshRecentCallsOptions) => Promise<RecentCallSummary[]>
  scheduleNextCampaignCallRef: MutableRefObject<
    ((afterLeadId: string, outcome: CallOutcome) => void) | null
  >
  selectedIds: Set<string>
  selectedLeadId: string | null
  setActiveCall: Dispatch<SetStateAction<ActiveCall | null>>
  setCampaignConfig: Dispatch<SetStateAction<CampaignConfig>>
  setCampaignQueueIds: Dispatch<SetStateAction<string[]>>
  setCampaignRunning: Dispatch<SetStateAction<boolean>>
  setCampaignStatus: Dispatch<SetStateAction<string>>
  setControlBusy: Dispatch<SetStateAction<ControlBusy>>
  setNotice: (message: string) => void
  setSelectedLeadId: Dispatch<SetStateAction<string | null>>
  setTranscript: Dispatch<SetStateAction<TranscriptEntry[]>>
  stopHumanAudioStream: () => void
  updateLead: (id: string, patch: Partial<Lead>) => void
  voiceBackend: VoiceBackendStatus
  voiceReady: boolean
}

function currentTimestamp() {
  return Date.now()
}

interface CallToolsReadinessPayload {
  blockers?: string[]
  campaignReady?: boolean
  directStartReady?: boolean
  error?: string
  liveCallAttached?: boolean
  ready?: boolean
  runtimeReady?: boolean
  dutyMonitor?: CallToolsDutyMonitorProof
}

interface CallToolsAgentSessionPayload {
  after?: {
    ready?: boolean
  }
  campaignAgentStatus?: {
    ready?: boolean
  }
  campaignStart?: {
    ok?: boolean
  }
  blockers?: string[]
  error?: string
  ok?: boolean
  patchError?: string
  proof?: {
    loggedIn?: boolean
  }
  dutyMonitor?: CallToolsDutyMonitorProof
}

interface CallToolsDutyMonitorProof {
  autoRearm?: boolean
  backendMonitored?: boolean
  message?: string
  status?: string
}

export function useDialerCallController({
  activeCall,
  activeCallIsLive,
  activeCallRef,
  activeHistoryCall,
  activeLead,
  autoAdvanceKeyRef,
  autoDialTimerRef,
  autoEndingOutcomeRef,
  campaignConfig,
  callToolsDuty,
  campaignQueueIds,
  campaignQueueIdsRef,
  campaignRunning,
  campaignRunningRef,
  controlBusy,
  controlsLocked,
  contactSourceKey,
  filteredLeads,
  leads,
  leadsRef,
  markQueuedInstructionsAttached,
  queuedInstructionTexts,
  recentCallsLoaded,
  refreshActiveAgentCallConfig,
  refreshRecentCalls,
  scheduleNextCampaignCallRef,
  selectedIds,
  selectedLeadId,
  setActiveCall,
  setCampaignConfig,
  setCampaignQueueIds,
  setCampaignRunning,
  setCampaignStatus,
  setControlBusy,
  setNotice,
  setSelectedLeadId,
  setTranscript,
  stopHumanAudioStream,
  updateLead,
  voiceBackend,
  voiceReady,
}: UseDialerCallControllerOptions) {
  const endCallRef = useRef<
    ((
      options?: {
        outcome?: CallOutcome
        autoAdvance?: boolean
        busyAction?: ControlBusy
      },
    ) => Promise<void>) | null
  >(null)

  function campaignSourceLeads(sourceLeads = leadsRef.current) {
    const visibleLeadIds = new Set(filteredLeads.map((lead) => lead.id))
    const visibleLeads = sourceLeads.filter((lead) => visibleLeadIds.has(lead.id))
    if (selectedIds.size > 0) {
      return visibleLeads.filter((lead) => selectedIds.has(lead.id))
    }

    return visibleLeads
  }

  function findNextCampaignLead(afterLeadId?: string) {
    const ids = campaignQueueIdsRef.current
    const leadsById = new Map(leadsRef.current.map((lead) => [lead.id, lead]))
    const startIndex = afterLeadId ? Math.max(0, ids.indexOf(afterLeadId) + 1) : 0

    for (let index = startIndex; index < ids.length; index += 1) {
      const lead = leadsById.get(ids[index])
      if (lead && isCampaignDialable(lead)) return lead
    }

    return null
  }

  function scheduleNextCampaignCall(afterLeadId: string, outcome: CallOutcome) {
    if (autoDialTimerRef.current) {
      window.clearTimeout(autoDialTimerRef.current)
    }

    const nextLead = findNextCampaignLead(afterLeadId)
    if (!nextLead) {
      campaignRunningRef.current = false
      setCampaignRunning(false)
      setCampaignStatus(`Queue complete after ${statusLabels[statusForOutcome(outcome)]}`)
      setNotice('Campaign complete')
      return
    }

    setCampaignStatus(`Next: ${nextLead.name} / ${nextLead.company}`)
    autoDialTimerRef.current = window.setTimeout(() => {
      autoDialTimerRef.current = null
      if (!campaignRunningRef.current) return
      void startCall(nextLead, { fromCampaign: true, busyAction: 'next' })
    }, 1800)
  }

  function markCampaignStartFailure(lead: Lead, message: string) {
    updateLead(lead.id, {
      status: 'failed',
      lastCall: todayLabel(),
      notes: lead.notes
        ? `${lead.notes}\nDial start failed: ${message}`
        : `Dial start failed: ${message}`,
    })

    if (!campaignRunningRef.current) return

    setNotice(`${message}. Moving to next contact.`)
    setCampaignStatus(`Start failed for ${lead.name}; advancing queue`)
    scheduleNextCampaignCall(lead.id, 'failed')
  }

  async function startCall(
    lead: Lead,
    options: { fromCampaign?: boolean; busyAction?: ControlBusy } = {},
  ) {
    if (lead.status === 'do-not-call') {
      setNotice('Contact is marked do not call')
      if (options.fromCampaign) {
        markCampaignStartFailure(lead, 'Contact is marked do not call')
      }
      return false
    }

    if (!isValidPhoneNumber(lead.phone)) {
      setNotice('Enter a valid E.164 phone number before calling')
      if (options.fromCampaign) {
        markCampaignStartFailure(lead, 'Invalid phone number')
      }
      return false
    }

    if (!voiceReady) {
      setNotice(voiceBackend.message)
      return false
    }

    if (activeCallIsLive) {
      setNotice('Finish the active call before starting another one')
      return false
    }

    const busyAction = options.busyAction || 'start'
    const operatorInstructions = queuedInstructionTexts

    try {
      setControlBusy(busyAction)
      setNotice('Syncing active agent configuration...')
      const callConfig = refreshActiveAgentCallConfig
        ? await refreshActiveAgentCallConfig()
        : resolveCallConfig(campaignConfig)
      const directCallConfig = {
        ...callConfig,
        dialerProvider: 'speak' as const,
      }
      setCampaignConfig(callConfig)
      setNotice(`Requesting call for ${lead.company}`)
      const response = await fetch(apiUrl('/calls/start'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lead,
          config: directCallConfig,
          operatorInstructions,
        }),
      })
      const payload = await response.json().catch(() => ({}))

      if (!response.ok) {
        throw new Error(payload.error || 'Call request failed')
      }

      const nextActiveCall = {
        leadId: lead.id,
        callControlId: payload.callControlId,
        chatId: payload.chatId,
        streamId: payload.streamId,
        phase: 'dialing',
        startedAt: currentTimestamp(),
        takeover: false,
        outcome: undefined,
      } satisfies ActiveCall
      activeCallRef.current = nextActiveCall
      setActiveCall(nextActiveCall)
      setSelectedLeadId(lead.id)
      if (operatorInstructions.length > 0) {
        markQueuedInstructionsAttached(operatorInstructions.length)
      }
      setTranscript([
        makeTranscriptEntry({
          speaker: 'System',
          text: `Call requested for ${lead.name}. Waiting for live provider events.`,
          tone: 'system',
        }),
      ])
      updateLead(lead.id, { status: 'calling', lastCall: 'In progress' })
      setNotice(
        options.fromCampaign
          ? `Campaign dialing ${lead.name}`
          : `Call requested for ${lead.company}`,
      )
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Call request failed'
      setNotice(message)
      if (options.fromCampaign) {
        markCampaignStartFailure(lead, message)
      }
      return false
    } finally {
      setControlBusy('idle')
    }
  }

  async function endHistoryCall(
    call: RecentCallSummary,
    outcome: CallOutcome,
    busyAction: ControlBusy = 'end',
  ) {
    if (controlsLocked) return

    try {
      setControlBusy(busyAction)
      setNotice(outcome === 'skipped' ? 'Skipping current call...' : 'Ending call...')
      const response = await fetch(apiUrl(`/calls/${call.callControlId}/end`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outcome }),
      })
      const payload = await response.json()

      if (!response.ok) {
        throw new Error(payload.error || 'End call failed')
      }

      await refreshRecentCalls({ recoverCampaign: false })
      setNotice(outcome === 'skipped' ? 'Call skipped' : 'Call ended')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'End call failed')
    } finally {
      setControlBusy('idle')
    }
  }

  async function endCall(
    options: {
      outcome?: CallOutcome
      autoAdvance?: boolean
      busyAction?: ControlBusy
    } = {},
  ) {
    if (controlsLocked && !options.busyAction) return
    if (!activeCall) return
    const outcome = options.outcome || 'operator-ended'
    const busyAction = options.busyAction || (outcome === 'skipped' ? 'next' : 'end')

    try {
      setControlBusy(busyAction)
      setNotice(outcome === 'skipped' ? 'Skipping current call...' : 'Ending call...')
      stopHumanAudioStream()
      const response = await fetch(apiUrl(`/calls/${activeCall.callControlId}/end`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outcome }),
      })
      const payload = await response.json()

      if (!response.ok) {
        throw new Error(payload.error || 'End call failed')
      }

      const finalOutcome = (payload.outcome as CallOutcome) || activeCall.outcome || outcome

      setActiveCall((current) =>
        current
          ? (() => {
              const next = {
                ...current,
                phase: 'ended' as const,
                takeover: false,
                outcome: finalOutcome,
              }
              activeCallRef.current = next
              return next
            })()
          : current,
      )
      if (activeLead) {
        updateLead(activeLead.id, {
          status:
            activeLead.status === 'do-not-call'
              ? 'do-not-call'
              : statusForOutcome(finalOutcome),
          lastCall: todayLabel(),
        })
      }
      setNotice(
        payload.alreadyEnded
          ? 'Call was already ended; queue control recovered'
          : finalOutcome === 'skipped'
            ? 'Call skipped'
            : 'Call ended',
      )
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'End call failed')
    } finally {
      setControlBusy('idle')
    }
  }

  async function startCampaign() {
    if (controlsLocked) return

    if (isContactSourceKeyForSource(contactSourceKey, 'calltools')) {
      let enableAttempted = false
      try {
        setControlBusy('start')
        setNotice('Starting the CallTools campaign and agent session...')
        await refreshRecentCalls({ recoverCampaign: false })
        const callConfig = refreshActiveAgentCallConfig
          ? await refreshActiveAgentCallConfig()
          : resolveCallConfig(campaignConfig)
        if (!callConfig.agentProfileId) {
          throw new Error('Select a saved agent profile before making CallTools Available.')
        }
        enableAttempted = true
        const sessionResponse = await fetch(apiUrl('/calltools/agent-session'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contactSourceKey,
            profileId: callConfig.agentProfileId,
            mode: 'campaign-follow',
            ready: true,
            apply: true,
            confirmAgentSession: true,
            requireCampaignReady: true,
          }),
        })
        const session = (await sessionResponse.json().catch(() => ({}))) as CallToolsAgentSessionPayload
        if (
          !sessionResponse.ok ||
          !session.ok ||
          session.campaignStart?.ok !== true ||
          session.campaignAgentStatus?.ready !== true ||
          session.proof?.loggedIn !== true ||
          session.after?.ready !== true ||
          session.dutyMonitor?.backendMonitored !== true ||
          session.dutyMonitor?.autoRearm !== true ||
          session.dutyMonitor?.status !== 'on'
        ) {
          throw new Error(
            session.error ||
              session.patchError ||
              session.dutyMonitor?.message ||
              session.blockers?.slice(0, 3).join(', ') ||
              'CallTools agent could not be made Available',
          )
        }
        const params = new URLSearchParams()
        params.set('profileId', callConfig.agentProfileId)
        const response = await fetch(
          apiUrl(`/calltools/readiness${params.toString() ? `?${params.toString()}` : ''}`),
        )
        const readiness = (await response.json().catch(() => ({}))) as CallToolsReadinessPayload
        if (!response.ok) {
          throw new Error(readiness.error || 'CallTools readiness check failed')
        }
        if (
          !readiness.ready ||
          !readiness.runtimeReady ||
          !readiness.campaignReady ||
          readiness.dutyMonitor?.backendMonitored !== true ||
          readiness.dutyMonitor?.autoRearm !== true ||
          readiness.dutyMonitor?.status !== 'on'
        ) {
          throw new Error(
            readiness.dutyMonitor?.message ||
            readiness.blockers?.slice(0, 3).join(', ') ||
              'CallTools runtime and campaign readiness were not proven',
          )
        }
        campaignRunningRef.current = true
        setCampaignRunning(true)
        setCampaignQueueIds([])
        campaignQueueIdsRef.current = []
        if (readiness.liveCallAttached) {
          setCampaignStatus('Following active CallTools call')
          setNotice('CallTools live call attached.')
        } else {
          setCampaignStatus('Available for CallTools campaign calls')
          setNotice('CallTools campaign and Speak agent are running and waiting for a human answer.')
        }
      } catch (error) {
        const failureMessage =
          error instanceof Error ? error.message : 'CallTools availability failed'
        let dutyActive = enableAttempted
        let dutyMessage = ''
        let dutyStatus = dutyActive ? 'attention' : 'off'
        try {
          const stateResponse = await fetch(apiUrl('/dialer-state'))
          const statePayload = (await stateResponse.json().catch(() => ({}))) as {
            dialerState?: DialerWorkspaceState
          }
          const duty = statePayload.dialerState?.calltoolsDuty
          if (stateResponse.ok && duty) {
            dutyStatus = duty.status || 'off'
            dutyActive = Boolean(
              duty.leaseId &&
                ['arming', 'attention', 'disarming', 'on'].includes(dutyStatus),
            )
            dutyMessage = duty.message || ''
          }
        } catch {
          // Keep the UI conservative until the backend monitor can be read.
        }
        campaignRunningRef.current = dutyActive
        setCampaignRunning(dutyActive)
        setCampaignStatus(
          dutyActive
            ? dutyStatus === 'on'
              ? 'Available for CallTools campaign calls'
              : 'CallTools availability needs verification'
            : 'Unavailable for CallTools campaign calls',
        )
        setNotice(
          dutyMessage ||
            (dutyActive
              ? `${failureMessage}. Speak is still retaining Available in the background.`
              : `${failureMessage}. The agent is Unavailable.`),
        )
      } finally {
        setControlBusy('idle')
      }
      return
    }

    if (!voiceReady) {
      setNotice(voiceBackend.message)
      return
    }

    if (!recentCallsLoaded) {
      setNotice('Loading prior call outcomes before building the queue')
    }

    if (activeCallIsLive) {
      setNotice('Finish or skip the active call before starting the campaign')
      return
    }

    setControlBusy('start')
    setNotice('Refreshing worked contact history before dialing...')
    await refreshRecentCalls({ recoverCampaign: false })

    const queue = campaignSourceLeads().filter(isCampaignDialable)
    if (queue.length === 0) {
      setNotice('No ready contacts with valid phone numbers in this view')
      setControlBusy('idle')
      return
    }

    const queueIds = queue.map((lead) => lead.id)
    campaignQueueIdsRef.current = queueIds
    campaignRunningRef.current = true
    autoAdvanceKeyRef.current = ''
    autoEndingOutcomeRef.current = ''
    setCampaignQueueIds(queueIds)
    setCampaignRunning(true)
    setCampaignStatus(`Dialing 1 of ${queue.length}: ${queue[0].name}`)
    const started = await startCall(queue[0], {
      fromCampaign: true,
      busyAction: 'start',
    })
    if (!started && !campaignRunningRef.current) {
      campaignRunningRef.current = false
      setCampaignRunning(false)
      setCampaignStatus('Queue did not start')
      setControlBusy('idle')
    }
  }

  async function stopCampaign() {
    if (autoDialTimerRef.current) {
      window.clearTimeout(autoDialTimerRef.current)
      autoDialTimerRef.current = null
    }
    if (isContactSourceKeyForSource(contactSourceKey, 'calltools')) {
      try {
        setControlBusy('start')
        setNotice('Making the CallTools agent Unavailable...')
        const response = await fetch(apiUrl('/calltools/agent-session'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            expectedLeaseId: callToolsDuty?.leaseId,
            profileId: callToolsDuty?.profileId,
            appUserId: callToolsDuty?.binding?.appUserId,
            campaignId: callToolsDuty?.binding?.campaignId,
            phoneId: callToolsDuty?.binding?.phoneId,
            mode: 'paused',
            ready: false,
            apply: true,
            confirmAgentSession: true,
          }),
        })
        const session = (await response.json().catch(() => ({}))) as CallToolsAgentSessionPayload
        if (!response.ok || !session.ok || session.after?.ready !== false) {
          throw new Error(
            session.error ||
              session.patchError ||
              session.blockers?.slice(0, 3).join(', ') ||
              'CallTools agent may still be Available',
          )
        }
        campaignRunningRef.current = false
        setCampaignRunning(false)
        setCampaignStatus('Unavailable for CallTools campaign calls')
        setNotice('CallTools agent is Unavailable. Speak released the shared phone for the human agent.')
      } catch (error) {
        setCampaignStatus('CallTools agent may still be Available')
        setNotice(error instanceof Error ? error.message : 'CallTools agent may still be Available')
      } finally {
        setControlBusy('idle')
      }
      return
    }
    campaignRunningRef.current = false
    setCampaignRunning(false)
    setCampaignStatus('Queue stopped')
    setNotice('Campaign queue stopped. End or skip the live call separately.')
  }

  async function skipToNext() {
    if (controlsLocked) return

    if (!activeCall && activeHistoryCall && isLiveRecentCall(activeHistoryCall)) {
      await endHistoryCall(activeHistoryCall, 'skipped', 'next')
      return
    }

    if (!isActiveCallLive(activeCall)) {
      const nextLead = findNextCampaignLead(activeCall?.leadId)
      if (!nextLead) {
        setNotice('No queued contact is ready to call')
        return
      }
      if (!campaignRunning) {
        campaignRunningRef.current = true
        setCampaignRunning(true)
      }
      await startCall(nextLead, { fromCampaign: true, busyAction: 'next' })
      return
    }

    await endCall({ outcome: 'skipped', autoAdvance: true, busyAction: 'next' })
  }

  useEffect(() => {
    activeCallRef.current = activeCall
  }, [activeCall, activeCallRef])

  useEffect(() => {
    if (!activeCall || isActiveCallLive(activeCall)) return
    const leadStillExists = leads.some((lead) => lead.id === activeCall.leadId)
    if (leadStillExists) return

    const timeout = window.setTimeout(() => {
      activeCallRef.current = null
      setActiveCall(null)
      setTranscript([
        makeTranscriptEntry({
          speaker: 'System',
          text: 'Workspace initialized.',
          tone: 'system',
        }),
      ])
    }, 0)

    return () => window.clearTimeout(timeout)
  }, [activeCall, activeCallRef, leads, setActiveCall, setTranscript])

  useEffect(() => {
    if (controlBusy === 'idle') return undefined

    const timeout = window.setTimeout(() => {
      setControlBusy('idle')
      setNotice('Action timed out before the backend confirmed it. Controls unlocked.')
    }, 25_000)

    return () => window.clearTimeout(timeout)
  }, [controlBusy, setControlBusy, setNotice])

  useEffect(() => {
    campaignQueueIdsRef.current = campaignQueueIds
  }, [campaignQueueIds, campaignQueueIdsRef])

  useEffect(() => {
    campaignRunningRef.current = campaignRunning
  }, [campaignRunning, campaignRunningRef])

  useEffect(() => {
    scheduleNextCampaignCallRef.current = scheduleNextCampaignCall
    endCallRef.current = endCall
  })

  useEffect(() => {
    if (activeCallIsLive) return

    const nextSelectedLeadId =
      selectedLeadId && filteredLeads.some((lead) => lead.id === selectedLeadId)
        ? selectedLeadId
        : filteredLeads[0]?.id || null

    if (selectedLeadId === nextSelectedLeadId) return

    const timeout = window.setTimeout(() => {
      setSelectedLeadId(nextSelectedLeadId)
    }, 0)

    return () => window.clearTimeout(timeout)
  }, [activeCallIsLive, filteredLeads, selectedLeadId, setSelectedLeadId])

  useEffect(() => {
    return () => {
      if (autoDialTimerRef.current) {
        window.clearTimeout(autoDialTimerRef.current)
      }
    }
  }, [autoDialTimerRef])

  useEffect(() => {
    if (!activeCall?.outcome || !isActiveCallLive(activeCall)) return
    if (!shouldAutoEndForOutcome(activeCall.outcome)) return

    const key = `${activeCall.callControlId}:${activeCall.outcome}`
    if (autoEndingOutcomeRef.current === key) return
    autoEndingOutcomeRef.current = key

    window.setTimeout(() => {
      void endCallRef.current?.({
        outcome: activeCall.outcome,
        autoAdvance: true,
      })
    }, 1200)
  }, [activeCall, autoEndingOutcomeRef])

  useEffect(() => {
    if (!campaignRunning || !activeCall || activeCall.phase !== 'ended') return
    if (isContactSourceKeyForSource(contactSourceKey, 'calltools')) return
    const outcome = activeCall.outcome || 'completed'
    if (!shouldAutoAdvanceForOutcome(outcome)) return

    const key = `${activeCall.callControlId}:${outcome}`
    if (autoAdvanceKeyRef.current === key) return
    autoAdvanceKeyRef.current = key
    scheduleNextCampaignCallRef.current?.(activeCall.leadId, outcome)
  }, [
    activeCall,
    autoAdvanceKeyRef,
    campaignRunning,
    contactSourceKey,
    scheduleNextCampaignCallRef,
  ])

  return {
    endCall,
    skipToNext,
    startCall,
    startCampaign,
    stopCampaign,
  }
}
