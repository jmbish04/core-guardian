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
 * P1 is read-only + resolve; P2/P3 add the scanners.
 *
 * ## Two routers, two auth models (P4 security structuring)
 * Every route on {@link offenseRouter} is guarded by {@link guardianAuth} via a
 * fail-CLOSED `use("*", …)` — so any route added to it is authenticated by
 * default. The Jules findings-intake endpoint must NOT sit behind guardianAuth
 * (its per-dispatch nonce IS the auth), so it lives on a **separate**
 * {@link offensePublicRouter} that carries no auth middleware at all.
 *
 * Both mount at `/api/guardian/offense`. Hono flattens both sub-apps into one
 * trie and runs matching handlers in **registration order**, so the public
 * router MUST be mounted before the guarded one (see api/index.ts): the
 * `/findings` handler then resolves and responds before the guarded router's
 * `/*` middleware can run. Verified: public-first ⇒ `/findings` bypasses auth
 * (200) while `/incidents` still enforces it (401); guarded-first ⇒ `/findings`
 * would 401. The failure mode of a wrong order is fail-SAFE (Jules is blocked,
 * never a silent bypass), but the order is load-bearing — do not reorder.
 * The nonce lookup (pending + spend_audit) is the only credential check.
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, desc, eq, gte, inArray, ne } from "drizzle-orm";

import { getDb } from "@/backend/db";
import {
  billingEvents,
  circuitBreakEvents,
  julesDispatches,
  scanTargets,
  type CircuitBreakAction,
} from "@/backend/db/schema";
import { guardianAuth } from "@/backend/api/routes/guardian";
import { deleteCircuit, setKillSwitch } from "@/backend/guardian/ai-router/circuits";
import { scanWorkers } from "@/backend/guardian/offense/scan-workers";
import { scanGithub } from "@/backend/guardian/offense/scan-github";
import { dispatchToJules, recordFindings } from "@/backend/guardian/offense/jules-dispatch";

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

/** Did this incident's actions break a project circuit (setCircuit)? */
function flippedCircuit(actions: CircuitBreakAction[] | null): boolean {
  return (actions ?? []).some((a) => a.kind === "circuit_break");
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
              circuitLifted: z.boolean(),
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
    let circuitLifted = false;

    // Erroneous → false positive: undo the breakers THIS incident engaged, but
    // never one another still-live incident also relies on. 'read' incidents are
    // still live breakers (acknowledged, breaker stays on), so they count too.
    if (action === "erroneous") {
      const others = await db
        .select({ scope: circuitBreakEvents.scope, actionsTaken: circuitBreakEvents.actionsTaken })
        .from(circuitBreakEvents)
        .where(
          and(inArray(circuitBreakEvents.status, ["active", "read"]), ne(circuitBreakEvents.id, id)),
        );

      // Lift the global kill switch, unless another live incident needs it.
      if (
        flippedKillSwitch(existing.actionsTaken) &&
        !others.some((o) => flippedKillSwitch(o.actionsTaken))
      ) {
        await setKillSwitch(c.env, false);
        killSwitchLifted = true;
      }

      // Restore AI for the project circuit this incident broke (e.g. a Jules
      // incident that flipped project:X to a $0 budget) — the operator's override
      // — unless another live incident broke the same scope.
      if (
        flippedCircuit(existing.actionsTaken) &&
        existing.scope &&
        !others.some((o) => o.scope === existing.scope && flippedCircuit(o.actionsTaken))
      ) {
        await deleteCircuit(c.env, existing.scope);
        circuitLifted = true;
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
      actionTaken: `Resolved incident ${id} as ${action}${killSwitchLifted ? " (kill switch lifted)" : ""}${circuitLifted ? ` (circuit ${existing.scope} restored)` : ""}.`,
      timestamp: now,
    });

    return c.json({ incident: updated, killSwitchLifted, circuitLifted }, 200);
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

// ---------------------------------------------------------------------------
// POST /dispatch/{targetId}  (P5 — hand a flagged target to Jules)
// ---------------------------------------------------------------------------

offenseRouter.openapi(
  createRoute({
    method: "post",
    path: "/dispatch/{targetId}",
    operationId: "offenseDispatchJules",
    tags: ["Guardian Offense"],
    summary: "Dispatch a Jules spend-audit session for a flagged scan target",
    description:
      "Operator-triggered (guardianAuth). Looks up the scan_targets row, resolves its GitHub owner/repo, mints a one-time nonce + pending jules_dispatches row, and creates a Jules session (AUTO_CREATE_PR) carrying a self-contained audit brief. The brief embeds the nonce (the sole credential for the /findings callback) and instructs Jules to comment out spend violations and open a PR. Returns the dispatch id + Jules session id. 400 when the target has no resolvable owner/repo or the Jules API call fails (the dispatch is marked failed). NO core-guardian-side AI.",
    request: {
      params: z.object({ targetId: z.string() }),
    },
    responses: {
      200: {
        description: "Jules session created; dispatch recorded",
        content: {
          "application/json": {
            schema: z.object({
              ok: z.literal(true),
              dispatchId: z.string().nullable(),
              julesSessionId: z.string().nullable(),
            }),
          },
        },
      },
      400: {
        description: "Target not dispatchable (no owner/repo) or the Jules API call failed",
        content: { "application/json": { schema: errorResponseSchema } },
      },
      401: {
        description: "Missing or invalid session cookie / WORKER_API_KEY bearer token",
        content: { "application/json": { schema: errorResponseSchema } },
      },
      404: {
        description: "No scan target with that id",
        content: { "application/json": { schema: errorResponseSchema } },
      },
    },
  }),
  async (c) => {
    const { targetId } = c.req.valid("param");
    const db = getDb(c.env);

    const [target] = await db
      .select()
      .from(scanTargets)
      .where(eq(scanTargets.id, targetId))
      .limit(1);
    if (!target) return c.json({ error: "No scan target with that id." }, 404);

    const result = await dispatchToJules(c.env, target);
    if (!result.ok) return c.json({ error: result.error ?? "Jules dispatch failed." }, 400);

    return c.json(
      { ok: true as const, dispatchId: result.dispatchId, julesSessionId: result.julesSessionId },
      200,
    );
  },
);

// ---------------------------------------------------------------------------
// Public (nonce-authed) router — POST /findings  (P4 — Jules reports back)
// ---------------------------------------------------------------------------

/**
 * The findings-intake router. Deliberately has **no** guardianAuth: the
 * per-dispatch nonce is the credential. Mounted at the same base path as
 * {@link offenseRouter}; its middleware stack is independent, so `/findings`
 * never inherits the session/bearer guard. See the file header for the rationale.
 */
export const offensePublicRouter = new OpenAPIHono<{ Bindings: Env }>();

/** The reporting contract Jules curls back (see docs → "Jules instruction contract"). */
const findingsBodySchema = z.object({
  repo: z.string(),
  repo_type: z.string(),
  worker_name: z.string().optional(),
  cron_audit_findings: z.array(z.string()),
  ai_audit_findings: z.array(z.string()),
  pr_number: z.number().optional(),
  actions_taken: z.array(z.string()),
  circuit_breaker_recommendation: z.array(z.string()),
  core_guardian_project_identification: z
    .object({
      projectName: z.string(),
      projectType: z.string().optional(),
    })
    .passthrough(),
  nonce: z.uuid(),
});

offensePublicRouter.openapi(
  createRoute({
    method: "post",
    path: "/findings",
    operationId: "offenseRecordFindings",
    tags: ["Guardian Offense"],
    summary: "Jules reports spend-audit findings (nonce-authenticated) and guardian auto-acts",
    description:
      "Nonce-authenticated: NOT behind guardianAuth. The presented `nonce` must match a PENDING `jules_dispatches` row of task_type `spend_audit`; no match → 403 (generic). On match the dispatch is spent (→ reported, one-time), the findings are persisted, an incident (source=jules) is filed, and — if Jules recommends disabling the identified project — that project's circuit breaker is flipped to a $0 budget. NO AI.",
    request: {
      body: {
        content: { "application/json": { schema: findingsBodySchema } },
      },
    },
    responses: {
      200: {
        description: "Findings recorded; auto-action (if any) applied",
        content: {
          "application/json": {
            schema: z.object({
              ok: z.literal(true),
              incidentId: z.string(),
              circuitFlipped: z.boolean(),
            }),
          },
        },
      },
      403: {
        description: "Nonce did not match a pending spend_audit dispatch (generic — does not leak)",
        content: { "application/json": { schema: errorResponseSchema } },
      },
    },
  }),
  async (c) => {
    const body = c.req.valid("json");
    const db = getDb(c.env);

    // Auth IS the lookup: only a pending spend_audit dispatch matches. A replayed
    // (already reported) or unknown nonce finds nothing → generic 403, no leak.
    const [dispatch] = await db
      .select()
      .from(julesDispatches)
      .where(
        and(
          eq(julesDispatches.nonce, body.nonce),
          eq(julesDispatches.status, "pending"),
          eq(julesDispatches.taskType, "spend_audit"),
        ),
      )
      .limit(1);
    if (!dispatch) return c.json({ error: "Invalid or expired token." }, 403);

    const { incidentId, circuitFlipped } = await recordFindings(c.env, dispatch, body);
    return c.json({ ok: true as const, incidentId, circuitFlipped }, 200);
  },
);
