/**
 * @fileoverview AI Router HTTP surface. `/run` is the inference ingress
 * (authed by CLOUDFLARE_AI_GATEWAY_TOKEN). Management routes (Task 10) are
 * guardianAuth-gated.
 */
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, desc, eq, ne } from "drizzle-orm";
import { guardianAuth } from "@/backend/api/routes/guardian";
import { getDb } from "@/backend/db";
import { aiRouterRecommendations, aiRouterRequests, billingEvents } from "@/backend/db/schema";
import {
  breakGlass, deleteCircuit, evaluateBreakers, getKillSwitch, incrementSpend, listCircuits, setCircuit, setKillSwitch,
} from "@/backend/guardian/ai-router/circuits";
import { captureResult, storePrompt } from "@/backend/guardian/ai-router/capture";
import { forward } from "@/backend/guardian/ai-router/router";
import { forwardStream } from "@/backend/guardian/ai-router/router-stream";
import { canPrice, priceSplit } from "@/backend/guardian/ai-router/pricing";
import { syncRouterRecommendations, usageByProject, usageByModelForProject } from "@/backend/guardian/ai-router-usage";
import { getSecretStoreBinding } from "@/backend/utils/secrets";
import type { RouterRequest } from "@/backend/guardian/ai-router/types";

export const aiRouterRouter = new OpenAPIHono<{ Bindings: Env }>();

const KNOWN = new Set(["project","importance","mode","provider","model","aiGatewayId","transport","stream","providerApiKey","input"]);

const runBody = z.object({
  project: z.string().min(1),
  importance: z.enum(["low", "medium", "high"]),
  mode: z.enum(["gateway","gateway-custom","provider-sdk-gateway","openai-compat","native","gemini-native"]).default("gateway"),
  provider: z.string().min(1),
  model: z.string().min(1),
  aiGatewayId: z.string().optional(),
  transport: z.enum(["ai-sdk","provider-sdk","openai-compat","gemini-sdk"]).optional(),
  stream: z.boolean().default(false),
  providerApiKey: z.string().optional(),
  input: z.unknown(),
}).passthrough().refine(
  (b) => b.mode !== "gateway-custom" || !!b.aiGatewayId,
  { message: "aiGatewayId is required when mode is gateway-custom" },
);

// Ingress bearer check — the inference door, NOT guardianAuth.
aiRouterRouter.use("/run", async (c, next) => {
  const auth = c.req.header("Authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  // CLOUDFLARE_AI_GATEWAY_TOKEN is a Secret Store binding (async .get()).
  const expected = await getSecretStoreBinding(c.env, "CLOUDFLARE_AI_GATEWAY_TOKEN");
  if (!token || !expected || token !== expected) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
});

aiRouterRouter.openapi(
  createRoute({
    method: "post", path: "/run", operationId: "aiRouterRun",
    summary: "Route an AI call through AI Gateway (or a bypass mode), metered + breaker-gated",
    request: { body: { content: { "application/json": { schema: runBody } } } },
    responses: {
      200: { description: "Provider response", content: { "application/json": { schema: z.object({
        request_uuid: z.string(), status: z.number(), provider: z.string(), model: z.string(),
        mode: z.string(), gateway: z.string().nullable(),
        tokens_in: z.number(), tokens_out: z.number(), cost_usd: z.number(), body: z.unknown(),
      }) } } },
      400: { description: "Invalid field (e.g. ':' in project/provider/model)", content: { "application/json": { schema: z.object({ error: z.string() }) } } },
      401: { description: "Bad ingress token", content: { "application/json": { schema: z.object({ error: z.string() }) } } },
      422: { description: "Unpriceable model in sole-meter mode", content: { "application/json": { schema: z.object({ error: z.string() }) } } },
      429: { description: "Circuit breaker / kill switch", content: { "application/json": { schema: z.object({
        request_uuid: z.string(), isCircuitBreaker: z.literal(true), circuitBrokenMessage: z.string() }) } } },
    },
  }),
  async (c) => {
    const raw = c.req.valid("json");
    // Reject ':' in scope-forming fields so circuit KV scope keys can't collide
    // (e.g. project "a:b" vs scope prefixes like "project:"/"model:").
    for (const f of ["project", "provider", "model"] as const) {
      if (String((raw as Record<string, unknown>)[f] ?? "").includes(":")) {
        return c.json({ error: `"${f}" must not contain ':'` }, 400);
      }
    }
    // M2: validate aiGatewayId charset before it's ever used to build a URL.
    if (raw.aiGatewayId && !/^[a-zA-Z0-9_-]+$/.test(raw.aiGatewayId)) {
      return c.json({ error: "aiGatewayId must be [A-Za-z0-9_-]" }, 400);
    }
    // Normalize the Gemini alias so provider is canonical everywhere downstream
    // (providers.ts / extractUsage key on "google").
    if (raw.provider === "gemini") raw.provider = "google";

    // C1: streaming supports only provider "openai" in v1 — reject BEFORE
    // storePrompt so a rejected request never orphans a stored prompt.
    if (raw.stream && raw.provider !== "openai") {
      return c.json({ error: 'Streaming (stream:true) supports only provider "openai" in v1.' }, 400);
    }

    // C3: fail closed — sole-meter bypass modes (native, or google forced to
    // gemini-native) must be priceable by the catalog, else spend is unmetered.
    const bypass = raw.mode === "native" || raw.provider === "google";
    if (bypass && !(await canPrice(c.env, String(raw.model)))) {
      return c.json({ error: `Model "${raw.model}" is not priceable in the catalog; sole-meter modes (native/gemini-native) require a priceable model or a gateway mode.` }, 422);
    }

    const extra: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) if (!KNOWN.has(k)) extra[k] = v;
    const req: RouterRequest = { ...raw, extra } as RouterRequest;
    const now = Date.now();
    const requestUuid = crypto.randomUUID();

    await storePrompt(c.env, requestUuid, req.input);

    const verdict = await evaluateBreakers(c.env, req, now);
    if (!verdict.admitted) {
      const msg = verdict.message ?? "circuit breaker";
      try {
        await captureResult(c.env, { requestUuid, req, at: now, gateway: null, breakerMessage: msg });
      } catch (e) {
        console.error("ai-router: breaker captureResult failed", e);
      }
      return c.json({ request_uuid: requestUuid, isCircuitBreaker: true as const, circuitBrokenMessage: msg }, 429);
    }

    // Streaming path returns SSE; meter finalizes after the stream ends.
    if (req.stream) {
      try {
        const s = await forwardStream(c.env, req, now);
        c.executionCtx.waitUntil((async () => {
          try {
            const usage = await s.usagePromise;
            const priced = await priceSplit(c.env, req.model, usage);
            await captureResult(c.env, { requestUuid, req, at: now, priced: { ...usage, ...priced }, gateway: s.gateway });
            try {
              await incrementSpend(c.env, req, priced.costUsd, now);
            } catch (e) {
              console.error("ai-router: stream incrementSpend failed", e);
            }
          } catch (e) {
            console.error("ai-router: stream finalize failed", e);
          }
        })());
        return new Response(s.stream, { status: s.status, headers: { "Content-Type": "text/event-stream", "x-request-uuid": requestUuid } });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        try {
          await captureResult(c.env, { requestUuid, req, at: now, gateway: null, isError: true, errorMessage: message });
        } catch (e) {
          console.error("ai-router: error-path captureResult failed", e);
        }
        return c.json({ request_uuid: requestUuid, status: 502, provider: req.provider, model: req.model, mode: req.mode, gateway: null, tokens_in: 0, tokens_out: 0, cost_usd: 0, body: { error: message } }, 200);
      }
    }

    // Buffered path.
    try {
      const r = await forward(c.env, req, now);
      const priced = await priceSplit(c.env, req.model, r.usage);
      await captureResult(c.env, {
        requestUuid, req, at: now, gateway: r.gateway,
        priced: { ...r.usage, ...priced }, isError: r.status >= 400,
        errorMessage: r.status >= 400 ? `upstream ${r.status}` : undefined,
      });
      try {
        await incrementSpend(c.env, req, priced.costUsd, now);
      } catch (e) {
        console.error("ai-router: incrementSpend failed", e);
      }
      return c.json({
        request_uuid: requestUuid, status: r.status, provider: req.provider, model: req.model,
        mode: req.mode, gateway: r.gateway,
        tokens_in: r.usage.tokensIn, tokens_out: r.usage.tokensOut, cost_usd: priced.costUsd, body: r.body,
      }, 200);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        await captureResult(c.env, { requestUuid, req, at: now, gateway: null, isError: true, errorMessage: message });
      } catch (e) {
        console.error("ai-router: error-path captureResult failed", e);
      }
      return c.json({ request_uuid: requestUuid, status: 502, provider: req.provider, model: req.model,
        mode: req.mode, gateway: null, tokens_in: 0, tokens_out: 0, cost_usd: 0, body: { error: message } }, 200);
    }
  },
);

// ---------------------------------------------------------------------------
// Management routes (Task 10) — circuits CRUD, kill switch, break-glass,
// recent requests. All guardianAuth-gated (admin), separate from /run.
// ---------------------------------------------------------------------------

const circuitSchema = z.object({
  budgetUsd: z.number().positive(),
  window: z.enum(["day", "week", "month", "total"]).default("month"),
  enabled: z.boolean().default(true),
});

async function audit(env: Env, actionTaken: string) {
  await getDb(env).insert(billingEvents).values({
    id: crypto.randomUUID(), service: "ai-router", actionTaken, timestamp: Date.now(),
  });
}

// All management routes require guardianAuth (admin), separate from /run.
aiRouterRouter.use("/circuits", guardianAuth);
aiRouterRouter.use("/circuits/*", guardianAuth);
aiRouterRouter.use("/kill-switch", guardianAuth);
aiRouterRouter.use("/requests", guardianAuth);
aiRouterRouter.use("/usage", guardianAuth);
aiRouterRouter.use("/usage/*", guardianAuth);

aiRouterRouter.openapi(createRoute({
  method: "get", path: "/circuits", operationId: "aiRouterListCircuits",
  summary: "List circuit breakers + current spend",
  responses: { 200: { description: "Circuits", content: { "application/json": { schema: z.object({
    killSwitch: z.boolean(),
    circuits: z.array(z.object({ scope: z.string(), circuit: z.object({
      budgetUsd: z.number(), window: z.string(), enabled: z.boolean(), breakGlassUntil: z.number().optional() }),
      spent: z.number() })) }) } } } },
}), async (c) => c.json({ killSwitch: await getKillSwitch(c.env), circuits: await listCircuits(c.env) }, 200));

aiRouterRouter.openapi(createRoute({
  method: "put", path: "/circuits/{scope}", operationId: "aiRouterSetCircuit",
  summary: "Create/update a circuit breaker (scope: global | provider:X | model:X/Y | project:Z)",
  request: { params: z.object({ scope: z.string() }), body: { content: { "application/json": { schema: circuitSchema } } } },
  responses: { 200: { description: "Saved", content: { "application/json": { schema: z.object({ ok: z.boolean() }) } } } },
}), async (c) => {
  const { scope } = c.req.valid("param"); const body = c.req.valid("json");
  await setCircuit(c.env, scope, body);
  await audit(c.env, `Set circuit ${scope}: $${body.budgetUsd}/${body.window} enabled=${body.enabled}`);
  return c.json({ ok: true }, 200);
});

aiRouterRouter.openapi(createRoute({
  method: "delete", path: "/circuits/{scope}", operationId: "aiRouterDeleteCircuit",
  summary: "Delete a circuit breaker",
  request: { params: z.object({ scope: z.string() }) },
  responses: { 200: { description: "Deleted", content: { "application/json": { schema: z.object({ ok: z.boolean() }) } } } },
}), async (c) => {
  const { scope } = c.req.valid("param"); await deleteCircuit(c.env, scope);
  await audit(c.env, `Deleted circuit ${scope}`); return c.json({ ok: true }, 200);
});

aiRouterRouter.openapi(createRoute({
  method: "post", path: "/circuits/{scope}/break-glass", operationId: "aiRouterBreakGlass",
  summary: "Temporarily bypass a circuit for N hours",
  request: { params: z.object({ scope: z.string() }), body: { content: { "application/json": { schema: z.object({ hours: z.number().positive().max(168) }) } } } },
  responses: { 200: { description: "Break-glass set", content: { "application/json": { schema: z.object({ ok: z.boolean() }) } } } },
}), async (c) => {
  const { scope } = c.req.valid("param"); const { hours } = c.req.valid("json");
  await breakGlass(c.env, scope, hours, Date.now());
  await audit(c.env, `Break-glass ${scope} for ${hours}h`); return c.json({ ok: true }, 200);
});

aiRouterRouter.openapi(createRoute({
  method: "post", path: "/kill-switch", operationId: "aiRouterKillSwitch",
  summary: "Toggle the global kill switch (rejects ALL AI). Turning OFF is confirm-gated.",
  request: { body: { content: { "application/json": { schema: z.object({ on: z.boolean(), confirm: z.string().optional() }) } } } },
  responses: {
    200: { description: "Toggled", content: { "application/json": { schema: z.object({ killSwitch: z.boolean() }) } } },
    400: { description: "Confirmation required to turn OFF", content: { "application/json": { schema: z.object({ error: z.string() }) } } },
  },
}), async (c) => {
  const { on, confirm } = c.req.valid("json");
  // Turning the kill switch OFF re-opens spend, so it is confirm-gated.
  if (!on && confirm !== "disable kill switch") return c.json({ error: 'Confirmation must be "disable kill switch".' }, 400);
  await setKillSwitch(c.env, on);
  await audit(c.env, `Kill switch ${on ? "ENABLED (all AI blocked)" : "disabled"}`);
  return c.json({ killSwitch: on }, 200);
});

aiRouterRouter.openapi(createRoute({
  method: "get", path: "/requests", operationId: "aiRouterRequests",
  summary: "Recent AI Router requests (newest first)",
  request: { query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50).optional() }) },
  responses: { 200: { description: "Rows", content: { "application/json": { schema: z.object({ requests: z.array(z.any()) }) } } } },
}), async (c) => {
  const limit = c.req.valid("query").limit ?? 50;
  const rows = await getDb(c.env).select().from(aiRouterRequests).orderBy(desc(aiRouterRequests.at)).limit(limit);
  return c.json({ requests: rows }, 200);
});

// ---------------------------------------------------------------------------
// Usage-by-project routes — reads only, no billing_events audit.
// ---------------------------------------------------------------------------

const projectUsageSchema = z.object({
  project: z.string(), requests: z.number(), tokensIn: z.number(), tokensOut: z.number(),
  costUsd: z.number(), errors: z.number(), breakers: z.number(),
});
const modelUsageSchema = z.object({
  provider: z.string(), model: z.string(), requests: z.number(),
  tokensIn: z.number(), tokensOut: z.number(), costUsd: z.number(),
});

aiRouterRouter.openapi(createRoute({
  method: "get", path: "/usage", operationId: "aiRouterUsageByProject",
  summary: "Router usage aggregated per project over a date range",
  request: { query: z.object({ start: z.coerce.number().optional(), end: z.coerce.number().optional() }) },
  responses: { 200: { description: "Per-project usage", content: { "application/json": { schema: z.object({ projects: z.array(projectUsageSchema) }) } } } },
}), async (c) => {
  const { start, end } = c.req.valid("query");
  const e = end ?? Date.now();
  const s = start ?? e - 30 * 86_400_000;
  return c.json({ projects: await usageByProject(c.env, s, e) }, 200);
});

aiRouterRouter.openapi(createRoute({
  method: "get", path: "/usage/{project}", operationId: "aiRouterUsageByModel",
  summary: "A project's router usage broken down by provider/model",
  request: { params: z.object({ project: z.string() }), query: z.object({ start: z.coerce.number().optional(), end: z.coerce.number().optional() }) },
  responses: { 200: { description: "Per-model usage for the project", content: { "application/json": { schema: z.object({ models: z.array(modelUsageSchema) }) } } } },
}), async (c) => {
  const { project } = c.req.valid("param");
  const { start, end } = c.req.valid("query");
  const e = end ?? Date.now();
  const s = start ?? e - 30 * 86_400_000;
  return c.json({ models: await usageByModelForProject(c.env, project, s, e) }, 200);
});

// ---------------------------------------------------------------------------
// Recommendations routes — cheaper-model suggestions (Task 4). guardianAuth-gated.
// ---------------------------------------------------------------------------

aiRouterRouter.use("/recommendations", guardianAuth);
aiRouterRouter.use("/recommendations/*", guardianAuth);

aiRouterRouter.openapi(createRoute({
  method: "get", path: "/recommendations", operationId: "aiRouterListRecommendations",
  summary: "List open router recommendations (newest first), optionally filtered by project",
  request: { query: z.object({ project: z.string().optional() }) },
  responses: { 200: { description: "Recommendations", content: { "application/json": { schema: z.object({ recommendations: z.array(z.any()) }) } } } },
}), async (c) => {
  const { project } = c.req.valid("query");
  const where = project
    ? and(ne(aiRouterRecommendations.status, "dismissed"), eq(aiRouterRecommendations.project, project))
    : ne(aiRouterRecommendations.status, "dismissed");
  const rows = await getDb(c.env).select().from(aiRouterRecommendations).where(where).orderBy(desc(aiRouterRecommendations.at));
  return c.json({ recommendations: rows }, 200);
});

aiRouterRouter.openapi(createRoute({
  method: "post", path: "/recommendations/refresh", operationId: "aiRouterRefreshRecommendations",
  summary: "Recompute router recommendations now (manual stand-in for the deferred weekly cron)",
  responses: { 200: { description: "Refreshed", content: { "application/json": { schema: z.object({ written: z.number() }) } } } },
}), async (c) => {
  const written = await syncRouterRecommendations(c.env);
  await audit(c.env, `Refreshed router recommendations: ${written} written`);
  return c.json({ written }, 200);
});

aiRouterRouter.openapi(createRoute({
  method: "post", path: "/recommendations/{id}/dismiss", operationId: "aiRouterDismissRecommendation",
  summary: "Dismiss a router recommendation",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: { description: "Dismissed", content: { "application/json": { schema: z.object({ ok: z.boolean() }) } } } },
}), async (c) => {
  const { id } = c.req.valid("param");
  await getDb(c.env).update(aiRouterRecommendations).set({ status: "dismissed" }).where(eq(aiRouterRecommendations.id, id));
  await audit(c.env, `Dismissed recommendation ${id}`);
  return c.json({ ok: true }, 200);
});
