import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { generateKeyPairSync, sign } from 'node:crypto'
import { buildSpeakAgentContract, buildSpeakUiAdapterKit } from '../server/agent-contract.mjs'
import {
  automationProof,
  resolveInboundAutomationPolicy,
} from '../server/communication-automation.mjs'
import { speakFunctionTools } from '../server/hume-tools.mjs'

const failures = []
// These child-process bounds include a full backend import plus deliberately
// large workspace fixtures. Keep them below the production shutdown fence
// (60s minimum) without letting machine or full-audit load kill valid drains.
const DELIVERY_INTEGRATION_PROCESS_TIMEOUT_MS = 45_000
const DELIVERY_SHUTDOWN_PROCESS_TIMEOUT_MS = 30_000
const contract = buildSpeakAgentContract({
  basePath: process.env.BASE_PATH || '/speak',
  publicBaseUrl: process.env.PUBLIC_BASE_URL || 'https://speak.example.com/speak',
})
const uiAdapterKit = buildSpeakUiAdapterKit({
  basePath: process.env.BASE_PATH || '/speak',
  publicBaseUrl: process.env.PUBLIC_BASE_URL || 'https://speak.example.com/speak',
})

function makeTempDir(prefix) {
  fs.mkdirSync('.tmp', { recursive: true })
  return fs.mkdtempSync(path.join('.tmp', `${prefix}-`))
}

const requiredDocs = [
  'README.md',
  'AGENTS.md',
  'BRANDING.md',
  'docs/index.md',
  'docs/index.html',
  'docs/backend-api-reference.md',
  'docs/agent-integration.md',
  'docs/agent-reference.md',
  'docs/generative-ui-widgets.md',
  'docs/ui-reference.md',
  'docs/voice-provider-integration.md',
  'docs/communication-thread-model.md',
  'agent/skills/speak-operator/SKILL.md',
  'agent/skills/speak-operator/references/workflows.md',
]

const requiredTerms = [
  'communicationThread',
  'communicationMessage',
  'communicationTopic',
  'contactIdentityLink',
  'SMS',
  'email',
  'call',
  'Contact Memory',
  'unresolved-attribution',
]

requiredDocs.forEach((file) => {
  const text = read(file)
  if (!text) return
  if (!/communication[- ]thread|Communication[- ]thread|communicationThread/.test(text)) {
    failures.push(`${file}: missing communication-thread contract language`)
  }
})

const playbook = read('docs/communication-thread-model.md')
const backendApiReference = read('docs/backend-api-reference.md')
const agentIntegrationGuide = read('docs/agent-integration.md')
const agentReference = read('docs/agent-reference.md')
const voiceProviderIntegration = read('docs/voice-provider-integration.md')
const serverIndexSource = read('server/index.mjs')
const runtimeConfigSource = read('server/runtime-config.mjs')
const workspaceEmailCheckSource = read('scripts/check-workspace-email.mjs')
const configurationOptions = read('docs/configuration-options.md')
const speakOperatorSkill = read('agent/skills/speak-operator/SKILL.md')
const speakOperatorWorkflows = read('agent/skills/speak-operator/references/workflows.md')
const updateContactTool = speakFunctionTools.find((tool) => tool.name === 'update_contact')
const updateContactSchema = JSON.parse(updateContactTool?.parameters || '{}')
const portalLinkTool = speakFunctionTools.find((tool) => tool.name === 'send_portal_link')
const portalLinkSchema = JSON.parse(portalLinkTool?.parameters || '{}')
assert(
  updateContactSchema.required?.includes('details_confirmed') &&
    updateContactSchema.properties?.details_confirmed?.type === 'boolean',
  'update_contact schema must require explicit confirmation before any contact detail is persisted',
)
assert(
  portalLinkSchema.properties?.phone_confirmed?.type === 'boolean' &&
    portalLinkSchema.properties?.email_confirmed?.type === 'boolean',
  'send_portal_link schema must expose independent phone and email confirmation fields',
)
requiredTerms.forEach((term) => {
  if (!new RegExp(escapeRegExp(term), 'i').test(playbook)) {
    failures.push(`docs/communication-thread-model.md: missing required term ${term}`)
  }
})
if (!runtimeConfigSource.includes("numberEnv('WORKSPACE_EMAIL_AUTH_CHECK_TIMEOUT_MS', 60_000)")) {
  failures.push('Workspace email runtime auth proof must allow the bounded production GOG keyring startup window')
}
if (!runtimeConfigSource.includes("numberEnv('WORKSPACE_EMAIL_AUTH_CHECK_CACHE_MS', 300_000)")) {
  failures.push('Workspace email runtime auth proof must not continuously reopen the production GOG keyring')
}
if (!runtimeConfigSource.includes("numberEnv('WORKSPACE_EMAIL_AUTH_CHECK_RETRY_MS', 5_000)")) {
  failures.push('Workspace email failed auth probes must retry quickly after transient VM contention')
}
const serverListenSource = serverIndexSource.slice(
  serverIndexSource.indexOf('server.listen(PORT'),
  serverIndexSource.indexOf("for (const signal of ['SIGTERM', 'SIGINT'])"),
)
if (
  /await\s+refreshWorkspaceEmailReadiness\(\{\s*force:\s*true\s*\}\)/.test(
    serverIndexSource.slice(0, serverIndexSource.indexOf('server.listen(PORT')),
  ) ||
  !serverListenSource.includes('void refreshWorkspaceEmailReadiness({ force: true })')
) {
  failures.push('Speak must begin listening before Workspace email readiness runs in the background')
}
if (!workspaceEmailCheckSource.includes("numberEnv('WORKSPACE_EMAIL_AUTH_CHECK_TIMEOUT_MS', 60_000)")) {
  failures.push('Workspace email production checker must use the runtime auth-proof timeout default')
}
if (
  !/WORKSPACE_EMAIL_AUTH_CHECK_TIMEOUT_MS[^\n]*`60000`/.test(configurationOptions) ||
  !/WORKSPACE_EMAIL_AUTH_CHECK_CACHE_MS[^\n]*`300000`/.test(configurationOptions) ||
  !/WORKSPACE_EMAIL_AUTH_CHECK_RETRY_MS[^\n]*`5000`/.test(configurationOptions)
) {
  failures.push('Workspace email auth proof timeout/cache defaults are missing from configuration docs')
}
for (const snippet of [
  'state.pendingCommunicationEvents',
  'recordCommunicationEvents(records)',
  'flushStateCallCommunicationEvents(state)',
  'state.pendingCommunicationEvents.slice()',
  'state.pendingCommunicationEvents.splice(0, records.length)',
  'event.patch?.outcome || event.outcome || event.audio',
  'flushPendingCallCommunicationEvents()',
  'flushPersistedCallEvents()',
  'quiesceVoiceBackendWebSockets()',
]) {
  if (!serverIndexSource.includes(snippet)) {
    failures.push(`server/index.mjs: missing realtime communication persistence guard ${snippet}`)
  }
}
;[
  ['docs/communication-thread-model.md', playbook],
  ['docs/backend-api-reference.md', backendApiReference],
  ['docs/agent-integration.md', agentIntegrationGuide],
  ['docs/agent-reference.md', agentReference],
  ['docs/voice-provider-integration.md', voiceProviderIntegration],
].forEach(([file, text]) => {
  if (
    !/TELNYX_WEBHOOK_SIGNATURE_REQUIRED|webhook signature|signature enforcement|signature-verified/i.test(text) ||
    !/qa:telnyx-source-routing/.test(text)
  ) {
    failures.push(`${file}: missing Telnyx webhook signature readiness language`)
  }
})

const runtime = contract.runtime?.communicationThreads || {}
if (runtime.playbook !== 'docs/communication-thread-model.md') {
  failures.push('agent contract missing communication thread playbook path')
}
if (runtime.status !== 'implemented') {
  failures.push(`agent contract communicationThreads.status is ${runtime.status || 'missing'}`)
}
;[
  'read_communication_threads',
  'read_communication_thread',
  'read_communication_thread_messages',
  'read_contact_communication_memory',
].forEach((actionId) => {
  if (!runtime.currentReadActions?.includes(actionId)) {
    failures.push(`communicationThreads.currentReadActions missing ${actionId}`)
  }
  if (!contract.backend?.actions?.some((action) => action.id === actionId && action.callableByMcp)) {
    failures.push(`backend actions missing callable ${actionId}`)
  }
})
const sendCommunicationAction = contract.backend?.actions?.find(
  (action) => action.id === 'send_communication_message',
)
if (!sendCommunicationAction) {
  failures.push('backend actions missing send_communication_message')
} else {
  if (sendCommunicationAction.path !== '/api/communication-messages/send') {
    failures.push('send_communication_message action path must be /api/communication-messages/send')
  }
  if (sendCommunicationAction.callableByMcp !== false || sendCommunicationAction.risk !== 'high') {
    failures.push('send_communication_message must remain high-risk and non-MCP-callable')
  }
  const preconditions = (sendCommunicationAction.preconditions || []).join('\n')
  if (
    !/delivery\.smsConfigured=true/.test(preconditions) ||
    !/delivery\.emailConfigured=true/.test(preconditions) ||
    !/delivery\.emailSendAsConfigured=true/.test(preconditions) ||
    !/current-device sms: handoff/.test(preconditions)
  ) {
    failures.push('send_communication_message action must declare SMS/email delivery readiness preconditions')
  }
}
const syncWorkspaceEmailAction = contract.backend?.actions?.find(
  (action) => action.id === 'sync_workspace_email',
)
const recordCommunicationAction = contract.backend?.actions?.find(
  (action) => action.id === 'record_communication_event',
)
if (!recordCommunicationAction) {
  failures.push('backend actions missing record_communication_event')
} else {
  if (recordCommunicationAction.path !== '/api/communication-events') {
    failures.push('record_communication_event action path must be /api/communication-events')
  }
  if (
    recordCommunicationAction.callableByMcp !== false ||
    recordCommunicationAction.risk !== 'high'
  ) {
    failures.push('record_communication_event must remain high-risk and non-MCP-callable')
  }
  if (!recordCommunicationAction.requestSchema?.properties?.allowAutomation) {
    failures.push('record_communication_event schema must expose explicit allowAutomation')
  }
}
if (!syncWorkspaceEmailAction) {
  failures.push('backend actions missing sync_workspace_email')
} else {
  if (syncWorkspaceEmailAction.path !== '/api/workspace-email/sync') {
    failures.push('sync_workspace_email action path must be /api/workspace-email/sync')
  }
  if (syncWorkspaceEmailAction.callableByMcp !== false || syncWorkspaceEmailAction.risk !== 'high') {
    failures.push('sync_workspace_email must remain high-risk and non-MCP-callable')
  }
  if (
    !syncWorkspaceEmailAction.requestSchema?.properties?.account ||
    !syncWorkspaceEmailAction.requestSchema?.properties?.authAccount
  ) {
    failures.push('sync_workspace_email schema must preserve mailbox account and GOG auth account fields')
  }
  if (
    !/delivery\.emailSourceReadConfigured=true/.test(
      (syncWorkspaceEmailAction.preconditions || []).join('\n'),
    )
  ) {
    failures.push('sync_workspace_email action must declare source-read readiness precondition')
  }
}
;['call', 'sms', 'email', 'browser_test', 'operator_chat', 'tool', 'system'].forEach((channel) => {
  if (!runtime.channels?.includes(channel)) {
    failures.push(`agent contract communicationThreads.channels missing ${channel}`)
  }
})
if (!/ambiguous inbound attribution remains unresolved/i.test(runtime.invariant || '')) {
  failures.push('agent contract communication thread invariant missing unresolved attribution rule')
}
if (!/full transcripts, SMS, or email bodies are retrieved only when relevant/i.test(runtime.memoryRule || '')) {
  failures.push('agent contract communication memory rule missing bounded retrieval rule')
}

const schemas = contract.dataSchemas || {}
requireSchema('communicationThread', schemas.communicationThread)
requireSchema('communicationMessage', schemas.communicationMessage)
requireSchema('communicationTopic', schemas.communicationTopic)
requireSchema('contactIdentityLink', schemas.contactIdentityLink)

const messageChannels = schemas.communicationMessage?.properties?.channel?.enum || []
;['call', 'sms', 'email'].forEach((channel) => {
  if (!messageChannels.includes(channel)) {
    failures.push(`communicationMessage.channel missing ${channel}`)
  }
})
;['messageCount', 'emotionScoreTurns', 'hasEmotionScores', 'latestChannel'].forEach((field) => {
  if (!schemas.communicationThread?.properties?.[field]) {
    failures.push(`communicationThread schema missing ${field}`)
  }
})
if (schemas.communicationMessage?.properties?.emotionScores?.type !== 'object') {
  failures.push('communicationMessage.emotionScores schema must preserve provider score maps')
}

const identityKinds = schemas.contactIdentityLink?.properties?.kind?.enum || []
;['phone', 'email', 'external_thread'].forEach((kind) => {
  if (!identityKinds.includes(kind)) {
    failures.push(`contactIdentityLink.kind missing ${kind}`)
  }
})

if (!contract.mcpGeneration?.validationCommands?.includes('npm run qa:communication-threads')) {
  failures.push('mcpGeneration validation commands missing npm run qa:communication-threads')
}
if (!uiAdapterKit.validation?.localCommands?.includes('npm run qa:communication-threads')) {
  failures.push('uiAdapterKit validation commands missing npm run qa:communication-threads')
}
if (!runtime.productionValidationCommands?.includes('npm run qa:telnyx-source-routing')) {
  failures.push('communicationThreads production validation missing npm run qa:telnyx-source-routing')
}
if (!runtime.productionValidationCommands?.includes('npm run qa:workspace-email')) {
  failures.push('communicationThreads production validation missing npm run qa:workspace-email')
}
if (!runtime.productionValidationCommands?.includes('npm run qa:workspace-email-source')) {
  failures.push('communicationThreads production validation missing npm run qa:workspace-email-source')
}
if (!/signature verification before source persistence/i.test(runtime.sourceIngressRule || '')) {
  failures.push('communicationThreads sourceIngressRule must require Telnyx signature verification before persistence')
}

for (const [file, text] of [
  ['agent/skills/speak-operator/SKILL.md', speakOperatorSkill],
  ['agent/skills/speak-operator/references/workflows.md', speakOperatorWorkflows],
  ['BRANDING.md', read('BRANDING.md')],
  ['AGENTS.md', read('AGENTS.md')],
  ['README.md', read('README.md')],
  ['docs/communication-thread-model.md', read('docs/communication-thread-model.md')],
]) {
  if (/future email|future one-pane conversation|one-pane chat does not exist yet|unified conversation pane exists|one-pane contact conversation UI|current production readback uses recent call\/config-test history/i.test(text)) {
    failures.push(`${file}: contains stale communication-history future-state language`)
  }
}
for (const [file, text] of [
  ['agent/skills/speak-operator/SKILL.md', speakOperatorSkill],
  ['agent/skills/speak-operator/references/workflows.md', speakOperatorWorkflows],
]) {
  for (const token of [
    '/api/communication-threads',
    '/api/communication-threads/{threadId}/messages',
    '/api/contacts/{contactId}/communication-memory',
  ]) {
    if (!text.includes(token)) {
      failures.push(`${file}: missing current communication-thread read API ${token}`)
    }
  }
}

const readiness = contract.readiness
if (readiness && !JSON.stringify(readiness).includes('communication_thread_contract')) {
  failures.push('contract readiness payload missing communication_thread_contract')
}

const libraryWorkspace = read('src/LibraryWorkspace.tsx')
const communicationThreadMessages = read('src/CommunicationThreadMessages.tsx')
const communicationThreadMessageUtils = read('src/communicationThreadMessageUtils.ts')
const dialerTranscript = read('src/CallTranscriptConsole.tsx')
const playgroundPanel = read('src/ConfigurationTestPanel.tsx')
const transcriptLabels = read('src/transcriptLabels.ts')
const serverIndex = read('server/index.mjs')
const speakMcp = read('server/speak-mcp.mjs')
const providerHttp = read('server/provider-http.mjs')
const telnyxWebhookNormalizer = read('server/telnyx-webhook-normalizer.mjs')
const telnyxWebhookSignature = read('server/telnyx-webhook-signature.mjs')
const telnyxSourceRoutingCheck = read('scripts/check-telnyx-source-routing.mjs')
const runtimeConfig = read('server/runtime-config.mjs')
const workspaceStore = read('server/workspace-store.mjs')
const workspaceEmailNormalizer = read('server/workspace-email-normalizer.mjs')
const workspaceEmailSync = read('server/workspace-email-sync.mjs')
const syncWorkspaceEmailScript = read('scripts/sync-workspace-email.mjs')
const checkWorkspaceEmailSourceScript = read('scripts/check-workspace-email-source-sample.mjs')
const repairWorkspaceEmailThreadIdentityScript = read(
  'scripts/repair-workspace-email-thread-identity.mjs',
)
const repairCommunicationSourceDedupScript = read(
  'scripts/repair-communication-source-dedup.mjs',
)
const repairDefaultOffInboundCallScript = read(
  'scripts/repair-default-off-inbound-calls.mjs',
)
const repairWorkspaceEmailSendAsScript = read('scripts/repair-workspace-email-sendas.mjs')
const completeWorkspaceEmailSendAsAuthScript = read(
  'scripts/complete-workspace-email-sendas-auth.mjs',
)
const packageJson = read('package.json')
if (!/fetch\(apiUrl\('\/communication-threads\?limit=500'\)\)/.test(libraryWorkspace)) {
  failures.push('LibraryWorkspace does not fetch communication threads for current Activity view')
}
if (!/params\.get\('thread'\)/.test(libraryWorkspace)) {
  failures.push('LibraryWorkspace does not handle #thread deep links')
}
if (!/transcript-thread-status/.test(libraryWorkspace)) {
  failures.push('LibraryWorkspace missing visible communication thread status')
}
if (!/communicationThreadSearchText/.test(libraryWorkspace)) {
  failures.push('LibraryWorkspace does not include communication threads in Activity search')
}
if (
  !/communicationThreadMessages/.test(libraryWorkspace) ||
  !/sourceThreadIds/.test(libraryWorkspace) ||
  !/missingThreadIds\.map/.test(libraryWorkspace) ||
  !/\/communication-threads\/\$\{encodeURIComponent\(threadId\)\}\/messages/.test(libraryWorkspace)
) {
  failures.push('LibraryWorkspace does not fetch communication thread messages on Activity expansion')
}
if (!/CommunicationThreadMessagesView/.test(libraryWorkspace) || !/ChatMessageBody/.test(communicationThreadMessages)) {
  failures.push('LibraryWorkspace transcript/activity bubbles do not use the shared communication message renderer')
}
if (
  !/function communicationThreadContextForCall\(call: RecentCallSummary\)[\s\S]*communicationThreadsByCallId\.get\(call\.callControlId\)[\s\S]*communicationMessagesForRecentCall\(call, threadId\)/.test(libraryWorkspace) ||
  (libraryWorkspace.match(/<CommunicationThreadMessagesView/g) || []).length < 3
) {
  failures.push('LibraryWorkspace contact, agent, and Activity histories must all render through CommunicationThreadMessagesView')
}
if (
  !/communicationThreadAgentKeys/.test(libraryWorkspace) ||
  !/communicationThreads\.forEach\(\(thread\) =>/.test(libraryWorkspace) ||
  !/record\.communicationThreads\.push\(thread\)/.test(libraryWorkspace) ||
  !/function renderAgentCommunicationThread/.test(libraryWorkspace) ||
  !/agent-library-source-list/.test(libraryWorkspace) ||
  !/record\.communicationThreads\.map\(\(thread\) =>[\s\S]*renderAgentCommunicationThread\(record, thread\)/.test(libraryWorkspace)
) {
  failures.push('Library Agent mode must index and render provider-neutral source threads, not only recent call records')
}
if (
  !/contactActivityThreadByLeadId/.test(libraryWorkspace) ||
  !/function renderContactSourceHistory\(lead: Lead, thread\?: CommunicationThreadSummary\)/.test(libraryWorkspace) ||
  !/contact-library-source-history/.test(libraryWorkspace) ||
  !/Source history/.test(libraryWorkspace) ||
  !/communicationThreadMergedMessages\(thread\)/.test(libraryWorkspace) ||
  !/reloadCommunicationThreadMessages\(missingThreadIds, contactThread\.threadId\)/.test(libraryWorkspace) ||
  /Call history/.test(libraryWorkspace)
) {
  failures.push('Library expanded Contact rows must render one unified source-history thread instead of call-only history')
}
if (/renderTranscriptEntry/.test(libraryWorkspace) || /turns\.map\(\(entry/.test(libraryWorkspace)) {
  failures.push('LibraryWorkspace must not use a separate raw transcript-entry renderer for contact or agent history')
}
if (!/CommunicationThreadMessageItem[\s\S]*<ChatMessageBody[\s\S]*text=\{body\}/.test(communicationThreadMessages)) {
  failures.push('shared communication Activity message bubbles missing shared copy action body')
}
if (
  !/communicationMessageSpeakerClass/.test(communicationThreadMessageUtils) ||
  !/communicationMessageSpeakerClass\(message\)/.test(communicationThreadMessages)
) {
  failures.push('communication Activity messages do not delegate sender/recipient bubble classes')
}
if (!/normalized === 'ai'[\s\S]*return 'speaker-lead'/.test(transcriptLabels)) {
  failures.push('transcript agent/assistant turns must use the fixed sent/dark bubble class')
}
if (!/normalized === 'lead'[\s\S]*return 'speaker-ai'/.test(transcriptLabels)) {
  failures.push('transcript lead/contact turns must use the received/readback bubble class')
}
if (!/role === 'agent' \|\| message\.direction === 'outbound'\)[\s\S]*return 'speaker-lead'/.test(communicationThreadMessageUtils)) {
  failures.push('communication outbound/agent messages must use the fixed sent/dark bubble class')
}
if (!/role === 'contact' \|\| message\.direction === 'inbound'\)[\s\S]*return 'speaker-ai'/.test(communicationThreadMessageUtils)) {
  failures.push('communication inbound/contact messages must use the received/readback bubble class')
}
if (!/TranscriptEmotionScores/.test(communicationThreadMessages) || !/scores=\{message\.emotionScores\}/.test(communicationThreadMessages)) {
  failures.push('communication Activity messages do not render provider emotion scores when available')
}
if (!/smsReceived[\s\S]*message\.role === 'contact'[\s\S]*message\.role === 'user'/.test(communicationThreadMessages)) {
  failures.push('contact/user SMS messages must always receive the iMessage blue class regardless of direction availability')
}
const appCss = read('src/App.css')
if (!/\.communication-message-entry\.channel-sms\.sms-received[\s\S]*#007aff/.test(appCss) || !/#0a84ff/.test(appCss)) {
  failures.push('SMS received/contact bubbles must keep iMessage blue in light and dark/system appearances')
}
if (!/\.communication-message-entry\.channel-sms\.sms-sent[\s\S]*#1d1d20/.test(appCss)) {
  failures.push('SMS sent/outbound bubbles must keep the fixed sent/dark treatment')
}
const indexCss = read('src/index.css')
if (!/--communication-email-bg:\s*#5e5788/.test(indexCss)) {
  failures.push('email communication channel must use the fixed Speak purple token')
}
if (!/\.communication-message-entry\.channel-email[\s\S]*var\(--communication-email-bg\)/.test(appCss)) {
  failures.push('email communication bubbles must use the fixed purple channel treatment')
}
if (
  !/\.contact-library-field:has\(> \.contact-delivery-composer\)\s*\{[\s\S]*grid-column:\s*span 2/.test(appCss) ||
  !/\.contact-library-field:has\(> \.contact-delivery-composer\) \.contact-delivery-composer\s*\{[\s\S]*z-index:\s*2/.test(appCss)
) {
  failures.push('Library contact SMS/email composers must reserve grid space and avoid adjacent field overlap')
}
if (!/\.communication-email-subject strong\s*\{[\s\S]*color:\s*inherit/.test(appCss)) {
  failures.push('collapsed email subjects must keep full bubble text contrast')
}
if (!/\.communication-message-entry\.channel-email \.chat-message-body\.is-collapsed::after\s*\{[\s\S]*display:\s*none/.test(appCss)) {
  failures.push('collapsed email subjects must not be covered by the shared message fade')
}
if (!/parseEmailMessageBody/.test(communicationThreadMessages) || !/Read email/.test(communicationThreadMessages)) {
  failures.push('email communication messages must render subject-first with a body expand affordance')
}
if (
  !/\^Subject:\\s\*\(\[\^\\n\\r\]\*\)\(\?:\\r\?\\n\(\?:\\r\?\\n\)\?\(\[\\s\\S\]\*\)\)\?\$/.test(
    communicationThreadMessages,
  ) ||
  !/collapsedChildren=\{collapsedBody\}/.test(communicationThreadMessages) ||
  !/forceCollapsible=\{Boolean\(parsedEmail\?\.body\)\}/.test(communicationThreadMessages)
) {
  failures.push('email communication messages must keep subject visible while preserving single-newline and blank-line bodies behind the expand affordance')
}
if (
  !/function communicationMessagePreview/.test(workspaceStore) ||
  !/function emailSubjectPreview/.test(workspaceStore) ||
  !/latestMessagePreview:\s*communicationMessagePreview\(latest\)/.test(workspaceStore) ||
  !/summary = messages\.length \? summarizeCommunicationMessages\(messages\) : thread\.summary/.test(
    workspaceStore,
  )
) {
  failures.push('communication thread summaries/previews must collapse email messages to subject-only from persisted message bodies')
}
if (!/ReplyActionButton/.test(communicationThreadMessages) || !/CommunicationReplyComposer/.test(communicationThreadMessages)) {
  failures.push('received SMS/email communication messages must expose a shared reply action')
}
if (!/onMessageSent/.test(communicationThreadMessages) || !/reloadKey/.test(communicationThreadMessages)) {
  failures.push('source-history reply sends must refresh the open CommunicationThreadMessages pane')
}
if (!/providerIds\.fromEmails/.test(communicationThreadMessages) || !/providerIds\.toEmails/.test(communicationThreadMessages) || !/Array\.isArray\(value\)/.test(communicationThreadMessages)) {
  failures.push('communication reply actions must resolve SMS/email targets from provider participant arrays')
}
const contactDeliveryActions = read('src/ContactDeliveryActions.tsx')
const contactDeliveryUtils = read('src/ContactDeliveryUtils.ts')
if (!/Agent number/.test(contactDeliveryActions) || !/Current device/.test(contactDeliveryActions)) {
  failures.push('SMS replies must offer both agent-number and current-device sending paths')
}
if (!/sendCommunicationMessage/.test(contactDeliveryUtils) || !/\/communication-messages\/send/.test(contactDeliveryUtils)) {
  failures.push('agent-number SMS/email sends must route through the backend proof endpoint')
}
if (!/typeof payload\.message === 'string'/.test(contactDeliveryUtils)) {
  failures.push('agent-number SMS/email sends must surface backend readiness messages, not only error codes')
}
if (
  !/useDeliveryReadiness/.test(contactDeliveryActions) ||
  !/fetch\(apiUrl\('\/health'\)\)/.test(contactDeliveryActions) ||
  !/payload\.delivery\?\.smsConfigured/.test(contactDeliveryActions) ||
  !/payload\.delivery\?\.emailConfigured/.test(contactDeliveryActions) ||
  !/payload\.delivery\?\.emailSendAsConfigured/.test(contactDeliveryActions) ||
  !/deliveryReadiness\.emailConfigured && deliveryReadiness\.emailSendAsConfigured !== false/.test(contactDeliveryActions) ||
  !/Workspace email send-as is not ready/.test(contactDeliveryActions)
) {
  failures.push('backend SMS/email reply composers must preflight /api/health delivery readiness before sending')
}
if (
  !/sms_not_configured/.test(serverIndex) ||
  !/workspace_email_not_ready/.test(serverIndex) ||
  !/workspaceEmailGmailAuthConfigured\(\)[\s\S]*workspaceEmailSendAsConfigured\(\)[\s\S]*sendEmail/.test(serverIndex)
) {
  failures.push('/api/communication-messages/send must fail closed on SMS/email readiness before provider delivery')
}
if (!/onSent\?:/.test(contactDeliveryActions) || !/onSent\?\.\(result\)/.test(contactDeliveryActions)) {
  failures.push('agent-number SMS/email reply composers must expose backend send proof to refresh source threads')
}
if (!/SmsFieldActions/.test(libraryWorkspace) || !/EmailFieldAction/.test(libraryWorkspace)) {
  failures.push('Library contact fields must expose SMS and email delivery actions')
}
if (!/SmsFieldActions/.test(read('src/LeadTable.tsx')) || !/EmailFieldAction/.test(read('src/LeadTable.tsx'))) {
  failures.push('Dialer contact detail fields must expose SMS and email delivery actions')
}
if (
  !/async function handleSendTextMessageTool[\s\S]*communication:\s*\{[\s\S]*channel:\s*'sms'[\s\S]*identity:\s*\{[\s\S]*phone[\s\S]*providerIds:\s*cleanObject\(\{[\s\S]*messageId:\s*proof\.message_id[\s\S]*providerLinks:\s*proof\.message_id/.test(serverIndex)
) {
  failures.push('voice-agent send_text_message tool events must persist SMS identity, provider IDs, and provider links')
}
if (
  !/async function handleSendEmailTool[\s\S]*communication:\s*\{[\s\S]*channel:\s*'email'[\s\S]*identity:\s*\{[\s\S]*email[\s\S]*externalThreadId:\s*proof\.thread_id[\s\S]*providerIds:\s*cleanObject\(\{[\s\S]*messageId:\s*proof\.message_id[\s\S]*emailThreadId:\s*proof\.thread_id[\s\S]*providerLinks:\s*\[/.test(serverIndex)
) {
  failures.push('voice-agent send_email tool events must persist email identity, provider IDs, and provider links')
}
const sendTextToolSource = serverIndex.slice(
  serverIndex.indexOf('async function handleSendTextMessageTool'),
  serverIndex.indexOf('async function handleSendEmailTool'),
)
const sendEmailToolSource = serverIndex.slice(
  serverIndex.indexOf('async function handleSendEmailTool'),
  serverIndex.indexOf('async function settleSmsBackgroundDelivery'),
)
if (
  sendTextToolSource.indexOf('if (!truthy(args.destination_confirmed))') < 0 ||
  sendTextToolSource.indexOf('if (!truthy(args.destination_confirmed))') >
    sendTextToolSource.indexOf('queueVoiceBackgroundDelivery(state, {')
) {
  failures.push('voice-agent send_text_message must require confirmed destination before provider delivery')
}
if (
  !sendTextToolSource.includes('queueVoiceBackgroundDelivery(state, {') ||
  !sendTextToolSource.includes('payload: {') ||
  !serverIndex.includes('return sendTextMessage(payload.phone, payload.message)') ||
  !sendTextToolSource.includes("provider: 'telnyx'") ||
  /calltools/i.test(sendTextToolSource)
) {
  failures.push('voice-agent send_text_message must queue the shared Telnyx delivery path, never native CallTools SMS')
}
if (
  sendEmailToolSource.indexOf('if (!truthy(args.destination_confirmed))') < 0 ||
  sendEmailToolSource.indexOf('if (!truthy(args.destination_confirmed))') >
    sendEmailToolSource.indexOf('queueVoiceBackgroundDelivery(state, {')
) {
  failures.push('voice-agent send_email must require confirmed destination before provider delivery')
}
if (
  !sendEmailToolSource.includes('queueVoiceBackgroundDelivery(state, {') ||
  !sendEmailToolSource.includes('payload: {') ||
  !serverIndex.includes('return sendEmail(payload.email, payload.subject, payload.body)') ||
  !sendEmailToolSource.includes("provider: 'google_workspace'") ||
  /calltools/i.test(sendEmailToolSource)
) {
  failures.push('voice-agent send_email must queue the shared Workspace delivery path, never native CallTools email')
}
if (
  !serverIndex.includes('rememberBackgroundDeliveryResult(state, outcome)') ||
  !serverIndex.includes('notifyVoiceOfBackgroundDelivery(state, outcome)') ||
  !serverIndex.includes('trackBackgroundDelivery(') ||
  !serverIndex.includes('createDurableBackgroundDeliveryOutbox({') ||
  !serverIndex.includes('await backgroundDeliveryOutbox.admit({') ||
  !serverIndex.includes('await backgroundDeliveryOutbox.close({ drain: true })') ||
  !serverIndex.includes('await drainDeliveryOperations()') ||
  !serverIndex.includes('state.backgroundDeliveryRequests ||= new Map()') ||
  !serverIndex.includes('dedupeDestination: phone') ||
  !serverIndex.includes('dedupeDestination: email') ||
  !serverIndex.includes('deduplicated: Boolean(queued.deduplicated)') ||
  !serverIndex.includes('hasPendingBackgroundDelivery(state)') ||
  !serverIndex.includes('sent: false') ||
  !serverIndex.includes("status: queued.result.pending ? 'processing' : queued.result.status")
) {
  failures.push('background voice delivery must return processing immediately, retain completion proof, and notify the active voice session')
}
if (
  !serverIndex.includes('observeTelnyxSmsFinalization(payload, { eventType })') ||
  !serverIndex.includes('await waitForTelnyxSmsFinalization(outcome.providerResult') ||
  !serverIndex.includes("provider_status: finalization.provider_status") ||
  !serverIndex.includes('delivery_finalized: true') ||
  !serverIndex.includes("status: 'accepted_unverified'")
) {
  failures.push('voice SMS delivery must remain processing until correlated Telnyx finalization or bounded readback proves delivered, failed, or unverified')
}
const shutdownSource = serverIndex.slice(
  serverIndex.indexOf('async function shutdownVoiceBackend'),
  serverIndex.indexOf('function stripBasePath'),
)
if (
  shutdownSource.indexOf('await quiesceVoiceBackendWebSockets()') < 0 ||
  shutdownSource.indexOf('await quiesceVoiceBackendWebSockets()') >
    shutdownSource.indexOf('await drainDeliveryOperations()') ||
  !shutdownSource.includes('const httpServerClosed = beginHttpServerShutdown()') ||
  !shutdownSource.includes('await httpServerClosed') ||
  !shutdownSource.includes('server.closeIdleConnections?.()') ||
  !shutdownSource.includes('sseClients.clear()') ||
  !shutdownSource.includes('while (deliveryDrainPromises.size > 0)') ||
  shutdownSource.includes('setTimeout(resolve, 8_000)') ||
  !serverIndex.includes("reason: 'service_shutting_down'")
) {
  failures.push('voice backend shutdown must quiesce new work before fully draining provider delivery and proof persistence')
}
const directDeliveryRouteStart = serverIndex.indexOf(
  "app.post('/api/communication-messages/send'",
)
const directDeliveryRouteEnd = serverIndex.indexOf('\napp.', directDeliveryRouteStart + 1)
const directDeliveryRoute = serverIndex.slice(
  directDeliveryRouteStart,
  directDeliveryRouteEnd > directDeliveryRouteStart
    ? directDeliveryRouteEnd
    : serverIndex.length,
)
const directSmsRouteSource = directDeliveryRoute.slice(
  directDeliveryRoute.indexOf("if (channel === 'sms')"),
  directDeliveryRoute.indexOf('\n    const email ='),
)
if (
  !directDeliveryRoute.includes('const deliveryAdmission = beginDeliveryAdmission()') ||
  !directDeliveryRoute.includes('deliveryAdmission.finish()') ||
  !directDeliveryRoute.includes('trackDeliveryOperation(') ||
  !serverIndex.includes('trackDeliveryOperation(recordAutomatedSmsReply(') ||
  !serverIndex.includes('recordAutomatedEmailReply({ policy, recorded, subject, target })') ||
  !serverIndex.includes('if (shutdownStarted) return null')
) {
  failures.push('direct and automated delivery provider/proof operations must drain independently of client sockets')
}
const automatedSmsReplySource = serverIndex.slice(
  serverIndex.indexOf('async function recordAutomatedSmsReply'),
  serverIndex.indexOf('async function recordAutomatedEmailReply'),
)
if (
  !directSmsRouteSource.includes('provider_accepted: true') ||
  !directSmsRouteSource.includes('delivery_finalized: false') ||
  !directSmsRouteSource.includes('sent: false') ||
  !directSmsRouteSource.includes("status: 'provider_accepted'") ||
  !directSmsRouteSource.includes('queueSmsDeliveryFinalizationRecord({') ||
  directSmsRouteSource.includes('sent: true')
) {
  failures.push('direct SMS sends must report provider acceptance without claiming sent or delivered and continue finalization in the background')
}
if (
  !automatedSmsReplySource.includes("action: 'auto_reply_provider_accepted'") ||
  !automatedSmsReplySource.includes('smsProviderAcceptanceProof({ phone, sms })') ||
  !automatedSmsReplySource.includes('queueSmsDeliveryFinalizationRecord({') ||
  automatedSmsReplySource.includes("action: 'auto_reply_sent'") ||
  !serverIndex.includes('function smsProviderAcceptanceProof') ||
  !serverIndex.includes('provider_accepted: true') ||
  !serverIndex.includes('delivery_finalized: false')
) {
  failures.push('inbound SMS automation must persist provider acceptance truthfully and settle final delivery without a second provider send')
}
if (
  !contactDeliveryUtils.includes('payload.provider_accepted !== true') ||
  !contactDeliveryActions.includes('Text accepted; delivery pending.')
) {
  failures.push('operator SMS UI must treat provider acceptance as a pending success without saying the text was sent')
}
if (
  !serverIndex.includes("message.type === 'response.created'") ||
  !serverIndex.includes('state.inworldInstructionWaitForFollowingResponse') ||
  !serverIndex.includes('state.inworldResponseActive || state.assistantResponseActive')
) {
  failures.push('Inworld background-delivery completion guidance must survive an already-active response')
}
if (!/delivery:\s*\{[\s\S]*linkConfigured:\s*Boolean\(getSpeakLinkUrl\(\)\)/.test(serverIndex)) {
  failures.push('backend delivery readiness must expose configured compatibility-link status')
}
const sandboxDeliveryGuardSource = serverIndex.slice(
  serverIndex.indexOf('function blockSandboxedPlaygroundDelivery'),
  serverIndex.indexOf('function publicRuntimeConfig'),
)
const codexToolExecutorSource = serverIndex.slice(
  serverIndex.indexOf('setCodexClmToolExecutor'),
  serverIndex.indexOf('function publicRuntimeConfig'),
)
const sharedToolExecutorSource = serverIndex.slice(
  serverIndex.indexOf('async function executeSpeakToolCall'),
  serverIndex.indexOf('async function handleSendPortalLinkTool'),
)
if (
  !sandboxDeliveryGuardSource.includes("['send_text_message', 'send_email', 'send_portal_link']") ||
  !sandboxDeliveryGuardSource.includes("reason: 'configuration_test_delivery_disabled'") ||
  !codexToolExecutorSource.includes('blockSandboxedPlaygroundDelivery(state, name)') ||
  !sharedToolExecutorSource.includes('blockSandboxedPlaygroundDelivery(state, name)')
) {
  failures.push('every voice runtime must block sandboxed Playground delivery before shared tool execution')
}
const inworldSessionBuilderSource = serverIndex.slice(
  serverIndex.indexOf('function buildInworldSession'),
  serverIndex.indexOf('function inworldReasoningEffort'),
)
if (
  !inworldSessionBuilderSource.includes('inworldSessionToolsEnabled(state)') ||
  inworldSessionBuilderSource.includes('!isBrowserTestSandbox(state)')
) {
  failures.push('sandboxed Inworld Playground sessions must expose shared tools behind the delivery guard')
}
if (
  !/buildStartPayload:[\s\S]*productionContext: true[\s\S]*testVariables: buildConfigurationTestVariables\(\)/.test(
    read('src/AgentConfigWorkspace.tsx'),
  )
) {
  failures.push('normal Playground sessions must opt into production-style shared tools while still avoiding a phone call')
}
if (!/communicationThreadForActivityGroup/.test(libraryWorkspace) || !/communicationMessagesForRecentCalls/.test(libraryWorkspace)) {
  failures.push('Library Activity must merge recent call transcripts into communication threads')
}
if (!/reloadCommunicationThreadMessages/.test(libraryWorkspace) || !/onMessageSent=\{\(\{ message, result \}\)/.test(libraryWorkspace) || !/void refreshLibrary\(\)/.test(libraryWorkspace)) {
  failures.push('Library Activity expanded contact threads must reload stored source messages and row summaries after proof-backed replies')
}
if (
  !/latestChannel/.test(libraryWorkspace) ||
  !/function orderedCommunicationThreadChannels\(thread: CommunicationThreadSummary\)[\s\S]*communicationThreadPrimaryChannel\(thread\)[\s\S]*\.\.\.\(thread\.channels \|\| \[\]\)/.test(libraryWorkspace) ||
  !/className="transcript-library-source"[\s\S]*communicationThreadPrimaryChannel\(thread\)[\s\S]*communicationThreadChannelSummary\(thread\)/.test(libraryWorkspace) ||
  !/case 'source':[\s\S]*communicationThreadChannelSummary\(left\)[\s\S]*communicationThreadChannelSummary\(right\)/.test(libraryWorkspace)
) {
  failures.push('Library Activity row source text must show the full channel set with latestChannel first, and source sorting must use that visible channel summary')
}
if (
  !/function communicationThreadPreviewText\(thread\?: CommunicationThreadSummary\)[\s\S]*latestMessagePreview[\s\S]*summary/.test(libraryWorkspace) ||
  !/className="transcript-library-summary"[\s\S]*communicationThreadPreviewText\(thread\)/.test(libraryWorkspace) ||
  !/latestSourceIsCall \? latestCallSummary : communicationThreadPreviewText\(latestThread\)/.test(libraryWorkspace)
) {
  failures.push('Library Activity row previews must show the newest source message before broader thread summaries')
}
if (!/activityGroupKeyForThread/.test(libraryWorkspace) || !/activityGroupKeyForRecentCall/.test(libraryWorkspace)) {
  failures.push('Library Activity must group source history by contact before falling back to individual activity')
}
if (!/providerSourceId = providerEventId \|\| sourceEventId/.test(communicationThreadMessageUtils)) {
  failures.push('shared Activity/source-history message dedupe must use provider event IDs for legacy source-message cleanup')
}
if (
  !/providerMessageId/.test(communicationThreadMessageUtils) ||
  !/providerSourceId = providerEventId \|\| sourceEventId \|\| providerMessageId/.test(communicationThreadMessageUtils) ||
  !/message\.provider/.test(communicationThreadMessageUtils)
) {
  failures.push('shared Activity/source-history message dedupe must mirror native provider source identity for SMS/email rows')
}
const providerSourceDedupeBlock = /if \(providerSourceId\) \{([\s\S]*?)\n  \}/.exec(communicationThreadMessageUtils)?.[1] || ''
const callProviderKeyIndex = providerSourceDedupeBlock.indexOf('const callProviderKey = [')
const callControlIdInCallProviderKey = providerSourceDedupeBlock.indexOf('callControlId', callProviderKeyIndex)
if (
  !providerSourceDedupeBlock ||
  !providerSourceDedupeBlock.includes('const providerKey = [') ||
  !providerSourceDedupeBlock.includes('message.provider') ||
  !providerSourceDedupeBlock.includes('providerSourceId') ||
  !providerSourceDedupeBlock.includes('keys.push(providerKey)') ||
  callProviderKeyIndex === -1 ||
  callControlIdInCallProviderKey === -1 ||
  !providerSourceDedupeBlock.includes('if (callControlId) keys.push(callProviderKey)')
) {
  failures.push('shared Activity/source-history message dedupe must not collapse same-channel messages unless a native provider/source id is present')
}
if (!/transcriptSourceEventId/.test(communicationThreadMessageUtils) || !/sourceEventId:\s*transcriptSourceEventId/.test(communicationThreadMessageUtils)) {
  failures.push('legacy transcript messages must carry sourceEventId keys so legacy system backfill rows dedupe away')
}
if (!/mergeCommunicationMessages\([\s\S]*linkedCallMessages[\s\S]*sourceThreadMessages/.test(libraryWorkspace)) {
  failures.push('Library Activity must prefer role-bearing recent-call turns when merging with durable source-thread messages')
}
if (!/fallbackMessages/.test(communicationThreadMessages) || !/mergeCommunicationMessages\(fallbackMessages, messages\)/.test(communicationThreadMessages)) {
  failures.push('shared communication message renderer must merge legacy transcript rows with provider thread messages')
}
if (!/communicationMessagesForRecentCall/.test(dialerTranscript) || !/fallbackMessages=\{fallbackMessages\}/.test(dialerTranscript)) {
  failures.push('CallTranscriptConsole linked source history must merge recent-call legacy messages before rendering')
}
if (
  !/selectedLeadCommunicationThreads/.test(dialerTranscript) ||
  !/selectedContactSourceThread/.test(dialerTranscript) ||
  !/Contact source history/.test(dialerTranscript) ||
  !/aria-label="Selected contact source history"/.test(dialerTranscript) ||
  !/selectedLeadCalls\.length === 0/.test(dialerTranscript)
) {
  failures.push('CallTranscriptConsole must render selected-contact SMS/email/missed-call source history even without call attempts')
}
if (
  !/showContactSourceHistory[\s\S]*thread\.threadId === selectedContactSourceThread\?\.threadId/.test(dialerTranscript)
) {
  failures.push('CallTranscriptConsole must suppress duplicate per-call source history when the selected contact thread is rendered')
}
if (!/communicationMessagesForTranscriptEntries/.test(playgroundPanel) || !/fallbackMessages=\{fallbackMessages\}/.test(playgroundPanel)) {
  failures.push('ConfigurationTestPanel linked source history must merge playground fallback messages before rendering')
}
if (!/sourceThreadsLoaded[\s\S]*loadingActivityMessages/.test(libraryWorkspace)) {
  failures.push('Library Activity must keep expansion in a loading state until fetched source messages are available')
}
;[
  'transcriptContactFilter',
  'transcriptAgentFilter',
  'transcriptDateFilter',
  'transcriptMinDurationFilter',
  'transcriptMinTurnsFilter',
].forEach((field) => {
  if (!libraryWorkspace.includes(field)) {
    failures.push(`Library Activity field filters missing ${field}`)
  }
})
if (
  !/communicationThreadDateFilterValue/.test(libraryWorkspace) ||
  !/Minimum call minutes/.test(libraryWorkspace) ||
  !/Minimum activity turns/.test(libraryWorkspace) ||
  !/Clear activity field filters/.test(libraryWorkspace)
) {
  failures.push('Library Activity must expose explicit date/contact/agent/call-time/turn field filters')
}
const activityPreviewStart = libraryWorkspace.indexOf('className="transcript-library-preview"')
const activityPreviewBlock =
  activityPreviewStart >= 0
    ? libraryWorkspace.slice(activityPreviewStart, activityPreviewStart + 900)
    : ''
if (!activityPreviewBlock || /order="asc"/.test(activityPreviewBlock)) {
  failures.push('Library Activity transcript preview must remain newest-first for the activity pane')
}
if (!activityPreviewBlock || !/order="desc"/.test(activityPreviewBlock)) {
  failures.push('Library Activity transcript preview must explicitly request newest-first ordering')
}
if (!/order\s*=\s*'desc'/.test(communicationThreadMessages)) {
  failures.push('CommunicationThreadMessages must default shared source-history panes to newest-first')
}
if (!/\.transcript-library-preview,[\s\S]*display:\s*grid[\s\S]*gap:\s*0/.test(appCss)) {
  failures.push('Library Activity preview must use shared transcript spacing, not compact Library row spacing')
}
if (
  /\.transcript-library-preview \.transcript-entry\s*\{/.test(appCss) ||
  /\.transcript-library-preview \.transcript-entry:hover/.test(appCss) ||
  /\.contact-library-call-transcript \.transcript-entry\s*\{/.test(appCss) ||
  /\.agent-library-call-transcript \.transcript-entry\s*\{/.test(appCss)
) {
  failures.push('Library transcript surfaces must not override shared transcript bubble geometry or hover colors')
}
if (!/communicationMessageDisplayLabel/.test(communicationThreadMessages) || !/labels\?\.(agent|contact)/.test(communicationThreadMessages)) {
  failures.push('communication Activity messages do not use transcript-style participant labels')
}
if (!/CommunicationThreadMessages/.test(dialerTranscript) || !/Source history/.test(dialerTranscript)) {
  failures.push('CallTranscriptConsole does not use shared communication message renderer for linked source history')
}
if (!/CommunicationThreadMessages/.test(playgroundPanel) || !/Source history/.test(playgroundPanel)) {
  failures.push('ConfigurationTestPanel does not use shared communication message renderer for linked source history')
}
if (!/normalizeEmotionScores\(source\.emotionScores\)/.test(workspaceStore)) {
  failures.push('workspace communication messages do not preserve normalized provider emotion score maps')
}
if (/confidence:\s*'verified',\s*confidence:\s*'verified'/.test(workspaceStore)) {
  failures.push('workspace identity-link persistence must not duplicate confidence keys')
}
if (/emotionScores:\s*event\.emotionScores,\s*emotionScores:\s*event\.emotionScores/.test(workspaceStore)) {
  failures.push('workspace communication message persistence must not duplicate emotionScores keys')
}
;['sms', 'email', 'browser_test', 'unresolved'].forEach((filter) => {
  if (!new RegExp(`\\['${filter}'`).test(libraryWorkspace)) {
    failures.push(`LibraryWorkspace Activity filters missing ${filter}`)
  }
})
if (!/communicationThreadCallStats/.test(libraryWorkspace) || !/compareCommunicationThreads/.test(libraryWorkspace)) {
  failures.push('LibraryWorkspace Activity sorting is not grounded in communication thread metadata')
}

const recentCallsHook = read('src/useRecentCalls.ts')
if (!/communicationThreads/.test(recentCallsHook) || !/\/communication-threads\?limit=/.test(recentCallsHook)) {
  failures.push('useRecentCalls does not fetch communication threads for Dialer')
}
if (!/communicationThreadsByCallId/.test(dialerTranscript) || !/selectedLeadThreadCount/.test(dialerTranscript)) {
  failures.push('CallTranscriptConsole does not surface linked communication threads')
}
const appShell = read('src/App.tsx')
if (!/communicationThreads=\{communicationThreads\}/.test(appShell)) {
  failures.push('Dialer App does not pass communication threads into CallTranscriptConsole')
}
const playgroundWorkspace = read('src/AgentConfigWorkspace.tsx')
if (!/communicationThreadsByCallId/.test(playgroundWorkspace) || !/communication-threads\?limit=100/.test(playgroundWorkspace)) {
  failures.push('AgentConfigWorkspace does not fetch communication threads for Playground history')
}
if (!/communicationThreadId/.test(playgroundPanel) || !/communicationThreadSummary/.test(playgroundPanel)) {
  failures.push('ConfigurationTestPanel does not surface saved-test communication thread metadata')
}
if (!/productionLibraryUrl\(contract\)\}#thread=\$\{encodeURIComponent\(thread\.threadId\)\}/.test(speakMcp)) {
  failures.push('Speak MCP search results do not deep-link communication threads into Library Activity')
}
if (!/productionLibraryUrl\(contract\)\}#thread=\$\{encodeURIComponent\(thread\.thread\.threadId\)\}/.test(speakMcp)) {
  failures.push('Speak MCP fetch results do not deep-link communication threads into Library Activity')
}
if (
  !/buildWorkspaceEmailCommunicationEvent/.test(serverIndex) ||
  !/buildWorkspaceEmailCommunicationEvent/.test(workspaceEmailNormalizer) ||
  !/workspaceEmailDirection/.test(workspaceEmailNormalizer) ||
  !/sent_source_record_only/.test(workspaceEmailNormalizer) ||
  !/fromEmails:\s*nonEmptyArray\(fromEmails\)/.test(workspaceEmailNormalizer) ||
  !/toEmails:\s*nonEmptyArray\(toEmails\)/.test(workspaceEmailNormalizer)
) {
  failures.push('Workspace email webhook does not normalize sent/received source events through the native normalizer with full participant arrays')
}
if (
  !/app\.post\('\/api\/workspace-email\/sync'/.test(serverIndex) ||
  !/fetchWorkspaceEmailSyncPayloads/.test(serverIndex) ||
  !/workspaceEmailSourceReadConfigured/.test(serverIndex) ||
  !/workspace_email_source_read_not_ready/.test(serverIndex) ||
  !/workspace_email_sync_record_only/.test(workspaceEmailNormalizer)
) {
  failures.push('server missing internal Workspace email inbox/outbox sync endpoint with source-read gate and record-only default')
}
if (
  !/app\.post\('\/api\/webhooks\/workspace-email'/.test(serverIndex) ||
  !/const allowAutomation = truthy\(body\.allowAutomation \|\| request\.query\.allowAutomation\)/.test(serverIndex) ||
  !/recordWorkspaceEmailPayload\(body, \{[\s\S]*allowAutomation,[\s\S]*source:\s*'workspace_email_webhook'/.test(serverIndex) ||
  !/buildWorkspaceEmailCommunicationEvent\(payload = \{\}, \{[\s\S]*allowAutomation = false/.test(workspaceEmailNormalizer) ||
  !/recordWorkspaceEmailPayload\(payload = \{\}, \{[\s\S]*allowAutomation = false/.test(serverIndex)
) {
  failures.push('Workspace email webhook must be record-only unless trusted ingress explicitly enables automation')
}
if (
  !/'gmail'[\s\S]*'messages'[\s\S]*'search'/.test(workspaceEmailSync) ||
  !/'--include-body'/.test(workspaceEmailSync) ||
  !/DEFAULT_WORKSPACE_EMAIL_SYNC_QUERY/.test(workspaceEmailSync) ||
  !/workspaceEmailDefaultSyncQuery/.test(workspaceEmailSync) ||
  !/workspaceEmailSourceProbeQuery\(account/.test(workspaceEmailSync) ||
  !/fromEmails/.test(workspaceEmailSync) ||
  !/ccEmails/.test(workspaceEmailSync)
) {
  failures.push('Workspace email sync must use native GOG Gmail message search with bounded body fetch and participant arrays')
}
if (!/sync:workspace-email/.test(packageJson) || !/sync:workspace-email:apply/.test(packageJson)) {
  failures.push('package scripts missing Workspace email sync dry-run/apply commands')
}
if (
  !/repair:workspace-email-thread-identity/.test(packageJson) ||
  !/repair:workspace-email-thread-identity:apply/.test(packageJson) ||
  !/repairWorkspaceEmailMailboxThreadIdentity/.test(workspaceStore) ||
  !/Dry-run only/.test(repairWorkspaceEmailThreadIdentityScript) ||
  !/--apply/.test(repairWorkspaceEmailThreadIdentityScript)
) {
  failures.push('package scripts missing Workspace email thread identity repair dry-run/apply commands')
}
if (
  !/repair:communication-source-dedup/.test(packageJson) ||
  !/repair:communication-source-dedup:apply/.test(packageJson) ||
  !/repairDuplicateCommunicationSourceMessages/.test(workspaceStore) ||
  !/communicationProviderSourceDedupKey/.test(workspaceStore) ||
  !/Dry-run only/.test(repairCommunicationSourceDedupScript) ||
  !/--apply/.test(repairCommunicationSourceDedupScript)
) {
  failures.push('package scripts missing communication provider-source dedup repair dry-run/apply commands')
}
if (
  !/repair:default-off-inbound-calls/.test(packageJson) ||
  !/repair:default-off-inbound-calls:apply/.test(packageJson) ||
  !/repairDefaultOffInboundCallMessages/.test(workspaceStore) ||
  !/defaultOffInboundCallRepairCandidate/.test(workspaceStore) ||
  !/Dry-run only/.test(repairDefaultOffInboundCallScript) ||
  !/--apply/.test(repairDefaultOffInboundCallScript)
) {
  failures.push('package scripts missing default-off inbound call source repair dry-run/apply commands')
}
;[
  ['README.md', read('README.md')],
  ['docs/communication-thread-model.md', playbook],
  ['docs/backend-api-reference.md', backendApiReference],
  ['docs/agent-integration.md', agentIntegrationGuide],
  ['docs/agent-reference.md', agentReference],
  ['docs/generative-ui-widgets.md', read('docs/generative-ui-widgets.md')],
].forEach(([file, text]) => {
  if (!/repair:communication-source-dedup/.test(text)) {
    failures.push(`${file}: missing communication provider-source dedup repair command`)
  }
})
;[
  ['README.md', read('README.md')],
  ['docs/communication-thread-model.md', playbook],
  ['docs/backend-api-reference.md', backendApiReference],
].forEach(([file, text]) => {
  if (!/repair:default-off-inbound-calls/.test(text)) {
    failures.push(`${file}: missing default-off inbound call repair command`)
  }
})
if (!/qa:workspace-email/.test(packageJson) || !fs.existsSync('scripts/check-workspace-email.mjs')) {
  failures.push('package scripts missing Workspace email production readiness check')
}
if (
  !/repair:workspace-email-sendas/.test(packageJson) ||
  !/repair:workspace-email-sendas:apply/.test(packageJson) ||
  !/repair:workspace-email-sendas:auth-url/.test(packageJson) ||
  !/repair:workspace-email-sendas:auth-complete/.test(packageJson) ||
  !fs.existsSync('scripts/repair-workspace-email-sendas.mjs') ||
  !fs.existsSync('scripts/complete-workspace-email-sendas-auth.mjs')
) {
  failures.push('package scripts missing Workspace email send-as repair commands')
}
if (
  !/Dry-run does not write communication threads or send auto-replies/.test(syncWorkspaceEmailScript) ||
  !/--allow-automation/.test(syncWorkspaceEmailScript)
) {
  failures.push('Workspace email sync script must default to dry-run and require explicit automation opt-in')
}
if (!/\/api\/communication-messages\/send/.test(serverIndex) || !/sendTextMessage\(phone, text\)/.test(serverIndex) || !/sendEmail\(email, subject, text\)/.test(serverIndex)) {
  failures.push('server missing proof-returning communication message send endpoint for SMS/email replies')
}
if (
  !/buildTelnyxSmsCommunicationEvent/.test(serverIndex) ||
  !/buildTelnyxSmsCommunicationEvent/.test(telnyxWebhookNormalizer) ||
  !/telnyxMessageDirection/.test(telnyxWebhookNormalizer) ||
  !/outbox_source_record_only/.test(telnyxWebhookNormalizer)
) {
  failures.push('Telnyx SMS webhook does not normalize inbox and outbox message source events through the native normalizer')
}
if (
  !/request\.body\?\.data\?\.occurred_at/.test(serverIndex) ||
  !/recordTelnyxProviderCommunicationEvent\(\{[\s\S]*occurredAt:\s*eventOccurredAt[\s\S]*webhookEventId/.test(serverIndex)
) {
  failures.push('Telnyx webhook persistence must carry top-level data.occurred_at and webhook event IDs into source records')
}
if (!/process\.env\.TELNYX_API_BASE/.test(providerHttp)) {
  failures.push('provider HTTP config must allow TELNYX_API_BASE override for provider-ingress route tests')
}
if (
  !/function telnyxWebhookAutomationAllowed/.test(serverIndex) ||
  !/SPEAK_TELNYX_WEBHOOK_ALLOW_AUTOMATION/.test(serverIndex) ||
  !/allowAutomation\s*=\s*telnyxWebhookAutomationAllowed\(\)/.test(serverIndex) ||
  !/telnyx_webhook_record_only/.test(serverIndex) ||
  !/direction === 'inbound' && !allowAutomation/.test(serverIndex) ||
  !/if \(!allowAutomation\)[\s\S]*telnyxWebhookRecordOnlyPolicy\([\s\S]*'call'/.test(serverIndex)
) {
  failures.push('Telnyx direct webhook intake must be record-only by default and require explicit webhook automation opt-in')
}
if (
  !/verifyTelnyxWebhookRequest/.test(serverIndex) ||
  !/express\.json/.test(serverIndex) ||
  !/verify:\s*captureRawJsonBody/.test(serverIndex) ||
  !/function captureRawJsonBody/.test(serverIndex) ||
  !/request\.rawBody/.test(telnyxWebhookSignature) ||
  !/telnyx-signature-ed25519/.test(telnyxWebhookSignature) ||
  !/telnyx-timestamp/.test(telnyxWebhookSignature) ||
  !/TELNYX_WEBHOOK_SIGNATURE_REQUIRED/.test(runtimeConfig)
) {
  failures.push('Telnyx source webhook ingress must verify signed raw webhook payloads before persistence')
}
if (!/Array\.isArray\(value\)/.test(telnyxWebhookNormalizer) || !/completed_at/.test(telnyxWebhookNormalizer)) {
  failures.push('Telnyx webhook normalizer must support official to[] recipients and message.finalized completed_at timestamps')
}
if (
  !/nativeInboundSmsNormalized/.test(telnyxSourceRoutingCheck) ||
  !/nativeOutboxSmsNormalized/.test(telnyxSourceRoutingCheck) ||
  !/nativeMissedInboundCallNormalized/.test(telnyxSourceRoutingCheck)
) {
  failures.push('Telnyx source routing check must verify native SMS and inbound-call normalization against a temp workspace')
}
if (
  !/telnyxWebhookPublicKeyObject/.test(telnyxSourceRoutingCheck) ||
  !/verifyWebhookSignatureKeys/.test(telnyxSourceRoutingCheck) ||
  !/webhookSignatureKeysParseable/.test(telnyxSourceRoutingCheck)
) {
  failures.push('Telnyx source routing check must parse configured webhook public keys with the production verifier')
}
const automationModule = read('server/communication-automation.mjs')
if (!/missed_call/.test(serverIndex) || !/inboundCallAutoAnswer:\s*Boolean/.test(automationModule)) {
  failures.push('Telnyx inbound call webhook does not record default-off missed-call proof')
}
if (
  !/function missedInboundCallRecordBody/.test(serverIndex) ||
  !/missedInboundCall[\s\S]*action:\s*'missed_call'/.test(serverIndex) ||
  !/body:\s*missedInboundCallRecordBody\(communication\)/.test(serverIndex) ||
  !/inbound call received[\s\S]*Missed inbound call/i.test(serverIndex)
) {
  failures.push('record-only inbound calls must persist visible missed-call body text and missed_call proof action')
}
if (!/actions\/answer/.test(serverIndex) || !/stream_bidirectional_mode/.test(serverIndex)) {
  failures.push('Telnyx inbound call auto-answer does not use native answer plus bidirectional media streaming')
}
if (!/resolveInboundAutomationPolicy/.test(serverIndex) || !/applyInboundAutomationPolicy/.test(serverIndex)) {
  failures.push('server webhooks do not resolve explicit inbound SMS/email automation policy')
}
if (
  !/function recordTrustedCommunicationEvent/.test(serverIndex) ||
  !/truthy\(body\.allowAutomation\)/.test(serverIndex) ||
  !/internal_event_record_only/.test(serverIndex) ||
  !/isMissedInboundCommunicationEvent/.test(serverIndex) ||
  !/communicationEventTargetValue\(body,\s*recorded\.message,\s*channel\)/.test(serverIndex) ||
  !/function communicationEventTargetValue/.test(serverIndex) ||
  !/identity\.phone/.test(serverIndex) ||
  !/identity\.email/.test(serverIndex)
) {
  failures.push('neutral communication-events route must be record-only by default, automation opt-in only, and target replies from event identity')
}
if (
  !/providerIds\.fromPhones/.test(serverIndex) ||
  !/providerIds\.toPhones/.test(serverIndex) ||
  !/providerIds\.fromEmails/.test(serverIndex) ||
  !/providerIds\.toEmails/.test(serverIndex) ||
  !/function firstSafeValue\([\s\S]*Array\.isArray\(value\)/.test(serverIndex) ||
  !/function firstCleanEmail\([\s\S]*workspaceEmailList/.test(serverIndex)
) {
  failures.push('neutral communication-events target resolution must support provider participant arrays for SMS/email replies')
}
if (!/DEFAULT_WORKSPACE_EMAIL_ACCOUNT = 'operator@example\.com'/.test(runtimeConfig)) {
  failures.push('workspace email default must be operator@example.com')
}
if (
  !/workspaceEmailGmailAuthConfigured/.test(runtimeConfig) ||
  !/workspaceEmailGmailReadConfigured/.test(runtimeConfig) ||
  !/getWorkspaceEmailGogAccount/.test(runtimeConfig) ||
  !/getWorkspaceEmailReadGogAccount/.test(runtimeConfig) ||
  !/getWorkspaceEmailSendGogAccount/.test(runtimeConfig) ||
  !/workspaceEmailSendAsConfigured/.test(runtimeConfig) ||
  !/WORKSPACE_EMAIL_GOG_ACCOUNT/.test(runtimeConfig) ||
  !/WORKSPACE_EMAIL_READ_GOG_ACCOUNT/.test(runtimeConfig) ||
  !/WORKSPACE_EMAIL_SEND_GOG_ACCOUNT/.test(runtimeConfig) ||
  !/'auth'[\s\S]*'list'/.test(runtimeConfig) ||
  !/'settings'[\s\S]*'sendas'[\s\S]*'list'/.test(runtimeConfig) ||
  !/gmailScopesSupportSend/.test(runtimeConfig) ||
  !/workspaceEmailSendConfigured:\s*workspaceEmailGmailAuthConfigured\(\)/.test(serverIndex) ||
  !/emailSendAuthAccountConfigured:\s*workspaceEmailGmailAuthConfigured\(\)/.test(serverIndex) ||
  !/workspaceEmailConfigured:\s*isEmailConfigured\(\)/.test(serverIndex)
) {
  failures.push('Workspace email health must verify configured GOG Gmail send auth and send-as capability, not only wrapper presence')
}
if (
  !/function summarizeHealth\(health\)/.test(speakMcp) ||
  !/delivery:\s*\{[\s\S]*smsConfigured:\s*Boolean\(health\?\.delivery\?\.smsConfigured\)/.test(speakMcp) ||
  !/emailConfigured:\s*Boolean\(health\?\.delivery\?\.emailConfigured\)/.test(speakMcp) ||
  !/emailReadAuthAccountConfigured:\s*Boolean/.test(speakMcp) ||
  !/emailSourceReadConfigured:\s*Boolean/.test(speakMcp) ||
  !/emailSendAuthAccountConfigured:\s*Boolean/.test(speakMcp) ||
  !/emailSendAsConfigured:\s*Boolean\(health\?\.delivery\?\.emailSendAsConfigured\)/.test(speakMcp)
) {
  failures.push('MCP widget health summaries must expose bounded SMS/email delivery readiness')
}
if (
  !/workspaceEmailReadConfigured:\s*workspaceEmailGmailReadConfigured\(\)/.test(serverIndex) ||
  !/emailReadAuthAccountConfigured:\s*workspaceEmailGmailReadConfigured\(\)/.test(serverIndex) ||
  !/workspaceEmailSourceReadConfigured:\s*workspaceEmailSourceReadConfigured\(\)/.test(serverIndex) ||
  !/emailSourceReadConfigured:\s*workspaceEmailSourceReadConfigured\(\)/.test(serverIndex) ||
  !/workspaceEmailSourceReadConfigured\(\{[\s\S]*account,[\s\S]*authAccount/.test(serverIndex) ||
  !/readAuthAccountCanRead/.test(read('scripts/check-workspace-email.mjs')) ||
  !/sendAuthAccountCanSend/.test(read('scripts/check-workspace-email.mjs')) ||
  !/sourceReadConfigured/.test(read('scripts/check-workspace-email.mjs')) ||
  !/sendAuthAccountCanManageSendAs/.test(read('scripts/check-workspace-email.mjs')) ||
  !/gmailScopesSupportSendAsManagement/.test(read('scripts/check-workspace-email.mjs')) ||
  !/WORKSPACE_EMAIL_READ_GOG_ACCOUNT/.test(read('scripts/check-workspace-email.mjs')) ||
  !/WORKSPACE_EMAIL_SEND_GOG_ACCOUNT/.test(read('scripts/check-workspace-email.mjs')) ||
  !/WORKSPACE_EMAIL_GOG_ACCOUNT_READS_MAILBOX/.test(read('scripts/check-workspace-email.mjs')) ||
  !/delegatedMailboxReadConfigured/.test(read('scripts/check-workspace-email.mjs'))
) {
  failures.push('Workspace email readiness must distinguish Gmail source-read auth, delegated mailbox read proof, reply send-as readiness, and send-as management scope')
}
if (
  !/gmail\.settings\.basic/.test(repairWorkspaceEmailSendAsScript) ||
  !/gmail\.settings\.sharing/.test(repairWorkspaceEmailSendAsScript) ||
  !/sendas'[\s\S]*'create'/.test(repairWorkspaceEmailSendAsScript) ||
  !/--apply/.test(repairWorkspaceEmailSendAsScript) ||
  !/reauthorizeCommand/.test(repairWorkspaceEmailSendAsScript)
) {
  failures.push('Workspace email send-as repair must expose scoped reauth guidance and apply-only alias creation')
}
if (
  !/--step=1/.test(completeWorkspaceEmailSendAsAuthScript) ||
  !/--step=2/.test(completeWorkspaceEmailSendAsAuthScript) ||
  !/--auth-url/.test(completeWorkspaceEmailSendAsAuthScript) ||
  !/gmail\.settings\.basic/.test(completeWorkspaceEmailSendAsAuthScript) ||
  !/gmail\.settings\.sharing/.test(completeWorkspaceEmailSendAsAuthScript) ||
  !/repair-workspace-email-sendas\.mjs/.test(completeWorkspaceEmailSendAsAuthScript) ||
  !/--apply/.test(completeWorkspaceEmailSendAsAuthScript) ||
  !/check-workspace-email\.mjs/.test(completeWorkspaceEmailSendAsAuthScript)
) {
  failures.push('Workspace email send-as auth helper must preserve two-step OAuth, Gmail settings scopes, repair apply, and readiness check')
}
if (!/getWorkspaceEmailSendGogAccount/.test(read('server/delivery.mjs')) || !/'--from'[\s\S]*account/.test(read('server/delivery.mjs'))) {
  failures.push('Workspace email send must use GOG auth account while preserving workspace mailbox as from address')
}
if (
  !/WORKSPACE_SMS_SENDER_NAME/.test(read('.env.example')) ||
  !/WORKSPACE_SMS_SENDER_NAME/.test(read('docs/configuration-options.md')) ||
  !/TELNYX_SMS_FINALIZATION_TIMEOUT_MS/.test(read('.env.example')) ||
  !/TELNYX_SMS_FINALIZATION_TIMEOUT_MS/.test(read('docs/configuration-options.md')) ||
  !/WORKSPACE_SMS_SENDER_NAME[\s\S]*Reply STOP to opt out/.test(read('server/delivery.mjs'))
) {
  failures.push('portal-link SMS must use an env-backed workspace brand and document bounded Telnyx final-delivery proof settings')
}
if (/provider:\s*'telnyx',\s*provider:\s*'telnyx'/.test(serverIndex)) {
  failures.push('Inbound call auto-answer proof must not duplicate provider keys')
}
if (
  !/authAccount = getWorkspaceEmailReadGogAccount/.test(workspaceEmailSync) ||
  !/'--account'[\s\S]*cleanAuthAccount/.test(workspaceEmailSync) ||
  !/workspaceEmailPayloadsFromGogOutput\(parsed, \{ account: cleanAccount \}\)/.test(workspaceEmailSync) ||
  !/workspaceEmailPayloadInvolvesAccount/.test(workspaceEmailSync)
) {
  failures.push('Workspace email sync must separate GOG auth account from mailbox identity and reject non-mailbox messages')
}
if (!/--read-auth-account/.test(syncWorkspaceEmailScript) || !/WORKSPACE_EMAIL_READ_GOG_ACCOUNT/.test(syncWorkspaceEmailScript) || !/authAccount/.test(syncWorkspaceEmailScript)) {
  failures.push('Workspace email sync script must expose an explicit GOG read-auth-account option')
}
if (
  !/workspaceEmailSourceProbeQuery/.test(checkWorkspaceEmailSourceScript) ||
  !/--read-auth-account/.test(checkWorkspaceEmailSourceScript) ||
  !/observedWorkspaceParticipantSample/.test(checkWorkspaceEmailSourceScript) ||
  !/const warnings = \[\]/.test(checkWorkspaceEmailSourceScript) ||
  !/No inbound Workspace email sample/.test(checkWorkspaceEmailSourceScript) ||
  !/live received-mail sampling is still unproven/.test(checkWorkspaceEmailSourceScript) ||
  !/WORKSPACE_EMAIL_GOG_ACCOUNT_READS_MAILBOX/.test(checkWorkspaceEmailSourceScript) ||
  !/nativeInboundEmailNormalized/.test(checkWorkspaceEmailSourceScript) ||
  !/nativeSentEmailNormalized/.test(checkWorkspaceEmailSourceScript) ||
  !/nativeEmailThreadReconciled/.test(checkWorkspaceEmailSourceScript)
) {
  failures.push('Workspace email source probe must prove bounded mailbox participant visibility and native email source normalization before delegated read is trusted')
}

await verifyCommunicationAutomationPolicy()
await verifyTelnyxWebhookSignature()
await verifyTelnyxWebhookNormalizer()
await verifyTelnyxWebhookIngressRoute()
await verifyWorkspaceEmailSyncNormalizer()
await verifyWorkspaceEmailSyncRoute()
await verifyContactDestinationPersistence()
await verifyRuntimeContactUpdateFailure()
await verifyDeliveryProviderProof()
await verifyBackgroundDeliveryQueue()
await verifyWorkspaceEmailReadinessDoesNotBlockVoiceRuntime()
await verifyCodexBackgroundDeliveryFollowUp()
await verifyBackgroundVoiceDeliveryIntegration()
await verifyBackgroundDeliveryShutdownDrain()
await verifyDirectDeliveryShutdownDrain()
await verifyCommunicationStoreRoundTrip()

if (failures.length > 0) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        failures,
      },
      null,
      2,
    ),
  )
  process.exitCode = 1
} else {
  console.log(
    JSON.stringify(
      {
        ok: true,
        playbook: runtime.playbook,
        channels: runtime.channels,
        schemas: [
          'communicationThread',
          'communicationMessage',
          'communicationTopic',
          'contactIdentityLink',
        ],
      },
      null,
      2,
    ),
  )
}

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (error) {
    failures.push(`${file}: ${error.message}`)
    return ''
  }
}

function requireSchema(name, schema) {
  if (!schema?.type || !schema?.properties) {
    failures.push(`dataSchemas missing ${name}`)
  }
}

async function verifyContactDestinationPersistence() {
  const tempDataDir = makeTempDir('check-contact-destination-persistence')
  const previousDataDir = process.env.SPEAK_WORKSPACE_DATA_DIR
  process.env.SPEAK_WORKSPACE_DATA_DIR = tempDataDir
  try {
    const store = await import(`../server/workspace-store.mjs?destinationCheck=${Date.now()}`)
    assert(
      typeof store.patchWorkspaceLeadWithProof === 'function',
      'workspace store must expose durable contact patch/readback proof',
    )
    if (typeof store.patchWorkspaceLeadWithProof !== 'function') return

    const contactId = 'lead-contact-destination-check'
    const oldPhone = '+15551234567'
    const newPhone = '+15557654321'
    const unrelatedPhone = '+15550001111'
    const oldEmail = 'old-destination@example.com'
    const newEmail = 'new-destination@example.com'
    const unrelatedEmail = 'unrelated-destination@example.com'
    const lead = await store.createWorkspaceLead({
      id: contactId,
      name: 'Destination Check',
      company: 'Destination Check Company',
      phone: oldPhone,
      email: oldEmail,
    })

    await store.recordCommunicationEvent({
      lead,
      createdAt: '2026-07-14T12:00:00.000Z',
      event: {
        entry: {
          id: 'destination-check-baseline',
          speaker: 'System',
          text: 'Contact destination baseline.',
        },
      },
    })
    await store.recordCommunicationEvent({
      createdAt: '2026-07-14T12:01:00.000Z',
      event: {
        communication: {
          contactId,
          channel: 'sms',
          modality: 'text',
          direction: 'inbound',
          role: 'contact',
          body: 'Historical provider phone evidence.',
          provider: 'telnyx',
          identity: { phone: oldPhone },
          providerIds: { messageId: 'destination-check-telnyx-message' },
        },
      },
    })
    await store.recordCommunicationEvent({
      createdAt: '2026-07-14T12:02:00.000Z',
      event: {
        communication: {
          contactId,
          channel: 'email',
          modality: 'text',
          direction: 'inbound',
          role: 'contact',
          body: 'Historical provider email evidence.',
          provider: 'google_workspace',
          identity: { email: oldEmail },
          providerIds: { messageId: 'destination-check-email-message' },
        },
      },
    })
    await store.recordCommunicationEvent({
      lead: {
        ...lead,
        phone: unrelatedPhone,
        email: unrelatedEmail,
      },
      createdAt: '2026-07-14T12:03:00.000Z',
      event: {
        entry: {
          id: 'destination-check-unrelated-speak-identities',
          speaker: 'System',
          text: 'Unrelated Speak identity evidence.',
        },
      },
    })

    const before = await store.workspaceSnapshot()
    const beforeLinks = before.contactIdentityLinks.filter((link) => link.contactId === contactId)
    assert(
      beforeLinks.some(
        (link) =>
          link.kind === 'phone' &&
          link.normalizedValue === oldPhone &&
          link.source === 'speak',
      ),
      'contact baseline did not retain the Speak-owned verified phone identity',
    )
    assert(
      beforeLinks.some(
        (link) =>
          link.kind === 'email' &&
          link.normalizedValue === oldEmail &&
          link.source === 'speak',
      ),
      'contact baseline did not retain the Speak-owned verified email identity',
    )
    assert(
      beforeLinks.some(
        (link) =>
          link.kind === 'phone' &&
          link.normalizedValue === oldPhone &&
          link.source === 'telnyx',
      ) &&
        beforeLinks.some(
          (link) =>
            link.kind === 'email' &&
            link.normalizedValue === oldEmail &&
            link.source === 'google_workspace',
        ),
      'contact baseline did not retain historical provider identity evidence',
    )

    const persisted = await store.patchWorkspaceLeadWithProof(contactId, {
      phone: newPhone,
      email: newEmail,
    })
    assert(
      persisted?.proof?.persisted === true &&
        persisted?.proof?.contactId === contactId &&
        persisted?.lead?.phone === newPhone &&
        persisted?.lead?.email === newEmail,
      'contact destination patch did not return durable workspace readback proof',
    )

    const after = await store.workspaceSnapshot()
    const readback = after.leads.find((item) => item.id === contactId)
    const afterLinks = after.contactIdentityLinks.filter((link) => link.contactId === contactId)
    assert(
      readback?.phone === newPhone && readback?.email === newEmail,
      'contact destination correction was not durable after workspace reload',
    )
    assert(
      afterLinks.some(
        (link) =>
          link.kind === 'phone' &&
          link.normalizedValue === newPhone &&
          link.source === 'speak' &&
          !link.supersededBy,
      ) &&
        afterLinks.some(
          (link) =>
            link.kind === 'email' &&
            link.normalizedValue === newEmail &&
            link.source === 'speak' &&
            !link.supersededBy,
        ),
      'corrected contact destinations did not become active Speak-owned identities',
    )
    assert(
      afterLinks
        .filter(
          (link) =>
            link.source === 'speak' &&
            ((link.kind === 'phone' && link.normalizedValue === oldPhone) ||
              (link.kind === 'email' && link.normalizedValue === oldEmail)),
        )
        .every((link) => Boolean(link.supersededBy)),
      'prior Speak-owned contact identities were not superseded',
    )
    const historicalProviderLinks = afterLinks.filter(
      (link) => link.source === 'telnyx' || link.source === 'google_workspace',
    )
    assert(
      historicalProviderLinks.some(
        (link) => link.kind === 'phone' && link.normalizedValue === oldPhone,
      ) &&
        historicalProviderLinks.some(
          (link) => link.kind === 'email' && link.normalizedValue === oldEmail,
        ) &&
        historicalProviderLinks.every((link) => !link.supersededBy),
      'contact correction deleted or superseded historical provider identity evidence',
    )
    assert(
      afterLinks.some(
        (link) =>
          link.source === 'speak' &&
          link.kind === 'phone' &&
          link.normalizedValue === unrelatedPhone &&
          !link.supersededBy,
      ) &&
        afterLinks.some(
          (link) =>
            link.source === 'speak' &&
            link.kind === 'email' &&
            link.normalizedValue === unrelatedEmail &&
            !link.supersededBy,
        ),
      'contact correction superseded unrelated Speak identity evidence',
    )
    const correctedPhoneContext = await store.resolveCommunicationEventContext({
      event: {
        communication: {
          channel: 'sms',
          direction: 'inbound',
          role: 'contact',
          body: 'Corrected phone attribution check.',
          provider: 'telnyx',
          identity: { phone: newPhone },
        },
      },
    })
    assert(
      correctedPhoneContext?.communication?.contactId === contactId,
      'corrected contact destination did not win verified attribution',
    )
  } catch (error) {
    failures.push(`contact destination persistence failed: ${error.message}`)
  } finally {
    if (previousDataDir === undefined) {
      delete process.env.SPEAK_WORKSPACE_DATA_DIR
    } else {
      process.env.SPEAK_WORKSPACE_DATA_DIR = previousDataDir
    }
    fs.rmSync(tempDataDir, { recursive: true, force: true })
  }
}

async function verifyRuntimeContactUpdateFailure() {
  let runtime
  try {
    runtime = await import(`../server/contact-update.mjs?runtimeFailureCheck=${Date.now()}`)
  } catch (error) {
    failures.push(`runtime contact update executor missing: ${error.message}`)
    return
  }

  const transient = await runtime.executeContactUpdatePersistence({
    lead: {
      id: 'browser-contact-update-check',
      phone: '+15551234567',
      email: 'before@example.com',
    },
    patch: {
      phone: '+15557654321',
      email: 'after@example.com',
    },
    transient: true,
  })
  assert(
    transient?.ok === false && transient?.reason === 'contact_persistence_unavailable',
    'transient/browser update_contact returned success without durable persistence',
  )

  const confirmationTempRoot = makeTempDir('check-update-contact-confirmation')
  try {
    const confirmationGuard = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        [
          "import fs from 'node:fs'",
          "import { handleUpdateContactTool } from './server/index.mjs'",
          "const state = { callControlId: 'handler-update-contact-confirmation', eventLog: [], lead: { id: 'handler-confirmation-contact', phone: '+15551234567', email: 'before@example.com' } }",
          'const before = JSON.stringify(state.lead)',
          "const result = await handleUpdateContactTool(state, { phone: '+15557654321', email: 'after@example.com', details_confirmed: false })",
          "const files = fs.existsSync(process.env.SPEAK_CALL_LOG_DIR) ? fs.readdirSync(process.env.SPEAK_CALL_LOG_DIR) : []",
          "console.log('__UPDATE_CONTACT_CONFIRMATION__' + JSON.stringify({ result, unchanged: JSON.stringify(state.lead) === before, eventLog: state.eventLog, files }))",
          'process.exit(0)',
        ].join(';'),
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          PORT: '0',
          SPEAK_CALL_LOG_DIR: path.resolve(confirmationTempRoot, 'call-logs'),
          SPEAK_WORKSPACE_DATA_DIR: path.resolve(confirmationTempRoot, 'workspace-data'),
          BACKGROUND_DELIVERY_OUTBOX_PATH: path.resolve(
            confirmationTempRoot,
            'delivery-outbox.json',
          ),
        },
      },
    )
    const resultLine = String(confirmationGuard.stdout || '')
      .split('\n')
      .find((line) => line.startsWith('__UPDATE_CONTACT_CONFIRMATION__'))
    const confirmationResult = resultLine
      ? JSON.parse(resultLine.slice('__UPDATE_CONTACT_CONFIRMATION__'.length))
      : {}
    assert(
      confirmationGuard.status === 0 &&
        confirmationResult?.result?.ok === false &&
        confirmationResult?.result?.reason === 'details_not_confirmed' &&
        confirmationResult?.unchanged === true &&
        confirmationResult?.eventLog?.length === 0 &&
        confirmationResult?.files?.length === 0,
      `update_contact accepted unconfirmed details or caused a side effect: ${confirmationGuard.stderr || confirmationGuard.stdout}`,
    )
  } finally {
    fs.rmSync(confirmationTempRoot, { recursive: true, force: true })
  }

  const injectedFailure = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      [
        "import { executeContactUpdatePersistence } from './server/contact-update.mjs'",
        "const result = await executeContactUpdatePersistence({ lead: { id: 'failure-contact', phone: '+15551234567' }, patch: { phone: '+15557654321' } })",
        'console.log(JSON.stringify(result))',
      ].join(';'),
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        SPEAK_WORKSPACE_DATA_DIR: '/dev/null/speak-contact-update-failure',
      },
    },
  )
  const failureResult = JSON.parse(String(injectedFailure.stdout || '{}').trim() || '{}')
  assert(
    injectedFailure.status === 0 &&
      failureResult?.ok === false &&
      failureResult?.reason === 'contact_persistence_failed',
    `update_contact persistence failure did not return explicit failure: ${injectedFailure.stderr || injectedFailure.stdout}`,
  )
  assert(
    /executeContactUpdatePersistence/.test(serverIndex) &&
      /if \(!persistedUpdate\.ok\) return persistedUpdate/.test(serverIndex),
    'runtime execute/update_contact path does not propagate persistence failure',
  )

  const handlerTempRoot = makeTempDir('check-update-contact-handler-failure')
  try {
    const handlerFailure = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        [
          "import fs from 'node:fs'",
          "import { handleUpdateContactTool } from './server/index.mjs'",
          "const state = { callControlId: 'handler-update-contact-failure', eventLog: [], lead: { id: 'handler-failure-contact', phone: '+15551234567', email: 'before@example.com' } }",
          'const before = JSON.stringify(state.lead)',
          "const result = await handleUpdateContactTool(state, { phone: '+15557654321', email: 'after@example.com', details_confirmed: true })",
          "const files = fs.existsSync(process.env.SPEAK_CALL_LOG_DIR) ? fs.readdirSync(process.env.SPEAK_CALL_LOG_DIR) : []",
          "console.log('__UPDATE_CONTACT_RESULT__' + JSON.stringify({ result, unchanged: JSON.stringify(state.lead) === before, eventLog: state.eventLog, files }))",
          'process.exit(0)',
        ].join(';'),
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          PORT: '0',
          SPEAK_CALL_LOG_DIR: path.resolve(handlerTempRoot, 'call-logs'),
          SPEAK_WORKSPACE_DATA_DIR: '/dev/null/speak-update-contact-handler-failure',
          BACKGROUND_DELIVERY_OUTBOX_PATH: path.resolve(handlerTempRoot, 'delivery-outbox.json'),
        },
      },
    )
    const resultLine = String(handlerFailure.stdout || '')
      .split('\n')
      .find((line) => line.startsWith('__UPDATE_CONTACT_RESULT__'))
    const handlerResult = resultLine
      ? JSON.parse(resultLine.slice('__UPDATE_CONTACT_RESULT__'.length))
      : {}
    assert(
      handlerFailure.status === 0 &&
        handlerResult?.result?.ok === false &&
        handlerResult?.result?.reason === 'contact_persistence_failed' &&
        handlerResult?.unchanged === true &&
        handlerResult?.eventLog?.length === 0 &&
        handlerResult?.files?.length === 0,
      `update_contact handler mutated state or emitted success after persistence failure: ${handlerFailure.stderr || handlerFailure.stdout}`,
    )
  } finally {
    fs.rmSync(handlerTempRoot, { recursive: true, force: true })
  }
}

async function verifyDeliveryProviderProof() {
  const tempRoot = makeTempDir('check-delivery-provider-proof')
  const fakeWrapper = path.resolve(tempRoot, 'fake-gog-provider-proof.cjs')
  const fakeWrapperArgs = path.resolve(tempRoot, 'fake-gog-provider-proof-args.json')
  const envKeys = [
    'GOG_FAKE_SEND_OUTPUT',
    'GOG_FAKE_SEND_ARGS_FILE',
    'GOG_WRAPPER',
    'CALLTOOLS_PHONE_NUMBER',
    'TELNYX_API_KEY',
    'TELNYX_FROM_NUMBER',
    'TELNYX_MESSAGING_PROFILE_ID',
    'TELNYX_SMS_NUMBER',
    'WORKSPACE_EMAIL_ACCOUNT',
    'WORKSPACE_EMAIL_GOG_ACCOUNT',
    'WORKSPACE_EMAIL_SEND_GOG_ACCOUNT',
  ]
  const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]))
  const previousFetch = globalThis.fetch

  try {
    fs.writeFileSync(
      fakeWrapper,
      [
        '#!/usr/bin/env node',
        "const fs = require('node:fs')",
        "if (process.env.GOG_FAKE_SEND_ARGS_FILE) fs.writeFileSync(process.env.GOG_FAKE_SEND_ARGS_FILE, JSON.stringify(process.argv.slice(2)))",
        "process.stdout.write(String(process.env.GOG_FAKE_SEND_OUTPUT || '{}') + '\\n')",
      ].join('\n'),
      { mode: 0o755 },
    )
    fs.chmodSync(fakeWrapper, 0o755)

    process.env.TELNYX_API_KEY = 'provider-proof-check-key'
    process.env.TELNYX_SMS_NUMBER = '+12025550141'
    process.env.TELNYX_MESSAGING_PROFILE_ID = 'provider-proof-check-profile'
    process.env.CALLTOOLS_PHONE_NUMBER = '+15550000000'
    process.env.WORKSPACE_EMAIL_ACCOUNT = 'speak@example.com'
    process.env.WORKSPACE_EMAIL_GOG_ACCOUNT = 'speak@example.com'
    process.env.WORKSPACE_EMAIL_SEND_GOG_ACCOUNT = 'speak@example.com'
    process.env.GOG_WRAPPER = fakeWrapper
    process.env.GOG_FAKE_SEND_ARGS_FILE = fakeWrapperArgs

    const delivery = await import(`../server/delivery.mjs?providerProofCheck=${Date.now()}`)

    let smsPayload = { data: { status: 'queued', to: [{ status: 'queued' }] } }
    let smsRequest = null
    globalThis.fetch = async (input, options = {}) => {
      smsRequest = {
        url: String(input),
        body: JSON.parse(String(options.body || '{}')),
      }
      return {
        ok: true,
        text: async () => JSON.stringify(smsPayload),
      }
    }
    let smsMissingIdError = ''
    try {
      await delivery.sendTextMessage('+15557654321', 'Provider proof check.')
    } catch (error) {
      smsMissingIdError = error instanceof Error ? error.message : String(error)
    }
    assert(
      /message ID.*status proof/i.test(smsMissingIdError),
      'SMS delivery accepted provider success without message ID proof',
    )

    smsPayload = { data: { id: 'provider-proof-sms-message', to: [{}] } }
    let smsMissingStatusError = ''
    try {
      await delivery.sendTextMessage('+15557654321', 'Provider proof check.')
    } catch (error) {
      smsMissingStatusError = error instanceof Error ? error.message : String(error)
    }
    assert(
      /message ID.*status proof/i.test(smsMissingStatusError),
      'SMS delivery accepted provider success without recipient status proof',
    )

    for (const status of ['failed', 'rejected', 'canceled']) {
      smsPayload = {
        data: {
          id: `provider-proof-sms-${status}`,
          status,
          to: [{ status }],
        },
      }
      let statusError = ''
      try {
        await delivery.sendTextMessage('+15557654321', 'Provider proof check.')
      } catch (error) {
        statusError = error instanceof Error ? error.message : String(error)
      }
      assert(
        /unsuccessful status proof/i.test(statusError),
        `SMS delivery accepted provider failure status ${status}`,
      )
    }

    smsPayload = {
      data: {
        id: 'provider-proof-sms-message',
        status: 'queued',
        to: [{ status: 'queued' }],
      },
    }
    const smsProof = await delivery.sendTextMessage(
      '+15557654321',
      'Provider proof check.',
    )
    assert(
      smsProof?.id === 'provider-proof-sms-message' &&
        (smsProof?.to?.[0]?.status || smsProof?.status) === 'queued',
      'SMS delivery rejected complete provider message ID/status proof',
    )
    assert(
      smsRequest?.url.endsWith('/messages') &&
        smsRequest?.body?.from === '+12025550141' &&
        smsRequest?.body?.to === '+15557654321' &&
        smsRequest?.body?.messaging_profile_id === 'provider-proof-check-profile' &&
        !JSON.stringify(smsRequest).includes(process.env.CALLTOOLS_PHONE_NUMBER),
      'shared SMS delivery did not use the configured Telnyx number/profile independently of CallTools',
    )

    process.env.GOG_FAKE_SEND_OUTPUT = JSON.stringify({ result: { ok: true } })
    let emailMissingIdError = ''
    try {
      await delivery.sendEmail(
        'contact@example.com',
        'Provider proof check',
        'Provider proof check.',
      )
    } catch (error) {
      emailMissingIdError = error instanceof Error ? error.message : String(error)
    }
    assert(
      /message ID proof/i.test(emailMissingIdError),
      'Workspace email delivery accepted provider success without message ID proof',
    )

    process.env.GOG_FAKE_SEND_OUTPUT = JSON.stringify({
      result: {
        id: 'provider-proof-email-message',
        threadId: 'provider-proof-email-thread',
        ok: true,
      },
    })
    const emailProof = await delivery.sendEmail(
      'contact@example.com',
      'Provider proof check',
      'Provider proof check.',
    )
    assert(
      emailProof?.id === 'provider-proof-email-message',
      'Workspace email delivery rejected complete provider message ID proof',
    )
    const emailArgs = JSON.parse(fs.readFileSync(fakeWrapperArgs, 'utf8'))
    assert(
      emailArgs.includes('--account') &&
        emailArgs.includes('speak@example.com') &&
        emailArgs.includes('--to') &&
        emailArgs.includes('contact@example.com') &&
        emailArgs.includes('--from') &&
        !emailArgs.includes(process.env.CALLTOOLS_PHONE_NUMBER),
      'shared email delivery did not use the configured Workspace sender independently of CallTools',
    )
  } catch (error) {
    failures.push(`delivery provider proof failed: ${error.message}`)
  } finally {
    globalThis.fetch = previousFetch
    previousEnv.forEach((value, key) => {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    })
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

async function verifyBackgroundDeliveryQueue() {
  try {
    const { queueBackgroundDelivery } = await import(
      `../server/background-delivery.mjs?check=${Date.now()}`
    )
    const scheduled = []
    const settled = []
    let providerStarted = false
    let releaseProvider
    const providerGate = new Promise((resolve) => {
      releaseProvider = resolve
    })

    const queued = queueBackgroundDelivery({
      requestId: 'delivery-queue-success-check',
      channel: 'sms',
      destination: '***4567',
      schedule: (job) => scheduled.push(job),
      run: async () => {
        providerStarted = true
        await providerGate
        return { id: 'provider-message-check', status: 'queued' }
      },
      onSettled: (outcome) => settled.push(outcome),
    })

    assert(
      queued.result?.ok === true &&
        queued.result?.queued === true &&
        queued.result?.pending === true &&
        queued.result?.sent === false &&
        queued.result?.status === 'processing' &&
        queued.result?.request_id === 'delivery-queue-success-check',
      'background delivery queue must return an immediate processing result without claiming sent',
    )
    assert(
      providerStarted === false && scheduled.length === 1,
      'background delivery queue must yield the voice tool response before provider work starts',
    )

    scheduled.shift()()
    await Promise.resolve()
    assert(
      providerStarted === true && settled.length === 0,
      'background delivery queue did not begin provider work after scheduling',
    )
    releaseProvider()
    const success = await queued.completion
    assert(
      success.ok === true &&
        success.status === 'accepted' &&
        success.providerResult?.id === 'provider-message-check' &&
        settled[0]?.request_id === 'delivery-queue-success-check',
      'background delivery queue did not preserve provider acceptance proof',
    )

    const failedJobs = []
    const failuresObserved = []
    const failed = queueBackgroundDelivery({
      requestId: 'delivery-queue-failure-check',
      channel: 'email',
      destination: 'c***@example.com',
      schedule: (job) => failedJobs.push(job),
      run: async () => {
        throw new Error('provider rejected check')
      },
      onSettled: (outcome) => failuresObserved.push(outcome),
    })
    failedJobs.shift()()
    const failure = await failed.completion
    assert(
      failure.ok === false &&
        failure.status === 'failed' &&
        failure.error === 'provider rejected check' &&
        failuresObserved.length === 1,
      'background delivery queue must settle provider failures without false success proof',
    )

    const observerJobs = []
    const observerErrors = []
    const observerFailure = queueBackgroundDelivery({
      requestId: 'delivery-observer-failure-check',
      channel: 'sms',
      destination: '***7890',
      schedule: (job) => observerJobs.push(job),
      run: async () => ({ id: 'provider-accepted-before-observer-failure' }),
      onSettled: () => {
        throw new Error('proof observer failed')
      },
      onObserverError: (error) => observerErrors.push(error.message),
    })
    observerJobs.shift()()
    const observerOutcome = await observerFailure.completion
    assert(
      observerOutcome.ok === false &&
        observerOutcome.sent === false &&
        observerOutcome.provider_accepted === true &&
        observerOutcome.status === 'accepted_unverified' &&
        observerOutcome.providerResult === undefined &&
        observerOutcome.observer_error === 'proof observer failed' &&
        observerErrors[0] === 'proof observer failed',
      'background delivery queue must preserve provider acceptance but fail closed when retained proof is unavailable',
    )
  } catch (error) {
    failures.push(`background delivery queue failed: ${error.message}`)
  }
}

async function verifyWorkspaceEmailReadinessDoesNotBlockVoiceRuntime() {
  const tempRoot = makeTempDir('check-workspace-email-readiness-cache')
  const wrapper = path.join(tempRoot, 'slow-gog-wrapper.cjs')
  const invocationLog = path.join(tempRoot, 'gog-invocations.jsonl')
  const previousCacheMs = process.env.WORKSPACE_EMAIL_AUTH_CHECK_CACHE_MS
  const previousRetryMs = process.env.WORKSPACE_EMAIL_AUTH_CHECK_RETRY_MS
  try {
    fs.writeFileSync(
      wrapper,
      [
        '#!/usr/bin/env node',
        "const args = process.argv.slice(2)",
        `require('node:fs').appendFileSync(${JSON.stringify(invocationLog)}, JSON.stringify(args) + '\\n')`,
        "const authList = args.includes('auth') && args.includes('list')",
        'setTimeout(() => {',
        "  const payload = authList ? { accounts: [{ email: 'broker@example.com', services: ['gmail'], scopes: ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.send'] }, { email: 'reader@example.com', services: ['gmail'], scopes: ['https://www.googleapis.com/auth/gmail.readonly'] }] } : { result: [{ sendAsEmail: 'workspace@example.com', verificationStatus: 'accepted' }] }",
        "  process.stdout.write(JSON.stringify(payload) + '\\n')",
        '}, 350)',
      ].join('\n'),
      { mode: 0o755 },
    )
    fs.chmodSync(wrapper, 0o755)
    process.env.WORKSPACE_EMAIL_AUTH_CHECK_CACHE_MS = '1'
    process.env.WORKSPACE_EMAIL_AUTH_CHECK_RETRY_MS = '1'
    const runtimeConfig = await import(
      `../server/runtime-config.mjs?emailReadinessNonBlocking=${Date.now()}`
    )
    assert(
      typeof runtimeConfig.refreshWorkspaceEmailReadiness === 'function',
      'Workspace email readiness must expose an awaitable startup/background refresh',
    )

    const coldStartedAt = Date.now()
    const coldReady = runtimeConfig.workspaceEmailGmailAuthConfigured({
      account: 'broker@example.com',
      wrapper,
    })
    const coldElapsedMs = Date.now() - coldStartedAt
    assert(
      coldElapsedMs < 150 && coldReady === false,
      `Workspace email cold readiness blocked the voice runtime for ${coldElapsedMs}ms`,
    )
    const coldSendAsStartedAt = Date.now()
    const coldSendAsReady = runtimeConfig.workspaceEmailSendAsConfigured({
      account: 'workspace@example.com',
      authAccount: 'broker@example.com',
      wrapper,
    })
    const coldSendAsElapsedMs = Date.now() - coldSendAsStartedAt
    assert(
      coldSendAsElapsedMs < 150 && coldSendAsReady === false,
      `Workspace email cold send-as readiness blocked the voice runtime for ${coldSendAsElapsedMs}ms`,
    )

    const refreshOptions = {
      account: 'workspace@example.com',
      sendAuthAccount: 'broker@example.com',
      readAuthAccount: 'reader@example.com',
      wrapper,
      sourceReadDelegated: false,
      force: true,
    }
    const refreshed = await runtimeConfig.refreshWorkspaceEmailReadiness(refreshOptions)
    assert(
      refreshed.emailConfigured === true &&
        refreshed.sendAuthConfigured === true &&
        refreshed.readAuthConfigured === true &&
        refreshed.sourceReadConfigured === false &&
        refreshed.sendAsConfigured === true,
      'Workspace email background refresh did not retain auth and send-as proof',
    )
    const initialInvocations = fs.readFileSync(invocationLog, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    assert(
      initialInvocations.filter((args) => args.includes('auth') && args.includes('list')).length === 1 &&
        initialInvocations.filter((args) => args.includes('sendas')).length === 1,
      'Workspace email startup refresh must share one auth catalog probe across distinct read/send accounts',
    )

    await new Promise((resolve) => setTimeout(resolve, 5))
    const staleStartedAt = Date.now()
    const staleReady = {
      sendAuth: runtimeConfig.workspaceEmailGmailAuthConfigured({
        account: 'broker@example.com',
        wrapper,
      }),
      readAuth: runtimeConfig.workspaceEmailGmailReadConfigured({
        account: 'reader@example.com',
        wrapper,
      }),
      sourceRead: runtimeConfig.workspaceEmailSourceReadConfigured({
        account: 'workspace@example.com',
        authAccount: 'reader@example.com',
        wrapper,
      }),
      sendAs: runtimeConfig.workspaceEmailSendAsConfigured({
        account: 'workspace@example.com',
        authAccount: 'broker@example.com',
        wrapper,
      }),
    }
    const staleElapsedMs = Date.now() - staleStartedAt
    assert(
      staleElapsedMs < 150 &&
        staleReady.sendAuth === true &&
        staleReady.readAuth === true &&
        staleReady.sourceRead === false &&
        staleReady.sendAs === true,
      `Workspace email stale-while-refresh readiness blocked or discarded proof after ${staleElapsedMs}ms`,
    )
    await runtimeConfig.refreshWorkspaceEmailReadiness(refreshOptions)

    const retryWrapper = path.join(tempRoot, 'retry-gog-wrapper.cjs')
    const retryMarker = path.join(tempRoot, 'retry-gog-marker')
    const retryInvocationLog = path.join(tempRoot, 'retry-gog-invocations.jsonl')
    fs.writeFileSync(
      retryWrapper,
      [
        '#!/usr/bin/env node',
        "const fs = require('node:fs')",
        `fs.appendFileSync(${JSON.stringify(retryInvocationLog)}, 'probe\\n')`,
        `if (!fs.existsSync(${JSON.stringify(retryMarker)})) {`,
        `  fs.writeFileSync(${JSON.stringify(retryMarker)}, 'failed-once')`,
        '  process.exit(1)',
        '}',
        "process.stdout.write(JSON.stringify({ accounts: [{ email: 'broker@example.com', services: ['gmail'], scopes: ['https://www.googleapis.com/auth/gmail.modify'] }] }) + '\\n')",
      ].join('\n'),
      { mode: 0o755 },
    )
    fs.chmodSync(retryWrapper, 0o755)
    const retryOptions = {
      account: 'broker@example.com',
      sendAuthAccount: 'broker@example.com',
      readAuthAccount: 'broker@example.com',
      wrapper: retryWrapper,
      force: true,
    }
    const failedProbe = await runtimeConfig.refreshWorkspaceEmailReadiness(retryOptions)
    assert(
      failedProbe.emailConfigured === false,
      'Workspace email failed readiness probe must remain fail-closed',
    )
    await new Promise((resolve) => setTimeout(resolve, 5))
    const recoveredProbe = await runtimeConfig.refreshWorkspaceEmailReadiness({
      ...retryOptions,
      force: false,
    })
    const retryInvocations = fs.readFileSync(retryInvocationLog, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean).length
    assert(
      recoveredProbe.emailConfigured === true && retryInvocations === 2,
      'Workspace email transient readiness failure must retry on the short failure window',
    )
  } catch (error) {
    failures.push(`Workspace email non-blocking readiness failed: ${error.message}`)
  } finally {
    if (previousCacheMs === undefined) {
      delete process.env.WORKSPACE_EMAIL_AUTH_CHECK_CACHE_MS
    } else {
      process.env.WORKSPACE_EMAIL_AUTH_CHECK_CACHE_MS = previousCacheMs
    }
    if (previousRetryMs === undefined) {
      delete process.env.WORKSPACE_EMAIL_AUTH_CHECK_RETRY_MS
    } else {
      process.env.WORKSPACE_EMAIL_AUTH_CHECK_RETRY_MS = previousRetryMs
    }
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

async function verifyCodexBackgroundDeliveryFollowUp() {
  try {
    const { toolFollowUpText } = await import(
      `../server/codex-clm.mjs?backgroundFollowUpCheck=${Date.now()}`
    )
    assert(
      typeof toolFollowUpText === 'function',
      'Codex deterministic tool follow-up must be executable in delivery regression checks',
    )
    if (typeof toolFollowUpText !== 'function') return
    for (const name of ['send_text_message', 'send_email', 'send_portal_link']) {
      const followUp = toolFollowUpText(
        { function: { name } },
        {
          ok: true,
          queued: true,
          pending: true,
          sent: false,
          status: 'processing',
        },
      )
      assert(
        /process|background|sending/i.test(followUp) &&
          !/not sent|did not go through|I sent/i.test(followUp),
        `Codex ${name} processing follow-up must keep conversation moving without claiming success or failure`,
      )
      const unverifiedFollowUp = toolFollowUpText(
        { function: { name } },
        {
          ok: false,
          sent: false,
          status: 'accepted_unverified',
          provider_accepted: true,
          observer_error: 'proof observer failed',
        },
      )
      assert(
        /proof|verify/i.test(unverifiedFollowUp) && !/I sent/i.test(unverifiedFollowUp),
        `Codex ${name} observer-failure follow-up must not convert provider acceptance into sent proof`,
      )
      const unprovenSentFollowUp = toolFollowUpText(
        { function: { name } },
        {
          ok: true,
          sent: true,
          status: 'accepted',
        },
      )
      assert(
        /proof|verify|not sent/i.test(unprovenSentFollowUp) &&
          !/I sent|was sent|delivered/i.test(unprovenSentFollowUp),
        `Codex ${name} accepted follow-up must not claim delivery without retained proof`,
      )
    }
  } catch (error) {
    failures.push(`Codex background delivery follow-up failed: ${error.message}`)
  }
}

async function verifyBackgroundVoiceDeliveryIntegration() {
  const tempRoot = makeTempDir('check-background-voice-delivery')
  const dataDir = path.join(tempRoot, 'workspace-data')
  const callLogDir = path.join(tempRoot, 'call-logs')
  const audioDir = path.join(tempRoot, 'call-audio')
  const wrapper = path.join(tempRoot, 'fake-gog-wrapper.cjs')
  const emailArgsFile = path.join(tempRoot, 'email-args.json')
  const child = path.join(tempRoot, 'check.mjs')
  try {
    fs.writeFileSync(
      wrapper,
      [
        '#!/usr/bin/env node',
        "const fs = require('node:fs')",
        "fs.appendFileSync(process.env.GOG_FAKE_SEND_ARGS_FILE, JSON.stringify(process.argv.slice(2)) + '\\n')",
        "process.stdout.write(JSON.stringify({ result: { id: 'workspace-message-check', threadId: 'workspace-thread-check', ok: true } }) + '\\n')",
      ].join('\n'),
      { mode: 0o755 },
    )
    fs.chmodSync(wrapper, 0o755)
    fs.writeFileSync(
      child,
      `import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function emailRequests() {
  if (!fs.existsSync(process.env.GOG_FAKE_SEND_ARGS_FILE)) return []
  return fs.readFileSync(process.env.GOG_FAKE_SEND_ARGS_FILE, 'utf8')
    .trim()
    .split('\\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

async function waitForBackgroundDeliveries(state, expected, label) {
  const deadline = Date.now() + 8_000
  while ((state.backgroundDeliveryResults || []).length < expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert(
    state.backgroundDeliveryResults?.length === expected,
    label + ' background provider completions did not settle'
  )
}

try {
  const root = process.argv[2]
  const smsRequests = []
  const smsReadbacks = []
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input)
    if (url.endsWith('/messages')) {
      const requestBody = JSON.parse(String(options.body || '{}'))
      smsRequests.push(requestBody)
      const messageId = requestBody.text === 'Finalized failure check.'
        ? 'telnyx-message-failure-check'
        : 'telnyx-message-check'
      return {
        ok: true,
        text: async () => JSON.stringify({
          data: {
            id: messageId,
            status: 'queued',
            to: [{ status: 'queued' }]
          }
        })
      }
    }
    if (url.endsWith('/messages/telnyx-message-failure-check')) {
      smsReadbacks.push(url)
      return {
        ok: true,
        text: async () => JSON.stringify({
          data: {
            id: 'telnyx-message-failure-check',
            status: 'delivery_failed',
            to: [{
              status: 'delivery_failed',
              errors: [{
                code: '40002',
                title: 'Blocked as spam - temporary',
                detail: 'The destination +15550000007 was not delivered.'
              }]
            }]
          }
        })
      }
    }
    if (url.endsWith('/messages/telnyx-message-check')) {
      smsReadbacks.push(url)
      return {
        ok: true,
        text: async () => JSON.stringify({
          data: {
            id: 'telnyx-message-check',
            status: 'delivered',
            to: [{ status: 'delivered' }]
          }
        })
      }
    }
    throw new Error('Unexpected test fetch: ' + url)
  }

  const store = await import(pathToFileURL(path.join(root, 'server/workspace-store.mjs')).href)
  const initial = await store.createWorkspaceLead({
    id: 'delivery-integration-contact',
    name: 'Delivery Integration Contact',
    phone: '+15550000001',
    email: 'old@example.com'
  })
  const runtime = await import(pathToFileURL(path.join(root, 'server/index.mjs')).href)
  const state = {
    callControlId: 'delivery-integration-call',
    callProvider: 'calltools',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    eventLog: [],
    lead: { ...initial },
    config: {
      agentProfileId: 'delivery-integration-agent',
      agentProfileName: 'Delivery Integration Agent',
      dialerProvider: 'calltools',
      voiceRuntimeProvider: 'inworld',
      inworldToolCallingEnabled: true
    },
    assistantResponseActive: false,
    inworldResponseActive: false,
    productionContext: true
  }
  runtime.registerVoiceDeliveryTestState(state)

  const portalSmsCountBefore = smsRequests.length
  const portalEmailCountBefore = emailRequests().length
  const ambiguousBothConfirmation = (await runtime.executeSpeakToolCall(
    state,
    'send_portal_link',
    {
      delivery_method: 'both',
      destination_confirmed: true,
      phone_number: '+15550000008',
      email: 'portal@example.com'
    }
  )).result
  const partialBothConfirmation = (await runtime.executeSpeakToolCall(
    state,
    'send_portal_link',
    {
      delivery_method: 'both',
      phone_confirmed: true,
      email_confirmed: false,
      phone_number: '+15550000008',
      email: 'portal@example.com'
    }
  )).result
  assert(
    ambiguousBothConfirmation.ok === false &&
      ambiguousBothConfirmation.reason === 'destination_not_confirmed' &&
      partialBothConfirmation.ok === false &&
      partialBothConfirmation.reason === 'destination_not_confirmed' &&
      smsRequests.length === portalSmsCountBefore &&
      emailRequests().length === portalEmailCountBefore,
    'portal delivery to both channels did not require independent phone and email confirmation'
  )

  const humeMessages = []
  const humeNativeState = {
    ...state,
    callControlId: 'delivery-native-hume-phone-call',
    callProvider: 'telnyx',
    eventLog: [],
    lead: { ...initial },
    config: {
      ...state.config,
      dialerProvider: 'telnyx',
      voiceRuntimeProvider: 'hume',
      languageModelMode: 'hume',
      languageModelProvider: 'ANTHROPIC',
      languageModelResource: 'claude-sonnet-4-6',
      codexAuthModel: '',
      useConfigTools: false
    },
    humeWs: {
      readyState: 1,
      send: (payload) => humeMessages.push(JSON.parse(payload))
    }
  }
  runtime.registerVoiceDeliveryTestState(humeNativeState)
  const humeSession = runtime.buildHumeSessionSettings(humeNativeState, { includeTools: true })
  const humeNativeToolNames = new Set((humeSession.tools || []).map((tool) => tool.name))
  assert(
    humeNativeToolNames.has('send_text_message') && humeNativeToolNames.has('send_email'),
    'Hume native session did not expose generic SMS and email tools'
  )
  await runtime.handleHumeToolCall(humeNativeState, {
    type: 'tool_call',
    name: 'send_text_message',
    tool_call_id: 'hume-native-sms-check',
    parameters: JSON.stringify({
      destination_confirmed: false,
      phone_number: '+15550000002',
      message: 'Must remain blocked.'
    })
  })
  await runtime.handleHumeToolCall(humeNativeState, {
    type: 'tool_call',
    name: 'send_email',
    tool_call_id: 'hume-native-email-check',
    parameters: JSON.stringify({
      destination_confirmed: false,
      email: 'new@example.com',
      subject: 'Must remain blocked',
      body: 'Must remain blocked.'
    })
  })
  const humeToolResponses = humeMessages.filter((message) => message.type === 'tool_response')
  assert(
    humeToolResponses.length === 2 &&
      humeToolResponses.every(
        (message) => JSON.parse(message.content).reason === 'destination_not_confirmed'
      ),
    'Hume native tool events did not reach the shared confirmed-destination dispatcher'
  )

  const humeSmsCountBefore = smsRequests.length
  const humeEmailCountBefore = emailRequests().length
  await runtime.handleHumeToolCall(humeNativeState, {
    type: 'tool_call',
    name: 'send_text_message',
    tool_call_id: 'hume-native-sms-background-check',
    parameters: JSON.stringify({
      destination_confirmed: true,
      phone_number: '+15550000005',
      message: 'Hume native background SMS check.'
    })
  })
  await runtime.handleHumeToolCall(humeNativeState, {
    type: 'tool_call',
    name: 'send_email',
    tool_call_id: 'hume-native-email-background-check',
    parameters: JSON.stringify({
      destination_confirmed: true,
      email: 'hume-native@example.com',
      subject: 'Hume native background email check',
      body: 'Hume must return its tool envelope before provider work starts.'
    })
  })
  const humeBackgroundResponses = humeMessages.filter(
    (message) =>
      message.type === 'tool_response' &&
      ['hume-native-sms-background-check', 'hume-native-email-background-check'].includes(
        message.tool_call_id
      )
  )
  assert(
    humeBackgroundResponses.length === 2 &&
      humeBackgroundResponses.every((message) => {
        const result = JSON.parse(message.content)
        return result.ok === true &&
          result.pending === true &&
          result.sent === false &&
          result.status === 'processing' &&
          Boolean(result.request_id)
      }),
    'Hume native SMS/email envelopes did not return shared background-processing results'
  )
  assert(
    smsRequests.length === humeSmsCountBefore &&
      emailRequests().length === humeEmailCountBefore,
    'Hume native SMS/email provider work started before both tool responses released the conversation'
  )
  await waitForBackgroundDeliveries(humeNativeState, 2, 'Hume native')
  assert(
    smsRequests.length === humeSmsCountBefore + 1 &&
      emailRequests().length === humeEmailCountBefore + 1 &&
      humeNativeState.backgroundDeliveryResults.every(
        (result) => result.sent === true && Boolean(result.proof)
      ),
    'Hume native SMS/email envelopes did not settle through the shared provider-proof queue'
  )

  const inworldMessages = []
  const inworldNativeState = {
    ...state,
    callControlId: 'delivery-native-inworld-calltools-call',
    callProvider: 'calltools',
    eventLog: [],
    lead: { ...initial },
    config: {
      ...state.config,
      dialerProvider: 'calltools',
      voiceRuntimeProvider: 'inworld',
      languageModelMode: 'inworld',
      languageModelResource: 'google-ai-studio/gemini-2.5-flash',
      inworldRealtimeModel: 'google-ai-studio/gemini-2.5-flash',
      codexAuthModel: '',
      inworldToolCallingEnabled: true
    },
    inworldWs: {
      readyState: 1,
      send: (payload) => inworldMessages.push(JSON.parse(payload))
    }
  }
  runtime.registerVoiceDeliveryTestState(inworldNativeState)
  const inworldSession = runtime.buildInworldSession(inworldNativeState, { includeTools: true })
  const inworldNativeToolNames = new Set((inworldSession.tools || []).map((tool) => tool.name))
  assert(
    inworldNativeToolNames.has('send_text_message') && inworldNativeToolNames.has('send_email'),
    'Inworld native session did not expose generic SMS and email tools'
  )
  const inworldSmsCountBefore = smsRequests.length
  const inworldEmailCountBefore = emailRequests().length
  await runtime.handleInworldToolCall(inworldNativeState, {
    type: 'response.function_call_arguments.done',
    name: 'send_text_message',
    call_id: 'inworld-native-sms-check',
    arguments: JSON.stringify({
      destination_confirmed: false,
      phone_number: '+15550000002',
      message: 'Must remain blocked.'
    })
  })
  await runtime.handleInworldToolCall(inworldNativeState, {
    type: 'response.function_call_arguments.done',
    name: 'send_email',
    call_id: 'inworld-native-email-check',
    arguments: JSON.stringify({
      destination_confirmed: false,
      email: 'new@example.com',
      subject: 'Must remain blocked',
      body: 'Must remain blocked.'
    })
  })
  const inworldToolResponses = inworldMessages.filter(
    (message) => message.type === 'conversation.item.create' &&
      message.item?.type === 'function_call_output'
  )
  assert(
    inworldToolResponses.length === 2 &&
      inworldToolResponses.every(
        (message) => JSON.parse(message.item.output).reason === 'destination_not_confirmed'
      ),
    'Inworld native tool events did not reach the shared confirmed-destination dispatcher'
  )
  assert(
    smsRequests.length === inworldSmsCountBefore &&
      emailRequests().length === inworldEmailCountBefore,
    'native provider confirmation guards started an external delivery'
  )

  const inworldResponseCreateCountBefore = inworldMessages.filter(
    (message) => message.type === 'response.create'
  ).length
  await runtime.handleInworldToolCall(inworldNativeState, {
    type: 'response.function_call_arguments.done',
    name: 'send_text_message',
    call_id: 'inworld-native-sms-background-check',
    arguments: JSON.stringify({
      destination_confirmed: true,
      phone_number: '+15550000006',
      message: 'Inworld native background SMS check.'
    })
  })
  await runtime.handleInworldToolCall(inworldNativeState, {
    type: 'response.function_call_arguments.done',
    name: 'send_email',
    call_id: 'inworld-native-email-background-check',
    arguments: JSON.stringify({
      destination_confirmed: true,
      email: 'inworld-native@example.com',
      subject: 'Inworld native background email check',
      body: 'Inworld must return its tool envelope before provider work starts.'
    })
  })
  const inworldBackgroundResponses = inworldMessages.filter(
    (message) =>
      message.type === 'conversation.item.create' &&
      message.item?.type === 'function_call_output' &&
      ['inworld-native-sms-background-check', 'inworld-native-email-background-check'].includes(
        message.item.call_id
      )
  )
  const inworldResponseCreateCountAfter = inworldMessages.filter(
    (message) => message.type === 'response.create'
  ).length
  assert(
    inworldBackgroundResponses.length === 2 &&
      inworldBackgroundResponses.every((message) => {
        const result = JSON.parse(message.item.output)
        return result.ok === true &&
          result.pending === true &&
          result.sent === false &&
          result.status === 'processing' &&
          Boolean(result.request_id)
      }) &&
      inworldResponseCreateCountAfter === inworldResponseCreateCountBefore + 2,
    'Inworld native SMS/email envelopes did not return shared background-processing results and resume responses'
  )
  assert(
    smsRequests.length === inworldSmsCountBefore &&
      emailRequests().length === inworldEmailCountBefore,
    'Inworld native SMS/email provider work started before both tool outputs released the conversation'
  )
  await waitForBackgroundDeliveries(inworldNativeState, 2, 'Inworld native')
  assert(
    smsRequests.length === inworldSmsCountBefore + 1 &&
      emailRequests().length === inworldEmailCountBefore + 1 &&
      inworldNativeState.backgroundDeliveryResults.every(
        (result) => result.sent === true && Boolean(result.proof)
      ),
    'Inworld native SMS/email envelopes did not settle through the shared provider-proof queue'
  )

  const blocked = (await runtime.executeSpeakToolCall(state, 'send_text_message', {
    destination_confirmed: false,
    phone_number: '+15550000002',
    message: 'Confirmation is required.'
  })).result
  assert(blocked.reason === 'destination_not_confirmed', 'unconfirmed SMS was not rejected')

  const directSmsCountBefore = smsRequests.length
  const directEmailCountBefore = emailRequests().length
  const sms = (await runtime.executeSpeakToolCall(state, 'send_text_message', {
    destination_confirmed: true,
    phone_number: '+15550000002',
    message: 'Shared delivery integration check.'
  })).result
  assert(
    smsRequests.length === directSmsCountBefore,
    'Telnyx started before its voice tool response was released'
  )
  assert(state.lead.phone === '+15550000001', 'contact phone changed before provider acceptance')
  const duplicateSms = (await runtime.executeSpeakToolCall(state, 'send_text_message', {
    destination_confirmed: true,
    phone_number: '+15550000002',
    message: 'Shared delivery integration check.'
  })).result
  const email = (await runtime.executeSpeakToolCall(state, 'send_email', {
    destination_confirmed: true,
    email: 'new@example.com',
    subject: 'Shared delivery integration check',
    body: 'The active agent supplied this explicit content.'
  })).result
  assert(
    emailRequests().length === directEmailCountBefore,
    'Workspace email started before its voice tool response was released'
  )

  for (const result of [sms, email]) {
    assert(
      result.ok === true && result.pending === true && result.sent === false && result.status === 'processing',
      'voice delivery did not return processing before provider work'
    )
  }
  assert(
    duplicateSms.deduplicated === true && duplicateSms.request_id === sms.request_id,
    'identical in-flight voice delivery was not deduplicated'
  )

  const deadline = Date.now() + 8_000
  while ((state.backgroundDeliveryResults || []).length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert(state.backgroundDeliveryResults?.length === 2, 'background provider completions did not settle')
  assert(
    smsRequests.length === directSmsCountBefore + 1,
    'deduplicated SMS invoked Telnyx more than once'
  )
  assert(smsReadbacks.length >= 1, 'SMS completion did not use final Telnyx readback proof')
  const directSmsRequest = smsRequests[directSmsCountBefore]
  assert(
    directSmsRequest.to === '+15550000002' &&
      directSmsRequest.from === '+15550000003' &&
      directSmsRequest.messaging_profile_id === 'delivery-profile-check' &&
      !JSON.stringify(directSmsRequest).includes('+15550000004'),
    'shared SMS delivery did not use the confirmed override and Speak-owned Telnyx sender'
  )
  const emailArgs = emailRequests().find((args) => args.includes('new@example.com')) || []
  assert(
    emailArgs.includes('--to') &&
      emailArgs.includes('new@example.com') &&
      emailArgs.includes('--from') &&
      emailArgs.includes('speak@example.com') &&
      !emailArgs.includes('old@example.com'),
    'shared email delivery did not use the confirmed override and Workspace sender'
  )

  const smsCompletion = state.backgroundDeliveryResults.find((item) => item.channel === 'sms')
  const emailCompletion = state.backgroundDeliveryResults.find((item) => item.channel === 'email')
  assert(
    smsCompletion?.request_id === sms.request_id &&
      smsCompletion?.sent === true &&
      smsCompletion?.proof?.message_id === 'telnyx-message-check' &&
      smsCompletion?.proof?.status === 'delivered' &&
      smsCompletion?.proof?.delivery_finalized === true &&
      smsCompletion?.proof?.contact_update?.persisted === true,
    'SMS completion did not retain correlated provider and contact-persistence proof'
  )
  assert(
    emailCompletion?.request_id === email.request_id &&
      emailCompletion?.sent === true &&
      emailCompletion?.proof?.message_id === 'workspace-message-check' &&
      emailCompletion?.proof?.thread_id === 'workspace-thread-check' &&
      emailCompletion?.proof?.contact_update?.persisted === true,
    'email completion did not retain correlated provider and contact-persistence proof'
  )
  assert(state.lead.phone === '+15550000002' && state.lead.email === 'new@example.com', 'confirmed recipient overrides did not update active call context')
  const snapshot = await store.listWorkspaceLeads({ limit: 20 })
  const persisted = snapshot.leads.find((lead) => lead.id === initial.id)
  assert(persisted?.phone === '+15550000002' && persisted?.email === 'new@example.com', 'confirmed recipient overrides were not durably persisted')
  await new Promise((resolve) => setImmediate(resolve))
  const settledDuplicateSms = (await runtime.executeSpeakToolCall(state, 'send_text_message', {
    destination_confirmed: true,
    phone_number: '+15550000002',
    message: 'Shared delivery integration check.'
  })).result
  assert(
    settledDuplicateSms.deduplicated === true &&
      settledDuplicateSms.pending === false &&
      settledDuplicateSms.sent === true &&
      settledDuplicateSms.proof?.message_id === 'telnyx-message-check' &&
      settledDuplicateSms.proof?.contact_update?.persisted === true &&
      smsRequests.length === directSmsCountBefore + 1,
    'post-settlement duplicate did not retain provider and contact-persistence proof without resending'
  )
  const failureRequestCountBefore = smsRequests.length
  const failedSms = (await runtime.executeSpeakToolCall(state, 'send_text_message', {
    destination_confirmed: true,
    phone_number: '+15550000007',
    message: 'Finalized failure check.'
  })).result
  assert(
    failedSms.pending === true && failedSms.sent === false && failedSms.status === 'processing',
    'finalized-failure SMS did not release the voice response as processing'
  )
  assert(
    smsRequests.length === failureRequestCountBefore,
    'finalized-failure SMS provider started before the voice response was released'
  )
  const failureDeadline = Date.now() + 8_000
  while ((state.backgroundDeliveryResults || []).length < 3 && Date.now() < failureDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  const failedCompletion = (state.backgroundDeliveryResults || []).find(
    (item) => item.proof?.message_id === 'telnyx-message-failure-check'
  )
  assert(
    smsRequests.length === failureRequestCountBefore + 1 &&
      failedCompletion?.status === 'failed' &&
      failedCompletion?.sent === false &&
      failedCompletion?.provider_accepted === true &&
      failedCompletion?.delivery_finalized === true &&
      failedCompletion?.proof?.provider_status === 'delivery_failed' &&
      failedCompletion?.proof?.error_code === '40002' &&
      !JSON.stringify(failedCompletion).includes('+15550000007'),
    'final Telnyx 40002 failure was not retained as sanitized failed proof'
  )
  assert(
    state.lead.phone === '+15550000002',
    'failed SMS finalization changed the persisted contact phone'
  )
  process.stdout.write(JSON.stringify({ ok: true }) + '\\n')
  process.exit(0)
} catch (error) {
  console.error(error instanceof Error ? error.stack : error)
  process.exit(1)
}
`,
    )

    const result = spawnSync(process.execPath, [child, process.cwd()], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: '0',
        BASE_PATH: '/speak',
        PUBLIC_BASE_URL: 'http://127.0.0.1',
        SPEAK_WORKSPACE_DATA_DIR: dataDir,
        BACKGROUND_DELIVERY_OUTBOX_PATH: path.join(
          dataDir,
          'background-delivery-outbox.json',
        ),
        SPEAK_CALL_LOG_DIR: callLogDir,
        SPEAK_CALL_AUDIO_DIR: audioDir,
        TELNYX_API_KEY: 'delivery-integration-key',
        TELNYX_SMS_NUMBER: '+15550000003',
        TELNYX_FROM_NUMBER: '+15550000003',
        TELNYX_MESSAGING_PROFILE_ID: 'delivery-profile-check',
        TELNYX_SMS_FINALIZATION_TIMEOUT_MS: '1000',
        TELNYX_SMS_FINALIZATION_POLL_MS: '5',
        CALLTOOLS_PHONE_NUMBER: '+15550000004',
        CALLTOOLS_API_KEY: '',
        HUME_API_KEY: '',
        INWORLD_API_KEY: '',
        WORKSPACE_EMAIL_ACCOUNT: 'speak@example.com',
        WORKSPACE_EMAIL_GOG_ACCOUNT: 'speak@example.com',
        WORKSPACE_EMAIL_SEND_GOG_ACCOUNT: 'speak@example.com',
        GOG_WRAPPER: wrapper,
        GOG_FAKE_SEND_ARGS_FILE: emailArgsFile,
        CALLTOOLS_DUTY_MONITOR_INTERVAL_MS: '600000',
      },
      timeout: DELIVERY_INTEGRATION_PROCESS_TIMEOUT_MS,
    })
    assert(
      result.status === 0 && /\{"ok":true\}/.test(result.stdout || ''),
      `background voice delivery integration failed: ${String(result.stderr || result.stdout).slice(0, 800)}`,
    )
  } catch (error) {
    failures.push(`background voice delivery integration failed: ${error.message}`)
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

async function verifyBackgroundDeliveryShutdownDrain() {
  const tempRoot = makeTempDir('check-background-delivery-shutdown')
  const dataDir = path.join(tempRoot, 'workspace-data')
  const callLogDir = path.join(tempRoot, 'call-logs')
  const audioDir = path.join(tempRoot, 'call-audio')
  const wrapper = path.join(tempRoot, 'slow-gog-wrapper.cjs')
  const providerMarker = path.join(tempRoot, 'provider-complete.txt')
  const child = path.join(tempRoot, 'check.mjs')
  try {
    fs.writeFileSync(
      wrapper,
      [
        '#!/usr/bin/env node',
        "const fs = require('node:fs')",
        'setTimeout(() => {',
        `  fs.writeFileSync(${JSON.stringify(providerMarker)}, 'complete')`,
        "  process.stdout.write(JSON.stringify({ result: { id: 'shutdown-workspace-message-check', threadId: 'shutdown-workspace-thread-check', ok: true } }) + '\\n')",
        '}, 1200)',
      ].join('\n'),
      { mode: 0o755 },
    )
    fs.chmodSync(wrapper, 0o755)
    fs.writeFileSync(
      child,
      `import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.argv[2]
const store = await import(pathToFileURL(path.join(root, 'server/workspace-store.mjs')).href)
const initial = await store.createWorkspaceLead({
  id: 'shutdown-delivery-contact',
  name: 'Shutdown Delivery Contact',
  email: 'old-shutdown@example.com'
})
const runtime = await import(pathToFileURL(path.join(root, 'server/index.mjs')).href)
const state = {
  callControlId: 'shutdown-delivery-call',
  callProvider: 'calltools',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  eventLog: [],
  lead: { ...initial },
  config: {
    agentProfileId: 'shutdown-delivery-agent',
    agentProfileName: 'Shutdown Delivery Agent',
    dialerProvider: 'calltools',
    voiceRuntimeProvider: 'inworld',
    languageModelMode: 'inworld',
    inworldToolCallingEnabled: true
  },
  productionContext: true
}
runtime.registerVoiceDeliveryTestState(state)
const delivery = (await runtime.executeSpeakToolCall(state, 'send_email', {
  destination_confirmed: true,
  email: 'new-shutdown@example.com',
  subject: 'Shutdown drain check',
  body: 'This uses a delayed fake provider.'
})).result
if (!delivery.pending || delivery.sent) throw new Error('delivery did not queue before shutdown')
await new Promise((resolve) => setTimeout(resolve, 75))
process.kill(process.pid, 'SIGTERM')
`,
    )

    const result = spawnSync(process.execPath, [child, process.cwd()], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: '0',
        BASE_PATH: '/speak',
        PUBLIC_BASE_URL: 'http://127.0.0.1',
        SPEAK_WORKSPACE_DATA_DIR: dataDir,
        BACKGROUND_DELIVERY_OUTBOX_PATH: path.join(
          dataDir,
          'background-delivery-outbox.json',
        ),
        SPEAK_CALL_LOG_DIR: callLogDir,
        SPEAK_CALL_AUDIO_DIR: audioDir,
        HUME_API_KEY: '',
        INWORLD_API_KEY: '',
        CALLTOOLS_API_KEY: '',
        WORKSPACE_EMAIL_ACCOUNT: 'speak@example.com',
        WORKSPACE_EMAIL_GOG_ACCOUNT: 'speak@example.com',
        WORKSPACE_EMAIL_SEND_GOG_ACCOUNT: 'speak@example.com',
        WORKSPACE_EMAIL_TIMEOUT_MS: '5000',
        GOG_WRAPPER: wrapper,
        CALLTOOLS_DUTY_MONITOR_INTERVAL_MS: '600000',
      },
      timeout: DELIVERY_SHUTDOWN_PROCESS_TIMEOUT_MS,
    })
    const workspacePath = path.join(dataDir, 'workspace.json')
    const workspaceText = fs.existsSync(workspacePath)
      ? fs.readFileSync(workspacePath, 'utf8')
      : ''
    assert(
      result.status === 0 &&
        fs.existsSync(providerMarker) &&
        workspaceText.includes('new-shutdown@example.com') &&
        workspaceText.includes('shutdown-workspace-message-check'),
      `voice shutdown did not drain provider acceptance, contact persistence, and communication proof: ${String(result.stderr || result.stdout).slice(0, 800)}`,
    )
  } catch (error) {
    failures.push(`background delivery shutdown drain failed: ${error.message}`)
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

async function verifyDirectDeliveryShutdownDrain() {
  const tempRoot = makeTempDir('check-direct-delivery-shutdown')
  const dataDir = path.join(tempRoot, 'workspace-data')
  const callLogDir = path.join(tempRoot, 'call-logs')
  const audioDir = path.join(tempRoot, 'call-audio')
  const providerStartedMarker = path.join(tempRoot, 'provider-started.txt')
  const providerCompleteMarker = path.join(tempRoot, 'provider-complete.txt')
  const child = path.join(tempRoot, 'check.mjs')
  try {
    const port = await freePort()
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(
      path.join(dataDir, 'workspace.json'),
      JSON.stringify({ version: 7, preflightPadding: 'x'.repeat(32 * 1024 * 1024) }),
    )
    fs.writeFileSync(
      child,
      `import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.argv[2]
const providerStartedMarker = process.argv[3]
const providerCompleteMarker = process.argv[4]
globalThis.fetch = async (input) => {
  const url = String(input)
  if (!url.endsWith('/messages')) throw new Error('Unexpected test fetch: ' + url)
  fs.writeFileSync(providerStartedMarker, 'started')
  await new Promise((resolve) => setTimeout(resolve, 1200))
  fs.writeFileSync(providerCompleteMarker, 'complete')
  return {
    ok: true,
    text: async () => JSON.stringify({
      data: {
        id: 'direct-shutdown-message-check',
        status: 'queued',
        to: [{ status: 'queued' }]
      }
    })
  }
}

await import(pathToFileURL(path.join(root, 'server/index.mjs')).href)

async function waitForServer() {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const request = http.get(
          'http://127.0.0.1:' + process.env.PORT + '/speak/api/health',
          (response) => {
            response.resume()
            response.on('end', resolve)
          }
        )
        request.on('error', reject)
      })
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  throw new Error('temporary Speak server did not become ready')
}

await waitForServer()
const payload = JSON.stringify({
  channel: 'sms',
  threadId: 'client-abort-preflight-thread',
  contactId: 'direct-shutdown-contact',
  lead: {
    id: 'direct-shutdown-contact',
    name: 'Direct Shutdown Contact',
    phone: '+15550000002'
  },
  phone: '+15550000002',
  body: 'Delayed fake direct send.'
})
const directRequest = http.request({
  hostname: '127.0.0.1',
  port: Number(process.env.PORT),
  path: '/speak/api/communication-messages/send',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  }
})
directRequest.on('error', () => {})
const requestFlushed = new Promise((resolve) => directRequest.once('finish', resolve))
directRequest.end(payload)
await requestFlushed
await new Promise((resolve) => setTimeout(resolve, 2))
if (fs.existsSync(providerStartedMarker)) throw new Error('provider started before preflight abort')
directRequest.destroy()
process.kill(process.pid, 'SIGTERM')
`,
    )

    const result = spawnSync(
      process.execPath,
      [child, process.cwd(), providerStartedMarker, providerCompleteMarker],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_ENV: 'test',
          PORT: String(port),
          BASE_PATH: '/speak',
          PUBLIC_BASE_URL: `http://127.0.0.1:${port}/speak`,
          SPEAK_WORKSPACE_DATA_DIR: dataDir,
          BACKGROUND_DELIVERY_OUTBOX_PATH: path.join(
            dataDir,
            'background-delivery-outbox.json',
          ),
          SPEAK_CALL_LOG_DIR: callLogDir,
          SPEAK_CALL_AUDIO_DIR: audioDir,
          TELNYX_API_KEY: 'direct-shutdown-key',
          TELNYX_SMS_NUMBER: '+15550000003',
          TELNYX_FROM_NUMBER: '+15550000003',
          TELNYX_MESSAGING_PROFILE_ID: 'direct-shutdown-profile',
          TELNYX_SMS_FINALIZATION_POLL_MS: '25',
          TELNYX_SMS_FINALIZATION_TIMEOUT_MS: '100',
          HUME_API_KEY: '',
          INWORLD_API_KEY: '',
          CALLTOOLS_API_KEY: '',
          CALLTOOLS_DUTY_MONITOR_INTERVAL_MS: '600000',
        },
        timeout: DELIVERY_SHUTDOWN_PROCESS_TIMEOUT_MS,
      },
    )
    const workspacePath = path.join(dataDir, 'workspace.json')
    const workspaceText = fs.existsSync(workspacePath)
      ? fs.readFileSync(workspacePath, 'utf8')
      : ''
    assert(
      result.status === 0 &&
        fs.existsSync(providerStartedMarker) &&
        fs.existsSync(providerCompleteMarker) &&
        workspaceText.includes('direct-shutdown-message-check'),
      `voice shutdown did not drain a client-aborted direct provider request and its proof: ${JSON.stringify({ status: result.status, signal: result.signal, error: result.error?.message || '', providerStarted: fs.existsSync(providerStartedMarker), providerComplete: fs.existsSync(providerCompleteMarker) })} ${String(result.stderr || result.stdout).slice(0, 800)}`,
    )
  } catch (error) {
    failures.push(`direct delivery shutdown drain failed: ${error.message}`)
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

async function verifyCommunicationStoreRoundTrip() {
  const tempDataDir = makeTempDir('check-communication-threads')
  const previousDataDir = process.env.SPEAK_WORKSPACE_DATA_DIR
  process.env.SPEAK_WORKSPACE_DATA_DIR = tempDataDir
  try {
    const store = await import(`../server/workspace-store.mjs?check=${Date.now()}`)
    const lead = {
      id: 'lead-communication-check',
      name: 'Casey Contact',
      company: 'Casey Coffee',
      phone: '+15551234567',
      email: 'casey@example.com',
    }
    const config = {
      agentProfileId: 'profile-communication-check',
      agentProfileName: 'Communication Check Agent',
      voiceRuntimeProvider: 'inworld',
    }

    const first = await store.recordCommunicationEvent({
      callControlId: 'call-communication-check',
      chatId: 'session-communication-check',
      lead,
      config,
      createdAt: '2026-07-02T12:00:00.000Z',
      event: {
        entry: {
          id: 'turn-contact-pricing',
          at: '2026-07-02T12:00:00.000Z',
          speaker: 'Lead',
          text: 'Please text me the pricing.',
          emotionScores: {
            calmness: 0.64,
            interest: 0.51,
          },
        },
      },
    })
    assert(first?.thread?.threadId, 'recordCommunicationEvent did not create a thread')
    assert(first?.message?.messageId, 'recordCommunicationEvent did not create a message')
    assert(first?.message?.role === 'contact', 'generic Lead transcript speaker must normalize to contact role')
    assert(first?.message?.direction === 'inbound', 'contact transcript speaker must normalize to inbound direction')

    const second = await store.recordCommunicationEvent({
      callControlId: 'call-communication-check',
      chatId: 'session-communication-check',
      lead,
      config,
      createdAt: '2026-07-02T12:01:00.000Z',
      event: {
        entry: {
          id: 'tool-sms-proof',
          at: '2026-07-02T12:01:00.000Z',
          speaker: 'Tool',
          text: 'Text message sent.',
        },
        communication: {
          channel: 'sms',
          modality: 'text',
          direction: 'outbound',
          role: 'agent',
          body: 'Here is the pricing link.',
          provider: 'telnyx',
          proof: {
            message_id: 'msg-communication-check',
            status: 'queued',
          },
        },
      },
    })
    assert(second?.thread?.channels?.includes('sms'), 'SMS event did not update thread channels')

    const inboundSms = await store.recordCommunicationEvent({
      createdAt: '2026-07-02T12:02:00.000Z',
      event: {
        communication: {
          channel: 'sms',
          modality: 'text',
          direction: 'inbound',
          role: 'contact',
          body: 'Can you send that quote to my email too?',
          provider: 'telnyx',
          identity: {
            phone: '+15551234567',
          },
          providerIds: {
            messageId: 'msg-inbound-communication-check',
          },
        },
      },
    })
    assert(
      inboundSms?.thread?.contactId === lead.id,
      'inbound SMS did not attach through verified phone attribution',
    )
    assert(
      inboundSms?.message?.providerIds?.fromPhone === '+15551234567' &&
        inboundSms?.message?.providerIds?.fromPhones?.includes('+15551234567'),
      'inbound SMS identity phone did not persist as reply-target provider IDs',
    )

    const outboundSmsSource = await store.recordCommunicationEvent({
      createdAt: '2026-07-02T12:02:30.000Z',
      event: {
        communication: {
          channel: 'sms',
          modality: 'text',
          direction: 'outbound',
          role: 'agent',
          body: 'Outbound source mirror for the quote.',
          provider: 'telnyx',
          identity: {
            phone: '+15551234567',
          },
          providerIds: {
            messageId: 'msg-outbox-source-communication-check',
          },
          proof: {
            message_id: 'msg-outbox-source-communication-check',
            automation: {
              smsAutoResponse: 'none',
              reason: 'outbox_source_record_only',
            },
          },
        },
      },
    })
    assert(
      outboundSmsSource?.thread?.contactId === lead.id,
      'outbound SMS source did not attach through verified phone attribution',
    )
    assert(
      outboundSmsSource?.message?.providerIds?.toPhone === '+15551234567' &&
        outboundSmsSource?.message?.providerIds?.toPhones?.includes('+15551234567'),
      'outbound SMS identity phone did not persist as destination provider IDs',
    )

    const sentEmail = await store.recordCommunicationEvent({
      createdAt: '2026-07-02T12:02:45.000Z',
      event: {
        communication: {
          channel: 'email',
          modality: 'text',
          direction: 'outbound',
          role: 'agent',
          body: 'Subject: Quote\n\nHere is the quote by email.',
          provider: 'google_workspace',
          identity: {
            email: 'casey@example.com',
            externalThreadId: 'email-thread-casey-communication-check',
          },
          providerIds: {
            messageId: 'email-sent-communication-check',
            emailThreadId: 'email-thread-casey-communication-check',
          },
          proof: {
            message_id: 'email-sent-communication-check',
            thread_id: 'email-thread-casey-communication-check',
            automation: {
              emailAutoReply: 'none',
              reason: 'sent_source_record_only',
            },
          },
        },
      },
    })
    assert(
      sentEmail?.thread?.contactId === lead.id,
      'sent email source did not attach through verified email attribution',
    )
    assert(
      sentEmail?.message?.providerIds?.toEmail === 'casey@example.com' &&
        sentEmail?.message?.providerIds?.toEmails?.includes('casey@example.com') &&
        sentEmail?.message?.providerIds?.emailThreadId === 'email-thread-casey-communication-check',
      'sent email identity did not persist destination and external-thread provider IDs',
    )
    assert(
      sentEmail?.thread?.latestMessagePreview === 'Quote' &&
        sentEmail?.thread?.summary?.includes('agent: Quote') &&
        !sentEmail?.thread?.summary?.includes('Here is the quote by email'),
      'sent email thread preview/summary did not collapse to subject-only',
    )

    const missedCall = await store.recordCommunicationEvent({
      callControlId: 'call-inbound-missed-communication-check',
      createdAt: '2026-07-02T12:02:50.000Z',
      event: {
        communication: {
          channel: 'call',
          modality: 'voice',
          direction: 'inbound',
          role: 'contact',
          body: 'Missed inbound call from contact.',
          provider: 'telnyx',
          identity: {
            phone: '+15551234567',
          },
          providerIds: {
            callControlId: 'call-inbound-missed-communication-check',
          },
          proof: {
            action: 'missed_call',
            automation: {
              inboundCallAutoAnswer: false,
              reason: 'default_off_no_explicit_context_policy',
            },
          },
        },
      },
    })
    assert(
      missedCall?.thread?.contactId === lead.id &&
        missedCall?.message?.proof?.action === 'missed_call',
      'missed inbound call did not attach with default-off missed-call proof',
    )

    const staleDefaultOffInboundCall = await store.recordCommunicationEvent({
      createdAt: '2026-07-02T12:02:52.000Z',
      event: {
        communication: {
          channel: 'call',
          modality: 'voice',
          direction: 'inbound',
          role: 'contact',
          body: 'Inbound call received from +15***4321 (call.initiated)',
          provider: 'telnyx',
          identity: {
            phone: '+15557654321',
          },
          providerIds: {
            callControlId: 'call-default-off-repair-communication-check',
            sourceEventId: 'call-default-off-repair-event-check',
          },
          proof: {
            action: 'inbound_call_received',
            automation: {
              inboundCallAutoAnswer: false,
              reason: 'telnyx_webhook_record_only',
            },
          },
        },
      },
    })
    assert(
      staleDefaultOffInboundCall?.message?.body?.startsWith('Inbound call received'),
      'default-off inbound call repair fixture was not recorded with stale received-call body text',
    )
    const defaultOffInboundCallDryRun = await store.repairDefaultOffInboundCallMessages()
    assert(
      defaultOffInboundCallDryRun?.repairableMessages === 1 &&
        defaultOffInboundCallDryRun?.repairs?.[0]?.messageId ===
          staleDefaultOffInboundCall.message.messageId,
      'default-off inbound call repair dry-run did not detect stale received-call source records',
    )
    const defaultOffInboundCallApplied = await store.repairDefaultOffInboundCallMessages({
      apply: true,
    })
    const defaultOffInboundCallAfterApply = await store.repairDefaultOffInboundCallMessages()
    const repairedDefaultOffInboundCallMessages = await store.listCommunicationThreadMessages(
      staleDefaultOffInboundCall.thread.threadId,
      { limit: 10 },
    )
    const repairedDefaultOffInboundCallMessage =
      repairedDefaultOffInboundCallMessages.messages.find(
        (message) => message.messageId === staleDefaultOffInboundCall.message.messageId,
      )
    assert(
      defaultOffInboundCallApplied?.ok &&
        defaultOffInboundCallApplied?.applied === 1 &&
        defaultOffInboundCallAfterApply?.repairableMessages === 0 &&
        repairedDefaultOffInboundCallMessage?.body?.startsWith('Missed inbound call') &&
        repairedDefaultOffInboundCallMessage?.proof?.action === 'missed_call',
      'default-off inbound call repair did not persist missed-call body text and proof action',
    )

    const providerIdsOnlyCall = await store.recordCommunicationEvent({
      createdAt: '2026-07-02T12:02:55.000Z',
      event: {
        communication: {
          channel: 'call',
          modality: 'voice',
          direction: 'inbound',
          role: 'contact',
          body: 'Inbound call provider event with providerIds only.',
          provider: 'telnyx',
          identity: {
            phone: '+15551234567',
          },
          providerIds: {
            callControlId: 'call-provider-ids-only-communication-check',
          },
        },
      },
    })
    assert(
      providerIdsOnlyCall?.thread?.providerLinks?.some(
        (link) =>
          link.kind === 'call_control' &&
          link.id === 'call-provider-ids-only-communication-check',
      ),
      'providerIds-only call event did not materialize a call_control provider link',
    )

    const unresolvedEmail = await store.recordCommunicationEvent({
      createdAt: '2026-07-02T12:03:00.000Z',
      event: {
        communication: {
          channel: 'email',
          modality: 'text',
          direction: 'inbound',
          role: 'contact',
          body: 'Unknown sender asking for details.',
          provider: 'google_workspace',
          identity: {
            email: 'unknown@example.com',
          },
          providerIds: {
            messageId: 'email-unknown-communication-check',
            emailThreadId: 'thread-unknown-communication-check',
          },
        },
      },
    })
    assert(
      unresolvedEmail?.thread?.status === 'unresolved_attribution',
      'unknown inbound email did not create an unresolved-attribution thread',
    )
    assert(
      unresolvedEmail?.message?.providerIds?.fromEmail === 'unknown@example.com' &&
        unresolvedEmail?.message?.providerIds?.fromEmails?.includes('unknown@example.com'),
      'unresolved inbound email identity did not persist as reply-target provider IDs',
    )

    const threads = await store.listCommunicationThreads({
      contactId: lead.id,
      channels: ['sms'],
      limit: 10,
    })
    assert(threads.threads.length === 1, 'listCommunicationThreads did not filter by contact/channel')

    const unresolvedEmailThreads = await store.listCommunicationThreads({
      channel: 'email',
      status: 'unresolved_attribution',
      limit: 10,
    })
    assert(
      unresolvedEmailThreads.threads.length === 1 &&
        unresolvedEmailThreads.threads[0].threadId === unresolvedEmail.thread.threadId,
      'listCommunicationThreads did not filter by string channel/status',
    )

    const updatedThreads = await store.listCommunicationThreads({
      updatedAfter: '2026-07-02T12:02:56.000Z',
      limit: 10,
    })
    assert(
      updatedThreads.threads.length === 1 &&
        updatedThreads.threads[0].threadId === unresolvedEmail.thread.threadId,
      'listCommunicationThreads did not filter by updatedAfter',
    )

    const firstThreadPage = await store.listCommunicationThreads({ limit: 1 })
    const secondThreadPage = await store.listCommunicationThreads({
      cursor: firstThreadPage.nextCursor,
      limit: 10,
    })
    assert(
      firstThreadPage.threads.length === 1 &&
        firstThreadPage.nextCursor === firstThreadPage.threads[0].threadId &&
        secondThreadPage.threads.every(
          (thread) => thread.threadId !== firstThreadPage.threads[0].threadId,
        ),
      'listCommunicationThreads cursor did not page after the returned cursor',
    )

    const threadId = threads.threads[0].threadId
    const thread = await store.readCommunicationThread(threadId)
    assert(
      thread?.thread?.summary?.includes('providerIds only'),
      'readCommunicationThread missing latest materialized summary',
    )
    assert(thread?.thread?.channels?.includes('email'), 'thread missing sent email source channel')
    assert(thread?.thread?.messageCount === 7, 'thread missing materialized message count')
    assert(thread?.thread?.hasEmotionScores === true, 'thread missing materialized score coverage')
    assert(thread?.thread?.emotionScoreTurns === 1, 'thread missing materialized score-turn count')

    const messages = await store.listCommunicationThreadMessages(threadId, { limit: 10 })
    assert(messages.messages.length === 7, 'listCommunicationThreadMessages missing recorded messages')
    const firstMessagePage = await store.listCommunicationThreadMessages(threadId, { limit: 2 })
    const secondMessagePage = await store.listCommunicationThreadMessages(threadId, {
      cursor: firstMessagePage.nextCursor,
      limit: 10,
    })
    const firstPageMessageIds = new Set(
      firstMessagePage.messages.map((firstMessage) => firstMessage.messageId),
    )
    assert(
      firstMessagePage.messages.length === 2 &&
        firstMessagePage.nextCursor === firstMessagePage.messages[1].messageId &&
        secondMessagePage.messages.every(
          (message) => !firstPageMessageIds.has(message.messageId),
        ),
      'listCommunicationThreadMessages cursor did not page after the returned cursor',
    )
    assert(
      messages.messages.some((message) => message.channel === 'sms' && message.proof?.message_id),
      'communication messages missing SMS proof',
    )
    assert(
      messages.messages.some(
        (message) => message.channel === 'email' && message.direction === 'outbound',
      ),
      'communication messages missing sent email source',
    )
    assert(
      messages.messages.some((message) => message.proof?.action === 'missed_call'),
      'communication messages missing missed inbound call action',
    )
    assert(
      messages.messages.some((message) => message.emotionScores?.calmness === 0.64),
      'communication messages missing provider emotion score map',
    )

    const memory = await store.readContactCommunicationMemory({ contactId: lead.id, limit: 3 })
    assert(memory.length === 1, 'readContactCommunicationMemory missing thread memory')
    assert(memory[0].recentMessages.length === 6, 'Contact Memory missing bounded recent messages')
    assert(
      memory[0].recentMessages.some((message) =>
        /providerIds only/.test(message.text || ''),
      ),
      'Contact Memory missing latest provider event message',
    )

    const rebuilt = await store.rebuildCommunicationThreadSummary(threadId)
    assert(rebuilt?.topics?.length === 1, 'rebuildCommunicationThreadSummary did not materialize a topic')

    const snapshot = await store.workspaceSnapshot()
    assert(snapshot.communicationThreads.length === 3, 'workspace missing communicationThreads')
    assert(snapshot.communicationMessages.length === 9, 'workspace missing communicationMessages')
    assert(snapshot.communicationTopics.length === 3, 'workspace missing communicationTopics')
    assert(snapshot.contactIdentityLinks.length >= 2, 'workspace missing contactIdentityLinks')
  } catch (error) {
    failures.push(`communication store round trip failed: ${error.message}`)
  } finally {
    if (previousDataDir === undefined) {
      delete process.env.SPEAK_WORKSPACE_DATA_DIR
    } else {
      process.env.SPEAK_WORKSPACE_DATA_DIR = previousDataDir
    }
    fs.rmSync(tempDataDir, { recursive: true, force: true })
  }
}

async function verifyCommunicationAutomationPolicy() {
  const automationEnvKeys = [
    'SPEAK_COMMUNICATION_AUTOMATION_POLICY',
    'SPEAK_SMS_AUTO_REPLY_BODY',
    'SPEAK_EMAIL_AUTO_REPLY_SUBJECT',
    'SPEAK_EMAIL_AUTO_REPLY_BODY',
    'SPEAK_INBOUND_CALL_AUTO_ANSWER',
  ]
  const previousEnv = new Map(automationEnvKeys.map((key) => [key, process.env[key]]))

  function clearAutomationEnv() {
    automationEnvKeys.forEach((key) => {
      delete process.env[key]
    })
  }

  function restoreAutomationEnv() {
    previousEnv.forEach((value, key) => {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    })
  }

  try {
    clearAutomationEnv()

    const lead = {
      firstName: 'Casey',
      name: 'Casey Morgan',
      company: 'Morgan Studio',
      context: {
        text: [
          'speak.sms.auto_reply.body = Hi {firstName}, we received your text and will follow up shortly.',
          'speak.email.auto_reply.subject = Re: {subject}',
          'speak.email.auto_reply.body = Hi {firstName}, thanks for the email.',
        ].join('\n'),
      },
    }
    const smsPolicy = resolveInboundAutomationPolicy({
      channel: 'sms',
      direction: 'inbound',
      lead,
    })
    assert(smsPolicy.enabled === true, 'explicit contact SMS policy did not enable fixed reply')
    assert(
      smsPolicy.body.includes('Hi Casey'),
      'explicit contact SMS policy did not render contact template',
    )
    assert(
      automationProof(smsPolicy).smsAutoResponse === 'fixed_reply',
      'SMS automation proof missing fixed-reply marker',
    )

    const emailPolicy = resolveInboundAutomationPolicy({
      channel: 'email',
      direction: 'inbound',
      lead,
      subject: 'Quote request',
    })
    assert(emailPolicy.enabled === true, 'explicit contact email policy did not enable fixed reply')
    assert(emailPolicy.subject === 'Re: Quote request', 'email policy did not render reply subject')
    assert(
      automationProof(emailPolicy).emailAutoReply === 'fixed_reply',
      'Email automation proof missing fixed-reply marker',
    )

    const profilePolicy = resolveInboundAutomationPolicy({
      channel: 'sms',
      direction: 'inbound',
      lead: {},
      profile: {
        context: {
          text: '{"speakAutomation":{"smsAutoReply":{"enabled":true,"body":"Agent-level fixed reply."}}}',
        },
      },
    })
    assert(profilePolicy.enabled === true, 'explicit agent SMS policy was not honored')
    assert(
      profilePolicy.source === 'agent_context',
      'agent SMS policy did not cite agent_context source',
    )

    const defaultSms = resolveInboundAutomationPolicy({ channel: 'sms', direction: 'inbound' })
    assert(defaultSms.enabled === false, 'default SMS policy must not auto-send')
    assert(
      automationProof(defaultSms).smsAutoResponse === 'none',
      'default SMS automation proof must be none',
    )

    const defaultEmail = resolveInboundAutomationPolicy({
      channel: 'email',
      direction: 'inbound',
    })
    assert(defaultEmail.enabled === false, 'default email policy must not auto-reply')
    assert(
      automationProof(defaultEmail).emailAutoReply === 'none',
      'default email automation proof must be none',
    )

    const defaultCall = resolveInboundAutomationPolicy({
      channel: 'call',
      direction: 'inbound',
    })
    assert(defaultCall.enabled === false, 'default inbound call auto-answer must remain off')
    assert(
      automationProof(defaultCall).inboundCallAutoAnswer === false,
      'default inbound call proof must remain off',
    )

    const vaguePolicy = resolveInboundAutomationPolicy({
      channel: 'sms',
      direction: 'inbound',
      lead: {
        context: {
          text: 'Please auto reply to texts when they come in.',
        },
      },
    })
    assert(vaguePolicy.enabled === false, 'vague natural-language SMS policy must not auto-send')
    assert(
      automationProof(vaguePolicy).smsAutoResponse === 'none',
      'vague natural-language SMS proof must remain none',
    )

    const outboundPolicy = resolveInboundAutomationPolicy({
      channel: 'email',
      direction: 'outbound',
      lead,
    })
    assert(outboundPolicy.enabled === false, 'outbound email events must not trigger auto-reply')
    assert(outboundPolicy.reason === 'not_inbound', 'outbound automation policy must cite not_inbound')

    const contactPrecedencePolicy = resolveInboundAutomationPolicy({
      channel: 'sms',
      direction: 'inbound',
      lead: {
        context: {
          text: 'speak.sms.auto_reply = none',
        },
      },
      profile: {
        context: {
          text: '{"speakAutomation":{"smsAutoReply":{"enabled":true,"body":"Agent fallback."}}}',
        },
      },
    })
    assert(
      contactPrecedencePolicy.enabled === false,
      'contact explicit none must override lower-priority agent SMS policy',
    )
    assert(
      contactPrecedencePolicy.source === 'contact_context',
      'contact explicit-none SMS policy must cite contact_context source',
    )

    const callPolicy = resolveInboundAutomationPolicy({
      channel: 'call',
      direction: 'inbound',
      lead: {
        context: {
          text: 'speak.inbound_call.auto_answer = true',
        },
      },
    })
    assert(callPolicy.enabled === true, 'explicit inbound call auto-answer policy did not enable answer_call')
    assert(callPolicy.action === 'answer_call', 'explicit inbound call policy did not resolve answer_call action')
    assert(
      automationProof(callPolicy).inboundCallAutoAnswer === true,
      'inbound call proof missing enabled auto-answer marker',
    )

    process.env.SPEAK_SMS_AUTO_REPLY_BODY = 'System fixed SMS for {firstName}.'
    const systemSmsPolicy = resolveInboundAutomationPolicy({
      channel: 'sms',
      direction: 'inbound',
      lead: { firstName: 'Riley' },
    })
    assert(systemSmsPolicy.enabled === true, 'system SMS auto-reply body did not enable fixed reply')
    assert(systemSmsPolicy.source === 'system_env', 'system SMS auto-reply must cite system_env')
    assert(
      systemSmsPolicy.body === 'System fixed SMS for Riley.',
      'system SMS auto-reply did not render template',
    )
    delete process.env.SPEAK_SMS_AUTO_REPLY_BODY

    process.env.SPEAK_EMAIL_AUTO_REPLY_SUBJECT = 'Re: {subject}'
    process.env.SPEAK_EMAIL_AUTO_REPLY_BODY = 'System fixed email for {firstName}.'
    const systemEmailPolicy = resolveInboundAutomationPolicy({
      channel: 'email',
      direction: 'inbound',
      lead: { firstName: 'Riley' },
      subject: 'Pricing',
    })
    assert(systemEmailPolicy.enabled === true, 'system email auto-reply body did not enable fixed reply')
    assert(systemEmailPolicy.source === 'system_env', 'system email auto-reply must cite system_env')
    assert(systemEmailPolicy.subject === 'Re: Pricing', 'system email subject did not render template')
    delete process.env.SPEAK_EMAIL_AUTO_REPLY_SUBJECT
    delete process.env.SPEAK_EMAIL_AUTO_REPLY_BODY

    process.env.SPEAK_COMMUNICATION_AUTOMATION_POLICY =
      '{"speakAutomation":{"smsAutoReply":{"enabled":true,"body":"JSON policy reply."}}}'
    const systemJsonPolicy = resolveInboundAutomationPolicy({
      channel: 'sms',
      direction: 'inbound',
    })
    assert(systemJsonPolicy.enabled === true, 'system JSON automation policy did not enable SMS reply')
    assert(systemJsonPolicy.body === 'JSON policy reply.', 'system JSON automation policy body mismatch')
    delete process.env.SPEAK_COMMUNICATION_AUTOMATION_POLICY

    process.env.SPEAK_INBOUND_CALL_AUTO_ANSWER = 'true'
    const systemCallPolicy = resolveInboundAutomationPolicy({
      channel: 'call',
      direction: 'inbound',
    })
    assert(systemCallPolicy.enabled === true, 'system inbound-call auto-answer env did not enable answer_call')
    assert(systemCallPolicy.source === 'system_env', 'system inbound-call policy must cite system_env')
    delete process.env.SPEAK_INBOUND_CALL_AUTO_ANSWER
  } finally {
    restoreAutomationEnv()
  }
}

async function verifyTelnyxWebhookSignature() {
  try {
    const telnyxSignature = await import(`../server/telnyx-webhook-signature.mjs?check=${Date.now()}`)
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const exportedPublicKey = publicKey.export({ format: 'der', type: 'spki' })
    const rawPublicKey = Buffer.from(exportedPublicKey).subarray(-32).toString('base64')
    const payload = Buffer.from(
      JSON.stringify({
        data: {
          event_type: 'message.received',
          id: 'telnyx-signature-check',
          payload: { id: 'message-signature-check' },
        },
      }),
    )
    const timestamp = String(Math.floor(Date.now() / 1000))
    const signature = sign(
      null,
      telnyxSignature.telnyxWebhookSignedPayload(timestamp, payload),
      privateKey,
    ).toString('base64')

    assert(
      telnyxSignature.verifyTelnyxWebhookSignature({
        payload,
        publicKeys: [rawPublicKey],
        signature,
        timestamp,
      }).ok === true,
      'Telnyx webhook signature verifier did not accept a valid Ed25519 signature',
    )
    assert(
      telnyxSignature.verifyTelnyxWebhookSignature({
        payload: Buffer.from('{"tampered":true}'),
        publicKeys: [rawPublicKey],
        signature,
        timestamp,
      }).ok === false,
      'Telnyx webhook signature verifier accepted a tampered payload',
    )
    assert(
      telnyxSignature.verifyTelnyxWebhookSignature({
        payload,
        publicKeys: [rawPublicKey],
        signature: '',
        timestamp,
      }).error === 'telnyx_webhook_signature_missing',
      'Telnyx webhook signature verifier must fail closed when signature headers are missing',
    )
  } catch (error) {
    failures.push(`Telnyx webhook signature verifier failed: ${error.message}`)
  }
}

async function verifyTelnyxWebhookNormalizer() {
  const tempDataDir = makeTempDir('check-telnyx-inbound-normalizer')
  const previousDataDir = process.env.SPEAK_WORKSPACE_DATA_DIR
  try {
    const telnyx = await import(`../server/telnyx-webhook-normalizer.mjs?check=${Date.now()}`)
    assert(
      telnyx.telnyxPayloadPhone([{ phone_number: '+13125550002', status: 'delivered' }]) ===
        '+13125550002',
      'Telnyx webhook normalizer must resolve official to[] recipient arrays',
    )
    assert(
      telnyx.telnyxPayloadPhone({ phone_number: '+18665550001' }) === '+18665550001',
      'Telnyx webhook normalizer must resolve from objects',
    )
    assert(
      telnyx.telnyxPayloadTimestamp({
        completed_at: '2024-01-15T21:32:14.148+00:00',
      }) === '2024-01-15T21:32:14.148+00:00',
      'Telnyx webhook normalizer must preserve message.finalized completed_at',
    )
    assert(
      telnyx.telnyxPayloadTimestamp({}, '2018-02-02T22:25:27.521992Z') ===
        '2018-02-02T22:25:27.521992Z',
      'Telnyx webhook normalizer must use top-level data.occurred_at fallback',
    )

    const inboundMissedCall = telnyx.buildTelnyxInboundCallCommunicationEvent({
      eventType: 'call.hangup',
      occurredAt: '2026-07-02T12:04:00.000Z',
      webhookEventId: 'telnyx-webhook-inbound-missed-check',
      payload: {
        call_control_id: 'call-inbound-native-normalizer-check',
        call_session_id: 'session-inbound-native-normalizer-check',
        call_direction: 'incoming',
        from: { phone_number: '+15551234567' },
        to: [{ phone_number: '+12025550141' }],
        hangup_cause: 'no_answer',
      },
    })
    assert(inboundMissedCall?.missed === true, 'Telnyx inbound missed call normalizer missed no_answer hangup')
    assert(
      inboundMissedCall?.communicationEvent?.event?.communication?.identity?.phone === '+15551234567',
      'Telnyx inbound call normalizer did not preserve caller identity phone',
    )
    assert(
      inboundMissedCall?.communicationEvent?.event?.communication?.providerIds?.toPhone === '+12025550141',
      'Telnyx inbound call normalizer did not preserve called Speak number',
    )
    assert(
      inboundMissedCall?.communicationEvent?.event?.communication?.proof?.action === 'missed_call',
      'Telnyx inbound call normalizer did not mark default missed-call proof',
    )

    process.env.SPEAK_WORKSPACE_DATA_DIR = tempDataDir
    const store = await import(`../server/workspace-store.mjs?telnyxCheck=${Date.now()}`)
    const lead = await store.createWorkspaceLead({
      id: 'lead-telnyx-inbound-native-check',
      name: 'Casey Contact',
      company: 'Casey Coffee',
      phone: '+15551234567',
    })
    const recorded = await store.recordCommunicationEvent({
      ...inboundMissedCall.communicationEvent,
      agent: {
        id: 'profile-telnyx-inbound-native-check',
        name: 'Telnyx Native Check Agent',
        voiceRuntimeProvider: 'inworld',
      },
      event: {
        ...inboundMissedCall.communicationEvent.event,
        communication: {
          ...inboundMissedCall.communicationEvent.event.communication,
          agentProfileId: 'profile-telnyx-inbound-native-check',
        },
      },
    })
    assert(
      recorded?.thread?.contactId === lead.id,
      'Telnyx inbound call source event did not reconcile to the verified contact thread',
    )
    assert(
      recorded?.thread?.agentProfileId === 'profile-telnyx-inbound-native-check',
      'Telnyx inbound call source event did not preserve agent profile context',
    )
    assert(
      recorded?.message?.providerIds?.fromPhone === '+15551234567' &&
        recorded?.message?.providerIds?.toPhone === '+12025550141',
      'Telnyx inbound call source event did not persist caller/called provider IDs',
    )
    assert(
      recorded?.message?.proof?.action === 'missed_call' &&
        recorded?.message?.proof?.webhook_event_id === 'telnyx-webhook-inbound-missed-check',
      'Telnyx inbound call source event did not persist webhook missed-call proof',
    )
  } catch (error) {
    failures.push(`Telnyx webhook normalizer failed: ${error.message}`)
  } finally {
    if (previousDataDir === undefined) {
      delete process.env.SPEAK_WORKSPACE_DATA_DIR
    } else {
      process.env.SPEAK_WORKSPACE_DATA_DIR = previousDataDir
    }
    fs.rmSync(tempDataDir, { recursive: true, force: true })
  }
}

async function verifyTelnyxWebhookIngressRoute() {
  const tempRoot = makeTempDir('check-telnyx-webhook-ingress-route')
  const tempDataDir = path.join(tempRoot, 'workspace-data')
  const previousDataDir = process.env.SPEAK_WORKSPACE_DATA_DIR
  const telnyxRequests = []
  let serverProcess = null
  let fakeTelnyxServer = null
  let pendingAutoReplyProviderResponse = null
  let serverStdout = ''
  let serverStderr = ''
  fs.mkdirSync(tempRoot, { recursive: true })

  try {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const exportedPublicKey = publicKey.export({ format: 'der', type: 'spki' })
    const rawPublicKey = Buffer.from(exportedPublicKey).subarray(-32).toString('base64')

    fakeTelnyxServer = http.createServer((request, response) => {
      let rawBody = ''
      request.setEncoding('utf8')
      request.on('data', (chunk) => {
        rawBody += chunk
      })
      request.on('end', () => {
        const event = {
          body: rawBody ? JSON.parse(rawBody) : {},
          headers: request.headers,
          method: request.method,
          url: request.url,
        }
        telnyxRequests.push(event)
        response.setHeader('content-type', 'application/json')
        if (request.method === 'POST' && request.url === '/messages') {
          const messageId = event.body?.text === 'Direct operator acceptance check.'
            ? 'sms-route-direct-send-check'
            : 'sms-route-auto-reply-check'
          const finish = () => response.end(JSON.stringify({
            data: {
              id: messageId,
              status: 'queued',
              to: [{ status: 'queued' }],
            },
          }))
          if (messageId === 'sms-route-auto-reply-check') {
            pendingAutoReplyProviderResponse = finish
          } else {
            finish()
          }
          return
        }
        if (
          request.method === 'GET' &&
          /^\/messages\/(sms-route-auto-reply-check|sms-route-direct-send-check)$/.test(request.url || '')
        ) {
          const messageId = String(request.url || '').split('/').at(-1)
          response.end(JSON.stringify({
            data: {
              id: messageId,
              status: 'delivered',
              to: [{ status: 'delivered' }],
            },
          }))
          return
        }
        if (
          request.method === 'POST' &&
          request.url === '/calls/call-route-inbound-auto-answer-check/actions/answer'
        ) {
          response.end(JSON.stringify({
            data: {
              call_control_id: 'call-route-inbound-auto-answer-check',
              call_session_id: 'session-route-inbound-auto-answer-check',
              status: 'accepted',
            },
          }))
          return
        }
        response.statusCode = 404
        response.end(JSON.stringify({ errors: [{ detail: 'unexpected fake Telnyx route' }] }))
      })
    })
    const fakeTelnyxPort = await freePort()
    await new Promise((resolve, reject) => {
      fakeTelnyxServer.once('error', reject)
      fakeTelnyxServer.listen(fakeTelnyxPort, '127.0.0.1', resolve)
    })
    const fakeTelnyxBaseUrl = `http://127.0.0.1:${fakeTelnyxPort}`
    const fakeGogWrapper = path.join(tempRoot, 'fake-gog')
    fs.writeFileSync(
      fakeGogWrapper,
      '#!/usr/bin/env sh\nprintf \'{"ok":true,"result":[],"fake":true}\\n\'\n',
    )
    fs.chmodSync(fakeGogWrapper, 0o755)

    process.env.SPEAK_WORKSPACE_DATA_DIR = tempDataDir
    const store = await import(`../server/workspace-store.mjs?telnyxRouteCheck=${Date.now()}`)
    const lead = await store.createWorkspaceLead({
      id: 'lead-telnyx-route-check',
      firstName: 'Casey',
      lastName: 'Contact',
      name: 'Casey Contact',
      company: 'Casey Coffee',
      phone: '+15551234567',
      context: {
        text: 'sms_auto_reply_body = Hi {firstName}, route SMS reply.',
      },
    })
    const autoAnswerLead = await store.createWorkspaceLead({
      id: 'lead-telnyx-auto-answer-route-check',
      firstName: 'Riley',
      lastName: 'Ring',
      name: 'Riley Ring',
      company: 'Riley Routing',
      phone: '+15557654321',
      context: {
        text: 'inbound_call_auto_answer = true',
      },
    })
    await store.upsertWorkspaceProfile({
      id: 'profile-telnyx-route-check',
      name: 'Telnyx Route Agent',
      config: {
        agentProfileId: 'profile-telnyx-route-check',
        agentProfileName: 'Telnyx Route Agent',
        voiceRuntimeProvider: 'hume',
      },
    })
    await store.setActiveWorkspaceProfile('profile-telnyx-route-check')

    const port = await freePort()
    const baseUrl = `http://127.0.0.1:${port}`
    serverProcess = spawn(process.execPath, ['server/index.mjs'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BASE_PATH: '',
        GOG_WRAPPER: fakeGogWrapper,
        PORT: String(port),
        PUBLIC_BASE_URL: baseUrl,
        HUME_API_KEY: 'hume-route-check-key',
        HUME_CONFIG_ID: 'hume-route-check-config',
        SPEAK_CALL_LOG_DIR: path.join(tempRoot, 'call-logs'),
        SPEAK_TELNYX_WEBHOOK_ALLOW_AUTOMATION: 'true',
        SPEAK_WORKSPACE_DATA_DIR: tempDataDir,
        BACKGROUND_DELIVERY_OUTBOX_PATH: path.join(
          tempDataDir,
          'background-delivery-outbox.json',
        ),
        TELNYX_API_BASE: fakeTelnyxBaseUrl,
        TELNYX_API_KEY: 'telnyx-route-check-key',
        TELNYX_CONNECTION_ID: 'telnyx-route-check-connection',
        TELNYX_FROM_NUMBER: '+12025550141',
        TELNYX_MESSAGING_PROFILE_ID: 'telnyx-route-check-profile',
        TELNYX_SMS_FINALIZATION_POLL_MS: '10',
        TELNYX_SMS_FINALIZATION_TIMEOUT_MS: '1000',
        TELNYX_SMS_NUMBER: '+12025550141',
        TELNYX_WEBHOOK_URL: `${baseUrl}/api/webhooks/telnyx`,
        TELNYX_WEBHOOK_PUBLIC_KEY: rawPublicKey,
        TELNYX_WEBHOOK_SIGNATURE_REQUIRED: 'true',
        TELNYX_WEBHOOK_SIGNATURE_TOLERANCE_SECONDS: '3600',
        VOICE_STREAM_URL: `${baseUrl.replace(/^http/, 'ws')}/media-stream`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    serverProcess.stdout?.on('data', (chunk) => {
      serverStdout += chunk.toString()
    })
    serverProcess.stderr?.on('data', (chunk) => {
      serverStderr += chunk.toString()
    })

    await waitForHealth(baseUrl, serverProcess)
    const telnyxSignature = await import(`../server/telnyx-webhook-signature.mjs?routeCheck=${Date.now()}`)
    const postSignedWebhook = async (body) => {
      const rawBody = JSON.stringify(body)
      const timestamp = String(Math.floor(Date.now() / 1000))
      const signature = sign(
        null,
        telnyxSignature.telnyxWebhookSignedPayload(timestamp, Buffer.from(rawBody)),
        privateKey,
      ).toString('base64')
      const response = await fetch(`${baseUrl}/api/webhooks/telnyx`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'telnyx-signature-ed25519': signature,
          'telnyx-timestamp': timestamp,
        },
        body: rawBody,
      })
      const payload = await response.json().catch(() => ({}))
      return { payload, response }
    }

    let inboundWebhookSettled = false
    const smsResultPromise = postSignedWebhook({
      data: {
        id: 'telnyx-webhook-route-sms-inbound-check',
        event_type: 'message.received',
        occurred_at: '2026-07-02T15:00:00.000Z',
        payload: {
          id: 'sms-route-inbound-check',
          direction: 'inbound',
          from: { phone_number: '+15551234567' },
          messaging_profile_id: 'telnyx-route-check-profile',
          received_at: '2026-07-02T15:00:00.000Z',
          record_type: 'message',
          text: 'Can you send that over?',
          to: [{ phone_number: '+12025550141' }],
        },
      },
    })
    void smsResultPromise.then(() => {
      inboundWebhookSettled = true
    })
    const providerRequestDeadline = Date.now() + 2_000
    while (!pendingAutoReplyProviderResponse && Date.now() < providerRequestDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
    const webhookReturnedBeforeProvider = inboundWebhookSettled
    pendingAutoReplyProviderResponse?.()
    pendingAutoReplyProviderResponse = null
    const smsResult = await smsResultPromise
    assert(
      smsResult.response.ok && smsResult.payload?.ok,
      `Signed Telnyx SMS webhook route did not accept the inbound event: ${JSON.stringify(smsResult.payload)}`,
    )
    assert(
      webhookReturnedBeforeProvider,
      'Signed Telnyx inbound SMS webhook waited for the automated provider reply instead of returning after durable inbound persistence',
    )

    const directSendResponse = await fetch(`${baseUrl}/api/communication-messages/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        body: 'Direct operator acceptance check.',
        channel: 'sms',
        contactId: lead.id,
        lead,
        phone: lead.phone,
      }),
    })
    const directSendPayload = await directSendResponse.json().catch(() => ({}))
    assert(
      directSendResponse.ok &&
        directSendPayload?.ok === true &&
        directSendPayload?.accepted === true &&
        directSendPayload?.provider_accepted === true &&
        directSendPayload?.sent === false &&
        directSendPayload?.pending === true &&
        directSendPayload?.status === 'provider_accepted' &&
        directSendPayload?.proof?.provider_status === 'queued' &&
        directSendPayload?.proof?.delivery_finalized === false,
      `Direct operator SMS response claimed more than provider acceptance: ${JSON.stringify(directSendPayload)}`,
    )

    const callResult = await postSignedWebhook({
      data: {
        id: 'telnyx-webhook-route-call-inbound-check',
        event_type: 'call.initiated',
        occurred_at: '2026-07-02T15:01:00.000Z',
        payload: {
          call_control_id: 'call-route-inbound-default-off-check',
          call_direction: 'incoming',
          call_session_id: 'session-route-inbound-default-off-check',
          from: { phone_number: '+15551234567' },
          state: 'ringing',
          to: { phone_number: '+12025550141' },
        },
      },
    })
    assert(
      callResult.response.ok && callResult.payload?.ok,
      `Signed Telnyx inbound-call webhook route did not accept the inbound event: ${JSON.stringify(callResult.payload)}`,
    )

    const autoAnswerResult = await postSignedWebhook({
      data: {
        id: 'telnyx-webhook-route-call-auto-answer-check',
        event_type: 'call.initiated',
        occurred_at: '2026-07-02T15:02:00.000Z',
        payload: {
          call_control_id: 'call-route-inbound-auto-answer-check',
          call_direction: 'incoming',
          call_session_id: 'session-route-inbound-auto-answer-check',
          from: { phone_number: '+15557654321' },
          state: 'ringing',
          to: { phone_number: '+12025550141' },
        },
      },
    })
    assert(
      autoAnswerResult.response.ok && autoAnswerResult.payload?.ok,
      `Signed Telnyx inbound-call webhook route did not accept the explicit auto-answer event: ${JSON.stringify(autoAnswerResult.payload)}`,
    )

    const finalizationDeadline = Date.now() + 2_000
    let workspace = null
    while (Date.now() < finalizationDeadline) {
      workspace = JSON.parse(
        fs.readFileSync(path.join(tempDataDir, 'workspace.json'), 'utf8'),
      )
      const autoReplyFinalized = workspace.communicationMessages.find(
        (message) => message.providerIds?.messageId === 'sms-route-auto-reply-check',
      )?.proof?.delivery_finalized
      const directSendFinalized = workspace.communicationMessages.find(
        (message) => message.providerIds?.messageId === 'sms-route-direct-send-check',
      )?.proof?.delivery_finalized
      if (autoReplyFinalized && directSendFinalized) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    workspace ||= JSON.parse(
      fs.readFileSync(path.join(tempDataDir, 'workspace.json'), 'utf8'),
    )
    const inboundSms = workspace.communicationMessages.find(
      (message) => message.providerIds?.messageId === 'sms-route-inbound-check',
    )
    const autoReplySms = workspace.communicationMessages.find(
      (message) => message.providerIds?.messageId === 'sms-route-auto-reply-check',
    )
    const directSendSms = workspace.communicationMessages.find(
      (message) => message.providerIds?.messageId === 'sms-route-direct-send-check',
    )
    const missedCall = workspace.communicationMessages.find(
      (message) => message.providerIds?.callControlId === 'call-route-inbound-default-off-check',
    )
    const autoAnswerCall = workspace.communicationMessages.find(
      (message) =>
        message.providerIds?.callControlId === 'call-route-inbound-auto-answer-check' &&
        message.direction === 'inbound',
    )
    const autoAnswerStarted = workspace.communicationMessages.find(
      (message) =>
        message.providerIds?.callControlId === 'call-route-inbound-auto-answer-check' &&
        message.proof?.automation?.action === 'auto_answer_started',
    )

    assert(
      inboundSms &&
        inboundSms.channel === 'sms' &&
        inboundSms.direction === 'inbound' &&
        inboundSms.contactId === lead.id &&
        inboundSms.agentProfileId === 'profile-telnyx-route-check' &&
        inboundSms.proof?.automation?.source === 'contact_context' &&
        inboundSms.proof?.automation?.smsAutoResponse === 'fixed_reply',
      'Signed Telnyx SMS webhook route did not persist inbound source proof from contact context',
    )
    assert(
      autoReplySms &&
        autoReplySms.channel === 'sms' &&
        autoReplySms.direction === 'outbound' &&
        autoReplySms.contactId === lead.id &&
        autoReplySms.threadId === inboundSms?.threadId &&
        autoReplySms.body === 'Hi Casey, route SMS reply.' &&
        autoReplySms.providerIds?.replyToMessageId === inboundSms?.messageId &&
        autoReplySms.providerIds?.toPhone === '+15551234567' &&
        autoReplySms.providerIds?.fromPhone === '+12025550141' &&
        autoReplySms.proof?.automation?.action === 'auto_reply_delivered' &&
        autoReplySms.proof?.provider_accepted === true &&
        autoReplySms.proof?.delivery_finalized === true &&
        autoReplySms.proof?.sent === true &&
        autoReplySms.proof?.automation?.originMessageId === inboundSms?.messageId,
      'Signed Telnyx SMS webhook route did not persist outbound auto-reply proof in the same thread',
    )
    assert(
      directSendSms?.proof?.status === 'delivered' &&
        directSendSms?.proof?.provider_status === 'delivered' &&
        directSendSms?.proof?.provider_accepted === true &&
        directSendSms?.proof?.delivery_finalized === true &&
        directSendSms?.proof?.sent === true,
      `Direct operator SMS finalization did not replace pending acceptance proof: ${JSON.stringify(directSendSms)}`,
    )
    assert(
      missedCall &&
        missedCall.channel === 'call' &&
        missedCall.direction === 'inbound' &&
        missedCall.contactId === lead.id &&
        missedCall.threadId === inboundSms?.threadId &&
        /^Missed inbound call/.test(missedCall.body || '') &&
        missedCall.proof?.action === 'missed_call' &&
        missedCall.proof?.automation?.inboundCallAutoAnswer === false &&
        missedCall.proof?.automation?.reason === 'default_off_no_explicit_context_policy',
      'Signed Telnyx inbound-call webhook route did not persist default-off missed-call proof in the contact thread',
    )
    assert(
      autoAnswerCall &&
        autoAnswerCall.channel === 'call' &&
        autoAnswerCall.direction === 'inbound' &&
        autoAnswerCall.contactId === autoAnswerLead.id &&
        autoAnswerCall.proof?.automation?.inboundCallAutoAnswer === true &&
        autoAnswerCall.proof?.automation?.source === 'contact_context',
      'Signed Telnyx inbound-call webhook route did not persist explicit auto-answer source proof in the contact thread',
    )
    assert(
      autoAnswerStarted &&
        autoAnswerStarted.channel === 'call' &&
        autoAnswerStarted.direction === 'system' &&
        autoAnswerStarted.threadId === autoAnswerCall?.threadId &&
        autoAnswerStarted.contactId === autoAnswerLead.id &&
        autoAnswerStarted.proof?.automation?.action === 'auto_answer_started' &&
        autoAnswerStarted.proof?.automation?.originMessageId === autoAnswerCall?.messageId,
      `Signed Telnyx inbound-call webhook route did not persist auto-answer start proof in the contact thread: ${JSON.stringify({
        autoAnswerCall,
        relatedMessages: workspace.communicationMessages.filter(
          (message) =>
            message.providerIds?.callControlId === 'call-route-inbound-auto-answer-check' ||
            message.providerIds?.automationSourceMessageId === autoAnswerCall?.messageId,
        ),
        telnyxRequests,
      })}`,
    )
    assert(
      workspace.communicationThreads.some(
        (thread) =>
          thread.threadId === inboundSms?.threadId &&
          thread.contactId === lead.id &&
          thread.agentProfileId === 'profile-telnyx-route-check' &&
          thread.channels.includes('sms') &&
          thread.channels.includes('call'),
      ),
      'Signed Telnyx webhook route did not reconcile SMS and inbound call into one contact activity thread',
    )
    assert(
      telnyxRequests.filter(
        (request) => request.method === 'POST' && request.url === '/messages',
      ).length === 2 &&
        telnyxRequests.some(
          (request) =>
            request.method === 'POST' &&
            request.url === '/messages' &&
            request.body?.from === '+12025550141' &&
            request.body?.to === '+15551234567' &&
            request.body?.text === 'Hi Casey, route SMS reply.' &&
            request.body?.messaging_profile_id === 'telnyx-route-check-profile',
        ),
      'Signed Telnyx webhook route did not send exactly one provider SMS auto-reply through Telnyx',
    )
    const answerRequests = telnyxRequests.filter(
      (request) =>
        request.method === 'POST' &&
        request.url === '/calls/call-route-inbound-auto-answer-check/actions/answer',
    )
    assert(
      answerRequests.length === 1 &&
        /^ws:\/\/127\.0\.0\.1:\d+\/media-stream$/.test(answerRequests[0]?.body?.stream_url || '') &&
        answerRequests[0]?.body?.stream_track === 'inbound_track' &&
        answerRequests[0]?.body?.stream_bidirectional_mode === 'rtp' &&
        answerRequests[0]?.body?.stream_bidirectional_target_legs === 'self' &&
        answerRequests[0]?.body?.webhook_url === `${baseUrl}/api/webhooks/telnyx` &&
        typeof answerRequests[0]?.body?.client_state === 'string' &&
        answerRequests[0]?.body?.client_state.length > 0,
      `Signed Telnyx webhook route did not answer explicit inbound calls with native bidirectional media settings: ${JSON.stringify({
        answerRequests,
        telnyxRequests,
      })}`,
    )
  } catch (error) {
    const stderr = serverStderr ? ` stderr=${serverStderr.slice(-800)}` : ''
    const stdout = serverStdout ? ` stdout=${serverStdout.slice(-400)}` : ''
    failures.push(`Telnyx webhook ingress route failed: ${error.message}${stderr}${stdout}`)
  } finally {
    if (serverProcess) {
      await stopProcess(serverProcess)
    }
    if (fakeTelnyxServer) {
      await closeHttpServer(fakeTelnyxServer)
    }
    if (previousDataDir === undefined) {
      delete process.env.SPEAK_WORKSPACE_DATA_DIR
    } else {
      process.env.SPEAK_WORKSPACE_DATA_DIR = previousDataDir
    }
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

async function verifyWorkspaceEmailSyncNormalizer() {
  const tempDataDir = makeTempDir('check-communication-thread-email-normalizer')
  const previousDataDir = process.env.SPEAK_WORKSPACE_DATA_DIR
  try {
    const sync = await import(`../server/workspace-email-sync.mjs?check=${Date.now()}`)
    const normalizer = await import(`../server/workspace-email-normalizer.mjs?check=${Date.now()}`)
    const payloads = sync.workspaceEmailPayloadsFromGogOutput(
      {
        result: [
          {
            id: 'gmail-message-inbound-check',
            threadId: 'gmail-thread-inbound-check',
            from: 'Casey Contact <casey@example.com>',
            to: 'Operator <operator@example.com>',
            subject: 'Quote',
            body: 'Can you send the quote?',
            labelIds: ['INBOX'],
            internalDate: '1782988800000',
          },
          {
            id: 'gmail-message-outbound-check',
            threadId: 'gmail-thread-inbound-check',
            from: 'Operator <operator@example.com>',
            to: [
              'Operator <operator@example.com>',
              'Casey Contact <casey@example.com>',
              'Jordan Contact <jordan@example.com>',
            ],
            cc: 'Ops <ops@example.com>',
            subject: 'Re: Quote',
            body: 'Here is the quote.',
            labelIds: ['SENT'],
            internalDate: '1782988860000',
          },
          {
            id: 'gmail-message-payload-check',
            threadId: 'gmail-thread-payload-check',
            payload: {
              headers: [
                { name: 'From', value: 'MIME Contact <mime@example.com>' },
                { name: 'To', value: 'Operator <operator@example.com>' },
                { name: 'Subject', value: 'MIME Body' },
              ],
              parts: [
                {
                  mimeType: 'text/html',
                  body: {
                    data: Buffer.from('<p>HTML fallback body.</p>').toString('base64url'),
                  },
                },
                {
                  mimeType: 'text/plain',
                  body: {
                    data: Buffer.from('Plain Gmail payload body.').toString('base64url'),
                  },
                },
              ],
            },
            labelIds: ['INBOX'],
            internalDate: '1782988920000',
          },
          {
            id: 'gmail-message-unresolved-outbound-check',
            threadId: 'gmail-thread-unresolved-outbound-check',
            from: 'Operator <operator@example.com>',
            subject: 'Provider report with missing recipient',
            body: 'Provider returned no external recipient, but the source should still be visible.',
            labelIds: ['SENT'],
            internalDate: '1782988950000',
          },
          {
            id: 'gmail-message-wrong-mailbox-check',
            threadId: 'gmail-thread-wrong-mailbox-check',
            from: 'Different Sender <sender@example.com>',
            to: 'Other Mailbox <mailbox@example.com>',
            subject: 'Should not enter Speak',
            body: 'This belongs to the auth account, not the workspace mailbox.',
            labelIds: ['INBOX'],
            internalDate: '1782988980000',
          },
        ],
      },
      { account: 'operator@example.com' },
    )
    assert(payloads.length === 4, 'Workspace email sync normalizer missed GOG messages or accepted non-mailbox mail')
    assert(
      payloads[0].direction === 'inbound' &&
        payloads[0].fromEmail === 'casey@example.com' &&
        payloads[0].toEmail === 'operator@example.com',
      'Workspace email sync normalizer did not classify inbound mail',
    )
    assert(
      payloads[1].direction === 'outbound' &&
        payloads[1].fromEmail === 'operator@example.com' &&
        payloads[1].toEmail === 'casey@example.com' &&
        payloads[1].toEmails.includes('jordan@example.com') &&
        payloads[1].ccEmails.includes('ops@example.com'),
      'Workspace email sync normalizer did not classify outbound sent mail',
    )
    assert(
      payloads[2].direction === 'inbound' &&
        payloads[2].fromEmail === 'mime@example.com' &&
        payloads[2].subject === 'MIME Body' &&
        payloads[2].body === 'Plain Gmail payload body.',
      'Workspace email sync normalizer did not decode Gmail MIME payload bodies',
    )
    assert(
      payloads[3].direction === 'outbound' &&
        payloads[3].fromEmail === 'operator@example.com' &&
        !payloads[3].toEmail &&
        payloads[3].threadId === 'gmail-thread-unresolved-outbound-check',
      'Workspace email sync normalizer did not retain outbound source mail with unresolved recipients',
    )

    const inboundSource = normalizer.buildWorkspaceEmailCommunicationEvent(payloads[0], {
      allowAutomation: false,
      source: 'workspace_email_sync',
    })
    const sentSource = normalizer.buildWorkspaceEmailCommunicationEvent(payloads[1], {
      allowAutomation: false,
      source: 'workspace_email_sync',
    })
    const unresolvedSentSource = normalizer.buildWorkspaceEmailCommunicationEvent(payloads[3], {
      allowAutomation: false,
      source: 'workspace_email_sync',
    })
    assert(
      inboundSource?.communicationEvent?.event?.communication?.direction === 'inbound' &&
        inboundSource?.communicationEvent?.event?.communication?.identity?.email ===
          'casey@example.com' &&
        inboundSource?.communicationEvent?.event?.communication?.proof?.automation?.reason ===
          'workspace_email_sync_record_only',
      'Workspace email source normalizer did not build record-only inbound email source event',
    )
    assert(
      sentSource?.communicationEvent?.event?.communication?.direction === 'outbound' &&
        sentSource?.communicationEvent?.event?.communication?.identity?.email ===
          'casey@example.com' &&
        sentSource?.communicationEvent?.event?.communication?.providerIds?.toEmails?.includes(
          'jordan@example.com',
        ) &&
        sentSource?.communicationEvent?.event?.communication?.proof?.automation?.reason ===
          'sent_source_record_only',
      'Workspace email source normalizer did not build sent email source event with participant arrays',
    )
    assert(
      unresolvedSentSource?.communicationEvent?.event?.communication?.direction === 'outbound' &&
        !unresolvedSentSource?.communicationEvent?.event?.communication?.identity?.email &&
        unresolvedSentSource?.communicationEvent?.event?.communication?.identity?.externalThreadId ===
          'gmail-thread-unresolved-outbound-check' &&
        unresolvedSentSource?.communicationEvent?.event?.communication?.providerIds?.fromEmails?.includes(
          'operator@example.com',
        ) &&
        unresolvedSentSource?.communicationEvent?.event?.communication?.proof?.automation?.reason ===
          'sent_source_record_only',
      'Workspace email source normalizer did not keep unresolved sent email source proof',
    )

    process.env.SPEAK_WORKSPACE_DATA_DIR = tempDataDir
    const store = await import(`../server/workspace-store.mjs?emailCheck=${Date.now()}`)
    const lead = await store.createWorkspaceLead({
      id: 'lead-workspace-email-normalizer-check',
      name: 'Casey Contact',
      company: 'Casey Coffee',
      email: 'casey@example.com',
    })
    const recordedInbound = await store.recordCommunicationEvent(inboundSource.communicationEvent)
    const recordedSent = await store.recordCommunicationEvent(sentSource.communicationEvent)
    const recordedUnresolvedSent = await store.recordCommunicationEvent(
      unresolvedSentSource.communicationEvent,
    )
    assert(
      recordedInbound?.thread?.contactId === lead.id,
      'Workspace inbound email source did not reconcile to the verified contact thread',
    )
    assert(
      recordedSent?.thread?.contactId === lead.id &&
        recordedSent?.thread?.threadId === recordedInbound?.thread?.threadId,
      'Workspace sent email source did not reconcile to the existing contact thread',
    )
    assert(
      recordedUnresolvedSent?.thread?.status === 'unresolved_attribution' &&
        !recordedUnresolvedSent?.thread?.contactId &&
        recordedUnresolvedSent?.thread?.threadId ===
          'thread-unresolved-email-external-thread-gmail-thread-unresolved-outbound-check' &&
        recordedUnresolvedSent?.message?.providerIds?.emailThreadId ===
          'gmail-thread-unresolved-outbound-check',
      'Workspace sent email source without recipient did not create an unresolved-attribution thread',
    )
    assert(
      !recordedUnresolvedSent?.thread?.threadId?.includes('operator') &&
        !recordedUnresolvedSent?.thread?.threadId?.includes('split-llc'),
      'Workspace sent email source without recipient used the workspace mailbox as contact identity',
    )
    assert(
      recordedUnresolvedSent?.thread?.latestMessagePreview ===
        'Provider report with missing recipient' &&
        !recordedUnresolvedSent?.thread?.summary?.includes(
          'Provider returned no external recipient',
        ),
      'Workspace sent email source preview did not collapse unresolved email to subject-only',
    )
    const staleThreadId =
      'thread-unresolved-email-email-operator-example-com-external-thread-gmail-thread-stale-outbound-check'
    const repairedThreadId =
      'thread-unresolved-email-external-thread-gmail-thread-stale-outbound-check'
    await store.recordCommunicationEvent({
      event: {
        communication: {
          threadId: staleThreadId,
          channel: 'email',
          direction: 'outbound',
          role: 'agent',
          modality: 'text',
          provider: 'google_workspace',
          identity: {
            externalThreadId: 'gmail-thread-stale-outbound-check',
          },
          providerIds: {
            fromEmails: ['operator@example.com'],
            emailThreadId: 'gmail-thread-stale-outbound-check',
            messageId: 'gmail-message-stale-outbound-check',
          },
          body: 'Subject: Stale provider report\n\nProvider returned no external recipient.',
          proof: {
            automation: {
              allowed: false,
              reason: 'sent_source_record_only',
            },
          },
        },
      },
    })
    const repairDryRun = await store.repairWorkspaceEmailMailboxThreadIdentity({
      mailboxEmail: 'operator@example.com',
    })
    assert(
      repairDryRun?.repairableThreads === 1 &&
        repairDryRun?.movedMessages === 1 &&
        repairDryRun?.repairs?.[0]?.oldThreadIds?.includes(staleThreadId) &&
        repairDryRun?.repairs?.[0]?.newThreadId === repairedThreadId,
      'Workspace email thread identity repair dry-run did not find the stale mailbox-attributed thread',
    )
    const repairApplied = await store.repairWorkspaceEmailMailboxThreadIdentity({
      apply: true,
      mailboxEmail: 'operator@example.com',
    })
    const staleAfterRepair = await store.readCommunicationThread(staleThreadId)
    const repairedAfterRepair = await store.readCommunicationThread(repairedThreadId)
    const repairedMessages = await store.listCommunicationThreadMessages(repairedThreadId, {
      limit: 10,
    })
    assert(
      repairApplied?.ok &&
        repairApplied?.applied === 1 &&
        !staleAfterRepair &&
        repairedAfterRepair?.thread?.threadId === repairedThreadId &&
        repairedMessages.messages.some(
          (message) =>
            message.providerIds?.messageId === 'gmail-message-stale-outbound-check' &&
            message.threadId === repairedThreadId,
        ),
      'Workspace email thread identity repair did not move stale mailbox-attributed thread messages',
    )
    await store.recordCommunicationEvent({
      event: {
        communication: {
          threadId: repairedThreadId,
          channel: 'email',
          direction: 'outbound',
          role: 'agent',
          modality: 'text',
          provider: 'google_workspace',
          identity: {
            externalThreadId: 'gmail-thread-stale-outbound-check',
          },
          providerIds: {
            fromEmails: ['operator@example.com'],
            emailThreadId: 'gmail-thread-stale-outbound-check',
            sourceEventId: 'gmail-message-stale-outbound-check',
            messageId: 'gmail-message-stale-outbound-check',
          },
          body: 'Subject: Stale provider report\n\nProvider returned no external recipient.',
          proof: {
            automation: {
              allowed: false,
              reason: 'sent_source_record_only',
            },
          },
        },
      },
    })
    const sourceDedupeMessages = await store.listCommunicationThreadMessages(repairedThreadId, {
      limit: 10,
    })
    assert(
      sourceDedupeMessages.messages.filter(
        (message) => message.providerIds?.messageId === 'gmail-message-stale-outbound-check',
      ).length === 1,
      'Communication source upsert did not dedupe stale and canonical provider message IDs',
    )
    const workspaceFile = `${tempDataDir}/workspace.json`
    const sourceDedupeWorkspace = JSON.parse(fs.readFileSync(workspaceFile, 'utf8'))
    const sourceMessage = sourceDedupeWorkspace.communicationMessages.find(
      (message) => message.providerIds?.messageId === 'gmail-message-stale-outbound-check',
    )
    assert(sourceMessage, 'Communication source dedup check could not find source message fixture')
    sourceDedupeWorkspace.communicationMessages.push({
      ...sourceMessage,
      messageId: 'message-duplicate-provider-source-check',
    })
    fs.writeFileSync(workspaceFile, `${JSON.stringify(sourceDedupeWorkspace, null, 2)}\n`)
    const sourceDedupDryRun = await store.repairDuplicateCommunicationSourceMessages()
    assert(
      sourceDedupDryRun?.duplicateGroups === 1 &&
        sourceDedupDryRun?.removedMessages === 1 &&
        sourceDedupDryRun?.repairs?.[0]?.removedMessageIds?.includes(
          'message-duplicate-provider-source-check',
        ),
      'Communication source dedup repair dry-run did not detect duplicate provider source messages',
    )
    const sourceDedupApplied = await store.repairDuplicateCommunicationSourceMessages({ apply: true })
    const sourceDedupAfterApply = await store.repairDuplicateCommunicationSourceMessages()
    const repairedSourceMessages = await store.listCommunicationThreadMessages(repairedThreadId, {
      limit: 10,
    })
    assert(
      sourceDedupApplied?.ok &&
        sourceDedupApplied?.applied === 1 &&
        sourceDedupAfterApply?.duplicateGroups === 0 &&
        repairedSourceMessages.messages.filter(
          (message) => message.providerIds?.messageId === 'gmail-message-stale-outbound-check',
        ).length === 1,
      'Communication source dedup repair did not remove duplicate provider source messages',
    )
    const messages = await store.listCommunicationThreadMessages(recordedInbound.thread.threadId, {
      limit: 10,
    })
    assert(
      messages.messages.length === 2 &&
        messages.messages.some(
          (message) =>
            message.channel === 'email' &&
            message.direction === 'inbound' &&
            message.providerIds?.fromEmail === 'casey@example.com',
        ) &&
        messages.messages.some(
          (message) =>
            message.channel === 'email' &&
            message.direction === 'outbound' &&
            message.providerIds?.toEmails?.includes('jordan@example.com'),
        ),
      'Workspace email source messages did not persist inbound and sent participant proof',
    )
  } catch (error) {
    failures.push(`Workspace email sync normalizer failed: ${error.message}`)
  } finally {
    if (previousDataDir === undefined) {
      delete process.env.SPEAK_WORKSPACE_DATA_DIR
    } else {
      process.env.SPEAK_WORKSPACE_DATA_DIR = previousDataDir
    }
    fs.rmSync(tempDataDir, { recursive: true, force: true })
  }
}

async function verifyWorkspaceEmailSyncRoute() {
  const tempRoot = makeTempDir('check-communication-thread-email-route')
  const tempDataDir = path.join(tempRoot, 'workspace-data')
  const fakeWrapper = path.join(tempRoot, 'fake-gog-wrapper.cjs')
  const wrapperLog = path.join(tempRoot, 'fake-gog-wrapper-log.jsonl')
  const previousDataDir = process.env.SPEAK_WORKSPACE_DATA_DIR
  let serverProcess = null
  fs.mkdirSync(tempRoot, { recursive: true })

  try {
    fs.writeFileSync(fakeWrapper, fakeGogWrapperSource(), { mode: 0o755 })
    fs.chmodSync(fakeWrapper, 0o755)

    process.env.SPEAK_WORKSPACE_DATA_DIR = tempDataDir
    const store = await import(`../server/workspace-store.mjs?emailRouteCheck=${Date.now()}`)
    const lead = await store.createWorkspaceLead({
      id: 'lead-workspace-email-route-check',
      firstName: 'Casey',
      lastName: 'Contact',
      name: 'Casey Contact',
      company: 'Casey Coffee',
      email: 'casey@example.com',
      context: {
        text: [
          'email_auto_reply_subject = Re: {subject}',
          'email_auto_reply_body = Hi {firstName}, route reply.',
        ].join('\n'),
      },
    })

    const port = await freePort()
    const baseUrl = `http://127.0.0.1:${port}`
    const internalToken = 'email-route-check-token'
    serverProcess = spawn(process.execPath, ['server/index.mjs'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BASE_PATH: '',
        GOG_FAKE_LOG: wrapperLog,
        GOG_WRAPPER: fakeWrapper,
        PORT: String(port),
        PUBLIC_BASE_URL: baseUrl,
        SPEAK_CALL_LOG_DIR: path.join(tempRoot, 'call-logs'),
        SPEAK_INTERNAL_EVENT_TOKEN: internalToken,
        SPEAK_WORKSPACE_DATA_DIR: tempDataDir,
        BACKGROUND_DELIVERY_OUTBOX_PATH: path.join(
          tempDataDir,
          'background-delivery-outbox.json',
        ),
        WORKSPACE_EMAIL_ACCOUNT: 'operator@example.com',
        WORKSPACE_EMAIL_GOG_ACCOUNT_READS_MAILBOX: '',
        WORKSPACE_EMAIL_READ_GOG_ACCOUNT: 'operator@example.com',
        WORKSPACE_EMAIL_SEND_GOG_ACCOUNT: 'operator@example.com',
        WORKSPACE_EMAIL_SYNC_LIMIT: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    serverProcess.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    serverProcess.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    await waitForHealth(baseUrl, serverProcess)
    await waitForWorkspaceEmailSourceReadiness(baseUrl, serverProcess)
    const blockedResponse = await fetch(`${baseUrl}/api/workspace-email/sync`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-speak-internal-token': internalToken,
      },
      body: JSON.stringify({
        account: 'operator@example.com',
        authAccount: 'broker@example.com',
        allowAutomation: false,
        limit: 1,
      }),
    })
    const blockedPayload = await blockedResponse.json().catch(() => ({}))
    assert(
      blockedResponse.status === 503 &&
        blockedPayload?.error === 'workspace_email_source_read_not_ready' &&
        blockedPayload?.delivery?.emailSourceReadConfigured === false,
      `Workspace email sync route did not fail closed when read auth differs without delegated mailbox proof: ${JSON.stringify(blockedPayload)}`,
    )

    const response = await fetch(`${baseUrl}/api/workspace-email/sync`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-speak-internal-token': internalToken,
      },
      body: JSON.stringify({
        account: 'operator@example.com',
        authAccount: 'operator@example.com',
        allowAutomation: true,
        limit: 1,
      }),
    })
    const payload = await response.json().catch(() => ({}))
    assert(
      response.ok &&
        payload?.ok &&
        payload?.scanned === 1 &&
        payload?.recorded === 1 &&
        payload?.records?.[0]?.contactId === lead.id &&
        payload?.records?.[0]?.automation?.emailAutoReply === 'fixed_reply',
      `Workspace email sync route did not record trusted inbound mail with fixed auto-reply policy: ${JSON.stringify(payload)}`,
    )

    const workspace = JSON.parse(
      fs.readFileSync(path.join(tempDataDir, 'workspace.json'), 'utf8'),
    )
    const inboundMessage = workspace.communicationMessages.find(
      (message) => message.providerIds?.messageId === 'gmail-message-route-inbound-check',
    )
    const replyMessage = workspace.communicationMessages.find(
      (message) => message.providerIds?.messageId === 'gmail-message-route-auto-reply-check',
    )
    assert(
      inboundMessage &&
        inboundMessage.channel === 'email' &&
        inboundMessage.direction === 'inbound' &&
        inboundMessage.contactId === lead.id &&
        inboundMessage.proof?.automation?.source === 'contact_context' &&
        inboundMessage.proof?.automation?.emailAutoReply === 'fixed_reply',
      'Workspace email sync route did not persist inbound email source proof from contact context',
    )
    assert(
      replyMessage &&
        replyMessage.channel === 'email' &&
        replyMessage.direction === 'outbound' &&
        replyMessage.contactId === lead.id &&
        replyMessage.threadId === inboundMessage.threadId &&
        replyMessage.providerIds?.replyToMessageId === inboundMessage.messageId &&
        replyMessage.providerIds?.toEmail === 'casey@example.com' &&
        replyMessage.providerIds?.fromEmail === 'operator@example.com' &&
        replyMessage.proof?.automation?.action === 'auto_reply_sent' &&
        replyMessage.proof?.automation?.originMessageId === inboundMessage.messageId,
      'Workspace email sync route did not persist outbound email auto-reply proof in the same thread',
    )
    assert(
      /Subject: Re: Route quote/.test(replyMessage?.body || '') &&
        /Hi Casey, route reply\./.test(replyMessage?.body || ''),
      'Workspace email sync route did not render contact-context email reply templates',
    )
    const wrapperEvents = fs.existsSync(wrapperLog)
      ? fs.readFileSync(wrapperLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
      : []
    assert(
      wrapperEvents.some((event) => event.command === 'search') &&
        wrapperEvents.some(
          (event) =>
            event.command === 'send' &&
            event.to === 'casey@example.com' &&
            event.from === 'operator@example.com' &&
            event.subject === 'Re: Route quote' &&
            event.body === 'Hi Casey, route reply.',
        ),
      'Workspace email sync route did not call Gmail search and send through the configured wrapper',
    )
  } catch (error) {
    failures.push(`Workspace email sync route failed: ${error.message}`)
  } finally {
    if (serverProcess) {
      await stopProcess(serverProcess)
    }
    if (previousDataDir === undefined) {
      delete process.env.SPEAK_WORKSPACE_DATA_DIR
    } else {
      process.env.SPEAK_WORKSPACE_DATA_DIR = previousDataDir
    }
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

function fakeGogWrapperSource() {
  return `#!/usr/bin/env node
const fs = require('fs')
const args = process.argv.slice(2)
const logPath = process.env.GOG_FAKE_LOG
function argAfter(flag) {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] || '' : ''
}
function log(event) {
  if (!logPath) return
  fs.appendFileSync(logPath, JSON.stringify(event) + '\\n')
}
if (args.includes('search')) {
  log({ command: 'search', account: argAfter('--account'), query: args[args.indexOf('search') + 1] || '' })
  console.log(JSON.stringify({
    result: [{
      id: 'gmail-message-route-inbound-check',
      threadId: 'gmail-thread-route-check',
      from: 'Casey Contact <casey@example.com>',
      to: 'Operator <operator@example.com>',
      subject: 'Route quote',
      body: 'Need route proof.',
      labelIds: ['INBOX'],
      internalDate: '1782989040000'
    }]
  }))
  process.exit(0)
}
if (args.includes('auth') && args.includes('list')) {
  console.log(JSON.stringify({
    accounts: [
      {
        email: 'operator@example.com',
        services: ['gmail'],
        scopes: ['https://www.googleapis.com/auth/gmail.modify']
      },
      {
        email: 'broker@example.com',
        services: ['gmail'],
        scopes: ['https://www.googleapis.com/auth/gmail.readonly']
      }
    ]
  }))
  process.exit(0)
}
if (args.includes('send')) {
  const event = {
    command: 'send',
    account: argAfter('--account'),
    to: argAfter('--to'),
    from: argAfter('--from'),
    subject: argAfter('--subject'),
    body: argAfter('--body')
  }
  log(event)
  console.log(JSON.stringify({
    result: {
      id: 'gmail-message-route-auto-reply-check',
      threadId: 'gmail-thread-route-check',
      ok: true
    }
  }))
  process.exit(0)
}
console.error('Unsupported fake GOG wrapper command: ' + args.join(' '))
process.exit(2)
`
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = address && typeof address === 'object' ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

async function waitForHealth(baseUrl, childProcess) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 10_000) {
    if (childProcess.exitCode !== null) {
      throw new Error(`server exited before health check with code ${childProcess.exitCode}`)
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return
    } catch {
      // Retry until the temporary server accepts connections.
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error('temporary server health check timed out')
}

async function waitForWorkspaceEmailSourceReadiness(baseUrl, childProcess) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 10_000) {
    if (childProcess.exitCode !== null) {
      throw new Error(
        `server exited before Workspace email readiness with code ${childProcess.exitCode}`,
      )
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      const payload = await response.json().catch(() => ({}))
      if (
        response.ok &&
        payload?.delivery?.emailReadAuthAccountConfigured === true &&
        payload?.delivery?.emailSourceReadConfigured === true
      ) {
        return
      }
    } catch {
      // The temporary server prewarms its fake Workspace auth cache asynchronously.
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('temporary Workspace email readiness check timed out')
}

async function stopProcess(childProcess) {
  if (!childProcess || childProcess.exitCode !== null) return
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      childProcess.kill('SIGKILL')
      resolve()
    }, 2_000)
    childProcess.once('exit', () => {
      clearTimeout(timeout)
      resolve()
    })
    childProcess.kill('SIGTERM')
  })
}

async function closeHttpServer(server) {
  if (!server?.listening) return
  await new Promise((resolve) => server.close(resolve))
}

function assert(condition, message) {
  if (!condition) failures.push(message)
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
