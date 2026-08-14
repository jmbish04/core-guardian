/**
 * @fileoverview `jules_sessions` table — the P14a Jules session lifecycle log.
 *
 * One row per Jules session core-guardian has spun up (via a spend-audit
 * dispatch or any future flow). It tracks the session from `pending` through to
 * a terminal state so the dashboard `/jules` page can show what Jules is doing
 * right now and link out to the session + the PR it opened.
 *
 * A row is created alongside a `jules_dispatches` row (see dispatchToJules); the
 * poller (`pollJulesSessions`) then walks non-terminal rows, calls
 * `GET /sessions/{id}`, maps Jules' state to our `status`, and fills in
 * `session_url` / `pr_url`. Terminal states (submitted|failed|completed) stop
 * being polled.
 *
 * @see {@link file://src/backend/guardian/projects/poll-jules.ts} for the poller.
 * @see {@link file://src/backend/guardian/offense/jules-dispatch.ts} for the writer.
 */

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

// ---------------------------------------------------------------------------
// Table & column documentation (consumed by /api/docs/schema)
// ---------------------------------------------------------------------------

export const JULES_SESSIONS_TABLE_DESCRIPTION =
  "Jules session lifecycle log: one row per Jules session core-guardian dispatched, polled from pending → running → terminal (submitted|failed|completed). Carries the session + PR links for the /jules dashboard page.";

export const JULES_SESSIONS_COLUMN_DESCRIPTIONS: Record<string, string> = {
  id: "Unique row id (UUID v4).",
  session_id: "The Jules session id (from POST /sessions), or null before it is created.",
  dispatch_id: "The jules_dispatches row that spawned this session, when known.",
  project: "The guardian project this session pertains to, when known.",
  repo: "The owner/repo Jules is operating on.",
  status: "pending | running | stuck | submitted | failed | completed. Terminal states stop polling.",
  session_url: "Link to the Jules session UI.",
  pr_url: "Link to the pull request Jules opened (outputs[].pullRequest.url), when present.",
  created_at: "Unix ms the row was created.",
  updated_at: "Unix ms of the last poll/update.",
};

// ---------------------------------------------------------------------------
// Table definition
// ---------------------------------------------------------------------------

export const julesSessions = sqliteTable(
  "jules_sessions",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id"),
    dispatchId: text("dispatch_id"),
    project: text("project"),
    repo: text("repo").notNull(),
    status: text("status", {
      enum: ["pending", "running", "stuck", "submitted", "failed", "completed"],
    })
      .notNull()
      .default("pending"),
    sessionUrl: text("session_url"),
    prUrl: text("pr_url"),
    createdAt: integer("created_at")
      .notNull()
      .$defaultFn(() => Date.now()),
    updatedAt: integer("updated_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => [
    // The poller scans non-terminal rows by status; /jules filters/sorts by it.
    index("idx_jules_sessions_status").on(t.status),
  ],
);

// ---------------------------------------------------------------------------
// Zod schemas & types
// ---------------------------------------------------------------------------

export const insertJulesSessionSchema = createInsertSchema(julesSessions);
export const selectJulesSessionSchema = createSelectSchema(julesSessions);
export type JulesSessionRow = typeof julesSessions.$inferSelect;
export type NewJulesSessionRow = typeof julesSessions.$inferInsert;
