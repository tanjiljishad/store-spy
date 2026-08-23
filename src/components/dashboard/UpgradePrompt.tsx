import Link from "next/link";
import { maxActiveMonitoredStores, maxAnalysesPer24h } from "@/lib/entitlements/entitlement-service";
import { listPriceCents } from "@/lib/billing/pricing";

/**
 * Milestone 12 §1.5: "When a FREE user clicks [monitor more stores], show
 * what BASIC (20) and BUSINESS (50) unlock, with the price — do not show a
 * bare error." Reads every number from entitlement-service.ts/pricing.ts
 * rather than hardcoding them, so this never drifts from the actual plan
 * matrix (the same discipline plan-limits.ts's own doc comment requires of
 * everything else in the app).
 */
const TIERS = ["BASIC", "BUSINESS"] as const;

function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(0)}/mo`;
}

export function UpgradePrompt() {
  return (
    <div className="mt-3 grid gap-2 sm:grid-cols-2">
      {TIERS.map((tier) => (
        <div key={tier} className="rounded-md border border-line-soft bg-surface p-3 text-left">
          <div className="font-mono text-[11px] font-semibold uppercase tracking-wider text-paper">
            {tier === "BASIC" ? "Basic" : "Business"} — {formatPrice(listPriceCents(tier, "MONTHLY"))}
          </div>
          <div className="mt-1 font-mono text-[11px] text-muted-dim">
            {maxActiveMonitoredStores(tier)} monitored stores · {maxAnalysesPer24h(tier)} analyses/day
          </div>
        </div>
      ))}
      <Link
        href="/#pricing"
        className="col-span-full mt-1 inline-block rounded-md bg-sig-price px-4 py-2 text-center font-mono text-[12px] font-semibold text-[#1A1204] transition hover:-translate-y-px hover:bg-[#FFC44D]"
      >
        Upgrade
      </Link>
    </div>
  );
}
