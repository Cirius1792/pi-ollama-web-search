import { fetchOllamaWeb } from "./client.js";
import { getMissingApiKeyMessage, type OllamaSearchConfig } from "./config.js";
import { formatFetchResult } from "./format.js";
import { normalizeWebFetchResponse, type NormalizedFetchResponse } from "./normalize.js";

export interface RunOllamaWebFetchOptions {
  config: OllamaSearchConfig;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface RunOllamaWebFetchResult {
  formatted: string;
  normalized: NormalizedFetchResponse;
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
  const formatted = formatFetchResult(normalized, { maxOutputChars: options.config.maxOutputChars });

  return { formatted, normalized };
}
