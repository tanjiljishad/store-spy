-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "Role" ADD VALUE 'MARKETING_ADMIN';
ALTER TYPE "Role" ADD VALUE 'MANAGER';

-- CreateTable
CREATE TABLE "AdminPermissionGrant" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "grantedByUserId" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "AdminPermissionGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdminPermissionGrant_userId_permission_idx" ON "AdminPermissionGrant"("userId", "permission");

-- CreateIndex
CREATE INDEX "AdminPermissionGrant_expiresAt_idx" ON "AdminPermissionGrant"("expiresAt");

-- AddForeignKey
ALTER TABLE "AdminPermissionGrant" ADD CONSTRAINT "AdminPermissionGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Milestone 12 §2.1: a partial unique index, not expressible via Prisma's
-- @@unique DSL (no WHERE-clause support) — see AdminPermissionGrant's own
-- schema.prisma doc comment for why this can only check revokedAt IS NULL,
-- not also expiresAt, and why that's an accepted, documented limitation
-- rather than a bug. Defense in depth alongside grantPermission()'s own
-- advisory-lock + check-then-insert, not the primary enforcement mechanism.
CREATE UNIQUE INDEX "AdminPermissionGrant_userId_permission_active_key"
    ON "AdminPermissionGrant"("userId", "permission")
    WHERE "revokedAt" IS NULL;
