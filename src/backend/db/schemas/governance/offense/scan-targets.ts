/**
 * @fileoverview `scan_targets` table — Spend Offense player registry (P2).
 *
 * The offense scanner enumerates every "player" that could rack up spend — P2
 * writes only Cloudflare Workers (`kind='worker'`); later phases add GitHub
 * Actions, local cron/launchd jobs, and Google Apps Script. Each row is one
 * player with its deterministic risk profile:
 *
 *  - `cron_schedules` — the worker's cron triggers (blast-radius cadence).
 *  - `risk_signals`   — which billable capabilities it wields (AI, D1, DO,
 *                       Vectorize, Browser Rendering, scraping, cron).
 *  - `risk_score`     — 0–100 deterministic score from those signals + cadence
 *                       + invocation frequency. NO AI is used to compute it.
 *  - `guardian_registered` — does core-guardian already see this player's AI
 *                       usage (rows in ai_router_requests / ai_usage_registrations)?
 *  - `bypass`         — set when the player has an AI signal but is NOT registered:
 *                       it is spending on AI behind core-guardian's back.
 *
 * Rows are upserted by name (unique on `kind,name`): re-scanning refreshes
 * `last_scan` and the risk profile while preserving `first_seen`.
 *
 * @see {@link file://src/backend/guardian/offense/scan-workers.ts} for the writer.
 * @see {@link file://src/backend/guardian/offense/classify.ts} for the scorer.
 * @see {@link file://src/backend/api/routes/offense.ts} for the read/scan API.
 */

import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

// ---------------------------------------------------------------------------
// Table & column documentation (consumed by /api/docs/schema)
// ---------------------------------------------------------------------------

export const SCAN_TARGETS_TABLE_DESCRIPTION =
  "Spend Offense player registry: every enumerated worker/job with its deterministic risk signals, 0–100 risk score, guardian-registration status, and AI-bypass flag. Upserted by (kind,name); NO AI is used to classify.";

export const SCAN_TARGETS_COLUMN_DESCRIPTIONS: Record<string, string> = {
  id: "Unique target id (UUID v4).",
  kind: "Player class: worker | github_action | local | gas. P2 writes 'worker' only.",
  name: "Stable player identity (for workers, the CF script id). Unique per kind.",
  worker_name: "The Cloudflare Worker script id, when kind='worker' (else null).",
  cron_schedules: "JSON string[]: the worker's cron trigger expressions.",
  risk_signals:
    "JSON {cron,browser,scraping,d1,vectorize,durableObject,ai}: booleans for the billable capabilities this player wields.",
  risk_score: "Deterministic 0–100 billable-risk score (cadence + bindings + frequency).",
  guardian_registered:
    "1 = core-guardian already sees this player's AI usage (rows in ai_router_requests / ai_usage_registrations).",
  bypass:
    "JSON {isBypass,why}: true when the player has an AI signal but is not registered — spending on AI behind guardian's back.",
  first_seen: "Unix ms the player was first enumerated (preserved across re-scans).",
  last_scan: "Unix ms of the most recent scan that touched this row.",
};

// ---------------------------------------------------------------------------
// JSON payload shapes
// ---------------------------------------------------------------------------

/** The deterministic billable-capability signals for one player. */
export interface RiskSignals {
  /** Has one or more cron triggers. */
  cron: boolean;
  /** Bound to Browser Rendering. */
  browser: boolean;
  /** Scraping-shaped: browser binding OR a high subrequest/request ratio. */
  scraping: boolean;
  /** Bound to a D1 database. */
  d1: boolean;
  /** Bound to a Vectorize index. */
  vectorize: boolean;
  /** Bound to a Durable Object namespace. */
  durableObject: boolean;
  /** Bound to Workers AI (`env.AI`). */
  ai: boolean;
}

/** AI-bypass verdict for one player. */
export interface BypassVerdict {
  /** True when the player uses AI but does not report through core-guardian. */
  isBypass: boolean;
  /** Human-readable justification (empty when not a bypass). */
  why: string;
}

// ---------------------------------------------------------------------------
// Table definition
// ---------------------------------------------------------------------------

export const scanTargets = sqliteTable(
  "scan_targets",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["worker", "github_action", "local", "gas"] }).notNull(),
    name: text("name").notNull(),
    workerName: text("worker_name"),
    cronSchedules: text("cron_schedules", { mode: "json" }).$type<string[]>(),
    riskSignals: text("risk_signals", { mode: "json" }).$type<RiskSignals>(),
    riskScore: integer("risk_score").notNull().default(0),
    guardianRegistered: integer("guardian_registered", { mode: "boolean" })
      .notNull()
      .default(false),
    bypass: text("bypass", { mode: "json" }).$type<BypassVerdict>(),
    firstSeen: integer("first_seen")
      .notNull()
      .$defaultFn(() => Date.now()),
    lastScan: integer("last_scan")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => [
    // Upsert key: one row per (kind,name); re-scans update in place.
    uniqueIndex("idx_scan_targets_kind_name").on(t.kind, t.name),
    // /targets lists newest-scanned first, often filtered by risk.
    index("idx_scan_targets_last_scan").on(t.lastScan),
  ],
);

// ---------------------------------------------------------------------------
// Zod schemas & types
// ---------------------------------------------------------------------------

export const insertScanTargetSchema = createInsertSchema(scanTargets);
export const selectScanTargetSchema = createSelectSchema(scanTargets);
export type ScanTargetRow = typeof scanTargets.$inferSelect;
export type NewScanTargetRow = typeof scanTargets.$inferInsert;
