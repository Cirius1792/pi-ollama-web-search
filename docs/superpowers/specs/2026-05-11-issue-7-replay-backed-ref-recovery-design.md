# Design: issue #7 replay-backed ref recovery on cache miss

## Context

Issue #7 is a focused slice of the parent retrieval PRD in issue #2. The repository already supports:

- stable-looking search refs with in-memory lookup in `src/store.ts`
- fetch refs with inline/file retrieval in `src/retrieval.ts`
- tool dispatch in `src/read-full.ts`
- search/fetch orchestration in `src/search.ts` and `src/fetch.ts`

What is still missing is replay-backed recovery when cached payloads have been evicted or otherwise cleared from in-memory state.

## Scope

Implement issue #7 only, plus minimal surfaced docs/comments if needed.

In scope:

- preserve current public ref formats exactly
  - search: `ws_s_*`
  - fetch: `fetch:*`
- move both search and fetch retrieval to stable-ref, replay-capable behavior
- use size-based cache eviction
- keep the newest oversized entry retrievable
- replay the original search/fetch request on cache miss
- re-run normalization after replay
- preserve search result identity by remapping by original ordered URL identity
- handle duplicate URLs deterministically by occurrence order
- return explicit combined cache-miss plus replay-failure errors
- add/update tests covering the new behavior

Out of scope:

- changing public ref formats
- cross-session persistence
- immutable snapshot recovery guarantees
- broader retrieval redesign outside this issue slice

## Approaches considered

### Recommended: keep separate search/fetch stores, add replay support in each

Preserve the current split between the search store and fetch retrieval store, but upgrade both to support:

- stable refs
- size-based eviction
- replay metadata
- replay-backed recovery
- structured `servedFrom` reporting

This fits the current codebase with the least churn and is the recommended approach.

### Alternative: unify all retrieval into one registry

A single deep retrieval registry would reduce duplication, but it would require a broader refactor across `src/store.ts`, `src/retrieval.ts`, and tool orchestration. That is larger than this issue needs.

### Rejected: encode more reconstruction semantics into refs

This would add risk to the product contract and conflicts with the requirement to preserve ref formats exactly.

## Architecture

### Module boundaries

#### `src/store.ts`

Upgrade the search store from TTL + entry-count eviction to stable-ref + size-based eviction.

Responsibilities:

- issue `ws_s_*` refs
- store compact replay input for search refs
- cache normalized search payloads when present
- track original ordered URL occurrence identity for deterministic replay remapping
- retrieve from cache or replay on cache miss
- rebuild cache under the same ref after successful replay

#### `src/retrieval.ts`

Keep fetch inline/file retrieval here, but make the store replay-capable.

Responsibilities:

- issue `fetch:*` refs
- store compact replay input for fetch refs
- cache normalized fetch payloads when present
- retrieve from cache or replay on cache miss
- rebuild cache under the same ref after successful replay
- preserve existing file export semantics

#### `src/read-full.ts`

Remain the tool-facing dispatcher for search and fetch refs.

Responsibilities:

- keep current validation behavior
- call the upgraded search/fetch retrieval paths
- surface structured `servedFrom: "cache" | "replay"` in retrieval details

#### `src/search.ts` and `src/fetch.ts`

Remain responsible for initial upstream request + normalization, while registering enough compact replay metadata for future recovery.

## Data model

### Search replay state

Each search ref needs:

- `ref`
- `query`
- `maxResults`
- cached normalized payload when present
- original ordered URL occurrence identity derived from the originally normalized results

The ordered URL occurrence identity is used to map the originally requested result back onto replayed results.

Example conceptual identity list:

- result 1: URL `https://a`, occurrence 1
- result 2: URL `https://b`, occurrence 1
- result 3: URL `https://a`, occurrence 2

### Fetch replay state

Each fetch ref needs:

- `ref`
- `url`
- cached normalized payload when present

Because fetch retrieval targets a single normalized page result, no search-style remapping is required.

## Data flow

### Search

1. `ollama_web_search` executes the upstream search request.
2. The response is normalized.
3. A stable `ws_s_*` ref is created once.
4. The search store records replay input and caches the normalized payload.
5. `ollama_web_read_full` for a search ref:
   - serves from cache when payload is present
   - otherwise replays the original search request using stored replay input
   - re-normalizes the replayed response
   - remaps the originally requested result by URL identity + duplicate occurrence order
   - restores cached payload under the same ref
   - returns the requested section with `servedFrom: "replay"`

### Fetch

1. `ollama_web_fetch` executes the upstream fetch request.
2. The response is normalized.
3. A stable `fetch:*` ref is created once.
4. The fetch store records replay input and caches the normalized payload.
5. `ollama_web_read_full` for a fetch ref:
   - serves from cache when payload is present
   - otherwise replays the original fetch request using stored replay input
   - re-normalizes the replayed response
   - restores cached payload under the same ref
   - continues through existing inline or file retrieval behavior with `servedFrom: "replay"`

## Cache eviction

Both search and fetch caches should evict by total retained size rather than TTL or entry count.

Rules:

- older cached payloads are evicted first
- replay metadata remains attached to the stable ref even when the cached payload is evicted
- the newest oversized payload remains retrievable even if it alone exceeds the normal byte budget

This preserves the current user expectation that the most recent result remains readable while still bounding memory growth.

## Replay remapping rules for search

When replaying a search ref:

- do not trust replayed numeric result position
- identify the original target by URL
- if the same URL occurred multiple times in the original response, identify the target by duplicate occurrence order
- match that same URL occurrence in the replayed normalized results
- if the required occurrence is missing, fail clearly instead of silently returning a different result

This ensures that asking for result 3 after cache loss still means the originally observed result 3, not whichever replayed result now happens to occupy slot 3.

## Error handling

### Cache hit

Return the requested content normally with:

- `servedFrom: "cache"`

### Cache miss + replay success

Return the requested content normally with:

- `servedFrom: "replay"`

### Cache miss + replay failure

Return an explicit combined error that states:

- the ref was missing from cache
- replay also failed, including the upstream or normalization failure reason

Examples:

- search: `No stored content found for ref ws_s_abc. Replay also failed: ...`
- fetch: `No stored full content found for ref: fetch:abc. Replay also failed: ...`

### Search replay target cannot be reconstructed

Fail clearly when the original URL occurrence cannot be found in replayed results. Do not silently fall back to numeric position.

## Testing strategy

Drive the work with TDD in four layers.

### 1. Store-level tests

Add failing tests for:

- search size-based eviction replacing TTL/entry-count behavior
- stable refs surviving cache rebuild
- newest oversized search entry staying retrievable
- older search entries evicted first
- fetch replay-capable stable-ref behavior extending current retention tests

### 2. Replay behavior unit tests

Add failing tests for:

- fetch cache miss → replay succeeds → same ref works again → `servedFrom: "replay"`
- fetch cache miss → replay fails → explicit combined error
- search cache miss → replay succeeds and remaps by original URL identity
- search duplicate URL replay maps by occurrence order
- search replay fails when original target can no longer be reconstructed

### 3. Tool-dispatch tests

Extend `test/read-full.test.ts` for:

- search retrieval details including `servedFrom`
- fetch inline/file replay paths flowing through `runOllamaWebReadFull`
- current validation behavior remaining unchanged outside replay recovery

### 4. End-to-end orchestration tests

Extend:

- `test/search.test.ts`
- `test/fetch.test.ts`
- `test/extension.test.ts`

Cover:

- same ref remains usable after cache loss
- replay is transparent to tool callers except for structured details
- fetch file mode still works after replay recovery
- explicit failures when replay cannot reconstruct the target

## Implementation plan shape

This design is well-scoped for one implementation plan with sequential tasks:

1. add failing tests for store + replay semantics
2. implement search stable-ref replayable store behavior
3. implement fetch stable-ref replayable store behavior
4. wire `read-full` to surface `servedFrom`
5. extend orchestration/extension tests
6. run full verification

## Risks and constraints

- search replay depends on URL identity, so changed upstream results can legitimately make a target unrecoverable
- replay must always pass through normalization so cached and replayed retrieval paths stay behaviorally aligned
- fetch file-mode behavior must not regress while replay support is added
- keeping ref formats fixed limits how much identity can be encoded into refs, so replay metadata must live alongside the stable ref

## Success criteria

This design is successful when:

- search and fetch refs preserve their current public formats
- refs remain usable after cache eviction when replay can reconstruct the payload
- replay reuses the same ref rather than minting a replacement
- search replay remaps by original URL occurrence identity
- duplicate URLs are handled deterministically
- replay failures report both cache miss and replay failure clearly
- the newest oversized cached payload remains retrievable
- all relevant tests pass without live Ollama access
