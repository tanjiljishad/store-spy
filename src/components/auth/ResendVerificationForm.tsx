"use client";

import { useState } from "react";

/** The /verify-email interstitial's "resend" action — POSTs to /api/auth/resend-verification and reports the outcome inline, no navigation. */
export function ResendVerificationForm() {
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setStatus("sending");
    setError(null);
    try {
      const res = await fetch("/api/auth/resend-verification", { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "Something went wrong. Please try again.");
        setStatus("error");
        return;
      }
      setStatus("sent");
    } catch {
      setError("Something went wrong. Please try again.");
      setStatus("error");
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-[420px] flex-col items-center gap-3">
      {error && (
        <p role="alert" className="rounded-md border border-sig-stock/35 px-3.5 py-2.5 font-mono text-[12.5px] text-sig-stock">
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={handleClick}
        disabled={status === "sending" || status === "sent"}
        className="rounded-md bg-sig-price px-5 py-3 font-mono text-[13px] font-semibold text-[#1A1204] transition hover:-translate-y-px hover:bg-[#FFC44D] disabled:pointer-events-none disabled:opacity-60"
      >
        {status === "sent" ? "Email sent — check your inbox" : status === "sending" ? "Sending…" : "Resend confirmation email"}
      </button>
    </div>
  );
}
