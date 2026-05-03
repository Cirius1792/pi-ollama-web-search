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
