-- Belt-and-suspenders DB-level backstop for "a free user may have at most
-- one ACTIVE monitoring watch." The service layer (src/lib/entitlements)
-- checks this before activating a watch, but Prisma's schema DSL can't
-- express a partial/filtered unique index, so it's added here by hand —
-- same pattern as the raw-SQL claim query in monitoring/scheduler.ts.
-- Concurrent attempts to activate a second watch race safely: whichever
-- transaction's row lands first wins the index, the second gets a unique
-- violation that the service layer surfaces as a clean entitlement error.
CREATE UNIQUE INDEX "Watchlist_one_active_per_user"
  ON "Watchlist" ("userId")
  WHERE "monitoringStatus" = 'ACTIVE';
