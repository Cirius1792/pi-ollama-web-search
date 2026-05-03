import { describe, expect, it, vi } from "vitest";
import { getMissingApiKeyMessage } from "../src/config.js";
import { formatSearchError, runOllamaWebSearch } from "../src/search.js";

describe("runOllamaWebSearch", () => {
  it("fails before network calls when API key is missing", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      runOllamaWebSearch("test", {
        config: {
          apiKey: undefined,
          devMode: false,
          endpoint: "https://example.invalid/api/web_search",
          maxResults: 5,
          maxOutputChars: 50_000,
        },
        fetchImpl,
      }),
    ).rejects.toThrow(getMissingApiKeyMessage());

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("runs client, normalizer, and formatter", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [{ title: " Ollama ", url: " https://ollama.com ", content: "Cloud models" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const result = await runOllamaWebSearch("what is ollama?", {
      config: {
        apiKey: "test-key",
        devMode: false,
        endpoint: "https://example.test/api/web_search",
        maxResults: 5,
        maxOutputChars: 50_000,
      },
      fetchImpl,
    });

    expect(result.normalized).toEqual({
      results: [{ title: "Ollama", url: "https://ollama.com", content: "Cloud models" }],
    });
    expect(result.formatted).toContain("[1] Ollama");
  });

  it("trims query and rejects blank input", async () => {
    await expect(
      runOllamaWebSearch("   ", {
        config: {
          apiKey: "test-key",
          devMode: false,
          endpoint: "https://example.test/api/web_search",
          maxResults: 5,
          maxOutputChars: 50_000,
        },
      }),
    ).rejects.toThrow("Search query must not be empty.");
  });
});

describe("formatSearchError", () => {
  it("formats ordinary errors", () => {
    expect(formatSearchError(new Error("boom"))).toBe("boom");
  });

  it("formats unknown thrown values", () => {
    expect(formatSearchError("bad value")).toBe("bad value");
  });
});
