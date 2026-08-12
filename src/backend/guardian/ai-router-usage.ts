/**
 * @fileoverview Aggregate ai_router_requests by project (and by model within a
 * project) so high AI spend can be attributed to the project driving it.
 * Router-only — ai_router_requests is the sole table carrying a `project` dim.
 */
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { getDb } from "@/backend/db";
import { aiRouterRequests } from "@/backend/db/schema";

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
