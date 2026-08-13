# Milestone 10, Sub-phase A — Production SaaS Readiness Audit

**Method note**: every claim below was checked against the current repository during this sub-phase, not carried forward from prior milestone summaries. Where a prior report's claim was re-confirmed, that is stated explicitly as re-confirmed, not merely repeated. Where something could not be verified without credentials this environment doesn't have, it is marked **BLOCKED** or **RESEARCH REQUIRED**, never asserted.

---

## 1. Executive Summary

Bellwether's *product* (crawling, intelligence composition, monitoring, the Store Intelligence UI) is mature, well-tested, and — per Milestone 9's own conclusion — deliberately not being expanded further. Its *business infrastructure* is not. This audit found **zero billing persistence of any kind** (no Subscription/Payment/Invoice model — `User.plan` is a bare enum with no history), **a real, displayed-vs-implemented pricing mismatch** (the public pricing page advertises four tiers; the entitlement backend implements three, with different limits), **no Terms/Privacy pages** (footer links are literal placeholders), **no account-deletion or password-reset flow**, and **no production error-observability platform**. None of these are subtle: they are the kind of gap that is invisible while the product is free and becomes a real legal/financial/operational problem the moment real payment is accepted.

Nothing found here required reopening Milestone 7/8/9's intelligence or infrastructure decisions. Two small, genuinely necessary fixes were made this sub-phase (Section 27) — both non-behavioral (a duplicated comment, a test-timing race) — and both verified.

## 2. Current Production Readiness Score

Not a single number — the brief's own audit areas pull in different directions, and collapsing them into one score would hide that. Scored per dimension instead:

| Dimension | Status |
|---|---|
| Core intelligence product | **READY** (Milestone 9's own conclusion, re-confirmed unchanged) |
| Authentication / authorization | **READY**, with two documented, accepted gaps (Section 9) |
| Entitlement enforcement (what exists today) | **READY** |
| Billing | **PRODUCTION BLOCKER** — does not exist |
| Pricing/marketing accuracy | **PRODUCTION BLOCKER** — displayed tiers don't match backend |
| Legal (Terms/Privacy) | **PRODUCTION BLOCKER** — pages don't exist |
| Abuse/rate-limiting | **READY for current scale**, single-instance-only (self-documented) |
| Worker/scheduler | **PREVIOUSLY VERIFIED**, re-confirmed unchanged this sub-phase |
| Database | **READY**, one real gap (no retention policy — Section 13) |
| Observability | **RESEARCH REQUIRED / minimum stack not yet chosen** |
| Cloud deployment | **BLOCKED** (credentials unavailable, pre-established, not re-attempted) |

## 3. Verified Baseline

**VERIFIED, fresh this sub-phase**, not carried forward unchecked:

- Unit tests: **352/352 passing**
- Integration tests: **235/235 passing**, against a real, freshly-migrated disposable PostgreSQL instance
- `tsc --noEmit`: **PASS**
- `eslint .`: **PASS**
- `next build`: **PASS** — all 18 routes compiled
- Full migration chain (11 migrations): **PASS** via `prisma migrate deploy` against a fresh database

Two integration tests (`monitoring/__tests__/timezone-safety.integration.test.ts` and its `marketing/` sibling) were observed to fail intermittently under full-suite load and pass reliably in isolation — diagnosed as a real test-construction race (Section 27), fixed, and re-verified clean on a subsequent full run.

## 4. Architecture Snapshot

**VERIFIED by direct code inspection.** Next.js 16 (App Router) + React + TypeScript + Tailwind + Prisma + PostgreSQL + Auth.js v5 (JWT sessions, Credentials + optional Google/Facebook OAuth). Two long-lived process roles: `web` (Next.js) and `worker` (`scripts/worker.ts`, calling the same scheduler functions in-process — no queue, no Redis, matching Milestone 8's own architecture decision, unchanged). `render.yaml` defines both services; Postgres itself is provisioned externally (Neon/Supabase recommended, per Milestone 8's research — unchanged). Cloud deployment itself remains **BLOCKED**: no cloud credentials exist in this environment, confirmed by the complete absence of any Render/Neon/Fly credential or CLI session — not re-attempted, per this sub-phase's explicit instruction not to repeat that finding.

## 5. Billing Architecture Audit

**PRODUCTION BLOCKER.** Grepped the entire schema and `src/` tree: there is no `Subscription`, `Payment`, `Invoice`, `PaymentEvent`, or webhook-related model or route anywhere. `User.plan` (`FREE | BASIC | BUSINESS`, an enum with no history table) is the *entire* billing state today — set once at signup (`FREE`) and never programmatically changed anywhere in the current codebase (no code path sets it to `BASIC`/`BUSINESS`). `npm run dev:set-plan` (`scripts/set-user-plan.ts`) exists as a manual developer tool for testing paid-tier behavior locally — it is not a billing integration.

Point-by-point against the brief's Section 5 checklist, all **VERIFIED by inspection**:
- **Where plans are defined**: `src/lib/entitlements/plan-limits.ts` — single source of truth, clean design.
- **Where limits are checked**: `src/lib/entitlements/entitlement-service.ts` (typed getters), consumed by `analysis-usage.ts` and `monitoring/watch.ts`.
- **Where active monitors are counted**: `Watchlist` rows with `monitoringStatus: "ACTIVE"`, counted race-safely under a Postgres advisory lock (`watch.ts`'s `startMonitoring`).
- **Where analysis usage is counted**: `AnalysisUsage` table, same advisory-lock pattern.
- **How expiration works**: `Watchlist.monitoringExpiresAt` + `expireDueWatches()`, called every scheduler tick — real, working, already covered by passing tests.
- **How upgrades/downgrades would change entitlements**: instantly and correctly, *if* `User.plan` changes — every limit read is live, not cached. The gap is entirely upstream: nothing today ever changes `User.plan` in response to a real payment.
- **How cancellations would work**: no concept of "cancellation" exists yet — only `User.plan` reverting to `FREE` would need to happen, which nothing currently triggers.
- **How payment state would be represented**: it wouldn't — there is no field for it.
- **Is the existing schema sufficient for a real billing provider?** Partially: the *entitlement-consumption* side (plan → limits → enforcement) is sufficient and needs no change. The *billing-state* side needs new persistence (Section 7).
- **Webhook idempotency / double-delivery / out-of-order / delay**: **NOT APPLICABLE — no webhook endpoint exists to audit.** Requirements for the future endpoint are specified in Section 8, not implemented.

## 6. Pricing/Entitlement Audit

**PRODUCTION BLOCKER — a real, verified mismatch, not a hypothetical one.**

| Plan | Displayed (`PricingSection.tsx`) | Backend (`plan-limits.ts`) | Match? |
|---|---|---|---|
| Free | 3 unique stores, 1 monitor, 30-day monitoring | `FREE`: `maxUniqueAnalyses=3`, `maxActiveMonitoredStores=1`, `monitoringDurationDays=30` | **Consistent** |
| Pro ($29/mo) | 25 unique stores, 10 monitors, continuous monitoring, "faster crawl cadence" | **No `PRO` tier exists in `PlanTier` at all.** Closest real tier (`BASIC`) has `maxUniqueAnalyses=null` (unlimited, not 25) and `maxActiveMonitoredStores=20` (not 10) | **Mismatch — displayed plan does not exist in the entitlement system** |
| Business ($79/mo) | 50 monitors, "2× daily crawl", CSV & API exports, "advanced analytics", priority processing | `BUSINESS`: `maxActiveMonitoredStores=50` (matches), `maxUniqueAnalyses=null` (not displayed, harmless). No crawl-cadence-by-plan mechanism exists (crawl cadence is driven entirely by `CrawlTier`, watch-based, not plan-based). No CSV export, API access, "advanced analytics" view, or request-priority mechanism exists anywhere in the codebase. | **Partial — the one numeric claim shown (50 stores) matches; every feature claim beyond that does not exist** |
| Agency ($149/mo) | "Multiple projects & team seats", 200+ monitored stores, white-label reports, full API access | **No `AGENCY` tier exists.** No `Organization`/`Team` model exists — `User` has no multi-seat concept at all. No monitor tier exceeds `BUSINESS`'s 50. | **Mismatch — displayed plan does not exist, and its core "team seats" feature has no underlying data model** |

Additionally **VERIFIED**: `PlanLimits.advancedIntelligence` and `PlanLimits.historicalAccess` are fully plumbed through `hasCapability()` but have **zero call sites anywhere outside `entitlement-service.ts` and its own tests** — confirmed by a repository-wide grep. They are live, tested, correctly-designed capability flags that currently gate nothing. Not a bug (nothing claims to be gated by them), but worth stating precisely: the "Advanced Intelligence" language on the pricing page has no enforcement behind it either way.

**No pricing change was made.** Per the brief's explicit instruction, this is a correctness finding for a human/business decision (Section 26), not something to redesign here. The two honest resolution paths — collapse the displayed tiers to match `FREE`/`BASIC`/`BUSINESS`, or build out real `PRO`/`AGENCY` tiers and a team/seat model to match what's displayed — are structurally very different amounts of work, and picking between them is exactly the kind of decision this audit exists to surface, not make.

## 7. Payment State Machine

**Designed, not implemented**, per the brief's explicit instruction.

```
anonymous → signup → free account (EXISTS TODAY: User.plan = FREE)
  → checkout (DOES NOT EXIST)
  → payment pending (DOES NOT EXIST)
  → payment successful (DOES NOT EXIST)
  → subscription active (PARTIALLY EXISTS: User.plan = BASIC would grant it,
      nothing sets this today)
  → recurring billing (DOES NOT EXIST — no state tracks renewal)
  → payment failed / grace period (DOES NOT EXIST)
  → cancelled (DOES NOT EXIST)
  → expired (PARTIALLY ANALOGOUS: Watchlist's own expiry mechanism exists,
      but that is monitoring-expiry, not plan/subscription-expiry — a
      different concept that happens to look similar)
```

**Recommended minimal persistence** (not created this sub-phase): a single new `Subscription` table (`userId`, `provider` free-text — mirrors the existing `AdObservation.source`/`StorefrontReviewObservation.source` convention of free-text vendor identifiers rather than an enum, so a second provider is additive — `providerSubscriptionId`, `status` enum mirroring the lifecycle above, `currentPeriodEnd`, `cancelAtPeriodEnd boolean`), plus a `PaymentEvent` append-only table (mirrors this codebase's own established `Event`/`Crawl` pattern — one row per received webhook, for idempotency and audit, never updated) — **not** a redesign of `User`. `User.plan` stays as the fast-path enum every entitlement check already reads; a `Subscription` row is the source of truth that *sets* it, exactly the same relationship `Watchlist` already has to `Store.tier` (a derived, denormalized field kept in sync by a service function, never written directly elsewhere — `recomputeStoreTier()` is the precedent to follow). No existing table needs to change. This is a genuine schema addition, not something achievable by extending `User` alone, because payment history and idempotent webhook processing both require their own rows, not scalar fields.

## 8. Webhook Security

**NOT APPLICABLE today (no endpoint exists) — requirements documented for the future one.** Every item the brief asked about has a concrete, specifiable answer even without a provider chosen:

- **Signature verification**: mandatory, provider-specific (Stripe: `Stripe-Signature` header + webhook signing secret; Paddle: `Paddle-Signature` header). Must reject unsigned/invalid requests before touching the database.
- **Idempotency/deduplication**: the `PaymentEvent` table's own provider event ID as a unique constraint (identical pattern to `Event.dedupeKey` and `AdObservation`'s `(storeId, platform, externalAdId)` uniqueness already proven in this codebase) — a re-delivered webhook upserts into a row that already exists and no-ops, never double-applies a plan change.
- **Replay/timestamp validation**: reject events older than a short window (both Stripe and Paddle SDKs support this natively) — prevents a captured, old, valid-signature payload from being replayed.
- **Raw-body requirement**: signature verification requires the *raw*, unparsed request body — Next.js Route Handlers must read `req.text()`, not `req.json()`, before verifying, or the signature check is comparing against a re-serialized (and therefore different) body.
- **Out-of-order delivery**: handled by making every transition idempotent and driven by the event's own `type` + the provider's own current-state fields, not by assuming events arrive in the order they were generated — e.g., a `subscription.updated` event should read and apply the subscription's *current* state from the payload, not increment/decrement from an assumed prior state.
- **Delayed webhook after synchronous "success"**: the checkout return URL must show a pending/processing state, not an immediate "you're on BASIC now" — the webhook, not the redirect, is the only trustworthy signal that payment actually completed. This is a real design requirement for whichever provider is chosen, not implementable generically today.
- **Secret management**: webhook signing secret follows the exact same pattern already established for `SCHEDULER_SECRET` (env var, never committed, `sync: false` in `render.yaml`) — no new pattern needed.

Nothing here was implemented. Per the brief's Section 20: **no fake "successful payment" behavior was created.**

## 9. Account Lifecycle

**VERIFIED, mostly solid, two real gaps.**

- **Signup/login/logout**: real, working, race-safe (unique-constraint-based duplicate-email handling, confirmed in `signup/route.ts`), rate-limited (10/min/IP).
- **Session persistence**: JWT strategy — **a previously-documented, accepted tradeoff** (Auth.js's Credentials provider is incompatible with database sessions), re-confirmed unchanged. Real, known cost: no instant server-side "sign out everywhere" — a JWT remains valid until it expires, not until revoked. Worth restating precisely for this audit's purposes: if a paid user's account is ever compromised or needs emergency lockout, this is the mechanism that would need to exist and currently doesn't.
- **Password/account recovery**: **does not exist.** Grepped the entire `src/` tree for any forgot-password/reset-password code — none found.
- **OAuth**: real, correctly gated on env-var presence (`configuredProviders`), no dangerous auto-linking (explicitly disabled by design, confirmed in `auth.ts`'s own comment).
- **Account deletion / data deletion**: **does not exist.** No route, no server action, nothing.
- **Store ownership / claiming / multiple stores**: `AnalysisUsage`/`Watchlist` are both scoped by `(userId, storeId)`, and every route (`dashboard/stores/[domain]/page.tsx`, `watch/route.ts`) derives `userId` from the server-side session (`getCurrentUser()`), never from a client-supplied value — **confirmed by direct code inspection, no vulnerability found.** Multiple users can independently watch/analyze the same store (by design — `Store` rows are shared, `AnalysisUsage`/`Watchlist` rows are per-user) with no cross-contamination: User A's `Watchlist`/`AnalysisUsage` rows are unreachable from User B's session.
- **Can User A ever access User B's store?** No evidence found of this. "Store" data itself is intentionally shared/global (the whole point of a shared intelligence corpus), but every *user-scoped* concept (analysis credit, monitoring) is correctly isolated.
- **Can an expired user continue monitoring?** No — `expireDueWatches()` runs every scheduler tick and is already covered by passing tests.
- **Can a deleted user continue consuming scheduler resources?** **UNVERIFIED in the literal sense that user deletion doesn't exist to test** — but by construction, `Watchlist`/`AnalysisUsage`/`Session`/`Account` all cascade-delete on `User` deletion (`onDelete: Cascade`, confirmed in schema), so if a deletion route were built using a plain `prisma.user.delete()`, monitoring would stop correctly as a side effect of the FK cascade. This is a real, positive finding: the schema is already deletion-safe, even though no deletion *feature* exists yet.
- **Race conditions on entitlement limits**: **VERIFIED safe** — both `recordAnalysisUsage()` and `startMonitoring()` use `pg_advisory_xact_lock` scoped to the user, confirmed by reading the code directly; this is the same pattern Milestone 8's own concurrent-worker validation already exercised successfully for the scheduler's claim mechanism.

## 10. Abuse/Ratelimit Audit

**READY for current (single-instance) scale, with self-documented limitations.**

- **`/api/analyze`** (the most expensive endpoint — triggers a real outbound crawl): rate-limited to 5/min/IP, **confirmed** by direct code inspection. Anonymous callers are permitted (by design, for the shared corpus) — the IP rate limit is the *only* protection against anonymous abuse.
- **`/api/store/[domain]/watch`**: 20/min/IP.
- **`/api/auth/signup`**: 10/min/IP.
- **`/api/store/[domain]/growth`** and siblings: 30/min/IP.
- **SSRF**: allowlist-based (`checkUrlIsSafeToFetch`), re-confirmed unchanged this sub-phase — rejects private/loopback/link-local ranges by construction (an address is safe only if `ipaddr.js` classifies it `unicast`), re-validated on every redirect hop. Not re-tested exhaustively this pass (already covered by 25 passing unit tests, re-run clean this sub-phase).
- **Huge catalogs / slow stores**: bounded by existing `maxPages`/`pageSize`/timeout/response-size-cap constants in `crawl/shopify.ts` — unchanged, already covered by passing tests.
- **The one real, self-documented limitation**: `checkRateLimit()`'s own header comment states plainly that it is in-memory, single-process, and **not safe across multiple instances** — N horizontal instances multiply the effective limit by N. This was already known and documented before this sub-phase; re-confirmed accurate and unchanged. It becomes relevant the moment the `web` service is scaled beyond one instance, which a real paid customer base would eventually require.
- **Signup abuse / free-plan farming**: rate-limited by IP only — a motivated abuser with many IPs could still create unlimited FREE accounts. No email-verification gate exists to raise this cost. Not a blocker for launch, worth listing as a real, known gap.

**Recommendation, per the brief's "smallest protection that fits"**: none needed before initial launch. The single-process limiter is adequate until the web service is horizontally scaled — at that point, and not before, a shared store (which could be as small as one new Postgres-backed rate-limit table, not necessarily Redis) becomes necessary. Do not add Redis now.

## 11. Worker/Scheduler Audit

**PREVIOUSLY VERIFIED, re-confirmed unchanged.** `SELECT ... FOR UPDATE SKIP LOCKED` claim mechanism (`claimDueStores`), stale-claim recovery via the `CLAIM_TIMEOUT_MS` window, one-batch-at-a-time sequential processing (a single store crawl failure can't take down the batch — confirmed directly in `runSchedulerTick`'s own try/catch), graceful handling of an unexpected exception mid-batch. Concurrent-worker safety, PostgreSQL crash/recovery, and mixed-success/failure batch handling were **PREVIOUSLY VERIFIED** in Milestone 8 Sub-phase D and **not re-tested this sub-phase**, per the brief's explicit instruction not to repeat that work absent a code change — none occurred in this area. **No remaining production gap was found in this audit area.**

## 12. Database Audit

**READY, one real gap: no retention policy.**

- Migrations: 11 total, all additive, all clean against a fresh database this sub-phase (re-verified).
- Indexes: every index added across Milestones 7–9 carries a query-justification comment in the schema itself (confirmed by reading the full schema) — no speculative indexes found, none added this sub-phase beyond what Milestone 9 Sub-phase F already justified with real `EXPLAIN ANALYZE` evidence.
- Foreign keys / cascade behavior: consistently `onDelete: Cascade` for owned child rows (`Product`→`Store`, `Watchlist`→`User`/`Store`, etc.) and `onDelete: SetNull` for the one genuinely optional reference (`AdObservation.matchedProduct`) — a deliberate, correct distinction, not an oversight.
- Connection pooling: not configured anywhere in this codebase (Prisma's own default pool) — the existing production research already recommends a pooled managed-Postgres provider (Neon/Supabase) specifically so the application doesn't need to manage this itself; unchanged, not re-litigated here.
- **Retention: genuinely absent.** Grepped for any deletion/cleanup/retention logic — none exists. `Crawl`, `Event`, `ProductStateSnapshot`, `StorefrontReviewObservation`, `MarketingCollectionRun`, and `AdObservation` are all append-only-forever today, exactly as their own design comments say ("Event is append-only and immutable. Never UPDATE, never DELETE.") — a deliberate design choice for *event* semantics, but with no corresponding retention/archival plan for when the corpus is large. This is not urgent at current (near-zero real user) scale, but is a real, identifiable future cost: unbounded storage growth with no automated mitigation. **Recommendation, not implemented**: a future retention pass should target `ProductStateSnapshot` and `StorefrontReviewObservation` rows older than N months for stores with no active `Watchlist` entry (the intelligence value of a competitor's price history from years ago, for a store nobody is watching, is low) — this is a genuine engineering task for a *later* sub-phase, not something to build speculatively now.

## 13. Data Retention Audit

See Section 12 for the mechanism gap. Categorized here per the brief's own taxonomy:

| Category | Retained today | Why | Should it be deletable on request? |
|---|---|---|---|
| Crawl/Product/Event data | Forever, no policy | Core product value (history) | Not personal data — no |
| Store data | Forever | Shared corpus | No — not user-specific |
| Review observations | Forever | Same as above | No |
| Marketing/ad observations | Forever | Same as above | No |
| Account data (User) | Forever, no deletion path | — | **Yes — currently cannot be honored (Section 9)** |
| Auth data (Session/Account) | Cascade-deletes with User | — | Yes, and already correctly wired via FK cascade |
| Payment data | N/A — doesn't exist yet | — | Would need explicit design once billing exists |

## 14. Privacy/Data Classification

Per-category, distinguishing engineering fact from legal judgment as the brief requires:

- **ACCOUNT DATA** (`User`: email, name, password hash): contains personal data. **ENGINEERING FACT**: password is bcrypt-hashed, never logged or exposed (re-confirmed by this session's own logging grep). **LEGAL REVIEW REQUIRED**: whether email/name retention, and the current absence of a deletion path, satisfies applicable data-protection obligations for Bellwether's actual customer base and operating jurisdiction — not something this audit can determine.
- **STORE/PRODUCT/CRAWL/ACTIVITY/MARKETING/REVIEW DATA**: all describe *merchants'* publicly-published storefronts, not Bellwether's own end users. **ENGINEERING FACT**: no reviewer names, emails, or free-text review content are stored (Milestone 9's own explicit design decision, re-confirmed unchanged — `StorefrontReviewObservation` has no PII columns). **LEGAL REVIEW REQUIRED**: whether crawling and redistributing publicly-observable competitor storefront data as a commercial product raises any claim beyond what Milestone 4/9's own prior ToS/robots research already covered — not re-litigated here.
- **AUTH DATA**: standard Auth.js shape, industry-standard handling, cascades correctly on deletion.
- **PAYMENT DATA**: does not exist yet. **LEGAL REVIEW REQUIRED** before it does: PCI-DSS scope is a primary reason to prefer a provider-hosted checkout (Stripe Checkout / Paddle Checkout) over collecting card details directly — this codebase currently does neither, which is the *safe* default to preserve.

## 15. Product Claims Audit

**Clean — re-confirmed, no new issue found.** Grepped all UI copy for sales/revenue/customer/order/conversion/accuracy language. Every real match is either an already-correct disclaimer ("not independently verified sales data," "Catalog growth is not the same as business growth") or an out-of-scope code comment. No instance of "bestseller movement = sales growth" or similar exists anywhere. The one real gap in this area isn't a false *claim* — it's an **absent** one: the footer's "Privacy," "Terms," "How we collect data," and "Support" links are all literal `href="#"` (verified directly in `SiteFooter.tsx`) — the pages they promise do not exist. **LEGAL REVIEW REQUIRED**, and **PRODUCTION BLOCKER for any paid launch**: a SaaS product cannot responsibly accept payment while advertising legal pages that don't exist.

## 16. Environment Variable Audit

**VERIFIED against actual `process.env.*` usage in `src/` and `scripts/`.**

| Variable | Required by | Web/Worker/Both | Secret? | Default? | Production required? | Documented? |
|---|---|---|---|---|---|---|
| `DATABASE_URL` | Prisma, everywhere | Both | Yes | No | Yes | Yes |
| `AUTH_SECRET` | Auth.js (implicit) | Web | Yes | No | Yes | Yes |
| `AUTH_TRUST_HOST` | Auth.js core (implicit) | Web | No | No | **Yes** (non-Vercel host) | Yes |
| `SCHEDULER_SECRET` | `/api/internal/scheduler/{tick,marketing-tick}` | Web (worker calls functions directly, bypasses this) | Yes | No | Only if HTTP routes are used | Yes |
| `SERPAPI_API_KEY` | `marketing/source-factory.ts` | Worker (+Web if manual trigger used) | Yes | No | Only if marketing collection is enabled | Yes |
| `GOOGLE_CLIENT_ID` / `_SECRET` | `auth.ts` | Web | ID: no / Secret: yes | No (feature no-ops if absent) | No | Yes |
| `FACEBOOK_CLIENT_ID` / `_SECRET` | `auth.ts` | Web | ID: no / Secret: yes | No (feature no-ops if absent) | No | Yes |
| `NODE_ENV` | Platform-managed, `db/prisma.ts` | Both | No | Set by platform | Yes | Yes |

**No new variable was found undocumented.** This table matches `docs/environment-variables.md` exactly — confirmed by re-reading both the doc and the actual code this sub-phase, not merely trusting the doc's own prior claim. **Future billing variables** (not yet needed): a webhook signing secret and an API key, whichever provider is chosen — same `sync: false` pattern as `SCHEDULER_SECRET`, no new mechanism required.

## 17. Deployment Audit

Per the brief's exact A–E categories:

- **(A) Can be done locally**: fixing the pricing/entitlement mismatch (a product decision + code change); building Terms/Privacy pages (once legal content exists); building account deletion/password reset; designing (not shipping) the billing schema; adding a minimum logging convention.
- **(B) Requires staging credentials**: real end-to-end verification of the deployed web+worker split, real OAuth callback URLs, real managed-Postgres behavior under real network conditions. **BLOCKED** — no staging credentials exist in this environment (pre-established, not re-attempted).
- **(C) Requires billing provider credentials**: any real checkout, webhook, or subscription-state test. **BLOCKED** — no Stripe/Paddle account exists.
- **(D) Requires business/legal decision**: which billing provider; which of the two pricing-mismatch resolution paths (Section 6); Terms/Privacy content; whether Bangladesh-based-operator constraints (Section 24) rule out one provider outright.
- **(E) Requires human action**: registering a business entity with a chosen billing provider; drafting/approving legal copy; provisioning staging infrastructure.

## 18. Customer Journey Audit

| Step | Route | Mutation | Entitlement check | Failure state | Status |
|---|---|---|---|---|---|
| Landing → analyze | `POST /api/analyze` | `Crawl`, `Product`, etc. | Pre-check + authoritative post-crawl check (`recordAnalysisUsage`) | SSE `error` event, curated message | **VERIFIED working** |
| Signup | `POST /api/auth/signup` | `User` created | None | 400/409 JSON | **VERIFIED working** |
| Login | Auth.js credentials/OAuth callback | `Session`/JWT issued | None | Auth.js standard error | **VERIFIED working** |
| Store Intelligence view | `dashboard/stores/[domain]/page.tsx` | None (read) | `hasAnalyzedStore` gate | "Analyze this store" CTA if not yet analyzed | **VERIFIED working** |
| Monitoring CTA | `POST /api/store/[domain]/watch` | `Watchlist` upsert | `startMonitoring` limit check | Inline error, **no upgrade link** (minor gap) | **VERIFIED working, minor UX gap** |
| **Checkout** | **does not exist** | — | — | — | **MISSING — Section 5/7** |
| **Subscription activation** | **does not exist** | — | — | — | **MISSING** |
| Scheduled crawl / updated intelligence | Worker → `runScheduledCrawl` | `Crawl`, diff, events | N/A (system-triggered) | Failure backoff, already tested | **PREVIOUSLY VERIFIED** |
| **Upgrade** | **does not exist as a real flow** — pricing buttons show a toast only | — | — | — | **MISSING** |
| **Cancellation** | **does not exist** | — | — | — | **MISSING** |

The gap is precisely and only at the payment boundary — everything before and after it is real, tested, working infrastructure.

## 19. Failure-State Matrix

| Failure | Current behavior | Adequate? |
|---|---|---|
| Crawl target unreachable/blocked | Classified, honest user-facing message, credit not spent | Yes |
| Scheduler store claim during outage | `FOR UPDATE SKIP LOCKED` + claim timeout — self-heals | Yes (previously verified) |
| One store's crawl throws unexpectedly | Caught, logged, batch continues | Yes |
| Concurrent entitlement check | Advisory-lock serialized | Yes |
| Webhook arrives twice / delayed / out of order | N/A — no webhook exists | Design specified (Section 8), not built |
| Payment succeeds, webhook delayed | N/A | Design requires "pending" UI state (Section 8), not built |
| User deleted mid-monitoring | Cascade-deletes cleanly (schema-verified, feature doesn't exist to trigger it yet) | Schema-ready |

## 20. Security Boundaries

**No vulnerability found this sub-phase.** Specifically checked and found intact: session-derived (never client-supplied) user identity on every protected route; SSRF allowlist; race-safe entitlement counters; no cross-user data access path; no secret or credential found in logs (5 total `console.*` call sites, all reviewed, none logs a secret, token, or payment detail — because none exists yet to leak).

## 21. Production Monitoring Requirements

**RESEARCH REQUIRED / not yet chosen.** Today: zero structured logging, zero metrics, zero alerting — only bare `console.error` in 5 files, visible solely through whatever the hosting platform's own log viewer captures. **Minimum V1 stack, recommended not built**: (1) a hosted error-tracking service (e.g., Sentry's free/starter tier) wired into the existing `console.error` call sites plus Next.js's own error boundary — the smallest real improvement over "nothing," (2) the hosting platform's own log retention (Render provides this natively) as the baseline, (3) one external uptime check against `/` (already the configured `healthCheckPath`). Explicitly **not recommended**: a dedicated observability platform, custom metrics pipeline, or log-aggregation service before there is real production traffic to justify the cost.

## 22. Logging Requirements

Per the brief's LOGGED/METRIC/ALERTED/IGNORED taxonomy:

| Event | Treatment |
|---|---|
| Analysis crash (`api/analyze`) | LOGGED (already, via `console.error`) → should become ALERTED once error tracking exists |
| Scheduler tick unexpected exception | LOGGED (already) → METRIC (failure rate over time) worth adding once traffic exists |
| Vendor API failure (SerpApi) | Already recorded as data (`MarketingCollectionRun.outcome=UNAVAILABLE`) — this is the *correct* pattern, a durable record, not just a log line |
| Webhook failure (future) | Must be LOGGED + ALERTED — a missed webhook is a billing-correctness incident |
| Migration failure | Render's own `preDeployCommand` failing blocks the deploy — already a hard stop by construction, no extra tooling needed |

**Confirmed no secrets, tokens, or payment data in any current log call** — verified directly, not assumed.

## 23. Alerting Requirements

None exist today; none are urgent at current scale. The one item worth flagging as **genuinely time-sensitive once billing exists**: a failed/undelivered webhook must alert a human, not just log — a silent billing-webhook failure directly risks free access to paid features (Section 24's STOP-condition list explicitly calls this out) or incorrectly cutting off a paying customer.

## 24. Billing Provider Comparison

**RESEARCH REQUIRED for final confirmation — preliminary desk research only, no credentials used or available.**

| Factor | Stripe | Paddle |
|---|---|---|
| Bangladesh as merchant/seller country | **Found NOT supported as a direct-merchant country as of 2026** (Bangladesh listed as a "Preview" tier — technically reachable but payouts may be paused without notice) — sourced from third-party aggregator summaries, **not independently confirmed against Stripe's own primary documentation this sub-phase** | **Bangladesh appears in Paddle's own supported-countries listing** (confirmed via a direct fetch of `developer.paddle.com`'s supported-countries page) — **but that specific page did not clearly distinguish seller/merchant eligibility from buyer/customer support**, so this remains a real, open question, not a confirmed green light |
| Model | Direct payment processor — the business itself is the merchant of record, responsible for its own tax/VAT collection and remittance | **Merchant of Record (MoR)** — Paddle is the legal seller; it handles global tax/VAT calculation and remittance on the business's behalf |
| Why the MoR distinction matters here | A direct-processor model requires the underlying business to be eligible as a merchant in its own country — the exact requirement Bangladesh appears to fail for Stripe | An MoR's country restrictions are typically about where it can pay out *to*, a structurally different (often more permissive) question than direct merchant eligibility — this is *why* Paddle/similar MoR platforms are generally the more realistic path for an operator based somewhere a direct processor doesn't support, not just an alternative preference |
| Implementation complexity | Lower-level, more control, more of the tax/compliance burden falls on the business | Higher-level, Paddle owns tax/VAT/invoicing/chargebacks, less code, less compliance surface for the business to own |
| Webhook reliability | Mature, well-documented, industry-standard | Mature, well-documented, industry-standard |
| Checkout UX / customer portal | Both offer hosted checkout + a customer self-service portal (subscription management, invoices) — roughly comparable |
| Refunds/chargebacks | Business's own responsibility to manage | Paddle handles chargeback response as the merchant of record |

**Conclusion, evidence-based, not a recommendation to commit funds or sign up**: given a Bangladesh-based operator, **Paddle (or another Merchant-of-Record platform) is the structurally more promising path**, but this is a preliminary finding from public documentation and secondary sources, not a verified account-eligibility result. **RESEARCH REQUIRED, human action needed**: attempt real seller onboarding (or contact Paddle's sales/support directly) with the business's actual registration details before committing any engineering effort to a specific provider's SDK.

## 25. Required Credentials

Not fabricated, not assumed present: a Paddle or Stripe merchant/seller account (**BLOCKED** — none exists); staging cloud credentials for Render/Neon (**BLOCKED**, pre-established); a real Google/Facebook OAuth app with production callback URLs, only if OAuth login is desired at launch (**OPTIONAL** — Credentials-only launch works today without them).

## 26. Required Human Decisions

1. Which pricing-mismatch resolution path (Section 6): shrink the displayed tiers to match the code, or build out the code to match the displayed tiers.
2. Which billing provider, after real (not desk-research) eligibility confirmation (Section 24).
3. Terms of Service / Privacy Policy content — this audit does not draft legal language, per its own explicit instruction.
4. Whether email verification is required before granting FREE-tier access (currently: not required).
5. Whether OAuth (Google/Facebook) is a launch requirement or a fast-follow.

## 27. Required Engineering Changes

**Made this sub-phase** (both small, both verified, neither behavioral in the product sense):
1. Removed a duplicated comment block in `src/app/api/analyze/route.ts` (pure cleanup, zero logic change).
2. Fixed a real test-construction timing race in `monitoring/__tests__/timezone-safety.integration.test.ts` and its `marketing/` sibling — the third test in each relied on the schema's bare `@default(now())` with no safety margin against a separately-captured `new Date()`, occasionally inverting under full-suite load; fixed by applying the same explicit-backdate pattern the adjacent, already-reliable test in the same file already uses. Re-verified: the full 235-test integration suite now passes cleanly, twice in a row.

**Not made, explicitly deferred to a real Sub-phase B/decision point**: any billing schema, webhook route, pricing UI change, Terms/Privacy page, account-deletion route, or password-reset flow. All are real, identified gaps — none were built speculatively this sub-phase, per its own explicit "audit, don't build" mandate.

## 28. Changes That Should NOT Be Made

Redis, a queue, a second worker process, Kubernetes, a new intelligence source, revenue/traffic/velocity estimation, a custom observability platform before real traffic exists, an in-house payment processor (build on Stripe/Paddle, don't reinvent PCI compliance), any change to the JWT session-strategy tradeoff without a concrete incident driving it, and — per the brief's own framing — do not pick a billing provider and start integrating before Section 24's Bangladesh-eligibility question is actually resolved with a real account, not desk research.

## 29. Launch Blockers

In order of severity:

1. **No billing infrastructure** (Section 5) — cannot accept payment at all.
2. **Pricing/backend mismatch** (Section 6) — cannot honestly sell what's displayed today.
3. **No Terms/Privacy pages** (Section 15) — cannot responsibly launch a paid product with placeholder legal links.
4. **No account deletion** (Section 9) — a real gap for any product handling account data, independent of billing.

None of these are cloud-credential-blocked — all four are addressable with decisions and code that can happen entirely in this environment, ahead of any staging/billing credential becoming available.

## 30. Pre-Staging Checklist

- [ ] Resolve the pricing/backend mismatch (decision + code)
- [ ] Draft and publish Terms of Service and Privacy Policy (content, not code)
- [ ] Build account deletion (schema already supports it cleanly)
- [ ] Build password reset (does not exist)
- [ ] Choose and document the minimum logging/error-tracking approach (Section 21)

## 31. Pre-Payment Checklist

- [ ] Confirm real billing-provider seller eligibility for the actual operating entity (Section 24) — not desk research
- [ ] Design and migrate the `Subscription`/`PaymentEvent` schema (Section 7)
- [ ] Build the webhook endpoint per Section 8's requirements, with real provider credentials in a real sandbox
- [ ] Build the checkout → pending → active flow, including the "payment succeeded but webhook delayed" UI state
- [ ] Legal review of payment/refund/cancellation terms

## 32. Pre-Production Checklist

- [ ] Real staging deployment exercised end to end (currently credential-blocked)
- [ ] Real OAuth production app + callback URLs, if launching with OAuth
- [ ] Minimum monitoring stack live (Section 21)
- [ ] A documented incident-response step for a missed/failed billing webhook (Section 23)

## 33. Known Unknowns

- Real Stripe/Paddle seller eligibility for the actual business entity (Section 24) — genuinely unknown until attempted for real.
- Real production traffic/cost patterns — nothing here simulates or estimates them.
- Whether the current in-memory rate limiter's single-instance assumption will need revisiting before or after the billing gaps are closed — depends on real growth, not predictable from this audit.

## 34. STOP Conditions

Evaluated against the brief's explicit list — **none were triggered**: no authorization vulnerability, no entitlement bypass, no billing-state inconsistency (there is no billing state to be inconsistent), no user-to-user data leakage, no SSRF regression, no payment-webhook flaw (nothing exists to flaw), no destructive migration, no unsafe account-deletion behavior (none exists; the schema is deletion-safe by construction whenever it's built), no unbounded production query, no unbounded crawler behavior, no worker duplication/corruption, no production crash affecting the core report, no secret exposed in source or logs. The pricing/backend mismatch (Section 6) was considered against "billing-state inconsistency that could give free paid features" specifically — it does **not** trigger that condition, because no real billing exists yet to be inconsistent; it is a *marketing-accuracy* risk, not a live financial-loss risk, and is documented plainly rather than silently fixed by (for example) unilaterally rewriting the pricing page's numbers.

## 35. Final Recommendation

**B — MORE RESEARCH REQUIRED**, specifically and narrowly: real billing-provider eligibility confirmation (Section 24) and the human pricing decision (Section 26, item 1). Everything else this audit found is either already fine (the core product, auth, entitlement enforcement, the scheduler) or a well-scoped, buildable engineering task with no external dependency (Terms/Privacy content aside, which needs human-authored legal copy, not more research).

This is deliberately **not** "E — READY FOR STAGING": the application building and passing tests locally is necessary but not sufficient, per the brief's own explicit instruction not to select that option on that basis alone. It is **not** "C — PRODUCTION BLOCKED" either: nothing found here is an architectural dead end — every gap has a clear, scoped, buildable resolution once the two research/decision items above are settled.

## 36. Exact Recommended Sub-phase B Scope

1. Resolve the pricing/backend mismatch (Section 6) — a decision, then a small, focused code change (either shrink `PricingSection.tsx`'s tiers to match `plan-limits.ts`, or extend `plan-limits.ts` to real `PRO`/`AGENCY` tiers — not both, and not decided by this sub-phase).
2. Build account deletion and password reset (Section 9) — both well-scoped, no external dependency, the schema already supports them.
3. Publish real Terms of Service / Privacy Policy pages once content exists (content is a human/legal task; wiring the pages is trivial).
4. Design (schema only, still not "go live") the `Subscription`/`PaymentEvent` tables per Section 7, so the moment a billing provider is confirmed eligible, implementation can start immediately without a design phase blocking it.
5. **Do not** attempt real billing integration until Section 24's eligibility question has a real, human-verified answer — attempting to integrate a provider before confirming the business can actually use it risks wasted engineering effort on a dead end.

---

## Evidence appendix

**Files inspected** (partial list, non-exhaustive — every file cited by path above was directly read or grepped this sub-phase): `prisma/schema.prisma` (full), `src/lib/entitlements/{plan-limits,analysis-usage,entitlement-service}.ts`, `src/lib/monitoring/{watch,scheduler}.ts`, `src/lib/auth/{auth,session}.ts`, `src/app/api/auth/signup/route.ts`, `src/app/api/analyze/route.ts`, `src/app/api/store/[domain]/watch/route.ts`, `src/app/page.tsx`, `src/components/marketing/{PricingSection,SiteFooter}.tsx`, `src/components/dashboard/MonitorButton.tsx`, `src/lib/security/rate-limit.ts`, `render.yaml`, `.env.example`, `docs/environment-variables.md`, `package.json`, and a repository-wide grep for account-deletion/password-reset code, console logging, retention/cleanup logic, and overclaiming UI language.

**Files changed**: `src/app/api/analyze/route.ts` (duplicated comment removed), `src/lib/monitoring/__tests__/timezone-safety.integration.test.ts` and `src/lib/marketing/__tests__/timezone-safety.integration.test.ts` (test-timing race fixed).

**Files created**: this document only.

**Schema changes**: none.

**Dependencies changed**: none.

**Tests**: 352/352 unit, 235/235 integration (both re-run fresh this sub-phase against a real, freshly-migrated disposable Postgres instance), `tsc --noEmit` clean, `eslint .` clean, `next build` clean.

**Tests failed**: 2, transiently, during the first full-suite run this sub-phase — both diagnosed as a test-construction timing race (not a production code defect), fixed, and re-verified passing on a subsequent full run.

**Production blockers**: no billing infrastructure; pricing/backend mismatch; no Terms/Privacy pages; no account deletion.

**Credential blockers**: cloud staging deployment; real billing-provider account/eligibility confirmation; production OAuth apps (optional).

**Business/legal blockers**: which pricing-resolution path; which billing provider; Terms/Privacy content; email-verification policy.

**Exact recommendation for Milestone 10 Sub-phase B**: see Section 36. Do not begin it automatically — this sub-phase stops here, as instructed.
