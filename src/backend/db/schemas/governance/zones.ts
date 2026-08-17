/**
 * @fileoverview `zones` — the account's Cloudflare zones.
 *
 * Spend attribution needs to know which zone a charge belongs to, and which
 * zones can accrue charges at all. `billable_usage` rows link here via their
 * `zone_fk` column; account-level charges have no zone and leave it null.
 *
 * Rows are upserted by the hourly sync from the Cloudflare zones API.
 *
 * @see {@link file://src/backend/db/schemas/governance/billable-usage.ts}
 */

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const ZONES_TABLE_DESCRIPTION =
  "The account's Cloudflare zones. billable=1 marks a zone that accrues charges; billable_usage rows link here by zone_id.";

export const ZONES_COLUMN_DESCRIPTIONS: Record<string, string> = {
  id: "Relational primary key (the Cloudflare zone id).",
  cf_zone_id: "Cloudflare zone id (same as id; explicit for joins/clarity).",
  name: "Zone name, e.g. hacolby.app.",
  billable: "1 = this zone accrues charges. Account has 3 zones; only hacolby.app is billable.",
  last_seen: "Unix ms the zone was last observed by a sync.",
};

export const zones = sqliteTable(
  "zones",
  {
    id: text("id").primaryKey(),
    cfZoneId: text("cf_zone_id").notNull(),
    name: text("name").notNull().default(""),
    billable: integer("billable", { mode: "boolean" }).notNull().default(false),
    lastSeen: integer("last_seen")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => [index("idx_zones_billable").on(t.billable)],
);

export const insertZoneSchema = createInsertSchema(zones);
export const selectZoneSchema = createSelectSchema(zones);
export type ZoneRow = typeof zones.$inferSelect;
export type NewZoneRow = typeof zones.$inferInsert;
