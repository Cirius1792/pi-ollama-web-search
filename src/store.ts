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
  results: SearchRetrievalResultMetadata[];
}

export interface StoredSearchContent {
  kind: "search";
  ref: string;
  query: string;
  maxResults: number;
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

interface ReplaySearchIdentity {
  url: string;
  occurrence: number;
}

interface StoredSearchReplayMetadata {
  ref: string;
  query: string;
  maxResults: number;
  resultIdentities: ReplaySearchIdentity[];
}

interface StoredCacheEntry {
  value: StoredSearchContent;
  retainedBytes: number;
}

const DEFAULT_SEARCH_CONTENT_CACHE_MAX_BYTES = 1_000_000;

function createOpaqueRefToken(): string {
  return randomBytes(12).toString("base64url");
}

function buildSearchReplayIdentities(payload: NormalizedSearchResponse): ReplaySearchIdentity[] {
  const seenByUrl = new Map<string, number>();

  return payload.results.map((result) => {
    const nextOccurrence = (seenByUrl.get(result.url) ?? 0) + 1;
    seenByUrl.set(result.url, nextOccurrence);

    return {
      url: result.url,
      occurrence: nextOccurrence,
    };
  });
}

function calculatePayloadRetainedBytes(payload: NormalizedSearchResponse): number {
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
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === "AbortError" || candidate.code === "ABORT_ERR";
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

function replayIdentityKey(identity: ReplaySearchIdentity): string {
  return `${identity.url}\u0000${String(identity.occurrence)}`;
}

function buildReplayLookup(replayedPayload: NormalizedSearchResponse): Map<string, NormalizedSearchResult> {
  const replayLookup = new Map<string, NormalizedSearchResult>();
  const replayUrlOccurrences = new Map<string, number>();

  for (const result of replayedPayload.results) {
    const nextOccurrence = (replayUrlOccurrences.get(result.url) ?? 0) + 1;
    replayUrlOccurrences.set(result.url, nextOccurrence);
    replayLookup.set(replayIdentityKey({ url: result.url, occurrence: nextOccurrence }), result);
  }

  return replayLookup;
}

function findFirstMissingReplayIdentityIndex(
  replayLookup: Map<string, NormalizedSearchResult>,
  metadata: StoredSearchReplayMetadata,
): number | undefined {
  for (let index = 0; index < metadata.resultIdentities.length; index += 1) {
    const identity = metadata.resultIdentities[index];
    if (!replayLookup.has(replayIdentityKey(identity))) {
      return index;
    }
  }

  return undefined;
}

function remapReplayPayloadByIdentity(
  replayLookup: Map<string, NormalizedSearchResult>,
  metadata: StoredSearchReplayMetadata,
): NormalizedSearchResponse {
  const remappedResults = metadata.resultIdentities.map((identity, index) => {
    const replayedResult = replayLookup.get(replayIdentityKey(identity));
    if (!replayedResult) {
      throw new Error(
        `Unable to reconstruct original result ${String(index + 1)} for URL ${identity.url} (occurrence ${String(identity.occurrence)}) during replay.`,
      );
    }

    return replayedResult;
  });

  return {
    results: remappedResults,
  };
}

export function createFullContentRef(_kind: "search"): string {
  return `ws_s_${createOpaqueRefToken()}`;
}

export function createSearchContentStore(options?: {
  maxRetainedBytes?: number;
  replaySearch?: (params: { query: string; maxResults: number; signal?: AbortSignal }) => Promise<NormalizedSearchResponse>;
}) {
  const maxRetainedBytes = options?.maxRetainedBytes ?? DEFAULT_SEARCH_CONTENT_CACHE_MAX_BYTES;
  const replaySearch = options?.replaySearch;

  if (!Number.isFinite(maxRetainedBytes) || maxRetainedBytes <= 0) {
    throw new Error("maxRetainedBytes must be greater than 0.");
  }

  const replayMetadataStore = new Map<string, StoredSearchReplayMetadata>();
  const payloadCache = new Map<string, StoredCacheEntry>();
  let retainedBytes = 0;

  function removeCachedPayload(ref: string): void {
    const existing = payloadCache.get(ref);
    if (!existing) {
      return;
    }

    retainedBytes -= existing.retainedBytes;
    payloadCache.delete(ref);
  }

  function touchCachedPayload(ref: string): StoredCacheEntry | undefined {
    const existing = payloadCache.get(ref);
    if (!existing) {
      return undefined;
    }

    payloadCache.delete(ref);
    payloadCache.set(ref, existing);

    return existing;
  }

  function enforceCacheByteBudget(newestRef: string): void {
    while (retainedBytes > maxRetainedBytes && payloadCache.size > 0) {
      const oldestRef = payloadCache.keys().next().value as string | undefined;
      if (!oldestRef) {
        return;
      }

      if (payloadCache.size === 1 && oldestRef === newestRef) {
        return;
      }

      removeCachedPayload(oldestRef);
    }
  }

  function cachePayload(input: { ref: string; query: string; maxResults: number; payload: NormalizedSearchResponse }): void {
    removeCachedPayload(input.ref);

    const value: StoredSearchContent = {
      kind: "search",
      ref: input.ref,
      query: input.query,
      maxResults: input.maxResults,
      payload: input.payload,
    };

    const cachedEntry: StoredCacheEntry = {
      value,
      retainedBytes: calculatePayloadRetainedBytes(input.payload),
    };

    payloadCache.set(input.ref, cachedEntry);
    retainedBytes += cachedEntry.retainedBytes;

    enforceCacheByteBudget(input.ref);
  }

  function rememberSearchContent(input: { ref: string; query: string; maxResults: number; payload: NormalizedSearchResponse }): void {
    replayMetadataStore.set(input.ref, {
      ref: input.ref,
      query: input.query,
      maxResults: input.maxResults,
      resultIdentities: buildSearchReplayIdentities(input.payload),
    });

    cachePayload(input);
  }

  function getStoredSearchContent(ref: string): StoredSearchContent | undefined {
    return touchCachedPayload(ref)?.value;
  }

  async function readSearchContent(input: ReadStoredSearchContentParams): Promise<ReadStoredSearchContentResult> {
    validateInlineIntegerInput("Offset", input.offset, 0);
    validateInlineIntegerInput("maxChars", input.maxChars, 1);

    const metadata = replayMetadataStore.get(input.ref);
    if (!metadata) {
      throw new Error(`No stored content found for ref ${input.ref}.`);
    }

    if (!Number.isInteger(input.resultIndex) || input.resultIndex < 1 || input.resultIndex > metadata.resultIdentities.length) {
      throw new Error(
        `Search result index ${String(input.resultIndex)} is out of range. Valid range is 1-${metadata.resultIdentities.length}.`,
      );
    }

    input.signal?.throwIfAborted();

    const cached = touchCachedPayload(input.ref)?.value;
    if (cached) {
      const selected = cached.payload.results[input.resultIndex - 1];
      if (!selected) {
        throw new Error(
          `Stored payload for ref ${input.ref} is missing result ${String(input.resultIndex)}. Clear refs and rerun search.`,
        );
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

      const replayedPayload = await replaySearch({
        query: metadata.query,
        maxResults: metadata.maxResults,
        signal: input.signal,
      });

      input.signal?.throwIfAborted();

      const targetIdentity = metadata.resultIdentities[input.resultIndex - 1];
      const replayLookup = buildReplayLookup(replayedPayload);
      const remappedResult = replayLookup.get(replayIdentityKey(targetIdentity));

      if (!remappedResult) {
        throw new Error(
          `Unable to reconstruct original result ${String(input.resultIndex)} for URL ${targetIdentity.url} (occurrence ${String(targetIdentity.occurrence)}) during replay.`,
        );
      }

      const missingReplayIndex = findFirstMissingReplayIdentityIndex(replayLookup, metadata);
      if (missingReplayIndex === undefined) {
        const remappedPayload = remapReplayPayloadByIdentity(replayLookup, metadata);
        cachePayload({
          ref: metadata.ref,
          query: metadata.query,
          maxResults: metadata.maxResults,
          payload: remappedPayload,
        });
      }

      return {
        text: sliceByOffsetAndMaxChars(getSearchSectionText(remappedResult, input.section), input.offset ?? 0, input.maxChars),
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
    payloadCache.clear();
    retainedBytes = 0;
  }

  function clearSearchContentStore(): void {
    replayMetadataStore.clear();
    clearCachedSearchPayloads();
  }

  return {
    rememberSearchContent,
    getStoredSearchContent,
    readSearchContent,
    clearCachedSearchPayloads,
    clearSearchContentStore,
  };
}

export function buildSearchRetrievalMetadata(payload: NormalizedSearchResponse): SearchRetrievalMetadata {
  return {
    kind: "search",
    results: payload.results.map((result, index) => ({
      resultIndex: index + 1,
      sections: {
        title: { totalChars: result.title.length },
        url: { totalChars: result.url.length },
        content: { totalChars: result.content.length },
      },
    })),
  };
}
