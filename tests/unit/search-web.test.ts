import { describe, expect, it, vi } from "vitest";
import { SEARCH_SYSTEM_INSTRUCTIONS } from "../../src/constants.js";
import { CodexClient } from "../../src/services/codex.js";
import {
  createSearchWebResult,
  executeSearchWeb,
  searchWebInputSchema,
} from "../../src/tools/search-web.js";

function resultText(result: { content?: unknown }): string {
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

describe("webai_search_web", () => {
  it("publishes strict input limits and applies defaults", () => {
    expect(searchWebInputSchema.parse({ query: "test query" })).toEqual({
      query: "test query",
      response_format: "markdown",
      max_length: 20_000,
    });
    expect(searchWebInputSchema.safeParse({ query: "" }).success).toBe(false);
    expect(
      searchWebInputSchema.safeParse({ query: "x".repeat(501) }).success,
    ).toBe(false);
    expect(
      searchWebInputSchema.safeParse({ query: "test", extra: true }).success,
    ).toBe(false);
  });

  it("limits only the answer and appends complete Markdown sources", () => {
    const input = searchWebInputSchema.parse({
      query: "test query",
      max_length: 4,
    });
    const result = createSearchWebResult(
      input,
      {
        text: "abcdef",
        citations: [
          { url: "https://example.test/one", title: "First source" },
          { url: "https://example.test/two" },
        ],
      },
      "gpt-5.6-sol",
    );

    expect(result.structuredContent).toEqual({
      query: "test query",
      answer: "abcd",
      sources: [
        { url: "https://example.test/one", title: "First source" },
        { url: "https://example.test/two" },
      ],
      truncated: true,
      model_used: "gpt-5.6-sol",
    });
    expect(resultText(result)).toBe(
      "abcd\n\n## Sources\n1. [First source](https://example.test/one)\n2. https://example.test/two",
    );
  });

  it("keeps the JSON envelope valid while limiting only answer", () => {
    const input = searchWebInputSchema.parse({
      query: "json query",
      response_format: "json",
      max_length: 2,
    });
    const result = createSearchWebResult(
      input,
      {
        text: "long answer",
        citations: [
          { url: "https://example.test/source", title: "Complete title" },
        ],
      },
      "gpt-5.6",
    );
    const envelope = JSON.parse(resultText(result));

    expect(envelope).toEqual(result.structuredContent);
    expect(envelope.answer).toBe("lo");
    expect(envelope.sources).toEqual([
      { url: "https://example.test/source", title: "Complete title" },
    ]);
    expect(envelope.truncated).toBe(true);
  });

  it("returns an empty source list as a successful response", async () => {
    const search = vi.fn().mockResolvedValue({
      text: "Answer without a search call.",
      citations: [],
    });
    const input = searchWebInputSchema.parse({ query: "optional search" });
    const result = await executeSearchWeb(input, "gpt-5.6", { search });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      answer: "Answer without a search call.",
      sources: [],
      truncated: false,
    });
    expect(resultText(result)).toBe(
      "Answer without a search call.\n\n## Sources",
    );
    expect(search).toHaveBeenCalledWith(
      SEARCH_SYSTEM_INSTRUCTIONS,
      "optional search",
    );
  });

  it("deduplicates source URLs first-wins through the Codex search path", async () => {
    const url = "https://example.test/source";
    const sse = [
      'data: {"type":"response.output_text.delta","delta":"answer"}',
      "",
      `data: ${JSON.stringify({
        type: "response.output_text.annotation.added",
        annotation: { type: "url_citation", url, title: "First title" },
      })}`,
      "",
      `data: ${JSON.stringify({
        type: "response.output_text.annotation.added",
        annotation: { type: "url_citation", url, title: "Later title" },
      })}`,
      "",
      'data: {"type":"response.completed","response":{"output":[]}}',
      "",
      "",
    ].join("\n");
    const codex = new CodexClient({
      apiKey: "test-secret",
      baseUrl: "https://relay.invalid/v1",
      model: "gpt-5.6",
      reasoningEffort: "low",
      timeoutMs: 2_000,
      fetchImpl: async () =>
        new Response(sse, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
    });
    const input = searchWebInputSchema.parse({ query: "dedupe query" });
    const result = await executeSearchWeb(input, "gpt-5.6", codex);

    expect(result.structuredContent).toMatchObject({
      sources: [{ url, title: "First title" }],
    });
  });

  it("maps Codex execution failures to the tool error channel", async () => {
    const input = searchWebInputSchema.parse({ query: "failing query" });
    const result = await executeSearchWeb(input, "gpt-5.6", {
      search: vi.fn().mockRejectedValue(new Error("timed out after 10ms")),
    });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(
      /webai_search_web failed: timed out after 10ms.*retry/i,
    );
  });
});
