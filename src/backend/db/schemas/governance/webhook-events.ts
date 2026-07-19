/**
 * @fileoverview `webhook_events` table — raw inbound Cloudflare notifications.
 *
 * Every payload Cloudflare POSTs to the Guardian webhook receiver is stored
 * verbatim alongside the parsed fields we understand. Keeping the raw JSON
 * matters: Cloudflare's notification payloads vary by alert type and change
 * over time, and a payload we failed to parse is exactly the one worth reading
 * by hand.
 *
 * @see {@link file://src/backend/api/routes/cloudflare-webhook.ts} for the receiver.
 */

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

// ---------------------------------------------------------------------------
// Table & column documentation (consumed by /api/docs/schema)
// ---------------------------------------------------------------------------

export const WEBHOOK_EVENTS_TABLE_DESCRIPTION =
  "Raw inbound Cloudflare notification webhooks (billing usage/budget alerts, health checks, and any other configured alert type).";

export const WEBHOOK_EVENTS_COLUMN_DESCRIPTIONS: Record<string, string> = {
  id: "Unique event identifier (UUID v4).",
  alert_type: "Cloudflare alert type (e.g. billing_usage_alert, billing_budget_alert).",
  alert_name: "Human-readable notification name from the payload.",
  text: "Notification body text as sent by Cloudflare.",
  severity: "Severity reported by Cloudflare, when present.",
  account_id: "Account the notification concerns.",
  payload: "Complete raw JSON payload as received.",
  verified: "1 when the cf-webhook-auth header matched the stored secret.",
  received_at: "Unix timestamp (ms) when the webhook was received.",
};

// ---------------------------------------------------------------------------
// Table definition
// ---------------------------------------------------------------------------

export const webhookEvents = sqliteTable("webhook_events", {
  id: text("id").primaryKey(),
  alertType: text("alert_type").notNull().default("unknown"),
  alertName: text("alert_name"),
  text: text("text"),
  severity: text("severity"),
  accountId: text("account_id"),
  payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>(),
  verified: integer("verified", { mode: "boolean" }).notNull().default(false),
  receivedAt: integer("received_at")
    .notNull()
    .$defaultFn(() => Date.now()),
});

// ---------------------------------------------------------------------------
// Zod schemas & types
// ---------------------------------------------------------------------------

export const insertWebhookEventSchema = createInsertSchema(webhookEvents);
export const selectWebhookEventSchema = createSelectSchema(webhookEvents);
export type WebhookEventRow = typeof webhookEvents.$inferSelect;
export type NewWebhookEventRow = typeof webhookEvents.$inferInsert;
