import { prisma } from "@/lib/db/prisma";
import { listPromos } from "@/lib/admin/promos-service";
import { CreatePromoForm } from "@/components/admin/CreatePromoForm";

/** Server Component — the list itself is fetched here, server-side, via the same listPromos() the API route uses. */
export default async function AdminPromosPage() {
  const page = await listPromos(prisma);

  return (
    <div>
      <h1 className="font-display text-2xl font-bold tracking-tight">Promo codes</h1>
      <CreatePromoForm />

      <table className="mt-6 w-full border-collapse font-mono text-[13px]">
        <thead>
          <tr className="border-b border-line-soft text-left text-muted-dim">
            <th className="py-2 pr-4">Code</th>
            <th className="py-2 pr-4">Discount</th>
            <th className="py-2 pr-4">Duration</th>
            <th className="py-2 pr-4">Status</th>
            <th className="py-2 pr-4">Redemptions</th>
            <th className="py-2">Assigned to</th>
          </tr>
        </thead>
        <tbody>
          {page.items.map((p) => (
            <tr key={p.id} className="border-b border-line-soft/60">
              <td className="py-2 pr-4">{p.code}</td>
              <td className="py-2 pr-4">{p.discountType === "PERCENT" ? `${p.discountValue}%` : `$${(p.discountValue / 100).toFixed(2)}`}</td>
              <td className="py-2 pr-4">{p.durationDays === null ? "Forever" : `${p.durationDays}d`}</td>
              <td className="py-2 pr-4">{p.status}</td>
              <td className="py-2 pr-4">
                {p.redemptionCount}
                {p.maxRedemptions !== null ? ` / ${p.maxRedemptions}` : ""}
              </td>
              <td className="py-2 text-muted-dim">{p.assignedToUserId ?? "Anyone"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {page.items.length === 0 && <p className="mt-4 text-muted-dim">No promo codes yet.</p>}
    </div>
  );
}
