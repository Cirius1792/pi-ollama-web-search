# Ollama Web Full Content Retrieval Design

## Context

`@cltec/pi-ollama-web-search` currently protects pi context by truncating long formatted output from `ollama_web_search` and `ollama_web_fetch`.

That behavior is useful, but it leaves a gap: when output is truncated, the agent needs a first-class, documented, tool-driven way to recover the full content later. The current implementation returns the normalized payload in `details`, but that is not a reliable recovery contract for the model.

This design adds an explicit retrieval flow that keeps normal search/fetch output context-safe while still allowing the agent to recover the full underlying content when needed.

## Goals

- Preserve context-safe default output for `ollama_web_search` and `ollama_web_fetch`.
- Make full content retrieval explicit, reliable, and model-friendly.
- Allow the agent to recover full content inline or export it to a file.
- Return enough metadata for the model to make good retrieval decisions.
- Keep the API surface small.
- Support both search and fetch results.
- Support replay on cache miss so refs remain useful beyond a single in-memory cache lifetime.

## Non-goals

- Do not remove truncation from the primary search/fetch tools.
- Do not add cross-session durable snapshot storage.
- Do not store full large payload snapshots in session `details`.
- Do not add automatic orchestration that decides retrieval steps on the model's behalf.
- Do not add a separate delete tool in v1.

## Summary

The extension will expose a stable retrieval handle for every successful search and fetch result.

Flow:

1. `ollama_web_search` and `ollama_web_fetch` continue to return context-safe visible output.
2. Each successful call also returns a `fullContentRef` in structured `details`.
3. The full normalized payload is cached in memory behind that ref.
4. The new `ollama_web_read_full` tool uses the ref to retrieve one selected field at a time, either:
   - inline, for direct model consumption, or
   - as a file export, for large or programmatic workflows.
5. If the ref is missing from memory, the tool transparently replays the original upstream request and rebuilds the cache under the same ref.

This makes refs stable handles for recovering previously seen content without requiring the original primary tool output to carry the whole payload.

## Public interface

### Existing tools

#### `ollama_web_search`

Keep the current input shape:

- Input: `{ query: string }`
- Behavior: calls `POST https://ollama.com/api/web_search`
- Output: visible search results with title, URL, and content

New behavior:

- always return a `fullContentRef` in `details`
- always return retrieval metadata in `details`
- mention the ref in visible output only when truncation happens

#### `ollama_web_fetch`

Keep the current input shape:

- Input: `{ url: string }`
- Behavior: calls `POST https://ollama.com/api/web_fetch`
- Output: visible fetched page title, content, and links

New behavior:

- always return a `fullContentRef` in `details`
- always return retrieval metadata in `details`
- mention the ref in visible output only when truncation happens

### New tool: `ollama_web_read_full`

Add one new production tool for recovering previously seen content by ref.

Input:

- `ref: string`
- `mode?: "inline" | "file"`
- `section?: string`
- `offset?: number`
- `maxChars?: number`
- `resultIndex?: number`
- `path?: string`
- `overwrite?: boolean`

Defaults:

- `mode` defaults to `"inline"`
- `section` defaults to `"content"`
- `offset` defaults to `0`
- omitting `maxChars` means "return the whole selected section" in inline mode

High-level behavior:

- the tool is strictly ref-based
- it retrieves exactly one field/section at a time
- for search refs, `resultIndex` is required and is 1-based
- for fetch refs, `resultIndex` is invalid
- invalid ref/section/parameter combinations fail clearly rather than being ignored

## Retrieval model

### Modes

#### Inline mode

Inline mode returns raw selected text directly to the model.

Rules:

- returns only the selected text, with no wrapper label
- supports `offset` and `maxChars`
- if `maxChars` is omitted, returns the whole selected section
- uses raw field content rather than formatted search/fetch output as the offset basis

#### File mode

File mode writes the full selected section to disk and returns metadata only.

Rules:

- writes the full selected section only
- ignores `offset` and `maxChars`
- never echoes the exported content inline
- returns path/metadata only

### Selectable sections

#### Fetch refs

Supported sections:

- `title`
- `content`
- `links`

Section representation:

- `title` → raw title text
- `content` → raw normalized page content
- `links` → newline-delimited URLs with no numbering

#### Search refs

Supported sections:

- `title`
- `url`
- `content`

Rules:

- `resultIndex` is required
- `resultIndex` is 1-based and matches the numbering shown in visible search output
- retrieval is limited to one field of one result at a time

## Ref semantics

### Ref creation

- every successful search/fetch invocation gets a new unique ref
- refs are not deduplicated by identical inputs
- refs remain stable across replay-based cache rebuilds

### What a ref means

A ref means: recover this previously seen logical target.

Operationally:

- if the normalized payload is still cached in memory, serve from cache
- if the payload is missing, replay the original upstream request using stored replay inputs
- rebuild the cache under the same ref
- then serve the requested section

This is a best-effort reproducible handle, not an immutable snapshot guarantee. Replayed content may differ from the originally observed content.

## Replay and cache behavior

### In-memory cache

Store the normalized structured payload in memory behind each ref.

Stored payload shape:

- fetch refs store normalized `{ title, content, links }`
- search refs store normalized `{ results: [...] }`
- derived retrieval metadata may also be cached for convenience

Do not store only pre-rendered text, and do not use the raw Ollama response as the primary retrieval representation.

### Eviction

Use a size-based LRU-style cache policy.

Rules:

- the primary budget is total stored size, not entry count alone
- least-recently-used entries are evicted first
- a single oversized current entry is still kept even if it exceeds the normal target by itself

### Replay inputs stored in details

Store compact replay metadata in `details`, not the full payload snapshot.

For fetch refs, store at least:

- `kind: "fetch"`
- `ref`
- original `url`

For search refs, store at least:

- `kind: "search"`
- `ref`
- original `query`
- original `maxResults`
- original displayed result URL list in order

This keeps `details` compact while allowing replay and safer search remapping.

### Replay behavior

Replay is allowed in both `inline` and `file` modes.

Rules:

- replay uses the same normalization pipeline as the original request path
- refs remain stable after replay rebuilds cache
- visible output stays transparent; replay is not announced in normal visible text
- `details` may record `servedFrom: "cache" | "replay"`

### Replay failures

If the cache is missing and replay fails, return an explicit combined error explaining both facts.

Example style:

- `Stored content for ref ws_f_abc123 was not available in session cache, and replaying the original fetch request failed: ...`

Do not collapse replay failures into a generic "ref not found" message.

## Search replay remapping

Search refs need extra care because replayed search result order may change.

Rules:

- store the original displayed result URL list in order
- on cache-miss replay, remap the requested `resultIndex` by original URL identity rather than blindly trusting the new numeric order
- if duplicate URLs exist, match by duplicate occurrence order
- if the original URL is no longer present, fail clearly rather than silently using the new result at the same numeric position

This keeps `resultIndex` tied to the originally shown result as much as possible.

## Formatting and truncation

### Fetch formatting

Keep fetch formatting content-first.

Rules:

- preserve title and links whenever reasonably possible
- truncate `content` first
- only truncate title/links when they alone cannot fit under the cap

This allows exact fetch section visibility metadata.

### Search formatting

Search formatting should become result-aware and content-first.

Rules:

- render results in order
- preserve each visible result's title and URL whenever possible
- truncate primarily inside result content
- when truncation happens inside result N, spend remaining budget on that result's content and then stop
- omit later results entirely rather than partially rendering their metadata
- visible truncated output should keep normal numbering for shown results and use one omission note for later results

Recommended omission note style:

```text
Additional search results were omitted from visible output. Use ollama_web_read_full with this ref and a resultIndex to retrieve them.
```

## Retrieval metadata in details

Return retrieval metadata in nested shapes that mirror retrieval inputs.

### Top-level

Search/fetch tool results should include at least:

- `fullContentRef`
- `truncated`
- replay metadata needed for future cache miss recovery
- nested target metadata

### Fetch metadata

Recommended structure:

- `targets.title`
- `targets.content`
- `targets.links`

Each target can include:

- `totalChars`
- `visibleChars`
- `remainingChars`
- `recommendedRetrievalMode`

Because fetch truncation is field-aware, exact `visibleChars` is available.

### Search metadata

Recommended structure:

- `results[1].title`
- `results[1].url`
- `results[1].content`
- etc. for all results, including omitted ones

Each target can include:

- `totalChars`
- `visibleChars`
- `remainingChars`
- `recommendedRetrievalMode`

Truncated search details should include retrieval metadata for all original results, including omitted ones with `visibleChars: 0` where appropriate.

### Retrieval recommendations

Return `recommendedRetrievalMode` per retrievable target, not as one top-level value.

Policy:

- deterministic
- size-based
- derived from the selected target's `remainingChars`

Recommended v1 rule:

- `inline` when `remainingChars <= 12_000`
- `file` when `remainingChars > 12_000`

## Visible output rules

### Non-truncated results

- visible output stays clean
- do not show the ref in visible text
- still return ref and retrieval metadata in `details`

### Truncated results

When truncation happens, visible output should explicitly mention recovery.

Recommended notice style:

```text
[Output truncated to 50000 characters to protect pi context. Full content is available via ollama_web_read_full with ref ws_f_abc123.]
```

For search, if later results are omitted, also include the omission note described above.

## File mode behavior

### Path handling

`path` handling should mirror built-in file tools.

Rules:

- accept relative or absolute paths
- resolve relative paths from `ctx.cwd`
- tolerate a leading `@`
- canonicalize resolved paths before queueing/writing
- allow writing anywhere built-in file tools can write, not just inside the workspace

### Parent directories

- create missing parent directories automatically

### Overwrite behavior

- refuse to overwrite existing files by default
- allow overwrite only when `overwrite: true` is explicitly provided

### File mutation queue

Use pi's file mutation queue for all file-mode writes, including auto-created temp files, so the implementation stays consistent and safe.

### Auto-created temp files

If `path` is omitted:

- create a temporary file automatically
- place it outside the repo, under an extension-specific directory in the system temp area
- auto-delete it on `session_shutdown`

Tool guidance should explicitly say that auto-created files are temporary and will be lost at the end of the session.

### Explicit paths

If `path` is provided:

- treat it as a deliberate export
- do not auto-delete it
- tool guidance should remind the agent to delete explicit export files if they are no longer needed, to avoid polluting the workspace

## Tool guidance

### `ollama_web_search` and `ollama_web_fetch`

Keep existing guidance and add enough metadata so the model can tell how much content is missing when truncation occurs.

### `ollama_web_read_full`

Its description and prompt guidance should explicitly teach the model:

- use `ollama_web_read_full` only with refs from previous search/fetch results
- use `mode: "inline"` when the agent wants full selected text in model context
- use `mode: "file"` when the content is large or should be inspected/programmatically processed with file tools
- if the cached ref is missing from memory, `ollama_web_read_full` may transparently replay the original request
- if no `path` is provided in file mode, the file is temporary and will be lost at session end
- if an explicit `path` is used and the file is no longer needed, delete it rather than polluting the workspace

## Dev tooling

Add a dev-only debug command behind `PI_OLLAMA_SEARCH_DEV`:

- `/ollama-read-full`

This should exercise the same retrieval logic as the production tool for local/manual testing.

## Validation and errors

Reject invalid combinations with clear errors.

Examples:

- `resultIndex is required for search refs.`
- `resultIndex is only valid for search refs.`
- `Section "links" is not valid for search refs.`
- `Section "url" is not valid for fetch refs.`
- `Offset must be 0 or greater.`
- `Search result index 6 is out of range. Valid range is 1-5.`

## Architecture

Recommended module layout:

```text
src/index.ts
  registers search, fetch, and read-full tools and dev commands
  wires cache/temp-file lifecycle hooks

src/store.ts
  ref cache, size accounting, LRU eviction, replay metadata helpers

src/search.ts
  existing search orchestration
  result-aware formatting
  retrieval metadata production

src/fetch.ts
  existing fetch orchestration
  field-aware formatting
  retrieval metadata production

src/read-full.ts
  retrieval validation
  cache lookup
  replay on cache miss
  section extraction
  inline/file execution

src/format.ts
  shared formatting helpers for visible output and truncation notices
```

Also add session cleanup logic:

- clear in-memory ref cache on shutdown
- delete auto-created temp files on `session_shutdown`

## Testing plan

Add or update tests without live Ollama API access.

### New `test/read-full.test.ts`

Cover:

- fetch inline retrieval for each supported section
- search inline retrieval for each supported section
- search `resultIndex` validation and 1-based indexing
- file mode metadata-only responses
- invalid section/ref/parameter combinations
- overwrite behavior
- explicit path handling and parent directory creation

### New `test/store.test.ts`

Cover:

- unique refs per invocation
- cache insert/lookup
- size-based eviction
- oversized current entry behavior
- stable ref reuse after replay rebuild

### Update `test/search.test.ts`

Cover:

- result-aware/content-first truncation
- omission note for later results
- retrieval metadata for all original results
- search replay remapping by original URL identity

### Update `test/fetch.test.ts`

Cover:

- content-first truncation
- exact fetch target visibility metadata
- retrieval metadata production

### Update `test/format.test.ts`

Cover:

- truncation notice includes recovery guidance
- ref is shown only on truncated visible output
- search omission note behavior

### Update `test/extension.test.ts`

Cover:

- `ollama_web_read_full` registration
- `/ollama-read-full` dev command registration in dev mode
- prompt guidance for inline/file mode and cleanup expectations
- `session_shutdown` cleanup behavior where practical

### Replay tests

Cover:

- cache miss triggers replay
- replay uses the normalization pipeline
- replay works in inline and file mode
- replay failure produces combined cache-miss + replay-failure error
- `servedFrom` details flag
- duplicate-URL remapping rules for search replay

## Documentation updates

Update `README.md` after implementation to document:

- that search/fetch outputs may truncate visible content to protect context
- that every successful search/fetch result returns a retrievable ref in structured metadata
- that `ollama_web_read_full` supports inline retrieval and file export
- that file mode without `path` creates a temporary file that is deleted at session end
- that explicit export paths persist and should be cleaned up if no longer needed
- that replay may occur on cache miss and can return changed web content

## Verification

Before completing implementation, run:

```bash
npm run typecheck
npm test
```

If package contents or docs are updated as part of implementation, also run:

```bash
npm pack --dry-run
```
