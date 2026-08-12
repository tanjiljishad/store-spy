-- Milestone 3 Sub-phase C: introduce the BASIC paid tier.
--
-- 1. Rename PlanTier's PRO value to BASIC. Safe, no-data-loss: nothing in
--    this codebase has ever set a User's plan to PRO (no billing exists),
--    so no live row references it. Written by hand rather than letting
--    `prisma migrate dev` auto-generate it, because Prisma's schema-diff
--    engine has no special awareness of "rename an enum value" — editing
--    the enum in schema.prisma and letting it auto-diff risks a
--    DROP-and-recreate migration instead of this single safe statement.
ALTER TYPE "PlanTier" RENAME VALUE 'PRO' TO 'BASIC';

-- 2. Drop the "at most one ACTIVE watch per user" partial unique index
--    added in Sub-phase A. It hard-coded FREE's limit (1) as a database
--    constraint; BASIC needs up to 20 concurrent active watches per user.
--    A unique index can only ever express "at most one" — it cannot
--    express "at most N" for N > 1 — so enforcement moves entirely to the
--    service layer (startMonitoring()'s existing advisory-lock + COUNT
--    check in src/lib/monitoring/watch.ts, which already worked for any N,
--    not just 1 — no logic change was needed there, only this index had to
--    go). This exactly mirrors how AnalysisUsage's "at most 3" limit was
--    already enforced without any unique-index backstop, for the same
--    underlying reason.
DROP INDEX "Watchlist_one_active_per_user";
