"use client";

import { useEffect, useState } from "react";

interface ActivityResponse {
  summary: {
    windowDays: number;
    productsAdded: number;
    productsRemoved: number;
    productsRestored: number;
    priceChanges: number;
    productCountDelta: number | null;
    hasEnoughHistory: boolean;
  };
  signals: Array<{ kind: string; detail: string }>;
}

export interface StoreActivitySummaryProps {
  domain: string;
}

/**
 * Fetches real activity from /api/store/[domain]/activity — every number
 * here is a live query against Event/Product, never fabricated. Renders
 * nothing (not a fake empty state) if the fetch itself fails; the honest
 * "not enough history yet" state is a real, successful response, not an error.
 */
export function StoreActivitySummary({ domain }: StoreActivitySummaryProps) {
  const [data, setData] = useState<ActivityResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/store/${encodeURIComponent(domain)}/activity`)
      .then((r) => (r.ok ? (r.json() as Promise<ActivityResponse>) : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [domain]);

  if (failed) return null;
  if (!data) {
    return <p className="font-mono text-xs text-muted-dim">Loading activity…</p>;
  }

  if (!data.summary.hasEnoughHistory) {
    return (
      <div className="rounded-xl border border-dashed border-line px-5 py-7 text-center">
        <p className="font-display text-base font-bold">Monitoring started</p>
        <p className="mt-1.5 font-mono text-xs text-muted-dim">
          Historical activity will appear here after the next crawl.
        </p>
      </div>
    );
  }

  const { summary, signals } = data;
  const netLabel =
    summary.productCountDelta === null
      ? "—"
      : `${summary.productCountDelta > 0 ? "+" : ""}${summary.productCountDelta}`;

  return (
    <div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={`Added · ${summary.windowDays}d`} value={`+${summary.productsAdded}`} />
        <Stat label={`Removed · ${summary.windowDays}d`} value={`-${summary.productsRemoved}`} />
        <Stat label={`Restored · ${summary.windowDays}d`} value={`+${summary.productsRestored}`} />
        <Stat label="Price changes" value={String(summary.priceChanges)} />
        <Stat label="Net products" value={netLabel} />
      </div>
      {signals.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-2">
          {signals.map((s) => (
            <li
              key={s.kind}
              className="rounded-full border border-line-soft px-3 py-1.5 font-mono text-[11px] text-muted"
            >
              {s.detail}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 font-mono text-[10.5px] text-muted-dim">
        Observed signals from real crawl history — not a claim about revenue or business growth.
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line-soft bg-surface p-3 text-center">
      <div className="font-display text-xl font-bold tracking-tight">{value}</div>
      <div className="mt-1 font-mono text-[10px] uppercase tracking-wider text-muted-dim">{label}</div>
    </div>
  );
}
