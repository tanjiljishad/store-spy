import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { needsConsentInterstitial } from "@/lib/account/consent";
import { ConsentInterstitialForm } from "@/components/auth/ConsentInterstitialForm";

export const metadata = { title: "Store Spy — Welcome" };

/**
 * Milestone 12 §4.1 addendum: the ONLY place a first-time OAuth sign-in
 * (Google/Facebook) captures ToS acceptance and marketing consent — there
 * is no signup form for that path (the Auth.js Prisma adapter creates the
 * `User` row directly). `DashboardLayout` redirects here whenever
 * `needsConsentInterstitial()` is true; this page redirects BACK to
 * `/dashboard` once it's false, so it can never be shown twice for the
 * same account, and redirects to `/login` for a genuinely signed-out
 * visitor rather than rendering a form with nothing to submit against.
 */
export default async function WelcomePage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }
  if (!(await needsConsentInterstitial(prisma, user.id))) {
    redirect("/dashboard");
  }

  return (
    <div className="mx-auto flex min-h-[calc(100vh-62px)] max-w-[1180px] flex-col items-center justify-center px-7 py-16">
      <Link href="/" className="mb-8 flex items-center gap-2.5 font-display text-[17px] font-bold tracking-tight">
        <span className="h-[11px] w-[11px] rounded-sm bg-sig-price shadow-[0_0_0_4px_rgba(255,182,39,0.14)]" />
        Store Spy
      </Link>
      <div className="w-full max-w-[420px] rounded-2xl border border-line bg-surface p-8 shadow-[0_24px_60px_-30px_rgba(0,0,0,0.9)]">
        <h1 className="mb-1.5 text-center font-display text-2xl font-bold tracking-tight">One more step</h1>
        <p className="mb-7 text-center font-mono text-[13px] text-muted">Before you continue to your dashboard.</p>
        <ConsentInterstitialForm />
      </div>
    </div>
  );
}
