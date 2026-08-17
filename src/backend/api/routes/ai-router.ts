/**
 * @fileoverview AI Router HTTP surface. `/run` is the inference ingress
 * (authed by CLOUDFLARE_AI_GATEWAY_TOKEN). Management routes (Task 10) are
 * guardianAuth-gated.
 */
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { guardianAuth } from "@/backend/api/routes/guardian";
import { getDb } from "@/backend/db";
import { aiRouterRecommendations, aiRouterRequests, billingEvents, guardianProjects } from "@/backend/db/schema";
import { dispatchRightSizing } from "@/backend/guardian/offense/jules-dispatch";
import {
  breakGlass, deleteCircuit, evaluateBreakers, getKillSwitch, incrementSpend, listCircuits, setCircuit, setKillSwitch,
} from "@/backend/guardian/ai-router/circuits";
import { captureResult, storePrompt } from "@/backend/guardian/ai-router/capture";
import { forward } from "@/backend/guardian/ai-router/router";
import { forwardStream } from "@/backend/guardian/ai-router/router-stream";
import { isConcreteModel, resolveModel, type ResolveResult } from "@/backend/guardian/ai-router/resolve-model";
import { canPrice, priceSplit } from "@/backend/guardian/ai-router/pricing";
import { syncRouterRecommendations, usageByProject, usageByModelForProject } from "@/backend/guardian/ai-router-usage";
import { getSecretStoreBinding } from "@/backend/utils/secrets";
import type { RouterRequest } from "@/backend/guardian/ai-router/types";

export const aiRouterRouter = new OpenAPIHono<{ Bindings: Env }>();

const KNOWN = new Set(["project","importance","mode","provider","model","aiGatewayId","transport","stream","providerApiKey","input","repo","budgetUsd","capabilities"]);

/** owner/repo shape for the optional repo hint (path 2 project→repo population). */
const REPO_RE = /^[^/]+\/[^/]+$/;

const runBody = z.object({
  project: z.string().min(1),
  // Optional GitHub "owner/repo" hint. NOT strictly validated here — a malformed
  // value must never reject an inference call; it's shape-checked at write time
  // and simply skipped if bad (see the fill-if-empty upsert below).
  repo: z.string().optional(),
  importance: z.enum(["low", "medium", "high"]),
  mode: z.enum(["gateway","gateway-custom","provider-sdk-gateway","openai-compat","native","gemini-native"]).default("gateway"),
  provider: z.string().min(1),
  // P12: model is OPTIONAL. Absent (or a sentinel "auto"/"best"/"budget"/
  // "cheapest") ⇒ the resolver picks one; a concrete model still passes through
  // unchanged unless a model_substitutions rule retargets it.
  model: z.string().min(1).optional(),
  // Optional hints for dynamic selection (ignored on the passthrough path).
  budgetUsd: z.number().positive().optional(),
  capabilities: z.array(z.string()).optional(),
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
    const requestedModelRaw = raw.model; // pre-resolution, for the audit trail
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

    // P12 smart proxy: resolve the model to dispatch BEFORE any model-dependent
    // guard, so stream/bypass/pricing all run against what actually dispatches.
    //   - concrete model + no rule → unchanged (reason "passthrough"): a caller
    //     that named a model with no substitution gets IDENTICAL behavior to pre-P12.
    //   - concrete model + enabled rule → the rule's to_model ("substitution").
    //   - absent/sentinel model → best catalog pick ("dynamic").
    // Only the dynamic path (opt-in) can fail (empty catalog) → 400.
    let resolution: ResolveResult;
    try {
      resolution = await resolveModel(c.env, {
        project: raw.project,
        requestedModel: raw.model,
        importance: raw.importance,
        budgetUsd: raw.budgetUsd,
        capabilities: raw.capabilities,
      });
    } catch (err) {
      // Resolution only throws on the DYNAMIC path (no concrete model to fall
      // back to) — that request genuinely can't proceed, so 400. But a request
      // that named a CONCRETE model must NEVER 400 here: fall back to
      // dispatching exactly what was asked for (passthrough) so a resolver/D1
      // hiccup can't break a previously-working call.
      if (isConcreteModel(raw.model)) {
        console.warn(
          JSON.stringify({ level: "WARN", source: "aiRouter.resolveModel", project: raw.project, model: raw.model, error: String(err) }),
        );
        resolution = { model: raw.model!.trim(), provider: null, reason: "passthrough" };
      } else {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    }
    raw.model = resolution.model;
    // Only substitution/dynamic set a provider; passthrough leaves the caller's
    // provider byte-identical (resolution.provider is null there).
    if (resolution.provider) raw.provider = resolution.provider;
    // Re-apply the ':' guard to the RESOLVED model/provider — a catalog- or
    // rule-sourced value must satisfy the same scope-key invariant as caller input.
    for (const f of ["provider", "model"] as const) {
      if (String(raw[f] ?? "").includes(":")) {
        return c.json({ error: `resolved "${f}" must not contain ':'` }, 400);
      }
    }

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
    // Exclude the `__`-prefixed namespace: it is reserved for internal audit
    // keys set below, so a client can't forge e.g. `__requestedModel`.
    for (const [k, v] of Object.entries(raw)) if (!KNOWN.has(k) && !k.startsWith("__")) extra[k] = v;
    // Audit the resolution so a substituted/dynamic dispatch is traceable in the
    // stored request row (payloadJson). Passthrough is recorded too for symmetry.
    extra.__resolution = resolution.reason;
    if (resolution.reason !== "passthrough") extra.__requestedModel = requestedModelRaw ?? null;
    const req: RouterRequest = { ...raw, extra } as RouterRequest;
    const now = Date.now();
    const requestUuid = crypto.randomUUID();

    // Path 2: project→repo population from the AI payload. Fill-if-empty only —
    // an automated caller is a first-writer, so it seeds repo when unset but
    // never overwrites a value set by CF-builds sync or the frontend/API. Bad
    // shape is skipped, not rejected. Off the hot path via waitUntil.
    if (typeof raw.repo === "string" && REPO_RE.test(raw.repo)) {
      const repo = raw.repo;
      const project = raw.project;
      c.executionCtx.waitUntil(
        getDb(c.env)
          .insert(guardianProjects)
          .values({ name: project, kind: "ai_project", repo, lastSeen: now, createdAt: now })
          .onConflictDoUpdate({
            target: guardianProjects.name,
            set: { repo },
            setWhere: isNull(guardianProjects.repo),
          })
          .catch((e) => console.error("ai-router: repo fill-if-empty failed", e)),
      );
    }

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
  const rows = await getDb(c.env).select().from(aiRouterRecommendations).where(where).orderBy(desc(aiRouterRecommendations.at)).limit(500);
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

aiRouterRouter.openapi(createRoute({
  method: "post", path: "/recommendations/{id}/dispatch-jules", operationId: "aiRouterDispatchJules",
  summary: "Dispatch a router recommendation to Jules for a right-sizing PR",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "Dispatched", content: { "application/json": { schema: z.object({
      ok: z.boolean(), julesSessionId: z.string().nullable(), dispatchId: z.string().nullable() }) } } },
    404: { description: "Recommendation not found", content: { "application/json": { schema: z.object({ error: z.string() }) } } },
    409: { description: "No repo mapping for project", content: { "application/json": { schema: z.object({ error: z.string() }) } } },
    502: { description: "Jules dispatch failed", content: { "application/json": { schema: z.object({ error: z.string() }) } } },
  },
}), async (c) => {
  const { id } = c.req.valid("param");
  const db = getDb(c.env);

  const [rec] = await db.select().from(aiRouterRecommendations).where(eq(aiRouterRecommendations.id, id)).limit(1);
  if (!rec) return c.json({ error: "Recommendation not found." }, 404);

  if (rec.status !== "open") {
    return c.json({ error: "Recommendation is not open (already dispatched or resolved)." }, 409);
  }
  if (!rec.suggestedModel) {
    return c.json({ error: "Recommendation has no suggested model to switch to." }, 409);
  }

  const [proj] = await db.select({ repo: guardianProjects.repo }).from(guardianProjects).where(eq(guardianProjects.name, rec.project)).limit(1);
  if (!proj?.repo) return c.json({ error: "No repo mapping for project; advisory only." }, 409);

  const result = await dispatchRightSizing(c.env, {
    repo: proj.repo, project: rec.project, currentModel: rec.model,
    suggestedModel: rec.suggestedModel ?? "", rationale: rec.rationale,
  });
  if (!result.ok) return c.json({ error: result.error ?? "Jules dispatch failed." }, 502);

  await db.update(aiRouterRecommendations)
    .set({ status: "dispatched", julesSessionId: result.julesSessionId })
    .where(eq(aiRouterRecommendations.id, id));
  await audit(c.env, `Dispatched right-sizing to Jules for ${rec.project}/${rec.model} (session ${result.julesSessionId})`);
  return c.json({ ok: true, julesSessionId: result.julesSessionId, dispatchId: result.dispatchId }, 200);
});
