import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fetchOllamaWeb, searchOllamaWeb } from "./client.js";
import { getMissingApiKeyMessage, loadConfig } from "./config.js";
import { runOllamaWebFetch } from "./fetch.js";
import { normalizeWebSearchResponse } from "./normalize.js";
import { runOllamaWebReadFull } from "./read-full.js";
import { createFetchRetrievalStore } from "./retrieval.js";
import { formatOllamaWebError, runOllamaWebSearch } from "./search.js";
import { createSearchContentStore } from "./store.js";

const SearchParams = Type.Object({
  query: Type.String({ description: "The web search query to send to Ollama." }),
});

const FetchParams = Type.Object({
  url: Type.String({ description: "The URL to fetch using Ollama Web Fetch API." }),
});

const ReadFullParams = Type.Object({
  ref: Type.String({
    description:
      "A full-content ref returned by ollama_web_search or ollama_web_fetch. Search refs use ws_s_*; fetch refs use fetch:*.",
  }),
  section: Type.Optional(
    Type.Union([Type.Literal("title"), Type.Literal("url"), Type.Literal("content"), Type.Literal("links")], {
      description:
        "Single section to read. Search refs support title/url/content. Fetch refs support title/content/links. Defaults to content.",
    }),
  ),
  resultIndex: Type.Optional(Type.Integer({ minimum: 1, description: "1-based search result index. Required for search refs." })),
  mode: Type.Optional(
    Type.Union([Type.Literal("inline"), Type.Literal("file")], {
      description:
        "Read mode. file mode is supported for fetch refs. Omit path to write to a generated temp file cleaned up at session shutdown.",
    }),
  ),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: "Start offset for inline retrieval. Must be 0 or greater." })),
  maxChars: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum characters to return for inline retrieval." })),
  path: Type.Optional(
    Type.String({
      description:
        "Optional export path for fetch file mode. Supports relative or absolute paths, resolves relative paths from the current working directory, tolerates leading @, and persists until you delete it. If omitted, a generated temp file is used instead.",
    }),
  ),
  outputPath: Type.Optional(
    Type.String({
      description:
        "Deprecated alias for path. Optional export path for fetch file mode. Prefer path for new calls.",
    }),
  ),
  overwrite: Type.Optional(Type.Boolean({ description: "Allow fetch file mode to overwrite an existing explicit path. Defaults to false." })),
});

function formatReadFullResult(result: Awaited<ReturnType<typeof runOllamaWebReadFull>>) {
  if (result.mode === "file") {
    const message = result.details.temporary
      ? `Wrote full section to ${result.details.outputPath}. This temp export will be deleted at session shutdown.`
      : `Wrote full section to ${result.details.outputPath}. Delete this file when you no longer need it.`;

    return {
      content: message,
      details: result.details,
    };
  }

  return {
    content: result.text,
    details: result.details,
  };
}

function parseReadFullDebugArgs(args: string): Omit<Parameters<typeof runOllamaWebReadFull>[0], "signal" | "cwd"> {
  const trimmedArgs = args.trim();
  if (!trimmedArgs) {
    throw new Error('Provide JSON arguments, for example: /ollama-read-full {"ref":"fetch:...","section":"content"}');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmedArgs);
  } catch {
    throw new Error('Invalid JSON. Example: /ollama-read-full {"ref":"fetch:...","section":"content"}');
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Read-full debug arguments must be a JSON object.");
  }

  return parsed;
}

export default function ollamaWebSearchExtension(pi: ExtensionAPI) {
  const config = loadConfig(process.env, { configRoot: getAgentDir() });
  const fetchRetrievalStore = createFetchRetrievalStore({
    replayFetch: async ({ url, signal }) => {
      if (!config.apiKey) {
        throw new Error(getMissingApiKeyMessage());
      }

      return fetchOllamaWeb({
        endpoint: config.fetchEndpoint,
        apiKey: config.apiKey,
        url,
        signal,
      });
    },
  });
  const searchContentStore = createSearchContentStore({
    replaySearch: async ({ query, maxResults, signal }) => {
      if (!config.apiKey) {
        throw new Error(getMissingApiKeyMessage());
      }

      const raw = await searchOllamaWeb({
        endpoint: config.searchEndpoint,
        apiKey: config.apiKey,
        query,
        maxResults,
        signal,
      });

      return normalizeWebSearchResponse(raw);
    },
  });

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
      const result = await runOllamaWebSearch(params.query, {
        config,
        signal,
        rememberSearchContent: searchContentStore.rememberSearchContent,
      });
      return {
        content: [{ type: "text", text: result.formatted }],
        details: {
          ...result.normalized,
          truncated: result.truncated,
          ...(result.fullContentRef ? { fullContentRef: result.fullContentRef } : {}),
          ...(result.retrieval ? { retrieval: result.retrieval } : {}),
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
      const result = await runOllamaWebFetch(params.url, {
        config,
        signal,
        registerFetchRetrieval: fetchRetrievalStore.registerFetchRetrieval,
      });
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
    description: "Read full content from previous web search or web fetch results using a ref and one selected section.",
    promptSnippet: "Recover full text from previous Ollama web search/fetch refs one field at a time.",
    promptGuidelines: [
      "Use ollama_web_read_full only with refs returned by previous ollama_web_search or ollama_web_fetch calls.",
      "Search refs require resultIndex and support title/url/content sections.",
      "Fetch refs support title/content/links and can use mode=file for temp-file or explicit-path exports.",
      "When using ollama_web_read_full with an explicit export path, delete explicit export files when you no longer need them.",
    ],
    parameters: ReadFullParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<any> {
      const result = await runOllamaWebReadFull(
        { ...params, cwd: ctx?.cwd, signal },
        {
          readFullFetchContent: fetchRetrievalStore.readFullFetchContent,
          readSearchContent: searchContentStore.readSearchContent,
        },
      );
      const response = formatReadFullResult(result);
      return {
        content: [{ type: "text", text: response.content }],
        details: response.details,
      };
    },
  });

  if (config.devMode) {
    pi.registerCommand("ollama-search", {
      description: "Run an Ollama web search debug request. Enabled by PI_OLLAMA_SEARCH_DEV.",
      handler: async (args, ctx) => {
        try {
          const result = await runOllamaWebSearch(args, {
            config,
            signal: ctx.signal,
            rememberSearchContent: searchContentStore.rememberSearchContent,
          });
          pi.sendMessage({
            customType: "ollama-web-search-debug",
            content: result.formatted,
            display: true,
            details: {
              ...result.normalized,
              truncated: result.truncated,
              ...(result.fullContentRef ? { fullContentRef: result.fullContentRef } : {}),
              ...(result.retrieval ? { retrieval: result.retrieval } : {}),
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
          const result = await runOllamaWebFetch(args, {
            config,
            signal: ctx.signal,
            registerFetchRetrieval: fetchRetrievalStore.registerFetchRetrieval,
          });
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

    pi.registerCommand("ollama-read-full", {
      description: "Run an Ollama read-full debug request. Enabled by PI_OLLAMA_SEARCH_DEV. Pass JSON args.",
      handler: async (args, ctx) => {
        try {
          const params = parseReadFullDebugArgs(args);
          const result = await runOllamaWebReadFull(
            { ...params, cwd: ctx.cwd, signal: ctx.signal },
            {
              readFullFetchContent: fetchRetrievalStore.readFullFetchContent,
              readSearchContent: searchContentStore.readSearchContent,
            },
          );
          const response = formatReadFullResult(result);

          pi.sendMessage({
            customType: "ollama-web-read-full-debug",
            content: response.content,
            display: true,
            details: response.details,
          });
        } catch (error) {
          ctx.ui.notify(formatOllamaWebError(error), "error");
        }
      },
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    fetchRetrievalStore.clearFetchRetrievalStore();
    searchContentStore.clearSearchContentStore();

    if (!config.apiKey && ctx.hasUI) {
      ctx.ui.notify(getMissingApiKeyMessage(), "warning");
    }
  });

  pi.on("session_shutdown", async () => {
    await fetchRetrievalStore.cleanupTemporaryExports();
  });
}
