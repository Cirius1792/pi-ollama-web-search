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

  it("runs client, normalizer, formatter, and retrieval metadata generation", async () => {
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
    expect(result.normalized.results[0].targets.content.remainingChars).toBe(0);
    expect(result.fullContentRef).toMatch(/^ws_s_/);
    expect(result.retrieval).toEqual({
      kind: "search",
      results: [
        {
          resultIndex: 1,
          sections: {
            title: { totalChars: 6 },
            url: { totalChars: 18 },
            content: { totalChars: 12 },
          },
        },
      ],
    });
    expect(result.formatted).toContain("[1] Ollama");
  });

  it("mentions full-content ref in visible output only when truncation happens", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(
        JSON.stringify({
          results: [{ title: "Large", url: "https://example.com", content: "x".repeat(500) }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const truncated = await runOllamaWebSearch("large", {
      config: {
        apiKey: "test-key",
        devMode: false,
        searchEndpoint: "https://example.test/api/web_search",
        fetchEndpoint: "https://example.test/api/web_fetch",
        maxResults: 5,
        maxOutputChars: 180,
      },
      fetchImpl,
    });

    expect(truncated.formatted).toContain("ollama_web_read_full");
    expect(truncated.formatted).toContain(truncated.fullContentRef!);

    const notTruncated = await runOllamaWebSearch("large", {
      config: {
        apiKey: "test-key",
        devMode: false,
        searchEndpoint: "https://example.test/api/web_search",
        fetchEndpoint: "https://example.test/api/web_fetch",
        maxResults: 5,
        maxOutputChars: 10_000,
      },
      fetchImpl,
    });

    expect(notTruncated.formatted).not.toContain(notTruncated.fullContentRef!);
  });

  it("does not advertise full-content retrieval when search returns no results", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await runOllamaWebSearch("no hits", {
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

    expect(result.formatted).toBe("No results found.");
    expect(result.fullContentRef).toBeUndefined();
    expect(result.retrieval).toBeUndefined();
    expect(result.truncated).toBe(false);
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

    expect(result.formatted.length).toBeLessThanOrEqual(360);
    expect(result.formatted).toContain("[1] First");
    expect(result.formatted).toContain("URL: https://example.com/first");
    expect(result.formatted).not.toContain("[2] Second");
    expect(result.formatted).toContain("Additional search results were omitted from visible output");
    expect(result.formatted).toContain("[Output truncated to 360 characters");

    expect(result.normalized.truncated).toBe(true);
    expect(result.normalized.results).toHaveLength(3);
    const contentRemaining = result.normalized.results.map((entry) => entry.targets.content.remainingChars);
    expect(contentRemaining.some((remaining) => remaining > 0)).toBe(true);
    expect(result.normalized.results[2].targets.title.visibleChars).toBe(0);
    expect(result.normalized.results[2].targets.url.visibleChars).toBe(0);

    const nestedTargets = result.normalized.results.map((entry) => entry.targets);
    expect(nestedTargets[0].title.recommendedRetrievalMode).toBe("inline");
    expect(nestedTargets[0].url.recommendedRetrievalMode).toBe("inline");
    expect(nestedTargets[0].content.recommendedRetrievalMode).toBe("inline");
    expect(nestedTargets[1].title.recommendedRetrievalMode).toBe("inline");
    expect(nestedTargets[1].url.recommendedRetrievalMode).toBe("inline");
    expect(nestedTargets[1].content.recommendedRetrievalMode).toBe("inline");
    expect(nestedTargets[2].title.recommendedRetrievalMode).toBe("inline");
    expect(nestedTargets[2].url.recommendedRetrievalMode).toBe("inline");
    expect(nestedTargets[2].content.recommendedRetrievalMode).toBe("inline");
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
