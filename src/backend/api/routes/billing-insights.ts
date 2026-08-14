/**
 * @fileoverview P8 Actionable-Insights routes — the accumulation + one-click
 * "end the bleeding" layer of the Spend Offense (mounted at
 * `/api/guardian/billing`).
 *
 * Kept in its own router (not `routes/offense.ts`) purely to avoid colliding
 * with a parallel PR that heavily edits that file. Both endpoints are gated by
 * {@link guardianAuth} (session cookie or `WORKER_API_KEY` bearer).
 *
 *  - `GET  /insights`               — the dashboard headline: month-to-date
 *    running total, straight-line projection, "since your last visit" delta
 *    (recorded in KV on read), and the ranked recurrence anomalies that make a
 *    $22/day drip read as "5 days running · $110 total" instead of a static bug.
 *  - `POST /controls/project-circuit` — wraps the AI Router's existing circuit
 *    breakers to cap/lock/freeze/unfreeze a project's spend, auditing every
 *    action to `billing_events`.
 *
 * ZERO AI in any analysis — pure queries + arithmetic (see
 * {@link file://src/backend/guardian/offense/insights.ts}).
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

import { getDb } from "@/backend/db";
import { billingEvents } from "@/backend/db/schema";
import {
  deleteCircuit,
  getCircuit,
  getKillSwitch,
  setCircuit,
} from "@/backend/guardian/ai-router/circuits";
import type { Circuit } from "@/backend/guardian/ai-router/types";
import { getDailyCostReport } from "@/backend/guardian/daily-cost";
import { getInsights } from "@/backend/guardian/offense/insights";
import {
  DEFAULT_INFRA_SPIKE_USD,
  getMtdTotal,
  INFRA_SPIKE_KEY,
  monthPrefix,
  nonAiServiceMtds,
  NUCLEAR_BUDGET_KEY,
  overBudget,
  overThreshold,
  readConfigNumber,
} from "@/backend/guardian/offense/nuclear";

import { upsertConfig } from "./config";
import { guardianAuth } from "./guardian";

export const billingInsightsRouter = new OpenAPIHono<{ Bindings: Env }>();
billingInsightsRouter.use("*", guardianAuth);

const errorResponseSchema = z.object({ error: z.string() });
const unauthorized = {
  description: "Missing or invalid session cookie / WORKER_API_KEY bearer token",
  content: { "application/json": { schema: errorResponseSchema } },
} as const;

// ---------------------------------------------------------------------------
// GET /api/guardian/billing/insights
// ---------------------------------------------------------------------------

const anomalySchema = z.object({
  source: z.enum(["router", "workers-ai-neurons"]),
  model: z.string(),
  provider: z.string().nullable(),
  project: z.string().nullable(),
  streakDays: z.number(),
  streakTotalUsd: z.number(),
  perDayUsd: z.number(),
  cadence: z.enum(["hourly", "daily", "weekly", "sporadic"]),
  callCount: z.number().nullable(),
  neuronsPerDay: z.number().nullable(),
  lastDay: z.string(),
});

const insightsResponseSchema = z.object({
  mtdUsd: z.number(),
  mtdSource: z.enum(["actual", "estimate"]),
  estimateUsd: z.number(),
  projectedMonthEnd: z.number(),
  sinceLastVisit: z.object({
    deltaUsd: z.number().nullable(),
    daysSince: z.number().nullable(),
    at: z.number().nullable(),
  }),
  anomalies: z.array(anomalySchema),
});

billingInsightsRouter.openapi(
  createRoute({
    method: "get",
    path: "/insights",
    operationId: "guardianBillingInsights",
    summary: "Month-to-date spend, projection, since-last-visit delta, ranked anomalies",
    description:
      "The headline data for the Spend Offense dashboard, fully deterministic (no AI). `mtdUsd` is the running month-to-date total from the reconstructed daily-cost rollup; `projectedMonthEnd` is its straight-line month-end projection. `sinceLastVisit` diffs this visit's MTD against the previous visit stored in KV (and records this one) — the signal the v1 dashboard lacked. `anomalies` are ranked recurrence findings (per project+model from the router, plus per-model Workers-AI neuron drips): each carries consecutive-day streak, accumulated streak total, cadence, call count and neurons/day so a recurring drip is loud instead of static.",
    responses: {
      200: {
        description: "Headline insights + ranked anomalies",
        content: { "application/json": { schema: insightsResponseSchema } },
      },
      401: unauthorized,
    },
  }),
  async (c) => c.json(await getInsights(c.env), 200),
);

// ---------------------------------------------------------------------------
// POST /api/guardian/billing/controls/project-circuit
// ---------------------------------------------------------------------------

const circuitStateSchema = z.object({
  budgetUsd: z.number(),
  window: z.enum(["day", "week", "month", "total"]),
  enabled: z.boolean(),
  breakGlassUntil: z.number().optional(),
});

/** How each action maps onto the AI Router circuit for `project:<p>`. */
function circuitFor(action: string, budgetUsd?: number): Circuit | null {
  switch (action) {
    case "set-budget":
      return { budgetUsd: budgetUsd!, window: "month", enabled: true };
    case "lock-month":
      return { budgetUsd: 0, window: "month", enabled: true };
    case "freeze":
      // Sticky: budget 0 over the "total" (all-time) window until unfrozen.
      return { budgetUsd: 0, window: "total", enabled: true };
    case "unfreeze":
      return null; // delete the circuit entirely
    default:
      return null;
  }
}

billingInsightsRouter.openapi(
  createRoute({
    method: "post",
    path: "/controls/project-circuit",
    operationId: "guardianBillingProjectCircuit",
    summary: "Cap / lock / freeze / unfreeze a project's AI spend (the 'end the bleeding' action)",
    description:
      "Wraps the AI Router's existing `project:<name>` circuit breaker — no parallel breaker system. `set-budget` caps monthly spend at `budgetUsd`; `lock-month` sets a $0 monthly cap (stops spend for the rest of the month); `freeze` sets a sticky $0 all-time cap; `unfreeze` removes the circuit entirely. Every action appends a `billing_events` audit row and returns the resulting circuit state (null after unfreeze).",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              project: z.string().min(1),
              action: z.enum(["set-budget", "lock-month", "freeze", "unfreeze"]),
              budgetUsd: z.number().nonnegative().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Circuit updated + audited",
        content: {
          "application/json": {
            schema: z.object({
              project: z.string(),
              action: z.string(),
              scope: z.string(),
              circuit: circuitStateSchema.nullable(),
              eventId: z.string(),
              timestamp: z.number(),
            }),
          },
        },
      },
      400: {
        description: "Invalid project (contains ':') or missing budgetUsd for set-budget",
        content: { "application/json": { schema: errorResponseSchema } },
      },
      401: unauthorized,
    },
  }),
  async (c) => {
    const { project, action, budgetUsd } = c.req.valid("json");

    // Reject ':' so the project can't collide with the circuit KV scope prefixes
    // (mirror of the AI Router ingress guard: "project:" / "model:" / ...).
    if (project.includes(":")) {
      return c.json({ error: `"project" must not contain ':'` }, 400);
    }
    if (action === "set-budget" && budgetUsd === undefined) {
      return c.json({ error: "budgetUsd is required for action 'set-budget'" }, 400);
    }

    const scope = `project:${project}`;
    const next = circuitFor(action, budgetUsd);
    if (next) await setCircuit(c.env, scope, next);
    else await deleteCircuit(c.env, scope);

    const eventId = crypto.randomUUID();
    const timestamp = Date.now();
    const actionTaken =
      action === "set-budget"
        ? `project-circuit set-budget ${project} → $${budgetUsd}/month`
        : `project-circuit ${action} ${project}`;
    await getDb(c.env)
      .insert(billingEvents)
      .values({ id: eventId, service: "ai-router", actionTaken, timestamp });

    return c.json(
      { project, action, scope, circuit: await getCircuit(c.env, scope), eventId, timestamp },
      200,
    );
  },
);

// ---------------------------------------------------------------------------
// GET /api/guardian/billing/budget-status
// ---------------------------------------------------------------------------

const budgetStatusSchema = z.object({
  mtdUsd: z.number(),
  mtdSource: z.enum(["billed", "estimated"]),
  nuclearBudgetUsd: z.number().nullable(),
  overBudget: z.boolean(),
  killSwitchEngaged: z.boolean(),
  infraThresholdUsd: z.number(),
  nonAiServices: z.array(
    z.object({ service: z.string(), mtdUsd: z.number(), overThreshold: z.boolean() }),
  ),
});

billingInsightsRouter.openapi(
  createRoute({
    method: "get",
    path: "/budget-status",
    operationId: "guardianBillingBudgetStatus",
    summary: "Total-CF-budget meter + non-AI infra breakdown (the nuclear-breaker state)",
    description:
      "The P9a dashboard header. `mtdUsd` is month-to-date TOTAL Cloudflare spend — preferring Cloudflare's actual billed figures and falling back to the reconstructed estimate (`mtdSource`). `nuclearBudgetUsd` is the configured total-CF budget (null = unset, nuke disabled); `overBudget` compares the two; `killSwitchEngaged` reflects whether all AI is currently blocked. `nonAiServices` breaks non-AI spend out by service with `overThreshold` flagging an infra spike. Zero AI in the analysis.",
    responses: {
      200: {
        description: "Total-budget meter + infra breakdown",
        content: { "application/json": { schema: budgetStatusSchema } },
      },
      401: unauthorized,
    },
  }),
  async (c) => {
    const [{ mtdUsd, mtdSource }, nuclearBudgetUsd, infraThresholdRaw, killSwitchEngaged, report] =
      await Promise.all([
        getMtdTotal(c.env),
        readConfigNumber(c.env, NUCLEAR_BUDGET_KEY, null),
        readConfigNumber(c.env, INFRA_SPIKE_KEY, DEFAULT_INFRA_SPIKE_USD),
        getKillSwitch(c.env),
        getDailyCostReport(c.env, 35),
      ]);
    const infraThresholdUsd = infraThresholdRaw ?? DEFAULT_INFRA_SPIKE_USD;
    const nonAiServices = nonAiServiceMtds(report, monthPrefix()).map((s) => ({
      service: s.service,
      mtdUsd: s.mtdUsd,
      overThreshold: overThreshold(s.mtdUsd, infraThresholdUsd),
    }));

    return c.json(
      {
        mtdUsd,
        mtdSource,
        nuclearBudgetUsd,
        overBudget: nuclearBudgetUsd != null && nuclearBudgetUsd > 0 && overBudget(mtdUsd, nuclearBudgetUsd),
        killSwitchEngaged,
        infraThresholdUsd,
        nonAiServices,
      },
      200,
    );
  },
);

// ---------------------------------------------------------------------------
// POST /api/guardian/billing/budget-config
// ---------------------------------------------------------------------------

billingInsightsRouter.openapi(
  createRoute({
    method: "post",
    path: "/budget-config",
    operationId: "guardianBillingBudgetConfig",
    summary: "Set the nuclear total-CF budget and/or the non-AI infra-spike threshold",
    description:
      "Upserts the P9a guard config into `global_config` (`nuclear_budget_usd`, `infra_spike_threshold_usd`). Both fields are optional — send only what you want to change. Every change appends a `billing_events` audit row. Returns the effective config after the write.",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              nuclearBudgetUsd: z.number().nonnegative().optional(),
              infraThresholdUsd: z.number().nonnegative().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Config upserted + audited",
        content: {
          "application/json": {
            schema: z.object({
              nuclearBudgetUsd: z.number().nullable(),
              infraThresholdUsd: z.number(),
              eventId: z.string(),
              timestamp: z.number(),
            }),
          },
        },
      },
      401: unauthorized,
    },
  }),
  async (c) => {
    const { nuclearBudgetUsd, infraThresholdUsd } = c.req.valid("json");

    const changes: string[] = [];
    if (nuclearBudgetUsd !== undefined) {
      await upsertConfig(c.env, NUCLEAR_BUDGET_KEY, nuclearBudgetUsd);
      changes.push(`nuclear_budget_usd → $${nuclearBudgetUsd}`);
    }
    if (infraThresholdUsd !== undefined) {
      await upsertConfig(c.env, INFRA_SPIKE_KEY, infraThresholdUsd);
      changes.push(`infra_spike_threshold_usd → $${infraThresholdUsd}`);
    }

    const eventId = crypto.randomUUID();
    const timestamp = Date.now();
    await getDb(c.env)
      .insert(billingEvents)
      .values({
        id: eventId,
        service: "offense",
        actionTaken: `budget-config: ${changes.length ? changes.join(", ") : "no change"}`,
        timestamp,
      });

    return c.json(
      {
        nuclearBudgetUsd: await readConfigNumber(c.env, NUCLEAR_BUDGET_KEY, null),
        infraThresholdUsd:
          (await readConfigNumber(c.env, INFRA_SPIKE_KEY, DEFAULT_INFRA_SPIKE_USD)) ??
          DEFAULT_INFRA_SPIKE_USD,
        eventId,
        timestamp,
      },
      200,
    );
  },
);
