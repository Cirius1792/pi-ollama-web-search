import { fetchOllamaWeb } from "./client.js";
import { getMissingApiKeyMessage, type OllamaSearchConfig } from "./config.js";
import { formatFetchResultWithMetadata, type FetchTruncationMetadata } from "./format.js";
import { normalizeWebFetchResponse } from "./normalize.js";

export interface RunOllamaWebFetchOptions {
  config: OllamaSearchConfig;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface FetchResultDetails {
  title: string;
  content: string;
  links: string[];
  truncated: boolean;
  maxOutputChars: number;
  targets: FetchTruncationMetadata["targets"];
}

export interface RunOllamaWebFetchResult {
  formatted: string;
  normalized: FetchResultDetails;
}

export async function runOllamaWebFetch(url: string, options: RunOllamaWebFetchOptions): Promise<RunOllamaWebFetchResult> {
  const trimmedUrl = url.trim();
  if (!trimmedUrl) {
    throw new Error("Fetch URL must not be empty.");
  }

  if (!options.config.apiKey) {
    throw new Error(getMissingApiKeyMessage());
  }

  const raw = await fetchOllamaWeb({
    endpoint: options.config.fetchEndpoint,
    apiKey: options.config.apiKey,
    url: trimmedUrl,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
  });

  const normalized = normalizeWebFetchResponse(raw);
  const formattedResult = formatFetchResultWithMetadata(normalized, { maxOutputChars: options.config.maxOutputChars });

  return {
    formatted: formattedResult.text,
    normalized: {
      ...normalized,
      truncated: formattedResult.truncation.truncated,
      maxOutputChars: formattedResult.truncation.maxOutputChars,
      targets: formattedResult.truncation.targets,
    },
  };
}
