import { describe, expect, it } from "vitest";
import { formatFetchResult, formatSearchResults } from "../src/format.js";

describe("formatSearchResults", () => {
  it("formats search results as readable text", () => {
    const text = formatSearchResults(
      {
        results: [
          {
            title: "First Result",
            url: "https://example.com/first",
            content: "First result content.",
          },
          {
            title: "Second Result",
            url: "https://example.com/second",
            content: "Second result content.",
          },
        ],
      },
      { maxOutputChars: 10_000 },
    );

    expect(text).toContain("Search results:");
    expect(text).toContain("[1] First Result");
    expect(text).toContain("URL: https://example.com/first");
    expect(text).toContain("First result content.");
    expect(text).toContain("[2] Second Result");
  });

  it("returns a clear successful message for empty results", () => {
    expect(formatSearchResults({ results: [] }, { maxOutputChars: 10_000 })).toBe("No results found.");
  });

  it("truncates only when the high safety cap is exceeded", () => {
    const text = formatSearchResults(
      {
        results: [
          {
            title: "Large Result",
            url: "https://example.com/large",
            content: "x".repeat(500),
          },
        ],
      },
      { maxOutputChars: 180 },
    );

    expect(text.length).toBeLessThanOrEqual(180);
    expect(text).toContain("[Output truncated to 180 characters");
  });
});

describe("formatFetchResult", () => {
  it("formats fetch result with title content and links", () => {
    const text = formatFetchResult(
      {
        title: "Ollama",
        content: "Main content",
        links: ["https://ollama.com/", "https://ollama.com/models"],
      },
      { maxOutputChars: 10_000 },
    );

    expect(text).toContain("Fetched page:");
    expect(text).toContain("Title: Ollama");
    expect(text).toContain("Content:");
    expect(text).toContain("Links:");
    expect(text).toContain("[1] https://ollama.com/");
    expect(text).toContain("[2] https://ollama.com/models");
  });

  it("formats empty links clearly", () => {
    const text = formatFetchResult(
      {
        title: "Ollama",
        content: "Main content",
        links: [],
      },
      { maxOutputChars: 10_000 },
    );

    expect(text).toContain("Links:");
    expect(text).toContain("No links found.");
  });

  it("truncates fetch output when cap is exceeded", () => {
    const text = formatFetchResult(
      {
        title: "Large",
        content: "x".repeat(500),
        links: ["https://example.com/1", "https://example.com/2"],
      },
      { maxOutputChars: 180 },
    );

    expect(text.length).toBeLessThanOrEqual(180);
    expect(text).toContain("[Output truncated to 180 characters");
  });

  it("preserves links when content is truncated", () => {
    const text = formatFetchResult(
      {
        title: "Large Content Page",
        content: "x".repeat(1000),
        links: ["https://example.com/1", "https://example.com/2"],
      },
      { maxOutputChars: 500 },
    );

    expect(text).toContain("Links:");
    expect(text).toContain("[1] https://example.com/1");
    expect(text).toContain("[2] https://example.com/2");
  });
});
