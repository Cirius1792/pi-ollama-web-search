import { getMissingApiKeyMessage, type OllamaSearchConfig } from "./config.js";
import { searchOllamaWeb } from "./client.js";
import { formatSearchResultsWithMetadata, type SearchTruncationMetadata } from "./format.js";
import { normalizeWebSearchResponse } from "./normalize.js";

export interface RunOllamaWebSearchOptions {
  config: OllamaSearchConfig;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface SearchResultDetails {
  truncated: boolean;
  maxOutputChars: number;
  omittedResultCount: number;
  results: Array<{
    title: string;
    url: string;
    content: string;
    targets: SearchTruncationMetadata["results"][number]["targets"];
  }>;
}

export interface RunOllamaWebSearchResult {
  formatted: string;
  normalized: SearchResultDetails;
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
    endpoint: options.config.searchEndpoint,
    apiKey: options.config.apiKey,
    query: trimmedQuery,
    maxResults: options.config.maxResults,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
  });

  const normalized = normalizeWebSearchResponse(raw);
  const formattedResult = formatSearchResultsWithMetadata(normalized, { maxOutputChars: options.config.maxOutputChars });

  return {
    formatted: formattedResult.text,
    normalized: {
      truncated: formattedResult.truncation.truncated,
      maxOutputChars: formattedResult.truncation.maxOutputChars,
      omittedResultCount: formattedResult.truncation.omittedResultCount,
      results: normalized.results.map((result, index) => ({
        ...result,
        targets: formattedResult.truncation.results[index].targets,
      })),
    },
  };
}

export function formatOllamaWebError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
