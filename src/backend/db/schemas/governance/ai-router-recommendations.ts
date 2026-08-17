/**
 * @fileoverview `ai_router_recommendations` — cheaper-model suggestions for
 * project+provider+model combos seen by the AI Router. Row id is a dedup key
 * (`${project}:${provider}:${model}`) so a refresh overwrites the open rec
 * instead of accumulating duplicates. `source` distinguishes local heuristic
 * suggestions from ones dispatched to Jules for a follow-up PR.
 */
import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const AI_ROUTER_RECOMMENDATIONS_TABLE_DESCRIPTION =
  "Cheaper-model recommendations per project+provider+model, optionally dispatched to Jules for a PR.";

export const AI_ROUTER_RECOMMENDATIONS_COLUMN_DESCRIPTIONS: Record<string, string> = {
  id: "Dedup key: `${project}:${provider}:${model}`.",
  at: "Unix ms the recommendation was computed.",
  project: "Invoking app/worker this recommendation applies to.",
  provider: "Current provider in use.",
  model: "Current model in use.",
  suggestedProvider: "Suggested replacement provider, if any.",
  suggestedModel: "Suggested replacement model, if any.",
  rationale: "Human-readable reason for the suggestion.",
  estMonthlySavingsUsd: "Estimated USD/month saved by switching.",
  source: "local | jules — heuristic-generated vs Jules-dispatched.",
  julesSessionId: "Jules session id, when dispatched.",
  prUrl: "PR URL opened by Jules, when available.",
  status: "open | dispatched | pr_opened | dismissed.",
  createdAt: "Unix ms row written.",
};

export const aiRouterRecommendations = sqliteTable(
  "ai_router_recommendations",
  {
    id: text("id").primaryKey(),
    at: integer("at").notNull(),
    project: text("project").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    suggestedProvider: text("suggested_provider"),
    suggestedModel: text("suggested_model"),
    rationale: text("rationale").notNull().default(""),
    estMonthlySavingsUsd: real("est_monthly_savings_usd").notNull().default(0),
    source: text("source", { enum: ["local", "jules"] }).notNull().default("local"),
    julesSessionId: text("jules_session_id"),
    prUrl: text("pr_url"),
    status: text("status", { enum: ["open", "dispatched", "pr_opened", "dismissed"] })
      .notNull()
      .default("open"),
    createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
  },
  (t) => [index("idx_ai_router_rec_project").on(t.project), index("idx_ai_router_rec_at").on(t.at)],
);

export const insertAiRouterRecommendationSchema = createInsertSchema(aiRouterRecommendations);
export const selectAiRouterRecommendationSchema = createSelectSchema(aiRouterRecommendations);
export type AiRouterRecommendationRow = typeof aiRouterRecommendations.$inferSelect;
export type NewAiRouterRecommendationRow = typeof aiRouterRecommendations.$inferInsert;
