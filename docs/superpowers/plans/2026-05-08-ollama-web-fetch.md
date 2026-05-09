# Ollama Web Fetch Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second production tool (`ollama_web_fetch`) and dev command (`/ollama-fetch`) to this extension while preserving existing `ollama_web_search` behavior.

**Architecture:** Keep the current layered pipeline and add fetch-specific orchestration (`src/fetch.ts`) plus shared client/normalize/format/config updates. Register both tools in `src/index.ts`, with tool-level prompt guidance so pi models can choose search vs fetch correctly.

**Tech Stack:** TypeScript (ESM, NodeNext), typebox schemas, Vitest.

---

## File structure and responsibilities

- Modify: `src/config.ts`
  - Add explicit `searchEndpoint` and `fetchEndpoint` fields.
- Modify: `src/client.ts`
  - Rename shared error type to cover both APIs.
  - Add fetch HTTP client call.
- Create: `src/fetch.ts`
  - Validate fetch input and orchestrate fetch client + normalize + format.
- Modify: `src/normalize.ts`
  - Add fetch response normalization and type.
- Modify: `src/format.ts`
  - Add fetch formatter (title/content/links + truncation cap).
- Modify: `src/search.ts`
  - Use `searchEndpoint` and shared error formatter naming.
- Modify: `src/index.ts`
  - Register `ollama_web_fetch`; add `/ollama-fetch`; add prompt guidance for both tools.
- Modify: `README.md`
  - Document both tools and fetch debug command.

Tests:
- Modify: `test/client.test.ts`
- Modify: `test/normalize.test.ts`
- Modify: `test/format.test.ts`
- Modify: `test/search.test.ts`
- Create: `test/fetch.test.ts`
- Modify: `test/extension.test.ts`

---

### Task 1: Add failing tests for config + client fetch support

**Files:**
- Modify: `test/client.test.ts`
- Modify: `test/config.test.ts`

- [ ] **Step 1: Add config endpoint assertions (failing test first)**

```ts
// test/config.test.ts (add case)
it("loads both search and fetch endpoints", () => {
  const config = loadConfig({ OLLAMA_API_KEY: "k", PI_OLLAMA_SEARCH_DEV: "0" });

  expect(config.searchEndpoint).toBe("https://ollama.com/api/web_search");
  expect(config.fetchEndpoint).toBe("https://ollama.com/api/web_fetch");
});
```

- [ ] **Step 2: Add fetch client request test (failing first)**

```ts
// test/client.test.ts (add case)
it("posts fetch request and returns parsed JSON", async () => {
  server = await startMockServer((request) => {
    expect(request.method).toBe("POST");
    expect(request.url).toBe("/api/web_fetch");
    expect(request.headers.authorization).toBe("Bearer test-key");
    expect(JSON.parse(request.body)).toEqual({ url: "ollama.com" });

    return {
      body: JSON.stringify({
        title: "Ollama",
        content: "Cloud models are now available...",
        links: ["https://ollama.com/"],
      }),
    };
  });

  await expect(
    fetchOllamaWeb({
      endpoint: `${server.url}/api/web_fetch`,
      apiKey: "test-key",
      url: "ollama.com",
    }),
  ).resolves.toEqual({
    title: "Ollama",
    content: "Cloud models are now available...",
    links: ["https://ollama.com/"],
  });
});
```

- [ ] **Step 3: Add fetch typed-error tests (failing first)**

```ts
// test/client.test.ts (add case)
it("throws typed error for fetch non-2xx response", async () => {
  server = await startMockServer(() => ({ status: 403, body: JSON.stringify({ error: "forbidden" }) }));

  await expect(
    fetchOllamaWeb({ endpoint: `${server.url}/api/web_fetch`, apiKey: "bad", url: "https://ollama.com" }),
  ).rejects.toMatchObject({ name: "OllamaWebError", code: "http_error", status: 403 });
});
```

- [ ] **Step 4: Run targeted tests to confirm failure**

Run:
```bash
npm test -- test/config.test.ts test/client.test.ts
```

Expected: FAIL with missing `searchEndpoint`/`fetchEndpoint` and missing `fetchOllamaWeb`/`OllamaWebError` references.

- [ ] **Step 5: Commit failing tests**

```bash
git add test/config.test.ts test/client.test.ts
git commit -m "test: add failing coverage for fetch config and client"
```

---

### Task 2: Implement config + client fetch support

**Files:**
- Modify: `src/config.ts`
- Modify: `src/client.ts`
- Modify: `test/client.test.ts` (import/type rename fixes if needed)
- Modify: `test/config.test.ts` (if fixtures need full object updates)

- [ ] **Step 1: Implement config endpoint split**

```ts
// src/config.ts (shape)
export interface OllamaSearchConfig {
  apiKey?: string;
  devMode: boolean;
  searchEndpoint: string;
  fetchEndpoint: string;
  maxResults: number;
  maxOutputChars: number;
}

export const OLLAMA_WEB_SEARCH_ENDPOINT = "https://ollama.com/api/web_search";
export const OLLAMA_WEB_FETCH_ENDPOINT = "https://ollama.com/api/web_fetch";

export function loadConfig(env: Env = process.env): OllamaSearchConfig {
  return {
    apiKey: optionalTrimmed(env.OLLAMA_API_KEY),
    devMode: isTruthyEnv(env.PI_OLLAMA_SEARCH_DEV),
    searchEndpoint: OLLAMA_WEB_SEARCH_ENDPOINT,
    fetchEndpoint: OLLAMA_WEB_FETCH_ENDPOINT,
    maxResults: DEFAULT_MAX_RESULTS,
    maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS,
  };
}
```

- [ ] **Step 2: Rename shared client error + add fetch client function**

```ts
// src/client.ts (shape)
export class OllamaWebError extends Error { /* same fields/code/status/responseBody */ }

export interface FetchOllamaWebOptions {
  endpoint: string;
  apiKey: string;
  url: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export async function fetchOllamaWeb(options: FetchOllamaWebOptions): Promise<unknown> {
  const fetchFunction = options.fetchImpl ?? fetch;
  const response = await fetchFunction(options.endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ url: options.url }),
    signal: options.signal,
  });
  // same body-reading + non-2xx + invalid-json handling using OllamaWebError
}
```

- [ ] **Step 3: Run targeted tests and verify pass**

Run:
```bash
npm test -- test/config.test.ts test/client.test.ts
```

Expected: PASS for config and client suites.

- [ ] **Step 4: Commit implementation**

```bash
git add src/config.ts src/client.ts test/config.test.ts test/client.test.ts
git commit -m "feat: add fetch endpoint config and HTTP client"
```

---

### Task 3: Add failing tests for fetch normalize/format/orchestration

**Files:**
- Modify: `test/normalize.test.ts`
- Modify: `test/format.test.ts`
- Create: `test/fetch.test.ts`

- [ ] **Step 1: Add fetch normalization tests (failing first)**

```ts
// test/normalize.test.ts (add cases)
it("normalizes valid web fetch response", () => {
  expect(
    normalizeWebFetchResponse({
      title: "  Ollama  ",
      content: "Line 1\r\nLine 2\n\n\nLine 3",
      links: [" https://ollama.com/ ", "https://ollama.com/models"],
    }),
  ).toEqual({
    title: "Ollama",
    content: "Line 1\nLine 2\n\nLine 3",
    links: ["https://ollama.com/", "https://ollama.com/models"],
  });
});
```

- [ ] **Step 2: Add fetch formatting tests (failing first)**

```ts
// test/format.test.ts (add cases)
it("formats fetch result with title content and links", () => {
  const text = formatFetchResult(
    {
      title: "Ollama",
      content: "Main content",
      links: ["https://ollama.com/", "https://ollama.com/models"],
    },
    { maxOutputChars: 10_000 },
  );

  expect(text).toContain("Fetched page:");
  expect(text).toContain("Title: Ollama");
  expect(text).toContain("Content:");
  expect(text).toContain("Links:");
  expect(text).toContain("[1] https://ollama.com/");
});
```

- [ ] **Step 3: Add fetch orchestration test file (failing first)**

```ts
// test/fetch.test.ts
import { describe, expect, it, vi } from "vitest";
import { getMissingApiKeyMessage } from "../src/config.js";
import { runOllamaWebFetch } from "../src/fetch.js";

describe("runOllamaWebFetch", () => {
  it("fails before network calls when API key is missing", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      runOllamaWebFetch("https://ollama.com", {
        config: {
          apiKey: undefined,
          devMode: false,
          searchEndpoint: "https://example.invalid/api/web_search",
          fetchEndpoint: "https://example.invalid/api/web_fetch",
          maxResults: 5,
          maxOutputChars: 50_000,
        },
        fetchImpl,
      }),
    ).rejects.toThrow(getMissingApiKeyMessage());

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: Run targeted tests and verify failure**

Run:
```bash
npm test -- test/normalize.test.ts test/format.test.ts test/fetch.test.ts
```

Expected: FAIL due to missing fetch normalize/format/orchestration exports.

- [ ] **Step 5: Commit failing tests**

```bash
git add test/normalize.test.ts test/format.test.ts test/fetch.test.ts
git commit -m "test: add failing fetch normalize format and orchestration coverage"
```

---

### Task 4: Implement fetch normalize/format/orchestration

**Files:**
- Create: `src/fetch.ts`
- Modify: `src/normalize.ts`
- Modify: `src/format.ts`
- Modify: `src/search.ts`

- [ ] **Step 1: Implement fetch response normalization**

```ts
// src/normalize.ts (additions)
export interface NormalizedFetchResponse {
  title: string;
  content: string;
  links: string[];
}

export function normalizeWebFetchResponse(raw: unknown): NormalizedFetchResponse {
  if (!isRecord(raw)) throw new Error("Unexpected Ollama web fetch response: response must be an object");

  const title = raw.title;
  const content = raw.content;
  const links = raw.links;

  if (typeof title !== "string") throw new Error("Unexpected Ollama web fetch response: title must be a string");
  if (typeof content !== "string") throw new Error("Unexpected Ollama web fetch response: content must be a string");
  if (!Array.isArray(links)) throw new Error("Unexpected Ollama web fetch response: links must be an array");
  if (!links.every((link) => typeof link === "string")) {
    throw new Error("Unexpected Ollama web fetch response: links must contain only strings");
  }

  return {
    title: normalizeCompactText(title),
    content: normalizeContent(content),
    links: links.map((link) => normalizeCompactText(link)),
  };
}
```

- [ ] **Step 2: Implement fetch formatter with shared cap**

```ts
// src/format.ts (additions)
import type { NormalizedFetchResponse, NormalizedSearchResponse } from "./normalize.js";

export function formatFetchResult(response: NormalizedFetchResponse, options: FormatOptions): string {
  const linksSection =
    response.links.length === 0
      ? "No links found."
      : response.links.map((link, index) => `[${index + 1}] ${link}`).join("\n");

  const text = [
    "Fetched page:",
    "",
    `Title: ${response.title}`,
    "",
    "Content:",
    response.content,
    "",
    "Links:",
    linksSection,
  ].join("\n");

  return applySafetyCap(text, options.maxOutputChars);
}
```

- [ ] **Step 3: Implement fetch orchestration and shared error formatter naming**

```ts
// src/fetch.ts
import { getMissingApiKeyMessage, type OllamaSearchConfig } from "./config.js";
import { fetchOllamaWeb } from "./client.js";
import { formatFetchResult } from "./format.js";
import { normalizeWebFetchResponse, type NormalizedFetchResponse } from "./normalize.js";

export interface RunOllamaWebFetchOptions {
  config: OllamaSearchConfig;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface RunOllamaWebFetchResult {
  formatted: string;
  normalized: NormalizedFetchResponse;
}

export async function runOllamaWebFetch(url: string, options: RunOllamaWebFetchOptions): Promise<RunOllamaWebFetchResult> {
  const trimmedUrl = url.trim();
  if (!trimmedUrl) throw new Error("Fetch URL must not be empty.");
  if (!options.config.apiKey) throw new Error(getMissingApiKeyMessage());

  const raw = await fetchOllamaWeb({
    endpoint: options.config.fetchEndpoint,
    apiKey: options.config.apiKey,
    url: trimmedUrl,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
  });

  const normalized = normalizeWebFetchResponse(raw);
  const formatted = formatFetchResult(normalized, { maxOutputChars: options.config.maxOutputChars });
  return { formatted, normalized };
}
```

```ts
// src/search.ts (rename + endpoint)
export function formatOllamaWebError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

// and use options.config.searchEndpoint in runOllamaWebSearch client call
```

- [ ] **Step 4: Run targeted tests and verify pass**

Run:
```bash
npm test -- test/normalize.test.ts test/format.test.ts test/fetch.test.ts test/search.test.ts
```

Expected: PASS for fetch/search normalize/format/orchestration suites.

- [ ] **Step 5: Commit implementation**

```bash
git add src/fetch.ts src/normalize.ts src/format.ts src/search.ts test/normalize.test.ts test/format.test.ts test/fetch.test.ts test/search.test.ts
git commit -m "feat: add fetch pipeline and shared web error formatting"
```

---

### Task 5: Add failing extension tests for new tool and debug command

**Files:**
- Modify: `test/extension.test.ts`

- [ ] **Step 1: Add failing assertions for second production tool**

```ts
it("registers search and fetch production tools", () => {
  const fake = createFakePi();
  extension(fake.pi as any);

  expect(fake.pi.registerTool).toHaveBeenCalledTimes(2);
  expect(fake.tools.map((tool) => tool.name)).toEqual(
    expect.arrayContaining(["ollama_web_search", "ollama_web_fetch"]),
  );
});
```

- [ ] **Step 2: Add failing dev-command coverage for `/ollama-fetch`**

```ts
it("registers search and fetch debug commands when dev mode is enabled", () => {
  process.env.PI_OLLAMA_SEARCH_DEV = "1";
  const fake = createFakePi();
  extension(fake.pi as any);

  expect(fake.pi.registerCommand).toHaveBeenCalledWith("ollama-search", expect.any(Object));
  expect(fake.pi.registerCommand).toHaveBeenCalledWith("ollama-fetch", expect.any(Object));
});
```

- [ ] **Step 3: Run targeted test and verify failure**

Run:
```bash
npm test -- test/extension.test.ts
```

Expected: FAIL because `src/index.ts` still registers only one production tool and one debug command.

- [ ] **Step 4: Commit failing tests**

```bash
git add test/extension.test.ts
git commit -m "test: add failing extension coverage for fetch tool and debug command"
```

---

### Task 6: Implement extension registration and tool guidance

**Files:**
- Modify: `src/index.ts`
- Modify: `test/extension.test.ts` (small assertion text updates if needed)

- [ ] **Step 1: Register `ollama_web_fetch` tool with schema + prompt guidance**

```ts
// src/index.ts (additions)
const FetchParams = Type.Object({
  url: Type.String({ description: "The URL to fetch using Ollama Web Fetch API." }),
});

pi.registerTool({
  name: "ollama_web_fetch",
  label: "Ollama Web Fetch",
  description: "Fetch a single web page using Ollama's Web Fetch API. Returns title, main content, and discovered links.",
  promptSnippet: "Fetch a known URL using Ollama Web Fetch to retrieve fuller page content and links.",
  promptGuidelines: [
    "Use ollama_web_fetch when a specific URL is known and you need the page content or links.",
    "Use ollama_web_fetch after ollama_web_search when search snippets are insufficient.",
  ],
  parameters: FetchParams,
  async execute(_toolCallId, params, signal) {
    const result = await runOllamaWebFetch(params.url, { config, signal });
    return {
      content: [{ type: "text", text: result.formatted }],
      details: result.normalized,
    };
  },
});
```

- [ ] **Step 2: Add `/ollama-fetch` command behind existing dev gate**

```ts
if (config.devMode) {
  pi.registerCommand("ollama-fetch", {
    description: "Run an Ollama web fetch debug request. Enabled by PI_OLLAMA_SEARCH_DEV.",
    handler: async (args, ctx) => {
      try {
        const result = await runOllamaWebFetch(args, { config, signal: ctx.signal });
        pi.sendMessage({
          customType: "ollama-web-fetch-debug",
          content: result.formatted,
          display: true,
          details: result.normalized,
        });
      } catch (error) {
        ctx.ui.notify(formatOllamaWebError(error), "error");
      }
    },
  });
}
```

- [ ] **Step 3: Ensure search tool metadata still clearly differentiates from fetch**

```ts
// src/index.ts (search tool metadata update)
promptGuidelines: [
  "Use ollama_web_search to discover relevant pages or current information when URLs are not known yet.",
  "Use ollama_web_search before ollama_web_fetch when you need candidate URLs first.",
],
```

- [ ] **Step 4: Run targeted extension tests and verify pass**

Run:
```bash
npm test -- test/extension.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit implementation**

```bash
git add src/index.ts test/extension.test.ts
git commit -m "feat: register ollama web fetch tool and debug command"
```

---

### Task 7: Add docs updates and full verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update README tool list and remove v1 no-fetch statement**

```md
## What it provides

This package registers two production tools:

- `ollama_web_search`
- `ollama_web_fetch`
```

- [ ] **Step 2: Add usage examples for search then fetch and dev fetch command**

```md
Example prompts:

```text
Search for recent Ollama engine updates, then fetch the official blog post URL and summarize details.
```

Dev command:

```text
/ollama-fetch https://ollama.com
```
```

- [ ] **Step 3: Update troubleshooting endpoint list**

```md
Check that your network can reach:

```text
https://ollama.com/api/web_search
https://ollama.com/api/web_fetch
```
```

- [ ] **Step 4: Run final verification commands**

Run:
```bash
npm run typecheck
npm test
```

Expected: both commands PASS.

Run:
```bash
npm pack --dry-run
```

Expected: package preview includes `package.json`, `README.md`, and `src/` contents; no unintended files.

- [ ] **Step 5: Commit docs + verification artifacts**

```bash
git add README.md
git commit -m "docs: add web fetch usage and troubleshooting"
```

---

## Final pre-merge checklist

- [ ] `ollama_web_search` behavior unchanged for existing callers.
- [ ] `ollama_web_fetch` registered and callable with `{ url: string }`.
- [ ] `/ollama-fetch` only available when `PI_OLLAMA_SEARCH_DEV=1`.
- [ ] Prompt snippets/guidelines explicitly name `ollama_web_search` and `ollama_web_fetch` use-cases.
- [ ] All tests pass.
- [ ] Typecheck passes.
- [ ] Dry-run package contents are correct.

---

## Self-review

### 1. Spec coverage

- Public interface (second tool + debug command): covered by Tasks 5–6.
- Architecture/pipeline additions (`fetch.ts`, client/normalize/format/config/search): covered by Tasks 1–4.
- Error handling (shared API key messaging + formatter rename + typed client errors): covered by Tasks 2 and 4.
- Tool guidance for model behavior: covered by Task 6.
- Testing and docs updates: covered by Tasks 1, 3, 5, and 7.

No spec gaps found.

### 2. Placeholder scan

Checked for TBD/TODO/ambiguous "later" statements: none.

### 3. Type consistency

- `searchEndpoint`/`fetchEndpoint` used consistently across config, client orchestration, and tests.
- Shared error naming uses `OllamaWebError` + `formatOllamaWebError` consistently.
- Fetch normalized type naming consistent: `NormalizedFetchResponse`.
