import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { needsConsentInterstitial } from "@/lib/account/consent";
import { needsEmailVerification } from "@/lib/account/email-verification";
import { DashboardNav } from "@/components/dashboard/DashboardNav";
import type { ReactNode } from "react";

/**
 * The actual security boundary for every /dashboard/** route — a server
 * component, not proxy.ts. This Next.js fork's own docs warn that a
 * matcher change can silently drop proxy coverage; checking here means
 * every dashboard page is protected regardless of routing changes
 * elsewhere, consistent with the same choice made for the API routes in
 * Sub-phase A (getCurrentUser() at the call site, not a shared gate).
 *
 * Milestone 12 §4.1 addendum: a signed-in user whose account has never
 * accepted ToS (OAuth first sign-in — no form, no consent moment of its
 * own; see needsConsentInterstitial()'s doc comment) is redirected to the
 * consent interstitial instead of the dashboard. A fresh DB read, not the
 * JWT — `getCurrentUser()`'s CurrentUser shape doesn't carry
 * `tosAcceptedAt`, and this condition, once satisfied, never needs
 * checking again for that account, so there's no cost to re-reading it
 * from source rather than caching it in the token the way plan/role are.
 *
 * Email verification addendum: checked AFTER the consent gate, same
 * fresh-read reasoning — see needsEmailVerification()'s own doc comment for
 * why an OAuth account never actually hits this (its emailVerified is set
 * at creation time, in auth.ts's Google/Facebook profile() overrides).
 */
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }
  if (await needsConsentInterstitial(prisma, user.id)) {
    redirect("/welcome");
  }
  if (await needsEmailVerification(prisma, user.id)) {
    redirect("/verify-email");
  }

  return (
    <>
      <DashboardNav email={user.email} />
      <div className="mx-auto max-w-[1180px] px-7 pb-16 pt-10">{children}</div>
    </>
  );
}
