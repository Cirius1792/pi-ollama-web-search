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

    expect(searchTool).toBeDefined();
    expect(readFullTool).toBeDefined();

    const searchResult = await searchTool!.execute("tool-1", { query: "test query" }, undefined);
    const ref = searchResult.details.fullContentRef;

    expect(ref).toMatch(/^ws_s_/);
    expect(searchResult.details.retrieval).toEqual({
      kind: "search",
      results: [
        {
          resultIndex: 1,
          sections: {
            title: { totalChars: 3 },
            url: { totalChars: 23 },
            content: { totalChars: 13 },
          },
        },
        {
          resultIndex: 2,
          sections: {
            title: { totalChars: 3 },
            url: { totalChars: 23 },
            content: { totalChars: 14 },
          },
        },
      ],
    });

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

  it("omits read-full metadata when search returns no results", async () => {
    process.env.OLLAMA_API_KEY = "test-key";

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const fake = createFakePi();
    extension(fake.pi as any);

    const searchTool = fake.tools.find((tool) => tool.name === "ollama_web_search");
    expect(searchTool).toBeDefined();

    const searchResult = await searchTool!.execute("tool-empty", { query: "no hits" }, undefined);

    expect(searchResult.content).toEqual([{ type: "text", text: "No results found." }]);
    expect(searchResult.details).toEqual({ results: [], truncated: false });
    expect(searchResult.details.fullContentRef).toBeUndefined();
    expect(searchResult.details.retrieval).toBeUndefined();
  });

  it("keeps read-full scope search-only in schema and guidance", () => {
    const fake = createFakePi();
    extension(fake.pi as any);

    const readFullTool = fake.tools.find((tool) => tool.name === "ollama_web_read_full");

    expect(readFullTool).toBeDefined();
    expect(readFullTool?.description).toContain("previous web search results");
    expect(readFullTool?.description).not.toContain("fetch");
    expect(readFullTool?.promptSnippet).toContain("search refs");
    expect(readFullTool?.promptGuidelines?.join(" ")).not.toContain("ollama_web_fetch");
    expect(readFullTool?.parameters?.properties?.ref?.description).toContain("ollama_web_search");
    expect(readFullTool?.parameters?.properties?.ref?.description).not.toContain("ollama_web_fetch");

    const sectionOptions = readFullTool?.parameters?.properties?.section?.anyOf ?? [];
    const sectionLiterals = sectionOptions.map((option: { const?: string }) => option.const).filter(Boolean);
    expect(sectionLiterals).toEqual(expect.arrayContaining(["title", "url", "content"]));
    expect(sectionLiterals).not.toContain("links");

    expect(readFullTool?.parameters?.properties?.resultIndex?.type).toBe("integer");
    expect(readFullTool?.parameters?.properties?.resultIndex?.minimum).toBe(1);
    expect(readFullTool?.parameters?.properties?.offset?.type).toBe("integer");
    expect(readFullTool?.parameters?.properties?.offset?.minimum).toBe(0);
    expect(readFullTool?.parameters?.properties?.maxChars?.type).toBe("integer");
    expect(readFullTool?.parameters?.properties?.maxChars?.minimum).toBe(1);
  });

  it("validates search retrieval inputs with explicit errors", async () => {
    process.env.OLLAMA_API_KEY = "test-key";

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes("web_fetch")) {
          return new Response(
            JSON.stringify({
              title: "Fetched",
              content: "Fetched content",
              links: ["https://example.com/alpha"],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        return new Response(
          JSON.stringify({
            results: [
              { title: "One", url: "https://example.com/one", content: "First content" },
              { title: "Two", url: "https://example.com/two", content: "Second content" },
              { title: "Three", url: "https://example.com/three", content: "Third content" },
              { title: "Four", url: "https://example.com/four", content: "Fourth content" },
              { title: "Five", url: "https://example.com/five", content: "Fifth content" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const fake = createFakePi();
    extension(fake.pi as any);

    const searchTool = fake.tools.find((tool) => tool.name === "ollama_web_search");
    const fetchTool = fake.tools.find((tool) => tool.name === "ollama_web_fetch");
    const readFullTool = fake.tools.find((tool) => tool.name === "ollama_web_read_full");

    expect(searchTool).toBeDefined();
    expect(fetchTool).toBeDefined();
    expect(readFullTool).toBeDefined();

    const searchResult = await searchTool!.execute("tool-1", { query: "test query" }, undefined);
    const ref = searchResult.details.fullContentRef;

    await expect(readFullTool!.execute("tool-2", { ref, section: "content" }, undefined)).rejects.toThrow(
      "resultIndex is required for search refs.",
    );

    await expect(readFullTool!.execute("tool-3", { ref, section: "content", resultIndex: 6 }, undefined)).rejects.toThrow(
      "Search result index 6 is out of range. Valid range is 1-5.",
    );

    await expect(readFullTool!.execute("tool-4", { ref, section: "content", resultIndex: 1, offset: -1 }, undefined)).rejects.toThrow(
      "Offset must be an integer greater than or equal to 0.",
    );

    await expect(readFullTool!.execute("tool-5", { ref, section: "content", resultIndex: 1.5 }, undefined)).rejects.toThrow(
      "Search result index 1.5 is out of range. Valid range is 1-5.",
    );

    await expect(readFullTool!.execute("tool-6", { ref, section: "content", resultIndex: 1, offset: 0.5 }, undefined)).rejects.toThrow(
      "Offset must be an integer greater than or equal to 0.",
    );

    await expect(readFullTool!.execute("tool-7", { ref, section: "content", resultIndex: 1, maxChars: 0 }, undefined)).rejects.toThrow(
      "maxChars must be an integer greater than or equal to 1.",
    );

    await expect(readFullTool!.execute("tool-8", { ref, section: "content", resultIndex: 1, maxChars: 1.2 }, undefined)).rejects.toThrow(
      "maxChars must be an integer greater than or equal to 1.",
    );

    await expect(readFullTool!.execute("tool-9", { ref, section: "summary" as any, resultIndex: 1 }, undefined)).rejects.toThrow(
      "section must be one of: title, url, content.",
    );

    const fetchResult = await fetchTool!.execute("tool-10", { url: "https://example.com/fetch" }, undefined);
    expect(fetchResult.details.fullContentRef).toBeUndefined();
  });
});
