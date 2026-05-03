import { getMissingApiKeyMessage, type OllamaSearchConfig } from "./config.js";
import { searchOllamaWeb } from "./client.js";
import { formatSearchResults } from "./format.js";
import { normalizeWebSearchResponse, type NormalizedSearchResponse } from "./normalize.js";

export interface RunOllamaWebSearchOptions {
  config: OllamaSearchConfig;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface RunOllamaWebSearchResult {
  formatted: string;
  normalized: NormalizedSearchResponse;
}

export async function runOllamaWebSearch(query: string, options: RunOllamaWebSearchOptions): Promise<RunOllamaWebSearchResult> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    throw new Error("Search query must not be empty.");
  }

  if (!options.config.apiKey) {
    throw new Error(getMissingApiKeyMessage());
  }

  const raw = await searchOllamaWeb({
    endpoint: options.config.endpoint,
    apiKey: options.config.apiKey,
    query: trimmedQuery,
    maxResults: options.config.maxResults,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
  });

  const normalized = normalizeWebSearchResponse(raw);
  const formatted = formatSearchResults(normalized, { maxOutputChars: options.config.maxOutputChars });

  return { formatted, normalized };
}

export function formatSearchError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
