# Speak Agent Integration Guide

This is the agent-only page. It is written for MCP hosts, ChatGPT Apps, MCP UI, AG-UI, A2UI, A2A, Vercel AI SDK, Vercel JSON Render, CopilotKit, custom iframe hosts, and headless backend agents.

## Portable Integration Rule

Start from discovery, invoke actions through stable IDs, require backend proof for mutations, and use the same context model as the UI. Do not scrape the browser, infer provider state, or call provider routes directly when a Speak contract route exists.

## First Requests

```bash
curl https://speak.example.com/speak/api/health
curl https://speak.example.com/speak/api/agent/capabilities
curl https://speak.example.com/speak/api/agent/openapi.json
curl https://speak.example.com/speak/api/agent/acp
curl https://speak.example.com/speak/api/agent/chatgpt-app.json
curl https://speak.example.com/speak/api/agent/readiness.json
curl https://speak.example.com/speak/api/agent/generative-ui.json
curl https://speak.example.com/speak/api/agent/ui-adapter-kit.json
curl 'https://speak.example.com/speak/api/agent/ui-snapshot.json?surface=library&limit=12'
curl 'https://speak.example.com/speak/api/agent/ui-snapshot.json?surface=dialer&limit=12'
curl 'https://speak.example.com/speak/api/agent/ui-snapshot.json?surface=configs&limit=12'
curl https://speak.example.com/speak/api/agent/mcp-ui.json
curl https://speak.example.com/speak/api/agent/ag-ui.json
curl https://speak.example.com/speak/api/agent/a2ui.json
curl https://speak.example.com/speak/api/agent/ai-sdk.json
curl https://speak.example.com/speak/api/agent/json-render.json
curl https://speak.example.com/speak/api/agent/copilotkit.json
curl https://speak.example.com/speak/api/agent/widgets/speak-operator.html
curl https://speak.example.com/speak/api/agent/host-client.mjs
curl https://speak.example.com/speak/mcp \
  -H 'Accept: application/json, text/event-stream'
curl https://speak.example.com/speak/.well-known/speak-agent.json
curl https://speak.example.com/speak/.well-known/agent-card.json
curl https://speak.example.com/speak/.well-known/agent.json
```

Local equivalents:

```bash
npm run --silent agent:contract
npm run --silent agent:openapi
npm run --silent agent:acp
npm run --silent agent:app
npm run --silent agent:genui
npm run --silent agent:readiness
npm run --silent agent:ui-kit
npm run --silent agent:ui-snapshot
npm run qa:backend-api
npm run qa:agent-adapters
npm run qa:ui-adapter-kit
npm run qa:ui-snapshot
npm run qa:voice-provider-process
npm run qa:voice-configs
npm run qa:communication-threads
npm run qa:speak-agent-tier
```

Backend API continuity is verified by `npm run qa:backend-api`, which checks
the generated contract, API reference, implemented routes, and safe live read
endpoints when a base URL is supplied. The live `/api/agent/capabilities`
action method/path readback must also match the local contract, so a stale
running backend cannot pass just because its endpoints are healthy. The live
OpenAPI path/method/operationId readback must match too, so generated REST
client contracts cannot drift independently. Do not document or use
provider-neutral placeholder webhook paths when the real implemented routes are
provider-specific.

Production communication-source readiness checks are host-bound:
`npm run qa:telnyx-source-routing`, `npm run qa:workspace-email`, and
`npm run qa:workspace-email-source` must run on the production host because
they verify live Telnyx routing plus webhook signature enforcement,
Workspace/Gmail auth/send-as readiness, and actual bounded mailbox source
visibility. Workspace/Gmail checks keep read auth for source sync separate
from send auth plus send-as proof for replies. If provider-source rows were
duplicated by a repair or normalizer change, dry-run
`npm run repair:communication-source-dedup` and apply only reviewed duplicate
source groups.

## MCP Transport

`/speak/mcp` is MCP Streamable HTTP. MCP hosts must send an `Accept` header
that allows `text/event-stream`; a plain browser GET returning
`406 Not Acceptable` is the expected fail-closed response and does not mean the
ChatGPT/MCP app endpoint is missing.

Production endpoint: `https://speak.example.com/speak/mcp`.

## Which Surface To Use

| Need | Use |
| --- | --- |
| Render live operator UI | `render_speak_library`, `render_speak_dialer`, or `render_speak_configs` from `/speak/mcp` |
| Hydrate in a custom host | `/api/agent/host-client.mjs` |
| Search contacts, profiles, views, and threads | `search_workspace`; use this bounded action instead of `read_workspace` for global search |
| List/edit contacts | `read_workspace`, `list_leads`, `update_lead`, `bulk_update_lead_status` |
| Work with Smart Views | `list_smart_views`, `upsert_smart_view`, `import_smart_view_leads`, `sync_personal_phone_contacts`, `sync_calltools_campaign_contacts` |
| Work with profiles | `list_profiles`, `upsert_profile`, `sync_speak_config` |
| Send a human operator to configuration | `https://speak.example.com/speak/configs`; agents use profile/config actions instead of scraping it |
| Preflight CallTools Phone-as-Agent | `read_calltools_readiness` |
| Read voice/model choices | `read_speak_options`; preserve Hume/Inworld native groups separately from Codex-auth groups and keep xAI native-only |
| Attach knowledge | OpenAPI `upload_context_file`, then `update_lead` or `upsert_profile` with Contact Memory in `lead.context` or Agent Knowledge Layer content in `profile.context` |
| Place or end Speak-owned calls | `start_live_call`, `end_live_call` only after explicit operator/user intent |
| Watch live call UI | widget/host client/SSE, not generic action invocation |
| Review history | `read_communication_threads`, `read_communication_thread_messages`, `read_contact_communication_memory`; use `read_recent_calls` and `read_browser_config_tests` for raw call/test compatibility |
| Plan unified conversation work | [Communication thread model](communication-thread-model.md); calls, SMS, email, browser tests, and provider events converge into contact-scoped threads/messages |

## Generative UI Widget Design

The approved widget design is framework-neutral and documented in [Generative UI widgets](generative-ui-widgets.md). [BRANDING.md](BRANDING.md) is the visual-design authority, `src/index.css` owns exact token values, and `frontend.designSystem` exposes outside-agent pointers. Adapter/framework metadata must stay outside the operator-facing widget.

Visible widget rules:

- Desktop starts with `Library / Dialer / Playground`, then utility controls, context, action, queue/transcript/library content.
- Mobile renders nothing above `Library / Dialer / Playground`.
- The widget must use Helvetica Neue.
- The widget may expose Settings, but full configuration details should appear only on demand.
- Action controls remain stateful and proof-backed.

Frameworks should map into the same component model:

| Host/framework | Adapter path |
| --- | --- |
| ChatGPT Apps / MCP Apps | `/speak/mcp` render tools and widget resource metadata. |
| MCP UI | UI resource wrapper around the same Speak widget. |
| AG-UI | State/tool/proof events around the same widget state. |
| A2UI | Declarative component intents generated from Speak surfaces and actions. |
| Vercel AI SDK UI | Tool-result props passed into app-owned Speak React components. |
| Vercel JSON Render | Catalog-constrained JSON tree mapped to Speak components. |
| CopilotKit | Optional React sidecar/assistant host using Speak actions. |

Adapter manifests are exposed at `/api/agent/ui-adapter-kit.json`,
`/api/agent/mcp-ui.json`, `/api/agent/ag-ui.json`,
`/api/agent/a2ui.json`, `/api/agent/ai-sdk.json`,
`/api/agent/json-render.json`, and `/api/agent/copilotkit.json`.
Live snapshots are available through
`/api/agent/ui-snapshot.json?surface=library|dialer|configs`.

## Action Invocation

Production endpoint template:
`https://speak.example.com/speak/api/agent/actions/{actionId}/invoke`.
Direct `fetch` callers must send the explicit action envelope. Use the host
client when you want convenience argument normalization.

```ts
async function speakInvoke(actionId, input) {
  const response = await fetch(`/speak/api/agent/actions/${actionId}/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!response.ok) throw new Error(await response.text())
  return response.json()
}

const result = await speakInvoke('bulk_update_lead_status', {
  body: {
    ids: ['lead-orion', 'lead-northline'],
    status: 'follow-up',
  },
})
console.log(result.result.patched)
```

Mutating responses are proof objects. Never claim an action succeeded until the response contains the expected changed record, call state, sync version, or delivery receipt.

## Voice Runtime Model Rules

Profiles can use Hume, Inworld, or xAI as the realtime speech-to-speech runtime. The
model selector is intentionally one dropdown with separate route groups:

- `Hume native`, `Inworld native`, and `xAI native` are provider-owned runtime choices.
- Hume `Codex auth` mirrors the authenticated Codex catalogue. Inworld
  `Codex auth` is its live intersection with Inworld's model catalogue and
  preserves each selected model's supported reasoning catalogue. Inworld
  reasoning is fixed to `None` while shared tools are active because the
  provider rejects function tools combined with nonzero effort.
- xAI has no Codex-auth group because its Voice Agent session has no external-LLM hook.
- Fast mode applies to every returned Codex-auth choice. On Inworld it turns
  conversational TTS context off and uses `fast_start`.

Agents should use `read_speak_options` and `sync_speak_config` instead of raw
provider APIs so these routing rules, proof fields, and saved-profile state stay
consistent across the app, MCP, REST, and widgets.

## Contact Memory And Agent Knowledge Layer

Speak has two durable knowledge scopes:

| Scope | Field | Runtime behavior |
| --- | --- | --- |
| Contact Memory | `lead.context` | Injected only into future sessions involving that contact. |
| Agent Knowledge Layer | `profile.context` | Injected into future sessions using that saved profile. |

Runtime injection is compact. Full source content remains retrievable through `get_lead_context` and `get_contact_context` tools when relevant.

```ts
const attachment = await uploadContextFile(file)

await speakInvoke('update_lead', {
  path: { leadId: 'lead-orion' },
  body: {
    patch: {
      context: {
        text: 'Customer asked about onboarding details. Use this only when relevant.',
        urls: ['https://speak.split-llc.com/communication-thread-model.md'],
        files: [attachment],
      },
    },
  },
})
```

`upload_context_file`, `download_context_file`, and `delete_context_file` are documented in OpenAPI but intentionally not MCP/action-invocation callable. Use explicit file upload/download support from your host.

## Communication Threads And Inbox Direction

Agents should review deployed communication history with
`read_communication_threads`, `read_communication_thread_messages`, and
`read_contact_communication_memory`. `read_recent_calls` and
`read_browser_config_tests` remain available for raw call/test compatibility,
recording lookup, and pre-thread historical records. Inbound SMS/call
attribution, trusted email routing, and thread-aware contact conversation work use the
[Communication thread model](communication-thread-model.md).

Agent rules for that model:

- Treat `threadId` as the stable conversation identity; provider IDs such as
  call-control IDs, Telnyx message IDs, email thread IDs, Hume chat IDs, and
  Inworld session IDs are metadata.
- Keep calls, SMS, email, browser tests, operator chat, tool proof, recordings,
  and provider events in one contact-scoped message envelope.
- For CallTools-backed calls, review recording-derived transcript consistency with
  `npm run audit:calltools-recording-transcript` before claiming consistency. The
  recording-derived comparison is generated by Speak from the `/calls/`
  recording metadata and CallTools recording audio, not text supplied by
  CallTools. Use
  `npm run calltools:transcribe-recording` for a local recording file, or the
  audit's `--transcribeRecording` mode to download/transcribe the CallTools
  filesystem recording when `call_recording_fsfile_id` is available. Fresh calls
  can return `clean_pending` while CallTools finishes recording generation;
  live-call success still depends on Speak transcript turns and audible local
  CallTools WAV evidence. Use `npm run audit:calltools-recording-rhythm` when
  the agent needs provider timing evidence rather than a single-call recording
  comparison answer.
- Run `npm run qa:telnyx-source-routing` on the production host before treating
  SMS inbox/outbox or inbound-call source records as end-to-end configured.
  That check must prove provider routing and Speak-side Telnyx webhook
  signature enforcement are both enabled.
- If attribution is ambiguous, surface an unresolved thread for operator
  resolution. Do not attach inbound content to a contact by name-only matching.
- Auto-reply and inbound-call auto-answer remain default-none/default-off.
  Agents must not claim those actions happened unless backend proof shows an
  explicit policy authorized and completed them.
- `record_communication_event` is an internal provider-ingest action. It is
  record-only by default and may apply inbound SMS/email/call automation only
  when a trusted ingester explicitly sets `allowAutomation`.
- `send_communication_message` is for first-party operator reply/send UI. It
  sends real SMS/email, returns provider proof, and writes outbound messages
  back into communication threads. Do not expose it as an autonomous generic
  tool; SMS UI must retain a separate current-device `sms:` handoff path.
- `sync_workspace_email` is for trusted server/local maintenance only. It reads
  bounded Workspace/Gmail inbox/outbox results through the configured GOG
  wrapper/auth account, writes communication history under the configured
  workspace mailbox identity, remains non-MCP-callable, and disables inbound
  email automation unless `allowAutomation` is explicitly true. It must fail
  closed unless `/api/health` reports `delivery.emailSourceReadConfigured=true`.
  A different read auth account requires verified mailbox-read proof via
  `npm run qa:workspace-email-source` before
  `WORKSPACE_EMAIL_GOG_ACCOUNT_READS_MAILBOX=true` is trusted.
- The Workspace email webhook follows the same fail-closed rule: sent/received
  events are source records by default, and inbound email auto-reply runs only
  when the trusted ingester explicitly sets `allowAutomation: true` and
  contact, agent, or system context contains an explicit fixed-reply policy.
- Build runtime Contact Memory from compact thread/topic summaries and bounded
  recent messages, not full raw transcript/SMS/email injection by default.
- Keep Agent Knowledge Layer content in `profile.context`; do not merge it
  into contact conversation threads.

## Widget Bridge

```js
import { createSpeakAgentClient } from '/speak/api/agent/host-client.mjs'

const client = createSpeakAgentClient({ baseUrl: '/speak' })

await client.hydrateWidget('#speak-widget', {
  surface: 'dialer',
  limit: 12,
})

const connection = client.connectWidget('#speak-widget')
await client.invoke('read_workspace')

// Later, when the host removes the widget:
connection.dispose()
```

Bridge events include `speak:hydrate`, `speak:ready`, `speak:tool-call`, and `speak:follow-up`. The host client maps widget-originated tool calls to action invocation without bypassing backend authorization.

## High-Risk Actions

These require explicit user/operator intent and backend proof:

| Action | Why |
| --- | --- |
| `replace_leads`, `delete_lead`, `bulk_delete_leads` | Destructive contact-record mutation. |
| `replace_profiles`, `delete_profile` | Destructive profile mutation. |
| `start_live_call`, `start_phone_config_test` | Places real outbound calls. |
| `send_communication_message` | Sends real SMS/email from the Telnyx agent number or workspace email account. |
| `pause_agent_for_takeover`, `end_live_call` | Changes a live phone session. |
| `delete_context_file` | Removes a durable knowledge source. |

For `start_live_call` and `start_phone_config_test`, agents may pass only
`config.agentProfileId` or `config.agentProfileName` when the operator selected
a saved profile. The backend resolves the complete saved profile before provider
mutation and treats the direct-call route itself as the Speak/Telnyx transport
choice. A stored `dialerProvider=calltools` default does not block Browser or
Phone testing and is not rewritten. Playground Phone uses the operator-selected
Telnyx number without changing or claiming a CallTools campaign seat.

For CallTools campaign sources, use `sync_calltools_campaign_contacts` to pull
the configured source, then invoke `establish_calltools_agent_session` with
`ready=true`, `apply=true`, and explicit confirmation. That single backend
action activates/originates the selected native campaign and establishes its
campaign-agent, AgentStatus, and SIP session without a human dashboard login.
Use `read_calltools_readiness` plus live events for proof. Never use
`start_live_call` for CallTools; that action is only for explicit Speak/Telnyx
direct calls. CallTools retains native contact selection and dialing while any
complete saved Speak agent can receive its campaign invites through the durable
Available lease.

A CallTools production certification must use a native campaign call
handoff into Speak, caller/callee speech before the first agent turn, assistant
transcript/audio after that caller turn, and enough back-and-forth conversation
to prove both sides are registered. Generate a
`speak.calltools.campaign-proof.v1` artifact with
`qa:calltools-live-proof -- --require-complete --callControlId=<id>`, then pass
it with `audit:calltools-recording-transcript` for recording-derived review. Do not report raw SIP registration, CallTools call rows, recordings, or recording transcription alone as live engine success.

Do not call internal/provider routes: `codex_clm_chat_completion`, `phone_media_stream`, `phone_provider_webhook`, `voice_provider_webhook`, or raw provider APIs.

## UI Reference For Agents

Rendered desktop UI screenshots and page behavior are in [docs/ui-reference.md](ui-reference.md):

- `docs/assets/screenshots/library-contacts-light.png?v=fb0b5ffeae9e`
- `docs/assets/screenshots/library-contacts-dark.png?v=11e98f00118f`
- `docs/assets/screenshots/library-agents-light.png?v=5d0d4464804b`
- `docs/assets/screenshots/library-agents-dark.png?v=f663dddc0de4`
- `docs/assets/screenshots/library-activity-light.png?v=258ebcfce82d`
- `docs/assets/screenshots/library-activity-dark.png?v=1196ef32f4c5`
- `docs/assets/screenshots/dialer-light.png?v=e40cb2acf2b1`
- `docs/assets/screenshots/dialer-dark.png?v=70abd70f2faf`
- `docs/assets/screenshots/playground-light.png?v=d65127e68909`
- `docs/assets/screenshots/playground-dark.png?v=9b57423209ff`

Use these images for orientation only. For state, call the API.
