import { describe, expect, it } from "vitest";
import { SEARCH_CONTENT_STORE_MAX_BYTES, createFullContentRef, createSearchContentStore } from "../src/store.js";

describe("full content store", () => {
  it("evicts cached payloads by retained bytes but preserves replay metadata for the same ref", () => {
    const store = createSearchContentStore();
    const firstRef = createFullContentRef("search");
    const secondRef = createFullContentRef("search");

    store.rememberSearchContent({
      ref: firstRef,
      query: "first query",
      maxResults: 5,
      payload: {
        results: [{ title: "first", url: "https://example.com/first", content: "a".repeat(900_000) }],
      },
    });

    store.rememberSearchContent({
      ref: secondRef,
      query: "second query",
      maxResults: 5,
      payload: {
        results: [{ title: "second", url: "https://example.com/second", content: "b".repeat(900_000) }],
      },
    });

    expect(store.getStoredSearchContent(firstRef)).toBeUndefined();
    expect(store.getStoredSearchReplay(firstRef)).toMatchObject({
      ref: firstRef,
      query: "first query",
      maxResults: 5,
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
      payload: {
        results: [{ title: "old", url: "https://example.com/old", content: "payload" }],
      },
    });

    store.rememberSearchContent({
      ref: oversizedRef,
      query: "oversized",
      maxResults: 5,
      payload: {
        results: [
          {
            title: "new",
            url: "https://example.com/new",
            content: "x".repeat(SEARCH_CONTENT_STORE_MAX_BYTES + 10_000),
          },
        ],
      },
    });

    expect(store.getStoredSearchContent(oldRef)).toBeUndefined();
    expect(store.getStoredSearchContent(oversizedRef)).toBeDefined();
    expect(store.getStoredSearchReplay(oversizedRef)).toMatchObject({
      ref: oversizedRef,
      query: "oversized",
      maxResults: 5,
      originalResultUrls: ["https://example.com/new"],
    });
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
