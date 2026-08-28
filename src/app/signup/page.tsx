import Link from "next/link";
import { configuredProviders } from "@/lib/auth/auth";
import { authDestination } from "@/lib/auth/redirect-destination";
import { AuthForm } from "@/components/auth/AuthForm";

export const metadata = { title: "Store Spy — Create your free account" };

export default async function SignupPage({ searchParams }: { searchParams: Promise<{ store?: string }> }) {
  const { store } = await searchParams;
  const destination = authDestination(store);

  return (
    <div className="mx-auto flex min-h-[calc(100vh-62px)] max-w-[1180px] flex-col items-center justify-center px-7 py-16">
      <Link href="/" className="mb-8 flex items-center gap-2.5 font-display text-[17px] font-bold tracking-tight">
        <span className="h-[11px] w-[11px] rounded-sm bg-sig-price shadow-[0_0_0_4px_rgba(255,182,39,0.14)]" />
        Store Spy
      </Link>
      <div className="w-full max-w-[420px] rounded-2xl border border-line bg-surface p-8 shadow-[0_24px_60px_-30px_rgba(0,0,0,0.9)]">
        <h1 className="mb-1.5 text-center font-display text-2xl font-bold tracking-tight">Create your free account</h1>
        <p className="mb-3 text-center font-mono text-[13px] text-muted">
          {store ? `Unlock the complete report for ${store}.` : "Unlock complete competitor intelligence."}
        </p>
        <ul className="mb-7 flex flex-col gap-1 font-mono text-[12px] text-muted-dim">
          <li>✓ 3 free store analyses, full intelligence unlocked</li>
          <li>✓ Monitor 1 competitor free for 30 days</li>
          <li>✓ No credit card required</li>
        </ul>
        <AuthForm mode="signup" hasGoogle={configuredProviders.google} hasFacebook={configuredProviders.facebook} destination={destination} />
      </div>
    </div>
  );
}
