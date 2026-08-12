"use client";

const TIERS = [
  {
    name: "Free",
    price: "$0",
    period: null,
    who: "Full intelligence on your first 3 competitors.",
    features: [
      "3 unique stores, full intelligence unlocked",
      "Complete app & technology stack",
      "Product, price & activity history",
      "Monitor 1 store free for 30 days",
    ],
    cta: "Current plan",
    highlighted: false,
  },
  {
    name: "Pro",
    price: "$29",
    period: "/month",
    who: "For operators tracking their direct competitors.",
    features: [
      "25 unique stores analyzed",
      "Monitor 10 stores · faster crawl cadence",
      "Continuous monitoring, no 30-day limit",
      "Change alerts & price history",
    ],
    cta: "Start Pro",
    highlighted: true,
  },
  {
    name: "Business",
    price: "$79",
    period: "/month",
    who: "For brands watching a whole category.",
    features: ["Everything in Pro", "Monitor 50 stores · 2× daily crawl", "CSV & API exports", "Advanced analytics", "Priority processing"],
    cta: "Start Business",
    highlighted: false,
  },
  {
    name: "Agency",
    price: "$149",
    period: "/month",
    who: "For agencies reporting to clients.",
    features: ["Everything in Business", "Multiple projects & team seats", "200+ monitored stores", "White-label client reports", "Full API access"],
    cta: "Start Agency",
    highlighted: false,
  },
];

export interface PricingSectionProps {
  /** No billing integration yet (see brief: full billing is a later phase) — this reports the click so the page can surface a toast instead of navigating anywhere. */
  onPlanSelected: (message: string) => void;
}

export function PricingSection({ onPlanSelected }: PricingSectionProps) {
  return (
    <section id="pricing" className="mt-20 border-t border-line-soft py-20">
      <div className="mx-auto max-w-[1180px] px-7">
        <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-dim">Pricing</span>
        <h2 className="mt-3.5 font-display text-4xl font-bold tracking-tight">Pay for intelligence, not exports</h2>
        <p className="mt-3.5 max-w-[58ch] text-[16.5px] text-muted">
          Every paid plan includes full store intelligence and continuous monitoring. Cancel anytime.
        </p>

        <div className="mt-10 grid grid-cols-1 items-start gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {TIERS.map((tier) => (
            <div
              key={tier.name}
              className={`relative rounded-xl border p-6 ${
                tier.highlighted ? "border-sig-price/40 bg-surface" : "border-line-soft bg-surface"
              }`}
            >
              {tier.highlighted && (
                <span className="absolute -top-2.5 left-6 rounded-sm bg-sig-price px-2.5 py-1 font-mono text-[9.5px] font-semibold tracking-wider text-[#1A1204]">
                  MOST PICKED
                </span>
              )}
              <h3 className="font-mono text-[11.5px] font-semibold uppercase tracking-wider text-muted-dim">{tier.name}</h3>
              <div className="mt-3 font-display text-[38px] font-bold tracking-tight">
                {tier.price}
                {tier.period && <small className="font-mono text-xs font-normal text-muted-dim">{tier.period}</small>}
              </div>
              <p className="mt-1 min-h-[40px] text-[13px] text-muted">{tier.who}</p>
              <ul className="my-5 text-[13.5px]">
                {tier.features.map((f) => (
                  <li key={f} className="relative py-1.5 pl-[18px] text-muted">
                    <span className="absolute left-[5px] font-bold text-sig-price">·</span>
                    {f}
                  </li>
                ))}
              </ul>
              <button
                className={`block w-full rounded-md py-2.5 text-center font-mono text-[13px] font-semibold transition ${
                  tier.highlighted
                    ? "bg-sig-price text-[#1A1204] hover:-translate-y-px hover:bg-[#FFC44D]"
                    : "border border-line text-paper hover:border-muted hover:bg-surface-2"
                }`}
                onClick={() =>
                  onPlanSelected(
                    tier.name === "Free"
                      ? "You are on the Free plan"
                      : `${tier.name} checkout — connects to billing in the production app`,
                  )
                }
              >
                {tier.cta}
              </button>
            </div>
          ))}
        </div>

        <p className="mt-7 text-center font-mono text-[11.5px] text-muted-dim">
          Analyzes publicly observable storefront data only · responsible crawl rates · no access to any merchant&apos;s private admin
        </p>
      </div>
    </section>
  );
}
