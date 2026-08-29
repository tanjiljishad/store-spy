-- ============================================================================
-- B2 / step 4 : drop store_spy."User"          ***  POINT OF NO RETURN  ***
--
-- Gated on the column-home discharge in docs/store-spy-control-plane-b2.md:
-- every store_spy.User column has a confirmed new home, and as of commit 4 no
-- reader remains anywhere in src/ (the one write — account/delete.ts's
-- tolerant deleteMany — is removed in this step's code change).
--
-- IRREVERSIBLE. down.sql recreates the table STRUCTURE only; it cannot restore
-- one row of dropped data, and the *_userId_fkey constraints already point at
-- control_plane.users (migration 20260828180000), not here. Do not treat
-- down.sql as a rollback.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. The three store_spy."PlanTier" columns that are NOT store_spy.User.plan.
--    All billing-history / promo columns, never a gate; their stored values
--    are already the plan-slug strings 'FREE' / 'BASIC' / 'BUSINESS'. The
--    USING cast is data-preserving. schema.prisma changes these fields to
--    `String` in the same PR.
-- ----------------------------------------------------------------------------
ALTER TABLE "store_spy"."Subscription" ALTER COLUMN "plan" TYPE TEXT USING "plan"::text;
ALTER TABLE "store_spy"."Checkout"     ALTER COLUMN "plan" TYPE TEXT USING "plan"::text;
ALTER TABLE "store_spy"."PromoCode"    ALTER COLUMN "appliesToPlan" TYPE TEXT USING "appliesToPlan"::text;

-- ----------------------------------------------------------------------------
-- 2. Drop the table. store_spy."User" has NO inbound foreign key — migration
--    20260828180000 repointed every *_userId_fkey to control_plane.users — so
--    no CASCADE is needed. Its PK, "User_email_key", "User_role_idx", the
--    freeTrialEndsAt DEFAULT expression, and the freeTrialEndsAt column itself
--    all go with it.
-- ----------------------------------------------------------------------------
DROP TABLE "store_spy"."User";

-- ----------------------------------------------------------------------------
-- 3. The store_spy."PlanTier" enum is now unreferenced (step 1 above removed
--    its last three uses; store_spy.User.plan went with the table).
-- ----------------------------------------------------------------------------
DROP TYPE "store_spy"."PlanTier";
