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

  it("runs client, normalizer, formatter, and retrieval metadata", async () => {
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
      retrieval: {
        target: "fetch",
        sections: ["title", "content", "links"],
        targets: {
          title: { section: "title" },
          content: { section: "content" },
          links: { section: "links" },
        },
      },
      truncated: false,
    });

    expect(result.normalized.fullContentRef).toMatch(/^fetch:[a-f0-9]{24}$/);
    expect(result.normalized.retrieval.targets.title.fullContentRef).toBe(result.normalized.fullContentRef);
    expect(result.normalized.retrieval.targets.content.fullContentRef).toBe(result.normalized.fullContentRef);
    expect(result.normalized.retrieval.targets.links.fullContentRef).toBe(result.normalized.fullContentRef);
    expect(result.normalized.targets.title.remainingChars).toBe(0);
    expect(result.formatted).toContain("Fetched page:");
  });

  it("returns opaque per-registration fullContentRefs for identical payloads", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            title: "  Ollama  ",
            content: "Cloud models",
            links: [" https://ollama.com/ "],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const first = await runOllamaWebFetch("https://ollama.com", {
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

    const second = await runOllamaWebFetch("https://ollama.com", {
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

    expect(first.normalized.fullContentRef).toMatch(/^fetch:[a-f0-9]{24}$/);
    expect(second.normalized.fullContentRef).toMatch(/^fetch:[a-f0-9]{24}$/);
    expect(first.normalized.fullContentRef).not.toBe(second.normalized.fullContentRef);
  });

  it("forwards trimmed sourceUrl to registerFetchRetrieval", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          title: "Ollama",
          content: "Cloud models",
          links: ["https://ollama.com"],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const registerFetchRetrieval = vi.fn().mockImplementation((payload) => ({
      ...payload,
      fullContentRef: "fetch:aaaaaaaaaaaaaaaaaaaaaaaa",
      retrieval: {
        target: "fetch",
        sections: ["title", "content", "links"],
        targets: {
          title: { section: "title", fullContentRef: "fetch:aaaaaaaaaaaaaaaaaaaaaaaa" },
          content: { section: "content", fullContentRef: "fetch:aaaaaaaaaaaaaaaaaaaaaaaa" },
          links: { section: "links", fullContentRef: "fetch:aaaaaaaaaaaaaaaaaaaaaaaa" },
        },
      },
    }));

    await runOllamaWebFetch(" https://ollama.com/page ", {
      config: {
        apiKey: "test-key",
        devMode: false,
        searchEndpoint: "https://example.test/api/web_search",
        fetchEndpoint: "https://example.test/api/web_fetch",
        maxResults: 5,
        maxOutputChars: 50_000,
      },
      fetchImpl,
      registerFetchRetrieval,
    });

    expect(registerFetchRetrieval).toHaveBeenCalledWith(
      {
        title: "Ollama",
        content: "Cloud models",
        links: ["https://ollama.com"],
      },
      { sourceUrl: "https://ollama.com/page" },
    );
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
    expect(result.formatted).toContain("ollama_web_read_full");

    expect(result.normalized.truncated).toBe(true);
    expect(result.normalized.targets).toEqual({
      title: {
        totalChars: "Fetch Result".length,
        visibleChars: "Fetch Result".length,
        remainingChars: 0,
        recommendedRetrievalMode: "inline",
      },
      content: {
        totalChars: 400,
        visibleChars: 29,
        remainingChars: 371,
        recommendedRetrievalMode: "inline",
      },
      links: {
        totalChars: "[1] https://example.com/1\n[2] https://example.com/2".length,
        visibleChars: "[1] https://example.com/1\n[2] https://example.com/2".length,
        remainingChars: 0,
        recommendedRetrievalMode: "inline",
      },
    });
  });
});
