-- DropIndex
DROP INDEX "AnalysisUsage_userId_idx";

-- DropIndex
DROP INDEX "AnalysisUsage_userId_storeId_key";

-- AlterTable: add nullable, no default yet — the default must not apply
-- until AFTER existing rows are backfilled from their OWN createdAt below,
-- since a single ADD COLUMN ... DEFAULT (now() + interval '30 days') would
-- give every pre-existing user the exact same flat migration-time value
-- instead of their individual createdAt + 30 days (Milestone 12 D1).
ALTER TABLE "User" ADD COLUMN     "freeTrialEndsAt" TIMESTAMP(3);

-- Backfill existing users (Milestone 12 §1.4: "Backfill existing users in
-- the migration"). Both operands are plain TIMESTAMP (no tz) — calendar
-- arithmetic on two naive timestamps, no timestamptz cast involved, so this
-- is not subject to the session TimeZone GUC (see AGENTS.md's Database time
-- rule; contrast with the DEFAULT expression below, which does involve one).
UPDATE "User" SET "freeTrialEndsAt" = "createdAt" + interval '30 days' WHERE "freeTrialEndsAt" IS NULL;

-- Now that every existing row has a real value, set the DB-level default
-- for every future insert (signup route, OAuth first sign-in through the
-- Auth.js Prisma adapter, the admin bootstrap script) — one default, no
-- creation path can miss it.
--
-- The AT TIME ZONE 'UTC' is not decorative — see AGENTS.md's Database time
-- rule. Confirmed live against this project's own dev Postgres (session
-- TimeZone Asia/Dhaka, inherited from the host OS — the exact scenario
-- AGENTS.md documents): a bare `now() + interval '30 days'` default landed
-- 6 hours off from createdAt + 30 days once actually exercised through a
-- real prisma.user.create() call (unlike createdAt's own `@default(now())`,
-- which Prisma's query engine populates client-side and never actually
-- routes through this table's SQL-level DEFAULT clause at all).
ALTER TABLE "User" ALTER COLUMN "freeTrialEndsAt" SET DEFAULT ((now() + interval '30 days') AT TIME ZONE 'UTC');

-- CreateTable
CREATE TABLE "AnonymousAnalysis" (
    "id" TEXT NOT NULL,
    "ipKey" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnonymousAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AnonymousAnalysis_ipKey_createdAt_idx" ON "AnonymousAnalysis"("ipKey", "createdAt");

-- CreateIndex
CREATE INDEX "AnonymousAnalysis_createdAt_idx" ON "AnonymousAnalysis"("createdAt");

-- CreateIndex
CREATE INDEX "AnalysisUsage_userId_createdAt_idx" ON "AnalysisUsage"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AnalysisUsage_userId_storeId_idx" ON "AnalysisUsage"("userId", "storeId");
