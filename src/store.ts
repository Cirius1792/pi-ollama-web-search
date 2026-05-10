import { randomBytes } from "node:crypto";
import type { NormalizedFetchResponse, NormalizedSearchResponse } from "./normalize.js";

export type FullContentRefKind = "search" | "fetch";

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

export interface StoredFetchContent {
  kind: "fetch";
  ref: string;
  url: string;
  payload: NormalizedFetchResponse;
}

export type StoredFullContent = StoredSearchContent | StoredFetchContent;

const FULL_CONTENT_STORE_MAX_ENTRIES = 128;
const FULL_CONTENT_STORE_TTL_MS = 15 * 60 * 1000;

interface StoredEntry {
  value: StoredFullContent;
  expiresAtMs: number;
}

const contentStore = new Map<string, StoredEntry>();

function pruneExpiredEntries(nowMs: number): void {
  for (const [ref, entry] of contentStore) {
    if (entry.expiresAtMs <= nowMs) {
      contentStore.delete(ref);
    }
  }
}

function enforceMaxEntries(): void {
  while (contentStore.size > FULL_CONTENT_STORE_MAX_ENTRIES) {
    const oldestRef = contentStore.keys().next().value;
    if (!oldestRef) {
      return;
    }
    contentStore.delete(oldestRef);
  }
}

function rememberContent(entry: StoredFullContent): void {
  const nowMs = Date.now();
  pruneExpiredEntries(nowMs);

  contentStore.delete(entry.ref);
  contentStore.set(entry.ref, {
    value: entry,
    expiresAtMs: nowMs + FULL_CONTENT_STORE_TTL_MS,
  });

  enforceMaxEntries();
}

function createOpaqueRefToken(): string {
  return randomBytes(12).toString("base64url");
}

export function createFullContentRef(kind: FullContentRefKind): string {
  return kind === "search" ? `ws_s_${createOpaqueRefToken()}` : `ws_f_${createOpaqueRefToken()}`;
}

export function rememberSearchContent(input: { ref: string; query: string; maxResults: number; payload: NormalizedSearchResponse }): void {
  rememberContent({
    kind: "search",
    ref: input.ref,
    query: input.query,
    maxResults: input.maxResults,
    payload: input.payload,
  });
}

export function rememberFetchContent(input: { ref: string; url: string; payload: NormalizedFetchResponse }): void {
  rememberContent({
    kind: "fetch",
    ref: input.ref,
    url: input.url,
    payload: input.payload,
  });
}

export function getStoredFullContent(ref: string): StoredFullContent | undefined {
  const nowMs = Date.now();
  pruneExpiredEntries(nowMs);

  const entry = contentStore.get(ref);
  if (!entry) {
    return undefined;
  }

  contentStore.delete(ref);
  contentStore.set(ref, entry);
  return entry.value;
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

export function clearFullContentStore(): void {
  contentStore.clear();
}
