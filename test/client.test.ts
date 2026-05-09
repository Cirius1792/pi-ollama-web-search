import { afterEach, describe, expect, it } from "vitest";
import { fetchOllamaWeb, OllamaWebError, searchOllamaWeb } from "../src/client.js";
import { startMockServer, type MockServer } from "./helpers/mock-server.js";

let server: MockServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("searchOllamaWeb", () => {
  it("posts the expected request and returns parsed JSON", async () => {
    server = await startMockServer((request) => {
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/api/web_search");
      expect(request.headers.authorization).toBe("Bearer test-key");
      expect(request.headers["content-type"]).toContain("application/json");
      expect(JSON.parse(request.body)).toEqual({ query: "what is ollama?", max_results: 5 });

      return {
        body: JSON.stringify({
          results: [{ title: "Ollama", url: "https://ollama.com", content: "Content" }],
        }),
      };
    });

    await expect(
      searchOllamaWeb({
        endpoint: `${server.url}/api/web_search`,
        apiKey: "test-key",
        query: "what is ollama?",
        maxResults: 5,
      }),
    ).resolves.toEqual({ results: [{ title: "Ollama", url: "https://ollama.com", content: "Content" }] });
  });

  it("throws a typed error for non-2xx responses", async () => {
    server = await startMockServer(() => ({ status: 401, body: JSON.stringify({ error: "unauthorized" }) }));

    await expect(
      searchOllamaWeb({ endpoint: `${server.url}/api/web_search`, apiKey: "bad-key", query: "test", maxResults: 5 }),
    ).rejects.toMatchObject({
      name: "OllamaWebError",
      code: "http_error",
      status: 401,
    });
  });

  it("throws a typed error for malformed JSON", async () => {
    server = await startMockServer(() => ({ body: "not json" }));

    await expect(
      searchOllamaWeb({ endpoint: `${server.url}/api/web_search`, apiKey: "test-key", query: "test", maxResults: 5 }),
    ).rejects.toMatchObject({
      name: "OllamaWebError",
      code: "invalid_json",
    });
  });

  it("wraps network failures", async () => {
    await expect(
      searchOllamaWeb({ endpoint: "http://127.0.0.1:1/api/web_search", apiKey: "test-key", query: "test", maxResults: 5 }),
    ).rejects.toBeInstanceOf(OllamaWebError);
  });

  it("re-throws AbortError from fetch without wrapping", async () => {
    const abortError = new DOMException("The operation was aborted.", "AbortError");
    const fetchImpl = async () => {
      throw abortError;
    };

    await expect(
      searchOllamaWeb({
        endpoint: "http://127.0.0.1:1/api/web_search",
        apiKey: "test-key",
        query: "test",
        maxResults: 5,
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).rejects.toBe(abortError);
  });

  it("re-throws AbortError when response.text() aborts (not wrapped)", async () => {
    const abortError = new DOMException("The operation was aborted.", "AbortError");
    const fetchImpl = async () => {
      return {
        ok: true,
        status: 200,
        text: async () => {
          throw abortError;
        },
      } as unknown as Response;
    };

    await expect(
      searchOllamaWeb({
        endpoint: "http://127.0.0.1:1/api/web_search",
        apiKey: "test-key",
        query: "test",
        maxResults: 5,
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).rejects.toBe(abortError);
  });
});

describe("fetchOllamaWeb", () => {
  it("posts the expected request and returns parsed JSON", async () => {
    server = await startMockServer((request) => {
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/api/web_fetch");
      expect(request.headers.authorization).toBe("Bearer test-key");
      expect(request.headers["content-type"]).toContain("application/json");
      expect(JSON.parse(request.body)).toEqual({ url: "ollama.com" });

      return {
        body: JSON.stringify({
          title: "Ollama",
          content: "Cloud models are now available...",
          links: ["https://ollama.com/"],
        }),
      };
    });

    await expect(
      fetchOllamaWeb({
        endpoint: `${server.url}/api/web_fetch`,
        apiKey: "test-key",
        url: "ollama.com",
      }),
    ).resolves.toEqual({
      title: "Ollama",
      content: "Cloud models are now available...",
      links: ["https://ollama.com/"],
    });
  });

  it("throws a typed error for non-2xx responses", async () => {
    server = await startMockServer(() => ({ status: 403, body: JSON.stringify({ error: "forbidden" }) }));

    await expect(
      fetchOllamaWeb({ endpoint: `${server.url}/api/web_fetch`, apiKey: "bad-key", url: "https://ollama.com" }),
    ).rejects.toMatchObject({
      name: "OllamaWebError",
      code: "http_error",
      status: 403,
    });
  });

  it("wraps network failures", async () => {
    await expect(fetchOllamaWeb({ endpoint: "http://127.0.0.1:1/api/web_fetch", apiKey: "test-key", url: "test" })).rejects.toBeInstanceOf(
      OllamaWebError,
    );
  });

  it("re-throws AbortError from fetch without wrapping", async () => {
    const abortError = new DOMException("The operation was aborted.", "AbortError");
    const fetchImpl = async () => {
      throw abortError;
    };

    await expect(
      fetchOllamaWeb({
        endpoint: "http://127.0.0.1:1/api/web_fetch",
        apiKey: "test-key",
        url: "https://example.com",
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).rejects.toBe(abortError);
  });

  it("re-throws AbortError when response.text() aborts (not wrapped)", async () => {
    const abortError = new DOMException("The operation was aborted.", "AbortError");
    const fetchImpl = async () => {
      return {
        ok: true,
        status: 200,
        text: async () => {
          throw abortError;
        },
      } as unknown as Response;
    };

    await expect(
      fetchOllamaWeb({
        endpoint: "http://127.0.0.1:1/api/web_fetch",
        apiKey: "test-key",
        url: "https://example.com",
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).rejects.toBe(abortError);
  });
});
