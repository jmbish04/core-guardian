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
  setCircuit,
} from "@/backend/guardian/ai-router/circuits";
import type { Circuit } from "@/backend/guardian/ai-router/types";
import { getInsights } from "@/backend/guardian/offense/insights";

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
