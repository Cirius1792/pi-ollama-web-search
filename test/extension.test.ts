import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "../src/index.js";
import packageJson from "../package.json" with { type: "json" };
import { FETCH_RETRIEVAL_STORE_MAX_ENTRIES } from "../src/retrieval.js";

const EXPECTED_GENERATED_CONFIG_VERSION = packageJson.version.split(".").slice(0, 2).join(".");

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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const originalEnv = process.env;

beforeEach(() => {
  process.env = { ...originalEnv };
  delete process.env.OLLAMA_API_KEY;
  delete process.env.PI_OLLAMA_SEARCH_DEV;
  delete process.env.PI_CODING_AGENT_DIR;
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

  it("creates the dedicated global config during extension startup without changing registered tools", async () => {
    const fake = createFakePi();
    const agentDir = await mkdtemp(join(tmpdir(), "pi-ollama-extension-"));

    try {
      process.env.PI_CODING_AGENT_DIR = agentDir;
      extension(fake.pi as any);

      expect(fake.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["ollama_web_search", "ollama_web_fetch", "ollama_web_read_full"]),
      );
      await expect(access(join(agentDir, "pi-ollama-web-search.json"))).resolves.toBeUndefined();
      expect(JSON.parse(await readFile(join(agentDir, "pi-ollama-web-search.json"), "utf8"))).toEqual({
        version: EXPECTED_GENERATED_CONFIG_VERSION,
        default: {
          maxResults: 3,
          maxOutputChars: 12_000,
        },
      });
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("adds local-first guidance for search and fetch workflows", () => {
    const fake = createFakePi();
    extension(fake.pi as any);

    const searchTool = fake.tools.find((tool) => tool.name === "ollama_web_search");
    const fetchTool = fake.tools.find((tool) => tool.name === "ollama_web_fetch");

    expect(searchTool?.promptGuidelines).toEqual(
      expect.arrayContaining([
        expect.stringContaining("latest, current, or recent"),
        expect.stringContaining("compact"),
        expect.stringContaining("context-safe"),
      ]),
    );

    expect(fetchTool?.promptGuidelines).toEqual(
      expect.arrayContaining([
        expect.stringContaining("user provides a URL"),
        expect.stringContaining("after ollama_web_search"),
        expect.stringContaining("fuller page content"),
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
    expect(fetchResult?.details?.retrieval?.replay?.url).toBe("https://example.com");
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
    expect(inlineContentResult?.details?.servedFrom).toBe("cache");
    expect(inlineContentResult?.details?.offset).toBe(0);

    const inlineLinksResult = await readFullTool?.execute(
      "call-2b",
      { ref: fullContentRef, section: "links", offset: 0, maxChars: 10_000 },
      new AbortController().signal,
    );

    expect(inlineLinksResult?.content?.[0]?.text).toBe("https://example.com/a\nhttps://example.com/b");
    expect(inlineLinksResult?.details?.mode).toBe("inline");
    expect(inlineLinksResult?.details?.section).toBe("links");
    expect(inlineLinksResult?.details?.servedFrom).toBe("cache");

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
      expect(fileResult?.details?.servedFrom).toBe("cache");
      expect(fileResult?.details?.temporary).toBe(false);
      expect(fileResult?.details?.outputPath).toBe(join(workspaceDir, "exports/title.txt"));
      expect(await readFile(fileResult?.details?.outputPath, "utf8")).toBe("Example title");

      const tempFileResult = await readFullTool?.execute(
        "call-4",
        { ref: fullContentRef, section: "content", mode: "file" },
        new AbortController().signal,
      );

      tempOutputPath = tempFileResult?.details?.outputPath;
      expect(tempFileResult?.details?.servedFrom).toBe("cache");
      expect(tempFileResult?.details?.temporary).toBe(true);
      expect(await readFile(tempFileResult?.details?.outputPath, "utf8")).toBe("Long content body");
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
      if (tempOutputPath) {
        await rm(tempOutputPath, { force: true });
      }
    }
  });

  it("replays evicted fetch refs for inline and file reads, then serves later reads from cache", async () => {
    process.env.OLLAMA_API_KEY = "test-key";

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            title: "Original title",
            content: "Original content",
            links: ["https://example.com/original"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            title: "Evictor one",
            content: "x".repeat(1_200_000),
            links: ["https://example.com/evictor-1"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            title: "Replay inline title",
            content: "Replay inline content",
            links: ["https://example.com/replay-inline"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            title: "Evictor two",
            content: "y".repeat(1_200_000),
            links: ["https://example.com/evictor-2"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            title: "Replay file title",
            content: "Replay file content",
            links: ["https://example.com/replay-file"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const fake = createFakePi();
    extension(fake.pi as any);

    const fetchTool = fake.tools.find((tool) => tool.name === "ollama_web_fetch");
    const readFullTool = fake.tools.find((tool) => tool.name === "ollama_web_read_full");

    const fetchResult = await fetchTool?.execute("call-fetch-1", { url: "https://example.com/original" }, new AbortController().signal);
    const fullContentRef = fetchResult?.details?.fullContentRef;

    await fetchTool?.execute("call-evict-1", { url: "https://example.com/evict-1" }, new AbortController().signal);

    const inlineReplayResult = await readFullTool?.execute(
      "call-read-inline-replay",
      { ref: fullContentRef, section: "content" },
      new AbortController().signal,
    );

    expect(inlineReplayResult).toEqual({
      content: [{ type: "text", text: "Replay inline content" }],
      details: {
        mode: "inline",
        target: "fetch",
        section: "content",
        fullContentRef,
        servedFrom: "replay",
        offset: 0,
        maxChars: undefined,
        totalChars: "Replay inline content".length,
        returnedChars: "Replay inline content".length,
      },
    });

    await fetchTool?.execute("call-evict-2", { url: "https://example.com/evict-2" }, new AbortController().signal);

    const workspaceDir = await mkdtemp(join(tmpdir(), "pi-ollama-web-search-replay-"));
    try {
      const fileReplayResult = await readFullTool?.execute(
        "call-read-file-replay",
        { ref: fullContentRef, section: "content", mode: "file", path: "exports/replayed.txt" },
        new AbortController().signal,
        undefined,
        { cwd: workspaceDir },
      );

      expect(fileReplayResult?.details).toEqual({
        mode: "file",
        target: "fetch",
        section: "content",
        fullContentRef,
        servedFrom: "replay",
        outputPath: join(workspaceDir, "exports/replayed.txt"),
        charsWritten: "Replay file content".length,
        temporary: false,
        overwritten: false,
      });
      expect(await readFile(fileReplayResult?.details?.outputPath, "utf8")).toBe("Replay file content");

      const cachedInlineResult = await readFullTool?.execute(
        "call-read-inline-cache",
        { ref: fullContentRef, section: "content" },
        new AbortController().signal,
      );

      expect(cachedInlineResult).toEqual({
        content: [{ type: "text", text: "Replay file content" }],
        details: {
          mode: "inline",
          target: "fetch",
          section: "content",
          fullContentRef,
          servedFrom: "cache",
          offset: 0,
          maxChars: undefined,
          totalChars: "Replay file content".length,
          returnedChars: "Replay file content".length,
        },
      });
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }

    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("replays count-evicted fetch refs through the extension", async () => {
    process.env.OLLAMA_API_KEY = "test-key";

    let sawOriginalRequest = false;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { url: string };
      const isReplay = body.url === "https://example.com/original" && sawOriginalRequest;
      sawOriginalRequest ||= body.url === "https://example.com/original";
      const suffix = isReplay ? "replay" : body.url.split("/").at(-1) ?? "unknown";

      return new Response(
        JSON.stringify({
          title: `Title ${suffix}`,
          content: isReplay ? "Replay content after count eviction" : `Content ${suffix}`,
          links: [`https://example.com/${suffix}`],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const fake = createFakePi();
    extension(fake.pi as any);

    const fetchTool = fake.tools.find((tool) => tool.name === "ollama_web_fetch");
    const readFullTool = fake.tools.find((tool) => tool.name === "ollama_web_read_full");

    const fetchResult = await fetchTool?.execute("call-fetch-original", { url: "https://example.com/original" }, new AbortController().signal);
    const fullContentRef = fetchResult?.details?.fullContentRef;

    for (let i = 1; i <= FETCH_RETRIEVAL_STORE_MAX_ENTRIES; i += 1) {
      await fetchTool?.execute(`call-evict-${i}`, { url: `https://example.com/${i}` }, new AbortController().signal);
    }

    const replayed = await readFullTool?.execute(
      "call-read-count-replay",
      { ref: fullContentRef, section: "content" },
      new AbortController().signal,
    );

    expect(replayed).toEqual({
      content: [{ type: "text", text: "Replay content after count eviction" }],
      details: {
        mode: "inline",
        target: "fetch",
        section: "content",
        fullContentRef,
        servedFrom: "replay",
        offset: 0,
        maxChars: undefined,
        totalChars: "Replay content after count eviction".length,
        returnedChars: "Replay content after count eviction".length,
      },
    });

    const cached = await readFullTool?.execute(
      "call-read-count-cache",
      { ref: fullContentRef, section: "content" },
      new AbortController().signal,
    );

    expect(cached?.details?.servedFrom).toBe("cache");
    expect(cached?.content).toEqual([{ type: "text", text: "Replay content after count eviction" }]);
    expect(fetchMock).toHaveBeenCalledTimes(FETCH_RETRIEVAL_STORE_MAX_ENTRIES + 2);
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

  it("fails clearly when fetch replay fails after a cache miss", async () => {
    process.env.OLLAMA_API_KEY = "test-key";

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            title: "Original title",
            content: "Original content",
            links: ["https://example.com/original"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            title: "Evictor",
            content: "x".repeat(1_200_000),
            links: ["https://example.com/evictor"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockRejectedValueOnce(new Error("fetch replay unavailable"));
    vi.stubGlobal("fetch", fetchMock);

    const fake = createFakePi();
    extension(fake.pi as any);

    const fetchTool = fake.tools.find((tool) => tool.name === "ollama_web_fetch");
    const readFullTool = fake.tools.find((tool) => tool.name === "ollama_web_read_full");

    const fetchResult = await fetchTool?.execute("call-fetch", { url: "https://example.com/original" }, new AbortController().signal);
    const fullContentRef = fetchResult?.details?.fullContentRef;

    await fetchTool?.execute("call-evict", { url: "https://example.com/evictor" }, new AbortController().signal);

    await expect(
      readFullTool?.execute("call-read-replay-fail", { ref: fullContentRef, section: "content" }, new AbortController().signal),
    ).rejects.toThrow(
      `No stored full content found for ref: ${fullContentRef}. Replay failed: Failed to reach Ollama Web API: fetch replay unavailable`,
    );
  });

  it("fails clearly when fetch replay returns a malformed payload after a cache miss", async () => {
    process.env.OLLAMA_API_KEY = "test-key";

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            title: "Original title",
            content: "Original content",
            links: ["https://example.com/original"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            title: "Evictor",
            content: "x".repeat(1_200_000),
            links: ["https://example.com/evictor"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            title: "Replay title",
            links: ["https://example.com/replay"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const fake = createFakePi();
    extension(fake.pi as any);

    const fetchTool = fake.tools.find((tool) => tool.name === "ollama_web_fetch");
    const readFullTool = fake.tools.find((tool) => tool.name === "ollama_web_read_full");

    const fetchResult = await fetchTool?.execute("call-fetch", { url: "https://example.com/original" }, new AbortController().signal);
    const fullContentRef = fetchResult?.details?.fullContentRef;

    await fetchTool?.execute("call-evict", { url: "https://example.com/evictor" }, new AbortController().signal);

    await expect(
      readFullTool?.execute("call-read-replay-malformed", { ref: fullContentRef, section: "content" }, new AbortController().signal),
    ).rejects.toThrow(
      `No stored full content found for ref: ${fullContentRef}. Replay failed: Unexpected Ollama web fetch response: content must be a string`,
    );
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
    ).rejects.toThrow(
      `No stored content found for ref ${ref}. Unable to reconstruct original result 2 for URL https://example.com/b (occurrence 1) during replay.`,
    );

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
      `No stored content found for ref ${ref}. Replay also failed: Unable to reconstruct original result 2 for URL https://example.com/a (occurrence 2) during replay.`,
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

  it("replays evicted search refs and preserves the same ref", async () => {
    process.env.OLLAMA_API_KEY = "test-key";

    const queryCallCounts = new Map<string, number>();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
        const payload = JSON.parse(String(init?.body ?? "{}")) as { query?: string };
        const query = payload.query;
        const nextCount = (queryCallCounts.get(query ?? "") ?? 0) + 1;
        queryCallCounts.set(query ?? "", nextCount);

        if (query === "replay query") {
          if (nextCount === 1) {
            return jsonResponse({
              results: [{ title: "Original", url: "https://example.com/a", content: "Original content" }],
            });
          }

          return jsonResponse({
            results: [{ title: "Replayed", url: "https://example.com/a", content: "Replayed content" }],
          });
        }

        if (query === "evict query") {
          return jsonResponse({
            results: [{ title: "Huge", url: "https://example.com/huge", content: "x".repeat(1_200_000) }],
          });
        }

        throw new Error(`Unexpected search query in test: ${String(query)}`);
      }),
    );

    const fake = createFakePi();
    extension(fake.pi as any);

    const searchTool = fake.tools.find((tool) => tool.name === "ollama_web_search");
    const readFullTool = fake.tools.find((tool) => tool.name === "ollama_web_read_full");

    const firstSearch = await searchTool!.execute("tool-search-1", { query: "replay query" }, undefined);
    const ref = firstSearch.details.fullContentRef;

    await searchTool!.execute("tool-search-evict", { query: "evict query" }, undefined);

    const replayed = await readFullTool!.execute("tool-read-replay", { ref, section: "content", resultIndex: 1 }, undefined);
    expect(replayed).toEqual({
      content: [{ type: "text", text: "Replayed content" }],
      details: {
        ref,
        kind: "search",
        section: "content",
        resultIndex: 1,
        servedFrom: "replay",
      },
    });

    const cached = await readFullTool!.execute("tool-read-cached", { ref, section: "content", resultIndex: 1 }, undefined);
    expect(cached.details.ref).toBe(ref);
    expect(cached.details.servedFrom).toBe("cache");
    expect(cached.content[0]?.text).toBe("Replayed content");
  });

  it("supports fetch file mode after replay rebuilds an evicted payload", async () => {
    process.env.OLLAMA_API_KEY = "test-key";

    const urlCallCounts = new Map<string, number>();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
        const payload = JSON.parse(String(init?.body ?? "{}")) as { url?: string };
        const url = payload.url;
        const nextCount = (urlCallCounts.get(url ?? "") ?? 0) + 1;
        urlCallCounts.set(url ?? "", nextCount);

        if (url === "https://example.com/replay-file") {
          if (nextCount === 1) {
            return jsonResponse({
              title: "Original title",
              content: "Original fetch content",
              links: ["https://example.com/replay-file"],
            });
          }

          return jsonResponse({
            title: "Replayed title",
            content: "Replayed fetch content",
            links: ["https://example.com/replay-file"],
          });
        }

        if (url === "https://example.com/evict-fetch") {
          return jsonResponse({
            title: "Huge",
            content: "y".repeat(1_200_000),
            links: ["https://example.com/evict-fetch"],
          });
        }

        throw new Error(`Unexpected fetch url in test: ${String(url)}`);
      }),
    );

    const fake = createFakePi();
    extension(fake.pi as any);

    const fetchTool = fake.tools.find((tool) => tool.name === "ollama_web_fetch");
    const readFullTool = fake.tools.find((tool) => tool.name === "ollama_web_read_full");

    const fetchResult = await fetchTool!.execute("tool-fetch-1", { url: "https://example.com/replay-file" }, new AbortController().signal);
    const fullContentRef = fetchResult.details.fullContentRef;

    await fetchTool!.execute("tool-fetch-evict", { url: "https://example.com/evict-fetch" }, new AbortController().signal);

    const fileResult = await readFullTool!.execute(
      "tool-read-file-replay",
      { ref: fullContentRef, section: "content", mode: "file" },
      new AbortController().signal,
    );

    try {
      expect(fileResult.details.fullContentRef).toBe(fullContentRef);
      expect(fileResult.details.servedFrom).toBe("replay");
      expect(fileResult.details.temporary).toBe(true);
      expect(await readFile(fileResult.details.outputPath, "utf8")).toBe("Replayed fetch content");

      const inlineCached = await readFullTool!.execute(
        "tool-read-inline-after-file",
        { ref: fullContentRef, section: "content" },
        new AbortController().signal,
      );

      expect(inlineCached.details.fullContentRef).toBe(fullContentRef);
      expect(inlineCached.details.servedFrom).toBe("cache");
      expect(inlineCached.content[0]?.text).toBe("Replayed fetch content");
    } finally {
      await rm(fileResult.details.outputPath, { force: true });
    }
  });

  it("fails search replay clearly when URL occurrence mapping cannot be reconstructed", async () => {
    process.env.OLLAMA_API_KEY = "test-key";

    const queryCallCounts = new Map<string, number>();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
        const payload = JSON.parse(String(init?.body ?? "{}")) as { query?: string };
        const query = payload.query;
        const nextCount = (queryCallCounts.get(query ?? "") ?? 0) + 1;
        queryCallCounts.set(query ?? "", nextCount);

        if (query === "duplicate query") {
          if (nextCount === 1) {
            return jsonResponse({
              results: [
                { title: "A1", url: "https://example.com/a", content: "orig-a1" },
                { title: "B1", url: "https://example.com/b", content: "orig-b1" },
                { title: "A2", url: "https://example.com/a", content: "orig-a2" },
              ],
            });
          }

          return jsonResponse({
            results: [
              { title: "A1 replay", url: "https://example.com/a", content: "replay-a1" },
              { title: "B1 replay", url: "https://example.com/b", content: "replay-b1" },
            ],
          });
        }

        if (query === "evict duplicate") {
          return jsonResponse({
            results: [{ title: "Huge", url: "https://example.com/huge", content: "z".repeat(1_200_000) }],
          });
        }

        throw new Error(`Unexpected search query in test: ${String(query)}`);
      }),
    );

    const fake = createFakePi();
    extension(fake.pi as any);

    const searchTool = fake.tools.find((tool) => tool.name === "ollama_web_search");
    const readFullTool = fake.tools.find((tool) => tool.name === "ollama_web_read_full");

    const searchResult = await searchTool!.execute("tool-search-dup", { query: "duplicate query" }, undefined);
    const ref = searchResult.details.fullContentRef;

    await searchTool!.execute("tool-search-evict-dup", { query: "evict duplicate" }, undefined);

    await expect(readFullTool!.execute("tool-read-dup-fail", { ref, section: "content", resultIndex: 3 }, undefined)).rejects.toThrow(
      new RegExp(
        `^No stored content found for ref ${ref.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\. Replay also failed: Unable to reconstruct original result 3 for URL https://example\\.com/a \\(occurrence 2\\) during replay\\.$`,
      ),
    );
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
    const readFullGuidance = readFullTool?.promptGuidelines?.join(" ") ?? "";

    expect(readFullTool).toBeDefined();
    expect(readFullTool?.description).toContain("search or web fetch");
    expect(readFullGuidance).toContain("ollama_web_search or ollama_web_fetch");
    expect(readFullGuidance).toContain("one field at a time");
    expect(readFullGuidance).toContain("mode=file");
    expect(readFullGuidance).toContain("large fetch sections");
    expect(readFullGuidance).toContain(
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

  it("registers search, fetch, and read-full debug commands when dev mode is enabled", () => {
    process.env.PI_OLLAMA_SEARCH_DEV = "1";
    const fake = createFakePi();
    extension(fake.pi as any);

    expect(fake.pi.registerCommand).toHaveBeenCalledWith("ollama-search", expect.any(Object));
    expect(fake.pi.registerCommand).toHaveBeenCalledWith("ollama-fetch", expect.any(Object));
    expect(fake.pi.registerCommand).toHaveBeenCalledWith("ollama-read-full", expect.any(Object));
    expect(fake.commands["ollama-search"].description).toContain("debug");
    expect(fake.commands["ollama-fetch"].description).toContain("debug");
    expect(fake.commands["ollama-read-full"].description).toContain("JSON args");
  });

  it("runs the read-full debug command through the same retrieval flow", async () => {
    process.env.OLLAMA_API_KEY = "test-key";
    process.env.PI_OLLAMA_SEARCH_DEV = "1";

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
    const fetchResult = await fetchTool?.execute("call-1", { url: "https://example.com" }, new AbortController().signal);
    const fullContentRef = fetchResult?.details?.fullContentRef;
    const notify = vi.fn();

    await fake.commands["ollama-read-full"].handler(
      JSON.stringify({ ref: fullContentRef, section: "content" }),
      { signal: new AbortController().signal, ui: { notify } },
    );

    expect(notify).not.toHaveBeenCalled();
    expect(fake.pi.sendMessage).toHaveBeenCalledWith({
      customType: "ollama-web-read-full-debug",
      content: "Body",
      display: true,
      details: {
        mode: "inline",
        target: "fetch",
        section: "content",
        fullContentRef,
        servedFrom: "cache",
        offset: 0,
        maxChars: undefined,
        totalChars: 4,
        returnedChars: 4,
      },
    });
  });

  it("supports file-mode exports through the read-full debug command", async () => {
    process.env.OLLAMA_API_KEY = "test-key";
    process.env.PI_OLLAMA_SEARCH_DEV = "1";

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
    const fetchResult = await fetchTool?.execute("call-1", { url: "https://example.com" }, new AbortController().signal);
    const fullContentRef = fetchResult?.details?.fullContentRef;
    const notify = vi.fn();
    const workspaceDir = await mkdtemp(join(tmpdir(), "pi-ollama-web-search-debug-read-full-"));

    try {
      await fake.commands["ollama-read-full"].handler(
        JSON.stringify({ ref: fullContentRef, section: "content", mode: "file", path: "exports/body.txt" }),
        { cwd: workspaceDir, signal: new AbortController().signal, ui: { notify } },
      );

      expect(notify).not.toHaveBeenCalled();
      expect(fake.pi.sendMessage).toHaveBeenLastCalledWith({
        customType: "ollama-web-read-full-debug",
        content: `Wrote full section to ${join(workspaceDir, "exports/body.txt")}. Delete this file when you no longer need it.`,
        display: true,
        details: {
          mode: "file",
          target: "fetch",
          section: "content",
          fullContentRef,
          servedFrom: "cache",
          outputPath: join(workspaceDir, "exports/body.txt"),
          charsWritten: 4,
          temporary: false,
          overwritten: false,
        },
      });
      expect(await readFile(join(workspaceDir, "exports/body.txt"), "utf8")).toBe("Body");
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("applies model-specific profile overrides during production tool execution", async () => {
    process.env.OLLAMA_API_KEY = "test-key";

    const agentDir = await mkdtemp(join(tmpdir(), "pi-ollama-agent-config-"));

    try {
      process.env.PI_CODING_AGENT_DIR = agentDir;
      await writeFile(
        join(agentDir, "pi-ollama-web-search.json"),
        JSON.stringify({
          default: {
            maxResults: 3,
            maxOutputChars: 120,
          },
          models: {
            "ollama/qwen3:14b": {
              maxResults: 1,
              maxOutputChars: 80,
            },
          },
        }),
        "utf8",
      );

      const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string; max_results?: number; url?: string };

        if (body.query) {
          return jsonResponse({
            results: [
              { title: "One", url: "https://example.com/one", content: "First result" },
              { title: "Two", url: "https://example.com/two", content: "Second result" },
              { title: "Three", url: "https://example.com/three", content: "Third result" },
            ].slice(0, body.max_results),
          });
        }

        return jsonResponse({
          title: "Example page",
          content: "x".repeat(200),
          links: ["https://example.com/a"],
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const fake = createFakePi();
      extension(fake.pi as any);

      const searchTool = fake.tools.find((tool) => tool.name === "ollama_web_search");
      const fetchTool = fake.tools.find((tool) => tool.name === "ollama_web_fetch");

      const ctx = {
        model: {
          provider: "ollama",
          id: "qwen3:14b",
        },
        ui: {
          notify: vi.fn(),
        },
      };

      const searchResult = await searchTool!.execute(
        "tool-search-model-profile",
        { query: "profiled query" },
        new AbortController().signal,
        undefined,
        ctx,
      );
      const fetchResult = await fetchTool!.execute(
        "tool-fetch-model-profile",
        { url: "https://example.com/page" },
        new AbortController().signal,
        undefined,
        ctx,
      );

      expect(searchResult.details.results).toHaveLength(1);
      expect(searchResult.details.maxOutputChars).toBe(80);
      expect(searchResult.details.appliedProfile).toEqual({
        maxResults: 1,
        maxOutputChars: 80,
        origin: {
          kind: "exact",
          selector: "ollama/qwen3:14b",
        },
      });
      expect(fetchResult.details.maxOutputChars).toBe(80);
      expect(fetchResult.details.truncated).toBe(true);
      expect(fetchResult.details.targets.content.recommendedRetrievalMode).toBe("file");
      expect(fetchResult.details.appliedProfile).toEqual({
        maxOutputChars: 80,
        source: "exact",
        matcher: "ollama/qwen3:14b",
      });
      expect(ctx.ui.notify).not.toHaveBeenCalled();
      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}"))).toMatchObject({
        query: "profiled query",
        max_results: 1,
      });
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("exposes the winning pattern selector in search details when a model-family override wins", async () => {
    process.env.OLLAMA_API_KEY = "test-key";

    const agentDir = await mkdtemp(join(tmpdir(), "pi-ollama-agent-config-"));

    try {
      process.env.PI_CODING_AGENT_DIR = agentDir;
      await writeFile(
        join(agentDir, "pi-ollama-web-search.json"),
        JSON.stringify({
          default: {
            maxResults: 3,
            maxOutputChars: 120,
          },
          models: {
            "ollama/qwen*": {
              maxResults: 2,
              maxOutputChars: 90,
            },
            "ollama/qwen3*": {
              maxResults: 1,
              maxOutputChars: 70,
            },
          },
        }),
        "utf8",
      );

      const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { max_results?: number };

        return jsonResponse({
          results: [
            { title: "One", url: "https://example.com/one", content: "First result" },
            { title: "Two", url: "https://example.com/two", content: "Second result" },
          ].slice(0, body.max_results),
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const fake = createFakePi();
      extension(fake.pi as any);

      const searchTool = fake.tools.find((tool) => tool.name === "ollama_web_search");
      const notify = vi.fn();

      const result = await searchTool!.execute(
        "tool-search-pattern-profile",
        { query: "pattern profile query" },
        new AbortController().signal,
        undefined,
        {
          model: {
            provider: "ollama",
            id: "qwen3:14b",
          },
          ui: { notify },
        },
      );

      expect(result.details.results).toHaveLength(1);
      expect(result.details.maxOutputChars).toBe(70);
      expect(result.details.appliedProfile).toEqual({
        maxResults: 1,
        maxOutputChars: 70,
        origin: {
          kind: "pattern",
          selector: "ollama/qwen3*",
        },
      });
      expect(notify).not.toHaveBeenCalled();
      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}"))).toMatchObject({
        query: "pattern profile query",
        max_results: 1,
      });
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("falls back to the default profile and warns when the current model is unavailable", async () => {
    process.env.OLLAMA_API_KEY = "test-key";

    const agentDir = await mkdtemp(join(tmpdir(), "pi-ollama-agent-config-"));

    try {
      process.env.PI_CODING_AGENT_DIR = agentDir;
      await writeFile(
        join(agentDir, "pi-ollama-web-search.json"),
        JSON.stringify({
          default: {
            maxResults: 2,
            maxOutputChars: 70,
          },
          models: {
            "ollama/qwen3:14b": {
              maxResults: 1,
              maxOutputChars: 40,
            },
          },
        }),
        "utf8",
      );

      const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { max_results?: number };

        return jsonResponse({
          results: [
            { title: "One", url: "https://example.com/one", content: "First result" },
            { title: "Two", url: "https://example.com/two", content: "Second result" },
          ].slice(0, body.max_results),
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const fake = createFakePi();
      extension(fake.pi as any);

      const searchTool = fake.tools.find((tool) => tool.name === "ollama_web_search");
      const notify = vi.fn();

      const result = await searchTool!.execute(
        "tool-search-default-profile",
        { query: "default profile query" },
        new AbortController().signal,
        undefined,
        { ui: { notify } },
      );

      expect(result.details.results).toHaveLength(2);
      expect(result.details.maxOutputChars).toBe(70);
      expect(result.details.appliedProfile).toEqual({
        maxResults: 2,
        maxOutputChars: 70,
        origin: {
          kind: "default",
        },
      });
      expect(notify).toHaveBeenCalledWith(
        "Using the default search profile because the current model could not be determined.",
        "warning",
      );
      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}"))).toMatchObject({
        query: "default profile query",
        max_results: 2,
      });
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("applies project-level model overrides during tool execution when ctx.cwd is provided", async () => {
    process.env.OLLAMA_API_KEY = "test-key";

    const agentDir = await mkdtemp(join(tmpdir(), "pi-ollama-agent-config-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "pi-ollama-project-config-"));

    try {
      process.env.PI_CODING_AGENT_DIR = agentDir;
      await writeFile(
        join(agentDir, "pi-ollama-web-search.json"),
        JSON.stringify({
          default: {
            maxResults: 3,
            maxOutputChars: 120,
          },
          models: {
            "ollama/qwen3:14b": {
              maxResults: 2,
              maxOutputChars: 90,
            },
          },
        }),
        "utf8",
      );

      await mkdir(join(projectRoot, ".pi"), { recursive: true });
      await writeFile(
        join(projectRoot, ".pi", "pi-ollama-web-search.json"),
        JSON.stringify({
          models: {
            "ollama/qwen3:14b": {
              maxResults: 1,
              maxOutputChars: 70,
            },
          },
        }),
        "utf8",
      );

      const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string; max_results?: number };

        return jsonResponse({
          results: [
            { title: "One", url: "https://example.com/one", content: "First result" },
            { title: "Two", url: "https://example.com/two", content: "Second result" },
          ].slice(0, body.max_results),
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const fake = createFakePi();
      extension(fake.pi as any);

      const searchTool = fake.tools.find((tool) => tool.name === "ollama_web_search");
      const notify = vi.fn();

      const result = await searchTool!.execute(
        "tool-search-project-override",
        { query: "project override query" },
        new AbortController().signal,
        undefined,
        {
          cwd: projectRoot,
          model: {
            provider: "ollama",
            id: "qwen3:14b",
          },
          ui: { notify },
        },
      );

      expect(result.details.results).toHaveLength(1);
      expect(result.details.maxOutputChars).toBe(70);
      expect(notify).not.toHaveBeenCalled();
      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}"))).toMatchObject({
        query: "project override query",
        max_results: 1,
      });
    } finally {
      await rm(agentDir, { recursive: true, force: true });
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("uses the fallback path and warns when project config is invalid during tool execution", async () => {
    process.env.OLLAMA_API_KEY = "test-key";

    const agentDir = await mkdtemp(join(tmpdir(), "pi-ollama-agent-config-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "pi-ollama-project-config-"));

    try {
      process.env.PI_CODING_AGENT_DIR = agentDir;
      await writeFile(
        join(agentDir, "pi-ollama-web-search.json"),
        JSON.stringify({
          default: {
            maxResults: 2,
            maxOutputChars: 70,
          },
        }),
        "utf8",
      );

      await mkdir(join(projectRoot, ".pi"), { recursive: true });
      await writeFile(join(projectRoot, ".pi", "pi-ollama-web-search.json"), "{\n  invalid json\n", "utf8");

      const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { max_results?: number };

        return jsonResponse({
          results: [
            { title: "One", url: "https://example.com/one", content: "First result" },
            { title: "Two", url: "https://example.com/two", content: "Second result" },
          ].slice(0, body.max_results),
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const fake = createFakePi();
      extension(fake.pi as any);

      const searchTool = fake.tools.find((tool) => tool.name === "ollama_web_search");
      const notify = vi.fn();

      const result = await searchTool!.execute(
        "tool-search-invalid-project-config",
        { query: "invalid project config query" },
        new AbortController().signal,
        undefined,
        {
          cwd: projectRoot,
          model: {
            provider: "ollama",
            id: "qwen3:14b",
          },
          ui: { notify },
        },
      );

      expect(result.details.results).toHaveLength(2);
      expect(result.details.maxOutputChars).toBe(70);
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("Ignoring invalid project config"), "warning");
      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}"))).toMatchObject({
        query: "invalid project config query",
        max_results: 2,
      });
    } finally {
      await rm(agentDir, { recursive: true, force: true });
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("registers a session_start warning for missing API key", async () => {
    const fake = createFakePi();
    extension(fake.pi as any);

    const notify = vi.fn();
    await fake.handlers.session_start({}, { hasUI: true, ui: { notify } });

    expect(notify).toHaveBeenCalledWith(expect.stringContaining("OLLAMA_API_KEY is not set"), "warning");
  });

  it("registers config and missing-key warnings independently on session_start", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-ollama-agent-config-"));

    try {
      process.env.PI_CODING_AGENT_DIR = agentDir;

      const currentMajorVersion = Number.parseInt(packageJson.version.split(".")[0] ?? "0", 10);
      await writeFile(
        join(agentDir, "pi-ollama-web-search.json"),
        JSON.stringify({
          version: `${currentMajorVersion + 1}.0.0`,
          default: {
            maxResults: 4,
            maxOutputChars: 8_000,
          },
        }),
        "utf8",
      );

      const fake = createFakePi();
      extension(fake.pi as any);

      expect(fake.pi.registerTool).toHaveBeenCalledTimes(3);
      expect(fake.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["ollama_web_search", "ollama_web_fetch", "ollama_web_read_full"]),
      );

      const notify = vi.fn();
      await fake.handlers.session_start({}, { hasUI: true, ui: { notify } });

      const warningMessages = notify.mock.calls
        .filter((call) => call[1] === "warning")
        .map((call) => String(call[0]));

      expect(warningMessages.some((message) => message.includes("unsupported major version"))).toBe(true);
      expect(warningMessages.some((message) => message.includes("OLLAMA_API_KEY is not set"))).toBe(true);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("does not block startup on invalid extension config and warns on session_start", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-ollama-agent-config-"));

    try {
      process.env.PI_CODING_AGENT_DIR = agentDir;
      await writeFile(join(agentDir, "pi-ollama-web-search.json"), "{\n  invalid json\n", "utf8");

      const fake = createFakePi();

      expect(() => extension(fake.pi as any)).not.toThrow();
      expect(fake.pi.registerTool).toHaveBeenCalledTimes(3);

      const notify = vi.fn();
      await fake.handlers.session_start({}, { hasUI: true, ui: { notify } });

      const warningMessages = notify.mock.calls
        .filter((call) => call[1] === "warning")
        .map((call) => String(call[0]));

      expect(warningMessages.some((message) => message.includes("Ignoring invalid extension config"))).toBe(true);
      expect(warningMessages.some((message) => message.includes("OLLAMA_API_KEY is not set"))).toBe(true);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });
});
