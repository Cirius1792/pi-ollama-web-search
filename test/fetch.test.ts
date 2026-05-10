import { describe, expect, it, vi } from "vitest";
import { getMissingApiKeyMessage } from "../src/config.js";
import { runOllamaWebFetch } from "../src/fetch.js";

describe("runOllamaWebFetch", () => {
  it("fails before network calls when API key is missing", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      runOllamaWebFetch("https://ollama.com", {
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
          title: " Ollama ",
          content: "Cloud models",
          links: [" https://ollama.com/ "],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const result = await runOllamaWebFetch(" ollama.com ", {
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
      title: "Ollama",
      content: "Cloud models",
      links: ["https://ollama.com/"],
      truncated: false,
    });
    expect((result.normalized as any).targets.title.remainingChars).toBe(0);
    expect(result.formatted).toContain("Fetched page:");
  });

  it("trims url and rejects blank input", async () => {
    await expect(
      runOllamaWebFetch("   ", {
        config: {
          apiKey: "test-key",
          devMode: false,
          searchEndpoint: "https://example.test/api/web_search",
          fetchEndpoint: "https://example.test/api/web_fetch",
          maxResults: 5,
          maxOutputChars: 50_000,
        },
      }),
    ).rejects.toThrow("Fetch URL must not be empty.");
  });

  it("uses content-first truncation and returns actionable target metadata", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          title: "Fetch Result",
          content: "x".repeat(400),
          links: ["https://example.com/1", "https://example.com/2"],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const result = await runOllamaWebFetch("https://example.com/page", {
      config: {
        apiKey: "test-key",
        devMode: false,
        searchEndpoint: "https://example.test/api/web_search",
        fetchEndpoint: "https://example.test/api/web_fetch",
        maxResults: 5,
        maxOutputChars: 260,
      },
      fetchImpl,
    });

    expect(result.formatted).toContain("Title: Fetch Result");
    expect(result.formatted).toContain("[1] https://example.com/1");
    expect(result.formatted).toContain("[2] https://example.com/2");
    expect(result.formatted).toContain("[Output truncated to 260 characters");

    expect((result.normalized as any).truncated).toBe(true);
    expect((result.normalized as any).targets.title.visibleChars).toBe("Fetch Result".length);
    expect((result.normalized as any).targets.links.visibleChars).toBeGreaterThan(0);
    expect((result.normalized as any).targets.content.remainingChars).toBeGreaterThan(0);
    expect((result.normalized as any).targets.content.recommendedRetrievalMode).toBe("inline");
  });
});
