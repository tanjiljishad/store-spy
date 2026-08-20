"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Client component for the one genuinely interactive piece of this page — the create form still POSTs to /api/admin/promos, which re-checks promo:create itself. */
export function CreatePromoForm() {
  const router = useRouter();
  const [discountType, setDiscountType] = useState<"PERCENT" | "FIXED">("PERCENT");
  const [discountValue, setDiscountValue] = useState("100");
  const [durationDays, setDurationDays] = useState("");
  const [vanityCode, setVanityCode] = useState("");
  const [result, setResult] = useState<{ code: string } | { error: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setResult(null);
    try {
      const res = await fetch("/api/admin/promos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          vanityCode: vanityCode || undefined,
          discountType,
          discountValue: Number(discountValue),
          validFrom: new Date().toISOString(),
          durationDays: durationDays ? Number(durationDays) : null,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setResult({ error: body.error ?? "Failed to create promo." });
      } else {
        setResult({ code: body.code });
        router.refresh();
      }
    } catch {
      setResult({ error: "Failed to create promo." });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-4 flex flex-wrap items-end gap-3 rounded-md border border-line-soft p-4">
      <label className="flex flex-col gap-1">
        <span className="font-mono text-[11px] text-muted-dim">Type</span>
        <select
          value={discountType}
          onChange={(e) => setDiscountType(e.target.value as "PERCENT" | "FIXED")}
          className="rounded-md border border-line bg-surface px-2.5 py-2 font-mono text-[13px] text-paper"
        >
          <option value="PERCENT">Percent</option>
          <option value="FIXED">Fixed (cents)</option>
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="font-mono text-[11px] text-muted-dim">Value</span>
        <input
          type="number"
          value={discountValue}
          onChange={(e) => setDiscountValue(e.target.value)}
          className="w-24 rounded-md border border-line bg-surface px-2.5 py-2 font-mono text-[13px] text-paper"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="font-mono text-[11px] text-muted-dim">Duration (days, blank = forever)</span>
        <input
          type="number"
          value={durationDays}
          onChange={(e) => setDurationDays(e.target.value)}
          className="w-40 rounded-md border border-line bg-surface px-2.5 py-2 font-mono text-[13px] text-paper"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="font-mono text-[11px] text-muted-dim">Vanity code (optional)</span>
        <input
          type="text"
          value={vanityCode}
          onChange={(e) => setVanityCode(e.target.value)}
          placeholder="auto-generated"
          className="w-40 rounded-md border border-line bg-surface px-2.5 py-2 font-mono text-[13px] text-paper"
        />
      </label>
      <button
        type="submit"
        disabled={submitting}
        className="rounded-md bg-sig-price px-4 py-2.5 font-mono text-[13px] font-semibold text-[#1A1204] disabled:opacity-50"
      >
        {submitting ? "Creating…" : "Create"}
      </button>

      {result && "code" in result && (
        <p className="w-full font-mono text-[12.5px] text-ok">
          Created — code (shown once): <strong>{result.code}</strong>
        </p>
      )}
      {result && "error" in result && <p className="w-full font-mono text-[12.5px] text-sig-stock">{result.error}</p>}
    </form>
  );
}
