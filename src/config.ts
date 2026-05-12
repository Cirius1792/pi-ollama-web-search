import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface OllamaSearchConfig {
  apiKey?: string;
  devMode: boolean;
  searchEndpoint: string;
  fetchEndpoint: string;
  maxResults: number;
  maxOutputChars: number;
}

export type Env = Record<string, string | undefined>;

export interface LoadConfigOptions {
  configRoot?: string;
}

export const OLLAMA_WEB_SEARCH_ENDPOINT = "https://ollama.com/api/web_search";
export const OLLAMA_WEB_FETCH_ENDPOINT = "https://ollama.com/api/web_fetch";
export const DEFAULT_MAX_RESULTS = 5;
export const DEFAULT_MAX_OUTPUT_CHARS = 50_000;
export const LOCAL_FIRST_MAX_RESULTS = 3;
export const LOCAL_FIRST_MAX_OUTPUT_CHARS = 12_000;

const CONFIG_FILE_NAME = "pi-ollama-web-search.json";

export function isTruthyEnv(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

function optionalTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parsePositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function getConfigPath(configRoot: string): string {
  return join(configRoot, CONFIG_FILE_NAME);
}

function ensureLocalFirstConfigFile(configRoot: string): string {
  mkdirSync(configRoot, { recursive: true });

  const configPath = getConfigPath(configRoot);
  if (existsSync(configPath)) {
    return configPath;
  }

  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        default: {
          maxResults: LOCAL_FIRST_MAX_RESULTS,
          maxOutputChars: LOCAL_FIRST_MAX_OUTPUT_CHARS,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return configPath;
}

function loadLocalFirstDefaults(configRoot: string): Pick<OllamaSearchConfig, "maxResults" | "maxOutputChars"> {
  const configPath = ensureLocalFirstConfigFile(configRoot);
  const parsed = JSON.parse(readFileSync(configPath, "utf8")) as {
    default?: {
      maxResults?: unknown;
      maxOutputChars?: unknown;
    };
  };

  return {
    maxResults: parsePositiveInteger(parsed.default?.maxResults) ?? LOCAL_FIRST_MAX_RESULTS,
    maxOutputChars: parsePositiveInteger(parsed.default?.maxOutputChars) ?? LOCAL_FIRST_MAX_OUTPUT_CHARS,
  };
}

export function loadConfig(env: Env = process.env, options?: LoadConfigOptions): OllamaSearchConfig {
  if (options?.configRoot) {
    const defaults = loadLocalFirstDefaults(options.configRoot);

    return {
      apiKey: optionalTrimmed(env.OLLAMA_API_KEY),
      devMode: isTruthyEnv(env.PI_OLLAMA_SEARCH_DEV),
      searchEndpoint: OLLAMA_WEB_SEARCH_ENDPOINT,
      fetchEndpoint: OLLAMA_WEB_FETCH_ENDPOINT,
      maxResults: defaults.maxResults,
      maxOutputChars: defaults.maxOutputChars,
    };
  }

  return {
    apiKey: optionalTrimmed(env.OLLAMA_API_KEY),
    devMode: isTruthyEnv(env.PI_OLLAMA_SEARCH_DEV),
    searchEndpoint: OLLAMA_WEB_SEARCH_ENDPOINT,
    fetchEndpoint: OLLAMA_WEB_FETCH_ENDPOINT,
    maxResults: DEFAULT_MAX_RESULTS,
    maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS,
  };
}

export function getMissingApiKeyMessage(): string {
  return "OLLAMA_API_KEY is not set. Run export OLLAMA_API_KEY in your shell environment before starting pi.";
}
