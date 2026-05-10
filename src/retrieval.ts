import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { NormalizedFetchResponse } from "./normalize.js";

export const FETCH_RETRIEVAL_SECTIONS = ["title", "content", "links"] as const;

export type FetchRetrievalSection = (typeof FETCH_RETRIEVAL_SECTIONS)[number];

export interface FetchRetrievalTargetMetadata {
  section: FetchRetrievalSection;
  fullContentRef: string;
}

export interface FetchRetrievalMetadata {
  target: "fetch";
  sections: FetchRetrievalSection[];
  targets: {
    title: FetchRetrievalTargetMetadata;
    content: FetchRetrievalTargetMetadata;
    links: FetchRetrievalTargetMetadata;
  };
}

export interface FetchRetrievalRecord extends NormalizedFetchResponse {
  fullContentRef: string;
  retrieval: FetchRetrievalMetadata;
}

export interface ReadFullFetchParams {
  fullContentRef: string;
  section: FetchRetrievalSection;
  mode?: "inline" | "file";
  offset?: number;
  maxChars?: number;
  outputPath?: string;
  signal?: AbortSignal;
}

export interface ReadFullInlineResult {
  mode: "inline";
  text: string;
  details: {
    mode: "inline";
    target: "fetch";
    section: FetchRetrievalSection;
    fullContentRef: string;
    offset: number;
    maxChars?: number;
    totalChars: number;
    returnedChars: number;
  };
}

export interface ReadFullFileResult {
  mode: "file";
  details: {
    mode: "file";
    target: "fetch";
    section: FetchRetrievalSection;
    fullContentRef: string;
    outputPath: string;
    charsWritten: number;
  };
}

export type ReadFullFetchResult = ReadFullInlineResult | ReadFullFileResult;

export const FETCH_RETRIEVAL_STORE_MAX_ENTRIES = 256;
export const FETCH_RETRIEVAL_STORE_MAX_BYTES = 1_000_000;

interface StoredFetchPayload {
  payload: NormalizedFetchResponse;
  retainedBytes: number;
}

export interface FetchRetrievalStore {
  registerFetchRetrieval(payload: NormalizedFetchResponse): FetchRetrievalRecord;
  clearFetchRetrievalStore(): void;
  readFullFetchContent(params: ReadFullFetchParams): Promise<ReadFullFetchResult>;
}

function createOpaqueFetchRef(): string {
  return `fetch:${randomBytes(12).toString("hex")}`;
}

function measureRetainedBytes(payload: NormalizedFetchResponse): number {
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

function getSectionText(payload: NormalizedFetchResponse, section: FetchRetrievalSection): string {
  if (section === "title") return payload.title;
  if (section === "content") return payload.content;
  return payload.links.join("\n");
}

function validateNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
}

function validatePositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
}

export function createFetchRetrievalStore(): FetchRetrievalStore {
  const fetchRetrievalStore = new Map<string, StoredFetchPayload>();
  let fetchRetrievalStoreBytes = 0;

  function evictOldestFetchRecord(): void {
    const oldestRef = fetchRetrievalStore.keys().next().value;
    if (!oldestRef) return;

    const removed = fetchRetrievalStore.get(oldestRef);
    if (removed) {
      fetchRetrievalStoreBytes = Math.max(0, fetchRetrievalStoreBytes - removed.retainedBytes);
    }
    fetchRetrievalStore.delete(oldestRef);
  }

  function enforceFetchStoreLimit(retainRef?: string): void {
    while (
      fetchRetrievalStore.size > FETCH_RETRIEVAL_STORE_MAX_ENTRIES ||
      (fetchRetrievalStoreBytes > FETCH_RETRIEVAL_STORE_MAX_BYTES && (!retainRef || fetchRetrievalStore.size > 1))
    ) {
      evictOldestFetchRecord();
    }
  }

  function requireRefPayload(fullContentRef: string): NormalizedFetchResponse {
    const trimmedRef = fullContentRef.trim();
    if (!trimmedRef) {
      throw new Error("fullContentRef must not be empty.");
    }

    if (!trimmedRef.startsWith("fetch:")) {
      throw new Error("fullContentRef must reference a fetch result.");
    }

    const stored = fetchRetrievalStore.get(trimmedRef);
    if (!stored) {
      throw new Error(`No stored full content found for ref: ${trimmedRef}`);
    }

    return stored.payload;
  }

  function registerFetchRetrieval(payload: NormalizedFetchResponse): FetchRetrievalRecord {
    let fullContentRef = createOpaqueFetchRef();
    while (fetchRetrievalStore.has(fullContentRef)) {
      fullContentRef = createOpaqueFetchRef();
    }

    const retainedBytes = measureRetainedBytes(payload);
    fetchRetrievalStore.set(fullContentRef, { payload, retainedBytes });
    fetchRetrievalStoreBytes += retainedBytes;
    enforceFetchStoreLimit(fullContentRef);

    return {
      ...payload,
      fullContentRef,
      retrieval: {
        target: "fetch",
        sections: [...FETCH_RETRIEVAL_SECTIONS],
        targets: {
          title: { section: "title", fullContentRef },
          content: { section: "content", fullContentRef },
          links: { section: "links", fullContentRef },
        },
      },
    };
  }

  function clearFetchRetrievalStore(): void {
    fetchRetrievalStore.clear();
    fetchRetrievalStoreBytes = 0;
  }

  async function readFullFetchContent(params: ReadFullFetchParams): Promise<ReadFullFetchResult> {
    params.signal?.throwIfAborted();

    const payload = requireRefPayload(params.fullContentRef);
    const sectionText = getSectionText(payload, params.section);
    const mode = params.mode ?? "inline";

    if (mode === "file") {
      const outputPath = join(tmpdir(), `pi-ollama-web-search-${randomBytes(12).toString("hex")}-${params.section}.txt`);

      params.signal?.throwIfAborted();
      await mkdir(dirname(outputPath), { recursive: true });
      params.signal?.throwIfAborted();
      await writeFile(outputPath, sectionText, { encoding: "utf8", signal: params.signal });

      return {
        mode: "file",
        details: {
          mode: "file",
          target: "fetch",
          section: params.section,
          fullContentRef: params.fullContentRef,
          outputPath,
          charsWritten: sectionText.length,
        },
      };
    }

    const offset = params.offset ?? 0;
    validateNonNegativeInteger("offset", offset);

    if (params.maxChars !== undefined) {
      validatePositiveInteger("maxChars", params.maxChars);
    }

    const slicedText = params.maxChars === undefined ? sectionText.slice(offset) : sectionText.slice(offset, offset + params.maxChars);

    return {
      mode: "inline",
      text: slicedText,
      details: {
        mode: "inline",
        target: "fetch",
        section: params.section,
        fullContentRef: params.fullContentRef,
        offset,
        maxChars: params.maxChars,
        totalChars: sectionText.length,
        returnedChars: slicedText.length,
      },
    };
  }

  return {
    registerFetchRetrieval,
    clearFetchRetrievalStore,
    readFullFetchContent,
  };
}

const defaultFetchRetrievalStore = createFetchRetrievalStore();

export const registerFetchRetrieval = defaultFetchRetrievalStore.registerFetchRetrieval;
export const clearFetchRetrievalStore = defaultFetchRetrievalStore.clearFetchRetrievalStore;
export const readFullFetchContent = defaultFetchRetrievalStore.readFullFetchContent;
