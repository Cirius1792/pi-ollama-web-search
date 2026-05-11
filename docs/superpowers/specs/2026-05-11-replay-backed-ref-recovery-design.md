# Replay-Backed Ref Recovery Design

## Context

Issue #7 implements replay-backed recovery for full-content refs when in-memory cache entries have been evicted or cleared. It is part of issue #2’s full-content retrieval PRD.

The repository already supports:
- `ollama_web_search` with search refs (`ws_s_*`)
- `ollama_web_fetch` with fetch refs (`fetch:*`)
- `ollama_web_read_full` for recovering one section at a time
- fetch file export mode

Current gaps:
- search refs are stored in a TTL/entry-count in-memory store
- fetch refs use size-based eviction but fail hard on cache miss
- retrieval does not transparently replay original upstream requests after cache loss

## Scope

This design is scoped to issue #7 plus user-facing docs updates directly related to replay-backed recovery.

In scope:
- stable refs with replay-backed recovery after cache miss
- size-based eviction for search and fetch retrieval storage
- preserving newest oversized entry retrievability
- replaying original search/fetch requests and re-running normalization
- deterministic search result remapping by original URL identity, including duplicate URLs by occurrence order
- explicit cache-miss plus replay-failure errors
- README updates describing best-effort replay semantics

Out of scope:
- unrelated cleanup
- new user-facing tools
- immutable snapshot persistence across sessions
- broader PRD follow-on work outside issue #7

## Approach

Recommended approach: deepen the existing retrieval modules instead of adding a new generic abstraction.

Why:
- `src/store.ts` already owns search ref storage
- `src/retrieval.ts` already owns fetch retrieval behavior
- `src/read-full.ts` is already the public retrieval entrypoint

This keeps the public tool surface stable while centralizing replay behavior behind small internal interfaces.

## Architecture

### Search retrieval store

Replace the current search TTL/entry-count cache with a stable-ref, size-bounded store.

Each stored search ref should retain:
- stable ref string
- normalized search payload when cached
- compact replay input: original `query` and `maxResults`
- original ordered result identity list derived from observed URLs, preserving duplicate occurrence order

On cache miss, the store should replay the original search request, normalize the response again, remap the originally requested result using URL identity plus occurrence order, rebuild the cache under the same ref, and return the rebuilt payload.

### Fetch retrieval store

Extend the existing fetch retrieval store so each ref retains:
- stable ref string
- normalized fetch payload when cached
- compact replay input: original `url`

On cache miss, the store should replay the original fetch request, normalize again, rebuild the cache under the same ref, and then serve the request through the same inline/file retrieval path.

### Read-full orchestration

`runOllamaWebReadFull` remains the public entrypoint.

It should no longer treat missing cache state as an immediate terminal failure. Instead, it should delegate to replay-aware search and fetch retrieval backends that can:
- serve from cache
- transparently replay and rebuild
- fail with explicit combined errors when replay does not recover the requested target

## Data Flow

### Search replay flow

1. `ollama_web_search` runs normally.
2. It creates a stable `ws_s_*` ref.
3. The search store records the cached normalized payload plus compact replay metadata.
4. Later, `ollama_web_read_full` requests `resultIndex + section`.
5. If cached payload exists, retrieval behaves as it does today.
6. If the payload is missing:
   - replay the original search request
   - normalize the replayed response
   - remap the original requested result by URL identity and duplicate occurrence order
   - if remap succeeds, rebuild the cache under the same ref and return the requested section
   - if remap fails, throw a clear error in the repository’s existing style

### Duplicate URL handling

Remapping must be deterministic.

Example original result URLs:
1. `a.com`
2. `b.com`
3. `a.com`

Replay remapping targets:
- original result 1 -> first `a.com`
- original result 2 -> `b.com`
- original result 3 -> second `a.com`

This prevents drift to the wrong duplicate match.

### Fetch replay flow

1. `ollama_web_fetch` runs normally.
2. It creates a stable `fetch:*` ref.
3. The fetch retrieval store records the cached normalized payload plus original URL replay input.
4. `ollama_web_read_full` later requests a section and optional `mode=file`.
5. If cached payload exists, retrieval behaves as it does today.
6. If the payload is missing:
   - replay the original fetch request
   - normalize the replayed response
   - rebuild cache under the same ref
   - continue through the normal inline/file retrieval path

## Structured Details

Keep additive metadata minimal and aligned with the issue/PRD.

Where natural, retrieval details may indicate whether the response was served from cache or replay. Replay should not add extra visible output chatter.

## Error Handling

Use the repository’s current style of clear thrown `Error` messages.

Behavior:
- cache hit: existing behavior, with additive served-from metadata where appropriate
- cache miss + replay success: return normally under the same ref
- cache miss + replay HTTP/network/normalization failure: throw an explicit combined cache-miss plus replay-failure error
- search replay success + remap failure: throw a clear error that the cache entry was missing, replay completed, but the original search result could not be reconstructed from replayed results

## Testing Strategy

Tests should remain behavior-focused and TDD-driven.

Planned coverage:
- `test/store.test.ts`
  - search store uses size-based eviction
  - newest oversized search entry remains retrievable
  - stable refs remain reusable after replay rebuilds cache
- `test/retrieval.test.ts`
  - fetch cache miss triggers replay recovery
  - replay works in both inline and file modes
  - combined cache-miss plus replay-failure errors are explicit
- `test/search.test.ts`
  - search replay remaps by original URL identity
  - duplicate URLs remap deterministically by occurrence
  - remap failure is explicit when the original target disappears
- `test/extension.test.ts`
  - refs still work after cache clear when replay is possible
  - same ref remains usable across replay recovery

## Documentation

Update `README.md` to explain:
- refs are best-effort stable handles
- cache loss may trigger transparent replay
- replay is not immutable snapshot restoration
- recovery can still fail if the original target can no longer be reconstructed

## Implementation Notes

Expected files to touch:
- `src/store.ts`
- `src/retrieval.ts`
- `src/read-full.ts`
- `src/search.ts`
- `src/fetch.ts`
- relevant tests under `test/`
- `README.md`

Keep imports extension-suffixed and preserve abort-signal propagation during replay.
