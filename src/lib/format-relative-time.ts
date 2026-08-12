/** Small hand-rolled relative-time formatter — not worth a date library for "2 hours ago" / "in 22 hours". */
export function formatRelativeTime(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "never";
  const target = new Date(iso);
  const diffMs = target.getTime() - now.getTime();
  const future = diffMs > 0;
  const abs = Math.abs(diffMs);

  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  let value: number;
  let unit: string;
  if (abs < MIN) {
    return future ? "in a moment" : "just now";
  } else if (abs < HOUR) {
    value = Math.round(abs / MIN);
    unit = "minute";
  } else if (abs < DAY) {
    value = Math.round(abs / HOUR);
    unit = "hour";
  } else {
    value = Math.round(abs / DAY);
    unit = "day";
  }
  const plural = value === 1 ? unit : `${unit}s`;
  return future ? `in ${value} ${plural}` : `${value} ${plural} ago`;
}
