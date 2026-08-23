import type { Prisma, PrismaClient } from "@prisma/client";
import { containsEmailShapedValue } from "./audit-pii";

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
 *
 * Milestone 12 §4.1 addendum: extends the rule above to cover PII, not
 * just secrets — `metadata` must never embed a subject's email or other
 * direct identifier. Store the user id only (already `targetId` on almost
 * every call site here); the admin UI joins to `User` at display time if
 * it needs to show an email. `actorEmail` on this model is a DIFFERENT
 * thing and stays exactly as it is — that's the ACTOR (who did this),
 * deliberately denormalized so the log survives the actor's own account
 * being deleted (see AdminAuditLog's own schema.prisma doc comment, and
 * account/delete.ts's tombstoning of it specifically for that case). This
 * rule is about the metadata payload's own content, i.e. the SUBJECT'S
 * PII, never about `actorEmail` itself.
 *
 * Enforced at write time, not just by convention: `containsEmailShapedValue()`
 * walks the whole `metadata` value and this throws — rolling back the
 * enclosing transaction along with it, the same "can't be logged, never
 * silently happens" discipline above — if it finds one. See audit.test.ts.
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
  if (args.metadata !== undefined && args.metadata !== null && containsEmailShapedValue(args.metadata)) {
    throw new Error(
      `recordAdminAction: metadata for action "${args.action}" contains an email-shaped value — store the user id only, never the subject's email (see this file's own doc comment).`,
    );
  }

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
