import { createHash } from "node:crypto";

/**
 * Shopify returns prices as strings ("79.00", "1,299.00", sometimes "79").
 * Everything downstream works in integer minor units. Never let a float
 * near a price — 0.1 + 0.2 problems show up as phantom PRICE_DROP events.
 */
export function toCents(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;

  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return null;
    return Math.round(raw * 100);
  }

  const cleaned = raw.replace(/[^0-9.\-]/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return null;

  const value = Number.parseFloat(cleaned);
  if (!Number.isFinite(value)) return null;

  return Math.round(value * 100);
}

export function formatCents(cents: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

/** Signed fractional change. Returns null when the baseline is zero/unknown. */
export function pctChange(from: number, to: number): number | null {
  if (from === 0) return null;
  return (to - from) / from;
}

/**
 * Deterministic JSON: object keys sorted recursively, so two structurally
 * identical payloads always hash identically regardless of key order from
 * the upstream API.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function hashOf(value: unknown): string {
  return sha256(canonicalJson(value));
}
