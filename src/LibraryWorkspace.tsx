import Papa from 'papaparse'
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Bot,
  Building2,
  Check,
  CheckCircle2,
  Clock3,
  FileText,
  Link2,
  Mail,
  MapPin,
  MessagesSquare,
  Pause,
  PhoneCall,
  Play,
  Plus,
  Save,
  SlidersHorizontal,
  Tags,
  Trash2,
  Upload,
  X,
} from './SpeakIcons'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  type ChangeEvent,
} from 'react'
import {
  AppPrimaryNavigation,
  AppearanceSwitch,
  GlobalSearchTrigger,
} from './AppTopbarControls'
import { apiBase, apiUrl } from './api'
import {
  communicationChannelLabel,
  communicationMessageLabel,
  communicationMessagesForRecentCall,
  communicationMessagesForRecentCalls,
  mergeCommunicationMessages,
  recentCallChannel,
  type CommunicationMessage,
} from './communicationThreadMessageUtils'
import { CommunicationThreadMessages as CommunicationThreadMessagesView } from './CommunicationThreadMessages'
import calltoolsIconUrl from './assets/calltools-favicon.png'
import { CopyAction } from './CopyAction'
import {
  ContactDeliveryComposer,
  EmailFieldAction,
  SmsFieldActions,
} from './ContactDeliveryActions'
import { cleanEmailAddress } from './ContactDeliveryUtils'
import type { AgentConfigProfile } from './agentConfigs'
import {
  callDurationSeconds,
  canRequestCallAudio,
  formatCallDate,
  recentBusinessName,
  recentOutcomeLabel,
  type RecentCallSummary,
} from './calls'
import {
  buildContactSourceOptionsFromLeads,
  contactSourceKey,
  dialerSourceIdFromContactSourceKey,
  isSelectableContactSource,
  leadContactSourceKey,
  leadMatchesContactSourceKey,
  resolveContactSourceOptionKey,
  type ContactSourceOption,
} from './contactSources'
import {
  contextSummary,
  contextUrlInputValue,
  normalizeContextFields,
  parseContextUrlInput,
} from './contextFields'
import { GlobalSearchOverlay } from './GlobalSearchOverlay'
import { LeadBulkActionBar } from './LeadBulkActionBar'
import {
  navigateToAppUrl,
  withSpeakViewTransition,
} from './navigation'
import {
  normalizePhoneNumber,
  normalizePhoneOnCommit,
} from './phoneNumbers'
import { writePlaygroundPhoneLeadId } from './playgroundLeadSelection'
import { useDismissibleLayer } from './useDismissibleLayer'
import {
  csvRowToLead,
  filterAndSortLeads,
  normalizeKey,
  statusLabels,
  statusOptions,
  type SortField,
  type StatusFilter,
} from './leads'
import {
  defaultLibraryColumns,
  type LibraryColumn,
  type LibraryColumnKey,
} from './libraryColumns'
import type {
  ContextAttachment,
  ContextFields,
  Lead,
  LeadStatus,
  SmartView,
  TranscriptEntry,
} from './types'
import {
  callAgentTranscriptLabel,
  callLeadTranscriptLabel,
} from './transcriptLabels'
import { useCallAudioPlayback } from './useCallAudioPlayback'
import { useAppearance } from './useAppearance'
import { speakActionIds, speakRouteIds, speakTestIds } from './uiContract'

type LibraryMode = 'leads' | 'agents' | 'transcripts'
type TranscriptSourceFilter =
  | 'all'
  | 'call'
  | 'sms'
  | 'email'
  | 'browser_test'
  | 'recorded'
  | 'scored'
  | 'unresolved'
type AgentSourceFilter = 'all' | 'active' | 'smart-view' | 'used' | 'recorded' | 'scored'
type AgentSortField = 'activity' | 'name' | 'calls' | 'turns' | 'recordings'
type TranscriptSortField = 'date' | 'contact' | 'agent' | 'duration' | 'turns' | 'source'

const contactLibraryRenderBatchSize = 250

function PersonalPhoneMark() {
  return <PhoneCall className="personal-phone-logo-mark" size={16} />
}

function CallToolsMark() {
  return (
    <img className="calltools-logo-mark" src={calltoolsIconUrl} alt="" aria-hidden="true" />
  )
}

interface WorkspacePayload {
  contactSources?: ContactSourceSummary[]
  leads?: Lead[]
  smartViews?: SmartView[]
  profiles?: AgentConfigProfile[]
  activeProfileId?: string
}

interface ContactSourceSummary {
  id: string
  source: string
  sourceId?: string
  sourceName?: string
  leadCount?: number
}

interface CallToolsCampaignOption {
  id: string
  name?: string
  active?: boolean
  originateCalls?: boolean
  liveFilterId?: string
  bucketId?: string
}

interface CallToolsOptionsPayload {
  campaigns?: CallToolsCampaignOption[]
}

function calltoolsCampaignLabel(campaign: CallToolsCampaignOption) {
  const sourceKind = campaign.liveFilterId
    ? 'Live filter'
    : campaign.bucketId
      ? 'Bucket'
      : 'No source'
  return `${campaign.name || `Campaign ${campaign.id}`} / ${sourceKind}`
}

interface RecentCallsPayload {
  calls?: RecentCallSummary[]
}

interface CommunicationProviderLink {
  id?: string
  kind?: string
  provider?: string
}

interface CommunicationParticipant {
  agentProfileId?: string
  contactId?: string
  label?: string
  provider?: string
  role?: string
}

interface CommunicationThreadSummary {
  agentProfileId?: string
  channels?: string[]
  contactId?: string
  emotionScoreTurns?: number
  hasEmotionScores?: boolean
  lastInboundAt?: string
  lastOutboundAt?: string
  latestChannel?: string
  latestMessagePreview?: string
  legacyRecentCall?: RecentCallSummary
  messageCount?: number
  participants?: CommunicationParticipant[]
  providerLinks?: CommunicationProviderLink[]
  status?: string
  summary?: string
  sourceThreadIds?: string[]
  threadId: string
  updatedAt?: string
}

interface CommunicationThreadsPayload {
  threads?: CommunicationThreadSummary[]
}

interface CommunicationMessagesPayload {
  messages?: CommunicationMessage[]
}

interface LibraryPhoneFieldProps {
  column: LibraryColumn
  lead: Lead
  onCommit: (value: string) => Promise<void> | void
  onOpenDialer: () => Promise<void> | void
}

function LibraryPhoneField({
  column,
  lead,
  onCommit,
  onOpenDialer,
}: LibraryPhoneFieldProps) {
  const [value, setValue] = useState(lead.phone || '')
  const [smsComposerOpen, setSmsComposerOpen] = useState(false)

  const normalizedPhone = normalizePhoneNumber(value)
  const copyPhone = normalizedPhone || value.trim()
  const phoneReady = Boolean(normalizedPhone)

  async function commitPhone() {
    const nextValue = normalizePhoneOnCommit(value)
    setValue(nextValue)
    await onCommit(nextValue)
  }

  return (
    <label
      className="contact-library-field contact-library-phone-field"
      key={column.key}
    >
      <span>{column.label}</span>
      <div
        className={[
          'phone-input-shell',
          'contact-library-phone-input',
          phoneReady || !value.trim() ? '' : 'invalid',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <input
          value={value}
          data-action-id={speakActionIds.editLead}
          aria-label={`${lead.company || lead.name || 'Contact'} ${column.label}`}
          autoCapitalize="none"
          autoComplete={autocompleteForColumn(column.key)}
          autoCorrect="off"
          enterKeyHint="done"
          inputMode="tel"
          type="tel"
          onBlur={() => {
            void commitPhone()
          }}
          onChange={(event) => setValue(event.target.value)}
        />
        <CopyAction
          className="phone-input-action"
          disabled={!copyPhone}
          label="Copy phone"
          value={copyPhone}
        />
        <button
          className="phone-input-action phone-dial-action"
          type="button"
          title="Open this contact in Dialer"
          aria-label="Open this contact in Dialer"
          disabled={!phoneReady}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            void (async () => {
              await commitPhone()
              await onOpenDialer()
            })()
          }}
        >
          <PhoneCall size={14} />
        </button>
        <SmsFieldActions
          disabled={!phoneReady}
          lead={lead}
          onOpenAgentSms={() => setSmsComposerOpen(true)}
          phone={copyPhone}
        />
      </div>
      {smsComposerOpen && (
        <ContactDeliveryComposer
          channel="sms"
          contactId={lead.id}
          contactLabel={lead.company || lead.name || 'Contact'}
          lead={lead}
          onClose={() => setSmsComposerOpen(false)}
          phone={copyPhone}
        />
      )}
    </label>
  )
}

interface LibraryEmailFieldProps {
  column: LibraryColumn
  lead: Lead
  onCommit: (value: string) => Promise<void> | void
}

function LibraryEmailField({
  column,
  lead,
  onCommit,
}: LibraryEmailFieldProps) {
  const [value, setValue] = useState(lead.email || '')
  const [emailComposerOpen, setEmailComposerOpen] = useState(false)
  const cleanEmail = cleanEmailAddress(value)
  const copyEmail = cleanEmail || value.trim()

  async function commitEmail() {
    const nextValue = cleanEmailAddress(value) || value.trim()
    setValue(nextValue)
    await onCommit(nextValue)
  }

  return (
    <label
      className="contact-library-field contact-library-email-field"
      key={column.key}
    >
      <span>{column.label}</span>
      <div className="phone-input-shell email-input-shell contact-library-email-input">
        <input
          value={value}
          data-action-id={speakActionIds.editLead}
          aria-label={`${lead.company || lead.name || 'Contact'} ${column.label}`}
          autoCapitalize="none"
          autoComplete={autocompleteForColumn(column.key)}
          autoCorrect="off"
          enterKeyHint="done"
          inputMode="email"
          type="email"
          onBlur={() => {
            void commitEmail()
          }}
          onChange={(event) => setValue(event.target.value)}
        />
        <CopyAction
          className="phone-input-action"
          disabled={!copyEmail}
          label="Copy email"
          value={copyEmail}
        />
        <EmailFieldAction
          disabled={!cleanEmail}
          email={cleanEmail}
          onOpenEmail={() => setEmailComposerOpen(true)}
        />
      </div>
      {emailComposerOpen && (
        <ContactDeliveryComposer
          channel="email"
          contactId={lead.id}
          contactLabel={lead.company || lead.name || 'Contact'}
          email={cleanEmail}
          lead={lead}
          onClose={() => setEmailComposerOpen(false)}
        />
      )}
    </label>
  )
}

function parseTags(value: string) {
  return value
    .split(/[;,|]/)
    .map((tag) => tag.trim())
    .filter(Boolean)
}

function formatClock(totalSeconds: number) {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '0:00'
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = Math.round(totalSeconds % 60)
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

function inputModeForColumn(key: LibraryColumnKey) {
  if (key === 'email') return 'email'
  if (key === 'phone') return 'tel'
  return 'text'
}

function autocompleteForColumn(key: LibraryColumnKey) {
  if (key === 'company') return 'organization'
  if (key === 'name') return 'name'
  if (key === 'email') return 'email'
  if (key === 'phone') return 'tel'
  if (key === 'state') return 'address-level1'
  return 'off'
}

function formatFileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  const kilobytes = bytes / 1024
  if (kilobytes < 1024) return `${kilobytes.toFixed(kilobytes >= 10 ? 0 : 1)} KB`
  const megabytes = kilobytes / 1024
  return `${megabytes.toFixed(megabytes >= 10 ? 0 : 1)} MB`
}

type ContextTarget =
  | { scope: 'lead'; id: string }
  | { scope: 'profile'; id: string }

function transcriptSource(call: RecentCallSummary) {
  return call.callControlId.startsWith('test-') ||
    call.origin === 'playground_browser' ||
    call.origin === 'playground_phone'
    ? 'playground'
    : 'phone'
}

function transcriptSourceLabel(call: RecentCallSummary) {
  return transcriptSource(call) === 'playground' ? 'Playground' : 'Phone'
}

function transcriptHasEmotionScores(call: RecentCallSummary) {
  return Boolean(call.transcript?.some((entry) => entry.emotionScores))
}

function communicationThreadContactLabel(
  thread: CommunicationThreadSummary | undefined,
  leads: Lead[],
) {
  if (!thread) return ''
  const participantLabel = thread.participants?.find(
    (participant) => participant.role === 'contact',
  )?.label
  const matchedLead = leads.find((lead) => lead.id === thread.contactId)
  return participantLabel || matchedLead?.company || matchedLead?.name || thread.contactId || ''
}

function communicationThreadSearchText(
  thread: CommunicationThreadSummary | undefined,
  leads: Lead[],
) {
  if (!thread) return ''
  return [
    thread.threadId,
    thread.sourceThreadIds?.join(' '),
    thread.status,
    thread.channels?.join(' '),
    thread.latestChannel,
    thread.summary,
    thread.latestMessagePreview,
    communicationThreadContactLabel(thread, leads),
    thread.providerLinks
      ?.map((link) => [link.provider, link.kind, link.id].filter(Boolean).join(' '))
      .join(' '),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

function communicationThreadMatchesId(
  thread: CommunicationThreadSummary | undefined,
  threadId = '',
) {
  if (!thread || !threadId) return false
  return thread.threadId === threadId || Boolean(thread.sourceThreadIds?.includes(threadId))
}

function communicationThreadSourceLabel(thread: CommunicationThreadSummary) {
  return communicationChannelLabel(communicationThreadPrimaryChannel(thread))
}

function orderedCommunicationThreadChannels(thread: CommunicationThreadSummary) {
  const primary = communicationThreadPrimaryChannel(thread)
  const channels = [primary, ...(thread.channels || [])]
  return channels.filter((channel, index) => channels.indexOf(channel) === index)
}

function communicationThreadChannelSummary(thread: CommunicationThreadSummary) {
  const channels = orderedCommunicationThreadChannels(thread)
  if (channels.length === 0) return communicationThreadSourceLabel(thread)
  return channels
    .map(communicationChannelLabel)
    .filter((label, index, labels) => labels.indexOf(label) === index)
    .join(' / ')
}

function communicationThreadPreviewText(thread?: CommunicationThreadSummary) {
  return thread?.latestMessagePreview || thread?.summary || ''
}

function communicationThreadPrimaryChannel(thread: CommunicationThreadSummary) {
  if (thread.latestChannel) return thread.latestChannel
  const channels = thread.channels || []
  if (channels.includes('sms')) return 'sms'
  if (channels.includes('email')) return 'email'
  if (channels.includes('browser_test')) return 'browser_test'
  if (channels.includes('call')) return 'call'
  return channels[0] || 'call'
}

function communicationThreadCallIds(thread: CommunicationThreadSummary) {
  return Array.from(
    new Set(
      (thread.providerLinks || [])
        .filter((link) => link.kind === 'call_control' && link.id)
        .map((link) => String(link.id)),
    ),
  )
}

function communicationThreadIdForRecentCall(call: RecentCallSummary) {
  return `thread-recent-call-${String(call.callControlId || call.createdAt || 'unknown')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')}`
}

function activityThreadIdForContact(contactId: string) {
  return `thread-contact-activity-${String(contactId || 'unknown')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')}`
}

function activityGroupKeyForThread(thread: CommunicationThreadSummary) {
  return thread.contactId ? `contact:${thread.contactId}` : `thread:${thread.threadId}`
}

function activityGroupKeyForRecentCall(
  call: RecentCallSummary,
  fallbackThread?: CommunicationThreadSummary,
) {
  const contactId = call.lead?.id || fallbackThread?.contactId || ''
  if (contactId) return `contact:${contactId}`
  return fallbackThread
    ? activityGroupKeyForThread(fallbackThread)
    : `call:${call.callControlId || call.createdAt || 'unknown'}`
}

function communicationMessageSummary(messages: CommunicationMessage[]) {
  return messages
    .filter((message) => message.body)
    .slice(-4)
    .map((message) => `${communicationMessageLabel(message)}: ${message.body}`)
    .join(' | ')
}

function latestIso(...values: Array<string | undefined>) {
  const latestMs = values.reduce((max, value) => {
    const timestamp = Date.parse(value || '')
    return timestamp > max ? timestamp : max
  }, 0)
  return latestMs ? new Date(latestMs).toISOString() : ''
}

function latestRecentCallTimestamp(call: RecentCallSummary) {
  return latestIso(call.updatedAt, call.createdAt)
}

function mergeCommunicationProviderLinks(
  ...groups: Array<Array<CommunicationProviderLink | null | undefined> | undefined>
) {
  const seen = new Set<string>()
  const links: CommunicationProviderLink[] = []
  groups.flat().forEach((link) => {
    if (!link?.id) return
    const key = [link.provider || '', link.kind || '', link.id].join(':')
    if (seen.has(key)) return
    seen.add(key)
    links.push(link)
  })
  return links
}

function mergeCommunicationParticipants(
  ...groups: Array<Array<CommunicationParticipant | null | undefined> | undefined>
) {
  const seen = new Set<string>()
  const participants: CommunicationParticipant[] = []
  groups.flat().forEach((participant) => {
    if (!participant?.label && !participant?.contactId && !participant?.agentProfileId) return
    const key = [
      participant.role || '',
      participant.contactId || '',
      participant.agentProfileId || '',
      participant.provider || '',
      participant.label || '',
    ].join(':')
    if (seen.has(key)) return
    seen.add(key)
    participants.push(participant)
  })
  return participants
}

function communicationThreadForRecentCall(call: RecentCallSummary): CommunicationThreadSummary {
  const threadId = communicationThreadIdForRecentCall(call)
  const channel = recentCallChannel(call)
  const messages = communicationMessagesForRecentCall(call, threadId)
  const contactLabel = callLeadTranscriptLabel(call) || recentBusinessName(call)
  const agentLabel = callAgentTranscriptLabel(call)
  const inbound = messages.filter((message) => message.direction === 'inbound')
  const outbound = messages.filter((message) => message.direction === 'outbound')
  return {
    agentProfileId: call.agent?.id || '',
    channels: [channel],
    contactId: call.lead?.id || '',
    emotionScoreTurns: messages.filter((message) => message.emotionScores).length,
    hasEmotionScores: transcriptHasEmotionScores(call),
    lastInboundAt: inbound[inbound.length - 1]?.at || '',
    lastOutboundAt: outbound[outbound.length - 1]?.at || '',
    latestMessagePreview: messages[messages.length - 1]?.body || call.insight || '',
    legacyRecentCall: call,
    messageCount: messages.length,
    participants: [
      contactLabel
        ? { role: 'contact', contactId: call.lead?.id || '', label: contactLabel }
        : null,
      agentLabel
        ? { role: 'agent', agentProfileId: call.agent?.id || '', label: agentLabel }
        : null,
    ].filter(Boolean) as CommunicationParticipant[],
    providerLinks: [
      { provider: 'phoneProvider', kind: 'call_control', id: call.callControlId },
      call.chatId
        ? {
            provider: call.agent?.voiceRuntimeProvider || 'speak',
            kind: 'voice_session',
            id: call.chatId,
          }
        : null,
    ].filter(Boolean) as CommunicationProviderLink[],
    status: call.outcome || call.phase || 'resolved',
    summary: communicationMessageSummary(messages) || call.insight || recentOutcomeLabel(call),
    threadId,
    updatedAt: call.updatedAt || call.createdAt || '',
  }
}

function communicationThreadForActivityGroup({
  calls,
  contactId,
  threads,
}: {
  calls: RecentCallSummary[]
  contactId: string
  threads: CommunicationThreadSummary[]
}): CommunicationThreadSummary {
  const sortedCalls = [...calls].sort(
    (left, right) =>
      (Date.parse(latestRecentCallTimestamp(left)) || 0) -
      (Date.parse(latestRecentCallTimestamp(right)) || 0),
  )
  const sortedThreads = [...threads].sort(
    (left, right) =>
      communicationThreadTimestamp(left) - communicationThreadTimestamp(right),
  )
  const latestThread = sortedThreads[sortedThreads.length - 1]
  const latestCall = sortedCalls[sortedCalls.length - 1]
  const latestCallAt = latestCall ? latestRecentCallTimestamp(latestCall) : ''
  const latestCallMs = Date.parse(latestCallAt) || 0
  const latestThreadMs = latestThread ? communicationThreadTimestamp(latestThread) : 0
  const hasThreadNonCallActivity = sortedThreads.some((thread) =>
    (thread.channels || []).some((channel) => channel !== 'call' && channel !== 'browser_test'),
  )
  const groupThreadId =
    latestThread?.threadId ||
    (contactId
      ? activityThreadIdForContact(contactId)
      : latestCall
        ? communicationThreadIdForRecentCall(latestCall)
        : 'thread-activity-empty')
  const rawCallMessages = communicationMessagesForRecentCalls(sortedCalls, groupThreadId)
  const rawInboundMessages = rawCallMessages.filter((message) => message.direction === 'inbound')
  const rawOutboundMessages = rawCallMessages.filter((message) => message.direction === 'outbound')
  const sourceThreadMessageCount = sortedThreads.reduce(
    (sum, thread) => sum + Number(thread.messageCount || 0),
    0,
  )
  const sourceThreadCallIds = new Set(sortedThreads.flatMap(communicationThreadCallIds))
  const fallbackCallMessageCount = rawCallMessages.filter((message) => {
    const callControlId = String(message.providerIds?.callControlId || '')
    return !callControlId || !sourceThreadCallIds.has(callControlId)
  }).length
  const callLinks = sortedCalls.map((call) => communicationThreadForRecentCall(call).providerLinks || [])
  const callParticipants = sortedCalls.map(
    (call) => communicationThreadForRecentCall(call).participants || [],
  )
  const channels = Array.from(
    new Set([
      ...sortedThreads.flatMap((thread) => thread.channels || []),
      ...sortedCalls.map(recentCallChannel),
    ]),
  )
  const sourceThreadIds = sortedThreads.map((thread) => thread.threadId)
  const latestCallSummary =
    communicationMessageSummary(rawCallMessages) ||
    latestCall?.insight ||
    (latestCall ? recentOutcomeLabel(latestCall) : '')
  const latestSourceIsCall =
    rawCallMessages.length > 0 &&
    (!hasThreadNonCallActivity || latestCallMs >= latestThreadMs)
  const updatedAt = latestSourceIsCall
    ? latestCallAt
    : latestIso(
        ...sortedThreads.map((thread) => thread.updatedAt),
        ...sortedCalls.map(latestRecentCallTimestamp),
      )
  return {
    agentProfileId: latestThread?.agentProfileId || latestCall?.agent?.id || '',
    channels: channels.length > 0 ? channels : ['call'],
    contactId: contactId || latestThread?.contactId || latestCall?.lead?.id || '',
    emotionScoreTurns: Math.max(
      sortedThreads.reduce((sum, thread) => sum + Number(thread.emotionScoreTurns || 0), 0),
      rawCallMessages.filter((message) => message.emotionScores).length,
    ),
    hasEmotionScores:
      sortedThreads.some((thread) => thread.hasEmotionScores) ||
      rawCallMessages.some((message) => message.emotionScores),
    lastInboundAt: latestIso(
      ...sortedThreads.map((thread) => thread.lastInboundAt),
      rawInboundMessages[rawInboundMessages.length - 1]?.at,
    ),
    lastOutboundAt: latestIso(
      ...sortedThreads.map((thread) => thread.lastOutboundAt),
      rawOutboundMessages[rawOutboundMessages.length - 1]?.at,
    ),
    latestChannel: latestSourceIsCall
      ? latestCall
        ? recentCallChannel(latestCall)
        : 'call'
      : latestThread
        ? communicationThreadPrimaryChannel(latestThread)
        : channels[0] || 'call',
    latestMessagePreview: latestSourceIsCall
      ? rawCallMessages[rawCallMessages.length - 1]?.body || latestCall?.insight || ''
      : latestThread?.latestMessagePreview || '',
    legacyRecentCall: latestThread ? undefined : latestCall,
    messageCount: Math.max(sourceThreadMessageCount + fallbackCallMessageCount, rawCallMessages.length),
    participants: mergeCommunicationParticipants(
      ...sortedThreads.map((thread) => thread.participants),
      ...callParticipants,
    ),
    providerLinks: mergeCommunicationProviderLinks(
      ...sortedThreads.map((thread) => thread.providerLinks),
      ...callLinks,
    ),
    sourceThreadIds,
    status: latestThread?.status || latestCall?.outcome || latestCall?.phase || 'resolved',
    summary:
      (latestSourceIsCall ? latestCallSummary : communicationThreadPreviewText(latestThread)) ||
      latestCallSummary ||
      'No activity text captured',
    threadId: groupThreadId,
    updatedAt,
  }
}

function communicationThreadCallStats(
  thread: CommunicationThreadSummary,
  recentCallsById: Map<string, RecentCallSummary>,
) {
  const callIds = communicationThreadCallIds(thread)
  const calls = callIds
    .map((callId) => recentCallsById.get(callId))
    .filter((call): call is RecentCallSummary => Boolean(call))
  const agentLabels = calls
    .map((call) => callAgentTranscriptLabel(call))
    .filter(Boolean)
  return {
    agentLabel:
      thread.participants?.find((participant) => participant.role === 'agent')?.label ||
      agentLabels[0] ||
      thread.agentProfileId ||
      '',
    callCount: Math.max(calls.length, callIds.length),
    recorded: calls.some(canRequestCallAudio),
    scored:
      Boolean(thread.hasEmotionScores || thread.emotionScoreTurns) ||
      calls.some(transcriptHasEmotionScores),
    totalSeconds: calls.reduce((sum, call) => sum + callDurationSeconds(call), 0),
    turns: Math.max(
      Number(thread.messageCount || 0),
      calls.reduce((sum, call) => sum + (call.transcript?.length || 0), 0),
    ),
  }
}

function communicationThreadTimestamp(thread: CommunicationThreadSummary) {
  return (
    Date.parse(thread.updatedAt || '') ||
    Date.parse(thread.lastInboundAt || '') ||
    Date.parse(thread.lastOutboundAt || '') ||
    0
  )
}

function communicationThreadDateFilterValue(thread: CommunicationThreadSummary) {
  const timestamp = communicationThreadTimestamp(thread)
  if (!timestamp) return ''
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function positiveNumberFilter(value: string) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function compareCommunicationThreads(
  left: CommunicationThreadSummary,
  right: CommunicationThreadSummary,
  field: TranscriptSortField,
  direction: 'asc' | 'desc',
  leads: Lead[],
  recentCallsById: Map<string, RecentCallSummary>,
) {
  const multiplier = sortMultiplier(direction)
  const leftStats = communicationThreadCallStats(left, recentCallsById)
  const rightStats = communicationThreadCallStats(right, recentCallsById)
  const result = (() => {
    switch (field) {
      case 'contact':
        return textCompare(
          communicationThreadContactLabel(left, leads),
          communicationThreadContactLabel(right, leads),
        )
      case 'agent':
        return textCompare(leftStats.agentLabel, rightStats.agentLabel)
      case 'duration':
        return leftStats.totalSeconds - rightStats.totalSeconds
      case 'turns':
        return leftStats.turns - rightStats.turns
      case 'source':
        return textCompare(communicationThreadChannelSummary(left), communicationThreadChannelSummary(right))
      case 'date':
      default:
        return communicationThreadTimestamp(left) - communicationThreadTimestamp(right)
    }
  })()
  return result === 0
    ? textCompare(communicationThreadContactLabel(left, leads), communicationThreadContactLabel(right, leads))
    : result * multiplier
}

function contextSearchText(context?: ContextFields) {
  if (!context) return ''
  return [
    context.text,
    context.urls?.join(' '),
    context.urlSnapshots
      ?.map((snapshot) =>
        [
          snapshot.url,
          snapshot.title,
          snapshot.text,
          snapshot.status,
          snapshot.error,
          snapshot.contentType,
        ].join(' '),
      )
      .join(' '),
    context.files
      ?.map((file) =>
        [
          file.name,
          file.type,
          file.preview,
          file.extractedText,
          file.extractionStatus,
          file.extractionError,
        ].join(' '),
      )
      .join(' '),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

function sortMultiplier(direction: 'asc' | 'desc') {
  return direction === 'asc' ? 1 : -1
}

function textCompare(left: string, right: string) {
  return left.localeCompare(right, undefined, { sensitivity: 'base' })
}

interface LeadIdentityIndex {
  byId: Map<string, Lead>
  byPhone: Map<string, Lead>
  byEmail: Map<string, Lead>
  byNameCompany: Map<string, Lead>
}

interface AgentLibraryRecord {
  id: string
  name: string
  profile?: AgentConfigProfile
  active: boolean
  historical: boolean
  smartViewName: string
  voice: string
  configIds: string[]
  callCount: number
  transcriptTurns: number
  scoredTurns: number
  recordingCount: number
  phoneCalls: number
  playgroundCalls: number
  sourceMessageCount: number
  sourceThreadCount: number
  smsThreads: number
  emailThreads: number
  totalSeconds: number
  leads: string[]
  smartViews: string[]
  outcomes: string[]
  communicationThreads: CommunicationThreadSummary[]
  recentCalls: RecentCallSummary[]
  lastActivityMs: number
  updatedAtMs: number
  searchText: string
}

interface MutableAgentRecord extends Omit<
  AgentLibraryRecord,
  | 'communicationThreads'
  | 'configIds'
  | 'leads'
  | 'smartViews'
  | 'outcomes'
  | 'recentCalls'
  | 'searchText'
> {
  communicationThreads: CommunicationThreadSummary[]
  communicationThreadIds: Set<string>
  configIds: Set<string>
  leads: Set<string>
  smartViews: Set<string>
  outcomes: Map<string, number>
  recentCalls: RecentCallSummary[]
  searchParts: string[]
}

function agentActivityMs(record: AgentLibraryRecord) {
  return Math.max(record.lastActivityMs, record.updatedAtMs)
}

function compareAgentRecords(
  left: AgentLibraryRecord,
  right: AgentLibraryRecord,
  field: AgentSortField,
  direction: 'asc' | 'desc',
) {
  if (field === 'activity' && left.active !== right.active) return left.active ? -1 : 1
  const multiplier = sortMultiplier(direction)
  const result = (() => {
    switch (field) {
      case 'name':
        return textCompare(left.name, right.name)
      case 'calls':
        return left.callCount - right.callCount
      case 'turns':
        return (
          left.transcriptTurns + left.sourceMessageCount -
          (right.transcriptTurns + right.sourceMessageCount)
        )
      case 'recordings':
        return left.recordingCount - right.recordingCount
      case 'activity':
      default:
        return agentActivityMs(left) - agentActivityMs(right)
    }
  })()
  return result === 0 ? textCompare(left.name, right.name) : result * multiplier
}

function phoneDigits(value?: string) {
  return String(value || '').replace(/\D/g, '')
}

function libraryKey(value?: string) {
  return String(value || '').trim().toLowerCase()
}

function leadNameCompanyKey(name?: string, company?: string) {
  const normalizedName = normalizeKey(name || '')
  const normalizedCompany = normalizeKey(company || '')
  return normalizedName && normalizedCompany
    ? `${normalizedName}::${normalizedCompany}`
    : ''
}

function addLeadIndexValue(
  map: Map<string, Lead>,
  key: string,
  lead: Lead,
) {
  if (key && !map.has(key)) map.set(key, lead)
}

function createLeadIdentityIndex(leads: Lead[]): LeadIdentityIndex {
  const index: LeadIdentityIndex = {
    byId: new Map(),
    byPhone: new Map(),
    byEmail: new Map(),
    byNameCompany: new Map(),
  }

  leads.forEach((lead) => {
    addLeadIndexValue(index.byId, lead.id, lead)
    addLeadIndexValue(index.byPhone, phoneDigits(lead.phone), lead)
    addLeadIndexValue(index.byEmail, libraryKey(lead.email), lead)
    addLeadIndexValue(index.byNameCompany, leadNameCompanyKey(lead.name, lead.company), lead)
  })

  return index
}

function resolveLeadForCall(call: RecentCallSummary, index: LeadIdentityIndex) {
  const directLead = call.lead?.id ? index.byId.get(call.lead.id) : undefined
  if (directLead) return directLead

  const calledPhone = phoneDigits(call.lead?.called_phone)
  const filePhone = phoneDigits(call.lead?.phone_on_file)
  const phoneLead =
    (calledPhone ? index.byPhone.get(calledPhone) : undefined) ||
    (filePhone ? index.byPhone.get(filePhone) : undefined)
  if (phoneLead) return phoneLead

  const emailLead = index.byEmail.get(libraryKey(call.lead?.email_on_file))
  if (emailLead) return emailLead

  return index.byNameCompany.get(
    leadNameCompanyKey(call.lead?.name, recentBusinessName(call)),
  )
}

function communicationThreadContactIds(thread?: CommunicationThreadSummary) {
  return Array.from(
    new Set(
      [
        thread?.contactId,
        ...(thread?.participants || []).map((participant) => participant.contactId),
      ]
        .map((contactId) => String(contactId || '').trim())
        .filter(Boolean),
    ),
  )
}

function communicationThreadContactIdForLeadIds(
  thread: CommunicationThreadSummary | undefined,
  leadIds: Set<string>,
) {
  return communicationThreadContactIds(thread).find((contactId) => leadIds.has(contactId)) || ''
}

function recentCallContactIdForLeadIds(
  call: RecentCallSummary,
  index: LeadIdentityIndex,
  leadIds: Set<string>,
  fallbackThread?: CommunicationThreadSummary,
) {
  const callLeadId = String(call.lead?.id || '')
  if (callLeadId) {
    return leadIds.has(callLeadId)
      ? callLeadId
      : communicationThreadContactIdForLeadIds(fallbackThread, leadIds)
  }

  const resolvedLead = resolveLeadForCall(call, index)
  if (resolvedLead?.id && leadIds.has(resolvedLead.id)) return resolvedLead.id
  return communicationThreadContactIdForLeadIds(fallbackThread, leadIds)
}

function addAgentKey(map: Map<string, string>, value: unknown, recordId: string) {
  const key = libraryKey(String(value || ''))
  if (key && !map.has(key)) map.set(key, recordId)
}

function profileAgentKeys(profile: AgentConfigProfile) {
  return [
    profile.id,
    profile.name,
    profile.config.agentProfileId,
    profile.config.agentProfileName,
    profile.config.speakConfigId,
    profile.config.humeConfigId,
    profile.config.inworldConfigId,
  ]
}

function callAgentKeys(call: RecentCallSummary) {
  return [
    call.agent?.id,
    call.agent?.name,
    call.agent?.speakConfigId,
    call.agent?.humeConfigId,
    call.agent?.inworldConfigId,
  ]
}

function communicationThreadAgentKeys(thread: CommunicationThreadSummary) {
  return [
    thread.agentProfileId,
    ...(thread.participants || [])
      .filter((participant) => participant.role === 'agent')
      .flatMap((participant) => [
        participant.agentProfileId,
        participant.label,
      ]),
  ]
}

function addConfigId(target: Set<string>, value?: string) {
  const next = String(value || '').trim()
  if (next) target.add(next)
}

function communicationThreadAgentLabel(thread: CommunicationThreadSummary) {
  return (
    thread.participants?.find((participant) => participant.role === 'agent')?.label ||
    thread.agentProfileId ||
    'Unassigned agent'
  )
}

function agentRecordSearchText(record: AgentLibraryRecord) {
  return [
    record.name,
    record.smartViewName,
    record.voice,
    ...record.configIds,
    ...record.leads,
    ...record.smartViews,
    ...record.outcomes,
    ...record.recentCalls.flatMap((call) => [
      callAgentTranscriptLabel(call),
      callLeadTranscriptLabel(call),
      recentBusinessName(call),
      call.outcome,
      call.insight,
    ]),
    ...record.communicationThreads.flatMap((thread) => [
      communicationThreadAgentLabel(thread),
      communicationThreadContactLabel(thread, []),
      communicationThreadChannelSummary(thread),
      thread.status,
      thread.summary,
      thread.latestMessagePreview,
      thread.channels?.join(' '),
    ]),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

export function LibraryWorkspace() {
  const basePath = apiBase().replace(/\/api$/, '')
  const smartCsvInputRef = useRef<HTMLInputElement | null>(null)
  const { appearance, setAppearance } = useAppearance()
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false)
  const [leads, setLeads] = useState<Lead[]>([])
  const [smartViews, setSmartViews] = useState<SmartView[]>([])
  const [profiles, setProfiles] = useState<AgentConfigProfile[]>([])
  const [activeAgentProfileId, setActiveAgentProfileId] = useState('')
  const [activeSmartViewId, setActiveSmartViewId] = useState('')
  const [activeContactSourceKey, setActiveContactSourceKey] = useState('personal-phone')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [recentCalls, setRecentCalls] = useState<RecentCallSummary[]>([])
  const [communicationThreads, setCommunicationThreads] = useState<
    CommunicationThreadSummary[]
  >([])
  const [libraryMode, setLibraryMode] = useState<LibraryMode>('leads')
  const [query, setQuery] = useState('')
  const [agentQuery, setAgentQuery] = useState('')
  const [agentSourceFilter, setAgentSourceFilter] =
    useState<AgentSourceFilter>('all')
  const [agentSortField, setAgentSortField] = useState<AgentSortField>('activity')
  const [agentSortDirection, setAgentSortDirection] = useState<'asc' | 'desc'>('desc')
  const [expandedAgentId, setExpandedAgentId] = useState('')
  const [expandedAgentTranscriptId, setExpandedAgentTranscriptId] = useState('')
  const [agentPromptDrafts, setAgentPromptDrafts] = useState<Record<string, string>>({})
  const [agentNameDrafts, setAgentNameDrafts] = useState<Record<string, string>>({})
  const [selectedAgentProfileIds, setSelectedAgentProfileIds] = useState<Set<string>>(
    new Set(),
  )
  const [transcriptQuery, setTranscriptQuery] = useState('')
  const [transcriptAgentFilter, setTranscriptAgentFilter] = useState('')
  const [transcriptContactFilter, setTranscriptContactFilter] = useState('')
  const [transcriptDateFilter, setTranscriptDateFilter] = useState('')
  const [transcriptMinDurationFilter, setTranscriptMinDurationFilter] = useState('')
  const [transcriptMinTurnsFilter, setTranscriptMinTurnsFilter] = useState('')
  const [transcriptSourceFilter, setTranscriptSourceFilter] =
    useState<TranscriptSourceFilter>('all')
  const [transcriptSortField, setTranscriptSortField] =
    useState<TranscriptSortField>('date')
  const [transcriptSortDirection, setTranscriptSortDirection] =
    useState<'asc' | 'desc'>('desc')
  const [expandedThreadId, setExpandedThreadId] = useState('')
  const [selectedThreadId, setSelectedThreadId] = useState('')
  const [communicationThreadMessages, setCommunicationThreadMessages] = useState<
    Record<string, CommunicationMessage[]>
  >({})
  const [loadingCommunicationThreadId, setLoadingCommunicationThreadId] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [stateFilter, setStateFilter] = useState('all')
  const [tagFilter, setTagFilter] = useState('all')
  const [sortField, setSortField] = useState<SortField>('company')
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc')
  const [smartViewName, setSmartViewName] = useState('')
  const [personalPhoneSyncing, setPersonalPhoneSyncing] = useState(false)
  const [calltoolsSyncing, setCalltoolsSyncing] = useState(false)
  const [calltoolsCampaigns, setCalltoolsCampaigns] = useState<CallToolsCampaignOption[]>([])
  const [selectedCalltoolsCampaignId, setSelectedCalltoolsCampaignId] = useState('')
  const columns = defaultLibraryColumns
  const [leadOptionsOpen, setLeadOptionsOpen] = useState(false)
  const [contactRenderLimit, setContactRenderLimit] = useState(contactLibraryRenderBatchSize)
  const [expandedLeadContextId, setExpandedLeadContextId] = useState('')
  const leadOptionsRef = useRef<HTMLDivElement | null>(null)
  const [, setNotice] = useState('Loading library...')

  const dismissLeadOptions = useCallback(() => {
    setLeadOptionsOpen(false)
  }, [])

  useDismissibleLayer({
    enabled: leadOptionsOpen,
    onDismiss: dismissLeadOptions,
    refs: [leadOptionsRef],
  })

  const activeSmartView = smartViews.find((view) => view.id === activeSmartViewId) || null
  const contactSourceOptions = useMemo<ContactSourceOption[]>(
    () => buildContactSourceOptionsFromLeads(leads),
    [leads],
  )
  const resolvedContactSourceKey = resolveContactSourceOptionKey(
    contactSourceOptions,
    activeContactSourceKey,
  )
  const activeContactSource =
    contactSourceOptions.find((option) => option.key === resolvedContactSourceKey) ||
    contactSourceOptions[0]
  const contactSourceLeads = useMemo(
    () =>
      leads.filter((lead) => leadMatchesContactSourceKey(lead, resolvedContactSourceKey)),
    [resolvedContactSourceKey, leads],
  )
  const contactSourceLeadIds = useMemo(
    () => new Set(contactSourceLeads.map((lead) => lead.id)),
    [contactSourceLeads],
  )
  const contactSourceLeadIdentityIndex = useMemo(
    () => createLeadIdentityIndex(contactSourceLeads),
    [contactSourceLeads],
  )
  const selectedCalltoolsCampaign =
    calltoolsCampaigns.find((campaign) => campaign.id === selectedCalltoolsCampaignId) ||
    calltoolsCampaigns[0] ||
    null
  const states = useMemo(
    () =>
      Array.from(new Set(contactSourceLeads.map((lead) => lead.state).filter(Boolean))).sort(),
    [contactSourceLeads],
  )
  const tags = useMemo(
    () =>
      Array.from(
        new Set(
          contactSourceLeads
            .flatMap((lead) => lead.tags)
            .map((tag) => tag.trim())
            .filter(Boolean),
        ),
      ).sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' })),
    [contactSourceLeads],
  )
  const selectLibraryMode = useCallback(
    (nextMode: LibraryMode) => {
      if (nextMode === libraryMode) return
      withSpeakViewTransition(() => setLibraryMode(nextMode), 'library-mode')
    },
    [libraryMode],
  )
  const smartViewsById = useMemo(
    () => new Map(smartViews.map((view) => [view.id, view])),
    [smartViews],
  )
  const smartViewLeadIds = useMemo(
    () => new Set(activeSmartView?.leadIds || []),
    [activeSmartView],
  )
  const leadIdentityIndex = useMemo(
    () => createLeadIdentityIndex(leads),
    [leads],
  )
  const smartViewNamesByLeadId = useMemo(() => {
    const next = new Map<string, Set<string>>()
    smartViews.forEach((view) => {
      view.leadIds.forEach((leadId) => {
        const names = next.get(leadId) || new Set<string>()
        names.add(view.name)
        next.set(leadId, names)
      })
    })
    return next
  }, [smartViews])
  const calltimeByLeadId = useMemo(() => {
    const totals = new Map<string, number>()
    recentCalls.forEach((call) => {
      const lead = resolveLeadForCall(call, contactSourceLeadIdentityIndex)
      if (!lead) return
      totals.set(lead.id, (totals.get(lead.id) || 0) + callDurationSeconds(call))
    })
    return totals
  }, [contactSourceLeadIdentityIndex, recentCalls])
  const recentCallsById = useMemo(
    () => new Map(recentCalls.map((call) => [call.callControlId, call])),
    [recentCalls],
  )
  const communicationThreadsByCallId = useMemo(() => {
    const next = new Map<string, CommunicationThreadSummary>()
    communicationThreads.forEach((thread) => {
      thread.providerLinks?.forEach((link) => {
        if (link.kind === 'call_control' && link.id) next.set(link.id, thread)
      })
    })
    return next
  }, [communicationThreads])
  const activityRecentCalls = useMemo(
    () =>
      recentCalls.flatMap((call) => {
        const fallbackThread = communicationThreadsByCallId.get(call.callControlId)
        const contactId = recentCallContactIdForLeadIds(
          call,
          contactSourceLeadIdentityIndex,
          contactSourceLeadIds,
          fallbackThread,
        )
        if (!contactId) return []
        return [
          {
            ...call,
            lead: {
              ...(call.lead || {}),
              id: contactId,
            },
          },
        ]
      }),
    [
      communicationThreadsByCallId,
      contactSourceLeadIds,
      contactSourceLeadIdentityIndex,
      recentCalls,
    ],
  )
  const activityThreads = useMemo(
    () => {
      const groups = new Map<
        string,
        {
          calls: RecentCallSummary[]
          contactId: string
          threads: CommunicationThreadSummary[]
        }
      >()

      function ensureGroup(key: string, contactId = '') {
        const existing = groups.get(key)
        if (existing) {
          if (contactId && !existing.contactId) existing.contactId = contactId
          return existing
        }
        const next = { calls: [], contactId, threads: [] }
        groups.set(key, next)
        return next
      }

      communicationThreads.forEach((thread) => {
        const contactId = communicationThreadContactIdForLeadIds(thread, contactSourceLeadIds)
        if (!contactId) return
        const sourceThread =
          thread.contactId === contactId
            ? thread
            : {
                ...thread,
                contactId,
              }
        const group = ensureGroup(activityGroupKeyForThread(sourceThread), contactId)
        group.threads.push(sourceThread)
      })

      activityRecentCalls.forEach((call) => {
        const fallbackThread = communicationThreadsByCallId.get(call.callControlId)
        const fallbackContactId = communicationThreadContactIdForLeadIds(
          fallbackThread,
          contactSourceLeadIds,
        )
        const sourceFallbackThread =
          fallbackThread && fallbackContactId
            ? fallbackThread.contactId === fallbackContactId
              ? fallbackThread
              : {
                  ...fallbackThread,
                  contactId: fallbackContactId,
                }
            : undefined
        const group = ensureGroup(
          activityGroupKeyForRecentCall(call, sourceFallbackThread),
          call.lead?.id || fallbackContactId || '',
        )
        group.calls.push(call)
      })

      return Array.from(groups.values()).map(communicationThreadForActivityGroup)
    },
    [
      activityRecentCalls,
      communicationThreads,
      communicationThreadsByCallId,
      contactSourceLeadIds,
    ],
  )
  const contactActivityThreadByLeadId = useMemo(() => {
    const next = new Map<string, CommunicationThreadSummary>()
    activityThreads.forEach((thread) => {
      if (thread.contactId && !next.has(thread.contactId)) {
        next.set(thread.contactId, thread)
      }
    })
    return next
  }, [activityThreads])
  const selectedThread = useMemo(
    () =>
      selectedThreadId
        ? activityThreads.find((thread) =>
            communicationThreadMatchesId(thread, selectedThreadId),
          )
        : undefined,
    [activityThreads, selectedThreadId],
  )
  const sourceLeads = useMemo(
    () =>
      activeSmartViewId
        ? contactSourceLeads.filter((lead) => smartViewLeadIds.has(lead.id))
        : contactSourceLeads,
    [activeSmartViewId, contactSourceLeads, smartViewLeadIds],
  )
  const smartViewCounts = useMemo(() => {
    const sourceLeadIds = new Set(contactSourceLeads.map((lead) => lead.id))
    const next = new Map<string, number>()
    smartViews.forEach((view) => {
      next.set(
        view.id,
        view.leadIds.filter((leadId) => sourceLeadIds.has(leadId)).length,
      )
    })
    return next
  }, [contactSourceLeads, smartViews])
  const filteredLeads = useMemo(
    () =>
      filterAndSortLeads(sourceLeads, {
        query,
        scoreFilter: 'all',
        sortDirection,
        sortField,
        stateFilter,
        statusFilter,
        tagFilter,
        sortValue: (lead, field) =>
          field === 'calltime'
              ? calltimeByLeadId.get(lead.id) || 0
              : undefined,
      }),
    [
      calltimeByLeadId,
      query,
      sortDirection,
      sortField,
      sourceLeads,
      stateFilter,
      statusFilter,
      tagFilter,
    ],
  )
  const renderedContactLeads = useMemo(
    () => filteredLeads.slice(0, contactRenderLimit),
    [contactRenderLimit, filteredLeads],
  )
  const remainingContactLeadCount = Math.max(
    0,
    filteredLeads.length - renderedContactLeads.length,
  )
  const visibleColumns = columns.filter((column) => column.visible)

  useEffect(() => {
    const resetTimer = window.setTimeout(() => {
      setContactRenderLimit(contactLibraryRenderBatchSize)
    }, 0)
    return () => window.clearTimeout(resetTimer)
  }, [
    activeSmartViewId,
    query,
    resolvedContactSourceKey,
    sortDirection,
    sortField,
    stateFilter,
    statusFilter,
    tagFilter,
  ])
  const allVisibleSelected =
    filteredLeads.length > 0 && filteredLeads.every((lead) => selectedIds.has(lead.id))
  const someVisibleSelected =
    filteredLeads.some((lead) => selectedIds.has(lead.id)) && !allVisibleSelected
  const transcriptRecords = useMemo(
    () =>
      [...activityThreads]
        .filter((thread) => {
          const channels = new Set(thread.channels || [])
          const stats = communicationThreadCallStats(thread, recentCallsById)
          if (transcriptSourceFilter === 'call') return channels.has('call')
          if (transcriptSourceFilter === 'sms') return channels.has('sms')
          if (transcriptSourceFilter === 'email') return channels.has('email')
          if (transcriptSourceFilter === 'browser_test') return channels.has('browser_test')
          if (transcriptSourceFilter === 'recorded') return stats.recorded
          if (transcriptSourceFilter === 'scored') return stats.scored
          if (transcriptSourceFilter === 'unresolved') {
            return thread.status === 'unresolved_attribution' || !thread.contactId
          }
          return true
        })
        .filter((thread) => {
          const normalizedQuery = transcriptQuery.trim().toLowerCase()
          return (
            !normalizedQuery ||
            communicationThreadSearchText(thread, leads).includes(normalizedQuery)
          )
        })
        .filter((thread) => {
          const stats = communicationThreadCallStats(thread, recentCallsById)
          const contactFilter = transcriptContactFilter.trim().toLowerCase()
          const agentFilter = transcriptAgentFilter.trim().toLowerCase()
          const minDurationSeconds = positiveNumberFilter(transcriptMinDurationFilter) * 60
          const minTurns = positiveNumberFilter(transcriptMinTurnsFilter)
          if (
            contactFilter &&
            !communicationThreadContactLabel(thread, leads).toLowerCase().includes(contactFilter)
          ) {
            return false
          }
          if (
            agentFilter &&
            ![stats.agentLabel, thread.agentProfileId]
              .filter(Boolean)
              .join(' ')
              .toLowerCase()
              .includes(agentFilter)
          ) {
            return false
          }
          if (
            transcriptDateFilter &&
            communicationThreadDateFilterValue(thread) !== transcriptDateFilter
          ) {
            return false
          }
          if (minDurationSeconds > 0 && stats.totalSeconds < minDurationSeconds) {
            return false
          }
          if (minTurns > 0 && stats.turns < minTurns) {
            return false
          }
          return true
        })
        .sort((left, right) =>
          compareCommunicationThreads(
            left,
            right,
            transcriptSortField,
            transcriptSortDirection,
            leads,
            recentCallsById,
          ),
        ),
    [
      activityThreads,
      leads,
      recentCallsById,
      transcriptAgentFilter,
      transcriptContactFilter,
      transcriptDateFilter,
      transcriptMinDurationFilter,
      transcriptMinTurnsFilter,
      transcriptQuery,
      transcriptSortDirection,
      transcriptSortField,
      transcriptSourceFilter,
    ],
  )
  const transcriptStats = useMemo(
    () => ({
      all: activityThreads.length,
      phone: activityThreads.filter((thread) => thread.channels?.includes('call')).length,
      sms: activityThreads.filter((thread) => thread.channels?.includes('sms')).length,
      email: activityThreads.filter((thread) => thread.channels?.includes('email')).length,
      playground: activityThreads.filter((thread) =>
        thread.channels?.includes('browser_test'),
      ).length,
      recorded: activityThreads.filter((thread) =>
        communicationThreadCallStats(thread, recentCallsById).recorded,
      ).length,
      scored: activityThreads.filter((thread) =>
        communicationThreadCallStats(thread, recentCallsById).scored,
      ).length,
      unresolved: activityThreads.filter(
        (thread) => thread.status === 'unresolved_attribution' || !thread.contactId,
      ).length,
      threads: activityThreads.length,
      linked: activityRecentCalls.filter((call) => {
        const fallbackThread = communicationThreadsByCallId.get(call.callControlId)
        return Boolean(communicationThreadContactIdForLeadIds(fallbackThread, contactSourceLeadIds))
      }).length,
    }),
    [
      activityRecentCalls,
      activityThreads,
      communicationThreadsByCallId,
      contactSourceLeadIds,
      recentCallsById,
    ],
  )
  const agentRecords = useMemo<AgentLibraryRecord[]>(() => {
    const records = new Map<string, MutableAgentRecord>()
    const agentKeyToRecordId = new Map<string, string>()

    function createRecord(profile?: AgentConfigProfile, historicalName = '') {
      const profileSmartView = profile?.config.smartViewId
        ? smartViewsById.get(profile.config.smartViewId)
        : undefined
      const id = profile?.id || `historical:${libraryKey(historicalName) || records.size}`
      const name = profile?.name || historicalName || 'Unassigned agent'
      const updatedAtMs = Date.parse(profile?.updatedAt || '') || 0
      const record: MutableAgentRecord = {
        id,
        name,
        profile,
        active: Boolean(profile && profile.id === activeAgentProfileId),
        historical: !profile,
        smartViewName: profileSmartView?.name || '',
        voice: profile?.config.humeVoiceName || profile?.config.voice || '',
        configIds: new Set<string>(),
        callCount: 0,
        transcriptTurns: 0,
        scoredTurns: 0,
        recordingCount: 0,
        phoneCalls: 0,
        playgroundCalls: 0,
        sourceMessageCount: 0,
        sourceThreadCount: 0,
        smsThreads: 0,
        emailThreads: 0,
        totalSeconds: 0,
        leads: new Set<string>(),
        smartViews: new Set<string>(),
        outcomes: new Map<string, number>(),
        communicationThreads: [],
        communicationThreadIds: new Set<string>(),
        recentCalls: [],
        lastActivityMs: 0,
        updatedAtMs,
        searchParts: [
          name,
          profileSmartView?.name || '',
          profile?.config.agentProfileName || '',
          profile?.config.instructions || '',
          contextSearchText(profile?.context),
        ],
      }

      addConfigId(record.configIds, profile?.config.speakConfigId)
      addConfigId(record.configIds, profile?.config.humeConfigId)
      addConfigId(record.configIds, profile?.config.inworldConfigId)
      addConfigId(record.configIds, profile?.config.agentProfileId)
      records.set(id, record)
      profileAgentKeys(profile || ({
        id,
        name,
        updatedAt: '',
        config: {},
        testVariables: {},
      } as AgentConfigProfile)).forEach((key) => addAgentKey(agentKeyToRecordId, key, id))
      return record
    }

    profiles.forEach((profile) => {
      createRecord(profile)
    })

    recentCalls.forEach((call) => {
      const existingRecordId = callAgentKeys(call)
        .map((key) => agentKeyToRecordId.get(libraryKey(String(key || ''))))
        .find(Boolean)
      let record = existingRecordId ? records.get(existingRecordId) : undefined

      if (!record) {
        const fallbackKey =
          call.agent?.id ||
          call.agent?.speakConfigId ||
          call.agent?.humeConfigId ||
          call.agent?.inworldConfigId ||
          call.agent?.name ||
          call.callControlId
        const historicalId = `historical:${libraryKey(fallbackKey)}`
        record = records.get(historicalId)
        if (!record) {
          record = createRecord(undefined, callAgentTranscriptLabel(call) || call.agent?.name || 'Unassigned agent')
          records.delete(record.id)
          record.id = historicalId
          records.set(record.id, record)
        }
        if (!record) return
        const recordId = record.id
        callAgentKeys(call).forEach((key) => addAgentKey(agentKeyToRecordId, key, recordId))
      }
      if (!record) return

      const turns = (call.transcript || []) as TranscriptEntry[]
      const scoredTurns = turns.filter((entry) => entry.emotionScores).length
      const callTimeMs = Date.parse(call.createdAt || call.updatedAt || '') || 0
      const outcome = recentOutcomeLabel(call)
      const lead = resolveLeadForCall(call, leadIdentityIndex)
      const leadLabel =
        lead?.company ||
        lead?.name ||
        callLeadTranscriptLabel(call) ||
        recentBusinessName(call)

      record.callCount += 1
      record.transcriptTurns += turns.length
      record.scoredTurns += scoredTurns
      record.recordingCount += canRequestCallAudio(call) ? 1 : 0
      record.phoneCalls += transcriptSource(call) === 'phone' ? 1 : 0
      record.playgroundCalls += transcriptSource(call) === 'playground' ? 1 : 0
      record.totalSeconds += callDurationSeconds(call)
      record.lastActivityMs = Math.max(record.lastActivityMs, callTimeMs)
      record.outcomes.set(outcome, (record.outcomes.get(outcome) || 0) + 1)
      if (leadLabel && leadLabel !== 'Unknown business') record.leads.add(leadLabel)
      if (lead) {
        smartViewNamesByLeadId.get(lead.id)?.forEach((name) => record.smartViews.add(name))
      }
      addConfigId(record.configIds, call.agent?.speakConfigId)
      addConfigId(record.configIds, call.agent?.humeConfigId)
      addConfigId(record.configIds, call.agent?.inworldConfigId)
      addConfigId(record.configIds, call.agent?.id)
      record.recentCalls.push(call)
      record.searchParts.push(
        outcome,
        leadLabel,
        call.insight || '',
        callAgentTranscriptLabel(call),
      )
    })

    communicationThreads.forEach((thread) => {
      const agentKeys = communicationThreadAgentKeys(thread)
      const existingRecordId = agentKeys
        .map((key) => agentKeyToRecordId.get(libraryKey(String(key || ''))))
        .find(Boolean)
      let record = existingRecordId ? records.get(existingRecordId) : undefined

      if (!record) {
        const fallbackKey =
          thread.agentProfileId ||
          communicationThreadAgentLabel(thread) ||
          thread.threadId
        const historicalId = `historical:${libraryKey(fallbackKey)}`
        record = records.get(historicalId)
        if (!record) {
          record = createRecord(undefined, communicationThreadAgentLabel(thread))
          records.delete(record.id)
          record.id = historicalId
          records.set(record.id, record)
        }
        if (!record) return
        const recordId = record.id
        agentKeys.forEach((key) => addAgentKey(agentKeyToRecordId, key, recordId))
      }
      if (!record || record.communicationThreadIds.has(thread.threadId)) return

      const channels = new Set(thread.channels || [])
      const sourceMs = communicationThreadTimestamp(thread)
      const contactLabel = communicationThreadContactLabel(thread, leads)
      record.communicationThreadIds.add(thread.threadId)
      record.communicationThreads.push(thread)
      record.sourceThreadCount += 1
      record.sourceMessageCount += Number(thread.messageCount || 0)
      record.scoredTurns += Number(thread.emotionScoreTurns || 0)
      record.lastActivityMs = Math.max(record.lastActivityMs, sourceMs)
      if (channels.has('sms')) record.smsThreads += 1
      if (channels.has('email')) record.emailThreads += 1
      if (contactLabel && contactLabel !== 'Unknown business') record.leads.add(contactLabel)
      addConfigId(record.configIds, thread.agentProfileId)
      record.searchParts.push(
        communicationThreadChannelSummary(thread),
        contactLabel,
        thread.status || '',
        thread.summary || '',
        thread.latestMessagePreview || '',
        (thread.channels || []).join(' '),
      )
    })

    return Array.from(records.values())
      .map((record) => {
        const outcomes = Array.from(record.outcomes.entries())
          .sort((left, right) => right[1] - left[1])
          .map(([label, count]) => `${label}: ${count}`)
        const recentAgentCalls = [...record.recentCalls]
          .sort(
            (left, right) =>
              (Date.parse(right.createdAt || right.updatedAt || '') || 0) -
              (Date.parse(left.createdAt || left.updatedAt || '') || 0),
          )
          .slice(0, 5)
        const recentAgentThreads = [...record.communicationThreads]
          .sort(
            (left, right) =>
              communicationThreadTimestamp(right) - communicationThreadTimestamp(left),
          )
          .slice(0, 8)
        const finalized: AgentLibraryRecord = {
          id: record.id,
          name: record.name,
          profile: record.profile,
          active: record.active,
          historical: record.historical,
          smartViewName: record.smartViewName,
          voice: record.voice,
          configIds: Array.from(record.configIds),
          callCount: record.callCount,
          transcriptTurns: record.transcriptTurns,
          scoredTurns: record.scoredTurns,
          recordingCount: record.recordingCount,
          phoneCalls: record.phoneCalls,
          playgroundCalls: record.playgroundCalls,
          sourceMessageCount: record.sourceMessageCount,
          sourceThreadCount: record.sourceThreadCount,
          smsThreads: record.smsThreads,
          emailThreads: record.emailThreads,
          totalSeconds: record.totalSeconds,
          leads: Array.from(record.leads).slice(0, 8),
          smartViews: Array.from(record.smartViews).slice(0, 8),
          outcomes,
          communicationThreads: recentAgentThreads,
          recentCalls: recentAgentCalls,
          lastActivityMs: record.lastActivityMs,
          updatedAtMs: record.updatedAtMs,
          searchText: '',
        }
        return {
          ...finalized,
          searchText: [
            agentRecordSearchText(finalized),
            ...record.searchParts,
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase(),
        }
      })
      .sort((left, right) => {
        if (left.active !== right.active) return left.active ? -1 : 1
        return (
          Math.max(right.lastActivityMs, right.updatedAtMs) -
          Math.max(left.lastActivityMs, left.updatedAtMs)
        )
      })
  }, [
    activeAgentProfileId,
    communicationThreads,
    leads,
    leadIdentityIndex,
    profiles,
    recentCalls,
    smartViewNamesByLeadId,
    smartViewsById,
  ])
  const filteredAgentRecords = useMemo(() => {
    const normalizedQuery = agentQuery.trim().toLowerCase()
    return agentRecords
      .filter((record) => {
        if (agentSourceFilter === 'active') return record.active
        if (agentSourceFilter === 'smart-view') {
          return Boolean(record.smartViewName || record.smartViews.length)
        }
        if (agentSourceFilter === 'used') {
          return record.callCount > 0 || record.sourceThreadCount > 0
        }
        if (agentSourceFilter === 'recorded') return record.recordingCount > 0
        if (agentSourceFilter === 'scored') return record.scoredTurns > 0
        return true
      })
      .filter((record) => !normalizedQuery || record.searchText.includes(normalizedQuery))
      .sort((left, right) =>
        compareAgentRecords(left, right, agentSortField, agentSortDirection),
      )
  }, [agentQuery, agentRecords, agentSortDirection, agentSortField, agentSourceFilter])
  const profileAgentRecords = filteredAgentRecords.filter((record) => record.profile)
  const selectedVisibleAgentProfileCount = profileAgentRecords.filter((record) =>
    selectedAgentProfileIds.has(record.profile?.id || ''),
  ).length
  const allVisibleAgentProfilesSelected =
    profileAgentRecords.length > 0 &&
    selectedVisibleAgentProfileCount === profileAgentRecords.length
  const someVisibleAgentProfilesSelected =
    selectedVisibleAgentProfileCount > 0 && !allVisibleAgentProfilesSelected
  const agentProfileSelectionState = allVisibleAgentProfilesSelected
    ? 'selected'
    : someVisibleAgentProfilesSelected
      ? 'mixed'
      : ''
  const agentStats = useMemo(
    () => ({
      all: agentRecords.length,
      active: agentRecords.filter((record) => record.active).length,
      smartView: agentRecords.filter(
        (record) => record.smartViewName || record.smartViews.length,
      ).length,
      used: agentRecords.filter((record) => record.callCount > 0).length,
      recorded: agentRecords.filter((record) => record.recordingCount > 0).length,
      scored: agentRecords.filter((record) => record.scoredTurns > 0).length,
    }),
    [agentRecords],
  )

  useEffect(() => {
    function loadHashView() {
      const params = new URLSearchParams(window.location.hash.slice(1))
      const viewId = params.get('view')
      const agentId = params.get('agent')
      const transcriptId = params.get('transcript')
      const threadId = params.get('thread')
      if (viewId) setActiveSmartViewId(viewId)
      if (agentId) {
        setLibraryMode('agents')
        setExpandedAgentId(agentId)
      }
      if (transcriptId) {
        setLibraryMode('transcripts')
        setTranscriptQuery(transcriptId)
      }
      if (threadId) {
        setLibraryMode('transcripts')
        setSelectedThreadId(threadId)
        setExpandedThreadId(threadId)
        setTranscriptQuery(threadId)
        setTranscriptSourceFilter('all')
        setTranscriptContactFilter('')
        setTranscriptAgentFilter('')
        setTranscriptDateFilter('')
        setTranscriptMinDurationFilter('')
        setTranscriptMinTurnsFilter('')
      }
    }

    loadHashView()
    window.addEventListener('hashchange', loadHashView)
    return () => window.removeEventListener('hashchange', loadHashView)
  }, [])

  const refreshLibrary = useCallback(async (): Promise<RecentCallSummary[]> => {
    try {
      const [
        workspaceResponse,
        callsResponse,
        threadsResponse,
        calltoolsOptionsResponse,
      ] = await Promise.all([
        fetch(apiUrl('/workspace')),
        fetch(apiUrl('/calls/recent?limit=500')),
        fetch(apiUrl('/communication-threads?limit=500')),
        fetch(apiUrl('/calltools/options')).catch(() => null),
      ])
      const workspacePayload = (await workspaceResponse.json().catch(() => ({}))) as WorkspacePayload
      const callsPayload = (await callsResponse.json().catch(() => ({}))) as RecentCallsPayload
      const threadsPayload = (await threadsResponse.json().catch(
        () => ({}),
      )) as CommunicationThreadsPayload
      const calltoolsOptionsPayload =
        calltoolsOptionsResponse && calltoolsOptionsResponse.ok
          ? ((await calltoolsOptionsResponse.json().catch(() => ({}))) as CallToolsOptionsPayload)
          : {}
      if (!workspaceResponse.ok) throw new Error('Library workspace failed')
      setLeads(workspacePayload.leads || [])
      setSmartViews(workspacePayload.smartViews || [])
      setProfiles(workspacePayload.profiles || [])
      setActiveAgentProfileId(workspacePayload.activeProfileId || '')
      const campaigns = calltoolsOptionsPayload.campaigns || []
      setCalltoolsCampaigns(campaigns)
      setSelectedCalltoolsCampaignId((current) =>
        campaigns.some((campaign) => campaign.id === current)
          ? current
          : campaigns[0]?.id || '',
      )
      const calls = callsPayload.calls || []
      setRecentCalls(calls)
      setCommunicationThreads(threadsPayload.threads || [])
      setNotice('Library ready')
      return calls
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Library failed')
      return []
    }
  }, [])

  const reloadCommunicationThreadMessages = useCallback(
    async (threadIds: string[], loadingThreadId = '') => {
      const uniqueThreadIds = Array.from(new Set(threadIds.filter(Boolean)))
      if (uniqueThreadIds.length === 0) return
      const ownerThreadId = loadingThreadId || uniqueThreadIds[0]
      setLoadingCommunicationThreadId(ownerThreadId)
      try {
        const loadedMessages = await Promise.all(
          uniqueThreadIds.map(async (threadId) => {
            const response = await fetch(
              apiUrl(`/communication-threads/${encodeURIComponent(threadId)}/messages?limit=500`),
            )
            const payload = (await response.json().catch(() => ({}))) as CommunicationMessagesPayload
            if (!response.ok) throw new Error('Thread messages failed')
            return [threadId, payload.messages || []] as const
          }),
        )
        setCommunicationThreadMessages((current) => {
          const next = { ...current }
          loadedMessages.forEach(([threadId, messages]) => {
            next[threadId] = messages
          })
          return next
        })
      } catch (error) {
        setNotice(error instanceof Error ? error.message : 'Thread messages failed')
      } finally {
        setLoadingCommunicationThreadId((current) =>
          current === ownerThreadId ? '' : current,
        )
      }
    },
    [],
  )

  useEffect(() => {
    const expandedActivityThread = activityThreads.find(
      (thread) => thread.threadId === expandedThreadId,
    )
    const sourceThreadIds = communicationSourceThreadIds(expandedActivityThread)
    const missingThreadIds = sourceThreadIds.filter(
      (threadId) => !communicationThreadMessages[threadId],
    )
    if (
      !expandedThreadId ||
      missingThreadIds.length === 0 ||
      (expandedActivityThread?.legacyRecentCall && sourceThreadIds.length === 0)
    ) {
      return
    }

    let cancelled = false

    async function loadExpandedThreadMessages() {
      setLoadingCommunicationThreadId(expandedThreadId)
      try {
        const loadedMessages = await Promise.all(
          missingThreadIds.map(async (threadId) => {
            const response = await fetch(
              apiUrl(`/communication-threads/${encodeURIComponent(threadId)}/messages?limit=500`),
            )
            const payload = (await response.json().catch(() => ({}))) as CommunicationMessagesPayload
            if (!response.ok) throw new Error('Thread messages failed')
            return [threadId, payload.messages || []] as const
          }),
        )
        if (cancelled) return
        setCommunicationThreadMessages((current) => {
          const next = { ...current }
          loadedMessages.forEach(([threadId, messages]) => {
            next[threadId] = messages
          })
          return next
        })
      } catch (error) {
        if (cancelled) return
        setNotice(error instanceof Error ? error.message : 'Thread messages failed')
        setCommunicationThreadMessages((current) => ({
          ...current,
          [expandedThreadId]: [],
        }))
      } finally {
        if (!cancelled) {
          setLoadingCommunicationThreadId((current) =>
            current === expandedThreadId ? '' : current,
          )
        }
      }
    }

    void loadExpandedThreadMessages()
    return () => {
      cancelled = true
    }
  }, [activityThreads, communicationThreadMessages, expandedThreadId])

  useEffect(() => {
    const contactThread = expandedLeadContextId
      ? contactActivityThreadByLeadId.get(expandedLeadContextId)
      : undefined
    const sourceThreadIds = communicationSourceThreadIds(contactThread)
    const missingThreadIds = sourceThreadIds.filter(
      (threadId) => !communicationThreadMessages[threadId],
    )
    if (!contactThread || missingThreadIds.length === 0) return
    const loadTimer = window.setTimeout(() => {
      void reloadCommunicationThreadMessages(missingThreadIds, contactThread.threadId)
    }, 0)
    return () => window.clearTimeout(loadTimer)
  }, [
    communicationThreadMessages,
    contactActivityThreadByLeadId,
    expandedLeadContextId,
    reloadCommunicationThreadMessages,
  ])

  const {
    audioPlaybackStateFor,
    toggleCallAudioPlayback,
  } = useCallAudioPlayback({
    refreshRecentCalls: refreshLibrary,
    setNotice,
  })

  useEffect(() => {
    const refreshTimer = window.setTimeout(() => {
      void refreshLibrary()
    }, 0)
    return () => window.clearTimeout(refreshTimer)
  }, [refreshLibrary])

  function toggleSelected(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      writePlaygroundPhoneLeadId(next.has(id) ? id : Array.from(next).at(-1) || '')
      return next
    })
  }

  function toggleAllVisible() {
    setSelectedIds((current) => {
      const next = new Set(current)
      filteredLeads.forEach((lead) => {
        if (allVisibleSelected) next.delete(lead.id)
        else next.add(lead.id)
      })
      writePlaygroundPhoneLeadId(Array.from(next).at(-1) || '')
      return next
    })
  }

  function clearSelectedLeads() {
    setSelectedIds(new Set())
    writePlaygroundPhoneLeadId('')
  }

  async function patchLead(leadId: string, patch: Partial<Lead>) {
    setLeads((current) =>
      current.map((lead) => (lead.id === leadId ? { ...lead, ...patch } : lead)),
    )
    try {
      const response = await fetch(apiUrl(`/leads/${encodeURIComponent(leadId)}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patch }),
      })
      const payload = (await response.json().catch(() => ({}))) as {
        lead?: Lead
        error?: string
      }
      if (!response.ok) throw new Error(payload.error || 'Contact update failed')
      if (payload.lead) {
        setLeads((current) =>
          current.map((lead) => (lead.id === payload.lead?.id ? payload.lead : lead)),
        )
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Contact update failed')
      void refreshLibrary()
    }
  }

  async function addLead() {
    const source = activeContactSource || contactSourceOptions[0]
    if (!source) {
      setNotice('Choose Personal Phone or CallTools before adding a contact')
      return
    }
    try {
      const response = await fetch(apiUrl('/leads'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: source.source,
          sourceId: source.sourceId || source.key,
          sourceName: source.sourceName || source.label,
        }),
      })
      const payload = (await response.json().catch(() => ({}))) as {
        lead?: Lead
        error?: string
      }
      if (!response.ok || !payload.lead) {
        throw new Error(payload.error || 'Contact create failed')
      }
      setLeads((current) => [payload.lead as Lead, ...current])
      setSelectedIds(new Set([payload.lead.id]))
      setNotice('Contact added')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Contact create failed')
    }
  }

  function parseCsv(file: File, onLeads: (rows: Lead[]) => void) {
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (result) => {
        const imported = result.data
          .map(csvRowToLead)
          .filter((lead) => lead.name || lead.phone || lead.company)
        onLeads(imported)
      },
      error: (error) => setNotice(`CSV import failed: ${error.message}`),
    })
  }

  function handleSmartViewCsvUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    parseCsv(file, (imported) => {
      void (async () => {
        try {
          const response = await fetch(apiUrl('/smart-views/import'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: file.name.replace(/\.[^.]+$/, '') || 'Imported Smart View',
              leads: imported,
            }),
          })
          const payload = (await response.json().catch(() => ({}))) as {
            leads?: Lead[]
            smartView?: SmartView
            smartViews?: SmartView[]
            error?: string
          }
          if (!response.ok) throw new Error(payload.error || 'Smart View import failed')
          setLeads((current) => payload.leads || [...imported, ...current])
          setSmartViews((current) =>
            payload.smartViews ||
            (payload.smartView ? [payload.smartView, ...current] : current),
          )
          if (payload.smartView) setActiveSmartViewId(payload.smartView.id)
          setNotice(`${payload.smartView?.name || 'Smart View'} imported`)
        } catch (error) {
          setNotice(error instanceof Error ? error.message : 'Smart View import failed')
        }
      })()
    })
    event.target.value = ''
  }

  async function syncPersonalPhoneContacts() {
    setPersonalPhoneSyncing(true)
    try {
      const response = await fetch(apiUrl('/personal-phone/contacts/sync'), {
        method: 'POST',
      })
      const payload = (await response.json().catch(() => ({}))) as {
        contactSource?: ContactSourceSummary
        imported?: Lead[]
        leads?: Lead[]
        smartViews?: SmartView[]
        personalPhone?: { totalContactCount?: number; importedCount?: number }
        error?: string
      }
      if (!response.ok || !payload.contactSource) {
        throw new Error(payload.error || 'Personal phone sync failed')
      }
      setLeads(payload.leads || [])
      setSmartViews(payload.smartViews || [])
      setActiveContactSourceKey(
        contactSourceKey(
          payload.contactSource.source || 'personal-phone',
          payload.contactSource.sourceId || '',
        ),
      )
      setActiveSmartViewId('')
      setNotice(
        `${payload.contactSource.sourceName || 'Personal Phone'} synced (${payload.personalPhone?.importedCount ?? payload.imported?.length ?? 0} of ${payload.personalPhone?.totalContactCount ?? payload.imported?.length ?? 0} contacts)`,
      )
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Personal phone sync failed')
    } finally {
      setPersonalPhoneSyncing(false)
    }
  }

  async function syncCallToolsCampaignContacts() {
    setCalltoolsSyncing(true)
    try {
      const campaign = selectedCalltoolsCampaign
      const response = await fetch(apiUrl('/calltools/campaign-contacts/sync'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          campaign
            ? {
                calltoolsSource: {
                  campaignId: campaign.id,
                  liveFilterId: campaign.liveFilterId || '',
                  bucketId: campaign.bucketId || '',
                },
              }
            : {},
        ),
      })
      const payload = (await response.json().catch(() => ({}))) as {
        contactSource?: ContactSourceSummary
        imported?: Lead[]
        leads?: Lead[]
        smartViews?: SmartView[]
        calltools?: {
          campaignName?: string
          queriedContactCount?: number
          importedCount?: number
        }
        error?: string
      }
      if (!response.ok || !payload.contactSource) {
        throw new Error(payload.error || 'CallTools sync failed')
      }
      setLeads(payload.leads || [])
      setSmartViews(payload.smartViews || [])
      setActiveContactSourceKey(
        contactSourceKey(
          payload.contactSource.source || 'calltools',
          payload.contactSource.sourceId || '',
        ),
      )
      setActiveSmartViewId('')
      setNotice(
        `${payload.contactSource.sourceName || campaign?.name || 'CallTools'} synced (${payload.calltools?.importedCount ?? payload.imported?.length ?? 0}/${payload.calltools?.queriedContactCount ?? 0} records)`,
      )
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'CallTools sync failed')
    } finally {
      setCalltoolsSyncing(false)
    }
  }

  function selectContactSource(sourceKey: string) {
    const nextSource =
      contactSourceOptions.find((option) => option.key === sourceKey) || contactSourceOptions[0]
    setActiveContactSourceKey(nextSource.key)
    setActiveSmartViewId('')
    clearSelectedLeads()
    setNotice(`${nextSource.label} selected`)
  }

  async function saveSmartView() {
    const leadIds = selectedIds.size
      ? filteredLeads.filter((lead) => selectedIds.has(lead.id)).map((lead) => lead.id)
      : filteredLeads.map((lead) => lead.id)
    if (leadIds.length === 0) {
      setNotice('No contacts in this view')
      return
    }
    try {
      const response = await fetch(apiUrl('/smart-views'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          smartView: {
            name: smartViewName.trim() || query.trim() || 'Library Smart View',
            source: 'filters',
            leadIds,
            filters: {
              query,
              sortDirection,
              sortField,
              stateFilter,
              statusFilter,
              tagFilter,
            },
          },
        }),
      })
      const payload = (await response.json().catch(() => ({}))) as {
        smartView?: SmartView
        smartViews?: SmartView[]
        error?: string
      }
      if (!response.ok || !payload.smartView) {
        throw new Error(payload.error || 'Smart View save failed')
      }
      setSmartViews(payload.smartViews || [payload.smartView, ...smartViews])
      setActiveSmartViewId(payload.smartView.id)
      setSmartViewName('')
      setNotice(`${payload.smartView.name} saved`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Smart View save failed')
    }
  }

  async function deleteSmartView(smartViewId: string) {
    try {
      const response = await fetch(apiUrl(`/smart-views/${encodeURIComponent(smartViewId)}`), {
        method: 'DELETE',
      })
      const payload = (await response.json().catch(() => ({}))) as {
        smartViews?: SmartView[]
        error?: string
      }
      if (!response.ok) throw new Error(payload.error || 'Smart View delete failed')
      setSmartViews(payload.smartViews || smartViews.filter((view) => view.id !== smartViewId))
      if (activeSmartViewId === smartViewId) setActiveSmartViewId('')
      setNotice('Smart View deleted')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Smart View delete failed')
    }
  }

  async function uploadContextFile(file: File) {
    const headers: Record<string, string> = {
      'X-Speak-File-Name': encodeURIComponent(file.name || 'context-file'),
    }
    if (file.type) {
      headers['Content-Type'] = file.type
      headers['X-Speak-File-Type'] = file.type
    }

    const response = await fetch(apiUrl('/context-files'), {
      method: 'POST',
      headers,
      body: file,
    })
    const payload = (await response.json().catch(() => ({}))) as {
      attachment?: ContextAttachment
      error?: string
    }
    if (!response.ok || !payload.attachment) {
      throw new Error(payload.error || 'File upload failed')
    }
    return payload.attachment
  }

  async function deleteContextFile(fileId: string) {
    const response = await fetch(apiUrl(`/context-files/${encodeURIComponent(fileId)}`), {
      method: 'DELETE',
    })
    if (!response.ok && response.status !== 404) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string }
      throw new Error(payload.error || 'File delete failed')
    }
  }

  async function handleContextFiles(target: ContextTarget, files: File[]) {
    if (files.length === 0) return

    try {
      setNotice(`Uploading ${files.length} context file${files.length === 1 ? '' : 's'}...`)
      const attachments = await Promise.all(files.map(uploadContextFile))
      if (target.scope === 'lead') {
        const lead = leads.find((item) => item.id === target.id)
        if (!lead) throw new Error('Contact not found')
        const context = normalizeContextFields(lead.context)
        await updateLeadContext(target.id, {
          ...context,
          files: [...context.files, ...attachments],
        })
      } else {
        const profile = profiles.find((item) => item.id === target.id)
        if (!profile) throw new Error('Agent profile not found')
        const context = normalizeContextFields(profile.context)
        await updateProfileContext(target.id, {
          ...context,
          files: [...context.files, ...attachments],
        })
      }
      setNotice('Context files uploaded')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Context upload failed')
    }
  }

  async function removeContextFile(target: ContextTarget, context: ContextFields, fileId: string) {
    try {
      await deleteContextFile(fileId)
      const nextContext = normalizeContextFields({
        ...context,
        files: context.files.filter((item) => item.id !== fileId),
      })
      if (target.scope === 'lead') {
        await updateLeadContext(target.id, nextContext)
      } else {
        await updateProfileContext(target.id, nextContext)
      }
      setNotice('Context file removed')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Context file remove failed')
    }
  }

  async function updateLeadContext(leadId: string, context: ContextFields) {
    await patchLead(leadId, { context: normalizeContextFields(context) })
  }

  async function updateProfileContext(profileId: string, context: ContextFields) {
    const profile = profiles.find((item) => item.id === profileId)
    if (!profile) return
    const nextProfile = {
      ...profile,
      context: normalizeContextFields(context),
      updatedAt: new Date().toISOString(),
    }
    setProfiles((current) =>
      current.map((item) => (item.id === profileId ? nextProfile : item)),
    )
    try {
      const response = await fetch(apiUrl('/profiles'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: nextProfile }),
      })
      const payload = (await response.json().catch(() => ({}))) as {
        profile?: AgentConfigProfile
        error?: string
      }
      if (!response.ok || !payload.profile) {
        throw new Error(payload.error || 'Agent context update failed')
      }
      setProfiles((current) =>
        current.map((item) => (item.id === payload.profile?.id ? payload.profile : item)),
      )
      setNotice('Agent context saved')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Agent context update failed')
      void refreshLibrary()
    }
  }

  async function updateProfileDetails(
    profileId: string,
    name: string,
    instructions: string,
  ) {
    const profile = profiles.find((item) => item.id === profileId)
    if (!profile) return

    const nextName = name.trim()
    if (!nextName) {
      setNotice('Agent name is required')
      return
    }

    const savedInstructions = profile.config?.instructions || ''
    const nameChanged =
      nextName !== profile.name || nextName !== profile.config?.agentProfileName
    const promptChanged = instructions !== savedInstructions
    if (!nameChanged && !promptChanged) return

    const nextProfile: AgentConfigProfile = {
      ...profile,
      name: nextName,
      config: {
        ...profile.config,
        agentProfileName: nextName,
        instructions,
      },
      updatedAt: new Date().toISOString(),
    }

    setProfiles((current) =>
      current.map((item) => (item.id === profileId ? nextProfile : item)),
    )

    let workspaceProfile = nextProfile
    let workspaceSaved = false
    try {
      const workspaceResponse = await fetch(apiUrl('/profiles'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: nextProfile }),
      })
      const workspacePayload = (await workspaceResponse.json().catch(() => ({}))) as {
        profile?: AgentConfigProfile
        error?: string
      }
      if (!workspaceResponse.ok || !workspacePayload.profile) {
        throw new Error(workspacePayload.error || 'Agent profile save failed')
      }

      workspaceProfile = workspacePayload.profile
      workspaceSaved = true
      setProfiles((current) =>
        current.map((item) =>
          item.id === workspaceProfile.id ? workspaceProfile : item,
        ),
      )

      const syncResponse = await fetch(apiUrl('/agent-configs/sync-speak'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profileId: workspaceProfile.id,
          profileName: workspaceProfile.name,
          config: workspaceProfile.config,
          createNew: false,
          ownedUpdates: { name: nameChanged, prompt: promptChanged },
        }),
      })
      const syncPayload = (await syncResponse.json().catch(() => ({}))) as {
        config?: Partial<AgentConfigProfile['config']>
        speakConfigId?: string
        humeConfigId?: string
        inworldConfigId?: string
        humeConfigVersion?: number
        error?: string
      }
      if (
        !syncResponse.ok ||
        !(syncPayload.speakConfigId || syncPayload.humeConfigId || syncPayload.inworldConfigId || syncPayload.config)
      ) {
        throw new Error(syncPayload.error || 'Speak config sync failed')
      }

      const syncedProfile: AgentConfigProfile = {
        ...workspaceProfile,
        config: {
          ...workspaceProfile.config,
          ...(syncPayload.config || {}),
          agentProfileName: workspaceProfile.name,
          instructions,
        },
        updatedAt: new Date().toISOString(),
      }
      const finalResponse = await fetch(apiUrl('/profiles'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: syncedProfile }),
      })
      const finalPayload = (await finalResponse.json().catch(() => ({}))) as {
        profile?: AgentConfigProfile
        error?: string
      }
      if (!finalResponse.ok || !finalPayload.profile) {
        throw new Error(finalPayload.error || 'Agent profile metadata save failed')
      }
      const persistedSyncedProfile = finalPayload.profile
      setProfiles((current) =>
        current.map((item) =>
          item.id === persistedSyncedProfile.id ? persistedSyncedProfile : item,
        ),
      )
      setAgentNameDrafts((current) => {
        const next = { ...current }
        delete next[profileId]
        return next
      })
      setAgentPromptDrafts((current) => {
        const next = { ...current }
        delete next[profileId]
        return next
      })
      setNotice('Agent profile saved and Speak synced')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Agent profile save failed')
      if (workspaceSaved) {
        try {
          await fetch(apiUrl('/profiles'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ profile }),
          })
        } catch {
          // The UI still restores local state; the next refresh will reconcile server state.
        }
      }
      setProfiles((current) =>
        current.map((item) => (item.id === profile.id ? profile : item)),
      )
      setAgentNameDrafts((current) => ({
        ...current,
        [profileId]: name,
      }))
      setAgentPromptDrafts((current) => ({
        ...current,
        [profileId]: instructions,
      }))
    }
  }

  async function addAgentProfile() {
    try {
      const response = await fetch(apiUrl('/profiles'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profile: {
            name: 'New agent config',
            updatedAt: new Date().toISOString(),
            context: normalizeContextFields(),
          },
        }),
      })
      const payload = (await response.json().catch(() => ({}))) as {
        profile?: AgentConfigProfile
        error?: string
      }
      if (!response.ok || !payload.profile) {
        throw new Error(payload.error || 'Agent create failed')
      }
      setProfiles((current) => [payload.profile as AgentConfigProfile, ...current])
      setExpandedAgentId(payload.profile.id)
      setNotice('Agent profile added')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Agent create failed')
    }
  }

  async function deleteAgentProfiles(ids: string[]) {
    const deleteIds = new Set(ids.filter(Boolean))
    if (deleteIds.size === 0) return
    const nextProfiles = profiles.filter((profile) => !deleteIds.has(profile.id))
    const nextActiveId = deleteIds.has(activeAgentProfileId)
      ? nextProfiles[0]?.id || ''
      : activeAgentProfileId
    setProfiles(nextProfiles)
    setActiveAgentProfileId(nextActiveId)
    setSelectedAgentProfileIds(new Set())
    try {
      const response = await fetch(apiUrl('/profiles'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profiles: nextProfiles,
          activeProfileId: nextActiveId,
        }),
      })
      const payload = (await response.json().catch(() => ({}))) as {
        profiles?: AgentConfigProfile[]
        activeProfileId?: string
        error?: string
      }
      if (!response.ok) throw new Error(payload.error || 'Agent delete failed')
      setProfiles(payload.profiles || nextProfiles)
      setActiveAgentProfileId(payload.activeProfileId || nextActiveId)
      setNotice(`${deleteIds.size} agent${deleteIds.size === 1 ? '' : 's'} deleted`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Agent delete failed')
      void refreshLibrary()
    }
  }

  function toggleAgentProfileSelected(id: string) {
    setSelectedAgentProfileIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAllVisibleAgentProfiles() {
    setSelectedAgentProfileIds((current) => {
      const next = new Set(current)
      profileAgentRecords.forEach((record) => {
        const id = record.profile?.id
        if (!id) return
        if (allVisibleAgentProfilesSelected) next.delete(id)
        else next.add(id)
      })
      return next
    })
  }

  async function bulkStatus(status: LeadStatus) {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    setLeads((current) =>
      current.map((lead) => (selectedIds.has(lead.id) ? { ...lead, status } : lead)),
    )
    try {
      const response = await fetch(apiUrl('/leads/bulk-status'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, status }),
      })
      if (!response.ok) throw new Error('Bulk status failed')
      setNotice(`${ids.length} contacts moved to ${statusLabels[status]}`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Bulk status failed')
      void refreshLibrary()
    }
  }

  async function bulkDelete() {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    setLeads((current) => current.filter((lead) => !selectedIds.has(lead.id)))
    clearSelectedLeads()
    try {
      const response = await fetch(apiUrl('/leads/bulk-delete'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      })
      if (!response.ok) throw new Error('Bulk delete failed')
      setNotice(`${ids.length} contacts deleted`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Bulk delete failed')
      void refreshLibrary()
    }
  }

  function contactColumnValue(lead: Lead, key: LibraryColumnKey) {
    if (key === 'calltime') return formatClock(calltimeByLeadId.get(lead.id) || 0)
    if (key === 'status') return statusLabels[lead.status]
    if (key === 'tags') return lead.tags.join(', ')
    if (key === 'lastCall') return lead.lastCall || 'Never'
    return String(lead[key] || '')
  }

  function contactSummaryItems(lead: Lead) {
    const summaryColumns = visibleColumns
      .filter((column) => !['company', 'name', 'status'].includes(column.key))
      .filter((column) => contactColumnValue(lead, column.key))
    const fallbackColumns = columns.filter((column) =>
      ['lastCall', 'calltime', 'state', 'phone', 'email'].includes(column.key),
    )
    return (summaryColumns.length ? summaryColumns : fallbackColumns)
      .map((column) => ({
        key: column.key,
        label: column.label,
        value: contactColumnValue(lead, column.key),
      }))
      .filter((item) => item.value)
      .slice(0, 5)
  }

  async function commitLeadTextField(
    lead: Lead,
    key: Exclude<LibraryColumnKey, 'status' | 'tags' | 'calltime'>,
    value: string,
  ) {
    const nextValue = key === 'phone' ? normalizePhoneOnCommit(value) : value
    if (nextValue === contactColumnValue(lead, key)) return
    await patchLead(lead.id, { [key]: nextValue } as Partial<Lead>)
  }

  async function openLeadInDialer(lead: Lead) {
    const sourceKey = leadContactSourceKey(lead)
    const sourceId = isSelectableContactSource(lead.source || '')
      ? dialerSourceIdFromContactSourceKey(sourceKey)
      : ''
    const dialerState = {
      sourceId,
      activeSmartViewId: '',
      query: '',
      statusFilter: 'all',
      stateFilter: 'all',
      scoreFilter: 'all',
      selectedLeadId: lead.id,
      selectedLeadIds: [lead.id],
      campaignQueueIds: [],
      campaignRunning: false,
      scheduledStartAt: '',
      scheduledQueueActive: false,
    }

    try {
      await fetch(apiUrl('/dialer-state'), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dialerState }),
      })
    } catch {
      // The URL hash still selects the contact when the Dialer opens.
    }

    navigateToAppUrl(`${basePath}/dialer#lead=${encodeURIComponent(lead.id)}`)
  }

  function renderContactDetailField(lead: Lead, column: LibraryColumn) {
    const key = column.key
    if (key === 'calltime') {
      return (
        <div className="contact-library-field contact-library-field-readonly" key={key}>
          <span>{column.label}</span>
          <strong>{formatClock(calltimeByLeadId.get(lead.id) || 0)}</strong>
        </div>
      )
    }
    if (key === 'status') {
      return (
        <label className="contact-library-field" key={key}>
          <span>{column.label}</span>
          <select
            value={lead.status}
            data-action-id={speakActionIds.editLead}
            aria-label={`${lead.company || lead.name || 'Contact'} status`}
            onChange={(event) => {
              void patchLead(lead.id, { status: event.target.value as LeadStatus })
            }}
          >
            {statusOptions.map((status) => (
              <option key={status} value={status}>
                {statusLabels[status]}
              </option>
            ))}
          </select>
        </label>
      )
    }
    if (key === 'tags') {
      return (
        <label className="contact-library-field" key={key}>
          <span>{column.label}</span>
          <input
            defaultValue={lead.tags.join(', ')}
            data-action-id={speakActionIds.editLead}
            aria-label={`${lead.company || lead.name || 'Contact'} tags`}
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            enterKeyHint="done"
            inputMode="text"
            onBlur={(event) => {
              const tags = parseTags(event.target.value)
              if (tags.join(', ') === lead.tags.join(', ')) return
              void patchLead(lead.id, { tags })
            }}
          />
        </label>
      )
    }
    if (key === 'notes') {
      return (
        <label className="contact-library-field contact-library-field-wide" key={key}>
          <span>{column.label}</span>
          <textarea
            defaultValue={lead.notes}
            data-action-id={speakActionIds.editLead}
            aria-label={`${lead.company || lead.name || 'Contact'} notes`}
            autoCapitalize="sentences"
            autoComplete="off"
            autoCorrect="on"
            onBlur={(event) => commitLeadTextField(lead, key, event.target.value)}
          />
        </label>
      )
    }
    const value = contactColumnValue(lead, key)
    if (key === 'phone') {
      return (
        <LibraryPhoneField
          column={column}
          key={`${key}:${lead.id}:${lead.phone}`}
          lead={lead}
          onCommit={(nextValue) => commitLeadTextField(lead, key, nextValue)}
          onOpenDialer={() => void openLeadInDialer(lead)}
        />
      )
    }
    if (key === 'email') {
      return (
        <LibraryEmailField
          column={column}
          key={`${key}:${lead.id}:${lead.email}`}
          lead={lead}
          onCommit={(nextValue) => commitLeadTextField(lead, key, nextValue)}
        />
      )
    }
    return (
      <label className="contact-library-field" key={key}>
        <span>{column.label}</span>
        <input
          defaultValue={value}
          data-action-id={speakActionIds.editLead}
          aria-label={`${lead.company || lead.name || 'Contact'} ${column.label}`}
          autoCapitalize="words"
          autoComplete={autocompleteForColumn(key)}
          autoCorrect="off"
          enterKeyHint="done"
          inputMode={inputModeForColumn(key)}
          type="text"
          onBlur={(event) => {
            void commitLeadTextField(lead, key, event.target.value)
          }}
        />
      </label>
    )
  }

  function renderContactLibrary() {
    return (
      <section
        className="library-database contact-library"
        data-testid={speakTestIds.leadQueue}
        aria-label="Contact library"
      >
        <div className="contact-library-toolbar">
          <LeadBulkActionBar
            allVisibleSelected={allVisibleSelected}
            bulkDelete={() => void bulkDelete()}
            bulkStatus={(status) => void bulkStatus(status)}
            bulkStatusOptions={statusOptions}
            clearSelectedLeads={clearSelectedLeads}
            itemLabel="contacts"
            selectedCount={selectedIds.size}
            showSelectControl
            someVisibleSelected={someVisibleSelected}
            toggleAllVisible={toggleAllVisible}
            totalVisibleCount={filteredLeads.length}
          />
        </div>

        <div className="contact-library-list" role="list" aria-label="Contact records">
          {renderedContactLeads.map((lead) => {
            const expanded = expandedLeadContextId === lead.id
            const businessLabel = lead.company || lead.name || 'Untitled contact'
            const contactLabel = lead.name && lead.name !== lead.company ? lead.name : 'No contact name'
            const summaryItems = contactSummaryItems(lead)
            const contactThread = contactActivityThreadByLeadId.get(lead.id)
            return (
              <article
                className={[
                  'contact-library-row',
                  selectedIds.has(lead.id) ? 'row-selected' : '',
                  expanded ? 'context-open' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                key={lead.id}
                data-lead-id={lead.id}
                role="listitem"
                aria-expanded={expanded}
              >
                <button
                  className={[
                    'selection-toggle',
                    'contact-library-row-select',
                    selectedIds.has(lead.id) ? 'selected' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  type="button"
                  data-action-id={speakActionIds.selectLead}
                  aria-pressed={selectedIds.has(lead.id)}
                  aria-label={`Select ${businessLabel}`}
                  onClick={() => toggleSelected(lead.id)}
                >
                  <Check size={13} />
                </button>
                <button
                  className="contact-library-main"
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => toggleLeadContextRow(lead.id)}
                >
                  <span className="contact-library-source">
                    <Building2 size={14} />
                    {activeSmartView?.name || 'Contact'}
                  </span>
                  <span className="contact-library-title">{businessLabel}</span>
                  <span className="contact-library-meta">{contactLabel}</span>
                  <span className="contact-library-summary">
                    {summaryItems.map((item) => (
                      <span key={item.key}>
                        {item.key === 'phone' ? (
                          <PhoneCall size={12} />
                        ) : item.key === 'email' ? (
                          <Mail size={12} />
                        ) : item.key === 'state' ? (
                          <MapPin size={12} />
                        ) : item.key === 'tags' ? (
                          <Tags size={12} />
                        ) : item.key === 'calltime' || item.key === 'lastCall' ? (
                          <Clock3 size={12} />
                        ) : (
                          <FileText size={12} />
                        )}
                        <strong>{item.value}</strong>
                      </span>
                    ))}
                    {summaryItems.length === 0 && <span>No contact details</span>}
                  </span>
                </button>
                <div className="contact-library-status">
                  <select
                    value={lead.status}
                    data-action-id={speakActionIds.editLead}
                    aria-label={`${businessLabel} status`}
                    onChange={(event) => {
                      void patchLead(lead.id, {
                        status: event.target.value as LeadStatus,
                      })
                    }}
                  >
                    {statusOptions.map((status) => (
                      <option key={status} value={status}>
                        {statusLabels[status]}
                      </option>
                    ))}
                  </select>
                  <span>{contextSummary(lead.context)}</span>
                </div>
                {expanded && (
                  <div className="contact-library-preview">
                    <div className="contact-library-fields">
                      {columns.map((detailColumn) =>
                        renderContactDetailField(lead, detailColumn),
                      )}
                    </div>
                    {renderContextEditor({
                      label: `${businessLabel} context`,
                      context: lead.context,
                      onChange: (nextContext) => void updateLeadContext(lead.id, nextContext),
                      onRemoveFile: (context, fileId) =>
                        void removeContextFile(
                          { scope: 'lead', id: lead.id },
                          context,
                          fileId,
                        ),
                      onUpload: (files) =>
                        void handleContextFiles({ scope: 'lead', id: lead.id }, files),
                    })}
                    {renderContactSourceHistory(lead, contactThread)}
                  </div>
                )}
              </article>
            )
          })}
          {remainingContactLeadCount > 0 && (
            <button
              className="contact-list-load-more"
              type="button"
              onClick={() =>
                setContactRenderLimit((current) =>
                  Math.min(current + contactLibraryRenderBatchSize, filteredLeads.length),
                )
              }
            >
              <span>
                Show {Math.min(contactLibraryRenderBatchSize, remainingContactLeadCount)} more
              </span>
              <strong>
                {renderedContactLeads.length}/{filteredLeads.length}
              </strong>
            </button>
          )}
          {filteredLeads.length === 0 && (
            <div className="empty-table-state">
              <span>No contacts match this library view.</span>
            </div>
          )}
        </div>
      </section>
    )
  }

  function toggleLeadContextRow(leadId: string) {
    setExpandedLeadContextId((current) => (current === leadId ? '' : leadId))
  }

  function renderContextEditor({
    context,
    label,
    onChange,
    onRemoveFile,
    onUpload,
  }: {
    context?: ContextFields
    label: string
    onChange: (nextContext: ContextFields) => void
    onRemoveFile: (context: ContextFields, fileId: string) => void
    onUpload: (files: File[]) => void
  }) {
    const normalized = normalizeContextFields(context)
    const urlValue = contextUrlInputValue(normalized)
    return (
      <div className="context-editor" aria-label={label}>
        <div className="context-editor-header">
          <span>{label}</span>
          <strong>{contextSummary(normalized)}</strong>
        </div>
        <div className="context-editor-grid">
          <label className="context-editor-field context-editor-text">
            <span>Text</span>
            <textarea
              defaultValue={normalized.text}
              aria-label={`${label} text`}
              placeholder="Instructions, notes, or relevant context for future calls..."
              onBlur={(event) => {
                const text = event.target.value.trim()
                if (text === normalized.text) return
                onChange(normalizeContextFields({ ...normalized, text }))
              }}
            />
          </label>
          <label className="context-editor-field context-editor-urls">
            <span>
              <Link2 size={13} />
              URLs
            </span>
            <textarea
              defaultValue={urlValue}
              aria-label={`${label} URLs`}
              placeholder="One URL per line"
              autoCapitalize="none"
              autoCorrect="off"
              onBlur={(event) => {
                const urls = parseContextUrlInput(event.target.value)
                if (urls.join('\n') === urlValue) return
                onChange(normalizeContextFields({ ...normalized, urls }))
              }}
            />
          </label>
        </div>
        <div className="context-files">
          <div className="context-files-heading">
            <span>
              <FileText size={13} />
              Files
            </span>
            <label
              className="secondary-button context-upload-action"
            >
              <Upload size={14} />
              <span>Upload</span>
              <input
                className="visually-hidden"
                type="file"
                multiple
                onChange={(event) => {
                  const files = Array.from(event.target.files || [])
                  event.target.value = ''
                  onUpload(files)
                }}
              />
            </label>
          </div>
          {normalized.files.length === 0 ? (
            <div className="context-empty">No files attached.</div>
          ) : (
            <div className="context-file-list">
              {normalized.files.map((file) => (
                <div className="context-file-row" key={file.id}>
                  <FileText size={14} />
                  <a href={file.url} download={file.name}>
                    {file.name}
                  </a>
                  <span>{formatFileSize(file.size) || file.type || 'file'}</span>
                  <button
                    className="icon-button"
                    type="button"
                    title={`Remove ${file.name}`}
                    aria-label={`Remove ${file.name}`}
                    onClick={() => onRemoveFile(normalized, file.id)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    )
  }

  function renderTranscriptAudioButton(call: RecentCallSummary) {
    const audioState = audioPlaybackStateFor(call)
    const canPlay = canRequestCallAudio(call)
    if (!canPlay) return null
    const status = audioState?.status || ''
    const title = audioState?.message || 'Play recording'
    return (
      <button
        className={[
          'icon-button',
          'transcript-library-audio',
          status ? `audio-${status}` : '',
        ]
          .filter(Boolean)
          .join(' ')}
        type="button"
        disabled={!canPlay}
        title={title}
        aria-label={title}
        onClick={() => {
          void toggleCallAudioPlayback(call)
        }}
      >
        {status === 'checking' || status === 'preparing' ? (
          <Activity size={15} />
        ) : status === 'playing' ? (
          <Pause size={14} />
        ) : (
          <Play size={14} />
        )}
      </button>
    )
  }

  function communicationThreadContextForCall(call: RecentCallSummary) {
    const linkedThread = communicationThreadsByCallId.get(call.callControlId)
    const threadId = linkedThread?.threadId || communicationThreadIdForRecentCall(call)
    return {
      enabled: Boolean(linkedThread?.threadId),
      fallbackMessages: communicationMessagesForRecentCall(call, threadId),
      threadId,
    }
  }

  function communicationSourceThreadIds(thread?: CommunicationThreadSummary) {
    if (!thread) return []
    if (thread.sourceThreadIds?.length) return thread.sourceThreadIds
    return thread.legacyRecentCall ? [] : [thread.threadId]
  }

  function communicationMessagesForThreadSourceIds(thread?: CommunicationThreadSummary) {
    if (!thread) return []
    return communicationSourceThreadIds(thread).flatMap(
      (sourceThreadId) => communicationThreadMessages[sourceThreadId] || [],
    )
  }

  function communicationThreadSourceLoaded(thread?: CommunicationThreadSummary) {
    const sourceThreadIds = communicationSourceThreadIds(thread)
    return sourceThreadIds.length === 0 ||
      sourceThreadIds.every((sourceThreadId) => communicationThreadMessages[sourceThreadId])
  }

  function communicationThreadFallbackMessages(thread?: CommunicationThreadSummary) {
    if (!thread) return []
    const linkedCalls = communicationThreadCallIds(thread)
      .map((callId) => recentCallsById.get(callId))
      .filter((call): call is RecentCallSummary => Boolean(call))
    return communicationMessagesForRecentCalls(linkedCalls, thread.threadId)
  }

  function communicationThreadMergedMessages(thread?: CommunicationThreadSummary) {
    if (!thread) return []
    return mergeCommunicationMessages(
      communicationThreadFallbackMessages(thread),
      communicationMessagesForThreadSourceIds(thread),
    )
  }

  function toggleCommunicationThread(threadId: string) {
    const next = expandedThreadId === threadId ? '' : threadId
    setExpandedThreadId(next)
    setSelectedThreadId(next)
  }

  function renderCommunicationChannelIcon(channel?: string) {
    if (channel === 'sms' || channel === 'operator_chat') return <MessagesSquare size={14} />
    if (channel === 'email') return <Mail size={14} />
    if (channel === 'browser_test') return <Bot size={14} />
    return <PhoneCall size={14} />
  }

  function renderLeadSidebarControls() {
    return (
      <div className="library-sidebar-section library-sidebar-controls" aria-label="Contact filters">
        <div className="library-sidebar-search-row">
          <input
            value={query}
            placeholder="Search contacts..."
            aria-label="Filter contacts"
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            enterKeyHint="search"
            inputMode="search"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="library-lead-options" ref={leadOptionsRef}>
            <button
              className={[
                'icon-button',
                'library-sidebar-flat-trigger',
                'library-lead-options-trigger',
                leadOptionsOpen ? 'active' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              type="button"
              title="Contact view options"
              aria-label="Contact view options"
              aria-expanded={leadOptionsOpen}
              onClick={() => {
                setLeadOptionsOpen((current) => !current)
              }}
            >
              <SlidersHorizontal size={15} />
            </button>
            {leadOptionsOpen && (
              <div
                className="library-lead-options-popout"
                role="dialog"
                aria-label="Contact view options"
              >
                <div className="library-sidebar-filter-row">
                  <select
                    value={statusFilter}
                    aria-label="Status filter"
                    onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
                  >
                    <option value="all">All status</option>
                    {statusOptions.map((status) => (
                      <option key={status} value={status}>
                        {statusLabels[status]}
                      </option>
                    ))}
                  </select>
                  <select
                    value={stateFilter}
                    aria-label="State filter"
                    onChange={(event) => setStateFilter(event.target.value)}
                  >
                    <option value="all">All states</option>
                    {states.map((state) => (
                      <option key={state} value={state}>
                        {state}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="library-sidebar-sort-row">
                  <select
                    value={sortField}
                    aria-label="Sort field"
                    onChange={(event) => setSortField(event.target.value as SortField)}
                  >
                    {columns.map((column) => (
                      <option key={column.key} value={column.key}>
                        {column.label}
                      </option>
                    ))}
                  </select>
                  <select
                    value={tagFilter}
                    aria-label="Tag filter"
                    onChange={(event) => setTagFilter(event.target.value)}
                  >
                    <option value="all">All tags</option>
                    {tags.map((tag) => (
                      <option key={tag} value={tag}>
                        {tag}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="library-sidebar-action-row">
                  <button
                    className="icon-button"
                    type="button"
                    title={sortDirection === 'asc' ? 'Sort descending' : 'Sort ascending'}
                    aria-label={sortDirection === 'asc' ? 'Sort descending' : 'Sort ascending'}
                    onClick={() =>
                      setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'))
                    }
                  >
                    {sortDirection === 'asc' ? <ArrowUp size={15} /> : <ArrowDown size={15} />}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  function renderAgentSidebarControls() {
    return (
      <div className="library-sidebar-section library-sidebar-controls" aria-label="Agent filters">
        <input
          value={agentQuery}
          placeholder="Search agents..."
          aria-label="Search agents"
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          enterKeyHint="search"
          inputMode="search"
          spellCheck={false}
          onChange={(event) => setAgentQuery(event.target.value)}
        />
        <div className="library-sidebar-sort-row">
          <select
            value={agentSortField}
            aria-label="Agent sort field"
            onChange={(event) => setAgentSortField(event.target.value as AgentSortField)}
          >
            <option value="activity">Activity</option>
            <option value="name">Name</option>
            <option value="calls">Call count</option>
            <option value="turns">Call turns</option>
            <option value="recordings">Recordings</option>
          </select>
          <button
            className="icon-button"
            type="button"
            title={agentSortDirection === 'asc' ? 'Sort descending' : 'Sort ascending'}
            aria-label={agentSortDirection === 'asc' ? 'Sort descending' : 'Sort ascending'}
            onClick={() =>
              setAgentSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'))
            }
          >
            {agentSortDirection === 'asc' ? <ArrowUp size={15} /> : <ArrowDown size={15} />}
          </button>
        </div>
      </div>
    )
  }

  function renderTranscriptSidebarControls() {
    const fieldFiltersActive = Boolean(
      transcriptAgentFilter ||
        transcriptContactFilter ||
        transcriptDateFilter ||
        transcriptMinDurationFilter ||
        transcriptMinTurnsFilter,
    )
    return (
      <div
        className="library-sidebar-section library-sidebar-controls"
        aria-label="Activity filters"
      >
        <input
          value={transcriptQuery}
          placeholder="Search activity..."
          aria-label="Search activity"
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          enterKeyHint="search"
          inputMode="search"
          spellCheck={false}
          onChange={(event) => setTranscriptQuery(event.target.value)}
        />
        <div className="library-sidebar-sort-row">
          <select
            value={transcriptSortField}
            aria-label="Activity sort field"
            onChange={(event) =>
              setTranscriptSortField(event.target.value as TranscriptSortField)
            }
          >
            <option value="date">Date</option>
            <option value="contact">Contact</option>
            <option value="agent">Agent</option>
            <option value="duration">Call time</option>
            <option value="turns">Turns</option>
            <option value="source">Source</option>
          </select>
          <button
            className="icon-button"
            type="button"
            title={
              transcriptSortDirection === 'asc' ? 'Sort descending' : 'Sort ascending'
            }
            aria-label={
              transcriptSortDirection === 'asc' ? 'Sort descending' : 'Sort ascending'
            }
            onClick={() =>
              setTranscriptSortDirection((current) =>
                current === 'asc' ? 'desc' : 'asc',
              )
            }
          >
            {transcriptSortDirection === 'asc' ? (
              <ArrowUp size={15} />
            ) : (
              <ArrowDown size={15} />
            )}
          </button>
        </div>
        <div className="library-sidebar-filter-grid activity-field-filters">
          <input
            value={transcriptContactFilter}
            placeholder="Contact"
            aria-label="Filter activity by contact"
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            enterKeyHint="search"
            inputMode="search"
            spellCheck={false}
            onChange={(event) => setTranscriptContactFilter(event.target.value)}
          />
          <input
            value={transcriptAgentFilter}
            placeholder="Agent"
            aria-label="Filter activity by agent"
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            enterKeyHint="search"
            inputMode="search"
            spellCheck={false}
            onChange={(event) => setTranscriptAgentFilter(event.target.value)}
          />
          <input
            value={transcriptDateFilter}
            aria-label="Filter activity by date"
            type="date"
            onChange={(event) => setTranscriptDateFilter(event.target.value)}
          />
          <input
            value={transcriptMinDurationFilter}
            placeholder="Call min"
            aria-label="Minimum call minutes"
            inputMode="decimal"
            min="0"
            type="number"
            onChange={(event) => setTranscriptMinDurationFilter(event.target.value)}
          />
          <input
            value={transcriptMinTurnsFilter}
            placeholder="Turns"
            aria-label="Minimum activity turns"
            inputMode="numeric"
            min="0"
            type="number"
            onChange={(event) => setTranscriptMinTurnsFilter(event.target.value)}
          />
          <button
            className="icon-button library-sidebar-flat-trigger"
            type="button"
            title="Clear activity field filters"
            aria-label="Clear activity field filters"
            disabled={!fieldFiltersActive}
            onClick={() => {
              setTranscriptAgentFilter('')
              setTranscriptContactFilter('')
              setTranscriptDateFilter('')
              setTranscriptMinDurationFilter('')
              setTranscriptMinTurnsFilter('')
            }}
          >
            <X size={15} />
          </button>
        </div>
      </div>
    )
  }

  function renderTranscriptLibrary() {
    return (
      <section
        className="transcript-library"
        aria-label="Communication activity"
        data-testid={speakTestIds.transcriptLibrary}
      >
        <div className="transcript-library-toolbar">
          <div
            className="transcript-thread-status"
            title="Communication thread protocol status"
            aria-label="Communication thread protocol status"
          >
            <MessagesSquare size={14} />
            <span>{transcriptStats.threads} threads</span>
            <span>{transcriptStats.linked} linked</span>
            <span>{transcriptStats.unresolved} unresolved</span>
          </div>
          {selectedThread && (
            <div className="transcript-thread-status selected">
              <span>
                {communicationThreadContactLabel(selectedThread, leads) || 'Selected thread'}
              </span>
              <span>{selectedThread.status || 'thread'}</span>
            </div>
          )}
        </div>

        <div className="transcript-library-list">
          {transcriptRecords.map((thread) => {
            const expanded = communicationThreadMatchesId(thread, expandedThreadId)
            const stats = communicationThreadCallStats(thread, recentCallsById)
            const latestAt = thread.updatedAt ? formatCallDate(thread.updatedAt) : ''
            const linkedCalls = communicationThreadCallIds(thread)
              .map((callId) => recentCallsById.get(callId))
              .filter((call): call is RecentCallSummary => Boolean(call))
            const linkedCallMessages = communicationMessagesForRecentCalls(
              linkedCalls,
              thread.threadId,
            )
            const sourceThreadIds = communicationSourceThreadIds(thread)
            const sourceThreadsLoaded = communicationThreadSourceLoaded(thread)
            const sourceThreadMessages = communicationMessagesForThreadSourceIds(thread)
            const messages = mergeCommunicationMessages(
              linkedCallMessages,
              sourceThreadMessages,
            )
            const audioCall = linkedCalls.find(canRequestCallAudio)
            const loadingActivityMessages =
              loadingCommunicationThreadId === thread.threadId ||
              (expanded && sourceThreadIds.length > 0 && !sourceThreadsLoaded)
            return (
              <article
                className="transcript-library-row"
                data-thread-channels={(thread.channels || []).join(',')}
                data-thread-id={thread.threadId}
                key={thread.threadId}
              >
                <span className="agent-library-row-select-spacer" aria-hidden="true" />
                <button
                  className="transcript-library-main"
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => toggleCommunicationThread(thread.threadId)}
                >
                  <span className="transcript-library-source">
                    {renderCommunicationChannelIcon(communicationThreadPrimaryChannel(thread))}
                    {communicationThreadChannelSummary(thread)}
                  </span>
                  <span className="transcript-library-title">
                    {communicationThreadContactLabel(thread, leads) || 'Unresolved contact'}
                  </span>
                  <span className="transcript-library-meta">
                    {[
                      latestAt,
                      stats.agentLabel || 'No agent',
                      thread.status || 'open',
                      stats.totalSeconds > 0 ? formatClock(stats.totalSeconds) : '',
                    ]
                      .filter(Boolean)
                      .join(' / ')}
                  </span>
                  <span className="transcript-library-summary">
                    {communicationThreadPreviewText(thread) ||
                      'No activity text captured'}
                  </span>
                </button>
                <div className="transcript-library-status">
                  <span>{stats.callCount} calls</span>
                  <span>{stats.turns} turns</span>
                  {thread.lastInboundAt && <span>Inbound</span>}
                  {thread.lastOutboundAt && <span>Outbound</span>}
                  {audioCall && renderTranscriptAudioButton(audioCall)}
                </div>
                {expanded && (
                  <CommunicationThreadMessagesView
                    className="transcript-library-preview"
                    emptyText={
                      thread.legacyRecentCall
                        ? 'Call text was not captured for this source record.'
                        : 'No messages are stored for this thread yet.'
                    }
                    initialMessages={messages}
                    labels={{
                      agent: stats.agentLabel,
                      contact: communicationThreadContactLabel(thread, leads),
                    }}
                    loading={loadingActivityMessages}
                    loadingText="Loading activity messages..."
                    order="desc"
                    onMessageSent={({ message, result }) => {
                      const sentThreadId =
                        typeof result.message === 'object'
                          ? result.message?.threadId || message.threadId
                          : message.threadId
                      const reloadThreadIds = Array.from(
                        new Set([...sourceThreadIds, sentThreadId].filter(Boolean)),
                      )
                      void reloadCommunicationThreadMessages(reloadThreadIds, thread.threadId)
                      void refreshLibrary()
                    }}
                    threadId={thread.threadId}
                  />
                )}
              </article>
            )
          })}
          {transcriptRecords.length === 0 && (
            <div className="empty-table-state">
              <span>No activity matches this library view.</span>
            </div>
          )}
        </div>
      </section>
    )
  }

  function renderContactSourceHistory(lead: Lead, thread?: CommunicationThreadSummary) {
    const contactLabel = lead.company || lead.name || 'Contact'
    if (!thread) {
      return (
        <div className="contact-library-call-history contact-library-source-history">
          <div className="contact-library-call-heading">
            <span>Source history</span>
            <strong>0</strong>
          </div>
          <div className="empty-table-state">
            <span>No source activity is stored for this contact.</span>
          </div>
        </div>
      )
    }

    const sourceThreadIds = communicationSourceThreadIds(thread)
    const stats = communicationThreadCallStats(thread, recentCallsById)
    const messages = communicationThreadMergedMessages(thread)
    const sourceLoaded = communicationThreadSourceLoaded(thread)
    const loading =
      loadingCommunicationThreadId === thread.threadId ||
      (sourceThreadIds.length > 0 && !sourceLoaded)
    return (
      <div className="contact-library-call-history contact-library-source-history">
        <div className="contact-library-call-heading">
          <span>Source history</span>
          <strong>{Math.max(Number(thread.messageCount || 0), messages.length)}</strong>
          <em>
            {[
              communicationThreadSourceLabel(thread),
              thread.updatedAt ? formatCallDate(thread.updatedAt) : '',
              stats.totalSeconds > 0 ? formatClock(stats.totalSeconds) : '',
              stats.turns > 0 ? `${stats.turns} turns` : '',
            ]
              .filter(Boolean)
              .join(' / ')}
          </em>
        </div>
        <CommunicationThreadMessagesView
          className="contact-library-call-transcript contact-library-source-transcript"
          emptyText="No source messages are stored for this contact yet."
          initialMessages={messages}
          labels={{
            agent: stats.agentLabel,
            contact: contactLabel,
          }}
          loading={loading}
          loadingText="Loading contact source history..."
          onMessageSent={({ message, result }) => {
            const sentThreadId =
              typeof result.message === 'object'
                ? result.message?.threadId || message.threadId
                : message.threadId
            const reloadThreadIds = Array.from(
              new Set([...sourceThreadIds, sentThreadId].filter(Boolean)),
            )
            void reloadCommunicationThreadMessages(reloadThreadIds, thread.threadId)
            void refreshLibrary()
          }}
          threadId={thread.threadId}
        />
      </div>
    )
  }

  function renderAgentPromptEditor(profile: AgentConfigProfile) {
    const savedName = profile.name || 'Untitled agent'
    const draftName = agentNameDrafts[profile.id] ?? savedName
    const nameChanged = draftName.trim() !== savedName
    const savedInstructions = profile.config?.instructions || ''
    const draftInstructions = agentPromptDrafts[profile.id] ?? savedInstructions
    const promptChanged = draftInstructions !== savedInstructions
    const changed = nameChanged || promptChanged

    return (
      <div className="agent-library-prompt">
        <div className="agent-library-name-row">
          <input
            value={draftName}
            aria-label={`${savedName} profile name`}
            placeholder="Agent name"
            onChange={(event) =>
              setAgentNameDrafts((current) => ({
                ...current,
                [profile.id]: event.target.value,
              }))
            }
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              void updateProfileDetails(profile.id, draftName, draftInstructions)
            }}
          />
          <button
            className="secondary-button"
            type="button"
            disabled={!changed || !draftName.trim()}
            title="Save agent profile"
            aria-label="Save agent profile"
            onClick={() =>
              void updateProfileDetails(profile.id, draftName, draftInstructions)
            }
          >
            <Save size={14} />
            <span className="visually-hidden">Save agent profile</span>
          </button>
        </div>
        <div className="agent-library-prompt-heading">
          <span>System prompt instructions</span>
        </div>
        <textarea
          value={draftInstructions}
          aria-label={`${profile.name} system prompt instructions`}
          placeholder="Profile instructions used by future Playground and Dialer calls..."
          onChange={(event) =>
            setAgentPromptDrafts((current) => ({
              ...current,
              [profile.id]: event.target.value,
            }))
          }
        />
      </div>
    )
  }

  function renderAgentCommunicationThread(
    record: AgentLibraryRecord,
    thread: CommunicationThreadSummary,
  ) {
    const threadKey = `thread:${record.id}:${thread.threadId}`
    const expanded = expandedAgentTranscriptId === threadKey
    const stats = communicationThreadCallStats(thread, recentCallsById)
    const latestAt = thread.updatedAt ? formatCallDate(thread.updatedAt) : ''
    const audioCall = communicationThreadCallIds(thread)
      .map((callId) => recentCallsById.get(callId))
      .find((call): call is RecentCallSummary => Boolean(call && canRequestCallAudio(call)))
    const audioButton = audioCall ? renderTranscriptAudioButton(audioCall) : null
    return (
      <article className="agent-library-call-row agent-library-source-row" key={thread.threadId}>
        <button
          className="agent-library-call-summary"
          type="button"
          aria-expanded={expanded}
          onClick={() =>
            setExpandedAgentTranscriptId((current) =>
              current === threadKey ? '' : threadKey,
            )
          }
        >
          <span>
            {renderCommunicationChannelIcon(communicationThreadPrimaryChannel(thread))}
            {communicationThreadChannelSummary(thread)}
          </span>
          <strong>
            {communicationThreadContactLabel(thread, leads) || 'Unresolved contact'}
          </strong>
          <em>
            {[
              latestAt,
              thread.status || 'open',
              `${Math.max(Number(thread.messageCount || 0), stats.turns)} turns`,
              stats.recorded ? 'recorded' : '',
            ]
              .filter(Boolean)
              .join(' / ')}
          </em>
        </button>
        {audioButton && (
          <div className="agent-library-call-actions">{audioButton}</div>
        )}
        {expanded && (
          <CommunicationThreadMessagesView
            className="agent-library-call-transcript agent-library-source-transcript"
            emptyText="No source messages are stored for this agent thread."
            fallbackMessages={communicationThreadFallbackMessages(thread)}
            labels={{
              agent: communicationThreadAgentLabel(thread) || record.name,
              contact: communicationThreadContactLabel(thread, leads),
            }}
            order="desc"
            onMessageSent={() => {
              void refreshLibrary()
            }}
            threadId={thread.threadId}
          />
        )}
      </article>
    )
  }

  function renderAgentCallTranscript(record: AgentLibraryRecord, call: RecentCallSummary) {
    const callKey = `${record.id}:${call.callControlId}`
    const expanded = expandedAgentTranscriptId === callKey
    const turns = (call.transcript || []) as TranscriptEntry[]
    const audioButton = renderTranscriptAudioButton(call)
    const sourceHistory = communicationThreadContextForCall(call)
    return (
      <article className="agent-library-call-row" key={call.callControlId}>
        <button
          className="agent-library-call-summary"
          type="button"
          aria-expanded={expanded}
          onClick={() =>
            setExpandedAgentTranscriptId((current) => (current === callKey ? '' : callKey))
          }
        >
          <span>
            {transcriptSource(call) === 'phone' ? (
              <PhoneCall size={13} />
            ) : (
              <MessagesSquare size={13} />
            )}
            {transcriptSourceLabel(call)}
          </span>
          <strong>{callLeadTranscriptLabel(call) || recentBusinessName(call)}</strong>
          <em>
            {[
              call.createdAt ? formatCallDate(call.createdAt) : '',
              recentOutcomeLabel(call),
              `${turns.length} turns`,
              canRequestCallAudio(call) ? 'recorded' : '',
            ]
              .filter(Boolean)
              .join(' / ')}
          </em>
        </button>
        {audioButton && (
          <div className="agent-library-call-actions">{audioButton}</div>
        )}
        {expanded && (
          <CommunicationThreadMessagesView
            className="agent-library-call-transcript"
            emptyText="Call text was not captured for this call."
            enabled={sourceHistory.enabled}
            fallbackMessages={sourceHistory.fallbackMessages}
            labels={{
              agent: callAgentTranscriptLabel(call) || record.name,
              contact: callLeadTranscriptLabel(call) || recentBusinessName(call),
            }}
            order="asc"
            threadId={sourceHistory.threadId}
          />
        )}
      </article>
    )
  }

  function renderAgentLibrary() {
    return (
      <section className="agent-library" aria-label="Agent library">
        <div className="agent-library-toolbar">
          <button
            className={[
              'selection-toggle',
              'agent-library-select-all',
              agentProfileSelectionState,
            ]
              .filter(Boolean)
              .join(' ')}
            type="button"
            disabled={profileAgentRecords.length === 0}
            aria-pressed={
              allVisibleAgentProfilesSelected
                ? 'true'
                : someVisibleAgentProfilesSelected
                  ? 'mixed'
                  : 'false'
            }
            aria-label={
              allVisibleAgentProfilesSelected
                ? 'Clear visible agent profiles'
                : 'Select visible agent profiles'
            }
            onClick={toggleAllVisibleAgentProfiles}
          >
            <Check size={13} />
          </button>
          <div className="library-record-actions">
            <button
              className="secondary-button"
              type="button"
              title="Add agent profile"
              aria-label="Add agent profile"
              onClick={() => void addAgentProfile()}
            >
              <Plus size={14} />
              <span className="visually-hidden">Agent</span>
            </button>
            {selectedAgentProfileIds.size > 0 && (
              <button
                className="secondary-button danger-button"
                type="button"
                title={`Delete ${selectedAgentProfileIds.size} selected agent profiles`}
                aria-label={`Delete ${selectedAgentProfileIds.size} selected agent profiles`}
                onClick={() => void deleteAgentProfiles(Array.from(selectedAgentProfileIds))}
              >
                <Trash2 size={14} />
                <span>{selectedAgentProfileIds.size}</span>
              </button>
            )}
          </div>
        </div>

        <div className="agent-library-list">
          {filteredAgentRecords.map((record) => {
            const expanded = expandedAgentId === record.id
            const latestAt = record.lastActivityMs
              ? formatCallDate(new Date(record.lastActivityMs).toISOString())
              : record.updatedAtMs
                ? formatCallDate(new Date(record.updatedAtMs).toISOString())
                : 'No activity yet'
            return (
              <article className="agent-library-row" key={record.id}>
                {record.profile ? (
                  <button
                    className={[
                      'selection-toggle',
                      'agent-library-row-select',
                      selectedAgentProfileIds.has(record.profile.id) ? 'selected' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    type="button"
                    aria-pressed={selectedAgentProfileIds.has(record.profile.id)}
                    aria-label={`Select ${record.name}`}
                    onClick={() => toggleAgentProfileSelected(record.profile?.id || '')}
                  >
                    <Check size={13} />
                  </button>
                ) : (
                  <span className="agent-library-row-select-spacer" aria-hidden="true" />
                )}
                <button
                  className="agent-library-main"
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => {
                    const next = expanded ? '' : record.id
                    setExpandedAgentId(next)
                    if (!next) setExpandedAgentTranscriptId('')
                  }}
                >
                  <span className="agent-library-source">
                    <Bot size={14} />
                    {record.historical ? 'Historical agent' : 'Agent profile'}
                  </span>
                  <span className="agent-library-title">{record.name}</span>
                  <span className="agent-library-meta">
                    {[
                      record.smartViewName || record.smartViews[0] || '',
                      latestAt,
                      record.voice,
                    ]
                      .filter(Boolean)
                      .join(' / ')}
                  </span>
                  <span className="agent-library-summary">
                    {[
                      `${record.sourceThreadCount} source threads`,
                      `${record.sourceMessageCount} source messages`,
                      `${record.callCount} calls`,
                      `${record.transcriptTurns} call turns`,
                      `${record.scoredTurns} scored turns`,
                      `${record.recordingCount} recordings`,
                      formatClock(record.totalSeconds),
                    ].join(' / ')}
                  </span>
                </button>
                <div className="agent-library-status">
                  {record.active && (
                    <span>
                      <CheckCircle2 size={13} />
                      Active
                    </span>
                  )}
                  <span>{record.sourceThreadCount} sources</span>
                  <span>{record.smsThreads} SMS</span>
                  <span>{record.emailThreads} email</span>
                  <span>{record.phoneCalls} phone</span>
                  <span>{record.playgroundCalls} playground</span>
                  <span>{record.outcomes[0] || 'No outcomes'}</span>
                </div>
                {expanded && (
                  <div className="agent-library-preview">
                    {record.profile && (
                      <div className="agent-library-context">
                        {renderAgentPromptEditor(record.profile)}
                        {renderContextEditor({
                          label: 'Agent context',
                          context: record.profile.context,
                          onChange: (nextContext) =>
                            void updateProfileContext(record.profile?.id || '', nextContext),
                          onRemoveFile: (context, fileId) =>
                            void removeContextFile(
                              {
                                scope: 'profile',
                                id: record.profile?.id || '',
                              },
                              context,
                              fileId,
                            ),
                          onUpload: (files) =>
                            void handleContextFiles(
                              {
                                scope: 'profile',
                                id: record.profile?.id || '',
                              },
                              files,
                            ),
                        })}
                      </div>
                    )}
                    <div className="agent-library-metrics">
                      <span>
                        <strong>Smart Views</strong>
                        {[
                          record.smartViewName,
                          ...record.smartViews,
                        ]
                          .filter(Boolean)
                          .join(', ') || 'None linked'}
                      </span>
                      <span>
                        <strong>Contacts</strong>
                        {record.leads.join(', ') || 'No matched contacts'}
                      </span>
                      <span>
                        <strong>Sources</strong>
                        {[
                          `${record.sourceThreadCount} threads`,
                          record.smsThreads ? `${record.smsThreads} SMS` : '',
                          record.emailThreads ? `${record.emailThreads} email` : '',
                        ]
                          .filter(Boolean)
                          .join(', ') || 'No source threads'}
                      </span>
                      <span>
                        <strong>Profile config IDs</strong>
                        {record.configIds.join(', ') || 'No profile config IDs'}
                      </span>
                      <span>
                        <strong>Outcomes</strong>
                        {record.outcomes.join(', ') || 'No outcomes'}
                      </span>
                    </div>
                    <div className="agent-library-call-list agent-library-source-list">
                      {record.communicationThreads.length === 0 ? (
                        <div className="empty-table-state">
                          <span>This agent has no matched source activity yet.</span>
                        </div>
                      ) : (
                        record.communicationThreads.map((thread) =>
                          renderAgentCommunicationThread(record, thread),
                        )
                      )}
                    </div>
                    <div className="agent-library-call-list">
                      {record.recentCalls.length === 0 ? (
                        <div className="empty-table-state">
                          <span>This agent has no matched calls yet.</span>
                        </div>
                      ) : (
                        record.recentCalls.map((call) =>
                          renderAgentCallTranscript(record, call),
                        )
                      )}
                    </div>
                  </div>
                )}
              </article>
            )
          })}
          {filteredAgentRecords.length === 0 && (
            <div className="empty-table-state">
              <span>No agents match this library view.</span>
            </div>
          )}
        </div>
      </section>
    )
  }

  return (
    <div className="app-shell" data-route-id={speakRouteIds.library}>
      <input
        ref={smartCsvInputRef}
        className="visually-hidden"
        type="file"
        accept=".csv,text/csv"
        onChange={handleSmartViewCsvUpload}
      />
      <main
        className={[
          'workspace',
          'library-workspace',
        ]
          .filter(Boolean)
          .join(' ')}
        data-route-id={speakRouteIds.library}
        data-testid={speakTestIds.libraryRoute}
      >
        <header className="topbar library-topbar" data-testid={speakTestIds.libraryTopbar}>
          <AppPrimaryNavigation
            active="library"
            basePath={basePath}
          />
          <div className="topbar-middle library-topbar-status">
            <GlobalSearchTrigger onClick={() => setGlobalSearchOpen(true)} />
            <AppearanceSwitch appearance={appearance} setAppearance={setAppearance} />
          </div>
        </header>

        <div className="library-layout">
          <aside className="library-views" aria-label="Smart Views">
            <div className="library-mode-switch" role="tablist" aria-label="Library mode">
              <button
                className={libraryMode === 'leads' ? 'active' : ''}
                type="button"
                role="tab"
                aria-selected={libraryMode === 'leads'}
                onClick={() => selectLibraryMode('leads')}
              >
                Contacts
              </button>
              <button
                className={libraryMode === 'transcripts' ? 'active' : ''}
                data-testid={speakTestIds.libraryActivityTab}
                type="button"
                role="tab"
                aria-selected={libraryMode === 'transcripts'}
                onClick={() => selectLibraryMode('transcripts')}
              >
                Activity
              </button>
              <button
                className={libraryMode === 'agents' ? 'active' : ''}
                type="button"
                role="tab"
                aria-selected={libraryMode === 'agents'}
                onClick={() => selectLibraryMode('agents')}
              >
                Agents
              </button>
            </div>
            {libraryMode === 'leads' ? (
              <>
                <div className="library-action-row">
                  <button
                    className="secondary-button library-personal-phone-action"
                    type="button"
                    title={
                      personalPhoneSyncing
                        ? 'Syncing personal phone contacts'
                        : 'Sync personal phone contacts'
                    }
                    aria-label={
                      personalPhoneSyncing
                        ? 'Syncing personal phone contacts'
                        : 'Sync personal phone contacts'
                    }
                    data-action-id={speakActionIds.syncPersonalPhoneSource}
                    disabled={personalPhoneSyncing}
                    onClick={() => void syncPersonalPhoneContacts()}
                  >
                    <PersonalPhoneMark />
                    <span className="visually-hidden">
                      {personalPhoneSyncing ? 'Syncing' : 'Personal phone'}
                    </span>
                  </button>
                  <button
                    className="secondary-button library-calltools-action"
                    type="button"
                    title={
                      calltoolsSyncing
                        ? 'Syncing CallTools campaign contacts'
                        : 'Sync CallTools campaign contacts'
                    }
                    aria-label={
                      calltoolsSyncing
                        ? 'Syncing CallTools campaign contacts'
                        : 'Sync CallTools campaign contacts'
                    }
                    data-action-id={speakActionIds.syncCallToolsSource}
                    disabled={calltoolsSyncing}
                    onClick={() => void syncCallToolsCampaignContacts()}
                  >
                    <CallToolsMark />
                    <span className="visually-hidden">
                      {calltoolsSyncing ? 'Syncing' : 'CallTools'}
                    </span>
                  </button>
                  <select
                    className="library-calltools-source-select"
                    value={selectedCalltoolsCampaign?.id || ''}
                    aria-label="CallTools campaign source"
                    disabled={calltoolsSyncing || calltoolsCampaigns.length === 0}
                    onChange={(event) => setSelectedCalltoolsCampaignId(event.target.value)}
                  >
                    {calltoolsCampaigns.length === 0 ? (
                      <option value="">No CallTools campaigns</option>
                    ) : (
                      calltoolsCampaigns.map((campaign) => (
                        <option key={campaign.id} value={campaign.id}>
                          {calltoolsCampaignLabel(campaign)}
                        </option>
                      ))
                    )}
                  </select>
                  <button
                    className="secondary-button library-icon-action"
                    type="button"
                    title="Add contact"
                    aria-label="Add contact"
                    data-action-id={speakActionIds.addLead}
                    data-testid={speakTestIds.addLeadButton}
                    onClick={addLead}
                  >
                    <Plus size={15} />
                    <span className="visually-hidden">Contact</span>
                  </button>
                  <button
                    className="secondary-button library-icon-action"
                    type="button"
                    title="Import CSV"
                    aria-label="Import CSV"
                    data-action-id={speakActionIds.importSmartViewCsv}
                    onClick={() => smartCsvInputRef.current?.click()}
                  >
                    <Upload size={15} />
                    <span className="visually-hidden">CSV</span>
                  </button>
                </div>
                <div className="library-source-list" aria-label="Contact sources">
                  {contactSourceOptions.map((source) => (
                    <button
                      className={
                        resolvedContactSourceKey === source.key
                          ? 'library-view active'
                          : 'library-view'
                      }
                      type="button"
                      key={source.key}
                      onClick={() => selectContactSource(source.key)}
                    >
                      <span>{source.label}</span>
                      <strong>{source.count}</strong>
                    </button>
                  ))}
                </div>
                {activeSmartViewId && (
                  <button
                    className="library-view"
                    type="button"
                    onClick={() => setActiveSmartViewId('')}
                  >
                    <span>
                      {`All ${activeContactSource?.label || 'contacts'}`}
                    </span>
                    <strong>{contactSourceLeads.length}</strong>
                  </button>
                )}
                {smartViews.map((view) => (
                  <div className="library-view-row" key={view.id}>
                    <button
                      className={view.id === activeSmartViewId ? 'library-view active' : 'library-view'}
                      type="button"
                      data-action-id={speakActionIds.selectSmartView}
                      onClick={() => setActiveSmartViewId(view.id)}
                    >
                      <span>{view.name}</span>
                      <strong>{smartViewCounts.get(view.id) ?? view.leadCount}</strong>
                    </button>
                    <button
                      className="icon-button"
                      type="button"
                      title={`Delete ${view.name}`}
                      aria-label={`Delete ${view.name}`}
                      onClick={() => void deleteSmartView(view.id)}
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
                <div className="library-smart-create">
                  <input
                    value={smartViewName}
                    placeholder="Smart View name"
                    aria-label="Smart View name"
                    autoCapitalize="words"
                    autoComplete="off"
                    autoCorrect="on"
                    enterKeyHint="done"
                    inputMode="text"
                    onChange={(event) => setSmartViewName(event.target.value)}
                  />
                  <button
                    className="secondary-button"
                    type="button"
                    data-action-id={speakActionIds.createSmartView}
                    onClick={saveSmartView}
                  >
                    <Save size={14} />
                    <span className="visually-hidden">Save view</span>
                  </button>
                </div>
                {renderLeadSidebarControls()}
              </>
            ) : libraryMode === 'agents' ? (
              <>
                {renderAgentSidebarControls()}
                <div className="agent-library-filters">
                  {[
                    ['all', 'All', agentStats.all],
                    ['active', 'Active', agentStats.active],
                    ['smart-view', 'Smart Views', agentStats.smartView],
                    ['used', 'Used', agentStats.used],
                    ['recorded', 'Recordings', agentStats.recorded],
                    ['scored', 'Scored', agentStats.scored],
                  ].map(([value, label, count]) => (
                    <button
                      className={agentSourceFilter === value ? 'library-view active' : 'library-view'}
                      type="button"
                      key={value}
                      onClick={() => setAgentSourceFilter(value as AgentSourceFilter)}
                    >
                      <span>{label}</span>
                      <strong>{count}</strong>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                {renderTranscriptSidebarControls()}
                <div className="transcript-library-filters">
                  {[
                    ['all', 'All', transcriptStats.all],
                    ['call', 'Phone', transcriptStats.phone],
                    ['sms', 'SMS', transcriptStats.sms],
                    ['email', 'Email', transcriptStats.email],
                    ['browser_test', 'Playground', transcriptStats.playground],
                    ['recorded', 'Recordings', transcriptStats.recorded],
                    ['scored', 'Scored', transcriptStats.scored],
                    ['unresolved', 'Unresolved', transcriptStats.unresolved],
                  ].map(([value, label, count]) => (
                    <button
                      className={
                        transcriptSourceFilter === value ? 'library-view active' : 'library-view'
                      }
                      type="button"
                      key={value}
                      onClick={() => setTranscriptSourceFilter(value as TranscriptSourceFilter)}
                    >
                      <span>{label}</span>
                      <strong>{count}</strong>
                    </button>
                  ))}
                </div>
              </>
            )}
          </aside>

          {libraryMode === 'transcripts'
            ? renderTranscriptLibrary()
            : libraryMode === 'agents'
              ? renderAgentLibrary()
              : renderContactLibrary()}
        </div>
        <GlobalSearchOverlay
          activeRoute="library"
          onClose={() => setGlobalSearchOpen(false)}
          open={globalSearchOpen}
        />
      </main>
    </div>
  )
}
