import { requireUser, ForbiddenError, UnauthorizedError, type CurrentUser } from "../auth/session";
import { prisma } from "../db/prisma";
import { hasPermission, type Permission } from "./roles";
import { hasActiveGrant } from "./permissions-service";

export type AdminActor = CurrentUser;

/**
 * The one gate every admin route goes through. Builds on requireUser()
 * (src/lib/auth/session.ts) rather than re-deriving the session — that
 * stays the single security boundary, this only adds a permission check on
 * top of it. Throws UnauthorizedError (via requireUser()) for no session,
 * ForbiddenError for a session that lacks the permission — routes map both
 * to the right status with withAdminRoute() below, never directly.
 *
 * Milestone 12 §2.1: checks the role first (no DB query — hasPermission()
 * is a pure in-memory lookup) and only falls through to a grant lookup when
 * the role alone doesn't already cover it, so the common case (a role that
 * already has the permission) pays no extra query cost. Deliberately reads
 * grants live, on every call, the same way Milestone 11's amended `jwt`
 * callback re-reads `role` on every request for a non-USER role — caching
 * grants in the token would reintroduce exactly the staleness window that
 * amendment closed. See permissions-service.ts's hasActiveGrant().
 */
export async function requirePermission(permission: Permission): Promise<AdminActor> {
  const actor = await requireUser();
  if (hasPermission(actor.role, permission)) return actor;
  if (await hasActiveGrant(prisma, actor.id, permission)) return actor;
  throw new ForbiddenError(`Missing permission: ${permission}`);
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
