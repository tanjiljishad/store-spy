"use client";

import { useEffect, useState } from "react";
import { IntelligenceCard } from "@/components/dashboard/IntelligenceCard";
import { SectionLabel } from "@/components/dashboard/SectionLabel";
import { formatRelativeTime } from "@/lib/format-relative-time";
import {
  bestsellerDirectionFromMomentum,
  catalogDirectionFromSignals,
  deriveInterpretation,
} from "@/lib/intelligence/interpretation";

interface CatalogTrendPoint {
  at: string;
  size: number;
}
type CatalogTrend =
  | { status: "INSUFFICIENT_HISTORY"; realCrawlsAvailable: number }
  | {
      status: "OBSERVED";
      points: CatalogTrendPoint[];
      sampledFromCrawlCount: number;
      reconstructedFromLaunchDates: boolean;
    };

interface MixEntry {
  label: string;
  count: number;
}
type CatalogComposition =
  | { status: "UNAVAILABLE"; reason: string }
  | {
      status: "OBSERVED";
      priceSpread: { minCents: number; maxCents: number; medianCents: number; p25Cents: number; p75Cents: number };
      discountDepth: { discountedCount: number; totalCount: number; averageDiscountPercent: number | null };
      vendorMix: MixEntry[];
      productTypeMix: MixEntry[];
      productCount: number;
    };

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
  composition: CatalogComposition;
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

type ReviewObservationSignal =
  | {
      status: "OBSERVED";
      reviewCount: number;
      ratingValue: number | null;
      observedAt: string;
      sharedWithGroup: boolean;
      change: { previousCount: number; delta: number } | null;
    }
  | { status: "UNSUPPORTED" }
  | { status: "NOT_SAMPLED" };

type ReviewCoverageSummary =
  | { status: "OBSERVED"; sampledCount: number; observedCount: number }
  | { status: "UNSUPPORTED"; sampledCount: number }
  | { status: "NOT_SAMPLED" };

interface ProductHighlight {
  productId: string;
  handle: string;
  title: string;
  freshness: FreshnessSignal;
  bestseller: BestsellerSignal;
  reviewObservation: ReviewObservationSignal;
}

interface GrowthReport {
  domain: string;
  checkedAt: string;
  catalogGrowth: CatalogGrowthView;
  reviewInfrastructure: ReviewInfrastructureField;
  productHighlights: ProductHighlight[];
  reviewCoverage: ReviewCoverageSummary;
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
  /**
   * Sub-phase D: the dashboard Store Intelligence page's server component
   * already computes this exact data (report.growth/productIntelligence.
   * highlights/reviews.infrastructure) via the intelligence composer on
   * every render — pass it here to skip the redundant client-side /growth
   * round trip entirely. Omit it (FullReportView.tsx's SSE analyze-result
   * path has no server-composed report to seed from) to keep the original
   * fetch-on-mount behavior, unchanged.
   */
  initialData?: GrowthReport;
}

/**
 * Fetches /api/store/[domain]/growth — catalog growth, bestseller rank
 * movement, review infrastructure, and product freshness, all derived live
 * from Product/ProductStateSnapshot/Event/StoreEntity, never fabricated.
 * Bestseller-rank language never claims sales/revenue — see growth/bestseller.ts.
 */
export function GrowthIntelligence({ domain, initialData }: GrowthIntelligenceProps) {
  const [data, setData] = useState<GrowthReport | null>(initialData ?? null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (initialData) return; // already have it — no network request at all
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
  }, [domain, initialData]);

  if (failed) return null;
  if (!data) {
    return <p className="font-mono text-xs text-muted-dim">Loading growth signals…</p>;
  }

  // Sub-phase F: a real caller was found (dashboard/stores/[domain]/page.tsx)
  // omitting reviewCoverage from its hand-assembled initialData object,
  // crashing this entire page with "Cannot read properties of undefined
  // (reading 'status')". That specific call site is now fixed, but this
  // component must not depend on every future caller getting it right —
  // defaulting to the same NOT_SAMPLED state a genuinely never-sampled store
  // already renders safely, rather than assuming the field is always present.
  const {
    catalogGrowth,
    reviewInfrastructure,
    productHighlights,
    reviewCoverage = { status: "NOT_SAMPLED" },
  } = data;

  // Two independently-sourced, already-OBSERVED signals — see
  // lib/intelligence/interpretation.ts. Combined only when both genuinely
  // agree; otherwise this renders nothing (no fabricated middle ground).
  const interpretation = deriveInterpretation(
    catalogDirectionFromSignals(catalogGrowth.signals),
    bestsellerDirectionFromMomentum(productHighlights.map((p) => p.bestseller.momentum)),
  );

  return (
    <div>
      <SectionLabel>Catalog growth</SectionLabel>
      {catalogGrowth.hasEnoughHistory && (
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
        </>
      )}
      {catalogGrowth.trend.status === "OBSERVED" ? (
        <>
          <CatalogSparkline trend={catalogGrowth.trend} />
          {!catalogGrowth.hasEnoughHistory && (
            <p className="mt-2 font-mono text-[10.5px] text-muted-dim">
              Added/removed/restored counts will appear after one more real check of this store.
            </p>
          )}
        </>
      ) : (
        !catalogGrowth.hasEnoughHistory && (
          <div className="rounded-xl border border-dashed border-line px-5 py-7 text-center">
            <p className="font-display text-base font-bold">Not enough history yet</p>
            <p className="mt-1.5 font-mono text-xs text-muted-dim">
              This store&apos;s products didn&apos;t carry a usable launch date, so the catalog curve will build up
              from real checks instead.
            </p>
          </div>
        )
      )}
      <p className="mt-3 font-mono text-[10.5px] text-muted-dim">
        Observed catalog size from real crawl history — not a measure of sales or revenue. Catalog growth is not
        the same as business growth.
      </p>
      {interpretation && (
        <div className="mt-3 rounded-lg border border-line-soft bg-surface px-4 py-3">
          <p className="font-display text-sm font-bold tracking-tight">{interpretation.headline}</p>
          <p className="mt-1 font-mono text-[11px] leading-relaxed text-muted-dim">{interpretation.detail}</p>
        </div>
      )}

      <SectionLabel className="mt-8">Catalog composition</SectionLabel>
      <CatalogCompositionSection composition={catalogGrowth.composition} />

      <SectionLabel className="mt-8">Product visibility &amp; bestseller movement</SectionLabel>
      {productHighlights.length > 0 ? (
        <ul className="space-y-2">
          {productHighlights.map((p) => (
            <ProductHighlightRow key={p.productId} product={p} />
          ))}
        </ul>
      ) : (
        <div className="rounded-xl border border-dashed border-line px-5 py-7 text-center">
          <p className="font-display text-base font-bold">No ranked products yet</p>
          <p className="mt-1.5 font-mono text-xs text-muted-dim">
            This store doesn&apos;t currently expose a bestseller ranking we can track.
          </p>
        </div>
      )}

      <SectionLabel className="mt-8">Review infrastructure</SectionLabel>
      <ReviewInfrastructureCard field={reviewInfrastructure} />

      <SectionLabel className="mt-8">Review intelligence</SectionLabel>
      <ReviewCoverageCard coverage={reviewCoverage} />
    </div>
  );
}

function ReviewCoverageCard({ coverage }: { coverage: ReviewCoverageSummary }) {
  const tooltip =
    "This is storefront-published review data observed on sampled product pages. It does not represent independently verified total store reviews.";

  if (coverage.status === "NOT_SAMPLED") {
    return (
      <div className="rounded-xl border border-dashed border-line px-5 py-7 text-center" title={tooltip}>
        <p className="font-display text-base font-bold">Not observed</p>
        <p className="mt-1.5 font-mono text-xs text-muted-dim">
          Review activity is being collected from sampled product pages.
        </p>
      </div>
    );
  }

  if (coverage.status === "UNSUPPORTED") {
    return (
      <div className="rounded-xl border border-dashed border-line px-5 py-7 text-center" title={tooltip}>
        <p className="font-display text-base font-bold">Not observed</p>
        <p className="mt-1.5 font-mono text-xs text-muted-dim">
          No storefront review count was exposed on the {coverage.sampledCount} sampled product
          {coverage.sampledCount === 1 ? "" : "s"}.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-line-soft bg-surface p-5" title={tooltip}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10.5px] uppercase tracking-wider text-muted-dim">Sampled product coverage</span>
        <span className="flex-none rounded-sm border border-ok/35 px-[7px] py-0.5 font-mono text-[9.5px] font-semibold tracking-wider text-ok">
          Observed
        </span>
      </div>
      <div className="mt-3.5 font-display text-lg font-bold tracking-tight">
        Review counts observed on {coverage.observedCount} of {coverage.sampledCount} sampled products
      </div>
      <p className="mt-1.5 font-mono text-[11px] leading-relaxed text-muted-dim">
        A bounded sample of this store&apos;s own product pages, not the whole catalog and not a store-wide review
        total.
      </p>
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
        {trend.reconstructedFromLaunchDates
          ? "Reconstructed from each product's own listed launch date — refines into real check-to-check history as this store is monitored over time."
          : "Catalog size at each real check — gaps reflect actual crawl frequency for this store."}
      </p>
    </div>
  );
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function CatalogCompositionSection({ composition }: { composition: CatalogComposition }) {
  if (composition.status === "UNAVAILABLE") {
    return (
      <div className="rounded-xl border border-dashed border-line px-5 py-7 text-center">
        <p className="font-display text-base font-bold">Not available</p>
        <p className="mt-1.5 font-mono text-xs text-muted-dim">{composition.reason}</p>
      </div>
    );
  }

  const { priceSpread, discountDepth, vendorMix, productTypeMix } = composition;
  const discountedShare =
    discountDepth.totalCount > 0 ? Math.round((discountDepth.discountedCount / discountDepth.totalCount) * 100) : 0;

  return (
    <div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Lowest price" value={formatCents(priceSpread.minCents)} />
        <Stat label="Median price" value={formatCents(priceSpread.medianCents)} />
        <Stat label="Typical range" value={`${formatCents(priceSpread.p25Cents)}–${formatCents(priceSpread.p75Cents)}`} />
        <Stat label="Highest price" value={formatCents(priceSpread.maxCents)} />
      </div>

      <div className="mt-3 rounded-lg border border-line-soft bg-surface px-4 py-3">
        <span className="font-mono text-[10.5px] uppercase tracking-wider text-muted-dim">Discount depth</span>
        <div className="mt-1.5 font-display text-base font-bold tracking-tight">
          {discountDepth.discountedCount.toLocaleString("en-US")} of {discountDepth.totalCount.toLocaleString("en-US")} products
          discounted ({discountedShare}%)
        </div>
        {discountDepth.averageDiscountPercent !== null && (
          <div className="mt-1 font-mono text-[11px] text-muted-dim">
            Average markdown on discounted products: {discountDepth.averageDiscountPercent}%
          </div>
        )}
        <p className="mt-1.5 font-mono text-[10.5px] text-muted-dim">
          Based on each product&apos;s listed compare-at price — not verified against actual order data.
        </p>
      </div>

      {(vendorMix.length > 0 || productTypeMix.length > 0) && (
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {vendorMix.length > 0 && <MixCard label="Vendor mix" entries={vendorMix} />}
          {productTypeMix.length > 0 && <MixCard label="Product-type mix" entries={productTypeMix} />}
        </div>
      )}
    </div>
  );
}

function MixCard({ label, entries }: { label: string; entries: MixEntry[] }) {
  return (
    <div className="rounded-lg border border-line-soft bg-surface px-4 py-3">
      <span className="font-mono text-[10.5px] uppercase tracking-wider text-muted-dim">{label}</span>
      <ul className="mt-2 space-y-1">
        {entries.map((e) => (
          <li key={e.label} className="flex items-center justify-between gap-2 font-mono text-[11.5px]">
            <span className="truncate text-paper">{e.label}</span>
            <span className="flex-none text-muted-dim">{e.count}</span>
          </li>
        ))}
      </ul>
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
        <span
          title="Detected directly from storefront data."
          className="flex-none rounded-sm border border-ok/35 px-[7px] py-0.5 font-mono text-[9.5px] font-semibold tracking-wider text-ok"
        >
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
  // Same defensive default as reviewCoverage above, same reason.
  const { freshness, bestseller, reviewObservation = { status: "NOT_SAMPLED" } } = product;
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
      <ReviewObservationRow reviewObservation={reviewObservation} />
    </li>
  );
}

/**
 * Only renders for products actually included in this crawl's bounded
 * review sample (NOT_SAMPLED renders nothing at all — see Step 13: "Do not
 * overload every product row with review information"). UNSUPPORTED is
 * still worth a line: it distinguishes "we checked, nothing was there" from
 * silence, without implying zero reviews.
 */
function ReviewObservationRow({ reviewObservation }: { reviewObservation: ReviewObservationSignal }) {
  if (reviewObservation.status === "NOT_SAMPLED") return null;

  if (reviewObservation.status === "UNSUPPORTED") {
    return (
      <p
        className="mt-1.5 font-mono text-[10.5px] text-muted-dim"
        title="This is storefront-published review data observed on sampled product pages. It does not represent independently verified total store reviews."
      >
        Review count not observed on this product
      </p>
    );
  }

  const { reviewCount, ratingValue, change, sharedWithGroup } = reviewObservation;

  return (
    <div
      className="mt-1.5 rounded-md border border-line-soft bg-surface px-3 py-2"
      title="This is storefront-published review data observed on sampled product pages. It does not represent independently verified total store reviews."
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 font-mono text-[11px] text-muted-dim">
        <span className="font-display text-sm font-bold text-paper">
          {reviewCount.toLocaleString("en-US")} reviews observed
        </span>
        {ratingValue !== null && <span>{ratingValue.toFixed(1)}★</span>}
        {change && (
          <span>
            {change.delta > 0 ? "+" : ""}
            {change.delta.toLocaleString("en-US")} since previous observation
          </span>
        )}
      </div>
      {sharedWithGroup && (
        <p className="mt-1 font-mono text-[10px] text-muted-dim">
          Same count observed on other sampled variants of this product — likely a shared, not independent, total.
        </p>
      )}
    </div>
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
