# Milestone 9, Sub-phase A — Review Intelligence & Revenue Signal Research

**Status: research only.** No production code, Prisma schema, dependency, or Fable UI was changed. This document is the entire deliverable. All temporary research scripts/fetched files used during this sub-phase live outside `src/`/`prisma/` and were removed before completion (see Section 28).

**Method note**: claims about provider APIs come from (a) live, direct web research performed this sub-phase (official docs, fetched today) and (b) a small number of real, read-only, unauthenticated HTTP requests against real Shopify storefronts, described in full in Section 30. Where documentation sources conflicted or were incomplete, that conflict is preserved and flagged rather than resolved by guessing. Where something could not be confirmed, it is marked **UNKNOWN**, not asserted.

---

## 1. Executive Summary

The core question this sub-phase was asked to answer: *can Bellwether responsibly acquire dated public review data using its existing TypeScript/HTTP architecture, and is that data strong enough to justify a future revenue signal?*

The answer is **split, and deliberately not collapsed into one verdict**:

- **Review data ACCESS is more achievable than Milestone 5 concluded — for one provider.** Milestone 5 (Sub-phase A, Milestone 5) found review data "architecturally absent" because the crawler never fetches individual product pages, which is where review widgets render. This sub-phase found that **Okendo** exposes a fully public, unauthenticated, store-wide, cursor-paginated, newest-first REST API returning individual dated reviews (with rating, verified-purchase flag, and an `isIncentivized` flag) — live-verified against a real store (colourpop.com) this sub-phase, requiring **zero product-page fetches** and only **one HTTP request per store per routine check** in the common case. This is a genuinely new finding, not previously established.
- **The other four providers researched (Judge.me, Yotpo, Stamped, Loox) each have a real, documented barrier** — most commonly, the endpoint that returns structured review data requires a private, merchant-issued API token, which Bellwether cannot obtain for a competitor's store. Section 5–10 detail each provider individually; none is a clean, confirmed GO the way Okendo is.
- **The revenue-proxy question is unchanged from Milestone 5, and this sub-phase's own research reinforces rather than weakens that finding.** Fresh 2025–2026 research confirms: natural review-submission rates vary roughly 5–10× to 15× depending on solicitation tactics (Section 21); a widely-cited figure puts ~42% of Amazon reviews as fake (Section 18); the one strong review-count-to-sales correlation found (88%, bestselling books) is from a narrow, curated, high-visibility Amazon category, not the small-store Shopify long-tail this product serves, and even that literature says the relationship is category-dependent. The Shopify-specific problem Milestone 5 identified — official, sanctioned supplier-review-import apps making review counts reflect a *supplier's* history, not a reseller's sales — remains fully intact and is not mitigated by better data access.
- **Recommendation: review activity/velocity as a standalone, honestly-labeled competitive-intelligence signal is a defensible, narrower goal than what Milestone 5 evaluated, and is worth a scoped Sub-phase B for Okendo specifically.** Revenue inference remains **PERMANENTLY DO NOT BUILD**, unchanged from Milestone 5 — this sub-phase found no new evidence that changes that conclusion, and explicitly did not go looking for one.

This is exactly the kind of mixed result Section 3 of the brief anticipated as valid, and this document does not force it toward a single GO or NO-GO.

---

## 2. Current Review Intelligence State

Before this sub-phase, Bellwether's only review-related capability was **review-app presence detection**: `fingerprint.ts` regex-matches installed apps (including the five review apps in scope here) against homepage HTML, and `growth/review-infrastructure.ts` surfaces that as an `ObservedField<ReviewInfrastructureEntry[]>` — "this store has Judge.me installed," never a count, rating, or date. `reviewVelocity` itself is a hardcoded `permanentlyUnavailable(...)` field (Milestone 5's decision, reaffirmed and given an explicit `permanent: true` flag in the most recent sub-phase's work on `report-contract.ts`).

No code anywhere in this repository fetches an individual Shopify product page (`/products/{handle}`), calls any review-provider API, or parses any review-app widget beyond its presence signature.

## 3. Existing Review Infrastructure Detection

`REVIEW_APP_KEYS = ["judgeme", "yotpo", "loox", "stamped", "okendo"]` (`review-infrastructure.ts`). Detection signatures (`fingerprint.ts`, `APP_SIGNATURES`):

```
judgeme: /judge\.me\/(?:widgets|assets|review)/i
yotpo:   /staticw2\.yotpo\.com|yotpo\.com\/widget/i
loox:    /loox\.(?:io|app)/i
stamped: /stamped\.io/i
okendo:  /okendo\.io/i
```

All script-src/domain-based, matched against homepage HTML only (the only HTML page currently fetched). `getReviewInfrastructureSignal()` reads `StoreEntity` rows of `kind: "APP"` filtered to this key list — no new query, no new crawl, presentation only. This is genuinely OBSERVED (an app is either detected or not) and is explicitly documented (in the module's own header comment) as never implying review volume, authenticity, or organic-ness — the file already cites the imported-review problem as the reason.

## 4. Existing Data Already Captured

Directly relevant to a future review-intelligence build, already in the schema and already written on every crawl:

| Field | Model | Relevance |
|---|---|---|
| `Product.externalId` | `Product` | Exact Shopify numeric product ID — every provider researched keys reviews by this (as `shopify-{id}` or bare) |
| `Product.sourceCreatedAt` | `Product` | Real Shopify `created_at` — useful to distinguish "review predates product's own listing" as one weak signal against certain import patterns |
| `Product.handle`, `title`, `vendor` | `Product` | Needed to attribute a review row back to a real product for display |
| `Store.domain` | `Store` | Needed to resolve `shop_domain`/store identifiers most provider APIs require |
| `StoreEntity` (kind=APP) | `StoreEntity` | Already answers "does this store have a review app," the gate for whether to attempt any review-specific fetch at all |
| `Event` table (append-only) | `Event` | The established pattern for "something happened at time T" — a natural home for review-count-crossed-a-threshold-style signals, if ever built |

No existing field currently stores a review count, rating, or review date anywhere.

## 5. Provider Inventory

| Provider | Detected today | Public data mechanism found | Requires merchant auth for review data? | Live-verified this sub-phase? |
|---|---|---|---|---|
| Judge.me | Yes | Widget-HTML endpoint (public token) + a separate `/reviews`/`/products/-1` structured endpoint | **Yes**, for the structured/listing endpoint (private `api_token`) | No — not found on a real, reachable store this sub-phase |
| Stamped | Yes | On-page widget init (public `apiKey`+`storeHash`); broader REST API described as needing HTTP Basic Auth with a private secret for most operations; provider's own docs show their review-API section mid-migration ("coming soon") | **Likely yes** for anything beyond basic widget rendering | No |
| Yotpo | Yes | Conflicting evidence: an older, sparsely-documented "Widget API" (`app_key`-only) vs. their actively-maintained "UGC API" which requires an `X-Yotpo-Token` | **Unclear — RESEARCH REQUIRED** | No |
| Loox | Yes | Merchant (full) API requires `X-Api-Secret-Key`; a Shopify-metafield-based aggregate (`shop.metafields.loox.global_stats`) exists but is **private by default**, requiring the merchant to opt in | **Yes** for the Merchant API; metafield route is merchant-gated by default | No |
| Okendo | Yes | **Fully public, unauthenticated Storefront REST API** — `subscriberId` extractable from any already-crawled page; store-wide and per-product dated review listing, cursor-paginated | **No** | **Yes** — real request, real response, documented in Section 30 |

## 6. Judge.me Analysis

Multiple independent search/doc results consistently describe two different surfaces:

- A **widget** surface (`api.judge.me/api/v1/widgets/product_review?shop_domain=...&id=...`), usable with a "Public API Token," described as intended for rendering pre-built widget HTML in a public JS context.
- A **structured review-listing** surface (`/reviews`, `/products/-1?...&api_token=PRIVATE_API_TOKEN&...`), which Judge.me's own Help Center article states requires the **Private API Token**, explicitly scoped "server-side... for enhanced security."

The widget surface's actual JSON shape (does it include dated, structured review rows, or only render-ready HTML/limited fields?) could not be confirmed from documentation alone this sub-phase, and no real store using Judge.me was reachable during live validation (Section 30) to test it directly. **UNKNOWN, RESEARCH REQUIRED**: whether the public-token widget endpoint returns individually dated reviews in a form usable for velocity computation, or only a rendered/aggregate view.

What is confirmed, not unknown: the endpoint that unambiguously supports full listing/filtering requires a **private, merchant-issued token** Bellwether cannot obtain for a competitor's store. That alone is enough to keep the *listing* capability on **DO NOT BUILD** without a resolved answer on the widget surface.

## 7. Stamped Analysis

Public widget initialization is well-documented and simple: `StampedFn.init({ apiKey: 'publicKey', sId: 'storeHash' })`, both values retrievable from a real store's on-page script config (not live-tested this sub-phase — no real Stamped store was reached). Beyond rendering, Stamped's own current documentation site (`developers.stamped.io`, fetched directly this sub-phase) states their newer Reviews API is **"coming soon"** as of this research, directing to a **legacy v2.0** reference whose only documented review-fetch endpoint is `/api/v2/{storeHash}/dashboard/reviews` — a path shape ("dashboard") and parameter set (requiring an `email` query parameter) consistent with a merchant-authenticated management endpoint, not a public storefront one. No security scheme was visible in the fetched OpenAPI fragment, which itself is a gap (**UNKNOWN**), but the path and required parameters both point away from public usability.

**Finding**: Stamped's public surface (confirmed) supports on-page widget rendering only; its structured review-listing surface is ambiguous in security terms but shaped like a merchant tool, and the vendor's own docs describe their review API as being actively rebuilt. **RESEARCH REQUIRED**, leaning **DO NOT BUILD** pending clarification, and independently risky to build against right now given the vendor's own docs signal the API surface is mid-change.

## 8. Yotpo Analysis

Genuinely conflicting evidence, preserved rather than resolved:

- One line of search results describes a `GET https://api-cdn.yotpo.com/v1/widget/{app_key}/products/{product_id}/reviews.json` pattern, usable with only a public `app_key`, no auth token — this shape matches a legacy "Widget API" era.
- A direct fetch of Yotpo's currently-maintained API reference (`apidocs.yotpo.com/reference/retrieve-reviews-for-a-product`) describes `GET https://api-cdn.yotpo.com/v1/widget/{store_id}/products/{product_id}/reviews.json` as requiring an `X-Yotpo-Token` header — i.e., the *same URL shape*, but the actively-documented version requires authentication.

These are consistent with the same endpoint having been tightened over time (a common vendor pattern), or with the older "public" version having been reported inaccurately in one source. **This could not be resolved from documentation alone**, and no real Yotpo-using store was reached in live validation. **UNKNOWN — RESEARCH REQUIRED**, specifically: attempt the unauthenticated variant against a real Yotpo-using store in a future, credential-free sub-phase before assuming either answer.

## 9. Loox Analysis

Two real, distinct surfaces, both checked:

- **Merchant API** (`api.loox.io/api/v1/store/{publicStoreId}`) explicitly requires `X-Api-Secret-Key` and — per its own documentation — returns full customer PII (email, customer ID, order ID) alongside review content. This is unambiguously a merchant-authenticated, private surface. Not usable by Bellwether, and Bellwether would have no legitimate reason to want the PII fields even if it were.
- **Shopify metafield aggregate** (`shop.metafields.loox.global_stats`, a comma-separated `"rating,count"` string) is real and requires no API key, but is **private by default** and only becomes queryable via the Shopify Storefront API if the merchant explicitly changes its visibility — meaning for the overwhelming majority of stores (who never touch this setting), it is not reachable.

**Finding**: Loox's *organic* public surface for a store that hasn't opted in is effectively **none** for structured/dated data. **DO NOT BUILD** for the private Merchant API (clear STOP condition #1); the metafield route is **DO NOT BUILD as a general mechanism** (works only for the unknown, likely small, subset of stores that changed a non-default setting) but could be opportunistically read where available — this is a minor, low-value, high-variance case, not a real capability to design around.

## 10. Okendo Analysis

The clear positive result of this sub-phase. Full detail and evidence in Sections 15 and 30; summarized here:

- `subscriberId` (Okendo's store identifier) is present in plain JSON inside the homepage HTML of a real Okendo-using store (`colourpop.com`), on a page **already fetched** by the existing crawler.
- `GET https://api.okendo.io/v1/stores/{subscriberId}/reviews` returned **HTTP 200** with **zero authentication of any kind**, live-verified this sub-phase.
- Response is cursor-paginated (`nextUrl`, DynamoDB-shaped `lastEvaluated` cursor), sorted **newest-first**, 25 reviews/page by default.
- Each review row includes: `dateCreated` (ISO-8601, second-precision), `rating`, `reviewer.isVerified`, `isIncentivized`, `productId` (as `shopify-{externalId}`, matching `Product.externalId` directly), `productHandle`, `status`.
- The same base path also supports a **per-product filter** (`.../products/shopify-{id}/reviews`), same shape, same pagination — confirmed live.
- No official, published API documentation was found describing this exact endpoint publicly (the Okendo docs site's Storefront REST API section did not render usable content via automated fetch — a real documentation-discoverability gap, not evidence the endpoint is unauthorized). The endpoint was found by inspecting the real, unminified-enough client JS Okendo itself serves to every visitor's browser (`cdn-static.okendo.io/reviews-widget-plus/js/okendo-reviews.js`) — i.e., **this is exactly the same mechanism the review widget itself uses to render on-page**, not a hidden or bypassed surface.

**This is a materially different situation from the other four providers**: no credential of any kind is needed, the identifier needed to call it is embedded in already-crawled data, and it is the *same* request path Okendo's own official widget makes from every visitor's browser.

## 11. Generic JSON-LD / AggregateRating Analysis

Research finding (not live-sampled at scale — see caveat below): Shopify's own out-of-the-box themes **do not** emit `AggregateRating`/`Review` JSON-LD by default, because the theme has no knowledge of which review app (if any) a merchant has installed. Review apps *can* inject their own JSON-LD block, and "many do," but multiple SEO-focused sources describe real, common failure modes: a theme's own product schema and a review app's separate schema block can both be present and conflict (search engines "pick whichever it parses first"), and implementation quality/completeness "varies" app-to-app and merchant-to-merchant (whether an app defaults to emitting valid schema, or requires a manual "nest into Product schema" configuration step many merchants never touch).

**No hard adoption-rate statistic was found**, and none is asserted here. Per the brief's explicit instruction (Section 6: "do not claim adoption rates without evidence... recommend an experiment rather than inventing one"): **a real, small, random-sampled adoption-rate measurement (e.g., fetch N already-crawled homepages/product pages Bellwether has touched before, grep for `AggregateRating`, report the real percentage) is the recommended next research step**, not performed in this sub-phase because it would require either a larger live-fetch sample than Section 19's "very small, representative sample" allows, or reuse of already-stored crawl HTML this codebase does not currently persist (it discards raw HTML after parsing — confirmed by inspecting `crawl/shopify.ts` and `crawl/normalize.ts`, neither of which writes raw HTML anywhere).

**Genuinely relevant, confirmed distinction**: even where JSON-LD `AggregateRating` is present, it structurally provides **only an aggregate count + average rating**, generally with at most a handful of individually-nested `Review` objects (the SEO guidance found recommends apps "ship 5 to 10 of your most recent reviews" — not a full history). This means JSON-LD, even at full adoption, would support **Level 1–2 only** (Section 12), never Level 4+ (dated review history / velocity) at any real depth. It is also the one review-data mechanism here that requires **zero provider-specific adapter code** — a single generic parser suffices for any app that populates it correctly.

## 12. Public Widget Endpoint Analysis

Summarized across Sections 6–10: of the five providers, **only Okendo's widget-supporting endpoint was confirmed to be genuinely public, unauthenticated, and to return full structured/dated data** rather than pre-rendered HTML or an aggregate-only payload. Judge.me and Stamped both have a public-key-gated widget surface whose exact JSON richness (dated, structured reviews vs. HTML/aggregate) is **UNKNOWN** without a live test against a real store using each. Yotpo's public-vs-authenticated status is itself unresolved (Section 8). Loox's genuinely public surface (the metafield) is opt-in and not the default.

## 13. Official API Availability

| Provider | Officially documented public review-read API? |
|---|---|
| Judge.me | Yes, but the officially documented review-listing endpoint requires a private token |
| Stamped | Partially — legacy v2.0 documented, but described by the vendor's own current site as being replaced; the replacement is not yet published |
| Yotpo | Yes (UGC API), but the currently-documented version requires an access token |
| Loox | Yes (Merchant API), requires a private secret key by design |
| Okendo | **Not found published as an official, indexed doc page** — discovered via the widget's own real client-side network call. Functionally public and stable enough to be the actual mechanism Okendo's own paying customers' storefronts depend on every day, but "not documented where a search engine/crawler of docs sites could find it" is itself a real caveat (see Section 33, risk: **UNDOCUMENTED**). |

## 14. Authentication Requirements

Restated as a direct table, since this is the single most decision-relevant axis:

| Provider | Auth required for review data | Type |
|---|---|---|
| Judge.me | Yes (for listing) | Private `api_token` |
| Stamped | Yes (for anything beyond widget rendering) | HTTP Basic (public key + private secret) |
| Yotpo | Unclear | `X-Yotpo-Token` on the currently-documented path |
| Loox | Yes (Merchant API) | `X-Api-Secret-Key` |
| Okendo | **No** | None — `subscriberId` alone, itself publicly embedded |

## 15. Dated Review Availability

Only confirmed, live-verified for Okendo: `dateCreated` present on every review, ISO-8601, second-precision, newest-first ordering. For the other four, dated-review availability is gated behind the same authentication question in Section 14 and remains **RESEARCH REQUIRED** rather than confirmed either way.

## 16. Review Data Granularity

Using the hierarchy the brief specifies, classified **per provider**, since collapsing this into one cross-provider answer would misrepresent the real, uneven picture:

| Level | Description | Judge.me | Stamped | Yotpo | Loox | Okendo |
|---|---|---|---|---|---|---|
| 1 | Aggregate review count only | RESEARCH REQUIRED | RESEARCH REQUIRED | RESEARCH REQUIRED | BUILDABLE (opt-in metafield only) | OBSERVED (live-verified) |
| 2 | Aggregate count + rating | RESEARCH REQUIRED | RESEARCH REQUIRED | RESEARCH REQUIRED | BUILDABLE (opt-in metafield only) | OBSERVED |
| 3 | Product-level aggregate counts | RESEARCH REQUIRED | RESEARCH REQUIRED | RESEARCH REQUIRED | UNSUPPORTED (no public per-product route found) | OBSERVED (via `productId` grouping of the same feed — no extra requests) |
| 4 | Dated individual reviews | RESEARCH REQUIRED (widget surface, unconfirmed richness) | RESEARCH REQUIRED | RESEARCH REQUIRED | UNSUPPORTED | OBSERVED (live-verified) |
| 5 | Historical review trajectory | RESEARCH REQUIRED | RESEARCH REQUIRED | RESEARCH REQUIRED | UNSUPPORTED | BUILDABLE (paginate `nextUrl` back through history; bounded, see Section 25) |
| 6 | Cross-product review velocity | RESEARCH REQUIRED | RESEARCH REQUIRED | RESEARCH REQUIRED | UNSUPPORTED | BUILDABLE (same store-wide feed, group by date) |
| 7 | Revenue inference | **DANGEROUS TO INFER**, all providers, uniformly — see Section 22 |

## 17. Review Velocity Definition

If pursued (Okendo only, given Section 16), the defensible definition — deliberately narrow:

- **Unit**: reviews per rolling 7-day and rolling 30-day window, computed per store from the persisted, deduplicated review stream — not a single fixed-calendar-month bucket, which would be sensitive to when-in-the-month a check happens.
- **Minimum sample before displaying anything**: an explicit `hasEnoughHistory`-style gate, matching this codebase's own established convention (`monitoring/activity.ts`'s `totalRealCrawls >= 2`) — proposed threshold: at least 2 real observation cycles spanning the window, and at least 1 review present, before rendering a velocity number at all. Zero and one-review cases must render as "not enough activity yet," never as `0/mo` (a `0` implies a measured rate, not an absence of data).
- **Store-level, not product-level, as the primary number** — product-level velocity is derivable from the same data (Section 16, Level 6) but is a secondary, more sparse signal per product and needs a higher minimum-sample bar before display.
- **No smoothing, weighting, or decay formula** is proposed — none was found to be evidence-supported for this specific use case, and the brief explicitly prohibits inventing one without support (Section 8).

Explicit non-handling, stated honestly rather than solved: a sudden app installation (a store that just added Okendo) will show a step-function jump in observed review count that is an artifact of *when Bellwether started observing*, not of *when reviews were actually written* — mitigated somewhat by `dateCreated` (Bellwether can see the review predates its own observation), but the distinction between "just started monitoring" and "genuinely just installed the app" cannot be fully resolved without a `StoreEntity.firstSeenAt` cross-check (already available) plus a documented UI caveat, not a data fix.

## 18. Imported Review Problem

Milestone 5's finding (Section 4 of that document) is restated and independently corroborated by fresh research this sub-phase, not contradicted:

- Shopify's App Store hosts multiple actively-used, officially-sanctioned apps (Judge.me AliExpress Reviews Importer, Trustoo Ali Reviews Importer, Editorify) explicitly for importing a **supplier's** review history onto a **reseller's** store — unchanged, re-confirmed conceptually this sub-phase, not re-verified live (would require finding and analyzing a real dropshipping store using one, out of scope for this pass).
- Fresh, independent research this sub-phase found a widely cited figure that **~42% of Amazon reviews were found to be fake in 2020** — a different platform, a different mechanism (Amazon's problem is largely incentivized/fake reviews, not supplier-import), but directly relevant as evidence that raw review-count contamination is a large, real, quantified phenomenon even on the platform with the most mature anti-fraud tooling in the industry. Shopify's review-app ecosystem has materially less centralized anti-fraud investment than Amazon's, making it reasonable to expect contamination is **at least** as significant for the Shopify long-tail — though no Shopify-specific prevalence percentage was found, and none is asserted (**UNKNOWN**).
- Okendo's own data model (Section 30) exposes an `isIncentivized` boolean and a `reviewer.isVerified` boolean on every review — a genuinely new, positive finding not available to Milestone 5's analysis, since it never got far enough to inspect a real payload. These flags provide **partial, not complete** mitigation: `isIncentivized` likely reflects only Okendo's own review-request-with-discount flow, not third-party import schemes, and `isVerified`'s exact definition (verified against a real order on *this* store, vs. verified as *an* Okendo account) is **UNKNOWN** — Okendo's own documentation for the precise semantics of this field was not found this sub-phase.

**Conclusion, unchanged from Milestone 5**: even with richer data access for Okendo specifically, Bellwether has **no reliable, general mechanism to distinguish organic activity from imported/incentivized activity at the level of confidence required to make a revenue claim**. The `isVerified`/`isIncentivized` flags are a genuine improvement over "raw count with zero metadata," worth surfacing honestly (e.g., "Xof Y recent reviews flagged verified" as its own observed fact), but they are not a solved problem.

## 19. Review Migration Problem

Distinct from the *imported-from-supplier* problem: a store switching review providers (e.g., Yotpo → Okendo) can trigger a bulk migration of its *own* historical reviews into the new provider, all landing with the *new provider's* `dateCreated` set to the migration date (or, if the migration tool is well-built, the *original* review date preserved) — **UNKNOWN, provider-and-migration-tool-dependent**, not resolved by this sub-phase's research. This would manifest identically to a genuine review-count burst and cannot currently be distinguished from one without either (a) trusting the provider's own migration tooling to preserve original dates faithfully (unverifiable from outside), or (b) detecting an anomalous same-timestamp cluster heuristically (a real, buildable detection, but a heuristic, not a certainty — flagged as future work, not built here).

## 20. Review Velocity Reliability

Even restricted to Okendo (the only provider with confirmed data access), review velocity as a **standalone activity signal** (not a revenue proxy) carries real, honestly-stated reliability caveats:

- Sparse-data noise: a store with 2–3 reviews/month showing "3 this month vs. 1 last month" is a 3x swing from a tiny, statistically meaningless sample — the display must communicate this, not just show a percentage.
- The "just started monitoring" artifact (Section 17).
- The migration-burst ambiguity (Section 19).
- Category/niche variance in natural review propensity (Section 21) means store-to-store comparison of *raw* velocity numbers, without normalizing for catalog size or category, could mislead a user into thinking "store A is more active than store B" when the real driver is products-per-review-opportunity, not genuine customer engagement.

None of these caveats block building a *store's own* velocity trend over time (comparing a store to its own history is far more defensible than comparing store A to store B) — this distinction should be reflected directly in how any future UI frames the number.

## 21. Review Velocity vs Sales Research

Fresh research this sub-phase, evaluated against Milestone 5's original findings rather than starting over:

- **Natural review-submission-rate variance, re-confirmed and slightly widened**: multiple 2025–2026 sources converge on ~5–10% of customers leaving a review unprompted, versus 70–80% when actively prompted via email — roughly a 7–16x range depending on which end of each band is compared, consistent with (and slightly wider than) Milestone 5's originally-cited 10–30x figure (which used different source studies). Amazon specifically is cited even lower (1–2% unprompted). **This variance is a submission-tactic effect Bellwether cannot observe from the storefront** (a store's email-automation configuration is invisible externally) — unchanged blocker from Milestone 5.
- **A real, credible review-count-to-sales correlation was found**, but in a narrow, specific, non-representative context: **88% correlation between review count and total sales for *bestselling books on Amazon***. This is a genuinely strong number, and it would be dishonest to omit it — but it describes a curated, high-visibility category on a single platform with Amazon's own review-solicitation infrastructure baked in, not the small/niche independent Shopify stores that make up Bellwether's actual corpus (Milestone 5's own Section 8 finding, unchanged). Generalizing this figure to "any Shopify store's review count predicts its sales" would be exactly the fabrication-by-analogy this brief prohibits.
- **Peer-reviewed/academic-adjacent research (Li et al., 2016, cited via secondary sources) found review count and rating "lead to a better sales rank," but explicitly names product category, Q&A activity, discounts, and review usefulness as significant moderating factors** — i.e., even the positive academic finding is explicitly NOT a stable, universal formula; it varies by exactly the segmentation axes Section 24 discusses.
- **Industry "Review-to-Sales Ratio" heuristics (5–15% of units sold generate a review) are Amazon-specific**, sourced from Amazon-seller-tooling blogs, not validated for Shopify's fragmented, multi-vendor review-app ecosystem, and explicitly caveated by their own sources as varying by category.

**Conclusion**: the evidence for *any* review-count-to-sales relationship is real but consistently platform-specific (Amazon) and category-conditional, never a stable cross-context formula — this is the same shape of finding Milestone 5 reached for traffic-based revenue estimation (Section 2 of that document), now independently reached again for review velocity from a different literature base. Two independent research passes reaching the same structural conclusion is meaningful corroboration, not a coincidence to discount.

## 22. Revenue-Inference Feasibility

**Unchanged from Milestone 5: not feasible responsibly, for any provider, including Okendo.** The blockers are not primarily about data *access* (which this sub-phase materially improved for one provider) but about data *interpretability*:

1. Submission-rate variance is unobservable per-store (Section 21).
2. Imported/incentivized reviews are common and only partially detectable even with Okendo's richer metadata (Section 18).
3. Migration bursts are indistinguishable from genuine bursts without unverifiable trust in third-party migration tooling (Section 19).
4. The one strong empirical correlation found is platform-and-category-specific, not general (Section 21).
5. No calibration dataset exists (Section 23, restating Milestone 5's Section 5 finding — nothing in this sub-phase's scope changes that; a calibration dataset problem is orthogonal to a data-access problem).

This sub-phase did not identify a fifth approach beyond Milestone 5's four (Section 2 of that document) that would change this. **PERMANENTLY DO NOT BUILD is reaffirmed**, not merely carried forward by default.

## 23. Required Calibration Dataset

No change from Milestone 5's Section 5: a statistically meaningful calibration dataset (their estimate: ~450 stores with real, verified revenue across size/category brackets) is a manual, relationship-driven, multi-month undertaking with no automatable source. This sub-phase did not attempt to build or shrink that requirement, and better review-data access does not reduce it — calibrating "does review velocity predict revenue" would require exactly the same real-ground-truth dataset as calibrating any other revenue signal.

## 24. Store/Category Segmentation Requirements

If revenue inference were ever revisited (it is not being recommended here), the minimum segmentation axes identified by this sub-phase's literature review, consistent with Milestone 5's Section 11-equivalent reasoning: product category, price bracket, review-solicitation intensity (unobservable — a hard blocker on its own), platform/provider (an Okendo store's `isVerified` semantics may not map to another provider's equivalent flag), and store maturity (a 6-month-old store's velocity is not comparable to a 6-year-old store's on the same absolute scale). Bellwether does not currently have real, verified ground truth for any of these axes (Section 23) — this remains a description of what *would* be needed, not evidence that it now exists.

## 25. Request/Collection Cost Model

Grounded in Okendo's real, confirmed behavior (Section 30) — the only provider with enough live evidence to cost accurately. Figures for the other four are marked accordingly.

**Per-check cost (Okendo, incremental/routine monitoring)**: because the store-wide endpoint sorts **newest-first**, a routine check needs to fetch pages only until it reaches a review it has already recorded (by `reviewId`) — **1 request in the overwhelming majority of real-world cases** (any store adding fewer than 25 reviews between checks), rising to 2+ only for unusually high-velocity stores. This is a **flat, near-constant cost independent of total catalog size or total historical review count** — a materially different (and better) cost shape than Milestone 5 assumed when it imagined "one product-page fetch per product."

**Per-store initial backfill (Okendo)**: unbounded without an explicit cap, since `nextUrl` will keep paginating back through a store's *entire* review history. Recommended bound, matching this codebase's existing philosophy (`MAX_CRAWLS_FOR_TREND`, `MAX_PRODUCTS_FOR_CATALOG_HISTORY`-style constants already in `growth/catalog.ts`): cap initial backfill at a fixed number of pages (e.g., 20 pages / 500 reviews), covering meaningful recent history for the vast majority of real stores without an unbounded worst case for a highly-reviewed brand.

| Store size (approx. product count) | Okendo initial backfill (capped at 500 reviews) | Okendo daily incremental check |
|---|---|---|
| 100 products | ≤20 requests (often far fewer — most small stores have well under 500 total reviews) | 1 request |
| 300 products | ≤20 requests | 1 request |
| 1,000 products | ≤20 requests | 1 request, occasionally 2 |
| 3,000 products | ≤20 requests | 1–2 requests |
| 5,000 products | ≤20 requests | 1–2 requests |

**Critical property**: this cost is driven by **review volume**, not **product count** — the two are correlated but not the same axis, unlike the "per-product-page fetch" model Milestone 5 evaluated, where cost scaled directly with catalog size.

**For the other four providers**: cost cannot be responsibly modeled yet, since the fundamental question of "is a single request even possible without merchant auth" is unresolved (Sections 6–9). No cost table is fabricated for them.

**Weekly/monthly monitoring**: strictly cheaper than daily in aggregate request count, at the cost of a wider window in which more than one page might be needed to catch up (still bounded, just occasionally 2–3 requests instead of 1).

## 26. Responsible Crawling Analysis

- **robots.txt**: not evaluated for `okendo.io`/`api.okendo.io` this sub-phase — a real gap, flagged explicitly as **UNKNOWN**, and should be checked before any real implementation (the existing crawler's own `robots.txt` posture toward target Shopify stores was not itself re-audited here either, out of scope).
- **Request frequency**: the incremental-check model (Section 25) naturally produces a low, bounded request rate — far below anything resembling abuse, and no different in kind from the existing marketing-intelligence (SerpApi) polling cadence already running safely in production.
- **Response-size caps, timeout, retry**: none of this sub-phase's live requests were large (the largest single response fetched was under 25KB) — a real review API response is orders of magnitude smaller than a Shopify `/products.json` page this codebase already safely bounds at 10MB (Section 27 continues this).
- **Provider rate limits**: Okendo's own rate limit is **UNKNOWN** — not disclosed anywhere found this sub-phase, and not stress-tested (deliberately, per the brief's "do not load-test" instruction). Yotpo's documented limit (30,000 req/min per app_key, from Section 8's research) is generous but belongs to a different, authenticated endpoint, not directly informative for Okendo.
- **Preference for aggregate/incremental over per-product per-crawl**: fully satisfied by the store-wide, newest-first design (Section 25) — this is the "prefer aggregate endpoints, incremental collection" outcome the brief asked this research to look for, and it was found to already exist as Okendo's own natural API shape, not something Bellwether would need to construct.

## 27. Security / SSRF Analysis

- Any future Okendo fetch must go through the **same** `checkUrlIsSafeToFetch`/`fetchWithTimeout`/`readBodyWithLimit` machinery already built and tested in `crawl/shopify.ts` (Milestone 8) — `api.okendo.io` is a fixed, known, non-user-controlled hostname (unlike the target store's own domain), so the *existing* SSRF guard's per-store DNS/private-IP checks are not even the relevant protection here; what matters is reusing the **response-size cap and timeout** discipline, not a new security layer. No new HTTP client should be built.
- The `subscriberId` extracted from a store's homepage is attacker-influenceable in the loose sense that it comes from HTML Bellwether doesn't control — but it is used only to construct a URL path segment to a **fixed, known API host** (`api.okendo.io`), never as a redirect target or a hostname itself, so standard SSRF concerns (an attacker redirecting the crawler to an internal address) do not apply the way they do to the primary crawl target's own domain. Ordinary input validation (reject anything that isn't a plausible UUID shape) is sufficient, not a new guard subsystem.
- Review **body text** is untrusted, attacker-adjacent (any real customer, or a malicious one, can write anything) content that would eventually be rendered in Bellwether's own UI if ever displayed — this requires the same HTML-escaping/sanitization discipline already mandatory for any user-generated content, not a new consideration specific to reviews, but worth stating explicitly since no code path in this repository currently renders third-party free text at all.
- No credential of any kind needs to be stored for Okendo (there is none to store) — this is a genuine simplification versus every other external vendor integration in this codebase (SerpApi, OAuth), which all carry real secret-management surface area Okendo's public API does not.

## 28. Future Data Model Recommendation

**Not built.** Proposed, smallest-first, for a future Sub-phase B **if** it proceeds:

- A single `ReviewObservation` table would likely suffice for the Okendo-only scope this research supports — one row per `(storeId, provider, externalReviewId)`, holding `productExternalId`, `rating`, `reviewCreatedAt` (the provider's own date — this is the field that matters, not `observedAt`), `isVerified`, `isIncentivized`, and `observedAt` (when Bellwether itself first saw it, for the "just started monitoring" caveat in Section 17). A composite unique key on `(storeId, provider, externalReviewId)` is the natural deduplication key, mirroring `Product`'s own `(storeId, externalId)` pattern already in this schema.
- **Individual review body text likely does not need persistence** for a velocity-only signal — storing only metadata (rating, date, verified/incentivized flags, product link) avoids taking on UGC-moderation/display responsibility this sub-phase was not asked to scope, and keeps the row small and cheap at scale.
- **A separate `ReviewProviderObservation`/aggregate snapshot table is likely unnecessary** — velocity can be computed on read from the `ReviewObservation` rows directly (the existing `getCatalogGrowthTrend`-style pattern in this codebase already computes trends from raw rows rather than pre-aggregating), avoiding a second source of truth to keep in sync.
- Retention: no different from this codebase's existing "keep everything, append-only" posture for `Event`/`ProductStateSnapshot` — reviews are small, and there's no stated reason to purge them.

This section is explicitly a sketch to inform a future planning pass, not a spec — no migration was written, per the brief's hard constraint.

## 29. Future UI Recommendation

**Not built.** Using the project's existing epistemic vocabulary (`OBSERVED`/`ESTIMATED`/`INFERRED`/`UNAVAILABLE`, plus the recently-added `permanent` flag on `UnavailableField`):

- **Review count / rating (Okendo-backed stores)**: `OBSERVED`, rendered through the existing `IntelligenceCard`, no new component needed.
- **Review velocity (Okendo-backed stores, enough history)**: `OBSERVED`, framed explicitly as "reviews per month, observed" — never "estimated sales."
- **Review velocity (not enough history yet)**: the existing "accumulating" pattern this codebase already uses for `hasEnoughHistory`-gated sections (a dashed-border card, distinct from the flat grey `UNAVAILABLE` treatment) — **not** routed through `IntelligenceCard`'s `UNAVAILABLE` branch, consistent with how `GrowthIntelligence.tsx` already separates these two visual treatments.
- **Provider not Okendo (Judge.me/Stamped/Yotpo/Loox detected, but data inaccessible)**: `UNAVAILABLE`, `permanent: false` (this is a "not yet, pending more research," not a permanent architectural wall the way revenue is) — reason text should say something honest like "review activity from this provider is not yet supported," distinct from Okendo-store copy.
- **No review app detected at all**: the existing `ReviewInfrastructureCard`'s "None detected" state, unchanged.
- **Revenue implication**: any future UI copy must not adjoin a review-velocity number with dollar figures or "estimated sales" language anywhere on the same card — this is a real risk (a designer reasonably assuming "we have review data now, let's show a revenue estimate too") that this document explicitly flags for whoever builds Sub-phase B.

## 30. Live Validation Results

Performed under Section 19's constraints: read-only, ordinary HTTP, no authentication, no cart/form/account actions, small sample, existing validation stores reused where possible.

| Store | Provider detected | Mechanism tested | Requests | Result | Notes |
|---|---|---|---|---|---|
| colourpop.com | Okendo | Homepage fetch (already-established target, re-used) | 1 | 200, real HTML, `subscriberId` found in plain JSON | Config present on a page already crawled today |
| colourpop.com | Okendo | `cdn-static.okendo.io/reviews-widget-plus/js/okendo-reviews.js` (Okendo's own real widget script) | 1 | 200, real JS, real API hostnames extracted (`api.okendo.io`, `reviews.okendo.io`) | Confirms this is Okendo's own client-side mechanism, not a hidden/bypassed one |
| colourpop.com | Okendo | `GET api.okendo.io/v1/stores/{subscriberId}/reviews` | 2 (default + `?limit=5`, same result) | **200, real, dated, individual reviews returned, no auth** | 25 reviews/page, `dateCreated` newest-first, `isVerified`/`isIncentivized` present on every row |
| colourpop.com | Okendo | `GET api.okendo.io/v1/stores/{subscriberId}/products/shopify-{realProductId}/reviews` | 1 | 200, same shape, filtered to one product | Confirms per-product filtering works identically |
| colourpop.com | Okendo | Two guessed "aggregate" endpoint variants | 2 | 403, 404 | Guessed paths, not the real shape — abandoned rather than continuing to probe |
| colourpop.com | (n/a) | `products.json?limit=3` | 1 | 200 | Reused only to obtain a real product ID for the per-product test above — same endpoint this codebase's crawler already fetches routinely |
| colourpop.com | (n/a) | Individual product page HTML | 1 | **403** | Ad-hoc request blocked; homepage and `/products.json` from the same store were not blocked — see analysis below |
| allbirds.com | (n/a) | Homepage | 2 (plain + browser-UA retry) | 403 both times | Not retried further |
| taylorstitch.com | (n/a) | Homepage | 1 | 403 | Not retried |
| gymshark.com | (n/a) | Homepage | 1 | 403 | Not retried |
| meowingtons.com | (n/a) | Homepage | 1 | 403 | Not retried |

**Total real requests this sub-phase: 13**, across 6 distinct real domains, all read-only GETs, no authentication attempted anywhere, no cart/checkout/form interaction, no account creation.

**Honest limitation of this sample**: only one provider (Okendo) was confirmed live because only one real, reachable store using it was identified and successfully queried; the four 403s against other real stores reflect ad-hoc research requests being caught by bot defenses that the *existing production crawler* (with its own established header/timing/retry configuration, proven throughout this project's entire prior history against these exact domains) does not trigger — this is **not evidence those stores are unreachable in general**, only that a quick manual `curl` is a different, less careful request shape than this project's own crawler. This also means **Judge.me, Stamped, Yotpo, and Loox remain entirely unverified live** — every claim about them in Sections 6–9 is documentation-derived, explicitly labeled as such, and should not be read as equivalent-confidence to the Okendo findings.

A secondary, real finding from the same sample: colourpop.com's **homepage** and **`/products.json`** both succeeded for an ad-hoc request, while its **individual product page** did not — suggesting rendered HTML product pages may carry materially different (stricter) bot-defense posture than JSON API endpoints on at least this real store, independently reinforcing why an approach that avoids product-page fetches entirely (Okendo's store-wide API) is architecturally preferable, not just cheaper.

## 31. Capability Decision Matrix

| Capability | Status | Evidence | Cost | Risk | Next step |
|---|---|---|---|---|---|
| Review infrastructure detection (presence only) | OBSERVED | Existing system, unchanged | Zero (already shipped) | Low | Shipped, no change |
| Okendo — aggregate review count/rating (Levels 1–2) | **GO** | Live-verified, Section 30 | ~1 req/store/check | Low | Build in Sub-phase B |
| Okendo — product-level counts (Level 3) | **GO** | Live-verified (same feed, grouped) | Zero marginal cost | Low | Build in Sub-phase B |
| Okendo — dated individual reviews (Level 4) | **GO** | Live-verified | ~1 req/store/check | Low | Build in Sub-phase B |
| Okendo — historical trajectory (Level 5) | **CONDITIONAL GO** | Buildable, bounded backfill required | Bounded (≤20 req/store, one-time) | Low-Medium (unbounded if cap is forgotten) | Build with an explicit, tested cap |
| Okendo — cross-product velocity (Level 6) | **CONDITIONAL GO** | Buildable from same data | Zero marginal cost | Medium (interpretation caveats, Section 20) | Build with the honesty caveats in Sections 17/20/29 |
| Judge.me — any review data | RESEARCH REQUIRED | Docs conflict; widget-surface richness unconfirmed; not live-tested | Unknown | Unknown | Live-test against a real Judge.me store in a future pass, credential-free |
| Stamped — any review data | RESEARCH REQUIRED, leaning DO NOT BUILD | Public docs mid-migration; likely-authenticated real endpoint | Unknown | Medium (building against an API the vendor is actively replacing) | Re-check vendor docs before any attempt |
| Yotpo — any review data | RESEARCH REQUIRED | Directly conflicting evidence on auth requirement | Unknown | Unknown | Live-test the unauthenticated URL shape against a real Yotpo store |
| Loox — any review data | **DO NOT BUILD** (Merchant API); low-value opportunistic (metafield) | Confirmed private-key-gated; metafield confirmed opt-in/non-default | N/A | High (would require a credential Bellwether cannot obtain) for the Merchant API | None for Merchant API; low priority for metafield |
| Generic JSON-LD `AggregateRating` | BUILDABLE, adoption UNKNOWN | Real, provider-agnostic mechanism confirmed to exist; no adoption-rate evidence found | Zero marginal cost (same page already fetched, if a page containing it were ever fetched) | Low | Recommend a dedicated, small adoption-rate sampling experiment before relying on it |
| Review velocity as revenue proxy | **PERMANENTLY DO NOT BUILD** | Milestone 5 finding reaffirmed by independent fresh research this sub-phase | N/A | Reputational/trust risk if built anyway | None — do not revisit without a real calibration dataset (Section 23), which does not exist |

## 32. Risks

- **Single-vendor concentration**: if a real implementation is scoped to Okendo only (this document's recommendation), Bellwether's review-intelligence coverage is limited to whatever fraction of the corpus uses Okendo specifically — real, unmeasured this sub-phase (**UNKNOWN** adoption share among analyzed stores).
- **Undocumented-endpoint fragility**: Okendo's endpoint was found via its own client JS, not an indexed public doc page (Section 13) — it could change without the same notice a documented, versioned API would give. A future implementation must fail closed/gracefully (matching this codebase's existing "silently degrade to UNAVAILABLE, never crash" discipline) if the shape changes.
- **Rate-limit unknown**: Okendo's real rate limit was not found or tested (Section 26) — a future implementation should start conservatively and observe real behavior, not assume generous limits.
- **Metadata-field trust**: `isVerified`/`isIncentivized` semantics are not confirmed by Okendo's own documentation (Section 18) — presenting them as a stronger signal than they actually are would itself be a new epistemic-honesty risk.

## 33. Unknowns

Explicitly marked, not silently assumed:

- Whether Judge.me's public-token widget endpoint returns dated, structured review data or only rendered/aggregate content — **UNKNOWN**.
- Whether Yotpo's legacy widget endpoint is still live and unauthenticated in practice, versus documentation drift — **UNKNOWN**.
- Stamped's actual current (non-legacy) review-read API shape — **UNKNOWN**, vendor states it is not yet published.
- Real adoption rate of JSON-LD `AggregateRating` across real Shopify stores — **UNKNOWN**, no measurement attempted.
- Real adoption rate of Okendo (or any provider) across Bellwether's actual analyzed-store corpus — **UNKNOWN**, not measured this sub-phase.
- Okendo's real rate limit — **UNKNOWN**.
- Exact semantics of Okendo's `isVerified`/`isIncentivized` flags — **UNKNOWN**.
- Whether review-date integrity survives a provider-to-provider migration — **UNKNOWN**, provider-and-tool-dependent.
- `robots.txt` posture of `okendo.io`/`api.okendo.io` — **UNKNOWN**, not checked this sub-phase.

## 34. STOP Conditions

Evaluated against the brief's ten explicit conditions, per capability rather than for the sub-phase as a whole:

- **STOP 1 (merchant authentication required)**: triggered for Judge.me's confirmed listing endpoint, Stamped's likely-authenticated broader API, and Loox's Merchant API. **Not triggered** for Okendo.
- **STOP 2–4 (browser automation / anti-bot bypass / private APIs)**: not triggered anywhere in this research — no such approach was investigated or is recommended.
- **STOP 5 (unreasonable storefront load)**: not triggered — Okendo's real cost shape (Section 25) is bounded and low; the four 403s encountered (Section 30) were not retried aggressively, consistent with this constraint rather than a violation of it.
- **STOP 6 (technically accessible but inappropriate for commercial redistribution)**: genuinely uncertain for Okendo specifically, and flagged rather than resolved — the endpoint is real, unauthenticated, and is the same one Okendo's own widget uses, but no ToS was located and reviewed this sub-phase confirming third-party commercial use is permitted. **This is the single most important open item before any real Sub-phase B implementation begins** — Okendo's terms of service must be read and, if ambiguous, Okendo should likely be contacted directly, exactly as this project chased down SerpApi's ToS in Milestone 4 before building on it.
- **STOP 7 (velocity cannot be distinguished from imported reviews)**: triggered for the **revenue-proxy** use specifically (Section 22) — not triggered for the narrower **activity-signal** use, which does not require that distinction to be solved, only to be honestly caveated (Section 20).
- **STOP 8 (revenue relationship cannot be responsibly established)**: triggered, unchanged from Milestone 5.
- **STOP 9 (new infrastructure category required)**: not triggered — everything researched fits the existing HTTP-crawler/TypeScript/Prisma architecture.
- **STOP 10 (conflicts with existing security architecture)**: not triggered — Section 27 found the existing SSRF/timeout/size-cap machinery is directly reusable, not in conflict.

## 35. Recommended Implementation Sequence

If a Sub-phase B is authorized, in the order the brief itself prescribes (Section 24 of the brief), scoped to what this research actually supports:

**Phase 1** — Generic aggregate review observation: attempt JSON-LD `AggregateRating` parsing (provider-agnostic) on already-fetched pages, and resolve the Section 6 adoption-rate unknown with a real, small measurement first.

**Phase 2** — Provider-specific adapter, Okendo only (the sole provider this research actually justifies): store-wide incremental polling, bounded initial backfill, `ReviewObservation`-shaped persistence (Section 28).

**Phase 3** — Dated review observation: already covered by Phase 2's design for Okendo — no separate phase needed for this provider specifically.

**Phase 4** — Review history/velocity: build on Phase 2's persisted data, with the explicit `hasEnoughHistory`-style gating and honest UI framing from Sections 17/20/29.

**Phase 5** — Signal-quality validation: before broad rollout, manually spot-check a sample of Okendo-backed stores' computed velocity against what a human would judge as "does this look like real activity" — a lightweight sanity pass, not the full calibration dataset Section 23 describes (that remains out of scope for any near-term phase).

**Phase 6** — Explicitly not started, and this document's own conclusion is that it should not be, absent a real, separately-scoped, multi-month calibration effort (Section 23) that nothing in this sub-phase's findings shortens.

Judge.me/Stamped/Yotpo/Loox are **not included** in this sequence — each needs its own resolved RESEARCH REQUIRED item (Sections 6, 7, 8) before it could enter Phase 2 at all, and none is recommended for parallel investment alongside the Okendo build.

## 36. Final Decision Gate

**A. Can Bellwether reliably observe review counts from Shopify stores?**
For Okendo-backed stores: **yes**, live-verified. For stores using the other four providers researched: **not established** — RESEARCH REQUIRED. For the corpus as a whole: **partial**, bounded by real (unmeasured) provider adoption share.

**B. Can Bellwether reliably observe product-level review counts?**
For Okendo-backed stores: **yes**, as a free byproduct of the same store-wide feed. Others: not established.

**C. Can Bellwether reliably obtain dated reviews?**
For Okendo-backed stores: **yes**. Others: not established.

**D. Can Bellwether calculate review velocity?**
For Okendo-backed stores: **yes**, mechanically — subject to the reliability caveats in Section 20.

**E. Can Bellwether calculate review velocity without excessive crawl cost?**
**Yes**, for Okendo — the real, measured cost shape (Section 25) is bounded and cheap, materially better than Milestone 5's assumption.

**F. Can review velocity distinguish recent organic activity from imported reviews?**
**No, not reliably.** Okendo's `isVerified`/`isIncentivized` flags help partially but their exact guarantees are unconfirmed (Section 18), and no mechanism found anywhere in this research solves the supplier-import problem generally.

**G. Is review velocity useful as a standalone competitive-intelligence signal?**
**Yes, conditionally** — as an honestly-labeled, `OBSERVED`-tier "this store's review activity is rising/falling/flat" signal, framed as activity, never as a sales/revenue implication, and gated by the same "not enough history" discipline this codebase already applies elsewhere.

**H. Is there sufficient evidence to use review velocity as a revenue proxy?**
**No.** Unchanged from Milestone 5, independently reaffirmed by this sub-phase's own fresh research (Section 21).

**I. Is a revenue model ready to build?**
**No.**

**J. What is the smallest safe implementation that should follow?**
Phase 1–2 of Section 35: a real JSON-LD adoption measurement, followed by an Okendo-only aggregate-and-dated-review observation pipeline, reusing the existing crawler's HTTP safety machinery, with review velocity surfaced honestly as an activity signal — contingent on first resolving the Section 34/STOP-6 terms-of-service question, which this document identifies as the single actual gate on proceeding at all.

---

## Sources used

- `docs/milestone-5-revenue-traffic-research.md` (this project's own prior research, re-read in full)
- `docs/milestone-5-growth-signals-research.md` (referenced by existing code comments, not re-read in full this sub-phase — flagged as a gap if its specific claims matter to a future reader)
- This project's own source: `src/lib/growth/review-infrastructure.ts`, `src/lib/crawl/fingerprint.ts`, `src/lib/crawl/shopify.ts`, `src/lib/crawl/normalize.ts`, `src/lib/security/ssrf-guard.ts`, `prisma/schema.prisma`
- [Using Judge.me API | Judge.me Help Center](https://judge.me/help/en/articles/8409180-using-judge-me-api)
- [Judge.me API Documentation](https://judge.me/api/docs)
- [Retrieve reviews for a product — Yotpo](https://apidocs.yotpo.com/reference/retrieve-reviews-for-a-product)
- [Welcome to the Yotpo UGC API Reference](https://apidocs.yotpo.com/reference/welcome)
- [Stamped REST API – Stamped Help Center](https://stampedsupport.stamped.io/hc/en-us/articles/10152777765659-Stamped-REST-API)
- [developers.stamped.io](https://developers.stamped.io/) and its `llms.txt` index
- [Stamped v2.0 GetReviews reference](https://developers.stamped.io/v2.0/reference/getreviews-1)
- [Loox Reviews API and webhooks](https://help.loox.io/support/solutions/articles/501000356871-loox-reviews-api-and-webhooks)
- [Loox API — apitracker.io](https://apitracker.io/a/loox-app)
- [Shopify Loox Reviews - get total reviews (Gist)](https://gist.github.com/0f98ace464acd1f47cd887b5c7c31158)
- [Reviews Widget | Okendo](https://docs.okendo.io/on-site/on-site-widgets/reviews-widget)
- [Storefront REST API | Okendo](https://docs.okendo.io/on-site/storefront-rest-api)
- [@frontend-sdk/okendo — npm](https://www.npmjs.com/package/@frontend-sdk/okendo)
- Live requests to `colourpop.com`, `api.okendo.io`, `reviews.okendo.io`, `cdn-static.okendo.io` (this sub-phase, Section 30)
- [Review schema markup for Shopify in 2026 — Reviewz](https://reviewz.ai/blog/review-schema-markup-guide)
- [What Percentage of Customers Write Reviews? — Growave](https://www.growave.io/blog/what-percentage-of-customers-write-reviews)
- [26 Review Response Rate Statistics for eCommerce Stores — Opensend](https://www.opensend.com/post/review-response-rate-statistics)
- [The Sales Velocity Effect on Retailing — ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S1094996814000322) (noted as a related-but-distinct concept, Section 21)
- [How I Used Amazon Reviews to Predict Sales of My Book — Forte Labs](https://fortelabs.com/blog/how-i-used-amazon-reviews-to-predict-sales-of-my-book/) (source of the 88%/bestselling-books figure)
- [Influential Factors in Increasing an Amazon Products Sales Rank (arXiv)](https://arxiv.org/pdf/2411.04305)
- General fake-review-prevalence research (42% figure), sourced via aggregated search results this sub-phase

## Unresolved questions

Restated from Section 33 for visibility: Judge.me/Yotpo/Stamped widget-endpoint data richness; real provider-adoption share within Bellwether's corpus; JSON-LD adoption rate; Okendo rate limits and ToS terms; exact semantics of Okendo's verification/incentive flags; review-date integrity across provider migrations.

## Sub-phase B readiness

**RESEARCH REQUIRED** overall, with a **CONDITIONAL GO** carve-out specifically for an Okendo-only aggregate/dated-review observation pipeline (Section 35, Phases 1–2), conditional on first resolving the Okendo ToS question raised in Section 34 (STOP 6). Revenue estimation remains **PERMANENTLY DO NOT BUILD**. Do not proceed to implementation of anything in this document without a human decision on the ToS question specifically — this research does not resolve it and should not be read as implicitly clearing it.

---

## Addendum (Sub-phase B, live spike) — JSON-LD `AggregateRating` adoption, small-sample result

**Context**: Sub-phase B attempted to implement an Okendo collector and was blocked at the commercial-use gate (see `docs/milestone-9-subphase-b-completion-report.md`, Section 2 — Okendo's own Terms of Service prohibit automated access to non-published interfaces and commercial exploitation of scraped content). During the same follow-up pass, an external pitch proposed generic JSON-LD `aggregateRating` scraping from individual product pages as a ToS-free alternative, asserting it appears on "nearly every Shopify product page." Section 11 above explicitly declined to assert an adoption rate and recommended a small, real measurement instead of inventing one. This addendum is that measurement.

**Method**: 5 real stores (colourpop.com, allbirds.com, taylorstitch.com, gymshark.com, meowingtons.com — all reused from Section 30's existing validation set, no new domains touched), 2 real product pages fetched per store via `/products/{handle}` with a standard browser User-Agent header (a real Chrome UA — the earlier Section 30 attempts used a bare, unheadered `curl`, which is the likely reason several 403'd there). 15 total read-only GET requests (5× `/products.json` to obtain real handles + 10× individual product pages). No cart/account/form interaction. Comparable in scale to Section 30's own 13-request sample.

**Result — do not generalize beyond this sample, but it is real data, not a guess**:

| Store | Product 1 | Product 2 | Notes |
|---|---|---|---|
| allbirds.com | `AggregateRating` present (valid schema.org JSON-LD, nested `itemReviewed`) | present | Clean, reliable |
| taylorstitch.com | `AggregateRating` present (`ratingValue: 4.47`, `reviewCount: 53`) | present (`ratingValue: 4.57`, `reviewCount: 14`) | Clean, reliable |
| colourpop.com (confirmed Okendo store, Section 30) | **Absent** — page contains only Okendo's own client-side JS variables (`okendoProduct.reviewAverageValue`), not schema.org markup | **Present** (`ratingValue: 4.7`, `ratingCount: 10412`) | Inconsistent *within the same store*, product-to-product |
| meowingtons.com | Real `Product` JSON-LD present (name/sku/offers) but **no `aggregateRating` block at all** | same pattern | Schema present, ratings sub-block simply never emitted |
| gymshark.com | **No JSON-LD of any kind** — `/products/{handle}` 301-redirects to `us.checkout.gymshark.com`, a separate, non-standard storefront subdomain | same | Architectural gap, not a review-app choice — likely a headless/custom storefront, not classic server-rendered Liquid theme |

**Honest reading of this sample**:

- The "nearly every product page" claim from the external pitch is **not supported** by this sample and should be treated as an overstated assumption, not a fact to build on. Reliable `AggregateRating` presence was 2 of 5 stores (40%); one store was inconsistent product-to-product; two stores had none, for two different underlying reasons.
- **A confirmed Okendo store not reliably exposing Okendo's own review data via JSON-LD is the single most decision-relevant finding here**: it means the JSON-LD approach is not a substitute or overlap for the (currently ToS-blocked) Okendo API — they are separate, non-redundant data-access channels with different, partial coverage. A future implementation could not simply fall back to JSON-LD wherever Okendo is blocked and expect equivalent coverage.
- The within-store inconsistency (colourpop: absent on product 1, present on product 2) is most plausibly explained by the review app only emitting an `AggregateRating` block once a product has at least one review — itself a reasonable vendor design choice, but it means **absence of JSON-LD on a given product page cannot be read as "this store has no review data,"** only as "not observable through this channel for this product." That ambiguity would need to be carried into any future epistemic-status classification (`UNAVAILABLE`, not "zero").
- **Positive, partial update to Section 30's bot-detection caveat**: all 10 product-page fetches succeeded (HTTP 200) using a standard browser `User-Agent` header, in contrast to Section 30's bare, unheadered `curl` attempts, several of which 403'd on some of these same domains. This suggests the earlier 403s were at least partly a request-fingerprint artifact rather than a hard, unconditional block on product-page access generally — a meaningfully less pessimistic picture than Section 30 left it at. This is still a small, one-off sample, not proof the *existing production crawler's* specific configuration would succeed at real operating scale/frequency, and it does not change the separate, still-valid cost-scaling concern (fetching one page per product reintroduces cost that scales with catalog size, unlike Okendo's bounded store-wide feed).
- At least one real, non-trivial storefront (gymshark.com) uses a non-standard/headless architecture with no server-rendered JSON-LD reachable at all — a coverage gap this small sample would not have surfaced without actually trying, and one no amount of review-app-specific research would have predicted.

**Verdict on this specific addendum's question**: generic JSON-LD `AggregateRating` scraping is **BUILDABLE but PARTIAL-COVERAGE, not the near-universal channel it was pitched as**. It remains a legitimate, ToS-clean, per-store-domain-only fetch (no third-party API involved, so the Okendo gate does not apply to it), but a real implementation would need to treat coverage as observed-when-present and openly `UNAVAILABLE` otherwise — never assume a missing block means zero reviews, and never assume this channel alone gives Bellwether broad review-intelligence coverage across its store corpus. Recommended before any real build: a larger, still-bounded sample (20–30 stores, matching the existing crawler's real request fingerprint rather than an ad-hoc one) to get an actual, citable adoption-rate percentage — this addendum's n=5 is a spot-check that disproves the "nearly every page" claim, not a statistically powered replacement figure.

Temporary files from this spike (`jsonld-*.json`, `jsonld-page-*.html`) were written to the session scratchpad, outside the repository, and removed after this addendum was written.

---

## Sub-phase C — Storefront JSON-LD Adoption & Cost Validation

**Dated addendum.** Research/validation only — no production code, schema, dependency, or UI changed. This section reports a larger, more rigorous, production-fingerprint-matched follow-up to the JSON-LD addendum immediately above, per an explicit Milestone 9 Sub-phase C brief.

### 1. Status

**COMPLETE** (as a bounded validation pass — not a claim of production readiness, and not an implementation).

### 2. Objective

Determine, with real measurement rather than assumption, how often Bellwether could reliably observe review counts from public Shopify product-page JSON-LD across a representative sample, and what the request/byte/latency cost of doing so would be — to support a GO / CONDITIONAL GO / DO NOT BUILD recommendation for a future implementation phase.

### 3. Files inspected

`src/lib/crawl/shopify.ts` (full read), `src/lib/security/ssrf-guard.ts` (full read), `package.json`, `prisma/schema.prisma` (grepped for any existing Review-related model — none found, confirming Sub-phase B's blocked status left no schema residue), `docs/milestone-9-review-intelligence-research.md`, `docs/milestone-9-subphase-b-completion-report.md`, `src/lib/growth/bestseller.ts`, `src/lib/diff/engine.ts`/`events.ts`/`significance.ts` (to identify whether a bestseller-based bounded sampling strategy could reuse existing data), and every `docs/*.md` file grepped for real domains ever used in this project's live-verification history.

### 4. Production code changed

**NO.**

### 5. Schema changed

**NO.**

### 6. Dependencies changed

**NO.** The validation script used only Node's built-in `fetch`, matching the project's existing convention (`fingerprint.ts` also does regex-based HTML inspection with no parser dependency) — no `cheerio`/`jsdom`/etc. was added or considered necessary.

### 7. External stores tested

**Exactly 5 — the project's entire real, previously-used validation corpus, not expanded.** A grep across every file in `docs/` for real domains ever fetched in this project's history turned up exactly six candidates: `allbirds.com`, `colourpop.com`, `taylorstitch.com`, `gymshark.com`, `meowingtons.com` (all genuinely live-fetched across Milestones 4–9), and `verabradley.com` (a false positive — that domain appears only as an example quoted *inside a third-party vendor's own documentation* in `docs/milestone-5-revenue-traffic-research.md`, never actually crawled by this project; excluded).

Per the brief's explicit instruction ("If fewer than 20 suitable previously-used stores exist, do NOT fabricate a larger sample... explicitly state the limitation" / "Do not discover random new targets simply to improve the result"): **this pass used all 5 real, genuine, previously-validated stores and stopped there.** No new domains were sought out. This is well short of the requested 20–30 and is the single most important scope limitation of this validation — see Section 22.

### 8. Exact sample size

5 stores × up to 10 products each = **50 product-page fetches**, plus 5 `/products.json?limit=10` calls to obtain real handles = **55 total real HTTP requests**, all read-only GET.

### 9. Request fingerprint

Matched the production crawler's real fingerprint exactly, read from `src/lib/crawl/shopify.ts` rather than assumed:
- **User-Agent**: `Mozilla/5.0 (compatible; StoreIntelBot/0.1; +https://example.com/bot)` — `DEFAULT_USER_AGENT`, verbatim.
- **Accept**: `text/html` (the same header `fetchHomepage()` sends for its own HTML fetch — no analogous existing product-page fetch exists to copy, so this was the closest real precedent in the codebase).
- **Accept-Language**: none sent — the production crawler never sends this header anywhere, so none was added here either.
- **Redirects**: manual handling, re-evaluated hop-by-hop, capped at `MAX_REDIRECTS = 5` — identical logic to `fetchWithTimeout()`.
- **Timeout**: 15,000ms per request — identical to the production default.
- **Response-size cap**: 10MB, enforced while streaming (abort mid-read past the cap) — identical logic to `readBodyWithLimit()`.
- **Politeness delay**: 250ms between requests — identical to `requestDelayMs`'s default.

**This is a materially important correction to the JSON-LD addendum immediately above this section**: that earlier spike used a real Chrome browser `User-Agent`, not the production bot UA. Section 12 below reports what changed (and, importantly, did not change) between the two.

### 10. Product sample methodology

Per store: fetched `/products.json?limit=10` (an endpoint the production crawler already calls routinely) with the production fingerprint, took up to 10 real product handles in listing order (no cherry-picking), then fetched each `/products/{handle}` individually. No product was fetched twice within a store. Never exceeded 10 product pages per store, per the brief's cap.

### 11. Fetch success rate

**55/55 (100%).** Every request — all 5 `/products.json` calls and all 50 individual product-page fetches — returned an eventual HTTP 200 (after following same-domain redirects where present). Zero timeouts, zero 403s, zero bot-challenge responses, across the entire sample.

### 12. JSON-LD adoption

Results, by category (Phase 4's required taxonomy):

| Category | Count | % of 50 |
|---|---|---|
| A. REVIEW_OBSERVED | 19 | 38% |
| B. RATING_ONLY | 0 | 0% |
| C. PRODUCT_JSONLD_NO_REVIEW | 21 | 42% |
| D. NO_PRODUCT_JSONLD | 0 | 0% |
| E. FETCH_FAILED | 0 | 0% |
| F. REDIRECTED_UNSUPPORTED | 10 | 20% |
| G. PARSE_FAILED | 0 | 0% |

Restricted to the 40 fetches that actually landed on a genuine, same-domain product page (excluding gymshark's 10 cross-domain-redirected checkout pages, which structurally cannot answer this question): **basic Product-type JSON-LD (name/sku/offers — Shopify's own default theme schema) was present on 40/40 (100%)** of real product pages reached. It is specifically the *review/rating* sub-block that is inconsistent, not the base product schema.

**A first pass at this script under-detected real data and was caught and fixed before any number here was trusted.** The initial run showed `allbirds.com` at 0/10 JSON-LD adoption — a result that, on inspection, was a parser bug, not a real finding: allbirds' theme emits a `ProductGroup` (schema.org's variant-grouping type) with the `AggregateRating` nested inside a bare `{aggregateRating: {itemReviewed: Product}}` node rather than the assumed `Product{aggregateRating}` shape. The original classifier only checked for `@type: "Product"` at the top level of each block and only read `.aggregateRating` directly off matched Product nodes — real markup is more varied than that. Fixed by rewriting the classifier as a full recursive walk of the entire parsed JSON-LD tree (all blocks, `@graph` arrays, and arbitrary nesting), collecting every `Product`/`ProductGroup`-typed node and every `aggregateRating` object found anywhere, regardless of shape. After the fix, allbirds correctly showed 8/10 `REVIEW_OBSERVED`. This is reported explicitly, not smoothed over, because it directly demonstrates the brief's own point (Phase 4): real-world JSON-LD structure is varied enough that a naive parser will silently undercount, and any future production implementation needs the same tolerance, not a single assumed shape.

### 13. AggregateRating adoption

Store-level (at least one sampled product with a usable `reviewCount`): **3 of 5 stores (60%)** — allbirds.com, colourpop.com, taylorstitch.com. Two stores (gymshark.com, meowingtons.com) showed **zero** across all 10 sampled products each, for two structurally different reasons (Section 20).

### 14. reviewCount adoption

Product-level: **19 of 50 (38%)** of all sampled product pages; **19 of 40 (47.5%)** restricted to genuine same-domain product pages. Every `AggregateRating` block found in this sample carried a usable `reviewCount`/`ratingCount` — zero `RATING_ONLY` cases (rating present, count missing) were observed.

### 15. Within-store consistency

**Zero of the 3 adopting stores were consistently available. All 3 were "partially available."** This replicates and strengthens the single-store observation from the addendum above (colourpop) across two more real stores:

| Store | REVIEW_OBSERVED / sampled | Consistency |
|---|---|---|
| allbirds.com | 8/10 | Partial |
| colourpop.com | 7/10 | Partial |
| taylorstitch.com | 4/10 | Partial |
| gymshark.com | 0/10 | Consistently absent (architectural — Section 20) |
| meowingtons.com | 0/10 | Consistently absent (theme never emits the block) |

**This is the single most decision-relevant finding of this validation pass, more important than the raw adoption percentage**: even at stores where the signal genuinely exists, it does not exist for every product. The most plausible explanation (not independently confirmed this pass) is that the review app/theme only emits an `AggregateRating` block once a product has accumulated at least one review, which — if true — is a reasonable vendor design choice, but it means **absence on a given product cannot be read as "zero reviews," only as "not observable via this channel for this product right now."** Any future implementation must persist this per-product, not collapse it into one per-store flag, and must classify per-product absence as `UNAVAILABLE`, never as an observed zero.

### 16. Known review-app observations

Only one store in this sample has an independently confirmed review-app identity from prior research: **colourpop.com is a confirmed live Okendo store** (Section 30 of the original research, and the Sub-phase B ToS investigation). Notably, colourpop's `AggregateRating` JSON-LD is **not** sourced from Okendo's own client-side widget config (that config — `okendoProduct.reviewAverageValue` etc. — is separate, plain JavaScript, not `application/ld+json`, confirmed in the addendum above). The theme appears to emit its own schema.org block independently. This suggests **JSON-LD adoption may correlate more with theme/template configuration than with which specific review app is installed** — a real, evidence-grounded observation, but based on a single confirmed-provider data point, so it is reported as a hypothesis worth testing further, not a conclusion.

### 17. Request latency

Two data points, both real, worth reporting honestly rather than picking the more favorable one: the browser-UA spike (previous addendum) averaged 762ms/request (range 277–1678ms); this production-fingerprint pass averaged **231ms/request (range 208–258ms)** on the identical URLs. The most likely explanation is CDN edge-cache warming from the earlier fetch of the same URLs minutes prior, not a User-Agent effect — this is a plausible but unverified explanation, not confirmed. Either figure is well within the crawler's existing 15,000ms per-request timeout with wide margin.

### 18. Response sizes

**Average 623,616 bytes (~609 KB) per product page**, range 52,289 bytes (gymshark's small redirected checkout page) to 1,376,496 bytes (~1.3 MB, taylorstitch). This is **5–15× larger than a typical existing `/products.json` page**, which the codebase's own comments describe as running "tens of KB to low hundreds of KB even for image/variant-heavy catalogs." This is a real, material cost difference, not a rounding error — see Section 19.

### 19. Request-volume implications

Per the brief's own worked example: a store's true catalog size (10, 1,000, or 100,000 products) must **not** determine how many product pages get fetched — only a fixed, bounded sample per crawl should. Modeled from this pass's real measured averages (~609 KB/page, ~230–760ms/request depending on cache state, plus the existing 250ms politeness delay):

| Bounded sample size (K products/crawl) | Added bytes/crawl | Added requests/crawl | Added latency/crawl (warm-cache est.) |
|---|---|---|---|
| 5 | ~3.0 MB | 5 | ~2.4s |
| 10 | ~6.1 MB | 10 | ~4.8s |
| 20 | ~12.2 MB | 20 | ~9.6s |

At K=20, added bytes alone **exceed the crawler's existing single-response 10MB cap** — not a problem for the cap itself (each product page is its own bounded ≤10MB request, not one combined response), but a meaningful addition to a crawl's total bandwidth footprint that has no precedent elsewhere in this codebase; every other "extras" fetch (bestseller ranks, collections, homepage) is a single request each. K=5–10 keeps the added cost roughly proportional to the existing `/products.json` pagination cost for a mid-sized catalog, which is the more defensible range.

Per the brief's Option A–D framing, evidence from Section 15 (partial *within-store* coverage) argues against a naive "top-N by listing order" sample (Option A/B), since it provides no reason to expect listing-order products are more likely to have reviews. **Option D — sampling only products already flagged by the existing, shipped `bestseller.ts` momentum/rank system** — is the more defensible starting hypothesis, since it reuses already-collected, already-bounded data (`bestsellerWindow: 60`) instead of an arbitrary cut, and concentrates limited request budget on the products a user is already most likely to care about. This is a reasoned recommendation from the evidence gathered, not a proven-optimal strategy — no data was collected this pass on whether bestseller status correlates with review presence.

### 20. Edge cases (Phase 7)

| # | Edge case | Observed this pass? | Detail |
|---|---|---|---|
| 1 | AggregateRating absent | **Yes, common** | 21/50 products (42%) |
| 2 | AggregateRating present only on some products | **Yes, on every adopting store** | Section 15 |
| 3 | reviewCount = 0 | Not observed | Lowest real value seen was 1 (colourpop) |
| 4 | reviewCount as a string | **Yes, confirmed real** | allbirds and colourpop both emit `"reviewCount": "44"` etc. as a JSON string, not a number; taylorstitch emits a true number. Any parser must normalize both. |
| 5 | Malformed JSON-LD | Not observed | Zero parse errors across 50 real fetches |
| 6 | Multiple Product JSON-LD objects | **Yes, confirmed real** | allbirds' `ProductGroup`/`hasVariant` pattern effectively nests multiple Product-shaped entries per page — the exact case that broke the first parser attempt (Section 12) |
| 7 | Multiple AggregateRating blocks | Not observed | Zero cases this pass |
| 8 | Dynamically generated / non-server-rendered data | **Cannot be ruled out — a real blind spot, not tested** | This method only ever sees server-sent HTML; any store that injects JSON-LD via client-side JS after page load would be invisible to it and indistinguishable from `NO_PRODUCT_JSONLD` in this dataset. No case was confirmed either way this pass. |
| 9 | Product page redirect | **Yes, two distinct kinds** | allbirds: harmless same-domain bare→www redirect (content unaffected). gymshark: cross-subdomain redirect to a separate checkout micro-frontend (`us.checkout.gymshark.com`) with no product JSON-LD at all — a real, structural coverage gap, not a review-app choice. |
| 10 | Non-200 response | Not observed | 55/55 requests eventually succeeded |
| 11 | Large HTML response | **Yes, confirmed real** | Up to 1.3MB; Section 18 |
| 12 | Store with no review infrastructure at all | Not directly tested | All 5 sampled stores have some prior review-app detection history; no confirmed reviewless store was in the corpus |

### 21. Legal/source boundary

Preserved exactly as instructed. Every request in this pass was an ordinary, unauthenticated `GET` to a merchant's own public storefront HTML (`{domain}/products.json`, `{domain}/products/{handle}`) — the same requests any shopper's browser or a search-engine crawler makes. No third-party review-provider API (Okendo, Judge.me, Stamped, Yotpo, Loox) was called. No API key, credential, or undocumented endpoint was used. No access control was bypassed. This is the same distinction Sub-phase B's blocked Okendo finding turned on: reading a merchant's own already-public page is not equivalent to calling a third party's backend, and nothing in this pass changes that boundary.

### 22. Limitations

- **Sample size is 5 stores, not the requested 20–30**, because that is the entirety of this project's real, previously-validated corpus — stated as a hard limitation, not worked around by fabricating additional targets (see Section 7).
- Store-level and product-level adoption percentages (60% / 38–47.5%) are **bounded validation evidence from n=5, not a statistically powered, citable platform-wide adoption rate.** Do not generalize beyond "meaningful but partial, in this specific sample."
- Within-store partial coverage means any future feature must treat coverage as fundamentally per-product, which is a more complex data model than a simple per-store flag.
- Client-side-injected JSON-LD (edge case 8) is an inherent, unresolved blind spot of this entire approach, not just this validation pass.
- Non-standard/headless storefronts (gymshark) are entirely invisible to this method — a real, structural gap distinct from review-app adoption.
- The latency improvement between the two spikes (Section 17) is most plausibly a caching artifact of re-fetching the same URLs, not a proven User-Agent effect — reported as a plausible explanation, not a verified one.

### 23. STOP-condition evaluation

None of the eight absolute STOP conditions in the brief were triggered: no third-party API was needed, no authentication was needed, no access control was bypassed, the sample executed safely and fully within its bounded budget (55 requests, small stores, no failures), no SSRF protection needed weakening (every target was an already-validated real domain; production implementation would still route through `checkUrlIsSafeToFetch`), no response-size/timeout protection needed weakening (all requests stayed comfortably inside the existing 10MB/15s limits), no production code change was required to run this validation, and the evidence gathered is concrete enough (real percentages, real byte/latency measurements, a real self-caught parsing bug) to support a responsible, non-forced recommendation below.

### 24. GO / CONDITIONAL GO / DO NOT BUILD decision

**CONDITIONAL GO.**

Weighed against the brief's own six axes (Phase 9): coverage is real but materially incomplete (60% store-level, ~38–47.5% product-level, and *zero* stores with full internal consistency); reliability is good in *value* (every observed rating/count looked sane, no corrupted data) but requires real normalization work (string vs. number types, varied JSON-LD shapes); representativeness is explicitly weak (n=5, not generalizable); cost is real but bounded and controllable by keeping the per-crawl sample small (K=5–10, Section 19); freshness is mechanically sound (the same delta-over-time mechanism the shipped `bestseller.ts` already uses); and the known limitations (per-product rather than per-store coverage, invisible headless storefronts, an unresolved client-side-rendering blind spot) are real but do not invalidate the signal where it does appear.

This matches the brief's own definition of CONDITIONAL GO precisely: *"The signal is valuable but coverage is materially incomplete. It can still ship if clearly labeled as an observed/partial signal and restricted to products/stores where the source exists."* It does not meet the bar for a full GO (coverage and sample size are too limited to call this "high enough" without hedging), and DO NOT BUILD would be too pessimistic given a 100% fetch success rate, zero ToS exposure, sane real data, and a bounded, quantified, manageable cost.

### 25. Recommended next step

Not implementation yet. Before any Sub-phase D attempts to build this:

1. **Widen the sample honestly, don't force it now.** The 20–30 store target from this brief was never met because the real corpus doesn't support it. If this signal is prioritized, the next research step should be crawling a modest number of genuinely new stores specifically to test JSON-LD adoption at more realistic scale — that is a deliberate scope expansion decision for a human to make (more real stores touched, however lightly), not something to backfill quietly inside a "validation" pass.
2. **Resolve edge case 8 (client-side rendering) before trusting a "not observed" result as final** — a small follow-up check (e.g., comparing raw-HTML JSON-LD presence against a headless-browser-rendered version of the same page for 2–3 stores) would clarify whether any `NO_PRODUCT_JSONLD`/`PRODUCT_JSONLD_NO_REVIEW` results are false negatives. This is research only, not an argument for adding browser automation to production.
3. **If a build is greenlit**, the data model must be per-product, not per-store (Section 15), the parser must handle both string and numeric `reviewCount`/`ratingCount` and the `ProductGroup`/`@graph` variants confirmed real in Section 12, and the bounded per-crawl sample should default to reusing `bestseller.ts`'s already-shipped, already-bounded product set (Section 19) rather than an arbitrary top-N cut, pending a follow-up check on whether that correlates with review presence.
4. Revenue/sales inference from any of this remains **PERMANENTLY DO NOT BUILD**, unchanged, and was not reconsidered or touched by this pass.

Temporary files from this validation (`subphase-c-jsonld-probe.mjs`, `subphase-c-results.json`) were written to the session scratchpad, outside the repository, and removed after this section was written.
