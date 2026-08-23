import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { deleteOwnAccount } from "../delete";

const url = process.env.DATABASE_URL;
if (!url || !/test/i.test(url)) throw new Error("Run this destructive suite with npm run test:integration against the test database.");
const prisma = new PrismaClient();
afterAll(async () => prisma.$disconnect());
beforeEach(async () =>
  prisma.$executeRawUnsafe(
    `TRUNCATE "AdminAuditLog","AdminPermissionGrant","PromoRedemption","PromoCode","Checkout","Subscription","AnalysisUsage","Watchlist","Session","Account","Store","User" RESTART IDENTITY CASCADE`,
  ),
);

async function makeUser(role: "USER" | "SUPER_ADMIN" = "USER") {
  return prisma.user.create({ data: { email: `${randomUUID()}@example.com`, role } });
}
async function makeStore() {
  return prisma.store.create({ data: { domain: `${randomUUID().slice(0, 8)}.com`, platform: "SHOPIFY" } });
}

describe("deleteOwnAccount", () => {
  it("returns user_not_found for a nonexistent user", async () => {
    expect(await deleteOwnAccount(prisma, "does-not-exist")).toEqual({ outcome: "user_not_found" });
  });

  it("deletes the User row and every DB-cascaded relation: Watchlist, AnalysisUsage, Account, Session, AdminPermissionGrant", async () => {
    const user = await makeUser();
    const store = await makeStore();
    await prisma.watchlist.create({ data: { userId: user.id, storeId: store.id } });
    await prisma.analysisUsage.create({ data: { userId: user.id, storeId: store.id } });
    await prisma.session.create({ data: { userId: user.id, sessionToken: randomUUID(), expires: new Date(Date.now() + 86_400_000) } });
    await prisma.account.create({ data: { userId: user.id, type: "oauth", provider: "google", providerAccountId: randomUUID() } });
    const granter = await makeUser("SUPER_ADMIN");
    await prisma.adminPermissionGrant.create({ data: { userId: user.id, permission: "audit:read", grantedByUserId: granter.id } });

    const result = await deleteOwnAccount(prisma, user.id);
    expect(result.outcome).toBe("deleted");

    expect(await prisma.user.findUnique({ where: { id: user.id } })).toBeNull();
    expect(await prisma.watchlist.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.analysisUsage.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.account.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.adminPermissionGrant.count({ where: { userId: user.id } })).toBe(0);
  });

  it("explicitly deletes Subscription and Checkout — the two tables with NO foreign key to User, which a bare user.delete() would silently leave dangling", async () => {
    const user = await makeUser();
    await prisma.subscription.create({ data: { userId: user.id, plan: "BASIC", source: "PROVIDER", status: "ACTIVE" } });
    await prisma.checkout.create({ data: { userId: user.id, plan: "BASIC", period: "MONTHLY", listPriceCents: 1900, discountCents: 0, finalCents: 1900, status: "COMPLETED" } });

    await deleteOwnAccount(prisma, user.id);

    expect(await prisma.subscription.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.checkout.count({ where: { userId: user.id } })).toBe(0);
  });

  it("does NOT touch another user's data", async () => {
    const target = await makeUser();
    const bystander = await makeUser();
    const store = await makeStore();
    await prisma.watchlist.create({ data: { userId: bystander.id, storeId: store.id } });
    await prisma.subscription.create({ data: { userId: bystander.id, plan: "BASIC", source: "PROVIDER", status: "ACTIVE" } });

    await deleteOwnAccount(prisma, target.id);

    expect(await prisma.user.findUnique({ where: { id: bystander.id } })).not.toBeNull();
    expect(await prisma.watchlist.count({ where: { userId: bystander.id } })).toBe(1);
    expect(await prisma.subscription.count({ where: { userId: bystander.id } })).toBe(1);
  });

  describe("audit log tombstoning", () => {
    it("an AdminAuditLog row where the deleted user was the ACTOR survives, with actorId/actorEmail replaced by a tombstone", async () => {
      const user = await makeUser();
      const originalId = user.id;
      const log = await prisma.adminAuditLog.create({
        data: { actorId: user.id, actorEmail: user.email, action: "checkout.completed_free", targetType: "User", targetId: user.id, metadata: { plan: "BASIC" } },
      });

      const result = await deleteOwnAccount(prisma, user.id);
      expect(result.outcome).toBe("deleted");
      if (result.outcome !== "deleted") throw new Error("unreachable");
      // Self-referential row (actorId === targetId === the deleted user) counted ONCE, not twice.
      expect(result.auditRowsTombstoned).toBe(1);

      const survived = await prisma.adminAuditLog.findUnique({ where: { id: log.id } });
      expect(survived).not.toBeNull();
      expect(survived!.actorId).toBe(`deleted:${originalId}`);
      expect(survived!.actorEmail).toBe("[deleted user]");
      expect(survived!.targetId).toBe(`deleted:${originalId}`);
      // The fact/shape of the action itself is preserved — this is what "the log stays an audit log" means.
      expect(survived!.action).toBe("checkout.completed_free");
      expect(survived!.metadata).toEqual({ plan: "BASIC" });
    });

    it("an AdminAuditLog row where the deleted user was only the TARGET (acted on by someone else) has targetId tombstoned but the real acting admin's identity untouched", async () => {
      const admin = await makeUser("SUPER_ADMIN");
      const targetUser = await makeUser();
      const log = await prisma.adminAuditLog.create({
        data: { actorId: admin.id, actorEmail: admin.email, action: "user.plan.update", targetType: "User", targetId: targetUser.id, metadata: { toPlan: "BASIC" } },
      });

      await deleteOwnAccount(prisma, targetUser.id);

      const survived = await prisma.adminAuditLog.findUnique({ where: { id: log.id } });
      expect(survived!.targetId).toBe(`deleted:${targetUser.id}`);
      expect(survived!.actorId).toBe(admin.id); // the real admin's identity is untouched — they were not the one erased
      expect(survived!.actorEmail).toBe(admin.email);
    });

    it("a targetId match on a DIFFERENT targetType is never tombstoned — only targetType='User' rows", async () => {
      const user = await makeUser();
      // A row whose targetId happens to equal this user's id but refers to
      // something else entirely (targetType != "User") must be left alone.
      const log = await prisma.adminAuditLog.create({
        data: { actorId: "system:test", actorEmail: "system:test", action: "promo.create", targetType: "PromoCode", targetId: user.id },
      });

      await deleteOwnAccount(prisma, user.id);

      const survived = await prisma.adminAuditLog.findUnique({ where: { id: log.id } });
      expect(survived!.targetId).toBe(user.id); // untouched
    });

    it("PromoRedemption rows survive completely untouched — out of this milestone's explicit deletion scope", async () => {
      const user = await makeUser();
      const promo = await prisma.promoCode.create({
        data: { code: randomUUID(), discountType: "PERCENT", discountValue: 100, validFrom: new Date("2026-01-01T00:00:00Z"), createdByUserId: user.id },
      });
      const redemption = await prisma.promoRedemption.create({
        data: { promoCodeId: promo.id, userId: user.id, listPriceCents: 1900, discountCents: 1900, finalCents: 0 },
      });

      await deleteOwnAccount(prisma, user.id);

      expect(await prisma.promoRedemption.findUnique({ where: { id: redemption.id } })).not.toBeNull();
    });
  });

  describe("last SUPER_ADMIN guard", () => {
    it("refuses to delete the only remaining SUPER_ADMIN", async () => {
      const onlyAdmin = await makeUser("SUPER_ADMIN");
      const result = await deleteOwnAccount(prisma, onlyAdmin.id);
      expect(result).toEqual({ outcome: "last_super_admin" });
      expect(await prisma.user.findUnique({ where: { id: onlyAdmin.id } })).not.toBeNull();
    });

    it("allows deleting a SUPER_ADMIN when another one still exists", async () => {
      const admin1 = await makeUser("SUPER_ADMIN");
      await makeUser("SUPER_ADMIN");
      const result = await deleteOwnAccount(prisma, admin1.id);
      expect(result.outcome).toBe("deleted");
    });

    it("two concurrent deletions of the last two SUPER_ADMINs never both succeed — exactly one is refused", async () => {
      const admin1 = await makeUser("SUPER_ADMIN");
      const admin2 = await makeUser("SUPER_ADMIN");

      const [r1, r2] = await Promise.all([deleteOwnAccount(prisma, admin1.id), deleteOwnAccount(prisma, admin2.id)]);

      const outcomes = [r1.outcome, r2.outcome].sort();
      expect(outcomes).toEqual(["deleted", "last_super_admin"]);
      expect(await prisma.user.count({ where: { role: "SUPER_ADMIN" } })).toBe(1);
    });
  });
});
