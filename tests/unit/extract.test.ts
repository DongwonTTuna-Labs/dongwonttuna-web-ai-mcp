import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractContent } from "../../src/services/extract.js";

async function fixture(name: string): Promise<Uint8Array> {
  return readFile(new URL(`../fixtures/${name}`, import.meta.url));
}

describe("extractContent", () => {
  it("extracts an article as Markdown and resolves relative links and images", async () => {
    const result = extractContent(
      await fixture("article.html"),
      "text/html; charset=utf-8",
      "https://example.com/news/2026/article.html",
    );

    expect(result).toMatchObject({
      title: "Deep Sea Gardens",
      contentType: "text/html",
      extraction: "readability",
    });
    expect(result.content).toContain(
      "Researchers have mapped a thriving garden",
    );
    expect(result.content).toContain(
      "[field notes](https://example.com/news/research/field-notes)",
    );
    expect(result.content).toContain(
      "![A glass sponge garden](https://example.com/images/sponge-garden.jpg)",
    );
    expect(result.content).not.toContain("Copyright Example");
  });

  it("preserves tables with the GFM plugin", async () => {
    const result = extractContent(
      await fixture("table.html"),
      "application/xhtml+xml",
      "https://example.com/report",
    );

    expect(result.extraction).toBe("readability");
    expect(result.content).toMatch(
      /\|\s*Station\s*\|\s*Temperature\s*\|\s*Sponges\s*\|/,
    );
    expect(result.content).toMatch(/\|\s*-+\s*\|\s*-+\s*\|\s*-+\s*\|/);
    expect(result.content).toMatch(/\|\s*North\s*\|\s*3\.2 C\s*\|\s*48\s*\|/);
  });

  it("uses a script-free text fallback when Readability finds no article", async () => {
    const result = extractContent(
      await fixture("spa.html"),
      null,
      "https://example.com/dashboard",
    );

    expect(result).toEqual({
      title: "Client Dashboard",
      content: "Loading dashboard…",
      contentType: "text/html",
      extraction: "fallback",
    });
    expect(result.content).not.toContain("secretScriptMarker");
  });

  it.each([
    ["text/plain; charset=utf-8", "plain response"],
    ["application/json", '{"status":"ok"}'],
    ["application/xml", "<status>ok</status>"],
  ])("returns %s bodies as raw text", (contentType, text) => {
    const result = extractContent(
      new TextEncoder().encode(text),
      contentType,
      "https://example.com/data",
    );

    expect(result).toEqual({
      content: text,
      contentType: contentType.split(";")[0],
      extraction: "raw",
    });
  });

  it("decodes an on-disk EUC-KR fixture using its meta charset", async () => {
    const bytes = await fixture("euc-kr.html");
    expect(new TextDecoder("utf-8").decode(bytes)).toContain("\ufffd");

    const result = extractContent(
      bytes,
      "text/html",
      "https://example.com/korean-news",
    );

    expect(result).toMatchObject({
      title: "한국어 기사",
      contentType: "text/html",
      extraction: "readability",
    });
    expect(result.content).toContain("봄날의 도서관");
    expect(result.content).toContain("새로운 열람실을 열었습니다");
    expect(result.content).not.toContain("\ufffd");
  });

  it("honors a header charset before a conflicting HTML meta charset", () => {
    const html =
      '<!doctype html><html><head><meta charset="euc-kr"></head>' +
      "<body><article><p>UTF-8 café content.</p></article></body></html>";
    const result = extractContent(
      new TextEncoder().encode(html),
      "text/html; charset=utf-8",
      "https://example.com/charset",
    );

    expect(result.content).toContain("café");
  });

  it("does not read a charset token from inside a quoted Content-Type parameter", () => {
    const html =
      '<!doctype html><html><head><meta charset="euc-kr"></head>' +
      "<body><article><p>A UTF-8 café report.</p></article></body></html>";

    const result = extractContent(
      new TextEncoder().encode(html),
      'text/html; note="x; charset=euc-kr"; charset=utf-8',
      "https://example.com/quoted-parameter",
    );

    expect(result.content).toContain("café");
  });

  it("detects a charset from an HTML http-equiv meta tag", () => {
    const ascii =
      '<!doctype html><html><head><meta http-equiv="Content-Type" ' +
      'content="text/html; charset=windows-1252"></head>' +
      "<body><article><p>A caf\u00e9 report for encoding detection.</p></article></body></html>";
    const bytes = Uint8Array.from(ascii, (character) =>
      character.charCodeAt(0),
    );

    const result = extractContent(
      bytes,
      "text/html",
      "https://example.com/legacy",
    );

    expect(result.content).toContain("café");
  });

  it.each([
    ["an HTML comment", '<!-- <meta charset="euc-kr"> -->'],
    [
      "a script string",
      "<script>const marker = '<meta charset=\"euc-kr\">';</script>",
    ],
  ])("ignores a meta charset inside %s", (_kind, fakeMeta) => {
    const html =
      `<!doctype html><html><head>${fakeMeta}<meta charset="utf-8"></head>` +
      "<body><article><p>A UTF-8 café report.</p></article></body></html>";

    const result = extractContent(
      new TextEncoder().encode(html),
      "text/html",
      "https://example.com/real-meta",
    );

    expect(result.content).toContain("café");
  });

  it("defaults HTML without a declared charset to UTF-8", () => {
    const html =
      "<!doctype html><html><body><article><p>A café report without charset metadata.</p>" +
      "</article></body></html>";

    const result = extractContent(
      new TextEncoder().encode(html),
      "text/html",
      "https://example.com/default-encoding",
    );

    expect(result.content).toContain("café");
  });

  it("ignores a meta charset outside the first 1024 bytes", () => {
    const padding = "x".repeat(1_024);
    const html =
      `<!doctype html><html><head><!--${padding}--><meta charset="euc-kr"></head>` +
      "<body><article><p>A UTF-8 café report after the sniffing window.</p>" +
      "</article></body></html>";

    const result = extractContent(
      new TextEncoder().encode(html),
      "text/html",
      "https://example.com/late-meta",
    );

    expect(result.content).toContain("café");
  });

  it("uses the first valid base href when resolving relative links and images", () => {
    const html = `<!doctype html>
      <html><head><base href="https://cdn.example/assets/"></head><body><article>
        <p>A sufficiently detailed report links to its <a href="manual.html">manual</a>
        and includes an expedition image for readers who need visual context.</p>
        <img src="photo.jpg" alt="Expedition">
      </article></body></html>`;

    const result = extractContent(
      new TextEncoder().encode(html),
      "text/html",
      "https://origin.example/news/page.html",
    );

    expect(result.content).toContain(
      "[manual](https://cdn.example/assets/manual.html)",
    );
    expect(result.content).toContain(
      "![Expedition](https://cdn.example/assets/photo.jpg)",
    );
  });

  it("rejects PDF and binary content with an actionable error", () => {
    expect(() =>
      extractContent(
        new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        "application/pdf",
        "https://x.test/a",
      ),
    ).toThrow(
      "unsupported content type application/pdf — this tool reads text/HTML content",
    );
    expect(() =>
      extractContent(
        new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        "image/png",
        "https://x.test/a",
      ),
    ).toThrow(
      "unsupported content type image/png — this tool reads text/HTML content",
    );
  });
});
