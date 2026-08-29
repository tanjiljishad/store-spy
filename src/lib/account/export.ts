import type { PrismaClient } from "@prisma/client";
import { getPurchasedPlanSlug } from "../control-plane/entitlements";

/**
 * Milestone 12 §4.1: GDPR Art. 15 ("right of access") — the user's OWN data,
 * self-requested. Deliberately a SEPARATE module from
 * admin/analytics/user-export.ts's bulk admin export: different audience
 * (the data subject themselves, not an admin), different scope (everything
 * genuinely about this one person, not a minimized row for a support
 * lookup), and a different exclusion rule — `passwordHash` is excluded here
 * too, but for a different reason (returning even a bcrypt hash to its own
 * owner serves no transparency purpose and is needless exposure if the
 * response is ever intercepted, not "keep it secret from the admin").
 *
 * `PERSONAL_DATA_FIELDS` is the User-scalar allowlist this module actually
 * selects — export.test.ts asserts every field on the Prisma User model is
 * either in this list or in that test's own reviewed-omit set, mirroring
 * user-export.test.ts's DMMF-exhaustiveness pattern, so a new column can't
 * silently go undisclosed (missing from Art. 15) OR silently leaked
 * (`passwordHash` included) without a human explicitly categorizing it.
 */
export const PERSONAL_DATA_FIELDS = [
  "id",
  "email",
  "emailVerified",
  "name",
  "image",
  "plan",
  "role",
  "freeTrialEndsAt",
  "marketingConsent",
  "marketingConsentAt",
  "marketingConsentSource",
  "tosAcceptedAt",
  "createdAt",
  "updatedAt",
] as const;

export interface AccountExportData {
  profile: Record<(typeof PERSONAL_DATA_FIELDS)[number], unknown>;
  watchlists: Array<{ storeId: string; addedAt: string; monitoringStatus: string; monitoringStartedAt: string | null; monitoringExpiresAt: string | null }>;
  analysisUsage: Array<{ storeId: string; createdAt: string }>;
  subscriptions: Array<{ plan: string; source: string; status: string; startedAt: string; expiresAt: string | null }>;
  checkouts: Array<{ plan: string; period: string; listPriceCents: number; discountCents: number; finalCents: number; status: string; createdAt: string }>;
  promoRedemptions: Array<{ listPriceCents: number; discountCents: number; finalCents: number; createdAt: string }>;
  exportedAt: string;
}

export async function exportOwnAccountData(prisma: PrismaClient, userId: string): Promise<AccountExportData | null> {
  // B2 2·B commit 3a: identity from control_plane.users; role from the
  // store_spy.UserAdminRole join; marketing consent from the
  // store_spy.MarketingConsent join; plan (coarse label) from the purchased
  // tier; freeTrialEndsAt from the TRIALING subscription's period_end (null
  // for an account that has no trial subscription, e.g. a paid one).
  const user = await prisma.cpUser.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      emailVerifiedAt: true,
      name: true,
      image: true,
      tosAcceptedAt: true,
      createdAt: true,
      updatedAt: true,
      adminRole: { select: { role: true } },
      marketingConsent: { select: { consent: true, consentAt: true, consentSource: true } },
      account: { select: { subscriptions: { select: { status: true, periodEnd: true } } } },
    },
  });
  if (!user) return null;

  const plan = await getPurchasedPlanSlug(prisma, userId);
  const role = user.adminRole?.role ?? "USER";
  const freeTrialEndsAt = user.account.subscriptions.find((s) => s.status === "TRIALING")?.periodEnd ?? null;
  const marketingConsent = user.marketingConsent?.consent ?? false;
  const marketingConsentAt = user.marketingConsent?.consentAt ?? null;
  const marketingConsentSource = user.marketingConsent?.consentSource ?? null;

  const [watchlists, analysisUsage, subscriptions, checkouts, promoRedemptions] = await Promise.all([
    prisma.watchlist.findMany({ where: { userId }, select: { storeId: true, addedAt: true, monitoringStatus: true, monitoringStartedAt: true, monitoringExpiresAt: true } }),
    prisma.analysisUsage.findMany({ where: { userId }, select: { storeId: true, createdAt: true } }),
    prisma.subscription.findMany({ where: { userId }, select: { plan: true, source: true, status: true, startedAt: true, expiresAt: true } }),
    prisma.checkout.findMany({ where: { userId }, select: { plan: true, period: true, listPriceCents: true, discountCents: true, finalCents: true, status: true, createdAt: true } }),
    prisma.promoRedemption.findMany({ where: { userId }, select: { listPriceCents: true, discountCents: true, finalCents: true, createdAt: true } }),
  ]);

  return {
    profile: {
      id: user.id,
      email: user.email,
      emailVerified: user.emailVerifiedAt?.toISOString() ?? null,
      name: user.name,
      image: user.image,
      plan,
      role,
      freeTrialEndsAt: freeTrialEndsAt?.toISOString() ?? null,
      marketingConsent,
      marketingConsentAt: marketingConsentAt?.toISOString() ?? null,
      marketingConsentSource,
      tosAcceptedAt: user.tosAcceptedAt?.toISOString() ?? null,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    },
    watchlists: watchlists.map((w) => ({
      storeId: w.storeId,
      addedAt: w.addedAt.toISOString(),
      monitoringStatus: w.monitoringStatus,
      monitoringStartedAt: w.monitoringStartedAt?.toISOString() ?? null,
      monitoringExpiresAt: w.monitoringExpiresAt?.toISOString() ?? null,
    })),
    analysisUsage: analysisUsage.map((a) => ({ storeId: a.storeId, createdAt: a.createdAt.toISOString() })),
    subscriptions: subscriptions.map((s) => ({
      plan: s.plan,
      source: s.source,
      status: s.status,
      startedAt: s.startedAt.toISOString(),
      expiresAt: s.expiresAt?.toISOString() ?? null,
    })),
    checkouts: checkouts.map((c) => ({
      plan: c.plan,
      period: c.period,
      listPriceCents: c.listPriceCents,
      discountCents: c.discountCents,
      finalCents: c.finalCents,
      status: c.status,
      createdAt: c.createdAt.toISOString(),
    })),
    promoRedemptions: promoRedemptions.map((p) => ({
      listPriceCents: p.listPriceCents,
      discountCents: p.discountCents,
      finalCents: p.finalCents,
      createdAt: p.createdAt.toISOString(),
    })),
    exportedAt: new Date().toISOString(),
  };
}
