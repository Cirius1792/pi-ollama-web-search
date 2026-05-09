# Ollama Web Full Content Retrieval Design

## Context

`@cltec/pi-ollama-web-search` currently protects pi context by truncating long formatted output from `ollama_web_search` and `ollama_web_fetch`.

That protects the model context window, but it creates an important gap: when truncation happens, the agent does not have a first-class, documented, tool-driven way to recover the full content later in the same session. The current implementation returns the full normalized payload in `details`, but that is not a reliable recovery contract for the model.

This design adds an explicit, session-local full-content retrieval flow so truncated search and fetch results remain recoverable without re-calling Ollama.

## Goals

- Preserve the existing context-protection behavior for primary search and fetch tool outputs.
- Make full content retrieval explicit and reliable when output is truncated.
- Guarantee recovery within the current session without re-fetching from Ollama.
- Use session-local, in-memory storage only.
- Keep the API surface small and model-friendly.
- Support both web search and web fetch results.
- Allow agents to page through large stored content safely.
- Allow search retrieval to target a specific result by index.

## Non-goals

- Do not persist stored content across sessions or process restarts.
- Do not write stored payloads to disk.
- Do not add caching of Ollama API responses beyond the current session-memory store.
- Do not add automatic multi-step orchestration that chains retrieval calls on the model's behalf.
- Do not remove truncation from the primary search or fetch tool outputs.
- Do not add a manual deletion tool in v1.

## Summary of the design

When `ollama_web_search` or `ollama_web_fetch` produces output that exceeds the context-safety cap, the extension will:

1. Store the full normalized result in a session-local in-memory store.
2. Return the usual truncated text for model context safety.
3. Add explicit recovery information to both the visible text and structured `details`.
4. Expose a new tool, `ollama_web_read_full`, that reads the stored content by opaque reference in bounded slices.

This keeps the default behavior safe while making large results recoverable in a documented way.

## Public interface

### Existing tools

#### `ollama_web_search`

Keep the current input shape:

- Input: `{ query: string }`
- Behavior: calls `POST https://ollama.com/api/web_search`
- Output: formatted search results with title, URL, and content snippets

New behavior when the formatted output is truncated:

- store the full normalized search result in the session store
- return truncation metadata in `details`
- append a visible recovery instruction naming `ollama_web_read_full`

#### `ollama_web_fetch`

Keep the current input shape:

- Input: `{ url: string }`
- Behavior: calls `POST https://ollama.com/api/web_fetch`
- Output: formatted fetched page title, content, and links

New behavior when the formatted output is truncated:

- store the full normalized fetch result in the session store
- return truncation metadata in `details`
- append a visible recovery instruction naming `ollama_web_read_full`

### New tool: `ollama_web_read_full`

Add one new production tool for in-session retrieval of stored content.

Input:

- `ref: string`
- `offset?: number`
- `maxChars?: number`
- `resultIndex?: number`

Behavior:

- loads the stored entry identified by `ref`
- for fetch refs, reads the fetched page content
- for search refs without `resultIndex`, reads the full stored search payload as formatted text
- for search refs with `resultIndex`, reads only the selected result's content
- returns only the requested bounded slice

Output:

- a text slice suitable for model consumption
- structured metadata including:
  - `ref`
  - `offset`
  - `returnedChars`
  - `totalChars`
  - `hasMore`
  - `nextOffset?`
  - `resultIndex?`

## Truncation contract

### Visible text

When truncation occurs, the tool output should do more than say that truncation happened. It should explicitly tell the model how to recover the remainder.

Recommended notice style:

```text
[Output truncated to 50000 characters to protect pi context. Full content is available via ollama_web_read_full with ref ws_f_abc123.]
```

This notice should appear in normal visible tool content so the model can see the recovery path without depending on hidden internals.

### Structured metadata

When truncation occurs, `details` should include metadata such as:

- `truncated: true`
- `fullContentRef: string`
- `fullContentKind: "search" | "fetch"`
- `totalChars: number`
- `availableSegments?: number`

When truncation does not occur, include:

- `truncated: false`

The full normalized payload should no longer be treated as the primary recovery mechanism. The explicit ref-based contract is the recovery mechanism.

## Retrieval semantics

### Paging model

Use `offset + maxChars` paging rather than precomputed chunk ids.

Why:

- simpler tool contract
- easier for the model to continue reading from `nextOffset`
- works naturally for both fetch and search
- avoids extra chunk-index bookkeeping in v1

### Search-specific retrieval

For search refs, support `resultIndex`.

Behavior:

- if `resultIndex` is omitted, the retrieval tool reads the entire stored search payload as formatted text
- if `resultIndex` is provided, the retrieval tool reads only that specific result

This avoids wasting context when the agent only needs one search result's full content.

### Context safety of retrieval

`ollama_web_read_full` must also remain context-safe.

That means:

- `maxChars` is bounded server-side
- returned content may itself be partial
- the tool always reports whether more content remains

The retrieval tool is therefore not a bypass around context safety. It is a controlled paging interface.

## Storage model

### Session-local store

Add an internal in-memory store owned by the extension runtime.

Each entry should include:

- `ref: string`
- `kind: "search" | "fetch"`
- full normalized payload
- `createdAt: number`
- `lastAccessedAt: number`
- aggregate size metadata

Recommended metadata:

- `totalChars`
- for search entries, per-result char counts

### Ref generation

Use opaque random ids that do not reveal URLs or queries.

Examples:

- `ws_f_<random>` for fetch
- `ws_s_<random>` for search

The exact random format is an implementation detail, but refs must be unique within the process lifetime and easy to distinguish by kind during debugging.

### Lifetime

Entries live only for the current session / extension runtime.

Entries are lost when:

- pi exits
- the extension reloads
- the process restarts

This is acceptable because the requirement is guaranteed in-session recoverability, not cross-session persistence.

### Eviction policy

Use a simple bounded in-memory policy.

Recommended v1 behavior:

- cap the number of stored entries, e.g. 20 to 50
- evict least-recently-accessed entries when the cap is exceeded

This prevents unbounded memory growth while keeping the implementation straightforward.

## Architecture

Keep the current layered search/fetch flow and add a minimal set of modules.

```text
src/index.ts
  registers search, fetch, and read-full tools
  wires session store into handlers

src/store.ts
  in-memory store for truncated results
  ref creation, lookup, access tracking, eviction

src/search.ts
  existing search orchestration
  stores full normalized result when truncation occurs
  returns truncation metadata

src/fetch.ts
  existing fetch orchestration
  stores full normalized result when truncation occurs
  returns truncation metadata

src/read-full.ts
  validates retrieval params
  loads stored entries
  slices content by offset/maxChars
  supports resultIndex for search refs

src/format.ts
  formats search/fetch output
  produces recovery notices when truncation occurs
```

This keeps search/fetch responsibilities intact and isolates new storage and retrieval behavior in small, testable modules.

## Data flow

### Truncated fetch flow

```text
ollama_web_fetch
  → call Ollama fetch API
  → normalize full response
  → format output with maxOutputChars
  → if not truncated: return normal result
  → if truncated:
      → store normalized payload in session store
      → generate opaque ref
      → append recovery notice with ref
      → return truncated text + truncation metadata
```

### Truncated search flow

```text
ollama_web_search
  → call Ollama search API
  → normalize full response
  → format output with maxOutputChars
  → if not truncated: return normal result
  → if truncated:
      → store normalized payload in session store
      → generate opaque ref
      → append recovery notice with ref
      → return truncated text + truncation metadata
```

### Retrieval flow

```text
ollama_web_read_full
  → validate ref/offset/maxChars/resultIndex
  → load stored entry from session store
  → select fetch content or search content
  → slice requested range
  → return bounded text slice + paging metadata
```

## Validation and error handling

`ollama_web_read_full` should return clear user-facing errors.

Cases to cover:

- unknown ref
- expired or evicted ref
- invalid `offset`
- invalid `maxChars`
- invalid `resultIndex`
- `resultIndex` provided for a fetch ref, if that is rejected rather than ignored

Recommended messages:

- `Stored Ollama web result not found for ref ws_f_abc123. It may have expired from session memory.`
- `Offset must be 0 or greater.`
- `maxChars must be greater than 0.`
- `Search result index 6 is out of range.`

The search and fetch tools should continue using the current API key and network error behavior. This design only changes recovery after successful responses.

## Result shaping

Search and fetch orchestration functions should return richer structured results than today.

Recommended shape:

- `formatted: string`
- `normalized: ...`
- `truncated: boolean`
- `fullContentRef?: string`
- `totalChars: number`

This allows `src/index.ts` to expose both:

- context-safe visible text
- machine-readable truncation metadata in `details`

## Formatting details

### Search and fetch output

When not truncated, keep existing formatting behavior unchanged.

When truncated:

- preserve the current truncation notice style
- extend it with a recovery instruction naming `ollama_web_read_full` and the generated ref

### Retrieval output

The retrieval tool should return plain readable text plus clear paging metadata.

Recommended behavior:

- return exactly one bounded slice per call
- do not attempt to auto-stream subsequent slices
- include `hasMore` and `nextOffset` when additional content remains

This keeps the interaction model predictable for both the agent and tests.

## Testing plan

Add or update tests without requiring live Ollama API access.

### New `test/store.test.ts`

Cover:

- storing search and fetch entries
- retrieving by ref
- access-time updates
- eviction behavior
- unknown ref handling

### New `test/read-full.test.ts`

Cover:

- fetch paging by `offset` and `maxChars`
- search paging without `resultIndex`
- search paging with `resultIndex`
- invalid ref
- invalid offset
- invalid maxChars
- invalid result index

### Update `test/format.test.ts`

Cover:

- truncation notice includes recovery guidance
- ref appears in the truncation notice when content is stored
- non-truncated output remains unchanged

### Update `test/search.test.ts` and `test/fetch.test.ts`

Cover:

- truncated results are stored
- orchestration returns `truncated`, `fullContentRef`, and `totalChars`
- non-truncated results do not create store entries

### Update `test/extension.test.ts`

Cover:

- `ollama_web_read_full` is registered as a production tool
- search/fetch tools expose truncation metadata when needed
- existing search/fetch registration behavior remains intact

## Documentation updates

Update `README.md` after implementation to document:

- that long outputs may be truncated to protect context
- that full content can be recovered within the session using `ollama_web_read_full`
- that retrieval is session-local and does not survive restart

If needed, update troubleshooting guidance to explain expired refs.

## Verification

Before completing implementation, run:

```bash
npm run typecheck
npm test
```

If package contents or documentation are updated as part of implementation, also run:

```bash
npm pack --dry-run
```
