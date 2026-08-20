import { promises as dns } from "node:dns";
import ipaddr from "ipaddr.js";

/**
 * SSRF protection for the crawler. This is the only thing standing between
 * "paste any URL" and an attacker reading cloud metadata endpoints or
 * internal services through our server.
 *
 * Deliberately an ALLOWLIST, not a denylist: an address is safe only if
 * ipaddr.js classifies it as "unicast". Every other range (loopback,
 * private, linkLocal, uniqueLocal, carrierGradeNat, reserved, multicast,
 * benchmarking, teredo, 6to4, the whole long tail of RFC-reserved blocks...)
 * is rejected by construction. A range we didn't think of still fails closed.
 *
 * Classic bypass encodings (decimal/octal/hex IPv4, IPv4-mapped IPv6) are
 * defeated for free: WHATWG URL parsing (new URL()) already canonicalizes
 * all of them before we ever look at the hostname — verified empirically,
 * not assumed. IPv4-mapped IPv6 is unwrapped explicitly below regardless.
 */

export type DnsLookup = (
  hostname: string,
) => Promise<Array<{ address: string }>>;

const defaultDnsLookup: DnsLookup = (hostname) => dns.lookup(hostname, { all: true, verbatim: true });

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

export interface SsrfCheckResult {
  ok: boolean;
  reason?: string;
  url?: URL;
}

export function isPublicUnicast(ip: string): boolean {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.process(ip);
  } catch {
    return false;
  }
  if (addr.kind() === "ipv6") {
    const v6 = addr as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) {
      // An attacker can address a private IPv4 host through its IPv6-mapped
      // form (::ffff:169.254.169.254) — unwrap and re-check the real target.
      return isPublicUnicast(v6.toIPv4Address().toString());
    }
  }
  return addr.range() === "unicast";
}

export async function checkUrlIsSafeToFetch(
  rawUrl: string,
  dnsLookup: DnsLookup = defaultDnsLookup,
): Promise<SsrfCheckResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return { ok: false, reason: "only http/https URLs are allowed" };
  }

  const hostname = url.hostname;
  if (!hostname) {
    return { ok: false, reason: "missing hostname" };
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return { ok: false, reason: "localhost is not allowed" };
  }

  // Literal IP in the URL — already canonicalized by the URL parser (defeats
  // decimal/octal/hex encoding tricks), and bracket-stripped for IPv6.
  const literal = hostname.replace(/^\[|\]$/, "").replace(/\]$/, "");
  if (ipaddr.isValid(literal)) {
    return isPublicUnicast(literal)
      ? { ok: true, url }
      : { ok: false, reason: `resolves to a non-public address (${literal})` };
  }

  // Hostname: resolve DNS and check every returned address, not just the
  // first — a rebinding-style DNS answer can list a public address plus a
  // private one in the same response.
  let records: Array<{ address: string }>;
  try {
    records = await dnsLookup(hostname);
  } catch {
    return { ok: false, reason: "DNS resolution failed" };
  }

  if (records.length === 0) {
    return { ok: false, reason: "DNS resolution returned no addresses" };
  }

  for (const r of records) {
    if (!isPublicUnicast(r.address)) {
      return { ok: false, reason: `${hostname} resolves to a non-public address (${r.address})` };
    }
  }

  return { ok: true, url };
}

/**
 * DNS-rebinding between this check and the connection undici actually makes
 * moments later — a short-TTL DNS answer flipping a hostname from a public
 * to a private address in that window — is now closed, not just documented:
 * see pinned-fetch.ts. crawl/shopify.ts's real default fetchImpl resolves
 * and validates a hostname itself (reusing isPublicUnicast, exported above)
 * and then binds the actual request to a custom undici Agent whose
 * `connect.lookup` returns ONLY that already-validated address — there is
 * no second, independent resolution left for a rebinding record to win, and
 * every redirect hop re-pins fresh (fetchWithTimeout calls the default
 * fetchImpl once per hop already).
 *
 * What still isn't, and can't be, closed by any check like this one: a host
 * that is genuinely, persistently public (passes every check here, no
 * rebinding involved) but is itself hostile — e.g. a public server designed
 * to abuse a naive crawler, or a public endpoint that later redirects to
 * attacker-controlled content within the bounds of what's allowed. That's a
 * content-trust problem this function was never meant to solve; it only
 * answers "is this address safe to open a TCP connection to," honestly.
 */
