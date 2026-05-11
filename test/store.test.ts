import { describe, expect, it, vi } from "vitest";
import { createFullContentRef, createSearchContentStore } from "../src/store.js";

function createPayload(marker: string) {
  return {
    results: [
      {
        title: `title-${marker}`,
        url: `https://example.com/${marker}`,
        content: `content-${marker}`,
      },
    ],
  };
}

describe("search content store", () => {
  it("replays using stable ref metadata after cached payload eviction", async () => {
    const store = createSearchContentStore({ maxRetainedBytes: 128 });
    const ref = createFullContentRef("search");

    store.rememberSearchContent({
      ref,
      query: "replay me",
      maxResults: 3,
      payload: createPayload("original"),
    });

    store.clearSearchPayloadCache();

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
