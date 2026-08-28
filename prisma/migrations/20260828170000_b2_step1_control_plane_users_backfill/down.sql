-- Reverse of 20260828170000_b2_step1_control_plane_users_backfill.
-- Not consumed by `prisma migrate deploy` — kept for review, verified
-- forward -> down -> forward on an empty database.
--
-- Safe because step 1 is the only thing that has ever populated
-- control_plane.{accounts,users,subscriptions,entitlements}: the wholesale
-- DELETEs below cannot touch rows that step 2+ would own, since this runs
-- before step 2 exists.

-- Backfilled rows (FK order: entitlements -> subscriptions -> users -> accounts)
DELETE FROM "control_plane"."entitlements";
DELETE FROM "control_plane"."subscriptions";
DELETE FROM "control_plane"."users";
DELETE FROM "control_plane"."accounts";

-- New store_spy tables
DROP TABLE "store_spy"."MarketingConsent";
DROP TABLE "store_spy"."UserAdminRole";

-- Identity columns
ALTER TABLE "control_plane"."users"
  DROP COLUMN "tos_accepted_at",
  DROP COLUMN "image",
  DROP COLUMN "name",
  DROP COLUMN "sessions_valid_after",
  DROP COLUMN "email_verified_at";
