import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      plan: string;
      role: string;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    plan?: string;
    role?: string;
    /** Date.now() (ms) of the last live User-row read — see PLAN_CHECK_TTL_MS in auth.ts. Ignored entirely when role is anything other than "USER" — see jwt-plan-refresh.ts. */
    planCheckedAt?: number;
  }
}
