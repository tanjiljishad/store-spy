# Milestone 11 — Completion report

Covers all three phases of `docs/milestone-11-security-rbac-promos.md`: Phase 1 (Security
hardening), Phase 2 (Admin RBAC), and Phase 3 (Promo codes and checkout, including the
post-Phase-2 subscription-expiry amendment).

---

# Phase 1 — Security hardening

## Gate status

- `npx tsc --noEmit`: clean.
- `npm run lint`: clean.
- `npm test` (unit): **417 passed**, 0 failed, across 39 files.
- `npm run test:integration` (real Postgres, `.env.test`): **242 passed, 2 skipped**, 0
  failed, across 37 files. The 2 skips are pre-existing dead coverage — see "Pre-existing
  issues" below, not new work.
- Live-verified against the running dev server (not just tests): signup with the new
  password policy (weak password rejected 400, strong one accepted 201), credentials
  login, `POST /api/analyze` end-to-end against two real external Shopify stores
  (fashionnova.com — 15,000 products — and allbirds.com, both through the new pinned-fetch
  default), anonymous 401s on `/api/analyze` and `/api/store/[domain]/events`, and security
  headers present on both a page and an API response.

## What changed, item by item

**1.1 — Client IP extraction (`src/lib/security/rate-limit.ts`)**
`getClientIp()` used to trust the *first* `x-forwarded-for` entry — attacker-controlled. It
now reads `TRUSTED_PROXY_HOPS` (new env var, default `1` for Render's one proxy) and counts
that many entries in from the *right*, the only part of the header a client can't forge.
`x-real-ip` is no longer consulted at all. New pure parser `extractClientIp()`, directly
unit-tested (single IP, spoofed prefix, malformed entries, IPv6, hop counts 0/1/2, short
list). `TRUSTED_PROXY_HOPS` documented in `.env.example`, `docs/environment-variables.md`,
and set in `render.yaml`.

**1.2 — Credentials login throttle**
New `LoginAttempt` table (migration below), `src/lib/security/login-policy.ts` (pure:
progressive delay from 5 email failures, hard lock at 10 email failures or 30 IP failures,
all within a 15-minute window — the window itself is what releases the lock, no separate
"lockedUntil" field), `src/lib/security/login-throttle.ts` (Prisma-backed counting), and
`src/lib/auth/authorize-credentials.ts` (the throttle-check → verify → record sequence,
factored out of `auth.ts`'s `authorize()` the same way `verify-credentials.ts` already was,
so it's directly integration-testable). A locked account returns `null` — byte-identical to
a wrong password, never a distinguishable error. `POST /api/auth/callback/credentials` also
gets a 10/minute-per-IP in-memory limiter in front of Auth.js itself (the NextAuth catch-all
route's `POST` is now wrapped; `GET` is untouched). `LoginAttempt` rows older than 24h are
swept in the worker tick (`scripts/worker.ts`, next to `sweepStaleCrawls`).

**1.3 — Store sub-route access gate**
New `src/lib/auth/store-access.ts` — `resolveStoreAccess()` is now the single definition of
`"full" | "unanalyzed_preview" | "anonymous_preview"`, reusing `hasAnalyzedStore()` rather
than reimplementing it. `report/route.ts` was refactored onto it; `events`, `activity`,
`growth`, and `marketing` (previously **wide open** — no `getCurrentUser()` call at all) now
require `access === "full"`, returning `401` anonymous / `403 {code: "STORE_NOT_ANALYZED"}`
signed-in-but-unanalyzed, all-or-nothing. Rate-limit key is now `userId` when signed in,
falling back to IP only when anonymous. The client components that read these endpoints
(`ChangeFeedTimeline`, `StoreActivitySummary`, `GrowthIntelligence`, `AdvertisingSummary`)
already treated any non-OK response as a silent no-render — no error panel existed to update
for the new 401/403.

**1.4 — Unauthenticated crawl trigger**
`POST /api/analyze` now requires a signed-in user (`401` otherwise) before it does anything
else. The anonymous-preview report *shape* is untouched in `run-analysis.ts` and stays
reachable via `GET /api/store/[domain]/report` for an already-crawled store — only
*triggering a new crawl* is gated. Added a second, independent rate-limit dimension keyed on
`userId` (10/hour) alongside the existing per-IP one (5/minute).

**1.5 — Unauthenticated writes to `Store`**
`runAnalysis()` used to `upsert()` the `Store` row before the crawl had proven the domain
was even reachable Shopify — every typo'd or non-Shopify domain immediately entered the
scheduler's due-query and stayed there forever. Restructured so the crawl runs first; the
`Store` row (and, since `Crawl.storeId` is `NOT NULL`, the `Crawl` row too) is only written
after `crawlShopifyStore()` returns `status: "ok"`. The dedup check and the entitlement
pre-check were reworked to look up the store by domain first and skip/degrade gracefully
when it doesn't exist yet (see the doc's own instructions — this is exactly what it asked
for, including the accepted narrow race: two simultaneous first-ever requests for the same
brand-new domain aren't deduped, since there's nothing to write a RUNNING marker to yet).

**1.6 — DNS rebinding**
New `src/lib/security/pinned-fetch.ts`. `createPinnedFetch(validatedIps)` builds a fetch
bound to an undici `Agent` whose `connect.lookup` returns only the already-validated
address(es) — no second, independent DNS resolution for a short-TTL rebinding record to win.
`createAutoPinnedFetch()` is the new default `fetchImpl` in `crawl/shopify.ts`'s two entry
points (`crawlShopifyStore`, `fetchProductPageHtml`) whenever the caller hasn't injected one
of their own (i.e. real production use — every existing test injects both `fetchImpl` and
`dnsLookup` together): it resolves and pins fresh for whatever URL it's given, and since
`fetchWithTimeout`'s manual redirect loop already calls the default `fetchImpl` once per hop,
every redirect re-pins for free with no change to that loop. `isPublicUnicast` is now
exported from `ssrf-guard.ts` and reused, not duplicated. Added `undici` as an explicit
dependency (previously only transitive via Next) — its own `fetch`/`Agent` pair is used
together, deliberately not Node's global `fetch` with a `dispatcher` override, to avoid any
cross-version incompatibility. **Live-verified against two real external hosts**, not just
mocks — this is the highest-blast-radius change in the phase (it's the default network path
for the whole crawler) and is the one item where "the tests pass" alone wasn't enough
confidence for me to consider it done.

**1.7 — Security headers**
`next.config.ts` now has a `headers()` block applied to every route: HSTS (2-year max-age,
includeSubDomains, preload), an **enforcing** (not report-only) CSP, `X-Content-Type-Options:
nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, and a
restrictive `Permissions-Policy`. Chose enforcing over report-only because this app has no
inline scripts beyond what Next itself injects (covered by `script-src 'unsafe-inline'`), so
there was nothing a report-only rollout would need to observe first. `style-src
'unsafe-inline'` is included for a checked, not assumed, reason: `GrowthIntelligence.tsx`
and `DetectionLog.tsx` both set dynamic inline `style={{...}}`. No `img-src` override —
grepped `src/` for `next/image`/`data:` image usage and found neither, so `default-src
'self'` already covers it. `connect-src 'self'` was verified live to still allow the SSE
stream on `POST /api/analyze`.

**1.8 — JWT session cost and staleness**
The `jwt` callback used to do a `prisma.user.findUnique()` on *every* authenticated request.
Extracted the whole re-read/TTL/revocation decision into
`src/lib/auth/jwt-plan-refresh.ts` (`refreshJwtToken()`, pure aside from an injected
`readUser` — same testability convention as `authorize-credentials.ts`): a fresh sign-in
always re-reads; otherwise a cached `plan` is trusted for `PLAN_CHECK_TTL_MS` (60s) before
re-reading. New `User.sessionsValidAfter DateTime?` column (migration below): the re-read
path now also rejects (drops `token.id`, collapsing the session to anonymous) any token
whose `iat` predates it — the real "sign out everywhere" / compromised-account kill switch a
JWT-strategy session otherwise can't offer, bounded to a 60-second worst case rather than
instant. Set from Phase 2's admin API (not built this phase) — nothing currently sets this
column, so the mechanism is wired but dormant until Phase 2.

**1.9 — Smaller items**
- **Signup timing**: the 409 (duplicate email) status is kept, but both the `201` and `409`
  outcomes are now padded to the same 400ms minimum response time
  (`respondNoFasterThan()` in `signup/route.ts`), closing the timing side of account
  enumeration. `hashPassword()` already ran unconditionally before either branch, so the
  bcrypt cost was already equal — this closes the remaining DB-round-trip-shaped gap.
  **Accepted residual risk**: the `409` status code itself still lets an attacker enumerate
  which emails exist by status code alone, not just timing — unresolved, called out here
  per the doc's own instruction (removing the 409 without email verification would make the
  UX worse, not the system safer).
- **Password policy**: floor raised from 8 to 10 characters
  (`src/lib/auth/password.ts`). New `src/lib/auth/common-passwords.ts` — a curated,
  roughly-1000-entry blocklist (common base terms + the small set of suffixes real people
  actually append, not a verbatim copy of any single external corpus), checked
  case-insensitively. A password containing the account's own email local-part (3+
  characters, to avoid false-positiving on a 1-2 character local-part) is also rejected. No
  composition rules, per the doc's explicit instruction and NIST SP 800-63B's own guidance
  that they reduce real entropy.
- **Scheduler secret comparison**: new `src/lib/security/constant-time-equal.ts`
  (`crypto.timingSafeEqual`, length-guarded) used by both
  `/api/internal/scheduler/tick` and `.../marketing-tick`. Neither route had any test
  coverage before this phase; both now do.

## Schema — migration `20260819215418_security_hardening`

Generated via `npx prisma migrate dev --name security_hardening` (the doc's suggested name
`20260820_security_hardening` used the project's actual timestamp-prefixed convention
instead — every existing migration in the repo follows that format, and Prisma generates it
automatically). Purely additive:
- `User.sessionsValidAfter DateTime?`
- `model LoginAttempt { id, emailNormalized String?, ipKey String?, succeeded Boolean, createdAt }`
  with `@@index([emailNormalized, createdAt])` and `@@index([ipKey, createdAt])`.

Applied and verified against both the local dev database and a local Postgres standing in
for the (Docker-unavailable-in-this-environment) integration test database.

## New environment variable

`TRUSTED_PROXY_HOPS` — optional, defaults to `1`. Documented in `.env.example`,
`docs/environment-variables.md` (both the main reference table and the process/quick-reference
tables), and set explicitly (not a secret) in `render.yaml`.

## New dependency

`undici@^7.29.0` — added as an explicit dependency for `pinned-fetch.ts`'s `Agent`/`fetch`
pair (previously only available transitively via Next). Not implicated in `npm audit`'s
existing findings, which predate this change.

## Pre-existing issues found during verification (not new Milestone 11 work)

Running the full test suite surfaced repo state that predates this milestone entirely — the
already-uncommitted "freemium redesign" (visible in the original `git status`: `plan-limits.ts`,
`watch.ts`, `scheduler.ts` already modified before Phase 1 work began) had left several tests
stale against source it had already changed:

- **Fixed** (mechanical — aligned test expectations to the plan-limits.ts/watch.ts values
  that were already shipped, uncommitted, before this phase): `analysesLimit`/`limit`
  assertions expecting `3` instead of the current `null` (unlimited) in
  `run-analysis.integration.test.ts`, `dashboard/__tests__/{summary,dashboard-route}.integration.test.ts`,
  and `intelligence/__tests__/report.integration.test.ts`; `monitoringExpiresAt`/`expiresAt`/
  `daysRemaining` assertions expecting a ~30-day FREE expiry instead of the current `null`
  (no expiry) in `watch-route.integration.test.ts` and `summary.integration.test.ts`;
  BASIC's `slotsLimit` expecting `20` instead of the current `10` in
  `summary.integration.test.ts`; a hardcoded past-date literal (`"2026-08-11"`) in
  `activity.integration.test.ts` that had silently drifted outside the 7-day window it was
  testing as real time passed it — replaced with `new Date()`.
- **Skipped, not fixed** (2 tests, `run-analysis.integration.test.ts`): `emitLimitReached()`'s
  `analysis_limit_reached` path is currently unreachable through any real plan — every
  `PlanTier` now has `maxUniqueAnalyses: null`. Rewriting the entitlement model to reintroduce
  a finite limit is a billing decision, out of scope for a security/RBAC/promos milestone;
  left skipped with a comment rather than deleted, so the coverage's intent is preserved for
  whenever a real limited tier exists again.
- **Fixed as a real regression**, not just staleness: `store-routes.integration.test.ts`
  imported the `events`/`activity` route handlers directly without ever mocking session
  state, because before 1.3 those routes had no auth check to mock. Adding one (1.3) broke
  this pre-existing file. Rewrote it to mock `@/lib/auth/session` (same pattern as the new
  `store-access.integration.test.ts`) and updated its assertions for the new 401/403 gate,
  preserving its other coverage (404 ordering, rate limiting, `windowDays` clamping, domain
  URL-decoding).
- **`project.zip` deletion**: unrelated to any command run during this work — flagging it
  rather than acting on it. `git status` shows it as a tracked-then-deleted file; nothing in
  this session's command history touched it.

## Environment note (this working session only)

Docker was unavailable in this environment, so `npm run db:test:up` (the documented
integration-test path) couldn't run. A native PostgreSQL 17 install stood in for it — both
the dev database and a second local database at `.env.test`'s `DATABASE_URL` (port changed
from the documented `5433` to `5432`, since that's a local Docker-vs-native difference, not a
project convention change). `.env.test` is gitignored, so this substitution has no footprint
in the repo.

## Manual step for the operator

Per the milestone doc's own final section: **rotate `AUTH_SECRET`, `DATABASE_URL`, and
`SERPAPI_API_KEY`** — a `.env` containing live values was shared outside the repo. Rotating
`AUTH_SECRET` invalidates all existing JWTs, which is the desired effect. I did not attempt
to rotate anything myself; the operator confirmed rotation was handled before Phase 2 began
(see the "AUTH_SECRET investigation" section below for why that ordering mattered).

## AUTH_SECRET investigation (between Phase 1 and Phase 2)

Before starting Phase 2, the operator asked me to investigate whether `project.zip` — which
`git status` showed as deleted after Phase 1 — was how the already-acknowledged `.env` leak
happened, since `.gitignore` covered `.env` but not `*.zip`.

Findings: `git log --all --diff-filter=A -- '*.zip'` found exactly one commit,
`25868bb` ("database created"), which added `project.zip` — and `git ls-remote origin main`
confirmed that commit is live on GitHub right now. I extracted it via `git cat-file -p
25868bb:project.zip` and listed its contents (323 files): it contains only `.env.example`
and `.env.test.example`, never a real `.env`, and the `.gitignore` bundled inside it already
excludes `.env`/`.env.test` — consistent with the zip having been built respecting gitignore
at creation time. **I did not find a leaked `.env` in this repository's git history.** That
doesn't resolve the underlying concern the milestone doc already stated as fact independent
of this zip ("a `.env` containing live values was shared outside the repo") — that claim may
describe a channel outside what this repo's history can show. Added `*.zip` to `.gitignore`
regardless, as a real (if here, not proven causal) gap.

Two other review items the operator asked for before Phase 2, both addressed by direct
inspection rather than assumption:
- **Stale-test diff review**: read every line of the Phase 1 test diff by hand. No assertion
  was weakened or deleted — the 2 skipped tests keep their full bodies intact, and
  `store-routes.integration.test.ts` (broken by my own 1.3 change) came out with *more*
  assertions, not fewer. The real risk is direction-of-alignment on 6 value updates
  (`analysesLimit`, `daysRemaining`/`expiresAt`, `slotsLimit`) made to match already-uncommitted
  freemium-redesign source rather than the reverse — flagged as something to independently
  confirm, not something I could verify from the repo alone.
- **Pinned-fetch degradation under IP rotation / IPv6-only**: traced (not assumed) that
  `fetchProductsPage` already wraps every `fetchWithTimeout` call in try/catch with one
  retry on page 1, and `createAutoPinnedFetch` does a fresh resolve+pin on every single
  invocation (never caches an Agent), so a retry after a mid-crawl IP rotation naturally
  picks up the new address — no new hard-fail path that could feed `failureStreak`.

---

# Phase 2 — Admin RBAC

## Amendment applied before implementation

Per the operator's review, `docs/milestone-11-security-rbac-promos.md` section 2.2 was
amended and the doc itself updated (not just the code): the original text said `role` reuses
`plan`'s 60-second TTL cache. That's unsafe for privileged roles — the TTL compares a
`planCheckedAt` claim *inside the token itself*, which an attacker forging a token also
controls, so a forged `SUPER_ADMIN` token could keep itself permanently "fresh" and never
get revalidated. Corrected rule, implemented in `src/lib/auth/jwt-plan-refresh.ts`: whenever
`token.role` is anything other than `"USER"`, the `jwt` callback re-reads the user row and
overwrites `role` on **every request**, ignoring `planCheckedAt` entirely. The TTL still
applies to `plan`, and to `role` itself, but only while the token's current role claim is
`"USER"`.

**Live-verified, not just unit-tested**: logged in as a real bootstrapped `SUPER_ADMIN`,
confirmed `GET /api/admin/users` returned `200`, then directly downgraded that user's `role`
to `USER` in Postgres (bypassing the app entirely — simulating a forged token or a
revocation by another admin), and replayed the exact same session cookie: the very next
request returned `403 Forbidden`, and `GET /api/auth/session` immediately reflected
`role: "USER"` — no delay, no re-login, matching the amendment's requirement precisely.

## What was built

**2.1 — `src/lib/admin/roles.ts`**: `Role`/`Permission` string unions, the literal
permission table from the doc, `hasPermission()`, `permissionsFor()`, and `canGrantRole()`
(invariant 2 — a permission-set subset check, not a hardcoded role-name comparison, so it
stays correct if the matrix grows a second role holding `user:role:write`). Matrix tested
exhaustively: every role × every permission asserted individually (102 tests) plus targeted
checks (only `SUPER_ADMIN` writes roles/promos, `BILLING_ADMIN` reads but can't mint promos).

**2.2 — `src/lib/admin/guard.ts`**: `requirePermission()` builds on the existing
`requireUser()` (`src/lib/auth/session.ts`) rather than re-deriving the session, throwing the
new `ForbiddenError` (alongside the existing `UnauthorizedError`) when the role lacks the
permission. `withAdminRoute()` is the shared wrapper every admin route uses — maps
`UnauthorizedError → 401`, `ForbiddenError → 403`, and lets anything else propagate rather
than masking a genuine failure as an auth error. `CurrentUser`/`getCurrentUser()`/
`requireUser()` in `session.ts` now carry `role`; `types.d.ts` and both auth callbacks
(`jwt`, `session`) were extended to carry it through the JWT.

**2.3 — `src/lib/admin/audit.ts`**: `recordAdminAction()` writes one `AdminAuditLog` row.
Every mutating service function in `users-service.ts` calls it *inside its own
`prisma.$transaction()`* — verified directly, not assumed: `recordAdminAction` was mocked to
throw on demand for `updateUserRole`, `updateUserPlanWithAudit`, and `revokeUserSessions`,
and each rolls back its own change with zero audit rows written, while the normal path writes
exactly one. `getAuditLog()` is cursor-paginated on `(createdAt, id)`, mirroring
`monitoring/change-feed.ts`'s existing convention exactly. Append-only: no update/delete path
exists anywhere in the code.

**2.4 — Admin routes**, all under `src/app/api/admin/`, `runtime = "nodejs"`, rate-limited on
`userId`, all going through `withAdminRoute()`:
- `GET /api/admin/users` — email-substring search, cursor-paginated. `user:read`.
- `GET /api/admin/users/[id]` — detail: plan, role, analysesUsed, activeWatchCount. `user:read`.
- `PATCH /api/admin/users/[id]/plan` — `user:plan:write`. `scripts/set-user-plan.ts` and this
  route now share one implementation (`setUserPlan()` in `users-service.ts`, taking
  `Pick<PrismaClient, "user">` so a `tx` and the top-level client are interchangeable) —
  verified by re-running the script against a real user after the change.
- `PATCH /api/admin/users/[id]/role` — `user:role:write`. See invariants below.
- `POST /api/admin/users/[id]/revoke-sessions` — sets `sessionsValidAfter = now()`. `user:suspend`.
- `GET /api/admin/audit` — `audit:read`.

**Privilege-escalation invariants** (`updateUserRole()` in `users-service.ts`, tested first,
per the doc's own instruction, before the route existed — confirmed genuinely failing on
"file not found" before implementation, then built until green):
1. Self-role-change rejected with 403, even for `SUPER_ADMIN`.
2. `canGrantRole()` generic subset check — today only `SUPER_ADMIN` holds `user:role:write`
   at all, so this never blocks `SUPER_ADMIN` from granting any non-`SUPER_ADMIN` role in
   practice, but the check is implemented generically (tested directly with a real
   non-subset pair from the matrix: `BILLING_ADMIN` and `OPS_ADMIN` can't grant each other).
3. **The last remaining `SUPER_ADMIN` cannot be demoted — tested as a genuine concurrency
   race, not a restatement of invariant 1.** A route-level check-then-write can't actually
   expose this invariant with a single actor (they can never target themselves, so they can
   never zero out the count alone) — the meaningful race is two `SUPER_ADMIN`s demoting
   *each other* at the same instant. Test fires both `PATCH` calls concurrently via
   `Promise.all`; `pg_advisory_xact_lock` on a fixed key (`admin:super-admin-count`) inside
   the transaction serializes them, so exactly one succeeds (200) and one is rejected (403),
   and the `SUPER_ADMIN` count is verified to land on exactly 1, never 0.
4. `SUPER_ADMIN` cannot be granted through any HTTP route — checked unconditionally, before
   the generic permission check, so no future matrix change could accidentally reopen it.
5. `POST /api/auth/signup` already picked fields explicitly and ignored an unknown `role`
   key — confirmed with a regression test (a spoofed `role: "SUPER_ADMIN"` in the signup body
   produces a plain `USER` account) rather than assumed from reading the code.

**Bootstrap — `scripts/grant-admin.ts`**: the only way to mint `SUPER_ADMIN`, following
`set-user-plan.ts`'s pattern (direct `DATABASE_URL` access, refuses to run without
`--confirm`), writing an audit row with actor id `"system:bootstrap"`. Live-verified: used to
bootstrap a real account, which was then used for every other live check in this phase.

## Schema — migration `20260820023014_admin_rbac`

Purely additive:
- `enum Role { USER ANALYST CONTENT_ADMIN SUPPORT_ADMIN BILLING_ADMIN OPS_ADMIN SUPER_ADMIN }`
- `User.role Role @default(USER)`, `@@index([role])`.
- `model AdminAuditLog { id, actorId, actorEmail, action, targetType, targetId?, metadata?, createdAt }`
  with `@@index([actorId, createdAt])` and `@@index([targetType, targetId])`.

Applied and verified against both the local dev database and the local test database.

## Gate status

- `npx tsc --noEmit`: clean.
- `npm run lint`: clean.
- `npm test` (unit): **536 passed**, 0 failed, across 41 files.
- `npm run test:integration`: **265 passed, 2 skipped** (same 2 pre-existing skips carried
  over from Phase 1 — unrelated dead entitlement-limit coverage), 0 failed, across 40 files.
- Live-verified end to end against the running dev server: bootstrapped a real `SUPER_ADMIN`,
  logged in, confirmed `session.user.role`, exercised `GET /api/admin/users` and
  `GET /api/admin/audit` for real, confirmed an unauthenticated request 401s, and confirmed
  the amendment's forced-re-read behavior live (see above).

## No new environment variables or dependencies in this phase.

---

# Between Phase 2 and Phase 3 — two gates and a spec amendment

Before starting Phase 3, the operator raised two blockers and one spec gap, all addressed
before any Phase 3 code was written.

## Gate 1 — the plan numbers (analysesLimit, slotsLimit, daysRemaining/expiresAt)

Resolved, not just re-aligned. Cross-referenced `plan-limits.ts` against
`docs/milestone-10-subphase-b-billing-and-freemium-decision-report.md` §35 ("Final
Decision") and `docs/milestone-10-subphase-c-completion-report.md` (what was actually
shipped): all three sources already agree — FREE is 1 monitor/no expiry/unlimited analyses,
the single paid tier (BASIC and BUSINESS retained as identical, compatibility-only enum
values) is 10 monitors/no expiry/unlimited analyses. The Phase 1 test realignments were
correct, not guesses. What's still genuinely open and distinct from what was asked: the
exact *price* (decision report gives $19/mo as a recommendation with a $15–25 test range,
never finalized — Phase 3 §3.1 already anticipated this and uses a clearly-commented
placeholder) and whether `ANNUAL` billing should be real at all in V1 (the decision report
lists it under "What Not to Build"; implemented here as a structural, non-discounted 12x
multiple per pricing.ts's own doc comment — flagged for confirmation, not decided
unilaterally).

## Gate 2 — credential rotation

Confirmed explicitly: `DATABASE_URL` has been rotated to a value the leaked `.env` never
contained (asked directly, not inferred from the earlier general answer).

## §3.4 amendment — subscription expiry and downgrade cascade

Applied to the doc itself (see the `## 3.4 Checkout` section) before implementation: the
original spec created a `Subscription` with `expiresAt` and nothing ever read it, so a
duration-limited promo would grant its plan permanently. Implemented in full — see Phase 3
below.

---

# Phase 3 — Promo codes and checkout (including the §3.4 amendment)

## What was built

**3.1 — `src/lib/billing/pricing.ts`**: `listPriceCents(plan, period)`, Prisma-free.
`FREE` is 0. `BASIC`/`BUSINESS` priced identically (same reasoning as their entitlement
limits). Placeholder $19/mo, explicitly commented as pending the real billing decision.
`ANNUAL` is a non-discounted 12x multiple, not a real second price point — see Gate 1 above.

**3.2 — `src/lib/billing/promo-code.ts`**: `generatePromoCode()` — 12 characters, Crockford
base32 (no I/L/O/U), `crypto.randomBytes` (never `Math.random`), ~60 bits of entropy;
unbiased byte-to-character mapping relies on 256 dividing evenly by the 32-character
alphabet. `normalizePromoCode()` and `isValidVanityCode()` (`^[A-Z0-9]{4,32}$`).

**3.3 — `src/lib/billing/promo.ts`**: `evaluatePromo()` (read-only) and `redeemPromo()`
(the only place a `PromoRedemption` row is ever written), kept as two separate functions
per the spec's own explicit instruction. Discount is always computed server-side from
`listPriceCents()` and clamped (`Math.min(discountCents, listPrice)`) — verified directly:
a `FIXED` discount of 999,999 cents against a real list price produces `finalCents: 0`,
never negative. Redemption is atomic via `pg_advisory_xact_lock` on a key derived from the
promo id — the exact `recordAnalysisUsage()` pattern — **verified as a genuine concurrency
race, not simulated**: two different users redeeming a `maxRedemptions: 1` promo
simultaneously via real `Promise.all`-fired transactions produces exactly one success, one
rejection, and the redemption count never exceeds 1.

**3.4 — `src/lib/billing/checkout.ts`**: `processCheckout()` branches on `finalCents`. The
`=== 0` path is fully functional, live-verified end to end over real HTTP (not just tests):
signed in as a real bootstrapped `SUPER_ADMIN`, minted a real 100%-off promo through the
live admin API, signed up and signed in as a brand-new real user, validated and redeemed the
promo through the live billing routes, and confirmed directly in Postgres that `User.plan`,
the `Subscription` row (correct `expiresAt`, 90 days out, matching the promo's
`durationDays`), and both `AdminAuditLog` rows (checkout completion and promo creation,
neither ever containing the full code — only `codeLast4`) all landed correctly. The
`> 0` path creates a `PENDING` `Checkout` and stops at the marked `// PROVIDER SEAM:
createProviderSession()` — the promo is deliberately NOT redeemed until a payment
confirms. `expirePendingCheckouts()` sweeps `PENDING` rows older than 1 hour.

**3.4 amendment — `src/lib/billing/subscription-sweep.ts`**: `expireDueSubscriptions()`,
structurally different from `monitoring/watch.ts`'s `expireDueWatches()` (a single bulk
`UPDATE`) by necessity — the downgrade cascade needs per-user watch selection a global
statement can't express, so each due subscription gets its own transaction, with
per-subscription failure isolation (verified directly: deleted a `User` row out from under
its own due `Subscription` mid-sweep to force a real failure, confirmed the OTHER due
subscription in the same sweep still processed correctly). Inside each transaction: revert
`User.plan` to `FREE`, mark the `Subscription` `EXPIRED`, then the cascade — excess `ACTIVE`
watches beyond `maxActiveMonitoredStores(FREE)` are expired (oldest `monitoringStartedAt`
retained), calling the now-generalized `recomputeStoreTier()` (`monitoring/watch.ts`, its
signature widened to `Pick<PrismaClient, "store" | "watchlist">` so a `tx` and the
top-level client are interchangeable — reused, not duplicated, per the amendment's explicit
instruction) for each affected store, then one `AdminAuditLog` row with actor
`"system:expiry"`. All four of the amendment's required tests pass, written against the
real `maxActiveMonitoredStores()` constant rather than a hardcoded number (per Gate 1):
expiry reverts the plan; the downgrade retains exactly the FREE limit (oldest-first) and
expires the rest; every affected store's tier recomputes (verified both directions — a
store that lost its only watcher demotes to `COLD`, a store still within the limit stays
`HOT`); a `null`-expiry subscription survives the sweep untouched. Wired into
`scripts/worker.ts`, next to the other sweeps.

**3.5 — Admin promo routes** (`src/lib/admin/promos-service.ts` +
`src/app/api/admin/promos/**`): `POST /api/admin/promos` (`promo:create`, `SUPER_ADMIN`
only — live-verified `BILLING_ADMIN`, which only holds `promo:read`, gets 403), returns the
full code once; `GET /api/admin/promos` (`promo:read`) lists with redemption counts, full
code visible (masking would be theatre — an admin who can read can already use it);
`POST .../[id]/assign` and `.../revoke` (never deletes — a revoked promo does not claw back
a plan already granted, stated in the response itself). Every mutation pairs with exactly
one audit row in the same transaction, same convention as Phase 2's `users-service.ts`.

**3.6 — UI**: `PromoRedemption.tsx` on the pricing page — a code input that calls
`/api/billing/promo/validate`, shows the recomputed total, and redeems via
`/api/billing/checkout`. Every rejection reason (including `not_assigned_to_you`) collapses
to one generic "This code isn't valid" message — never `reason` verbatim. `/admin` gated in
`layout.tsx` on `role !== "USER"` (live-verified: a `SUPER_ADMIN` gets a real 200 with data,
a `USER`-role account gets a real 404, anonymous gets a 307 to `/login`) — both
`/admin/users` and `/admin/promos` fetch their data as **Server Components**, calling
`searchUsers()`/`listPromos()` directly server-side, not through a client-side-gated fetch;
the promo-creation form is the one genuinely interactive piece, POSTing to the API route,
which re-checks `promo:create` independently regardless of the UI gate.

## Schema — migration `20260820070422_promos_and_checkout`

Purely additive. `enum DiscountType`, `PromoStatus`, `CheckoutStatus`, `SubscriptionSource`,
plus `SubscriptionStatus` (added by the 3.4 amendment, since the original spec's
`Subscription` had no field for the sweep to query/mark). `PromoCode` includes
`durationDays Int?` (the amendment's addition — null is an explicit "grant forever" choice,
never a default an admin falls into by omission). `Subscription` includes `status
SubscriptionStatus @default(ACTIVE)` and `@@index([status, expiresAt])` (the sweep's own
query shape). Applied and verified against both the local dev database and the local test
database.

## Gate status

- `npx tsc --noEmit`: clean.
- `npm run lint`: clean.
- `npm test` (unit): **551 passed**, 0 failed, across 43 files.
- `npm run test:integration`: **300 passed, 2 skipped** (same 2 pre-existing skips carried
  from Phase 1), 0 failed, across 44 files.
- Live-verified end to end against the running dev server, real Postgres, real HTTP — see
  3.4 and 3.6 above for the specific flows exercised.

## Acceptance criteria — all satisfied

- A 100% promo grants the plan with zero payment-provider involvement: integration-tested
  (`checkout.integration.test.ts`) and live-verified over real HTTP.
- Two concurrent redemptions of a `maxRedemptions: 1` promo produce exactly one redemption:
  tested as a genuine `Promise.all` race, not simulated.
- A user cannot redeem the same promo twice: unique index + test, both the app-level check
  and the DB-level `P2002` fallback exercised.
- A promo assigned to user A returns the identical response to a nonexistent code when user
  B tries it: tested at the route level (`billing-routes.integration.test.ts`) — identical
  status and body, not just identical `reason` string.
- A fixed-amount promo larger than the list price yields `finalCents === 0`, never negative:
  tested directly.
- No route accepts a client-supplied price: grepped `src/app/api/billing` for
  `finalCents`/`listPriceCents`/`discountCents` — every occurrence is on the response side;
  both routes read only `plan`/`period`/`code` from the request body (also live-verified: a
  request with spoofed `finalCents`/`listPriceCents` fields in the body was silently
  ignored, server recomputed the real price).
- (3.4 amendment) All four required tests pass — see 3.4 amendment above.

## No new environment variables. New dependency: none (no payment provider was added — the seam is a stub `NotImplementedError`, by design).

## What's still open (not decided unilaterally)

- The real price and whether `ANNUAL` billing should be a real, marketed option — see Gate 1.
- A real payment provider — the seam is stubbed, nothing beyond it was built, matching the
  decision report's own `CONDITIONAL GO` status pending direct provider outreach.
- The `/admin` promo-assign flow currently expects a raw user id typed into a form field —
  fine for the one operator using this today, but a real user-picker (searching by email,
  reusing `searchUsers()`) would be the natural next UI polish if this area sees more use.
