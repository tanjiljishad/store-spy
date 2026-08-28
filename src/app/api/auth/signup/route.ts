import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "../../../../lib/db/prisma";
import { hashPassword, isPasswordAcceptable } from "../../../../lib/auth/password";
import { isPlausibleEmail, normalizeEmail } from "../../../../lib/auth/normalize-email";
import { checkRateLimit, getClientIp } from "../../../../lib/security/rate-limit";
import { SIGNUP_FORM_CONSENT_SOURCE } from "../../../../lib/marketing/consent";
import { COOKIE_CONSENT_COOKIE_NAME, parseCookieConsent } from "../../../../lib/marketing/cookie-consent";
import { recordSignupConversionEvents } from "../../../../lib/marketing/conversion-events";
import { sendVerificationEmail } from "../../../../lib/email/verification-email";

/**
 * Creates a Credentials-provider account. Does not sign the user in itself
 * — the client calls next-auth's signIn("credentials", ...) with the same
 * email/password immediately after a successful response, so this route
 * only ever needs to worry about account creation, not session issuance.
 */
export const runtime = "nodejs";

const RATE_LIMIT = { limit: 10, windowMs: 60_000 };

/**
 * Applied to the 201 (created) and 409 (already exists) outcomes only —
 * the pair that actually leaks account existence through response timing.
 * Both already pay the same bcrypt cost (hashPassword runs unconditionally
 * before either branch), but the DB round trip itself (a real INSERT vs. a
 * unique-constraint rejection) can still differ by a few ms; padding both
 * to the same floor closes that instead of leaving it as measurement noise
 * an attacker could average out over enough requests. The 409 status code
 * itself is kept (see this milestone's doc, item 1.9) — removing it without
 * building email verification would make the UX worse, not the system
 * safer, so this closes the TIMING side of enumeration, not the existence
 * of the 409 response itself. Accepted residual risk: an attacker can still
 * enumerate by observing which addresses return 409 vs. 201 outright — a
 * real gap, unresolved, called out here and in the completion report.
 */
const MIN_ACCOUNT_DECISION_RESPONSE_MS = 400;

export async function POST(req: NextRequest) {
  const ip = getClientIp(req.headers);
  const rate = checkRateLimit(`signup:${ip}`, RATE_LIMIT);
  if (!rate.allowed) {
    return Response.json({ error: "Too many signup attempts. Try again shortly." }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  const rawEmail = isRecord(body) && typeof body.email === "string" ? body.email : null;
  const password = isRecord(body) && typeof body.password === "string" ? body.password : null;
  const name = isRecord(body) && typeof body.name === "string" ? body.name.slice(0, 200) : null;
  // Milestone 12 §4.1: the ToS checkbox stays MANDATORY — reject the
  // signup outright if it isn't checked, the same way a missing password
  // rejects. marketingConsent is the opposite: its absence/false is a
  // perfectly valid, expected signup, never rejected — see the doc's own
  // "separate, unticked" requirement.
  const tosAccepted = isRecord(body) && body.tosAccepted === true;
  const marketingConsent = isRecord(body) && body.marketingConsent === true;

  if (!rawEmail || !isPlausibleEmail(rawEmail)) {
    return Response.json({ error: "Enter a valid email address." }, { status: 400 });
  }
  if (!password || !isPasswordAcceptable(password, rawEmail)) {
    return Response.json(
      { error: "Password must be at least 10 characters, not one of the most common passwords, and not contain your email address." },
      { status: 400 },
    );
  }
  if (!tosAccepted) {
    return Response.json({ error: "You must agree to the Terms of Service and Privacy Policy to create an account." }, { status: 400 });
  }

  const email = normalizeEmail(rawEmail);
  const passwordHash = await hashPassword(password);

  const decisionStartedAt = Date.now();
  try {
    // marketingConsent bundled into the SAME create() call, not a second
    // update() right after — a two-step "create, then set consent" would
    // leave a real (if brief) window where the row exists with the
    // GDPR-correct default (false) contradicted by an in-flight request
    // that already promised true; one insert makes the row correct from
    // the instant it exists, with no intermediate state to reason about.
    const now = new Date();
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        name,
        // §4.1 addendum: tosAccepted was already validated true above —
        // this is the ONE field DashboardLayout gates on (needsConsentInterstitial()),
        // so a credentials signup must set it here or it would incorrectly
        // hit the OAuth-only /welcome interstitial on its first dashboard visit.
        tosAcceptedAt: now,
        ...(marketingConsent ? { marketingConsent: true, marketingConsentAt: now, marketingConsentSource: SIGNUP_FORM_CONSENT_SOURCE } : {}),
      },
      select: { id: true, email: true },
    });

    // §4.2 Step 2: reads the SAME cookie the consent banner and every
    // pixel loader already use (cookie-consent.ts) — never a second
    // consent mechanism, and never User.marketingConsent (a legally
    // distinct "may we email you" consent, not tracking consent). This is
    // the request's OWN cookie header — whatever the banner already wrote
    // to this browser before the signup form was submitted — not
    // anything this route decides on its own. Best-effort: a failure here
    // must never break the actual signup response, so it's isolated in
    // its own try/catch and only logged.
    try {
      const cookieConsent = parseCookieConsent(req.cookies.get(COOKIE_CONSENT_COOKIE_NAME)?.value);
      await recordSignupConversionEvents(prisma, user.id, cookieConsent);
    } catch (e) {
      console.error("[api/auth/signup] recordSignupConversionEvents failed (non-fatal):", e);
    }

    // Best-effort, same isolation as recordSignupConversionEvents above — a
    // Resend outage must never break account creation itself. A user who
    // never receives this email can still get one via the "resend" button
    // on /verify-email (DashboardLayout/AdminLayout redirect there until
    // emailVerified is set).
    try {
      await sendVerificationEmail(req.nextUrl.origin, user.id, user.email);
    } catch (e) {
      console.error("[api/auth/signup] sendVerificationEmail failed (non-fatal):", e);
    }

    return await respondNoFasterThan(
      decisionStartedAt,
      Response.json({ id: user.id, email: user.email }, { status: 201 }),
    );
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      // Unique violation on email — including the race where two signups
      // for the same address land concurrently and only one wins the insert.
      return await respondNoFasterThan(
        decisionStartedAt,
        Response.json({ error: "An account with this email already exists." }, { status: 409 }),
      );
    }
    // Any other failure (e.g. DB unreachable) previously escaped as an
    // uncaught exception, which Next.js turns into a bare HTML 500 page
    // instead of JSON — AuthForm's res.json() then silently fails and the
    // user sees a stock "Something went wrong" message with zero trace of
    // the real cause anywhere. Log it server-side and respond in the same
    // JSON shape every other branch of this route uses.
    console.error("[api/auth/signup] account creation failed:", e);
    return Response.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}

async function respondNoFasterThan(startedAt: number, response: Response): Promise<Response> {
  const elapsed = Date.now() - startedAt;
  if (elapsed < MIN_ACCOUNT_DECISION_RESPONSE_MS) {
    await new Promise((resolve) => setTimeout(resolve, MIN_ACCOUNT_DECISION_RESPONSE_MS - elapsed));
  }
  return response;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
