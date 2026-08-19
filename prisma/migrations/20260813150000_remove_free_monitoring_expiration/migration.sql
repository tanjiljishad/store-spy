-- Existing active watches must receive the same non-expiring entitlement as
-- newly created watches. This is a data-only migration: no billing schema or
-- provider-specific persistence is introduced.
UPDATE "Watchlist"
SET "monitoringExpiresAt" = NULL
WHERE "monitoringStatus" = 'ACTIVE' AND "monitoringExpiresAt" IS NOT NULL;
