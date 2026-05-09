export type OllamaWebErrorCode = "http_error" | "invalid_json" | "network_error";

export class OllamaWebError extends Error {
  readonly code: OllamaWebErrorCode;
  readonly status?: number;
  readonly responseBody?: string;

  constructor(message: string, options: { code: OllamaWebErrorCode; status?: number; responseBody?: string; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = "OllamaWebError";
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

export interface FetchOllamaWebOptions {
  endpoint: string;
  apiKey: string;
  url: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

async function readResponseBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return "";
  }
}

async function postOllamaWeb(endpoint: string, init: RequestInit & { fetchImpl?: typeof fetch }): Promise<unknown> {
  const fetchFunction = init.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchFunction(endpoint, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    throw new OllamaWebError(`Failed to reach Ollama Web API: ${error instanceof Error ? error.message : String(error)}`, {
      code: "network_error",
      cause: error,
    });
  }

  const body = await readResponseBody(response);

  if (!response.ok) {
    throw new OllamaWebError(`Ollama Web API returned HTTP ${response.status}${body ? `: ${body}` : ""}`, {
      code: "http_error",
      status: response.status,
      responseBody: body,
    });
  }

  try {
    return body ? JSON.parse(body) : null;
  } catch (error) {
    throw new OllamaWebError("Ollama Web API returned invalid JSON", {
      code: "invalid_json",
      responseBody: body,
      cause: error,
    });
  }
}

export async function searchOllamaWeb(options: SearchOllamaWebOptions): Promise<unknown> {
  return postOllamaWeb(options.endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query: options.query, max_results: options.maxResults }),
    signal: options.signal,
    fetchImpl: options.fetchImpl,
  });
}

export async function fetchOllamaWeb(options: FetchOllamaWebOptions): Promise<unknown> {
  return postOllamaWeb(options.endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ url: options.url }),
    signal: options.signal,
    fetchImpl: options.fetchImpl,
  });
}
