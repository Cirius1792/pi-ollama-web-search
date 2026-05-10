import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearFullContentStore, createFullContentRef, getStoredFullContent, rememberSearchContent } from "../src/store.js";

function rememberSearchEntry(ref: string, marker: string): void {
  rememberSearchContent({
    ref,
    query: `query-${marker}`,
    maxResults: 5,
    payload: {
      results: [{ title: `title-${marker}`, url: `https://example.com/${marker}`, content: `content-${marker}` }],
    },
  });
}

describe("full content store", () => {
  beforeEach(() => {
    clearFullContentStore();
  });

  afterEach(() => {
    clearFullContentStore();
    vi.useRealTimers();
  });

  it("evicts older entries once the in-memory budget is exceeded", () => {
    const refs: string[] = [];

    for (let i = 0; i < 300; i += 1) {
      const ref = createFullContentRef("search");
      refs.push(ref);
      rememberSearchEntry(ref, String(i));
    }

    expect(getStoredFullContent(refs[0])).toBeUndefined();
    expect(getStoredFullContent(refs.at(-1)!)).toBeDefined();
  });

  it("expires old entries after a TTL", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const ref = createFullContentRef("search");
    rememberSearchEntry(ref, "ttl");

    vi.advanceTimersByTime(24 * 60 * 60 * 1000);

    expect(getStoredFullContent(ref)).toBeUndefined();
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
