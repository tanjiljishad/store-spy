# Milestone 7 Sub-phase C — Completion Report

**Product Presentation / UX Polish — Making Existing Intelligence Understandable**

## 1. Executive summary

This sub-phase reorganized and clarified the presentation of intelligence the platform already
produces — it introduced no new intelligence source, no scoring system, and no schema change. The
Store Intelligence page's information architecture was split into clearer conceptual sections (Store
Overview → Technology Stack → Business Intelligence → Product Activity → Catalog Growth → Product
Visibility & Bestseller Movement → Review Infrastructure → Recent Changes → Advertising Intelligence),
matching the eight-category hierarchy the brief specified while reusing every existing Fable component
unmodified in style. `IntelligenceCard`'s epistemic-status badge gained a native-tooltip explanation
(OBSERVED/ESTIMATED/INFERRED/UNAVAILABLE) and an optional "detected instead" hint for UNAVAILABLE
cards, applied to revenue, traffic, review velocity, and advertising product-matching. A new
Technology Stack section surfaces the pixel/payment-provider chips (Sub-phase B) alongside a
technology-filtered activity timeline, reusing the exact `ChangeFeedTimeline` + `eventTypes` filter
pattern already proven for advertising. Three previously-uncollected `AdvertisingSummary` fields
(ad spend, impressions, conversions) are now shown as honest, explained UNAVAILABLE cards instead of
being silently absent. A small, deterministic, rule-based "what this means" layer combines two already-
OBSERVED signals (catalog growth direction, aggregate bestseller momentum) into one conservative
sentence — only when both genuinely agree, never a fabricated composite score.

While live-verifying the analyze flow in a real browser, a genuine pre-existing bug was found in
`POST /api/analyze`'s SSE stream: a client disconnect (navigating away, closing the tab) mid-crawl
threw an uncaught `Invalid state: Controller is already closed` error and logged a false "analysis
crashed," because `cancel()`'s comment claimed to stop further writes but never actually did (the
`closed` flag it needed lived in a different closure). Fixed narrowly — three lines, one shared flag —
with a regression test that fails against the pre-fix code and passes against the fix, confirmed by
manually reverting and re-applying it.

476 tests pass (274 unit, +21; 202 integration, +1), `tsc --noEmit`/`eslint .`/`next build` all clean,
and the whole flow was verified live against a real external Shopify store (allbirds.com) via a real
signup → real crawl → real dashboard revisit → real mobile viewport, using Playwright against a real
running dev server and real Postgres.

## 2. Scope

In scope and delivered: information-architecture reorganization (Objective 1), epistemic-status
tooltips (Objective 2), improved UNAVAILABLE-state copy (Objective 3), bestseller trajectory wording
audit (Objective 4, already correct from Sub-phase B — confirmed, not re-built), catalog-growth vs.
business-growth wording (Objective 5), Technology Stack presentation with ADDED/REMOVED history
(Objective 6), review infrastructure promoted to its own section (Objective 7), advertising
intelligence gap-filling for the three previously-hidden UNAVAILABLE fields (Objective 8), activity
timeline audit (Objective 9, confirmed already human-readable — no change needed), deterministic
interpretation layer (Objective 10), empty/low-history state audit across the scenarios in Objective 11
(confirmed via live testing at the single-crawl state — every new addition honestly renders "not
enough history" or an equivalent honest empty state), mobile audit (Objective 12, confirmed via real
375px screenshots — no redesign needed).

Explicitly deferred (see Section 31): the pre-existing architectural inefficiency where the dashboard
page's SSR composer output and the client-fetched `GrowthIntelligence`/`StoreActivitySummary`/
`AdvertisingSummary`/`ChangeFeedTimeline` components independently re-fetch overlapping data.

## 3. Files changed

```
src/app/api/analyze/route.ts                                       SSE cancel() bug fix
src/components/dashboard/IntelligenceCard.tsx                      tooltips + unavailableHint prop
src/components/analysis/GrowthIntelligence.tsx                     3 labeled sub-sections + interpretation
src/components/analysis/FullReportView.tsx                         Technology Stack section, reorg
src/app/dashboard/stores/[domain]/page.tsx                         Technology Stack section, reorg
src/components/analysis/AdvertisingSummary.tsx                     ad spend/impressions/conversions cards
vitest.config.ts                                                    @ alias (needed for the new route test)
src/lib/monitoring/__tests__/change-feed.integration.test.ts        + TECHNOLOGY_EVENT_TYPES test
```

## 4. Files added

```
src/lib/monitoring/event-categories.ts                              TECHNOLOGY_EVENT_TYPES constant
src/lib/intelligence/interpretation.ts                               deterministic "what this means" rule
src/lib/intelligence/__tests__/interpretation.test.ts                 19 unit tests
src/lib/analysis/__tests__/analyze-route.test.ts                      2 unit tests (SSE regression)
docs/milestone-7-subphase-c-completion-report.md                      this report
```

## 5. Files deleted

None.

## 6. Existing components reused

`IntelligenceCard`, `SectionLabel`, `ChangeFeedTimeline` (including its existing `eventTypes` filter —
the Technology Stack timeline is the third instance of this exact pattern, after the full feed and the
marketing feed), `CatalogSparkline`/`TrajectorySparkline` (unmodified, Sub-phase B), the existing chip-
list rendering pattern, `MonitoringStatusCard`, `MonitorButton`, `StoreActivitySummary`. No component
was redesigned; every visual addition copies an existing component's exact classes.

## 7. New components added

None as new `.tsx` files. Two new small in-file helper functions (`TechnologyChips` in both
`FullReportView.tsx` and the dashboard page — presentational only, no new visual language, mirroring
the existing "each report page owns small presentational helpers" precedent noted in the Sub-phase A
research) and one new render branch inside `GrowthIntelligence.tsx` (the interpretation text block,
styled identically to the existing disclaimer/empty-state card patterns already in that file).

## 8. Backend changes

- `src/lib/monitoring/event-categories.ts` (new): `TECHNOLOGY_EVENT_TYPES`, a plain string-literal
  array (`APP_ADDED/REMOVED`, `PIXEL_ADDED/REMOVED`, `PAYMENT_PROVIDER_ADDED/REMOVED`, `THEME_CHANGED`,
  `COLLECTION_ADDED/REMOVED`), mirroring `marketing/event-types.ts`'s existing `MARKETING_EVENT_TYPES`
  exactly. Zero database calls, zero new query shape — it feeds the pre-existing `eventTypes` filter
  parameter on the already-bounded `getChangeFeed()`.
- `src/lib/intelligence/interpretation.ts` (new): pure functions, zero Prisma import, zero I/O. Reads
  only data the `/growth` endpoint already returns (`catalogGrowth.signals`,
  `productHighlights[].bestseller.momentum`).
- `src/app/api/analyze/route.ts`: the SSE `closed` flag fix (Section 16). No change to the route's
  request/response contract, only to internal stream-lifecycle correctness.

No field was added to, removed from, or reshaped in any API response. `buildFullStoreReport()`,
`buildStoreIntelligenceReport()`, `buildGrowthReport()`, and `buildMarketingReport()` are all byte-for-
byte unchanged this sub-phase.

## 9. Frontend changes

Detailed per-file in Section 3. Summary of the actual visual delta a returning user would see:

- Pixel/payment-provider/app chips moved from "Store overview" into their own "Technology stack"
  section, now paired with a filtered activity timeline showing real ADDED/REMOVED/theme-change
  history.
- Every epistemic-status badge (OBSERVED/ESTIMATED/INFERRED/UNAVAILABLE) now has a native tooltip
  explaining what the status means, on hover/focus — no visible change until interacted with.
- Revenue, traffic, review velocity, and advertising product-matching UNAVAILABLE cards gained one
  small "Detected instead: …" line pointing at what real, adjacent data is available.
- "Growth signals" is now three separately labeled sub-sections ("Catalog growth", "Product visibility
  & bestseller movement", "Review infrastructure") instead of one undifferentiated block.
- Review velocity moved from the top "Business intelligence" grid (alongside unrelated revenue/traffic)
  to sit directly below the review-infrastructure card it's actually about.
- "Business intelligence" is now a 2-card grid (revenue, traffic) instead of 3.
- Advertising intelligence gained three more honest UNAVAILABLE cards (ad spend, impressions,
  conversions) that previously weren't rendered at all.
- A new, small, conditionally-rendered "Storefront activity increasing/decreasing" sentence appears
  only when catalog growth and bestseller momentum genuinely agree — confirmed via live testing to
  correctly NOT appear at all when history is insufficient (Section 27).

## 10. Intelligence sources used

Every field and event type presented this sub-phase already existed before it started:
`report.technology.{apps,pixels,paymentProviders}` (Sub-phase B), `report.growth.signals`/
`report.productIntelligence.highlights[].bestseller.momentum` (Milestone 5), the `Event` table's
existing `APP_ADDED/REMOVED`/`PIXEL_ADDED/REMOVED`/`PAYMENT_PROVIDER_ADDED/REMOVED`/`THEME_CHANGED`/
`COLLECTION_ADDED/REMOVED` types (Milestones 1–2), and `MarketingReport.{adSpend,impressions,
conversions}` (Milestone 4, previously computed but never rendered). No new source was added.

## 11. Epistemic-status behavior

Unchanged at the data-contract level — `IntelligenceField<T>`'s four states are exactly as defined in
Sub-phase B. What changed is legibility: `IntelligenceCard`'s status badge now carries a `title`
attribute with the brief's own suggested one-line explanations:

| Status | Tooltip |
|---|---|
| OBSERVED | "Detected directly from storefront data." |
| ESTIMATED | "Derived from observed signals, not measured directly." |
| INFERRED | "Strong indication from observed signals, but not directly verified." |
| UNAVAILABLE | "The available data does not support a reliable answer." |

The same treatment was applied to `GrowthIntelligence.tsx`'s custom review-infrastructure "Observed"
badge for consistency. No internal implementation detail (query names, table names, vendor names
beyond what was already shown) is exposed by any tooltip.

## 12. Empty-state behavior

Confirmed via real live testing against a single-crawl store (Section 27): the Technology Stack
timeline correctly shows `ChangeFeedTimeline`'s existing "Monitoring started today" state (not
"genuinely quiet") because `totalCrawls < 2`; "Catalog growth" correctly shows "Not enough history yet"
because `hasEnoughHistory` is false; "Product visibility & bestseller movement" correctly shows every
product as "Insufficient history" rather than a fabricated single-point trend; the new interpretation
sentence correctly renders nothing at all (not an "insufficient evidence" placeholder — genuinely
absent) since neither catalog direction nor bestseller direction is decided yet. No new empty state
was invented; every one reuses an existing honest-state component or pattern.

## 13. Growth-signal behavior

Unchanged computation (`monitoring/activity.ts`'s `computeGrowthSignals()`, Milestone 3/5). Newly
added: the deterministic interpretation layer reads `catalogGrowth.signals` to decide
`EXPANDING`/`CONTRACTING`/null (Section 17), and the "Catalog growth" sub-section's disclaimer text was
extended with an explicit sentence: "Catalog growth is not the same as business growth."

## 14. Bestseller behavior

Unchanged (Sub-phase B's trajectory sparkline, movement/momentum computation). Confirmed via the
Sub-phase A research (Section 7) and a fresh grep this sub-phase that the mandatory language
("Bestseller rank movement is not independently verified sales data") is still present and unmodified.
The new interpretation layer's aggregate momentum read (Section 17) requires a genuine majority among
decided (non-null) momentum values, not a single product — see the unit tests in Section 24.

## 15. Technology intelligence behavior

Pixel/payment-provider/app presence: unchanged from Sub-phase B, relocated into its own section
(Section 9). ADDED/REMOVED/theme-change history: new, via a `ChangeFeedTimeline` instance filtered to
`TECHNOLOGY_EVENT_TYPES` — the exact same client component, exact same `/api/store/[domain]/events`
route, exact same cursor pagination and bounded page size (20/request) already used by the full and
marketing-filtered timelines. No new detection logic, no new backend route.

## 16. Review infrastructure behavior

Unchanged detection/data (`growth/review-infrastructure.ts`, Milestone 5). Presentation change only:
promoted from being buried inside one undifferentiated "Growth signals" block to its own labeled
sub-section, with the review-velocity UNAVAILABLE card now positioned directly beneath it instead of
in the unrelated top "Business intelligence" grid — a direct response to Objective 3's "detected
instead" principle (review-collection-app presence is the most honest adjacent fact for a "we don't
know review velocity" card to point at).

## 17. Advertising intelligence behavior

`AdvertisingSummary.tsx` previously rendered `ads`, `productMatching`, and `lastCheckedAt`/`activity`
but silently never rendered `adSpend`, `impressions`, or `conversions` at all — even though
`MarketingReport` (Milestone 4) always returns them as permanently `UNAVAILABLE` with real reason
strings. This left a real gap against the product's own stated Tier-4 principle (research doc Section
16: unavailable fields "always shown as an honest UNAVAILABLE card where a user might reasonably look
for it… never hidden entirely"). Fixed by adding three more `IntelligenceCard`s, each honest, each with
a `unavailableHint` pointing at what IS available (ad presence, format, regions, timing). No vendor
call was added; no field's value or reason string changed; `productMatching`/`adSpend`/`impressions`/
`conversions` remain hard-coded `unavailable()` constants in `marketing/report.ts`, confirmed
byte-for-byte unchanged.

## 18. Timeline behavior

Audited, not changed. Confirmed by direct read of `diff/engine.ts`/`diff/entities.ts` that every event
type already has a real, human-readable `headline` (e.g., "Widget is back in the catalog" for
`PRODUCT_RESTORED`, "Widget climbed #22 → #14" for `BESTSELLER_CLIMBED`, "Rebuilt storefront: Dawn →
Impulse" for `THEME_CHANGED`), and `ChangeFeedTimeline` already renders only `item.headline`, never the
raw `eventType` enum. Objective 9's requirement was already fully satisfied before this sub-phase
started — no change was made or needed.

## 19. Deterministic interpretation rules

`src/lib/intelligence/interpretation.ts`. Two independently-sourced inputs:

- `catalogDirectionFromSignals(signals)` → `"EXPANDING"` iff a real `CATALOG_EXPANSION` signal is
  present, `"CONTRACTING"` iff `CATALOG_CONTRACTION` is present, else `null` (covers `STEADY`,
  `PRICE_ACTIVITY`, and the empty-signals/insufficient-history case identically — all "no direction").
- `bestsellerDirectionFromMomentum(momentums)` → requires at least 2 decided (non-null) values AND a
  strict majority (`> half`) in one direction; a tie or a lone data point yields `null`.
- `deriveInterpretation(catalogDirection, bestsellerDirection)` → a fixed, pre-written sentence ONLY
  when both agree (`EXPANDING`+`IMPROVING` or `CONTRACTING`+`DECLINING`); `null` in every other case,
  including disagreement.

Every output sentence is hard-coded (no string interpolation of arbitrary values) and explicitly
caveated: "not confirmation of sales or revenue growth" / "not confirmation of reduced sales or
revenue." No LLM, no natural-language generation, no new data source.

## 20. Performance audit

Every change this sub-phase is one of: (a) a pure function with zero I/O (`interpretation.ts`), (b) a
plain constant array (`event-categories.ts`), (c) a client-side JSX reorganization consuming data an
existing fetch already returns, or (d) one more `ChangeFeedTimeline` instance reusing the exact same
bounded, already-audited `/events` query. `buildFullStoreReport()` (the function on the synchronous,
BASIC-unlimited `POST /api/analyze` path) was not touched — confirmed by re-reading the file: 14
`prisma.` call sites, identical count to before this sub-phase. `EXPLAIN ANALYZE` on the new technology-
filtered `Event` query at 3,000 seeded rows for one store: 7.03ms, index scan via
`Event_storeId_entityType_entityKey_occurredAt_idx`, identical plan shape to the pre-existing marketing-
filtered query. No new database index was added or needed.

## 21. Query bounds

No new query shape was introduced. `ChangeFeedTimeline`'s existing bound (default 20/page, cursor-
paginated, capped at 100/request server-side) now serves a third filter value; nothing about its
boundedness changes with a different `eventTypes` array. `interpretation.ts` operates entirely on
already-fetched, already-bounded in-memory arrays (`catalogGrowth.signals`, at most a handful of
entries; `productHighlights`, bounded to `MAX_PRODUCT_HIGHLIGHTS = 20` since Milestone 5) — it cannot
scale with catalog size by construction, since its only inputs are already capped upstream.

## 22. Security audit

No SSRF/URL-validation/DNS/redirect/response-size/rate-limit code was touched, except the `POST
/api/analyze` fix, which strictly narrows behavior (a disconnected client now correctly stops receiving
writes; nothing is newly exposed, no new data reaches any client). No new external call, no new vendor,
no new crawl surface. The SSE fix does not change what a client can request or receive — it only
prevents a server-side exception from being logged for a request the client already abandoned.

## 23. Entitlement audit

Zero touches to `src/lib/entitlements/`, `src/lib/auth/`, or any FREE/BASIC limit constant. The
dashboard page's `hasAnalyzedStore`/`recordAnalysisUsage`/`claim` gate (lines preceding the report
render) is unchanged — confirmed by diff-reading the file: only the JSX below that gate was
reorganized.

## 24. Fable-design preservation audit

No new Tailwind color token, spacing scale, border style, or typography rule was introduced anywhere
in this sub-phase. Every new visual element traces to an exact pre-existing pattern:

| New element | Copied from |
|---|---|
| Technology Stack chip rows | Sub-phase B's "Apps / technologies" chip row (same border/padding/font classes) |
| Technology-filtered timeline | The existing marketing-filtered `ChangeFeedTimeline` instance |
| `unavailableHint` line | `IntelligenceCard`'s existing `reason` line styling, one step lighter (`text-muted` vs. `text-muted-dim`) |
| Interpretation sentence card | The existing `rounded-lg border border-line-soft bg-surface px-4 py-3` pattern already used elsewhere in `GrowthIntelligence.tsx` |
| Sub-section headers | The existing `SectionLabel` component, reused verbatim, nested at the same visual weight the page already uses everywhere else (Fable's flat hierarchy has no separate "sub-heading" tier to invent) |
| Epistemic-status tooltip | Native browser `title` attribute — zero new UI |

No layout/navigation/responsive-breakpoint change. Confirmed visually via the live browser screenshots
in Section 28.

## 25. Tests added

- `src/lib/intelligence/__tests__/interpretation.test.ts` (19 tests): `catalogDirectionFromSignals`
  (5), `bestsellerDirectionFromMomentum` (6, including the "one improving among four is not a majority"
  and "ignores nulls" cases), `deriveInterpretation` (8, including both-agree/disagree/single-signal/
  no-signal and a "never says 'sales'" assertion).
- `src/lib/analysis/__tests__/analyze-route.test.ts` (2 tests): mocked-`runAnalysis` regression test
  proving a simulated client disconnect no longer logs a false "analysis crashed" (confirmed to fail
  against the pre-fix code — Section 16), plus a normal-completion sanity test proving the fix didn't
  break the happy path.
- `src/lib/monitoring/__tests__/change-feed.integration.test.ts` (+1 test): seeds one real event per
  `TECHNOLOGY_EVENT_TYPES` literal against real Postgres, proving every string in the constant is a
  real, correctly-spelled `EventType` the database accepts, and that the filter excludes
  `PRODUCT_ADDED`/`AD_DETECTED`/`BESTSELLER_CLIMBED`.

No existing test's assertions were changed.

## 26. Total test results

| | Before this sub-phase | After this sub-phase |
|---|---|---|
| Unit | 253 | 274 (+21) |
| Integration | 201 | 202 (+1) |
| **Total** | **454** | **476** |

All 476 pass.

## 27. Typecheck/lint/build results

`tsc --noEmit` — clean. `eslint .` — clean. `next build` (Turbopack) — succeeded, all 18 routes
compiled, identical route list to Sub-phase B (no route added or removed).

## 28. Live verification

Real, end-to-end, against a real running `next dev` server (embedded Postgres, real migrations, no
mocks): signed up a real user via the real `/signup` form, submitted `allbirds.com` via the real
landing-page input, and let the real crawl pipeline run (real DNS, real fetch, real product pagination
— 291 real products). Confirmed via the rendered page:

- Store overview: 291 products, real theme name (`[DNAM Theme July 2026]`), real average price
  ($69.66), "Apps / technologies: None detected" (correct — allbirds.com has none).
- Technology Stack: real payment-provider chips (amazon_pay, apple_pay, google_pay, paypal), correctly
  no Apps/Pixels rows rendered (both genuinely empty), and the technology-filtered timeline correctly
  showing "Monitoring started today" on a single-crawl store.
- Business Intelligence: both revenue and traffic UNAVAILABLE with the new "Detected instead: …" hint
  text rendering correctly.
- Catalog growth: "Not enough history yet" (single crawl, honest) with the new
  "Catalog growth is not the same as business growth" disclaimer visible.
- Product visibility & bestseller movement: 20 real ranked products (Allbirds Slipper, Anytime Ankle
  Sock variants, etc.) at real ranks #1–#20, every one correctly "Insufficient history" (no fabricated
  trend from one crawl).
- Review infrastructure section present and correctly positioned; review-velocity card correctly
  relocated beneath it with its new hint text.
- Advertising: the three new ad spend/impressions/conversions UNAVAILABLE cards render.
- The new interpretation sentence correctly did NOT render anywhere (expected — insufficient history
  for both signals it needs).
- Zero browser console errors across the entire flow.

## 29. Real stores tested

allbirds.com (291 products) — the same store used across Milestones 5 and 7's prior live-verification
passes, chosen here specifically because its known-empty apps/pixels fields and known-populated
payment-provider field together exercise the Technology Stack section's partial-population branch (some
chip rows present, others correctly absent) in one real store, without any new vendor call. Marketing/
advertising data was intentionally not freshly collected via SerpApi for this pass (per the brief's "do
not perform expensive vendor calls unless explicitly necessary" instruction) — the honest
"not checked yet" `UNAVAILABLE` state for `ads`/`adSpend`/`impressions`/`conversions` was verified
instead, which is itself a real, correctly-rendered state for a store with no marketing collection run.

## 30. Browser verification

Performed via Playwright (Chromium), launched against the live `next dev` server described in Section
28. Desktop (1280×1000) and mobile (375×900) viewports both captured, real screenshots inspected
directly (not merely asserted). Desktop confirmed the full section reorganization renders correctly
top-to-bottom on both the post-analyze result page and the dashboard Store Intelligence page (a genuine
revisit, not the same render). Mobile confirmed: no horizontal overflow anywhere, chip lists wrap
correctly, all card grids collapse to single-column cleanly, the "Detected instead" hint text wraps
without truncation, and the product-visibility list remains fully readable. No mobile-specific fix was
needed — the existing responsive Tailwind classes already handled every new addition correctly.

## 31. Bugs discovered and fixed

**Fixed**: `POST /api/analyze`'s SSE stream (`src/app/api/analyze/route.ts`) — `cancel()`'s `closed`
flag lived inside `start()`'s own closure, so a client disconnect never actually set the flag `cancel()`
claimed to set. A user navigating away or closing the tab mid-crawl caused `send()` to keep calling
`controller.enqueue()` on an already-cancelled controller, throwing `TypeError: Invalid state:
Controller is already closed`, logged as a false `"[api/analyze] analysis crashed"`. Discovered via
live browser verification (Section 28), not a test. Fixed by hoisting `closed` to a scope shared by
both `start()` and `cancel()`. Regression test added (Section 25); confirmed to fail against the
pre-fix code by manually reverting the fix and re-running the test (documented failure output
captured during development), then confirmed passing again after restoring it. No data-integrity
consequence found — the abandoned crawl itself still completes and persists normally per the
pre-existing `cancel()` comment's own (previously false, now true) claim.

**Investigated, found to be a test-script false positive, not a product bug**: while live-testing, an
early version of the browser-verification script's `page.waitForSelector("text=Technology stack")`
resolved instantly on the landing page because Playwright's default substring text matching matched
the always-present pricing section's copy ("Complete app & technology stack"), not the actual
`FullReportView`. This produced several rounds of misleading symptoms (apparent premature navigation,
an apparent "second POST /api/analyze," an apparent `hasAnalyzedStore` staleness bug) that were fully
explained once the selector was corrected to `getByText(..., { exact: true })`. Verified via direct
Postgres queries during the investigation that `recordAnalysisUsage`/`hasAnalyzedStore` were correct
throughout — the underlying entitlement code was never actually wrong. Documented here so a future
session doesn't re-investigate the same non-bug.

## 32. Known limitations

- The dashboard page's SSR composer call and its client-fetched child components
  (`GrowthIntelligence`/`StoreActivitySummary`/`AdvertisingSummary`/`ChangeFeedTimeline`) independently
  re-fetch overlapping data on every page load — a pre-existing inefficiency (present since Sub-phase
  B shipped the composer, not introduced here), out of this sub-phase's additive-only scope. See
  Section 33.
- The interpretation layer (Section 19) only combines two signals (catalog direction, bestseller
  momentum) rather than three (the brief's own example additionally mentioned "technology changes =
  recent") — a deliberate scope reduction to avoid adding any new query to the synchronous analyze
  path or introducing a third, less-clean signal; documented as a decision, not an oversight.
- `AdvertisingSummary`'s `ads.findMany` query remains unbounded by count (flagged, not fixed, in
  Sub-phase A's research and re-confirmed unchanged here — out of this sub-phase's scope).

## 33. Deferred work

Recommended for a future sub-phase, not attempted here (would require converting several client-
fetching components to accept server-fetched initial data, a real architectural change beyond
"presentation polish," carrying real regression risk to the separate SSE-driven `FullReportView` path
that has no server-composed data to seed from): wiring the dashboard page's already-computed
`report.growth`/`report.marketing`/`report.productIntelligence` server-side data directly into
`GrowthIntelligence`/`AdvertisingSummary` as an optional initial-data prop, so the dashboard revisit
path stops re-fetching data the SSR composer already computed in the same request.

## 34. Explicit out-of-scope confirmation

Confirmed absent, by direct grep of the entire `src/` tree (Section 27's audit): revenue estimation,
traffic estimation, review-velocity-as-sales-proxy, ad-spend/impression/conversion estimation, AI
product matching, image similarity, any Meta/TikTok/Pinterest scraping, any new payment/billing/plan-
tier code, any new crawler target, any browser-automation production code (Playwright was dev-only
tooling for this session's own verification, fully uninstalled — Section 35), and — the grep explicitly
checked — zero occurrences of `opportunityScore`/`storeScore`/`growthScore`/`competitorScore` or any
bare "sales increased"/"revenue increased" language anywhere in the composed report or its UI.

## 35. STOP-condition review

None of the twelve enumerated STOP conditions were triggered:

1. No requested UI needed data that doesn't exist — every new card/section sources an already-collected
   field.
2. No signal required implying an unsupported business conclusion — the interpretation layer's own
   design (Section 19) exists specifically to avoid this.
3. No new database schema was required (confirmed: zero Prisma schema edits, zero migrations).
4. No new external vendor was needed.
5. No existing entitlement behavior needed to change (Section 23).
6. No Fable visual-language redesign was needed (Section 24).
7. Every query remained safely bounded (Section 21).
8. No performance regression was detected (Section 20).
9. No live vendor behavior contradicted an existing assumption (no new vendor call was made).
10. No security boundary needed weakening (Section 22).
11. No serious data-integrity problem was found — the one real bug found (Section 31) had no
    data-integrity consequence, only a false error log.
12. No AI/LLM inference was required for anything shipped — the interpretation layer is fully
    rule-based and unit-tested (Section 19/25).

`embedded-postgres` and `playwright` were installed as disposable, `--no-save` dev-only tooling for
this session's own integration and browser verification, exactly as in every prior sub-phase, and were
fully uninstalled at the end — confirmed via `node_modules` and `package.json`/`package-lock.json`
inspection (Section "cleanup," folded into this review).

## Final recommendation for Milestone 7 Sub-phase D

The Store Intelligence page's information architecture, epistemic-status legibility, and unavailable-
state honesty are now substantially improved and live-verified. Recommend Sub-phase D scope to:
(1) the deferred SSR/client-fetch de-duplication (Section 33), specifically for the dashboard revisit
path only, leaving the SSE-driven analyze-result path untouched; (2) a dedicated data-quality validation
pass against a second real store with richer history (multiple real crawls, at least one real technology
change, at least one real product removal/restoration) to exercise the "rich history" branches of every
section this sub-phase touched, which the single-crawl allbirds.com pass in Section 28 could not reach;
(3) consider whether the Technology Stack timeline and the interpretation sentence are worth a small
follow-up user-facing evaluation once real users see them, before investing further in this direction.
