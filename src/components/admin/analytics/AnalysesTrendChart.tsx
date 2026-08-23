"use client";

import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export interface TrendChartPoint {
  day: string; // pre-formatted (e.g. "Aug 20") — no date math in a client component
  FREE: number;
  BASIC: number;
  BUSINESS: number;
}

const PLAN_COLOR: Record<"FREE" | "BASIC" | "BUSINESS", string> = {
  FREE: "var(--color-muted)",
  BASIC: "var(--color-sig-new)",
  BUSINESS: "var(--color-sig-price)",
};

/** Milestone 12 §3.1: "analyses/day by plan" — the one metric this phase gives per-day trend granularity (see usage-cost.ts's getDailyAnalysesTrend()). */
export function AnalysesTrendChart({ points }: { points: TrendChartPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={points} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="var(--color-line-soft)" vertical={false} />
        <XAxis dataKey="day" tick={{ fill: "var(--color-muted)", fontSize: 11, fontFamily: "monospace" }} axisLine={{ stroke: "var(--color-line)" }} tickLine={false} />
        <YAxis tick={{ fill: "var(--color-muted)", fontSize: 11, fontFamily: "monospace" }} axisLine={false} tickLine={false} allowDecimals={false} />
        <Tooltip
          contentStyle={{ background: "var(--color-surface-2)", border: "1px solid var(--color-line)", fontFamily: "monospace", fontSize: 12 }}
          labelStyle={{ color: "var(--color-paper)" }}
        />
        <Legend wrapperStyle={{ fontFamily: "monospace", fontSize: 11, color: "var(--color-muted)" }} />
        <Line type="monotone" dataKey="FREE" stroke={PLAN_COLOR.FREE} dot={false} strokeWidth={1.5} />
        <Line type="monotone" dataKey="BASIC" stroke={PLAN_COLOR.BASIC} dot={false} strokeWidth={1.5} />
        <Line type="monotone" dataKey="BUSINESS" stroke={PLAN_COLOR.BUSINESS} dot={false} strokeWidth={1.5} />
      </LineChart>
    </ResponsiveContainer>
  );
}
