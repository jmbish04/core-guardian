/**
 * @fileoverview `daily_cost` — one reconstructed USD cost per service per UTC day.
 *
 * Cloudflare exposes NO cost API; the billing dashboard's dollar figures live
 * only in that UI. This table reconstructs them: the hourly Guardian cron
 * writes raw usage to `usage_snapshots` (neurons, rows read, bytes…), and the
 * daily rollup sums a day's snapshots per service and prices them against the
 * curated overage rates in {@link file://src/backend/guardian/allowances.ts}.
 * Persisting the daily figure lets the panel chart day-over-day cost movement
 * (flat vs climbing) without re-summing every page load, and keeps history past
 * the ~31-day GraphQL retention window.
 *
 * A `dimension` of "" is the service headline for the day. Non-empty dimension
 * rows carry a sub-breakdown — currently Workers AI neurons per `modelId` — so
 * the 80%-of-spend neuron line can be attributed to a model.
 *
 * `costUsd` is NULL when no overage rate is known for the service (e.g. DO
 * compute duration, R2 operations, KV) — those are shown as raw usage only,
 * never an invented dollar figure. `basis` records how a non-null cost was
 * derived so nothing is presented as authoritative when it is an estimate.
 *
 * PK is deterministic (`day:service:dimension`) so a re-snapshot of the same
 * day upserts rather than duplicating.
 *
 * @see {@link file://src/backend/guardian/daily-cost.ts} for the writer/report.
 */

import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

// ---------------------------------------------------------------------------
// Table & column documentation (consumed by /api/docs/schema)
// ---------------------------------------------------------------------------

export const DAILY_COST_TABLE_DESCRIPTION =
  "Daily reconstructed USD cost per Cloudflare service, summed from usage_snapshots and priced against the curated overage rates. Retained permanently for day-over-day trend.";

export const DAILY_COST_COLUMN_DESCRIPTIONS: Record<string, string> = {
  id: "Deterministic key: day:service:dimension.",
  day: "UTC date bucket (YYYY-MM-DD).",
  day_start: "Unix ms at the start of the day bucket (for range queries).",
  service: "Probe id the usage came from (e.g. workers-ai, d1, durable-objects-cpu).",
  product: "Human product name (e.g. Workers AI).",
  dimension:
    'Sub-breakdown key: "" for the service headline, else a modelId (Workers AI neuron split).',
  unit: "Unit of raw_usage (neurons, rows read, bytes stored, …).",
  raw_usage: "Summed usage for the day in `unit`.",
  cost_usd: "Reconstructed USD cost, or NULL when no overage rate is known for the service.",
  basis:
    "How cost_usd was derived (overage@daily-reset, marginal@monthly, marginal@model, no-rate).",
  captured_at: "Unix ms this row was written/updated.",
};

// ---------------------------------------------------------------------------
// Table definition
// ---------------------------------------------------------------------------

export const dailyCost = sqliteTable(
  "daily_cost",
  {
    id: text("id").primaryKey(),
    day: text("day").notNull(),
    dayStart: integer("day_start").notNull(),
    service: text("service").notNull(),
    product: text("product").notNull(),
    dimension: text("dimension").notNull().default(""),
    unit: text("unit").notNull(),
    rawUsage: real("raw_usage").notNull().default(0),
    costUsd: real("cost_usd"),
    basis: text("basis").notNull(),
    capturedAt: integer("captured_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => [
    // The report filters `dayStart >= cutoff`; index the range so it never scans.
    index("idx_daily_cost_day_start").on(t.dayStart),
    // Freshness probe `ORDER BY captured_at DESC LIMIT 1` was scanning ~1.1k rows
    // per call; this serves it as a reverse index seek.
    index("idx_daily_cost_captured_at").on(t.capturedAt),
  ],
);

// ---------------------------------------------------------------------------
// Zod schemas & types
// ---------------------------------------------------------------------------

export const insertDailyCostSchema = createInsertSchema(dailyCost);
export const selectDailyCostSchema = createSelectSchema(dailyCost);
export type DailyCostRow = typeof dailyCost.$inferSelect;
export type NewDailyCostRow = typeof dailyCost.$inferInsert;
