import { once } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { CodexClient, CodexRefusalError } from "../../src/services/codex.js";

interface CapturedRequest {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  contentType: string | undefined;
  body: string;
}

type TestHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void | Promise<void>;

const openServers = new Set<Server>();

afterEach(async () => {
  await Promise.all(
    [...openServers].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  openServers.clear();
});

async function withServer<T>(
  handler: TestHandler,
  run: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch((error: unknown) => {
      response.statusCode = 500;
      response.end(
        error instanceof Error ? error.message : "test handler failed",
      );
    });
  });
  openServers.add(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not expose a TCP address");
  }

  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    openServers.delete(server);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function readRequest(request: IncomingMessage): Promise<CapturedRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return {
    method: request.method,
    url: request.url,
    authorization: request.headers.authorization,
    contentType: request.headers["content-type"],
    body: Buffer.concat(chunks).toString("utf8"),
  };
}

function client(baseUrl: string, timeoutMs = 2_000): CodexClient {
  return new CodexClient({
    apiKey: "unit-test-secret",
    baseUrl,
    model: "gpt-5.6",
    reasoningEffort: "high",
    timeoutMs,
  });
}

describe("CodexClient", () => {
  it("sends the exact Responses request and aggregates SSE and raw JSON identically", async () => {
    const requests: CapturedRequest[] = [];
    let callCount = 0;

    await withServer(
      async (request, response) => {
        requests.push(await readRequest(request));
        callCount += 1;

        if (callCount === 1) {
          response.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
          });
          response.write('data: {"type":"response.output_');
          response.write('text.delta","delta":"same "}\r\n\r\n');
          response.write("event: keepalive\r\ndata: not-json\r\n\r\n");
          response.write(
            'event: ignored.custom.event\r\ndata: {"type":"ignored.custom.event","delta":"wrong"}\r\n\r\n',
          );
          response.end(
            'data: {"type":"response.output_text.delta","delta":"output"}\r\n\r\n' +
              'data: {"type":"response.completed","response":{"status":"completed"}}\r\n\r\n',
          );
          return;
        }

        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            id: "resp_raw_fixture",
            status: "completed",
            output_text: "fallback must not replace standard output",
            output: [
              {
                type: "reasoning",
                summary: [{ type: "summary_text", text: "wrong" }],
              },
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "same " }],
              },
              { type: "function_call", name: "wrong", arguments: "{}" },
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "output" }],
              },
            ],
          }),
        );
      },
      async (baseUrl) => {
        const codex = client(`${baseUrl}/v1///`);
        const sseResult = await codex.process(
          "system instructions",
          "page input",
        );
        const jsonResult = await codex.process(
          "system instructions",
          "page input",
        );

        expect(sseResult).toBe("same output");
        expect(jsonResult).toBe(sseResult);
      },
    );

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request).toMatchObject({
        method: "POST",
        url: "/v1/responses",
        authorization: "Bearer unit-test-secret",
        contentType: "application/json",
      });
      expect(JSON.parse(request.body)).toEqual({
        model: "gpt-5.6",
        instructions: "system instructions",
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: "page input" }],
          },
        ],
        stream: true,
        store: false,
        reasoning: { effort: "high" },
      });
    }
  });

  it("uses top-level output_text only after standard output has no text", async () => {
    await withServer(
      (_request, response) => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            status: "completed",
            output: [{ type: "reasoning", summary: [] }],
            output_text: "compatibility fallback",
          }),
        );
      },
      async (baseUrl) => {
        await expect(
          client(baseUrl).process("instructions", "input"),
        ).resolves.toBe("compatibility fallback");
      },
    );
  });

  it("redacts the API key reflected in a successful SSE output", async () => {
    await withServer(
      (_request, response) => {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end(
          'data: {"type":"response.output_text.delta","delta":"reflected unit-test-secret value"}\n\n' +
            'data: {"type":"response.completed"}\n\n',
        );
      },
      async (baseUrl) => {
        const result = await client(baseUrl).process("instructions", "input");

        expect(result).toContain("[REDACTED]");
        expect(result).not.toContain("unit-test-secret");
      },
    );
  });

  it("redacts the API key reflected in a successful raw JSON output", async () => {
    await withServer(
      (_request, response) => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            status: "completed",
            output: [
              {
                type: "message",
                content: [
                  {
                    type: "output_text",
                    text: "reflected unit-test-secret value",
                  },
                ],
              },
            ],
          }),
        );
      },
      async (baseUrl) => {
        const result = await client(baseUrl).process("instructions", "input");

        expect(result).toContain("[REDACTED]");
        expect(result).not.toContain("unit-test-secret");
      },
    );
  });

  it("preserves unrelated Bearer examples in successful output", async () => {
    await withServer(
      (_request, response) => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            status: "completed",
            output: [
              {
                type: "message",
                content: [
                  {
                    type: "output_text",
                    text: "Authorization: Bearer some-example-token",
                  },
                ],
              },
            ],
          }),
        );
      },
      async (baseUrl) => {
        await expect(
          client(baseUrl).process("instructions", "input"),
        ).resolves.toBe("Authorization: Bearer some-example-token");
      },
    );
  });

  it("surfaces SSE and JSON refusal-only responses as CodexRefusalError", async () => {
    let callCount = 0;
    await withServer(
      (_request, response) => {
        callCount += 1;
        if (callCount === 1) {
          response.writeHead(200, { "Content-Type": "text/event-stream" });
          response.end(
            'data: {"type":"response.refusal.delta","delta":"cannot "}\n\n' +
              'data: {"type":"response.refusal.done","refusal":"cannot comply"}\n\n' +
              'data: {"type":"response.completed"}\n\n',
          );
          return;
        }

        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            status: "completed",
            output: [
              {
                type: "message",
                content: [{ type: "refusal", refusal: "policy refusal" }],
              },
            ],
          }),
        );
      },
      async (baseUrl) => {
        for (const expectedRefusal of ["cannot comply", "policy refusal"]) {
          try {
            await client(baseUrl).process("instructions", "input");
            throw new Error("expected CodexRefusalError");
          } catch (error) {
            expect(error).toBeInstanceOf(CodexRefusalError);
            expect(error).toMatchObject({ refusal: expectedRefusal });
            expect((error as Error).message).toContain(expectedRefusal);
          }
        }
      },
    );
  });

  it("rejects failed, incomplete, top-level error, and unterminated SSE streams", async () => {
    const replies = [
      'data: {"type":"response.failed","response":{"error":{"message":"model failed"}}}\n\n',
      'data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"limit"}}}\n\n',
      'data: {"error":{"message":"relay error"}}\n\n',
      'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
    ];
    let callCount = 0;

    await withServer(
      (_request, response) => {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end(replies[callCount]);
        callCount += 1;
      },
      async (baseUrl) => {
        await expect(
          client(baseUrl).process("instructions", "input"),
        ).rejects.toThrow(/failed.*model failed/i);
        await expect(
          client(baseUrl).process("instructions", "input"),
        ).rejects.toThrow(/incomplete.*limit/i);
        await expect(
          client(baseUrl).process("instructions", "input"),
        ).rejects.toThrow(/response error.*relay error/i);
        await expect(
          client(baseUrl).process("instructions", "input"),
        ).rejects.toThrow(/before response\.completed/i);
      },
    );
  });

  it("rejects JSON error states and completed responses without text", async () => {
    const replies = [
      { error: { message: "top-level failure" } },
      { status: "failed", error: null },
      {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      },
      { status: "completed", output: [{ type: "reasoning", summary: [] }] },
    ];
    let callCount = 0;

    await withServer(
      (_request, response) => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(replies[callCount]));
        callCount += 1;
      },
      async (baseUrl) => {
        await expect(
          client(baseUrl).process("instructions", "input"),
        ).rejects.toThrow(/top-level failure/);
        await expect(
          client(baseUrl).process("instructions", "input"),
        ).rejects.toThrow(/failed/i);
        await expect(
          client(baseUrl).process("instructions", "input"),
        ).rejects.toThrow(/incomplete.*max_output_tokens/i);
        await expect(
          client(baseUrl).process("instructions", "input"),
        ).rejects.toThrow(/without output text/i);
      },
    );
  });

  it("summarizes non-2xx bodies without exposing API keys or Authorization values", async () => {
    await withServer(
      (_request, response) => {
        response.writeHead(401, { "Content-Type": "text/plain" });
        response.end(
          `upstream rejected credentials; Authorization: Bearer unit-test-secret; Authorization: Basic unrelated-secret; ${"detail ".repeat(100)}`,
        );
      },
      async (baseUrl) => {
        try {
          await client(baseUrl).process("instructions", "input");
          throw new Error("expected HTTP error");
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          const message = (error as Error).message;
          expect(message).toMatch(/HTTP 401/);
          expect(message).toContain("upstream rejected credentials");
          expect(message).toContain("[REDACTED]");
          expect(message).not.toContain("unit-test-secret");
          expect(message).not.toContain("unrelated-secret");
          expect(message.length).toBeLessThan(650);
        }
      },
    );
  });

  it("redacts JSON Authorization fields including array values", async () => {
    await withServer(
      (_request, response) => {
        response.writeHead(401, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            message: "relay rejected the request",
            headers: {
              authorization: ["Basic unrelated-secret"],
              nested: { Authorization: "Bearer another-secret" },
            },
          }),
        );
      },
      async (baseUrl) => {
        try {
          await client(baseUrl).process("instructions", "input");
          throw new Error("expected HTTP error");
        } catch (error) {
          const message = (error as Error).message;
          expect(message).toContain("relay rejected the request");
          expect(message).toContain("[REDACTED]");
          expect(message).not.toContain("unrelated-secret");
          expect(message).not.toContain("another-secret");
        }
      },
    );
  });

  it("redacts a non-JSON Authorization array representation", async () => {
    await withServer(
      (_request, response) => {
        response.writeHead(401, { "Content-Type": "text/plain" });
        response.end(
          'relay rejected request; authorization=["Basic raw-secret"]',
        );
      },
      async (baseUrl) => {
        await expect(
          client(baseUrl).process("instructions", "input"),
        ).rejects.not.toThrow(/raw-secret/);
      },
    );
  });

  it("aborts a request that exceeds its timeout", async () => {
    await withServer(
      (request) => {
        request.resume();
      },
      async (baseUrl) => {
        await expect(
          client(baseUrl, 60).process("instructions", "input"),
        ).rejects.toThrow(/timed out after 60ms/);
      },
    );
  });
});
