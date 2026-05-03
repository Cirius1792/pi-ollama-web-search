import { describe, expect, it } from "vitest";
import { normalizeWebSearchResponse } from "../src/normalize.js";

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
