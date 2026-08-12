# Milestone 5 Sub-phase B — Growth Signals & Ordinal Bestseller Intelligence Research

**Status: research only. No application code, schema, dependency, API, or UI was changed to produce this document.**

This document inspects the actual repository (not assumptions) to determine whether Bellwether can
reliably ship (1) store growth signals, (2) product growth signals, (3) ordinal bestseller-rank
movement, (4) product freshness signals, (5) catalog expansion/contraction signals, (6)
technology/app adoption change signals, (7) review-app presence signals, and (8) a defensible
"opportunity intelligence" layer built only from observable/derived signals — never revenue,
traffic, or absolute sales volume.

---

## 1. Executive Summary

The single biggest finding of this research is that **store-level growth signals and review-app
presence are not a new build — they are already shipped**, and **ordinal bestseller-rank movement
is already half-shipped as discrete events**. `src/lib/monitoring/activity.ts` (`getActivitySummary`
+ `computeGrowthSignals`), wired through `GET /api/store/[domain]/activity` into
`StoreActivitySummary.tsx`, already computes real, deterministic, non-fabricated
CATALOG_EXPANSION / CATALOG_CONTRACTION / PRICE_ACTIVITY / STEADY signals from live `Event` and
`Product` rows, gated on a `hasEnoughHistory` (≥2 real crawls) rule that is exactly the discipline
this brief asks for. `src/lib/diff/engine.ts`'s `diffRank()` already emits `BESTSELLER_ENTERED`,
`BESTSELLER_CLIMBED`, and `BESTSELLER_DROPPED` events, and `ProductStateSnapshot.bestsellerRank`
already accumulates real rank history on every rank change (confirmed by direct reading of the
`stateChanged` computation, not assumption). Review-app presence is already tracked as `StoreEntity`
rows (`kind: APP`, keys `judgeme`/`yotpo`/`loox`/`stamped`/`okendo`) with full first-seen/last-seen/
removed history via the same generic `diffEntitySet()` state machine used for every other tech
signal.

What is genuinely missing is: (a) **product-level** growth signals (freshness, persistence, rank
trajectory as a queryable derived view rather than a stream of discrete crossing-events), (b) a
**catalog-size-over-time** table/chart at the store level (the raw data exists in `Product` fields
today but nothing aggregates it into a trend), (c) **rank persistence/acceleration** as derived
signals rather than raw snapshot rows, (d) dedicated **review-infrastructure presentation** (the
data exists as generic app rows; nothing frames it as "review infrastructure" specifically), and
(e) any **opportunity-combination** layer at all.

Two structural gaps limit what's honestly claimable regardless of how much is built: **no
product-to-collection membership mapping exists anywhere** in the schema or crawler (collections are
a flat handle list — `collectionHandles: string[]` — never linked to specific products), and
**bestseller ranking is captured for only one global list**, capped at whatever `pageSize` the crawl
used (250 by default, a hard Shopify per-request ceiling) — there is no per-collection ranking, and
products beyond the captured page never receive a rank at all, ever.

Overall this phase produces **five GO recommendations, one CONDITIONAL GO, and one NO-GO**
(automated opportunity *scoring* specifically) — see Section 19. Nothing here proposes revenue,
traffic, or sales-volume inference. Growth signals throughout are relative and observational:
positions, counts, and durations — never dollar amounts or unit counts.

---

## 2. Sub-phase A Decisions Carried Forward

From `docs/milestone-5-revenue-traffic-research.md`, binding on this phase:

| Decision | Status | Applies to this phase as |
|---|---|---|
| Estimated Revenue | **NO-GO** | No signal in this document computes or implies a dollar figure. |
| Estimated Traffic | **NO-GO** | Not revisited. No signal in this document implies visitor counts. |
| Review Velocity as revenue proxy | **PERMANENT NO-GO** | Not revisited. Review-app *presence* (Section 8) is a distinct, allowed capability — an ecosystem/technology signal, not a proxy for sales or customer volume. |
| Growth Signals | **GO** | Confirmed already partially shipped (Section 3); this phase extends it. |
| Ordinal Bestseller-rank movement | **GO** | Confirmed already partially shipped (Section 3); this phase extends it. |
| Review-App-Presence | **GO** | Confirmed already shipped as generic tech detection (Section 3); this phase asks whether dedicated presentation is warranted. |

The Sub-phase A economics findings (vendor-priced signals create dangerous, hard-to-bound cost
exposure; SimilarWeb/Ahrefs/Store Leads are all vendor-priced and unverified for accuracy at this
platform's scale) are the direct reason every signal proposed in this document is derived from data
the crawler **already collects for free** from the storefront's own JSON endpoints. Nothing here
proposes a new paid vendor.

---

## 3. Existing Architecture Findings

### 3.1 Existing Capability

**Data model (`prisma/schema.prisma`, confirmed by direct read):**

- `Product`: `firstSeenAt`, `lastSeenAt`, `missingSince`, `missingStreak`, `status`
  (ACTIVE/MISSING/REMOVED), `priceMinCents`/`priceMaxCents`/`compareAtMaxCents`, `variantCount`,
  `availableVariants`, `bestsellerRank` (nullable), `imageHash`, `sourceCreatedAt` (Shopify's own
  `created_at`, letting a launch timeline be reconstructed retroactively from a single first crawl),
  `tags`, `vendor`, `productType`. Denormalized current-state fields, one row per product, indexed
  `[storeId, status]`.
- `ProductStateSnapshot`: **append-only, one row per product PER CHANGE** (not per crawl) —
  `capturedAt`, `priceMinCents`/`priceMaxCents`/`compareAtMaxCents`, `variantCount`,
  `availableVariants`, `bestsellerRank`. Indexed `[productId, capturedAt DESC]`. This table already
  holds genuine bestseller-rank history: confirmed by direct read of `engine.ts`, a
  `ProductStateSnapshot` row is written whenever `stateChanged` is true, and `stateChanged` includes
  `(snapshot.hasRankData && prev.bestsellerRank !== p.bestsellerRank)` — a rank-only change, with no
  price or availability change, still produces a history row.
- `Crawl.rankHash`: a **separate** hash from `catalogHash`, specifically because — per the schema's
  own comment — bestseller ordering "changes almost daily," and mixing it into the catalog hash
  would defeat the crawl's unchanged-catalog short-circuit. This is itself evidence from the
  system's own design that rank is expected to be a high-churn signal, relevant to Section 9's
  noise/stability testing.
- `StoreEntity`: a fully generic ACTIVE→MISSING→REMOVED state machine (`diffEntitySet()` in
  `engine.ts`) already used for `APP`, `PIXEL`, `COLLECTION`, `PAYMENT_PROVIDER` kinds, each with
  `firstSeenAt`/`lastSeenAt`/`missingSince`/`missingStreak`. This is the *exact* shape needed for
  "technology adoption change" and "review-app presence first/last detected" — no new state machine
  is required.
- `Event`: append-only, immutable, `dedupeKey`-unique, `significance` (0–100, computed once at write
  time by `significance.ts`, never recomputed), `backfilled` flag (so reconstructed history never
  triggers a live alert). Already carries `BESTSELLER_ENTERED`, `BESTSELLER_CLIMBED`,
  `BESTSELLER_DROPPED`, `PRODUCT_ADDED`, `PRODUCT_REMOVED`, `PRODUCT_RESTORED`,
  `PRODUCT_SOLD_OUT`/`PRODUCT_RESTOCKED`/`VARIANT_SOLD_OUT`, `COLLECTION_ADDED`/`REMOVED`,
  `THEME_CHANGED`, `APP_ADDED`/`REMOVED` event types today.

**Diff engine (`src/lib/diff/engine.ts`, confirmed by direct full read):**

- `diffRank()` already implements ordinal-movement detection: `BESTSELLER_ENTERED` fires when a
  product's rank goes from null to present within `cfg.bestsellerWindow` (default 60);
  `BESTSELLER_CLIMBED` fires when rank improves by at least `cfg.minRankImprovement` (default 3);
  `BESTSELLER_DROPPED` fires when a product that was within the window is no longer ranked. Products
  whose rank is `>= cfg.bestsellerWindow` generate **no event at all** — `diffRank()` returns early.
  This is a tunable "newsworthiness" threshold, separate from the crawl-depth limit below.
- Two crawl-integrity guards directly relevant to catalog/rank trustworthiness: **GUARD 1** aborts
  the entire diff if the fresh catalog looks like it collapsed by more than
  `cfg.maxCatalogShrinkRatio` (default 0.4, i.e. a >40% apparent shrink), only when the store has at
  least `minProductsForShrinkCheck` (10) products — this protects against a broken crawl being
  mistaken for real catalog contraction. **GUARD 2**: a `PARTIAL` crawl status (some pages failed)
  skips removal-streak advancement — "additions are trusted, removals are NOT" — protecting against
  a transient fetch failure being read as products disappearing.
- `DEFAULT_DIFF_CONFIG` (from `events.ts`, confirmed): `minPriceChangePct: 0.02`,
  `minPriceChangeCents: 100`, `removalConfirmations: 2`, `maxCatalogShrinkRatio: 0.4`,
  `minProductsForShrinkCheck: 10`, `minRankImprovement: 3`, `bestsellerWindow: 60`,
  `maxEventsPerCrawl: 200`.

**Crawler (`src/lib/crawl/shopify.ts`, confirmed by direct read):**

- Bestseller ranks are fetched with **one single request**:
  `${baseUrl}/collections/all/products.json?limit=${pageSize}&sort_by=best-selling`, not paginated
  further. `pageSize` defaults to 250 (Shopify's own per-request ceiling). The code comment states
  the intent explicitly: "Only the top `pageSize` matter: `DEFAULT_DIFF_CONFIG.bestsellerWindow` …
  comfortably covers every rank the engine will ever treat as newsworthy." This means today's crawl
  already captures *more* raw rank data (up to ~250 positions) than the event system currently
  surfaces (top 60) — untapped raw signal, not a gap (see Section 5.3).
- Collections are fetched via `/collections.json`, producing a flat `collectionHandles: string[]` on
  the store snapshot (`crawl/types.ts`), plus an `hasCollectionData: boolean` flag distinguishing "we
  fetched zero collections because there are none" from "we fetched incompletely." **No product is
  ever associated with a specific collection handle anywhere in this pipeline** — confirmed by
  grepping `crawl/types.ts` for every occurrence of "collection."
- Tech/app/pixel/payment/theme fingerprinting (`fingerprint.ts`, confirmed by direct read) runs
  regex signatures against homepage HTML only. Review-app detection exists today for `judgeme`,
  `yotpo`, `loox`, `stamped`, `okendo` — a subset of `APP_SIGNATURES`, indistinguishable in the data
  model from any other detected app (Klaviyo, Recharge, Gorgias, etc.) until a caller specifically
  filters for review-related keys.

**Growth signals — already shipped end-to-end (`src/lib/monitoring/activity.ts`, confirmed by direct
read):**

- `getActivitySummary()` computes, purely from live `Event`/`Product`/`Crawl` queries (no caching,
  no invented numbers): `productsAdded`, `productsRemoved`, `priceChanges`, `currentProductCount`,
  `productCountWindowAgo` (derived by undoing the window's net add/remove from the current count —
  explicitly documented as an *approximation*, not a stored historical snapshot),
  `productCountDelta`, `productCountDeltaPct`, `crawlsInWindow`, and `hasEnoughHistory` (true only
  once `totalRealCrawls >= 2`).
- `computeGrowthSignals()` turns that into `GrowthSignal[]` with kinds `CATALOG_EXPANSION` /
  `CATALOG_CONTRACTION` / `PRICE_ACTIVITY` / `STEADY`, each carrying a plain-language `detail`
  string (e.g. `"+12 products (+6.4%) over the last 7 days"`) — no numeric score, no confidence
  percentage, deterministic and fully explainable from the inputs. Returns `[]` (not a
  fabricated-zero state) when `hasEnoughHistory` is false.
- Wired live: `GET /api/store/[domain]/activity` (rate-limited, 30 req/min) calls both functions and
  returns `{ summary, signals }`; `StoreActivitySummary.tsx` renders them as a stat grid plus pill
  badges, with an honest "Monitoring started" empty state when `hasEnoughHistory` is false, and a
  closing disclaimer line: *"Observed signals from real crawl history — not a claim about revenue or
  business growth."* This exact sentence is direct precedent for Section 14's misinterpretation
  guardrails.

**Entitlements (`src/lib/entitlements/plan-limits.ts`, confirmed by direct read):** FREE / BASIC /
BUSINESS tiers exist; an `advancedIntelligence: boolean` capability flag exists (false on FREE, true
on BASIC/BUSINESS) but — per the Milestone 4 Sub-phase C decision already on record — is
deliberately **unused**; Marketing Intelligence was opened to all analyzed users rather than gated
behind it. This document does not decide gating for growth signals (out of scope for a research
phase with no product decision requested), but notes the precedent: the last time a new intelligence
category shipped, the answer was "open to everyone," not "gate behind the unused flag."

**Report contract (`src/lib/analysis/report-contract.ts`, confirmed by direct read):** the
`IntelligenceField<T>` union — `OBSERVED` / `ESTIMATED` (`value` + `confidence` + `methodology`) /
`INFERRED` (`value` + `confidence`) / `UNAVAILABLE` (`reason`) — is the exact same discipline this
brief's OBSERVED/DERIVED/UNKNOWN vocabulary maps onto. `IntelligenceCard.tsx` already renders all
four states with a consistent badge, including a genuinely honest "Not available yet" + reason
treatment for `UNAVAILABLE` that looks like a real feature state, not a paywall tease. This component
is directly reusable for every new signal in this document.

**Cost/scheduling architecture (`monitoring/scheduler.ts`, `monitoring/policy.ts`, confirmed by
direct read):** crawl cadence by tier — HOT 8h, WARM daily, COOL weekly, COLD monthly (the default
tier a store gets on first baseline), DORMANT quarterly, DISABLED never. The scheduler claims stores
in batches of 10 (`DEFAULT_BATCH_SIZE`) via `SELECT … FOR UPDATE SKIP LOCKED`, then crawls the batch
**sequentially**, one store at a time, so no single tick can be monopolized. A manual "Analyze"
request (`run-analysis.ts`) runs one full crawl synchronously in-process per request; the
entitlement check happens *after* the crawl succeeds, never before, so a failed/blocked crawl never
burns a user's credit — but it also means **the crawl itself is not entitlement-gated**: anonymous
and authenticated users alike always trigger a real crawl against the target store.

### 3.2 Missing Capability

1. **No product-to-collection membership mapping**, anywhere. `StoreEntity(kind: COLLECTION)` only
   tracks the existence of a collection handle as a set member (present/absent/first-seen/last-seen)
   — never which products are in it. This directly means this brief's own Phase 11 mockup example
   ("Collections: Kitchen, Best Sellers, Trending" shown on a single product) **cannot be answered
   today** with any data source in this repository. Building it would require crawling each
   collection's product listing (`/collections/{handle}/products.json`) — an N+1 request pattern
   against the target store per crawl, a real cost and politeness concern not currently incurred at
   all (see Section 10).
2. **No per-collection bestseller ordering.** Only the single global "best-selling" sort is ever
   fetched. A product's position within, say, a store's "Best Sellers" *collection* specifically
   (as opposed to the whole catalog) is not observable with the current crawler.
3. **No rank data beyond the crawled page.** For any store with more products than `pageSize`
   (up to 250), products beyond that cutoff have `bestsellerRank: null` forever — not "unranked
   low," genuinely unknown. This must be surfaced honestly, not silently treated as "not a
   bestseller."
4. **No derived product-level growth/freshness computation exists.** `activity.ts` computes only
   store-level aggregates. Nothing today answers, for a single product, "how many snapshots has this
   product been observed in," "is its rank trending up across the last N observations," or "how
   persistent is its presence in the top N."
5. **No catalog-size-over-time series is materialized or queried anywhere.** The building blocks
   exist (Section 3.3) but no code computes or exposes a trend line.
6. **No dedicated "review infrastructure" presentation.** The detection exists; the framing
   (explicitly as an ecosystem signal, explicitly not a sales/velocity proxy) does not.
7. **No product review count, rating, or velocity data of any kind.** The crawler never fetches
   individual product pages (`/products/{handle}`), which is where review-app widgets render their
   content — confirmed architecturally: `shopify.ts` only ever calls `/products.json` (list
   endpoint), `/collections.json`, and the storefront root for fingerprinting. This is consistent
   with, and reinforces, Sub-phase A's permanent rejection of review velocity as any kind of proxy —
   the data plainly does not exist to compute it from, regardless of methodology.

### 3.3 Reusable Infrastructure

- **Catalog size at any past date is reconstructable without a new table.** A product existed at
  time T if `firstSeenAt <= T` and (`status != REMOVED` or `missingSince > T` or `missingSince` is
  null). Walking `Product.firstSeenAt`/`missingSince`/`status` for a store yields a step function of
  catalog size over time using data already collected on every crawl. **Honest caveat**: a product
  that was both added and fully removed *between* two consecutive crawls is invisible to this
  reconstruction — a genuine crawler-discovery gap, not a bug, and one that gets worse the longer a
  store's crawl interval is (i.e., worse for COLD/DORMANT-tier stores than HOT-tier ones).
- **`ProductStateSnapshot`** already gives free, real rank-history rows on every rank change (not
  just price/availability changes) — the raw material for rank trajectory, persistence, and
  acceleration is already accumulating in the database for every store that has ever been crawled
  more than once, at **no additional crawl or storage-schema cost**.
- **`computeGrowthSignals()`'s pattern** (deterministic, string-explained, `hasEnoughHistory`-gated,
  no numeric score) is the direct template to extend for product-level and rank signals — not a
  pattern to invent fresh.
- **`diffEntitySet()`'s ACTIVE→MISSING→REMOVED state machine** is the direct template for any new
  "first detected / still active / removed" lifecycle at the product level, and is already exactly
  what backs review-app presence today.
- **`IntelligenceCard`, `SectionLabel`, `ChangeFeedTimeline`, `StoreActivitySummary`'s `Stat`
  sub-component** are all proven, reusable UI primitives (used twice already for Marketing
  Intelligence) capable of rendering every signal this document proposes without new visual design.
- **A live, real cautionary precedent against fabricated scoring already exists in this codebase**:
  `significance.ts`'s `rarityFactor()` is designed to read from the `StoreStats` table, which — per
  `activity.ts`'s own comment, confirmed by grep across the codebase — **is never written by
  anything**. The function's defensive `if (!stats || stats.crawlsInWindow < 5) return 1.0;` means
  this term has silently been a permanent no-op (neutral multiplier) since it was written. This is
  direct, in-repository evidence for Section 12's opportunity-scoring caution: a numeric weighting
  term wired to data that isn't reliably populated degrades silently, and the only reason it isn't
  actively *wrong* today is that its designer defensively defaulted to neutral rather than to a
  confident-looking number. Any new score must follow that same discipline or, per this document's
  recommendation, avoid a single blended score altogether (Section 12).

---

## 4. Observable Growth Signals

Each signal below is evaluated for: reliability, source, frequency, historical data required, false
positives/negatives, collection cost, corpus compatibility, and transparency to users.

### 4.1 Store-level signals

| Signal | Reliable? | Source | Frequency | History needed | False positive risk | False negative risk | Collection cost | Status |
|---|---|---|---|---|---|---|---|---|
| New products detected | Yes | `PRODUCT_ADDED` events, `Product.firstSeenAt` | Per crawl | 2 crawls (`hasEnoughHistory`) | Low — GUARD 2 already protects partial crawls from misreading | Products added+removed between crawls are invisible (crawl-interval-dependent) | Zero (already crawled) | **Shipped** |
| Products removed | Yes | `PRODUCT_REMOVED` events (fires after `removalConfirmations`=2 consecutive absences) | Per crawl | 2 crawls | Low | A product temporarily 404ing (e.g. Shopify maintenance) could count once if it recovers before 2 confirmations — already mitigated by the 2-confirmation threshold | Zero | **Shipped** |
| Catalog expansion/contraction (net %) | Yes, with the documented approximation caveat | `computeGrowthSignals()` | Per crawl / on demand | 2 crawls | The `productCountWindowAgo` approximation doesn't reconcile mid-window MISSING→ACTIVE bounces — small, bounded skew | Same as above | Zero | **Shipped** |
| New/removed collections | Yes | `COLLECTION_ADDED`/`COLLECTION_REMOVED` events via `diffEntitySet` on `StoreEntity(kind: COLLECTION)` | Per crawl | 1 crawl for existence, 2 for a "new" claim | Low | A renamed collection handle looks like remove+add — an honest, documented limitation, not a bug | Zero | **Shipped** (not yet in `computeGrowthSignals`, only in raw event feed) |
| Collection size changes | **Not currently observable** | N/A — no product-to-collection membership exists | N/A | N/A | N/A | Total — this data does not exist | New: per-collection product list fetch, N+1 per crawl | **Missing capability** (Section 3.2 item 1) |
| Price changes (aggregate count) | Yes | `PRICE_DROP`/`PRICE_INCREASE`/`SALE_STARTED`/`SALE_ENDED` events | Per crawl | 2 crawls | Low (thresholded: `minPriceChangePct: 0.02`, `minPriceChangeCents: 100`, avoids penny-rounding noise) | Sub-threshold changes are intentionally not counted — documented, not accidental | Zero | **Shipped** |
| Tech additions/removals | Yes | `APP_ADDED`/`APP_REMOVED`/`PIXEL_ADDED`/`PIXEL_REMOVED`/`PAYMENT_PROVIDER_ADDED`/`REMOVED` events via `StoreEntity` | Per crawl | 1 crawl for existence, 2 for "new" | Signature staleness (an app changes its markup) silently degrades to "not detected," never a false positive — by design (`fingerprint.ts` comment) | Real but silent: an app the signature doesn't cover is invisible | Zero | **Shipped** |
| Theme changes | Yes | `THEME_CHANGED` events, `Store.themeName`/`themeVersion` | Per crawl | 2 crawls | Low | `themeVersion` is frequently null (no universal storefront signal exists per `fingerprint.ts`'s own comment) — under-detects version bumps, still catches name changes | Zero | **Shipped**, partial (name reliable, version often unavailable) |
| Storefront structural changes | Partially — only via theme name/version and catalogHash | `Crawl.catalogHash`/`techHash` | Per crawl | 2 crawls | N/A | A structural change that doesn't move catalogHash/techHash/themeName is invisible | Zero | **Partial** — no dedicated "structure changed" signal exists; catalogHash changing is a byproduct signal already used for the diff short-circuit, not exposed to users today |
| Frequency of catalog changes | Yes, derivable | Count of `PRODUCT_ADDED`/`REMOVED`/price events over multiple windows | Per crawl, aggregated | 3+ crawls for a *rate*, not just a delta | Low | Depends entirely on actual crawl cadence — a COLD-tier store crawled monthly cannot show a *weekly* frequency at all | Zero | **New, straightforward extension** of `activity.ts` |

### 4.2 Product-level signals

| Signal | Reliable? | Source | Frequency | History needed | False positive risk | False negative risk | Collection cost | Status |
|---|---|---|---|---|---|---|---|---|
| First seen / last seen | Yes | `Product.firstSeenAt`/`lastSeenAt` | Per crawl | 1 crawl | Low | A product added and removed entirely between two crawls never gets a `firstSeenAt` at all (invisible, not wrong) | Zero | **Shipped** (field exists; not surfaced as a "freshness" signal yet) |
| Persistence (present across N snapshots) | Yes, once product-level snapshot querying exists | `ProductStateSnapshot` count/gaps, or crawl-count while `status=ACTIVE` | Per crawl | 3+ crawls for a meaningful ratio | Low | Products that never change (price/rank/availability) get **no** `ProductStateSnapshot` rows at all — persistence for a static product must be computed from *crawl count while ACTIVE*, not snapshot count, or it will undercount every stable product. This is a real, non-obvious pitfall (see Section 6.4). | Zero | **New**, straightforward but requires the above correction |
| Price movement | Yes | `ProductStateSnapshot.priceMinCents/priceMaxCents` history | Per crawl (on change) | 2+ snapshots for a direction | Low (already thresholded) | Sub-threshold moves invisible by design | Zero | **Shipped** (raw data); no dedicated product-level trend view yet |
| Availability changes | Yes | `PRODUCT_SOLD_OUT`/`PRODUCT_RESTOCKED`/`VARIANT_SOLD_OUT` events, `ProductStateSnapshot.availableVariants` | Per crawl | 2 crawls | Low | Zero-inventory-tracking themes/apps can misreport availability upstream — inherited from the source, not introduced by this system | Zero | **Shipped** |
| Collection movement | **Not currently observable** | N/A | N/A | N/A | N/A | Same root cause as 4.1's collection-size gap | New crawl work | **Missing capability** |
| Bestseller ordering/movement | Yes, within crawled window | `Product.bestsellerRank`, `ProductStateSnapshot.bestsellerRank`, `BESTSELLER_*` events | Per crawl (rank refetched every crawl) | 2+ snapshots for movement, more for trend (Section 5) | Rank churns "almost daily" per the schema's own `rankHash` comment — single-snapshot moves can be noise, not durable movement (see Section 5.5) | Products beyond the crawled page (~250) never get a rank — total blind spot, not a false negative in the statistical sense, a structural one | Zero (already crawled) | **Partially shipped** — event-level; trajectory/persistence not yet derived |
| Appearance/disappearance | Yes | `PRODUCT_ADDED`/`REMOVED`/`RESTORED` events | Per crawl | 1–2 crawls | Low | Same crawl-interval gap as above | Zero | **Shipped** |
| Image/content changes | **Partially** | `Product.imageHash` (perceptual hash) exists but is documented as being for *cross-store* image matching, not change detection; no event type fires on an image-hash change today; title/tags changes are captured in raw fields but no `TITLE_CHANGED`/`CONTENT_CHANGED` event exists | Per crawl | 2 crawls | Perceptual hashing has inherent false-positive/negative rates for near-duplicate images — unverified in this codebase, no test coverage found for `imageHash` diffing | N/A | Zero (hash already computed) | **Missing capability** — field exists, diff logic does not |
| Variant changes | Partially | `Product.variantCount`, `ProductStateSnapshot.variantCount` | Per crawl | 2 snapshots | Low | A variant swap that keeps the same *count* is invisible (count-based, not identity-based) | Zero | **Shipped**, coarse (count only, not which variant) |

---

## 5. Ordinal Bestseller Intelligence Research

### 5.1 Which storefronts expose bestseller ordering

Shopify's default storefront JSON API supports `?sort_by=best-selling` on both the global catalog
(`/collections/all/products.json`) and any individual collection
(`/collections/{handle}/products.json`) — the crawler today uses only the former. This sort order is
Shopify's own internal sales-based ranking; its exact algorithm and refresh cadence are not publicly
documented by Shopify, and this repository does not have any way to verify it independently. It is
therefore properly the platform's own *derived* ranking, re-observed by us — we do not compute it,
we observe Shopify's computation of it. This distinction matters for the epistemic contract in
Section 15: `bestsellerRank` is OBSERVED (we read a value Shopify hands us) but the *reason* the rank
changed is fundamentally UNKNOWN to us (Shopify's algorithm is opaque, and even if it purely
reflected recent sales, we have no visibility into what "recent" means to Shopify or whether returns/
promotions/manual merchandising affect it).

### 5.2 How ordering is detected today, and its limits

Confirmed via direct code read (`shopify.ts`): one request, `sort_by=best-selling`, `limit=pageSize`
(default 250), **not paginated further**. Two independent limits exist and must not be conflated:

- **Crawl-depth limit** (~`pageSize`, up to Shopify's 250-per-request maximum): the hard ceiling on
  which products can *ever* receive a `bestsellerRank` value at all. A product ranked 300th is
  `bestsellerRank: null` forever under the current crawler, indistinguishable in the data from "this
  store doesn't have bestseller data."
- **Event-newsworthiness limit** (`cfg.bestsellerWindow`, default 60, tunable): the threshold below
  which `diffRank()` even bothers emitting `BESTSELLER_ENTERED`/`CLIMBED`/`DROPPED`. This is
  *product* policy, not a technical ceiling — raw rank data up to the crawl-depth limit already
  exists in `ProductStateSnapshot` even for positions 61–250 that never generate an event.

This second point matters: a derived "rank trajectory" *query* (new work, Section 5.4) is not
limited to 60 — it can legitimately show a product moving from #180 to #90, even though that
movement never fired a `BESTSELLER_*` event under today's event policy.

### 5.3 Per-collection ordering — confirmed not currently captured

As established in Section 3.2, the crawler never fetches `?sort_by=best-selling` against any
individual collection URL, and there is no product-to-collection membership data to even scope such
a query against retroactively. **Any UI implying "rank within Best Sellers collection" would be
fabricated** unless this crawl gap is closed first. This is a hard prerequisite, not a display
nuance.

### 5.4 Reconstructing ranking from snapshots — feasible, with real caveats

`ProductStateSnapshot(productId, capturedAt, bestsellerRank)` rows, ordered by `capturedAt`, directly
give a rank trajectory: `#80 → #55 → #37 → #21 → #12`. This is genuinely reconstructable **today**,
for any product that has had at least one rank change since it started being tracked, with no schema
change. Caveats that must be surfaced honestly, not smoothed over:

- **Gaps are silent.** If a product's rank didn't change between two crawls, no snapshot row exists
  for that crawl — the trajectory is a series of *changes*, not a fixed-interval time series. A
  30-day gap between two snapshot rows could mean "rank was stable for 30 days" or "we didn't crawl
  for 30 days" (COLD tier = monthly). These are different facts and must not be presented identically.
- **Ties and missing-product handling**: Shopify's `sort_by=best-selling` output is a dense ordinal
  list (no ties observed in the API's own behavior — every returned product gets a distinct 0-indexed
  position per `crawl/types.ts`'s comment "0-indexed position in /collections/all?sort_by=best-selling,
  if crawled"). When a product drops out of the crawled window, its rank becomes `null`, not a
  large number — it must never be treated as "worst possible rank" in a trend chart, only as "no
  longer observable in this range."
- **Ranking normalization across products of different catalog sizes** is not needed within a single
  store's own trajectory (rank is always relative to that store's own catalog), but comparing
  "moved from #12 to #8" across two stores of very different catalog sizes (50 products vs. 5,000)
  would be misleading without normalization — this document does not recommend any cross-store rank
  comparison for that reason.

### 5.5 What constitutes "meaningful" movement

The system already encodes one judgment call: `minRankImprovement: 3` — a 1–2 position move is
noise, ≥3 is a "climb." Given the schema's own acknowledgment that rank "changes almost daily,"
single-crawl movements at low crawl frequency (COLD tier = monthly) are far less noisy than the same
movements would be at HOT tier (every 8h) simply because there's more real time, and plausibly more
real sales activity, between two observations. **Rank stability/movement significance should be
interpreted relative to the store's own crawl cadence, not as an absolute constant** — a fixed
"≥3 positions = meaningful" threshold (as used today for events) is a reasonable default for the
existing coarse ENTERED/CLIMBED/DROPPED events, but a *derived trend* signal (Section 5.6) should
require multiple observations, not a single crossing, before calling anything "momentum."

### 5.6 Proposed derived signals — and which are, and are not, justified

| Proposed signal | Definition | Justified by current data? | Terminology |
|---|---|---|---|
| **Rank Movement** | `Previous rank → Current rank`, delta between the two most recent snapshots with rank data | Yes — direct read of two existing rows | "Observed rank movement" |
| **Rank Persistence** | "Observed within the top N in X of the last Y snapshots with rank data" | Yes, with the gap caveat from 5.4 made explicit in the copy (Y = snapshots *taken*, not calendar days) | "Ranking persistence" |
| **Rank Acceleration** ("momentum") | A monotonic or near-monotonic multi-point improving trend, e.g. `#80→#55→#37→#21→#12` | **Conditionally** — the arithmetic (comparing 4+ real snapshot values) is sound and requires no invention. What is **not** justified is calling this "sales growth" or "accelerating sales" — Shopify's ranking algorithm is opaque (5.1); a consistent rank improvement is evidence of *something* changing favorably for the product but the underlying cause (real sales increase, a promotion, a competitor's stockout, Shopify recalculating with different weights) is unverifiable from this data alone. Recommend the term **"ordinal product momentum"** or **"observed rank momentum"**, explicitly defined in-product as "based on Shopify's own bestseller ranking, not verified sales data," never "sales growth" or "sales momentum." | "Bestseller momentum" / "ordinal product momentum" (rank-only, explicitly not a sales claim) |

A minimum of **4 snapshots with rank data**, spanning at least 3 distinct crawls, is recommended
before labeling any trend "momentum" rather than "movement" — three points is the minimum to detect
a non-reversing direction at all, and a 4th guards against a single reversal being mistaken for a
trend break (see Section 7 for the fuller justification and Section 9 for how this would be tested).

---

## 6. Product Freshness Research

### 6.1 The proposed signal

"First detected: 14 days ago / Still active: Yes / Observed in 7 snapshots / Current bestseller
position #18" — a composite *display*, but each clause must be validated as an independent,
honestly-sourced fact before any combination is considered (per the brief's explicit instruction not
to jump to a combined score).

### 6.2 "First detected" — validated

`Product.firstSeenAt` is set at crawl time, from our own first observation — it is **not** Shopify's
`created_at`. `Product.sourceCreatedAt` (Shopify's own field) is separately available and is a better
answer to "when was this product actually created" *if* it predates our own tracking — but the two
must never be conflated in copy. "First detected 14 days ago" (our `firstSeenAt`) is a different,
narrower claim than "launched 14 days ago" (which would require `sourceCreatedAt`). Recommend the UI
always say "First detected" (our observation) and, only when `sourceCreatedAt` is present and trusted,
a secondary "Store lists this as created on {date}" line — kept visually and textually distinct, per
the OBSERVED-vs-OBSERVED-but-different-source distinction.

### 6.3 "Still active" — validated

Directly `Product.status === "ACTIVE"`. Reliable, already correct today (feeds `PRODUCT_REMOVED`/
`RESTORED` events).

### 6.4 "Observed in N snapshots" — validated, with a real pitfall

As flagged in Section 4.2: `ProductStateSnapshot` rows exist **only when something changed**. A
product whose price, availability, and rank have been perfectly stable since it was first crawled has
**zero** `ProductStateSnapshot` rows, not one-per-crawl. "Observed in 7 snapshots" computed naively
from `COUNT(ProductStateSnapshot)` would make a *stable* bestselling product look *less* observed
than a volatile one — exactly backwards from the intended meaning. The correct count for "how many
times have we looked and found this product active" is **crawl count while `status = ACTIVE` over
the product's lifetime**, which is not directly stored today (would need either a join against
`Crawl` filtered by `startedAt BETWEEN firstSeenAt AND (missingSince OR now)`, or — more cheaply — a
new lightweight counter). This is flagged as an implementation detail worth getting right the first
time, since getting it backwards would produce a signal that's confidently wrong rather than honestly
absent.

### 6.5 "Current bestseller position" — validated

Direct read of `Product.bestsellerRank`, with the honest `null` = "not currently ranked or beyond our
crawl depth" state already required by 5.2/5.3.

### 6.6 Is the combination useful, and is it justified?

The brief asks specifically whether "recently launched + persistent + increasing rank" is a useful
discovery signal. Each component is independently valid (6.2–6.5). The *combination* — new product,
seen consistently, climbing — is intuitively the shape of "something worth noticing," but this
document does not have (and Section 9 explains how one would obtain) empirical validation that this
combination actually correlates with anything a user would find valuable versus noise. The
recommendation (consistent with Section 12) is to **show the four component facts side by side,
transparently**, and let the user form the judgment, rather than collapsing them into a single
"Opportunity" score before that correlation has been tested against real outcomes.

---

## 7. Catalog Growth Research

### 7.1 The proposed signal

A store-level catalog-size-over-time table (`June 1: 182 → June 15: 194 → July 1: 217 → July 15:
243`).

### 7.2 Feasibility

As established in Section 3.3, this is reconstructable from `Product.firstSeenAt`/`missingSince`/
`status` with **no new table** — a "catalog size as-of date T" query is: count of products where
`firstSeenAt <= T` and (`status != REMOVED` or `missingSince > T`). Run at several T values, this
produces exactly the requested table.

### 7.3 Pitfalls, addressed one by one

- **Measurement windows**: the resolution of this reconstruction is bounded by actual crawl
  frequency, which is tier-dependent (Section 3.1). A COLD-tier store (monthly) cannot produce a
  meaningful *weekly* chart — there is nothing to plot between crawls except a flat interpolation,
  which would misrepresent granularity we don't have. Recommend the chart's minimum bucket width be
  derived from the store's actual observed crawl cadence, not a fixed UI default.
- **Minimum snapshot requirements**: at least 3 distinct crawl dates are needed for a chart to show a
  *trend* rather than two disconnected points; this document recommends against rendering any
  catalog-growth chart before that threshold, mirroring `hasEnoughHistory`'s existing ≥2 discipline
  but slightly stricter given a chart implies a trend claim a two-point delta doesn't.
- **Seasonal-product effects**: a store adding 40 products for a holiday drop and removing 35 of them
  six weeks later is real catalog churn, correctly captured — but "catalog grew 22%" during the drop
  and "catalog shrank 18%" after are both true statements about the *catalog*, and neither implies
  anything about revenue (this exact conflation is explicitly named as a misinterpretation risk in
  Section 14).
- **Bulk-import effects**: a store migrating platforms or bulk-uploading its full catalog in one
  crawl would show a single enormous `PRODUCT_ADDED` spike, indistinguishable in this data from
  genuine organic growth. Recommend the UI never claim "growth" without also being able to show the
  underlying event count is spread across multiple crawls, not concentrated in one — a "growth
  measured across N distinct crawl dates" qualifier is cheap to add and materially more honest.
- **Crawler discovery gaps**: already covered (Section 3.3) — products added-and-removed entirely
  between two crawls are invisible. This makes the reconstructed trend a **lower bound on churn**,
  not an exact ledger — worth stating once, plainly, near any such chart.
- **Pagination failures**: GUARD 1 (catalog-shrink circuit breaker) already protects against a
  pagination failure being misread as catalog contraction — a crawl that aborts due to
  `maxCatalogShrinkRatio` never reaches the point of writing `Product` state, so it cannot pollute
  this reconstruction. GUARD 2 similarly protects partial crawls from advancing removal streaks. Both
  guards were verified by direct code read, not assumed.
- **Temporary availability / duplicate URLs / variant-vs-product counting**: `Product` rows are keyed
  on `(storeId, externalId)` — Shopify's own stable product ID — not URL or handle, so a
  handle/URL change does not create a duplicate `Product` row. `variantCount` is tracked separately
  from product count, so a store adding variants to existing products (not new products) correctly
  does *not* show up as catalog growth — confirmed correct by the schema's own separation of these
  two counters.

### 7.4 Conclusion

Catalog growth can be **safely surfaced today**, using entirely existing fields, provided the chart
enforces a minimum-crawl-count gate and states its measurement-window limitation and the
crawl-discovery-gap caveat plainly. No new crawl work or schema change is required for the store-level
version.

---

## 8. Review-App Presence

Per the explicit instruction, review *velocity* is not revisited — it remains a permanent NO-GO as a
revenue proxy (Sub-phase A). This section is scoped strictly to presence-as-technology-signal.

### 8.1 What's already detected

`fingerprint.ts`'s `APP_SIGNATURES` already includes `judgeme`, `yotpo`, `loox`, `stamped`, `okendo` —
regex-matched against homepage HTML, feeding the same `StoreEntity(kind: APP)` pipeline as every
other detected app, with full `firstSeenAt`/`lastSeenAt`/removed history via `diffEntitySet()` and
`APP_ADDED`/`APP_REMOVED` events. This is confirmed shipped, generic infrastructure — nothing new is
required to detect "a review app is installed," "which one," or "since when."

### 8.2 What's missing is framing, not data

Today these five keys are indistinguishable in the UI from Klaviyo, Recharge, Gorgias, etc. — they
all render as generic entries in whatever "detected apps" list exists. The brief's ask is a
**dedicated, explicitly-scoped presentation**: "Review infrastructure detected: Judge.me (since
{date})" — filtered from the same `StoreEntity` query by a known review-app key list, styled as its
own labeled section rather than buried in a general tech list.

### 8.3 The exact, required epistemic framing

This must say, explicitly and prominently, next to the detected app name: **"Review infrastructure
detected — this indicates the store has a review collection system installed, not verified review
volume, review authenticity, or customer satisfaction."** This directly mirrors Sub-phase A's own
finding (cited in the prior research doc) that some of these very apps — including Judge.me itself,
via its own official "AliExpress Reviews Importer" — are also legitimately used to import a
*supplier's* reviews onto a *reseller's* store, meaning "has Judge.me installed" cannot even reliably
imply "collects its own customers' reviews," let alone imply sales volume. The presence signal is
real and useful (it says something about the store's operational maturity/tooling choices) but must
never be allowed to imply anything about customers, sales, or trust.

### 8.4 Conclusion

**GO**, and effectively free — this is a presentation-layer addition over already-shipped detection
and history, with no new crawl, schema, or cost. The only required care is in the copy (8.3), which
this document treats as a hard requirement, not a suggestion.

---

## 9. Historical Data Requirements

Per the brief, these are researched and justified from this system's own actual behavior, not
invented round numbers.

| Signal | Minimum snapshots/crawls | Recommended history | Frequency basis |
|---|---|---|---|
| Product freshness ("first detected," "still active") | 1 crawl | N/A — valid from the first crawl | Available immediately; a single crawl already answers "first detected when" and "still active" |
| Product persistence ratio | 3 real crawls (matches `hasEnoughHistory`'s existing ≥2 precedent, +1 stricter since a ratio implies a trend, not just a delta) | 5+ crawls for a stable-looking ratio | Tier-dependent: 3 crawls = 24h at HOT tier, but ~3 months at COLD tier — the *same* "3 crawls" threshold means very different real-world elapsed time depending on tier, and the UI must show elapsed time, not just crawl count |
| Catalog growth (chart) | 3 distinct crawl dates (Section 7.3) | 6+ for a visually meaningful trend line | Same tier-dependency as above |
| Bestseller rank movement (single delta) | 2 snapshots with rank data | N/A beyond that — already how `BESTSELLER_CLIMBED`/`DROPPED` work today | Every crawl re-fetches rank, so this accrues at full crawl cadence |
| Bestseller rank persistence | 5 snapshots with rank data | 10+ for the ratio to stabilize (below 5, one missed observation swings the ratio by 20+ points) | Same |
| Bestseller "momentum"/acceleration | 4 snapshots with rank data, from at least 3 distinct crawls (Section 5.6) | 6+ before describing a trend as "sustained" | Same — and given rank "changes almost daily" per the schema's own comment, this signal matures fastest at HOT tier and slowest at COLD/DORMANT tier |
| Technology/app change | 1 crawl for existence; 2 for "newly added" claim | N/A beyond that | Matches existing `APP_ADDED` event precedent exactly |

**Does the existing corpus already have sufficient history?** This cannot be answered with certainty
without querying live production data, which this research-only phase did not do (no database
queries were run against a live corpus; doing so was out of scope for a "no code, no execution"
research pass, and this document does not fabricate a corpus-size number it did not verify). What
*can* be said architecturally: because `DEFAULT_TIER_ON_BASELINE` is `COLD` (monthly cadence) and
most stores only get promoted to a faster tier by being watchlisted, a large fraction of the corpus —
specifically every store that was analyzed once and never watched — likely has very few real crawls
regardless of how long ago it was first analyzed. **Recommendation**: before shipping any signal with
a >2-crawl minimum, run a real query (`SELECT storeId, COUNT(*) FROM "Crawl" WHERE status IN
('OK','PARTIAL') GROUP BY storeId`) against production to confirm what fraction of stores would
actually clear each threshold — this is a cheap, non-code verification step for the next
implementation milestone, not a reason to block this research.

---

## 10. Cost & Scalability Analysis

This section is mandatory per the brief, given Sub-phase A's finding that vendor-priced intelligence
creates dangerous, hard-to-bound cost exposure.

### 10.1 The critical distinction from Marketing Intelligence's cost risk

Marketing Intelligence's cost risk was **external, per-call, vendor-metered** (SerpApi). Every signal
in this document is computed from data **the crawler already fetches from the target storefront's own
free JSON endpoints** — no new vendor, no new paid API, no new per-signal external cost. This is a
materially different, and materially smaller, risk category. It does **not** mean there is no cost
risk at all — the real risks here are (a) additional **crawl requests** if per-collection product
membership is ever built (Section 3.2 item 1), and (b) **database query cost** as
`ProductStateSnapshot` grows without bound.

### 10.2 Crawl-request cost, if collection-membership mapping is pursued

Fetching every collection's product list would add up to `collectionHandles.length` extra requests
**per crawl, per store** — for a store with 40 collections, that's 40 additional HTTP requests against
someone else's storefront on every single crawl, at every tier's cadence. At HOT tier (every 8h) that
is 120 requests/day to one store just for this feature. This is a real politeness/rate-limit/latency
cost against target storefronts, not a $ cost to Bellwether, but it directly threatens crawl
reliability (more requests = more chances to trip the target's own rate limiting, which the crawler's
existing retry/backoff logic would then have to absorb) and crawl duration (more requests = longer
`durationMs`, worse user-facing latency on manual "Analyze" requests, which run synchronously). **This
document explicitly recommends against per-collection membership crawling being added to the
synchronous manual-analysis path.** If pursued at all, it should be a background, opt-in,
lower-frequency job scoped to watchlisted (HOT-tier) stores only — never something a first-time
anonymous "Analyze" request pays for. This is exactly the "if background/corpus-scoped collection is
required, state that explicitly" instruction from the brief: **it is explicitly required**, should
collection-membership ever be built.

### 10.3 Database growth and query cost

`ProductStateSnapshot` is already unbounded and growing today (append-only, one row per change) —
this is pre-existing, not introduced by this document. What this document's proposed signals add is
**read** load: rank-trajectory and persistence queries need to scan a product's snapshot history
ordered by `capturedAt`. The existing index `[productId, capturedAt DESC]` already supports this
efficiently for a single product; the risk is a query that scans *all* snapshots for *all* products in
a store (e.g., a naive "catalog growth chart" implementation) without a bound. Every derived-signal
query in this document should be written against a specific, indexed key (`productId` or `storeId` +
a date range), never an unbounded table scan — this is a code-review-time constraint for the next
milestone, not a schema change.

### 10.4 The BASIC-unlimited-analysis flow, specifically

Per the brief's explicit instruction to pay particular attention here: `buildFullStoreReport()`
(`run-analysis.ts`) currently issues 6 parallel Prisma queries per report, all simple counts/finds/
aggregates against indexed columns — cheap today. Adding product-level freshness/persistence/rank-
trajectory to this **synchronous** path means adding N more per-product queries (one per bestseller
product shown, potentially) to every single manual analysis request, run by BASIC users with
*unlimited* analysis counts. **This is the actual unbounded-cost risk for this phase** — not vendor
dollars, but unbounded synchronous database read amplification on a plan tier with no request cap.
Recommendation: any product-level derived signal shown in the synchronous report path must be scoped
to a small, fixed-size set (e.g., "top 10 currently-ranked products" or "products with a
`ProductStateSnapshot` in the last N days"), never "every product in the catalog," and should be
measured (query count, latency) before being added to that path.

### 10.5 Storage estimate

`ProductStateSnapshot` rows are small (a handful of ints + a timestamp). At corpus scale — this
document does not have a verified current row count (Section 9) — the marginal storage cost of the
*existing* rank-history capture is already being paid; nothing in this document increases the write
volume, only proposes new ways to *read* what's already being written.

### 10.6 Conclusion

**No new external/vendor cost.** Real, boundable crawl-cost risk only if per-collection membership
crawling is pursued (recommend: don't, or scope to background/HOT-tier only). Real database read-cost
risk if product-level signals are added to the synchronous BASIC-unlimited report path without a
fixed cap — this is the section's core actionable finding for the next milestone's implementation.

---

## 11. Signal Quality & Validation Plan

Per the brief: not "this should work," a concrete methodology per signal.

| Signal | Ground Truth | Test Corpus | Metrics |
|---|---|---|---|
| Catalog expansion/contraction | Manually verify against the target store's own storefront (visit `/collections/all` and count) at two dates for a small sample of real stores | 5–10 real Shopify stores spanning small (<50 SKU) to large (1,000+ SKU) catalogs, at least one fashion (high SKU churn) and one durable-goods (low churn) store | Precision (of claimed adds/removals, how many are real), recall (of real adds/removals, how many were caught), false-positive rate specifically around bulk-import events (7.3) |
| Bestseller rank movement | Not independently verifiable — Shopify's own ranking is the ground truth, and we only ever observe it, never compute it ourselves (5.1) | Same corpus, filtered to stores with an active "Best Sellers" merchandising pattern (fashion/DTC brands typically) | **Not precision/recall** (there is no independent truth to compare against) — instead: **snapshot consistency** (does re-crawling immediately reproduce the same rank, i.e., is Shopify's own list stable moment-to-moment) and **stability under the ≥3-position noise threshold** (what fraction of single-crawl rank changes reverse within the next crawl — a proxy for how much of "movement" is noise vs. durable) |
| Rank persistence | N/A (definitionally derived from our own snapshot history, not an external fact) | Same corpus | **Snapshot consistency**: does the persistence ratio stay stable (not wildly swing) as more snapshots accrue — tested by computing the ratio at snapshot 5, 10, 15 for the same product and checking it converges rather than oscillates |
| Product freshness (first-detected/persistence combo) | Cross-check `firstSeenAt` against `sourceCreatedAt` where both are available — large discrepancies flag a bug, not a data-quality issue in Shopify's own field | Corpus with a known mix of recently-launched and long-standing products (verifiable by visiting the store and checking product page "new" badges or announcement dates, where the merchant discloses them) | Agreement rate between `firstSeenAt` and `sourceCreatedAt` for products where both exist |
| Catalog growth chart | Manual count at 3+ real dates against a real store (labor-intensive, small sample) | 3–5 real stores tracked manually over several weeks during this validation | Precision/recall of the reconstructed step-function against manual counts; specifically test a store known to have run a bulk import (dropshipping stores are a good target — frequent bulk catalog swaps per Sub-phase A's own research) |
| Review-app presence | Visually inspect the storefront for review widgets (Judge.me/Loox/etc. badges) vs. what `fingerprint.ts` detected | Corpus should include dropshipping-pattern stores specifically, since Sub-phase A flagged these as where imported (non-native) reviews are most common — presence detection doesn't need to distinguish native vs. imported (8.3's copy handles that), but the *detection itself* should be checked for false negatives (installed but undetected due to signature staleness) | False-negative rate (installed apps not caught by current `APP_SIGNATURES`) — false positives are structurally impossible here since detection is regex-based on real markup, not inference |

**Test corpus composition** (per the brief's explicit categories): small (<50 SKU) and large
(1,000+ SKU) stores; at least fashion, electronics, beauty, and home categories; at least one
confirmed dropshipping-pattern store and one confirmed DTC-manufacturer store (distinguishable by
catalog turnover rate and, per Sub-phase A's research, telltale signs like imported-review apps);
stores with and without a "Best Sellers" collection specifically named as such. This document
recommends this validation pass be a first-week task of the *next* (implementation) milestone, run
against a handful of real, consented, or clearly-public storefronts — not fabricated or synthetic
data, consistent with Sub-phase A's own "no unverified scraping, no fabricated ground truth" standard.

---

## 12. Opportunity Intelligence Assessment

### 12.1 Should signals combine at all?

The brief's own example — Product Freshness + Bestseller Momentum + Rank Persistence + Catalog
Context + Technology Context → "Product Opportunity Signal" — is intuitively appealing but this
document finds **no evidentiary basis yet** for combining these into anything more than a
side-by-side presentation. Section 9's validation plan has not been run; Section 6.6 explicitly
declined to endorse the freshness+momentum combination as validated; and Section 3.3's `rarityFactor`
precedent is a live, in-repository example of what happens when a numeric combination is shipped
ahead of the data actually supporting it (it silently no-ops rather than actively lying, which is the
*best-case* outcome of doing this wrong — not a reason to repeat the pattern).

### 12.2 Should it be a score?

**No.** A single number (e.g., "Opportunity Score: 87/100") implies a validated, weighted formula.
None of the weights between freshness/momentum/persistence/catalog-context/tech-context have any
empirical basis in this codebase or this research — assigning them would be exactly the "arbitrary
weights" the brief explicitly forbids. `rarityFactor`'s own concrete history in this codebase (bucket
thresholds like `<=0.2 → 1.4x`, `<=1 → 1.15x` — hand-picked, undocumented-as-validated multipliers)
is itself an example of exactly this pattern already present in the significance scorer, and this
document does not recommend replicating it for a new, user-facing "opportunity" concept without
validation, even though the precedent exists.

### 12.3 Should it be ordinal?

An ordinal ranking ("this product ranks higher on our opportunity signals than that one") has the
same weighting problem as a score — ranking two products requires comparing their signals, which
requires weights. Not recommended for the same reason as 12.2.

### 12.4 Recommended presentation instead

The brief's own preferred example is directly endorsed by this research: a **transparent,
signal-based badge list**, e.g.:

```
🟢 Recently detected (12 days)
🟢 Bestseller rank improving (#37 → #12)
🟢 Persistent bestseller presence (8 of last 9 observations)
🟡 Moderate catalog competition (240 active products in this store)
```

Each line is a direct, honestly-labeled restatement of one already-validated OBSERVED or DERIVED
fact (Sections 4–8), with **no aggregation, no weighting, no single number**. This is both more
defensible today and more useful long-term: if validation (Section 11) later demonstrates a
genuine correlation worth scoring, that's a future, evidence-backed decision — not one this
research phase can responsibly make now.

### 12.5 Should users see component signals?

Yes, always — per 12.4, the components *are* the presentation, not hidden inputs to a black box.

### 12.6 How should confidence be represented?

Not as a percentage (no methodology in this document justifies a specific number). Where confidence
genuinely varies (e.g., rank momentum with only 4 snapshots vs. 12), represent it structurally —
"based on 4 observations" rather than "72% confidence" — letting the user judge reliability from the
same transparent facts rather than a manufactured summary statistic.

### 12.7 Do different categories need different models?

Not evaluated in this phase — this question only becomes answerable once Section 11's validation is
actually run across a category-diverse corpus. Flagged as an open question for the next milestone,
not resolved here.

---

## 13. UX Presentation Recommendations (spec only — no implementation)

All of the following reuse `IntelligenceCard`, `SectionLabel`, `ChangeFeedTimeline`, and
`StoreActivitySummary`'s `Stat` pattern exactly as they exist today — no new component, no Fable
redesign.

### 13.1 Product card (within an existing product list)

```
┌─────────────────────────────────────┐
│ Product Title                        │
│ 🆕 Detected 12 days ago              │
│ ↑ Bestseller rank #37 → #12          │
│ ● Persistent · seen in 8/9 checks    │
└─────────────────────────────────────┘
```

Each line is a DERIVED signal restating an OBSERVED fact, with the underlying observation always one
click away (13.2). "🆕", "↑", "●" are the same restrained iconography style
`StoreActivitySummary.tsx` already uses for its pill badges — no new visual language introduced.

### 13.2 Product Intelligence page (detail view)

```
SectionLabel: OBSERVED HISTORY

First seen:        14 days ago (2026-07-28)
Still active:       Yes
Last checked:        2 hours ago

SectionLabel: BESTSELLER RANK TRAJECTORY
  #80 → #55 → #37 → #21 → #12   (5 observations, 3 distinct crawls)
  ⚠ Based on Shopify's own bestseller ranking — not independently verified sales data.

SectionLabel: PRICE TRAJECTORY
  $24.00 → $19.99 (2026-08-02)   [existing IntelligenceCard/price-history pattern, unchanged]

SectionLabel: COLLECTIONS
  Not available — product-to-collection mapping is not currently tracked.
  [rendered via IntelligenceCard's existing UNAVAILABLE state, exact same treatment
   Marketing Intelligence's "Product matching" card uses today]
```

The explicit `UNAVAILABLE` treatment for collections (rather than omitting the section) is
deliberate and matches this codebase's established convention (Milestone 4E's "Product matching:
Not available yet" card) — an honest gap, presented identically to an already-shipped field, never a
missing section that looks like an oversight.

### 13.3 Store-level catalog growth chart

A simple step-line chart of catalog size at each real crawl date (never interpolated between crawls
in a way that implies data between them), with a one-line caption: *"Catalog size at each check —
gaps reflect actual crawl frequency for this store."* Directly extends the existing
`StoreActivitySummary` section rather than introducing a new page.

### 13.4 Review infrastructure card

Reuses `IntelligenceCard` exactly:

```
REVIEW INFRASTRUCTURE                              [Observed]
Judge.me
Detected 2026-03-14 · still active
Indicates a review collection system is installed —
not a measure of review volume or customer sentiment.
```

### 13.5 What the UX must never do

- Never show a bestseller rank number without the trajectory or persistence context next to it — a
  bare "#12" with no history invites exactly the "rank = sales" misreading (Section 14).
- Never show catalog growth as a percentage without the underlying date range and crawl-count
  visible in the same view.
- Never combine multiple derived signals into one visual weight (size, color intensity, single score)
  that implies a ranking between products, per Section 12.

---

## 14. Misinterpretation & Trust Risks

| Risk | Why it's wrong | Mitigation copy |
|---|---|---|
| "Bestseller rank increased, therefore sales increased" | Shopify's ranking algorithm is opaque (5.1); a rank change could reflect returns/other products dropping/promotions/Shopify's own recalculation, not necessarily this product's sales rising | Every rank-movement display carries: *"Based on Shopify's own bestseller ranking — not independently verified sales data."* (already spec'd in 13.2) |
| "Review app detected, therefore store has lots of customers / genuine reviews" | Review apps are also used to import a *supplier's* reviews (Sub-phase A finding, cited in 8.3); presence proves tooling, not volume or authenticity | Fixed copy: *"Indicates a review collection system is installed — not a measure of review volume or customer sentiment."* (8.3, 13.4) |
| "Catalog grew 40%, therefore revenue grew 40%" | Catalog size and revenue are entirely different observations; a store can add 40% more SKUs and sell none of them, or sell fewer total dollars across a larger catalog | Catalog charts never appear near any revenue/traffic language (moot today since those remain UNAVAILABLE per Sub-phase A) and should carry: *"Observed catalog size — not a measure of sales or revenue."* (mirrors the exact sentence `StoreActivitySummary.tsx` already uses today for its own disclaimer) |
| "This product is persistent in the bestseller list, therefore it's a safe bet to source/compete on" | Persistence measures *observation frequency*, not profitability, margin, or demand durability going forward — past ranking says nothing about competitive saturation or margin at the point a new seller would enter | Persistence signals should be labeled "observed," never "recommended" or "opportunity" without the Section 12 caveats attached |
| "Product freshness + climbing rank = guaranteed opportunity" | Section 6.6/12 explicitly found this combination unvalidated | Present as independent badges only (12.4), never a single "Opportunity" verdict |
| "A gap in the rank trajectory means the product fell out of the bestseller list" | A gap might just mean the crawl cadence didn't happen to observe a change (5.4) — especially likely at COLD/DORMANT tier | Trajectory displays must distinguish "not observed in this range" from "confirmed absent," using the same `null`-vs-explicit-`DROPPED`-event distinction the data already supports |
| "No review app detected, therefore this store has no reviews" | Detection is signature-based and can silently miss a review app whose markup doesn't match current signatures, or a store using a review system embedded without a detectable third-party widget (native platform reviews, e.g.) | Absence must be framed as "no review infrastructure detected" (a statement about our detection), never "this store has no reviews" (a claim about the store) |

---

## 15. Recommended Data Model Changes — RESEARCH ONLY

No schema change is required for: store-level catalog growth (7), review-app presence (8), rank
movement/persistence/momentum as computed from existing `ProductStateSnapshot` (5), or product
freshness (6) — all reconstructable from fields that exist today.

If pursued in a future milestone, these would be net-new and should be scoped as separate,
independently-justified follow-up work, **not** part of this phase's recommended GO items:

- A `ProductCollection` join table (`productId`, `collectionHandle`, `firstSeenAt`, `lastSeenAt`) —
  only justified if per-collection ordering/membership work (Section 10.2) is separately approved,
  given its real crawl-cost implications.
- A lightweight `Product.observedCrawlCount` counter (incremented once per crawl the product was seen
  `ACTIVE`, regardless of whether anything changed) — would make persistence-ratio computation (6.4)
  a direct field read instead of a `Crawl` join, at the cost of one more write per product per crawl.
  Worth considering specifically because the join alternative could become the exact kind of
  unbounded-read-cost risk flagged in Section 10.3 at scale.
- A `TITLE_CHANGED`/`IMAGE_CHANGED` event pair, if content-change tracking (4.2) is prioritized —
  `imageHash` already exists but is unused for diffing today.

---

## 16. Recommended API Changes — RESEARCH ONLY

Following the additive-only pattern already used for Marketing Intelligence (Milestone 4E added four
fields to an existing endpoint rather than a new route):

- `GET /api/store/[domain]/activity` could be extended with a `catalogHistory` array (Section 7) and
  a `reviewInfrastructure` field (Section 8) — additive to the existing `{ summary, signals }` shape.
- A new, product-scoped read endpoint would be needed for Section 13.2's detail view (freshness +
  rank trajectory + persistence for one product) — none of the existing routes are product-scoped
  today (`activity`, `events`, `marketing`, `report`, `watch` are all store-scoped). This is the one
  genuinely new route implied by this document's recommendations, and its query shape must respect
  Section 10.3's indexed, bounded-query constraint.
- No change recommended to `GET /api/store/[domain]/report` (the synchronous BASIC-unlimited path) —
  per Section 10.4, product-level signals should not be added to this path without an explicit,
  small, fixed cap.

---

## 17. Recommended Background Processing — RESEARCH ONLY

Per Section 10.2's explicit finding: **if per-collection product-membership crawling is ever
pursued, it must be background and/or HOT-tier-scoped, never part of the synchronous manual-analysis
path.** Everything else in this document (rank trajectory, persistence, catalog growth, review
presence) is a **read-time computation over already-collected data** — no new background job is
required to produce it, only (per Section 10.3) careful, indexed, bounded queries at read time. If
Section 6.4's `observedCrawlCount` counter is adopted, it would be a small addition to the existing
per-crawl persist path (`diff/persist.ts`), not a separate job.

---

## 18. Implementation Dependencies

1. Section 9's corpus-history verification (a real query against production `Crawl` counts) should
   run before committing to any >2-crawl-minimum signal, to avoid shipping a signal that's
   `UNAVAILABLE` for the overwhelming majority of the corpus.
2. Section 11's validation pass (against a small real, diverse store corpus) should run before any
   "momentum"/"opportunity" language ships, even in the non-scored, badge-based form recommended in
   12.4 — the badges still need their underlying thresholds (e.g., "4+ snapshots" for momentum)
   sanity-checked against real data, not just this document's reasoning.
3. Section 6.4's crawl-count-vs-snapshot-count distinction must be resolved in code review before
   persistence signals ship — this document flags it as the single highest-risk "confidently wrong"
   pitfall identified in this research pass.
4. Any per-collection membership work (Sections 3.2, 10.2, 15) is its own, separately-scoped decision
   given its real crawl-cost and politeness implications — not bundled into the rest of this
   document's GO items.

---

## 19. GO / NO-GO Decision Table

| Capability | Decision | Confidence | Reason |
|---|---|---|---|
| Store-level growth signals (catalog size, expansion/contraction, price activity) | **GO** | High | Already shipped end-to-end (`activity.ts` → API → UI); this phase's work is extension (catalog-history chart, Section 7), not invention. Confirmed by direct code read, not assumption. |
| Bestseller rank movement (single-delta and multi-point trajectory) | **GO** | High | Rank history already accumulates today (`ProductStateSnapshot`, confirmed via `stateChanged` logic); movement/persistence are direct queries over existing data. Momentum/acceleration language requires the ≥4-snapshot threshold and explicit "not sales data" framing (Section 5.6, 14). |
| Product freshness (first-detected, still-active, persistence) | **CONDITIONAL GO** | Medium | First-detected/still-active are trivially correct today. Persistence has one concrete, identified implementation pitfall (Section 6.4 — snapshot-count vs. crawl-count) that must be resolved correctly, not assumed; confidence is Medium specifically because that correction hasn't been validated in code yet, only identified in research. |
| Catalog growth (store-level trend chart) | **GO** | High | Fully reconstructable from existing `Product` fields; guards against the known pitfalls (bulk-import spikes, pagination failures) already exist in the diff engine (GUARD 1/2, confirmed by direct read). |
| Review-app presence (dedicated framing) | **GO** | High | Detection and history already shipped generically; this is a presentation-layer addition with a hard-required, already-drafted epistemic-safety copy requirement (Section 8.3). |
| Opportunity scoring (single numeric/ordinal score) | **NO-GO** | High | No empirical basis for any weighting between component signals; this codebase's own `rarityFactor`/`StoreStats` precedent (Section 3.3) is direct evidence of what happens when a score ships ahead of its data. Explicitly rejected per Section 12. |
| Automated opportunity recommendations (system proactively surfacing "opportunities" to users) | **NO-GO** | High | Depends entirely on the scoring this document rejects; also unvalidated against Section 11's not-yet-run signal-quality testing. Transparent signal badges (Section 12.4) are the recommended substitute — not a recommendation, a display of facts. |

Per the brief's own instruction, no GO was forced: Product Freshness is deliberately marked
CONDITIONAL rather than a clean GO because a specific, concrete implementation risk was found and not
yet resolved in code; Opportunity Scoring and Automated Recommendations are marked NO-GO on direct,
in-repository evidence rather than general caution.

---

## 20. Recommended Next Milestone

Suggested implementation order, sequencing lowest-risk/highest-confidence first and gating riskier
work behind the validation this document identified as still outstanding:

1. **Review infrastructure presentation** (Section 8) — zero new data, zero new risk, ships the
   required epistemic copy. Fastest, safest first slice.
2. **Store-level catalog growth chart** (Section 7) — no schema change, guards already exist,
   well-understood pitfalls with documented mitigations.
3. **Bestseller rank movement + persistence, product-scoped detail view** (Sections 5, 13.2) —
   requires the one new API route (Section 16) and the crawl-count-vs-snapshot-count fix (Section
   6.4) to be done correctly in the same pass, since persistence and rank-history share the same
   underlying data-access pattern.
4. **Product freshness combined display** (Section 6, 13.1) — layer onto step 3's work once the
   persistence-counting fix is in place and tested.
5. **Run Section 11's validation pass** against a real, diverse store corpus, in parallel with or
   immediately after steps 1–4 ship — this is what would upgrade "momentum" language from
   research-justified-but-unvalidated to actually validated, and would answer Section 12.7's open
   "different models per category" question.
6. **Explicitly deferred**: per-collection product membership (Section 3.2/10.2/15) — real crawl-cost
   tradeoffs that deserve their own scoped decision, not bundled into this milestone. Opportunity
   scoring — deferred indefinitely pending Section 11's validation results, and even then, this
   document's default recommendation remains the transparent-badge presentation (12.4), not a score.

Architectural work needed **before** step 3, specifically: resolve Section 6.4 (persistence counting
method) and Section 10.4 (fixed cap on any product-level query added near the synchronous report
path) at design time, not discovered during implementation — both are concrete, already-identified
risks, not open-ended unknowns.

---

## 21. Explicitly Rejected Ideas

- **A single "Opportunity Score"** (0–100 or similar) — no validated weighting exists; rejected per
  Section 12, with this codebase's own `rarityFactor`/`StoreStats` history as direct supporting
  evidence of the failure mode.
- **Calling bestseller rank improvement "sales growth" or "increasing sales"** — Shopify's ranking
  algorithm is opaque and unverifiable from this data; rejected per Section 5.1/5.6/14. The accepted
  substitute is "bestseller momentum" / "observed rank movement," always paired with the
  not-sales-data disclaimer.
- **Per-collection bestseller ranking or collection-membership display, right now** — the crawl
  infrastructure to observe it doesn't exist, and building it has real, non-trivial crawl-cost
  implications (Section 10.2) that deserve their own decision, not folded into this milestone.
  Rejected as *this milestone's* scope, not rejected as a concept.
- **Cross-store rank comparison** ("this product ranks better than that one at a different store") —
  rejected per Section 5.4: catalog sizes differ too much between stores for an unnormalized ordinal
  comparison to mean anything, and no normalization methodology was researched or validated here.
- **Interpolating catalog-size charts between crawl dates** — rejected per Section 7.3/13.3: would
  visually imply data resolution the crawl cadence doesn't actually provide.
- **Treating a missing/null bestseller rank as "worst possible rank"** — rejected per Section 5.4:
  conflates "not observed" with "observed and ranked last," which are different facts with different
  reliability.
- **Any UI treating "review app detected" as evidence of review volume, authenticity, or customer
  count** — rejected per Section 8.3/14, consistent with and explicitly not revisiting Sub-phase A's
  permanent review-velocity rejection.

---

*End of research document. No application code, schema, dependency, API, or UI was modified while
producing this document — verified by this session's tool history (`Read`/`Grep`/`Glob`/`Bash`-list
only; zero `Edit`/`Write` calls other than this document itself).*
