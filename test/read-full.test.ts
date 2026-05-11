import { describe, expect, it, vi } from "vitest";
import { runOllamaWebReadFull } from "../src/read-full.js";
import { createFullContentRef } from "../src/store.js";

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

function createReadSearchContentStub(servedFrom: "cache" | "replay" = "cache") {
  return vi.fn(async () => ({
    text: "search content",
    details: {
      ref: "ws_s_test",
      kind: "search" as const,
      section: "content" as const,
      resultIndex: 1,
      servedFrom,
    },
  }));
}

describe("runOllamaWebReadFull", () => {
  it("rejects invalid section values explicitly for search refs", async () => {
    await expect(
      runOllamaWebReadFull(
        { ref: "ws_s_test", section: "summary" as any, resultIndex: 1 },
        {
          readFullFetchContent: createReadFullFetchStub(),
          readSearchContent: createReadSearchContentStub(),
        },
      ),
    ).rejects.toThrow("section must be one of: title, url, content.");
  });

  it("returns search details servedFrom from readSearchContent", async () => {
    const readSearchContent = createReadSearchContentStub("replay");

    const result = await runOllamaWebReadFull(
      { ref: "ws_s_test", section: "content", resultIndex: 1, offset: 2, maxChars: 5 },
      {
        readFullFetchContent: createReadFullFetchStub(),
        readSearchContent,
      },
    );

    expect(result).toEqual({
      mode: "inline",
      text: "search content",
      details: {
        ref: "ws_s_test",
        kind: "search",
        section: "content",
        resultIndex: 1,
        servedFrom: "replay",
      },
    });

    expect(readSearchContent).toHaveBeenCalledWith({
      ref: "ws_s_test",
      section: "content",
      resultIndex: 1,
      offset: 2,
      maxChars: 5,
      signal: undefined,
    });
  });

  it("uses path as the canonical file export parameter for fetch refs", async () => {
    const readFullFetchContent = createReadFullFetchStub();

    await runOllamaWebReadFull(
      { ref: "fetch:test", section: "content", mode: "file", path: "@exports/content.txt" },
      {
        readFullFetchContent,
        readSearchContent: createReadSearchContentStub(),
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
    const readFullFetchContent = createReadFullFetchStub();

    await runOllamaWebReadFull(
      { ref: "fetch:test", section: "content", mode: "file", outputPath: "@exports/content.txt" },
      {
        readFullFetchContent,
        readSearchContent: createReadSearchContentStub(),
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
    await expect(
      runOllamaWebReadFull(
        { ref: "fetch:test", section: "content", resultIndex: 1 },
        {
          readFullFetchContent: createReadFullFetchStub(),
          readSearchContent: createReadSearchContentStub(),
        },
      ),
    ).rejects.toThrow("resultIndex is not supported for fetch refs.");
  });

  it("rejects path/overwrite for fetch refs unless mode=file", async () => {
    await expect(
      runOllamaWebReadFull(
        { ref: "fetch:test", section: "content", path: "@exports/content.txt" },
        {
          readFullFetchContent: createReadFullFetchStub(),
          readSearchContent: createReadSearchContentStub(),
        },
      ),
    ).rejects.toThrow("path/outputPath and overwrite are only supported for fetch refs when mode=file.");

    await expect(
      runOllamaWebReadFull(
        { ref: "fetch:test", section: "content", overwrite: true },
        {
          readFullFetchContent: createReadFullFetchStub(),
          readSearchContent: createReadSearchContentStub(),
        },
      ),
    ).rejects.toThrow("path/outputPath and overwrite are only supported for fetch refs when mode=file.");
  });

  it("rejects path/overwrite for search refs", async () => {
    const ref = createFullContentRef("search");

    await expect(
      runOllamaWebReadFull(
        { ref, section: "content", resultIndex: 1, path: "@exports/content.txt" },
        {
          readFullFetchContent: createReadFullFetchStub(),
          readSearchContent: createReadSearchContentStub(),
        },
      ),
    ).rejects.toThrow("path/outputPath and overwrite are only supported for fetch refs when mode=file.");
  });

  it("rejects conflicting path and outputPath values", async () => {
    await expect(
      runOllamaWebReadFull(
        { ref: "fetch:test", section: "content", mode: "file", path: "a.txt", outputPath: "b.txt" },
        {
          readFullFetchContent: createReadFullFetchStub(),
          readSearchContent: createReadSearchContentStub(),
        },
      ),
    ).rejects.toThrow("path and outputPath must match when both are provided.");
  });
});
