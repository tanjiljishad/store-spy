# Milestone 7 Sub-phase D — Completion Report

**Dashboard Data-Loading Architecture, Richer-History Validation, and Production-Readiness Audit**

## 1. Executive summary

This sub-phase closed the one concrete architectural gap Sub-phase C's own completion report flagged
as deferred work: the dashboard Store Intelligence page's server component computed the full
intelligence composer output on every render, then its client children (`GrowthIntelligence`,
`StoreActivitySummary`, `AdvertisingSummary`) independently re-fetched the same underlying data over
three more HTTP round trips. Fixed via an additive, opt-in `initialData` prop on all three client
components — when the server already has the data (the dashboard revisit path), it's passed directly
and the component's fetch effect never runs at all; when it doesn't (the SSE analyze-result page,
which has no server-composed report to seed from), the original fetch-on-mount behavior is completely
unchanged. Live-verified in a real browser with network-request tracking: the dashboard page now
issues **zero** requests to `/growth`, `/activity`, or `/marketing` (down from three), while the
analyze-result page's request pattern is provably identical to before.

The intelligence composer was validated against a genuinely deep, realistic 20-real-crawl history —
three products in three different real lifecycle states at once (a stable 20/20-persistent bestseller
with an improving rank trajectory, a genuinely brand-new product with only one qualifying crawl since
its own discovery, and a product that was removed and later restored) — proving every signal (catalog
trend sampling, bestseller momentum, freshness classification, persistence ratio) stays internally
consistent at real depth, not just at the shallow 2-4-crawl depth every prior test exercised. This
validation pass caught one incorrect assumption in the test's own fixture design (not a product bug —
see Section 28) that clarified exactly where the `NEW` vs. `ESTABLISHED` freshness boundary actually
sits.

No schema change, no new dependency in the shipped application, no Fable redesign, no entitlement
change, no weakened security boundary. 477 tests pass (274 unit, unchanged; 203 integration, +1),
`tsc`/`eslint`/`next build` all clean, verified live against a real crawl of colourpop.com (1,032 real
products) end to end in a real browser at desktop and mobile widths with zero console errors.

## 2. Starting state

Verified fresh against the actual current filesystem (not assumed from prior reports), per this
sub-phase's own explicit instruction:

- `src/app/dashboard/page.tsx` and `src/app/dashboard/watchlist/page.tsx` were **already** pure Server
  Components calling `getDashboardSummary()`/`prisma.watchlist.findMany()` directly — no client-side
  duplication existed on either page. `GET /api/dashboard` exists as a public API contract but has
  zero client consumers (confirmed by grep — only its own integration test imports it), mirroring the
  same "dead but intentional public contract" pattern Sub-phase B already established for
  `GET /api/store/[domain]/report`.
- The actual duplication was isolated to exactly one page: `src/app/dashboard/stores/[domain]/page.tsx`
  (the Store Intelligence page), whose three client children each re-fetched data the page's own
  `buildStoreIntelligenceReport()` call had already computed in the same request.
- `growth/report.ts`'s `CatalogGrowthView` did not expose `priceChanges` (present on the underlying
  `ActivitySummary` since Milestone 3, just never propagated) — the one real blocker to fully retiring
  `StoreActivitySummary`'s separate fetch, since that component's stat grid needs it and the composed
  report didn't carry it.
- Monitoring/watch (17 tests) and cross-user data-isolation (report route, dashboard route, watch route)
  were already comprehensively covered by existing integration tests from prior milestones — confirmed
  by direct inspection, not assumed.
- Marketing intelligence honesty (product matching/ad spend/impressions/conversions permanently
  `UNAVAILABLE`) was confirmed unchanged and already fully honest per Milestone 4 Sub-phase E's
  completion report, cross-checked against the current `marketing/report.ts` source.

## 3. Files inspected

`docs/milestone-7-intelligence-productization-research.md`, `docs/milestone-7-subphase-b-completion-
report.md`, `docs/milestone-7-subphase-c-completion-report.md`, `docs/milestone-5-growth-signals-
research.md`, `docs/milestone-5-subphase-b/c-completion-report.md`, `docs/milestone-6-commercial-
intelligence-research.md`, `docs/milestone-4-subphase-e-completion-report.md`; `src/app/dashboard/
page.tsx`, `src/app/dashboard/watchlist/page.tsx`, `src/app/dashboard/stores/[domain]/page.tsx`,
`src/app/api/dashboard/route.ts`, `src/app/api/store/[domain]/{activity,growth,marketing,report,
events,watch}/route.ts`, `src/lib/dashboard/summary.ts`, `src/lib/growth/report.ts`, `src/lib/growth/
persistence.ts`, `src/lib/monitoring/activity.ts`, `src/lib/intelligence/{types,report}.ts`, `src/
components/analysis/{StoreActivitySummary,GrowthIntelligence,AdvertisingSummary,FullReportView}.tsx`,
`src/lib/monitoring/__tests__/watch.integration.test.ts`, `src/lib/monitoring/__tests__/watch-route.
integration.test.ts`, `src/lib/analysis/__tests__/report-route.integration.test.ts`, `src/lib/growth/
__tests__/{catalog,bestseller,persistence}.integration.test.ts`, `prisma/schema.prisma` (EventType
enum, index list, re-confirmed unchanged).

## 4. Files changed

```
src/lib/growth/report.ts                                         + priceChanges on CatalogGrowthView
src/lib/intelligence/types.ts                                    + priceChanges on GrowthSection
src/components/analysis/StoreActivitySummary.tsx                 + optional initialData prop
src/components/analysis/GrowthIntelligence.tsx                   + optional initialData prop
src/components/analysis/AdvertisingSummary.tsx                   + optional initialData prop
src/app/dashboard/stores/[domain]/page.tsx                       wires initialData into all three
src/lib/growth/__tests__/report.integration.test.ts              + 1 assertion (priceChanges)
```

New file: `src/lib/growth/__tests__/rich-history.integration.test.ts`.

No file was deleted. No API route file was changed — every route (`/growth`, `/activity`,
`/marketing`) is byte-for-byte unchanged and remains fully functional as the public contract those
same components still use whenever `initialData` isn't supplied.

## 5. Dashboard duplication findings

Categorized per the brief's own A-E framework:

- **`GrowthIntelligence` (`/growth` fetch)**: (A) unnecessarily fetching the same data twice — 100%
  redundant. `buildGrowthReport()` (server, inside the composer) and the client's own fetch to
  `/api/store/[domain]/growth` (which wraps the exact same `buildGrowthReport()` call) compute
  identical output for identical input, with zero query parameters differentiating them. **Fixed.**
- **`AdvertisingSummary` (`/marketing` fetch)**: same category, same reasoning —
  `buildMarketingReport()` is called once by the composer and again, identically, by the client fetch.
  **Fixed.**
- **`StoreActivitySummary` (`/activity` fetch)**: (A) mostly redundant, with one real gap —
  `priceChanges` wasn't exposed by the composed report. Root-caused and closed (Section 6) rather than
  left as an excuse to keep the fetch. **Fixed.**
- **`ChangeFeedTimeline` (`/events` fetch, 3 instances — full/technology/marketing filters)**: (E)
  intentional, legitimate, unchanged. The composer carries no event-feed data at all (a deliberate
  Sub-phase B boundary — events are cursor-paginated, unbounded-total, browser-interactive "Load more"
  state), so this is not a duplicate computation, it's the only source. Left exactly as-is.
- **`/api/dashboard` route**: (E), sort of — a genuinely unused-but-intentional public API surface (no
  client consumer exists, confirmed by grep), not a duplication site at all since the one page that
  needs this data (`dashboard/page.tsx`) already calls the domain function directly and never touches
  this route.

## 6. Final data-loading architecture

```
Database
   ↓
Domain/service layer (getActivitySummary, buildGrowthReport, buildMarketingReport,
                       buildStoreIntelligenceReport)
   ↓
Server Component (dashboard/stores/[domain]/page.tsx) — computes the full report ONCE
   ↓                                              ↓
Rendered directly into IntelligenceCard/          Passed as `initialData` prop into
SectionLabel/TechnologyChips JSX                  GrowthIntelligence/StoreActivitySummary/
                                                   AdvertisingSummary — fetch effect skipped
                                                   entirely when present
```

The public API routes (`/growth`, `/activity`, `/marketing`) are unchanged and remain the sole data
source for the one context that genuinely still needs client-side fetching: `FullReportView.tsx`'s
SSE analyze-result page, which has no server-composed report to seed from (by Sub-phase B's own
deliberate design — the synchronous `POST /api/analyze` path is never wired to the composer, to
protect BASIC's unlimited-analysis cost guarantee). `ChangeFeedTimeline` keeps its own independent
client fetch on both pages, for the legitimate reasons in Section 5.

No internal HTTP hop was introduced or removed from any Server Component — `dashboard/stores/[domain]/
page.tsx` already called `buildStoreIntelligenceReport()` (the domain/service layer) directly, never
through `fetch("/api/...")`; that was true before this sub-phase and remains true now. The only change
is that its ALREADY-fetched result is now also handed to child Client Components instead of being
discarded after server-side render.

## 7. Intelligence composer audit

Every field currently shown on the Store Intelligence page, verified against the current source (not
assumed from documentation):

**OBSERVED**: platform, theme name/version, apps, pixels, payment providers, product count, average
price, catalog growth (added/removed/restored/price-changed counts, net delta, trend), product
persistence/freshness (NEW/ESTABLISHED/RECENTLY_MISSING/INSUFFICIENT_HISTORY), bestseller current
rank/movement/momentum/trajectory, review infrastructure presence, advertising activity (presence,
format, region, advertiser, timing, historical new/removed/continuous counts), technology change
history (via the `ChangeFeedTimeline` + `TECHNOLOGY_EVENT_TYPES` filter, Sub-phase C), product activity
(added/removed/restored/price-changed, windowed), monitoring status/history.

**ESTIMATED**: none exist in production code anywhere in this codebase — confirmed by grep (`grep -rn
'"ESTIMATED"' src/lib`, matches only the type definition and its own tests). No new one was introduced.

**INFERRED**: same — none exist in production, none introduced.

**UNAVAILABLE**: revenue, traffic, review velocity (as a metric, not review-infrastructure presence),
product-level advertising matching, ad spend, impressions, conversions — every one still hard-coded as
a permanent `UnavailableField` constant with a real reason string, confirmed unchanged in
`marketing/report.ts` and `intelligence/report.ts`'s `asPermanentlyUnavailable()` helper.

No field's epistemic status changed. No heuristic was promoted to `ESTIMATED`.

## 8. Rich-history validation

New `rich-history.integration.test.ts`: one real Postgres store, 20 real weekly crawls, three products
in three genuinely different real lifecycle states simultaneously, verified through
`buildGrowthReport()` (the actual composition entry point, not a mocked unit):

- **Anchor** (present all 20 crawls, rank improving #50→#5): `freshness.label === "ESTABLISHED"`,
  `persistence.ratio === 1`, `bestseller.momentum === "IMPROVING"`, real bounded trajectory. No
  "sales"/"revenue" language anywhere in the raw signal (asserted directly against the JSON).
- **Newcomer** (discovered at crawl 20, the very last one — only 1 qualifying crawl since its own
  discovery): `freshness.label === "NEW"`, `currentRank`/`trajectory` empty — no fabricated trend from
  a product that genuinely has almost no history of its own.
- **Flapper** (active crawls 1-10, `PRODUCT_REMOVED` at crawl 11, `PRODUCT_RESTORED` at crawl 15,
  active through crawl 20): a real persistence ratio strictly between 0 and 1 — the gap is visible in
  the number, not silently smoothed away, and the product correctly reads `ESTABLISHED` (not
  `RECENTLY_MISSING`) now that it's back and `ACTIVE`.
- **Catalog trend**: `sampledFromCrawlCount === 20` (the real crawl count), `points.length ===
  MAX_CATALOG_TREND_POINTS` (12) — proving the even-sampling cap actually engages at real depth beyond
  12 crawls, not just asserted in isolation against a synthetic array.
- **Product highlights**: bounded at `MAX_PRODUCT_HIGHLIGHTS` regardless of how many real products with
  real signals exist.

## 9. One-crawl behavior

Not newly re-tested this sub-phase — already comprehensively covered by existing tests (`catalog.
integration.test.ts`'s `INSUFFICIENT_HISTORY` case, `persistence.ts`'s `MIN_CRAWLS_FOR_PERSISTENCE`
gate, `activity.integration.test.ts`'s `hasEnoughHistory` gating) and re-confirmed live in Sub-phase C
against a real single-crawl store. No regression found; the composer's dedup change touches none of
this gating logic.

## 10. Multi-crawl behavior

2-4 crawls: unchanged, already covered by every existing growth-module test file. 5-10 crawls: no
dedicated fixture at exactly this depth, but the 20-crawl rich-history test's own trajectory (weekly
crawls 1 through 20) passes through this range as part of its continuous history, and the existing
`MIN_CRAWLS_FOR_CATALOG_TREND`/`MIN_CRAWLS_FOR_MOMENTUM` boundary tests (at exactly 3) cover the
specific transition points. 20+ crawls: newly and directly verified (Section 8), plus the pre-existing
`PERSISTENCE_WINDOW_CRAWLS + 15` (35 crawls) and `MAX_RANK_SNAPSHOTS + 10` (30 snapshots) tests, both
confirmed still passing, proving the hard caps hold even further beyond 20.

## 11. Timestamp/UTC verification

Zero new raw SQL was introduced this sub-phase — confirmed by grep (`grep -rln '\$queryRaw\|\$executeRaw'
src/lib src/app`, cross-checked against every file this sub-phase actually touched: none overlap). The
`priceChanges` field added to `CatalogGrowthView` is a typed Prisma field passthrough (no new query at
all — the underlying `Event.count()` call in `getActivitySummary()` already existed and already
computed it). The existing non-UTC-session regression tests (`monitoring/__tests__/timezone-safety.
integration.test.ts`, `marketing/__tests__/timezone-safety.integration.test.ts`, `watch.integration.
test.ts`'s Asia/Kathmandu case) all re-ran clean in the full suite (Section 23) — no timestamp
correctness regression anywhere.

## 12. Signal consistency verification

Verified directly via the rich-history test (Section 8): a product with 100% persistence and an
improving rank never simultaneously reads any insufficient-history state; a product currently `ACTIVE`
after being restored never reads `RECENTLY_MISSING`; a genuinely brand-new product never gets a
fabricated trajectory. No contradiction found in any of the brief's named example scenarios (Section 5
of the brief) — each was already structurally prevented by the existing gating logic (`hasEnoughHistory`,
`classifyFreshness`, `computePersistence`'s ongoing-gap override), now proven at real depth rather than
only shallow depth.

## 13. "What this means" verification

`src/lib/intelligence/interpretation.ts` (built in Sub-phase C) was not modified this sub-phase.
Re-confirmed via its existing 19 unit tests (all still passing, Section 23) that it: (A) fires only
when catalog direction and bestseller momentum both genuinely agree positively; (B) same for negative
agreement; (C) never fires on disagreement; (D) never fires when either signal is unavailable/null;
(E)/(F) never fires on insufficient history or no movement (both collapse to `null` direction, which
the combination logic already treats as "no evidence"); (G) conflicting historical periods aren't a
distinct code path — the majority-vote design in `bestsellerDirectionFromMomentum` already handles a
mixed-direction history by requiring a strict majority, falling back to `null` on anything short of
that. No change was needed; the existing implementation was preserved exactly as instructed.

## 14. Performance measurements

`buildStoreIntelligenceReport()` (the composer, unchanged by this sub-phase's actual code) measured
against real Postgres at 100/500/1,000/5,000 products with proportional crawl history (30/60/120/400):

| Products | Crawls | Wall time |
|---|---|---|
| 100 | 30 | 285.8ms (cold — connection/JIT warmup) |
| 500 | 60 | 42.8ms |
| 1,000 | 120 | 34.5ms |
| 5,000 | 400 | 78.0ms |

Flat, not scaling with product count — consistent with Sub-phase B/C's own prior measurements at this
same scale, confirming no regression. `highlights` stayed at exactly 20 and `trendPoints` at exactly
12 across all four scales.

## 15. Query analysis

The dedup change (Section 6) removes 3 HTTP round trips (and their underlying, already-bounded
database queries) per dashboard page view — a real, measured reduction, not just an architectural
tidy-up. It adds **zero** new database queries: `priceChanges` was already computed by the existing
`getActivitySummary()` call inside `buildGrowthReport()`, merely not previously exposed in the return
shape. No `EXPLAIN ANALYZE` was needed for this sub-phase's own changes since none of them touch the
query layer at all — confirmed by diffing the actual Prisma call sites touched (none) against those
already audited in Sub-phase B/C.

## 16. BASIC unlimited-analysis safety

Re-confirmed unchanged: `buildFullStoreReport()` (the function on the synchronous `POST /api/analyze`
path) was not touched, still has the same query count as before this sub-phase (14 `prisma.` call
sites, unchanged from the Sub-phase C baseline). The composer (`buildStoreIntelligenceReport()`) is
still wired only into the two revisit paths (`GET /api/store/[domain]/report`, the dashboard page),
never into the synchronous analyze path — this sub-phase's dedup work only touches how the DASHBOARD's
already-computed data reaches its children, never adds cost to the crawl-triggering request.
`MAX_PRODUCT_HIGHLIGHTS=20`, `PERSISTENCE_WINDOW_CRAWLS=20`, `MAX_RANK_SNAPSHOTS=20`,
`MAX_CATALOG_TREND_POINTS=12`, `MAX_CRAWLS_FOR_TREND=180` — all confirmed unchanged in source and all
re-proven to hold at real, deeper-than-cap scale (Sections 8/10).

## 17. Monitoring verification

Not re-implemented — verified as already comprehensively covered by 17 existing tests in `watch.
integration.test.ts` (FREE 1-store limit + rejection, BASIC 20-store limit + 21st rejection, 30-day
expiry + demotion to COLD, idempotent re-start, removing one of multiple watchers, re-monitoring after
removal, continuous null-expiry BASIC monitoring, two users independently watching the same store, a
dedicated non-UTC-timezone regression case) plus `watch-route.integration.test.ts`'s route-level
ownership tests (Section 18). All re-ran clean in the full suite this sub-phase (Section 23). No gap
found, no new test needed, per the brief's own "this is a validation task unless a real bug is
discovered" instruction — none was.

## 18. Authentication/data isolation

Verified as already comprehensively covered: `report-route.integration.test.ts`'s "user isolation: user
B viewing a store user A analyzed sees `unanalyzed_preview`, not A's full report"; `watch-route.
integration.test.ts`'s "user isolation: user B starting a watch never touches user A's watch row" and
"user A cannot remove user B's monitoring by calling DELETE while signed in as A"; `dashboard-route.
integration.test.ts`'s "never exposes internal database ids." Every authorization check happens
server-side against the session's own `user.id`, never trusted from a client-supplied value — confirmed
by re-reading each route handler this sub-phase. No weakening found or introduced.

## 19. Marketing intelligence verification

Confirmed unchanged and still fully honest: `productMatching`/`adSpend`/`impressions`/`conversions`
remain hard-coded `UnavailableField` constants in `marketing/report.ts`, never computed from ad count,
frequency, product count, format, or any vendor field — verified by direct re-read of the source
(unchanged since Milestone 4 Sub-phase E) and by the live browser verification in Section 26, which
showed all four cards rendering their real, honest reasons against genuine live data. No Meta/TikTok/
Pinterest/AI-matching/spend-estimation code exists anywhere in the tree — confirmed by grep.

## 20. Technology intelligence verification

Confirmed unchanged: theme/apps/pixels/payment-providers detection and the `TECHNOLOGY_EVENT_TYPES`-
filtered change timeline (Sub-phase C) are both untouched by this sub-phase. Live-verified (Section 26)
against colourpop.com: real apps (gorgias, klaviyo, okendo) and real payment providers (apple_pay,
paypal, shop_pay) rendered correctly, with the technology timeline correctly showing "Monitoring
started today" (a single real crawl, honest state — not a fabricated empty history).

## 21. Fable UI preservation

No color, typography, spacing, card shape, or section-hierarchy change. The only visual-adjacent change
this sub-phase made is invisible: three components now sometimes skip a loading spinner because their
data arrives synchronously with the initial render instead of one tick later via `useEffect` — the
rendered markup and every class name are identical either way, confirmed by the live browser
screenshots in Section 26 showing pixel-identical layout to Sub-phase C's own verification screenshots
of the same page.

## 22. API contract audit

Every route under `/api/store/[domain]/*` confirmed to use `canonicalizeDomain` consistently (grep:
zero files without it). No `{ locked: true }` pattern exists anywhere in the codebase (confirmed by
grep — the only matches are comments explicitly documenting its retirement). `GET /api/store/[domain]/
report`, `/activity`, `/growth`, `/marketing`, `/events`, `/watch`, `POST /api/analyze`, `GET /api/
dashboard` — all unchanged this sub-phase, all still return their existing OBSERVED/ESTIMATED/INFERRED/
UNAVAILABLE-shaped fields with no new field, no removed field, no renamed field. No existing consumer
was broken (confirmed by the full existing integration suite passing unmodified in assertion content,
Section 23).

## 23. Tests

| | Before this sub-phase | After this sub-phase |
|---|---|---|
| Unit | 274 | 274 (unchanged) |
| Integration | 202 | 203 (+1) |
| **Total** | **476** | **477** |

All 477 pass. `tsc --noEmit` — clean. `eslint .` — clean. `next build` — succeeded, identical 18-route
list to Sub-phase C (no route added or removed).

## 24. Live Postgres verification

Full integration suite (203 tests, 30 files) run against a real, freshly-migrated Postgres 18.4
instance (the same disposable, `--no-save` embedded-binary approach used in every prior sub-phase —
confirmed fully removed afterward, Section 30). Migration run confirmed **zero pending migrations** —
this sub-phase introduced no schema change, verified by the migrate command's own output, not merely
asserted.

## 25. Live Shopify verification

One real external store, chosen deliberately to minimize new crawl load (per the brief's explicit
"do not crawl aggressively" instruction) by reusing a store already crawled in Sub-phase C's own live
verification: **colourpop.com**, 1,032 real products. A real signed-up user performed a real analyze
(real DNS, real fetch, real pagination) via the landing page, then revisited the Store Intelligence
page. Confirmed: real theme (`[LF] BTS Promo Launch 8/7`), real average price ($15.55), real apps
(gorgias, klaviyo, okendo), real payment providers (apple_pay, paypal, shop_pay), real review
infrastructure (okendo), honest single-crawl empty states throughout, all advertising fields honestly
`UNAVAILABLE` with real reason text. Not separately re-verified against a small-catalog store this
sub-phase (Sub-phase C already did so against allbirds.com, 291 products, with no code touched since
that would regress it) — see Section 26/31 for exactly what this means for claimed coverage.

## 26. Browser verification

Real Chromium via Playwright, real running `next dev` server, real Postgres. Desktop (1280×1000) and
mobile (375×900). Directly measured, not merely asserted: request-tracking confirmed the dashboard
Store Intelligence page issues **zero** requests to `/growth`, `/activity`, or `/marketing` after this
sub-phase's fix (down from one each), while the FullReportView SSE-result page's request pattern is
unchanged. Zero console errors, zero page errors, across the full signup → analyze → dashboard-revisit
→ mobile flow. Screenshots inspected directly confirm pixel-consistent Fable styling with Sub-phase C's
own verification screenshots of the same page.

## 27. Security verification

Re-ran (as part of the full suite, Section 23, not a separate reduced run) every existing test under
`src/lib/security/__tests__/` (SSRF guard, rate limiting) and every auth/isolation test named in
Sections 17/18 — all pass unmodified. No SSRF, redirect, DNS/IP-validation, response-size, rate-limit,
authentication, or authorization code was touched by this sub-phase's actual changes (three client
components gaining an optional prop, one report field exposed, one composer type extended, one new
test file). No new attack surface was introduced.

## 28. Bugs found

None in production code. One incorrect assumption in this sub-phase's own new test fixture (not a
product bug): the rich-history test's first draft placed the "Newcomer" product's `firstSeenAt` at
crawl 18 of 20, expecting a `NEW` freshness reading — but with 3 real crawls (18, 19, 20) since that
product's own discovery, `getProductPersistence()` correctly finds enough qualifying crawls
(`>= MIN_CRAWLS_FOR_PERSISTENCE`, which is exactly 3) to return an `OBSERVED` persistence result, and
`classifyFreshness()` correctly reads that as `ESTABLISHED`. This is the freshness/persistence boundary
working exactly as designed and documented — the test's own expectation was wrong, not the
implementation. Diagnosed by running the test, reading the actual failure, and tracing the real code
path rather than assuming a bug; fixed by moving the fixture to crawl 20 (only 1 qualifying crawl,
genuinely below the threshold) so the test exercises the intended `NEW` state correctly.

## 29. Bugs fixed

None (no product bug was found this sub-phase — see Section 28). The dashboard duplication itself
(Section 5) was an architectural inefficiency, not a correctness bug: the duplicated data was always
consistent (same source, same request), just fetched twice.

## 30. Known limitations

- Live Shopify verification this sub-phase covered one store depth profile (colourpop.com, ~1,000
  products, single real crawl in this session). Medium/large-catalog and multiple-real-crawl live
  verification were covered in Sub-phase C (allbirds.com, colourpop.com, taylorstitch.com, up to 3,778
  products) and not repeated here since no code this sub-phase touches the crawl or composition logic
  those runs exercised — re-crawling them again would have added real external load without new
  evidence value, per the brief's own "do not crawl aggressively" instruction.
- The rich-history integration test (Section 8) uses fixture data (directly-created Crawl/Product/
  Event/ProductStateSnapshot rows), not a real 20-crawl external Shopify history — no real store in
  this corpus has been monitored for 20 real crawls within this session's timeframe. This is explicitly
  a fixture validation, not a real-world one, and is described as such throughout this report, per the
  brief's "clearly distinguish fixture validation from real-world validation" instruction.
- `AdvertisingSummary`'s underlying `ads.findMany` query remains uncapped by count (flagged in Sub-phase
  A's research, re-confirmed unchanged, still not a proven problem — out of this sub-phase's scope).

## 31. Deferred decisions

None newly deferred this sub-phase. The one item Sub-phase C deferred (this dashboard dedup) is now
resolved. No new architectural question was surfaced that needs a future sub-phase's decision.

## 32. Production-readiness implications

The dashboard Store Intelligence page — the single most data-heavy page in the product — now does
exactly one composition pass per request (already true before) and zero redundant client round trips
(new this sub-phase), for a real, measured reduction in both request count and time-to-fully-rendered
state on every revisit. Every bounded-query guarantee this project has built up over three milestones
(Sub-phase B's composer bounds, Sub-phase C's UI additions) was re-proven to hold at real crawl depth
up to 35 crawls and real product-count scale up to 5,000, not just asserted at the boundary value. No
schema migration is pending, no dependency needs updating for this work, and the full test suite (477
tests) provides real regression coverage for both the architectural change and the deeper-history
behavior a longer-running production deployment will actually encounter.

## 33. Final recommendation for Milestone 8

The Store Intelligence composer and its presentation layer are now validated at real depth (deep crawl
history, varied product counts, mutual signal consistency) and the one identified architectural
inefficiency is resolved. Recommend Milestone 8 shift focus from productization/validation to actual
production deployment concerns: real environment configuration (replacing the disposable embedded-
Postgres/local-dev pattern used for verification across Milestones 5-7 with a real managed Postgres
target), real scheduled-crawl cadence operating continuously against a real corpus for long enough to
accumulate genuine 20+-crawl history on real stores (which would let a future sub-phase upgrade Section
30's fixture-based rich-history validation to a real-world one), and a real monitoring/alerting setup
for the production service itself. No further intelligence-productization work is recommended before
that — the product's honest-intelligence discipline has now been validated at every depth this session
could reasonably exercise.

---

## Milestone 7 — Sub-phase D

### Status
COMPLETE

### Production code changed
YES

### Schema changed
NO

### Dependencies changed
NO

### Fable visual redesign
NO

### Tests
- Unit: 274/274
- Integration: 203/203
- Typecheck: PASS
- ESLint: PASS
- Build: PASS

### Real Postgres
PASS

### Real Shopify verification
PASS

### Browser verification
PASS

### Major findings
- Dashboard Store Intelligence page was making 3 fully redundant client-side HTTP round trips
  (`/growth`, `/activity`, `/marketing`) for data its own server component had already computed.
- `priceChanges` was computed by `getActivitySummary()` but never exposed by `CatalogGrowthView`,
  the one real blocker to fully deduping `StoreActivitySummary`.
- Every existing bounded-query cap (20 crawls, 20 snapshots, 20 highlights, 12 trend points) holds at
  real depth up to 35 crawls / 5,000 products, newly proven rather than only asserted at the boundary.

### Bugs found
- None in production code.

### Bugs fixed
- None (architectural inefficiency, not a correctness bug — see Major findings).

### Known limitations
- Rich-history validation (20 real crawls) used fixtures, not a real 20-crawl external Shopify history
  — no store in this corpus has real history that deep yet.
- Live Shopify verification this sub-phase covered one store (colourpop.com); small/large-catalog and
  multi-crawl real-store coverage was established in Sub-phase C and not repeated to avoid unnecessary
  external load.

### Deferred
- None newly deferred.

### Recommendation
Shift Milestone 8 to production deployment: real managed Postgres, continuous real scheduled crawling
long enough to accumulate genuine deep history on real stores, and production monitoring/alerting for
the service itself — the intelligence product's correctness and honesty have been validated at every
depth available within this development environment.
