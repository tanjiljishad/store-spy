-- Milestone 4 Sub-phase B: Google advertising intelligence foundation.
--
-- Additive only. Nothing existing is dropped, renamed, or backfilled;
-- every pre-existing table/column keeps its current meaning and every
-- existing write path continues to work unchanged.
--
-- 1. Event.crawlId becomes nullable. Marketing events (AD_DETECTED etc.)
--    are not produced by a Shopify crawl, so they cannot supply a real
--    Crawl row. Every existing Shopify-crawl code path still always
--    supplies a real crawlId — this widens the column, it does not
--    repurpose it. No existing row has a NULL crawlId, so this is a
--    pure constraint relaxation with no data migration required.
ALTER TABLE "Event" ALTER COLUMN "crawlId" DROP NOT NULL;

-- 2. New EventType/EntityType values for marketing events. Postgres can't
--    add enum values and use them in the same transaction, but nothing
--    below references these new values in DML, so running all four ADDs
--    together in this file is safe (unlike the PlanTier RENAME VALUE
--    migration, this is a pure addition — no existing row's value changes).
ALTER TYPE "EventType" ADD VALUE 'AD_DETECTED';
ALTER TYPE "EventType" ADD VALUE 'AD_REMOVED';
ALTER TYPE "EventType" ADD VALUE 'AD_CHANGED';
ALTER TYPE "EventType" ADD VALUE 'PRODUCT_AD_MATCHED';
ALTER TYPE "EntityType" ADD VALUE 'AD';

-- 3. Store.marketingBaselinedAt / nextMarketingCollectionAt — the marketing
--    pipeline's own baseline flag and scheduler claim column, independent
--    of the Shopify crawl schedule's baselinedAt/nextCrawlAt. Defaulting
--    nextMarketingCollectionAt to now() (like nextCrawlAt) means every
--    existing store becomes immediately eligible for its first marketing
--    collection once a scheduler tick runs against it — intentional, not
--    an oversight: there is no backlog to protect against here the way a
--    brand-new free-crawl cadence might need one.
ALTER TABLE "Store" ADD COLUMN "marketingBaselinedAt" TIMESTAMP(3);
ALTER TABLE "Store" ADD COLUMN "nextMarketingCollectionAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- 4. Marketing intelligence tables. See prisma/schema.prisma for the design
--    rationale (Store-scoped never User-scoped; MarketingCollectionRun is
--    the Crawl-equivalent attempt log so a failed vendor check is a
--    recorded fact, never silently "no ads found"; AdObservation is
--    identified by the vendor's externalAdId, never by destination URL).

-- CreateEnum
CREATE TYPE "AdPlatform" AS ENUM ('GOOGLE');

-- CreateEnum
CREATE TYPE "MarketingCollectionOutcome" AS ENUM ('SUCCESS', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "AdObservationStatus" AS ENUM ('ACTIVE_EVIDENCE', 'HISTORICAL');

-- CreateEnum
CREATE TYPE "MatchMethod" AS ENUM ('EXACT_PRODUCT_URL');

-- CreateEnum
CREATE TYPE "MatchConfidence" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateTable
CREATE TABLE "MarketingCollectionRun" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "platform" "AdPlatform" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "outcome" "MarketingCollectionOutcome",
    "reason" TEXT,
    "adsObserved" INTEGER,
    "vendorRequestCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "MarketingCollectionRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdObservation" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "platform" "AdPlatform" NOT NULL,
    "externalAdId" TEXT NOT NULL,
    "advertiserExternalId" TEXT,
    "advertiserName" TEXT,
    "destinationUrl" TEXT,
    "format" TEXT,
    "status" "AdObservationStatus" NOT NULL DEFAULT 'ACTIVE_EVIDENCE',
    "missingStreak" INTEGER NOT NULL DEFAULT 0,
    "matchedProductId" TEXT,
    "matchMethod" "MatchMethod",
    "matchConfidence" "MatchConfidence",
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "sourceMetadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdObservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MarketingCollectionRun_storeId_platform_startedAt_idx" ON "MarketingCollectionRun"("storeId", "platform", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "AdObservation_storeId_status_idx" ON "AdObservation"("storeId", "status");

-- CreateIndex
CREATE INDEX "AdObservation_matchedProductId_idx" ON "AdObservation"("matchedProductId");

-- CreateIndex
CREATE UNIQUE INDEX "AdObservation_storeId_platform_externalAdId_key" ON "AdObservation"("storeId", "platform", "externalAdId");

-- AddForeignKey
ALTER TABLE "MarketingCollectionRun" ADD CONSTRAINT "MarketingCollectionRun_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdObservation" ADD CONSTRAINT "AdObservation_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdObservation" ADD CONSTRAINT "AdObservation_matchedProductId_fkey" FOREIGN KEY ("matchedProductId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
