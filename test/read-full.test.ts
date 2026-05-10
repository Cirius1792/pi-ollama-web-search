import { afterEach, describe, expect, it, vi } from "vitest";
import { runOllamaWebReadFull } from "../src/read-full.js";
import { clearFullContentStore, createFullContentRef, rememberSearchContent } from "../src/store.js";

describe("runOllamaWebReadFull", () => {
  afterEach(() => {
    clearFullContentStore();
  });

  it("rejects invalid section values explicitly for search refs", async () => {
    const ref = createFullContentRef("search");
    rememberSearchContent({
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
        { readFullFetchContent: vi.fn(async () => ({ mode: "inline", text: "", details: {} as any })) },
      ),
    ).rejects.toThrow("section must be one of: title, url, content.");
  });
});
