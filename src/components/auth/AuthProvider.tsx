"use client";

import { SessionProvider } from "next-auth/react";
import type { ReactNode } from "react";

/** Thin client boundary so layout.tsx (a Server Component) can wrap the app in a session context. */
export function AuthProvider({ children }: { children: ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>;
}
