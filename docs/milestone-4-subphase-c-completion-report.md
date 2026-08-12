# Milestone 4 Sub-phase C — Completion Report

**Production Verification + Google Marketing Intelligence Integration.** Status: implemented, verified against a real database and a real (unauthenticated) vendor endpoint, wired into the existing Store Intelligence UI, and confirmed end-to-end in a real browser. Real vendor *responses* remain unverified — no `SERPAPI_API_KEY` exists in this environment. Read §5 and §16 before treating this as production-ready.

## 1. What was already present (Sub-phase B)

Schema (`AdObservation`, `MarketingCollectionRun`, 5 enums, nullable `Event.crawlId`, `Store.marketingBaselinedAt`/`nextMarketingCollectionAt`), the vendor-agnostic `MarketingAdSource` interface + `GoogleAdsSource`/SerpApi adapter, pure `diffAds()`, cost-controlled `collect.ts`, transactional `persist.ts`, a separate scheduler + cron route, `GET /api/store/[domain]/marketing`, and `report.ts`. 205 unit tests existed. None of this was redesigned; it was verified, then extended.

## 2. What was changed in this sub-phase

- **Real-database verification** of everything Sub-phase B could only claim, not prove (§5).
- **One real bug found and fixed** — in a test, not application code (§16).
- **`report.ts`**: `AdView.matchedProductId: string` → `matchedProduct: { id, handle, title } | null` (joins `Product`), so the UI never needs a second lookup to show a real product name. `MarketingReport.ads` narrowed from the general `IntelligenceField<T>` union to `ObservedField<T> | UnavailableField` — marketing data is deterministic-only in this product (§10 of your brief), so the type now says that instead of merely behaving that way.
- **`ChangeFeedTimeline.tsx`**: two new optional, backward-compatible props — `eventTypes` (already-supported server-side filter, just not exposed before) and `steadyEmptyState` (override copy for a filtered feed, since "this store has been steady" is the wrong claim for an advertising-only view). Both existing call sites (general Shopify feed) pass neither and are byte-for-byte unaffected.
- **New file `AdvertisingSummary.tsx`** (`src/components/analysis/`, not `src/components/marketing/` — that directory is unrelated landing-page marketing, a naming collision worth flagging so nobody merges the two later).
- **New file `event-types.ts`** — the 4-item marketing `EventType` list, shared by both integration points instead of duplicated.
- **Two integration points wired**, each an identical 3-line addition (`SectionLabel` + `AdvertisingSummary` + filtered `ChangeFeedTimeline`): `dashboard/stores/[domain]/page.tsx` and `components/analysis/FullReportView.tsx`. No existing section in either file was touched, reordered, or restyled.

## 3. Files changed

```
prisma/schema.prisma                                    (no changes this sub-phase — already correct)
src/lib/marketing/report.ts                              modified (matchedProduct join, narrower ads type)
src/lib/marketing/event-types.ts                          new
src/lib/marketing/__tests__/persist.integration.test.ts   modified (idempotency test bug fix)
src/components/analysis/ChangeFeedTimeline.tsx            modified (2 new optional props)
src/components/analysis/AdvertisingSummary.tsx             new
src/app/dashboard/stores/[domain]/page.tsx                 modified (+8 lines, additive section)
src/components/analysis/FullReportView.tsx                  modified (+10 lines, additive section)
```

No file outside this list was modified. No Fable-derived component was restyled, reordered, or removed.

## 4. Database changes

**None new.** Sub-phase B's migration (`20260811220000_marketing_intelligence_foundation`) was applied as-is to a real PostgreSQL 18.4 instance (§5) — no schema drift, no corrections needed.

## 5. Real database verification — the headline result

The prior report said this was blocked: no Docker, no WSL, no native Postgres in this sandbox. That conclusion was incomplete — it only checked for a Postgres *server distribution*, not an embedded *binary*. I found and used `embedded-postgres` (npm), which bundles genuine PostgreSQL binaries (Windows x64 build exists) and runs them as a real local process — not a mock, not `pg-mem`. Installed with `--no-save`/uninstalled afterward specifically so it never becomes part of this project's actual infrastructure (per your explicit instruction not to invent new DB architecture) — `docker-compose.test.yml` remains the one documented, real path for contributors with Docker. Verified clean before and after: zero references to it survive in `package.json` or `package-lock.json`.

Procedure, using the project's own **unmodified** scripts throughout:
1. Started real Postgres 18.4 on port 5433 with the exact credentials `.env.test` already expects, and the exact `--encoding=UTF8 --locale=C` flags `docker-compose.test.yml` documents (confirmed necessary: a first attempt without them reproduced the *exact* WIN1252-encoding failure that file's comment warns about, on the first event headline containing "→" — real proof the flags matter, not decoration).
2. `npm run db:test:migrate` — all 7 migrations, including the marketing one, applied cleanly.
3. `npm run test:integration` — first run: **8 failures**, all traced to the encoding misconfiguration in step 1 (a harness bug, not an app bug). Fixed the harness, re-ran.
4. Second run: **3 failures** — 2 were cross-test-file flakes (passed cleanly both isolated and on 2 subsequent full re-runs — cold-start noise, not a real defect) and **1 was a real, reproducible bug in my own test** (§16). Fixed it.
5. Final state, reproduced 3 times consecutively for stability: **152/152 integration tests pass, 205/205 unit tests pass** — 357/357 total, against a real database.

## 6. UTC database safety

Verified live, not just unit-tested: `firstSeenAt`/`lastSeenAt` on `AdObservation` (via `persist.ts`'s raw-SQL upsert) and the `nextMarketingCollectionAt` claim boundary (via `scheduler.ts`'s raw-SQL claim query) were both exercised under a real Postgres session pinned to `Asia/Kathmandu` (UTC+5:45 — a fractional offset an hour-rounding bug can't accidentally survive), using the project's existing dedicated-connection-plus-`SET TIME ZONE` pattern. Both passed. No raw SQL in the marketing pipeline was found to violate the `AT TIME ZONE 'UTC'` rule — it was already correct in Sub-phase B. No existing UTC test was weakened, removed, or had its assertions loosened.

## 7. Real vendor verification status

**Vendor integration remains unverified against a real authenticated response** — `SERPAPI_API_KEY` does not exist anywhere in this environment (`.env`, `.env.test`, or the shell), confirmed by direct check, not assumed. I did not fabricate a successful vendor test and did not create fake credentials.

What *was* verified live, real, and free: an unauthenticated request to `https://serpapi.com/search.json?engine=google_ads_transparency_center` returns a genuine `HTTP 401` with SerpApi's real error body (`"Invalid API key..."`) — confirming the endpoint is live and reachable, and that the adapter's 401/auth-failure handling path matches real server behavior. This costs no API credits and was re-confirmed in this sub-phase (same result as Sub-phase B). Everything past authentication — exact JSON field names in a real 200 response — remains research-derived, not independently confirmed, exactly as disclosed before.

## 8. Real vendor response findings

None new — no authenticated call was possible. See Sub-phase B's report §2 for what was verified via documentation.

## 9. Marketing matching behavior

Confirmed live, twice, against a real crawled catalog: a real allbirds.com crawl (291 real products) was matched against 3 scripted ad summaries. The ad whose destination URL was `https://allbirds.com/products/mens-wool-runners-natural-white` (a real, live product path) matched with `HIGH` confidence and resolved to the real product's real title ("Men's Wool Runner - Natural White (Cream Sole)") — not a placeholder. The ad pointed at an unrelated landing page correctly matched nothing. Deterministic exact-URL matching only, unchanged from Sub-phase B; no fuzzy/AI/image matching exists anywhere in this codebase.

## 10. Scheduler behavior

Unchanged from Sub-phase B, re-verified against real Postgres in this sub-phase: separate claim column, separate cron route, `tier != DISABLED AND baselinedAt IS NOT NULL` gating, tier-driven cadence (HOT: daily … DORMANT: quarterly), flat 24h failure backoff. Never merged with the Shopify crawler's scheduler.

## 11. Event behavior

Confirmed live: a genuinely new ad correctly fired `AD_DETECTED` + `PRODUCT_AD_MATCHED` exactly once; a repeat cycle with no changes fired nothing (idempotent); a single missed check did not fire `AD_REMOVED` (flap suppression). Marketing events use the **existing** `Event` table with `entityType: "AD"` and `crawlId: null` — confirmed live that they surface automatically through the pre-existing `GET /api/store/[domain]/events` feed with zero route changes, and are correctly excludable/includable via the existing (previously unused) `?types=` filter.

## 12. API changes

One behavioral extension, zero new endpoints: `GET /api/store/[domain]/marketing`'s response shape gained `matchedProduct: {id, handle, title}` in place of a bare `matchedProductId` string (§2). No entitlement gate was added — confirmed with you directly: fully open to any user who has analyzed the store, matching how every other report section behaves today (the existing `ADVANCED_INTELLIGENCE` capability exists but is wired to nothing anywhere in this app, and stays that way — not touched, not newly used).

## 13. UI changes

One new section, "Advertising intelligence," added identically to both places the existing report renders (dashboard page + post-analyze view): three `IntelligenceCard`s (Ads observed / Products matched / Last checked — reusing the exact existing OBSERVED/UNAVAILABLE badge component, zero new visual vocabulary), a matched-products list styled like the existing timeline list items, and a second `ChangeFeedTimeline` instance filtered to the 4 marketing event types. Verified live in a real Chromium browser against the real database (screenshots taken, not just asserted): the "not checked yet" `UNAVAILABLE` state renders correctly right after a fresh analyze, and after running a real (scripted-vendor) collection against the same store, the section correctly switches to live `OBSERVED` data — real counts, a real product title, real relative timestamps — with **zero visual distinction** from the surrounding Store Overview / Business Intelligence sections. No typography, color, spacing, card style, or navigation was changed anywhere.

## 14. Security verification

No new security surface. SSRF guard untouched and not invoked by this pipeline (unchanged design decision from Sub-phase B — matching is against the already-crawled catalog, not arbitrary destination-URL fetching). Vendor key read once server-side (`source-factory.ts`), never logged, never reaches the browser — confirmed by inspecting the actual network responses during live browser testing: the marketing API response contains only normalized fields, no vendor metadata beyond the small `sourceMetadata` bag which itself never carries credentials. Rate limiting, auth, and entitlement checks all unchanged.

## 15. Tests

- **Unit** (no DB, mocked): 205 pass, unchanged from Sub-phase B.
- **Integration** (real DB, mocked vendor): 152 pass — **this sub-phase's main addition is that these are now proven to actually pass against real Postgres**, not merely typecheck.
- **Real HTTP, no vendor**: a real Next.js dev server, a real Chromium browser, real signup/login, a real crawl of a real live Shopify store (allbirds.com, 291 products) via `POST /api/analyze`'s real SSE flow — screenshots captured at each stage.
- **Real HTTP, real vendor**: **not performed** — no credentials. The one piece of the full chain (`Shopify store → Marketing collection → Real vendor → Normalization → Postgres → API → Store Intelligence`) that could not be exercised is specifically "Real vendor" — everything before and after it, including Postgres, the API, and the UI, was exercised with real infrastructure and a scripted-but-structurally-typed vendor response standing in for that one step.

## 16. Bugs discovered

1. **Test harness bug (mine, this sub-phase, not application code)**: `persist.integration.test.ts`'s idempotency test asserted that re-running a collection cycle right after baseline would produce events (`eventsWritten > 0`). Traced it: baseline suppresses events by design, and re-observing an *unchanged* already-known ad correctly produces zero events (that's the flap-suppression contract working, not a bug) — so the assertion was wrong, not the code. Root cause: the test never established a state that could legitimately *change*. **Fixed** by seeding a baseline, then running a cycle with a genuinely different `advertiserName` (the one field guaranteed fresh every cycle — `destinationUrl` is cost-cached once resolved, so it can't be used to force a change without a details re-fetch), confirmed the resulting `AD_CHANGED` event, then confirmed a repeat produces none. Re-ran 3 times for stability.
2. **Two transient flakes**, both in pre-existing (non-marketing) and marketing `timezone-safety.integration.test.ts` claim-boundary tests, both first-run-only and not reproducible on 3 subsequent runs (isolated and full-suite) — attributed to cold-start noise from the very first connection/migration cycle against a freshly initialized database, not a defect in `claimDueStores`/`claimDueStoresForMarketing`. No test code was changed for these; they simply pass reliably now.

## 17. Bugs fixed

Only #1 above required a code change (test-only, one file). No application code in `src/lib/marketing/` was found to be incorrect by this sub-phase's real-database and real-browser verification.

## 18. Known limitations

- Real vendor response shape remains unconfirmed (§7) — the single largest remaining risk, unchanged from Sub-phase B.
- Real SerpApi pricing/ToS remain unconfirmed — your explicit follow-up, not resolved here.
- `AD_CHANGED`'s destination-URL-comparison branch is effectively unreachable in the current cost-control design: `collect.ts` never re-fetches a resolved `destinationUrl` from the vendor, so an ad that genuinely changes its landing page after first resolution won't be caught unless the vendor also issues it a new `creative_id` (plausible for most ad platforms, not guaranteed). Worth a periodic slow-cadence re-verification pass in a later phase; not fixed here since it wasn't asked for and isn't free (it reintroduces the exact per-ad-per-cycle vendor cost the caching exists to avoid).
- The "Advertising intelligence" section shows only `ACTIVE_EVIDENCE` ads; historical (`HISTORICAL`) ads are visible via the timeline's individual events but have no dedicated "past ads" list view.
- No exponential backoff or DISABLED-equivalent demotion for repeated marketing-collection failures (flat 24h retry) — unchanged, deliberate Sub-phase B simplification.

## 19. Vendor pricing/ToS verification status

**Unchanged, still UNKNOWN/unpublished.** Not addressed in this sub-phase — outside its scope (production/DB verification + UI integration), and you already own this follow-up independently.

## 20. What remains before production

1. Provision `SERPAPI_API_KEY`, make one real authenticated call, confirm/correct the field-name assumptions in the adapter (isolated to `sources/google-serpapi.ts` by design).
2. Confirm real pricing and full ToS/redistribution terms with SerpApi.
3. Apply the migration to a real staging/production Postgres (the migration itself is now proven correct against a real server — this step is procedural, not exploratory).
4. Point a real cron/scheduler trigger at `POST /api/internal/scheduler/marketing-tick` with a real `SCHEDULER_SECRET`.
5. Decide whether the `AD_CHANGED` destination-URL limitation (§18) needs addressing before launch or can ship as a known gap.

## 21. Recommended next milestone

With Google/SerpApi now verified end-to-end except for the one vendor-credential gap, and the UI genuinely shipped (not just data-modeled), the natural next step is closing that one gap — a short, narrowly-scoped "Sub-phase D: live vendor confirmation" once credentials exist, rather than a new feature milestone. Everything explicitly excluded from Milestones 4B/4C (Meta, TikTok, Pinterest, AI matching, spend/ROAS estimation, entitlement changes) remains correctly deferred and architecturally unblocked — the vendor-agnostic `MarketingAdSource` boundary was verified clean in this sub-phase specifically so a future `MetaAdsSource` is additive, not a rewrite.
