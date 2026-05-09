import { beforeEach, describe, expect, it, vi } from "vitest";
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

describe("extension", () => {
  it("registers search and fetch production tools", () => {
    const fake = createFakePi();
    extension(fake.pi as any);

    expect(fake.pi.registerTool).toHaveBeenCalledTimes(2);
    expect(fake.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["ollama_web_search", "ollama_web_fetch"]));
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
});
