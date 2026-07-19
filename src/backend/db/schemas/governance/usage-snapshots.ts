/**
 * @fileoverview `usage_snapshots` table — hourly per-binding usage readings.
 *
 * Written by the Core Guardian cron (`evaluateUsage`) once per hour, one row
 * per metered probe. Retained so the panel can show a trend without re-querying
 * the Cloudflare GraphQL Analytics API on every page load.
 *
 * @see {@link file://src/backend/guardian/collect.ts} for the writer.
 */

import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

// ---------------------------------------------------------------------------
// Table & column documentation (consumed by /api/docs/schema)
// ---------------------------------------------------------------------------

export const USAGE_SNAPSHOTS_TABLE_DESCRIPTION =
  "Hourly usage readings per Cloudflare binding type, captured by the Core Guardian cron from the GraphQL Analytics API.";

export const USAGE_SNAPSHOTS_COLUMN_DESCRIPTIONS: Record<string, string> = {
  id: "Unique snapshot identifier (UUID v4).",
  service: "Probe id (e.g. d1, r2-operations, workers-ai).",
  metric: "Unit of the recorded value (e.g. rows read, requests, bytes stored).",
  value: "Headline value for the window.",
  window_hours: "Width of the aggregation window in hours.",
  timestamp: "Unix timestamp (ms) when the reading was captured.",
};

// ---------------------------------------------------------------------------
// Table definition
// ---------------------------------------------------------------------------

export const usageSnapshots = sqliteTable("usage_snapshots", {
  id: text("id").primaryKey(),
  service: text("service").notNull(),
  metric: text("metric").notNull(),
  value: real("value").notNull().default(0),
  windowHours: integer("window_hours").notNull().default(1),
  timestamp: integer("timestamp")
    .notNull()
    .$defaultFn(() => Date.now()),
});

// ---------------------------------------------------------------------------
// Zod schemas & types
// ---------------------------------------------------------------------------

export const insertUsageSnapshotSchema = createInsertSchema(usageSnapshots);
export const selectUsageSnapshotSchema = createSelectSchema(usageSnapshots);
export type UsageSnapshotRow = typeof usageSnapshots.$inferSelect;
export type NewUsageSnapshotRow = typeof usageSnapshots.$inferInsert;
