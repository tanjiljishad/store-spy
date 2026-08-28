import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { verifyEmailVerificationToken } from "@/lib/auth/email-verification-token";
import { ResendVerificationForm } from "@/components/auth/ResendVerificationForm";

export const metadata = { title: "Store Spy — Confirm your email" };

interface VerifyEmailPageProps {
  searchParams: Promise<{ uid?: string; token?: string }>;
}

/**
 * Two distinct entry points share this one route:
 *  - `?uid=&token=` — the link mailed by sendVerificationEmail(). No session
 *    required; the HMAC token IS the authentication, the same "one click, no
 *    login" precedent as /unsubscribe (see unsubscribe-token.ts's own doc
 *    comment) — whoever can click the link has proven they control the inbox.
 *  - No query params — DashboardLayout/AdminLayout redirect a signed-in,
 *    unverified account here (mirrors /welcome's consent interstitial),
 *    where they land right after signup and can request the email again.
 */
export default async function VerifyEmailPage({ searchParams }: VerifyEmailPageProps) {
  const { uid, token } = await searchParams;

  if (uid && token) {
    const target = await prisma.user.findUnique({ where: { id: uid }, select: { email: true, emailVerified: true } });
    const alreadyVerified = Boolean(target?.emailVerified);
    const valid = Boolean(target) && verifyEmailVerificationToken(uid, target!.email, token);

    if (valid && !alreadyVerified) {
      const verifiedAt = new Date();
      // TRANSITIONAL (B2 step 2·B): dual-write. 2·B repoints needsEmailVerification()
      // to control_plane.users and drops the shadow store_spy.User write.
      await prisma.user.update({ where: { id: uid }, data: { emailVerified: verifiedAt } });
      await prisma.cpUser.updateMany({ where: { id: uid }, data: { emailVerifiedAt: verifiedAt } });
    }

    // Idempotent — re-clicking an already-used link is a harmless no-op
    // that still reads as success, not an error (same reasoning as
    // /unsubscribe treating a repeat click as fine).
    const confirmed = valid || alreadyVerified;

    return (
      <div className="mx-auto flex min-h-[calc(100vh-62px)] max-w-[560px] flex-col items-center justify-center px-7 py-16 text-center">
        <Link href="/" className="mb-8 flex items-center gap-2.5 font-display text-[17px] font-bold tracking-tight">
          <span className="h-[11px] w-[11px] rounded-sm bg-sig-price shadow-[0_0_0_4px_rgba(255,182,39,0.14)]" />
          Store Spy
        </Link>
        {confirmed ? (
          <>
            <h1 className="mb-2 font-display text-2xl font-bold tracking-tight">Email confirmed</h1>
            <p className="mb-6 font-mono text-[13px] text-muted-dim">Your email is verified.</p>
            <Link
              href="/dashboard"
              className="rounded-md bg-sig-price px-5 py-3 font-mono text-[13px] font-semibold text-[#1A1204] transition hover:-translate-y-px hover:bg-[#FFC44D]"
            >
              Continue to your dashboard
            </Link>
          </>
        ) : (
          <>
            <h1 className="mb-2 font-display text-2xl font-bold tracking-tight">Link no longer valid</h1>
            <p className="font-mono text-[13px] text-muted-dim">
              This confirmation link is invalid. Sign in and request a new one from there.
            </p>
          </>
        )}
      </div>
    );
  }

  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }
  const fresh = await prisma.user.findUnique({ where: { id: user.id }, select: { email: true, emailVerified: true } });
  if (!fresh) {
    redirect("/login");
  }
  if (fresh.emailVerified) {
    redirect("/dashboard");
  }

  return (
    <div className="mx-auto flex min-h-[calc(100vh-62px)] max-w-[560px] flex-col items-center justify-center px-7 py-16 text-center">
      <Link href="/" className="mb-8 flex items-center gap-2.5 font-display text-[17px] font-bold tracking-tight">
        <span className="h-[11px] w-[11px] rounded-sm bg-sig-price shadow-[0_0_0_4px_rgba(255,182,39,0.14)]" />
        Store Spy
      </Link>
      <h1 className="mb-2 font-display text-2xl font-bold tracking-tight">Confirm your email</h1>
      <p className="mb-7 font-mono text-[13px] text-muted-dim">
        We sent a confirmation link to <span className="text-paper">{fresh.email}</span>. Click it to unlock your dashboard.
      </p>
      <ResendVerificationForm />
    </div>
  );
}
