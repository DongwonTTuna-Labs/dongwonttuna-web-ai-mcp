export type CodexReasoningEffort = "low" | "medium" | "high";

export interface CodexClientOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  reasoningEffort: CodexReasoningEffort;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export interface CodexCitation {
  url: string;
  title?: string;
}

export interface CodexSearchResult {
  text: string;
  citations: CodexCitation[];
}

export class CodexRefusalError extends Error {
  readonly refusal: string;

  constructor(refusal: string) {
    super(`Codex refused the request: ${refusal}`);
    this.name = "CodexRefusalError";
    this.refusal = refusal;
  }
}

interface SseEvent {
  event?: string;
  data: string;
}

interface SseState {
  outputText: string;
  refusalText: string;
  citations: CodexCitation[];
  seenCitationUrls: Set<string>;
}

const ERROR_BODY_SUMMARY_LIMIT = 500;

export class CodexClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly reasoningEffort: CodexReasoningEffort;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CodexClientOptions) {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new Error("Codex timeoutMs must be a positive number");
    }

    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.model = options.model;
    this.reasoningEffort = options.reasoningEffort;
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async process(instructions: string, input: string): Promise<string> {
    return (await this.request(instructions, input, false)).text;
  }

  async search(
    instructions: string,
    input: string,
  ): Promise<CodexSearchResult> {
    return this.request(instructions, input, true);
  }

  private async request(
    instructions: string,
    input: string,
    webSearch: boolean,
  ): Promise<CodexSearchResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          buildRequestBody(
            this.model,
            this.reasoningEffort,
            instructions,
            input,
            webSearch,
          ),
        ),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(await this.formatHttpError(response));
      }

      const contentType =
        response.headers.get("content-type")?.toLowerCase() ?? "";
      const output = contentType.includes("text/event-stream")
        ? await parseSseResponse(response)
        : await parseJsonResponse(response);
      return redactSuccessfulResult(output, this.apiKey);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Codex request timed out after ${this.timeoutMs}ms`);
      }

      if (error instanceof CodexRefusalError) {
        throw new CodexRefusalError(
          redactSensitive(error.refusal, this.apiKey),
        );
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new Error(redactSensitive(message, this.apiKey));
    } finally {
      clearTimeout(timeout);
    }
  }

  private async formatHttpError(response: Response): Promise<string> {
    let responseBody: string;
    try {
      responseBody = await response.text();
    } catch {
      responseBody = "";
    }

    const summary = summarizeErrorBody(responseBody, this.apiKey);
    return `Codex Responses API returned HTTP ${response.status}${
      response.statusText ? ` ${response.statusText}` : ""
    }: ${summary}`;
  }
}

function buildRequestBody(
  model: string,
  reasoningEffort: CodexReasoningEffort,
  instructions: string,
  input: string,
  webSearch: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    instructions,
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: input }],
      },
    ],
    stream: true,
    store: false,
    reasoning: { effort: reasoningEffort },
  };
  if (webSearch) {
    body.tools = [{ type: "web_search" }];
  }
  return body;
}

async function parseSseResponse(
  response: Response,
): Promise<CodexSearchResult> {
  if (!response.body) {
    throw new Error("Codex SSE response had no body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const state = createSseState();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });

    let boundary = findSseBoundary(buffer);
    while (boundary) {
      const block = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.length);
      const event = parseSseEvent(block);
      if (event && consumeSseEvent(event, state)) {
        await reader.cancel();
        return finishResponse(
          state.outputText,
          state.refusalText,
          state.citations,
        );
      }
      boundary = findSseBoundary(buffer);
    }

    if (done) {
      const event = parseSseEvent(buffer);
      if (event && consumeSseEvent(event, state)) {
        return finishResponse(
          state.outputText,
          state.refusalText,
          state.citations,
        );
      }
      throw new Error("Codex SSE stream ended before response.completed");
    }
  }
}

function createSseState(): SseState {
  return {
    outputText: "",
    refusalText: "",
    citations: [],
    seenCitationUrls: new Set(),
  };
}

function findSseBoundary(
  value: string,
): { index: number; length: number } | undefined {
  const match = /\r?\n\r?\n/.exec(value);
  if (!match || match.index === undefined) {
    return undefined;
  }
  return { index: match.index, length: match[0].length };
}

function parseSseEvent(block: string): SseEvent | undefined {
  let event: string | undefined;
  const data: string[] = [];

  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith(":")) {
      continue;
    }
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      const value = line.slice("data:".length);
      data.push(value.startsWith(" ") ? value.slice(1) : value);
    }
  }

  if (data.length === 0) {
    return undefined;
  }
  const parsed: SseEvent = { data: data.join("\n") };
  if (event !== undefined) {
    parsed.event = event;
  }
  return parsed;
}

function consumeSseEvent(event: SseEvent, state: SseState): boolean {
  if (event.data === "[DONE]") {
    return false;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(event.data);
  } catch {
    if (event.event !== undefined && !isHandledSseType(event.event)) {
      return false;
    }
    throw new Error("Codex SSE response contained invalid JSON");
  }

  if (!isRecord(payload)) {
    if (event.event !== undefined && !isHandledSseType(event.event)) {
      return false;
    }
    throw new Error("Codex SSE response contained an invalid event payload");
  }
  const type = typeof payload.type === "string" ? payload.type : event.event;
  if (type?.startsWith("response.web_search_call.")) {
    return false;
  }
  if (payload.error != null) {
    throw new Error(`Codex response error: ${describeError(payload.error)}`);
  }

  switch (type) {
    case "response.output_text.delta": {
      if (typeof payload.delta !== "string") {
        throw new Error("Codex output_text delta did not contain text");
      }
      state.outputText += payload.delta;
      return false;
    }
    case "response.output_text.annotation.added":
      addCitation(state, payload.annotation);
      return false;
    case "response.refusal.delta": {
      if (typeof payload.delta !== "string") {
        throw new Error("Codex refusal delta did not contain text");
      }
      state.refusalText += payload.delta;
      return false;
    }
    case "response.refusal.done": {
      const refusal =
        typeof payload.refusal === "string" ? payload.refusal : undefined;
      if (refusal !== undefined) {
        state.refusalText = mergeCompletedRefusal(state.refusalText, refusal);
      }
      return false;
    }
    case "response.completed":
      return true;
    case "response.failed":
      throw new Error(`Codex response failed: ${describeFailure(payload)}`);
    case "response.incomplete":
      throw new Error(
        `Codex response was incomplete: ${describeFailure(payload)}`,
      );
    case "error":
      throw new Error(`Codex response error: ${describeError(payload)}`);
    default:
      return false;
  }
}

function isHandledSseType(type: string): boolean {
  return (
    type === "response.output_text.delta" ||
    type === "response.output_text.annotation.added" ||
    type === "response.refusal.delta" ||
    type === "response.refusal.done" ||
    type === "response.completed" ||
    type === "response.failed" ||
    type === "response.incomplete" ||
    type === "error"
  );
}

async function parseJsonResponse(
  response: Response,
): Promise<CodexSearchResult> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Codex response contained invalid JSON");
  }

  if (!isRecord(payload)) {
    throw new Error("Codex response JSON was not an object");
  }
  if (payload.error != null) {
    throw new Error(`Codex response error: ${describeError(payload.error)}`);
  }

  if (payload.status !== "completed") {
    if (payload.status === "failed") {
      throw new Error(`Codex response failed: ${describeFailure(payload)}`);
    }
    if (payload.status === "incomplete") {
      throw new Error(
        `Codex response was incomplete: ${describeFailure(payload)}`,
      );
    }
    const status =
      typeof payload.status === "string" ? payload.status : "missing";
    throw new Error(`Codex response did not complete (status: ${status})`);
  }

  const outputText: string[] = [];
  const refusalText: string[] = [];
  const state = createSseState();
  if (Array.isArray(payload.output)) {
    for (const item of payload.output) {
      if (
        !isRecord(item) ||
        item.type !== "message" ||
        !Array.isArray(item.content)
      ) {
        continue;
      }
      for (const part of item.content) {
        if (!isRecord(part)) {
          continue;
        }
        if (Array.isArray(part.annotations)) {
          for (const annotation of part.annotations) {
            addCitation(state, annotation);
          }
        }
        if (part.type === "output_text" && typeof part.text === "string") {
          outputText.push(part.text);
        } else if (
          part.type === "refusal" &&
          typeof part.refusal === "string"
        ) {
          refusalText.push(part.refusal);
        }
      }
    }
  }

  const standardOutput = outputText.join("");
  const fallbackOutput =
    typeof payload.output_text === "string" ? payload.output_text : "";
  return finishResponse(
    standardOutput || fallbackOutput,
    refusalText.join(""),
    state.citations,
  );
}

function finishResponse(
  outputText: string,
  refusalText: string,
  citations: CodexCitation[],
): CodexSearchResult {
  if (outputText.length > 0) {
    return { text: outputText, citations };
  }
  if (refusalText.length > 0) {
    throw new CodexRefusalError(refusalText);
  }
  throw new Error("Codex response completed without output text");
}

function addCitation(state: SseState, annotation: unknown): void {
  if (
    !isRecord(annotation) ||
    annotation.type !== "url_citation" ||
    typeof annotation.url !== "string" ||
    annotation.url.length === 0 ||
    state.seenCitationUrls.has(annotation.url)
  ) {
    return;
  }

  state.seenCitationUrls.add(annotation.url);
  const citation: CodexCitation = { url: annotation.url };
  if (typeof annotation.title === "string") {
    citation.title = annotation.title;
  }
  state.citations.push(citation);
}

function mergeCompletedRefusal(
  deltaText: string,
  completedText: string,
): string {
  if (deltaText.length === 0 || completedText.startsWith(deltaText)) {
    return completedText;
  }
  if (deltaText.endsWith(completedText)) {
    return deltaText;
  }
  return `${deltaText}${completedText}`;
}

function describeFailure(payload: Record<string, unknown>): string {
  const response = isRecord(payload.response) ? payload.response : payload;
  if (response.error != null) {
    return describeError(response.error);
  }
  if (response.incomplete_details != null) {
    return describeError(response.incomplete_details);
  }
  return "the API did not provide failure details";
}

function describeError(error: unknown): string {
  if (typeof error === "string" && error.length > 0) {
    return error;
  }
  if (isRecord(error)) {
    for (const key of ["message", "reason", "code", "type"] as const) {
      const value = error[key];
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    }
  }
  return "the API did not provide error details";
}

function summarizeErrorBody(body: string, apiKey: string): string {
  let safeBody: string;
  try {
    safeBody = JSON.stringify(redactAuthorizationFields(JSON.parse(body)));
  } catch {
    safeBody = body;
  }
  const normalized = redactSensitive(safeBody, apiKey)
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length === 0) {
    return "empty response body";
  }
  if (normalized.length <= ERROR_BODY_SUMMARY_LIMIT) {
    return normalized;
  }
  return `${normalized.slice(0, ERROR_BODY_SUMMARY_LIMIT)}…`;
}

function redactAuthorizationFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactAuthorizationFields);
  }
  if (!isRecord(value)) {
    return value;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    redacted[key] =
      key.toLowerCase() === "authorization"
        ? "[REDACTED]"
        : redactAuthorizationFields(child);
  }
  return redacted;
}

function redactSensitive(value: string, apiKey: string): string {
  return redactApiKey(value, apiKey)
    .replace(
      /(["']?authorization["']?\s*[:=]\s*)(["'])(?:\\.|[^"'\\])*(["'])/gi,
      "$1$2[REDACTED]$3",
    )
    .replace(
      /(["']?authorization["']?\s*[:=]\s*)\[[^\]\r\n]*\]/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(\bauthorization\s*[:=]\s*)(?:bearer|basic)?\s*[^,;\r\n}]+/gi,
      "$1[REDACTED]",
    )
    .replace(/\bbearer\s+[^\s"',;}]+/gi, "Bearer [REDACTED]");
}

function redactSuccessfulResult(
  result: CodexSearchResult,
  apiKey: string,
): CodexSearchResult {
  return {
    text: redactApiKey(result.text, apiKey),
    citations: result.citations.map((citation) => {
      const redacted: CodexCitation = {
        url: redactApiKey(citation.url, apiKey),
      };
      if (citation.title !== undefined) {
        redacted.title = redactApiKey(citation.title, apiKey);
      }
      return redacted;
    }),
  };
}

function redactApiKey(value: string, apiKey: string): string {
  return apiKey.length > 0 ? value.split(apiKey).join("[REDACTED]") : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
