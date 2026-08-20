# Milestone 11 — Security hardening, admin RBAC, and promo codes

You are working in the Bellwether repo (`ecommerce-intelligence-engine`): Next.js 16 App
Router, Prisma 5 + Postgres, Auth.js v5, Vitest. Two long-lived processes (`web` and
`worker`, see `render.yaml`) share one database. There is no queue and no Redis — claims
are done in SQL with `FOR UPDATE SKIP LOCKED`.

Read `CLAUDE.md`, `AGENTS.md`, and `README.md` first. Match the conventions already in the
codebase — do not invent new ones.

## Ground rules

1. **Work phase by phase.** Phases 1 → 2 → 3. After each phase: `npm run typecheck`,
   `npm run lint`, `npm test`, then `npm run db:test:up && npm run db:test:migrate &&
   npm run test:integration`. Do not start the next phase until the previous one is green.
   Stop and report if a phase can't be made green.
2. **Every behavioural change needs a test.** Pure logic → unit test next to the module in
   `__tests__/`. Anything touching Prisma → integration test using the existing harness
   (truncate in `beforeEach`, `.env.test`, the `DATABASE_URL` must contain `test` guard).
   Follow the shape of `src/lib/entitlements/__tests__/analysis-usage.integration.test.ts`.
3. **Keep the layering.** Pure policy modules stay Prisma-free and hand-mirror enums as
   string unions (the convention in `plan-limits.ts` and `monitoring/policy.ts`). Prisma
   access lives in service modules. Route handlers do auth + rate limit + parse + delegate,
   nothing else.
4. **One implementation per rule.** If a check exists somewhere, import it — never write a
   second copy that can drift.
5. **Comment the "why", not the "what."** This codebase documents rationale and known
   residual gaps in doc comments. Preserve that. When you accept a tradeoff, say so and say
   why, the way `ssrf-guard.ts` does at the bottom.
6. **Do not touch** `src/lib/diff/engine.ts`, `significance.ts`, `money.ts`, or
   `crawl/normalize.ts`. The change-detection core is out of scope.
7. **Migrations are additive.** One migration per phase, named as instructed. Never edit an
   existing migration in `prisma/migrations/`. No destructive column drops.
8. Update `docs/environment-variables.md` and `render.yaml` for any new env var, and write a
   completion report to `docs/milestone-11-completion-report.md` at the end summarising what
   changed, what was tested, and what residual risk remains.

---

# Phase 1 — Security hardening

Nine defects, in priority order. Each is a real finding against the current tree.

## 1.1 Client IP extraction is attacker-controlled

`src/lib/security/rate-limit.ts` → `getClientIp()` returns the **first** value in
`x-forwarded-for`. A client can prepend an arbitrary IP per request and get a fresh bucket,
so every rate limit in the app is one header away from being unlimited.

Fix: read the IP from the right-hand side, counting back a configured number of trusted
proxy hops.

- New env var `TRUSTED_PROXY_HOPS`, default `1` (Render puts exactly one proxy in front of
  the web service). `0` means "no proxy, use the socket peer, ignore XFF entirely".
- Parse the XFF list, validate each entry with `ipaddr.js` (already a dependency), drop
  malformed entries, then take the entry `TRUSTED_PROXY_HOPS` from the end. If the list is
  shorter than the hop count, the header is lying — fall back to `"unknown"` and treat that
  as one shared bucket.
- Never use `x-real-ip` as a fallback when a proxy is configured; it is equally spoofable
  and is only meaningful if your own proxy sets it.
- Keep the existing doc comment's honesty and update it to describe the new contract.

Unit-test the parser directly: single IP, spoofed prefix list, malformed entries, IPv6,
hop count 0/1/2, list shorter than hop count.

## 1.2 Credentials login has no rate limit and no lockout

`src/app/api/auth/[...nextauth]/route.ts` re-exports `handlers` with nothing in front of it,
so `POST /api/auth/callback/credentials` allows unlimited password guessing. Because
`verifyPassword` runs bcrypt at cost 12 (~250 ms of blocked CPU), this is also a
denial-of-service vector against a single-process web service.

Build `src/lib/security/login-throttle.ts`, backed by a **database table**, not the
in-memory limiter — lockout state must survive a restart and be shared across instances.

- New model `LoginAttempt` (see schema section). Track failures per normalized email and,
  separately, per client IP.
- Policy (pure, Prisma-free, in `src/lib/security/login-policy.ts` so it is unit-testable):
  progressive delay after 5 failures in 15 minutes, hard lock for 15 minutes after 10.
  Per-IP threshold is looser than per-email (a shared NAT is normal) — 30 failures in
  15 minutes.
- Wire it into the Credentials provider's `authorize()` in `src/lib/auth/auth.ts`. Auth.js
  v5 passes the request as the second argument — use it for the IP via the fixed
  `getClientIp`. Check the throttle **before** calling `verifyCredentials`, and record the
  outcome after. A successful login clears that email's failure rows.
- `authorize()` must return `null` for a locked account, never a distinguishable error —
  the response must be identical to a wrong password, or you have built an account-state
  oracle.
- Sweep rows older than 24h inside the existing worker tick (`scripts/worker.ts`), next to
  `sweepStaleCrawls`.

Also apply the in-memory limiter to the NextAuth route as a cheap first line: wrap the
exported `POST` so credential callbacks are limited to 10/minute per IP before Auth.js is
invoked at all. Leave `GET` unwrapped (session/provider reads are hot and harmless).

## 1.3 Store sub-routes have no auth and no entitlement gate

`GET /api/store/[domain]/report` gates full data behind `hasAnalyzedStore()`. But
`/events`, `/activity`, `/growth`, and `/marketing` call `getCurrentUser()` **not at all**.
Anyone who knows a domain can pull the change feed, growth signals, and the SerpAPI-derived
marketing intelligence anonymously. That makes the report endpoint's gate decorative and
gives away vendor-paid data for free.

Create `src/lib/auth/store-access.ts` as the single gate:

```ts
export type StoreAccess = "full" | "unanalyzed_preview" | "anonymous_preview";
export async function resolveStoreAccess(prisma, storeId, user): Promise<StoreAccess>
```

It reuses `hasAnalyzedStore()` — do not reimplement the check. Then:

- Refactor `report/route.ts` to use it, so there is one definition of access, not two.
- Apply it to `events`, `activity`, `growth`, and `marketing`. These four require
  `access === "full"`; anything else returns `401` when anonymous and `403` with
  `{ code: "STORE_NOT_ANALYZED" }` when signed in but unanalyzed. Do not return a partial
  payload from these four — they are all-or-nothing.
- Rate-limit key for authenticated callers becomes `userId`, not IP (per-account limits are
  not spoofable). Fall back to IP for anonymous callers.

Update `src/app/dashboard/stores/[domain]/page.tsx` and any component that fetches these
endpoints so the UI handles the new 401/403 instead of rendering an error panel.

## 1.4 Unauthenticated crawl trigger

`POST /api/analyze` accepts `caller === null` by design. Each accepted request fans out to
up to 60 paginated fetches plus review-page sampling, at 5 requests/minute/IP — and per 1.1
that IP key was spoofable. This is an open outbound-request relay.

- Require a signed-in user for `POST /api/analyze`. Return `401` with a clear message for
  anonymous callers.
- Keep the anonymous report *shape* (`access: "anonymous_preview"`) in `run-analysis.ts` —
  it is still reachable through `GET /api/store/[domain]/report` for already-crawled
  stores. Only the ability to *trigger a new crawl* becomes authenticated.
- Add a second limiter dimension keyed on `userId` (10/hour) alongside the per-IP one, so
  one account cannot burn the crawl budget from many IPs.

## 1.5 Unauthenticated writes to `Store`

`src/lib/analysis/run-analysis.ts` calls `prisma.store.upsert()` on the submitted domain
*before* the crawl proves it is a Shopify store. `Store.tier` defaults to `COLD` and
`nextCrawlAt` to `now()`, so every junk domain immediately enters the scheduler's
due-query.

Restructure `runAnalysis` so the crawl runs first and the `Store` row is created only after
`crawlShopifyStore` returns `status: "ok"`. The dedup-window check and the entitlement
pre-check currently depend on `store.id` existing — rework them:

- Dedup: look up an existing store by domain; if none exists there is no in-flight crawl to
  collide with, so skip the check.
- Entitlement pre-check: it is only a fast-fail optimisation (the authoritative gate is
  `recordAnalysisUsage` after the crawl). If the store does not exist yet, check the user's
  raw count against the limit without a store-specific `hasAnalyzedStore` lookup.

Add an integration test asserting that a domain that fails Shopify detection leaves zero
`Store` rows behind.

## 1.6 DNS rebinding between check and connect

`src/lib/security/ssrf-guard.ts` documents this gap honestly at the bottom of the file.
Close it.

Add `src/lib/security/pinned-fetch.ts`: resolve the hostname once, validate every returned
address with the existing `isPublicUnicast` logic, then perform the request against a
`fetch` bound to an undici `Agent` whose `connect.lookup` returns **only the already
validated address**. This removes the resolve-then-connect window entirely.

- Add `undici` as an explicit dependency (it is currently only transitive via Next).
- Export a `createPinnedFetch(validatedIps): FetchLike` that slots into the existing
  `fetchImpl` injection points in `crawl/shopify.ts` and `reviews/collect.ts` — do not
  change those modules' signatures, they already take `fetchImpl`.
- Keep `checkUrlIsSafeToFetch` as-is and reuse its address validation. Export the
  `isPublicUnicast` helper rather than duplicating it.
- Every redirect hop must re-pin, not just re-check. The manual redirect loop in
  `fetchWithTimeout` is already the right place.
- Replace the "known residual gap" comment with a description of what is now closed and
  what still isn't (e.g. a host that is genuinely public but hostile).

## 1.7 No security headers

`next.config.ts` sets only `reactStrictMode`. Add a `headers()` block covering all routes:

- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
- `Content-Security-Policy` — start with `default-src 'self'`, `frame-ancestors 'none'`,
  `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`. Next needs
  `script-src 'self' 'unsafe-inline'` unless you wire a nonce; do the simple version, and
  leave a comment stating the nonce upgrade is the next step. Report-only first if you
  prefer, but ship the enforcing header — say which you chose in the completion report.
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `X-Frame-Options: DENY`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`.

Verify the app still renders and the SSE stream on `/api/analyze` still works — CSP
`connect-src` must allow `'self'`.

## 1.8 JWT session cost and staleness

The `jwt` callback in `src/lib/auth/auth.ts` issues a `prisma.user.findUnique` on **every**
token refresh, i.e. on every authenticated request. Add a TTL: store `planCheckedAt` on the
token and re-read the user row at most once every 60 seconds. Keep the existing behaviour
that a plan change propagates without re-login — 60 seconds is fast enough.

Do **not** switch to database sessions. The Credentials provider is incompatible with them
and the tradeoff is already documented in the file. Instead, add a
`sessionsValidAfter DateTime?` column on `User`: the `jwt` callback rejects a token issued
before that timestamp, giving you a real "sign out everywhere" and a kill switch for a
compromised account. Set it from the admin API in Phase 2.

## 1.9 Smaller items

- **Signup enumeration**: `POST /api/auth/signup` returns a distinct `409` for an existing
  email. Keep the 409 (removing it without an email-verification flow makes the UX worse,
  not the system safer) but add a fixed minimum response time to both branches so timing
  does not additionally leak, and note the accepted risk in the completion report.
- **Password policy**: length-only at 8 chars. Raise the floor to 10, reject the top-1000
  common passwords via a small bundled list, and reject passwords containing the email
  local-part. Keep `isPasswordAcceptable` pure and unit-tested. Do not add composition rules
  (symbol/digit requirements) — they reduce real entropy.
- **Scheduler secret comparison**: `provided !== expected` in both
  `src/app/api/internal/scheduler/*/route.ts` is a non-constant-time comparison. Use
  `crypto.timingSafeEqual` on equal-length buffers, guarding the length check.

---

# Phase 2 — Admin RBAC

One super admin, five sub-admin roles. Roles are coarse; permissions are fine-grained;
routes check permissions, never role strings.

## 2.1 Policy module — `src/lib/admin/roles.ts`

Prisma-free, string unions, same convention as `plan-limits.ts`. This is the single source
of truth for "who can do what".

```ts
export type Role =
  | "USER"
  | "ANALYST"
  | "CONTENT_ADMIN"
  | "SUPPORT_ADMIN"
  | "BILLING_ADMIN"
  | "OPS_ADMIN"
  | "SUPER_ADMIN";

export type Permission =
  | "user:read"
  | "user:plan:write"
  | "user:role:write"
  | "user:suspend"
  | "promo:read"
  | "promo:create"
  | "promo:assign"
  | "promo:revoke"
  | "store:tier:write"
  | "crawl:trigger"
  | "crawl:retry"
  | "metrics:read"
  | "audit:read";
```

Grants:

| Role | Permissions |
|---|---|
| `USER` | none |
| `ANALYST` | `metrics:read` |
| `CONTENT_ADMIN` | `metrics:read`, `user:read` |
| `SUPPORT_ADMIN` | `metrics:read`, `user:read`, `user:suspend`, `crawl:retry` |
| `BILLING_ADMIN` | `metrics:read`, `user:read`, `user:plan:write`, `promo:read` |
| `OPS_ADMIN` | `metrics:read`, `user:read`, `store:tier:write`, `crawl:trigger`, `crawl:retry` |
| `SUPER_ADMIN` | all of the above, plus `user:role:write`, `promo:create`, `promo:assign`, `promo:revoke`, `audit:read` |

Note deliberately: **only `SUPER_ADMIN` can create, assign, or revoke promo codes, and only
`SUPER_ADMIN` can change anyone's role.** `BILLING_ADMIN` can read promos but not mint them
— minting a 100%-off code is equivalent to giving away the product, so it stays with one
role.

Export `hasPermission(role, permission)` and `permissionsFor(role)`. Unit-test the whole
matrix exhaustively — one test that asserts every role/permission pair against a literal
expected table, so an accidental grant widening fails loudly.

## 2.2 Guard — `src/lib/admin/guard.ts`

```ts
export async function requirePermission(permission: Permission): Promise<AdminActor>
```

Builds on `requireUser()` from `src/lib/auth/session.ts` — do not re-derive the session.
Throws `ForbiddenError` (new, alongside the existing `UnauthorizedError`) when the role
lacks the permission. Add a shared route helper that maps `UnauthorizedError` → 401 and
`ForbiddenError` → 403 with a JSON body matching the shape every other route uses.

Role comes from the session, which comes from the JWT — so extend `src/lib/auth/types.d.ts`
and both auth callbacks to carry `role`.

**Amendment (post-Phase-1 review) — privileged roles bypass the TTL cache.** The original
text of this section said `role` reuses `plan`'s 60-second TTL re-read (1.8). That is wrong
for privileged roles, and it's a spec error, not an implementation one: the TTL works by
comparing a `planCheckedAt` claim *inside the token itself*. An attacker who has forged a
token controls that claim too, and can simply keep it permanently fresh — the DB re-read
that would catch the forgery never fires. A forged `SUPER_ADMIN` token would never be
revalidated.

Corrected rule: if `token.role` is anything other than `"USER"`, the `jwt` callback
re-reads the user row on **every request** and overwrites `role` from the database,
ignoring `planCheckedAt` entirely. The 60-second TTL optimization applies only to `plan`,
and only when `role` is `"USER"`. Admin traffic is a rounding error in this app's request
volume — the extra query cost is irrelevant; the staleness window on a privileged role is
not. Add a test asserting that a token carrying `role: "SUPER_ADMIN"` for a user whose
database row actually says `"USER"` is rejected (role downgraded to what the database says,
at minimum — see guard.ts) on the very next request, with no delay and no dependence on
`planCheckedAt`.

A role revocation must take effect within 60 seconds without re-login for a `USER`-role
token (bounded by the `plan` TTL, unchanged from 1.8's mechanism); for any token already
carrying a privileged role, it takes effect on the very next request, unconditionally.

## 2.3 Audit log — `src/lib/admin/audit.ts`

Every mutating admin action writes an `AdminAuditLog` row **in the same transaction as the
change itself**. If the audit write fails, the change rolls back. Signature:

```ts
export async function recordAdminAction(tx, {
  actorId, action, targetType, targetId, metadata,
}): Promise<void>
```

`metadata` is JSON and must never contain secrets, password hashes, or full promo codes —
store the promo *id* and last 4 characters only.

`GET /api/admin/audit` requires `audit:read`, is cursor-paginated using the same
`getChangeFeed` cursor convention, and is append-only — no update or delete path exists
anywhere in the code.

## 2.4 Admin routes

All under `src/app/api/admin/`, all `runtime = "nodejs"`, all rate-limited keyed on
`userId`, all going through `requirePermission`:

- `GET  /api/admin/users` — search by email, paginated. `user:read`.
- `GET  /api/admin/users/[id]` — detail: plan, role, usage counts, watch counts. `user:read`.
- `PATCH /api/admin/users/[id]/plan` — `user:plan:write`. Reuses whatever `scripts/set-user-plan.ts` does; extract that into a service function so script and route share one implementation.
- `PATCH /api/admin/users/[id]/role` — `user:role:write`.
- `POST /api/admin/users/[id]/revoke-sessions` — sets `sessionsValidAfter = now()`. `user:suspend`.

### Privilege-escalation invariants (test each one explicitly)

1. An actor can never change **their own** role. Reject with 403 even for `SUPER_ADMIN`.
2. An actor can never grant a role they do not themselves hold. In practice only
   `SUPER_ADMIN` has `user:role:write`, but write the check generically so it stays true if
   the matrix changes.
3. The **last remaining `SUPER_ADMIN` cannot be demoted**. Enforce inside a transaction with
   `pg_advisory_xact_lock` on a fixed key, then a `COUNT` — the same pattern
   `recordAnalysisUsage` uses. A check-then-write here races into a zero-super-admin
   lockout.
4. `SUPER_ADMIN` cannot be granted through **any** HTTP route. It is bootstrap-only.
5. Signup must never accept a `role` field. Verify `POST /api/auth/signup` ignores unknown
   body keys — it currently picks fields explicitly, so confirm and add a regression test.

### Bootstrap — `scripts/grant-admin.ts`

Follows the `scripts/set-user-plan.ts` pattern. Takes an email and a role, requires direct
`DATABASE_URL` access, and is the **only** way to mint the first `SUPER_ADMIN`. Refuses to
run without an explicit `--confirm` flag. Writes an audit row with a synthetic actor id of
`"system:bootstrap"`.

---

# Phase 3 — Promo codes and checkout

There is **no payment provider in this repo today** — `plan-limits.ts` says billing is
deliberately unmodelled, and `PricingSection.tsx` is presentational. So build the promo and
checkout domain provider-agnostically, and make the 100%-discount path fully functional
end-to-end (it needs no provider at all). Leave a single clearly marked seam where Stripe
session creation goes.

## 3.1 Server-side price table — `src/lib/billing/pricing.ts`

Prisma-free. Integer cents only — reuse the conventions in `src/lib/money.ts`, never floats.

```ts
export type BillingPeriod = "MONTHLY" | "ANNUAL";
export function listPriceCents(plan: PlanTier, period: BillingPeriod): number
```

`FREE` is 0 and is not purchasable. Put real placeholder numbers in and comment that they
are placeholders pending the billing decision in
`docs/milestone-10-subphase-b-billing-and-freemium-decision-report.md`.

**The client never sends a price.** It sends `{ plan, period, code? }` and the server
returns the computed total. Any design where the browser supplies an amount is a
vulnerability, not a shortcut.

## 3.2 Code generation and normalization — `src/lib/billing/promo-code.ts`

- `generatePromoCode()`: 12 characters from Crockford base32 (no I/L/O/U), from
  `crypto.randomBytes` — never `Math.random`. That is ~60 bits, enough that guessing is not
  a threat even before rate limiting.
- `normalizePromoCode(input)`: uppercase, strip whitespace and dashes. The unique index is
  on the normalized form so `abc-def` and `ABCDEF` cannot both exist.
- Admin may supply a vanity code (e.g. `LAUNCH50`); validate it against
  `^[A-Z0-9]{4,32}$` after normalization and reject codes that collide.

## 3.3 Validation and redemption — `src/lib/billing/promo.ts`

Two separate functions. Keep them separate — this distinction is the whole design.

```ts
// Read-only. Safe to call from a preview endpoint. Never mutates.
export async function evaluatePromo(prisma, { code, userId, plan, period }): Promise<PromoEvaluation>

// Mutating. Transactional. The only place a redemption row is ever written.
export async function redeemPromo(tx, { promoId, userId, checkoutId, amounts }): Promise<void>
```

`PromoEvaluation` is a discriminated union: `{ ok: true, promoId, listPriceCents,
discountCents, finalCents }` or `{ ok: false, reason }` where `reason` is one of
`not_found | expired | not_yet_valid | disabled | exhausted | already_redeemed |
not_assigned_to_you | wrong_plan`.

Rules:

- **Discount is always computed server-side** from `listPriceCents()`. Clamp: `discountCents
  = Math.min(discountCents, listPrice)` so a fixed-amount promo can never produce a negative
  total or a refund.
- `PERCENT` type: integer 1–100, `Math.floor(listPrice * pct / 100)`. 100 is legal and is
  the "free access" case the super admin needs.
- **Assigned promos**: when `assignedToUserId` is set, only that user may redeem it. Return
  `not_assigned_to_you` — but return exactly the same HTTP status and shape as `not_found`
  at the route layer, so the endpoint cannot be used to probe which codes exist.
- **Redemption is atomic.** Inside the transaction: `pg_advisory_xact_lock(hashtext('promo:'
  || promoId)::bigint)`, then count existing redemptions, then check `maxRedemptions` and
  `perUserLimit`, then insert. Identical pattern to `recordAnalysisUsage`. A unique index on
  `(promoCodeId, userId)` backs up the per-user limit at the database level.
- Never mutate a `PromoCode` row's discount terms after creation. To change terms, disable
  and mint a new one — an immutable promo means a redemption row's recorded amounts can
  always be reconciled.

## 3.4 Checkout — `src/lib/billing/checkout.ts` and routes

- `POST /api/billing/promo/validate` — signed-in only, rate-limited hard
  (**10/hour per user**; this is the brute-force surface, treat it like a login). Calls
  `evaluatePromo` and returns the price preview. Mutates nothing.
- `POST /api/billing/checkout` — signed-in only. Body `{ plan, period, code? }`.
  Server computes the total, then branches:
  - **`finalCents === 0`** → in one transaction: create `Checkout` with status `COMPLETED`,
    `redeemPromo(...)`, upgrade `User.plan`, create the `Subscription` row with
    `source: "PROMO"`, and write an audit row. Return the granted plan. No provider involved.
  - **`finalCents > 0`** → create `Checkout` with status `PENDING` holding the plan, period,
    promo id and computed amounts, and return its id. **Do not redeem the promo here** — the
    redemption happens only when payment confirms, or a failed card burns the user's code.
    Mark the provider seam with a single `// PROVIDER SEAM:` comment and a stub
    `createProviderSession()` that currently throws `NotImplementedError`.
  - Expire `PENDING` checkouts older than 1 hour in the worker sweep.
- Recompute the price from the stored `Checkout` at confirmation time; never trust the
  amount that round-tripped through the client.

**Amendment (post-Phase-2 review) — subscription expiry and downgrade cascade.** The
original text of this section created a `Subscription` with `expiresAt` and stopped there.
Nothing ever read it. A 100%-off promo intended as a fixed-duration trial would grant its
plan *permanently*, because `User.plan` is what every entitlement check actually reads and
nothing downgrades it when `expiresAt` passes. This must be closed before 3.4 is considered
built, not treated as follow-up work:

- Add `expireDueSubscriptions()` to the worker tick, next to `expireDueWatches()` and
  modeled on it directly (same shape, same file layout). In one transaction per user: find
  `Subscription` rows where `expiresAt < now()` and `status` is `ACTIVE`, set `User.plan`
  back to `FREE`, mark the subscription `EXPIRED`, and write an audit row with actor
  `"system:expiry"` (same synthetic-actor convention as `scripts/grant-admin.ts`'s
  `"system:bootstrap"`).
- **Downgrading cascades.** A user dropping from a paid plan to `FREE` may hold more
  `ACTIVE` watches than `maxActiveMonitoredStores(FREE)` allows. In the *same* transaction,
  expire the excess — oldest `monitoringStartedAt` retained, the rest set to `EXPIRED` —
  then call `recomputeStoreTier()` for each affected store so the scheduler stops crawling
  stores nobody watches anymore. Reuse the existing helpers in `monitoring/watch.ts`; do not
  write a second expiry path that could drift from `expireDueWatches()`'s own.
- A `Subscription` with `expiresAt: null` is perpetual and is never swept — the same
  NULL-comparison behavior `expireDueWatches()` already relies on for `FREE`'s non-expiring
  monitor. An admin creating a promo must therefore choose explicitly: a promo with no
  duration grants the plan forever, not "forgot to set an expiry."
- `Subscription` needs a `status` field for the sweep to query against — see the schema
  amendment below (`SubscriptionStatus`).
- Add `durationDays Int?` to `PromoCode` so `SUPER_ADMIN` sets the grant length at mint
  time (`POST /api/admin/promos`, section 3.5); carry it to `Subscription.expiresAt` at
  redemption (`now() + durationDays`, or `null` if `durationDays` is `null`).
- Tests (add to this phase's suite, not deferred): expiry reverts `User.plan` to `FREE`; a
  paid user with `maxActiveMonitoredStores(BASIC)` active watches downgrades to exactly
  `maxActiveMonitoredStores(FREE)` retained (oldest-first) and the rest `EXPIRED`; every
  affected store's tier is recomputed; a `null`-expiry subscription survives the sweep
  untouched.

## 3.5 Admin promo routes

- `POST /api/admin/promos` — `promo:create` (SUPER_ADMIN only). Body: optional vanity code,
  `discountType`, `discountValue`, `appliesToPlan` (nullable = any), `maxRedemptions`
  (nullable = unlimited), `perUserLimit` (default 1), `validFrom`, `validUntil`,
  `assignedToUserId` (nullable). Validate ranges hard: percent 1–100, fixed ≥ 1 cent,
  `validUntil > validFrom`. Returns the full code **once** in the response.
- `GET /api/admin/promos` — `promo:read`. Lists with redemption counts. Shows the full code
  (an admin who can read promos can already use them; masking here is theatre).
- `POST /api/admin/promos/[id]/assign` — `promo:assign`. Sets `assignedToUserId`. This is
  the "give a promo to someone" flow.
- `POST /api/admin/promos/[id]/revoke` — `promo:revoke`. Sets status `DISABLED`. **Never
  deletes** — existing redemptions must stay reconcilable. Revoking does not claw back a
  plan already granted; say so in the response and the completion report.

## 3.6 UI

Minimal, matching the existing component style in `src/components/`:

- A promo input on the pricing/checkout surface that calls `/api/billing/promo/validate` and
  shows the recomputed total. Show a single generic failure message for all rejection
  reasons — do not surface `reason` to the browser verbatim, it leaks code existence.
- An `/admin` area gated on `role !== "USER"` in the layout, with a promo list/create form
  and a user search. Server Components, reading role from the session — no client-side
  role checks deciding what data is fetched.

---

# Schema changes

Three migrations, one per phase. Generate with `npx prisma migrate dev --name <name>`.

**Phase 1** — `20260820_security_hardening`:
- `User.sessionsValidAfter DateTime?`
- `model LoginAttempt { id, emailNormalized String?, ipKey String?, succeeded Boolean, createdAt DateTime @default(now()) }` with `@@index([emailNormalized, createdAt])` and `@@index([ipKey, createdAt])`.

**Phase 2** — `20260820_admin_rbac`:
- `enum Role { USER ANALYST CONTENT_ADMIN SUPPORT_ADMIN BILLING_ADMIN OPS_ADMIN SUPER_ADMIN }`
- `User.role Role @default(USER)`, indexed.
- `model AdminAuditLog { id, actorId String, actorEmail String, action String, targetType String, targetId String?, metadata Json?, createdAt }` with `@@index([actorId, createdAt])` and `@@index([targetType, targetId])`. `actorEmail` is denormalized on purpose: the log must stay readable after a user row is deleted.

**Phase 3** — `20260820_promos_and_checkout`:
- `enum DiscountType { PERCENT FIXED }`
- `enum PromoStatus { ACTIVE DISABLED }`
- `enum CheckoutStatus { PENDING COMPLETED EXPIRED FAILED }`
- `enum SubscriptionSource { PROMO PROVIDER MANUAL }`
- `enum SubscriptionStatus { ACTIVE EXPIRED }` — added by the 3.4 amendment above, so `expireDueSubscriptions()` has something to query (`status: ACTIVE, expiresAt: { lt: now }`) and mark (`EXPIRED`) without relying on a nullable-`expiresAt` comparison alone.
- `model PromoCode { id, code String @unique, discountType, discountValue Int, appliesToPlan PlanTier?, maxRedemptions Int?, perUserLimit Int @default(1), validFrom DateTime, validUntil DateTime?, status PromoStatus @default(ACTIVE), assignedToUserId String?, createdByUserId String, durationDays Int?, createdAt, ... }` — `durationDays` added by the 3.4 amendment: null means the granted plan never expires (perpetual), a caller must choose explicitly, never fall into it by omission.
- `model PromoRedemption { id, promoCodeId, userId, checkoutId String?, listPriceCents Int, discountCents Int, finalCents Int, createdAt }` with `@@unique([promoCodeId, userId])` and `@@index([promoCodeId])`.
- `model Checkout { id, userId, plan, period, promoCodeId String?, listPriceCents, discountCents, finalCents, status, createdAt, completedAt DateTime? }`
- `model Subscription { id, userId, plan, source SubscriptionSource, status SubscriptionStatus @default(ACTIVE), startedAt, expiresAt DateTime?, createdAt }` with `@@index([userId])` and `@@index([status, expiresAt])` (the sweep's own query shape — added by the 3.4 amendment).

All money columns are `Int` cents. No `Float`, no `Decimal`, anywhere.

---

# Acceptance criteria

Phase 1:
- Spoofed `x-forwarded-for` cannot mint a fresh rate-limit bucket (test).
- 10 wrong passwords locks the account for 15 minutes; the locked response is byte-identical to a wrong-password response (test).
- All four store sub-routes return 401 anonymous / 403 unanalyzed (test each).
- `POST /api/analyze` returns 401 anonymous (test).
- A non-Shopify domain leaves zero `Store` rows (integration test).
- A DNS lookup returning a private address mid-redirect is refused (test with an injected `dnsLookup`).
- Security headers present on a page response and on an API response (test).

Phase 2:
- The full role×permission matrix matches the literal table (test).
- Self-role-change, last-super-admin demotion, and `SUPER_ADMIN` grant over HTTP are each rejected (three tests).
- Every mutating admin route writes exactly one audit row, and a forced failure of the audit write rolls the change back (test).
- Role revocation takes effect within 60 seconds without re-login for a `USER`-role token; for a token already carrying a privileged role, on the very next request, unconditionally (test — see the 2.2 amendment above).
- A forged token carrying `role: "SUPER_ADMIN"` for a user whose database row says `"USER"` is rejected on the very next request, with no delay (test).

Phase 3:
- A 100% promo grants the plan with zero payment-provider involvement (integration test).
- Two concurrent redemptions of a `maxRedemptions: 1` promo produce exactly one redemption (integration test, same shape as the existing concurrent-analysis-usage test).
- A user cannot redeem the same promo twice (unique index + test).
- A promo assigned to user A returns the identical response to a nonexistent code when user B tries it (test).
- (3.4 amendment) A subscription past `expiresAt` reverts `User.plan` to `FREE` on the next
  sweep (test).
- (3.4 amendment) A paid user holding `maxActiveMonitoredStores(BASIC)` active watches, on
  expiry, downgrades to exactly `maxActiveMonitoredStores(FREE)` retained (oldest
  `monitoringStartedAt` first) and the rest `EXPIRED` — asserted against the actual
  `plan-limits.ts` constants, not a hardcoded number (test).
- (3.4 amendment) Every store affected by the cascade has its tier recomputed via the
  existing `recomputeStoreTier()` (test).
- (3.4 amendment) A `Subscription` with `expiresAt: null` survives the sweep untouched,
  indefinitely (test).
- A fixed-amount promo larger than the list price yields `finalCents === 0`, never negative (test).
- No route accepts a client-supplied price (grep and assert by review).

---

# Out of scope — do not build

- Stripe or any real payment integration beyond the marked seam.
- Email sending, email verification, or password reset.
- Redis or any shared cache. The in-memory limiter stays as-is for non-auth routes; its
  multi-instance weakness is already documented in the file and should stay documented.
- Refunds, proration, invoicing, tax.
- Changes to the diff engine, significance scoring, or crawl normalization.

# Manual step for the operator — not for you

The repository owner must rotate `AUTH_SECRET`, `DATABASE_URL`, and `SERPAPI_API_KEY`: a
`.env` containing live values was shared outside the repo. Rotating `AUTH_SECRET`
invalidates all existing JWTs, which is the desired effect. Add a line to the completion
report reminding them, but do not attempt to rotate anything yourself.
