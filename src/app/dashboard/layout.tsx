import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { DashboardNav } from "@/components/dashboard/DashboardNav";
import type { ReactNode } from "react";

/**
 * The actual security boundary for every /dashboard/** route — a server
 * component, not proxy.ts. This Next.js fork's own docs warn that a
 * matcher change can silently drop proxy coverage; checking here means
 * every dashboard page is protected regardless of routing changes
 * elsewhere, consistent with the same choice made for the API routes in
 * Sub-phase A (getCurrentUser() at the call site, not a shared gate).
 */
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }

  return (
    <>
      <DashboardNav email={user.email} />
      <div className="mx-auto max-w-[1180px] px-7 pb-16 pt-10">{children}</div>
    </>
  );
}
