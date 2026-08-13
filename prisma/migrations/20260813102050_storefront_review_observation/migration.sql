-- CreateTable
CREATE TABLE "StorefrontReviewObservation" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "crawlId" TEXT NOT NULL,
    "reviewCount" INTEGER,
    "ratingValue" DOUBLE PRECISION,
    "source" TEXT NOT NULL DEFAULT 'storefront_jsonld',
    "provider" TEXT,
    "sharedWithGroup" BOOLEAN NOT NULL DEFAULT false,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StorefrontReviewObservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StorefrontReviewObservation_productId_observedAt_idx" ON "StorefrontReviewObservation"("productId", "observedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "StorefrontReviewObservation_productId_crawlId_key" ON "StorefrontReviewObservation"("productId", "crawlId");

-- AddForeignKey
ALTER TABLE "StorefrontReviewObservation" ADD CONSTRAINT "StorefrontReviewObservation_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StorefrontReviewObservation" ADD CONSTRAINT "StorefrontReviewObservation_crawlId_fkey" FOREIGN KEY ("crawlId") REFERENCES "Crawl"("id") ON DELETE CASCADE ON UPDATE CASCADE;
