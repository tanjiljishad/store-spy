import { describe, expect, it, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: vi.fn() }));

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import DashboardLayout from "../../../app/dashboard/layout";
import { getCurrentUser } from "@/lib/auth/session";
import { makeStoreSpyUser, resetControlPlane } from "../../test-support/store-spy-user";

/**
 * Milestone 12 §4.1 addendum: "Test that an OAuth account cannot reach the
 * dashboard without passing it." Invokes the real DashboardLayout Server
 * Component function directly (it's just an async function under the
 * App Router) and inspects the thrown NEXT_REDIRECT signal next/navigation's
 * redirect() produces — the actual gate mechanism, not a re-implementation
 * of its logic. Live HTTP verification (see the completion report) covers
 * the full browser-redirect behavior this can't reach outside a real
 * request/render context; this covers the decision logic exhaustively.
 */
const url = process.env.DATABASE_URL;
if (!url || !/test/i.test(url)) throw new Error("Run this destructive suite with npm run test:integration against the test database.");
const prisma = new PrismaClient();
beforeEach(async () => {
  await prisma.$executeRawUnsafe(`TRUNCATE "Session","Account","User" RESTART IDENTITY CASCADE`);
  vi.mocked(getCurrentUser).mockReset();
  await resetControlPlane(prisma);
});

function redirectDestination(e: unknown): string | null {
  const digest = e && typeof e === "object" && "digest" in e ? (e as { digest?: unknown }).digest : undefined;
  if (typeof digest !== "string" || !digest.startsWith("NEXT_REDIRECT")) return null;
  return digest.split(";")[2] ?? null;
}

describe("DashboardLayout — Milestone 12 §4.1 consent gate", () => {
  it("redirects a signed-out visitor to /login, never reaching the consent check", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null);

    let caught: unknown;
    try {
      await DashboardLayout({ children: null });
    } catch (e) {
      caught = e;
    }
    expect(redirectDestination(caught)).toBe("/login");
  });

  it("redirects an OAuth-shaped account (tosAcceptedAt never set) to /welcome", async () => {
    const user = await makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com` }); // no passwordHash, no tosAcceptedAt — exactly what the Auth.js adapter creates
    vi.mocked(getCurrentUser).mockResolvedValue({ id: user.id, email: user.email, plan: "FREE", role: "USER" });

    let caught: unknown;
    try {
      await DashboardLayout({ children: null });
    } catch (e) {
      caught = e;
    }
    expect(redirectDestination(caught)).toBe("/welcome");
  });

  it("does NOT redirect a credentials-signup-shaped account (tosAcceptedAt and emailVerified already set)", async () => {
    const user = await makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com`, tosAcceptedAt: new Date(), emailVerified: new Date() });
    vi.mocked(getCurrentUser).mockResolvedValue({ id: user.id, email: user.email, plan: "FREE", role: "USER" });

    const result = await DashboardLayout({ children: "dashboard content" });
    expect(result).toBeTruthy(); // rendered — no redirect thrown
  });

  it("does NOT redirect an OAuth account that has already completed the interstitial once", async () => {
    const user = await makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com`, tosAcceptedAt: new Date(), emailVerified: new Date() });
    vi.mocked(getCurrentUser).mockResolvedValue({ id: user.id, email: user.email, plan: "FREE", role: "USER" });

    const result = await DashboardLayout({ children: "dashboard content" });
    expect(result).toBeTruthy();
  });

  it("redirects a ToS-accepted-but-unverified credentials account to /verify-email", async () => {
    const user = await makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com`, tosAcceptedAt: new Date() }); // no emailVerified
    vi.mocked(getCurrentUser).mockResolvedValue({ id: user.id, email: user.email, plan: "FREE", role: "USER" });

    let caught: unknown;
    try {
      await DashboardLayout({ children: null });
    } catch (e) {
      caught = e;
    }
    expect(redirectDestination(caught)).toBe("/verify-email");
  });
});
