-- ============================================================================
-- B2 / step 1 : control_plane.users identity columns + backfill (ADDITIVE)
--
-- Nothing here removes or repoints anything. store_spy."User" stays the
-- authoritative identity store and login runs entirely off it — see
-- docs/store-spy-control-plane-b2.md. This migration only mirrors identity
-- data into its new homes so that step 2 (the auth repoint, a separate PR)
-- is a pure code + FK-drop change.
--
-- Reversible: see down.sql. The WHOLE file is idempotent — DDL uses
-- IF NOT EXISTS / duplicate-swallowing DO blocks, and every backfill INSERT
-- is ON CONFLICT DO NOTHING on a deterministic id. So it can be re-run with
--   prisma db execute --schema prisma/schema.prisma --file <this file>
-- immediately before step 2 to pick up any store_spy."User" rows created
-- after it was first applied.
--
-- NOTE: this step does NOT add any FK from store_spy.* to
-- control_plane.users. Doing so would require every existing userId to have a
-- control_plane.users row — which the backfill provides for users that exist
-- now, but NOT for any user created afterwards by code that still writes only
-- store_spy."User" (the entire app, and all test fixtures, until step 2). The
-- redundant cross-schema FKs move to step 2, added atomically with the auth
-- write-path repoint and the drop of the old *_userId_fkey -> store_spy."User"
-- constraints.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. control_plane.users: identity columns migrated off store_spy."User".
--    All nullable; the backfill below populates them. `plan` /
--    `freeTrialEndsAt` are intentionally NOT columns — they become derived
--    from control_plane.subscriptions / entitlements.
-- ----------------------------------------------------------------------------
ALTER TABLE "control_plane"."users"
  ADD COLUMN IF NOT EXISTS "email_verified_at"    TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "sessions_valid_after" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "name"                 TEXT,
  ADD COLUMN IF NOT EXISTS "image"                TEXT,
  ADD COLUMN IF NOT EXISTS "tos_accepted_at"      TIMESTAMP(3);

-- ----------------------------------------------------------------------------
-- 2. New store_spy homes for the two User columns that stay product-specific
--    (Q2: role, until the B2.5 staff split; Q5: marketing consent).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "store_spy"."UserAdminRole" (
    "userId" TEXT NOT NULL,
    "role" "store_spy"."Role" NOT NULL,

    CONSTRAINT "UserAdminRole_pkey" PRIMARY KEY ("userId")
);
CREATE INDEX IF NOT EXISTS "UserAdminRole_role_idx" ON "store_spy"."UserAdminRole"("role");

CREATE TABLE IF NOT EXISTS "store_spy"."MarketingConsent" (
    "userId" TEXT NOT NULL,
    "consent" BOOLEAN NOT NULL DEFAULT false,
    "consent_at" TIMESTAMP(3),
    "consent_source" TEXT,

    CONSTRAINT "MarketingConsent_pkey" PRIMARY KEY ("userId")
);

-- ----------------------------------------------------------------------------
-- 3. Backfill. Deterministic ids (acct_/sub_/ent_ prefix + the user id;
--    control_plane.users.id REUSES store_spy."User".id verbatim so every
--    existing userId FK value stays valid). Idempotent.
-- ----------------------------------------------------------------------------

-- 3a. one account per user
INSERT INTO "control_plane"."accounts" ("id", "billing_email", "created_at")
SELECT 'acct_' || u."id", u."email", u."createdAt"
FROM "store_spy"."User" u
ON CONFLICT ("id") DO NOTHING;

-- 3b. the user row itself
INSERT INTO "control_plane"."users"
  ("id", "account_id", "email", "password_hash", "account_role", "created_at",
   "email_verified_at", "sessions_valid_after", "name", "image", "tos_accepted_at")
SELECT
  u."id", 'acct_' || u."id", u."email", u."passwordHash", 'OWNER', u."createdAt",
  u."emailVerified", u."sessionsValidAfter", u."name", u."image", u."tosAcceptedAt"
FROM "store_spy"."User" u
ON CONFLICT ("id") DO NOTHING;

-- 3c. subscriptions. The model mirrors "analyze free forever, monitor on a
--     30-day trial then pay" (M10 freemium direction) exactly, so
--     resolveEntitlement() agrees with today's plan-limits.ts per feature:
--
--     FREE  -> TWO subs:
--       'subf_' (ACTIVE, perpetual)   grants store_spy.analysis.run   [not trial-gated]
--       'subt_' (TRIALING, period_end) grants store_spy.monitoring.slots [trial-gated]
--       period_end = freeTrialEndsAt exactly (fallback created_at + 30d), so the
--       derived "freeTrialEndsAt" in B2 is byte-identical to today's column.
--
--     BASIC/BUSINESS -> ONE sub (ACTIVE) granting all three features.
--       period_end = the REAL expiry: store_spy."Subscription".expiresAt of the
--       user's current ACTIVE billing row (NULL if none, or if that row is a
--       perpetual promo grant). Not provisional — read from source here.
--       A user whose real expiry is already past but whose User.plan wasn't
--       swept back to FREE yet will show up in the step-1 semantic check as a
--       genuine plan/entitlement disagreement (reported, not hidden).

-- FREE: permanent free-tier subscription (analysis)
INSERT INTO "control_plane"."subscriptions"
  ("id", "account_id", "product_id", "status", "period_end", "created_at")
SELECT 'subf_' || u."id", 'acct_' || u."id", 'prod_store_spy',
       'ACTIVE'::"control_plane"."subscription_status", NULL, u."createdAt"
FROM "store_spy"."User" u
WHERE u."plan" = 'FREE'
ON CONFLICT ("id") DO NOTHING;

-- FREE: monitoring trial subscription
INSERT INTO "control_plane"."subscriptions"
  ("id", "account_id", "product_id", "status", "period_end", "created_at")
SELECT 'subt_' || u."id", 'acct_' || u."id", 'prod_store_spy',
       'TRIALING'::"control_plane"."subscription_status",
       COALESCE(u."freeTrialEndsAt", (u."createdAt" + interval '30 days')),
       u."createdAt"
FROM "store_spy"."User" u
WHERE u."plan" = 'FREE'
ON CONFLICT ("id") DO NOTHING;

-- BASIC / BUSINESS: single paid subscription, real expiry from store_spy."Subscription"
INSERT INTO "control_plane"."subscriptions"
  ("id", "account_id", "product_id", "status", "period_end", "created_at")
SELECT 'sub_' || u."id", 'acct_' || u."id", 'prod_store_spy',
       'ACTIVE'::"control_plane"."subscription_status",
       (SELECT s."expiresAt"
        FROM "store_spy"."Subscription" s
        WHERE s."userId" = u."id" AND s."status" = 'ACTIVE'
        ORDER BY s."startedAt" DESC
        LIMIT 1),
       u."createdAt"
FROM "store_spy"."User" u
WHERE u."plan" IN ('BASIC', 'BUSINESS')
ON CONFLICT ("id") DO NOTHING;

-- 3d. entitlement rows from the Milestone 12 plan matrix, attached to the
--     right subscription per 3c.
--   FREE analysis.run -> subf_
INSERT INTO "control_plane"."entitlements" ("id", "subscription_id", "feature_key", "quota")
SELECT 'entf_' || u."id" || '_arun', 'subf_' || u."id", 'store_spy.analysis.run', 10
FROM "store_spy"."User" u WHERE u."plan" = 'FREE'
ON CONFLICT ("subscription_id", "feature_key") DO NOTHING;

--   FREE monitoring.slots -> subt_
INSERT INTO "control_plane"."entitlements" ("id", "subscription_id", "feature_key", "quota")
SELECT 'entt_' || u."id" || '_mslots', 'subt_' || u."id", 'store_spy.monitoring.slots', 1
FROM "store_spy"."User" u WHERE u."plan" = 'FREE'
ON CONFLICT ("subscription_id", "feature_key") DO NOTHING;

--   PAID -> the single sub_ carries all three
INSERT INTO "control_plane"."entitlements" ("id", "subscription_id", "feature_key", "quota")
SELECT 'ent_' || u."id" || '_arun', 'sub_' || u."id", 'store_spy.analysis.run',
       CASE u."plan" WHEN 'BASIC' THEN 50 WHEN 'BUSINESS' THEN 100 END
FROM "store_spy"."User" u WHERE u."plan" IN ('BASIC', 'BUSINESS')
ON CONFLICT ("subscription_id", "feature_key") DO NOTHING;

INSERT INTO "control_plane"."entitlements" ("id", "subscription_id", "feature_key", "quota")
SELECT 'ent_' || u."id" || '_mslots', 'sub_' || u."id", 'store_spy.monitoring.slots',
       CASE u."plan" WHEN 'BASIC' THEN 20 WHEN 'BUSINESS' THEN 50 END
FROM "store_spy"."User" u WHERE u."plan" IN ('BASIC', 'BUSINESS')
ON CONFLICT ("subscription_id", "feature_key") DO NOTHING;

INSERT INTO "control_plane"."entitlements" ("id", "subscription_id", "feature_key", "quota")
SELECT 'ent_' || u."id" || '_iadv', 'sub_' || u."id", 'store_spy.intelligence.advanced', NULL
FROM "store_spy"."User" u WHERE u."plan" IN ('BASIC', 'BUSINESS')
ON CONFLICT ("subscription_id", "feature_key") DO NOTHING;

-- 3e. role — only non-USER users get a row (absence = USER)
INSERT INTO "store_spy"."UserAdminRole" ("userId", "role")
SELECT u."id", u."role"
FROM "store_spy"."User" u
WHERE u."role" <> 'USER'
ON CONFLICT ("userId") DO NOTHING;

-- 3f. marketing consent — one row per user, verbatim copy
INSERT INTO "store_spy"."MarketingConsent" ("userId", "consent", "consent_at", "consent_source")
SELECT u."id", u."marketingConsent", u."marketingConsentAt", u."marketingConsentSource"
FROM "store_spy"."User" u
ON CONFLICT ("userId") DO NOTHING;

-- (No cross-schema FKs here — see the header note. They belong to step 2.)
