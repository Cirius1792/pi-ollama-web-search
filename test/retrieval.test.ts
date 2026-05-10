import { describe, expect, it, vi } from "vitest";

const { mkdirMock, writeFileMock } = vi.hoisted(() => ({
  mkdirMock: vi.fn(async () => undefined),
  writeFileMock: vi.fn(async () => undefined),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: mkdirMock,
  writeFile: writeFileMock,
}));

import { readFullFetchContent, registerFetchRetrieval } from "../src/retrieval.js";

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
});
