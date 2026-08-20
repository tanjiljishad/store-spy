import { requireUser, ForbiddenError, UnauthorizedError, type CurrentUser } from "../auth/session";
import { hasPermission, type Permission } from "./roles";

export type AdminActor = CurrentUser;

/**
 * The one gate every admin route goes through. Builds on requireUser()
 * (src/lib/auth/session.ts) rather than re-deriving the session — that
 * stays the single security boundary, this only adds a permission check on
 * top of it. Throws UnauthorizedError (via requireUser()) for no session,
 * ForbiddenError for a session that lacks the permission — routes map both
 * to the right status with withAdminRoute() below, never directly.
 */
export async function requirePermission(permission: Permission): Promise<AdminActor> {
  const actor = await requireUser();
  if (!hasPermission(actor.role, permission)) {
    throw new ForbiddenError(`Missing permission: ${permission}`);
  }
  return actor;
}

/**
 * Shared route wrapper: does the permission check, maps UnauthorizedError
 * -> 401 and ForbiddenError -> 403 with the same JSON error shape every
 * other route in this app already uses, and only then calls the handler
 * with a confirmed AdminActor. Keeps every admin route handler itself down
 * to "parse + delegate" — no route re-implements this error mapping.
 */
export async function withAdminRoute(
  permission: Permission,
  handler: (actor: AdminActor) => Promise<Response>,
): Promise<Response> {
  let actor: AdminActor;
  try {
    actor = await requirePermission(permission);
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (e instanceof ForbiddenError) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
    throw e; // a genuinely unexpected failure — never mask it as a 401/403
  }
  return handler(actor);
}
