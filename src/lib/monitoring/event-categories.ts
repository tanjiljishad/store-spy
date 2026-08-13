/**
 * The technology-intelligence subset of EventType — mirrors marketing/
 * event-types.ts's MARKETING_EVENT_TYPES exactly (same pattern, same
 * purpose: filter the existing change feed to one conceptual category via
 * the events route's already-proven `eventTypes` param, no new query).
 * Matches docs/milestone-7-intelligence-productization-research.md Section
 * 12's "Technology" category.
 */
export const TECHNOLOGY_EVENT_TYPES = [
  "APP_ADDED",
  "APP_REMOVED",
  "PIXEL_ADDED",
  "PIXEL_REMOVED",
  "PAYMENT_PROVIDER_ADDED",
  "PAYMENT_PROVIDER_REMOVED",
  "THEME_CHANGED",
  "COLLECTION_ADDED",
  "COLLECTION_REMOVED",
] as const;
