"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";

export interface AuthFormProps {
  mode: "login" | "signup";
  hasGoogle: boolean;
  hasFacebook: boolean;
  /** Where to land once auth succeeds — "/dashboard" by default, or a specific store's report if the user arrived via an anonymous-preview signup CTA. Computed server-side (see authDestination()), never a client-controlled redirect. */
  destination: string;
}

/**
 * Shared shell for /login and /signup. Google/Facebook buttons only render
 * when the server actually has those providers configured (passed down
 * from getProviders(), read server-side in the page) — never a fake
 * "Continue with Google" that would 500 on click.
 */
export function AuthForm({ mode, hasGoogle, hasFacebook, destination }: AuthFormProps) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Milestone 12 §4.1: two SEPARATE checkboxes. tosAccepted is required to
  // submit at all (see the disabled state below); marketingConsent starts
  // unticked and stays fully optional — the two must never be combined
  // into one control, or read from one another, or this whole point is lost.
  const [tosAccepted, setTosAccepted] = useState(false);
  const [marketingConsent, setMarketingConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    if (mode === "signup") {
      try {
        const res = await fetch("/api/auth/signup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, password, tosAccepted, marketingConsent }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setError(body.error ?? "Something went wrong. Please try again.");
          setLoading(false);
          return;
        }
      } catch {
        setError("Something went wrong. Please try again.");
        setLoading(false);
        return;
      }
    }

    const result = await signIn("credentials", { email, password, redirect: false });
    if (result?.error) {
      setError(mode === "signup" ? "Account created, but sign-in failed. Try signing in below." : "Invalid email or password.");
      setLoading(false);
      return;
    }

    router.push(destination);
    router.refresh();
  }

  return (
    <div className="mx-auto w-full max-w-[400px]">
      {(hasGoogle || hasFacebook) && (
        <div className="mb-5 flex flex-col gap-2.5">
          {hasGoogle && (
            <button
              type="button"
              className="rounded-md border border-line px-5 py-3 font-mono text-[13px] font-semibold text-paper transition hover:border-muted hover:bg-surface"
              onClick={() => signIn("google", { callbackUrl: destination })}
            >
              Continue with Google
            </button>
          )}
          {hasFacebook && (
            <button
              type="button"
              className="rounded-md border border-line px-5 py-3 font-mono text-[13px] font-semibold text-paper transition hover:border-muted hover:bg-surface"
              onClick={() => signIn("facebook", { callbackUrl: destination })}
            >
              Continue with Facebook
            </button>
          )}
        </div>
      )}

      {(hasGoogle || hasFacebook) && (
        <div className="mb-5 flex items-center gap-3 font-mono text-[11px] uppercase tracking-wider text-muted-dim">
          <span className="h-px flex-1 bg-line-soft" />
          or
          <span className="h-px flex-1 bg-line-soft" />
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-3.5">
        <label className="flex flex-col gap-1.5">
          <span className="font-mono text-[11px] uppercase tracking-wider text-muted-dim">Email</span>
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded-md border border-line bg-surface px-4 py-2.5 text-[14px] text-paper outline-none transition focus:border-sig-price"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="font-mono text-[11px] uppercase tracking-wider text-muted-dim">Password</span>
          <input
            type="password"
            required
            minLength={8}
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="rounded-md border border-line bg-surface px-4 py-2.5 text-[14px] text-paper outline-none transition focus:border-sig-price"
          />
        </label>

        {mode === "signup" && (
          <div className="flex flex-col gap-2.5">
            {/* Milestone 12 §4.1: required — the submit button stays disabled until this is checked. */}
            <label className="flex items-start gap-2.5 font-mono text-[12px] text-muted-dim">
              <input
                type="checkbox"
                required
                checked={tosAccepted}
                onChange={(e) => setTosAccepted(e.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-sig-price"
              />
              <span>
                I agree to the{" "}
                <a href="/terms" target="_blank" rel="noreferrer" className="text-sig-new hover:text-[#8AD8FF]">
                  Terms of Service
                </a>{" "}
                and{" "}
                <a href="/privacy" target="_blank" rel="noreferrer" className="text-sig-new hover:text-[#8AD8FF]">
                  Privacy Policy
                </a>
                . (Required)
              </span>
            </label>
            {/* Milestone 12 §4.1: a SEPARATE, unticked-by-default checkbox — deliberately not combined with the one above. Fully optional; signup succeeds either way. */}
            <label className="flex items-start gap-2.5 font-mono text-[12px] text-muted-dim">
              <input
                type="checkbox"
                checked={marketingConsent}
                onChange={(e) => setMarketingConsent(e.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-sig-price"
              />
              <span>Send me occasional product updates and offers by email. (Optional — you can unsubscribe anytime)</span>
            </label>
          </div>
        )}

        {error && (
          <p role="alert" className="rounded-md border border-sig-stock/35 px-3.5 py-2.5 font-mono text-[12.5px] text-sig-stock">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={loading || (mode === "signup" && !tosAccepted)}
          className="mt-1.5 rounded-md bg-sig-price px-5 py-3 font-mono text-[13px] font-semibold text-[#1A1204] transition hover:-translate-y-px hover:bg-[#FFC44D] disabled:pointer-events-none disabled:opacity-60"
        >
          {loading ? "Please wait…" : mode === "signup" ? "Create free account" : "Sign in"}
        </button>
      </form>

      {mode === "signup" ? (
        <p className="mt-5 text-center font-mono text-[12.5px] text-muted-dim">
          Already have an account?{" "}
          <a href="/login" className="text-sig-new hover:text-[#8AD8FF]">
            Sign in
          </a>
        </p>
      ) : (
        <p className="mt-5 text-center font-mono text-[12.5px] text-muted-dim">
          No account yet?{" "}
          <a href="/signup" className="text-sig-new hover:text-[#8AD8FF]">
            Create a free account
          </a>
        </p>
      )}
    </div>
  );
}
