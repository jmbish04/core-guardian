/**
 * @fileoverview `billing_events` table — the Core Guardian governance audit trail.
 *
 * Every emergency mitigation executed by the Guardian control panel (R2
 * lifecycle eviction, Vectorize index drop) appends one immutable row here so
 * spend-surge responses are auditable after the fact.
 *
 * @see {@link file://src/backend/api/routes/guardian.ts} for the writers.
 */

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

// ---------------------------------------------------------------------------
// Table & column documentation (consumed by /api/docs/schema)
// ---------------------------------------------------------------------------

export const BILLING_EVENTS_TABLE_DESCRIPTION =
  "Audit trail of Core Guardian emergency cost-mitigation actions (R2 lifecycle eviction, Vectorize index drops). Append-only.";

export const BILLING_EVENTS_COLUMN_DESCRIPTIONS: Record<string, string> = {
  id: "Unique event identifier (UUID v4).",
  service: "Cloudflare service the mitigation targeted (e.g. r2, vectorize).",
  action_taken: "Human-readable description of the mitigation performed.",
  timestamp: "Unix timestamp (ms) when the mitigation completed.",
};

// ---------------------------------------------------------------------------
// Table definition
// ---------------------------------------------------------------------------

export const billingEvents = sqliteTable("billing_events", {
  id: text("id").primaryKey(),
  service: text("service").notNull(),
  actionTaken: text("action_taken").notNull(),
  timestamp: integer("timestamp")
    .notNull()
    .$defaultFn(() => Date.now()),
});

// ---------------------------------------------------------------------------
// Zod schemas & types
// ---------------------------------------------------------------------------

export const insertBillingEventSchema = createInsertSchema(billingEvents);
export const selectBillingEventSchema = createSelectSchema(billingEvents);
export type BillingEventRow = typeof billingEvents.$inferSelect;
export type NewBillingEventRow = typeof billingEvents.$inferInsert;
