import type { PrismaClient } from "@prisma/client";
import { hasAnalyzedStore } from "../entitlements/analysis-usage";

/**
 * The single access gate for a store's data. Before this milestone, only
 * GET /api/store/[domain]/report actually checked hasAnalyzedStore() —
 * /events, /activity, /growth, and /marketing called getCurrentUser() not
 * at all, so anyone who knew a domain could pull the change feed, growth
 * signals, and the SerpAPI-derived marketing intelligence anonymously. That
 * made report's own gate decorative: the SAME data was one path away, free.
 *
 * "full" / "unanalyzed_preview" / "anonymous_preview" is deliberately the
 * same three-way shape report/route.ts already used — this factors that
 * decision out to one place so all five routes (report + the four below)
 * agree on it, rather than report keeping its own copy while the other four
 * grow a second, possibly-drifting one.
 */
export type StoreAccess = "full" | "unanalyzed_preview" | "anonymous_preview";

export async function resolveStoreAccess(
  prisma: PrismaClient,
  storeId: string,
  user: { id: string } | null,
): Promise<StoreAccess> {
  if (!user) return "anonymous_preview";
  const analyzed = await hasAnalyzedStore(prisma, user.id, storeId);
  return analyzed ? "full" : "unanalyzed_preview";
}
