"use client";

const TIERS = [
  {
    name: "Free",
    price: "$0",
    period: null,
    who: "For researching any Shopify store.",
    features: ["Unlimited store analysis", "Complete app & technology stack", "Product, price & activity history", "Monitor 1 store"],
    cta: "Current plan",
    highlighted: false,
  },
  {
    name: "Paid",
    price: "~$19",
    period: "/month",
    who: "For monitoring multiple stores at scale.",
    features: ["Unlimited store analysis", "Monitor up to 10 stores", "Same monitoring cadence as Free", "Full Store Intelligence"],
    cta: "Coming soon",
    highlighted: true,
  },
];

export interface PricingSectionProps {
  /** Billing is not implemented. The parent surfaces this honest status without navigating to checkout. */
  onPlanSelected: (message: string) => void;
}

export function PricingSection({ onPlanSelected }: PricingSectionProps) {
  return (
    <section id="pricing" className="mt-20 border-t border-line-soft py-20">
      <div className="mx-auto max-w-[1180px] px-7">
        <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-dim">Pricing</span>
        <h2 className="mt-3.5 font-display text-4xl font-bold tracking-tight">Analyze freely. Monitor at scale.</h2>
        <p className="mt-3.5 max-w-[58ch] text-[16.5px] text-muted">
          Store intelligence is free. Paid monitoring for up to 10 stores is coming soon; no checkout is available yet.
        </p>

        <div className="mt-10 grid grid-cols-1 items-start gap-5 sm:grid-cols-2">
          {TIERS.map((tier) => (
            <div
              key={tier.name}
              className={`relative rounded-xl border p-6 ${tier.highlighted ? "border-sig-price/40 bg-surface" : "border-line-soft bg-surface"}`}
            >
              {tier.highlighted && (
                <span className="absolute -top-2.5 left-6 rounded-sm bg-sig-price px-2.5 py-1 font-mono text-[9.5px] font-semibold tracking-wider text-[#1A1204]">
                  COMING SOON
                </span>
              )}
              <h3 className="font-mono text-[11.5px] font-semibold uppercase tracking-wider text-muted-dim">{tier.name}</h3>
              <div className="mt-3 font-display text-[38px] font-bold tracking-tight">
                {tier.price}
                {tier.period && <small className="font-mono text-xs font-normal text-muted-dim">{tier.period}</small>}
              </div>
              <p className="mt-1 min-h-[40px] text-[13px] text-muted">{tier.who}</p>
              <ul className="my-5 text-[13.5px]">
                {tier.features.map((feature) => (
                  <li key={feature} className="relative py-1.5 pl-[18px] text-muted">
                    <span className="absolute left-[5px] font-bold text-sig-price">·</span>
                    {feature}
                  </li>
                ))}
              </ul>
              <button
                className={`block w-full rounded-md py-2.5 text-center font-mono text-[13px] font-semibold transition ${tier.highlighted ? "bg-sig-price text-[#1A1204] hover:-translate-y-px hover:bg-[#FFC44D]" : "border border-line text-paper hover:border-muted hover:bg-surface-2"}`}
                onClick={() => onPlanSelected(tier.name === "Free" ? "Free includes unlimited store analysis." : "Paid monitoring is coming soon.")}
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
