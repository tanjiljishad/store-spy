/**
 * The epistemic-status wrapper every piece of store intelligence must be
 * expressed through (Milestone 3 spec: "never present an estimate as an
 * observed fact"). Four states, no fifth "locked" state — Milestone 3
 * retires the old `{ locked: true }` paywall contract entirely. A field
 * that isn't built yet is UNAVAILABLE with an honest reason, not a tease.
 */
export type FieldStatus = "OBSERVED" | "ESTIMATED" | "INFERRED" | "UNAVAILABLE";
export type Confidence = "LOW" | "MEDIUM" | "HIGH";

export interface ObservedField<T> {
  status: "OBSERVED";
  value: T;
}
export interface EstimatedField<T> {
  status: "ESTIMATED";
  value: T;
  confidence: Confidence;
  methodology: string;
}
export interface InferredField<T> {
  status: "INFERRED";
  value: T;
  confidence: Confidence;
}
export interface UnavailableField {
  status: "UNAVAILABLE";
  reason: string;
}

export type IntelligenceField<T> = ObservedField<T> | EstimatedField<T> | InferredField<T> | UnavailableField;

export function observed<T>(value: T): ObservedField<T> {
  return { status: "OBSERVED", value };
}
export function unavailable(reason: string): UnavailableField {
  return { status: "UNAVAILABLE", reason };
}
