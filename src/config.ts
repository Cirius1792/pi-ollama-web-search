import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import packageJson from "../package.json" with { type: "json" };

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
  version?: unknown;
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

export interface LoadExtensionProfileConfigResult {
  document: OllamaSearchConfigDocument;
  warnings: string[];
}

export interface LoadConfigResult {
  config: OllamaSearchConfig;
  document: OllamaSearchConfigDocument;
  warnings: string[];
}

interface LoadedConfigDocumentResult {
  document: OllamaSearchConfigDocument;
  warnings: string[];
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
const SUPPORTED_EXTENSION_VERSION = packageJson.version;
const SUPPORTED_CONFIG_MAJOR_VERSION = Number.parseInt(
  SUPPORTED_EXTENSION_VERSION.split(".")[0] ?? "0",
  10,
);

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

export function getExtensionProfileConfigPath(configRoot: string): string {
  return getConfigPath(configRoot);
}

function getProjectConfigPath(projectRoot: string): string {
  return join(projectRoot, PROJECT_CONFIG_DIR, CONFIG_FILE_NAME);
}

function getLocalFirstConfigDocument(): OllamaSearchConfigDocument {
  return {
    default: {
      maxResults: LOCAL_FIRST_MAX_RESULTS,
      maxOutputChars: LOCAL_FIRST_MAX_OUTPUT_CHARS,
    },
  };
}

function getConfigVersionMismatchWarning(
  version: unknown,
  configPath: string,
): string | undefined {
  if (typeof version !== "string") {
    return undefined;
  }

  const match = /^(\d+)/.exec(version.trim());
  if (!match) {
    return undefined;
  }

  const majorVersion = Number.parseInt(match[1], 10);
  if (majorVersion === SUPPORTED_CONFIG_MAJOR_VERSION) {
    return undefined;
  }

  return `Extension config at ${configPath} declares version ${version} with unsupported major version ${majorVersion}; expected major ${SUPPORTED_CONFIG_MAJOR_VERSION} from extension version ${SUPPORTED_EXTENSION_VERSION}. Using the config anyway.`;
}

function readConfigDocument(configPath: string): OllamaSearchConfigDocument {
  if (!existsSync(configPath)) {
    return {};
  }

  return JSON.parse(readFileSync(configPath, "utf8")) as OllamaSearchConfigDocument;
}

function isConfigProfileDocument(value: unknown): value is {
  maxResults?: unknown;
  maxOutputChars?: unknown;
} {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyValidProfileValues(value: unknown): boolean {
  if (!isConfigProfileDocument(value)) {
    return false;
  }

  if (
    "maxResults" in value &&
    value.maxResults !== undefined &&
    parsePositiveInteger(value.maxResults) === undefined
  ) {
    return false;
  }

  if (
    "maxOutputChars" in value &&
    value.maxOutputChars !== undefined &&
    parsePositiveInteger(value.maxOutputChars) === undefined
  ) {
    return false;
  }

  return true;
}

function isStructurallyValidConfigDocument(document: unknown): document is OllamaSearchConfigDocument {
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return false;
  }

  if ("default" in document && document.default !== undefined && !hasOnlyValidProfileValues(document.default)) {
    return false;
  }

  if ("models" in document && document.models !== undefined) {
    if (typeof document.models !== "object" || document.models === null || Array.isArray(document.models)) {
      return false;
    }

    for (const profile of Object.values(document.models)) {
      if (!hasOnlyValidProfileValues(profile)) {
        return false;
      }
    }
  }

  return true;
}

function loadConfigDocument(
  configPath: string,
  fallbackDocument: OllamaSearchConfigDocument,
  invalidWarning: string,
): LoadedConfigDocumentResult {
  let document: OllamaSearchConfigDocument;

  try {
    document = readConfigDocument(configPath);
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }

    return {
      document: fallbackDocument,
      warnings: [invalidWarning],
    };
  }

  if (!isStructurallyValidConfigDocument(document)) {
    return {
      document: fallbackDocument,
      warnings: [invalidWarning],
    };
  }

  return {
    document,
    warnings: [],
  };
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
): LoadExtensionProfileConfigResult {
  const globalConfigResult = loadConfigDocument(
    options.globalConfigPath,
    getLocalFirstConfigDocument(),
    `Ignoring invalid extension config at ${options.globalConfigPath}; using local-first defaults.`,
  );
  const warnings = [...globalConfigResult.warnings];
  const globalConfigDocument = globalConfigResult.document;

  const versionMismatchWarning = getConfigVersionMismatchWarning(
    globalConfigDocument.version,
    options.globalConfigPath,
  );
  if (versionMismatchWarning) {
    warnings.push(versionMismatchWarning);
  }

  const projectConfigPath = options.projectRoot
    ? getProjectConfigPath(options.projectRoot)
    : undefined;
  const projectConfigResult = projectConfigPath
    ? loadConfigDocument(
        projectConfigPath,
        {},
        `Ignoring invalid project config at ${projectConfigPath}; using global/default values.`,
      )
    : { document: {}, warnings: [] };
  warnings.push(...projectConfigResult.warnings);
  const projectConfigDocument = projectConfigResult.document;
  const projectVersionMismatchWarning = projectConfigPath
    ? getConfigVersionMismatchWarning(projectConfigDocument.version, projectConfigPath)
    : undefined;
  if (projectVersionMismatchWarning) {
    warnings.push(projectVersionMismatchWarning);
  }

  return {
    document: mergeConfigDocuments(globalConfigDocument, projectConfigDocument),
    warnings,
  };
}

export function resolveActiveProfile(options: {
  document: OllamaSearchConfigDocument;
  activeModelKey?: string;
  activeModelAvailable?: boolean;
}): {
  profile: ExtensionProfile;
  origin: ActiveProfileOrigin;
  warnings?: string[];
} {
  const defaultProfile = parseExtensionProfile(options.document.default) ?? {
    maxResults: LOCAL_FIRST_MAX_RESULTS,
    maxOutputChars: LOCAL_FIRST_MAX_OUTPUT_CHARS,
  };

  if (options.activeModelAvailable === false) {
    return {
      profile: defaultProfile,
      origin: {
        kind: "default",
      },
      warnings: [
        "Using the default search profile because the current model could not be determined.",
      ],
    };
  }

  if (options.activeModelKey) {
    const exactCandidate = options.document.models?.[options.activeModelKey];
    const exactProfile = parseExtensionProfile(exactCandidate);
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
    profile: defaultProfile,
    origin: {
      kind: "default",
    },
  };
}

export function loadConfigWithWarnings(
  env: Env = process.env,
  options?: LoadConfigOptions,
): LoadConfigResult {
  if (options?.configRoot) {
    const extensionProfileConfig = loadExtensionProfileConfig({
      globalConfigPath: ensureLocalFirstConfigFile(options.configRoot),
      projectRoot: options.projectRoot,
    });

    return {
      config: {
        apiKey: optionalTrimmed(env.OLLAMA_API_KEY),
        devMode: isTruthyEnv(env.PI_OLLAMA_SEARCH_DEV),
        searchEndpoint: OLLAMA_WEB_SEARCH_ENDPOINT,
        fetchEndpoint: OLLAMA_WEB_FETCH_ENDPOINT,
        maxResults:
          parsePositiveInteger(extensionProfileConfig.document.default?.maxResults) ??
          LOCAL_FIRST_MAX_RESULTS,
        maxOutputChars:
          parsePositiveInteger(extensionProfileConfig.document.default?.maxOutputChars) ??
          LOCAL_FIRST_MAX_OUTPUT_CHARS,
      },
      document: extensionProfileConfig.document,
      warnings: extensionProfileConfig.warnings,
    };
  }

  return {
    config: {
      apiKey: optionalTrimmed(env.OLLAMA_API_KEY),
      devMode: isTruthyEnv(env.PI_OLLAMA_SEARCH_DEV),
      searchEndpoint: OLLAMA_WEB_SEARCH_ENDPOINT,
      fetchEndpoint: OLLAMA_WEB_FETCH_ENDPOINT,
      maxResults: DEFAULT_MAX_RESULTS,
      maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS,
    },
    document: {
      default: {
        maxResults: DEFAULT_MAX_RESULTS,
        maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS,
      },
    },
    warnings: [],
  };
}

export function loadConfig(env: Env = process.env, options?: LoadConfigOptions): OllamaSearchConfig {
  return loadConfigWithWarnings(env, options).config;
}

export function getMissingApiKeyMessage(): string {
  return "OLLAMA_API_KEY is not set. Run export OLLAMA_API_KEY in your shell environment before starting pi.";
}
