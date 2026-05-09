export interface NormalizedSearchResult {
  title: string;
  url: string;
  content: string;
}

export interface NormalizedSearchResponse {
  results: NormalizedSearchResult[];
}

export interface NormalizedFetchResponse {
  title: string;
  content: string;
  links: string[];
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

export function normalizeWebFetchResponse(raw: unknown): NormalizedFetchResponse {
  if (!isRecord(raw)) {
    throw new Error("Unexpected Ollama web fetch response: response must be an object");
  }

  const { title, content, links } = raw;

  if (typeof title !== "string") {
    throw new Error("Unexpected Ollama web fetch response: title must be a string");
  }

  if (typeof content !== "string") {
    throw new Error("Unexpected Ollama web fetch response: content must be a string");
  }

  let linksArray: string[];
  if (links === undefined) {
    linksArray = [];
  } else if (Array.isArray(links)) {
    if (!links.every((link) => typeof link === "string")) {
      throw new Error("Unexpected Ollama web fetch response: links must contain only strings");
    }
    linksArray = links;
  } else {
    throw new Error("Unexpected Ollama web fetch response: links must be an array");
  }

  return {
    title: normalizeCompactText(title),
    content: normalizeContent(content),
    links: linksArray.map((link) => normalizeCompactText(link)),
  };
}
