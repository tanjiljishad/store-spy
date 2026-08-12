export interface FreeReportStripProps {
  report: {
    productCount: number;
    theme: { name: string | null; version: string | null };
  };
}

/** The three things every visitor gets for free, straight from the persisted crawl — nothing modeled or estimated here. */
export function FreeReportStrip({ report }: FreeReportStripProps) {
  return (
    <div className="grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-line bg-line-soft sm:grid-cols-3">
      <Cell k="Platform" v="Shopify" s="Verified from storefront signatures" />
      <Cell
        k="Products"
        v={report.productCount.toLocaleString("en-US")}
        s={report.productCount === 1 ? "product found" : "products found"}
      />
      <Cell
        k="Theme"
        v={report.theme.name ?? "Not detected"}
        s={report.theme.version ? `v${report.theme.version}` : "version not exposed by this store"}
      />
    </div>
  );
}

function Cell({ k, v, s }: { k: string; v: string; s: string }) {
  return (
    <div className="relative bg-surface p-5 sm:p-[22px]">
      <span className="absolute right-[18px] top-4 font-mono text-[10px] tracking-wider text-ok">DETECTED</span>
      <div className="font-mono text-[10.5px] uppercase tracking-wider text-muted-dim">{k}</div>
      <div className="mt-2 font-display text-[26px] font-bold tracking-tight">{v}</div>
      <div className="mt-1 font-mono text-[11.5px] text-muted">{s}</div>
    </div>
  );
}
