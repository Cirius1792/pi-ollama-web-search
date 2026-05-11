import { describe, expect, it, vi } from "vitest";
import { createFullContentRef, createSearchContentStore } from "../src/store.js";

function createPayload(marker: string, content = `content-${marker}`) {
  return {
    results: [
      {
        title: `title-${marker}`,
        url: `https://example.com/${marker}`,
        content,
      },
    ],
  };
}

describe("search content store", () => {
  it("evicts by byte size and still replays from stable ref metadata", async () => {
    const replaySearch = vi.fn().mockResolvedValue({
      results: [
        {
          title: "replayed title",
          url: "https://example.com/original",
          content: "replayed content",
        },
      ],
    });
    const store = createSearchContentStore({ maxRetainedBytes: 220, replaySearch });
    const ref = createFullContentRef("search");

    store.rememberSearchContent({
      ref,
      query: "replay me",
      maxResults: 3,
      payload: {
        results: [
          {
            title: "title-original",
            url: "https://example.com/original",
            content: "x".repeat(160),
          },
        ],
      },
    });

    const secondRef = createFullContentRef("search");
    store.rememberSearchContent({
      ref: secondRef,
      query: "newer result",
      maxResults: 1,
      payload: {
        results: [
          {
            title: "title-newer",
            url: "https://example.com/newer",
            content: "y".repeat(160),
          },
        ],
      },
    });

    expect(store.getStoredSearchContent(ref)).toBeUndefined();
    expect(store.getStoredSearchContent(secondRef)?.payload.results[0]?.url).toBe("https://example.com/newer");

    const result = await store.readSearchContent({ ref, resultIndex: 1, section: "content" });

    expect(replaySearch).toHaveBeenCalledWith({ query: "replay me", maxResults: 3, signal: undefined });
    expect(result.text).toBe("replayed content");
    expect(result.details.ref).toBe(ref);
    expect(result.details.servedFrom).toBe("replay");
    expect(store.getStoredSearchContent(ref)?.payload.results[0]?.content).toBe("replayed content");
  });

  it("remaps duplicate URLs by occurrence order on replay", async () => {
    const replaySearch = vi.fn().mockResolvedValue({
      results: [
        { title: "replay-a1", url: "https://example.com/a", content: "replay-a1" },
        { title: "replay-a2", url: "https://example.com/a", content: "replay-a2" },
        { title: "replay-b1", url: "https://example.com/b", content: "replay-b1" },
      ],
    });
    const store = createSearchContentStore({ maxRetainedBytes: 1024, replaySearch });
    const ref = createFullContentRef("search");

    store.rememberSearchContent({
      ref,
      query: "duplicate urls",
      maxResults: 5,
      payload: {
        results: [
          { title: "original-a1", url: "https://example.com/a", content: "original-a1" },
          { title: "original-b1", url: "https://example.com/b", content: "original-b1" },
          { title: "original-a2", url: "https://example.com/a", content: "original-a2" },
        ],
      },
    });

    store.clearCachedSearchPayloads();

    const replayed = await store.readSearchContent({ ref, resultIndex: 3, section: "content" });

    const cached = await store.readSearchContent({ ref, resultIndex: 3, section: "content" });

    expect(replayed.text).toBe("replay-a2");
    expect(replayed.details.servedFrom).toBe("replay");

    expect(cached.text).toBe("replay-a2");
    expect(cached.details.servedFrom).toBe("cache");
    expect(replaySearch).toHaveBeenCalledTimes(1);
  });

  it("returns combined cache-miss and replay-failure errors", async () => {
    const replaySearch = vi.fn().mockRejectedValue(new Error("upstream unavailable"));
    const store = createSearchContentStore({ maxRetainedBytes: 256, replaySearch });
    const ref = createFullContentRef("search");

    store.rememberSearchContent({
      ref,
      query: "replay fails",
      maxResults: 2,
      payload: createPayload("failure"),
    });

    store.clearCachedSearchPayloads();

    await expect(store.readSearchContent({ ref, resultIndex: 1, section: "content" })).rejects.toThrow(
      `No stored content found for ref ${ref}. Replay also failed: upstream unavailable`,
    );
  });

  it("rethrows replay AbortError unchanged", async () => {
    const abortError = new Error("The operation was aborted.");
    abortError.name = "AbortError";
    const replaySearch = vi.fn().mockRejectedValue(abortError);
    const store = createSearchContentStore({ maxRetainedBytes: 256, replaySearch });
    const ref = createFullContentRef("search");

    store.rememberSearchContent({
      ref,
      query: "replay aborts",
      maxResults: 2,
      payload: createPayload("abort"),
    });

    store.clearCachedSearchPayloads();

    await expect(store.readSearchContent({ ref, resultIndex: 1, section: "content" })).rejects.toBe(abortError);
  });

  it("surfaces a replay-not-configured error when cache is empty", async () => {
    const store = createSearchContentStore({ maxRetainedBytes: 256 });
    const ref = createFullContentRef("search");

    store.rememberSearchContent({
      ref,
      query: "replay unavailable",
      maxResults: 1,
      payload: createPayload("missing-replay"),
    });

    store.clearCachedSearchPayloads();

    await expect(store.readSearchContent({ ref, resultIndex: 1, section: "content" })).rejects.toThrow(
      `No stored content found for ref ${ref}. Replay also failed: Search replay is not configured.`,
    );
  });

  it("returns requested replayed result when another original result is missing", async () => {
    const replaySearch = vi.fn().mockResolvedValue({
      results: [
        { title: "replay-a1", url: "https://example.com/a", content: "replay-a1" },
        { title: "replay-a2", url: "https://example.com/a", content: "replay-a2" },
      ],
    });
    const store = createSearchContentStore({ maxRetainedBytes: 220, replaySearch });
    const ref = createFullContentRef("search");

    store.rememberSearchContent({
      ref,
      query: "duplicate urls",
      maxResults: 5,
      payload: {
        results: [
          { title: "original-a1", url: "https://example.com/a", content: "original-a1" },
          { title: "original-b1", url: "https://example.com/b", content: "original-b1" },
          { title: "original-a2", url: "https://example.com/a", content: "original-a2" },
        ],
      },
    });

    const secondRef = createFullContentRef("search");
    store.rememberSearchContent({
      ref: secondRef,
      query: "newer result",
      maxResults: 1,
      payload: {
        results: [
          {
            title: "title-newer",
            url: "https://example.com/newer",
            content: "y".repeat(160),
          },
        ],
      },
    });

    expect(store.getStoredSearchContent(ref)).toBeUndefined();

    const replayed = await store.readSearchContent({ ref, resultIndex: 3, section: "content" });

    expect(replayed.text).toBe("replay-a2");
    expect(replayed.details.servedFrom).toBe("replay");
  });

  it("refreshes payload recency on cache hits before eviction", () => {
    const payloadOne = createPayload("one", "x".repeat(120));
    const payloadTwo = createPayload("two", "y".repeat(120));
    const payloadThree = createPayload("three", "z".repeat(120));

    const payloadBytes = Buffer.byteLength(JSON.stringify(payloadOne), "utf8");
    const store = createSearchContentStore({ maxRetainedBytes: payloadBytes * 2 + 10 });

    const firstRef = createFullContentRef("search");
    const secondRef = createFullContentRef("search");
    const thirdRef = createFullContentRef("search");

    store.rememberSearchContent({ ref: firstRef, query: "one", maxResults: 1, payload: payloadOne });
    store.rememberSearchContent({ ref: secondRef, query: "two", maxResults: 1, payload: payloadTwo });

    expect(store.getStoredSearchContent(firstRef)?.payload.results[0]?.url).toBe("https://example.com/one");

    store.rememberSearchContent({ ref: thirdRef, query: "three", maxResults: 1, payload: payloadThree });

    expect(store.getStoredSearchContent(firstRef)?.payload.results[0]?.url).toBe("https://example.com/one");
    expect(store.getStoredSearchContent(secondRef)).toBeUndefined();
    expect(store.getStoredSearchContent(thirdRef)?.payload.results[0]?.url).toBe("https://example.com/three");
  });

  it("returns combined cache-miss envelope when replay remap/cache work fails", async () => {
    const replaySearch = vi.fn().mockResolvedValue((() => {
      const circular: Record<string, unknown> = {
        title: "replay-a1",
        url: "https://example.com/a",
        content: "replay-a1",
      };
      circular.self = circular;

      return {
        results: [
          circular,
          { title: "replay-b1", url: "https://example.com/b", content: "replay-b1" },
          { title: "replay-a2", url: "https://example.com/a", content: "replay-a2" },
        ],
      };
    })());
    const store = createSearchContentStore({ maxRetainedBytes: 220, replaySearch });
    const ref = createFullContentRef("search");

    store.rememberSearchContent({
      ref,
      query: "duplicate urls",
      maxResults: 5,
      payload: {
        results: [
          { title: "original-a1", url: "https://example.com/a", content: "original-a1" },
          { title: "original-b1", url: "https://example.com/b", content: "original-b1" },
          { title: "original-a2", url: "https://example.com/a", content: "original-a2" },
        ],
      },
    });

    const secondRef = createFullContentRef("search");
    store.rememberSearchContent({
      ref: secondRef,
      query: "newer result",
      maxResults: 1,
      payload: {
        results: [
          {
            title: "title-newer",
            url: "https://example.com/newer",
            content: "y".repeat(160),
          },
        ],
      },
    });

    await expect(store.readSearchContent({ ref, resultIndex: 3, section: "content" })).rejects.toThrow(
      `No stored content found for ref ${ref}. Replay also failed:`,
    );

    await expect(store.readSearchContent({ ref, resultIndex: 3, section: "content" })).rejects.toThrow(/circular structure/i);
  });

  it("validates resultIndex range in readSearchContent", async () => {
    const replaySearch = vi.fn();
    const store = createSearchContentStore({ maxRetainedBytes: 256, replaySearch });
    const ref = createFullContentRef("search");

    store.rememberSearchContent({
      ref,
      query: "range-check",
      maxResults: 1,
      payload: createPayload("range"),
    });

    await expect(store.readSearchContent({ ref, resultIndex: 0, section: "content" })).rejects.toThrow(
      "Search result index 0 is out of range. Valid range is 1-1.",
    );

    await expect(store.readSearchContent({ ref, resultIndex: 2, section: "content" })).rejects.toThrow(
      "Search result index 2 is out of range. Valid range is 1-1.",
    );

    expect(replaySearch).not.toHaveBeenCalled();
  });

  it("validates offset and maxChars in readSearchContent", async () => {
    const replaySearch = vi.fn();
    const store = createSearchContentStore({ maxRetainedBytes: 256, replaySearch });
    const ref = createFullContentRef("search");

    store.rememberSearchContent({
      ref,
      query: "slice-params",
      maxResults: 1,
      payload: createPayload("slice"),
    });

    await expect(store.readSearchContent({ ref, resultIndex: 1, section: "content", offset: -1 })).rejects.toThrow(
      "Offset must be an integer greater than or equal to 0.",
    );

    await expect(store.readSearchContent({ ref, resultIndex: 1, section: "content", maxChars: 0 })).rejects.toThrow(
      "maxChars must be an integer greater than or equal to 1.",
    );

    expect(replaySearch).not.toHaveBeenCalled();
  });

  it("supports slicing for cached reads", async () => {
    const replaySearch = vi.fn();
    const store = createSearchContentStore({ maxRetainedBytes: 256, replaySearch });
    const ref = createFullContentRef("search");

    store.rememberSearchContent({
      ref,
      query: "cached slicing",
      maxResults: 1,
      payload: createPayload("cached", "0123456789"),
    });

    const result = await store.readSearchContent({ ref, resultIndex: 1, section: "content", offset: 2, maxChars: 4 });

    expect(result.text).toBe("2345");
    expect(result.details.servedFrom).toBe("cache");
    expect(replaySearch).not.toHaveBeenCalled();
  });

  it("supports slicing for replayed reads", async () => {
    const replaySearch = vi.fn().mockResolvedValue({
      results: [
        {
          title: "title-replay",
          url: "https://example.com/replay",
          content: "abcdefghij",
        },
      ],
    });
    const store = createSearchContentStore({ maxRetainedBytes: 32, replaySearch });
    const ref = createFullContentRef("search");

    store.rememberSearchContent({
      ref,
      query: "replay slicing",
      maxResults: 1,
      payload: createPayload("replay", "pre-evict"),
    });

    const secondRef = createFullContentRef("search");
    store.rememberSearchContent({
      ref: secondRef,
      query: "evict",
      maxResults: 1,
      payload: createPayload("evict", "x".repeat(200)),
    });

    expect(store.getStoredSearchContent(ref)).toBeUndefined();

    const result = await store.readSearchContent({ ref, resultIndex: 1, section: "content", offset: 3, maxChars: 3 });

    expect(result.text).toBe("def");
    expect(result.details.servedFrom).toBe("replay");
  });

  it("returns combined cache-miss and replay-failure errors when replay cannot reconstruct URL occurrences", async () => {
    const replaySearch = vi.fn().mockResolvedValue({
      results: [
        { title: "replay-a1", url: "https://example.com/a", content: "replay-a1" },
        { title: "replay-b1", url: "https://example.com/b", content: "replay-b1" },
      ],
    });
    const store = createSearchContentStore({ maxRetainedBytes: 220, replaySearch });
    const ref = createFullContentRef("search");

    store.rememberSearchContent({
      ref,
      query: "duplicate urls",
      maxResults: 5,
      payload: {
        results: [
          { title: "original-a1", url: "https://example.com/a", content: "original-a1" },
          { title: "original-b1", url: "https://example.com/b", content: "original-b1" },
          { title: "original-a2", url: "https://example.com/a", content: "original-a2" },
        ],
      },
    });

    const secondRef = createFullContentRef("search");
    store.rememberSearchContent({
      ref: secondRef,
      query: "newer result",
      maxResults: 1,
      payload: {
        results: [
          {
            title: "title-newer",
            url: "https://example.com/newer",
            content: "y".repeat(160),
          },
        ],
      },
    });

    expect(store.getStoredSearchContent(ref)).toBeUndefined();

    await expect(store.readSearchContent({ ref, resultIndex: 3, section: "content" })).rejects.toThrow(
      new RegExp(
        `^No stored content found for ref ${ref}\\. Replay also failed: Unable to reconstruct original result 3 for URL https://example\\.com/a \\(occurrence 2\\) during replay\\.$`,
      ),
    );
  });

  it("generates opaque refs instead of short sequential IDs", () => {
    const firstRef = createFullContentRef("search");
    const secondRef = createFullContentRef("search");

    expect(firstRef).toMatch(/^ws_s_/);
    expect(secondRef).toMatch(/^ws_s_/);
    expect(firstRef).not.toBe(secondRef);

    const firstToken = firstRef.replace(/^ws_s_/, "");
    const secondToken = secondRef.replace(/^ws_s_/, "");

    expect(firstToken.length).toBeGreaterThanOrEqual(16);
    expect(secondToken.length).toBeGreaterThanOrEqual(16);
  });
});
