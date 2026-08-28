import { describe, expect, it } from "vitest";
import { explicitSearchPathProblems, liveSearchPathProblem, schemaParamProblem } from "../search-path";

const GOOD = "postgresql://app:app@localhost:5433/ecom_intel_test?options=-c%20search_path%3Dstore_spy%2Cpublic";

describe("schemaParamProblem", () => {
  it("clean when there is no ?schema=", () => {
    expect(schemaParamProblem(GOOD)).toBeNull();
  });

  it("flags ?schema=public (the footgun)", () => {
    const p = schemaParamProblem("postgresql://app:app@localhost:5433/db?schema=public");
    expect(p).toMatch(/schema=public/);
    expect(p).toMatch(/options/);
  });

  it("flags any ?schema=, not just public", () => {
    expect(schemaParamProblem("postgresql://app:app@localhost:5433/db?schema=store_spy")).toMatch(/schema=store_spy/);
  });

  it("null (not a throw) for an unset or unparseable URL — a different, louder failure", () => {
    expect(schemaParamProblem(undefined)).toBeNull();
    expect(schemaParamProblem("::::not a url")).toBeNull();
  });
});

describe("explicitSearchPathProblems", () => {
  it("clean for the canonical options URL", () => {
    expect(explicitSearchPathProblems(GOOD)).toEqual([]);
  });

  it("clean when search_path has extra trailing schemas after store_spy,public", () => {
    expect(
      explicitSearchPathProblems("postgresql://a:b@h:5433/d?options=-c%20search_path%3Dstore_spy%2Cpublic%2Cextra"),
    ).toEqual([]);
  });

  it("rejects ?schema= outright", () => {
    expect(explicitSearchPathProblems("postgresql://a:b@h:5433/d?schema=public")[0]).toMatch(/schema=public/);
  });

  it("flags a URL with no options/search_path at all", () => {
    expect(explicitSearchPathProblems("postgresql://a:b@h:5433/d")[0]).toMatch(/no `options/);
  });

  it("flags wrong order (public before store_spy)", () => {
    const p = explicitSearchPathProblems("postgresql://a:b@h:5433/d?options=-c%20search_path%3Dpublic%2Cstore_spy");
    expect(p.join(" ")).toMatch(/"store_spy" must be first/);
  });

  it("flags store_spy present but public missing", () => {
    const p = explicitSearchPathProblems("postgresql://a:b@h:5433/d?options=-c%20search_path%3Dstore_spy");
    expect(p.join(" ")).toMatch(/"public" must also be present/);
  });

  it("unset URL", () => {
    expect(explicitSearchPathProblems(undefined)).toEqual(["DATABASE_URL is unset"]);
  });
});

describe("liveSearchPathProblem", () => {
  const client = (searchPath: string) => ({
    $queryRawUnsafe: async () => [{ search_path: searchPath }],
  });

  it("clean for 'store_spy, public'", async () => {
    expect(await liveSearchPathProblem(client("store_spy, public"))).toBeNull();
  });

  it("clean when a leading \"$user\" entry is present but store_spy still precedes public", async () => {
    expect(await liveSearchPathProblem(client('"$user", store_spy, public'))).toBeNull();
  });

  it("flags store_spy absent", async () => {
    expect(await liveSearchPathProblem(client('"$user", public'))).toMatch(/"store_spy" is absent/);
  });

  it("flags public before store_spy", async () => {
    expect(await liveSearchPathProblem(client("public, store_spy"))).toMatch(/"public" precedes "store_spy"/);
  });

  it("clean when public is absent entirely (store_spy present, nothing shadows it)", async () => {
    expect(await liveSearchPathProblem(client("store_spy"))).toBeNull();
  });

  it("propagates a real connection error (caller decides whether to block boot)", async () => {
    const boom = { $queryRawUnsafe: async () => { throw new Error("ECONNREFUSED"); } };
    await expect(liveSearchPathProblem(boom)).rejects.toThrow("ECONNREFUSED");
  });
});
