# Milestone 4 Sub-phase E — Completion Report

**Marketing Intelligence Productization.** Status: complete. The system now honestly presents exactly what's verified (advertiser, format, timing, region, historical trend) and explicitly, visibly says what isn't (product matching, spend, impressions, conversions) — through the existing UI vocabulary, not a special-cased "broken feature" look.

## 1. Files changed

```
src/lib/marketing/activity.ts                                    new
src/lib/marketing/__tests__/activity.integration.test.ts          new
src/lib/marketing/report.ts                                       modified (contract extended)
src/lib/marketing/__tests__/report.integration.test.ts             modified (+7 tests)
src/components/analysis/AdvertisingSummary.tsx                    modified (rewritten to match new contract)
```

No other file touched. No schema change. No API route added (same `GET /api/store/[domain]/marketing`). No entitlement file touched. No Fable component other than `AdvertisingSummary`'s own internals modified — `IntelligenceCard`, `SectionLabel`, `ChangeFeedTimeline`, and the page layouts around it are byte-for-byte unchanged.

## 2. Schema changes

None.

## 3. API changes

`GET /api/store/[domain]/marketing`'s response gained four new top-level fields and one new per-ad field — additive, nothing removed or renamed:

- `activity: MarketingActivitySummary | null` — real historical signals (new/removed/continuously-active ad counts over a 30-day window), `null` until at least one successful collection has ever run, with its own `hasEnoughHistory` gate requiring a *second* successful collection before any delta is shown.
- `productMatching: UnavailableField` — always `{ status: "UNAVAILABLE", reason: "Product-level matching unavailable from the current advertising data source." }`. Stated once, explicitly, rather than left implicit in every ad's already-null `matchedProduct`.
- `adSpend` / `impressions` / `conversions: UnavailableField` — reserved shape, always unavailable, mirroring `FullStoreReport.revenue`/`traffic`/`reviewVelocity`'s existing "not built yet, explicitly so" convention.
- `AdView.regions: string[] | null` — real, vendor-disclosed region names, extracted from the `sourceMetadata` Sub-phase D's adapter already started capturing but nothing surfaced until now.

## 4. UI changes

`AdvertisingSummary.tsx` only. Three additive changes, all built from components that already existed:

1. The "Products matched" card is now a "Product matching" card driven directly by the new `productMatching` field — `IntelligenceCard` renders it exactly like any other `UNAVAILABLE` field (same "Not available yet" headline, same reason-text styling as "Estimated revenue" above it). No new visual state was invented for this.
2. A new activity-stats row (reusing `StoreActivitySummary`'s existing `Stat` sub-component verbatim) shows real new/removed/continuously-active counts when `activity.hasEnoughHistory` is true, or an honest "Advertising monitoring started" empty state (mirroring `ChangeFeedTimeline`'s existing "just started" copy pattern) when it isn't.
3. The ad list now shows real advertiser name, format, and regions (when disclosed) instead of a matched-product title — verified live in a real browser against real seeded data, screenshot inspected directly, not just asserted by a test.

Confirmed no typography, color, spacing, card shape, or layout changed anywhere — every new element reuses `IntelligenceCard`, `SectionLabel`, or `StoreActivitySummary`'s own `Stat` pattern.

## 5. New tests

- `activity.integration.test.ts` (6 tests, real Postgres): `hasEnoughHistory` gating (false at 1 successful run, true at 2, unaffected by failed runs), real windowed AD_DETECTED/AD_REMOVED counts, `currentActiveAdCount` excluding HISTORICAL rows, `continuouslyObservedAdCount` correctly distinguishing "first seen before this window" from "new this window."
- `report.integration.test.ts` (+7 tests): `productMatching`/`adSpend`/`impressions`/`conversions` are always UNAVAILABLE with the exact real reason text, regardless of whether ads were found; `regions` extraction from real `sourceMetadata` and correct `null` when absent; `activity` is `null` before any check and reflects `hasEnoughHistory` correctly across 1 vs. 2 successful runs.

## 6. Total test count

**380 pass** (214 unit + 166 integration — up from 368 at the end of Sub-phase D). Zero regressions: every Sub-phase B/C/D test still passes unchanged, confirmed by full-suite runs before and after this sub-phase's changes.

## 7. Live verification results

- **Real Postgres**: full integration suite (166 tests) run against a real, freshly-migrated Postgres 18.4 instance (same temporary, fully-removed embedded-binary approach as prior sub-phases — confirmed zero traces in `package.json`/`package-lock.json` afterward).
- **Real browser, real data**: signed up a real user, seeded a real store/product/two `AdObservation` rows (one "new" within the 30-day window, one "continuous," with real region metadata) directly via Prisma, logged in, navigated to the Store Intelligence page, and inspected a full-page screenshot. Confirmed directly, not just asserted: the "Product matching: Not available yet" card renders identically in style to the pre-existing "Estimated revenue: Not available yet" card; activity stats showed the correct real `+1 new / -0 removed / 1 continuously active`; the ad list showed real advertiser name, format, and `"United States, Canada"` region text; the general "Recent changes" feed and the dedicated advertising timeline both correctly surfaced the same real `AD_DETECTED` event.
- **Real SerpApi**: one confirmatory live call through the Sub-phase-D-corrected adapter (`searchAdsForDomain("allbirds.com")`) — `outcome: SUCCESS, ads: 80, requestCount: 2`, matching the `MAX_AD_PAGES = 2` cap exactly, with real field extraction (`advertiserName: "Allbirds Inc"`, real creative/advertiser IDs) confirming the Sub-phase D fixes hold against the live vendor, not just against corrected mocks. Deliberately minimal — 2 requests, no detail calls — since this sub-phase's job was confirming the existing correction still holds, not re-discovering it.

## 8. Actual SerpApi request consumption this sub-phase

**2 requests total** (one smoke-test call, 2 pages). Everything else in this sub-phase (report contract, activity summary, UI) is a pure read against already-persisted Postgres data — none of it calls the vendor.

## 9. Remaining limitations

Unchanged from Sub-phase D: destination URLs remain unavailable from this vendor; real pricing/ToS remain unverified; `MAX_AD_PAGES = 2` is a judgment call from one data point. Newly explicit rather than newly discovered: `adSpend`/`impressions`/`conversions` have no validated source and are now visibly, permanently marked as such in the API and UI rather than simply absent.

## 10. Exact data that is OBSERVED

Per-ad: `externalAdId`, `advertiserName`, `format`, `regions` (when the vendor discloses them), `firstSeenAt`/`lastSeenAt` (system-derived from our own check history, never attributed to the vendor as a claimed campaign date — see Sub-phase D's epistemic audit, unchanged). Aggregate: current active ad count, real historical deltas (new/removed/continuously-active) once `hasEnoughHistory` is true, last-checked time.

## 11. Exact data that is UNAVAILABLE

Product-level ad-to-product matching (`productMatching`, and consequently every ad's `matchedProduct`/`matchConfidence`/`destinationUrl`, which remain structurally present in the type — preserving existing behavior — but always resolve to `null`/`UNAVAILABLE` in practice). Ad spend, impressions, conversions — no field pretends otherwise anywhere in the codebase, confirmed by grep as well as by design.

## 12. Recommendation for future product-level ad matching

Unchanged from Sub-phase D: the path forward is either confirming a higher SerpApi plan tier discloses destination URLs (your own follow-up, still open) or evaluating a different data source specifically for that capability. Nothing in this sub-phase's work forecloses either option — `productMatching`'s reason string and the per-ad `destinationUrl`/`matchedProduct` fields are exactly where a future fix would plug back in, unchanged in shape from what Sub-phase C already built.
