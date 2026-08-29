import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      // B2 2·B: `plan` is no longer a session/JWT claim — CurrentUser.plan
      // (session.ts) is derived from entitlements per call.
      role: string;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    role?: string;
    /** Date.now() (ms) of the last live control_plane.users read — see SESSION_CHECK_TTL_MS in jwt-session-refresh.ts. Ignored while role is anything other than "USER". */
    sessionCheckedAt?: number;
  }
}
