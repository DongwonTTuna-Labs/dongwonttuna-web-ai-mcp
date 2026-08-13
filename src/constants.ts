export const PACKAGE_NAME = "dongwonttuna-web-ai-mcp";
export const PACKAGE_VERSION = "0.1.0";

export const DEFAULT_MAX_LENGTH = 20_000;
export const MODEL_INPUT_CHAR_LIMIT = 80_000;
export const MAX_REDIRECTS = 5;

export const USER_AGENT = `${PACKAGE_NAME}/${PACKAGE_VERSION} (+https://github.com/DongwonTTuna-Labs/dongwonttuna-web-ai-mcp)`;

export const CODEX_SYSTEM_INSTRUCTIONS =
  "You are a web content processing engine. Follow the user's instruction using only the supplied page content. Extract, transform, summarize, or answer as requested, and never invent information that is absent from the page.";

export const SEARCH_SYSTEM_INSTRUCTIONS =
  "You are a web search research engine. Use web search to gather evidence and answer the user's query. Cite the sources you use, never invent unsupported facts, and state clearly when the available evidence is insufficient.";
