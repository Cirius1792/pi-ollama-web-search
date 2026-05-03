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
