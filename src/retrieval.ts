import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { normalizeWebFetchResponse, type NormalizedFetchResponse } from "./normalize.js";

export const FETCH_RETRIEVAL_SECTIONS = ["title", "content", "links"] as const;

export type FetchRetrievalSection = (typeof FETCH_RETRIEVAL_SECTIONS)[number];

export interface FetchRetrievalTargetMetadata {
  section: FetchRetrievalSection;
  fullContentRef: string;
}

export interface FetchRetrievalReplayMetadata {
  url: string;
}

export interface FetchRetrievalMetadata {
  target: "fetch";
  sections: FetchRetrievalSection[];
  replay?: FetchRetrievalReplayMetadata;
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

export interface FetchReplayInput {
  url: string;
}

export interface RegisterFetchRetrievalReplay {
  url: string;
  replayFetch?: (replay: FetchReplayInput, signal?: AbortSignal) => Promise<unknown>;
}

interface StoredFetchEntry {
  payload?: NormalizedFetchResponse;
  retainedBytes: number;
  replay?: RegisterFetchRetrievalReplay;
}

export interface FetchRetrievalStore {
  registerFetchRetrieval(payload: NormalizedFetchResponse, replay?: RegisterFetchRetrievalReplay): FetchRetrievalRecord;
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

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

export function createFetchRetrievalStore(): FetchRetrievalStore {
  const fetchRetrievalStore = new Map<string, StoredFetchEntry>();
  let fetchRetrievalStoreBytes = 0;
  const temporaryExportRoot = join(tmpdir(), `pi-ollama-web-search-${randomBytes(12).toString("hex")}`);
  let hasTemporaryExports = false;

  function touchEntry(ref: string, entry: StoredFetchEntry): void {
    fetchRetrievalStore.delete(ref);
    fetchRetrievalStore.set(ref, entry);
  }

  function evictPayload(entry: StoredFetchEntry): void {
    if (!entry.payload || entry.retainedBytes === 0) {
      return;
    }

    fetchRetrievalStoreBytes = Math.max(0, fetchRetrievalStoreBytes - entry.retainedBytes);
    entry.payload = undefined;
    entry.retainedBytes = 0;
  }

  function evictOldestFetchRecord(): void {
    const oldestRef = fetchRetrievalStore.keys().next().value;
    if (!oldestRef) return;

    const removed = fetchRetrievalStore.get(oldestRef);
    if (removed) {
      evictPayload(removed);
    }
    fetchRetrievalStore.delete(oldestRef);
  }

  function enforceFetchStoreLimit(retainRef?: string): void {
    while (fetchRetrievalStore.size > FETCH_RETRIEVAL_STORE_MAX_ENTRIES) {
      evictOldestFetchRecord();
    }

    if (fetchRetrievalStoreBytes <= FETCH_RETRIEVAL_STORE_MAX_BYTES) {
      return;
    }

    for (const [ref, entry] of fetchRetrievalStore) {
      if (ref === retainRef) {
        continue;
      }

      evictPayload(entry);
      if (fetchRetrievalStoreBytes <= FETCH_RETRIEVAL_STORE_MAX_BYTES) {
        return;
      }
    }
  }

  function requireEntry(fullContentRef: string): { ref: string; entry: StoredFetchEntry } {
    const trimmedRef = fullContentRef.trim();
    if (!trimmedRef) {
      throw new Error("fullContentRef must not be empty.");
    }

    if (!trimmedRef.startsWith("fetch:")) {
      throw new Error("fullContentRef must reference a fetch result.");
    }

    const entry = fetchRetrievalStore.get(trimmedRef);
    if (!entry) {
      throw new Error(`No stored full content found for ref: ${trimmedRef}`);
    }

    touchEntry(trimmedRef, entry);
    return { ref: trimmedRef, entry };
  }

  async function getOrReplayPayload(
    fullContentRef: string,
    signal?: AbortSignal,
  ): Promise<{ payload: NormalizedFetchResponse; servedFrom: "cache" | "replay" }> {
    const { ref, entry } = requireEntry(fullContentRef);
    if (entry.payload) {
      signal?.throwIfAborted();
      return { payload: entry.payload, servedFrom: "cache" };
    }

    if (!entry.replay) {
      throw new Error(`No stored full content found for ref: ${ref}`);
    }

    if (!entry.replay.replayFetch) {
      throw new Error(`No stored full content found for ref: ${ref}. Replay failed: replayFetch dependency is not configured.`);
    }

    let payload: NormalizedFetchResponse;
    try {
      const raw = await entry.replay.replayFetch({ url: entry.replay.url }, signal);
      payload = normalizeWebFetchResponse(raw);
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`No stored full content found for ref: ${ref}. Replay failed: ${message}`);
    }

    evictPayload(entry);
    entry.payload = payload;
    entry.retainedBytes = measureRetainedBytes(payload);
    fetchRetrievalStoreBytes += entry.retainedBytes;
    touchEntry(ref, entry);
    enforceFetchStoreLimit(ref);

    return { payload, servedFrom: "replay" };
  }

  function registerFetchRetrieval(payload: NormalizedFetchResponse, replay?: RegisterFetchRetrievalReplay): FetchRetrievalRecord {
    let fullContentRef = createOpaqueFetchRef();
    while (fetchRetrievalStore.has(fullContentRef)) {
      fullContentRef = createOpaqueFetchRef();
    }

    const retainedBytes = measureRetainedBytes(payload);
    fetchRetrievalStore.set(fullContentRef, { payload, retainedBytes, replay });
    fetchRetrievalStoreBytes += retainedBytes;
    enforceFetchStoreLimit(fullContentRef);

    return {
      ...payload,
      fullContentRef,
      retrieval: {
        target: "fetch",
        sections: [...FETCH_RETRIEVAL_SECTIONS],
        ...(replay ? { replay: { url: replay.url } } : {}),
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

  async function cleanupTemporaryExports(): Promise<void> {
    if (!hasTemporaryExports) {
      return;
    }

    await rm(temporaryExportRoot, { recursive: true, force: true });
    hasTemporaryExports = false;
  }

  async function readFullFetchContent(params: ReadFullFetchParams): Promise<ReadFullFetchResult> {
    const { payload, servedFrom } = await getOrReplayPayload(params.fullContentRef, params.signal);
    const sectionText = getSectionText(payload, params.section);
    const mode = params.mode ?? "inline";

    if (mode === "file") {
      const hasExplicitOutputPath = typeof params.outputPath === "string" && params.outputPath.trim().length > 0;
      const outputPath = hasExplicitOutputPath
        ? resolveOutputPath(params.outputPath!.trim(), params.cwd ?? process.cwd())
        : join(temporaryExportRoot, `${randomBytes(12).toString("hex")}-${params.section}.txt`);

      let overwritten = false;

      if (!hasExplicitOutputPath) {
        hasTemporaryExports = true;
      }

      await withFileMutationQueue(outputPath, async () => {
        params.signal?.throwIfAborted();

        if (hasExplicitOutputPath) {
          const exists = await pathExists(outputPath);
          if (exists && !params.overwrite) {
            throw new Error(`File already exists: ${outputPath}. Pass overwrite=true to replace it.`);
          }
          overwritten = exists && params.overwrite === true;
        }

        await mkdir(dirname(outputPath), { recursive: true });
        params.signal?.throwIfAborted();
        await writeFile(outputPath, sectionText, {
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
          outputPath,
          charsWritten: sectionText.length,
          temporary: !hasExplicitOutputPath,
          overwritten,
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
    clearFetchRetrievalStore,
    cleanupTemporaryExports,
    readFullFetchContent,
  };
}

const defaultFetchRetrievalStore = createFetchRetrievalStore();

export const registerFetchRetrieval = defaultFetchRetrievalStore.registerFetchRetrieval;
export const clearFetchRetrievalStore = defaultFetchRetrievalStore.clearFetchRetrievalStore;
export const cleanupTemporaryExports = defaultFetchRetrievalStore.cleanupTemporaryExports;
export const readFullFetchContent = defaultFetchRetrievalStore.readFullFetchContent;
