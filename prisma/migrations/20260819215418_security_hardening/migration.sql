-- AlterTable
ALTER TABLE "User" ADD COLUMN     "sessionsValidAfter" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "LoginAttempt" (
    "id" TEXT NOT NULL,
    "emailNormalized" TEXT,
    "ipKey" TEXT,
    "succeeded" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LoginAttempt_emailNormalized_createdAt_idx" ON "LoginAttempt"("emailNormalized", "createdAt");

-- CreateIndex
CREATE INDEX "LoginAttempt_ipKey_createdAt_idx" ON "LoginAttempt"("ipKey", "createdAt");
