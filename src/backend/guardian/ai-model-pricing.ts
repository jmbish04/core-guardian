/**
 * @fileoverview Cloudflare Workers AI model-pricing catalog.
 *
 * Refreshes `ai_model_pricing` (append-only) from the Cloudflare Workers AI
 * models API, which returns structured USD-per-million pricing in each model's
 * `price` property — parsed directly, no AI extraction, no neuron conversion.
 *
 * Third-party model pricing (Anthropic / OpenAI / Google / etc.) is NOT scraped
 * here anymore — it now comes, structured and daily, from the OpenRouter and AI
 * Pricing Guru sources merged in {@link ./model-catalog}. This file's remaining
 * job is the one thing those APIs don't cover: the account's own `@cf/…` models.
 *
 * The latest snapshot is also cached in KV (SESSIONS, key `ai-model-pricing:latest`)
 * so the list endpoint can answer without a D1 scan.
 *
 * @see {@link file://src/backend/db/schemas/governance/ai-model-pricing.ts}
 * @see {@link file://src/backend/guardian/model-catalog.ts} for third-party pricing.
 */

import { getDb } from "@/backend/db";
import { aiModelPricing, type NewAiModelPricingRow } from "@/backend/db/schema";
import { getCloudflareAccountId, getCloudflareApiToken } from "@/backend/utils/secrets";

export const PRICING_CACHE_KEY = "ai-model-pricing:latest";

/** One normalized catalog record (before the D1 row envelope). */
export type ModelRecord = {
  provider: string;
  model: string;
  apiModelName: string;
  description: string | null;
  bestUsedFor: string | null;
  inputPricePerMillion: number | null;
  outputPricePerMillion: number | null;
  cachedInputPricePerMillion: number | null;
  sourceUrl: string;
};

function cleanNum(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Parse Workers AI models API directly — pricing is already structured USD/1M. */
async function scrapeWorkersAi(env: Env): Promise<ModelRecord[]> {
  const [account, token] = await Promise.all([
    getCloudflareAccountId(env),
    getCloudflareApiToken(env),
  ]);
  if (!account || !token) return [];
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/ai/models/search?per_page=300`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return [];
  const json = (await res.json()) as { result?: any[] };
  const url = "https://developers.cloudflare.com/workers-ai/platform/pricing/";
  const out: ModelRecord[] = [];
  for (const m of json.result ?? []) {
    if ((m.task?.name ?? "") !== "Text Generation") continue; // token-priced chat models only
    const price = (m.properties ?? []).find((p: any) => p.property_id === "price")?.value;
    if (!Array.isArray(price)) continue;
    const find = (u: string) => price.find((p: any) => p.unit === u)?.price;
    const input = cleanNum(find("per M input tokens"));
    const output = cleanNum(find("per M output tokens"));
    if (input === null && output === null) continue;
    out.push({
      provider: "workers-ai",
      model: m.name,
      apiModelName: m.name,
      description: m.description ? String(m.description).slice(0, 300) : null,
      bestUsedFor: m.task?.name ?? null,
      inputPricePerMillion: input,
      outputPricePerMillion: output,
      cachedInputPricePerMillion: cleanNum(find("per M cached input tokens")),
      sourceUrl: url,
    });
  }
  return out;
}

/** Keep one record per (provider, api_model_name) — the base rate wins ties. */
function dedupeRecords(records: ModelRecord[]): ModelRecord[] {
  const best = new Map<string, ModelRecord>();
  for (const r of records) {
    const key = `${r.provider}::${r.apiModelName}`;
    const prev = best.get(key);
    // Prefer the lower input price (the standard/base tier over long-context/priority).
    if (!prev || (r.inputPricePerMillion ?? Infinity) < (prev.inputPricePerMillion ?? Infinity)) {
      best.set(key, r);
    }
  }
  return [...best.values()];
}

/** Collect Cloudflare Workers AI records, deduped. (The `provider` param is kept
 * for the by-provider route/test entry point; only `workers-ai` yields data now
 * that third-party pricing lives in {@link ./model-catalog}.) */
async function collectProvider(env: Env, provider: string): Promise<ModelRecord[]> {
  if (provider !== "workers-ai") return [];
  return dedupeRecords(await scrapeWorkersAi(env).catch(() => []));
}

/** Persist a batch of records (append) + refresh the KV cache with the latest. */
async function persist(env: Env, records: ModelRecord[], now: number): Promise<void> {
  if (records.length === 0) return;
  const db = getDb(env);
  const rows: NewAiModelPricingRow[] = records.map((r) => ({
    id: crypto.randomUUID(),
    provider: r.provider,
    model: r.model,
    apiModelName: r.apiModelName,
    description: r.description,
    bestUsedFor: r.bestUsedFor,
    inputPricePerMillion: r.inputPricePerMillion,
    outputPricePerMillion: r.outputPricePerMillion,
    cachedInputPricePerMillion: r.cachedInputPricePerMillion,
    currency: "USD",
    sourceUrl: r.sourceUrl,
    scrapedAt: now,
  }));
  for (let i = 0; i < rows.length; i += 8) {
    await db.insert(aiModelPricing).values(rows.slice(i, i + 8));
  }
}

/** Scrape a single provider, append to D1. For testing + resilient re-runs. */
export async function scrapeOneProvider(env: Env, provider: string): Promise<number> {
  const now = Date.now();
  const recs = await collectProvider(env, provider);
  await persist(env, recs, now);
  return recs.length;
}

/**
 * Scrape all sources, append to D1, and cache the latest snapshot in KV.
 *
 * @returns per-provider counts.
 */
export async function scrapeAllModelPricing(env: Env): Promise<Record<string, number>> {
  const now = Date.now();
  const all = await collectProvider(env, "workers-ai");
  await persist(env, all, now);

  // Cache the latest snapshot for the list endpoint.
  await env.SESSIONS.put(PRICING_CACHE_KEY, JSON.stringify({ scrapedAt: now, models: all })).catch(() => {});

  return { "workers-ai": all.length };
}
