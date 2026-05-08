# Ollama Web Search Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a GitHub-installable pi package that exposes Ollama Web Search as one production pi tool plus one environment-gated debug command.

**Architecture:** The extension is externally minimal and internally modular. `src/index.ts` registers the pi tool and optional debug command, while `config`, `client`, `normalize`, `format`, and `search` modules keep configuration, HTTP, response validation, output shaping, and shared orchestration isolated and testable.

**Tech Stack:** TypeScript, pi extensions API, `typebox`, Node 20+/22 global `fetch`, Vitest, Node `http` mock server, GitHub Actions.

---

## File Structure

Create these files:

```text
package.json
README.md
tsconfig.json
vitest.config.ts
.gitignore
.github/workflows/test.yml
src/config.ts
src/client.ts
src/normalize.ts
src/format.ts
src/search.ts
src/index.ts
test/config.test.ts
test/normalize.test.ts
test/format.test.ts
test/client.test.ts
test/search.test.ts
test/extension.test.ts
test/helpers/mock-server.ts
```

Responsibilities:

- `src/config.ts`: env parsing, constants, missing-key messages.
- `src/client.ts`: HTTP request/response handling for Ollama Web Search.
- `src/normalize.ts`: raw API validation and stable internal result shape.
- `src/format.ts`: readable model-facing output with high safety cap.
- `src/search.ts`: shared search pipeline used by both tool and dev command.
- `src/index.ts`: pi extension entrypoint, tool registration, optional command registration, startup warning.
- `test/helpers/mock-server.ts`: local HTTP server used by client tests.
- `README.md`: GitHub pi package installation and usage docs for `https://github.com/Cirius1792/pi-ollama-web-search`.

## Task 1: Initialize package scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `.github/workflows/test.yml`

- [ ] **Step 1: Create `package.json`**

Write this exact file:

```json
{
  "name": "pi-ollama-web-search",
  "version": "0.1.0",
  "description": "A pi extension package that exposes Ollama Web Search as a custom tool.",
  "type": "module",
  "license": "MIT",
  "keywords": [
    "pi-package",
    "pi-extension",
    "ollama",
    "web-search"
  ],
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "pi": {
    "extensions": [
      "./src/index.ts"
    ]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "typebox": "*"
  },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "^0.74.0",
    "@types/node": "^22.0.0",
    "typebox": "^1.1.24",
    "typescript": "^5.9.0",
    "vitest": "^4.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

Write this exact file:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "types": ["node", "vitest/globals"],
    "noEmit": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts", "vitest.config.ts"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

Write this exact file:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    restoreMocks: true,
    clearMocks: true,
    testTimeout: 10_000,
  },
});
```

- [ ] **Step 4: Create `.gitignore`**

Write this exact file:

```gitignore
node_modules/
dist/
coverage/
.vitest/
.worktrees/
*.log
.DS_Store
.env
.env.*
!.env.example
```

- [ ] **Step 5: Create GitHub Actions workflow**

Write `.github/workflows/test.yml` exactly:

```yaml
name: Test

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest

    strategy:
      matrix:
        node-version: [20.x, 22.x]

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Use Node.js ${{ matrix.node-version }}
        uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Typecheck
        run: npm run typecheck

      - name: Run tests
        run: npm test
```

- [ ] **Step 6: Install dependencies**

Run:

```bash
npm install
```

Expected: `package-lock.json` is created and installation exits with code 0.

- [ ] **Step 7: Run baseline checks**

Run:

```bash
npm run typecheck
npm test
```

Expected:
- `npm run typecheck` passes with no TypeScript errors.
- `npm test` reports no test files or zero tests, depending on Vitest version.

- [ ] **Step 8: Commit scaffold**

If the repository is not initialized, run:

```bash
git init
git branch -M main
```

Then run:

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore .github/workflows/test.yml
git commit -m "chore: initialize pi extension package"
```

Expected: commit succeeds.

## Task 2: Add configuration module with TDD

**Files:**
- Create: `src/config.ts`
- Create: `test/config.test.ts`

- [ ] **Step 1: Write failing config tests**

Create `test/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_OUTPUT_CHARS,
  DEFAULT_MAX_RESULTS,
  getMissingApiKeyMessage,
  isTruthyEnv,
  loadConfig,
} from "../src/config.js";

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
  it("loads API key and dev mode from an env object", () => {
    const config = loadConfig({
      OLLAMA_API_KEY: "ollama-secret",
      PI_OLLAMA_SEARCH_DEV: "1",
    });

    expect(config.apiKey).toBe("ollama-secret");
    expect(config.devMode).toBe(true);
    expect(config.endpoint).toBe("https://ollama.com/api/web_search");
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
```

- [ ] **Step 2: Run config tests to verify failure**

Run:

```bash
npm test -- test/config.test.ts
```

Expected: FAIL because `src/config.ts` does not exist.

- [ ] **Step 3: Implement config module**

Create `src/config.ts`:

```ts
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
  return "OLLAMA_API_KEY is not set. Export OLLAMA_API_KEY in your shell environment before starting pi.";
}
```

- [ ] **Step 4: Run config tests to verify pass**

Run:

```bash
npm test -- test/config.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit config module**

Run:

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat: add Ollama search configuration"
```

Expected: commit succeeds.

## Task 3: Add normalization and formatting modules with TDD

**Files:**
- Create: `src/normalize.ts`
- Create: `src/format.ts`
- Create: `test/normalize.test.ts`
- Create: `test/format.test.ts`

- [ ] **Step 1: Write failing normalization tests**

Create `test/normalize.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { normalizeWebSearchResponse } from "../src/normalize.js";

describe("normalizeWebSearchResponse", () => {
  it("normalizes valid Ollama search results", () => {
    const normalized = normalizeWebSearchResponse({
      results: [
        {
          title: "  Example   Title  ",
          url: " https://example.com/page ",
          content: "Line one\r\nLine two  \n\n\nLine three",
        },
      ],
    });

    expect(normalized).toEqual({
      results: [
        {
          title: "Example Title",
          url: "https://example.com/page",
          content: "Line one\nLine two\n\nLine three",
        },
      ],
    });
  });

  it("accepts empty results", () => {
    expect(normalizeWebSearchResponse({ results: [] })).toEqual({ results: [] });
  });

  it("throws on missing results array", () => {
    expect(() => normalizeWebSearchResponse({})).toThrow("Unexpected Ollama web search response: results must be an array");
  });

  it("throws on invalid result fields", () => {
    expect(() =>
      normalizeWebSearchResponse({
        results: [{ title: "Title", url: "https://example.com", content: 42 }],
      }),
    ).toThrow("Unexpected Ollama web search response: result 1 content must be a string");
  });
});
```

- [ ] **Step 2: Write failing formatting tests**

Create `test/format.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatSearchResults } from "../src/format.js";

describe("formatSearchResults", () => {
  it("formats search results as readable text", () => {
    const text = formatSearchResults(
      {
        results: [
          {
            title: "First Result",
            url: "https://example.com/first",
            content: "First result content.",
          },
          {
            title: "Second Result",
            url: "https://example.com/second",
            content: "Second result content.",
          },
        ],
      },
      { maxOutputChars: 10_000 },
    );

    expect(text).toContain("Search results:");
    expect(text).toContain("[1] First Result");
    expect(text).toContain("URL: https://example.com/first");
    expect(text).toContain("First result content.");
    expect(text).toContain("[2] Second Result");
  });

  it("returns a clear successful message for empty results", () => {
    expect(formatSearchResults({ results: [] }, { maxOutputChars: 10_000 })).toBe("No results found.");
  });

  it("truncates only when the high safety cap is exceeded", () => {
    const text = formatSearchResults(
      {
        results: [
          {
            title: "Large Result",
            url: "https://example.com/large",
            content: "x".repeat(500),
          },
        ],
      },
      { maxOutputChars: 180 },
    );

    expect(text.length).toBeLessThanOrEqual(180);
    expect(text).toContain("[Output truncated to 180 characters");
  });
});
```

- [ ] **Step 3: Run tests to verify failure**

Run:

```bash
npm test -- test/normalize.test.ts test/format.test.ts
```

Expected: FAIL because `src/normalize.ts` and `src/format.ts` do not exist.

- [ ] **Step 4: Implement `src/normalize.ts`**

Create `src/normalize.ts`:

```ts
export interface NormalizedSearchResult {
  title: string;
  url: string;
  content: string;
}

export interface NormalizedSearchResponse {
  results: NormalizedSearchResult[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeCompactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeContent(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function requireString(record: Record<string, unknown>, key: "title" | "url" | "content", index: number): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`Unexpected Ollama web search response: result ${index} ${key} must be a string`);
  }
  return value;
}

export function normalizeWebSearchResponse(raw: unknown): NormalizedSearchResponse {
  if (!isRecord(raw) || !Array.isArray(raw.results)) {
    throw new Error("Unexpected Ollama web search response: results must be an array");
  }

  return {
    results: raw.results.map((item, itemIndex) => {
      const resultNumber = itemIndex + 1;
      if (!isRecord(item)) {
        throw new Error(`Unexpected Ollama web search response: result ${resultNumber} must be an object`);
      }

      return {
        title: normalizeCompactText(requireString(item, "title", resultNumber)),
        url: normalizeCompactText(requireString(item, "url", resultNumber)),
        content: normalizeContent(requireString(item, "content", resultNumber)),
      };
    }),
  };
}
```

- [ ] **Step 5: Implement `src/format.ts`**

Create `src/format.ts`:

```ts
import type { NormalizedSearchResponse } from "./normalize.js";

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
```

- [ ] **Step 6: Run normalization and formatting tests**

Run:

```bash
npm test -- test/normalize.test.ts test/format.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run full checks**

Run:

```bash
npm run typecheck
npm test
```

Expected: PASS.

- [ ] **Step 8: Commit normalization and formatting**

Run:

```bash
git add src/normalize.ts src/format.ts test/normalize.test.ts test/format.test.ts
git commit -m "feat: normalize and format Ollama search results"
```

Expected: commit succeeds.

## Task 4: Add Ollama HTTP client with mock-server tests

**Files:**
- Create: `src/client.ts`
- Create: `test/helpers/mock-server.ts`
- Create: `test/client.test.ts`

- [ ] **Step 1: Write mock server helper**

Create `test/helpers/mock-server.ts`:

```ts
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface CapturedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage["headers"];
  body: string;
}

export interface MockResponse {
  status?: number;
  headers?: Record<string, string>;
  body: string;
}

export interface MockServer {
  url: string;
  requests: CapturedRequest[];
  close(): Promise<void>;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function startMockServer(handler: (request: CapturedRequest) => MockResponse | Promise<MockResponse>): Promise<MockServer> {
  const requests: CapturedRequest[] = [];

  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const captured: CapturedRequest = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: await readBody(request),
    };
    requests.push(captured);

    const mockResponse = await handler(captured);
    response.statusCode = mockResponse.status ?? 200;
    for (const [key, value] of Object.entries(mockResponse.headers ?? { "content-type": "application/json" })) {
      response.setHeader(key, value);
    }
    response.end(mockResponse.body);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start mock server");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
```

- [ ] **Step 2: Write failing client tests**

Create `test/client.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { OllamaWebSearchError, searchOllamaWeb } from "../src/client.js";
import { startMockServer, type MockServer } from "./helpers/mock-server.js";

let server: MockServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("searchOllamaWeb", () => {
  it("posts the expected request and returns parsed JSON", async () => {
    server = await startMockServer((request) => {
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/api/web_search");
      expect(request.headers.authorization).toBe("Bearer test-key");
      expect(request.headers["content-type"]).toContain("application/json");
      expect(JSON.parse(request.body)).toEqual({ query: "what is ollama?", max_results: 5 });

      return {
        body: JSON.stringify({
          results: [{ title: "Ollama", url: "https://ollama.com", content: "Content" }],
        }),
      };
    });

    await expect(
      searchOllamaWeb({
        endpoint: `${server.url}/api/web_search`,
        apiKey: "test-key",
        query: "what is ollama?",
        maxResults: 5,
      }),
    ).resolves.toEqual({ results: [{ title: "Ollama", url: "https://ollama.com", content: "Content" }] });
  });

  it("throws a typed error for non-2xx responses", async () => {
    server = await startMockServer(() => ({ status: 401, body: JSON.stringify({ error: "unauthorized" }) }));

    await expect(
      searchOllamaWeb({ endpoint: `${server.url}/api/web_search`, apiKey: "bad-key", query: "test", maxResults: 5 }),
    ).rejects.toMatchObject({
      name: "OllamaWebSearchError",
      code: "http_error",
      status: 401,
    });
  });

  it("throws a typed error for malformed JSON", async () => {
    server = await startMockServer(() => ({ body: "not json" }));

    await expect(
      searchOllamaWeb({ endpoint: `${server.url}/api/web_search`, apiKey: "test-key", query: "test", maxResults: 5 }),
    ).rejects.toMatchObject({
      name: "OllamaWebSearchError",
      code: "invalid_json",
    });
  });

  it("wraps network failures", async () => {
    await expect(
      searchOllamaWeb({ endpoint: "http://127.0.0.1:1/api/web_search", apiKey: "test-key", query: "test", maxResults: 5 }),
    ).rejects.toBeInstanceOf(OllamaWebSearchError);
  });
});
```

- [ ] **Step 3: Run client tests to verify failure**

Run:

```bash
npm test -- test/client.test.ts
```

Expected: FAIL because `src/client.ts` does not exist.

- [ ] **Step 4: Implement HTTP client**

Create `src/client.ts`:

```ts
export type OllamaWebSearchErrorCode = "http_error" | "invalid_json" | "network_error";

export class OllamaWebSearchError extends Error {
  readonly code: OllamaWebSearchErrorCode;
  readonly status?: number;
  readonly responseBody?: string;

  constructor(message: string, options: { code: OllamaWebSearchErrorCode; status?: number; responseBody?: string; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = "OllamaWebSearchError";
    this.code = options.code;
    this.status = options.status;
    this.responseBody = options.responseBody;
  }
}

export interface SearchOllamaWebOptions {
  endpoint: string;
  apiKey: string;
  query: string;
  maxResults: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

async function readResponseBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

export async function searchOllamaWeb(options: SearchOllamaWebOptions): Promise<unknown> {
  const fetchFunction = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchFunction(options.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query: options.query, max_results: options.maxResults }),
      signal: options.signal,
    });
  } catch (error) {
    throw new OllamaWebSearchError(`Failed to reach Ollama Web Search API: ${error instanceof Error ? error.message : String(error)}`, {
      code: "network_error",
      cause: error,
    });
  }

  const body = await readResponseBody(response);

  if (!response.ok) {
    throw new OllamaWebSearchError(`Ollama Web Search API returned HTTP ${response.status}${body ? `: ${body}` : ""}`, {
      code: "http_error",
      status: response.status,
      responseBody: body,
    });
  }

  try {
    return body ? JSON.parse(body) : null;
  } catch (error) {
    throw new OllamaWebSearchError("Ollama Web Search API returned invalid JSON", {
      code: "invalid_json",
      responseBody: body,
      cause: error,
    });
  }
}
```

- [ ] **Step 5: Run client tests**

Run:

```bash
npm test -- test/client.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run full checks**

Run:

```bash
npm run typecheck
npm test
```

Expected: PASS.

- [ ] **Step 7: Commit HTTP client**

Run:

```bash
git add src/client.ts test/client.test.ts test/helpers/mock-server.ts
git commit -m "feat: add Ollama web search HTTP client"
```

Expected: commit succeeds.

## Task 5: Add shared search pipeline and error formatting

**Files:**
- Create: `src/search.ts`
- Create: `test/search.test.ts`

- [ ] **Step 1: Write failing search pipeline tests**

Create `test/search.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { getMissingApiKeyMessage } from "../src/config.js";
import { formatSearchError, runOllamaWebSearch } from "../src/search.js";

describe("runOllamaWebSearch", () => {
  it("fails before network calls when API key is missing", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      runOllamaWebSearch("test", {
        config: {
          apiKey: undefined,
          devMode: false,
          endpoint: "https://example.invalid/api/web_search",
          maxResults: 5,
          maxOutputChars: 50_000,
        },
        fetchImpl,
      }),
    ).rejects.toThrow(getMissingApiKeyMessage());

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("runs client, normalizer, and formatter", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [{ title: " Ollama ", url: " https://ollama.com ", content: "Cloud models" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const result = await runOllamaWebSearch("what is ollama?", {
      config: {
        apiKey: "test-key",
        devMode: false,
        endpoint: "https://example.test/api/web_search",
        maxResults: 5,
        maxOutputChars: 50_000,
      },
      fetchImpl,
    });

    expect(result.normalized).toEqual({
      results: [{ title: "Ollama", url: "https://ollama.com", content: "Cloud models" }],
    });
    expect(result.formatted).toContain("[1] Ollama");
  });

  it("trims query and rejects blank input", async () => {
    await expect(
      runOllamaWebSearch("   ", {
        config: {
          apiKey: "test-key",
          devMode: false,
          endpoint: "https://example.test/api/web_search",
          maxResults: 5,
          maxOutputChars: 50_000,
        },
      }),
    ).rejects.toThrow("Search query must not be empty.");
  });
});

describe("formatSearchError", () => {
  it("formats ordinary errors", () => {
    expect(formatSearchError(new Error("boom"))).toBe("boom");
  });

  it("formats unknown thrown values", () => {
    expect(formatSearchError("bad value")).toBe("bad value");
  });
});
```

- [ ] **Step 2: Run search tests to verify failure**

Run:

```bash
npm test -- test/search.test.ts
```

Expected: FAIL because `src/search.ts` does not exist.

- [ ] **Step 3: Implement search pipeline**

Create `src/search.ts`:

```ts
import { getMissingApiKeyMessage, type OllamaSearchConfig } from "./config.js";
import { searchOllamaWeb } from "./client.js";
import { formatSearchResults } from "./format.js";
import { normalizeWebSearchResponse, type NormalizedSearchResponse } from "./normalize.js";

export interface RunOllamaWebSearchOptions {
  config: OllamaSearchConfig;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface RunOllamaWebSearchResult {
  formatted: string;
  normalized: NormalizedSearchResponse;
}

export async function runOllamaWebSearch(query: string, options: RunOllamaWebSearchOptions): Promise<RunOllamaWebSearchResult> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    throw new Error("Search query must not be empty.");
  }

  if (!options.config.apiKey) {
    throw new Error(getMissingApiKeyMessage());
  }

  const raw = await searchOllamaWeb({
    endpoint: options.config.endpoint,
    apiKey: options.config.apiKey,
    query: trimmedQuery,
    maxResults: options.config.maxResults,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
  });

  const normalized = normalizeWebSearchResponse(raw);
  const formatted = formatSearchResults(normalized, { maxOutputChars: options.config.maxOutputChars });

  return { formatted, normalized };
}

export function formatSearchError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
```

- [ ] **Step 4: Run search tests**

Run:

```bash
npm test -- test/search.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run full checks**

Run:

```bash
npm run typecheck
npm test
```

Expected: PASS.

- [ ] **Step 6: Commit search pipeline**

Run:

```bash
git add src/search.ts test/search.test.ts
git commit -m "feat: add shared Ollama search pipeline"
```

Expected: commit succeeds.

## Task 6: Add pi extension entrypoint and extension behavior tests

**Files:**
- Create: `src/index.ts`
- Create: `test/extension.test.ts`

- [ ] **Step 1: Write failing extension tests**

Create `test/extension.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import extension from "../src/index.js";

interface RegisteredTool {
  name: string;
  execute: (...args: any[]) => Promise<any>;
}

function createFakePi() {
  const tools: RegisteredTool[] = [];
  const commands: Record<string, any> = {};
  const handlers: Record<string, any> = {};

  return {
    pi: {
      registerTool: vi.fn((tool: RegisteredTool) => tools.push(tool)),
      registerCommand: vi.fn((name: string, command: any) => {
        commands[name] = command;
      }),
      on: vi.fn((event: string, handler: any) => {
        handlers[event] = handler;
      }),
      sendMessage: vi.fn(),
    },
    tools,
    commands,
    handlers,
  };
}

const originalEnv = process.env;

beforeEach(() => {
  process.env = { ...originalEnv };
  delete process.env.OLLAMA_API_KEY;
  delete process.env.PI_OLLAMA_SEARCH_DEV;
});

describe("extension", () => {
  it("always registers the production search tool", () => {
    const fake = createFakePi();
    extension(fake.pi as any);

    expect(fake.pi.registerTool).toHaveBeenCalledOnce();
    expect(fake.tools[0].name).toBe("ollama_web_search");
  });

  it("does not register the debug command by default", () => {
    const fake = createFakePi();
    extension(fake.pi as any);

    expect(fake.pi.registerCommand).not.toHaveBeenCalled();
  });

  it("registers the debug command when dev mode is enabled", () => {
    process.env.PI_OLLAMA_SEARCH_DEV = "1";
    const fake = createFakePi();
    extension(fake.pi as any);

    expect(fake.pi.registerCommand).toHaveBeenCalledWith("ollama-search", expect.any(Object));
    expect(fake.commands["ollama-search"].description).toContain("debug");
  });

  it("registers a session_start warning for missing API key", async () => {
    const fake = createFakePi();
    extension(fake.pi as any);

    const notify = vi.fn();
    await fake.handlers.session_start({}, { hasUI: true, ui: { notify } });

    expect(notify).toHaveBeenCalledWith(expect.stringContaining("OLLAMA_API_KEY is not set"), "warning");
  });
});
```

- [ ] **Step 2: Run extension tests to verify failure**

Run:

```bash
npm test -- test/extension.test.ts
```

Expected: FAIL because `src/index.ts` does not exist.

- [ ] **Step 3: Implement extension entrypoint**

Create `src/index.ts`:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
```

- [ ] **Step 4: Run extension tests**

Run:

```bash
npm test -- test/extension.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run full checks**

Run:

```bash
npm run typecheck
npm test
```

Expected: PASS.

- [ ] **Step 6: Commit extension entrypoint**

Run:

```bash
git add src/index.ts test/extension.test.ts
git commit -m "feat: register Ollama web search extension"
```

Expected: commit succeeds.

## Task 7: Add README documentation

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write README**

Create `README.md`:

```md
# pi-ollama-web-search

A reusable [pi](https://pi.dev) package that exposes [Ollama Web Search](https://docs.ollama.com/capabilities/web-search) as a custom pi tool.

## What it provides

This package registers one production tool:

- `ollama_web_search`

The tool accepts a search query and returns Ollama web search results with title, URL, and content.

Version 1 intentionally does not include web fetch, query caching, custom secret storage, or search-agent orchestration.

## Install

Install directly from GitHub:

```bash
pi install git:github.com/Cirius1792/pi-ollama-web-search
```

Then start or reload pi.

## Authentication

Create an Ollama API key at:

https://ollama.com/settings/keys

Export it before starting pi:

```bash
export OLLAMA_API_KEY="your_api_key_here"
pi
```

For persistent setup, add the export to your shell profile such as `~/.profile`, `~/.bashrc`, or `~/.zshrc`.

## Usage

Ask pi a question that benefits from web search. The model can call `ollama_web_search` when it needs current or external information.

Example prompt:

```text
Search the web for recent Ollama Web Search API documentation and summarize what changed.
```

## Dev mode

A debug slash command is available only when dev mode is enabled.

Enable it before starting pi:

```bash
export PI_OLLAMA_SEARCH_DEV=1
pi
```

Then run:

```text
/ollama-search what is ollama?
```

The debug command is intended for local testing and troubleshooting. It is not part of the normal user workflow.

Changing `PI_OLLAMA_SEARCH_DEV` requires restarting pi or reloading extensions.

## Troubleshooting

### `OLLAMA_API_KEY is not set`

Set the API key before starting pi:

```bash
export OLLAMA_API_KEY="your_api_key_here"
```

If you added it to `~/.profile`, reload your shell or source the file before starting pi:

```bash
source ~/.profile
pi
```

### HTTP 401 or 403

The API key is present but Ollama rejected it. Create a new key at `https://ollama.com/settings/keys` and restart pi with the new value.

### Network errors

Check that your network can reach:

```text
https://ollama.com/api/web_search
```

## Development

Install dependencies:

```bash
npm install
```

Run checks:

```bash
npm run typecheck
npm test
```

The test suite uses unit tests and a local mock HTTP server. CI does not call the live Ollama API.

Manual live verification is optional:

```bash
source ~/.profile
export PI_OLLAMA_SEARCH_DEV=1
pi -e ./src/index.ts
```

Then run:

```text
/ollama-search what is ollama?
```
```

- [ ] **Step 2: Run documentation-adjacent checks**

Run:

```bash
npm run typecheck
npm test
```

Expected: PASS.

- [ ] **Step 3: Commit README**

Run:

```bash
git add README.md
git commit -m "docs: add installation and usage guide"
```

Expected: commit succeeds.

## Task 8: Final verification and package install smoke test

**Files:**
- Modify only if previous checks reveal a concrete issue.

- [ ] **Step 1: Run full automated verification**

Run:

```bash
npm run typecheck
npm test
```

Expected:
- TypeScript passes with no errors.
- Vitest passes every test.
- No test makes a live request to Ollama.

- [ ] **Step 2: Verify pi package manifest shape**

Run:

```bash
node -e "const p=require('./package.json'); console.log(p.pi.extensions[0])"
```

Expected output:

```text
./src/index.ts
```

- [ ] **Step 3: Verify local extension load command is documented and usable**

Run:

```bash
source ~/.profile >/dev/null 2>&1 || true
PI_OLLAMA_SEARCH_DEV=1 pi --no-session --no-builtin-tools -e ./src/index.ts -p "Do not call tools. Reply only: extension loaded" 
```

Expected:
- pi starts with the extension loaded.
- If `OLLAMA_API_KEY` is missing, a warning may appear.
- The final assistant text includes `extension loaded`.

- [ ] **Step 4: Optional live manual smoke test outside CI**

Run only on a developer machine with `OLLAMA_API_KEY` set:

```bash
source ~/.profile
export PI_OLLAMA_SEARCH_DEV=1
pi -e ./src/index.ts
```

Then run inside pi:

```text
/ollama-search what is ollama?
```

Expected:
- debug command is available
- command returns search results
- no API key is printed

- [ ] **Step 5: Commit final verification changes if any**

If Step 1 or Step 2 required changes, run:

```bash
git add .
git commit -m "chore: finalize Ollama web search package"
```

Expected: commit succeeds only if there were final changes.

## Self-Review

Spec coverage:
- GitHub-installable package: Task 1 package manifest, Task 7 README, Task 8 manifest verification.
- One production tool: Task 6.
- Dev-only command gated by `PI_OLLAMA_SEARCH_DEV`: Task 2 config, Task 6 extension tests and implementation.
- `OLLAMA_API_KEY` env-only auth: Task 2 config, Task 5 missing-key behavior, Task 7 docs.
- Fixed `max_results`: Task 2 config, Task 4 client request test.
- Mostly pass-through output with normalization and high safety cap: Task 3.
- Startup warning and call-time failure: Task 5 and Task 6.
- Mock-only CI: Task 1 workflow, Task 4 mock server, Task 7 docs.

Placeholder scan:
- No implementation step contains unresolved placeholder markers.
- Each created source/test/doc file has concrete content.

Type consistency:
- `OllamaSearchConfig`, `NormalizedSearchResponse`, `runOllamaWebSearch`, and `formatSearchResults` names are consistent across tasks.
- Test imports use `.js` specifiers to match NodeNext TypeScript ESM resolution.
