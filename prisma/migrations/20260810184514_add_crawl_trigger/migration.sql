-- CreateEnum
CREATE TYPE "CrawlTrigger" AS ENUM ('MANUAL', 'SCHEDULED');

-- AlterTable
ALTER TABLE "Crawl" ADD COLUMN     "trigger" "CrawlTrigger" NOT NULL DEFAULT 'MANUAL';
