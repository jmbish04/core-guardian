/**
 * @fileoverview AI model advisory + cost service over the `ai_model_pricing`
 * catalog.
 *
 * - `latestModels` — the newest price row per (provider, api_model_name).
 * - `adviseModels` — hands the whole catalog + a use-case/volume request to
 *   Workers AI (kimi-k2.7-code) and returns the top-3 cheapest-capable models.
 * - `calculateCosts` — for an array of usage scenarios, looks up the price that
 *   was in effect at each scenario's timestamp (pricing drifts within a month)
 *   and sums the input+output cost.
 *
 * @see {@link file://src/backend/guardian/ai-model-pricing.ts} for the scraper.
 */

import { and, desc, eq, lte, sql } from "drizzle-orm";

import { getDb } from "@/backend/db";
import { aiModelPricing, type AiModelPricingRow } from "@/backend/db/schema";

import { queryGatewayCosts } from "./ai-gateway-costs";

const ADVISOR_MODEL = "@cf/moonshotai/kimi-k2.7-code";

/** Newest price row per (provider, api_model_name). */
export async function latestModels(env: Env): Promise<AiModelPricingRow[]> {
  const rows = await getDb(env).select().from(aiModelPricing).orderBy(desc(aiModelPricing.scrapedAt));
  const seen = new Set<string>();
  const out: AiModelPricingRow[] = [];
  for (const r of rows) {
    const key = `${r.provider}::${r.apiModelName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

export type AdviseRequest = {
  useCase: string;
  frequency?: string;
  inputTokens?: number;
  outputTokens?: number;
};

export type Advice = {
  recommendations: { apiModelName: string; provider: string; why: string; estCostPerCall: number | null }[];
  raw?: string;
};

function readAiText(res: any): string {
  return (
    res?.response ??
    res?.result?.response ??
    res?.choices?.[0]?.message?.content ??
    res?.result?.choices?.[0]?.message?.content ??
    ""
  );
}

/** Per-call cost from a catalog row + token estimates. */
function estCost(row: AiModelPricingRow, inTok: number, outTok: number): number | null {
  if (row.inputPricePerMillion === null && row.outputPricePerMillion === null) return null;
  return (inTok / 1_000_000) * (row.inputPricePerMillion ?? 0) + (outTok / 1_000_000) * (row.outputPricePerMillion ?? 0);
}

/**
 * Recommend the top-3 models for a use case, weighing price against capability.
 * The full catalog is handed to kimi-k2.7-code so the advice reflects live prices.
 */
export async function adviseModels(env: Env, req: AdviseRequest): Promise<Advice> {
  const models = await latestModels(env);
  const inTok = req.inputTokens ?? 1000;
  const outTok = req.outputTokens ?? 1000;

  // Blend in what AI Gateway ACTUALLY charged (last 30d) so the advice reflects
  // real observed cost + any fluctuation, not just advertised list price.
  const observed = new Map<string, number>();
  try {
    const gw = await queryGatewayCosts(env, Date.now() - 30 * 86_400_000, Date.now());
    for (const g of gw) {
      if (g.effectivePerMillion !== null) {
        const key = g.model.toLowerCase();
        if (!observed.has(key)) observed.set(key, g.effectivePerMillion);
      }
    }
  } catch {
    /* gateway data is optional context */
  }

  // Compact the catalog for the prompt (with a per-call cost estimate so the
  // model can reason about price directly).
  const catalog = models.map((m) => ({
    provider: m.provider,
    apiModelName: m.apiModelName,
    model: m.model,
    bestUsedFor: m.bestUsedFor,
    inPerM: m.inputPricePerMillion,
    outPerM: m.outputPricePerMillion,
    estCostPerCall: estCost(m, inTok, outTok),
    // Blended $/1M this account actually paid via AI Gateway, when we've seen it.
    observedGatewayPerM: observed.get(m.apiModelName.toLowerCase()) ?? null,
  }));

  const prompt = `You advise coding agents on the cheapest capable AI model for a task. Given the request and the live model catalog (prices in USD; estCostPerCall is for the given token estimates; observedGatewayPerM is the blended $/1M this account has ACTUALLY paid through AI Gateway when available — trust it over the advertised list price when present), pick the TOP 3 models that best balance capability for the use case against cost. Prefer the cheapest model that is clearly capable.

Return ONLY JSON: {"recommendations":[{"apiModelName":string,"provider":string,"why":string}]} — exactly 3, best first.

REQUEST:
- use case: ${req.useCase}
- frequency: ${req.frequency ?? "unspecified"}
- est input tokens/call: ${inTok}
- est output tokens/call: ${outTok}

CATALOG:
${JSON.stringify(catalog).slice(0, 18000)}`;

  let raw = "";
  try {
    // kimi-k2.7-code is a reasoning model — it spends tokens on hidden
    // reasoning_content before the answer, so give the budget room or `content`
    // comes back empty.
    const out: any = await env.AI.run(ADVISOR_MODEL, {
      messages: [{ role: "user", content: prompt }],
      max_tokens: 6000,
    });
    raw = readAiText(out);
  } catch (err) {
    return { recommendations: [], raw: `advisor model error: ${err instanceof Error ? err.message : String(err)}` };
  }

  const match = raw.match(/\{[\s\S]*\}/);
  let recs: { apiModelName: string; provider: string; why: string }[] = [];
  if (match) {
    try {
      recs = JSON.parse(match[0]).recommendations ?? [];
    } catch {
      /* fall through — return raw for debugging */
    }
  }

  const byName = new Map(models.map((m) => [m.apiModelName, m]));
  return {
    recommendations: recs.slice(0, 3).map((r) => {
      const row = byName.get(r.apiModelName);
      return {
        apiModelName: r.apiModelName,
        provider: r.provider ?? row?.provider ?? "unknown",
        why: r.why ?? "",
        estCostPerCall: row ? estCost(row, inTok, outTok) : null,
      };
    }),
    raw: recs.length === 0 ? raw.slice(0, 500) : undefined,
  };
}

export type UsageScenario = {
  provider?: string;
  model: string; // api_model_name (or display name)
  inputTokens: number;
  outputTokens: number;
  /** Unix ms the usage occurred — pricing is looked up as-of this time. */
  at?: number;
};

export type CostLine = UsageScenario & {
  matched: boolean;
  pricedAt: number | null;
  inputPricePerMillion: number | null;
  outputPricePerMillion: number | null;
  costUsd: number | null;
};

/**
 * Cost each scenario using the price in effect at its timestamp (newest row with
 * scraped_at <= at). Returns per-line detail plus the total.
 */
export async function calculateCosts(
  env: Env,
  scenarios: UsageScenario[],
): Promise<{ lines: CostLine[]; totalUsd: number }> {
  const db = getDb(env);
  const lines: CostLine[] = [];
  let total = 0;

  for (const s of scenarios) {
    const at = s.at ?? Date.now();
    // Newest price row for this model at-or-before the usage time.
    const conds = [lte(aiModelPricing.scrapedAt, at)];
    // Match on api_model_name OR display model; provider narrows when given.
    const modelCond = sql`(${aiModelPricing.apiModelName} = ${s.model} OR ${aiModelPricing.model} = ${s.model})`;
    const where = s.provider
      ? and(modelCond, eq(aiModelPricing.provider, s.provider), ...conds)
      : and(modelCond, ...conds);
    const [row] = await db
      .select()
      .from(aiModelPricing)
      .where(where)
      .orderBy(desc(aiModelPricing.scrapedAt))
      .limit(1);

    const cost = row
      ? (s.inputTokens / 1_000_000) * (row.inputPricePerMillion ?? 0) +
        (s.outputTokens / 1_000_000) * (row.outputPricePerMillion ?? 0)
      : null;
    if (cost !== null) total += cost;

    lines.push({
      ...s,
      matched: Boolean(row),
      pricedAt: row?.scrapedAt ?? null,
      inputPricePerMillion: row?.inputPricePerMillion ?? null,
      outputPricePerMillion: row?.outputPricePerMillion ?? null,
      costUsd: cost,
    });
  }

  return { lines, totalUsd: total };
}
