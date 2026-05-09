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

    expect(result.normalized).toEqual({
      title: "Ollama",
      content: "Cloud models",
      links: ["https://ollama.com/"],
    });
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
});
