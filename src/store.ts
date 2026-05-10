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

const contentStore = new Map<string, StoredFullContent>();
let nextRefId = 1;

function nextRefToken(): string {
  const token = nextRefId.toString(36).padStart(6, "0");
  nextRefId += 1;
  return token;
}

export function createFullContentRef(kind: FullContentRefKind): string {
  return kind === "search" ? `ws_s_${nextRefToken()}` : `ws_f_${nextRefToken()}`;
}

export function rememberSearchContent(input: { ref: string; query: string; maxResults: number; payload: NormalizedSearchResponse }): void {
  contentStore.set(input.ref, {
    kind: "search",
    ref: input.ref,
    query: input.query,
    maxResults: input.maxResults,
    payload: input.payload,
  });
}

export function rememberFetchContent(input: { ref: string; url: string; payload: NormalizedFetchResponse }): void {
  contentStore.set(input.ref, {
    kind: "fetch",
    ref: input.ref,
    url: input.url,
    payload: input.payload,
  });
}

export function getStoredFullContent(ref: string): StoredFullContent | undefined {
  return contentStore.get(ref);
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
