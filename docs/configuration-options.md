# Speak Configuration Options

This page covers backend environment flags plus every Playground profile/runtime option that frontend, backend, or agents can use. Runtime values are source-of-truth server state; verify live values from `/api/health`, `/api/agent-configs/speak-options`, `/api/profiles`, or `npm run --silent agent:contract`.

## Deployment And Storage

| Option | Scope | Default | Purpose |
| --- | --- | --- | --- |
| `PORT` | backend env | `8787` | Express/API port. |
| `BASE_PATH` | backend env | empty | Mount path for app/API, production uses `/speak`. |
| `PUBLIC_BASE_URL` | backend env | empty | Public HTTPS base used to derive webhooks, CLM URL, manifests, and links. |
| `VITE_BASE_PATH` | frontend env | `/` locally, `/speak/` in `build:speak` | Vite asset/router base. |
| `VITE_API_PROXY_TARGET` | frontend dev env | `http://127.0.0.1:8787` | Local Vite dev-server API/WebSocket proxy target for `/api` and `/speak/api`. Docs screenshot generation sets this to the isolated fixture API server so rendered captures do not hit production. |
| `SPEAK_WORKSPACE_DATA_DIR` | backend env | `workspace-data` | Directory containing authoritative `workspace.json`. |
| `BACKGROUND_DELIVERY_OUTBOX_PATH` | backend env | `<SPEAK_WORKSPACE_DATA_DIR>/background-delivery-outbox.json` | Private durable JSON outbox for voice-agent SMS/email admission, dispatch fencing, deduplication, restart recovery, and terminal provider proof. Its parent directory is created automatically and the file is written with owner-only permissions; keep it on persistent local storage. |
| `SPEAK_OPERATIONAL_TIME_ZONE` | backend/scripts env | `America/New_York` | Shared operational date zone for Speak call logs and operator-visible call/transcript timestamps. Use the IANA zone, not a fixed `EST` offset; July dates resolve as EDT while winter dates resolve as EST. CallTools provider API filters still need UTC date candidates for records stored after UTC midnight. |
| `SPEAK_CALL_LOG_DIR` | backend/scripts env | `call-logs` | Directory containing persisted call-event JSONL logs. Useful for isolated fixtures, audits, and tests. |
| `SPEAK_INTERNAL_EVENT_TOKEN` | backend env | localhost-only when unset | Optional bearer or `x-speak-internal-token` secret for trusted `/api/communication-events` writes. Keep unset for local-only development, set in production if an external trusted ingester writes normalized events. |
| `CALL_AUDIO_MAX_BYTES` | backend env | `25000000` | Maximum local call-audio response size. |
| `SPEAK_CODEX_APP_SERVER_BIN` | backend env | `codex` | Binary used by Smart Config app-server bridge. |

## Provider And Delivery Runtime

| Option | Scope | Default | Purpose |
| --- | --- | --- | --- |
| `HUME_API_KEY` | backend env/keychain | required for live voice/provider sync | Private voice provider API key. On macOS development hosts, the optional local fallback is Keychain service `speak-hume-api-key`; the value never reaches the browser. |
| `HUME_CONFIG_ID` | backend env/profile fallback | required for Hume-backed live calls | Hume EVI config ID. Inworld-backed profiles use the Speak-owned `INWORLD_CONFIG_ID` session-update path instead. |
| `HUME_VOICE_ID` | backend env/profile fallback | empty | Hume voice ID for Hume-backed calls. |
| `HUME_AUDIO_SAMPLE_RATE` | backend env | `16000` | Runtime phone/audio sample rate. |
| `HUME_USE_CONFIG_PROMPT` | backend env/profile | `false` unless profile sets true | Whether runtime uses provider config prompt. Production baseline is true. |
| `HUME_USE_CONFIG_TOOLS` | backend env/profile | `false` unless profile sets true | Whether runtime uses provider config tools. Production baseline is true. |
| `HUME_AUTO_START_GREETING` | backend env/profile | `false` | Whether the agent speaks before callee audio on non-CallTools paths. Production baseline is false. CallTools S-tier proof always requires caller/callee speech before the first agent turn. |
| `HUME_TEMP_AGENT_MODE` | backend env | empty | Test-only global persona override. The only supported value is `jonathan_echo`, which makes calls ask for Jonathan, suppress normal resume guidance, and mirror Jonathan verbatim through the temporary prompt path. Leave unset in production. |
| `HUME_END_OF_TURN_SILENCE_MS` | backend env/profile | `500` | Responsive turn-detection silence window; Hume's documented minimum. Speak does not substitute prompt/model/voice changes for this transport setting. |
| `HUME_SPEECH_DETECTION_THRESHOLD` | backend env/profile | `0.58` | Speech detection threshold. |
| `HUME_PREFIX_PADDING_MS` | backend env/profile | `300` | Audio prefix padding for turn detection. |
| `HUME_MIN_INTERRUPTION_MS` | backend env/profile | `550` | Minimum interruption duration. |
| `HUME_ASSISTANT_RESPONSE_IDLE_MS` | backend env | `4500` | Recheck interval for stalled assistant response recovery. |
| `HUME_PLAYGROUND_PENDING_INPUT_RECHECK_MS` | backend env | `1200` | Browser playground pending input recheck interval. |
| `HUME_PHONE_OUTPUT_GAIN` | backend env/profile | `0.72` | Phone output gain. |
| `HUME_PHONE_OUTPUT_PEAK` | backend env/profile | `0.58` | Phone output peak target. |
| `VOICE_RUNTIME_PROVIDER` | backend env/profile | `hume` | Default speech-to-speech runtime: `hume`, `inworld`, or `xai`. |
| `INWORLD_API_KEY` | backend env/keychain | required for Inworld live calls/options | Private Inworld API key. Can be read from the local keychain helper in development. |
| `INWORLD_CONFIG_ID` | backend env/profile fallback | `inworld-realtime` | Synthetic Speak-owned Inworld config ID. Inworld Realtime applies config through `session.update`. |
| `INWORLD_REALTIME_MODEL` | backend env/profile | `google-ai-studio/gemini-2.5-flash` | Default Inworld native Realtime LLM model. |
| `INWORLD_FALLBACK_REALTIME_MODEL` | backend env/profile | `google-ai-studio/gemini-2.5-flash` | Native Inworld fallback model used only for the current live session when a selected Inworld router/Codex-auth model is rejected by the account plan. Speak records the fallback in transport diagnostics without mutating the saved profile selection. |
| `INWORLD_CODEX_ROUTER_MODEL` / `INWORLD_CODEX_MODEL` | backend env/profile | empty | Optional explicit Inworld Realtime model/router for Codex-auth profiles. Bare `gpt-*` values normalize to `openai/gpt-*`; `INWORLD_CODEX_MODEL` is the older alias still read by runtime config. |
| `INWORLD_CODEX_ROUTER_MODELS` | backend env | empty | Optional comma-separated extra Inworld Codex-auth model/router choices. |
| `INWORLD_STT_MODEL` | backend env/profile | `inworld/inworld-stt-1` | Inworld-native Realtime STT model for live speech-to-speech calls. Do not switch live calls to third-party STT as a latency shortcut; recording-derived audits may still use `CALLTOOLS_RECORDING_STT_MODEL`. |
| `INWORLD_TTS_MODEL` | backend env/profile | `inworld-tts-2` | Inworld Realtime TTS model. Speak normalizes all Inworld realtime sessions to the latest supported `inworld-tts-2`; do not downgrade to older Inworld TTS models for latency. |
| `INWORLD_VOICE_ID` | backend env/profile | `Dennis` | Default Inworld voice ID for runtime/profile fallback. It is not a selectable voice-catalog fallback; Settings voice options come from the active `INWORLD_API_KEY` account read. |
| `INWORLD_LANGUAGE` | backend env/profile | `en-US` | Inworld STT/TTS language hint. |
| `INWORLD_TURN_DETECTION` | backend env/profile | `semantic_vad` | Inworld Realtime turn detection, `semantic_vad` or `server_vad`. |
| `INWORLD_STT_END_OF_TURN_CONFIDENCE_THRESHOLD` | backend env/profile | unset | Advanced Inworld semantic VAD override. Leave unset so `INWORLD_TURN_EAGERNESS` controls the native confidence threshold. |
| `INWORLD_STT_MIN_END_OF_TURN_SILENCE_MS` | backend env/profile | unset | Advanced Inworld semantic VAD override. Leave unset so `INWORLD_TURN_EAGERNESS` controls native minimum end-of-turn silence. |
| `INWORLD_STT_MAX_TURN_SILENCE_MS` | backend env/profile | unset | Advanced Inworld semantic VAD override. Leave unset so `INWORLD_TURN_EAGERNESS` controls native maximum within-turn silence. |
| `INWORLD_STT_VAD_THRESHOLD` | backend env/profile | unset | Advanced Inworld semantic VAD override. Leave unset so `INWORLD_TURN_EAGERNESS` controls the native VAD threshold. |
| `INWORLD_TURN_EAGERNESS` | backend env/profile | `high` | Inworld semantic VAD eagerness. Speak defaults to `high` for live phone calls so Inworld commits user turns quickly without Hume-style fixed silence overrides. |
| `INWORLD_TTS_DELIVERY_MODE` | backend env/profile | `CREATIVE` | Inworld TTS-2 delivery mode. `CREATIVE` is the naturalness default; profiles can choose `BALANCED` or `STABLE` when consistency matters more. |
| `INWORLD_TTS_SEGMENTER_STRATEGY` | backend env/profile | `full_turn` | Inworld TTS segmenter strategy. Speak defaults to `full_turn` because Inworld documents it as the natural-cadence TTS-2 setting. Profiles can choose `fast_start` or `sentence` only as an explicit latency-over-cadence tradeoff. |
| `INWORLD_TTS_STEERING_HANDLING` | backend env/profile | `emit_once` | Inworld TTS steering behavior. |
| `INWORLD_TTS_CONVERSATIONAL_ENABLED` | backend env/profile | `false` | Optional Inworld TTS-2 shared conversational context. Locked at session open by Inworld, so use per-profile and verify latency before enabling. |
| `INWORLD_TTS_USER_TURN_MODE` | backend env/profile | `both` | Inworld TTS-2 conversational-mode user-turn context, one of `both`, `audio_only`, `text_only`, or `none`. No-op when conversational context is disabled. |
| `INWORLD_VOICE_STEERING_ENABLED` | backend env/profile | `true` | Adds Inworld TTS-2 speech-output rules to `session.instructions` so the model may use one leading `[speak ...]` steering tag when useful. Tags are stripped from stored assistant transcript text. |
| `INWORLD_VOICE_PROFILE_ENABLED` | backend env/profile | `true` | Enables Inworld-native STT voice-profile cues for caller emotion, vocal style, accent, age, and gender metadata on transcription events. Speak stores this in diagnostics for tone/audibility review without changing the configured LLM model or using a third-party live STT service. |
| `INWORLD_RESPONSIVENESS_INITIAL_WAIT_MS` | backend env/profile | `600` | Inworld responsiveness filler wait used only when responsiveness is explicitly enabled. Speak keeps the timing fields measurable but disables fillers by default so the first spoken answer is the actual response. |
| `INWORLD_RESPONSIVENESS_HARD_DEADLINE_MS` | backend env/profile | `1200` | Maximum time spent generating the short responsiveness filler. |
| `INWORLD_BACKCHANNEL_ENABLED` | backend env/profile | `false` | Enables Inworld backchannel extension. |
| `INWORLD_RESPONSIVENESS_ENABLED` | backend env/profile | `false` | Enables Inworld responsiveness extension. Leave disabled for normal live phone calls unless a measured provider proof shows a natural acknowledgement improves perceived latency without filler phrasing. |
| `INWORLD_MEMORY_ENABLED` | backend env/profile | `false` | Enables Inworld memory extension. |
| `INWORLD_TOOL_CALLING_ENABLED` | backend env/profile | `true` | Enables the shared Speak tools for Inworld Realtime sessions, including Speak-owned Telnyx SMS and Workspace email delivery. Set an individual profile or this environment override to `false` only when the account lacks tool-calling capability; if Inworld returns a plan restriction, Speak retries the session without provider tools and does not claim an action succeeded. Hume tool behavior is unchanged. |
| `INWORLD_OUTPUT_SAMPLE_RATE` | backend env/profile | `16000` | Inworld output PCM sample rate before phone/browser queueing. Phone calls default to Speak's 16 kHz PCM path to avoid an extra 24 kHz to 16 kHz hop. |
| `XAI_API_KEY` | backend env/keychain | required for xAI live calls/options | Private xAI key. On macOS development hosts, the optional local fallback is Keychain service `speak-xai-api-key`; the value never reaches the browser. |
| `XAI_REALTIME_MODEL` | backend env/profile | `grok-voice-latest` | xAI Voice Agent model. Settings also offer the current pinned `grok-voice-think-fast-1.0`. |
| `XAI_VOICE_ID` | backend env/profile | `eve` | Default built-in or custom xAI voice ID. Settings merge `GET /v1/tts/voices` with every custom-voice page. |
| `XAI_REASONING_EFFORT` | backend env/profile | `none` | Voice Agent reasoning effort: `none` for latency or `high`. |
| `XAI_LANGUAGE_HINT` | backend env/profile | `en` | Optional Realtime input transcription language hint. |
| `XAI_KEYTERMS` | backend env/profile | empty | Comma-separated transcription keyterms. Profiles store the same setting as an array. |
| `XAI_VOICE_SPEED` | backend env/profile | `1` | Realtime output voice speed, clamped to xAI's supported `0.7`–`1.5` range. |
| `XAI_RESUMPTION_ENABLED` | backend env/profile | `true` | Enables xAI conversation resumption and bounded reconnect using the provider conversation ID. |
| `XAI_TOOL_CALLING_ENABLED` | backend env/profile | `true` | Enables proof-backed Speak function tools. Parallel xAI calls return all outputs before one follow-up `response.create`. |
| `XAI_OUTPUT_SAMPLE_RATE` | backend env/profile | `16000` | xAI PCM16 output rate. The 16 kHz default matches Telnyx L16 and CallTools phone media without an extra resample. |
| `VOICE_SESSION_PRECONNECT_TTL_MS` | backend env | `15000` | Maximum unbound lifetime for a provisional Hume/Inworld/xAI session prepared before direct Phone or Personal Phone media arrives. Expired sessions close their provider sockets and aliases; the registry caps this value at 10 minutes. |
| `PLAYGROUND_START_REQUEST_TTL_MS` | backend env | `900000` | Retention window for Browser/Phone start-request cancellation tombstones. Keep this longer than every provider/readiness request so a delayed accepted start can still be closed after reset, refresh, navigation, or tab close. |
| `PLAYGROUND_START_REQUEST_MAX_ENTRIES` | backend env | `2048` | Maximum retained Playground start-request and cancellation records. Old terminal records are evicted after TTL while pending records remain fail-closed. |
| `DEEPGRAM_API_KEY` | backend env/keychain | required only for Playground Phone audio Whisper | Private server-side streaming transcription key. the raw key and Deepgram socket never reach the browser. Text Whisper, Spy, and Barge remain available without it. |
| `DEEPGRAM_STT_MODEL` | backend env | `nova-3` | Streaming transcription model used only for bounded Playground Phone audio Whisper turns. |
| `DEEPGRAM_STT_LANGUAGE` | backend env | `en-US` | Language hint for Playground Phone audio Whisper transcription. |
| `PLAYGROUND_AUDIO_WHISPER_MAX_MS` | backend env | `30000` | Maximum operator microphone duration for one audio Whisper, bounded to 5–60 seconds. Reaching the limit finalizes transcription; no operator audio is sent to the contact. |
| `TELNYX_API_BASE` | backend/test env | `https://api.telnyx.com/v2` | Override only for deterministic provider-ingress tests; production should use Telnyx's default API base. |
| `TELNYX_API_KEY` | backend env | required for live calls/SMS | Private phone provider API key. |
| `TELNYX_CONNECTION_ID` | backend env | required for live calls | Workspace-wide outbound Call Control application. Saved profile and phone-catalog connection IDs cannot substitute because they may be inbound TeXML/SIP assignments; outbound calls fail closed when this environment value is missing. |
| `TELNYX_FROM_NUMBER` | backend env/profile | required for live calls | Caller ID. |
| `TELNYX_PHONE_NUMBER_ID` | backend env | `env:telnyx-from-number` | Optional Telnyx phone-number resource ID for the env fallback caller ID shown by `/api/phone-provider/options`. |
| `TELNYX_FROM_NUMBER_LABEL` | backend env | inferred | Optional display label for the env fallback caller ID. Numbers ending in `1882` display as `Personal Phone` when no explicit label is set. |
| `TELNYX_SMS_NUMBER` | backend env | falls back to `TELNYX_SMS_FROM`/`TELNYX_FROM_NUMBER` | SMS sender. |
| `TELNYX_SMS_NUMBER_LABEL` | backend env | inferred | Optional display label for the SMS number when it appears in the Speak phone-number catalog. |
| `TELNYX_SMS_FROM` | backend env | empty | Alternate SMS sender. |
| `SPEAK_PHONE_NUMBER_OPTIONS` / `TELNYX_PHONE_NUMBER_OPTIONS` | backend env | empty | Optional JSON array or comma-separated fallback phone-number catalog for `/api/phone-provider/options`. JSON entries may include `id`, `label`, `phoneNumber`, `connectionId`, `messagingProfileId`, and `default`. |
| `TELNYX_MESSAGING_PROFILE_ID` | backend env | required for SMS | Messaging profile. |
| `TELNYX_STREAM_CODEC` | backend env/profile | `L16` | Phone media codec, `L16` or `PCMU`. |
| `TELNYX_STREAM_CODEC_FORCE` | backend env | `false` | Forces env codec over profile codec. |
| `TELNYX_WEBHOOK_URL` | backend env | derived from `PUBLIC_BASE_URL` | Explicit phone webhook URL. |
| `TELNYX_WEBHOOK_PUBLIC_KEYS` | backend env | empty | Comma- or newline-separated Telnyx Ed25519 webhook public signing keys. Use multiple values during key rotation. |
| `TELNYX_WEBHOOK_PUBLIC_KEY` / `TELNYX_PUBLIC_KEY` | backend env | empty | Single-key fallback for the Telnyx webhook public signing key from Mission Control. |
| `TELNYX_WEBHOOK_SIGNATURE_REQUIRED` | backend env | `false` | Set `true` in production so `/api/webhooks/telnyx` rejects unsigned, stale, or invalid SMS/call webhooks before source persistence. |
| `TELNYX_WEBHOOK_SIGNATURE_TOLERANCE_SECONDS` | backend env | `300` | Replay window for signed Telnyx webhook timestamps. Set only when Telnyx delivery timing requires a different tolerance. |
| `SPEAK_TELNYX_WEBHOOK_ALLOW_AUTOMATION` | backend env | `false` | Allows signed Telnyx webhook intake to apply explicit contact/agent/system inbound SMS auto-reply or inbound-call auto-answer policy. Leave false unless `/api/webhooks/telnyx` is the trusted live automation ingester; source records are still written when false. |
| `TELNYX_FRAME_MS` | backend env | `20` | Outbound media frame size. |
| `TELNYX_MAX_QUEUE_MS` | backend env | `30000` | Maximum queued outbound media. The queue preserves the earliest unsent frames so provider bursts cannot jump playback into the middle of a sentence; live caller barge-in still clears pending audio immediately. |
| `VOICE_STREAM_URL` | backend env | derived from `PUBLIC_BASE_URL` | Public WebSocket media URL. |
| `DIALER_PROVIDER` | backend env/profile | `speak` | Default call-origination provider. `speak` uses the current Speak/Telnyx phone path; `calltools` uses CallTools Phone-as-Agent profile binding and must not be treated as a voice runtime. |
| `GET /api/phone-provider/options` | backend read API | n/a | Reads the active Telnyx account phone-number catalog for Speak phone-provider settings and falls back to explicit env numbers when Telnyx credentials are absent or the catalog read fails. Returned payloads include sanitized number, connection, messaging-profile, and read-proof fields only; API keys are never returned. |
| `BLUEBUBBLES_SERVER_URL` / `BLUEBUBBLES_API_URL` | backend env | `http://127.0.0.1:1234` | BlueBubbles private API base URL for Personal Phone contact sync. |
| `BLUEBUBBLES_PASSWORD` | backend env/keychain | macOS Keychain `bluebubbles-password` | BlueBubbles private API password. The server reads env first, then macOS Keychain locally; the raw password is never returned by Speak APIs. |
| `PERSONAL_PHONE_CONTACTS_SOURCE_ID` | backend env | sync default `bluebubbles:contacts`; explicit value required for inbound handoff | Durable source ID for the Personal Phone contact source. Missed-call eligibility fails closed unless production explicitly pins this value. |
| `PERSONAL_PHONE_CONTACTS_EXTERNAL_URL` / `PERSONAL_PHONE_CONTACTS_SOURCE_URL` | backend env | `bluebubbles://contacts` | External/source URLs stored on contacts imported from BlueBubbles. |
| `PERSONAL_PHONE_CONTACTS_TITLE` | backend env | `Personal Phone Contacts` | Contact source name for imported personal-phone contacts. |
| `GET /api/personal-phone/contacts` / `POST /api/personal-phone/contacts/sync` | backend read/mutation API | n/a | Reads BlueBubbles source configuration and syncs personal-phone contacts into the durable `source=personal-phone` contact source. The sync maps BlueBubbles contact records to contact fields and preserves local contact edits during source refreshes. |
| `PERSONAL_PHONE_TELNYX_DID` | backend env | required for inbound handoff | Exact E.164 Personal Phone DID accepted by the missed-call handoff policy. Missing or mismatched values return voicemail. |
| `PERSONAL_PHONE_SPEAK_HANDOFF_SECRET` | backend env/keychain | required when Personal Phone handoff is enabled | Shared bearer secret for the Personal Phone handoff/resolve routes. On macOS development hosts, the optional local fallback is Keychain service `speak-personal-phone-speak-handoff-secret`; raw values are never returned. |
| `PERSONAL_PHONE_SPEAK_STREAM_HOST` | backend env | `speak.example.com` | Exact host required for the one-time `wss:` Personal Phone media URL. |
| `GET /api/personal-phone/inbound/readiness` | backend read API | n/a | Sanitized backend/headless readiness for the handoff secret, DID, backend-authoritative source ID, secure stream, durable replay store, enabled profiles, bounded selections, and Hume/Inworld/xAI runtime credentials. It performs no provider call. |
| `POST /api/personal-phone/inbound/handoffs` | protected Worker API | n/a | Authenticated, workspace-only missed-call policy. It accepts fresh terminal Linphone outcomes, requires one exact Personal Phone contact and one eligible ready profile, durably caches every decision by event plus call ID, and returns either voicemail or a one-time PCMU stream. |
| `POST /api/personal-phone/inbound/handoffs/{correlationId}/resolve` | protected Worker API | n/a | Authenticated terminal classifier. Exact fresh resolve.v1 requests map prepared/attached pre-conversation states to voicemail and conversation/terminal states to hangup; unknown or malformed requests return the frozen HTTP-200 voicemail outcome. |
| `CALLTOOLS_BASE_URL` | backend env | required when using CallTools | CallTools account silo API base, for example `https://your-silo.calltools.io/api`. CallTools uses per-account silo domains; copy the domain from your account. |
| `CALLTOOLS_API_KEY` / `CALLTOOLS_TOKEN` | backend env/keychain | required for CallTools provider reads | Private CallTools API token. Never expose in client payloads or logs. |
| `CALLTOOLS_API_TIMEOUT_MS` | backend env | `12000` | Per-request timeout for CallTools API reads/writes. Slow upstream CallTools responses fail closed with `calltools_request_timeout` instead of hanging Speak routes or gateway registration. |
| `CALLTOOLS_PHONE_CREDENTIAL_TIMEOUT_MS` | backend env | `20000` | Timeout for the protected gateway-config phone credential read. This uses native direct `GET /phones/{id}/`, not a list-all phone read, because that endpoint is the fastest reliable way to recover WebRTC/SIP credentials. |
| `CALLTOOLS_PHONE_CREDENTIAL_FALLBACK_FIRST` | backend env | `false` | When `true` and a server-local credential fallback is configured, `/api/calltools/gateway-config` uses the local fallback immediately instead of waiting on the CallTools phone read. Use this only for production restart continuity while the upstream CallTools phone endpoint is slow or unavailable. |
| `CALLTOOLS_PHONE_CREDENTIALS_FILE` / `CALLTOOLS_GATEWAY_PHONE_CREDENTIALS_FILE` | backend env | empty | Optional server-local JSON fallback for the CallTools WebRTC phone credential used only by `/api/calltools/gateway-config`. By default it is used after the native CallTools `/phones/{id}/` read fails or times out; with `CALLTOOLS_PHONE_CREDENTIAL_FALLBACK_FIRST=true` it is used immediately. The file must stay on the server with restricted permissions and may contain `id`, `server` or `ws_url`, `uri` or `sip_uri`, `authorizationUsername` or `username`, and `authorizationPassword` or `password`. |
| `CALLTOOLS_PHONE_CREDENTIALS_JSON` / `CALLTOOLS_GATEWAY_PHONE_CREDENTIALS_JSON` | backend env | empty | Inline JSON equivalent to the credential file fallback. It may be a single phone object, `{ "phones": [...] }`, or a keyed phone map. Prefer the protected file fallback for production; never put these values in profile state, public readiness payloads, docs, or client bundles. |
| `CALLTOOLS_GATEWAY_PHONE_ID` / `CALLTOOLS_PHONE_ID`, `CALLTOOLS_GATEWAY_PHONE_WS_URL` / `CALLTOOLS_GATEWAY_PHONE_SERVER`, `CALLTOOLS_GATEWAY_PHONE_SIP_URI`, `CALLTOOLS_GATEWAY_PHONE_USERNAME`, `CALLTOOLS_GATEWAY_PHONE_PASSWORD`, `CALLTOOLS_GATEWAY_PHONE_IS_WEBRTC` | backend env | empty / `true` for WebRTC flag | Direct env fallback equivalent to `CALLTOOLS_PHONE_CREDENTIALS_FILE`. Use only for restart continuity when the CallTools API is unavailable; profile state still stores non-secret IDs only. |
| `CALLTOOLS_MEDIA_GATEWAY_SHARED_SECRET` | backend env | empty | Shared secret used by Speak and the hosted CallTools media gateway. Required before CallTools live audio can start. |
| `CALLTOOLS_GATEWAY_PROFILE_ID` / `CALLTOOLS_READINESS_PROFILE_ID` / `CALLTOOLS_PROFILE_ID` | gateway/readiness/proof env | backend-selected active profile | Optional saved-profile pin. The production gateway normally bootstraps from the persisted active Speak agent, borrows the compatible shared CallTools user/phone/campaign binding without modifying that agent's Hume/Inworld/xAI settings, and binds the idle shared phone to the selected agent before native AgentStatus is made ready. With no pin, proof/readiness scripts first read the backend-selected active profile and keep that returned ID for the run. Use a pin only for an intentional dedicated proof target. |
| `CALLTOOLS_GATEWAY_PROFILE_BIND_TIMEOUT_MS` | backend env | `2500` | Maximum time for the idle persistent gateway to acknowledge a selected Speak profile before native CallTools AgentStatus is made ready. The handoff requires the same assigned physical CallTools phone and fails closed when the gateway is busy, unhealthy, or bound to a different phone. |
| `CALLTOOLS_GATEWAY_REGISTRATION_TIMEOUT_MS` | backend env | `10000` | Maximum time for the persistent gateway to acknowledge an explicit SIP registration or unregistration handoff. Timeout fails the Available/Unavailable transition closed instead of guessing shared-seat ownership. |
| `CALLTOOLS_GATEWAY_CLOSE_RECONCILE_TIMEOUT_MS` | backend env | `2500` | Total budget for the detached native CallTools historical-call lookup after terminal state has already been persisted and emitted. Recording metadata can reconcile later without delaying hangup state, UI completion, or graceful shutdown. |
| `CALLTOOLS_GATEWAY_PAGE_URL` | gateway launcher env | derived from `PUBLIC_BASE_URL` or local `PORT`/`BASE_PATH` | Optional explicit URL for `calltools-gateway.html`. The production systemd gateway uses `http://127.0.0.1:8791/speak/calltools-gateway.html` so page/API/PCM traffic stays on the VM rather than hairpinning through the public edge. |
| `CALLTOOLS_GATEWAY_PAGE_LOAD_TIMEOUT_MS` | gateway launcher env | `15000` | Maximum time spent loading the hosted gateway page shell before retrying. Same-origin gateway/API/asset `5xx` responses fail immediately so a transient deploy 502 does not consume the full readiness timeout. |
| `CALLTOOLS_GATEWAY_READY_TIMEOUT_MS` | gateway launcher env | `60000` | Maximum time to wait for the gateway process to initialize its backend control socket and SIP client. An intentionally Unavailable process is ready without registering the shared SIP phone. |
| `CALLTOOLS_GATEWAY_RETRY_DELAY_MS` | gateway launcher env | `5000` | Delay between gateway registration attempts. |
| `CALLTOOLS_GATEWAY_HEADLESS` / `CALLTOOLS_GATEWAY_START_ATTEMPTS` | gateway launcher env | `true` / `6` | Headless Playwright mode and bounded registration retry count for `npm run calltools:gateway`. Keep headless enabled in automation; set `CALLTOOLS_GATEWAY_HEADLESS=false` only for local diagnosis. |
| `CALLTOOLS_GATEWAY_STALE_AFTER_MS` | backend env | `45000` | Maximum heartbeat age for a registered CallTools gateway to count as healthy. Gateway summaries include `lastSeenAgeMs`, `healthy`, and `stale`; readiness does not count stale gateway websockets as connected. |
| `CALLTOOLS_VOICE_READY_TIMEOUT_MS` | backend env | `8000` | Maximum time a CallTools call may wait for Hume input readiness or Inworld `session.updated`. Expiry sends a stream-correlated rejection and ends the SIP call fail closed instead of leaving a human connected to silence. |
| `CALLTOOLS_VOICE_STANDBY_TTL_MS` | backend env | `300000` | Maximum lifetime of the exact lease/profile/user/campaign/phone-scoped Hume/Inworld/xAI standby session kept warm while Speak is Available. Expiry closes an unclaimed provider socket; the availability monitor may prepare a fresh standby only while the same frozen lease remains valid. |
| `CALLTOOLS_READINESS_REQUEST_TIMEOUT_MS` | backend env | `5000` | Per-upstream CallTools API read timeout used by `/api/calltools/readiness` and `npm run calltools:agent-session`. Readiness fans out native CallTools reads in parallel and returns explicit `*_READ_FAILED` blockers when the provider is slow instead of hanging, timing out at the edge, or falling back to browser automation or dashboard automation. |
| `CALLTOOLS_DUTY_MONITOR_INTERVAL_MS` | backend env | `5000` | Reconciliation interval for the always-on, server-owned CallTools availability lease. An active Available lease freezes the selected profile/app-user/campaign/phone assignment and repairs native readiness, campaign/gateway drift, SIP registration, and profile binding until the operator explicitly selects Go unavailable. An Unavailable request persists as `disarming` and is retried only toward native `ready=false` plus proved SIP unregistration; it is never converted back into Available by a retry. |
| `CALLTOOLS_WATCHDOG_INTERVAL_MS` | backend env | `300000` | VM-resident call-quality audit cadence. The watchdog wakes in the Speak backend, performs work only while the persisted CallTools Available lease is active, and stops semantic/provider usage while Speak is Unavailable. |
| `CALLTOOLS_WATCHDOG_STATE_PATH` | backend env | `workspace-data/calltools-watchdog.json` | Durable idempotency, incident, repair, semantic-review usage, and bounded run-history proof. The file stays on the VM and survives backend restarts; raw transcript evidence is not returned by the public status endpoint. |
| `CALLTOOLS_WATCHDOG_MODEL` | backend env | `gpt-5.6-sol` | VM Codex-auth model used to interpret new CallTools transcripts against natural turn-taking and the active agent instructions. Requests use `reasoning_effort=xhigh` and priority/fast service. This background reasoning is isolated from the live voice session and cannot make the agent think aloud. No request is made when there is no new transcript to review. |
| `CALLTOOLS_WATCHDOG_MISSING_RESPONSE_MS` / `CALLTOOLS_WATCHDOG_SLOW_RESPONSE_MS` | backend env | `10000` / `1680` | Deterministic thresholds for a caller turn with no assistant reply and first caller-stop-to-audible-assistant-audio latency. The latency default matches the median measured from separate caller/assistant channels in the retained Vapi benchmark recording; Speak prefers PCM-derived timing over transcript/provider-final timing. Incidents trigger safe availability/standby reconciliation but never mutate profile settings or silently release the Available lease. |
| `CALLTOOLS_WATCHDOG_SEMANTIC_TIMEOUT_MS` | backend env | `120000` | Bound for one batched xhigh semantic transcript review. Failure is retained as watchdog attention and retried for the same transcript fingerprint on the next cycle. |
| `CALLTOOLS_AGENT_SESSION_PATCH_TIMEOUT_MS` | backend env | `30000` | Separate upstream CallTools timeout for the `/api/calltools/agent-session` native `AgentStatus` PATCH. Keep this longer than readiness reads because CallTools can apply `ready` and webphone registration changes after a 5s read-style timeout; strict headless verifiers poll readiness after timeout-shaped patch results and still fail closed unless backend proof appears. |
| `CALLTOOLS_CAMPAIGN_SETTLE_MS` | readiness verifier env | `10000` | Maximum propagation window after backend/headless availability starts the selected campaign and requests its agent session. Strict `qa:calltools-readiness` waits for native campaign-agent/login proof; after this bound, it reports blockers and performs the requested final native AgentStatus release instead of consuming the longer provider mutation timeout. |
| `CALLTOOLS_CONTACT_SYNC_PAGE_SIZE` / `CALLTOOLS_CONTACT_SYNC_MAX_PAGES` | backend env | `100` / `250` | Pagination bounds for `/api/calltools/campaign-contacts/sync`. Speak reads the selected CallTools live filter or bucket through `/contacts/` with explicit `page` and `page_size` until `next` is empty, so multi-thousand-contact campaigns import completely without relying on one-page defaults. If the max page bound is reached, sync fails closed instead of silently truncating contacts. |
| `CALLTOOLS_PHONE_NUMBER_SYNC_PAGE_SIZE` / `CALLTOOLS_PHONE_NUMBER_SYNC_MAX_PAGES` | backend env | `500` / `250` | Pagination bounds for the CallTools `/phonenumbers/` enrichment pass used by campaign contact sync. CallTools large contact-source reads can omit phone fields, so Speak joins phone-number rows by contact ID with bounded bulk pagination instead of making one request per contact. |
| `GET /api/calltools/readiness` | backend read API | n/a | Read-only Phone-as-Agent preflight for API auth, agent user, WebRTC phone, Speak media gateway, campaign/caller ID/source health, dispositions, live calls, outcome writeback, and sanitized watchdog status. `runtimeReady` covers transport dependencies. `campaignReady` proves the campaign/session established by Go available: native AgentStatus readiness with `webPhoneRegisteredOn`, selected-campaign binding, `/campaignagents/{app_user_id}` readiness, active/originating campaign state, caller ID, source inventory, and aggregate agent counts. `dutyMonitor` reports the server-owned Available lease and frozen binding; the backend retains and repairs Available until explicit Go unavailable. |
| `GET /api/calltools/watchdog` | backend read API | n/a | Sanitized VM watchdog status, last run/repair/semantic-review status and model, and recent incident codes/call IDs. Token usage, raw transcript excerpts, and profile instructions stay only in the VM state file. |
| `POST /api/calltools/agent-session` | backend maintenance API | n/a | Programmatic backend/headless Available/Unavailable handoff used by the Dialer, `calltools:agent-session`, and strict `qa:calltools-readiness`. `ready=true` persists an `arming` lease with the frozen profile/app-user/campaign/phone assignment, confirms the shared seat is free, claims SIP, activates/originates the native campaign, and establishes campaign-agent plus AgentStatus state without a human login. Successful proof transitions to `on`. `ready=false` persists `disarming` and clears only after native `ready=false` plus SIP unregistration are proved; it does not deactivate the campaign needed for human handoff. Apply requires `apply=true` and `confirmAgentSession=true`. This route never direct-dials a contact. |
| `POST /api/calls/start` with CallTools | backend live-call API | unsupported | Returns `409 calltools_direct_start_disabled` after saved-profile resolution and before voice-provider reconciliation, gateway selection, AgentStatus mutation, or dialing. Use Go available to start the selected native CallTools campaign and durable agent lease. `/api/calls/start` remains supported for Speak/Telnyx direct calls and Playground Phone's transient Speak/Telnyx config. |
| `CALLTOOLS_SYNC_OUTCOMES` | backend env | `false` | When `true`, CallTools Phone-as-Agent call endings create a CallTools `HistoricalCallDisposition` record using the mapped Speak outcome and resolved CallTools call/contact/campaign IDs. When `false`, Speak still plans and logs the mapped disposition without mutating CallTools. |
| `CALLTOOLS_PROOF_REQUIRE_LATENCY` / `CALLTOOLS_PROOF_REQUIRE_AUDIO_QUALITY` | script env | `true` / `true` | Diagnostic latency/audio thresholds used by retained log readers. They remain useful evidence but do not by themselves certify a native campaign invite. |
| `CALLTOOLS_PROOF_MAX_ATTACH_TO_VOICE_SESSION_MS` | script env | `2000` | Maximum time from CallTools gateway attach to the active Hume/Inworld/xAI voice session opening or attaching. |
| `CALLTOOLS_PROOF_MAX_INVITE_TO_VOICE_INPUT_READY_MS` | script env | `2000` | Maximum time from an inbound CallTools SIP invite to the selected voice input path becoming ready. This prevents preconnect from being misreported as zero attach latency when readiness finishes before SIP answer. |
| `CALLTOOLS_PROOF_MAX_FIRST_USER_TO_ASSISTANT_AUDIO_MS` | script env | `5000` | Maximum time from the first caller/callee transcript turn to first assistant audio delivered back toward CallTools. This is the primary speech-to-speech responsiveness gate. |
| `CALLTOOLS_PROOF_MAX_FIRST_USER_TO_ASSISTANT_MESSAGE_MS` | script env | fallback for audio gate | Optional text-timing fallback. Assistant transcript-after-caller is still required separately, but text event timing is not the primary real-time audio responsiveness gate. |
| `CALLTOOLS_PROOF_MAX_ATTACH_TO_FIRST_ASSISTANT_AUDIO_MS` | script env | `10000` | Maximum time from CallTools gateway attach to first assistant audio delivered back toward CallTools. |
| `CALLTOOLS_PROOF_MAX_PROVIDER_AUDIO_TO_CALLTOOLS_AUDIO_MS` | script env | `1200` | Maximum transport time from first provider audio output to first CallTools media output frame. |
| `CALLTOOLS_PROOF_MAX_LEAD_AUDIO_TO_USER_MESSAGE_MS` / `CALLTOOLS_PROOF_MAX_DIAL_TO_GATEWAY_ATTACH_MS` | script env | disabled unless set | Optional diagnostic latency gates for caller-audio-to-user-message timing and CallTools-dial-to-gateway-attach timing. Keep unset unless measured production evidence proves a safe threshold. |
| `CALLTOOLS_PROOF_MAX_QUEUE_MS` / `CALLTOOLS_PROOF_MAX_DROPPED_FRAMES` | script env | `250` / `0` | Maximum outbound playback queue depth and dropped frame count for proof calls. |
| `CALLTOOLS_PROOF_MAX_INBOUND_CLIPPED_FRAMES` / `CALLTOOLS_PROOF_MAX_OUTPUT_CLIPPED_FRAMES` | script env | `0` / `0` | Maximum clipped inbound and final phone/CallTools output audio frames allowed during proof calls. Raw Hume/Inworld provider clipping is retained as diagnostic metadata, but the output gate measures the post-leveled audio that is actually sent to the phone path. |
| `CALLTOOLS_PROOF_MAX_ODD_BYTE_PAYLOADS` / `CALLTOOLS_PROOF_MAX_DECODE_ERRORS` | script env | `0` / `0` | Maximum malformed inbound PCM payload count and decode errors allowed during proof calls. |
| `CALLTOOLS_RECORDING_RECONCILE_DELAYS_MS` | backend env | `15000,60000,180000,600000,1800000,3600000` | Post-call retry schedule for resolving delayed CallTools `/calls/` recording metadata into the communication thread. The default keeps short retries for quick availability and then retries at roughly 10, 30, and 60 minutes because CallTools recording generation can lag behind call end. |
| `CALLTOOLS_RECORDING_LAG_GRACE_MS` | script env | `3600000` | Grace window for fresh CallTools calls before missing `/calls/` recording metadata is treated as a review warning. Inside the window, the recording-derived audit reports CallTools recording evidence as pending while still requiring Speak live transcript and local WAV proof. Keep this aligned with the longest production recording reconciliation retry unless production intentionally waits longer. |
| `CALLTOOLS_PROVIDER_ARTIFACT_GRACE_MS` / `CALLTOOLS_HISTORICAL_CALL_START_TOLERANCE_MS` | script/backend env | `3600000` / `900000` | Recording-derived audit and historical-call matching windows. The provider artifact grace controls how long fresh CallTools recordings may remain pending before audit warnings harden; the start tolerance scopes `/calls/` lookup around the Speak call start so delayed or timezone-shifted provider rows do not attach to the wrong call. |
| `CALLTOOLS_FULL_AUDIT_RECORDING_TRANSCRIPT_WAIT_MS` / `CALLTOOLS_FULL_AUDIT_RECORDING_TRANSCRIPT_POLL_MS` / `--calltoolsRecordingTranscriptWaitMs=<ms>` / `--calltoolsRecordingTranscriptPollMs=<ms>` | full-audit env/flag | `1200000` / `60000` | Wait/poll window for attaching required recording-derived review to a supplied native campaign proof. The standalone read-only recording audit can perform the same review for one completed campaign call. |
| `npm run qa:calltools-live-proof -- --require-complete --callControlId=<id>` | production proof script | VM call log/audio | Validates one actual native campaign-routed call and emits `speak.calltools.campaign-proof.v1`. It requires selected Available lease/campaign/profile identity, answered attach, caller-before-assistant transcript order, two-sided audio, latency/quality gates, and retained WAV evidence. It never starts a call. |
| `qa:full-audit -- --include-live` | full-audit flag | disabled | Campaign-follow certification orchestration. It arms the selected durable Available lease, waits for a new native answered campaign invite, captures `speak.calltools.campaign-proof.v1`, and explicitly releases only the lease it armed during cleanup. It never direct-dials a CallTools contact. |
| `CALLTOOLS_CAMPAIGN_PROOF_WAIT_MS` / `--campaignProofWaitMs=<ms>` / `--liveProofWaitMs=<ms>` | full audit/live proof env/flag | `180000` | Maximum time `--include-live` waits for a new answered native campaign invite after availability is established. |
| `CALLTOOLS_CAMPAIGN_PROOF_POLL_MS` / `--campaignProofPollMs=<ms>` / `--liveProofPollMs=<ms>` | full audit/live proof env/flag | `2000` | Poll interval while the campaign-follow proof observer waits for the new Speak call log entry and required evidence. |
| `CALLTOOLS_LIVE_PROOF_WAIT_MS` / `--waitMs=<ms>` | live proof env/flag | `0` standalone; full audit supplies its campaign wait | Maximum time the read-only proof observer waits for a qualifying native campaign call-log entry. It never initiates a call. |
| `CALLTOOLS_LIVE_PROOF_POLL_MS` / `--pollMs=<ms>` | live proof env/flag | `2000` | Poll interval while waiting for the native campaign call and its required proof fields. |
| `CALLTOOLS_LIVE_PROOF_MIN_CALLER_TURNS` / `CALLTOOLS_LIVE_PROOF_MIN_ASSISTANT_TURNS` | script env | `2` / `2` | Minimum two-sided transcript turns required by `speak.calltools.campaign-proof.v1`. |
| `CALLTOOLS_S_TIER_LIVE_PROOF_JSON` / `CALLTOOLS_PRODUCTION_LIVE_PROOF_JSON` / `--liveProof=<file>` / `--proof=<file>` | full audit/S-tier env/flag | empty | Path to a saved `speak.calltools.campaign-proof.v1` artifact generated from an actual native campaign-routed call by `qa:calltools-live-proof -- --require-complete --callControlId=<id>`. Final S-tier certification also requires recording-derived review. |
| `SPEAK_FULL_AUDIT_LIVE_PROOF_MAX_AGE_MS` / `CALLTOOLS_S_TIER_LIVE_PROOF_MAX_AGE_MS` / `--liveProofMaxAgeMs=<ms>` | full audit/S-tier env/flag | `86400000` | Maximum accepted age for a supplied native campaign proof. Freshness, identity consistency, live log replay, and recording-derived review must all pass. |
| `SPEAK_FULL_AUDIT_CERTIFY` / `--certify` / `--require-certification` | full audit env/flag | disabled | Strict release mode. For CallTools, supply a current `speak.calltools.campaign-proof.v1` artifact plus recording-derived review or combine with the reworked campaign-follow `--include-live`. Build, API, UI, readiness, provider, live-log replay, and recording checks must all pass. JSON reports `coverageMode=certification`; the default non-certification run reports `coverageMode=regression`. |
| `CALLTOOLS_AGENT_SESSION_PROFILE_ID` / `CALLTOOLS_AGENT_SESSION_TIMEOUT_MS` / `CALLTOOLS_AGENT_SESSION_POLL_MS` / `--calltoolsAgentSessionTimeoutMs=<ms>` / `--calltoolsProfileId=<id>` / `--profileId=<id>` | `calltools:agent-session`, `qa:calltools-readiness`, and full audit env/flag | backend-selected active profile / `180000` / `5000` | Backend/headless Available/Unavailable establishment and campaign-readiness polling bounds. With no profile pin, helpers adopt the backend-selected profile. Apply requires explicit confirmation, and strict readiness requires native AgentStatus, selected-campaign, webphone, `/campaignagents/{app_user_id}`, and aggregate campaign proof. |
| `--pause-after-ready` | CallTools readiness flag | disabled | After a strict non-live readiness proof, explicitly returns native AgentStatus to Unavailable. It is not used by campaign-follow live proof, which keeps the selected lease Available until its own bounded cleanup. |
| `CALLTOOLS_READINESS_CAMPAIGN_ID` / `CALLTOOLS_CAMPAIGN_ID` / `--calltoolsCampaignId=<id>` / `--campaignId=<id>` | full audit/live proof env/flag | campaign from selected lease | Optional fail-closed campaign identity pin for campaign-follow proof. It must match the selected durable lease and native invite evidence. |
| `--allow-pending-calltools-recording-transcript` | full-audit flag | disabled | Diagnostic escape hatch only. It cannot be used for certification because `speak.calltools.campaign-proof.v1` S-tier requires completed recording-derived review. |
| `CALLTOOLS_FULL_AUDIT_RECORDING_TRANSCRIPT_LOG` / `SPEAK_CALLTOOLS_PROOF_LOG` / `--calltoolsRecordingLog=<file>` / `--log=<file>` | recording audit env/flag | recent operational logs | Optional call-log override for CallTools recording-derived transcript review. Direct `audit:calltools-recording-transcript` runs with only `--callControlId` scan recent operational logs before falling back to the current day, so native campaign calls remain discoverable after UTC midnight. A call-log override is diagnostic evidence only and does not certify campaign following. |
| `CALLTOOLS_FULL_AUDIT_RECORDING_AUDIO_DIR` / `--calltoolsRecordingAudioDir=<dir>` / `--callAudioDir=<dir>` | full audit env/flag | `CALL_AUDIO_DIR` or audit default | Optional local/remote call-audio directory override for the CallTools recording-derived transcript review. Use it only when proof audio artifacts are outside the standard `call-audio` directory. |
| `CALLTOOLS_FULL_AUDIT_RECORDING_FILE` / `--calltoolsRecordingFile=<file>` / `--recordingFile=<file>` | full audit env/flag | empty | Optional CallTools recording audio file override to pass into recording-derived transcript review. Without this override, the full audit uses `call_recording_fsfile_id` from the historical `/calls/` row to download `/filesystemfiles/{id}/download/` and generate the recording-derived transcript. The provider download is preferred over this manual override. |
| `npm run audit:calltools-recording-transcript` | operator script | read-only by default | Compares Speak call-log transcript turns and local WAV audibility against the transcript Speak generates from CallTools `/calls/` recording metadata. Fresh calls inside `CALLTOOLS_RECORDING_LAG_GRACE_MS` may report `clean_pending` while CallTools finishes recording generation. Short live-STT fragments corrected by the recording-derived transcript report as `LIVE_SPEAK_STT_CORRECTED_BY_PROVIDER_RECORDING`; material missing Speak turns remain warning-level gaps. Pass `--transcribeRecording` to download/transcribe the CallTools recording when `call_recording_fsfile_id` is available; `--recordingFile=<file> --transcribeRecording` is only a manual override when CallTools download is unavailable. |
| `npm run audit:calltools-recording-rhythm` | operator script | read-only by default | Profiles CallTools `/calls/` recording-reference timing only. Options include `--appUserId`, `--destination` or `--to`, `--date`, `--dateRange`, `--limit`, `--include-internal`, and `--json`; matching env aliases are `CALLTOOLS_RECORDING_RHYTHM_APP_USER_ID` / `CALLTOOLS_APP_USER_ID`, `CALLTOOLS_RECORDING_RHYTHM_DESTINATION`, `CALLTOOLS_RECORDING_RHYTHM_DATE`, `CALLTOOLS_RECORDING_RHYTHM_DATE_RANGE`, and `CALLTOOLS_RECORDING_RHYTHM_LIMIT`. Use this before changing provider recording retry windows. |
| `npm run calltools:transcribe-recording` | operator script | Inworld STT | Generates a recording-derived transcript from a CallTools recording file. |
| `CALLTOOLS_RECORDING_STT_MODEL` / `CALLTOOLS_RECORDING_STT_LANGUAGE` | script env | `inworld/inworld-stt-1` / `en-US` | Optional STT override for Speak-generated transcripts from CallTools recording audio. Requires `INWORLD_API_KEY`. |
| `SPEAK_LINK_URL` | backend env | empty | Optional default URL for the confirmed link-delivery helper. Generic `send_text_message` and `send_email` use explicit content from the active agent instructions. |
| `WORKSPACE_EMAIL_ACCOUNT` | backend env | empty | Sender/readback email account for workspace email sends and replies. |
| `WORKSPACE_EMAIL_GOG_ACCOUNT_READS_MAILBOX` | backend/checker/script env | `false` | Set only after `npm run qa:workspace-email-source` verifies `WORKSPACE_EMAIL_READ_GOG_ACCOUNT` can actually read `WORKSPACE_EMAIL_ACCOUNT` through delegation, routing, or a broker. Gmail read scope on a different auth account is not enough by itself to prove source-read readiness for the visible mailbox, and `/api/workspace-email/sync` fails closed without this proof when the read auth account differs from the mailbox. |
| `WORKSPACE_EMAIL_TIMEOUT_MS` | backend env | `45000` | Email send timeout. |
| `TELNYX_SMS_TIMEOUT_MS` | backend env | `15000` | Telnyx SMS request timeout. |
| `TELNYX_SMS_FINALIZATION_TIMEOUT_MS` | backend env | `30000` | Background-only limit for correlating an accepted SMS with `message.finalized` or readback proof. The voice tool still returns `processing` immediately; a timeout becomes `accepted_unverified`, never sent proof. |
| `TELNYX_SMS_FINALIZATION_POLL_MS` | backend env | `2000` | Read-only Telnyx message-status polling interval used when a signed finalization webhook is late or was missed. It never resends the SMS. |
| `TELNYX_SMS_FINALIZATION_READ_TIMEOUT_MS` | backend env | `8000` | Per-request timeout for read-only Telnyx message-status recovery after acceptance or restart. |
| `WORKSPACE_EMAIL_SYNC_QUERY` | backend env / script env | participant-scoped 30-day query for `WORKSPACE_EMAIL_ACCOUNT` | Optional explicit Gmail query for `npm run sync:workspace-email`. When unset, Speak searches for messages where `WORKSPACE_EMAIL_ACCOUNT` is a sender/recipient/cc/bcc participant. |
| `WORKSPACE_EMAIL_SYNC_WINDOW` | backend env / script env | `30d` | Lookback window used by the default participant-scoped Workspace/Gmail sync query. |
| `WORKSPACE_EMAIL_SYNC_LIMIT` | backend env / script env | `50` | Default maximum Gmail messages fetched per Workspace email sync run. |
| `WORKSPACE_EMAIL_SYNC_TIMEOUT_MS` | backend env / script env | `60000` | Timeout for the GOG-backed Gmail sync read. |
| `SPEAK_API_BASE_URL` | script env | `PUBLIC_BASE_URL`, then local API | Backend API base for `npm run sync:workspace-email -- --apply` when the sync script writes normalized messages through Speak instead of only dry-running the Gmail read. |
| `SPEAK_COMMUNICATION_BACKFILL_LIMIT` | script env | `5000`, capped at `50000` | Default call-log scan limit for `npm run backfill:communication-threads` when `--limit=<n>` is not supplied. Dry-run remains the default; `backfill:communication-threads:apply` is required before writing historical call summaries into communication threads. |
| `WORKSPACE_EMAIL_SOURCE_SAMPLE_WINDOW` | checker/script env | `90d` | Lookback window used by `npm run qa:workspace-email-source` when proving the auth account can observe a mailbox participant sample. |
| `WORKSPACE_EMAIL_SOURCE_SAMPLE_LIMIT` | checker/script env | `25` | Maximum Gmail messages fetched by the source sample proof. |
| `WORKSPACE_EMAIL_AUTH_CHECK_TIMEOUT_MS` | backend env | `60000` | Bounded startup/background-probe timeout for verifying the configured GOG Gmail account and send-as proof. The encrypted production GOG keyring can take tens of seconds to open under VM contention; request and voice-turn paths never synchronously wait on this process. |
| `WORKSPACE_EMAIL_AUTH_CHECK_CACHE_MS` | backend env | `300000` | Stale-safe cache window for non-blocking Gmail auth and send-as readiness. Expired proof is returned while one background refresh runs, avoiding repeated encrypted-keyring opens; a completed failed refresh replaces it with fail-closed `false`. |
| `WORKSPACE_EMAIL_AUTH_CHECK_RETRY_MS` | backend env | `5000` | Retry window after a transient failed GOG readiness probe; failure remains fail-closed but is not cached for the full success interval. |
| `npm run qa:workspace-email` | production check | n/a | Verifies `WORKSPACE_EMAIL_ACCOUNT`, read GOG auth, Gmail read scope for source sync, send GOG auth, Gmail send/compose scope for replies, accepted send-as identity, and whether the send auth account has Gmail settings scope to manage a missing send-as alias. |
| `npm run qa:workspace-email-source` | production check | n/a | Runs a bounded Gmail read through `WORKSPACE_EMAIL_READ_GOG_ACCOUNT` and requires at least one normalized message involving `WORKSPACE_EMAIL_ACCOUNT`, without printing email subjects or bodies. |
| `npm run repair:workspace-email-sendas` | production repair | n/a | Dry-runs Workspace email reply repair. It lists the current Gmail send-as aliases and either reports accepted readiness, says `repair:workspace-email-sendas:apply` can create the alias, or prints the exact GOG reauthorization command required for Gmail settings scope. |
| `npm run repair:workspace-email-sendas:apply` | production repair | n/a | Creates the `WORKSPACE_EMAIL_ACCOUNT` send-as alias for `WORKSPACE_EMAIL_SEND_GOG_ACCOUNT` only when the send auth account already has Gmail settings scope. It does not bypass Gmail verification; rerun `qa:workspace-email` after the alias is accepted. |
| `npm run repair:workspace-email-sendas:auth-url` | production repair | n/a | Generates the remote Google consent URL for `WORKSPACE_EMAIL_SEND_GOG_ACCOUNT` with full Gmail plus `gmail.settings.basic` and `gmail.settings.sharing` scopes. Use this when `qa:workspace-email` says the send auth account cannot manage send-as aliases. |
| `npm run repair:workspace-email-sendas:auth-complete -- --auth-url '<redirected-localhost-url>'` | production repair | n/a | Completes the GOG OAuth exchange from the copied localhost redirect URL, runs `repair:workspace-email-sendas:apply`, then runs `qa:workspace-email` so reply readiness is checked immediately after the auth repair. |
| `WORKSPACE_EMAIL_THREAD_REPAIR_ACCOUNT` / `--account=<email>` / `--mailbox=<email>` | repair script env/flag | `WORKSPACE_EMAIL_ACCOUNT` | Mailbox identity targeted by `npm run repair:workspace-email-thread-identity`. The default dry-run lists unresolved Workspace mailbox identity-link repairs; the apply variant writes only the reviewed repairs. |
| `npm run repair:workspace-email-thread-identity` | production repair | n/a | Dry-runs unresolved Workspace mailbox-attributed thread IDs that should move to external-thread-only IDs without treating `WORKSPACE_EMAIL_ACCOUNT` as a customer identity. |
| `npm run repair:workspace-email-thread-identity:apply` | production repair | n/a | Applies only the reviewed Workspace email thread-identity repairs from the dry-run list and moves affected messages/topics to the corrected external thread identity. |
| `npm run repair:communication-source-dedup` | production repair | n/a | Dry-runs duplicate communication message cleanup for rows that share the same native provider source event after attribution or normalizer repairs. |
| `npm run repair:communication-source-dedup:apply` | production repair | n/a | Removes only reviewed duplicate communication message rows with the same native provider source event and rebuilds affected thread summaries. |
| `WORKSPACE_EMAIL_SENDER_NAME` | backend env | `Speak` | Email display sender. |
| `WORKSPACE_SMS_SENDER_NAME` | backend env | `WORKSPACE_EMAIL_SENDER_NAME`, then `Speak` | Workspace/brand prefix used only by the configured portal-link SMS alias. The alias keeps the full first-party URL and STOP language; generic `send_text_message` content remains agent-authored and unchanged. |
| `GOG_WRAPPER` | backend env | empty | Optional command path for the Workspace/Gmail account broker used by source sync and sending. Configure it explicitly when enabling Workspace email; Speak fails closed when it is unavailable. |
| `HOME` | CallTools gateway service env | deployment-defined | Runtime home for a persistent CallTools gateway service. |
| `PLAYWRIGHT_BROWSERS_PATH` | CallTools gateway service env | deployment-defined | Playwright browser bundle used by the persistent CallTools gateway. |
| `SPEAK_COMMUNICATION_AUTOMATION_POLICY` | backend env | empty | Optional structured global automation policy text/JSON. Explicit fixed-reply directives only; no vague natural-language permission. |
| `SPEAK_SMS_AUTO_REPLY_BODY` | backend env | empty | Optional global fixed SMS auto-reply body. Empty means no SMS auto-response. |
| `SPEAK_EMAIL_AUTO_REPLY_SUBJECT` | backend env | `Re: {subject}` when body is set | Optional global fixed email auto-reply subject. |
| `SPEAK_EMAIL_AUTO_REPLY_BODY` | backend env | empty | Optional global fixed email auto-reply body. Empty means no email auto-reply. |
| `SPEAK_INBOUND_CALL_AUTO_ANSWER` | backend env | empty/off | Optional explicit inbound call auto-answer directive. Empty/off keeps calls proof-only; enabled answers attributed inbound Telnyx calls with Speak's bidirectional media stream and records backend proof. |

To add another Workspace mailbox, run the repair auth flow with `--send-auth-account <mailbox>` or use the equivalent `gog auth add <mailbox>` command. Do not delete existing GOG accounts when adding a mailbox; Speak selects the production sender with `WORKSPACE_EMAIL_SEND_GOG_ACCOUNT` and the source reader with `WORKSPACE_EMAIL_READ_GOG_ACCOUNT`.

Production Telnyx source routing must pass `npm run qa:telnyx-source-routing`
on the production host before SMS inbox/outbox or inbound-call source ingestion
is considered end-to-end configured. The check verifies the configured phone
number belongs to `TELNYX_MESSAGING_PROFILE_ID`, is attached to
`TELNYX_CONNECTION_ID`, both Telnyx webhook URLs equal
`TELNYX_WEBHOOK_URL`, and Speak has `TELNYX_WEBHOOK_SIGNATURE_REQUIRED=true`
with at least one Telnyx public signing key configured and parseable by the
same verifier used by the production webhook route.

## Codex CLM And Smart Config

| Option | Scope | Default | Purpose |
| --- | --- | --- | --- |
| `CODEX_CLM_PUBLIC_URL` | backend env | derived from `PUBLIC_BASE_URL` | OpenAI-compatible CLM endpoint URL for voice sessions. |
| `CODEX_CLM_API_KEY` | backend env | required for Codex CLM | Bearer token expected by CLM endpoint. |
| `CODEX_CLM_DEFAULT_MODEL` | backend env/profile | `gpt-5.5` | Default Codex-auth language model. |
| `CODEX_AUTH_PROXY_BASE_URL` | backend env | `http://127.0.0.1:48765/v1` | Local Codex auth proxy base. |
| `CODEX_AUTH_PROXY_READINESS_TIMEOUT_MS` | backend env | `5000` | Cold local-proxy readiness request bound. |
| `CODEX_AUTH_PROXY_READINESS_CACHE_MS` | backend env | `30000` | Successful per-model Speak readiness cache lifetime. |
| `CALLTOOLS_CODEX_READINESS_PROOF_TTL_MS` | backend env | `15000` | Maximum age of the cache-only Codex proof consumed by a native CallTools invite. |
| `CODEX_CLM_STREAM_INITIAL_RESPONSE_MS` | backend env | `45000` | Maximum wait for the first upstream SSE event. A miss fails closed instead of returning a successful empty voice turn. |
| `CODEX_CLM_STREAM_IDLE_AFTER_OUTPUT_MS` | backend env | `2500` | Fail-safe idle timeout only when an upstream stream omits both `[DONE]` and a terminal `finish_reason`. A terminal finish closes immediately. |
| `CODEX_CLM_MODEL_FOLLOWUP_AFTER_TOOLS` | backend env | not true | Whether CLM follows up after tool calls. |
| `SPEAK_SMART_CONFIG_ENABLED` | backend env | enabled unless `false` | Owner Smart Config availability. |
| `SPEAK_SMART_CONFIG_TOKEN` | backend env | empty | Owner/debug bearer token. |
| `SPEAK_SMART_CONFIG_AUTH_MODE` | backend env | token/session inferred | Smart Config auth mode. |
| `SPEAK_SMART_CONFIG_TRUST_OWNER` | backend env | false | Trust configured owner identity. |
| `SPEAK_SMART_CONFIG_TRUSTED_EMAIL` | backend env | `WORKSPACE_EMAIL_ACCOUNT` fallback | Trusted owner email. |
| `SPEAK_SMART_CONFIG_TRUSTED_NAME` | backend env | `Owner` | Trusted owner display name. |
| `SPEAK_SMART_CONFIG_SESSION_SECRET` | backend env | owner token fallback | Session signing secret. |
| `SPEAK_SMART_CONFIG_SESSION_DAYS` | backend env | `30` | Session lifetime. |
| `SPEAK_SMART_CONFIG_ALLOWED_EMAILS` | backend env | workspace email fallback | OAuth/session allowed emails. |
| `SPEAK_SMART_CONFIG_ALLOWED_DOMAINS` | backend env | empty | OAuth/session allowed domains. |
| `SPEAK_SMART_CONFIG_PUBLIC_BASE_URL` | backend env | `PUBLIC_BASE_URL` fallback | Public base for Smart Config auth redirects. |
| `SPEAK_GOOGLE_OAUTH_CLIENT_ID` | backend env | alias chain | Google OAuth client ID. |
| `SPEAK_GOOGLE_OAUTH_CLIENT_SECRET` | backend env | alias chain | Google OAuth client secret. |
| `SPEAK_GOOGLE_OAUTH_REDIRECT_URI` | backend env | derived | Explicit OAuth redirect URI. |
| `SPEAK_SMART_CONFIG_CODEX_MODEL` | backend env | `gpt-5.5` | Smart Config Codex model. |
| `SPEAK_SMART_CONFIG_CODEX_EFFORT` | backend env | `xhigh` | Smart Config reasoning effort. |
| `SPEAK_SMART_CONFIG_CODEX_SERVICE_TIER` | backend env | `priority` | Smart Config service tier. |
| `SPEAK_SMART_CONFIG_TURN_TIMEOUT_MS` | backend env | `600000` | Smart Config turn timeout. |

Before Speak starts a Hume Codex-auth session, it calls the local proxy's
`GET /v1/readiness?model={model}` contract to prove both authenticated model
availability and current usage allowance. Speak uses a five-second request bound
and a 30-second successful-result cache, retained independently per configured
model, and asynchronously prewarms saved Hume Codex profiles after the HTTP
server begins listening. While Speak owns a CallTools lease, the backend
availability monitor and standby replenishment force-refresh a shorter-lived
proof outside the SIP hot path. The native invite consumes only a fresh local
proof and performs no provider I/O; a failed refresh invalidates the proof before
the next invite. The proxy returns only sanitized readiness fields. A
`usage_limit_reached` becomes a sanitized HTTP `429` error with `reset_at` when
available, while auth, model, and other readiness failures remain fail-closed
HTTP `503` errors. Hume-native and every Inworld runtime bypass this local proxy
check. This preflight performs no generation canary.

## Context Knowledge Flags

| Option | Scope | Default | Purpose |
| --- | --- | --- | --- |
| `SPEAK_CONTEXT_FILE_UPLOAD_MAX_BYTES` | backend env | `104857600` | Maximum uploaded context file size. |
| `SPEAK_CONTEXT_FILE_PREVIEW_BYTES` | backend env | `16384` | Preview bytes retained for files. |
| `SPEAK_RUNTIME_CONTEXT_CHARS` | backend env | `12000` | Compact runtime context budget. |
| `SPEAK_RUNTIME_CONTEXT_TEXT_CHARS` | backend env | `4000` | Runtime text budget per context text source. |
| `SPEAK_CONTEXT_TOOL_CHARS` | backend env | `60000` | Full context-tool response budget. |
| `SPEAK_CONTEXT_TOOL_ITEM_CHARS` | backend env | `12000` | Per-item context-tool budget. |
| `SPEAK_CONTEXT_EXTRACTED_TEXT_CHARS` | backend env | `200000` | Extracted text retention limit. |
| `SPEAK_CONTEXT_URL_FETCH_MAX_BYTES` | backend env | `2097152` | Max bytes fetched from a context URL. |
| `SPEAK_CONTEXT_URL_FETCH_TIMEOUT_MS` | backend env | `2500` | URL refresh timeout. |
| `SPEAK_CONTEXT_URL_REFRESH_TTL_MS` | backend env | `300000` | Cached URL snapshot TTL. |
| `SPEAK_CONTEXT_URL_REFRESH_MAX` | backend env | `8` | Max URL refreshes before a session. |

## QA And Generated Manifests

| Option | Scope | Default | Purpose |
| --- | --- | --- | --- |
| `SPEAK_QA_BASE_URL` | QA env | `http://127.0.0.1:5173/speak` | Browser QA target. |
| `SPEAK_QA_API_ROOT` | QA env | `http://127.0.0.1:8787/api` | MCP/app verifier API target. |
| `SPEAK_QA_FAIL_CONSOLE` | QA env | empty; full audit sets `1` for rendered UI | Fail UI contract on relevant console warnings or errors when `1`. |
| `SPEAK_QA_EXPECTED_TITLE` | QA env | `Speak` | Expected document title for rendered UI contract checks. |
| `SPEAK_QA_ONLY_CALLTOOLS_AVAILABILITY` / `SPEAK_QA_ONLY_PLAYGROUND_CALL_METHODS` | UI contract QA env | empty | Focused rendered-browser modes for the CallTools availability lifecycle or Playground call-method matrix. They skip unrelated viewport sweeps and never change production runtime behavior. |
| `SPEAK_QA_ISOLATED_BACKEND_START_TIMEOUT_MS` | QA env | `60000` | Bounded startup allowance for the backend API verifier's isolated test process. This absorbs cold module parsing on a loaded development host and does not change production call-connect latency or provider timing. |
| `SPEAK_QA_TRANSCRIPT_BASE_URL` | QA env | local or supplied base URL | Optional base URL for transcript-rendering production scans. |
| `SPEAK_BASE_URL` | script env | `PUBLIC_BASE_URL`, then production `/speak` URL in CallTools scripts | Shared Speak app/API base used by CallTools readiness, campaign proof, and agent-session scripts. Prefer this for headless backend checks that should target the deployed Speak surface without browser automation. |
| `SPEAK_BACKEND_API_BASE_URL` | QA env | `SPEAK_QA_API_ROOT`, then local API | Backend API base for `npm run qa:backend-api` live endpoint readback. |
| `SPEAK_FULL_AUDIT_BASE_URL` / `--baseUrl=<url>` | full audit env/flag | `http://127.0.0.1:5173/speak` | Local rendered app URL used by `qa:full-audit` when it runs the non-production browser checks. |
| `SPEAK_FULL_AUDIT_PRODUCTION_BASE_URL` / `--productionBaseUrl=<url>` | full audit env/flag | `PUBLIC_BASE_URL` or `https://speak.example.com/speak` | Production Speak base used for production/readiness/live-proof flows. |
| `SPEAK_FULL_AUDIT_RENDERED_BASE_URL` / `--renderedBaseUrl=<url>` | full audit env/flag | production URL when production/SSH mode is active; otherwise local base | Rendered UI target for `qa:ui-contract` inside `qa:full-audit`. |
| `SPEAK_FULL_AUDIT_DEV_HEALTH_URL` / `--devHealthUrl=<url>` | full audit env/flag | `http://127.0.0.1:8787/api/health` | Local backend health URL the full audit waits on before running local rendered checks. |
| `SPEAK_FULL_AUDIT_SSH_HOST` / `--sshHost=<host>` | full audit env/flag | empty | SSH host used for production-parity checks. Supplying it makes the full audit use production mode for rendered UI and provider/readiness lanes. |
| `SPEAK_FULL_AUDIT_REMOTE_CWD` / `--remoteCwd=<path>` | full audit env/flag | `/opt/speak` | Remote deployment path used only when `--sshHost` explicitly runs production-parity checks. |
| `--production` / `--include-production` | full audit flag | disabled | Enables production provider-routing checks. `--sshHost` also selects production mode. |
| `--skip-build` / `--skip-rendered-ui` | full audit diagnostic flags | disabled | Bounded diagnostics only. Strict `--certify` rejects either skip because release certification requires both production build and rendered-browser proof. |
| `--recordingReview=<json-or-file>` | full audit flag | empty | Optional completed recording-derived review attached to a newly observed native campaign proof. Certification still requires the review to be clean and tied to the same call. |
| `SPEAK_FULL_AUDIT_LIVE_PROOF_DIR` / `--liveProofDir=<path>` | full audit env/flag | temp directory | Directory where `qa:full-audit --include-live` writes a generated CallTools campaign-proof artifact before recording-derived review. |
| `SPEAK_PRODUCT_PAGE_URL` | docs/brand QA env | `https://speak.split-llc.com/` | Published product/docs URL fetched by `qa:brand-marketing -- --published` to verify the current public showcase. |
| `SPEAK_INWORLD_LATENCY_CHECK_BASE_URL` / `SPEAK_INWORLD_LATENCY_CHECK_PROFILE_ID` | QA env | empty / empty | Optional live target and exact profile for the Inworld latency contract checker. With a live target and no profile ID, the checker validates every actual Inworld runtime profile and ignores dormant Inworld fields on Hume profiles. An explicit non-Inworld profile fails closed. Without a live target, it validates local source/docs defaults only. |
| `INWORLD_TOOL_CAPABILITY_MODEL` | no-call capability-probe env | `google-ai-studio/gemini-3.5-flash` | Model used by `scripts/probe-inworld-tool-capability.mjs`. The default mode performs a one-session `session.update` schema check without generating a response. Add `--audio-smoke --voice=<provider-voice-id>` to generate one internal `Ready` response and require real `response.output_audio.delta` bytes; `--fast-mode`, `--conversational`, and `--reasoning-effort=<level>` exercise those session features. Use `--omit-reasoning` to prove a native model whose live capability does not advertise reasoning. The probe never mutates a saved profile or calls a person. |
| `GOG_FAKE_LOG` | test env | temporary fixture path | Internal communication-thread verifier fixture log used to prove GOG wrapper behavior without reading real mailbox content. Not a production runtime setting. |
| `GOG_FAKE_SEND_ARGS_FILE` / `GOG_FAKE_SEND_OUTPUT` | test env | temporary fixture path / `{}` | Internal communication-thread verifier controls for capturing fake GOG send arguments and returning a deterministic fake provider response. They never configure the production Workspace sender. |
| `CALLTOOLS_PHONE_NUMBER` | test env | `+15550000000` fixture | Internal communication-thread verifier value used to prove CallTools caller IDs are not reused as Speak SMS senders. Production SMS always uses a configured Telnyx number. |
| `SPEAK_API_ROOT` | manifest env | derived | UI snapshot API root. |
| `SPEAK_UI_SURFACE` | manifest env | `dialer` | UI snapshot surface. |
| `SPEAK_UI_LIMIT` | manifest env | `12` | UI snapshot row/item limit. |
| `SPEAK_AUTHORIZATION_MODE` | manifest env | empty | Authorization metadata in UI snapshot. |
| `NODE_ENV` | backend/process env | runtime-managed | Standard Node environment selector. Production and test processes set it externally; Speak does not use it for credentials or provider routing. |

Run `npm run qa:voice-provider-process` before adding a new speech-to-speech
runtime. It verifies the provider onboarding playbook, core feature matrix,
optimization audit, and MCP/CLI/SDK discovery requirements. Run
`npm run qa:voice-configs` after voice-runtime or profile-setting changes. It
verifies that Hume and Inworld expose provider-native and Codex-auth model
choices separately, while xAI exposes only native Voice Agent models. Hume retains the authenticated Codex catalogue. Inworld
exposes only its live intersection with `/llm/v1alpha/models`, and each routed
model carries its current `reasoningCapability.supportedLevels`. A model absent
from the Inworld catalogue must not appear in the Inworld controls. Native and
Codex-auth models whose live capability says function calling is unavailable
must also be excluded because production Speak sessions require shared tools;
when input/output modalities are advertised, both must include text.
Run `npm run qa:xai-voice-runtime` for the xAI catalog/config contract, or
`node scripts/check-xai-voice-runtime.mjs --live` for a no-phone live Realtime
instruction, transcript, audio, and resumption probe.
Native models that do not advertise reasoning support omit
`text_generation_config.reasoning` instead of sending an unsupported field. While
shared Speak tools are active, Inworld reasoning is fixed to `None` because
that provider route rejects function tools combined with nonzero effort; older
saved nonzero values are sent as `NONE`, not forwarded into a router 400.

Voice option catalogs are credential-derived. Hume selectable voices must come
from the active `HUME_API_KEY` via `/tts/voices`, and Inworld selectable voices
must come from the active `INWORLD_API_KEY` via `/voices/v1/voices`. Speak may
retain a saved profile voice ID as unavailable state after an account switch,
but it must not synthesize provider voice dropdown options from static defaults.

## Profile And Campaign Options

Saved profile records move through `/api/profiles`, `/api/agent-configs/sync-speak`, `/api/calls/start`, and browser Playground test routes (`/api/config-tests/*`). The outer `profile` envelope is the durable saved-profile record; its nested `config` is the `CampaignConfig` runtime payload.

| Field | Type | Default | Frontend/backend meaning |
| --- | --- | --- | --- |
| `id` | string | generated profile ID | Durable saved-profile identity and active-profile pointer target. |
| `name` | string | `Untitled config` | Human-readable saved profile name shown in Playground and agent selectors. |
| `updatedAt` | ISO string | current time on write | Profile freshness and sort/readback timestamp. |
| `config` | `CampaignConfig` | normalized defaults | Runtime voice, dialer, model, provider, prompt, and phone settings listed below. |
| `testVariables` | object | empty strings | Browser/phone Playground test contact fields. The UI persists `first_name`, `last_name`, `full_name`, `business_name`, `contact_phone`, `contact_email`, and `notes`; the backend contract also accepts `portal_url` / `portalUrl` for link-delivery context. |
| `context` | `ContextFields` | empty | Saved Agent Knowledge Layer state. Runtime preparation normalizes this into `profileContext` on `CampaignConfig`. |

`CampaignConfig` fields:

| Field | Type | Default | Frontend/backend meaning |
| --- | --- | --- | --- |
| `instructions` | string | empty | Profile prompt instructions shown in Playground. |
| `agentProfileId` | string | profile ID | Saved profile identity. |
| `agentProfileName` | string | profile name | Human-readable agent label used in transcripts. |
| `agentProfileUpdatedAt` | ISO timestamp | empty for unsaved/ad hoc sessions | Server-injected saved-profile revision proof used to reconcile a newer provider profile once before session start. It is operational metadata, not an operator-editable setting. |
| `contactSource` | `personal-phone` or `calltools` | empty | Exact Library source owned by the profile. This source-of-record assignment prevents two profiles from claiming the same Personal Phone or CallTools source. Selecting the field alone performs no provider mutation; the Dialer Go available action starts the selected CallTools campaign. |
| `contactSourceId` | string | empty | Provider source ID for the selected source, such as `bluebubbles:contacts` or a CallTools campaign/live-filter source ID. Store the raw source ID; UI keys may encode it for dropdown selection only. |
| `smartViewId` | string | empty | Linked Smart View for queue/test contact context. |
| `personalPhoneInbound` | object | disabled; new UI profiles use `eligibilityScope=source` with an explicit `sourceId` | Fail-closed Personal Phone missed-call policy for this saved profile. `source` scope covers every contact in the configured Personal Phone source without brittle ID enumeration. `selected` scope remains available for exact contact IDs and Smart Views. A source can belong to only one enabled profile; conflicting, unknown, unmatched, or unready routes go to voicemail. |
| `dialerProvider` | `speak` or `calltools` | `speak` | `speak` enables direct calls through the workspace Telnyx Call Control app. `calltools` uses Go available to start the selected native campaign and durable agent session; CallTools owns contact selection/dialing and Speak attaches through its SIP lease. Playground Phone deliberately uses a transient `speak` override without changing the saved assignment or touching the shared CallTools seat. |
| `calltoolsAgentBinding` | object | unconfigured | Non-secret CallTools campaign binding: `appUserId`, `phoneId`, optional `campaignId`, `queueId`, `liveFilterId`, `bucketId`, provisioning status, and media-gateway status. Phone credentials remain protected. Go available freezes the selected compatible binding, registers the shared SIP endpoint, activates/originates the campaign, and establishes campaign-agent plus native AgentStatus state without a human login. CallTools then routes campaign invites that Speak attaches to the selected Hume/Inworld/xAI profile. Go unavailable proves native `ready=false` and SIP unregistration before releasing the seat. `/api/calls/start` rejects this transport with `calltools_direct_start_disabled`; `directStartReady` is diagnostic output only, while `campaignReady` is the supported operational gate. |
| `voiceRuntimeProvider` | `hume`, `inworld`, or `xai` | `hume` | Speech-to-speech runtime used for future sessions. Settings render only fields belonging to this runtime. |
| `eviVersion` | string | `3`, `inworld-realtime`, or `xai-realtime` | Hume EVI version or Speak-owned Inworld/xAI runtime ID. |
| `humeConfigId` | string | runtime default | Hume provider config ID. Hume config IDs are account-scoped to the active `HUME_API_KEY`; if a saved profile references a config from a prior Hume account, `/api/agent-configs/sync-speak`, `/api/config-tests/start`, Speak/Telnyx `/api/calls/start`, and CallTools Go available reconcile the complete provider config before a session or provider mutation. Reconciliation failures stop the start/arming request. Recovery persists the replacement config back to the saved profile without replacing dialer or phone bindings. Inworld profiles use `inworldConfigId`; neutral surfaces may also expose `speakConfigId` as the active provider-config alias. |
| `inworldConfigId` | string | `inworld-realtime` | Speak-owned Inworld config ID; Realtime sessions are configured per-session. Playground, direct-phone, CallTools duty, and native campaign invites validate the saved model against the current function-calling/text-modality catalogue before call state is created. The short-lived server cache is force-refreshed whenever provider options load so normal call connection does not add another provider round trip. |
| `xaiConfigId` | string | `xai-realtime` | Speak-owned xAI config ID; Realtime sessions are configured through `session.update` and validated against the live voice catalogue plus the documented Voice Agent model list. |
| `speakConfigId` | string | alias | Provider config ID alias used by neutral surfaces. |
| `humeConfigVersion` | number | provider value | Provider config version. |
| `inworldConfigVersion` | number | sync timestamp version | Synthetic Inworld sync proof version. |
| `xaiConfigVersion` | number | sync timestamp version | Synthetic xAI sync proof version. |
| `speakConfigVersion` | number | alias | Neutral config version alias. |
| `humeConfigSyncedAt` | ISO string | empty | Last provider sync timestamp. |
| `inworldConfigSyncedAt` | ISO string | empty | Synthetic Inworld Realtime sync timestamp. |
| `xaiConfigSyncedAt` | ISO string | empty | Synthetic xAI Voice Agent sync timestamp. |
| `speakConfigSyncedAt` | ISO string | alias | Neutral sync timestamp alias. |
| `voice` | string | runtime default | Voice ID. |
| `humeVoiceId` / `inworldVoiceId` / `xaiVoiceId` | string | runtime default | Per-runtime voice identity retained when the operator switches runtimes; `voice` mirrors the currently selected runtime. |
| `humeVoiceName` | string | `Speak Voice` | Voice display name. |
| `speakVoiceName` | string | alias | Neutral voice display name alias. |
| `humeVoiceProvider` | string | `CUSTOM_VOICE` | Hume voice provider enum. `HUME_AI` voices are Hume Library voices returned for the active `HUME_API_KEY` through `/tts/voices`; `CUSTOM_VOICE` entries appear only after custom voices are saved in that Hume account. Reconciliation fails closed when an explicitly selected voice is missing instead of silently substituting another catalog voice. |
| `inworldVoiceName` | string | runtime default | Inworld voice display name. |
| `inworldVoiceProvider` | string | `INWORLD_SYSTEM` | Inworld voice provider bucket returned by the active `INWORLD_API_KEY` `/voices/v1/voices` catalog. |
| `xaiVoiceName` | string | `Eve` | xAI voice display name. |
| `xaiVoiceProvider` | `XAI_BUILTIN` or `XAI_CUSTOM` | `XAI_BUILTIN` | xAI voice bucket from the merged built-in/custom catalogue. |
| `speakVoiceProvider` | string | alias | Neutral voice provider alias. |
| `supplementalLlm` | string | `Claude Sonnet 4.6` | Display/supporting model label for provider-native sessions. |
| `languageModelMode` | `hume`, `inworld`, `xai`, or `codex` | runtime default | Provider-native vs Codex-auth runtime route. xAI is native-only. Hume rejects Prompt resources on `CUSTOM_LANGUAGE_MODEL` configs, so Codex-auth profile instructions remain authoritative at the Speak CLM boundary and are injected by correlated `custom_session_id`. Speak also places the exact assembled prompt in persistent Hume session context before audio so EVI's optional quick responses follow the selected agent. The CLM removes that mirrored provider-context block before sending the caller turn to Codex because its correlated system copy is authoritative. Shared tools are injected and executed inside `server/codex-clm.mjs`, not duplicated as native Hume config tools. The CLM reflects only the latest caller turn's six highest Hume vocal-expression measures into that user message; this is bounded prosody context, not prompt expansion. |
| `languageModelProvider` | string | `ANTHROPIC` | Provider language-model provider. |
| `languageModelResource` | string | `claude-sonnet-4-6` | Provider model resource. |
| `languageModelTemperature` | number | `1` | Language model temperature. |
| `codexAuthModel` | string | `gpt-5.5` | Hume Codex-auth CLM model. Current fallback choices are `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, and `gpt-5.3-codex-spark`; runtime catalog discovery can add newer authenticated choices. |
| `codexReasoningEffort` | `none`, `minimal`, `low`, `medium`, `high`, or `xhigh` | `none` | Codex reasoning effort for Codex-auth selections. Missing, blank, and older saved values normalize to `none`; an explicit supported nonzero value remains available. Hume forwards the normalized selection to the Speak CLM bridge. Inworld fixes the effective value to `NONE` while shared tools are active because its chat-completions route rejects function tools combined with nonzero effort. |
| `inworldReasoningEfforts` | string array | live model capability | Saved Inworld capability snapshot populated from `reasoningCapability.supportedLevels` when any Inworld model is selected. It supports provider drift checks and a future tools-compatible route; it does not override the current tools-plus-reasoning safety rule. |
| `inworldReasoningSupported` | boolean | live model capability | Saved proof that the selected Inworld model advertises reasoning. Native sessions send `NONE` only when `EFFORT_NONE` is advertised and otherwise omit `text_generation_config.reasoning`; current Codex-auth tool routes advertise and use the provider-compatible explicit `NONE`. |
| `codexFastMode` | boolean | `true` | Provider-aware low-latency path for every Codex-auth selection in both runtimes. Missing or older blank values normalize to Fast mode on; an explicit saved `false` remains available. Hume requests the Codex priority service tier. Inworld disables conversational TTS context and uses `fast_start` for earlier first audio; enabling conversational context turns Fast mode off. |
| `inworldRealtimeModel` | string | runtime default | Inworld Realtime `session.model`. Codex-auth choices are OpenAI-compatible IDs returned by the live intersection of the Codex and Inworld model catalogues. Runtime resources stay canonical `provider/model` IDs even when the model portion contains nested paths. Stale, unsupported, non-tool, or non-text selections fail preflight before dialing. |
| `xaiRealtimeModel` | string | `grok-voice-latest` | xAI Voice Agent model; current alias and pinned Think Fast model only. |
| `xaiReasoningEffort` | `none` or `high` | `none` | Native xAI Voice Agent reasoning effort. |
| `xaiLanguageHint` | string | `en` | xAI `grok-transcribe` language hint. |
| `xaiKeyterms` | string array | empty | xAI transcription-bias keyterms. |
| `xaiVoiceSpeed` | number | `1` | Native xAI voice speed in the supported `0.7`–`1.5` range. |
| `xaiResumptionEnabled` | boolean | `true` | Enables conversation resumption for bounded provider reconnect. |
| `xaiToolCallingEnabled` | boolean | `true` | Enables proof-backed Speak functions inside xAI Realtime. |
| `xaiOutputSampleRate` | `16000` or `24000` | `16000` | Native xAI PCM16 output rate; 16 kHz is the phone-optimized default. |
| `inworldFallbackRealtimeModel` | string | `google-ai-studio/gemini-2.5-flash` | Runtime-only fallback for live sessions when the selected Inworld model is not available on the current plan. Recovery revalidates the fallback against the cached live catalogue and preserves the full shared tool set; an incompatible fallback fails closed instead of retrying without SMS/email/contact tools. |
| `inworldSttModel` | string | `inworld/inworld-stt-1` | Inworld-native STT model for live realtime calls. Voice naturalness should be tuned through provider-native TTS-2 settings and prompt guidance, not by swapping to third-party STT models. |
| `inworldTtsModel` | `inworld-tts-2` | `inworld-tts-2` | Inworld TTS model. Speak only supports latest `inworld-tts-2` for realtime speech-to-speech calls. |
| `inworldLanguage` | string | `en-US` | Inworld language hint. |
| `inworldSttEndOfTurnConfidenceThreshold` | number | unset | Advanced Inworld semantic VAD override; absent values preserve the native `inworldTurnEagerness` mapping. |
| `inworldSttMinEndOfTurnSilenceMs` | number | unset | Advanced Inworld semantic VAD override; absent values preserve the native `inworldTurnEagerness` mapping. |
| `inworldSttMaxTurnSilenceMs` | number | unset | Advanced Inworld semantic VAD override; absent values preserve the native `inworldTurnEagerness` mapping. |
| `inworldSttVadThreshold` | number | unset | Advanced Inworld semantic VAD override; absent values preserve the native `inworldTurnEagerness` mapping. |
| `inworldTurnDetectionMode` | `semantic_vad` or `server_vad` | `semantic_vad` | Inworld turn detection mode. |
| `inworldTurnEagerness` | string | `high` | Inworld semantic VAD eagerness. |
| `inworldTtsDeliveryMode` | string | `CREATIVE` | Inworld TTS-2 delivery mode. |
| `inworldTtsSegmenterStrategy` | string | `full_turn` | Inworld TTS segmentation strategy. Codex fast mode applies `fast_start` for the live session without changing the saved non-fast default. |
| `inworldTtsSteeringHandling` | string | `emit_once` | Inworld TTS steering behavior. |
| `inworldTtsConversationalEnabled` | boolean | `false` | Enables Inworld TTS-2 shared conversational context for the session. Inworld locks this mode to `full_turn`; enabling it turns Fast mode off, while enabling Fast mode turns this off. |
| `inworldTtsUserTurnMode` | string | `both` | User-turn context sent to Inworld TTS-2 conversational mode. |
| `inworldVoiceSteeringEnabled` | boolean | `true` | Enables Inworld TTS-2 steering prompt rules and transcript tag cleanup. |
| `inworldVoiceProfileEnabled` | boolean | `true` | Enables Inworld-native caller voice-profile cue capture for diagnostics and future tone-adaptation review. |
| `inworldResponsivenessInitialWaitMs` | number | `600` | Inworld responsiveness filler wait in milliseconds. |
| `inworldResponsivenessHardDeadlineMs` | number | `1200` | Inworld responsiveness filler hard deadline in milliseconds. |
| `inworldBackchannelEnabled` | boolean | `false` | Enables Inworld backchannel extension. |
| `inworldResponsivenessEnabled` | boolean | `false` | Enables Inworld responsiveness extension. |
| `inworldMemoryEnabled` | boolean | `false` | Enables Inworld memory extension. |
| `inworldToolCallingEnabled` | boolean | `true` | Enables shared Speak function tools for Inworld Realtime, including Telnyx SMS and Workspace email. Explicit `false` remains available for accounts that return a tool-calling restriction so realtime audio can continue without silent assistant failure. |
| `inworldOutputSampleRate` | number | `16000` | Inworld output PCM rate before Speak queues audio. |
| `allowShortResponses` | boolean | `false` | Hume EVI `ellm_model.allow_short_responses` setting. Inworld short-turn behavior comes from runtime prompt and TTS controls instead. |
| `promptExpansionEnabled` | boolean | `false` for new profiles; existing saved/provider values remain until changed | Operator-controlled Hume prompt expansion. In native mode Speak syncs the setting to Hume. In Codex-auth mode the selected assembled runtime prompt is supplied through persistent Hume session context before audio and independently retained as the CLM's authoritative correlated system prompt. Prompt expansion stays independent from latency optimization and is never enabled automatically as a latency change. |
| `inactivityTimeoutEnabled` | boolean | `true` | Enables inactivity timeout. |
| `inactivityTimeoutSeconds` | number | `120` | Inactivity timeout duration. |
| `maxDurationTimeoutEnabled` | boolean | `true` | Enables max duration timeout. |
| `maxDurationTimeoutSeconds` | number | `1800` | Max session duration. |
| `turnDetectionEnabled` | boolean | `true` | Enables turn detection. |
| `endOfTurnSilenceMs` | number | `500` | Responsive silence window; Hume's documented minimum. |
| `speechDetectionThreshold` | number | `0.58` | Speech threshold. |
| `prefixPaddingMs` | number | `300` | Prefix padding. |
| `interruptionEnabled` | boolean | `true` | Enables callee interruption. |
| `minInterruptionMs` | number | `550` | Minimum interruption duration. |
| `nudgesEnabled` | boolean | `true` | Enables nudges. |
| `nudgesIntervalSeconds` | number | `4` | Nudge interval. |
| `eviStartsConversation` | boolean | `false` | Hume EVI event message for `on_new_chat`; production baseline is false. |
| `resumeConversationMessageEnabled` | boolean | `true` | Hume EVI event-message toggle for `on_resume_chat`. |
| `resumeConversationMessage` | string | empty | Hume EVI resume message text. |
| `inactivityMessageEnabled` | boolean | `false` | Hume EVI event-message toggle for `on_inactivity_timeout`. |
| `inactivityMessage` | string | empty | Hume EVI inactivity message text. |
| `maxDurationMessageEnabled` | boolean | `false` | Hume EVI event-message toggle for `on_max_duration_timeout`. |
| `maxDurationMessage` | string | empty | Hume EVI max-duration message text. |
| `webSearchEnabled` | boolean | `false` | Provider web search setting. |
| `hangUpEnabled` | boolean | `true` | Enables built-in hangup tool. |
| `verboseTranscription` | boolean | `true` | Enables verbose transcript behavior. |
| `audioEncoding` | `linear16` | `linear16` | Runtime audio encoding. |
| `phoneAudioMode` | `optimized` or `legacy` | `optimized` | Phone transport mode. |
| `phoneOutputGain` | number | `0.72` | Phone output gain. |
| `phoneOutputPeak` | number | `0.58` | Phone peak target. |
| `sampleRate` | number | `16000` | Runtime sample rate. |
| `telnyxCallerId` | string | env fallback | Speak/Telnyx caller ID used only for direct Phone and Playground Phone calls. Saved profile values override env defaults unless the profile still contains an old placeholder. CallTools ignores this field and uses its native campaign caller-ID strategy. |
| `phoneCallerId` | string | alias | Neutral alias for the Speak/Telnyx direct-call caller ID; it is not a CallTools assignment. |
| `telnyxStreamCodec` | `L16` or `PCMU` | `L16` | Phone media codec. |
| `phoneStreamCodec` | `L16` or `PCMU` | alias | Neutral stream codec alias. |
| `callWindow` | string | `10:00 AM - 6:00 PM local` | Operator-facing call window label. |
| `maxConcurrent` | number | `1` | Queue concurrency. |
| `useConfigPrompt` | boolean | `true` in seeded config | Use provider config prompt. |
| `useConfigTools` | boolean | `true` in seeded config | Use provider config tools. |
| `autoStartGreeting` | boolean | `false` | Agent auto-greeting behavior. |
| `profileContext` | `ContextFields` | empty | Runtime Agent Knowledge Layer snapshot. |

Speak also uses `nudgesIntervalSeconds` for its false-interruption silence fallback. The fallback waits for real caller PCM to become quiet before asking the configured agent to resume naturally, and it is canceled by caller speech, a completed caller turn, renewed assistant speech, human takeover, or call closure.

Opening or refreshing Settings performs a fresh Inworld model and voice read
with two bounded five-second attempts per provider page. A failed refresh stays
visible as an Inworld provider error and does not silently return old selectable
options. Only current models that are provider-supported, text-capable, and
compatible with Speak tools may replace the five-minute validated model cache
used by call-start preflight. Calls reuse that cache without provider I/O; an
uncached runtime check keeps the shorter 1.5-second single-attempt bound and is
isolated from longer Settings refreshes.

## Context Field Shape

```ts
type ContextFields = {
  text: string
  urls: string[]
  urlSnapshots?: Array<{
    url: string
    title?: string
    text?: string
    status?: string
    error?: string
    contentType?: string
    fetchedAt?: string
    contentHash?: string
    contentChars?: number
  }>
  files: Array<{
    id: string
    name: string
    type: string
    size: number
    uploadedAt: string
    url: string
    preview?: string
    extractedText?: string
    extractionStatus?: 'ready' | 'empty' | 'unsupported' | 'error'
    extractionError?: string
    extractedAt?: string
    contentHash?: string
    contentChars?: number
  }>
}
```
