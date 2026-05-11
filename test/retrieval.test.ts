import { beforeEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { accessMock, mkdirMock, rmMock, writeFileMock } = vi.hoisted(() => ({
  accessMock: vi.fn<(...args: unknown[]) => Promise<void>>(async (..._args: unknown[]) => {}),
  mkdirMock: vi.fn<(...args: unknown[]) => Promise<void>>(async (..._args: unknown[]) => {}),
  rmMock: vi.fn<(...args: unknown[]) => Promise<void>>(async (..._args: unknown[]) => {}),
  writeFileMock: vi.fn<(...args: unknown[]) => Promise<void>>(async (..._args: unknown[]) => {}),
}));

vi.mock("node:fs/promises", () => ({
  access: accessMock,
  mkdir: mkdirMock,
  rm: rmMock,
  writeFile: writeFileMock,
}));

import {
  FETCH_RETRIEVAL_STORE_MAX_BYTES,
  FETCH_RETRIEVAL_STORE_MAX_ENTRIES,
  clearFetchRetrievalStore,
  createFetchRetrievalStore,
  readFullFetchContent,
  registerFetchRetrieval,
} from "../src/retrieval.js";

beforeEach(() => {
  clearFetchRetrievalStore();
  accessMock.mockReset();
  mkdirMock.mockReset();
  rmMock.mockReset();
  writeFileMock.mockReset();
  accessMock.mockImplementation(async () => {
    const error = new Error("ENOENT") as NodeJS.ErrnoException;
    error.code = "ENOENT";
    throw error;
  });
  mkdirMock.mockImplementation(async (..._args: unknown[]) => {});
  rmMock.mockImplementation(async (..._args: unknown[]) => {});
  writeFileMock.mockImplementation(async (..._args: unknown[]) => {});
});

describe("readFullFetchContent abort handling", () => {
  it("throws AbortError before file work when signal is already aborted", async () => {
    const record = registerFetchRetrieval({
      title: "Example title",
      content: "Long content",
      links: ["https://example.com"],
    });

    const controller = new AbortController();
    controller.abort();

    await expect(
      readFullFetchContent({
        fullContentRef: record.fullContentRef,
        section: "content",
        mode: "file",
        outputPath: "/tmp/example.txt",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(mkdirMock).not.toHaveBeenCalled();
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it("checks cancellation again after mkdir and before writeFile", async () => {
    const record = registerFetchRetrieval({
      title: "Example title",
      content: "Long content",
      links: ["https://example.com"],
    });

    const controller = new AbortController();
    mkdirMock.mockImplementationOnce(async () => {
      controller.abort();
    });

    await expect(
      readFullFetchContent({
        fullContentRef: record.fullContentRef,
        section: "content",
        mode: "file",
        outputPath: "/tmp/example.txt",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(mkdirMock).toHaveBeenCalledTimes(1);
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it("propagates abort signal into writeFile so an in-progress write can cancel", async () => {
    const record = registerFetchRetrieval({
      title: "Example title",
      content: "Long content",
      links: ["https://example.com"],
    });

    const controller = new AbortController();
    writeFileMock.mockImplementationOnce((...args: unknown[]) => {
      const options = (args[2] as { encoding?: string; signal?: AbortSignal } | undefined) ?? undefined;

      return new Promise<void>((resolve, reject) => {
        if (!options?.signal) {
          resolve();
          return;
        }

        options.signal.addEventListener(
          "abort",
          () => {
            reject(options.signal?.reason);
          },
          { once: true },
        );

        controller.abort();
      });
    });

    await expect(
      readFullFetchContent({
        fullContentRef: record.fullContentRef,
        section: "content",
        mode: "file",
        outputPath: "/tmp/example.txt",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("still cleans temporary export root after an aborted temporary write", async () => {
    const store = createFetchRetrievalStore();
    const record = store.registerFetchRetrieval({
      title: "Example title",
      content: "Long content",
      links: ["https://example.com"],
    });

    const controller = new AbortController();
    writeFileMock.mockImplementationOnce((...args: unknown[]) => {
      const options = (args[2] as { signal?: AbortSignal } | undefined) ?? undefined;

      return new Promise<void>((_resolve, reject) => {
        if (!options?.signal) {
          reject(new Error("Expected signal on writeFile options"));
          return;
        }

        options.signal.addEventListener(
          "abort",
          () => {
            reject(options.signal?.reason);
          },
          { once: true },
        );

        controller.abort();
      });
    });

    await expect(
      store.readFullFetchContent({
        fullContentRef: record.fullContentRef,
        section: "content",
        mode: "file",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    await store.cleanupTemporaryExports();

    expect(rmMock).toHaveBeenCalledWith(expect.stringContaining(`${tmpdir()}/pi-ollama-web-search-`), {
      force: true,
      recursive: true,
    });
  });
});

describe("readFullFetchContent file exports", () => {
  it("resolves relative export paths from cwd, tolerates leading @, and creates parent directories", async () => {
    const store = createFetchRetrievalStore();
    const record = store.registerFetchRetrieval({
      title: "Example title",
      content: "Long content",
      links: ["https://example.com"],
    });

    const result = await store.readFullFetchContent({
      fullContentRef: record.fullContentRef,
      section: "content",
      mode: "file",
      cwd: "/workspace/project",
      outputPath: "@exports/full/content.txt",
    });

    expect(result.mode).toBe("file");
    if (result.mode !== "file") {
      throw new Error("Expected file mode result");
    }

    expect(result.details.outputPath).toBe("/workspace/project/exports/full/content.txt");
    expect(result.details.temporary).toBe(false);
    expect(result.details.overwritten).toBe(false);
    expect(mkdirMock).toHaveBeenCalledWith("/workspace/project/exports/full", { recursive: true });
    expect(writeFileMock).toHaveBeenCalledWith(
      "/workspace/project/exports/full/content.txt",
      "Long content",
      expect.objectContaining({ encoding: "utf8", flag: "wx" }),
    );
  });

  it("refuses to overwrite an existing explicit export unless overwrite=true", async () => {
    const store = createFetchRetrievalStore();
    const record = store.registerFetchRetrieval({
      title: "Example title",
      content: "Long content",
      links: ["https://example.com"],
    });

    accessMock.mockResolvedValueOnce();

    await expect(
      store.readFullFetchContent({
        fullContentRef: record.fullContentRef,
        section: "content",
        mode: "file",
        outputPath: "/workspace/project/export.txt",
      }),
    ).rejects.toThrow("File already exists: /workspace/project/export.txt. Pass overwrite=true to replace it.");

    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it("overwrites an existing explicit export only when overwrite=true", async () => {
    const store = createFetchRetrievalStore();
    const record = store.registerFetchRetrieval({
      title: "Example title",
      content: "Long content",
      links: ["https://example.com"],
    });

    accessMock.mockResolvedValueOnce();

    const result = await store.readFullFetchContent({
      fullContentRef: record.fullContentRef,
      section: "content",
      mode: "file",
      outputPath: "/workspace/project/export.txt",
      overwrite: true,
    });

    expect(result.mode).toBe("file");
    if (result.mode !== "file") {
      throw new Error("Expected file mode result");
    }

    expect(result.details.outputPath).toBe("/workspace/project/export.txt");
    expect(result.details.temporary).toBe(false);
    expect(result.details.overwritten).toBe(true);
    expect(writeFileMock).toHaveBeenCalledWith(
      "/workspace/project/export.txt",
      "Long content",
      expect.objectContaining({ encoding: "utf8", flag: "w" }),
    );
  });

  it("creates temp exports when no outputPath is provided and cleans them up on shutdown", async () => {
    const store = createFetchRetrievalStore();
    const record = store.registerFetchRetrieval({
      title: "Example title",
      content: "Long content",
      links: ["https://example.com"],
    });

    const result = await store.readFullFetchContent({
      fullContentRef: record.fullContentRef,
      section: "title",
      mode: "file",
    });

    expect(result.mode).toBe("file");
    if (result.mode !== "file") {
      throw new Error("Expected file mode result");
    }

    expect(result.details.outputPath).toContain("pi-ollama-web-search-");
    expect(result.details.outputPath.startsWith(tmpdir())).toBe(true);
    expect(result.details.temporary).toBe(true);
    expect(result.details.overwritten).toBe(false);

    await store.cleanupTemporaryExports();

    expect(rmMock).toHaveBeenCalledWith(expect.stringContaining(`${tmpdir()}/pi-ollama-web-search-`), {
      force: true,
      recursive: true,
    });
  });
});

describe("readFullFetchContent replay recovery", () => {
  it("replays payload on cache miss and returns servedFrom replay with same ref", async () => {
    const replayFetch = vi.fn().mockResolvedValue({
      title: "Replayed title",
      content: "Replayed content",
      links: ["https://example.com/replayed"],
    });

    const store = createFetchRetrievalStore({ replayFetch });
    const replayable = store.registerFetchRetrieval(
      {
        title: "Original title",
        content: "Original content",
        links: ["https://example.com/original"],
      },
      { sourceUrl: "https://example.com/source" },
    );

    store.registerFetchRetrieval({
      title: "Oversized",
      content: "x".repeat(FETCH_RETRIEVAL_STORE_MAX_BYTES + 10_000),
      links: ["https://example.com/oversized"],
    });

    const result = await store.readFullFetchContent({
      fullContentRef: replayable.fullContentRef,
      section: "content",
    });

    expect(result.mode).toBe("inline");
    if (result.mode !== "inline") {
      throw new Error("Expected inline mode result");
    }

    expect(result.text).toBe("Replayed content");
    expect(result.details.fullContentRef).toBe(replayable.fullContentRef);
    expect(result.details.servedFrom).toBe("replay");
    expect(replayFetch).toHaveBeenCalledWith({ url: "https://example.com/source", signal: undefined });

    const cached = await store.readFullFetchContent({
      fullContentRef: replayable.fullContentRef,
      section: "content",
    });

    expect(cached.mode).toBe("inline");
    if (cached.mode !== "inline") {
      throw new Error("Expected inline mode result");
    }

    expect(cached.text).toBe("Replayed content");
    expect(cached.details.servedFrom).toBe("cache");
    expect(replayFetch).toHaveBeenCalledTimes(1);
  });

  it("returns combined cache-miss envelope when replay also fails", async () => {
    const replayFetch = vi.fn().mockRejectedValue(new Error("upstream unavailable"));
    const store = createFetchRetrievalStore({ replayFetch });
    const replayable = store.registerFetchRetrieval(
      {
        title: "Original title",
        content: "Original content",
        links: ["https://example.com/original"],
      },
      { sourceUrl: "https://example.com/source" },
    );

    store.registerFetchRetrieval({
      title: "Oversized",
      content: "x".repeat(FETCH_RETRIEVAL_STORE_MAX_BYTES + 10_000),
      links: ["https://example.com/oversized"],
    });

    await expect(
      store.readFullFetchContent({
        fullContentRef: replayable.fullContentRef,
        section: "content",
      }),
    ).rejects.toThrow(
      `No stored full content found for ref: ${replayable.fullContentRef}. Replay also failed: upstream unavailable`,
    );
  });

  it("rebuilds payload for file mode reads after replay", async () => {
    const replayFetch = vi.fn().mockResolvedValue({
      title: "Replayed title",
      content: "Replayed content",
      links: ["https://example.com/replayed"],
    });
    const store = createFetchRetrievalStore({ replayFetch });
    const replayable = store.registerFetchRetrieval(
      {
        title: "Original title",
        content: "Original content",
        links: ["https://example.com/original"],
      },
      { sourceUrl: "https://example.com/source" },
    );

    store.registerFetchRetrieval({
      title: "Oversized",
      content: "x".repeat(FETCH_RETRIEVAL_STORE_MAX_BYTES + 10_000),
      links: ["https://example.com/oversized"],
    });

    const fileResult = await store.readFullFetchContent({
      fullContentRef: replayable.fullContentRef,
      section: "content",
      mode: "file",
      outputPath: "/workspace/project/replayed.txt",
    });

    expect(fileResult.mode).toBe("file");
    if (fileResult.mode !== "file") {
      throw new Error("Expected file mode result");
    }

    expect(fileResult.details.fullContentRef).toBe(replayable.fullContentRef);
    expect(fileResult.details.servedFrom).toBe("replay");
    expect(writeFileMock).toHaveBeenCalledWith(
      "/workspace/project/replayed.txt",
      "Replayed content",
      expect.objectContaining({ encoding: "utf8", flag: "wx" }),
    );

    const cachedInline = await store.readFullFetchContent({
      fullContentRef: replayable.fullContentRef,
      section: "content",
    });

    expect(cachedInline.mode).toBe("inline");
    if (cachedInline.mode !== "inline") {
      throw new Error("Expected inline mode result");
    }

    expect(cachedInline.details.servedFrom).toBe("cache");
    expect(cachedInline.text).toBe("Replayed content");
    expect(replayFetch).toHaveBeenCalledTimes(1);
  });
});

describe("registerFetchRetrieval store retention", () => {
  it("issues unique refs for identical payloads", async () => {
    const payload = {
      title: "same title",
      content: "same content",
      links: ["https://example.com/same"],
    };

    const first = registerFetchRetrieval(payload);
    const second = registerFetchRetrieval(payload);

    expect(first.fullContentRef).toMatch(/^fetch:[a-f0-9]{24}$/);
    expect(second.fullContentRef).toMatch(/^fetch:[a-f0-9]{24}$/);
    expect(first.fullContentRef).not.toBe(second.fullContentRef);

    await expect(readFullFetchContent({ fullContentRef: first.fullContentRef, section: "content" })).resolves.toMatchObject({
      mode: "inline",
      text: "same content",
    });
    await expect(readFullFetchContent({ fullContentRef: second.fullContentRef, section: "content" })).resolves.toMatchObject({
      mode: "inline",
      text: "same content",
    });
  });

  it("evicts older refs when cumulative retained fetch bytes exceed the budget", async () => {
    const oldest = registerFetchRetrieval({
      title: "first",
      content: "a".repeat(900_000),
      links: ["https://example.com/first"],
    });

    const newest = registerFetchRetrieval({
      title: "second",
      content: "b".repeat(900_000),
      links: ["https://example.com/second"],
    });

    await expect(readFullFetchContent({ fullContentRef: newest.fullContentRef, section: "content" })).resolves.toMatchObject({
      mode: "inline",
    });

    await expect(
      readFullFetchContent({
        fullContentRef: oldest.fullContentRef,
        section: "content",
      }),
    ).rejects.toThrow(`No stored full content found for ref: ${oldest.fullContentRef}`);
  });

  it("keeps the newest ref readable even when its payload alone exceeds the byte budget", async () => {
    const oldest = registerFetchRetrieval({
      title: "oldest",
      content: "payload-0",
      links: ["https://example.com/0"],
    });

    const newest = registerFetchRetrieval({
      title: "oversized",
      content: "x".repeat(FETCH_RETRIEVAL_STORE_MAX_BYTES + 10_000),
      links: ["https://example.com/oversized"],
    });

    await expect(readFullFetchContent({ fullContentRef: newest.fullContentRef, section: "content" })).resolves.toMatchObject({
      mode: "inline",
    });

    await expect(
      readFullFetchContent({
        fullContentRef: oldest.fullContentRef,
        section: "content",
      }),
    ).rejects.toThrow(`No stored full content found for ref: ${oldest.fullContentRef}`);
  });

  it("evicts older refs after the bounded store limit is exceeded", async () => {
    const oldest = registerFetchRetrieval({
      title: "oldest",
      content: "payload-0",
      links: ["https://example.com/0"],
    });

    for (let i = 1; i <= FETCH_RETRIEVAL_STORE_MAX_ENTRIES * 2; i += 1) {
      registerFetchRetrieval({
        title: `title-${i}`,
        content: `payload-${i}`,
        links: [`https://example.com/${i}`],
      });
    }

    await expect(
      readFullFetchContent({
        fullContentRef: oldest.fullContentRef,
        section: "content",
      }),
    ).rejects.toThrow(`No stored full content found for ref: ${oldest.fullContentRef}`);
  });
});
