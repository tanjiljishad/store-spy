# B2 — Move Store Spy's identity and session issuance into the control plane

Executes step B2 of `store-spy-rebrand-and-control-plane.md`, on branch
`control-plane/b2-auth-to-control-plane`. Follows B1 (schema split + entitlements
endpoint, merged). **B2 can break login** — this document is the plan and the
cutover order, reviewed before anything is applied.

## Decisions taken into this plan (operator, post-B1)

| # | Decision |
|---|---|
| Q1 | **Repoint in place.** NextAuth stays inside the Store Spy Next app; its adapter, callbacks, and the JWT refresh read `control_plane.*`. `AUTH_SECRET` and JWT signing are unchanged. A standalone control-plane auth *service* is B4, not B2. |
| Q2 | **Staff split deferred to B2.5.** `role` stays in the JWT with the existing "privileged role → always re-read" branch. Admin tooling has one user and can wait. Admin-analytics raw SQL is **not** reworked in B2. |
| Q3 | **`Subscription` + `Checkout` move to `control_plane` in B2.** Two subscription tables during the gate rewire is how they drift. `PromoCode` / `PromoRedemption` stay in `store_spy` — they are product-specific (they grant Store Spy `PlanTier`s, carry `durationDays` for a Store Spy plan, and are redeemed through `checkout.ts` which sets Store Spy's plan). The promo↔checkout link is already a nullable `String`, not a FK, so nothing breaks crossing the schema line. |
| Q4 | **`store_spy.Account` (OAuth identities) → renamed `store_spy.OAuthAccount`, stays in Store Spy.** Shared OAuth identity is a Find Suppliers problem, not B2's. |
| Q5 | **`tosAcceptedAt` → `control_plane.users`** (terms are accepted with the company). **Marketing consent stays per-product in `store_spy`** — Store Spy consent is not Find Suppliers consent; merging them is a consent problem, not a modelling convenience. |
| Q6 | **No entitlements cache.** The 60-second plan-staleness window is being deleted on purpose; a per-request cache reintroduces it. One indexed same-Postgres query per gate. Revisit with a profile, never on principle. |

## Cutover sequence (approved)

Steps 1–4 and 6 are B2. Step 5 is B2.5. Each step is independently testable.

| Step | What | Reversible? | Breaks |
|---|---|---|---|
| **1** | Additive migration + backfill. `control_plane.users` gains identity columns; `accounts`/`users`/`subscriptions`/`entitlements` backfilled from `store_spy.User`; new `store_spy` homes for `role` and marketing consent, backfilled. **No FK changes** — a `store_spy.* → control_plane.users` FK would require every `userId` to already have a `control_plane.users` row, which nothing but the backfill provides until step 2 writes there. `store_spy.User` untouched and still authoritative. | **Yes** — `down.sql` drops the additions. | nothing. Login still runs entirely off `store_spy.User`; the full test suite is green with this applied. |
| **2** | Identity + session + gates + billing move to `control_plane`, as one cutover (`plan` is load-bearing across all three and can't be half-migrated). Delivered as **2·A** (additive: signup/adapter write `control_plane.users` + a shadow `store_spy.User`; billing dual-writes) → **migration M** (swap the `userId` FKs to `control_plane.users`, names reused) → **2·B** (`plan` leaves the JWT; gates call the entitlements endpoint; `plan-limits.ts` deleted; shadow write + `User.plan` dual-write dropped). Folds in the old "step 3". **See "Step 2 — detailed plan" below.** | 2·A reversible; M reversible pre-2·B; 2·B hard. `store_spy.User` data still present. | **login** + gating — full auth suite, a real `next start` sign-in (Credentials + OAuth), and a pre-cutover JWT still authorising post-2·B. |
| **3** | Repoint gates (`run-analysis.ts`, `watch.ts`, `dashboard/summary.ts`, `stores/[domain]/page.tsx`) to the entitlements endpoint. `plan-limits.ts` gutted. `Subscription` + `Checkout` moved to `control_plane`. | Hard. | **analysis + monitoring gating**, **billing writes**. |
| **4** | Drop `store_spy.User`, `PlanTier` enum, `freeTrialEndsAt`, and the now-dead auth bits. | **No.** Gated on the column-home verification below. | point of no return. |
| **6** | Drop the `Cp` model-name prefix; `store_spy.Account` → `store_spy.OAuthAccount`. Pure rename. | Mechanical. | nothing functional. |
| 5 (B2.5) | Staff split: admin users → `control_plane.staff` / `staff_roles`; rework `guard.ts` / `roles.ts` / `permissions-service.ts`; rework admin-analytics raw SQL. | — | admin routes. |

### Two hard constraints (operator)

1. **Step 1 is reviewed and merged on its own, before step 2 touches auth.** Data in place and reversible while login still works.
2. **Before step 4, a verification is produced showing every `store_spy.User` column has a confirmed new home and no reader remains.** The column-home table below is that scaffold; step 4's PR must show it fully discharged with `grep` evidence for the "no reader remains" half.

---

## Target end state (after step 6)

```
control_plane
  accounts        id, billing_email, provider_customer_id, created_at
  users           id, account_id, email, password_hash, account_role,
                  email_verified_at, sessions_valid_after, name, image,
                  tos_accepted_at, created_at
  products        (unchanged — store-spy, find-suppliers)
  subscriptions   id, account_id, product_id, status, source, period_end,
                  provider_ref, created_at            ← `source` added in B2
  checkouts       id, account_id, product_id, plan_slug, period, promo_code_id?,
                  list_price_cents, discount_cents, final_cents, status,
                  created_at, completed_at            ← moved from store_spy in B2
  entitlements    (unchanged shape — quota per feature_key)
  staff / staff_roles / audit_log   (unchanged — populated in B2.5)

store_spy
  OAuthAccount        (was `Account` — OAuth identities, userId → control_plane.users.id)
  Session             (dead under JWT strategy — drop candidate, step 7)
  UserAdminRole       userId (→ cp.users.id), role   ← B2 temp home for User.role; B2.5 folds into staff
  MarketingConsent    userId (→ cp.users.id), consent, consent_at, consent_source
  Watchlist / AnalysisUsage / AnonymousAnalysis / Store / Crawl / Product / …
                      (unchanged; userId columns now FK control_plane.users)
  PromoCode / PromoRedemption   (unchanged — product-specific)
  AdminAuditLog / AdminPermissionGrant   (unchanged in B2; AdminPermissionGrant
                      moves to staff in B2.5)
```

`PlanTier` enum: **gone** after step 4 — `plan` is `control_plane.entitlements` +
`subscriptions.status`. `PromoCode.appliesToPlan` and `Checkout.plan` /
`checkouts.plan_slug` become plain strings (`"store-spy:basic"` etc.), reconciled
in step 3 — flagged, not a blocker.

`Role` enum: **stays** (moves with `UserAdminRole`), retired in B2.5.

---

## `store_spy.User` → new home (the step-4 gate)

| Column | New home | Readers today (must all be repointed by step 4) |
|---|---|---|
| `id` | `control_plane.users.id` — **same value reused**, so every `userId` FK value is unchanged | join key everywhere |
| `email` | `control_plane.users.email` (`@unique` preserved) | `verify-credentials` (`where:{email}`), `resend-verification`, `account/export`, `billing/checkout`, `dashboard/summary`, `admin/users-service`, `admin/analytics/user-export` |
| `emailVerified` | `control_plane.users.email_verified_at` | `account/email-verification`, `resend-verification`, auth adapter (`profile()`), OAuth sign-in |
| `name`, `image` | `control_plane.users.name` / `image` | `verify-credentials` (return), signup (write), auth adapter |
| `passwordHash` | `control_plane.users.password_hash` | `verify-credentials`, signup (write) |
| `plan` | **derived** — `control_plane.subscriptions` + `entitlements`, via `/api/internal/entitlements` | `auth.ts` jwt callback, `dashboard/summary`, `entitlements/analysis-usage`, `admin/users-service` (read + `setUserPlan` write), `billing/checkout` (write), `billing/subscription-sweep` (write), `admin/analytics/*` (B2.5) |
| `role` | `store_spy.UserAdminRole.role` (temp; B2.5 → `control_plane.staff_roles`) | `auth.ts` jwt callback (privileged re-read), `jwt-plan-refresh`, `account/delete` (+ `count SUPER_ADMIN`), `admin/permissions-service`, `admin/users-service` (read/write/`count SUPER_ADMIN`) |
| `sessionsValidAfter` | `control_plane.users.sessions_valid_after` | `jwt-plan-refresh` (read), `admin/users-service` (revoke-sessions write) |
| `freeTrialEndsAt` | **derived** — `control_plane.subscriptions.period_end` of the `TRIALING` row | `monitoring/watch` (gate + watch-expiry math), `account/export`, `admin/analytics/user-export` |
| `marketingConsent` / `…At` / `…Source` | `store_spy.MarketingConsent` | `marketing/consent` (write), `account/consent`, `account/export`, `account/delete`, `admin/analytics/user-export` (marketing filter) |
| `tosAcceptedAt` | `control_plane.users.tos_accepted_at` | `account/consent` (read + write), signup (write), `DashboardLayout` gate |
| `createdAt` | `control_plane.users.created_at` | `admin/users-service`, `admin/analytics/user-export` |
| `updatedAt` | dropped (nothing reads it) | — |

Relations (`accounts` / `sessions` / `watchlists` / `analysisUsage` /
`permissionGrants` back-relations): repoint by `userId` value, unchanged.

---

## `jwt-plan-refresh.ts` and the 60-second plan claim

### Today

JWT claims: `id`, `plan`, `role`, `planCheckedAt`. `refreshJwtToken()` runs in
`auth.ts`'s `jwt` callback on every request:

- fresh sign-in → live read, set `plan`/`role`/`planCheckedAt`
- `role !== "USER"` → **always** live-read (`planCheckedAt` ignored) — a forged
  privileged token can keep its own `planCheckedAt` "fresh" forever, so a
  privileged role must be revalidated every request
- `role === "USER"` and `planCheckedAt` within `PLAN_CHECK_TTL_MS` (60s) → pass through
- otherwise → live-read `User{plan, role, sessionsValidAfter}`; strip `id`
  (collapse to anonymous) if the row is gone or the token's `iat` predates
  `sessionsValidAfter`

`session.ts`'s `getCurrentUser()` reads `{id, plan, role}` straight off the token,
no DB.

### After B2

**`plan` leaves the JWT entirely.** No `plan` claim. No plan `planCheckedAt`.
Entitlement is fetched per-feature from `/api/internal/entitlements` at
gate-check time against live `control_plane` data. **The 60-second
plan-staleness window is deleted, not moved** — an upgrade, downgrade, or trial
expiry takes effect on the caller's *next gated action*, with no window. The
cost (Q6, accepted): `/api/analyze` and `/api/store/[domain]/watch` each gain
one indexed same-Postgres query where they previously read a token field.

**`session.ts`**: `CurrentUser` loses `plan`. `getCurrentUser()` returns
`{ id, email?, role }`. The ~4 sites that read `user.plan` switch to an
entitlements call (step 3).

**`jwt-plan-refresh.ts` → `jwt-session-refresh.ts`**, slimmed to **existence +
revocation only**:

- keep the 60s TTL; rename `PLAN_CHECK_TTL_MS` → `SESSION_CHECK_TTL_MS`
- keep the `role !== "USER"` → always-re-read branch **unchanged** (Q2 — role
  stays in the JWT, and the forged-privileged-token reasoning is untouched).
  The re-read now reads `control_plane.users` (existence, `sessions_valid_after`)
  joined to `store_spy.UserAdminRole` (role).
- `role === "USER"` within TTL → pass through
- otherwise → re-read; strip `id` if the `control_plane.users` row is gone or
  `iat` < `sessions_valid_after`
- **no `plan` handling anywhere** — the function no longer knows the word

`auth.ts`: the `jwt` callback's `readUser` closure reads
`control_plane.users` + `UserAdminRole` instead of `store_spy.User`; the
`session` callback stops copying `plan` onto `session.user`. `types.d.ts` drops
`plan` from `Session["user"]` and `JWT`.

**`sessions_valid_after`** (the "sign out everywhere" kill switch) moves to
`control_plane.users`. The guarantee stays **"revocation lands within 60s"** —
identical mechanism, identical bound.

---

## Migrations by step

| Step | Migration | Nature |
|---|---|---|
| 1 | `<ts>_b2_step1_control_plane_users_backfill` | hand-written, fully idempotent (`ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`, `INSERT … ON CONFLICT DO NOTHING`): `ALTER control_plane.users ADD COLUMN` ×5, `CREATE store_spy.UserAdminRole` / `MarketingConsent`, backfill. **No FK changes.** `down.sql` included. Additive only. |
| 2·M | `20260828180000_b2_step2_swap_user_fks_to_control_plane` (branch `control-plane/b2-step-2m`, in review) | Swap `Account` / `AdminPermissionGrant` / `AnalysisUsage` / `Session` / `Watchlist` `*_userId_fkey` from `store_spy.User` to `control_plane.users` (names reused); add the same FK to `UserAdminRole` / `MarketingConsent`. Bundled with the ~38-file fixture migration to `makeStoreSpyUser()` — mandatory once the FK points at `control_plane.users`. Idempotent; `down.sql` (safe pre-2·B). Applied to the test DB; full suite green with **identical per-file test counts** (no assertion drift). |
| 2 (billing) | `<ts>_b2_step2_move_billing_to_control_plane` | folded in from the old step 3. `ALTER control_plane.subscriptions ADD COLUMN source`; `CREATE control_plane.checkouts`; migrate `store_spy.Subscription`/`Checkout` rows (backfill `source`, re-key `userId` → `account_id`); `period_end` already correct from step 1; drop `store_spy.Subscription`/`Checkout`. Lands with 2·B. |
| 4 | `<ts>_b2_step4_drop_store_spy_user` | `DROP TABLE store_spy."User"`; `DROP TYPE store_spy."PlanTier"`; drop `freeTrialEndsAt` (already unreferenced). Irreversible — gated on the column-home verification. |
| 6 | `<ts>_b2_step6_drop_cp_prefix` | `ALTER TABLE store_spy."Account" RENAME TO "OAuthAccount"`; Prisma model renames `Cp*` → plain (no SQL — `@@map` names already unprefixed). |

`prisma migrate diff` cannot express the cross-schema data moves or the
redundant FKs; every B2 migration is hand-written and ships with a `down.sql`
(steps 1–3, 6) verified forward/back on an empty DB, per the B1 discipline.

---

## Step 1 — what's in this PR

**Schema (`schema.prisma`)**

- `CpUser` gains `emailVerifiedAt`, `sessionsValidAfter`, `name`, `image`,
  `tosAcceptedAt` (all nullable), mapped snake_case.
- New `store_spy` model `UserAdminRole` — `userId String @id`, `role Role`.
  No Prisma relation (the FK to `control_plane.users` is raw SQL — Prisma's DSL
  can't put two `@relation`s on one column, and this table is B2.5-throwaway).
- New `store_spy` model `MarketingConsent` — `userId String @id`,
  `consent Boolean @default(false)`, `consentAt DateTime?`, `consentSource String?`.

**Migration SQL (hand-written)**

1. `ALTER TABLE "control_plane"."users" ADD COLUMN` — the 5 identity columns.
2. `CREATE TABLE "store_spy"."UserAdminRole"`, `"store_spy"."MarketingConsent"`.
3. Backfill, idempotent (`INSERT … SELECT … ON CONFLICT DO NOTHING`), keyed on
   deterministic ids so it can be re-run just before step 2 to catch any
   `store_spy.User` rows created in between:
   - `accounts`   — `id = 'acct_' || u.id`, `billing_email = u.email`
   - `users`      — **`id = u.id`** (reused), all identity columns copied
   - `subscriptions` — the model mirrors "analyze free forever, monitor on a
     30-day trial then pay" so `resolveEntitlement()` agrees with today's
     `plan-limits.ts` per feature (analysis is **not** trial-gated today, monitoring is):
     - `plan = FREE` → **two** subs:
       - `'subf_' || u.id` — `status = 'ACTIVE'`, `period_end = NULL` — grants `store_spy.analysis.run`
       - `'subt_' || u.id` — `status = 'TRIALING'`, `period_end = COALESCE(u."freeTrialEndsAt", u."createdAt" + interval '30 days')` — grants `store_spy.monitoring.slots`. `period_end` **equals `freeTrialEndsAt` exactly** — the derived value in B2 is byte-identical to today's column.
     - `plan IN (BASIC, BUSINESS)` → one sub `'sub_' || u.id`, `status = 'ACTIVE'`,
       `period_end =` the **real** expiry: `store_spy."Subscription".expiresAt` of the
       user's current `ACTIVE` billing row (`NULL` if none, or a perpetual promo grant).
       Read from source here — **not provisional**. A paid user whose real expiry
       is already past but whose `User.plan` was never swept is a genuine
       disagreement and is reported by the semantic check below, not hidden.
   - `entitlements` — from the M12 matrix, attached to the sub above that owns each feature:
     | plan | `store_spy.analysis.run` | `store_spy.monitoring.slots` | `store_spy.intelligence.advanced` |
     |---|---|---|---|
     | FREE | quota 10 (on `subf_`) | quota 1 (on `subt_`) | *(no row)* |
     | BASIC | quota 50 | quota 20 | quota `NULL` (boolean grant) |
     | BUSINESS | quota 100 | quota 50 | quota `NULL` |
   - `UserAdminRole` — one row per `u.role <> 'USER'`
   - `MarketingConsent` — one row per user (`consent = u."marketingConsent"`, etc.)
4. *(nothing — no FK changes in step 1; see the sequence table and the
   migration header for why they wait for step 2.)*

**`down.sql`**: drop the new tables; `DELETE FROM
"control_plane"."entitlements" / "subscriptions" / "users" / "accounts"`
(these are empty pre-step-1, so wholesale is safe); drop the 5 columns.

**No code changes in step 1.** `verify-credentials`, `auth.ts`, signup, every
gate — untouched. Login runs off `store_spy.User` exactly as today. The
integration suite is unaffected (it still creates `store_spy.User` rows).

### Step 1 verification

- `prisma migrate diff --from-url <migrated DB> --to-schema-datamodel` →
  only the known `freeTrialEndsAt` `dbgenerated()` phantom. Nothing else
  (step 1 adds no FK, so no diff noise).
- Backfill correctness on a DB with representative `store_spy.User` rows
  (FREE in-trial, FREE past-trial, BASIC perpetual, BASIC lapsed, BUSINESS
  with no billing row, an admin, an OAuth-only user with `passwordHash` null):
  row counts match, ids line up, FREE gets a `subf_`/`subt_` pair, paid gets
  one `sub_`, entitlement quotas match the matrix, `period_end` correct per
  branch (trial = `freeTrialEndsAt` exactly; paid = real
  `store_spy.Subscription.expiresAt`).
- **Semantic parity** — `npm run verify:b2-step1` (`scripts/verify-b2-step1-semantics.ts`):
  for every user, `plan-limits.ts`'s grants today vs `resolveEntitlement()` on
  the backfilled rows — quota, `allowed`, `reason`, and the exact trial / paid
  expiry timestamp. Run while `store_spy.User` is authoritative. Exit 0 = every
  user's two paths agree exactly; exit 1 lists each disagreement.
- Re-run the backfill block → no-ops (idempotency).
- `down.sql` round-trip on an empty DB: forward → down → forward, clean.
- Full unit + integration suites green (they must be — step 1 changes no code).

---

## Risks / watch items

- **Backfill drift between step-1 merge and step-2 deploy.** New signups in
  that window write only `store_spy.User`. Mitigation: the backfill is
  idempotent and re-run as the first action of step 2. (Moot today — nothing
  deployed, no users — but the procedure is written down.)
- **`PromoCode.appliesToPlan` / `Checkout.plan` still typed `PlanTier`** after
  step 4 drops the enum. Step 3 converts them to plan-slug strings; called out
  so it isn't discovered at `DROP TYPE`.
- **`store_spy.Session` is dead weight** (JWT strategy never writes it). Not
  load-bearing; drop candidate in a step-7 cleanup, not B2 core.
- **45 integration test files create `store_spy.User`.** Steps 2–4 rework their
  fixtures to `control_plane.users` (+ `UserAdminRole` / `MarketingConsent`).
  A shared `makeUser()` test helper is introduced in step 2 rather than editing
  45 call sites individually — this is test infrastructure, not a product
  refactor.
- **Cross-schema `ON DELETE CASCADE`** from `store_spy.*` to
  `control_plane.users`: verified supported in the same Postgres instance
  (a scratch test deletes a `control_plane.users` row and confirms the
  `store_spy` children go with it). This lands in **step 2** with the FK swap,
  not step 1 — an early attempt to add these FKs in step 1 broke every test
  that creates a `store_spy.User` with no matching `control_plane.users` row
  (i.e. all of them, until signup writes both).

---

# Step 2 — detailed plan (review before applying)

Branch `control-plane/b2-auth-to-control-plane`. **Nothing applied until
reviewed.**

## Re-scoping: step 2 is one cutover, not two

`plan` is load-bearing across **three** concerns at once:

1. **identity / session** — the `plan` JWT claim, set by the `jwt` callback,
   read by `session.ts`;
2. **gates** — `run-analysis.ts`, `watch.ts`, `dashboard/summary.ts`,
   `stores/[domain]/page.tsx` all call `plan-limits.ts` with `user.plan`;
3. **billing** — `checkout.ts`, `subscription-sweep.ts`, and admin
   `setUserPlan()` all **write** `User.plan`.

None can move alone. The instant `session.ts` stops exposing `plan`, the
gates break. The instant the gates read entitlements, any billing path still
writing only `User.plan` produces a user whose gate limits disagree with
what they paid for. So the doc's original "step 2 = auth, step 3 = billing"
split doesn't survive contact — **step 3's billing work folds into step 2**,
delivered as two deploys around one migration:

### 2·A — additive, zero behaviour change (own PR, reversible)

- `provisionStoreSpyAccount(tx, { email, passwordHash, name, tosAcceptedAt })`
  — one function: `cpAccount` + `cpUser` + `subf_`/`subt_` subs + entitlements
  (the same shape step 1 backfilled). Called by both the signup route and the
  OAuth adapter's `createUser`.
- Signup route + a **custom Auth.js adapter** (replacing `@auth/prisma-adapter`)
  write `control_plane.users` — **and, transitionally, a shadow
  `store_spy.User` row** (same id; `email` / `passwordHash` / `plan` / `role` /
  `freeTrialEndsAt` mirrored) so the existing FKs and the still-live
  `User.plan` readers keep working untouched.
- `checkout.ts` / `subscription-sweep.ts` / admin `setUserPlan()`:
  **dual-write** — keep the `User.plan` write, add the equivalent
  `control_plane` subscription + entitlement mutation.
- Nothing reads `control_plane` for gating yet. Login, gates, billing behave
  exactly as today.

### Migration M — the FK swap (the file in this PR)

For `Account`, `AdminPermissionGrant`, `AnalysisUsage`, `Session`,
`Watchlist`: `ADD` the FK to `control_plane.users(id)` (every row satisfiable
— backfill + 2·A dual-writes), then `DROP` the FK to `store_spy.User`.
`UserAdminRole` / `MarketingConsent` gain their FK here too. **Constraint
names are reused** (`Watchlist_userId_fkey`, …) so step 6's Cp-prefix drop
needs no FK rename. `down.sql` reverses it.

### 2·B — the cutover (own PR)

- `verify-credentials`, the `jwt` / `session` callbacks, `session.ts`,
  `types.d.ts`: read `control_plane.users` (+ `store_spy.UserAdminRole` for
  `role`). **`plan` leaves the JWT.** `jwt-plan-refresh.ts` →
  `jwt-session-refresh.ts` (existence + revocation only; keep the 60s TTL,
  `PLAN_CHECK_TTL_MS` → `SESSION_CHECK_TTL_MS`; keep the `role !== "USER"`
  always-re-read branch per Q2).
- Gates call `/api/internal/entitlements`; `recordAnalysisUsage()` takes a
  `quota: number | null` argument instead of `plan`; `plan-limits.ts` /
  `entitlement-service.ts` deleted.
- Billing writes drop the `User.plan` half of the dual-write —
  `control_plane` only.
- Signup + adapter stop writing the shadow `store_spy.User`.
- `store_spy.User` now has **no readers and no writers** — the column-home
  discharge verification (below) runs here, gating step 4.

A `makeUser()` test helper is introduced in 2·A and the 45 fixture files move
to it across 2·A/2·B — test infrastructure, tracked separately from the
product diff.

## Q: is there a window where signup or an FK write can fail?

**No.** The shadow `store_spy.User` write in 2·A is the hinge — it keeps the
old FK satisfiable across the swap, so migration M never has to be co-timed
with a code deploy.

| phase | signup writes | live FK on `Watchlist.userId` (&c.) | write can fail? |
|---|---|---|---|
| after step 1, before 2·A | `store_spy.User` only | `_userId_fkey → store_spy.User` | no |
| 2·A deployed | `control_plane.users` **+ shadow `store_spy.User`** (same id) | `_userId_fkey → store_spy.User` | no — shadow row satisfies it |
| migration M running | (same) | briefly **both** `_userId_fkey` and the new one | no — every `userId` has a row in **both** tables |
| after M, before 2·B | `control_plane.users` + shadow | `_userId_fkey → control_plane.users` | no — cp.users row satisfies it |
| 2·B deployed | `control_plane.users` only | `_userId_fkey → control_plane.users` | no |

Order is: deploy 2·A → run M → deploy 2·B. M can run any time after 2·A and
before 2·B; it is not coupled to a deploy instant.

## Q: what happens to in-flight sessions at cutover?

**Nobody is logged out.** Session strategy is JWT signed with `AUTH_SECRET`
(unchanged in B2). A pre-cutover token carries
`{ id, plan, role, planCheckedAt, iat }`.

- **`token.id`** is the old `store_spy.User.id`, which step 1's backfill copied
  **verbatim** into `control_plane.users.id`. The post-cutover `jwt` callback's
  re-read (`cpUser.findUnique({ where: { id: token.id } })`) resolves — session
  stays valid.
- **stale `plan` claim** — the `session` callback stops copying it;
  `refreshSessionToken` ignores it. It rides along unused until the token
  expires and re-mints without it.
- **`role`** — re-read from `store_spy.UserAdminRole` (backfilled). Preserved,
  including for admins.
- **`sessionsValidAfter`** — moved to `control_plane.users` (backfilled,
  including any non-null revocation floor). "Sign out everywhere" still
  enforced; a token issued before an existing floor is still rejected.
- **`planCheckedAt` claim** — renamed to `sessionCheckedAt`. Old tokens lack
  it → treated as stale → **one** forced `control_plane.users` re-read on the
  session's first post-cutover request (exactly the revalidation we want),
  then the new claim is written. No user-visible effect.
- **OAuth sessions** — same: `token.id` resolves, and the custom adapter's
  `getUserByAccount` (`store_spy.Account` → `userId` → `control_plane.users`)
  works because `Account.userId` was repointed to the same id.

If a clean-slate logout were ever wanted (it is **not** — no security reason):
`UPDATE control_plane.users SET sessions_valid_after = now()` at cutover
invalidates every existing JWT on its next request. B2 does not do this.

## Step 2 verification

- **2·A** (done): full unit + integration suite green with the dual-writes +
  shadow row (73 files / 516 tests). `src/lib/control-plane/__tests__/dual-write-parity.integration.test.ts`
  drives signup / checkout / admin `setUserPlan` (both directions) / sweep and
  asserts `User.plan` and the control plane stay in sync at each step, using
  the same `planParityMismatches()` the gate script runs.
- **The gate before 2·B**: `npm run verify:b2-step1` (`scripts/verify-b2-step1-semantics.ts`)
  — re-used from step 1, now the standing check that every 2·A dual-write path
  kept both sides in step. Run it after 2·A is deployed and exercised (real
  signups, a real checkout, an admin plan change, a sweep). **It must exit 0
  before 2·B lands.** A path that writes `User.plan` but not the control plane
  (or vice-versa) shows up here as a per-user disagreement.
- **2·M**: `ADD`/`DROP` both directions on a scratch DB with backfilled +
  shadow rows (done); a cross-schema `ON DELETE CASCADE` from each child
  actually cascades (done); `down.sql` round-trip (done); + the full suite
  green with the fixture migration applied.
- **2·B**: every auth integration test; a real `next start` browser sign-in
  (Credentials **and**, if configured, OAuth); a pre-cutover JWT (minted
  against 2·A) still authorises a request after 2·B is deployed — asserted,
  not assumed.
- **Column-home discharge**: `grep` evidence that no `prisma.user.` /
  `session.user.plan` / `plan-limits` reader remains, table-by-table against
  the step-4 gate list.

## A note on the self-heal in 2·A

`syncControlPlanePlan()` calls `ensureControlPlaneAccount()` first, which
creates `acct_<userId>` + its `cpUser` from the shadow `store_spy.User` row if
missing. In production this is always a no-op (signup and the OAuth adapter
provision up front). It exists so the dual-writes converge to a correct
control plane even from an inconsistent start, and so an integration fixture
that creates a bare `store_spy.User` still works without replicating the
provisioning. It is removed in 2·B with the rest of the dual-write
scaffolding — grep `TRANSITIONAL (B2 step 2·B)`.
