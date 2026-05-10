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
- `ollama_web_fetch` accepts a URL and returns fetched page title, content, and discovered links.
- `ollama_web_read_full` accepts a `fullContentRef` from search and retrieves exactly one section (`title`, `url`, or `content`) for a 1-based `resultIndex`.

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
- `ollama_web_read_full` after search truncation (or when more detail is needed) to retrieve one field from one search result at a time.

### Search retrieval flow

1. Run `ollama_web_search` with a query.
2. Read `details.fullContentRef` and `details.retrieval` from the search response.
3. Call `ollama_web_read_full` with:
   - `ref`: the `fullContentRef` value,
   - `resultIndex`: 1-based result number,
   - `section`: one of `title`, `url`, or `content`.

Example prompts:

```text
Search for recent Ollama engine updates. If the output is truncated, use the returned full-content ref to read the full content for result 1.
```

```text
Fetch https://ollama.com and list the most important links from the page.
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
```

Debug commands are intended for local testing and troubleshooting. They are not part of the normal user workflow.

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
```
