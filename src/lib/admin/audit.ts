import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * Every mutating admin action writes exactly one AdminAuditLog row, in the
 * SAME transaction as the change it's recording — `tx` is always the
 * transaction client the caller is already inside, never a fresh
 * `prisma.$transaction()` of its own. If the audit write fails for any
 * reason, the transaction (and therefore the change itself) rolls back
 * with it: an admin action that can't be logged never silently happens.
 *
 * `metadata` must never contain secrets, password hashes, or a promo
 * code's full value — callers pass only what's safe to keep forever (a
 * promo's id and last 4 characters, not the code itself; never a
 * passwordHash).
 */
export interface RecordAdminActionArgs {
  actorId: string;
  actorEmail: string;
  action: string;
  targetType: string;
  targetId?: string | null;
  metadata?: Prisma.InputJsonValue | null;
}

export async function recordAdminAction(
  tx: Pick<PrismaClient, "adminAuditLog">,
  args: RecordAdminActionArgs,
): Promise<void> {
  await tx.adminAuditLog.create({
    data: {
      actorId: args.actorId,
      actorEmail: args.actorEmail,
      action: args.action,
      targetType: args.targetType,
      targetId: args.targetId ?? null,
      metadata: args.metadata ?? undefined,
    },
  });
}

export interface AuditLogItem {
  id: string;
  actorId: string;
  actorEmail: string;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata: Prisma.JsonValue | null;
  createdAt: string;
}

export interface AuditLogPage {
  items: AuditLogItem[];
  nextCursor: string | null;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/** Same cursor convention as monitoring/change-feed.ts's getChangeFeed(). */
export async function getAuditLog(
  prisma: PrismaClient,
  opts: { cursor?: string | null; limit?: number } = {},
): Promise<AuditLogPage> {
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE));

  const rows = await prisma.adminAuditLog.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return {
    items: page.map((r) => ({
      id: r.id,
      actorId: r.actorId,
      actorEmail: r.actorEmail,
      action: r.action,
      targetType: r.targetType,
      targetId: r.targetId,
      metadata: r.metadata,
      createdAt: r.createdAt.toISOString(),
    })),
    nextCursor: hasMore ? page[page.length - 1].id : null,
  };
}
