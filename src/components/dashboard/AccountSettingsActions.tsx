"use client";

import { useState } from "react";
import { signOut } from "next-auth/react";

export interface AccountSettingsActionsProps {
  email: string;
}

/**
 * Milestone 12 §4.1: the two GDPR endpoints, made actually reachable from
 * the app rather than existing only as API routes nothing links to.
 */
export function AccountSettingsActions({ email }: AccountSettingsActionsProps) {
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const [confirmEmail, setConfirmEmail] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  async function handleExport() {
    setExporting(true);
    setExportError(null);
    try {
      const res = await fetch("/api/account/export");
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setExportError(body.error ?? `Export failed (${res.status})`);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `store-spy-account-data-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch("/api/account/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmEmail }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setDeleteError(body.error ?? `Delete failed (${res.status})`);
        setDeleting(false);
        return;
      }
      // The JWT itself isn't invalidated by the DB delete until its next
      // refresh (see jwt-plan-refresh.ts) — sign out explicitly rather
      // than leaving a "still looks logged in" UI for up to that window.
      await signOut({ callbackUrl: "/" });
    } catch {
      setDeleteError("Something went wrong. Please try again.");
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-lg border border-line bg-surface p-5">
        <h2 className="mb-1 font-mono text-[13px] font-semibold text-paper">Export your data</h2>
        <p className="mb-3 font-mono text-[12.5px] text-muted-dim">
          Download a copy of everything we store about your account (GDPR Art. 15).
        </p>
        <button
          type="button"
          onClick={handleExport}
          disabled={exporting}
          className="rounded-md border border-line px-4 py-2 font-mono text-[12.5px] font-semibold text-paper transition hover:border-sig-new disabled:opacity-50"
        >
          {exporting ? "Preparing…" : "Export my data"}
        </button>
        {exportError && <p className="mt-2 font-mono text-[12px] text-sig-stock">{exportError}</p>}
      </div>

      <div className="rounded-lg border border-sig-stock/35 bg-surface p-5">
        <h2 className="mb-1 font-mono text-[13px] font-semibold text-sig-stock">Delete your account</h2>
        <p className="mb-3 font-mono text-[12.5px] text-muted-dim">
          Permanently deletes your account, watches, analysis history, subscriptions, and checkouts (GDPR
          Art. 17). This cannot be undone.
        </p>

        {!showDeleteConfirm ? (
          <button
            type="button"
            onClick={() => setShowDeleteConfirm(true)}
            className="rounded-md border border-sig-stock/50 px-4 py-2 font-mono text-[12.5px] font-semibold text-sig-stock transition hover:bg-sig-stock/10"
          >
            Delete my account
          </button>
        ) : (
          <div className="flex flex-col gap-2.5">
            <label className="flex flex-col gap-1.5">
              <span className="font-mono text-[11px] uppercase tracking-wider text-muted-dim">
                Type <span className="text-paper">{email}</span> to confirm
              </span>
              <input
                type="email"
                value={confirmEmail}
                onChange={(e) => setConfirmEmail(e.target.value)}
                className="rounded-md border border-line bg-ink px-3.5 py-2 font-mono text-[13px] text-paper outline-none focus:border-sig-stock"
              />
            </label>
            <div className="flex gap-2.5">
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleting || confirmEmail.trim().toLowerCase() !== email.trim().toLowerCase()}
                className="rounded-md bg-sig-stock px-4 py-2 font-mono text-[12.5px] font-semibold text-ink transition disabled:pointer-events-none disabled:opacity-40"
              >
                {deleting ? "Deleting…" : "Permanently delete"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowDeleteConfirm(false);
                  setConfirmEmail("");
                  setDeleteError(null);
                }}
                className="rounded-md border border-line px-4 py-2 font-mono text-[12.5px] text-muted-dim transition hover:border-muted"
              >
                Cancel
              </button>
            </div>
            {deleteError && <p className="font-mono text-[12px] text-sig-stock">{deleteError}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
