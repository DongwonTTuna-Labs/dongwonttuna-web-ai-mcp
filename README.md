# dongwonttuna-web-ai-mcp

`dongwonttuna-web-ai-mcp` is a jina Reader- and Search-like MCP server. It can
turn a web page into LLM-friendly content, apply a Codex instruction to that
content, or search the web for an evidence-based answer with source URLs.

The AI backend is deliberately one Codex tuple: one API key, one model, and one
base URL. The base URL must expose an OpenAI Responses API-compatible
`/responses` endpoint. This project does not contain a multi-provider
abstraction or support Chat Completions-compatible endpoints.

## Requirements

- Node.js 20 or newer
- A Codex API key accepted by your Responses API-compatible endpoint

## Quick start

### Claude Code

```sh
claude mcp add --transport stdio webai -e CODEX_API_KEY=your-api-key -- \
  npx -y dongwonttuna-web-ai-mcp
```

Add more `-e KEY=value` options after `webai` when you need to override a
default, for example `-e CODEX_BASE_URL=https://your-relay.example/v1`.
ChatGPT-backend Codex relays may reject the platform alias `gpt-5.6`; in that
case, also set `CODEX_MODEL` to a Codex model ID served by the relay, such as
`gpt-5.6-sol`.

### Claude Desktop

Add the server to the `mcpServers` object in your Claude Desktop configuration:

```json
{
  "mcpServers": {
    "webai": {
      "command": "npx",
      "args": ["-y", "dongwonttuna-web-ai-mcp"],
      "env": {
        "CODEX_API_KEY": "your-api-key"
      }
    }
  }
}
```

Restart Claude Desktop after changing its configuration.

### Codex CLI

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.webai]
command = "npx"
args = ["-y", "dongwonttuna-web-ai-mcp"]
env = { CODEX_API_KEY = "your-api-key" }
```

## Configuration

| Environment variable | Required | Default | Description |
| --- | --- | --- | --- |
| `CODEX_API_KEY` | Yes | None | Bearer credential for the configured Responses API-compatible endpoint. The server refuses to start when it is missing. |
| `CODEX_BASE_URL` | No | `https://api.openai.com/v1` | HTTP(S) API root. Trailing slashes are removed before `/responses` is appended. |
| `CODEX_MODEL` | No | `gpt-5.6` | Codex model sent in each Responses API request. ChatGPT-backend Codex relays may reject the platform alias `gpt-5.6`, so override it with a Codex model ID served by the relay, such as `gpt-5.6-sol`. |
| `CODEX_REASONING_EFFORT` | No | `low` | Reasoning effort: `low`, `medium`, or `high`. |
| `CODEX_TIMEOUT_MS` | No | `180000` | Positive integer timeout for a Codex request, in milliseconds. |
| `WEBAI_FETCH_TIMEOUT_MS` | No | `30000` | Positive integer timeout for fetching a page, in milliseconds. |
| `WEBAI_MAX_CONTENT_BYTES` | No | `10485760` | Positive integer maximum response-body size. Oversized responses fail instead of being partially returned. |
| `WEBAI_ALLOW_PRIVATE_NETWORKS` | No | `false` | Disables the private/special-address SSRF block only when its value is exactly the lowercase string `true`. Intended for trusted local use. |

Only `CODEX_API_KEY`, `CODEX_BASE_URL`, and `CODEX_MODEL` select the AI backend;
they always describe a single OpenAI Responses-compatible Codex endpoint.

## Tool reference

### `webai_read_url`

Fetches one HTTP(S) URL, extracts readable content, and optionally applies a
Codex instruction.

#### Input

| Field | Required | Default | Description |
| --- | --- | --- | --- |
| `url` | Yes | None | An `http` or `https` URL without embedded credentials. |
| `instruction` | No | None | A 1-2000 character instruction for Codex, such as a summary or targeted extraction request. Omitting it avoids a model call. |
| `response_format` | No | `markdown` | `markdown` or `json`. |
| `start_index` | No | `0` | Non-negative character offset for deterministic pagination. It must not be supplied together with `instruction`, even when it is `0`. |
| `max_length` | No | `20000` | Maximum returned content length, from 1 through 50000 characters. |

Without `instruction`, the tool converts HTML to Markdown (or returns supported
text content as-is) and applies `start_index` and `max_length`. With
`instruction`, it sends up to 80000 characters of extracted page content to the
configured Codex endpoint and applies `max_length` to the model output.

#### Output

The result contains one text content block and matching `structuredContent`.
Its declared `outputSchema` has the following fields:

| Field | Description |
| --- | --- |
| `url` | Requested URL. |
| `final_url` | Final URL after redirects. |
| `title` | Extracted title, when available. |
| `content` | Extracted or model-processed text. This is the value limited by `max_length`. |
| `content_type` | Response media type. |
| `extraction` | `readability`, `fallback`, or `raw`. |
| `truncated` | Whether returned content was truncated. |
| `next_start_index` | Next deterministic pagination offset, when more content remains. |
| `model_used` | Codex model used when `instruction` was supplied. |
| `model_input_truncated` | Whether page content exceeded the 80000-character model-input limit. |

For `response_format: "json"`, the text content block is a JSON serialization of
the structured result; the JSON envelope itself is never truncated. Fetch,
extraction, policy, and Codex failures are returned as MCP tool errors with an
actionable message.

### `webai_search_web`

Uses the configured Codex Responses endpoint with its built-in `web_search`
tool to answer a query and return the URL citations emitted by the model.

#### Input

| Field | Required | Default | Description |
| --- | --- | --- | --- |
| `query` | Yes | None | Search query from 1 through 500 characters. |
| `response_format` | No | `markdown` | `markdown` or `json`. |
| `max_length` | No | `20000` | Maximum answer length, from 1 through 50000 characters. It does not limit the source list or JSON envelope. |

The request exposes only the Responses API `web_search` tool and does not force
`tool_choice`; the model may answer without invoking search.

#### Output

The result contains one text content block and matching `structuredContent`.
Its declared `outputSchema` has the following fields:

| Field | Description |
| --- | --- |
| `query` | Original search query. |
| `answer` | Model answer, limited by `max_length`. |
| `sources` | Ordered, URL-deduplicated citations with `url` and an optional `title`. This may be an empty array when the model does not search. |
| `truncated` | Whether the answer was truncated. Sources do not affect this value. |
| `model_used` | Configured Codex model used for the search. |

For `response_format: "markdown"`, the text block contains the answer followed
by a `## Sources` numbered list. For `response_format: "json"`, it is a JSON
serialization of the structured result. Only `answer` is limited by
`max_length`; the source section and JSON envelope are never truncated.

## Security

The fetcher resolves every hostname before connecting and requires every A and
AAAA result to be allowed. It blocks loopback (`127.0.0.0/8`, `::1`), private
IPv4 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), IPv4 link-local and
metadata (`169.254.0.0/16`), IPv6 link-local (`fe80::/10`), IPv6 ULA
(`fc00::/7`), and unspecified addresses (`0.0.0.0`, `::`). IPv4-mapped IPv6
addresses are decoded and checked by the same rules. IP-literal URLs receive
the same checks. Credentials in URLs are rejected, and each redirect target is
resolved and checked again.

Private access is an explicit opt-in: only
`WEBAI_ALLOW_PRIVATE_NETWORKS=true` (exact, lowercase) disables the
private/special-address block. Enable it only when the MCP client and requested
URLs are trusted.

DNS rebinding protection has a known limit: the server validates DNS results
before fetch, but does not pin a validated IP address to the subsequent socket.
An address can therefore change between validation and connection. Do not
expose the server to untrusted callers in an environment where this residual
risk is unacceptable.

The configured API key is exact-match redacted from successful model text and
source URL/title fields. Error messages additionally redact Authorization
credential values. Keep credentials in the MCP client's environment rather
than source files.

## Manual live smoke test

The live smoke test is intentionally outside CI. Build first, then run it
against a real page and your configured Responses API-compatible endpoint:

```sh
npm ci
npm run build
CODEX_API_KEY=your-api-key \
CODEX_BASE_URL=https://api.openai.com/v1 \
npm run smoke:live
```

The default mode is `reader`. `WEBAI_SMOKE_URL` and
`WEBAI_SMOKE_INSTRUCTION` optionally override its default page
(`https://example.com/`) and instruction.

To exercise the search tool instead, select `search` mode and optionally set a
1-500 character query:

```sh
CODEX_API_KEY=your-api-key \
CODEX_BASE_URL=https://api.openai.com/v1 \
WEBAI_SMOKE_MODE=search \
WEBAI_SMOKE_QUERY="What is the purpose of the Example Domain website?" \
npm run smoke:live
```

The script starts the built stdio server through the MCP SDK, performs the
selected live tool call, and prints a redacted result summary; it never prints
the API key. The live smoke test is not part of CI or `npm test`.

## License

MIT. See [LICENSE](LICENSE).
