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
  projectRoot?: string;
}

export interface OllamaSearchConfigDocument {
  default?: {
    maxResults?: unknown;
    maxOutputChars?: unknown;
  };
  models?: Record<
    string,
    {
      maxResults?: unknown;
      maxOutputChars?: unknown;
    }
  >;
}

export interface ResolveConfigDocumentsOptions {
  configRoot: string;
  projectRoot?: string;
}

export interface LoadExtensionProfileConfigOptions {
  globalConfigPath: string;
  projectRoot?: string;
}

export interface ExtensionProfile {
  maxResults: number;
  maxOutputChars: number;
}

export type ActiveProfileOrigin =
  | { kind: "default" }
  | { kind: "exact"; selector: string }
  | { kind: "pattern"; selector: string };

export const OLLAMA_WEB_SEARCH_ENDPOINT = "https://ollama.com/api/web_search";
export const OLLAMA_WEB_FETCH_ENDPOINT = "https://ollama.com/api/web_fetch";
export const DEFAULT_MAX_RESULTS = 5;
export const DEFAULT_MAX_OUTPUT_CHARS = 50_000;
export const LOCAL_FIRST_MAX_RESULTS = 3;
export const LOCAL_FIRST_MAX_OUTPUT_CHARS = 12_000;

const CONFIG_FILE_NAME = "pi-ollama-web-search.json";
const PROJECT_CONFIG_DIR = ".pi";

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

function parseExtensionProfile(
  value: { maxResults?: unknown; maxOutputChars?: unknown } | undefined,
): ExtensionProfile | undefined {
  const maxResults = parsePositiveInteger(value?.maxResults);
  const maxOutputChars = parsePositiveInteger(value?.maxOutputChars);
  if (!maxResults || !maxOutputChars) {
    return undefined;
  }

  return {
    maxResults,
    maxOutputChars,
  };
}

function matchesSimpleGlob(pattern: string, value: string): boolean {
  const escapedPattern = pattern.replace(/[-/\\^$+?.()|[\]{}]/g, "\\$&");
  const regexPattern = `^${escapedPattern.replace(/\*/g, ".*")}$`;
  return new RegExp(regexPattern).test(value);
}

function getPatternSpecificity(selector: string): number {
  return selector.replace(/\*/g, "").length;
}

function getConfigPath(configRoot: string): string {
  return join(configRoot, CONFIG_FILE_NAME);
}

function getProjectConfigPath(projectRoot: string): string {
  return join(projectRoot, PROJECT_CONFIG_DIR, CONFIG_FILE_NAME);
}

function readConfigDocument(configPath: string): OllamaSearchConfigDocument {
  if (!existsSync(configPath)) {
    return {};
  }

  return JSON.parse(readFileSync(configPath, "utf8")) as OllamaSearchConfigDocument;
}

function mergeConfigDocuments(
  globalConfigDocument: OllamaSearchConfigDocument,
  projectConfigDocument: OllamaSearchConfigDocument,
): OllamaSearchConfigDocument {
  const mergedModels = {
    ...globalConfigDocument.models,
    ...projectConfigDocument.models,
  };

  return {
    ...globalConfigDocument,
    ...projectConfigDocument,
    default: {
      ...globalConfigDocument.default,
      ...projectConfigDocument.default,
    },
    ...(Object.keys(mergedModels).length > 0 ? { models: mergedModels } : {}),
  };
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

export function resolveConfigDocuments(
  options: ResolveConfigDocumentsOptions,
): OllamaSearchConfigDocument {
  const globalConfigDocument = readConfigDocument(ensureLocalFirstConfigFile(options.configRoot));
  const projectConfigDocument = options.projectRoot
    ? readConfigDocument(getProjectConfigPath(options.projectRoot))
    : {};

  return mergeConfigDocuments(globalConfigDocument, projectConfigDocument);
}

export function loadExtensionProfileConfig(
  options: LoadExtensionProfileConfigOptions,
): {
  document: OllamaSearchConfigDocument;
} {
  const globalConfigDocument = readConfigDocument(options.globalConfigPath);
  const projectConfigDocument = options.projectRoot
    ? readConfigDocument(getProjectConfigPath(options.projectRoot))
    : {};

  return {
    document: mergeConfigDocuments(globalConfigDocument, projectConfigDocument),
  };
}

export function resolveActiveProfile(options: {
  document: OllamaSearchConfigDocument;
  activeModelKey?: string;
}): {
  profile: ExtensionProfile;
  origin: ActiveProfileOrigin;
} {
  if (options.activeModelKey) {
    const exactProfile = parseExtensionProfile(options.document.models?.[options.activeModelKey]);
    if (exactProfile) {
      return {
        profile: exactProfile,
        origin: {
          kind: "exact",
          selector: options.activeModelKey,
        },
      };
    }

    let bestPatternMatch:
      | {
          selector: string;
          profile: ExtensionProfile;
        }
      | undefined;

    for (const [selector, candidateProfile] of Object.entries(options.document.models ?? {})) {
      if (!selector.includes("*") || !matchesSimpleGlob(selector, options.activeModelKey)) {
        continue;
      }

      const patternProfile = parseExtensionProfile(candidateProfile);
      if (!patternProfile) {
        continue;
      }

      if (
        !bestPatternMatch ||
        getPatternSpecificity(selector) > getPatternSpecificity(bestPatternMatch.selector)
      ) {
        bestPatternMatch = {
          selector,
          profile: patternProfile,
        };
      }
    }

    if (bestPatternMatch) {
      return {
        profile: bestPatternMatch.profile,
        origin: {
          kind: "pattern",
          selector: bestPatternMatch.selector,
        },
      };
    }
  }

  return {
    profile: parseExtensionProfile(options.document.default) ?? {
      maxResults: LOCAL_FIRST_MAX_RESULTS,
      maxOutputChars: LOCAL_FIRST_MAX_OUTPUT_CHARS,
    },
    origin: {
      kind: "default",
    },
  };
}

function loadLocalFirstDefaults(options: ResolveConfigDocumentsOptions): Pick<OllamaSearchConfig, "maxResults" | "maxOutputChars"> {
  const parsed = resolveConfigDocuments(options);

  return {
    maxResults: parsePositiveInteger(parsed.default?.maxResults) ?? LOCAL_FIRST_MAX_RESULTS,
    maxOutputChars: parsePositiveInteger(parsed.default?.maxOutputChars) ?? LOCAL_FIRST_MAX_OUTPUT_CHARS,
  };
}

export function loadConfig(env: Env = process.env, options?: LoadConfigOptions): OllamaSearchConfig {
  if (options?.configRoot) {
    const defaults = loadLocalFirstDefaults({
      configRoot: options.configRoot,
      projectRoot: options.projectRoot,
    });

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
