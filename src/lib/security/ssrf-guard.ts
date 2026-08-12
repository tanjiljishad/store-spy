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

function isPublicUnicast(ip: string): boolean {
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
 * Known residual gap: DNS-rebinding between this check and the connection
 * undici actually makes moments later (short-TTL DNS flipping a hostname
 * from a public to a private address in that window) is not closed here —
 * doing that properly means pinning the resolved IP at the transport layer
 * (a custom fetch dispatcher), which is real additional work. This function
 * closes the common case (obviously-private domains and IPs, and unsafe
 * redirect targets, since the crawler re-runs this check on every hop)
 * rather than pretending to be airtight against a sophisticated attacker.
 */
