-- Milestone 12 §4.1 addendum: User.tosAcceptedAt — the one field
-- DashboardLayout gates on, regardless of signup path. Purely additive.
--
-- NOTE: `prisma migrate diff` also proposed re-running the `freeTrialEndsAt`
-- default ALTER (byte-identical expression) — the same known Prisma
-- dbgenerated()-introspection quirk noted in this milestone's earlier
-- migrations. Dropped from this file to keep the migration purely additive.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "tosAcceptedAt" TIMESTAMP(3);
