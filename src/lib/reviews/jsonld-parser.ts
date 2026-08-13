/**
 * Parses public storefront product-page JSON-LD for an observed review
 * count. PURE — no I/O, no fetch, no Prisma. Milestone 9 Sub-phase E.
 *
 * Source: the merchant's own `<script type="application/ld+json">` blocks
 * on a product page the crawler already fetched — never a review-provider
 * API (Okendo/Judge.me/Stamped/Yotpo/Loox all remain out of scope; see
 * docs/milestone-9-subphase-b-completion-report.md).
 *
 * Real-world shapes confirmed live during Milestone 9 Sub-phase C/D
 * research, all of which this parser must handle without throwing:
 *   - `Product { aggregateRating: { reviewCount } }` (most common)
 *   - `ProductGroup { hasVariant: [Product, ...] }` with the rating nested
 *     under the group, a variant, or both
 *   - a bare `{ aggregateRating: { itemReviewed: Product } }` node with no
 *     `@type` of its own (confirmed live on allbirds.com)
 *   - `@graph` arrays
 *   - multiple `<script>` blocks on one page
 *   - `reviewCount` as either a JSON string or a JSON number (confirmed:
 *     the string form is the MAJORITY case in the wild — Sub-phase D found
 *     it on 74% of real PRESENT observations)
 *   - multiple sibling Product/ProductGroup nodes on one page (confirmed
 *     majority case, not an edge case: 58% of Sub-phase D's PRESENT pages)
 */

export type JsonLdReviewResult =
  | { status: "PRESENT"; reviewCount: number; ratingValue: number | null }
  | { status: "PRESENT_BUT_INVALID"; reason: string }
  | { status: "ABSENT" }
  | { status: "AMBIGUOUS"; reason: string };

export interface ProductIdentity {
  /** The Shopify handle this page was fetched FOR — the identity we're trying to confirm a match against. */
  handle: string;
}

interface CandidateNode {
  node: Record<string, unknown>;
  /** URL(s) found on this node or its immediate offers, for identity matching. */
  urls: string[];
}

interface CandidateRating {
  rating: Record<string, unknown>;
  /** The product-identity context this rating is attached to, if any could be determined. */
  urls: string[];
  /**
   * True only when this rating's own enclosing node (or its `itemReviewed`)
   * is itself typed Product/ProductGroup. Guards against mis-attributing an
   * unrelated store-wide rating (Organization/LocalBusiness — a real,
   * common pattern, e.g. a Trustpilot company-trust score) to the product
   * being checked just because it happens to be the only rating on the page.
   */
  productAttributable: boolean;
}

function extractLdJsonBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  const re = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  let sawAnyBlock = false;
  while ((match = re.exec(html)) !== null) {
    sawAnyBlock = true;
    try {
      blocks.push(JSON.parse(match[1].trim()));
    } catch {
      // One malformed block must never stop parsing of the others — see
      // Step 2's explicit "never throw because one JSON-LD block is
      // malformed" requirement. Push a sentinel so the caller can still
      // tell "we saw ld+json but it was garbage" apart from "no ld+json at all."
      blocks.push(PARSE_ERROR_SENTINEL);
    }
  }
  return sawAnyBlock ? blocks : [];
}

const PARSE_ERROR_SENTINEL = Symbol("jsonld-parse-error");

function urlsOf(node: Record<string, unknown>): string[] {
  const urls: string[] = [];
  if (typeof node.url === "string") urls.push(node.url);
  if (typeof node["@id"] === "string") urls.push(node["@id"] as string);
  const offers = Array.isArray(node.offers) ? node.offers : node.offers ? [node.offers] : [];
  for (const offer of offers) {
    if (offer && typeof offer === "object" && typeof (offer as Record<string, unknown>).url === "string") {
      urls.push((offer as Record<string, unknown>).url as string);
    }
  }
  return urls;
}

function typeListOf(node: Record<string, unknown>): string[] {
  const t = node["@type"];
  if (typeof t === "string") return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string");
  return [];
}

/**
 * Walks the ENTIRE parsed structure — arrays, `@graph`, arbitrary nesting —
 * rather than assuming one fixed shape. This is the direct fix for the real
 * bug Sub-phase C's own research tooling hit (a shallow, single-shape parser
 * silently undercounted allbirds.com's real data): a naive parser here would
 * reproduce that exact bug in production.
 */
function walk(node: unknown, products: CandidateNode[], ratings: CandidateRating[], seen: Set<object>): void {
  if (!node || typeof node !== "object") return;
  if (seen.has(node)) return; // defends against a pathological self-referential structure
  seen.add(node);

  if (Array.isArray(node)) {
    for (const item of node) walk(item, products, ratings, seen);
    return;
  }

  const record = node as Record<string, unknown>;
  const types = typeListOf(record);
  if (types.includes("Product") || types.includes("ProductGroup")) {
    products.push({ node: record, urls: urlsOf(record) });
  }

  const agg = record.aggregateRating;
  if (agg && typeof agg === "object" && !Array.isArray(agg)) {
    const aggRecord = agg as Record<string, unknown>;
    // The rating's own identity context — either the enclosing node (Product
    // { aggregateRating }) or, for the inverted shape confirmed live on
    // allbirds.com (a bare node whose only content IS the rating), the
    // rating's own itemReviewed sub-object.
    const contextUrls = [...urlsOf(record)];
    let productAttributable = types.includes("Product") || types.includes("ProductGroup");
    const itemReviewed = aggRecord.itemReviewed;
    if (itemReviewed && typeof itemReviewed === "object" && !Array.isArray(itemReviewed)) {
      const itemReviewedRecord = itemReviewed as Record<string, unknown>;
      contextUrls.push(...urlsOf(itemReviewedRecord));
      const itemReviewedTypes = typeListOf(itemReviewedRecord);
      if (itemReviewedTypes.includes("Product") || itemReviewedTypes.includes("ProductGroup")) {
        productAttributable = true;
      }
    }
    ratings.push({ rating: aggRecord, urls: contextUrls, productAttributable });
  }

  for (const key of Object.keys(record)) {
    if (key === "@type" || key === "aggregateRating") continue; // already handled above
    walk(record[key], products, ratings, seen);
  }
}

function pathOf(rawUrl: string): string | null {
  try {
    // Accept both absolute ("https://store.com/products/x?variant=1") and
    // relative ("/products/x") forms — real pages use both.
    const url = rawUrl.startsWith("http") ? new URL(rawUrl) : new URL(rawUrl, "https://placeholder.invalid");
    return url.pathname.toLowerCase().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function matchesHandle(urls: string[], handle: string): boolean {
  const expected = `/products/${handle}`.toLowerCase();
  return urls.some((u) => {
    const p = pathOf(u);
    return p !== null && p === expected;
  });
}

function normalizeReviewCount(raw: unknown): { ok: true; value: number } | { ok: false; reason: string } {
  if (raw === null || raw === undefined) return { ok: false, reason: "reviewCount/ratingCount missing" };
  const n = typeof raw === "string" ? Number(raw.trim()) : typeof raw === "number" ? raw : NaN;
  if (!Number.isFinite(n)) return { ok: false, reason: `reviewCount is not a usable number (${JSON.stringify(raw)})` };
  if (n < 0) return { ok: false, reason: `reviewCount is negative (${n})` };
  if (!Number.isInteger(n)) return { ok: false, reason: `reviewCount is not a whole number (${n})` };
  return { ok: true, value: n };
}

function normalizeRatingValue(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === "string" ? Number(raw.trim()) : typeof raw === "number" ? raw : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * Extracts an observed review count for ONE specific product from a product
 * page's full HTML. Never throws. Returns ABSENT (not a fabricated 0) when
 * no usable data exists, and AMBIGUOUS (not a guess) when the page's
 * structure genuinely doesn't let us confidently attribute a rating to the
 * product we fetched this page for — see Step 3's "do not guess" rule.
 */
export function extractReviewObservation(html: string, identity: ProductIdentity): JsonLdReviewResult {
  const blocks = extractLdJsonBlocks(html);
  if (blocks.length === 0) return { status: "ABSENT" };

  const validBlocks = blocks.filter((b) => b !== PARSE_ERROR_SENTINEL);
  const hadParseErrors = validBlocks.length < blocks.length;

  const products: CandidateNode[] = [];
  const ratings: CandidateRating[] = [];
  const seen = new Set<object>();
  for (const block of validBlocks) walk(block, products, ratings, seen);

  if (products.length === 0 && ratings.length === 0) {
    return hadParseErrors
      ? { status: "AMBIGUOUS", reason: "storefront JSON-LD present but failed to parse" }
      : { status: "ABSENT" };
  }

  if (ratings.length === 0) return { status: "ABSENT" };

  // Prefer a rating whose own identity context confidently matches the
  // product this page was fetched for.
  const matching = ratings.filter((r) => matchesHandle(r.urls, identity.handle));

  let chosen: CandidateRating | null = null;
  if (matching.length === 1) {
    chosen = matching[0];
  } else if (matching.length > 1) {
    // Multiple ratings all claim to belong to the same product URL — pick
    // the first deterministically rather than guessing between them, but
    // this is still a confident match (same identity), not ambiguous.
    chosen = matching[0];
  } else {
    // No URL matched anything. Ratings with no plausible product
    // attribution at all (e.g. an Organization-wide trust score) are simply
    // not evidence about THIS product — confidently ABSENT, not ambiguous.
    const attributable = ratings.filter((r) => r.productAttributable);
    if (attributable.length === 0) {
      return { status: "ABSENT" };
    }
    if (attributable.length === 1 && products.length <= 1) {
      // Unambiguous on its own terms: exactly one rating explicitly tied to
      // a Product/ProductGroup, at most one product node on the whole page.
      // Nothing else it could plausibly belong to.
      chosen = attributable[0];
    } else {
      // Multiple plausible product-attributable ratings and none could be
      // confidently tied BY URL to the product we fetched this page for.
      // Per Step 3: do not guess.
      return { status: "AMBIGUOUS", reason: "multiple products/ratings on page, none confidently matched by URL" };
    }
  }

  const countRaw = chosen.rating.reviewCount ?? chosen.rating.ratingCount;
  const count = normalizeReviewCount(countRaw);
  if (!count.ok) {
    return { status: "PRESENT_BUT_INVALID", reason: count.reason };
  }

  return {
    status: "PRESENT",
    reviewCount: count.value,
    ratingValue: normalizeRatingValue(chosen.rating.ratingValue),
  };
}
