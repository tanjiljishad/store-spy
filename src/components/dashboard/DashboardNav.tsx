"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";

export interface DashboardNavProps {
  email: string;
}

const LINKS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/dashboard/watchlist", label: "Watchlist" },
];

export function DashboardNav({ email }: DashboardNavProps) {
  const pathname = usePathname();

  return (
    <nav className="sticky top-0 z-40 border-b border-line-soft bg-ink/85 backdrop-blur-lg">
      <div className="mx-auto flex h-[62px] max-w-[1180px] items-center justify-between px-7">
        <div className="flex items-center gap-8">
          <Link href="/" className="flex items-center gap-2.5 font-display text-[17px] font-bold tracking-tight">
            <span className="h-[11px] w-[11px] rounded-sm bg-sig-price shadow-[0_0_0_4px_rgba(255,182,39,0.14)]" />
            Bellwether
          </Link>
          <div className="hidden gap-6 font-mono text-sm sm:flex">
            {LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={`transition hover:text-paper ${pathname === link.href ? "text-paper" : "text-muted"}`}
              >
                {link.label}
              </Link>
            ))}
            <Link href="/" className="text-muted transition hover:text-paper">
              Analyze a store
            </Link>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <span className="hidden font-mono text-[12.5px] text-muted-dim sm:inline">{email}</span>
          <button
            className="rounded-md border border-line px-4 py-2 font-mono text-[12.5px] font-semibold text-paper transition hover:border-muted hover:bg-surface"
            onClick={() => signOut({ callbackUrl: "/" })}
          >
            Sign out
          </button>
        </div>
      </div>
    </nav>
  );
}
