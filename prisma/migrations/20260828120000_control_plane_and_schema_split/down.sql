-- Reverse of 20260828120000_control_plane_and_schema_split.
-- Not consumed by `prisma migrate deploy` (Prisma has no down runner) — kept
-- for review and manually verified against an empty database.

-- Drop control_plane (FK-safe order)
DROP TABLE "control_plane"."audit_log";
DROP TABLE "control_plane"."staff_roles";
DROP TABLE "control_plane"."entitlements";
DROP TABLE "control_plane"."subscriptions";
DROP TABLE "control_plane"."staff";
DROP TABLE "control_plane"."products";
DROP TABLE "control_plane"."users";
DROP TABLE "control_plane"."accounts";
DROP TYPE "control_plane"."subscription_status";
DROP TYPE "control_plane"."account_role";

-- Move tables back: store_spy -> public
ALTER TABLE "store_spy"."MarketingConversionEvent" SET SCHEMA "public";
ALTER TABLE "store_spy"."MetricSnapshot" SET SCHEMA "public";
ALTER TABLE "store_spy"."Subscription" SET SCHEMA "public";
ALTER TABLE "store_spy"."Checkout" SET SCHEMA "public";
ALTER TABLE "store_spy"."PromoRedemption" SET SCHEMA "public";
ALTER TABLE "store_spy"."PromoCode" SET SCHEMA "public";
ALTER TABLE "store_spy"."AdObservation" SET SCHEMA "public";
ALTER TABLE "store_spy"."MarketingCollectionRun" SET SCHEMA "public";
ALTER TABLE "store_spy"."AnonymousAnalysis" SET SCHEMA "public";
ALTER TABLE "store_spy"."AnalysisUsage" SET SCHEMA "public";
ALTER TABLE "store_spy"."Watchlist" SET SCHEMA "public";
ALTER TABLE "store_spy"."VerificationToken" SET SCHEMA "public";
ALTER TABLE "store_spy"."Session" SET SCHEMA "public";
ALTER TABLE "store_spy"."Account" SET SCHEMA "public";
ALTER TABLE "store_spy"."LoginAttempt" SET SCHEMA "public";
ALTER TABLE "store_spy"."AdminPermissionGrant" SET SCHEMA "public";
ALTER TABLE "store_spy"."AdminAuditLog" SET SCHEMA "public";
ALTER TABLE "store_spy"."User" SET SCHEMA "public";
ALTER TABLE "store_spy"."Event" SET SCHEMA "public";
ALTER TABLE "store_spy"."StoreEntity" SET SCHEMA "public";
ALTER TABLE "store_spy"."StorefrontReviewObservation" SET SCHEMA "public";
ALTER TABLE "store_spy"."ProductStateSnapshot" SET SCHEMA "public";
ALTER TABLE "store_spy"."Product" SET SCHEMA "public";
ALTER TABLE "store_spy"."Crawl" SET SCHEMA "public";
ALTER TABLE "store_spy"."StoreStats" SET SCHEMA "public";
ALTER TABLE "store_spy"."Store" SET SCHEMA "public";

-- Move enum types back: store_spy -> public
ALTER TYPE "store_spy"."MarketingConversionDispatchStatus" SET SCHEMA "public";
ALTER TYPE "store_spy"."MarketingConversionEventType" SET SCHEMA "public";
ALTER TYPE "store_spy"."SubscriptionStatus" SET SCHEMA "public";
ALTER TYPE "store_spy"."SubscriptionSource" SET SCHEMA "public";
ALTER TYPE "store_spy"."CheckoutStatus" SET SCHEMA "public";
ALTER TYPE "store_spy"."PromoStatus" SET SCHEMA "public";
ALTER TYPE "store_spy"."DiscountType" SET SCHEMA "public";
ALTER TYPE "store_spy"."MatchConfidence" SET SCHEMA "public";
ALTER TYPE "store_spy"."MatchMethod" SET SCHEMA "public";
ALTER TYPE "store_spy"."AdObservationStatus" SET SCHEMA "public";
ALTER TYPE "store_spy"."MarketingCollectionOutcome" SET SCHEMA "public";
ALTER TYPE "store_spy"."AdPlatform" SET SCHEMA "public";
ALTER TYPE "store_spy"."WatchStatus" SET SCHEMA "public";
ALTER TYPE "store_spy"."Role" SET SCHEMA "public";
ALTER TYPE "store_spy"."PlanTier" SET SCHEMA "public";
ALTER TYPE "store_spy"."EntityType" SET SCHEMA "public";
ALTER TYPE "store_spy"."EventType" SET SCHEMA "public";
ALTER TYPE "store_spy"."StoreEntityKind" SET SCHEMA "public";
ALTER TYPE "store_spy"."ProductStatus" SET SCHEMA "public";
ALTER TYPE "store_spy"."CrawlTrigger" SET SCHEMA "public";
ALTER TYPE "store_spy"."CrawlStatus" SET SCHEMA "public";
ALTER TYPE "store_spy"."CrawlTier" SET SCHEMA "public";
ALTER TYPE "store_spy"."Platform" SET SCHEMA "public";

DROP SCHEMA "control_plane";
DROP SCHEMA "store_spy";
