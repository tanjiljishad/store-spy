-- Milestone 12 Phase 3: MetricSnapshot, the read-only store the admin
-- analytics dashboard reads from. Purely additive.
--
-- NOTE: `prisma migrate diff` also proposed re-running the
-- `freeTrialEndsAt` default ALTER from 20260820163932_freemium_windowed_ledger
-- (byte-identical expression) — a known Prisma quirk introspecting
-- dbgenerated() raw-SQL defaults, not a real change. Dropped from this file
-- to keep the migration purely additive, per this milestone's own rule.

-- CreateTable
CREATE TABLE "MetricSnapshot" (
    "id" TEXT NOT NULL,
    "metricKey" TEXT NOT NULL,
    "dimension" TEXT NOT NULL DEFAULT '',
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MetricSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MetricSnapshot_metricKey_dimension_windowEnd_idx" ON "MetricSnapshot"("metricKey", "dimension", "windowEnd" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "MetricSnapshot_metricKey_dimension_windowStart_windowEnd_key" ON "MetricSnapshot"("metricKey", "dimension", "windowStart", "windowEnd");
