import { describe, expect, it, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: vi.fn(), requireUser: vi.fn(), UnauthorizedError: class UnauthorizedError extends Error {} }));

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import AdminLayout from "../../../app/admin/layout";
import { requireUser, UnauthorizedError } from "@/lib/auth/session";
import { makeStoreSpyUser, resetControlPlane } from "../../test-support/store-spy-user";

/**
 * Milestone 12 §4.2 preflight finding: AdminLayout is a sibling of
 * DashboardLayout, not nested under it, so it needed its OWN consent-gate
 * check — see AdminLayout's own updated doc comment. Same direct-Server-
 * Component-invocation pattern as dashboard-consent-gate.integration.test.ts.
 */
const url = process.env.DATABASE_URL;
if (!url || !/test/i.test(url)) throw new Error("Run this destructive suite with npm run test:integration against the test database.");
const prisma = new PrismaClient();
beforeEach(async () => {
  await prisma.$executeRawUnsafe(`TRUNCATE "Session","Account" RESTART IDENTITY CASCADE`);
  vi.mocked(requireUser).mockReset();
  await resetControlPlane(prisma);
});

function redirectDestination(e: unknown): string | null {
  const digest = e && typeof e === "object" && "digest" in e ? (e as { digest?: unknown }).digest : undefined;
  if (typeof digest !== "string" || !digest.startsWith("NEXT_REDIRECT")) return null;
  return digest.split(";")[2] ?? null;
}

describe("AdminLayout — Milestone 12 §4.2 preflight: consent gate now covers /admin too", () => {
  it("redirects a signed-out visitor to /login, never reaching role or consent checks", async () => {
    vi.mocked(requireUser).mockRejectedValue(new UnauthorizedError());

    let caught: unknown;
    try {
      await AdminLayout({ children: null });
    } catch (e) {
      caught = e;
    }
    expect(redirectDestination(caught)).toBe("/login");
  });

  it("404s a plain USER role, before the consent check even runs", async () => {
    const user = await makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com`, role: "USER" });
    vi.mocked(requireUser).mockResolvedValue({ id: user.id, email: user.email, role: "USER" });

    await expect(AdminLayout({ children: null })).rejects.toThrow(); // notFound() also throws a Next-internal signal
  });

  it("THE GAP THIS CLOSES: redirects a privileged, OAuth-shaped account (tosAcceptedAt never set) to /welcome instead of rendering the admin panel", async () => {
    const admin = await makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com`, role: "SUPER_ADMIN" }); // no tosAcceptedAt — exactly a promoted-before-completing-/welcome OAuth account
    vi.mocked(requireUser).mockResolvedValue({ id: admin.id, email: admin.email, role: "SUPER_ADMIN" });

    let caught: unknown;
    try {
      await AdminLayout({ children: null });
    } catch (e) {
      caught = e;
    }
    expect(redirectDestination(caught)).toBe("/welcome");
  });

  it("does NOT redirect a privileged account that has completed ToS acceptance and email verification", async () => {
    const admin = await makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com`, role: "SUPER_ADMIN", tosAcceptedAt: new Date(), emailVerified: new Date() });
    vi.mocked(requireUser).mockResolvedValue({ id: admin.id, email: admin.email, role: "SUPER_ADMIN" });

    const result = await AdminLayout({ children: "admin content" });
    expect(result).toBeTruthy();
  });

  it("THE SAME GAP, for email verification: redirects a privileged account promoted before ever verifying its email to /verify-email instead of rendering the admin panel", async () => {
    const admin = await makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com`, role: "SUPER_ADMIN", tosAcceptedAt: new Date() }); // no emailVerified
    vi.mocked(requireUser).mockResolvedValue({ id: admin.id, email: admin.email, role: "SUPER_ADMIN" });

    let caught: unknown;
    try {
      await AdminLayout({ children: null });
    } catch (e) {
      caught = e;
    }
    expect(redirectDestination(caught)).toBe("/verify-email");
  });

  it("security review fix 1: does NOT 404 a plain USER role that holds an active AdminPermissionGrant — the exact gap the old role !== \"USER\" check had", async () => {
    const user = await makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com`, role: "USER", tosAcceptedAt: new Date(), emailVerified: new Date() });
    await prisma.adminPermissionGrant.create({ data: { userId: user.id, permission: "metrics:read", grantedByUserId: "test-admin" } });
    vi.mocked(requireUser).mockResolvedValue({ id: user.id, email: user.email, role: "USER" });

    const result = await AdminLayout({ children: "admin content" });
    expect(result).toBeTruthy();
  });

  it("still 404s a plain USER role whose only grant has expired", async () => {
    const user = await makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com`, role: "USER", tosAcceptedAt: new Date(), emailVerified: new Date() });
    await prisma.adminPermissionGrant.create({
      data: { userId: user.id, permission: "metrics:read", grantedByUserId: "test-admin", expiresAt: new Date(Date.now() - 1000) },
    });
    vi.mocked(requireUser).mockResolvedValue({ id: user.id, email: user.email, role: "USER" });

    await expect(AdminLayout({ children: null })).rejects.toThrow();
  });

  // revokedAt and expiresAt are two different columns (see AdminPermissionGrant
  // in schema.prisma) checked by the SAME query in hasAnyActiveGrant() — but
  // that's an implementation detail this test deliberately doesn't trust
  // blindly. Proven here, at the layout itself, not just at
  // hasAnyActiveGrant's own unit level (permissions-service.integration.test.ts),
  // because the layout is where a future refactor that handled the two
  // columns differently would actually be user-visible.
  it("still 404s a plain USER role whose only grant was manually revoked (not expired)", async () => {
    const user = await makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com`, role: "USER", tosAcceptedAt: new Date() });
    await prisma.adminPermissionGrant.create({
      data: { userId: user.id, permission: "metrics:read", grantedByUserId: "test-admin", revokedAt: new Date() },
    });
    vi.mocked(requireUser).mockResolvedValue({ id: user.id, email: user.email, role: "USER" });

    await expect(AdminLayout({ children: null })).rejects.toThrow();
  });
});
