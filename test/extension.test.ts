import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "../src/index.js";

interface RegisteredTool {
  name: string;
  description?: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters?: any;
  execute: (...args: any[]) => Promise<any>;
}

function createFakePi() {
  const tools: RegisteredTool[] = [];
  const commands: Record<string, any> = {};
  const handlers: Record<string, any> = {};

  return {
    pi: {
      registerTool: vi.fn((tool: RegisteredTool) => tools.push(tool)),
      registerCommand: vi.fn((name: string, command: any) => {
        commands[name] = command;
      }),
      on: vi.fn((event: string, handler: any) => {
        handlers[event] = handler;
      }),
      sendMessage: vi.fn(),
    },
    tools,
    commands,
    handlers,
  };
}

const originalEnv = process.env;

beforeEach(() => {
  process.env = { ...originalEnv };
  delete process.env.OLLAMA_API_KEY;
  delete process.env.PI_OLLAMA_SEARCH_DEV;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("extension", () => {
  it("registers search, fetch, and read-full production tools", () => {
    const fake = createFakePi();
    extension(fake.pi as any);

    expect(fake.pi.registerTool).toHaveBeenCalledTimes(3);
    expect(fake.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["ollama_web_search", "ollama_web_fetch", "ollama_web_read_full"]),
    );
  });

  it("adds proactive guidance for when search and fetch should be used", () => {
    const fake = createFakePi();
    extension(fake.pi as any);

    const searchTool = fake.tools.find((tool) => tool.name === "ollama_web_search");
    const fetchTool = fake.tools.find((tool) => tool.name === "ollama_web_fetch");

    expect(searchTool?.promptGuidelines).toEqual(
      expect.arrayContaining([
        expect.stringContaining("latest, current, or recent"),
        expect.stringContaining("documentation or references"),
      ]),
    );

    expect(fetchTool?.promptGuidelines).toEqual(
      expect.arrayContaining([
        expect.stringContaining("user provides a URL"),
        expect.stringContaining("before quoting or summarizing"),
      ]),
    );
  });

  it("fetch + read-full retrieval path supports inline, explicit file export, and temp file export modes", async () => {
    process.env.OLLAMA_API_KEY = "test-key";

    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            title: "Example title",
            content: "Long content body",
            links: ["https://example.com/a", "https://example.com/b"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchImpl);

    const fake = createFakePi();
    extension(fake.pi as any);

    const fetchTool = fake.tools.find((tool) => tool.name === "ollama_web_fetch");
    const readFullTool = fake.tools.find((tool) => tool.name === "ollama_web_read_full");

    const fetchResult = await fetchTool?.execute("call-1", { url: "https://example.com" }, new AbortController().signal);

    const fullContentRef = fetchResult?.details?.fullContentRef;
    expect(typeof fullContentRef).toBe("string");
    expect(fetchResult?.details?.retrieval?.target).toBe("fetch");
    expect(fetchResult?.details?.retrieval?.sections).toEqual(["title", "content", "links"]);
    expect(fetchResult?.details?.retrieval?.targets?.title?.section).toBe("title");
    expect(fetchResult?.details?.retrieval?.targets?.content?.section).toBe("content");
    expect(fetchResult?.details?.retrieval?.targets?.links?.section).toBe("links");
    expect(fetchResult?.details?.retrieval?.targets?.title?.fullContentRef).toBe(fullContentRef);
    expect(fetchResult?.details?.retrieval?.targets?.content?.fullContentRef).toBe(fullContentRef);
    expect(fetchResult?.details?.retrieval?.targets?.links?.fullContentRef).toBe(fullContentRef);

    const inlineContentResult = await readFullTool?.execute("call-2", { ref: fullContentRef, section: "content" }, new AbortController().signal);

    expect(inlineContentResult?.content?.[0]?.text).toBe("Long content body");
    expect(inlineContentResult?.details?.mode).toBe("inline");
    expect(inlineContentResult?.details?.section).toBe("content");
    expect(inlineContentResult?.details?.offset).toBe(0);

    const inlineLinksResult = await readFullTool?.execute(
      "call-2b",
      { ref: fullContentRef, section: "links", offset: 0, maxChars: 10_000 },
      new AbortController().signal,
    );

    expect(inlineLinksResult?.content?.[0]?.text).toBe("https://example.com/a\nhttps://example.com/b");
    expect(inlineLinksResult?.details?.mode).toBe("inline");
    expect(inlineLinksResult?.details?.section).toBe("links");

    const workspaceDir = await mkdtemp(join(tmpdir(), "pi-ollama-web-search-workspace-"));
    let tempOutputPath: string | undefined;
    try {
      const fileResult = await readFullTool?.execute(
        "call-3",
        { ref: fullContentRef, section: "title", mode: "file", path: "@exports/title.txt" },
        new AbortController().signal,
        undefined,
        { cwd: workspaceDir },
      );

      expect(fileResult?.content?.[0]?.text).toContain("Wrote full section to");
      expect(fileResult?.content?.[0]?.text).toContain("Delete this file when you no longer need it.");
      expect(fileResult?.details?.mode).toBe("file");
      expect(fileResult?.details?.temporary).toBe(false);
      expect(fileResult?.details?.outputPath).toBe(join(workspaceDir, "exports/title.txt"));
      expect(await readFile(fileResult?.details?.outputPath, "utf8")).toBe("Example title");

      const tempFileResult = await readFullTool?.execute(
        "call-4",
        { ref: fullContentRef, section: "content", mode: "file" },
        new AbortController().signal,
      );

      tempOutputPath = tempFileResult?.details?.outputPath;
      expect(tempFileResult?.details?.temporary).toBe(true);
      expect(await readFile(tempFileResult?.details?.outputPath, "utf8")).toBe("Long content body");
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
      if (tempOutputPath) {
        await rm(tempOutputPath, { force: true });
      }
    }
  });

  it("propagates abort signal to fetch read-full retrieval", async () => {
    process.env.OLLAMA_API_KEY = "test-key";

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            title: "Example title",
            content: "Long content body",
            links: ["https://example.com/a"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const fake = createFakePi();
    extension(fake.pi as any);

    const fetchTool = fake.tools.find((tool) => tool.name === "ollama_web_fetch");
    const readFullTool = fake.tools.find((tool) => tool.name === "ollama_web_read_full");

    const fetchResult = await fetchTool?.execute("call-1", { url: "https://example.com" }, new AbortController().signal);
    const fullContentRef = fetchResult?.details?.fullContentRef;

    const controller = new AbortController();
    controller.abort();

    await expect(readFullTool?.execute("call-2", { ref: fullContentRef, section: "content" }, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("validates fetch-specific read-full parameter combinations", async () => {
    process.env.OLLAMA_API_KEY = "test-key";

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            title: "Example title",
            content: "Long content body",
            links: ["https://example.com/a"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const fake = createFakePi();
    extension(fake.pi as any);

    const fetchTool = fake.tools.find((tool) => tool.name === "ollama_web_fetch");
    const readFullTool = fake.tools.find((tool) => tool.name === "ollama_web_read_full");

    const fetchResult = await fetchTool?.execute("call-fetch", { url: "https://example.com" }, new AbortController().signal);
    const fullContentRef = fetchResult?.details?.fullContentRef;

    await expect(
      readFullTool?.execute("call-fetch-result-index", { ref: fullContentRef, section: "content", resultIndex: 1 }, new AbortController().signal),
    ).rejects.toThrow("resultIndex is not supported for fetch refs.");

    await expect(
      readFullTool?.execute("call-fetch-path-inline", { ref: fullContentRef, section: "content", path: "@exports/content.txt" }, new AbortController().signal),
    ).rejects.toThrow("path/outputPath and overwrite are only supported for fetch refs when mode=file.");

    await expect(
      readFullTool?.execute("call-fetch-overwrite-inline", { ref: fullContentRef, section: "content", overwrite: true }, new AbortController().signal),
    ).rejects.toThrow("path/outputPath and overwrite are only supported for fetch refs when mode=file.");

    await expect(
      readFullTool?.execute(
        "call-fetch-conflicting-paths",
        { ref: fullContentRef, section: "content", mode: "file", path: "a.txt", outputPath: "b.txt" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("path and outputPath must match when both are provided.");
  });

  it("returns search retrieval metadata and reads title/url/content through ollama_web_read_full", async () => {
    process.env.OLLAMA_API_KEY = "test-key";

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            results: [
              { title: "One", url: "https://example.com/one", content: "First content" },
              { title: "Two", url: "https://example.com/two", content: "Second content" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const fake = createFakePi();
    extension(fake.pi as any);

    const searchTool = fake.tools.find((tool) => tool.name === "ollama_web_search");
    const readFullTool = fake.tools.find((tool) => tool.name === "ollama_web_read_full");

    const searchResult = await searchTool!.execute("tool-1", { query: "test query" }, undefined);
    const ref = searchResult.details.fullContentRef;

    expect(ref).toMatch(/^ws_s_/);
    expect(searchResult.details.retrieval.kind).toBe("search");

    const retrievalCases = [
      { section: "title", resultIndex: 1, expectedText: "One" },
      { section: "url", resultIndex: 2, expectedText: "https://example.com/two" },
      { section: "content", resultIndex: 2, expectedText: "Second content" },
    ] as const;

    for (const testCase of retrievalCases) {
      const readResult = await readFullTool!.execute(
        `tool-read-${testCase.section}`,
        { ref, section: testCase.section, resultIndex: testCase.resultIndex },
        undefined,
      );

      expect(readResult).toEqual({
        content: [{ type: "text", text: testCase.expectedText }],
        details: {
          ref,
          kind: "search",
          section: testCase.section,
          resultIndex: testCase.resultIndex,
          servedFrom: "cache",
        },
      });
    }
  });

  it("replays evicted search refs into original result-index order and serves later reads from cache", async () => {
    process.env.OLLAMA_API_KEY = "test-key";

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [
              { title: "A1", url: "https://example.com/a", content: "first a" },
              { title: "B", url: "https://example.com/b", content: "bee" },
              { title: "A2", url: "https://example.com/a", content: "second a" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [{ title: "Evictor", url: "https://example.com/evictor", content: "x".repeat(1_200_000) }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [
              { title: "B replay", url: "https://example.com/b", content: "bee replay" },
              { title: "A replay 1", url: "https://example.com/a", content: "first a replay" },
              { title: "A replay 2", url: "https://example.com/a", content: "second a replay" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const fake = createFakePi();
    extension(fake.pi as any);

    const searchTool = fake.tools.find((tool) => tool.name === "ollama_web_search");
    const readFullTool = fake.tools.find((tool) => tool.name === "ollama_web_read_full");

    const searchResult = await searchTool!.execute("tool-search-1", { query: "dupes" }, new AbortController().signal);
    const ref = searchResult.details.fullContentRef;

    await searchTool!.execute("tool-search-evict", { query: "evict" }, new AbortController().signal);

    await expect(
      readFullTool!.execute("tool-read-replayed", { ref, section: "content", resultIndex: 3 }, new AbortController().signal),
    ).resolves.toEqual({
      content: [{ type: "text", text: "second a replay" }],
      details: {
        ref,
        kind: "search",
        section: "content",
        resultIndex: 3,
        servedFrom: "replay",
      },
    });

    await expect(
      readFullTool!.execute("tool-read-cached", { ref, section: "content", resultIndex: 1 }, new AbortController().signal),
    ).resolves.toEqual({
      content: [{ type: "text", text: "first a replay" }],
      details: {
        ref,
        kind: "search",
        section: "content",
        resultIndex: 1,
        servedFrom: "cache",
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("serves a requested replayed result even when an unrelated original result is gone", async () => {
    process.env.OLLAMA_API_KEY = "test-key";

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [
              { title: "A1", url: "https://example.com/a", content: "first a" },
              { title: "B", url: "https://example.com/b", content: "bee" },
              { title: "A2", url: "https://example.com/a", content: "second a" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [{ title: "Evictor", url: "https://example.com/evictor", content: "x".repeat(1_200_000) }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [
              { title: "A replay 2", url: "https://example.com/a", content: "second a replay" },
              { title: "A replay 1", url: "https://example.com/a", content: "first a replay" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const fake = createFakePi();
    extension(fake.pi as any);

    const searchTool = fake.tools.find((tool) => tool.name === "ollama_web_search");
    const readFullTool = fake.tools.find((tool) => tool.name === "ollama_web_read_full");

    const searchResult = await searchTool!.execute("tool-search-1", { query: "dupes" }, new AbortController().signal);
    const ref = searchResult.details.fullContentRef;

    await searchTool!.execute("tool-search-evict", { query: "evict" }, new AbortController().signal);

    await expect(
      readFullTool!.execute("tool-read-replayed", { ref, section: "content", resultIndex: 3 }, new AbortController().signal),
    ).resolves.toEqual({
      content: [{ type: "text", text: "first a replay" }],
      details: {
        ref,
        kind: "search",
        section: "content",
        resultIndex: 3,
        servedFrom: "replay",
      },
    });

    await expect(
      readFullTool!.execute("tool-read-cached", { ref, section: "content", resultIndex: 1 }, new AbortController().signal),
    ).resolves.toEqual({
      content: [{ type: "text", text: "second a replay" }],
      details: {
        ref,
        kind: "search",
        section: "content",
        resultIndex: 1,
        servedFrom: "cache",
      },
    });

    await expect(
      readFullTool!.execute("tool-read-missing-unrelated", { ref, section: "content", resultIndex: 2 }, new AbortController().signal),
    ).rejects.toThrow(`No stored content found for ref ${ref}. Replay succeeded, but the original search result 2 could not be reconstructed.`);

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("replays evicted search refs using the extension's injected config even if env changes before read-full", async () => {
    process.env.OLLAMA_API_KEY = "test-key";

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [{ title: "One", url: "https://example.com/one", content: "First content" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [{ title: "Evictor", url: "https://example.com/evictor", content: "x".repeat(1_200_000) }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [{ title: "One replay", url: "https://example.com/one", content: "First content replay" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const fake = createFakePi();
    extension(fake.pi as any);

    const searchTool = fake.tools.find((tool) => tool.name === "ollama_web_search");
    const readFullTool = fake.tools.find((tool) => tool.name === "ollama_web_read_full");

    const searchResult = await searchTool!.execute("tool-search-1", { query: "dupes" }, new AbortController().signal);
    const ref = searchResult.details.fullContentRef;

    await searchTool!.execute("tool-search-evict", { query: "evict" }, new AbortController().signal);
    delete process.env.OLLAMA_API_KEY;

    await expect(
      readFullTool!.execute("tool-read-replayed", { ref, section: "content", resultIndex: 1 }, new AbortController().signal),
    ).resolves.toEqual({
      content: [{ type: "text", text: "First content replay" }],
      details: {
        ref,
        kind: "search",
        section: "content",
        resultIndex: 1,
        servedFrom: "replay",
      },
    });
  });

  it("fails clearly when the requested search replay occurrence is gone", async () => {
    process.env.OLLAMA_API_KEY = "test-key";

    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              results: [
                { title: "A1", url: "https://example.com/a", content: "first a" },
                { title: "A2", url: "https://example.com/a", content: "second a" },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              results: [{ title: "Evictor", url: "https://example.com/evictor", content: "x".repeat(1_200_000) }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              results: [{ title: "A replay 1", url: "https://example.com/a", content: "first a replay" }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ),
    );

    const fake = createFakePi();
    extension(fake.pi as any);

    const searchTool = fake.tools.find((tool) => tool.name === "ollama_web_search");
    const readFullTool = fake.tools.find((tool) => tool.name === "ollama_web_read_full");

    const searchResult = await searchTool!.execute("tool-search-1", { query: "dupes" }, new AbortController().signal);
    const ref = searchResult.details.fullContentRef;

    await searchTool!.execute("tool-search-evict", { query: "evict" }, new AbortController().signal);

    await expect(
      readFullTool!.execute("tool-read-missing-occurrence", { ref, section: "content", resultIndex: 2 }, new AbortController().signal),
    ).rejects.toThrow(
      `No stored content found for ref ${ref}. Replay succeeded, but the original search result 2 could not be reconstructed.`,
    );
  });

  it("validates search read-full errors end-to-end through the registered tool", async () => {
    process.env.OLLAMA_API_KEY = "test-key";

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            results: [
              { title: "One", url: "https://example.com/one", content: "First content" },
              { title: "Two", url: "https://example.com/two", content: "Second content" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const fake = createFakePi();
    extension(fake.pi as any);

    const searchTool = fake.tools.find((tool) => tool.name === "ollama_web_search");
    const readFullTool = fake.tools.find((tool) => tool.name === "ollama_web_read_full");

    const searchResult = await searchTool!.execute("tool-1", { query: "test query" }, undefined);
    const ref = searchResult.details.fullContentRef;

    await expect(readFullTool!.execute("tool-missing-index", { ref, section: "content" }, undefined)).rejects.toThrow(
      "resultIndex is required for search refs.",
    );

    await expect(
      readFullTool!.execute("tool-invalid-section", { ref, section: "links" as any, resultIndex: 1 }, undefined),
    ).rejects.toThrow("section must be one of: title, url, content.");

    await expect(readFullTool!.execute("tool-out-of-range", { ref, section: "content", resultIndex: 3 }, undefined)).rejects.toThrow(
      "Search result index 3 is out of range. Valid range is 1-2.",
    );

    await expect(readFullTool!.execute("tool-file-mode", { ref, section: "content", resultIndex: 1, mode: "file" }, undefined)).rejects.toThrow(
      "mode=file is only supported for fetch refs.",
    );

    await expect(
      readFullTool!.execute("tool-search-path", { ref, section: "content", resultIndex: 1, path: "@exports/content.txt" }, undefined),
    ).rejects.toThrow("path/outputPath and overwrite are only supported for fetch refs when mode=file.");

    await expect(
      readFullTool!.execute("tool-search-overwrite", { ref, section: "content", resultIndex: 1, overwrite: true }, undefined),
    ).rejects.toThrow("path/outputPath and overwrite are only supported for fetch refs when mode=file.");

    await expect(
      readFullTool!.execute("tool-bad-ref", { ref: "ws_s_missing", section: "content", resultIndex: 1 }, undefined),
    ).rejects.toThrow("No stored content found for ref ws_s_missing.");
  });

  it("isolates search retrieval refs between extension instances and clears them on session_start", async () => {
    process.env.OLLAMA_API_KEY = "test-key";

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            results: [{ title: "One", url: "https://example.com/one", content: "First content" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const fakeA = createFakePi();
    const fakeB = createFakePi();
    extension(fakeA.pi as any);
    extension(fakeB.pi as any);

    const searchToolA = fakeA.tools.find((tool) => tool.name === "ollama_web_search");
    const readFullToolA = fakeA.tools.find((tool) => tool.name === "ollama_web_read_full");
    const readFullToolB = fakeB.tools.find((tool) => tool.name === "ollama_web_read_full");

    const searchResultA = await searchToolA!.execute("tool-search-a", { query: "query a" }, undefined);
    const refA = searchResultA.details.fullContentRef;

    await expect(readFullToolB!.execute("tool-read-b", { ref: refA, section: "content", resultIndex: 1 }, undefined)).rejects.toThrow(
      `No stored content found for ref ${refA}.`,
    );

    await expect(readFullToolA!.execute("tool-read-a", { ref: refA, section: "content", resultIndex: 1 }, undefined)).resolves.toMatchObject({
      content: [{ type: "text", text: "First content" }],
    });

    await fakeA.handlers.session_start({}, { hasUI: false, ui: { notify: vi.fn() } });

    await expect(readFullToolA!.execute("tool-read-a-after-clear", { ref: refA, section: "content", resultIndex: 1 }, undefined)).rejects.toThrow(
      `No stored content found for ref ${refA}.`,
    );
  });

  it("supports read-full schema and guidance for both search and fetch refs", () => {
    const fake = createFakePi();
    extension(fake.pi as any);

    const readFullTool = fake.tools.find((tool) => tool.name === "ollama_web_read_full");

    expect(readFullTool).toBeDefined();
    expect(readFullTool?.description).toContain("search or web fetch");
    expect(readFullTool?.promptGuidelines?.join(" ")).toContain("ollama_web_search or ollama_web_fetch");
    expect(readFullTool?.promptGuidelines?.join(" ")).toContain(
      "When using ollama_web_read_full with an explicit export path, delete explicit export files when you no longer need them.",
    );
    expect(readFullTool?.parameters?.properties?.ref?.description).toContain("ollama_web_search or ollama_web_fetch");
    expect(readFullTool?.parameters?.properties?.path?.description).toContain("generated temp file");
    expect(readFullTool?.parameters?.properties?.outputPath?.description).toContain("Deprecated alias for path");

    const sectionOptions = readFullTool?.parameters?.properties?.section?.anyOf ?? [];
    const sectionLiterals = sectionOptions.map((option: { const?: string }) => option.const).filter(Boolean);
    expect(sectionLiterals).toEqual(expect.arrayContaining(["title", "url", "content", "links"]));

    expect(readFullTool?.parameters?.properties?.mode?.anyOf?.map((option: { const?: string }) => option.const)).toEqual(
      expect.arrayContaining(["inline", "file"]),
    );
    expect(readFullTool?.parameters?.properties?.overwrite?.type).toBe("boolean");
    expect(readFullTool?.parameters?.properties?.resultIndex?.type).toBe("integer");
    expect(readFullTool?.parameters?.properties?.offset?.minimum).toBe(0);
    expect(readFullTool?.parameters?.properties?.maxChars?.minimum).toBe(1);
  });

  it("clears stored fetch retrieval refs on session_start", async () => {
    process.env.OLLAMA_API_KEY = "test-key";

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({ title: "Example", content: "Body", links: ["https://example.com/a"] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const fake = createFakePi();
    extension(fake.pi as any);

    const fetchTool = fake.tools.find((tool) => tool.name === "ollama_web_fetch");
    const readFullTool = fake.tools.find((tool) => tool.name === "ollama_web_read_full");

    const fetchResult = await fetchTool?.execute("call-1", { url: "https://example.com" }, new AbortController().signal);
    const fullContentRef = fetchResult?.details?.fullContentRef;

    await fake.handlers.session_start({}, { hasUI: false, ui: { notify: vi.fn() } });

    await expect(readFullTool?.execute("call-2", { ref: fullContentRef, section: "content" }, new AbortController().signal)).rejects.toThrow(
      `No stored full content found for ref: ${fullContentRef}`,
    );
  });


  it("deletes temporary fetch exports on session_shutdown but leaves explicit exports in place", async () => {
    process.env.OLLAMA_API_KEY = "test-key";

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({ title: "Example", content: "Body", links: ["https://example.com/a"] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const fake = createFakePi();
    extension(fake.pi as any);

    const fetchTool = fake.tools.find((tool) => tool.name === "ollama_web_fetch");
    const readFullTool = fake.tools.find((tool) => tool.name === "ollama_web_read_full");

    const fetchResult = await fetchTool?.execute("call-1", { url: "https://example.com" }, new AbortController().signal);
    const fullContentRef = fetchResult?.details?.fullContentRef;

    const workspaceDir = await mkdtemp(join(tmpdir(), "pi-ollama-web-search-persist-"));
    try {
      const persistentResult = await readFullTool?.execute(
        "call-persistent",
        { ref: fullContentRef, section: "title", mode: "file", path: "saved/title.txt" },
        new AbortController().signal,
        undefined,
        { cwd: workspaceDir },
      );
      const temporaryResult = await readFullTool?.execute(
        "call-temp",
        { ref: fullContentRef, section: "content", mode: "file" },
        new AbortController().signal,
      );

      expect(await readFile(persistentResult?.details?.outputPath, "utf8")).toBe("Example");
      expect(await readFile(temporaryResult?.details?.outputPath, "utf8")).toBe("Body");

      await fake.handlers.session_shutdown({}, { hasUI: false, ui: { notify: vi.fn() } });

      expect(await readFile(persistentResult?.details?.outputPath, "utf8")).toBe("Example");
      await expect(readFile(temporaryResult?.details?.outputPath, "utf8")).rejects.toThrow();
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("isolates fetch retrieval refs between extension instances", async () => {
    process.env.OLLAMA_API_KEY = "test-key";

    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          title: "Example title",
          content: "Long content body",
          links: ["https://example.com/a", "https://example.com/b"],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchImpl);

    const fakeA = createFakePi();
    const fakeB = createFakePi();
    extension(fakeA.pi as any);
    extension(fakeB.pi as any);

    const fetchToolA = fakeA.tools.find((tool) => tool.name === "ollama_web_fetch");
    const readFullToolA = fakeA.tools.find((tool) => tool.name === "ollama_web_read_full");
    const readFullToolB = fakeB.tools.find((tool) => tool.name === "ollama_web_read_full");

    const fetchResultA = await fetchToolA?.execute("call-1", { url: "https://example.com" }, new AbortController().signal);
    const fullContentRefA = fetchResultA?.details?.fullContentRef;

    await expect(
      readFullToolB?.execute("call-2", { ref: fullContentRefA, section: "content" }, new AbortController().signal),
    ).rejects.toThrow(`No stored full content found for ref: ${fullContentRefA}`);

    await fakeB.handlers.session_start({}, { hasUI: false, ui: { notify: vi.fn() } });

    await expect(
      readFullToolA?.execute("call-3", { ref: fullContentRefA, section: "content" }, new AbortController().signal),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "Long content body" }],
    });
  });

  it("does not register the debug command by default", () => {
    const fake = createFakePi();
    extension(fake.pi as any);

    expect(fake.pi.registerCommand).not.toHaveBeenCalled();
  });

  it("registers search and fetch debug commands when dev mode is enabled", () => {
    process.env.PI_OLLAMA_SEARCH_DEV = "1";
    const fake = createFakePi();
    extension(fake.pi as any);

    expect(fake.pi.registerCommand).toHaveBeenCalledWith("ollama-search", expect.any(Object));
    expect(fake.pi.registerCommand).toHaveBeenCalledWith("ollama-fetch", expect.any(Object));
    expect(fake.commands["ollama-search"].description).toContain("debug");
    expect(fake.commands["ollama-fetch"].description).toContain("debug");
  });

  it("registers a session_start warning for missing API key", async () => {
    const fake = createFakePi();
    extension(fake.pi as any);

    const notify = vi.fn();
    await fake.handlers.session_start({}, { hasUI: true, ui: { notify } });

    expect(notify).toHaveBeenCalledWith(expect.stringContaining("OLLAMA_API_KEY is not set"), "warning");
  });
});
