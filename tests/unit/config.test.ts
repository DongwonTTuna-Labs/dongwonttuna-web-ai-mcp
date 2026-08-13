import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";

describe("loadConfig", () => {
  it("requires a Codex API key", () => {
    expect(() => loadConfig({})).toThrow(/CODEX_API_KEY is required/);
  });

  it("uses the documented defaults and a non-retired model", () => {
    const config = loadConfig({ CODEX_API_KEY: "test-placeholder" });

    expect(config).toMatchObject({
      codexBaseUrl: "https://api.openai.com/v1",
      codexModel: "gpt-5.6",
      codexReasoningEffort: "low",
      codexTimeoutMs: 180_000,
      fetchTimeoutMs: 30_000,
      maxContentBytes: 10_485_760,
      allowPrivateNetworks: false,
    });
    expect(config.codexModel).not.toMatch(/^gpt-5\.1-codex/);
  });

  it("normalizes a trailing slash and accepts supported effort values", () => {
    const config = loadConfig({
      CODEX_API_KEY: "test-placeholder",
      CODEX_BASE_URL: "http://127.0.0.1:9000/api///",
      CODEX_REASONING_EFFORT: "high",
    });

    expect(config.codexBaseUrl).toBe("http://127.0.0.1:9000/api");
    expect(config.codexReasoningEffort).toBe("high");
  });

  it("rejects unsupported reasoning effort", () => {
    expect(() =>
      loadConfig({
        CODEX_API_KEY: "test-placeholder",
        CODEX_REASONING_EFFORT: "minimal",
      }),
    ).toThrow(/CODEX_REASONING_EFFORT/);
  });

  it("rejects an invalid base URL through Zod validation", () => {
    expect(() =>
      loadConfig({
        CODEX_API_KEY: "test-placeholder",
        CODEX_BASE_URL: "not-a-url",
      }),
    ).toThrow(/CODEX_BASE_URL must be a valid URL/);
  });

  it('only enables private networks for the exact string "true"', () => {
    expect(
      loadConfig({
        CODEX_API_KEY: "test-placeholder",
        WEBAI_ALLOW_PRIVATE_NETWORKS: "true",
      }).allowPrivateNetworks,
    ).toBe(true);
    expect(
      loadConfig({
        CODEX_API_KEY: "test-placeholder",
        WEBAI_ALLOW_PRIVATE_NETWORKS: "false",
      }).allowPrivateNetworks,
    ).toBe(false);
    expect(
      loadConfig({
        CODEX_API_KEY: "test-placeholder",
        WEBAI_ALLOW_PRIVATE_NETWORKS: "TRUE",
      }).allowPrivateNetworks,
    ).toBe(false);
  });
});
