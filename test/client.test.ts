import { afterEach, describe, expect, it } from "vitest";
import { OllamaWebSearchError, searchOllamaWeb } from "../src/client.js";
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
      name: "OllamaWebSearchError",
      code: "http_error",
      status: 401,
    });
  });

  it("throws a typed error for malformed JSON", async () => {
    server = await startMockServer(() => ({ body: "not json" }));

    await expect(
      searchOllamaWeb({ endpoint: `${server.url}/api/web_search`, apiKey: "test-key", query: "test", maxResults: 5 }),
    ).rejects.toMatchObject({
      name: "OllamaWebSearchError",
      code: "invalid_json",
    });
  });

  it("wraps network failures", async () => {
    await expect(
      searchOllamaWeb({ endpoint: "http://127.0.0.1:1/api/web_search", apiKey: "test-key", query: "test", maxResults: 5 }),
    ).rejects.toBeInstanceOf(OllamaWebSearchError);
  });
});
