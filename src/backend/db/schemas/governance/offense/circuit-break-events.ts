/**
 * @fileoverview `circuit_break_events` table — Spend Offense incident records.
 *
 * The "offense" side of Core Guardian catches spend before (or as) it happens
 * and files an incident here. Each row is one incident: something tripped a
 * spend guard (P1: two consecutive days over the daily threshold), optionally an
 * automated action was taken (e.g. the AI kill switch was flipped), and a
 * recommendation was surfaced to the operator.
 *
 * Incidents are recommend-only by default. An `active` incident stays visible as
 * a live breaker on the dashboard and is polled by the local watchdog until the
 * operator resolves it:
 *
 *   - **read**      → acknowledged, but the breaker stays live (still shown).
 *   - **erroneous** → false positive; any automated action (kill switch) is lifted.
 *
 * `source` records what raised it. P1 only ever writes `auto_spend`; `scanner`
 * and `jules` are reserved for later phases (see docs/architecture/spend-offense.md).
 *
 * @see {@link file://src/backend/guardian/offense/auto-break.ts} for the writer.
 * @see {@link file://src/backend/api/routes/offense.ts} for the read/resolve API.
 */

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

// ---------------------------------------------------------------------------
// Table & column documentation (consumed by /api/docs/schema)
// ---------------------------------------------------------------------------

export const CIRCUIT_BREAK_EVENTS_TABLE_DESCRIPTION =
  "Spend Offense incidents: a spend guard tripped, optionally an action was taken, and a recommendation was surfaced. Active rows are live breakers until resolved (read / erroneous).";

export const CIRCUIT_BREAK_EVENTS_COLUMN_DESCRIPTIONS: Record<string, string> = {
  id: "Unique incident id (UUID v4).",
  project_identification:
    "JSON: the project/target this incident is about, when known (null for account-wide sustained-spend).",
  scope: "Circuit scope the incident concerns (e.g. 'global', 'project:acre'), or null.",
  reason: "Human-readable reason the incident was filed.",
  source:
    "What raised it: scanner | jules | auto_spend | budget_cap | infra_spike. P1 writes auto_spend; P9a adds budget_cap (nuclear total-CF-budget breaker) and infra_spike (non-AI infra-spike guard).",
  status: "active | read | erroneous. Active rows are live breakers shown on the dashboard.",
  jules_pr: "PR opened by Jules for this incident, if any (later phases).",
  actions_taken: "JSON: automated actions performed (e.g. kill switch flipped). Empty when recommend-only.",
  recommendation: "JSON: what the operator is advised to do.",
  created_at: "Unix ms the incident was filed.",
  resolved_at: "Unix ms the operator resolved it (read or erroneous), or null.",
};

// ---------------------------------------------------------------------------
// Table definition
// ---------------------------------------------------------------------------

/** One automated action taken for an incident (stored in `actions_taken`). */
export interface CircuitBreakAction {
  /** Machine tag, e.g. "kill_switch". */
  kind: string;
  /** Human description of what was done. */
  detail: string;
  /** Unix ms the action ran. */
  at: number;
}

/** Operator-facing recommendation payload (stored in `recommendation`). */
export interface CircuitBreakRecommendation {
  /** Short imperative, e.g. "Investigate the two-day spend spike.". */
  summary: string;
  /** Supporting figures / context. */
  details?: Record<string, unknown>;
}

export const circuitBreakEvents = sqliteTable(
  "circuit_break_events",
  {
    id: text("id").primaryKey(),
    projectIdentification: text("project_identification", { mode: "json" }).$type<
      Record<string, unknown>
    >(),
    scope: text("scope"),
    reason: text("reason").notNull(),
    source: text("source", {
      enum: ["scanner", "jules", "auto_spend", "budget_cap", "infra_spike"],
    }).notNull(),
    status: text("status", { enum: ["active", "read", "erroneous"] })
      .notNull()
      .default("active"),
    julesPr: text("jules_pr"),
    actionsTaken: text("actions_taken", { mode: "json" }).$type<CircuitBreakAction[]>(),
    recommendation: text("recommendation", { mode: "json" }).$type<CircuitBreakRecommendation>(),
    createdAt: integer("created_at")
      .notNull()
      .$defaultFn(() => Date.now()),
    resolvedAt: integer("resolved_at"),
  },
  (t) => [
    // The incidents list + the active-incident dedupe both filter by status and
    // order by created_at DESC — index the pair to avoid a scan + sort.
    index("idx_circuit_break_events_status_created").on(t.status, t.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Zod schemas & types
// ---------------------------------------------------------------------------

export const insertCircuitBreakEventSchema = createInsertSchema(circuitBreakEvents);
export const selectCircuitBreakEventSchema = createSelectSchema(circuitBreakEvents);
export type CircuitBreakEventRow = typeof circuitBreakEvents.$inferSelect;
export type NewCircuitBreakEventRow = typeof circuitBreakEvents.$inferInsert;
