/**
 * @fileoverview `billable_usage` — actual billed usage & cost from Cloudflare's
 * Billable Usage API (launched Agents Week 2026).
 *
 * The rest of Guardian *reconstructs* cost from usage + curated overage rates
 * ({@link file://src/backend/guardian/daily-cost.ts}) because, historically,
 * Cloudflare exposed no cost API — only the billing dashboard's UI numbers.
 * The Billable Usage API changes that: it returns the real charged amount per
 * product per charge period. This table persists that ground truth so the panel
 * can chart *billed* dollars and reconcile them against the reconstructed
 * estimate (the estimate-accuracy signal).
 *
 * One row = one product's charge for one charge period (daily granularity),
 * optionally per zone. PK is deterministic (`chargePeriodStart:service:zoneId`)
 * so re-syncing the same window upserts rather than duplicating.
 *
 * @see https://blog.cloudflare.com/billable-usage-api/
 * @see {@link file://src/backend/guardian/billable-usage.ts} for the client/report.
 */

import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const BILLABLE_USAGE_TABLE_DESCRIPTION =
  "Actual billed usage and cost per Cloudflare product per charge period, from the Billable Usage API. Unlike daily_cost (reconstructed estimate) these are the real charged amounts.";

export const BILLABLE_USAGE_COLUMN_DESCRIPTIONS: Record<string, string> = {
  id: "Deterministic key: chargePeriodStart:serviceName:zoneId.",
  day: "UTC date bucket of the charge period start (YYYY-MM-DD).",
  day_start: "Unix ms at the start of `day` (for range queries).",
  charge_period_start: "ISO start of the charge period (from the API).",
  charge_period_end: "ISO end of the charge period (from the API).",
  billing_period_start: "ISO start of the billing period this charge rolls up into.",
  service_name: "Cloudflare product name (e.g. Workers Paid, R2, Workers AI).",
  service_family: "Product family grouping (from the API).",
  consumed_quantity: "Metered usage in `consumed_unit`.",
  consumed_unit: "Unit of consumed_quantity (requests, GB-months, neurons, …).",
  pricing_quantity: "Billable quantity after included-allowance deduction.",
  contracted_cost: "Actual USD (or billing-currency) charged for this row.",
  currency: "Billing currency for contracted_cost.",
  zone_id: 'Zone the charge is attributed to, or "" for account-level.',
  zone_name: "Zone name, when zone-scoped.",
  zone_fk: "Relational link to zones.id (null for account-level charges).",
  captured_at: "Unix ms this row was fetched/updated.",
};

export const billableUsage = sqliteTable(
  "billable_usage",
  {
    id: text("id").primaryKey(),
    day: text("day").notNull(),
    dayStart: integer("day_start").notNull(),
    chargePeriodStart: text("charge_period_start").notNull(),
    chargePeriodEnd: text("charge_period_end").notNull().default(""),
    billingPeriodStart: text("billing_period_start").notNull().default(""),
    serviceName: text("service_name").notNull(),
    serviceFamily: text("service_family").notNull().default(""),
    consumedQuantity: real("consumed_quantity").notNull().default(0),
    consumedUnit: text("consumed_unit").notNull().default(""),
    pricingQuantity: real("pricing_quantity").notNull().default(0),
    contractedCost: real("contracted_cost").notNull().default(0),
    currency: text("currency").notNull().default("USD"),
    zoneId: text("zone_id").notNull().default(""),
    zoneName: text("zone_name").notNull().default(""),
    // Relational link to `zones.id` (null for account-level charges). The raw
    // `zone_id` above is the API value; this is the resolved relation.
    zoneFk: text("zone_fk"),
    capturedAt: integer("captured_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => [
    index("idx_billable_usage_day_start").on(t.dayStart),
    // Freshness probe `ORDER BY captured_at DESC LIMIT 1` was scanning ~1.3k rows
    // per call; this serves it as a reverse index seek.
    index("idx_billable_usage_captured_at").on(t.capturedAt),
  ],
);

export const insertBillableUsageSchema = createInsertSchema(billableUsage);
export const selectBillableUsageSchema = createSelectSchema(billableUsage);
export type BillableUsageRow = typeof billableUsage.$inferSelect;
export type NewBillableUsageRow = typeof billableUsage.$inferInsert;
