"use client";

import { useState } from "react";

/**
 * Minimal promo-code widget for the pricing surface (this milestone's doc,
 * §3.6). Defaults to the "Paid" plan at monthly billing — BASIC and
 * BUSINESS are billed identically (see pricing.ts's own doc comment), so
 * there is only one real purchasable plan to redeem against today.
 *
 * A single generic failure message covers every rejection reason — never
 * surface the server's `reason` verbatim, it leaks code existence (see
 * promo.ts's own doc comment on why `not_assigned_to_you` must be
 * indistinguishable from `not_found`).
 */
type ValidateResponse = { ok: true; listPriceCents: number; discountCents: number; finalCents: number } | { ok: false };

export function PromoRedemption() {
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<
    | { view: "idle" }
    | { view: "checking" }
    | { view: "valid"; finalCents: number; listPriceCents: number; redeeming: boolean }
    | { view: "invalid" }
    | { view: "signed_out" }
    | { view: "redeemed" }
  >({ view: "idle" });

  async function checkCode(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim()) return;
    setStatus({ view: "checking" });
    try {
      const res = await fetch("/api/billing/promo/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan: "BASIC", period: "MONTHLY", code }),
      });
      if (res.status === 401) {
        setStatus({ view: "signed_out" });
        return;
      }
      const body = (await res.json()) as ValidateResponse;
      if (!body.ok) {
        setStatus({ view: "invalid" });
        return;
      }
      setStatus({ view: "valid", finalCents: body.finalCents, listPriceCents: body.listPriceCents, redeeming: false });
    } catch {
      setStatus({ view: "invalid" });
    }
  }

  async function redeem() {
    if (status.view !== "valid") return;
    setStatus({ ...status, redeeming: true });
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan: "BASIC", period: "MONTHLY", code }),
      });
      if (!res.ok) {
        setStatus({ view: "invalid" });
        return;
      }
      setStatus({ view: "redeemed" });
    } catch {
      setStatus({ view: "invalid" });
    }
  }

  if (status.view === "redeemed") {
    return (
      <p className="mt-8 text-center font-mono text-[13px] text-ok">
        Your Paid plan is active. Refresh the dashboard to see it reflected.
      </p>
    );
  }

  return (
    <div className="mx-auto mt-8 max-w-[420px]">
      <form onSubmit={checkCode} className="flex gap-2">
        <input
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Have a promo code?"
          className="flex-1 rounded-md border border-line bg-surface px-3.5 py-2.5 font-mono text-[13px] text-paper outline-none focus:border-sig-price"
        />
        <button
          type="submit"
          disabled={status.view === "checking"}
          className="rounded-md border border-line px-4 py-2.5 font-mono text-[13px] font-semibold text-paper transition hover:border-muted hover:bg-surface-2 disabled:opacity-50"
        >
          {status.view === "checking" ? "Checking…" : "Apply"}
        </button>
      </form>

      {status.view === "invalid" && <p className="mt-2 text-center font-mono text-[12px] text-sig-stock">This code isn&apos;t valid.</p>}
      {status.view === "signed_out" && (
        <p className="mt-2 text-center font-mono text-[12px] text-muted-dim">
          <a href="/login" className="text-sig-new hover:text-[#8AD8FF]">
            Sign in
          </a>{" "}
          to redeem a promo code.
        </p>
      )}
      {status.view === "valid" && (
        <div className="mt-3 text-center">
          <p className="font-mono text-[13px] text-muted">
            Total: <span className="font-semibold text-paper">${(status.finalCents / 100).toFixed(2)}</span>
            {status.finalCents < status.listPriceCents && (
              <span className="ml-1.5 text-muted-dim line-through">${(status.listPriceCents / 100).toFixed(2)}</span>
            )}
          </p>
          <button
            onClick={redeem}
            disabled={status.redeeming}
            className="mt-2.5 rounded-md bg-sig-price px-5 py-2.5 font-mono text-[13px] font-semibold text-[#1A1204] transition hover:-translate-y-px hover:bg-[#FFC44D] disabled:opacity-50"
          >
            {status.redeeming ? "Redeeming…" : "Redeem"}
          </button>
        </div>
      )}
    </div>
  );
}
