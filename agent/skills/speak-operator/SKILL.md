---
name: speak-operator
description: Operate and modify the Speak outbound voice-agent app. Use when an agent needs to inspect, test, automate, build MCP tools for, or change the Speak frontend/backend, including phone call flows, agent profiles, Playground tests, contact queue behavior, transcripts, runtime health, deployment checks, and production verification.
---

# Speak Operator

Use this skill for Speak work in the authoritative Surface checkout at `/opt/speak`; the live runtime is `/opt/speak`.
Speak is revenue-critical call software: every action must map to a real backend route, browser state, or deployed runtime fact.

## First Read

1. Read `AGENTS.md`.
2. Read `BRANDING.md` before UI, layout, generated-widget, visual token, or responsive changes. It is the design.md-compatible visual authority; exact token values live in `src/index.css`.
3. Read the live/generated agent contract:
   - local command: `npm run --silent agent:contract`
   - OpenAPI command: `npm run --silent agent:openapi`
   - ACP command: `npm run --silent agent:acp`
   - ChatGPT app command: `npm run --silent agent:app`
   - generative UI command: `npm run --silent agent:genui`
   - readiness command: `npm run --silent agent:readiness`
   - server endpoint: `/api/agent/capabilities`
   - OpenAPI endpoint: `/api/agent/openapi.json`
   - ACP endpoint: `/api/agent/acp`
   - ChatGPT app manifest: `/api/agent/chatgpt-app.json`
   - agent readiness report: `/api/agent/readiness.json`
   - global generative UI manifest: `/api/agent/generative-ui.json`
   - UI adapter kit: `/api/agent/ui-adapter-kit.json`
   - live UI snapshot: `/api/agent/ui-snapshot.json?surface=library|dialer|configs`
   - proof-preserving action invocation: `/api/agent/actions/{actionId}/invoke`
   - generic host client: `/api/agent/host-client.mjs`
   - MCP UI manifest: `/api/agent/mcp-ui.json`
   - AG-UI manifest: `/api/agent/ag-ui.json`
   - A2UI manifest: `/api/agent/a2ui.json`
   - A2A Agent Card discovery: `/.well-known/agent-card.json` and `/.well-known/agent.json`
   - Vercel AI SDK generative UI manifest: `/api/agent/ai-sdk.json`
   - Vercel JSON Render manifest: `/api/agent/json-render.json`
   - CopilotKit manifest: `/api/agent/copilotkit.json`
   - ChatGPT MCP app endpoint: `/speak/mcp`
   - public endpoint when deployed: `/speak/api/agent/capabilities`
   - UI automation and visual-design contract: `frontend.uiActions`, `frontend.automation`, and `frontend.designSystem`
4. For production API/agent integration or context knowledge work, read `docs/agent-reference.md`.
5. For communication history, inbox, SMS, inbound-call, email, or Contact Memory work, read `docs/communication-thread-model.md`.
6. For GenUI widget work, read `docs/generative-ui-widgets.md`.
7. For workflow details, read `references/workflows.md` only for the task area you need.

## Rules

- Start clean and end clean for every Speak task. Check `git status --short`
  before editing. Before final handoff, stop temporary dev servers/watchers,
  commit intentional changes unless explicitly told not to, rerun
  `git status --short`, and do not finish with uncommitted task files or running
  local processes.
- Treat `/api/agent/capabilities` as the source of truth for MCP-safe actions, proof fields, risk, and blocked routes.
- Use `/api/agent/openapi.json` for generic REST agents and SDK generation, and `/api/agent/acp` for ACP-style discovery.
- Use `generativeUi` and `agentAdapters` as the platform-neutral widget contract. ChatGPT/OpenAI Apps, MCP Apps, iframe/custom-element hosts, MCP UI, AG-UI, A2UI, A2A Agent Card discovery, Vercel AI SDK, Vercel JSON Render, and CopilotKit should adapt from that layer instead of inventing new action names.
- Keep operator-facing GenUI widgets chrome-free. Do not render framework headings, adapter panels, schema rails, host descriptions, or preview notices inside the widget. Desktop starts at `Library / Dialer / Playground`; mobile renders nothing above that route selector.
- Use `BRANDING.md` plus `frontend.designSystem` as the visual source of truth. If a host asks for DESIGN.md-style context, derive it from `BRANDING.md` and `src/index.css`; do not maintain a separate manual design source.
- Use `/api/agent/ui-adapter-kit.json` for concrete generic-host, MCP UI, AG-UI, A2UI, Vercel AI SDK, Vercel JSON Render, and CopilotKit envelopes before writing platform-specific adapter glue.
- Use `/api/agent/ui-snapshot.json?surface=library|dialer|configs` when a non-ChatGPT host needs current Speak data already materialized into generic-host, MCP UI, AG-UI, A2UI, Vercel AI SDK, Vercel JSON Render, and CopilotKit envelopes.
- Use `/api/agent/actions/{actionId}/invoke` when a non-MCP host needs one platform-neutral action transport. It accepts `{ path, query, body, authorizationMode }`, invokes only callable REST actions, and returns the same risk, confirmation, proof, failure, and transport metadata as the contract.
- Use `/api/agent/host-client.mjs` when a browser, iframe, web-component, or server-side JavaScript host needs dependency-free glue for discovery, snapshots, widget hydration, bridge events, and action invocation.
- Use `/mcp` as the ChatGPT/MCP Apps endpoint. Keep ChatGPT-specific value paths intact: widget resource metadata, `_meta["openai/outputTemplate"]`, and optional `window.openai` support.
- For generic iframe/custom-element hosts, use `generativeUi.genericHostBridge` and `speak.widget-postmessage.v1` instead of requiring ChatGPT-only `window.openai` APIs. Verify message source, `source: "speak-widget"`, and schema version before acting on outbound widget messages.
- Generate MCP tools only from contract actions with `callableByMcp: true`.
- High-risk tools may accept `authorizationMode`: `confirm_each`, `session_preauthorized`, `no_permission_needed`, `yolo`, or `dangerously_approve_everything`. These modes affect approval prompts only; backend proof and failure contracts still apply.
- Preserve confirmation text for high-risk live-world mutations: live calls, hangups, human takeover, deletes, and outbound delivery. Speak profile sync is proof-gated but should not have an extra confirmation blocker.
- Never expose provider secrets, env values, raw credentials, or private call data in client code, screenshots, docs, or MCP tool output.
- Never claim a call, SMS, email, portal link, hangup, Speak profile sync, or live instruction succeeded until the backend returns proof.
- Do not call provider webhooks, media sockets, or the Codex CLM endpoint as general MCP tools.
- Use `/configs` for browser Playground tests and explicit phone-quality tests. Browser tests never place real phone calls; phone-quality tests use the live call route and require the same proof as dialer calls. Playground Phone tests use the selected Speak/Telnyx caller ID and workspace Call Control connection while preserving the selected profile's Hume/Inworld and native/Codex-auth settings; do not use or mutate a CallTools campaign seat for this test path.
- Use `/api/workspace`, `/api/leads`, `/api/smart-views`, and `/api/profiles` for headless contact, Smart View, and profile work. Browser automation is for visual QA or UI-only state.
- Use `lead.context` and `profile.context` for durable context knowledge. Text and URLs are JSON-editable through workspace actions. Files are direct binary REST uploads to `/api/context-files`; persist the returned attachment metadata through `update_lead` or `upsert_profile`.
- Use `docs/communication-thread-model.md` for communication history. Calls, SMS, email, browser tests, operator chat, tool proof, recordings, and provider events must converge into contact-scoped `communicationThread` / `communicationMessage` records. Do not add channel-specific history stores for the same customer conversation.
- Inbound SMS, inbound calls, and email require verified `contactIdentityLink` attribution. Ambiguous matches become unresolved-attribution threads instead of attaching content by name or company alone.
- Use stable `data-testid` and `data-action-id` values from `src/uiContract.ts` and the contract's `frontend.automation.stableTestIds` for browser automation. Prefer mapped backend actions from the contract when a task can be done headlessly.

## Workflows

Use the smallest proof path:

- Runtime state: call `GET /api/health`, then compare live values against the contract baseline.
- Workspace state: call `GET /api/workspace`, then mutate through `/api/leads`, `/api/smart-views`, or `/api/profiles` and require returned proof.
- Context knowledge: upload files directly to `/api/context-files`, review extraction proof, attach returned metadata through `update_lead` or `upsert_profile`, and rely on `get_contact_context` / `get_lead_context` for full runtime retrieval.
- Call review: call `GET /api/calls/recent`, then inspect the relevant SSE/audio route only when needed.
- Communication history: read current thread state through `GET /api/communication-threads`, `GET /api/communication-threads/{threadId}/messages`, and `GET /api/contacts/{contactId}/communication-memory` first. Use recent call/config-test history only for raw recording/audio compatibility and older pre-thread records. Inbox, SMS, inbound-call, email, and thread-aware contact conversation work must follow `docs/communication-thread-model.md`.
- Live call control: start with health, perform the authorized mutation, then read SSE or recent-call proof.
- Speak profile work: read `/api/agent-configs/speak-options`, sync through `/api/agent-configs/sync-speak`, then read the returned config ID/version proof.
- CallTools campaign operation: use backend/headless `calltools:agent-session` (the Dialer Go available path) to activate/originate the selected native campaign and establish its agent/SIP session without dashboard login. Verify with `qa:calltools-readiness`, then observe the native campaign invite, live transcript, and communication-thread proof. Never use `/api/calls/start` to originate a native CallTools campaign call; that route intentionally adapts any selected complete profile to Speak/Telnyx. Generate `speak.calltools.campaign-proof.v1` from the completed campaign call with `qa:calltools-live-proof`; removed direct/contact/answer-bot proof helpers must not be used or reintroduced.
- Frontend changes: inspect existing components, follow `BRANDING.md` token/component recipes, keep the Library/Dialer/Playground geometry contracts, run lint/build, then use browser QA when UI changed.
- Backend changes: keep orchestration out of `App.tsx`, keep pure call-state logic out of `server/index.mjs`, and run targeted syntax plus runtime checks.

## Verification

Before final handoff, follow the `AGENTS.md` Clean Start / Clean End checklist
in addition to the targeted checks below.

Always run for code changes:

```sh
npm run lint
npm run build:speak
git diff --check
```

For agent-contract changes also run:

```sh
npm run --silent agent:contract
node --check server/agent-contract.mjs
```

For MCP app, widget, or generative UI adapter changes also run:

```sh
npm run qa:mcp-app
npm run qa:communication-threads
npm run qa:widget-bridge
npm run qa:ui-adapter-kit
npm run qa:ui-snapshot
npm run qa:action-invoke
npm run qa:host-client
npm run qa:agent-adapters
npm run qa:agent-readiness
npm run qa:speak-agent-tier
```

For UI selector/layout contract changes also run:

```sh
SPEAK_QA_BASE_URL=http://127.0.0.1:5173/speak npm run qa:ui-contract
```

For backend call-path changes add:

```sh
node --check server/index.mjs
npm run qa:transport
curl -fsS https://speak.example.com/speak/api/health
```
