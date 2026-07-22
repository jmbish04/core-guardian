/**
 * @fileoverview `ai_model_pricing` — the multi-provider AI model + price catalog.
 *
 * Refreshed weekly from each provider's public pricing page (Anthropic, Google,
 * OpenAI) plus the Cloudflare Workers AI models API. Append-only: every weekly
 * scrape inserts a fresh row per (provider, api_model_name) stamped with
 * `scraped_at`, so a usage-cost calculation can look up the price that was in
 * effect at the time of use (pricing fluctuates within a month).
 *
 * @see {@link file://src/backend/guardian/ai-model-pricing.ts} for the scraper.
 */

import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const AI_MODEL_PRICING_TABLE_DESCRIPTION =
  "Multi-provider AI model catalog with per-million-token input/output pricing, refreshed weekly. Append-only and stamped with scraped_at for time-aware cost lookups.";

export const AI_MODEL_PRICING_COLUMN_DESCRIPTIONS: Record<string, string> = {
  id: "Unique row id (UUID v4).",
  provider: "anthropic | google | openai | workers-ai.",
  model: "Human display name (e.g. 'Claude Sonnet 4.5', 'GPT-4o').",
  api_model_name: "Exact id to pass to the API/SDK (e.g. 'claude-sonnet-4-5', '@cf/openai/gpt-oss-120b').",
  description: "Short description of the model.",
  best_used_for: "What the model is best suited for (agentic, coding, cheap bulk, vision, etc.).",
  input_price_per_million: "USD per 1M input tokens.",
  output_price_per_million: "USD per 1M output tokens.",
  cached_input_price_per_million: "USD per 1M cached input tokens, if the provider offers prompt caching.",
  currency: "ISO currency (USD).",
  source_url: "Where the price was scraped from.",
  scraped_at: "Unix ms this row was captured — the pricing's effective time.",
};

export const aiModelPricing = sqliteTable("ai_model_pricing", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  apiModelName: text("api_model_name").notNull(),
  description: text("description"),
  bestUsedFor: text("best_used_for"),
  inputPricePerMillion: real("input_price_per_million"),
  outputPricePerMillion: real("output_price_per_million"),
  cachedInputPricePerMillion: real("cached_input_price_per_million"),
  currency: text("currency").notNull().default("USD"),
  sourceUrl: text("source_url"),
  scrapedAt: integer("scraped_at")
    .notNull()
    .$defaultFn(() => Date.now()),
});

export const insertAiModelPricingSchema = createInsertSchema(aiModelPricing);
export const selectAiModelPricingSchema = createSelectSchema(aiModelPricing);
export type AiModelPricingRow = typeof aiModelPricing.$inferSelect;
export type NewAiModelPricingRow = typeof aiModelPricing.$inferInsert;
