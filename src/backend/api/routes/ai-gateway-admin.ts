/**
 * @fileoverview AI Gateway admin + actual-cost routes — `/api/ai-gateway-admin/*`.
 *
 * - Gateway CRUD (list/get/create/update/delete) wrapping the Cloudflare API so
 *   coding agents can manage gateways programmatically.
 * - Actual per-model cost recorded by AI Gateway, snapshotted to D1 and queried
 *   over a date range, plus the scraped-vs-actual drift check.
 *
 * Gated by {@link guardianAuth}; mutations are mirrored by MCP tools.
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

import { guardianAuth } from "@/backend/api/routes/guardian";
import {
  createGateway,
  deleteGateway,
  getGateway,
  listGateways,
  updateGateway,
} from "@/backend/guardian/ai-gateway-admin";
import { driftCheck, queryGatewayCosts, snapshotGatewayCosts } from "@/backend/guardian/ai-gateway-costs";

const errorResponseSchema = z.object({ error: z.string() });
const gatewaySchema = z.record(z.string(), z.unknown());

/** The config an agent may pass to create/update a gateway. */
const gatewayConfigSchema = z.object({
  id: z.string().min(1),
  cache_ttl: z.number().int().min(0).optional(),
  cache_invalidate_on_update: z.boolean().optional(),
  collect_logs: z.boolean().optional(),
  rate_limiting_interval: z.number().int().min(0).optional(),
  rate_limiting_limit: z.number().int().min(0).optional(),
  rate_limiting_technique: z.enum(["fixed", "sliding"]).optional(),
  authentication: z.boolean().optional(),
  log_management: z.number().int().optional(),
  log_management_strategy: z.enum(["STOP_INSERTING", "DELETE_OLDEST"]).optional(),
  logpush: z.boolean().optional(),
  retry_backoff: z.enum(["constant", "linear", "exponential"]).optional(),
  retry_delay: z.number().int().min(0).max(5000).optional(),
  retry_max_attempts: z.number().int().min(1).max(5).optional(),
  zdr: z.boolean().optional(),
});

export const aiGatewayAdminRouter = new OpenAPIHono<{ Bindings: Env }>();
aiGatewayAdminRouter.use("*", guardianAuth);

const unauthorized = {
  description: "Unauthorized",
  content: { "application/json": { schema: errorResponseSchema } },
};

// ---- CRUD -----------------------------------------------------------------

aiGatewayAdminRouter.openapi(
  createRoute({
    method: "get",
    path: "/gateways",
    operationId: "aiGatewayList",
    summary: "List AI Gateways",
    responses: {
      200: { description: "Gateways", content: { "application/json": { schema: z.object({ gateways: z.array(gatewaySchema) }) } } },
      401: unauthorized,
    },
  }),
  async (c) => c.json({ gateways: await listGateways(c.env) }, 200),
);

aiGatewayAdminRouter.openapi(
  createRoute({
    method: "get",
    path: "/gateways/{id}",
    operationId: "aiGatewayGet",
    summary: "Get one AI Gateway",
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: { description: "Gateway", content: { "application/json": { schema: gatewaySchema } } },
      401: unauthorized,
    },
  }),
  async (c) => c.json(await getGateway(c.env, c.req.valid("param").id), 200),
);

aiGatewayAdminRouter.openapi(
  createRoute({
    method: "post",
    path: "/gateways",
    operationId: "aiGatewayCreate",
    summary: "Create an AI Gateway (id required; other config defaults)",
    request: { body: { content: { "application/json": { schema: gatewayConfigSchema } } } },
    responses: {
      200: { description: "Created", content: { "application/json": { schema: gatewaySchema } } },
      401: unauthorized,
      500: { description: "Create failed", content: { "application/json": { schema: errorResponseSchema } } },
    },
  }),
  async (c) => {
    try {
      return c.json(await createGateway(c.env, c.req.valid("json")), 200);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Create failed." }, 500);
    }
  },
);

aiGatewayAdminRouter.openapi(
  createRoute({
    method: "put",
    path: "/gateways/{id}",
    operationId: "aiGatewayUpdate",
    summary: "Update an AI Gateway (merges with current config)",
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { "application/json": { schema: gatewayConfigSchema.partial() } } },
    },
    responses: {
      200: { description: "Updated", content: { "application/json": { schema: gatewaySchema } } },
      401: unauthorized,
      500: { description: "Update failed", content: { "application/json": { schema: errorResponseSchema } } },
    },
  }),
  async (c) => {
    try {
      return c.json(await updateGateway(c.env, c.req.valid("param").id, c.req.valid("json")), 200);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Update failed." }, 500);
    }
  },
);

aiGatewayAdminRouter.openapi(
  createRoute({
    method: "delete",
    path: "/gateways/{id}",
    operationId: "aiGatewayDelete",
    summary: "Delete an AI Gateway",
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: z.object({ ok: z.boolean() }) } } },
      401: unauthorized,
      500: { description: "Delete failed", content: { "application/json": { schema: errorResponseSchema } } },
    },
  }),
  async (c) => {
    try {
      await deleteGateway(c.env, c.req.valid("param").id);
      return c.json({ ok: true }, 200);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Delete failed." }, 500);
    }
  },
);

// ---- Actual costs + drift --------------------------------------------------

aiGatewayAdminRouter.openapi(
  createRoute({
    method: "post",
    path: "/snapshot",
    operationId: "aiGatewaySnapshot",
    summary: "Snapshot recent AI Gateway per-model costs into D1 now (also daily on cron)",
    request: { query: z.object({ days: z.coerce.number().int().min(1).max(31).optional() }) },
    responses: {
      200: { description: "Rows written", content: { "application/json": { schema: z.object({ rows: z.number() }) } } },
      401: unauthorized,
    },
  }),
  async (c) => c.json({ rows: await snapshotGatewayCosts(c.env, c.req.valid("query").days ?? 3) }, 200),
);

aiGatewayAdminRouter.openapi(
  createRoute({
    method: "get",
    path: "/costs",
    operationId: "aiGatewayCosts",
    summary: "Actual per-model AI Gateway cost recorded over a date range (from D1)",
    request: {
      query: z.object({
        start: z.coerce.number(),
        end: z.coerce.number(),
        models: z.string().optional(),
      }),
    },
    responses: {
      200: {
        description: "Actual gateway costs",
        content: {
          "application/json": {
            schema: z.object({
              costs: z.array(
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
      401: unauthorized,
    },
  }),
  async (c) => {
    const { start, end, models } = c.req.valid("query");
    const list = models ? models.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    return c.json({ costs: await queryGatewayCosts(c.env, start, end, list) }, 200);
  },
);

aiGatewayAdminRouter.openapi(
  createRoute({
    method: "get",
    path: "/drift",
    operationId: "aiGatewayDrift",
    summary: "Scraped list price vs actual gateway cost — flag models that disagree",
    request: {
      query: z.object({
        start: z.coerce.number(),
        end: z.coerce.number(),
        thresholdPct: z.coerce.number().min(0).optional(),
      }),
    },
    responses: {
      200: {
        description: "Drift findings, largest first",
        content: {
          "application/json": {
            schema: z.object({
              findings: z.array(
                z.object({
                  provider: z.string(),
                  model: z.string(),
                  gateway: z.string(),
                  actualCostUsd: z.number(),
                  expectedCostUsd: z.number(),
                  driftPct: z.number(),
                  scrapedInputPerM: z.number().nullable(),
                  scrapedOutputPerM: z.number().nullable(),
                  effectivePerMillion: z.number().nullable(),
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
    const { start, end, thresholdPct } = c.req.valid("query");
    return c.json({ findings: await driftCheck(c.env, start, end, thresholdPct ?? 10) }, 200);
  },
);
