import { checkRateLimit } from "../../security/rate-limit";
import type { AdDetails, AdSummary, DetailsResult, MarketingAdSource, SearchResult } from "../types";

/**
 * Google advertising intelligence via SerpApi's Google Ads Transparency
 * Center API — the vendor selected in Sub-phase A/B research (see
 * docs/milestone-4-marketing-intelligence-research.md). SerpApi wraps
 * Google's own Ads Transparency Center (adstransparency.google.com); we
 * never talk to Google directly, and never bypass any access control — this
 * is a documented, commercial, publicly-offered API surface.
 *
 * VENDOR CONTRACT — LIVE-VERIFIED IN SUB-PHASE D (real authenticated calls,
 * 7 total, against a real advertiser — Allbirds — deliberately kept minimal
 * for cost reasons once the answer was clear and reproducible):
 *
 *   - `searchAdsForDomain` is ONE call (`engine=google_ads_transparency_center
 *     &text={domain}`), not two. There is NO separate "find the advertiser"
 *     step — `text=domain` returns matching `ad_creatives[]` directly. The
 *     Sub-phase B/C design assumed a two-step advertiser-lookup-then-list
 *     flow; that assumption was wrong and has been removed.
 *   - Each `ad_creatives[]` entry carries its OWN `advertiser_id`/`advertiser`
 *     /`target_domain` — confirmed live that MULTIPLE, unrelated advertisers
 *     can share the same `target_domain` (e.g. an affiliate/reseller running
 *     ads that click through to a brand's site). This adapter does not — and
 *     structurally cannot — determine which advertiser "really is" the
 *     store; every ad's real, vendor-reported `advertiserName` is surfaced
 *     as-is rather than silently attributed to the store being analyzed.
 *   - Real per-ad field names (confirmed, replacing Sub-phase B's guesses):
 *     `ad_creative_id` (not `creative_id`), `advertiser` (not
 *     `advertiser_name`), plus `target_domain`, `format`, `total_days_shown`,
 *     `first_shown`/`last_shown` (Unix timestamps, numbers — Sub-phase B's
 *     code incorrectly expected strings).
 *   - **CRITICAL, confirmed across all three ad formats (text/image/video)
 *     and with an explicit `region` parameter tried as a hypothesis: no
 *     destination/landing-page URL field exists anywhere in the real
 *     ad-details response**, despite SerpApi's own published documentation
 *     describing a `link` field "for text and image ads." The `link` field
 *     that DOES appear on some `ad_creatives[]` entries in the SEARCH
 *     response is a Google `ads-integrity-transparency` creative-PREVIEW
 *     rendering URL (renders the ad's visual content), not a click-through
 *     destination — confirmed by inspecting it directly, not assumed from
 *     the field name. This is the exact STOP CONDITION named in this
 *     project's own Sub-phase B brief ("vendor does not provide destination
 *     URLs"). Matching-scope decisions arising from this are tracked
 *     separately (see the Sub-phase D completion report) — this adapter
 *     still defensively checks a couple of plausible response locations for
 *     a destination URL in case a different account/plan tier discloses one,
 *     but as of this verification it always resolves to null.
 *   - Real, valuable data that DOES exist and IS extracted: `ad_funded_by`
 *     (the details endpoint's own advertiser-name field), per-region
 *     first/last-shown breakdown (`regions[]`), and `more_ads_by_advertiser`.
 *   - `SearchResult`'s `NO_ADVERTISER_FOUND` outcome (defined for
 *     vendor-agnostic future sources) is never produced by this adapter —
 *     there is no distinguishable "advertiser not found" signal in the real
 *     API now that there's no separate lookup step; a domain with no ads
 *     simply returns SUCCESS with an empty `ad_creatives[]`.
 *   - `serpapi_pagination.next` is a real, followable field, confirmed live
 *     — the Sub-phase B pagination-following code was correct.
 *   - Real advertisers can have hundreds to thousands of historical
 *     `total_results` (2000 for Allbirds, spanning 400+ day-old creatives) —
 *     far more than the existing MAX_AD_PAGES safety cap fetches. This is a
 *     real cost consideration for Sub-phase D's completion report, not
 *     addressed by changing the cap here.
 *
 * Every parsing step below is defensive: an unexpected shape is treated as
 * a malformed response (UNAVAILABLE), never silently coerced into "no ads
 * found" or a partially-fabricated ad.
 */

const SERPAPI_BASE_URL = "https://serpapi.com/search.json";
const DEFAULT_TIMEOUT_MS = 15_000;
const RATE_LIMIT_KEY = "serpapi:google_ads_transparency_center";
// SerpApi's published free/dev tier is request-per-second bounded; this is a
// conservative default meant to avoid bursting the vendor, not a claim about
// any specific plan's real quota (pricing/quota were UNKNOWN — unpublished —
// as of Sub-phase A/B research; see the final report).
const DEFAULT_RATE_LIMIT = { limit: 5, windowMs: 1_000 };
// Safety cap on ads-list pagination. CONFIRMED EXPENSIVE LIVE (Sub-phase D):
// a real, moderately-large advertiser (Allbirds) had 2000 total_results at
// 40/page — the OLD cap of 10 silently walked all 10 pages (400 ads, 10
// requests) on a single collection call, every single cycle, since nothing
// distinguishes a first-ever baseline from a routine steady-state check.
// Lowered to 2 (80 ads, 2 requests) as an unambiguous cost fix: most of a
// large advertiser's total_results are old creatives (total_days_shown in
// the hundreds) already seen in a prior cycle, and Google's own ordering
// put currently-relevant ads on the first page in every response observed
// live. Revisit with real usage data before raising this again — do not
// re-raise it without first checking real vendor pricing (still UNVERIFIED).
const MAX_AD_PAGES = 2;

type FetchLike = typeof fetch;

export interface GoogleAdsSourceOptions {
  apiKey: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  rateLimit?: { limit: number; windowMs: number };
}

export function createGoogleAdsSource(opts: GoogleAdsSourceOptions): MarketingAdSource {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const rateLimit = opts.rateLimit ?? DEFAULT_RATE_LIMIT;
  const apiKey = opts.apiKey;

  async function callSerpApiUrl(url: URL): Promise<CallResult> {
    const gate = checkRateLimit(RATE_LIMIT_KEY, rateLimit);
    if (!gate.allowed) {
      return { ok: false, reason: `rate limited — retry after ${gate.retryAfterMs}ms`, retryable: false };
    }

    const attempt = () => fetchJson(fetchImpl, url.toString(), timeoutMs);
    let result = await attempt();
    // One retry for transient failures, same discipline as the Shopify
    // crawler's fetchProductsPage — a single blip should not fail the whole
    // collection attempt (and thus should not corrupt the dataset with a
    // false "no ads found").
    if (!result.ok && result.retryable) {
      result = await attempt();
    }
    return result;
  }

  function callSerpApi(params: Record<string, string>): Promise<CallResult> {
    const url = new URL(SERPAPI_BASE_URL);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("api_key", apiKey);
    return callSerpApiUrl(url);
  }

  /**
   * Follows SerpApi's conventional `serpapi_pagination.next` link, bounded
   * by MAX_PAGES the same way the Shopify crawler bounds /products.json
   * pagination — a safety cap, not an expectation that any real advertiser
   * has this many running ads. UNVERIFIED against a live response for this
   * specific engine (see the header comment); defensive parsing means a
   * response without this field simply behaves as a single page.
   */
  async function fetchAllAdPages(
    firstPageBody: unknown,
  ): Promise<{ bodies: unknown[]; requestCount: number } | { malformed: true; requestCount: number } | { failed: CallResult & { ok: false }; requestCount: number }> {
    const bodies: unknown[] = [firstPageBody];
    let requestCount = 0;
    let current = firstPageBody;

    for (let page = 1; page < MAX_AD_PAGES; page++) {
      if (!isRecord(current)) return { malformed: true, requestCount };
      const pagination = current.serpapi_pagination;
      const next = isRecord(pagination) && typeof pagination.next === "string" ? pagination.next : null;
      if (!next) break;

      let nextUrl: URL;
      try {
        nextUrl = new URL(next);
      } catch {
        break; // malformed pagination link — treat what we have as complete rather than fail the whole run
      }
      nextUrl.searchParams.set("api_key", apiKey);

      const result = await callSerpApiUrl(nextUrl);
      requestCount++;
      if (!result.ok) return { failed: result, requestCount };

      bodies.push(result.body);
      current = result.body;
    }

    return { bodies, requestCount };
  }

  return {
    platform: "GOOGLE",
    source: "SERPAPI_GOOGLE_ADS_TRANSPARENCY_CENTER",

    async searchAdsForDomain(domain: string): Promise<SearchResult> {
      // ONE call, not two — see the module header. `text=domain` returns
      // matching ad_creatives directly; there is no separate advertiser
      // lookup step in the real API.
      const call = await callSerpApi({
        engine: "google_ads_transparency_center",
        text: domain,
      });
      let requestCount = 1;

      if (!call.ok) {
        return { outcome: "UNAVAILABLE", reason: call.reason, requestCount };
      }

      const paged = await fetchAllAdPages(call.body);
      requestCount += paged.requestCount;
      if ("malformed" in paged) {
        return { outcome: "UNAVAILABLE", reason: "vendor returned an unrecognized response shape", requestCount };
      }
      if ("failed" in paged) {
        return { outcome: "UNAVAILABLE", reason: paged.failed.reason, requestCount };
      }

      const ads: AdSummary[] = [];
      for (const body of paged.bodies) {
        const pageAds = extractAdSummaries(body, domain);
        if (pageAds === "malformed") {
          return { outcome: "UNAVAILABLE", reason: "vendor returned an unrecognized response shape", requestCount };
        }
        ads.push(...pageAds);
      }

      // A domain with genuinely no matching ads returns SUCCESS with an
      // empty array (case A: checked, none found) — never NO_ADVERTISER_FOUND,
      // which this adapter cannot distinguish (see module header).
      return { outcome: "SUCCESS", ads, requestCount };
    },

    async getAdDetails(ad: AdSummary): Promise<DetailsResult> {
      if (!ad.advertiserExternalId) {
        return { outcome: "UNAVAILABLE", reason: "ad has no advertiser id — cannot fetch details", requestCount: 0 };
      }

      const call = await callSerpApi({
        engine: "google_ads_transparency_center_ad_details",
        advertiser_id: ad.advertiserExternalId,
        creative_id: ad.externalAdId,
      });

      if (!call.ok) {
        return { outcome: "UNAVAILABLE", reason: call.reason, requestCount: 1 };
      }

      const details = extractAdDetails(call.body, ad);
      if (details === "malformed") {
        return { outcome: "UNAVAILABLE", reason: "vendor returned an unrecognized response shape", requestCount: 1 };
      }

      return { outcome: "SUCCESS", details, requestCount: 1 };
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

type CallResult = { ok: true; body: unknown } | { ok: false; reason: string; retryable: boolean };

async function fetchJson(fetchImpl: FetchLike, url: string, timeoutMs: number): Promise<CallResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(url, { signal: controller.signal, headers: { Accept: "application/json" } });
  } catch (e) {
    const timedOut = e instanceof Error && e.name === "AbortError";
    return { ok: false, reason: timedOut ? "request timed out" : describeNetworkError(e), retryable: true };
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: `authentication failed (HTTP ${res.status})`, retryable: false };
  }
  if (res.status === 429) {
    return { ok: false, reason: "vendor rate limit exceeded (HTTP 429)", retryable: true };
  }
  if (res.status >= 500) {
    return { ok: false, reason: `vendor server error (HTTP ${res.status})`, retryable: true };
  }
  if (!res.ok) {
    return { ok: false, reason: `unexpected vendor response (HTTP ${res.status})`, retryable: false };
  }

  const read = await readJsonBounded(res);
  if (!read.ok) {
    return { ok: false, reason: read.reason, retryable: false };
  }
  const body = read.body;

  // SerpApi's own error envelope: { error: "..." } with a 200 status.
  if (isRecord(body) && typeof body.error === "string") {
    return { ok: false, reason: `vendor error: ${body.error}`, retryable: false };
  }

  return { ok: true, body };
}

function describeNetworkError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Generous for a JSON ad list (typically a few dozen ads at most), but a
// real cap: an oversized/misbehaving response must fail cleanly rather than
// buffer unboundedly into memory (Sub-phase D security review — this vendor
// is the only outbound call in this codebase with no prior size guard).
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

async function readJsonBounded(res: Response): Promise<{ ok: true; body: unknown } | { ok: false; reason: string }> {
  const reader = res.body?.getReader();
  if (!reader) {
    try {
      return { ok: true, body: await res.json() };
    } catch {
      return { ok: false, reason: "vendor response was not valid JSON" };
    }
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: `vendor response exceeded the ${MAX_RESPONSE_BYTES}-byte limit` };
      }
      chunks.push(value);
    }
  } catch (e) {
    return { ok: false, reason: `failed reading vendor response: ${describeNetworkError(e)}` };
  }

  const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf-8");
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, reason: "vendor response was not valid JSON" };
  }
}

// ---------------------------------------------------------------------------
// Response parsing — isolated so a vendor field-name correction is a
// localized change, not a rewrite of the request/orchestration logic.
// ---------------------------------------------------------------------------

/**
 * `domain` is used only as a defensive filter (drop any entry whose
 * `target_domain` doesn't match) — in live testing every returned entry
 * already matched, but nothing guarantees that holds for every domain/query,
 * and this is cheap insurance against silently attributing another site's
 * ad to the store being analyzed.
 */
function extractAdSummaries(body: unknown, domain: string): AdSummary[] | "malformed" {
  if (!isRecord(body)) return "malformed";
  const raw = body.ad_creatives;
  if (raw === undefined) return "malformed";
  if (!Array.isArray(raw)) return "malformed";

  const ads: AdSummary[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const externalAdId = entry.ad_creative_id;
    if (typeof externalAdId !== "string" || externalAdId.length === 0) continue;
    const advertiserExternalId = entry.advertiser_id;
    // An ad with no advertiser id can never have its details fetched
    // (the details endpoint requires both ids) — not usable, skip it.
    if (typeof advertiserExternalId !== "string" || advertiserExternalId.length === 0) continue;
    if (typeof entry.target_domain === "string" && entry.target_domain.toLowerCase() !== domain.toLowerCase()) {
      continue;
    }
    ads.push({
      externalAdId,
      advertiserExternalId,
      advertiserName: typeof entry.advertiser === "string" ? entry.advertiser : null,
      format: typeof entry.format === "string" ? entry.format : null,
    });
  }
  return ads;
}

function extractAdDetails(body: unknown, ad: AdSummary): AdDetails | "malformed" {
  if (!isRecord(body)) return "malformed";
  const info = body.search_information;
  if (!isRecord(info)) return "malformed";

  // Destination URL: confirmed absent from every real response seen in
  // Sub-phase D live verification (text/image/video, with and without an
  // explicit region param) — see the module header for the full evidence
  // trail. Checked in the two locations that would plausibly carry it if a
  // different account/plan tier ever discloses one; resolves to null today.
  const creative = Array.isArray(body.ad_creatives) ? body.ad_creatives[0] : undefined;
  const destinationUrl =
    (isRecord(creative) && typeof creative.link === "string" ? creative.link : null) ??
    (typeof info.link === "string" ? info.link : null);

  return {
    externalAdId: ad.externalAdId,
    destinationUrl,
    advertiserExternalId: ad.advertiserExternalId,
    advertiserName: typeof info.ad_funded_by === "string" ? info.ad_funded_by : ad.advertiserName,
    format: typeof info.format === "string" ? info.format : ad.format,
    sourceMetadata: buildSourceMetadata(info),
  };
}

/** Small, non-sensitive subset worth keeping for debugging — never the raw payload wholesale. */
function buildSourceMetadata(info: Record<string, unknown>): Record<string, unknown> | null {
  const meta: Record<string, unknown> = {};
  // Real fields are Unix-timestamp numbers, not strings — corrected from
  // Sub-phase B's untested assumption.
  if (typeof info.first_shown === "number") meta.firstShown = info.first_shown;
  if (typeof info.last_shown === "number") meta.lastShown = info.last_shown;
  if (Array.isArray(info.regions)) {
    const regions = info.regions
      .filter(isRecord)
      .map((r) => ({
        regionName: typeof r.region_name === "string" ? r.region_name : null,
        firstShown: typeof r.first_shown === "number" ? r.first_shown : null,
        lastShown: typeof r.last_shown === "number" ? r.last_shown : null,
      }));
    if (regions.length > 0) meta.regions = regions;
  }
  return Object.keys(meta).length > 0 ? meta : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
