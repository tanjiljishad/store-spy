import { auth } from "./auth";
import { prisma } from "../db/prisma";
import { resolvePlanSlug } from "../control-plane/entitlements";
import type { PlanTier } from "../entitlements/plan-limits";
import type { Role } from "../admin/roles";

export interface CurrentUser {
  id: string;
  email: string;
  /**
   * TRANSITIONAL (B2 step 2·B): no longer a JWT claim. Derived fresh from the
   * account's current entitlements every call via resolvePlanSlug() (the 60s
   * staleness window is gone). Still a COARSE label for display and the
   * upgrade prompt — never a gate; every gate calls resolveEntitlement per
   * feature. Removed in commit 3 once the UI reads entitlements directly — at
   * which point the resolvePlanSlug() call below stops running on every
   * authenticated request. Grep "TRANSITIONAL (B2 step 2·B)".
   */
  plan: PlanTier;
  role: Role;
}

/**
 * Returns the signed-in user's id/plan/role, or null for an anonymous
 * caller. This — not proxy.ts — is the actual security boundary: every
 * protected route/page calls this itself rather than trusting a proxy/
 * middleware pass to have already checked (this Next.js fork's own docs
 * say the same: a matcher change can silently drop proxy coverage).
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const session = await auth();
  if (!session?.user?.id) return null;
  const id = session.user.id;
  return {
    id,
    email: session.user.email ?? "",
    plan: await resolvePlanSlug(prisma, id),
    role: (session.user.role as Role) ?? "USER",
  };
}

export class UnauthorizedError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "UnauthorizedError";
  }
}

/** Signed in, but the role lacks the permission a route/action requires. See admin/guard.ts. */
export class ForbiddenError extends Error {
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/** For routes/pages that must have a signed-in user — throws rather than returning null. */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) throw new UnauthorizedError();
  return user;
}
