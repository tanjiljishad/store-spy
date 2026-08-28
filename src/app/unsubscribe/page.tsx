import Link from "next/link";
import { prisma } from "@/lib/db/prisma";
import { verifyUnsubscribeToken } from "@/lib/marketing/unsubscribe-token";
import { revokeMarketingConsent } from "@/lib/marketing/consent";

export const metadata = { title: "Store Spy — Unsubscribe" };

interface UnsubscribePageProps {
  searchParams: Promise<{ uid?: string; token?: string }>;
}

/**
 * Milestone 12 §4.1: "giving a one-click unsubscribe that requires no
 * login." No session check anywhere on this page — the HMAC token IS the
 * authentication (see unsubscribe-token.ts). The unsubscribe itself
 * happens on this GET render, not behind a second POST/confirm step: no
 * email sender exists anywhere in this codebase yet (out of scope for this
 * milestone), so there is no real corporate-email-scanner-prefetch risk to
 * guard against today, and "one click" is the doc's own explicit
 * requirement — a second confirmation click would violate it for no
 * present benefit.
 */
export default async function UnsubscribePage({ searchParams }: UnsubscribePageProps) {
  const { uid, token } = await searchParams;

  const valid = Boolean(uid) && verifyUnsubscribeToken(uid!, token);

  if (valid) {
    // Idempotent — clicking a stale/already-used link a second time is a
    // harmless no-op, not an error, matching revokeMarketingConsent()'s
    // own doc comment.
    await revokeMarketingConsent(prisma, uid!);
  }

  return (
    <div className="mx-auto flex min-h-[calc(100vh-62px)] max-w-[560px] flex-col items-center justify-center px-7 py-16 text-center">
      <Link href="/" className="mb-8 flex items-center gap-2.5 font-display text-[17px] font-bold tracking-tight">
        <span className="h-[11px] w-[11px] rounded-sm bg-sig-price shadow-[0_0_0_4px_rgba(255,182,39,0.14)]" />
        Store Spy
      </Link>
      {valid ? (
        <>
          <h1 className="mb-2 font-display text-2xl font-bold tracking-tight">You&rsquo;re unsubscribed</h1>
          <p className="font-mono text-[13px] text-muted-dim">
            You will no longer receive marketing emails from us. You can still sign in and use your
            account normally — this only affects marketing email.
          </p>
        </>
      ) : (
        <>
          <h1 className="mb-2 font-display text-2xl font-bold tracking-tight">Link no longer valid</h1>
          <p className="font-mono text-[13px] text-muted-dim">
            This unsubscribe link is invalid or expired. If you&rsquo;re still receiving unwanted email, sign in
            and update your preferences from account settings, or contact support.
          </p>
        </>
      )}
    </div>
  );
}
