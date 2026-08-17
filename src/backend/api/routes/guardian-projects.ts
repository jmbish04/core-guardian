/**
 * @fileoverview Guardian Projects API (P14a) — the unified project + Jules
 * lifecycle surface. Mounted at `/api/guardian/projects`, every route gated by
 * {@link guardianAuth} (session cookie or WORKER_API_KEY bearer).
 *
 * Note the naming: the generic template ships a separate `/api/projects` router
 * (task containers). This is the offense/spend registry over `guardian_projects`
 * + `jules_sessions`, unrelated despite the near-name.
 *
 *  - `GET  /`                      — list projects (active by default; ?all=1 for
 *                                    all), newest last_seen first, with this
 *                                    month's AI spend per project.
 *  - `GET  /jules/sessions`        — list jules_sessions, newest first.
 *  - `POST /sync`                  — run syncWorkerProjects now (returns counts).
 *  - `GET  /{name}`                — one project + its jules_sessions + circuit.
 *  - `POST /{name}/config`         — update {note?, criticality?} (audited).
 *  - `DELETE /{name}/worker`       — DESTRUCTIVE: delete the CF worker (confirm-gated).
 *  - `POST /{name}/disable-crons`  — delete the worker's cron triggers (confirm-gated).
 *
 * The write endpoints are all two-segment (`/{name}/config|worker|disable-crons`)
 * so they never collide with the static `/sync` or `/jules/sessions` paths. The
 * only single-segment `/{name}` route is a GET, and there is no GET `/sync`. NO
 * AI anywhere.
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { desc, eq, gte, sql } from "drizzle-orm";

import { getDb } from "@/backend/db";
import {
  aiRouterRequests,
  billingEvents,
  guardianProjects,
  julesSessions,
} from "@/backend/db/schema";
import { guardianAuth } from "@/backend/api/routes/guardian";
import { getCircuit } from "@/backend/guardian/ai-router/circuits";
import { cfApi } from "@/backend/guardian/resources";
import { syncWorkerProjects } from "@/backend/guardian/projects/sync-workers";

const errorResponseSchema = z.object({ error: z.string() });

/** Wire shape of one guardian_projects row (+ derived monthly spend). */
const projectSchema = z.object({
  name: z.string(),
  kind: z.enum(["worker", "ai_project", "py", "gas", "other"]),
  repo: z.string().nullable(),
  isActive: z.boolean(),
  lastSeen: z.number(),
  note: z.string().nullable(),
  criticality: z.enum(["hobby", "normal", "important", "critical"]),
  createdAt: z.number(),
  spendThisMonthUsd: z.number(),
});

/** Wire shape of one jules_sessions row. */
const julesSessionSchema = z.object({
  id: z.string(),
  sessionId: z.string().nullable(),
  dispatchId: z.string().nullable(),
  project: z.string().nullable(),
  repo: z.string(),
  status: z.enum(["pending", "running", "stuck", "submitted", "failed", "completed"]),
  sessionUrl: z.string().nullable(),
  prUrl: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const guardianProjectsRouter = new OpenAPIHono<{ Bindings: Env }>();
guardianProjectsRouter.use("*", guardianAuth);

/** UTC start-of-month in ms — the window for "spend this month". */
function monthStartMs(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/**
 * Sum this month's ai_router_requests.cost_usd per project, as a Map. One
 * grouped scan rather than a per-row subquery.
 */
async function monthlySpendByProject(
  db: ReturnType<typeof getDb>,
): Promise<Map<string, number>> {
  const rows = await db
    .select({
      project: aiRouterRequests.project,
      total: sql<number>`sum(${aiRouterRequests.costUsd})`,
    })
    .from(aiRouterRequests)
    .where(gte(aiRouterRequests.at, monthStartMs()))
    .groupBy(aiRouterRequests.project);
  const map = new Map<string, number>();
  for (const r of rows) if (r.project) map.set(r.project, Number(r.total ?? 0));
  return map;
}

// ---------------------------------------------------------------------------
// GET /  — list projects
// ---------------------------------------------------------------------------

guardianProjectsRouter.openapi(
  createRoute({
    method: "get",
    path: "/",
    operationId: "guardianProjectsList",
    tags: ["Guardian Projects"],
    summary: "List projects (active by default; ?all=1 for all), newest last_seen first",
    description:
      "Returns the unified project registry ordered by last_seen (newest first). Active-only by default; `all=1` includes deactivated (vanished) workers. Each row carries `spendThisMonthUsd` = sum of ai_router_requests.cost_usd for that project name this UTC month (0 if none).",
    request: {
      query: z.object({ all: z.enum(["0", "1"]).default("0").optional() }),
    },
    responses: {
      200: {
        description: "Projects, newest last_seen first",
        content: {
          "application/json": { schema: z.object({ projects: z.array(projectSchema) }) },
        },
      },
      401: {
        description: "Missing or invalid session cookie / WORKER_API_KEY bearer token",
        content: { "application/json": { schema: errorResponseSchema } },
      },
    },
  }),
  async (c) => {
    const all = c.req.valid("query").all === "1";
    const db = getDb(c.env);

    const [rows, spend] = await Promise.all([
      all
        ? db.select().from(guardianProjects).orderBy(desc(guardianProjects.lastSeen))
        : db
            .select()
            .from(guardianProjects)
            .where(eq(guardianProjects.isActive, true))
            .orderBy(desc(guardianProjects.lastSeen)),
      monthlySpendByProject(db),
    ]);

    const projects = rows.map((r) => ({ ...r, spendThisMonthUsd: spend.get(r.name) ?? 0 }));
    return c.json({ projects }, 200);
  },
);

// ---------------------------------------------------------------------------
// GET /jules/sessions  — list jules_sessions (static path, before /{name})
// ---------------------------------------------------------------------------

guardianProjectsRouter.openapi(
  createRoute({
    method: "get",
    path: "/jules/sessions",
    operationId: "guardianProjectsJulesSessions",
    tags: ["Guardian Projects"],
    summary: "List Jules sessions, newest first",
    description:
      "Returns jules_sessions ordered by created_at (newest first) for the /jules page. Optional `status` filter.",
    request: {
      query: z.object({
        status: z
          .enum(["pending", "running", "stuck", "submitted", "failed", "completed", "all"])
          .default("all")
          .optional(),
      }),
    },
    responses: {
      200: {
        description: "Jules sessions, newest first",
        content: {
          "application/json": { schema: z.object({ sessions: z.array(julesSessionSchema) }) },
        },
      },
      401: {
        description: "Missing or invalid session cookie / WORKER_API_KEY bearer token",
        content: { "application/json": { schema: errorResponseSchema } },
      },
    },
  }),
  async (c) => {
    const status = c.req.valid("query").status ?? "all";
    const db = getDb(c.env);
    const rows =
      status === "all"
        ? await db.select().from(julesSessions).orderBy(desc(julesSessions.createdAt))
        : await db
            .select()
            .from(julesSessions)
            .where(eq(julesSessions.status, status))
            .orderBy(desc(julesSessions.createdAt));
    return c.json({ sessions: rows }, 200);
  },
);

// ---------------------------------------------------------------------------
// POST /sync  — run the worker sync now (static path, before /{name})
// ---------------------------------------------------------------------------

guardianProjectsRouter.openapi(
  createRoute({
    method: "post",
    path: "/sync",
    operationId: "guardianProjectsSync",
    tags: ["Guardian Projects"],
    summary: "Run syncWorkerProjects now and return counts",
    description:
      "Reconciles guardian_projects with the live account: upserts every Cloudflare Worker (preserving operator note/criticality), deactivates vanished workers, and inserts distinct ai_router_requests.project values as kind='ai_project'. Best-effort repo resolution from the Workers Builds config. NO AI.",
    responses: {
      200: {
        description: "Sync summary counts",
        content: {
          "application/json": {
            schema: z.object({
              workers: z.number(),
              workersUpserted: z.number(),
              workersDeactivated: z.number(),
              aiProjects: z.number(),
              aiProjectsInserted: z.number(),
              reposResolved: z.number(),
              syncedAt: z.number(),
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
    const summary = await syncWorkerProjects(c.env);
    return c.json(summary, 200);
  },
);

// ---------------------------------------------------------------------------
// GET /{name}  — one project + its jules_sessions + circuit
// ---------------------------------------------------------------------------

guardianProjectsRouter.openapi(
  createRoute({
    method: "get",
    path: "/{name}",
    operationId: "guardianProjectsGet",
    tags: ["Guardian Projects"],
    summary: "Get one project with its Jules sessions and current circuit state",
    description:
      "Returns the project row (+ this month's spend), every jules_sessions row that names it, and its current AI Router circuit (CIRCUITS KV, scope project:<name>) — null when no circuit is set.",
    request: { params: z.object({ name: z.string() }) },
    responses: {
      200: {
        description: "The project, its Jules sessions, and its circuit",
        content: {
          "application/json": {
            schema: z.object({
              project: projectSchema,
              julesSessions: z.array(julesSessionSchema),
              circuit: z.record(z.string(), z.unknown()).nullable(),
            }),
          },
        },
      },
      401: {
        description: "Missing or invalid session cookie / WORKER_API_KEY bearer token",
        content: { "application/json": { schema: errorResponseSchema } },
      },
      404: {
        description: "No project with that name",
        content: { "application/json": { schema: errorResponseSchema } },
      },
    },
  }),
  async (c) => {
    const { name } = c.req.valid("param");
    const db = getDb(c.env);

    const [row] = await db
      .select()
      .from(guardianProjects)
      .where(eq(guardianProjects.name, name))
      .limit(1);
    if (!row) return c.json({ error: "No project with that name." }, 404);

    const [sessions, spend, circuit] = await Promise.all([
      db.select().from(julesSessions).where(eq(julesSessions.project, name)).orderBy(desc(julesSessions.createdAt)),
      monthlySpendByProject(db),
      getCircuit(c.env, `project:${name}`),
    ]);

    return c.json(
      {
        project: { ...row, spendThisMonthUsd: spend.get(name) ?? 0 },
        julesSessions: sessions,
        circuit: (circuit as Record<string, unknown> | null) ?? null,
      },
      200,
    );
  },
);

// ---------------------------------------------------------------------------
// POST /{name}  — update metadata
// ---------------------------------------------------------------------------

guardianProjectsRouter.openapi(
  createRoute({
    method: "post",
    path: "/{name}/config",
    operationId: "guardianProjectsUpdate",
    tags: ["Guardian Projects"],
    summary: "Update a project's note / criticality / repo (audited)",
    description:
      "Updates the operator metadata on a project. All fields optional; only provided fields are written. `repo` is a deliberate source — it sets or CHANGES the stored owner/repo (unlike the CF-builds sync, which only fills/refreshes). Audited to billing_events.",
    request: {
      params: z.object({ name: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              note: z.string().nullable().optional(),
              criticality: z.enum(["hobby", "normal", "important", "critical"]).optional(),
              repo: z.string().regex(/^[^/]+\/[^/]+$/, "repo must be owner/name").optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "The updated project",
        content: { "application/json": { schema: z.object({ project: projectSchema }) } },
      },
      400: {
        description: "No updatable fields provided",
        content: { "application/json": { schema: errorResponseSchema } },
      },
      401: {
        description: "Missing or invalid session cookie / WORKER_API_KEY bearer token",
        content: { "application/json": { schema: errorResponseSchema } },
      },
      404: {
        description: "No project with that name",
        content: { "application/json": { schema: errorResponseSchema } },
      },
    },
  }),
  async (c) => {
    const { name } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = getDb(c.env);

    const patch: {
      note?: string | null;
      criticality?: (typeof body)["criticality"];
      repo?: string;
    } = {};
    if (body.note !== undefined) patch.note = body.note;
    if (body.criticality !== undefined) patch.criticality = body.criticality;
    if (body.repo !== undefined) patch.repo = body.repo;
    if (Object.keys(patch).length === 0) {
      return c.json({ error: "Provide at least one of note, criticality, repo." }, 400);
    }

    const [updated] = await db
      .update(guardianProjects)
      .set(patch)
      .where(eq(guardianProjects.name, name))
      .returning();
    if (!updated) return c.json({ error: "No project with that name." }, 404);

    await db.insert(billingEvents).values({
      id: crypto.randomUUID(),
      service: "projects",
      actionTaken: `Updated project ${name} metadata (${Object.keys(patch).join(", ")}).`,
      timestamp: Date.now(),
    });

    const spend = await monthlySpendByProject(db);
    return c.json({ project: { ...updated, spendThisMonthUsd: spend.get(name) ?? 0 } }, 200);
  },
);

// ---------------------------------------------------------------------------
// DELETE /{name}/worker  — DESTRUCTIVE, confirm-gated
// ---------------------------------------------------------------------------

guardianProjectsRouter.openapi(
  createRoute({
    method: "delete",
    path: "/{name}/worker",
    operationId: "guardianProjectsDeleteWorker",
    tags: ["Guardian Projects"],
    summary: "DESTRUCTIVE: delete the Cloudflare Worker for a project (confirm-gated)",
    description:
      "Deletes the underlying Cloudflare Worker script via the CF API (force=true). Only valid for kind='worker'. Requires body `{ confirm: \"delete <name>\" }` matching EXACTLY, else 400. The project row is then marked is_active=0. Audited.",
    request: {
      params: z.object({ name: z.string() }),
      body: {
        content: { "application/json": { schema: z.object({ confirm: z.string() }) } },
      },
    },
    responses: {
      200: {
        description: "Worker deleted; project deactivated",
        content: {
          "application/json": { schema: z.object({ ok: z.literal(true), name: z.string() }) },
        },
      },
      400: {
        description: "Confirmation mismatch or project is not a worker",
        content: { "application/json": { schema: errorResponseSchema } },
      },
      401: {
        description: "Missing or invalid session cookie / WORKER_API_KEY bearer token",
        content: { "application/json": { schema: errorResponseSchema } },
      },
      404: {
        description: "No project with that name",
        content: { "application/json": { schema: errorResponseSchema } },
      },
    },
  }),
  async (c) => {
    const { name } = c.req.valid("param");
    const { confirm } = c.req.valid("json");
    const db = getDb(c.env);

    const [row] = await db
      .select()
      .from(guardianProjects)
      .where(eq(guardianProjects.name, name))
      .limit(1);
    if (!row) return c.json({ error: "No project with that name." }, 404);
    if (row.kind !== "worker") {
      return c.json({ error: `Project ${name} is kind=${row.kind}, not a deletable worker.` }, 400);
    }
    if (confirm !== `delete ${name}`) {
      return c.json({ error: `Confirmation must be exactly "delete ${name}".` }, 400);
    }

    await cfApi(c.env, `/workers/scripts/${encodeURIComponent(name)}?force=true`, {
      method: "DELETE",
    });

    await db
      .update(guardianProjects)
      .set({ isActive: false })
      .where(eq(guardianProjects.name, name));

    await db.insert(billingEvents).values({
      id: crypto.randomUUID(),
      service: "projects",
      actionTaken: `DELETED Cloudflare Worker "${name}" (confirm-gated) and deactivated its project row.`,
      timestamp: Date.now(),
    });

    return c.json({ ok: true as const, name }, 200);
  },
);

// ---------------------------------------------------------------------------
// POST /{name}/disable-crons  — delete cron triggers, confirm-gated
// ---------------------------------------------------------------------------

guardianProjectsRouter.openapi(
  createRoute({
    method: "post",
    path: "/{name}/disable-crons",
    operationId: "guardianProjectsDisableCrons",
    tags: ["Guardian Projects"],
    summary: "Delete a worker's cron triggers (confirm-gated)",
    description:
      "Clears all cron triggers on the Cloudflare Worker via PUT /workers/scripts/{name}/schedules with an empty list. Only valid for kind='worker'. Requires body `{ confirm: \"delete <name>\" }` matching EXACTLY, else 400. Audited. Stops a runaway scheduled worker without deleting it.",
    request: {
      params: z.object({ name: z.string() }),
      body: {
        content: { "application/json": { schema: z.object({ confirm: z.string() }) } },
      },
    },
    responses: {
      200: {
        description: "Cron triggers cleared",
        content: {
          "application/json": { schema: z.object({ ok: z.literal(true), name: z.string() }) },
        },
      },
      400: {
        description: "Confirmation mismatch or project is not a worker",
        content: { "application/json": { schema: errorResponseSchema } },
      },
      401: {
        description: "Missing or invalid session cookie / WORKER_API_KEY bearer token",
        content: { "application/json": { schema: errorResponseSchema } },
      },
      404: {
        description: "No project with that name",
        content: { "application/json": { schema: errorResponseSchema } },
      },
    },
  }),
  async (c) => {
    const { name } = c.req.valid("param");
    const { confirm } = c.req.valid("json");
    const db = getDb(c.env);

    const [row] = await db
      .select()
      .from(guardianProjects)
      .where(eq(guardianProjects.name, name))
      .limit(1);
    if (!row) return c.json({ error: "No project with that name." }, 404);
    if (row.kind !== "worker") {
      return c.json({ error: `Project ${name} is kind=${row.kind}, not a worker.` }, 400);
    }
    if (confirm !== `delete ${name}`) {
      return c.json({ error: `Confirmation must be exactly "delete ${name}".` }, 400);
    }

    // CF schedules API: PUT the full desired schedule list; [] clears all crons.
    await cfApi(c.env, `/workers/scripts/${encodeURIComponent(name)}/schedules`, {
      method: "PUT",
      body: JSON.stringify([]),
    });

    await db.insert(billingEvents).values({
      id: crypto.randomUUID(),
      service: "projects",
      actionTaken: `Cleared cron triggers on Cloudflare Worker "${name}" (confirm-gated).`,
      timestamp: Date.now(),
    });

    return c.json({ ok: true as const, name }, 200);
  },
);
