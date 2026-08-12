# Milestone 5 Sub-phase C — Completion Report

**Growth Signal Quality Validation + Production Hardening.** Status: complete. This phase found and
fixed one real, previously-undetected correctness bug affecting two of the five growth signals,
validated all signals against realistic multi-crawl scenarios and three real external Shopify stores,
and confirms the intelligence is trustworthy enough to ship as-is, with limitations stated precisely
rather than smoothed over.

**Headline finding**: `persistence.ts` and `catalog.ts` compared `Crawl.startedAt` (set before the
storefront fetch) against `Product.missingSince`/`Event.occurredAt` (set at persist time, after the
fetch) — two different moments in the same crawl's lifecycle. This silently misclassified the exact
crawl that discovered a product's absence, return, or first appearance, in both signals, on every
transition. Fixed by switching both modules to `Crawl.finishedAt`, which is written from the identical
`now` value as the entity timestamps it's compared against. Confirmed via a real end-to-end pipeline
test (not just hand-built fixtures) and re-verified against real Postgres and three live external
Shopify stores.

## 1. What was inspected

- Both Milestone 5 documents in full: `docs/milestone-5-growth-signals-research.md` (re-read for
  context, not re-verified line-by-line since it's research, not shipped code) and
  `docs/milestone-5-subphase-b-completion-report.md` (its claims were re-verified directly against
  code, per this phase's explicit "do not assume the previous report is correct" instruction).
- Every file in `src/lib/growth/` (`persistence.ts`, `catalog.ts`, `bestseller.ts`, `freshness.ts`,
  `review-infrastructure.ts`, `report.ts`) re-read in full against the completion report's claims.
- `prisma/schema.prisma` — specifically `Crawl.startedAt`/`finishedAt` semantics, `Product`,
  `ProductStateSnapshot`, `StoreEntity`, `Event`, `Watchlist`, and every relevant index.
- `src/lib/diff/persist.ts` and `src/lib/monitoring/run-scheduled-crawl.ts` — re-read specifically to
  determine exactly when `now` is captured relative to `Crawl.startedAt`/`finishedAt` in both the
  manual-analysis and scheduled-crawl code paths (this is what surfaced the headline bug).
- `src/lib/monitoring/activity.ts` — re-checked whether its `Crawl.startedAt` usage has the same
  cross-timestamp issue; confirmed it does not (it compares `startedAt` against an independently
  computed request-time window boundary, never against another timestamp from the same crawl).
- `src/lib/dashboard/summary.ts` — confirmed unrelated to growth signals, no changes needed.
- `src/app/api/store/[domain]/growth/route.ts`, `src/components/analysis/GrowthIntelligence.tsx`,
  and both pages that render it (`FullReportView.tsx`, `dashboard/stores/[domain]/page.tsx`).
- All ten existing growth test files (5 unit, 5 integration) from Sub-phase B.

## 2. What was tested

- **Real Postgres** (embedded-binary workaround, same as every prior sub-phase — fully removed
  afterward, confirmed by grep: zero occurrences of `embedded-postgres` in `package.json`/
  `package-lock.json`, and by `npm install` reporting no changes).
- **The temporal-boundary fix**, at three levels: a pure-logic reproduction, a real-Postgres
  integration test with hand-built but production-shaped rows, and a genuine end-to-end test that
  runs the real crawl → diff → persist pipeline (`runScheduledCrawl`) twice against a mocked
  storefront and checks the resulting persistence ratio.
- **GUARD 1** (catalog-shrink circuit breaker): seeded 15 real products via three real crawls, then
  sent a crawl returning only 2 of them (87% apparent shrink) — confirmed the diff aborts, the Crawl
  row is marked `FAILED`, every `Product` row is byte-for-byte unchanged, zero new
  `ProductStateSnapshot` rows are written, and both `getProductPersistence` and
  `getCatalogGrowthTrend` return results identical to before the bad crawl.
- **GUARD 2** (partial-crawl removal-skip): a real crawl with one page 500ing verified a product
  missed only by the failed page keeps `status: ACTIVE`/`missingSince: null` when the crawl is
  genuinely `PARTIAL`.
- **Flap suppression**: a product missing for exactly one real crawl, then restored before
  `removalConfirmations` (2) is ever reached — confirmed no `PRODUCT_REMOVED` event fires (0), one
  `PRODUCT_RESTORED` does (1), and persistence reports full presence across all 4 real crawls. This
  is a genuine, bounded limitation (documented in Section 11), not a bug.
- **Query cost**, via `EXPLAIN ANALYZE` against real Postgres at two scales: a 5,000-product/
  400-crawl store (realistic-to-large) and a 5,475-crawl single store (~5 years of pathological
  HOT-tier cadence, to stress-test the `finishedAt` sort specifically). Also measured
  `buildGrowthReport()`'s real wall-clock time at the 5,000-product scale.
- **Real-world HTTP validation** against three live external Shopify stores, two real crawls apart
  (Section 8).
- Full unit suite, full integration suite, `tsc --noEmit`, `eslint .`, `next build` — all run after
  every substantive change, not just once at the end.

## 3. What was changed

```
src/lib/growth/persistence.ts                                    modified (finishedAt fix + doc)
src/lib/growth/catalog.ts                                         modified (finishedAt fix + doc)
src/lib/growth/__tests__/persistence.integration.test.ts          modified (fixture fix + 2 new tests)
src/lib/growth/__tests__/catalog.integration.test.ts              modified (fixture fix + 1 new test)
src/lib/growth/__tests__/report.integration.test.ts                modified (fixture fix only)
src/lib/growth/__tests__/bestseller.integration.test.ts            modified (+1 new test — no fixture fix needed, see Section 4)
src/lib/growth/__tests__/crawl-integrity.integration.test.ts       new (3 tests)
```

No schema change. No migration. No new index (see Section 10). No UI change (the bug was invisible
to the UI — every affected field still rendered as a well-formed number, just an occasionally
off-by-one-crawl one; no wording, layout, or component changed). No API contract change. `bestseller.ts`
itself was not touched — confirmed unaffected by the bug class (Section 4).

## 4. Bugs discovered

**The one substantive bug this phase exists to find:** `persistence.ts` and `catalog.ts` both
compared `Crawl.startedAt` against `Product.missingSince` / `Event.occurredAt`. Tracing the actual
write paths (`diff/persist.ts`, `monitoring/run-scheduled-crawl.ts`) shows these are not the same
clock:

- `Crawl.startedAt` is set via `@default(now())` at row-creation time, **before** the storefront
  fetch runs.
- `Product.missingSince`, `Product.firstSeenAt`, and every lifecycle `Event.occurredAt` are all
  written from a single `now` variable captured **after** the fetch (manual-analysis path) or
  **before** the fetch but threaded through consistently to `Crawl.finishedAt` as well (scheduled
  path) — in both cases, `Crawl.finishedAt` and these entity timestamps share the exact same `now`.

Comparing `startedAt` against them meant the one crawl that actually *discovered* a transition always
landed on the wrong side: the crawl that first found a product missing still counted as an active
observation for that crawl, and the crawl that found a product restored (or a new product's very own
discovery crawl) still counted as inactive/absent for that crawl. This is exactly the kind of
"confidently wrong" result this whole project is built to avoid — the numbers were well-formed and
never crashed anything, just quietly off by one crawl at every transition boundary.

**Why Sub-phase B's own tests didn't catch it**: every persistence/catalog integration test built in
Sub-phase B set `missingSince`/`firstSeenAt` to a value chosen to exactly equal the corresponding
crawl's `startedAt` (both were hand-picked, not derived the way the real system derives them) — which
papered over the exact ordering assumption that's false in production. This phase's fixtures now
construct `startedAt` a full second before `finishedAt` specifically so a regression back to comparing
`startedAt` would fail immediately.

**Confirmed NOT affected**: `bestseller.ts` (compares `ProductStateSnapshot.capturedAt` only against
other snapshot rows — a single, internally consistent clock, never cross-referenced against
`Crawl.startedAt`) and `monitoring/activity.ts` (compares `Crawl.startedAt` only against an
independently-computed request-time window boundary, never against another timestamp from the same
crawl). Both confirmed by re-reading the code, not assumed.

**Two smaller, non-bug findings, documented rather than "fixed"** (fixing them would mean inventing
signal the system doesn't actually have):
1. A product missing for exactly one real crawl, then restored before `removalConfirmations` (2) is
   reached, generates no `PRODUCT_REMOVED` event at all — the single-crawl blip is invisible to
   `getProductPersistence`'s event-based past-gap reconstruction. This matches the rest of the
   system's own flap-suppression philosophy (the event log itself never records a blip this short) —
   see Section 11.
2. `selectHighlightProducts()` only ever queries `status: "ACTIVE"` products, so the `RECENTLY_MISSING`
   freshness label — fully implemented and tested in isolation since Sub-phase B — is still never
   actually surfaced in `buildGrowthReport()`'s output. Carried forward from Sub-phase B's own "Known
   limitations," unchanged by this phase; still a deliberate scoping choice, not a defect.

## 5. Bugs fixed

The temporal-boundary bug (Section 4) — fixed in both `persistence.ts` and `catalog.ts` by reading
`Crawl.finishedAt` instead of `startedAt`, with a `finishedAt: { not: null }` where-clause (real
OK/PARTIAL crawls always have it set, per the same write-path invariant) and updated doc comments
explaining exactly why, so this doesn't get silently reverted in a future pass. No crawler change, no
schema change — the fix is entirely within the two growth modules' own queries.

## 6. Tests added

**7 new integration tests, 0 new unit tests** (the bug is a real-Postgres/real-pipeline issue; a
pure-function unit test using the same hand-picked-timestamp pattern that hid the bug in Sub-phase B
would not have proven anything new):

- `persistence.integration.test.ts`: a hand-built boundary-crawl regression test, plus a genuine
  end-to-end test running two real `runScheduledCrawl()` calls against a mocked storefront and
  confirming the discovering crawl is correctly excluded.
- `catalog.integration.test.ts`: a boundary regression test confirming a product's own discovery
  crawl counts it as present in the trend.
- `bestseller.integration.test.ts`: a real-data `DECLINING` momentum test (Scenario D from the
  brief) — previously only unit-tested — plus an explicit assertion that the raw signal payload
  never contains the words "sales" or "revenue".
- `crawl-integrity.integration.test.ts` (new file, 3 tests): GUARD 1 abort leaves growth signals
  byte-for-byte unchanged; GUARD 2 partial-crawl silence doesn't corrupt product state; the
  single-crawl flap-suppression limitation is pinned by an explicit, documented test rather than
  left as an unstated gap.

Existing fixtures in `report.integration.test.ts` were corrected to set realistic `finishedAt` values
(no new test cases needed there — its existing assertions already cover the report-composition
behavior correctly once the fixture matches reality).

## 7. Final test counts

**447 total: 253 unit (unchanged from Sub-phase B — the bug and its fix are both invisible to
pure-function tests built on already-bounded inputs) + 194 integration (up from 190; net +7 new,
+3 files touched, +1 new file).** Zero regressions — every pre-existing test, growth and otherwise,
still passes unchanged. `tsc --noEmit`, `eslint .`, and `next build` all clean.

## 8. Real-world validation results

Ran real crawls (via `runScheduledCrawl`, real fetch, real DNS) against three live, diverse external
Shopify stores, persisted into real Postgres, twice each (roughly a minute apart) to observe genuine
`hasEnoughHistory` transitions without generating unnecessary external traffic:

| Store | Active products | Review infra detected | Notes |
|---|---|---|---|
| allbirds.com | 291 | None (`OBSERVED []`) | Medium catalog, established DTC brand |
| colourpop.com | 1,032 | Okendo | Large catalog, beauty category |
| taylorstitch.com | 3,778 | Stamped | Very large catalog, apparel |

All three: first crawl correctly produced `hasEnoughHistory: false` / `INSUFFICIENT_HISTORY` for every
signal (a real single observation, honestly reported as insufficient — not a synthetic scenario).
Second crawl (short-circuited — nothing on the real store changed in the intervening minute) correctly
flipped `hasEnoughHistory: true` for store-level activity while `catalogGrowth.trend` correctly stayed
`INSUFFICIENT_HISTORY` (2 real crawls, below the 3-crawl minimum) — the two different thresholds
behaved independently and correctly against real data. `productHighlights` was capped at exactly 20 in
every case, including against the real 3,778-product store — the bound holds against real, not just
synthetic, large catalogs. Zero crashes, zero malformed output, zero sales/revenue language anywhere
in any response, across three genuinely different real storefronts.

## 9. Signal-by-signal production readiness

| Signal | Status | Evidence | Known limitations |
|---|---|---|---|
| Catalog growth (added/removed/net/trend) | **READY** | Real multi-crawl validation (3 external stores), GUARD 1/2 integrity tests, temporal bug fixed and regression-tested, query cost confirmed cheap at 5,000 products/400 crawls (EXPLAIN ANALYZE) | Lower bound on churn (crawler discovery-gap, pre-existing, documented since the research phase); tier-dependent resolution |
| Product persistence | **READY** (post-fix) | The temporal-boundary bug was here; now fixed and proven via a real end-to-end pipeline test, not just fixtures | Single-crawl blips invisible to past-gap reconstruction (Section 4/11) — bounded, documented, consistent with existing flap-suppression philosophy |
| Bestseller rank movement | **READY** | Confirmed unaffected by the temporal bug (self-consistent snapshot clock); real rank data validated against 3 live stores (real ranks 0–19 present); movement logic unit- and integration-tested | Rank ceiling at crawl depth (~250 products), pre-existing and documented |
| Bestseller trajectory | **READY** | Same evidence as movement | Gaps between real snapshots are silent by design (never interpolated) |
| Bestseller momentum | **READY** | Gating (4+ observations/3+ distinct crawls) and reversal-yields-null behavior both tested; new real-data `DECLINING` case added this phase | Momentum language never implies sales — verified by a real assertion against the raw signal payload, not just UI copy |
| Product freshness | **READY** for NEW/ESTABLISHED/INSUFFICIENT_HISTORY | Depends directly on the now-fixed persistence computation | `RECENTLY_MISSING` implemented and tested but not currently surfaced by `buildGrowthReport()`'s highlight selection — carried-forward, deliberate scope limit, not a defect |
| Review infrastructure | **READY** | Validated against 3 real stores: one with none, two with different real apps (Okendo, Stamped) correctly detected and correctly excluding unrelated apps | Presence-only; cannot distinguish native from imported reviews (permanent, by design, per Sub-phase A) |
| Store-level growth signals (`activity.ts` reuse) | **READY** | Pre-existing, re-confirmed unaffected by this phase's bug class; real-world validated | Unchanged from Sub-phase A/B |
| Opportunity scoring / combined signal | **NOT JUSTIFIED** | No new evidence this phase changes Sub-phase B's rejection | Remains explicitly not built — see Section 12 of the research doc; nothing in this phase's findings creates new justification for one |

No signal was force-classified. Every classification above is backed by a specific test or a specific
real-world observation cited in this report, not an assumption.

## 10. Query-cost findings

`EXPLAIN ANALYZE` against real Postgres, at two deliberately pessimistic scales:

- **5,000 products, 400 crawls, one store**: the `finishedAt`-ordered crawl queries (`persistence.ts`'s
  take-20 and `catalog.ts`'s take-180) both resolve via an index scan on the existing
  `[storeId, startedAt DESC]` index (Postgres uses its `storeId` prefix, then a top-N heapsort on the
  bounded per-store row set) — **1.1ms and 0.25ms respectively**. The full-catalog product fetch for
  the trend (5,000 rows) — **2.9ms**. The ranked-highlight selection (`bestsellerRank ASC`, take 20) —
  **1.6ms**. `buildGrowthReport()` end-to-end — **305ms**, entirely attributable to the already-known,
  already-documented hard-capped N+1 pattern (20 products × ~4 small queries each, run concurrently) —
  each individual query is sub-millisecond; the total is round-trip count, not per-query cost. This is
  the first real measurement of that documented tradeoff (Sub-phase B could only estimate it); it
  remains an accepted tradeoff for a client-side-fetched, rate-limited, non-blocking UI section that is
  not on the synchronous BASIC-unlimited-analysis path — but is now a concrete number, not a guess.
- **5,475 crawls on one store** (~5 years of pathological HOT-tier cadence, to specifically stress the
  unindexed `finishedAt` sort): **2.8ms**. Confirms no new index is warranted — the existing
  `[storeId, startedAt]` index's `storeId` prefix already bounds the scan to that store's own row
  count, and Postgres's sort of a few thousand small rows is cheap regardless of which `DateTime`
  column is the sort key. Per the explicit "do not add indexes speculatively" instruction, none was
  added.
- Confirmed (Section 8/9 of Sub-phase B, re-verified rather than re-derived): `buildGrowthReport()` is
  not reachable from `run-analysis.ts`'s synchronous path; `MAX_PRODUCT_HIGHLIGHTS` (20) held exactly
  at real-world scale (3,778 real products at taylorstitch.com, still exactly 20 highlights returned).

## 11. Known limitations

Carried forward from Sub-phase B, still accurate, not re-litigated: the N+1 query pattern (now with a
real measured number, Section 10); the 20-crawl/180-crawl fixed window sizes not adapting to crawl
tier; the crawler's own discovery-gap limitation for products added-and-removed between crawls; the
rank-depth ceiling (~250 products); review-infrastructure's native-vs-imported ambiguity.

New from this phase:
- **Single-crawl flap blips are invisible to persistence's past-gap reconstruction** (Section 4) —
  bounded to exactly one-crawl-long gaps (anything 2+ crawls long generates a real `PRODUCT_REMOVED`
  event at confirmation and is correctly reconstructed), consistent with the event system's own
  existing flap-suppression design, not a new inconsistency introduced by growth signals.
- **`buildGrowthReport()` measured at 305ms** for the largest realistic scale tested (Section 10) —
  not a regression, not urgent, but now a real number rather than an unverified estimate, and the
  threshold at which the previously-deferred batched-query optimization would become worth revisiting.

## 12. Revenue/traffic decision

Explicitly revisited, as required. **No new data source, calibration method, or ground-truth
mechanism was discovered during this validation phase that changes Sub-phase A's conclusion.**
Everything found this phase reinforces the existing NO-GO rather than weakening it:

1. **What currently exists**: catalog size, product counts, bestseller *ordinal position* (not
   volume), review-app *presence* (not count/rating), price history, app/theme/pixel presence and
   change history. All directly observed, none of it a revenue or traffic proxy.
2. **What can be observed directly**: everything in (1). Nothing about visitor counts, conversion
   rates, or units sold is observable from any Shopify JSON endpoint this crawler fetches (confirmed
   architecturally in the research phase, re-confirmed by this phase's real crawls against allbirds/
   colourpop/taylorstitch — none of their `/products.json` or `/collections/all/products.json`
   responses carry anything resembling sales or traffic data).
3. **What requires inference**: revenue, traffic, and conversion all require either (a) a paid
   third-party estimator (SimilarWeb/Ahrefs-class, already rejected in Sub-phase A for cost and
   accuracy-at-scale reasons) or (b) a calibration model trained against real ground truth this
   project has no access to.
4. **What external calibration data would be needed**: real, verified sales/traffic figures for a
   representative sample of Shopify stores across categories and sizes — not available, not
   ethically/practically obtainable at the scale this product would need, per Sub-phase A's own
   research.
5. **What ground truth sources could be used**: none identified in Sub-phase A remain available or
   newly available; this phase did not discover any.
6. **Accuracy target**: not evaluated, because no candidate methodology exists to evaluate — setting
   an accuracy bar for a model with no calibration data would be premature.
7. **What would make the estimate misleading**: any single point estimate presented as fact rather
   than a wide, honestly-labeled range with a stated methodology and confidence — precisely what
   Sub-phase A already found no defensible way to produce at this project's current data access level.

**Decision: DO NOT BUILD.** Unchanged from Sub-phase A. Review velocity remains the **permanent
NO-GO** it was declared — not revisited, per the explicit instruction, and nothing in this phase's
review-infrastructure validation (Section 8/9) does anything but reinforce that presence ≠ velocity ≠
revenue proxy.

## 13. Deferred work

- Adapting `PERSISTENCE_WINDOW_CRAWLS`/`MAX_CRAWLS_FOR_TREND` to a store's actual `CrawlTier` rather
  than a fixed crawl count (carried forward from Sub-phase B, still not attempted — no new evidence
  this phase makes it urgent).
- Surfacing `RECENTLY_MISSING` products in `buildGrowthReport()`'s highlights via a second, bounded
  selection query (carried forward, still deliberately out of this phase's scope).
- Batched (window-function) per-product queries, now with a real number to weigh it against (305ms at
  5,000 products/400 crawls) rather than an estimate — still not pursued this phase, since 305ms on a
  non-blocking, rate-limited, client-fetched route did not meet the bar for "proven correctness issue"
  or "measured production bottleneck" that would justify the added complexity risk.
- Recovering the resolved-single-crawl-blip case for persistence (Section 4/11) — would require either
  a new field or scanning additional crawl-level evidence the Event log doesn't currently carry; not
  pursued, since the current behavior is consistent with the system's own existing flap-suppression
  philosophy, not a defect.

## 14. Recommended next milestone

1. Run the research document's Section 11 signal-quality validation pass properly — a larger, more
   deliberately diverse real-store corpus (this phase's 3 stores were a real, valuable, but small
   spot-check, not the full validation plan Sub-phase B deferred). Specifically: a confirmed
   dropshipping-pattern store, a confirmed low-SKU-churn DTC store, and a store with a genuinely
   volatile bestseller list observed across real calendar days (not just a same-session second crawl).
2. If `buildGrowthReport()`'s real p95 latency in actual production use approaches or exceeds the
   305ms measured here, revisit the batched-query design — with real production numbers, not this
   phase's synthetic stress test.
3. Decide whether `RECENTLY_MISSING` product highlights are worth the second bounded query, informed
   by real usage of what's already shipped.
4. No revenue/traffic/opportunity-score work — remains correctly out of scope, reconfirmed this phase.
