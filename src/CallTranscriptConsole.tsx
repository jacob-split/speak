import {
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from 'react'
import {
  Activity,
  ArrowDown,
  Check,
  Maximize2,
  Minimize2,
  Mic,
  Pause,
  Phone,
  Play,
  SkipForward,
  Trash2,
  X,
} from './SpeakIcons'
import {
  callDuration,
  callMeetsAudioPlaybackStandards,
  formatCallDate,
  formatCallTime,
  isActiveCallLive,
  isLiveRecentCall,
  recentBusinessName,
  recentOutcomeLabel,
} from './calls'
import { ChatMessageBody } from './ChatMessageBody'
import { CommunicationThreadMessages } from './CommunicationThreadMessages'
import { communicationMessagesForRecentCall } from './communicationThreadMessageUtils'
import type { RecentCallSummary } from './calls'
import type {
  ActiveCall,
  Lead,
  TranscriptEntry,
} from './types'
import { TranscriptEmotionScores } from './TranscriptEmotionScores'
import {
  leadTranscriptLabel,
  transcriptSpeakerClass,
  transcriptSpeakerLabel,
} from './transcriptLabels'
import type { AudioPlaybackStatus } from './useCallAudioPlayback'
import type { CommunicationThreadSummary } from './useRecentCalls'
import { useChatScroll } from './useChatScroll'
import { useVisibleScrollSection } from './useVisibleScrollSection'
import { speakActionIds, speakTestIds } from './uiContract'

interface CallTranscriptConsoleProps {
  activeCall: ActiveCall | null
  agentTranscriptLabel: string
  audioPlaybackStateFor: (call: RecentCallSummary) => AudioPlaybackStatus | null
  communicationThreads?: CommunicationThreadSummary[]
  controlStatusText: string
  controlsLocked: boolean
  displayedBusinessName: string
  displayedPhase: string
  displayedTranscript: TranscriptEntry[]
  filteredLeadCount: number
  liveControlReady: boolean
  liveTranscriptBelongsToSelectedLead: boolean
  loadingAudioCallId: string | null
  mobileTranscriptFullscreen?: boolean
  mobileTranscriptOpen?: boolean
  onBargeIn: () => void
  onCloseMobileTranscript?: () => void
  onDeleteCallAttempts?: (callControlIds: string[]) => void | Promise<void>
  onEndCall: () => void | Promise<void>
  onSkipToNext: () => void
  onToggleMobileTranscriptFullscreen?: () => void
  playingAudioCallId: string | null
  runControl?: ReactNode
  selectedLeadCalls: RecentCallSummary[]
  endBusy: boolean
  skipBusy: boolean
  takeoverBusy: boolean
  transcriptLead: Lead | null
  toggleCallAudioPlayback: (call: RecentCallSummary) => void | Promise<void>
  voiceReady: boolean
}

function usePhoneViewport() {
  const [phoneViewport, setPhoneViewport] = useState(() =>
    typeof window === 'undefined'
      ? false
      : window.matchMedia('(max-width: 760px)').matches,
  )

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const query = window.matchMedia('(max-width: 760px)')
    const update = () => setPhoneViewport(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  return phoneViewport
}

function hasCrossSourceHistory(thread?: CommunicationThreadSummary) {
  const channels = new Set(thread?.channels || [])
  if (channels.size === 0) return false
  if (channels.size > 1) return true
  return !channels.has('call')
}

function communicationThreadTime(thread?: CommunicationThreadSummary) {
  return Date.parse(thread?.updatedAt || '') || 0
}

function communicationThreadChannelLabel(thread?: CommunicationThreadSummary) {
  const channels = thread?.channels?.length
    ? thread.channels
    : [thread?.latestChannel || 'source']
  return channels.filter(Boolean).join(' / ')
}

export function CallTranscriptConsole({
  activeCall,
  agentTranscriptLabel,
  audioPlaybackStateFor,
  communicationThreads = [],
  controlStatusText,
  controlsLocked,
  displayedBusinessName,
  displayedPhase,
  displayedTranscript,
  filteredLeadCount,
  liveControlReady,
  liveTranscriptBelongsToSelectedLead,
  loadingAudioCallId,
  mobileTranscriptFullscreen = false,
  mobileTranscriptOpen = false,
  onBargeIn,
  onCloseMobileTranscript,
  onDeleteCallAttempts,
  onEndCall,
  onSkipToNext,
  onToggleMobileTranscriptFullscreen,
  playingAudioCallId,
  runControl,
  selectedLeadCalls,
  endBusy,
  skipBusy,
  takeoverBusy,
  transcriptLead,
  toggleCallAudioPlayback,
  voiceReady,
}: CallTranscriptConsoleProps) {
  const phoneViewport = usePhoneViewport()
  const [deleteCallAttemptsBusy, setDeleteCallAttemptsBusy] = useState(false)
  const transcriptAttemptCount =
    selectedLeadCalls.length + (liveTranscriptBelongsToSelectedLead ? 1 : 0)
  const communicationThreadsByCallId = useMemo(() => {
    const next = new Map<string, CommunicationThreadSummary>()
    communicationThreads.forEach((thread) => {
      thread.providerLinks?.forEach((link) => {
        if (link.kind === 'call_control' && link.id) next.set(link.id, thread)
      })
    })
    return next
  }, [communicationThreads])
  const transcriptLeadId = transcriptLead?.id || ''
  const selectedLeadCommunicationThreads = useMemo(
    () =>
      transcriptLeadId
        ? communicationThreads
            .filter((thread) => thread.contactId === transcriptLeadId)
            .sort(
              (left, right) =>
                communicationThreadTime(right) - communicationThreadTime(left),
            )
        : [],
    [communicationThreads, transcriptLeadId],
  )
  const selectedLeadCallThreadIds = useMemo(
    () =>
      new Set(
        selectedLeadCalls
          .map((call) => communicationThreadsByCallId.get(call.callControlId)?.threadId)
          .filter(Boolean),
      ),
    [communicationThreadsByCallId, selectedLeadCalls],
  )
  const selectedContactSourceThread = useMemo(() => {
    const crossSourceThread = selectedLeadCommunicationThreads.find((thread) =>
      hasCrossSourceHistory(thread),
    )
    return crossSourceThread || selectedLeadCommunicationThreads[0] || null
  }, [selectedLeadCommunicationThreads])
  const showContactSourceHistory = Boolean(
    selectedContactSourceThread &&
      (hasCrossSourceHistory(selectedContactSourceThread) ||
        selectedLeadCalls.length === 0 ||
        !selectedLeadCallThreadIds.has(selectedContactSourceThread.threadId)),
  )
  const selectedLeadThreadCount = useMemo(
    () =>
      selectedLeadCalls.filter((call) =>
        communicationThreadsByCallId.has(call.callControlId),
      ).length,
    [communicationThreadsByCallId, selectedLeadCalls],
  )
  const liveAttemptId = 'live-call'
  const fallbackAttemptId = liveTranscriptBelongsToSelectedLead
    ? liveAttemptId
    : selectedLeadCalls[selectedLeadCalls.length - 1]?.callControlId || null
  const transcriptHeading = transcriptLead
    ? transcriptLead.name
    : 'Calls'
  const transcriptLeadLabel =
    leadTranscriptLabel(transcriptLead) || displayedBusinessName || 'Contact'
  const transcriptSubheading = transcriptLead
    ? [
        transcriptLead.company || displayedBusinessName,
        `${transcriptAttemptCount} call attempts`,
        `${selectedLeadThreadCount} threaded`,
      ]
        .filter(Boolean)
        .join(' / ')
    : filteredLeadCount === 0
      ? 'No contacts in view'
      : 'Select a contact row'
  const playableCalls = useMemo(
    () => selectedLeadCalls.filter(callMeetsAudioPlaybackStandards),
    [selectedLeadCalls],
  )
  const [selectedCallAttemptIds, setSelectedCallAttemptIds] = useState<Set<string>>(
    () => new Set(),
  )
  const liveCallActionsActive = isActiveCallLive(activeCall)
  const liveCallControlId = liveCallActionsActive ? activeCall?.callControlId || '' : ''
  const selectableCallAttempts = useMemo(
    () =>
      selectedLeadCalls.filter(
        (call) => call.callControlId !== liveCallControlId && !isLiveRecentCall(call),
      ),
    [liveCallControlId, selectedLeadCalls],
  )
  const visibleHistoricalCallIdSet = useMemo(
    () => new Set(selectableCallAttempts.map((call) => call.callControlId)),
    [selectableCallAttempts],
  )
  const selectedVisibleCallAttemptIds = useMemo(
    () =>
      new Set(
        [...selectedCallAttemptIds].filter((id) => visibleHistoricalCallIdSet.has(id)),
      ),
    [selectedCallAttemptIds, visibleHistoricalCallIdSet],
  )
  const selectedVisibleCallAttemptIdList = useMemo(
    () =>
      selectableCallAttempts
        .map((call) => call.callControlId)
        .filter((id) => selectedVisibleCallAttemptIds.has(id)),
    [selectableCallAttempts, selectedVisibleCallAttemptIds],
  )
  const allVisibleCallAttemptsSelected =
    selectableCallAttempts.length > 0 &&
    selectedVisibleCallAttemptIds.size === selectableCallAttempts.length
  const someVisibleCallAttemptsSelected =
    selectedVisibleCallAttemptIds.size > 0 && !allVisibleCallAttemptsSelected
  const callAttemptSelectionState = allVisibleCallAttemptsSelected
    ? 'selected'
    : someVisibleCallAttemptsSelected
      ? 'mixed'
      : ''
  const showEndControl = liveCallActionsActive || endBusy
  const showTakeoverControl =
    liveCallActionsActive || Boolean(activeCall?.takeover) || takeoverBusy
  const showDesktopTakeoverControl = showTakeoverControl && !phoneViewport
  const showMobileTakeoverControl = showTakeoverControl && phoneViewport
  const showSkipControl = liveCallActionsActive || skipBusy
  const transcriptScrollRevision = [
    liveTranscriptBelongsToSelectedLead ? displayedTranscript.length : 0,
    selectedLeadCalls.length,
    selectedLeadCalls.map((call) => call.transcript?.length || 0).join(','),
    transcriptLead?.id || '',
  ].join(':')
  const {
    ref: transcriptListRef,
    scrollToLatest,
    showJumpToLatest,
  } = useChatScroll<HTMLDivElement>(transcriptScrollRevision)
  const visibleAttemptIds = useMemo(
    () => [
      ...(liveTranscriptBelongsToSelectedLead ? [liveAttemptId] : []),
      ...selectedLeadCalls.map((call) => call.callControlId),
    ],
    [liveTranscriptBelongsToSelectedLead, selectedLeadCalls],
  )
  const visibleAttemptId = useVisibleScrollSection({
    containerRef: transcriptListRef,
    fallbackId: fallbackAttemptId,
    revision: transcriptScrollRevision,
    sectionIds: visibleAttemptIds,
  })
  const visibleHistoricalCall =
    selectedLeadCalls.find((call) => call.callControlId === visibleAttemptId) ||
    selectedLeadCalls.find((call) => call.callControlId === fallbackAttemptId) ||
    null
  const visibleAttemptStartedAt =
    visibleAttemptId === liveAttemptId && activeCall?.startedAt
      ? new Date(activeCall.startedAt).toISOString()
      : visibleHistoricalCall?.createdAt || visibleHistoricalCall?.updatedAt || ''
  const visibleAttemptTime = visibleAttemptStartedAt
    ? formatCallDate(visibleAttemptStartedAt)
    : ''
  const headerPlaybackCall =
    playableCalls.find((call) => call.callControlId === visibleAttemptId) ||
    playableCalls[playableCalls.length - 1] ||
    null
  const headerAudioIsPlaying =
    Boolean(headerPlaybackCall) &&
    playingAudioCallId === headerPlaybackCall?.callControlId
  const headerAudioIsLoading =
    Boolean(headerPlaybackCall) &&
    loadingAudioCallId === headerPlaybackCall?.callControlId
  const headerAudioState = headerPlaybackCall
    ? audioPlaybackStateFor(headerPlaybackCall)
    : null
  const headerAudioStateName =
    headerAudioState?.status ||
    (headerAudioIsPlaying ? 'playing' : headerAudioIsLoading ? 'checking' : '')
  const headerAudioLabel = headerPlaybackCall
    ? headerAudioStateName === 'playing'
      ? 'Pause visible call audio'
      : headerAudioStateName === 'paused'
        ? 'Resume visible call audio'
        : 'Play visible call audio'
    : 'No playable call audio'
  const showHeaderAudio = Boolean(headerPlaybackCall)

  function toggleAllVisibleCallAttempts() {
    setSelectedCallAttemptIds((current) => {
      const next = new Set(current)
      if (allVisibleCallAttemptsSelected) {
        selectableCallAttempts.forEach((call) => next.delete(call.callControlId))
      } else {
        selectableCallAttempts.forEach((call) => next.add(call.callControlId))
      }
      return next
    })
  }

  function toggleCallAttemptSelected(callId: string) {
    setSelectedCallAttemptIds((current) => {
      const next = new Set(current)
      if (next.has(callId)) next.delete(callId)
      else next.add(callId)
      return next
    })
  }

  async function deleteSelectedCallAttempts() {
    if (
      !onDeleteCallAttempts ||
      selectedVisibleCallAttemptIdList.length === 0 ||
      deleteCallAttemptsBusy
    ) {
      return
    }
    setDeleteCallAttemptsBusy(true)
    try {
      await onDeleteCallAttempts(selectedVisibleCallAttemptIdList)
      setSelectedCallAttemptIds((current) => {
        const next = new Set(current)
        selectedVisibleCallAttemptIdList.forEach((id) => next.delete(id))
        return next
      })
    } catch {
      // The app-level delete handler owns the visible failure notice.
    } finally {
      setDeleteCallAttemptsBusy(false)
    }
  }

  function renderTranscriptEntry(
    entry: TranscriptEntry,
    key: string,
  ) {
    return (
      <article
        key={key}
        className={[
          'transcript-entry',
          transcriptSpeakerClass(entry.speaker),
          entry.tone ? `tone-${entry.tone}` : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <div>
          <strong>
            {transcriptSpeakerLabel(entry.speaker, {
              agent: agentTranscriptLabel,
              lead: transcriptLeadLabel,
            })}
          </strong>
          <time>{entry.at}</time>
        </div>
        <ChatMessageBody text={entry.text}>
          <p>{entry.text}</p>
        </ChatMessageBody>
        <TranscriptEmotionScores scores={entry.emotionScores} />
      </article>
    )
  }

  function renderLinkedSourceHistory(
    thread?: CommunicationThreadSummary,
    call?: RecentCallSummary,
  ) {
    if (!thread || !hasCrossSourceHistory(thread)) return null
    if (showContactSourceHistory && thread.threadId === selectedContactSourceThread?.threadId) {
      return null
    }
    const fallbackMessages = call
      ? communicationMessagesForRecentCall(call, thread.threadId)
      : []

    return (
      <section
        className="communication-source-history"
        aria-label="Linked source history"
      >
        <div className="communication-source-history-heading">
          <strong>Source history</strong>
          <span>{communicationThreadChannelLabel(thread)}</span>
        </div>
        <CommunicationThreadMessages
          className="communication-source-history-list"
          emptyText="No source messages are stored for this thread yet."
          fallbackMessages={fallbackMessages}
          labels={{
            agent: agentTranscriptLabel,
            contact: transcriptLeadLabel,
          }}
          loadingText="Loading source history..."
          threadId={thread.threadId}
        />
      </section>
    )
  }

  function renderSelectedContactSourceHistory() {
    const thread = selectedContactSourceThread
    if (!thread || !showContactSourceHistory) return null
    return (
      <section
        className="communication-source-history contact-source-history"
        aria-label="Selected contact source history"
        data-thread-id={thread.threadId}
      >
        <div className="communication-source-history-heading">
          <strong>Contact source history</strong>
          <span>{communicationThreadChannelLabel(thread)}</span>
        </div>
        <CommunicationThreadMessages
          className="communication-source-history-list"
          emptyText="No source messages are stored for this contact yet."
          labels={{
            agent: agentTranscriptLabel,
            contact: transcriptLeadLabel,
          }}
          loadingText="Loading contact source history..."
          threadId={thread.threadId}
        />
      </section>
    )
  }

  useEffect(() => {
    if (!mobileTranscriptOpen || !onCloseMobileTranscript) return undefined

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') onCloseMobileTranscript?.()
    }

    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [mobileTranscriptOpen, onCloseMobileTranscript])

  return (
    <aside
      className={[
        'call-column',
        mobileTranscriptOpen ? 'mobile-transcript-open' : '',
        mobileTranscriptFullscreen ? 'mobile-transcript-fullscreen' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      aria-label="Live call console"
      role={mobileTranscriptOpen ? 'dialog' : undefined}
      aria-modal={mobileTranscriptOpen ? 'true' : undefined}
    >
        <section
          className="panel transcript-panel"
          aria-label="Calls"
          data-testid={speakTestIds.transcriptPanel}
        >
          {(runControl || showDesktopTakeoverControl) && (
            <div className="transcript-run-control">
              {showDesktopTakeoverControl && (
                <button
                  className={[
                    'dialer-takeover-button',
                    activeCall?.takeover ? 'active' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  disabled={controlsLocked || !liveControlReady}
                  data-action-id={speakActionIds.toggleTakeover}
                  type="button"
                  title={
                    !liveControlReady
                      ? 'Waiting for Speak and phone media before takeover'
                      : activeCall?.takeover
                      ? 'Release microphone and resume the agent'
                      : 'Pause the agent and bridge your microphone'
                  }
                  onClick={onBargeIn}
                  aria-label={
                    activeCall?.takeover
                      ? 'Release takeover and resume agent'
                      : 'Take over active call'
                  }
                >
                  {takeoverBusy ? (
                    <Activity size={16} />
                  ) : (
                    <Mic size={18} />
                  )}
                </button>
              )}
              {runControl}
            </div>
          )}
          <div className="panel-heading compact-heading">
            <div className="transcript-heading-copy">
              <h2>{transcriptHeading}</h2>
              <p className="transcript-heading-meta">
                <span>{transcriptSubheading}</span>
                {visibleAttemptTime && (
                  <time dateTime={visibleAttemptStartedAt}>
                    {visibleAttemptId === liveAttemptId ? 'Live since ' : ''}
                    {visibleAttemptTime}
                  </time>
                )}
              </p>
            </div>
            <div className="transcript-header-actions">
              {onToggleMobileTranscriptFullscreen && (
                <button
                  className="icon-button transcript-action-button mobile-transcript-expand"
                  type="button"
                  data-action-id={speakActionIds.expandTranscript}
                  title={mobileTranscriptFullscreen ? 'Collapse calls' : 'Expand calls'}
                  aria-label={mobileTranscriptFullscreen ? 'Collapse calls' : 'Expand calls'}
                  aria-pressed={mobileTranscriptFullscreen}
                  onClick={onToggleMobileTranscriptFullscreen}
                >
                  {mobileTranscriptFullscreen ? (
                    <Minimize2 size={15} />
                  ) : (
                    <Maximize2 size={15} />
                  )}
                </button>
              )}
              {onCloseMobileTranscript && (
                <button
                  className="icon-button transcript-action-button mobile-transcript-close"
                  type="button"
                  data-action-id={speakActionIds.closeTranscript}
                  title="Close calls"
                  aria-label="Close calls"
                  onClick={onCloseMobileTranscript}
                >
                  <X size={15} />
                </button>
              )}
              {controlStatusText && (
                <span className="header-control-status" aria-live="polite">
                  <Activity size={12} />
                  {controlStatusText}
                </span>
              )}
              {selectableCallAttempts.length > 0 && (
                <div className="playground-history-actions transcript-history-actions">
                  <button
                    className={[
                      'selection-toggle',
                      callAttemptSelectionState,
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    type="button"
                    aria-pressed={
                      allVisibleCallAttemptsSelected
                        ? 'true'
                        : someVisibleCallAttemptsSelected
                          ? 'mixed'
                          : 'false'
                    }
                    aria-label={
                      allVisibleCallAttemptsSelected
                        ? 'Clear visible call selection'
                        : 'Select visible calls'
                    }
                    onClick={toggleAllVisibleCallAttempts}
                  >
                    <Check size={13} />
                  </button>
                  {selectedVisibleCallAttemptIds.size > 0 && (
                    <>
                      <span className="transcript-selection-count">
                        {selectedVisibleCallAttemptIds.size}
                      </span>
                      {onDeleteCallAttempts && (
                        <button
                          className="icon-button danger-button"
                          type="button"
                          title={`Delete ${selectedVisibleCallAttemptIds.size} selected calls`}
                          aria-label={`Delete ${selectedVisibleCallAttemptIds.size} selected calls`}
                          disabled={deleteCallAttemptsBusy}
                          onClick={() => void deleteSelectedCallAttempts()}
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
              {showEndControl && (
                <button
                  className="icon-button transcript-action-button transcript-end-call"
                  type="button"
                  data-action-id={speakActionIds.endCall}
                  disabled={controlsLocked}
                  title={endBusy ? 'Ending active call' : 'End active call'}
                  aria-label={endBusy ? 'Ending active call' : 'End active call'}
                  onClick={() => {
                    void onEndCall()
                  }}
                >
                  {endBusy ? (
                    <Activity size={15} />
                  ) : (
                    <Phone className="call-button-icon-hangup" size={17} />
                  )}
                </button>
              )}
              {showMobileTakeoverControl && (
                <button
                  className={[
                    'icon-button transcript-action-button transcript-mobile-takeover-button',
                    activeCall?.takeover ? 'active' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  disabled={controlsLocked || !liveControlReady}
                  data-action-id={speakActionIds.toggleTakeover}
                  type="button"
                  title={
                    !liveControlReady
                      ? 'Waiting for Speak and phone media before takeover'
                      : activeCall?.takeover
                      ? 'Release microphone and resume the agent'
                      : 'Pause the agent and bridge your microphone'
                  }
                  onClick={onBargeIn}
                  aria-label={
                    activeCall?.takeover
                      ? 'Release takeover and resume agent'
                      : 'Take over active call'
                  }
                >
                  {takeoverBusy ? (
                    <Activity size={15} />
                  ) : (
                    <Mic size={15} />
                  )}
                </button>
              )}
              {showHeaderAudio && (
                <button
                  className={[
                    'icon-button transcript-action-button transcript-header-audio',
                    headerAudioStateName ? `audio-${headerAudioStateName}` : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  type="button"
                  data-action-id={speakActionIds.toggleCallAudio}
                  disabled={headerAudioStateName === 'checking'}
                  title={headerAudioState?.message || headerAudioLabel}
                  aria-label={headerAudioLabel}
                  onClick={() => {
                    if (!headerPlaybackCall) return
                    void toggleCallAudioPlayback(headerPlaybackCall)
                  }}
                >
                  {headerAudioStateName === 'checking' ||
                  headerAudioStateName === 'preparing' ? (
                    <Activity size={15} />
                  ) : headerAudioStateName === 'playing' ? (
                    <Pause size={14} />
                  ) : (
                    <Play size={14} />
                  )}
                </button>
              )}
              {showSkipControl && (
                <button
                  className="icon-button transcript-action-button"
                  title="Skip this call and dial the next ready contact"
                  data-action-id={speakActionIds.skipToNextCall}
                  disabled={
                    controlsLocked ||
                    !voiceReady ||
                    !liveCallActionsActive
                  }
                  onClick={onSkipToNext}
                  aria-label="Skip to next call"
                >
                  {skipBusy ? (
                    <Activity size={15} />
                  ) : (
                    <SkipForward size={15} />
                  )}
                </button>
              )}
            </div>
          </div>
          <div
            className="transcript-list expanded-transcript"
            ref={transcriptListRef}
          >
              {!transcriptLead ? (
                <div className="empty-transcript">
                  Select a contact to review every call for that contact.
                </div>
              ) : (
                <>
                  {selectedLeadCalls.length === 0 &&
                  !liveTranscriptBelongsToSelectedLead ? (
                    <>
                      <div className="empty-transcript">
                        No call has been captured for this contact yet.
                      </div>
                      {renderSelectedContactSourceHistory()}
                    </>
                  ) : (
                    selectedLeadCalls.map((call) => {
                      const entries = call.transcript || []
                      const duration = callDuration(call)
                      const linkedThread = communicationThreadsByCallId.get(
                        call.callControlId,
                      )
                      const canSelectCallAttempt = visibleHistoricalCallIdSet.has(
                        call.callControlId,
                      )
                      return (
                        <section
                          className={[
                            'call-attempt',
                            entries.length === 0 ? 'empty-call-attempt' : '',
                          ]
                            .filter(Boolean)
                            .join(' ')}
                          key={call.callControlId}
                          data-call-control-id={call.callControlId}
                        >
                          <div className="call-attempt-heading">
                            <div>
                              <strong>
                                {formatCallDate(call.createdAt || call.updatedAt)}
                              </strong>
                              <p>
                                {call.insight ||
                                  linkedThread?.summary ||
                                  linkedThread?.latestMessagePreview ||
                                  recentBusinessName(call)}
                              </p>
                            </div>
                            <div className="call-attempt-metrics">
                              {canSelectCallAttempt && (
                                <button
                                  className={[
                                    'selection-toggle',
                                    selectedVisibleCallAttemptIds.has(call.callControlId)
                                      ? 'selected'
                                      : '',
                                  ]
                                    .filter(Boolean)
                                    .join(' ')}
                                  type="button"
                                  aria-pressed={selectedVisibleCallAttemptIds.has(
                                    call.callControlId,
                                  )}
                                  aria-label={`Select call from ${formatCallDate(
                                    call.createdAt || call.updatedAt,
                                  )}`}
                                  onClick={() => toggleCallAttemptSelected(call.callControlId)}
                                >
                                  <Check size={13} />
                                </button>
                              )}
                              {linkedThread && <span>Thread</span>}
                              <span>{recentOutcomeLabel(call)}</span>
                              {call.updatedAt && (
                                <span>Ended {formatCallTime(call.updatedAt)}</span>
                              )}
                              {duration && <span>{duration}</span>}
                              <span>{entries.length} turns</span>
                            </div>
                          </div>
                          {entries.length === 0 ? (
                            <div className="empty-transcript">
                              No call captured for this attempt.
                            </div>
                          ) : (
                            entries.map((entry, index) =>
                              renderTranscriptEntry(
                                entry as TranscriptEntry,
                                `${call.callControlId}-${entry.speaker}-${entry.at || 'turn'}-${index}`,
                              ),
                            )
                          )}
                          {renderLinkedSourceHistory(linkedThread, call)}
                        </section>
                      )
                    })
                  )}
                  {liveTranscriptBelongsToSelectedLead && (
                    <section
                      className="call-attempt live-attempt"
                      data-call-control-id={liveAttemptId}
                    >
                      <div className="call-attempt-heading">
                        <div>
                          <strong>Live call</strong>
                          <p>
                            {[
                              displayedBusinessName || transcriptLead.company,
                              activeCall?.startedAt
                                ? formatCallDate(
                                    new Date(activeCall.startedAt).toISOString(),
                                  )
                                : '',
                            ]
                              .filter(Boolean)
                              .join(' / ')}
                          </p>
                        </div>
                        <div className="call-attempt-metrics">
                          <span>{displayedPhase}</span>
                          <span>{displayedTranscript.length} turns</span>
                        </div>
                      </div>
                      {displayedTranscript.length === 0 ? (
                        <div className="empty-transcript">
                          Waiting for spoken turns.
                        </div>
                      ) : (
                        displayedTranscript.map((entry, index) =>
                          renderTranscriptEntry(
                            entry,
                            `live-${entry.speaker}-${entry.at || 'turn'}-${index}`,
                          ),
                        )
                      )}
                    </section>
                  )}
                  {selectedLeadCalls.length > 0 && renderSelectedContactSourceHistory()}
                </>
              )}
          </div>
          {showJumpToLatest && (
            <button
              className="chat-scroll-latest"
              type="button"
              onClick={() => scrollToLatest()}
              aria-label="Jump to latest call turn"
              title="Jump to latest"
            >
              <ArrowDown size={15} />
              <span>Latest</span>
            </button>
          )}
        </section>
    </aside>
  )
}
