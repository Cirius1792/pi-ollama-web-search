# Agent Instructions

## Agent skills

### Issue tracker

Issues for this repo are tracked in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

This repo uses the default canonical triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

This repo is configured as single-context. See `docs/agents/domain.md`.

## Repository overview

This repository contains `@cltec/pi-ollama-web-search`, a TypeScript ESM pi extension package that registers `ollama_web_search` and `ollama_web_fetch` tools. The tools call Ollama's Web Search and Web Fetch APIs and return formatted results to pi.

Core runtime flow:

1. `src/index.ts` registers the pi tool and optional debug slash command.
2. `src/config.ts` reads environment-based configuration.
3. `src/search.ts` validates input and orchestrates the search pipeline.
4. `src/client.ts` sends the HTTP request to Ollama.
5. `src/normalize.ts` validates and normalizes the API response.
6. `src/format.ts` formats normalized results for model context.

## Development commands

Run these before finishing changes:

```bash
npm run typecheck
npm test
```

For release/package changes, also run:

```bash
npm pack --dry-run
```

The test suite uses Vitest and local/mock HTTP behavior. Do not require live Ollama API access for automated tests.

## Environment variables

- `OLLAMA_API_KEY`: required for live Ollama Web Search calls.
- `PI_OLLAMA_SEARCH_DEV=1`: enables the development-only `/ollama-search` and `/ollama-fetch` debug slash commands.

Do not commit API keys, `.env` files, or other secrets.

## Code conventions

- Use TypeScript with strict types and ESM imports.
- Keep source imports extension-suffixed for NodeNext resolution, e.g. `./config.js` from TypeScript files.
- Keep production behavior in small modules with clear responsibilities.
- Prefer dependency injection for testability, as with `fetchImpl` in the search/client flow.
- Preserve abort-signal propagation for pi tool calls and command handlers.
- Return user-facing errors as clear messages; keep typed lower-level API errors in `src/client.ts`.

## Testing guidance

- Add or update tests in `test/` for behavior changes.
- Use Vitest assertions and mocks consistently with the existing tests.
- Mock HTTP with `test/helpers/mock-server.ts` or injected `fetchImpl`; avoid live network calls in tests.
- Cover both success and failure paths for API/client changes.
- If changing formatting, update `test/format.test.ts` and consider truncation behavior.
- If changing response validation, update `test/normalize.test.ts`.
- If changing pi registration behavior, update `test/extension.test.ts`.

## pi extension guidance

- The package exposes two production tools: `ollama_web_search` and `ollama_web_fetch`.
- The debug command `/ollama-search` must remain gated behind `PI_OLLAMA_SEARCH_DEV`.
- The extension should warn on `session_start` when `OLLAMA_API_KEY` is missing and UI is available.
- Keep tool parameters schema-based with `typebox`.
- Avoid adding unrelated pi tools, search-agent orchestration, caching, or secret storage unless explicitly requested.

## Documentation and release notes

- Update `README.md` for user-facing behavior, install instructions, environment variables, or troubleshooting changes.
- Update `docs/release.md` for publishing workflow changes.
- Keep `package.json` metadata aligned with the GitHub repository and npm package name.

## Release/package checks

Before publishing or changing package contents, verify:

```bash
npm ci
npm run typecheck
npm test
npm pack --dry-run
```

The npm package should include `package.json`, `README.md`, and files under `src/`. Tests, CI config, and local development files should not be included unless intentionally changed.

## Git hygiene

- Check `git status --short` before and after edits.
- Keep changes focused and avoid unrelated refactors.
- Do not edit generated dependency directories such as `node_modules/`.
- Do not commit local secrets or machine-specific configuration.
