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
