-- ============================================================================
-- B2 / step 3 prep : control_plane tier column + users.updated_at (ADDITIVE)
--
-- Two new columns, both nullable-safe against the code currently on main
-- (B2 2·A / 2·M), so this PR can merge and sit ahead of the split commit 3
-- without breaking any write path:
--
--   1. control_plane.subscriptions.plan_slug  TEXT, NULLABLE
--      "What tier did this account buy." A plain string, deliberately NOT a
--      control_plane enum: a tier/pricing change (or another product with its
--      own tier names) must not each need a migration, and PlanTier itself is
--      dropped in step 4. Backfilled to 100% of existing rows here; every
--      writer starts populating it in commit 3, which also tightens it to
--      NOT NULL. Until then a row created by the current writeStoreSpy-
--      Subscriptions() (which does not set it) is a visible NULL, never a
--      silently-wrong default.
--
--   2. control_plane.users.updated_at  TIMESTAMP(3), NOT NULL DEFAULT now()
--      Mirrors store_spy."User".updatedAt (Prisma @updatedAt). Only reader is
--      the GDPR self-export (account/export.ts); repointed in commit 3.
--
-- Nothing is removed or repointed here. store_spy."User" stays authoritative.
-- Reversible: see down.sql (verified forward -> down -> forward on an empty DB).
-- Idempotent: IF NOT EXISTS on the DDL, and both backfills are guarded by
-- `IS NULL` so re-running picks up only rows added since.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. control_plane.subscriptions.plan_slug
-- ----------------------------------------------------------------------------
ALTER TABLE "control_plane"."subscriptions"
  ADD COLUMN IF NOT EXISTS "plan_slug" TEXT;

-- Backfill from the still-authoritative store_spy."User".plan, matched by the
-- deterministic account id ('acct_' || userId) the step-1 backfill established
-- — same convention as migration 20260828170000, and it does not depend on a
-- control_plane.users row existing. A FREE account's two subs (subf_ ACTIVE,
-- subt_ TRIALING) both get 'FREE'; a paid account's single sub_ gets
-- 'BASIC' / 'BUSINESS'. Casting the store_spy."PlanTier" enum to text yields
-- the label verbatim.
UPDATE "control_plane"."subscriptions" s
SET "plan_slug" = u."plan"::text
FROM "store_spy"."User" u
WHERE s."account_id" = 'acct_' || u."id"
  AND s."plan_slug" IS NULL;

-- ----------------------------------------------------------------------------
-- 2. control_plane.users.updated_at
-- ----------------------------------------------------------------------------
ALTER TABLE "control_plane"."users"
  ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP(3);

-- Existing rows: seed from created_at (the best available "last changed"),
-- not migration time. Column-to-column copy of two TIMESTAMP(3) values — no
-- now()/parameter, so none of AGENTS.md's session-TimeZone raw-SQL caveats
-- apply here.
UPDATE "control_plane"."users"
SET "updated_at" = "created_at"
WHERE "updated_at" IS NULL;

ALTER TABLE "control_plane"."users"
  ALTER COLUMN "updated_at" SET NOT NULL,
  ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;
