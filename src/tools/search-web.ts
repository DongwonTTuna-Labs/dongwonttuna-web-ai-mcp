import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import {
  DEFAULT_MAX_LENGTH,
  SEARCH_SYSTEM_INSTRUCTIONS,
} from "../constants.js";
import { CodexClient, type CodexSearchResult } from "../services/codex.js";

export const searchWebInputSchema = z
  .object({
    query: z.string().min(1).max(500),
    response_format: z.enum(["markdown", "json"]).default("markdown"),
    max_length: z.number().int().min(1).max(50_000).default(DEFAULT_MAX_LENGTH),
  })
  .strict();

const searchSourceSchema = z
  .object({
    url: z.string(),
    title: z.string().optional(),
  })
  .strict();

export const searchWebOutputSchema = z
  .object({
    query: z.string(),
    answer: z.string(),
    sources: z.array(searchSourceSchema),
    truncated: z.boolean(),
    model_used: z.string(),
  })
  .strict();

export type SearchWebInput = z.infer<typeof searchWebInputSchema>;
export type SearchWebOutput = z.infer<typeof searchWebOutputSchema>;

type SearchClient = Pick<CodexClient, "search">;

export function createSearchWebResult(
  input: SearchWebInput,
  result: CodexSearchResult,
  model: string,
): CallToolResult {
  const structured: SearchWebOutput = {
    query: input.query,
    answer: result.text.slice(0, input.max_length),
    sources: result.citations,
    truncated: result.text.length > input.max_length,
    model_used: model,
  };

  const text =
    input.response_format === "json"
      ? JSON.stringify(structured)
      : formatMarkdown(structured);
  return {
    content: [{ type: "text", text }],
    structuredContent: structured,
  };
}

export async function executeSearchWeb(
  input: SearchWebInput,
  model: string,
  codex: SearchClient,
): Promise<CallToolResult> {
  try {
    const result = await codex.search(SEARCH_SYSTEM_INSTRUCTIONS, input.query);
    return createSearchWebResult(input, result, model);
  } catch (error) {
    return {
      content: [{ type: "text", text: formatExecutionError(error) }],
      isError: true,
    };
  }
}

export function registerSearchWebTool(
  server: McpServer,
  config: AppConfig,
): void {
  const codex = new CodexClient({
    apiKey: config.codexApiKey,
    baseUrl: config.codexBaseUrl,
    model: config.codexModel,
    reasoningEffort: config.codexReasoningEffort,
    timeoutMs: config.codexTimeoutMs,
  });

  server.registerTool(
    "webai_search_web",
    {
      title: "Search the web",
      description:
        "Search the web with a Codex model and return an evidence-based answer with source URLs.",
      inputSchema: searchWebInputSchema,
      outputSchema: searchWebOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input): Promise<CallToolResult> =>
      executeSearchWeb(input, config.codexModel, codex),
  );
}

function formatMarkdown(output: SearchWebOutput): string {
  const sources = output.sources.map((source, index) =>
    source.title === undefined
      ? `${index + 1}. ${source.url}`
      : `${index + 1}. [${source.title}](${source.url})`,
  );
  return `${output.answer}\n\n## Sources${
    sources.length > 0 ? `\n${sources.join("\n")}` : ""
  }`;
}

function formatExecutionError(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown error";
  if (/timed out/i.test(message)) {
    return `webai_search_web failed: ${message}. Please retry the request.`;
  }
  return `webai_search_web failed: ${message}`;
}
