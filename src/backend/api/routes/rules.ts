/**
 * @fileoverview Alert rule CRUD — the configuration surface behind the Alert
 * Rules panel.
 *
 * Arming a rule (letting it execute a mitigation without a human) is the one
 * state change here that grants autonomous authority over infrastructure, so it
 * is a dedicated endpoint with a typed confirmation rather than a field on the
 * generic update route.
 *
 * All routes are gated by {@link guardianAuth}.
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { desc, eq } from "drizzle-orm";

import { guardianAuth } from "@/backend/api/routes/guardian";
import { getDb } from "@/backend/db";
import { alertRules, billingEvents } from "@/backend/db/schema";
import { seedDefaultRules } from "@/backend/guardian/rules";

export const rulesRouter = new OpenAPIHono<{ Bindings: Env }>();
rulesRouter.use("*", guardianAuth);

const errorSchema = z.object({ error: z.string() });
const unauthorized = {
  description: "Missing or invalid session cookie / WORKER_API_KEY bearer token",
  content: { "application/json": { schema: errorSchema } },
};

const COMPARATORS = ["gt", "gte", "lt", "lte"] as const;
const SEVERITIES = ["info", "moderate", "significant", "critical"] as const;
const ACTIONS = ["notify", "evict_r2", "drop_vectorize", "disable_topup"] as const;

const ruleSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  service: z.string(),
  comparator: z.enum(COMPARATORS),
  threshold: z.number().nullable(),
  windowHours: z.number(),
  severity: z.enum(SEVERITIES),
  action: z.enum(ACTIONS),
  actionTarget: z.string().nullable(),
  armed: z.boolean(),
  enabled: z.boolean(),
  cooldownMinutes: z.number(),
  lastFiredAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const ruleInput = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  service: z.string().min(1),
  comparator: z.enum(COMPARATORS).default("gt"),
  threshold: z.number().nullable().default(null),
  windowHours: z.number().int().min(1).max(744).default(1),
  severity: z.enum(SEVERITIES).default("moderate"),
  action: z.enum(ACTIONS).default("notify"),
  actionTarget: z.string().nullable().default(null),
  enabled: z.boolean().default(true),
  cooldownMinutes: z.number().int().min(0).max(10_080).default(60),
});

/** Records a rule configuration change in the governance audit trail. */
async function audit(env: Env, actionTaken: string): Promise<void> {
  await getDb(env).insert(billingEvents).values({
    id: crypto.randomUUID(),
    service: "alert-rules",
    actionTaken,
    timestamp: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// GET /api/rules
// ---------------------------------------------------------------------------

rulesRouter.openapi(
  createRoute({
    method: "get",
    path: "/",
    operationId: "rulesList",
    summary: "List alert rules",
    responses: {
      200: {
        description: "Rules, newest first",
        content: { "application/json": { schema: z.object({ rules: z.array(ruleSchema) }) } },
      },
      401: unauthorized,
    },
  }),
  async (c) => {
    const rules = await getDb(c.env).select().from(alertRules).orderBy(desc(alertRules.createdAt));
    return c.json({ rules }, 200);
  },
);

// ---------------------------------------------------------------------------
// POST /api/rules/seed
// ---------------------------------------------------------------------------

rulesRouter.openapi(
  createRoute({
    method: "post",
    path: "/seed",
    operationId: "rulesSeed",
    summary: "Create starter rules from the probe registry's built-in thresholds",
    responses: {
      200: {
        description: "Seed result (no-op when rules already exist)",
        content: {
          "application/json": { schema: z.object({ created: z.number() }) },
        },
      },
      401: unauthorized,
    },
  }),
  async (c) => {
    const created = await seedDefaultRules(c.env);
    if (created > 0) await audit(c.env, `Seeded ${created} default alert rules`);
    return c.json({ created }, 200);
  },
);

// ---------------------------------------------------------------------------
// POST /api/rules  (create)
// ---------------------------------------------------------------------------

rulesRouter.openapi(
  createRoute({
    method: "post",
    path: "/",
    operationId: "rulesCreate",
    summary: "Create an alert rule (always created disarmed)",
    request: { body: { content: { "application/json": { schema: ruleInput } } } },
    responses: {
      200: { description: "Created rule", content: { "application/json": { schema: ruleSchema } } },
      401: unauthorized,
    },
  }),
  async (c) => {
    const input = c.req.valid("json");
    const now = Date.now();
    const [row] = await getDb(c.env)
      .insert(alertRules)
      .values({
        ...input,
        id: crypto.randomUUID(),
        // New rules never arrive armed — arming is a separate, deliberate act.
        armed: false,
        lastFiredAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await audit(c.env, `Created alert rule "${row.name}" on ${row.service}`);
    return c.json(row, 200);
  },
);

// ---------------------------------------------------------------------------
// PATCH /api/rules/{id}
// ---------------------------------------------------------------------------

rulesRouter.openapi(
  createRoute({
    method: "patch",
    path: "/{id}",
    operationId: "rulesUpdate",
    summary: "Update an alert rule (cannot arm — use /arm)",
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { "application/json": { schema: ruleInput.partial() } } },
    },
    responses: {
      200: { description: "Updated rule", content: { "application/json": { schema: ruleSchema } } },
      400: {
        description: "Rule not found",
        content: { "application/json": { schema: errorSchema } },
      },
      401: unauthorized,
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const patch = c.req.valid("json");
    const db = getDb(c.env);

    // Changing what a rule watches invalidates the review that armed it, so any
    // edit disarms it. Re-arming is an explicit second step.
    const [row] = await db
      .update(alertRules)
      .set({ ...patch, armed: false, updatedAt: Date.now() })
      .where(eq(alertRules.id, id))
      .returning();

    if (!row) return c.json({ error: "Rule not found." }, 400);
    await audit(c.env, `Updated alert rule "${row.name}" (disarmed pending review)`);
    return c.json(row, 200);
  },
);

// ---------------------------------------------------------------------------
// POST /api/rules/{id}/arm
// ---------------------------------------------------------------------------

rulesRouter.openapi(
  createRoute({
    method: "post",
    path: "/{id}/arm",
    operationId: "rulesArm",
    summary: "Arm or disarm a rule's automatic mitigation",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              armed: z.boolean(),
              /** Required only when arming: the rule's own name. */
              confirm: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: { description: "Updated rule", content: { "application/json": { schema: ruleSchema } } },
      400: {
        description: "Rule not found, unconfigured, or confirmation mismatch",
        content: { "application/json": { schema: errorSchema } },
      },
      401: unauthorized,
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const { armed, confirm } = c.req.valid("json");
    const db = getDb(c.env);

    const [rule] = await db.select().from(alertRules).where(eq(alertRules.id, id));
    if (!rule) return c.json({ error: "Rule not found." }, 400);

    if (armed) {
      // Arming grants this rule authority to change infrastructure with no human
      // in the loop, so it is confirm-gated and requires a complete rule.
      if (confirm !== rule.name) {
        return c.json(
          { error: `Confirmation must exactly match the rule name "${rule.name}".` },
          400,
        );
      }
      if (rule.threshold === null) {
        return c.json({ error: "Cannot arm a rule with no threshold." }, 400);
      }
      if (rule.action === "notify") {
        return c.json({ error: "A notify-only rule has no action to arm." }, 400);
      }
      if (rule.action !== "disable_topup" && !rule.actionTarget) {
        return c.json({ error: `Action "${rule.action}" requires an action target.` }, 400);
      }
    }

    const [row] = await db
      .update(alertRules)
      .set({ armed, updatedAt: Date.now() })
      .where(eq(alertRules.id, id))
      .returning();

    await audit(
      c.env,
      armed
        ? `ARMED alert rule "${row.name}" — it may now execute ${row.action} on ${row.actionTarget ?? "the account"} automatically`
        : `Disarmed alert rule "${row.name}"`,
    );
    return c.json(row, 200);
  },
);

// ---------------------------------------------------------------------------
// DELETE /api/rules/{id}
// ---------------------------------------------------------------------------

rulesRouter.openapi(
  createRoute({
    method: "delete",
    path: "/{id}",
    operationId: "rulesDelete",
    summary: "Delete an alert rule",
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description: "Deleted",
        content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
      },
      401: unauthorized,
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const [row] = await getDb(c.env).delete(alertRules).where(eq(alertRules.id, id)).returning();
    if (row) await audit(c.env, `Deleted alert rule "${row.name}"`);
    return c.json({ ok: true }, 200);
  },
);
