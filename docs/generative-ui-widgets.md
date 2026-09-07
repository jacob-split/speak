# Speak Generative UI Widgets

This page documents the approved GenUI direction for Speak widgets across ChatGPT Apps, MCP Apps, MCP UI, AG-UI, A2UI, Vercel AI SDK UI, Vercel JSON Render, CopilotKit, iframe, and custom-element hosts.

## Approved Direction

Use one Speak-owned widget design and adapt it to host frameworks through metadata, events, or declarative envelopes. The operator-facing widget should not expose adapter labels, framework headings, manifest details, or implementation panels.

The visible widget starts with the route controls:

- `Library`
- `Dialer`
- `Playground`

Everything visible after that must be part of the user workflow: search, appearance, settings, current call/list/profile context, one stateful primary action, queue/list rows, transcript/test chat, library records, or compact proof state.

## Visual Rules

- Follow [BRANDING.md](BRANDING.md) as the visual-design authority. Use
  `src/index.css` for exact token values and `frontend.designSystem` for
  outside-agent token and component pointers.
- Use Helvetica Neue for generated widgets.
- Do not show a page title, marketing header, framework name, adapter panel, schema rail, or instructional notice inside the operator widget.
- Desktop should render the widget window only: route selector at the top, utility controls to the right, then context and work surface below.
- Mobile should render nothing above the `Library / Dialer / Playground` route controls.
- Settings are available through a compact control and may expand only on demand.
- The primary action is stateful: `Call` becomes `End call`; `Start test` becomes `Stop test`.
- Proof is compact and secondary. It must never claim success without backend proof.
- Host/framework differences belong in generated manifests, adapter kits, bridge messages, docs, or QA output, not in the operator-facing widget.

## Canonical Widget State

All frameworks should render from the same widget state shape:

| State area | Purpose |
| --- | --- |
| `surface` | `library`, `dialer`, or `configs`; the visible `configs` label is Playground. |
| `authorizationMode` | Approval policy only; never waives backend proof. |
| `callTarget` | Individual contact or Smart View/list being called or tested. |
| `agentConfig` | Selected profile/config name plus compact runtime/settings summary. |
| `transcript` | Live, saved, or playground turns with participant labels from call context. |
| `communicationThreads` | Contact-scoped thread summaries and cursor hints for calls, SMS, email, tests, tool proof, recordings, and provider events. |
| `library` | Smart View/source, mode, records, bulk state, context/transcript availability. Source controls include CSV import, Personal Phone contacts sync, and CallTools campaign live-filter or bucket contact sync as contact sources; Smart Views filter inside the selected source. |
| `availableActions` | Real Speak action IDs, risk, confirmation, and proof requirements. |
| `proof` | Backend proof fields returned after a mutation or safe readback. |

Widgets should render a one-pane contact conversation from
`communicationThreads` plus fetched messages rather than adding separate call,
SMS, or email timelines. Keep compact summaries in model-visible
`structuredContent`; put full messages in `_meta` or fetch-on-open payloads.
Thread message widgets preserve the web app channel grammar: received contact
SMS is always blue, sent SMS uses the fixed sent/dark treatment, email uses the
fixed Speak purple treatment with subject-only previews and collapsed
rendering, and received SMS/email reply controls distinguish current-device
handoff from backend provider-proof sends.
Widget `structuredContent.health.delivery` exposes bounded readiness booleans
for SMS backend send, Workspace email read/send auth, and Workspace email
send-as proof. Widgets must use those booleans to disable or annotate backend
SMS/email send affordances; current-device SMS handoff remains separate because
it does not return backend proof.
See [Communication thread model](communication-thread-model.md).

## Framework Mapping

ChatGPT Apps and MCP Apps use the `/speak/mcp` MCP Streamable HTTP endpoint.
Hosts must accept `text/event-stream`; a plain browser GET returning
`406 Not Acceptable` is expected and should not be treated as a broken widget
resource.

| Framework | Speak role | Visible UI impact |
| --- | --- | --- |
| ChatGPT Apps / MCP Apps | Primary MCP render-tool host using widget resources and `_meta["openai/outputTemplate"]`. | None beyond mounting the same widget. |
| MCP UI | Portable MCP UI resource wrapper. | None beyond mounting the same widget. |
| AG-UI | Event stream adapter for state snapshots, transcript deltas, tool calls, approval, and proof. | None beyond live state updates. |
| A2UI | Declarative component-intent adapter. | None beyond rendering the same component hierarchy. |
| Vercel AI SDK UI | Tool result to app-owned React component mapping. | None beyond rendering the same component props. |
| Vercel JSON Render | Catalog-constrained JSON tree mapped to Speak components. | None beyond rendering the same catalog components. |
| CopilotKit | Optional React assistant/sidecar consumer. | None unless a separate Copilot host wraps the widget. |

Do not use open-ended GenUI for Speak. The model may choose or hydrate a surface, but it must not invent arbitrary controls, arbitrary component code, or action names.

## Production Status

The production contract now exposes all three operator surfaces through the
same widget resource:

- `render_speak_library`
- `render_speak_dialer`
- `render_speak_configs`

Framework-specific endpoints are generated from `server/agent-contract.mjs` and
all hydrate the same Speak-owned component model:

- `/api/agent/mcp-ui.json`
- `/api/agent/ag-ui.json`
- `/api/agent/a2ui.json`
- `/api/agent/ai-sdk.json`
- `/api/agent/json-render.json`
- `/api/agent/copilotkit.json`
- `/api/agent/ui-adapter-kit.json`
- `/api/agent/ui-snapshot.json?surface=library|dialer|configs`

## Preview

The original approval prototype is intentionally sample-data-only:

- HTML: `design-previews/genui-framework-widgets/index.html`
- Desktop Dialer: `design-previews/genui-framework-widgets/screenshots/desktop-dialer.png`
- Desktop Playground: `design-previews/genui-framework-widgets/screenshots/desktop-playground.png`
- Desktop Library: `design-previews/genui-framework-widgets/screenshots/desktop-library.png`
- Mobile Dialer viewport: `design-previews/genui-framework-widgets/screenshots/mobile-dialer-viewport.png`
- Mobile widget capture: `design-previews/genui-framework-widgets/screenshots/mobile-first-widget.png`

The preview buttons update local state only. They do not place calls, send messages, sync profiles, import contacts, or mutate the workspace.

The production widget resource is also captured with sanitized fixture data:

- Desktop Library: `design-previews/chatgpt-genui-test/screenshots/production-widget-library-desktop.png`
- Desktop Dialer: `design-previews/chatgpt-genui-test/screenshots/production-widget-dialer-desktop.png`
- Desktop Playground: `design-previews/chatgpt-genui-test/screenshots/production-widget-playground-desktop.png`
- Mobile Dialer: `design-previews/chatgpt-genui-test/screenshots/production-widget-dialer-mobile.png`

## Implementation Notes

Production implementation keeps `server/agent-contract.mjs` as the canonical
action and adapter contract, with `server/speak-mcp.mjs` rendering the same
clean widget shell.

1. Preserve render tools for every primary route: `render_speak_library`, `render_speak_dialer`, and `render_speak_configs`.
2. Keep the render tools' `structuredContent` compact and model-visible.
3. Put larger widget-only hydration under `_meta`.
4. Keep action execution proof-backed through MCP tools or `/api/agent/actions/{actionId}/invoke`.
5. Keep adapter-specific details in `/api/agent/generative-ui.json`, `/api/agent/ui-adapter-kit.json`, `/api/agent/ui-snapshot.json`, `/api/agent/mcp-ui.json`, `/api/agent/ag-ui.json`, `/api/agent/a2ui.json`, `/api/agent/ai-sdk.json`, `/api/agent/json-render.json`, `/api/agent/copilotkit.json`, and `/api/agent/host-client.mjs`.
6. Readiness must not pass unless Library, Dialer, and Playground are all represented.

## Verification

For prototype-only changes:

```sh
node --check /dev/stdin < <(perl -0777 -ne 'print $1 if /<script>(.*)<\/script>/s' design-previews/genui-framework-widgets/index.html)
git diff --check -- design-previews/genui-framework-widgets/index.html docs/generative-ui-widgets.md
```

For production widget or adapter changes:

```sh
npm run qa:brand-marketing
npm run qa:mcp-app
npm run qa:voice-provider-process
npm run qa:voice-configs
npm run qa:communication-threads
npm run qa:widget-bridge
npm run qa:ui-adapter-kit
npm run qa:ui-snapshot
npm run qa:action-invoke
npm run qa:backend-api -- --baseUrl=https://speak.example.com/speak --json
npm run qa:host-client
npm run qa:agent-adapters
npm run qa:agent-readiness
npm run qa:speak-agent-tier
```

`qa:agent-adapters` must reject generated manifest endpoints that still contain
scaffold hosts such as `your-public-host.example.com`. Production adapter
verification is not complete until every generated endpoint resolves from the
real Speak public base URL and `qa:backend-api` has live-probed every documented public agent/adapter manifest, widget HTML, and host client endpoint on the deployed `/speak` surface.

For widgets that expose SMS, email, or inbound-call source history, also run
`npm run qa:telnyx-source-routing`, `npm run qa:workspace-email`, and
`npm run qa:workspace-email-source` on the production host before claiming
end-to-end source readiness. Workspace email readiness must prove read auth
source visibility separately from send auth and send-as reply proof. If source
history shows duplicate rows for the same native provider event, run
`npm run repair:communication-source-dedup` first and apply only reviewed
provider-source groups.

For visual QA, always check desktop and mobile `390 x 844` and confirm there is no document-level horizontal overflow.
