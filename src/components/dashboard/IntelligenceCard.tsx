import type { IntelligenceField } from "@/lib/analysis/report-contract";

const STATUS_LABEL: Record<IntelligenceField<unknown>["status"], string> = {
  OBSERVED: "Observed",
  ESTIMATED: "Estimated",
  INFERRED: "Inferred",
  UNAVAILABLE: "Unavailable",
};
const STATUS_CLASS: Record<IntelligenceField<unknown>["status"], string> = {
  OBSERVED: "text-ok border-ok/35",
  ESTIMATED: "text-sig-price border-sig-price/35",
  INFERRED: "text-sig-new border-sig-new/35",
  UNAVAILABLE: "text-muted-dim border-line",
};
/**
 * Native-tooltip copy for each epistemic status — a plain `title` attribute,
 * zero new visual footprint (no badge redesign, no banner), satisfying
 * "visible, compact, consistent, non-alarming" by relying on the browser's
 * own hover/focus tooltip rather than inventing UI for it.
 */
const STATUS_EXPLANATION: Record<IntelligenceField<unknown>["status"], string> = {
  OBSERVED: "Detected directly from storefront data.",
  ESTIMATED: "Derived from observed signals, not measured directly.",
  INFERRED: "Strong indication from observed signals, but not directly verified.",
  UNAVAILABLE: "The available data does not support a reliable answer.",
};

export interface IntelligenceCardProps<T> {
  label: string;
  field: IntelligenceField<T>;
  format: (value: T) => string;
  /**
   * Optional, UNAVAILABLE-only: what the store's available data DOES show
   * instead of the unavailable metric — e.g. "Detected instead: catalog
   * size and average price." Renders as one more small line under the
   * reason, only when provided; every existing call site that omits it
   * renders exactly as before.
   */
  unavailableHint?: string;
}

/**
 * The one place that renders an IntelligenceField — every card on the
 * Store Intelligence page that shows observed/estimated/inferred/
 * unavailable data goes through this, so the epistemic-status badge can
 * never be forgotten or rendered inconsistently between sections.
 */
export function IntelligenceCard<T>({ label, field, format, unavailableHint }: IntelligenceCardProps<T>) {
  return (
    <div className="rounded-xl border border-line-soft bg-surface p-5">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10.5px] uppercase tracking-wider text-muted-dim">{label}</span>
        <span
          title={STATUS_EXPLANATION[field.status]}
          className={`flex-none rounded-sm border px-[7px] py-0.5 font-mono text-[9.5px] font-semibold tracking-wider ${STATUS_CLASS[field.status]}`}
        >
          {STATUS_LABEL[field.status]}
        </span>
      </div>
      {field.status === "UNAVAILABLE" ? (
        <>
          <div className="mt-3.5 font-display text-lg font-bold tracking-tight text-muted-dim">
            {field.permanent ? "Not available" : "Not available yet"}
          </div>
          <div className="mt-1.5 font-mono text-[11.5px] leading-relaxed text-muted-dim">{field.reason}</div>
          {unavailableHint && (
            <div className="mt-1.5 font-mono text-[11px] leading-relaxed text-muted">{unavailableHint}</div>
          )}
        </>
      ) : (
        <>
          <div className="mt-3.5 font-display text-2xl font-bold tracking-tight">{format(field.value)}</div>
          {(field.status === "ESTIMATED" || field.status === "INFERRED") && (
            <div className="mt-1.5 font-mono text-[11px] text-muted-dim">
              Confidence: {field.confidence}
              {field.status === "ESTIMATED" && <> · {field.methodology}</>}
            </div>
          )}
        </>
      )}
    </div>
  );
}
