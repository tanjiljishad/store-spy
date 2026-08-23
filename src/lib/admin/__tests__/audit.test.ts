import { describe, expect, it, vi } from "vitest";
import { recordAdminAction } from "../audit";

/**
 * Milestone 12 §4.1 addendum: "Add a test that fails if a new action type
 * writes an email-shaped value into metadata." This is that test — DB-free
 * (a stub `tx` with a mocked `adminAuditLog.create`), since the guard runs
 * BEFORE any database call. Any future call site anywhere in the app that
 * embeds an email in `metadata` fails exactly like this the moment its own
 * test suite exercises it for real, not just this file.
 */
// A real Pick<PrismaClient, "adminAuditLog"> has a dozen other Prisma
// delegate methods this test never calls — cast rather than stub them all,
// the same pragmatic choice `vi.mock()`-based Prisma stubs elsewhere in
// this codebase make (see guard.test.ts's own doc comment).
function stubTx(): Parameters<typeof recordAdminAction>[0] {
  return { adminAuditLog: { create: vi.fn() } } as unknown as Parameters<typeof recordAdminAction>[0];
}

describe("recordAdminAction — metadata PII guard", () => {
  it("throws and never calls adminAuditLog.create when metadata contains an email-shaped value", async () => {
    const tx = stubTx();
    await expect(
      recordAdminAction(tx, {
        actorId: "system:test",
        actorEmail: "system:test",
        action: "some.new.action",
        targetType: "User",
        metadata: { userEmail: "person@example.com" },
      }),
    ).rejects.toThrow(/email-shaped/);
    expect(tx.adminAuditLog.create).not.toHaveBeenCalled();
  });

  it("throws for an email buried in a nested object", async () => {
    const tx = stubTx();
    await expect(
      recordAdminAction(tx, {
        actorId: "system:test",
        actorEmail: "system:test",
        action: "user.export",
        targetType: "User",
        metadata: { filters: { emailQuery: "person@example.com" } },
      }),
    ).rejects.toThrow(/email-shaped/);
    expect(tx.adminAuditLog.create).not.toHaveBeenCalled();
  });

  it("succeeds for metadata with no email — the real, current shapes every call site in this app uses", async () => {
    const tx = stubTx();
    await recordAdminAction(tx, {
      actorId: "actor-1",
      actorEmail: "actor@example.com",
      action: "subscription.expire",
      targetType: "User",
      targetId: "user-1",
      metadata: { subscriptionId: "sub_1", watchesExpired: 2 },
    });
    expect(tx.adminAuditLog.create).toHaveBeenCalledTimes(1);
  });

  it("actorEmail itself is untouched by the guard — it's the actor, not subject PII embedded in metadata", async () => {
    const tx = stubTx();
    await recordAdminAction(tx, {
      actorId: "actor-1",
      actorEmail: "real-actor@example.com",
      action: "user.plan.update",
      targetType: "User",
      targetId: "user-1",
      metadata: { fromPlan: "FREE", toPlan: "BASIC" },
    });
    expect(tx.adminAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ actorEmail: "real-actor@example.com" }) }),
    );
  });

  it("succeeds with no metadata at all", async () => {
    const tx = stubTx();
    await recordAdminAction(tx, { actorId: "actor-1", actorEmail: "actor@example.com", action: "noop", targetType: "User" });
    expect(tx.adminAuditLog.create).toHaveBeenCalledTimes(1);
  });
});
