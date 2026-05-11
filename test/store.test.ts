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
    const store = createSearchContentStore({ maxRetainedBytes: 220 });
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

    const replaySearch = vi.fn().mockResolvedValue({
      results: [
        {
          title: "replayed title",
          url: "https://example.com/original",
          content: "replayed content",
        },
      ],
    });

    const result = await store.readSearchContent(
      { ref, resultIndex: 1, section: "content" },
      { replaySearch },
    );

    expect(replaySearch).toHaveBeenCalledWith({ query: "replay me", maxResults: 3, signal: undefined });
    expect(result.text).toBe("replayed content");
    expect(result.details.ref).toBe(ref);
    expect(result.details.servedFrom).toBe("replay");
    expect(store.getStoredSearchContent(ref)?.payload.results[0]?.content).toBe("replayed content");
  });

  it("remaps duplicate URLs by occurrence order on replay", async () => {
    const store = createSearchContentStore({ maxRetainedBytes: 1024 });
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

    store.clearSearchPayloadCache();

    const replaySearch = vi.fn().mockResolvedValue({
      results: [
        { title: "replay-a1", url: "https://example.com/a", content: "replay-a1" },
        { title: "replay-a2", url: "https://example.com/a", content: "replay-a2" },
        { title: "replay-b1", url: "https://example.com/b", content: "replay-b1" },
      ],
    });

    const replayed = await store.readSearchContent(
      { ref, resultIndex: 3, section: "content" },
      { replaySearch },
    );

    const cached = await store.readSearchContent(
      { ref, resultIndex: 3, section: "content" },
      { replaySearch },
    );

    expect(replayed.text).toBe("replay-a2");
    expect(replayed.details.servedFrom).toBe("replay");

    expect(cached.text).toBe("replay-a2");
    expect(cached.details.servedFrom).toBe("cache");
    expect(replaySearch).toHaveBeenCalledTimes(1);
  });

  it("returns combined cache-miss and replay-failure errors", async () => {
    const store = createSearchContentStore({ maxRetainedBytes: 256 });
    const ref = createFullContentRef("search");

    store.rememberSearchContent({
      ref,
      query: "replay fails",
      maxResults: 2,
      payload: createPayload("failure"),
    });

    store.clearSearchPayloadCache();

    const replaySearch = vi.fn().mockRejectedValue(new Error("upstream unavailable"));

    await expect(
      store.readSearchContent(
        { ref, resultIndex: 1, section: "content" },
        { replaySearch },
      ),
    ).rejects.toThrow(`No stored content found for ref ${ref}. Replay also failed: upstream unavailable`);
  });

  it("returns requested replayed result when another original result is missing", async () => {
    const store = createSearchContentStore({ maxRetainedBytes: 220 });
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

    const replaySearch = vi.fn().mockResolvedValue({
      results: [
        { title: "replay-a1", url: "https://example.com/a", content: "replay-a1" },
        { title: "replay-a2", url: "https://example.com/a", content: "replay-a2" },
      ],
    });

    const replayed = await store.readSearchContent(
      { ref, resultIndex: 3, section: "content" },
      { replaySearch },
    );

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

  it("returns combined cache-miss and replay-failure errors when replay cannot reconstruct URL occurrences", async () => {
    const store = createSearchContentStore({ maxRetainedBytes: 220 });
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

    const replaySearch = vi.fn().mockResolvedValue({
      results: [
        { title: "replay-a1", url: "https://example.com/a", content: "replay-a1" },
        { title: "replay-b1", url: "https://example.com/b", content: "replay-b1" },
      ],
    });

    await expect(
      store.readSearchContent(
        { ref, resultIndex: 3, section: "content" },
        { replaySearch },
      ),
    ).rejects.toThrow(
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
