"use client";

import { useCallback, useRef, useState } from "react";
import type { AnalysisReport, AnalysisSseEvent, AnalysisStatus, LimitReachedDetail } from "@/lib/analysis/types";

export type AnalysisViewState =
  | { view: "idle" }
  | { view: "analyzing"; domain: string; events: AnalysisSseEvent[] }
  | { view: "report"; domain: string; report: AnalysisReport }
  | {
      view: "error";
      domain: string;
      status: AnalysisStatus;
      message: string;
      retryable: boolean;
      limitReached?: LimitReachedDetail;
    };

function labelFromUrl(rawUrl: string): string {
  return rawUrl
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .split(/[/?#]/)[0];
}

/**
 * Drives POST /api/analyze and parses its Server-Sent Events stream by hand:
 * the browser's EventSource only supports GET, and this needs to POST the
 * URL. Every state transition below is caused by an event the server sent
 * for something that actually happened — nothing here is a timer.
 */
export function useAnalysisStream() {
  const [state, setState] = useState<AnalysisViewState>({ view: "idle" });
  const abortRef = useRef<AbortController | null>(null);

  const start = useCallback(async (rawUrl: string, turnstileToken?: string | null) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const domain = labelFromUrl(rawUrl);
    setState({ view: "analyzing", domain, events: [] });

    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: rawUrl, ...(turnstileToken ? { turnstileToken } : {}) }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        let message = `Request failed (${res.status})`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body.error) message = body.error;
        } catch {
          // keep the generic message
        }
        // 401 (anonymous caller, see this milestone's doc item 1.4) and 400
        // (bad input) both need the caller to change something before
        // retrying helps — a bare "Try again" would just repeat the same
        // rejection.
        setState({ view: "error", domain, status: "failed", message, retryable: res.status !== 400 && res.status !== 401 });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
          const rawEvent = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);

          const dataLine = rawEvent.split("\n").find((line) => line.startsWith("data:"));
          if (!dataLine) continue;

          let event: AnalysisSseEvent;
          try {
            event = JSON.parse(dataLine.slice(5).trim()) as AnalysisSseEvent;
          } catch {
            continue; // malformed line — skip rather than crash the stream
          }

          if (event.type === "status" || event.type === "progress") {
            setState((prev) => (prev.view === "analyzing" ? { ...prev, events: [...prev.events, event] } : prev));
          } else if (event.type === "complete") {
            setState({ view: "report", domain, report: event.report });
          } else if (event.type === "error") {
            setState({
              view: "error",
              domain,
              status: event.status,
              message: event.message,
              retryable: event.retryable,
              limitReached: event.limitReached,
            });
          }
        }
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      // This is a real transport-level failure (fetch rejected or the
      // stream reader threw), not a graceful server-emitted error — those
      // are handled above via event.type === "error". Log it so the actual
      // cause (dev server restart, dropped connection, DNS failure, etc.)
      // is visible in devtools instead of being fully discarded.
      console.error("[useAnalysisStream] transport error:", e);
      setState({
        view: "error",
        domain,
        status: "failed",
        message: "Connection lost while analyzing. Please try again.",
        retryable: true,
      });
    }
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setState({ view: "idle" });
  }, []);

  return { state, start, reset };
}
