/**
 * @fileoverview `alert_rules` table — declarative alert + auto-action logic.
 *
 * Each row binds a usage probe to a comparator, a threshold, and an action. The
 * hourly cron evaluates every enabled rule against the probe readings it just
 * collected. Rules with `action = "notify"` only record an event; rules with a
 * mitigation action can execute it, but only when `armed` is true — so a rule
 * can be authored, reviewed, and watched in dry-run before it is ever allowed
 * to touch infrastructure.
 *
 * Rules override the static `alertThreshold` values baked into
 * `@/backend/guardian/probes`; probes remain the fallback for any service with
 * no rule.
 *
 * @see {@link file://src/backend/guardian/rules.ts} for the evaluator.
 */

import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

// ---------------------------------------------------------------------------
// Table & column documentation (consumed by /api/docs/schema)
// ---------------------------------------------------------------------------

export const ALERT_RULES_TABLE_DESCRIPTION =
  "Declarative alert rules binding a usage probe to a threshold, a severity, and an optional automatic mitigation.";

export const ALERT_RULES_COLUMN_DESCRIPTIONS: Record<string, string> = {
  id: "Unique rule identifier (UUID v4).",
  name: "Human-readable rule name.",
  description: "What the rule watches for.",
  service: "Probe id this rule evaluates (e.g. d1, r2-storage, ai-gateway).",
  comparator: "gt | gte | lt | lte — how value is compared to threshold.",
  threshold: "Numeric threshold in the probe's own unit. NULL = not yet configured.",
  window_hours: "Trailing window the probe value is measured over.",
  severity: "info | moderate | significant | critical.",
  action: "notify | evict_r2 | drop_vectorize | disable_topup.",
  action_target: "Resource the action applies to (bucket name, index name).",
  armed: "1 = the action may execute. 0 = evaluate and record only (dry run).",
  enabled: "1 = evaluated by the cron. 0 = paused.",
  cooldown_minutes: "Minimum gap between firings, to stop alert storms.",
  last_fired_at: "Unix ms of the last time this rule fired.",
  created_at: "Unix ms when the rule was created.",
  updated_at: "Unix ms when the rule was last modified.",
};

// ---------------------------------------------------------------------------
// Table definition
// ---------------------------------------------------------------------------

export const alertRules = sqliteTable("alert_rules", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  service: text("service").notNull(),
  comparator: text("comparator", { enum: ["gt", "gte", "lt", "lte"] })
    .notNull()
    .default("gt"),
  // Null until the operator sets one — the UI surfaces this as "Set threshold"
  // and refuses to save the rule as enabled.
  threshold: real("threshold"),
  windowHours: integer("window_hours").notNull().default(1),
  severity: text("severity", { enum: ["info", "moderate", "significant", "critical"] })
    .notNull()
    .default("moderate"),
  action: text("action", {
    enum: ["notify", "evict_r2", "drop_vectorize", "disable_topup"],
  })
    .notNull()
    .default("notify"),
  actionTarget: text("action_target"),
  armed: integer("armed", { mode: "boolean" }).notNull().default(false),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  cooldownMinutes: integer("cooldown_minutes").notNull().default(60),
  lastFiredAt: integer("last_fired_at"),
  createdAt: integer("created_at")
    .notNull()
    .$defaultFn(() => Date.now()),
  updatedAt: integer("updated_at")
    .notNull()
    .$defaultFn(() => Date.now()),
});

// ---------------------------------------------------------------------------
// Zod schemas & types
// ---------------------------------------------------------------------------

export const insertAlertRuleSchema = createInsertSchema(alertRules);
export const selectAlertRuleSchema = createSelectSchema(alertRules);
export type AlertRuleRow = typeof alertRules.$inferSelect;
export type NewAlertRuleRow = typeof alertRules.$inferInsert;
