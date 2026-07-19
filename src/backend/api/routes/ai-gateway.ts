/**
 * @fileoverview AI Gateway billing + configuration routes.
 *
 * `GET /api/ai-gateway/billing` is the money view: credit balance, payment
 * method, auto top-up state, the enforced spending limit, and the draft invoice
 * with per-model line items. Gateway routes expose rate limiting, caching, and
 * retry configuration per gateway.
 *
 * Mutating routes (top-up config, spending-limit removal, gateway patch) are
 * audited to `billing_events`, and the two that loosen spend controls require a
 * typed confirmation.
 *
 * All routes are gated by {@link guardianAuth}.
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

import { guardianAuth } from "@/backend/api/routes/guardian";
import { getDb } from "@/backend/db";
import { billingEvents } from "@/backend/db/schema";
import {
  deleteSpendingLimit,
  deleteTopupConfig,
  getCreditBalance,
  getInvoiceHistory,
  getInvoicePreview,
  getSpendingLimit,
  getUsageHistory,
  listGateways,
  setTopupConfig,
  updateGateway,
} from "@/backend/guardian/ai-gateway";

export const aiGatewayRouter = new OpenAPIHono<{ Bindings: Env }>();
aiGatewayRouter.use("*", guardianAuth);

const errorSchema = z.object({ error: z.string() });
const unauthorized = {
  description: "Missing or invalid session cookie / WORKER_API_KEY bearer token",
  content: { "application/json": { schema: errorSchema } },
};

/** Records an AI Gateway billing change in the governance audit trail. */
async function audit(env: Env, actionTaken: string): Promise<void> {
  await getDb(env).insert(billingEvents).values({
    id: crypto.randomUUID(),
    service: "ai-gateway",
    actionTaken,
    timestamp: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// GET /api/ai-gateway/billing
// ---------------------------------------------------------------------------

aiGatewayRouter.openapi(
  createRoute({
    method: "get",
    path: "/billing",
    operationId: "aiGatewayBilling",
    summary: "Credit balance, auto top-up, spending limit, and the draft invoice",
    responses: {
      200: {
        description: "Consolidated AI Gateway billing state",
        content: {
          "application/json": {
            schema: z.object({
              balance: z.object({
                balance: z.number(),
                hasDefaultPaymentMethod: z.boolean(),
                paymentMethod: z.object({
                  brand: z.string().nullable(),
                  last4: z.string().nullable(),
                }),
                topupConfig: z.object({
                  amount: z.number(),
                  threshold: z.number(),
                  disabledReason: z.string().nullable(),
                  error: z.string().nullable(),
                  lastFailedAt: z.number().nullable(),
                }),
                firstTopupSuccess: z.boolean().nullable(),
              }),
              spendingLimit: z.object({
                enabled: z.boolean(),
                amount: z.number(),
                duration: z.string().nullable(),
                strategy: z.string().nullable(),
              }),
              invoicePreview: z.object({
                amountDue: z.number(),
                amountRemaining: z.number(),
                currency: z.string(),
                status: z.string().nullable(),
                periodStart: z.number().nullable(),
                periodEnd: z.number().nullable(),
                lines: z.array(
                  z.object({
                    description: z.string(),
                    amount: z.number(),
                    quantity: z.number(),
                    unitAmount: z.string().nullable(),
                  }),
                ),
              }),
            }),
          },
        },
      },
      401: unauthorized,
    },
  }),
  async (c) => {
    const [balance, spendingLimit, invoicePreview] = await Promise.all([
      getCreditBalance(c.env),
      getSpendingLimit(c.env),
      getInvoicePreview(c.env),
    ]);
    return c.json({ balance, spendingLimit, invoicePreview }, 200);
  },
);

// ---------------------------------------------------------------------------
// GET /api/ai-gateway/billing/usage-history
// ---------------------------------------------------------------------------

aiGatewayRouter.openapi(
  createRoute({
    method: "get",
    path: "/billing/usage-history",
    operationId: "aiGatewayUsageHistory",
    summary: "Metered AI Gateway usage over a time range",
    request: {
      query: z.object({
        window: z.enum(["day", "hour"]).default("day").optional(),
        days: z.coerce.number().int().min(1).max(90).default(30).optional(),
      }),
    },
    responses: {
      200: {
        description: "Usage buckets",
        content: {
          "application/json": {
            schema: z.object({
              history: z.array(
                z.object({
                  id: z.string(),
                  value: z.number(),
                  startTime: z.number(),
                  endTime: z.number(),
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
    const { window, days } = c.req.valid("query");
    const end = Date.now();
    // Both bounds are required — the API rejects the call with NaN otherwise.
    const start = end - (days ?? 30) * 86_400_000;
    const history = await getUsageHistory(c.env, window ?? "day", start, end);
    return c.json({ history }, 200);
  },
);

// ---------------------------------------------------------------------------
// GET /api/ai-gateway/billing/invoices
// ---------------------------------------------------------------------------

aiGatewayRouter.openapi(
  createRoute({
    method: "get",
    path: "/billing/invoices",
    operationId: "aiGatewayInvoices",
    summary: "Invoice history",
    request: { query: z.object({ type: z.enum(["auto", "manual", "all"]).optional() }) },
    responses: {
      200: {
        description: "Invoices, newest first",
        content: {
          "application/json": {
            schema: z.object({
              invoices: z.array(
                z.object({
                  id: z.string().nullable(),
                  status: z.string().nullable(),
                  amountDue: z.number(),
                  amountPaid: z.number(),
                  amountRemaining: z.number(),
                  currency: z.string(),
                  created: z.number().nullable(),
                  description: z.string().nullable(),
                  origin: z.string().nullable(),
                  pdfUrl: z.string().nullable(),
                }),
              ),
            }),
          },
        },
      },
      401: unauthorized,
    },
  }),
  async (c) => c.json({ invoices: await getInvoiceHistory(c.env, c.req.valid("query").type) }, 200),
);

// ---------------------------------------------------------------------------
// Auto top-up configuration
// ---------------------------------------------------------------------------

aiGatewayRouter.openapi(
  createRoute({
    method: "post",
    path: "/billing/topup-config",
    operationId: "aiGatewaySetTopupConfig",
    summary: "Set the auto top-up threshold and amount",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              // Cloudflare minimums: 1000 cents top-up, 500 cents threshold.
              amount: z.number().int().min(1000),
              threshold: z.number().int().min(500),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Stored configuration",
        content: {
          "application/json": {
            schema: z.object({ amount: z.number(), threshold: z.number() }),
          },
        },
      },
      401: unauthorized,
      502: {
        description: "Cloudflare API rejected the change",
        content: { "application/json": { schema: errorSchema } },
      },
    },
  }),
  async (c) => {
    const { amount, threshold } = c.req.valid("json");
    try {
      const stored = await setTopupConfig(c.env, amount, threshold);
      await audit(
        c.env,
        `Set AI Gateway auto top-up: $${(stored.amount / 100).toFixed(2)} when balance falls below $${(stored.threshold / 100).toFixed(2)}`,
      );
      return c.json(stored, 200);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  },
);

aiGatewayRouter.openapi(
  createRoute({
    method: "delete",
    path: "/billing/topup-config",
    operationId: "aiGatewayDeleteTopupConfig",
    summary: "Disable auto top-up",
    responses: {
      200: {
        description: "Auto top-up removed",
        content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
      },
      401: unauthorized,
      502: {
        description: "Cloudflare API rejected the change",
        content: { "application/json": { schema: errorSchema } },
      },
    },
  }),
  async (c) => {
    try {
      await deleteTopupConfig(c.env);
      // Disabling auto top-up tightens spend, so no confirmation is required.
      await audit(c.env, "Disabled AI Gateway auto top-up");
      return c.json({ ok: true }, 200);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  },
);

// ---------------------------------------------------------------------------
// Spending limit
// ---------------------------------------------------------------------------

aiGatewayRouter.openapi(
  createRoute({
    method: "delete",
    path: "/billing/spending-limit",
    operationId: "aiGatewayDeleteSpendingLimit",
    summary: "Remove the account spending limit (raises the spend ceiling)",
    request: {
      body: {
        content: { "application/json": { schema: z.object({ confirm: z.string() }) } },
      },
    },
    responses: {
      200: {
        description: "Spending limit removed",
        content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
      },
      400: {
        description: "Confirmation phrase did not match",
        content: { "application/json": { schema: errorSchema } },
      },
      401: unauthorized,
      502: {
        description: "Cloudflare API rejected the change",
        content: { "application/json": { schema: errorSchema } },
      },
    },
  }),
  async (c) => {
    // Removing a spend limit is the one action here that *increases* exposure,
    // so it is confirm-gated like the destructive storage routes.
    if (c.req.valid("json").confirm !== "remove spending limit") {
      return c.json({ error: 'Confirmation must be exactly "remove spending limit".' }, 400);
    }
    try {
      const current = await getSpendingLimit(c.env);
      await deleteSpendingLimit(c.env);
      await audit(
        c.env,
        `Removed AI Gateway spending limit (was $${(current.amount / 100).toFixed(2)} ${current.duration ?? ""} ${current.strategy ?? ""})`.trim(),
      );
      return c.json({ ok: true }, 200);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  },
);

// ---------------------------------------------------------------------------
// Gateways
// ---------------------------------------------------------------------------

const gatewaySchema = z.object({
  id: z.string(),
  createdAt: z.string().nullable(),
  modifiedAt: z.string().nullable(),
  rateLimitingInterval: z.number().nullable(),
  rateLimitingLimit: z.number().nullable(),
  rateLimitingTechnique: z.string().nullable(),
  cacheTtl: z.number().nullable(),
  logManagement: z.number().nullable(),
  collectLogs: z.boolean(),
  authentication: z.boolean(),
  retryMaxAttempts: z.number().nullable(),
  retryDelay: z.number().nullable(),
  workersAiBillingMode: z.string().nullable(),
});

aiGatewayRouter.openapi(
  createRoute({
    method: "get",
    path: "/gateways",
    operationId: "aiGatewayListGateways",
    summary: "Gateways with rate limiting, caching, and retry configuration",
    responses: {
      200: {
        description: "Gateways",
        content: {
          "application/json": { schema: z.object({ gateways: z.array(gatewaySchema) }) },
        },
      },
      401: unauthorized,
    },
  }),
  async (c) => c.json({ gateways: await listGateways(c.env) }, 200),
);

aiGatewayRouter.openapi(
  createRoute({
    method: "patch",
    path: "/gateways/{id}",
    operationId: "aiGatewayUpdateGateway",
    summary: "Update a gateway's rate limit, cache TTL, or log retention",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              rate_limiting_limit: z.number().int().min(0).optional(),
              rate_limiting_interval: z.number().int().min(0).optional(),
              rate_limiting_technique: z.enum(["fixed", "sliding"]).optional(),
              cache_ttl: z.number().int().min(0).optional(),
              log_management: z.number().int().min(0).optional(),
              collect_logs: z.boolean().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Updated gateway",
        content: { "application/json": { schema: gatewaySchema } },
      },
      401: unauthorized,
      502: {
        description: "Cloudflare API rejected the change",
        content: { "application/json": { schema: errorSchema } },
      },
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const patch = c.req.valid("json");
    try {
      const gateway = await updateGateway(c.env, id, patch);
      await audit(c.env, `Updated AI Gateway "${id}": ${JSON.stringify(patch)}`);
      return c.json(gateway, 200);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  },
);
