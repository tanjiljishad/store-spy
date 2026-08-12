"use client";

import { useEffect, useState } from "react";
import { IntelligenceCard } from "@/components/dashboard/IntelligenceCard";
import { formatRelativeTime } from "@/lib/format-relative-time";

interface CatalogTrendPoint {
  at: string;
  size: number;
}
type CatalogTrend =
  | { status: "INSUFFICIENT_HISTORY"; realCrawlsAvailable: number }
  | { status: "OBSERVED"; points: CatalogTrendPoint[]; sampledFromCrawlCount: number };

interface CatalogGrowthView {
  windowDays: number;
  productsAdded: number;
  productsRemoved: number;
  productsRestored: number;
  productCountDelta: number | null;
  currentProductCount: number;
  hasEnoughHistory: boolean;
  signals: Array<{ kind: string; detail: string }>;
  trend: CatalogTrend;
}

interface ReviewInfrastructureEntry {
  key: string;
  status: "ACTIVE" | "MISSING" | "REMOVED";
  firstSeenAt: string;
  lastSeenAt: string;
}
type ReviewInfrastructureField =
  | { status: "OBSERVED"; value: ReviewInfrastructureEntry[] }
  | { status: "UNAVAILABLE"; reason: string };

type PersistenceResult =
  | { status: "INSUFFICIENT_HISTORY"; realCrawlsAvailable: number; storeRealCrawlCount: number }
  | { status: "OBSERVED"; observedActiveCount: number; windowCrawlCount: number; ratio: number };

interface FreshnessSignal {
  label: "NEW" | "ESTABLISHED" | "RECENTLY_MISSING" | "INSUFFICIENT_HISTORY";
  persistence: PersistenceResult;
}

interface BestsellerSignal {
  currentRank: number | null;
  trajectory: Array<{ capturedAt: string; rank: number }>;
  movement: { previousRank: number; currentRank: number; delta: number } | null;
  momentum: "IMPROVING" | "DECLINING" | "STABLE" | null;
}

interface ProductHighlight {
  productId: string;
  handle: string;
  title: string;
  freshness: FreshnessSignal;
  bestseller: BestsellerSignal;
}

interface GrowthReport {
  domain: string;
  checkedAt: string;
  catalogGrowth: CatalogGrowthView;
  reviewInfrastructure: ReviewInfrastructureField;
  productHighlights: ProductHighlight[];
}

const REVIEW_APP_LABELS: Record<string, string> = {
  judgeme: "Judge.me",
  yotpo: "Yotpo",
  loox: "Loox",
  stamped: "Stamped.io",
  okendo: "Okendo",
};

const FRESHNESS_LABEL: Record<FreshnessSignal["label"], string> = {
  NEW: "🆕 New",
  ESTABLISHED: "● Established",
  RECENTLY_MISSING: "○ Recently missing",
  INSUFFICIENT_HISTORY: "Insufficient history",
};

export interface GrowthIntelligenceProps {
  domain: string;
}

/**
 * Fetches /api/store/[domain]/growth — catalog growth, bestseller rank
 * movement, review infrastructure, and product freshness, all derived live
 * from Product/ProductStateSnapshot/Event/StoreEntity, never fabricated.
 * Bestseller-rank language never claims sales/revenue — see growth/bestseller.ts.
 */
export function GrowthIntelligence({ domain }: GrowthIntelligenceProps) {
  const [data, setData] = useState<GrowthReport | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/store/${encodeURIComponent(domain)}/growth`)
      .then((r) => (r.ok ? (r.json() as Promise<GrowthReport>) : Promise.reject(new Error(String(r.status)))))
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
    return <p className="font-mono text-xs text-muted-dim">Loading growth signals…</p>;
  }

  const { catalogGrowth, reviewInfrastructure, productHighlights } = data;

  return (
    <div>
      {catalogGrowth.hasEnoughHistory ? (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label={`Added · ${catalogGrowth.windowDays}d`} value={`+${catalogGrowth.productsAdded}`} />
            <Stat label={`Removed · ${catalogGrowth.windowDays}d`} value={`-${catalogGrowth.productsRemoved}`} />
            <Stat label={`Restored · ${catalogGrowth.windowDays}d`} value={`+${catalogGrowth.productsRestored}`} />
            <Stat
              label="Net change"
              value={catalogGrowth.productCountDelta === null ? "—" : `${catalogGrowth.productCountDelta > 0 ? "+" : ""}${catalogGrowth.productCountDelta}`}
            />
            <Stat label="Catalog size" value={catalogGrowth.currentProductCount.toLocaleString("en-US")} />
          </div>
          {catalogGrowth.signals.length > 0 && (
            <ul className="mt-3 flex flex-wrap gap-2">
              {catalogGrowth.signals.map((s) => (
                <li key={s.kind} className="rounded-full border border-line-soft px-3 py-1.5 font-mono text-[11px] text-muted">
                  {s.detail}
                </li>
              ))}
            </ul>
          )}
          <CatalogSparkline trend={catalogGrowth.trend} />
        </>
      ) : (
        <div className="rounded-xl border border-dashed border-line px-5 py-7 text-center">
          <p className="font-display text-base font-bold">Not enough history yet</p>
          <p className="mt-1.5 font-mono text-xs text-muted-dim">
            Catalog growth trends will appear after a second real check of this store.
          </p>
        </div>
      )}
      <p className="mt-3 font-mono text-[10.5px] text-muted-dim">
        Observed catalog size from real crawl history — not a measure of sales or revenue.
      </p>

      <div className="mt-6">
        <ReviewInfrastructureCard field={reviewInfrastructure} />
      </div>

      {productHighlights.length > 0 && (
        <div className="mt-6">
          <ul className="space-y-2">
            {productHighlights.map((p) => (
              <ProductHighlightRow key={p.productId} product={p} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function CatalogSparkline({ trend }: { trend: CatalogTrend }) {
  if (trend.status !== "OBSERVED" || trend.points.length < 2) return null;
  const max = Math.max(...trend.points.map((p) => p.size), 1);
  const min = Math.min(...trend.points.map((p) => p.size));
  const span = Math.max(max - min, 1);

  return (
    <div className="mt-4 rounded-xl border border-line-soft bg-surface p-4">
      <div className="flex h-16 items-end gap-1">
        {trend.points.map((p, i) => (
          <div
            key={i}
            title={`${new Date(p.at).toLocaleDateString()}: ${p.size} products`}
            className="min-w-[3px] flex-1 rounded-t-sm bg-sig-new/70"
            style={{ height: `${Math.max(((p.size - min) / span) * 100, 6)}%` }}
          />
        ))}
      </div>
      <div className="mt-2 flex justify-between font-mono text-[10px] text-muted-dim">
        <span>{new Date(trend.points[0].at).toLocaleDateString()}</span>
        <span>{new Date(trend.points[trend.points.length - 1].at).toLocaleDateString()}</span>
      </div>
      <p className="mt-1 font-mono text-[10px] text-muted-dim">
        Catalog size at each real check — gaps reflect actual crawl frequency for this store.
      </p>
    </div>
  );
}

function ReviewInfrastructureCard({ field }: { field: ReviewInfrastructureField }) {
  if (field.status === "UNAVAILABLE") {
    return <IntelligenceCard label="Review infrastructure" field={field} format={() => ""} />;
  }

  const active = field.value.filter((e) => e.status === "ACTIVE");

  return (
    <div className="rounded-xl border border-line-soft bg-surface p-5">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10.5px] uppercase tracking-wider text-muted-dim">Review infrastructure</span>
        <span className="flex-none rounded-sm border border-ok/35 px-[7px] py-0.5 font-mono text-[9.5px] font-semibold tracking-wider text-ok">
          Observed
        </span>
      </div>
      {active.length === 0 ? (
        <>
          <div className="mt-3.5 font-display text-lg font-bold tracking-tight text-muted-dim">None detected</div>
          <div className="mt-1.5 font-mono text-[11.5px] leading-relaxed text-muted-dim">
            No known review-collection app was found on this storefront.
          </div>
        </>
      ) : (
        <>
          <div className="mt-3.5 flex flex-wrap gap-2">
            {active.map((e) => (
              <span key={e.key} className="rounded-md border border-line px-3 py-1.5 font-mono text-[12.5px] text-paper">
                {REVIEW_APP_LABELS[e.key] ?? e.key} · since {formatRelativeTime(e.firstSeenAt)}
              </span>
            ))}
          </div>
          <div className="mt-2 font-mono text-[11px] leading-relaxed text-muted-dim">
            Indicates a review collection system is installed — not a measure of review volume, authenticity, or
            customer sentiment.
          </div>
        </>
      )}
    </div>
  );
}

function persistenceLabel(persistence: PersistenceResult): string | null {
  if (persistence.status !== "OBSERVED") return null;
  return `seen in ${persistence.observedActiveCount}/${persistence.windowCrawlCount} checks`;
}

function ProductHighlightRow({ product }: { product: ProductHighlight }) {
  const { freshness, bestseller } = product;
  const persistenceText = persistenceLabel(freshness.persistence);

  return (
    <li className="rounded-lg border border-line-soft bg-surface px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="text-sm text-paper">{product.title}</span>
        <span className="font-mono text-[10.5px] text-muted-dim">{FRESHNESS_LABEL[freshness.label]}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-muted-dim">
        {bestseller.currentRank !== null && <span>Bestseller rank #{bestseller.currentRank + 1}</span>}
        {bestseller.movement && (
          <span>
            {bestseller.movement.delta > 0 ? "↑" : bestseller.movement.delta < 0 ? "↓" : "="} #
            {bestseller.movement.previousRank + 1} → #{bestseller.movement.currentRank + 1}
          </span>
        )}
        {bestseller.momentum && <span>Bestseller momentum: {bestseller.momentum.toLowerCase()}</span>}
        {persistenceText && <span>{persistenceText}</span>}
      </div>
      {bestseller.movement && (
        <p className="mt-1 font-mono text-[10px] text-muted-dim">
          Based on Shopify&apos;s own bestseller ranking — not independently verified sales data.
        </p>
      )}
      <TrajectorySparkline trajectory={bestseller.trajectory} />
    </li>
  );
}

/**
 * Same CSS-bar construction as CatalogSparkline, applied to rank history
 * instead of catalog size — deliberately the same visual language, not a
 * new chart component. Rank is inverted (lower number = better position),
 * so bar height is drawn from the WORST rank in the window, making an
 * improving trend read as bars growing taller left-to-right.
 *
 * Renders nothing below 2 real observations — never a fabricated single-point
 * "trend," matching every other insufficient-history rule in this file.
 */
function TrajectorySparkline({ trajectory }: { trajectory: Array<{ capturedAt: string; rank: number }> }) {
  if (trajectory.length < 2) return null;
  const ranks = trajectory.map((t) => t.rank);
  const best = Math.min(...ranks); // lower rank number = better position
  const worst = Math.max(...ranks);
  const span = Math.max(worst - best, 1);

  return (
    <div className="mt-2 rounded-lg border border-line-soft bg-surface p-3">
      <div className="flex h-10 items-end gap-1">
        {trajectory.map((t, i) => (
          <div
            key={i}
            title={`${new Date(t.capturedAt).toLocaleDateString()}: #${t.rank + 1}`}
            className="min-w-[3px] flex-1 rounded-t-sm bg-sig-new/70"
            style={{ height: `${Math.max(((worst - t.rank) / span) * 100, 6)}%` }}
          />
        ))}
      </div>
      <div className="mt-1.5 flex justify-between font-mono text-[9.5px] text-muted-dim">
        <span>#{trajectory[0].rank + 1}</span>
        <span>#{trajectory[trajectory.length - 1].rank + 1}</span>
      </div>
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
