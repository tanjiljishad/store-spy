-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('SHOPIFY', 'WOOCOMMERCE', 'BIGCOMMERCE', 'MAGENTO', 'CUSTOM', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "CrawlTier" AS ENUM ('HOT', 'WARM', 'COOL', 'COLD', 'DORMANT', 'DISABLED');

-- CreateEnum
CREATE TYPE "CrawlStatus" AS ENUM ('RUNNING', 'OK', 'PARTIAL', 'FAILED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('ACTIVE', 'MISSING', 'REMOVED');

-- CreateEnum
CREATE TYPE "EventType" AS ENUM ('STORE_BASELINED', 'PRODUCT_ADDED', 'PRODUCT_REMOVED', 'PRODUCT_RESTORED', 'PRICE_DROP', 'PRICE_INCREASE', 'SALE_STARTED', 'SALE_ENDED', 'PRODUCT_SOLD_OUT', 'PRODUCT_RESTOCKED', 'VARIANT_SOLD_OUT', 'BESTSELLER_ENTERED', 'BESTSELLER_CLIMBED', 'BESTSELLER_DROPPED', 'COLLECTION_ADDED', 'COLLECTION_REMOVED', 'THEME_CHANGED', 'APP_ADDED', 'APP_REMOVED', 'PIXEL_ADDED', 'PIXEL_REMOVED');

-- CreateEnum
CREATE TYPE "EntityType" AS ENUM ('STORE', 'PRODUCT', 'VARIANT', 'COLLECTION', 'TECH');

-- CreateTable
CREATE TABLE "Store" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "platform" "Platform" NOT NULL DEFAULT 'UNKNOWN',
    "tier" "CrawlTier" NOT NULL DEFAULT 'COLD',
    "name" TEXT,
    "currency" VARCHAR(3),
    "countryCode" VARCHAR(2),
    "themeName" TEXT,
    "themeVersion" TEXT,
    "baselinedAt" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastCrawledAt" TIMESTAMP(3),
    "lastChangedAt" TIMESTAMP(3),
    "nextCrawlAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unchangedStreak" INTEGER NOT NULL DEFAULT 0,
    "failureStreak" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Store_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreStats" (
    "storeId" TEXT NOT NULL,
    "windowDays" INTEGER NOT NULL DEFAULT 30,
    "priceChangesInWindow" INTEGER NOT NULL DEFAULT 0,
    "productsAddedInWindow" INTEGER NOT NULL DEFAULT 0,
    "productsRemovedInWindow" INTEGER NOT NULL DEFAULT 0,
    "crawlsInWindow" INTEGER NOT NULL DEFAULT 0,
    "medianPriceCents" INTEGER,
    "productCount" INTEGER NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoreStats_pkey" PRIMARY KEY ("storeId")
);

-- CreateTable
CREATE TABLE "Crawl" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "status" "CrawlStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "catalogHash" VARCHAR(64),
    "rankHash" VARCHAR(64),
    "techHash" VARCHAR(64),
    "pagesExpected" INTEGER,
    "pagesFetched" INTEGER,
    "productCount" INTEGER,
    "httpErrors" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER,
    "errorMessage" TEXT,

    CONSTRAINT "Crawl_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "vendor" TEXT,
    "productType" TEXT,
    "tags" TEXT[],
    "sourceCreatedAt" TIMESTAMP(3),
    "status" "ProductStatus" NOT NULL DEFAULT 'ACTIVE',
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "missingSince" TIMESTAMP(3),
    "missingStreak" INTEGER NOT NULL DEFAULT 0,
    "priceMinCents" INTEGER NOT NULL,
    "priceMaxCents" INTEGER NOT NULL,
    "compareAtMaxCents" INTEGER,
    "variantCount" INTEGER NOT NULL DEFAULT 0,
    "availableVariants" INTEGER NOT NULL DEFAULT 0,
    "bestsellerRank" INTEGER,
    "imageHash" VARCHAR(32),

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductStateSnapshot" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "crawlId" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "priceMinCents" INTEGER NOT NULL,
    "priceMaxCents" INTEGER NOT NULL,
    "compareAtMaxCents" INTEGER,
    "variantCount" INTEGER NOT NULL,
    "availableVariants" INTEGER NOT NULL,
    "bestsellerRank" INTEGER,

    CONSTRAINT "ProductStateSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "crawlId" TEXT NOT NULL,
    "entityType" "EntityType" NOT NULL,
    "entityKey" TEXT NOT NULL,
    "eventType" "EventType" NOT NULL,
    "oldValue" JSONB,
    "newValue" JSONB,
    "significance" INTEGER NOT NULL,
    "headline" TEXT NOT NULL,
    "backfilled" BOOLEAN NOT NULL DEFAULT false,
    "dedupeKey" TEXT NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "lookupsUsed" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Watchlist" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "alertThreshold" INTEGER NOT NULL DEFAULT 60,
    "lastDigestAt" TIMESTAMP(3),

    CONSTRAINT "Watchlist_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Store_domain_key" ON "Store"("domain");

-- CreateIndex
CREATE INDEX "Store_tier_nextCrawlAt_idx" ON "Store"("tier", "nextCrawlAt");

-- CreateIndex
CREATE INDEX "Store_platform_idx" ON "Store"("platform");

-- CreateIndex
CREATE INDEX "Crawl_storeId_startedAt_idx" ON "Crawl"("storeId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "Product_storeId_status_idx" ON "Product"("storeId", "status");

-- CreateIndex
CREATE INDEX "Product_imageHash_idx" ON "Product"("imageHash");

-- CreateIndex
CREATE UNIQUE INDEX "Product_storeId_externalId_key" ON "Product"("storeId", "externalId");

-- CreateIndex
CREATE INDEX "ProductStateSnapshot_productId_capturedAt_idx" ON "ProductStateSnapshot"("productId", "capturedAt" DESC);

-- CreateIndex
CREATE INDEX "Event_storeId_occurredAt_idx" ON "Event"("storeId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "Event_storeId_significance_occurredAt_idx" ON "Event"("storeId", "significance" DESC, "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "Event_eventType_occurredAt_idx" ON "Event"("eventType", "occurredAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Event_dedupeKey_key" ON "Event"("dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Watchlist_storeId_idx" ON "Watchlist"("storeId");

-- CreateIndex
CREATE UNIQUE INDEX "Watchlist_userId_storeId_key" ON "Watchlist"("userId", "storeId");

-- AddForeignKey
ALTER TABLE "StoreStats" ADD CONSTRAINT "StoreStats_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Crawl" ADD CONSTRAINT "Crawl_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductStateSnapshot" ADD CONSTRAINT "ProductStateSnapshot_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductStateSnapshot" ADD CONSTRAINT "ProductStateSnapshot_crawlId_fkey" FOREIGN KEY ("crawlId") REFERENCES "Crawl"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_crawlId_fkey" FOREIGN KEY ("crawlId") REFERENCES "Crawl"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Watchlist" ADD CONSTRAINT "Watchlist_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Watchlist" ADD CONSTRAINT "Watchlist_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
