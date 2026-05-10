import { beforeEach, describe, expect, it, vi } from "vitest";

const { mkdirMock, writeFileMock } = vi.hoisted(() => ({
  mkdirMock: vi.fn<(...args: unknown[]) => Promise<void>>(async (..._args: unknown[]) => {}),
  writeFileMock: vi.fn<(...args: unknown[]) => Promise<void>>(async (..._args: unknown[]) => {}),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: mkdirMock,
  writeFile: writeFileMock,
}));

import {
  FETCH_RETRIEVAL_STORE_MAX_ENTRIES,
  readFullFetchContent,
  registerFetchRetrieval,
} from "../src/retrieval.js";

beforeEach(() => {
  mkdirMock.mockReset();
  writeFileMock.mockReset();
  mkdirMock.mockImplementation(async (..._args: unknown[]) => {});
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
