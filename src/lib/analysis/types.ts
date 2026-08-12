import type { CrawlPhase } from "../crawl/shopify";
import type { IntelligenceField } from "./report-contract";
import type { Limit } from "../entitlements/plan-limits";

/**
 * Typed job lifecycle — nothing downstream should compare against a raw
 * string literal for these. Maps onto crawlShopifyStore()'s CrawlResult
 * status, but is its own vocabulary: this is what the PRODUCT calls each
 * outcome, not what the crawler internally calls it.
 */
export type AnalysisStatus =
  | "validating"
  | "shopify_detection"
  | "crawling"
  | "persisting"
  | "analyzing"
  | "completed"
  | "invalid_url"
  | "non_shopify"
  | "unreachable"
  | "crawl_incomplete"
  | "analysis_limit_reached"
  | "failed";

export const FAILURE_STATUSES: ReadonlySet<AnalysisStatus> = new Set([
  "invalid_url",
  "non_shopify",
  "unreachable",
  "crawl_incomplete",
  "analysis_limit_reached",
  "failed",
]);

/**
 * Monitoring status is free, not premium — it's "is this being watched and
 * when did we last check", not intelligence about the store itself.
 * totalCrawls drives the frontend's "only crawled once, don't show fake
 * history" guard: it's the real count of completed OK/PARTIAL crawls.
 */
export interface MonitoringStatus {
  tier: "HOT" | "WARM" | "COOL" | "COLD" | "DORMANT" | "DISABLED";
  active: boolean;
  lastCrawledAt: string | null;
  nextCrawlAt: string | null;
  totalCrawls: number;
}

/**
 * What a non-entitled caller gets — a genuine result from a real crawl
 * (never fabricated), deliberately narrow. No `{ locked: true }` teaser
 * fields: a non-entitled request simply doesn't receive the rest of the
 * report at all. `access` is the discriminant the frontend and every route
 * branch on, and it distinguishes *why* the view is truncated: not signed
 * in at all, vs. signed in but this particular store hasn't been spent as
 * one of the user's 3 analyses yet.
 */
interface PreviewReportFields {
  domain: string;
  platform: "shopify";
  productCount: number;
  theme: { name: string | null; version: string | null };
  checkedAt: string;
  cta: string;
}
export interface AnonymousPreviewReport extends PreviewReportFields {
  access: "anonymous_preview";
}
export interface UnanalyzedPreviewReport extends PreviewReportFields {
  access: "unanalyzed_preview";
}

/**
 * The complete currently-supported intelligence report for a signed-in,
 * entitled user (Milestone 3). Every field that carries real intelligence
 * is wrapped in an IntelligenceField so the client always knows whether
 * it's looking at an observed fact, an estimate, an inference, or
 * something genuinely not built yet — see report-contract.ts. There is no
 * separate "full" object this gets sliced from later; this project has one
 * report builder per access level, and this IS what full access returns.
 */
export interface FullStoreReport {
  access: "full";
  domain: string;
  platform: "shopify";
  checkedAt: string;
  productCount: IntelligenceField<number>;
  theme: IntelligenceField<{ name: string | null; version: string | null }>;
  apps: IntelligenceField<string[]>;
  /** Detected via the same homepage-fingerprint pass as apps (fingerprint.ts's PIXEL_SIGNATURES) — collected since Milestone 1, never surfaced until now. */
  pixels: IntelligenceField<string[]>;
  /** Same pattern as pixels — fingerprint.ts's PAYMENT_SIGNATURES. */
  paymentProviders: IntelligenceField<string[]>;
  averagePrice: IntelligenceField<number>;
  /** Reserved shape for when a validated model exists — see AGENTS.md / Milestone 3 report. Always UNAVAILABLE today. */
  revenue: IntelligenceField<{ minCents: number; maxCents: number }>;
  traffic: IntelligenceField<{ monthlyVisits: number }>;
  reviewVelocity: IntelligenceField<{ reviewsPerMonth: number }>;
  monitoring: MonitoringStatus;
  entitlement: { analysesUsed: number; analysesLimit: Limit; alreadyAnalyzed: boolean };
}

export type AnalysisReport = AnonymousPreviewReport | UnanalyzedPreviewReport | FullStoreReport;

export type AnalysisSseEvent =
  | { type: "status"; status: AnalysisStatus }
  | { type: "progress"; phase: CrawlPhase; message: string; detail?: Record<string, unknown> }
  | { type: "complete"; report: AnalysisReport }
  | { type: "error"; status: AnalysisStatus; message: string; retryable: boolean };
