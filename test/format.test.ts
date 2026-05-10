import { describe, expect, it } from "vitest";
import { formatFetchResult, formatSearchResults, formatSearchResultsWithMetadata } from "../src/format.js";

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

  it("avoids partial title/url metadata when truncating search output", () => {
    const result = formatSearchResultsWithMetadata(
      {
        results: [
          {
            title: "First",
            url: "https://example.com/first",
            content: "a".repeat(120),
          },
          {
            title: "Second",
            url: "https://example.com/second",
            content: "b".repeat(120),
          },
          {
            title: "Third",
            url: "https://example.com/third",
            content: "c".repeat(120),
          },
        ],
      },
      { maxOutputChars: 370 },
    );

    expect(result.text.length).toBeLessThanOrEqual(370);
    expect(result.text).toContain("[Output truncated to 370 characters");
    expect(result.text).toContain("Additional search results were omitted from visible output");

    expect(result.text).not.toContain("[2] S");
    expect(result.text).not.toContain("[3] T");

    const second = result.truncation.results[1];
    const third = result.truncation.results[2];
    expect(second.targets.title.visibleChars).toBe(0);
    expect(second.targets.url.visibleChars).toBe(0);
    expect(third.targets.title.visibleChars).toBe(0);
    expect(third.targets.url.visibleChars).toBe(0);
  });

  it("preserves omitted-results messaging when max output is very small", () => {
    const result = formatSearchResultsWithMetadata(
      {
        results: [
          {
            title: "First",
            url: "https://example.com/first",
            content: "a".repeat(40),
          },
          {
            title: "Second",
            url: "https://example.com/second",
            content: "b".repeat(40),
          },
        ],
      },
      { maxOutputChars: 180 },
    );

    expect(result.truncation.omittedResultCount).toBeGreaterThan(0);
    expect(result.text.length).toBeLessThanOrEqual(180);
    expect(result.text).toContain("Additional search results were omitted from visible output");
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
