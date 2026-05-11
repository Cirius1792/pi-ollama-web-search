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

    expect(result.details.servedFrom).toBe("cache");
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

    expect(result.details.servedFrom).toBe("cache");
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

    expect(result.details.servedFrom).toBe("cache");
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

describe("registerFetchRetrieval replay recovery", () => {
  it("replays evicted refs for inline reads, rebuilds the cache under the same ref, and reports servedFrom", async () => {
    const store = createFetchRetrievalStore();
    const replayFetch = vi.fn().mockResolvedValue({
      title: "Replay title",
      content: "Replay content",
      links: ["https://example.com/replay"],
    });

    const original = store.registerFetchRetrieval(
      {
        title: "Original title",
        content: "Original content",
        links: ["https://example.com/original"],
      },
      {
        url: "https://example.com/original",
        replayFetch,
      },
    );

    store.registerFetchRetrieval({
      title: "Evictor",
      content: "x".repeat(FETCH_RETRIEVAL_STORE_MAX_BYTES + 10_000),
      links: ["https://example.com/evictor"],
    });

    const replayed = await store.readFullFetchContent({
      fullContentRef: original.fullContentRef,
      section: "content",
    });

    expect(replayed).toMatchObject({
      mode: "inline",
      text: "Replay content",
      details: {
        mode: "inline",
        target: "fetch",
        section: "content",
        fullContentRef: original.fullContentRef,
        servedFrom: "replay",
      },
    });
    expect(replayFetch).toHaveBeenCalledWith({ url: "https://example.com/original" }, expect.any(AbortSignal));

    const cached = await store.readFullFetchContent({
      fullContentRef: original.fullContentRef,
      section: "content",
    });

    expect(cached).toMatchObject({
      mode: "inline",
      text: "Replay content",
      details: {
        fullContentRef: original.fullContentRef,
        servedFrom: "cache",
      },
    });
    expect(replayFetch).toHaveBeenCalledTimes(1);
  });

  it("replays evicted refs for file exports and preserves existing export behavior", async () => {
    const store = createFetchRetrievalStore();
    const replayFetch = vi.fn().mockResolvedValue({
      title: "Replay title",
      content: "Replay file body",
      links: ["https://example.com/replay"],
    });

    const original = store.registerFetchRetrieval(
      {
        title: "Original title",
        content: "Original content",
        links: ["https://example.com/original"],
      },
      {
        url: "https://example.com/original",
        replayFetch,
      },
    );

    store.registerFetchRetrieval({
      title: "Evictor",
      content: "x".repeat(FETCH_RETRIEVAL_STORE_MAX_BYTES + 10_000),
      links: ["https://example.com/evictor"],
    });

    const result = await store.readFullFetchContent({
      fullContentRef: original.fullContentRef,
      section: "content",
      mode: "file",
      outputPath: "/workspace/project/export.txt",
    });

    expect(result).toMatchObject({
      mode: "file",
      details: {
        mode: "file",
        target: "fetch",
        section: "content",
        fullContentRef: original.fullContentRef,
        servedFrom: "replay",
        outputPath: "/workspace/project/export.txt",
        charsWritten: "Replay file body".length,
        temporary: false,
        overwritten: false,
      },
    });
    expect(writeFileMock).toHaveBeenCalledWith(
      "/workspace/project/export.txt",
      "Replay file body",
      expect.objectContaining({ encoding: "utf8", flag: "wx" }),
    );
  });

  it("includes cache-miss and replay-failure context when fetch replay fails", async () => {
    const store = createFetchRetrievalStore();
    const replayFetch = vi.fn().mockRejectedValue(new Error("upstream unavailable"));

    const original = store.registerFetchRetrieval(
      {
        title: "Original title",
        content: "Original content",
        links: ["https://example.com/original"],
      },
      {
        url: "https://example.com/original",
        replayFetch,
      },
    );

    store.registerFetchRetrieval({
      title: "Evictor",
      content: "x".repeat(FETCH_RETRIEVAL_STORE_MAX_BYTES + 10_000),
      links: ["https://example.com/evictor"],
    });

    await expect(
      store.readFullFetchContent({
        fullContentRef: original.fullContentRef,
        section: "content",
      }),
    ).rejects.toThrow(`No stored full content found for ref: ${original.fullContentRef}. Replay failed: upstream unavailable`);
  });

  it("includes cache-miss and replay-failure context when fetch replay returns a malformed payload", async () => {
    const store = createFetchRetrievalStore();
    const replayFetch = vi.fn().mockResolvedValue({
      title: "Replay title",
      links: ["https://example.com/replay"],
    });

    const original = store.registerFetchRetrieval(
      {
        title: "Original title",
        content: "Original content",
        links: ["https://example.com/original"],
      },
      {
        url: "https://example.com/original",
        replayFetch,
      },
    );

    store.registerFetchRetrieval({
      title: "Evictor",
      content: "x".repeat(FETCH_RETRIEVAL_STORE_MAX_BYTES + 10_000),
      links: ["https://example.com/evictor"],
    });

    await expect(
      store.readFullFetchContent({
        fullContentRef: original.fullContentRef,
        section: "content",
      }),
    ).rejects.toThrow(
      `No stored full content found for ref: ${original.fullContentRef}. Replay failed: Unexpected Ollama web fetch response: content must be a string`,
    );
  });

  it("aborts an in-progress fetch replay when its only waiting caller aborts and preserves AbortError", async () => {
    const store = createFetchRetrievalStore();
    const controller = new AbortController();
    const abortError = new DOMException("The operation was aborted.", "AbortError");
    let replaySignal: AbortSignal | undefined;
    const replayFetch = vi.fn().mockImplementation(async (_replay: { url: string }, signal?: AbortSignal) => {
      replaySignal = signal;
      queueMicrotask(() => {
        controller.abort();
      });
      return new Promise<never>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            reject(abortError);
          },
          { once: true },
        );
      });
    });

    const original = store.registerFetchRetrieval(
      {
        title: "Original title",
        content: "Original content",
        links: ["https://example.com/original"],
      },
      {
        url: "https://example.com/original",
        replayFetch,
      },
    );

    store.registerFetchRetrieval({
      title: "Evictor",
      content: "x".repeat(FETCH_RETRIEVAL_STORE_MAX_BYTES + 10_000),
      links: ["https://example.com/evictor"],
    });

    await expect(
      store.readFullFetchContent({
        fullContentRef: original.fullContentRef,
        section: "content",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(replayFetch).toHaveBeenCalledTimes(1);
    expect(replayFetch.mock.calls[0]?.[0]).toEqual({ url: "https://example.com/original" });
    expect(replaySignal).toBeDefined();
    expect(replaySignal).not.toBe(controller.signal);
    expect(replaySignal?.aborted).toBe(true);
  });

  it("rejects an already-aborted signal before starting fetch replay", async () => {
    const store = createFetchRetrievalStore();
    const controller = new AbortController();
    const replayFetch = vi.fn().mockResolvedValue({
      title: "Replay title",
      content: "Replay content",
      links: ["https://example.com/replay"],
    });

    const original = store.registerFetchRetrieval(
      {
        title: "Original title",
        content: "Original content",
        links: ["https://example.com/original"],
      },
      {
        url: "https://example.com/original",
        replayFetch,
      },
    );

    store.registerFetchRetrieval({
      title: "Evictor",
      content: "x".repeat(FETCH_RETRIEVAL_STORE_MAX_BYTES + 10_000),
      links: ["https://example.com/evictor"],
    });

    controller.abort();

    await expect(
      store.readFullFetchContent({
        fullContentRef: original.fullContentRef,
        section: "content",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(replayFetch).not.toHaveBeenCalled();
  });

  it("dedupes concurrent replays for the same evicted fetch ref", async () => {
    const store = createFetchRetrievalStore();
    let resolveReplay: ((value: { title: string; content: string; links: string[] }) => void) | undefined;
    const replayFetch = vi.fn().mockImplementation(
      () =>
        new Promise<{ title: string; content: string; links: string[] }>((resolve) => {
          resolveReplay = resolve;
        }),
    );

    const original = store.registerFetchRetrieval(
      {
        title: "Original title",
        content: "Original content",
        links: ["https://example.com/original"],
      },
      {
        url: "https://example.com/original",
        replayFetch,
      },
    );

    store.registerFetchRetrieval({
      title: "Evictor",
      content: "x".repeat(FETCH_RETRIEVAL_STORE_MAX_BYTES + 10_000),
      links: ["https://example.com/evictor"],
    });

    const firstRead = store.readFullFetchContent({
      fullContentRef: original.fullContentRef,
      section: "content",
    });
    const secondRead = store.readFullFetchContent({
      fullContentRef: original.fullContentRef,
      section: "content",
    });

    expect(replayFetch).toHaveBeenCalledTimes(1);

    resolveReplay?.({
      title: "Replay title",
      content: "Replay content",
      links: ["https://example.com/replay"],
    });

    await expect(Promise.all([firstRead, secondRead])).resolves.toEqual([
      expect.objectContaining({
        mode: "inline",
        text: "Replay content",
        details: expect.objectContaining({
          fullContentRef: original.fullContentRef,
          servedFrom: "replay",
        }),
      }),
      expect.objectContaining({
        mode: "inline",
        text: "Replay content",
        details: expect.objectContaining({
          fullContentRef: original.fullContentRef,
          servedFrom: "replay",
        }),
      }),
    ]);

    const cached = await store.readFullFetchContent({
      fullContentRef: original.fullContentRef,
      section: "content",
    });

    expect(cached).toMatchObject({
      mode: "inline",
      text: "Replay content",
      details: {
        fullContentRef: original.fullContentRef,
        servedFrom: "cache",
      },
    });
    expect(replayFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects an aborted waiter promptly without aborting unrelated waiters sharing the replay", async () => {
    const store = createFetchRetrievalStore();
    const secondController = new AbortController();
    let resolveReplay: ((value: { title: string; content: string; links: string[] }) => void) | undefined;
    let replaySignal: AbortSignal | undefined;
    const replayFetch = vi.fn().mockImplementation(
      async (_replay: { url: string }, signal?: AbortSignal) => {
        replaySignal = signal;
        return new Promise<{ title: string; content: string; links: string[] }>((resolve) => {
          resolveReplay = resolve;
        });
      },
    );

    const original = store.registerFetchRetrieval(
      {
        title: "Original title",
        content: "Original content",
        links: ["https://example.com/original"],
      },
      {
        url: "https://example.com/original",
        replayFetch,
      },
    );

    store.registerFetchRetrieval({
      title: "Evictor",
      content: "x".repeat(FETCH_RETRIEVAL_STORE_MAX_BYTES + 10_000),
      links: ["https://example.com/evictor"],
    });

    const firstRead = store.readFullFetchContent({
      fullContentRef: original.fullContentRef,
      section: "content",
    });
    const secondRead = store.readFullFetchContent({
      fullContentRef: original.fullContentRef,
      section: "content",
      signal: secondController.signal,
    });

    expect(replayFetch).toHaveBeenCalledTimes(1);

    let secondStatus = "pending";
    secondRead.then(
      () => {
        secondStatus = "resolved";
      },
      (error: unknown) => {
        secondStatus = error instanceof Error ? error.name : String(error);
      },
    );

    try {
      secondController.abort();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(secondStatus).toBe("AbortError");
      expect(replaySignal?.aborted).toBe(false);

      resolveReplay?.({
        title: "Replay title",
        content: "Replay content",
        links: ["https://example.com/replay"],
      });

      await expect(firstRead).resolves.toMatchObject({
        mode: "inline",
        text: "Replay content",
        details: {
          fullContentRef: original.fullContentRef,
          servedFrom: "replay",
        },
      });
      await expect(secondRead).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      resolveReplay?.({
        title: "Replay title",
        content: "Replay content",
        links: ["https://example.com/replay"],
      });
    }
  });

  it("aborts the upstream replay once all concurrent waiters abort", async () => {
    const store = createFetchRetrievalStore();
    const firstController = new AbortController();
    const secondController = new AbortController();
    const abortError = new DOMException("The operation was aborted.", "AbortError");
    let replaySignal: AbortSignal | undefined;
    const replayFetch = vi.fn().mockImplementation(
      async (_replay: { url: string }, signal?: AbortSignal) => {
        replaySignal = signal;
        return new Promise<never>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              reject(abortError);
            },
            { once: true },
          );
        });
      },
    );

    const original = store.registerFetchRetrieval(
      {
        title: "Original title",
        content: "Original content",
        links: ["https://example.com/original"],
      },
      {
        url: "https://example.com/original",
        replayFetch,
      },
    );

    store.registerFetchRetrieval({
      title: "Evictor",
      content: "x".repeat(FETCH_RETRIEVAL_STORE_MAX_BYTES + 10_000),
      links: ["https://example.com/evictor"],
    });

    const firstRead = store.readFullFetchContent({
      fullContentRef: original.fullContentRef,
      section: "content",
      signal: firstController.signal,
    });
    const secondRead = store.readFullFetchContent({
      fullContentRef: original.fullContentRef,
      section: "content",
      signal: secondController.signal,
    });

    expect(replayFetch).toHaveBeenCalledTimes(1);

    firstController.abort();
    await expect(firstRead).rejects.toMatchObject({ name: "AbortError" });
    expect(replaySignal?.aborted).toBe(false);

    secondController.abort();
    await expect(secondRead).rejects.toMatchObject({ name: "AbortError" });
    expect(replaySignal?.aborted).toBe(true);
  });

  it("starts a fresh replay after the last waiter aborts even if the aborted replay has not settled yet", async () => {
    const store = createFetchRetrievalStore();
    const waitingController = new AbortController();
    const abortError = new DOMException("The operation was aborted.", "AbortError");
    let firstReplayReject: ((reason?: unknown) => void) | undefined;
    let firstReplaySignal: AbortSignal | undefined;
    let replayAttempt = 0;
    const replayFetch = vi.fn().mockImplementation(async (_replay: { url: string }, signal?: AbortSignal) => {
      replayAttempt += 1;

      if (replayAttempt === 1) {
        firstReplaySignal = signal;
        return new Promise<never>((_resolve, reject) => {
          firstReplayReject = reject;
        });
      }

      return {
        title: "Fresh replay title",
        content: "Fresh replay content",
        links: ["https://example.com/fresh-replay"],
      };
    });

    const original = store.registerFetchRetrieval(
      {
        title: "Original title",
        content: "Original content",
        links: ["https://example.com/original"],
      },
      {
        url: "https://example.com/original",
        replayFetch,
      },
    );

    store.registerFetchRetrieval({
      title: "Evictor",
      content: "x".repeat(FETCH_RETRIEVAL_STORE_MAX_BYTES + 10_000),
      links: ["https://example.com/evictor"],
    });

    const abortedWaiter = store.readFullFetchContent({
      fullContentRef: original.fullContentRef,
      section: "content",
      signal: waitingController.signal,
    });

    expect(replayFetch).toHaveBeenCalledTimes(1);

    waitingController.abort();
    await expect(abortedWaiter).rejects.toMatchObject({ name: "AbortError" });
    expect(firstReplaySignal?.aborted).toBe(true);

    const freshCaller = store.readFullFetchContent({
      fullContentRef: original.fullContentRef,
      section: "content",
    });

    await expect(freshCaller).resolves.toMatchObject({
      mode: "inline",
      text: "Fresh replay content",
      details: {
        fullContentRef: original.fullContentRef,
        servedFrom: "replay",
      },
    });
    expect(replayFetch).toHaveBeenCalledTimes(2);

    firstReplayReject?.(abortError);
  });

  it("aborts in-flight fetch replays when the store is cleared", async () => {
    const store = createFetchRetrievalStore();
    const abortError = new DOMException("The operation was aborted.", "AbortError");
    let replayReject: ((reason?: unknown) => void) | undefined;
    let replaySignal: AbortSignal | undefined;
    const replayFetch = vi.fn().mockImplementation(async (_replay: { url: string }, signal?: AbortSignal) => {
      replaySignal = signal;
      return new Promise<never>((_resolve, reject) => {
        replayReject = reject;
      });
    });

    const original = store.registerFetchRetrieval(
      {
        title: "Original title",
        content: "Original content",
        links: ["https://example.com/original"],
      },
      {
        url: "https://example.com/original",
        replayFetch,
      },
    );

    store.registerFetchRetrieval({
      title: "Evictor",
      content: "x".repeat(FETCH_RETRIEVAL_STORE_MAX_BYTES + 10_000),
      links: ["https://example.com/evictor"],
    });

    const readDuringReplay = store.readFullFetchContent({
      fullContentRef: original.fullContentRef,
      section: "content",
    });

    expect(replayFetch).toHaveBeenCalledTimes(1);

    store.clearFetchRetrievalStore();

    expect(replaySignal?.aborted).toBe(true);

    replayReject?.(abortError);
    await expect(readDuringReplay).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      store.readFullFetchContent({
        fullContentRef: original.fullContentRef,
        section: "content",
      }),
    ).rejects.toThrow(`No stored full content found for ref: ${original.fullContentRef}`);
  });

  it("does not repopulate cleared fetch state when an aborted replay resolves late", async () => {
    const store = createFetchRetrievalStore();
    let replaySignal: AbortSignal | undefined;
    let resolveReplay: ((value: { title: string; content: string; links: string[] }) => void) | undefined;
    const replayFetch = vi.fn().mockImplementation(async (_replay: { url: string }, signal?: AbortSignal) => {
      replaySignal = signal;
      return new Promise<{ title: string; content: string; links: string[] }>((resolve) => {
        resolveReplay = resolve;
      });
    });

    const original = store.registerFetchRetrieval(
      {
        title: "Original title",
        content: "Original content",
        links: ["https://example.com/original"],
      },
      {
        url: "https://example.com/original",
        replayFetch,
      },
    );

    store.registerFetchRetrieval({
      title: "Evictor",
      content: "x".repeat(FETCH_RETRIEVAL_STORE_MAX_BYTES + 10_000),
      links: ["https://example.com/evictor"],
    });

    const readDuringReplay = store.readFullFetchContent({
      fullContentRef: original.fullContentRef,
      section: "content",
    });

    expect(replayFetch).toHaveBeenCalledTimes(1);

    store.clearFetchRetrievalStore();

    expect(replaySignal?.aborted).toBe(true);

    resolveReplay?.({
      title: "Late replay title",
      content: "Late replay content",
      links: ["https://example.com/late-replay"],
    });

    await expect(readDuringReplay).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      store.readFullFetchContent({
        fullContentRef: original.fullContentRef,
        section: "content",
      }),
    ).rejects.toThrow(`No stored full content found for ref: ${original.fullContentRef}`);
  });

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

  it("replays refs after count-based payload eviction and rebuilds the cache under the same ref", async () => {
    const store = createFetchRetrievalStore();
    const replayFetch = vi.fn().mockResolvedValue({
      title: "Replay title",
      content: "Replay content after count eviction",
      links: ["https://example.com/replay"],
    });

    const original = store.registerFetchRetrieval(
      {
        title: "Original title",
        content: "Original content",
        links: ["https://example.com/original"],
      },
      {
        url: "https://example.com/original",
        replayFetch,
      },
    );

    for (let i = 1; i <= FETCH_RETRIEVAL_STORE_MAX_ENTRIES; i += 1) {
      store.registerFetchRetrieval({
        title: `title-${i}`,
        content: `payload-${i}`,
        links: [`https://example.com/${i}`],
      });
    }

    const replayed = await store.readFullFetchContent({
      fullContentRef: original.fullContentRef,
      section: "content",
    });

    expect(replayed).toMatchObject({
      mode: "inline",
      text: "Replay content after count eviction",
      details: {
        fullContentRef: original.fullContentRef,
        servedFrom: "replay",
      },
    });
    expect(replayFetch).toHaveBeenCalledWith({ url: "https://example.com/original" }, expect.any(AbortSignal));

    const cached = await store.readFullFetchContent({
      fullContentRef: original.fullContentRef,
      section: "content",
    });

    expect(cached).toMatchObject({
      mode: "inline",
      text: "Replay content after count eviction",
      details: {
        fullContentRef: original.fullContentRef,
        servedFrom: "cache",
      },
    });
    expect(replayFetch).toHaveBeenCalledTimes(1);
  });

  it("uses the store-level replay dependency when refs only retain lightweight replay metadata", async () => {
    const replayFetch = vi.fn().mockResolvedValue({
      title: "Replay title",
      content: "Replay content from store-level dependency",
      links: ["https://example.com/replay"],
    });
    const store = createFetchRetrievalStore({ replayFetch });

    const original = store.registerFetchRetrieval(
      {
        title: "Original title",
        content: "Original content",
        links: ["https://example.com/original"],
      },
      {
        url: "https://example.com/original",
      },
    );

    for (let i = 1; i <= FETCH_RETRIEVAL_STORE_MAX_ENTRIES; i += 1) {
      store.registerFetchRetrieval({
        title: `title-${i}`,
        content: `payload-${i}`,
        links: [`https://example.com/${i}`],
      });
    }

    await expect(
      store.readFullFetchContent({
        fullContentRef: original.fullContentRef,
        section: "content",
      }),
    ).resolves.toMatchObject({
      mode: "inline",
      text: "Replay content from store-level dependency",
      details: {
        fullContentRef: original.fullContentRef,
        servedFrom: "replay",
      },
    });

    expect(replayFetch).toHaveBeenCalledTimes(1);
    expect(replayFetch).toHaveBeenCalledWith({ url: "https://example.com/original" }, expect.any(AbortSignal));
  });

  it("retains replay metadata for older fetch refs even after many newer refs are registered", async () => {
    const store = createFetchRetrievalStore();
    const replayFetch = vi.fn().mockResolvedValue({
      title: "Replay title",
      content: "Replay content after metadata pressure",
      links: ["https://example.com/replay"],
    });

    const oldest = store.registerFetchRetrieval(
      {
        title: "Original title",
        content: "Original content",
        links: ["https://example.com/original"],
      },
      {
        url: "https://example.com/original",
        replayFetch,
      },
    );

    for (let i = 1; i <= FETCH_RETRIEVAL_STORE_MAX_ENTRIES * 8; i += 1) {
      store.registerFetchRetrieval({
        title: `title-${i}`,
        content: `payload-${i}`,
        links: [`https://example.com/${i}`],
      });
    }

    await expect(
      store.readFullFetchContent({
        fullContentRef: oldest.fullContentRef,
        section: "content",
      }),
    ).resolves.toMatchObject({
      mode: "inline",
      text: "Replay content after metadata pressure",
      details: {
        fullContentRef: oldest.fullContentRef,
        servedFrom: "replay",
      },
    });

    await expect(
      store.readFullFetchContent({
        fullContentRef: oldest.fullContentRef,
        section: "content",
      }),
    ).resolves.toMatchObject({
      mode: "inline",
      text: "Replay content after metadata pressure",
      details: {
        fullContentRef: oldest.fullContentRef,
        servedFrom: "cache",
      },
    });

    expect(replayFetch).toHaveBeenCalledTimes(1);
    expect(replayFetch).toHaveBeenCalledWith({ url: "https://example.com/original" }, expect.any(AbortSignal));
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
