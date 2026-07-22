/**
 * @fileoverview AI Gateway actual-cost snapshotting + drift check.
 *
 * - `snapshotGatewayCosts` — daily cron: pull per-gateway/provider/model cost +
 *   tokens from GraphQL analytics (retained only ~31 days) and upsert into
 *   `ai_gateway_costs` so we keep permanent history.
 * - `queryGatewayCosts` — read the actual recorded cost over a date range,
 *   optionally filtered to specific models.
 * - `driftCheck` — for models with both a scraped list price and observed
 *   gateway cost, compare what Cloudflare ACTUALLY charged against what the
 *   scraped provider price WOULD predict, and flag anything off by > threshold.
 *
 * @see {@link file://src/backend/db/schemas/governance/ai-gateway-costs.ts}
 */

import { and, desc, gte, lte } from "drizzle-orm";

import { getDb } from "@/backend/db";
import { aiGatewayCosts, aiModelPricing, type AiModelPricingRow, type NewAiGatewayCostRow } from "@/backend/db/schema";
import { queryAccountAnalytics } from "@/backend/lib/cloudflare-graphql";

/** Newest scraped price row per (provider, api_model_name). Local copy to keep
 *  this module free of a circular import with ai-model-advisor. */
async function latestScraped(env: Env): Promise<AiModelPricingRow[]> {
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

const SNAPSHOT_QUERY = `query GwCosts($accountTag: string!, $start: Time!, $end: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      aiGatewayRequestsAdaptiveGroups(
        limit: 10000
        filter: { datetimeHour_geq: $start, datetimeHour_leq: $end }
      ) {
        count
        sum { cost uncachedTokensIn uncachedTokensOut }
        dimensions { gateway provider model date }
      }
    }
  }
}`;

type GwRow = {
  count: number;
  sum: { cost: number; uncachedTokensIn: number; uncachedTokensOut: number };
  dimensions: { gateway: string; provider: string; model: string; date: string };
};

/**
 * Snapshot the last `days` of AI Gateway per-model cost into D1 (upsert).
 *
 * @returns rows written.
 */
export async function snapshotGatewayCosts(env: Env, days = 3): Promise<number> {
  const end = new Date();
  const start = new Date(end.getTime() - days * 86_400_000);
  start.setUTCHours(0, 0, 0, 0);

  const account = await queryAccountAnalytics<{ aiGatewayRequestsAdaptiveGroups: GwRow[] }>(
    env,
    SNAPSHOT_QUERY,
    { start: start.toISOString(), end: end.toISOString() },
  );
  const groups = account.aiGatewayRequestsAdaptiveGroups ?? [];

  const now = Date.now();
  const rows: NewAiGatewayCostRow[] = groups
    .filter((g) => g.dimensions.model) // skip rows with no model
    .map((g) => {
      const { gateway, provider, model, date } = g.dimensions;
      return {
        id: `${date}:${gateway}:${provider}:${model}`,
        day: date,
        dayStart: Date.parse(`${date}T00:00:00Z`),
        gateway,
        provider,
        model,
        requests: g.count ?? 0,
        costUsd: g.sum.cost ?? 0,
        tokensIn: g.sum.uncachedTokensIn ?? 0,
        tokensOut: g.sum.uncachedTokensOut ?? 0,
        capturedAt: now,
      };
    });

  const db = getDb(env);
  for (const r of rows) {
    // 11 columns; single-row upserts keep it simple and idempotent.
    await db
      .insert(aiGatewayCosts)
      .values(r)
      .onConflictDoUpdate({
        target: aiGatewayCosts.id,
        set: {
          requests: r.requests,
          costUsd: r.costUsd,
          tokensIn: r.tokensIn,
          tokensOut: r.tokensOut,
          capturedAt: now,
        },
      });
  }
  return rows.length;
}

export type GatewayCostRange = {
  provider: string;
  model: string;
  gateway: string;
  requests: number;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  /** Blended effective USD per 1M tokens Cloudflare actually charged. */
  effectivePerMillion: number | null;
};

/**
 * Actual gateway cost aggregated per (provider, model, gateway) over a range.
 *
 * @param models - optional list of model names/ids to filter to (substring match)
 */
export async function queryGatewayCosts(
  env: Env,
  start: number,
  end: number,
  models?: string[],
): Promise<GatewayCostRange[]> {
  const rows = await getDb(env)
    .select()
    .from(aiGatewayCosts)
    .where(and(gte(aiGatewayCosts.dayStart, startOfDay(start)), lte(aiGatewayCosts.dayStart, end)));

  const wanted = models?.map((m) => m.toLowerCase());
  const agg = new Map<string, GatewayCostRange>();
  for (const r of rows) {
    if (wanted && !wanted.some((w) => r.model.toLowerCase().includes(w) || w.includes(r.model.toLowerCase())))
      continue;
    const key = `${r.provider}::${r.model}::${r.gateway}`;
    const cur =
      agg.get(key) ??
      {
        provider: r.provider,
        model: r.model,
        gateway: r.gateway,
        requests: 0,
        costUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
        effectivePerMillion: null,
      };
    cur.requests += r.requests;
    cur.costUsd += r.costUsd;
    cur.tokensIn += r.tokensIn;
    cur.tokensOut += r.tokensOut;
    agg.set(key, cur);
  }
  return [...agg.values()].map((c) => {
    const tot = c.tokensIn + c.tokensOut;
    return { ...c, effectivePerMillion: tot > 0 ? (c.costUsd / tot) * 1_000_000 : null };
  });
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export type DriftFinding = {
  provider: string;
  model: string;
  gateway: string;
  actualCostUsd: number;
  expectedCostUsd: number;
  driftPct: number;
  scrapedInputPerM: number | null;
  scrapedOutputPerM: number | null;
  effectivePerMillion: number | null;
};

/**
 * Compare actual gateway cost against what the scraped list price predicts.
 *
 * expectedCost = tokensIn·inScraped + tokensOut·outScraped (per 1M). A large
 * gap means our scraped price is stale, or Cloudflare marks up / caches, or the
 * model was misidentified — all worth surfacing.
 *
 * @param thresholdPct - minimum |drift| to report (e.g. 10 = 10%).
 */
export async function driftCheck(
  env: Env,
  start: number,
  end: number,
  thresholdPct = 10,
): Promise<DriftFinding[]> {
  const [gwCosts, scraped] = await Promise.all([queryGatewayCosts(env, start, end), latestScraped(env)]);

  const findings: DriftFinding[] = [];
  for (const g of gwCosts) {
    if (g.costUsd <= 0) continue;
    // Workers AI models routed through a gateway are billed by NEURONS (postpaid),
    // not the catalog per-token price — so comparing the two bases is apples-to-
    // oranges and always "drifts". Drift is only meaningful for third-party
    // (openai/anthropic/google) models, which bill per token on both sides.
    if (g.provider === "workers-ai" || g.model.startsWith("@cf/")) continue;
    // Match a scraped model by name (either direction of substring containment).
    const gl = g.model.toLowerCase();
    const match = scraped.find(
      (s) => s.apiModelName.toLowerCase() === gl || gl.includes(s.apiModelName.toLowerCase()) || s.apiModelName.toLowerCase().includes(gl),
    );
    if (!match || match.inputPricePerMillion === null || match.outputPricePerMillion === null) continue;

    const expected =
      (g.tokensIn / 1_000_000) * match.inputPricePerMillion +
      (g.tokensOut / 1_000_000) * match.outputPricePerMillion;
    if (expected <= 0) continue;
    const driftPct = ((g.costUsd - expected) / expected) * 100;
    if (Math.abs(driftPct) < thresholdPct) continue;

    findings.push({
      provider: g.provider,
      model: g.model,
      gateway: g.gateway,
      actualCostUsd: g.costUsd,
      expectedCostUsd: expected,
      driftPct,
      scrapedInputPerM: match.inputPricePerMillion,
      scrapedOutputPerM: match.outputPricePerMillion,
      effectivePerMillion: g.effectivePerMillion,
    });
  }
  return findings.sort((a, b) => Math.abs(b.driftPct) - Math.abs(a.driftPct));
}

// ---------------------------------------------------------------------------
// Dual-source pricing history — advertised (scraped) vs actual (gateway)
// ---------------------------------------------------------------------------

export type PricingSource = "both" | "scraped" | "gateway";

export type ScrapedPricePoint = {
  provider: string;
  model: string;
  apiModelName: string;
  inputPricePerMillion: number | null;
  outputPricePerMillion: number | null;
  scrapedAt: number;
};

export type PricingHistory = {
  scraped: ScrapedPricePoint[];
  gateway: GatewayCostRange[];
};

/**
 * Return, for the given models over a date range, the ADVERTISED pricing we
 * scraped from provider docs and/or the ACTUAL pricing Cloudflare recorded via
 * AI Gateway — so a consumer can see "here's what the site advertised" next to
 * "here's what the gateway actually charged".
 *
 * @param models - model names/ids (plural). Empty = all.
 * @param source - both (default) | scraped | gateway
 */
export async function pricingHistory(
  env: Env,
  models: string[],
  start: number,
  end: number,
  source: PricingSource = "both",
): Promise<PricingHistory> {
  const wanted = models.map((m) => m.toLowerCase()).filter(Boolean);
  const matchModel = (name: string) =>
    wanted.length === 0 ||
    wanted.some((w) => name.toLowerCase().includes(w) || w.includes(name.toLowerCase()));

  let scraped: ScrapedPricePoint[] = [];
  if (source !== "gateway") {
    const rows = await getDb(env)
      .select()
      .from(aiModelPricing)
      .where(and(gte(aiModelPricing.scrapedAt, start), lte(aiModelPricing.scrapedAt, end)));
    scraped = rows
      .filter((r) => matchModel(r.apiModelName) || matchModel(r.model))
      .map((r) => ({
        provider: r.provider,
        model: r.model,
        apiModelName: r.apiModelName,
        inputPricePerMillion: r.inputPricePerMillion,
        outputPricePerMillion: r.outputPricePerMillion,
        scrapedAt: r.scrapedAt,
      }))
      .sort((a, b) => b.scrapedAt - a.scrapedAt);
  }

  let gateway: GatewayCostRange[] = [];
  if (source !== "scraped") {
    gateway = await queryGatewayCosts(env, start, end, wanted.length ? models : undefined);
  }

  return { scraped, gateway };
}
