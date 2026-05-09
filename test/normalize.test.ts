import { describe, expect, it } from "vitest";
import { normalizeWebFetchResponse, normalizeWebSearchResponse } from "../src/normalize.js";

describe("normalizeWebSearchResponse", () => {
  it("normalizes valid Ollama search results", () => {
    const normalized = normalizeWebSearchResponse({
      results: [
        {
          title: "  Example   Title  ",
          url: " https://example.com/page ",
          content: "Line one\r\nLine two  \n\n\nLine three",
        },
      ],
    });

    expect(normalized).toEqual({
      results: [
        {
          title: "Example Title",
          url: "https://example.com/page",
          content: "Line one\nLine two\n\nLine three",
        },
      ],
    });
  });

  it("accepts empty results", () => {
    expect(normalizeWebSearchResponse({ results: [] })).toEqual({ results: [] });
  });

  it("throws on missing results array", () => {
    expect(() => normalizeWebSearchResponse({})).toThrow("Unexpected Ollama web search response: results must be an array");
  });

  it("throws on invalid result fields", () => {
    expect(() =>
      normalizeWebSearchResponse({
        results: [{ title: "Title", url: "https://example.com", content: 42 }],
      }),
    ).toThrow("Unexpected Ollama web search response: result 1 content must be a string");
  });
});

describe("normalizeWebFetchResponse", () => {
  it("normalizes valid web fetch response", () => {
    expect(
      normalizeWebFetchResponse({
        title: "  Ollama  ",
        content: "Line 1\r\nLine 2\n\n\nLine 3",
        links: [" https://ollama.com/ ", "https://ollama.com/models"],
      }),
    ).toEqual({
      title: "Ollama",
      content: "Line 1\nLine 2\n\nLine 3",
      links: ["https://ollama.com/", "https://ollama.com/models"],
    });
  });

  it("accepts empty links", () => {
    expect(
      normalizeWebFetchResponse({
        title: "Ollama",
        content: "Content",
        links: [],
      }),
    ).toEqual({
      title: "Ollama",
      content: "Content",
      links: [],
    });
  });

  it("accepts omitted links and defaults to []", () => {
    expect(
      normalizeWebFetchResponse({
        title: "Ollama",
        content: "Content",
      }),
    ).toEqual({
      title: "Ollama",
      content: "Content",
      links: [],
    });
  });

  it("accepts null links and defaults to []", () => {
    expect(
      normalizeWebFetchResponse({
        title: "Ollama",
        content: "Content",
        links: null,
      }),
    ).toEqual({
      title: "Ollama",
      content: "Content",
      links: [],
    });
  });

  it("throws when links contains non-strings", () => {
    expect(() =>
      normalizeWebFetchResponse({
        title: "Ollama",
        content: "Content",
        links: ["https://ollama.com/", 42],
      }),
    ).toThrow("Unexpected Ollama web fetch response: links must contain only strings");
  });



  it("throws when links is present but not an array (object)", () => {
    expect(() =>
      normalizeWebFetchResponse({
        title: "Ollama",
        content: "Content",
        links: { url: "https://ollama.com" },
      }),
    ).toThrow("Unexpected Ollama web fetch response: links must be an array");
  });

  it("throws when links is present but not an array (string)", () => {
    expect(() =>
      normalizeWebFetchResponse({
        title: "Ollama",
        content: "Content",
        links: "https://ollama.com",
      }),
    ).toThrow("Unexpected Ollama web fetch response: links must be an array");
  });

  it("throws when links is present but not an array (number)", () => {
    expect(() =>
      normalizeWebFetchResponse({
        title: "Ollama",
        content: "Content",
        links: 42,
      }),
    ).toThrow("Unexpected Ollama web fetch response: links must be an array");
  });
});
