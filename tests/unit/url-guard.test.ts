import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_REDIRECTS, USER_AGENT } from "../../src/constants.js";
import {
  assertSafeUrl,
  type DnsResolver,
  fetchUrl,
  type ResolvedAddress,
} from "../../src/services/fetcher.js";

const PUBLIC_ADDRESSES: readonly ResolvedAddress[] = [
  { address: "93.184.216.34", family: 4 },
];

const publicResolver: DnsResolver = async () => PUBLIC_ADDRESSES;

function fetchMock(
  implementation: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>,
) {
  return vi.fn(implementation);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("assertSafeUrl", () => {
  it.each([
    "http://127.0.0.1/",
    "http://10.1.2.3/",
    "http://172.16.0.1/",
    "http://172.31.255.254/",
    "http://192.168.1.1/",
    "http://169.254.10.20/",
    "http://0.0.0.0/",
  ])("rejects the blocked IPv4 literal %s before DNS or HTTP", async (url) => {
    const resolver = vi.fn(async () => PUBLIC_ADDRESSES);
    const http = fetchMock(async () => new Response("unexpected"));

    await expect(
      fetchUrl(url, {
        timeoutMs: 1_000,
        maxContentBytes: 1_024,
        resolver,
        fetchImpl: http as typeof fetch,
      }),
    ).rejects.toThrow(/blocked network address/);

    expect(resolver).not.toHaveBeenCalled();
    expect(http).not.toHaveBeenCalled();
  });

  it.each([
    "http://[::]/",
    "http://[::1]/",
    "http://[fe80::1]/",
    "http://[febf::1]/",
    "http://[fc00::1]/",
    "http://[fdff::1]/",
    "http://[::ffff:127.0.0.1]/",
  ])("rejects the blocked IPv6 literal %s before HTTP", async (url) => {
    const http = fetchMock(async () => new Response("unexpected"));

    await expect(
      fetchUrl(url, {
        timeoutMs: 1_000,
        maxContentBytes: 1_024,
        fetchImpl: http as typeof fetch,
      }),
    ).rejects.toThrow(/blocked network address/);

    expect(http).not.toHaveBeenCalled();
  });

  it("checks every A and AAAA answer and rejects a private AAAA answer", async () => {
    const answers: readonly ResolvedAddress[] = [
      { address: "93.184.216.34", family: 4 },
      { address: "fd00::1234", family: 6 },
    ];
    const resolver = vi.fn(async () => answers);
    const http = fetchMock(async () => new Response("unexpected"));

    await expect(
      fetchUrl("https://example.test/page", {
        timeoutMs: 1_000,
        maxContentBytes: 1_024,
        resolver,
        fetchImpl: http as typeof fetch,
      }),
    ).rejects.toThrow(/fd00::1234/);

    expect(resolver).toHaveBeenCalledOnce();
    expect(resolver).toHaveBeenCalledWith("example.test", {
      all: true,
      verbatim: true,
    });
    expect(http).not.toHaveBeenCalled();
  });

  it("rejects non-HTTP protocols and URL credentials", async () => {
    const resolver = vi.fn(async () => PUBLIC_ADDRESSES);

    await expect(
      assertSafeUrl("file:///etc/passwd", { resolver }),
    ).rejects.toThrow(/Unsupported URL protocol/);
    await expect(
      assertSafeUrl("https://user:secret@example.test/", { resolver }),
    ).rejects.toThrow(/credentials/);

    expect(resolver).not.toHaveBeenCalled();
  });

  it("disables the private-network policy only when requested", async () => {
    const resolver = vi.fn(async () => PUBLIC_ADDRESSES);
    const http = fetchMock(async () => new Response("private-ok"));

    const result = await fetchUrl("http://127.0.0.1/internal", {
      timeoutMs: 1_000,
      maxContentBytes: 1_024,
      allowPrivateNetworks: true,
      resolver,
      fetchImpl: http as typeof fetch,
    });

    expect(new TextDecoder().decode(result.bytes)).toBe("private-ok");
    expect(resolver).not.toHaveBeenCalled();
    expect(http).toHaveBeenCalledOnce();
  });
});

describe("fetchUrl", () => {
  it("guards a redirect target before issuing the next request", async () => {
    const resolver = vi.fn(async () => PUBLIC_ADDRESSES);
    const http = fetchMock(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/admin" },
        }),
    );

    await expect(
      fetchUrl("https://example.test/start", {
        timeoutMs: 1_000,
        maxContentBytes: 1_024,
        resolver,
        fetchImpl: http as typeof fetch,
      }),
    ).rejects.toThrow(/blocked network address/);

    expect(http).toHaveBeenCalledOnce();
    expect(resolver).toHaveBeenCalledOnce();
  });

  it("follows a relative redirect manually and returns response metadata", async () => {
    const resolver = vi.fn(async () => PUBLIC_ADDRESSES);
    let requestCount = 0;
    const http = fetchMock(async (input, init) => {
      requestCount += 1;
      expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).get("user-agent")).toBe(USER_AGENT);
      expect(init?.signal).toBeInstanceOf(AbortSignal);

      if (requestCount === 1) {
        expect(input.toString()).toBe("https://example.test/start");
        return new Response(null, {
          status: 302,
          headers: { location: "../final" },
        });
      }

      expect(input.toString()).toBe("https://example.test/final");
      return new Response(new Uint8Array([65, 66, 67]), {
        headers: { "content-type": "text/plain" },
      });
    });

    const result = await fetchUrl("https://example.test/start", {
      timeoutMs: 1_000,
      maxContentBytes: 1_024,
      resolver,
      fetchImpl: http as typeof fetch,
    });

    expect(result).toEqual({
      requestedUrl: "https://example.test/start",
      finalUrl: "https://example.test/final",
      bytes: new Uint8Array([65, 66, 67]),
      contentType: "text/plain",
    });
    expect(http).toHaveBeenCalledTimes(2);
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it(`stops after ${MAX_REDIRECTS} redirects`, async () => {
    let requestCount = 0;
    const http = fetchMock(async () => {
      requestCount += 1;
      return new Response(null, {
        status: 302,
        headers: { location: `/hop-${requestCount}` },
      });
    });

    await expect(
      fetchUrl("https://example.test/start", {
        timeoutMs: 1_000,
        maxContentBytes: 1_024,
        resolver: publicResolver,
        fetchImpl: http as typeof fetch,
      }),
    ).rejects.toThrow(`Too many redirects (maximum ${MAX_REDIRECTS})`);

    expect(http).toHaveBeenCalledTimes(MAX_REDIRECTS + 1);
  });

  it("rejects a redirect response without a Location header", async () => {
    const http = fetchMock(async () => new Response(null, { status: 302 }));

    await expect(
      fetchUrl("https://93.184.216.34/start", {
        timeoutMs: 1_000,
        maxContentBytes: 1_024,
        fetchImpl: http as typeof fetch,
      }),
    ).rejects.toThrow(/redirect.*did not include a Location header/i);
  });

  it("rejects a streamed body that exceeds the byte limit instead of truncating", async () => {
    const http = fetchMock(
      async () => new Response(new Uint8Array([1, 2, 3, 4])),
    );

    await expect(
      fetchUrl("https://93.184.216.34/data", {
        timeoutMs: 1_000,
        maxContentBytes: 3,
        fetchImpl: http as typeof fetch,
      }),
    ).rejects.toThrow(/exceeds the 3-byte content limit/);
  });

  it("includes a non-success HTTP status in the error", async () => {
    const http = fetchMock(
      async () =>
        new Response("unavailable", {
          status: 503,
          statusText: "Service Unavailable",
        }),
    );

    await expect(
      fetchUrl("https://93.184.216.34/data", {
        timeoutMs: 1_000,
        maxContentBytes: 1_024,
        fetchImpl: http as typeof fetch,
      }),
    ).rejects.toThrow(/HTTP 503 Service Unavailable/);
  });

  it("times out even when an injected fetch does not settle", async () => {
    vi.useFakeTimers();
    const http = fetchMock(async () => new Promise<Response>(() => undefined));

    const request = fetchUrl("https://93.184.216.34/data", {
      timeoutMs: 25,
      maxContentBytes: 1_024,
      fetchImpl: http as typeof fetch,
    });
    const rejection = expect(request).rejects.toThrow(
      "Fetch timed out after 25 ms",
    );

    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(http).toHaveBeenCalledOnce();
  });
});
