# Speak

Speak is an open-source workspace for operating live voice agents with human visibility and control.

- Documentation: https://speak.split-llc.com/
- Source: https://github.com/jacob-split/speak
- License: Apache-2.0

## Start here

Speak has three main surfaces:

- **Library** — prepare contacts, agent profiles, context, and communication history.
- **Dialer** — run calls, follow the realtime transcript, guide the agent, or take over.
- **Playground** — configure and test prompts, voices, providers, and phone behavior.

## Why Speak exists

Voice automation becomes hard to trust when configuration, live call state, transcripts, intervention controls, and follow-up proof are split across tools. Speak keeps those pieces in one operator workflow.

External actions are proof-backed: a surface should not claim that a call, message, contact update, or other side effect succeeded until the backend confirms it.

## Architecture

The React/TypeScript interface talks to an Express API that owns provider sessions, phone transports, workspace state, communication history, and action proof. Agent and widget integrations adapt the same backend contract rather than defining separate behavior.

## Integrations

- Realtime voice: Hume, Inworld, xAI Voice Agent
- Phone transport: Telnyx, CallTools
- Agent/app interfaces: MCP, ChatGPT Apps, OpenAPI, A2A, AG-UI, A2UI and portable widgets

## Documentation

- [Product and UI guide](ui-reference.md)
- [Agent integration](agent-integration.md)
- [API reference](backend-api-reference.md)
- [Configuration](configuration-options.md)
- [Communication model](communication-thread-model.md)
- [Provider integration](voice-provider-integration.md)

## Local development

```bash
npm ci
cp .env.example .env
npm run dev
```

Run `npm run lint` and `npm run build` before submitting code changes. Provider-specific live checks require the corresponding credentials and are separate from normal local development.

All documentation screenshots and fixtures are synthetic.
