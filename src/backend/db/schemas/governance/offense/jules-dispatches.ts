/**
 * @fileoverview `jules_dispatches` table — Spend Offense capability tokens (P4).
 *
 * When guardian sends an uncertain target to Jules (the external AI auditor), it
 * mints a per-dispatch **nonce** (an unguessable UUID) and records a `pending`
 * row here. That nonce IS the auth for the findings-intake endpoint: Jules curls
 * `POST /api/guardian/offense/findings` carrying the nonce, and the only rows it
 * can satisfy are `pending` dispatches of task_type `spend_audit`.
 *
 * The nonce is a one-time capability token. On a successful report the row flips
 * to `reported`, so a replayed nonce no longer matches any pending row — no
 * self-DoS, no header secret to leak.
 *
 * @see {@link file://src/backend/guardian/offense/jules-dispatch.ts} for the
 *   minting (`createJulesDispatch`) + intake (`recordFindings`) logic.
 * @see {@link file://src/backend/api/routes/offense.ts} for the nonce-authed route.
 */

import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

// ---------------------------------------------------------------------------
// Table & column documentation (consumed by /api/docs/schema)
// ---------------------------------------------------------------------------

export const JULES_DISPATCHES_TABLE_DESCRIPTION =
  "Spend Offense capability tokens: one row per Jules dispatch. The unguessable nonce authenticates the findings-intake endpoint; a pending row is spent (→ reported) on first successful report, so the nonce is one-time.";

export const JULES_DISPATCHES_COLUMN_DESCRIPTIONS: Record<string, string> = {
  id: "Unique dispatch id (UUID v4).",
  nonce: "Per-dispatch capability token (UUID v4). Unique; presented by Jules to authenticate findings intake.",
  jules_session_id: "The Jules session/run this dispatch was handed to.",
  target_id: "The scan_targets row this dispatch audits, when known (else null).",
  task_type: "What Jules was asked to do. P4 only mints 'spend_audit'.",
  status: "pending | reported | failed | expired. Only 'pending' rows can satisfy a findings report.",
  dispatched_at: "Unix ms the dispatch (pending row) was created.",
  reported_at: "Unix ms Jules successfully reported findings, or null.",
  findings: "JSON: the raw findings payload Jules reported, or null.",
};

// ---------------------------------------------------------------------------
// Table definition
// ---------------------------------------------------------------------------

export const julesDispatches = sqliteTable(
  "jules_dispatches",
  {
    id: text("id").primaryKey(),
    nonce: text("nonce").notNull(),
    julesSessionId: text("jules_session_id").notNull(),
    targetId: text("target_id"),
    taskType: text("task_type", { enum: ["spend_audit"] })
      .notNull()
      .default("spend_audit"),
    status: text("status", { enum: ["pending", "reported", "failed", "expired"] })
      .notNull()
      .default("pending"),
    dispatchedAt: integer("dispatched_at")
      .notNull()
      .$defaultFn(() => Date.now()),
    reportedAt: integer("reported_at"),
    findings: text("findings", { mode: "json" }).$type<Record<string, unknown>>(),
  },
  (t) => [
    // The nonce is the capability token — it must be globally unique, and the
    // intake path looks a dispatch up by it on every report.
    uniqueIndex("idx_jules_dispatches_nonce").on(t.nonce),
    // Intake filters pending spend_audit rows; the housekeeping/expiry pass
    // scans by status too.
    index("idx_jules_dispatches_status").on(t.status),
  ],
);

// ---------------------------------------------------------------------------
// Zod schemas & types
// ---------------------------------------------------------------------------

export const insertJulesDispatchSchema = createInsertSchema(julesDispatches);
export const selectJulesDispatchSchema = createSelectSchema(julesDispatches);
export type JulesDispatchRow = typeof julesDispatches.$inferSelect;
export type NewJulesDispatchRow = typeof julesDispatches.$inferInsert;
