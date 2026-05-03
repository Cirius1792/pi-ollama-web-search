import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { getMissingApiKeyMessage, loadConfig } from "./config.js";
import { formatSearchError, runOllamaWebSearch } from "./search.js";

const SearchParams = Type.Object({
  query: Type.String({ description: "The web search query to send to Ollama." }),
});

export default function ollamaWebSearchExtension(pi: ExtensionAPI) {
  const config = loadConfig();

  pi.registerTool({
    name: "ollama_web_search",
    label: "Ollama Web Search",
    description: "Search the web using Ollama's Web Search API. Returns title, URL, and content for each result.",
    promptSnippet: "Search the web using Ollama Web Search for current or external information.",
    parameters: SearchParams,

    async execute(_toolCallId, params, signal) {
      const result = await runOllamaWebSearch(params.query, { config, signal });
      return {
        content: [{ type: "text", text: result.formatted }],
        details: result.normalized,
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
            details: result.normalized,
          });
        } catch (error) {
          ctx.ui.notify(formatSearchError(error), "error");
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
