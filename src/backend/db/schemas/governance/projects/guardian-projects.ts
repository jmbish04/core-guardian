/**
 * @fileoverview `guardian_projects` table — the P14a unified project registry.
 *
 * One row per *thing that can spend* on this account: every Cloudflare Worker
 * (kind='worker', synced from `/workers/scripts`) plus every distinct AI-only
 * caller (kind='ai_project', from `ai_router_requests.project`) and the
 * occasional py/gas/other caller. This is the single manageable list the
 * dashboard renders — "who exists, is it live, when did we last see it, how
 * much does it matter".
 *
 * @remarks Naming: the generic template already ships a `projects` table (a
 * task-management container in `schemas/projects/projects.ts`). To avoid a hard
 * SQL table-name + drizzle-symbol collision, this offense/spend registry is the
 * **`guardian_projects`** table, exported as `guardianProjects`. The AI-router
 * `project` field and circuits keyed `project:<name>` still key off the bare
 * `name` column here — the two tables are unrelated despite the near-name.
 *
 * Budgets and circuit state are NOT duplicated here — they live in the AI Router
 * circuits (CIRCUITS KV, scope `project:<name>`). This table holds intent +
 * liveness metadata and references the circuit by `name`.
 *
 * @see {@link file://src/backend/guardian/projects/sync-workers.ts} for the writer.
 * @see {@link file://src/backend/api/routes/projects.ts}? — no: this table is
 *   served by `routes/projects.ts` under `/api/guardian/projects` (the generic
 *   `/api/projects` router is the task-container one).
 */

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

// ---------------------------------------------------------------------------
// Table & column documentation (consumed by /api/docs/schema)
// ---------------------------------------------------------------------------

export const GUARDIAN_PROJECTS_TABLE_DESCRIPTION =
  "Unified project registry: one row per worker / AI-only caller / other spender, keyed by name (the worker script id or ai-router project). Liveness + intent metadata only — budgets/circuits live in the AI Router circuits keyed project:<name>.";

export const GUARDIAN_PROJECTS_COLUMN_DESCRIPTIONS: Record<string, string> = {
  name: "Primary key: the project id = worker script name = ai-router project field. Circuits key off this as project:<name>.",
  kind: "worker | ai_project | py | gas | other. worker = synced from /workers/scripts; ai_project = a distinct ai_router_requests.project not already a worker.",
  repo: "Connected GitHub repo (owner/repo), resolved from the worker's builds config where available, else null.",
  is_active: "1 = seen in the latest sync. A worker that disappears from /workers/scripts is set 0 (last_seen preserved).",
  last_seen: "Unix ms the project was last observed by a sync.",
  note: "Operator note (freeform).",
  criticality: "hobby | normal | important | critical — drives tightening priority; critical survives longest.",
  created_at: "Unix ms the row was first created.",
};

// ---------------------------------------------------------------------------
// Table definition
// ---------------------------------------------------------------------------

export const guardianProjects = sqliteTable(
  "guardian_projects",
  {
    name: text("name").primaryKey(),
    kind: text("kind", { enum: ["worker", "ai_project", "py", "gas", "other"] })
      .notNull()
      .default("other"),
    repo: text("repo"),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    lastSeen: integer("last_seen")
      .notNull()
      .$defaultFn(() => Date.now()),
    note: text("note"),
    criticality: text("criticality", {
      enum: ["hobby", "normal", "important", "critical"],
    })
      .notNull()
      .default("normal"),
    createdAt: integer("created_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => [
    // /projects lists active-first, newest last_seen first.
    index("idx_guardian_projects_last_seen").on(t.lastSeen),
  ],
);

// ---------------------------------------------------------------------------
// Zod schemas & types
// ---------------------------------------------------------------------------

export const insertGuardianProjectSchema = createInsertSchema(guardianProjects);
export const selectGuardianProjectSchema = createSelectSchema(guardianProjects);
export type GuardianProjectRow = typeof guardianProjects.$inferSelect;
export type NewGuardianProjectRow = typeof guardianProjects.$inferInsert;
