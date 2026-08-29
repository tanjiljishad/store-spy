import { afterEach, describe, expect, it, vi } from "vitest";

const queryRaw = vi.fn();
vi.mock("@/lib/db/prisma", () => ({ prisma: { $queryRaw: (...args: unknown[]) => queryRaw(...args) } }));

const { GET } = await import("../route");

afterEach(() => queryRaw.mockReset());

describe("GET /api/health", () => {
  it("200 { status: ok, db: ok } when SELECT 1 succeeds", async () => {
    queryRaw.mockResolvedValueOnce([{ "?column?": 1 }]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", db: "ok" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("503 { status: degraded, db: down } when the DB query rejects", async () => {
    queryRaw.mockRejectedValueOnce(new Error("connection refused"));
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "degraded", db: "down" });
  });

  it("503 when the DB query hangs past the timeout — a fast fail, not a hang", async () => {
    queryRaw.mockReturnValueOnce(new Promise(() => {})); // never resolves
    const start = Date.now();
    const res = await GET();
    expect(res.status).toBe(503);
    expect(Date.now() - start).toBeLessThan(3000); // the 2s DB_TIMEOUT_MS + slack, not indefinite
  });
});
