import { getMissingApiKeyMessage, type OllamaSearchConfig } from "./config.js";
import { searchOllamaWeb } from "./client.js";
import { formatSearchResultsWithMetadata, type SearchTruncationMetadata } from "./format.js";
import { normalizeWebSearchResponse, type NormalizedSearchResponse } from "./normalize.js";
import { buildSearchRetrievalMetadata, createFullContentRef, type SearchRetrievalMetadata } from "./store.js";

export interface RunOllamaWebSearchOptions {
  config: OllamaSearchConfig;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  rememberSearchContent?: (input: { ref: string; query: string; maxResults: number; payload: NormalizedSearchResponse }) => void;
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
  fullContentRef?: string;
  truncated: boolean;
  retrieval?: SearchRetrievalMetadata;
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

  if (normalized.results.length === 0) {
    return {
      formatted: "No results found.",
      normalized: {
        truncated: false,
        maxOutputChars: options.config.maxOutputChars,
        omittedResultCount: 0,
        results: [],
      },
      truncated: false,
    };
  }

  const fullContentRef = createFullContentRef("search");
  options.rememberSearchContent?.({
    ref: fullContentRef,
    query: trimmedQuery,
    maxResults: options.config.maxResults,
    payload: normalized,
  });

  const retrieval = buildSearchRetrievalMetadata(normalized);
  let truncated = false;
  const formattedResult = formatSearchResultsWithMetadata(normalized, {
    maxOutputChars: options.config.maxOutputChars,
    fullContentRef,
    onTruncate: () => {
      truncated = true;
    },
  });

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
    fullContentRef,
    truncated,
    retrieval,
  };
}

export function formatOllamaWebError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
