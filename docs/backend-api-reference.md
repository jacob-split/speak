# Speak Backend API Reference

The backend API is generated from the contract in `server/agent-contract.mjs`. For exact schemas, run:

```bash
npm run --silent agent:openapi
npm run --silent agent:contract
npm run --silent agent:acp
npm run --silent agent:app
npm run --silent qa:backend-api
```

`qa:backend-api` compares this reference against `server/agent-contract.mjs`,
exact method/path route registrations in `server/index.mjs`, package scripts,
and, when `--baseUrl=<url>` is supplied, safe live read endpoints on the
requested Speak surface, live capabilities frontend route labels/UI-action text plus
action method/path readback, live OpenAPI path/method/operationId readback,
and every documented public agent/adapter manifest, widget HTML, and host
client endpoint.
Full-audit runs pass the rendered base URL so API documentation, contract
manifests, and production routes are verified together.

Production roots:

| Surface | URL |
| --- | --- |
| App | `https://speak.example.com/speak/` |
| Backend health | `https://speak.example.com/speak/api/health` |
| MCP app | `https://speak.example.com/speak/mcp` |
| Well-known Speak capabilities | `https://speak.example.com/speak/.well-known/speak-agent.json` |
| A2A Agent Card | `https://speak.example.com/speak/.well-known/agent-card.json` |
| A2A Agent JSON alias | `https://speak.example.com/speak/.well-known/agent.json` |
| OpenAPI | `https://speak.example.com/speak/api/agent/openapi.json` |
| ACP-style manifest | `https://speak.example.com/speak/api/agent/acp` |
| Host client | `https://speak.example.com/speak/api/agent/host-client.mjs` |

The MCP app endpoint uses MCP Streamable HTTP. It is not a static browser
document: plain browser GET requests are expected to return
`406 Not Acceptable` unless the client accepts `text/event-stream`.

Portable agent and widget manifests are generated from `agentAdapters` in
`server/agent-contract.mjs`:

| Manifest | URL |
| --- | --- |
| Agent capabilities | `https://speak.example.com/speak/api/agent/capabilities` |
| Well-known Speak capabilities alias | `https://speak.example.com/speak/.well-known/speak-agent.json` |
| Action invocation | `https://speak.example.com/speak/api/agent/actions/{actionId}/invoke` |
| ChatGPT app manifest | `https://speak.example.com/speak/api/agent/chatgpt-app.json` |
| Agent readiness | `https://speak.example.com/speak/api/agent/readiness.json` |
| Widget HTML | `https://speak.example.com/speak/api/agent/widgets/speak-operator.html` |
| Host client | `https://speak.example.com/speak/api/agent/host-client.mjs` |
| Generative UI | `https://speak.example.com/speak/api/agent/generative-ui.json` |
| UI adapter kit | `https://speak.example.com/speak/api/agent/ui-adapter-kit.json` |
| UI snapshot | `https://speak.example.com/speak/api/agent/ui-snapshot.json` |
| MCP UI | `https://speak.example.com/speak/api/agent/mcp-ui.json` |
| AG-UI | `https://speak.example.com/speak/api/agent/ag-ui.json` |
| A2UI | `https://speak.example.com/speak/api/agent/a2ui.json` |
| Vercel AI SDK UI | `https://speak.example.com/speak/api/agent/ai-sdk.json` |
| Vercel JSON Render | `https://speak.example.com/speak/api/agent/json-render.json` |
| CopilotKit | `https://speak.example.com/speak/api/agent/copilotkit.json` |

The capabilities manifest also exposes `frontend.routes` with route IDs,
operator-facing labels, paths, public URLs, and purposes. The current route
labels are `Library`, `Dialer`, and `Playground`; production `qa:backend-api`
compares those labels against the live `/api/agent/capabilities` payload when a
base URL is supplied.

The agent readiness manifest emits schema `speak.agent-readiness.v1`. A passing
production contract reports `readinessLevel=s-class-candidate`,
`overallStatus=pass`, and `summary.failed=0`; the verifier rejects live
readiness payloads that fail checks or drift from that schema.

## Backend Boundaries

The generated manifests are backed by smaller server modules, not only by route
handlers in `server/index.mjs`. Keep these boundaries current when changing
backend behavior:

| Boundary | Owner |
| --- | --- |
| Generic action invocation | `server/agent-action-invoker.mjs` resolves callable REST actions, authorization modes, path/query/body bindings, and proof readback. |
| Inbound automation policy | `server/communication-automation.mjs` keeps SMS, email, and inbound-call automation default-off unless explicit contact, agent, or system policy enables it. |
| Provider event normalization | `server/telnyx-webhook-normalizer.mjs` and `server/workspace-email-normalizer.mjs` convert Telnyx SMS/call events and Workspace/Gmail sent/received events into communication-thread records. |
| Provider webhook trust | `server/telnyx-webhook-signature.mjs` verifies Telnyx Ed25519 signatures before production webhook events are accepted. |
| Runtime prompt safety | `server/session-prompt.mjs` adds live-call speech guardrails and extracts profile instructions, including persisted prompt tags. |
| Operational dates | `server/operational-time.mjs` keeps call logs and proof artifacts on the Eastern operational day across UTC midnight. |
| Secret lookup | `server/secrets.mjs` centralizes provider secret reads from environment variables and protected local keychains. |

## Invocation Model

Agents and host integrations should prefer the generic action endpoint when they need a stable portable action contract. Contact-record routes still use persisted `lead` action names, so keep those names exact in code while using contact/customer language in user-facing copy:

```ts
const response = await fetch('/speak/api/agent/actions/update_lead/invoke', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    path: { leadId: 'lead-orion' },
    body: {
      patch: { status: 'follow-up', notes: 'Asked for onboarding checklist.' },
    },
  }),
})

const proof = await response.json()
const contact = proof.result.lead
console.log(contact.status)
```

Direct REST routes are supported for backend services and first-party UI code. Unsafe provider webhooks, media WebSockets, internal CLM routes, and SSE streams are intentionally not MCP/action-invocation callable.

Private owner Smart Config routes are first-party UI endpoints, not portable
agent actions. They are owner-gated by `server/smart-config-auth.mjs`, backed by
`server/smart-config-chat.mjs`, and stay outside the generic MCP/action matrix
because the turn route is an owner-only SSE stream that can apply validated
profile patches. The streaming turn endpoint is
`POST /api/smart-config/turns/stream`; no shorter turn endpoint is implemented.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/smart-config/session` | Read owner access and login state. |
| GET | `/api/smart-config/oauth/start` | Start Google owner OAuth. |
| GET | `/api/smart-config/oauth/callback` | Finish Google owner OAuth. |
| POST | `/api/smart-config/logout` | Clear Smart Config owner access. |
| GET | `/api/smart-config/conversations` | List profile-scoped Codex app-server threads. |
| GET | `/api/smart-config/conversations/{conversationId}` | Read one Smart Config thread. |
| POST | `/api/smart-config/conversations` | Create a Smart Config thread for the selected profile. |
| POST | `/api/smart-config/turns/stream` | Stream a Smart Config Codex turn and optional validated profile patch. |

## First-Party And Compatibility REST Routes

These routes are implemented in `server/index.mjs` for first-party UI flows,
provider diagnostics, or compatibility with provider-native configuration
tooling. They intentionally stay outside the generic MCP/action matrix unless a
portable action row below exposes the same capability.

| Method | Path | Purpose | MCP/action callable |
| --- | --- | --- | --- |
| GET | `/api/agent-configs/hume/{configId}` | Direct Hume config readback for provider diagnostics. Prefer `/api/agent-configs/speak/{configId}` for portable Speak profile reads. | no |
| GET | `/api/agent-configs/inworld/{configId}` | Direct Inworld config readback for provider diagnostics. Prefer `/api/agent-configs/speak/{configId}` for portable Speak profile reads. | no |
| GET | `/api/agent-configs/hume-options` | Hume-native model and voice option catalog used by first-party config tooling and live probes. | no |
| GET | `/api/agent-configs/inworld-options` | Inworld-native model and voice option catalog used by first-party config tooling and live probes. | no |
| POST | `/api/agent-configs/sync-hume` | Direct Hume profile sync compatibility route. Prefer `/api/agent-configs/sync-speak` for provider-neutral profile sync. | no |
| POST | `/api/agent-configs/sync-inworld` | Direct Inworld profile sync compatibility route. Prefer `/api/agent-configs/sync-speak` for provider-neutral profile sync. | no |
| POST | `/api/calls/delete` | First-party bulk delete for ended call or Playground test transcripts. Rejects active calls. | no |
| DELETE | `/api/calls/{callControlId}` | First-party single-record delete for ended call or Playground test transcripts. Rejects active calls. | no |
| GET | `/api/calls/{callControlId}/audio` | Local retained mixed WAV stream when Speak has generated call audio. | no |
| GET | `/api/calls/{callControlId}/audio/diagnostics/{stage}` | Local retained diagnostic WAV stream for a specific proof stage, such as CallTools input or handset output evidence. | no |
| WS | `/api/calls/{callControlId}/supervision` | Token-bound first-party Playground Phone media/control socket for mixed caller/agent Spy audio and bounded private audio Whisper transcription. It rejects Browser, Device, Personal Phone, and CallTools sessions. | no |
| GET | `/api/calltools/status` | First-party CallTools account, binding, media-gateway, readiness, and proof summary for the settings UI. Use the contract action `read_calltools_readiness` for portable readiness checks. | no |
| GET | `/api/calltools/options` | First-party CallTools user, phone, campaign, queue, caller ID, status, and source-option catalog for Playground settings. | no |
| GET | `/api/phone-provider/options` | First-party Telnyx phone-number catalog for Speak phone-provider settings. Reads the active `TELNYX_API_KEY` account when available and falls back to explicit env-configured numbers. | no |
| GET | `/api/personal-phone/inbound/readiness` | Sanitized backend/headless Personal Phone handoff readiness. Reports configured booleans, the backend-authoritative contact source ID, bounded counts, blocker names, and durable replay proof; performs no provider call. | no |
| POST | `/api/personal-phone/inbound/handoffs` | Protected Personal Phone Worker policy route. Requires the shared bearer secret and a fresh exact handoff.v1 body; every valid decision is durably idempotent by event plus call ID through a bounded 24-hour replay window. Expired or consumed stream-token replays return voicemail. | no |
| POST | `/api/personal-phone/inbound/handoffs/{correlationId}/resolve` | Protected Personal Phone Worker terminal route. Requires the shared bearer secret and a fresh exact resolve.v1 body; only an exact valid hangup outcome may bypass voicemail. | no |
| POST | `/api/calltools/verify-agent` | First-party backend verifier for a proposed CallTools user/phone/campaign binding. Returns sanitized account proof only. | no |
| POST | `/api/calltools/provision-agent` | First-party dry-run provisioning planner for CallTools Phone-as-Agent bindings. It plans account objects and does not become queue authority. | no |
| GET | `/api/calltools/watchdog` | Sanitized VM-resident CallTools call-quality watchdog status, including cadence, last check/repair, semantic model/status, and recent incident codes/call IDs without token usage, transcript evidence, or profile instructions. | no |
| GET | `/api/calltools/gateway-config` | Protected CallTools WebRTC/SIP phone credential read for the persistent Speak media gateway. Requires the gateway shared secret and must never expose phone credentials through public contracts. | no |
| WS | `/api/calltools/media-gateway` | Protected Speak-owned WebRTC/SIP media-gateway socket. It is a runtime bridge for the persistent CallTools gateway, not an agent action. | no |
| POST | `/api/webhooks/workspace-email` | Trusted Workspace/Gmail sent/received event normalizer. Internal-only; records email source history and keeps inbound automation off unless a trusted ingester explicitly enables it. | no |

## REST And Action Matrix

| Action ID | Method | Path | Kind | Risk | MCP/action callable |
| --- | --- | --- | --- | --- | --- |
| `read_runtime_health` | GET | `/api/health` | read | low | yes |
| `read_recent_calls` | GET | `/api/calls/recent` | read | low | yes |
| `read_communication_threads` | GET | `/api/communication-threads` | read | low | yes |
| `read_communication_thread` | GET | `/api/communication-threads/{threadId}` | read | low | yes |
| `read_communication_thread_messages` | GET | `/api/communication-threads/{threadId}/messages` | read | low | yes |
| `send_communication_message` | POST | `/api/communication-messages/send` | write | high | no |
| `read_contact_communication_memory` | GET | `/api/contacts/{contactId}/communication-memory` | read | low | yes |
| `rebuild_communication_thread_summary` | POST | `/api/communication-threads/{threadId}/summary/rebuild` | maintenance | medium | no |
| `record_communication_event` | POST | `/api/communication-events` | internal | high | no |
| `sync_workspace_email` | POST | `/api/workspace-email/sync` | internal | high | no |
| `read_workspace` | GET | `/api/workspace` | read | low | yes |
| `search_workspace` | GET | `/api/search` | read | low | yes |
| `upload_context_file` | POST | `/api/context-files` | binary-upload | medium | no; OpenAPI documented |
| `download_context_file` | GET | `/api/context-files/{fileId}/download` | binary-download | medium | no; OpenAPI documented |
| `delete_context_file` | DELETE | `/api/context-files/{fileId}` | binary-delete | high | no; OpenAPI documented |
| `read_personal_phone_contacts_status` | GET | `/api/personal-phone/contacts` | read | low | yes |
| `read_calltools_campaign_contacts_status` | GET | `/api/calltools/campaign-contacts` | read | low | yes |
| `read_dialer_state` | GET | `/api/dialer-state` | read | low | yes |
| `update_dialer_state` | PATCH | `/api/dialer-state` | mutation | medium | yes |
| `list_leads` | GET | `/api/leads` | read | low | yes |
| `replace_leads` | PUT | `/api/leads` | mutation | high | yes |
| `create_lead` | POST | `/api/leads` | mutation | medium | yes |
| `import_leads` | POST | `/api/leads/import` | mutation | medium | yes |
| `list_smart_views` | GET | `/api/smart-views` | read | low | yes |
| `upsert_smart_view` | POST | `/api/smart-views` | mutation | medium | yes |
| `import_smart_view_leads` | POST | `/api/smart-views/import` | mutation | medium | yes |
| `sync_personal_phone_contacts` | POST | `/api/personal-phone/contacts/sync` | mutation | medium | yes |
| `sync_calltools_campaign_contacts` | POST | `/api/calltools/campaign-contacts/sync` | mutation | medium | yes |
| `delete_smart_view` | DELETE | `/api/smart-views/{smartViewId}` | mutation | medium | yes |
| `update_lead` | PATCH | `/api/leads/{leadId}` | mutation | medium | yes |
| `delete_lead` | DELETE | `/api/leads/{leadId}` | mutation | high | yes |
| `bulk_update_lead_status` | POST | `/api/leads/bulk-status` | mutation | medium | yes |
| `bulk_delete_leads` | POST | `/api/leads/bulk-delete` | mutation | high | yes |
| `list_profiles` | GET | `/api/profiles` | read | low | yes |
| `replace_profiles` | PUT | `/api/profiles` | mutation | high | yes |
| `upsert_profile` | POST | `/api/profiles` | mutation | medium | yes |
| `set_active_profile` | PUT | `/api/profiles/active` | mutation | medium | yes |
| `delete_profile` | DELETE | `/api/profiles/{profileId}` | mutation | high | yes |
| `read_calltools_readiness` | GET | `/api/calltools/readiness` | read | low | yes |
| `establish_calltools_agent_session` | POST | `/api/calltools/agent-session` | maintenance | medium | no |
| `start_live_call` | POST | `/api/calls/start` | mutation | high | yes |
| `start_phone_config_test` | POST | `/api/calls/start` | mutation | high | yes |
| `stream_call_events` | GET | `/api/calls/{callControlId}/events` | sse | low | no |
| `pause_agent_for_takeover` | POST | `/api/calls/{callControlId}/barge-in` | mutation | high | yes |
| `resume_agent_after_takeover` | POST | `/api/calls/{callControlId}/resume` | mutation | medium | yes |
| `send_live_instruction` | POST | `/api/calls/{callControlId}/instructions` | mutation | medium | yes |
| `send_operator_chat_message` | POST | `/api/operator-chat/turns` | mutation | medium | yes |
| `end_live_call` | POST | `/api/calls/{callControlId}/end` | mutation | high | yes |
| `read_call_audio_link` | GET | `/api/calls/{callControlId}/audio-link` | read | low | yes |
| `read_speak_config` | GET | `/api/agent-configs/speak/{configId}` | read | low | yes |
| `read_speak_options` | GET | `/api/agent-configs/speak-options` | read | low | yes |
| `sync_speak_config` | POST | `/api/agent-configs/sync-speak` | mutation | medium | yes |
| `read_browser_config_tests` | GET | `/api/config-tests/recent` | read | low | yes |
| `start_browser_config_test` | POST | `/api/config-tests/start` | mutation | medium | yes |
| `send_browser_config_message` | POST | `/api/config-tests/{testId}/message` | mutation | medium | yes |
| `stream_browser_config_audio` | WEBSOCKET | `/api/config-tests/{testId}/audio` | websocket | medium | no |
| `end_browser_config_test` | POST | `/api/config-tests/{testId}/end` | mutation | medium | yes |
| `codex_clm_chat_completion` | POST | `/api/codex-clm/chat/completions` | internal | high | no |
| `phone_media_stream` | WEBSOCKET | `/media-stream` | provider-websocket | high | no |
| `phone_provider_webhook` | POST | `/api/webhooks/telnyx` | provider-webhook | high | no |
| `voice_provider_webhook` | POST | `/api/webhooks/hume` | provider-webhook | high | no |

Browser Playground clients end sessions on reset, unmount, failed/late starts,
and explicit Stop. If the backend restarts first, `end_browser_config_test`
recognizes a persisted Browser-test ID and appends terminal proof so Recent
tests cannot remain falsely live after the in-memory voice session is gone.

## Contact Memory And Agent Knowledge Files

Context can be attached to `lead.context` for Contact Memory or `profile.context` for the Agent Knowledge Layer. Binary upload/download/delete routes are OpenAPI documented but intentionally not generic MCP-callable because agents need explicit file handling and authorization.

`read_speak_options` returns the combined Hume/Inworld/xAI model and voice
catalogue. Consumers must keep provider-native choices separate from
Codex-auth choices and show only the selected runtime's controls. Hume Codex-auth options mirror the authenticated Codex
catalogue. Inworld Codex-auth options are its live intersection with Inworld's
model catalogue and include the selected model's supported reasoning catalogue.
Inworld reasoning is fixed to `None` while shared tools are active because its
chat-completions route rejects function tools combined with nonzero effort.
Fast mode applies to every returned Codex-auth choice; on Inworld it disables
conversational TTS context and uses `fast_start`.
xAI returns its live built-in/custom voice catalogue and native Voice Agent
models only; it does not advertise Codex-auth choices.
When only one provider refresh fails, the response includes a sanitized
`providerErrors` entry while preserving the other provider's live options; the
first-party UI retains its last available catalogue and prompts the operator to
retry instead of presenting a transient timeout as a removed model.

```ts
const upload = await fetch('/speak/api/context-files', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/pdf',
    'X-Speak-File-Name': encodeURIComponent('onboarding-checklist.pdf'),
  },
  body: pdfArrayBuffer,
})
const attachment = await upload.json()

await fetch('/speak/api/leads/lead-orion', {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    context: {
      text: 'Use implementation notes only if the customer asks about onboarding.',
      urls: ['https://speak.split-llc.com/agent-integration.md'],
      files: [attachment],
    },
  }),
})
```

Supported extraction includes plain text, Markdown, CSV, HTML, JSON/XML/log-style text, PDF, `.docx`, and `.xlsx`. Unsupported binary formats fail closed with `extractionStatus` such as `unsupported` or `error`.

## Communication Threads

Current production communication history is Speak-owned and thread-based. New
call, browser-test, SMS, email, portal-link, contact-update, and tool-proof
events are mirrored into durable `communicationThread` and
`communicationMessage` records. `read_recent_calls`,
`read_browser_config_tests`, `/api/calls/recent`, and
`/api/config-tests/recent` remain compatibility/readback routes for raw call
summaries, recordings, and older records.
Recent call summaries include sanitized `provider`, `providerIds`, and
`lead.source/sourceId` attribution so CallTools follow-mode calls can be matched
back to the correct contact source without inferring from contact names or local
queue state.
Backfill older call logs with `npm run backfill:communication-threads` for a
dry run and `npm run backfill:communication-threads:apply` when applying to the
configured workspace.

The model is documented in
[Communication thread model](communication-thread-model.md). Call, SMS, email,
browser-test, tool-proof, recording, and provider-event work must normalize
into contact-scoped `communicationThread`, `communicationMessage`,
`communicationTopic`, and `contactIdentityLink` records instead of adding
channel-specific history stores.

`communicationThread.messageCount`, `communicationThread.emotionScoreTurns`,
and `communicationThread.hasEmotionScores` are materialized from normalized
messages so Activity filters match expanded source history. `communicationMessage.emotionScores`
is a provider score map when the source turn emitted one, not a required field.
UI surfaces render the same transcript bubble, participant label,
copy/collapse controls, and score strip wherever a thread message is displayed;
providers without score payloads should not emit a placeholder or missing-value
state.

Primary read surfaces:

| Route | Purpose |
| --- | --- |
| `GET /api/communication-threads` | Cursor-page thread summaries by contact, agent profile, channel, status, or updated time. |
| `GET /api/communication-threads/{threadId}` | Read one thread summary and provider-link metadata. |
| `GET /api/communication-threads/{threadId}/messages` | Cursor-page normalized messages for one thread. |
| `POST /api/communication-messages/send` | First-party UI route for operator-confirmed SMS/email sends and replies. Sends through Telnyx or the workspace email account, returns provider proof, and writes the outbound message back to the communication thread. High-risk and not MCP-callable. UI and widget callers must preflight `/api/health`; the backend also rejects unready sends before provider IO. Backend SMS send requires `delivery.smsConfigured=true`, and backend Workspace email send requires `delivery.emailConfigured=true` with `delivery.emailSendAsConfigured=true`. |
| `GET /api/contacts/{contactId}/communication-memory` | Compact prior-context block for runtime Contact Memory. |
| `POST /api/communication-events` | Internal/provider normalizer for call, SMS, email, and tool events. Requires trusted internal access. Records inbound SMS/email/call automation proof by default; only applies auto-reply or auto-answer when `allowAutomation` is explicitly true and explicit context/system policy authorizes it. |
| `POST /api/webhooks/telnyx` | Telnyx SMS and Call Control webhook ingress. Provider-only, signature-verified in production, records inbound/outbound source events, and is not MCP-callable. Inbound automation remains record-only unless `SPEAK_TELNYX_WEBHOOK_ALLOW_AUTOMATION=true` and explicit contact/agent/system policy authorizes the action. |
| `POST /api/communication-threads/{threadId}/summary/rebuild` | Trusted maintenance route for rebuilding materialized summaries/topics. |
| `POST /api/webhooks/workspace-email` | Trusted Workspace/Gmail sent/received email normalizer. Requires internal access and records email as a communication message. Inbound auto-replies are record-only unless the trusted ingester explicitly sends `allowAutomation: true` and context/system policy authorizes a fixed reply. |
| `POST /api/workspace-email/sync` | Internal bounded Gmail inbox/outbox sync. Fails closed unless `delivery.emailSourceReadConfigured=true`, uses the GOG-backed read auth account, records into communication threads under the configured workspace mailbox identity, and disables inbound auto-replies unless `allowAutomation` is explicitly true. |

Provider event ingestion through `/api/communication-events` and webhook
normalization remain internal and non-MCP-callable. Neutral
`/api/communication-events` writes are record-only by default and may run
auto-reply/auto-answer only when a trusted ingester sends `allowAutomation:
true`. Telnyx SMS inbox/outbox events, default-off missed inbound calls, and
trusted Workspace sent/received email events attach only through verified
phone/email/thread attribution.
Direct Telnyx webhook intake has its own backend opt-in:
`SPEAK_TELNYX_WEBHOOK_ALLOW_AUTOMATION=true` must be set before signed Telnyx
webhooks may apply explicit SMS auto-reply or inbound-call auto-answer policy.
When unset, the route records source events and disabled automation proof only.
When explicit inbound-call auto-answer is enabled, the signed Telnyx route must
answer through native Call Control with Speak bidirectional media settings and
persist both inbound source policy proof and an `auto_answer_started` proof
message in the same communication thread.
For provider-neutral events, send the contact target in
`event.communication.identity.phone` for SMS/call or
`event.communication.identity.email` for email. Automation reply and answer
targets are resolved from that identity first, then provider IDs/proof as
fallbacks.
Operators can dry-run Workspace/Gmail sync with `npm run sync:workspace-email`
and apply it with `npm run sync:workspace-email:apply`; apply remains
record-only unless `--allow-automation` is supplied.
`npm run qa:workspace-email` is the production readiness check for Workspace
email. The check reports Gmail read/source readiness separately from
send/reply readiness; `WORKSPACE_EMAIL_READ_GOG_ACCOUNT` is required for
source sync, and `WORKSPACE_EMAIL_SEND_GOG_ACCOUNT` with send scope plus
accepted send-as identity is required before email replies are end-to-end
configured. The configured Gmail account broker should store mailbox auth accounts additively, so adding another account preserves existing entries; Speak chooses the active sender/reader through the
`WORKSPACE_EMAIL_SEND_GOG_ACCOUNT` and `WORKSPACE_EMAIL_READ_GOG_ACCOUNT`
environment variables. `npm run qa:workspace-email-source` is the production source-read
proof; it requires the configured read auth account to return a bounded
normalized sample involving `WORKSPACE_EMAIL_ACCOUNT`. The default sync query
is participant-scoped to `WORKSPACE_EMAIL_ACCOUNT`, and the sync normalizer
rejects auth-account-only mail so a broker account cannot
accidentally write unrelated messages into the visible workspace mailbox
thread history. If send-as readiness fails because Gmail settings scope is
missing, use `npm run repair:workspace-email-sendas:auth-url` on the production
host, complete Google consent, then finish with
`npm run repair:workspace-email-sendas:auth-complete -- --auth-url '<redirected-localhost-url>'`;
completion applies the send-as repair and reruns `qa:workspace-email`.
If Workspace email thread attribution repair or any provider normalizer change
leaves duplicate communication rows for the same native source event, run
`npm run repair:communication-source-dedup` on production, review the reported
provider-source groups, then apply with
`npm run repair:communication-source-dedup:apply`.
If default-off inbound-call source records still display as `Inbound call
received`, run `npm run repair:default-off-inbound-calls` on production and
apply the reviewed missed-call body/proof normalization with
`npm run repair:default-off-inbound-calls:apply`.
`npm run qa:telnyx-source-routing` is the production readiness check for SMS
and inbound-call source routing. The check verifies the configured phone
number belongs to the configured Telnyx messaging profile, is attached to the
configured Call Control application, and both provider webhook URLs point at
Speak's production Telnyx webhook. It also requires
`TELNYX_WEBHOOK_SIGNATURE_REQUIRED=true` plus a Telnyx public signing key
that is parseable by Speak's production webhook verifier, so SMS inbox/outbox
or inbound-call history is not treated as end-to-end configured while unsigned
or un-verifiable provider ingress can write source records.
Ambiguous inbound SMS, calls, or email must create or surface an
unresolved-attribution thread rather than attaching history to a contact by
name alone. Auto-reply and inbound-call auto-answer are default-none/default-off
and must not run from webhook intake without an explicit server-owned policy.
For SMS and email, explicit fixed-reply policy can come from contact context,
agent context, or system env and writes outbound proof into the same thread.
Unresolved-attribution messages block auto-send and auto-answer. Inbound call
auto-answer remains off by default; explicit policy uses Telnyx `answer` with
Speak's bidirectional `/media-stream` bridge and records proof in the same
thread, including an `auto_answer_started` system message after Telnyx accepts
the answer request.

`/api/communication-messages/send` is reserved for first-party operator UI. It
supports received-message replies and contact-field sends, returns provider
proof, and records the outbound item in the same communication-thread model.
SMS UI must keep both paths visible: current-device `sms:` handoff with no
backend proof and Telnyx/Speak agent-number delivery through the backend. Email
delivery uses the configured workspace account, defaulting to
operator&#64;example.com.

CallTools status and options include `mediaGatewayProfiles[]` with registered
profile ID, profile name, phone ID, sample rate, heartbeat timestamps,
`lastSeenAgeMs`, `heartbeatStaleAfterMs`, `healthy`, `stale`, and active call
IDs when present. Use that profile-specific readback for readiness; a registered
gateway for one CallTools phone does not make unrelated profiles live-call
ready, and stale gateway websockets do not count as connected. When Available is
confirmed, the backend combines the selected Hume/Inworld/xAI agent with the current
shared CallTools user/phone/campaign binding, then asks the idle gateway to select
that exact agent and requires browser-side acknowledgement on the already assigned
phone. The voice profile is not overwritten; a busy gateway or conflicting
explicit phone binding fails before native AgentStatus is armed.
`GET /api/calltools/readiness` is the read-only production preflight. It returns
`ready`, `runtimeReady`, diagnostic `directStartReady`, `campaignReady`, `checks[]`, `blockers[]`, and
`counts` for API auth, agent user, native agent session, WebRTC phone, media
gateway, campaign, caller ID, live filter, native dispositions, active live
calls, and outcome writeback. The `agent-session` check reads CallTools
registered Speak media gateway, optional Web Call Back route metadata, campaign
source health, and native `agentstatuses/{appUserId}`. `runtimeReady` is the
Speak runtime/gateway baseline. `directStartReady` additionally requires the
bound CallTools agent to be native-ready and webphone-registered with
`webPhoneRegisteredOn` proof. This field is retained for compatibility
diagnostics only and never authorizes `/api/calls/start`; direct CallTools starts
return `409 calltools_direct_start_disabled` before provider mutation.
`campaignReady` is the supported operational gate and means the native CallTools
campaign and agent session established by Go available are ready:
backend AgentStatus is ready, bound to the selected campaign, backed by
per-agent `/campaignagents/{app_user_id}/` readiness and matching campaign
aggregate agent counts, campaign/caller ID checks pass, and campaign inventory
is selectable. The `agent-session` proof must declare
`backendOnly=true`, `headlessOnly=true`,
`campaignStartPath=campaigns.patch`,
`campaignAgentEstablishPath=campaignagents.patch`,
`establishPath=agentstatuses.patch`, and proof sources for `agentstatuses.read`, `campaignagents.read`, and
`campaignstatuses.read`; browser or dashboard session state is not accepted.
Top-level `ready` requires both `runtimeReady` and
`campaignReady`; raw SIP registration alone is not enough. The
`campaign-source` check separates source
membership from CallTools campaign selectability: bucket-source proof includes
`membershipCount` from native `ContactBucket` rows and keeps the bucket/live
filter API count as `reportedCount`, while `selectableContactCount` is the
effective selectable proof from either CallTools campaign status or a direct
CallTools `/contacts/` source query for `live_filter_id` / `buckets__id`.
`campaignStatusSelectableContactCount` preserves the raw campaign-status count
so delayed or stale campaign inventory remains visible. Because CallTools list
rows can omit phone fields that are present on contact detail reads, source
selectability hydrates the native contact detail before declaring a row
phone-less. A positive membership or source contact count clears false
empty-source reporting only when the direct source query also shows at least
one ready, unsuppressed, dialable contact.
CallTools API collection/object failures surface as explicit `*_READ_FAILED`
blockers with sanitized `readError` proof on the affected check and top-level
`readErrors`; these provider failures must not be reported as missing Speak
configuration or empty inventory. The readiness endpoint itself does not start,
stop, activate, update, or otherwise mutate CallTools.
It also returns `dutyMonitor`, the sanitized proof for the durable
campaign-follow Available lease: `backendMonitored=true`, `autoRearm=true`, status,
frozen app-user/campaign/phone binding, profile ID, timestamps, and retry
blockers. The monitor is owned by the backend service, so it continues when the
Dialer tab is closed. While a lease is active it reads native AgentStatus and
campaign status and verifies the selected media gateway's heartbeat, SIP
registration, and audio-track health. Transient campaign, provider-read, gateway,
SIP, or audio drift retains the lease and is reconciled back to native
`ready=true`. Only an explicit Go unavailable operation disarms AgentStatus and
releases Speak's SIP registration for the human handoff.

`GET /api/calltools/watchdog` returns sanitized, read-only proof for the VM-resident
five-minute call-quality watchdog. It includes current status, cadence, last check,
last repair and semantic-review status/model, bounded run count, and recent incident
codes with call IDs. Token usage, transcript excerpts, and profile instructions
remain in the VM-only state file. The
watchdog is idle and makes no semantic model request while the persisted CallTools
lease is Unavailable; while Available, unchanged transcript fingerprints are not
reviewed twice.

`POST /api/calltools/agent-session` is the backend/headless establishment path
used by the Dialer availability handoff, `npm run calltools:agent-session`, and
strict `qa:calltools-readiness`. It wraps the native CallTools
`campaigns/{campaignId}` PATCH for `active=true` and
`originate_calls=true`, `/campaignagents/{appUserId}` PATCH for the selected
campaign and readiness, and `agentstatuses/{appUserId}` PATCH for `ready`,
`web_phone_status=Registered`, and `web_phone_registered_on`. The shared-seat
guard runs before those mutations, so an owned Available human session is never
displaced. The supported mode is campaign-follow availability: `ready=true`
starts the selected native campaign and agent session without browser/dashboard
login, while `ready=false` releases the Speak agent after native AgentStatus and
SIP unregistration are proved without deactivating the campaign. The route returns the
same sanitized backend proof fields used by readiness: `backendOnly=true`,
`headlessOnly=true`, `campaignStartPath=campaigns.patch`,
`campaignAgentEstablishPath=campaignagents.patch`,
`establishPath=agentstatuses.patch`, and
`agentstatuses.read` / `campaignagents.read` / `campaignstatuses.read` proof
sources. Apply mode requires both `apply=true` and `confirmAgentSession=true`;
without confirmation the route is a non-mutating plan/readback. Browser
automation, dashboard login state, and browser-held webphone sessions are not
accepted as proof for this route.
Dialer campaign-follow mode persists an `arming` lease with the selected profile
and frozen CallTools binding before native AgentStatus is mutated. Successful
readback transitions it to `on`; Go unavailable transitions to `disarming` and
only reaches `off` after native `after.ready=false` and SIP unregistration are
both proved. A crash or failed Available transition retains an `arming`, `on`,
or `attention` lease and repairs toward Available. A failed Unavailable
transition remains `disarming` and repairs only toward release. Generic
`/api/dialer-state` patches cannot
replace this server-owned lease or resurrect `campaignRunning` after release.
`POST /api/calls/start` is a Speak/Telnyx direct-call route. After resolving a
saved profile, it returns `409` with code `calltools_direct_start_disabled` when
`dialerProvider=calltools`, before voice-provider reconciliation, gateway
selection, AgentStatus mutation, or dialing. Playground Phone uses a transient
`dialerProvider=speak` config and the selected Telnyx caller ID; it does not
change or claim the saved profile's CallTools seat.

Browser and Phone Playground clients send a unique `startRequestId` with each
start. `POST /api/playground-starts/:startRequestId/cancel` records a bounded,
expiring cancellation tombstone before attempting session cleanup. This makes
reset, navigation, refresh, and tab close fail closed even when the start
response is still pending: Browser sessions are closed, and a Telnyx call that
is accepted after cancellation is hung up immediately with bounded background
retry. Tombstones default to 15 minutes so they outlive every bounded provider
or readiness request; duplicate request IDs are rejected.

selected durable lease, waits for a new native answered invite, and releases
only the lease it armed during cleanup.
Supported certification starts with an actual native campaign invite while the
selected durable lease is Available. Run
`qa:calltools-live-proof -- --require-complete --callControlId=<id>` against the
VM log/audio to produce `speak.calltools.campaign-proof.v1`, then pass that
artifact and run `audit:calltools-recording-transcript` for recording-derived review.
Fresh calls may still be waiting on CallTools historical recording
generation; inside `CALLTOOLS_RECORDING_LAG_GRACE_MS`, missing native
`/calls/` recording metadata is pending provider evidence, not a failure of the
live Speak engine proof. The backend also retries
CallTools historical `/calls/` recording lookup after call end through
`CALLTOOLS_RECORDING_RECONCILE_DELAYS_MS`; the default schedule includes short
retries plus roughly 10, 30, and 60 minute checks so delayed CallTools recording
metadata can still attach to the communication thread after the live call has
ended.
CallTools recording-derived review can run after any completed native campaign
call. When the historical
`/calls/` row exposes `call_recording_fsfile_id`, the recording audit downloads the
CallTools recording from `/filesystemfiles/{call_recording_fsfile_id}/download/`
and transcribes it with Inworld STT for review; a supplied `--recordingFile` is
only an override. A review can use `--require-clean` so warning-level gaps such
as material Speak turns missing from the recording-derived transcript fail the
lane. Short live-STT fragments that the
recording-derived transcript corrects are reported separately as
`LIVE_SPEAK_STT_CORRECTED_BY_PROVIDER_RECORDING` info findings. Pending provider
artifacts remain diagnostic evidence. Recording review alone cannot certify
live campaign media, selected-profile routing, or shared-seat release. Direct
`audit:calltools-recording-transcript` runs
with only `--callControlId` scan recent Speak call logs, so an evening Eastern
proof rerun after UTC midnight does not drift to the wrong `events-*.jsonl`.
`npm run audit:calltools-recording-rhythm` is the read-only tool for measuring
recording-reference delay against the current account. It queries `/calls/`
only. Speak's recording-derived transcript comparison is generated from
recording audio. No CallTools text artifact is part of the transcript path.
`GET /api/calltools/gateway-config` is protected by the gateway shared secret
and returns the selected CallTools WebRTC/SIP phone credential to the headless
gateway. It prefers native direct `GET /phones/{id}/` with
`CALLTOOLS_PHONE_CREDENTIAL_TIMEOUT_MS`, but may use server-local
`CALLTOOLS_PHONE_CREDENTIALS_FILE` or `CALLTOOLS_GATEWAY_PHONE_*` fallback values
after native phone read failure. When
`CALLTOOLS_PHONE_CREDENTIAL_FALLBACK_FIRST=true`, it uses the local fallback
immediately so production restarts are not blocked by a slow upstream CallTools
API. Those fallback values must never appear in profile state, public readiness
payloads, client bundles, or logs.
`POST /api/calltools/campaign-contacts/sync` reads the selected CallTools
campaign live filter or bucket by paging `/contacts/` with explicit `page` and
`page_size`, imports the returned contacts into a durable `source=calltools`
contact source, and preserves CallTools campaign/contact metadata as provider
IDs. It does not start, stop, or mutate the CallTools campaign.
When no CallTools numbers or live-filter/bucket contacts are loaded, it returns a
proof object with `queriedContactCount=0` and an empty contact source. For CallTools profiles,
`POST /api/calls/start` is unsupported and returns
`calltools_direct_start_disabled` after resolving the saved profile but before
any provider mutation. Use Go available to start the selected native campaign
and agent session. CallTools remains the contact-selection and dial authority;
Speak attaches when that campaign routes a SIP invite to the Available agent.

When the media gateway reports `call.start`, the backend attempts a bounded
CallTools lookup against `/livephonecalls/` and then `/contacts/{id}/` before
creating the Speak call state. Successful lookups enrich the runtime contact,
Contact Memory lookup, and communication provider IDs with CallTools contact,
campaign, Web callback, queue, phone, and live-call identifiers. Lookup failure
is fail-soft: the call still attaches from the SIP invite, but diagnostics and
provider IDs will be limited to the gateway payload.

CallTools caller audio arrives as PCM16 frames over `/api/calltools/media-gateway`.
The browser gateway packetizes inbound WebRTC audio into 20 ms frames at the
profile sample rate, and the backend stores the observed frame duration as
`calltools.inputFrameMs` in transport diagnostics. The same snapshot exposes
CallTools timing fields including `calltoolsDialToGatewayAttach`,
`firstCallToolsLeadAudioToFirstUserMessage` for
caller/contact audio,
`firstUserMessageToFirstAssistantAudio`,
`firstUserMessageToFirstAssistantMessage`, and
`firstInworldAudioToFirstCallToolsAudio` so answer-time attach and audio-path
latency can be verified from completed call records. Run
`npm run qa:calltools-live-proof -- --require-complete --callControlId=<id>`
against the VM call log/audio after an answered native campaign call. It emits
`speak.calltools.campaign-proof.v1` only when the selected Available lease,
campaign/profile identity, answered attach, caller-before-assistant transcript
order, two-sided audio, latency, audio-quality gates, and retained WAV evidence pass. Packet counters
are transport evidence only; they are not enough to prove caller speech or
handset audibility.

Any future test callee must enter through the native CallTools campaign like a
human contact. It must not receive provider-specific transcript or audio
shortcuts.

Use `npm run audit:calltools-recording-transcript -- --callControlId=<id> --log=/opt/speak/call-logs/events-YYYY-MM-DD.jsonl`
when a CallTools recording-derived transcript needs review against Speak. The audit is
read-only. It compares Speak call-log turns, local `lead-calltools-input` and
`ai-calltools-output` WAV audibility, `/calls/` recording metadata, and the
recording-derived transcript generated by Speak from CallTools recording audio.
When recording audio is available, pass
`--transcribeRecording` so the audit can download
`/filesystemfiles/{call_recording_fsfile_id}/download/` from the historical
CallTools call row and generate the recording-derived transcript through the
configured Speak STT path. Pass `--recordingFile=<file> --transcribeRecording` or run
`npm run calltools:transcribe-recording -- --recordingFile=<file>` only when a
local file must override provider download.

When a CallTools-backed call ends, Speak maps the final Speak outcome to a
CallTools call disposition by reading `/calldispositions/` and building a
`HistoricalCallDisposition` payload. By default this is proof-only and is logged
on the call event. Set `CALLTOOLS_SYNC_OUTCOMES=true` to allow confirmed
`POST /historicalcalldispositions/` writeback.

The shared `hang_up` tool and backend use one canonical hyphenated outcome
vocabulary; underscore aliases remain accepted. Missing or invalid tool
outcomes fail closed to `no-answer` before the first caller turn or
`operator-ended` after a conversation, while `completed` requires an explicit
outcome. Explicit `completed` remains neutral: it maps to the same native
disposition as `operator-ended` and never implies that a sales goal was met.
CallTools readiness verifies native disposition coverage for callback and
wrong-number outcomes as well as the other advertised results. A missing
dedicated voicemail disposition does not block CallTools readiness because the
native dialer filters voicemail before agent handoff. If an unexpected
voicemail outcome reaches reconciliation, it fails closed rather than mapping
to a goal, DNC, non-contact, or vertical-specific result.

The same call-end path reads the native CallTools historical `/calls/` record
when available, then schedules short background retries so delayed CallTools
recording metadata can be attached without blocking the final transcript event.
If that payload includes `call_recording_fsfile_id`, Speak adds a
`provider=calltools`, `kind=recording` provider link and a CallTools recording
attachment to the communication thread. The playable fast path remains the
local Speak mixed WAV returned by `/api/calls/{callControlId}/audio-link`;
CallTools provider media should be resolved or cached only through a future
backend-controlled URL when CallTools exposes a stable media retrieval path.
The CallTools recording reference is the provider-side source for a Speak-owned
transcription job rather than evidence that no conversation occurred.
Because CallTools may publish recording artifacts after the live call
has already ended, production tests should use Speak's call log, local WAV
audibility, and live proof artifact for immediate pass/fail, then rerun the
recording-derived audit after the provider lag window if CallTools artifacts are
still missing.

## Proof Rules

Mutating actions return proof fields. A caller must not claim that SMS, email, contact changes, profile sync, hangup, or call start happened unless the backend response proves it.

Examples:

| Action | Expected proof |
| --- | --- |
| `update_lead` | updated contact record with `updatedAt` or changed fields |
| `sync_speak_config` | saved profile plus provider config/version/sync timestamp |
| `start_live_call` | call control ID, selected contact, active phase, provider acceptance details |
| `end_live_call` | call state with ended/hangup proof |
| `send_operator_chat_message` | turn result plus whether guidance was live, queued, or future-scoped |

## Host Client

Use the portable ESM host client when embedding Speak in iframe/custom-element, MCP UI, AG-UI, A2UI, A2A, Vercel AI SDK, Vercel JSON Render, CopilotKit, or similar hosts:

```js
import { createSpeakAgentClient } from '/speak/api/agent/host-client.mjs'

const client = createSpeakAgentClient({
  baseUrl: 'https://speak.example.com/speak',
})

await client.invoke('read_workspace')
await client.hydrateWidget('#speak-widget', { surface: 'dialer' })
const connection = client.connectWidget('#speak-widget')
```

The host client does not broaden backend authorization. It only normalizes discovery, hydration, UI snapshot, and action invocation.
