import { describe, expect, it, vi } from "vitest";
import { createPinnedFetch, resolveValidatedAddresses, createAutoPinnedFetch } from "../pinned-fetch";
import type { DnsLookup } from "../ssrf-guard";

describe("createPinnedFetch", () => {
  it("throws for an empty address list rather than silently pinning to nothing", () => {
    expect(() => createPinnedFetch([])).toThrow();
  });

  it("returns a callable fetch-shaped function for a valid address", () => {
    const pinned = createPinnedFetch(["8.8.8.8"]);
    expect(typeof pinned).toBe("function");
  });
});

describe("resolveValidatedAddresses", () => {
  it("resolves and validates a hostname via the injected DNS lookup", async () => {
    const dnsLookup: DnsLookup = async () => [{ address: "8.8.8.8" }];
    expect(await resolveValidatedAddresses("real-store.com", dnsLookup)).toEqual(["8.8.8.8"]);
  });

  it("filters out private addresses from a mixed DNS answer — never pins to one", async () => {
    const dnsLookup: DnsLookup = async () => [{ address: "8.8.8.8" }, { address: "169.254.169.254" }];
    expect(await resolveValidatedAddresses("mixed.example.com", dnsLookup)).toEqual(["8.8.8.8"]);
  });

  it("returns an empty list when every resolved address is private", async () => {
    const dnsLookup: DnsLookup = async () => [{ address: "10.0.0.5" }];
    expect(await resolveValidatedAddresses("internal.example.com", dnsLookup)).toEqual([]);
  });

  it("skips DNS entirely for a literal public IP hostname", async () => {
    const dnsLookup = vi.fn();
    expect(await resolveValidatedAddresses("1.1.1.1", dnsLookup)).toEqual(["1.1.1.1"]);
    expect(dnsLookup).not.toHaveBeenCalled();
  });

  it("rejects a literal private IP hostname without calling DNS", async () => {
    const dnsLookup = vi.fn();
    expect(await resolveValidatedAddresses("127.0.0.1", dnsLookup)).toEqual([]);
    expect(dnsLookup).not.toHaveBeenCalled();
  });
});

describe("createAutoPinnedFetch", () => {
  it("rejects (throws) when a hostname resolves to nothing publicly routable, per hop", async () => {
    const dnsLookup: DnsLookup = async () => [{ address: "10.0.0.5" }];
    const fetchImpl = createAutoPinnedFetch(dnsLookup);
    await expect(fetchImpl("https://internal.example.com/")).rejects.toThrow();
  });

  it("a DNS lookup returning a private address is refused, closing the mid-redirect rebinding gap", async () => {
    // This is exactly the scenario a DNS-rebinding attack relies on: the
    // hostname currently resolves to something private. createAutoPinnedFetch
    // resolves+validates BEFORE ever attempting a connection, per call — so
    // a redirect target (crawl/shopify.ts's fetchWithTimeout calls the
    // default fetchImpl fresh on every hop) that currently resolves private
    // is refused right here, never reaching a real socket.
    const dnsLookup: DnsLookup = async () => [{ address: "169.254.169.254" }];
    const fetchImpl = createAutoPinnedFetch(dnsLookup);
    await expect(fetchImpl("https://attacker-controlled-redirect-target.com/")).rejects.toThrow();
  });
});
