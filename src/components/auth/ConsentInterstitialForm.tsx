"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Milestone 12 §4.1 addendum: the OAuth-signup equivalent of AuthForm's own
 * two checkboxes — same rule (ToS required, marketing optional and
 * unticked, never bundled), rendered as a standalone interstitial instead
 * of part of the signup form, since OAuth has no signup form of its own.
 */
export function ConsentInterstitialForm() {
  const router = useRouter();
  const [tosAccepted, setTosAccepted] = useState(false);
  const [marketingConsent, setMarketingConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/account/consent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tosAccepted, marketingConsent }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Something went wrong. Please try again.");
        setLoading(false);
        return;
      }
      router.push("/dashboard");
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mx-auto w-full max-w-[420px] flex flex-col gap-4">
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
      <label className="flex items-start gap-2.5 font-mono text-[12px] text-muted-dim">
        <input
          type="checkbox"
          checked={marketingConsent}
          onChange={(e) => setMarketingConsent(e.target.checked)}
          className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-sig-price"
        />
        <span>Send me occasional product updates and offers by email. (Optional — you can unsubscribe anytime)</span>
      </label>

      {error && (
        <p role="alert" className="rounded-md border border-sig-stock/35 px-3.5 py-2.5 font-mono text-[12.5px] text-sig-stock">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={loading || !tosAccepted}
        className="mt-1.5 rounded-md bg-sig-price px-5 py-3 font-mono text-[13px] font-semibold text-[#1A1204] transition hover:-translate-y-px hover:bg-[#FFC44D] disabled:pointer-events-none disabled:opacity-60"
      >
        {loading ? "Please wait…" : "Continue"}
      </button>
    </form>
  );
}
