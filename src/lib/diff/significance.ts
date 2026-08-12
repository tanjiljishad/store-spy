import type { StoreContext } from "../crawl/types";
import type { EventType } from "./events";

/**
 * The diff is easy. Deciding which diffs matter is the actual product.
 *
 *   significance = base(type) x magnitude x relevance x rarity
 *
 * Output is clamped to 0..100. Watchlist alertThreshold (default 60) decides
 * real-time push vs. weekly digest. Tune the constants against real data —
 * these are calibrated starting points, not truths.
 */

const BASE_SCORE: Record<EventType, number> = {
  STORE_BASELINED: 5,
  PRODUCT_ADDED: 45,
  PRODUCT_REMOVED: 40,
  PRODUCT_RESTORED: 30,
  PRICE_DROP: 55,
  PRICE_INCREASE: 40,
  SALE_STARTED: 60,
  SALE_ENDED: 30,
  PRODUCT_SOLD_OUT: 65, // strongest free demand signal available
  PRODUCT_RESTOCKED: 45,
  VARIANT_SOLD_OUT: 20,
  BESTSELLER_ENTERED: 70,
  BESTSELLER_CLIMBED: 55,
  BESTSELLER_DROPPED: 30,
  // Shopify auto-generates a collection per tag combination — a store adding
  // one product tag can spawn several. Too noisy to alert on; low enough to
  // land in the weekly digest instead of a real-time push. Revisit against
  // real corpus numbers.
  COLLECTION_ADDED: 25,
  COLLECTION_REMOVED: 25,
  THEME_CHANGED: 60,
  APP_ADDED: 55,
  APP_REMOVED: 40,
  PIXEL_ADDED: 65, // new pixel = new ad channel = they are scaling
  PIXEL_REMOVED: 35,
  PAYMENT_PROVIDER_ADDED: 45,
  PAYMENT_PROVIDER_REMOVED: 25,
  // A new ad is a real spend/channel signal — comparable to a new pixel.
  AD_DETECTED: 50,
  // Weaker signal than detection: could be a routine creative rotation, not
  // necessarily "they stopped advertising."
  AD_REMOVED: 25,
  AD_CHANGED: 35,
  // Informational/enrichment, not "something happened" — a match can be
  // computed well after the ad itself was first detected.
  PRODUCT_AD_MATCHED: 20,
};

export interface SignificanceInput {
  eventType: EventType;
  store: StoreContext;
  /** 0..1 — size of the change relative to what "big" means for this type. */
  magnitude?: number;
  /** Bestseller rank of the subject product, if known. */
  bestsellerRank?: number | null;
  /** Product price, used to weight high-ticket items slightly higher. */
  priceCents?: number | null;
  /** How many other stores in the corpus did the same thing this week. */
  crossStoreCount?: number;
}

/**
 * RELEVANCE: a change to bestseller #2 matters enormously more than a change
 * to SKU #847 that nobody has ever bought.
 */
function relevanceFactor(rank: number | null | undefined, priceCents: number | null | undefined): number {
  let factor = 0.7; // unranked default — not zero, just quiet

  if (rank !== null && rank !== undefined) {
    if (rank < 5) factor = 1.6;
    else if (rank < 15) factor = 1.35;
    else if (rank < 40) factor = 1.15;
    else if (rank < 100) factor = 0.95;
    else factor = 0.8;
  }

  // Mild high-ticket bump. Deliberately mild: cheap products churn faster and
  // over-weighting price would drown out the volume sellers.
  if (priceCents && priceCents > 15000) factor *= 1.1;

  return factor;
}

/**
 * RARITY: a price change at a store that reprices daily is noise. The same
 * change at a store that has not touched a price in three months is a signal.
 */
function rarityFactor(store: StoreContext, eventType: EventType): number {
  const stats = store.stats;
  if (!stats || stats.crawlsInWindow < 5) return 1.0; // not enough history yet

  const isPriceEvent =
    eventType === "PRICE_DROP" ||
    eventType === "PRICE_INCREASE" ||
    eventType === "SALE_STARTED" ||
    eventType === "SALE_ENDED";

  const isCatalogEvent = eventType === "PRODUCT_ADDED" || eventType === "PRODUCT_REMOVED";

  let ratePerCrawl = 0;
  if (isPriceEvent) ratePerCrawl = stats.priceChangesInWindow / stats.crawlsInWindow;
  else if (isCatalogEvent) ratePerCrawl = stats.productsAddedInWindow / stats.crawlsInWindow;
  else return 1.0;

  if (ratePerCrawl <= 0.2) return 1.4; // rare -> amplify
  if (ratePerCrawl <= 1) return 1.15;
  if (ratePerCrawl <= 5) return 0.9;
  return 0.6; // constant churn -> suppress
}

/**
 * CROSS-STORE: the term competitors cannot replicate without your corpus.
 * One store cutting a price is trivia. Five stores cutting the same product
 * in a week is a market event.
 */
function crossStoreFactor(count: number | undefined): number {
  if (!count || count < 2) return 1.0;
  if (count < 4) return 1.25;
  if (count < 8) return 1.5;
  return 1.75;
}

export function scoreEvent(input: SignificanceInput): number {
  const base = BASE_SCORE[input.eventType] ?? 30;
  const magnitude = clamp(input.magnitude ?? 0.5, 0, 1);

  // Magnitude scales between 60% and 140% of base rather than 0-100%, so a
  // small change to a critical product still outranks a huge change to a
  // product nobody sees.
  const magnitudeFactor = 0.6 + magnitude * 0.8;

  const raw =
    base *
    magnitudeFactor *
    relevanceFactor(input.bestsellerRank, input.priceCents) *
    rarityFactor(input.store, input.eventType) *
    crossStoreFactor(input.crossStoreCount);

  return softSaturate(raw);
}

/**
 * A hard clamp at 100 destroys ordering at the top of the scale: a big price
 * drop on a bestseller already exceeds 100 before the cross-store multiplier
 * is applied, so the market-wide signal — the most valuable term we have —
 * becomes invisible exactly when it matters most.
 *
 * Exponential saturation keeps the output in 0..100 while preserving strict
 * monotonicity: every additional multiplier still moves the number, just by
 * less. SATURATION_K sets where the curve bends; ~70 puts a routine event
 * around 50 and leaves genuine headroom above it.
 */
const SATURATION_K = 70;

function softSaturate(raw: number): number {
  if (raw <= 0) return 0;
  return Math.round(100 * (1 - Math.exp(-raw / SATURATION_K)));
}

/** Maps a fractional price move onto 0..1, saturating at a 50% change. */
export function priceMagnitude(pct: number): number {
  return clamp(Math.abs(pct) / 0.5, 0, 1);
}

/** Maps a rank improvement onto 0..1, saturating at 20 places. */
export function rankMagnitude(places: number): number {
  return clamp(Math.abs(places) / 20, 0, 1);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
