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

import { requirePermission, withAdminRoute } from "../guard";
import { getCurrentUser } from "@/lib/auth/session";

function signIn(role: string) {
  vi.mocked(getCurrentUser).mockResolvedValue({ id: "u1", email: "u1@example.com", plan: "FREE", role: role as never });
}
function signOut() {
  vi.mocked(getCurrentUser).mockResolvedValue(null);
}

describe("requirePermission", () => {
  it("returns the actor when the role holds the permission", async () => {
    signIn("SUPER_ADMIN");
    const actor = await requirePermission("audit:read");
    expect(actor.role).toBe("SUPER_ADMIN");
  });

  it("throws ForbiddenError when the role lacks the permission", async () => {
    signIn("ANALYST");
    await expect(requirePermission("user:role:write")).rejects.toThrow(/Missing permission/);
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
    const res = await withAdminRoute("metrics:read", async () => Response.json({ ok: true }));
    expect(res.status).toBe(403);
  });

  it("calls the handler with the actor when permitted", async () => {
    signIn("ANALYST");
    const res = await withAdminRoute("metrics:read", async (actor) => Response.json({ role: actor.role }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ role: "ANALYST" });
  });

  it("lets a genuinely unexpected error propagate rather than masking it as 401/403", async () => {
    vi.mocked(getCurrentUser).mockRejectedValueOnce(new Error("db unreachable"));
    await expect(withAdminRoute("metrics:read", async () => Response.json({}))).rejects.toThrow("db unreachable");
  });
});
