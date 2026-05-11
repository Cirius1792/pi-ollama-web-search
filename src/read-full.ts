import { type NormalizedSearchResponse } from "./normalize.js";
import { FETCH_RETRIEVAL_SECTIONS, type ReadFullFetchResult, type ReadFullFetchParams } from "./retrieval.js";
import type { StoredSearchContent, StoredSearchReplay } from "./store.js";

export type ReadFullSearchSection = "title" | "url" | "content";
export type ReadFullFetchSection = (typeof FETCH_RETRIEVAL_SECTIONS)[number];
export type ReadFullSection = ReadFullSearchSection | ReadFullFetchSection;

const SEARCH_READ_FULL_SECTIONS: readonly ReadFullSearchSection[] = ["title", "url", "content"];

function isSearchReadFullSection(value: unknown): value is ReadFullSearchSection {
  return typeof value === "string" && (SEARCH_READ_FULL_SECTIONS as readonly string[]).includes(value);
}

function isFetchReadFullSection(value: unknown): value is ReadFullFetchSection {
  return typeof value === "string" && (FETCH_RETRIEVAL_SECTIONS as readonly string[]).includes(value);
}

export interface RunOllamaWebReadFullInput {
  ref?: string;
  fullContentRef?: string;
  section?: ReadFullSection;
  resultIndex?: number;
  mode?: "inline" | "file";
  offset?: number;
  maxChars?: number;
  path?: string;
  outputPath?: string;
  overwrite?: boolean;
  cwd?: string;
  signal?: AbortSignal;
}

type FetchInlineDetails = Extract<ReadFullFetchResult, { mode: "inline" }>["details"];
type FetchFileDetails = Extract<ReadFullFetchResult, { mode: "file" }>["details"];

export interface RunOllamaWebReadFullInlineResult {
  mode: "inline";
  text: string;
  details:
    | {
        ref: string;
        kind: "search";
        section: ReadFullSearchSection;
        resultIndex: number;
        servedFrom: "cache" | "replay";
      }
    | FetchInlineDetails;
}

export interface RunOllamaWebReadFullFileResult {
  mode: "file";
  details: FetchFileDetails;
}

export type RunOllamaWebReadFullResult = RunOllamaWebReadFullInlineResult | RunOllamaWebReadFullFileResult;

function sliceByOffsetAndMaxChars(value: string, offset: number, maxChars?: number): string {
  if (maxChars === undefined) {
    return value.slice(offset);
  }
  return value.slice(offset, offset + maxChars);
}

function getRefValue(input: RunOllamaWebReadFullInput): string {
  const ref = (input.ref ?? input.fullContentRef)?.trim();
  if (!ref) {
    throw new Error("ref is required.");
  }
  return ref;
}

function validateInlineIntegerInput(name: string, value: number | undefined, minimum: number): void {
  if (value === undefined) {
    return;
  }

  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}.`);
  }
}

function resolveExportPath(input: RunOllamaWebReadFullInput): string | undefined {
  if (input.path !== undefined && input.outputPath !== undefined && input.path !== input.outputPath) {
    throw new Error("path and outputPath must match when both are provided.");
  }

  return input.path ?? input.outputPath;
}

function getSearchResultText(result: NormalizedSearchResponse["results"][number], section: ReadFullSearchSection): string {
  return section === "title" ? result.title : section === "url" ? result.url : result.content;
}

function getSearchResultCount(stored: StoredSearchContent | undefined, replay: StoredSearchReplay | undefined): number | undefined {
  if (replay) {
    return replay.originalResultUrls.length;
  }

  if (stored) {
    return stored.payload.results.length;
  }

  return undefined;
}

function getOriginalSearchResultIdentity(originalResultUrls: string[], resultIndex: number): { url: string; occurrence: number } {
  const targetUrl = originalResultUrls[resultIndex - 1];
  let occurrence = 0;

  for (let index = 0; index < resultIndex; index += 1) {
    if (originalResultUrls[index] === targetUrl) {
      occurrence += 1;
    }
  }

  return {
    url: targetUrl,
    occurrence,
  };
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function getMappedSearchResult(
  payload: NormalizedSearchResponse,
  originalResultUrls: string[],
  resultIndex: number,
): NormalizedSearchResponse["results"][number] {
  const { url, occurrence } = getOriginalSearchResultIdentity(originalResultUrls, resultIndex);
  let matchedOccurrence = 0;

  for (const result of payload.results) {
    if (result.url !== url) {
      continue;
    }

    matchedOccurrence += 1;
    if (matchedOccurrence === occurrence) {
      return result;
    }
  }

  throw new Error(`Replay succeeded, but the original search result ${String(resultIndex)} could not be reconstructed.`);
}

export async function runOllamaWebReadFull(
  input: RunOllamaWebReadFullInput,
  options: {
    readFullFetchContent: (params: ReadFullFetchParams) => Promise<ReadFullFetchResult>;
    getStoredSearchContent: (ref: string) => StoredSearchContent | undefined;
    getStoredSearchReplay?: (ref: string) => StoredSearchReplay | undefined;
    replaySearch?: (replay: StoredSearchReplay, signal?: AbortSignal) => Promise<NormalizedSearchResponse>;
    rememberSearchContent?: (input: {
      ref: string;
      query: string;
      maxResults: number;
      payload: NormalizedSearchResponse;
      originalResultUrls?: string[];
    }) => void;
  },
): Promise<RunOllamaWebReadFullResult> {
  const ref = getRefValue(input);

  validateInlineIntegerInput("Offset", input.offset, 0);
  validateInlineIntegerInput("maxChars", input.maxChars, 1);

  const exportPath = resolveExportPath(input);

  if (ref.startsWith("fetch:")) {
    if (input.resultIndex !== undefined) {
      throw new Error("resultIndex is not supported for fetch refs.");
    }

    if (input.mode !== "file" && (exportPath !== undefined || input.overwrite !== undefined)) {
      throw new Error("path/outputPath and overwrite are only supported for fetch refs when mode=file.");
    }

    const section = input.section ?? "content";
    if (!isFetchReadFullSection(section)) {
      throw new Error("section must be one of: title, content, links.");
    }

    const fetchResult = await options.readFullFetchContent({
      fullContentRef: ref,
      section,
      mode: input.mode,
      offset: input.offset,
      maxChars: input.maxChars,
      outputPath: exportPath,
      overwrite: input.overwrite,
      cwd: input.cwd,
      signal: input.signal,
    });

    if (fetchResult.mode === "file") {
      return {
        mode: "file",
        details: fetchResult.details,
      };
    }

    return {
      mode: "inline",
      text: fetchResult.text,
      details: fetchResult.details,
    };
  }

  if (input.mode === "file") {
    throw new Error("mode=file is only supported for fetch refs.");
  }

  if (exportPath !== undefined || input.overwrite !== undefined) {
    throw new Error("path/outputPath and overwrite are only supported for fetch refs when mode=file.");
  }

  const section = input.section ?? "content";
  if (!isSearchReadFullSection(section)) {
    throw new Error("section must be one of: title, url, content.");
  }

  const stored = options.getStoredSearchContent(ref);
  const replay = options.getStoredSearchReplay?.(ref);

  if (input.resultIndex === undefined) {
    throw new Error("resultIndex is required for search refs.");
  }

  const resultCount = getSearchResultCount(stored, replay);
  if (resultCount === undefined) {
    throw new Error(`No stored content found for ref ${ref}.`);
  }

  if (!Number.isInteger(input.resultIndex) || input.resultIndex < 1 || input.resultIndex > resultCount) {
    throw new Error(`Search result index ${String(input.resultIndex)} is out of range. Valid range is 1-${resultCount}.`);
  }

  if (stored) {
    let selected = stored.payload.results[input.resultIndex - 1];

    if (replay) {
      try {
        selected = getMappedSearchResult(stored.payload, replay.originalResultUrls, input.resultIndex);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`No stored content found for ref ${ref}. ${message}`);
      }
    }

    return {
      mode: "inline",
      text: sliceByOffsetAndMaxChars(getSearchResultText(selected, section), input.offset ?? 0, input.maxChars),
      details: {
        ref,
        kind: "search",
        section,
        resultIndex: input.resultIndex,
        servedFrom: "cache",
      },
    };
  }

  if (!replay) {
    throw new Error(`No stored content found for ref ${ref}.`);
  }

  if (!options.replaySearch) {
    throw new Error(`No stored content found for ref ${ref}. Replay failed: replaySearch dependency is not configured.`);
  }

  let replayed: NormalizedSearchResponse;
  try {
    replayed = await options.replaySearch(replay, input.signal);
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`No stored content found for ref ${ref}. Replay failed: ${message}`);
  }

  let selected: NormalizedSearchResponse["results"][number];
  try {
    selected = getMappedSearchResult(replayed, replay.originalResultUrls, input.resultIndex);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`No stored content found for ref ${ref}. ${message}`);
  }

  options.rememberSearchContent?.({
    ref,
    query: replay.query,
    maxResults: replay.maxResults,
    payload: replayed,
    originalResultUrls: replay.originalResultUrls,
  });

  return {
    mode: "inline",
    text: sliceByOffsetAndMaxChars(getSearchResultText(selected, section), input.offset ?? 0, input.maxChars),
    details: {
      ref,
      kind: "search",
      section,
      resultIndex: input.resultIndex,
      servedFrom: "replay",
    },
  };
}
