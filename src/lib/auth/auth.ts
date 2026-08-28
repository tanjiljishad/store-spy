import NextAuth from "next-auth";
import type { Provider } from "next-auth/providers";
import Credentials from "next-auth/providers/credentials";
import Facebook from "next-auth/providers/facebook";
import Google from "next-auth/providers/google";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "../db/prisma";
import { authorizeCredentials } from "./authorize-credentials";
import { getClientIp } from "../security/rate-limit";
import { refreshJwtToken } from "./jwt-plan-refresh";

/**
 * Auth.js v5, three providers unified onto the one Prisma `User` model via
 * `PrismaAdapter` (OAuth identities live in `Account`, never a second User
 * row for the same person).
 *
 * Session strategy is JWT, not database, for a specific reason: Auth.js's
 * Credentials provider is documented as incompatible with database
 * sessions — a Credentials sign-in doesn't go through the adapter's
 * account-linking path the way an OAuth sign-in does, so there is no
 * adapter-managed Session row to create for it. Since this app requires
 * both Credentials and OAuth, JWT is the only configuration that supports
 * all three uniformly. The real cost: no INSTANT server-side "sign out
 * everywhere" the way revoking a database session row would give you — see
 * AGENTS.md / the Milestone 3 report for why that tradeoff was accepted.
 * Milestone 11 closes most of the gap without switching strategies:
 * `User.sessionsValidAfter` (checked via refreshJwtToken() below, see
 * jwt-plan-refresh.ts) rejects any token issued before it was set, bounded
 * by PLAN_CHECK_TTL_MS — so revocation lands within 60 seconds, not
 * instantly, but without needing a database round trip on every single
 * request either.
 *
 * Google/Facebook are only registered when their env vars are present, so
 * a deployment (or this sandbox) without OAuth app credentials still gets
 * a fully working Credentials flow instead of a boot-time crash.
 */


const providers: Provider[] = [
  Credentials({
    id: "credentials",
    name: "Email and password",
    credentials: {
      email: { label: "Email", type: "email" },
      password: { label: "Password", type: "password" },
    },
    async authorize(credentials, request) {
      const email = typeof credentials?.email === "string" ? credentials.email : null;
      const password = typeof credentials?.password === "string" ? credentials.password : null;
      if (!email || !password) return null;

      return authorizeCredentials(prisma, email, password, getClientIp(request.headers));
    },
  }),
];

/**
 * Single source of truth for "is this provider actually configured" —
 * read by the providers array below AND by the /login and /signup Server
 * Components (getConfiguredProviders()) so the UI never renders a
 * "Continue with Google" button that would 500 on click. getProviders()
 * from next-auth/react does a relative fetch() internally, which isn't
 * reliable from a Server Component during SSR — this sidesteps that
 * entirely by checking the same env vars auth.ts itself gates on.
 */
export const configuredProviders = {
  google: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
  facebook: Boolean(process.env.FACEBOOK_CLIENT_ID && process.env.FACEBOOK_CLIENT_SECRET),
};

if (configuredProviders.google) {
  providers.push(
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      // Default profile() (Auth.js's OIDC client) does not map
      // emailVerified at all — overridden here so an OAuth-created row
      // never hits the email-verification gate (needsEmailVerification())
      // for an email Google has already verified itself. Google's OIDC
      // userinfo returns `email_verified` as a real boolean per-account, so
      // this only trusts it when Google itself says so, not unconditionally.
      profile(profile) {
        return {
          id: profile.sub,
          name: profile.name,
          email: profile.email,
          image: profile.picture,
          emailVerified: profile.email_verified ? new Date() : null,
        };
      },
    }),
  );
}

if (configuredProviders.facebook) {
  providers.push(
    Facebook({
      clientId: process.env.FACEBOOK_CLIENT_ID!,
      clientSecret: process.env.FACEBOOK_CLIENT_SECRET!,
      // Facebook's Graph API has no `email_verified` field to read — but it
      // only ever returns `email` at all when that address is confirmed
      // verified with Facebook (Facebook's own platform policy, not an
      // assumption made here), so presence of `email` is itself the signal.
      profile(profile) {
        return {
          id: profile.id,
          name: profile.name,
          email: profile.email,
          image: profile.picture?.data?.url,
          emailVerified: profile.email ? new Date() : null,
        };
      },
    }),
  );
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  session: { strategy: "jwt" },
  providers,
  pages: { signIn: "/login" },
  // Deliberately NOT enabling allowDangerousEmailAccountLinking: a
  // Credentials account and an OAuth account that happen to share an email
  // are kept separate unless a user explicitly links them from a signed-in
  // session (not built this milestone) — silently merging on email match
  // alone is exactly the "unsafe automatic linking" the spec says not to
  // build.
  callbacks: {
    async jwt({ token, user }) {
      if (user) token.id = user.id;
      const refreshed = await refreshJwtToken(token, Boolean(user), (userId) =>
        prisma.user.findUnique({ where: { id: userId }, select: { plan: true, role: true, sessionsValidAfter: true } }),
      );
      return refreshed as typeof token;
    },
    async session({ session, token }) {
      if (session.user && token.id) {
        session.user.id = token.id as string;
        session.user.plan = (token.plan as string) ?? "FREE";
        session.user.role = (token.role as string) ?? "USER";
      }
      return session;
    },
  },
});
