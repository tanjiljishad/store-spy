-- Reverse of 20260829010000_b2_step4_drop_store_spy_user.
--
-- ***  THIS IS NOT A ROLLBACK.  ***
--
-- It recreates the store_spy."User" table STRUCTURE and the "PlanTier" enum so
-- that a `migrate diff` round-trip on an EMPTY database is clean, and nothing
-- more. It CANNOT:
--   - restore any row that was in store_spy."User"
--   - re-point the *_userId_fkey constraints back at store_spy."User" (they
--     were moved to control_plane.users in 20260828180000 and belong there)
--   - undo the code that stopped reading store_spy.User
--
-- If step 4 ever has to be undone in anger, the real procedure is: revert the
-- application to a pre-step-4 build, then re-run 20260828170000's backfill in
-- REVERSE from control_plane back into a freshly recreated store_spy."User".
-- That procedure is not automated here.

CREATE TYPE "store_spy"."PlanTier" AS ENUM ('FREE', 'BASIC', 'BUSINESS');

CREATE TABLE "store_spy"."User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" TIMESTAMP(3),
    "name" TEXT,
    "image" TEXT,
    "passwordHash" TEXT,
    "plan" "store_spy"."PlanTier" NOT NULL DEFAULT 'FREE',
    "role" "store_spy"."Role" NOT NULL DEFAULT 'USER',
    "sessionsValidAfter" TIMESTAMP(3),
    "freeTrialEndsAt" TIMESTAMP(3) DEFAULT ((now() + '30 days'::interval) AT TIME ZONE 'UTC'),
    "marketingConsent" BOOLEAN NOT NULL DEFAULT false,
    "marketingConsentAt" TIMESTAMP(3),
    "marketingConsentSource" TEXT,
    "tosAcceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "User_email_key" ON "store_spy"."User"("email");
CREATE INDEX "User_role_idx" ON "store_spy"."User"("role");

ALTER TABLE "store_spy"."Subscription" ALTER COLUMN "plan" TYPE "store_spy"."PlanTier" USING "plan"::"store_spy"."PlanTier";
ALTER TABLE "store_spy"."Checkout"     ALTER COLUMN "plan" TYPE "store_spy"."PlanTier" USING "plan"::"store_spy"."PlanTier";
ALTER TABLE "store_spy"."PromoCode"    ALTER COLUMN "appliesToPlan" TYPE "store_spy"."PlanTier" USING "appliesToPlan"::"store_spy"."PlanTier";
