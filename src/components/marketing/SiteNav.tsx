"use client";

import { useSession } from "next-auth/react";

export interface SiteNavProps {
  onHome: () => void;
}

export function SiteNav({ onHome }: SiteNavProps) {
  const { data: session, status } = useSession();

  return (
    <nav className="sticky top-0 z-40 border-b border-line-soft bg-ink/85 backdrop-blur-lg">
      <div className="mx-auto flex h-[62px] max-w-[1180px] items-center justify-between px-7">
        <button
          className="flex items-center gap-2.5 font-display text-[17px] font-bold tracking-tight"
          onClick={onHome}
        >
          <span className="h-[11px] w-[11px] rounded-sm bg-sig-price shadow-[0_0_0_4px_rgba(255,182,39,0.14)]" />
          Bellwether
        </button>
        <div className="hidden gap-7 font-mono text-sm text-muted sm:flex">
          <button className="transition hover:text-paper" onClick={onHome}>
            Analyze a store
          </button>
          <a className="transition hover:text-paper" href="#pricing">
            Pricing
          </a>
        </div>
        {status === "authenticated" && session.user ? (
          <a
            className="rounded-md border border-line px-[18px] py-2.5 font-mono text-[13px] font-semibold text-paper transition hover:border-muted hover:bg-surface"
            href="/dashboard"
          >
            Dashboard
          </a>
        ) : (
          <div className="flex items-center gap-2.5">
            <a
              className="hidden font-mono text-[13px] font-semibold text-muted transition hover:text-paper sm:inline"
              href="/login"
            >
              Sign in
            </a>
            <a
              className="rounded-md bg-sig-price px-[18px] py-2.5 font-mono text-[13px] font-semibold text-[#1A1204] transition hover:-translate-y-px hover:bg-[#FFC44D]"
              href="/signup"
            >
              Sign up free
            </a>
          </div>
        )}
      </div>
    </nav>
  );
}
