import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "../../../../lib/db/prisma";
import { hashPassword, isPasswordAcceptable } from "../../../../lib/auth/password";
import { isPlausibleEmail, normalizeEmail } from "../../../../lib/auth/normalize-email";
import { checkRateLimit, getClientIp } from "../../../../lib/security/rate-limit";

/**
 * Creates a Credentials-provider account. Does not sign the user in itself
 * — the client calls next-auth's signIn("credentials", ...) with the same
 * email/password immediately after a successful response, so this route
 * only ever needs to worry about account creation, not session issuance.
 */
export const runtime = "nodejs";

const RATE_LIMIT = { limit: 10, windowMs: 60_000 };

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

  if (!rawEmail || !isPlausibleEmail(rawEmail)) {
    return Response.json({ error: "Enter a valid email address." }, { status: 400 });
  }
  if (!password || !isPasswordAcceptable(password)) {
    return Response.json({ error: "Password must be at least 8 characters." }, { status: 400 });
  }

  const email = normalizeEmail(rawEmail);
  const passwordHash = await hashPassword(password);

  try {
    const user = await prisma.user.create({
      data: { email, passwordHash, name },
      select: { id: true, email: true },
    });
    return Response.json({ id: user.id, email: user.email }, { status: 201 });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      // Unique violation on email — including the race where two signups
      // for the same address land concurrently and only one wins the insert.
      return Response.json({ error: "An account with this email already exists." }, { status: 409 });
    }
    throw e;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
