/**
 * @fileoverview `spend_rollup` — the cached reconciled spend ledger.
 *
 * One row per cron rebuild. `payload` is the full JSON the frontend renders in a
 * single cheap read (no compute on page load): the Cloudflare bill mirrored by
 * `service_family` (the Billed lane, ground truth), each family's run-rate
 * projection, and the per-project allocation (actual distributed by estimated
 * share, so projects sum to the real bill) plus the unattributed/shared pools.
 * Read the newest by `built_at`.
 *
 * @see {@link file://src/backend/guardian/spend-rollup.ts} the writer.
 */

import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const SPEND_ROLLUP_TABLE_DESCRIPTION =
  "Cached reconciled spend ledger (one row per cron rebuild). payload is the full JSON the frontend renders: billed-by-family + run-rate projection + per-project allocation + pools. Read the newest by built_at.";

export const SPEND_ROLLUP_COLUMN_DESCRIPTIONS: Record<string, string> = {
  id: "Rebuild id (uuid).",
  built_at: "Unix ms this rollup was computed.",
  window_start: "Unix ms of the billing-cycle window start.",
  window_end: "Unix ms of the window end (cycle end).",
  total_actual_usd: "Sum of billed actual across all families (matches the Cloudflare bill).",
  payload: "JSON: { window, billed[], projects[], pools[], totals } — the whole frontend view.",
};

export const spendRollup = sqliteTable(
  "spend_rollup",
  {
    id: text("id").primaryKey(),
    builtAt: integer("built_at").notNull(),
    windowStart: integer("window_start").notNull(),
    windowEnd: integer("window_end").notNull(),
    totalActualUsd: real("total_actual_usd").notNull().default(0),
    payload: text("payload").notNull(),
  },
  (t) => [index("idx_spend_rollup_built").on(t.builtAt)],
);

export const insertSpendRollupSchema = createInsertSchema(spendRollup);
export const selectSpendRollupSchema = createSelectSchema(spendRollup);
export type SpendRollupRow = typeof spendRollup.$inferSelect;
export type NewSpendRollupRow = typeof spendRollup.$inferInsert;
