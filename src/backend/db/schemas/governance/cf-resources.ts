/**
 * @fileoverview `cf_resources` + `resource_usage_snapshots` + `resource_bindings` —
 * the raw material for per-resource spend attribution.
 *
 * `cf_resources` is a registry of every billable Cloudflare resource (bucket,
 * database, namespace, index, …) keyed by a deterministic `${product}:${cfId}`
 * id. `resource_usage_snapshots` is the append-only per-resource usage + cost
 * estimate written each hour, so spend can be diffed over time.
 * `resource_bindings` persists the worker -> resource map from the Cloudflare
 * bindings API, which is how a resource's cost gets an owning worker.
 *
 * The three tables change together (a new product touches all of them), so they
 * live in one file. All three are written by the hourly cron via
 * {@link file://src/backend/guardian/snapshot-resources.ts}.
 */

import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const CF_RESOURCES_TABLE_DESCRIPTION =
  "Registry of billable Cloudflare resources (one per bucket/db/namespace/index/etc), each with its own relational id. Not tied to a project; workers link via resource_bindings.";

export const cfResources = sqliteTable(
  "cf_resources",
  {
    id: text("id").primaryKey(), // `${product}:${cfId}` — stable, deterministic
    product: text("product").notNull(), // r2 | d1 | kv | vectorize | durable_objects | workers_ai | queue | images | ...
    resourceType: text("resource_type").notNull().default(""),
    resourceName: text("resource_name").notNull().default(""),
    cfId: text("cf_id").notNull(), // bucket name / db uuid / index name / namespace id
    firstSeen: integer("first_seen")
      .notNull()
      .$defaultFn(() => Date.now()),
    lastSeen: integer("last_seen")
      .notNull()
      .$defaultFn(() => Date.now()),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
  },
  (t) => [index("idx_cf_resources_product").on(t.product)],
);

export const RESOURCE_USAGE_SNAPSHOTS_TABLE_DESCRIPTION =
  "Append-only periodic per-resource, per-metric usage + estimated cost. Powers over-time deltas. Composite-keyed on (resource_id, metric, captured_at) — a resource can bill on several metrics (e.g. R2 operations vs R2 storage), each its own row with its own unit. Pruned to a retention window by the writer.";

export const resourceUsageSnapshots = sqliteTable(
  "resource_usage_snapshots",
  {
    resourceId: text("resource_id")
      .notNull()
      .references(() => cfResources.id),
    // The billing metric, i.e. the probe id (r2-operations, r2-storage, d1, …).
    // Keeps distinct-unit metrics on one resource from clobbering each other.
    metric: text("metric").notNull().default(""),
    capturedAt: integer("captured_at").notNull(),
    windowHours: integer("window_hours").notNull().default(1),
    usageQty: real("usage_qty").notNull().default(0),
    unit: text("unit").notNull().default(""),
    estCostUsd: real("est_cost_usd").notNull().default(0),
  },
  (t) => [
    // PK covers latest-per-(resource,metric); the index serves time-range
    // pruning/deltas across all resources.
    primaryKey({ columns: [t.resourceId, t.metric, t.capturedAt] }),
    index("idx_rus_captured").on(t.capturedAt),
  ],
);

export const RESOURCE_BINDINGS_TABLE_DESCRIPTION =
  "Worker -> resource binding map from the Cloudflare bindings API (persisted from getBindingIndex).";

export const resourceBindings = sqliteTable(
  "resource_bindings",
  {
    worker: text("worker").notNull(),
    resourceId: text("resource_id")
      .notNull()
      .references(() => cfResources.id),
    bindingName: text("binding_name").notNull().default(""),
    updatedAt: integer("updated_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => [
    primaryKey({ columns: [t.worker, t.resourceId] }),
    index("idx_resource_bindings_resource").on(t.resourceId),
  ],
);

export const insertCfResourceSchema = createInsertSchema(cfResources);
export const selectCfResourceSchema = createSelectSchema(cfResources);
export type CfResourceRow = typeof cfResources.$inferSelect;
export type NewCfResourceRow = typeof cfResources.$inferInsert;
export type ResourceUsageSnapshotRow = typeof resourceUsageSnapshots.$inferSelect;
export type NewResourceUsageSnapshotRow = typeof resourceUsageSnapshots.$inferInsert;
export type ResourceBindingRow = typeof resourceBindings.$inferSelect;
export type NewResourceBindingRow = typeof resourceBindings.$inferInsert;
