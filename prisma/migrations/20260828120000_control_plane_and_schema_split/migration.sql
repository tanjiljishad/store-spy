-- ============================================================================
-- Task B / B1 : control plane + schema split
--
-- Two things happen here, in one migration:
--
--   1. SCHEMA SPLIT (non-destructive). Every existing enum and table is moved
--      out of `public` into a named `store_spy` schema with ALTER ... SET
--      SCHEMA. No table is dropped or recreated: all rows, sequences, PKs,
--      FKs and indexes travel with their object. `prisma migrate diff`
--      cannot represent a schema move (it emits a full CREATE TABLE for every
--      relocated table), so this half is hand-written. Verified forward and
--      backward against an empty database; see down.sql.
--
--   2. CONTROL PLANE (new). The shared identity / billing / entitlements
--      layer: 8 tables + 2 enums in a new `control_plane` schema, plus a
--      two-row seed of the product catalogue. Lifted verbatim from
--      `prisma migrate diff`.
--
-- `_prisma_migrations` deliberately stays in `public` (the connection
-- string keeps `?schema=public`); Prisma keeps its bookkeeping table there.
-- ============================================================================

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "store_spy";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "control_plane";

-- ----------------------------------------------------------------------------
-- 1a. Move existing ENUM types: public -> store_spy
-- ----------------------------------------------------------------------------
ALTER TYPE "public"."Platform" SET SCHEMA "store_spy";
ALTER TYPE "public"."CrawlTier" SET SCHEMA "store_spy";
ALTER TYPE "public"."CrawlStatus" SET SCHEMA "store_spy";
ALTER TYPE "public"."CrawlTrigger" SET SCHEMA "store_spy";
ALTER TYPE "public"."ProductStatus" SET SCHEMA "store_spy";
ALTER TYPE "public"."StoreEntityKind" SET SCHEMA "store_spy";
ALTER TYPE "public"."EventType" SET SCHEMA "store_spy";
ALTER TYPE "public"."EntityType" SET SCHEMA "store_spy";
ALTER TYPE "public"."PlanTier" SET SCHEMA "store_spy";
ALTER TYPE "public"."Role" SET SCHEMA "store_spy";
ALTER TYPE "public"."WatchStatus" SET SCHEMA "store_spy";
ALTER TYPE "public"."AdPlatform" SET SCHEMA "store_spy";
ALTER TYPE "public"."MarketingCollectionOutcome" SET SCHEMA "store_spy";
ALTER TYPE "public"."AdObservationStatus" SET SCHEMA "store_spy";
ALTER TYPE "public"."MatchMethod" SET SCHEMA "store_spy";
ALTER TYPE "public"."MatchConfidence" SET SCHEMA "store_spy";
ALTER TYPE "public"."DiscountType" SET SCHEMA "store_spy";
ALTER TYPE "public"."PromoStatus" SET SCHEMA "store_spy";
ALTER TYPE "public"."CheckoutStatus" SET SCHEMA "store_spy";
ALTER TYPE "public"."SubscriptionSource" SET SCHEMA "store_spy";
ALTER TYPE "public"."SubscriptionStatus" SET SCHEMA "store_spy";
ALTER TYPE "public"."MarketingConversionEventType" SET SCHEMA "store_spy";
ALTER TYPE "public"."MarketingConversionDispatchStatus" SET SCHEMA "store_spy";

-- ----------------------------------------------------------------------------
-- 1b. Move existing TABLES: public -> store_spy (indexes / PKs / FKs / sequences follow)
-- ----------------------------------------------------------------------------
ALTER TABLE "public"."Store" SET SCHEMA "store_spy";
ALTER TABLE "public"."StoreStats" SET SCHEMA "store_spy";
ALTER TABLE "public"."Crawl" SET SCHEMA "store_spy";
ALTER TABLE "public"."Product" SET SCHEMA "store_spy";
ALTER TABLE "public"."ProductStateSnapshot" SET SCHEMA "store_spy";
ALTER TABLE "public"."StorefrontReviewObservation" SET SCHEMA "store_spy";
ALTER TABLE "public"."StoreEntity" SET SCHEMA "store_spy";
ALTER TABLE "public"."Event" SET SCHEMA "store_spy";
ALTER TABLE "public"."User" SET SCHEMA "store_spy";
ALTER TABLE "public"."AdminAuditLog" SET SCHEMA "store_spy";
ALTER TABLE "public"."AdminPermissionGrant" SET SCHEMA "store_spy";
ALTER TABLE "public"."LoginAttempt" SET SCHEMA "store_spy";
ALTER TABLE "public"."Account" SET SCHEMA "store_spy";
ALTER TABLE "public"."Session" SET SCHEMA "store_spy";
ALTER TABLE "public"."VerificationToken" SET SCHEMA "store_spy";
ALTER TABLE "public"."Watchlist" SET SCHEMA "store_spy";
ALTER TABLE "public"."AnalysisUsage" SET SCHEMA "store_spy";
ALTER TABLE "public"."AnonymousAnalysis" SET SCHEMA "store_spy";
ALTER TABLE "public"."MarketingCollectionRun" SET SCHEMA "store_spy";
ALTER TABLE "public"."AdObservation" SET SCHEMA "store_spy";
ALTER TABLE "public"."PromoCode" SET SCHEMA "store_spy";
ALTER TABLE "public"."PromoRedemption" SET SCHEMA "store_spy";
ALTER TABLE "public"."Checkout" SET SCHEMA "store_spy";
ALTER TABLE "public"."Subscription" SET SCHEMA "store_spy";
ALTER TABLE "public"."MetricSnapshot" SET SCHEMA "store_spy";
ALTER TABLE "public"."MarketingConversionEvent" SET SCHEMA "store_spy";

-- ----------------------------------------------------------------------------
-- 2a. Create the control_plane schema objects (verbatim from prisma migrate diff)
-- ----------------------------------------------------------------------------
-- CreateEnum
CREATE TYPE "control_plane"."account_role" AS ENUM ('OWNER', 'MEMBER');

-- CreateEnum
CREATE TYPE "control_plane"."subscription_status" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'EXPIRED');

-- CreateTable
CREATE TABLE "control_plane"."accounts" (
    "id" TEXT NOT NULL,
    "billing_email" TEXT NOT NULL,
    "provider_customer_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control_plane"."users" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT,
    "account_role" "control_plane"."account_role" NOT NULL DEFAULT 'OWNER',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control_plane"."products" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control_plane"."subscriptions" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "status" "control_plane"."subscription_status" NOT NULL,
    "period_end" TIMESTAMP(3),
    "provider_ref" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control_plane"."entitlements" (
    "id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "feature_key" TEXT NOT NULL,
    "quota" INTEGER,
    "used" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "entitlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control_plane"."staff" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT,
    "is_superadmin" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control_plane"."staff_roles" (
    "id" TEXT NOT NULL,
    "staff_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,

    CONSTRAINT "staff_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control_plane"."audit_log" (
    "id" TEXT NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "accounts_provider_customer_id_key" ON "control_plane"."accounts"("provider_customer_id");
CREATE UNIQUE INDEX "users_email_key" ON "control_plane"."users"("email");
CREATE INDEX "users_account_id_idx" ON "control_plane"."users"("account_id");
CREATE UNIQUE INDEX "products_slug_key" ON "control_plane"."products"("slug");
CREATE INDEX "subscriptions_account_id_product_id_status_idx" ON "control_plane"."subscriptions"("account_id", "product_id", "status");
CREATE UNIQUE INDEX "entitlements_subscription_id_feature_key_key" ON "control_plane"."entitlements"("subscription_id", "feature_key");
CREATE UNIQUE INDEX "staff_email_key" ON "control_plane"."staff"("email");
CREATE INDEX "staff_roles_product_id_idx" ON "control_plane"."staff_roles"("product_id");
CREATE UNIQUE INDEX "staff_roles_staff_id_product_id_role_key" ON "control_plane"."staff_roles"("staff_id", "product_id", "role");
CREATE INDEX "audit_log_actor_type_actor_id_created_at_idx" ON "control_plane"."audit_log"("actor_type", "actor_id", "created_at");
CREATE INDEX "audit_log_action_created_at_idx" ON "control_plane"."audit_log"("action", "created_at");

-- AddForeignKey
ALTER TABLE "control_plane"."users" ADD CONSTRAINT "users_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "control_plane"."accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "control_plane"."subscriptions" ADD CONSTRAINT "subscriptions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "control_plane"."accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "control_plane"."subscriptions" ADD CONSTRAINT "subscriptions_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "control_plane"."products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "control_plane"."entitlements" ADD CONSTRAINT "entitlements_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "control_plane"."subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "control_plane"."staff_roles" ADD CONSTRAINT "staff_roles_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "control_plane"."staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "control_plane"."staff_roles" ADD CONSTRAINT "staff_roles_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "control_plane"."products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- 2b. Seed the product catalogue. Stable, readable ids on purpose: the
--     entitlements endpoint and the Find Suppliers codebase both resolve a
--     product by slug, and a predictable id for store-spy is convenient for
--     fixtures and manual inspection.
-- ----------------------------------------------------------------------------
INSERT INTO "control_plane"."products" ("id", "slug", "name") VALUES
  ('prod_store_spy',      'store-spy',      'Store Spy'),
  ('prod_find_suppliers', 'find-suppliers', 'Find Suppliers');
