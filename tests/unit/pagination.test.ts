import { describe, expect, it } from "vitest";
import {
  paginateContent,
  readUrlInputSchema,
} from "../../src/tools/read-url.js";

describe("paginateContent", () => {
  it("returns the complete content when it fits", () => {
    expect(paginateContent("abcdef", 0, 10)).toEqual({
      content: "abcdef",
      truncated: false,
    });
  });

  it("returns a continuation index while more content remains", () => {
    expect(paginateContent("abcdefghij", 2, 4)).toEqual({
      content: "cdef",
      truncated: true,
      nextStartIndex: 6,
    });
  });

  it("marks a nonzero final page as truncated without a continuation", () => {
    expect(paginateContent("abcdefghij", 6, 10)).toEqual({
      content: "ghij",
      truncated: true,
    });
  });
});

describe("readUrlInputSchema", () => {
  it("preserves omission of start_index", () => {
    const parsed = readUrlInputSchema.parse({
      url: "https://example.com",
      instruction: "Summarize",
    });

    expect(parsed.start_index).toBeUndefined();
    expect(parsed.max_length).toBe(20_000);
  });

  it("rejects explicit start_index with an instruction, including zero", () => {
    expect(() =>
      readUrlInputSchema.parse({
        url: "https://example.com",
        instruction: "Summarize",
        start_index: 0,
      }),
    ).toThrow(/start_index cannot be specified/);
  });

  it("rejects credentials and unknown fields", () => {
    expect(() =>
      readUrlInputSchema.parse({ url: "https://user:pass@example.com" }),
    ).toThrow(/credentials/);
    expect(() =>
      readUrlInputSchema.parse({
        url: "https://example.com",
        unexpected: true,
      }),
    ).toThrow();
  });

  it("returns a validation error rather than throwing from URL parsing", () => {
    const result = readUrlInputSchema.safeParse({ url: "not-a-url" });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toContain(
        "url must be a valid URL",
      );
    }
  });
});
