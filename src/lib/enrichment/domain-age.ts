import type { PrismaClient } from "@prisma/client";
import { observed, unavailable, type IntelligenceField } from "../analysis/report-contract";

/**
 * Free, real, deterministic store-age signals from two fixed, trusted
 * external endpoints — never the target store itself, so none of the SSRF
 * guard's per-store DNS/private-IP checks apply here (those exist to keep
 * an ATTACKER-CONTROLLED domain from being crawled; rdap.org and
 * web.archive.org are hardcoded, not user input).
 *
 * Looked up ONCE per store, then cached forever on Store.domainRegisteredAt/
 * firstArchivedAt/domainAgeCheckedAt — a domain's registration date and
 * Wayback history only grow, they never need re-checking on every routine
 * monitoring crawl. This mirrors the existing marketingBaselinedAt pattern:
 * a report reads the persisted value (fast, no external call on every page
 * view); only the crawl orchestration calls the lookups themselves, and
 * only when domainAgeCheckedAt is still null.
 *
 * Best-effort and NEVER throws: a failure here must never break the crawl
 * it's attached to. Both lookups are attempted independently — one vendor
 * being down doesn't block the other from being recorded.
 */

const FETCH_TIMEOUT_MS = 8_000;
const WAYBACK_CDX_LIMIT = 20; // just enough to find the earliest row; not a full history dump

export interface DomainAgeFields {
  domainRegisteredAt: Date | null;
  firstArchivedAt: Date | null;
}

interface FetchLike {
  (url: string, init?: { signal?: AbortSignal }): Promise<Response>;
}

async function fetchWithTimeout(url: string, fetchImpl: FetchLike): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * RDAP (rdap.org) — the IANA-bootstrapped, standardized successor to WHOIS.
 * `events[].eventAction === "registration"` carries the domain's original
 * registration date. Many registrars redact this for privacy — a missing
 * event is a normal, expected outcome, not a failure.
 */
async function lookupRdapRegistration(domain: string, fetchImpl: FetchLike): Promise<Date | null> {
  const res = await fetchWithTimeout(`https://rdap.org/domain/${encodeURIComponent(domain)}`, fetchImpl);
  if (!res.ok) return null;

  const body: unknown = await res.json();
  if (typeof body !== "object" || body === null || !("events" in body)) return null;
  const events = (body as { events: unknown }).events;
  if (!Array.isArray(events)) return null;

  for (const event of events) {
    if (
      typeof event === "object" &&
      event !== null &&
      (event as Record<string, unknown>).eventAction === "registration" &&
      typeof (event as Record<string, unknown>).eventDate === "string"
    ) {
      const date = new Date((event as Record<string, unknown>).eventDate as string);
      if (!Number.isNaN(date.getTime())) return date;
    }
  }
  return null;
}

/**
 * Wayback Machine's CDX API — queries for archived snapshots of this
 * store's /products.json specifically (not the homepage), since that's the
 * one URL this codebase already treats as the canonical "is this a real,
 * crawlable Shopify storefront" signal. Returns the EARLIEST snapshot date
 * found, a real lower bound on how long this store has been running in a
 * publicly crawlable form — independent of (and sometimes earlier or later
 * than) raw domain registration, since a domain can be registered and
 * parked for years before a store actually launches on it.
 */
async function lookupEarliestWaybackSnapshot(domain: string, fetchImpl: FetchLike): Promise<Date | null> {
  const url = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(domain)}/products.json&output=json&limit=${WAYBACK_CDX_LIMIT}&sort=ascending`;
  const res = await fetchWithTimeout(url, fetchImpl);
  if (!res.ok) return null;

  const rows: unknown = await res.json();
  // CDX JSON format: first row is a header (["urlkey","timestamp",...]),
  // remaining rows are data. Fewer than 2 rows means zero real snapshots.
  if (!Array.isArray(rows) || rows.length < 2) return null;

  const timestamp = rows[1]?.[1]; // column index 1 is "timestamp", format YYYYMMDDhhmmss
  if (typeof timestamp !== "string" || !/^\d{14}$/.test(timestamp)) return null;

  const iso = `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}T${timestamp.slice(8, 10)}:${timestamp.slice(10, 12)}:${timestamp.slice(12, 14)}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Idempotent, safe to call on every crawl: no-ops immediately (zero
 * external calls) once `domainAgeCheckedAt` is set, regardless of whether
 * the lookups found anything. Call after a crawl's own persistence
 * succeeds — this must never run in a way that could delay or fail the
 * crawl it's attached to.
 */
export async function enrichDomainAgeIfUnknown(
  prisma: PrismaClient,
  storeId: string,
  domain: string,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const store = await prisma.store.findUnique({ where: { id: storeId }, select: { domainAgeCheckedAt: true } });
  if (!store || store.domainAgeCheckedAt !== null) return;

  const [registeredAt, archivedAt] = await Promise.all([
    lookupRdapRegistration(domain, fetchImpl).catch(() => null),
    lookupEarliestWaybackSnapshot(domain, fetchImpl).catch(() => null),
  ]);

  await prisma.store.update({
    where: { id: storeId },
    data: { domainRegisteredAt: registeredAt, firstArchivedAt: archivedAt, domainAgeCheckedAt: new Date() },
  });
}

export function domainRegisteredAtField(fields: DomainAgeFields): IntelligenceField<{ registeredAt: string }> {
  return fields.domainRegisteredAt
    ? observed({ registeredAt: fields.domainRegisteredAt.toISOString() })
    : unavailable("No public registration date found for this domain.");
}

export function firstArchivedAtField(fields: DomainAgeFields): IntelligenceField<{ firstArchivedAt: string }> {
  return fields.firstArchivedAt
    ? observed({ firstArchivedAt: fields.firstArchivedAt.toISOString() })
    : unavailable("No archived storefront snapshot found for this domain.");
}
