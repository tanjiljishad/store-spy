-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "domainAgeCheckedAt" TIMESTAMP(3),
ADD COLUMN     "domainRegisteredAt" TIMESTAMP(3),
ADD COLUMN     "firstArchivedAt" TIMESTAMP(3);
