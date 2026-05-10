import type { NormalizedFetchResponse, NormalizedSearchResponse } from "./normalize.js";

export interface FormatOptions {
  maxOutputChars: number;
}

export type RecommendedRetrievalMode = "inline" | "file";

export interface TargetVisibilityMetadata {
  totalChars: number;
  visibleChars: number;
  remainingChars: number;
  recommendedRetrievalMode: RecommendedRetrievalMode;
}

export interface FetchTruncationMetadata {
  truncated: boolean;
  maxOutputChars: number;
  targets: {
    title: TargetVisibilityMetadata;
    content: TargetVisibilityMetadata;
    links: TargetVisibilityMetadata;
  };
}

export interface SearchResultTruncationMetadata {
  targets: {
    title: TargetVisibilityMetadata;
    url: TargetVisibilityMetadata;
    content: TargetVisibilityMetadata;
  };
}

export interface SearchTruncationMetadata {
  truncated: boolean;
  maxOutputChars: number;
  omittedResultCount: number;
  results: SearchResultTruncationMetadata[];
}

export interface FormattedSearchResult {
  text: string;
  truncation: SearchTruncationMetadata;
}

export interface FormattedFetchResult {
  text: string;
  truncation: FetchTruncationMetadata;
}

const RETRIEVAL_INLINE_THRESHOLD = 12_000;

function applySafetyCap(text: string, maxOutputChars: number): string {
  if (text.length <= maxOutputChars) return text;

  const notice = `\n\n[Output truncated to ${maxOutputChars} characters to protect pi context.]`;
  const available = Math.max(0, maxOutputChars - notice.length);
  return text.slice(0, available).trimEnd() + notice;
}

function buildTargetVisibilityMetadata(totalChars: number, visibleChars: number): TargetVisibilityMetadata {
  const clampedVisibleChars = Math.max(0, Math.min(totalChars, visibleChars));
  const remainingChars = Math.max(0, totalChars - clampedVisibleChars);

  return {
    totalChars,
    visibleChars: clampedVisibleChars,
    remainingChars,
    recommendedRetrievalMode: remainingChars <= RETRIEVAL_INLINE_THRESHOLD ? "inline" : "file",
  };
}

function buildSearchResultChunk(index: number, title: string, url: string, content: string): { separator: string; prefix: string; chunk: string } {
  const separator = index === 0 ? "" : "\n\n---\n\n";
  const prefix = `[${index + 1}] ${title}\nURL: ${url}\nContent:\n`;
  return { separator, prefix, chunk: separator + prefix + content };
}

function buildSearchResultVisibility(index: number, title: string, url: string, content: string, visibleChunkChars: number): SearchResultTruncationMetadata {
  const { separator } = buildSearchResultChunk(index, title, url, content);
  let remaining = Math.max(0, visibleChunkChars - separator.length);

  const leading = `[${index + 1}] `;
  const between = "\nURL: ";
  const beforeContent = "\nContent:\n";

  const consume = (size: number): number => {
    const consumed = Math.max(0, Math.min(size, remaining));
    remaining -= consumed;
    return consumed;
  };

  consume(leading.length);
  const titleVisible = consume(title.length);
  consume(between.length);
  const urlVisible = consume(url.length);
  consume(beforeContent.length);
  const contentVisible = consume(content.length);

  return {
    targets: {
      title: buildTargetVisibilityMetadata(title.length, titleVisible),
      url: buildTargetVisibilityMetadata(url.length, urlVisible),
      content: buildTargetVisibilityMetadata(content.length, contentVisible),
    },
  };
}

function getSearchTruncationNotice(maxOutputChars: number): string {
  return `[Output truncated to ${maxOutputChars} characters to protect pi context. See details for retrieval metadata.]`;
}

function getSearchOmissionNotice(): string {
  return "Additional search results were omitted from visible output. See details for omitted result targets.";
}

function getFetchTruncationNotice(maxOutputChars: number): string {
  return `[Output truncated to ${maxOutputChars} characters to protect pi context. See details for retrieval metadata.]`;
}

export function formatSearchResultsWithMetadata(response: NormalizedSearchResponse, options: FormatOptions): FormattedSearchResult {
  if (response.results.length === 0) {
    return {
      text: "No results found.",
      truncation: {
        truncated: false,
        maxOutputChars: options.maxOutputChars,
        omittedResultCount: 0,
        results: [],
      },
    };
  }

  const header = "Search results:\n\n";
  const chunks = response.results.map((result, index) => buildSearchResultChunk(index, result.title, result.url, result.content));
  const fullText = header + chunks.map((chunk) => chunk.chunk).join("");

  if (fullText.length <= options.maxOutputChars) {
    return {
      text: fullText,
      truncation: {
        truncated: false,
        maxOutputChars: options.maxOutputChars,
        omittedResultCount: 0,
        results: response.results.map((result) => ({
          targets: {
            title: buildTargetVisibilityMetadata(result.title.length, result.title.length),
            url: buildTargetVisibilityMetadata(result.url.length, result.url.length),
            content: buildTargetVisibilityMetadata(result.content.length, result.content.length),
          },
        })),
      },
    };
  }

  let used = header.length;
  let truncationIndex = 0;

  for (let index = 0; index < chunks.length; index += 1) {
    if (used + chunks[index].chunk.length > options.maxOutputChars) {
      truncationIndex = index;
      break;
    }
    used += chunks[index].chunk.length;
  }

  const omittedResultCount = Math.max(0, response.results.length - (truncationIndex + 1));
  const truncationNotice = getSearchTruncationNotice(options.maxOutputChars);
  const omissionNotice = omittedResultCount > 0 ? getSearchOmissionNotice() : "";
  const trailingNotices = `\n\n${truncationNotice}${omittedResultCount > 0 ? `\n\n${omissionNotice}` : ""}`;

  const visibleBeforeTruncation = header + chunks.slice(0, truncationIndex).map((chunk) => chunk.chunk).join("");
  const remainingForTruncatedChunk = Math.max(0, options.maxOutputChars - visibleBeforeTruncation.length - trailingNotices.length);
  const partialChunk = chunks[truncationIndex].chunk.slice(0, remainingForTruncatedChunk);

  const text = visibleBeforeTruncation + partialChunk + trailingNotices;

  const metadata: SearchResultTruncationMetadata[] = response.results.map((result, index) => {
    if (index < truncationIndex) {
      return {
        targets: {
          title: buildTargetVisibilityMetadata(result.title.length, result.title.length),
          url: buildTargetVisibilityMetadata(result.url.length, result.url.length),
          content: buildTargetVisibilityMetadata(result.content.length, result.content.length),
        },
      };
    }

    if (index === truncationIndex) {
      return buildSearchResultVisibility(index, result.title, result.url, result.content, partialChunk.length);
    }

    return {
      targets: {
        title: buildTargetVisibilityMetadata(result.title.length, 0),
        url: buildTargetVisibilityMetadata(result.url.length, 0),
        content: buildTargetVisibilityMetadata(result.content.length, 0),
      },
    };
  });

  return {
    text,
    truncation: {
      truncated: true,
      maxOutputChars: options.maxOutputChars,
      omittedResultCount,
      results: metadata,
    },
  };
}

export function formatSearchResults(response: NormalizedSearchResponse, options: FormatOptions): string {
  return formatSearchResultsWithMetadata(response, options).text;
}

function buildLinksSection(links: string[]): string {
  return links.length === 0 ? "No links found." : links.map((link, i) => `[${i + 1}] ${link}`).join("\n");
}

export function formatFetchResultWithMetadata(response: NormalizedFetchResponse, options: FormatOptions): FormattedFetchResult {
  const linksSection = buildLinksSection(response.links);
  const headerPrefix = "Fetched page:\n\nTitle: ";
  const betweenTitleAndContent = "\n\nContent:\n";
  const linksHeader = "\nLinks:\n";

  const fullText = `${headerPrefix}${response.title}${betweenTitleAndContent}${response.content}${linksHeader}${linksSection}`;

  if (fullText.length <= options.maxOutputChars) {
    return {
      text: fullText,
      truncation: {
        truncated: false,
        maxOutputChars: options.maxOutputChars,
        targets: {
          title: buildTargetVisibilityMetadata(response.title.length, response.title.length),
          content: buildTargetVisibilityMetadata(response.content.length, response.content.length),
          links: buildTargetVisibilityMetadata(linksSection.length, linksSection.length),
        },
      },
    };
  }

  const notice = getFetchTruncationNotice(options.maxOutputChars);
  const noticeBlock = `\n\n${notice}`;

  let visibleTitleChars = response.title.length;
  let visibleContentChars = response.content.length;
  let visibleLinksChars = linksSection.length;

  const measure = () =>
    headerPrefix.length +
    visibleTitleChars +
    betweenTitleAndContent.length +
    visibleContentChars +
    noticeBlock.length +
    linksHeader.length +
    visibleLinksChars;

  let overflow = measure() - options.maxOutputChars;

  if (overflow > 0) {
    const contentReduction = Math.min(overflow, visibleContentChars);
    visibleContentChars -= contentReduction;
    overflow -= contentReduction;
  }

  if (overflow > 0) {
    const linksReduction = Math.min(overflow, visibleLinksChars);
    visibleLinksChars -= linksReduction;
    overflow -= linksReduction;
  }

  if (overflow > 0) {
    const titleReduction = Math.min(overflow, visibleTitleChars);
    visibleTitleChars -= titleReduction;
    overflow -= titleReduction;
  }

  const titleVisible = response.title.slice(0, visibleTitleChars);
  const contentVisible = response.content.slice(0, visibleContentChars);
  const linksVisible = linksSection.slice(0, visibleLinksChars);

  const truncatedText = `${headerPrefix}${titleVisible}${betweenTitleAndContent}${contentVisible}${noticeBlock}${linksHeader}${linksVisible}`;

  if (overflow > 0) {
    return {
      text: applySafetyCap(truncatedText, options.maxOutputChars),
      truncation: {
        truncated: true,
        maxOutputChars: options.maxOutputChars,
        targets: {
          title: buildTargetVisibilityMetadata(response.title.length, 0),
          content: buildTargetVisibilityMetadata(response.content.length, 0),
          links: buildTargetVisibilityMetadata(linksSection.length, 0),
        },
      },
    };
  }

  return {
    text: truncatedText,
    truncation: {
      truncated: true,
      maxOutputChars: options.maxOutputChars,
      targets: {
        title: buildTargetVisibilityMetadata(response.title.length, visibleTitleChars),
        content: buildTargetVisibilityMetadata(response.content.length, visibleContentChars),
        links: buildTargetVisibilityMetadata(linksSection.length, visibleLinksChars),
      },
    },
  };
}

export function formatFetchResult(response: NormalizedFetchResponse, options: FormatOptions): string {
  return formatFetchResultWithMetadata(response, options).text;
}
