/**
 * @fileoverview Aggregate ai_router_requests by project (and by model within a
 * project) so high AI spend can be attributed to the project driving it.
 * Router-only — ai_router_requests is the sole table carrying a `project` dim.
 */
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { getDb } from "@/backend/db";
import { aiRouterRecommendations, aiRouterRequests } from "@/backend/db/schema";
import { getRecommendations, type ObservedModel } from "@/backend/guardian/model-recommendations";

export interface ProjectUsage {
  project: string; requests: number; tokensIn: number; tokensOut: number;
  costUsd: number; errors: number; breakers: number;
}
export interface ModelUsage {
  provider: string; model: string; requests: number;
  tokensIn: number; tokensOut: number; costUsd: number;
}

const n = (v: unknown) => Number(v ?? 0);

export async function usageByProject(env: Env, start: number, end: number): Promise<ProjectUsage[]> {
  const rows = await getDb(env)
    .select({
      project: aiRouterRequests.project,
      requests: sql<number>`count(*)`,
      tokensIn: sql<number>`sum(${aiRouterRequests.tokensIn})`,
      tokensOut: sql<number>`sum(${aiRouterRequests.tokensOut})`,
      costUsd: sql<number>`sum(${aiRouterRequests.costUsd})`,
      errors: sql<number>`sum(${aiRouterRequests.isError})`,
      breakers: sql<number>`sum(${aiRouterRequests.isCircuitBreaker})`,
    })
    .from(aiRouterRequests)
    .where(and(gte(aiRouterRequests.at, start), lte(aiRouterRequests.at, end)))
    .groupBy(aiRouterRequests.project)
    .orderBy(desc(sql`sum(${aiRouterRequests.costUsd})`))
    .limit(500);
  return rows.map((r) => ({
    project: r.project, requests: n(r.requests), tokensIn: n(r.tokensIn), tokensOut: n(r.tokensOut),
    costUsd: n(r.costUsd), errors: n(r.errors), breakers: n(r.breakers),
  }));
}

export async function usageByModelForProject(
  env: Env, project: string, start: number, end: number,
): Promise<ModelUsage[]> {
  const rows = await getDb(env)
    .select({
      provider: aiRouterRequests.provider,
      model: aiRouterRequests.model,
      requests: sql<number>`count(*)`,
      tokensIn: sql<number>`sum(${aiRouterRequests.tokensIn})`,
      tokensOut: sql<number>`sum(${aiRouterRequests.tokensOut})`,
      costUsd: sql<number>`sum(${aiRouterRequests.costUsd})`,
    })
    .from(aiRouterRequests)
    .where(and(eq(aiRouterRequests.project, project), gte(aiRouterRequests.at, start), lte(aiRouterRequests.at, end)))
    .groupBy(aiRouterRequests.provider, aiRouterRequests.model)
    .orderBy(desc(sql`sum(${aiRouterRequests.costUsd})`))
    .limit(200);
  return rows.map((r) => ({
    provider: r.provider, model: r.model, requests: n(r.requests),
    tokensIn: n(r.tokensIn), tokensOut: n(r.tokensOut), costUsd: n(r.costUsd),
  }));
}

/** Same grouping as {@link usageByModelForProject}, shaped for the model advisor. */
export async function observedForProject(
  env: Env, project: string, start: number, end: number,
): Promise<ObservedModel[]> {
  const rows = await getDb(env)
    .select({
      provider: aiRouterRequests.provider,
      model: aiRouterRequests.model,
      requests: sql<number>`count(*)`,
      tokensIn: sql<number>`sum(${aiRouterRequests.tokensIn})`,
      tokensOut: sql<number>`sum(${aiRouterRequests.tokensOut})`,
      costUsd: sql<number>`sum(${aiRouterRequests.costUsd})`,
    })
    .from(aiRouterRequests)
    .where(and(eq(aiRouterRequests.project, project), gte(aiRouterRequests.at, start), lte(aiRouterRequests.at, end)))
    .groupBy(aiRouterRequests.provider, aiRouterRequests.model)
    .orderBy(desc(sql`sum(${aiRouterRequests.costUsd})`))
    .limit(200);
  return rows.map((r) => ({
    provider: r.provider, model: r.model, requests: n(r.requests),
    tokensIn: n(r.tokensIn), tokensOut: n(r.tokensOut), costUsd: n(r.costUsd),
  }));
}

/**
 * Derive per-project model recommendations from AI Router usage and upsert
 * them into `ai_router_recommendations`. Tier-based only (no prompt
 * classification) — meant for a cheap periodic sync, not an on-demand deep
 * dive.
 *
 * @returns count of recommendation rows written
 */
export async function syncRouterRecommendations(env: Env, days = 30): Promise<number> {
  const end = Date.now();
  const start = end - days * 86_400_000;
  const projects = await usageByProject(env, start, end);
  const db = getDb(env);
  let written = 0;

  for (const p of projects) {
    const observed = await observedForProject(env, p.project, start, end);
    const report = await getRecommendations(env, { observed, days, minSavingsUsd: 1 });
    for (const rec of report.recommendations) {
      const id = `${p.project}:${rec.currentProvider}:${rec.currentModel}`;
      const at = Date.now();
      await db
        .insert(aiRouterRecommendations)
        .values({
          id,
          at,
          project: p.project,
          provider: rec.currentProvider,
          model: rec.currentModel,
          suggestedProvider: rec.suggestedProvider,
          suggestedModel: rec.suggestedModel,
          rationale: rec.rationale,
          estMonthlySavingsUsd: rec.monthlySavingsUsd,
          source: "local",
          status: "open",
        })
        .onConflictDoUpdate({
          target: aiRouterRecommendations.id,
          set: {
            at,
            suggestedProvider: rec.suggestedProvider,
            suggestedModel: rec.suggestedModel,
            rationale: rec.rationale,
            estMonthlySavingsUsd: rec.monthlySavingsUsd,
            status: "open",
          },
        });
      written++;
    }
  }
  return written;
}
