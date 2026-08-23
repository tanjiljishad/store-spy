-- Milestone 12 §4.1 addendum: extends the "metadata must never contain
-- secrets" rule (audit.ts) to cover PII. Two call sites, found by
-- exhaustively grepping every recordAdminAction() call site in src/,
-- historically embedded a subject's email directly in AdminAuditLog.metadata:
--
--   1. subscription.expire (billing/subscription-sweep.ts) wrote
--      metadata.userEmail — always redundant with targetId, which already
--      identifies the same user.
--   2. user.export (admin/analytics/user-export.ts) wrote metadata.filters.
--      emailQuery verbatim whenever an admin searched by a specific email —
--      no targetId exists for a bulk export to fall back on, so this is
--      replaced with a non-identifying boolean (hasEmailFilter) rather than
--      just removed, preserving "an email filter was used" as real audit
--      signal without the address itself.
--
-- Both code paths were fixed in the same change that added this migration
-- (recordAdminAction() itself now also rejects any FUTURE write containing
-- an email-shaped metadata value at write time — see audit.ts/audit-pii.ts).
-- This migration is the one-time backfill for rows written BEFORE that fix.
--
-- No schema change — pure data scrub.

-- 1. subscription.expire: drop the redundant userEmail key entirely.
UPDATE "AdminAuditLog"
SET metadata = metadata - 'userEmail'
WHERE action = 'subscription.expire'
  AND metadata ? 'userEmail';

-- 2. user.export: replace filters.emailQuery with filters.hasEmailFilter,
-- matching the new code's own output shape exactly.
UPDATE "AdminAuditLog"
SET metadata = jsonb_set(
  metadata #- '{filters,emailQuery}',
  '{filters,hasEmailFilter}',
  to_jsonb((metadata #> '{filters,emailQuery}') IS NOT NULL)
)
WHERE action = 'user.export'
  AND metadata ? 'filters'
  AND (metadata -> 'filters') ? 'emailQuery';
