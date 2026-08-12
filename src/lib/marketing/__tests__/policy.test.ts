import { describe, expect, it } from "vitest";
import { nextMarketingCollectionAfterFailure, nextMarketingCollectionAfterSuccess } from "../policy";

const NOW = new Date("2026-08-11T12:00:00Z");

describe("nextMarketingCollectionAfterSuccess", () => {
  it("schedules HOT stores daily", () => {
    const next = nextMarketingCollectionAfterSuccess("HOT", NOW);
    expect(next?.getTime()).toBe(NOW.getTime() + 24 * 60 * 60 * 1000);
  });

  it("never schedules DISABLED stores", () => {
    expect(nextMarketingCollectionAfterSuccess("DISABLED", NOW)).toBeNull();
  });

  it("orders cadence slowest-to-fastest across tiers consistently with HOT > WARM > COOL > COLD > DORMANT", () => {
    const hot = nextMarketingCollectionAfterSuccess("HOT", NOW)!.getTime();
    const warm = nextMarketingCollectionAfterSuccess("WARM", NOW)!.getTime();
    const cool = nextMarketingCollectionAfterSuccess("COOL", NOW)!.getTime();
    const cold = nextMarketingCollectionAfterSuccess("COLD", NOW)!.getTime();
    const dormant = nextMarketingCollectionAfterSuccess("DORMANT", NOW)!.getTime();
    expect(hot).toBeLessThan(warm);
    expect(warm).toBeLessThan(cool);
    expect(cool).toBeLessThan(cold);
    expect(cold).toBeLessThan(dormant);
  });
});

describe("nextMarketingCollectionAfterFailure", () => {
  it("pushes the next attempt forward by a flat delay", () => {
    const next = nextMarketingCollectionAfterFailure(NOW);
    expect(next.getTime()).toBeGreaterThan(NOW.getTime());
  });
});
