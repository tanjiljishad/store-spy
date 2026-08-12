import { describe, expect, it } from "vitest";
import { checkUrlIsSafeToFetch, type DnsLookup } from "../ssrf-guard";

function fakeDns(map: Record<string, string[]>): DnsLookup {
  return async (hostname) => {
    const addresses = map[hostname];
    if (!addresses) throw new Error(`ENOTFOUND ${hostname}`);
    return addresses.map((address) => ({ address }));
  };
}

describe("checkUrlIsSafeToFetch — protocol and shape", () => {
  it("rejects an unparseable URL", async () => {
    const r = await checkUrlIsSafeToFetch("not a url");
    expect(r.ok).toBe(false);
  });

  it("rejects non-http(s) protocols", async () => {
    for (const url of ["ftp://example.com/", "file:///etc/passwd", "gopher://example.com/"]) {
      const r = await checkUrlIsSafeToFetch(url);
      expect(r.ok, url).toBe(false);
    }
  });

  it("rejects localhost and *.localhost outright, no DNS lookup needed", async () => {
    const r1 = await checkUrlIsSafeToFetch("http://localhost/", fakeDns({}));
    const r2 = await checkUrlIsSafeToFetch("http://foo.localhost/", fakeDns({}));
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
  });
});

describe("checkUrlIsSafeToFetch — literal IPs, no DNS involved", () => {
  const blocked = [
    "http://127.0.0.1/",
    "http://0.0.0.0/",
    "http://10.1.2.3/",
    "http://172.16.0.5/",
    "http://192.168.1.1/",
    "http://169.254.169.254/", // AWS/GCP/Azure metadata
    "http://100.100.100.200/", // Alibaba Cloud metadata (carrier-grade NAT range)
    "http://[::1]/",
    "http://[fe80::1]/",
    "http://[fc00::1]/",
    "http://[::ffff:127.0.0.1]/", // IPv4-mapped IPv6 wrapping a loopback address
  ];

  it.each(blocked)("blocks %s", async (url) => {
    const r = await checkUrlIsSafeToFetch(url);
    expect(r.ok, url).toBe(false);
  });

  it("allows a genuine public IP literal", async () => {
    const r = await checkUrlIsSafeToFetch("http://1.1.1.1/");
    expect(r.ok).toBe(true);
  });
});

describe("checkUrlIsSafeToFetch — classic IPv4 encoding bypass tricks", () => {
  // WHATWG URL parsing canonicalizes all of these to 127.0.0.1 before we ever
  // inspect the hostname (verified directly against Node's URL, not assumed).
  const tricks = [
    "http://2130706433/", // decimal-integer form of 127.0.0.1
    "http://0x7f000001/", // hex form
    "http://017700000001/", // octal form
    "http://127.1/", // shortened dotted form
    "http://0177.0.0.1/", // octal first octet
  ];

  it.each(tricks)("still blocks %s", async (url) => {
    const r = await checkUrlIsSafeToFetch(url);
    expect(r.ok, url).toBe(false);
  });
});

describe("checkUrlIsSafeToFetch — DNS resolution", () => {
  it("blocks a hostname that resolves to a private address", async () => {
    const r = await checkUrlIsSafeToFetch(
      "https://internal.example.com/",
      fakeDns({ "internal.example.com": ["10.0.0.5"] }),
    );
    expect(r.ok).toBe(false);
  });

  it("blocks if ANY resolved address is private, even if others are public", async () => {
    const r = await checkUrlIsSafeToFetch(
      "https://mixed.example.com/",
      fakeDns({ "mixed.example.com": ["8.8.8.8", "169.254.169.254"] }),
    );
    expect(r.ok).toBe(false);
  });

  it("allows a hostname that resolves only to public addresses", async () => {
    const r = await checkUrlIsSafeToFetch(
      "https://real-store.com/",
      fakeDns({ "real-store.com": ["8.8.8.8"] }),
    );
    expect(r.ok).toBe(true);
  });

  it("fails closed when DNS resolution errors", async () => {
    const r = await checkUrlIsSafeToFetch("https://does-not-resolve.invalid/", fakeDns({}));
    expect(r.ok).toBe(false);
  });

  it("fails closed when DNS resolution returns zero addresses", async () => {
    const r = await checkUrlIsSafeToFetch(
      "https://empty.example.com/",
      async () => [],
    );
    expect(r.ok).toBe(false);
  });
});
