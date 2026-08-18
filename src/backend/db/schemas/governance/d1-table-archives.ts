/**
 * @fileoverview `d1_table_archives` — the audit trail for per-table D1
 * archive → verify → trim. Every archive, its Drive location, the
 * download-back verification (row counts matched), and any subsequent trim is
 * recorded here so a destructive trim is always preceded by a logged, verified
 * export. Never trim a table whose archive isn't `verified` in this table.
 */

import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const D1_TABLE_ARCHIVES_TABLE_DESCRIPTION =
  "Audit trail for per-table D1 archive→verify→trim. An archive row is written on export (verified=0), flipped to verified=1 after the Drive file is re-downloaded and its row count matches, and stamped trimmed=1 once the old rows are deleted. A trim is gated on verified=1.";

export const d1TableArchives = sqliteTable(
  "d1_table_archives",
  {
    id: text("id").primaryKey(),
    databaseUuid: text("database_uuid").notNull(),
    databaseName: text("database_name").notNull().default(""),
    tableName: text("table_name").notNull(),
    // Scope is stored STRUCTURALLY (not as raw SQL) and re-rendered at trim —
    // safer than trusting a stored SQL fragment. "" timeColumn = whole table.
    timeColumn: text("time_column").notNull().default(""),
    cutoffValue: text("cutoff_value").notNull().default(""),
    cutoffIsNum: integer("cutoff_is_num", { mode: "boolean" }).notNull().default(false),
    /**
     * The MAX(rowid) captured at export. Trim deletes only `... AND rowid <=
     * max_rowid`, so rows created after the archive can never be deleted
     * un-archived, and a truncated export can't over-delete (the count guard
     * catches a mismatch).
     */
    maxRowid: integer("max_rowid").notNull().default(0),
    /** Rows written to the Drive archive. */
    archivedRows: integer("archived_rows").notNull().default(0),
    driveFileId: text("drive_file_id").notNull().default(""),
    driveUrl: text("drive_url").notNull().default(""),
    bytes: integer("bytes").notNull().default(0),
    /** SHA-256 of the archived JSONL — verification re-hashes the re-download. */
    contentHash: text("content_hash").notNull().default(""),
    /** Verify-by-redownload: 1 once re-download row count + byte length + hash all match. */
    verified: integer("verified", { mode: "boolean" }).notNull().default(false),
    verifiedRows: integer("verified_rows").notNull().default(0),
    verifiedAt: integer("verified_at"),
    /** Trim: 1 once the old rows were deleted from D1 (only allowed after verified). */
    trimmed: integer("trimmed", { mode: "boolean" }).notNull().default(false),
    trimmedRows: integer("trimmed_rows").notNull().default(0),
    trimmedAt: integer("trimmed_at"),
    /** Reclaimed byte estimate (archived bytes attributed to the trim). */
    reclaimedBytes: real("reclaimed_bytes").notNull().default(0),
    createdAt: integer("created_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => [
    index("idx_d1_table_archives_db").on(t.databaseUuid),
    index("idx_d1_table_archives_created").on(t.createdAt),
  ],
);

export const insertD1TableArchiveSchema = createInsertSchema(d1TableArchives);
export const selectD1TableArchiveSchema = createSelectSchema(d1TableArchives);
export type D1TableArchiveRow = typeof d1TableArchives.$inferSelect;
export type NewD1TableArchiveRow = typeof d1TableArchives.$inferInsert;
