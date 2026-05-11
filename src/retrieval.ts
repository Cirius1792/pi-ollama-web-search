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

export interface FetchRetrievalStore {
  registerFetchRetrieval(payload: NormalizedFetchResponse): FetchRetrievalRecord;
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

export function createFetchRetrievalStore(): FetchRetrievalStore {
  const fetchRetrievalStore = new Map<string, StoredFetchPayload>();
  let fetchRetrievalStoreBytes = 0;
  const temporaryExportRoot = join(tmpdir(), `pi-ollama-web-search-${randomBytes(12).toString("hex")}`);
  let hasTemporaryExports = false;

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

  async function cleanupTemporaryExports(): Promise<void> {
    if (!hasTemporaryExports) {
      return;
    }

    await rm(temporaryExportRoot, { recursive: true, force: true });
    hasTemporaryExports = false;
  }

  async function readFullFetchContent(params: ReadFullFetchParams): Promise<ReadFullFetchResult> {
    params.signal?.throwIfAborted();

    const payload = requireRefPayload(params.fullContentRef);
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
