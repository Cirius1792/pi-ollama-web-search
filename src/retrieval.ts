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

export interface RegisterFetchRetrievalOptions {
  sourceUrl?: string;
  url?: string;
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

export type FetchReplayDependency = (params: { url: string; signal?: AbortSignal }) => Promise<unknown>;

export interface FetchRetrievalStoreOptions {
  replayFetch?: FetchReplayDependency;
}

interface StoredFetchEntry {
  payload?: NormalizedFetchResponse;
  retainedBytes: number;
  replay?: FetchRetrievalReplayMetadata;
}

interface InFlightFetchReplay {
  controller: AbortController;
  promise: Promise<NormalizedFetchResponse>;
  waiterCount: number;
  settled: boolean;
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

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError") ||
    (!!error && typeof error === "object" && (error as { code?: unknown }).code === "ABORT_ERR")
  );
}

export function createFetchRetrievalStore(options: FetchRetrievalStoreOptions = {}): FetchRetrievalStore {
  const fetchRetrievalStore = new Map<string, StoredFetchEntry>();
  const payloadLru = new Map<string, StoredFetchEntry>();
  const inFlightReplays = new Map<string, InFlightFetchReplay>();
  let fetchRetrievalStoreBytes = 0;
  const temporaryExportRoot = join(tmpdir(), `pi-ollama-web-search-${randomBytes(12).toString("hex")}`);
  let hasTemporaryExports = false;

  function touchPayload(ref: string, entry: StoredFetchEntry): void {
    if (!entry.payload) {
      return;
    }

    payloadLru.delete(ref);
    payloadLru.set(ref, entry);
  }

  function evictPayload(ref: string, entry: StoredFetchEntry): void {
    if (!entry.payload || entry.retainedBytes === 0) {
      payloadLru.delete(ref);
      return;
    }

    fetchRetrievalStoreBytes = Math.max(0, fetchRetrievalStoreBytes - entry.retainedBytes);
    payloadLru.delete(ref);
    entry.payload = undefined;
    entry.retainedBytes = 0;
  }

  function storePayload(ref: string, entry: StoredFetchEntry, payload: NormalizedFetchResponse): void {
    evictPayload(ref, entry);
    entry.payload = payload;
    entry.retainedBytes = measureRetainedBytes(payload);
    fetchRetrievalStoreBytes += entry.retainedBytes;
    touchPayload(ref, entry);
  }

  function evictOldestPayload(retainRef?: string): boolean {
    for (const [ref, entry] of payloadLru) {
      if (ref === retainRef) {
        continue;
      }

      evictPayload(ref, entry);
      return true;
    }

    return false;
  }

  function enforceFetchStoreLimit(retainRef?: string): void {
    while (payloadLru.size > FETCH_RETRIEVAL_STORE_MAX_ENTRIES) {
      if (!evictOldestPayload(retainRef)) {
        break;
      }
    }

    while (fetchRetrievalStoreBytes > FETCH_RETRIEVAL_STORE_MAX_BYTES) {
      if (!evictOldestPayload(retainRef)) {
        break;
      }
    }
  }

  function releaseReplayWaiter(replay: InFlightFetchReplay): void {
    replay.waiterCount = Math.max(0, replay.waiterCount - 1);
    if (replay.waiterCount === 0 && !replay.settled && !replay.controller.signal.aborted) {
      replay.controller.abort();
    }
  }

  async function waitForReplay(replay: InFlightFetchReplay, signal?: AbortSignal): Promise<NormalizedFetchResponse> {
    if (!signal) {
      replay.waiterCount += 1;
      try {
        return await replay.promise;
      } finally {
        releaseReplayWaiter(replay);
      }
    }

    signal.throwIfAborted();
    replay.waiterCount += 1;

    let removeAbortListener = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = () => {
        try {
          signal.throwIfAborted();
        } catch (error) {
          reject(error);
          return;
        }

        reject(new DOMException("The operation was aborted.", "AbortError"));
      };

      if (signal.aborted) {
        onAbort();
        return;
      }

      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => {
        signal.removeEventListener("abort", onAbort);
      };
    });

    try {
      return await Promise.race([replay.promise, aborted]);
    } finally {
      removeAbortListener();
      releaseReplayWaiter(replay);
    }
  }

  function createInFlightReplay(ref: string, replayFetch: FetchReplayDependency, replayInput: FetchReplayInput): InFlightFetchReplay {
    const controller = new AbortController();
    const replay: InFlightFetchReplay = {
      controller,
      waiterCount: 0,
      settled: false,
      promise: Promise.resolve(undefined as never),
    };

    replay.promise = (async () => {
      try {
        controller.signal.throwIfAborted();
        const raw = await replayFetch({ url: replayInput.url, signal: controller.signal });
        controller.signal.throwIfAborted();
        return normalizeWebFetchResponse(raw);
      } finally {
        replay.settled = true;
        if (inFlightReplays.get(ref) === replay) {
          inFlightReplays.delete(ref);
        }
      }
    })();
    replay.promise.catch(() => undefined);
    return replay;
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

    return { ref: trimmedRef, entry };
  }

  async function getOrReplayPayload(
    fullContentRef: string,
    signal?: AbortSignal,
  ): Promise<{ payload: NormalizedFetchResponse; servedFrom: "cache" | "replay" }> {
    const { ref, entry } = requireEntry(fullContentRef);
    if (entry.payload) {
      signal?.throwIfAborted();
      touchPayload(ref, entry);
      return { payload: entry.payload, servedFrom: "cache" };
    }

    if (!entry.replay?.url) {
      throw new Error(`No stored full content found for ref: ${ref}`);
    }

    signal?.throwIfAborted();

    const replayFetch = options.replayFetch;
    if (!replayFetch) {
      throw new Error(`No stored full content found for ref: ${ref}. Replay failed: replayFetch dependency is not configured.`);
    }

    let replay = inFlightReplays.get(ref);
    if (replay?.controller.signal.aborted) {
      replay = undefined;
    }

    if (!replay) {
      replay = createInFlightReplay(ref, replayFetch, { url: entry.replay.url });
      inFlightReplays.set(ref, replay);
    }

    let payload: NormalizedFetchResponse;
    try {
      signal?.throwIfAborted();
      payload = await waitForReplay(replay, signal);
      signal?.throwIfAborted();
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`No stored full content found for ref: ${ref}. Replay failed: ${message}`);
    }

    const currentEntry = fetchRetrievalStore.get(ref);
    if (currentEntry !== entry) {
      return { payload, servedFrom: "replay" };
    }

    if (!currentEntry.payload) {
      storePayload(ref, currentEntry, payload);
      enforceFetchStoreLimit(ref);
    } else {
      touchPayload(ref, currentEntry);
      payload = currentEntry.payload;
    }

    return { payload, servedFrom: "replay" };
  }

  function registerFetchRetrieval(payload: NormalizedFetchResponse, registerOptions?: RegisterFetchRetrievalOptions): FetchRetrievalRecord {
    let fullContentRef = createOpaqueFetchRef();
    while (fetchRetrievalStore.has(fullContentRef)) {
      fullContentRef = createOpaqueFetchRef();
    }

    const sourceUrl = (registerOptions?.sourceUrl ?? registerOptions?.url)?.trim();
    const entry: StoredFetchEntry = {
      replay: sourceUrl ? { url: sourceUrl } : undefined,
      retainedBytes: 0,
    };
    storePayload(fullContentRef, entry, payload);
    fetchRetrievalStore.set(fullContentRef, entry);
    enforceFetchStoreLimit(fullContentRef);

    return {
      ...payload,
      fullContentRef,
      retrieval: {
        target: "fetch",
        sections: [...FETCH_RETRIEVAL_SECTIONS],
        ...(sourceUrl ? { replay: { url: sourceUrl } } : {}),
        targets: {
          title: { section: "title", fullContentRef },
          content: { section: "content", fullContentRef },
          links: { section: "links", fullContentRef },
        },
      },
    };
  }

  function clearCachedFetchPayloads(): void {
    for (const [ref, entry] of fetchRetrievalStore) {
      evictPayload(ref, entry);
    }
    payloadLru.clear();
    fetchRetrievalStoreBytes = 0;
  }

  function clearFetchRetrievalStore(): void {
    for (const replay of inFlightReplays.values()) {
      if (!replay.controller.signal.aborted) {
        replay.controller.abort();
      }
    }

    fetchRetrievalStore.clear();
    payloadLru.clear();
    inFlightReplays.clear();
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
    const mode = params.mode ?? "inline";

    params.signal?.throwIfAborted();

    if (mode === "file") {
      requireEntry(params.fullContentRef);
      const hasExplicitOutputPath = typeof params.outputPath === "string" && params.outputPath.trim().length > 0;
      const outputPath = hasExplicitOutputPath
        ? resolveOutputPath(params.outputPath!.trim(), params.cwd ?? process.cwd())
        : join(temporaryExportRoot, `${randomBytes(12).toString("hex")}-${params.section}.txt`);

      let overwritten = false;
      let explicitOutputExists = false;

      if (hasExplicitOutputPath) {
        explicitOutputExists = await pathExists(outputPath);
        if (explicitOutputExists && !params.overwrite) {
          throw new Error(`File already exists: ${outputPath}. Pass overwrite=true to replace it.`);
        }
        overwritten = explicitOutputExists && params.overwrite === true;
      }

      const { payload, servedFrom } = await getOrReplayPayload(params.fullContentRef, params.signal);
      const sectionText = getSectionText(payload, params.section);

      if (!hasExplicitOutputPath) {
        hasTemporaryExports = true;
      }

      await withFileMutationQueue(outputPath, async () => {
        params.signal?.throwIfAborted();

        if (hasExplicitOutputPath && !explicitOutputExists) {
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

    const { payload, servedFrom } = await getOrReplayPayload(params.fullContentRef, params.signal);
    const sectionText = getSectionText(payload, params.section);
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
