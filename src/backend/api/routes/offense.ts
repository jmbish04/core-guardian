/**
 * @fileoverview Spend Offense incident API (P1) — read + resolve.
 *
 * Mounted at `/api/guardian/offense`. Two endpoints, both gated by the shared
 * {@link guardianAuth} middleware (session cookie or `WORKER_API_KEY` bearer):
 *
 *  - `GET  /incidents`            — list `circuit_break_events`, newest first,
 *                                    optionally filtered by status. Polled by the
 *                                    local watchdog and rendered on the dashboard.
 *  - `POST /incidents/{id}/resolve` — mark an incident `read` (acknowledged, stays
 *                                    a live breaker) or `erroneous` (false positive;
 *                                    lift any kill switch this incident engaged).
 *
 * P1 is read-only + resolve. The scanners, Jules dispatch, and nonce-authed
 * findings intake are later phases (see docs/architecture/spend-offense.md).
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, desc, eq, gte, ne } from "drizzle-orm";

import { getDb } from "@/backend/db";
import {
  billingEvents,
  circuitBreakEvents,
  scanTargets,
  type CircuitBreakAction,
} from "@/backend/db/schema";
import { guardianAuth } from "@/backend/api/routes/guardian";
import { setKillSwitch } from "@/backend/guardian/ai-router/circuits";
import { scanWorkers } from "@/backend/guardian/offense/scan-workers";
import { scanGithub } from "@/backend/guardian/offense/scan-github";

const errorResponseSchema = z.object({ error: z.string() });

/** Wire shape of one incident row. JSON columns are passed through as-is. */
const incidentSchema = z.object({
  id: z.string(),
  projectIdentification: z.record(z.string(), z.unknown()).nullable(),
  scope: z.string().nullable(),
  reason: z.string(),
  source: z.enum(["scanner", "jules", "auto_spend"]),
  status: z.enum(["active", "read", "erroneous"]),
  julesPr: z.string().nullable(),
  actionsTaken: z.array(z.record(z.string(), z.unknown())).nullable(),
  recommendation: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.number(),
  resolvedAt: z.number().nullable(),
});

export const offenseRouter = new OpenAPIHono<{ Bindings: Env }>();
offenseRouter.use("*", guardianAuth);

// ---------------------------------------------------------------------------
// GET /incidents
// ---------------------------------------------------------------------------

offenseRouter.openapi(
  createRoute({
    method: "get",
    path: "/incidents",
    operationId: "offenseListIncidents",
    tags: ["Guardian Offense"],
    summary: "List Spend Offense incidents (circuit_break_events), newest first",
    description:
      "Returns `circuit_break_events` filtered by status. `active` (default) are live breakers still awaiting resolution — the set the local watchdog polls and the dashboard banners. `all` returns every incident regardless of status.",
    request: {
      query: z.object({
        status: z.enum(["active", "read", "erroneous", "all"]).default("active").optional(),
      }),
    },
    responses: {
      200: {
        description: "Incidents, newest first",
        content: {
          "application/json": {
            schema: z.object({ incidents: z.array(incidentSchema) }),
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
    const db = getDb(c.env);
    const rows =
      status === "all"
        ? await db
            .select()
            .from(circuitBreakEvents)
            .orderBy(desc(circuitBreakEvents.createdAt))
        : await db
            .select()
            .from(circuitBreakEvents)
            .where(eq(circuitBreakEvents.status, status))
            .orderBy(desc(circuitBreakEvents.createdAt));
    return c.json({ incidents: rows }, 200);
  },
);

// ---------------------------------------------------------------------------
// POST /incidents/{id}/resolve
// ---------------------------------------------------------------------------

/** Did this incident's recorded actions flip the AI kill switch? */
function flippedKillSwitch(actions: CircuitBreakAction[] | null): boolean {
  return (actions ?? []).some((a) => a.kind === "kill_switch");
}

offenseRouter.openapi(
  createRoute({
    method: "post",
    path: "/incidents/{id}/resolve",
    operationId: "offenseResolveIncident",
    tags: ["Guardian Offense"],
    summary: "Resolve an incident: mark read (acknowledge) or erroneous (lift any kill switch)",
    description:
      "`read` acknowledges the incident and stamps resolved_at, but the breaker stays a live active-status entry per the safety model. `erroneous` marks it a false positive and, if this incident engaged the AI kill switch, lifts it (setKillSwitch false).",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({ action: z.enum(["read", "erroneous"]) }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "The updated incident",
        content: {
          "application/json": {
            schema: z.object({
              incident: incidentSchema,
              killSwitchLifted: z.boolean(),
            }),
          },
        },
      },
      401: {
        description: "Missing or invalid session cookie / WORKER_API_KEY bearer token",
        content: { "application/json": { schema: errorResponseSchema } },
      },
      404: {
        description: "No incident with that id",
        content: { "application/json": { schema: errorResponseSchema } },
      },
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const { action } = c.req.valid("json");
    const db = getDb(c.env);

    const [existing] = await db
      .select()
      .from(circuitBreakEvents)
      .where(eq(circuitBreakEvents.id, id))
      .limit(1);
    if (!existing) return c.json({ error: "Incident not found." }, 404);

    const now = Date.now();
    let killSwitchLifted = false;

    // Erroneous → false positive: undo an automated kill switch this incident set,
    // but ONLY if no other still-active incident also relies on it (otherwise
    // resolving an old incident would turn AI back on while a newer one wants it off).
    if (action === "erroneous" && flippedKillSwitch(existing.actionsTaken)) {
      const others = await db
        .select({ actionsTaken: circuitBreakEvents.actionsTaken })
        .from(circuitBreakEvents)
        .where(and(eq(circuitBreakEvents.status, "active"), ne(circuitBreakEvents.id, id)));
      const stillNeeded = others.some((o) => flippedKillSwitch(o.actionsTaken));
      if (!stillNeeded) {
        await setKillSwitch(c.env, false);
        killSwitchLifted = true;
      }
    }

    const [updated] = await db
      .update(circuitBreakEvents)
      .set({ status: action, resolvedAt: now })
      .where(eq(circuitBreakEvents.id, id))
      .returning();

    // Audit the resolution.
    await db.insert(billingEvents).values({
      id: crypto.randomUUID(),
      service: "offense",
      actionTaken: `Resolved incident ${id} as ${action}${killSwitchLifted ? " (kill switch lifted)" : ""}.`,
      timestamp: now,
    });

    return c.json({ incident: updated, killSwitchLifted }, 200);
  },
);

// ---------------------------------------------------------------------------
// POST /scan  (P2 — zero-AI Cloudflare Worker scanner)
// ---------------------------------------------------------------------------

/** Wire shape of the deterministic risk signals. */
const riskSignalsSchema = z.object({
  cron: z.boolean(),
  browser: z.boolean(),
  scraping: z.boolean(),
  d1: z.boolean(),
  vectorize: z.boolean(),
  durableObject: z.boolean(),
  ai: z.boolean(),
});

offenseRouter.openapi(
  createRoute({
    method: "post",
    path: "/scan",
    operationId: "offenseScanWorkers",
    tags: ["Guardian Offense"],
    summary: "Run the zero-AI worker scanner and upsert scan_targets",
    description:
      "Enumerates every Cloudflare Worker, reads cron triggers + bindings, samples invocation frequency, and scores billable-risk deterministically (NO AI). Cross-checks each AI-using worker against ai_router_requests / ai_usage_registrations; an AI worker guardian has never logged is flagged as a bypass. Upserts one scan_targets row per worker (keyed by name; first_seen preserved).",
    responses: {
      200: {
        description: "Scan summary: counts + the highest-risk workers",
        content: {
          "application/json": {
            schema: z.object({
              scanned: z.number(),
              upserted: z.number(),
              aiWorkers: z.number(),
              cronWorkers: z.number(),
              bypasses: z.number(),
              scannedAt: z.number(),
              topRisk: z.array(
                z.object({
                  name: z.string(),
                  riskScore: z.number(),
                  guardianRegistered: z.boolean(),
                  isBypass: z.boolean(),
                  cronSchedules: z.array(z.string()),
                  signals: riskSignalsSchema,
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
    const summary = await scanWorkers(c.env);
    return c.json(summary, 200);
  },
);

// ---------------------------------------------------------------------------
// POST /scan/github  (P3 — zero-AI GitHub Actions scanner)
// ---------------------------------------------------------------------------

offenseRouter.openapi(
  createRoute({
    method: "post",
    path: "/scan/github",
    operationId: "offenseScanGithub",
    tags: ["Guardian Offense"],
    summary: "Run the zero-AI GitHub Actions scanner and upsert scan_targets",
    description:
      "Lists the authenticated user's GitHub repos, reads each repo's .github/workflows/* (+ wrangler config), and regex-detects AI usage (Cloudflare AI / AI Gateway / *.hacolby.workers.dev / provider hosts). NO AI is used. A repo that uses AI in CI but has no rows in ai_router_requests / ai_usage_registrations is flagged as a bypass. Only AI-using repos are upserted (kind='github_action', keyed by full_name; first_seen preserved). Stops gracefully on GitHub rate limits and caps enumeration at 200 repos (both surfaced in the summary).",
    responses: {
      200: {
        description: "GitHub scan summary: counts + the highest-risk repos",
        content: {
          "application/json": {
            schema: z.object({
              ok: z.boolean(),
              error: z.string().optional(),
              reposListed: z.number(),
              reposScanned: z.number(),
              aiRepos: z.number(),
              bypasses: z.number(),
              truncated: z.boolean(),
              rateLimited: z.boolean(),
              scannedAt: z.number(),
              topRisk: z.array(
                z.object({
                  name: z.string(),
                  riskScore: z.number(),
                  guardianRegistered: z.boolean(),
                  isBypass: z.boolean(),
                  cronSchedules: z.array(z.string()),
                  workerName: z.string().nullable(),
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
    const summary = await scanGithub(c.env);
    return c.json(summary, 200);
  },
);

// ---------------------------------------------------------------------------
// GET /targets  (list scanned players + risk)
// ---------------------------------------------------------------------------

/** Wire shape of one scan_targets row. JSON columns pass through as-is. */
const targetSchema = z.object({
  id: z.string(),
  kind: z.enum(["worker", "github_action", "local", "gas"]),
  name: z.string(),
  workerName: z.string().nullable(),
  cronSchedules: z.array(z.string()).nullable(),
  riskSignals: riskSignalsSchema.nullable(),
  riskScore: z.number(),
  guardianRegistered: z.boolean(),
  bypass: z.object({ isBypass: z.boolean(), why: z.string() }).nullable(),
  firstSeen: z.number(),
  lastScan: z.number(),
});

offenseRouter.openapi(
  createRoute({
    method: "get",
    path: "/targets",
    operationId: "offenseListTargets",
    tags: ["Guardian Offense"],
    summary: "List scan_targets (players + risk), newest scan first",
    description:
      "Returns scan_targets ordered by last_scan (newest first). `bypass` filters to AI workers that do (true) or do not (false) evade core-guardian; `all` (default) returns everything. `minRisk` keeps only rows with risk_score >= N.",
    request: {
      query: z.object({
        bypass: z.enum(["true", "false", "all"]).default("all").optional(),
        minRisk: z.coerce.number().min(0).max(100).default(0).optional(),
      }),
    },
    responses: {
      200: {
        description: "Scan targets, newest scan first",
        content: {
          "application/json": {
            schema: z.object({ targets: z.array(targetSchema) }),
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
    const { bypass, minRisk } = c.req.valid("query");
    const db = getDb(c.env);

    const conditions = [gte(scanTargets.riskScore, minRisk ?? 0)];
    const rows = await db
      .select()
      .from(scanTargets)
      .where(and(...conditions))
      .orderBy(desc(scanTargets.lastScan));

    // `bypass` filter lives on a JSON column — filter in-app rather than probe
    // JSON in SQL. ponytail: fine at scan_targets' scale (one row per worker).
    const filtered =
      bypass === "true"
        ? rows.filter((r) => r.bypass?.isBypass === true)
        : bypass === "false"
          ? rows.filter((r) => r.bypass?.isBypass !== true)
          : rows;

    return c.json({ targets: filtered }, 200);
  },
);
