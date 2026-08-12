import type { ReactNode } from "react";

export function SectionLabel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`mb-4 font-mono text-[11px] uppercase tracking-[0.16em] text-muted-dim ${className}`}>
      {children}
    </div>
  );
}
