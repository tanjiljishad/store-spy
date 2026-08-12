import type { PrismaClient } from "@prisma/client";

/**
 * Reads from the existing append-only Event table — no new write path, no
 * new storage. Cursor-based (on Event.id, unique and stable) rather than
 * offset-based, so the browser never has to load the full history to page
 * through it, and results stay stable even as new events are appended ahead
 * of the page being read.
 */

export interface ChangeFeedItem {
  id: string;
  eventType: string;
  entityType: string;
  entityKey: string;
  headline: string;
  significance: number;
  occurredAt: string;
}

export interface ChangeFeedPage {
  items: ChangeFeedItem[];
  nextCursor: string | null;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export interface GetChangeFeedOptions {
  cursor?: string | null;
  limit?: number;
  eventTypes?: string[];
}

export async function getChangeFeed(
  prisma: PrismaClient,
  storeId: string,
  opts: GetChangeFeedOptions = {},
): Promise<ChangeFeedPage> {
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE));

  const events = await prisma.event.findMany({
    where: {
      storeId,
      // Backfilled events are reconstructed launch history (real, but dated
      // to when the product actually launched — sometimes years back), not
      // something monitoring just detected. They power a history/chart view,
      // not this "what changed recently" feed. See Event.backfilled's own doc.
      backfilled: false,
      ...(opts.eventTypes && opts.eventTypes.length > 0
        ? { eventType: { in: opts.eventTypes as never[] } }
        : {}),
    },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });

  const hasMore = events.length > limit;
  const page = hasMore ? events.slice(0, limit) : events;

  return {
    items: page.map((e) => ({
      id: e.id,
      eventType: e.eventType,
      entityType: e.entityType,
      entityKey: e.entityKey,
      headline: e.headline,
      significance: e.significance,
      occurredAt: e.occurredAt.toISOString(),
    })),
    nextCursor: hasMore ? page[page.length - 1].id : null,
  };
}
