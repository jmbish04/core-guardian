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
import { z } from "zod";

import { generateStructuredOutput } from "@/backend/ai/providers";
import { getDb } from "@/backend/db";
import { alerts, aiUsageRegistrations } from "@/backend/db/schema";

import { queryGatewayCosts } from "./ai-gateway-costs";
import {
  type CapabilityTier,
  type CatalogModel,
  capabilityScore,
  classifyTier,
  getModelCatalog,
  isChatModel,
  matchCatalogModel,
  normalizeModelName as norm,
  TIER_MIN_SCORE,
  TIER_RANK,
} from "./model-catalog";

const DAY_MS = 86_400_000;

/** Structured-output contract for the prompt-classification pass. */
const MIN_TIER_SCHEMA = z.object({
  tiers: z.array(
    z.object({
      model: z.string(),
      tier: z.enum(["small", "mid", "frontier"]),
    }),
  ),
});

/** One model's observed workload over the window. */
export type ObservedModel = {
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

  const prompt = `For each model below, given sample task descriptions it was used for, return the MINIMUM capability tier that can reliably do those tasks. Tiers: "small" (simple extraction/classification/formatting), "mid" (general reasoning, coding, summarization), "frontier" (hard multi-step reasoning, complex code, nuanced judgment).

${JSON.stringify(samples).slice(0, 8000)}`;
  try {
    // Structured output — the model is forced to return an object matching
    // MIN_TIER_SCHEMA (response_format: json_schema), validated by Zod. No
    // text-then-JSON.parse (AGENTS.md §25).
    const result = await generateStructuredOutput(env, {
      messages: [{ role: "user", content: prompt }],
      schema: MIN_TIER_SCHEMA,
      schemaName: "MinTiers",
      max_tokens: 2000,
    });
    for (const t of result.tiers) out.set(norm(t.model), t.tier);
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
    observed: injectedObserved,
    catalog: injectedCatalog,
  }: {
    days?: number;
    classifyPrompts?: boolean;
    minSavingsUsd?: number;
    observed?: ObservedModel[];
    catalog?: CatalogModel[];
  } = {},
): Promise<RecommendationReport> {
  const catalog = injectedCatalog ?? (await getModelCatalog(env));
  const observed = injectedObserved ?? (await observedUsage(env, days));
  const scale = 30 / days; // observed-window → monthly

  const minTiers = classifyPrompts ? await classifyMinTiers(env, observed) : new Map();

  const recommendations: ModelRecommendation[] = [];
  for (const o of observed) {
    if (o.requests <= 0) continue;
    // Only advise on chat/completion models — an embedding or speech model has
    // no chat-model equivalent to swap to.
    if (!isChatModel(o.model)) continue;
    const incumbent = matchCatalogModel(catalog, o.model);
    const incumbentTier = incumbent?.tier ?? classifyTier(o.model);
    const incumbentScore = incumbent?.score ?? capabilityScore(o.model);
    // The capability floor a candidate must clear, as a curated score. Prompt
    // classification can lower it (to the classified tier's minimum) when the
    // sampled tasks are simpler than the incumbent's own capability.
    const classifiedTier: CapabilityTier | undefined = minTiers.get(norm(o.model));
    const floorScore = classifiedTier ? TIER_MIN_SCORE[classifiedTier] : incumbentScore;

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
      if (c.score < floorScore) continue; // must be at least as capable
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
          ? `Sampled tasks need only a ${classifiedTier}-tier model; ${best.c.name} (capability ${best.c.score}/100) covers that at a lower rate for this token mix.`
          : `${best.c.name} rates ${best.c.score}/100 on capability vs ${o.model}'s ${incumbentScore}, and is cheaper for the observed ${Math.round(o.tokensIn / o.requests)}-in / ${Math.round(o.tokensOut / o.requests)}-out token mix.`,
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

/** Alert `service` tag that scopes model-advisor rows in the shared alerts table. */
const ADVISOR_ALERT_SERVICE = "model-advisor";
/** Only savings at or above this monthly figure are worth an alert. */
const ALERT_MIN_SAVINGS_USD = 5;

/**
 * Surface high-value recommendations in the Guardian alerts feed (advisory —
 * snooze/resolve, never destructive). Upserts one alert per current model whose
 * best swap saves ≥ $5/mo, and resolves model-advisor alerts whose saving has
 * since evaporated. Runs on the daily cron. Tier-based only — no per-load kimi.
 *
 * @returns count of active recommendation alerts after the sync
 */
export async function syncRecommendationAlerts(env: Env): Promise<number> {
  const { recommendations } = await getRecommendations(env, {
    days: 30,
    classifyPrompts: false,
    minSavingsUsd: ALERT_MIN_SAVINGS_USD,
  });
  const db = getDb(env);
  const now = Date.now();
  const activeIds = new Set<string>();

  for (const r of recommendations) {
    const id = `${ADVISOR_ALERT_SERVICE}::${r.currentModel}`;
    activeIds.add(id);
    // ≥$50/mo is a warning (worth acting on); $5–50 is informational. Never
    // critical — an unrealized saving is an opportunity, not an incident.
    const severity: "info" | "warning" = r.monthlySavingsUsd >= 50 ? "warning" : "info";
    const cause = `${r.currentModel} runs ~$${r.observedMonthlyUsd.toFixed(2)}/mo; ${r.suggestedModel} (${r.suggestedTier}-tier, ≥ its ${r.currentTier}) would run ~$${r.suggestedMonthlyUsd.toFixed(2)}/mo for the same observed token mix.`;
    const recommendation = `Switch ${r.currentModel} → ${r.suggestedModel} to save ~$${r.monthlySavingsUsd.toFixed(2)}/mo (${Math.round(r.savingsPct * 100)}% less). Review in Model advisor: /dashboard/recommendations`;

    const [existing] = await db.select().from(alerts).where(eq(alerts.id, id)).limit(1);
    const stillSnoozed =
      existing?.status === "snoozed" && existing.snoozedUntil && existing.snoozedUntil > now;
    const row = {
      service: ADVISOR_ALERT_SERVICE,
      resource: r.currentModel,
      worker: null,
      severity,
      cause,
      recommendation,
      // No allowance fraction / overage cost — a saving isn't either. Left null
      // so the alerts UI shows neither the % ring nor the "overage" chip.
      projectedFraction: null,
      estCostDelta: null,
      status: (stillSnoozed ? "snoozed" : "active") as "snoozed" | "active",
      updatedAt: now,
    };
    if (existing) {
      await db.update(alerts).set(row).where(eq(alerts.id, id));
    } else {
      await db.insert(alerts).values({ ...row, id, createdAt: now });
    }
  }

  // Resolve model-advisor alerts whose saving no longer clears the bar.
  const existingAdvisor = await db
    .select({ id: alerts.id })
    .from(alerts)
    .where(and(eq(alerts.service, ADVISOR_ALERT_SERVICE), sql`${alerts.status} != 'resolved'`));
  for (const a of existingAdvisor) {
    if (!activeIds.has(a.id))
      await db.update(alerts).set({ status: "resolved", updatedAt: now }).where(eq(alerts.id, a.id));
  }
  return activeIds.size;
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
  // Capability scores — the fix for "cheap obscure model displaces a strong one".
  // The exact bug we caught: a code model must out-rank a generic flash model,
  // so Ling-2.6-flash can NOT be recommended to replace kimi-k2.7-code.
  assert(
    capabilityScore("kimi-k2.7-code") > capabilityScore("inclusionAI: Ling-2.6-flash"),
    `kimi-code (${capabilityScore("kimi-k2.7-code")}) must beat Ling-flash (${capabilityScore("inclusionAI: Ling-2.6-flash")})`,
  );
  assert(capabilityScore("gpt-5-mini") > capabilityScore("gpt-5-nano"), "gpt-5-mini > nano");
  assert(capabilityScore("claude-opus-5") >= 80, "opus is frontier-score");
  assert(capabilityScore("gemini-2.5-flash-lite") < capabilityScore("gemini-2.5-flash"), "flash-lite < flash");
  assert(capabilityScore("some-unknown-model-xyz") === 48, "unknown → conservative default");
  // Version-format + code-specialist coverage (the tightening pass).
  assert(capabilityScore("@cf/meta/llama-3.3-70b-instruct") >= 68, "llama-3.3-70b is strong-mid");
  assert(
    capabilityScore("@cf/qwen/qwen2.5-coder-32b-instruct") > capabilityScore("Ling-2.6-flash"),
    "a coder model outranks a generic flash",
  );
  const c: CatalogModel = { key: "x:y", id: "y", name: "Y", provider: "x", inPerM: 1, outPerM: 2, cachedInPerM: null, context: null, tier: "mid", source: "aipricing" };
  assert(monthlyCost(c, 1_000_000, 1_000_000) === 3, "monthly cost 1M+1M @ $1/$2 = $3");
  // eslint-disable-next-line no-console
  console.log("ok — model-recommendations logic verified");
}
