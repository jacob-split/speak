import {
  Activity,
  ArrowDown,
  ArrowUp,
  Check,
  Play,
  Square,
  Trash2,
} from './SpeakIcons'
import {
  type ReactNode,
  useMemo,
  useState,
} from 'react'
import type { AgentTestVariables } from './agentConfigs'
import { SpeakLogoMark } from './SpeakLogoMark'
import { formatCallDate } from './calls'
import { ChatMessageBody } from './ChatMessageBody'
import { CommunicationThreadMessages } from './CommunicationThreadMessages'
import { communicationMessagesForTranscriptEntries } from './communicationThreadMessageUtils'
import { TranscriptEmotionScores } from './TranscriptEmotionScores'
import {
  transcriptSpeakerClass,
  transcriptSpeakerLabel,
} from './transcriptLabels'
import type { TranscriptEntry } from './types'
import { useChatScroll } from './useChatScroll'
import { useAutosizeTextarea } from './useAutosizeTextarea'
import { useVisibleScrollSection } from './useVisibleScrollSection'
import { speakActionIds, speakTestIds } from './uiContract'

export interface ConfigTestVariableField {
  key: keyof AgentTestVariables
  label: string
  inputType?: string
  control?: 'input' | 'textarea'
}

type ConfigTestThreadEntry = Pick<TranscriptEntry, 'at' | 'speaker' | 'text'> &
  Partial<Pick<TranscriptEntry, 'id' | 'tone' | 'emotionScores' | 'providerEventId'>>

export interface ConfigTestThread {
  id: string
  title: string
  subtitle?: string
  createdAt?: string
  updatedAt?: string
  outcome?: string
  phase?: string
  transcript: ConfigTestThreadEntry[]
  transcriptTurns?: number
  agentLabel?: string
  leadLabel?: string
  communicationThreadId?: string
  communicationThreadChannels?: string[]
  communicationThreadStatus?: string
  communicationThreadSummary?: string
}

interface ConfigurationTestPanelProps {
  onEnd: () => void | Promise<void>
  onSendMessage?: (message: string) => void | Promise<void>
  onStart: () => void | Promise<void>
  activeThreadTitle?: string
  agentSwitcher?: ReactNode
  agentLabel?: string
  composerControls?: ReactNode
  composerLeadingAccessory?: ReactNode
  composerPlaceholder?: string
  composerTrailingAccessory?: ReactNode
  bodyHeader?: ReactNode
  headerActions?: ReactNode
  historyThreads?: ConfigTestThread[]
  onDeleteHistoryThreads?: (ids: string[]) => void | Promise<void>
  liveStartedAt?: string
  leadLabel?: string
  messageSending?: boolean
  messageProgressLabel?: string
  promptOpen?: boolean
  promptPanel?: ReactNode
  running: boolean
  sessionId: string
  showControls?: boolean
  sendButtonTitle?: string
  startTitle?: string
  starting: boolean
  status: string
  subtitle?: string
  testSetup?: ReactNode
  title?: string
  transcript: TranscriptEntry[]
}

export function ConfigurationTestPanel({
  onEnd,
  onSendMessage,
  onStart,
  activeThreadTitle = 'Live test',
  agentSwitcher,
  agentLabel = 'Agent',
  composerControls,
  composerLeadingAccessory,
  composerPlaceholder = 'Message Agent...',
  composerTrailingAccessory,
  bodyHeader,
  headerActions,
  historyThreads = [],
  onDeleteHistoryThreads,
  liveStartedAt = '',
  leadLabel = 'Test contact',
  messageSending = false,
  messageProgressLabel = 'Waiting for the test agent response',
  promptOpen = false,
  promptPanel,
  running,
  sessionId,
  showControls = true,
  sendButtonTitle,
  startTitle,
  starting,
  status,
  subtitle,
  testSetup,
  title = 'Playground',
  transcript,
}: ConfigurationTestPanelProps) {
  const [draftMessage, setDraftMessage] = useState('')
  const [selectedHistoryThreadIds, setSelectedHistoryThreadIds] = useState<Set<string>>(
    new Set(),
  )
  const canStop = running || Boolean(sessionId)
  const buttonDisabled = starting && !canStop
  const buttonTitle = canStop
    ? 'Stop Playground test'
    : starting
      ? 'Starting Playground test'
      : startTitle || 'Start Playground test'
  const buttonLabel = canStop ? 'Stop test' : starting ? 'Starting' : 'Start test'
  const canSendMessage =
    Boolean(onSendMessage) && Boolean(draftMessage.trim()) && !messageSending
  const resolvedSendButtonTitle = messageSending
    ? 'Sending test message'
    : sendButtonTitle || 'Send test message'

  function sendDraftMessage() {
    const message = draftMessage.trim()
    if (!message || messageSending || !onSendMessage) return
    setDraftMessage('')
    void onSendMessage(message)
  }

  function renderEntry(
    entry: ConfigTestThreadEntry,
    key: string,
    labels = { agent: agentLabel, lead: leadLabel },
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
            {transcriptSpeakerLabel(entry.speaker, labels, {
              treatYouAsLead: true,
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

  function hasCrossSourceHistory(channels?: string[]) {
    const channelSet = new Set(channels || [])
    if (channelSet.size === 0) return false
    if (channelSet.size > 1) return true
    return !channelSet.has('browser_test') && !channelSet.has('call')
  }

  function renderLinkedSourceHistory(thread: ConfigTestThread) {
    if (!thread.communicationThreadId || !hasCrossSourceHistory(thread.communicationThreadChannels)) {
      return null
    }
    const fallbackMessages = communicationMessagesForTranscriptEntries(thread.transcript, {
      agentProfileId: '',
      callControlId: thread.id,
      channel: 'browser_test',
      createdAt: thread.createdAt,
      provider: 'speak',
      threadId: thread.communicationThreadId,
      updatedAt: thread.updatedAt,
    })

    return (
      <section
        className="communication-source-history"
        aria-label="Linked source history"
      >
        <div className="communication-source-history-heading">
          <strong>Source history</strong>
          <span>{(thread.communicationThreadChannels || ['browser_test']).join(' / ')}</span>
        </div>
        <CommunicationThreadMessages
          className="communication-source-history-list"
          emptyText="No source messages are stored for this thread yet."
          fallbackMessages={fallbackMessages}
          labels={{
            agent: thread.agentLabel || agentLabel,
            contact: thread.leadLabel || leadLabel,
          }}
          loadingText="Loading source history..."
          threadId={thread.communicationThreadId}
        />
      </section>
    )
  }

  const orderedHistoryThreads = useMemo(
    () =>
      [...historyThreads].sort(
        (left, right) =>
          (Date.parse(left.createdAt || left.updatedAt || '') || 0) -
          (Date.parse(right.createdAt || right.updatedAt || '') || 0),
      ),
    [historyThreads],
  )
  const hasLiveAttempt = running || Boolean(sessionId) || transcript.length > 0
  const hasHistory = orderedHistoryThreads.length > 0
  const liveThreadId = 'live-test'
  const fallbackThreadId = hasLiveAttempt
    ? liveThreadId
    : orderedHistoryThreads[orderedHistoryThreads.length - 1]?.id || null
  const transcriptRevision = [
    transcript.length,
    orderedHistoryThreads.length,
    orderedHistoryThreads.map((thread) => thread.transcript.length).join(','),
    running ? 'running' : 'idle',
    sessionId,
  ].join(':')
  const {
    ref: transcriptRef,
    scrollToLatest,
    showJumpToLatest,
  } = useChatScroll<HTMLDivElement>(transcriptRevision)
  const visibleThreadIds = useMemo(
    () => [
      ...(hasLiveAttempt ? [liveThreadId] : []),
      ...orderedHistoryThreads.map((thread) => thread.id),
    ],
    [hasLiveAttempt, orderedHistoryThreads],
  )
  const visibleThreadId = useVisibleScrollSection({
    containerRef: transcriptRef,
    fallbackId: fallbackThreadId,
    revision: `${transcriptRevision}:${promptOpen ? 'prompt' : 'transcript'}`,
    sectionIds: visibleThreadIds,
  })
  const visibleHistoryThread =
    orderedHistoryThreads.find((thread) => thread.id === visibleThreadId) ||
    orderedHistoryThreads.find((thread) => thread.id === fallbackThreadId) ||
    null
  const visibleThreadIsActive =
    visibleThreadId === liveThreadId && (running || Boolean(sessionId))
  const visibleThreadStartedAt =
    visibleThreadId === liveThreadId
      ? liveStartedAt
      : visibleHistoryThread?.createdAt || visibleHistoryThread?.updatedAt || ''
  const visibleThreadTime = visibleThreadStartedAt
    ? formatCallDate(visibleThreadStartedAt)
    : ''
  const composerRef = useAutosizeTextarea(draftMessage)
  const visibleHistoryIdSet = useMemo(
    () => new Set(orderedHistoryThreads.map((thread) => thread.id)),
    [orderedHistoryThreads],
  )
  const visibleSelectedHistoryThreadIds = useMemo(
    () =>
      new Set(
        [...selectedHistoryThreadIds].filter((id) => visibleHistoryIdSet.has(id)),
      ),
    [selectedHistoryThreadIds, visibleHistoryIdSet],
  )
  const selectedVisibleHistoryCount = orderedHistoryThreads.filter((thread) =>
    visibleSelectedHistoryThreadIds.has(thread.id),
  ).length
  const allVisibleHistorySelected =
    orderedHistoryThreads.length > 0 &&
    selectedVisibleHistoryCount === orderedHistoryThreads.length
  const someVisibleHistorySelected =
    selectedVisibleHistoryCount > 0 && !allVisibleHistorySelected
  const historySelectionState = allVisibleHistorySelected
    ? 'selected'
    : someVisibleHistorySelected
      ? 'mixed'
      : ''

  function toggleHistoryThreadSelected(id: string) {
    setSelectedHistoryThreadIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAllVisibleHistoryThreads() {
    setSelectedHistoryThreadIds((current) => {
      const next = new Set(current)
      orderedHistoryThreads.forEach((thread) => {
        if (allVisibleHistorySelected) next.delete(thread.id)
        else next.add(thread.id)
      })
      return next
    })
  }

  function deleteHistoryThreads(ids: string[]) {
    if (!ids.length || !onDeleteHistoryThreads) return
    setSelectedHistoryThreadIds((current) => {
      const next = new Set(current)
      ids.forEach((id) => next.delete(id))
      return next
    })
    void onDeleteHistoryThreads(ids)
  }

  return (
    <section className="config-test-panel" data-testid={speakTestIds.configTestPanel}>
      <div className="panel-heading compact-heading config-test-heading">
        <div className="transcript-heading-copy">
          <h2>{title}</h2>
          <p className="transcript-heading-meta">
            <span>{subtitle || status}</span>
            {visibleThreadTime && (
              <time dateTime={visibleThreadStartedAt}>
                {visibleThreadIsActive ? 'Live since ' : ''}
                {visibleThreadTime}
              </time>
            )}
          </p>
        </div>
        {(headerActions || showControls) && (
          <div className="transcript-header-actions config-test-heading-actions">
            {onDeleteHistoryThreads && orderedHistoryThreads.length > 0 && (
              <div className="playground-history-actions">
                <button
                  className={[
                    'selection-toggle',
                    historySelectionState,
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  type="button"
                  aria-pressed={
                    allVisibleHistorySelected
                      ? 'true'
                      : someVisibleHistorySelected
                        ? 'mixed'
                        : 'false'
                  }
                  aria-label={
                    allVisibleHistorySelected
                      ? 'Clear saved test selection'
                      : 'Select saved test history'
                  }
                  onClick={toggleAllVisibleHistoryThreads}
                >
                  <Check size={13} />
                </button>
                {visibleSelectedHistoryThreadIds.size > 0 && (
                  <button
                    className="secondary-button danger-button"
                    type="button"
                    title={`Delete ${visibleSelectedHistoryThreadIds.size} saved tests`}
                    aria-label={`Delete ${visibleSelectedHistoryThreadIds.size} saved tests`}
                    onClick={() =>
                      deleteHistoryThreads(Array.from(visibleSelectedHistoryThreadIds))
                    }
                  >
                    <Trash2 size={14} />
                    <span>{visibleSelectedHistoryThreadIds.size}</span>
                  </button>
                )}
              </div>
            )}
            {headerActions}
            {showControls && (
              <button
                className={canStop ? 'secondary-button' : 'primary-button'}
                data-action-id={
                  canStop ? speakActionIds.stopConfigTest : speakActionIds.startConfigTest
                }
                data-testid={speakTestIds.configTestToggle}
                disabled={buttonDisabled}
                onClick={() => {
                  void (canStop ? onEnd() : onStart())
                }}
                title={buttonTitle}
                aria-label={buttonTitle}
              >
                {canStop ? <Square size={15} /> : <Play size={15} />}
                <span className="config-test-label">{buttonLabel}</span>
              </button>
            )}
          </div>
        )}
        {agentSwitcher && (
          <div className="config-test-agent-switcher-slot">
            {agentSwitcher}
          </div>
        )}
      </div>

      {testSetup && <div className="config-test-setup">{testSetup}</div>}

      {promptOpen && promptPanel ? (
        <div
          className={[
            'config-test-prompt-panel',
            bodyHeader ? 'has-body-header' : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          {bodyHeader && (
            <div className="config-test-body-header">
              {bodyHeader}
            </div>
          )}
          {promptPanel}
        </div>
      ) : (
        <>
          <div className="config-test-transcript operator-chat-thread" ref={transcriptRef}>
            {bodyHeader && (
              <div className="config-test-body-header">
                {bodyHeader}
              </div>
            )}
            {!hasLiveAttempt && !hasHistory ? (
              <div className="empty-transcript">No test call yet.</div>
            ) : (
              <>
                {orderedHistoryThreads.map((thread) => (
                  <section
                    className={[
                      'call-attempt',
                      thread.transcript.length === 0 ? 'empty-call-attempt' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    key={thread.id}
                    data-call-control-id={thread.id}
                  >
                    <div className="call-attempt-heading">
                      <div>
                        <strong>{thread.title}</strong>
                        {thread.subtitle && <p>{thread.subtitle}</p>}
                      </div>
                      <div className="call-attempt-metrics">
                        {onDeleteHistoryThreads && (
                          <button
                            className={[
                              'selection-toggle',
                              visibleSelectedHistoryThreadIds.has(thread.id) ? 'selected' : '',
                            ]
                              .filter(Boolean)
                              .join(' ')}
                            type="button"
                            aria-pressed={visibleSelectedHistoryThreadIds.has(thread.id)}
                            aria-label={`Select saved test ${thread.title}`}
                            onClick={() => toggleHistoryThreadSelected(thread.id)}
                          >
                            <Check size={13} />
                          </button>
                        )}
                        {thread.outcome && <span>{thread.outcome}</span>}
                        {thread.phase && !thread.outcome && <span>{thread.phase}</span>}
                        {thread.communicationThreadId && (
                          <span>{thread.communicationThreadStatus || 'Thread'}</span>
                        )}
                        <span>{thread.transcriptTurns ?? thread.transcript.length} turns</span>
                      </div>
                    </div>
                    {thread.transcript.length === 0 ? (
                      <div className="empty-transcript">
                        {thread.communicationThreadSummary ||
                          'No call captured for this test.'}
                      </div>
                    ) : (
                      thread.transcript.map((entry, index) =>
                        renderEntry(
                          entry,
                          `${thread.id}-${entry.id || entry.at || 'turn'}-${index}`,
                          {
                            agent: thread.agentLabel || agentLabel,
                            lead: thread.leadLabel || leadLabel,
                          },
                        ),
                      )
                    )}
                    {renderLinkedSourceHistory(thread)}
                  </section>
                ))}
                {hasLiveAttempt && (
                  <section
                    className="call-attempt live-attempt"
                    data-call-control-id={liveThreadId}
                  >
                    <div className="call-attempt-heading">
                      <div>
                        <strong>{activeThreadTitle}</strong>
                        <p>{status}</p>
                      </div>
                      <div className="call-attempt-metrics">
                        <span>{running || sessionId ? 'Live' : 'Draft'}</span>
                        <span>{transcript.length} turns</span>
                      </div>
                    </div>
                    {transcript.length === 0 ? (
                      <div className="empty-transcript">Waiting for test turns.</div>
                    ) : (
                      transcript.map((entry, index) =>
                        renderEntry(
                          entry,
                          `${entry.id || entry.at || 'live'}-${index}`,
                        ),
                      )
                    )}
                    {messageSending && (
                      <div className="chat-progress-row active" aria-live="polite">
                        <Activity size={14} />
                        <span>{messageProgressLabel}</span>
                      </div>
                    )}
                  </section>
                )}
              </>
            )}
          </div>
        </>
      )}

      {onSendMessage && (
        <div className="chat-input-row operator-chat-composer playground-composer">
          <div className="chat-composer-shell">
            <textarea
              ref={composerRef}
              value={draftMessage}
              placeholder={composerPlaceholder}
              aria-label={composerPlaceholder}
              autoCapitalize="sentences"
              autoComplete="off"
              autoCorrect="on"
              enterKeyHint="send"
              inputMode="text"
              rows={1}
              onChange={(event) => setDraftMessage(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === 'Enter' &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault()
                  sendDraftMessage()
                }
              }}
            />
            <div className="chat-composer-toolbar">
              {composerLeadingAccessory || (
                <span
                  className="chat-composer-mode chat-composer-brand"
                  role="img"
                  aria-label="Speak"
                  title="Speak"
                >
                  <SpeakLogoMark />
                </span>
              )}
              {composerControls}
              <div className="chat-composer-latest-slot">
                {showJumpToLatest && (
                  <button
                    className="chat-scroll-latest chat-scroll-latest-inline"
                    type="button"
                    onClick={() => scrollToLatest()}
                    aria-label="Jump to latest playground turn"
                    title="Jump to latest"
                  >
                    <ArrowDown size={15} />
                    <span>Latest</span>
                  </button>
                )}
              </div>
              <div className="chat-composer-actions">
                {composerTrailingAccessory}
                <button
                  className="primary-button chat-composer-submit"
                  type="button"
                  data-action-id={speakActionIds.sendPlaygroundMessage}
                  disabled={!canSendMessage}
                  onClick={sendDraftMessage}
                  title={resolvedSendButtonTitle}
                  aria-label={resolvedSendButtonTitle}
                >
                  {messageSending ? <Activity size={16} /> : <ArrowUp size={17} />}
                  <span className="visually-hidden">
                    {messageSending ? 'Sending' : 'Send'}
                  </span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
