import { describe, expect, it, vi } from "vitest";
import { getMissingApiKeyMessage } from "../src/config.js";
import { formatOllamaWebError, runOllamaWebSearch } from "../src/search.js";

describe("runOllamaWebSearch", () => {
  it("fails before network calls when API key is missing", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      runOllamaWebSearch("test", {
        config: {
          apiKey: undefined,
          devMode: false,
          searchEndpoint: "https://example.invalid/api/web_search",
          fetchEndpoint: "https://example.invalid/api/web_fetch",
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
        searchEndpoint: "https://example.test/api/web_search",
        fetchEndpoint: "https://example.test/api/web_fetch",
        maxResults: 5,
        maxOutputChars: 50_000,
      },
      fetchImpl,
    });

    expect(result.normalized).toMatchObject({
      truncated: false,
      results: [{ title: "Ollama", url: "https://ollama.com", content: "Cloud models" }],
    });
    expect((result.normalized as any).results[0].targets.content.remainingChars).toBe(0);
    expect(result.formatted).toContain("[1] Ollama");
  });

  it("trims query and rejects blank input", async () => {
    await expect(
      runOllamaWebSearch("   ", {
        config: {
          apiKey: "test-key",
          devMode: false,
          searchEndpoint: "https://example.test/api/web_search",
          fetchEndpoint: "https://example.test/api/web_fetch",
          maxResults: 5,
          maxOutputChars: 50_000,
        },
      }),
    ).rejects.toThrow("Search query must not be empty.");
  });

  it("uses result-aware truncation and returns metadata for omitted results", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            {
              title: "First",
              url: "https://example.com/first",
              content: "a".repeat(220),
            },
            {
              title: "Second",
              url: "https://example.com/second",
              content: "b".repeat(180),
            },
            {
              title: "Third",
              url: "https://example.com/third",
              content: "c".repeat(180),
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const result = await runOllamaWebSearch("example", {
      config: {
        apiKey: "test-key",
        devMode: false,
        searchEndpoint: "https://example.test/api/web_search",
        fetchEndpoint: "https://example.test/api/web_fetch",
        maxResults: 5,
        maxOutputChars: 360,
      },
      fetchImpl,
    });

    expect(result.formatted).toContain("[1] First");
    expect(result.formatted).toContain("URL: https://example.com/first");
    expect(result.formatted).not.toContain("[2] Second");
    expect(result.formatted).toContain("Additional search results were omitted from visible output");
    expect(result.formatted).toContain("[Output truncated to 360 characters");

    expect((result.normalized as any).truncated).toBe(true);
    expect((result.normalized as any).results).toHaveLength(3);
    const contentRemaining = (result.normalized as any).results.map((entry: any) => entry.targets.content.remainingChars);
    expect(contentRemaining.some((remaining: number) => remaining > 0)).toBe(true);
    expect((result.normalized as any).results[2].targets.title.visibleChars).toBe(0);
    expect((result.normalized as any).results[2].targets.url.visibleChars).toBe(0);
  });
});

describe("formatOllamaWebError", () => {
  it("formats ordinary errors", () => {
    expect(formatOllamaWebError(new Error("boom"))).toBe("boom");
  });

  it("formats unknown thrown values", () => {
    expect(formatOllamaWebError("bad value")).toBe("bad value");
  });
});
