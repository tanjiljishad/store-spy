-- Milestone 12 §4.2 Step 2: MarketingConversionEvent — the server-side
-- conversion-event queue (signup route writes, worker dispatches). Purely
-- additive.
--
-- NOTE: `prisma migrate diff` also proposed re-running the byte-identical
-- `freeTrialEndsAt` default ALTER — the same known Prisma
-- dbgenerated()-introspection quirk noted in every migration this
-- milestone has hand-edited. Dropped from this file for the same reason.

-- CreateEnum
CREATE TYPE "MarketingConversionEventType" AS ENUM ('SIGNUP');

-- CreateEnum
CREATE TYPE "MarketingConversionDispatchStatus" AS ENUM ('PENDING', 'DISPATCHED', 'SKIPPED_NO_CREDENTIAL', 'FAILED');

-- CreateTable
CREATE TABLE "MarketingConversionEvent" (
    "id" TEXT NOT NULL,
    "eventType" "MarketingConversionEventType" NOT NULL,
    "vendor" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatchStatus" "MarketingConversionDispatchStatus" NOT NULL DEFAULT 'PENDING',
    "dispatchedAt" TIMESTAMP(3),
    "dispatchError" TEXT,

    CONSTRAINT "MarketingConversionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MarketingConversionEvent_dispatchStatus_occurredAt_idx" ON "MarketingConversionEvent"("dispatchStatus", "occurredAt");

-- CreateIndex
CREATE INDEX "MarketingConversionEvent_userId_idx" ON "MarketingConversionEvent"("userId");
