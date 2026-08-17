/**
 * @fileoverview `trim_targets` table — the universal table-trim registry.
 *
 * Each row names a (database, table) whose oldest rows should be periodically
 * exported to Google Drive and then truncated, keeping the table bounded. It is
 * database-agnostic: the workflow reads/deletes the target over the Cloudflare
 * D1 REST API by uuid (see `log-trim-workflow.ts`), so a target can point at ANY
 * D1 on the account — not just this Worker's bindings.
 *
 * The default seeds (core-guardian-logs.logs, core-github-api-webhooks
 * .webhook_deliveries) are installed idempotently by `ensureDefaultTrimTargets`.
 *
 * @see {@link file://src/backend/guardian/log-trim-workflow.ts}
 */

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const TRIM_TARGETS_TABLE_DESCRIPTION =
  "Universal table-trim registry: per (database, table) export-to-Drive-then-truncate policy driven by the LogTrimWorkflow.";

export const TRIM_TARGETS_COLUMN_DESCRIPTIONS: Record<string, string> = {
  id: "Stable target id (UUID or a deterministic seed id).",
  db_uuid: "Cloudflare D1 database uuid the target table lives in.",
  db_name: "Human-readable database name (for filenames + the audit trail).",
  table_name: "The table to trim.",
  key_column: "Ordering/range column for oldest-first export + range delete (default 'id'; use 'rowid' when there is no integer id).",
  threshold_rows: "Trim only runs when COUNT(*) exceeds this.",
  keep_rows: "Rows to retain after a trim (never export below this).",
  batch_rows: "Max rows exported+deleted per workflow run.",
  drive_folder_id: "Destination Drive folder id; null → resolve from drive_folders(purpose='d1').",
  enabled: "1 to include this target in the cron dispatch.",
  last_run_at: "Unix ms of the last workflow completion.",
  last_export_path: "Drive path of the last export file.",
  last_rows_exported: "Row count of the last export.",
  last_error: "Last failure detail, cleared on success.",
  updated_at: "Unix ms last saved.",
};

export const trimTargets = sqliteTable("trim_targets", {
  id: text("id").primaryKey(),
  dbUuid: text("db_uuid").notNull(),
  dbName: text("db_name").notNull(),
  tableName: text("table_name").notNull(),
  keyColumn: text("key_column").notNull().default("id"),
  thresholdRows: integer("threshold_rows").notNull().default(50000),
  keepRows: integer("keep_rows").notNull().default(20000),
  batchRows: integer("batch_rows").notNull().default(10000),
  driveFolderId: text("drive_folder_id"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  lastRunAt: integer("last_run_at"),
  lastExportPath: text("last_export_path"),
  lastRowsExported: integer("last_rows_exported"),
  lastError: text("last_error"),
  updatedAt: integer("updated_at")
    .notNull()
    .$defaultFn(() => Date.now()),
});

export const insertTrimTargetSchema = createInsertSchema(trimTargets);
export const selectTrimTargetSchema = createSelectSchema(trimTargets);
export type TrimTargetRow = typeof trimTargets.$inferSelect;
export type NewTrimTargetRow = typeof trimTargets.$inferInsert;
