# Issue #7 Replay-Backed Ref Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `ollama_web_read_full` recover stable search and fetch refs after in-memory cache eviction by replaying the original upstream request, while preserving current ref formats and returning explicit reconstruction errors when replay cannot recover the requested target.

**Architecture:** Keep the current split between `src/store.ts` for search refs and `src/retrieval.ts` for fetch refs. Convert both from payload-only caches into stable ref registries that retain compact replay metadata even after payload eviction, then replay through the existing client + normalization pipeline on cache miss. Surface `servedFrom: "cache" | "replay"` in structured retrieval details without changing normal visible output.

**Tech Stack:** TypeScript ESM, Vitest, Node 22, injected `fetch`, existing normalize/client/orchestration modules

---

## File map

- Modify: `src/store.ts`
  - Replace TTL/entry-count search caching with stable-ref, size-based cached payload retention.
  - Keep compact replay inputs (`query`, `maxResults`) and original URL occurrence identities even when payload is evicted.
  - Add a search read path that can replay and remap by URL occurrence.
- Modify: `src/retrieval.ts`
  - Keep fetch file/inline retrieval behavior.
  - Retain stable fetch replay metadata (`url`) after payload eviction.
  - Replay on cache miss and repopulate the same ref.
- Modify: `src/read-full.ts`
  - Dispatch to the upgraded search/fetch read paths.
  - Pass through `servedFrom` in search and fetch details.
- Modify: `src/index.ts`
  - Create stores with replay callbacks wired to the existing client + normalization pipeline.
- Modify: `src/search.ts`
  - Register search refs through the upgraded store API.
- Modify: `src/fetch.ts`
  - Register fetch refs through the upgraded retrieval store API.
- Test: `test/store.test.ts`
  - Search store eviction, replay success, duplicate URL remapping, replay failure.
- Test: `test/retrieval.test.ts`
  - Fetch cache miss replay success/failure plus existing file-mode behavior after replay.
- Test: `test/read-full.test.ts`
  - Dispatcher-level `servedFrom` assertions and unchanged validation behavior.
- Test: `test/extension.test.ts`
  - End-to-end stable refs after cache loss and replay across registered tools.
- Test: `test/search.test.ts`
  - Search orchestration still returns stable refs and metadata after store API changes.
- Test: `test/fetch.test.ts`
  - Fetch orchestration still returns stable refs and metadata after retrieval API changes.
- Modify if needed: `README.md`
  - Add a small note that replay recovery is best-effort, not immutable snapshot restoration.

## Task 1: Upgrade the search store to stable-ref replay recovery

**Files:**
- Modify: `src/store.ts`
- Test: `test/store.test.ts`

- [ ] **Step 1: Write the failing test for search size-based eviction and stable-ref replay metadata retention**

Add this test to `test/store.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createFullContentRef, createSearchContentStore } from "../src/store.js";

describe("search store replay retention", () => {
  const store = createSearchContentStore();

  beforeEach(() => {
    store.clearSearchContentStore();
  });

  it("evicts cached payload bytes but keeps the stable ref replayable", async () => {
    const ref = createFullContentRef("search");

    store.rememberSearchContent({
      ref,
      query: "alpha",
      maxResults: 5,
      payload: {
        results: [
          {
            title: "Large",
            url: "https://example.com/large",
            content: "x".repeat(1_100_000),
          },
        ],
      },
    });

    await expect(
      store.readSearchContent(
        { ref, resultIndex: 1, section: "content" },
        {
          replaySearch: vi.fn(async () => ({
            results: [
              {
                title: "Large",
                url: "https://example.com/large",
                content: "replayed-content",
              },
            ],
          })),
        },
      ),
    ).resolves.toMatchObject({
      text: "replayed-content",
      details: {
        ref,
        kind: "search",
        section: "content",
        resultIndex: 1,
        servedFrom: "replay",
      },
    });
  });
});
```

- [ ] **Step 2: Run the focused search store test to verify it fails**

Run:

```bash
npx vitest run test/store.test.ts -t "evicts cached payload bytes but keeps the stable ref replayable"
```

Expected: FAIL because `readSearchContent` does not exist yet and the search store currently drops evicted entries entirely.

- [ ] **Step 3: Write the failing duplicate-URL remapping test**

Add this test to `test/store.test.ts`:

```ts
it("replays search results by URL occurrence order instead of replayed numeric position", async () => {
  const ref = createFullContentRef("search");

  store.rememberSearchContent({
    ref,
    query: "dup",
    maxResults: 5,
    payload: {
      results: [
        { title: "First A", url: "https://example.com/a", content: "original-a1" },
        { title: "B", url: "https://example.com/b", content: "original-b" },
        { title: "Second A", url: "https://example.com/a", content: "original-a2" },
      ],
    },
  });

  store.clearCachedSearchPayloads();

  const replaySearch = vi.fn(async () => ({
    results: [
      { title: "B replay", url: "https://example.com/b", content: "replay-b" },
      { title: "A replay 1", url: "https://example.com/a", content: "replay-a1" },
      { title: "A replay 2", url: "https://example.com/a", content: "replay-a2" },
    ],
  }));

  await expect(
    store.readSearchContent(
      { ref, resultIndex: 3, section: "content" },
      { replaySearch },
    ),
  ).resolves.toMatchObject({
    text: "replay-a2",
    details: {
      ref,
      kind: "search",
      section: "content",
      resultIndex: 3,
      servedFrom: "replay",
    },
  });
});
```

- [ ] **Step 4: Run the duplicate-URL test to verify it fails for the right reason**

Run:

```bash
npx vitest run test/store.test.ts -t "replays search results by URL occurrence order instead of replayed numeric position"
```

Expected: FAIL because the current store has no replay path and no URL occurrence remapping.

- [ ] **Step 5: Write the failing explicit replay failure test**

Add this test to `test/store.test.ts`:

```ts
it("returns a combined cache-miss plus replay-failure error for search refs", async () => {
  const ref = createFullContentRef("search");

  store.rememberSearchContent({
    ref,
    query: "missing",
    maxResults: 5,
    payload: {
      results: [{ title: "One", url: "https://example.com/one", content: "one" }],
    },
  });

  store.clearCachedSearchPayloads();

  await expect(
    store.readSearchContent(
      { ref, resultIndex: 1, section: "content" },
      {
        replaySearch: vi.fn(async () => {
          throw new Error("HTTP 503");
        }),
      },
    ),
  ).rejects.toThrow(`No stored content found for ref ${ref}. Replay also failed: HTTP 503`);
});
```

- [ ] **Step 6: Run the search store test file to confirm the red state**

Run:

```bash
npx vitest run test/store.test.ts
```

Expected: FAIL with the new replay-related assertions and/or missing methods.

- [ ] **Step 7: Implement the minimal search store registry and replay helpers in `src/store.ts`**

Replace the TTL-based entry model with a stable ref registry plus cached payload retention. Use code shaped like this:

```ts
export const SEARCH_CONTENT_STORE_MAX_BYTES = 1_000_000;

interface SearchReplayIdentity {
  url: string;
  occurrence: number;
}

interface StoredSearchEntry {
  ref: string;
  query: string;
  maxResults: number;
  identities: SearchReplayIdentity[];
  payload?: NormalizedSearchResponse;
  retainedBytes: number;
}

function measureSearchPayloadBytes(payload: NormalizedSearchResponse): number {
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

function buildSearchReplayIdentities(payload: NormalizedSearchResponse): SearchReplayIdentity[] {
  const counts = new Map<string, number>();

  return payload.results.map((result) => {
    const occurrence = (counts.get(result.url) ?? 0) + 1;
    counts.set(result.url, occurrence);
    return { url: result.url, occurrence };
  });
}

function findReplayResultIndex(
  payload: NormalizedSearchResponse,
  identity: SearchReplayIdentity,
): number {
  const counts = new Map<string, number>();

  for (const [index, result] of payload.results.entries()) {
    const occurrence = (counts.get(result.url) ?? 0) + 1;
    counts.set(result.url, occurrence);
    if (result.url === identity.url && occurrence === identity.occurrence) {
      return index;
    }
  }

  return -1;
}
```

- [ ] **Step 8: Implement search replay-aware reads in `src/store.ts`**

Add a search read API that keeps validation and slicing local to the store:

```ts
export async function readSearchContent(
  params: {
    ref: string;
    resultIndex: number;
    section: "title" | "url" | "content";
    offset?: number;
    maxChars?: number;
  },
  deps: {
    replaySearch: (input: { query: string; maxResults: number; signal?: AbortSignal }) => Promise<NormalizedSearchResponse>;
    signal?: AbortSignal;
  },
): Promise<{
  text: string;
  details: {
    ref: string;
    kind: "search";
    section: "title" | "url" | "content";
    resultIndex: number;
    servedFrom: "cache" | "replay";
  };
}> {
  const entry = searchEntries.get(params.ref);
  if (!entry) {
    throw new Error(`No stored content found for ref ${params.ref}.`);
  }

  let payload = entry.payload;
  let servedFrom: "cache" | "replay" = "cache";

  if (!payload) {
    try {
      const replayed = await deps.replaySearch({
        query: entry.query,
        maxResults: entry.maxResults,
        signal: deps.signal,
      });

      const identity = entry.identities[params.resultIndex - 1];
      const replayIndex = findReplayResultIndex(replayed, identity);
      if (replayIndex === -1) {
        throw new Error(
          `Replay could not reconstruct result ${params.resultIndex} for ref ${params.ref}.`,
        );
      }

      entry.payload = replayed;
      entry.retainedBytes = measureSearchPayloadBytes(replayed);
      touchCachedSearchRef(params.ref);
      enforceSearchPayloadBudget(params.ref);
      payload = replayed;
      servedFrom = "replay";
    } catch (error) {
      throw new Error(
        `No stored content found for ref ${params.ref}. Replay also failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const selected = payload.results[servedFrom === "replay"
    ? findReplayResultIndex(payload, entry.identities[params.resultIndex - 1])
    : params.resultIndex - 1];
  const raw = params.section === "title" ? selected.title : params.section === "url" ? selected.url : selected.content;
  const start = params.offset ?? 0;
  const end = params.maxChars === undefined ? undefined : start + params.maxChars;

  return {
    text: raw.slice(start, end),
    details: {
      ref: params.ref,
      kind: "search",
      section: params.section,
      resultIndex: params.resultIndex,
      servedFrom,
    },
  };
}
```

- [ ] **Step 9: Add store instance methods needed by the new tests**

Make `createSearchContentStore()` return these functions in addition to `rememberSearchContent` and `clearSearchContentStore`:

```ts
return {
  rememberSearchContent,
  readSearchContent,
  clearSearchContentStore,
  clearCachedSearchPayloads,
};
```

Use `clearCachedSearchPayloads()` to remove only cached payload bodies while leaving replay metadata intact:

```ts
function clearCachedSearchPayloads(): void {
  for (const entry of searchEntries.values()) {
    entry.payload = undefined;
    entry.retainedBytes = 0;
  }
  cachedSearchPayloadBytes = 0;
  cachedSearchRefs.clear();
}
```

- [ ] **Step 10: Run the search store tests to verify green**

Run:

```bash
npx vitest run test/store.test.ts
```

Expected: PASS.

- [ ] **Step 11: Refactor search store naming and exports while keeping tests green**

Normalize names around the new API so downstream files can use the store consistently:

```ts
export interface SearchContentStore {
  rememberSearchContent: (input: {
    ref: string;
    query: string;
    maxResults: number;
    payload: NormalizedSearchResponse;
  }) => void;
  readSearchContent: typeof readSearchContent;
  clearSearchContentStore: () => void;
  clearCachedSearchPayloads: () => void;
}
```

- [ ] **Step 12: Commit the search store slice**

Run:

```bash
git add src/store.ts test/store.test.ts
git commit -m "feat: add replay-backed search ref recovery"
```

## Task 2: Upgrade fetch retrieval to stable-ref replay recovery

**Files:**
- Modify: `src/retrieval.ts`
- Test: `test/retrieval.test.ts`

- [ ] **Step 1: Write the failing fetch replay-success test**

Add this test to `test/retrieval.test.ts`:

```ts
it("replays a fetch ref on cache miss and keeps the same ref", async () => {
  const replayFetch = vi.fn(async () => ({
    title: "Replay title",
    content: "Replay content body",
    links: ["https://example.com/replay"],
  }));

  const store = createFetchRetrievalStore({ replayFetch });
  const record = store.registerFetchRetrieval({
    title: "Original title",
    content: "Original content body",
    links: ["https://example.com/original"],
    sourceUrl: "https://example.com/page",
  });

  store.clearCachedFetchPayloads();

  await expect(
    store.readFullFetchContent({
      fullContentRef: record.fullContentRef,
      section: "content",
    }),
  ).resolves.toMatchObject({
    mode: "inline",
    text: "Replay content body",
    details: {
      mode: "inline",
      target: "fetch",
      section: "content",
      fullContentRef: record.fullContentRef,
      servedFrom: "replay",
    },
  });
});
```

- [ ] **Step 2: Run the focused fetch replay-success test to verify it fails**

Run:

```bash
npx vitest run test/retrieval.test.ts -t "replays a fetch ref on cache miss and keeps the same ref"
```

Expected: FAIL because `createFetchRetrievalStore` does not accept replay dependencies, fetch entries do not retain replay metadata, and details do not include `servedFrom`.

- [ ] **Step 3: Write the failing combined-error fetch replay test**

Add this test to `test/retrieval.test.ts`:

```ts
it("returns a combined cache-miss plus replay-failure error for fetch refs", async () => {
  const store = createFetchRetrievalStore({
    replayFetch: vi.fn(async () => {
      throw new Error("HTTP 500");
    }),
  });

  const record = store.registerFetchRetrieval({
    title: "Original title",
    content: "Original content body",
    links: ["https://example.com/original"],
    sourceUrl: "https://example.com/page",
  });

  store.clearCachedFetchPayloads();

  await expect(
    store.readFullFetchContent({
      fullContentRef: record.fullContentRef,
      section: "content",
    }),
  ).rejects.toThrow(
    `No stored full content found for ref: ${record.fullContentRef}. Replay also failed: HTTP 500`,
  );
});
```

- [ ] **Step 4: Write the failing file-mode-after-replay test**

Add this test to `test/retrieval.test.ts`:

```ts
it("supports file mode after replay rebuilds a fetch payload", async () => {
  const store = createFetchRetrievalStore({
    replayFetch: vi.fn(async () => ({
      title: "Replay title",
      content: "Replay content body",
      links: ["https://example.com/replay"],
    })),
  });

  const record = store.registerFetchRetrieval({
    title: "Original title",
    content: "Original content body",
    links: ["https://example.com/original"],
    sourceUrl: "https://example.com/page",
  });

  store.clearCachedFetchPayloads();

  const result = await store.readFullFetchContent({
    fullContentRef: record.fullContentRef,
    section: "content",
    mode: "file",
    outputPath: "/tmp/replayed-fetch.txt",
    overwrite: true,
  });

  expect(result).toMatchObject({
    mode: "file",
    details: {
      fullContentRef: record.fullContentRef,
      servedFrom: "replay",
      charsWritten: "Replay content body".length,
    },
  });
});
```

- [ ] **Step 5: Run the fetch retrieval test file to establish the red state**

Run:

```bash
npx vitest run test/retrieval.test.ts
```

Expected: FAIL with missing replay hooks and missing `servedFrom` details.

- [ ] **Step 6: Extend the normalized fetch payload type so replay metadata can retain the original URL**

Modify `src/fetch.ts` and `src/retrieval.ts` to register the source URL alongside the normalized payload:

```ts
export interface RegisterFetchRetrievalInput extends NormalizedFetchResponse {
  sourceUrl: string;
}

export interface StoredFetchEntry {
  sourceUrl: string;
  payload?: NormalizedFetchResponse;
  retainedBytes: number;
}
```

Then update `runOllamaWebFetch` registration like this:

```ts
const normalizedPayload = normalizeWebFetchResponse(raw);
const normalized = registerFetchRetrieval({
  ...normalizedPayload,
  sourceUrl: trimmedUrl,
});
```

- [ ] **Step 7: Implement stable fetch ref metadata retention and replay in `src/retrieval.ts`**

Shape the registry like this:

```ts
export interface CreateFetchRetrievalStoreOptions {
  replayFetch?: (input: { url: string; signal?: AbortSignal }) => Promise<NormalizedFetchResponse>;
}

interface StoredFetchEntry {
  sourceUrl: string;
  payload?: NormalizedFetchResponse;
  retainedBytes: number;
}

function requireFetchEntry(fullContentRef: string): StoredFetchEntry {
  const entry = fetchRetrievalStore.get(fullContentRef.trim());
  if (!entry) {
    throw new Error(`No stored full content found for ref: ${fullContentRef.trim()}`);
  }
  return entry;
}
```

On cache miss inside `readFullFetchContent`, replay and repopulate the same ref:

```ts
let payload = entry.payload;
let servedFrom: "cache" | "replay" = "cache";

if (!payload) {
  try {
    if (!replayFetch) {
      throw new Error("Replay is not configured for fetch retrieval.");
    }
    payload = await replayFetch({ url: entry.sourceUrl, signal: params.signal });
    entry.payload = payload;
    entry.retainedBytes = measureRetainedBytes(payload);
    touchFetchRef(params.fullContentRef);
    enforceFetchStoreLimit(params.fullContentRef);
    servedFrom = "replay";
  } catch (error) {
    throw new Error(
      `No stored full content found for ref: ${params.fullContentRef}. Replay also failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
```

- [ ] **Step 8: Add `servedFrom` to both fetch inline and file details**

Update the result shapes in `src/retrieval.ts`:

```ts
export interface ReadFullInlineResult {
  mode: "inline";
  text: string;
  details: {
    mode: "inline";
    target: "fetch";
    section: FetchRetrievalSection;
    fullContentRef: string;
    servedFrom: "cache" | "replay";
    offset: number;
    maxChars?: number;
    totalChars: number;
    returnedChars: number;
  };
}

export interface ReadFullFileResult {
  mode: "file";
  details: {
    mode: "file";
    target: "fetch";
    section: FetchRetrievalSection;
    fullContentRef: string;
    servedFrom: "cache" | "replay";
    outputPath: string;
    charsWritten: number;
    temporary: boolean;
    overwritten: boolean;
  };
}
```

- [ ] **Step 9: Add a test helper to clear cached fetch payloads without deleting refs**

Return this method from `createFetchRetrievalStore()`:

```ts
function clearCachedFetchPayloads(): void {
  for (const entry of fetchRetrievalStore.values()) {
    entry.payload = undefined;
    entry.retainedBytes = 0;
  }
  fetchRetrievalStoreBytes = 0;
}
```

- [ ] **Step 10: Run the fetch retrieval tests to verify green**

Run:

```bash
npx vitest run test/retrieval.test.ts
```

Expected: PASS.

- [ ] **Step 11: Commit the fetch replay slice**

Run:

```bash
git add src/fetch.ts src/retrieval.ts test/retrieval.test.ts
git commit -m "feat: add replay-backed fetch ref recovery"
```

## Task 3: Wire replay-aware stores through `read-full` and extension setup

**Files:**
- Modify: `src/read-full.ts`
- Modify: `src/index.ts`
- Modify: `src/search.ts`
- Test: `test/read-full.test.ts`

- [ ] **Step 1: Write the failing dispatcher test for search `servedFrom` details**

Add this test to `test/read-full.test.ts`:

```ts
it("returns servedFrom from the replay-aware search store", async () => {
  const readFullFetchContent = createReadFullFetchStub();
  const readSearchContent = vi.fn(async () => ({
    text: "replayed search content",
    details: {
      ref: "ws_s_test",
      kind: "search",
      section: "content",
      resultIndex: 1,
      servedFrom: "replay",
    },
  }));

  const result = await runOllamaWebReadFull(
    { ref: "ws_s_test", section: "content", resultIndex: 1 },
    {
      readFullFetchContent,
      readSearchContent,
    },
  );

  expect(result).toEqual({
    mode: "inline",
    text: "replayed search content",
    details: {
      ref: "ws_s_test",
      kind: "search",
      section: "content",
      resultIndex: 1,
      servedFrom: "replay",
    },
  });
});
```

- [ ] **Step 2: Run the dispatcher test to verify it fails**

Run:

```bash
npx vitest run test/read-full.test.ts -t "returns servedFrom from the replay-aware search store"
```

Expected: FAIL because `runOllamaWebReadFull` still depends on `getStoredSearchContent` and does not accept `readSearchContent`.

- [ ] **Step 3: Update `runOllamaWebReadFull` to dispatch through the new store read API**

Change the options shape in `src/read-full.ts` to this:

```ts
export async function runOllamaWebReadFull(
  input: RunOllamaWebReadFullInput,
  options: {
    readFullFetchContent: (params: ReadFullFetchParams) => Promise<ReadFullFetchResult>;
    readSearchContent: (params: {
      ref: string;
      resultIndex: number;
      section: "title" | "url" | "content";
      offset?: number;
      maxChars?: number;
      signal?: AbortSignal;
    }) => Promise<{
      text: string;
      details: {
        ref: string;
        kind: "search";
        section: "title" | "url" | "content";
        resultIndex: number;
        servedFrom: "cache" | "replay";
      };
    }>;
  },
): Promise<RunOllamaWebReadFullResult> {
```

Use the new search path instead of calling `getStoredSearchContent` directly:

```ts
const searchResult = await options.readSearchContent({
  ref,
  resultIndex: input.resultIndex,
  section,
  offset: input.offset,
  maxChars: input.maxChars,
  signal: input.signal,
});

return {
  mode: "inline",
  text: searchResult.text,
  details: searchResult.details,
};
```

- [ ] **Step 4: Wire replay callbacks from `src/index.ts` using the existing client + normalization pipeline**

Create the stores with replay callbacks that re-run normalization:

```ts
const searchContentStore = createSearchContentStore({
  replaySearch: async ({ query, maxResults, signal }) => {
    const raw = await searchOllamaWeb({
      endpoint: config.searchEndpoint,
      apiKey: config.apiKey!,
      query,
      maxResults,
      signal,
    });
    return normalizeWebSearchResponse(raw);
  },
});

const fetchRetrievalStore = createFetchRetrievalStore({
  replayFetch: async ({ url, signal }) => {
    const raw = await fetchOllamaWeb({
      endpoint: config.fetchEndpoint,
      apiKey: config.apiKey!,
      url,
      signal,
    });
    return normalizeWebFetchResponse(raw);
  },
});
```

- [ ] **Step 5: Update the registered read-full tool to use `readSearchContent`**

Change the `runOllamaWebReadFull` call in `src/index.ts` to:

```ts
const result = await runOllamaWebReadFull(
  { ...params, cwd: ctx?.cwd, signal },
  {
    readFullFetchContent: fetchRetrievalStore.readFullFetchContent,
    readSearchContent: (searchParams) =>
      searchContentStore.readSearchContent(searchParams),
  },
);
```

- [ ] **Step 6: Keep search registration simple in `src/search.ts`**

Do not add replay logic here. Keep `runOllamaWebSearch` focused on the first call and registration:

```ts
options.rememberSearchContent?.({
  ref: fullContentRef,
  query: trimmedQuery,
  maxResults: options.config.maxResults,
  payload: normalized,
});
```

The only code change needed in this file is adapting types if the store return shape changed.

- [ ] **Step 7: Run the dispatcher tests to verify green**

Run:

```bash
npx vitest run test/read-full.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit the dispatcher/wiring slice**

Run:

```bash
git add src/index.ts src/read-full.ts src/search.ts test/read-full.test.ts
git commit -m "feat: wire replay recovery through read-full"
```

## Task 4: Prove the end-to-end behavior through orchestration and extension tests

**Files:**
- Modify: `test/extension.test.ts`
- Modify: `test/search.test.ts`
- Modify: `test/fetch.test.ts`
- Modify if needed: `README.md`

- [ ] **Step 1: Write the failing extension test for search replay after cache loss**

Add this test to `test/extension.test.ts`:

```ts
it("replays a search ref after cached payload loss and preserves the same ref", async () => {
  process.env.OLLAMA_API_KEY = "test-key";

  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          results: [{ title: "One", url: "https://example.com/one", content: "first content" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          results: [{ title: "One replay", url: "https://example.com/one", content: "replayed content" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

  vi.stubGlobal("fetch", fetchImpl);

  const fake = createFakePi();
  extension(fake.pi as any);

  const searchTool = fake.tools.find((tool) => tool.name === "ollama_web_search");
  const readFullTool = fake.tools.find((tool) => tool.name === "ollama_web_read_full");

  const searchResult = await searchTool!.execute("search-1", { query: "test query" }, new AbortController().signal);
  const ref = searchResult.details.fullContentRef;

  await fake.handlers.session_start({}, { hasUI: false, ui: { notify: vi.fn() } });

  const replayed = await readFullTool!.execute(
    "read-1",
    { ref, section: "content", resultIndex: 1 },
    new AbortController().signal,
  );

  expect(replayed).toEqual({
    content: [{ type: "text", text: "replayed content" }],
    details: {
      ref,
      kind: "search",
      section: "content",
      resultIndex: 1,
      servedFrom: "replay",
    },
  });
});
```

- [ ] **Step 2: Write the failing extension test for fetch file mode after replay**

Add this test to `test/extension.test.ts`:

```ts
it("replays a fetch ref before writing file mode output", async () => {
  process.env.OLLAMA_API_KEY = "test-key";

  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          title: "Original title",
          content: "Original body",
          links: ["https://example.com/original"],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          title: "Replay title",
          content: "Replay body",
          links: ["https://example.com/replay"],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

  vi.stubGlobal("fetch", fetchImpl);

  const fake = createFakePi();
  extension(fake.pi as any);

  const fetchTool = fake.tools.find((tool) => tool.name === "ollama_web_fetch");
  const readFullTool = fake.tools.find((tool) => tool.name === "ollama_web_read_full");

  const fetchResult = await fetchTool!.execute("fetch-1", { url: "https://example.com/page" }, new AbortController().signal);
  const ref = fetchResult.details.fullContentRef;

  await fake.handlers.session_start({}, { hasUI: false, ui: { notify: vi.fn() } });

  const workspaceDir = await mkdtemp(join(tmpdir(), "pi-ollama-web-search-replay-"));
  try {
    const replayed = await readFullTool!.execute(
      "read-1",
      { ref, section: "content", mode: "file", path: "exports/replayed.txt" },
      new AbortController().signal,
      undefined,
      { cwd: workspaceDir },
    );

    expect(replayed.details.servedFrom).toBe("replay");
    expect(await readFile(replayed.details.outputPath, "utf8")).toBe("Replay body");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Write the failing extension test for search replay reconstruction failure**

Add this test to `test/extension.test.ts`:

```ts
it("fails clearly when search replay cannot reconstruct the original URL occurrence", async () => {
  process.env.OLLAMA_API_KEY = "test-key";

  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          results: [
            { title: "One", url: "https://example.com/a", content: "a1" },
            { title: "Two", url: "https://example.com/a", content: "a2" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          results: [
            { title: "Only one", url: "https://example.com/a", content: "a1 replay" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

  vi.stubGlobal("fetch", fetchImpl);

  const fake = createFakePi();
  extension(fake.pi as any);

  const searchTool = fake.tools.find((tool) => tool.name === "ollama_web_search");
  const readFullTool = fake.tools.find((tool) => tool.name === "ollama_web_read_full");

  const searchResult = await searchTool!.execute("search-1", { query: "dup query" }, new AbortController().signal);
  const ref = searchResult.details.fullContentRef;

  await fake.handlers.session_start({}, { hasUI: false, ui: { notify: vi.fn() } });

  await expect(
    readFullTool!.execute(
      "read-1",
      { ref, section: "content", resultIndex: 2 },
      new AbortController().signal,
    ),
  ).rejects.toThrow(
    `No stored content found for ref ${ref}. Replay also failed: Replay could not reconstruct result 2 for ref ${ref}.`,
  );
});
```

- [ ] **Step 4: Run the extension test file to verify the red state**

Run:

```bash
npx vitest run test/extension.test.ts
```

Expected: FAIL because the new replay behavior is not yet fully wired end-to-end.

- [ ] **Step 5: Update unit-level orchestration tests only where signatures/details changed**

Adjust `test/search.test.ts` and `test/fetch.test.ts` to keep asserting current metadata plus the new detail shapes. Use assertions like these:

```ts
expect(result.fullContentRef).toMatch(/^ws_s_/);
expect(result.retrieval?.kind).toBe("search");
```

```ts
expect(result.normalized.fullContentRef).toMatch(/^fetch:[a-f0-9]{24}$/);
expect(result.normalized.retrieval.targets.content.fullContentRef).toBe(result.normalized.fullContentRef);
```

Do not add replay-specific expectations to `runOllamaWebSearch` or `runOllamaWebFetch`; replay is exercised through the read path.

- [ ] **Step 6: Add the minimal README note only if the current text does not already say replay is best-effort**

If `README.md` is still missing that point, add one sentence under the retrieval usage section:

```md
Refs are stable best-effort retrieval handles: when cached content has been evicted, the extension may replay the original upstream request and recover changed content under the same ref. Replay is not an immutable historical snapshot guarantee.
```

- [ ] **Step 7: Run the end-to-end test files to verify green**

Run:

```bash
npx vitest run test/extension.test.ts test/search.test.ts test/fetch.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit the orchestration slice**

Run:

```bash
git add test/extension.test.ts test/search.test.ts test/fetch.test.ts README.md
git commit -m "test: cover replay-backed full-content recovery"
```

## Task 5: Final verification and cleanup

**Files:**
- Modify if needed: any files touched in Tasks 1-4

- [ ] **Step 1: Check git status before the final verification pass**

Run:

```bash
git status --short
```

Expected: only the intended files for issue #7 are modified.

- [ ] **Step 2: Run type checking**

Run:

```bash
npm run typecheck
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 3: Run the full test suite**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 4: If package contents changed materially, dry-run the package build**

Run:

```bash
npm pack --dry-run
```

Expected: PASS and package contents remain intentional.

- [ ] **Step 5: Check git status after verification**

Run:

```bash
git status --short
```

Expected: clean working tree, or only the exact uncommitted docs/README changes you intentionally chose to leave for the final commit.

- [ ] **Step 6: Create the final implementation commit if needed**

Run:

```bash
git add src/store.ts src/retrieval.ts src/read-full.ts src/index.ts src/search.ts src/fetch.ts test/store.test.ts test/retrieval.test.ts test/read-full.test.ts test/extension.test.ts test/search.test.ts test/fetch.test.ts README.md
git commit -m "feat: add replay-backed ref recovery on cache miss"
```

## Self-review

### Spec coverage

- Stable refs preserved with current formats: Task 1, Task 2, Task 4
- Size-based eviction with newest oversized entry retrievable: Task 1, Task 2
- Replay-backed recovery for search and fetch: Task 1, Task 2, Task 3, Task 4
- Replay normalization through existing pipeline: Task 3
- Search remapping by original URL identity with duplicate handling: Task 1, Task 4
- Combined cache-miss plus replay-failure errors: Task 1, Task 2, Task 4
- File mode after replay: Task 2, Task 4
- Verification commands: Task 5

### Placeholder scan

- No `TODO`, `TBD`, or “implement later” markers remain.
- Every test-writing step includes actual test code.
- Every code-writing step includes concrete code shapes or signatures.
- Every run step includes an exact command and expected result.

### Type consistency

- Search read path consistently uses `readSearchContent`.
- Fetch read path consistently uses `readFullFetchContent`.
- `servedFrom` is consistently typed as `"cache" | "replay"`.
- Search sections remain `"title" | "url" | "content"`.
- Fetch sections remain `"title" | "content" | "links"`.
