# Milestone 12 — Freemium model, extended RBAC, admin analytics, marketing integrations

Follow-on to Milestone 11 (`docs/milestone-11-security-rbac-promos.md`). Same ground rules:
phase by phase, typecheck/lint/unit/integration green before advancing, every behavioural
change tested, pure policy modules stay Prisma-free, one implementation per rule, additive
migrations only, completion report at the end.

**Read `docs/milestone-11-completion-report.md` first.** Three items in this milestone
directly modify security fixes shipped there. Do not undo them by accident — each is called
out explicitly below.

---

## Blocking decisions — get answers before writing code

Do not start Phase 1 until the repository owner has answered these. Record the answers in
the doc itself.

- **D1 — Free trial anchor.** Does the 30-day free monitoring window run from *account
  creation* or from *when the user adds their first watch*? Recommended: account creation
  (`User.freeTrialEndsAt = createdAt + 30d`). Per-watch anchoring lets a user sign up, wait
  60 days, then start a fresh 30-day window, and gives no fixed date to convert against.
- **D2 — Repeat analysis.** Does re-analyzing a store the user already analyzed within the
  last 24h consume a second daily credit? Recommended: no. Charge once per
  `(userId, storeId)` per 24h window.
- **D3 — Anonymous analysis.** Milestone 11 fix 1.4 made `POST /api/analyze` require
  sign-in. This milestone reinstates anonymous access at 3/24h. Confirm, and confirm whether
  Cloudflare Turnstile is acceptable on the anonymous form (strongly recommended — an
  IP-keyed quota is one VPN hop from unlimited).
- **D4 — Prices.** `BASIC` monthly price (currently a `$19` placeholder), and whether
  `ANNUAL` is real in V1 or dropped. `BUSINESS` is confirmed at `$49/mo`.
- **D5 — Business cap behaviour.** At the 100/day cap, does the request hard-fail with an
  error, or soft-throttle (queue/slow)? Recommended: hard-fail with a message that does not
  contradict the marketing copy — see the "unlimited" note in Phase 1.

---

# Phase 1 — Entitlement model rework

The current entitlement model does not express what the product now needs. Two independent
axes replace one.

## 1.1 Final plan matrix

Update `src/lib/entitlements/plan-limits.ts`. This table is the single source of truth;
nothing else in the codebase may hardcode any of these numbers.

| | Anonymous | `FREE` | `BASIC` | `BUSINESS` |
|---|---|---|---|---|
| Analyses per rolling 24h | 3 | 10 | 50 | 100 |
| Analysis result depth | preview | full | full | full |
| Concurrently monitored stores | 0 | 1 | 20 | 50 |
| Monitoring duration | — | 30 days from signup | continuous | continuous |
| Historical access | no | no | yes | yes |
| Advanced intelligence | no | no | no | yes |
| Price | — | $0 | D4 | $49/mo |

`BUSINESS` is marketed as "Unlimited — fair use, up to 100 stores/day". Implement the cap as
100 and make the user-facing copy state the fair-use number. Do not ship copy that says
"unlimited" with no qualifier while the code enforces a hard limit: it is the kind of claim
that draws consumer-protection scrutiny in the EU/UK, it goes badly in chargeback disputes,
and the users who hit it are the highest-intent ones you have.

Add to the `PlanLimits` type: `maxAnalysesPer24h: Limit` (null = unlimited, unused today but
keep the type honest) and `freeTrialDays: Limit`. Keep the existing `Limit` semantics where
`null` means unlimited — do not introduce a second sentinel.

## 1.2 `AnalysisUsage` becomes a windowed ledger

This is the significant change. Today `AnalysisUsage` has `@@unique([userId, storeId])` and
answers "how many distinct stores has this user ever analyzed". The product now needs "how
many analyses has this user run in the last 24 hours".

- Migration: drop the unique constraint on `(userId, storeId)`. Add
  `@@index([userId, createdAt])` — the quota query's covering index.
- The table becomes append-only: one row per analysis run.
- New service function in `src/lib/entitlements/analysis-usage.ts`:
  `countAnalysesInWindow(prisma, userId, windowHours)`.
- **Preserve `hasAnalyzedStore()`.** Milestone 11's `resolveStoreAccess()` depends on it and
  it gates report access on all five store routes. It becomes an `EXISTS` query rather than
  a unique-row lookup — same answer, and it still works with duplicate rows. Add
  `@@index([userId, storeId])` (non-unique) so it stays fast.
- **Preserve the advisory-lock pattern.** `recordAnalysisUsage()` currently uses
  `pg_advisory_xact_lock` so two concurrent requests from a user with one credit left cannot
  both consume it. That race is unchanged by the switch to a time window — keep the lock,
  keep the count-inside-the-transaction ordering. Carry the existing concurrency integration
  test over and adapt it rather than deleting it.
- Per D2, if repeat analyses are free: inside the same transaction, check for an existing row
  with the same `(userId, storeId)` inside the window and skip the insert if found. The lock
  makes this safe.
- Sweep rows older than 30 days in the worker tick (they are no longer needed for quota once
  outside the window, but keep 30 days for the admin analytics in Phase 3).

## 1.3 Anonymous analysis — reinstating 1.4 safely

Per D3. This partially reverses Milestone 11 fix 1.4, so it must be done deliberately.

- `POST /api/analyze` accepts anonymous callers again, capped at **3 per rolling 24h**, keyed
  on the client IP from the *fixed* `getClientIp()` (Milestone 11 fix 1.1 — the pre-fix
  version would have made this quota free to bypass).
- Anonymous quota state must be DB-backed, not the in-memory limiter: a 24-hour window
  cannot live in a process that restarts. Add `AnonymousAnalysis { id, ipKey, storeId,
  createdAt }` with `@@index([ipKey, createdAt])`. Sweep rows older than 48h in the worker.
- **Turnstile** on the anonymous form (per D3). Verify the token server-side before the
  crawl. Fail closed: no token, no crawl. Add `TURNSTILE_SECRET_KEY` /
  `NEXT_PUBLIC_TURNSTILE_SITE_KEY` to `docs/environment-variables.md` and `render.yaml`.
- **Global circuit breaker.** A single counter of anonymous crawls started in the last hour,
  in the database. Above a configurable ceiling (`ANONYMOUS_CRAWL_HOURLY_CEILING`, default
  500), anonymous analysis returns 503 and only authenticated crawls proceed. This is the
  backstop for distributed abuse that per-IP quotas cannot see.
- Anonymous callers keep the existing `anonymous_preview` access level — 2–3 signals, no
  full report. That behaviour already exists in `run-analysis.ts`; do not widen it.
- Fix 1.5 stays intact: no `Store` row is written until the crawl proves the domain is a real
  Shopify store. Anonymous traffic must not be able to create rows.

## 1.4 Free trial and monitoring slots

- Add `User.freeTrialEndsAt DateTime?`, set at signup to `createdAt + 30 days` (per D1).
  Backfill existing users in the migration.
- A `FREE` user may hold **1** `ACTIVE` watch. The existing advisory-lock + COUNT check in
  `monitoring/watch.ts` already enforces "at most N" — feed it the new number from
  `plan-limits.ts`, do not write a second check.
- When `freeTrialEndsAt` passes, the user's active watch expires. Extend
  `expireDueWatches()` — it already sweeps on `monitoringExpiresAt`, so the cleanest
  implementation sets each `FREE` watch's `monitoringExpiresAt` to
  `min(freeTrialEndsAt, watchExpiry)` at creation time and changes nothing in the sweep.
  Prefer that over a second sweep path.
- `recomputeStoreTier()` must run for the affected store, as it does today.
- Upgrading from `FREE` to a paid plan must clear the trial ceiling on existing watches.
  Milestone 11's `expireDueSubscriptions()` already implements the downgrade cascade; this is
  its inverse and belongs next to it.

## 1.5 Upgrade prompts

When a limit is hit, the API must return a machine-readable reason the UI can turn into the
right prompt — not a generic 403.

```ts
{ code: "LIMIT_REACHED",
  limit: "ANALYSES_PER_DAY" | "MONITORED_STORES" | "TRIAL_EXPIRED",
  current: number, max: number,
  resetsAt?: string,          // for windowed limits
  upgradeTo: "BASIC" | "BUSINESS" }
```

UI work: the "monitor more stores" action on the dashboard is the primary conversion
surface. When a `FREE` user clicks it, show what `BASIC` (20) and `BUSINESS` (50) unlock,
with the price — do not show a bare error.

## Phase 1 acceptance criteria

- The plan matrix in 1.1 is asserted against a literal table in a unit test, every cell.
- The 11th analysis in 24h for a `FREE` user is rejected with `LIMIT_REACHED` and a correct
  `resetsAt`; the 10th succeeds.
- Two concurrent analyses from a user with one credit left produce exactly one (adapted
  Milestone 11 test).
- Per D2: a repeat analysis of an already-analyzed store within the window does/does not
  consume a credit, as decided.
- The 4th anonymous analysis from one IP in 24h is rejected; a spoofed `x-forwarded-for`
  does not reset it (regression test against fix 1.1).
- Anonymous analysis with no Turnstile token is rejected before any outbound fetch.
- A `FREE` user's watch expires when `freeTrialEndsAt` passes, and the store's tier
  recomputes.
- Upgrading `FREE` → `BASIC` lifts the trial ceiling on the existing watch.
- No `Store` row exists after an anonymous analysis of a non-Shopify domain (regression
  against fix 1.5).

---

# Phase 2 — Per-employee permission grants

Milestone 11 shipped six roles with fixed permission sets. The requirement now is that the
super admin configures access per employee. Extend, do not replace.

## 2.1 Effective permissions

Roles stay as the baseline. Add per-user grants on top.

```ts
// src/lib/admin/roles.ts — extend, keep the existing matrix intact
export function effectivePermissions(role: Role, grants: Permission[]): Set<Permission>
```

Effective set = `permissionsFor(role) ∪ grants`. **Additive only** — a grant can widen
access, never narrow it. Narrowing is done by changing the role. One direction is far easier
to reason about and to audit than two.

New model `AdminPermissionGrant { id, userId, permission String, grantedByUserId,
grantedAt, expiresAt DateTime?, revokedAt DateTime? }`, `@@unique([userId, permission])`
where `revokedAt IS NULL`. Expired and revoked grants are never deleted — the audit trail
must survive.

`requirePermission()` in `src/lib/admin/guard.ts` reads grants alongside the role. Because
Milestone 11's amended `jwt` callback already re-reads the DB on every request for any
non-`USER` role, grants are picked up immediately with no new staleness window — **keep that
property**. Do not cache grants in the token.

## 2.2 Protected permissions — never grantable

This is the "only I touch money" requirement, enforced in code rather than by convention.

```ts
export const SUPER_ADMIN_ONLY: readonly Permission[] = [
  "user:role:write",
  "promo:create", "promo:assign", "promo:revoke",
  "billing:provider:write",     // payment provider keys and configuration
  "billing:refund",
  "billing:payout:read",
  "integration:credentials:write",
  "permission:grant",
];
```

`grantPermission()` throws if the permission is in this list, regardless of who is asking —
including a `SUPER_ADMIN`. These are reachable *only* by holding the `SUPER_ADMIN` role
itself. That makes "can a non-super-admin ever touch payments?" answerable by reading one
array, which is the point.

Unit-test that every member of `SUPER_ADMIN_ONLY` is rejected by `grantPermission()` and that
no other role's baseline matrix contains any of them.

## 2.3 Role naming for the new org shape

The requirement is 2–3 manager roles and 6–7 marketing/ops roles. Do not add ten roles — that
is what grants are for. Add exactly two to the Milestone 11 set:

- `MARKETING_ADMIN` — `metrics:read`, `user:read`, `campaign:read`, `campaign:write`
- `MANAGER` — the union of `SUPPORT_ADMIN` and `OPS_ADMIN`, plus `audit:read`. This is the
  2–3 manager seats.

Everyone else gets a base role plus grants. Ten people can hold `MARKETING_ADMIN` with
different grants; that is one role, ten configurations.

New permissions this milestone: `campaign:read`, `campaign:write`, `integration:read`,
`integration:credentials:write`, `permission:grant`, `analytics:read`, `export:users`,
`billing:provider:write`, `billing:refund`, `billing:payout:read`.

## 2.4 Routes

- `GET /api/admin/users/[id]/permissions` — effective set, showing role-derived vs granted.
  Requires `user:read`.
- `POST /api/admin/users/[id]/permissions` — grant. Requires `permission:grant`
  (`SUPER_ADMIN` only). Body includes optional `expiresAt`. Rejects `SUPER_ADMIN_ONLY`.
- `DELETE /api/admin/users/[id]/permissions/[permission]` — revoke (sets `revokedAt`).
- Expire due grants in the worker tick.

All four write an audit row in the same transaction, per Milestone 11 §2.3. Carry over every
privilege-escalation invariant from §2.4 — in particular, an actor cannot grant a permission
to themselves.

---

# Phase 3 — Super admin analytics

A real dashboard, not a table dump. Everything read-only, everything behind
`analytics:read`.

## 3.1 Metrics that matter

Build these, in this order — they are the ones that change decisions:

**Funnel** — anonymous analysis → signup → first analysis → first watch → paid. Absolute
counts and conversion rate per step, over a selectable window. The anonymous→signup and
watch→paid steps are the two you will actually act on.

**Activation** — % of signups that run an analysis within 24h, and that add a watch within
7 days. If activation is low, pricing is not the problem.

**Revenue** — MRR, new/expansion/churned MRR, ARPU, active subscriptions by plan, promo-granted
vs paid subscriptions (Milestone 11's `Subscription.source` already distinguishes these).

**Retention** — signup-cohort retention by month; trial→paid conversion rate by cohort. Cohort
tables are the only honest way to see whether the product is improving or the top of funnel
is just growing.

**Usage and cost** — analyses/day by plan, crawl volume, crawl failure rate, and
**SerpAPI calls with their cost**. At `BUSINESS` = 100 analyses/day and $49/mo, per-analysis
vendor cost is the difference between a healthy margin and none. Surface cost per active
account.

**Operational** — scheduler lag (stores past `nextCrawlAt`), failure streaks, stores at
`DISABLED`, promo redemption counts.

## 3.2 Implementation

- All queries live in `src/lib/admin/analytics/`, one module per metric group, Prisma raw SQL
  with tagged templates (never `$queryRawUnsafe`), each with an integration test asserting
  against seeded fixtures.
- These are aggregate queries over the whole `Event`/`Crawl`/`AnalysisUsage` tables. Do not
  run them synchronously on page load. Compute into a `MetricSnapshot { id, metricKey,
  dimension, windowStart, windowEnd, value, computedAt }` table on a scheduled worker tick
  (hourly), and read snapshots from the dashboard. Add the raw queries first, then the
  snapshot layer.
- Server Components reading from snapshots. Charts with `recharts` (already a dependency).

## 3.3 User list and export

`GET /api/admin/users` gains search, plan/role filters, and sort — requires `user:read`.

`POST /api/admin/users/export` requires `export:users` (**not** `user:read` — bulk export is
a materially different act from looking someone up, and it should be separately grantable and
separately audited). It:

- Excludes `passwordHash`, session tokens, and all integration credentials. Assert this in a
  test that fails if a new sensitive `User` column is ever added without being excluded.
- Respects `marketingConsent` (Phase 4): an export flagged `purpose: "marketing"` returns
  only consented users. An export flagged `purpose: "support"` may include all, and is
  audited more loudly.
- Writes an audit row recording row count, filters, and purpose.

---

# Phase 4 — Marketing integrations and consent

## 4.1 Consent first — this gates everything else

Do not build the pixel layer before this. Retrofitting consent onto collected data is far
harder than collecting it correctly.

- `User.marketingConsent Boolean @default(false)`, `marketingConsentAt DateTime?`,
  `marketingConsentSource String?`.
- Signup has a **separate, unticked** checkbox for marketing email. It must not be bundled
  into ToS acceptance — bundled consent is not valid consent under GDPR, and the ToS
  checkbox stays mandatory while this one stays optional.
- `UnsubscribeToken` per user (or an HMAC of the user id with a dedicated secret), giving a
  one-click unsubscribe that requires no login. Legally required for marketing email in most
  jurisdictions.
- A cookie consent banner on public pages. **No non-essential pixel may load before consent.**
  This is the mechanism that makes 4.2 lawful in the EU/UK.
- Data export and deletion endpoints for the user themselves (GDPR Art. 15 and 17). Deletion
  must cascade correctly and leave audit rows intact with the user id replaced by a tombstone.

## 4.2 Pixels — public pages only

**Never load a third-party marketing script on `/dashboard` or `/admin`.** Those pages carry
session state, customer store data, and admin surfaces; a pixel there has full DOM access to
all of it. Scope the pixel layer to the marketing routes only, and add a test asserting no
pixel component is reachable from the dashboard or admin layouts.

- One `src/lib/marketing/pixels/` module per vendor (Meta, TikTok, LinkedIn, X, Google Ads +
  GA4), each behind a feature flag and a consent check.
- **CSP conflict — this is the thing that will break.** Milestone 11 fix 1.7 shipped an
  enforcing `default-src 'self'`. Each vendor needs specific `script-src`, `connect-src`, and
  `img-src` entries. Add them *per vendor, explicitly listed*, in `next.config.ts`. Do not
  widen to `*` or drop the header. Route-scope the loosened policy to public pages so
  `/dashboard` and `/admin` keep the strict policy — Next's `headers()` supports per-path
  matching.
- Prefer **server-side** conversion APIs where they exist — Meta Conversions API, TikTok
  Events API, Google Measurement Protocol. Better attribution under ad blockers, and no user
  data handed to a client-side script. Server-side events go out from the worker, not the
  request path.

## 4.3 Credential vault

API tokens for six ad platforms are the most valuable secrets in the system after
`DATABASE_URL`.

- `IntegrationCredential { id, platform, label, ciphertext, iv, authTag, createdByUserId,
  createdAt, rotatedAt, lastUsedAt }`.
- AES-256-GCM at rest, key from `INTEGRATION_ENCRYPTION_KEY` (32 bytes, base64), separate
  from `AUTH_SECRET`. Document the rotation procedure.
- **Plaintext is never returned by any API, ever.** Read endpoints return platform, label,
  last-4, and timestamps. Decryption happens only in the worker at call time.
- Write requires `integration:credentials:write` — a `SUPER_ADMIN_ONLY` permission (§2.2).
- Every decryption writes an audit row.

## 4.4 Campaign surface

Modest, and clearly separated from the credential layer: connected-account status per
platform, campaign performance read-through, and audience export gated on
`export:users` + consent. `campaign:write` covers actions that spend money — hold it back to
`MANAGER` and `SUPER_ADMIN` by default and grant it individually.

---

# Out of scope — do not build

- Stripe or any payment provider (the `// PROVIDER SEAM:` stub from Milestone 11 stays).
- Transactional or marketing **email sending** — consent capture and unsubscribe tokens are in
  scope, the sender is not. See the backlog note in the completion report.
- Redis. The in-memory limiter's multi-instance weakness stays documented, not solved.
- Changes to the diff engine, significance scoring, or crawl normalization.
- Any change that weakens a Milestone 11 fix other than 1.4, which is modified deliberately in
  §1.3 with compensating controls.
