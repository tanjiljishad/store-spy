import type { PrismaClient } from "@prisma/client";

/**
 * The one condition DashboardLayout and AdminLayout both check —
 * `emailVerified IS NULL` — mirroring needsConsentInterstitial()'s own
 * shape and its same reasoning: a fresh DB read, not derived from the JWT
 * (the session token doesn't carry this field, and it never needs checking
 * more than once per account's whole lifetime once it flips true).
 *
 * A Credentials account starts with `emailVerified: null` and is set by
 * GET /verify-email (the mailed link) or by manual operator action. An
 * OAuth account gets `emailVerified` set directly at creation time — see
 * auth.ts's Google/Facebook `profile()` overrides — since Google/Facebook
 * have already verified that email themselves; this check treats both
 * paths identically, it just never fires for a correctly-created OAuth row.
 */
export async function needsEmailVerification(prisma: Pick<PrismaClient, "user">, userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { emailVerified: true } });
  // A user row that's vanished (e.g. mid-deletion) needs no gate — nothing
  // left to verify, and the caller's own getCurrentUser()/requireUser()
  // check handles "no real account" separately.
  if (!user) return false;
  return user.emailVerified === null;
}
