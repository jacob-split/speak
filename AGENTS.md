# Speak agent guide

Speak is an operator-first voice-agent workspace. Preserve real behavior over decorative UI: every visible action must perform a real backend/browser action, open a real configuration path, or accurately report unavailable state.

## Product priorities

1. Preserve the live-call loop and realtime correctness.
2. Keep contact, queue, call, transcript, and profile state durable and explicit.
3. Keep high-risk actions proof-backed and fail closed.
4. Keep Library, Dialer, and Playground compact and consistent.
5. Keep provider-specific behavior behind shared contracts where possible.

Read `BRANDING.md` before changing visible UI. Exact design tokens live in `src/index.css`; stable automation selectors live in `src/uiContract.ts`.

## Architecture

- `src/`: React/TypeScript operator UI.
- `server/`: Express API, voice runtimes, phone transports, workspace store, communication history, and shared agent/action contracts.
- `agent/`: portable Speak operator skill and adapter resources.
- `scripts/`: contract, provider, browser, and safety checks.
- `docs/`: public product, API, architecture, provider, and UI documentation.

Keep orchestration out of `src/App.tsx` and pure call-state logic out of `server/index.mjs`. Prefer reusable modules and shared action definitions over surface-specific copies.

## Safety and data

- Never commit API keys, tokens, phone credentials, customer/contact exports, recordings, private call logs, or `.env` files.
- Documentation screenshots and fixtures must remain synthetic.
- Do not hard-code deployment-specific accounts, campaign IDs, hosts, or filesystem paths.
- Provider/tool actions must not claim completion unless the backend returns proof.
- Keep automation opt-in for inbound messaging/calling paths unless the caller explicitly authorizes it.

## UI

Speak should feel compact, neutral, and operational. No gradients, decorative assistant panels, fake controls, or oversized marketing UI inside the application. Preserve route/control symmetry across Dialer and Playground and verify desktop/phone behavior when changing layout.

## Development

```bash
npm ci
cp .env.example .env
npm run dev
```

Before finishing code changes, run the smallest relevant checks plus:

```bash
npm run lint
npm run build
```

For API/agent contract work use `npm run qa:backend-api` and the relevant `qa:agent-*` check. For UI work use `npm run qa:ui-contract`. For communication-history work use `npm run qa:communication-threads`.

Preserve unrelated work. Update documentation when public behavior, configuration, routes, or provider capabilities change.
