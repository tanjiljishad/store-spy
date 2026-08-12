import { describe, expect, it } from "vitest";
import { computeBestsellerSignal, MIN_OBSERVATIONS_FOR_MOMENTUM, type RankObservation } from "../bestseller";

const D = (s: string) => new Date(s);

function obs(rank: number | null, capturedAt: string, crawlId: string): RankObservation {
  return { rank, capturedAt: D(capturedAt), crawlId };
}

describe("computeBestsellerSignal — movement", () => {
  it("reports movement against the most recent distinct prior rank", () => {
    const observationsDesc = [obs(12, "2026-08-10", "c4"), obs(37, "2026-08-01", "c3")];
    const result = computeBestsellerSignal(12, observationsDesc);
    expect(result.movement).toEqual({ previousRank: 37, currentRank: 12, delta: 25 });
  });

  it("skips repeated identical rank observations to find the real prior value", () => {
    const observationsDesc = [obs(12, "2026-08-10", "c3"), obs(12, "2026-08-05", "c2"), obs(37, "2026-08-01", "c1")];
    const result = computeBestsellerSignal(12, observationsDesc);
    expect(result.movement).toEqual({ previousRank: 37, currentRank: 12, delta: 25 });
  });

  it("returns null movement when there is no prior distinct observation", () => {
    expect(computeBestsellerSignal(12, []).movement).toBeNull();
    expect(computeBestsellerSignal(12, [obs(12, "2026-08-10", "c1")]).movement).toBeNull();
  });

  it("returns null movement when currently unranked, even with prior history", () => {
    const result = computeBestsellerSignal(null, [obs(12, "2026-08-01", "c1")]);
    expect(result.movement).toBeNull();
  });

  it("a decline shows a negative delta", () => {
    const result = computeBestsellerSignal(40, [obs(40, "2026-08-10", "c2"), obs(10, "2026-08-01", "c1")]);
    expect(result.movement).toEqual({ previousRank: 10, currentRank: 40, delta: -30 });
  });
});

describe("computeBestsellerSignal — trajectory", () => {
  it("is chronological (oldest first) and excludes unranked (null) observations", () => {
    const observationsDesc = [
      obs(12, "2026-08-10", "c4"),
      obs(null, "2026-08-05", "c3"),
      obs(21, "2026-08-03", "c2"),
      obs(37, "2026-08-01", "c1"),
    ];
    const result = computeBestsellerSignal(12, observationsDesc);
    expect(result.trajectory.map((t) => t.rank)).toEqual([37, 21, 12]);
    expect(result.trajectory.map((t) => t.capturedAt.toISOString())).toEqual(
      [D("2026-08-01"), D("2026-08-03"), D("2026-08-10")].map((d) => d.toISOString()),
    );
  });

  it("never fabricates an observation that wasn't actually stored", () => {
    const result = computeBestsellerSignal(12, [obs(12, "2026-08-10", "c1")]);
    expect(result.trajectory).toHaveLength(1);
  });
});

describe("computeBestsellerSignal — momentum gating", () => {
  it("is null below MIN_OBSERVATIONS_FOR_MOMENTUM ranked observations", () => {
    const observationsDesc = Array.from({ length: MIN_OBSERVATIONS_FOR_MOMENTUM - 1 }, (_, i) =>
      obs(50 - i * 5, `2026-08-${10 - i}`, `c${i}`),
    );
    const result = computeBestsellerSignal(observationsDesc[0].rank, observationsDesc);
    expect(result.momentum).toBeNull();
  });

  it("is null below MIN_CRAWLS_FOR_MOMENTUM distinct crawls, even with enough snapshot rows", () => {
    // 4 ranked observations but only 2 distinct crawls behind them.
    const observationsDesc = [
      obs(10, "2026-08-10T02:00:00Z", "c2"),
      obs(15, "2026-08-10T01:00:00Z", "c2"),
      obs(20, "2026-08-01T02:00:00Z", "c1"),
      obs(25, "2026-08-01T01:00:00Z", "c1"),
    ];
    const result = computeBestsellerSignal(10, observationsDesc);
    expect(result.momentum).toBeNull();
  });

  it("reports IMPROVING for a clean, monotonic rank improvement across enough crawls", () => {
    const observationsDesc = [obs(12, "2026-08-10", "c4"), obs(21, "2026-08-08", "c3"), obs(37, "2026-08-05", "c2"), obs(55, "2026-08-01", "c1")];
    const result = computeBestsellerSignal(12, observationsDesc);
    expect(result.momentum).toBe("IMPROVING");
  });

  it("reports DECLINING for a clean, monotonic rank decline", () => {
    const observationsDesc = [obs(55, "2026-08-10", "c4"), obs(37, "2026-08-08", "c3"), obs(21, "2026-08-05", "c2"), obs(12, "2026-08-01", "c1")];
    const result = computeBestsellerSignal(55, observationsDesc);
    expect(result.momentum).toBe("DECLINING");
  });

  it("reports STABLE when the rank hasn't moved across enough observations", () => {
    const observationsDesc = [obs(20, "2026-08-10", "c4"), obs(20, "2026-08-08", "c3"), obs(20, "2026-08-05", "c2"), obs(20, "2026-08-01", "c1")];
    const result = computeBestsellerSignal(20, observationsDesc);
    expect(result.momentum).toBe("STABLE");
  });

  it("returns null (not a fabricated direction) when the trend reverses", () => {
    // #80 -> #55 -> #37 -> #55 : improved then reversed. Not a clean trend.
    const observationsDesc = [obs(55, "2026-08-10", "c4"), obs(37, "2026-08-08", "c3"), obs(55, "2026-08-05", "c2"), obs(80, "2026-08-01", "c1")];
    const result = computeBestsellerSignal(55, observationsDesc);
    expect(result.momentum).toBeNull();
  });
});
