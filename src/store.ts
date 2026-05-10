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

export interface StoredSearchContent {
  kind: "search";
  ref: string;
  query: string;
  maxResults: number;
  payload: NormalizedSearchResponse;
}

const SEARCH_CONTENT_STORE_MAX_ENTRIES = 128;
const SEARCH_CONTENT_STORE_TTL_MS = 15 * 60 * 1000;

interface StoredEntry {
  value: StoredSearchContent;
  expiresAtMs: number;
}

function createOpaqueRefToken(): string {
  return randomBytes(12).toString("base64url");
}

function pruneExpiredEntries(contentStore: Map<string, StoredEntry>, nowMs: number): void {
  for (const [ref, entry] of contentStore) {
    if (entry.expiresAtMs <= nowMs) {
      contentStore.delete(ref);
    }
  }
}

function enforceMaxEntries(contentStore: Map<string, StoredEntry>): void {
  while (contentStore.size > SEARCH_CONTENT_STORE_MAX_ENTRIES) {
    const oldestRef = contentStore.keys().next().value;
    if (!oldestRef) {
      return;
    }
    contentStore.delete(oldestRef);
  }
}

export function createFullContentRef(_kind: "search"): string {
  return `ws_s_${createOpaqueRefToken()}`;
}

export function createSearchContentStore() {
  const contentStore = new Map<string, StoredEntry>();

  function rememberSearchContent(input: { ref: string; query: string; maxResults: number; payload: NormalizedSearchResponse }): void {
    const nowMs = Date.now();
    pruneExpiredEntries(contentStore, nowMs);

    contentStore.delete(input.ref);
    contentStore.set(input.ref, {
      value: {
        kind: "search",
        ref: input.ref,
        query: input.query,
        maxResults: input.maxResults,
        payload: input.payload,
      },
      expiresAtMs: nowMs + SEARCH_CONTENT_STORE_TTL_MS,
    });

    enforceMaxEntries(contentStore);
  }

  function getStoredSearchContent(ref: string): StoredSearchContent | undefined {
    const nowMs = Date.now();
    pruneExpiredEntries(contentStore, nowMs);

    const entry = contentStore.get(ref);
    if (!entry) {
      return undefined;
    }

    contentStore.delete(ref);
    contentStore.set(ref, entry);
    return entry.value;
  }

  function clearSearchContentStore(): void {
    contentStore.clear();
  }

  return {
    rememberSearchContent,
    getStoredSearchContent,
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
