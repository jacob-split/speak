# Speak Operator Workflows

## MCP Tool Generation

1. Load the contract with `npm run --silent agent:contract` or `GET /api/agent/capabilities`.
2. Create one MCP tool per `backend.actions[]` item where `callableByMcp` is `true`.
3. Use the action `id` as the stable tool identifier.
4. Include `method`, `path`, `requestSchema`, `querySchema`, `pathSchema`, `risk`, `externalSideEffect`, `requiresHumanConfirmation`, `proof`, and `failureContract` in the MCP tool description.
5. For path templates like `/api/calls/{callControlId}/end`, require explicit path params and URL-encode them.
6. For high-risk mutations, use the host/operator authorization policy:
   - default: `authorizationMode: "confirm_each"`
   - preapproved session: `authorizationMode: "session_preauthorized"`
   - host says no prompt is needed: `authorizationMode: "no_permission_needed"`
   - high-autonomy aliases: `authorizationMode: "yolo"` or `"dangerously_approve_everything"`
   These modes change approval prompting only. They do not waive backend proof, failure contracts, destructive/open-world annotations, or recent-call/SSE readback.
7. After mutating live call state, read SSE events or `/api/calls/recent` to confirm the resulting phase/outcome.

For platform-neutral agents, use `npm run --silent agent:openapi` or
`GET /api/agent/openapi.json` for REST SDK generation, and
`npm run --silent agent:acp` or `GET /api/agent/acp` for ACP-style
discovery. Use `npm run --silent agent:app` or
`GET /api/agent/chatgpt-app.json` for the ChatGPT Apps manifest. All are
generated from the same action table. If the host cannot
mount MCP and does not want route-specific REST glue, call
`POST /api/agent/actions/{actionId}/invoke` with `{ path, query, body,
authorizationMode }`; the response envelope preserves the action's risk,
confirmation, proof, failure contract, transport status, and backend result or
error.

Do not expose these as general MCP tools:

- provider webhook routes
- `/media-stream`
- `/api/codex-clm/chat/completions`
- raw `/api/context-files` binary upload/download transport
- browser audio WebSockets unless building a dedicated audio client

## Generative UI And Widget Adapters

1. Read `generativeUi` in `/api/agent/capabilities` before choosing a widget integration.
2. Treat `generativeUi` as the neutral source of truth for widget surfaces, bridge capabilities, event model, and adapter guidance.
3. Read `BRANDING.md` and `docs/generative-ui-widgets.md` for the approved visible widget design before changing the widget shell.
4. Keep framework and adapter metadata outside the visible widget. Do not show framework headings, adapter panels, schema rails, host descriptions, or preview notices inside the operator frame.
5. Desktop widgets start at `Library / Dialer / Playground`; mobile widgets render nothing above that route selector.
6. Read `/api/agent/ui-adapter-kit.json` for concrete generic-host hydration messages, MCP UI resources, AG-UI event sequences, A2UI messages, Vercel AI SDK component props, Vercel JSON Render catalog data, and CopilotKit render/action glue.
7. Use `/api/agent/ui-snapshot.json?surface=library|dialer|configs` when a non-ChatGPT host needs current Speak data already materialized into generic-host, MCP UI, AG-UI, A2UI, Vercel AI SDK, Vercel JSON Render, and CopilotKit payloads.
8. Use `/api/agent/actions/{actionId}/invoke` when a non-MCP host needs to execute a backend action with proof metadata preserved in one canonical envelope.
9. Use `/api/agent/host-client.mjs` when a generic host wants dependency-free JavaScript for `createSpeakAgentClient`, then call `client.hydrateWidget()` and `client.connectWidget()` from that client.
10. Keep ChatGPT/OpenAI Apps support first-class: `/mcp`, registered widget resource, `_meta.ui.resourceUri`, `_meta["openai/outputTemplate"]`, and optional `window.openai` support.
11. For MCP Apps-compatible hosts, call `render_speak_library`, `render_speak_dialer`, or `render_speak_configs`; render the registered widget resource and hydrate it from `structuredContent` plus `_meta`.
12. For generic iframe/custom-element hosts, load `/api/agent/widgets/speak-operator.html` and use `generativeUi.genericHostBridge` / `speak.widget-postmessage.v1` for `speak:hydrate`, `speak:tool-call`, `speak:follow-up`, `speak:ready`, and `speak:state`. Verify message source, `source: "speak-widget"`, and schema version before acting on outbound widget messages.
13. For MCP UI hosts, start from `/api/agent/mcp-ui.json`, the widget resource, and the live snapshot's `mcpUi` payload.
14. For AG-UI-style frontends, start from `/api/agent/ag-ui.json`, the adapter kit's AG-UI event sequences, or the live snapshot's `agUi.events`; map Speak tool results, follow-up intents, approval interrupts, and widget state to event streams.
15. For A2UI-style declarative UI, start from `/api/agent/a2ui.json`, the adapter kit's A2UI messages, or the live snapshot's `a2ui.messages`; map `generativeUi.widget.surfaces` and `frontend.uiActions` into component intents while keeping backend actions authoritative.
16. For A2A-style agents, start from `/.well-known/agent-card.json` or `/.well-known/agent.json`; use its advertised MCP, OpenAPI, ACP, actionInvocation, hostClient, and generative UI interfaces for execution.
17. For Vercel AI SDK or other React generative UI hosts, start from `/api/agent/ai-sdk.json`, the adapter kit's AI SDK component props, or the live snapshot's `aiSdk.props`; expose Speak actions as model tools and pass returned `structuredContent` into the host's component system.
18. For Vercel JSON Render, start from `/api/agent/json-render.json`, constrain output to the Speak component catalog, and route resulting actions through the same proof-preserving Speak action IDs.
19. For CopilotKit, start from `/api/agent/copilotkit.json`; register only the listed Speak render components and proof-preserving actions.
20. Run `npm run qa:mcp-app`, `npm run qa:widget-bridge`, `npm run qa:ui-adapter-kit`, `npm run qa:ui-snapshot`, `npm run qa:action-invoke`, `npm run qa:host-client`, `npm run qa:agent-adapters`, `npm run qa:agent-readiness`, and `npm run qa:speak-agent-tier` after any MCP app, widget, render-tool, `authorizationMode`, actionInvocation, hostClient, or generative UI adapter change.

## UI Automation Contract

1. Read `frontend.uiActions` and `frontend.automation.stableTestIds` before choosing browser automation.
2. If a UI action has `backendActions`, prefer those headless actions unless the task is specifically visual or browser-only.
3. Use `data-action-id` to identify what a visible control does and `data-testid` to locate stable elements.
4. Use `frontend.automation.routeContracts[]` for required visible elements on `/dialer`, `/configs`, and `/library`.
5. Use `BRANDING.md`, `src/index.css`, and `frontend.designSystem.cssTokens` before introducing new dimensions, visual tokens, or control geometry.
6. Run `SPEAK_QA_BASE_URL=http://127.0.0.1:5173/speak npm run qa:ui-contract` after selector, topbar, shared-control, or layout changes.

## Runtime Preflight

1. Call `GET /api/health`.
2. Confirm `ok: true`.
3. If live calls are involved, require `configured: true`.
4. Check the returned runtime baseline: `useConfigPrompt`, `useConfigTools`, `autoStartGreeting`, codec, sample rate, verbose transcription, and delivery config.
5. Do not use older docs as runtime truth when `/api/health` disagrees.

## Communication History And Threads

1. Current deployed conversation state is read first through
   `/api/communication-threads`,
   `/api/communication-threads/{threadId}/messages`, and
   `/api/contacts/{contactId}/communication-memory`. Use
   `/api/calls/recent`, `/api/config-tests/recent`, call SSE, and audio-link
   routes for raw recording/audio compatibility and older pre-thread records.
2. Inbox, inbound SMS, inbound calls, email, or thread-aware contact conversation work must
   start from `docs/communication-thread-model.md`.
3. Normalize call transcript turns, SMS, email messages, browser tests,
   operator chat, tool proof, recordings, and provider events into
   `communicationThread` and `communicationMessage` records.
4. Keep provider IDs such as Telnyx message IDs, call-control IDs, Hume chat
   IDs, Inworld session IDs, and email thread IDs as metadata, not primary UI
   identity.
5. Use `contactIdentityLink` for inbound attribution. If phone/email/provider
   identity maps to multiple contacts, create or surface an
   unresolved-attribution thread instead of attaching by name or company alone.
6. Build runtime Contact Memory from compact thread/topic summaries and bounded
   recent messages; retrieve full messages only when the conversation needs
   them.
7. Run `npm run qa:communication-threads` after changing docs, schemas,
   contracts, widgets, or APIs that touch conversation history.

## Workspace Management

1. Read `GET /api/workspace` before changing contacts or saved profiles.
2. Manage contact records through legacy `/api/leads`: list, replace, create, import, patch, bulk status, and delete.
3. Manage saved profiles through `/api/profiles`: list, replace, upsert, set active, and delete.
4. Preserve returned proof such as `leads[]`, `lead.id`, `profiles[]`, and `activeProfileId`.
5. Manage durable contact knowledge in legacy `lead.context` and durable agent knowledge in `profile.context`.
6. For text and URLs, merge the existing context and persist it through `update_lead`, `upsert_profile`, or `replace_profiles`.
7. For files, upload the raw binary to `POST /api/context-files` with `x-speak-file-name` and `Content-Type`, review the returned `attachment.extractionStatus` and `attachment.contentChars`, then persist the returned attachment metadata in `context.files`.
8. To delete a context file, remove its attachment metadata from every contact/profile context first, then call `DELETE /api/context-files/{fileId}`.
9. Future sessions receive compact context inventory automatically; full file, URL, and prior-call content is retrieved by the runtime tools `get_contact_context` and `get_lead_context` when relevant.
10. Browser localStorage is only a migration/fallback cache. Do not use browser automation for routine headless contact or profile mutations.

## Live Call Control

1. Confirm the user explicitly authorized the live call action.
2. Call health and verify live-call config.
3. For a Speak/Telnyx direct call, call `POST /api/calls/start` with a contact payload and optional config/operator instructions. The route adapts the complete selected profile to `dialerProvider=speak` for that session without rewriting it.
4. Never call `/api/calls/start` to originate a native CallTools campaign call. Use Go available or `POST /api/calltools/agent-session`; any complete saved agent may be selected for either transport.
5. Treat `callControlId` as the first proof only.
6. Subscribe to `/api/calls/{callControlId}/events` or read `/api/calls/recent` for provider/state proof.
7. For live instructions, call `/instructions` and verify `ok: true` plus an event notice.
8. For hangup, call `/end` with an outcome and expect the backend to enforce the phone minimum duration.

## CallTools Campaign Following And Readiness

1. CallTools remains the native contact-selection and dialing authority; Speak never direct-dials a CallTools contact through `/api/calls/start`.
2. Select the intended saved Speak agent and CallTools campaign source, then use the Dialer **Go available** action. That single backend action activates/originates the selected campaign, establishes campaign-agent and AgentStatus state, registers SIP, and persists the durable lease across route changes, refreshes, closed tabs, and service restarts until **Go unavailable** completes. No human dashboard login is required.
3. Read `GET /api/calltools/readiness` for the selected profile. Require `campaignReady=true`, a matching durable lease, native `AgentStatus.ready=true`, selected-campaign binding, `webPhoneRegisteredOn`, `/campaignagents/{app_user_id}` readiness, campaign aggregate proof, and a healthy matching SIP gateway. `directStartReady` is legacy diagnostic output only and never authorizes `/api/calls/start`.
4. Start or release native CallTools campaign-agent state only through `POST /api/calltools/agent-session` with `apply=true` and `confirmAgentSession=true`, or the corresponding backend/headless helper. Do not use browser automation, dashboard login state, `Join Campaign`, or a browser-held webphone session as proof.
5. Once Available, wait for CallTools to route the next human-answer campaign invite. Confirm the live call is tied to the selected campaign/contact source, then verify live transcript events and communication-thread proof in Speak.
6. Ending one call must keep Speak Available for the next campaign call. **Go unavailable** is the only normal shared-seat release; require native `ready=false` and SIP unregistration before handing the account to the human agent.
7. For a non-live readiness audit, use `npm run qa:calltools-readiness -- --require-ready --pause-after-ready`; it may prove and release availability without placing a call.
8. After a completed native campaign call, run `npm run qa:calltools-live-proof -- --require-complete --callControlId=<id>` against the VM call log/audio. Require a `speak.calltools.campaign-proof.v1` artifact with selected-profile/campaign lease proof, caller speech, assistant transcript/audio after that caller turn, and live Speak transcript continuity.
9. Final certification uses `npm run qa:production-calltools-s-tier -- --liveProof=<proof.json>` and requires recording-derived review in or attached to that campaign proof. The reworked `qa:full-audit -- --include-live` may instead arm the selected lease and wait for the next native answered campaign invite; cleanup releases only the lease it armed. Removed direct/contact/answer-bot package aliases must not be used or reintroduced.

## Speak Profile Work

1. Read `/api/agent-configs/speak-options` to discover current configs, voices, and models.
2. Read `/api/agent-configs/speak/{configId}` before assuming profile prompt, voice, model, tools, or version.
3. Sync through `POST /api/agent-configs/sync-speak`; never move provider secrets to the client.
4. Confirm the response includes config identity/version/sync proof.
5. Test behavior through `/configs`, not by placing a phone call unless the user asked for a live-call test.

## Frontend Work

1. Read `AGENTS.md` and `BRANDING.md`; `BRANDING.md` is the visual-design authority and design.md-compatible checklist.
2. Inspect the relevant component and hook before editing.
3. Preserve the dialer as the primary work surface and `/configs` as the profile workshop.
4. Keep topbar, active-agent, Start/Stop, and transcript/test-panel geometry aligned with the documented contracts and component token recipes.
5. Keep `src/uiContract.ts` aligned with controls that agents need to discover.
6. Run lint/build/diff checks.
7. If selectors, topbar, shared controls, or layout changed, run `npm run qa:ui-contract`.
8. If UI changed, perform browser QA on desktop and phone `390 x 844`; check console errors and horizontal overflow.
9. If an outside host asks for DESIGN.md-style context, derive it from `BRANDING.md`, `src/index.css`, and `frontend.designSystem` rather than creating a second maintained source.
10. End clean: stop temporary dev servers/watchers, commit intentional changes
    unless explicitly told not to, and confirm `git status --short` is empty
    before final handoff.

## Backend Work

1. Keep Express IO boundaries in `server/index.mjs`.
2. Put reusable pure logic in focused modules, not in UI components.
3. Update `server/agent-contract.mjs` whenever routes, proof fields, or MCP-safe actions change.
4. Fail closed on delivery and provider actions: backend proof first, user-facing claim second.
5. Run syntax checks for changed backend files plus lint/build.
