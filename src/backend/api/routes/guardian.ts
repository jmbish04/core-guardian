/**
 * @fileoverview Core Guardian routes — usage monitoring + emergency eviction.
 *
 * `GET /api/guardian/usage` is the read layer: one reading per binding type,
 * pulled from the Cloudflare GraphQL Analytics API (see
 * `@/backend/guardian/collect`). The same collection runs hourly from the cron
 * trigger in `src/_worker.ts`.
 *
 * Below it sit two destructive, spend-stopping mitigations exposed to the
 * Guardian control panel. Both orchestrate the Cloudflare REST API with the account id + API
 * token already bound in `wrangler.jsonc` (Secrets Store —
 * `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_WRANGLER_API_TOKEN`), both are gated on
 * `WORKER_API_KEY` / a signed session cookie by {@link guardianAuth}, and both
 * append an audit row to the D1 `billing_events` table.
 *
 * - `POST /api/r2/evict` — injects a 1-day `Expire` lifecycle rule on a bucket.
 *   Preferred over an itemized delete loop, which would blow the Worker CPU /
 *   subrequest budget on a bucket large enough to matter.
 * - `POST /api/vectorize/reset` — deletes a Vectorize index outright, stopping
 *   runaway vector read/write metering immediately.
 *
 * @remarks Both operations are irreversible. The R2 route merges its rule into
 * the bucket's existing lifecycle configuration rather than replacing it —
 * every bucket ships with a default multipart-abort rule that a blind `PUT`
 * would destroy.
 */

import type { Context, Next } from "hono";

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { desc } from "drizzle-orm";

import { extractBearerToken, safeEqual } from "@/backend/api/lib/auth";
import { getDb } from "@/backend/db";
import { billingEvents, cronRuns } from "@/backend/db/schema";
import { collectUsage } from "@/backend/guardian/collect";
import { verifySessionCookie } from "@/backend/lib/cookies";
import {
  getCloudflareAccountId,
  getCloudflareApiToken,
  getWorkerApiKey,
} from "@/backend/utils/secrets";

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

/** Shared success/failure envelope returned by both mitigations. */
const mitigationResponseSchema = z.object({
  ok: z.boolean(),
  service: z.string(),
  actionTaken: z.string(),
  eventId: z.string(),
  timestamp: z.number(),
});

const errorResponseSchema = z.object({ error: z.string() });

/**
 * Gate for the destructive Guardian endpoints.
 *
 * Accepts either the signed session cookie (so the Guardian panel works for a
 * logged-in operator without shipping the key to the browser) or an
 * `Authorization: Bearer <WORKER_API_KEY>` header for scripted use. The bearer
 * comparison is constant-time.
 *
 * @param c - Hono request context
 * @param next - Downstream handler
 * @returns 401 JSON when neither credential validates
 */
export async function guardianAuth(c: Context<{ Bindings: Env }>, next: Next) {
  const session = await verifySessionCookie(c.env, c.req.header("Cookie"));
  if (session) return await next();

  const presented = extractBearerToken(c.req.header("Authorization"));
  const expected = await getWorkerApiKey(c.env);
  if (presented && expected && (await safeEqual(presented, expected))) {
    return await next();
  }

  return c.json({ error: "Unauthorized" }, 401);
}

/**
 * Calls the Cloudflare REST API with the bound account credentials.
 *
 * @param env - Worker env carrying the Secrets Store bindings
 * @param path - API path relative to the account (e.g. `/r2/buckets/x/lifecycle`)
 * @param init - Fetch init (method, body); `Authorization` is injected here
 * @returns The parsed Cloudflare API envelope
 * @throws Error when credentials are missing or the API reports failure
 */
async function cfFetch(
  env: Env,
  path: string,
  init: RequestInit,
): Promise<{ success: boolean; errors?: { message: string }[]; result?: unknown }> {
  const [accountId, token] = await Promise.all([
    getCloudflareAccountId(env),
    getCloudflareApiToken(env),
  ]);
  if (!accountId || !token) {
    throw new Error(
      "Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_WRANGLER_API_TOKEN in the Secrets Store.",
    );
  }

  const res = await fetch(`${CF_API_BASE}/accounts/${accountId}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });

  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    errors?: { message: string }[];
    result?: unknown;
  };

  if (!res.ok || body.success === false) {
    const detail = body.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`;
    throw new Error(`Cloudflare API error: ${detail}`);
  }
  return { success: true, errors: body.errors, result: body.result };
}

/**
 * Appends one row to the `billing_events` governance audit trail.
 *
 * @param env - Worker env (D1 binding)
 * @param service - Service the mitigation targeted (`r2`, `vectorize`)
 * @param actionTaken - Human-readable description of what was executed
 * @returns The generated event id and its timestamp
 */
async function logMitigation(
  env: Env,
  service: string,
  actionTaken: string,
): Promise<{ eventId: string; timestamp: number }> {
  const eventId = crypto.randomUUID();
  const timestamp = Date.now();
  await getDb(env).insert(billingEvents).values({ id: eventId, service, actionTaken, timestamp });
  return { eventId, timestamp };
}

// ---------------------------------------------------------------------------
// GET /api/guardian/usage
// ---------------------------------------------------------------------------

export const guardianRouter = new OpenAPIHono<{ Bindings: Env }>();
guardianRouter.use("*", guardianAuth);

const usageReadingSchema = z.object({
  id: z.string(),
  label: z.string(),
  product: z.string(),
  bindings: z.array(z.string()),
  unit: z.string(),
  status: z.enum(["ok", "not_metered", "unavailable"]),
  value: z.number(),
  breakdown: z.array(z.object({ label: z.string(), value: z.number() })),
  alertThreshold: z.number().nullable(),
  surging: z.boolean(),
  error: z.string().optional(),
});

guardianRouter.openapi(
  createRoute({
    method: "get",
    path: "/usage",
    operationId: "guardianUsage",
    summary: "Per-binding usage readings from the Cloudflare GraphQL Analytics API",
    request: {
      query: z.object({
        hours: z.coerce.number().int().min(1).max(744).default(24).optional(),
      }),
    },
    responses: {
      200: {
        description: "One reading per registered binding probe",
        content: {
          "application/json": {
            schema: z.object({
              windowHours: z.number(),
              readings: z.array(usageReadingSchema),
            }),
          },
        },
      },
      401: {
        description: "Missing or invalid session cookie / WORKER_API_KEY bearer token",
        content: { "application/json": { schema: errorResponseSchema } },
      },
    },
  }),
  async (c) => {
    const hours = c.req.valid("query").hours ?? 24;
    const readings = await collectUsage(c.env, hours);
    return c.json({ windowHours: hours, readings }, 200);
  },
);

// ---------------------------------------------------------------------------
// GET /api/guardian/cron
// ---------------------------------------------------------------------------

const cronRunSchema = z.object({
  id: z.string(),
  ranAt: z.number(),
  durationMs: z.number(),
  probesOk: z.number(),
  probesFailed: z.number(),
  alerts: z.number(),
  status: z.enum(["ok", "partial", "error"]),
  error: z.string().nullable(),
});

guardianRouter.openapi(
  createRoute({
    method: "get",
    path: "/cron",
    operationId: "guardianCronRuns",
    summary: "Hourly evaluation heartbeat — proves the cron trigger is firing",
    request: {
      query: z.object({
        limit: z.coerce.number().int().min(1).max(200).default(24).optional(),
      }),
    },
    responses: {
      200: {
        description: "Recent cron runs, newest first",
        content: {
          "application/json": {
            schema: z.object({
              runs: z.array(cronRunSchema),
              /** True when the newest run is older than 2 cron intervals. */
              stale: z.boolean(),
            }),
          },
        },
      },
      401: {
        description: "Missing or invalid session cookie / WORKER_API_KEY bearer token",
        content: { "application/json": { schema: errorResponseSchema } },
      },
    },
  }),
  async (c) => {
    const limit = c.req.valid("query").limit ?? 24;
    const runs = await getDb(c.env)
      .select()
      .from(cronRuns)
      .orderBy(desc(cronRuns.ranAt))
      .limit(limit);

    // Cron is hourly; miss two in a row and something is wrong.
    const stale = runs.length === 0 || Date.now() - runs[0].ranAt > 2 * 3_600_000;
    return c.json({ runs, stale }, 200);
  },
);

// ---------------------------------------------------------------------------
// GET /api/guardian/events
// ---------------------------------------------------------------------------

const billingEventSchema = z.object({
  id: z.string(),
  service: z.string(),
  actionTaken: z.string(),
  timestamp: z.number(),
});

guardianRouter.openapi(
  createRoute({
    method: "get",
    path: "/events",
    operationId: "guardianEvents",
    summary: "Governance audit trail — mitigations executed and surges detected",
    request: {
      query: z.object({
        limit: z.coerce.number().int().min(1).max(200).default(50).optional(),
      }),
    },
    responses: {
      200: {
        description: "Audit rows, newest first",
        content: {
          "application/json": { schema: z.object({ events: z.array(billingEventSchema) }) },
        },
      },
      401: {
        description: "Missing or invalid session cookie / WORKER_API_KEY bearer token",
        content: { "application/json": { schema: errorResponseSchema } },
      },
    },
  }),
  async (c) => {
    const limit = c.req.valid("query").limit ?? 50;
    const events = await getDb(c.env)
      .select()
      .from(billingEvents)
      .orderBy(desc(billingEvents.timestamp))
      .limit(limit);
    return c.json({ events }, 200);
  },
);

// ---------------------------------------------------------------------------
// POST /api/r2/evict
// ---------------------------------------------------------------------------

export const r2Router = new OpenAPIHono<{ Bindings: Env }>();
r2Router.use("*", guardianAuth);

const evictBody = z.object({
  bucketName: z
    .string()
    .min(3)
    .max(63)
    // R2 bucket naming: lowercase alphanumerics + hyphens.
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, "Invalid R2 bucket name"),
});

r2Router.openapi(
  createRoute({
    method: "post",
    path: "/evict",
    operationId: "r2EmergencyEvict",
    summary: "Emergency-evict an R2 bucket via a 1-day lifecycle expiration rule",
    request: { body: { content: { "application/json": { schema: evictBody } } } },
    responses: {
      200: {
        description: "Lifecycle expiration rule applied",
        content: { "application/json": { schema: mitigationResponseSchema } },
      },
      401: {
        description: "Missing or invalid session cookie / WORKER_API_KEY bearer token",
        content: { "application/json": { schema: errorResponseSchema } },
      },
      502: {
        description: "Cloudflare API rejected the lifecycle update",
        content: { "application/json": { schema: errorResponseSchema } },
      },
    },
  }),
  async (c) => {
    const { bucketName } = c.req.valid("json");

    // `PUT .../lifecycle` replaces the whole configuration, so read the existing
    // rules and append ours. Every R2 bucket ships with a default multipart
    // abort rule; a blind PUT would silently delete it.
    const EMERGENCY_RULE_ID = "core-guardian-emergency-expire";
    try {
      let existing: unknown[] = [];
      try {
        const current = await cfFetch(
          c.env,
          `/r2/buckets/${encodeURIComponent(bucketName)}/lifecycle`,
          { method: "GET" },
        );
        const rules = (current.result as { rules?: unknown[] } | undefined)?.rules;
        // Drop any prior emergency rule so repeated evictions stay idempotent.
        existing = (rules ?? []).filter((r) => (r as { id?: string }).id !== EMERGENCY_RULE_ID);
      } catch {
        // No lifecycle configuration yet — start from an empty rule set.
      }

      await cfFetch(c.env, `/r2/buckets/${encodeURIComponent(bucketName)}/lifecycle`, {
        method: "PUT",
        body: JSON.stringify({
          rules: [
            ...existing,
            {
              id: EMERGENCY_RULE_ID,
              enabled: true,
              conditions: { prefix: "" },
              action: { type: "Expire", parameters: { days: 1 } },
            },
          ],
        }),
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }

    const actionTaken = `Applied 1-day emergency Expire lifecycle rule to R2 bucket "${bucketName}"`;
    const { eventId, timestamp } = await logMitigation(c.env, "r2", actionTaken);

    return c.json({ ok: true, service: "r2", actionTaken, eventId, timestamp }, 200);
  },
);

// ---------------------------------------------------------------------------
// POST /api/vectorize/reset
// ---------------------------------------------------------------------------

export const vectorizeRouter = new OpenAPIHono<{ Bindings: Env }>();
vectorizeRouter.use("*", guardianAuth);

const resetBody = z.object({
  indexName: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "Invalid Vectorize index name"),
});

vectorizeRouter.openapi(
  createRoute({
    method: "post",
    path: "/reset",
    operationId: "vectorizeEmergencyReset",
    summary: "Drop a Vectorize index to halt runaway read/write metering",
    request: { body: { content: { "application/json": { schema: resetBody } } } },
    responses: {
      200: {
        description: "Index deleted",
        content: { "application/json": { schema: mitigationResponseSchema } },
      },
      401: {
        description: "Missing or invalid session cookie / WORKER_API_KEY bearer token",
        content: { "application/json": { schema: errorResponseSchema } },
      },
      502: {
        description: "Cloudflare API rejected the index deletion",
        content: { "application/json": { schema: errorResponseSchema } },
      },
    },
  }),
  async (c) => {
    const { indexName } = c.req.valid("json");

    // V2 path — `/vectorize/indexes/{name}` (no `/v2`) is the legacy V1 API and
    // only resolves for indexes created before the V2 migration.
    try {
      await cfFetch(c.env, `/vectorize/v2/indexes/${encodeURIComponent(indexName)}`, {
        method: "DELETE",
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }

    const actionTaken = `Deleted Vectorize index "${indexName}" to stop vector read/write metering`;
    const { eventId, timestamp } = await logMitigation(c.env, "vectorize", actionTaken);

    return c.json({ ok: true, service: "vectorize", actionTaken, eventId, timestamp }, 200);
  },
);
