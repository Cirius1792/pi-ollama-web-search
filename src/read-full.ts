import { getStoredFullContent } from "./store.js";

export type ReadFullSection = "title" | "url" | "content";

export interface RunOllamaWebReadFullInput {
  ref: string;
  section?: ReadFullSection;
  resultIndex?: number;
  offset?: number;
  maxChars?: number;
}

export interface RunOllamaWebReadFullResult {
  text: string;
  details: {
    ref: string;
    kind: "search";
    section: "title" | "url" | "content";
    resultIndex?: number;
    servedFrom: "cache";
  };
}

function sliceByOffsetAndMaxChars(value: string, offset: number, maxChars?: number): string {
  if (maxChars === undefined) {
    return value.slice(offset);
  }
  return value.slice(offset, offset + maxChars);
}

export function runOllamaWebReadFull(input: RunOllamaWebReadFullInput): RunOllamaWebReadFullResult {
  const offset = input.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error("Offset must be an integer greater than or equal to 0.");
  }

  if (input.maxChars !== undefined && (!Number.isInteger(input.maxChars) || input.maxChars < 1)) {
    throw new Error("maxChars must be an integer greater than or equal to 1.");
  }

  const section = input.section ?? "content";
  const stored = getStoredFullContent(input.ref);
  if (!stored) {
    throw new Error(`No stored content found for ref ${input.ref}.`);
  }

  if (stored.kind === "search") {
    if (input.resultIndex === undefined) {
      throw new Error("resultIndex is required for search refs.");
    }

    if (!Number.isInteger(input.resultIndex) || input.resultIndex < 1 || input.resultIndex > stored.payload.results.length) {
      throw new Error(
        `Search result index ${String(input.resultIndex)} is out of range. Valid range is 1-${stored.payload.results.length}.`,
      );
    }

    const selected = stored.payload.results[input.resultIndex - 1];
    const text = section === "title" ? selected.title : section === "url" ? selected.url : selected.content;

    return {
      text: sliceByOffsetAndMaxChars(text, offset, input.maxChars),
      details: {
        ref: input.ref,
        kind: "search",
        section,
        resultIndex: input.resultIndex,
        servedFrom: "cache",
      },
    };
  }

  if (input.resultIndex !== undefined) {
    throw new Error("resultIndex is only valid for search refs.");
  }

  throw new Error("Fetch refs are not supported by this retrieval slice.");
}
