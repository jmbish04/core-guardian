/**
 * @fileoverview `ai_gateway_costs` — actual per-model cost Cloudflare recorded
 * for traffic routed through an AI Gateway.
 *
 * The GraphQL `aiGatewayRequestsAdaptiveGroups` dataset carries the real
 * upstream `cost` (Unified Billing / BYOK) plus tokens per gateway/provider/
 * model, but only for ~31 days. A daily cron snapshots it here so we keep
 * permanent history — the authoritative "what Cloudflare actually charged"
 * counterpart to the scraped provider list prices, used for the drift check and
 * the dual-source pricing query.
 *
 * PK is deterministic (`day:gateway:provider:model`) so a re-snapshot of the
 * same day upserts rather than duplicating.
 *
 * @see {@link file://src/backend/guardian/ai-gateway-costs.ts} for the writer.
 */

import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const AI_GATEWAY_COSTS_TABLE_DESCRIPTION =
  "Daily snapshot of actual per-model cost + tokens Cloudflare recorded for AI Gateway traffic (from GraphQL analytics), retained permanently.";

export const AI_GATEWAY_COSTS_COLUMN_DESCRIPTIONS: Record<string, string> = {
  id: "Deterministic key: day:gateway:provider:model.",
  day: "UTC date bucket (YYYY-MM-DD).",
  dayStart: "Unix ms at the start of the day bucket (for range queries).",
  gateway: "AI Gateway id the traffic ran through.",
  provider: "Upstream provider (openai, anthropic, google-ai-studio, workers-ai, …).",
  model: "Model id as the gateway saw it.",
  requests: "Request count that day.",
  costUsd: "Actual USD cost Cloudflare recorded for those requests.",
  tokensIn: "Uncached input tokens.",
  tokensOut: "Uncached output tokens.",
  capturedAt: "Unix ms this snapshot row was written/updated.",
};

export const aiGatewayCosts = sqliteTable("ai_gateway_costs", {
  id: text("id").primaryKey(),
  day: text("day").notNull(),
  dayStart: integer("day_start").notNull(),
  gateway: text("gateway").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  requests: integer("requests").notNull().default(0),
  costUsd: real("cost_usd").notNull().default(0),
  tokensIn: real("tokens_in").notNull().default(0),
  tokensOut: real("tokens_out").notNull().default(0),
  capturedAt: integer("captured_at")
    .notNull()
    .$defaultFn(() => Date.now()),
});

export const insertAiGatewayCostSchema = createInsertSchema(aiGatewayCosts);
export const selectAiGatewayCostSchema = createSelectSchema(aiGatewayCosts);
export type AiGatewayCostRow = typeof aiGatewayCosts.$inferSelect;
export type NewAiGatewayCostRow = typeof aiGatewayCosts.$inferInsert;
