/**
 * @fileoverview AI Router capture: prompt → PROMPTS KV, per-request row → D1
 * ai_router_requests, and a feed into the existing ai_gateway_costs roll-up so
 * current cost/drift/usage queries include router traffic.
 */
import { getDb } from "@/backend/db";
import { aiRouterRequests } from "@/backend/db/schema";
import { registerDirectUsage } from "@/backend/guardian/register-usage";
import type { PricedUsage, RouterRequest } from "./types";

export async function storePrompt(env: Env, requestUuid: string, input: unknown): Promise<void> {
  await env.PROMPTS.put(`prompt:${requestUuid}`, JSON.stringify(input ?? null));
}

export interface CaptureArgs {
  requestUuid: string;
  req: RouterRequest;
  at: number;
  priced?: PricedUsage;
  gateway: string | null;
  isError?: boolean;
  errorMessage?: string;
  breakerMessage?: string; // set → isCircuitBreaker row, no provider call happened
}

export async function captureResult(env: Env, a: CaptureArgs): Promise<{ costRowId: string | null }> {
  const priced = a.priced ?? { tokensIn: 0, tokensOut: 0, tokensInCost: 0, tokensOutCost: 0, costUsd: 0 };
  let costRowId: string | null = null;

  // Feed the existing roll-up only for real (non-breaker) calls with cost/tokens.
  if (!a.breakerMessage) {
    const reg = await registerDirectUsage(env, {
      worker: a.req.project,
      provider: a.req.provider,
      model: a.req.model,
      tokensIn: priced.tokensIn,
      tokensOut: priced.tokensOut,
      costUsd: priced.costUsd,
      gateway: a.gateway ?? (a.req.mode === "gemini-native" ? "router-gemini" : "router-native"),
      at: a.at,
      taskDescription: `ai-router:${a.req.mode}:${a.req.importance}`,
    });
    costRowId = reg.id;
  }

  await getDb(env).insert(aiRouterRequests).values({
    id: a.requestUuid,
    at: a.at,
    project: a.req.project,
    importance: a.req.importance,
    provider: a.req.provider,
    model: a.req.model,
    mode: a.req.mode,
    gateway: a.gateway,
    tokensIn: priced.tokensIn,
    tokensOut: priced.tokensOut,
    tokensInCost: priced.tokensInCost,
    tokensOutCost: priced.tokensOutCost,
    costUsd: priced.costUsd,
    isError: a.isError ?? false,
    errorMessage: a.errorMessage ?? null,
    isCircuitBreaker: Boolean(a.breakerMessage),
    circuitBrokenMessage: a.breakerMessage ?? null,
    costRowId,
    payloadJson: Object.keys(a.req.extra).length ? JSON.stringify(a.req.extra) : null,
    createdAt: Date.now(),
  });

  return { costRowId };
}
