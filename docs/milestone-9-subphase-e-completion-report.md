# Milestone 9, Sub-phase E — Storefront JSON-LD Review Observation (Implementation)

## 1. Status

**COMPLETE.** A bounded, provider-aware, per-product storefront JSON-LD review-count observation system is implemented, tested (unit + integration + live), and wired into the existing crawl/report/UI pipeline. Revenue/sales inference was not introduced anywhere. No private review-provider API was called anywhere.

## 2. Objective

Implement — for the first time, after three prior research/validation sub-phases (A: provider API research, B: blocked by Okendo's ToS, C/D: JSON-LD validation, CONDITIONAL GO) — a production feature that answers *"does this product's publicly rendered storefront markup expose an observed review count?"*, never *"how many reviews does this store have"* or anything sales/revenue-related.

## 3. Scope

Exactly the 10 items listed in the brief's Strict Scope section: JSON-LD extraction, structural-shape support (Product/ProductGroup/nested AggregateRating/string+numeric reviewCount), bounded sampling, provider-aware prioritization, persistence, historical comparison, UI presentation, variant/shared-count handling, tests, documentation. Nothing else.

## 4. Explicit non-goals

Not implemented, not attempted, not discussed as a live option: any review-provider API call (Okendo/Judge.me/Stamped/Yotpo/Loox); review text/author/individual-timestamp collection; review sentiment; review velocity; revenue/sales/traffic estimation; ad intelligence of any kind; inventory-quantity probing; cart manipulation; a new browser-automation *production* dependency; Python; a new backend service, queue, or Redis; a new crawler architecture; any entitlement/pricing change.

## 5. Research assumptions carried forward

From Sub-phases A–D, treated as settled and not re-litigated: Okendo's technically-public API remains ToS-blocked (Sub-phase B); storefront JSON-LD is the only currently-viable source; real-world adoption is materially partial (Sub-phase D: 27% product-level, 39% store-level across 23 genuinely new stores) and correlates strongly with detected provider (Okendo-detected stores: 100% store-level adoption in that sample; Judge.me: near-zero); sibling product-group/variant listings can share one non-independent count (confirmed on 3 of 9 adopting stores in Sub-phase D); client-side rendering is a real, minority (not dominant) cause of false negatives.

## 6. Files inspected

Prior to any code change: `prisma/schema.prisma` (full), `src/lib/analysis/report-contract.ts`, `src/lib/crawl/{shopify,normalize,types,fingerprint}.ts`, `src/lib/growth/{bestseller,report,review-infrastructure}.ts`, `src/lib/intelligence/{report,types}.ts`, `src/lib/analysis/run-analysis.ts`, `src/lib/monitoring/run-scheduled-crawl.ts`, `src/lib/enrichment/domain-age.ts` (the exact "best-effort, post-persist enrichment" pattern this feature reuses), `src/components/dashboard/IntelligenceCard.tsx`, `src/components/analysis/GrowthIntelligence.tsx` (full), `src/lib/growth/__tests__/bestseller.test.ts` and `growth/__tests__/composition.integration.test.ts` (test-style precedent), `prisma/migrations/` (full listing, plus the most recent migration's SQL for style), `docs/milestone-9-*.md` (all four prior sub-phase documents), `docs/milestone-9-subphase-d-completion-report.md`.

## 7. Files changed

**Modified (existing files):**
- `prisma/schema.prisma` — added `StorefrontReviewObservation` model + 2 relation fields (`Product.reviewObservations`, `Crawl.reviewObservations`).
- `src/lib/crawl/shopify.ts` — added `fetchProductPageHtml()` + supporting types, reusing the file's own private `fetchWithTimeout`/`readBodyWithLimit`/SSRF-guard machinery. No existing function changed.
- `src/lib/growth/report.ts` — `ProductHighlight` gained `reviewObservation`; `GrowthReport` gained `reviewCoverage`; `buildGrowthReport()` now also calls `getReviewObservationSignal()`/`getReviewCoverageSummary()` in its existing `Promise.all` fan-outs.
- `src/lib/intelligence/types.ts` — `ReviewsSection` gained `coverage: ReviewCoverageSummary` (new field, additive only — `velocity` untouched).
- `src/lib/intelligence/report.ts` — composer passes `growth.reviewCoverage` through to `reviews.coverage`. One line added.
- `src/lib/analysis/run-analysis.ts` — added a second best-effort, try/catch-wrapped call (`collectStorefrontReviewObservations`) right after the existing `enrichDomainAgeIfUnknown` call.
- `src/lib/monitoring/run-scheduled-crawl.ts` — same addition, same position, same pattern.
- `src/components/analysis/GrowthIntelligence.tsx` — added client-side type mirrors (`ReviewObservationSignal`, `ReviewCoverageSummary`), a new "Review intelligence" section (`ReviewCoverageCard`), and per-product review rendering inside `ProductHighlightRow` (`ReviewObservationRow`). No existing visual element removed or restyled.

**New files (production code):**
- `src/lib/reviews/jsonld-parser.ts` — pure JSON-LD parser (`extractReviewObservation`).
- `src/lib/reviews/sampling.ts` — bounded, provider-aware candidate selection (`selectReviewSampleCandidates`, `chooseReviewBudget`).
- `src/lib/reviews/collect.ts` — orchestration (`collectStorefrontReviewObservations`, `fetchAndParseCandidate`, `detectSharedCounts`).
- `src/lib/reviews/signal.ts` — read-time signal computation (`getReviewObservationSignal`, `computeReviewObservationSignal`, `getReviewCoverageSummary`).

**New files (tests):**
- `src/lib/reviews/__tests__/jsonld-parser.test.ts` (20 tests)
- `src/lib/reviews/__tests__/sampling.test.ts` (4 tests)
- `src/lib/reviews/__tests__/collect.test.ts` (8 tests)
- `src/lib/reviews/__tests__/signal.test.ts` (10 tests)
- `src/lib/reviews/__tests__/collect.integration.test.ts` (7 tests, real Postgres)
- `src/lib/reviews/__tests__/signal.integration.test.ts` (8 tests, real Postgres)

**New migration:**
- `prisma/migrations/20260813102050_storefront_review_observation/migration.sql`

**Deleted:** none.

## 8. Files deleted

None.

## 9. Parser architecture

`src/lib/reviews/jsonld-parser.ts`'s `extractReviewObservation(html, {handle})` is a PURE function (no I/O). It extracts every `<script type="application/ld+json">` block via regex, `JSON.parse`s each individually (a malformed block is caught and skipped — never aborts the others), then recursively walks the entire parsed tree (arrays, `@graph`, arbitrary nesting) collecting every `Product`/`ProductGroup`-typed node and every `aggregateRating` object found anywhere, regardless of shape. This directly avoids reproducing the exact bug Sub-phase C's own research tooling hit (a shallow, single-shape parser silently undercounting real data) — see Section 29.

Returns one of four states: `PRESENT` (usable count), `PRESENT_BUT_INVALID` (rating found, count missing/non-numeric/negative/fractional), `ABSENT` (no usable data, confidently — including "found a rating but it's unrelated to this product," e.g. an Organization-wide trust score), `AMBIGUOUS` (genuinely can't tell — multiple candidate products/ratings, none confidently matched by URL, or every ld+json block failed to parse).

## 10. JSON-LD shapes supported

All eight structural cases the brief listed, each with a passing unit test, all confirmed against REAL shapes seen in Sub-phase C/D live research (not hypothetical): `Product`; `ProductGroup`; nested `Product` under `ProductGroup.hasVariant`; `AggregateRating` nested under `Product`; under `ProductGroup`; a bare `{aggregateRating:{itemReviewed:Product}}` node with no `@type` of its own (confirmed live on allbirds.com in Sub-phase C); `@graph` arrays; top-level JSON-LD arrays; multiple `<script>` blocks per page; `reviewCount` as a string (the empirically majority real-world case — 74% in Sub-phase D) and as a number.

## 11. Product identity matching

Never blindly accepts the first `AggregateRating` found. Builds each candidate rating's identity context from its own `url`/`@id`/`offers[].url` fields (and, for the inverted shape, its `itemReviewed`'s same fields), compares against the expected `/products/{handle}` path (case-insensitive, query-string-tolerant, relative-URL-tolerant). Exactly one URL match → confident. Multiple URL matches → first, deterministic, still confident (same identity). No URL match at all → falls back to "exactly one rating, explicitly tied to a Product/ProductGroup (not an off-topic Organization rating), at most one product node on the page" as the only safe unambiguous case; anything more ambiguous than that returns `AMBIGUOUS`, never a guess (unit-tested: Section 17, tests 13–15).

## 12. Sampling strategy

`src/lib/reviews/sampling.ts`'s `selectReviewSampleCandidates()` deliberately mirrors `growth/report.ts`'s existing `selectHighlightProducts()` — "ranked bestsellers first (by `Product.bestsellerRank`), then most-recently-seen fill the remaining slots" — rather than inventing a second selection strategy, per the brief's own explicit instruction to reuse the already-shipped bestseller set. Detects the store's review-app providers via `StoreEntity` (kind=APP, key in the existing `REVIEW_APP_KEYS`, reused directly from `review-infrastructure.ts` — no duplicated list).

## 13. Provider-aware prioritization

`MAX_REVIEW_OBSERVATION_PRODUCTS = 20` when any review provider is detected (matches the brief's own suggested default exactly); `MAX_REVIEW_OBSERVATION_PRODUCTS_NO_PROVIDER = 5` — smaller, deliberately never zero — when none is detected. This is a real, evidence-grounded decision, not arbitrary: Sub-phase D found 100% store-level adoption on Okendo-detected stores vs. 16.7% on no-provider stores, but also one real, unexplained positive outlier (tarte.com, no detected provider, 100% product-level adoption) — hard-skipping no-provider stores would make outliers like that permanently invisible. Provider detection is explicitly a budget hint only, never a gate — every candidate is still fetched from public storefront HTML regardless of detected provider, and the detected provider (if any) is attached to each observation purely as attribution context (`provider` column), never as a claim about where the count actually came from.

## 14. Hard request cap

Enforced by construction: `selectReviewSampleCandidates()` never returns more than `budget` candidates (`take: budget` in both its Prisma queries), and `collectStorefrontReviewObservations()` iterates only over the returned candidate list — there is no code path that can fetch more than 20 product pages in one collection run, regardless of real catalog size. Verified live: Section 22.

## 15. Persistence strategy

New table `StorefrontReviewObservation`, deliberately NOT merged into `ProductStateSnapshot` — documented reasoning in the schema comment and Section 16 below. One row per `(productId, crawlId)` (enforced by a real unique constraint, upserted so a re-run is idempotent, verified in `collect.integration.test.ts`). `reviewCount: Int?` — `null` means "this product's page was fetched and read this crawl, but no usable count was found," a real, intentional, distinct value from both "never sampled" (no row at all) and a genuine `0`.

## 16. Migration details

`prisma/migrations/20260813102050_storefront_review_observation/migration.sql` — one `CREATE TABLE`, two `CREATE INDEX` (one unique on `(productId, crawlId)`, one on `(productId, observedAt DESC)`), two `ADD CONSTRAINT` foreign keys (`ON DELETE CASCADE`). **Zero `ALTER TABLE` on any existing table.** Reuse of `ProductStateSnapshot`/`Event` was considered and rejected: `ProductStateSnapshot` is written for every ACTIVE product on every crawl with a detected change (a fundamentally different, full-catalog cadence); this feature writes only for a small, bounded, sampled subset regardless of whether anything "changed" — merging them would leave most `ProductStateSnapshot` rows carrying null review fields, or force review sampling onto a change-detection cadence it has no relationship to. Verified via `prisma migrate dev` (creates + applies against a fresh disposable Postgres) AND separately via `prisma migrate deploy` (the real production command) against a second fresh database — both succeeded cleanly.

## 17. Tests

**Unit — 42 new tests**, all passing: 20 parser-shape tests (Section 10/Section 17's items 1–15, plus 5 extra: relative-URL resolution, no-ld+json, no-aggregateRating, pathological self-referential input, double-check on malformed-block resilience), 4 sampling-budget tests (items 16–19), 8 collect/fetch-outcome + shared-count tests (covers items 20 partially and the "never a fabricated absence on fetch failure" requirement), 10 signal/history tests (items 21–30, including the explicit "missing prior observation never becomes a fabricated 0→N delta" case and the "null in between doesn't break the delta search" case).

**Integration — 15 new tests, real Postgres**: `collect.integration.test.ts` (7 — real persistence, real null-row vs. no-row distinction, real idempotent upsert, real provider-aware budget read from a real `StoreEntity` row, real shared-count detection across a real batch, safe no-op on zero candidates) and `signal.integration.test.ts` (8 — real NOT_SAMPLED/OBSERVED/UNSUPPORTED states from real rows, a real cross-crawl delta, a real proof that an older crawl's rows never leak into the latest-crawl coverage count).

**Regression (item 37 — the Sub-phase C ProductGroup/nested-AggregateRating bug)**: covered directly in `jsonld-parser.test.ts` tests 2/3/15 (ProductGroup, the bare-itemReviewed inversion, and `hasVariant` nesting) — a pure-parsing concern, correctly unit-tested rather than requiring a DB round-trip to exercise.

**Full-suite regression**: every pre-existing unit (310) and integration (220) test still passes unmodified — 352 unit / 235 integration total after this sub-phase's additions.

Item 32–36 (full analyze flow / scheduler flow / composer integration / authorization / entitlement boundary) were verified as **regression checks against the existing, still-passing integration suite** rather than new bespoke tests: `run-analysis.integration.test.ts` and `run-scheduled-crawl.integration.test.ts` exercise the full crawl flow with my new best-effort call now live inside it and still pass; `intelligence/report.integration.test.ts` ("composes every section from real, independently-seeded data") still passes with the new `reviews.coverage` field present; `entitlements/analysis-usage.integration.test.ts` and `entitlements/plan-limits.test.ts` are unmodified and still pass, confirming no entitlement regression (Section 20/34 below — none was expected, since nothing entitlement-related was touched).

## 18. Real Postgres verification

**VERIFIED.** `prisma migrate dev` and `prisma migrate deploy` both succeeded against fresh disposable Postgres instances (see Section 16). Full unit (352) and integration (235) suites passed against a real, UTF8-initialized disposable Postgres. One real, pre-existing environment issue was hit and fixed along the way — see Section 29.

## 19. Real Shopify verification

**VERIFIED — live, using the actual production functions, not a standalone script.** A temporary script imported and called the real `collectStorefrontReviewObservations()` directly against real Postgres and the real internet, over 5 real stores (all previously used in this project's validation history), one per Step-18-required category:

| Store | Category | Products sampled | Observed | Notes |
|---|---|---|---|---|
| colourpop.com | Okendo-detected | 5 | 3 | Real counts (10,412 × 3, matching Sub-phase C/D's own earlier finding) |
| snowehome.com | Judge.me-detected | 5 | 0 | Consistent with Sub-phase D's near-zero Judge.me correlation |
| rothys.com | Yotpo-detected | 5 | 5 | **Live-reconfirmed the exact Sub-phase D shared-count finding**: 3 "Max Square Mary Jane" colorways all reported 1,626 and were correctly flagged `sharedWithGroup: true`; the two genuinely distinct products (6,650 and 1,253) were correctly flagged `false` |
| blume.com | No provider detected | 5 | 0 | Consistent with Sub-phase D's confirmed finding that blume.com's review data is client-side-rendered, invisible to this (deliberately server-HTML-only) collector |
| fashionnova.com | Large catalog | 5 | 0 | — |

30 real HTTP requests total across this pass, all read-only, all against each store's own domain, zero third-party review-API calls, zero review text collected.

## 20. Request-count measurements

Every collection run in Section 19 fetched exactly as many product pages as candidates were seeded (5 each) — never more, confirming the hard cap (Section 14) holds under real conditions. Real elapsed time per store: 3.9–9.9 seconds for 5 sequential product-page fetches including the 250ms politeness delay between each (matching `crawl/shopify.ts`'s own `requestDelayMs` default) — consistent with, not worse than, Sub-phase D's own cost model.

## 21. Performance measurements

Parser runtime: sub-millisecond per page in all unit tests (pure, in-memory, no I/O). Composer/report runtime: `buildGrowthReport()`'s existing bounded fan-out pattern was extended, not restructured — `getReviewObservationSignal`/`getReviewCoverageSummary` add at most `MAX_PRODUCT_HIGHLIGHTS` (20) additional bounded, indexed queries per report build, run inside the same existing `Promise.all` concurrency, not serially. No N+1 pattern was introduced. Database query cost: every new query is either indexed by an existing index (`Crawl(storeId, startedAt DESC)`, reused for `getReviewCoverageSummary`) or a new dedicated one (`StorefrontReviewObservation(productId, observedAt DESC)`), and every result set is bounded by construction (≤10 rows per product history read, ≤20 rows per crawl's coverage read) — never a full-table scan. `EXPLAIN ANALYZE` was not separately run this pass (the brief's Sub-phase D companion, not this one, specified that requirement for the JSON-LD *validation* queries; this sub-phase's new queries are structurally identical in shape to `bestseller.ts`'s and `activity.ts`'s already-shipped, already-bounded query patterns) — flagged honestly as **NOT SEPARATELY VERIFIED**, not claimed.

## 22. Security/SSRF verification

**VERIFIED.** `fetchProductPageHtml()` is implemented inside `crawl/shopify.ts` specifically so it can call the file's own private `fetchWithTimeout` (which re-runs `checkUrlIsSafeToFetch` on every redirect hop, including the first) and `readBodyWithLimit` (same streamed 10MB cap) directly — no second HTTP client, no second SSRF layer, no weakened check anywhere. The only externally-influenced input to a URL is the product `handle`, which is `encodeURIComponent`-escaped into a path segment on an already-known, already-validated store domain — never used to construct a hostname or a redirect target. No credential, API key, or authentication header is used or stored anywhere in this feature (there is none to use — every request is a plain unauthenticated GET).

## 23. ToS/compliance boundary

Every request this feature makes is an ordinary, unauthenticated `GET` to a merchant's own public storefront HTML (`{domain}/products/{handle}`) — the same request any shopper's browser or a search-engine crawler makes, and the same category of request this project's existing crawler already makes routinely to the same domain. No review-provider's API, undocumented endpoint, or authentication mechanism is touched anywhere in this implementation, preserving the exact boundary Sub-phase B's ToS finding turned on.

## 24. Bugs found

Three, all caught and fixed during this same development pass, none shipped:
1. **Parser design gap** (caught while writing unit test 13, before any DB work): an early version would have misattributed an unrelated Organization-level `aggregateRating` (e.g., a store-wide trust score) to the product being checked, if it were the only rating on a page. Fixed by requiring explicit `Product`/`ProductGroup` type-attribution for the no-URL-evidence fallback case (Section 11).
2. **My own test's wrong assumption**, not a code bug: `collect.integration.test.ts`'s provider-budget test originally asserted 8 sampled products for a no-provider store, not realizing the no-provider budget (5) is smaller than the 8 seeded products. Caught immediately on first run; fixed by correcting the test's expected value, not the code.
3. **Self-inflicted test-file edit error**: an `Edit` tool call meant to insert new content above the `candidate()` helper function in `collect.test.ts` accidentally deleted it (an imprecise `old_string`/`new_string` pair). Caught immediately via the resulting test failures; the helper was restored in the next edit.

## 25. Bugs fixed

All three items in Section 24 were fixed within this same sub-phase, before any test suite was reported as passing.

## 26. Known limitations

- Client-side-rendered review data (Sub-phase D found this affects a real, minority share of otherwise-`ABSENT` products) remains invisible to this collector by design (Step 6's explicit "do not require browser rendering in production").
- Coverage percentages will vary store-to-store exactly as Sub-phase D's research predicted — this is expected, not a defect.
- The shared-count detection (Section 13/Step 7) is a same-crawl, same-value heuristic, not a structural/guaranteed relationship — it can theoretically both under-flag (two genuinely independent products that happen to share a count by coincidence, extremely unlikely at real review-count magnitudes) and, in principle, over-flag nothing since it only compares real observed values, never assumed ones.
- No `EXPLAIN ANALYZE` was run against production-scale data volumes this pass (Section 21).
- No interactive, authenticated browser screenshot of the rendered Store Intelligence page was captured this pass — see Section 32.

## 27. Deferred work

Everything the brief explicitly listed as out of scope (Section 4) remains deferred, unchanged. Additionally deferred, not attempted: `EXPLAIN ANALYZE` at production data volumes; a full authenticated browser click-through; any decision about whether/how to surface `sharedWithGroup` more prominently than the current per-product note.

## 28. Explicit non-goals (confirmation)

Reconfirmed, not merely restated: this implementation never computes a rate, a per-time-period figure, or anything resembling "reviews/month." `computeReviewObservationSignal()`'s only arithmetic is a single subtraction between two real observed counts (`delta`), and that value is never divided by a time interval anywhere in this codebase's new code.

## 29. Bugs/quirks found in the *environment*, not the code

While bringing up a fresh disposable Postgres for this sub-phase's migration/integration testing, the instance auto-detected the host's Windows locale and initialized with `WIN1252` encoding rather than UTF8, causing 7 genuinely pre-existing (not introduced by this sub-phase) integration tests to fail on a real `→` (U+2192) character inside an existing bestseller-rank event headline (`character with byte sequence 0xe2 0x86 0x92 ... has no equivalent in encoding "WIN1252"`). This is an infrastructure artifact of `embedded-postgres`'s own locale auto-detection, not a code defect — fixed by re-initializing with explicit `initdbFlags: ["--encoding=UTF8", "--locale=C"]`, after which all 220 pre-existing integration tests passed cleanly. Documented here because it's a real, reproducible gotcha worth remembering for future disposable-Postgres setups on this machine, not because it reflects on this sub-phase's own code.

## 30. Final decision

Not applicable in the Sub-phase D "GO/CONDITIONAL GO" sense — this sub-phase was an authorized implementation, not a fresh evidence-driven gate decision. The feature was built exactly to the CONDITIONAL GO's own stated condition (Sub-phase D, Section 34): provider-aware targeted sampling, strict per-product semantics, explicit shared-count handling, no store-wide totals anywhere.

## 31. Recommendation for Sub-phase F

If a Sub-phase F is authorized: (1) run `EXPLAIN ANALYZE` against a realistically-populated store (hundreds of products, dozens of crawls) to close the one performance gap explicitly flagged as unverified in Section 21; (2) capture a real authenticated browser screenshot pass (desktop + mobile) of the Store Intelligence page, closing Section 26/32's gap; (3) consider — as a product decision, not an engineering one — whether `sharedWithGroup` should eventually suppress duplicate rows in the product-highlight list rather than just annotating them; (4) revisit Judge.me/Stamped/Loox coverage only if a genuinely new, ToS-clean access path is ever found (none is proposed here). Revenue/sales inference remains untouched and should not be revisited without a real calibration dataset, which still does not exist.

## 32. Browser verification

**PARTIALLY VERIFIED, stated honestly.** A real Next.js dev server was started against the same disposable Postgres used for integration testing, and the real `GET /api/store/[domain]/growth` route was hit directly (not mocked) for a store seeded via the Section 19 live-validation run — confirmed HTTP 200 with the exact expected shape: `reviewCoverage: {status:"OBSERVED", sampledCount:5, observedCount:5}`, and each of rothys.com's 5 product highlights carrying the correct real `reviewObservation` (including the 3 shared-count Mary Jane colorways all correctly flagged `sharedWithGroup:true`, and the 2 independent products correctly flagged `false`) — a genuine, real, end-to-end confirmation of the full server-side pipeline (collector → database → composer → API route → JSON) using real data, not a fixture. **What was NOT done**: an authenticated, interactive, visual browser session (screenshot) of the actual rendered React component on the dashboard Store Intelligence page — this requires a real user/session, and was not completed this pass given time constraints. This gap is stated explicitly rather than glossed over; the production build (Section 33) does confirm the component compiles and type-checks correctly, which is a real but different form of verification than a visual render check.

## 33. Final verification suite

- **Unit tests**: 352/352 passing (310 pre-existing + 42 new), zero regressions.
- **Integration tests**: 235/235 passing (220 pre-existing + 15 new) against real Postgres, zero regressions.
- **Typecheck** (`tsc --noEmit`): clean, zero errors.
- **Lint** (`eslint .`): clean, zero errors/warnings beyond one pre-existing-style Tailwind-canonicalization hint matching the file's own established convention (not a new issue).
- **Production build** (`next build`): succeeded cleanly, all 18 routes (12 static/dynamic pages, 6+ API routes) compiled and generated with no errors.
- **Migration**: verified via both `prisma migrate dev` (creates + applies) and `prisma migrate deploy` (the real production command) against independent fresh databases.
- **Live Shopify verification**: Section 19.
- **API-route end-to-end verification with real data**: Section 32.
- **Interactive browser screenshot**: not completed — Section 32.

## 34. Regression confirmation

No regression in: signup/login/logout (auth integration tests unmodified, still passing), analysis (`run-analysis.integration.test.ts` passing with the new best-effort call live), monitoring/scheduler (`run-scheduled-crawl.integration.test.ts`, `scheduler.integration.test.ts` passing), dashboard (`dashboard-route.integration.test.ts` passing), Store Intelligence (`report.integration.test.ts`, `full-store-report.integration.test.ts` passing), existing growth signals (`growth/report.integration.test.ts`, `catalog.integration.test.ts`, `bestseller.integration.test.ts` all passing unmodified), marketing intelligence (all `marketing/*.integration.test.ts` passing, untouched by this sub-phase), entitlements (`analysis-usage.integration.test.ts`, `plan-limits.test.ts` passing, untouched — no entitlement code was modified, per Step 15).

## 35. STOP-condition evaluation

None of the ten STOP conditions were triggered: no evidence required bypassing access controls; no third-party endpoint was ever needed; no aggressive crawling occurred at any point (bounded by construction, real request counts documented in Section 20); no signal was found to be materially misleading once per-product/shared-count semantics are respected (Sections 13/15); production request cost stayed within the ranges Sub-phase D's own cost model predicted; adoption rate, while partial, is not so low that the provider-aware-targeted implementation is all complexity and no value (Section 19's live rothys.com/colourpop.com results are real, correct, and useful); no new schema design beyond the single minimal table was required (Section 16); no revenue/sales inference was ever produced; the existing crawler architecture safely supported the bounded sample with zero SSRF/timeout/size-cap issues across every real request made this sub-phase (Sections 19, 22); the migration is a single small additive table, not a large or speculative schema change.

## 36. Final conclusion

Every piece of this feature — parser, sampler, collector, signal computation, persistence, UI — was built to reuse existing architecture rather than create parallel infrastructure (the existing SSRF/fetch machinery, the existing bestseller-selection pattern, the existing best-effort-enrichment pattern, the existing epistemic-status/report-composition pattern, the existing Fable visual language). It was verified at every level this sub-phase's time allowed: pure-function unit tests against real-world-shaped fixtures, real-Postgres integration tests, a live run of the actual production collector against 5 real stores that re-confirmed prior research findings (including the exact shared-count pattern on rothys.com), and a real end-to-end API-route check with real persisted data. The one gap knowingly left open — an interactive authenticated browser screenshot — is stated as such, not concealed. No revenue, sales, or velocity claim exists anywhere in this implementation; every number shown is a directly observed count, a directly observed rating, or a simple delta between two directly observed counts.

---

## Final summary block

```
STATUS: COMPLETE

PRODUCTION CODE CHANGED: YES (see Section 7)
SCHEMA CHANGED: YES — one new additive table, zero ALTER on existing tables (Section 16)
DEPENDENCIES CHANGED: NO (package.json/package-lock.json diff unchanged from before this sub-phase)
FABLE UI CHANGED: NO redesign — new content added inside existing card/section patterns only (Section 7)

FILES CHANGED: 8 modified, 10 new (4 production modules + 6 test files), 1 migration
TESTS: 352/352 unit, 235/235 integration — zero regressions
TYPECHECK/LINT/BUILD: all clean

REAL SHOPIFY VALIDATION: 5 stores, 30 real requests, real results matching prior research
  (Section 19)
REAL API END-TO-END CHECK: verified with real persisted data (Section 32)
INTERACTIVE BROWSER SCREENSHOT: NOT completed — explicit, stated gap (Section 32)

PRIVATE REVIEW-PROVIDER API ACCESS: NONE — confirmed by code inspection (every fetch target
  is the merchant's own storefront domain) and by the live validation run's real network log

REVENUE/SALES INFERENCE: NONE INTRODUCED — confirmed by code inspection (Section 28); the only
  arithmetic anywhere in this feature is a single subtraction between two observed counts

RECOMMENDATION FOR SUB-PHASE F: EXPLAIN ANALYZE at production scale, a real authenticated
  browser screenshot pass, and — as a product decision only — whether to visually de-duplicate
  shared-count product rows. Revenue/sales inference remains untouched and not recommended.
```
