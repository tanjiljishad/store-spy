# Milestone 4 Sub-phase D — Completion Report

**Real Vendor Integration, Validation & Production Readiness.** Status: real, authenticated vendor validation is now done — and it overturned a core assumption from Sub-phase A/B research. One product decision remains genuinely open and is explicitly not decided here (see §5, §21).

## 1. What was already present (Sub-phases B/C)

Full architecture: schema, vendor-agnostic `MarketingAdSource` interface, `GoogleAdsSource`/SerpApi adapter (built entirely from documentation, never live-tested), pure `diffAds()`, cost-controlled `collect.ts`, transactional `persist.ts`, scheduler, API, report contract, and a Marketing Intelligence UI section wired into the Store Intelligence page. 357/357 tests passing, verified against real Postgres in Sub-phase C.

## 2. What was changed in this sub-phase

- **Real SerpApi validation** — 19 authenticated live requests total, deliberately minimized once each question had a clear, reproducible answer.
- **`sources/google-serpapi.ts`: substantial correctness rewrite**, driven entirely by live evidence, not guesses:
  - Removed the two-step "find advertiser, then list ads" request model — the real API returns ads directly from one `text={domain}` call. `searchAdsForDomain()` now makes 1 request (was 2).
  - Fixed real field names: `ad_creative_id` (not `creative_id`), `advertiser` (not `advertiser_name`), `ad_funded_by` on the details endpoint (not `advertiser`), numeric `first_shown`/`last_shown` (not strings).
  - Fixed `extractAdDetails()` to read the real `search_information`/`ad_creatives[]` structure instead of a nonexistent `body.ad` wrapper.
  - Added real per-region breakdown (`regions[]`) to `sourceMetadata` — genuine, valuable vendor-disclosed data found live that Sub-phase A's research didn't anticipate.
  - Documented, with the full evidence trail, that **no destination/landing-page URL field exists** in any tested real response (§5).
  - Lowered `MAX_AD_PAGES` from 10 to 2 after live testing showed a real advertiser with 2000 `total_results`, which the old cap would silently walk 10 pages (400 ads, 10 requests) for on **every single collection cycle** (§7).
  - Added a real byte-size cap on response reads (5MB) — a genuine, previously-absent security gap, not present anywhere else in this codebase either (§10).
- **Adapter test suite rewritten** (20 tests, was 16) to match the confirmed real shape, plus new cases: multiple unrelated advertisers sharing one `target_domain`, defensive domain-mismatch filtering, the pagination-cap regression, and the oversized-response guard.
- **Matching, cost-control, scheduler-concurrency, and diff-engine re-verification** against real Postgres (multi-worker concurrency test, multi-ad-same-product test, 4 new URL-matching edge cases) — all confirmed correct, zero bugs found in these layers.
- **One real test bug found and fixed**: a fragile test helper reused the same `Response` object instance across more logical calls than it had scripted responses for, which broke once response reading switched to a stream reader (`.getReader()`) for the new size guard — `.json()` had apparently tolerated the reuse silently before. Fixed by scripting a distinct response per real call.
- **`.env.test.example`** documents `SERPAPI_API_KEY` (it didn't before — no `.env.example` existed for the main `.env` at all in this project).
- **No schema, UI, entitlement, or scheduler-architecture changes.**

## 3. Files changed

```
.env.test.example                                              modified (SERPAPI_API_KEY documented)
src/lib/marketing/sources/google-serpapi.ts                     modified (request model + field-name + cost fixes)
src/lib/marketing/sources/__tests__/google-serpapi.test.ts      modified (rewritten fixtures, +4 tests)
src/lib/marketing/report.ts                                     modified (epistemic-audit doc comment only, no behavior change)
src/lib/marketing/__tests__/normalize-url.test.ts                modified (+4 edge-case tests)
src/lib/marketing/__tests__/persist.integration.test.ts          modified (+1 multi-ad-same-product test)
src/lib/marketing/__tests__/scheduler.integration.test.ts        modified (+1 multi-worker concurrency test)
```

## 4. Vendor verification status — DONE, with a major finding

Real, authenticated. Confirmed: base URL live, both engines (`google_ads_transparency_center`, `google_ads_transparency_center_ad_details`) reachable and authenticating correctly, real advertiser data returned for a real, actively-advertising Shopify store (Allbirds — 40 ad creatives across text/image/video formats, 2 distinct advertisers sharing the domain).

**No false claim of full production verification**: pricing and full ToS/redistribution terms remain unconfirmed (§18) — that's still explicitly your follow-up, not resolved here.

## 5. Real vendor response findings — the core discovery

**The vendor does not return a destination/landing-page URL, for any ad format.** Confirmed across text, image, and video ad-details responses, plus a retry with an explicit `region` parameter to rule out gating. SerpApi's own published documentation (re-fetched live during this sub-phase) claims a `link` field exists "for text and image ads" — the real, authenticated response never contains it. A `link` field *does* appear on some search-response entries, but it's a Google `ads-integrity-transparency` **creative-preview rendering URL**, not a click-through destination — confirmed by inspecting its actual value, not assumed from the field name.

This is the exact STOP CONDITION your own Sub-phase B brief named explicitly ("vendor does not provide destination URLs"). It invalidates the deterministic exact-URL product-matching feature as designed — every real `AdObservation` will persist with `destinationUrl: null` and `matchedProductId: null`, forever, for this vendor.

**Real, valuable data confirmed to exist and now correctly extracted**: advertiser name (`advertiser`/`ad_funded_by`), ad format, `first_shown`/`last_shown` (real vendor-disclosed Unix timestamps — better than Sub-phase A's research expected), per-region breakdown with regional first/last-shown dates, and total-days-shown.

**Secondary finding**: multiple, unrelated advertisers can share the same `target_domain` (confirmed for both Allbirds and, independently, for claude.ai, where several apparently-unrelated individual advertisers' ads also targeted that domain). This adapter never assumes any one of them "is" the store — every ad's real, vendor-reported advertiser name is surfaced as-is.

I asked how you want to handle the matching-feature implication of this; you're checking your SerpApi plan/support first. **No scope change has been made** — the architecture, schema, and UI are untouched pending your answer. See §21.

## 6. Marketing matching behavior

Unchanged in design (deterministic exact-URL matching only, still correct and well-tested — 23 unit tests, including new redirect/collection-URL/variant-query/mixed-case edge cases). In practice, against this vendor, it will now always resolve to `matchedProduct: null` for real data, since there's no destination URL to match against. The matching *code* is not broken — the *input* it depends on doesn't exist for this vendor.

## 7. Scheduler behavior

Unchanged in design. Newly proven live against real Postgres with genuine parallel execution (not just sequential claim calls): two `runMarketingSchedulerTick()` calls racing the same 6-store due-pool simultaneously — every store claimed exactly once, **the vendor is never called twice for the same store**, exactly one `MarketingCollectionRun` per store per cycle.

## 8. Event behavior

Unchanged in design, re-verified. New explicit coverage: multiple distinct ads (different `externalAdId`) pointing at the same product all persist and match independently, no dedup collision — identity is `externalAdId`, never `destinationUrl`, exactly as designed.

## 9. API changes

None. `GET /api/store/[domain]/marketing`'s contract is unchanged.

## 10. UI changes

None this sub-phase — no Fable component touched, per your explicit constraint. (The Sub-phase C UI already renders the OBSERVED/UNAVAILABLE contract correctly regardless of whether `matchedProduct` is ever populated — it was already built to honestly show "no matched product" without matching being guaranteed to work.)

## 11. Security verification

- **Real gap found and fixed**: no response-size cap existed anywhere in this codebase's outbound HTTP layer (Shopify crawler included) before this sub-phase. Added a bounded stream-read (5MB) specifically to the vendor adapter, with a test proving it rejects cleanly rather than buffering unbounded.
- Traced every code path that could plausibly leak the API key (URL construction, error messages, `MarketingCollectionRun.reason`, `console.error` calls) — confirmed clean. The key is read once server-side (`source-factory.ts`), never logged, never reaches the browser, never appears in this report or its file names.
- No client component imports the adapter or key (confirmed by grep).
- SSRF guard remains untouched and uninvoked by this pipeline (unchanged design decision — no arbitrary destination-URL fetching happens or is planned).
- One residual, unmitigated risk noted rather than "solved": if the vendor's own error text ever echoed back request parameters (it doesn't, empirically, for the 401 case observed), that would be vendor-side behavior outside this codebase's control — consistent with how upstream error text is already handled elsewhere (Shopify crawl errors).

## 12. Tests — unit

214 pass (was 210 at the start of this sub-phase). New: 4 URL-matching edge cases (collection URLs, variant query params, click-tracking-redirect URLs, mixed-case stress case), 1 oversized-response guard test, 20 rewritten adapter tests (was 16 — now matching the real API shape, +4 net: multi-advertiser, domain-mismatch filter, pagination-cap regression, malformed-search_information).

## 13. Tests — integration

154 pass against real Postgres (via the same temporary embedded-binary approach as Sub-phase C — installed with `--no-save`, fully removed afterward, confirmed zero traces in `package.json`/`package-lock.json`). New: a genuine multi-worker concurrency test (two schedulers racing 6 stores in true parallel) and a multiple-ads-same-product persistence test.

## 14. Live smoke tests — distinguished precisely, per your instruction

- **Real HTTP, real vendor, mocked (structurally faithful) fixtures for automated tests**: the 20 adapter unit tests — mocked HTTP, but fixtures now mirror confirmed-real response shapes exactly.
- **Real HTTP, real vendor, real authentication, ad-hoc verification (not part of the automated suite)**: 19 live SerpApi calls total this sub-phase — 1 search (Allbirds), 3 ad-details (text/image/video), 1 region-param retry, 1 search (claude.ai, investigating the multi-advertiser/no-ads question), 1 doc re-fetch (free, not billed), and a final 12-request live-wiring test that ran the REAL adapter through the REAL `runMarketingCollection()` pipeline against REAL Postgres (capped to 2 ads' worth of detail calls by design — the cap didn't work as intended because pagination happens inside the adapter's own search step, which is exactly how the pagination cost bug in §2 was discovered). Real data persisted correctly: real advertiser name, real format, real region/timestamp metadata, correctly-null destination URL and match.
- **What was NOT done**: exhausting Phase 3's full 5-store test matrix (advertising store ✓, little/no-advertising store — attempted with claude.ai but it unexpectedly had ad activity too, so a clean "zero ads" response shape remains unconfirmed live; multi-product store ✓ via Allbirds; stable canonical URLs — moot given §5; repeated collection of the same store — proven via mocks, not live, to control cost). Given §5's finding already determines the main architectural question, I stopped rather than spend further real quota chasing the remaining matrix cells for diminishing information value — happy to run any of them if you want them specifically confirmed.

## 15. Bugs discovered

1. **Application bug (real, in the shipped adapter)**: the entire two-step request model, four field names, and the details-response parsing structure were wrong — Sub-phase B's documentation-only build never matched the real API. **Fixed** (§2).
2. **Application bug (real, cost-critical)**: `MAX_AD_PAGES = 10` would silently consume up to 10 requests per collection cycle, every cycle, for any advertiser with a large `total_results` — confirmed live at 2000 for a real store. **Fixed** (lowered to 2, with a regression test).
3. **Application bug (real, security)**: no response-size cap existed on the vendor adapter (or anywhere else in this codebase's HTTP layer). **Fixed** (§11).
4. **Test bug**: a `sequencedFetch` test helper's Response-object reuse broke once response reading became stream-based. **Fixed** (§2).
5. **Test bug** (from Sub-phase C, unrelated to vendor work): none new found in this sub-phase beyond what Sub-phase C already fixed.

## 16. Bugs fixed

All four above. No bug was found in `diff.ts`, `persist.ts`, `collect.ts`, `scheduler.ts`, or the report contract — every layer downstream of the adapter's normalized interface (`AdSummary`/`AdDetails`) was unaffected by the adapter rewrite, confirmed by the full integration suite passing unchanged.

## 17. Known limitations

- **Destination URLs are unavailable from this vendor** (§5) — the single largest limitation, affecting the product's core differentiator. Decision pending (§21).
- Real pricing/ToS remain unconfirmed (§18).
- A clean "genuinely zero ads" response shape was not confirmed live (§14) — both domains tested had some ad activity.
- `AD_CHANGED`'s destination-URL-comparison branch remains moot now that destination URLs never resolve — noted in Sub-phase C, unchanged.
- `MAX_AD_PAGES = 2` (80 ads/cycle) is a judgment call from one data point (Allbirds) — worth revisiting with more real usage data, not a settled number.

## 18. Vendor pricing/ToS verification status

**Still UNVERIFIED.** Not resolved in this sub-phase — genuinely your follow-up, requiring your SerpApi account/billing access, which I don't have.

## 19. What remains before production

1. **Resolve the matching-scope question** (§21) — you're checking your plan/support; I've made no architecture change pending that answer.
2. Confirm real pricing and full ToS.
3. Decide whether `MAX_AD_PAGES = 2` is the right steady-state depth once real cost data exists.
4. Apply the (unchanged) migration to a real staging/production Postgres.
5. Point a real cron trigger at the marketing scheduler tick route with a real `SCHEDULER_SECRET`.

## 20. Cost report — real request-count model, pricing still UNVERIFIED

Confirmed from real code + real live testing, not invented:

- **`searchAdsForDomain()`**: exactly 1 request per page fetched, up to `MAX_AD_PAGES` (now 2) — so **1–2 requests**, not the 2 Sub-phase B assumed (there is no separate advertiser-lookup call).
- **`getAdDetails()`**: 1 request per ad, called only for ads never previously resolved (cost-control layer, unchanged and confirmed working) — **but given §5, every call to this endpoint currently returns zero additional actionable value** (no destination URL ever comes back; `ad_funded_by`/`format`/`regions` are the only new data, and `format`/advertiser are already known from the search step). This is a concrete, immediate cost-saving opportunity: **while destination URLs remain unavailable, `getAdDetails()` could be skipped entirely**, cutting real per-store cost from `1–2 + N` (N = new ads that cycle) down to a flat `1–2` requests regardless of ad count. I have not made this change — it's entangled with §21's open question (if matching later becomes viable via plan upgrade, you'd want the calls back).
- **Real evidence this sub-phase changed the model materially**: a real advertiser (Allbirds) had 2000 historical `total_results` — large stores can have far more ads than the original "a few dozen" assumption. The pagination cap fix (§2) directly bounds this.
- **Steady-state monthly requests per store, current code** (2 search-tier requests/cycle, ads assumed already-resolved so 0 details calls in steady state): HOT (daily) ≈ 60/mo, WARM (3d) ≈ 20/mo, COOL (weekly) ≈ 8.6/mo, COLD (monthly) = 2/mo, DORMANT (quarterly) ≈ 0.67/mo.
- **Real structural cost-model risk, unchanged from what I flagged before real testing**: collection targets the whole corpus with no entitlement gate, so aggregate cost scales with *total unique stores ever analyzed by anyone* (BASIC's unlimited analyses included), not with paying-user count. This is now more urgent to resolve given §5 — paying per-request for a feature that currently can't attribute ads to products is a materially different cost/value tradeoff than paying for one that can.
- Dollar figures remain **UNVERIFIED** — I have not invented a price. The one lever this sub-phase's evidence puts entirely in your hands: whether `getAdDetails()` is worth calling at all right now.

## 21. Recommended next milestone — and the one open decision

Everything achievable without your input is done: real vendor validated, adapter corrected to match reality, cost bugs found and fixed, matching/scheduler/diff/security re-verified against real Postgres, 368/368 tests passing, typecheck/lint/build clean.

**What's left is entirely your call, not a technical one**: once you've checked your SerpApi plan/support about destination URLs, the two live paths are (a) ship marketing intelligence *without* product-level matching — advertiser presence, format, timing, and region remain genuinely valuable and fully working — or (b) a different vendor/data source is needed for the product-matching claim specifically. I'd recommend (a) as the default if support doesn't turn up a plan-tier fix, since it's real, honest, and already 90% built (the only work left would be quieting `getAdDetails()`'s now-pointless calls and adjusting the "Products Being Advertised" UI copy to not imply a guarantee it can't meet) — but that's a product call, not mine to make unilaterally.
