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

  it("fetch + read-full retrieval path supports inline and file modes", async () => {
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

    const outputDir = await mkdtemp(join(tmpdir(), "pi-ollama-web-search-"));
    let generatedOutputPath: string | undefined;
    try {
      const requestedOutputPath = join(outputDir, "title.txt");
      const fileResult = await readFullTool?.execute(
        "call-3",
        { ref: fullContentRef, section: "title", mode: "file", outputPath: requestedOutputPath },
        new AbortController().signal,
      );

      generatedOutputPath = fileResult?.details?.outputPath;

      expect(fileResult?.content?.[0]?.text).toContain("Wrote full section to");
      expect(fileResult?.details?.mode).toBe("file");
      expect(fileResult?.details?.outputPath).not.toBe(requestedOutputPath);
      expect(await readFile(fileResult?.details?.outputPath, "utf8")).toBe("Example title");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
      if (generatedOutputPath) {
        await rm(generatedOutputPath, { force: true });
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

  it("supports read-full schema and guidance for both search and fetch refs", () => {
    const fake = createFakePi();
    extension(fake.pi as any);

    const readFullTool = fake.tools.find((tool) => tool.name === "ollama_web_read_full");

    expect(readFullTool).toBeDefined();
    expect(readFullTool?.description).toContain("search or web fetch");
    expect(readFullTool?.promptGuidelines?.join(" ")).toContain("ollama_web_search or ollama_web_fetch");
    expect(readFullTool?.parameters?.properties?.ref?.description).toContain("ollama_web_search or ollama_web_fetch");

    const sectionOptions = readFullTool?.parameters?.properties?.section?.anyOf ?? [];
    const sectionLiterals = sectionOptions.map((option: { const?: string }) => option.const).filter(Boolean);
    expect(sectionLiterals).toEqual(expect.arrayContaining(["title", "url", "content", "links"]));

    expect(readFullTool?.parameters?.properties?.mode?.anyOf?.map((option: { const?: string }) => option.const)).toEqual(
      expect.arrayContaining(["inline", "file"]),
    );
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

  it("clears stored fetch retrieval refs on session_start", async () => {
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

    const fake = createFakePi();
    extension(fake.pi as any);

    const fetchTool = fake.tools.find((tool) => tool.name === "ollama_web_fetch");
    const readFullTool = fake.tools.find((tool) => tool.name === "ollama_web_read_full");

    const fetchResult = await fetchTool?.execute("call-1", { url: "https://example.com" }, new AbortController().signal);
    const fullContentRef = fetchResult?.details?.fullContentRef;

    await fake.handlers.session_start({}, { hasUI: false, ui: { notify: vi.fn() } });

    await expect(
      readFullTool?.execute("call-2", { fullContentRef, section: "content" }, new AbortController().signal),
    ).rejects.toThrow(`No stored full content found for ref: ${fullContentRef}`);
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
