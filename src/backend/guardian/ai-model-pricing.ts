/**
 * @fileoverview Weekly AI model-pricing catalog scraper.
 *
 * Refreshes `ai_model_pricing` (append-only) from four sources:
 *  - Anthropic / Google / OpenAI: fetch the public pricing markdown (plain
 *    fetch + a User-Agent; no browser render) and normalize with a Workers AI
 *    extraction pass into per-million-token input/output prices + a short
 *    description and best-used-for.
 *  - Cloudflare Workers AI: the models API already returns structured USD
 *    per-million pricing in each model's `price` property — parsed directly, no
 *    AI needed, no neuron conversion.
 *
 * The latest snapshot is also cached in KV (SESSIONS, key `ai-model-pricing:latest`)
 * so the list endpoint can answer without a D1 scan.
 *
 * @see {@link file://src/backend/db/schemas/governance/ai-model-pricing.ts}
 */

import { getDb } from "@/backend/db";
import { aiModelPricing, type NewAiModelPricingRow } from "@/backend/db/schema";
import { getCloudflareAccountId, getCloudflareApiToken } from "@/backend/utils/secrets";

const UA = "core-guardian-pricing/1.0 (+https://core-guardian.hacolby.workers.dev)";
export const PRICING_CACHE_KEY = "ai-model-pricing:latest";

const DOC_SOURCES: { provider: string; url: string }[] = [
  { provider: "anthropic", url: "https://platform.claude.com/docs/en/about-claude/pricing.md" },
  { provider: "google", url: "https://ai.google.dev/gemini-api/docs/pricing.md.txt" },
  { provider: "openai", url: "https://developers.openai.com/api/docs/pricing.md" },
];

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

/** Read text output across Workers AI response shapes (gpt-oss uses choices). */
function readAiText(res: any): string {
  return (
    res?.response ??
    res?.result?.response ??
    res?.choices?.[0]?.message?.content ??
    res?.result?.choices?.[0]?.message?.content ??
    ""
  );
}

const EXTRACT_SCHEMA = {
  type: "json_schema",
  json_schema: {
    type: "object",
    properties: {
      models: {
        type: "array",
        items: {
          type: "object",
          properties: {
            model: { type: "string" },
            apiModelName: { type: "string" },
            inputPricePerMillion: { type: ["number", "null"] },
            outputPricePerMillion: { type: ["number", "null"] },
            cachedInputPricePerMillion: { type: ["number", "null"] },
            description: { type: ["string", "null"] },
            bestUsedFor: { type: ["string", "null"] },
          },
          required: ["model", "apiModelName"],
        },
      },
    },
    required: ["models"],
  },
} as const;

function cleanNum(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Extract model records from one provider's pricing markdown via Workers AI. */
async function scrapeDoc(env: Env, provider: string, url: string): Promise<ModelRecord[]> {
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "text/plain, text/markdown, */*" } });
  if (!res.ok) throw new Error(`${provider} ${res.status}`);
  const text = await res.text();

  // OpenAI ships a JS array, not a table — parse it deterministically.
  if (provider === "openai") return parseOpenAi(text);

  const model = (env as any).MODEL_EXTRACT || "@cf/openai/gpt-oss-120b";
  const prompt = `You are extracting AI text-model token pricing from this ${provider} pricing page. Extract EVERY text/chat model listed in the pricing tables — do not stop at the first row, do not summarize. ${provider} typically lists several models and versions.
For each model return:
- apiModelName: the EXACT id passed to the API/SDK (e.g. "claude-sonnet-4-5", "gemini-2.5-pro", "gpt-4o", "gpt-4o-mini"). If only a display name is shown, use the canonical API id.
- inputPricePerMillion / outputPricePerMillion: USD per 1,000,000 tokens. If the page lists a per-1,000 (per-1K) price, MULTIPLY BY 1000. Use the standard base rate (not cached, not batch, not priority).
- cachedInputPricePerMillion: the prompt-caching input rate per 1M if shown, else null.
- description: one short sentence.
- bestUsedFor: a few words (e.g. "agentic coding", "cheap high-volume", "vision", "long context").
Return exactly ONE row per model — its standard BASE rate. If a model's price varies by context length or paid tier, use the base/standard tier (the lower context-length threshold, paid tier — not free, not batch, not the long-context surcharge). Do not emit the same model twice.
Tables may be Markdown pipes OR embedded HTML (<table>) — read both. Ignore image/audio/video/embedding-only rows and cache-write multiplier columns.

Pricing page:
${text.slice(0, 42000)}`;

  let raw = "";
  try {
    const out: any = await env.AI.run(model, {
      messages: [{ role: "user", content: prompt }],
      max_tokens: 8192,
      response_format: EXTRACT_SCHEMA,
    });
    raw = readAiText(out);
  } catch {
    return [];
  }
  if (!raw) return [];
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return [];
    try {
      parsed = JSON.parse(m[0]);
    } catch {
      return [];
    }
  }
  const arr = Array.isArray(parsed?.models) ? parsed.models : [];
  const out: ModelRecord[] = [];
  for (const r of arr) {
    const apiModelName = String(r?.apiModelName ?? "").trim();
    if (!apiModelName) continue;
    out.push({
      provider,
      model: String(r?.model ?? apiModelName).slice(0, 120),
      apiModelName: apiModelName.slice(0, 120),
      description: r?.description ? String(r.description).slice(0, 300) : null,
      bestUsedFor: r?.bestUsedFor ? String(r.bestUsedFor).slice(0, 120) : null,
      inputPricePerMillion: cleanNum(r?.inputPricePerMillion),
      outputPricePerMillion: cleanNum(r?.outputPricePerMillion),
      cachedInputPricePerMillion: cleanNum(r?.cachedInputPricePerMillion),
      sourceUrl: url,
    });
  }
  return out;
}

/**
 * OpenAI's pricing page embeds a JS array, not a table:
 *   <PricingTables tier="standard" rows={[ ["gpt-4o", 2.5, 1.25, 10], … ]}>
 * where each row is [modelName, inputPerM, cachedInputPerM, …, outputPerM]
 * (prices already per 1M tokens). Deterministic parsing beats AI extraction
 * here. We isolate the "standard" tier pane so batch/flex/priority tiers don't
 * duplicate rows, then take input = first number, output = last number.
 */
function parseOpenAi(text: string): ModelRecord[] {
  const url = "https://developers.openai.com/api/docs/pricing.md";
  // Isolate the standard-tier region so we don't pull batch/priority duplicates.
  const startIdx = text.indexOf('data-value="standard"');
  const region = startIdx >= 0 ? text.slice(startIdx, startIdx + 6000) : text;

  const out: ModelRecord[] = [];
  const seen = new Set<string>();
  // Match ["model-name", n, n, ... ] rows. Names may contain spaces/parens.
  const rowRe = /\[\s*"([^"]+)"\s*,\s*([^\]]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(region)) !== null) {
    const name = m[1].trim();
    // Skip obvious non-model header/label rows.
    if (!/^(gpt|o\d|chatgpt|text-|davinci|codex)/i.test(name)) continue;
    const apiModelName = name.replace(/\s*\(.*\)$/, "").trim(); // drop "(<272K …)"
    if (seen.has(apiModelName)) continue;
    // Numbers in the tail (treat "-"/null as gaps).
    const nums = m[2]
      .split(",")
      .map((x) => x.trim())
      .map((x) => (x === '"-"' || x === "null" || x === "-" ? null : Number(x)))
      .map((x) => (Number.isFinite(x as number) ? (x as number) : null));
    const priced = nums.filter((x): x is number => x !== null);
    if (priced.length < 2) continue;
    seen.add(apiModelName);
    out.push({
      provider: "openai",
      model: name.slice(0, 120),
      apiModelName: apiModelName.slice(0, 120),
      description: null,
      bestUsedFor: null,
      inputPricePerMillion: priced[0], // first number = input $/1M
      outputPricePerMillion: priced[priced.length - 1], // last number = output $/1M
      cachedInputPricePerMillion: priced.length >= 3 ? priced[1] : null,
      sourceUrl: url,
    });
  }
  return out;
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

/** Collect records for one source ("workers-ai" or a doc provider), deduped. */
async function collectProvider(env: Env, provider: string): Promise<ModelRecord[]> {
  const raw =
    provider === "workers-ai"
      ? await scrapeWorkersAi(env).catch(() => [])
      : await (async () => {
          const src = DOC_SOURCES.find((s) => s.provider === provider);
          return src ? scrapeDoc(env, src.provider, src.url).catch(() => []) : [];
        })();
  return dedupeRecords(raw);
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
  const all: ModelRecord[] = [];
  const counts: Record<string, number> = {};

  for (const provider of ["workers-ai", "anthropic", "google", "openai"]) {
    const recs = await collectProvider(env, provider);
    all.push(...recs);
    counts[provider] = recs.length;
  }

  await persist(env, all, now);

  // Cache the latest snapshot for the list endpoint.
  await env.SESSIONS.put(PRICING_CACHE_KEY, JSON.stringify({ scrapedAt: now, models: all })).catch(() => {});

  return counts;
}
