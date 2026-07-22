/**
 * @fileoverview AI proxy + budget routes — `/api/ai/*`.
 *
 * The proxy relays a native provider call (caller supplies its own key via
 * `X-Provider-Key`) through the KV circuit breaker; the budget routes read and
 * set the monthly cap and the break-glass override. Gated by {@link guardianAuth}.
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

import { guardianAuth } from "@/backend/api/routes/guardian";
import {
  breakGlass,
  getBudgetStatus,
  proxyCall,
  setBudgetCap,
} from "@/backend/guardian/ai-proxy";

const errorResponseSchema = z.object({ error: z.string() });

const budgetSchema = z.object({
  cap: z.number().nullable(),
  spent: z.number(),
  remaining: z.number().nullable(),
  breaker: z.enum(["armed", "tripped", "break-glass"]),
  breakGlassUntil: z.number().nullable(),
  month: z.string(),
});

export const aiProxyRouter = new OpenAPIHono<{ Bindings: Env }>();
aiProxyRouter.use("*", guardianAuth);

// GET /api/ai/budget
aiProxyRouter.openapi(
  createRoute({
    method: "get",
    path: "/budget",
    operationId: "aiBudgetStatus",
    summary: "AI spend budget + circuit-breaker status (monthly rolling)",
    responses: {
      200: { description: "Budget status", content: { "application/json": { schema: budgetSchema } } },
      401: { description: "Unauthorized", content: { "application/json": { schema: errorResponseSchema } } },
    },
  }),
  async (c) => c.json(await getBudgetStatus(c.env, Date.now()), 200),
);

// PUT /api/ai/budget  { cap }
aiProxyRouter.openapi(
  createRoute({
    method: "put",
    path: "/budget",
    operationId: "aiBudgetSet",
    summary: "Set the monthly AI spend cap (USD)",
    request: {
      body: { content: { "application/json": { schema: z.object({ cap: z.number().min(0) }) } } },
    },
    responses: {
      200: { description: "Updated", content: { "application/json": { schema: budgetSchema } } },
      401: { description: "Unauthorized", content: { "application/json": { schema: errorResponseSchema } } },
    },
  }),
  async (c) => {
    await setBudgetCap(c.env, c.req.valid("json").cap);
    return c.json(await getBudgetStatus(c.env, Date.now()), 200);
  },
);

// POST /api/ai/budget/break-glass  { hours }
aiProxyRouter.openapi(
  createRoute({
    method: "post",
    path: "/budget/break-glass",
    operationId: "aiBudgetBreakGlass",
    summary: "Temporarily allow spend past the cap for N hours",
    request: {
      body: { content: { "application/json": { schema: z.object({ hours: z.number().min(1).max(168) }) } } },
    },
    responses: {
      200: { description: "Break-glass armed", content: { "application/json": { schema: budgetSchema } } },
      401: { description: "Unauthorized", content: { "application/json": { schema: errorResponseSchema } } },
    },
  }),
  async (c) => {
    await breakGlass(c.env, Date.now(), c.req.valid("json").hours);
    return c.json(await getBudgetStatus(c.env, Date.now()), 200);
  },
);

// POST /api/ai/{provider}/{model}  — proxy a native provider call
aiProxyRouter.openapi(
  createRoute({
    method: "post",
    path: "/{provider}/{model}",
    operationId: "aiProxy",
    summary: "Proxy a native provider call through the spend breaker",
    description:
      "Forwards the JSON body to the provider (openai | anthropic | google) using the CALLER's key from the X-Provider-Key header (never stored), meters cost from the provider's usage payload, and 429s when the monthly cap is exceeded (unless break-glass is active).",
    request: {
      params: z.object({ provider: z.enum(["openai", "anthropic", "google"]), model: z.string() }),
      headers: z.object({ "x-provider-key": z.string() }),
      body: { content: { "application/json": { schema: z.any() } } },
    },
    responses: {
      200: {
        description: "Provider response, plus cost/spent metadata",
        content: {
          "application/json": {
            schema: z.object({ body: z.any(), cost: z.number(), spent: z.number() }),
          },
        },
      },
      400: { description: "Bad request", content: { "application/json": { schema: errorResponseSchema } } },
      401: { description: "Unauthorized", content: { "application/json": { schema: errorResponseSchema } } },
      429: {
        description: "Budget exceeded — breaker tripped",
        content: { "application/json": { schema: errorResponseSchema } },
      },
    },
  }),
  async (c) => {
    const { provider, model } = c.req.valid("param");
    const key = c.req.header("X-Provider-Key");
    if (!key) return c.json({ error: "Missing X-Provider-Key header." }, 400);
    const body = await c.req.json().catch(() => ({}));
    const result = await proxyCall(c.env, provider, model, key, body, Date.now());
    if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 429);
    return c.json({ body: result.body, cost: result.cost, spent: result.spent }, 200);
  },
);
