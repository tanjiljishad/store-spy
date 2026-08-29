import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", () => {
  class UnauthorizedError extends Error {
    constructor() {
      super("Unauthorized");
      this.name = "UnauthorizedError";
    }
  }
  class ForbiddenError extends Error {
    constructor(message = "Forbidden") {
      super(message);
      this.name = "ForbiddenError";
    }
  }
  const getCurrentUser = vi.fn();
  const requireUser = async () => {
    const user = await getCurrentUser();
    if (!user) throw new UnauthorizedError();
    return user;
  };
  return { getCurrentUser, requireUser, UnauthorizedError, ForbiddenError };
});

// Milestone 12 §2.1: requirePermission() now falls through to a real DB
// lookup (hasActiveGrant()) whenever the role alone doesn't already cover
// the permission — this is a genuine, deliberate behavior, not something to
// work around. But `npm test` must stay DB-free (vitest.config.ts's own
// doc comment), so this unit suite mocks @/lib/db/prisma the same way
// analyze-route.test.ts and other route-level unit tests already do,
// rather than letting requirePermission() reach a real Postgres connection
// that may not exist in this environment.
const findFirstMock = vi.fn(async (_args: unknown) => null as { id: string } | null);
vi.mock("@/lib/db/prisma", () => ({
  prisma: { adminPermissionGrant: { findFirst: (args: unknown) => findFirstMock(args) } },
}));

import { requirePermission, withAdminRoute } from "../guard";
import { getCurrentUser } from "@/lib/auth/session";

function signIn(role: string, id = "u1") {
  vi.mocked(getCurrentUser).mockResolvedValue({ id, email: `${id}@example.com`, role: role as never });
}
function signOut() {
  vi.mocked(getCurrentUser).mockResolvedValue(null);
}

describe("requirePermission", () => {
  it("returns the actor when the role holds the permission — no grant lookup needed", async () => {
    signIn("SUPER_ADMIN");
    findFirstMock.mockClear();
    const actor = await requirePermission("audit:read");
    expect(actor.role).toBe("SUPER_ADMIN");
    expect(findFirstMock).not.toHaveBeenCalled(); // the fast path: role alone already covers it
  });

  it("throws ForbiddenError when the role lacks the permission and no grant covers it", async () => {
    signIn("ANALYST");
    findFirstMock.mockResolvedValueOnce(null);
    await expect(requirePermission("user:role:write")).rejects.toThrow(/Missing permission/);
  });

  it("succeeds when the role lacks the permission but an active grant covers it (Milestone 12 §2.1)", async () => {
    signIn("ANALYST", "u2");
    findFirstMock.mockResolvedValueOnce({ id: "grant-1" });
    const actor = await requirePermission("crawl:retry");
    expect(actor.id).toBe("u2");
    expect(findFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: "u2", permission: "crawl:retry" }) }),
    );
  });

  it("throws UnauthorizedError (via requireUser) for an anonymous caller", async () => {
    signOut();
    await expect(requirePermission("metrics:read")).rejects.toThrow("Unauthorized");
  });
});

describe("withAdminRoute", () => {
  it("maps an anonymous caller to 401", async () => {
    signOut();
    const res = await withAdminRoute("metrics:read", async () => Response.json({ ok: true }));
    expect(res.status).toBe(401);
  });

  it("maps a signed-in but under-permissioned caller to 403", async () => {
    signIn("USER");
    findFirstMock.mockResolvedValueOnce(null);
    const res = await withAdminRoute("metrics:read", async () => Response.json({ ok: true }));
    expect(res.status).toBe(403);
  });

  it("calls the handler with the actor when permitted", async () => {
    signIn("ANALYST");
    const res = await withAdminRoute("metrics:read", async (actor) => Response.json({ role: actor.role }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ role: "ANALYST" });
  });

  it("calls the handler when a grant (not the role) covers the permission", async () => {
    signIn("USER");
    findFirstMock.mockResolvedValueOnce({ id: "grant-2" });
    const res = await withAdminRoute("export:users", async (actor) => Response.json({ role: actor.role }));
    expect(res.status).toBe(200);
  });

  it("lets a genuinely unexpected error propagate rather than masking it as 401/403", async () => {
    vi.mocked(getCurrentUser).mockRejectedValueOnce(new Error("db unreachable"));
    await expect(withAdminRoute("metrics:read", async () => Response.json({}))).rejects.toThrow("db unreachable");
  });
});
