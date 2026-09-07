# Speak Communication Thread Model

This is the required data and interface contract for unifying every customer
conversation in Speak. The durable workspace now includes communication
threads, messages, topics, and contact identity links. New call, browser-test,
SMS, email, and tool-proof events are mirrored into this provider-neutral model
while the existing call/test history routes remain compatibility read surfaces.

## Objective

Speak must be able to render one contact-scoped conversation pane that mixes
call transcripts, SMS, email, browser tests, operator notes, tool proof,
recordings, and provider events without leaking context between contacts or
forking UI logic by channel.

The model has three jobs:

1. Preserve raw provider proof and call logs for audit.
2. Normalize communication into contact-owned threads and messages for UI,
   agents, search, memory, and future inbox workflows.
3. Keep channel/provider details as metadata, not as separate product models.

## Current State

- Calls and browser tests are appended to Speak-owned call logs at event time.
  Their call-channel thread/message records are accumulated in memory during
  active audio and committed as one ordered workspace batch on outcome/end, so
  large workspace serialization cannot interrupt realtime PCM. External
  SMS/email/tool proof remains immediate. A bounded SIGTERM/SIGINT drain flushes
  queued call logs and any pending communication batch before process exit.
- Outbound SMS, email, portal-link, contact-update, and caller-identity tools
  attach backend proof to normalized communication messages.
- Hume, Inworld, and xAI browser Playground sessions receive the same shared tool
  definitions as phone sessions. An explicit `productionContext=false`
  sandbox still exposes those tools for runtime-parity testing, but blocks SMS,
  email, and portal-link delivery with
  `configuration_test_delivery_disabled` before any provider call.
- Telnyx SMS inbox/outbox events, default-off missed inbound-call events, and
  trusted Workspace sent/received email intake are normalized into the same
  thread/message model. Exact phone/email/thread attribution attaches to a
  verified contact; ambiguous or unknown identities create
  unresolved-attribution threads.
- Production Telnyx source routing must pass
  `npm run qa:telnyx-source-routing` on the production host before SMS
  inbox/outbox or inbound-call source ingestion is considered end-to-end
  configured. Production must require Telnyx Ed25519 webhook signatures with
  at least one public signing key configured so unsigned, stale, or invalid
  SMS/call webhooks fail before source persistence.
- The same source-routing check must also run a local temp-workspace native
  payload dry run for inbound SMS, outbox SMS, missed inbound calls, and
  contact-thread reconciliation so account wiring cannot mask a broken
  provider-normalization path.
- `npm run qa:communication-threads` must also prove the trusted Workspace
  email sync route itself: a bounded Gmail search result reaches
  `/api/workspace-email/sync`, reconciles to the contact thread, and only sends
  an email auto-reply when explicit contact/agent/system context authorizes it.
- `npm run qa:communication-threads` must prove the signed Telnyx webhook route
  itself with a fake provider API: inbound SMS reaches `/api/webhooks/telnyx`,
  contact-context SMS auto-reply writes back to the same thread, and inbound
  calls remain default-off missed-call source records unless explicit policy
  authorizes auto-answer. When explicit auto-answer is authorized, the verifier
  must observe a native Telnyx `actions/answer` request with Speak's
  bidirectional media settings and matching thread proof.
- Telnyx webhook intake must preserve native event shape: `data.occurred_at`
  is the envelope timestamp fallback, `message.finalized` may use
  `completed_at`, and Messaging `to` recipients may arrive as arrays. The
  normalizer must keep those values in the provider-proof path before writing
  Speak-owned thread messages.
- Signed Telnyx webhook intake is still record-only for inbound automation by
  default. `SPEAK_TELNYX_WEBHOOK_ALLOW_AUTOMATION=true` is required before the
  webhook path may apply explicit contact, agent, or system SMS auto-reply or
  inbound-call auto-answer policy.
- Operator-confirmed replies and contact-field sends use
  `POST /api/communication-messages/send` when the backend sends through the
  Telnyx/Speak agent number or the workspace email account. The route returns
  provider proof and writes the outbound item back into the thread.
- Voice-agent `send_text_message`, `send_email`, and compatibility
  `send_portal_link` calls require a confirmed destination before queueing.
  `send_portal_link` requires separate phone and email confirmation when both
  channels are requested; one generic confirmation cannot authorize two
  destinations. `update_contact` requires `details_confirmed=true` before it
  can persist any corrected contact field.
  They return `processing` immediately so the Hume/Inworld/xAI conversation can
  continue while Speak-owned Telnyx/Workspace IO runs in the background. The
  delivered, failed, or accepted-unverified completion is written as the
  communication event and supplied to the still-active voice session; the
  processing acknowledgement is never delivery proof. For SMS, `queued`,
  `sending`, and `sent` mean only that Telnyx accepted the request. Speak
  correlates `message.finalized` by provider message ID, handles finalization
  that arrives before settlement, and uses bounded read-only status recovery
  after restart or a missed webhook. Only `delivered` permits a sent claim;
  a final provider rejection such as `40002` stays failed and is never retried
  automatically. Phone Playground and CallTools calls share this exact path.
- `GET /api/communication-threads`,
  `GET /api/communication-threads/{threadId}`,
  `GET /api/communication-threads/{threadId}/messages`, and
  `GET /api/contacts/{contactId}/communication-memory` are live read APIs.
- Contact Memory is stored on `lead.context`; Agent Knowledge Layer content is
  stored on `profile.context`. Runtime conversation memory is now read from
  communication thread/topic summaries first, with the old recent-call scan
  retained as a migration fallback for older call logs.
- Existing raw call history remains available through `read_recent_calls` and
  `read_browser_config_tests` for recording/audio compatibility and for
  pre-thread historical records that have not been backfilled. Use
  `npm run backfill:communication-threads` for a dry run and
  `npm run backfill:communication-threads:apply` for an idempotent backfill.
- Current production surfaces consume this protocol through implemented
  thread-aware views: Library Activity renders one row per contact or unresolved
  thread, filters by source type, sorts by latest activity/contact/agent/call
  time/turns/source, fetches messages on expansion, and honors `#thread=`
  links; expanded Library Contacts render the same contact-scoped source history
  instead of a call-only history list; Global Search indexes communication
  thread summaries; Dialer transcript history shows one selected-contact
  source-history pane for SMS/email/missed-call records while preserving call
  attempt transcripts; Playground saved tests carry thread status and summaries;
  MCP widgets and agent contracts expose communication-thread summaries and
  message reads as first-class proof surfaces.
- When Activity merges pre-thread recent-call turns with durable source-thread
  messages, dedupe only on native provider event, message, or source IDs. Do
  not collapse two same-channel SMS/email messages merely because they share a
  thread/channel and lack provider source IDs.

## Durable Objects

### `communicationThread`

One contact-scoped conversation timeline. A thread may contain multiple
channels when they are part of the same customer conversation.

Required fields:

| Field | Purpose |
| --- | --- |
| `threadId` | Stable Speak-owned ID. UI and agents should use this instead of provider IDs. |
| `contactId` | Canonical Speak contact/lead ID. Required unless attribution is unresolved. |
| `agentProfileId` | Optional saved profile tied to the conversation. |
| `status` | `open`, `waiting`, `resolved`, `archived`, or `unresolved_attribution`. |
| `channels` | Distinct channels present: `call`, `sms`, `email`, `browser_test`, `operator_chat`, `tool`, `system`. |
| `latestChannel` | The newest source channel for Activity row icon and ordered source label. `channels` remains the full filterable source set, and Activity renders the full channel set with `latestChannel` first. |
| `participants` | Contact, agent/profile, operator, and provider participants. |
| `topicIds` | Linked topic summaries. |
| `summary` | Compact contact-safe summary for search and runtime memory. |
| `latestMessagePreview` | Redacted/scannable preview for list rows. Email previews are subject-only; full email bodies remain on expanded message records. |
| `lastMessageId` | Message pointer for cursor-based retrieval. |
| `lastInboundAt` / `lastOutboundAt` | Inbox and SLA ordering. |
| `messageCount` | Materialized count of normalized messages for turn counts and sorting. |
| `emotionScoreTurns` / `hasEmotionScores` | Materialized provider score coverage for Activity filters and badges. |
| `identityConfidence` | `verified`, `probable`, or `unresolved`. |
| `providerLinks` | Provider IDs such as call control ID, Telnyx message ID, email thread ID, Hume chat ID, Inworld session ID, or CallTools call/contact/campaign/Web callback IDs. |
| `createdAt` / `updatedAt` | Server timestamps. |

### `communicationMessage`

One normalized event in a thread. Spoken transcript turns, SMS bodies, email
summaries, tool results, call status events, and recording links use the same
message envelope with different channel/modality metadata.

Required fields:

| Field | Purpose |
| --- | --- |
| `messageId` | Stable Speak-owned ID. |
| `threadId` | Parent communication thread. |
| `contactId` | Canonical contact ID when attributed. |
| `agentProfileId` | Saved profile used for the message when applicable. |
| `channel` | `call`, `sms`, `email`, `browser_test`, `operator_chat`, `tool`, or `system`. |
| `modality` | `voice`, `text`, `audio`, `tool`, `status`, or `attachment`. |
| `direction` | `inbound`, `outbound`, `internal`, or `system`. |
| `role` | `contact`, `agent`, `operator`, `tool`, or `system`. |
| `body` | Final user-visible text or compact status text. |
| `bodyStatus` | `partial`, `final`, `redacted`, or `not_applicable`. |
| `provider` | `speak`, `telnyx`, `calltools`, `hume`, `inworld`, `google_workspace`, or future provider ID. |
| `providerIds` | External IDs such as `callControlId`, `calltoolsCallId`, `calltoolsContactId`, `calltoolsCampaignId`, `calltoolsWebCallbackId`, `calltoolsWebCallbackRequestId`, `chatId`, `messageId`, `emailThreadId`. |
| `proof` | Backend proof for sends, contact updates, hangups, and provider acceptance. |
| `attachments` | Recording/audio/file metadata when present. |
| `emotionScores` | Hume score payload when the source turn actually provided scores. |
| `topicIds` | Topic labels produced from this message or turn. |
| `at` | Event timestamp. |

### `communicationTopic`

Small summaries for search, memory, and inbox triage. Topics must cite source
message IDs so runtime memory can retrieve full context without injecting whole
transcripts by default.

Required fields: `topicId`, `threadId`, `contactId`, `label`, `summary`,
`status`, `confidence`, `sourceMessageIds`, and `updatedAt`.

### `contactIdentityLink`

The attribution table that prevents cross-contact memory bleed. Use it before
attaching SMS, inbound calls, or email source events to a contact.

Required fields: `contactId`, `kind` (`phone`, `email`, `provider_contact`,
`external_thread`), `normalizedValue`, `source`, `confidence`, `verifiedAt`,
and optional `supersededBy`.

## API Surface

The REST/action surface exposes these routes while preserving current call
history routes during migration:

| Route | Purpose |
| --- | --- |
| `GET /api/communication-threads` | List thread summaries by `contactId`, `agentProfileId`, `channel`/`channels`, `status`, `updatedAfter`, and cursor. |
| `GET /api/communication-threads/{threadId}` | Read one thread summary and metadata. |
| `GET /api/communication-threads/{threadId}/messages` | Cursor-page messages for one thread. |
| `POST /api/communication-messages/send` | First-party UI route for operator-confirmed SMS/email send and reply actions. High-risk, proof-returning, and not generic MCP-callable. UI callers preflight `/api/health`, and the backend rejects unready SMS/email before provider IO. |
| `POST /api/communication-events` | Internal/provider normalizer for call/SMS/email/tool events. Not generic MCP-callable. Inbound SMS/email/call automation is record-only by default; a trusted ingester must set `allowAutomation: true` before explicit fixed-reply or inbound-call answer policy can run. |
| `POST /api/webhooks/telnyx` | Telnyx SMS and Call Control webhook ingress. Provider-only, signature-verified in production, and not generic MCP-callable. |
| `POST /api/communication-threads/{threadId}/summary/rebuild` | Recompute summaries/topics from messages. Operator or maintenance only. |
| `GET /api/contacts/{contactId}/communication-memory` | Compact prior-context block generated from thread summaries and selected messages. |
| `POST /api/webhooks/workspace-email` | Trusted sent/received Workspace/Gmail event normalizer. Internal-only. Inbound email is record-only unless the trusted ingester explicitly sends `allowAutomation: true` and an explicit fixed-reply policy is present. |
| `POST /api/workspace-email/sync` | Internal bounded Workspace/Gmail inbox/outbox sync. Fails closed unless source-read readiness is proven, uses the configured GOG wrapper/read auth account, and records messages into the same thread model while preserving `WORKSPACE_EMAIL_ACCOUNT` as the mailbox identity. |

MCP and agent adapters should prefer the read-only thread summary/message
actions. Provider webhooks and raw event ingestion remain non-callable generic
internals.

Trusted provider normalizers should put the durable contact address in
`event.communication.identity`: use `identity.phone` for SMS/call senders and
`identity.email` for email senders. Provider-specific `from*` / `to*` values
may also live in `providerIds` and `proof`, but neutral automation resolves the
reply or answer target from the event identity first so providers do not need to
duplicate native identity into Telnyx- or Gmail-shaped fields.

## Attribution Rules

- Exact verified phone/email identity attaches to the matching contact.
- If no identity link exists but exactly one workspace contact has the same
  normalized phone/email, that contact row becomes the verified identity source
  and the link is materialized during event intake.
- If a phone or email maps to multiple active contacts, create or surface an
  `unresolved_attribution` thread and require operator resolution before the
  content becomes runtime Contact Memory.
- Browser playground tests must be marked `environment: playground`; they may
  be linked to a contact for review but should not contaminate production
  Contact Memory unless explicitly promoted.
- Provider IDs are never the primary UI identity. They live in `providerLinks`
  and `providerIds`.
- CallTools Phone-as-Agent events must write CallTools call/contact/campaign/Web callback IDs
  as `calltools*` provider IDs and `providerLinks` with `provider=calltools`;
  they must not be relabeled as Telnyx call-control IDs. Speak thread IDs,
  contact identity links, and the shared transcript bubble renderer remain the
  source of truth for the UI. CallTools-backed transcript turns come from
  Speak-owned persisted call logs and local audio capture after the media
  gateway bridges WebRTC audio. Speak checks the CallTools historical
  `/calls/` record at call end and retries briefly in the background because
  CallTools recording metadata can arrive after the live gateway closes. When
  that record exposes `call_recording_fsfile_id`, Speak also stores the value as
  a `provider=calltools`, `kind=recording` provider link and a CallTools
  recording attachment on the same message. The native recording reference
  complements the local Speak WAV; it does not replace thread transcripts,
  Telnyx call-control IDs, or Hume Chat History reconstruction.
  CallTools recording-derived review is recording-first: use the `/calls/` recording
  reference and generate a recording-derived transcript from CallTools recording
  audio. The recording-derived transcript is recording-audio evidence and must be
  compared against Speak-owned call-log turns plus local
  `lead-calltools-input` / `ai-calltools-output` audibility evidence with
  `npm run audit:calltools-recording-transcript`. The audit keeps material Speak
  turns missing from the recording-derived transcript as warning-level review
  gaps, while short live-STT fragments corrected by the recording-derived
  transcript are reported as `LIVE_SPEAK_STT_CORRECTED_BY_PROVIDER_RECORDING`.
  Fresh CallTools calls can report
  recording evidence as pending inside
  `CALLTOOLS_RECORDING_LAG_GRACE_MS`; that state must not overwrite or weaken
  the Speak-owned transcript, local WAV proof, or communication thread.
  Production recording reconciliation also keeps retrying delayed CallTools
  `/calls/` recording metadata through the default
  `CALLTOOLS_RECORDING_RECONCILE_DELAYS_MS` one-hour window. When recording
  audio is already available, `npm run calltools:transcribe-recording` or the
  audit's `--transcribeRecording` mode can create the recording-derived transcript. If the
  historical row exposes `call_recording_fsfile_id`, `--transcribeRecording`
  downloads the CallTools recording audio through `/filesystemfiles/{id}/download/`
  before running Inworld STT. It must not overwrite the communication thread as
  the durable source of truth. It satisfies the recording-derived comparison
  gate only when it is generated from the CallTools recording reference.
  Use `npm run audit:calltools-recording-rhythm` when the provider timing
  itself is in question. That audit reads only CallTools metadata and keeps
  Speak's immediate transcript model independent from delayed provider
  recording artifacts.
- CallTools live-call metadata should be resolved from `LivePhoneCall` plus
  `ContactDetail` when available before a voice-runtime session starts. When a
  native campaign invite attaches through the registered SIP/WebRTC gateway, the Speak
  `callControlId`, gateway stream ID, CallTools call ID, and any resolved contact
  or campaign IDs should feed the same contact-scoped thread, Contact Memory,
  and provider-link path as SMS, email, and Telnyx call events.
- CallTools outcome reconciliation should map Speak outcomes to native
  CallTools call dispositions and log or create `HistoricalCallDisposition`
  proof. Default production behavior is proof-only unless
  `CALLTOOLS_SYNC_OUTCOMES=true` explicitly enables writeback.
- Deleting or merging contacts must update identity links and preserve an audit
  trail so old messages do not reattach to a different contact by name alone.

## UI And Widget Rules

- A single contact conversation pane should be able to render all messages
  across calls, SMS, email, and tests with transcript-style participant labels
  and compact proof metadata. Library Activity is contact-thread-first: one
  contact should render as one Activity row unless attribution is unresolved,
  and expanding that row starts with the most recent source messages before
  older history. Expanded Activity rows and any linked source-history readback
  must show the fetched cross-channel message/turn list rather than a
  summary-only, role-labeled, or agent-only subset.
- Channel filters are view controls, not separate data stores.
- Source-filtered Activity rows must still look like unified contact threads:
  if a thread contains SMS and the latest event is a call, the row remains in
  the SMS filter but the visible source label must read as the full ordered
  channel set instead of a misleading latest-only value.
- Transcript rows, SMS bubbles, and email snippets should share message
  geometry, participant labels, fixed sender colors, copy/collapse actions,
  optional provider enrichments such as Hume emotion-score strips, and
  modality-specific actions such as playback, reply, resend, or open source.
  Sent/outbound agent and operator turns use the dark bubble in every
  appearance mode. Received/contact turns use the readback bubble, except
  contact/user-side SMS which is always iMessage blue in every appearance.
  Sent/outbound SMS stays on the fixed sent/dark treatment. Email messages use
  the fixed Speak purple treatment in every appearance, show only the subject
  in list previews and collapsed bubbles, and then reveal the full body only
  when expanded. Received SMS/email messages expose reply. SMS reply must offer
  both current-device handoff and backend delivery from the Telnyx/Speak agent
  number. Providers that do not emit a given enrichment should not show
  missing-value UI.
- Library Activity pulls from contact-scoped thread summaries first and fetches
  messages only when the operator opens a contact/thread. Raw recent-call
  records remain a compatibility source for recordings, call-time totals, and
  pre-thread audit readback. When a communication thread links to pre-thread
  call/test records, Activity must merge those raw transcript turns into the
  expanded contact thread so older contact/user turns are not dropped by stale
  materialized thread rows. The same source-history fallback is required for
  Dialer and Playground linked source history so stale backfilled `system`
  rows are deduped away before rendering.
- Generative UI widgets should receive compact thread summaries in
  `structuredContent` and keep full message bodies in `_meta` or fetch-on-open
  payloads to avoid bloated model-visible state.

## Automation Policy

- Auto-response and inbound-call auto-answer are default-none/default-off.
- Webhook and internal provider intake may record the resolved policy in proof
  metadata, but they must not autonomously send SMS/email replies or answer
  inbound calls unless an explicit server-owned policy authorizes that action.
  The neutral `/api/communication-events` route is record-only unless the
  trusted ingester sets `allowAutomation: true`. The direct Telnyx webhook
  route is also record-only unless `SPEAK_TELNYX_WEBHOOK_ALLOW_AUTOMATION=true`
  is set on the backend.
- Contact context is checked first, then agent/profile context, then system
  environment policy. Automation runs only for contact-attributed inbound
  messages; unresolved-attribution threads block auto-send even when a global
  policy exists.
- Agent/profile context and contact context can inform policy resolution only
  through explicit directives. Vague natural-language prompt text is not
  sufficient proof to send a message or answer a call.
- Supported fixed-reply directives may be stored as line-based text:

```text
speak.sms.auto_reply.body = Hi {firstName}, we received your text and will follow up shortly.
speak.email.auto_reply.subject = Re: {subject}
speak.email.auto_reply.body = Hi {firstName}, thanks for the email.
speak.inbound_call.auto_answer = off
```

  Or as JSON in context text:

```json
{
  "speakAutomation": {
    "smsAutoReply": { "enabled": true, "body": "Hi {firstName}, we received your text." },
    "emailAutoReply": { "enabled": true, "subject": "Re: {subject}", "body": "Thanks for the email." },
    "inboundCallAutoAnswer": { "enabled": false }
  }
}
```

- SMS and email directives send fixed replies only and write the outbound proof
  back into the same communication thread. Inbound call auto-answer remains
  default-off unless explicit contact, agent, or system policy enables it; when
  enabled, Telnyx answers the inbound Call Control leg with the same
  bidirectional media stream used by Speak voice sessions and records both the
  inbound source policy proof and an `auto_answer_started` system proof message.
- Telnyx inbound-call source events must be normalized from native webhook
  fields such as `call_direction`, `from`, `to`, `call_control_id`,
  `call_session_id`, top-level `occurred_at`, and webhook event id. The
  production verifier must prove that the native payload produces a
  default-off missed-call record, caller/called provider IDs, agent profile
  context, and verified contact-thread reconciliation.
- Workspace email sync is record-only by default so historical backfills do not
  accidentally send replies. Use `npm run sync:workspace-email` for a dry run
  and `npm run sync:workspace-email:apply` to write bounded Gmail results into
  communication threads. Add `--allow-automation` only for a live trusted sync
  runner where explicit inbound email policies should be honored. When GOG read
  auth uses a broker or delegated identity, set `WORKSPACE_EMAIL_READ_GOG_ACCOUNT`
  or pass `--read-auth-account`; message direction and visible sender still use
  `WORKSPACE_EMAIL_ACCOUNT`. The sync normalizer must reject messages that do
  not include `WORKSPACE_EMAIL_ACCOUNT` in the normalized participant arrays, so
  an auth/broker mailbox cannot write unrelated mail into Speak's visible
  workspace identity. Health and `npm run qa:workspace-email` must keep Gmail
  read/source readiness separate from send/send-as readiness so inbound source
  intake can be audited without weakening reply-send proof.
  `npm run qa:workspace-email-source` must also pass before applying source
  sync; it performs a bounded Gmail read and requires a normalized mailbox
  participant sample without printing subject or body content. The default sync
  query is participant-scoped to `WORKSPACE_EMAIL_ACCOUNT` so a broker mailbox
  does not scan unrelated mail before normalization. The same source probe must
  also run a temp-workspace native email dry run for inbound email, sent email,
  and contact-thread reconciliation so mailbox-read visibility cannot mask a
  broken source-normalization path. When the auth
  account differs from the visible mailbox, full reply readiness requires
  `WORKSPACE_EMAIL_SEND_GOG_ACCOUNT` to have an accepted send-as alias and Gmail
  settings scope to manage that alias if it is missing. Source-read readiness
  for a different auth account must also prove
  delegated, routed, or brokered read access to the visible mailbox; Gmail read
  scope on the auth account alone is not enough. The production recovery path
  for missing Gmail settings scope is `npm run repair:workspace-email-sendas:auth-url`,
  followed by Google consent and
  `npm run repair:workspace-email-sendas:auth-complete -- --auth-url '<redirected-localhost-url>'`;
  the completion command applies the send-as repair and reruns
  `qa:workspace-email`.
- If older Workspace-email source records produced unresolved thread IDs that
  include the visible mailbox as the contact identity, run
  `npm run repair:workspace-email-thread-identity` first. It dry-runs the exact
  unresolved mailbox-attributed email threads that would move to
  external-thread-only IDs. Apply with
  `npm run repair:workspace-email-thread-identity:apply` only after reviewing
  the dry-run list; the repair moves messages/topics without treating
  `WORKSPACE_EMAIL_ACCOUNT` as a customer identity.
- Communication source ingestion is idempotent by native provider event, not
  only by Speak's generated message id. When a prior attribution repair or
  provider normalizer change leaves duplicate rows for the same source event,
  run `npm run repair:communication-source-dedup` first and apply with
  `npm run repair:communication-source-dedup:apply` only after reviewing the
  provider-source groups that would be removed.
- Default-off inbound calls are stored as missed-call source records, not as
  answered call events. If older Telnyx source records still show `Inbound call
  received` even though their automation proof has `inboundCallAutoAnswer:
  false`, dry-run `npm run repair:default-off-inbound-calls` and apply the
  reviewed body/proof normalization with
  `npm run repair:default-off-inbound-calls:apply`.
- Workspace email normalizers must preserve full provider participant arrays
  (`fromEmails`, `toEmails`, `ccEmails`, `bccEmails`) in provider metadata and
  proof while selecting exactly one canonical contact email for thread
  attribution. Multi-recipient messages must not lose audit participants.
- Neutral communication-event automation and reply-target resolution must read
  preserved provider participant arrays (`fromPhones`, `toPhones`,
  `fromEmails`, `toEmails`) before falling back to scalar compatibility fields.

## Runtime Memory Rules

- Runtime Contact Memory should be built from contact-scoped thread summaries,
  selected topic summaries, and bounded recent messages.
- Do not inject raw full transcripts, SMS histories, or email bodies by default.
- Full messages are retrieved through tools when the conversation needs them.
- Agent/profile knowledge remains separate from contact conversation memory.
- Provider-specific memories, if any, are optional readback sources; Speak-owned
  threads are the durable source for cross-provider continuity.

## Backfilling older history

The thread model is implemented for current call, browser-test, SMS, email, and tool-proof paths. Existing pre-thread call logs can be imported idempotently with:

```sh
npm run backfill:communication-threads
npm run backfill:communication-threads:apply
```

Run the first command as a dry run and review the planned records before applying. Raw call/test history remains available for recording/audio readback and older records that have not been backfilled.

## Verification

Run:

```sh
npm run qa:communication-threads
npm run qa:agent-readiness
npm run qa:speak-agent-tier
```

The thread check must fail if docs, agent contracts, widget guidance, backend
API references, or provider intake docs stop mentioning the unified thread
contract.
