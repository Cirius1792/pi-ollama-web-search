import { describe, expect, it } from "vitest";
import { formatSearchResults } from "../src/format.js";

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
