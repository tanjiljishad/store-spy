# Milestone 7, Sub-phase A — Intelligence Productization Research & V1 Report Specification

**Status: research and specification only.** No production application code, Prisma schema,
migration, dependency, or Fable-derived UI was changed to produce this document. One purpose of this
document is to be directly implementable by a future session without re-deriving the architecture —
every claim below is checked against the actual current source, not recalled from a prior summary.

---

## 1. Executive Summary

The platform already collects substantially more intelligence than it currently presents coherently.
Growth Intelligence (Milestone 5), Marketing Intelligence (Milestone 4), and Technology Intelligence
(Milestones 1–2) each shipped as their own additive section, each correct in isolation, but the
product has never had a single, deliberately-ordered "here is everything we know about this store"
report. This sub-phase's central finding: **Sub-phase B does not need to build new intelligence — it
needs to compose, order, and honestly caption intelligence that already exists**, plus close two
concrete, small UI gaps (pixels and payment providers are tracked with full history but never
rendered anywhere) and one concrete, small backend gap (a bounded, product-scoped report endpoint
does not yet exist — today's UI stitches together four separate client-side fetches per page:
`/activity`, `/growth`, `/marketing`, `/events`).

Every existing intelligence-bearing module already follows the OBSERVED/UNAVAILABLE discipline this
document extends. No metric currently ships as `ESTIMATED` or `INFERRED` anywhere in the codebase —
confirmed by grep. This is the strongest asset going into Sub-phase B: nothing needs to be walked
back, only assembled.

**Two real, previously-undocumented findings surfaced during this inspection** (Section 3, marked
`BUG` per the strict-execution-rules "document, don't fix" instruction):
1. `StoreEntity(kind: PIXEL)` and `StoreEntity(kind: PAYMENT_PROVIDER)` rows are fully collected,
   diffed, and event-logged (`PIXEL_ADDED`/`REMOVED`, `PAYMENT_PROVIDER_ADDED`/`REMOVED` all exist in
   the `EventType` enum and all fire from `diffEntitySet()`) but **are never read by
   `buildFullStoreReport()` and never rendered anywhere in the UI.** This is real, complete, already-
   paid-for intelligence sitting unused.
2. `PRODUCT_RESTORED` events are recorded and appear in the raw `ChangeFeedTimeline` feed, but
   `monitoring/activity.ts`'s `ActivitySummary` never counts them — `StoreActivitySummary`'s stat grid
   has no "restored" figure, only added/removed/price-changes.

No `Opportunity Score`, `Store Score`, revenue estimate, traffic estimate, or AI layer is specified
here — none is proposed, per the explicit constraints, and the research in Sections 21–23 explains
why each remains out of scope for V1.

---

## 2. Current Product Capability Map

Verified directly against source this sub-phase — not copied from any prior milestone report.

| Capability | Existing module | Existing API | Existing UI | Data source | Evidence status | Historical depth | Production ready? |
|---|---|---|---|---|---|---|---|
| Shopify platform detection | `crawl/shopify.ts` (`/products.json` probe) | `POST /api/analyze`, `GET /api/store/[domain]/report` | `FreeReportStrip` ("Platform: Shopify") | Storefront JSON | OBSERVED | Point-in-time | Yes |
| Theme name | `crawl/fingerprint.ts` (`extractThemeName`) | report route | `FreeReportStrip`, `FullReportView` "Theme" card | Homepage `Shopify.theme` JS global | OBSERVED | Full, via `THEME_CHANGED` events | Yes |
| Theme version | `crawl/fingerprint.ts` (`extractThemeVersion`) | report route | Same card | Homepage meta tag / inline JS | OBSERVED when present | Same | Partial — frequently `null`; no universal storefront signal exists (documented in `fingerprint.ts` itself), not a bug |
| Apps | `fingerprint.ts` `APP_SIGNATURES`, `StoreEntity(kind: APP)` | report route | `FullReportView` "Apps / technologies" chip list | Homepage HTML regex | OBSERVED (presence only) | Full, via `APP_ADDED`/`REMOVED` | Yes |
| **Pixels** | `fingerprint.ts` `PIXEL_SIGNATURES`, `StoreEntity(kind: PIXEL)` | **None** | **None** | Homepage HTML regex | OBSERVED (presence + captured ID) | Full, via `PIXEL_ADDED`/`REMOVED` | **No — collected, never surfaced (Finding 1)** |
| **Payment providers** | `fingerprint.ts` `PAYMENT_SIGNATURES`, `StoreEntity(kind: PAYMENT_PROVIDER)` | **None** | **None** | Homepage HTML regex | OBSERVED (presence only) | Full, via `PAYMENT_PROVIDER_ADDED`/`REMOVED` | **No — collected, never surfaced (Finding 1)** |
| Review infrastructure | `growth/review-infrastructure.ts` | `GET /api/store/[domain]/growth` | `GrowthIntelligence.tsx` "Review infrastructure" card | `StoreEntity(kind: APP)` filtered to 5 known keys | OBSERVED | Full | Yes |
| Product count | `run-analysis.ts` (`buildFullStoreReport`) | report route | `FreeReportStrip`, `FullReportView` "Products" card | `Product.count()` | OBSERVED | Point-in-time only (trend exists via Growth, not wired to this card) | Yes |
| Average price | Same | Same | "Average price" card | `Product.aggregate` | OBSERVED | Point-in-time only | Yes |
| Product additions | `diff/engine.ts` (`PRODUCT_ADDED`), `monitoring/activity.ts` | `GET /api/store/[domain]/activity` | `StoreActivitySummary` | `Event` | OBSERVED | Windowed (default 7d, up to 90d) | Yes |
| Product removals | Same (`PRODUCT_REMOVED`) | Same | Same | `Event` | OBSERVED | Same | Yes |
| **Product restoration** | `diff/engine.ts` (`PRODUCT_RESTORED`) | `GET /api/store/[domain]/events` only | Raw feed only (`ChangeFeedTimeline`) | `Event` | OBSERVED | Full in raw feed | **Partial — not counted in the activity summary stat grid (Finding 2)** |
| Price changes | `diff/engine.ts` (`PRICE_DROP`/`INCREASE`/`SALE_STARTED`/`SALE_ENDED`) | activity route | `StoreActivitySummary` | `Event` | OBSERVED | Windowed | Yes |
| Product persistence | `growth/persistence.ts` | growth route | `GrowthIntelligence.tsx` product highlights ("seen in X/Y checks") | `Crawl.finishedAt` + `Product.missingSince` + lifecycle `Event`s | OBSERVED | Up to 20 real crawls | Yes (post-Sub-phase-C fix) |
| Product freshness | `growth/freshness.ts` | growth route | Freshness label badge | Derived from persistence | OBSERVED | Same | Yes |
| Catalog growth | `growth/catalog.ts` + `monitoring/activity.ts` reuse | growth route | Stats row + CSS sparkline | `Product.firstSeenAt`/`missingSince` sampled at real `Crawl.finishedAt` dates | OBSERVED | Up to 180 crawls, 12 plotted points | Yes |
| Bestseller current rank | `Product.bestsellerRank` | growth route | Product highlight row | `ProductStateSnapshot` | OBSERVED (ordinal) | Current value | Yes |
| Bestseller movement | `growth/bestseller.ts` | growth route | Product highlight row (`↑/↓ #A → #B`) | `ProductStateSnapshot` history | OBSERVED (ordinal) | Up to 20 snapshots | Yes |
| **Bestseller trajectory** | `growth/bestseller.ts` (`trajectory` array) | growth route (in payload) | **Not visualized** — only `currentRank`/`movement`/`momentum` are rendered | Same | OBSERVED | Same | **Partial — delivered by the API, not shown in the UI (Section 7)** |
| Bestseller momentum | `growth/bestseller.ts` | growth route | "Bestseller momentum: improving/declining/stable" text | Same | OBSERVED (ordinal), gated | ≥4 observations / ≥3 crawls | Yes |
| Marketing/ad activity (presence) | `marketing/report.ts`, `AdObservation` | `GET /api/store/[domain]/marketing` | `AdvertisingSummary.tsx` | SerpApi Google Ads Transparency Center | OBSERVED | Full, via `AD_DETECTED`/`REMOVED` | Yes |
| Ad count | Same | Same | "Ads observed" card | Same | OBSERVED | Windowed activity summary | Yes |
| Ad format | Same | Same | Per-ad list line | Vendor-supplied | OBSERVED | Full | Yes |
| Advertising regions | Same | Same | Per-ad list line | Vendor-supplied, when disclosed | OBSERVED when present | Full | Yes |
| Marketing activity trend | `marketing/activity.ts` | Same | Stat row (new/removed/continuously active) | `Event` + `AdObservation` | OBSERVED, `hasEnoughHistory`-gated | ≥2 collection runs | Yes |
| Product-level ad matching | Schema supports it (`matchedProductId`/`matchMethod`/`matchConfidence`) | Same | "Product matching" card, always `UNAVAILABLE` | N/A | **Permanently `UNAVAILABLE`** | N/A | By design — SerpApi never discloses destination URL (Milestone 4D, re-confirmed unchanged) |
| Ad spend / impressions / conversions | N/A | Same | Three `UNAVAILABLE` cards | N/A | `UNAVAILABLE` | N/A | By design, no source exists |
| Traffic | None | None | None | N/A | `UNAVAILABLE` | N/A | **DO NOT BUILD** (Milestone 5/6, unchanged) |
| Revenue | None | None | None | N/A | `UNAVAILABLE` | N/A | **DO NOT BUILD** (Milestone 5/6, unchanged) |
| Review velocity (as sales proxy) | None | None | None | N/A | `UNAVAILABLE` | N/A | **DO NOT BUILD, permanent** (Milestone 5) |
| Review-count observation | None | None | None | N/A | `UNAVAILABLE` | N/A | **RESEARCH REQUIRED** (Milestone 6) — not V1 |
| Store growth signals | `monitoring/activity.ts` (`computeGrowthSignals`) | activity route | `StoreActivitySummary` pill badges | `Event`/`Product` | OBSERVED | `hasEnoughHistory` ≥2 crawls | Yes |
| Monitoring | `monitoring/watch.ts`, `scheduler.ts`, `policy.ts` | `POST`/`DELETE /api/store/[domain]/watch` | `MonitorButton`, `MonitoringStatusCard`, dashboard, watchlist page | `Watchlist`, `Store.tier` | OBSERVED | N/A | Yes |
| Change events (raw feed) | `diff/persist.ts` writes, `monitoring/change-feed.ts` reads | `GET /api/store/[domain]/events` | `ChangeFeedTimeline` | `Event` | OBSERVED | Cursor-paginated, unbounded total, bounded per page (20/request) | Yes |

---

## 3. Existing Architecture Inventory

Re-verified this sub-phase, organized by the brief's own inspection categories.

**Analysis** (`src/lib/analysis/`): `run-analysis.ts` is the single orchestrator for both the manual
"Analyze" flow and `GET /api/store/[domain]/report`'s re-fetch — `buildFullStoreReport()` is called
from both places, confirmed by direct read, so there is exactly one report-assembly function, not two
that can drift. `report-contract.ts` defines the closed `IntelligenceField<T>` union
(`OBSERVED`/`ESTIMATED`/`INFERRED`/`UNAVAILABLE`) with `observed()`/`unavailable()` helpers.
`types.ts` defines three `AnalysisReport` variants: `anonymous_preview`, `unanalyzed_preview` (a
signed-in user viewing a store they haven't spent one of their 3 analyses on — a real, distinct state
this document's Section 13 flow must account for, not merged into "anonymous"), and `full`.

**Crawling** (`src/lib/crawl/shopify.ts`, `src/lib/security/ssrf-guard.ts`): four endpoint shapes —
`/products.json` (paginated, up to `maxPages=60` × `pageSize=250`), `/collections/all/products.json?
sort_by=best-selling` (single page, unpaginated, intentional per its own comment — see Section 7),
`/collections.json` (paginated, up to 20 pages/5,000 collections — confirmed via the code's own
comment that a real store, allbirds.com, has 1,345 collections, so "under 250" was never a safe
assumption), and homepage `/` for fingerprinting. SSRF protection is allowlist-based (`ipaddr.js`
"unicast" classification, not a denylist), re-validates every redirect hop (`fetchWithTimeout`'s
manual redirect loop, max 5 hops), and explicitly documents its own residual gap (DNS-rebinding
between check and connect) rather than claiming to be airtight. Failure classification is a closed
`CrawlResult` union (`ok`/`invalid`/`blocked`/`not_found`/`error`) with one retry on the first page
specifically (a real historical bug — a transient blip there previously misclassified a reachable
store as unreachable, per the code's own comment) and Shopify's own pagination quirk (a repeated page
past supported depth) handled as a clean end-of-catalog signal, not a failure.

**Diff/Events** (`src/lib/diff/engine.ts`): pure, no I/O. Product diff produces `PRODUCT_ADDED`/
`REMOVED`/`RESTORED`, price events (`PRICE_DROP`/`INCREASE`/`SALE_STARTED`/`ENDED`, thresholded at
2%/100¢ to avoid rounding noise), availability events (`PRODUCT_SOLD_OUT`/`RESTOCKED`/
`VARIANT_SOLD_OUT`), and rank events (`BESTSELLER_ENTERED`/`CLIMBED`/`DROPPED`, gated at
`bestsellerWindow=60` and `minRankImprovement=3`). Entity diff (`diffEntitySet()`) is fully generic
across `APP`/`PIXEL`/`COLLECTION`/`PAYMENT_PROVIDER` — the same ACTIVE→MISSING→REMOVED state machine
products use. Three guards protect signal integrity: GUARD 1 aborts the whole diff on apparent
catalog collapse (>40% shrink, ≥10 products); GUARD 2 skips removal-streak advancement on `PARTIAL`
crawls ("additions are trusted, removals are NOT"); GUARD 3 caps alertable events per crawl at 200,
keeping the highest-significance ones. `significance.ts` computes a 0–100 score once at write time,
never recomputed — its `rarityFactor()` term reads from `StoreStats`, a table confirmed (by grep,
repeatedly, across three prior milestones) never written by any code path, so that term has always
silently defaulted to neutral (1.0).

**Monitoring** (`src/lib/monitoring/`): `scheduler.ts` claims due stores via `SELECT ... FOR UPDATE
SKIP LOCKED`, batch size 10, sequential crawling within a batch. `policy.ts` defines cadence by
`CrawlTier`: HOT 8h, WARM daily, COOL weekly, COLD monthly (default on baseline), DORMANT quarterly,
DISABLED never — plus exponential failure backoff (base 1h, cap 48h, disable after 5 consecutive
failures). `activity.ts` computes `ActivitySummary`/`GrowthSignal[]`, gated on `hasEnoughHistory`
(≥2 real crawls) — the precedent every later "don't fabricate a trend from one data point" gate in
this codebase follows. `watch.ts` backs `Watchlist` start/stop, tier promotion/demotion.

**Growth Intelligence** (`src/lib/growth/`, Milestone 5): `persistence.ts` (corrected in Sub-phase C
to compare `Crawl.finishedAt`, not `startedAt`, against `Product.missingSince`/lifecycle-event
timestamps — both share the same write-time `now`), `catalog.ts` (same `finishedAt` discipline for
trend sampling), `bestseller.ts` (self-consistent on `ProductStateSnapshot.capturedAt` alone, never
cross-referenced against `Crawl` timestamps, confirmed unaffected by the Sub-phase C bug),
`freshness.ts` (thin label layer over persistence: `NEW`/`ESTABLISHED`/`RECENTLY_MISSING`/
`INSUFFICIENT_HISTORY`), `review-infrastructure.ts`, `report.ts` (`buildGrowthReport()`, bounded to
`MAX_PRODUCT_HIGHLIGHTS=20` products, each product's own signals computed via a fixed number of
already-bounded queries run concurrently). Every hard cap is a named constant, documented in the
Sub-phase B/C completion reports and re-verified here by reading the current source, not copied.

**Marketing Intelligence** (`src/lib/marketing/`, Milestone 4): `AdObservation` (one row per vendor
`externalAdId`, two-state `ACTIVE_EVIDENCE`/`HISTORICAL` lifecycle), `MarketingCollectionRun` (one row
per collection attempt, successful or not — mirrors `Crawl`'s role, so a failed check is a recorded
fact, never silently absent), `source-factory.ts` (server-side-only credential handling for SerpApi),
`diff.ts`/`persist.ts`/`scheduler.ts` (parallel structure to the Shopify pipeline, deliberately
separate — its own baseline gate via `Store.marketingBaselinedAt`, its own cadence via
`nextMarketingCollectionAt`). `report.ts`'s `MarketingReport` type hard-codes `productMatching`/
`adSpend`/`impressions`/`conversions` as permanently `unavailable()` — not computed per-request, a
constant — confirmed this is a deliberate, load-bearing design choice (Milestone 4D found SerpApi's
Google Ads Transparency Center endpoint never discloses destination URLs, across every ad format
tested), not a placeholder.

**Technology Intelligence** (`src/lib/crawl/fingerprint.ts`): pure regex-signature matching against
already-fetched HTML (no separate crawl surface). Five signature sets: `APP_SIGNATURES` (20 apps
including the 5 review apps), `PIXEL_SIGNATURES` (7, each with a capture group for the account/pixel
ID itself — meaning pixel *IDs*, not just presence, are already captured in `StoreEntity.meta`),
`PAYMENT_SIGNATURES` (5), theme name/version extraction, `EMAIL_PLATFORM_SIGNATURES` (4, checked in
priority order, single-value not array). Explicitly designed to degrade silently to "not detected"
on signature staleness, never to fabricate — confirmed by the module's own doc comment.

**UI** (`src/components/`): the Fable visual language is a dark, monospace/display-font, card-based
system built from a small set of primitives — `IntelligenceCard` (renders any `IntelligenceField<T>`
uniformly, including the `ESTIMATED` confidence+methodology state, unused today but ready),
`SectionLabel` (uppercase mono section headers), `ChangeFeedTimeline` (cursor-paginated event list,
renders only `item.headline` — the precomputed human-readable string — never the raw `eventType`
enum to the user, confirmed by direct read; this already satisfies the "don't expose raw internal
event names" requirement architecturally). `FullReportView.tsx` and `dashboard/stores/[domain]/
page.tsx` are near-duplicates of each other's section ordering (Store overview → Business
intelligence → Product activity → Growth signals → Recent changes → Advertising intelligence →
advertising-filtered timeline) — the first is the post-analysis SSE result view, the second is the
persistent, revisitable Store Intelligence page; both independently import and render the same child
components, so there is no shared "report body" component today, only shared children — a real
implementation consideration for Section 24/26. Every growth/marketing addition since Milestone 4 has
followed the same rule: reuse `IntelligenceCard`/`SectionLabel`, add one new `<SectionLabel>` +
one new fetch-driven client component, touch nothing else.

**Database**: full model map re-confirmed via direct schema read (Section 2's table cites exact
fields). Historical depth today: `Event` (append-only, unbounded retention, no TTL/cleanup job
exists anywhere — confirmed by grep for any deletion of `Event` rows: none), `ProductStateSnapshot`
(append-only, on-change only, same — no cleanup job), `Crawl` (append-only, no cleanup job),
`AdObservation`/`MarketingCollectionRun` (same pattern). **Nothing in this codebase currently deletes
or archives historical data of any kind** — directly relevant to Section 18.

---

## 4. V1 Store Intelligence Report

Structured per the brief's own A/B/C ordering, cross-checked against what's actually `OBSERVED`
today (Section 2) — nothing below proposes a metric that doesn't already exist.

### A. What is this store?

| Field | Source | Status | UI today |
|---|---|---|---|
| Platform | Crawl probe | OBSERVED | Shipped |
| Theme name/version | `fingerprint.ts` | OBSERVED / partial | Shipped |
| Product count | `Product.count()` | OBSERVED | Shipped |
| Average price | `Product.aggregate` | OBSERVED | Shipped |
| Apps | `StoreEntity(APP)` | OBSERVED | Shipped |
| **Pixels** | `StoreEntity(PIXEL)` | OBSERVED | **Missing — Finding 1, recommend adding to Sub-phase B** |
| **Payment providers** | `StoreEntity(PAYMENT_PROVIDER)` | OBSERVED | **Missing — Finding 1, recommend adding to Sub-phase B** |
| Review infrastructure | `growth/review-infrastructure.ts` | OBSERVED | Shipped (Growth section, could also be cross-referenced here) |

No new backend work is required for pixels/payment providers — `buildFullStoreReport()` would add two
more `IntelligenceField<string[]>` fields following the exact pattern `apps` already uses (a
`storeEntity.findMany({kind: "PIXEL"/"PAYMENT_PROVIDER", status: "ACTIVE"})` query, already indexed
by `[storeId, kind, status]`), and the UI would add two more chip lists next to the existing "Apps /
technologies" card, using the identical rendering pattern.

### B. What is happening with this store?

Per the explicit "no fake score" instruction, this section is a set of independently-labeled,
independently-sourced signal badges — never combined into one number. Each row below is the complete
spec required by the brief ("signal name, calculation, data source, minimum history, confidence/
evidence, wording, failure state"):

| Signal | Calculation | Source | Min. history | Evidence | Wording | Failure state |
|---|---|---|---|---|---|---|
| Catalog activity | Count of `PRODUCT_ADDED`/`REMOVED`/price `Event`s in window | `monitoring/activity.ts` | 2 real crawls | OBSERVED | "+N added · −N removed · N price changes (Nd)" | `hasEnoughHistory: false` → "Monitoring started" |
| Catalog growth | `computeGrowthSignals()` kind (`CATALOG_EXPANSION`/`CONTRACTION`/`PRICE_ACTIVITY`/`STEADY`) | Same | Same | OBSERVED | Exact existing strings, e.g. "+12 products (+6.4%) over the last 7 days" | Same |
| Product freshness (aggregate) | Count of highlighted products per `FreshnessLabel` | `growth/freshness.ts` via `growth/report.ts` | 3 real crawls per product | OBSERVED | "N newly discovered · N established · N recently missing" (a new, small aggregation over the existing per-product labels — no new query, same 20-product bound) | Products below 3 crawls individually show `INSUFFICIENT_HISTORY`, never silently omitted |
| Bestseller movement | `growth/bestseller.ts` `movement`/`momentum` per highlighted product | Same | 2 snapshots (movement) / 4 obs., 3 crawls (momentum) | OBSERVED (ordinal) | "N products improving rank · N declining" (aggregate) + per-product detail | No ranked products → card doesn't render (not a fake zero) |
| Advertising activity | `MarketingCollectionRun`/`AdObservation` presence | `marketing/report.ts` | 1 successful collection | OBSERVED / UNAVAILABLE | "Advertising activity detected" / "Not checked yet" / "No ads found in the sources we cover" | Three distinct states already implemented — never collapse "not checked" into "none found" |
| Technology changes | `APP_ADDED`/`REMOVED`, `PIXEL_ADDED`/`REMOVED`, `PAYMENT_PROVIDER_ADDED`/`REMOVED`, `THEME_CHANGED` events in window | `Event` | 2 real crawls | OBSERVED | "N technology changes this period" (new aggregate — no new query, a `count()` over existing event types) | 0 changes is a real, valid state — must read "No technology changes observed," never omit the row |
| Recent changes | Raw `ChangeFeedTimeline`, unfiltered | `Event` | 1 real crawl for existence | OBSERVED | Existing headline strings | "No changes detected yet" (already the existing empty state) |

**Explicitly not built**: any single blended score. Section 21 covers this in full.

### C. What products are changing?

| List | Source | Bound | Notes |
|---|---|---|---|
| Newly added products | `PRODUCT_ADDED` events, windowed | `Event`, existing `changeFeed` cursor pagination (20/page) | Already shippable via a filtered `ChangeFeedTimeline` (`eventTypes: ["PRODUCT_ADDED"]`), exact precedent already used for the marketing-filtered timeline |
| Removed products | `PRODUCT_REMOVED`, same | Same | Same pattern |
| Restored products | `PRODUCT_RESTORED`, same | Same | Same pattern — **currently has no dedicated summary count (Finding 2)**, but the raw filtered-feed capability already works today with zero new code, just a new filter value passed to the existing component |
| Recent price changes | `PRICE_DROP`/`INCREASE`/`SALE_STARTED`/`ENDED`, same | Same | Same pattern |
| Freshest products | `growth/report.ts` highlights, sorted by `freshness.label === "NEW"` then `firstSeenAt desc` | `MAX_PRODUCT_HIGHLIGHTS = 20` (existing hard cap, unconditional) | No new query — a client-side filter/sort over the already-fetched, already-bounded `productHighlights` array |
| Persistent products | Same, filtered to `label === "ESTABLISHED"` and `ratio` near 1.0 | Same 20-item bound | Same — no new query |
| Bestseller movers (climbers/droppers) | Same, filtered to `movement !== null` | Same 20-item bound | Same — no new query |
| Notable product activity | Editorial combination of the above (client-side only) | Same | The one place a "highlight reel" is reasonable — because it is a *display* re-sort of already-bounded, already-fetched, already-labeled data, not a new derived score |

**All product-level lists here are already bounded by existing constants** (`MAX_PRODUCT_HIGHLIGHTS`
for growth-derived lists, the events route's own `limit` param — default 20, capped, per
`change-feed.ts` — for event-derived lists). No new query shape is required for Section 4C; this is
purely a presentation/filtering specification over data the backend already returns.

---

## 5. Product Intelligence

### Product activity

Fully covered by Section 4C — additions/removals/restorations/price changes are all existing,
bounded, `Event`-sourced lists.

### Product persistence — precise definition, to prevent future conflation

**Persistence measures how many of the store's own last N real crawls found a specific product still
present.** It does **not** measure popularity (how many people viewed/bought it) and does **not**
measure sales (units moved). A product can have 100% persistence (never once absent) and be a total
commercial failure, or 40% persistence (genuinely intermittent stock) and be a bestseller between
restocks. This document, per the brief's explicit instruction, treats conflating any of these three
concepts as a defect to prevent, not a simplification to allow. Recommended V1 copy, adapted from
`growth/persistence.ts`'s own doc comment: *"How many times we checked and found this product still
in the catalog — not a measure of popularity or sales."*

### Product freshness

The existing four categories (`growth/freshness.ts`, already implemented and tested) are exactly
justifiable from current data and should be used as-is — **do not invent a different category set**
(e.g., the brief's example "New/Fresh/Established/Aging" four-tier scheme is not what's implemented;
using it would require new thresholds with no basis, contradicting the "only recommend categories
that can be justified from existing data" instruction):

- `NEW` — active, insufficient crawl history for *this product* specifically, but the store itself has
  enough history that the shortfall is genuinely "just discovered."
- `ESTABLISHED` — active, sufficient history to compute a real persistence ratio.
- `RECENTLY_MISSING` — currently `MISSING` or `REMOVED`. **Known limitation, unchanged from
  Milestone 5**: `growth/report.ts`'s highlight selection only ever queries `status: "ACTIVE"`
  products, so this label is implemented and tested but never actually surfaced by the current
  composition. A V1 report wanting to show "recently missing" products needs a second, separately-
  bounded query (Section 18) — not built here, explicitly flagged for Sub-phase B to decide.
- `INSUFFICIENT_HISTORY` — active, but the *store* itself hasn't been crawled enough times yet.

### Bestseller intelligence

| Element | Source | V1 treatment |
|---|---|---|
| Current rank | `Product.bestsellerRank` | Show as `#N+1` (the field is 0-indexed; existing UI already does `+1` display math) |
| Rank movement | `growth/bestseller.ts` `movement` | "↑/↓ #A → #B" — existing format |
| Trajectory | `growth/bestseller.ts` `trajectory[]` | **Data exists, not currently visualized** — recommend a small sparkline (same CSS-bar technique already used for the catalog-growth trend, `GrowthIntelligence.tsx`'s `CatalogSparkline`) as the one new, small, Fable-consistent visual element this specification recommends. Not a "NEW COMPONENT REQUIRED" in the heavyweight sense — it's a second instance of a pattern that already exists in this codebase, applied to a second dataset. |
| Momentum | `growth/bestseller.ts` `momentum` | Existing "improving/declining/stable" text |

**Mandatory language, already implemented and must not regress**: every rank-movement/momentum
surface must carry *"Bestseller rank movement is not independently verified sales data."* Confirmed
present today in `GrowthIntelligence.tsx`. Never "sales growth," never "sales increased" — grepped
the entire `growth/` and `components/analysis/` tree this sub-phase: zero occurrences of "sales" or
"revenue" attached to rank language, confirmed clean.

---

## 6. Growth Intelligence

Already comprehensively specified and shipped (Milestone 5 B/C). This section records what a V1
report composition needs from it, not new design:

- **Time windows available**: `activity.ts`'s window is caller-specified (default 7d, capped 90d).
  `catalog.ts`'s trend samples from the most recent `MAX_CRAWLS_FOR_TREND=180` real crawls, evenly
  down to `MAX_CATALOG_TREND_POINTS=12` plotted points. `persistence.ts`'s window is
  `PERSISTENCE_WINDOW_CRAWLS=20` real crawls, not a calendar window — this distinction (crawl-count
  window vs. calendar window) must remain visible in any V1 copy, since a HOT-tier store's 20-crawl
  window spans about a week and a COLD-tier store's spans about 20 months.
- **One crawl**: `hasEnoughHistory` (activity) and `MIN_CRAWLS_FOR_CATALOG_TREND=3` (catalog trend)
  and `MIN_CRAWLS_FOR_PERSISTENCE=3` (persistence) all correctly gate to an honest insufficient-history
  state — verified in Sub-phase C's live testing against three real external stores on their very
  first crawl.
- **Partial crawls**: counted as real observations (`status IN ('OK','PARTIAL')` throughout Growth),
  consistent with GUARD 2's own "silence proves nothing, but a partial crawl's successes are still
  real" philosophy — verified via a real end-to-end integration test in Sub-phase C.
- **Catalog-shrink guard (GUARD 1)**: an aborted diff writes zero `Product`/`ProductStateSnapshot`
  changes — verified in Sub-phase C to leave every growth signal byte-identical to before the bad
  crawl.
- **Maximum history queried**: every constant is named and bounded — `PERSISTENCE_WINDOW_CRAWLS=20`,
  `MAX_RANK_SNAPSHOTS=20`, `MAX_CRAWLS_FOR_TREND=180`, `MAX_PRODUCTS_FOR_CATALOG_HISTORY=20,000`
  (defensive ceiling), `MAX_PRODUCT_HIGHLIGHTS=20`. No query in this module scales with total catalog
  size or total historical crawl count — confirmed via real `EXPLAIN ANALYZE` in Sub-phase C at a
  5,475-crawl, 5,000-product pathological scale (sub-3ms).
- **UI recommendation**: total catalog size, products added/removed, net change, and the growth-trend
  sparkline are all already shipped in `GrowthIntelligence.tsx`. A V1 report should not build a second
  version of this — it should place the existing component correctly in the new hierarchy (Section
  15).

**Do not create a misleading growth percentage** — already enforced: `computeGrowthSignals()` returns
`[]` (not a fabricated 0%) when `hasEnoughHistory` is false, and the catalog-trend chart requires 3
real crawl dates before rendering at all. No change needed; this is a verification, not a new
requirement.

---

## 7. Bestseller Intelligence

Fully documented in Section 5. Recommended V1 UI labels, validated against the actual implementation
(not invented against the brief's example list):

| Brief's suggested label | Maps to real data? | V1 recommendation |
|---|---|---|
| "Trending up" | Maps to `momentum: "IMPROVING"` | Use "Bestseller rank improving" — matches existing copy, avoids "trending" which implies a broader claim than one product's ordinal rank |
| "Trending down" | Maps to `momentum: "DECLINING"` | "Bestseller rank declining" |
| "Stable" | Maps to `momentum: "STABLE"` | Use as-is |
| "Newly ranked" | Maps to `movement === null && currentRank !== null` with no prior snapshot | Legitimate, currently inferable from the payload but not a named UI state today — cheap to add: "Newly ranked at #N" |
| "Rank movement detected" | Maps to `movement !== null` | Use as-is for the aggregate signal-badge (Section 4B); use the specific "#A → #B" for the per-product row |

**Thresholds are already defined, not invented here**: `minRankImprovement=3` (event-level, `diff/
engine.ts`), `MIN_OBSERVATIONS_FOR_MOMENTUM=4`/`MIN_CRAWLS_FOR_MOMENTUM=3` (derived-signal-level,
`growth/bestseller.ts`). No new threshold is proposed by this document.

---

## 8. Marketing Intelligence

Fully documented in Section 3/4/Section 2's capability table. The V1 report should surface exactly
what's already `OBSERVED`, and this document explicitly re-states, per the brief's own instruction,
that **product-level ad matching must not be designed as a working V1 capability** — it is
permanently `UNAVAILABLE` under the current vendor, not a "coming soon."

The marketing event system (`AD_DETECTED`/`AD_REMOVED`/`AD_CHANGED`/`PRODUCT_AD_MATCHED`) already
supports a useful timeline **today** — `MARKETING_EVENT_TYPES` (`marketing/event-types.ts`) already
filters `ChangeFeedTimeline` to exactly these four types, already wired into both `FullReportView.tsx`
and the Store Intelligence page. No new work is required for a marketing-specific timeline; it exists.
One precise note: `PRODUCT_AD_MATCHED` is a real, defined `EventType`, but because deterministic
matching is permanently non-functional under the current vendor, this event type is very likely never
actually written by any code path today — confirmed architecturally (matching requires a destination
URL SerpApi doesn't supply), not confirmed by a database query (out of scope for a no-execution
research phase). A future Sub-phase B does not need special-case handling for this — if it never
fires, the existing generic marketing-timeline filter handles its absence correctly by simply never
showing it.

---

## 9. Technology Intelligence

| Section | Fields | OBSERVED vs. INFERRED |
|---|---|---|
| Theme | Name, version | OBSERVED (name reliable, version often absent) |
| Apps | Detected app list, first/last seen, added/removed history | OBSERVED (presence only — see Section 21 for why "app X installed" must never imply a business conclusion) |
| Marketing/analytics | Pixels (7 signatures, including captured pixel/account ID) | OBSERVED — **currently uncollected in any report, Finding 1** |
| Payments | Payment providers (5 signatures) | OBSERVED — **currently uncollected in any report, Finding 1** |
| Reviews | Review infrastructure presence (5 apps) | OBSERVED, already shipped with the mandatory non-sales-proxy disclaimer |

**Explicitly forbidden inference, per the brief's own example, re-stated as a concrete rule for this
codebase**: technology presence must never be composed into a revenue/scale claim (e.g., "has
Recharge installed, therefore has significant subscription revenue"). Every existing technology
signal in this codebase already stops at presence + first/last-seen; this document recommends V1
preserve that boundary exactly, including for the two newly-recommended pixel/payment-provider
sections.

---

## 10. Review Infrastructure

Re-stating Milestone 6's conclusion, not re-deriving it: **review-app presence is already shipped and
belongs in V1** (it already is, via `growth/review-infrastructure.ts`). **Review-count observation is
`RESEARCH REQUIRED`, not V1** — Milestone 6 found the technical format exists (`AggregateRating`
JSON-LD, verified live) but real-world adoption prevalence across this product's actual corpus is
unmeasured, and the crawl surface it would require (individual product pages) does not exist today.
**This document does not promote review-count observation into V1** — the existing data and Milestone
6 research do not support doing so yet, exactly per this brief's own instruction. Review velocity as a
sales/revenue proxy remains permanently out of scope, not revisited.

---

## 11. Evidence / Epistemic Status

The mandatory per-signal template, applied to every V1 signal in Section 4B (the template itself, not
repeated per-row since Section 4B's table already instantiates it):

1. **What does it claim?** — stated in plain language, never implying more than the source supports.
2. **What evidence supports it?** — the exact table/query, cited.
3. **Which epistemic status applies?** — `OBSERVED` for every V1 signal in this document; nothing
   proposed here is `ESTIMATED` or `INFERRED` (both remain unused in production code, confirmed by
   grep, and this document does not introduce a first user).
4. **Minimum required data** — the exact crawl/snapshot/event count, cited from the real constant.
5. **Fallback state** — always a named, honest state (`INSUFFICIENT_HISTORY`, `UNAVAILABLE`, "not
   checked yet"), never a bare zero standing in for "unknown" (Section 17 elaborates).
6. **Exact user-facing language** — cited from existing shipped copy where it exists, proposed new
   copy explicitly marked as new where it doesn't (Sections 4, 5, 9).

The `ESTIMATED`/`INFERRED` states remain fully defined in `report-contract.ts` and fully rendered by
`IntelligenceCard` (confidence badge + methodology string) — **ready for a future metric, not
activated by anything in this document.**

---

## 12. Competitor Timeline

Every event type mapped to a user-facing category, title pattern, and default-visibility
recommendation. Titles below are the **existing** `headline` strings already generated by
`significance.ts`/`diff/engine.ts` (confirmed by direct read) — this section documents them, it does
not invent new copy, per the "raw internal event names must never reach the user" rule (already
satisfied architecturally, per Section 3, since the UI renders `headline`, never `eventType`).

| Category | Event types | Shown by default? | Filterable? |
|---|---|---|---|
| Product | `PRODUCT_ADDED`, `PRODUCT_REMOVED`, `PRODUCT_RESTORED`, `PRICE_DROP`, `PRICE_INCREASE`, `SALE_STARTED`, `SALE_ENDED`, `PRODUCT_SOLD_OUT`, `PRODUCT_RESTOCKED`, `VARIANT_SOLD_OUT` | Yes | Yes — precedent already exists (`eventTypes` param on `GET /api/store/[domain]/events`, already used for the marketing-only filtered view) |
| Bestseller | `BESTSELLER_ENTERED`, `BESTSELLER_CLIMBED`, `BESTSELLER_DROPPED` | Yes | Yes |
| Technology | `APP_ADDED`, `APP_REMOVED`, `PIXEL_ADDED`, `PIXEL_REMOVED`, `PAYMENT_PROVIDER_ADDED`, `PAYMENT_PROVIDER_REMOVED`, `THEME_CHANGED`, `COLLECTION_ADDED`, `COLLECTION_REMOVED` | Yes | Yes |
| Marketing | `AD_DETECTED`, `AD_REMOVED`, `AD_CHANGED`, `PRODUCT_AD_MATCHED` | Yes (already the case — `MARKETING_EVENT_TYPES`) | Yes (already implemented) |
| System | `STORE_BASELINED` | **No** — this is a system bookkeeping event (`backfilled: true` semantics apply to a store's first crawl), not user-facing intelligence; recommend excluding it from any "recent changes" default view, consistent with how `backfilled` events already power charts but never alerts |

For every event, per the brief's exact fields: **title** = `headline` (already generated, never raw
`eventType`); **description** = not separately stored — `headline` already carries the full
human-readable content (e.g., "Widget climbed #22 → #14"), so no additional description field is
needed or recommended; **timestamp** = `occurredAt`; **severity** = `significance` (0–100, already
computed, already available — not currently rendered as a number to users, and this document does not
recommend exposing the raw integer, only using it for sort/highlight-worthiness decisions, consistent
with "don't expose raw internals"); **evidence** = the event's own `oldValue`/`newValue` JSON, not
currently rendered, available for a future "why did this happen" detail view if ever built (not
specified here — out of scope, no evidence this is needed for V1); **default visibility** = per table
above; **filterable** = per table above, using the exact mechanism (`eventTypes` query param) already
proven twice.

---

## 13. Monitoring Experience

Entitlements unchanged, confirmed by reading `plan-limits.ts`/`entitlement-service.ts` fresh this
sub-phase: FREE (3 analyses, 1 monitor, 30-day monitoring), BASIC (unlimited analyses, 20 monitors,
continuous). This section specifies presentation only, using components that already exist and
already implement exactly the states the brief asks for:

- **`MonitorButton.tsx`** (already shipped): `ACTIVE` → "● Monitoring active — N days remaining" (or
  no day count for BASIC's continuous/null-expiry case) + "Stop monitoring"; `NONE` at plan limit →
  "Monitoring limit reached" + explanatory sub-text; `NONE` under limit → "Monitor this store" button;
  `EXPIRED` → "Resume monitoring" + "Your 30-day free monitoring period has ended." **All of this
  already exists, verified by direct read this sub-phase — no new component needed.**
- **`MonitoringStatusCard.tsx`** (already shipped): Active/Paused dot + cadence label (from
  `Store.tier`) + last-checked/next-check relative times.
  Dashboard (`dashboard/page.tsx`, already shipped): stat cards (analyses used/remaining, monitoring
  slots used/limit) + a monitored-stores list showing days-remaining or "∞" for continuous.
- **Watchlist page** (`dashboard/watchlist/page.tsx`, already shipped): active watches with real
  status text (matches the brief's exact examples: "X days remaining" / continuous), a `history`
  section for expired/removed watches, and a `SubscriptionCTA` component shown specifically when a
  FREE user's monitoring has lapsed (not shown to a user who simply never started monitoring — a real,
  already-implemented behavioral nuance worth preserving, not flattening into one generic empty
  state).

**Nothing here requires new UI work.** This section's contribution is confirming, via direct
inspection, that the brief's own example states are already fully built — Sub-phase B's job regarding
monitoring is to make sure any new Store Intelligence Report composition **keeps using these existing
components unmodified**, not to build them again.

---

## 14. Anonymous → Signup → Full Report Flow

Confirmed against `src/app/page.tsx`, `AnonymousReportView.tsx`, `run-analysis.ts`, and
`report/route.ts`, this sub-phase:

1. Landing page (`page.tsx`, `state.view === "idle"`) — `SiteNav`, hero, `StoreUrlInput`.
2. `StoreUrlInput` submits → `useAnalysisStream` opens the `POST /api/analyze` SSE connection.
3. `state.view === "analyzing"` — `DetectionLog` renders real `progress` events as they arrive
   (confirmed: no synthetic timer, no fabricated step — the component's own doc comment states this
   and the code matches it).
4. On completion, `runAnalysis()` returns exactly one of two shapes for the *live* SSE path
   (`anonymous_preview` or `full` — `unanalyzed_preview` is exclusive to the separate `GET .../report`
   re-fetch route, confirmed by a code comment in `page.tsx` itself, a detail the brief's flow diagram
   doesn't distinguish but a real implementer must).
5. Anonymous: `AnonymousReportView` — real platform/product-count/theme (`FreeReportStrip`, genuinely
   truncated, not a `{locked: true}` tease — confirmed, no such pattern exists anywhere in this
   codebase, grepped) + a CTA block linking to `/signup?store={domain}` and `/login?store={domain}`.
6. Signup preserves the store context via the `?store=` query param — confirmed present in the actual
   href construction.
7. **The exact "no unnecessary second crawl" mechanism**: `dashboard/stores/[domain]/page.tsx` accepts
   a `?claim=1` param (arriving specifically from the post-signup/login redirect) and calls
   `recordAnalysisUsage()` directly — spending one of the user's 3 credits on the **already-crawled**
   store with **zero new crawl**, confirmed by direct read (`recordAnalysisUsage` never calls
   `runAnalysis`/`crawlShopifyStore`, it only writes an `AnalysisUsage` row). This is exactly the
   requirement in the brief's steps 10–11, already correctly implemented.
8. User lands on the Store Intelligence page (`dashboard/stores/[domain]/page.tsx`), sees the full
   report, can start monitoring via `MonitorButton`.

**No redesign is proposed.** The one gap this document identifies in this flow is not visual: the
`unanalyzed_preview` state (a signed-in user visiting a store's URL directly without having spent a
credit on it) currently renders through the *same* `AnonymousReportView`-shaped truncation logic at
the API level but — confirmed by reading `dashboard/stores/[domain]/page.tsx` — the **page** itself
handles this differently (a dedicated "This store is in Bellwether's corpus, but you haven't analyzed
it yet" panel, not `AnonymousReportView`). This is already correct and already distinguishes the two
truncation reasons with different copy, exactly as Section 2 of this document's capability map
implies it should. No change recommended.

---

## 15. Fable Design Constraints

Hard requirement, honored throughout this document. Every recommendation in Sections 4–12 either (a)
reuses an existing component exactly as it renders today, or (b) is explicitly marked below.

**Reused, unmodified**: `IntelligenceCard`, `SectionLabel`, `ChangeFeedTimeline` (including its
existing `eventTypes` filter mechanism), `StoreActivitySummary`, `GrowthIntelligence`,
`AdvertisingSummary`, `MonitorButton`, `MonitoringStatusCard`, `FreeReportStrip`, `AnonymousReportView`,
`ErrorPanel`, `DetectionLog`, the existing chip-list pattern (`FullReportView`'s "Apps / technologies"
rendering), the existing CSS-bar sparkline pattern (`GrowthIntelligence.tsx`'s `CatalogSparkline`).

**"NEW COMPONENT REQUIRED"** (both are small extensions of an existing pattern, not new visual
language):
1. **A second chip-list row for Pixels and Payment Providers** — visually identical to the existing
   "Apps / technologies" chip list (same border/padding/typography), just fed by two more
   `IntelligenceField<string[]>` values. Not a new design, a second instance of one.
2. **A bestseller-trajectory sparkline** on the product-highlight detail — visually identical
   construction to the existing catalog-growth sparkline (same CSS-bar technique, same card
   container), applied to `trajectory[].rank` instead of catalog size. Not a new design, a second
   instance of one.

**Nothing else in this document requires a new component.** No layout change, no navigation change,
no typography/color/spacing change, no card-shape change is proposed anywhere in this document.

---

## 16. Report Information Hierarchy

| Tier | Content | Rationale |
|---|---|---|
| **Tier 1 — immediately visible** | Store overview (platform/theme/products/price), Section 4B's signal badges (catalog activity, growth, freshness, bestseller movement, advertising activity, tech changes) | Answers "what is this store doing" in one screen, matches the brief's own framing exactly |
| **Tier 2 — important intelligence** | Product Intelligence lists (Section 4C/5), Growth Intelligence detail (trend chart, per-product persistence/freshness), Marketing Intelligence detail (ad list, activity trend) | Supports actual competitive-research decisions, one click/scroll deeper than Tier 1 |
| **Tier 3 — supporting evidence** | Full app/pixel/payment-provider lists, full Competitor Timeline (all event types, paginated), raw per-product bestseller trajectory | Detailed evidence a researcher consults when they want to verify or dig into a Tier 1/2 claim |
| **Tier 4 — unavailable / future** | Product-level ad matching, ad spend/impressions/conversions, traffic, revenue, review velocity, review-count observation | Always shown as an honest `UNAVAILABLE` card where a user might reasonably look for it (e.g., next to Ads Observed), never hidden entirely — consistent with the existing "Not available yet" pattern, never omitted as if the question never occurred to the product |

**Recommended top-to-bottom order for the Store Intelligence page**, synthesizing the above with the
brief's own A/B/C ordering and the existing page's current section order (confirmed via direct read
of `dashboard/stores/[domain]/page.tsx`) — changes from today are marked:

1. Store header + `MonitoringStatusCard` + `MonitorButton` (unchanged)
2. Store overview (Tier 1) — **add** Pixels/Payment Providers chip rows (Finding 1)
3. Growth signals badges (Tier 1, Section 4B) — **new aggregate badges**, composed from existing data
4. Business intelligence (revenue/traffic/review-velocity — unchanged, still honestly `UNAVAILABLE`)
5. Product activity + Growth Intelligence detail (Tier 2, existing `StoreActivitySummary` +
   `GrowthIntelligence`, unchanged placement)
6. Recent changes — full timeline (Tier 3, existing `ChangeFeedTimeline`, unchanged)
7. Advertising intelligence (Tier 2 summary + Tier 3 filtered timeline, existing, unchanged placement)

This is **not a reordering of the existing page** — items 1, 4, 5, 6, 7 already exist in exactly this
relative order today. Items 2's chip additions and item 3's new badge row are the only insertions.

---

## 17. Data Quality States

Every state below is either already implemented (cited) or specified for the first time (marked
**NEW**) — none is a redesign of an existing state.

| State | Existing? | Where | Copy |
|---|---|---|---|
| No analysis | Yes | `dashboard/stores/[domain]/page.tsx`'s "haven't analyzed it yet" panel | Existing |
| Analysis in progress | Yes | `DetectionLog` | Existing, real progress events only |
| Analysis failed | Yes | `ErrorPanel`, 6 distinct status-specific messages | Existing |
| Single crawl | Yes | `hasEnoughHistory: false` throughout Growth/Activity | Existing |
| Insufficient history | Yes | `INSUFFICIENT_HISTORY` (persistence/catalog-trend), `hasEnoughHistory` (activity/marketing) | Existing |
| Rich history | Implicit (the "else" branch of every gate above) | N/A | No dedicated state needed — it's simply what renders when the gates pass |
| Marketing not checked | Yes | `ads: UNAVAILABLE` with `lastCheckedAt: null` | Existing, confirmed distinct from "checked, found nothing" (`ads: OBSERVED []`) |
| Marketing checked | Yes | `ads: OBSERVED` (including the empty-array "checked, found nothing" case) | Existing |
| Marketing unavailable (vendor failure) | Yes | `ads: UNAVAILABLE` with the real vendor-failure reason string | Existing |
| Monitoring active | Yes | `MonitorButton`/`MonitoringStatusCard` | Existing |
| Monitoring expired | Yes | `MonitorButton`'s `EXPIRED` state, watchlist's "History" section | Existing |
| **Pixels/payment providers not yet surfaced anywhere** | **NEW (this doc)** | Would follow the exact `apps` pattern — `OBSERVED` empty array vs. not-yet-crawled | Recommend the identical "None detected" vs. field-absent distinction `apps` already makes |
| **Aggregate freshness/tech-change badges (Section 4B)** | **NEW (this doc)** | Would follow `hasEnoughHistory`/count-based gating identical to existing patterns | No new state *shape* — reuses the same insufficient-history vs. real-zero distinction already proven everywhere else in this codebase |

**The "never imply missing data means zero" rule is already the codebase's own standing discipline** —
every example the brief gives (`Ads: 0` when unchecked) already has a real counter-example already
shipped (`ads: UNAVAILABLE` vs. `ads: OBSERVED []`, `productMatching` always stated explicitly rather
than left as an implicitly-null per-ad field). This document's job was to confirm this discipline
holds, and extend it identically to the two new fields it recommends (pixels/payment providers) rather
than inventing a new discipline.

---

## 18. Query / Performance Constraints

Every bound currently in force, confirmed by reading the actual current constants (not copied from a
prior report) — a table for the brief's exact requested fields:

| Query | Current bound | Expected scale | Max records | Index | Cache? | Sync or async? |
|---|---|---|---|---|---|---|
| `getProductPersistence` (per product) | `PERSISTENCE_WINDOW_CRAWLS=20` crawls, `MAX_TRANSITION_EVENTS=50` events | Per-store crawl history up to thousands | 20 crawls / 50 events, hard | `[storeId, startedAt]` (crawl), `[storeId, entityType, entityKey, occurredAt]` (event) | Not cached; cheap enough not to need it (confirmed sub-3ms even at 5,475 crawls) | Client-fetched async (`/growth` route), never in the synchronous analyze path |
| `getCatalogGrowthTrend` | `MAX_CRAWLS_FOR_TREND=180`, `MAX_PRODUCTS_FOR_CATALOG_HISTORY=20,000` (defensive) | Full catalog per store | 180 crawls, 20K products (ceiling, not expected to bind) | `[storeId, startedAt]` (crawl), `[storeId, status]`/unique `(storeId, externalId)` (product) | Not cached | Async |
| `getBestsellerSignal` (per product) | `MAX_RANK_SNAPSHOTS=20` | Per-product snapshot history | 20, hard | `[productId, capturedAt]` | Not cached | Async |
| `buildGrowthReport` (whole-store) | `MAX_PRODUCT_HIGHLIGHTS=20` products, each a fixed small query count | Any catalog size | 20 products × ~4 queries ≈ 84 total, hard ceiling, **measured** at 305ms for a 5,000-product/400-crawl store (Sub-phase C) | See above | Not cached | Async, client-fetched, rate-limited 30/min |
| `buildMarketingReport` | `ads.findMany` unbounded by count but naturally small (ad accounts rarely exceed dozens of active ads); `activity.ts` uses count-only queries | Per store | Not explicitly capped — **flagged below as worth a bound if a store were ever observed with hundreds of concurrent ads** | `[storeId, status]` | Not cached | Async |
| `getChangeFeed` | `limit` param, default/max not independently re-verified this pass beyond confirming cursor pagination exists | Per store, unbounded total `Event` rows | Bounded per page | `[storeId, occurredAt]` | Not cached | Async |
| `buildFullStoreReport` (existing, synchronous BASIC-unlimited path) | 6 parallel simple `count`/`find`/`aggregate` queries, **does not call any Growth/Marketing module** | Any catalog size | Small, fixed | Existing indexes | Not cached | **Synchronous** — confirmed unchanged, confirmed still not reachable from any bounded-but-nonzero-cost Growth/Marketing query |

**One real, not-yet-a-problem risk flagged for Sub-phase B's design**: `buildMarketingReport`'s
`ads.findMany` has no explicit `take` limit. This is not a proven bug (ad accounts for a single store
are not expected to reach a scale where this matters, and no evidence from three milestones of live
testing suggests otherwise) but it is the one query in this inventory without a named constant
bounding it, and per this brief's own "identify any proposed query that could become expensive"
instruction, it is recorded here rather than silently passed over. **Not fixed in this research
phase**, per the explicit "document, don't fix" rule (Section 28 formally classifies its severity).

**Confirmed unchanged**: nothing in this document proposes adding Growth/Marketing/Product-Intelligence
queries to `run-analysis.ts`'s synchronous `buildFullStoreReport()` path. Every recommendation in this
document is either (a) already async/client-fetched today, or (b) a new async, client-fetched
composition endpoint (Section 26).

---

## 19. Historical Data / Corpus Strategy

Confirmed this sub-phase: **no retention/deletion/archival logic exists anywhere in this codebase**
for `Crawl`, `Event`, `ProductStateSnapshot`, or `AdObservation`/`MarketingCollectionRun` — all four
are pure-accumulation, append-only tables with no TTL, no cleanup job, no archival path. This is a
genuine, unaddressed long-term risk (unbounded storage growth) and a genuine long-term asset (nothing
has ever been silently lost) at the same time.

**This document does not recommend implementing retention now.** It records the shape of the future
decision for Sub-phase B or later to make deliberately rather than by accident:

- `Crawl`: candidate for the **longest-lived** raw table — it's the temporal backbone every other
  table's `crawlId`/timing correctness depends on (Sub-phase C's entire `finishedAt` bug-fix leaned on
  `Crawl` rows staying intact and correctly timestamped). Recommend never deleting `Crawl` rows
  without first confirming no downstream query (Growth, Activity, future features) implicitly assumes
  a contiguous crawl history.
- `Event`: the actual product-facing asset (the Competitor Timeline *is* this table). Deleting old
  events directly deletes user-visible product value, not just storage. If retention is ever needed,
  compaction (e.g., collapsing old low-significance events into a periodic summary) is a more
  defensible shape than deletion — not designed here, flagged as the right *kind* of future work.
- `ProductStateSnapshot`: already storage-optimized by design (on-change only, not per-crawl — this
  was the whole point of the original schema decision, re-confirmed by this sub-phase's reading of
  the model's own doc comment). Lowest-priority retention candidate; it's already sparse.
- `AdObservation`/`MarketingCollectionRun`: smallest table by row count of the four (bounded by ad
  account sizes, not catalog sizes); lowest urgency.

**No retention is implemented. This section exists so a future session doesn't accidentally treat
"the database is growing" as license to delete data whose product value (Section 20) hasn't been
weighed.**

---

## 20. Long-Term Data Moat

Per the explicit "every dataset must have a product purpose" instruction — not "more data is better."
Evaluated against what this codebase already accumulates:

| Historical dataset | Already accumulating? | Strategic value | Why |
|---|---|---|---|
| Price history (`ProductStateSnapshot`) | Yes | **High** | Directly powers persistence/freshness/growth today; a competitor tool re-crawling from scratch tomorrow cannot reconstruct a store's *past* pricing behavior, only its current state — this is a genuine, compounding, hard-to-reproduce asset |
| Bestseller rank history (`ProductStateSnapshot.bestsellerRank`) | Yes | **High** | Same reasoning — trajectory/momentum are only possible because this has been silently accumulating since Milestone 1–2, long before Growth Intelligence existed to use it |
| Catalog/technology change history (`Event`) | Yes | **High** | The Competitor Timeline's entire value proposition; a fresh competitor's first crawl of the same store today would see none of this |
| Advertising history (`AdObservation`) | Yes | **Medium** | Real value, but younger (Milestone 4) and vendor-dependent (SerpApi could change/discontinue) — the *history already captured* remains valuable even if the *ongoing collection* ever had to stop |
| Store-level growth/change frequency | Yes (derived from the above, not separately stored) | **Medium** | Already covered by the price/catalog history rows above; not a separate moat |

**Not recommended for new collection**, because no product purpose was identified this sub-phase:
review counts (Milestone 6: `RESEARCH REQUIRED`, not yet justified), traffic/revenue proxies
(permanently out of scope), social signals (Milestone 6: not legitimately accessible).

**The actual moat is time, not schema.** Every dataset in the "High" row above already exists in the
current schema — the competitive advantage compounds by *continuing to run the existing crawler on
the existing schedule against the existing corpus*, not by adding new tables. This is the single most
important finding of this section: **Milestone 7 does not need new data collection to build a data
moat — it needs to keep doing what it already does, for longer, and to let the product surface that
accumulated depth (the Competitor Timeline, bestseller trajectory) rather than only ever showing
current-state snapshots.**

---

## 21. Revenue / Traffic / Review Velocity Decisions

Explicitly preserved, not re-litigated, per the brief's own instruction — restated here precisely so
a future session reads this section instead of reopening the question:

- **Revenue estimation: DO NOT BUILD.** No validated ground truth exists; no calibration dataset has
  been collected (Milestone 5 Sub-phase A, re-confirmed Milestone 6 Sub-phase A). Revisit only if a
  real, multi-month, relationship-driven calibration effort (specified in both prior documents)
  actually happens — not by re-deriving the decision from first principles again.
- **Traffic estimation: DO NOT BUILD.** No traffic vendor is both affordable at this product's
  economics and independently confirmed accurate for its actual (mostly small/niche) store corpus
  (same two documents).
- **Review velocity as a sales/revenue proxy: DO NOT BUILD, permanently.** Import-review-dropshipping
  practice makes this actively misleading, not merely imprecise, for a well-documented, common
  category of store (Milestone 5 Sub-phase A). Not a "not yet" — a closed question.
- **Review-count observation: RESEARCH REQUIRED**, and explicitly **not part of V1** (Section 10).

---

## 22. Opportunity Score Decision

**REJECT.** No `Opportunity Score`, `Store Score`, `Growth Score`, `Winning Product Score`, or
`Competitor Score` is specified anywhere in this document, and none is recommended for Sub-phase B.
This is not merely compliance with the explicit instruction — it follows directly from this
codebase's own history: `significance.ts`'s `rarityFactor()` term has silently been a permanent no-op
since the day it was written, because its input table (`StoreStats`) has never been populated by any
code path (Section 3, re-confirmed this sub-phase) — a live, in-repository example of exactly the
failure mode a fabricated score produces. Every signal specified in Section 4B is instead a
transparent, independently-labeled, independently-sourced badge — the user is meant to understand
*why* each one is showing, not trust a black-box number.

---

## 23. AI Future Opportunities

Per the explicit "do not add AI merely because it's available" instruction: **no AI feature is
specified or recommended for implementation in this document or Sub-phase B.** Recorded here strictly
as a possible *future* product layer, explicitly deferred:

- Summarizing an already-observed event set in natural language (e.g., "This week: 3 products added,
  1 price drop, advertising activity resumed") — the underlying facts (Section 12's timeline) would
  remain fully deterministic; an AI layer here would only be a presentation transform of real,
  already-correct data, never a new source of claims.
- Generating a natural-language store summary from Section 4's existing fields — same constraint: the
  facts must already exist and already be `OBSERVED`, the AI layer only narrates them.
- Explaining *why* a change likely happened — explicitly **not recommended even as a future idea**
  without new evidence, since "why" almost always requires information this crawler cannot observe
  (an AI narrating a plausible-sounding but unverifiable cause would reintroduce exactly the
  fabrication risk this whole product line has spent five milestones avoiding).
- Grouping related events into a single narrative moment — a legitimate future presentation
  simplification over `Event` data that already exists.
- Natural-language query over existing evidence ("has this store run ads in Canada?") — a legitimate
  future interface layer over data that is already fully queryable; the underlying facts remain
  exactly as observed, only the query interface would be new.

**For this sub-phase and Sub-phase B: no AI implementation, in any form.**

---

## 24. Competitor Research User Journey

The brief's example journey is already substantially built, per Sections 13–14's direct-read
confirmation: landing → analyze → anonymous preview → signup → full report → (understand/inspect
product/growth/advertising/technology, all real sections that exist today) → historical changes
(existing `ChangeFeedTimeline`) → monitor → return later → see what changed (existing watchlist +
monitored-store-list on the dashboard, existing `MonitoringStatusCard`'s "last checked"/"next check").

**Encouraging return visits**: the dashboard's monitored-store list (`dashboard/page.tsx`) already
links directly back to each monitored store's Store Intelligence page — the "return and see what
changed" loop is already closed architecturally; Sub-phase B's job is to make sure the page a
returning user lands on (Section 15/16's hierarchy) leads with what's *changed* since their last
visit, not just current state. **Nothing here requires new navigation or new pages** — it requires
composing the existing `ChangeFeedTimeline` prominently in the existing hierarchy, which Section 16
already specifies (Tier 1 badges reference recent activity; Tier 3 holds the full timeline).

---

## 25. Competitor Comparison

**DEFER**, not build in Sub-phase B.

- **User value**: plausible (the brief's own suggested fields — products, average price, catalog
  growth, bestseller movement, advertising activity, technology, product activity — are all things a
  competitor researcher genuinely compares mentally today across separately-opened tabs), but
  unvalidated — no user research (real or fabricated) supports prioritizing it over the Section 26
  roadmap's other items.
- **Implementation complexity**: non-trivial. Every Growth/Marketing module in this codebase is
  single-store-scoped by construction (`getProductPersistence(prisma, storeId, product)`,
  `buildGrowthReport(prisma, storeId, domain)`, etc.) — a comparison view would need to call the same
  bounded functions twice (cheap, since they're already bounded per Section 18) and then build new
  side-by-side presentation logic (real, non-trivial UI work, and per Section 15's constraint, would
  need real design thought to stay Fable-consistent rather than becoming the first genuinely new
  layout in this product).
- **Query cost**: low incremental risk specifically *because* every underlying query is already
  bounded (Section 18) — two bounded reports cost roughly 2× one bounded report, not a multiplicative
  blowup.
- **Data quality**: two stores being compared could easily be at very different history depths (one
  `hasEnoughHistory`, one not) — a comparison UI would need to handle asymmetric data-quality states
  gracefully, a real design problem Section 17's existing per-field states don't automatically solve
  when placed side by side.
- **Recommendation**: defer until the single-store report (Sub-phase B/C) has shipped and been used —
  a comparison view's exact value only becomes clear once the single-store report's own information
  hierarchy (Section 16) has been validated in the product. Building comparison first risks comparing
  two copies of a hierarchy that itself hasn't been proven right yet.

---

## 26. Recommended Implementation Roadmap

Sequenced by actual dependency, based on this sub-phase's code inspection — not a repeat of any prior
milestone's roadmap.

### Sub-phase B — Unified Store Intelligence Report backend composition

- **Objective**: one new, bounded, async composition function/endpoint that assembles Section 4's
  full V1 report shape (existing `FullStoreReport` fields + existing Growth report + existing
  Marketing report + the two new Pixel/Payment-Provider fields + the new Section 4B aggregate badges)
  so the frontend stops making 3–4 separate client fetches per page load.
- **Modules affected**: new `src/lib/report/` (or similar) composition module; `analysis/types.ts`
  extended (additively) with the two new `IntelligenceField<string[]>` fields; no changes to
  `growth/`, `marketing/`, or `diff/` internals — this phase composes, it does not recompute.
- **Database impact**: none — every field already exists.
- **API impact**: additive only — either extend `GET /api/store/[domain]/report`'s payload or add one
  new composition route; either way, existing consumers of the current shape must not break (an
  additive-fields contract, matching every prior milestone's own precedent).
- **UI impact**: none required for this sub-phase specifically (backend-only) — though the two new
  chip rows (Finding 1) could ship here if the schema-level query work is bundled with the field
  addition.
- **Tests required**: unit tests for the new composition function's aggregation logic (Section 4B's
  badges), integration tests against real Postgres proving the composed report matches what the
  separate existing endpoints already return (a regression guard against drift).
- **Live verification required**: real HTTP smoke test confirming the new endpoint's shape and timing
  at realistic scale (reuse Sub-phase C's own 5,000-product benchmark methodology).
- **Major risks**: query-count creep if the new composition function isn't careful to call the
  *existing* bounded functions rather than re-querying independently — the entire point of this
  sub-phase is reuse, not reimplementation.
- **Fable UI changes required**: no.

### Sub-phase C — Report UI integration

- **Objective**: wire the new composed endpoint into `FullReportView.tsx`/`dashboard/stores/
  [domain]/page.tsx`, add the two new chip rows (if not done in B) and the new Section 4B badge row,
  per Section 16's hierarchy.
- **Modules affected**: the two existing report pages, one new small badge-row component (reusing
  `IntelligenceCard`/pill-badge patterns already proven), the two chip-list additions.
- **Database/API impact**: none beyond B.
- **UI impact**: additive sections only, per Section 15's explicit constraints.
- **Tests required**: component-level tests for the new badge row's insufficient-history/real-data
  states; existing page tests (if any) must remain green unmodified.
- **Live verification required**: browser screenshot verification (the established pattern from every
  prior UI sub-phase) confirming visual consistency with the existing Fable language.
- **Major risks**: visual drift if the new badge row doesn't precisely match existing card/spacing
  conventions — mitigate by literally reusing `IntelligenceCard`/existing pill styles, not
  approximating them.
- **Fable UI changes required**: no — additive only, per Section 15.

### Sub-phase D — Competitor Timeline productization

- **Objective**: apply Section 12's categorization to the existing `ChangeFeedTimeline`/events route
  — category-based filtering UI (reusing the exact `eventTypes` mechanism already proven for
  marketing), excluding `STORE_BASELINED` from default view.
- **Modules affected**: `ChangeFeedTimeline.tsx` (additive filter-control UI only), no backend changes
  (the `eventTypes` param already exists).
- **Database/API impact**: none.
- **Tests required**: UI-level filter-interaction tests.
- **Live verification required**: browser verification of filtering behavior against real seeded
  event data.
- **Major risks**: low — this is the lowest-risk sub-phase in the roadmap, since it adds a control
  surface over an already-correct, already-bounded existing query.
- **Fable UI changes required**: no.

### Sub-phase E — Bestseller trajectory visualization + Finding 2 fix

- **Objective**: the one new small component (Section 15, item 2 — trajectory sparkline), plus adding
  `PRODUCT_RESTORED` to `ActivitySummary`'s counted fields (Finding 2 — a real, small, additive fix,
  not a redesign).
- **Modules affected**: `monitoring/activity.ts` (add one more `Event.count()` call + one new field on
  `ActivitySummary`), `StoreActivitySummary.tsx` (one more `Stat`), new sparkline component (copy of
  the existing `CatalogSparkline` pattern applied to rank data).
- **Database/API impact**: none — additive field on an existing response shape.
- **Tests required**: unit test for the new count; existing `activity.integration.test.ts` tests must
  remain green.
- **Live verification required**: standard real-Postgres integration pass, real HTTP smoke test.
- **Major risks**: low.
- **Fable UI changes required**: no — the sparkline reuses an existing visual pattern (Section 15).

### Sub-phase F — Data-quality validation

- **Objective**: a dedicated pass (mirroring Milestone 5 Sub-phase C's own methodology) validating
  the FULL composed report (Sub-phase B–E's output) against real external stores at varied history
  depths, explicitly re-testing every state in Section 17's table with real data, not synthetic
  fixtures alone.
- **Modules affected**: none (validation only) — regression tests added wherever a real issue is
  found, per this project's own standing discipline.
- **Major risks**: this is exactly the phase most likely to surface a Sub-phase-C-style real bug
  (the temporal-boundary bug was found by exactly this kind of validation pass, not by unit tests
  alone) — budget real time for it, don't treat it as a formality.
- **Fable UI changes required**: no.

**Explicitly not in this roadmap**: Competitor Comparison (Section 25, deferred), Revenue/Traffic/
Review-velocity (Section 21, out of scope), AI features (Section 23, deferred), review-count
observation (Section 10, research required first, not implementation-ready).

---

## 27. Acceptance Criteria

Concrete, testable, for whichever sub-phase(s) are approved to begin:

- [ ] `FullReportView.tsx` and `dashboard/stores/[domain]/page.tsx` render identically, pixel-for-pixel
      in their pre-existing sections, before and after the change (verified by screenshot comparison,
      not just "looks the same").
- [ ] No `.tsx` file outside `src/components/analysis/` and the two named report pages is touched by
      any Sub-phase B–E work (scope containment check).
- [ ] Zero occurrences of a numeric "score" field anywhere in the new API response shape (grep-checked).
- [ ] Every new field in the composed report has a `status` of `OBSERVED` or `UNAVAILABLE` — zero
      `ESTIMATED`/`INFERRED` values introduced (grep-checked, matching this document's Section 11).
- [ ] Every insufficient-history case in Section 17's table renders its named honest state, verified by
      a real integration test seeding exactly that condition (1 crawl, 2 crawls, etc.) — not merely
      asserted in a unit test with mocked inputs.
- [ ] No new query in the composed report scans more than its documented bound (Section 18) —
      verified via `EXPLAIN ANALYZE` at a deliberately pessimistic scale, mirroring Sub-phase C's own
      methodology, not merely code-reviewed.
- [ ] `run-analysis.ts`'s `buildFullStoreReport()` — the function in the synchronous BASIC-unlimited
      path — has zero new calls into `growth/`, `marketing/`, or any new report-composition module
      (grep/import-graph checked).
- [ ] `crawlShopifyStore()`'s endpoint set (four shapes, Section 3) is unchanged — no new crawl surface
      added (grep-checked against `fetchWithTimeout` call sites).
- [ ] `monitoring/scheduler.ts`/`policy.ts` cadence constants are unchanged (diff-checked against this
      document's Section 3 citations).
- [ ] `src/lib/auth/` is untouched (diff-checked).
- [ ] `plan-limits.ts`'s numeric values are unchanged (diff-checked).
- [ ] `marketing/report.ts`'s `productMatching`/`adSpend`/`impressions`/`conversions` remain hard-coded
      `unavailable()` — not computed, not made conditional (diff-checked).
- [ ] No code path anywhere calls a revenue/traffic vendor or computes a revenue/traffic number
      (grep-checked for the absence of any such vendor's name in `package.json`/source).
- [ ] Full existing unit + integration suite passes unmodified in count or content, plus new tests for
      new behavior only (no existing test's assertions changed to accommodate new code, unless a real
      bug in the existing test is separately documented per this project's own standing rule).
- [ ] New functionality is live-tested against at least one real external Shopify store with rich
      history and one with a single crawl, mirroring Sub-phase C's own real-world validation
      methodology, not synthetic fixtures alone.

---

## 28. Security Review

Classified per the brief's exact LOW/MEDIUM/HIGH scale, based on the actual proposed additions
(Section 26) — not a generic audit of already-shipped, already-reviewed code.

| Risk | Classification | Reasoning |
|---|---|---|
| SSRF | **LOW** | No new crawl surface is proposed (Section 3/27); the existing `checkUrlIsSafeToFetch` guard is untouched by anything in this document |
| Authorization leaks (cross-user data exposure) | **LOW** | The proposed composed report follows the exact existing pattern (`GET /api/store/[domain]/report`'s store-scoped-not-user-scoped shape, already proven safe across three prior milestones) — no new per-user data is introduced; monitoring status (which IS per-user) already correctly derives from the session, and nothing in this document changes that derivation |
| Premium/free entitlement bypass | **LOW** | No entitlement logic is touched (Section 27); the composed report's new fields (pixels, payment providers, aggregate badges) follow the same no-entitlement-gate precedent already established for Growth/Marketing Intelligence (Milestone 4C's explicit decision, re-confirmed unchanged) — this is a deliberate continuation of an existing decision, not a new gap |
| Excessive database access / expensive-endpoint abuse | **MEDIUM** | The one flagged-but-unfixed item from Section 18 (`buildMarketingReport`'s unbounded `ads.findMany`) remains a real, if currently unproven, risk; a new composed-report endpoint that calls Growth + Marketing + the new fields concurrently is, by construction, a heavier single request than any endpoint that exists today (even though each component is individually bounded) — recommend the new composition endpoint gets its own, possibly stricter, rate limit (mirroring the existing 30/min pattern) rather than assuming the sum of several 30/min-limited components is automatically safe as one endpoint |
| Information leakage | **LOW** | No new field proposed in this document exposes anything not already `OBSERVED` and already served by an existing endpoint — the composition is additive, not a new data source |
| Event-history exposure | **LOW** | `Event` data is already store-scoped-not-user-scoped by design (shared corpus value, consistent with the whole product's positioning) — nothing in this document changes that model or exposes anything currently private |
| Marketing data exposure | **LOW** | Same reasoning — `AdObservation`/`MarketingCollectionRun` are already store-scoped, already served without an entitlement gate, unchanged here |

**No HIGH-severity risk was identified for anything actually proposed in this document.** The one
MEDIUM item (composed-endpoint request cost) is a real, if modest, new consideration specifically
because composition concentrates several already-safe calls into one request — flagged for Sub-phase
B's rate-limit design, not urgent, not a reason to withhold approval.

---

## Files Changed

```
docs/milestone-7-intelligence-productization-research.md    new
```

## Files Inspected

`src/lib/analysis/*` (all 4 files), `src/app/api/analyze/route.ts`,
`src/app/api/store/[domain]/{report,watch,activity,growth,marketing,events}/route.ts`,
`src/lib/crawl/shopify.ts`, `src/lib/crawl/fingerprint.ts`, `src/lib/security/ssrf-guard.ts`,
`src/lib/diff/engine.ts`, `src/lib/diff/persist.ts` (re-confirmed from prior sub-phase work this
session), `src/lib/monitoring/{activity,scheduler,policy,watch,run-scheduled-crawl}.ts`,
`src/lib/growth/*` (all 6 modules, re-confirmed from prior sub-phase work this session),
`src/lib/marketing/{report,activity,event-types}.ts` (re-confirmed from prior sub-phase work),
`src/lib/entitlements/{entitlement-service,analysis-usage,plan-limits}.ts`,
`src/components/analysis/{AnonymousReportView,MonitoringStatusCard,DetectionLog,ErrorPanel,
FreeReportStrip,FullReportView,GrowthIntelligence,AdvertisingSummary,StoreActivitySummary,
ChangeFeedTimeline}.tsx`, `src/components/dashboard/{MonitorButton,IntelligenceCard,SectionLabel}.tsx`,
`src/app/{page,dashboard/page,dashboard/watchlist/page}.tsx`, `prisma/schema.prisma` (full model map).

## Tests Run

None — this is a research/specification sub-phase; no code changed, so no test run was needed or
performed, per the explicit "do not implement" instruction.

## Tests Not Run

Full unit/integration suite was not run this sub-phase (nothing changed that could regress it). The
existing 447-test suite (253 unit + 194 integration) remains at its Milestone 5 Sub-phase C state,
unmodified.

## Production Code Changed: **NO**
## Schema Changed: **NO**
## Dependencies Changed: **NO**
## Fable UI Changed: **NO**

---

## 30. Decision Gate

| Capability | Decision | Reason | Next Action |
|---|---|---|---|
| Unified Store Intelligence Report (backend composition) | **GO** | Every field already exists and is already `OBSERVED`; this is composition, not new intelligence | Sub-phase B |
| Pixels / Payment Providers surfaced in report | **GO** | Fully collected, fully event-logged, zero new crawl/schema work (Finding 1) | Sub-phase B |
| Product Intelligence lists (Section 4C/5) | **GO** | Existing bounded data, existing filter mechanism | Sub-phase B/C |
| Growth Signals productization (Section 4B badges) | **GO** | Existing modules, new aggregation only | Sub-phase B/C |
| Competitor Timeline categorization | **GO** | Existing `Event` system, existing filter mechanism, existing headline-not-raw-name discipline | Sub-phase D |
| Bestseller trajectory visualization | **GO** | Data already delivered by the API, unused; one small, pattern-matching new component | Sub-phase E |
| `PRODUCT_RESTORED` activity count (Finding 2) | **GO** | One-line-scale fix to an existing aggregation | Sub-phase E |
| Marketing Intelligence productization (presence/format/region/trend) | **GO** | Already fully collected and shipped; this document adds no new marketing capability, only confirms its place in the unified hierarchy | Sub-phase B/C |
| Product-level ad matching | **REJECT / permanently deferred** | SerpApi never discloses destination URL — not a V1 gap to close, a vendor limitation | Do not build under the current vendor |
| Ad spend / impressions / conversions | **DO NOT BUILD** | No source exists | Revisit only if a new vendor is evaluated (separate research) |
| Revenue estimation | **DO NOT BUILD** | No ground truth / calibration dataset (Milestone 5/6, unchanged) | Revisit only with a real calibration dataset |
| Traffic estimation | **DO NOT BUILD** | No reliable, affordable, accurate-for-corpus source (Milestone 5/6, unchanged) | Revisit only with new vendor evidence |
| Review velocity as sales proxy | **DO NOT BUILD — permanent** | Import-review practice makes it unreliable by design | Permanently closed |
| Review-count observation | **RESEARCH REQUIRED** | Crawl-surface + adoption-rate unknowns (Milestone 6) | Small, bounded validation study — not V1 |
| Opportunity Score / any blended score | **REJECT** | No validated weighting methodology; live in-repo precedent (`rarityFactor`) shows exactly this failure mode | Use transparent signal badges instead (already the plan) |
| AI analysis / summarization | **DEFER** | Facts must remain deterministic; no evidence yet that a narration layer is needed | Future, not Sub-phase B–F |
| Competitor comparison (Store A vs. Store B) | **DEFER** | Plausible value, real complexity, best validated after the single-store report ships | Revisit after Sub-phase F |

### Final recommendation

> **Should Milestone 7 Sub-phase B begin immediately? YES.**

Sub-phase B should implement exactly the "Unified Store Intelligence Report backend composition"
scope specified in Section 26: one new, bounded, additive composition layer over
`buildFullStoreReport()` + `buildGrowthReport()` + `buildMarketingReport()` plus the two new Pixel/
Payment-Provider fields (Finding 1), following the additive-API-contract, no-entitlement-gate,
no-synchronous-vendor-cost, Fable-unmodified precedents this entire inspection confirmed are already
this codebase's own established discipline. No new research is required first — every fact Sub-phase
B needs is already established in this document, cited against the actual current source. The one
open design choice left for Sub-phase B itself to make (not a blocker, a decision) is the exact
composition-endpoint shape (extend `GET /api/store/[domain]/report` vs. a new dedicated route) and
its own rate limit (Section 28's MEDIUM finding) — both small, contained decisions with existing
precedent to follow either way.
