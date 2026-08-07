/**
 * @fileoverview Unified AI-model candidate catalog for the cost advisor.
 *
 * Merges three price sources into one comparable pool of models the advisor can
 * recommend switching TO:
 *  - OpenRouter (`/api/v1/models`) — the widest roster; pricing is USD *per token*
 *    (strings), normalized here to per-1M. Skipped when OPEN_ROUTER_API_KEY is unset.
 *  - AI Pricing Guru (`/api/pricing.json`) — curated per-1M input/output/cached
 *    rates across the major providers, refreshed daily.
 *  - The Worker's own scraped `ai_model_pricing` catalog ({@link ./ai-model-pricing}).
 *
 * Each candidate carries a coarse capability `tier` (small | mid | frontier) so a
 * recommendation only ever swaps DOWN in price, never DOWN in capability. The
 * merged pool is cached in KV (SESSIONS) and refreshed daily on the cron — the
 * recommendation engine reads the cache, never the upstreams on the hot path.
 *
 * @see https://openrouter.ai/api/v1/models
 * @see https://www.aipricing.guru/api/pricing.json
 */

import { getOpenRouterApiKey } from "@/backend/utils/secrets";

import { latestModels } from "./ai-model-advisor";

export const CATALOG_CACHE_KEY = "model-catalog:latest";
const AIPRICING_URL = "https://www.aipricing.guru/api/pricing.json";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/models?limit=500";

export type CapabilityTier = "small" | "mid" | "frontier";

/** One comparable candidate model, prices in USD per 1M tokens. */
export type CatalogModel = {
  /** Stable key: `${provider}:${id}` lowercased. */
  key: string;
  id: string;
  name: string;
  provider: string;
  inPerM: number | null;
  outPerM: number | null;
  cachedInPerM: number | null;
  context: number | null;
  tier: CapabilityTier;
  source: "aipricing" | "openrouter" | "scraped";
};

export const TIER_RANK: Record<CapabilityTier, number> = { small: 0, mid: 1, frontier: 2 };

/**
 * Coarse capability tier from the model name. A heuristic, deliberately — the
 * point is to never recommend a clearly-weaker model, not to rank rivals within
 * a tier. Order matters: check the strongest signals first.
 * ponytail: regex map with a known ceiling; the prompt-classify path (opt-in)
 * refines it per observed task when a caller wants the deeper read.
 */
export function classifyTier(name: string): CapabilityTier {
  const s = name.toLowerCase();
  // Small / fast tiers — cheapest, weakest. Checked first so "gpt-5-nano" doesn't
  // match the frontier "gpt-5" rule below.
  if (/nano|mini|haiku|flash-?lite|lite|8b|7b|3b|1b|small|gemma|ministral|phi-|tiny|instant/.test(s))
    return "small";
  // Frontier tiers — the strongest, most expensive.
  if (/opus|gpt-5(?![-\w]*(nano|mini))|o[0-9]|sonnet-5|gemini-[0-9.]*-?(pro|ultra)|grok-[0-9]|deepseek-r|llama-[0-9]*-?405b|mistral-large|command-r-plus|qwen[0-9.]*-max/.test(s))
    return "frontier";
  return "mid";
}

function normKey(provider: string, id: string): string {
  return `${provider}:${id}`.toLowerCase();
}

/**
 * True only for text chat/completion models — the sole thing a chat-cost
 * recommendation may swap between. Excludes embeddings, rerankers, speech,
 * and image models: recommending a chat model to replace an embedding model
 * (or vice-versa) is category-wrong advice, not a saving.
 */
export function isChatModel(name: string): boolean {
  return !/embed|bge-|\brerank|whisper|\btts\b|text-to-speech|speech|stable-diffusion|sdxl|\bflux\b|dall-?e|\bimage\b|diffusion|\bvoice\b|guard|moderation/i.test(
    name,
  );
}

/** OpenRouter: pricing is USD per token as strings; ×1e6 for per-1M. */
async function fetchOpenRouter(env: Env): Promise<CatalogModel[]> {
  const token = await getOpenRouterApiKey(env);
  if (!token) return [];
  const res = await fetch(OPENROUTER_URL, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}`);
  const body = (await res.json()) as { data?: any[] };
  const perM = (v: unknown): number | null => {
    const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
    return Number.isFinite(n) && n > 0 ? n * 1_000_000 : null;
  };
  return (body.data ?? [])
    .filter((m) => (m.architecture?.modality ?? "text->text").startsWith("text"))
    .map((m): CatalogModel => {
      const provider = String(m.id ?? "").split("/")[0] || "openrouter";
      return {
        key: normKey(provider, m.id),
        id: m.id,
        name: m.name ?? m.id,
        provider,
        inPerM: perM(m.pricing?.prompt),
        outPerM: perM(m.pricing?.completion),
        cachedInPerM: perM(m.pricing?.input_cache_read) ?? null,
        context: typeof m.context_length === "number" ? m.context_length : null,
        tier: classifyTier(`${m.id} ${m.name ?? ""}`),
        source: "openrouter",
      };
    });
}

/** AI Pricing Guru: already per-1M. No auth. */
async function fetchAiPricingGuru(): Promise<CatalogModel[]> {
  const res = await fetch(AIPRICING_URL);
  if (!res.ok) throw new Error(`AI Pricing Guru HTTP ${res.status}`);
  const body = (await res.json()) as { models?: any[] };
  return (body.models ?? [])
    .filter((m) => m.status !== "legacy" && m.availability !== "suspended")
    .map((m): CatalogModel => ({
      key: normKey(m.provider ?? "unknown", m.id),
      id: m.id,
      name: m.name ?? m.id,
      provider: m.provider ?? "unknown",
      inPerM: typeof m.pricing?.inputPerM === "number" ? m.pricing.inputPerM : null,
      outPerM: typeof m.pricing?.outputPerM === "number" ? m.pricing.outputPerM : null,
      cachedInPerM: typeof m.pricing?.cachedInputPerM === "number" ? m.pricing.cachedInputPerM : null,
      context: typeof m.context === "number" ? m.context : null,
      tier: classifyTier(`${m.id} ${m.name ?? ""} ${m.family ?? ""}`),
      source: "aipricing",
    }));
}

/** The Worker's own scraped catalog, as candidates. */
async function fetchScraped(env: Env): Promise<CatalogModel[]> {
  const rows = await latestModels(env);
  return rows.map((r): CatalogModel => ({
    key: normKey(r.provider, r.apiModelName),
    id: r.apiModelName,
    name: r.model,
    provider: r.provider,
    inPerM: r.inputPricePerMillion,
    outPerM: r.outputPricePerMillion,
    cachedInPerM: r.cachedInputPricePerMillion,
    context: null,
    tier: classifyTier(`${r.apiModelName} ${r.model}`),
    source: "scraped",
  }));
}

/**
 * Fetch all sources, merge, and cache. Dedupe by canonical key preferring the
 * curated sources (aipricing > scraped > openrouter) so a model isn't listed
 * three times with slightly different prices. Non-fatal per source — a dead
 * upstream shrinks the pool, it doesn't fail the refresh.
 *
 * @returns the merged candidate list (also written to KV)
 */
export async function refreshModelCatalog(env: Env): Promise<CatalogModel[]> {
  const [openrouter, aipricing, scraped] = await Promise.all([
    fetchOpenRouter(env).catch((e) => {
      console.warn(JSON.stringify({ level: "WARN", source: "modelCatalog.openrouter", error: String(e) }));
      return [] as CatalogModel[];
    }),
    fetchAiPricingGuru().catch((e) => {
      console.warn(JSON.stringify({ level: "WARN", source: "modelCatalog.aipricing", error: String(e) }));
      return [] as CatalogModel[];
    }),
    fetchScraped(env).catch(() => [] as CatalogModel[]),
  ]);

  // Priority order defines which source wins a key collision.
  const merged = new Map<string, CatalogModel>();
  for (const m of [...aipricing, ...scraped, ...openrouter]) {
    if (m.inPerM === null && m.outPerM === null) continue; // unpriced → not a candidate
    if (!isChatModel(`${m.id} ${m.name}`)) continue; // chat/completion candidates only
    if (!merged.has(m.key)) merged.set(m.key, m);
  }
  const list = [...merged.values()];
  try {
    await env.SESSIONS.put(CATALOG_CACHE_KEY, JSON.stringify({ at: Date.now(), models: list }));
  } catch {
    /* KV write is best-effort; the caller still gets the list */
  }
  return list;
}

/** Read the cached catalog, refreshing once if the cache is empty. */
export async function getModelCatalog(env: Env): Promise<CatalogModel[]> {
  try {
    const cached = await env.SESSIONS.get(CATALOG_CACHE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached) as { models: CatalogModel[] };
      if (parsed.models?.length) return parsed.models;
    }
  } catch {
    /* fall through to a live refresh */
  }
  return await refreshModelCatalog(env);
}
