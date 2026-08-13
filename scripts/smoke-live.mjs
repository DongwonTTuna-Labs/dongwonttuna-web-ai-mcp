import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = resolve(projectRoot, "dist/index.js");
const apiKey = process.env.CODEX_API_KEY;

if (!apiKey) {
  console.error("CODEX_API_KEY is required for the live smoke test.");
  process.exit(1);
}

await access(serverPath).catch(() => {
  console.error("dist/index.js is missing; run `npm run build` first.");
  process.exit(1);
});

const smokeMode = process.env.WEBAI_SMOKE_MODE ?? "reader";
if (smokeMode !== "reader" && smokeMode !== "search") {
  console.error("WEBAI_SMOKE_MODE must be reader or search.");
  process.exit(1);
}

const smokeUrl = process.env.WEBAI_SMOKE_URL ?? "https://example.com/";
const smokeInstruction =
  process.env.WEBAI_SMOKE_INSTRUCTION ??
  "Summarize the page's main purpose in one short sentence.";
const smokeQuery =
  process.env.WEBAI_SMOKE_QUERY ??
  "What is the purpose of the Example Domain website?";

if (smokeMode === "reader") {
  if (!smokeInstruction.trim() || smokeInstruction.length > 2000) {
    console.error(
      "WEBAI_SMOKE_INSTRUCTION must contain between 1 and 2000 characters.",
    );
    process.exit(1);
  }

  let parsedSmokeUrl;
  try {
    parsedSmokeUrl = new URL(smokeUrl);
  } catch {
    console.error("WEBAI_SMOKE_URL must be a valid URL.");
    process.exit(1);
  }
  if (
    parsedSmokeUrl.protocol !== "http:" &&
    parsedSmokeUrl.protocol !== "https:"
  ) {
    console.error("WEBAI_SMOKE_URL must use http or https.");
    process.exit(1);
  }
} else if (!smokeQuery.trim() || smokeQuery.length > 500) {
  console.error("WEBAI_SMOKE_QUERY must contain between 1 and 500 characters.");
  process.exit(1);
}

const childEnv = {
  CODEX_API_KEY: apiKey,
  CODEX_BASE_URL: process.env.CODEX_BASE_URL ?? "https://api.openai.com/v1",
  CODEX_MODEL: process.env.CODEX_MODEL ?? "gpt-5.6",
  CODEX_REASONING_EFFORT: process.env.CODEX_REASONING_EFFORT ?? "low",
  CODEX_TIMEOUT_MS: process.env.CODEX_TIMEOUT_MS ?? "180000",
  WEBAI_FETCH_TIMEOUT_MS: process.env.WEBAI_FETCH_TIMEOUT_MS ?? "30000",
  WEBAI_MAX_CONTENT_BYTES: process.env.WEBAI_MAX_CONTENT_BYTES ?? "10485760",
  WEBAI_ALLOW_PRIVATE_NETWORKS:
    process.env.WEBAI_ALLOW_PRIVATE_NETWORKS ?? "false",
};

for (const name of ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"]) {
  const value = process.env[name];
  if (value !== undefined) {
    childEnv[name] = value;
  }
}

const redact = (value) => String(value).split(apiKey).join("[REDACTED]");
const sanitizeResultText = (value) =>
  redact(value).replace(
    /authorization(?:\s*[:=]\s*|["']?\s*:\s*["']?)bearer\s+[^\s"']+/gi,
    "Authorization: Bearer [REDACTED]",
  );
const client = new Client({ name: "webai-live-smoke", version: "0.1.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: projectRoot,
  env: childEnv,
  stderr: "pipe",
});
let serverStderr = "";
transport.stderr?.setEncoding("utf8");
transport.stderr?.on("data", (chunk) => {
  serverStderr += chunk;
});

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const toolName =
    smokeMode === "search" ? "webai_search_web" : "webai_read_url";
  if (!listed.tools.some((tool) => tool.name === toolName)) {
    throw new Error(`The server did not advertise ${toolName}`);
  }

  const result = await client.callTool({
    name: toolName,
    arguments:
      smokeMode === "search"
        ? {
            query: smokeQuery,
            response_format: "markdown",
            max_length: 2000,
          }
        : {
            url: smokeUrl,
            instruction: smokeInstruction,
            response_format: "markdown",
            max_length: 2000,
          },
  });

  const text = result.content.find((item) => item.type === "text")?.text;
  if (result.isError) {
    throw new Error(text || `${toolName} returned an unspecified tool error`);
  }
  if (!text?.trim()) {
    throw new Error(`${toolName} returned no text content`);
  }

  const structured = result.structuredContent;
  if (!structured || typeof structured !== "object") {
    throw new Error(`${toolName} returned no structuredContent`);
  }
  if (typeof structured.model_used !== "string" || !structured.model_used) {
    throw new Error(`${toolName} did not report model_used`);
  }

  let summary;
  if (smokeMode === "search") {
    if (typeof structured.answer !== "string") {
      throw new Error("webai_search_web returned no structured answer");
    }
    if (!Array.isArray(structured.sources)) {
      throw new Error("webai_search_web returned no structured source list");
    }
    summary = {
      ok: true,
      mode: smokeMode,
      query: structured.query,
      model_used: structured.model_used,
      source_count: structured.sources.length,
      answer_preview: sanitizeResultText(structured.answer.slice(0, 500)),
    };
  } else {
    summary = {
      ok: true,
      mode: smokeMode,
      url: structured.url,
      final_url: structured.final_url,
      model_used: structured.model_used,
      content_preview: sanitizeResultText(text.slice(0, 500)),
    };
  }
  console.log(redact(JSON.stringify(summary, null, 2)));
} catch (error) {
  const detail = error instanceof Error ? error.stack || error.message : error;
  const serverDetail = serverStderr.trim();
  const suffix = serverDetail ? `\nServer stderr: ${serverDetail}` : "";
  console.error(`Live smoke failed: ${redact(`${detail}${suffix}`)}`);
  process.exitCode = 1;
} finally {
  try {
    await client.close();
  } catch (error) {
    const detail =
      error instanceof Error ? error.stack || error.message : error;
    console.error(`Failed to close the smoke client: ${redact(detail)}`);
    process.exitCode = 1;
  }
}
