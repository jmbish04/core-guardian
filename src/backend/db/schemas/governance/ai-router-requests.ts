/**
 * @fileoverview `ai_router_requests` — one immutable row per AI Router call.
 * Superset of ai_usage_registrations: carries project, importance, routing
 * mode, split in/out cost, error + circuit-breaker outcome, and the extra
 * (payloadJson) fields. Prompt bodies live in PROMPTS KV keyed by this id.
 * @see {@link file://src/backend/guardian/ai-router/capture.ts}
 */
import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const AI_ROUTER_REQUESTS_TABLE_DESCRIPTION =
  "Append-only per-request log for the AI Router: routing mode, project, importance, tokens, split cost, error + circuit-breaker outcome.";

export const AI_ROUTER_REQUESTS_COLUMN_DESCRIPTIONS: Record<string, string> = {
  id: "Request UUID (also the PROMPTS KV key suffix).",
  at: "Unix ms the request was received.",
  project: "Invoking app/worker (required).",
  importance: "low | medium | high — criticality of the call.",
  provider: "Upstream provider (openai, anthropic, google, workers-ai).",
  model: "Model id as billed.",
  mode: "Routing mode used (gateway, native, gemini-native, ...).",
  gateway: "AI Gateway id, or null for bypass modes.",
  tokensIn: "Input tokens.",
  tokensOut: "Output tokens.",
  tokensInCost: "USD cost of input tokens.",
  tokensOutCost: "USD cost of output tokens.",
  costUsd: "tokensInCost + tokensOutCost.",
  isError: "1 = upstream/handler error.",
  errorMessage: "Error text when isError.",
  isCircuitBreaker: "1 = rejected by a breaker/kill switch (no provider call).",
  circuitBrokenMessage: "Which breaker tripped and why.",
  costRowId: "ai_gateway_costs row id this fed.",
  payloadJson: "JSON of non-standard top-level request keys.",
  createdAt: "Unix ms row written.",
};

export const aiRouterRequests = sqliteTable(
  "ai_router_requests",
  {
    id: text("id").primaryKey(),
    at: integer("at").notNull(),
    project: text("project").notNull(),
    importance: text("importance", { enum: ["low", "medium", "high"] }).notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    mode: text("mode").notNull(),
    gateway: text("gateway"),
    tokensIn: real("tokens_in").notNull().default(0),
    tokensOut: real("tokens_out").notNull().default(0),
    tokensInCost: real("tokens_in_cost").notNull().default(0),
    tokensOutCost: real("tokens_out_cost").notNull().default(0),
    costUsd: real("cost_usd").notNull().default(0),
    isError: integer("is_error", { mode: "boolean" }).notNull().default(false),
    errorMessage: text("error_message"),
    isCircuitBreaker: integer("is_circuit_breaker", { mode: "boolean" }).notNull().default(false),
    circuitBrokenMessage: text("circuit_broken_message"),
    costRowId: text("cost_row_id"),
    payloadJson: text("payload_json"),
    createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
  },
  (t) => [
    index("idx_ai_router_req_project").on(t.project),
    index("idx_ai_router_req_model").on(t.model),
    index("idx_ai_router_req_at").on(t.at),
  ],
);

export const insertAiRouterRequestSchema = createInsertSchema(aiRouterRequests);
export const selectAiRouterRequestSchema = createSelectSchema(aiRouterRequests);
export type AiRouterRequestRow = typeof aiRouterRequests.$inferSelect;
export type NewAiRouterRequestRow = typeof aiRouterRequests.$inferInsert;
