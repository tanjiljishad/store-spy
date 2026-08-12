# Milestone 4, Sub-phase A — Marketing & Advertising Intelligence
## Research, Data-Source Validation & Architecture Spike

**Status:** Research only. No production code, schema, crawler, UI, auth, entitlement, or scheduler changes were made. This document is the entire deliverable for this sub-phase.

**Method note on sourcing:** Every platform-capability claim below was checked against an official source (Meta for Developers / Meta Transparency Center, TikTok for Developers, Google's own support/transparency pages) via direct fetch, not inferred from third-party "ad spy tool" marketing blogs. Where a claim could only be corroborated by secondary sources, or where official and secondary sources disagreed, that is stated explicitly rather than silently resolved. Where something could not be verified at all, it is marked **UNKNOWN**.

---

## SECTION 1 — Repository architecture findings

Re-inspected directly for this sub-phase (not assumed from memory):

- **Crawler (`src/lib/crawl/shopify.ts`)**: a single-purpose Shopify JSON crawler. Every outbound request goes through `checkUrlIsSafeToFetch()` (`src/lib/security/ssrf-guard.ts`) — including on **every redirect hop**, via manual (`redirect: "manual"`) handling in `fetchWithTimeout()`, because a validated URL can redirect to an internal address the original check never saw. There is no generic "fetch arbitrary external URL" utility exposed for reuse elsewhere yet — any new collector that needs to follow an ad's destination URL must route through this same guard, not bypass it.
- **SSRF guard**: allowlist-based (`ipaddr.js` "unicast" range only), resolves and checks every DNS answer, unwraps IPv4-mapped IPv6. Documented residual gap: no DNS-rebinding protection at the transport layer. This guard is platform-agnostic already — it takes a raw URL, nothing Shopify-specific — so it's directly reusable for ad-destination-URL validation with zero modification.
- **Rate limiting (`src/lib/security/rate-limit.ts`)**: in-memory, single-process, fixed-window. Explicitly documented as unsafe across multiple instances. Fine for inbound request throttling today; **not** suitable as the mechanism for respecting a third-party API's rate limit if this app ever runs as more than one process (see Section 15).
- **Event model**: `EventType` is a **Postgres native enum** (`prisma/schema.prisma`), currently 22 values, all product/tech/store fields. Adding marketing event types is an additive `ALTER TYPE ... ADD VALUE` migration — safe, non-breaking, same pattern already used for `CrawlTrigger` in Milestone 2.
- **Append-only event architecture**: `Event.dedupeKey` (unique) + `skipDuplicates: true` is the existing idempotency mechanism; `backfilled` distinguishes real-time-alertable events from reconstructed history. Any marketing event pipeline should reuse this exact mechanism rather than inventing a second one.
- **Store tier / global corpus**: `Store.tier` (HOT/WARM/COOL/COLD/DORMANT/DISABLED) is global and shared — `src/lib/monitoring/watch.ts`'s `recomputeStoreTier()` promotes to HOT while ≥1 user actively watches a store, demotes to COLD otherwise. This is the natural priority signal for marketing-intelligence collection too (Section 16).
- **Scheduler**: `claimDueStores()` uses `SELECT ... FOR UPDATE SKIP LOCKED` + pushes `nextCrawlAt` forward as the claim marker — no queue dependency today. `runSchedulerTick()` runs claimed stores sequentially, once per tick.
- **Dependencies**: confirmed via `package.json` — **no queue library** (no BullMQ/Redis client), **no headless browser** (no Playwright/Puppeteer), **no OCR**, **no AI/embeddings SDK**. Everything today is plain Node `fetch` + Prisma. This is a real, load-bearing fact for the architecture options in Section 22: any option requiring browser automation or a distributed queue is a genuinely new infrastructure category for this codebase, not an incremental add.
- **Test infrastructure**: embedded ephemeral Postgres for integration tests, strict UTC-timestamp rule (`AGENTS.md`'s "Database time rule" — any raw SQL comparing a Date against a `TIMESTAMP` column must `AT TIME ZONE 'UTC'` cast), live-HTTP smoke testing convention. All directly reusable for a marketing-intelligence pipeline with no changes.

**Findings for the specific questions asked (Section 3 of the brief):**

- **(A) Where should a new external collector live?** `src/lib/marketing/` (new, parallel to `src/lib/crawl/`, `src/lib/monitoring/`), following the same Prisma-free pure-core / IO-boundary split already established by `crawl/` and `diff/`.
- **(B) Does the current crawler support multiple data sources?** Not today — `crawlShopifyStore()` is Shopify-specific end to end (URL shape, JSON parsing, pagination quirks). It is **not** a generic multi-source crawler and shouldn't become one; a marketing-intelligence collector is architecturally a sibling, not an extension.
- **(C) Where should it run?** A **separate scheduled pipeline** (Section 22) — not inside the Shopify crawl. Ad-transparency sources have entirely different rate limits, failure modes, and cadences than a Shopify storefront (see Section 15); coupling them would make one source's outage or throttling block the other.
- **(D) How do external observations enter the event system?** Same append-only `Event` table, new `EventType` values (Section 14), `entityType` extended with a marketing-specific value or a parallel `MarketingEvent` table if the shape diverges too far (Section 13 explains the tradeoff).
- **(E) Relationships**: a marketing observation is fundamentally `Store`-scoped (global corpus) and optionally `Product`-scoped once matched (Section 8) — never `User`-scoped, mirroring the existing `AdvertisingEvidence`-should-be-global principle already established in this project's own prior milestone planning.

---

## SECTION 2 — Marketing intelligence product definition

Going through the brief's own list of target questions and honestly separating what's realistically answerable from what isn't, **given the sources actually found in Sections 4-7**:

| Question | Realistically answerable? | How |
|---|---|---|
| Is this competitor currently advertising? | **Partially** — only on platforms/regions where a transparency source exists and returns a positive result. Absence of a result is never proof of absence (Section 19). | Google ATC (broad), Meta official API (EU/political only) |
| Where are they advertising? | **Partially** — limited to the platforms we integrate and the regions those platforms disclose. | Per-source |
| Which products are they promoting? | **Yes, with real confidence variance** — high confidence when the ad's destination URL is an exact product URL; lower otherwise. | Deterministic URL matching (Section 8) |
| Which landing pages are being used? | **Yes** — the destination URL itself is directly observed when the source discloses it. | Direct field from source |
| What promotional offers are being used? | **Partially** — only what's visible in static Shopify-crawlable HTML/JSON (Section 10); not what's in ad creative text/images without OCR/vision, which is out of MVP scope. | Existing crawler extension |
| Are they running sales funnels? | **Narrowly, structurally** — only as a labeled set of *observed steps* (ad→landing→product), never as a certified claim of "yes, a funnel exists" (Section 9). | Combination |
| Which products receive sustained attention? | **Yes, but only after enough historical observations accumulate** — this is a *derived* signal from our own repeated observations over time, not something any single source hands us directly. | Our own event history |
| When did advertising activity begin/end? | **Yes, but bounded by when *we* started observing**, not true campaign start (unless the source explicitly discloses a start date, which varies by source/region). | firstSeenAt/lastSeenAt (Section 21) |
| Did activity change after a launch/price change? | **Yes, eventually** — this is a correlation over our own accumulated event timeline, achievable once both product-change events and ad-observation events exist in the same append-only store. Not an MVP feature. | Future analysis over existing data |
| Which platforms matter most to this competitor? | **Only across the platforms we cover** — cannot make a claim about platforms we don't observe. | Aggregation over integrated sources |

**Conclusion:** most of the brief's product questions are answerable in *degree*, not absolutely — and several (funnel existence, "sustained attention," platform importance) are only honestly answerable as a byproduct of accumulated history, not a single observation. This directly supports Section 21's narrow MVP scope and Section 20's emphasis on historical accumulation as the actual long-term product moat, exactly as the brief itself anticipated in Section 22 of the brief ("The long-term moat... is not simply scraping. It is accumulated historical intelligence").

---

## SECTION 3 — Data-source comparison

| Source | Official URL | Public/no-login | API exists | Approval needed | Commercial use | Scraping stance | Coverage | Product-ID capability |
|---|---|---|---|---|---|---|---|---|
| Meta Ad Library **API** (`ads_archive`) | `developers.facebook.com` / `facebook.com/ads/library/api` | No (OAuth token) | **Yes, official, free** | Identity verification only (no app review) | Allowed within Terms; resale/bulk-redistribution prohibited | N/A (it's an API) | Political/social-issue/housing/employment/credit ads: **global**. Ordinary commercial ads: **EU/UK only** (1-yr archive) | Destination URL field present |
| Meta Ad Library **website** ("All ads") | `facebook.com/ads/library` | Yes | No (UI only) | N/A | Meta's own Terms **prohibit** automated scraping of it | Broader than the API for *currently active* ads (any Page, any country) — see caveat below | Same, manual/UI only |
| TikTok Commercial Content API | `developers.tiktok.com` | No | **Yes, official** | **Yes — research-project application, ~2 business days** | Ambiguous; positioned for "researchers," commercial-SaaS eligibility **UNKNOWN** | N/A (it's an API) | **EU only** currently; global expansion "planned," no date found | Destination/targeting fields present per docs |
| TikTok Creative Center (Top Ads) | `ads.tiktok.com/business/creativecenter` | Partial (5 ads signed-out, more signed-in) | No | No (free account) | Allowed for browsing; no data-export API | **Curated subset only** — high performers, not per-advertiser lookup | Global | No per-advertiser search at all |
| Google Ads Transparency Center | `adstransparency.google.com` | **Yes, fully, no login** | **No official API** (third-party paid wrappers exist) | No | **UNKNOWN** — no explicit ToS statement on automated access found for this specific tool | **Global**, searchable by advertiser/domain | Search, Shopping, Display, YouTube, Maps, Play | Shopping-ad product data plausible; not directly confirmed |
| Pinterest Ads Repository | via Pinterest Business Help | Yes | No official API | No | UNKNOWN | **EU only** | Active promoted pins only | Limited |
| LinkedIn / Snapchat / X ad repositories | (not deep-researched) | Varies | No | — | — | **EU-only pattern confirmed for peers**, assumed same absent evidence otherwise | EU only | Low relevance — minority ad channel for typical Shopify DTC brands |

**The single most important pattern across every platform researched:** the EU's Digital Services Act (DSA) is the actual forcing function making *any* commercial (non-political) ad transparency data public at all. Every platform's *comprehensive* ad archive is EU-scoped; *global* coverage exists only for political/social-issue ads (Meta) or as a curated/non-comprehensive view (TikTok Creative Center), with **Google's Ads Transparency Center as the one clear exception** — it is genuinely global, no-login, and covers Shopping ads specifically, which is the most directly relevant ad format to a Shopify competitor-intelligence product.

---

## SECTION 4 — Meta/Facebook findings

**Sources:** [Meta for Developers — Graph API `ads_archive` reference](https://developers.facebook.com/docs/graph-api/reference/ads_archive/), [Meta Ad Library API](https://www.facebook.com/ads/library/api), [Meta Transparency Center — Ad Library tools](https://transparency.meta.com/researchtools/ad-library-tools/), [Meta Automated Data Collection Terms](https://www.facebook.com/legal/automated_data_collection_terms), search-corroborated detail on EU/UK vs. rest-of-world coverage.

- The **official API** (`ads_archive` Graph API endpoint) is free, requires only identity verification (no app review needed for base access), and returns `ArchivedAd` nodes filterable by country and "special ad category."
- **Critical, precisely-sourced limitation**, quoted directly from the official reference: *"Ads that did not reach any location in the EU will only return if they are about social issues, elections or politics."* This means: for a US-only Shopify store that has never targeted EU/UK audiences, its ordinary product ads are **not** retrievable through the official API at all — not "zero ads found," but "this access path cannot see this category of ad for this advertiser."
- **EU/UK exception**: any ad delivered to EU/UK users, of any kind (commercial included), is archived and searchable for up to one year after it stopped running.
- **Rate limit**: ~200 calls/hour/app for standard access (unverified against a primary numeric source — the official reference only confirms the *existence* of a rate-limit error code, not the exact threshold; the 200/hr figure comes from secondary sources and should be treated as approximate, not contractual).
- **The website vs. API discrepancy (flagging per the brief's Section 30 instruction, not silently resolving it):** multiple secondary sources describe the Ad Library **website's** "All ads" category as letting a user search any Page/advertiser and see their **currently active** ads globally, regardless of category — which reads as broader than what the documented API exposes for the same non-EU commercial case. I could not confirm from an official source whether this is (a) the website surfacing the same API data through a different UI framing I'm misreading, or (b) a genuinely broader internal capability not exposed through the public API. This is marked **UNKNOWN** and should not be assumed either way before Sub-phase B.
- **Terms of Service**: Meta's own Automated Data Collection Terms and Research Tool terms **explicitly prohibit scraping** the Ad Library website. A January 2024 U.S. federal court ruling reportedly found that scraping *publicly accessible, logged-out* data doesn't violate certain anti-hacking statutes — but that is a different legal question from whether it breaches Meta's own contractual Terms of Service, which the brief instructs us to respect regardless. **Conclusion: only the official `ads_archive` API is in scope for this product; the website's broader "All ads" view is explicitly out of scope unless/until confirmed available through the official API.**

---

## SECTION 5 — TikTok findings

**Sources:** [TikTok for Developers — Commercial Content API](https://developers.tiktok.com/products/commercial-content-api), [Commercial Content API — Getting Started](https://developers.tiktok.com/doc/commercial-content-api-getting-started), [TikTok Newsroom — Expanding Research API and Commercial Content Library](https://newsroom.tiktok.com/en-eu/expanding-tiktoks-research-api-and-commercial-content-library), direct fetch of the Top Ads dashboard.

- **Commercial Content API**: official, requires a developer account + application (TikTok states ~2 business days for a decision), issues a `client_key`/`client_secret` → access token once approved. Exposes `published date`, `last seen date`, targeting parameters, impressions-seen count, advertiser metadata, and disapproved-ad data. Data retained "for the period the ad ran, and until one year since it was last shown."
- **Coverage is EU-only today**, explicitly stated by TikTok itself, with global expansion described as planned but undated. Applicants may be located in any country, but the **data itself** is EU-scoped only.
- **Commercial eligibility is genuinely unclear.** TikTok's own framing leans toward "researchers" and regulatory compliance; nothing found explicitly confirms or excludes a commercial SaaS product as an eligible applicant. Marked **UNKNOWN** — would need a real application submitted to resolve, which is out of scope for a research-only sub-phase.
- **Creative Center Top Ads**: confirmed via direct fetch — filterable by region/objective/format/like-threshold, **no advertiser-name search**, explicitly a curated "high-performing" subset (independently corroborated: "Top Ads is a curated collection... not a complete public database," matching this project's own prior finding from Milestone 3). **Not usable for "is competitor X advertising" lookups** — it answers "what's trending," not "what is this specific store doing."
- **Net assessment**: TikTok is the **weakest** of the three major platforms for this product's purposes today — EU-only API with unclear commercial eligibility, and a public tool that structurally can't do per-advertiser lookup.

---

## SECTION 6 — Google findings

**Sources:** [Google Ads Transparency Center](https://adstransparency.google.com/), [Google Support — Ads transparency](https://support.google.com/adspolicy/answer/13733850), search-corroborated detail on coverage and access.

- **No official public API.** Confirmed by absence — no official Google documentation for a programmatic Ads Transparency Center endpoint was found; the only "APIs" available are unofficial third-party wrapper services (SerpApi, SearchApi.io) that scrape the public site and resell structured access.
- **The public website itself is the most broadly useful transparency surface found in this entire research pass**: searchable by advertiser name *or* website/domain, no login required, covers Search, Shopping, Display, YouTube, Maps, and Play ad formats, filterable by date and targeted region. **Shopping-ad coverage is the single most directly relevant fact found for this product** — Shopping ads are structurally the closest ad format to "advertising a specific Shopify product."
- **Explicit automated-access ToS statement**: not found. This is a real gap — I have no primary-source confirmation either permitting or prohibiting automated querying of `adstransparency.google.com` specifically (as distinct from general Google Search scraping policy, which is more clearly restrictive but is a different product). Marked **UNKNOWN**, and treated as **MEDIUM legal risk** rather than LOW until confirmed (Section 18).
- **De-risking path**: third-party providers (SerpApi, SearchApi.io) already operate paid, productized access to this data. Using a licensed vendor converts an uncertain scraping question into a normal vendor-cost line item, and shifts first-order ToS exposure to a company whose business model depends on having resolved it — a materially different risk posture than building our own scraper against Google directly. This is a genuine architectural decision, not a foregone conclusion, and is treated as such in Section 22.

---

## SECTION 7 — Other useful sources

- **Pinterest Ads Repository**: EU-only (same DSA pattern), no official API, promoted-pins-only (not full campaign history). Given Pinterest is a minority advertising channel for most Shopify DTC brands relative to Meta/Google/TikTok, and offers no US/global coverage, **not recommended for MVP inclusion** — revisit only if a specific customer segment (e.g., home/lifestyle brands) shows Pinterest is materially important to them.
- **LinkedIn, Snapchat, X**: not deep-researched in this pass; secondary sources describe the same EU-only DSA-repository pattern as Pinterest/TikTok. Given these are even less central to typical Shopify e-commerce advertising than Pinterest, **out of scope** for this research pass and MVP.
- **Third-party ad-intelligence aggregators** (e.g., SerpApi, SearchApi.io, and consumer-facing tools like PowerAdSpy/Foreplay/AdSpy referenced throughout the secondary sources): not a "data source" in the same sense as the platforms themselves, but a **legitimate alternative architecture** for accessing Google's (and potentially Meta's website) data without building and maintaining our own scraper — see Section 22.

---

## SECTION 8 — Product ↔ advertisement matching strategies

Ranked from most to least reliable, per the brief's explicit instruction to prefer deterministic signals over AI:

| # | Strategy | Confidence | False-positive risk | Cost | Deterministic? |
|---|---|---|---|---|---|
| 1 | Exact destination-URL match to a known `Product.handle`/URL already in our own Shopify crawl data for that store | **HIGH** | Very low — the URL either matches a real crawled product or it doesn't | Low (string match against already-persisted data) | Yes |
| 2 | Destination URL matches a known `Collection` handle | **MEDIUM-HIGH** | Low, but ambiguous (a collection ad promotes N products, not one) | Low | Yes |
| 3 | Destination is the bare domain root or an unrecognized path (a dedicated landing page) | **LOW-MEDIUM as product evidence; HIGH as "this store advertises" evidence** | N/A for product-matching (it isn't one) — but real signal for funnel detection (Section 9) | Low | Yes, but doesn't resolve to a product |
| 4 | Product title/name string match between ad creative text (where the source discloses ad copy) and a crawled `Product.title` | **MEDIUM** | Real — generic titles ("Classic Tee") collide across unrelated products/stores | Low | Mostly, with fuzzy-match tuning |
| 5 | SKU/product-identifier match, where an ad platform exposes a merchant product ID (most plausible for Google Shopping ads, which are fed from a product catalog) | **HIGH when available** | Low | Low | Yes |
| 6 | Image similarity/perceptual hash between ad creative and product photos | **MEDIUM**, degrades with generic product photography | Moderate | Meaningfully higher (image fetch + hashing pipeline) | Semi — hash comparison is deterministic, but the *matching threshold* is a tuned heuristic |
| 7 | AI-assisted semantic matching (title+description+image via an LLM/embedding) | **LOW-MEDIUM**, must always render as `INFERRED` per the epistemic model | Highest | Highest (inference cost) | No |

**Recommendation**: MVP implements **only strategy #1** (and #2 as a labeled, lower-confidence variant) — exact destination-URL matching against data the Shopify crawler has *already* persisted. This needs no new external dependency, no AI, no image pipeline, and produces the single highest-confidence, cheapest signal available. Strategies 4-7 are explicitly deferred, consistent with Section 26 of the brief ("do not make AI the foundation").

---

## SECTION 9 — Sales funnel detection feasibility

**Precise definition for this product** (the brief demands precision, not marketing language):

> A **funnel signal** is a single, individually-observed structural step in a possible path from an advertisement or promotion toward a purchase — e.g., "this ad's destination URL is a page distinct from any known product/collection URL" or "this landing page contains an email-capture form." A **funnel** is never asserted as existing; only its individual, evidenced steps are reported, each independently labeled with its own epistemic status. The product must never render a sentence like "Store X is running an advanced sales funnel" — only "the following structural signals were observed: [list]."

| Signal | Observable without purchasing? | Classification |
|---|---|---|
| Ad → landing page URL differs from any known product/collection page | Yes (from ad source's destination field) | **OBSERVED** |
| Landing page contains an email-capture form (static HTML) | Yes | **OBSERVED** |
| Landing page is a Shopify "page" template vs. product template (URL/structure heuristic) | Yes | **OBSERVED** |
| Landing page contains quiz/interactive-funnel markup (recognizable third-party app scripts, e.g., existing app-fingerprinting patterns) | Yes, reusing the existing tech-fingerprint crawler | **OBSERVED** |
| Post-add-to-cart upsell exists | **No**, without simulating an actual add-to-cart interaction (requires either browser automation or an authenticated-like session flow) | **UNAVAILABLE** in MVP |
| Checkout-step behavior (e.g., one-click upsell at checkout) | **No**, same reason — and additionally many Shopify stores gate checkout behind Shopify's own hosted checkout domain, outside our crawl surface entirely | **UNAVAILABLE**, likely permanently, not just for MVP |
| "This constitutes a sales funnel" | **Never directly observable** — always a human/product judgment applied on top of the observed signals | Not a field we should ever emit; UI should show the observed signals themselves (Section 28) |

**A plain `Product → Cart → Checkout` path must never be labeled a "funnel"** — the brief is explicit about this, and the signal list above only lights up for genuinely distinguishing structure (dedicated landing pages, capture forms, quiz apps), not Shopify's default purchase flow.

---

## SECTION 10 — Promotion detection feasibility

| Signal | Already observable from existing static Shopify JSON crawl? | Needs HTML rendering? | Needs browser automation/JS execution? |
|---|---|---|---|
| Sale price (current price < some baseline) | **Yes, already computed** — `Product.priceMinCents` vs. history via `ProductStateSnapshot`, and the existing diff engine already emits `PRICE_DROP`/`SALE_STARTED`/`SALE_ENDED` events | No | No |
| Compare-at price | **Yes, already crawled** — `variant.compare_at_price` is already part of the Shopify JSON payload this crawler parses | No | No |
| Sitewide vs. product-specific promotion | Partially — inferable from *how many* products show a compare-at price simultaneously (a derived signal over existing data, not a new collector) | No | No |
| Discount codes | No — codes aren't exposed in public product JSON | Sometimes (banner text in HTML) | Often yes (many discount banners are JS-rendered or app-injected) |
| Bundle / BOGO / quantity-break offers | No, not from `/products.json` | Partially (static HTML app-widget markup is sometimes detectable, reusing existing app-fingerprint patterns) | Often yes — most bundle apps render client-side |
| Free shipping threshold banners | Rarely in static HTML | Usually | Usually |
| Countdown timers | No | Rarely (mostly JS-rendered) | Yes |
| Popup/exit-intent offers | No | No | Yes, and interaction-dependent (exit-intent specifically requires simulating mouse behavior) |

**Conclusion**: sale/compare-at pricing is **already fully covered by the existing crawler and diff engine** — this is not new work, just better-labeled reporting on data already collected. Everything past that (codes, bundles, timers, popups) genuinely requires either HTML rendering or full browser automation, which is a **new infrastructure category** for this codebase (Section 1) and should **not** be pulled into the marketing-intelligence MVP — it's a separate, larger investment decision.

---

## SECTION 11 — Observed / Inferred / Estimated classification table

| Planned field | Classification | Why |
|---|---|---|
| "Ad found in Meta's official Ad Library API" | **OBSERVED** | Retrieved directly from an official transparency source |
| "Ad found via Google Ads Transparency Center" | **OBSERVED** | Same — direct retrieval, not modeled |
| Ad → exact product URL match | **OBSERVED**, high confidence | Deterministic string match against our own crawled data |
| Ad → title/image similarity match | **INFERRED** | Heuristic, not exact; always carries a confidence value, never presented as fact |
| "No ads found on Platform X" | **OBSERVED** (explicitly: "no evidence found in the sources we checked") | A real, positive result from a real query — see Section 19's OBSERVED-vs-UNAVAILABLE distinction |
| "Could not check Platform X" (rate-limited, source down, no EU coverage available for a non-EU advertiser) | **UNAVAILABLE** | The check itself did not complete or does not apply — must never be conflated with "no ads found" |
| Funnel structural signal (landing page ≠ product page) | **OBSERVED** | Directly derived from a retrieved destination URL |
| "This is a sales funnel" | **Not implemented as a field** | Would require judgment past what's directly evidenced — out of scope entirely, not just downgraded to INFERRED |
| Estimated ad spend / campaign reach | **ESTIMATED**, and **not built in this milestone** | No validated model exists (matches the brief's Section 27 instruction) |
| "Advertising began on [date]" | **OBSERVED, but scoped to firstSeenAt = when we first observed it**, not true campaign start unless the source explicitly discloses a start date | Must be labeled precisely — "first observed" not "campaign started" |

---

## SECTION 12 — Confidence model

Proposed levels: **HIGH / MEDIUM / LOW**, matching the brief's own suggested vocabulary and this project's existing `Confidence` type already defined in `src/lib/analysis/report-contract.ts` for the Milestone 3 epistemic model — **reused, not reinvented**.

Proposed deterministic formula (no ML scoring in MVP — a lookup table, not a model):

```
MATCH TYPE                                    → CONFIDENCE
exact product URL (path match)                → HIGH
exact collection URL                          → MEDIUM-HIGH (ambiguous target)
exact domain root / unrecognized landing page  → N/A for product match (still HIGH for
                                                  "this store is advertising")
title string exact/near-exact match            → MEDIUM
title fuzzy match only                         → LOW
image similarity only                          → LOW
AI/semantic inference only                     → LOW (never higher, regardless of the
                                                  model's own stated confidence — the
                                                  brief requires AI output to remain
                                                  INFERRED, and inflating LOW to MEDIUM
                                                  based on a model's self-reported score
                                                  would violate that)
```

Multiple independent signals agreeing (e.g., exact URL match *and* title match) may justify a documented upgrade rule later, but the MVP should ship the simple table above — it is fully explainable to a user in the "why this confidence?" methodology text the existing product already uses elsewhere (Milestone 3's `IntelligenceCard` component pattern).

---

## SECTION 13 — Proposed data model (conceptual — no schema changes made)

Evaluating the brief's own suggested entity list against "does this need to be its own table, or can it be derived":

| Entity | Persistent table? | Reasoning |
|---|---|---|
| `Store` | Already exists | No change |
| `Product` | Already exists | No change |
| `AdPlatform` | **Small static enum**, not a table | Fixed, small set (META, GOOGLE, TIKTOK...) — a Postgres enum, matching the existing `Platform`/`EventType` convention, not a lookup table |
| `Advertiser` | **Not needed as a separate entity for MVP** | For MVP, "advertiser" is just "this Store" — we're not tracking third-party advertisers unrelated to a Shopify store we already know. Revisit only if multi-advertiser-per-store (agency accounts) becomes relevant |
| `Advertisement` / `AdObservation` | **One table, event-shaped**: `AdObservation` | This is the core entity — one row per (store, platform, source-ad-identifier, observation). See below |
| `AdCreative` | **Not persisted in MVP** | Storing/hosting actual ad creative (images/video) raises copyright and storage-cost questions (Section 17) the brief explicitly flags — MVP stores the *destination URL* and *observed metadata*, not the creative asset itself |
| `LandingPage` | **Derived field on `AdObservation`**, not its own table | A URL string is enough for MVP; promote to its own entity only if we start tracking landing-page-level history independent of any single ad |
| `Promotion` | **Out of scope this sub-phase** (Section 10) — belongs to a future Shopify-crawler extension, not the marketing-intelligence pipeline | — |
| `MarketingEvent` | **Reuse the existing `Event` table** with new `EventType` values, not a parallel table | Matches the brief's own instruction (Section 12) and the existing architecture's stated design rule ("Event is append-only... never derived at read time") |
| `ProductAdRelationship` | **Fields on `AdObservation`** (`matchedProductId`, `matchConfidence`, `matchMethod`), not a separate join table | One ad observation matches to at most one product in the deterministic-MVP model; a join table is premature normalization for a 1:1 (or 1:0) relationship |

**Minimum viable model: one new table.**

```
AdObservation
  id
  storeId          -> Store (global corpus, never userId-scoped)
  platform          AdPlatform enum
  sourceRef         string   (the source's own ad/advertiser identifier, for dedup)
  destinationUrl     string?
  matchedProductId  -> Product?  (nullable)
  matchConfidence    Confidence enum?  (HIGH/MEDIUM/LOW, null if unmatched)
  matchMethod        string?  ("exact_product_url", "exact_collection_url", ...)
  status             AdObservationStatus enum (ACTIVE_EVIDENCE / HISTORICAL / NOT_FOUND / UNAVAILABLE)
  firstSeenAt        timestamp(3)   (Section 21, UTC-rule-compliant)
  lastSeenAt         timestamp(3)
  source             string  ("META_AD_LIBRARY_API", "GOOGLE_ADS_TRANSPARENCY_CENTER", ...)
  sourceMetadata      jsonb  (raw disclosed fields we don't want to lose but don't need indexed columns for)
  createdAt / updatedAt
```

This directly mirrors the existing `StoreEntity` model's own shape and lifecycle (`ACTIVE`/`MISSING`/`REMOVED`-equivalent status machine, `firstSeenAt`/`lastSeenAt`) — reused, not reinvented, per the brief's own repeated instruction to prefer extending existing patterns.

---

## SECTION 14 — Proposed event model

Smallest useful vocabulary, evaluated item-by-item against the brief's suggested list:

| Proposed event | Keep? | Trigger | Confidence carried? |
|---|---|---|---|
| `AD_EVIDENCE_FOUND` | Yes (replaces the brief's `AD_DETECTED` — "evidence found," not "ad exists," matching Section 19's absence-vs-evidence rule) | First successful observation of an ad for a store on a platform | No (presence itself isn't a confidence question) |
| `AD_EVIDENCE_NO_LONGER_OBSERVED` | Yes (replaces `AD_REMOVED` for the same reason — we never confirm an ad was *removed*, only that we stopped observing it) | A previously-`ACTIVE_EVIDENCE` observation transitions to `HISTORICAL` | No |
| `PRODUCT_AD_MATCH_FOUND` | Yes | Deterministic URL match succeeds on an existing `AdObservation` | Yes — carries the `Confidence` |
| `AD_LANDING_PAGE_CHANGED` | Yes | Same `sourceRef`, `destinationUrl` differs from the prior observation | No |
| `AD_CREATIVE_CHANGED` | **Deferred** — MVP doesn't persist creative, so there's nothing to diff | — | — |
| `PROMOTION_DETECTED` / `PROMOTION_REMOVED` | **Deferred to Section 10's future Shopify-crawler-extension work**, not this pipeline | — | — |
| `FUNNEL_SIGNAL_DETECTED` / `FUNNEL_SIGNAL_REMOVED` | **Deferred past MVP** (Section 9) | — | — |

Each event: `dedupeKey` on `(storeId, platform, sourceRef, eventType, discriminator)` (same idempotency pattern as every existing event type), `backfilled: false` always (there is no historical backfill possible for a source we're observing for the first time — unlike Shopify's `sourceCreatedAt`, ad platforms don't expose a reliable "this ad started N months ago" field in most cases), append-only, never mutates entity state directly (the `AdObservation` row's `status`/`lastSeenAt` is the queryable current-state table, exactly mirroring `Product`/`StoreEntity` vs. `Event`).

---

## SECTION 15 — Collection/scheduling architecture

**Comparison:**

| Cadence | Fit |
|---|---|
| Every Shopify crawl | **Rejected** — different rate limits/failure modes per Section 1(C); would make a slow/failing ad source block the (already-working, revenue-adjacent) Shopify crawl path |
| Separate scheduled job, independent cadence | **Recommended** |
| Hourly | Too aggressive for MVP-scale API quotas (Meta's ~200/hr/app is shared across *every* store we'd ever check) |
| Daily | Reasonable default |
| 6-hourly | Reasonable for HOT-tier (actively watched) stores only |
| Only for HOT stores | **Recommended as the primary prioritization signal** (Section 16) |
| Only for monitored (watched) stores | Too narrow — anonymous/free-tier analyzed stores still benefit the shared corpus (same principle as Shopify crawling itself) |
| Global corpus collection | Yes, but rate-bounded and tier-prioritized, not "collect for everything at once" |

**Recommendation**: daily collection for HOT-tier stores, weekly (or on-demand at first analysis) for everything else, mirroring the existing `CrawlTier` cadence philosophy exactly (`policy.ts`'s own doc comment: "cadence and backoff as pure functions of tier"). No new cadence concept needed — reuse `Store.tier`.

---

## SECTION 16 — Global corpus vs. user-specific collection

**Principle, stated explicitly per the brief's request:** marketing intelligence is collected **once per store**, globally, regardless of how many users are watching it — never once per user. This is a direct extension of the same principle already implemented for Shopify crawling (`Store` is the shared entity; `Watchlist` is the per-user relationship that influences *priority*, never triggers a *duplicate* collection).

`Store.tier` (already promoted to HOT by `recomputeStoreTier()` when ≥1 user actively watches it) becomes the **same** priority signal for marketing-intelligence collection: a marketing-intelligence scheduler tick claims HOT-tier stores first, using the identical `FOR UPDATE SKIP LOCKED` claim pattern already proven correct in `scheduler.ts` — but against a **new, separate "due for marketing collection" timestamp**, not `Store.nextCrawlAt` itself (that field belongs to the Shopify crawl cadence and must not be repurposed or coupled to a completely different rate-limit regime).

---

## SECTION 17 — Cost/unit economics considerations

Ranges, explicitly labeled as assumptions where not independently verified:

| Cost category | MVP scope needs it? | Rough shape |
|---|---|---|
| HTTP requests (Meta API, Google ATC) | Yes | Free (Meta official API) to low-cost-per-request (a licensed Google ATC data vendor — **exact pricing not verified**, assumption: comparable to other SERP/data-API vendors' published tiers, typically cents-to-low-dollars per 1,000 requests) |
| Proxies | **Not needed if using official APIs / licensed vendors** — proxies are only needed for direct scraping, which this report recommends against (Section 18, 22) | — |
| Browser automation | **Not needed for MVP** (Sections 9, 10) | Deferred entirely |
| Third-party API subscription (Google ATC vendor) | Likely, if Google is included in MVP | **Unverified — must be priced during Sub-phase B before committing**, not assumed here |
| Storage | Minimal — one new table, no creative assets stored | Negligible |
| Image/video storage | **Not needed** — MVP doesn't persist creative | Zero |
| OCR | Not needed | Zero |
| AI inference/embeddings | Not needed (Section 26) | Zero |
| Queues/workers | **Possibly a new cost/complexity category** if Option B/C (Section 22) is chosen — no queue infrastructure exists in this codebase today | Needs real evaluation in Sub-phase B, not assumed |

**Unit-economics risk flag**: any source requiring a **paid per-request cost** (a licensed Google ATC vendor) must be weighed against FREE-tier users, who generate zero revenue. The natural mitigation is exactly the global-corpus principle in Section 16 — one collection serves every user watching that store, so cost scales with **unique stores actively monitored**, not with user count, which is the same economic shape the Shopify crawler itself already has.

---

## SECTION 18 — Legal / terms / compliance risk

| Source | Risk | Why |
|---|---|---|
| Meta official `ads_archive` API | **LOW** | Official, documented, free, ToS-compliant by construction as long as we stay within documented scope (no resale/bulk redistribution) |
| Meta Ad Library **website** scraping | **HIGH — explicitly excluded from any recommendation in this report** | Meta's own Terms directly and explicitly prohibit it, regardless of the separate CFAA-adjacent court ruling about logged-out public scraping — a contract-terms violation is not cured by a criminal-statute ruling on a different question |
| TikTok Commercial Content API | **LOW risk to use, MEDIUM risk to *obtain*** | The API itself is official and governed by clear terms once granted; the *approval* step (Section 5) has an unclear commercial-eligibility bar |
| TikTok Creative Center | **LOW** | Fully public, intended for exactly this kind of browsing use — but not useful for MVP regardless (Section 5) |
| Google Ads Transparency Center — direct automated access | **MEDIUM / UNKNOWN** | No explicit ToS statement found either permitting or forbidding automated querying of this specific tool; treated as unresolved, not assumed safe |
| Google Ads Transparency Center — via a licensed third-party vendor | **LOW-MEDIUM** | Shifts first-order ToS exposure to a vendor whose business is built on having resolved this; still carries residual "vendor's own risk becomes our risk if they're ever shut down" exposure |
| Pinterest Ads Repository | **LOW** (EU-only, public, no automated-access statement found either way, but low priority regardless per Section 7) | — |
| Storing ad creative (images/video) | **N/A — not done in MVP** | Copyright-around-storing-creative concern the brief flags is sidestepped entirely by not persisting creative assets, only metadata/URLs |
| Following an ad's destination URL to crawl the landing page | **LOW, conditional on reusing the existing SSRF guard unmodified** | An ad can point anywhere, including attacker-controlled or internal-network-adjacent URLs in theory — the existing `checkUrlIsSafeToFetch()` + manual-redirect-recheck pattern is exactly the control needed here and must not be bypassed "just this once" for marketing URLs |

**Explicitly not proposed, per the brief's Section 18 instruction**: any CAPTCHA-solving, authentication-bypass, paywall-circumvention, or anti-bot-evasion technique, for any source.

---

## SECTION 19 — Failure handling

The brief's own example is adopted verbatim as the product's contract:

> **OBSERVED**: "No active ads found." — a completed query against a real source that returned zero results.
> **UNAVAILABLE**: "Advertising data could not be retrieved." — the query itself did not complete (source down, rate-limited, region not covered for this advertiser type, could not resolve an advertiser identity for this store).

Failure modes to distinguish explicitly, each mapped to `AdObservationStatus`:

| Situation | Status |
|---|---|
| Source queried successfully, zero ads returned | `NOT_FOUND` (rendered to the user as OBSERVED "no evidence found") |
| Source rate-limited us | `UNAVAILABLE` (reason: "rate limited, will retry") |
| Source structure changed / parse failure | `UNAVAILABLE` (reason: "source format changed, collection paused") — **must alert engineering**, not silently produce empty results that look identical to a genuine "no ads" observation |
| Could not resolve this store to an advertiser identity on this platform at all | `UNAVAILABLE` (reason: "advertiser identity not resolved") — this is a distinct, common failure mode not to conflate with "no ads" |
| Source temporarily blocked us | `UNAVAILABLE` (reason: "temporarily blocked") |
| Source returned stale/cached-looking data | `UNAVAILABLE` if detectable, otherwise accepted with `lastSeenAt` reflecting the true retrieval time, never the source's own claimed freshness uncritically |

**A parse-failure silently returning "zero ads" is the single most dangerous failure mode for this feature's credibility** — it would misclassify "our collector broke" as "this store stopped advertising," which is exactly the fabrication the entire epistemic model exists to prevent. Sub-phase B must treat a parse/shape failure as a hard error surfaced to `UNAVAILABLE`, never silently coerced to an empty success.

---

## SECTION 20 — Historical intelligence strategy

Minimum fields required, all UTC-rule-compliant per `AGENTS.md`:

- `firstSeenAt` — when **we** first observed this ad evidence (not campaign start, unless a source explicitly discloses one — most don't, reliably, outside the EU/political categories)
- `lastSeenAt` — most recent successful observation confirming it's still there
- Transition to `HISTORICAL` (not deletion) the moment an observation is no longer confirmed — mirroring the existing `StoreEntity` MISSING-streak-before-REMOVED state machine, likely reusing the **same flap-suppression pattern** (a single missed check shouldn't immediately flip `ACTIVE_EVIDENCE` → `HISTORICAL`, exactly as a single missed crawl doesn't immediately mark a product REMOVED today)

This directly enables (later, not in Sub-phase B) the exact questions the brief lists in its own Section 22 ("when did they start/stop advertising this product," "how many creatives did we observe," "did price change while advertising") — **all of which are queries over accumulated `AdObservation` + existing `Event`/`ProductStateSnapshot` history**, not new collection capability. The data foundation is what Sub-phase B must build; the analytical questions themselves are correctly deferred.

---

## SECTION 21 — Recommended MVP

**ONE primary source + ONE secondary source, not a multi-platform launch:**

1. **Google Ads Transparency Center**, accessed via a **licensed third-party data vendor** (not a self-built scraper) — broadest coverage, includes Shopping ads, no approval process, global. Vendor selection and real pricing confirmation is a Sub-phase B task, not resolved here.
2. **Meta's official `ads_archive` API** as a free, low-effort secondary source — honestly scoped to "EU/UK-delivered or political/social-issue ads only," clearly labeled as such in the product, never implying broader coverage than it has.

**Intelligence scope**: advertising-presence evidence, exact-URL product matching only (Section 8, strategy #1-2), first/last-seen, and the small event vocabulary in Section 14. **Explicitly not in MVP**: TikTok (weak fit today, Section 5), Pinterest (EU-only, low relevance, Section 7), funnel detection beyond structural signal logging (Section 9), promotion detection beyond what the existing crawler already computes (Section 10), any AI-assisted matching (Section 26), creative storage, revenue/spend estimation (Section 27).

**Why this MVP, why not everything**: the research consistently found that *comprehensive, reliable, per-advertiser* coverage exists for exactly one platform (Google) and exists in a *narrow, honestly-labelable* form for a second (Meta, EU/political-scoped). Every other researched source is either curated-not-comprehensive (TikTok Creative Center), access-uncertain (TikTok Commercial Content API), or low-relevance-and-EU-only (Pinterest and peers). Shipping all of them at MVP would mean shipping several sources whose honest output is "usually UNAVAILABLE" — which fails the brief's own bar ("can this become a reliable, differentiated, commercially useful feature") for those specific sources, even though the *category* as a whole clears that bar via Google.

---

## SECTION 22 — Recommended technical architecture

**Option A — Extend existing crawler workers.**
Add marketing collection as another step inside the existing Shopify-crawl-triggered flow (`run-analysis.ts` / `run-scheduled-crawl.ts`).
*Advantages*: no new scheduling infrastructure, reuses the existing SSRF-guarded fetch layer directly.
*Disadvantages*: couples two collectors with entirely different rate limits and failure modes (Section 1C); a slow/rate-limited ad source would directly slow down or destabilize the Shopify crawl path that the whole product's core value depends on; violates the existing architecture's own stated principle of clean IO-boundary separation (`crawl/` is Shopify-only by design).
*Verdict*: **rejected**, confirmed by direct repo inspection, not assumed.

**Option B — Separate Marketing Intelligence workers (new queue-based infrastructure).**
*Advantages*: full failure isolation, independently scalable, matches how a mature system would eventually look.
*Disadvantages*: **introduces a genuinely new infrastructure category** — no queue library exists in this codebase today (Section 1). This is real, non-trivial new operational surface (deployment, monitoring, a second failure domain) for a sub-phase whose own MVP (Section 21) is deliberately narrow (two sources, no browser automation, no AI).
*Verdict*: **premature for the MVP defined in Section 21** — right shape for a later scale-up, wrong shape to start.

**Option C — Hybrid: a separate scheduled *pipeline* (own cadence, own claim/tier logic, own failure handling), reusing the existing in-process scheduler-tick model rather than a distributed queue.**
Concretely: a new `src/lib/marketing/scheduler.ts`, structurally parallel to (not merged into) `src/lib/monitoring/scheduler.ts` — same `FOR UPDATE SKIP LOCKED` claim pattern, same tier-prioritization principle (Section 16), triggered by its own internal API route + CLI script (mirroring `scripts/scheduler-tick.ts` exactly), but with **its own claim timestamp field, its own rate-limit budget, and its own failure/backoff policy**, completely decoupled from the Shopify-crawl scheduler.
*Advantages*: real failure isolation (Option B's core benefit) without a new infrastructure category (avoids Option B's cost); consistent with every existing architectural pattern in this codebase; can evolve into Option B later (extracting the pipeline into a real queue/worker) without a rewrite, if/when the source count or volume genuinely requires it.
*Disadvantages*: still runs in the same Node process as the rest of the app for now — a genuinely large volume of marketing-collection work could contend with request-serving capacity, same limitation the existing Shopify scheduler already has and has apparently operated fine within to date.

**Recommendation: Option C.** This matches the brief's own hedge ("marketing intelligence may eventually deserve separate workers... but do not assume this is correct — verify") — the verification concluded that the *isolation* benefit is real and worth having now, but the *infrastructure cost* of true separate workers is not justified by an MVP scoped to two low-volume, non-browser-automation sources.

---

## SECTION 23 — Sub-phase B implementation plan

| # | Task | Complexity | Depends on |
|---|---|---|---|
| 1 | Confirm Google ATC vendor pricing/ToS in writing; formally decide vendor vs. direct access | LOW (research), but **blocking** | — |
| 2 | Data model: `AdObservation` table + `AdPlatform`/`AdObservationStatus` enums, one migration | LOW | Task 1's source decision (affects `source` field's real values) |
| 3 | Collector abstraction (`AdvertisingSourceAdapter` interface, per-source implementations) | MEDIUM | Task 2 |
| 4 | Meta `ads_archive` adapter | LOW-MEDIUM (official, documented API) | Task 3 |
| 5 | Google ATC adapter (via chosen vendor) | MEDIUM (unofficial-vendor integration risk) | Tasks 1, 3 |
| 6 | Rate limiting for external sources (respecting Meta's real quota; vendor's contracted quota) | MEDIUM (existing in-memory limiter may not directly reuse — needs per-source budget, not per-client-IP) | Tasks 4, 5 |
| 7 | Product matching (exact URL/collection match only) | LOW | Task 2, existing `Product` data |
| 8 | Event generation (small vocabulary, Section 14) | LOW | Existing `Event` model, Task 7 |
| 9 | Scheduler integration (Option C pipeline, Section 22) | MEDIUM | Tasks 2-8 |
| 10 | Failure-handling correctness (OBSERVED-vs-UNAVAILABLE, Section 19) | MEDIUM — this is where bugs would be most damaging to product credibility, deserves real test-writing effort | Task 9 |
| 11 | Tests (unit for matching/confidence logic, integration against real embedded Postgres for persistence + scheduler claim logic, live smoke test against at least one real store with genuine public ad evidence) | MEDIUM-HIGH | All above |
| 12 | API (read-only endpoint(s) surfacing `AdObservation` data, mirroring the existing `/api/store/[domain]/{activity,events}` pattern) | LOW | Task 2 |
| 13 | Report contract extension (`FullStoreReport` gains an honestly-`UNAVAILABLE`-by-default marketing section, matching the existing epistemic-field pattern exactly) | LOW | Task 12 |
| 14 | UI (conceptual only per Section 28 — do not build yet even in Sub-phase B without a fresh go-ahead, since the brief's Section 28 restriction is about *this* sub-phase specifically, but the same "don't redesign Fable" discipline should carry forward) | — | — |

Nothing here requires AI, browser automation, or new queue infrastructure — consistent with the MVP scope in Section 21.

---

## SECTION 24 — Risks and unknowns

Explicitly marked **UNKNOWN**, not assumed, per the brief's Section 4/30 instruction:

- Google Ads Transparency Center's own stance on automated/vendor-mediated access — no official ToS statement found either way.
- TikTok Commercial Content API's actual commercial-SaaS eligibility — would require a real application to resolve.
- The Meta Ad Library website's "All ads" feature vs. what the documented API actually exposes for non-EU commercial ads — a genuine, unresolved discrepancy between sources (Section 4).
- Real per-request pricing for any Google ATC data vendor — not verified, must be priced before committing.
- Meta's actual numeric rate limit (the ~200/hr figure is secondary-sourced, not confirmed against Meta's own primary documentation, which only confirms the *existence* of a limit).
- Whether Google Shopping ads specifically (vs. Search/Display/YouTube) expose a reliable product-identifier field through the Ads Transparency Center — plausible given Shopping ads are catalog-fed, but not directly confirmed in this research pass.
- Long-term source stability — every platform's transparency tooling here is materially shaped by an evolving regulatory environment (EU DSA); a policy change could expand *or* contract what's available with little notice, which is itself the single largest structural risk to this feature's durability, independent of any implementation choice.

---

## SECTION 25 — Definition of Done for Sub-phase B

1. `AdObservation` model + enums exist via a reviewed migration; zero changes to any other existing table.
2. Meta `ads_archive` adapter live-tested against at least one real store with confirmed EU-delivered or political/social-issue ad history (or, failing to find one, an honest report that no such test case was found and why).
3. Google ATC adapter (via the vendor decided in Task 1) live-tested against at least one real Shopify store with confirmed active Shopping/Search ads.
4. A deliberately-unmatched or genuinely-quiet store produces `NOT_FOUND` (OBSERVED "no evidence"), and a deliberately-broken/rate-limited request produces `UNAVAILABLE` — both proven live, not just unit-tested, since this exact distinction is the feature's core credibility claim.
5. Exact-URL product matching produces `HIGH` confidence on a real matched case, live-verified against real crawled `Product` data for a real store.
6. All existing tests remain green; new tests cover the matching logic, the event vocabulary, the scheduler's own claim/tier-priority behavior (reusing the `FOR UPDATE SKIP LOCKED` pattern's existing test style), and the OBSERVED/UNAVAILABLE distinction specifically.
7. Typecheck, lint, and `next build` all pass.
8. No SSRF-guard bypass anywhere a destination URL is followed.
9. No AI, no browser automation, no creative storage — confirming Sub-phase B stayed within this report's recommended MVP scope, or an explicit, justified deviation is documented if it didn't.

---

# FINAL DECISION GATE

## GO — for a narrowly-scoped Marketing Intelligence MVP.

**Exactly what "GO" means here:**

- **Sources**: Google Ads Transparency Center (via a licensed vendor, pending Task 1's pricing/ToS confirmation) as primary; Meta's official `ads_archive` API as a free, honestly-EU/political-scoped secondary source. Not TikTok, not Pinterest, not any other platform, in this MVP.
- **Data**: advertising-presence evidence, destination URL, first/last observed, exact-URL product match with a deterministic confidence table — nothing estimated, nothing AI-inferred, no creative storage.
- **Collection method**: scheduled pipeline (Section 22, Option C), reusing the existing SSRF guard for any destination-URL following, reusing the existing append-only Event model and `FOR UPDATE SKIP LOCKED` claim pattern, prioritized by the existing `Store.tier` signal — no new infrastructure category (no queue, no browser automation).
- **Matching method**: deterministic exact-URL/collection-handle matching only. No image similarity, no AI, no title-fuzzy-matching in MVP.
- **Events**: the four-item vocabulary in Section 14, not the brief's full ten-item suggested list.
- **Data model**: one new table (`AdObservation`) plus two small enums — not the brief's full nine-entity suggested list.
- **Known limitations to carry forward honestly into the product**: coverage is real but partial (most non-EU commercial advertisers will legitimately show `UNAVAILABLE` or thin data on Meta; Google's breadth is the load-bearing source); TikTok/Pinterest are absent entirely; funnel and promotion detection remain structural-signal-only, never a certified "funnel exists" claim; no creative, no spend/revenue estimation.
- **Primary residual risk**: the UNKNOWNs in Section 24, especially Google ATC's own automated-access stance and real vendor pricing — both must be resolved as literally the first task of Sub-phase B, before any collector code is written, since they could change the recommended architecture (e.g., if no acceptable vendor exists at a sane price, the MVP shrinks to Meta-only, which is a materially weaker but still shippable and still-honest product).

**Why GO and not DO NOT GO**: unlike a hypothetical world where *every* platform researched turned out EU-only/curated/access-gated, this research found one source (Google) that is genuinely global, no-login, directly relevant to e-commerce (Shopping ads), and technically straightforward to integrate via an established vendor market — clearing the brief's own bar of "reliable, differentiated, commercially useful," provided the product is honest about being Google-led with Meta as a bounded supplement, rather than overselling multi-platform coverage it cannot actually deliver.
