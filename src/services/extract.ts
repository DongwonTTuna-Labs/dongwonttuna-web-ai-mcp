import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

export type ExtractionMethod = "readability" | "fallback" | "raw";

export interface ExtractedContent {
  title?: string;
  content: string;
  contentType: string;
  extraction: ExtractionMethod;
}

interface ParsedContentType {
  mediaType: string;
  charset?: string;
}

const HTML_CONTENT_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const RAW_APPLICATION_TYPES = new Set(["application/json", "application/xml"]);

const BLOCK_ELEMENTS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "dd",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

export function extractContent(
  bytes: Uint8Array,
  contentTypeHeader: string | null | undefined,
  finalUrl: string,
): ExtractedContent {
  const { mediaType, charset: headerCharset } =
    parseContentType(contentTypeHeader);

  if (!isSupportedContentType(mediaType)) {
    throw new Error(
      `unsupported content type ${mediaType} — this tool reads text/HTML content`,
    );
  }

  const charset =
    headerCharset ??
    (HTML_CONTENT_TYPES.has(mediaType) ? detectHtmlCharset(bytes) : undefined);
  const decoded = decode(bytes, charset ?? "utf-8");

  if (HTML_CONTENT_TYPES.has(mediaType)) {
    return extractHtml(decoded, mediaType, finalUrl);
  }

  return {
    content: decoded,
    contentType: mediaType,
    extraction: "raw",
  };
}

function parseContentType(
  contentTypeHeader: string | null | undefined,
): ParsedContentType {
  if (
    contentTypeHeader === null ||
    contentTypeHeader === undefined ||
    !contentTypeHeader.trim()
  ) {
    return { mediaType: "text/html" };
  }

  const [rawMediaType, ...parameters] = splitMimeParameters(contentTypeHeader);
  const mediaType = rawMediaType?.trim().toLowerCase() || "text/html";
  const charset = findMimeParameter(parameters, "charset");

  return charset ? { mediaType, charset } : { mediaType };
}

function splitMimeParameters(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaped = false;

  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }

    if (character === "\\" && quote !== undefined) {
      current += character;
      escaped = true;
      continue;
    }

    if (character === '"' || character === "'") {
      if (quote === character) {
        quote = undefined;
      } else if (quote === undefined) {
        quote = character;
      }
      current += character;
      continue;
    }

    if (character === ";" && quote === undefined) {
      parts.push(current);
      current = "";
      continue;
    }

    current += character;
  }

  parts.push(current);
  return parts;
}

function findMimeParameter(
  parameters: string[],
  name: string,
): string | undefined {
  for (const parameter of parameters) {
    const separator = parameter.indexOf("=");
    if (
      separator < 0 ||
      parameter.slice(0, separator).trim().toLowerCase() !== name
    ) {
      continue;
    }

    const rawValue = parameter.slice(separator + 1).trim();
    const value = unquoteMimeParameter(rawValue);
    if (value) {
      return value;
    }
  }

  return undefined;
}

function unquoteMimeParameter(value: string): string {
  if (value.length < 2) {
    return value;
  }

  const quote = value[0];
  if ((quote !== '"' && quote !== "'") || value.at(-1) !== quote) {
    return value;
  }

  return value.slice(1, -1).replace(/\\(.)/g, "$1").trim();
}

function isSupportedContentType(mediaType: string): boolean {
  return (
    HTML_CONTENT_TYPES.has(mediaType) ||
    mediaType.startsWith("text/") ||
    RAW_APPLICATION_TYPES.has(mediaType)
  );
}

function detectHtmlCharset(bytes: Uint8Array): string | undefined {
  const prefix = new TextDecoder("iso-8859-1").decode(bytes.subarray(0, 1024));
  const { document } = parseHTML(prefix);

  for (const meta of document.querySelectorAll("meta")) {
    const charset = meta.getAttribute("charset")?.trim();
    if (charset) {
      return charset;
    }

    if (
      meta.getAttribute("http-equiv")?.trim().toLowerCase() !== "content-type"
    ) {
      continue;
    }

    const content = meta.getAttribute("content");
    if (!content) {
      continue;
    }

    const [, ...parameters] = splitMimeParameters(content);
    const detected = findMimeParameter(parameters, "charset");
    if (detected) {
      return detected;
    }
  }

  return undefined;
}

function decode(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch (error) {
    const cause = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`unsupported charset ${charset}${cause}`);
  }
}

function extractHtml(
  html: string,
  contentType: string,
  finalUrl: string,
): ExtractedContent {
  const { document } = parseHTML(html);
  makeResourceUrlsAbsolute(document as unknown as Document, finalUrl);
  const documentTitle = document.title.trim();

  try {
    const article = new Readability(document as unknown as Document).parse();
    if (article?.content) {
      const turndown = new TurndownService({
        bulletListMarker: "-",
        codeBlockStyle: "fenced",
        headingStyle: "atx",
      });
      turndown.use(gfm);
      const content = turndown.turndown(article.content).trim();
      if (content) {
        const title = article.title?.trim() || documentTitle;
        return {
          ...(title ? { title } : {}),
          content,
          contentType,
          extraction: "readability",
        };
      }
    }
  } catch {
    // A deterministic text fallback is returned below.
  }

  const fallback = extractFallbackText(html);
  return {
    ...(fallback.title ? { title: fallback.title } : {}),
    content: fallback.content,
    contentType,
    extraction: "fallback",
  };
}

function makeResourceUrlsAbsolute(document: Document, finalUrl: string): void {
  const baseUrl = effectiveBaseUrl(document, finalUrl);
  for (const anchor of document.querySelectorAll("a[href]")) {
    absolutizeAttribute(anchor, "href", baseUrl);
  }
  for (const image of document.querySelectorAll("img[src]")) {
    absolutizeAttribute(image, "src", baseUrl);
  }
}

function effectiveBaseUrl(document: Document, finalUrl: string): string {
  for (const base of document.querySelectorAll("base[href]")) {
    const href = base.getAttribute("href");
    if (!href) {
      continue;
    }

    try {
      return new URL(href, finalUrl).href;
    } catch {
      // The first valid base element determines the document base URL.
    }
  }

  return finalUrl;
}

function absolutizeAttribute(
  element: Element,
  attribute: string,
  finalUrl: string,
): void {
  const value = element.getAttribute(attribute);
  if (!value) {
    return;
  }

  try {
    element.setAttribute(attribute, new URL(value, finalUrl).href);
  } catch {
    // Preserve malformed or non-URL attributes instead of losing page content.
  }
}

function extractFallbackText(html: string): {
  title?: string;
  content: string;
} {
  const { document } = parseHTML(html);
  const title = document.title.trim();
  for (const element of document.querySelectorAll("script, style")) {
    element.remove();
  }

  const root = document.body ?? document.documentElement;
  const content = root ? serializeText(root as unknown as Node) : "";
  return {
    ...(title ? { title } : {}),
    content,
  };
}

function serializeText(root: Node): string {
  const chunks: string[] = [];

  const visit = (node: Node): void => {
    if (node.nodeType === 3) {
      chunks.push(node.nodeValue ?? "");
      return;
    }

    const tagName =
      node.nodeType === 1 ? (node as Element).tagName.toLowerCase() : undefined;
    const addsBoundary = tagName !== undefined && BLOCK_ELEMENTS.has(tagName);
    if (addsBoundary) {
      chunks.push("\n");
    }

    for (let child = node.firstChild; child; child = child.nextSibling) {
      visit(child);
    }

    if (addsBoundary) {
      chunks.push("\n");
    }
  };

  visit(root);
  return chunks
    .join("")
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
