/**
 * Milestone 12 §3.1: "SerpAPI calls with their cost" and "cost per active
 * account" both need a per-call cost constant. Kept in this one file, not
 * inlined into usage-cost.ts, so a real vendor-account price update is a
 * one-line change with no query logic to re-read.
 *
 * SOURCE: https://serpapi.com/pricing, fetched live 2026-08-21. Confirmed
 * plans at that date (monthly price -> included searches/month):
 *   Starter $25 -> 1,000 ($0.0250/search)
 *   Developer $75 -> 5,000 ($0.0150/search)
 *   Production $150 -> 15,000 ($0.0100/search)
 *   Big Data $275 -> 30,000 ($0.00917/search)
 *   Searcher $725 -> 100,000, Volume $1,475 -> 250,000, Infrastructure
 *   $2,750 -> 500,000, Cloud tiers above that.
 *
 * google-serpapi.ts's own header comment records that this project's real
 * account tier/volume was UNVERIFIED as of Sub-phase A/B/D research — no
 * confirmed invoice or vendor-dashboard figure exists in this codebase to
 * pin the constant to instead. Developer ($0.015/search) is used as the
 * default: it's the lowest tier whose volume (5,000/mo = ~165/day) is
 * plausible for a pre-revenue product's real SerpAPI call volume
 * (MAX_AD_PAGES=2 caps each collection run at 2 requests, and marketing
 * collection runs on a daily-or-slower cadence per store — see
 * marketing/policy.ts), while Starter's per-search cost is punitive enough
 * to likely overstate cost. This is a placeholder pending a real vendor
 * invoice or dashboard figure, same status as pricing.ts's BASIC price —
 * update the constant, not the query logic around it, once the actual
 * plan is confirmed.
 */
export const SERPAPI_COST_PER_CALL_CENTS = 1.5; // Developer plan, $75/5,000 = $0.015/search = 1.5 cents/search
