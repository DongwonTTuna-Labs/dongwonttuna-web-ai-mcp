import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const serverPath = resolve(projectRoot, "dist/index.js");
const articlePath = resolve(projectRoot, "tests/fixtures/article.html");

let fixtureServer: Server;
let fixtureOrigin: string;

beforeAll(async () => {
  const article = await readFile(articlePath);
  fixtureServer = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/page") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(article);
      return;
    }

    if (request.method === "POST" && request.url === "/responses") {
      let requestBody = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        requestBody += chunk;
      });
      request.on("end", () => {
        let body: { tools?: unknown };
        try {
          body = JSON.parse(requestBody);
        } catch {
          response.writeHead(400, { "Content-Type": "text/plain" });
          response.end("invalid request JSON");
          return;
        }

        const isSearch =
          JSON.stringify(body.tools) ===
          JSON.stringify([{ type: "web_search" }]);
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        });
        response.end(
          (isSearch
            ? [
                'data: {"type":"response.web_search_call.in_progress"}',
                "",
                'data: {"type":"response.output_text.delta","delta":"Mocked search answer."}',
                "",
                'data: {"type":"response.output_text.annotation.added","annotation":{"type":"url_citation","url":"https://example.test/first","title":"First source","start_index":0,"end_index":6}}',
                "",
                'data: {"type":"response.output_text.annotation.added","annotation":{"type":"url_citation","url":"https://example.test/second"}}',
                "",
                'data: {"type":"response.output_text.annotation.added","annotation":{"type":"url_citation","url":"https://example.test/first","title":"Duplicate source"}}',
                "",
                'data: {"type":"response.completed","response":{"status":"completed","output":[]}}',
                "",
                "",
              ]
            : [
                'data: {"type":"response.output_text.delta","delta":"Mocked Codex summary."}',
                "",
                'data: {"type":"response.completed","response":{"status":"completed"}}',
                "",
                "",
              ]
          ).join("\n"),
        );
      });
      return;
    }

    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("not found");
  });

  await new Promise<void>((resolveListen, reject) => {
    fixtureServer.once("error", reject);
    fixtureServer.listen(0, "127.0.0.1", () => {
      fixtureServer.off("error", reject);
      resolveListen();
    });
  });
  const address = fixtureServer.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture server did not expose a TCP address");
  }
  fixtureOrigin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolveClose, reject) => {
    fixtureServer.close((error) => (error ? reject(error) : resolveClose()));
  });
});

function childEnvironment(): Record<string, string> {
  return {
    ...getDefaultEnvironment(),
    CODEX_API_KEY: "integration-placeholder",
    CODEX_BASE_URL: fixtureOrigin,
    CODEX_MODEL: "gpt-5.6",
    CODEX_REASONING_EFFORT: "low",
    CODEX_TIMEOUT_MS: "2000",
    WEBAI_FETCH_TIMEOUT_MS: "2000",
    WEBAI_MAX_CONTENT_BYTES: "1048576",
    WEBAI_ALLOW_PRIVATE_NETWORKS: "true",
  };
}

function textFromResult(result: { content?: unknown }): string {
  if (!Array.isArray(result.content)) {
    return "";
  }
  const block = result.content.find(
    (item): item is { type: "text"; text: string } =>
      typeof item === "object" &&
      item !== null &&
      "type" in item &&
      item.type === "text" &&
      "text" in item &&
      typeof item.text === "string",
  );
  return block?.text ?? "";
}

describe("stdio MCP server", () => {
  it("initializes, advertises a strict schema, and reads a localhost fixture", async () => {
    const client = new Client({ name: "integration-client", version: "0.1.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverPath],
      cwd: projectRoot,
      env: childEnvironment(),
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    try {
      await client.connect(transport);
      expect(client.getServerVersion()).toEqual({
        name: "dongwonttuna-web-ai-mcp",
        version: "0.1.0",
      });

      const listed = await client.listTools();
      expect(listed.tools).toHaveLength(2);
      const tool = listed.tools.find(
        (candidate) => candidate.name === "webai_read_url",
      );
      expect(tool?.name).toBe("webai_read_url");
      expect(tool?.inputSchema).toMatchObject({
        type: "object",
        required: expect.arrayContaining(["url"]),
        additionalProperties: false,
        properties: { url: expect.any(Object) },
      });
      expect(tool?.outputSchema).toMatchObject({
        type: "object",
        properties: { content: expect.any(Object) },
      });

      const searchTool = listed.tools.find(
        (candidate) => candidate.name === "webai_search_web",
      );
      expect(searchTool?.inputSchema).toMatchObject({
        type: "object",
        required: expect.arrayContaining(["query"]),
        additionalProperties: false,
        properties: { query: expect.any(Object) },
      });
      expect(searchTool?.outputSchema).toMatchObject({
        type: "object",
        properties: {
          answer: expect.any(Object),
          sources: expect.any(Object),
        },
      });
      expect(searchTool?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      });

      const direct = await client.callTool({
        name: "webai_read_url",
        arguments: {
          url: `${fixtureOrigin}/page`,
          response_format: "markdown",
          max_length: 500,
        },
      });
      expect(direct.isError).not.toBe(true);
      expect(textFromResult(direct)).toContain(
        "Researchers have mapped a thriving garden",
      );
      expect(direct.structuredContent).toMatchObject({
        url: `${fixtureOrigin}/page`,
        final_url: `${fixtureOrigin}/page`,
        content_type: "text/html",
        extraction: "readability",
      });

      const jsonResult = await client.callTool({
        name: "webai_read_url",
        arguments: {
          url: `${fixtureOrigin}/page`,
          response_format: "json",
          max_length: 10,
        },
      });
      expect(jsonResult.isError).not.toBe(true);
      const jsonEnvelope = JSON.parse(textFromResult(jsonResult));
      expect(jsonEnvelope).toMatchObject({
        content: expect.any(String),
        truncated: true,
        next_start_index: 10,
      });
      expect(jsonEnvelope.content).toHaveLength(10);
      expect(jsonResult.structuredContent).toEqual(jsonEnvelope);

      const instructed = await client.callTool({
        name: "webai_read_url",
        arguments: {
          url: `${fixtureOrigin}/page`,
          instruction: "Summarize the page.",
          max_length: 10,
        },
      });
      expect(instructed.isError).not.toBe(true);
      expect(textFromResult(instructed)).toBe("Mocked Cod");
      expect(instructed.structuredContent).toMatchObject({
        content: "Mocked Cod",
        truncated: true,
        model_used: "gpt-5.6",
        model_input_truncated: false,
      });
      expect(instructed.structuredContent).not.toHaveProperty(
        "next_start_index",
      );

      const invalidCombination = await client.callTool({
        name: "webai_read_url",
        arguments: {
          url: `${fixtureOrigin}/page`,
          instruction: "Summarize the page.",
          start_index: 0,
        },
      });
      expect(invalidCombination.isError).toBe(true);
      expect(textFromResult(invalidCombination)).toMatch(
        /MCP error -32602: Input validation error/,
      );

      const searched = await client.callTool({
        name: "webai_search_web",
        arguments: {
          query: "Find a mocked answer.",
          response_format: "json",
          max_length: 13,
        },
      });
      expect(searched.isError).not.toBe(true);
      const searchEnvelope = JSON.parse(textFromResult(searched));
      expect(searchEnvelope).toEqual(searched.structuredContent);
      expect(searchEnvelope).toEqual({
        query: "Find a mocked answer.",
        answer: "Mocked search",
        sources: [
          {
            url: "https://example.test/first",
            title: "First source",
          },
          { url: "https://example.test/second" },
        ],
        truncated: true,
        model_used: "gpt-5.6",
      });
      await expect
        .poll(() => stderr, { timeout: 2_000 })
        .toContain("dongwonttuna-web-ai-mcp 0.1.0 started on stdio");
    } finally {
      await client.close();
    }
  });

  it("exits with code 1 and a clear stderr error when the API key is missing", async () => {
    const sanitizedEnv = getDefaultEnvironment();
    delete sanitizedEnv.CODEX_API_KEY;

    const outcome = await new Promise<{ code: number | null; stderr: string }>(
      (resolveExit, reject) => {
        const child = spawn(process.execPath, [serverPath], {
          cwd: projectRoot,
          env: sanitizedEnv,
          stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", (chunk) => {
          stderr += chunk.toString();
        });
        child.once("error", reject);
        child.once("close", (code) => resolveExit({ code, stderr }));
      },
    );

    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain("configuration error");
    expect(outcome.stderr).toContain("CODEX_API_KEY is required");
  });
});
