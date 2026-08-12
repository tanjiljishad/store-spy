-- CreateEnum
CREATE TYPE "StoreEntityKind" AS ENUM ('APP', 'PIXEL', 'COLLECTION', 'PAYMENT_PROVIDER', 'EMAIL_PLATFORM');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "EventType" ADD VALUE 'PAYMENT_PROVIDER_ADDED';
ALTER TYPE "EventType" ADD VALUE 'PAYMENT_PROVIDER_REMOVED';

-- CreateTable
CREATE TABLE "StoreEntity" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "kind" "StoreEntityKind" NOT NULL,
    "key" TEXT NOT NULL,
    "meta" JSONB,
    "status" "ProductStatus" NOT NULL DEFAULT 'ACTIVE',
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "missingSince" TIMESTAMP(3),
    "missingStreak" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "StoreEntity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StoreEntity_storeId_kind_status_idx" ON "StoreEntity"("storeId", "kind", "status");

-- CreateIndex
CREATE INDEX "StoreEntity_kind_key_idx" ON "StoreEntity"("kind", "key");

-- CreateIndex
CREATE UNIQUE INDEX "StoreEntity_storeId_kind_key_key" ON "StoreEntity"("storeId", "kind", "key");

-- AddForeignKey
ALTER TABLE "StoreEntity" ADD CONSTRAINT "StoreEntity_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
