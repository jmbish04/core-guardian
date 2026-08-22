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

import { desc } from "drizzle-orm";

import { getDb } from "@/backend/db";
import { aiModelPricing } from "@/backend/db/schema";
import { getOllamaApiKey, getOpenRouterApiKey } from "@/backend/utils/secrets";

export const CATALOG_CACHE_KEY = "model-catalog:latest";
const AIPRICING_URL = "https://www.aipricing.guru/api/pricing.json";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/models?limit=500";
/** Ollama Cloud model list endpoint — same path as local Ollama, hosted at ollama.com. */
const OLLAMA_CLOUD_URL = "https://ollama.com/api/tags";

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
  /** Curated capability score 0–100 (see {@link capabilityScore}). */
  score: number;
  tier: CapabilityTier;
  source: "aipricing" | "openrouter" | "scraped" | "ollama";
};

export const TIER_RANK: Record<CapabilityTier, number> = { small: 0, mid: 1, frontier: 2 };

/** Conservative score for a model whose family we don't recognize. Deliberately
 * mid-low so an unknown cheap model can't outrank a known-strong incumbent in
 * the metadata path — the prompt-classify path is where unknowns earn a swap. */
const DEFAULT_SCORE = 48;

/**
 * Curated per-family capability score, 0–100. This is the calibration knob for
 * the whole advisor: a recommendation only fires when a candidate scores at or
 * above the incumbent, so the scores' RELATIVE order is what matters, not their
 * absolute value. Ordered strongest-signal-first; the first match wins.
 *
 * Unknown families fall to {@link DEFAULT_SCORE} — low enough that a mystery
 * model won't be recommended over anything we actually rate, high enough that a
 * known-weak model still loses to it. Tune a family by moving its number.
 * ponytail: hand-curated map with a known ceiling — for 500+ models we can only
 * confidently rank the families we know; the opt-in prompt analysis judges the rest.
 */
export function capabilityScore(name: string): number {
  const s = name.toLowerCase();
  // Order matters. Small/cheap variants first so "gpt-5-mini" isn't swept up by
  // the frontier "gpt-5" rule — but "mini" alone must not demote gpt-5-mini,
  // so the strong-mini exceptions are listed in the mid band below.
  if (/nano|haiku|flash-?lite|-lite\b|gemma|ministral|phi-?[0-9]|tiny|instant|\b1b\b|\b3b\b|\b7b\b|\b8b\b/.test(s))
    return 32;
  // Frontier — strongest reasoning/code.
  if (
    /opus|gpt-5\.[0-9]|gpt-5(?![-\w]*(nano|mini))|\bo[13]\b|o[0-9]-|sonnet-5|gemini-[0-9.]+-?(pro|ultra)|grok-[3-9]|deepseek-r|kimi-k2[.\w]*-?code|kimi-k2\.[0-9]|glm-[5-9]|qwen[-.0-9]*max|llama[-.0-9]*405b|mistral-large/.test(s)
  )
    return 88;
  // Strong mid — capable general/code models a tier below frontier. Version
  // separators vary (llama-3.3-70b, qwen2.5-72b) so match digits/dots loosely.
  if (
    /gpt-5-mini|gpt-4\.1|gpt-4o(?!-mini)|sonnet-4|sonnet-3\.[57]|claude-3\.[57]|gemini-[2-9][.0-9]*-flash|deepseek-v[0-9]|deepseek-chat|kimi-k2(?![.\w]*code)|qwen[-.0-9]*(?:plus|72b)|llama[-.0-9]*70b|command-r-plus|mistral-medium|grok-[0-9]+-mini/.test(s)
  )
    return 68;
  // Code specialists are purpose-built — don't let a generic cheap chat model
  // replace one on price alone. Below frontier (those are already 88 above).
  if (/coder|[-.]code\b|code-[0-9]/.test(s)) return 66;
  // Named-but-modest mid (generic "flash"/"mini"/"small"/"air" families).
  if (/flash|mini|small|air|lite|turbo/.test(s)) return 52;
  return DEFAULT_SCORE;
}

/** Tier bucket derived from the capability score (display + coarse floors). */
export function tierFromScore(score: number): CapabilityTier {
  if (score >= 80) return "frontier";
  if (score >= 45) return "mid";
  return "small";
}

/** Minimum score a candidate must clear to count as a given tier's capability. */
export const TIER_MIN_SCORE: Record<CapabilityTier, number> = { small: 0, mid: 45, frontier: 80 };

/** Coarse tier from the model name (derived from the curated score). */
export function classifyTier(name: string): CapabilityTier {
  return tierFromScore(capabilityScore(name));
}

function normKey(provider: string, id: string): string {
  return `${provider}:${id}`.toLowerCase();
}

/** Normalize a model name/id for fuzzy matching across sources — strips the
 * `@cf/` and `provider/` prefixes and all non-alphanumerics. */
export function normalizeModelName(s: string): string {
  return s
    .toLowerCase()
    .replace(/^@cf\//, "")
    .replace(/^[a-z0-9-]+\//, "")
    .replace(/[^a-z0-9]/g, "");
}

/** Find the catalog entry that best matches a model name/id (exact norm first,
 * then either-direction substring containment). */
export function matchCatalogModel(catalog: CatalogModel[], name: string): CatalogModel | undefined {
  const n = normalizeModelName(name);
  return (
    catalog.find((c) => normalizeModelName(c.id) === n || normalizeModelName(c.name) === n) ??
    catalog.find(
      (c) => normalizeModelName(c.id).includes(n) || n.includes(normalizeModelName(c.id)),
    )
  );
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
        score: capabilityScore(`${m.id} ${m.name ?? ""}`),
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
      score: capabilityScore(`${m.id} ${m.name ?? ""} ${m.family ?? ""}`),
      tier: classifyTier(`${m.id} ${m.name ?? ""} ${m.family ?? ""}`),
      source: "aipricing",
    }));
}

/**
 * Ollama Cloud: fetch available models via `GET /api/tags` (the same endpoint
 * local Ollama exposes, hosted at ollama.com). Requires `OLLAMA_API_KEY` in the
 * Secrets Store — skipped silently when unset so the catalog degrades gracefully.
 *
 * Pricing is not returned by the list API and is stored as null. These entries
 * are included in the catalog for model-resolution and discovery (AI Router,
 * recommendations engine) even though the cost advisor can't price-compare them.
 */
async function fetchOllama(env: Env): Promise<CatalogModel[]> {
  const token = await getOllamaApiKey(env);
  if (!token) return [];
  const res = await fetch(OLLAMA_CLOUD_URL, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Ollama Cloud HTTP ${res.status}`);
  const body = (await res.json()) as { models?: { name?: string; model?: string; details?: { family?: string; parameter_size?: string } }[] };
  return (body.models ?? [])
    .filter((m) => {
      const id = m.model ?? m.name ?? "";
      return id && isChatModel(`${id} ${m.details?.family ?? ""}`);
    })
    .map((m): CatalogModel => {
      const id = m.model ?? m.name ?? "";
      const label = `${id} ${m.details?.family ?? ""} ${m.details?.parameter_size ?? ""}`.trim();
      return {
        key: normKey("ollama", id),
        id,
        name: m.name ?? id,
        provider: "ollama",
        inPerM: null,
        outPerM: null,
        cachedInPerM: null,
        context: null,
        score: capabilityScore(label),
        tier: classifyTier(label),
        source: "ollama",
      };
    });
}

/** The Worker's own `ai_model_pricing` catalog (now Cloudflare Workers AI only),
 * newest row per (provider, api_model_name), as candidates. Queried directly
 * rather than via ai-model-advisor to keep this module out of an import cycle. */
async function fetchScraped(env: Env): Promise<CatalogModel[]> {
  const all = await getDb(env).select().from(aiModelPricing).orderBy(desc(aiModelPricing.scrapedAt));
  const seen = new Set<string>();
  const rows = all.filter((r) => {
    const key = `${r.provider}::${r.apiModelName}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return rows.map((r): CatalogModel => ({
    key: normKey(r.provider, r.apiModelName),
    id: r.apiModelName,
    name: r.model,
    provider: r.provider,
    inPerM: r.inputPricePerMillion,
    outPerM: r.outputPricePerMillion,
    cachedInPerM: r.cachedInputPricePerMillion,
    context: null,
    score: capabilityScore(`${r.apiModelName} ${r.model}`),
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
  const [openrouter, aipricing, scraped, ollama] = await Promise.all([
    fetchOpenRouter(env).catch((e) => {
      console.warn(JSON.stringify({ level: "WARN", source: "modelCatalog.openrouter", error: String(e) }));
      return [] as CatalogModel[];
    }),
    fetchAiPricingGuru().catch((e) => {
      console.warn(JSON.stringify({ level: "WARN", source: "modelCatalog.aipricing", error: String(e) }));
      return [] as CatalogModel[];
    }),
    fetchScraped(env).catch(() => [] as CatalogModel[]),
    fetchOllama(env).catch((e) => {
      console.warn(JSON.stringify({ level: "WARN", source: "modelCatalog.ollama", error: String(e) }));
      return [] as CatalogModel[];
    }),
  ]);

  // Priority order defines which source wins a key collision.
  // Ollama entries have null pricing (list API doesn't expose it) but are still
  // included for model-resolution and discovery — the cost advisor skips null-priced
  // candidates via its own filter, so they don't pollute savings recommendations.
  const merged = new Map<string, CatalogModel>();
  for (const m of [...aipricing, ...scraped, ...ollama, ...openrouter]) {
    if (m.inPerM === null && m.outPerM === null && m.source !== "ollama") continue; // unpriced non-ollama → not a candidate
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
