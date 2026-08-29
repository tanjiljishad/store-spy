import { auth } from "./auth";
import type { Role } from "../admin/roles";

export interface CurrentUser {
  id: string;
  email: string;
  /**
   * Still a JWT claim (the staff/customer split is B2.5). Everything ELSE
   * about entitlement — plan, quotas, capabilities — is fetched fresh from
   * the control plane at the point of use: `resolveEntitlement()` to gate,
   * `getPurchasedPlanSlug()` for a display label. `CurrentUser` deliberately
   * carries neither.
   */
  role: Role;
}

/**
 * Returns the signed-in user's id/role, or null for an anonymous caller.
 * This — not proxy.ts — is the actual security boundary: every protected
 * route/page calls this itself rather than trusting a proxy/middleware pass
 * to have already checked (this Next.js fork's own docs say the same: a
 * matcher change can silently drop proxy coverage).
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const session = await auth();
  if (!session?.user?.id) return null;
  return {
    id: session.user.id,
    email: session.user.email ?? "",
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
