/**
 * @fileoverview AI model catalog + advisory routes — `/api/ai-models/*`.
 *
 * - GET  /api/ai-models          — list models + pricing (KV cache, D1 fallback)
 * - POST /api/ai-models/scrape   — refresh the catalog now (also weekly on cron)
 * - POST /api/ai-models/advise   — top-3 model picks for a use case + volume
 * - POST /api/ai-models/cost     — cost an array of usage scenarios (time-aware)
 *
 * Gated by {@link guardianAuth}. Mirrored by MCP tools of the same names.
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

import { guardianAuth } from "@/backend/api/routes/guardian";
import { adviseModels, calculateCosts, latestModels } from "@/backend/guardian/ai-model-advisor";
import { pricingHistory } from "@/backend/guardian/ai-gateway-costs";
import {
  PRICING_CACHE_KEY,
  scrapeAllModelPricing,
  scrapeOneProvider,
} from "@/backend/guardian/ai-model-pricing";

const errorResponseSchema = z.object({ error: z.string() });

const modelSchema = z.object({
  provider: z.string(),
  model: z.string(),
  apiModelName: z.string(),
  description: z.string().nullable(),
  bestUsedFor: z.string().nullable(),
  inputPricePerMillion: z.number().nullable(),
  outputPricePerMillion: z.number().nullable(),
  cachedInputPricePerMillion: z.number().nullable(),
  currency: z.string(),
  scrapedAt: z.number(),
});

export const aiModelsRouter = new OpenAPIHono<{ Bindings: Env }>();
aiModelsRouter.use("*", guardianAuth);

// GET /api/ai-models
aiModelsRouter.openapi(
  createRoute({
    method: "get",
    path: "/",
    operationId: "aiModelsList",
    summary: "List AI models + per-million-token pricing across providers",
    request: { query: z.object({ provider: z.string().optional() }) },
    responses: {
      200: {
        description: "Latest model + pricing per (provider, api_model_name)",
        content: {
          "application/json": {
            schema: z.object({ scrapedAt: z.number().nullable(), models: z.array(modelSchema) }),
          },
        },
      },
      401: { description: "Unauthorized", content: { "application/json": { schema: errorResponseSchema } } },
    },
  }),
  async (c) => {
    const provider = c.req.valid("query").provider;
    const rows = await latestModels(c.env);
    const models = (provider ? rows.filter((r) => r.provider === provider) : rows).map((r) => ({
      provider: r.provider,
      model: r.model,
      apiModelName: r.apiModelName,
      description: r.description,
      bestUsedFor: r.bestUsedFor,
      inputPricePerMillion: r.inputPricePerMillion,
      outputPricePerMillion: r.outputPricePerMillion,
      cachedInputPricePerMillion: r.cachedInputPricePerMillion,
      currency: r.currency,
      scrapedAt: r.scrapedAt,
    }));
    const scrapedAt = models.length > 0 ? Math.max(...models.map((m) => m.scrapedAt)) : null;
    return c.json({ scrapedAt, models }, 200);
  },
);

// POST /api/ai-models/scrape
aiModelsRouter.openapi(
  createRoute({
    method: "post",
    path: "/scrape",
    operationId: "aiModelsScrape",
    summary: "Refresh the model-pricing catalog now (also runs weekly on the cron)",
    request: {
      query: z.object({
        background: z.enum(["true", "false"]).optional(),
        provider: z.enum(["workers-ai", "anthropic", "google", "openai"]).optional(),
      }),
    },
    responses: {
      200: {
        description: "Scrape started (background) or counts (sync)",
        content: {
          "application/json": {
            schema: z.object({ started: z.boolean(), counts: z.record(z.string(), z.number()).optional() }),
          },
        },
      },
      401: { description: "Unauthorized", content: { "application/json": { schema: errorResponseSchema } } },
    },
  }),
  async (c) => {
    const { background, provider } = c.req.valid("query");
    // Single provider (sync) — for testing + resilient re-runs.
    if (provider) {
      const n = await scrapeOneProvider(c.env, provider);
      return c.json({ started: false, counts: { [provider]: n } }, 200);
    }
    // Default background (4 fetch+AI passes is slow); ?background=false for sync.
    if (background === "false") {
      const counts = await scrapeAllModelPricing(c.env);
      return c.json({ started: false, counts }, 200);
    }
    c.executionCtx.waitUntil(scrapeAllModelPricing(c.env).catch(() => {}));
    return c.json({ started: true }, 200);
  },
);

// POST /api/ai-models/advise
aiModelsRouter.openapi(
  createRoute({
    method: "post",
    path: "/advise",
    operationId: "aiModelsAdvise",
    summary: "Recommend the top-3 cheapest-capable models for a use case + volume",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              useCase: z.string().min(3),
              frequency: z.string().optional(),
              inputTokens: z.number().min(0).optional(),
              outputTokens: z.number().min(0).optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Top-3 recommendations",
        content: {
          "application/json": {
            schema: z.object({
              recommendations: z.array(
                z.object({
                  apiModelName: z.string(),
                  provider: z.string(),
                  why: z.string(),
                  estCostPerCall: z.number().nullable(),
                }),
              ),
              raw: z.string().optional(),
            }),
          },
        },
      },
      401: { description: "Unauthorized", content: { "application/json": { schema: errorResponseSchema } } },
    },
  }),
  async (c) => c.json(await adviseModels(c.env, c.req.valid("json")), 200),
);

// POST /api/ai-models/cost
aiModelsRouter.openapi(
  createRoute({
    method: "post",
    path: "/cost",
    operationId: "aiModelsCost",
    summary: "Cost an array of usage scenarios using the price in effect at each time",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              scenarios: z
                .array(
                  z.object({
                    provider: z.string().optional(),
                    model: z.string(),
                    inputTokens: z.number().min(0),
                    outputTokens: z.number().min(0),
                    at: z.number().optional(),
                  }),
                )
                .min(1),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Per-scenario cost + total",
        content: {
          "application/json": {
            schema: z.object({
              lines: z.array(
                z.object({
                  provider: z.string().optional(),
                  model: z.string(),
                  inputTokens: z.number(),
                  outputTokens: z.number(),
                  at: z.number().optional(),
                  matched: z.boolean(),
                  pricedAt: z.number().nullable(),
                  inputPricePerMillion: z.number().nullable(),
                  outputPricePerMillion: z.number().nullable(),
                  costUsd: z.number().nullable(),
                }),
              ),
              totalUsd: z.number(),
            }),
          },
        },
      },
      401: { description: "Unauthorized", content: { "application/json": { schema: errorResponseSchema } } },
    },
  }),
  async (c) => c.json(await calculateCosts(c.env, c.req.valid("json").scenarios), 200),
);

// POST /api/ai-models/pricing-history — advertised (scraped) vs actual (gateway)
aiModelsRouter.openapi(
  createRoute({
    method: "post",
    path: "/pricing-history",
    operationId: "aiModelsPricingHistory",
    summary: "Pricing for models over a date range: advertised (scraped) and/or actual (AI Gateway)",
    description:
      "Given model names and a date range, returns what each provider ADVERTISED (from our scraped pricing catalog captured in that window) and/or what Cloudflare's AI Gateway ACTUALLY recorded charging (from the snapshotted gateway costs). `source` defaults to both; set 'scraped' or 'gateway' to narrow. Example: query Gemini over 2026-07-31…2026-08-04 to see advertised-vs-actual.",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              models: z.array(z.string()).default([]),
              start: z.number(),
              end: z.number(),
              source: z.enum(["both", "scraped", "gateway"]).optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Pricing history from the requested source(s)",
        content: {
          "application/json": {
            schema: z.object({
              scraped: z.array(
                z.object({
                  provider: z.string(),
                  model: z.string(),
                  apiModelName: z.string(),
                  inputPricePerMillion: z.number().nullable(),
                  outputPricePerMillion: z.number().nullable(),
                  scrapedAt: z.number(),
                }),
              ),
              gateway: z.array(
                z.object({
                  provider: z.string(),
                  model: z.string(),
                  gateway: z.string(),
                  requests: z.number(),
                  costUsd: z.number(),
                  tokensIn: z.number(),
                  tokensOut: z.number(),
                  effectivePerMillion: z.number().nullable(),
                }),
              ),
            }),
          },
        },
      },
      401: { description: "Unauthorized", content: { "application/json": { schema: errorResponseSchema } } },
    },
  }),
  async (c) => {
    const { models, start, end, source } = c.req.valid("json");
    return c.json(await pricingHistory(c.env, models, start, end, source ?? "both"), 200);
  },
);

export { PRICING_CACHE_KEY };
