"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { UpgradePrompt } from "./UpgradePrompt";

export interface MonitorButtonProps {
  domain: string;
  /** This store's watch status for the CURRENT signed-in user — never another user's. */
  watchStatus: "ACTIVE" | "EXPIRED" | "NONE";
  daysRemaining: number | null;
  /** How many OTHER stores (excluding this one) the user currently has ACTIVE — plan-limit math, not a FREE-only "1 store" assumption. */
  otherActiveWatchCount: number;
  /** null = unlimited (not currently offered for monitoring, but the type stays honest). */
  monitorLimit: number | null;
  planLabel: string;
}

/**
 * The one interactive piece of the Store Intelligence header. Every state
 * shown here reflects what the server just told us — no optimistic "looks
 * active" guess. POST/DELETE hit the same /api/store/[domain]/watch route
 * built in Sub-phase A; this component doesn't reimplement entitlement
 * logic or hardcode a plan's limit — the limit and count are passed in
 * from the entitlement service via the page, so this same component works
 * unmodified whether the user is on FREE (limit 1) or PAID (limit 10).
 */
export function MonitorButton({
  domain,
  watchStatus,
  daysRemaining,
  otherActiveWatchCount,
  monitorLimit,
  planLabel,
}: MonitorButtonProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showUpgradePrompt, setShowUpgradePrompt] = useState(false);

  async function start() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/store/${encodeURIComponent(domain)}/watch`, { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { code?: string; limit?: string };
        if (body.code === "LIMIT_REACHED" && (body.limit === "MONITORED_STORES" || body.limit === "TRIAL_EXPIRED")) {
          // Milestone 12 §1.5: a bare error here would just tell the user
          // no — the actual conversion opportunity is showing them what
          // upgrading unlocks, right where they hit the wall.
          setShowUpgradePrompt(true);
        } else {
          setError("Couldn't start monitoring. Try again.");
        }
        return;
      }
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  async function stop() {
    setLoading(true);
    setError(null);
    try {
      await fetch(`/api/store/${encodeURIComponent(domain)}/watch`, { method: "DELETE" });
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  if (watchStatus === "ACTIVE") {
    return (
      <div className="flex items-center gap-3">
        <span className="rounded-md border border-ok/35 px-4 py-2.5 font-mono text-[13px] font-semibold text-ok">
          ● Monitoring active{daysRemaining !== null ? ` — ${daysRemaining} ${daysRemaining === 1 ? "day" : "days"} remaining` : ""}
        </span>
        <button
          className="font-mono text-[12px] text-muted-dim underline decoration-dotted hover:text-muted"
          onClick={stop}
          disabled={loading}
        >
          Stop monitoring
        </button>
      </div>
    );
  }

  const atLimit = monitorLimit !== null && otherActiveWatchCount >= monitorLimit;

  if (atLimit || showUpgradePrompt) {
    return (
      <div className="text-right">
        <span className="rounded-md border border-line px-4 py-2.5 font-mono text-[13px] text-muted">
          Monitoring limit reached
        </span>
        <p className="mt-1.5 max-w-[34ch] font-mono text-[11px] text-muted-dim">
          {planLabel} accounts can monitor{monitorLimit === null ? " unlimited stores." : ` up to ${monitorLimit} store${monitorLimit === 1 ? "" : "s"}.`}
        </p>
        <UpgradePrompt />
      </div>
    );
  }

  return (
    <div>
      <button
        className="rounded-md bg-sig-price px-5 py-2.5 font-mono text-[13px] font-semibold text-[#1A1204] transition hover:-translate-y-px hover:bg-[#FFC44D] disabled:pointer-events-none disabled:opacity-60"
        onClick={start}
        disabled={loading}
      >
        {watchStatus === "EXPIRED" ? "Resume monitoring" : "Monitor this store"}
      </button>
      {error && <p className="mt-1.5 font-mono text-[11px] text-sig-stock">{error}</p>}
    </div>
  );
}
