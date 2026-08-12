"use client";

import { useEffect, useState } from "react";
import { formatRelativeTime } from "@/lib/format-relative-time";

interface FeedItem {
  id: string;
  eventType: string;
  headline: string;
  significance: number;
  occurredAt: string;
}

interface FeedPage {
  items: FeedItem[];
  nextCursor: string | null;
}

export interface ChangeFeedTimelineProps {
  domain: string;
  /** Drives which honest empty state to show — "just started" vs. "genuinely quiet". */
  totalCrawls: number;
  /** Restricts the feed to specific event types (e.g. the marketing vocabulary) — omit for the full feed. */
  eventTypes?: string[];
  /** Overrides the default "steady" empty-state copy — for a filtered feed, "no product changes" isn't the right claim. */
  steadyEmptyState?: { headline: string; detail: string };
}

/** Fetches from /api/store/[domain]/events — real append-only Event rows, cursor-paginated. */
export function ChangeFeedTimeline({ domain, totalCrawls, eventTypes, steadyEmptyState }: ChangeFeedTimelineProps) {
  const [items, setItems] = useState<FeedItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);

  const typesParam = eventTypes && eventTypes.length > 0 ? `&types=${eventTypes.join(",")}` : "";

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/store/${encodeURIComponent(domain)}/events?limit=20${typesParam}`)
      .then((r) => (r.ok ? (r.json() as Promise<FeedPage>) : Promise.reject(new Error(String(r.status)))))
      .then((page) => {
        if (cancelled) return;
        setItems(page.items);
        setCursor(page.nextCursor);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [domain, typesParam]);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const res = await fetch(`/api/store/${encodeURIComponent(domain)}/events?limit=20&cursor=${cursor}${typesParam}`);
      if (!res.ok) return;
      const page = (await res.json()) as FeedPage;
      setItems((prev) => [...(prev ?? []), ...page.items]);
      setCursor(page.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  }

  if (failed) return null;
  if (!items) {
    return <p className="font-mono text-xs text-muted-dim">Loading recent activity…</p>;
  }

  if (items.length === 0) {
    const justStarted = totalCrawls < 2;
    const steady = steadyEmptyState ?? {
      headline: "No changes detected yet",
      detail: "This store has been steady across recent checks.",
    };
    return (
      <div className="rounded-xl border border-dashed border-line px-5 py-7 text-center">
        <p className="font-display text-base font-bold">{justStarted ? "Monitoring started today" : steady.headline}</p>
        <p className="mt-1.5 font-mono text-xs text-muted-dim">
          {justStarted ? "Historical changes will appear after future crawls." : steady.detail}
        </p>
      </div>
    );
  }

  return (
    <div>
      <ul className="space-y-2">
        {items.map((item) => (
          <li
            key={item.id}
            className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg border border-line-soft bg-surface px-4 py-3"
          >
            <span className="w-28 flex-none font-mono text-[11px] text-muted-dim">
              {formatRelativeTime(item.occurredAt)}
            </span>
            <span className="text-sm text-paper">{item.headline}</span>
          </li>
        ))}
      </ul>
      {cursor && (
        <button
          className="mt-3 font-mono text-xs text-sig-new hover:text-[#8AD8FF] disabled:opacity-50"
          onClick={loadMore}
          disabled={loadingMore}
        >
          {loadingMore ? "Loading…" : "Load more"}
        </button>
      )}
    </div>
  );
}
