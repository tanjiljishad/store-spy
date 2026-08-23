"use client";

import { useState } from "react";

export interface ExportUsersButtonProps {
  emailQuery?: string;
  plan?: string;
  role?: string;
}

/**
 * Milestone 12 §3.3: POST /api/admin/users/export, purpose:"support" —
 * the only purpose this phase implements (see the route's own doc comment
 * for why "marketing" fails closed with 501 until Phase 4's consent model
 * exists). A plain HTML form can't trigger this: the route expects a JSON
 * body and returns a CSV as a fetch response, not a full-page navigation,
 * so this is one of the few genuinely client-side pieces in /admin — same
 * reasoning as MonitorButton.tsx's own "use client" boundary.
 */
export function ExportUsersButton({ emailQuery, plan, role }: ExportUsersButtonProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleExport() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/users/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ purpose: "support", emailQuery, plan, role }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? `Export failed (${res.status})`);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `users-export-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={handleExport}
        disabled={loading}
        className="rounded-md border border-line bg-surface px-3 py-1.5 font-mono text-[12px] text-paper hover:border-sig-new disabled:opacity-50"
      >
        {loading ? "Exporting…" : "Export CSV"}
      </button>
      {error && <span className="font-mono text-[12px] text-sig-stock">{error}</span>}
    </div>
  );
}
