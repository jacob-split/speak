# Speak Responsive UI Reference

This responsive UI reference documents the production browser surfaces across desktop and phone, and how each visible operator feature maps back to backend state or agent-callable APIs. The populated screenshots are desktop captures using synthetic contact data, not customer data; phone route chrome, Activity, composer, and mutation coverage is verified by `qa:ui-contract`.

Visual design authority lives in [BRANDING.md](BRANDING.md). Use
`src/index.css` for exact token values and `frontend.designSystem` from
`/api/agent/capabilities` for outside-agent token and component pointers. Do
not derive UI changes from generic design-system defaults when `BRANDING.md`
defines a Speak-specific rule.

## Page Map

| Page | Route | Primary job | Backend owner |
| --- | --- | --- | --- |
| Library | `/speak/library` | Contact database, Smart Views, CSV/Personal Phone/CallTools imports, agent reconciliation, transcript history, contact/profile context files. | `/api/workspace`, `/api/leads`, `/api/smart-views`, `/api/profiles`, `/api/context-files`, `/api/communication-threads`, `/api/calls/recent`, `/api/config-tests/recent` |
| Dialer | `/speak/dialer` | Live queue and transcript surface for outbound AI voice workflows, including Operator Takeover and Agent Whisper. | `/api/dialer-state`, `/api/calltools/agent-session`, `/api/calls/start`, `/api/calls/{callControlId}/events`, `/api/calls/{callControlId}/end` |
| Playground | `/speak/configs` | Saved agent profile editing, browser tests, explicit phone tests, Smart Config, settings. | `/api/profiles`, `/api/agent-configs/speak-options`, `/api/agent-configs/sync-speak`, `/api/config-tests/*`, `/api/smart-config/*` |

Agent-embeddable widgets expose Library, Dialer, and Playground through `render_speak_library`, `render_speak_dialer`, and `render_speak_configs`. The visible GenUI widget is chrome-free and starts with the `Library / Dialer / Playground` selector. See [Generative UI widgets](generative-ui-widgets.md).

## Library

Light:

![Populated Library contacts page, light mode](assets/screenshots/library-contacts-light.png?v=fb0b5ffeae9e)

Dark:

![Populated Library contacts page, dark mode](assets/screenshots/library-contacts-dark.png?v=11e98f00118f)

The Library page is the data workbench. The left rail owns mode selection, Smart Views, source controls, filters, sorting, column visibility, CSV import, Personal Phone sync, CallTools campaign contact sync, Smart View creation, and contact creation. The main surface owns row selection, editable contact fields, status changes, bulk status/delete, ordering, and Contact Memory expansion. The underlying API still uses legacy `lead` route/action names for contact records.

| Feature | UI location | Backend/API | Agent note |
| --- | --- | --- | --- |
| Contact table edit | Main database cells | `PATCH /api/leads/{leadId}` | Use `update_lead`; proof includes the returned contact record. |
| Add/import contacts | Left rail | `POST /api/leads`, `POST /api/smart-views/import` | The rendered CSV control imports a durable Smart View. `POST /api/leads/import` remains available for headless contact-import adapters. |
| Smart Views | Left rail | `GET/POST/DELETE /api/smart-views` | Use Smart View IDs in profile configs and dialer state. |
| Personal Phone contacts sync | Left rail | `GET /api/personal-phone/contacts`, `POST /api/personal-phone/contacts/sync` | Reads BlueBubbles contacts into the durable `source=personal-phone` contact source and returns source/readback proof. |
| CallTools campaign contacts sync | Left rail | `GET /api/calltools/campaign-contacts`, `POST /api/calltools/campaign-contacts/sync` | Reads the selected CallTools campaign live filter or bucket into the durable `source=calltools` contact source. The button uses the official CallTools mark asset and does not start or alter campaigns. Empty CallTools campaign inventory imports zero contacts with proof instead of showing fake rows. |
| Contact Memory | Row context expander | `PATCH /api/leads/{leadId}`, `POST /api/context-files` | `lead.context` is future-session context for that contact. |
| Agent Knowledge Layer | Agents mode | `PUT/POST /api/profiles`, `POST /api/context-files` | `profile.context` is global for future sessions using that profile. |
| Activity review | Activity mode | `GET /api/communication-threads`, `GET /api/communication-threads/{threadId}/messages`, `POST /api/communication-messages/send`, compatibility `GET /api/calls/recent`, `GET /api/config-tests/recent` | Activity renders one row per contact or unresolved-attribution thread, not one row per source event. It filters by the full `channels` source set. The row icon follows `latestChannel`, while the visible source label lists the full channel set with the latest channel first so source-filtered views do not show a misleading latest-only label. It also exposes explicit contact, agent, date, minimum call-time, and minimum-turn filters in the Activity rail, plus sort by date/contact/agent/call time/turns/source. It sorts by the most recent cross-source activity and fetches source-thread messages on expansion. When a thread links to legacy call/test records, expanded Activity merges those raw transcript turns so it matches Contact and Agent transcript content instead of stale materialized thread rows. Expanded Activity starts newest-first and uses the same transcript bubble renderer as Dialer linked source history and Playground linked source history: participant labels, fixed sender colors, copy/collapse/reply actions, and provider score strips when available. Sent/outbound agent or operator turns use the fixed dark bubble in every appearance; received/contact turns use the readback bubble, except contact/user-side SMS which is always iMessage blue. Sent/outbound SMS stays on the fixed sent/dark treatment. Email messages use fixed Speak purple, display subject-first, and expand for body copy. Received SMS/email can reply; SMS reply offers current-device SMS or backend Telnyx/Speak agent-number send. SMS inbox/outbox, Workspace sent/received webhook email, bounded Workspace/Gmail sync email, and missed inbound-call source records display through the same rows. Use persisted records as truth; do not infer from UI cache. |

### Agents Mode

Light:

![Populated Library agents page, light mode](assets/screenshots/library-agents-light.png?v=5d0d4464804b)

Dark:

![Populated Library agents page, dark mode](assets/screenshots/library-agents-dark.png?v=f663dddc0de4)

Agents mode is a derived reconciliation view over saved profiles, linked Smart Views, matched contacts, recent calls, transcript turns, recordings, outcomes, and context coverage. It does not duplicate transcript storage.

### Activity Mode

Light:

![Populated Library Activity page, light mode](assets/screenshots/library-activity-light.png?v=258ebcfce82d)

Dark:

![Populated Library Activity page, dark mode](assets/screenshots/library-activity-dark.png?v=1196ef32f4c5)

Activity mode combines phone-call attempts, SMS, email, and browser playground tests. Filters separate phone/SMS/email/playground, recording availability, scored/emotion coverage, and unresolved attribution.
Call and transcript timestamps render in the Speak operational timezone,
`America/New_York`, regardless of the browser, server, or provider UTC storage
timezone. For example, a provider timestamp of `2026-07-04T01:40:00Z` displays
as July 3, 2026 at 9:40 PM Eastern.

### Communication Threads

Contact chat, inbox, SMS, inbound call, email, and new transcript UI work
should use the [Communication thread model](communication-thread-model.md):
one contact-scoped timeline made from normalized messages across calls, SMS,
email, browser tests, operator chat, tool proof, recordings, and
provider events. Existing call/test history remains available for raw
recording/readback compatibility. Channel filters should be view controls, not
separate storage or separate primary panes.

Library Activity is the current thread-first operator surface. It renders one
row per contact or unresolved-attribution thread, sorts by latest activity,
supports source filters for phone, SMS, email, playground, recordings, scored
calls, and unresolved attribution, and labels multi-source rows with the latest
source first followed by the other channels present in the thread. It fetches
message bodies only when a row is expanded. Expanded Activity rows render the fetched full cross-source
message/turn list for that thread, with participant labels, fixed sender
colors, copy/collapse actions, and provider score strips when available
applied consistently across appearance modes. Any activity or transcript
source-history surface, including Library contact, agent, Activity, Dialer, and
Playground transcript/message bubbles, uses the same shared body pattern as
Playground. Linked source history also merges legacy raw call/test transcript
rows before rendering so older role-poor `system` backfill rows do not visually
split from the main transcript grammar. New inbox or one-pane chat UI should
build on that thread/message contract rather than reintroducing source-specific
lists.

Editable contact phone fields expose current-device call, current-device SMS,
and agent-number SMS where the field is editable. Editable contact email fields
expose workspace-email send. Backend SMS/email sends use
`POST /api/communication-messages/send`, return provider proof, and write the
outbound message into the durable thread. Current-device SMS is only a browser
handoff and should not be presented as backend proof.

## Dialer

Light:

![Populated Dialer page, light mode](assets/screenshots/dialer-light.png?v=e40cb2acf2b1)

Dark:

![Populated Dialer page, dark mode](assets/screenshots/dialer-dark.png?v=70abd70f2faf)

The Dialer is the live calling surface. It opens directly into the selected queue and transcript console. Speak/Telnyx uses the stateful Call/Stop/End flow. For CallTools, Go available starts the selected native campaign and agent session without a dashboard login, then holds the durable lease until Go unavailable. Each native SIP invite attaches to the same transcript surface; ending one call leaves the lease Available for the next invite. Operator Takeover and Agent Whisper keep the human operator close to the live conversation.

| Feature | UI location | Backend/API | Agent note |
| --- | --- | --- | --- |
| Queue source/agent/schedule | Center setup control | `GET /api/profiles`, `GET /api/smart-views`, `PATCH /api/dialer-state` | Persist source, selected contacts, queue IDs, and controller heartbeat. |
| Start Speak/Telnyx call | Transcript command area | `POST /api/calls/start` | High-risk; requires backend proof before claiming a call started. The route adapts any selected complete agent profile to Speak/Telnyx without changing its saved transport default. |
| Start/follow CallTools campaign | Transcript command area | `POST /api/calltools/agent-session`, native SIP invite | Go available activates/originates the selected campaign, establishes the selected profile's native agent/SIP session, and holds its server-owned lease until Go unavailable. CallTools then owns contact selection and dialing; Speak attaches each routed call. |
| Live transcript | Transcript panel | `GET /api/calls/{callControlId}/events` SSE | Streaming is not MCP-callable; use widget or host client for live UI state. |
| Operator Takeover | Transcript header | `POST /api/calls/{callControlId}/barge-in`, `POST /api/calls/{callControlId}/resume` | Proof must include call state. |
| Agent Whisper/live guidance | Transcript action path and agent-host actions | `POST /api/calls/{callControlId}/instructions`, `POST /api/operator-chat/turns` | Live call guidance uses `/instructions`; queued guidance attaches to the next call. `/api/operator-chat/turns` is for agent hosts, Playground/config edits, and generative UI flows, not a separate Dialer chat panel. |
| End call | Transcript header/action | `POST /api/calls/{callControlId}/end` | High-risk; phone hangup proof is required. |
| Device call | Command row | `tel:` handoff only | Must not call `/api/calls/start`; this is not agent-backed. |

## Playground

Light:

![Populated Playground page, light mode](assets/screenshots/playground-light.png?v=d65127e68909)

Dark:

![Populated Playground page, dark mode](assets/screenshots/playground-dark.png?v=9b57423209ff)

The Playground is the profile and test workspace. It edits saved profiles, syncs provider-backed configs, runs browser tests, and can start explicit phone-quality tests with a saved or ad hoc contact.

| Feature | UI location | Backend/API | Agent note |
| --- | --- | --- | --- |
| Profile select/add/save | Center configurator | `GET/PUT/POST /api/profiles` | Saved profile state is backend authoritative. |
| Prompt editor | Main prompt panel | `PUT/POST /api/profiles`, `POST /api/agent-configs/sync-speak` | Prompt text is profile instructions only; backend prepends guardrails at runtime. |
| Settings rail | Right details rail | `GET /api/agent-configs/speak-options`, `GET /api/phone-provider/options`, `GET /api/calltools/options`, `GET /api/calltools/readiness`, `POST /api/calltools/verify-agent`, `POST /api/calltools/provision-agent`, `POST /api/agent-configs/sync-speak` | Every field is documented in [configuration options](configuration-options.md). Speak phone-provider controls bind the selected Telnyx caller ID and Call Control connection from the active account catalog or env fallback numbers. Personal Phone missed-call routing is saved on the selected agent profile and can cover one entire explicit Personal Phone source or a narrower set of contacts and Smart Views; the same source cannot be enabled on two profiles. CallTools controls bind user, WebRTC phone, optional Web Call Back metadata, campaign/source, and queue account objects only; voice runtime and model selection remain Hume/Inworld/xAI settings. The profile selected in Dialer is authoritative; compatible shared-seat CallTools binding can be borrowed without changing that agent's voice runtime. The media-gateway row says `Configured` when the secret exists, `Healthy` or `Healthy live` when a non-stale gateway heartbeat is connected for the selected profile or its bound phone, and `Stale` when the latest gateway heartbeat has aged past the configured stale window; the detail line includes heartbeat age and sample rate when present. Readiness reports exact blockers for API, agent user, phone, gateway, campaign/source, dispositions, live calls, and outcome writeback without mutating CallTools. CallTools API read failures appear as `*_READ_FAILED` blockers with sanitized `readError` proof, not as false missing configuration. Top-level `ready` requires both runtime readiness and native CallTools campaign readiness, including backend AgentStatus readiness, selected campaign binding, webphone `webPhoneRegisteredOn` proof, per-agent `/campaignagents/{app_user_id}/` readiness, and matching campaign aggregate agent counts. |
| Browser test | Playground transcript | `POST /api/config-tests/start`, `POST /api/config-tests/{testId}/message`, `POST /api/config-tests/{testId}/end` | Does not place a phone call. |
| Phone test and supervision | Playground Call menu and bottom console | `POST /api/calls/start`, `WS /api/calls/{callControlId}/supervision`, `POST /api/calls/{callControlId}/barge-in`, `POST /api/calls/{callControlId}/resume`, `POST /api/calls/{callControlId}/instructions`, `POST /api/calls/{callControlId}/end` | Real outbound call through the explicitly selected Speak/Telnyx number and workspace Call Control connection. During the live Phone attempt, Spy plays both sides only in the operator browser; Barge replaces the agent with the preconnected operator microphone; typed console text and bounded microphone transcription are private Whisper guidance for the agent's next response. The supervision socket rejects Browser, Device, Personal Phone, and CallTools sessions. The transient test config forces `dialerProvider=speak`, so a CallTools-assigned profile never claims or mutates the campaign seat. |
| Smart Config | Playground composer mode | `GET /api/smart-config/session`, `GET /api/smart-config/conversations`, `GET /api/smart-config/conversations/{conversationId}`, `POST /api/smart-config/conversations`, `POST /api/smart-config/turns/stream`, `POST /api/smart-config/logout`, `GET /api/smart-config/oauth/start`, `GET /api/smart-config/oauth/callback` | Owner-only; not MCP/action callable. Profile-scoped Codex app-server thread history is read through the conversation endpoints, turns stream over SSE, and profile patching must return config/version proof. |

## UI Automation Handles

Stable route and action IDs live in `src/uiContract.ts`.

```ts
import { speakRouteIds, speakTestIds, speakActionIds } from './src/uiContract'

console.log(speakRouteIds.library) // "library"
console.log(speakTestIds.routeDialer) // "speak-route-dialer"
console.log(speakActionIds.routeToConfigs) // "route_to_configs"
```

Use `data-testid` and `data-action-id` selectors for browser QA across desktop and phone. Do not bind automation to visible copy. Phone readiness is part of the UI contract: route chrome, global search, appearance, Activity expansion, SMS/email composers, and Library mutations must keep passing `qa:ui-contract` before docs or product copy can claim the surface is current.
