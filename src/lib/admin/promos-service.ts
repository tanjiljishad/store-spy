import { Prisma, type PrismaClient } from "@prisma/client";
import type { PlanTier } from "../entitlements/plan-limits";
import { generatePromoCode, isValidVanityCode, normalizePromoCode } from "../billing/promo-code";
import { recordAdminAction } from "./audit";
import type { AdminActor } from "./guard";

/**
 * SUPER_ADMIN-only promo lifecycle: create, list, assign, revoke. Every
 * mutating function here pairs its write with exactly one audit row in the
 * same transaction (same convention as users-service.ts). `metadata` never
 * contains the full code — only the promo id (already the audit row's
 * `targetId`) and the code's last 4 characters, per audit.ts's own rule.
 */

export interface CreatePromoArgs {
  vanityCode?: string | null;
  discountType: "PERCENT" | "FIXED";
  discountValue: number;
  appliesToPlan?: PlanTier | null;
  maxRedemptions?: number | null;
  perUserLimit?: number;
  validFrom: Date;
  validUntil?: Date | null;
  assignedToUserId?: string | null;
  /** Null = perpetual — see PromoCode.durationDays's own schema doc comment. */
  durationDays?: number | null;
}

export type CreatePromoOutcome =
  | { outcome: "created"; id: string; code: string }
  | { outcome: "invalid_discount_value" }
  | { outcome: "invalid_date_range" }
  | { outcome: "invalid_vanity_code" }
  | { outcome: "code_collision" };

export async function createPromo(prisma: PrismaClient, actor: AdminActor, args: CreatePromoArgs): Promise<CreatePromoOutcome> {
  const validValue =
    args.discountType === "PERCENT"
      ? Number.isInteger(args.discountValue) && args.discountValue >= 1 && args.discountValue <= 100
      : Number.isInteger(args.discountValue) && args.discountValue >= 1;
  if (!validValue) return { outcome: "invalid_discount_value" };

  if (args.validUntil && args.validUntil <= args.validFrom) {
    return { outcome: "invalid_date_range" };
  }

  let code: string;
  if (args.vanityCode) {
    const normalized = normalizePromoCode(args.vanityCode);
    if (!isValidVanityCode(normalized)) return { outcome: "invalid_vanity_code" };
    code = normalized;
  } else {
    code = generatePromoCode();
  }

  try {
    const created = await prisma.$transaction(async (tx) => {
      const promo = await tx.promoCode.create({
        data: {
          code,
          discountType: args.discountType,
          discountValue: args.discountValue,
          appliesToPlan: args.appliesToPlan ?? null,
          maxRedemptions: args.maxRedemptions ?? null,
          perUserLimit: args.perUserLimit ?? 1,
          validFrom: args.validFrom,
          validUntil: args.validUntil ?? null,
          assignedToUserId: args.assignedToUserId ?? null,
          durationDays: args.durationDays ?? null,
          createdByUserId: actor.id,
        },
      });

      await recordAdminAction(tx, {
        actorId: actor.id,
        actorEmail: actor.email,
        action: "promo.create",
        targetType: "PromoCode",
        targetId: promo.id,
        metadata: {
          codeLast4: promo.code.slice(-4),
          discountType: promo.discountType,
          discountValue: promo.discountValue,
          durationDays: promo.durationDays,
          assignedToUserId: promo.assignedToUserId,
        },
      });

      return promo;
    });

    return { outcome: "created", id: created.id, code: created.code };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { outcome: "code_collision" };
    }
    throw e;
  }
}

export interface PromoListItem {
  id: string;
  code: string;
  discountType: string;
  discountValue: number;
  appliesToPlan: PlanTier | null;
  maxRedemptions: number | null;
  perUserLimit: number;
  validFrom: string;
  validUntil: string | null;
  status: string;
  assignedToUserId: string | null;
  durationDays: number | null;
  createdAt: string;
  redemptionCount: number;
}
export interface PromoListPage {
  items: PromoListItem[];
  nextCursor: string | null;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/** An admin who can read promos can already use them — showing the full code here is not a leak, it's theatre to hide it (see this milestone's doc, §3.5). */
export async function listPromos(prisma: PrismaClient, opts: { cursor?: string | null; limit?: number } = {}): Promise<PromoListPage> {
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE));

  const rows = await prisma.promoCode.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    include: { _count: { select: { redemptions: true } } },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return {
    items: page.map((p) => ({
      id: p.id,
      code: p.code,
      discountType: p.discountType,
      discountValue: p.discountValue,
      appliesToPlan: p.appliesToPlan,
      maxRedemptions: p.maxRedemptions,
      perUserLimit: p.perUserLimit,
      validFrom: p.validFrom.toISOString(),
      validUntil: p.validUntil?.toISOString() ?? null,
      status: p.status,
      assignedToUserId: p.assignedToUserId,
      durationDays: p.durationDays,
      createdAt: p.createdAt.toISOString(),
      redemptionCount: p._count.redemptions,
    })),
    nextCursor: hasMore ? page[page.length - 1].id : null,
  };
}

export type AssignPromoOutcome = { outcome: "assigned" } | { outcome: "not_found" };

/** "Give a promo to someone" — sets assignedToUserId. */
export async function assignPromo(
  prisma: PrismaClient,
  actor: AdminActor,
  promoId: string,
  targetUserId: string,
): Promise<AssignPromoOutcome> {
  return prisma.$transaction(async (tx) => {
    const promo = await tx.promoCode.findUnique({ where: { id: promoId }, select: { code: true } });
    if (!promo) return { outcome: "not_found" };

    await tx.promoCode.update({ where: { id: promoId }, data: { assignedToUserId: targetUserId } });
    await recordAdminAction(tx, {
      actorId: actor.id,
      actorEmail: actor.email,
      action: "promo.assign",
      targetType: "PromoCode",
      targetId: promoId,
      metadata: { codeLast4: promo.code.slice(-4), assignedToUserId: targetUserId },
    });

    return { outcome: "assigned" };
  });
}

export type RevokePromoOutcome = { outcome: "revoked" } | { outcome: "not_found" };

/** Never deletes — existing redemptions must stay reconcilable. Does not claw back a plan already granted (see this milestone's doc, §3.5). */
export async function revokePromo(prisma: PrismaClient, actor: AdminActor, promoId: string): Promise<RevokePromoOutcome> {
  return prisma.$transaction(async (tx) => {
    const promo = await tx.promoCode.findUnique({ where: { id: promoId }, select: { code: true } });
    if (!promo) return { outcome: "not_found" };

    await tx.promoCode.update({ where: { id: promoId }, data: { status: "DISABLED" } });
    await recordAdminAction(tx, {
      actorId: actor.id,
      actorEmail: actor.email,
      action: "promo.revoke",
      targetType: "PromoCode",
      targetId: promoId,
      metadata: { codeLast4: promo.code.slice(-4) },
    });

    return { outcome: "revoked" };
  });
}
