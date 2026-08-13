import { z } from "zod";

const positiveIntegerString = (name: string) =>
  z
    .string()
    .regex(/^\d+$/, `${name} must be a positive integer`)
    .transform(Number)
    .pipe(z.number().int().positive(`${name} must be a positive integer`));

const httpUrl = z
  .string()
  .url("CODEX_BASE_URL must be a valid URL")
  .refine((value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  }, "CODEX_BASE_URL must use http or https");

const configSchema = z
  .object({
    CODEX_API_KEY: z
      .string({ error: "CODEX_API_KEY is required" })
      .min(1, "CODEX_API_KEY is required"),
    CODEX_BASE_URL: httpUrl.default("https://api.openai.com/v1"),
    CODEX_MODEL: z.string().min(1).default("gpt-5.6"),
    CODEX_REASONING_EFFORT: z.enum(["low", "medium", "high"]).default("low"),
    CODEX_TIMEOUT_MS:
      positiveIntegerString("CODEX_TIMEOUT_MS").default(180_000),
    WEBAI_FETCH_TIMEOUT_MS: positiveIntegerString(
      "WEBAI_FETCH_TIMEOUT_MS",
    ).default(30_000),
    WEBAI_MAX_CONTENT_BYTES: positiveIntegerString(
      "WEBAI_MAX_CONTENT_BYTES",
    ).default(10_485_760),
    WEBAI_ALLOW_PRIVATE_NETWORKS: z
      .string()
      .optional()
      .transform((value) => value === "true"),
  })
  .strict();

export interface AppConfig {
  codexApiKey: string;
  codexBaseUrl: string;
  codexModel: string;
  codexReasoningEffort: "low" | "medium" | "high";
  codexTimeoutMs: number;
  fetchTimeoutMs: number;
  maxContentBytes: number;
  allowPrivateNetworks: boolean;
}

const CONFIG_KEYS = [
  "CODEX_API_KEY",
  "CODEX_BASE_URL",
  "CODEX_MODEL",
  "CODEX_REASONING_EFFORT",
  "CODEX_TIMEOUT_MS",
  "WEBAI_FETCH_TIMEOUT_MS",
  "WEBAI_MAX_CONTENT_BYTES",
  "WEBAI_ALLOW_PRIVATE_NETWORKS",
] as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const relevantEnv: Record<string, string | undefined> = {};
  for (const key of CONFIG_KEYS) {
    if (env[key] !== undefined) {
      relevantEnv[key] = env[key];
    }
  }

  const parsed = configSchema.parse(relevantEnv);
  return {
    codexApiKey: parsed.CODEX_API_KEY,
    codexBaseUrl: parsed.CODEX_BASE_URL.replace(/\/+$/, ""),
    codexModel: parsed.CODEX_MODEL,
    codexReasoningEffort: parsed.CODEX_REASONING_EFFORT,
    codexTimeoutMs: parsed.CODEX_TIMEOUT_MS,
    fetchTimeoutMs: parsed.WEBAI_FETCH_TIMEOUT_MS,
    maxContentBytes: parsed.WEBAI_MAX_CONTENT_BYTES,
    allowPrivateNetworks: parsed.WEBAI_ALLOW_PRIVATE_NETWORKS,
  };
}

export function formatConfigError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues
      .map(
        (issue) =>
          `${issue.path.join(".") || "configuration"}: ${issue.message}`,
      )
      .join("; ");
  }
  return error instanceof Error ? error.message : "unknown configuration error";
}
