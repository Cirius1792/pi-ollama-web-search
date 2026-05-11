# Replay-Backed Ref Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `ollama_web_read_full` recover stable search and fetch refs after payload cache eviction by replaying the original upstream request, re-normalizing the response, and preserving search result identity by original URL occurrence.

**Architecture:** Keep `runOllamaWebReadFull` as the public entrypoint, but move replay-aware recovery behind the existing search store and fetch retrieval store. Search storage becomes size-bounded and replay-aware, fetch retrieval keeps its stable ref and file export behavior while adding replay metadata and cache-miss recovery, and both flows surface explicit cache-vs-replay details without changing visible tool output.

**Tech Stack:** TypeScript ESM, Vitest, Node.js fs/promises, existing Ollama client/normalize pipeline, pi extension tool registration.

---

### Task 1: Make the search store size-bounded and replay-aware

**Files:**
- Modify: `src/store.ts`
- Test: `test/store.test.ts`

- [ ] **Step 1: Write the failing search-store tests for size eviction and replay metadata retention**

```ts
import { SEARCH_CONTENT_STORE_MAX_BYTES, createFullContentRef, createSearchContentStore } from "../src/store.js";

it("evicts cached payloads by retained bytes but preserves replay metadata for the same ref", () => {
  const store = createSearchContentStore();
  const firstRef = createFullContentRef("search");
  const secondRef = createFullContentRef("search");

  store.rememberSearchContent({
    ref: firstRef,
    query: "first query",
    maxResults: 5,
    payload: { results: [{ title: "first", url: "https://example.com/first", content: "a".repeat(900_000) }] },
  });

  store.rememberSearchContent({
    ref: secondRef,
    query: "second query",
    maxResults: 5,
    payload: { results: [{ title: "second", url: "https://example.com/second", content: "b".repeat(900_000) }] },
  });

  expect(store.getStoredSearchContent(firstRef)).toBeUndefined();
  expect(store.getStoredSearchReplay(firstRef)).toMatchObject({
    ref: firstRef,
    query: "first query",
    originalResultUrls: ["https://example.com/first"],
  });
  expect(store.getStoredSearchContent(secondRef)).toBeDefined();
});

it("keeps the newest oversized search payload retrievable", () => {
  const store = createSearchContentStore();
  const oldRef = createFullContentRef("search");
  const oversizedRef = createFullContentRef("search");

  store.rememberSearchContent({
    ref: oldRef,
    query: "old",
    maxResults: 5,
    payload: { results: [{ title: "old", url: "https://example.com/old", content: "payload" }] },
  });

  store.rememberSearchContent({
    ref: oversizedRef,
    query: "oversized",
    maxResults: 5,
    payload: { results: [{ title: "new", url: "https://example.com/new", content: "x".repeat(SEARCH_CONTENT_STORE_MAX_BYTES + 10_000) }] },
  });

  expect(store.getStoredSearchContent(oldRef)).toBeUndefined();
  expect(store.getStoredSearchContent(oversizedRef)).toBeDefined();
});
```

- [ ] **Step 2: Run the focused store tests to verify they fail**

Run:
```bash
npx vitest run test/store.test.ts
```

Expected: FAIL because `SEARCH_CONTENT_STORE_MAX_BYTES` and `getStoredSearchReplay()` do not exist and the store still uses TTL/entry-count eviction.

- [ ] **Step 3: Replace the search TTL store with size-bounded cached payload storage plus retained replay metadata**

```ts
export const SEARCH_CONTENT_STORE_MAX_BYTES = 1_000_000;
export const SEARCH_CONTENT_STORE_MAX_ENTRIES = 256;

export interface StoredSearchReplay {
  kind: "search";
  ref: string;
  query: string;
  maxResults: number;
  originalResultUrls: string[];
}

interface StoredSearchEntry {
  replay: StoredSearchReplay;
  payload?: NormalizedSearchResponse;
  retainedBytes: number;
}

function buildStoredSearchReplay(input: { ref: string; query: string; maxResults: number; payload: NormalizedSearchResponse }): StoredSearchReplay {
  return {
    kind: "search",
    ref: input.ref,
    query: input.query,
    maxResults: input.maxResults,
    originalResultUrls: input.payload.results.map((result) => result.url),
  };
}

function rememberSearchContent(input: { ref: string; query: string; maxResults: number; payload: NormalizedSearchResponse }): void {
  const replay = buildStoredSearchReplay(input);
  const retainedBytes = Buffer.byteLength(JSON.stringify(input.payload), "utf8");

  contentStore.delete(input.ref);
  contentStore.set(input.ref, {
    replay,
    payload: input.payload,
    retainedBytes,
  });

  enforceSearchStoreLimit(input.ref);
}

function getStoredSearchReplay(ref: string): StoredSearchReplay | undefined {
  return contentStore.get(ref)?.replay;
}
```

- [ ] **Step 4: Run the store tests again to verify they pass**

Run:
```bash
npx vitest run test/store.test.ts
```

Expected: PASS, with assertions proving the store now evicts cached payloads by total bytes and preserves replay inputs for evicted refs.

- [ ] **Step 5: Commit the search-store slice**

```bash
git add src/store.ts test/store.test.ts
git commit -m "feat: make search refs size-bounded and replay-aware"
```

### Task 2: Add replay-backed search retrieval with URL-occurrence remapping

**Files:**
- Modify: `src/read-full.ts`
- Modify: `src/search.ts`
- Modify: `src/store.ts`
- Test: `test/search.test.ts`
- Test: `test/extension.test.ts`

- [ ] **Step 1: Write the failing search replay tests**

```ts
it("replays search refs after cached payload eviction and remaps by original URL occurrence", async () => {
  const fetchImpl = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify({
      results: [
        { title: "A1", url: "https://example.com/a", content: "first a" },
        { title: "B", url: "https://example.com/b", content: "bee" },
        { title: "A2", url: "https://example.com/a", content: "second a" },
      ],
    })))
    .mockResolvedValueOnce(new Response(JSON.stringify({
      results: [{ title: "Evictor", url: "https://example.com/evictor", content: "x".repeat(1_200_000) }],
    })))
    .mockResolvedValueOnce(new Response(JSON.stringify({
      results: [
        { title: "B replay", url: "https://example.com/b", content: "bee replay" },
        { title: "A replay 1", url: "https://example.com/a", content: "first a replay" },
        { title: "A replay 2", url: "https://example.com/a", content: "second a replay" },
      ],
    })));

  vi.stubGlobal("fetch", fetchImpl);
  const fake = createFakePi();
  extension(fake.pi as any);

  const searchTool = fake.tools.find((tool) => tool.name === "ollama_web_search")!;
  const readFullTool = fake.tools.find((tool) => tool.name === "ollama_web_read_full")!;

  const searchResult = await searchTool.execute("search-1", { query: "dupes" }, undefined);
  const ref = searchResult.details.fullContentRef;

  await searchTool.execute("search-evict", { query: "evict" }, undefined);

  const recovered = await readFullTool.execute("read-1", { ref, section: "content", resultIndex: 3 }, undefined);

  expect(recovered).toEqual({
    content: [{ type: "text", text: "second a replay" }],
    details: {
      ref,
      kind: "search",
      section: "content",
      resultIndex: 3,
      servedFrom: "replay",
    },
  });
});

it("fails clearly when search replay succeeds but the original result occurrence is gone", async () => {
  const ref = "ws_s_test";
  const searchStore = createSearchContentStore();
  searchStore.rememberSearchContent({
    ref,
    query: "dupes",
    maxResults: 5,
    payload: {
      results: [
        { title: "A1", url: "https://example.com/a", content: "first a" },
        { title: "A2", url: "https://example.com/a", content: "second a" },
      ],
    },
  });
  searchStore.rememberSearchContent({
    ref: createFullContentRef("search"),
    query: "evict",
    maxResults: 5,
    payload: { results: [{ title: "Evictor", url: "https://example.com/e", content: "x".repeat(1_200_000) }] },
  });

  await expect(runOllamaWebReadFull(
    { ref, section: "content", resultIndex: 2 },
    {
      getStoredSearchContent: searchStore.getStoredSearchContent,
      getStoredSearchReplay: searchStore.getStoredSearchReplay,
      replaySearch: async () => ({
        results: [{ title: "A replay 1", url: "https://example.com/a", content: "first a replay" }],
      }),
      readFullFetchContent: vi.fn(),
      rememberSearchContent: searchStore.rememberSearchContent,
    },
  )).rejects.toThrow(
    "No stored content found for ref ws_s_test. Replay succeeded, but the original search result 2 could not be reconstructed.",
  );
});
```

- [ ] **Step 2: Run the focused search/extension tests to verify they fail**

Run:
```bash
npx vitest run test/search.test.ts test/extension.test.ts
```

Expected: FAIL because search retrieval still errors on cache miss and there is no replay/remapping path.

- [ ] **Step 3: Teach the search path to retain replay metadata in structured details and replay through `runOllamaWebReadFull`**

```ts
export interface SearchRetrievalMetadata {
  kind: "search";
  replay: {
    query: string;
    maxResults: number;
    originalResultUrls: string[];
  };
  results: SearchRetrievalResultMetadata[];
}

const retrieval = buildSearchRetrievalMetadata({
  payload: normalized,
  query: trimmedQuery,
  maxResults: options.config.maxResults,
});
```

```ts
function remapSearchResultIndex(originalUrls: string[], replayed: NormalizedSearchResponse, resultIndex: number): number {
  const targetUrl = originalUrls[resultIndex - 1];
  const targetOccurrence = originalUrls.slice(0, resultIndex).filter((url) => url === targetUrl).length;

  let seen = 0;
  for (const [index, result] of replayed.results.entries()) {
    if (result.url !== targetUrl) continue;
    seen += 1;
    if (seen === targetOccurrence) return index;
  }

  throw new Error(
    `Replay succeeded, but the original search result ${String(resultIndex)} could not be reconstructed.`,
  );
}

const replay = options.getStoredSearchReplay(ref);
if (!stored && replay) {
  const raw = await options.replaySearch({ query: replay.query, maxResults: replay.maxResults, signal: input.signal });
  const rebuilt = normalizeWebSearchResponse(raw);
  options.rememberSearchContent({ ref, query: replay.query, maxResults: replay.maxResults, payload: rebuilt });
  const replayedIndex = remapSearchResultIndex(replay.originalResultUrls, rebuilt, input.resultIndex);
  const selected = rebuilt.results[replayedIndex];
  return {
    mode: "inline",
    text: sliceByOffsetAndMaxChars(selected[section], input.offset ?? 0, input.maxChars),
    details: { ref, kind: "search", section, resultIndex: input.resultIndex, servedFrom: "replay" },
  };
}
```

- [ ] **Step 4: Run the search/extension tests again to verify the replay path passes**

Run:
```bash
npx vitest run test/search.test.ts test/extension.test.ts
```

Expected: PASS, including duplicate-URL remapping and explicit remap-failure messaging.

- [ ] **Step 5: Commit the search replay slice**

```bash
git add src/read-full.ts src/search.ts src/store.ts test/search.test.ts test/extension.test.ts
git commit -m "feat: replay search refs on cache miss"
```

### Task 3: Add replay-backed fetch recovery for inline and file modes

**Files:**
- Modify: `src/retrieval.ts`
- Modify: `src/fetch.ts`
- Modify: `src/read-full.ts`
- Test: `test/retrieval.test.ts`
- Test: `test/fetch.test.ts`
- Test: `test/extension.test.ts`

- [ ] **Step 1: Write the failing fetch replay tests**

```ts
it("replays fetch refs after cache eviction for inline mode", async () => {
  const store = createFetchRetrievalStore({
    replayFetch: async ({ url }) => ({
      title: "Replay title",
      content: "Replay content",
      links: [url],
    }),
  });

  const record = store.registerFetchRetrieval({
    title: "Original title",
    content: "Original content",
    links: ["https://example.com/page"],
  }, {
    url: "https://example.com/page",
  });

  store.registerFetchRetrieval({
    title: "Evictor",
    content: "x".repeat(FETCH_RETRIEVAL_STORE_MAX_BYTES + 10_000),
    links: ["https://example.com/evictor"],
  }, {
    url: "https://example.com/evictor",
  });

  await expect(store.readFullFetchContent({ fullContentRef: record.fullContentRef, section: "content" })).resolves.toMatchObject({
    mode: "inline",
    text: "Replay content",
    details: { servedFrom: "replay" },
  });
});

it("returns a combined cache-miss plus replay-failure error for fetch refs", async () => {
  const store = createFetchRetrievalStore({
    replayFetch: async () => {
      throw new Error("upstream failed");
    },
  });

  const record = store.registerFetchRetrieval({
    title: "Original title",
    content: "Original content",
    links: ["https://example.com/page"],
  }, {
    url: "https://example.com/page",
  });

  store.registerFetchRetrieval({
    title: "Evictor",
    content: "x".repeat(FETCH_RETRIEVAL_STORE_MAX_BYTES + 10_000),
    links: ["https://example.com/evictor"],
  }, {
    url: "https://example.com/evictor",
  });

  await expect(store.readFullFetchContent({ fullContentRef: record.fullContentRef, section: "content" })).rejects.toThrow(
    `No stored full content found for ref: ${record.fullContentRef}. Replay failed: upstream failed`,
  );
});

it("replays fetch refs before writing file exports", async () => {
  const store = createFetchRetrievalStore({
    replayFetch: async () => ({
      title: "Replay title",
      content: "Replay file content",
      links: ["https://example.com/page"],
    }),
  });

  const record = store.registerFetchRetrieval({
    title: "Original title",
    content: "Original content",
    links: ["https://example.com/page"],
  }, {
    url: "https://example.com/page",
  });

  store.registerFetchRetrieval({
    title: "Evictor",
    content: "x".repeat(FETCH_RETRIEVAL_STORE_MAX_BYTES + 10_000),
    links: ["https://example.com/evictor"],
  }, {
    url: "https://example.com/evictor",
  });

  await expect(
    store.readFullFetchContent({ fullContentRef: record.fullContentRef, section: "content", mode: "file", outputPath: "/tmp/replayed.txt" }),
  ).resolves.toMatchObject({
    mode: "file",
    details: {
      servedFrom: "replay",
      outputPath: "/tmp/replayed.txt",
      charsWritten: "Replay file content".length,
    },
  });
});
```

- [ ] **Step 2: Run the focused fetch/retrieval tests to verify they fail**

Run:
```bash
npx vitest run test/retrieval.test.ts test/fetch.test.ts test/extension.test.ts
```

Expected: FAIL because the fetch store does not retain replay input or replay on cache miss.

- [ ] **Step 3: Extend the fetch retrieval store to retain replay input and rebuild cached payloads under the same ref**

```ts
export interface FetchReplayMetadata {
  url: string;
}

interface StoredFetchPayload {
  payload?: NormalizedFetchResponse;
  retainedBytes: number;
  replay: FetchReplayMetadata;
}

export interface FetchRetrievalStoreOptions {
  replayFetch?: (input: { url: string; signal?: AbortSignal }) => Promise<NormalizedFetchResponse>;
}

function registerFetchRetrieval(payload: NormalizedFetchResponse, replay: FetchReplayMetadata): FetchRetrievalRecord {
  const fullContentRef = createOpaqueFetchRef();
  fetchRetrievalStore.set(fullContentRef, {
    payload,
    retainedBytes: measureRetainedBytes(payload),
    replay,
  });
  enforceFetchStoreLimit(fullContentRef);
  return buildFetchRetrievalRecord(payload, fullContentRef, replay);
}

async function requireRefPayload(fullContentRef: string, signal?: AbortSignal): Promise<{ payload: NormalizedFetchResponse; servedFrom: "cache" | "replay" }> {
  const stored = fetchRetrievalStore.get(trimmedRef);
  if (stored?.payload) {
    return { payload: stored.payload, servedFrom: "cache" };
  }
  if (!stored?.replay || !replayFetch) {
    throw new Error(`No stored full content found for ref: ${trimmedRef}`);
  }

  try {
    const rebuilt = await replayFetch({ url: stored.replay.url, signal });
    fetchRetrievalStore.set(trimmedRef, { ...stored, payload: rebuilt, retainedBytes: measureRetainedBytes(rebuilt) });
    enforceFetchStoreLimit(trimmedRef);
    return { payload: rebuilt, servedFrom: "replay" };
  } catch (error) {
    throw new Error(`No stored full content found for ref: ${trimmedRef}. Replay failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
```

- [ ] **Step 4: Run the fetch/retrieval tests again to verify inline and file-mode replay pass**

Run:
```bash
npx vitest run test/retrieval.test.ts test/fetch.test.ts test/extension.test.ts
```

Expected: PASS, with stable fetch refs serving replayed content in inline and file modes and preserving explicit/temp export semantics.

- [ ] **Step 5: Commit the fetch replay slice**

```bash
git add src/retrieval.ts src/fetch.ts src/read-full.ts test/retrieval.test.ts test/fetch.test.ts test/extension.test.ts
git commit -m "feat: replay fetch refs on cache miss"
```

### Task 4: Document best-effort replay semantics and run full verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Write the failing documentation expectation by identifying the missing replay contract**

```md
- Retrieval refs are best-effort stable handles.
- If cached payloads are evicted, `ollama_web_read_full` may transparently replay the original search or fetch request.
- Replay re-runs normalization and can return changed web content.
- Replay can still fail if the upstream call fails or the original search result can no longer be reconstructed.
```

- [ ] **Step 2: Verify the current README does not yet describe replay-backed recovery**

Run:
```bash
grep -n "best-effort\|replay" README.md
```

Expected: no lines describing ref replay semantics, or wording that is incomplete for issue #7.

- [ ] **Step 3: Update the README retrieval sections and troubleshooting wording**

```md
- `ollama_web_read_full` refs are stable best-effort handles rather than immutable snapshots.
- When cached payloads are unavailable, the extension may replay the original search or fetch request behind the same ref.
- Search replay remaps requested results by original URL occurrence, so duplicate URLs stay deterministic.
- If replay fails, or the original search result can no longer be reconstructed, `ollama_web_read_full` returns a clear error.
```

- [ ] **Step 4: Run full project verification**

Run:
```bash
npm run typecheck
npm test
```

Expected: PASS for typecheck and the full Vitest suite.

- [ ] **Step 5: Commit the docs + verification slice**

```bash
git add README.md
git commit -m "docs: describe replay-backed ref recovery"
```

## Self-Review Checklist

- Search store work covers stable refs, size-based eviction, and newest-oversized-entry retention.
- Search replay work covers normalization, URL-occurrence remapping, duplicate handling, and explicit remap failures.
- Fetch replay work covers inline and file-mode recovery, stable ref reuse, and explicit cache-miss plus replay-failure errors.
- README work covers best-effort replay semantics and failure expectations.
- Final verification includes `npm run typecheck` and `npm test`.
