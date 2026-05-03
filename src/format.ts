import type { NormalizedSearchResponse } from "./normalize.js";

export interface FormatOptions {
  maxOutputChars: number;
}

function applySafetyCap(text: string, maxOutputChars: number): string {
  if (text.length <= maxOutputChars) return text;

  const notice = `\n\n[Output truncated to ${maxOutputChars} characters to protect pi context.]`;
  const available = Math.max(0, maxOutputChars - notice.length);
  return text.slice(0, available).trimEnd() + notice;
}

export function formatSearchResults(response: NormalizedSearchResponse, options: FormatOptions): string {
  if (response.results.length === 0) {
    return "No results found.";
  }

  const sections = response.results.map((result, index) => {
    return [`[${index + 1}] ${result.title}`, `URL: ${result.url}`, "Content:", result.content].join("\n");
  });

  return applySafetyCap(`Search results:\n\n${sections.join("\n\n---\n\n")}`, options.maxOutputChars);
}
