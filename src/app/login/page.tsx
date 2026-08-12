import Link from "next/link";
import { configuredProviders } from "@/lib/auth/auth";
import { authDestination } from "@/lib/auth/redirect-destination";
import { AuthForm } from "@/components/auth/AuthForm";

export const metadata = { title: "Sign in — Bellwether" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ store?: string }> }) {
  const { store } = await searchParams;
  const destination = authDestination(store);

  return (
    <div className="mx-auto flex min-h-[calc(100vh-62px)] max-w-[1180px] flex-col items-center justify-center px-7 py-16">
      <Link href="/" className="mb-8 flex items-center gap-2.5 font-display text-[17px] font-bold tracking-tight">
        <span className="h-[11px] w-[11px] rounded-sm bg-sig-price shadow-[0_0_0_4px_rgba(255,182,39,0.14)]" />
        Bellwether
      </Link>
      <div className="w-full max-w-[420px] rounded-2xl border border-line bg-surface p-8 shadow-[0_24px_60px_-30px_rgba(0,0,0,0.9)]">
        <h1 className="mb-1.5 text-center font-display text-2xl font-bold tracking-tight">Sign in</h1>
        <p className="mb-7 text-center font-mono text-[13px] text-muted">
          {store ? `Sign in to see the full report for ${store}.` : "Continue tracking your competitors."}
        </p>
        <AuthForm mode="login" hasGoogle={configuredProviders.google} hasFacebook={configuredProviders.facebook} destination={destination} />
      </div>
    </div>
  );
}
