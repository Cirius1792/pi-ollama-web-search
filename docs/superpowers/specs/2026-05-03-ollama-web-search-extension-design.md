---
title: Ollama Web Search pi Extension Design
created: 2026-05-03
status: approved-in-chat
---

# Ollama Web Search pi Extension Design

## Summary

Build a reusable, shareable pi package distributed from GitHub that integrates Ollama's Web Search API into pi through an extension.

Version 1 is intentionally narrow:
- one production tool: `ollama_web_search`
- one dev-only slash command for manual testing/debugging
- authentication via `OLLAMA_API_KEY` environment variable only
- no `web_fetch`
- no research orchestration
- no query/result cache
- no live API calls in CI

The extension should expose Ollama web search to pi with minimal opinionation. It should preserve the API's rich result content as much as possible, while still applying light normalization and a high safety cap to protect model context.

## Goals

- Provide pi with a callable tool for Ollama web search.
- Make the integration reusable and shareable as a GitHub-installable pi package.
- Keep the public API surface small and easy to understand.
- Keep the implementation modular enough to test well and evolve safely.
- Provide a dev-only command for manual verification without expanding the normal user-facing surface.

## Non-goals

Version 1 will not include:
- Ollama `web_fetch`
- multi-step search agent orchestration
- automatic prompt interception or forced tool use
- query/result caching
- follow-up result expansion tools
- custom secret storage
- pi `/login` integration
- runtime toggling of dev mode
- real Ollama API calls in CI

## User-facing behavior

### Production tool

The extension exposes one production tool:
- `ollama_web_search`

Tool input:
- `query: string`

Tool behavior:
- sends a POST request to `https://ollama.com/api/web_search`
- authenticates with `Authorization: Bearer <OLLAMA_API_KEY>`
- sends a fixed extension-controlled `max_results`
- returns search results in a readable, stable format
- preserves the API's returned content as much as possible
- applies only light normalization plus a high safety cap for unusually large responses

The tool should be available in normal use regardless of dev mode.

### Dev-only command

The extension also exposes one debug command when dev mode is enabled:
- `/ollama-search <query>`

Purpose:
- manual verification during development
- debugging and troubleshooting
- not part of the primary end-user workflow

The command must call the same shared search path used by the tool. It must not implement a separate request flow.

## Authentication and configuration

### Required environment variable

- `OLLAMA_API_KEY`

This is the only supported authentication mechanism in v1.

### Optional environment variable

- `PI_OLLAMA_SEARCH_DEV`

Accepted truthy values for enabling dev mode:
- `1`
- `true`

If dev mode is enabled at startup, the extension registers the debug slash command. Otherwise it does not.

### Configuration rules

- No config file support in v1.
- No persisted credentials in v1.
- No in-product login flow in v1.
- Changing env vars requires restarting pi or reloading extensions for behavior to update consistently.

## Architecture

The package should feel minimal externally but be modular internally.

### Package shape

The repository will be a GitHub-installable pi package containing:
- package metadata for pi package installation
- extension source files
- tests
- README documentation

### Internal modules

#### `src/index.ts`
Extension entrypoint.

Responsibilities:
- read configuration
- register the production tool
- conditionally register the dev command
- emit startup warnings when configuration is missing

#### `src/config.ts`
Configuration loader.

Responsibilities:
- read `OLLAMA_API_KEY`
- read `PI_OLLAMA_SEARCH_DEV`
- expose fixed constants such as default `max_results`
- expose high safety limits for formatted output
- centralize truthy parsing and validation decisions

#### `src/client.ts`
Ollama HTTP client.

Responsibilities:
- perform POST requests to Ollama web search API
- set required headers
- serialize request body
- parse JSON responses
- convert HTTP/network/protocol failures into typed or structured errors usable by higher layers

#### `src/normalize.ts`
Response normalization.

Responsibilities:
- map raw API JSON into a stable internal result shape
- ensure each result is represented consistently with `title`, `url`, and `content`
- normalize line endings and whitespace without rewriting meaning
- distinguish valid empty results from invalid response shapes

#### `src/format.ts`
Model-facing output formatter.

Responsibilities:
- convert normalized results into readable tool output text
- preserve rich content rather than aggressively summarizing it
- enforce only a high safety cap when output becomes unusually large
- append an explicit truncation notice only when truncation actually occurs

## Data flow

### Tool flow

1. pi calls `ollama_web_search` with `query`.
2. The extension validates that `OLLAMA_API_KEY` is present.
3. The client sends a POST request to Ollama web search API.
4. The client parses the HTTP response and returns raw JSON.
5. The normalizer maps raw JSON into stable internal result objects.
6. The formatter builds readable tool output from normalized results.
7. The tool returns:
   - `content`: human/model-readable formatted search results
   - `details`: normalized structured data for debugging and testability

### Dev command flow

1. User runs `/ollama-search <query>`.
2. The command calls the same shared search function used by the tool.
3. The result is displayed for human debugging.

The command must reuse the same lower-level pipeline so that manual testing exercises the same code path as production tool execution.

## Output strategy

Version 1 should be close to pass-through.

Output requirements:
- preserve the API's result content as much as practical
- normalize only enough to keep formatting stable
- avoid aggressive summarization or sanitization that hides useful content
- use a high safety cap to prevent pathological context blowups
- include clear truncation messaging only when the cap is hit

This choice follows observed API behavior: live responses can already contain substantial content, so the extension should not prematurely reduce result richness.

## Error handling

### Missing API key

On `session_start`:
- if `OLLAMA_API_KEY` is missing, show a warning notification

On tool invocation:
- fail clearly with an actionable error telling the user to export `OLLAMA_API_KEY`

On dev command invocation:
- fail clearly with the same actionable guidance

### HTTP failures

For non-2xx responses:
- surface a concise error
- include HTTP status
- include safe response details when useful
- never include secrets

### Authentication failures

401/403 responses should be distinguishable from missing-config errors.

### Network failures

Timeout, DNS, connection, and transport failures should be surfaced as network/integration errors rather than auth errors.

### Invalid response shape

If Ollama returns JSON that does not match expected shape:
- fail clearly as an unexpected response format
- do not silently reinterpret it as empty results

### Empty results

If the API returns zero results:
- return a successful result saying no results were found
- do not treat it as a failure

### Oversized responses

If formatted output exceeds the configured safety cap:
- truncate only then
- preserve as much useful content as possible within the cap
- clearly indicate truncation in returned content

## Testing strategy

CI must not depend on live Ollama cloud access.

### Unit tests

Test pure logic for:
- environment parsing
- dev mode flag parsing
- normalization behavior
- formatting behavior
- truncation behavior
- error mapping

### Mock-server integration tests

Use a local mock HTTP server to emulate:
- successful search results
- empty results
- 401/403 responses
- generic non-2xx failures
- malformed JSON
- invalid response shapes
- network failure scenarios where practical

These tests should verify:
- request method and path
- request headers, including authorization
- request body structure
- response parsing
- surfaced error behavior

### Extension behavior tests

Where practical, verify:
- the production tool is always registered
- the dev command is registered only when `PI_OLLAMA_SEARCH_DEV` is truthy
- startup warning behavior occurs when the API key is missing

### Manual verification

Manual maintainer verification is recommended but outside CI:
- export `OLLAMA_API_KEY`
- optionally export `PI_OLLAMA_SEARCH_DEV=1`
- install/load the package in pi
- run a known query
- confirm tool and optional command behavior

## Package and repository layout

Recommended initial layout:

```text
package.json
README.md
src/
  index.ts
  config.ts
  client.ts
  normalize.ts
  format.ts
test/
  ...unit and mock-server integration tests...
```

The package manifest should declare the extension entry so it can be installed as a pi package from GitHub.

## README requirements

The README should prioritize the GitHub pi package install flow.

Minimum documentation sections:
- what the package does
- installation via pi from GitHub
- required env var setup for `OLLAMA_API_KEY`
- optional dev mode setup for `PI_OLLAMA_SEARCH_DEV=1`
- example usage
- troubleshooting for missing API key and auth failures
- note that CI uses mocks only

## Public contract summary

Version 1 public contract:
- production tool: `ollama_web_search(query)`
- required env var: `OLLAMA_API_KEY`
- optional env var: `PI_OLLAMA_SEARCH_DEV`
- optional dev-only command: `/ollama-search <query>`

Version 1 intentionally excludes any additional production tools or auth/config mechanisms.

## Rationale for chosen design

This design balances simplicity and completeness.

It stays small by exposing only one production capability and avoiding speculative extensions such as fetch, caching, or agent orchestration. It remains maintainable by separating configuration, HTTP interaction, normalization, and formatting into distinct units. It also respects real observed API behavior by preserving rich search content rather than over-compressing it.

The result is a good v1 for a reusable pi package: easy to explain, straightforward to install, safe to test in CI, and narrow enough to evolve without carrying unnecessary complexity.
