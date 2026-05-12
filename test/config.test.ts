import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_OUTPUT_CHARS,
  DEFAULT_MAX_RESULTS,
  getMissingApiKeyMessage,
  isTruthyEnv,
  loadConfig,
} from "../src/config.js";

const EXPECTED_SEARCH_ENDPOINT = "https://ollama.com/api/web_search";
const EXPECTED_FETCH_ENDPOINT = "https://ollama.com/api/web_fetch";

describe("isTruthyEnv", () => {
  it("treats 1 and true as enabled", () => {
    expect(isTruthyEnv("1")).toBe(true);
    expect(isTruthyEnv("true")).toBe(true);
    expect(isTruthyEnv("TRUE")).toBe(true);
    expect(isTruthyEnv(" true ")).toBe(true);
  });

  it("treats everything else as disabled", () => {
    expect(isTruthyEnv(undefined)).toBe(false);
    expect(isTruthyEnv("")).toBe(false);
    expect(isTruthyEnv("0")).toBe(false);
    expect(isTruthyEnv("false")).toBe(false);
    expect(isTruthyEnv("yes")).toBe(false);
  });
});

describe("loadConfig", () => {
  it("creates the dedicated global config file with local-first defaults when missing", async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "pi-ollama-config-"));

    try {
      const config = await loadConfig({}, { configRoot });

      expect(config.maxResults).toBe(3);
      expect(config.maxOutputChars).toBe(12_000);
      expect(
        JSON.parse(await readFile(join(configRoot, "pi-ollama-web-search.json"), "utf8")),
      ).toMatchObject({
        default: {
          maxResults: 3,
          maxOutputChars: 12_000,
        },
      });
    } finally {
      await rm(configRoot, { recursive: true, force: true });
    }
  });

  it("does not overwrite an existing dedicated global config file", async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "pi-ollama-config-"));
    const configPath = join(configRoot, "pi-ollama-web-search.json");

    try {
      await writeFile(
        configPath,
        JSON.stringify({
          default: {
            maxResults: 99,
            maxOutputChars: 999,
          },
        }),
        "utf8",
      );

      const config = loadConfig({}, { configRoot });

      expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
        default: {
          maxResults: 99,
          maxOutputChars: 999,
        },
      });
      expect(config.maxResults).toBe(99);
      expect(config.maxOutputChars).toBe(999);
    } finally {
      await rm(configRoot, { recursive: true, force: true });
    }
  });

  it("loads API key and dev mode from an env object", () => {
    const config = loadConfig({
      OLLAMA_API_KEY: "ollama-secret",
      PI_OLLAMA_SEARCH_DEV: "1",
    });

    expect(config.apiKey).toBe("ollama-secret");
    expect(config.devMode).toBe(true);
    expect(config.searchEndpoint).toBe(EXPECTED_SEARCH_ENDPOINT);
    expect(config.fetchEndpoint).toBe(EXPECTED_FETCH_ENDPOINT);
    expect(config.maxResults).toBe(DEFAULT_MAX_RESULTS);
    expect(config.maxOutputChars).toBe(DEFAULT_MAX_OUTPUT_CHARS);
  });

  it("trims whitespace from the API key", () => {
    const config = loadConfig({ OLLAMA_API_KEY: "  key-with-spaces  " });
    expect(config.apiKey).toBe("key-with-spaces");
  });

  it("converts blank API keys to undefined", () => {
    const config = loadConfig({ OLLAMA_API_KEY: "   " });
    expect(config.apiKey).toBeUndefined();
  });

  it("uses production defaults when env values are missing", () => {
    const config = loadConfig({});
    expect(config.apiKey).toBeUndefined();
    expect(config.devMode).toBe(false);
    expect(config.searchEndpoint).toBe(EXPECTED_SEARCH_ENDPOINT);
    expect(config.fetchEndpoint).toBe(EXPECTED_FETCH_ENDPOINT);
    expect(config.maxResults).toBe(5);
    expect(config.maxOutputChars).toBe(50_000);
  });
});

describe("getMissingApiKeyMessage", () => {
  it("returns actionable setup guidance", () => {
    expect(getMissingApiKeyMessage()).toContain("OLLAMA_API_KEY is not set");
    expect(getMissingApiKeyMessage()).toContain("export OLLAMA_API_KEY");
  });
});
