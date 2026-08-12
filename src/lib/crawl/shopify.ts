import type { ShopifyProduct } from "./normalize";
import type { NormalizeInput } from "./normalize";
import type { NormalizedTech } from "./types";
import { fingerprintTech } from "./fingerprint";
import { checkUrlIsSafeToFetch, type DnsLookup } from "../security/ssrf-guard";

/**
 * Fetches a Shopify storefront's public JSON endpoints and hands back a
 * NormalizeInput — the raw material for normalizeSnapshot(). This file does
 * no normalization itself; that stays normalize.ts's job so there is one
 * definition of "Shopify JSON -> canonical shape", not two.
 *
 * Everything here is IO. Nothing in engine.ts or normalize.ts depends on it,
 * and it depends on nothing but the crawl<->engine contract in ./types —
 * swap in a WooCommerce or BigCommerce crawler later without touching either.
 */

// Identify yourself honestly and point at a real bot-info page before
// crawling anything you don't own — a generic/missing User-Agent is also
// what gets you rate-limited or blocked outright by most WAFs.
const DEFAULT_USER_AGENT = "Mozilla/5.0 (compatible; StoreIntelBot/0.1; +https://example.com/bot)";

type FetchLike = typeof fetch;

/**
 * Real phase transitions the caller can render as a live progress log —
 * every event corresponds to something that actually just happened, not a
 * synthetic timer. If a phase hasn't happened yet, no event for it has
 * fired; the caller must never fabricate one to fill a gap.
 */
export type CrawlPhase =
  | "validating"
  | "connecting"
  | "fetching_products"
  | "fetching_extras"
  | "done";

export interface CrawlProgressEvent {
  phase: CrawlPhase;
  message: string;
  detail?: Record<string, unknown>;
}

export type CrawlProgressCallback = (event: CrawlProgressEvent) => void;

export interface CrawlOptions {
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: FetchLike;
  /** Injectable for tests; defaults to real DNS resolution. */
  dnsLookup?: DnsLookup;
  userAgent?: string;
  /** Products per /products.json page. Shopify's public max is 250. */
  pageSize?: number;
  /** Safety cap on pagination depth. 60 * 250 = 15,000 products of headroom. */
  maxPages?: number;
  /** Pause between page requests — politeness, not just evasion-avoidance. */
  requestDelayMs?: number;
  timeoutMs?: number;
  onProgress?: CrawlProgressCallback;
}

export type CrawlResult =
  | { status: "ok"; input: NormalizeInput }
  /** Rejected before any request was made — not a public address (SSRF guard). */
  | { status: "invalid"; reason: string }
  /** Reachable, but refused: password-protected, WAF/bot-challenge, 401/403. */
  | { status: "blocked"; reason: string }
  /** Nothing Shopify-shaped at this domain — 404, or 2xx with the wrong body. */
  | { status: "not_found"; reason: string }
  /** Couldn't even complete the first request — DNS, timeout, connection reset. */
  | { status: "error"; reason: string };

export function canonicalizeDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
}

export async function crawlShopifyStore(
  domainInput: string,
  opts: CrawlOptions = {},
): Promise<CrawlResult> {
  const domain = canonicalizeDomain(domainInput);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const dnsLookup = opts.dnsLookup;
  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
  const pageSize = opts.pageSize ?? 250;
  const maxPages = opts.maxPages ?? 60;
  const requestDelayMs = opts.requestDelayMs ?? 250;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const onProgress = opts.onProgress ?? (() => {});
  const baseUrl = `https://${domain}`;
  const deps: FetchDeps = { fetchImpl, dnsLookup, userAgent, timeoutMs };

  onProgress({ phase: "validating", message: `Validating ${domain}` });

  // SSRF guard: reject before making a single request, not after. This is
  // the primary gate — every fetchWithTimeout call below re-checks its own
  // target too, since a redirect can point somewhere this first check never saw.
  const safety = await checkUrlIsSafeToFetch(baseUrl, dnsLookup);
  if (!safety.ok) {
    return { status: "invalid", reason: safety.reason ?? "URL rejected" };
  }

  onProgress({ phase: "connecting", message: `Connecting to ${domain}` });

  // Page 1 doubles as the "is this even a live Shopify store" probe — no
  // separate throwaway request needed.
  let first = await fetchProductsPage(baseUrl, 1, pageSize, deps);
  if (!first.ok) {
    // Same one-retry treatment every later page gets — a transient blip here
    // is more consequential than anywhere else in the crawl, since it fails
    // the whole analysis instead of just truncating the catalog. Confirmed
    // live against a real server: a first-page network blip with zero retry
    // was misclassified as "store unreachable" for a store that was, a
    // moment later, reachable fine.
    await sleep(first.retryAfterMs ?? requestDelayMs);
    first = await fetchProductsPage(baseUrl, 1, pageSize, deps);
  }
  if (!first.ok) {
    return classifyFirstPageFailure(first);
  }

  onProgress({
    phase: "fetching_products",
    message: "Shopify store detected",
  });

  const rawProducts: ShopifyProduct[] = [...first.products];
  let httpErrors = 0;
  let pagesFetched = 1;
  let lastPageFirstId: number | null = first.products[0]?.id ?? null;
  let reachedEnd = first.products.length < pageSize;

  onProgress({
    phase: "fetching_products",
    message: `Discovered ${rawProducts.length} products`,
    detail: { productCount: rawProducts.length, pagesFetched },
  });

  for (let page = 2; !reachedEnd && page <= maxPages; page++) {
    if (requestDelayMs > 0) await sleep(requestDelayMs);

    let attempt = await fetchProductsPage(baseUrl, page, pageSize, deps);
    if (!attempt.ok) {
      // One retry for transient blips — honoring Retry-After on a 429 —
      // before counting the page as a genuine failure.
      await sleep(attempt.retryAfterMs ?? requestDelayMs);
      attempt = await fetchProductsPage(baseUrl, page, pageSize, deps);
    }

    if (!attempt.ok) {
      httpErrors++;
      break; // catalog is now known-incomplete; further pages don't help
    }

    pagesFetched++;

    if (attempt.products.length === 0) {
      reachedEnd = true;
      break;
    }

    // Known Shopify quirk: page-based /products.json pagination can start
    // silently repeating the last real page instead of returning empty once
    // you're past the platform's supported depth. A repeat is a clean
    // end-of-catalog signal, not a failure — what we already collected is
    // real, there's just nothing new here.
    const firstId = attempt.products[0]?.id ?? null;
    if (firstId !== null && firstId === lastPageFirstId) {
      reachedEnd = true;
      break;
    }
    lastPageFirstId = firstId;
    rawProducts.push(...attempt.products);

    if (attempt.products.length < pageSize) {
      reachedEnd = true; // short page — this is the last one, no need to probe further
    }
  }

  if (!reachedEnd && pagesFetched >= maxPages) {
    // Hit the safety cap without a clean termination signal — we genuinely
    // don't know if there's more. Routed through httpErrors, not a separate
    // flag: that's the field normalizeSnapshot() already reads as "removal
    // detection can't be trusted this crawl," which is exactly true here too.
    httpErrors++;
  }

  onProgress({
    phase: "fetching_products",
    message: `Discovered ${rawProducts.length} products total`,
    detail: { productCount: rawProducts.length, pagesFetched },
  });
  onProgress({ phase: "fetching_extras", message: "Reading theme, apps, and collections" });

  // Best-effort extras. None of these may fail the crawl — a store with a
  // broken bestsellers collection or a locked-down homepage still has a
  // perfectly good product diff waiting in rawProducts. Progress fires as
  // each one actually resolves, not in Promise.all's fixed order.
  const rankPromise = fetchBestsellerRanks(baseUrl, pageSize, deps).then((ranks) => {
    onProgress({ phase: "fetching_extras", message: `Bestseller ranking ${ranks.size > 0 ? "found" : "unavailable"}` });
    return ranks;
  });
  const collectionsPromise = fetchCollectionHandles(baseUrl, deps).then((result) => {
    onProgress({
      phase: "fetching_extras",
      message: `Found ${result.handles.length} collections`,
      detail: { collectionCount: result.handles.length },
    });
    return result;
  });
  const homepagePromise = fetchHomepage(baseUrl, deps).then((html) => {
    const tech: NormalizedTech | null = html ? fingerprintTech(html) : null;
    const currency = html ? extractCurrency(html) : null;
    onProgress({
      phase: "fetching_extras",
      message: tech?.themeName ? `Theme detected: ${tech.themeName}` : "Detecting theme and technology stack",
      detail: tech?.themeName ? { themeName: tech.themeName } : undefined,
    });
    return { tech, currency, html };
  });

  const [bestsellerRanks, collections, homepageResult] = await Promise.all([
    rankPromise,
    collectionsPromise,
    homepagePromise,
  ]);

  const { tech, currency, html: homepageHtml } = homepageResult;

  onProgress({ phase: "done", message: "Analysis complete" });

  return {
    status: "ok",
    input: {
      domain,
      currency,
      rawProducts,
      bestsellerRanks,
      collectionHandles: collections.handles,
      hasCollectionData: collections.complete,
      tech,
      hasTechData: homepageHtml !== null,
      // Shopify's public JSON API never states a catalog total up front —
      // there is no reliable "pagesExpected" to report. httpErrors is the
      // signal that actually carries crawl-completeness information here.
      pagesExpected: null,
      pagesFetched,
      httpErrors,
      capturedAt: new Date(),
    },
  };
}

// ---------------------------------------------------------------------------
// /products.json paging
// ---------------------------------------------------------------------------

interface FetchDeps {
  fetchImpl: FetchLike;
  dnsLookup?: DnsLookup;
  userAgent: string;
  timeoutMs: number;
}

interface PageSuccess {
  ok: true;
  products: ShopifyProduct[];
}
interface PageFailure {
  ok: false;
  httpStatus: number | null;
  retryAfterMs: number | null;
  error: string;
}
type PageResult = PageSuccess | PageFailure;

async function fetchProductsPage(
  baseUrl: string,
  page: number,
  pageSize: number,
  deps: FetchDeps,
): Promise<PageResult> {
  const url = `${baseUrl}/products.json?limit=${pageSize}&page=${page}`;
  let res: Response;
  try {
    res = await fetchWithTimeout(url, deps);
  } catch (e) {
    return { ok: false, httpStatus: null, retryAfterMs: null, error: describeNetworkError(e) };
  }

  if (!res.ok) {
    return {
      ok: false,
      httpStatus: res.status,
      retryAfterMs: parseRetryAfter(res),
      error: `HTTP ${res.status}`,
    };
  }

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const error = looksLikeBotChallenge(text) ? "bot-challenge page (non-JSON response)" : "invalid JSON";
    return { ok: false, httpStatus: res.status, retryAfterMs: null, error };
  }

  const products = (parsed as { products?: unknown }).products;
  if (!Array.isArray(products)) {
    return {
      ok: false,
      httpStatus: res.status,
      retryAfterMs: null,
      error: "response has no products array — likely not a Shopify storefront",
    };
  }

  return { ok: true, products: products as ShopifyProduct[] };
}

function classifyFirstPageFailure(failure: PageFailure): CrawlResult {
  if (failure.httpStatus === 401 || failure.httpStatus === 403) {
    return {
      status: "blocked",
      reason: `products.json returned ${failure.httpStatus} — likely password-protected or blocked`,
    };
  }
  if (failure.httpStatus === 404) {
    return { status: "not_found", reason: "products.json 404 — not a Shopify storefront, or the endpoint is disabled" };
  }
  if (failure.error.includes("bot-challenge")) {
    return { status: "blocked", reason: failure.error };
  }
  if (failure.httpStatus !== null && failure.httpStatus >= 200 && failure.httpStatus < 300) {
    return { status: "not_found", reason: `products.json responded but ${failure.error}` };
  }
  return { status: "error", reason: failure.error };
}

// ---------------------------------------------------------------------------
// Best-effort extras — ranks, collections, tech/currency
// ---------------------------------------------------------------------------

async function fetchBestsellerRanks(
  baseUrl: string,
  pageSize: number,
  deps: FetchDeps,
): Promise<Map<string, number>> {
  // Only the top `pageSize` matter: DEFAULT_DIFF_CONFIG.bestsellerWindow is
  // 60, so a single page comfortably covers every rank the engine will ever
  // treat as newsworthy — no need to paginate this one.
  const url = `${baseUrl}/collections/all/products.json?limit=${pageSize}&sort_by=best-selling`;
  try {
    const res = await fetchWithTimeout(url, deps);
    if (!res.ok) return new Map();
    const parsed = JSON.parse(await res.text()) as { products?: ShopifyProduct[] };
    if (!Array.isArray(parsed.products)) return new Map();
    const ranks = new Map<string, number>();
    parsed.products.forEach((p, i) => ranks.set(String(p.id), i));
    return ranks;
  } catch {
    return new Map();
  }
}

/**
 * /collections.json paginates exactly like /products.json (confirmed against
 * a real store: allbirds.com has 1,345 collections — Shopify auto-generates
 * one per tag combination, so "under 250" is not a safe assumption for any
 * store). A single unpaginated fetch here would silently truncate the set,
 * and every collection past the cut would permanently flap
 * MISSING -> REMOVED -> re-added on every future crawl.
 *
 * No retry-on-failure here (unlike fetchProductsPage): this is best-effort
 * and self-heals next crawl via `complete: false` -> observedKinds excluding
 * COLLECTION, so a transient blip costs one suppressed crawl, not a retry.
 */
async function fetchCollectionHandles(
  baseUrl: string,
  deps: FetchDeps,
): Promise<{ handles: string[]; complete: boolean }> {
  const pageSize = 250;
  const maxPages = 20; // 5,000 collections of headroom
  const handles: string[] = [];
  let lastPageFirstHandle: string | null = null;

  for (let page = 1; page <= maxPages; page++) {
    const url = `${baseUrl}/collections.json?limit=${pageSize}&page=${page}`;
    let pageHandles: string[];
    try {
      const res = await fetchWithTimeout(url, deps);
      if (!res.ok) return { handles, complete: false };
      const parsed = JSON.parse(await res.text()) as { collections?: Array<{ handle?: string }> };
      if (!Array.isArray(parsed.collections)) return { handles, complete: false };
      pageHandles = parsed.collections.map((c) => c.handle).filter((h): h is string => Boolean(h));
    } catch {
      return { handles, complete: false };
    }

    if (pageHandles.length === 0) return { handles, complete: true };

    // Same repeat-page quirk as /products.json.
    if (pageHandles[0] === lastPageFirstHandle) return { handles, complete: true };
    lastPageFirstHandle = pageHandles[0];

    handles.push(...pageHandles);

    if (pageHandles.length < pageSize) return { handles, complete: true };
  }

  return { handles, complete: false }; // hit the safety cap without a clean end
}

async function fetchHomepage(baseUrl: string, deps: FetchDeps): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(`${baseUrl}/`, deps, { Accept: "text/html" });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function extractCurrency(html: string): string | null {
  const match = html.match(/Shopify\.currency\s*=\s*(\{[^;<]*\})/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    return typeof parsed.active === "string" ? parsed.active : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_REDIRECTS = 5;

/**
 * Manual redirect handling, not fetch's automatic follow: a validated public
 * URL can redirect to an internal one, and the SSRF guard only ever saw the
 * URL we started with unless every hop gets re-checked before we follow it.
 */
async function fetchWithTimeout(
  url: string,
  deps: FetchDeps,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  let currentUrl = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const safety = await checkUrlIsSafeToFetch(currentUrl, deps.dnsLookup);
    if (!safety.ok) {
      throw new Error(`blocked by SSRF guard: ${safety.reason}`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
    let res: Response;
    try {
      res = await deps.fetchImpl(currentUrl, {
        headers: { "User-Agent": deps.userAgent, Accept: "application/json", ...extraHeaders },
        signal: controller.signal,
        redirect: "manual",
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.status < 300 || res.status >= 400) {
      return res;
    }

    const location = res.headers.get("location");
    if (!location) {
      return res; // redirect status with no target — let the caller treat it as a non-ok response
    }
    currentUrl = new URL(location, currentUrl).toString();
  }

  throw new Error(`too many redirects (>${MAX_REDIRECTS})`);
}

function parseRetryAfter(res: Response): number | null {
  const header = res.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

function looksLikeBotChallenge(body: string): boolean {
  return /cf-browser-verification|Just a moment\.\.\.|Attention Required! \| Cloudflare|__cf_chl_/i.test(
    body.slice(0, 2000),
  );
}

function describeNetworkError(e: unknown): string {
  if (e instanceof Error) {
    return e.name === "AbortError" ? "request timed out" : e.message;
  }
  return String(e);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
