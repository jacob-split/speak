# Speak

Speak is an open-source operator workspace for live voice agents. It combines contact context, a realtime dialer, agent configuration, communication history, human supervision, and proof-backed actions in one product model.

- Source: https://github.com/jacob-split/speak
- Product and documentation showcase: https://files.split-llc.com/speak/
- License: Apache-2.0

## Product surfaces

### Library

Library is the operational record for contacts, Smart Views, imported sources, saved agent profiles, recordings, communication threads, and contact-scoped memory. It supports editable contact data, bulk operations, source-aware activity, and transcript review without turning Speak into a general-purpose CRM.

### Dialer

Dialer is the live calling surface. It keeps the selected queue, current agent, call state, realtime transcript, playback, live guidance, operator takeover, and proof of external actions visible while a call is active.

### Playground

Playground is the configuration and test surface. It supports prompts, runtime/model choices, voice settings, browser tests, phone-quality tests, saved profiles, and supported live supervision controls without crowding the production dialer.

## Core capabilities

| Capability | What Speak provides |
| --- | --- |
| Human supervision | Take over an active call, whisper guidance, and use supported Spy/Barge flows. |
| Contact memory | Persist notes, URLs, files, prior conversations, and compact context for later sessions. |
| Communication threads | Normalize calls, SMS, email, recordings, provider events, and tool proof into durable contact-scoped history. |
| Realtime voice runtimes | Hume, Inworld, and xAI Voice Agent integrations behind provider-aware runtime modules. |
| Phone transports | Telnyx call control/streaming and CallTools campaign/SIP transport paths. |
| Messaging and email | Proof-backed SMS and workspace email actions plus bounded source synchronization. |
| Agent interoperability | MCP/ChatGPT Apps, OpenAPI, ACP, A2A discovery, MCP UI, AG-UI, A2UI, AI SDK, JSON Render, CopilotKit, widgets, and portable host-client manifests. |
| Codex integration | Optional Codex-authenticated model routing and configuration workflows while the shared Speak action contract remains provider-neutral. |
| Fail-closed actions | High-risk external actions are not reported as successful until backend proof is returned. |

## Architecture

Speak uses one backend-owned contract across browser, agent, and widget surfaces. The React/TypeScript frontend calls an Express API that owns durable workspace state, provider sessions, phone transports, communication history, and action proof. Generated adapter manifests expose the same capabilities to outside agent hosts instead of reimplementing them per framework.

Key source areas:

- `src/` — React operator UI.
- `server/` — API, voice runtimes, transports, durable state, action contracts, and communication normalization.
- `agent/` — portable Speak operator skill and host resources.
- `scripts/` — build, contract, provider, browser, safety, and integration verification.
- `docs/` — UI, API, agent, provider, and data-model documentation.

## Documentation

- [UI reference](ui-reference.md)
- [Agent integration](agent-integration.md)
- [Agent reference](agent-reference.md)
- [Backend API reference](backend-api-reference.md)
- [Generative UI widgets](generative-ui-widgets.md)
- [Communication thread model](communication-thread-model.md)
- [Configuration options](configuration-options.md)
- [Voice provider integration](voice-provider-integration.md)
- [Branding and UI guidelines](BRANDING.md)

## Screenshots

All checked-in documentation screenshots are generated from synthetic fixtures. No real contact data, call logs, credentials, phone numbers, or provider configuration IDs are used.

- [Library — contacts, light](assets/screenshots/library-contacts-light.png)
- [Library — contacts, dark](assets/screenshots/library-contacts-dark.png)
- [Library — agents, light](assets/screenshots/library-agents-light.png)
- [Library — agents, dark](assets/screenshots/library-agents-dark.png)
- [Library — activity, light](assets/screenshots/library-activity-light.png)
- [Library — activity, dark](assets/screenshots/library-activity-dark.png)
- [Dialer, light](assets/screenshots/dialer-light.png)
- [Dialer, dark](assets/screenshots/dialer-dark.png)
- [Playground, light](assets/screenshots/playground-light.png)
- [Playground, dark](assets/screenshots/playground-dark.png)

## Integration model

New speech-to-speech providers follow the same process: inspect official SDK/API capabilities, map them against Speak's shared runtime contract, isolate provider-specific behavior, preserve transcripts and proof, and add repeatable verification. See [Voice provider integration](voice-provider-integration.md).

Agent adapters follow the same principle. Speak owns the workflow and action semantics; MCP, ChatGPT Apps, widgets, A2A, AG-UI, A2UI, and other hosts adapt around that contract rather than defining separate product behavior.

## Development

```bash
npm ci
cp .env.example .env
npm run dev
```

For normal changes run `npm run lint` and `npm run build`, plus the targeted contract or provider check for the area changed. Live provider certification is intentionally separate and requires explicit credentials/configuration.
