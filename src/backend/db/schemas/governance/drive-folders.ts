/**
 * @fileoverview `drive_folders` table — self-service Google Drive destinations.
 *
 * The archive features (R2 → Drive, D1 → Drive, CF Images → Drive) each need a
 * target Drive folder. Rather than hardcoding ids or paying for an always-on
 * Durable Object to hold them, the operator pastes a folder URL/id on a config
 * page; the id is extracted, the service account's access is validated live, and
 * the result is saved here. One row per purpose.
 *
 * @see {@link file://src/backend/api/routes/drive-config.ts}
 */

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const DRIVE_FOLDERS_TABLE_DESCRIPTION =
  "Self-service Google Drive folder destinations per archive purpose, with live service-account validation state.";

export const DRIVE_FOLDERS_COLUMN_DESCRIPTIONS: Record<string, string> = {
  purpose: "root | r2 | d1 | cf-image — which archive flow uses this folder (primary key).",
  folder_id: "Extracted Google Drive folder id.",
  url: "The original pasted URL or id.",
  name: "Folder name as seen by the service account (null until validated).",
  validated: "1 when the service account could read the folder, else 0.",
  error: "Validation failure detail, if any.",
  validated_at: "Unix ms of the last successful validation.",
  updated_at: "Unix ms last saved.",
};

export const driveFolders = sqliteTable("drive_folders", {
  purpose: text("purpose").primaryKey(),
  folderId: text("folder_id").notNull(),
  url: text("url").notNull(),
  name: text("name"),
  validated: integer("validated", { mode: "boolean" }).notNull().default(false),
  error: text("error"),
  validatedAt: integer("validated_at"),
  updatedAt: integer("updated_at")
    .notNull()
    .$defaultFn(() => Date.now()),
});

export const insertDriveFolderSchema = createInsertSchema(driveFolders);
export const selectDriveFolderSchema = createSelectSchema(driveFolders);
export type DriveFolderRow = typeof driveFolders.$inferSelect;
export type NewDriveFolderRow = typeof driveFolders.$inferInsert;
