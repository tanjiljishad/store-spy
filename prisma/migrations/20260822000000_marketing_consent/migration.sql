-- Milestone 12 Phase 4 §4.1: marketing consent fields on User. Purely
-- additive.
--
-- NOTE: `prisma migrate diff` also proposed re-running the `freeTrialEndsAt`
-- default ALTER from 20260820163932_freemium_windowed_ledger (byte-identical
-- expression) — the same known Prisma dbgenerated()-introspection quirk
-- noted in 20260821000000_analytics_metric_snapshot/migration.sql. Dropped
-- from this file to keep the migration purely additive.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "marketingConsent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "marketingConsentAt" TIMESTAMP(3),
ADD COLUMN     "marketingConsentSource" TEXT;
