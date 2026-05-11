import { describe, expect, it, vi } from "vitest";
import { runOllamaWebReadFull } from "../src/read-full.js";
import { createFullContentRef, createSearchContentStore } from "../src/store.js";

function createReadFullFetchStub() {
  return vi.fn(async () => ({
    mode: "inline" as const,
    text: "fetch content",
    details: {
      mode: "inline" as const,
      target: "fetch" as const,
      section: "content" as const,
      fullContentRef: "fetch:test",
      servedFrom: "cache" as const,
      offset: 0,
      totalChars: 12,
      returnedChars: 12,
    },
  }));
}

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
          readFullFetchContent: createReadFullFetchStub(),
          getStoredSearchContent: searchContentStore.getStoredSearchContent,
        },
      ),
    ).rejects.toThrow("section must be one of: title, url, content.");
  });

  it("uses path as the canonical file export parameter for fetch refs", async () => {
    const searchContentStore = createSearchContentStore();
    const readFullFetchContent = createReadFullFetchStub();

    await runOllamaWebReadFull(
      { ref: "fetch:test", section: "content", mode: "file", path: "@exports/content.txt" },
      {
        readFullFetchContent,
        getStoredSearchContent: searchContentStore.getStoredSearchContent,
      },
    );

    expect(readFullFetchContent).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "file",
        outputPath: "@exports/content.txt",
      }),
    );
  });

  it("supports outputPath as a backward-compatible alias", async () => {
    const searchContentStore = createSearchContentStore();
    const readFullFetchContent = createReadFullFetchStub();

    await runOllamaWebReadFull(
      { ref: "fetch:test", section: "content", mode: "file", outputPath: "@exports/content.txt" },
      {
        readFullFetchContent,
        getStoredSearchContent: searchContentStore.getStoredSearchContent,
      },
    );

    expect(readFullFetchContent).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "file",
        outputPath: "@exports/content.txt",
      }),
    );
  });

  it("rejects fetch refs when resultIndex is provided", async () => {
    const searchContentStore = createSearchContentStore();

    await expect(
      runOllamaWebReadFull(
        { ref: "fetch:test", section: "content", resultIndex: 1 },
        {
          readFullFetchContent: createReadFullFetchStub(),
          getStoredSearchContent: searchContentStore.getStoredSearchContent,
        },
      ),
    ).rejects.toThrow("resultIndex is not supported for fetch refs.");
  });

  it("rejects path/overwrite for fetch refs unless mode=file", async () => {
    const searchContentStore = createSearchContentStore();

    await expect(
      runOllamaWebReadFull(
        { ref: "fetch:test", section: "content", path: "@exports/content.txt" },
        {
          readFullFetchContent: createReadFullFetchStub(),
          getStoredSearchContent: searchContentStore.getStoredSearchContent,
        },
      ),
    ).rejects.toThrow("path/outputPath and overwrite are only supported for fetch refs when mode=file.");

    await expect(
      runOllamaWebReadFull(
        { ref: "fetch:test", section: "content", overwrite: true },
        {
          readFullFetchContent: createReadFullFetchStub(),
          getStoredSearchContent: searchContentStore.getStoredSearchContent,
        },
      ),
    ).rejects.toThrow("path/outputPath and overwrite are only supported for fetch refs when mode=file.");
  });

  it("rejects path/overwrite for search refs", async () => {
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
        { ref, section: "content", resultIndex: 1, path: "@exports/content.txt" },
        {
          readFullFetchContent: createReadFullFetchStub(),
          getStoredSearchContent: searchContentStore.getStoredSearchContent,
        },
      ),
    ).rejects.toThrow("path/outputPath and overwrite are only supported for fetch refs when mode=file.");
  });

  it("rejects conflicting path and outputPath values", async () => {
    const searchContentStore = createSearchContentStore();

    await expect(
      runOllamaWebReadFull(
        { ref: "fetch:test", section: "content", mode: "file", path: "a.txt", outputPath: "b.txt" },
        {
          readFullFetchContent: createReadFullFetchStub(),
          getStoredSearchContent: searchContentStore.getStoredSearchContent,
        },
      ),
    ).rejects.toThrow("path and outputPath must match when both are provided.");
  });
});
