<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/speak-wordmark-dark.png">
    <img src="docs/assets/speak-wordmark-light.png" alt="Speak" width="236">
  </picture>
</p>

<p align="center"><strong>Open-source operations workspace for live voice agents.</strong></p>

<p align="center">
  <a href="https://speak.split-llc.com/">Documentation</a> ·
  <a href="docs/agent-integration.md">Agent integration</a> ·
  <a href="docs/backend-api-reference.md">API reference</a>
</p>

# Speak

Speak gives an operator one place to prepare a contact, run a voice-agent call, follow the live transcript, intervene when needed, and review what happened afterward.

It is built for workflows where automation needs human visibility and control rather than a black-box dialer.

![Speak Dialer](docs/assets/screenshots/dialer-dark.png)

## Core workflow

- **Library** — contacts, agent profiles, source imports, communication history, recordings, and contact memory.
- **Dialer** — queue control, realtime transcripts, playback, live guidance, and operator takeover.
- **Playground** — prompts, voices, provider settings, browser tests, and phone-quality tests.
- **Proof-backed actions** — calls, messages, contact changes, and other external actions are only reported as successful after backend confirmation.

## Integrations

Speak keeps provider-specific logic behind shared runtime and action contracts.

- Realtime voice: Hume, Inworld, xAI Voice Agent
- Phone transport: Telnyx, CallTools
- Agent/app interfaces: MCP, ChatGPT Apps, OpenAPI, A2A, AG-UI, A2UI and portable widget manifests

## Architecture

```text
React / TypeScript UI
        │
        ▼
Express API + shared action contract
   ┌────┼──────────┬───────────┐
   ▼    ▼          ▼           ▼
voice  phone    workspace    agent/UI
      providers    state      adapters
```

The browser UI and agent-facing integrations use the same backend-owned actions, state rules, and proof semantics.

## Run locally

Requirements: Node.js 22+ and npm.

```bash
git clone https://github.com/jacob-split/speak.git
cd speak
npm ci
cp .env.example .env
npm run dev
```

Provider credentials are optional for browsing the UI and running non-live checks. Configure only the providers you intend to use; secrets stay on the backend.

Useful checks:

```bash
npm run lint
npm run build
npm run qa:backend-api
npm run qa:agent-readiness
```

## Documentation

Start at **https://speak.split-llc.com/**. The public docs are intentionally focused on the product, local setup, architecture, integrations, and stable interfaces. They do not link to or describe any private deployment.

- [Product and UI guide](docs/ui-reference.md)
- [Agent integration](docs/agent-integration.md)
- [API reference](docs/backend-api-reference.md)
- [Configuration](docs/configuration-options.md)
- [Communication model](docs/communication-thread-model.md)
- [Provider integration](docs/voice-provider-integration.md)

All checked-in screenshots and fixtures use synthetic data.

## Security

Do not commit `.env` files, API keys, phone credentials, contact exports, recordings, or private call logs. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Contributing

Focused issues and pull requests are welcome. Keep changes scoped, preserve the shared action contract, use synthetic fixtures, and run the relevant checks before submitting. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
