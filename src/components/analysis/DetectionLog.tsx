import type { AnalysisSseEvent } from "@/lib/analysis/types";

export interface DetectionLogProps {
  domain: string;
  events: AnalysisSseEvent[];
}

/**
 * Renders exactly the events the server has sent so far — nothing here is
 * synthesized. If the crawler hasn't reported a product count yet, no line
 * mentions one; the log is only ever as far along as the real backend is.
 */
export function DetectionLog({ domain, events }: DetectionLogProps) {
  const lines = events.filter((e) => e.type === "progress");
  const isDone = events.some((e) => e.type === "status" && e.status === "completed");
  const percent = Math.min(100, lines.length === 0 ? 5 : Math.round((lines.length / 7) * 100));

  return (
    <div className="mx-auto mt-16 max-w-[820px] text-left">
      <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-[0_24px_60px_-30px_rgba(0,0,0,0.9)]">
        <div className="flex items-center justify-between gap-3 border-b border-line-soft bg-surface-2 px-[18px] py-[13px]">
          <span className="font-mono text-xs font-semibold tracking-wider text-muted">
            ANALYZING — {domain}
          </span>
          <span className="flex items-center gap-1.5 font-mono text-[11px] text-muted-dim">
            <i
              className={`h-1.5 w-1.5 rounded-full bg-ok ${isDone ? "" : "animate-pulse"}`}
              aria-hidden="true"
            />
            live crawl
          </span>
        </div>

        <ul className="min-h-[160px] py-2 font-mono text-[13px]" aria-live="polite">
          {lines.length === 0 && (
            <li className="flex items-baseline gap-3 px-[18px] py-[9px] text-muted-dim">
              <span className="w-3.5 flex-none">…</span>
              <span>Connecting…</span>
            </li>
          )}
          {lines.map((e, i) => (
            <li key={i} className="flex items-baseline gap-3 px-[18px] py-[9px]">
              <span className="w-3.5 flex-none text-ok">✓</span>
              <span className="break-words text-paper">{e.message}</span>
            </li>
          ))}
        </ul>

        <div className="border-t border-line-soft bg-surface-2 px-[18px] py-3">
          <div className="h-1 overflow-hidden rounded-full bg-line">
            <div
              className="h-full rounded-full bg-sig-price transition-all duration-500"
              style={{ width: `${percent}%` }}
            />
          </div>
          <p className="mt-2 font-mono text-[11px] text-muted-dim">
            Reading publicly available store data. Typical analysis: 8–20 seconds.
          </p>
        </div>
      </div>
    </div>
  );
}
