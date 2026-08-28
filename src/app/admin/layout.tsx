import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireUser, UnauthorizedError } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { needsConsentInterstitial } from "@/lib/account/consent";
import { needsEmailVerification } from "@/lib/account/email-verification";
import { permissionsFor } from "@/lib/admin/roles";
import { hasAnyActiveGrant } from "@/lib/admin/permissions-service";

/**
 * The gate for the whole /admin area: "holds at least one effective
 * permission" — role-derived OR granted (Milestone 12 §2.1's
 * AdminPermissionGrant), read fresh here rather than assumed from role
 * alone. Security review fix 1: the previous `role !== "USER"` check
 * ignored grants entirely, so a USER-role account holding a grant (e.g.
 * `export:users`) passed requirePermission() at the API layer but was
 * notFound() here before ever reaching it — a real, if narrow, denial of a
 * legitimately granted permission. `permissionsFor(role).length > 0` is
 * checked first — a pure in-memory lookup, true for every role except
 * USER — so this stays a zero-query check for every ordinary admin visit;
 * only a USER-role account falls through to hasAnyActiveGrant()'s DB read.
 *
 * Deliberately a Server Component check, not a client-side one — every
 * page under this layout fetches its own data server-side too (see
 * admin/promos/page.tsx, admin/users/page.tsx), so there is no client-side
 * check ever deciding what data gets requested in the first place. Still
 * only a UX convenience, NOT the security boundary: this proves the caller
 * has *some* admin-grade access, not the SPECIFIC permission a given
 * page's data requires — every page under this layout must call its own
 * requirePermission() for that (see admin/analytics/page.tsx's pattern,
 * now also followed by promos/page.tsx and users/page.tsx), the same way
 * every /api/admin/* route re-checks independently regardless of this gate.
 *
 * Milestone 12 §4.2 preflight finding: this layout is a SIBLING of
 * DashboardLayout, not nested under it — its own consent-interstitial
 * check (§4.1 addendum) does not cover this tree at all. An account with
 * a privileged role and a never-completed ToS acceptance (e.g. an OAuth
 * signup promoted via scripts/grant-admin.ts before ever visiting
 * /welcome) could reach every /admin page entirely around the gate.
 * Mirrors DashboardLayout's own check exactly — see needsConsentInterstitial()'s
 * doc comment for why this is a fresh DB read, not JWT-cached.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    if (e instanceof UnauthorizedError) redirect("/login");
    throw e;
  }

  const hasEffectivePermission = permissionsFor(user.role).length > 0 || (await hasAnyActiveGrant(prisma, user.id));
  if (!hasEffectivePermission) notFound();
  if (await needsConsentInterstitial(prisma, user.id)) {
    redirect("/welcome");
  }
  // Same "this layout is a sibling of DashboardLayout, not nested under it"
  // gap the consent-gate addendum above already closed once — an account
  // promoted via scripts/grant-admin.ts before ever clicking its
  // verification link would otherwise reach every /admin page around this
  // check entirely. See needsEmailVerification()'s own doc comment.
  if (await needsEmailVerification(prisma, user.id)) {
    redirect("/verify-email");
  }

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
        <Link href="/admin/analytics" className="font-mono text-[13px] text-paper hover:text-sig-new">
          Analytics
        </Link>
        <span className="ml-auto font-mono text-[11px] text-muted-dim">Signed in as {user.email} ({user.role})</span>
      </nav>
      {children}
    </div>
  );
}
