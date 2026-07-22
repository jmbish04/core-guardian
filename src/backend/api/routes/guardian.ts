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
import { and, asc, desc, gte, sql } from "drizzle-orm";

import { extractBearerToken, safeEqual } from "@/backend/api/lib/auth";
import { getDb } from "@/backend/db";
import {
  actionItems,
  alerts,
  billingEvents,
  cronRuns,
  pricingRevisions,
  scrapeRuns,
  usageSnapshots,
} from "@/backend/db/schema";
import { executeActionItem } from "@/backend/guardian/action-items";
import { ALLOWANCES, allowanceStatus, periodElapsed, periodStart } from "@/backend/guardian/allowances";
import { collectUsage, evaluateUsage, type UsageReading } from "@/backend/guardian/collect";
import { archiveD1Database } from "@/backend/guardian/d1-archive";
import { archiveImages } from "@/backend/guardian/cf-image-archive";
import { archiveR2Bucket } from "@/backend/guardian/r2-archive";
import { proposeHotfix } from "@/backend/guardian/hotfix";
import { getWorkerSpend } from "@/backend/guardian/worker-spend";
import { scrapeAllPricing, scrapeOneProduct } from "@/backend/guardian/pricing-scrape";
import {
  getBindingIndex,
  listD1Databases,
  listKVNamespaces,
  listR2Objects,
  listVectorizeIndexes,
} from "@/backend/guardian/resources";
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
    await resolveBreakdownNames(c.env, readings);
    return c.json({ windowHours: hours, readings }, 200);
  },
);

/**
 * Rewrites id-keyed breakdown labels into human names in place.
 *
 * The GraphQL Analytics datasets group D1 by `databaseId`, KV by `namespaceId`,
 * and Vectorize by `vectorizeIndexId` — all opaque. A governance panel must
 * never render one of those raw (the D1 pie chart of UUIDs is exactly the sin
 * this fixes), so we resolve them against the account's own resource lists.
 * Only the products that actually need it are fetched, and only when a reading
 * has a breakdown. An unresolved id degrades to a short prefix, never the full
 * 36-char string.
 */
async function resolveBreakdownNames(env: Env, readings: UsageReading[]): Promise<void> {
  const has = (id: string) => readings.some((r) => r.id === id && r.breakdown.length > 0);
  const [d1, kv, vec] = await Promise.all([
    has("d1") ? listD1Databases(env).catch(() => []) : Promise.resolve([]),
    has("kv") ? listKVNamespaces(env).catch(() => []) : Promise.resolve([]),
    has("vectorize") ? listVectorizeIndexes(env).catch(() => []) : Promise.resolve([]),
  ]);

  const maps: Record<string, Map<string, string>> = {
    d1: new Map(d1.map((x) => [x.uuid, x.name])),
    kv: new Map(kv.map((x) => [x.id, x.title])),
    vectorize: new Map(vec.map((x) => [x.name, x.name])),
  };

  for (const reading of readings) {
    const map = maps[reading.id];
    if (!map) continue;
    reading.breakdown = reading.breakdown.map((row) => ({
      value: row.value,
      label: map.get(row.label) ?? (row.label.length > 12 ? `${row.label.slice(0, 8)}…` : row.label),
    }));
  }
}

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
// GET /api/guardian/history
// ---------------------------------------------------------------------------

guardianRouter.openapi(
  createRoute({
    method: "get",
    path: "/history",
    operationId: "guardianUsageHistory",
    summary: "Hourly usage snapshots per probe — the trend behind the current reading",
    description:
      "Replays the `usage_snapshots` rows the cron has written so the panel can chart a trend without re-querying the Cloudflare GraphQL Analytics API. Returns one series per probe, oldest point first.",
    request: {
      query: z.object({
        hours: z.coerce.number().int().min(1).max(720).default(168).optional(),
      }),
    },
    responses: {
      200: {
        description: "One series per probe, points ordered oldest → newest",
        content: {
          "application/json": {
            schema: z.object({
              windowHours: z.number(),
              series: z.array(
                z.object({
                  service: z.string(),
                  metric: z.string(),
                  points: z.array(z.object({ t: z.number(), value: z.number() })),
                }),
              ),
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
    const hours = c.req.valid("query").hours ?? 168;
    const rows = await getDb(c.env)
      .select()
      .from(usageSnapshots)
      .where(gte(usageSnapshots.timestamp, Date.now() - hours * 3_600_000))
      .orderBy(asc(usageSnapshots.timestamp));

    // Group in JS rather than SQL: the row count here is bounded by
    // (probes × hours) — ~2.4k at the 720h ceiling, far cheaper to bucket in
    // memory than to round-trip D1 once per probe.
    const byService = new Map<string, { service: string; metric: string; points: { t: number; value: number }[] }>();
    for (const row of rows) {
      let series = byService.get(row.service);
      if (!series) {
        series = { service: row.service, metric: row.metric, points: [] };
        byService.set(row.service, series);
      }
      series.points.push({ t: row.timestamp, value: row.value });
    }

    return c.json({ windowHours: hours, series: [...byService.values()] }, 200);
  },
);

// ---------------------------------------------------------------------------
// GET /api/guardian/allowances  — billing period + per-binding used/remaining
// ---------------------------------------------------------------------------

guardianRouter.openapi(
  createRoute({
    method: "get",
    path: "/allowances",
    operationId: "guardianAllowances",
    summary: "Current billing period + per-binding included allowance, used, remaining",
    description:
      "For every probe with a curated allowance: period-to-date usage (summed from snapshots, or the latest reading for level metrics), the included allowance, straight-line projection, and remaining. Non-comparable probes return raw usage with remaining null rather than a fabricated number.",
    responses: {
      200: {
        description: "Per-binding allowance status for the current period",
        content: {
          "application/json": {
            schema: z.object({
              period: z.object({
                monthStart: z.number(),
                elapsedFraction: z.number(),
              }),
              allowances: z.array(
                z.object({
                  service: z.string(),
                  unit: z.string(),
                  comparable: z.boolean(),
                  included: z.number(),
                  usedSoFar: z.number(),
                  projected: z.number(),
                  projectedFraction: z.number().nullable(),
                  remaining: z.number().nullable(),
                  note: z.string().optional(),
                }),
              ),
            }),
          },
        },
      },
      401: {
        description: "Missing or invalid session cookie / WORKER_API_KEY bearer token",
        content: { "application/json": { schema: errorResponseSchema } },
      },
      500: {
        description: "Failed",
        content: { "application/json": { schema: errorResponseSchema } },
      },
    },
  }),
  async (c) => {
    try {
    const now = Date.now();
    const db = getDb(c.env);

    const rows = [];
    for (const [service, a] of Object.entries(ALLOWANCES)) {
      const start = periodStart(now, a.reset);
      const cumulative = a.cumulative !== false;
      let usedSoFar = 0;
      if (cumulative) {
        const [{ total }] = await db
          .select({ total: sql<number>`COALESCE(SUM(${usageSnapshots.value}), 0)` })
          .from(usageSnapshots)
          .where(and(gte(usageSnapshots.timestamp, start), sql`${usageSnapshots.service} = ${service}`));
        usedSoFar = total ?? 0;
      } else {
        // Level metric: the most recent snapshot is the current stored level.
        const [latest] = await db
          .select({ value: usageSnapshots.value })
          .from(usageSnapshots)
          .where(sql`${usageSnapshots.service} = ${service}`)
          .orderBy(desc(usageSnapshots.timestamp))
          .limit(1);
        usedSoFar = latest?.value ?? 0;
      }

      const status = allowanceStatus(service, usedSoFar, now);
      if (!status) continue;
      const projected = cumulative ? status.projected : usedSoFar;
      const projectedFraction = a.comparable ? (cumulative ? status.projectedFraction : usedSoFar / a.paidIncluded) : null;
      rows.push({
        service,
        unit: a.unit,
        comparable: a.comparable,
        included: a.paidIncluded,
        usedSoFar,
        projected,
        projectedFraction,
        remaining: a.comparable ? Math.max(0, a.paidIncluded - projected) : null,
        note: a.note,
      });
    }
    rows.sort((x, y) => (y.projectedFraction ?? -1) - (x.projectedFraction ?? -1));

    return c.json(
      {
        period: { monthStart: periodStart(now, "monthly"), elapsedFraction: periodElapsed(now, "monthly") },
        allowances: rows,
      },
      200,
    );
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Failed." }, 500);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/guardian/worker/{name}/spend  — CF usage + AI-provider spend
// ---------------------------------------------------------------------------

guardianRouter.openapi(
  createRoute({
    method: "get",
    path: "/worker/{name}/spend",
    operationId: "guardianWorkerSpend",
    summary: "One worker's Cloudflare usage + its AI-Gateway provider spend",
    description:
      "Two signals over the window: Cloudflare compute (requests/errors/subrequests/CPU quantiles) for the script, and real AI upstream cost by provider/model from a same-named AI Gateway (or `gateway` override). AI spend is $0 until the worker routes its calls through that gateway — the honest signal that provider billing is not yet visible Cloudflare-side.",
    request: {
      params: z.object({ name: z.string() }),
      query: z.object({
        gateway: z.string().optional(),
        hours: z.coerce.number().int().min(1).max(744).optional(),
      }),
    },
    responses: {
      200: {
        description: "Worker spend",
        content: {
          "application/json": {
            schema: z.object({
              worker: z.string(),
              gateway: z.string(),
              windowHours: z.number(),
              cloudflare: z.object({
                requests: z.number(),
                errors: z.number(),
                subrequests: z.number(),
                cpuTimeP50Us: z.number().nullable(),
                cpuTimeP99Us: z.number().nullable(),
              }),
              ai: z.object({
                routed: z.boolean(),
                upstreamCostUsd: z.number(),
                requests: z.number(),
                tokensIn: z.number(),
                tokensOut: z.number(),
                byModel: z.array(
                  z.object({
                    provider: z.string(),
                    model: z.string(),
                    costUsd: z.number(),
                    tokensIn: z.number(),
                    tokensOut: z.number(),
                  }),
                ),
              }),
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
    const { name } = c.req.valid("param");
    const { gateway, hours } = c.req.valid("query");
    const spend = await getWorkerSpend(c.env, name, gateway ?? name, hours ?? 720);
    return c.json(spend, 200);
  },
);

// ---------------------------------------------------------------------------
// GET /api/guardian/worker/{name}/audit  — one worker's usage + its bindings
// ---------------------------------------------------------------------------

guardianRouter.openapi(
  createRoute({
    method: "get",
    path: "/worker/{name}/audit",
    operationId: "guardianWorkerAudit",
    summary: "One worker's bound resources (from the attribution graph)",
    description:
      "Every resource the named worker binds, grouped by type, resolved to names. The spend view for a single worker — what it can touch, so a surge can be reasoned about per worker.",
    request: { params: z.object({ name: z.string() }) },
    responses: {
      200: {
        description: "The worker's bindings",
        content: {
          "application/json": {
            schema: z.object({
              worker: z.string(),
              resourceCount: z.number(),
              byType: z.record(z.string(), z.number()),
              resources: z.array(
                z.object({ type: z.string(), id: z.string(), name: z.string(), binding: z.string() }),
              ),
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
    const { name } = c.req.valid("param");
    const index = await getBindingIndex(c.env);
    const needsD1 = Object.keys(index.byResource).some((k) => k.startsWith("d1:"));
    const needsKV = Object.keys(index.byResource).some((k) => k.startsWith("kv:"));
    const [d1, kv] = await Promise.all([
      needsD1 ? listD1Databases(c.env).catch(() => []) : Promise.resolve([]),
      needsKV ? listKVNamespaces(c.env).catch(() => []) : Promise.resolve([]),
    ]);
    const d1Names = new Map(d1.map((x) => [x.uuid, x.name]));
    const kvNames = new Map(kv.map((x) => [x.id, x.title]));

    const resources: { type: string; id: string; name: string; binding: string }[] = [];
    const byType: Record<string, number> = {};
    for (const [key, owners] of Object.entries(index.byResource)) {
      const mine = owners.find((o) => o.worker === name);
      if (!mine) continue;
      const [type, ...rest] = key.split(":");
      const id = rest.join(":");
      const resolved = type === "d1" ? (d1Names.get(id) ?? id) : type === "kv" ? (kvNames.get(id) ?? id) : id;
      resources.push({ type, id, name: resolved, binding: mine.binding });
      byType[type] = (byType[type] ?? 0) + 1;
    }
    resources.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));

    return c.json({ worker: name, resourceCount: resources.length, byType, resources }, 200);
  },
);

// ---------------------------------------------------------------------------
// GET /api/guardian/attribution
// ---------------------------------------------------------------------------

const attributedResourceSchema = z.object({
  key: z.string(),
  type: z.string(),
  id: z.string(),
  name: z.string(),
  workers: z.array(z.object({ worker: z.string(), binding: z.string() })),
});

guardianRouter.openapi(
  createRoute({
    method: "get",
    path: "/attribution",
    operationId: "guardianAttribution",
    summary: "Worker ↔ resource attribution — which worker binds which D1/KV/R2/Vectorize/Queue",
    description:
      "Materialized from the hourly binding-index fan-out (cached in KV; the cron keeps it warm). Returns two views of the same graph: `resources` (resource → binding workers) and `workers` (worker → the resources it binds). Opaque D1/KV ids are resolved to names.",
    request: {
      query: z.object({
        refresh: z.enum(["true", "false"]).optional(),
      }),
    },
    responses: {
      200: {
        description: "The attribution graph, both directions",
        content: {
          "application/json": {
            schema: z.object({
              builtAt: z.number(),
              workerCount: z.number(),
              resources: z.array(attributedResourceSchema),
              workers: z.array(
                z.object({
                  worker: z.string(),
                  resources: z.array(
                    z.object({
                      key: z.string(),
                      type: z.string(),
                      id: z.string(),
                      name: z.string(),
                      binding: z.string(),
                    }),
                  ),
                }),
              ),
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
    const refresh = c.req.valid("query").refresh === "true";
    const index = await getBindingIndex(c.env, refresh);

    // Resolve the opaque id-keyed resources (d1 uuid, kv id) to names. r2 /
    // vectorize / queue keys already carry the human name; hyperdrive has no
    // list endpoint, so its id stands in.
    const needsD1 = Object.keys(index.byResource).some((k) => k.startsWith("d1:"));
    const needsKV = Object.keys(index.byResource).some((k) => k.startsWith("kv:"));
    const [d1, kv] = await Promise.all([
      needsD1 ? listD1Databases(c.env).catch(() => []) : Promise.resolve([]),
      needsKV ? listKVNamespaces(c.env).catch(() => []) : Promise.resolve([]),
    ]);
    const d1Names = new Map(d1.map((x) => [x.uuid, x.name]));
    const kvNames = new Map(kv.map((x) => [x.id, x.title]));

    const nameFor = (type: string, id: string) =>
      type === "d1" ? (d1Names.get(id) ?? id) : type === "kv" ? (kvNames.get(id) ?? id) : id;

    const resources = Object.entries(index.byResource).map(([key, workers]) => {
      const [type, ...rest] = key.split(":");
      const id = rest.join(":");
      return { key, type, id, name: nameFor(type, id), workers };
    });

    // Invert to worker → resources.
    const byWorker = new Map<
      string,
      { key: string; type: string; id: string; name: string; binding: string }[]
    >();
    for (const r of resources) {
      for (const w of r.workers) {
        (byWorker.get(w.worker) ?? byWorker.set(w.worker, []).get(w.worker)!).push({
          key: r.key,
          type: r.type,
          id: r.id,
          name: r.name,
          binding: w.binding,
        });
      }
    }
    const workers = [...byWorker.entries()]
      .map(([worker, res]) => ({ worker, resources: res }))
      .sort((a, b) => a.worker.localeCompare(b.worker));

    resources.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));

    return c.json(
      { builtAt: index.builtAt, workerCount: index.workerCount, resources, workers },
      200,
    );
  },
);

// ---------------------------------------------------------------------------
// GET /api/guardian/logpush  — triage the Logpush → R2 log bucket
// ---------------------------------------------------------------------------

const LOGPUSH_BUCKET = "cloudflare-managed-6a40525f";
const LOGPUSH_MAX_PAGES = 10; // 10 × 1000 objects; cap so a huge bucket can't hang the request

guardianRouter.openapi(
  createRoute({
    method: "get",
    path: "/logpush",
    operationId: "guardianLogpush",
    summary: "Triage the Logpush → R2 log bucket: volume by prefix, newest files",
    description:
      "Logpush bills on delivered log volume, exported to an R2 bucket. This walks that bucket (capped pages) and rolls the objects up by top-level key prefix — usually the date or dataset — so a spend surge can be traced to the day/stream producing it. Reports the scanned/truncated state; it never claims full coverage it did not achieve.",
    request: {
      query: z.object({
        bucket: z.string().optional(),
      }),
    },
    responses: {
      200: {
        description: "Log volume rollup",
        content: {
          "application/json": {
            schema: z.object({
              bucket: z.string(),
              scannedObjects: z.number(),
              totalBytes: z.number(),
              truncated: z.boolean(),
              prefixes: z.array(
                z.object({ prefix: z.string(), objects: z.number(), bytes: z.number() }),
              ),
              largest: z.array(
                z.object({ key: z.string(), size: z.number(), lastModified: z.string().nullable() }),
              ),
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
    const bucket = c.req.valid("query").bucket || LOGPUSH_BUCKET;
    const byPrefix = new Map<string, { objects: number; bytes: number }>();
    const largest: { key: string; size: number; lastModified: string | null }[] = [];
    let scanned = 0;
    let totalBytes = 0;
    let cursor: string | undefined;
    let pages = 0;
    let truncated = false;

    do {
      const page = await listR2Objects(c.env, bucket, cursor, 1000);
      for (const o of page.objects) {
        scanned++;
        totalBytes += o.size;
        // Top-level prefix: the segment before the first "/" (date or dataset).
        const prefix = o.key.split("/")[0] || "(root)";
        const agg = byPrefix.get(prefix) ?? { objects: 0, bytes: 0 };
        agg.objects++;
        agg.bytes += o.size;
        byPrefix.set(prefix, agg);
        largest.push({ key: o.key, size: o.size, lastModified: o.lastModified });
      }
      cursor = page.cursor ?? undefined;
      pages++;
      if (pages >= LOGPUSH_MAX_PAGES && page.truncated) {
        truncated = true; // hit our page cap with more to go — say so, do not imply full coverage
        break;
      }
      if (!page.truncated) break;
    } while (cursor);

    const prefixes = [...byPrefix.entries()]
      .map(([prefix, v]) => ({ prefix, ...v }))
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 30);
    largest.sort((a, b) => b.size - a.size);

    return c.json(
      { bucket, scannedObjects: scanned, totalBytes, truncated, prefixes, largest: largest.slice(0, 15) },
      200,
    );
  },
);

// ---------------------------------------------------------------------------
// POST /api/guardian/evaluate  — run the hourly evaluation on demand
// ---------------------------------------------------------------------------

guardianRouter.openapi(
  createRoute({
    method: "post",
    path: "/evaluate",
    operationId: "guardianEvaluate",
    summary: "Run the usage + allowance-alert evaluation now (same path as the cron)",
    responses: {
      200: {
        description: "Evaluation complete",
        content: {
          "application/json": {
            schema: z.object({ alerted: z.array(z.string()), probes: z.number() }),
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
    const { readings, alerted } = await evaluateUsage(c.env);
    return c.json({ alerted, probes: readings.length }, 200);
  },
);

// ---------------------------------------------------------------------------
// POST /api/guardian/archive/d1  — export a D1 database to Drive (no delete)
// ---------------------------------------------------------------------------

guardianRouter.openapi(
  createRoute({
    method: "post",
    path: "/archive/d1",
    operationId: "guardianArchiveD1",
    summary: "Archive a D1 database to Drive (JSON bundle + reconstruct script)",
    description:
      "Copy-only: serializes the database's schema + every table to a JSON bundle, uploads it plus a Python reconstruct script to the configured Drive folder, audits the byte count, and files a human-gated action item to delete the source. Never deletes anything itself.",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({ uuid: z.string(), name: z.string() }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Archived; a deletion action item was filed",
        content: {
          "application/json": {
            schema: z.object({
              database: z.string(),
              uuid: z.string(),
              tables: z.number(),
              rows: z.number(),
              bytes: z.number(),
              driveUrl: z.string(),
              actionItemId: z.string(),
            }),
          },
        },
      },
      401: {
        description: "Missing or invalid session cookie / WORKER_API_KEY bearer token",
        content: { "application/json": { schema: errorResponseSchema } },
      },
      500: {
        description: "Archive failed (e.g. Drive upload rejected)",
        content: { "application/json": { schema: errorResponseSchema } },
      },
    },
  }),
  async (c) => {
    const { uuid, name } = c.req.valid("json");
    try {
      const result = await archiveD1Database(c.env, uuid, name);
      return c.json(result, 200);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Archive failed." }, 500);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/guardian/hotfix  — DRY-RUN emergency patch → draft PR (never merges)
// ---------------------------------------------------------------------------

guardianRouter.openapi(
  createRoute({
    method: "post",
    path: "/hotfix",
    operationId: "guardianHotfix",
    summary: "Propose an emergency code hotfix as a DRAFT pull request (never merges)",
    description:
      "Dry-run only: fetches a file from GitHub, has Workers AI apply the instruction, commits to a new branch, and opens a DRAFT PR for a human to review and merge. Guardian never merges or deploys. Uses the GITHUB_TOKEN binding.",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              repo: z.string().regex(/^[^/]+\/[^/]+$/, "repo must be owner/name"),
              path: z.string().min(1),
              instruction: z.string().min(3),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Draft PR opened",
        content: {
          "application/json": {
            schema: z.object({
              repo: z.string(),
              path: z.string(),
              branch: z.string(),
              prNumber: z.number(),
              prUrl: z.string(),
              changed: z.boolean(),
            }),
          },
        },
      },
      401: {
        description: "Missing or invalid session cookie / WORKER_API_KEY bearer token",
        content: { "application/json": { schema: errorResponseSchema } },
      },
      500: {
        description: "Hotfix failed",
        content: { "application/json": { schema: errorResponseSchema } },
      },
    },
  }),
  async (c) => {
    const { repo, path, instruction } = c.req.valid("json");
    try {
      const result = await proposeHotfix(c.env, repo, path, instruction, Date.now());
      return c.json(result, 200);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Hotfix failed." }, 500);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/guardian/archive/r2  — archive an R2 bucket's objects to Drive
// ---------------------------------------------------------------------------

guardianRouter.openapi(
  createRoute({
    method: "post",
    path: "/archive/r2",
    operationId: "guardianArchiveR2",
    summary: "Archive an R2 bucket's objects to Drive (copy-only; files a delete action item)",
    description:
      "Downloads each object (v4 REST) and uploads it to <worker>/r2-archive/<bucket> in Drive, one at a time, writes a manifest, and files a human-gated action item to delete the archived objects. Bounded by `max`; reports truncation when the bucket has more.",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({ bucket: z.string(), max: z.number().min(1).max(1000).optional() }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Archived",
        content: {
          "application/json": {
            schema: z.object({
              bucket: z.string(),
              archived: z.number(),
              totalBytes: z.number(),
              truncated: z.boolean(),
              driveUrl: z.string(),
              actionItemId: z.string().nullable(),
            }),
          },
        },
      },
      401: {
        description: "Missing or invalid session cookie / WORKER_API_KEY bearer token",
        content: { "application/json": { schema: errorResponseSchema } },
      },
      500: {
        description: "Archive failed",
        content: { "application/json": { schema: errorResponseSchema } },
      },
    },
  }),
  async (c) => {
    const { bucket, max } = c.req.valid("json");
    try {
      const result = await archiveR2Bucket(c.env, bucket, max ?? 100);
      return c.json(result, 200);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Archive failed." }, 500);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/guardian/archive/images  — archive Cloudflare Images to Drive
// ---------------------------------------------------------------------------

guardianRouter.openapi(
  createRoute({
    method: "post",
    path: "/archive/images",
    operationId: "guardianArchiveImages",
    summary: "Archive Cloudflare Images to Drive (copy-only; files a bulk-delete action item)",
    description:
      "Downloads each image blob and uploads it to the auto-managed <worker>/cf-image-archive Drive folder, writes a manifest, and files one human-gated action item to bulk-delete the archived images. Bounded by `max`; filter by `olderThanDays`.",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              olderThanDays: z.number().min(0).max(3650).optional(),
              max: z.number().min(1).max(200).optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Archived",
        content: {
          "application/json": {
            schema: z.object({
              archived: z.number(),
              totalBytes: z.number(),
              candidates: z.number(),
              driveUrl: z.string(),
              actionItemId: z.string().nullable(),
            }),
          },
        },
      },
      401: {
        description: "Missing or invalid session cookie / WORKER_API_KEY bearer token",
        content: { "application/json": { schema: errorResponseSchema } },
      },
      500: {
        description: "Archive failed",
        content: { "application/json": { schema: errorResponseSchema } },
      },
    },
  }),
  async (c) => {
    const { olderThanDays, max } = c.req.valid("json");
    try {
      const result = await archiveImages(c.env, olderThanDays ?? 0, max ?? 25);
      return c.json(result, 200);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Archive failed." }, 500);
    }
  },
);

// ---------------------------------------------------------------------------
// Action items — human-gated destructive follow-ups (approve → verify → done)
// ---------------------------------------------------------------------------

const actionItemSchema = z.object({
  id: z.string(),
  kind: z.string(),
  service: z.string(),
  resourceType: z.string(),
  resourceId: z.string(),
  resourceName: z.string(),
  title: z.string(),
  description: z.string(),
  audit: z.string().nullable(),
  driveUrl: z.string().nullable(),
  status: z.enum(["pending", "in_progress", "complete", "failed"]),
  verifyResult: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.number(),
  approvedAt: z.number().nullable(),
  completedAt: z.number().nullable(),
});

guardianRouter.openapi(
  createRoute({
    method: "get",
    path: "/action-items",
    operationId: "guardianActionItems",
    summary: "Human-gated follow-up tasks (optionally filtered by binding/status)",
    description:
      "Archive flows file these instead of auto-deleting. Filter by `service` so a binding dashboard shows only its own items, and by `status` (pending by default) so the widget only nags about what still needs a decision.",
    request: {
      query: z.object({
        service: z.string().optional(),
        status: z.enum(["pending", "in_progress", "complete", "failed", "all"]).optional(),
      }),
    },
    responses: {
      200: {
        description: "Action items, newest first",
        content: {
          "application/json": {
            schema: z.object({
              items: z.array(actionItemSchema),
              counts: z.object({ pending: z.number(), inProgress: z.number(), complete: z.number() }),
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
    const { service, status } = c.req.valid("query");
    const rows = await getDb(c.env).select().from(actionItems).orderBy(desc(actionItems.createdAt));
    let items = rows;
    if (service) items = items.filter((r) => r.service === service);
    const wantStatus = status ?? "pending";
    if (wantStatus !== "all") items = items.filter((r) => r.status === wantStatus);
    const counts = {
      pending: rows.filter((r) => r.status === "pending").length,
      inProgress: rows.filter((r) => r.status === "in_progress").length,
      complete: rows.filter((r) => r.status === "complete").length,
    };
    return c.json({ items, counts }, 200);
  },
);

// POST /api/guardian/action-items/{id}/approve — run the gated action + verify.
guardianRouter.openapi(
  createRoute({
    method: "post",
    path: "/action-items/{id}/approve",
    operationId: "guardianActionItemApprove",
    summary: "Approve an action item: execute its destructive step, then verify",
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description: "Executed",
        content: {
          "application/json": {
            schema: z.object({ status: z.enum(["complete", "failed"]), detail: z.string() }),
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
    const { id } = c.req.valid("param");
    const result = await executeActionItem(c.env, id);
    return c.json(result, 200);
  },
);

// ---------------------------------------------------------------------------
// GET /api/guardian/alerts  — the actionable advisory surface
// ---------------------------------------------------------------------------

const alertSchema = z.object({
  id: z.string(),
  service: z.string(),
  resource: z.string(),
  worker: z.string().nullable(),
  severity: z.enum(["info", "warning", "critical"]),
  cause: z.string(),
  recommendation: z.string(),
  projectedFraction: z.number().nullable(),
  estCostDelta: z.number().nullable(),
  status: z.enum(["active", "snoozed", "resolved"]),
  snoozedUntil: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

guardianRouter.openapi(
  createRoute({
    method: "get",
    path: "/alerts",
    operationId: "guardianAlerts",
    summary: "Allowance-projection alerts — resource, owner, cause, fix, cost",
    request: {
      query: z.object({
        status: z.enum(["active", "snoozed", "resolved", "all"]).optional(),
      }),
    },
    responses: {
      200: {
        description: "Alerts, most severe first",
        content: {
          "application/json": {
            schema: z.object({
              alerts: z.array(alertSchema),
              counts: z.object({ critical: z.number(), warning: z.number(), info: z.number() }),
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
    const status = c.req.valid("query").status ?? "active";
    const now = Date.now();
    const rows = await getDb(c.env).select().from(alerts).orderBy(desc(alerts.updatedAt));

    // A snooze that has elapsed reads as active again.
    const normalized = rows.map((r) => ({
      ...r,
      status:
        r.status === "snoozed" && (!r.snoozedUntil || r.snoozedUntil <= now)
          ? ("active" as const)
          : r.status,
    }));
    const filtered = status === "all" ? normalized : normalized.filter((r) => r.status === status);

    const SEV_RANK = { critical: 0, warning: 1, info: 2 } as const;
    filtered.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || b.updatedAt - a.updatedAt);

    const counts = { critical: 0, warning: 0, info: 0 };
    for (const r of normalized) if (r.status === "active") counts[r.severity]++;

    return c.json({ alerts: filtered, counts }, 200);
  },
);

// POST /api/guardian/alerts/{id}/action  — snooze | resolve | reactivate
guardianRouter.openapi(
  createRoute({
    method: "post",
    path: "/alerts/{id}/action",
    operationId: "guardianAlertAction",
    summary: "Snooze, resolve, or reactivate an alert",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              action: z.enum(["snooze", "resolve", "reactivate"]),
              hours: z.number().min(1).max(720).optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Updated",
        content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
      },
      401: {
        description: "Missing or invalid session cookie / WORKER_API_KEY bearer token",
        content: { "application/json": { schema: errorResponseSchema } },
      },
      404: {
        description: "No such alert",
        content: { "application/json": { schema: errorResponseSchema } },
      },
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const { action, hours } = c.req.valid("json");
    const now = Date.now();
    const db = getDb(c.env);
    const [existing] = await db.select().from(alerts).where(sql`${alerts.id} = ${id}`).limit(1);
    if (!existing) return c.json({ error: "No such alert" }, 404);

    const patch =
      action === "snooze"
        ? { status: "snoozed" as const, snoozedUntil: now + (hours ?? 24) * 3_600_000, updatedAt: now }
        : action === "resolve"
          ? { status: "resolved" as const, snoozedUntil: null, updatedAt: now }
          : { status: "active" as const, snoozedUntil: null, updatedAt: now };
    await db.update(alerts).set(patch).where(sql`${alerts.id} = ${id}`);
    return c.json({ ok: true }, 200);
  },
);

// ---------------------------------------------------------------------------
// GET /api/guardian/pricing  — the scraped cost basis
// ---------------------------------------------------------------------------

guardianRouter.openapi(
  createRoute({
    method: "get",
    path: "/pricing",
    operationId: "guardianPricing",
    summary: "Latest scraped overage rates + scrape health (the cost basis)",
    description:
      "Cloudflare has no pricing API, so these rates are scraped monthly from the public pricing docs (Browser Rendering, json-schema first then markdown+AI). Returns the latest effective revision per (product, metric) plus the recent scrape runs so the cost-basis page can show how fresh each rate is.",
    responses: {
      200: {
        description: "Latest rates and recent scrape runs",
        content: {
          "application/json": {
            schema: z.object({
              rates: z.array(
                z.object({
                  product: z.string(),
                  metric: z.string(),
                  unitPrice: z.number(),
                  perUnits: z.number(),
                  currency: z.string(),
                  included: z.number().nullable(),
                  effectiveFrom: z.number(),
                }),
              ),
              runs: z.array(
                z.object({
                  id: z.string(),
                  url: z.string(),
                  product: z.string(),
                  status: z.string(),
                  method: z.string(),
                  revisionsWritten: z.number(),
                  error: z.string().nullable(),
                  ranAt: z.number(),
                }),
              ),
              lastScrapedAt: z.number().nullable(),
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
    const db = getDb(c.env);
    const [revs, runs] = await Promise.all([
      db.select().from(pricingRevisions).orderBy(desc(pricingRevisions.effectiveFrom)),
      db.select().from(scrapeRuns).orderBy(desc(scrapeRuns.ranAt)).limit(30),
    ]);

    // Keep only the newest revision per (product, metric). Rows already arrive
    // newest-first, so the first seen wins.
    const seen = new Set<string>();
    const rates = [];
    for (const r of revs) {
      const key = `${r.product}::${r.metric}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rates.push({
        product: r.product,
        metric: r.metric,
        unitPrice: r.unitPrice,
        perUnits: r.perUnits,
        currency: r.currency,
        included: r.included,
        effectiveFrom: r.effectiveFrom,
      });
    }
    rates.sort((a, b) => a.product.localeCompare(b.product) || a.metric.localeCompare(b.metric));

    const lastScrapedAt = runs.length > 0 ? runs[0].ranAt : null;
    const runsOut = runs.map((r) => ({
      id: r.id,
      url: r.url,
      product: r.product,
      status: r.status,
      method: r.method,
      revisionsWritten: r.revisionsWritten,
      error: r.error,
      ranAt: r.ranAt,
    }));
    return c.json({ rates, runs: runsOut, lastScrapedAt }, 200);
  },
);

// ---------------------------------------------------------------------------
// POST /api/guardian/pricing/scrape  — manual trigger
// ---------------------------------------------------------------------------

guardianRouter.openapi(
  createRoute({
    method: "post",
    path: "/pricing/scrape",
    operationId: "guardianPricingScrape",
    summary: "Scrape pricing docs now (also runs monthly on the cron)",
    description:
      "Scraping every doc is a sequence of slow Browser Rendering calls — far longer than one HTTP request should live — so the full run is kicked off in the background (waitUntil) and returns immediately. Pass `?product=<id>` to scrape a single doc synchronously (used for verification).",
    request: {
      query: z.object({ product: z.string().optional() }),
    },
    responses: {
      200: {
        description: "Full run started in the background, or one doc scraped synchronously",
        content: {
          "application/json": {
            schema: z.object({
              started: z.boolean(),
              docs: z.number().optional(),
              revisions: z.number().optional(),
              status: z.string().optional(),
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
    const product = c.req.valid("query").product;
    if (product) {
      // Synchronous single-doc scrape — one Browser Rendering round trip fits in
      // a request, and it lets the UI (and a verifier) confirm extraction works.
      const result = await scrapeOneProduct(c.env, product);
      return c.json({ started: false, ...result }, 200);
    }
    // Full run: too slow for one request. Kick it off in the background.
    c.executionCtx.waitUntil(scrapeAllPricing(c.env).catch(() => {}));
    return c.json({ started: true }, 200);
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
