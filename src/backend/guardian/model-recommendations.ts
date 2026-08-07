/**
 * @fileoverview Proactive model-cost advisor.
 *
 * The existing {@link ./ai-model-advisor} answers "given THIS use case, what's
 * the cheapest capable model?" — a human supplies the use case. This module runs
 * the other direction: it looks at what Guardian OBSERVED the account actually
 * running (per-model requests + tokens + cost, from AI Gateway and the Worker's
 * own usage registrations) and asks, per model, "is there a model that is at
 * least as capable but cheaper for this exact workload?"
 *
 * Capability is gated by the coarse tier on each {@link ./model-catalog}
 * candidate: a recommendation only ever swaps to an equal-or-higher tier, so it
 * can lower cost but never quietly lower capability. Savings are the observed
 * monthly spend minus the same token volume priced at the candidate's rates.
 *
 * `classifyPrompts` (opt-in) adds a second read: it samples the task
 * descriptions the account logged per model and asks Workers AI for the *minimum*
 * tier each workload actually needs, which can unlock a cheaper small/mid model
 * the blunt tier floor would have blocked. It costs one inference call and reads
 * task descriptions the caller already stored — raw provider prompts are never read.
 */

import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";

import { getDb } from "@/backend/db";
import { aiUsageRegistrations } from "@/backend/db/schema";

import { queryGatewayCosts } from "./ai-gateway-costs";
import {
  type CapabilityTier,
  type CatalogModel,
  classifyTier,
  getModelCatalog,
  isChatModel,
  TIER_RANK,
} from "./model-catalog";

const DAY_MS = 86_400_000;
const ADVISOR_MODEL = "@cf/moonshotai/kimi-k2.7-code";

/** One model's observed workload over the window. */
type ObservedModel = {
  provider: string;
  model: string;
  requests: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
};

export type ModelRecommendation = {
  /** Stable id for deep-linking a single rec (widget → full page). */
  id: string;
  currentModel: string;
  currentProvider: string;
  currentTier: CapabilityTier;
  observedRequests: number;
  avgInTokens: number;
  avgOutTokens: number;
  observedMonthlyUsd: number;
  suggestedModel: string;
  suggestedProvider: string;
  suggestedTier: CapabilityTier;
  suggestedMonthlyUsd: number;
  monthlySavingsUsd: number;
  savingsPct: number;
  rationale: string;
  basis: "tier" | "prompt-classified";
};

/** Normalize a model name/id for fuzzy matching across sources. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/^@cf\//, "")
    .replace(/^[a-z0-9-]+\//, "") // strip provider/ prefix
    .replace(/[^a-z0-9]/g, "");
}

/** Monthly cost of a token volume at a candidate's per-1M rates. */
function monthlyCost(c: CatalogModel, inTok: number, outTok: number): number | null {
  if (c.inPerM === null && c.outPerM === null) return null;
  return (inTok / 1_000_000) * (c.inPerM ?? 0) + (outTok / 1_000_000) * (c.outPerM ?? 0);
}

/** Aggregate observed per-model usage from gateway costs + usage registrations. */
async function observedUsage(env: Env, days: number): Promise<ObservedModel[]> {
  const since = Date.now() - days * DAY_MS;
  const by = new Map<string, ObservedModel>();
  const add = (provider: string, model: string, u: Partial<ObservedModel>) => {
    const key = norm(model);
    const cur = by.get(key) ?? { provider, model, requests: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 };
    cur.requests += u.requests ?? 0;
    cur.tokensIn += u.tokensIn ?? 0;
    cur.tokensOut += u.tokensOut ?? 0;
    cur.costUsd += u.costUsd ?? 0;
    by.set(key, cur);
  };

  try {
    for (const g of await queryGatewayCosts(env, since, Date.now())) {
      add(g.provider, g.model, {
        requests: g.requests,
        tokensIn: g.tokensIn,
        tokensOut: g.tokensOut,
        costUsd: g.costUsd,
      });
    }
  } catch {
    /* gateway data optional */
  }

  const regs = await getDb(env)
    .select({
      provider: aiUsageRegistrations.provider,
      model: aiUsageRegistrations.model,
      requests: sql<number>`sum(${aiUsageRegistrations.requests})`,
      tokensIn: sql<number>`sum(${aiUsageRegistrations.tokensIn})`,
      tokensOut: sql<number>`sum(${aiUsageRegistrations.tokensOut})`,
      costUsd: sql<number>`sum(${aiUsageRegistrations.costUsd})`,
    })
    .from(aiUsageRegistrations)
    .where(gte(aiUsageRegistrations.at, since))
    .groupBy(aiUsageRegistrations.provider, aiUsageRegistrations.model);
  for (const r of regs)
    add(r.provider, r.model, {
      requests: r.requests ?? 0,
      tokensIn: r.tokensIn ?? 0,
      tokensOut: r.tokensOut ?? 0,
      costUsd: r.costUsd ?? 0,
    });

  return [...by.values()].filter((m) => m.requests > 0 || m.costUsd > 0);
}

/** Find the catalog entry that best matches an observed model. */
function matchCatalog(model: string, catalog: CatalogModel[]): CatalogModel | undefined {
  const n = norm(model);
  return (
    catalog.find((c) => norm(c.id) === n || norm(c.name) === n) ??
    catalog.find((c) => norm(c.id).includes(n) || n.includes(norm(c.id)))
  );
}

/**
 * Opt-in: sample stored task descriptions per model and ask Workers AI for the
 * minimum capability tier each model's workload actually needs. Returns a map
 * of normalized-model → floor tier. One inference call, best-effort.
 */
async function classifyMinTiers(
  env: Env,
  models: ObservedModel[],
): Promise<Map<string, CapabilityTier>> {
  const out = new Map<string, CapabilityTier>();
  const db = getDb(env);
  const samples: { model: string; tasks: string[] }[] = [];
  for (const m of models.slice(0, 8)) {
    const rows = await db
      .select({ task: aiUsageRegistrations.taskDescription })
      .from(aiUsageRegistrations)
      .where(
        and(
          eq(aiUsageRegistrations.model, m.model),
          isNotNull(aiUsageRegistrations.taskDescription),
        ),
      )
      .orderBy(desc(aiUsageRegistrations.at))
      .limit(5);
    const tasks = rows.map((r) => r.task).filter((t): t is string => Boolean(t));
    if (tasks.length) samples.push({ model: m.model, tasks });
  }
  if (!samples.length) return out;

  const prompt = `For each model below, given sample task descriptions it was used for, return the MINIMUM capability tier that can reliably do those tasks. Tiers: "small" (simple extraction/classification/formatting), "mid" (general reasoning, coding, summarization), "frontier" (hard multi-step reasoning, complex code, nuanced judgment). Return ONLY JSON: {"tiers":[{"model":string,"tier":"small"|"mid"|"frontier"}]}.

${JSON.stringify(samples).slice(0, 8000)}`;
  try {
    const res: any = await env.AI.run(ADVISOR_MODEL, {
      messages: [{ role: "user", content: prompt }],
      max_tokens: 2000,
    });
    const raw =
      res?.response ?? res?.result?.response ?? res?.choices?.[0]?.message?.content ?? "";
    const match = String(raw).match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]) as { tiers?: { model: string; tier: CapabilityTier }[] };
      for (const t of parsed.tiers ?? []) {
        if (t?.model && (t.tier === "small" || t.tier === "mid" || t.tier === "frontier"))
          out.set(norm(t.model), t.tier);
      }
    }
  } catch {
    /* classification is advisory; fall back to the blunt tier floor */
  }
  return out;
}

export type RecommendationReport = {
  days: number;
  classified: boolean;
  catalogSize: number;
  totalMonthlySavingsUsd: number;
  recommendations: ModelRecommendation[];
};

/**
 * Compute cheaper-but-capable model swaps for the account's observed usage.
 *
 * @param days - trailing observation window (default 30)
 * @param classifyPrompts - opt-in: refine the capability floor per model from
 *   its sampled task descriptions (one Workers AI call)
 * @param minSavingsUsd - drop recommendations under this monthly saving
 */
export async function getRecommendations(
  env: Env,
  {
    days = 30,
    classifyPrompts = false,
    minSavingsUsd = 0.01,
  }: { days?: number; classifyPrompts?: boolean; minSavingsUsd?: number } = {},
): Promise<RecommendationReport> {
  const [observed, catalog] = await Promise.all([observedUsage(env, days), getModelCatalog(env)]);
  const scale = 30 / days; // observed-window → monthly

  const minTiers = classifyPrompts ? await classifyMinTiers(env, observed) : new Map();

  const recommendations: ModelRecommendation[] = [];
  for (const o of observed) {
    if (o.requests <= 0) continue;
    // Only advise on chat/completion models — an embedding or speech model has
    // no chat-model equivalent to swap to.
    if (!isChatModel(o.model)) continue;
    const incumbent = matchCatalog(o.model, catalog);
    const incumbentTier = incumbent?.tier ?? classifyTier(o.model);
    // The capability floor a candidate must clear. Prompt classification can
    // lower it below the incumbent's own tier when the tasks are simple.
    const floorTier: CapabilityTier = minTiers.get(norm(o.model)) ?? incumbentTier;
    const floorRank = TIER_RANK[floorTier];

    const observedMonthlyUsd = o.costUsd * scale;
    const monthlyIn = o.tokensIn * scale;
    const monthlyOut = o.tokensOut * scale;
    // Need a cost to beat. Prefer observed spend; else price the incumbent list.
    const baseMonthly =
      observedMonthlyUsd > 0
        ? observedMonthlyUsd
        : incumbent
          ? (monthlyCost(incumbent, monthlyIn, monthlyOut) ?? 0)
          : 0;
    if (baseMonthly <= 0) continue;

    let best: { c: CatalogModel; monthly: number } | null = null;
    for (const c of catalog) {
      if (TIER_RANK[c.tier] < floorRank) continue; // must be capable enough
      if (incumbent && c.key === incumbent.key) continue;
      if (norm(c.id) === norm(o.model)) continue;
      const m = monthlyCost(c, monthlyIn, monthlyOut);
      if (m === null) continue;
      if (m < baseMonthly && (!best || m < best.monthly)) best = { c, monthly: m };
    }
    if (!best) continue;

    const savings = baseMonthly - best.monthly;
    if (savings < minSavingsUsd) continue;

    const basis: ModelRecommendation["basis"] = minTiers.has(norm(o.model))
      ? "prompt-classified"
      : "tier";
    recommendations.push({
      id: `${o.provider}:${o.model}`,
      currentModel: o.model,
      currentProvider: o.provider,
      currentTier: incumbentTier,
      observedRequests: Math.round(o.requests),
      avgInTokens: Math.round(o.tokensIn / o.requests),
      avgOutTokens: Math.round(o.tokensOut / o.requests),
      observedMonthlyUsd: baseMonthly,
      suggestedModel: best.c.name,
      suggestedProvider: best.c.provider,
      suggestedTier: best.c.tier,
      suggestedMonthlyUsd: best.monthly,
      monthlySavingsUsd: savings,
      savingsPct: baseMonthly > 0 ? savings / baseMonthly : 0,
      rationale:
        basis === "prompt-classified"
          ? `Sampled tasks need only a ${floorTier}-tier model; ${best.c.name} covers that at a lower rate for this token mix.`
          : `${best.c.name} is ${best.c.tier}-tier (≥ ${incumbentTier}) and cheaper for the observed ${Math.round(o.tokensIn / o.requests)}-in / ${Math.round(o.tokensOut / o.requests)}-out token mix.`,
      basis,
    });
  }

  recommendations.sort((a, b) => b.monthlySavingsUsd - a.monthlySavingsUsd);
  return {
    days,
    classified: classifyPrompts,
    catalogSize: catalog.length,
    totalMonthlySavingsUsd: recommendations.reduce((s, r) => s + r.monthlySavingsUsd, 0),
    recommendations,
  };
}

// ---------------------------------------------------------------------------
// Self-check — pure matching/pricing logic. Never runs in the Worker.
// ---------------------------------------------------------------------------
if (import.meta.main) {
  const assert = (c: boolean, m: string) => {
    if (!c) throw new Error(m);
  };
  assert(norm("@cf/moonshotai/kimi-k2.7-code") === "kimik27code", `norm cf: ${norm("@cf/moonshotai/kimi-k2.7-code")}`);
  assert(norm("anthropic/claude-sonnet-5") === "claudesonnet5", `norm slash: ${norm("anthropic/claude-sonnet-5")}`);
  assert(!isChatModel("@cf/baai/bge-large-en-v1.5"), "embedding excluded");
  assert(!isChatModel("@cf/openai/whisper-large-v3-turbo"), "whisper excluded");
  assert(isChatModel("@cf/moonshotai/kimi-k2.7-code"), "chat model kept");
  assert(classifyTier("gpt-5-nano") === "small", "nano is small");
  assert(classifyTier("claude-opus-5") === "frontier", "opus is frontier");
  assert(classifyTier("claude-sonnet-4") === "mid", "sonnet-4 is mid");
  assert(TIER_RANK.frontier > TIER_RANK.mid && TIER_RANK.mid > TIER_RANK.small, "tier order");
  const c: CatalogModel = { key: "x:y", id: "y", name: "Y", provider: "x", inPerM: 1, outPerM: 2, cachedInPerM: null, context: null, tier: "mid", source: "aipricing" };
  assert(monthlyCost(c, 1_000_000, 1_000_000) === 3, "monthly cost 1M+1M @ $1/$2 = $3");
  // eslint-disable-next-line no-console
  console.log("ok — model-recommendations logic verified");
}
