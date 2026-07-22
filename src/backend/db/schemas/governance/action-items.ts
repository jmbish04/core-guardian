/**
 * @fileoverview `action_items` table — human-gated follow-up tasks.
 *
 * The archive flows never auto-delete. Instead, once data is copied to Drive and
 * the copy is audited (Drive really received the full archive), the flow files an
 * action item proposing deletion of the source. The operator approves it; only
 * then does deletion run, and completion is gated on a re-check that the source
 * is actually gone.
 *
 * Items carry a `service` (d1 / r2 / cf-image) so a binding dashboard can show
 * only its own items, and the account dashboard can show them all.
 *
 * Lifecycle: pending → (approve) → in_progress → (verify) → complete | failed.
 *
 * @see {@link file://src/backend/guardian/action-items.ts} for the executor.
 */

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const ACTION_ITEMS_TABLE_DESCRIPTION =
  "Human-gated follow-up tasks (e.g. delete an archived source). Approve → execute → verify → complete.";

export const ACTION_ITEMS_COLUMN_DESCRIPTIONS: Record<string, string> = {
  id: "Unique id (UUID v4).",
  kind: "What the item does when approved (e.g. delete-source).",
  service: "Owning probe/binding id (d1, r2, cf-image) for per-binding filtering.",
  resource_type: "Kind of resource (d1-database, r2-bucket, cf-image-batch).",
  resource_id: "Stable id of the source resource.",
  resource_name: "Human name of the source resource.",
  title: "Short label shown in the dashboard widget.",
  description: "What will happen and why.",
  audit: "JSON: the archive verification (drive file id/url, bytes, match) that justifies this item.",
  drive_url: "Link to the archive in Drive, if any.",
  status: "pending | in_progress | complete | failed.",
  verify_result: "Result of the post-action verification (e.g. 'source no longer exists').",
  error: "Failure detail when status = failed.",
  created_at: "Unix ms filed.",
  approved_at: "Unix ms the operator approved.",
  completed_at: "Unix ms finished (complete or failed).",
};

export const actionItems = sqliteTable("action_items", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  service: text("service").notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id").notNull(),
  resourceName: text("resource_name").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  audit: text("audit"),
  driveUrl: text("drive_url"),
  status: text("status", { enum: ["pending", "in_progress", "complete", "failed"] })
    .notNull()
    .default("pending"),
  verifyResult: text("verify_result"),
  error: text("error"),
  createdAt: integer("created_at")
    .notNull()
    .$defaultFn(() => Date.now()),
  approvedAt: integer("approved_at"),
  completedAt: integer("completed_at"),
});

export const insertActionItemSchema = createInsertSchema(actionItems);
export const selectActionItemSchema = createSelectSchema(actionItems);
export type ActionItemRow = typeof actionItems.$inferSelect;
export type NewActionItemRow = typeof actionItems.$inferInsert;
