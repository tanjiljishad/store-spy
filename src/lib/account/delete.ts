import type { PrismaClient } from "@prisma/client";

/**
 * Milestone 12 §4.1: GDPR Art. 17 ("right to erasure"), self-service.
 *
 * "Deletion cascades across watches, usage rows, subscriptions, and
 * checkouts, but audit rows SURVIVE with the user id replaced by a
 * tombstone — an audit log that can be erased by its subject is not an
 * audit log."
 *
 * Watchlist / AnalysisUsage / Account / Session / AdminPermissionGrant /
 * UserAdminRole / MarketingConsent all cascade automatically when the
 * control-plane account (and with it `control_plane.users`) is deleted —
 * their `*_userId_fkey` constraints point there with `ON DELETE CASCADE`
 * (migration 20260828180000). Nothing to do for those here beyond the
 * `cpAccount.deleteMany` below. Subscription and Checkout are deliberately
 * NOT FK-related to the user anywhere in this schema (so a user's billing
 * history can outlive an unrelated admin action elsewhere — same reasoning
 * family as AdminPermissionGrant.grantedByUserId's own doc comment), which
 * means the cascade would silently leave them dangling instead of removing
 * them. The doc's own scope names exactly these two, so both are deleted
 * explicitly, in the same transaction.
 *
 * PromoRedemption and PromoCode.assignedToUserId/createdByUserId are
 * likewise un-FK'd to User but are NOT in the doc's named scope — left
 * untouched, same "survives, not erasure-scoped" status as AdminAuditLog,
 * consistent with how immutable financial/promo records are treated
 * elsewhere in this codebase (PromoCode's own doc comment: "a redemption
 * row's recorded amounts must always be reconcilable").
 */

const TOMBSTONE_EMAIL = "[deleted user]";

function tombstoneUserId(originalUserId: string): string {
  return `deleted:${originalUserId}`;
}

export type DeleteOwnAccountOutcome =
  | { outcome: "deleted"; auditRowsTombstoned: number }
  | { outcome: "user_not_found" }
  | { outcome: "last_super_admin" };

export async function deleteOwnAccount(prisma: PrismaClient, userId: string): Promise<DeleteOwnAccountOutcome> {
  return prisma.$transaction(async (tx) => {
    // B2 2·B commit 3a: existence from control_plane.users; role from
    // store_spy.UserAdminRole (absence = USER).
    const user = await tx.cpUser.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) return { outcome: "user_not_found" };
    const adminRole = await tx.userAdminRole.findUnique({ where: { userId }, select: { role: true } });

    if (adminRole?.role === "SUPER_ADMIN") {
      // Same lock key as updateUserRole() (users-service.ts) — a role
      // demotion and a self-deletion racing each other must never both
      // read "count = 2" and both proceed, leaving zero SUPER_ADMINs with
      // no HTTP path to mint another (see scripts/grant-admin.ts's own
      // doc comment: it's the ONLY way). Not a GDPR carve-out — a
      // SUPER_ADMIN retains the same Art. 17 right as anyone else, just
      // not the right to strand the whole admin system while exercising
      // it; they can still delete their account after demoting themselves
      // or promoting a successor.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('admin:super-admin-count')::bigint)`;
      const superAdminCount = await tx.userAdminRole.count({ where: { role: "SUPER_ADMIN" } });
      if (superAdminCount <= 1) {
        return { outcome: "last_super_admin" };
      }
    }

    await tx.checkout.deleteMany({ where: { userId } });
    await tx.subscription.deleteMany({ where: { userId } });

    // B2 2·B: deleting the control-plane account cascades control_plane.users
    // and, through the *_userId_fkey constraints migration 20260828180000
    // repointed there (ON DELETE CASCADE), every store_spy child too —
    // Watchlist / AnalysisUsage / Account / Session / AdminPermissionGrant /
    // UserAdminRole / MarketingConsent — plus the account's cp subscriptions +
    // entitlements. Account id is `acct_<userId>`; deleteMany so a missing row
    // is a no-op.
    await tx.cpAccount.deleteMany({ where: { id: `acct_${userId}` } });

    // Distinct affected rows counted BEFORE either UPDATE — a row can
    // legitimately match both conditions (e.g. checkout.completed_free's
    // own audit write sets actorId AND targetId to the same acting user),
    // and summing two separate updateMany() counts would double-count it.
    const affected = await tx.adminAuditLog.findMany({
      where: { OR: [{ actorId: userId }, { targetType: "User", targetId: userId }] },
      select: { id: true },
    });

    await tx.adminAuditLog.updateMany({
      where: { actorId: userId },
      data: { actorId: tombstoneUserId(userId), actorEmail: TOMBSTONE_EMAIL },
    });
    await tx.adminAuditLog.updateMany({
      where: { targetType: "User", targetId: userId },
      data: { targetId: tombstoneUserId(userId) },
    });

    // The `cpAccount.deleteMany` above erased everything: control_plane.users
    // and, through the ON DELETE CASCADE *_userId_fkey constraints, every
    // store_spy child (Watchlist / AnalysisUsage / Account / Session /
    // AdminPermissionGrant / UserAdminRole / MarketingConsent).

    return { outcome: "deleted", auditRowsTombstoned: affected.length };
  });
}
