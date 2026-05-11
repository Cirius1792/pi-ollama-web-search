import { fetchOllamaWeb } from "./client.js";
import { getMissingApiKeyMessage, type OllamaSearchConfig } from "./config.js";
import { formatFetchResultWithMetadata, type FetchTruncationMetadata } from "./format.js";
import { normalizeWebFetchResponse, type NormalizedFetchResponse } from "./normalize.js";
import {
  registerFetchRetrieval as registerFetchRetrievalDefault,
  type FetchRetrievalRecord,
  type FetchReplayInput,
  type RegisterFetchRetrievalReplay,
} from "./retrieval.js";

export interface RunOllamaWebFetchOptions {
  config: OllamaSearchConfig;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  registerFetchRetrieval?: (payload: NormalizedFetchResponse, replay?: RegisterFetchRetrievalReplay) => FetchRetrievalRecord;
}

export interface FetchResultDetails extends FetchRetrievalRecord {
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

  const apiKey = options.config.apiKey;

  const raw = await fetchOllamaWeb({
    endpoint: options.config.fetchEndpoint,
    apiKey,
    url: trimmedUrl,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
  });

  const registerFetchRetrieval = options.registerFetchRetrieval ?? registerFetchRetrievalDefault;
  const normalizedPayload = normalizeWebFetchResponse(raw);
  const replay: RegisterFetchRetrievalReplay = {
    url: trimmedUrl,
    replayFetch: async (replayInput: FetchReplayInput, signal?: AbortSignal) =>
      fetchOllamaWeb({
        endpoint: options.config.fetchEndpoint,
        apiKey,
        url: replayInput.url,
        signal,
        fetchImpl: options.fetchImpl,
      }),
  };
  const normalized = registerFetchRetrieval(normalizedPayload, replay);
  const formattedResult = formatFetchResultWithMetadata(normalized, {
    maxOutputChars: options.config.maxOutputChars,
    fullContentRef: normalized.fullContentRef,
  });

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
