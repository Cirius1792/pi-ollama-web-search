export interface OllamaSearchConfig {
  apiKey?: string;
  devMode: boolean;
  endpoint: string;
  maxResults: number;
  maxOutputChars: number;
}

export type Env = Record<string, string | undefined>;

export const OLLAMA_WEB_SEARCH_ENDPOINT = "https://ollama.com/api/web_search";
export const DEFAULT_MAX_RESULTS = 5;
export const DEFAULT_MAX_OUTPUT_CHARS = 50_000;

export function isTruthyEnv(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

function optionalTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function loadConfig(env: Env = process.env): OllamaSearchConfig {
  return {
    apiKey: optionalTrimmed(env.OLLAMA_API_KEY),
    devMode: isTruthyEnv(env.PI_OLLAMA_SEARCH_DEV),
    endpoint: OLLAMA_WEB_SEARCH_ENDPOINT,
    maxResults: DEFAULT_MAX_RESULTS,
    maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS,
  };
}

export function getMissingApiKeyMessage(): string {
  return "OLLAMA_API_KEY is not set. Run export OLLAMA_API_KEY in your shell environment before starting pi.";
}
