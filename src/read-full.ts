import { getStoredFullContent } from "./store.js";

export type ReadFullSection = "title" | "url" | "content" | "links";

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
    kind: "search" | "fetch";
    section: "title" | "url" | "content" | "links";
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
  if (offset < 0) {
    throw new Error("Offset must be 0 or greater.");
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

    if (section === "links") {
      throw new Error('Section "links" is not valid for search refs.');
    }

    if (!Number.isInteger(input.resultIndex) || input.resultIndex < 1 || input.resultIndex > stored.payload.results.length) {
      throw new Error(
        `Search result index ${String(input.resultIndex)} is out of range. Valid range is 1-${stored.payload.results.length}.`,
      );
    }

    const selected = stored.payload.results[input.resultIndex - 1];
    const text =
      section === "title"
        ? selected.title
        : section === "url"
          ? selected.url
          : section === "content"
            ? selected.content
            : (() => {
                throw new Error(`Section "${section}" is not valid for search refs.`);
              })();

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
