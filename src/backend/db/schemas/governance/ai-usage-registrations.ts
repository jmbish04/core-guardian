/**
 * @fileoverview `ai_usage_registrations` — append-only trace log of AI usage
 * registered by hand (calls that never touched an AI Gateway, e.g. the Gemini
 * interactions API).
 *
 * The cost roll-up lives in `ai_gateway_costs` (accumulated per day/provider/
 * model), but that aggregate can't carry per-call context. This log keeps one
 * immutable row per registration so usage stays traceable to its source: which
 * worker or application made the call, and optionally the operation id and a
 * task description. `costRowId` points back at the aggregate row the same
 * registration accumulated into.
 *
 * @see {@link file://src/backend/guardian/register-usage.ts} for the writer.
 * @see {@link file://src/backend/db/schemas/governance/ai-gateway-costs.ts} for the roll-up.
 */

import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const AI_USAGE_REGISTRATIONS_TABLE_DESCRIPTION =
  "Append-only trace log of manually-registered AI usage (calls that bypassed AI Gateway), tagged with the originating worker/application and optional operation context.";

export const AI_USAGE_REGISTRATIONS_COLUMN_DESCRIPTIONS: Record<string, string> = {
  id: "Registration id (uuid).",
  worker: "Originating worker or application — where the AI usage came from (required).",
  operationId: "Optional caller-supplied operation/request id for correlation.",
  taskDescription: "Optional human description of what the usage was for.",
  gateway: "Synthetic gateway tag the usage was grouped under (default 'direct').",
  provider: "Upstream provider (openai, anthropic, google-ai-studio, …).",
  model: "Model id as billed.",
  requests: "Requests in this batch.",
  costUsd: "USD cost recorded for this batch.",
  tokensIn: "Input tokens.",
  tokensOut: "Output tokens (as reported by the caller, excluding thinking).",
  tokensThinking: "Reasoning/thinking tokens, incl. interim thought images. Billed at the output rate; folded into tokensOut in the ai_gateway_costs roll-up, kept separate here.",
  priced: "How cost was set: explicit | scraped | unmatched.",
  costRowId: "The ai_gateway_costs row id this registration accumulated into.",
  at: "Unix ms the usage occurred.",
  createdAt: "Unix ms this row was written.",
};

export const aiUsageRegistrations = sqliteTable("ai_usage_registrations", {
  id: text("id").primaryKey(),
  worker: text("worker").notNull(),
  operationId: text("operation_id"),
  taskDescription: text("task_description"),
  gateway: text("gateway").notNull().default("direct"),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  requests: integer("requests").notNull().default(0),
  costUsd: real("cost_usd").notNull().default(0),
  tokensIn: real("tokens_in").notNull().default(0),
  tokensOut: real("tokens_out").notNull().default(0),
  tokensThinking: real("tokens_thinking").notNull().default(0),
  priced: text("priced").notNull(),
  costRowId: text("cost_row_id").notNull(),
  at: integer("at").notNull(),
  createdAt: integer("created_at")
    .notNull()
    .$defaultFn(() => Date.now()),
});

export const insertAiUsageRegistrationSchema = createInsertSchema(aiUsageRegistrations);
export const selectAiUsageRegistrationSchema = createSelectSchema(aiUsageRegistrations);
export type AiUsageRegistrationRow = typeof aiUsageRegistrations.$inferSelect;
export type NewAiUsageRegistrationRow = typeof aiUsageRegistrations.$inferInsert;
