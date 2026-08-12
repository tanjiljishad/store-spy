"use client";

import { useEffect, useState } from "react";
import type { ObservedField, UnavailableField } from "@/lib/analysis/report-contract";
import { IntelligenceCard } from "@/components/dashboard/IntelligenceCard";
import { formatRelativeTime } from "@/lib/format-relative-time";

interface AdView {
  externalAdId: string;
  destinationUrl: string | null;
  advertiserName: string | null;
  format: string | null;
  regions: string[] | null;
  matchedProduct: { id: string; handle: string; title: string } | null;
  matchConfidence: "HIGH" | "MEDIUM" | "LOW" | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

interface MarketingActivitySummary {
  windowDays: number;
  adsDetected: number;
  adsRemoved: number;
  currentActiveAdCount: number;
  continuouslyObservedAdCount: number;
  collectionsInWindow: number;
  hasEnoughHistory: boolean;
}

interface MarketingReport {
  domain: string;
  platform: "GOOGLE";
  ads: ObservedField<AdView[]> | UnavailableField;
  lastCheckedAt: string | null;
  activity: MarketingActivitySummary | null;
  productMatching: UnavailableField;
}

export interface AdvertisingSummaryProps {
  domain: string;
}

/**
 * Fetches real marketing intelligence from /api/store/[domain]/marketing —
 * every number here is a live query against AdObservation/MarketingCollectionRun
 * /Event, never fabricated. Deterministic exact-URL product matching is a
 * verified non-capability of the current data source (Sub-phase D live
 * testing) — this component never implies otherwise; productMatching
 * renders through the same IntelligenceCard "Unavailable" state as any
 * other not-yet-supported field, with its real reason, not a special case.
 */
export function AdvertisingSummary({ domain }: AdvertisingSummaryProps) {
  const [data, setData] = useState<MarketingReport | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/store/${encodeURIComponent(domain)}/marketing`)
      .then((r) => (r.ok ? (r.json() as Promise<MarketingReport>) : Promise.reject(new Error(String(r.status)))))
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
    return <p className="font-mono text-xs text-muted-dim">Loading advertising activity…</p>;
  }

  const { ads, activity } = data;
  const adsObservedField: ObservedField<number> | UnavailableField =
    ads.status === "OBSERVED" ? { status: "OBSERVED", value: ads.value.length } : ads;

  return (
    <div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <IntelligenceCard label="Ads observed" field={adsObservedField} format={(v) => v.toLocaleString("en-US")} />
        <IntelligenceCard label="Product matching" field={data.productMatching} format={() => ""} />
        <div className="rounded-xl border border-line-soft bg-surface p-5">
          <span className="font-mono text-[10.5px] uppercase tracking-wider text-muted-dim">Last checked</span>
          <div className="mt-3.5 font-display text-lg font-bold tracking-tight">
            {data.lastCheckedAt ? formatRelativeTime(data.lastCheckedAt) : "Not yet"}
          </div>
          <div className="mt-1.5 font-mono text-[11px] text-muted-dim">Google Ads Transparency Center</div>
        </div>
      </div>

      {activity && (
        <div className="mt-4">
          {activity.hasEnoughHistory ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Stat label={`New · ${activity.windowDays}d`} value={`+${activity.adsDetected}`} />
              <Stat label={`Removed · ${activity.windowDays}d`} value={`-${activity.adsRemoved}`} />
              <Stat label="Continuously active" value={String(activity.continuouslyObservedAdCount)} />
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-line px-5 py-7 text-center">
              <p className="font-display text-base font-bold">Advertising monitoring started</p>
              <p className="mt-1.5 font-mono text-xs text-muted-dim">
                Historical advertising trends will appear after the next check.
              </p>
            </div>
          )}
        </div>
      )}

      {ads.status === "OBSERVED" && ads.value.length > 0 && (
        <ul className="mt-4 space-y-2">
          {ads.value.map((a) => (
            <li
              key={a.externalAdId}
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border border-line-soft bg-surface px-4 py-3"
            >
              <div>
                <span className="text-sm text-paper">{a.advertiserName ?? "Unknown advertiser"}</span>
                <span className="ml-2 font-mono text-[11px] text-muted-dim">
                  Google{a.format ? ` · ${a.format}` : ""}
                  {a.regions && a.regions.length > 0 ? ` · ${a.regions.join(", ")}` : ""}
                </span>
              </div>
              <span className="flex-none font-mono text-[10.5px] text-muted-dim">
                since {formatRelativeTime(a.firstSeenAt)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {ads.status === "OBSERVED" && ads.value.length === 0 && (
        <div className="mt-4 rounded-xl border border-dashed border-line px-5 py-7 text-center">
          <p className="font-display text-base font-bold">No advertising activity observed</p>
          <p className="mt-1.5 font-mono text-xs text-muted-dim">
            The latest check found no matching ads in the sources we cover.
          </p>
        </div>
      )}
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
