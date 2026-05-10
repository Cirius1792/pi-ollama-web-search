import { afterEach, describe, expect, it } from "vitest";
import { runOllamaWebReadFull } from "../src/read-full.js";
import { clearFullContentStore, createFullContentRef, rememberSearchContent } from "../src/store.js";

describe("runOllamaWebReadFull", () => {
  afterEach(() => {
    clearFullContentStore();
  });

  it("rejects invalid section values explicitly", () => {
    const ref = createFullContentRef("search");
    rememberSearchContent({
      ref,
      query: "test query",
      maxResults: 5,
      payload: {
        results: [{ title: "One", url: "https://example.com/one", content: "First content" }],
      },
    });

    expect(() => runOllamaWebReadFull({ ref, section: "summary" as any, resultIndex: 1 })).toThrow(
      "section must be one of: title, url, content.",
    );
  });
});
