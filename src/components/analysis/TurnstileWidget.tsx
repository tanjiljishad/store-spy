"use client";

import { useEffect, useId, useRef } from "react";

/**
 * Milestone 12 §1.3: the client half of the anonymous-analysis Turnstile
 * gate — the server half (security/turnstile.ts's verifyTurnstileToken())
 * fails closed regardless of whether this even renders, so an unset
 * NEXT_PUBLIC_TURNSTILE_SITE_KEY degrades to "anonymous analysis is
 * unavailable" rather than silently skipping verification, matching the
 * SCHEDULER_SECRET precedent already documented in
 * docs/environment-variables.md.
 */

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: HTMLElement,
        opts: { sitekey: string; callback: (token: string) => void; "expired-callback"?: () => void; "error-callback"?: () => void },
      ) => string;
      remove: (widgetId: string) => void;
    };
  }
}

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js";
let scriptLoadPromise: Promise<void> | null = null;

function loadTurnstileScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.turnstile) return Promise.resolve();
  if (!scriptLoadPromise) {
    scriptLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = SCRIPT_SRC;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Failed to load Turnstile"));
      document.head.appendChild(script);
    });
  }
  return scriptLoadPromise;
}

export interface TurnstileWidgetProps {
  onToken: (token: string | null) => void;
}

export function TurnstileWidget({ onToken }: TurnstileWidgetProps) {
  const containerId = useId();
  const widgetIdRef = useRef<string | null>(null);
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

  useEffect(() => {
    if (!siteKey) return;
    let cancelled = false;

    loadTurnstileScript()
      .then(() => {
        if (cancelled) return;
        const container = document.getElementById(containerId);
        if (!container || !window.turnstile) return;
        widgetIdRef.current = window.turnstile.render(container, {
          sitekey: siteKey,
          callback: (token) => onToken(token),
          "expired-callback": () => onToken(null),
          "error-callback": () => onToken(null),
        });
      })
      .catch(() => onToken(null));

    return () => {
      cancelled = true;
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onToken is expected to be stable per mount; re-subscribing per-render would re-render the widget
  }, [siteKey, containerId]);

  if (!siteKey) {
    // No site key configured (local dev without Turnstile set up) — the
    // server-side check still fails closed; this just avoids rendering a
    // broken widget nobody can complete.
    return (
      <p className="mt-3 font-mono text-[11px] text-muted-dim">
        Anonymous analysis is unavailable in this environment (verification not configured). Sign in to analyze.
      </p>
    );
  }

  return <div id={containerId} className="mt-3" />;
}
