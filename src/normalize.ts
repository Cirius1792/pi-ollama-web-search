export interface NormalizedSearchResult {
  title: string;
  url: string;
  content: string;
}

export interface NormalizedSearchResponse {
  results: NormalizedSearchResult[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeCompactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeContent(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function requireString(record: Record<string, unknown>, key: "title" | "url" | "content", index: number): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`Unexpected Ollama web search response: result ${index} ${key} must be a string`);
  }
  return value;
}

export function normalizeWebSearchResponse(raw: unknown): NormalizedSearchResponse {
  if (!isRecord(raw) || !Array.isArray(raw.results)) {
    throw new Error("Unexpected Ollama web search response: results must be an array");
  }

  return {
    results: raw.results.map((item, itemIndex) => {
      const resultNumber = itemIndex + 1;
      if (!isRecord(item)) {
        throw new Error(`Unexpected Ollama web search response: result ${resultNumber} must be an object`);
      }

      return {
        title: normalizeCompactText(requireString(item, "title", resultNumber)),
        url: normalizeCompactText(requireString(item, "url", resultNumber)),
        content: normalizeContent(requireString(item, "content", resultNumber)),
      };
    }),
  };
}
