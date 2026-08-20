import { Agent, fetch as undiciFetch } from "undici";
import { promises as dns } from "node:dns";
import ipaddr from "ipaddr.js";
import { isPublicUnicast } from "./ssrf-guard";
import type { DnsLookup } from "./ssrf-guard";

/**
 * Closes the DNS-rebinding gap ssrf-guard.ts used to document as a known
 * residual: checkUrlIsSafeToFetch() resolves a hostname and validates every
 * address it gets back, but the actual TCP connection undici opens a moment
 * later does its OWN, independent DNS resolution — a short-TTL record that
 * flips from a public to a private address in that window sails straight
 * past a check that already happened. Fixing this means the address that
 * gets CONNECTED TO must be the exact one that was VALIDATED, not a fresh
 * lookup — the classic "pin what you checked" fix for a check-then-use race.
 */

type FetchLike = typeof fetch;

/**
 * Fetch bound to a fixed, already-validated set of IP addresses — undici's
 * `connect.lookup` is overridden to hand back exactly those addresses,
 * regardless of what a real DNS query for the hostname would return at
 * connect time. There is no second resolution for an attacker's rebinding
 * record to win.
 *
 * Uses undici's own `fetch`/`Agent` pair, not Node's global `fetch` with a
 * `dispatcher` override: both come from the SAME undici version this way,
 * avoiding any cross-version incompatibility between a separately-installed
 * `undici` package's `Agent` and whatever undici build Node's own `fetch`
 * happens to embed.
 */
export function createPinnedFetch(validatedIps: string[]): FetchLike {
  if (validatedIps.length === 0) {
    throw new Error("createPinnedFetch requires at least one validated address");
  }

  const agent = new Agent({
    connect: {
      lookup(_hostname, options, callback) {
        if (options.all) {
          callback(
            null,
            validatedIps.map((address) => ({ address, family: ipaddr.process(address).kind() === "ipv6" ? 6 : 4 })),
          );
        } else {
          const address = validatedIps[0];
          callback(null, address, ipaddr.process(address).kind() === "ipv6" ? 6 : 4);
        }
      },
    },
  });

  return (async (input, init) => {
    const response = await undiciFetch(input as string, { ...(init as Record<string, unknown>), dispatcher: agent } as never);
    // undici's Response is structurally compatible with the DOM Response
    // type every caller in this codebase (crawl/shopify.ts) already expects
    // (fetchImpl: typeof fetch) — cast at this one boundary rather than
    // threading undici's own types through the rest of the crawler.
    return response as unknown as Response;
  }) as FetchLike;
}

const defaultDnsLookup: DnsLookup = (hostname) => dns.lookup(hostname, { all: true, verbatim: true });

/**
 * Resolves and validates `hostname` the same way checkUrlIsSafeToFetch()
 * does (isPublicUnicast — imported, never a second copy of that logic), for
 * ONE purpose: handing createPinnedFetch() something concrete to pin to.
 * Deliberately a second resolution on top of checkUrlIsSafeToFetch()'s own —
 * accepted, not overlooked: closing a real rebinding window this way costs
 * one extra, cheap, typically-cached resolver round trip, which is a good
 * trade. A literal IP in the URL needs no DNS at all.
 */
export async function resolveValidatedAddresses(hostname: string, dnsLookup: DnsLookup = defaultDnsLookup): Promise<string[]> {
  const literal = hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (ipaddr.isValid(literal)) {
    return isPublicUnicast(literal) ? [literal] : [];
  }
  const records = await dnsLookup(hostname);
  return records.map((r) => r.address).filter(isPublicUnicast);
}

/**
 * The default `fetchImpl` crawl/shopify.ts's two entry points (crawlShopifyStore,
 * fetchProductPageHtml) fall back to when the caller hasn't injected one of
 * their own (i.e. real production use, never a test — every existing test
 * injects both `fetchImpl` and `dnsLookup` together, see shopify.test.ts).
 * Resolves and pins fresh for whatever URL it's asked to fetch, each time
 * it's called — since fetchWithTimeout's manual redirect loop calls
 * `deps.fetchImpl` once per hop with that hop's own URL, this makes every
 * redirect hop re-pin for free, with no change needed to that loop itself.
 */
export function createAutoPinnedFetch(dnsLookup?: DnsLookup): FetchLike {
  return (async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url);
    const validated = await resolveValidatedAddresses(url.hostname, dnsLookup);
    if (validated.length === 0) {
      throw new Error(`no validated public address to pin for ${url.hostname}`);
    }
    return createPinnedFetch(validated)(input, init);
  }) as FetchLike;
}
