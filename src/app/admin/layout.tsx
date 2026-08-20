import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireUser, UnauthorizedError } from "@/lib/auth/session";

/**
 * The gate for the whole /admin area: role !== "USER", read from the
 * session (which reads from the JWT — see jwt-plan-refresh.ts for how a
 * privileged role stays correct on every request, not just a cached one).
 * Deliberately a Server Component check, not a client-side one — every
 * page under this layout fetches its own data server-side too (see
 * admin/promos/page.tsx, admin/users/page.tsx), so there is no client-side
 * role check ever deciding what data gets requested in the first place.
 * The API routes underneath (/api/admin/*) re-check independently via
 * requirePermission() regardless — this layout is a UX convenience, not
 * the security boundary.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    if (e instanceof UnauthorizedError) redirect("/login");
    throw e;
  }

  if (user.role === "USER") notFound();

  return (
    <div className="mx-auto max-w-[1180px] px-7 py-10">
      <nav className="mb-8 flex items-center gap-5 border-b border-line-soft pb-4">
        <span className="font-mono text-[11px] uppercase tracking-wider text-muted-dim">Admin</span>
        <Link href="/admin/users" className="font-mono text-[13px] text-paper hover:text-sig-new">
          Users
        </Link>
        <Link href="/admin/promos" className="font-mono text-[13px] text-paper hover:text-sig-new">
          Promos
        </Link>
        <span className="ml-auto font-mono text-[11px] text-muted-dim">Signed in as {user.email} ({user.role})</span>
      </nav>
      {children}
    </div>
  );
}
