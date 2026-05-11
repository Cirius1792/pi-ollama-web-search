import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
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

export interface RegisterFetchRetrievalOptions {
  sourceUrl?: string;
}

export interface ReadFullFetchParams {
  fullContentRef: string;
  section: FetchRetrievalSection;
  mode?: "inline" | "file";
  offset?: number;
  maxChars?: number;
  outputPath?: string;
  overwrite?: boolean;
  cwd?: string;
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
    servedFrom: "cache" | "replay";
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
    servedFrom: "cache" | "replay";
    outputPath: string;
    charsWritten: number;
    temporary: boolean;
    overwritten: boolean;
  };
}

export type ReadFullFetchResult = ReadFullInlineResult | ReadFullFileResult;

export const FETCH_RETRIEVAL_STORE_MAX_ENTRIES = 256;
export const FETCH_RETRIEVAL_STORE_MAX_BYTES = 1_000_000;

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

interface StoredFetchPayload {
  payload: NormalizedFetchResponse;
  retainedBytes: number;
}

interface StoredFetchReplayMetadata {
  sourceUrl?: string;
}

export interface FetchRetrievalStore {
  registerFetchRetrieval(payload: NormalizedFetchResponse, options?: RegisterFetchRetrievalOptions): FetchRetrievalRecord;
  clearCachedFetchPayloads(): void;
  clearFetchRetrievalStore(): void;
  cleanupTemporaryExports(): Promise<void>;
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

function normalizeOutputPath(rawPath: string): string {
  const normalizedSpaces = rawPath.replace(UNICODE_SPACES, " ");
  const withoutAtPrefix = normalizedSpaces.startsWith("@") ? normalizedSpaces.slice(1) : normalizedSpaces;

  if (withoutAtPrefix === "~") {
    return homedir();
  }

  if (withoutAtPrefix.startsWith("~/")) {
    return join(homedir(), withoutAtPrefix.slice(2));
  }

  return withoutAtPrefix;
}

function resolveOutputPath(outputPath: string, cwd: string): string {
  const normalized = normalizeOutputPath(outputPath);
  if (isAbsolute(normalized)) {
    return normalized;
  }
  return resolve(cwd, normalized);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return false;
    }
    throw error;
  }
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

export function createFetchRetrievalStore(options?: {
  replayFetch?: (params: { url: string; signal?: AbortSignal }) => Promise<NormalizedFetchResponse>;
}): FetchRetrievalStore {
  const fetchReplayMetadata = new Map<string, StoredFetchReplayMetadata>();
  const fetchPayloadCache = new Map<string, StoredFetchPayload>();
  let fetchPayloadCacheBytes = 0;
  const temporaryExportRoot = join(tmpdir(), `pi-ollama-web-search-${randomBytes(12).toString("hex")}`);
  let hasTemporaryExports = false;

  function evictOldestFetchRecord(): void {
    const oldestRef = fetchPayloadCache.keys().next().value;
    if (!oldestRef) return;

    const removed = fetchPayloadCache.get(oldestRef);
    if (removed) {
      fetchPayloadCacheBytes = Math.max(0, fetchPayloadCacheBytes - removed.retainedBytes);
    }
    fetchPayloadCache.delete(oldestRef);
  }

  function enforceFetchStoreLimit(retainRef?: string): void {
    while (
      fetchPayloadCache.size > FETCH_RETRIEVAL_STORE_MAX_ENTRIES ||
      (fetchPayloadCacheBytes > FETCH_RETRIEVAL_STORE_MAX_BYTES && (!retainRef || fetchPayloadCache.size > 1))
    ) {
      evictOldestFetchRecord();
    }
  }

  function cacheFetchPayload(fullContentRef: string, payload: NormalizedFetchResponse): void {
    const existing = fetchPayloadCache.get(fullContentRef);
    if (existing) {
      fetchPayloadCacheBytes = Math.max(0, fetchPayloadCacheBytes - existing.retainedBytes);
      fetchPayloadCache.delete(fullContentRef);
    }

    const retainedBytes = measureRetainedBytes(payload);
    fetchPayloadCache.set(fullContentRef, { payload, retainedBytes });
    fetchPayloadCacheBytes += retainedBytes;
    enforceFetchStoreLimit(fullContentRef);
  }

  function requireRefMetadata(fullContentRef: string): { ref: string; metadata: StoredFetchReplayMetadata } {
    const trimmedRef = fullContentRef.trim();
    if (!trimmedRef) {
      throw new Error("fullContentRef must not be empty.");
    }

    if (!trimmedRef.startsWith("fetch:")) {
      throw new Error("fullContentRef must reference a fetch result.");
    }

    const metadata = fetchReplayMetadata.get(trimmedRef);
    if (!metadata) {
      throw new Error(`No stored full content found for ref: ${trimmedRef}`);
    }

    return { ref: trimmedRef, metadata };
  }

  async function getPayloadForRead(
    fullContentRef: string,
    signal?: AbortSignal,
  ): Promise<{ payload: NormalizedFetchResponse; servedFrom: "cache" | "replay" }> {
    const { ref, metadata } = requireRefMetadata(fullContentRef);

    const cached = fetchPayloadCache.get(ref);
    if (cached) {
      fetchPayloadCache.delete(ref);
      fetchPayloadCache.set(ref, cached);
      return {
        payload: cached.payload,
        servedFrom: "cache",
      };
    }

    try {
      signal?.throwIfAborted();

      if (!metadata.sourceUrl?.trim()) {
        throw new Error(`Replay metadata for ref ${ref} is missing source URL.`);
      }

      if (!options?.replayFetch) {
        throw new Error("fetch replay is not configured.");
      }

      const replayedPayload = await options.replayFetch({
        url: metadata.sourceUrl,
        signal,
      });

      cacheFetchPayload(ref, replayedPayload);

      return {
        payload: replayedPayload,
        servedFrom: "replay",
      };
    } catch (error) {
      if (isAbortLikeError(error)) {
        throw error;
      }

      throw new Error(`No stored full content found for ref: ${ref}. Replay also failed: ${getErrorReason(error)}`, {
        cause: error,
      });
    }
  }

  function registerFetchRetrieval(payload: NormalizedFetchResponse, registerOptions?: RegisterFetchRetrievalOptions): FetchRetrievalRecord {
    let fullContentRef = createOpaqueFetchRef();
    while (fetchReplayMetadata.has(fullContentRef)) {
      fullContentRef = createOpaqueFetchRef();
    }

    const sourceUrl = registerOptions?.sourceUrl?.trim();

    fetchReplayMetadata.set(fullContentRef, {
      sourceUrl: sourceUrl ? sourceUrl : undefined,
    });

    cacheFetchPayload(fullContentRef, payload);

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

  function clearCachedFetchPayloads(): void {
    fetchPayloadCache.clear();
    fetchPayloadCacheBytes = 0;
  }

  function clearFetchRetrievalStore(): void {
    fetchReplayMetadata.clear();
    clearCachedFetchPayloads();
  }

  async function cleanupTemporaryExports(): Promise<void> {
    if (!hasTemporaryExports) {
      return;
    }

    await rm(temporaryExportRoot, { recursive: true, force: true });
    hasTemporaryExports = false;
  }

  async function readFullFetchContent(params: ReadFullFetchParams): Promise<ReadFullFetchResult> {
    params.signal?.throwIfAborted();

    const mode = params.mode ?? "inline";
    const offset = params.offset ?? 0;

    let hasExplicitOutputPath = false;
    let outputPath: string | undefined;

    if (mode === "inline") {
      validateNonNegativeInteger("offset", offset);

      if (params.maxChars !== undefined) {
        validatePositiveInteger("maxChars", params.maxChars);
      }
    } else {
      hasExplicitOutputPath = typeof params.outputPath === "string" && params.outputPath.trim().length > 0;
      outputPath = hasExplicitOutputPath
        ? resolveOutputPath(params.outputPath!.trim(), params.cwd ?? process.cwd())
        : join(temporaryExportRoot, `${randomBytes(12).toString("hex")}-${params.section}.txt`);

      if (hasExplicitOutputPath && !params.overwrite) {
        const exists = await pathExists(outputPath);
        if (exists) {
          throw new Error(`File already exists: ${outputPath}. Pass overwrite=true to replace it.`);
        }
      }
    }

    const { payload, servedFrom } = await getPayloadForRead(params.fullContentRef, params.signal);
    const sectionText = getSectionText(payload, params.section);

    if (mode === "file") {
      const resolvedOutputPath = outputPath!;
      let overwritten = false;

      if (!hasExplicitOutputPath) {
        hasTemporaryExports = true;
      }

      await withFileMutationQueue(resolvedOutputPath, async () => {
        params.signal?.throwIfAborted();

        if (hasExplicitOutputPath) {
          const exists = await pathExists(resolvedOutputPath);
          if (exists && !params.overwrite) {
            throw new Error(`File already exists: ${resolvedOutputPath}. Pass overwrite=true to replace it.`);
          }
          overwritten = exists && params.overwrite === true;
        }

        await mkdir(dirname(resolvedOutputPath), { recursive: true });
        params.signal?.throwIfAborted();
        await writeFile(resolvedOutputPath, sectionText, {
          encoding: "utf8",
          flag: hasExplicitOutputPath ? (params.overwrite ? "w" : "wx") : "w",
          signal: params.signal,
        });
      });

      return {
        mode: "file",
        details: {
          mode: "file",
          target: "fetch",
          section: params.section,
          fullContentRef: params.fullContentRef,
          servedFrom,
          outputPath: resolvedOutputPath,
          charsWritten: sectionText.length,
          temporary: !hasExplicitOutputPath,
          overwritten,
        },
      };
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
        servedFrom,
        offset,
        maxChars: params.maxChars,
        totalChars: sectionText.length,
        returnedChars: slicedText.length,
      },
    };
  }

  return {
    registerFetchRetrieval,
    clearCachedFetchPayloads,
    clearFetchRetrievalStore,
    cleanupTemporaryExports,
    readFullFetchContent,
  };
}

const defaultFetchRetrievalStore = createFetchRetrievalStore();

export const registerFetchRetrieval = defaultFetchRetrievalStore.registerFetchRetrieval;
export const clearCachedFetchPayloads = defaultFetchRetrievalStore.clearCachedFetchPayloads;
export const clearFetchRetrievalStore = defaultFetchRetrievalStore.clearFetchRetrievalStore;
export const cleanupTemporaryExports = defaultFetchRetrievalStore.cleanupTemporaryExports;
export const readFullFetchContent = defaultFetchRetrievalStore.readFullFetchContent;
