/**
 * Deterministic URL normalization for exact-match ad->product matching.
 *
 * HIGH PRECISION, not maximum recall (Milestone 4 Sub-phase B spec): a
 * missed match is a minor loss; an asserted match that isn't real corrupts
 * the intelligence dataset. There is no fuzzy matching, no title inference,
 * no scoring here — two URLs either normalize to the identical string or
 * they do not match, full stop.
 *
 * Every rule below is deliberate and tested (see normalize-url.test.ts):
 *   - scheme (http/https) is ignored — same page, different scheme
 *   - "www." is stripped — same host as far as a storefront is concerned
 *   - host is lowercased — DNS is case-insensitive
 *   - percent-encoding is decoded — %20 and a literal space are the same path
 *   - a single trailing slash is stripped (except bare "/")
 *   - the fragment (#...) is dropped — never sent to the server, irrelevant
 *   - the ENTIRE query string is dropped for matching purposes — Shopify
 *     product identity is the path (/products/{handle}), and ad platforms
 *     routinely append tracking params (utm_*, gclid, fbclid, ...) that
 *     never change which product a link points to. Keeping some query
 *     params and stripping others would require guessing which ones are
 *     "meaningful," which is exactly the kind of judgment call this module
 *     is designed not to make.
 */

export function normalizeUrlForMatch(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const host = url.hostname.toLowerCase().replace(/^www\./, "");

  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    // Malformed percent-encoding (e.g. a lone "%") — fall back to the raw
    // pathname rather than throwing away an otherwise-valid URL.
    pathname = url.pathname;
  }
  if (pathname.length > 1 && pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }

  return `${host}${pathname}`;
}

/** Canonical Shopify product-page path for a given handle, matching what the crawler stores. */
export function productCanonicalUrl(domain: string, handle: string): string {
  return `https://${domain}/products/${handle}`;
}

export type MatchResult = { productId: string; method: "EXACT_PRODUCT_URL"; confidence: "HIGH" };

/**
 * A store's product catalog, pre-normalized once per collection cycle so
 * matching N ads against M products costs O(N + M), not O(N * M).
 */
export function buildProductMatchIndex(
  domain: string,
  products: Array<{ id: string; handle: string }>,
): Map<string, string> {
  const index = new Map<string, string>();
  for (const p of products) {
    const normalized = normalizeUrlForMatch(productCanonicalUrl(domain, p.handle));
    if (normalized) index.set(normalized, p.id);
  }
  return index;
}

/**
 * Deterministic exact-URL match only. Returns null — never a low-confidence
 * guess — when the destination URL doesn't normalize, or doesn't hit any
 * known product path exactly. There is no MEDIUM/LOW confidence tier for
 * matching: a match is either an exact hit (HIGH) or it doesn't happen.
 */
export function matchDestinationUrl(
  destinationUrl: string | null,
  index: Map<string, string>,
): MatchResult | null {
  if (!destinationUrl) return null;
  const normalized = normalizeUrlForMatch(destinationUrl);
  if (!normalized) return null;
  const productId = index.get(normalized);
  if (!productId) return null;
  return { productId, method: "EXACT_PRODUCT_URL", confidence: "HIGH" };
}
