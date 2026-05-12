# @cltec/pi-ollama-web-search

A local-first, context-safe [pi](https://pi.dev) package that exposes Ollama web APIs as custom pi tools.

This package is designed for workflows where model context is scarce, especially when you are running local models. It keeps discovery output compact by default, supports selective follow-up retrieval, and lets fetched content be exported to files when you do not want large payloads in the main model context.

## What it provides

This package registers three production tools:

- `ollama_web_search`
- `ollama_web_fetch`
- `ollama_web_read_full`

Tool behavior:

- `ollama_web_search` accepts a search query and returns compact search results with title, URL, and content snippets.
  - When results are present, tool `details` includes:
    - `fullContentRef`: opaque ref used for follow-up retrieval.
    - `retrieval`: per-result metadata (`resultIndex` + available sections with character counts).
    - `appliedProfile`: the active local-first profile values chosen for the current model.
- `ollama_web_fetch` accepts a URL and returns fetched page title, content, and discovered links.
  - Successful fetch responses include:
    - `fullContentRef`: opaque ref used for follow-up retrieval.
    - target metadata for `title`, `content`, and `links`, including visibility/truncation information.
    - `appliedProfile`: the active fetch budget metadata, including the selected value source and winning matcher when one applies.
- `ollama_web_read_full` accepts a `ref` returned by `ollama_web_search` or `ollama_web_fetch`.
  - Search refs (`ws_s_*`) read exactly one section (`title`, `url`, or `content`) for a 1-based `resultIndex`.
  - Fetch refs (`fetch:*`) read one section (`title`, `content`, or `links`) inline, or export the full section in `mode: "file"`.
    - If `path` is omitted, the tool writes to a generated temp file outside the repo and deletes it at session shutdown.
    - If `path` is provided, the tool resolves it like pi file tools (relative to the current working directory, absolute paths allowed, leading `@` tolerated), creates parent directories automatically, and refuses to overwrite unless `overwrite: true` is passed.
    - `outputPath` is still accepted as a backward-compatible alias, but `path` is canonical.
  - Read-full responses include structured retrieval details.
    - `servedFrom: "cache"` means the ref was still available in memory.
    - `servedFrom: "replay"` means the extension replayed the original search or fetch request after cache loss, so the retrieved web content may have changed.
  - Replay behavior is best-effort: the ref stays stable, but replay can still fail if upstream content changed, the original target can no longer be reconstructed, or the upstream request itself fails.

## Why local-first

Web results can consume context quickly, especially on smaller local models. This package is opinionated about that trade-off:

- keep search output compact by default;
- favor a few useful results over broad, noisy output;
- fetch only when you already know the page you want;
- read one field at a time when you need more detail;
- export large fetched sections to a file instead of forcing them into model context.

The extension does not implement downstream orchestration such as summarization agents or file-analysis pipelines, but it is intentionally shaped to support those workflows cleanly.

## Install

Install from npm:

```bash
pi install npm:@cltec/pi-ollama-web-search
```

Or install directly from GitHub:

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

## Configuration

The extension uses a dedicated config file named `pi-ollama-web-search.json`.

### Global config

On startup, the extension creates a global config file automatically if it does not already exist.

That file lives in pi's active config directory and starts with conservative local-first defaults:

```json
{
  "default": {
    "maxResults": 3,
    "maxOutputChars": 12000
  }
}
```

### Project override config

A repository can override the global defaults with:

```text
.pi/pi-ollama-web-search.json
```

Project config is merged on top of global config, so repository-local policy wins when both are present.

### Model-aware profiles

You can define exact model matches and simple `*` glob patterns using the canonical model key format `provider/id`.

Example:

```json
{
  "default": {
    "maxResults": 3,
    "maxOutputChars": 12000
  },
  "models": {
    "ollama/qwen3:14b": {
      "maxResults": 2,
      "maxOutputChars": 9000
    },
    "ollama/qwen3*": {
      "maxResults": 4,
      "maxOutputChars": 20000
    }
  }
}
```

Matching rules:

- exact match wins over pattern match;
- among matching patterns, the most specific pattern wins;
- if nothing matches, the `default` profile is used.

### Complete overrides, not patches

Each model override must be a complete profile. In other words, model entries are not partial patches: include both `maxResults` and `maxOutputChars` for each override.

### Optional version field

Config files may include a top-level `version` string. If the config major version does not match the installed package major version, the extension warns and still uses the config when it is otherwise structurally valid.

### Invalid config behavior

Invalid config is non-blocking:

- invalid global config falls back to local-first defaults;
- invalid project config falls back to global/default values;
- missing model matches quietly use the default profile;
- if pi cannot determine the current model, the extension warns and uses the default profile.

## Local-first workflow

The intended workflow is:

1. Run `ollama_web_search` first for compact discovery.
2. Use `ollama_web_fetch` only when you have a specific URL or need a fuller page after search.
3. Use `ollama_web_read_full` only with the returned ref, one field at a time.
4. Use `mode: "file"` for large fetch sections you want to inspect outside the main model context.

### Search retrieval flow

1. Run `ollama_web_search` with a query.
2. Read `details.fullContentRef` and `details.retrieval` from the search response.
3. Call `ollama_web_read_full` with:
   - `ref`: the `fullContentRef` value,
   - `resultIndex`: 1-based result number,
   - `section`: one of `title`, `url`, or `content`.
4. If the in-memory search payload has been evicted, `ollama_web_read_full` may replay the original search request and remap the requested `resultIndex` by the original URL occurrence rather than blindly trusting the replayed numeric position.

### Fetch retrieval flow

1. Run `ollama_web_fetch` with a URL.
2. Read `details.fullContentRef` from the fetch response.
3. Call `ollama_web_read_full` with:
   - `ref`: the `fullContentRef` value,
   - `section`: one of `title`, `content`, or `links`.
4. Use `mode: "file"` when you want the full fetch section written to disk instead of returned inline.
5. Optional file-mode controls:
   - Omit `path` to create a temporary export file that is cleaned up at session shutdown.
   - Set `path` to keep a persistent export that remains on disk until you delete it.
   - Set `overwrite: true` only when you intentionally want to replace an existing explicit export file.
6. If the in-memory fetch payload has been evicted, `ollama_web_read_full` may replay the original fetch request. Replay keeps the same ref but can return changed web content, and `details.servedFrom` will be `"replay"`.

## Example prompts

```text
Search for recent Ollama engine updates. Keep the results compact. If the output is truncated, use the returned full-content ref to read the full content for result 1.
```

```text
Search for the latest pi extension docs about themes, then fetch the most relevant result if the snippets are not enough.
```

```text
Fetch https://ollama.com and list the most important links from the page. If the page output is truncated, use the returned ref with ollama_web_read_full section=links.
```

```text
Fetch https://ollama.com/blog and if the content is too large, use ollama_web_read_full with the returned ref in mode=file so the full content is written to a temp file.
```

```text
Fetch https://ollama.com/blog and export the full page content to @artifacts/ollama-blog.txt with ollama_web_read_full mode=file. If the file already exists, only overwrite it when I ask.
```

## Dev mode

Debug slash commands are available only when dev mode is enabled.

Enable it before starting pi:

```bash
export PI_OLLAMA_SEARCH_DEV=1
pi
```

Then run:

```text
/ollama-search what is ollama?
/ollama-fetch https://ollama.com
/ollama-read-full {"ref":"fetch:...","section":"content"}
```

`/ollama-read-full` accepts a JSON object matching the production tool parameters. This gives developers a direct way to verify inline reads, file exports, replay behavior, and temp-file cleanup through the same retrieval path used by `ollama_web_read_full`.

Examples:

```text
/ollama-read-full {"ref":"ws_s_...","resultIndex":1,"section":"content"}
/ollama-read-full {"ref":"fetch:...","section":"links"}
/ollama-read-full {"ref":"fetch:...","section":"content","mode":"file"}
/ollama-read-full {"ref":"fetch:...","section":"content","mode":"file","path":"@artifacts/page.txt"}
```

Debug commands are intended for local testing and troubleshooting. They are not part of the normal user workflow.

Cleanup expectations:

- Temp exports created by `ollama_web_read_full` without `path` are deleted automatically at session shutdown.
- Persistent exports created with explicit `path` are left in place and should be deleted when no longer needed.

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
https://ollama.com/api/web_fetch
```

### Config warnings

Config warnings are non-blocking. If a config file is invalid, the extension continues with safe defaults or higher-level fallback values and surfaces warnings through pi's UI when available.

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

For release/package changes, also run:

```bash
npm pack --dry-run
```

Release instructions are in [`docs/release.md`](docs/release.md).

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
/ollama-fetch https://ollama.com
/ollama-read-full {"ref":"fetch:...","section":"content"}
```
