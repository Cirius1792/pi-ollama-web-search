import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "../src/index.js";

interface RegisteredTool {
  name: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
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

  it("returns a full-content ref from search and reads back one search field by 1-based resultIndex", async () => {
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
    expect(searchResult.details.fullContentRef).toMatch(/^ws_s_/);

    const readResult = await readFullTool!.execute(
      "tool-2",
      { ref: searchResult.details.fullContentRef, section: "url", resultIndex: 2 },
      undefined,
    );

    expect(readResult).toEqual({
      content: [{ type: "text", text: "https://example.com/two" }],
      details: {
        ref: searchResult.details.fullContentRef,
        kind: "search",
        section: "url",
        resultIndex: 2,
        servedFrom: "cache",
      },
    });
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

    await expect(readFullTool!.execute("tool-3", { ref, section: "links", resultIndex: 1 }, undefined)).rejects.toThrow(
      'Section "links" is not valid for search refs.',
    );

    await expect(readFullTool!.execute("tool-4", { ref, section: "content", resultIndex: 6 }, undefined)).rejects.toThrow(
      "Search result index 6 is out of range. Valid range is 1-5.",
    );

    await expect(readFullTool!.execute("tool-5", { ref, section: "content", resultIndex: 1, offset: -1 }, undefined)).rejects.toThrow(
      "Offset must be 0 or greater.",
    );

    const fetchResult = await fetchTool!.execute("tool-6", { url: "https://example.com/fetch" }, undefined);
    await expect(
      readFullTool!.execute("tool-7", { ref: fetchResult.details.fullContentRef, section: "content", resultIndex: 1 }, undefined),
    ).rejects.toThrow("resultIndex is only valid for search refs.");
  });
});
