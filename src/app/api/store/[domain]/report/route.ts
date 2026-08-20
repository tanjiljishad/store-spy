import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { canonicalizeDomain } from "@/lib/crawl/shopify";
import { checkRateLimit, getClientIp } from "@/lib/security/rate-limit";
import { getCurrentUser } from "@/lib/auth/session";
import { resolveStoreAccess } from "@/lib/auth/store-access";
import { buildStoreIntelligenceReport } from "@/lib/intelligence/report";
import type { AnalysisReport } from "@/lib/analysis/types";

/**
 * Re-fetches the CURRENT report for an already-known store without
 * triggering a new crawl — what the Store Intelligence page loads. This is
 * the canonical Store Intelligence endpoint (Milestone 7 Sub-phase B):
 * `full` access now returns buildStoreIntelligenceReport()'s composed,
 * sectioned contract (identity/technology/catalog/productIntelligence/
 * growth/marketing/reviews/commercial/monitoring/entitlement/meta) rather
 * than the older, flatter FullStoreReport shape — see
 * src/lib/intelligence/types.ts for the section boundaries and
 * docs/milestone-7-subphase-b-completion-report.md for why. The composer
 * itself calls buildFullStoreReport() internally (unchanged, still the one
 * place Product/theme/apps/pixels/payment-providers are queried) alongside
 * buildGrowthReport()/buildMarketingReport(), so there remains exactly one
 * implementation per underlying signal, never two that can drift apart.
 *
 * Deliberately NOT wired into POST /api/analyze's live crawl flow — see
 * intelligence/report.ts's own doc comment for why that boundary is
 * protected rather than unified in this sub-phase.
 *
 * Full access still requires the store be one of THIS user's 3 analyzed
 * stores — visiting the URL directly for a store you haven't spent a
 * credit on returns the same truncated preview shape as an anonymous
 * caller, just with a different reason (`access: "unanalyzed_preview"`).
 */
export const runtime = "nodejs";

const RATE_LIMIT = { limit: 30, windowMs: 60_000 };

export async function GET(req: NextRequest, { params }: { params: Promise<{ domain: string }> }) {
  const rate = checkRateLimit(`report:${getClientIp(req.headers)}`, RATE_LIMIT);
  if (!rate.allowed) {
    return Response.json({ error: "Too many requests. Try again shortly." }, { status: 429 });
  }

  const { domain: rawDomain } = await params;
  const domain = canonicalizeDomain(decodeURIComponent(rawDomain));

  const store = await prisma.store.findUnique({ where: { domain } });
  if (!store) {
    return Response.json({ error: "Store not found" }, { status: 404 });
  }

  const user = await getCurrentUser();
  const access = await resolveStoreAccess(prisma, store.id, user);

  if (access === "anonymous_preview") {
    const report: AnalysisReport = {
      access: "anonymous_preview",
      domain,
      platform: "shopify",
      productCount: await prisma.product.count({ where: { storeId: store.id, status: "ACTIVE" } }),
      theme: { name: store.themeName, version: store.themeVersion },
      checkedAt: new Date().toISOString(),
      cta: "Create a free account to unlock the complete store intelligence — full app stack, pricing, activity, and monitoring.",
    };
    return Response.json(report);
  }

  if (access === "unanalyzed_preview") {
    const report: AnalysisReport = {
      access: "unanalyzed_preview",
      domain,
      platform: "shopify",
      productCount: await prisma.product.count({ where: { storeId: store.id, status: "ACTIVE" } }),
      theme: { name: store.themeName, version: store.themeVersion },
      checkedAt: new Date().toISOString(),
      cta: "Analyze this store to add it to your 3 free store analyses and unlock the complete report.",
    };
    return Response.json(report);
  }

  // access === "full" — resolveStoreAccess only ever returns this for a signed-in user.
  if (!user) {
    return Response.json({ error: "Unexpected access state" }, { status: 500 });
  }
  const report = await buildStoreIntelligenceReport(prisma, store.id, domain, user.id, /* alreadyAnalyzed */ true);
  return Response.json({ access: "full" as const, ...report });
}
