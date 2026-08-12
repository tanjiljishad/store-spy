const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Pure by convention (now defaults but is always overridable) — kept out of
 * any component body on purpose. React's render-purity lint rule flags
 * Date.now()/new Date() called directly inside a component function; the
 * fix is never a suppression, it's moving the impure default into a plain
 * function the component merely calls. See getDashboardSummary() for the
 * same pattern already established in this codebase.
 */
export function daysRemaining(expiresAt: Date, now: Date = new Date()): number {
  return Math.max(0, Math.ceil((expiresAt.getTime() - now.getTime()) / DAY_MS));
}
