"use client";

import { useState } from "react";
import { TurnstileWidget } from "./TurnstileWidget";

export interface StoreUrlInputProps {
  onSubmit: (url: string) => void;
  disabled?: boolean;
  /** Milestone 12 §1.3: only an anonymous (signed-out) caller needs Turnstile — a signed-in request skips it entirely. */
  requireTurnstile?: boolean;
  turnstileToken?: string | null;
  onTurnstileToken?: (token: string | null) => void;
}

const DEMO_URLS = ["allbirds.com", "gymshark.com", "kyliecosmetics.com"];

function validate(raw: string): { domain: string } | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { error: "Enter a store URL to analyze." };

  const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { error: "Enter a full store URL, like https://store-name.com" };
  }

  if (!/^https?:$/.test(parsed.protocol)) {
    return { error: "Only http and https URLs can be analyzed." };
  }
  const host = parsed.hostname.toLowerCase();
  if (!host.includes(".") || /\s/.test(trimmed)) {
    return { error: "That doesn't look like a valid domain. Check for typos and try again." };
  }
  return { domain: candidate };
}

export function StoreUrlInput({
  onSubmit,
  disabled,
  requireTurnstile = false,
  turnstileToken = null,
  onTurnstileToken,
}: StoreUrlInputProps) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit() {
    const result = validate(value);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    if (requireTurnstile && !turnstileToken) {
      setError("Please complete the verification below.");
      return;
    }
    setError(null);
    onSubmit(result.domain);
  }

  return (
    <div className="mx-auto mt-9 max-w-[660px]">
      <div className="flex flex-col gap-2.5 sm:flex-row">
        <input
          className={`min-w-0 flex-1 rounded-lg border bg-surface px-4 py-3.5 font-mono text-[14.5px] text-paper placeholder:text-muted-dim focus:outline-none focus:ring-2 ${
            error ? "border-sig-stock ring-2 ring-sig-stock/10" : "border-line focus:border-sig-price focus:ring-sig-price/10"
          }`}
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://competitor-store.com"
          aria-label="Shopify store URL"
          aria-invalid={error ? "true" : "false"}
          value={value}
          disabled={disabled}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        <button
          className="rounded-md bg-sig-price px-6 py-3.5 font-mono text-sm font-semibold text-[#1A1204] transition hover:-translate-y-px hover:bg-[#FFC44D] disabled:cursor-not-allowed disabled:opacity-60"
          onClick={submit}
          disabled={disabled}
        >
          Analyze store
        </button>
      </div>
      {error && (
        <p className="mt-2.5 text-left font-mono text-[12.5px] text-sig-stock" role="alert">
          {error}
        </p>
      )}
      {requireTurnstile && onTurnstileToken && <TurnstileWidget onToken={onTurnstileToken} />}
      <p className="mt-3.5 font-mono text-xs text-muted-dim">
        {requireTurnstile ? "3 free analyses per day · no account required" : "First analysis is free · no account required"}
      </p>

      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <span className="self-center font-mono text-[11px] tracking-wider text-muted-dim">TRY:</span>
        {DEMO_URLS.map((demo) => (
          <button
            key={demo}
            className="rounded-full border border-line-soft px-3.5 py-1.5 font-mono text-xs text-muted transition hover:border-muted hover:text-paper"
            onClick={() => {
              setValue(demo);
              setError(null);
            }}
          >
            {demo}
          </button>
        ))}
      </div>
    </div>
  );
}
