import { notFound } from "next/navigation";
import { prisma } from "@/lib/db/prisma";
import { searchUsers } from "@/lib/admin/users-service";
import { requirePermission } from "@/lib/admin/guard";
import { ForbiddenError, UnauthorizedError } from "@/lib/auth/session";
import { ExportUsersButton } from "@/components/admin/ExportUsersButton";
import type { PlanTier } from "@/lib/entitlements/plan-limits";
import type { Role } from "@/lib/admin/roles";

interface AdminUsersPageProps {
  searchParams: Promise<{ email?: string; plan?: string; role?: string }>;
}

const PLAN_OPTIONS: PlanTier[] = ["FREE", "BASIC", "BUSINESS"];
const ROLE_OPTIONS: Role[] = [
  "USER",
  "ANALYST",
  "CONTENT_ADMIN",
  "SUPPORT_ADMIN",
  "BILLING_ADMIN",
  "OPS_ADMIN",
  "MARKETING_ADMIN",
  "MANAGER",
  "SUPER_ADMIN",
];

/**
 * Server Component — the search itself runs here, server-side, via the same
 * searchUsers() the API route uses. No client fetch, no client-side role
 * check deciding what's requested. Milestone 12 §3.3 adds plan/role filters
 * and the CSV export action. Security review fix 1: gated on user:read
 * specifically (excludes ANALYST) — AdminLayout's own gate only proves
 * "some admin permission," not this one, so an ANALYST (metrics:read only)
 * previously read every user's email here with no check above it. Same
 * pattern as admin/analytics/page.tsx.
 */
export default async function AdminUsersPage({ searchParams }: AdminUsersPageProps) {
  try {
    await requirePermission("user:read");
  } catch (e) {
    if (e instanceof UnauthorizedError || e instanceof ForbiddenError) notFound();
    throw e;
  }

  const { email, plan, role } = await searchParams;
  const page = await searchUsers(prisma, {
    emailQuery: email,
    plan: plan && PLAN_OPTIONS.includes(plan as PlanTier) ? (plan as PlanTier) : undefined,
    role: role && ROLE_OPTIONS.includes(role as Role) ? (role as Role) : undefined,
  });

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <h1 className="font-display text-2xl font-bold tracking-tight">Users</h1>
        <ExportUsersButton emailQuery={email} plan={plan} role={role} />
      </div>

      <form className="mt-4 flex flex-wrap items-center gap-3" method="get">
        <input
          type="text"
          name="email"
          defaultValue={email ?? ""}
          placeholder="Search by email…"
          className="w-full max-w-[360px] rounded-md border border-line bg-surface px-3.5 py-2.5 font-mono text-[13px] text-paper outline-none focus:border-sig-price"
        />
        <select name="plan" defaultValue={plan ?? ""} className="rounded-md border border-line bg-surface px-3 py-2.5 font-mono text-[13px] text-paper">
          <option value="">Any plan</option>
          {PLAN_OPTIONS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <select name="role" defaultValue={role ?? ""} className="rounded-md border border-line bg-surface px-3 py-2.5 font-mono text-[13px] text-paper">
          <option value="">Any role</option>
          {ROLE_OPTIONS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <button type="submit" className="rounded-md border border-line bg-surface px-3 py-2.5 font-mono text-[13px] text-paper hover:border-sig-new">
          Filter
        </button>
      </form>

      <table className="mt-6 w-full border-collapse font-mono text-[13px]">
        <thead>
          <tr className="border-b border-line-soft text-left text-muted-dim">
            <th className="py-2 pr-4">Email</th>
            <th className="py-2 pr-4">Plan</th>
            <th className="py-2 pr-4">Role</th>
            <th className="py-2">Created</th>
          </tr>
        </thead>
        <tbody>
          {page.items.map((u) => (
            <tr key={u.id} className="border-b border-line-soft/60">
              <td className="py-2 pr-4">{u.email}</td>
              <td className="py-2 pr-4">{u.plan}</td>
              <td className="py-2 pr-4">{u.role}</td>
              <td className="py-2 text-muted-dim">{new Date(u.createdAt).toLocaleDateString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {page.items.length === 0 && <p className="mt-4 text-muted-dim">No users found.</p>}
    </div>
  );
}
