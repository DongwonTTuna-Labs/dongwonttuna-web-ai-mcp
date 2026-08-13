import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { MAX_REDIRECTS, USER_AGENT } from "../constants.js";

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface DnsLookupOptions {
  all: true;
  verbatim: true;
}

export type DnsResolver = (
  hostname: string,
  options: DnsLookupOptions,
) => Promise<readonly ResolvedAddress[]>;

export interface UrlGuardOptions {
  allowPrivateNetworks?: boolean;
  resolver?: DnsResolver;
}

export interface FetchUrlOptions extends UrlGuardOptions {
  timeoutMs: number;
  maxContentBytes: number;
  fetchImpl?: typeof fetch;
}

export interface FetchUrlResult {
  requestedUrl: string;
  finalUrl: string;
  bytes: Uint8Array;
  contentType: string | null;
}

const defaultResolver: DnsResolver = async (hostname, options) => {
  const results = await lookup(hostname, options);
  return results.map((result) => {
    if (result.family !== 4 && result.family !== 6) {
      throw new Error(
        `Resolver returned an unsupported address family: ${result.family}`,
      );
    }
    return { address: result.address, family: result.family };
  });
};

function parseUrl(input: string | URL): URL {
  let url: URL;
  try {
    url = new URL(input instanceof URL ? input.href : input);
  } catch (error) {
    throw new Error("Invalid URL", { cause: error });
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported URL protocol: ${url.protocol || "(missing)"}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("URLs containing credentials are not allowed");
  }

  return url;
}

function withoutIpv6Brackets(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

function parseIpv4(
  address: string,
): readonly [number, number, number, number] | null {
  if (isIP(address) !== 4) {
    return null;
  }

  const octets = address.split(".").map(Number);
  if (octets.length !== 4) {
    return null;
  }

  return [octets[0] ?? 0, octets[1] ?? 0, octets[2] ?? 0, octets[3] ?? 0];
}

function isBlockedIpv4(address: string): boolean {
  const octets = parseIpv4(address);
  if (octets === null) {
    return false;
  }

  const [first, second, third, fourth] = octets;
  return (
    first === 127 ||
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254) ||
    (first === 0 && second === 0 && third === 0 && fourth === 0)
  );
}

function parseIpv6(address: string): Uint8Array | null {
  const withoutZone = address.split("%", 1)[0];
  if (withoutZone === undefined || isIP(withoutZone) !== 6) {
    return null;
  }

  let normalized = withoutZone.toLowerCase();
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    const ipv4 = parseIpv4(normalized.slice(lastColon + 1));
    if (lastColon < 0 || ipv4 === null) {
      return null;
    }
    normalized = `${normalized.slice(0, lastColon)}:${(
      (ipv4[0] << 8) | ipv4[1]
    ).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) {
    return null;
  }

  const left = halves[0] === "" ? [] : (halves[0]?.split(":") ?? []);
  const right =
    halves.length === 1 || halves[1] === ""
      ? []
      : (halves[1]?.split(":") ?? []);
  const omittedGroups = 8 - left.length - right.length;
  if (
    (halves.length === 1 && omittedGroups !== 0) ||
    (halves.length === 2 && omittedGroups < 1)
  ) {
    return null;
  }

  const groups = [
    ...left,
    ...Array.from({ length: omittedGroups }, () => "0"),
    ...right,
  ];
  if (
    groups.length !== 8 ||
    groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))
  ) {
    return null;
  }

  const bytes = new Uint8Array(16);
  for (const [index, group] of groups.entries()) {
    const value = Number.parseInt(group, 16);
    bytes[index * 2] = value >> 8;
    bytes[index * 2 + 1] = value & 0xff;
  }
  return bytes;
}

function isBlockedIpv6(address: string): boolean {
  const bytes = parseIpv6(address);
  if (bytes === null) {
    return false;
  }

  const isUnspecified = bytes.every((byte) => byte === 0);
  const isLoopback =
    bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
  const isLinkLocal = bytes[0] === 0xfe && ((bytes[1] ?? 0) & 0xc0) === 0x80;
  const isUniqueLocal = ((bytes[0] ?? 0) & 0xfe) === 0xfc;
  const isIpv4Mapped =
    bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff;

  if (isIpv4Mapped) {
    return isBlockedIpv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  }

  return isUnspecified || isLoopback || isLinkLocal || isUniqueLocal;
}

function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return isBlockedIpv4(address);
  }
  if (family === 6) {
    return isBlockedIpv6(address);
  }
  return false;
}

function assertAllowedAddress(address: string, hostname: string): void {
  const family = isIP(address);
  if (family === 0) {
    throw new Error(
      `Resolver returned an invalid IP address for ${hostname}: ${address}`,
    );
  }
  if (isBlockedAddress(address)) {
    throw new Error(
      `URL hostname ${hostname} points to a blocked network address: ${address}`,
    );
  }
}

/**
 * Parses a URL and rejects network destinations covered by the private-network policy.
 * Every A and AAAA result is checked before the caller opens an HTTP connection.
 */
export async function assertSafeUrl(
  input: string | URL,
  options: UrlGuardOptions = {},
): Promise<URL> {
  const url = parseUrl(input);
  if (options.allowPrivateNetworks === true) {
    return url;
  }

  const hostname = withoutIpv6Brackets(url.hostname);
  const literalFamily = isIP(hostname);
  if (literalFamily !== 0) {
    assertAllowedAddress(hostname, hostname);
    return url;
  }

  const resolver = options.resolver ?? defaultResolver;
  let addresses: readonly ResolvedAddress[];
  try {
    addresses = await resolver(hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new Error(`Failed to resolve URL hostname: ${hostname}`, {
      cause: error,
    });
  }

  if (addresses.length === 0) {
    throw new Error(
      `URL hostname did not resolve to an IP address: ${hostname}`,
    );
  }
  for (const result of addresses) {
    const actualFamily = isIP(result.address);
    if (actualFamily !== result.family) {
      throw new Error(
        `Resolver returned an invalid address family for ${hostname}: ${result.address}`,
      );
    }
    assertAllowedAddress(result.address, hostname);
  }

  return url;
}

function isRedirectStatus(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

function validatePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function discardBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

async function readResponseBytes(
  response: Response,
  maxContentBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/.test(contentLength)) {
    if (BigInt(contentLength) > BigInt(maxContentBytes)) {
      discardBody(response);
      throw new Error(
        `Response exceeds the ${maxContentBytes}-byte content limit`,
      );
    }
  }

  if (response.body === null) {
    return new Uint8Array();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await raceWithAbort(reader.read(), signal);
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxContentBytes) {
        void reader.cancel().catch(() => undefined);
        throw new Error(
          `Response exceeds the ${maxContentBytes}-byte content limit`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Fetches a guarded HTTP(S) URL without automatically following redirects. */
export async function fetchUrl(
  input: string | URL,
  options: FetchUrlOptions,
): Promise<FetchUrlResult> {
  validatePositiveInteger(options.timeoutMs, "timeoutMs");
  validatePositiveInteger(options.maxContentBytes, "maxContentBytes");

  const requested = parseUrl(input);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const resolver = options.resolver ?? defaultResolver;
  const allowPrivateNetworks = options.allowPrivateNetworks ?? false;
  const timeoutError = new Error(
    `Fetch timed out after ${options.timeoutMs} ms`,
  );
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(timeoutError),
    options.timeoutMs,
  );

  let currentUrl = requested;
  let redirectCount = 0;
  try {
    while (true) {
      currentUrl = await raceWithAbort(
        assertSafeUrl(currentUrl, { allowPrivateNetworks, resolver }),
        controller.signal,
      );

      const response = await raceWithAbort(
        fetchImpl(currentUrl, {
          headers: { "user-agent": USER_AGENT },
          redirect: "manual",
          signal: controller.signal,
        }),
        controller.signal,
      );

      if (isRedirectStatus(response.status)) {
        const location = response.headers.get("location");
        discardBody(response);
        if (location === null || location.trim() === "") {
          throw new Error(
            `HTTP ${response.status} redirect from ${currentUrl.href} did not include a Location header`,
          );
        }
        if (redirectCount >= MAX_REDIRECTS) {
          throw new Error(`Too many redirects (maximum ${MAX_REDIRECTS})`);
        }

        try {
          currentUrl = new URL(location, currentUrl);
        } catch (error) {
          throw new Error(`Invalid redirect URL: ${location}`, {
            cause: error,
          });
        }
        redirectCount += 1;
        continue;
      }

      if (!response.ok) {
        discardBody(response);
        const statusText =
          response.statusText === "" ? "" : ` ${response.statusText}`;
        throw new Error(
          `HTTP ${response.status}${statusText} while fetching ${currentUrl.href}`,
        );
      }

      const bytes = await readResponseBytes(
        response,
        options.maxContentBytes,
        controller.signal,
      );
      return {
        requestedUrl: requested.href,
        finalUrl: currentUrl.href,
        bytes,
        contentType: response.headers.get("content-type"),
      };
    }
  } catch (error) {
    if (
      controller.signal.aborted &&
      controller.signal.reason === timeoutError
    ) {
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
