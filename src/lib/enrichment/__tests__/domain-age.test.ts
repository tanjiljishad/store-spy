import { describe, expect, it, vi } from "vitest";
import { domainRegisteredAtField, firstArchivedAtField } from "../domain-age";

describe("domainRegisteredAtField / firstArchivedAtField", () => {
  it("is OBSERVED when the date is present", () => {
    const field = domainRegisteredAtField({ domainRegisteredAt: new Date("2020-01-01"), firstArchivedAt: null });
    expect(field.status).toBe("OBSERVED");
    if (field.status !== "OBSERVED") throw new Error("unreachable");
    expect(field.value.registeredAt).toBe(new Date("2020-01-01").toISOString());
  });

  it("is UNAVAILABLE with an honest reason when the date is null", () => {
    const field = domainRegisteredAtField({ domainRegisteredAt: null, firstArchivedAt: null });
    expect(field.status).toBe("UNAVAILABLE");
    if (field.status !== "UNAVAILABLE") throw new Error("unreachable");
    expect(field.reason.length).toBeGreaterThan(0);
  });

  it("firstArchivedAtField is independent of domainRegisteredAt", () => {
    const field = firstArchivedAtField({ domainRegisteredAt: null, firstArchivedAt: new Date("2019-06-01") });
    expect(field.status).toBe("OBSERVED");
    if (field.status !== "OBSERVED") throw new Error("unreachable");
    expect(field.value.firstArchivedAt).toBe(new Date("2019-06-01").toISOString());
  });
});

// enrichDomainAgeIfUnknown's own RDAP/Wayback parsing is exercised via a
// real (mocked-at-the-fetch-boundary) call, matching this codebase's
// convention elsewhere (crawl/shopify.ts's own tests) of testing the real
// exported function against a fake fetch rather than extracting parsing
// into separately-tested private helpers.
describe("enrichDomainAgeIfUnknown — fetch-boundary behavior", () => {
  function fakePrisma(initialDomainAgeCheckedAt: Date | null) {
    const updates: unknown[] = [];
    return {
      store: {
        findUnique: vi.fn().mockResolvedValue({ domainAgeCheckedAt: initialDomainAgeCheckedAt }),
        update: vi.fn().mockImplementation((args: unknown) => {
          updates.push(args);
          return Promise.resolve({});
        }),
      },
      _updates: updates,
    };
  }

  it("no-ops immediately (zero fetch calls) once domainAgeCheckedAt is already set", async () => {
    const prisma = fakePrisma(new Date("2026-01-01"));
    const fetchImpl = vi.fn();
    const { enrichDomainAgeIfUnknown } = await import("../domain-age");

    await enrichDomainAgeIfUnknown(prisma as never, "store1", "example.com", fetchImpl);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(prisma.store.update).not.toHaveBeenCalled();
  });

  it("persists parsed RDAP registration + Wayback earliest-snapshot dates on a first-ever lookup", async () => {
    const prisma = fakePrisma(null);
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url.includes("rdap.org")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              events: [
                { eventAction: "last changed", eventDate: "2025-01-01T00:00:00Z" },
                { eventAction: "registration", eventDate: "2020-03-15T00:00:00Z" },
              ],
            }),
        });
      }
      if (url.includes("web.archive.org")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              ["urlkey", "timestamp", "original"],
              ["com,example)/products.json", "20190601123045", "https://example.com/products.json"],
            ]),
        });
      }
      return Promise.reject(new Error("unexpected URL"));
    });
    const { enrichDomainAgeIfUnknown } = await import("../domain-age");

    await enrichDomainAgeIfUnknown(prisma as never, "store1", "example.com", fetchImpl);

    expect(prisma.store.update).toHaveBeenCalledTimes(1);
    const call = prisma._updates[0] as { data: { domainRegisteredAt: Date | null; firstArchivedAt: Date | null; domainAgeCheckedAt: Date } };
    expect(call.data.domainRegisteredAt?.toISOString()).toBe(new Date("2020-03-15T00:00:00Z").toISOString());
    expect(call.data.firstArchivedAt?.toISOString()).toBe(new Date("2019-06-01T12:30:45Z").toISOString());
    expect(call.data.domainAgeCheckedAt).toBeInstanceOf(Date);
  });

  it("persists domainAgeCheckedAt even when both lookups find nothing, so it never retries forever", async () => {
    const prisma = fakePrisma(null);
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, json: () => Promise.resolve(null) });
    const { enrichDomainAgeIfUnknown } = await import("../domain-age");

    await enrichDomainAgeIfUnknown(prisma as never, "store1", "example.com", fetchImpl);

    expect(prisma.store.update).toHaveBeenCalledTimes(1);
    const call = prisma._updates[0] as { data: { domainRegisteredAt: Date | null; firstArchivedAt: Date | null; domainAgeCheckedAt: Date } };
    expect(call.data.domainRegisteredAt).toBeNull();
    expect(call.data.firstArchivedAt).toBeNull();
    expect(call.data.domainAgeCheckedAt).toBeInstanceOf(Date);
  });

  it("one vendor throwing does not prevent the other's result from being recorded", async () => {
    const prisma = fakePrisma(null);
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url.includes("rdap.org")) return Promise.reject(new Error("RDAP is down"));
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve([
            ["urlkey", "timestamp", "original"],
            ["com,example)/products.json", "20190601123045", "https://example.com/products.json"],
          ]),
      });
    });
    const { enrichDomainAgeIfUnknown } = await import("../domain-age");

    await enrichDomainAgeIfUnknown(prisma as never, "store1", "example.com", fetchImpl);

    const call = prisma._updates[0] as { data: { domainRegisteredAt: Date | null; firstArchivedAt: Date | null } };
    expect(call.data.domainRegisteredAt).toBeNull();
    expect(call.data.firstArchivedAt).not.toBeNull();
  });

  it("never throws even when everything fails", async () => {
    const prisma = fakePrisma(null);
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    const { enrichDomainAgeIfUnknown } = await import("../domain-age");

    await expect(enrichDomainAgeIfUnknown(prisma as never, "store1", "example.com", fetchImpl)).resolves.not.toThrow();
  });
});
