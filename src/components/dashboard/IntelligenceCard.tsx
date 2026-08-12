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

export interface IntelligenceCardProps<T> {
  label: string;
  field: IntelligenceField<T>;
  format: (value: T) => string;
}

/**
 * The one place that renders an IntelligenceField — every card on the
 * Store Intelligence page that shows observed/estimated/inferred/
 * unavailable data goes through this, so the epistemic-status badge can
 * never be forgotten or rendered inconsistently between sections.
 */
export function IntelligenceCard<T>({ label, field, format }: IntelligenceCardProps<T>) {
  return (
    <div className="rounded-xl border border-line-soft bg-surface p-5">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10.5px] uppercase tracking-wider text-muted-dim">{label}</span>
        <span className={`flex-none rounded-sm border px-[7px] py-0.5 font-mono text-[9.5px] font-semibold tracking-wider ${STATUS_CLASS[field.status]}`}>
          {STATUS_LABEL[field.status]}
        </span>
      </div>
      {field.status === "UNAVAILABLE" ? (
        <>
          <div className="mt-3.5 font-display text-lg font-bold tracking-tight text-muted-dim">Not available yet</div>
          <div className="mt-1.5 font-mono text-[11.5px] leading-relaxed text-muted-dim">{field.reason}</div>
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
