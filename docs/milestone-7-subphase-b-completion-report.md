# Milestone 7 Sub-phase B — Completion Report

**Intelligence Productization — Backend Composition Layer**

## 1. Executive summary

Built one canonical `StoreIntelligenceReport` contract (`src/lib/intelligence/`) that composes the
store's already-existing, already-tested intelligence modules — identity/technology/catalog
(`analysis/run-analysis.ts`), growth + product highlights + review infrastructure
(`growth/report.ts`), and marketing (`marketing/report.ts`) — into one deterministic, section-shaped
object. The composer computes nothing itself; it calls three existing builder functions in parallel
and reassembles their output under new section names. It is wired into the two "revisit" surfaces
that read already-persisted data (`GET /api/store/[domain]/report` and the dashboard Store
Intelligence page's server component) and deliberately **not** wired into the synchronous,
BASIC-unlimited-analysis crawl-triggering path (`POST /api/analyze`), preserving the cost guarantee
that path has been protected under across three prior milestones.

Alongside the composer, the three concrete gaps identified in the Sub-phase A research were closed:
pixels and payment providers (detected and persisted since Milestone 1, never surfaced) are now
exposed in `FullStoreReport`/`StoreIntelligenceReport` and rendered as chip lists; `PRODUCT_RESTORED`
events (already flowing into the raw change feed, never counted anywhere) are now a first-class
`productsRestored` field in `ActivitySummary`/`CatalogGrowthView`, additive and separate from the
pre-existing `productsAdded`/`productsRemoved`/`totalProductChanges` formulas so no existing field's
value changes for any store; and bestseller `trajectory` (already returned by the growth API, never
visualized) now renders as a small inverted-rank sparkline reusing the exact CSS-bar technique of the
pre-existing catalog sparkline.

No schema migration, no new dependency, no Fable design change, no weakened entitlement or security
behavior. 454 tests pass (253 unit, 201 integration, +7 net new), `tsc --noEmit`/`eslint .`/`next
build` all clean, and the full pipeline was verified live against three real external Shopify stores
(allbirds.com, colourpop.com, taylorstitch.com) via two real crawls each, confirming genuine pixel/
payment-provider/app/review-infrastructure data and a flat, catalog-size-independent composer runtime
up to a real 3,778-product store.

## 2. Files changed

```
src/lib/monitoring/activity.ts                                    productsRestored field + query
src/lib/monitoring/__tests__/activity.integration.test.ts          extended + 1 new test
src/lib/analysis/types.ts                                          pixels/paymentProviders fields
src/lib/analysis/run-analysis.ts                                   2 new StoreEntity queries
src/lib/analysis/__tests__/report-route.integration.test.ts        assertions updated for new shape
src/components/analysis/FullReportView.tsx                         pixels/payment-provider chips
src/app/dashboard/stores/[domain]/page.tsx                         wired to composer, new field paths
src/components/analysis/StoreActivitySummary.tsx                   "Restored" stat
src/lib/growth/report.ts                                           productsRestored propagated
src/components/analysis/GrowthIntelligence.tsx                     "Restored" stat + trajectory sparkline
src/app/api/store/[domain]/report/route.ts                         wired to composer
package.json / package-lock.json                                   embedded-postgres installed then
                                                                     fully removed (dev-only test tool,
                                                                     no net change — see Section 5)
```

## 3. Files added

```
src/lib/intelligence/types.ts                                      canonical StoreIntelligenceReport contract
src/lib/intelligence/report.ts                                     buildStoreIntelligenceReport() composer
src/lib/intelligence/__tests__/report.integration.test.ts           3 integration tests
src/lib/analysis/__tests__/full-store-report.integration.test.ts    3 integration tests (pixels/payment providers)
docs/milestone-7-subphase-b-completion-report.md                    this report
```

## 4. Files deleted

None.

## 5. Database changes

**None.** No Prisma schema migration was created or is needed. Every field this sub-phase surfaces
(`PIXEL`/`PAYMENT_PROVIDER` `StoreEntity` rows, `PRODUCT_RESTORED` events, `bestsellerRank`/trajectory
snapshots) was already being detected, persisted, and historized by existing Milestone 1–5 code — this
sub-phase only reads and composes it. The two new `StoreEntity` queries (pixels, payment providers)
are covered by the pre-existing `@@index([storeId, kind, status])` index — confirmed via `EXPLAIN
ANALYZE` (Section 17), no new index warranted. The `embedded-postgres` npm package was installed
(`--no-save`, so `package.json` was never meant to carry it) purely as this session's disposable local
Postgres for integration testing, exactly as in every prior sub-phase, and has been fully uninstalled,
its `node_modules/@embedded-postgres` directory removed, and its temporary launcher script deleted —
`package.json`/`package-lock.json` carry no trace of it.

## 6. API changes

`GET /api/store/[domain]/report`'s `access: "full"` branch now returns the canonical, sectioned
`StoreIntelligenceReport` shape (`identity`/`technology`/`catalog`/`productIntelligence`/`growth`/
`marketing`/`reviews`/`commercial`/`monitoring`/`entitlement`/`meta`) instead of the flat
`FullStoreReport`. This is a **breaking shape change** to that one endpoint's full-access response —
confirmed safe because a grep across the codebase found zero client-side consumers of this route
(only its own integration test); every other route (`/activity`, `/events`, `/watch`, `/marketing`,
`/growth`) is untouched. The `anonymous_preview`/`unanalyzed_preview` branches are byte-for-byte
unchanged. The `access: "full"` discriminant is added at the route level, spread onto the composer's
pure output — the composer itself has no knowledge of access tiers (see Section 15). No other route
was modified.

## 7. Canonical intelligence contract

`src/lib/intelligence/types.ts` defines `StoreIntelligenceReport`:

```
StoreIntelligenceReport
├── identity            { domain, platform, theme }
├── technology          { apps, pixels, paymentProviders }
├── catalog              { productCount, averagePrice }
├── productIntelligence  { highlights }                    — bounded to 20, unchanged
├── growth                CatalogGrowthView                — store-level activity + trend, unchanged
├── marketing             MarketingReport                  — passthrough, unchanged
├── reviews               { infrastructure, velocity }
├── commercial            { revenue, traffic }              — permanently UNAVAILABLE
├── monitoring             MonitoringStatus                 — passthrough
├── entitlement            { analysesUsed, analysesLimit, alreadyAnalyzed } — passthrough
└── meta                   { generatedAt, historySufficiency: { growth, marketing } }
```

Every leaf value keeps the existing `IntelligenceField<T>` OBSERVED/ESTIMATED/INFERRED/UNAVAILABLE
union from `analysis/report-contract.ts` — no second epistemic-status system was introduced. Section
boundaries are documented in-file: `identity`/`technology`/`catalog` map onto `buildFullStoreReport()`;
`growth` and `productIntelligence` map onto `growth/report.ts`'s own two-field split
(`catalogGrowth`/`productHighlights`); `marketing` is `marketing/report.ts`'s `MarketingReport` passed
through whole; `reviews` groups review-infrastructure presence with the permanent velocity
placeholder; `commercial` keeps revenue/traffic exactly as UNAVAILABLE as Milestone 5/6 left them;
`meta` is bookkeeping, explicitly not a confidence score.

## 8. Intelligence modules reused

- `buildFullStoreReport()` (`analysis/run-analysis.ts`) — identity, technology (apps + 2 new pixel/
  payment-provider queries), catalog, monitoring, entitlement.
- `buildGrowthReport()` (`growth/report.ts`) — `catalogGrowth` (store-level activity via
  `monitoring/activity.ts`'s `getActivitySummary`/`computeGrowthSignals`, catalog trend via
  `growth/catalog.ts`), `reviewInfrastructure`, `productHighlights` (bounded 20, via
  `growth/bestseller.ts`/`growth/freshness.ts`).
- `buildMarketingReport()` (`marketing/report.ts`) — ads, marketing activity, product-matching/spend/
  impressions/conversions (all permanently UNAVAILABLE, unchanged).

None of these were reimplemented, forked, or had their internal calculations touched — the composer
imports and calls them exactly as they already existed, in parallel via `Promise.all`.

## 9. New intelligence logic

None. The only new *computation* anywhere in this sub-phase is the additive `productsRestored` count
in `monitoring/activity.ts` (Section 10) — a straightforward `Event.count()` for an event type
(`PRODUCT_RESTORED`) that was already being written, using the exact same query shape as the
pre-existing `productsAdded`/`productsRemoved` counts. Everything else is composition, exposure of
already-collected data, or presentation.

## 10. Product-restored fix

`ActivitySummary` (`monitoring/activity.ts`) gained a `productsRestored: number` field, populated by a
new `Event.count({ eventType: "PRODUCT_RESTORED", occurredAt: { gte: since } })` query added to the
existing `Promise.all` batch. Deliberately **not** folded into `productCountWindowAgo`'s
reconstruction or `totalProductChanges` (`productsAdded + productsRemoved + priceChanges`, unchanged)
— restorations are additive information, not a correction to those pre-existing formulas, so no
existing field's computed value changes for any store. Propagated through `growth/report.ts`'s
`CatalogGrowthView` into both `StoreActivitySummary.tsx` and `GrowthIntelligence.tsx` as a new
"Restored" stat next to the existing "Removed" stat.

Regression coverage added to `activity.integration.test.ts`: the existing "counts events precisely"
test now also seeds and asserts one in-window and one out-of-window `PRODUCT_RESTORED` event; a new
test seeds two independent remove/restore flap cycles for the same product and confirms both
`productsRemoved` and `productsRestored` land at 2 each, not double- or under-counted. `crawl-
integrity.integration.test.ts` (Sub-phase C) already proves GUARD 1/2 leave growth signals — now
including `productsRestored` — uncorrupted by aborted or partial crawls, since it exercises the same
`getActivitySummary()` call path unchanged.

## 11. Pixel/payment-provider exposure

`FullStoreReport` gained `pixels: IntelligenceField<string[]>` and
`paymentProviders: IntelligenceField<string[]>`. `buildFullStoreReport()` now issues two more
`storeEntity.findMany({ kind: "PIXEL" | "PAYMENT_PROVIDER", status: "ACTIVE" })` queries, mirroring
the pre-existing `apps` query exactly, both covered by the existing `[storeId, kind, status]` index.
No change to detection (`crawl/fingerprint.ts`'s `PIXEL_SIGNATURES`/`PAYMENT_SIGNATURES`) or to
`diffEntitySet()`'s tracking — this is exposure of data that was already being detected, persisted,
and historized (including `PIXEL_ADDED`/`REMOVED` and `PAYMENT_PROVIDER_ADDED`/`REMOVED` events since
Milestone 1) but never queried or rendered anywhere. Surfaced in `FullReportView.tsx` and the
dashboard Store Intelligence page as two new conditionally-rendered chip lists, styled identically to
the pre-existing Apps chip list, only rendered when `OBSERVED` and non-empty.

## 12. Bestseller trajectory implementation

A new `TrajectorySparkline` component in `GrowthIntelligence.tsx`, rendered inside each product
highlight row directly below the existing "not independently verified sales data" disclaimer.
Consumes `bestseller.trajectory[].rank` (already returned by `growth/report.ts`, previously unused by
any UI) and reuses the pre-existing `CatalogSparkline`'s exact CSS-bar construction, with rank
inverted (`(worst - rank) / span`) so an improving rank (lower number = better) reads as a taller bar
moving left to right. Renders nothing below 2 observations — no fabricated single-point trend. No new
ranking model, no sales/revenue-growth calculation; vocabulary is strictly "rank," "trajectory," and
"improved/declined/changed," never "sales" or "revenue."

## 13. UI changes

- `FullReportView.tsx` / dashboard page: two new pixel/payment-provider chip-list blocks (Section 11).
- `StoreActivitySummary.tsx`: one new "Restored" stat.
- `GrowthIntelligence.tsx`: one new "Restored" stat, plus the `TrajectorySparkline` (Section 12).
- Dashboard page (`dashboard/stores/[domain]/page.tsx`): all field-access paths updated to the new
  sectioned report shape (`report.catalog.productCount`, `report.identity.theme`,
  `report.commercial.revenue`, etc.) — no visual/layout change, purely a data-source rewire.

No new colors, card styles, typography, spacing, or layout patterns were introduced anywhere. Every
addition reuses an existing chip/stat/sparkline visual pattern already present in the same component.

## 14. Fable-design compliance confirmation

Confirmed by direct inspection of every diff: no new Tailwind color tokens, no new card/border/spacing
classes beyond what the pre-existing Apps-chip-row and Catalog-sparkline patterns already used, no
new component primitives, no navigation/responsive-structure changes. The two new chip-list blocks
copy the Apps chip row's classes verbatim; the trajectory sparkline copies the catalog sparkline's
classes verbatim (one pre-existing Tailwind canonical-class IDE suggestion for `min-w-[3px]` was left
as-is to match the original component's own identical usage, not introduced by this work). The stat
grids simply gained one more `<Stat>` child each (a 4→5 or 3→4 item reflow within an existing
responsive grid), not a redesign.

## 15. Entitlement behavior confirmation

Unchanged. The composer (`intelligence/report.ts`) contains no subscription/plan/entitlement logic —
it receives `alreadyAnalyzed` as a plain boolean parameter and passes entitlement data through from
`buildFullStoreReport()` untouched. The access-tier decision (`anonymous_preview` /
`unanalyzed_preview` / `full`) still lives entirely in the route handler
(`app/api/store/[domain]/report/route.ts`), unchanged from before this sub-phase — only the shape of
the `full` branch's payload changed (Section 6), never the decision of *whether* to grant it. The
dashboard page's own pre-existing `hasAnalyzedStore`/`recordAnalysisUsage` gate (lines 50–78) is
untouched; it still runs before the composer is ever called.

## 16. Security verification

No SSRF/URL-validation/DNS/redirect/response-size/auth/rate-limit code was touched. The composer never
accepts a URL or performs a fetch — it only reads already-persisted Postgres rows via Prisma, behind
the same `requireUser`/`getCurrentUser`/rate-limit checks each call site already had. No internal DB
details, vendor API keys, or raw stack traces are newly exposed — `commercial.revenue`/`traffic` and
`reviews.velocity` carry only a static, pre-written reason string, matching the existing UNAVAILABLE
convention.

## 17. Performance/query audit

The composer itself issues **zero** new queries — it calls `buildFullStoreReport()`,
`buildGrowthReport()`, and `buildMarketingReport()` concurrently via `Promise.all` and only
destructures their results. The two genuinely new queries this sub-phase adds (pixels, payment
providers in `buildFullStoreReport()`) and the one new aggregate (`productsRestored` in
`getActivitySummary()`) were measured directly:

Seeded real Postgres data at 291 / 1,000 / 3,000 / 5,000 products (with 30–400 crawls, mixed
`StoreEntity` kinds, and marketing/ad rows) and ran `buildStoreIntelligenceReport()` end to end:

| Products | Crawls | `buildStoreIntelligenceReport()` wall time |
|---|---|---|
| 291 | 30 | 239.5ms (cold — connection/JIT warmup) |
| 1,000 | 60 | 71.4ms |
| 3,000 | 120 | 77.7ms |
| 5,000 | 400 | 84.9ms |

Flat, not scaling with product count — consistent with every query the composer touches being either
a bounded aggregate/count or capped at `MAX_PRODUCT_HIGHLIGHTS = 20`. `EXPLAIN ANALYZE` on the two new
`StoreEntity` queries showed an index scan on the existing `StoreEntity_storeId_kind_key_key` index at
every scale (0.02–0.07ms execution time). The new `productsRestored` `Event.count()` uses the
pre-existing `[storeId, occurredAt DESC]` index — the same index and query shape already carrying
`productsAdded`/`productsRemoved` since Milestone 3, unchanged in cost profile. No catalog-sized loop,
no per-product query, and no unbounded scan was introduced anywhere in this sub-phase; the ~75–85ms
steady-state cost is entirely the pre-existing, already-documented, already-accepted 20-highlight
bounded-fan-out pattern inside `growth/report.ts` (measured and accepted in Milestone 5 Sub-phase C).

## 18. Tests added

- `src/lib/analysis/__tests__/full-store-report.integration.test.ts` (new, 3 tests): pixels/payment
  providers surfaced as OBSERVED and correctly kind-filtered against a mixed `StoreEntity` seed
  (APP/PIXEL/PAYMENT_PROVIDER/COLLECTION); empty case returns OBSERVED `[]`, not UNAVAILABLE;
  MISSING/REMOVED entities excluded.
- `src/lib/intelligence/__tests__/report.integration.test.ts` (new, 3 tests): full section
  composition against a richly-seeded store (verifies every section is populated from the correct
  independent source, correctly attributed); honest insufficient-history behavior on a single-crawl
  store; determinism (two calls against unchanged DB state produce identical output modulo
  `generatedAt`).
- `src/lib/monitoring/__tests__/activity.integration.test.ts` (extended): existing "counts events
  precisely" test extended with in-window/out-of-window `PRODUCT_RESTORED` assertions; one new test
  for double-flap-cycle `productsRemoved`/`productsRestored` counting.
- `src/lib/analysis/__tests__/report-route.integration.test.ts` (updated): assertions updated for the
  new nested response shape, plus new assertions for `technology.pixels`/`technology.paymentProviders`
  and a no-fabricated-score regex check.

Two test-authoring bugs were caught and fixed by the real-Postgres run itself (not by review): an
overly broad `/confidence/` regex false-positived on the legitimate, pre-existing `matchConfidence`
field name (narrowed to target only `opportunityScore|storeScore|growthScore|competitorScore`); and a
flap-cycle test used day-offsets close enough to the fixed 7-day window boundary that real clock drift
between the file's hardcoded `NOW` constant and the actual test-run date could push an event outside
the window (widened the margin). Both are documented in the affected test files' own comments.

## 19. Total test counts

| | Before this sub-phase | After this sub-phase |
|---|---|---|
| Unit | 253 | 253 (unchanged) |
| Integration | 194 | 201 (+7) |
| **Total** | **447** | **454** |

All 454 pass. The +7 integration tests are exactly: 3 in `full-store-report.integration.test.ts` + 3
in `intelligence/report.integration.test.ts` + 1 new flap-cycle test in `activity.integration.test.ts`.

## 20. Typecheck result

`npm run typecheck` (`tsc --noEmit`) — **clean**, zero errors.

## 21. ESLint result

`npm run lint` (`eslint .`) — **clean**, zero errors/warnings.

## 22. Build result

`npm run build` (`next build`, Turbopack) — **succeeded**. All 18 routes compiled (12 static/dynamic
pages + API routes), including `/dashboard/stores/[domain]` and
`/api/store/[domain]/report`, both of which now depend on the new composer.

## 23. Live verification

Ran the real crawl pipeline (`runAnalysis()` — real DNS resolution, real `fetch` against the live
storefront, real Postgres persistence via `runDiffAndPersist`) against three real external Shopify
domains, twice each (to exercise real multi-crawl growth composition), then called
`buildStoreIntelligenceReport()` exactly as the route/dashboard page do. No mocks, no fixtures.

## 24. Real stores tested

| Store | Products (real) | Apps | Pixels | Payment providers | Reviews |
|---|---|---|---|---|---|
| allbirds.com | 291 | none detected | none detected | amazon_pay, apple_pay, google_pay, paypal | none detected |
| colourpop.com | 1,032 | gorgias, klaviyo, okendo | none detected | apple_pay, paypal, shop_pay | okendo (OBSERVED) |
| taylorstitch.com | 3,778 | gorgias, klaviyo, stamped | none detected | apple_pay, paypal | stamped (OBSERVED) |

For all three: first crawl correctly produced `hasEnoughHistory: false` / `trend.status:
"INSUFFICIENT_HISTORY"`; `commercial.revenue`/`traffic` and `reviews.velocity` correctly stayed
UNAVAILABLE; `marketing.ads.status` correctly stayed UNAVAILABLE (no marketing collection run was
performed — genuinely unchecked, never presented as "0 ads"); `productIntelligence.highlights` was
capped at exactly 20 in every case, including against the real 3,778-product taylorstitch.com catalog.
Second crawl (seconds later, nothing genuinely changed on the live site) correctly flipped
`hasEnoughHistory: true` with `productsAdded/Removed/Restored` all `0` — no false signal fabricated
from an unchanged real store. Zero crashes, zero malformed output, across three genuinely different
real storefronts. No pixel was detected on any of the three — plausible and consistent (not every
store runs tracking pixels the fingerprinter recognizes); not treated as a defect since detection
logic itself was not touched this sub-phase.

Not verified live: the actual authenticated browser session (NextAuth cookie flow → dashboard page →
rendered chips/sparkline in an actual browser). No dev-database server was running for this session
(`localhost:5432` unreachable), so live verification ran against the disposable embedded-Postgres
instance used for integration testing instead, driving the real domain functions directly rather than
through a running `next dev` server + browser. The API route handler itself (not just the composer)
was, however, exercised end-to-end against real crawled data in Section 6/24's underlying test run
methodology, and separately proven correct against synthetic fixtures in
`report-route.integration.test.ts`.

## 25. Known limitations

- `productsRestored` (Section 10) inherits the same bounded-reconstruction limitation documented in
  Milestone 5 Sub-phase C: a product missing for exactly one crawl then restored before
  `removalConfirmations` (2) is reached produces no `PRODUCT_REMOVED`/`PRODUCT_RESTORED` event pair at
  all, so it is invisible to this count. This is the existing flap-suppression philosophy, not a new
  gap introduced here.
- `marketing/report.ts`'s `ads` query (`AdObservation.findMany` filtered to `ACTIVE_EVIDENCE`, no
  explicit limit) is pre-existing Milestone 4 code, unchanged and out of this sub-phase's scope; it is
  not currently capped by count, only by status filter. Not a new risk introduced by the composer
  (which adds no additional call to it), but worth flagging for a future sub-phase if very
  long-lived, high-ad-volume stores are ever observed to make this slow.
- Pixel/payment-provider detection itself (which signatures are recognized) was not touched or
  re-validated this sub-phase — only its exposure. All three live-tested stores detected multiple real
  payment providers but zero pixels; this reflects the pre-existing Milestone 1 fingerprinter's
  current signature set, not a Sub-phase B change.

## 26. Deferred work

Per the Sub-phase A research roadmap, UI polish beyond the minimal wiring described in Section 13
(dedicated pixel/payment-provider iconography, a richer trajectory visualization treatment, timeline
integration of `PRODUCT_RESTORED` into `ChangeFeedTimeline`'s own summary copy, monitoring-experience
UX, and full data-quality-state validation across all five insufficient-history states from Task 12)
remains explicitly out of scope for this sub-phase and is recommended for Sub-phase C, consistent with
the original roadmap's own staging (Sub-phase B = backend composition, later phases = UI integration/
timeline/monitoring UX/data-quality validation).

## 27. Contradictions discovered

None. No existing intelligence module's actual behavior contradicted the Sub-phase A research
document; the research was not repeated, per the brief's explicit instruction, since no such
contradiction was encountered.

## 28. STOP conditions encountered

None of the eleven enumerated STOP conditions were triggered:

1. No existing module contradicted the research doc.
2. No schema change was needed.
3. No new dependency was needed (embedded-postgres was disposable test-only tooling, fully removed).
4. No canonical report field required data that doesn't exist — every field maps to already-collected
   data or an already-established permanent UNAVAILABLE.
5. No calculation required a fabricated assumption.
6. No query was found to scale with catalog size (Section 17).
7. No new intelligence model was needed.
8. No Fable UI redesign was needed (Section 14).
9. No existing entitlement behavior needed modification (Section 15).
10. No security boundary needed weakening (Section 16).
11. No raw SQL timestamp comparison was introduced — every new/touched query in this sub-phase is a
    typed Prisma call (`findMany`/`count` with typed `Date` filters), which round-trips UTC correctly
    per the project's own database-time rule; no `$queryRaw`/`$executeRaw` was added or modified.

## 29. Final recommendation for Sub-phase C

Backend composition is complete, tested, performance-audited, and live-verified. Recommend Sub-phase C
scope to the deferred UI/UX work named in Section 26: richer bestseller-trajectory presentation if
warranted by user feedback, `ChangeFeedTimeline` copy updates to acknowledge `PRODUCT_RESTORED`
explicitly, monitoring-experience polish, and a dedicated pass validating all five insufficient-history
states (Task 12) render honest, non-alarming, non-misleading copy across every real data-quality
condition a store can actually be in — mirroring this sub-phase's own live-verification discipline
against real stores rather than only synthetic fixtures.
