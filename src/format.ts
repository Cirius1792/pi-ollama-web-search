import type { NormalizedFetchResponse, NormalizedSearchResponse } from "./normalize.js";

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

export function formatFetchResult(response: NormalizedFetchResponse, options: FormatOptions): string {
  const linksSection = response.links.length === 0 ? "No links found." : response.links.map((link, i) => `[${i + 1}] ${link}`).join("\n");

  const header = ["Fetched page:", "", `Title: ${response.title}`, "", "Content:"].join("\n");
  const linksBlock = "\nLinks:\n" + linksSection;

  // Leave room for header, links block, truncation notice, and join newlines so links survive truncation
  const joinOverhead = 2; // two "\n" separators from join
  const fixedLength = header.length + linksBlock.length + joinOverhead;
  const notice = "\n\n[Output truncated to " + String(options.maxOutputChars) + " characters to protect pi context.]";
  const contentMax = Math.max(0, options.maxOutputChars - fixedLength - notice.length);

  const truncatedContent =
    contentMax > 0 && response.content.length > contentMax
      ? response.content.slice(0, contentMax).trimEnd() + notice
      : response.content;

  const text = [header, truncatedContent, linksBlock].join("\n");

  // Final safety cap as belt-and-suspenders for edge cases (e.g. very long title/links)
  return applySafetyCap(text, options.maxOutputChars);
}
