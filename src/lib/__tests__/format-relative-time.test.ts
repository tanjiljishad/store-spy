import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "../format-relative-time";

const NOW = new Date("2026-08-11T12:00:00Z");

describe("formatRelativeTime", () => {
  it("returns 'never' for null", () => {
    expect(formatRelativeTime(null, NOW)).toBe("never");
  });

  it("formats recent past as 'just now'", () => {
    expect(formatRelativeTime(new Date(NOW.getTime() - 30_000).toISOString(), NOW)).toBe("just now");
  });

  it("formats minutes/hours/days ago", () => {
    expect(formatRelativeTime(new Date(NOW.getTime() - 5 * 60_000).toISOString(), NOW)).toBe("5 minutes ago");
    expect(formatRelativeTime(new Date(NOW.getTime() - 2 * 3_600_000).toISOString(), NOW)).toBe("2 hours ago");
    expect(formatRelativeTime(new Date(NOW.getTime() - 3 * 86_400_000).toISOString(), NOW)).toBe("3 days ago");
  });

  it("formats future times with 'in'", () => {
    expect(formatRelativeTime(new Date(NOW.getTime() + 22 * 3_600_000).toISOString(), NOW)).toBe("in 22 hours");
    expect(formatRelativeTime(new Date(NOW.getTime() + 30 * 86_400_000).toISOString(), NOW)).toBe("in 30 days");
  });

  it("singularizes a single unit", () => {
    expect(formatRelativeTime(new Date(NOW.getTime() - 3_600_000).toISOString(), NOW)).toBe("1 hour ago");
    expect(formatRelativeTime(new Date(NOW.getTime() + 86_400_000).toISOString(), NOW)).toBe("in 1 day");
  });
});
