import { describe, expect, it, vi } from "vitest";
import { runOllamaWebReadFull } from "../src/read-full.js";
import { createFullContentRef, createSearchContentStore } from "../src/store.js";

describe("runOllamaWebReadFull", () => {
  it("rejects invalid section values explicitly for search refs", async () => {
    const searchContentStore = createSearchContentStore();
    const ref = createFullContentRef("search");
    searchContentStore.rememberSearchContent({
      ref,
      query: "test query",
      maxResults: 5,
      payload: {
        results: [{ title: "One", url: "https://example.com/one", content: "First content" }],
      },
    });

    await expect(
      runOllamaWebReadFull(
        { ref, section: "summary" as any, resultIndex: 1 },
        {
          readFullFetchContent: vi.fn(async () => ({
            mode: "inline" as const,
            text: "",
            details: {
              mode: "inline" as const,
              target: "fetch" as const,
              section: "content" as const,
              fullContentRef: "fetch:test",
              offset: 0,
              totalChars: 0,
              returnedChars: 0,
            },
          })),
          getStoredSearchContent: searchContentStore.getStoredSearchContent,
        },
      ),
    ).rejects.toThrow("section must be one of: title, url, content.");
  });
});
