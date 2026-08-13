# Milestone 10 Sub-phase B — Billing & Freemium Decision Report

**Phase type:** Research + product decision only. No code, schema, dependency, or UI changes.
**Status legend used throughout:** `VERIFIED` `OBSERVED` `ESTIMATED` `RESEARCH REQUIRED` `HUMAN DECISION REQUIRED` `BLOCKED` `GO` `CONDITIONAL GO` `DO NOT BUILD`

---

## 1. Executive Summary

Bellwether's intelligence layer works and is already, structurally, closer to the requested "analyze free, monitor at scale" model than the public pricing page suggests — the backend today gives every signed-in FREE user full-intelligence reports (capped at 3 lifetime stores) and one free 30-day monitored store, while anonymous visitors already get a real, free, no-signup preview. The gap is not the product; it's that **no billing exists at all** (`GO`/`DO NOT BUILD` findings below are about what to build next, not what's broken today), the public pricing page advertises two tiers (Pro, Agency) and several features (faster crawl cadence, CSV/API export, team seats) that have zero backend implementation, and the free tier's "3 unique stores" lifetime cap actively contradicts the new "analyze competitors for free" positioning the user wants to lead with.

On billing providers: **Stripe is confirmed `NOT SUPPORTED`** as a direct-merchant option for a Bangladesh-based operator (Bangladesh is absent from Stripe's own primary global-availability page). **Polar.sh is the strongest lead** — its own primary docs explicitly separate buyer eligibility (global) from seller/payout eligibility (a restricted list), and Bangladesh is on that seller list via Stripe Connect Express. **Paddle is `LIKELY`** — its own Help Center article frames seller support as "everywhere except an explicit 28-country exclusion list," and Bangladesh is not on that list — but Paddle never makes an affirmative "yes" statement, so this stops short of `VERIFIED`. **Lemon Squeezy is `RESEARCH REQUIRED`** — its docs domain returned HTTP 403 to every direct-fetch attempt in this research pass (a genuine access block, not a skipped step); only secondary-source claims exist, which the brief's rules explicitly forbid treating as confirmation.

This report's final recommendation: **CONDITIONAL GO** on the freemium redesign and a FREE + ONE PAID PLAN structure built around "monitor more than one competitor," gated on two unresolved items — direct outreach to confirm Polar/Paddle individual-seller eligibility from Bangladesh, and a human decision on the pricing-mismatch resolution path (Section 8). **Sub-phase C is NOT authorized to begin.**

---

## 2. Phase Status

`RESEARCH REQUIRED` items remain (provider seller-eligibility confirmation via direct outreach). No code was written. This document is the sole deliverable.

---

## 3. Scope

In scope: repo architecture tracing (read-only), billing-provider research, pricing-mismatch reconstruction, freemium/entitlement design, subscription lifecycle and security design (conceptual only), legal-surface identification, acquisition-funnel design, pricing recommendation, Sub-phase C sequencing, STOP-condition evaluation.

Out of scope (explicitly, per the governing brief): implementing billing, adding Stripe/Paddle/any SDK, modifying `prisma/schema.prisma`, modifying entitlement logic, modifying pricing UI, adding webhooks, adding dependencies, redesigning the Fable UI, deploying anything, starting Sub-phase C.

---

## 4. Files Inspected

This sub-phase re-used Milestone 10 Sub-phase A's same-session, direct inspection of the billing/entitlement/auth/scheduler stack (`docs/milestone-10-subphase-a-production-saas-readiness-audit.md`) rather than re-reading unchanged files from scratch, and supplemented it with targeted fresh inspection of exactly the things Sub-phase A didn't answer:

- `src/lib/entitlements/plan-limits.ts` (re-read in full this sub-phase — current `PlanTier`/`PlanLimits`/`PLAN_LIMITS` source of truth)
- `src/components/marketing/PricingSection.tsx` (re-read in full this sub-phase — current public pricing copy, verbatim)
- `src/components/dashboard/SubscriptionCTA.tsx`, `src/components/analysis/FreeReportStrip.tsx` (read this sub-phase)
- `src/lib/analysis/run-analysis.ts` (re-read relevant sections this sub-phase — anonymous vs. signed-in report branching, entitlement gate ordering, marketing-collection decoupling)
- `src/lib/monitoring/policy.ts` (grepped this sub-phase — `CrawlTier` cadence constants)
- `src/lib/marketing/*` (grepped this sub-phase — plan-gating search)
- `prisma/schema.prisma` — `User`, `Watchlist`, `AnalysisUsage` models (re-read this sub-phase)
- `src/app/api/auth/` directory listing (confirmed no password-reset route)
- Repo-wide search for CSV/export functionality (corrected this sub-phase after an initial overbroad grep matched the JS `export` keyword itself; the precise re-run — `"text/csv"`, `Content-Disposition`, `.csv` literals — returned zero matches)
- External: Stripe (`stripe.com/global`), Paddle (`developer.paddle.com`, `paddle.com/help/...`), Polar.sh (`polar.sh/docs/merchant-of-record/supported-countries`), Lemon Squeezy (`docs.lemonsqueezy.com` — blocked)

No production file was modified, added, or deleted (confirmed in Section 21 with a final `git status`).

---

## 5. Current Billing State

`VERIFIED` (re-affirmed from Sub-phase A, unchanged):

- No `Subscription`, `Payment`, `Invoice`, `PaymentEvent`, `Organization`, or `Team` model exists in `prisma/schema.prisma`.
- `User.plan` is a bare `PlanTier` enum (`FREE | BASIC | BUSINESS`) with `@default(FREE)` and no history, no provider linkage, no status field.
- No checkout, no webhook endpoint, no payment provider SDK, no `package.json` dependency related to billing.
- Clicking any paid tier on the public pricing page only invokes a client-side callback that shows a toast ("connects to billing in the production app") — `onPlanSelected` in `PricingSection.tsx` never navigates anywhere or calls an API.

---

## 6. Current Entitlement State

`VERIFIED` — traced this sub-phase directly from `plan-limits.ts`, `analysis-usage.ts`, `watch.ts` (Sub-phase A), `run-analysis.ts`, `policy.ts`, and `src/lib/marketing/`.

**The actual current entitlement surface (three enforced dimensions, everything else is unenforced):**

| Dimension | FREE | BASIC | BUSINESS |
|---|---|---|---|
| `maxUniqueAnalyses` | 3 (lifetime) | unlimited | unlimited |
| `maxActiveMonitoredStores` | 1 | 20 | 50 |
| `monitoringDurationDays` | 30 | unlimited (continuous) | unlimited |
| `historicalAccess` | true | true | true |
| `advancedIntelligence` | false | true | true |

`historicalAccess` and `advancedIntelligence` are defined and plumbed onto every plan but have **zero enforcement call-sites anywhere in the codebase** — re-confirmed this sub-phase, not just carried over from Sub-phase A. They are dead flags today.

**Where plan decisions are actually made** (the complete list — nowhere else checks `plan`):
1. `recordAnalysisUsage()` — the only place `maxUniqueAnalyses` is enforced, inside a `pg_advisory_xact_lock` for race safety.
2. `startMonitoring()` (`watch.ts`) — the only place `maxActiveMonitoredStores` is enforced, same locking pattern.
3. `expireDueWatches()` — applies `monitoringDurationDays` by flipping `Watchlist.monitoringStatus` to `EXPIRED` once `monitoringExpiresAt` passes; runs every scheduler tick.

**Confirmed NOT plan-gated at all** (new findings this sub-phase, not previously stated):
- **Crawl cadence.** `CrawlTier` (`HOT`=8h, `WARM`=1day, `COOL`=7days, `COLD`=30days, `DORMANT`=90days; `DEFAULT_TIER_ON_BASELINE = "COLD"`) is a `Store`-level, globally-shared field. A store gets `HOT` the instant it has ≥1 active watcher, regardless of that watcher's plan. **There is no mechanism today that gives a paid plan a faster crawl than a free plan's single watched store** — both get the same 8-hour `HOT` cadence.
- **Marketing/SerpApi collection.** Grepped `src/lib/marketing/` for `plan` this sub-phase: zero Bellwether-plan references. Collection is driven purely by `Store.nextMarketingCollectionAt`, a per-store cooldown independent of which user (or which user's plan) is watching. It's also decoupled from `/api/analyze` entirely — `runAnalysis()` never triggers marketing collection inline; that only happens on the scheduler's own tick (see Section 20 for why this matters for abuse economics).
- **Export/CSV.** No implementation anywhere (precise re-search this sub-phase, zero matches on `text/csv`, `Content-Disposition`, or `.csv`) — the "CSV & API exports" feature advertised on the Business tier does not exist in any form.
- **Alerts.** `Watchlist.alertThreshold` and `lastDigestAt` exist in the schema but are annotated in the schema itself as "Unused until the alerts feature (explicitly out of scope this milestone) ships." No alert delivery code exists.
- **Team seats / multi-project / white-label.** No `Organization`/`Team` model, no multi-tenancy of any kind.

**Anonymous (unauthenticated) access — a materially important, previously under-stated finding:** `runAnalysis()` accepts `caller: null` explicitly and documents it: *"the crawl still runs (shared corpus value), but no usage credit is checked or spent."* An anonymous visitor can analyze **any number of stores**, gated only by the in-memory, single-process, 5-requests-per-minute-per-IP limit on `/api/analyze` — there is no lifetime or daily cap for anonymous use. What they receive back is a reduced `access: "anonymous_preview"` report (platform, product count, theme name/version only — exactly what `FreeReportStrip.tsx` renders), with a CTA to create an account for the full report. Signed-in FREE users get the full report (`buildFullStoreReport`) for up to 3 lifetime stores.

---

## 7. Current Pricing State

`VERIFIED` — `PricingSection.tsx` read in full this sub-phase, verbatim tier data below.

| Tier | Price | Headline features (verbatim) |
|---|---|---|
| Free | $0 | "3 unique stores, full intelligence unlocked" · "Complete app & technology stack" · "Product, price & activity history" · "Monitor 1 store free for 30 days" |
| Pro | $29/mo | "25 unique stores analyzed" · "Monitor 10 stores · faster crawl cadence" · "Continuous monitoring, no 30-day limit" · "Change alerts & price history" |
| Business | $79/mo | "Everything in Pro" · "Monitor 50 stores · 2× daily crawl" · "CSV & API exports" · "Advanced analytics" · "Priority processing" |
| Agency | $149/mo | "Everything in Business" · "Multiple projects & team seats" · "200+ monitored stores" · "White-label client reports" · "Full API access" |

Page tagline (verbatim): *"Pay for intelligence, not exports."* Sub-copy: *"Every paid plan includes full store intelligence and continuous monitoring. Cancel anytime."* — this tagline is notable: it's already directionally aligned with the new philosophy (see Section 25).

Every paid-tier CTA button, when clicked, calls `onPlanSelected("<Tier> checkout — connects to billing in the production app")`, which the parent page renders as a toast. No navigation, no API call, no checkout.

---

## 8. Pricing Mismatch Inventory

| Feature (public promise) | Backend implementation | Actually works? | Mismatch? | Recommended action |
|---|---|---|---|---|
| Free: "3 unique stores, full intelligence" | `FREE.maxUniqueAnalyses = 3` | Yes | No | Keep as documentation of current behavior; **but see Section 15 — recommend raising/removing this cap** as a product decision, not a bug fix. |
| Free: "Monitor 1 store free for 30 days" | `FREE.maxActiveMonitoredStores = 1`, `monitoringDurationDays = 30` | Yes | No | Works exactly as advertised. **See Section 15 — recommend removing the 30-day expiry** as a product decision. |
| Pro: "25 unique stores analyzed" | No `PRO` plan exists in `PlanTier` | No | **Yes — hard mismatch** | Pro doesn't exist as a backend concept at all. Cannot be purchased, cannot be granted. |
| Pro: "Monitor 10 stores · faster crawl cadence" | No `PRO` plan; and "faster crawl cadence" has **no implementation for any plan** | No | **Yes — hard mismatch, double** | Neither the tier nor the claimed capability exists. |
| Pro/Business: "Continuous monitoring, no 30-day limit" | `BASIC.monitoringDurationDays = null` is the real backend equivalent | Partially — the *capability* exists on `BASIC`, just not reachable via "Pro" | **Yes — naming mismatch** | The real, working continuous-monitoring tier is called `BASIC` in code and "Pro"/"Business" on the page. |
| Pro: "Change alerts & price history" | `alertThreshold`/digest fields exist but are explicitly unused; price history exists as raw data but has no user-facing alert delivery | No (alerts), Yes (raw history) | **Yes, for alerts** | Alerts are unbuilt. Do not advertise until built (see Section 30). |
| Business: "Monitor 50 stores · 2× daily crawl" | `BUSINESS.maxActiveMonitoredStores = 50` (count works); "2× daily crawl" has no implementation — cadence is not plan-based at all | Partially | **Yes, for cadence** | The store-count number happens to match code, coincidentally — the cadence claim does not exist anywhere. |
| Business: "CSV & API exports" | None found (precise search this sub-phase) | No | **Yes — hard mismatch** | Fully unbuilt. |
| Business: "Advanced analytics" | `advancedIntelligence: true` flag exists but has zero enforcement/behavioral effect | No | **Yes — dead flag** | The flag exists in shape only; nothing reads it. |
| Business: "Priority processing" | No priority queue exists (no queue at all — single scheduler, FIFO by due time) | No | **Yes — hard mismatch** | Unbuilt. |
| Agency (entire tier) | No `AGENCY` plan; no team/org model; no multi-project concept | No | **Yes — hard mismatch, entire tier** | Agency doesn't exist as a backend concept in any dimension. |
| Agency: "200+ monitored stores" | Backend max across all plans is `BUSINESS` at 50 | No | **Yes** | Would require a new plan tier and possibly infra scaling (see Section 20 STOP conditions). |
| Agency: "White-label client reports" | No white-labeling of any kind | No | **Yes** | Unbuilt. |
| Agency: "Full API access" | No public API exists at all (only internal Next.js routes consumed by the dashboard) | No | **Yes** | Unbuilt. |

**Summary:** Of the 4 advertised tiers, exactly 2 backend plans exist (`FREE`, `BASIC`), and `BUSINESS` exists as a schema value with real store-count/analysis-count numbers but no distinguishing capability beyond those two numbers (no cadence, export, or analytics difference from `BASIC`). Every feature that isn't a raw `maxUniqueAnalyses`/`maxActiveMonitoredStores`/`monitoringDurationDays` number is either unenforced or entirely unbuilt.

---

## 9. Billing Provider Research

Per the brief's hard rule: absence from an exclusion list, or a secondary-source claim, is not treated as merchant-eligibility confirmation. Only an explicit, primary-source, seller-scoped statement is `VERIFIED`. Everything short of that is labeled precisely.

### 9.1 Stripe

- `VERIFIED` — Bangladesh is **absent** from Stripe's own primary global-availability page (`stripe.com/global`), fetched directly this sub-phase. Stripe's own page lists supported countries for operating a Stripe account (i.e., as a merchant); Bangladesh does not appear.
- `RESEARCH REQUIRED` (unchanged from Sub-phase A) — secondary sources describe a "Preview" tier under Stripe Connect that reportedly includes Bangladesh with unstable, revocable cross-border payouts. This was not found on any Stripe-owned primary page this sub-phase either, so it remains unconfirmed and, per Sub-phase A's own finding, explicitly described elsewhere as carrying payout risk (Stripe may pause payouts without notice).
- Stripe is a **direct payment processor**, not a Merchant of Record — Bellwether itself would need to be the merchant of record for tax, refunds, and chargebacks even where Stripe is usable. This is a materially higher operational/legal burden than an MoR platform, independent of the country question.
- **Classification: `DO NOT USE`** for V1 — not because Stripe is bad, but because no primary-source path to legitimate Bangladesh merchant status was found, and even a workaround (e.g., a Stripe Atlas US entity) pushes scope far beyond V1 (see Section 33 STOP conditions).

### 9.2 Paddle

- `VERIFIED` (upgraded this sub-phase from Sub-phase A's `RESEARCH REQUIRED`) — Paddle's own Help Center article, "Which countries are supported by Paddle?" (`paddle.com/help/start/intro-to-paddle/which-countries-are-supported-by-paddle`), fetched directly this sub-phase, states verbatim: *"Paddle is unable to support suppliers operating from the below countries."* It then lists 28 excluded countries (Afghanistan, Antarctica, Belarus, Burma/Myanmar, Central African Republic, Cuba, Crimea, DR Congo, Donetsk, Haiti, Iran, Iraq, Kherson, Libya, Luhansk, Mali, Netherlands Antilles, Nicaragua, North Korea, Russia, Somalia, South Sudan, Sudan, Syria, Venezuela, Yemen, Zaporizhzhia, Zimbabwe). **Bangladesh is not on this list.**
- This is the strongest form of confirmation reasonably obtainable from desk research: Paddle explicitly frames the list as seller/supplier-scoped (not buyer-scoped, which is documented separately), and states the default is inclusion except for the named list. It stops short of `VERIFIED` in the strictest sense only because Paddle never makes an affirmative "Bangladesh: yes" statement — actual account approval is discretionary (Paddle's own language: *"may from time to time request further information... for risk and compliance purposes"*), so real confirmation requires an actual application or a direct sales answer (Section 13 questionnaire).
- Individual (non-incorporated, sole-trader) sellers are explicitly supported per Paddle's own account-setup documentation — payouts go directly to a personal bank account, no incorporation required. This directly matters for a Bangladesh-based individual operator, since acquiring a Bangladeshi corporate entity for this project has not been established (`HUMAN DECISION REQUIRED`, not assumed here).
- Requires KYB (Know Your Business) verification; ownership-breakdown documents are waived for individuals/sole traders.
- Fees (secondary-source, multiple 2026 aggregator sites converge on the same figure, **not independently confirmed against Paddle's own pricing page this sub-phase** — labeled `ESTIMATED`): ~5% + $0.50 per transaction, no separate international-card or subscription surcharge (all-in pricing).
- **Classification: `LIKELY` → `CONDITIONAL GO`**, pending the outreach questionnaire in Section 13.

### 9.3 Polar.sh

- `VERIFIED` — Polar's own primary docs page (`polar.sh/docs/merchant-of-record/supported-countries`), fetched directly this sub-phase, **explicitly and structurally separates buyer eligibility from seller eligibility**: buyers are supported globally (minus sanctions); sellers are supported only in an enumerated payout-country list, because Polar uses Stripe Connect Express for seller payouts. **Bangladesh appears explicitly in that seller/payout-country list** — the single most direct, affirmative, primary-source confirmation found for any provider in this research pass.
- Individual-vs-business eligibility for Bangladesh specifically is `RESEARCH REQUIRED` — Polar's own FAQ says an individual can sell "given that Stripe Connect Express supports individual as a business type in your region," and directs the seller to check this directly inside Stripe Connect Express onboarding by selecting Bangladesh as the account country. Polar's docs do not state the answer for Bangladesh specifically.
- Polar is Merchant of Record (handles tax/VAT/chargebacks), supports subscriptions natively (it is built specifically for SaaS/dev tools), and is open-source.
- Fees (`ESTIMATED`, secondary-source convergence across multiple 2026 comparison articles, not independently confirmed against Polar's own pricing page): a free/Starter tier at ~5% + $0.50, with paid tiers reducing to ~3.8–3.4% + $0.30–0.40 depending on a monthly platform fee ($20–$400/mo) — this tiered-fee-for-lower-rate structure is new as of 2026 per these sources and should be re-verified directly before any commitment. Also charges an additional ~1.5% on non-US cards.
- **Classification: `LIKELY` → `CONDITIONAL GO`, currently the strongest single candidate**, pending confirmation of individual-seller eligibility specifically (Section 13).

### 9.4 Lemon Squeezy

- `RESEARCH REQUIRED` — `BLOCKED`, not skipped. `docs.lemonsqueezy.com` returned HTTP 403 to every direct-fetch attempt this sub-phase (3 attempts, 2 distinct pages, both via `WebFetch` and via a web-archive fallback that was itself unreachable from this environment). This is consistent with bot/Cloudflare protection on that domain, not an absence of documentation.
- Secondary sources (search-result summaries, not independently verifiable this sub-phase) claim Lemon Squeezy expanded bank payouts to "79 countries" and that Bangladesh is among countries where buyers can be charged — **neither claim was confirmed against a primary source**, and per the brief's explicit rule, this must not be reported as eligibility.
- Lemon Squeezy is Merchant of Record, supports subscriptions, and by multiple secondary accounts converges on similar ~5% + $0.50 pricing to Paddle with additional surcharges on international cards/PayPal/subscriptions (`ESTIMATED`, unconfirmed).
- **Classification: `RESEARCH REQUIRED`** — cannot be ruled in or out from this research pass. Requires either a successful direct fetch from an unblocked environment, or the Section 13 outreach questionnaire.

---

## 10. Provider Comparison Matrix

| Provider | Merchant eligibility from Bangladesh | Payout support | MoR | Subscriptions | Webhooks | Customer portal | Refunds | Tax handling | Approx. fees | Business requirements | Main risk | Overall suitability |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Stripe** | `VERIFIED` absent from primary supported list; secondary "Preview" tier `RESEARCH REQUIRED` | Unstable/unconfirmed | No (direct processor) | Yes | Yes | Yes (Billing Portal) | Yes (Bellwether's own liability) | Bellwether's own liability | ~2.9% + $0.30 (`ESTIMATED`) | Bellwether becomes merchant of record itself | No confirmed legitimate path from Bangladesh; even if usable, shifts tax/chargeback/PCI burden onto Bellwether | **`DO NOT USE`** |
| **Paddle** | `LIKELY` (absent from explicit 28-country exclusion list; individual sellers explicitly supported) | Direct bank payout, individual sellers OK | Yes | Yes | Yes | Yes | Yes (Paddle-handled) | Yes (Paddle-handled) | ~5% + $0.50, all-in (`ESTIMATED`) | None beyond KYB (waived ownership docs for individuals) | Approval is discretionary; no affirmative "yes" statement found | **`CONDITIONAL GO`** |
| **Polar.sh** | `VERIFIED` on Bangladesh being in the seller/payout list; individual-vs-business `RESEARCH REQUIRED` | Via Stripe Connect Express | Yes | Yes (native SaaS focus) | Yes | Yes | Yes (Polar-handled) | Yes (Polar-handled) | ~5% + $0.50 base, tiered discounts to ~3.4–3.8% + $0.30–0.40 at $20–$400/mo (`ESTIMATED`) | Depends on Stripe Connect Express's Bangladesh business-type support (unconfirmed) | Fee-tier terms changed in 2026 and may change again; individual eligibility unconfirmed | **`CONDITIONAL GO`, strongest lead** |
| **Lemon Squeezy** | `RESEARCH REQUIRED` — primary docs inaccessible (403) | Unconfirmed | Yes | Yes | Yes | Yes | Yes (LS-handled) | Yes (LS-handled) | ~5% + $0.50 + surcharges (`ESTIMATED`, unconfirmed) | Unknown | Cannot currently confirm or rule out | **`RESEARCH REQUIRED`** |

---

## 11. Bangladesh Eligibility Findings

Summarized from Section 9 — the single most load-bearing fact in this report:

- **The question that matters is seller/merchant eligibility, not buyer/customer eligibility**, and all four providers' marketing pages default to describing buyer reach (the "sell in 200+ countries" language), which is a different claim entirely.
- **Only Polar's own docs explicitly separate the two and name Bangladesh on the seller side** — this is the cleanest, most direct primary-source finding of the four.
- **Paddle's own docs imply seller eligibility by exclusion** (Bangladesh not on a named 28-country block-list) — a reasonable, but not airtight, signal.
- **Stripe's own docs confirm Bangladesh is NOT a merchant country** for standard Stripe accounts.
- **Lemon Squeezy remains genuinely unknown** — not because it's unlikely, but because its documentation could not be accessed this session.

None of this is a substitute for an actual application or a direct answer from provider support. Treat Section 13's questionnaire as a required next step, not optional due diligence.

---

## 12. Provider Recommendation

**Primary candidate: Polar.sh.** It has the most explicit, structurally-separated, primary-source confirmation of Bangladesh seller eligibility of any provider researched, it is purpose-built for SaaS subscriptions (matches Bellwether's actual product shape), and it is Merchant of Record (keeps tax/chargeback/PCI liability off Bellwether). **Secondary/fallback candidate: Paddle** — same MoR/subscription shape, slightly weaker (but still real) eligibility signal, more mature/longer track record than Polar. **Do not pursue Stripe** for V1 given the confirmed absence from its own merchant-country list and the added burden of not being an MoR. **Lemon Squeezy stays under consideration** pending the Section 13 outreach, since it may turn out equal or superior to Polar/Paddle, but should not block a decision on the other two.

This recommendation is `CONDITIONAL GO`, not `GO` — the condition is direct confirmation via Section 13 before any integration work begins.

---

## 13. Unresolved Provider Questions — Outreach Questionnaire

Send verbatim to each provider's sales/support (Polar and Paddle first, in parallel; Lemon Squeezy once/if its docs become reachable or a support contact is found):

1. Can a Bangladesh-based **individual** (not a registered company) sell a SaaS subscription product through your platform and receive payouts to a Bangladesh bank account?
2. Can a Bangladesh-based **registered company** do the same, and does that unlock anything an individual seller doesn't get?
3. Do you require a foreign (e.g., US, UK, EU) legal entity for a Bangladesh-based operator, or is a Bangladesh entity/individual sufficient on its own?
4. Can you act as Merchant of Record for a Bangladesh-based SaaS business specifically (not just "supported countries" in general)?
5. Are recurring monthly subscriptions with automatic renewal and cancellation fully supported for a Bangladesh-based seller?
6. What KYC/KYB documentation would a Bangladesh-based individual specifically need to provide?
7. What payout method(s) are actually available to a Bangladesh bank account (local currency, USD, wire, etc.), and what is the payout schedule/minimum?
8. Are there any Bangladesh-specific restrictions, additional review steps, or historical rejection patterns you're aware of?
9. If our account is approved, is there any condition under which payouts could later be paused or the account restricted specifically due to our being Bangladesh-based?
10. What is the realistic approval timeline for a first-time Bangladesh-based applicant?

---

## 14. Freemium Product Strategy

The new north star, taken directly from the brief: **"Analyze competitors for free. Monitor them at scale."** The exact upgrade trigger: **"I have more than one competitor I want Bellwether to keep watching."**

This sub-phase's architecture trace (Section 6) shows the codebase is already unexpectedly close to this model — full-intelligence analysis is already free for signed-in users, and single-store monitoring is already free. The redesign is less "invent a new model" and more "remove the parts of the current model that quietly contradict the model already half-built," specifically: the lifetime 3-store analysis cap, the 30-day monitoring expiry, and the 4-tier pricing page that doesn't match any of it.

**Recommendation: collapse to FREE + ONE PAID PLAN.** The current 3-tier backend (`FREE`/`BASIC`/`BUSINESS`) already has `BUSINESS` as an unused, undifferentiated placeholder (Section 6) — there is no product reason today to keep three, let alone the page's four.

---

## 15. Free Tier Definition

`HUMAN DECISION REQUIRED` on the two starred items — these are real product/cost trade-offs, not settled facts. Recommendations given with reasoning; final call belongs to the project owner.

- **Analysis: recommend removing the lifetime "3 unique stores" cap for signed-in users.**\* Reasoning: (1) it directly contradicts "analyze competitors for free" — a business with 4+ real competitors, the exact serious user Bellwether wants, hits a wall on the one thing supposed to be unconditionally free; (2) the cap is already not a real abuse boundary — a determined abuser bypasses it with a second free account (protected only by a 10/min/IP signup rate limit), so it mostly taxes legitimate users while barely inconveniencing abusers; (3) analysis is a one-time cost (single crawl) vs. monitoring's recurring cost, so the economics that justify limiting monitoring don't apply the same way to analysis. Replace the product-facing cap with velocity-based abuse protection instead (Section 17) — bound cost by behavior, not by a marketed number.
- **Frequency:** on-demand, any time, subject only to the (currently in-memory, needs hardening — Section 22) abuse-prevention layer, never a "you get N per day" marketed limit.
- **Monitoring: yes, 1 store, free.** Keep this — it already exists and already works.
- **Monitoring duration: recommend removing the 30-day expiry, making the single free monitored store permanent.**\* Reasoning: today's 30-day cutoff, and the `SubscriptionCTA` that appears after it lapses, is functionally identical to the "paywall around basic intelligence" pattern the brief explicitly says Bellwether should stop being. A permanent single free monitored store makes the free/paid boundary exactly the sentence the brief gave: free = 1 competitor watched forever, paid = more than 1.
- **What's free regardless of plan:** all analysis, all report categories currently gated by nothing (advertising summary, growth intelligence, review observations, product/price history), 1 continuously-monitored store, full historical access to anything the account has ever analyzed or monitored, the anonymous preview.

---

## 16. Paid Tier Definition

Single paid tier (proposed name: kept generic here — naming is a marketing decision outside this report's scope).

- **Monitored stores:** a bounded number materially above 1 — see Section 29 for the specific recommended figure and range. Not the current `BASIC` value of 20 (never load-tested or cost-modeled against real scheduler behavior — carried over from a pre-billing placeholder, not a considered decision).
- **Crawl frequency:** same shared cadence as the free tier's 1 store (the existing `HOT` 8-hour tier). **Recommend NOT building plan-differentiated cadence in V1** — see Section 30 — since no infrastructure for it exists today and the value proposition ("more than one competitor," not "faster than one competitor") doesn't require it.
- **What paid actually buys:** more simultaneous monitored stores. Nothing else, in V1. Historical access, full analysis, and report depth are identical to free.

---

## 17. Entitlement Matrix

For each conceptual entitlement named in the brief: Free value / Paid value / Should it exist in V1 / Why.

| Entitlement | Free | Paid | Exists in V1? | Why |
|---|---|---|---|---|
| `ANALYSIS_ACCESS` | Unlimited (see Section 15) | Unlimited | Yes | Core free hook; must not be plan-differentiated per the new positioning. |
| `MONITORED_STORE_LIMIT` | 1 | N (Section 29) | Yes | The entire paid value proposition lives here — this is the one dimension worth keeping plan-differentiated. |
| `CRAWL_FREQUENCY` | Shared `HOT` (8h) | Same | **No — do not differentiate** | No infra exists for this; building it is unjustified complexity for a V1 whose value prop is store-count, not speed (see Section 30). |
| `ALERT_ACCESS` | — | — | **No** | The underlying feature (real-time/digest alerts) is unbuilt (`alertThreshold` is a dead schema field). Do not paywall a feature that doesn't exist. |
| `HISTORY_RETENTION` | Full | Full | **No — not plan-differentiated** | Already `true` for every plan today; no reason found to change that (see Section 23 on retention after cancellation). |
| `MARKETING_COLLECTION` | Included in any full report | Same | **No — not plan-differentiated** | Confirmed store-scoped, not plan-scoped, at the architecture level; would require real redesign to differentiate and there's no product reason to. |
| `EXPORT_ACCESS` | — | — | **No** | Unbuilt entirely; do not advertise or gate a feature that doesn't exist (see Section 30). |
| `TEAM_SEATS` | — | — | **No** | No multi-tenancy model exists; explicitly out of scope for V1 (see Section 30). |
| `API_ACCESS` | — | — | **No** | No public API exists; explicitly out of scope for V1 (see Section 30). |

The honest V1 entitlement model has exactly **two** real dimensions: `ANALYSIS_ACCESS` (unlimited, universal) and `MONITORED_STORE_LIMIT` (1 free / N paid). Everything else on the current pricing page is either already-free-and-shouldn't-be-paywalled or doesn't exist yet and shouldn't be advertised.

---

## 18. Usage Limits

See Section 15 (analysis: recommend unlimited, velocity-protected) and Section 16 (monitoring: 1 free / N paid). No other usage dimension is recommended for V1.

---

## 19. Monitoring Limits

Recommended paid monitored-store limit and reasoning are in Section 29 (pricing) since the two decisions — "how many stores" and "what to charge for them" — are really one decision about willingness-to-pay, not two independent ones.

---

## 20. Abuse Protection

Distinguishing `OBSERVED` (measured/confirmed this session or Sub-phase A) from `ESTIMATED` (reasoned, not measured) throughout.

**`OBSERVED` facts that shape the real risk:**
- `/api/analyze` already rate-limits at 5/min/IP (`OBSERVED`, `src/lib/security/rate-limit.ts`), but the limiter is in-memory and single-process — `OBSERVED` (Sub-phase A) not to survive horizontal scaling. This is an existing gap, not a new one created by this redesign.
- Anonymous analysis has **no usage ledger at all** today (`OBSERVED`, Section 6) — only the IP rate limit bounds it.
- A full analysis crawl of a **never-before-seen domain** does two things a re-analysis of a known store doesn't: it creates a permanent `Store` row that the scheduler will keep re-crawling on a recurring cadence indefinitely (decaying `HOT→WARM→COOL→COLD→DORMANT` over time, per `policy.ts`, but never fully stopping short of `DISABLED`) — `OBSERVED`, and a genuinely new finding this sub-phase not previously stated in Sub-phase A. This means mass submission of throwaway/unique domains creates **standing infrastructure debt**, not just a one-time cost — a materially different (and larger) risk than "someone re-analyzes the same store a lot."
- Marketing/SerpApi collection is **not** triggered by `/api/analyze` at all — confirmed this sub-phase by reading `run-analysis.ts` end to end; it only fires from the scheduler's own cooldown-gated tick. This means the single most expensive external cost per Sub-phase A (SerpApi is a paid third-party API) is **not** directly exposed to `/api/analyze` abuse the way a naive reading of the brief's "excessive SerpApi-triggering" concern might suggest — it's bounded by the scheduler's own store-level cooldown regardless of how many times a human hits "Analyze."

**Recommended layered protections** (concrete, per the brief's explicit ask for specifics, not "just rate limit it"):

| Layer | What's limited | Identity | Starting point (`ESTIMATED`, needs real-world tuning) | Notes |
|---|---|---|---|---|
| Burst | Requests/minute | IP | 5/min (already exists — keep) | Already `OBSERVED` working; needs a persistent (not in-memory) backing store before multi-instance deployment. |
| Daily velocity | Analyses/day | IP | ~20–30/day (`ESTIMATED`) | New — catches sustained single-IP abuse the burst limit alone doesn't. |
| Daily velocity | Analyses/day | Account | ~50/day (`ESTIMATED`) | New — a human doing competitive research won't hit this; a script will. Deliberately never surfaced as a marketed number, so the public "unlimited" claim stays honest. |
| New-domain velocity | First-ever crawls of a domain never seen before | IP + account combined | ~5–10/day (`ESTIMATED`, stricter than the general daily cap) | New, and the most important addition — this is the one action that creates standing scheduler cost, not just a one-time request cost. |
| Signup friction | Account creation | IP | 10/min (already exists — keep) | Already `OBSERVED`; the natural place to add email verification if abuse is later observed in practice. |

**What's deliberately not recommended:** CAPTCHA, payment-method-on-file for free tier, or hard account-level analysis caps — all would directly undercut the "analyze free" positioning this whole redesign exists to deliver. Add them only if the layers above prove insufficient in practice (`RESEARCH REQUIRED` in the sense that this is a hypothesis to monitor post-launch, not a certainty).

---

## 21. Plan vs. Subscription Model

Conceptual distinction only — **no schema change made or proposed as code here.**

- **PLAN** answers "what is this user entitled to" — e.g., `FREE` / `PAID`. It's a current-state projection.
- **SUBSCRIPTION STATE** answers "what is the billing relationship's status" — e.g., `ACTIVE` / `PAST_DUE` / `CANCELED` / `PAUSED`. It's a history-aware, provider-synced record.

Today, `User.plan` conflates both into one bare enum with no history. When real billing exists, it will need (documented as future requirements, not implemented):

- A `provider` field (which billing provider — matters once more than one might ever be used, or during a future migration).
- A `providerCustomerId` and `providerSubscriptionId` (the external identifiers a webhook payload references).
- A `status` field distinct from `plan` (a user can be `PAID` plan with `PAST_DUE` status during a grace period — see Section 23).
- `currentPeriodStart` / `currentPeriodEnd`.
- A cancellation flag distinguishable from expiration (`cancelAtPeriodEnd` vs. an already-lapsed period).
- Webhook idempotency state (Section 24) — almost certainly a separate table (a `ProcessedWebhookEvent` ledger keyed on the provider's event ID), not a field on `User`.

None of this is proposed as an actual schema at this stage — it's the shape Sub-phase C will need to design against.

---

## 22. Subscription Lifecycle

Standard states to design against later: trial (if any — `HUMAN DECISION REQUIRED`, not addressed by the brief's 15 questions and not assumed here), active, past_due (grace period), canceled (still active until period end), expired/lapsed (period ended, not renewed). See Section 23 for the specific downgrade behavior at each transition.

---

## 23. Cancellation/Downgrade Policy

Worked example from the brief: a paid user has 10 monitored stores; subscription lapses (cancellation or non-payment, treated identically once the grace period, if any, expires).

**Recommended policy** (`HUMAN DECISION REQUIRED` to formally adopt, but this is a direct, low-risk extension of the sketch already given in the brief and consistent with `historicalAccess: true` already being universal in the current code):

1. No immediate deletion of anything, ever, for a billing reason.
2. Monitoring beyond the free allotment (1 store) stops — but "stops" means the excess `Watchlist` rows transition to an expired-equivalent status, not that they're deleted.
3. The user is presented a choice of which single store stays actively monitored; until they choose (or after a short grace window, e.g. 7 days), the system should not arbitrarily pick for them if avoidable — but if it must default (e.g., they never log back in), default to the most-recently-added store as the least-surprising fallback.
4. Analysis access is never affected by subscription state, at any point — it was never conditioned on billing to begin with (Section 15).
5. All previously generated reports and historical data remain fully accessible regardless of subscription state — this requires no new work, since `historicalAccess` is already `true` universally.
6. Reactivation (re-subscribing) resumes monitoring on the stores that were active before lapsing, where still possible (a store the user un-monitored isn't silently re-added).

---

## 24. Future Webhook Architecture

Design-only — do not assume provider-specific event names until Section 12's provider is confirmed and its actual webhook payload schema is read directly from that provider's docs. Generic event categories to design around (verified generically true of MoR providers, not asserting Polar/Paddle-specific names): subscription created, subscription updated (plan/quantity change), subscription canceled, payment succeeded, payment failed (triggers past_due).

**Required invariants, regardless of provider:**
- **Authentication/signature verification** on every webhook request — reject anything not signed by the provider's documented secret.
- **Idempotency** — a `ProcessedWebhookEvent` ledger keyed on the provider's event ID; processing must be a no-op on replay.
- **Replay safety** — a replayed old event must not un-cancel a subsequently-canceled subscription (ordering matters more than idempotency alone).
- **Event ordering** — do not assume delivery order; use the event's own timestamp/version, not arrival order, to decide whether it's newer than current state.
- **Authorization** — the webhook payload's customer/subscription ID must be resolved to exactly one Bellwether user; never trust a user ID if the payload includes one (it doesn't come from an authenticated session).
- **Transaction boundaries** — the entitlement change and the webhook-processed marker must commit atomically (same DB transaction), or a crash between them creates a permanently-stuck or double-processed event.
- **Auditability** — store the raw payload (or a durable reference to it) alongside the processed outcome, for support/dispute resolution.

---

## 25. Security Requirements

Design-only, architectural rules for Sub-phase C to follow — attack scenarios and the rule that closes each:

| Attack | Architectural rule |
|---|---|
| Forged webhook | Verify provider signature before touching any data. |
| Replayed webhook | Idempotency ledger keyed on provider event ID (Section 24). |
| Client-side plan manipulation | Entitlements are derived server-side from the subscription-state record on every check, never trusted from a client-supplied value (this already matches the current pattern — `plan` is read server-side from the session/DB today, not trusted from the client). |
| Checkout-success-without-webhook-confirmation | Never grant entitlement from a checkout-return redirect alone; the webhook (or a synchronous provider API confirmation) is the only source of truth. |
| Canceled subscription retaining paid entitlement | Entitlement checks read current subscription status live (or from a recently-synced cache with a short TTL), not a cached "is paid" boolean set once at checkout time. |
| Double-delivered webhook | Same idempotency ledger as replay. |
| Out-of-order webhook | Compare event timestamps/versions, not arrival order (Section 24). |
| Subscription belonging to another user | Resolve `providerCustomerId`/`providerSubscriptionId` → Bellwether `userId` via a server-side lookup table populated at checkout-initiation time, never from client input. |
| Provider customer ID collision | `providerCustomerId` should be unique-constrained per provider in the schema Sub-phase C designs. |
| Downgrade race | The same `pg_advisory_xact_lock` pattern already used for `recordAnalysisUsage`/`startMonitoring` (Section 6) should extend to subscription-state transitions — this codebase already has the right idiom for this class of problem. |

---

## 26. Account Lifecycle Requirements

`HUMAN DECISION REQUIRED` on whether these block Sub-phase C's start, with a recommendation:

- **Password reset:** confirmed absent (`src/app/api/auth/` has only `signup` and `[...nextauth]`). **Recommend this becomes a prerequisite for accepting payment** — a paying customer locked out of their account with no self-service recovery is a support and trust liability disproportionate to the feature's small build cost.
- **Account deletion:** confirmed absent. Interacts directly with subscription cancellation (must cancel any active subscription before/during deletion — a provider-side call, not just a DB delete) and with retained historical/billing data. **Recommend this becomes a prerequisite too**, for the same reason, plus the (unconfirmed, `LEGAL REVIEW REQUIRED`) likelihood that a paid product handling any EU/UK customer data triggers a "right to erasure" expectation regardless of Bellwether's own jurisdiction.
- **Data retention on deletion:** what happens to billing records (provider-side records persist regardless of Bellwether's own deletion; Bellwether's own copies raise a genuine legal question this report is not qualified to answer — `LEGAL REVIEW REQUIRED`, explicitly not invented here.

---

## 27. Terms/Privacy/Refund Requirements

`ENGINEERING vs LEGAL REVIEW REQUIRED` — this report does not draft legal text.

**Engineering surface needed before accepting payment:**
- Real Terms of Service and Privacy Policy pages (currently `href="#"` placeholders in `SiteFooter.tsx` — `VERIFIED`, Sub-phase A).
- A refund-policy statement (content is `LEGAL REVIEW REQUIRED`; the page/route to host it is engineering work).
- A subscription/cancellation explanation reachable from the billing UI (what happens when you cancel — should mirror Section 23's policy once adopted).
- A billing support contact (even a plain support email is sufficient for V1 — no ticketing system implied).
- A data-handling explanation covering what Bellwether crawls/stores about third-party storefronts, given the product's nature (publicly-observable competitor data) — this is a differentiator worth being explicit about, not just boilerplate.

**Legal review required, explicitly not invented in this report:** actual ToS/Privacy/refund legal text, any jurisdiction-specific consumer-protection obligations for a Bangladesh-based seller serving international customers, and whether any of the account-deletion/data-retention questions in Section 26 have a firm legal answer.

---

## 28. Advertising/Acquisition Model

No ad provider, ad unit, or UI change proposed — design-only, per the brief.

**Funnel as it already exists today (verified this sub-phase) plus where paid acquisition would slot in:**

SEO/landing → free anonymous analysis (already works, no signup) → preview report + signup CTA → signed-in free full report (already works, now recommended unlimited — Section 15) → optional free single-store monitoring (already works, recommended permanent — Section 15) → hits "more than one competitor" moment → paid upgrade.

- **Likely future ad surfaces:** the landing page itself, and possibly SEO-optimized "compare X vs Y" or "[Competitor] Shopify teardown" pages generated from already-crawled public data (a genuine, low-cost content angle this architecture already supports, since the crawl data exists regardless of who requested it).
- **Likely ad-free surfaces:** the dashboard and report views themselves — ads inside a paid-adjacent intelligence product read as undermining trust in the data, and the free tier's entire purpose is conversion, not ad-impression revenue.
- **Trust risk:** a competitive-intelligence tool that shows ads (especially programmatic/retargeting ads) risks looking like it's monetizing the very attention it's supposed to be protecting/analyzing on the user's behalf — worth flagging as a real positioning risk, not just a UX one, if ads are ever pursued on report pages specifically.
- **Relationship between free traffic and paid monitoring:** free analysis is the entire acquisition mechanism under this model — it should be treated as a cost center that earns its keep through monitoring conversions, not as a channel to itself monetize via ads. Advertising, if pursued at all, belongs on pre-report/landing surfaces, never on the report itself.

Treated throughout as a future, non-guaranteed revenue channel, per the brief.

---

## 29. Recommended Pricing

**Recommended V1 price: $19/month**, single paid tier.
**Acceptable test range: $15–$25/month.**

**Reasoning:**
- The comparable-category anchor is competitor-monitoring/price-tracking SaaS tools, which commonly sit in the $19–$49/month range for an individual-operator tier — Bellwether's current $29 "Pro" price sits inside that range already, but that price was set for a feature bundle (25 analyses + 10 monitored stores + several unbuilt features) that no longer exists under this redesign; the new bundle is smaller (unlimited analysis, N monitored stores, nothing else), which argues for pricing at the lower end of the category rather than the current $29.
- Monitoring cost is the only real recurring operational cost this plan is priced against (Section 20) — analysis is free and one-time; monitoring is the recurring crawl-cadence cost multiplied by store count, which scales roughly linearly with the store limit chosen (Section 16).
- The target buyer is an individual operator or small team tracking a handful of real competitors — not an agency (explicitly out of scope, Section 30) — so the price should clear "easy expense-it" territory for a solo founder or small-team marketer, not require a procurement conversation.
- **What would justify raising it:** measured monitoring infrastructure cost per store meaningfully exceeding what a $19/mo × N-stores plan recovers once real usage data exists (this report has no measured cost-per-store figure to check against — `ESTIMATED` only); or clear evidence from actual signups that willingness-to-pay is higher than assumed.
- **What would justify lowering it:** conversion data showing the free tier's single-store cap isn't converting because $19 reads as too big a jump from $0 for a user who only wants 2 stores, not 10.

This is a testable starting hypothesis, explicitly not a modeled-to-certainty number — no real infrastructure cost-per-monitored-store figure exists yet to price against with confidence.

**Recommended monitored-store limit for the paid tier: 10, test range 5–15.** Reasoning: high enough to clear "I have 2-3 real competitors" (the common real-world case for the target buyer) with headroom, low enough to stay meaningfully differentiated from a hypothetical future higher tier if one is ever justified by actual demand, and — unlike the current `BASIC` plan's 20 — chosen as a starting hypothesis rather than inherited from a pre-billing placeholder with no cost model behind it.

---

## 30. What Not to Build

Explicitly out of V1, per the brief and per this sub-phase's own findings:

- Team/organization systems, multi-seat billing (no `Organization`/`Team` model exists; no evidence in the current code of demand for this).
- Agency tier or any tier above the single paid plan (the current `BUSINESS` placeholder has never been differentiated from `BASIC` in practice — Section 6).
- Public API access (none exists; no partial implementation to build on).
- Plan-differentiated crawl cadence / "faster monitoring" (Section 17 — no infra exists, no product reason to build it for V1).
- CSV/API exports (none exists; advertised but never built).
- Alerts (the underlying feature, not just the entitlement, is unbuilt — `alertThreshold` is a dead field).
- White-labeling.
- Annual billing, coupons, affiliate systems, complicated invoicing.
- Feature-by-feature paywalls of any kind — the entire point of this redesign is one dimension (`MONITORED_STORE_LIMIT`) doing all the monetization work.

---

## 31. Sub-phase C Implementation Plan (Sequencing Only — Not Started)

For each step: files likely affected / schema impact / dependency impact / security implications / tests required / browser verification required / external credential requirement.

1. **Finalize pricing config** — decide exact price, store-limit number, and provider (resolve Section 13 first). Files: none yet (decision, not code). No schema/dependency impact.
2. **Align public pricing page with backend reality** — collapse `PricingSection.tsx` to FREE + 1 paid tier, remove unbuilt-feature claims. Files: `src/components/marketing/PricingSection.tsx`. No schema/dependency impact. Security: none. Tests: none new (presentational). Browser verification: required (visual + click-through). Credentials: none.
3. **Remove the FREE analysis cap and monitoring-duration expiry** (Section 15 decisions, once formally adopted) — a genuinely small, low-risk code change on its own, separable from billing entirely. Files: `src/lib/entitlements/plan-limits.ts`, possibly `SubscriptionCTA.tsx` (removal/rework). Schema impact: none (uses existing fields, just changes the constant/expiry value). Dependency impact: none. Security: none new. Tests: update `plan-limits.test.ts` and `analysis-usage.integration.test.ts` expectations. Browser verification: required. Credentials: none. **This step could ship independently of billing, before Sub-phase C's billing work, if the project owner wants the positioning change live sooner** — flagged as an option, not a recommendation to split phases without being asked.
4. **Subscription domain model** — new `Subscription` (or similarly-named) model per Section 21's shape. Files: `prisma/schema.prisma`, new migration. Schema impact: yes, additive only. Dependency impact: none yet. Security: new PII-adjacent (billing) data at rest. Tests: schema/migration tests. Browser verification: N/A. Credentials: none yet.
5. **Billing provider integration (SDK, checkout)** — files: new `src/lib/billing/` module, `package.json`. Schema impact: none beyond step 4. Dependency impact: yes, first billing SDK dependency. Security: API key handling (server-side only, never client-exposed). Tests: unit tests against the SDK's test/sandbox mode. Browser verification: required (real checkout flow in sandbox). Credentials: **provider sandbox/test API keys required.**
6. **Checkout flow** — files: new checkout route/page. Security: never trust checkout-success redirect alone (Section 25). Tests: integration test simulating checkout-return without a webhook having fired yet, confirming no entitlement is granted. Browser verification: required. Credentials: sandbox keys (from step 5).
7. **Webhook endpoint + signature verification** — files: new `src/app/api/webhooks/<provider>/route.ts`. Security: highest-risk step in the whole sequence (Section 25). Tests: forged-signature rejection, replay rejection, out-of-order rejection — all as explicit test cases, not just happy-path. Browser verification: N/A (server-to-server). Credentials: provider webhook signing secret.
8. **Entitlement sync from webhook events** — files: `src/lib/entitlements/*`, extending the existing `pg_advisory_xact_lock` pattern (Section 25) to subscription-state writes. Schema impact: none beyond step 4. Tests: concurrency tests mirroring the existing `analysis-usage.integration.test.ts` pattern.
9. **Subscription lifecycle (past_due, cancellation, reactivation)** — implements Section 23's policy. Files: `src/lib/entitlements/*`, scheduler (for grace-period expiry, similar to `expireDueWatches()`). Tests: each state transition, each timezone-safety consideration per `AGENTS.md`'s Database time rule if any raw SQL touches timestamps here.
10. **Downgrade UX (choose which store stays monitored)** — files: new dashboard UI. Browser verification: required.
11. **Account billing page** (view plan, cancel, update payment method — likely a provider-hosted customer portal link, not custom UI, per Section 9's finding that all three viable providers offer one). Files: new dashboard route. Credentials: sandbox keys.
12. **Terms/Privacy/refund links** (Section 27) — files: `SiteFooter.tsx`, new static pages. Requires the actual legal text (`LEGAL REVIEW REQUIRED`) before this step can complete, even though the engineering wiring is trivial.
13. **Production verification** — full test suite, `tsc`/`eslint`/`next build`, migration-chain verification (same disposable-Postgres pattern used in Sub-phase A), and live browser verification of the full checkout→webhook→entitlement path in the provider's sandbox mode, before any real credential is used.

---

## 32. External Credentials Required

None for this sub-phase (research-only). For Sub-phase C, in order of first need: chosen provider's sandbox/test API key (step 5), chosen provider's webhook signing secret (step 7), then, only after full sandbox verification, live/production credentials.

---

## 33. STOP Conditions

Evaluated against this sub-phase's findings:

1. **No legitimate billing provider can support Bellwether's actual merchant situation** — not triggered. Polar and Paddle both show real (if not fully `VERIFIED`) support.
2. **Provider eligibility requires an unestablished legal structure** — not triggered for Polar/Paddle (individual-seller paths appear to exist); would trigger if Section 13 outreach reveals otherwise, or if the fallback becomes Stripe-via-foreign-entity.
3. **The freemium model creates unacceptable infrastructure exposure** — partially relevant: Section 20's "standing scheduler debt from unlimited free analysis of new domains" is a real exposure, but it's judged manageable via the new-domain velocity limit proposed there, not a blocker.
4. **Existing entitlement architecture can't be safely extended without major redesign** — not triggered; the `pg_advisory_xact_lock` pattern already used for the two existing enforcement points (Section 6) extends naturally to subscription-state (Section 25), and the entitlement model shrinks (Section 17) rather than grows in complexity under this redesign.
5. **Any pricing claim can't be reconciled with actual implementation** — this is exactly what Section 8 documents; it's resolved by this report's recommendation to redesign the page (step 2, Section 31), not a blocker to that redesign happening.
6. **A provider's terms prohibit Bellwether's intended SaaS model** — no evidence found; not triggered.
7. **Billing integration would require storing sensitive payment info directly** — not triggered; both recommended providers (Polar, Paddle) are MoR/hosted-checkout platforms, so Bellwether never touches raw card data.
8. **A proposed feature requires infrastructure not justified for V1** — this is exactly why Section 30 exists; those features are excluded, not blocked-and-ignored.

**No STOP condition is currently triggered.** The phase is `CONDITIONAL GO`, gated on Section 13's outreach and the `HUMAN DECISION REQUIRED` items in Sections 15, 21 (naming), and 26.

---

## 34. Open Questions

1. Section 13's outreach responses (Polar, Paddle, and Lemon Squeezy if reachable) — the single biggest open item.
2. Whether to remove the FREE analysis cap and monitoring-duration expiry as a standalone change ahead of full billing (Section 31, step 3) or bundle it with the rest of Sub-phase C.
3. Final paid-tier name (not addressed here — a marketing decision).
4. Whether any trial period should exist on the paid tier (not specified by the brief's 15 questions; no recommendation made here without a clearer signal of intent).
5. The account-deletion/data-retention legal questions in Section 26 (`LEGAL REVIEW REQUIRED`).

---

## 35. Final Decision

**Overall status: `CONDITIONAL GO`.**

- **Billing provider:** Polar.sh recommended primary, Paddle as a close secondary/fallback — both `CONDITIONAL GO`, gated on the Section 13 questionnaire. Lemon Squeezy `RESEARCH REQUIRED` (access-blocked, not ruled out). Stripe `DO NOT USE`.
- **Final proposed free tier:** unlimited full-intelligence analysis (removing the current 3-store lifetime cap) + 1 permanently-monitored store (removing the current 30-day expiry). Both are `HUMAN DECISION REQUIRED` changes from current behavior, strongly recommended.
- **Final proposed paid tier:** one plan, up to 10 monitored stores (test range 5–15), same shared crawl cadence as free — no other differentiator in V1.
- **Proposed price:** $19/month (test range $15–$25).
- **Exact upgrade trigger:** "I have more than one competitor I want Bellwether to keep watching" — and the entitlement model in Section 17 is a direct, literal implementation of that one sentence, nothing more.
- **Major risks:** (1) provider eligibility not yet confirmed by direct outreach — the single hardest blocker to full `GO`; (2) removing the analysis cap without hardening abuse protection first could expose real infrastructure cost (Section 20) — sequence the abuse-protection hardening alongside, not after, the cap removal; (3) the legal-review items in Sections 26–27 are unresolved and outside this report's authority to close.

---

## 36. Recommendation

Proceed with Section 13's provider outreach immediately — it is cheap, fast, and gates everything else. In parallel, the project owner should make the three `HUMAN DECISION REQUIRED` calls in Sections 15 and 21 (analysis cap removal, monitoring-expiry removal, paid-tier naming). Once outreach returns a confirmed provider, Sub-phase C can begin at step 1 of Section 31.

**Sub-phase C is NOT authorized to begin by this report.** This report is a decision input, not an implementation trigger.

---

## Appendix: Files Read/Modified This Sub-phase

**Read (research only, listed in full in Section 4):** `plan-limits.ts`, `PricingSection.tsx`, `SubscriptionCTA.tsx`, `FreeReportStrip.tsx`, `run-analysis.ts`, `policy.ts`, `src/lib/marketing/*` (grep), `schema.prisma` (`User`/`Watchlist`/`AnalysisUsage`), `src/app/api/auth/` (listing).

**Modified:** none.
**Created:** this file only.
