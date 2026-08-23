# Milestone 12 — Completion report

Covers Phase 1 (entitlement model rework), Phase 2 (per-employee permission grants), Phase 3
(super admin analytics), and Phase 4 §4.1 (consent) including its addendum (audit metadata PII,
the OAuth consent gate), `docs/milestone-12-freemium-admin-marketing.md`. Phase 4 §§4.2-4.4
(pixels, credential vault, campaign surface) are explicitly out of scope for this report — the
operator's own instruction was to build §4.1 in full and stop for review before touching pixels,
since consent is the gate that makes the rest lawful.

---

# Blocking decisions — recorded in the doc itself

D1–D5 were answered by the operator and written into
`docs/milestone-12-freemium-admin-marketing.md`'s own "Blocking decisions" section before any
code was written. Summary: trial anchors to account creation (D1); a repeat analysis of the
same store within the 24h window is free (D2); anonymous users get a shallow probe, never a
full report (D3, with a spec amendment — see below); `BASIC`'s price stays an unfinalized
$19/mo placeholder, `BUSINESS` is confirmed at $49/mo (D4); the `BUSINESS` cap hard-fails with
`LIMIT_REACHED`, no soft-throttle (D5).

# Phase 1 — Entitlement model rework

## Gate status

- `npx tsc --noEmit`: clean.
- `npm run lint`: clean.
- `npm test` (unit): **584 passed**, 0 failed, across 46 files.
- `npm run test:integration` (real Postgres, `.env.test`): **331 passed**, 0 failed, across 47
  files.
- Live-verified against the running dev server, real Postgres, real HTTP, two real external
  Shopify stores (allbirds.com, gymshark.com): signup (confirmed `freeTrialEndsAt` set to
  exactly `createdAt + 30 days`), credentials login, a full authenticated `POST /api/analyze`
  end to end (`entitlement.analysesLimit: 10`, `resetsAt` a real ISO timestamp 24h out),
  `POST /api/store/[domain]/watch` returning a real `expiresAt` equal to the trial ceiling,
  a second watch attempt returning the exact `LIMIT_REACHED` JSON shape
  (`{code:"LIMIT_REACHED",limit:"MONITORED_STORES",current:1,max:1,upgradeTo:"BASIC"}`, `403`),
  an anonymous `POST /api/analyze` reaching the new code path (no longer a bare `401`) and
  failing closed with `turnstile_failed` since no Turnstile key is configured locally, and the
  dashboard/store-detail pages rendering without error, including the new `UpgradePrompt`.

## What changed, item by item

**1.1 — Final plan matrix (`src/lib/entitlements/plan-limits.ts`)**
Replaced `maxUniqueAnalyses` (a lifetime cap, unused since Milestone 10/11's freemium redesign
set it to `null`/unlimited on every plan) with `maxAnalysesPer24h` — the §1.1 table transcribed
literally: `FREE` 10, `BASIC` 50, `BUSINESS` 100. Added `freeTrialDays` (`FREE`: 30, paid: `null`).
`maxActiveMonitoredStores` changed from the old 1/10/10 to 1/20/50 — `BASIC` and `BUSINESS` stop
being identical entitlement tiers, matching the doc's explicit un-collapsing. Anonymous is kept
as its own constant (`ANONYMOUS_ANALYSES_PER_24H = 3`), not a `PlanTier` row — no account exists
yet for an anonymous caller, so forcing it through the same type as a signed-in user's plan
would be a worse fit than a separate constant. The matrix is asserted cell-by-cell against the
doc's own table in `plan-limits.test.ts`, per the phase's own acceptance criterion.

**1.2 — `AnalysisUsage` becomes a windowed ledger (`src/lib/entitlements/analysis-usage.ts`)**
Migration `20260820163932_freemium_windowed_ledger` drops `@@unique([userId, storeId])`, adds
`@@index([userId, createdAt])` (the quota query's covering index) and a non-unique
`@@index([userId, storeId])`. The table is append-only now — one row per analysis run.
`recordAnalysisUsage()` keeps its `pg_advisory_xact_lock` pattern verbatim (same key,
`'analysis:' || userId`) and the same count-inside-the-transaction ordering; D2's dedup is
implemented as a `findFirst` inside the window, checked before the count, inside the same lock,
so it can never race a `limit_reached` decision. `hasAnalyzedStore()` is preserved exactly as
the doc requires — same permanent, all-time meaning Milestone 11's `resolveStoreAccess()`
depends on, now an `EXISTS`-shaped `findFirst` instead of a unique lookup, tested directly to
still work with duplicate rows. A new `hasAnalyzedStoreInWindow()` exists specifically for
`run-analysis.ts`'s fast-fail pre-check optimization — the all-time version would wrongly treat
a store analyzed outside the current window as "already free" under D2's windowed model, letting
an over-quota caller reach a wasted crawl; this keeps that optimization accurate without
touching the authoritative gate. `sweepOldAnalysisUsage()` (30-day retention, for Phase 3's
future admin analytics) is wired into `scripts/worker.ts`.

The Milestone 11 concurrency test this phase's acceptance criteria call for adapting did not
actually exist in the repository at the time (the referenced test file had only two,
non-concurrent cases) — written fresh in `analysis-usage.integration.test.ts` instead, as a
real `Promise.all` race with exactly one credit left, verified to produce exactly one
`recorded` and one `limit_reached` outcome, never both `recorded`.

**1.3 — Anonymous analysis, reinstated safely (`src/lib/analysis/anonymous-probe.ts`,
`src/lib/crawl/shopify.ts`, `src/lib/entitlements/anonymous-analysis.ts`,
`src/lib/security/turnstile.ts`)**
Per D3's amendment: anonymous callers get a genuinely different, much cheaper operation, not a
branch of the authenticated crawl. `probeShopifyStorePage1()` (new, in `crawl/shopify.ts`) makes
exactly one request — `products.json` page 1, no retry — reusing `fetchProductsPage()` and
`classifyFirstPageFailure()` verbatim rather than a second implementation of "fetch and classify
one page." `runAnonymousProbe()` orchestrates it: Turnstile verification (fail closed, before
any fetch or DB write) → the DB-backed anonymous quota/circuit-breaker check → the probe itself.
No `Store` row is ever written on this path — not because fix 1.5's crawl-then-persist ordering
happens to apply, but because the shallow probe never calls `runDiffAndPersist` or touches the
`Store` table at all; a dedicated regression test confirms zero `Store`/`Crawl` rows for a
non-Shopify domain on this path specifically, alongside the pre-existing authenticated-path
version of the same fix 1.5 regression test.

`runAnalysis()`'s own `caller` parameter changed from optional/nullable to **required** —
anonymous calls no longer reach it at all (previously only reachable in tests, since Milestone
11 fix 1.4 already gated the real route). This is a deliberate signature change, not a
compatibility shim: the old "anonymous → full crawl, no credit spent" branch inside
`buildReport()` is dead code under D3 and was removed rather than kept unreachable.

New model `AnonymousAnalysis { id, ipKey, domain, createdAt }` — `domain` rather than the doc's
literal `storeId`, deliberately: an anonymous probe never creates a `Store` row, so most probed
domains have no `Store` to reference; a real FK would either need to be nullable-with-no-real-use
or force widening fix 1.5's guarantee for no benefit. `recordAnonymousAnalysis()` mirrors
`recordAnalysisUsage()`'s advisory-lock pattern (`'anon-analysis:' || ipKey`) and additionally
gates the global circuit breaker (`ANONYMOUS_CRAWL_HOURLY_CEILING`, default 500) inside the same
lock — recorded *before* the fetch, deliberately unlike the authenticated path's
record-after-success ordering: the circuit breaker's own contract is a count of crawls
*started*, and a single-request probe is cheap enough that "don't waste a slot on a failure"
matters far less than closing the free-retry gap a record-after-success design would leave open
against an always-failing domain. `sweepOldAnonymousAnalyses()` (48h retention) is wired into
the worker tick.

`verifyTurnstileToken()` (`security/turnstile.ts`) fails closed exactly like `SCHEDULER_SECRET`
does: an unset `TURNSTILE_SECRET_KEY` makes every verification fail, not skip the check — live-
verified against the dev server, which has no key configured. `TURNSTILE_SECRET_KEY`,
`NEXT_PUBLIC_TURNSTILE_SITE_KEY`, and `ANONYMOUS_CRAWL_HOURLY_CEILING` are documented in
`docs/environment-variables.md` (all three tables — process matrix, quick reference, and the
"never shared between environments" list) and added to `render.yaml`.

`POST /api/analyze` (`src/app/api/analyze/route.ts`) now branches on `getCurrentUser()`: signed
in reaches `runAnalysis()` exactly as before; signed out reaches `runAnonymousProbe()`, keyed on
`getClientIp()` — the fixed extractor (Milestone 11 fix 1.1), never the raw header. The SSE
streaming plumbing (disconnect-safety, the `closed` flag) is factored into a shared
`streamAnalysis()` helper used by both paths rather than duplicated.

Two regression tests exist for this item, per the operator's explicit instruction to write them
first: a route-level test asserting a spoofed `x-forwarded-for` prefix does not change the
`ipKey` passed to `runAnonymousProbe()` (mirroring `rate-limit.test.ts`'s own fix-1.1
regression), and a ledger-level test in `anonymous-analysis.integration.test.ts` proving the
same thing directly against `recordAnonymousAnalysis()` with real `getClientIp()` extraction —
burning all 3 slots via three different spoofed prefixes for the same real IP and confirming the
4th request is still rejected, not granted a fresh bucket.

**1.4 — Free trial and monitoring slots (`src/lib/monitoring/watch.ts`,
`src/lib/billing/subscription-sweep.ts`)**
`User.freeTrialEndsAt DateTime?` is set via a DB-level default
(`(now() + interval '30 days') AT TIME ZONE 'UTC'`) so every creation path — the signup route,
OAuth first sign-in through the Auth.js Prisma adapter, the admin bootstrap script — gets it
uniformly with no call site able to miss it. Existing users are backfilled from their own
`createdAt` in the migration, not a single flat migration-time value (see the timezone finding
below for why the migration SQL computes this in two steps).

`startMonitoring()` now reads `User.freeTrialEndsAt` for `FREE`-plan callers only: a trial that
has already passed rejects with a new `trial_expired` outcome *before* the count check — without
this, a user whose only watch already expired would read back `activeCount: 0`, pass the limit
check trivially, and get a brand-new watch whose `min(freeTrialEndsAt, watchExpiry)` computes to
an already-past date, i.e. silently created-then-immediately-expired rather than genuinely
rejected. For a still-valid trial, `expiresAt = min(freeTrialEndsAt, watchExpiry)` exactly as the
doc specifies (`watchExpiry` itself stays `null` today, since no plan has a
`monitoringDurationDays` yet — the trial ceiling is the only expiry mechanism FREE watches carry
right now). `expireDueWatches()` needed no changes at all — it already sweeps on
`monitoringExpiresAt`, which is now a real value for FREE instead of always `null`.

`clearTrialCeiling()` (new, `billing/subscription-sweep.ts` — "belongs next to"
`expireDueSubscriptions()`, per the doc) is the upgrade path's inverse of the downgrade cascade:
nulls out `monitoringExpiresAt` on every `ACTIVE` watch for a user moving to a paid plan. Wired
into both places `User.plan` is actually written to a non-`FREE` value today —
`checkout.ts`'s zero-cost-promo redemption and `users-service.ts`'s `setUserPlan()` (shared by
the admin route and `scripts/set-user-plan.ts`), so an admin-granted plan change isn't a second,
possibly-drifting implementation. Live-verified: started a FREE watch (real `expiresAt` 30 days
out), the trial-expiry integration test confirms the watch expires and the store's tier
recomputes to `COLD` once `freeTrialEndsAt` passes, and a separate test confirms
`clearTrialCeiling()` nulls the expiry on upgrade.

**1.5 — Upgrade prompts (`src/lib/entitlements/limit-reached.ts`)**
One shared `LIMIT_REACHED` envelope (`limitReached()`/`nextPlanUp()`) used by all three
call sites: the SSE error event's `limitReached` field for `ANALYSES_PER_DAY`
(`run-analysis.ts`), and the JSON `403` body for `MONITORED_STORES` and `TRIAL_EXPIRED`
(`watch/route.ts`) — never three independently-hand-rolled shapes. `resetsAt` is included only
when there's a real one to report (`Object` spread on a conditional, not a `null` placeholder) —
`TRIAL_EXPIRED` has no meaningful `current`/`max` count, so it uses `0`/`0` as the
least-misleading filler the shared shape's required fields allow, documented at the one call
site that needs it. `upgradeTo` is derived from the caller's own current plan
(`FREE → BASIC`, `BASIC`/`BUSINESS → BUSINESS`), not hardcoded per limit kind.

UI: `MonitorButton.tsx`'s at-limit state and its `LIMIT_REACHED`-triggered error state both now
render the new `UpgradePrompt` component (`src/components/dashboard/UpgradePrompt.tsx`), which
reads `BASIC`'s and `BUSINESS`'s real limits and prices from `entitlement-service.ts`/
`pricing.ts` rather than hardcoding them — live-verified against the running dev server (a
second watch attempt against a real analyzed store rendered the upgrade panel with the correct
props). `plan-label.ts` was also corrected to return `"Basic"`/`"Business"` distinctly instead
of collapsing both to `"Paid"`, since they are no longer the same entitlement tier under §1.1.
`pricing.ts` was updated per D4: `BUSINESS` is now `4900` cents (was `1900`, incorrectly tied to
`BASIC`'s placeholder) — a real, confirmed number, not a placeholder like `BASIC`'s remains.

Anonymous-side UI: a `TurnstileWidget` component loads Cloudflare's script and renders the
challenge only for a signed-out caller (`useSession()`-gated in `page.tsx`), degrading to an
explanatory "unavailable" message when `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is unset — the server
check fails closed regardless, so this is purely about not rendering a broken widget, never a
bypass. `POST /api/analyze`'s anonymous result gets a new `AnonymousProbeReport` type/view
(`access: "anonymous_probe"`) — deliberately distinct from the pre-existing
`AnonymousPreviewReport` (`access: "anonymous_preview"`, still produced by
`GET /api/store/[domain]/report` for an anonymous viewer of a store someone *else* already fully
crawled, theme data included since that's real and already public) rather than widening that
shared type, per the doc's own "do not widen anything else" instruction.

## Schema — migration `20260820163932_freemium_windowed_ledger`

Additive except the two `AnalysisUsage` index changes (drop unique, add two non-unique):
- `AnalysisUsage`: `@@unique([userId, storeId])` dropped; `@@index([userId, createdAt])` and
  `@@index([userId, storeId])` added.
- `User.freeTrialEndsAt DateTime?`, backfilled from each row's own `createdAt`, then a DB-level
  default set for future inserts.
- `model AnonymousAnalysis { id, ipKey, domain, createdAt }` with `@@index([ipKey, createdAt])`
  and `@@index([createdAt])` (the circuit breaker's own global-count query shape).

Applied and verified against both the local dev database and the local test database.

### A real timezone bug, found and fixed during this phase (AGENTS.md's Database time rule)

The first version of `freeTrialEndsAt`'s DB default (`now() + interval '30 days'`, no explicit
UTC cast) landed **6 hours off** from `createdAt + 30 days` once actually exercised through a
real `prisma.user.create()` call against this project's own dev Postgres — session `TimeZone`
Asia/Dhaka, inherited from the host OS, the exact scenario AGENTS.md's own account of the
original incident describes. This is a genuinely different case from every other `DateTime`
field in the schema: Prisma's own `@default(now())` fields (`createdAt`, etc.) are populated
**client-side** by Prisma's query engine with an already-UTC-safe parameter — confirmed
directly, empirically, not assumed — the engine never actually invokes those columns' SQL-level
`DEFAULT` clause on a real typed `.create()` call, only on a raw SQL insert that omits the
column. `freeTrialEndsAt` has no such client-side special case, so its SQL-level default
genuinely fires on every real insert, putting it squarely inside the rule: a `timestamptz`-typed
expression (`now()`) cast into a `timestamp(3)` (no tz) column depends on the session's
`TimeZone` GUC, not UTC. Fixed by wrapping the whole default expression in
`AT TIME ZONE 'UTC'`; live-verified before and after the fix against the real Asia/Dhaka dev
session (confirmed a 6h gap with the bug, exactly `30.000` days after the fix). A dedicated
regression test (`src/lib/auth/__tests__/free-trial-default-timezone-safety.integration.test.ts`)
pins a deliberately pathological, fractional-hour session timezone (Asia/Kathmandu, UTC+5:45)
via a single-connection client — confirmed to fail against the pre-fix expression and pass
against the fixed one, so this can't silently regress on a CI machine whose Postgres happens to
default to UTC.

## New environment variables

`TURNSTILE_SECRET_KEY`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `ANONYMOUS_CRAWL_HOURLY_CEILING`
(default `500`) — all documented in `docs/environment-variables.md` and added to `render.yaml`
(the two Turnstile keys as `sync: false` secrets/site-key, the ceiling as a plain, non-secret
`value`).

## No new dependencies

The Turnstile widget is loaded via a plain `<script>` tag against Cloudflare's own CDN
(`challenges.cloudflare.com/turnstile/v0/api.js`), not an npm package — consistent with this
project's existing preference for minimal dependencies on a single-purpose integration.

## Acceptance criteria — all nine satisfied

- The plan matrix is asserted cell-by-cell in `plan-limits.test.ts`.
- The 10th/11th analysis boundary: `analysis-usage.integration.test.ts` and
  `run-analysis.integration.test.ts`, including the correct `resetsAt`.
- Two concurrent analyses with one credit left: `analysis-usage.integration.test.ts`, a real
  `Promise.all` race.
- D2's within-window/outside-window dedup: `analysis-usage.integration.test.ts` and
  `run-analysis.integration.test.ts`.
- The 4th anonymous analysis rejected, spoofed XFF regression: `anonymous-analysis.integration.test.ts`,
  `anonymous-probe.integration.test.ts`, and `analyze-route.test.ts` (route-level).
- Turnstile-missing-token rejected before any fetch: `anonymous-probe.integration.test.ts`,
  live-verified against the dev server.
- FREE watch expiry + tier recompute on trial end: `watch.integration.test.ts`.
- Upgrade lifts the trial ceiling: `watch.integration.test.ts` (`clearTrialCeiling()` directly)
  and live-verified for the checkout/admin call sites' wiring by code path, not a live paid
  upgrade (no real payment provider exists to drive one end to end — same limitation Milestone
  11 Phase 3 already documented).
- Zero Store rows after an anonymous non-Shopify analysis: `anonymous-probe.integration.test.ts`,
  alongside the pre-existing authenticated-path version in `run-analysis.integration.test.ts`.

## What's still open (not decided unilaterally) — as of Phase 1

- `BASIC`'s real price — still the $19/mo placeholder, per D4's explicit deferral.
- The Milestone 11 Render staging deploy verification (proxy-topology XFF check, security-header
  check, SSE-under-CSP check) — paused mid-thread before this milestone began, still outstanding.

---

# Phase 2 — Per-employee permission grants

## Gate status

- `npx tsc --noEmit`: clean.
- `npm run lint`: clean.
- `npm test` (unit): **713 passed**, 0 failed, across 46 files.
- `npm run test:integration` (real Postgres, `.env.test`): **357 passed**, 0 failed, across 49
  files.
- Live-verified against the running dev server, real Postgres, real HTTP: bootstrapped a real
  `SUPER_ADMIN`, confirmed self-grant is rejected (`403`), confirmed every `SUPER_ADMIN_ONLY`
  permission is rejected even from the `SUPER_ADMIN` actor (`403`), granted `audit:read` to a
  real signed-in `USER` and — **without that user re-authenticating** — their already-open
  session went from `403 Forbidden` on `GET /api/admin/audit` to `200` on the very next request;
  revoking it immediately flipped the same still-open session back to `403`. This is the
  concrete, live demonstration of "no staleness window" the doc's own §2.1 asks for, not just a
  test assertion.

## What was built

**2.1 — Effective permissions (`src/lib/admin/roles.ts`, `src/lib/admin/guard.ts`)**
`effectivePermissions(role, grants)` is a plain `Set` union — `permissionsFor(role) ∪ grants` —
with no code path that can remove a role-derived entry; narrowing stays exclusively a
role-change operation (`updateUserRole()`, unchanged from Milestone 11). New model
`AdminPermissionGrant { id, userId, permission, grantedByUserId, grantedAt, expiresAt?,
revokedAt? }`, append-only like `AdminAuditLog` — revocation and expiry both work by *setting*
`revokedAt`, never by deleting the row. `permission` is a plain `String`, matching
`AdminAuditLog.action`'s own convention, so a new permission value never needs a migration.
`grantedByUserId` is deliberately a plain field, not a relation — the granting admin's own
account may later be deleted, and the grant they issued to someone else must keep working
(exactly `AdminAuditLog.actorEmail`'s existing "survives the actor's own deletion" reasoning);
the *target* (`userId`) relation, by contrast, cascades, since a deleted user has nothing left
to apply a grant to and the permanent record already lives in `AdminAuditLog`.

`requirePermission()` (`admin/guard.ts`) checks the role first — a pure, in-memory
`hasPermission()` lookup, no DB query — and only falls through to a live grant lookup
(`hasActiveGrant()`) when the role alone doesn't already cover it, so the common case (a role
that already has the permission) pays no extra query cost. The grant lookup itself re-checks
`expiresAt` directly in its `WHERE` clause rather than trusting the worker sweep to have already
run, so a grant stops applying the instant it expires, not up to one tick-interval later — the
same "live, not cached" discipline Milestone 11's amended `jwt` callback already established for
`role`. **Grants are never written into the JWT or session** — every check is a fresh read.

**2.2 — Protected permissions (`src/lib/admin/roles.ts`, `src/lib/admin/permissions-service.ts`)**
`SUPER_ADMIN_ONLY` transcribed verbatim from the doc. `grantPermission()` rejects every member
unconditionally, before touching the database, regardless of the actor's own role — verified
directly with a real `SUPER_ADMIN` actor attempting to grant `billing:refund` and
`permission:grant` itself, both rejected. `roles.test.ts` asserts, exhaustively, that every
`SUPER_ADMIN_ONLY` permission is held by `SUPER_ADMIN`'s own baseline matrix (otherwise it would
be unreachable by *anyone*) and that no other role's baseline matrix contains any of them.

**2.3 — New roles (`src/lib/admin/roles.ts`, `prisma/schema.prisma`)**
Exactly two, per the doc: `MARKETING_ADMIN` (`metrics:read`, `user:read`, `campaign:read`,
`campaign:write`) and `MANAGER` (the union of `SUPPORT_ADMIN` and `OPS_ADMIN`, plus
`audit:read` — asserted in `roles.test.ts` as a computed union against the matrix, not a
hand-copied literal, so it can never silently drift from its two source roles). Ten new
permissions added to the `Permission` union and to `SUPER_ADMIN`'s own baseline set (the only
role whose matrix contains the five `SUPER_ADMIN_ONLY` ones, by construction).

Two pre-existing `VALID_ROLES` allowlists — `PATCH /api/admin/users/[id]/role`'s route and
`scripts/grant-admin.ts` — hardcoded the Milestone 11 seven-role list and would have made
`MARKETING_ADMIN`/`MANAGER` practically unreachable (defined in the matrix, but nothing could
ever assign them) had they not been updated alongside the enum; caught and fixed as part of this
phase, not left as a latent gap.

**2.4 — Routes (`src/app/api/admin/users/[id]/permissions/`)**
- `GET .../permissions` — `user:read`. Returns role-derived, granted (with `grantedAt`/
  `expiresAt`/`grantedByUserId`), and their effective union as three separate arrays, so the UI
  (not built this phase — out of scope per the doc) can show provenance, not just a flat list.
- `POST .../permissions` — `permission:grant`, itself `SUPER_ADMIN_ONLY`, so only a real
  `SUPER_ADMIN` ever reaches this handler in practice. Body `{ permission, expiresAt? }`. `400`
  for an unrecognized permission string or a malformed `expiresAt`; every privilege-escalation
  outcome (self-grant, protected permission, unknown target user) maps to its own `403`/`404`.
  Idempotent: granting an already-actively-granted permission returns `200` with
  `status: "already_granted"` rather than an error or a duplicate row.
- `DELETE .../permissions/[permission]` — same `permission:grant` gate. Sets `revokedAt`,
  `404`s a permission the target was never actively granted.
- `expireDuePermissionGrants()` wired into `scripts/worker.ts`, next to the other sweeps —
  bookkeeping for the audit trail (so "is this active" is a single `revokedAt IS NULL` check at
  the DB level), not the enforcement mechanism, which is the live query described under 2.1.

**Privilege-escalation invariants**, written first per the doc's own instruction — confirmed
genuinely failing (`Failed to load url .../permissions/route... Does the file exist?`) before
either route existed, then built until green, mirroring Milestone 11 Phase 2's own process
exactly:
1. An actor cannot grant a permission to themselves, even a `SUPER_ADMIN`.
2. An actor lacking `permission:grant` cannot grant anything at all — generic gate, not a
   hardcoded role check.
3. Every `SUPER_ADMIN_ONLY` permission is rejected even when the actor genuinely is
   `SUPER_ADMIN`.
4. `permission:grant` itself can never be granted through the route, by anyone.
5. An unknown permission string is `400`, never silently accepted.
6. A real grant is visible immediately (no re-login, no cache).
7. Two concurrent grants of the same `(user, permission)` — fired as a genuine `Promise.all`
   race, not simulated — produce exactly one active row, race-safe via
   `pg_advisory_xact_lock` on a key derived from both the target user and the permission, the
   same pattern `recordAnalysisUsage()`/`updateUserRole()` already use.

## A real testability bug, found and fixed during this phase

Adding `hasActiveGrant()` to `requirePermission()` meant `admin/guard.ts` started importing the
real Prisma singleton. `guard.test.ts` is a **unit** test (`npm test`, no `.integration.`
suffix) that only mocked `@/lib/auth/session` — it doesn't set up a real database at all. Run in
isolation, it happened to keep passing anyway, purely because this machine's local dev Postgres
was reachable at `DATABASE_URL` and answered the incidental real query fast enough not to
matter. That's exactly the kind of test that silently breaks in CI (or any environment without
Postgres provisioned for the unit-test job) — `vitest.config.ts`'s own header comment states the
invariant this violated: "`npm test` must stay fast and DB-free so it runs on every save."
Fixed by having `guard.test.ts` mock `@/lib/db/prisma` too (the same pattern
`analyze-route.test.ts` already established for exactly this situation), stubbing
`adminPermissionGrant.findFirst` directly rather than letting the real singleton through — also
used to add two new tests (a grant covering a permission the role lacks succeeds; the DB is
never queried at all when the role alone already covers it) that a real-DB-backed unit test
couldn't have asserted about call counts as cleanly.

## Schema — migration `20260820174427_permission_grants`

Additive except two new values on the existing `Role` enum (`MARKETING_ADMIN`, `MANAGER` —
added as separate `ALTER TYPE ... ADD VALUE` statements, since Postgres can't add more than one
enum value per transaction-migration in a single statement, matching the pattern Prisma itself
generates). New `AdminPermissionGrant` table with two plain indexes
(`(userId, permission)`, `(expiresAt)`) plus a hand-written **partial** unique index —
`ON (userId, permission) WHERE revokedAt IS NULL` — appended to the generated SQL, since
Prisma's `@@unique` has no `WHERE`-clause support and Postgres partial-index predicates must be
immutable (so it can only check `revokedAt IS NULL`, never also `expiresAt > now()` — a
documented, accepted limitation: the *live* application-level check in
`permissions-service.ts` already handles expiry correctly regardless, and the index is defense
in depth against a duplicate *active* row, not the primary enforcement path, which is the
advisory lock). Applied and verified against both the local dev database and the local test
database.

## No new environment variables or dependencies in this phase.

## Acceptance criteria — satisfied

- `effectivePermissions()` is additive-only: asserted directly in `roles.test.ts`, and
  end-to-end via the `GET .../permissions` route's `roleDerived`/`granted`/`effective` triad.
- Every `SUPER_ADMIN_ONLY` permission rejected by `grantPermission()` regardless of actor,
  including `SUPER_ADMIN` itself: unit-tested exhaustively and live-verified over real HTTP.
- No role other than `SUPER_ADMIN` holds any `SUPER_ADMIN_ONLY` permission in its baseline
  matrix: asserted exhaustively in `roles.test.ts`.
- Grants are never cached in the JWT — live-verified: a single already-open session flips from
  `403` to `200` and back to `403` across a grant and a revoke, with no re-authentication
  between any of the three requests.
- Every Milestone 11 §2.4-style privilege-escalation invariant carried over, in particular
  self-grant forbidden: seven invariants, written first, confirmed failing, then green —
  `permission-grant-invariants.integration.test.ts`.

## What's still open (not decided unilaterally) — as of Phase 2

- `BASIC`'s real price — still the $19/mo placeholder, per D4's explicit deferral (Phase 1).
- No admin UI for viewing/granting/revoking per-user permissions — the doc's Phase 2 scope is
  the four routes only; a UI wasn't asked for and wasn't built, unlike Phase 1's explicit
  upgrade-prompt UI requirement.
- The Milestone 11 Render staging deploy verification (proxy-topology XFF check, security-header
  check, SSE-under-CSP check) — paused mid-thread before Milestone 12 began, still outstanding.

---

# Phase 3 — Super admin analytics

## Dependency check

Phase 3 requires `analytics:read` and `export:users` (§2.3). Phase 2 had already shipped in full
(`AdminPermissionGrant`, `MARKETING_ADMIN`/`MANAGER` roles, both permissions present in
`roles.ts` on `SUPER_ADMIN`'s own baseline matrix) — confirmed by reading the schema and
`roles.ts` before writing any code, per this phase's own explicit instruction to check first.
**Used both permissions as-is.** No change to the role matrix; the `AdminPermissionGrant` system
was not touched. Live-verified as part of this phase's own verification (see below): a
`SUPPORT_ADMIN` test account was refused both the new page and the export route until granted
`analytics:read` through the real Phase 2 grant route, at which point access worked on the
account's already-open session with no re-login — the same "no staleness window" property
Phase 2's own report demonstrated, now confirmed to extend to Phase 3's checks too.

## Gate status

- `npx tsc --noEmit`: clean.
- `npm run lint`: clean.
- `npm test` (unit): **719 passed**, 0 failed, across 50 files (+6 tests / +2 files over Phase 2's
  713/46 — `funnel.test.ts`'s pure rate math and `user-export.test.ts`'s DMMF field-coverage
  check, both genuinely DB-free).
- `npm run test:integration` (real Postgres, `.env.test`): **407 passed**, 0 failed, across 60
  files (+50 tests / +13 files over Phase 2's 357/49).
- Live-verified against the running dev server, real Postgres, real HTTP: signed up a fresh user,
  granted `SUPER_ADMIN` via `scripts/grant-admin.ts`, signed in for a real `authjs.session-token`
  cookie (NextAuth credentials flow via curl, not simulated). With that cookie: ran
  `computeAndStoreSnapshots()` directly against the real dev database (129 real rows written from
  real signups/analyses already in that database, not synthetic fixtures — confirmed the
  `rowsWritten` count matches the table's actual row count exactly, catching and fixing a real
  duplicate-write bug in the process, see 3.2 below); `GET /admin/analytics` returned a real `200`
  rendering all six sections with the real computed numbers and the correct `computedAt` timestamp,
  recharts chunks loading; `POST /api/admin/users/export` with `purpose:"marketing"` returned the
  real `501` with the Phase-4-pointing message; the same route with `purpose:"support"` returned a
  real CSV (`Content-Disposition: attachment`) and wrote a real `AdminAuditLog` row with the exact
  `rowCount`/`filters`/`purpose`; a second `SUPPORT_ADMIN` account was refused both routes (`404`
  on the page, `403` on the export) until granted `analytics:read`/it would separately need
  `export:users`, then let through immediately, no re-login.

## What was built

**1 — Raw query modules (`src/lib/admin/analytics/`)**
One module per §3.1 metric group, each a `PrismaClient`-typed function returning raw counts —
`funnel.ts`, `activation.ts`, `revenue.ts`, `retention.ts`, `usage-cost.ts`, `operational.ts` —
every query a `prisma.$queryRaw` tagged template, never `$queryRawUnsafe`. `window.ts` is the
shared, Prisma-typed (but logic-pure) helper every module goes through for date handling —
`utcParam()` for window-boundary comparisons, and a header comment explaining why bucketing
(`date_trunc`) must NOT use the same wrapper (see the timezone section below). Rate/percentage
math that doesn't need the database — `computeFunnelSteps()` in `funnel.ts` — is a separate,
Prisma-free function, unit-tested with no DB, per this milestone's own "pure policy modules stay
Prisma-free" rule.

Two judgment calls worth recording, since the doc didn't specify them literally:
- **Funnel** counts each step's absolute occurrences in the window, not a per-identity
  attribution chain — `AnonymousAnalysis` is keyed only on IP, with no link anywhere in the schema
  to the `User` a visitor might later become, so "this anonymous visitor became this signup" isn't
  a question this data can answer. "Absolute counts and conversion rate per step" (the doc's own
  words) is exactly what independent per-step counts support.
- **Revenue**'s MRR/new/expansion/contraction/churned definitions are recorded as doc comments at
  the top of `revenue.ts` (first-ever-Subscription-row = "new"; price delta vs. the immediately
  preceding plan = expansion/contraction; `status=EXPIRED` with `expiresAt` in-window = "churned").
  `contractionMrrCents` isn't named in the doc but falls out of the same LATERAL-join query as
  expansion — reporting it separately seemed better than silently dropping real downgrade impact.
- **Retention** reports `everPaid` (trial→paid conversion, ever) and `currentlyPaid` (plan is
  non-FREE right now) per signup-month cohort, rather than a fabricated M0/M1/M2 retention curve —
  this schema has no activity timestamps beyond auth to honestly support one.

**2 — `MetricSnapshot` and the hourly worker tick**
Migration `20260821000000_analytics_metric_snapshot` — purely additive, one new table. Unique on
`(metricKey, dimension, windowStart, windowEnd)`, which doubles as the upsert key.
`analytics/snapshot.ts`'s `computeAndStoreSnapshots()` self-gates to hourly (`SNAPSHOT_MIN_INTERVAL_MS`,
a `MAX(computedAt)` check) so it's safe to call on every 5-minute worker cycle — wired into
`scripts/worker.ts` next to the other sweeps, isolated in its own `try`/`catch` per that file's
existing per-phase discipline.

A real bug, found live during this phase's own dev-database verification, not a hypothetical: the
standard rolling windows (1d/7d/30d/90d) advance their `windowEnd` every run (truncated to the
hour), unlike retention/daily-trend rows, which are pinned to calendar month/day boundaries and so
naturally upsert the same row when recomputed. Without a fix, every hourly tick would leave the
previous hour's row in place and insert a fresh one next to it — one new row per rolled-up metric
per hour, forever. Caught by comparing `rowsWritten` against the table's real row count after
running against the dev database (138 written, 129 actually distinct) — not by the integration
tests alone, whose synthetic single-run fixtures couldn't see a bug that only appears on a
*second* run an hour later. Fixed with `pruneStaleRolledUpRows()`: after each run, deletes
strictly-older rows for the exact `(metricKey, dimension)` pairs just recomputed. A second,
smaller version of the same shape was caught in the same live check: the three point-in-time
operational metrics (`scheduler_lag`, `disabled_stores`, `stores_on_failure_streak`) don't vary by
window at all, so emitting them once per `STANDARD_WINDOWS` iteration was writing the identical
row four times per run — fixed by emitting them only once. Both fixes are covered by
`snapshot.integration.test.ts`'s "upsert, not a new one" test.

Row volume: ~50 rolled-up metrics × 4 windows (pruned to one live row each), 12 cohort-months × 3
metrics, 35 days × 3 plans — a few hundred rows total, not the unbounded growth an un-pruned
design would have produced.

**3 — Server Components and charts (`recharts`)**
`recharts` was NOT actually an existing dependency despite the doc's "already a dependency" —
confirmed absent from both `package.json` and `node_modules` before installing it
(`^3.10.1`, `npm audit`'s pre-existing vitest/esbuild dev-only findings are unrelated and
predate this change). `src/app/admin/analytics/page.tsx` is a Server Component gated on
`requirePermission("analytics:read")` specifically — not just `AdminLayout`'s broad
`role !== "USER"` check — the same permission-not-role distinction every `/api/admin/*` route
already uses, now live-verified to extend to a page. It calls exactly one function,
`getAnalyticsDashboardData()` (`analytics/dashboard-data.ts`), which reads ONLY `MetricSnapshot`
via `analytics/read.ts` — never a raw aggregate query — so the page stays cheap regardless of
`Event`/`Crawl`/`AnalysisUsage` table size. Two `"use client"` chart components
(`FunnelBarChart`, `AnalysesTrendChart`) render the funnel step counts and the analyses-per-day-by-plan
trend; every other section (activation, revenue, retention, operational) is a stat-tile/table
layout matching the existing `/admin/promos` and `/admin/users` pages' own style, not a bespoke
new visual language.

**4 — User list filters and export**
`GET /api/admin/users` and `searchUsers()` (`users-service.ts`) gained `plan`/`role`/`sort`
params, additive to the existing `email`/`cursor`/`limit` ones — `buildUserSearchWhere()` is now
shared between `searchUsers()` and the new `exportUsers()` so the two can never define "matches
these filters" differently. `POST /api/admin/users/export` requires `export:users`, checked via
the same `withAdminRoute()` every other route uses — never `user:read`. `purpose:"marketing"`
returns `501` with a message pointing at Phase 4 (§4.1); `purpose:"support"` exports a CSV
(`id,email,plan,role,createdAt`) and writes exactly one `AdminAuditLog` row recording
`rowCount`/`filters`/`purpose` — the write happens *before* the function returns the rows, so a
failed audit write means the caller never gets data back, mirroring `audit.ts`'s own "an action
that can't be logged never silently happens" principle, applied here to a read instead of a
mutation.

The exclusion test (`user-export.test.ts`) reads `Prisma.dmmf.datamodel.models` directly — no DB
connection needed, genuinely schema metadata baked into the generated client — rather than
hand-copying `schema.prisma`'s field list, so it can't drift out of date with the schema on its
own. Every `User` field must be in the export allowlist OR in a small, explicitly-reviewed
"safe to omit" set (`passwordHash`, `sessionsValidAfter`, relations, etc.); a brand-new column
lands in neither and fails the test until a human categorizes it — confirmed this actually
enforces something by checking `passwordHash` is asserted absent from the allowlist directly, not
just implied by omission.

## The timezone check

Per this phase's own explicit instruction, a dedicated `timezone-safety.integration.test.ts` pins
`Asia/Kathmandu` (UTC+5:45) the same way Phase 1's `free-trial-default-timezone-safety` suite did,
and asserts BOTH directions at once against real queries in this directory (not a synthetic
repro): window-boundary comparisons via `getFunnelCounts()` stay correct at the exact edge of a
window, and `date_trunc` bucketing via `getCohortRetention()`/`getDailyAnalysesTrend()` buckets by
the UTC calendar day/month, not the session-local one. The suite's own claim to actually catch the
regression was verified directly, not assumed: temporarily reintroducing the "wrap the bucketed
column in `AT TIME ZONE 'UTC'`" mistake into `retention.ts` made the cohort-bucketing test fail
exactly as expected, confirming it isn't a test that would pass regardless — then reverted.
`window.ts`'s own header comment records both rules and why they're opposites, specifically
because getting rule 2 backwards (the retention/trend case) looks "safe" by false analogy with
rule 1 (the window-boundary case) and is actually a live regression — the exact trap this phase's
brief called out by name.

## SerpAPI cost

`analytics/vendor-cost.ts` holds `SERPAPI_COST_PER_CALL_CENTS` alone, with a comment naming the
source (`https://serpapi.com/pricing`, fetched live 2026-08-21) and every confirmed plan tier at
that date. `google-serpapi.ts`'s own header comment records this project's real account
tier/volume as unverified — no invoice or vendor-dashboard figure exists in the codebase to pin
the constant to instead — so the Developer tier ($75/5,000 = 1.5 cents/search) was chosen as the
default: the lowest tier whose volume is plausible for a pre-revenue product's real call volume,
same placeholder status as `pricing.ts`'s `BASIC` price. `usage-cost.ts`'s
`costPerActiveBusinessAccountCents` attributes vendor spend specifically to `BUSINESS`-plan
accounts — SerpAPI calls for a store watched by more than one `BUSINESS` account are counted once
(`EXISTS`, not a join that would multiply rows), matching real spend rather than double-counting
shared-store cost.

## Schema — migration `20260821000000_analytics_metric_snapshot`

Additive only: new `MetricSnapshot` table (`id, metricKey, dimension, windowStart, windowEnd,
value, computedAt`), a unique index on `(metricKey, dimension, windowStart, windowEnd)`, and a
`(metricKey, dimension, windowEnd DESC)` index for the dashboard's own "latest value" read shape.
`prisma migrate diff` also proposed re-running Phase 1's `freeTrialEndsAt` default `ALTER`
(byte-identical expression — a known Prisma quirk introspecting `dbgenerated()` raw-SQL defaults,
not a real change); dropped from the migration file to keep it purely additive. Applied and
verified against both the local dev database and the local test database.

## New dependencies

`recharts@^3.10.1` — was not actually present despite the doc's "already a dependency," confirmed
by checking both `package.json` and `node_modules` before installing.

## No new environment variables

`SERPAPI_COST_PER_CALL_CENTS` is a code constant (`analytics/vendor-cost.ts`), not an env var —
same placeholder-price convention as `pricing.ts`'s `BASIC` figure, not a secret or a
per-environment value.

## Acceptance criteria — all satisfied

- Every metric group has its own module, raw `$queryRaw` tagged templates only, each with an
  integration test against seeded fixtures: `funnel.integration.test.ts`,
  `activation.integration.test.ts`, `revenue.integration.test.ts`, `retention.integration.test.ts`,
  `usage-cost.integration.test.ts`, `operational.integration.test.ts`.
- `MetricSnapshot` computed on a self-gated hourly worker tick, never synchronously on page load —
  `snapshot.integration.test.ts`, plus the live dev-database run that caught the duplicate-write
  bug.
- Server Components read snapshots only — `dashboard-data.ts`/`read.ts` never call the raw query
  modules directly; live-verified via the rendered `/admin/analytics` page.
- Charts render with `recharts` (a real, now-installed dependency) — live-verified (recharts
  chunks loading in the served page).
- `GET /api/admin/users` gains plan/role/sort — `users-service-filters.integration.test.ts`.
- `POST /api/admin/users/export` requires `export:users`, not `user:read`; excludes `passwordHash`
  and never joins `Session`/`Account`; `purpose:"marketing"` is `501`; `purpose:"support"` writes
  one audit row with row count, filters, and purpose — `user-export.test.ts`,
  `user-export.integration.test.ts`, live-verified over real HTTP.
- Every date-bucketed/windowed query stays correct under a pathological non-UTC session timezone —
  `timezone-safety.integration.test.ts`, confirmed to actually catch the regression via a
  deliberate negative-control run.
- No mutating admin routes added — every new route this phase is read-only except the export,
  whose only "write" is its own audit row.

## What's still open (not decided unilaterally) — as of Phase 3

- `BASIC`'s real price — still the $19/mo placeholder, per D4's explicit deferral (Phase 1).
- The real SerpAPI account tier/volume — `SERPAPI_COST_PER_CALL_CENTS` is a documented placeholder
  (Developer tier, $0.015/search) pending a real invoice or vendor-dashboard figure.
- No admin UI for viewing/granting/revoking per-user permissions — unchanged from Phase 2, still
  not in scope for any phase run so far.
- The Milestone 11 Render staging deploy verification (proxy-topology XFF check, security-header
  check, SSE-under-CSP check) — paused mid-thread before Milestone 12 began, still outstanding.

---

# Phase 4 §4.1 — Consent

Scope: exactly §4.1 of the doc. §§4.2-4.4 (pixels, CSP loosening, credential vault, campaign
surface) are explicitly NOT started — the operator's own instruction was to stop here for review
before pixels exist anywhere in the tree, since §4.2 will loosen the CSP Milestone 11 fix 1.7
shipped, and that's the highest-risk change in this milestone.

## A real gap found before writing any code

The doc's own §4.1 text assumes a ToS acceptance checkbox already exists ("the ToS checkbox stays
mandatory while this one stays optional"). It doesn't — there was no ToS/Privacy Policy checkbox,
page, or any acceptance mechanism anywhere in this codebase before this phase. Flagged to the
operator before writing any signup UI (rather than either inventing legal-page content
unilaterally or silently building the marketing checkbox with nothing real to be "separate from,"
which would make the "not bundled" property untestable). Operator chose: add a minimal, required
ToS checkbox plus `/terms` and `/privacy` pages, both explicitly marked as placeholder content
pending legal review. Built exactly that — no other content invented.

A related, disclosed limitation: OAuth signup (Google/Facebook via the Auth.js Prisma adapter)
creates a `User` row directly in the adapter callback, with no form and no consent-checkbox
moment at all. `marketingConsent` defaults to `false` for that path, which is correct (no consent
was ever given). ToS acceptance for OAuth signups is NOT gated by anything this phase built — the
same status quo as before this phase (no worse), not a new gap, but a real one: building a
post-OAuth "accept terms" interstitial is a separate, larger feature not requested.

## Gate status

- `npx tsc --noEmit`: clean.
- `npm run lint`: clean (one real finding fixed during this phase — see "A real lint finding"
  below, not suppressed).
- `npm test` (unit): **727 passed**, 0 failed, across 50 files (+8 over Phase 3's 719/48 —
  `unsubscribe-token.test.ts` (6, pure HMAC math) and `account/export.test.ts` (2, DMMF
  exhaustiveness), both genuinely DB-free).
- `npm run test:integration` (real Postgres, `.env.test`): **440 passed**, 0 failed, across 64
  files (+33 over Phase 3's 407/60).
- Live-verified against the running dev server, real Postgres, real HTTP, real NextAuth session
  cookies (not simulated): signup rejected with `400` when `tosAccepted` was omitted; signup with
  `tosAccepted: true, marketingConsent: true` returned `201` and the DB row showed
  `marketingConsent: true` with a real `marketingConsentAt` and `marketingConsentSource:
  "signup_form"`; the real unsubscribe link (HMAC token freshly minted for that user) flipped
  `marketingConsent` to `false` while leaving `marketingConsentAt`/`Source` untouched as history,
  and re-fetching the user afterward confirmed it; a garbage token on the same URL left the row
  untouched and rendered "Link no longer valid"; signed in as the existing `SUPER_ADMIN` from
  Phase 3's own verification and ran `POST /api/admin/users/export` with `purpose:"marketing"` —
  the now-unsubscribed user was absent, a separately-created still-consented user was present,
  proving both directions of the filter over real HTTP, not just the integration tests; signed in
  as a fresh user and exercised `GET /api/account/export` (real JSON download, no `passwordHash`
  anywhere in it) and `POST /api/account/delete` (wrong `confirmEmail` → `400`, correct
  `confirmEmail` → `200`, immediate re-fetch of the same endpoint → `404 Account not found` —
  the deleted-account JWT-collapse edge case in `jwt-plan-refresh.ts` firing for real, not just
  covered defensively); `/dashboard/settings` rendered the real "Subscribed" status and both
  action buttons for a real consented user.

## What was built, item by item

**Schema (`prisma/schema.prisma`, migration `20260822000000_marketing_consent`)**
`User.marketingConsent Boolean @default(false)`, `marketingConsentAt DateTime?`,
`marketingConsentSource String?` — purely additive. `AdminAuditLog`'s own doc comment was updated
in place (no schema change, just documentation) to record the one narrow, deliberate exception to
"append-only, no update path" this phase introduces — see tombstoning below.

**Signup consent (`src/app/api/auth/signup/route.ts`, `src/components/auth/AuthForm.tsx`)**
Two SEPARATE checkboxes, never combined into one control or read from one another: `tosAccepted`
(required — the submit button stays disabled until checked, and the route rejects `400` if it's
missing or `false` even with a direct API call bypassing the UI) and `marketingConsent`
(optional, unticked by default, never blocks signup). `marketingConsent: true` is written in the
SAME `prisma.user.create()` call as the rest of the row, not a second `update()` right after —
no window where the row exists with the correct default contradicted by an in-flight `true`
already promised. Only a literal `=== true` counts as consent (a truthy-but-non-boolean value is
rejected, tested explicitly) — this is the one thing on the form that must never be inferred.

**Unsubscribe (`src/lib/marketing/unsubscribe-token.ts`, `src/lib/marketing/consent.ts`,
`src/app/unsubscribe/page.tsx`)**
HMAC-SHA256 of the user id under a dedicated `UNSUBSCRIBE_TOKEN_SECRET` (never `AUTH_SECRET`
reused), verified with `constantTimeEqual()` (the same timing-safe comparator `SCHEDULER_SECRET`
already uses) — chose this over a stored `UnsubscribeToken` table because no email SENDER exists
anywhere in this codebase yet (M12's own doc lists email sending as out of scope for the whole
milestone), so there is nothing that would ever need to look up or revoke an individual token row;
a stateless, deterministic HMAC has no table to prune. Fails closed exactly like
`TURNSTILE_SECRET_KEY`: an unset secret makes every token invalid, never silently trusted.
`GET /unsubscribe?uid=&token=` performs the unsubscribe on the GET itself, not behind a second
POST/confirm step — deliberate: no email sender exists yet, so the usual corporate-email-scanner-
prefetch concern that would normally argue for a confirm step doesn't apply today, and "one click"
is the doc's own explicit requirement. `revokeMarketingConsent()` flips `marketingConsent` to
`false` but leaves `marketingConsentAt`/`Source` untouched — they record when/where consent was
originally granted, which stays true and worth keeping even after revocation, the same
append-only-history spirit as `AdminAuditLog`. Idempotent — a stale or already-used link is a
harmless no-op.

**Cookie consent banner (`src/lib/marketing/cookie-consent.ts`,
`src/components/marketing/CookieConsentBanner.tsx`)**
A shared, not-httpOnly cookie (`bw-cookie-consent`, `"granted"` | `"denied"`) — not httpOnly
deliberately, since both this banner (client-side write) and §4.2's future pixel loaders will
need to read it, possibly client-side. Mounted from the ROOT layout (this repo has no "public
route group" to scope it to more precisely — introducing one is a structural change beyond this
phase's own scope, noted for §4.2's own planning, which will need its own enforcement for pixels
regardless of how this banner is scoped) and hides itself under `/dashboard`/`/admin` via a
pathname check. Uses `useSyncExternalStore`, not `useState`+`useEffect` — see "a real lint
finding" below for why. Loads no third-party script itself, so "no non-essential pixel before
consent" is trivially satisfied this phase (nothing exists yet to gate).

**Self-service export and deletion (`src/lib/account/export.ts`, `src/lib/account/delete.ts`,
`GET /api/account/export`, `POST /api/account/delete`, `/dashboard/settings`)**
Export: a DMMF-exhaustiveness test (mirroring Phase 3's admin-export pattern, opposite direction —
this one guards against a new column going UNDISCLOSED rather than LEAKED) asserts every `User`
field is either in the export or an explicitly reviewed omit set; `passwordHash` is asserted
absent directly, not just implied. Deletion, the highest-stakes piece this phase:
- `Checkout` and `Subscription` are deleted EXPLICITLY, before the `User` row — both are
  deliberately NOT FK-related to `User` anywhere in this schema (so one user's billing history
  can't be silently nuked by an unrelated cascade elsewhere), which means a bare
  `user.delete()` would leave them dangling rather than removing them. `Watchlist`/
  `AnalysisUsage`/`Account`/`Session`/`AdminPermissionGrant` all cascade automatically via their
  existing `onDelete: Cascade` relations — confirmed, not assumed, by a dedicated integration
  test creating one row of each and asserting all are gone.
- `PromoRedemption` and `PromoCode.assignedToUserId`/`createdByUserId` are deliberately left
  untouched — outside the doc's own named scope ("watches, usage rows, subscriptions, and
  checkouts"), same "survives, not erasure-scoped" status as `AdminAuditLog`, consistent with how
  immutable promo/financial records are treated elsewhere in this schema. Tested explicitly.
- `AdminAuditLog` rows are TOMBSTONED, never deleted: `actorId`/`actorEmail` replaced wherever the
  erased user was the actor, `targetId` replaced wherever `targetType = "User"` and `targetId`
  matched — the `targetType` check is real and tested (a row whose `targetId` happens to equal the
  user's id but under a DIFFERENT `targetType` is left untouched). A self-referential row (the
  erased user was both actor AND target of the same audit event — a real, existing shape:
  `checkout.completed_free`'s own audit write) is tombstoned correctly on both fields and counted
  ONCE in the returned count, not twice — caught and fixed via a dedicated test before it could
  ship as a reporting bug. `actorEmail` is redacted to a fixed placeholder (`"[deleted user]"`),
  a genuine narrowing of the PRE-EXISTING "actorEmail is denormalized so the log stays readable
  forever" design — that reasoning holds for an admin employee's account being deprovisioned, not
  for a paying customer's own GDPR erasure request, and `checkout.ts`'s own audit write already
  puts a customer's real email into `actorEmail` today. Disclosed, not silently expanded: arbitrary
  `metadata` JSON (e.g. `subscription.expire`'s own `userEmail` field) is NOT scrubbed — doing so
  correctly would require per-action-type-aware parsing, a materially larger undertaking than "the
  user id replaced by a tombstone," and is flagged here rather than glossed over.
- A last-`SUPER_ADMIN` guard, reusing the exact `pg_advisory_xact_lock` key
  `updateUserRole()` (`users-service.ts`) already uses, refuses to let the only remaining
  `SUPER_ADMIN` delete themselves — a system-safety concern (no HTTP path can ever mint another
  one; `scripts/grant-admin.ts` is the only way), not a claimed legal carve-out on their Art. 17
  right; they can still delete after demoting themselves or promoting a successor. Race-tested:
  two concurrent deletions of the last two `SUPER_ADMIN`s never both succeed.
- The route requires `confirmEmail` matching the caller's own email (case/whitespace-insensitive,
  reusing `normalizeEmail()`) rather than a password — an OAuth-only account has no password to
  re-enter. `userId` always comes from the session, never a request field, so this route can only
  ever delete the caller's OWN account.
- Sign-out is triggered client-side immediately on a successful delete (`AccountSettingsActions.tsx`)
  rather than relying on `jwt-plan-refresh.ts`'s own up-to-60-second TTL collapse — live-verified
  that the collapse mechanism itself is real (an immediate re-fetch after deletion returned `404`,
  not a stale `200`), but a UI showing "still logged in" for up to a minute would be a bad
  experience regardless of that safety net existing underneath it.

**Marketing export un-stubbed (`src/lib/admin/analytics/user-export.ts`,
`POST /api/admin/users/export`)**
Phase 3 shipped `purpose:"marketing"` as a deliberate `501` because `User.marketingConsent` didn't
exist yet. Now that it does: `exportUsers()` gained an internal `marketingConsentOnly` option that
ANDs `marketingConsent: true` onto the SAME `where` clause every other filter already goes
through — never a second, divergent query path a future filter change could apply to one purpose
and forget the other. `purpose:"support"` is completely unaffected by consent status (tested
explicitly — both a consented and an unconsented user appear). The admin bulk-export CSV itself
does NOT include the raw `marketingConsent` columns — reviewed and added to the exhaustiveness
test's omit set with a reason (a support lookup never needs consent status; the marketing path
filters on it at the query level instead of exposing it as an output column).

## A real lint finding, fixed properly rather than suppressed

`CookieConsentBanner`'s first draft used `useState` + `useEffect` to read `document.cookie` after
mount (the conventional-looking way to bridge "unknown during SSR" to "known on the client").
`eslint-plugin-react-hooks`'s `set-state-in-effect` rule correctly flagged it — calling `setState`
synchronously inside an effect body causes an avoidable extra render pass, and React has an actual
built-in mechanism for exactly this "SSR-safe default, real value after hydration" case. Rewritten
with `useSyncExternalStore` (a tiny module-level listener array standing in for the cookie's lack
of a real change-event API) instead of suppressing the rule — confirmed clean (`npm run lint`) and
behaves identically, including forcing a re-render when the user clicks Accept/Decline.

## New environment variable

`UNSUBSCRIBE_TOKEN_SECRET` — dedicated secret (never `AUTH_SECRET` reused), fails closed like
`TURNSTILE_SECRET_KEY`/`SCHEDULER_SECRET` when unset. Documented in `docs/environment-variables.md`
(all four tables), `.env.example`, and `render.yaml` (web service only — the unsubscribe page runs
in the web process, not the worker).

## No new dependencies

## Acceptance criteria — all satisfied

- Marketing consent checkbox separate and unticked, not bundled with ToS — `signup-route.
  integration.test.ts`'s dedicated `marketing consent` and `ToS acceptance` describe blocks, live-
  verified.
- `marketingConsent`/`At`/`Source` recorded correctly — same tests, plus `consent.integration.
  test.ts` for the grant/revoke functions directly.
- Unsubscribe works with no login, HMAC-based, fails closed — `unsubscribe-token.test.ts`, live-
  verified with a real link end to end including the garbage-token negative case.
- Cookie consent banner on public pages, state readable by a future pixel layer, no non-essential
  script loads before consent — banner built, mounted, live-verified rendering on the homepage;
  "no pixel loads" is vacuous this phase (§4.2 not started) but structurally nothing this phase
  added loads a third-party script.
- Self-service data export (Art. 15) and deletion (Art. 17) — `export.test.ts`, `export.
  integration.test.ts`, `delete.integration.test.ts` (11 tests, including the tombstone/cascade/
  last-SUPER_ADMIN/concurrency cases), `account-routes.integration.test.ts`, live-verified over
  real HTTP with a real session.
- Deletion cascades watches/usage/subscriptions/checkouts; `AdminAuditLog` rows survive with the
  user id (and, going further than the doc's literal words, `actorEmail`) replaced by a tombstone
  — explicitly tested, including the self-referential-row double-count fix and the
  different-`targetType` non-match case.
- `POST /api/admin/users/export` `purpose:"marketing"` returns consented users only — `user-
  export.integration.test.ts`'s two new tests (plain filter, and combined with a plan filter),
  live-verified both directions over real HTTP against real signed-up/unsubscribed users.
- No mutating pixel/CSP/vendor code anywhere in the tree — §4.2-4.4 not started, confirmed by this
  report's own file list.

## What's still open (not decided unilaterally) — as of Phase 4 §4.1, before the addendum

- Everything already open as of Phase 3 (BASIC's price, SerpAPI's real cost tier, no admin
  permission-grant UI, the Milestone 11 Render staging deploy verification) — unchanged.
- §§4.2-4.4 of this milestone (pixels, the CSP loosening, the credential vault, the campaign
  surface) — not started, per the operator's explicit instruction to stop here for review.
- ~~OAuth signups have no ToS-acceptance gate~~ — **closed by the addendum below.**
- ~~`AdminAuditLog.metadata` JSON is not scrubbed of a deleted user's PII on specific action
  types~~ — **closed by the addendum below**, for the two real call sites that had it; the
  addendum's own scope note explains what's still NOT covered (arbitrary future `metadata`
  shapes are guarded going forward by a runtime check, not by a generic scrubber).
- `/terms` and `/privacy` are explicitly placeholder content, not reviewed by counsel — must be
  replaced with real legal copy before this matters for an actual production launch.

---

# Phase 4 §4.1 addendum — audit metadata PII and the OAuth consent gate

Two gaps identified in the §4.1 report above, closed before starting §4.2 — both consent-layer
work, per the operator's own framing: "the pixel layer assumes consent is complete."

## Gate status

- `npx tsc --noEmit`: clean.
- `npm run lint`: clean.
- `npm test` (unit): **740 passed**, 0 failed, across 52 files (+13 over the pre-addendum
  727/50 — `audit-pii.test.ts` (8) and `audit.test.ts` (5), both DB-free).
- `npm run test:integration` (real Postgres, `.env.test`): **457 passed**, 0 failed, across 67
  files (+17 over the pre-addendum 440/64).
- Live-verified against the running dev server, real Postgres, real HTTP, real sessions: a
  credentials-signup user reached `/dashboard` immediately (`200`, no redirect) since the signup
  route now sets `tosAcceptedAt` itself; directly nulling that same user's `tosAcceptedAt` in the
  database (simulating exactly the row shape Auth.js's Prisma adapter creates on a first OAuth
  sign-in — no `passwordHash`, no consent moment) made the SAME session immediately start getting
  `307` → `/welcome` from `GET /dashboard`; `POST /api/account/consent` without `tosAccepted`
  returned `400` and left the account still gated (`GET /dashboard` still redirected); submitting
  `{tosAccepted: true, marketingConsent: true}` returned `200`, and `GET /dashboard` immediately
  rendered normally afterward; re-visiting `/welcome` on the same completed account redirected
  away to `/dashboard` (`307`) rather than showing the form again; the database read back
  `marketingConsentSource: "oauth_welcome_interstitial"`, distinct from credentials signup's
  `"signup_form"`. The audit-PII backfill migration was live-verified separately by inserting two
  rows shaped exactly like real pre-fix historical rows (raw SQL, bypassing the new
  application-level guard entirely) and confirming the migration's own SQL — re-run manually,
  statement-for-statement — scrubbed both to the new, PII-free shape.

## 1. Audit metadata PII

**Enumeration.** Grepped every `recordAdminAction()` call site in `src/` (12 files) by hand. Two
of them embedded a subject's email in `metadata`:
- `billing/subscription-sweep.ts`'s `subscription.expire` wrote `metadata.userEmail` — always
  redundant, since `targetId` on the same row already identifies the same user. Fixed by deleting
  the field (and the now-unnecessary `tx.user.findUniqueOrThrow({ select: { email: true } })`
  that existed only to produce it — `tx.user.update()` right after already throws `P2025` if the
  user is gone, so removing the extra read doesn't weaken the existing "isolate one subscription's
  failure from the rest of the sweep" test, which still passes unchanged, exercising the exact
  same failure path through the simpler code).
- `admin/analytics/user-export.ts`'s `user.export` wrote `metadata.filters.emailQuery` verbatim
  whenever an admin searched by a specific email. Different treatment than the first case: a bulk
  export has no single `targetId` to fall back on, and the raw guard (below) would otherwise make
  a completely legitimate "search by exact email" admin action fail outright. Replaced with a
  non-identifying `hasEmailFilter: boolean` — "an email filter was used" is real audit signal;
  the address itself is not needed to reconstruct what happened, and is never persisted.

**Enforcement, not just convention.** `audit.ts`'s own doc comment already said "metadata must
never contain secrets" — extended to explicitly cover PII, and, unlike the secrets rule, actually
enforced at write time: `recordAdminAction()` now calls `containsEmailShapedValue()`
(`admin/audit-pii.ts`, a small recursive walk over objects/arrays reusing `isPlausibleEmail()` —
the same "does this look like an email" check the signup route itself already uses, not a second,
possibly-divergent regex) and throws before ever touching the database if it finds one. Throwing
rolls back the enclosing transaction along with it — the same "an action that can't be logged
never silently happens" discipline the file already applied to the DB write itself, now applied
one step earlier to the payload's own content. This is what makes "a test that fails if a new
action type writes an email-shaped value into metadata" true structurally, not just for the two
call sites audited by hand: `audit.test.ts` proves the guard rejects a call with an embedded email
(top-level and nested) and never calls `adminAuditLog.create`, while still allowing every
CURRENT non-PII shape through — and any FUTURE call site that regresses fails the same way the
moment its own test suite (or a live request) exercises it, not just when someone remembers to
re-audit `src/` by hand again.

**`actorEmail` is deliberately untouched by any of this** — per the operator's own framing, that's
the ACTOR (who did this), not the subject's PII this addendum removes. It stays denormalized so
the log survives the actor's own account being deleted, exactly as `AdminAuditLog`'s schema
comment already documented; `account/delete.ts`'s tombstoning (built in the base §4.1 work)
already redacts it specifically in the one case where that reasoning doesn't hold — a customer's
own GDPR erasure of their own actor row.

**Backfill.** Migration `20260823000000_scrub_audit_metadata_pii` — pure data scrub, no schema
change — removes `metadata.userEmail` from existing `subscription.expire` rows and rewrites
`metadata.filters.emailQuery` into `metadata.filters.hasEmailFilter` on existing `user.export`
rows, matching the new code's own output shape exactly. Applied to both the dev and test
databases; live-verified against realistic historical-shaped rows (see Gate status above) rather
than assumed correct from reading the SQL.

## 2. OAuth ToS and consent gate

**The gap.** Google/Facebook sign-in creates the `User` row directly through the Auth.js Prisma
adapter — there is no form, no request body, no moment at all where the base §4.1 work's two
checkboxes could apply. An OAuth account previously reached the dashboard with
`marketingConsent: false` (correct — no consent was ever given) but also with no ToS acceptance
on record whatsoever, silently.

**The fix.** `User.tosAcceptedAt DateTime?` (migration `20260823010000_tos_accepted_at`, purely
additive) is the ONE condition that gates dashboard access, regardless of which path created the
account:
- Credentials signup sets it synchronously, in the same `user.create()` call the route already
  makes (alongside the pre-existing `tosAccepted` validation) — a credentials user is therefore
  NEVER shown the OAuth interstitial; regression-tested directly (`signup-route.integration.test.ts`)
  and live-verified (a fresh credentials signup reached `/dashboard` with no redirect).
- OAuth first sign-in leaves it `null` until `/welcome` — a new page, gated itself (redirects a
  signed-out visitor to `/login`, and an already-consented account straight to `/dashboard`, so it
  can never be shown twice for the same account) — is submitted via the new
  `POST /api/account/consent`, which enforces the exact same rule the credentials signup route
  does: ToS required, marketing optional and unticked by default, never bundled.
- `DashboardLayout` (every route under `/dashboard/**`) does one additional fresh-read check —
  `needsConsentInterstitial()` (`src/lib/account/consent.ts`) — after its existing
  `getCurrentUser()` gate, and redirects to `/welcome` if `tosAcceptedAt` is still null. A fresh
  DB read, not folded into the JWT/`jwt-plan-refresh.ts` machinery: this condition, once satisfied,
  never needs re-checking for the lifetime of the account, so there's no caching benefit to chase,
  and touching that file's cached-claims logic for a one-time check wasn't worth the added risk to
  a security-critical, heavily-tested path.
- `grantMarketingConsentAtSignup()` (previously dead code — written in the base §4.1 work but
  never actually called by the signup route, which inlines its own write for the one-transaction
  reason documented there) is now genuinely used: renamed to `grantMarketingConsent(db, userId,
  source, now)`, taking the source as a parameter instead of hardcoding `"signup_form"`, so
  `/welcome`'s own `recordOAuthWelcomeConsent()` can call the SAME function with a distinct
  `OAUTH_WELCOME_CONSENT_SOURCE = "oauth_welcome_interstitial"` — one implementation of "grant
  marketing consent," two honestly-distinguishable sources, not two copies of the write.

**No consent is ever backdated.** Existing accounts created before `tosAcceptedAt` existed —
including ones created via credentials signup under earlier phases of this very milestone — read
back `tosAcceptedAt: null` after the migration and will see `/welcome` once on their next
dashboard visit, the same as a genuinely un-consented OAuth account. Deliberate: fabricating a
timestamp for consent that was never actually given would defeat the entire point of this
addendum. This is a real, disclosed behavior change for any pre-existing account, not an
oversight.

**Testing "cannot reach the dashboard without passing it."** Beyond the live HTTP verification
above, `dashboard-consent-gate.integration.test.ts` invokes the real `DashboardLayout` Server
Component function directly (App Router layouts are plain async functions — no rendering
framework needed to call one) and inspects the `NEXT_REDIRECT` signal `next/navigation`'s
`redirect()` throws, asserting the exact destination for four cases: signed-out → `/login`;
OAuth-shaped account (`tosAcceptedAt` null) → `/welcome`; credentials-shaped account
(`tosAcceptedAt` already set) → renders, no redirect; an OAuth account that already completed the
interstitial → renders, no redirect. Verified this test suite actually catches a regression, not
just happens to pass: temporarily disabled the gate check in `DashboardLayout`, confirmed the
OAuth-shaped-account test failed with the real, informative assertion failure, then restored it
and confirmed green again.

## Schema — migrations `20260823000000_scrub_audit_metadata_pii` and `20260823010000_tos_accepted_at`

The first is a pure data migration (no `AlterTable`). The second adds exactly one nullable column,
`User.tosAcceptedAt DateTime?` — purely additive. Both applied and verified against the local dev
and local test databases. `prisma migrate diff` again proposed re-running the byte-identical
`freeTrialEndsAt` default `ALTER` (the same known `dbgenerated()`-introspection quirk noted in
every migration this milestone has hand-edited) — dropped from `20260823010000`'s file for the
same reason as every prior instance.

## No new environment variables or dependencies

## Acceptance criteria — all satisfied

- Every admin action type whose metadata embedded an email was enumerated and fixed — `git grep`
  of all 12 `recordAdminAction()`-touching files, not a partial search.
- A test fails if a new action type writes an email-shaped value into metadata — `audit.test.ts`,
  backed by a real, enforced runtime guard in `recordAdminAction()` itself, not just a test-time
  check.
- Existing rows backfill-scrubbed — migration `20260823000000_scrub_audit_metadata_pii`,
  live-verified against realistic historical-shaped data.
- `AdminAuditLog.actorEmail` (the actor) is untouched by any of this — asserted directly in
  `audit.test.ts`.
- OAuth signup gains the same two checkboxes as credentials signup (ToS required, marketing
  optional/unticked), same `marketingConsentSource` discipline (a distinct, real source value) —
  `consent-route.integration.test.ts`, `account/consent.integration.test.ts`, live-verified.
- An OAuth account cannot reach the dashboard without passing the interstitial —
  `dashboard-consent-gate.integration.test.ts` (direct Server Component invocation, regression
  confirmed via negative control) plus live HTTP verification end to end.

## What's still open (not decided unilaterally) — as of the Phase 4 §4.1 addendum

- Everything already open as of Phase 3 (BASIC's price, SerpAPI's real cost tier, no admin
  permission-grant UI, the Milestone 11 Render staging deploy verification) — unchanged.
- §§4.2-4.4 of this milestone (pixels, the CSP loosening, the credential vault, the campaign
  surface) — not started, per the operator's explicit instruction to stop here for review.
- `AdminAuditLog.metadata` is NOT generically scrubbed of PII for action types not audited here —
  the runtime guard catches any FUTURE call site that embeds an email, but a hypothetical
  non-email direct identifier (there are none in this schema today) in some other field shape
  would not be caught by an email-shaped-value check specifically.
- `/terms` and `/privacy` are explicitly placeholder content, not reviewed by counsel — must be
  replaced with real legal copy before this matters for an actual production launch.
- Pre-existing accounts (including ones created earlier in this same milestone's own
  live-verification work) will see `/welcome` once on their next dashboard visit — disclosed
  above as a deliberate, correct consequence of never backdating consent, not a bug to fix.

---

# Phase 4 §4.2, Step 1 — CSP route-scoping (no vendors yet)

Per the operator's explicit "build it in this order and stop between steps 1 and 2" instruction:
this covers ONLY the preflight consent-gate check and Step 1 (the routing mechanism). Step 2
(actual vendor CSP entries, pixel modules, the consent-gated loader, the dashboard/admin
importability test) has NOT been started.

## Preflight finding: the ToS gate did not cover /admin

Confirmed before writing any Step 1 code, as instructed. `AdminLayout` (`src/app/admin/layout.tsx`)
is a SIBLING of `DashboardLayout`, not nested under it — it only checked `requireUser()` + `role
!== "USER"`, with no `needsConsentInterstitial()` call at all. A privileged account with
`tosAcceptedAt: null` (concretely: an OAuth signup promoted via `scripts/grant-admin.ts` before
ever completing `/welcome` — the bootstrap script has no consent check of its own, by design, per
its own doc comment) could reach every `/admin` page entirely around the gate.

Fixed as part of this same change, not deferred — a one-line addition mirroring `DashboardLayout`'s
own check exactly (same `needsConsentInterstitial()` call, same fresh-DB-read reasoning).
Regression-tested (`admin-consent-gate.integration.test.ts`, 4 cases, same direct-Server-Component-
invocation pattern as `dashboard-consent-gate.integration.test.ts`) with a confirmed negative
control (temporarily disabled the check, watched the "closes the gap" test fail with the real
assertion, restored it, confirmed green).

## Step 1 — routing mechanism

**Confirmed against this fork's own docs before writing anything** (`node_modules/next/dist/docs/
01-app/03-api-reference/05-config/01-next-config-js/headers.md`, "Header Overriding Behavior"):
"If two headers match the same path and set the same header key, the LAST header key will override
the first." This — not an assumption from training data, which this fork's own AGENTS.md
explicitly warns may not match — is what makes the split design correct.

`next.config.ts` now declares:
1. ONE catch-all rule (`source: "/:path*"`), declared FIRST, carrying the FULL strict header set
   (unchanged from Milestone 11 fix 1.7 byte-for-byte) — the default/fallback for every path,
   including any route added later that nobody remembers to classify. Fail-closed by construction.
2. One override rule PER entry in a new exported `PUBLIC_MARKETING_ROUTES` array
   (`["/", "/login", "/signup", "/terms", "/privacy"]`), declared AFTER the catch-all, each
   carrying ONLY a `Content-Security-Policy` header — per the override rule above, this replaces
   the CSP value for that exact path while every other header (HSTS, X-Frame-Options, etc.) is
   untouched, since those keys have exactly one definition in the whole file and can never drift
   between strict and public routes by construction, not by convention.

`/welcome` and `/unsubscribe` are deliberately NOT in the public list — both are §4.1 mechanisms,
not marketing content: `/welcome` requires an authenticated session (same session-adjacent
sensitivity as `/dashboard`), and `/unsubscribe`'s entire purpose is opting OUT of marketing, so a
conversion pixel there would be actively perverse.

Per the doc's own explicit instruction, `PUBLIC_CONTENT_SECURITY_POLICY` is set to literally
`STRICT_CONTENT_SECURITY_POLICY` (the same constant, not a copy) — Step 1 is purely the routing
mechanism, no vendor entries.

## Gate status

- `npx tsc --noEmit`: clean.
- `npm run lint`: clean.
- `npm test` (unit): **745 passed**, 0 failed, across 52 files.
- `npm run test:integration`: **461 passed**, 0 failed, across 68 files (+4 for the AdminLayout
  gate fix).
- Live-verified against a real running dev server (restarted to pick up the `next.config.ts`
  change — this file isn't hot-reloadable): fetched full headers for `/`, `/login`, `/signup`,
  `/terms`, `/privacy`, `/dashboard`, `/admin`, `/welcome`, `/unsubscribe`, `/api/analyze` and
  confirmed exactly ONE `Content-Security-Policy` header per response (never two, never zero —
  the real risk this whole mechanism could have gotten wrong), all five other security headers
  present and unchanged everywhere, and — since Step 1's two policies are still byte-identical —
  every route currently showing the same CSP string, as expected for this step specifically.

## Testing note: the value-equality trap

Because the strict and public CSP strings are identical at Step 1, a test that only compares
resolved VALUES would pass even if the wrong rule matched (e.g. `/dashboard` accidentally added
to the public list) — it wouldn't be able to tell the difference yet. `next-config-headers.test.ts`
was written to catch this anyway: it re-implements this fork's own documented override-resolution
algorithm and asserts, for each `PUBLIC_MARKETING_ROUTES` entry, that the WINNING rule's `source`
is that route's own override rule specifically (not just that the catch-all happens to produce the
same string), plus an independent, hard-coded safety-net test asserting the list never contains a
protected path at all. Verified both actually catch a regression, not just structurally plausible:
temporarily added `/dashboard` to `PUBLIC_MARKETING_ROUTES` and confirmed the safety-net test
failed with a real assertion failure (the value-comparison test, as predicted, did NOT catch it at
this step — confirming the layered design was necessary, not redundant), then reverted.

## No new environment variables or dependencies

## Acceptance criteria — Step 1 satisfied

- The strict policy is still present, byte-for-byte, on a dashboard route and an API route —
  `next-config-headers.test.ts`, live-verified.
- The loosened policy appears only on public paths — same test (structural + resolved-value +
  safety-net), live-verified.
- The loosened policy is identical to the strict one at this step — explicit, named test
  (`"Step 1: the public policy is byte-identical..."`) designed to start failing the moment Step 2
  adds a real vendor entry.
- Preflight: the ToS/consent gate now genuinely covers `/admin`, not only `/dashboard` —
  `admin-consent-gate.integration.test.ts`, negative-control-confirmed, live-verified conceptually
  via the same mechanism already proven live for `/dashboard` in the §4.1 addendum.

## What's still open — as of Step 1

- Everything already open as of the §4.1 addendum (BASIC's price, SerpAPI's real cost tier, no
  admin permission-grant UI, the Milestone 11 Render staging deploy verification, `/terms`/
  `/privacy` placeholder content, `AdminAuditLog.metadata` not generically PII-scrubbed) —
  unchanged.
- §4.2 Step 2 (vendor CSP entries, `src/lib/marketing/pixels/` modules, the consent-gated loader
  reusing `cookie-consent.ts`, the dashboard/admin pixel-importability test, server-side
  conversion APIs preferred over client pixels) — not started, per the operator's explicit
  "stop between steps 1 and 2" instruction.
- §§4.3-4.4 (credential vault, campaign surface) — not started.

---

# Phase 4 §4.2, Step 2 — Vendors, one at a time: Vendor 1 (Meta)

Per the operator's explicit "add vendors ONE AT A TIME... report after each vendor rather than at
the end" instruction: this covers ONLY Meta. TikTok, LinkedIn, X, and Google Ads/GA4 have not been
started and require the same per-vendor process repeated, on separate instruction to proceed.

## Classification questions, answered before any vendor was added

**1. Can signup attribution move server-side, off `/login` and `/signup`?** Yes, fully. The
signup route already owns the one moment attribution needs — a successful `prisma.user.create()`
— so recording a `MarketingConversionEvent` there costs nothing in attribution value versus a
client pixel. Both routes are reverted to the strict CSP; this is not an accepted-risk tradeoff,
it's a strictly better design with no downside. `/login` in particular has no plausible
attribution need at all — nobody advertises "log in." `PUBLIC_MARKETING_ROUTES` is now exactly
`["/", "/terms", "/privacy"]`, asserted directly in `next-config-headers.test.ts`.

**2. Is `/pricing` classified deliberately?** There is no separate `/pricing` route — confirmed by
reading `src/app/page.tsx` and grepping the route tree — pricing is the `PricingSection` component
embedded directly in the homepage, which was already public. Nothing was classified by omission.

## What was built

**Server-side path preferred, per instruction.** `dispatchMetaConversionEvent()`
(`src/lib/marketing/pixels/meta.ts`) is the PROVIDER SEAM for Meta's Conversions API — called only
from `scripts/worker.ts`'s cycle, never the request path. It requires zero CSP changes: a
server-only `fetch` from the worker process is never a browser-loaded resource, so no host was
added to any policy for this half of the vendor. `isMetaConversionsApiConfigured()` is provably
`false` this phase (no real access token exists — §4.3, the credential vault, hasn't shipped), so
`dispatchOne()` marks every row `SKIPPED_NO_CREDENTIAL` rather than attempting a call. Confirmed
live: a full worker cycle against the dev DB ran the new `marketing_conversion_dispatch` phase
cleanly (`{"dispatched":0,"skipped":0,"failed":0}` — zero pending rows in the dev DB — and no
crash), then the process was stopped cleanly with no orphaned state.

**Client pixel, only because Meta has no server-side equivalent for `PageView`.** `MetaPixel.tsx`
loads `fbevents.js` and fires `PageView` only — never a conversion event, which stays server-side
per the paragraph above. It reads `useCookieConsent()` from the existing
`src/lib/marketing/cookie-consent.ts` (extracted this vendor's work into a shared
`useSyncExternalStore` hook so a second vendor can reuse the exact same consent check rather than
writing a second one) and only injects the script when consent is `"granted"`. Feature-flagged off
by default: BOTH `NEXT_PUBLIC_META_PIXEL_ENABLED="true"` AND a real `NEXT_PUBLIC_META_PIXEL_ID`
must be set — unset locally, unset in `render.yaml` (both `sync: false`) — so the pixel does not
load anywhere until an operator deliberately turns it on per environment.

**Attribution event, recorded server-side.** `POST /api/auth/signup` reads the request's own
`bw-cookie-consent` cookie and, only when it is `"granted"`, writes a `PENDING`
`MarketingConversionEvent(eventType: SIGNUP, vendor: "meta")` row via
`recordSignupConversionEvents()` — wrapped in its own try/catch so a failure here can never break
the signup response itself. Deliberately gated on the COOKIE consent signal, not
`User.marketingConsent` (the "may we email you" checkbox) — these are legally distinct GDPR/
ePrivacy consents that can vary independently for the same visitor; documented at length in
`conversion-events.ts`'s own comment and regression-tested explicitly (signup route suite's "is
independent of marketingConsent" case).

**CSP entries — public routes only, explicit hosts.** `META_PIXEL_CSP_HOSTS` in `meta.ts` is the
single source of truth `next.config.ts` imports: `script-src: https://connect.facebook.net`,
`connect-src`/`img-src: https://www.facebook.com`. No wildcard, no `'unsafe-eval'`, `default-src`
untouched. Live-verified: `/`, `/terms`, `/privacy` return the public CSP with exactly these hosts
present; `/login`, `/signup`, `/dashboard`, `/admin`, `/welcome`, `/unsubscribe`, and
`POST /api/analyze` all return the strict CSP with none of them present.

**Importability guarantee.** `MarketingPixels.tsx` (the aggregator `MetaPixel` is mounted through)
is imported only from the three public page files (`page.tsx`, `terms/page.tsx`,
`privacy/page.tsx`) — never any layout. `no-pixels-in-protected-layouts.test.ts` proves this
structurally: a regex-based import-graph walk from `DashboardLayout`, `AdminLayout`, and the root
layout, asserting zero pixel files are transitively reachable, plus a positive-control case
proving the same scanner DOES find the import starting from the homepage (so a "the scanner is
just broken" false negative can't hide a real regression). Verified with a live negative control:
temporarily added the pixel import to `DashboardLayout`, confirmed the test failed listing all
three transitively-imported files, reverted, confirmed green again.

## Gate status

- `npx tsc --noEmit`: clean.
- `npm run lint`: clean.
- `npm test` (unit): **758 passed**, 0 failed, across 54 files.
- `npm run test:integration`: **473 passed**, 0 failed, across 69 files.
- Live-verified against a real running dev server (restarted to pick up `next.config.ts` and the
  new pixel bundle):
  - CSP headers fetched for `/`, `/terms`, `/privacy`, `/login`, `/signup`, `/dashboard`, `/admin`,
    `/welcome`, `/unsubscribe`, `POST /api/analyze` — public routes carry Meta's hosts, every other
    route stays strict with none of them present.
  - `POST /api/analyze` (anonymous path) still streams correctly: `200`, `text/event-stream`, a
    `status` event followed by a real `error` event (Turnstile unconfigured locally — expected,
    unrelated to this change), strict CSP on the response.
  - Homepage's client JS chunk (`src_0hikru8._.js`) greped directly and confirmed to contain
    `MetaPixel`, `connect.facebook.net`, and `fbevents` — the pixel component is genuinely bundled,
    not dead code, even though it stays inert until both env vars are set (neither is, locally).
  - A full worker cycle ran the new dispatch phase with no crash (see above), then was stopped
    cleanly.

## No CSP entry for the server-side half — confirmed, not just claimed

Per the operator's instruction ("For any vendor you implement server-side, no CSP entry should be
needed at all; flag it if you find yourself adding one anyway."): `dispatchMetaConversionEvent()`
added zero directives to either CSP. The only two hosts in `META_PIXEL_CSP_HOSTS` back the
client-side `PageView` pixel specifically, which has no server-side equivalent for a page-load
event. Nothing to flag.

## Acceptance criteria — Vendor 1 (Meta) satisfied

- `/login` and `/signup` reverted to strict; signup attribution moved server-side with no loss of
  attribution value — both classification questions answered above, before any vendor code was
  written.
- `/pricing` confirmed non-existent, not classified by omission.
- CSP entries by explicit host only — no wildcard, no `'unsafe-eval'`, `default-src` unchanged —
  `next-config-headers.test.ts`, live-verified.
- Loads only after `cookie-consent.ts` (the existing module, reused, not duplicated) says granted.
- Feature-flagged off by default — both `NEXT_PUBLIC_META_PIXEL_ENABLED` and
  `NEXT_PUBLIC_META_PIXEL_ID` unset in every environment right now.
- Public pixel ID only — `META_CONVERSIONS_API_ACCESS_TOKEN` (the real secret) is declared in
  `render.yaml` but deliberately left unset pending §4.3.
- Server-side preferred where it exists (Conversions API, from the worker, not the request path);
  client pixel used only for `PageView`, which has no server-side equivalent.
- A test asserts no pixel component is importable from the dashboard or admin layouts —
  `no-pixels-in-protected-layouts.test.ts`, negative-control-confirmed.
- Public pages render, the SSE stream on `/api/analyze` still works, all gates pass — verified
  live in that order, per the operator's explicit per-vendor process, before this report was
  written.

## What's still open — as of Vendor 1 (Meta)

- Everything already open as of Step 1 (BASIC's price, SerpAPI's real cost tier, no admin
  permission-grant UI, the Milestone 11 Render staging deploy verification, `/terms`/`/privacy`
  placeholder content, `AdminAuditLog.metadata` not generically PII-scrubbed) — unchanged.
- TikTok, LinkedIn, X, Google Ads/GA4 — not started. Per instruction, each is added one at a time,
  with its own report, on further explicit instruction to proceed.
- §4.3 (credential vault) — not started. Until it exists, `META_CONVERSIONS_API_ACCESS_TOKEN` has
  nowhere safe to be configured, so Meta's server-side dispatch will keep marking every event
  `SKIPPED_NO_CREDENTIAL` in every real environment, indefinitely, by design (never a silent no-op
  — every skip is a real, queryable row).
- §4.4 (campaign surface) — not started.
- The Meta pixel has never been exercised against a real Meta Pixel ID / real Facebook domain —
  only structurally verified (bundled JS, correct CSP hosts, correct consent gating). A real
  end-to-end check (real ID, real browser, Meta's own pixel-helper tooling confirming the event
  actually arrives) is an operator action, not something this environment can do without a real
  Meta Business account.

---

# Phase 4 §4.2, Step 2 — Vendors, one at a time: Vendor 2 (Google Ads + GA4)

Per the operator's "add vendors ONE AT A TIME... report after each vendor" instruction: this
covers ONLY Google. TikTok, LinkedIn, and X have not been started.

## Two carry-over questions from the Meta review, answered before any Google code was written

**1. Does `MarketingConversionEvent` store any email or hashed email?** No. Confirmed by reading
the schema (`prisma/schema.prisma`): the model has exactly one identifying column, `userId` — no
email, no hashed email, anywhere. This was deliberate from Vendor 1: the model's own doc comment
already states the "store the id, join at dispatch time" discipline (the same one the §4.1
audit-metadata addendum established), and both `dispatchMetaConversionEvent()` and the new
`dispatchGoogleConversionEvent()` are designed to look up whatever a real vendor call would need
(a hashed identifier, for instance) at dispatch time from a fresh DB read, never from a frozen
copy stored on the row. Account deletion never has to reach into this table.

**2. Does the `bw-cookie-consent` gate check marketing consent specifically, or just that the
banner was answered?** Specifically marketing/tracking consent. `recordSignupConversionEvents()`
checks `cookieConsent !== "granted"` (not `!== "unset"`), and the cookie itself is a true binary
— `CookieConsentBanner.tsx` offers exactly two buttons, Accept and Decline, no third
"essential-only" tier exists anywhere in this codebase's model. A user who declined, or never
answered, generates no conversion event, full stop. No change was needed to close this — it was
already correct from Vendor 1.

## Two scope decisions flagged before writing Google's CSP entries

The operator's brief listed four hosts to expect (`googletagmanager.com`, `google-analytics.com`,
`googleads.g.doubleclick.net`, and GA4's region-sharded collect endpoints) and explicitly said to
stop rather than wildcard the regional shards. Both of those anticipated complications were
designed around instead of implemented — flagged here for review, not silently decided:

**`googleads.g.doubleclick.net` — NOT added.** The client tag is configured with ONLY the GA4
measurement ID (`G-XXXXXXX`), never a Google Ads conversion ID (`AW-XXXXXXX`). gtag.js only
contacts `googleads.g.doubleclick.net` when an `AW-` id is present in its client-side config —
with a GA4-only config, the browser never talks to that host, so it needs no CSP entry at all.
Google Ads gets its conversion data by linking the GA4 property to a Google Ads account in
Google's own console (external to this app) and importing the SAME server-side Measurement
Protocol events `dispatchGoogleConversionEvent()` sends — i.e. "prefer server-side conversions"
applied to both halves of this vendor pairing, not just GA4's. If a client-side Ads conversion
tag is genuinely wanted later, that is a new host and a new decision, not an oversight here.

**No region-sharded `google-analytics.com` host — NOT enumerated, and NOT wildcarded.** GA4's
default `www.google-analytics.com` endpoint is what every property uses unless "EU Data
Boundary" (a specific, paid-tier, opt-in GA4 admin setting) is turned on, in which case hits go
to a `regionN.google-analytics.com` shard instead. Google does not publish a fixed, stable list
of these hosts, so enumerating them would have been a guess that could silently go stale — and a
wildcard (`*.google-analytics.com`) is explicitly out per this phase's non-negotiables. The CSP
therefore supports only the default endpoint. This fails CLOSED, not open: if EU Data Boundary is
ever enabled for this property, its hits get CSP-blocked (a dropped network request, not a broken
page) until someone deliberately adds that specific host here. A disclosed constraint, not an
oversight — flagged explicitly for the operator to correct if this property does need EU Data
Boundary support.

## What was built

**Server-side path preferred, exactly mirroring Meta's CAPI pattern.**
`dispatchGoogleConversionEvent()` (`src/lib/marketing/pixels/google.ts`) is the PROVIDER SEAM for
GA4's Measurement Protocol — called only from `scripts/worker.ts`'s cycle, never the request
path. Per the operator's explicit steer ("Prefer Measurement Protocol server-side for
conversions... exactly as Meta's CAPI path works"), this uses GA4's own Measurement Protocol, not
a separate Google Ads API integration — a materially simpler credential shape (one API secret,
not OAuth2 developer-token/refresh-token/customer-id). It requires zero CSP changes, same
reasoning as Meta: a server-only fetch from the worker process is never a browser-loaded
resource. `isGoogleMeasurementProtocolConfigured()` checks `GOOGLE_MEASUREMENT_PROTOCOL_API_SECRET`
(a real secret, unset this phase — §4.3 hasn't shipped) AND `NEXT_PUBLIC_GA4_MEASUREMENT_ID`
(reused from the client config, deliberately — Measurement Protocol hits must target the same GA4
property as the client tag to unify in reporting, and that ID was never a secret to begin with).
Confirmed live: a full worker cycle ran the (now two-vendor) dispatch phase cleanly with no
crash.

**Client tag, only for what genuinely has no server-side equivalent.** `GooglePixel.tsx` loads
`gtag.js` and fires only the automatic `page_view` GA4's `gtag('config', ...)` sends — never a
conversion event, which stays server-side per the paragraph above. It reads the SAME
`useCookieConsent()` hook Meta's pixel already reuses (no second consent check written), and only
injects the script when consent is `"granted"`. Feature-flagged off by default:
`NEXT_PUBLIC_GA4_MEASUREMENT_ENABLED` and `NEXT_PUBLIC_GA4_MEASUREMENT_ID` are both unset
everywhere right now (`.env.example`, `render.yaml`, both `sync: false`).

**CSP entries — public routes only, explicit hosts, two vendors now.**
`GOOGLE_PIXEL_CSP_HOSTS` (`google.ts`) is the single source of truth `next.config.ts`'s
`VENDOR_CSP_HOSTS` array imports: `script-src: https://www.googletagmanager.com`,
`connect-src: https://www.google-analytics.com`. No `img-src` entry — unlike Meta's pixel (which
has a `<noscript><img>` fallback), gtag.js sends its collect hits via `fetch()`/`sendBeacon()`,
both governed by `connect-src` per the CSP spec, not `img-src`. No wildcard, no `'unsafe-eval'`,
`default-src` untouched. Live-verified: `/`, `/terms`, `/privacy` now carry BOTH vendors' hosts;
every protected/auth route (`/login`, `/signup`, `/dashboard`, `/admin`, `/welcome`,
`/unsubscribe`, `POST /api/analyze`) still resolves to the strict policy with neither vendor's
hosts present.

**Importability guarantee — no test change needed.** `GooglePixel.tsx` lives under
`src/components/marketing/pixels/`, the same directory `no-pixels-in-protected-layouts.test.ts`
already walks structurally (by directory, not a hardcoded per-vendor file list) — the existing
test covers the new vendor automatically. Verified anyway with a live negative control:
temporarily imported `GooglePixel` into `DashboardLayout`, confirmed the test failed listing both
`GooglePixel.tsx` and `google.ts` by real path, reverted, confirmed green again.

## Gate status

- `npx tsc --noEmit`: clean.
- `npm run lint`: clean.
- `npm test` (unit): **772 passed**, 0 failed, across 55 files (+14 for `google.test.ts`).
- `npm run test:integration`: **474 passed**, 0 failed, across 69 files (+1 net: PII/dispatch
  tests widened to cover two vendors, plus one new Google-specific FAILED-path test).
- Live-verified against a real running dev server (restarted to pick up `next.config.ts` and the
  new pixel bundle):
  - CSP headers fetched for `/`, `/terms`, `/privacy`, `/login`, `/signup`, `/dashboard`,
    `/admin`, `/welcome`, `/unsubscribe`, `POST /api/analyze` — public routes now carry BOTH
    Meta's and Google's explicit hosts, every other route stays strict with neither present, and
    `googleads.g.doubleclick.net`/any region-sharded host is absent everywhere, as designed.
  - `POST /api/analyze` (anonymous path) still streams correctly: `200`, `text/event-stream`, a
    `status` event followed by a real `error` event (Turnstile unconfigured locally — expected,
    unrelated to this change), strict CSP on the response.
  - Homepage's client JS chunk greped directly and confirmed to contain `GooglePixel`,
    `googletagmanager.com`, and `google-analytics.com` alongside the existing Meta strings — both
    vendors' pixel components are genuinely bundled, not dead code.
  - A full worker cycle ran the two-vendor dispatch phase with no crash, then was stopped
    cleanly.

## No CSP entry for the server-side half — confirmed, not just claimed

Same non-negotiable as Vendor 1: `dispatchGoogleConversionEvent()` added zero directives to
either CSP. The only host group in `GOOGLE_PIXEL_CSP_HOSTS` backs the client-side `page_view` tag
specifically, which has no server-side equivalent for a page-load event. Nothing to flag beyond
the two scope decisions already called out above.

## Acceptance criteria — Vendor 2 (Google Ads + GA4) satisfied

- Both carry-over questions from the Meta review confirmed, not re-litigated with new code — no
  PII in `MarketingConversionEvent`, cookie gate already specific to marketing consent.
- CSP entries by explicit host only — no wildcard, no `'unsafe-eval'`, `default-src` unchanged —
  `next-config-headers.test.ts` (generalized to loop over all configured vendors), live-verified.
- Two flagged scope decisions (no `googleads.g.doubleclick.net`, no region-sharded collect host)
  reported explicitly rather than decided silently, per the operator's own "stop and tell me"
  instruction for the wildcard-tempting case specifically.
- Loads only after `cookie-consent.ts` (the existing module, reused again, not duplicated) says
  granted.
- Feature-flagged off by default — both `NEXT_PUBLIC_GA4_MEASUREMENT_ENABLED` and
  `NEXT_PUBLIC_GA4_MEASUREMENT_ID` unset in every environment right now.
- Public measurement ID only — `GOOGLE_MEASUREMENT_PROTOCOL_API_SECRET` (the real secret) is
  declared in `render.yaml` but deliberately left unset pending §4.3.
- Server-side preferred where it exists (GA4 Measurement Protocol, from the worker, not the
  request path, exactly mirroring Meta's CAPI path); client tag used only for `page_view`, which
  has no server-side equivalent.
- The existing "no pixel component is importable from the dashboard or admin layouts" test
  covers the new vendor with no changes needed (directory-based scan) — negative-control-
  confirmed live for this vendor specifically.
- Public pages render, the SSE stream on `/api/analyze` still works, all gates pass — verified
  live in that order, per the operator's explicit per-vendor process, before this report was
  written.

## What's still open — as of Vendor 2 (Google)

- Everything already open as of Vendor 1 (BASIC's price, SerpAPI's real cost tier, no admin
  permission-grant UI, the Milestone 11 Render staging deploy verification, `/terms`/`/privacy`
  placeholder content, `AdminAuditLog.metadata` not generically PII-scrubbed) — unchanged.
- TikTok, LinkedIn, X — not started. Per instruction, each is added one at a time, with its own
  report, on further explicit instruction to proceed.
- §4.3 (credential vault) — not started. Until it exists, neither
  `META_CONVERSIONS_API_ACCESS_TOKEN` nor `GOOGLE_MEASUREMENT_PROTOCOL_API_SECRET` has anywhere
  safe to be configured, so both vendors' server-side dispatch will keep marking every event
  `SKIPPED_NO_CREDENTIAL` in every real environment, indefinitely, by design.
- §4.4 (campaign surface) — not started.
- The GA4 tag has never been exercised against a real measurement ID / real Google Analytics
  property — only structurally verified (bundled JS, correct CSP hosts, correct consent gating).
  A real end-to-end check (real ID, real browser, GA4's own DebugView confirming the event
  actually arrives) is an operator action, not something this environment can do without a real
  Google Analytics property.
- If this property will ever need GA4's EU Data Boundary feature, `GOOGLE_PIXEL_CSP_HOSTS` needs
  a deliberate, explicit region host added — flagged above as a disclosed scope constraint, not
  a bug, but a real gap if that feature is ever turned on without updating this file.
- If a client-side Google Ads conversion tag (as opposed to server-side GA4 Measurement Protocol
  import) is ever specifically wanted, `googleads.g.doubleclick.net` needs its own CSP entry and
  its own client-side wiring — a new, separate decision, not something this vendor's work covers.

## Operational tripwire — read this BEFORE debugging a GA4 traffic drop

**If GA4 traffic ever drops to zero after a property setting change, check for CSP-blocked
`regionN.google-analytics.com` requests (browser devtools Network/Console tab, or the site's own
CSP violation reports if one is ever wired up) before debugging anything else** — a wrong
consent-gating theory, a broken `gtag.js` load, a wrong measurement ID, etc. The single most
likely cause of a sudden, total GA4 outage in THIS app specifically is an operator turning on
GA4's "EU Data Boundary" setting in the Google Analytics admin console: the client tag would keep
loading and firing normally, but every collect request would silently redirect to a
`regionN.google-analytics.com` shard this CSP does not allow — dropped by the browser, not
reported as a GA4-side error, and easy to mistake for "the pixel stopped working" rather than
"the CSP is (correctly) blocking an endpoint nobody told this file about." The fix, once
confirmed, is to add the specific region host actually in use to `GOOGLE_PIXEL_CSP_HOSTS` in
`src/lib/marketing/pixels/google.ts` — not to widen the CSP generally, and never a wildcard.

---

# Phase 4 §4.2, Step 2 — Vendors, one at a time: Vendor 3 (TikTok)

Per the operator's "add vendors ONE AT A TIME... report after each vendor" instruction: this
covers ONLY TikTok. LinkedIn and X have not been started — the operator's own instruction after
this vendor was to assess a vendor-registry refactor rather than start LinkedIn next (see the
assessment section below), and NOT to refactor without explicit agreement.

## Scope scrutiny applied, same discipline as Vendor 2

TikTok's own integration docs/tutorials mention `business-api.tiktok.com` (the Events API's own
host) and occasional region-specific mirrors for advertiser accounts. Neither is in
`TIKTOK_PIXEL_CSP_HOSTS`:

**`business-api.tiktok.com` — NOT added.** That is the Events API's own host — reached only from
the worker with a real access token, never the browser, per the same "prefer server-side, no CSP
entry needed" reasoning as Meta's Conversions API and GA4's Measurement Protocol.

**No region-specific pixel/collect host — NOT guessed.** This app has no real TikTok Pixel
provisioned yet, so there is no confirmed evidence any region variant is actually needed.
Guessing a host from memory risks either being wrong (silently CSP-blocked tracking) or
needlessly widening the CSP for a host never actually contacted. `analytics.tiktok.com` — the one
host with genuine, current-documentation confidence, used for both the loader script and the
events it reports — is the only host included. If a real Pixel ID's actual network requests are
ever observed going to a different host, that's a deliberate, explicit addition later, not
something to pre-guess.

## What was built

Mirrors the Meta/Google pattern exactly. **Server-side conversions**:
`dispatchTikTokConversionEvent()` (`src/lib/marketing/pixels/tiktok.ts`) is the PROVIDER SEAM for
TikTok's Events API, called only from the worker. `isTikTokEventsApiConfigured()` checks
`TIKTOK_EVENTS_API_ACCESS_TOKEN` (real secret, unset — §4.3 scope) AND
`NEXT_PUBLIC_TIKTOK_PIXEL_ID` (reused from the client config, same footgun-avoidance reasoning as
Google's measurement ID reuse). Needs zero CSP entries.

**Client pixel, pageview only**: `TikTokPixel.tsx` reads the same `useCookieConsent()` hook the
other two vendors already reuse, only loads after `"granted"`, feature-flagged off by both
`NEXT_PUBLIC_TIKTOK_PIXEL_ENABLED` and `NEXT_PUBLIC_TIKTOK_PIXEL_ID` being unset everywhere right
now. **One deliberate implementation simplification worth flagging**: TikTok's own published base
snippet pre-defines a `window.ttq` stub with internal queue bookkeeping (`_i`/`_t`/`_o`,
`setAndDefer`) so calls made before `events.js` loads get captured and replayed — an undocumented
implementation detail, unlike Meta's simple `callMethod`/`queue` pair or Google's
`dataLayer.push`, both of which are stable, documented public contracts. Since this component only
ever needs ONE call (`ttq.page()`, once), it sidesteps the queue entirely: inject the script, wait
for its own `onload`, then call `window.ttq.page()` directly — the loaded library defines a
complete, real `window.ttq` itself, so nothing needs pre-queuing. Documented in the component's
own comment as a deliberate deviation from TikTok's official snippet, not an oversight.

**CSP — one host, both directives, no `img-src`.** `TIKTOK_PIXEL_CSP_HOSTS` adds
`https://analytics.tiktok.com` to both `script-src` and `connect-src`. No `img-src` entry — same
reasoning as Google: TikTok's pixel reports events via `fetch()`/`sendBeacon()` (governed by
`connect-src`), not a documented `<noscript><img>` fallback the way Meta's pixel has.

**Importability guarantee — no test change needed**, same as Vendor 2: `TikTokPixel.tsx` lives
under the directory `no-pixels-in-protected-layouts.test.ts` already walks structurally. Verified
anyway with a live negative control — this time against `AdminLayout` rather than
`DashboardLayout` (broader coverage across the two prior vendors' checks): temporarily imported
`TikTokPixel` there, confirmed the test failed listing both `TikTokPixel.tsx` and `tiktok.ts` by
real path, reverted, confirmed green again.

## Gate status

- `npx tsc --noEmit`: clean.
- `npm run lint`: clean.
- `npm test` (unit): **786 passed**, 0 failed, across 57 files (+14 for `tiktok.test.ts`).
- `npm run test:integration`: **475 passed**, 0 failed, across 69 files (+1 net: dispatch tests
  widened to cover three vendors, plus one new TikTok-specific FAILED-path test).
- Live-verified against a real running dev server (restarted to pick up `next.config.ts` and the
  new pixel bundle):
  - CSP headers fetched for `/`, `/terms`, `/privacy`, `/login`, `/signup`, `/dashboard`,
    `/admin`, `/welcome`, `/unsubscribe`, `POST /api/analyze` — public routes now carry all THREE
    vendors' explicit hosts (including `analytics.tiktok.com`), every other route stays strict
    with none present, and `business-api.tiktok.com`/any region-specific TikTok host is absent
    everywhere, as designed.
  - `POST /api/analyze` (anonymous path) still streams correctly: `200`, `text/event-stream`, a
    `status` event followed by a real `error` event (Turnstile unconfigured locally — expected,
    unrelated to this change), strict CSP on the response.
  - Homepage's client JS chunk greped directly and confirmed to contain `TikTokPixel` and
    `analytics.tiktok.com` alongside the existing Meta/Google strings — all three vendors' pixel
    components are genuinely bundled, not dead code.
  - A full worker cycle ran the three-vendor dispatch phase with no crash, then was stopped
    cleanly.

## No CSP entry for the server-side half — confirmed, not just claimed

Same non-negotiable as the other two vendors: `dispatchTikTokConversionEvent()` added zero
directives to either CSP. Nothing to flag beyond the two scope decisions already called out above.

## Acceptance criteria — Vendor 3 (TikTok) satisfied

- CSP entries by explicit host only — no wildcard, no `'unsafe-eval'`, `default-src` unchanged —
  `next-config-headers.test.ts` (already generalized to loop over all configured vendors from
  Vendor 2), live-verified.
- Scope scrutiny applied and reported: `business-api.tiktok.com` (server-side host, never
  contacted by the browser) and any region-specific pixel host (no confirmed evidence needed)
  both left out, flagged explicitly rather than decided silently.
- Loads only after `cookie-consent.ts` (the existing module, reused a third time) says granted.
- Feature-flagged off by default — both `NEXT_PUBLIC_TIKTOK_PIXEL_ENABLED` and
  `NEXT_PUBLIC_TIKTOK_PIXEL_ID` unset in every environment right now.
- Public pixel ID only — `TIKTOK_EVENTS_API_ACCESS_TOKEN` (the real secret) is declared in
  `render.yaml` but deliberately left unset pending §4.3.
- Server-side preferred where it exists (TikTok Events API, from the worker, not the request
  path); client pixel used only for page view, which has no server-side equivalent.
- The existing "no pixel component is importable from the dashboard or admin layouts" test
  covers the new vendor with no changes needed — negative-control-confirmed live for this vendor
  specifically (against `AdminLayout` this time).
- Public pages render, the SSE stream on `/api/analyze` still works, all gates pass — verified
  live in that order, per the operator's explicit per-vendor process, before this report was
  written.

## What's still open — as of Vendor 3 (TikTok)

- Everything already open as of Vendor 2 (BASIC's price, SerpAPI's real cost tier, no admin
  permission-grant UI, the Milestone 11 Render staging deploy verification, `/terms`/`/privacy`
  placeholder content, `AdminAuditLog.metadata` not generically PII-scrubbed, GA4's EU Data
  Boundary scope constraint) — unchanged.
- LinkedIn, X — not started. The operator's explicit instruction after this vendor was to assess
  a vendor-registry refactor (see below), not to proceed to LinkedIn.
- §4.3 (credential vault) — not started. Until it exists, none of the three vendors' server-side
  secrets (`META_CONVERSIONS_API_ACCESS_TOKEN`, `GOOGLE_MEASUREMENT_PROTOCOL_API_SECRET`,
  `TIKTOK_EVENTS_API_ACCESS_TOKEN`) has anywhere safe to be configured, so all three keep marking
  every event `SKIPPED_NO_CREDENTIAL` in every real environment, indefinitely, by design.
- §4.4 (campaign surface) — not started.
- The TikTok pixel has never been exercised against a real Pixel ID / real TikTok account — only
  structurally verified (bundled JS, correct CSP hosts, correct consent gating, and the
  deliberate onload-based simplification described above). A real end-to-end check (real ID, real
  browser, TikTok's own Pixel Helper extension confirming the event actually arrives) is an
  operator action, not something this environment can do without a real TikTok Business account.
- If TikTok's real network behavior for a provisioned pixel ever turns out to need a second host
  (a regional mirror, a CDN alias), `TIKTOK_PIXEL_CSP_HOSTS` needs a deliberate, explicit addition
  — flagged above as a disclosed scope constraint, not a bug.

---

# Vendor-registry refactor assessment (requested after Vendor 3, before LinkedIn)

The operator asked for an assessment of whether Meta/Google/TikTok should collapse into one
vendor-registry array — hosts, env flags, client component, and server dispatch function all
declared per entry, with the CSP builder, pixel mounting, and import test all derived from it —
**with an explicit instruction not to refactor until agreed, and a stated preference for three
honest copies over one abstraction with exceptions if the three genuinely differ enough to need
escape hatches.**

**Recommendation: don't collapse into a registry. Keep three (soon four, soon five) separate
files.** The three implementations are structurally identical at the level a registry would
mechanize (each exports a CSP host object, an `is*Configured()` pair, a `dispatch*Event()`
PROVIDER SEAM, and a client component reading `useCookieConsent()`), but every one of the
non-mechanical parts — the part actually worth writing down — differs per vendor in a way a
registry would have to special-case:

- **The CSP host shape differs per vendor, not just its values.** Meta uses `img-src` (a
  `<noscript>` fallback); Google and TikTok explicitly don't (`fetch`/`sendBeacon` only,
  documented as a deliberate absence in each file). A registry's `hosts` field would need to
  either force every vendor to populate all three arrays (silently reintroducing the exact
  "img-src for a vendor that doesn't use it" mistake Google's and TikTok's own file comments
  argue against) or add a per-vendor "which directives does this vendor's transport actually use"
  flag — an escape hatch by another name.
- **The "what's deliberately left out and why" reasoning is the majority of each file's value,
  and it's vendor-specific prose, not data.** `googleads.g.doubleclick.net`/GA4 region shards
  (Google) and `business-api.tiktok.com`/TikTok region mirrors (TikTok) are different hosts, cited
  for different reasons, discovered by different scope-scrutiny passes. A registry entry's `hosts`
  field can encode what's *included*; it can't usefully encode a decision about what's
  *deliberately excluded and why* — that has to live in prose next to the vendor it's about, which
  is exactly what these three files already are.
- **The client component's queuing strategy is genuinely different per vendor, not incidental.**
  Meta's `callMethod`/`queue` stub, Google's `dataLayer.push`, and TikTok's onload-then-call (a
  deliberate deviation from TikTok's own undocumented queue internals, explained in
  `TikTokPixel.tsx`'s own comment) are three different integration strategies chosen because the
  three vendors' actual JS APIs differ, not three copies of one pattern. A registry that reduced
  "client component" to a slot in an array would still just be pointing at three separate
  component files — the abstraction wouldn't remove any code, only add a layer of indirection
  between "vendor list" and "the file that does the work."
- **The `is*Configured()` pairs already encode genuinely different eligibility rules.** Every
  vendor's server-side check reuses its own public client ID (footgun-avoidance, argued
  separately per file) — mechanically similar — but TikTok's and Google's both need a second
  env var (the public ID) *in addition to* the secret, while nothing here is actually uniform
  enough to hang a single generic `isConfigured(vendor)` function off of without an
  if/else per vendor inside it — which is just the current three functions, renamed and
  concatenated into one file.
- **What a registry WOULD mechanize — the `VENDOR_CSP_HOSTS` array in `next.config.ts`, the
  `MarketingPixels` JSX list, and the vendor loop in `conversion-events.ts`'s `dispatchOne()` —
  is already exactly that: three short, flat, one-line-per-vendor lists.** Collapsing three
  one-line array entries into one registry array doesn't reduce them further; it just moves the
  same three lines into a different file and adds a lookup indirection between "the vendor list"
  and "the vendor's actual CSP/component/dispatch function." There's no repeated *logic* to
  de-duplicate here, only a repeated *shape* — and the shape is already about as short as it can
  get (one array-of-three literal, one JSX list, one if-chain).

**What a registry would actually buy**: slightly shorter diffs when adding vendor 4/5 (one array
entry instead of touching `next.config.ts` + `MarketingPixels.tsx` + `conversion-events.ts`
separately) — a real but small win, and one that trades away the thing that's made this phase's
reviews tractable so far: each vendor's file is a complete, self-contained, independently
readable account of exactly what it does and doesn't touch, with its scope decisions argued right
next to the code they justify. Splitting that reasoning between a registry's data fields and each
vendor's own file — or worse, folding it into comments ON the registry entries — makes the "why"
harder to find, not easier, for a marginal reduction in three still-small wiring files.

**If this assessment is wrong**: the strongest case FOR a registry would be "we're about to add
several more vendors and the wiring-file churn is the actual bottleneck" — that's not true yet
(two additions, LinkedIn and X, are what's left, not ten), and revisiting this after those two are
built (with five real examples instead of three) would be a better-informed moment to decide, if
the operator still wants to reconsider then.

No refactor has been made — this is assessment only, per the explicit instruction not to touch
the three vendors' structure without agreement. **Resolution**: the operator's next instruction
("Proceed with Vendor 4 — LinkedIn, then Vendor 5 — X") did not adopt the registry — Vendors 4-5
below are built as the same fourth/fifth honest copy, per the assessment's recommendation.

## Import-test structural property — confirmed, not changed

Before LinkedIn was built, the operator asked to confirm whether
`no-pixels-in-protected-layouts.test.ts` enumerates the three pixel components by name or works
structurally by directory — "if it enumerates, make it structural." **Confirmed already
structural, no change needed.** `pixelFilesIn()` filters the walked import graph by directory
membership (`marketing/pixels/`) and a filename prefix (`MarketingPixels`) — it never names
`MetaPixel`/`GooglePixel`/`TikTokPixel` anywhere. This had already been proven empirically twice,
via the live negative controls run for Vendor 2 and Vendor 3 (a new pixel file was caught with
zero test changes both times) — this is the one property a registry would have given "for free"
that the test already has by construction. LinkedIn's own negative control (below) is the third
confirmation.

---

# Phase 4 §4.2, Step 2 — Vendors, one at a time: Vendor 4 (LinkedIn)

Per the operator's "add vendors ONE AT A TIME... report after each vendor" instruction: this
covers ONLY LinkedIn. X has not been started — see the assessment in the next section before its
own build begins.

## The split was pre-confirmed by the operator, not derived here

"LinkedIn's Insight Tag has no meaningful server-side equivalent for pageview, but its
Conversions API does exist for conversions — same split as the other three." Taken as given —
this vendor's design didn't need to re-derive the client/server split the way Meta's original
report did.

## What was built

Mirrors the Meta/Google/TikTok pattern, with one genuine structural difference flagged rather
than glossed over: **LinkedIn's CSP needs TWO directives on its collect host, not one.**
`LINKEDIN_PIXEL_CSP_HOSTS` (`src/lib/marketing/pixels/linkedin.ts`) lists `px.ads.linkedin.com`
in both `connect-src` AND `img-src` — LinkedIn's own documented Insight Tag snippet includes a
real `<noscript><img>` fallback (`https://px.ads.linkedin.com/collect/?pid=...&fmt=gif`), the
same pattern Meta's pixel uses, unlike Google's/TikTok's fetch/sendBeacon-only tags which
deliberately have no `img-src` entry at all. `snap.licdn.com` (the separate script-loader host)
only needs `script-src`. This is Meta's own treatment applied a second time for a genuinely
matching reason (a real documented noscript fallback), not a default copied without checking.

**Server-side conversions**: `dispatchLinkedInConversionEvent()` is the PROVIDER SEAM for
LinkedIn's Conversions API, called only from the worker. `isLinkedInConversionsApiConfigured()`
checks `LINKEDIN_CONVERSIONS_API_ACCESS_TOKEN` (real secret, unset — §4.3 scope) AND
`NEXT_PUBLIC_LINKEDIN_PARTNER_ID` (reused from the client config, same footgun-avoidance
reasoning as the other vendors — flagged honestly in the file's own comment that a real
integration will likely also need a separate Conversion Rule ID, a detail deferred to §4.3 along
with every other vendor's exact request shape). Needs zero CSP entries.

**Client pixel**: `LinkedInPixel.tsx` reads the same `useCookieConsent()` hook the other three
vendors already reuse, only loads after `"granted"`, feature-flagged off by both
`NEXT_PUBLIC_LINKEDIN_PIXEL_ENABLED` and `NEXT_PUBLIC_LINKEDIN_PARTNER_ID` being unset everywhere
right now. Unlike TikTok, LinkedIn's own base snippet (`_linkedin_data_partner_ids.push(...)` +
the `lintrk`/`lintrk.q` queue stub) is small, stable, and publicly documented — faithfully
reproduced rather than simplified, the same confidence level as Meta's/Google's snippets. No
explicit "track a page view" call exists or is needed: pushing the partner ID and loading
`insight.min.js` is what triggers LinkedIn's own page-view report.

**Importability guarantee — no test change needed** (confirmed structural above). Verified with a
live negative control against the ROOT layout this time (broader coverage than Vendor 2's
`DashboardLayout` check and Vendor 3's `AdminLayout` check — all three protected entry points are
now each individually negative-control-proven across the four vendors built so far): temporarily
imported `LinkedInPixel` there, confirmed the test failed listing both `LinkedInPixel.tsx` and
`linkedin.ts` by real path, reverted, confirmed green again.

## Gate status

- `npx tsc --noEmit`: clean.
- `npm run lint`: clean.
- `npm test` (unit): **799 passed**, 0 failed, across 58 files (+13 for `linkedin.test.ts`).
- `npm run test:integration`: **476 passed**, 0 failed, across 69 files (+1 net: dispatch tests
  widened to cover four vendors, plus one new LinkedIn-specific FAILED-path test).
- Live-verified against a real running dev server (restarted to pick up `next.config.ts` and the
  new pixel bundle):
  - CSP headers fetched for `/`, `/terms`, `/privacy`, `/login`, `/signup`, `/dashboard`,
    `/admin`, `/welcome`, `/unsubscribe`, `POST /api/analyze` — public routes now carry all FOUR
    vendors' explicit hosts (`snap.licdn.com` in script-src, `px.ads.linkedin.com` in both
    connect-src and img-src), every other route stays strict with none present.
  - `POST /api/analyze` (anonymous path) still streams correctly: `200`, `text/event-stream`, a
    `status` event followed by a real `error` event (Turnstile unconfigured locally — expected,
    unrelated to this change), strict CSP on the response.
  - Homepage's client JS chunk greped directly and confirmed to contain `LinkedInPixel` and
    `snap.licdn.com` alongside the existing Meta/Google/TikTok strings — all four vendors'
    pixel components are genuinely bundled, not dead code.
  - A full worker cycle ran the four-vendor dispatch phase with no crash, then was stopped
    cleanly.

## No CSP entry for the server-side half — confirmed, not just claimed

Same non-negotiable as the other three vendors: `dispatchLinkedInConversionEvent()` added zero
directives to either CSP.

## Acceptance criteria — Vendor 4 (LinkedIn) satisfied

- CSP entries by explicit host only — no wildcard, no `'unsafe-eval'`, `default-src` unchanged,
  the two-directive `img-src`+`connect-src` treatment justified by a real documented noscript
  fallback (not a default) — `next-config-headers.test.ts`, live-verified.
- Loads only after `cookie-consent.ts` (the existing module, reused a fourth time) says granted.
- Feature-flagged off by default — both `NEXT_PUBLIC_LINKEDIN_PIXEL_ENABLED` and
  `NEXT_PUBLIC_LINKEDIN_PARTNER_ID` unset in every environment right now.
- Public partner ID only — `LINKEDIN_CONVERSIONS_API_ACCESS_TOKEN` (the real secret) is declared
  in `render.yaml` but deliberately left unset pending §4.3.
- Server-side preferred where it exists (LinkedIn Conversions API, from the worker, not the
  request path); client tag used only for page view, which has no server-side equivalent — the
  split confirmed by the operator before this vendor was built.
- The existing "no pixel component is importable from the dashboard or admin layouts" test
  covers the new vendor with no changes needed — negative-control-confirmed live against the root
  layout this time.
- Public pages render, the SSE stream on `/api/analyze` still works, all gates pass — verified
  live in that order, per the operator's explicit per-vendor process, before this report was
  written.

## What's still open — as of Vendor 4 (LinkedIn)

- Everything already open as of Vendor 3 (BASIC's price, SerpAPI's real cost tier, no admin
  permission-grant UI, the Milestone 11 Render staging deploy verification, `/terms`/`/privacy`
  placeholder content, `AdminAuditLog.metadata` not generically PII-scrubbed, GA4's EU Data
  Boundary scope constraint) — unchanged.
- X — assessed next, not yet built (see below).
- §4.3 (credential vault) — not started. Until it exists, none of the four vendors' server-side
  secrets has anywhere safe to be configured, so all four keep marking every event
  `SKIPPED_NO_CREDENTIAL` in every real environment, indefinitely, by design.
- §4.4 (campaign surface) — not started.
- The LinkedIn Insight Tag has never been exercised against a real partner ID / real LinkedIn
  Campaign Manager account — only structurally verified (bundled JS, correct CSP hosts, correct
  consent gating). A real end-to-end check is an operator action requiring a real LinkedIn
  Campaign Manager account.
- LinkedIn's Conversions API's real request shape likely needs a Conversion Rule ID in addition
  to the partner ID and access token — flagged in `linkedin.ts`'s own comment as a §4.3-scope
  detail not yet modeled, since the PROVIDER SEAM never reaches a real request this phase anyway.

---

# Phase 4 §4.2, Step 2 — Vendors, one at a time: Vendor 5 (X) — necessity assessment, PARTIAL build

Per the operator's explicit instruction: "check whether the pixel is actually needed at all
before building it. If X's conversion API covers what we'd want and the client tag only adds
pageview telemetry we already get from GA4, say so and I will skip it." **This section presents
that assessment BEFORE any client-side code was written, and the client pixel has deliberately
NOT been built pending the operator's decision on it.** Only the uncontroversial half — X's
server-side Conversions API dispatch — is built and verified below.

## The assessment

**Conversion attribution (signup): X's Conversions API covers this exactly as well as the other
four vendors' server-side APIs do.** No disagreement here — `dispatchXConversionEvent()` is built
below, unconditionally, the same PROVIDER SEAM pattern as Meta/Google/TikTok/LinkedIn.

**Pageview/retargeting-audience telemetry: the premise as stated does not technically hold.**
GA4's pageview data is not visible to X's ad platform — it is a completely separate vendor silo,
the same way Meta/Google/TikTok/LinkedIn's own telemetry streams don't cross into each other.
"The client tag only adds pageview telemetry we already get from GA4" would be true only if GA4
data somehow fed X's own audience-building/retargeting system, and it doesn't — no ad platform
consumes another platform's client-side analytics. This is exactly the reason Meta's, Google's,
TikTok's, and LinkedIn's own client pixels were built in the first place (per this milestone's
own doc: "Client pixels only where there is no server-side equivalent" — an anonymous visitor has
no server-observable identity to attach a useful retargeting event to, so ONLY a client-side
pixel can build an X-specific "people who visited this page" audience). Nothing about X makes
this platform structurally different from the other four in that respect.

**A second, independent reason for caution exists, and it's NOT the one asked about**: this
assessment has meaningfully LOWER confidence in the exact current hosts a real X pixel would need
than any of the other four vendors did. X's ad-tech infrastructure (`static.ads-twitter.com`,
`analytics.twitter.com` in the historically documented snippet) predates the platform's rename
from Twitter to X, and there is no way to confirm from here whether those domains are still
current or have since moved to `x.com`-branded hosts. Every other vendor's hosts in this
milestone were built from long-stable, still-current documentation; X's specifically carry a real
risk of being stale. This is a DIFFERENT concern from the one the operator asked about (it's
about confidence in implementation correctness, not about redundancy with GA4), but it's relevant
to the same decision, so it's surfaced here rather than glossed over.

**Conclusion reported, not decided unilaterally**: the stated premise (GA4 redundancy) does not
hold on inspection — so this is not a case where "say so and I will skip it" applies as framed.
If the pixel is skipped, the more honest grounds would be either a business call (X ad spend
isn't planned) or the hosts being too uncertain to commit to safely — either is the operator's
call, not a technical inevitability this assessment can resolve on its own. **The client pixel
has not been built.** Awaiting direction: build it (with the host-naming caveat flagged for
verification against a real X Ads pixel snippet before ever enabling it), or skip it, or defer
until a real X Ads account can confirm the actual current hosts.

## What was built (server-side only)

Mirrors the other four vendors' PROVIDER SEAM pattern exactly. `dispatchXConversionEvent()`
(`src/lib/marketing/pixels/x.ts`) is called only from the worker, needs zero CSP entries (trivially
true right now — there is no client-side code of any kind for this vendor).
`isXConversionsApiConfigured()` checks `X_CONVERSIONS_API_ACCESS_TOKEN` (real secret, unset —
§4.3 scope) AND `X_PIXEL_ID`. **`X_PIXEL_ID` is deliberately NOT `NEXT_PUBLIC_`-prefixed**, unlike
every other vendor's identifier — it is read only server-side right now, since no client code
exists to read it. If a client pixel is ever built, this becomes a rename to
`NEXT_PUBLIC_X_PIXEL_ID` (never a secret to begin with), not a new variable — noted explicitly in
the file's own comment so the eventual change is recognized as a rename, not new scope.

`recordSignupConversionEvents()` now writes a `PENDING` row for `"x"` unconditionally at every
consenting signup, regardless of the client-pixel decision — the conversion-tracking half was
never in question.

## Gate status

- `npx tsc --noEmit`: clean.
- `npm run lint`: clean.
- `npm test` (unit): **803 passed**, 0 failed, across 59 files (+4 for `x.test.ts`).
- `npm run test:integration`: **477 passed**, 0 failed, across 69 files (+1 net: dispatch tests
  widened to cover five vendors, plus one new X-specific FAILED-path test). One run hit an
  infrastructure-level `vitest-worker: Timeout calling "onTaskUpdate"` (a worker-communication
  timeout, not a real assertion failure) while other tool calls were running concurrently against
  the machine; re-ran clean immediately after with no code changes — a flake, not a regression.
- Live-verified against the already-running dev server (no restart needed — `next.config.ts` is
  unchanged, since X added no CSP entries at all):
  - Confirmed the CSP on `/` is byte-identical to the post-LinkedIn state — no `x.com`/
    `twitter.com`/`ads-twitter.com` host anywhere, exactly as expected for a vendor with no
    client-side code yet.
  - `POST /api/analyze` (anonymous path) still streams correctly: `200`, `text/event-stream`,
    same behavior as every prior vendor's check.
  - A full worker cycle ran the five-vendor dispatch phase with no crash, then was stopped
    cleanly.

## No CSP entry — trivially true this vendor, not yet a tested guarantee

Every other vendor's "no CSP entry for the server-side half" claim was verified against a real
CSP that DOES contain that vendor's client-side hosts (proving the server half specifically adds
nothing beyond them). X's CSP claim is currently unfalsifiable in the same way, since there is no
client-side code to compare against — noted so this isn't mistaken for the same category of
verification the other four vendors received.

## What's still open — as of Vendor 5 (X), PARTIAL

- Everything already open as of Vendor 4 (BASIC's price, SerpAPI's real cost tier, no admin
  permission-grant UI, the Milestone 11 Render staging deploy verification, `/terms`/`/privacy`
  placeholder content, `AdminAuditLog.metadata` not generically PII-scrubbed, GA4's EU Data
  Boundary scope constraint) — unchanged.
- **X's client pixel — an open decision, not a deferred implementation detail.** Awaiting the
  operator's direction per the assessment above.
- §4.3 (credential vault) — not started. Until it exists, none of the five vendors' server-side
  secrets has anywhere safe to be configured, so all five keep marking every event
  `SKIPPED_NO_CREDENTIAL` in every real environment, indefinitely, by design.
- §4.4 (campaign surface) — not started.
- X's Conversions API's real request shape (endpoint, auth scheme, matching identifiers) has not
  been researched to the same confidence level as the other vendors' — deferred to §4.3 along
  with every other vendor's exact request shape, so this carries no additional risk THIS phase,
  but is worth a real look whenever §4.3 is scoped.
