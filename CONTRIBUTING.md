# Contributing to Speak

Speak welcomes focused issues and pull requests that improve the operator workflow, realtime correctness, provider integrations, agent portability, documentation, or verification.

## Development setup

```bash
npm ci
cp .env.example .env
npm run dev
```

Most non-live development does not require provider credentials. Use synthetic fixtures for tests and screenshots.

## Pull requests

Keep changes scoped and explain the user-visible or contract-level behavior they change. Do not include credentials, real contact data, recordings, production exports, deployment-specific identifiers, or private logs.

Run the relevant targeted checks and, at minimum:

```bash
npm run lint
npm run build
```

If you change backend routes or agent actions, run `npm run qa:backend-api`. If you change UI behavior, run `npm run qa:ui-contract`. If you change communication history, run `npm run qa:communication-threads`.

## Design changes

Read `BRANDING.md` first. Reuse existing tokens and component grammar, preserve accessible labels/focus behavior, and avoid decorative UI that competes with live call state.

## Provider integrations

New realtime voice providers should follow `docs/voice-provider-integration.md`: start from official SDK/docs, map capabilities explicitly, keep provider-specific behavior isolated, and add a repeatable verification path.
