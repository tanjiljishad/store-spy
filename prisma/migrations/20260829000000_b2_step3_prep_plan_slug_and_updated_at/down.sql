-- Reverse of 20260829000000_b2_step3_prep_plan_slug_and_updated_at.
-- Not consumed by `prisma migrate deploy` — kept for review, verified
-- forward -> down -> forward on an empty database.
--
-- Both columns are additive and unread by any code on main at the time this
-- migration lands, so dropping them cannot strand a reader.

ALTER TABLE "control_plane"."users"
  DROP COLUMN "updated_at";

ALTER TABLE "control_plane"."subscriptions"
  DROP COLUMN "plan_slug";
