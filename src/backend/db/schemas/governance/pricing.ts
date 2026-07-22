/**
 * @fileoverview Pricing catalog tables — `scrape_runs` and `pricing_revisions`.
 *
 * Cloudflare exposes no pricing API, so overage unit rates are scraped from the
 * public pricing docs on a monthly cadence (Browser Rendering: `/json` with a
 * schema first, falling back to `/markdown` + a Workers AI extraction pass).
 *
 * - `scrape_runs`  — one row per doc fetched: url, when, status, and the raw
 *   markdown/json kept for audit and re-extraction without re-fetching.
 * - `pricing_revisions` — the extracted rates, one row per (product, metric).
 *   Append-only and versioned by `scrape_run_id`; the spend calc joins the
 *   latest effective revision per metric. A rate that changes writes a new row,
 *   never mutates the old — the history is the point.
 *
 * @see {@link file://src/backend/guardian/pricing-scrape.ts} for the writer.
 */

import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

// ---------------------------------------------------------------------------
// Documentation (consumed by /api/docs/schema)
// ---------------------------------------------------------------------------

export const SCRAPE_RUNS_TABLE_DESCRIPTION =
  "One row per pricing-doc scrape: the source URL, outcome, and the raw markdown/json retained for re-extraction.";

export const SCRAPE_RUNS_COLUMN_DESCRIPTIONS: Record<string, string> = {
  id: "Unique scrape identifier (UUID v4).",
  url: "Pricing doc URL that was fetched.",
  product: "Product key the doc covers (e.g. d1, r2, kv), for grouping.",
  status: "ok | partial | failed — extraction outcome.",
  method: "json | markdown_ai — which Browser Rendering path produced the data.",
  markdown: "Raw markdown returned by Browser Rendering (null on the json path).",
  raw_json: "Raw JSON string returned/extracted (null when only markdown landed).",
  revisions_written: "Count of pricing_revisions rows this run produced.",
  error: "Failure detail when status != ok.",
  ran_at: "Unix timestamp (ms) when the scrape completed.",
};

export const PRICING_REVISIONS_TABLE_DESCRIPTION =
  "Extracted overage unit rates, one row per (product, metric). Append-only and versioned by scrape_run_id; the spend calc joins the latest effective revision.";

export const PRICING_REVISIONS_COLUMN_DESCRIPTIONS: Record<string, string> = {
  id: "Unique revision identifier (UUID v4).",
  scrape_run_id: "FK → scrape_runs.id that produced this revision.",
  product: "Product key (e.g. d1, r2, workers-ai).",
  metric: "Metered unit the rate applies to (e.g. 'rows read', 'GB stored/mo').",
  unit_price: "Price in `currency` per one `metric` unit (or per `per_units`).",
  per_units: "Number of metric units the unit_price covers (e.g. 1_000_000 for '$/million').",
  currency: "ISO currency (always USD for Cloudflare).",
  included: "Free included allowance stated in the doc, if any.",
  effective_from: "Unix timestamp (ms) the rate became effective (scrape time).",
};

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export const scrapeRuns = sqliteTable("scrape_runs", {
  id: text("id").primaryKey(),
  url: text("url").notNull(),
  product: text("product").notNull(),
  status: text("status", { enum: ["ok", "partial", "failed"] }).notNull(),
  method: text("method", { enum: ["json", "markdown_ai", "none"] }).notNull(),
  markdown: text("markdown"),
  rawJson: text("raw_json"),
  revisionsWritten: integer("revisions_written").notNull().default(0),
  error: text("error"),
  ranAt: integer("ran_at")
    .notNull()
    .$defaultFn(() => Date.now()),
});

export const pricingRevisions = sqliteTable("pricing_revisions", {
  id: text("id").primaryKey(),
  scrapeRunId: text("scrape_run_id").notNull(),
  product: text("product").notNull(),
  metric: text("metric").notNull(),
  unitPrice: real("unit_price").notNull(),
  perUnits: real("per_units").notNull().default(1),
  currency: text("currency").notNull().default("USD"),
  included: real("included"),
  effectiveFrom: integer("effective_from")
    .notNull()
    .$defaultFn(() => Date.now()),
});

// ---------------------------------------------------------------------------
// Zod schemas & types
// ---------------------------------------------------------------------------

export const insertScrapeRunSchema = createInsertSchema(scrapeRuns);
export const selectScrapeRunSchema = createSelectSchema(scrapeRuns);
export type ScrapeRunRow = typeof scrapeRuns.$inferSelect;
export type NewScrapeRunRow = typeof scrapeRuns.$inferInsert;

export const insertPricingRevisionSchema = createInsertSchema(pricingRevisions);
export const selectPricingRevisionSchema = createSelectSchema(pricingRevisions);
export type PricingRevisionRow = typeof pricingRevisions.$inferSelect;
export type NewPricingRevisionRow = typeof pricingRevisions.$inferInsert;
