/**
 * @fileoverview External-provider billing routes (mounted at
 * `/api/guardian/providers`). Gated by {@link guardianAuth}.
 *
 *  - `GET  /report`  — per-provider daily spend series + month-to-date totals.
 *  - `GET  /budgets` — the configured monthly budgets + Gemini billing-account id.
 *  - `PUT  /budgets` — set provider budgets / Gemini billing-account id.
 *  - `POST /sync`    — pull all provider billing APIs now + run threshold alerts.
 *
 * Provider **billing keys** (Anthropic/OpenAI admin keys) are
 * onboarded as Secrets Store bindings, NOT here — see wrangler.jsonc. This route
 * only manages the non-secret budget/threshold config.
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";

import { getDb } from "@/backend/db";
import { globalConfig, PROVIDERS } from "@/backend/db/schema";
import { readConfigNumber } from "@/backend/guardian/offense/nuclear";
import {
  checkProviderSpendAlerts,
  getProviderCostReport,
  providerBudgetKey,
  syncProviderCosts,
} from "@/backend/guardian/providers/sync";

import { upsertConfig } from "./config";
import { guardianAuth } from "./guardian";

export const providersRouter = new OpenAPIHono<{ Bindings: Env }>();
providersRouter.use("*", guardianAuth);

const errorResponseSchema = z.object({ error: z.string() });
const unauthorized = {
  description: "Missing or invalid session cookie / WORKER_API_KEY bearer token",
  content: { "application/json": { schema: errorResponseSchema } },
} as const;

const GEMINI_ACCOUNT_KEY = "gemini_billing_account_id";

// ---------------------------------------------------------------------------
// GET /report
// ---------------------------------------------------------------------------

const seriesSchema = z.object({
  provider: z.enum(PROVIDERS),
  metric: z.enum(["spent", "budget"]),
  currency: z.string(),
  points: z.array(z.object({ day: z.string(), costUsd: z.number().nullable() })),
  mtdUsd: z.number(),
  deltaUsd: z.number().nullable(),
});

providersRouter.openapi(
  createRoute({
    method: "get",
    path: "/report",
    operationId: "guardianProvidersReport",
    summary: "External AI provider spend — per-provider daily series + MTD totals",
    description:
      "Daily billed cost per external provider (Anthropic/OpenAI) from each provider's own billing API, plus Gemini's Cloud Billing budget ceiling (metric='budget'). `totalSpentMtdUsd` sums only spend, not budget ceilings.",
    request: { query: z.object({ days: z.coerce.number().int().min(1).max(90).default(35) }) },
    responses: {
      200: {
        description: "Provider spend report",
        content: {
          "application/json": {
            schema: z.object({
              month: z.string(),
              totalSpentMtdUsd: z.number(),
              providers: z.array(seriesSchema),
            }),
          },
        },
      },
      401: unauthorized,
    },
  }),
  async (c) => c.json(await getProviderCostReport(c.env, c.req.valid("query").days), 200),
);

// ---------------------------------------------------------------------------
// GET /budgets
// ---------------------------------------------------------------------------

async function readBudgets(env: Env) {
  const budgets: Record<string, number | null> = {};
  for (const p of PROVIDERS) budgets[p] = await readConfigNumber(env, providerBudgetKey(p), null);
  return budgets;
}

async function readGeminiAccount(env: Env): Promise<string | null> {
  const [row] = await getDb(env)
    .select()
    .from(globalConfig)
    .where(eq(globalConfig.key, GEMINI_ACCOUNT_KEY))
    .limit(1);
  return typeof row?.value === "string" && row.value.trim() ? row.value.trim() : null;
}

providersRouter.openapi(
  createRoute({
    method: "get",
    path: "/budgets",
    operationId: "guardianProvidersBudgetsGet",
    summary: "Configured monthly budgets per provider + Gemini billing-account id",
    responses: {
      200: {
        description: "Budgets + Gemini account id",
        content: {
          "application/json": {
            schema: z.object({
              budgets: z.record(z.string(), z.number().nullable()),
              geminiBillingAccountId: z.string().nullable(),
            }),
          },
        },
      },
      401: unauthorized,
    },
  }),
  async (c) =>
    c.json(
      { budgets: await readBudgets(c.env), geminiBillingAccountId: await readGeminiAccount(c.env) },
      200,
    ),
);

// ---------------------------------------------------------------------------
// PUT /budgets
// ---------------------------------------------------------------------------

providersRouter.openapi(
  createRoute({
    method: "put",
    path: "/budgets",
    operationId: "guardianProvidersBudgetsPut",
    summary: "Set provider monthly budgets and/or the Gemini billing-account id",
    description:
      "All fields optional — send only what changes. A budget crossing fires ONE warning notification per month (no breaker; external providers can't be throttled).",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              budgets: z.record(z.enum(PROVIDERS), z.number().nonnegative()).optional(),
              geminiBillingAccountId: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Config after write",
        content: {
          "application/json": {
            schema: z.object({
              budgets: z.record(z.string(), z.number().nullable()),
              geminiBillingAccountId: z.string().nullable(),
            }),
          },
        },
      },
      401: unauthorized,
    },
  }),
  async (c) => {
    const { budgets, geminiBillingAccountId } = c.req.valid("json");
    if (budgets) {
      for (const [provider, value] of Object.entries(budgets)) {
        await upsertConfig(c.env, providerBudgetKey(provider as (typeof PROVIDERS)[number]), value);
      }
    }
    if (geminiBillingAccountId !== undefined) {
      await upsertConfig(c.env, GEMINI_ACCOUNT_KEY, geminiBillingAccountId);
    }
    return c.json(
      { budgets: await readBudgets(c.env), geminiBillingAccountId: await readGeminiAccount(c.env) },
      200,
    );
  },
);

// ---------------------------------------------------------------------------
// POST /sync
// ---------------------------------------------------------------------------

providersRouter.openapi(
  createRoute({
    method: "post",
    path: "/sync",
    operationId: "guardianProvidersSync",
    summary: "Pull all provider billing APIs now + run threshold alerts",
    responses: {
      200: {
        description: "Sync summary + alert results",
        content: {
          "application/json": {
            schema: z.object({
              synced: z.record(z.string(), z.object({ rows: z.number(), error: z.string().optional() })),
              alerts: z.array(
                z.object({
                  provider: z.enum(PROVIDERS),
                  mtdUsd: z.number(),
                  budgetUsd: z.number(),
                  fired: z.boolean(),
                }),
              ),
            }),
          },
        },
      },
      401: unauthorized,
    },
  }),
  async (c) => {
    const synced = await syncProviderCosts(c.env);
    const alerts = await checkProviderSpendAlerts(c.env);
    return c.json({ synced, alerts }, 200);
  },
);
