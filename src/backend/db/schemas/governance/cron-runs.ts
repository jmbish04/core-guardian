/**
 * @fileoverview `cron_runs` table — heartbeat for the hourly Guardian cron.
 *
 * One row per `scheduled()` invocation, written whether the run succeeded or
 * failed. Without this, a cron that silently stops firing looks identical to a
 * cron that runs and finds nothing wrong — the panel would show stale numbers
 * with no indication anything is broken.
 *
 * @remarks One row per hour is ~8.8k rows/year. Prune beyond 30 days if that
 * ever matters; at this volume it does not.
 *
 * @see {@link file://src/backend/guardian/collect.ts} for the writer.
 */

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

// ---------------------------------------------------------------------------
// Table & column documentation (consumed by /api/docs/schema)
// ---------------------------------------------------------------------------

export const CRON_RUNS_TABLE_DESCRIPTION =
  "Execution heartbeat for the hourly Core Guardian usage evaluation. One row per scheduled() invocation.";

export const CRON_RUNS_COLUMN_DESCRIPTIONS: Record<string, string> = {
  id: "Unique run identifier (UUID v4).",
  ran_at: "Unix timestamp (ms) when the run started.",
  duration_ms: "Wall-clock duration of the run.",
  probes_ok: "Number of probes that returned data.",
  probes_failed: "Number of probes that failed to query.",
  alerts: "Number of threshold crossings recorded this run.",
  status: "ok | partial | error.",
  error: "Failure detail when status = error.",
};

// ---------------------------------------------------------------------------
// Table definition
// ---------------------------------------------------------------------------

export const cronRuns = sqliteTable("cron_runs", {
  id: text("id").primaryKey(),
  ranAt: integer("ran_at")
    .notNull()
    .$defaultFn(() => Date.now()),
  durationMs: integer("duration_ms").notNull().default(0),
  probesOk: integer("probes_ok").notNull().default(0),
  probesFailed: integer("probes_failed").notNull().default(0),
  alerts: integer("alerts").notNull().default(0),
  status: text("status", { enum: ["ok", "partial", "error"] })
    .notNull()
    .default("ok"),
  error: text("error"),
});

// ---------------------------------------------------------------------------
// Zod schemas & types
// ---------------------------------------------------------------------------

export const insertCronRunSchema = createInsertSchema(cronRuns);
export const selectCronRunSchema = createSelectSchema(cronRuns);
export type CronRunRow = typeof cronRuns.$inferSelect;
export type NewCronRunRow = typeof cronRuns.$inferInsert;
