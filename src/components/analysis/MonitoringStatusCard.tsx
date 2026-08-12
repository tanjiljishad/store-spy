import type { MonitoringStatus } from "@/lib/analysis/types";
import { formatRelativeTime } from "@/lib/format-relative-time";

export interface MonitoringStatusCardProps {
  monitoring: MonitoringStatus;
}

const TIER_LABEL: Record<MonitoringStatus["tier"], string> = {
  HOT: "every ~8 hours",
  WARM: "daily",
  COOL: "weekly",
  COLD: "monthly",
  DORMANT: "quarterly",
  DISABLED: "not scheduled",
};

/** Real values from Store.tier/lastCrawledAt/nextCrawlAt — never fabricated. */
export function MonitoringStatusCard({ monitoring }: MonitoringStatusCardProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-line-soft bg-surface px-5 py-4">
      <div className="flex items-center gap-3">
        <span className={`h-2 w-2 rounded-full ${monitoring.active ? "bg-ok" : "bg-muted-dim"}`} aria-hidden="true" />
        <div>
          <div className="font-mono text-xs uppercase tracking-wider text-muted-dim">Monitoring</div>
          <div className="font-display text-base font-bold tracking-tight">
            {monitoring.active ? "Active" : "Paused"}
            <span className="ml-2 font-mono text-xs font-normal text-muted">· checked {TIER_LABEL[monitoring.tier]}</span>
          </div>
        </div>
      </div>
      <div className="flex gap-6 font-mono text-xs text-muted">
        <div>
          <div className="text-muted-dim">Last checked</div>
          <div className="mt-0.5 text-paper">{formatRelativeTime(monitoring.lastCrawledAt)}</div>
        </div>
        {monitoring.active && (
          <div>
            <div className="text-muted-dim">Next check</div>
            <div className="mt-0.5 text-paper">{formatRelativeTime(monitoring.nextCrawlAt)}</div>
          </div>
        )}
      </div>
    </div>
  );
}
