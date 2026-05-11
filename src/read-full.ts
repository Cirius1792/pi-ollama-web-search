import { FETCH_RETRIEVAL_SECTIONS, type ReadFullFetchResult, type ReadFullFetchParams } from "./retrieval.js";
import type { ReadStoredSearchContentParams, ReadStoredSearchContentResult } from "./store.js";

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

export async function runOllamaWebReadFull(
  input: RunOllamaWebReadFullInput,
  options: {
    readFullFetchContent: (params: ReadFullFetchParams) => Promise<ReadFullFetchResult>;
    readSearchContent: (params: ReadStoredSearchContentParams) => Promise<ReadStoredSearchContentResult>;
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

  if (input.resultIndex === undefined) {
    throw new Error("resultIndex is required for search refs.");
  }

  const searchResult = await options.readSearchContent({
    ref,
    resultIndex: input.resultIndex,
    section,
    offset: input.offset,
    maxChars: input.maxChars,
    signal: input.signal,
  });

  return {
    mode: "inline",
    text: searchResult.text,
    details: searchResult.details,
  };
}
