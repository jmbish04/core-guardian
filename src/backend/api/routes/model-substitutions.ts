/**
 * @fileoverview Management CRUD for AI-Router model-substitution rules (P12),
 * mounted at `/api/guardian/ai-router/substitutions`. All routes are
 * guardianAuth-gated (admin), separate from the `/run` inference door.
 *
 * A rule = "for this project, dispatch to_model whenever from_model is asked
 * for" (read on the hot path by {@link
 * file://src/backend/guardian/ai-router/resolve-model.ts}). Mutations append a
 * `billing_events` audit row. `:` is rejected in project/model to preserve the
 * circuit-breaker scope-key invariant enforced by `/run`.
 */
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { desc, eq } from "drizzle-orm";

import { getDb } from "@/backend/db";
import { billingEvents, modelSubstitutions } from "@/backend/db/schema";
import { DYNAMIC_SENTINELS } from "@/backend/guardian/ai-router/resolve-model";

import { guardianAuth } from "./guardian";

export const modelSubstitutionsRouter = new OpenAPIHono<{ Bindings: Env }>();
modelSubstitutionsRouter.use("*", guardianAuth);

async function audit(env: Env, actionTaken: string) {
  await getDb(env).insert(billingEvents).values({
    id: crypto.randomUUID(), service: "ai-router", actionTaken, timestamp: Date.now(),
  });
}

const ruleSchema = z.object({
  id: z.string(),
  project: z.string(),
  fromModel: z.string(),
  toModel: z.string(),
  enabled: z.boolean(),
  note: z.string().nullable(),
  createdAt: z.number(),
});
const errorSchema = z.object({ error: z.string() });

/** Guard the scope-forming fields exactly like `/run` does. */
function badColon(...vals: string[]): string | null {
  for (const v of vals) if (v.includes(":")) return "project/model must not contain ':'";
  return null;
}

// GET / — list all rules (newest first), optionally filtered by ?project=.
modelSubstitutionsRouter.openapi(createRoute({
  method: "get", path: "/", operationId: "listModelSubstitutions",
  summary: "List model-substitution rules (optionally filter by project)",
  request: { query: z.object({ project: z.string().optional() }) },
  responses: { 200: { description: "Rules", content: { "application/json": { schema: z.object({ substitutions: z.array(ruleSchema) }) } } } },
}), async (c) => {
  const { project } = c.req.valid("query");
  const db = getDb(c.env);
  const base = db.select().from(modelSubstitutions);
  const rows = await (project
    ? base.where(eq(modelSubstitutions.project, project))
    : base
  ).orderBy(desc(modelSubstitutions.createdAt));
  return c.json({ substitutions: rows }, 200);
});

// POST / — create or upsert a rule (unique on project+fromModel). Re-creating
// an existing (project, fromModel) updates its target/note and re-enables it.
modelSubstitutionsRouter.openapi(createRoute({
  method: "post", path: "/", operationId: "upsertModelSubstitution",
  summary: "Create/upsert a substitution rule for a (project, fromModel)",
  request: { body: { content: { "application/json": { schema: z.object({
    project: z.string().min(1), fromModel: z.string().min(1), toModel: z.string().min(1), note: z.string().optional(),
  }) } } } },
  responses: {
    200: { description: "Saved rule", content: { "application/json": { schema: ruleSchema } } },
    400: { description: "Invalid field (':' in project/model)", content: { "application/json": { schema: errorSchema } } },
  },
}), async (c) => {
  const body = c.req.valid("json");
  // Trim so a rule can't substitute to/from whitespace-only, then re-check min
  // length AFTER trim (zod's min(1) passes "   ").
  const project = body.project.trim();
  const fromModel = body.fromModel.trim();
  const toModel = body.toModel.trim();
  const note = body.note;
  if (!project || !fromModel || !toModel) {
    return c.json({ error: "project/fromModel/toModel must be non-empty (after trimming)." }, 400);
  }
  const colon = badColon(project, fromModel, toModel);
  if (colon) return c.json({ error: colon }, 400);
  // A rule keyed on a dynamic sentinel never fires — the resolver treats those
  // as "you pick", never as a concrete from_model. Reject so it can't be saved.
  if (DYNAMIC_SENTINELS.has(fromModel.toLowerCase())) {
    return c.json({ error: `fromModel "${fromModel}" is a dynamic sentinel; a substitution keyed on it would never fire.` }, 400);
  }

  const db = getDb(c.env);
  const row = {
    id: crypto.randomUUID(), project, fromModel, toModel,
    enabled: true, note: note ?? null, createdAt: Date.now(),
  };
  await db.insert(modelSubstitutions).values(row).onConflictDoUpdate({
    target: [modelSubstitutions.project, modelSubstitutions.fromModel],
    set: { toModel, note: note ?? null, enabled: true },
  });
  // Read back the canonical row (the upsert may have kept the original id).
  const saved = await db.select().from(modelSubstitutions)
    .where(eq(modelSubstitutions.project, project)).orderBy(desc(modelSubstitutions.createdAt));
  const rule = saved.find((r) => r.fromModel === fromModel) ?? row;
  await audit(c.env, `Substitution set ${project}: ${fromModel} → ${toModel}`);
  return c.json(rule, 200);
});

// POST /{id}/toggle — flip a rule's enabled flag.
modelSubstitutionsRouter.openapi(createRoute({
  method: "post", path: "/{id}/toggle", operationId: "toggleModelSubstitution",
  summary: "Enable/disable a substitution rule",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "New state", content: { "application/json": { schema: z.object({ id: z.string(), enabled: z.boolean() }) } } },
    404: { description: "No such rule", content: { "application/json": { schema: errorSchema } } },
  },
}), async (c) => {
  const { id } = c.req.valid("param");
  const db = getDb(c.env);
  const existing = await db.select().from(modelSubstitutions).where(eq(modelSubstitutions.id, id)).limit(1);
  if (existing.length === 0) return c.json({ error: "No such substitution rule." }, 404);
  const enabled = !existing[0].enabled;
  await db.update(modelSubstitutions).set({ enabled }).where(eq(modelSubstitutions.id, id));
  await audit(c.env, `Substitution ${id} ${enabled ? "enabled" : "disabled"}`);
  return c.json({ id, enabled }, 200);
});

// DELETE /{id} — remove a rule.
modelSubstitutionsRouter.openapi(createRoute({
  method: "delete", path: "/{id}", operationId: "deleteModelSubstitution",
  summary: "Delete a substitution rule",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: { description: "Deleted", content: { "application/json": { schema: z.object({ ok: z.boolean() }) } } } },
}), async (c) => {
  const { id } = c.req.valid("param");
  await getDb(c.env).delete(modelSubstitutions).where(eq(modelSubstitutions.id, id));
  await audit(c.env, `Substitution ${id} deleted`);
  return c.json({ ok: true }, 200);
});
