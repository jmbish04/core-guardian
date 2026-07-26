/**
 * @fileoverview Manual registration of AI usage that never touched an AI Gateway.
 *
 * Some provider APIs aren't proxyable through Cloudflare AI Gateway or Workers
 * AI (e.g. the Gemini interactions API), so their calls go straight to the
 * provider and leave no trace in the GraphQL analytics the daily snapshot reads.
 * This writer lets a caller (MCP tool or REST POST) register that usage by hand
 * so it lands in the SAME `ai_gateway_costs` table the gateway snapshot feeds —
 * meaning drift checks, cost queries, and pricing history all see it for free.
 *
 * Rows are tagged with a synthetic gateway (default `direct`) so they never
 * collide with real gateway snapshot rows, and repeated registrations for the
 * same day/provider/model ACCUMULATE (add) rather than replace — each POST
 * reports a fresh batch of usage.
 *
 * When `costUsd` is omitted it's priced from the scraped provider catalog
 * (same source as {@link calculateCosts}); if the model isn't in the catalog the
 * cost is recorded as 0 and `priced: "unmatched"` is returned so the caller
 * knows to pass an explicit cost.
 *
 * @see {@link file://src/backend/db/schemas/governance/ai-gateway-costs.ts}
 */

import { and, desc, eq, sql } from "drizzle-orm";

import { getDb } from "@/backend/db";
import {
  aiGatewayCosts,
  aiUsageRegistrations,
  type AiUsageRegistrationRow,
  billingEvents,
} from "@/backend/db/schema";
import { calculateCosts } from "@/backend/guardian/ai-model-advisor";

export type RegisterUsageInput = {
  /** Originating worker or application — where the usage came from (required, for tracing). */
  worker: string;
  provider: string;
  model: string;
  tokensIn?: number;
  tokensOut?: number;
  /**
   * Reasoning/thinking tokens (incl. Gemini interim thought images). Billed at
   * the output rate — priced as output and folded into tokensOut in the
   * ai_gateway_costs roll-up; kept broken out in the trace log.
   */
  tokensThinking?: number;
  requests?: number;
  /** Explicit USD cost. Omit to price from the scraped catalog. */
  costUsd?: number;
  /** Synthetic gateway tag. Default "direct". */
  gateway?: string;
  /** Unix ms the usage occurred. Default now — set to backfill a past day. */
  at?: number;
  /** Optional caller operation/request id for correlation. */
  operationId?: string;
  /** Optional human description of what the usage was for. */
  taskDescription?: string;
};

export type RegisterUsageResult = {
  /** The append-only trace-log registration id. */
  registrationId: string;
  /** The ai_gateway_costs roll-up row id this batch accumulated into. */
  id: string;
  day: string;
  worker: string;
  gateway: string;
  provider: string;
  model: string;
  requests: number;
  costUsd: number;
  tokensIn: number;
  /** Output tokens as the roll-up stores them: caller output + thinking. */
  tokensOut: number;
  /** Thinking tokens broken out (already included in tokensOut). */
  tokensThinking: number;
  /** "explicit" (cost given), "scraped" (priced from catalog), or "unmatched". */
  priced: "explicit" | "scraped" | "unmatched";
};

/**
 * Read the append-only registration trace, newest first, optionally filtered
 * by originating worker, provider, or model — for tracing where usage came from.
 */
export async function listUsageRegistrations(
  env: Env,
  filter: { worker?: string; provider?: string; model?: string; limit?: number } = {},
): Promise<AiUsageRegistrationRow[]> {
  const conds = [
    filter.worker ? eq(aiUsageRegistrations.worker, filter.worker) : undefined,
    filter.provider ? eq(aiUsageRegistrations.provider, filter.provider) : undefined,
    filter.model ? eq(aiUsageRegistrations.model, filter.model) : undefined,
  ].filter(Boolean);
  const where = conds.length ? and(...conds) : undefined;
  return getDb(env)
    .select()
    .from(aiUsageRegistrations)
    .where(where)
    .orderBy(desc(aiUsageRegistrations.at))
    .limit(filter.limit ?? 100);
}

function dayBucket(at: number): { day: string; dayStart: number } {
  const d = new Date(at);
  const day = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  return { day, dayStart: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) };
}

/**
 * Register a batch of direct-to-provider AI usage into `ai_gateway_costs`.
 * Accumulates onto any existing row for the same (day, gateway, provider, model).
 */
export async function registerDirectUsage(
  env: Env,
  input: RegisterUsageInput,
): Promise<RegisterUsageResult> {
  const at = input.at ?? Date.now();
  const gateway = input.gateway?.trim() || "direct";
  const requests = input.requests ?? 1;
  const tokensIn = input.tokensIn ?? 0;
  const tokensOutRaw = input.tokensOut ?? 0;
  const tokensThinking = input.tokensThinking ?? 0;
  // Thinking tokens bill at the output rate, so the roll-up's output side is
  // caller output + thinking (matches how the gateway lumps them). The trace
  // log keeps the raw split.
  const tokensOut = tokensOutRaw + tokensThinking;
  const { day, dayStart } = dayBucket(at);

  let costUsd = input.costUsd;
  let priced: RegisterUsageResult["priced"] = "explicit";
  if (costUsd === undefined) {
    const { lines } = await calculateCosts(env, [
      { provider: input.provider, model: input.model, inputTokens: tokensIn, outputTokens: tokensOut, at },
    ]);
    costUsd = lines[0].costUsd ?? 0;
    priced = lines[0].matched ? "scraped" : "unmatched";
  }

  const id = `${day}:${gateway}:${input.provider}:${input.model}`;
  const now = Date.now();

  const [row] = await getDb(env)
    .insert(aiGatewayCosts)
    .values({
      id,
      day,
      dayStart,
      gateway,
      provider: input.provider,
      model: input.model,
      requests,
      costUsd,
      tokensIn,
      tokensOut,
      capturedAt: now,
    })
    .onConflictDoUpdate({
      target: aiGatewayCosts.id,
      set: {
        // Accumulate — each registration is a new batch of usage.
        requests: sql`${aiGatewayCosts.requests} + ${requests}`,
        costUsd: sql`${aiGatewayCosts.costUsd} + ${costUsd}`,
        tokensIn: sql`${aiGatewayCosts.tokensIn} + ${tokensIn}`,
        tokensOut: sql`${aiGatewayCosts.tokensOut} + ${tokensOut}`,
        capturedAt: now,
      },
    })
    .returning();

  // Append-only trace row — carries the per-call context the aggregate can't.
  const registrationId = crypto.randomUUID();
  await getDb(env)
    .insert(aiUsageRegistrations)
    .values({
      id: registrationId,
      worker: input.worker,
      operationId: input.operationId ?? null,
      taskDescription: input.taskDescription ?? null,
      gateway,
      provider: input.provider,
      model: input.model,
      requests,
      costUsd,
      tokensIn,
      tokensOut: tokensOutRaw,
      tokensThinking,
      priced,
      costRowId: id,
      at,
      createdAt: now,
    });

  await getDb(env)
    .insert(billingEvents)
    .values({
      id: crypto.randomUUID(),
      service: "ai-usage",
      actionTaken: `Registered direct usage from ${input.worker}: ${gateway}/${input.provider}/${input.model} +${requests}req $${costUsd.toFixed(6)} (${priced})`,
      timestamp: now,
    });

  return {
    registrationId,
    id: row.id,
    day: row.day,
    worker: input.worker,
    gateway: row.gateway,
    provider: row.provider,
    model: row.model,
    requests: row.requests,
    costUsd: row.costUsd,
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
    tokensThinking,
    priced,
  };
}
