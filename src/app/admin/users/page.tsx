import { prisma } from "@/lib/db/prisma";
import { searchUsers } from "@/lib/admin/users-service";

interface AdminUsersPageProps {
  searchParams: Promise<{ email?: string }>;
}

/** Server Component — the search itself runs here, server-side, via the same searchUsers() the API route uses. No client fetch, no client-side role check deciding what's requested. */
export default async function AdminUsersPage({ searchParams }: AdminUsersPageProps) {
  const { email } = await searchParams;
  const page = await searchUsers(prisma, { emailQuery: email });

  return (
    <div>
      <h1 className="font-display text-2xl font-bold tracking-tight">Users</h1>
      <form className="mt-4" method="get">
        <input
          type="text"
          name="email"
          defaultValue={email ?? ""}
          placeholder="Search by email…"
          className="w-full max-w-[360px] rounded-md border border-line bg-surface px-3.5 py-2.5 font-mono text-[13px] text-paper outline-none focus:border-sig-price"
        />
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
