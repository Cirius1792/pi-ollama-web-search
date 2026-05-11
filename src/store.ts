import { randomBytes } from "node:crypto";
import type { NormalizedSearchResponse } from "./normalize.js";

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
}): StoredSearchReplay {
  return {
    kind: "search",
    ref: input.ref,
    query: input.query,
    maxResults: input.maxResults,
    originalResultUrls: input.payload.results.map((result) => result.url),
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

export function createFullContentRef(_kind: "search"): string {
  return `ws_s_${createOpaqueRefToken()}`;
}

export function createSearchContentStore() {
  const contentStore = new Map<string, StoredSearchEntry>();
  let totalRetainedBytes = 0;

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

    if (totalRetainedBytes <= SEARCH_CONTENT_STORE_MAX_BYTES) {
      return;
    }

    for (const [ref, entry] of contentStore) {
      if (ref === newestRef) {
        continue;
      }

      evictPayload(entry);
      if (totalRetainedBytes <= SEARCH_CONTENT_STORE_MAX_BYTES) {
        return;
      }
    }
  }

  function rememberSearchContent(input: {
    ref: string;
    query: string;
    maxResults: number;
    payload: NormalizedSearchResponse;
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

  function clearSearchContentStore(): void {
    contentStore.clear();
    totalRetainedBytes = 0;
  }

  return {
    rememberSearchContent,
    getStoredSearchContent,
    getStoredSearchReplay,
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
