# Voice Provider Integration Playbook

This is the required intake and implementation process for adding any new
speech-to-speech runtime to Speak, including future OpenAI Realtime, Google
Realtime or Live APIs, or another provider SDK. The goal is not to translate
Hume or Inworld behavior into a new adapter. The goal is to understand the new
provider's native API, preserve Speak's core call workflow, and use provider
features that can improve latency, quality, reliability, or operator control.

## Acceptance Standard

A provider is ready only when these conditions are true:

- It can run realtime speech-to-speech for browser tests and phone calls.
- It preserves Speak's live-call loop: contact context, selected profile,
  transcripts, barge-in, stop/end call, takeover or live guidance, tools, and
  persisted history.
- It exposes provider-native model and voice choices without confusing them
  with Codex-auth choices.
- It has a documented transcript and recording retrieval path, or Speak-owned
  persistence is explicitly the durable source.
- It normalizes call transcripts, provider events, recordings, tool proof, and
  future adjacent communication into Speak communication threads/messages
  rather than creating provider-specific history storage.
- SMS and inbound-call source ingestion is production-ready only after
  `npm run qa:telnyx-source-routing` passes on the production host. The check
  verifies the configured Speak number, Telnyx messaging profile, Call Control
  application, provider webhook URLs, and Speak-side Telnyx webhook signature
  enforcement all point at Speak production.
- It has an SDK, REST, WebSocket, CLI, MCP, or official guide audit recorded in
  this playbook's intake template.
- It passes local and production verification, including
  `npm run qa:voice-configs`, `npm run qa:communication-threads`, and
  `npm run qa:voice-provider-process`.

## Required Discovery

Do this before writing provider code.

1. Read the provider overview, official docs, realtime API docs, SDK docs, auth docs, examples,
   limits, billing notes, and migration guides.
2. Read all guides that affect speech-to-speech behavior: audio codecs,
   sample rates, VAD, interruptions, session updates, tool calling, prompt
   instructions, model routing, transcript events, recordings, and webhooks.
3. Search for official MCP servers, CLIs, SDK helpers, example repos, and
   provider-owned development tools. Prefer provider-owned tooling over
   unofficial wrappers.
4. Search installed Codex plugins and MCP tools with `tool_search` for docs or
   account tooling that can speed up implementation. For OpenAI API work, use
   the OpenAI developer docs MCP before falling back to web search.
5. If a provider advertises an MCP server, install it only from the official
   provider package or repository, configure secrets outside the repo, and
   verify `initialize` plus `tools/list` or the provider's equivalent.
6. Capture current model, voice, STT, TTS, tool, and feature catalogues from the
   live API when credentials are available. Do not rely on stale screenshots or
   marketing pages for selectable runtime options.

## Generated Contract Inventory

`server/agent-contract.mjs` exports the provider-onboarding inventory consumed by
agent hosts and S-tier checks. Keep this playbook aligned with those exact
contract phrases when adding or renaming provider requirements.

Core feature terms:

- `realtime speech-to-speech`
- `browser playground`
- `phone call path`
- `input audio`
- `output audio`
- `barge-in`
- `turn finalization`
- `transcript persistence`
- `recording/audio retrieval`
- `provider-native model catalogue`
- `Codex-auth model route audit`
- `voice catalogue`
- `tool/function calling`
- `prompt/session contract`
- `context injection`
- `live guidance/takeover`
- `provider config sync proof`
- `observability`
- `safe MCP/action boundary`
- `official MCP/CLI/SDK discovery`

Optimization audit terms:

- `latency and streaming mode`
- `turn detection and interruption controls`
- `codec and sample-rate fit with browser, Telnyx, and CallTools gateway audio`
- `noise suppression, backchannel, and responsiveness settings`
- `STT/TTS model, voice steering, language, and pronunciation controls`
- `session resume, reconnect, and conversation replay`
- `tool-call streaming and confirmation hooks`
- `native transcript, recording, analytics, and quality signals`
- `rate limits, policy events, and safety controls`
- `official CLI, MCP, SDK debug tools, and simulator support`

## Core Feature Matrix

Every provider must be mapped against this matrix. If a provider does not
support a feature natively, document the Speak-owned fallback and whether that
fallback is acceptable for production.

| Capability | Speak requirement | Hume | Inworld | New provider intake |
| --- | --- | --- | --- | --- |
| Realtime speech-to-speech | Full duplex or low-latency turn streaming for browser and phone paths. | EVI WebSocket | Realtime WebSocket | Required |
| Browser playground | Typed and audio test sessions using saved profile and test contact context. | Supported | Supported | Required |
| Phone call path | Speak/Telnyx direct calls use Call Control start/stop/end. CallTools Go available activates/originates the selected native campaign and establishes a durable agent/SIP lease; the media gateway then receives native campaign invites with attach/end timing and no Speak contact-level direct start. | Supported through Telnyx and CallTools gateway | Supported through Telnyx and CallTools gateway | Required |
| Input audio | Accepts Speak's phone/browser input after codec conversion. | L16 16 kHz | PCM routed to Realtime input | Required |
| Output audio | Streams assistant audio into browser and phone output queues. | Provider audio output | Realtime audio delta | Required |
| Barge-in | Detects user speech and clears queued assistant audio. | Every final/interim `user_message` plus `user_interruption` clears playback | `speech_started` plus response cancel | Required |
| Turn finalization | Produces authoritative final user turns; partial transcripts must never be replayed as synthetic turns. | Native EVI final turns | Native Realtime final events | Required |
| Transcript persistence | Call and playground history visible in Library and per contact/profile. | Speak logs plus Hume metadata | Speak logs | Required |
| Communication thread normalization | Provider events and transcripts can be mapped into contact-scoped threads/messages. | Required via Speak logs | Required via Speak logs | Required |
| Recording/audio retrieval | Playback or clear "not recorded" status per call attempt. | Hume reconstruction where available | Speak-owned or provider-specific path | Required |
| Model catalogue | Provider-native models shown separately from Codex auth. | Hume language models | Inworld model list | Required |
| Codex-auth route | If provider supports external model routing, expose Codex-auth choices in the same selector with distinct labels. | CLM bridge | OpenAI-compatible `session.model` route | Audit |
| Voice catalogue | Native voices/custom voices shown with runtime provider labels and fetched through full provider pagination. | Hume/custom voices | Inworld system/custom voices via paginated List Voices API | Required |
| Tools/function calls | Speak tools remain backend-proofed and fail closed. | Hume tools/OpenAI-compatible tools | Realtime tool calls | Required |
| Prompt contract | Saved profile instructions remain Speak-owned and provider-appropriate. | Hume prompt resource/session settings | `session.instructions`/Realtime settings | Required |
| Context injection | Contact Memory and Agent Knowledge Layer are compact at session start, with retrieval tools for full content. | Supported | Supported | Required |
| Live guidance/takeover | Operator guidance and pause/resume semantics stay real, not simulated. | Control messages | Realtime messages/cancel | Required |
| Provider config sync | Save returns provider or synthetic proof and does not use stale browser state. | Provider config version | Synthetic Realtime proof | Required |
| Observability | Transport diagnostics, errors, transcript events, and provider metadata are logged without secrets. | Supported | Supported | Required |
| Safety boundary | Provider webhooks/media sockets are not MCP-callable generic tools. | Enforced | Enforced | Required |
| MCP/CLI tooling | Official tooling is searched, installed when useful, and verified. | Hume API only today | Inworld CLI/MCP | Required search |

## Optimization Audit

New providers often include improvements that Speak should use natively when
they fit the workflow. Audit these areas and record a decision for each:

- Lower-latency audio mode, streaming mode, or turn-detection preset.
- Semantic VAD, server VAD, configurable interruption threshold, or eager
  response controls.
- Codec/sample-rate choices that reduce transcoding between Telnyx, browser,
  and provider audio.
- Native echo cancellation, noise suppression, endpointing, backchannels, or
  responsiveness settings.
- Native STT/TTS model selection, language hints, pronunciation controls, or
  voice steering. For Inworld, TTS-2 steering requires a profile-visible
  steering toggle, `CREATIVE`/`BALANCED`/`STABLE` delivery choices, segmenter
  choices, and prompt rules that keep tags provider-native while stripping
  tags from Speak transcripts.
- Session resumption, reconnect, conversation item replay, or server-side state
  that improves recovery.
- Tool-call streaming, partial arguments, parallel tools, or provider-side
  confirmation hooks.
- Native transcript, recording, event export, analytics, or quality scores.
- Mapping from provider events into `communicationThread` and
  `communicationMessage` without losing provider proof or contact attribution.
- Built-in safety, DNC-style call controls, policy events, or provider rate
  limit metadata.
- Official CLI, MCP, SDK debug commands, or local simulator that can become part
  of Speak verification.

Do not enable an optimization just because it exists. It must improve the live
call loop without weakening proof, persistence, or operator control.

## Implementation Shape

Add new providers through the neutral Speak surfaces:

- Runtime/config normalization: `server/runtime-config.mjs`.
- Provider option/sync adapters: `server/hume-configs.mjs` and
  `server/inworld-configs.mjs`; new providers should follow that server-side
  adapter pattern before they are folded through the neutral facade.
- Neutral provider facade: `server/speak-configs.mjs`.
- Realtime session bridge: keep provider-specific WebSocket or SDK semantics
  native; do not transform another provider's event model into Hume terms.
- Phone media bridges: verify new runtime audio over both current Speak phone
  bridges when applicable: Telnyx media streams and the CallTools SIP/WebRTC media gateway.
  CallTools remains a dialer/origination provider, not a voice runtime.
- Frontend settings: provider-native and Codex-auth options appear in the same
  model selector, with route labels that identify the backend path.
- Profile persistence: `CampaignConfig` stores provider-specific fields plus
  neutral `speak*` aliases where headless agents need one shape.
- Call logs: Speak-owned call records remain the durable transcript/history
  source even if provider transcript APIs are also available.
- Communication threads: normalize provider transcript turns, provider events,
  recordings, tool proof, and future channel handoffs into the model in
  `docs/communication-thread-model.md`; do not add provider-specific history
  panes or provider-owned thread IDs as primary UI identity.
- Agent contract: update `server/agent-contract.mjs` for provider names, model
  groups, proof fields, blocked internals, and verification commands.
- MCP: expose only safe Speak actions. Do not expose provider webhooks,
  media sockets, raw SDK debug methods, or secret-bearing routes as generic MCP
  tools.

The third-provider intake renamed the shared frontend option types to
`src/voiceConfigOptions.ts`. Keep future providers on that neutral surface and
do not reintroduce provider-specific naming.

## Intake Record Template

Create or update a section in this document before implementation:

```md
## Provider Intake: {Provider Name}

- Provider docs reviewed:
- SDK docs reviewed:
- Realtime API docs reviewed:
- Guides/examples reviewed:
- Auth/secrets model:
- Official CLI found:
- Official MCP found:
- MCP verification:
- Model catalogue source:
- Voice catalogue source:
- STT/TTS options:
- Barge-in/interruption events:
- Tool/function-call model:
- Transcript source:
- Recording/audio source:
- Phone bridge coverage:
- Communication thread/message mapping:
- Contact attribution and unresolved-match behavior:
- Prompt/session contract:
- Codec/sample-rate contract:
- Optimizations to use:
- Optimizations rejected:
- Speak fallback decisions:
- Verification commands:
- Production readback:
```

## Provider Intake: xAI Voice Agent API

- Provider docs reviewed: Voice overview, Voice Agent API capability page,
  pricing/rate limits, release notes, custom voices, and SIP phone calls.
- SDK docs reviewed: the Voice Agent API's documented OpenAI Realtime SDK
  compatibility and xAI-owned WebSocket, WebRTC, iOS, and telephony tester apps.
- Realtime API docs reviewed: `wss://api.x.ai/v1/realtime`, `session.update`,
  client/server events, audio transport, function calls, interruption events,
  session resumption, and OpenAI Realtime event differences.
- Guides/examples reviewed: browser ephemeral-token auth, parallel microphone and
  socket initialization, audio buffering, tool-call playback ordering, BYO SIP,
  and custom-voice examples.
- Auth/secrets model: `XAI_API_KEY` is server-only; macOS development may read the
  optional local Keychain service `speak-xai-api-key`.
  Browser clients remain connected through Speak and never receive the key.
- Official CLI found: no voice-specific xAI CLI was found.
- Official MCP found: xAI Realtime can consume remote MCP tools, but no
  provider-account/docs MCP was found or needed for this server-side adapter.
- MCP verification: installed MCP/plugin inventory contained no xAI provider
  MCP; safe Speak functions remain client-executed custom function tools.
- Model catalogue source: the Voice Agent guide. `grok-voice-latest` resolves to the current Voice Agent model; Speak does not expose superseded model IDs for new profiles. The generic `/v1/models` response does not advertise Voice Agent models.
- Voice catalogue source: merge every built-in from `GET /v1/tts/voices` with
  every page from `GET /v1/custom-voices?limit=1000`; custom voices do not appear
  in the built-in response.
- STT/TTS options: native Grok Voice Agent speech-to-speech with
  `grok-transcribe` cumulative/final transcript events and the selected built-in
  or custom xAI voice.
- Barge-in/interruption events: `input_audio_buffer.speech_started` cancels the
  active response and clears Speak-owned browser/phone playback; authoritative
  caller turns come from `conversation.item.input_audio_transcription.completed`.
- Tool/function-call model: Speak's proof-backed functions are sent as xAI
  custom function tools. Speak handles `response.function_call_arguments.done`,
  returns `function_call_output`, and delays `response.create` until prior audio
  playback is clear enough to avoid overlapping speech.
- Transcript source: Speak-owned call logs and communication threads remain the
  durable source; xAI transcript events provide live/final turns.
- Recording/audio source: Speak-owned phone/browser audio and call artifacts;
  xAI does not become the primary history identity.
- Phone bridge coverage: direct Speak/Telnyx and CallTools SIP/WebRTC gateway
  media continue through Speak's current bridges. xAI BYO SIP is documented but
  is not used for outbound authority, phone-number ownership, or campaign state.
- Communication thread/message mapping: normalized caller, assistant, tool,
  error, and provider lifecycle events use the existing call/thread persistence.
- Contact attribution and unresolved-match behavior: unchanged Speak-owned
  contact/profile binding; provider conversation IDs are metadata only.
- Prompt/session contract: `session.instructions` receives Speak's guarded
  runtime system prompt plus the selected profile instructions and compact
  contact/profile context. Hume prompt-resource semantics are never forwarded.
- Codec/sample-rate contract: PCM16 little-endian at 16 kHz over JSON audio
  events for the browser, Telnyx L16, and CallTools paths, avoiding unnecessary
  phone transcoding while retaining current packet timing and diagnostics.
- Optimizations to use: existing provisional preconnect, server VAD with saved
  threshold/silence/prefix controls, `reasoning.effort=none` as the latency-first
  default with `high` selectable, current-model alias plus pinned-model choice,
  cumulative live captions, custom keyterms, and fail-closed tool execution.
- Optimizations rejected: direct browser-to-xAI secrets, xAI-purchased numbers,
  replacing Telnyx/CallTools origination with provider-specific SIP paths,
  provider-side web/X search by default, and advertising Codex auth when xAI's
  Voice Agent session has no external-LLM route.
- Speak fallback decisions: no Codex-auth option is shown while xAI is selected;
  Hume and Inworld keep their existing Codex-auth routes. Speak owns reconnect,
  transcript, recording, live guidance, takeover, and call termination proof.
- Verification commands: targeted xAI config/session checks plus the standard
  provider, voice-config, communication-thread, MCP, readiness, lint, build, UI,
  browser, and production readback gates below.

## Verification

Run these for provider work:

```sh
npm run qa:voice-provider-process
npm run qa:voice-configs
npm run qa:communication-threads
npm run qa:mcp-app
npm run qa:agent-readiness
npm run qa:speak-agent-tier
npm run lint
npm run build:speak
git diff --check
```

For UI selector or layout changes, also run:

```sh
SPEAK_QA_BASE_URL=http://127.0.0.1:5173/speak npm run qa:ui-contract
```

For production deployment, verify:

```sh
curl -fsS https://speak.example.com/speak/api/health
curl -fsS https://speak.example.com/speak/api/agent-configs/speak-options
curl -fsS https://speak.example.com/speak/api/agent/readiness.json
```
