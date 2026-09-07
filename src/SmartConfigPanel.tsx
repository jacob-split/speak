import {
  Activity,
  ArrowDown,
  ArrowUp,
  History,
  Square,
  SquarePen,
} from './SpeakIcons'
import {
  type ReactNode,
  useCallback,
  useMemo,
  useRef,
  useState,
} from 'react'
import { CodexAppIcon } from './AppTopbarControls'
import { ChatMessageBody } from './ChatMessageBody'
import { CodexMessageContent } from './CodexMessageContent'
import type {
  SmartConfigConversationSummary,
  SmartConfigMessage,
} from './useSmartConfigChat'
import { useChatScroll } from './useChatScroll'
import { useAutosizeTextarea } from './useAutosizeTextarea'
import { formatOperationalDateTime } from './time'
import { useDismissibleLayer } from './useDismissibleLayer'
import { speakActionIds, speakTestIds } from './uiContract'

type HistoryAnchor = 'composer' | 'header'

interface SmartConfigPanelProps {
  activeConversationId: string
  authChecking?: boolean
  authEmail?: string
  authRequired?: boolean
  bodyHeader?: ReactNode
  composerLeadingAccessory?: ReactNode
  conversations: SmartConfigConversationSummary[]
  loadingConversations?: boolean
  messages: SmartConfigMessage[]
  onNewConversation: () => void | Promise<void>
  onSelectConversation: (conversationId: string) => void | Promise<void>
  onSendMessage: (message: string) => void | Promise<void>
  onStartGoogleSignIn?: () => void
  onStopMessage: () => void
  profileName: string
  promptOpen?: boolean
  promptPanel?: ReactNode
  sending?: boolean
  status: string
  steerReady?: boolean
}

function conversationTime(value: string) {
  if (!value) return ''
  return formatOperationalDateTime(value, {
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
    day: 'numeric',
  })
}

function messageSpeaker(message: SmartConfigMessage) {
  if (message.role === 'user') return 'You'
  if (message.role === 'system') return 'Smart Config'
  return 'Codex'
}

export function SmartConfigPanel({
  activeConversationId,
  authChecking = false,
  authEmail = '',
  authRequired = false,
  bodyHeader,
  composerLeadingAccessory,
  conversations,
  loadingConversations = false,
  messages,
  onNewConversation,
  onSelectConversation,
  onSendMessage,
  onStartGoogleSignIn,
  onStopMessage,
  profileName,
  promptOpen = false,
  promptPanel,
  sending = false,
  status,
  steerReady = false,
}: SmartConfigPanelProps) {
  const [draftMessage, setDraftMessage] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyAnchor, setHistoryAnchor] = useState<HistoryAnchor>('header')
  const headerHistoryActionsRef = useRef<HTMLDivElement | null>(null)
  const composerHistoryActionsRef = useRef<HTMLDivElement | null>(null)
  const historyPopoverRef = useRef<HTMLDivElement | null>(null)
  const dismissHistory = useCallback(() => setHistoryOpen(false), [])
  const revision = useMemo(
    () => [
      activeConversationId,
      messages.length,
      messages.map((message) => `${message.id}:${message.text.length}`).join('|'),
      sending ? 'sending' : 'idle',
    ].join(':'),
    [activeConversationId, messages, sending],
  )
  const {
    ref: transcriptRef,
    scrollToLatest,
    showJumpToLatest,
  } = useChatScroll<HTMLDivElement>(revision)
  const canSend =
    Boolean(draftMessage.trim()) && !authRequired && (!sending || steerReady)
  const sendDisabled = sending ? false : !canSend
  const sendTitle = sending
    ? 'Stop Smart Config response'
    : 'Send Smart Config message'
  const sendActionId = sending
    ? speakActionIds.stopSmartConfigMessage
    : speakActionIds.sendSmartConfigMessage
  const composerRef = useAutosizeTextarea(draftMessage)

  useDismissibleLayer({
    enabled: historyOpen,
    onDismiss: dismissHistory,
    refs: [headerHistoryActionsRef, composerHistoryActionsRef, historyPopoverRef],
  })

  function sendDraftMessage() {
    const message = draftMessage.trim()
    if (!message || authRequired || (sending && !steerReady)) return
    setDraftMessage('')
    void onSendMessage(message)
  }

  function submitOrStop() {
    if (sending) {
      onStopMessage()
      return
    }
    sendDraftMessage()
  }

  function startNewConversation() {
    setHistoryOpen(false)
    void onNewConversation()
  }

  function toggleHistory(anchor: HistoryAnchor) {
    const sameAnchor = historyAnchor === anchor
    setHistoryAnchor(anchor)
    setHistoryOpen((current) => (sameAnchor ? !current : true))
  }

  function renderThreadControls(anchor: HistoryAnchor) {
    return (
      <>
        <button
          className="icon-button smart-config-thread-button"
          type="button"
          data-action-id={speakActionIds.openSmartConfigHistory}
          aria-expanded={historyOpen && historyAnchor === anchor}
          aria-label="Open Smart Config history"
          title="Smart Config history"
          onClick={() => toggleHistory(anchor)}
        >
          <History size={17} />
        </button>
        <button
          className="icon-button smart-config-thread-button"
          type="button"
          data-action-id={speakActionIds.newSmartConfigConversation}
          disabled={loadingConversations || sending || authRequired}
          aria-label="New Smart Config thread"
          title="New Smart Config thread"
          onClick={startNewConversation}
        >
          <SquarePen size={17} />
        </button>
      </>
    )
  }

  function renderHistoryPanel() {
    return (
      <div
        className="smart-config-history-panel"
        ref={historyPopoverRef}
        data-testid={speakTestIds.smartConfigHistory}
        aria-label="Smart Config conversations"
      >
        <div className="smart-config-history-heading">
          <span>{loadingConversations ? 'Loading' : 'Threads'}</span>
          <button
            className="icon-button smart-config-thread-button"
            type="button"
            data-action-id={speakActionIds.newSmartConfigConversation}
            disabled={loadingConversations || sending || authRequired}
            aria-label="New Smart Config thread"
            title="New Smart Config thread"
            onClick={startNewConversation}
          >
            <SquarePen size={16} />
          </button>
        </div>
        <div className="smart-config-history-list">
          {conversations.length === 0 ? (
            <span>No threads</span>
          ) : (
            conversations.map((conversation) => (
              <button
                className={conversation.id === activeConversationId ? 'active' : ''}
                type="button"
                key={conversation.id}
                data-action-id={speakActionIds.selectSmartConfigConversation}
                disabled={sending}
                onClick={() => {
                  setHistoryOpen(false)
                  void onSelectConversation(conversation.id)
                }}
              >
                <span>{conversation.title || conversation.profileName}</span>
                <em>{conversationTime(conversation.updatedAt)}</em>
              </button>
            ))
          )}
        </div>
      </div>
    )
  }

  return (
    <section
      className="config-test-panel smart-config-panel"
      data-testid={speakTestIds.smartConfigPanel}
    >
      <div className="panel-heading compact-heading config-test-heading smart-config-heading">
        <div className="transcript-heading-copy">
          <h2>Smart Config</h2>
          <p className="transcript-heading-meta">
            <span>{profileName || 'Selected agent'}</span>
            <span>{status}</span>
          </p>
        </div>
        <div className="transcript-header-actions config-test-heading-actions">
          <div
            className="smart-config-thread-actions smart-config-header-thread-actions"
            ref={headerHistoryActionsRef}
          >
            {renderThreadControls('header')}
            {historyOpen && historyAnchor === 'header' && renderHistoryPanel()}
          </div>
        </div>
      </div>

      <div className="smart-config-panel-secondary">
        {authRequired && (
          <div className="smart-config-auth-row">
            <span>
              {authChecking ? 'Checking Codex access' : 'Owner sign-in required'}
            </span>
            <button
              className="primary-button"
              type="button"
              onClick={onStartGoogleSignIn}
            >
              <CodexAppIcon />
              <span>{authEmail || 'Sign in'}</span>
            </button>
          </div>
        )}
      </div>

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
          <div
            className="config-test-transcript operator-chat-thread smart-config-thread"
            ref={transcriptRef}
          >
            {bodyHeader && (
              <div className="config-test-body-header">
                {bodyHeader}
              </div>
            )}
            {messages.length === 0 ? (
              <div className="empty-transcript">No Smart Config messages yet.</div>
            ) : (
              <section
                className="call-attempt live-attempt smart-config-attempt"
                data-call-control-id={activeConversationId || 'smart-config'}
              >
                {messages.map((message) => (
                  <article
                    className={[
                      'transcript-entry',
                      'smart-config-turn',
                      message.role === 'user'
                        ? 'speaker-you'
                        : message.role === 'system'
                          ? 'speaker-system'
                          : 'speaker-ai',
                      message.tone ? `tone-${message.tone}` : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    key={message.id}
                  >
                    <div>
                      <strong>{messageSpeaker(message)}</strong>
                      <time>{message.at}</time>
                    </div>
                    <ChatMessageBody text={message.text}>
                      {message.role === 'assistant' ? (
                        <CodexMessageContent text={message.text} />
                      ) : (
                        <p>{message.text}</p>
                      )}
                    </ChatMessageBody>
                  </article>
                ))}
                {sending && (
                  <div className="chat-progress-row active" aria-live="polite">
                    <Activity size={14} />
                    <span>Codex is responding</span>
                  </div>
                )}
              </section>
            )}
          </div>
        </>
      )}

      <div className="chat-input-row operator-chat-composer playground-composer smart-config-composer">
        <div className="chat-composer-shell">
          <textarea
            ref={composerRef}
            value={draftMessage}
            placeholder={`Tune ${profileName || 'this agent'}...`}
            aria-label="Message Smart Config"
            autoCapitalize="sentences"
            autoComplete="off"
            autoCorrect="on"
            enterKeyHint="send"
            inputMode="text"
            rows={1}
            disabled={authRequired}
            onChange={(event) => setDraftMessage(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault()
                submitOrStop()
              }
            }}
          />
          <div className="chat-composer-toolbar">
            {composerLeadingAccessory || (
              <span
                className="chat-composer-mode chat-composer-brand"
                role="img"
                aria-label="Codex"
                title="Codex"
              >
                <CodexAppIcon />
              </span>
            )}
            <div
              className="smart-config-thread-actions smart-config-composer-thread-actions"
              ref={composerHistoryActionsRef}
            >
              {renderThreadControls('composer')}
              {historyOpen && historyAnchor === 'composer' && renderHistoryPanel()}
            </div>
            <div className="chat-composer-latest-slot">
              {showJumpToLatest && (
                <button
                  className="chat-scroll-latest chat-scroll-latest-inline"
                  type="button"
                  onClick={() => scrollToLatest()}
                  aria-label="Jump to latest Smart Config turn"
                  title="Jump to latest"
                >
                  <ArrowDown size={15} />
                  <span>Latest</span>
                </button>
              )}
            </div>
            <div className="chat-composer-actions">
              <button
                className="primary-button chat-composer-submit"
                type="button"
                data-action-id={sendActionId}
                disabled={sendDisabled}
                onClick={submitOrStop}
                title={sendTitle}
                aria-label={sendTitle}
              >
                {sending ? <Square size={16} /> : <ArrowUp size={17} />}
                <span className="visually-hidden">
                  {sending ? 'Stop' : 'Send'}
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
