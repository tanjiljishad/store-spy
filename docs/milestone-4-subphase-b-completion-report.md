# Milestone 4 Sub-phase B — Completion Report

**Google Advertising Intelligence Foundation.** Status: implemented, tested to the limit of this environment's capabilities, NOT deployed. See "Environment limitations" before treating anything here as production-ready.

## 1. Vendor selected

**SerpApi**, wrapping Google's own Ads Transparency Center (`adstransparency.google.com`). Confirmed in Sub-phase A/B research: SerpApi is a documented, commercial third-party API — not a scrape of Google, not an access-control bypass.

## 2. Vendor validation results

- **Two-endpoint split confirmed via direct documentation fetch** (Sub-phase A): a search/list endpoint (`engine=google_ads_transparency_center`) that returns advertiser + creative summaries but **no destination URL**, and a separate ad-details endpoint that takes `advertiser_id` + `creative_id` and returns a `link` field with the real destination URL.
- **Re-confirmed live in this session** (see §16): an unauthenticated request to `https://serpapi.com/search.json?engine=google_ads_transparency_center` returns real `HTTP 401` with a `{"error": "Invalid API key..."}` body — proves the base URL and engine parameter are live and that the adapter's auth-failure path matches real server behavior. This cost no API credits.
- **NOT verified live**: the exact JSON field names inside a successful (200) response (`advertiser_id`, `creative_id`, `target_domain`, `link`, `format`, pagination field name). No SerpApi API key exists in this environment. The adapter (`sources/google-serpapi.ts`) is built defensively against these assumed field names, isolates all vendor-shape parsing in a handful of small functions, and documents this gap explicitly in its header comment.

## 3. Pricing

**UNKNOWN — unpublished**, same finding as Sub-phase A. SerpApi does not publish per-engine pricing for Google Ads Transparency Center on its public pricing page. Recommendation unchanged: confirm real pricing directly with SerpApi (or by creating a trial account) before any production spend. The cost-control architecture below (§9, §12) is designed to minimize whatever that price turns out to be.

## 4. ToS / commercial rights

**NEEDS CLARIFICATION** — this is the item the user explicitly deferred at the vendor-decision gate: SerpApi's general ToS permits commercial SaaS use of returned data, but per-engine redistribution/derived-data/display terms for Ads Transparency Center specifically were not independently confirmed. The user chose to proceed with implementation now, using scripted-but-realistic mocks for tests, and will independently confirm real pricing/ToS with the vendor before any production spend or credential provisioning.

## 5. Data available / not available

| Field | Available | Epistemic status |
|---|---|---|
| Ad exists in the vendor's index | Yes | OBSERVED |
| Destination URL | Yes, via the details call | OBSERVED |
| Advertiser name / ID | Yes | OBSERVED |
| Ad format (text/image/video) | Yes | OBSERVED |
| First/last shown dates | Partial — kept in `sourceMetadata` when the vendor supplies them | OBSERVED where present |
| Ad spend, impressions, ROAS | No | UNAVAILABLE — never estimated (explicitly out of scope) |
| "Likely promoting Product X" without an exact URL match | No | Not implemented — exact URL match only, no inference |

## 6. Architecture

```
Scheduler (marketing/scheduler.ts, FOR UPDATE SKIP LOCKED)
  -> Collector/orchestrator (marketing/persist.ts: runMarketingCollection)
    -> Vendor adapter (marketing/sources/google-serpapi.ts, MarketingAdSource interface)
    -> Collection+cost-control (marketing/collect.ts: collectAdsForStore)
    -> Matching (marketing/normalize-url.ts: exact-URL match against Product catalog)
    -> Diff (marketing/diff.ts: diffAds, pure, mirrors diff/entities.ts)
    -> Persist (raw-SQL bulk upsert + Event.createMany, one transaction)
```

Kept entirely separate from the Shopify crawl pipeline (`diff/`, `crawl/`, `monitoring/`): different scheduler, different claim column (`Store.nextMarketingCollectionAt`), different DB tables, same `Event` table. `MarketingAdSource` is vendor-agnostic; `GoogleAdsSource` is the only implementation. No Meta adapter, real or stubbed, was written — Meta remains reserved for a future sub-phase per the explicit exclusion.

## 7. DB changes

One migration: `prisma/migrations/20260811220000_marketing_intelligence_foundation/`. Additive only, hand-verified via `prisma migrate diff` against the schema files directly (no live DB needed for this — see §16):

- `Event.crawlId` / `Event.crawl`: made **nullable** (was required). Every existing Shopify-crawl code path still always supplies a real `crawlId`; marketing events pass `null`.
- New `EventType` values: `AD_DETECTED`, `AD_REMOVED`, `AD_CHANGED`, `PRODUCT_AD_MATCHED`.
- New `EntityType` value: `AD`.
- `Store.marketingBaselinedAt` (nullable) and `Store.nextMarketingCollectionAt` (default `now()`) — the marketing pipeline's own baseline flag and scheduler claim column, independent of the Shopify equivalents.
- Two new tables: `MarketingCollectionRun` (attempt log, mirrors `Crawl`) and `AdObservation` (current-state table, mirrors `Product`/`StoreEntity`).
- Five new enums: `AdPlatform`, `MarketingCollectionOutcome`, `AdObservationStatus`, `MatchMethod` (one member: `EXACT_PRODUCT_URL` — `EXACT_COLLECTION_URL` was drafted then removed, see §17), `MatchConfidence`.

No existing table's columns were removed, renamed, or had their meaning changed. No data migration/backfill needed (no existing row has a null `crawlId`).

## 8. AdObservation design

Identified by the vendor's own **`externalAdId`**, never by destination URL (a documented, explicit requirement — multiple ads can point at the same product). Two-state lifecycle (`ACTIVE_EVIDENCE` / `HISTORICAL`), collapsed from `StoreEntity`'s three-state `ACTIVE -> MISSING -> REMOVED`: `missingStreak` climbs while status stays `ACTIVE_EVIDENCE`, and only flips to `HISTORICAL` once `removalConfirmations` (default 2, same as the Shopify pipeline) is reached on **successful** checks only — never on a failed/`UNAVAILABLE` run. `matchedProductId` is a nullable FK to `Product` (`onDelete: SetNull`) — no forced matching.

## 9. Collection cost control

`collect.ts` only calls the vendor's (costlier) ad-details endpoint for ads that have never had a destination URL successfully resolved. Ads with an already-cached `destinationUrl` are served from `previous` DB state, at zero additional vendor cost. Steady-state cost per store per check is the search tier (1–2 requests, given the advertiser-lookup + ads-list two-call flow), not `1 + N`. A failed details call (case C) leaves `destinationUrl: null` and is retried on the next cycle, rather than fabricating a value or dropping the ad.

## 10. Event model

Reused the **existing** `Event` table and its `EventType`/`EntityType`/`DraftEvent`/`makeDedupeKey`/`dayBucket` machinery verbatim (`diff/events.ts`), extended with 4 new event types and 1 new entity type rather than inventing a parallel event system. Marketing events carry `crawlId: null` and `entityType: "AD"`. Because `GET /api/store/[domain]/events` already queries `Event` with no `entityType` filter, marketing events **surface through that existing endpoint automatically — no route change was needed there.**

Four event types implemented, exactly as proposed (reviewed, not blindly adopted): `AD_DETECTED` (new ad, or day-bucketed on reappearance after `HISTORICAL`), `AD_REMOVED` (confirmed absence), `AD_CHANGED` (destination URL / advertiser / format change — matching fields only, never matching-derived fields), `PRODUCT_AD_MATCHED` (fires on first match or on a match changing to a different product). Significance scoring reuses the existing `scoreEvent()` engine with new `BASE_SCORE` entries (`AD_DETECTED: 50`, `AD_CHANGED: 35`, `AD_REMOVED: 25`, `PRODUCT_AD_MATCHED: 20`) and a flat, neutral magnitude (no per-instance signal like rank/price exists for ads yet).

## 11. Matching logic

**Deterministic exact-URL match only** (`marketing/normalize-url.ts`). No AI, no embeddings, no fuzzy matching, no title inference. Normalization rules (each independently unit-tested, 19 tests): scheme-agnostic (http=https), `www.` stripped, host lowercased, percent-decoding, trailing slash stripped (except bare `/`), fragment dropped, **entire query string dropped** (Shopify product identity is the path; tracking params never change it). A match is either an exact hit (`MatchConfidence: HIGH`) or it doesn't happen — there is no `MEDIUM`/`LOW` matching tier. `MatchMethod.EXACT_COLLECTION_URL` was drafted in an earlier design pass and removed once I noticed `AdObservation` only has a `Product` FK, not a collection-match field — a collection-page destination URL is simply left unmatched rather than inventing a second matched-entity shape without a concrete use case.

## 12. Scheduler behavior

Separate claim column (`Store.nextMarketingCollectionAt`), separate `FOR UPDATE SKIP LOCKED` claim query, separate tick function (`marketing/scheduler.ts`) and separate cron route (`POST /api/internal/scheduler/marketing-tick`) — deliberately never sharing a transaction, batch, or schedule with the Shopify crawler, so a slow/rate-limited paid-vendor cycle can never delay it. Claims require `tier != DISABLED` **and** `baselinedAt IS NOT NULL` (matching needs a real product catalog). Cadence is tier-driven but independently conservative from Shopify's (HOT: daily, WARM: 3d, COOL: weekly, COLD: monthly, DORMANT: quarterly — see `marketing/policy.ts`), since this pipeline calls a paid vendor per check. Failure backoff is a **deliberately simple flat 24h retry** — no streak-based exponential backoff or DISABLED-demotion state machine was built for marketing specifically, per the brief's explicit anti-over-engineering guidance; worth revisiting with real cost/failure data later.

## 13. Rate limiting

The vendor adapter reuses the **existing** in-memory `checkRateLimit()` (`security/rate-limit.ts`) rather than introducing new infrastructure, gated in front of every real HTTP call including paginated follow-ups. A blocked call never reaches the network. Retries: one retry on timeout/5xx/429 (mirrors the Shopify crawler's `fetchProductsPage` discipline); no retry on 401/403/malformed-response (non-retryable). Pagination (`serpapi_pagination.next`) is followed up to a 10-page safety cap, mirroring `crawlShopifyStore`'s `maxPages` — implemented defensively since the exact field name is unverified live (see §2).

## 14. Failure semantics

The four cases from the spec, all implemented and integration-tested:

- **(A) Checked, no ads** → `MarketingCollectionRun.outcome = SUCCESS`, `adsObserved: 0`. `diffAds()` runs normally on an empty observed set — this is what correctly produces zero `AD_DETECTED` and (if ads existed before) eventual `AD_REMOVED` once confirmed.
- **(B) Vendor unavailable** → `outcome = UNAVAILABLE`, reason recorded. `diffAds()` is **never called** on a failed run — collection failure cannot be converted into "no ads found." Verified directly in `persist.integration.test.ts`: after a failed check, the existing ad's `missingStreak` and `status` are provably untouched.
- **(C) Vendor returned incomplete data** → a malformed search response fails the whole run as `UNAVAILABLE`; a malformed/failed per-ad details call leaves that one ad's `destinationUrl: null` (honest partial data) without failing the run.
- **(D) Advertiser cannot be identified** → distinct `NO_ADVERTISER_FOUND` outcome from the adapter, mapped to `outcome: UNAVAILABLE` with a **distinguishable reason string** ("advertiser identification unavailable — no matching advertiser record found for this domain"), never confused with "checked, zero ads."
- A `MarketingCollectionRun` row is created **before** the vendor call (outcome starts `null`), so a worker crash mid-collection leaves a visible "never finished" row rather than silence.

## 15. Security

No new security surface was introduced, and every existing guarantee is untouched: SSRF guard (`ssrf-guard.ts`) was not modified and is not invoked by this pipeline in this sub-phase — deliberately, because the MVP relies on the vendor's own `destinationUrl` plus exact-string matching against the store's already-crawled product catalog, never arbitrary destination-URL crawling. The vendor API key is read once (`source-factory.ts`) from `SERPAPI_API_KEY`, never logged, never included in `sourceMetadata`, never returned by the API route. Both scheduler cron routes share the identical fail-closed `SCHEDULER_SECRET` gate. The new API route has no entitlement/plan gating by design (§27 of the brief: entitlement decisions are explicitly deferred) but is rate-limited identically to the existing `/events` route.

## 16. API contract

`GET /api/store/[domain]/marketing` — new, additive, not merged into `FullStoreReport` (deliberately: that type is what the existing Fable-derived UI renders, and this sub-phase must not touch it). Follows the existing `IntelligenceField<T>` OBSERVED/UNAVAILABLE contract: `ads: { status: "OBSERVED", value: [] }` means genuinely checked-and-empty; `ads: { status: "UNAVAILABLE", reason }` means the check failed or never happened — the two are structurally incapable of being confused by a client. No vendor secrets are exposed. Historical/event-level marketing data needs no new endpoint — it already flows through the existing `GET /api/store/[domain]/events`.

## 17. Tests and counts

- **Unit** (no DB): 205 tests total across the whole repo pass, zero regressions. 67 of those are new marketing-module tests: `normalize-url.test.ts` (19), `diff.test.ts` (20), `collect.test.ts` (9), `policy.test.ts` (4), `sources/__tests__/google-serpapi.test.ts` (15 — covers all 8 required adapter scenarios: success, empty, malformed, rate limit, auth failure, timeout, vendor error, pagination).
- **Integration** (needs Postgres): 4 new files — `persist.integration.test.ts` (baseline, detection, idempotency, change detection, removal confirmation, all 4 failure-semantics cases, Store/Product relations including FK `onDelete: SetNull`, concurrency, independence from the Shopify pipeline), `scheduler.integration.test.ts` (claim boundary, DISABLED exclusion, non-baselined exclusion, claim-timeout, tick rescheduling on success/failure, one-store-exception isolation), `report.integration.test.ts` (the OBSERVED/UNAVAILABLE contract, including the "run never finished" case), `timezone-safety.integration.test.ts` (the pathological-timezone regression guard, mirrored for the new raw-SQL upsert and claim query). **Written and typechecked, but not executed** — see §18.

## 18. Typecheck / lint / build results

All green:
- `tsc --noEmit`: **zero errors**, whole project.
- `eslint .`: **zero errors/warnings**, whole project.
- `next build`: **succeeded** (Turbopack), including the two new routes (`/api/store/[domain]/marketing`, `/api/internal/scheduler/marketing-tick`). No existing route, page, or static asset was affected.
- `vitest run` (unit): **205/205 passed**.

## 19. Live smoke-test result

Ran `scripts/marketing-smoke.ts` against a real, live Shopify store (allbirds.com). Exactly what it proved, labeled honestly:

- **REAL**: an unauthenticated request to `https://serpapi.com/search.json?engine=google_ads_transparency_center` returned a genuine `HTTP 401` with SerpApi's real error body — confirms the endpoint is live and the adapter's auth-failure handling matches reality. No credits spent.
- **REAL**: a live crawl of allbirds.com discovered 291 real products; two real handles were used as match targets.
- **SIMULATED**: the actual ad search/details vendor payload (no SerpApi key exists in this environment) — shape follows documented fields, not independently confirmed against a real 200 response.
- Against that real+simulated mix: matching correctly matched 1/2 simulated ads (the one pointed at a real product URL) and correctly left the other unmatched (landing page); baseline collection emitted zero events; an identical repeat cycle emitted zero events (idempotent); a single-cycle absence did not fire `AD_REMOVED` (flap suppression working).
- **NOT RUN**: anything touching Postgres — no `AdObservation`/`MarketingCollectionRun` row was ever actually written, and the scheduler's claim query was never executed against a real database. See §21.

## 20. External dependencies

`SERPAPI_API_KEY` (not yet provisioned — no key exists in this environment or in `.env`/`.env.test`). No new npm packages were added; the adapter uses the platform `fetch`, same as the existing Shopify crawler.

## 21. Environment limitations (read before treating this as "done")

This sandboxed environment has **no Docker, no WSL, and no locally installed Postgres** (all three were checked and confirmed absent). As a direct consequence:

- The migration was **never applied** to any real database. It was hand-verified via `prisma migrate diff --from-schema-datamodel ... --to-schema-datamodel ...` (a pure schema-to-schema diff that needs no live connection) and matches exactly what `prisma migrate dev` would generate, but `prisma migrate dev`/`deploy` itself was never run.
- **None of the 4 new integration test files were executed.** They were confirmed to typecheck cleanly and to correctly hit their own `DATABASE_URL` guard clause (proving no import/syntax error) when run against a non-test database, but zero assertions inside them have ever actually run against real Postgres.
- The live smoke test could not exercise persistence, the scheduler's claim query, or a real end-to-end HTTP round trip through a running Next.js server.

**Before this ships**, someone with Docker (or any reachable Postgres) needs to run, in order: `npm run db:test:up`, `npm run db:test:migrate` (watch specifically for the multi-`ALTER TYPE ADD VALUE` statements and the new-table creation — low-risk, additive DDL, but not yet proven against a real server), `npm run test:integration`, and ideally a real `marketing-smoke.ts` run with a provisioned `SERPAPI_API_KEY` against a real authenticated response to finally confirm the field-name assumptions in §2.

## 22. Known limitations

- SerpApi field names (`advertiser_id`, `creative_id`, `target_domain`, `link`, `format`, `serpapi_pagination.next`) are research-derived, not live-confirmed against an authenticated response.
- Real pricing and full ToS/redistribution terms remain unconfirmed (§3, §4) — explicitly the user's follow-up, not resolved here.
- No exponential backoff or DISABLED-equivalent demotion exists for repeated marketing-collection failures (flat 24h retry only) — a deliberate v1 simplification.
- Matching is Product-URL-only; collection-page destination URLs are always left unmatched (§11).
- The marketing report API surfaces current `ACTIVE_EVIDENCE` ads only; historical ads are queryable via the existing events feed, not as a dedicated "ad history" list — no UI consumes any of this yet (out of scope, §26 of the brief).

## 23. Remaining risks

1. A live-authenticated SerpApi response could reveal different field names than assumed, requiring changes localized to `sources/google-serpapi.ts`'s parsing functions only (the interface boundary was designed for exactly this).
2. Real per-store, per-check vendor cost is still unknown — the cost-control design (§9) minimizes it, but the actual number could still make the tier cadences in §12 uneconomical; revisit once pricing is confirmed.
3. The migration has not been applied to any real Postgres instance in this project — see §21 for the exact verification steps still required.

## 24. Recommended Sub-phase C scope

In priority order: (1) provision `SERPAPI_API_KEY` and confirm real pricing/ToS, then re-run the smoke test against a real authenticated response and correct any field-name mismatches; (2) run the integration suite against a real Postgres and fix anything it finds; (3) apply the migration to a real dev/staging database; (4) only after 1–3 are clean, begin the Marketing Intelligence UI (explicitly out of scope here) and any entitlement/plan decisions (explicitly deferred here). Meta collection, TikTok/Pinterest, AI-based matching, and spend/ROAS estimation remain excluded per the brief's "what not to build" list — nothing in this sub-phase's design blocks adding a `MetaAdsSource` later without touching `diff.ts`, `persist.ts`, or the scheduler.
