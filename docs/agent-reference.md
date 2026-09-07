# Speak Production Agent Reference

Speak is designed for portable agent integration: any supported framework should be
able to discover the same capabilities, choose its preferred transport, and keep
the same proof and safety semantics without a bespoke adapter.

## Source Of Truth

Start from the generated contract:

```sh
npm run --silent agent:contract
npm run --silent agent:openapi
npm run --silent agent:acp
npm run --silent agent:app
npm run --silent agent:genui
npm run --silent agent:readiness
npm run --silent agent:ui-kit
npm run --silent agent:ui-snapshot
```

Runtime endpoints are available under `/api/agent/*`; production uses the
`https://speak.example.com/speak` origin. Start discovery from
`https://speak.example.com/speak/api/agent/capabilities`.
The generated readiness report uses schema `speak.agent-readiness.v1`; the
current passing production contract reports `readinessLevel=s-class-candidate`,
`overallStatus=pass`, and zero failed checks. Any failed check drops the report
to `readinessLevel=needs-work` / `overallStatus=fail`.

Use these lanes:

- Documentation entry point: `docs/index.md`.
- Visual-design authority: `BRANDING.md`; exact token values live in
  `src/index.css` and the generated `frontend.designSystem` contract.
- UI and screenshot reference: `docs/ui-reference.md`.
- Backend/API reference: `docs/backend-api-reference.md`.
- Configuration flags and profile options: `docs/configuration-options.md`.
- Agent-only implementation guide: `docs/agent-integration.md`.
- ChatGPT or MCP Apps: `/speak/mcp`, render tools, and widget resource metadata.
  This endpoint is MCP Streamable HTTP: hosts must accept `text/event-stream`,
  and a plain browser GET returning `406 Not Acceptable` is expected.
- Generic REST or SDKs: `/api/agent/openapi.json`.
- ACP-style routing: `/api/agent/acp`.
- Generative UI manifest: `/api/agent/generative-ui.json`.
- Non-MCP action execution: `POST /api/agent/actions/{actionId}/invoke`.
- Browser, iframe, or custom-element hosts: `/api/agent/host-client.mjs`.
- MCP UI, AG-UI, A2UI, A2A, Vercel AI SDK, Vercel JSON Render, and CopilotKit hosts: the matching `/api/agent/*` manifests plus `/api/agent/ui-adapter-kit.json` and `/api/agent/ui-snapshot.json?surface=library|dialer|configs`.

## Action Rules

Generate callable tools only from `backend.actions[]` where
`callableByMcp: true`. Preserve each action's `risk`,
`requiresHumanConfirmation`, `externalSideEffect`, `proof`, and
`failureContract`.

Do not expose provider webhooks, media sockets, Codex CLM callbacks, or raw
binary context file transport as generic tools. Direct routes may still be
documented in OpenAPI when they are part of a supported headless workflow.

Voice profile work must preserve Speak's runtime model routing:

- Hume, Inworld, and xAI are separate realtime speech-to-speech runtimes.
- Provider-native model choices stay separate from `Codex auth` choices in the
  same model selector.
- Hume Codex-auth choices mirror the authenticated Codex catalogue. Inworld
  Codex-auth choices are its live intersection with Inworld's model catalogue
  and preserve each model's supported reasoning catalogue. Inworld reasoning
  is fixed to `None` while shared tools are active because the provider rejects
  function tools combined with nonzero effort.
- Fast mode applies to every returned Codex-auth choice. On Inworld it turns
  conversational TTS context off and uses `fast_start`.
- xAI exposes only native Voice Agent models and its live built-in/custom voice
  catalogue because xAI Realtime has no external-LLM hook.

High-risk calls may include `authorizationMode`, but that changes approval
prompting only. It never waives backend proof.

## Contact Memory And Agent Knowledge Layer

Contact Memory and Agent Knowledge Layer content lives in the workspace records:

```json
{
  "context": {
    "text": "Operator-authored notes",
    "urls": ["https://files.split-llc.com/speak/agent-reference.md"],
    "urlSnapshots": [],
    "files": []
  }
}
```

Use `lead.context` for contact-specific knowledge and `profile.context` for agent-wide knowledge. Future live calls and browser tests resolve the stored contact/profile context, refresh URL snapshots with bounded timeouts, inject a compact source inventory into the session, and expose full source contents through `get_contact_context` / `get_lead_context` when relevant.

Text and URLs are JSON-editable through:

- `update_lead` for Contact Memory.
- `upsert_profile` or `replace_profiles` for profile context.

Files use a two-step direct REST workflow because uploads are raw binary, not
JSON actionInvocation payloads.

The contract action handles are `upload_context_file`, `download_context_file`,
and `delete_context_file`. They are documented for OpenAPI/direct REST clients
and intentionally not marked `callableByMcp`.

1. Upload the file:

```sh
curl -fsS -X POST "$SPEAK_ROOT/api/context-files" \
  -H "x-speak-file-name: underwriting-notes.pdf" \
  -H "Content-Type: application/pdf" \
  --data-binary @underwriting-notes.pdf
```

2. Review the returned `attachment.id`, `attachment.extractionStatus`, and
`attachment.contentChars`.

3. Read the current contact/profile, merge the new attachment into
`context.files`, then persist it with `update_lead` or `upsert_profile`.

4. Verify proof from the mutation response and, before a call/test, read the
workspace or start-session result to confirm the expected contact/profile context is
selected.

To remove a file, remove its metadata from every contact/profile context first,
then call `DELETE /api/context-files/{fileId}`. Download original files only
from trusted contexts through `GET /api/context-files/{fileId}/download`.

Never put secrets, private credentials, or provider tokens in context text,
URLs, filenames, or uploaded files.

## Communication Thread Contract

The implemented history model is
[docs/communication-thread-model.md](communication-thread-model.md). Production
readback should use `read_communication_threads`,
`read_communication_thread_messages`, and
`read_contact_communication_memory` first. `read_recent_calls` and
`read_browser_config_tests` remain compatibility surfaces for raw call/test
summaries, recordings, and older records.

Agent-facing expectations:

- Use one contact-scoped `communicationThread` plus `communicationMessage`
  envelope for call transcript turns, SMS, email, browser tests,
  operator chat, tool proof, recordings, and provider events.
- Keep provider IDs in `providerLinks` / `providerIds`; do not make Hume,
  Inworld, Telnyx, or email IDs the primary UI identity.
- Treat `docs/backend-api-reference.md`, `server/agent-contract.mjs`, and
  `server/index.mjs` as one contract. `npm run qa:backend-api` must pass before
  claiming backend API continuity or changing an endpoint path.
- For CallTools-backed calls, do not infer recording-derived transcript consistency from packet counts
  or CallTools recording lag. Run
  `npm run audit:calltools-recording-transcript` against the production call log;
  when a recording reference is present, use the audit `--transcribeRecording`
  mode to download/transcribe the CallTools recording and create the
  recording-derived transcript to compare against Speak turns. No CallTools text
  artifact is part of this path. Use
  `npm run calltools:transcribe-recording` only when a local recording file must
  be supplied manually. If the call is fresh and still inside
  `CALLTOOLS_RECORDING_LAG_GRACE_MS`, missing CallTools recording
  metadata is pending provider evidence; it does not replace the required live
  Speak transcript and local WAV audibility proof. Use
  `npm run audit:calltools-recording-rhythm` when checking CallTools
  account-level recording timing. The recording-derived comparison path is the
  transcript generated by Speak from CallTools recording audio, not text
  supplied by CallTools.
- Use `contactIdentityLink` attribution before routing inbound SMS/calls/email
  into a contact thread. Ambiguous matches stay unresolved until an operator or
  trusted workflow resolves them.
- Treat SMS and inbound-call source routing as production-ready only after
  `npm run qa:telnyx-source-routing` passes on the production host. That check
  must confirm the configured Speak number, Telnyx messaging profile, Call
  Control application, webhook URLs, and Telnyx webhook signature enforcement
  are all aligned with Speak production.
- `send_communication_message` / `POST /api/communication-messages/send` is a
  high-risk first-party UI send route, not an MCP-callable autonomous tool.
  Received-message reply UI may use it after operator input; SMS must also keep
  a current-device `sms:` handoff option that does not imply backend proof.
  First-party and widget UIs must read `/api/health` before enabling backend
  delivery. Backend SMS send requires `delivery.smsConfigured=true`; Workspace
  email send requires `delivery.emailConfigured=true` and
  `delivery.emailSendAsConfigured=true`.
- `sync_workspace_email` / `POST /api/workspace-email/sync` is high-risk,
  internal maintenance only. It reads bounded Gmail inbox/outbox results through
  the configured GOG wrapper/read auth account and writes communication history
  under the configured workspace mailbox identity; it is not an MCP or autonomous
  agent action, and sync apply disables inbound email automation unless
  `allowAutomation` is explicitly true. Apply must preflight
  `delivery.emailSourceReadConfigured=true`; if the read auth account differs
  from the mailbox, `WORKSPACE_EMAIL_GOG_ACCOUNT_READS_MAILBOX` is valid only
  after `npm run qa:workspace-email-source` proves mailbox participant visibility.
- `record_communication_event` / `POST /api/communication-events` is high-risk
  internal provider intake only. It records inbound SMS/email/call
  no-automation proof by default; `allowAutomation` may be used only by trusted
  ingesters when explicit contact, agent, or system policy should be honored.
- Do not infer permission to auto-reply or auto-answer from vague prompt text.
  SMS/email actions stay default-none unless a server-owned fixed-reply policy
  explicitly authorizes them in contact context, agent context, or system env.
  Unresolved-attribution messages block auto-send and auto-answer. Inbound
  call auto-answer stays default-off unless explicit policy authorizes Telnyx
  answer with Speak's bidirectional media stream and backend proof.
- Runtime Contact Memory should use compact thread/topic summaries by default
  and retrieve full messages only when relevant.

## Headless Workspace

Use backend-owned state for routine work:

- `read_workspace`: full current workspace.
- `list_leads`, `create_lead`, `import_leads`, `update_lead`, contact bulk actions.
- `list_smart_views`, `upsert_smart_view`, Smart View import/sync/delete.
  `sync_calltools_campaign_contacts` pulls CallTools campaign live-filter or
  bucket contacts into the durable `source=calltools` contact source with campaign/contact
  proof and does not start or mutate a campaign.
- `list_profiles`, `upsert_profile`, `set_active_profile`, profile delete/replace.
- `read_calltools_readiness` for CallTools Phone-as-Agent preflight. It is
  read-only and reports exact transport/campaign blockers. Treat
  `directStartReady` as legacy diagnostic output only; it never authorizes
  `/api/calls/start`, which rejects CallTools transport before provider
  mutation. Treat `campaignReady` as the supported operational proof after Go
  available establishes the selected campaign/session: native AgentStatus readiness with
  `webPhoneRegisteredOn`, selected-campaign binding, `/campaignagents/{app_user_id}`
  proof, active/originating campaign state, and aggregate agent counts. The
  read-only readiness action itself performs no mutation; use
  `establish_calltools_agent_session` to start or release the native session.
- `read_dialer_state`, `update_dialer_state` for queue continuity.

Browser localStorage is a migration/cache copy, not the agent source of truth.

## Verification

Run the generated agent/adapter contract subset when contract, adapter, or
context surfaces change:

```sh
npm run qa:mcp-app
npm run qa:voice-provider-process
npm run qa:voice-configs
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

For documentation or published-surface changes, publish changed files under
`docs/` to every here.now entry in `.herenow/state.json`. The existing
`files.split-llc.com/speak` link already points at `onyx-breeze-jbke`, so update
all registered slugs with `--no-domain-link` instead of attempting to recreate
that link:

```sh
while IFS= read -r slug; do
  bash "$HOME/.codex/skills/here-now/scripts/publish.sh" docs \
    --slug "$slug" --client codex --title Speak --no-domain-link
done < <(jq -r '.publishes | keys[]' .herenow/state.json)
```

Then run:

```sh
npm run qa:brand-marketing
npm run qa:backend-api -- --baseUrl=https://speak.example.com/speak --json
npm run qa:full-audit
git diff --check
```

After a completed native campaign call, generate the supported campaign proof:

```sh
npm run qa:calltools-live-proof -- --require-complete --callControlId=<id>
```

Then run the release gate with the resulting
`speak.calltools.campaign-proof.v1` artifact and required recording-derived
review:

```sh
npm run qa:production-calltools-s-tier -- --liveProof=<proof.json>
```

selected Available lease, waits for the next native answered invite, and
releases only the lease it armed.

For code changes also run:

```sh
npm run lint
npm run qa:voice-provider-process
npm run qa:voice-configs
npm run qa:communication-threads
npm run build:speak
git diff --check
```

For production communication-source readiness, run these on the production host:

```sh
npm run qa:telnyx-source-routing
npm run qa:workspace-email
npm run qa:workspace-email-source
npm run repair:communication-source-dedup
npm run repair:workspace-email-sendas
npm run repair:workspace-email-sendas:auth-url
npm run repair:workspace-email-sendas:auth-complete -- --auth-url '<redirected-localhost-url>'
```

`qa:workspace-email` must prove both sides separately: the read auth account
can observe the workspace mailbox for source sync, and the send auth account
can send as the visible workspace mailbox before replies are considered
production-ready. `repair:workspace-email-sendas` is the safe recovery command
for the common failure where source read works but the send auth account is
missing the accepted Gmail send-as alias or settings scope. The `auth-url`
and `auth-complete` commands wrap the required two-step Google consent flow,
then apply the send-as repair and rerun `qa:workspace-email`.
`repair:communication-source-dedup` is the dry-run cleanup for duplicate
thread messages that share one native provider source event after attribution
or normalizer repairs; apply only after reviewing the reported groups.
