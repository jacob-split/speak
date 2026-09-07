import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { CallTranscriptConsole } from './CallTranscriptConsole'
import { DialerRunButton, DialerRunControls } from './DialerRunControls'
import { DialerTopbar } from './DialerTopbar'
import { DeviceCallButton } from './DeviceCallButton'
import { GlobalSearchOverlay } from './GlobalSearchOverlay'
import { LeadBulkActionBar } from './LeadBulkActionBar'
import { LeadQueuePanel } from './LeadQueuePanel'
import { LeadQueueToolbar } from './LeadQueueToolbar'
import {
  clearActiveAgentProfileId,
  loadActiveAgentProfileId,
  loadAgentProfiles,
  normalizeAgentProfile,
  resolveCallConfig,
  saveActiveAgentProfileId,
  saveAgentProfiles,
  type AgentConfigProfile,
} from './agentConfigs'
import {
  apiBase,
  apiUrl,
} from './api'
import { getBrowserStorage } from './browserStorage'
import {
  callMatchesLead,
  isActiveCallLive,
  isLiveRecentCall,
  makeTranscriptEntry,
} from './calls'
import {
  buildContactSourceOptionsFromLeads,
  contactSourceKeyFromDialerSourceId,
  contactSourceLabel,
  dialerSourceIdFromContactSourceKey,
  isContactSourceKeyForSource,
} from './contactSources'
import {
  callToolsDutyIsActive,
  resolveDialerAgentProfileId,
} from './dialerAgentSelection'
import { defaultCampaignConfig } from './data'
import {
  currentAppPathname,
  listenToAppNavigation,
} from './navigation'
import {
  isCampaignDialable,
  isValidPhoneNumber,
  type ScoreFilter,
  type SortField,
  type StatusFilter,
} from './leads'
import type {
  ActiveCall,
  CallOutcome,
  CampaignConfig,
  CallPhase,
  DialerWorkspaceState,
  TranscriptEntry,
} from './types'
import { useCallAudioPlayback } from './useCallAudioPlayback'
import { useDialerReadModel } from './useDialerReadModel'
import { useLeadWorkspace } from './useLeadWorkspace'
import { useHumanTakeover } from './useHumanTakeover'
import { useLiveInstructions } from './useLiveInstructions'
import { useRecentCalls } from './useRecentCalls'
import { useActiveCallEvents } from './useActiveCallEvents'
import { useActiveCallTranscript } from './useActiveCallTranscript'
import { useRecentCallRecovery } from './useRecentCallRecovery'
import { useAppearance } from './useAppearance'
import {
  useDialerCallController,
  type ControlBusy,
} from './useDialerCallController'
import { useVoiceBackendStatus } from './useVoiceBackendStatus'
import { formatOperationalDateTime } from './time'
import { speakRouteIds, speakTestIds } from './uiContract'
import './App.css'

const dialerClientIdStorageKey = 'speak:dialer-client-id:v1'
const staleDialerControllerMs = 15_000
let inMemoryDialerClientId = ''

const AgentConfigWorkspace = lazy(() =>
  import('./AgentConfigWorkspace').then((module) => ({
    default: module.AgentConfigWorkspace,
  })),
)

const LibraryWorkspace = lazy(() =>
  import('./LibraryWorkspace').then((module) => ({
    default: module.LibraryWorkspace,
  })),
)

function createDialerClientId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `dialer-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function getInMemoryDialerClientId() {
  if (!inMemoryDialerClientId) {
    inMemoryDialerClientId = createDialerClientId()
  }
  return inMemoryDialerClientId
}

function getDialerClientId() {
  if (typeof window === 'undefined') return 'server'
  try {
    const storage = getBrowserStorage()
    if (!storage) return getInMemoryDialerClientId()
    const existing = storage?.getItem(dialerClientIdStorageKey)
    if (existing) return existing
    const next = createDialerClientId()
    storage.setItem(dialerClientIdStorageKey, next)
    return next
  } catch {
    // Backend dialer state still receives this in-memory controller ID.
    return getInMemoryDialerClientId()
  }
}

interface DialerContactSourceOption {
  id: string
  label: string
}

type DialerCallToolsDuty = NonNullable<DialerWorkspaceState['calltoolsDuty']>

function recentCallPhase(value?: string): CallPhase {
  if (value === 'dialing' || value === 'live' || value === 'handoff') return value
  return 'live'
}

function useMobileVisualViewport() {
  useEffect(() => {
    const root = document.documentElement

    function updateViewportMetrics() {
      const viewport = window.visualViewport
      const height = viewport?.height || window.innerHeight
      const offsetTop = viewport?.offsetTop || 0
      const keyboardInset = Math.max(0, window.innerHeight - height - offsetTop)

      root.style.setProperty('--speak-visual-viewport-height', `${Math.round(height)}px`)
      root.style.setProperty('--speak-keyboard-inset', `${Math.round(keyboardInset)}px`)
      root.dataset.mobileKeyboardOpen = keyboardInset > 80 ? 'true' : 'false'
    }

    updateViewportMetrics()
    window.visualViewport?.addEventListener('resize', updateViewportMetrics)
    window.visualViewport?.addEventListener('scroll', updateViewportMetrics)
    window.addEventListener('orientationchange', updateViewportMetrics)
    window.addEventListener('resize', updateViewportMetrics)

    return () => {
      window.visualViewport?.removeEventListener('resize', updateViewportMetrics)
      window.visualViewport?.removeEventListener('scroll', updateViewportMetrics)
      window.removeEventListener('orientationchange', updateViewportMetrics)
      window.removeEventListener('resize', updateViewportMetrics)
      root.style.removeProperty('--speak-visual-viewport-height')
      root.style.removeProperty('--speak-keyboard-inset')
      delete root.dataset.mobileKeyboardOpen
    }
  }, [])
}

function useMobileNativeViewportGuard() {
  useEffect(() => {
    const root = document.documentElement
    const mobileMedia = window.matchMedia('(max-width: 760px), (pointer: coarse)')
    const activeListenerOptions: AddEventListenerOptions = { passive: false }

    function viewportLockActive() {
      return mobileMedia.matches
    }

    function updateViewportLock() {
      root.dataset.mobileViewportLocked = viewportLockActive() ? 'true' : 'false'
    }

    function preventMobileScale(event: Event) {
      if (!viewportLockActive()) return
      event.preventDefault()
    }

    function preventMobileWheelZoom(event: WheelEvent) {
      if (!viewportLockActive() || !event.ctrlKey) return
      event.preventDefault()
    }

    function preventMultiTouchMove(event: TouchEvent) {
      if (!viewportLockActive() || event.touches.length < 2) return
      event.preventDefault()
    }

    updateViewportLock()
    mobileMedia.addEventListener('change', updateViewportLock)
    document.addEventListener('gesturestart', preventMobileScale, activeListenerOptions)
    document.addEventListener('gesturechange', preventMobileScale, activeListenerOptions)
    document.addEventListener('gestureend', preventMobileScale, activeListenerOptions)
    document.addEventListener('touchmove', preventMultiTouchMove, activeListenerOptions)
    document.addEventListener('wheel', preventMobileWheelZoom, activeListenerOptions)

    return () => {
      mobileMedia.removeEventListener('change', updateViewportLock)
      document.removeEventListener('gesturestart', preventMobileScale)
      document.removeEventListener('gesturechange', preventMobileScale)
      document.removeEventListener('gestureend', preventMobileScale)
      document.removeEventListener('touchmove', preventMultiTouchMove)
      document.removeEventListener('wheel', preventMobileWheelZoom)
      delete root.dataset.mobileViewportLocked
    }
  }, [])
}

function useIsMobileViewport() {
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.matchMedia('(max-width: 760px)').matches
  })

  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)')
    const update = () => setIsMobile(media.matches)

    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  return isMobile
}

function useAppRoutePath() {
  const [route, setRoute] = useState(() => currentAppPathname())

  useEffect(() => {
    const syncRoute = () => setRoute(currentAppPathname())
    return listenToAppNavigation(syncRoute)
  }, [])

  return route
}

function isPhoneConfigPlaceholder(value?: string) {
  const text = String(value || '').trim()
  return (
    !text ||
    /your\s+(phone|telnyx)\s+number/i.test(text) ||
    /^phone connection id$/i.test(text) ||
    /^telnyx connection id$/i.test(text) ||
    /^telnyx call control connection_id$/i.test(text)
  )
}

function profilePhoneConfigValue(value: string | undefined, fallback: string | undefined) {
  return isPhoneConfigPlaceholder(value) ? fallback || value || '' : value || ''
}

function profileToCallConfig(
  profile: AgentConfigProfile,
  fallback: CampaignConfig,
): CampaignConfig {
  return {
    ...fallback,
    ...profile.config,
    agentProfileId: profile.id,
    agentProfileName: profile.name,
    telnyxCallerId: profilePhoneConfigValue(profile.config.telnyxCallerId, fallback.telnyxCallerId),
    telnyxConnectionId:
      profilePhoneConfigValue(profile.config.telnyxConnectionId, fallback.telnyxConnectionId),
  }
}

function DialerApp() {
  const basePath = apiBase().replace(/\/api$/, '')
  const autoDialTimerRef = useRef<number | null>(null)
  const autoEndingOutcomeRef = useRef('')
  const autoAdvanceKeyRef = useRef('')
  const activeCallRef = useRef<ActiveCall | null>(null)
  const campaignQueueIdsRef = useRef<string[]>([])
  const campaignRunningRef = useRef(false)
  const dialerClientIdRef = useRef(getDialerClientId())
  const resumeAttemptKeyRef = useRef('')
  const scheduledQueueTimerRef = useRef<number | null>(null)
  const scheduleNextCampaignCallRef = useRef<
    ((afterLeadId: string, outcome: CallOutcome) => void) | null
  >(null)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [stateFilter, setStateFilter] = useState('all')
  const [scoreFilter, setScoreFilter] = useState<ScoreFilter>('all')
  const [activeSmartViewId, setActiveSmartViewId] = useState('')
  const [dialerSourceId, setDialerSourceId] = useState('')
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false)
  const [mobileTranscriptOpen, setMobileTranscriptOpen] = useState(false)
  const [mobileTranscriptFullscreen, setMobileTranscriptFullscreen] = useState(false)
  const [sortField] = useState<SortField>('score')
  const [sortDirection] = useState<'asc' | 'desc'>('desc')
  const [campaignConfig, setCampaignConfig] = useState<CampaignConfig>(
    () => resolveCallConfig(defaultCampaignConfig),
  )
  const [agentProfiles, setAgentProfiles] = useState<AgentConfigProfile[]>(
    () => loadAgentProfiles(),
  )
  const [activeAgentProfileId, setActiveAgentProfileId] =
    useState(loadActiveAgentProfileId)
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null)
  const [controlBusy, setControlBusy] = useState<ControlBusy>('idle')
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([
    makeTranscriptEntry({
      speaker: 'System',
      text: 'Workspace initialized.',
      tone: 'system',
    }),
  ])
  const [campaignRunning, setCampaignRunning] = useState(false)
  const [callToolsDuty, setCallToolsDuty] = useState<DialerCallToolsDuty>()
  const [campaignQueueIds, setCampaignQueueIds] = useState<string[]>([])
  const [scheduledStartAt, setScheduledStartAt] = useState('')
  const [scheduledQueueActive, setScheduledQueueActive] = useState(false)
  const [dialerStateHydrated, setDialerStateHydrated] = useState(false)
  const [agentProfilesHydrated, setAgentProfilesHydrated] = useState(false)
  const [remoteDialerController, setRemoteDialerController] = useState({
    heartbeatAt: '',
    id: '',
  })
  const [campaignStatus, setCampaignStatus] = useState('Queue idle')
  const [notice, setNotice] = useState('Checking voice backend...')
  const voiceBackend = useVoiceBackendStatus({
    setCampaignConfig,
    setNotice,
  })
  const {
    bulkDelete,
    bulkStatus,
    clearSelectedLeads,
    leads,
    leadsRef,
    selectedIds,
    selectedLeadId,
    setLeadsState,
    setSelectedLeadId,
    setSelectedLeadIds,
    smartViews,
    toggleAllVisible,
    toggleRow,
    updateLead,
  } = useLeadWorkspace({
    activeCall,
    activeCallRef,
    campaignQueueIdsRef,
    setActiveCall,
    setCampaignQueueIds,
    setNotice,
  })

  useEffect(() => {
    let mounted = true

    async function hydrateDialerState() {
      try {
        const response = await fetch(apiUrl('/dialer-state'))
        const payload = (await response.json().catch(() => ({}))) as {
          dialerState?: Partial<DialerWorkspaceState>
          error?: string
        }
        if (!response.ok) throw new Error(payload.error || 'Dialer state failed')
        if (!mounted) return

        const state = payload.dialerState || {}
        const rawSourceId = state.sourceId === 'all' ? '' : state.sourceId || ''
        const sourceId = rawSourceId.startsWith('smart:') ? '' : rawSourceId
        const smartViewId =
          sourceId && state.activeSmartViewId
            ? state.activeSmartViewId
            : ''
        const queueIds = Array.isArray(state.campaignQueueIds)
          ? state.campaignQueueIds
          : []
        const calltoolsSource = /^source:calltools(?:$|::)/.test(sourceId)
        const running =
          calltoolsSource && state.calltoolsDuty
            ? callToolsDutyIsActive(state.calltoolsDuty)
            : Boolean(state.campaignRunning)

        setDialerSourceId(sourceId)
        setActiveSmartViewId(smartViewId)
        setQuery(state.query || '')
        setStatusFilter((state.statusFilter as StatusFilter) || 'all')
        setStateFilter(state.stateFilter || 'all')
        setScoreFilter((state.scoreFilter as ScoreFilter) || 'all')
        setSelectedLeadId(state.selectedLeadId || null)
        setSelectedLeadIds(Array.isArray(state.selectedLeadIds) ? state.selectedLeadIds : [])
        setCampaignQueueIds(queueIds)
        campaignQueueIdsRef.current = queueIds
        setCampaignRunning(running)
        campaignRunningRef.current = running
        setCallToolsDuty(state.calltoolsDuty)
        setScheduledStartAt(state.scheduledStartAt || '')
        setScheduledQueueActive(Boolean(state.scheduledQueueActive))
        setRemoteDialerController({
          heartbeatAt: state.controllerHeartbeatAt || '',
          id: state.controllerId || '',
        })
        if (calltoolsSource && state.calltoolsDuty?.message) {
          setNotice(state.calltoolsDuty.message)
        }
      } catch (error) {
        if (mounted) {
          setNotice(error instanceof Error ? error.message : 'Dialer state failed')
        }
      } finally {
        if (mounted) setDialerStateHydrated(true)
      }
    }

    void hydrateDialerState()

    return () => {
      mounted = false
    }
  }, [campaignQueueIdsRef, campaignRunningRef, setNotice, setSelectedLeadId, setSelectedLeadIds])

  const persistDialerState = useCallback(async (
    patch: Partial<DialerWorkspaceState> = {},
  ) => {
    const running = patch.campaignRunning ?? campaignRunning
    const controllerId = running ? dialerClientIdRef.current : ''
    const controllerHeartbeatAt = running ? new Date().toISOString() : ''
    const dialerState: DialerWorkspaceState = {
      sourceId: dialerSourceId,
      activeSmartViewId,
      query,
      statusFilter,
      stateFilter,
      scoreFilter,
      selectedLeadId: selectedLeadId || '',
      selectedLeadIds: Array.from(selectedIds),
      campaignQueueIds,
      campaignRunning,
      scheduledStartAt,
      scheduledQueueActive,
      controllerId,
      controllerHeartbeatAt,
      ...patch,
    }

    try {
      const response = await fetch(apiUrl('/dialer-state'), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dialerState }),
      })
      const payload = (await response.json().catch(() => ({}))) as {
        dialerState?: Partial<DialerWorkspaceState>
        error?: string
      }
      if (!response.ok) throw new Error(payload.error || 'Dialer state sync failed')
      const persisted = payload.dialerState || {}
      setRemoteDialerController({
        heartbeatAt: persisted.controllerHeartbeatAt || controllerHeartbeatAt,
        id: persisted.controllerId || controllerId,
      })
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Dialer state sync failed')
    }
  }, [
    activeSmartViewId,
    campaignQueueIds,
    campaignRunning,
    dialerSourceId,
    query,
    scheduledQueueActive,
    scheduledStartAt,
    scoreFilter,
    selectedIds,
    selectedLeadId,
    setNotice,
    stateFilter,
    statusFilter,
  ])

  useEffect(() => {
    if (!dialerStateHydrated) return undefined
    const timeout = window.setTimeout(() => {
      void persistDialerState()
    }, 350)
    return () => window.clearTimeout(timeout)
  }, [dialerStateHydrated, persistDialerState])

  useEffect(() => {
    if (!dialerStateHydrated || !campaignRunning) return undefined
    const interval = window.setInterval(() => {
      void persistDialerState({
        controllerHeartbeatAt: new Date().toISOString(),
        controllerId: dialerClientIdRef.current,
      })
    }, 5_000)
    return () => window.clearInterval(interval)
  }, [campaignRunning, dialerStateHydrated, persistDialerState])

  const handleRecentCallsRefreshed = useRecentCallRecovery({
    activeCallRef,
    autoAdvanceKeyRef,
    autoDialTimerRef,
    campaignRunningRef,
    leadsRef,
    scheduleNextCampaignCall: (afterLeadId, outcome) =>
      scheduleNextCampaignCallRef.current?.(afterLeadId, outcome),
    setActiveCall,
    setLeadsState,
    setNotice,
  })
  const {
    communicationThreads,
    recentCalls,
    recentCallsLoaded,
    refreshRecentCalls,
  } = useRecentCalls({
    onCallsRefreshed: handleRecentCallsRefreshed,
  })
  const { appearance, setAppearance } = useAppearance()
  const voiceReady = voiceBackend.ok && voiceBackend.configured
  const leasedAgentProfileId = callToolsDutyIsActive(callToolsDuty)
    ? callToolsDuty?.profileId || ''
    : ''
  const effectiveActiveAgentProfileId = resolveDialerAgentProfileId(
    callToolsDuty,
    activeAgentProfileId,
  )
  const effectiveActiveAgentProfile = agentProfiles.find(
    (profile) => profile.id === effectiveActiveAgentProfileId,
  )
  const callToolsReadinessProfileId =
    agentProfilesHydrated && effectiveActiveAgentProfile
      ? effectiveActiveAgentProfile.id
      : ''
  const activeAgentName =
    effectiveActiveAgentProfile?.name ||
    campaignConfig.agentProfileName ||
    'Active agent'
  const activeCallControlId = activeCall?.callControlId
  const controlsLocked = controlBusy !== 'idle'
  const activeSmartView = useMemo(
    () => smartViews.find((smartView) => smartView.id === activeSmartViewId) || null,
    [activeSmartViewId, smartViews],
  )
  const activeSmartViewLeadIds = useMemo(
    () => (activeSmartView ? new Set(activeSmartView.leadIds) : undefined),
    [activeSmartView],
  )
  const contactSources = useMemo<DialerContactSourceOption[]>(() => {
    return buildContactSourceOptionsFromLeads(leads).map((source) => ({
      id: dialerSourceIdFromContactSourceKey(source.key),
      label: source.label,
    }))
  }, [leads])
  const activeContactSourceKey = contactSourceKeyFromDialerSourceId(dialerSourceId)
  const calltoolsFollowMode = isContactSourceKeyForSource(
    activeContactSourceKey,
    'calltools',
  )
  const calltoolsCampaignId = String(
    campaignConfig.calltoolsAgentBinding?.campaignId || '',
  )
  const mirroredCallToolsCalls = useMemo(() => {
    if (!calltoolsFollowMode) return recentCalls
    return recentCalls.filter((call) => {
      if (call.provider !== 'calltools') return false
      const callCampaignId = String(
        call.providerIds?.calltoolsCampaignId || '',
      )
      if (!callCampaignId) return isLiveRecentCall(call)
      return !calltoolsCampaignId || callCampaignId === calltoolsCampaignId
    })
  }, [calltoolsCampaignId, calltoolsFollowMode, recentCalls])
  useEffect(() => {
    if (
      !dialerStateHydrated ||
      !agentProfilesHydrated ||
      !calltoolsFollowMode ||
      !callToolsReadinessProfileId
    ) {
      return undefined
    }

    let cancelled = false

    async function syncCallToolsAvailabilityProof() {
      try {
        const params = new URLSearchParams()
        params.set('profileId', callToolsReadinessProfileId)
        const response = await fetch(
          apiUrl(`/calltools/readiness${params.toString() ? `?${params.toString()}` : ''}`),
        )
        const readiness = (await response.json().catch(() => ({}))) as {
          campaignReady?: boolean
          runtimeReady?: boolean
          liveCallAttached?: boolean
          blockers?: string[]
          dutyMonitor?: DialerCallToolsDuty
          error?: string
        }
        if (!response.ok) throw new Error(readiness.error || 'CallTools availability sync failed')
        if (cancelled) return

        setCallToolsDuty(readiness.dutyMonitor)
        const monitorStatus = readiness.dutyMonitor?.status || 'off'
        const leaseActive = callToolsDutyIsActive(readiness.dutyMonitor)
        campaignRunningRef.current = leaseActive
        setCampaignRunning(leaseActive)

        if (monitorStatus === 'disarming' && leaseActive) {
          setCampaignStatus('Making the Speak agent Unavailable in CallTools')
          setNotice(
            readiness.dutyMonitor?.message ||
              'Speak is retaining the assigned agent until CallTools confirms Unavailable.',
          )
          return
        }

        if (leaseActive) {
          if (readiness.liveCallAttached && readiness.campaignReady) {
            setCampaignStatus('Following active CallTools call')
            setNotice('Following the active CallTools campaign call.')
          } else if (readiness.runtimeReady && readiness.campaignReady) {
            setCampaignStatus('Available for CallTools campaign calls')
            setNotice('CallTools campaign and Speak agent are running and waiting for a human answer.')
          } else {
            setCampaignStatus('Available — reconnecting CallTools')
            setNotice(
              readiness.dutyMonitor?.message ||
              readiness.blockers?.slice(0, 3).join(', ') ||
                'Speak is retaining Available while it restores the CallTools connection.',
            )
          }
          return
        }

        if (monitorStatus === 'arming') {
          setCampaignStatus('Making the agent Available in CallTools')
        } else if (monitorStatus === 'disarming') {
          setCampaignStatus('Making the Speak agent Unavailable in CallTools')
        } else if (monitorStatus === 'attention') {
          setCampaignStatus('CallTools availability needs verification')
          setNotice(
            readiness.dutyMonitor?.message ||
              readiness.blockers?.slice(0, 3).join(', ') ||
              'CallTools availability could not be verified.',
          )
        } else {
          setCampaignStatus('Unavailable for CallTools campaign calls')
          if (readiness.campaignReady) {
            setNotice('CallTools is Available outside Speak. Select Go available to assign Speak.')
          }
          setRemoteDialerController({ heartbeatAt: '', id: '' })
        }
      } catch (error) {
        if (!cancelled) {
          setNotice(error instanceof Error ? error.message : 'CallTools availability sync failed')
        }
      }
    }

    void syncCallToolsAvailabilityProof()
    const interval = window.setInterval(() => {
      void syncCallToolsAvailabilityProof()
    }, 5_000)

    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [
    agentProfilesHydrated,
    callToolsReadinessProfileId,
    calltoolsFollowMode,
    dialerStateHydrated,
  ])
  const {
    audioPlaybackStateFor,
    loadingAudioCallId,
    playingAudioCallId,
    toggleCallAudioPlayback,
  } = useCallAudioPlayback({
    refreshRecentCalls,
    setNotice,
  })
  const deleteDialerCallAttempts = useCallback(
    async (ids: string[]) => {
      const callControlIds = Array.from(new Set(ids.filter(Boolean)))
      if (callControlIds.length === 0) return
      try {
        const response = await fetch(apiUrl('/calls/delete'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: callControlIds }),
        })
        const payload = (await response.json().catch(() => ({}))) as {
          deleted?: string[]
          activeIds?: string[]
          error?: string
        }
        if (!response.ok) {
          throw new Error(payload.error || 'Call delete failed')
        }
        const deleted = payload.deleted || callControlIds
        setNotice(`${deleted.length} call${deleted.length === 1 ? '' : 's'} deleted`)
        await refreshRecentCalls()
      } catch (error) {
        setNotice(error instanceof Error ? error.message : 'Call delete failed')
        throw error
      }
    },
    [refreshRecentCalls],
  )
  const {
    activeCallIsLive,
    activeHistoryCall,
    activeLead,
    agentNameByLeadId,
    calltimeByLeadId,
    displayedBusinessName,
    displayedPhase,
    displayedTranscript,
    filteredLeads,
    lastCallByLeadId,
    liveInstructionTarget,
    liveTranscriptBelongsToSelectedLead,
    selectedLeadCalls,
    transcriptLead,
  } = useDialerReadModel({
    leads,
    activeAgentName,
    activeCall,
    activeSmartViewId,
    campaignQueueIds,
    query,
    recentCalls: mirroredCallToolsCalls,
    scoreFilter,
    selectedIds,
    selectedLeadId,
    sortDirection,
    sortField,
    sourceKey: activeContactSourceKey,
    smartViewLeadIds: activeSmartViewLeadIds,
    stateFilter,
    statusFilter,
    transcript,
  })
  const dialerFilteredLeads = !dialerSourceId
    ? []
    : calltoolsFollowMode
      ? filteredLeads.filter((lead) =>
          mirroredCallToolsCalls.some((call) => callMatchesLead(call, lead)),
        )
      : filteredLeads
  const dialerQueueSourceLeads =
    selectedIds.size > 0
      ? dialerFilteredLeads.filter((lead) => selectedIds.has(lead.id))
      : dialerFilteredLeads
  const dialerReadyCount = dialerQueueSourceLeads.filter(isCampaignDialable).length
  const deviceCallLead =
    leads.find((lead) => lead.id === selectedLeadId) ||
    dialerFilteredLeads.find((lead) => lead.id === selectedLeadId) ||
    dialerQueueSourceLeads[0] ||
    null
  const {
    markQueuedInstructionsAttached,
    queuedInstructionTexts,
  } = useLiveInstructions({
    liveInstructionTarget,
    setNotice,
  })
  const {
    bargeIn,
    stopHumanAudioStream,
  } = useHumanTakeover({
    activeCall,
    activeCallRef,
    activeLead,
    controlsLocked,
    sampleRate: campaignConfig.sampleRate,
    setActiveCall,
    setBusy: setControlBusy,
    setNotice,
    updateLead,
  })
  useActiveCallTranscript(activeCallControlId, setTranscript)
  useActiveCallEvents({
    activeCallControlId,
    activeCallRef,
    setActiveCall,
    setNotice,
    setTranscript,
    updateLead,
  })

  const applyAgentProfileToCallConfig = useCallback((profile: AgentConfigProfile) => {
    setCampaignConfig((current) => profileToCallConfig(profile, current))
  }, [])

  useEffect(() => {
    if (!leasedAgentProfileId) return undefined
    const timeout = window.setTimeout(() => {
      const leasedProfile = agentProfiles.find(
        (profile) => profile.id === leasedAgentProfileId,
      )
      if (!leasedProfile) {
        setNotice(
          'The Available CallTools lease references an agent profile that is no longer available.',
        )
        return
      }

      setActiveAgentProfileId(leasedProfile.id)
      saveActiveAgentProfileId(leasedProfile.id)
      applyAgentProfileToCallConfig(leasedProfile)
    })
    return () => window.clearTimeout(timeout)
  }, [
    agentProfiles,
    applyAgentProfileToCallConfig,
    leasedAgentProfileId,
    setNotice,
  ])

  const refreshActiveAgentCallConfig = useCallback(async () => {
    const response = await fetch(apiUrl('/profiles'))
    const payload = (await response.json().catch(() => ({}))) as {
      activeProfileId?: string
      error?: string
      profiles?: AgentConfigProfile[]
    }
    if (!response.ok) throw new Error(payload.error || 'Profile workspace failed')

    const nextProfiles = (payload.profiles || []).map((profile) =>
      normalizeAgentProfile(profile),
    )
    const preferredActiveId =
      effectiveActiveAgentProfileId || activeAgentProfileId
    const nextActiveId =
      (preferredActiveId &&
      nextProfiles.some((profile) => profile.id === preferredActiveId)
        ? preferredActiveId
        : '') ||
      payload.activeProfileId ||
      nextProfiles[0]?.id ||
      ''
    setAgentProfiles(nextProfiles)
    setActiveAgentProfileId(nextActiveId)
    saveAgentProfiles(nextProfiles)
    if (nextActiveId) {
      saveActiveAgentProfileId(nextActiveId)
    } else {
      clearActiveAgentProfileId()
    }

    const profile = nextProfiles.find((item) => item.id === nextActiveId)
    if (!profile) throw new Error('No active agent profile is available.')
    const nextConfig = profileToCallConfig(profile, campaignConfig)
    setCampaignConfig(nextConfig)
    return nextConfig
  }, [activeAgentProfileId, campaignConfig, effectiveActiveAgentProfileId])

  function resetOrFocusFilters() {
    const hasFilters =
      query !== '' ||
      dialerSourceId !== '' ||
      activeSmartViewId !== '' ||
      statusFilter !== 'all' ||
      stateFilter !== 'all' ||
      scoreFilter !== 'all'

    if (hasFilters) {
      setQuery('')
      setActiveSmartViewId('')
      setDialerSourceId('')
      setStatusFilter('all')
      setStateFilter('all')
      setScoreFilter('all')
      setNotice('Contact filters cleared')
      return
    }

    setNotice('Contact filters already clear')
  }

  const {
    endCall,
    skipToNext,
    startCampaign,
    stopCampaign,
  } = useDialerCallController({
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
    contactSourceKey: activeContactSourceKey,
    filteredLeads: dialerFilteredLeads,
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
  })

  const visibleSelectedCount = dialerFilteredLeads.filter((lead) =>
    selectedIds.has(lead.id),
  ).length
  const viewIsFiltered =
    dialerSourceId !== '' ||
    query.trim() !== '' ||
    activeSmartViewId !== '' ||
    statusFilter !== 'all' ||
    stateFilter !== 'all' ||
    scoreFilter !== 'all'
  const leadEmptyStateText =
    !dialerSourceId
      ? ''
      : calltoolsFollowMode && mirroredCallToolsCalls.length === 0
        ? 'Waiting for CallTools campaign calls.'
      : leads.length === 0
      ? 'Import a CSV or add a contact.'
      : viewIsFiltered
        ? 'No contacts match this view.'
        : 'No contacts in this queue.'
  const allVisibleSelected =
    dialerFilteredLeads.length > 0 && visibleSelectedCount === dialerFilteredLeads.length
  const liveControlReady = Boolean(
    activeCall &&
      activeCallIsLive &&
      activeCall.chatId &&
      activeCall.streamId,
  )
  const callToolsDisarming =
    calltoolsFollowMode && callToolsDuty?.status === 'disarming'
  const controlStatusText =
    callToolsDisarming
      ? 'Making the Speak agent Unavailable in CallTools...'
      : controlBusy === 'start'
      ? calltoolsFollowMode
        ? 'Making the agent Available in CallTools...'
        : 'Starting outbound call...'
      : controlBusy === 'next'
        ? 'Skipping and moving to the next ready contact...'
        : controlBusy === 'end'
          ? 'Ending call through phone provider...'
          : controlBusy === 'takeover'
            ? 'Connecting your microphone...'
            : controlBusy === 'release'
              ? 'Releasing takeover...'
              : notice || campaignStatus

  function openTranscriptForLead(leadId: string) {
    setSelectedLeadId(leadId)
    setMobileTranscriptOpen(true)
    setMobileTranscriptFullscreen(false)
  }

  function selectLeadFromSearch(leadId: string) {
    setSelectedLeadId(leadId)
    setMobileTranscriptOpen(false)
    setMobileTranscriptFullscreen(false)
  }

  useEffect(() => {
    function selectLeadFromHash() {
      const params = new URLSearchParams(window.location.hash.slice(1))
      const leadId = params.get('lead')
      if (!leadId || !leads.some((lead) => lead.id === leadId)) return
      setSelectedLeadId(leadId)
    }

    selectLeadFromHash()
    window.addEventListener('hashchange', selectLeadFromHash)
    return () => window.removeEventListener('hashchange', selectLeadFromHash)
  }, [leads, setSelectedLeadId])

  function closeMobileTranscript() {
    setMobileTranscriptOpen(false)
    setMobileTranscriptFullscreen(false)
  }

  function dialerSourceLabel(sourceId = dialerSourceId) {
    const sourceKey = contactSourceKeyFromDialerSourceId(sourceId)
    if (sourceKey) {
      return (
        contactSources.find((source) => source.id === sourceId)?.label ||
        contactSourceLabel(sourceKey.split('::')[0] || '') ||
        'Contact source'
      )
    }
    return 'Contact list'
  }

  function selectDialerSource(nextSourceId: string) {
    if (activeCallIsLive || campaignRunning || controlsLocked) {
      setNotice('Stop the active queue before changing contact lists.')
      return
    }

    const sourceId = nextSourceId === 'all' ? '' : nextSourceId
    setDialerSourceId(sourceId)
    setActiveSmartViewId('')
    setQuery('')
    setStatusFilter('all')
    setStateFilter('all')
    setScoreFilter('all')
    setSelectedLeadId(null)
    clearSelectedLeads()
    setNotice(sourceId ? `${dialerSourceLabel(sourceId)} selected` : 'Dialer list cleared')
  }

  function selectDialerSmartView(smartViewId: string) {
    if (activeCallIsLive || campaignRunning || controlsLocked) {
      setNotice('Stop the active queue before changing Smart Views.')
      return
    }

    setActiveSmartViewId(smartViewId)
    setSelectedLeadId(null)
    clearSelectedLeads()
    const smartViewName =
      smartViews.find((smartView) => smartView.id === smartViewId)?.name || 'All contacts'
    setNotice(smartViewId ? `${smartViewName} selected` : 'All contacts in source selected')
  }

  async function selectDialerAgent(profileId: string) {
    if (activeCallIsLive || campaignRunning || controlsLocked) {
      setNotice('Stop the active queue before switching agents.')
      return
    }

    const profile = agentProfiles.find((item) => item.id === profileId)
    if (!profile) {
      setNotice('Agent profile is unavailable.')
      return
    }

    setActiveAgentProfileId(profile.id)
    saveActiveAgentProfileId(profile.id)
    applyAgentProfileToCallConfig(profile)
    setNotice(`${profile.name} selected.`)

    try {
      const response = await fetch(apiUrl('/profiles/active'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: profile.id }),
      })
      const payload = (await response.json().catch(() => ({}))) as {
        activeProfileId?: string
        error?: string
        profiles?: AgentConfigProfile[]
      }
      if (!response.ok) throw new Error(payload.error || 'Active profile sync failed')
      const nextProfiles = (payload.profiles || agentProfiles).map((item) =>
        normalizeAgentProfile(item),
      )
      const nextActiveId = payload.activeProfileId || profile.id
      setAgentProfiles(nextProfiles)
      setActiveAgentProfileId(nextActiveId)
      saveAgentProfiles(nextProfiles)
      saveActiveAgentProfileId(nextActiveId)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Active profile sync failed')
    }
  }

  function cancelScheduledQueue() {
    if (scheduledQueueTimerRef.current) {
      window.clearTimeout(scheduledQueueTimerRef.current)
      scheduledQueueTimerRef.current = null
    }
    setScheduledQueueActive(false)
    setNotice('Scheduled queue start canceled.')
  }

  function runDialerQueue() {
    if (scheduledQueueActive) {
      cancelScheduledQueue()
      return
    }

    const scheduledMs = scheduledStartAt ? Date.parse(scheduledStartAt) : 0
    const delayMs = scheduledMs - Date.now()
    if (scheduledMs && delayMs > 1000) {
      if (scheduledQueueTimerRef.current) {
        window.clearTimeout(scheduledQueueTimerRef.current)
      }
      scheduledQueueTimerRef.current = window.setTimeout(() => {
        scheduledQueueTimerRef.current = null
        setScheduledQueueActive(false)
        void startCampaign()
      }, delayMs)
      setScheduledQueueActive(true)
      setNotice(`Queue scheduled for ${formatOperationalDateTime(scheduledMs, {
        month: 'numeric',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
      })}.`)
      return
    }

    void startCampaign()
  }

  useEffect(() => {
    if (
      !dialerStateHydrated ||
      !scheduledQueueActive ||
      !scheduledStartAt ||
      campaignRunning
    ) {
      return undefined
    }

    if (scheduledQueueTimerRef.current) {
      window.clearTimeout(scheduledQueueTimerRef.current)
      scheduledQueueTimerRef.current = null
    }

    const scheduledMs = Date.parse(scheduledStartAt)
    const delayMs = scheduledMs - Date.now()
    if (!scheduledMs || delayMs <= 1000) {
      const timeout = window.setTimeout(() => {
        setScheduledQueueActive(false)
        void startCampaign()
      }, 0)
      return () => window.clearTimeout(timeout)
    }

    scheduledQueueTimerRef.current = window.setTimeout(() => {
      scheduledQueueTimerRef.current = null
      setScheduledQueueActive(false)
      void startCampaign()
    }, delayMs)

    return () => {
      if (scheduledQueueTimerRef.current) {
        window.clearTimeout(scheduledQueueTimerRef.current)
        scheduledQueueTimerRef.current = null
      }
    }
  }, [
    campaignRunning,
    dialerStateHydrated,
    scheduledQueueActive,
    scheduledStartAt,
    startCampaign,
  ])

  useEffect(() => {
    if (
      !dialerStateHydrated ||
      (!campaignRunning && !calltoolsFollowMode) ||
      (activeCall && isActiveCallLive(activeCall))
    ) return undefined
    const liveCall = (calltoolsFollowMode ? mirroredCallToolsCalls : recentCalls).find((call) => {
      if (!isLiveRecentCall(call) || !call.callControlId || !call.lead?.id) return false
      if (activeCall && call.callControlId === activeCall.callControlId) return false
      if (calltoolsFollowMode) return true
      return campaignQueueIds.length === 0 || campaignQueueIds.includes(call.lead.id)
    })
    if (!liveCall?.lead?.id) return undefined

    const restoredCall: ActiveCall = {
      leadId: liveCall.lead.id,
      callControlId: liveCall.callControlId,
      chatId: liveCall.chatId,
      phase: recentCallPhase(liveCall.phase),
      startedAt: Date.parse(liveCall.createdAt || liveCall.updatedAt || '') || Date.now(),
      takeover: false,
      outcome: liveCall.outcome || undefined,
    }
    const timeout = window.setTimeout(() => {
      activeCallRef.current = restoredCall
      setActiveCall(restoredCall)
      setSelectedLeadId(liveCall.lead?.id || restoredCall.leadId)
      setNotice('Recovered live call state from backend history.')
    }, 0)

    return () => window.clearTimeout(timeout)
  }, [
    activeCall,
    campaignQueueIds,
    campaignRunning,
    calltoolsFollowMode,
    dialerStateHydrated,
    mirroredCallToolsCalls,
    recentCalls,
    setActiveCall,
    setNotice,
    setSelectedLeadId,
  ])

  useEffect(() => {
    if (
      !dialerStateHydrated ||
      !campaignRunning ||
      activeCall ||
      !recentCallsLoaded ||
      controlBusy !== 'idle' ||
      !dialerSourceId ||
      campaignQueueIds.length === 0 ||
      document.visibilityState === 'hidden'
    ) {
      return undefined
    }

    if (recentCalls.some(isLiveRecentCall)) return undefined

    const heartbeatMs = Date.parse(remoteDialerController.heartbeatAt || '')
    const otherControllerFresh =
      remoteDialerController.id &&
      remoteDialerController.id !== dialerClientIdRef.current &&
      heartbeatMs &&
      Date.now() - heartbeatMs < staleDialerControllerMs
    if (otherControllerFresh) return undefined

    const latestCallStamp = recentCalls[0]?.updatedAt || recentCalls[0]?.createdAt || ''
    const resumeKey = `${campaignQueueIds.join(',')}:${latestCallStamp}`
    if (resumeAttemptKeyRef.current === resumeKey) return undefined
    resumeAttemptKeyRef.current = resumeKey

    const timeout = window.setTimeout(() => {
      if (document.visibilityState === 'hidden') return
      void skipToNext()
    }, 900)

    return () => window.clearTimeout(timeout)
  }, [
    activeCall,
    campaignQueueIds,
    campaignRunning,
    controlBusy,
    dialerSourceId,
    dialerStateHydrated,
    recentCalls,
    recentCallsLoaded,
    remoteDialerController,
    skipToNext,
  ])

  useEffect(() => {
    return () => {
      if (scheduledQueueTimerRef.current) {
        window.clearTimeout(scheduledQueueTimerRef.current)
        scheduledQueueTimerRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    let mounted = true

    async function hydrateAgentProfiles() {
      try {
        const response = await fetch(apiUrl('/profiles'))
        const payload = (await response.json().catch(() => ({}))) as {
          activeProfileId?: string
          error?: string
          profiles?: AgentConfigProfile[]
        }
        if (!response.ok) throw new Error(payload.error || 'Profile workspace failed')
        if (!mounted) return
        const nextProfiles = (payload.profiles || []).map((profile) =>
          normalizeAgentProfile(profile),
        )
        const nextActiveId =
          payload.activeProfileId ||
          nextProfiles[0]?.id ||
          ''
        setAgentProfiles(nextProfiles)
        setActiveAgentProfileId(nextActiveId)
        saveAgentProfiles(nextProfiles)
        if (nextActiveId) {
          saveActiveAgentProfileId(nextActiveId)
        } else {
          clearActiveAgentProfileId()
        }
        const profile = nextProfiles.find((item) => item.id === nextActiveId)
        if (profile) applyAgentProfileToCallConfig(profile)
        setAgentProfilesHydrated(true)
      } catch (error) {
        setNotice(error instanceof Error ? error.message : 'Profile workspace failed')
      }
    }

    void hydrateAgentProfiles()
    return () => {
      mounted = false
    }
  }, [applyAgentProfileToCallConfig])

  function renderDialerCallControls() {
    return (
      <div className="call-control-group dialer-call-control-group">
        <DeviceCallButton
          lead={deviceCallLead}
          disabled={!deviceCallLead || !isValidPhoneNumber(deviceCallLead.phone)}
        />
        <DialerRunButton
          activeCallIsLive={activeCallIsLive}
          callToolsDisarming={callToolsDisarming}
          campaignRunning={campaignRunning}
          campaignScheduled={scheduledQueueActive}
          controlBusy={controlBusy}
          controlsLocked={controlsLocked}
          dialerSourceId={dialerSourceId}
          readyCount={dialerReadyCount}
          voiceReady={voiceReady}
          onCancelSchedule={cancelScheduledQueue}
          onEndCall={() => void endCall()}
          onRunQueue={runDialerQueue}
          onStopQueue={stopCampaign}
        />
      </div>
    )
  }

  return (
    <div className="app-shell" data-route-id={speakRouteIds.dialer}>
      <main
        className="workspace"
        data-route-id={speakRouteIds.dialer}
        data-testid={speakTestIds.routeDialer}
      >
        <DialerTopbar
          basePath={basePath}
          leadControls={
            <LeadQueueToolbar
              appearance={appearance}
              callControl={renderDialerCallControls()}
              onOpenGlobalSearch={() => setGlobalSearchOpen(true)}
              runControls={
                <DialerRunControls
                  activeAgentProfileId={
                    effectiveActiveAgentProfileId || agentProfiles[0]?.id || ''
                  }
                  activeCallIsLive={activeCallIsLive}
                  activeSmartViewId={activeSmartViewId}
                  campaignRunning={campaignRunning}
                  controlsLocked={controlsLocked}
                  contactSources={contactSources}
                  dialerSourceId={dialerSourceId}
                  profiles={agentProfiles}
                  readyCount={dialerReadyCount}
                  scheduledStartAt={scheduledStartAt}
                  smartViews={smartViews}
                  onScheduleChange={setScheduledStartAt}
                  onSelectAgent={selectDialerAgent}
                  onSelectSource={selectDialerSource}
                  onSelectSmartView={selectDialerSmartView}
                />
              }
              selectionControls={
                selectedIds.size > 0 ? (
                  <div className="dialer-topbar-selection-actions">
                    <LeadBulkActionBar
                      allVisibleSelected={allVisibleSelected}
                      bulkDelete={bulkDelete}
                      bulkStatus={bulkStatus}
                      clearSelectedLeads={clearSelectedLeads}
                      selectedCount={selectedIds.size}
                      showIdleCount={false}
                      someVisibleSelected={visibleSelectedCount > 0}
                      toggleAllVisible={() => toggleAllVisible(dialerFilteredLeads)}
                      totalVisibleCount={dialerFilteredLeads.length}
                    />
                  </div>
                ) : null
              }
              setAppearance={setAppearance}
            />
          }
        />

        <div
          className={[
            'operator-grid',
            mobileTranscriptOpen ? 'mobile-transcript-open' : '',
            mobileTranscriptFullscreen ? 'mobile-transcript-fullscreen' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          data-testid={speakTestIds.operatorGrid}
        >
          <LeadQueuePanel
            activeCall={activeCall}
            activeCallIsLive={activeCallIsLive}
            agentNameByLeadId={agentNameByLeadId}
            calltimeByLeadId={calltimeByLeadId}
            emptyStateActionLabel={
              dialerSourceId && viewIsFiltered ? 'Clear View' : undefined
            }
            emptyStateText={leadEmptyStateText}
            filteredLeads={dialerFilteredLeads}
            lastCallByLeadId={lastCallByLeadId}
            onEmptyStateAction={
              dialerSourceId && viewIsFiltered ? resetOrFocusFilters : undefined
            }
            onOpenTranscript={openTranscriptForLead}
            selectedIds={selectedIds}
            setSelectedLeadId={setSelectedLeadId}
            toggleRow={toggleRow}
            transcriptLead={transcriptLead}
            updateLead={updateLead}
          />

          <CallTranscriptConsole
            activeCall={activeCall}
            agentTranscriptLabel={activeAgentName}
            audioPlaybackStateFor={audioPlaybackStateFor}
            communicationThreads={communicationThreads}
            controlStatusText={controlStatusText}
            controlsLocked={controlsLocked}
            displayedBusinessName={displayedBusinessName}
            displayedPhase={displayedPhase || ''}
            displayedTranscript={displayedTranscript}
            filteredLeadCount={dialerFilteredLeads.length}
            liveControlReady={liveControlReady}
            liveTranscriptBelongsToSelectedLead={liveTranscriptBelongsToSelectedLead}
            loadingAudioCallId={loadingAudioCallId}
            mobileTranscriptFullscreen={mobileTranscriptFullscreen}
            mobileTranscriptOpen={mobileTranscriptOpen}
            onBargeIn={bargeIn}
            onCloseMobileTranscript={closeMobileTranscript}
            onDeleteCallAttempts={deleteDialerCallAttempts}
            onEndCall={endCall}
            onSkipToNext={skipToNext}
            onToggleMobileTranscriptFullscreen={() =>
              setMobileTranscriptFullscreen((current) => !current)
            }
            playingAudioCallId={playingAudioCallId}
            runControl={renderDialerCallControls()}
            selectedLeadCalls={selectedLeadCalls}
            endBusy={controlBusy === 'end'}
            skipBusy={controlBusy === 'next'}
            takeoverBusy={controlBusy === 'takeover' || controlBusy === 'release'}
            transcriptLead={transcriptLead}
            toggleCallAudioPlayback={toggleCallAudioPlayback}
            voiceReady={voiceReady}
          />
        </div>
        <GlobalSearchOverlay
          activeRoute="dialer"
          onClose={() => setGlobalSearchOpen(false)}
          onSelectLead={selectLeadFromSearch}
          open={globalSearchOpen}
        />
      </main>
    </div>
  )
}

function RouteLoadingFallback() {
  return (
    <div className="route-loading" role="status" aria-live="polite">
      Loading workspace
    </div>
  )
}

function App() {
  useMobileVisualViewport()
  useMobileNativeViewportGuard()
  const isMobile = useIsMobileViewport()
  const route = useAppRoutePath()

  if (route.endsWith('/library')) {
    return (
      <Suspense fallback={<RouteLoadingFallback />}>
        <LibraryWorkspace />
      </Suspense>
    )
  }
  if (route.endsWith('/configs')) {
    return (
      <Suspense fallback={<RouteLoadingFallback />}>
        <AgentConfigWorkspace />
      </Suspense>
    )
  }
  if (route.endsWith('/dialer')) return <DialerApp />
  if (isMobile && (route === '' || route.endsWith('/speak'))) {
    return (
      <Suspense fallback={<RouteLoadingFallback />}>
        <AgentConfigWorkspace />
      </Suspense>
    )
  }
  return <DialerApp />
}

export default App
