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
    /** Column used for the age cutoff, or "" for a whole-table archive (display). */
    timeColumn: text("time_column").notNull().default(""),
    /**
     * The EXACT SQL WHERE fragment (no leading WHERE) that scoped the archive.
     * Trim reuses this verbatim so it deletes precisely what was archived +
     * verified — never re-derived (a re-derivation dropped string cutoffs and
     * would have trimmed the whole table). "" = whole table.
     */
    scopeSql: text("scope_sql").notNull().default(""),
    /** Rows written to the Drive archive. */
    archivedRows: integer("archived_rows").notNull().default(0),
    driveFileId: text("drive_file_id").notNull().default(""),
    driveUrl: text("drive_url").notNull().default(""),
    bytes: integer("bytes").notNull().default(0),
    /** Verify-by-redownload: 1 once the Drive file's row count matched archivedRows. */
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
