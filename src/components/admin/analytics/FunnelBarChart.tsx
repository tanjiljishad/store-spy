"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { FunnelStepView } from "@/lib/admin/analytics/dashboard-data";

/** Milestone 12 §3.2: "charts with recharts." One bar per funnel step (§3.1) — count only; conversion rates are shown as text next to each bar (see the page), since a rate needs the previous bar's value for context a chart alone can't carry. */
export function FunnelBarChart({ steps }: { steps: FunnelStepView[] }) {
  const data = steps.map((s) => ({ label: s.label, count: s.count }));

  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="var(--color-line-soft)" vertical={false} />
        <XAxis
          dataKey="label"
          tick={{ fill: "var(--color-muted)", fontSize: 11, fontFamily: "monospace" }}
          axisLine={{ stroke: "var(--color-line)" }}
          tickLine={false}
        />
        <YAxis tick={{ fill: "var(--color-muted)", fontSize: 11, fontFamily: "monospace" }} axisLine={false} tickLine={false} allowDecimals={false} />
        <Tooltip
          contentStyle={{ background: "var(--color-surface-2)", border: "1px solid var(--color-line)", fontFamily: "monospace", fontSize: 12 }}
          labelStyle={{ color: "var(--color-paper)" }}
          itemStyle={{ color: "var(--color-sig-new)" }}
        />
        <Bar dataKey="count" fill="var(--color-sig-new)" radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
