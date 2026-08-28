-- Reverse of 20260828180000_b2_step2_swap_user_fks_to_control_plane.
-- Not consumed by `prisma migrate deploy`. Verified forward -> down -> forward
-- on a scratch DB.
--
-- ONLY safe while deploy 2·A's shadow store_spy."User" write is still active
-- (i.e. before 2·B). After 2·B, new users have no store_spy."User" row and
-- re-adding the old FK would fail. Reverting past that point means reverting
-- 2·B's code first.

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['Account', 'AdminPermissionGrant', 'AnalysisUsage', 'Session', 'Watchlist']
  LOOP
    EXECUTE format('ALTER TABLE "store_spy".%I DROP CONSTRAINT IF EXISTS %I', t, t || '_userId_fkey');
    BEGIN
      EXECUTE format(
        'ALTER TABLE "store_spy".%I ADD CONSTRAINT %I FOREIGN KEY ("userId") '
        || 'REFERENCES "store_spy"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE',
        t, t || '_userId_fkey'
      );
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END LOOP;

  FOREACH t IN ARRAY ARRAY['UserAdminRole', 'MarketingConsent']
  LOOP
    EXECUTE format('ALTER TABLE "store_spy".%I DROP CONSTRAINT IF EXISTS %I', t, t || '_userId_fkey');
  END LOOP;
END $$;
