# Milestone 5 Sub-phase B — Completion Report

**Growth Signals & Ordinal Bestseller Intelligence.** Status: complete. Built strictly from
`docs/milestone-5-growth-signals-research.md`'s findings and, wherever the research showed a
capability was already partially shipped (store-level growth, bestseller events, review-app
detection), extended it rather than rebuilding it. No revenue, no traffic, no opportunity score, no
per-collection product mapping, no Fable redesign, no new entitlement gate.

## 1. Files changed

```
prisma/schema.prisma                                                    modified (+1 index)
prisma/migrations/20260811230000_growth_signals_event_index/            new
src/lib/growth/persistence.ts                                           new
src/lib/growth/catalog.ts                                               new
src/lib/growth/bestseller.ts                                            new
src/lib/growth/review-infrastructure.ts                                 new
src/lib/growth/freshness.ts                                             new
src/lib/growth/report.ts                                                new
src/app/api/store/[domain]/growth/route.ts                              new
src/components/analysis/GrowthIntelligence.tsx                          new
src/components/analysis/FullReportView.tsx                              modified (+1 section)
src/app/dashboard/stores/[domain]/page.tsx                              modified (+1 section)
src/lib/growth/__tests__/*.test.ts (5 files)                            new — unit
src/lib/growth/__tests__/*.integration.test.ts (5 files)                new — integration
```

No other file touched. `analysis/types.ts` (`FullStoreReport`), `analysis/report-contract.ts`,
`monitoring/activity.ts`, `diff/engine.ts`, entitlements, and every existing component
(`IntelligenceCard`, `SectionLabel`, `ChangeFeedTimeline`, `StoreActivitySummary`,
`AdvertisingSummary`) are byte-for-byte unchanged — confirmed by re-running their full existing test
suites unmodified (Section 12) and by this session's own tool history (no `Edit` call touched any of
them).

## 2. Database/schema changes

One index, nothing else:

```sql
CREATE INDEX "Event_storeId_entityType_entityKey_occurredAt_idx"
  ON "Event"("storeId", "entityType", "entityKey", "occurredAt" DESC);
```

Justification: two new query patterns — persistence-gap reconstruction (`persistence.ts`) and, in
principle, any future per-product event lookup — need "this product's lifecycle events, recent
first," which the existing `[storeId, occurredAt DESC]` index only partially serves (it has to scan
every event in the time range and filter `entityKey` out row-by-row). No other index was added;
`bestseller.ts`'s snapshot lookups reuse the existing `[productId, capturedAt DESC]` index unchanged,
and `catalog.ts`/`report.ts`'s product queries reuse the existing `[storeId, status]` index — both
confirmed sufficient by inspection before writing any query, per the "review existing indexes before
adding new ones" instruction.

Applied cleanly to a real, freshly-initialized Postgres 18.4 instance alongside all 7 prior
migrations — no drift, no corrections needed (Section 14).

## 3. Persistence methodology

The exact bug named in the brief: `ProductStateSnapshot` is written only on change, so counting its
rows as "observations" makes a perfectly stable product look never-observed and a volatile one look
maximally persistent — backwards.

**Fixed methodology** (`src/lib/growth/persistence.ts`): persistence is computed over the store's
most recent `PERSISTENCE_WINDOW_CRAWLS` (20) real (`OK`/`PARTIAL`) crawls — a hard, unconditional
cap. For each crawl in that window, "was this product ACTIVE" is reconstructed from two sources, not
one:

1. **`Product.missingSince`** — set the instant a product first goes missing (even at streak 1,
   before `PRODUCT_REMOVED` is ever confirmed), cleared only on restore. Catches the *current* gap
   precisely, including the pre-confirmation case no event exists for yet.
2. **`PRODUCT_REMOVED`/`PRODUCT_RESTORED` events** for that product (via the new index) — the only
   surviving record of a *past*, now-resolved gap, since a restored product's `missingSince` resets
   to null and the current `Product` row alone can no longer prove it was ever gone.

Below `MIN_CRAWLS_FOR_PERSISTENCE` (3) real crawls since the product's `firstSeenAt`, the function
returns `INSUFFICIENT_HISTORY` — and additionally reports `storeRealCrawlCount` alongside
`realCrawlsAvailable`, so a caller (see `freshness.ts`) can tell "this product is brand new" (store
has history, product doesn't) apart from "the store itself barely has any history yet."

**Known, documented imprecision**: `PRODUCT_REMOVED` fires at confirmation (2 consecutive misses by
default), not at the true start of the gap, so a resolved past gap's first crawl or two may be
counted active when the product was in fact already unseen. This is stated in the code comment, not
hidden — the ongoing-gap case has no such imprecision.

## 4. Catalog-growth implementation

`src/lib/growth/catalog.ts` reconstructs catalog size at a bounded set of real crawl dates purely
from `Product.firstSeenAt`/`missingSince` — no new table, no per-date query. One capped crawl-date
fetch (`MAX_CRAWLS_FOR_TREND = 180`, most recent) plus one capped product fetch
(`MAX_PRODUCTS_FOR_CATALOG_HISTORY = 20,000`, a defensive ceiling, not expected to bind) feed an
in-memory computation that evenly samples up to `MAX_CATALOG_TREND_POINTS` (12) real dates and counts
`firstSeenAt <= date && (missingSince === null || missingSince > date)` per product per date. Below
`MIN_CRAWLS_FOR_CATALOG_TREND` (3) real crawls, returns `INSUFFICIENT_HISTORY` rather than a
misleading two-point line. Added/removed/net counts reuse the already-shipped, already-tested
`getActivitySummary()`/`computeGrowthSignals()` from `monitoring/activity.ts` unchanged — this module
adds only the trend-points capability, per the research doc's explicit finding that store-level
growth signals were already mostly built.

## 5. Bestseller implementation

`src/lib/growth/bestseller.ts` reads the existing `ProductStateSnapshot.bestsellerRank` history
(already accumulating on every rank change, per the diff engine's `stateChanged` logic — confirmed by
direct code read, not assumed) via the existing `[productId, capturedAt DESC]` index, capped at
`MAX_RANK_SNAPSHOTS` (20). Produces:

- **Trajectory** — chronological, ranked-only observations, exactly as stored, no interpolation.
- **Movement** — current rank vs. the most recent *distinct* prior rank (skipping repeated values
  from unrelated changes, e.g. a price update that didn't touch rank).
- **Momentum** — `IMPROVING`/`DECLINING`/`STABLE`, set only once `MIN_OBSERVATIONS_FOR_MOMENTUM` (4)
  ranked observations exist across `MIN_CRAWLS_FOR_MOMENTUM` (3) distinct crawls, and only when the
  trend doesn't reverse direction (a reversal yields `null`, never a forced label).

**Language**: every UI surface pairs a movement/momentum value with *"Based on Shopify's own
bestseller ranking — not independently verified sales data."* Grepped the entire diff (`growth/`,
`GrowthIntelligence.tsx`) for "sales," "revenue," "grew," "growth" near rank language — the only
"growth" language present is the catalog-size sense, never attached to bestseller rank.

## 6. Review-infrastructure implementation

`src/lib/growth/review-infrastructure.ts` adds zero new detection — it filters the already-shipped
`StoreEntity(kind: APP)` rows (via `fingerprint.ts`'s existing `judgeme`/`yotpo`/`loox`/`stamped`/
`okendo` signatures) to that five-key set and returns them with real `firstSeenAt`/`lastSeenAt`/
`status`. Follows the OBSERVED-empty-vs-UNAVAILABLE discipline exactly as `marketing/report.ts`
established: a store checked with zero review apps returns `{status: "OBSERVED", value: []}` (looked,
found nothing), never a fabricated `UNAVAILABLE`; a store that's never completed a crawl returns
`UNAVAILABLE` without touching `StoreEntity` at all (verified by a unit test using a Prisma stand-in
that throws if called). Every rendering carries the fixed disclaimer: *"Indicates a review collection
system is installed — not a measure of review volume, authenticity, or customer sentiment."*

## 7. Freshness/persistence implementation

`src/lib/growth/freshness.ts` classifies into exactly the four labels specified — `NEW` /
`ESTABLISHED` / `RECENTLY_MISSING` / `INSUFFICIENT_HISTORY` — built as a thin, pure function
(`classifyFreshness`) over `persistence.ts`'s corrected result, never a new scoring mechanism:

- Not `ACTIVE` → `RECENTLY_MISSING`, full stop — the dominant fact right now is absence.
- `ACTIVE` + `OBSERVED` persistence → `ESTABLISHED` (the underlying ratio always rides along in the
  same payload, never hidden behind the label).
- `ACTIVE` + `INSUFFICIENT_HISTORY`, but the store has ≥3 real crawls overall → `NEW` (the shortfall
  is because the product was just discovered, which is itself the signal).
- `ACTIVE` + `INSUFFICIENT_HISTORY`, and the store itself has <3 real crawls → `INSUFFICIENT_HISTORY`
  (a statement about our data, not about the product).

## 8. Query-cost safeguards

No new external/vendor cost — everything here reads data the crawler already collects for free.
Every new query is bounded by a named, hard constant, never an unconditional table scan:

| Constant | Value | Bounds |
|---|---|---|
| `PERSISTENCE_WINDOW_CRAWLS` | 20 | Crawls considered per persistence computation |
| `MIN_CRAWLS_FOR_PERSISTENCE` | 3 | Below this: `INSUFFICIENT_HISTORY`, not a query |
| `MAX_RANK_SNAPSHOTS` | 20 | Snapshot rows fetched per bestseller lookup |
| `MAX_CRAWLS_FOR_TREND` | 180 | Crawl dates fetched per catalog-trend computation |
| `MAX_CATALOG_TREND_POINTS` | 12 | Trend points actually plotted (sampled from the above) |
| `MAX_PRODUCTS_FOR_CATALOG_HISTORY` | 20,000 | Defensive ceiling on the product fetch for catalog trend |
| `MAX_PRODUCT_HIGHLIGHTS` | 20 | Products evaluated per growth report — **never scales with catalog size** |

`MAX_PRODUCT_HIGHLIGHTS` is the one that most directly answers the brief's "no unbounded reads on the
BASIC unlimited-analysis path" mandate: `buildGrowthReport()` always evaluates exactly ≤20 products
(ranked products first, then most-recently-discovered, confirmed by an integration test seeding 30
ranked products and asserting exactly 20 come back), each a fixed number of already-bounded queries,
run concurrently via `Promise.all`. Total query count for one report request is therefore a **fixed
ceiling** (roughly 4 store-level queries + 20 × ~4 per-product queries ≈ 84), never a function of how
large the store's catalog is — verified directly against real Postgres with a 40-product store
(Section 14).

**Known, deliberate tradeoff, stated plainly**: this is 20 products × 4 small queries run
concurrently, not one batched query — a real N+1 pattern, just a *hard-capped* one. A single-query,
grouped-by-product batch (raw SQL window functions for "top-20-snapshots-per-product") was considered
and rejected for this pass: `take` on a flattened global sort can silently truncate one product's
history unevenly if the total across all 20 products exceeds the batch size, which is a
"confidently wrong" risk this milestone's own standard explicitly rejects. Correctness over
cleverness; flagged in Section 20 as a reasonable future optimization if 80-ish sub-5ms indexed
queries per report ever becomes a measured bottleneck (it was not, in this session's testing —
Section 14).

`buildGrowthReport()` is not called anywhere in `run-analysis.ts`'s synchronous `buildFullStoreReport()`
path — it is its own additive route (`GET /api/store/[domain]/growth`), fetched client-side by
`GrowthIntelligence.tsx` exactly like `AdvertisingSummary.tsx` fetches marketing data. The BASIC
unlimited-analysis flow's existing query shape is completely unchanged.

## 9. API/report-contract changes

One new route, additive only: `GET /api/store/[domain]/growth` — same shape as
`GET /api/store/[domain]/marketing` (rate-limited 30/min, store-scoped not user-scoped, store lookup
→ 404 if unknown, **no entitlement/plan gate** — matching the Milestone 4C precedent that new
intelligence categories are open to every analyzed user rather than gated behind the unused
`advancedIntelligence` capability). No `{locked: true}` anywhere — confirmed by grep.

`FullStoreReport` (`analysis/types.ts`) is **unchanged** — growth signals are a new, separate report
type (`GrowthReport`), exactly mirroring how `marketing/report.ts` stayed separate from it. Every
field is `OBSERVED` or `UNAVAILABLE`/`INSUFFICIENT_HISTORY` — no `ESTIMATED` value appears anywhere in
this sub-phase's code, confirmed by grep across `src/lib/growth/`.

## 10. UI changes

- `GrowthIntelligence.tsx` (new) — mirrors `AdvertisingSummary.tsx`'s structure exactly: fetches the
  new route client-side, renders catalog stats via the same `Stat` pattern, a dependency-free CSS-bar
  sparkline for the catalog trend (no charting library added), review infrastructure through
  `IntelligenceCard`, and a product-highlights list using the same card/border/typography conventions
  as every existing list in this codebase.
- `FullReportView.tsx` and `dashboard/stores/[domain]/page.tsx` — one new `<SectionLabel>Growth
  signals</SectionLabel>` + `<GrowthIntelligence />` insertion each, in the same position both pages
  already use for `StoreActivitySummary`. No other line in either file touched.
- Confirmed live (Section 14, screenshot) that typography, color tokens, card shape, spacing, and
  page structure are unchanged — the new section is visually indistinguishable in style from
  "Product activity" and "Advertising intelligence" above/below it.

## 11. Tests added

**Unit (39 new, all pure functions, no DB):**
- `persistence.test.ts` (11) — the 6 required scenarios (stable/no-snapshot, volatile/many-snapshots,
  becoming missing pre-confirmation, missing-then-restored, insufficient history, volatility must not
  reward) plus boundary and new-vs-young-store distinction tests.
- `catalog.test.ts` (9) — even sampling, first/last-point guarantee, size-at-date boundary conditions,
  never-fabricated-between-two-real-dates.
- `bestseller.test.ts` (13) — movement (incl. skipping repeated identical ranks), trajectory ordering
  and null-exclusion, momentum gating on both observation count and distinct-crawl count, reversal
  correctly yields `null` not a forced direction.
- `freshness.test.ts` (4) — all four label branches including the new/young-store distinction.
- `review-infrastructure.test.ts` (2) — the UNAVAILABLE-without-querying-the-DB guarantee, key-set
  pin.

**Integration (21 new, real Postgres):**
- `persistence.integration.test.ts` (7) — real crawl/event rows exercising the same 6 scenarios end
  to end through actual Prisma queries and the new index, plus a dedicated non-UTC-session-timezone
  test (see Section 16 — this module never uses raw SQL, so this test *verifies* that claim rather
  than assuming it).
- `catalog.integration.test.ts` (4), `bestseller.integration.test.ts` (3, including a real
  20-vs-30-snapshot bound check), `review-infrastructure.integration.test.ts` (4, including "checked,
  found nothing" vs. "never checked"), `report.integration.test.ts` (3, including a real 30-vs-20
  product highlight bound check and a freshly-baselined store's fully honest empty state).

## 12. Full test counts

**440 pass total** — 253 unit (up from 214) + 187 integration (up from 166), up from 380 at the end
of Sub-phase E. **Zero regressions**: every pre-existing unit and integration test still passes
unchanged, confirmed by full-suite runs before and after this sub-phase's changes.

## 13. Typecheck/lint/build results

- `tsc --noEmit`: clean, zero errors, run three times at different points during implementation (after
  the lib modules, after UI wiring, and at the end).
- `eslint .` (full project, not just new files): clean, zero warnings or errors.
- `next build`: succeeds. `GET /api/store/[domain]/growth` appears correctly in the route table
  alongside the other dynamic API routes; no new static/dynamic classification issues.

## 14. Live smoke-test results

Real, freshly-initialized Postgres 18.4 (embedded-binary workaround, same as prior sub-phases —
confirmed fully removed afterward, Section 17), migrated with all 8 migrations including this
sub-phase's index. Seeded three realistic scenarios directly via Prisma and hit the real HTTP route
(`next start`, not `next dev`) with `curl`:

1. **Rich store** (8 real crawls over 60 days, one product climbing #54→#4 across the full trajectory,
   8 stable never-changed products, 3 products added 2 days ago, 1 recently-missing product, Judge.me
   + Klaviyo both installed): response showed the climbing product's full trajectory, movement
   `{previousRank: 5, currentRank: 4, delta: 1}`, `momentum: "IMPROVING"`; all 8 stable products
   correctly `ESTABLISHED` with `ratio: 1` (**the core bug fix, confirmed live with real zero-snapshot
   products**); the 3 new products correctly `NEW` with `INSUFFICIENT_HISTORY` persistence
   (`realCrawlsAvailable: 2`, `storeRealCrawlCount: 8` — correctly distinguished); review
   infrastructure returned only `judgeme`, correctly excluding `klaviyo`; catalog trend showed a real
   10→9→12 curve across 8 sampled points.
2. **Single-crawl store**: `hasEnoughHistory: false`, catalog trend `INSUFFICIENT_HISTORY`, the one
   product's freshness correctly `INSUFFICIENT_HISTORY` (not fabricated as `NEW`), review
   infrastructure correctly `OBSERVED []` — nothing pretended to know more than one crawl can support.
3. **Plain store** (no review app, no bestseller data, 4 real crawls, 5 static products): all 5
   products `ESTABLISHED` with `ratio: 1`; review infrastructure `OBSERVED []`; every bestseller field
   correctly `null`/empty — no fabrication anywhere in a store with genuinely no ad/rank/review data.

Also confirmed: unknown domain → `404`; sibling routes (`/activity`, `/marketing`) still return `200`
(no regression from the new route's addition or the schema migration).

## 15. Browser verification results

Performed, not skipped. Installed Playwright/Chromium temporarily (same
install-verify-uninstall discipline as the embedded-Postgres workaround). Signed up a real user via
the actual signup flow, logged in, navigated to `/dashboard/stores/smoke-rich-store.com`, and
captured a full-page screenshot against the real running app and real seeded data.

Confirmed directly from the screenshot, not just asserted: the "Growth signals" section renders in
the same visual language as every existing section (identical card borders, typography, color
tokens); the catalog sparkline renders as a real 8-bar chart matching the seeded 10→9→12 curve; the
review-infrastructure card shows "Judge.me · since 50 days ago" with the exact required disclaimer
text; the bestseller highlight shows "Bestseller rank #5 ↑ #6 → #5 · Bestseller momentum: improving ·
seen in 8/8 checks" plus the required "not independently verified sales data" line; all 8 stable
products render "● Established · seen in 8/8 checks" — the persistence fix, visible end to end
through a real browser against a real database, not just asserted by a test.

One environment hiccup during this pass, unrelated to the application: the embedded Postgres instance
became briefly unresponsive ("could not fork new process for connection") under this sandbox's
resource pressure partway through. Diagnosed as environmental (confirmed via `pg_ctl`/`tasklist`, not
an application error), resolved by a clean restart + re-migrate + re-seed, and the full check then
passed on the first retry. Noted here for transparency, not glossed over.

## 16. Bugs discovered

1. **In this session's own draft code, caught before it shipped**: `report.ts`'s first draft passed
   `externalId: ""` as a placeholder into `getFreshnessSignal()` instead of the product's real
   `externalId`, which would have silently broken every persistence-gap event lookup (every product
   would have queried for lifecycle events under an empty-string key, always finding none). Caught by
   re-reading the draft before running anything, fixed by threading the real `externalId` through
   `selectHighlightProducts()`'s Prisma `select`. No test would have caught this at the unit level
   (the unit tests correctly test `computePersistence`'s pure logic, not `report.ts`'s wiring) — it
   was caught by inspection, and the real-Postgres integration test for `report.integration.test.ts`
   would have caught it too (the bestseller/freshness values would have been wrong for the seeded
   climbing product) had it shipped un-caught.
2. **Genuine environment finding, not an application bug**: `npm install <package> --no-save` can
   silently remove a *different* previously `--no-save`-installed package on the next install (both
   are "extraneous" from npm's perspective and npm's dedup pass doesn't protect either). Worked around
   by installing both temporary packages (`embedded-postgres`, `playwright`) in a single command.
   Documented here so a future sub-phase doesn't lose time rediscovering it.

## 17. Bugs fixed

Both of the above were fixed within this session before they affected any shipped code or left any
trace — no separate "fix commit" exists because nothing wrong was ever merged. `node_modules` and
`package.json`/`package-lock.json` were confirmed clean of both temporary packages after cleanup
(grep for `embedded-postgres`/`playwright`: zero matches in either package file); the leftover
`node_modules/@embedded-postgres` binary directory (not removed by a plain `npm uninstall` since it's
an optional-dependency subpackage) was found and removed manually, then `npm install` was re-run to
reconcile the lockfile state, confirmed "up to date, audited 442 packages" with no changes.

## 18. Known limitations

- **Product highlights are ACTIVE-only.** `selectHighlightProducts()` queries `status: "ACTIVE"`
  exclusively (ranked products first, then most-recently-discovered), so a `RECENTLY_MISSING`
  freshness label — while fully implemented, unit-tested, and integration-tested in isolation
  (`freshness.ts`) — is never actually surfaced by today's `buildGrowthReport()` composition, since no
  non-ACTIVE product is ever selected into the highlights list. This is an honest, deliberate scoping
  choice for this pass (a currently-missing bestseller is a genuinely interesting signal, but adding a
  second, separately-bounded selection query for it was judged separate, additive work rather than a
  requirement of this milestone's definition of done) — not a defect in the underlying capability.
- **N+1 query pattern, hard-capped but not batched** (Section 8) — a real, accepted tradeoff, not an
  oversight.
- **20-crawl persistence window and 180-crawl catalog-trend window are fixed constants**, not adaptive
  to a store's actual crawl tier (HOT vs. COLD). A HOT-tier store's 20-crawl window spans ~1 week; a
  COLD-tier store's spans ~20 months. Both are honestly labeled with real dates/counts in every
  response, so nothing is misrepresented, but the *resolution* genuinely differs by tier — exactly the
  tradeoff the research document flagged in Section 7/9 as inherent to this data, not a new problem
  introduced here.
- **The past-gap exclusion imprecision** documented in Section 3 (up to `removalConfirmations - 1`
  crawls at the start of a resolved gap may be counted active).

## 19. Data-quality limitations

- Catalog-trend and persistence computations are a lower bound on real churn: a product added and
  fully removed entirely between two consecutive crawls is invisible to both, inherited directly from
  the crawler's own discovery-gap limitation (documented in the research doc, not new to this
  implementation).
- Bestseller rank remains capped at whatever the crawler's `pageSize` fetched (up to 250, a Shopify
  ceiling) — products beyond that are `bestsellerRank: null` forever, indistinguishable from "not a
  bestseller." This implementation surfaces that `null` honestly (never treated as "worst rank") but
  does not and cannot change the underlying crawl-depth ceiling.
- Review-infrastructure presence remains, as designed, silent about volume/authenticity/sentiment —
  and, per the carried-forward Sub-phase A finding, cannot distinguish a store's own review collection
  from an imported supplier's reviews via some of these same apps.

## 20. Deferred decisions

- Batched (window-function) per-product snapshot/event queries, if the current hard-capped N+1
  pattern is ever measured as a real bottleneck at production scale (Section 8).
- Surfacing `RECENTLY_MISSING` products in the highlights list via a second, separately-bounded
  selection query (Section 18).
- Adapting the persistence/catalog-trend window sizes to a store's actual `CrawlTier` rather than a
  fixed crawl count.
- Any per-collection product-membership work remains explicitly out of scope, per the brief and the
  research document's own cost analysis (Section 10.2 of the research doc) — not touched, not
  designed around, in this sub-phase.

## 21. Recommended next sub-phase

1. Run the research document's Section 11 signal-quality validation pass against a small, real,
   diverse store corpus (the one substantive research recommendation this implementation sub-phase
   did not itself execute, since it requires real external storefronts, not synthetic seed data).
2. Decide whether `RECENTLY_MISSING` product highlights are worth a second bounded query, informed by
   real usage of what's shipped here.
3. If per-product query volume ever shows up as a real latency concern in production metrics,
   revisit the batched-query design rejected in Section 8 — with real numbers this time, not a
   preemptive optimization.
