import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { enrichDomainAgeIfUnknown } from "../domain-age";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL unset — run via `npm run test:integration`");
}
if (!/test/i.test(url)) {
  throw new Error(
    `Refusing to run: DATABASE_URL does not look like a test database (${url}). This suite TRUNCATEs every table.`,
  );
}

const prisma = new PrismaClient();

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(`TRUNCATE "Store" RESTART IDENTITY CASCADE`);
});

async function makeStore() {
  return prisma.store.create({ data: { domain: `age-${randomUUID().slice(0, 8)}.com`, platform: "SHOPIFY" } });
}

function fakeFetch() {
  return vi.fn().mockImplementation((rawUrl: string) => {
    if (rawUrl.includes("rdap.org")) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({ events: [{ eventAction: "registration", eventDate: "2021-05-01T00:00:00Z" }] }),
      });
    }
    return Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve([
          ["urlkey", "timestamp", "original"],
          ["x", "20200101000000", "y"],
        ]),
    });
  });
}

describe("enrichDomainAgeIfUnknown — real Postgres", () => {
  it("persists both dates and sets domainAgeCheckedAt on a real Store row", async () => {
    const store = await makeStore();
    await enrichDomainAgeIfUnknown(prisma, store.id, store.domain, fakeFetch());

    const updated = await prisma.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(updated.domainRegisteredAt?.toISOString()).toBe(new Date("2021-05-01T00:00:00Z").toISOString());
    expect(updated.firstArchivedAt?.toISOString()).toBe(new Date("2020-01-01T00:00:00Z").toISOString());
    expect(updated.domainAgeCheckedAt).not.toBeNull();
  });

  it("is idempotent: a second real call makes zero fetch calls and does not overwrite the first result", async () => {
    const store = await makeStore();
    const firstFetch = fakeFetch();
    await enrichDomainAgeIfUnknown(prisma, store.id, store.domain, firstFetch);
    const afterFirst = await prisma.store.findUniqueOrThrow({ where: { id: store.id } });

    const secondFetch = vi.fn();
    await enrichDomainAgeIfUnknown(prisma, store.id, store.domain, secondFetch);
    const afterSecond = await prisma.store.findUniqueOrThrow({ where: { id: store.id } });

    expect(secondFetch).not.toHaveBeenCalled();
    expect(afterSecond.domainRegisteredAt?.toISOString()).toBe(afterFirst.domainRegisteredAt?.toISOString());
    expect(afterSecond.domainAgeCheckedAt?.toISOString()).toBe(afterFirst.domainAgeCheckedAt?.toISOString());
  });

  it("a nonexistent storeId is a safe no-op, never a crash", async () => {
    await expect(enrichDomainAgeIfUnknown(prisma, "does-not-exist", "example.com", fakeFetch())).resolves.not.toThrow();
  });
});
