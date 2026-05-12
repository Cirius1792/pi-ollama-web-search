# @cltec/pi-ollama-web-search

A reusable [pi](https://pi.dev) package that exposes Ollama web APIs as custom pi tools.

## What it provides

This package registers three production tools:

- `ollama_web_search`
- `ollama_web_fetch`
- `ollama_web_read_full`

Tool behavior:

- `ollama_web_search` accepts a search query and returns web results with title, URL, and content snippets.
  - When results are present, tool `details` includes:
    - `fullContentRef`: opaque ref used for follow-up retrieval.
    - `retrieval`: per-result metadata (`resultIndex` + available sections with character counts).
    - `appliedProfile`: the active profile values chosen for the current model.
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

## Usage

Ask pi questions that benefit from web search or page fetch.

The extension includes prompt guidance so pi proactively uses tools when appropriate:

- `ollama_web_search` for unknown URLs, documentation/reference lookup, and requests about latest/current/recent information.
- `ollama_web_fetch` when a URL is known (or provided by the user), and before quoting/summarizing details from a specific page.
- `ollama_web_read_full` after search or fetch truncation (or when more detail is needed) to retrieve one field at a time from a previous result/page.

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

Example prompts:

```text
Search for recent Ollama engine updates. If the output is truncated, use the returned full-content ref to read the full content for result 1.
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
