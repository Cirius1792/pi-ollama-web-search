# Ollama Web Fetch Support Design

## Context

`@cltec/pi-ollama-web-search` currently registers one production pi tool, `ollama_web_search`, which calls Ollama's Web Search API and returns formatted search results. Ollama also provides a Web Fetch API at `POST https://ollama.com/api/web_fetch` for retrieving the main content of a single known URL.

This design adds Web Fetch support without changing the existing search tool behavior.

## Goals

- Add a second production pi tool named `ollama_web_fetch`.
- Preserve `ollama_web_search` behavior and input shape.
- Add a development-only `/ollama-fetch <url>` debug command gated by `PI_OLLAMA_SEARCH_DEV=1`.
- Make tool descriptions and prompt guidance clear enough that pi's model can choose between search and fetch.
- Keep implementation consistent with the existing small-module TypeScript pipeline.
- Keep automated tests fully mocked/local with no live Ollama API dependency.

## Non-goals

- Do not add caching.
- Do not add search-agent orchestration or automatic chained search/fetch loops.
- Do not add secret storage beyond the existing `OLLAMA_API_KEY` environment variable.
- Do not remove or rename `ollama_web_search`.
- Do not enforce strict URL syntax for fetch inputs.

## Public interface

### `ollama_web_search`

Existing production tool remains unchanged.

- Input: `{ query: string }`
- Behavior: calls `POST https://ollama.com/api/web_search`
- Output: formatted search results with title, URL, and content snippet
- Details: normalized `{ results: Array<{ title, url, content }> }`

### `ollama_web_fetch`

New production tool.

- Input: `{ url: string }`
- Behavior: calls `POST https://ollama.com/api/web_fetch`
- URL handling:
  - Trim whitespace.
  - Reject blank input with `Fetch URL must not be empty.`
  - Pass the trimmed value through to Ollama unchanged, including bare domains such as `ollama.com`.
- Output: formatted page fetch result with:
  - title
  - main content
  - links found on the page
- Details: normalized `{ title: string, content: string, links: string[] }`

### Development commands

When `PI_OLLAMA_SEARCH_DEV=1`:

- Keep existing `/ollama-search <query>`.
- Add `/ollama-fetch <url>`.

Both commands use the same config, API key, abort-signal propagation, and user-facing error formatting style.

## Tool guidance for pi models

Both production tools should include clear `description`, `promptSnippet`, and `promptGuidelines` metadata.

Guidance should make this distinction explicit:

- Use `ollama_web_search` to discover relevant pages, find recent/current information, or answer questions where the URL is not yet known.
- Use `ollama_web_fetch` to retrieve full/main page content from a known URL, including URLs returned by `ollama_web_search`.
- Prefer `ollama_web_fetch` after search when snippets are insufficient or when the user asks to inspect/summarize a specific page.

Because pi appends `promptGuidelines` as flat bullets, each guideline must name the relevant tool directly.

## Architecture

Use the existing layered pipeline and add fetch-specific functions alongside search-specific functions.

```text
src/index.ts
  registers tools and dev commands

src/config.ts
  shared API key, dev mode, output cap, search endpoint, fetch endpoint

src/client.ts
  HTTP POST requests to Ollama
  - searchOllamaWeb(...)
  - fetchOllamaWeb(...)

src/search.ts
  validates search input
  calls search client
  normalizes search response
  formats search output

src/fetch.ts
  validates fetch input
  calls fetch client
  normalizes fetch response
  formats fetch output

src/normalize.ts
  validates and normalizes search and fetch response shapes

src/format.ts
  formats normalized search and fetch outputs with the shared safety cap
```

This keeps search and fetch behavior independently testable while sharing common config, client error handling, normalization helpers, and formatting safety-cap logic where appropriate.

## Data flow

### Fetch tool flow

```text
ollama_web_fetch tool or /ollama-fetch command
  → runOllamaWebFetch(url, { config, signal })
  → trim/reject blank URL
  → require OLLAMA_API_KEY
  → POST config.fetchEndpoint with { url }
  → parse JSON or throw typed client error
  → normalize title/content/links
  → format title/content/links with shared 50,000 character cap
  → return content and details to pi
```

### Search flow

Search flow remains the same, with config exposing explicit `searchEndpoint` and `fetchEndpoint` fields:

```text
ollama_web_search tool or /ollama-search command
  → runOllamaWebSearch(query, { config, signal })
  → trim/reject blank query
  → require OLLAMA_API_KEY
  → POST search endpoint with { query, max_results }
  → parse JSON or throw typed client error
  → normalize search results
  → format search results with shared 50,000 character cap
  → return content and details to pi
```

## Configuration

Use the existing environment variables:

- `OLLAMA_API_KEY`: required by both live APIs.
- `PI_OLLAMA_SEARCH_DEV=1`: enables both debug commands.

Add a fetch endpoint constant:

- `OLLAMA_WEB_FETCH_ENDPOINT = "https://ollama.com/api/web_fetch"`

The existing default output cap remains shared:

- `DEFAULT_MAX_OUTPUT_CHARS = 50_000`

Update the config interface from a generic `endpoint` field to explicit `searchEndpoint` and `fetchEndpoint` fields. Update all internal call sites and tests together. No user-facing config compatibility is required because endpoints are not currently user-configurable.

## Client behavior

`src/client.ts` should continue to own lower-level typed API errors.

For fetch:

- POST to the configured fetch endpoint.
- Send headers:
  - `Authorization: Bearer <api key>`
  - `Content-Type: application/json`
- Send body: `{ "url": "<trimmed input>" }`
- Parse successful JSON responses.
- Throw typed errors for:
  - non-2xx HTTP responses
  - invalid JSON
  - network failures

Rename the shared typed error class from `OllamaWebSearchError` to `OllamaWebError` so it accurately covers both search and fetch. Update tests and imports consistently.

## Normalization

### Search

Keep existing normalization behavior:

- Require `results` array.
- Require each result to contain string `title`, `url`, and `content`.
- Compact title and URL whitespace.
- Preserve readable newlines in content.

### Fetch

Add `normalizeWebFetchResponse(raw)`.

Rules:

- Require response to be an object.
- Require `title` to be a string.
- Require `content` to be a string.
- Require `links` to be an array of strings.
- Compact title whitespace.
- Preserve readable markdown/newline structure in content.
- Trim/compact each link string.
- Preserve empty links arrays.
- Reject malformed responses with explicit error messages, e.g. `Unexpected Ollama web fetch response: links must be an array`.

## Formatting

Add `formatFetchResult(response, { maxOutputChars })`.

Recommended format:

```text
Fetched page:

Title: Ollama

Content:
<main content>

Links:
[1] https://ollama.com/
[2] https://ollama.com/models
```

If there are no links, include a clear links section such as:

```text
Links:
No links found.
```

Use the same 50,000 character safety cap as search. If output is truncated, include the existing truncation notice style.

## Error handling

- Missing API key uses the existing shared message from `getMissingApiKeyMessage()`.
- `session_start` emits one warning when `OLLAMA_API_KEY` is missing and UI is available; the warning covers both tools.
- Blank fetch URL throws `Fetch URL must not be empty.` before any network call.
- Command handlers catch errors and notify the user with a shared user-facing formatter.
- Rename `formatSearchError` to `formatOllamaWebError` to reflect shared search/fetch usage.

## Testing plan

Update or add tests without live network calls.

### `test/client.test.ts`

- Existing search client tests remain.
- Add fetch client success test:
  - method is POST
  - path is `/api/web_fetch`
  - authorization and content-type headers are present
  - request body is `{ url: "ollama.com" }`
  - parsed JSON response is returned
- Add fetch typed error coverage for non-2xx HTTP responses and invalid JSON responses.

### `test/normalize.test.ts`

- Existing search normalization tests remain.
- Add valid fetch response normalization.
- Add empty links array case.
- Add malformed fetch response cases for missing/invalid title, content, and links.

### `test/format.test.ts`

- Existing search formatting tests remain.
- Add fetch formatting with title, content, and numbered links.
- Add fetch formatting with empty links.
- Add fetch truncation coverage.

### `test/search.test.ts`

- Preserve existing search orchestration tests.
- Update config object field names from `endpoint` to `searchEndpoint` and add `fetchEndpoint` where shared test helpers require complete config objects.

### New `test/fetch.test.ts`

- Missing API key fails before network calls.
- Valid fetch runs client, normalizer, and formatter.
- Blank URL is rejected before network calls.
- Trimmed URL is sent to the client.

### `test/extension.test.ts`

- Assert both production tools are registered.
- Assert tool names include `ollama_web_search` and `ollama_web_fetch`.
- Assert dev mode registers both `/ollama-search` and `/ollama-fetch`.
- Assert the fetch tool description/guidance distinguishes it from search.
- Preserve missing API key warning coverage.

## Documentation updates

Update `README.md` to state that the package provides two production tools:

- `ollama_web_search`
- `ollama_web_fetch`

Document:

- fetch tool purpose and input
- search-then-fetch usage pattern
- `/ollama-fetch` debug command in dev mode
- troubleshooting endpoint list including both:
  - `https://ollama.com/api/web_search`
  - `https://ollama.com/api/web_fetch`

Remove or replace the existing statement that version 1 intentionally does not include web fetch.

## Verification

Before completing implementation, run:

```bash
npm run typecheck
npm test
```

For package/release content changes, also run:

```bash
npm pack --dry-run
```
