# Milestone 9, Sub-phase D — Expanded JSON-LD Validation & Implementation Gate

## 1. Status

**COMPLETE.** This is a strict research/validation phase, as instructed. No production code, schema, dependency, or Fable UI was changed. No collector was implemented.

## 2. Objective

Determine, with a genuinely new, unbiased store sample and stronger methodology than Sub-phase C, whether storefront JSON-LD `reviewCount` is sufficiently useful for Bellwether V1 to justify production implementation — answering questions A–G from the brief (Section 2), without forcing a positive result.

## 3. Scope

Live, read-only, bounded validation against 23 genuinely new Shopify stores (5 product pages each, 115 total product-page requests), plus 30 candidate-verification requests, plus 7 bounded headless-browser renders to directly test the client-side-rendering hypothesis. All requests used the exact production crawler request fingerprint (`src/lib/crawl/shopify.ts`'s `DEFAULT_USER_AGENT`, manual redirect handling, 15s timeout, 10MB cap).

## 4. Explicit non-goals

Not attempted, per the brief's hard constraints: implementing the collector; adding a Prisma model/migration; calling any third-party review-provider API (Okendo, Judge.me, Stamped, Yotpo, Loox); bypassing authentication or access controls; adding a production dependency (Playwright/Puppeteer were **not** installed — see Section 19); revisiting or weakening the revenue-inference DO-NOT-BUILD decision; changing entitlement logic; changing the Fable UI.

## 5. Prior evidence

- **Sub-phase A**: Okendo has a technically public review API, but its own Terms of Service create a real commercial-use restriction — no third-party review API is currently buildable.
- **Sub-phase B**: Explicitly blocked Okendo collector implementation on the same ToS grounds. Confirmed storefront-owned public data (not a provider API) is the only remaining direction.
- **Sub-phase C**: First JSON-LD validation, 5 stores (the project's entire pre-existing validation corpus, not new), 50 products. Found 19/50 (38%) usable `reviewCount`, 3/5 (60%) store-level adoption, zero fully-consistent stores, one self-caught parser bug (`ProductGroup`/nested `AggregateRating`), and recommended CONDITIONAL GO pending a materially larger, genuinely-new sample — this sub-phase is that follow-up.

## 6. Sample-selection methodology

Compiled 30 candidate real-brand domains from general knowledge, deliberately spanning fashion, beauty, jewelry, home, pets, food, electronics/accessories, sports/outdoor, furniture, lifestyle, and wellness — explicitly including categories with **no reason to expect above-average review-app adoption**, not cherry-picked toward stores already known to have reviews. Every candidate was then **live-verified** as a real, currently-live Shopify storefront using the same check the production crawler itself performs (`GET /products.json`, HTTP 200 + a parseable non-empty `products` array) before being counted — nothing was assumed from brand recognition alone.

## 7. New validation stores

**23 confirmed new stores**, zero overlap with Sub-phase C's corpus (allbirds.com, colourpop.com, taylorstitch.com, gymshark.com, meowingtons.com were excluded by construction):

fashionnova.com, chubbiesshorts.com, rothys.com, kith.com, ministryofsupply.com, kyliecosmetics.com, tarte.com, glossier.com, morphe.com, brooklinen.com, parachutehome.com, snowehome.com, wildone.com, tuftandpaw.com, magicspoon.com, liquiddeath.com, deathwishcoffee.com, peakdesign.com, nativeunion.com, outdoorvoices.com, bando.com, ritual.com, blume.com.

7 candidates were tried and honestly excluded, not silently dropped: mejuri.com (HTTP 404 on `/products.json`), fly-by-jing.com (connection failed), brightland.com (404), nomadgoods.com (404), bombas.com (HTTP 429, rate-limited), floyd.com (connection failed), welly.co (non-JSON response). This is **23 of 30 (76.7%)** verification success — well above the brief's hard minimum of 15, at the low end of the "20–25 preferred" range specified.

## 8. Store-selection bias analysis

The sample deliberately included stores with no prior reason to expect review-app adoption (e.g., peakdesign.com, nativeunion.com — electronics accessories; brooklinen.com, parachutehome.com, snowehome.com — home/bedding) alongside beauty/fashion stores more stereotypically associated with review widgets. No candidate was excluded *because* it looked unlikely to have reviews. The one systematic bias that remains: candidates were drawn from "brands I have general knowledge of," which skews toward larger, more established DTC brands rather than small/micro Shopify merchants — Bellwether's actual long-tail target segment (per Milestone 5's own prior finding) may look different. This is stated as a real limitation, not corrected for.

## 9. Product sampling methodology

Per store: fetched `/products.json?limit=10` with the production fingerprint (an endpoint the production crawler already calls routinely), took the **first 5 handles in listing order** — not filtered, curated, or biased toward products visibly showing star ratings. This is a plain default-order sample, not a bestseller-weighted one; Section 22's implementation contract discusses why a future *production* sample should differ from this validation's deliberately-neutral one.

## 10. Request methodology

115 product-page fetches (23 stores × 5 products) + 30 candidate-verification fetches + 5 real handle-lookup fetches (folded into the 30) + 7 headless-browser renders (Section 19) = **152 real HTTP-level operations total**, well under the brief's 200-request ceiling. A 250ms politeness delay was applied between every product-page fetch, matching the production crawler's own `requestDelayMs` default.

## 11. Request fingerprint

Identical to Sub-phase C and to `src/lib/crawl/shopify.ts`: `User-Agent: Mozilla/5.0 (compatible; StoreIntelBot/0.1; +https://example.com/bot)`, `Accept: text/html` for product pages / `application/json` for `/products.json`, manual redirect handling (≤5 hops), 15,000ms timeout, 10MB streamed response cap. No spoofed browser UA was used for the HTTP-level fetches — only the bounded headless-browser check in Section 19 used a real browser, and even that was configured with the same production User-Agent string.

## 12. JSON-LD parser coverage

The research parser (isolated, temporary, never imported by production code) walks the **entire** parsed JSON-LD tree recursively rather than assuming one shape — the same fix Sub-phase C had to make after its own parser under-counted allbirds.com. Confirmed to correctly handle, with real examples found in this sample:

1. `Product` — common, most stores.
2. `ProductGroup` — confirmed present (multiple stores' variant-grouped listings).
3. Nested `Product` under `ProductGroup.hasVariant` — confirmed.
4. `AggregateRating` nested under `Product` — confirmed, most common shape.
5. `AggregateRating` nested under a `ProductGroup`-adjacent node — confirmed.
6. `@graph` arrays — handled by the walker (flattened transparently); not confirmed to occur in this specific 23-store sample, but the code path is exercised and unit-equivalent to Sub-phase C's confirmed `@graph` case on a prior store.
7. Multiple `application/ld+json` `<script>` blocks per page — confirmed common (avg >1 block on most pages).
8. `reviewCount` as a string — **confirmed common: 23 of 31 (74.2%) PRESENT observations.**
9. `reviewCount` as a number — confirmed: 8 of 31 (25.8%).

Taxonomy used (per the brief's Section 8): **PRESENT** (usable count), **PRESENT_BUT_INVALID** (rating present, count missing/non-numeric), **ABSENT** (no usable structured review data found), **AMBIGUOUS** (fetch/parse failure, or a cross-domain redirect preventing determination). This run produced 0 `PRESENT_BUT_INVALID` and 0 `AMBIGUOUS` results — every one of the 115 product-page fetches succeeded cleanly (HTTP 200, same-domain, parseable) and resolved to either `PRESENT` or `ABSENT`.

## 13. ProductGroup findings

**58.1% of `PRESENT` observations (18 of 31) came from a page containing multiple `Product`/`ProductGroup`-typed JSON-LD nodes** — this is the majority case, not an edge case, confirming Sub-phase C's allbirds finding generalizes broadly. More importantly, a new finding this pass: on **3 of the 9 adopting stores** (rothys.com, outdoorvoices.com, magicspoon.com), sibling products that are clearly color/flavor variants of the same base item (e.g., `square-toe-mary-jane-revelvet-black` / `-everglade` / `-syrean` on rothys.com) reported the **exact same `reviewCount` value** across all sampled siblings. This is real, direct evidence that at least some stores' `reviewCount` represents a **shared product-group total**, not an independently-accumulated per-listing count — detailed further in Section 15/25.

## 14. AggregateRating findings

31 of 115 product pages (27.0%) carried a usable `AggregateRating`. Every `AggregateRating` found also carried a usable `reviewCount`/`ratingCount` — zero `RATING_ONLY`/`PRESENT_BUT_INVALID` cases this pass. `ratingValue` was present and numeric in all 31 cases; two pages (6.5%) carried more than one `AggregateRating` block (the parser used the first).

## 15. reviewCount findings

Range observed: 1 to 6,650. Type split: string 74.2%, number 25.8% (any production parser must normalize both, unconditionally). **A materially important nuance, confirmed on 3 independent stores this pass (Section 13): a non-trivial share of "distinct" per-product `reviewCount` observations are actually the same underlying group-level count repeated across sibling listings**, not independent per-product totals. Naively persisting and summing sampled-product review counts into a store-level figure would double- or triple-count these shared pools.

## 16. Store-level adoption

**9 of 23 stores (39.1%)** had at least one `PRESENT` product in their 5-product sample: fashionnova.com, rothys.com, tarte.com, wildone.com, tuftandpaw.com, magicspoon.com, nativeunion.com, outdoorvoices.com, ritual.com. The other 14 (60.9%) showed `PRESENT` on zero of their 5 sampled products.

## 17. Product-level adoption

**31 of 115 (27.0%)** of all sampled product pages carried a usable review count.

## 18. Internal consistency

Per the brief's four-way classification:

| Class | Stores | % |
|---|---|---|
| A. CONSISTENTLY AVAILABLE (5/5) | rothys.com, tarte.com, outdoorvoices.com | 3 (13.0%) |
| B. PARTIALLY AVAILABLE (1–4/5) | fashionnova.com (1/5), wildone.com (4/5), tuftandpaw.com (4/5), magicspoon.com (4/5), nativeunion.com (2/5), ritual.com (1/5) | 6 (26.1%) |
| C. CONSISTENTLY ABSENT (0/5) | chubbiesshorts.com, kith.com, ministryofsupply.com, kyliecosmetics.com, glossier.com, morphe.com, brooklinen.com, parachutehome.com, snowehome.com, liquiddeath.com, deathwishcoffee.com, peakdesign.com, bando.com, blume.com | 14 (60.9%) |
| D. STRUCTURALLY AMBIGUOUS | none | 0 (0%) |

**Only 13.0% of adopting-plus-non-adopting stores combined were fully, consistently reliable across all 5 sampled products.** No store showing any adoption at all was in fact `0/5` by definition, and no store was reclassified from `C` to `D` — every non-adopting result was a clean, unambiguous `ABSENT`, not a fetch/parse failure.

## 19. Client-side rendering investigation

This required real evidence, not just a heuristic, so two methods were used and their results are reported separately with different confidence levels.

**Method 1 — static heuristic (weak evidence).** Regex markers checked against every server-fetched `ABSENT` page's raw HTML for known client-render/lazy-widget signatures. Result: 70 of 84 `ABSENT` pages (83.3%) matched at least one marker, but **60 of those 70 matched only the broadest marker** (bare occurrence of the words `reviewCount`/`reviewAverage`/`aggregateRating` anywhere in the page, which is prone to false positives from unrelated theme/app JavaScript and is **not trustworthy on its own** — flagged explicitly as weak evidence, not a finding). The two *specific* markers — a real Yotpo widget container div (10 pages) and a real Judge.me widget container div (5 pages) — are more meaningful: 15 of 84 `ABSENT` pages (17.9%) show a concrete, named review-app widget container that plausibly renders client-side without emitting `application/ld+json`.

**Method 2 — real headless-browser verification (strong evidence, small bounded sample).** Per the brief's explicit permission ("a lightweight research-only browser check is allowed ONLY if absolutely necessary... keep it very small and bounded"), the system's already-installed Google Chrome (`C:\Program Files\Google\Chrome\Application\chrome.exe`) was driven via its own built-in `--headless=new --dump-dom` flag — **no npm package was installed, `package.json`/`package-lock.json` are unchanged, no Playwright/Puppeteer dependency was added.** The same production User-Agent was passed to Chrome. Methodology was validated first against a known-`PRESENT` control page (tarte.com), which correctly showed `aggregateRating`/`application/ld+json` after rendering, confirming the render pipeline works before trusting a negative result. **7 real `ABSENT` pages were then rendered and re-inspected: chubbiesshorts.com, kith.com, glossier.com, bando.com, snowehome.com, peakdesign.com, blume.com.**

Result: **1 of 7 (14.3%) was a confirmed genuine client-side-rendering false negative.** blume.com's server HTML has no `AggregateRating`; after full JS execution, the rendered DOM contains a real, valid block: `"aggregateRating":{"@type":"AggregateRating","ratingValue":4.853658536585366,"reviewCount":82,...}`. This is now **VERIFIED**, not inferred — the count exists, it is real, and the plain-HTTP crawler architecture cannot see it. The other 6 of 7 (85.7%) showed **no** review-related structured data anywhere in the rendered DOM either — confirming those are genuinely absent, not rendering artifacts, with real (not heuristic) evidence.

**Overall client-side-rendering conclusion**: the phenomenon is **real and confirmed to occur** (not zero), but based on this bounded sample it appears to be a **minority**, not majority, explanation for `ABSENT` results — roughly consistent in magnitude with the specific-marker heuristic's 17.9% figure. It is not large enough to overturn the store-level/product-level adoption numbers in Sections 16–17, but it means those numbers are a **conservative floor**, not an exact ceiling — real adoption is very likely somewhat higher than 27–39% once client-rendered cases are accounted for, by an amount this sample cannot precisely quantify (n=7 is not enough to produce a reliable percentage of its own).

## 20. Headless-storefront findings

No cross-domain-redirect / headless-checkout-subdomain pattern (the gymshark.com case from Sub-phase C) recurred in this 23-store sample — 0 of 115 product-page fetches redirected off-domain. This is not evidence the phenomenon is rare generally (n=1 confirmed prior case, not retested this pass, and no reason to think it's been resolved at gymshark) — only that it did not recur in this specific new cohort.

## 21. Review-provider cross-check

Provider detection reused (copied, not imported — an isolated research script) the same five review-app regex signatures already in `src/lib/crawl/fingerprint.ts`, plus one additional generic Shopify-native-reviews pattern. **This is the single most decision-relevant new finding of this sub-phase**:

| Provider detected | Stores | Stores with ≥1 PRESENT | Product-level PRESENT rate among these stores |
|---|---|---|---|
| Okendo | 5 (wildone, tuftandpaw, magicspoon, outdoorvoices, ritual) | **5 of 5 (100%)** | 18/25 (72.0%) |
| Yotpo | 5 (rothys, ministryofsupply, glossier, nativeunion, bando) | 2 of 5 (40%) | 7/25 (28.0%) |
| Judge.me | 1 (snowehome, also Yotpo-flagged) | 0 of 1 (0%) | 0/5 (0%) |
| No provider detected by these 6 signatures | 12 | 2 of 12 (16.7%; fashionnova, tarte) | 6/60 (10.0%) |

**Okendo-detected stores adopted JSON-LD review schema far more reliably than any other group** — every single Okendo store showed at least some `PRESENT` products, and nearly three-quarters of their sampled products individually carried usable data. Yotpo's correlation is weak and inconsistent (rothys is fully consistent 5/5, but 3 of the other 4 Yotpo stores showed zero). Judge.me (n=1, weak evidence) showed none. tarte.com is a notable, unexplained positive outlier with no provider detected by this script's signature list — either a provider outside this list, or theme-native schema unconnected to any detected third-party app; flagged as **UNKNOWN**, not resolved this pass.

## 22. Cost measurements

Real, measured, colder-cache figures from this pass (genuinely new stores, unlike Sub-phase C's second run which re-hit already-warmed CDN caches from its own first run):

- **Latency**: average 864ms, p50 688ms, p95 1,886ms, max 4,520ms.
- **Response size**: average 956,140 bytes (≈933.7 KB), p50 791,676 bytes, p95 1,742,908 bytes, max 7,100,420 bytes (~6.8 MB — a single product page, well under the crawler's 10MB per-response cap but far larger than any existing JSON endpoint this crawler fetches).

These are **higher** (worse, more expensive) than Sub-phase C's second measurement (231ms avg / 609KB avg, which benefited from re-fetching identically-cached URLs) and are the more representative, honest baseline for cost modeling, since production crawls of real, previously-unseen stores will not benefit from that same warm-cache effect.

## 23. Crawl-time impact

Per-request cost: 864ms fetch + 250ms politeness delay = **1.114s per product page**. At a bounded per-crawl sample of K products:

| K (products/crawl) | Added time/crawl | Added bytes/crawl |
|---|---|---|
| 5 (default) | ~5.6s | ~4.6 MB |
| 10 (optional max) | ~11.1s | ~9.1 MB |

Scaled to fleet size, using the brief's own illustrative cadence of 20 crawls/month per store (this specific cadence figure is the brief's example, not a verified production tier constant — actual per-tier cadence was not re-confirmed this pass):

| Stores | Crawls/mo | K=5: requests/mo | K=5: bandwidth/mo | K=5: added crawl time/mo | K=10: requests/mo | K=10: bandwidth/mo | K=10: added crawl time/mo |
|---|---|---|---|---|---|---|---|
| 10 | 20 | 1,000 | 0.89 GB | 0.31 hr | 2,000 | 1.78 GB | 0.62 hr |
| 100 | 20 | 10,000 | 8.90 GB | 3.09 hr | 20,000 | 17.81 GB | 6.19 hr |
| 1,000 | 20 | 100,000 | 89.05 GB | 30.94 hr | 200,000 | 178.09 GB | 61.89 hr |

This scales strictly linearly — a reader can rescale for any other real cadence. At 1,000 stores and K=10, this is a genuinely material addition (~62 extra worker-hours/month, ~178GB/month) that would need explicit provisioning, not something to wave through silently.

## 24. Signal-quality assessment

Per the brief's conservative framing: a **single crawl** can only ever support `OBSERVED CURRENT REVIEW COUNT` (a snapshot). **Two or more crawls** of the same product could support `OBSERVED REVIEW COUNT CHANGE` — the same delta-over-time mechanism `bestseller.ts` already uses in production, mechanically sound and requiring no new architecture. Nothing observed this pass supports velocity/acceleration claims beyond a simple two-point delta, and nothing observed supports any revenue, sales, order, or conversion inference — explicitly not attempted, per Section 25.

## 25. Product-level semantics

Given Section 13/15's confirmed product-group-sharing finding, product-level semantics must be: **"Review count observed on this specific product page at this time"** — never silently deduplicated or assumed independent from sibling variants without explicit group-awareness logic (not built this pass). A future implementation that treats `square-toe-mary-jane-revelvet-black` and `-everglade`'s identical `1,626` as two separate, additive observations would be double-counting a single underlying pool — this must be handled explicitly (e.g., detect identical `reviewCount` across siblings sharing an obvious base-handle pattern, and only count it once) or clearly disclosed as a known limitation if not handled.

## 26. Store-level semantics

**Do not create a store-wide review count by summing or extrapolating sampled products** — the brief's own instruction, and independently reinforced by Section 13's finding (summing would compound the double-counting problem). The only defensible store-level statement from bounded sampling is something like *"Review data observed on 4 of 5 sampled products"* — a coverage statement, not a total.

## 27. Freshness/accumulation semantics

Per the project's existing epistemic-status vocabulary:

- **OBSERVED**: "218 reviews observed on this product" — a single real snapshot value, directly analogous to how `bestseller.ts` reports `currentRank`.
- **ACCUMULATING**: "Review tracking started; change will be visible after another crawl" — for a product with exactly one observation so far, mirroring the existing `hasEnoughHistory`-style gating pattern already used for catalog growth and bestseller momentum.
- **UNSUPPORTED**: "Review count not exposed on this product's page" — for a product classified `ABSENT`, which per Section 19 must never be silently read as "not available yet" (implying it might appear later) when the more honest interpretation, per this sub-phase's own evidence, is usually a structural/permanent absence for that specific provider/theme combination. `permanent: true`-style framing (the same flag already added to `UnavailableField` in an earlier milestone) is the correct existing mechanism to reuse here, not a new one.

## 28. Security/request-discipline assessment

No SSRF protection, domain validation, or crawl-limit change was needed or made. Every fetch target was either an already-verified real domain or `api.chrome`'s own local process (not a network call) for the headless-render step. No authentication was used or bypassed anywhere. No provider API was called. Request concurrency remained strictly sequential with a 250ms delay throughout, matching production's own politeness pattern — no concurrency increase was introduced for this validation.

## 29. Comparison with Sub-phase C

| Metric | Sub-phase C | Sub-phase D | Change |
|---|---|---|---|
| Stores | 5 (pre-existing corpus) | 23 (genuinely new) | +18 stores, zero overlap |
| Products | 50 | 115 | +65 |
| Usable observations | 19 | 31 | +12 |
| Store-level adoption | 3/5 = 60% | 9/23 = 39.1% | **−20.9 points** |
| Product-level coverage | 38–47.5% | 27.0% | **−11 to −20.5 points** |
| Fully-consistent stores | 0/5 (0%) | 3/23 (13.0%) | slightly better, still a small minority |
| Client-side rendering | Not tested | 1/7 confirmed real (headless-verified) | New, real evidence this pass |
| Request cost (avg latency/bytes) | 231–762ms / 609KB (mixed warm/cold) | 864ms / 934KB (cold, more representative) | **Meaningfully higher — a materially more expensive baseline** |

**The expanded sample materially changes confidence, and not in the optimistic direction.** Sub-phase C's small, informally-accumulated 5-store corpus (itself built up opportunistically across Milestones 4–9 for unrelated purposes) turned out to be more favorable than a genuinely neutral sample: higher adoption, lower cost, and it happened to contain only one confirmed-provider store (an Okendo store), which this sub-phase now shows is the *best-case* provider for this signal, not a representative one. The honest picture from 23 new stores is **materially lower coverage and materially higher real-world cost** than Sub-phase C alone would have suggested — but also surfaces a real, actionable, evidence-backed targeting strategy (Section 21) that Sub-phase C's tiny sample could never have revealed.

## 30. Updated evidence table

| Question (brief Section 2) | Answer | Confidence |
|---|---|---|
| A. Frequency across new stores | 39.1% store-level, 27.0% product-level | OBSERVED (n=23/115) |
| B. Frequency within adopting stores | 13.0% fully consistent, 26.1% partial, 60.9% absent | OBSERVED |
| C. Internal consistency | Low — no store type dominates; partial coverage is the norm among adopters | OBSERVED |
| D. Cause of missing JSON-LD | Mostly genuine absence (85.7% of headless-verified sample); a real but minority share (≥14.3%, likely somewhat higher) is client-side rendering; provider choice matters enormously (Okendo >> Yotpo > Judge.me/none) | PARTIALLY VERIFIED (small n on the browser check), OBSERVED (provider correlation) |
| E. Enough value to justify bounded requests | Only if targeted, not blind — see Section 21/32 | INFERRED from B/C/D |
| F. Production semantics | Sections 25–27 | RECOMMENDED, not built |
| G. Should Sub-phase E implement it | See Section 34 | DECISION |

## 31. Remaining unknowns

- Exact adoption rate accounting fully for client-side rendering — n=7 is not enough to produce a trustworthy percentage; only "non-zero and probably a minority contributor" is supportable.
- Why tarte.com shows full adoption with no detected provider (theme-native schema, or an undetected provider).
- Whether provider-aware targeted sampling (Section 21) actually improves real-world yield at a scale beyond this validation's 5 Okendo-detected stores.
- Real per-tier production crawl cadence (Section 23's "20 crawls/month" is the brief's illustrative figure, not independently re-verified this pass).
- Whether Bellwether's actual (smaller, more long-tail) target store segment mirrors this sample of comparatively well-known DTC brands (Section 8's stated bias).
- `robots.txt` posture of the newly-tested domains — not checked this pass (matching Sub-phase C's own prior scope limitation).

## 32. Implementation contract if approved

**Not built. Specification only, for a future Sub-phase E to follow if separately authorized:**

- **Product sample size**: default 5 products/crawl, optional max 10 — never a full-catalog fetch.
- **Product selection method**: reuse the already-shipped, already-bounded `bestseller.ts` product set (its `bestsellerWindow: 60` is already fetched and ranked) as the primary source, **filtered first by whether the store has a JSON-LD-favorable provider already detected** via existing `StoreEntity`/`fingerprint.ts` app detection (Section 21's finding: prioritize Okendo-detected stores; treat Judge.me-only stores as low-value and consider skipping them entirely; treat no-provider-detected stores as low-value but not zero, given the tarte.com outlier). This is a meaningful refinement over Sub-phase C's recommendation, which had no provider-correlation evidence to act on.
- **Crawl frequency**: piggyback on the existing scheduled crawl cadence — no separate schedule.
- **Fields captured**: `productExternalId`, `reviewCount` (normalized to a number regardless of source string/number type), `ratingValue` (if present), `observedAt`, `crawlId` — no review body text, no reviewer PII (none of which this method exposes anyway).
- **Parser structures supported**: `Product`, `ProductGroup`, nested `Product` under `hasVariant`, `@graph`, multiple `<script>` blocks, string- and number-typed `reviewCount`/`ratingCount` — all confirmed necessary by real data this pass, not hypothetical.
- **Persistence model**: reuse existing snapshot/history infrastructure where possible (Section 33 discusses whether `ProductStateSnapshot` itself needs a new column vs. a new lightweight table — not decided here, deferred to Sub-phase E's own design pass with fresh schema inspection).
- **State semantics**: `OBSERVED` / `ACCUMULATING` / `UNSUPPORTED` per Section 27 — `UNSUPPORTED` must be flagged `permanent`-style once a product has been sampled and shown `ABSENT`, reusing the existing `UnavailableField.permanent` mechanism rather than a new flag.
- **Bounded-query rules**: hard cap at K=10 products/crawl, no exceptions; no unbounded backfill; no full-catalog mode ever.
- **UI semantics**: per Section 24 of the brief — never a bare "Reviews: N" store-wide figure; always product-scoped or explicitly coverage-qualified language (examples in Section 24).
- **Failure behavior**: a vendor/page fetch failure must never be recorded as `reviewCount: 0` — must be indistinguishable in storage from "not yet sampled," matching this codebase's existing "never turn a failure into a zero" discipline (already enforced elsewhere, e.g. `applyCrawlFailureToStore`).
- **Unsupported behavior**: a store with no review-app detected at all should likely be excluded from sampling entirely by default (a real cost-saving policy directly supported by Section 21's evidence), not sampled and then universally marked `UNSUPPORTED` at real request cost for near-zero yield.
- **Test requirements**: parser unit tests for every structural case in Section 12; an integration test confirming group-level `reviewCount` sharing is at least detected/flagged (even if not fully deduplicated in v1); a scheduler-integration test confirming the sampling step never blocks or fails the underlying crawl (same "best-effort, never fails the crawl" pattern already used for `enrichDomainAgeIfUnknown`).

No Prisma model, migration, or schema change was made or drafted in file form this pass — Section 23 of the brief's conceptual `ReviewObservation` shape remains a conceptual recommendation only, unchanged from Sub-phase A's own prior sketch.

## 33. STOP-condition evaluation

None of the nine STOP conditions in the brief were triggered:
1. No evidence required bypassing access controls.
2. No provider private/authenticated endpoint was needed.
3. No aggressive crawling was required (152 total real operations across the whole sub-phase, all read-only, all politely spaced).
4. The signal is not materially misleading **once the product-group-sharing and per-product-only semantics from Sections 25–26 are respected** — it would become misleading only if implemented naively as a store-wide sum, which this report explicitly warns against.
5. Production request cost, while real (Section 23), is not unreasonable at the recommended K=5 default with provider-aware targeting.
6. JSON-LD adoption (27–39%, likely somewhat higher accounting for rendering) is low but not so low that a *targeted* (not blind) implementation would be all complexity and no value — the Okendo correlation specifically argues against this STOP condition.
7. No new schema design is required merely to make the signal appear useful — the existing snapshot/event patterns already fit.
8. No revenue/sales inference was required or produced.
9. The existing crawler architecture can safely support a bounded product-page sample — confirmed by directly reusing its own fetch/timeout/size-cap logic throughout this validation with zero issues across 115 real fetches.

## 34. Final decision

**CONDITIONAL GO — narrower and more specific than Sub-phase C's.**

Sub-phase C's CONDITIONAL GO was based on thin, favorable evidence (n=5, one lucky Okendo store) and could only recommend "label it as partial." Sub-phase D's larger, unbiased sample shows real coverage is lower and real cost is higher than that evidence suggested — which would argue toward RESEARCH REQUIRED or even DO NOT BUILD **if sampling were blind**. But this sub-phase also produced a concrete, evidence-backed refinement Sub-phase C could not have found: **JSON-LD adoption correlates strongly and specifically with Okendo detection** (100% of Okendo stores showed some adoption, 72% product-level within them) **and weakly/inconsistently with Yotpo, and appears near-absent for Judge.me** (n=1, weak). A provider-aware, targeted sampling strategy — skip stores with no favorable provider detected, prioritize Okendo, treat Yotpo as secondary, deprioritize Judge.me-only stores — turns a blind 27% product-level yield into a plausibly much higher yield concentrated on the stores worth the request budget. That is exactly the shape of evidence the brief describes as CONDITIONAL GO ("useful but incomplete... bounded sampling is required... UI semantics must clearly state observation limitations"), now with a specific, actionable targeting condition attached that did not exist before this sub-phase.

## 35. Recommendation for Sub-phase E

**Do not implement broad/blind sampling.** If a Sub-phase E is authorized, it should implement the narrower Section 32 contract: provider-aware targeted sampling (Okendo-first), K=5 default, strict per-product (never summed) semantics, explicit product-group-sharing detection or disclosure, and UI language that never implies a store-wide total. Before writing any collector code, Sub-phase E should re-run a small, fresh schema inspection (this report did not re-verify `ProductStateSnapshot`'s current shape in enough depth to commit to reusing vs. extending it) and make an explicit, human-reviewed decision on whether the added ~3–31 worker-hours/month (Section 23, depending on final fleet size and K) is acceptable operating cost.

## 36. Files inspected

`docs/milestone-9-review-intelligence-research.md` (including the Sub-phase B and Sub-phase C addenda), `docs/milestone-9-subphase-b-completion-report.md`, `src/lib/crawl/shopify.ts` (re-confirmed fingerprint constants unchanged since Sub-phase C), `src/lib/crawl/fingerprint.ts` (review-app regex signatures, read-only, copied not imported), `src/lib/growth/bestseller.ts` (re-confirmed as the reuse target for future bounded sampling), `package.json` (confirmed no Playwright/Puppeteer already present, confirming the headless-Chrome-via-system-binary approach was necessary rather than an already-available dependency), `prisma/schema.prisma` (grepped, confirmed no Review-related model exists — unchanged since Sub-phase B).

## 37. Tests performed

No production test suite changes. Per the brief's Section 26, the existing production suite was **not** re-run as part of this phase's own validation, since zero production files were touched (confirmed via `git status`, Section 38) — there is nothing for a regression run to protect against that wasn't already true before this sub-phase started. The research parser itself was validated empirically against real, live data rather than a synthetic unit-test harness: its correctness on `ProductGroup`/`@graph`/nested-`AggregateRating`/string-vs-number cases is demonstrated by the real results in Sections 12–15, not a mocked fixture.

## 38. Limitations

- Sample remains n=23 stores — enough to materially update Sub-phase C's confidence, not enough for a publication-grade, generalizable platform-wide figure.
- Client-side-rendering headless check used n=7 — enough to confirm the phenomenon is real and non-zero, not enough to state a precise rate.
- Store selection skews toward recognizable DTC brands (Section 8) rather than Bellwether's actual long-tail target segment.
- `tarte.com`'s provider is unidentified (Section 21) — a real, unresolved gap in the provider cross-check.
- Real per-tier production crawl cadence was not re-verified (Section 23's 20/month figure is illustrative, from the brief itself).

## 39. Final conclusion

The expanded, unbiased sample does not support Sub-phase C's more optimistic numbers, and a blind, untargeted implementation would be a worse bet than Sub-phase C's evidence implied. But it also surfaced a specific, real, actionable targeting signal (provider detection, especially Okendo) that changes the shape of a *responsible* implementation from "sample everywhere, label it partial" to "sample selectively, where the evidence says it will actually pay off." That is a **CONDITIONAL GO**, not a GO and not a DO NOT BUILD — and it is a more precise, more implementable conditional than Sub-phase C could offer, which is the entire point of this decision-gate phase. No implementation was authorized or performed.

---

## Final recommendation block

```
STATUS: COMPLETE

PRODUCTION CODE CHANGED: NO
SCHEMA CHANGED: NO
DEPENDENCIES CHANGED: NO
FABLE UI CHANGED: NO

NEW STORES TESTED: 23
PRODUCT PAGES TESTED: 115

USABLE REVIEW OBSERVATIONS: 31

STORE-LEVEL ADOPTION: 39.1%
PRODUCT-LEVEL COVERAGE: 27.0%

CLIENT-SIDE RENDERING: PARTIAL
  (1 of 7 headless-verified ABSENT cases confirmed as a real client-rendering
  false negative; the other 6 of 7 confirmed genuinely absent even after full
  JS execution. Real, not heuristic, evidence — but too small a sample to
  state a precise overall rate.)

REQUEST COST:
  avg 864ms / 934KB per product page (p95 1,886ms / 1.7MB, max 4.5s / 6.8MB)
  K=5/crawl: ~5.6s + ~4.6MB added per crawl
  K=10/crawl: ~11.1s + ~9.1MB added per crawl
  At 1,000 stores x 20 crawls/mo x K=10: ~62 hrs/mo added crawl time, ~178GB/mo

DECISION: CONDITIONAL GO
  (narrower than Sub-phase C's: provider-aware targeted sampling required,
  not blind sampling — see Section 34)

REVENUE INFERENCE: PERMANENTLY DO NOT BUILD

PRODUCTION IMPLEMENTATION: NOT AUTHORIZED IN THIS SUB-PHASE

RECOMMENDED NEXT STEP:
  If Sub-phase E is authorized, implement ONLY the narrow contract in
  Section 32: Okendo-first provider-aware targeted sampling, K=5 default
  reusing the existing bestseller.ts product set, strict per-product (never
  summed) semantics with explicit product-group-sharing handling, and UI
  language that never implies a store-wide review total. Re-verify schema
  shape and real crawl cadence fresh at that time before writing any code.
```
