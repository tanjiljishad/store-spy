import { describe, expect, it } from "vitest";
import { computeFunnelSteps, type FunnelCounts } from "../funnel";

/** Prisma-free — pure rate math, no DB (npm test, not npm run test:integration). */
describe("computeFunnelSteps", () => {
  const windowStart = new Date("2026-08-01T00:00:00Z");
  const windowEnd = new Date("2026-08-08T00:00:00Z");

  it("computes conversion rate as a fraction of the previous step", () => {
    const counts: FunnelCounts = {
      windowStart,
      windowEnd,
      anonymousAnalyses: 100,
      signups: 20,
      firstAnalyses: 15,
      firstWatches: 10,
      firstPaidConversions: 2,
    };
    const steps = computeFunnelSteps(counts);
    expect(steps.map((s) => s.key)).toEqual(["anonymous_analysis", "signup", "first_analysis", "first_watch", "paid"]);
    expect(steps[0].conversionFromPrevious).toBeNull(); // first step has no "previous"
    expect(steps[1].conversionFromPrevious).toBeCloseTo(0.2, 5); // 20/100
    expect(steps[2].conversionFromPrevious).toBeCloseTo(0.75, 5); // 15/20
    expect(steps[3].conversionFromPrevious).toBeCloseTo(2 / 3, 5); // 10/15
    expect(steps[4].conversionFromPrevious).toBeCloseTo(0.2, 5); // 2/10
  });

  it("a zero-count previous step yields a null rate, not a divide-by-zero NaN or Infinity", () => {
    const counts: FunnelCounts = {
      windowStart,
      windowEnd,
      anonymousAnalyses: 0,
      signups: 0,
      firstAnalyses: 0,
      firstWatches: 0,
      firstPaidConversions: 0,
    };
    const steps = computeFunnelSteps(counts);
    for (const s of steps.slice(1)) {
      expect(s.conversionFromPrevious).toBeNull();
    }
  });
});
