-- ============================================================================
-- B2 / step 2 : swap the userId foreign keys from store_spy."User" to
--               control_plane.users  (migration "M" in the step-2 plan)
--
-- Runs AFTER deploy 2·A (signup + the custom Auth.js adapter write
-- control_plane.users AND a transitional shadow store_spy."User" row) and
-- BEFORE deploy 2·B (which stops the shadow write). At that point every
-- userId value exists in BOTH tables — the backfill (step 1) covers
-- pre-existing users, the 2·A shadow write covers new ones — so neither the
-- old nor the new constraint can be violated at any instant. See
-- docs/store-spy-control-plane-b2.md "is there a window where ... can fail".
--
-- Constraint names are reused (Watchlist_userId_fkey, ...) so step 6's
-- Cp-prefix drop needs no FK rename. Idempotent. Reversible: see down.sql
-- (only safe while the 2·A shadow write is still active).
-- ============================================================================

-- store_spy child tables that had a real FK to store_spy."User": drop it,
-- re-add the same-named constraint pointing at control_plane.users.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['Account', 'AdminPermissionGrant', 'AnalysisUsage', 'Session', 'Watchlist']
  LOOP
    EXECUTE format('ALTER TABLE "store_spy".%I DROP CONSTRAINT IF EXISTS %I', t, t || '_userId_fkey');
    BEGIN
      EXECUTE format(
        'ALTER TABLE "store_spy".%I ADD CONSTRAINT %I FOREIGN KEY ("userId") '
        || 'REFERENCES "control_plane"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE',
        t, t || '_userId_fkey'
      );
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END LOOP;

  -- The two step-1 tables had NO FK yet (adding one in step 1 would have
  -- broken every test that creates a store_spy."User" with no cp.users row).
  FOREACH t IN ARRAY ARRAY['UserAdminRole', 'MarketingConsent']
  LOOP
    BEGIN
      EXECUTE format(
        'ALTER TABLE "store_spy".%I ADD CONSTRAINT %I FOREIGN KEY ("userId") '
        || 'REFERENCES "control_plane"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE',
        t, t || '_userId_fkey'
      );
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END LOOP;
END $$;
