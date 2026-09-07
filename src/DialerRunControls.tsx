import {
  Activity,
  CalendarClock,
  Phone,
  SlidersHorizontal,
  X,
} from './SpeakIcons'
import {
  useCallback,
  useRef,
  useState,
} from 'react'
import type { AgentConfigProfile } from './agentConfigs'
import {
  contactSourceKeyFromDialerSourceId,
  isContactSourceKeyForSource,
} from './contactSources'
import type { SmartView } from './types'
import { speakActionIds, speakTestIds } from './uiContract'
import { useDismissibleLayer } from './useDismissibleLayer'

type DialerBusyState = 'idle' | 'start' | 'next' | 'end' | 'takeover' | 'release'

interface DialerRunControlsProps {
  activeAgentProfileId: string
  activeCallIsLive: boolean
  activeSmartViewId: string
  campaignRunning: boolean
  controlsLocked: boolean
  contactSources: { id: string; label: string }[]
  dialerSourceId: string
  profiles: AgentConfigProfile[]
  readyCount: number
  scheduledStartAt: string
  smartViews: SmartView[]
  onScheduleChange: (value: string) => void
  onSelectAgent: (profileId: string) => void
  onSelectSource: (sourceId: string) => void
  onSelectSmartView: (smartViewId: string) => void
}

function dialerSourceName(
  sourceId: string,
  contactSources: { id: string; label: string }[],
) {
  if (sourceId.startsWith('source:')) {
    return contactSources.find((source) => source.id === sourceId)?.label || 'Contact source'
  }
  return 'Contact list'
}

export function DialerRunControls({
  activeAgentProfileId,
  activeCallIsLive,
  activeSmartViewId,
  campaignRunning,
  controlsLocked,
  contactSources,
  dialerSourceId,
  profiles,
  readyCount,
  scheduledStartAt,
  smartViews,
  onScheduleChange,
  onSelectAgent,
  onSelectSource,
  onSelectSmartView,
}: DialerRunControlsProps) {
  const [setupOpen, setSetupOpen] = useState(false)
  const setupRef = useRef<HTMLDivElement>(null)
  const activeProfile = profiles.find((profile) => profile.id === activeAgentProfileId)
  const activeSourceName = dialerSourceName(dialerSourceId, contactSources)
  const activeSmartViewName =
    smartViews.find((smartView) => smartView.id === activeSmartViewId)?.name || ''
  const setupLabel = `Dialer setup: ${activeSourceName}, ${activeProfile?.name || 'Agent'}`

  const dismissSetup = useCallback(() => {
    setSetupOpen(false)
  }, [])

  useDismissibleLayer({
    enabled: setupOpen,
    onDismiss: dismissSetup,
    refs: [setupRef],
  })

  return (
    <div
      className="dialer-run-controls"
      data-testid={speakTestIds.dialerRunControls}
      aria-label="Dialer setup"
    >
      <div
        className="dialer-schedule-control"
        ref={setupRef}
      >
        <button
          className={[
            'icon-button',
            'dialer-setup-trigger',
            dialerSourceId || scheduledStartAt ? 'active' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          type="button"
          data-action-id={speakActionIds.configureDialer}
          title={setupLabel}
          aria-label={setupLabel}
          aria-expanded={setupOpen}
          onClick={() => setSetupOpen((current) => !current)}
        >
          <SlidersHorizontal size={16} />
          <span className="dialer-setup-copy">
            <strong>{activeSourceName}</strong>
            <small>
              {[
                activeSmartViewName || '',
                activeProfile?.name || 'Agent',
              ].filter(Boolean).join(' / ')}
            </small>
          </span>
        </button>
        {setupOpen && (
          <div className="dialer-schedule-popover" role="dialog" aria-label="Dialer setup">
            <label>
              <span>Agent</span>
              <select
                className="dialer-run-select"
                data-action-id={speakActionIds.selectAgentProfile}
                value={activeAgentProfileId}
                disabled={
                  controlsLocked ||
                  activeCallIsLive ||
                  campaignRunning ||
                  profiles.length === 0
                }
                aria-label="Select dialer agent"
                onChange={(event) => onSelectAgent(event.target.value)}
              >
                {profiles.length === 0 ? (
                  <option value="">No agents</option>
                ) : (
                  profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))
                )}
              </select>
            </label>
            <label>
              <span>Contact list</span>
              <select
                className="dialer-run-select"
                data-action-id={speakActionIds.selectContactSource}
                value={dialerSourceId}
                disabled={controlsLocked || activeCallIsLive || campaignRunning}
                aria-label="Select contact list"
                onChange={(event) => onSelectSource(event.target.value)}
              >
                <option value="">Contact list</option>
                {contactSources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Smart View</span>
              <select
                className="dialer-run-select"
                data-action-id={speakActionIds.selectSmartView}
                value={activeSmartViewId}
                disabled={
                  controlsLocked ||
                  activeCallIsLive ||
                  campaignRunning ||
                  !dialerSourceId
                }
                aria-label="Select Smart View"
                onChange={(event) => onSelectSmartView(event.target.value)}
              >
                <option value="">All contacts in source</option>
                {smartViews.map((smartView) => (
                  <option key={smartView.id} value={smartView.id}>
                    {smartView.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Schedule</span>
              <div className="dialer-schedule-input-row">
                <input
                  type="datetime-local"
                  value={scheduledStartAt}
                  onChange={(event) => onScheduleChange(event.target.value)}
                  aria-label="Queue start date and time"
                />
                <button
                  className="icon-button"
                  type="button"
                  title="Clear scheduled time"
                  aria-label="Clear scheduled time"
                  onClick={() => onScheduleChange('')}
                >
                  <X size={15} />
                </button>
              </div>
            </label>
            <p className="dialer-setup-summary">
              <strong>{activeSourceName}</strong>
              <span>
                {[
                  activeSmartViewName || 'All contacts in source',
                  activeProfile?.name || 'Agent',
                  `${readyCount} ready`,
                ].join(' / ')}
              </span>
            </p>
            {scheduledStartAt && (
              <p className="dialer-schedule-note">
                <CalendarClock size={13} />
                Starts {scheduledStartAt}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

interface DialerRunButtonProps {
  activeCallIsLive: boolean
  callToolsDisarming: boolean
  campaignRunning: boolean
  campaignScheduled: boolean
  controlBusy: DialerBusyState
  controlsLocked: boolean
  dialerSourceId: string
  readyCount: number
  voiceReady: boolean
  onCancelSchedule: () => void
  onEndCall: () => void
  onRunQueue: () => void
  onStopQueue: () => void
}

export function DialerRunButton({
  activeCallIsLive,
  callToolsDisarming,
  campaignRunning,
  campaignScheduled,
  controlBusy,
  controlsLocked,
  dialerSourceId,
  readyCount,
  voiceReady,
  onCancelSchedule,
  onEndCall,
  onRunQueue,
  onStopQueue,
}: DialerRunButtonProps) {
  const busy = controlBusy === 'start' || controlBusy === 'next' || controlBusy === 'end'
  const hasSource = dialerSourceId !== ''
  const calltoolsFollowMode = isContactSourceKeyForSource(
    contactSourceKeyFromDialerSourceId(dialerSourceId),
    'calltools',
  )
  const calltoolsReleasePending =
    calltoolsFollowMode && callToolsDisarming && !activeCallIsLive
  const runDisabled = calltoolsReleasePending || busy
    ? true
    : activeCallIsLive
    ? controlsLocked
    : campaignScheduled || campaignRunning
      ? false
      : controlsLocked ||
        !hasSource ||
        (!calltoolsFollowMode && (!voiceReady || readyCount === 0))
  const runLabel = activeCallIsLive
    ? controlBusy === 'end'
      ? 'Ending'
      : 'End'
    : campaignScheduled
      ? 'Cancel'
      : calltoolsReleasePending
        ? 'Making unavailable…'
      : campaignRunning
        ? calltoolsFollowMode
          ? 'Go unavailable'
          : 'Stop'
        : controlBusy === 'start'
          ? calltoolsFollowMode
            ? 'Enabling'
            : 'Starting'
          : calltoolsFollowMode
            ? 'Go available'
            : 'Call'
  const runTitle = activeCallIsLive
    ? 'End the active call'
    : campaignScheduled
      ? 'Cancel scheduled queue start'
      : calltoolsReleasePending
        ? 'Waiting for CallTools to confirm the agent is Unavailable'
        : campaignRunning
          ? calltoolsFollowMode
          ? 'Make the configured agent Unavailable in CallTools'
          : 'Stop queue after the current call'
        : !hasSource
          ? 'Choose a contact list before starting'
          : calltoolsFollowMode
            ? 'Start the selected CallTools campaign and make this agent Available'
          : readyCount === 0
            ? 'No ready callable contacts in this list'
            : 'Start the selected dialer queue'

  function handleRunClick() {
    if (activeCallIsLive) {
      onEndCall()
      return
    }
    if (campaignScheduled) {
      onCancelSchedule()
      return
    }
    if (campaignRunning) {
      onStopQueue()
      return
    }
    onRunQueue()
  }

  return (
    <button
      className={[
        'dialer-run-button',
        'config-test-action-button',
        'config-call-action-button',
        activeCallIsLive || campaignRunning || campaignScheduled || calltoolsReleasePending
          ? 'active'
          : '',
        activeCallIsLive ? 'danger' : '',
        calltoolsFollowMode ? 'calltools-follow-mode' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      type="button"
      data-action-id={
        activeCallIsLive
          ? speakActionIds.endCall
          : campaignScheduled || campaignRunning || calltoolsReleasePending
            ? speakActionIds.stopQueue
            : speakActionIds.startQueue
      }
      disabled={runDisabled}
      title={runTitle}
      aria-label={runTitle}
      onClick={handleRunClick}
    >
      {busy || calltoolsReleasePending ? (
        <Activity size={16} />
      ) : (
        <Phone
          className={
            activeCallIsLive || campaignScheduled || campaignRunning || calltoolsReleasePending
              ? 'call-button-icon-hangup'
              : ''
          }
          size={18}
        />
      )}
      <span>{runLabel}</span>
    </button>
  )
}
