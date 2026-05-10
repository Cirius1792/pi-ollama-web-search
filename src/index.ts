import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getMissingApiKeyMessage, loadConfig } from "./config.js";
import { runOllamaWebFetch } from "./fetch.js";
import { runOllamaWebReadFull } from "./read-full.js";
import { formatOllamaWebError, runOllamaWebSearch } from "./search.js";

const SearchParams = Type.Object({
  query: Type.String({ description: "The web search query to send to Ollama." }),
});

const FetchParams = Type.Object({
  url: Type.String({ description: "The URL to fetch using Ollama Web Fetch API." }),
});

const ReadFullParams = Type.Object({
  ref: Type.String({ description: "A full-content ref returned by ollama_web_search." }),
  section: Type.Optional(
    Type.Union([
      Type.Literal("title"),
      Type.Literal("url"),
      Type.Literal("content"),
    ], { description: "Single section/field to read. Defaults to content." }),
  ),
  resultIndex: Type.Optional(Type.Integer({ minimum: 1, description: "1-based search result index. Required." })),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: "Start offset for inline retrieval. Must be 0 or greater." })),
  maxChars: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum characters to return for inline retrieval." })),
});
export default function ollamaWebSearchExtension(pi: ExtensionAPI) {
  const config = loadConfig();

  pi.registerTool({
    name: "ollama_web_search",
    label: "Ollama Web Search",
    description: "Search the web using Ollama's Web Search API. Returns title, URL, and content for each result.",
    promptSnippet: "Search the web using Ollama Web Search for current or external information.",
    promptGuidelines: [
      "Use ollama_web_search to discover relevant pages or current information when URLs are not known yet.",
      "Use ollama_web_search for documentation or references when the answer depends on external sources.",
      "When the user asks for latest, current, or recent information, run ollama_web_search before answering.",
      "Use ollama_web_search before ollama_web_fetch when you need candidate URLs first.",
    ],
    parameters: SearchParams,

    async execute(_toolCallId, params, signal) {
      const result = await runOllamaWebSearch(params.query, { config, signal });
      return {
        content: [{ type: "text", text: result.formatted }],
        details: {
          ...result.normalized,
          fullContentRef: result.fullContentRef,
          truncated: result.truncated,
          retrieval: result.retrieval,
        },
      };
    },
  });

  pi.registerTool({
    name: "ollama_web_fetch",
    label: "Ollama Web Fetch",
    description: "Fetch a single web page using Ollama's Web Fetch API. Returns title, main content, and discovered links.",
    promptSnippet: "Fetch a known URL using Ollama Web Fetch to retrieve fuller page content and links.",
    promptGuidelines: [
      "Use ollama_web_fetch when a specific URL is known and you need page content or links.",
      "Use ollama_web_fetch when the user provides a URL to inspect.",
      "Use ollama_web_fetch after ollama_web_search when search snippets are insufficient.",
      "Fetch source pages before quoting or summarizing details from a specific page.",
    ],
    parameters: FetchParams,

    async execute(_toolCallId, params, signal) {
      const result = await runOllamaWebFetch(params.url, { config, signal });
      return {
        content: [{ type: "text", text: result.formatted }],
        details: {
          ...result.normalized,
        },
      };
    },
  });

  pi.registerTool({
    name: "ollama_web_read_full",
    label: "Ollama Web Read Full",
    description: "Read full content from previous web search results using a ref and one selected section.",
    promptSnippet: "Recover full text from previous Ollama web search refs one field at a time.",
    promptGuidelines: [
      "Use ollama_web_read_full only with refs returned by previous ollama_web_search calls.",
      "Pass resultIndex using the same 1-based numbering shown in search results.",
      "Retrieve exactly one field at a time using section: title, url, or content.",
    ],
    parameters: ReadFullParams,

    async execute(_toolCallId, params) {
      const result = runOllamaWebReadFull(params);
      return {
        content: [{ type: "text", text: result.text }],
        details: result.details,
      };
    },
  });

  if (config.devMode) {
    pi.registerCommand("ollama-search", {
      description: "Run an Ollama web search debug request. Enabled by PI_OLLAMA_SEARCH_DEV.",
      handler: async (args, ctx) => {
        try {
          const result = await runOllamaWebSearch(args, { config, signal: ctx.signal });
          pi.sendMessage({
            customType: "ollama-web-search-debug",
            content: result.formatted,
            display: true,
            details: {
              ...result.normalized,
              fullContentRef: result.fullContentRef,
              truncated: result.truncated,
              retrieval: result.retrieval,
            },
          });
        } catch (error) {
          ctx.ui.notify(formatOllamaWebError(error), "error");
        }
      },
    });

    pi.registerCommand("ollama-fetch", {
      description: "Run an Ollama web fetch debug request. Enabled by PI_OLLAMA_SEARCH_DEV.",
      handler: async (args, ctx) => {
        try {
          const result = await runOllamaWebFetch(args, { config, signal: ctx.signal });
          pi.sendMessage({
            customType: "ollama-web-fetch-debug",
            content: result.formatted,
            display: true,
            details: {
              ...result.normalized,
            },
          });
        } catch (error) {
          ctx.ui.notify(formatOllamaWebError(error), "error");
        }
      },
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    if (!config.apiKey && ctx.hasUI) {
      ctx.ui.notify(getMissingApiKeyMessage(), "warning");
    }
  });
}
