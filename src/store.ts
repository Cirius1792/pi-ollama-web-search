import { randomBytes } from "node:crypto";
import type { NormalizedSearchResponse, NormalizedSearchResult } from "./normalize.js";

export interface SearchRetrievalSectionMetadata {
  totalChars: number;
}

export interface SearchRetrievalResultMetadata {
  resultIndex: number;
  sections: {
    title: SearchRetrievalSectionMetadata;
    url: SearchRetrievalSectionMetadata;
    content: SearchRetrievalSectionMetadata;
  };
}

export interface SearchRetrievalMetadata {
  kind: "search";
  replay: {
    query: string;
    maxResults: number;
    originalResultUrls: string[];
  };
  results: SearchRetrievalResultMetadata[];
}

export interface StoredSearchRetrievalBase {
  kind: "search";
  ref: string;
  query: string;
  maxResults: number;
}

export interface StoredSearchReplay extends StoredSearchRetrievalBase {
  originalResultUrls: string[];
}

export interface StoredSearchContent extends StoredSearchRetrievalBase {
  payload: NormalizedSearchResponse;
}

export interface ReadStoredSearchContentParams {
  ref: string;
  resultIndex: number;
  section: "title" | "url" | "content";
  offset?: number;
  maxChars?: number;
  signal?: AbortSignal;
}

export interface ReadStoredSearchContentResult {
  text: string;
  details: {
    ref: string;
    kind: "search";
    section: "title" | "url" | "content";
    resultIndex: number;
    servedFrom: "cache" | "replay";
  };
}

export const SEARCH_CONTENT_STORE_MAX_BYTES = 1_000_000;
export const SEARCH_CONTENT_STORE_MAX_ENTRIES = 256;

interface StoredSearchEntry {
  replay: StoredSearchReplay;
  payload?: NormalizedSearchResponse;
  retainedBytes: number;
}

function createOpaqueRefToken(): string {
  return randomBytes(12).toString("base64url");
}

function buildStoredSearchReplay(input: {
  ref: string;
  query: string;
  maxResults: number;
  payload: NormalizedSearchResponse;
  originalResultUrls?: string[];
}): StoredSearchReplay {
  return {
    kind: "search",
    ref: input.ref,
    query: input.query,
    maxResults: input.maxResults,
    originalResultUrls: input.originalResultUrls ?? input.payload.results.map((result) => result.url),
  };
}

function toStoredSearchContent(entry: StoredSearchEntry): StoredSearchContent | undefined {
  if (!entry.payload) {
    return undefined;
  }

  return {
    kind: "search",
    ref: entry.replay.ref,
    query: entry.replay.query,
    maxResults: entry.replay.maxResults,
    payload: entry.payload,
  };
}

function getRetainedBytes(payload: NormalizedSearchResponse): number {
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

function validateInlineIntegerInput(name: string, value: number | undefined, minimum: number): void {
  if (value === undefined) {
    return;
  }

  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}.`);
  }
}

function getSearchSectionText(result: NormalizedSearchResult, section: "title" | "url" | "content"): string {
  return section === "title" ? result.title : section === "url" ? result.url : result.content;
}

function sliceByOffsetAndMaxChars(value: string, offset: number, maxChars?: number): string {
  if (maxChars === undefined) {
    return value.slice(offset);
  }

  return value.slice(offset, offset + maxChars);
}

function isAbortLikeError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError") ||
    (!!error && typeof error === "object" && (error as { code?: unknown }).code === "ABORT_ERR")
  );
}

function getErrorReason(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return "Unknown replay error";
}

function getOriginalSearchResultIdentity(originalResultUrls: string[], resultIndex: number): { url: string; occurrence: number } {
  const targetUrl = originalResultUrls[resultIndex - 1];
  let occurrence = 0;

  for (let index = 0; index < resultIndex; index += 1) {
    if (originalResultUrls[index] === targetUrl) {
      occurrence += 1;
    }
  }

  return {
    url: targetUrl,
    occurrence,
  };
}

function getMappedSearchResult(
  payload: NormalizedSearchResponse,
  originalResultUrls: string[],
  resultIndex: number,
): NormalizedSearchResult {
  const { url, occurrence } = getOriginalSearchResultIdentity(originalResultUrls, resultIndex);
  let matchedOccurrence = 0;

  for (const result of payload.results) {
    if (result.url !== url) {
      continue;
    }

    matchedOccurrence += 1;
    if (matchedOccurrence === occurrence) {
      return result;
    }
  }

  throw new Error(`Unable to reconstruct original result ${String(resultIndex)} for URL ${url} (occurrence ${String(occurrence)}) during replay.`);
}

export function createFullContentRef(_kind: "search"): string {
  return `ws_s_${createOpaqueRefToken()}`;
}

export function createSearchContentStore(options?: {
  maxRetainedBytes?: number;
  replaySearch?: (params: { query: string; maxResults: number; signal?: AbortSignal }) => Promise<NormalizedSearchResponse>;
}) {
  const maxRetainedBytes = options?.maxRetainedBytes ?? SEARCH_CONTENT_STORE_MAX_BYTES;
  const replaySearch = options?.replaySearch;
  const contentStore = new Map<string, StoredSearchEntry>();
  let totalRetainedBytes = 0;

  if (!Number.isFinite(maxRetainedBytes) || maxRetainedBytes <= 0) {
    throw new Error("maxRetainedBytes must be greater than 0.");
  }

  function touchEntry(ref: string, entry: StoredSearchEntry): void {
    contentStore.delete(ref);
    contentStore.set(ref, entry);
  }

  function evictPayload(entry: StoredSearchEntry): void {
    if (!entry.payload || entry.retainedBytes === 0) {
      return;
    }

    totalRetainedBytes = Math.max(0, totalRetainedBytes - entry.retainedBytes);
    entry.payload = undefined;
    entry.retainedBytes = 0;
  }

  function evictOldestEntry(): void {
    const oldestRef = contentStore.keys().next().value;
    if (!oldestRef) {
      return;
    }

    const oldestEntry = contentStore.get(oldestRef);
    if (oldestEntry) {
      evictPayload(oldestEntry);
    }

    contentStore.delete(oldestRef);
  }

  function enforceStoreLimits(newestRef: string): void {
    while (contentStore.size > SEARCH_CONTENT_STORE_MAX_ENTRIES) {
      evictOldestEntry();
    }

    if (totalRetainedBytes <= maxRetainedBytes) {
      return;
    }

    for (const [ref, entry] of contentStore) {
      if (ref === newestRef) {
        continue;
      }

      evictPayload(entry);
      if (totalRetainedBytes <= maxRetainedBytes) {
        return;
      }
    }
  }

  function rememberSearchContent(input: {
    ref: string;
    query: string;
    maxResults: number;
    payload: NormalizedSearchResponse;
    originalResultUrls?: string[];
  }): void {
    const replay = buildStoredSearchReplay(input);
    const retainedBytes = getRetainedBytes(input.payload);
    const existingEntry = contentStore.get(input.ref);

    if (existingEntry) {
      evictPayload(existingEntry);
    }

    const entry: StoredSearchEntry = {
      replay,
      payload: input.payload,
      retainedBytes,
    };

    totalRetainedBytes += retainedBytes;
    touchEntry(input.ref, entry);
    enforceStoreLimits(input.ref);
  }

  function getStoredSearchContent(ref: string): StoredSearchContent | undefined {
    const entry = contentStore.get(ref);
    if (!entry?.payload) {
      return undefined;
    }

    touchEntry(ref, entry);
    return toStoredSearchContent(entry);
  }

  function getStoredSearchReplay(ref: string): StoredSearchReplay | undefined {
    const entry = contentStore.get(ref);
    if (!entry) {
      return undefined;
    }

    touchEntry(ref, entry);
    return entry.replay;
  }

  async function readSearchContent(input: ReadStoredSearchContentParams): Promise<ReadStoredSearchContentResult> {
    validateInlineIntegerInput("Offset", input.offset, 0);
    validateInlineIntegerInput("maxChars", input.maxChars, 1);

    const entry = contentStore.get(input.ref);
    if (!entry) {
      throw new Error(`No stored content found for ref ${input.ref}.`);
    }

    if (
      !Number.isInteger(input.resultIndex) ||
      input.resultIndex < 1 ||
      input.resultIndex > entry.replay.originalResultUrls.length
    ) {
      throw new Error(
        `Search result index ${String(input.resultIndex)} is out of range. Valid range is 1-${entry.replay.originalResultUrls.length}.`,
      );
    }

    input.signal?.throwIfAborted();

    if (entry.payload) {
      touchEntry(input.ref, entry);

      let selected: NormalizedSearchResult;
      try {
        selected = getMappedSearchResult(entry.payload, entry.replay.originalResultUrls, input.resultIndex);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`No stored content found for ref ${input.ref}. ${message}`);
      }

      return {
        text: sliceByOffsetAndMaxChars(getSearchSectionText(selected, input.section), input.offset ?? 0, input.maxChars),
        details: {
          ref: input.ref,
          kind: "search",
          section: input.section,
          resultIndex: input.resultIndex,
          servedFrom: "cache",
        },
      };
    }

    try {
      input.signal?.throwIfAborted();

      if (!replaySearch) {
        throw new Error("Search replay is not configured.");
      }

      const replayed = await replaySearch({
        query: entry.replay.query,
        maxResults: entry.replay.maxResults,
        signal: input.signal,
      });

      input.signal?.throwIfAborted();

      const selected = getMappedSearchResult(replayed, entry.replay.originalResultUrls, input.resultIndex);

      rememberSearchContent({
        ref: entry.replay.ref,
        query: entry.replay.query,
        maxResults: entry.replay.maxResults,
        payload: replayed,
        originalResultUrls: entry.replay.originalResultUrls,
      });

      return {
        text: sliceByOffsetAndMaxChars(getSearchSectionText(selected, input.section), input.offset ?? 0, input.maxChars),
        details: {
          ref: input.ref,
          kind: "search",
          section: input.section,
          resultIndex: input.resultIndex,
          servedFrom: "replay",
        },
      };
    } catch (error) {
      if (isAbortLikeError(error)) {
        throw error;
      }

      throw new Error(`No stored content found for ref ${input.ref}. Replay also failed: ${getErrorReason(error)}`, {
        cause: error,
      });
    }
  }

  function clearCachedSearchPayloads(): void {
    for (const entry of contentStore.values()) {
      evictPayload(entry);
    }
    totalRetainedBytes = 0;
  }

  function clearSearchContentStore(): void {
    contentStore.clear();
    totalRetainedBytes = 0;
  }

  return {
    rememberSearchContent,
    getStoredSearchContent,
    getStoredSearchReplay,
    readSearchContent,
    clearCachedSearchPayloads,
    clearSearchContentStore,
  };
}

export function buildSearchRetrievalMetadata(input: {
  payload: NormalizedSearchResponse;
  query: string;
  maxResults: number;
}): SearchRetrievalMetadata {
  return {
    kind: "search",
    replay: {
      query: input.query,
      maxResults: input.maxResults,
      originalResultUrls: input.payload.results.map((result) => result.url),
    },
    results: input.payload.results.map((result, index) => ({
      resultIndex: index + 1,
      sections: {
        title: { totalChars: result.title.length },
        url: { totalChars: result.url.length },
        content: { totalChars: result.content.length },
      },
    })),
  };
}
