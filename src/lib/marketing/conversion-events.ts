import type { PrismaClient } from "@prisma/client";
import type { CookieConsentState } from "./cookie-consent";
import { dispatchGoogleConversionEvent, isGoogleMeasurementProtocolConfigured } from "./pixels/google";
import { dispatchLinkedInConversionEvent, isLinkedInConversionsApiConfigured } from "./pixels/linkedin";
import { dispatchMetaConversionEvent, isMetaConversionsApiConfigured } from "./pixels/meta";
import { dispatchTikTokConversionEvent, isTikTokEventsApiConfigured } from "./pixels/tiktok";
import { dispatchXConversionEvent, isXConversionsApiConfigured } from "./pixels/x";

/**
 * Milestone 12 §4.2 Step 2: "Prefer server-side conversion APIs where they
 * exist... Server-side events go out from the worker, not the request
 * path." Two halves, deliberately separate:
 *   - recordSignupConversionEvents() — called from the signup route, fast
 *     and local (one INSERT per configured vendor), never an outbound
 *     network call.
 *   - dispatchPendingConversionEvents() — called from the worker tick,
 *     the ONLY place an actual vendor API call is ever attempted.
 *
 * Gated on COOKIE consent (`store-spy-cookie-consent`), not `User.marketingConsent`
 * — these are two legally distinct GDPR/ePrivacy consents. Reporting a
 * conversion to an ad platform is a tracking/attribution activity, which is
 * what cookie/tracking consent governs; `marketingConsent` is specifically
 * "may we email you," a different question with a different checkbox at
 * signup. Conflating them would let a user who declined tracking cookies
 * (but happened to opt into marketing email, or vice versa) get tracked
 * anyway — exactly the kind of consent-scope violation §4.1 exists to
 * prevent. The signup route reads the incoming request's OWN cookie header
 * to get this — see its own comment for why that's a legitimate,
 * server-side read of the same consent signal the client-side pixel layer
 * already uses, not a second consent mechanism.
 */

/** One row per vendor that has a server-side dispatch path implemented — grows as each vendor is added. Meta, Google, TikTok, LinkedIn, and X so far — X's client pixel is a separate, still-open question (see x.ts's own file comment); its server-side conversion dispatch is unconditionally wired regardless of that decision. */
const SERVER_SIDE_VENDORS = ["meta", "google", "tiktok", "linkedin", "x"] as const;
type ServerSideVendor = (typeof SERVER_SIDE_VENDORS)[number];

export async function recordSignupConversionEvents(
  prisma: Pick<PrismaClient, "marketingConversionEvent">,
  userId: string,
  cookieConsent: CookieConsentState | "unset",
): Promise<void> {
  if (cookieConsent !== "granted") return;

  // Recorded for every vendor with a dispatch IMPLEMENTATION, regardless of
  // whether it's currently CONFIGURED with a real credential — dispatch
  // time is what checks configuration (see dispatchOne() below). This way
  // a PENDING row from before §4.3 ships is immediately dispatchable the
  // moment a real credential is configured, with no backfill needed.
  await Promise.all(
    SERVER_SIDE_VENDORS.map((vendor) =>
      prisma.marketingConversionEvent.create({ data: { eventType: "SIGNUP", vendor, userId } }),
    ),
  );
}

const DISPATCH_BATCH_SIZE = 100;

async function dispatchOne(
  prisma: PrismaClient,
  event: { id: string; vendor: string; userId: string },
): Promise<"dispatched" | "skipped" | "failed"> {
  try {
    if (event.vendor === "meta") {
      return await dispatchMetaConversionEvent(prisma, event);
    }
    if (event.vendor === "google") {
      return await dispatchGoogleConversionEvent(prisma, event);
    }
    if (event.vendor === "tiktok") {
      return await dispatchTikTokConversionEvent(prisma, event);
    }
    if (event.vendor === "linkedin") {
      return await dispatchLinkedInConversionEvent(prisma, event);
    }
    if (event.vendor === "x") {
      return await dispatchXConversionEvent(prisma, event);
    }
    // Not one of SERVER_SIDE_VENDORS — a row that predates a vendor being
    // removed, or a data problem. Fail loudly into the row itself rather
    // than throwing and stalling the whole batch.
    await prisma.marketingConversionEvent.update({
      where: { id: event.id },
      data: { dispatchStatus: "FAILED", dispatchError: `no dispatcher for vendor "${event.vendor}"` },
    });
    return "failed";
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await prisma.marketingConversionEvent.update({ where: { id: event.id }, data: { dispatchStatus: "FAILED", dispatchError: message.slice(0, 500) } });
    return "failed";
  }
}

export interface DispatchPendingConversionEventsResult {
  dispatched: number;
  skipped: number;
  failed: number;
}

/**
 * Run from the worker tick, next to the other sweeps. Bounded batch, not an
 * unbounded sweep — matches every other worker-driven query in this
 * codebase (claimDueStores() etc.).
 */
export async function dispatchPendingConversionEvents(prisma: PrismaClient): Promise<DispatchPendingConversionEventsResult> {
  const pending = await prisma.marketingConversionEvent.findMany({
    where: { dispatchStatus: "PENDING" },
    orderBy: { occurredAt: "asc" },
    take: DISPATCH_BATCH_SIZE,
  });

  const result: DispatchPendingConversionEventsResult = { dispatched: 0, skipped: 0, failed: 0 };
  for (const event of pending) {
    const outcome = await dispatchOne(prisma, event);
    result[outcome]++;
  }
  return result;
}

/** Exposed for the worker's own log line — "is there even a point running this tick" without querying the table separately. */
export function anyServerSideVendorConfigured(): boolean {
  return (
    isMetaConversionsApiConfigured() ||
    isGoogleMeasurementProtocolConfigured() ||
    isTikTokEventsApiConfigured() ||
    isLinkedInConversionsApiConfigured() ||
    isXConversionsApiConfigured()
  );
}
