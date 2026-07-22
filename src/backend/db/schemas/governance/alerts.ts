/**
 * @fileoverview `alerts` table — the actionable advisory surface.
 *
 * Distinct from `billing_events` (which is the append-only audit of mitigations
 * actually executed): an alert is a live, dismissible finding that names the
 * resource, its owning worker, the diagnosed cause, a recommendation, the
 * projected cost impact, and a snooze state. Governance is expressed as a
 * fraction of the monthly included allowance projected to period end — not a
 * guessed absolute threshold, which is what made the old D1 alert fire hourly.
 *
 * One row per (service, resource) finding; re-evaluation updates the existing
 * row in place rather than piling up duplicates.
 *
 * @see {@link file://src/backend/guardian/alerts.ts} for the evaluator.
 */

import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const ALERTS_TABLE_DESCRIPTION =
  "Live governance findings: resource, owning worker, diagnosed cause, recommendation, projected allowance fraction and cost delta, with a snooze/resolve lifecycle.";

export const ALERTS_COLUMN_DESCRIPTIONS: Record<string, string> = {
  id: "Stable id, derived from service+resource so re-evaluation updates in place.",
  service: "Probe id the alert came from (e.g. d1, kv, vectorize).",
  resource: "Human name of the specific resource, or '(account)' for account-wide probes.",
  worker: "Owning worker(s) from the attribution graph, comma-joined, or null.",
  severity: "info | warning | critical — from the projected allowance fraction.",
  cause: "One-line diagnosis of why this fired.",
  recommendation: "What to do about it.",
  projected_fraction: "projected period-end usage / included allowance (null when not comparable).",
  est_cost_delta: "Estimated USD overage if the projection holds (null when no rate is known).",
  status: "active | snoozed | resolved.",
  snoozed_until: "Unix ms until which the alert is muted (null unless snoozed).",
  created_at: "Unix ms first raised.",
  updated_at: "Unix ms last re-evaluated.",
};

export const alerts = sqliteTable("alerts", {
  id: text("id").primaryKey(),
  service: text("service").notNull(),
  resource: text("resource").notNull(),
  worker: text("worker"),
  severity: text("severity", { enum: ["info", "warning", "critical"] }).notNull(),
  cause: text("cause").notNull(),
  recommendation: text("recommendation").notNull(),
  projectedFraction: real("projected_fraction"),
  estCostDelta: real("est_cost_delta"),
  status: text("status", { enum: ["active", "snoozed", "resolved"] })
    .notNull()
    .default("active"),
  snoozedUntil: integer("snoozed_until"),
  createdAt: integer("created_at")
    .notNull()
    .$defaultFn(() => Date.now()),
  updatedAt: integer("updated_at")
    .notNull()
    .$defaultFn(() => Date.now()),
});

export const insertAlertSchema = createInsertSchema(alerts);
export const selectAlertSchema = createSelectSchema(alerts);
export type AlertRow = typeof alerts.$inferSelect;
export type NewAlertRow = typeof alerts.$inferInsert;
