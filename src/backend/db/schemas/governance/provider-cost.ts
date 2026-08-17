/**
 * @fileoverview `provider_cost` — daily billed cost from EXTERNAL AI providers
 * (Anthropic, OpenAI, Cursor) plus Gemini's Cloud Billing budget ceiling.
 *
 * Everything else in Guardian monitors Cloudflare spend. This table is the
 * off-Cloudflare complement: a daily-gated step on the hourly cron pulls each
 * provider's own billing API (see {@link file://src/backend/guardian/providers/sync.ts})
 * and persists one row per provider per UTC day so the panel can chart external AI spend
 * alongside the CF numbers and the alert layer can fire on a threshold breach.
 *
 * `metric` distinguishes the two shapes we can actually get:
 *  - `"spent"` — real charged USD for the day (Anthropic cost report, OpenAI
 *    costs API, Cursor team spend). `costUsd` is the dollars charged.
 *  - `"budget"` — Gemini/GCP has no per-key spend API without BigQuery export;
 *    the Cloud Billing **Budgets** API only returns the configured ceiling. So a
 *    Gemini row carries the budget amount in `costUsd` with `metric = "budget"`,
 *    and the alert layer never treats it as spend. Honest, not fabricated.
 *
 * `costUsd` is NULL when the provider returned usage but no dollar figure (never
 * an invented number). `dimension` is a per-model / per-budget sub-line, or ""
 * for the provider's daily headline. PK is deterministic (`day:provider:dimension`)
 * so a re-sync of the same day upserts rather than duplicating.
 */

import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

// ---------------------------------------------------------------------------
// Table & column documentation (consumed by /api/docs/schema)
// ---------------------------------------------------------------------------

export const PROVIDER_COST_TABLE_DESCRIPTION =
  "Daily billed cost per external AI provider (Anthropic/OpenAI/Cursor), plus the Gemini Cloud Billing budget ceiling. Pulled hourly from each provider's own billing API; retained permanently for trend.";

export const PROVIDER_COST_COLUMN_DESCRIPTIONS: Record<string, string> = {
  id: "Deterministic key: day:provider:dimension.",
  day: "UTC date bucket (YYYY-MM-DD).",
  day_start: "Unix ms at the start of `day` (for range queries).",
  provider: "External provider: anthropic | openai | gemini | cursor.",
  dimension: 'Per-model / per-budget sub-line, or "" for the daily headline.',
  metric: '"spent" (real charged USD) or "budget" (configured ceiling, Gemini only).',
  cost_usd: "USD charged (spent) or budget ceiling (budget); NULL when the provider gave no dollar figure.",
  currency: "Reported currency for cost_usd.",
  source: "Which API produced the row (e.g. anthropic-cost-report, openai-costs, cursor-spend, gcp-budget).",
  captured_at: "Unix ms this row was fetched/updated.",
};

/** The four providers we can onboard a billing key for. */
export const PROVIDERS = ["anthropic", "openai", "gemini", "cursor"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const providerCost = sqliteTable(
  "provider_cost",
  {
    id: text("id").primaryKey(),
    day: text("day").notNull(),
    dayStart: integer("day_start").notNull(),
    provider: text("provider").notNull(),
    dimension: text("dimension").notNull().default(""),
    metric: text("metric", { enum: ["spent", "budget"] })
      .notNull()
      .default("spent"),
    costUsd: real("cost_usd"),
    currency: text("currency").notNull().default("USD"),
    source: text("source").notNull().default(""),
    capturedAt: integer("captured_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => [
    index("idx_provider_cost_day_start").on(t.dayStart),
    index("idx_provider_cost_provider").on(t.provider),
  ],
);

export const insertProviderCostSchema = createInsertSchema(providerCost);
export const selectProviderCostSchema = createSelectSchema(providerCost);
export type ProviderCostRow = typeof providerCost.$inferSelect;
export type NewProviderCostRow = typeof providerCost.$inferInsert;
