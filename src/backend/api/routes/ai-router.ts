/**
 * @fileoverview AI Router HTTP surface. `/run` is the inference ingress
 * (authed by CLOUDFLARE_AI_GATEWAY_TOKEN). Management routes (Task 10) are
 * guardianAuth-gated.
 */
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { evaluateBreakers, incrementSpend } from "@/backend/guardian/ai-router/circuits";
import { captureResult, storePrompt } from "@/backend/guardian/ai-router/capture";
import { forward } from "@/backend/guardian/ai-router/router";
import { forwardStream } from "@/backend/guardian/ai-router/router-stream";
import { priceSplit } from "@/backend/guardian/ai-router/pricing";
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
    // Normalize the Gemini alias so provider is canonical everywhere downstream
    // (providers.ts / extractUsage key on "google").
    if (raw.provider === "gemini") raw.provider = "google";
    const extra: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) if (!KNOWN.has(k)) extra[k] = v;
    const req: RouterRequest = { ...raw, extra } as RouterRequest;
    const now = Date.now();
    const requestUuid = crypto.randomUUID();

    await storePrompt(c.env, requestUuid, req.input);

    const verdict = await evaluateBreakers(c.env, req, now);
    if (!verdict.admitted) {
      const msg = verdict.message ?? "circuit breaker";
      await captureResult(c.env, { requestUuid, req, at: now, gateway: null, breakerMessage: msg });
      return c.json({ request_uuid: requestUuid, isCircuitBreaker: true as const, circuitBrokenMessage: msg }, 429);
    }

    // Streaming path returns SSE; meter finalizes after the stream ends.
    if (req.stream) {
      const s = await forwardStream(c.env, req, now);
      c.executionCtx.waitUntil((async () => {
        const usage = await s.usagePromise;
        const priced = await priceSplit(c.env, req.model, usage);
        await captureResult(c.env, { requestUuid, req, at: now, priced: { ...usage, ...priced }, gateway: s.gateway });
        await incrementSpend(c.env, req, priced.costUsd, now);
      })());
      return new Response(s.stream, { status: s.status, headers: { "Content-Type": "text/event-stream", "x-request-uuid": requestUuid } });
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
      await incrementSpend(c.env, req, priced.costUsd, now);
      return c.json({
        request_uuid: requestUuid, status: r.status, provider: req.provider, model: req.model,
        mode: req.mode, gateway: r.gateway,
        tokens_in: r.usage.tokensIn, tokens_out: r.usage.tokensOut, cost_usd: priced.costUsd, body: r.body,
      }, 200);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await captureResult(c.env, { requestUuid, req, at: now, gateway: null, isError: true, errorMessage: message });
      return c.json({ request_uuid: requestUuid, status: 502, provider: req.provider, model: req.model,
        mode: req.mode, gateway: null, tokens_in: 0, tokens_out: 0, cost_usd: 0, body: { error: message } }, 200);
    }
  },
);
