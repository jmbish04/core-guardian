/**
 * @fileoverview Ollama Cloud provider — real-time model validation + quota
 * usage tracking. Backs the `provider: "ollama"` path in the AI Router.
 *
 * WHY THIS EXISTS
 *   Ollama Cloud is a flat-rate subscription ($20/mo, no per-token billing), so
 *   its spend never shows up in the token-cost roll-up other providers feed.
 *   Two things still matter for a metered proxy:
 *     1. Reject calls for models the account can't serve (real-time validation).
 *     2. Track how much of the session/weekly quota is burned (usage tracking).
 *
 * TWO DATA SOURCES, TWO AUTH MECHANISMS
 *   • Model list — GET https://ollama.com/api/tags via the official `ollama`
 *     SDK, Bearer-authed with OLLAMA_CLOUD_API_KEY. Cached in OLLAMA_KV for 1 h
 *     (see {@link getAuthoritativeOllamaModels}).
 *   • Quota usage — there is NO usage JSON API. The numbers are only rendered
 *     server-side into https://ollama.com/settings, so we fetch that page with
 *     the dashboard session cookie (OLLAMA_SESSION_COOKIE, the `__Secure-session`
 *     value) and parse the `data-*` attributes off the progress-bar markup
 *     (see {@link fetchOllamaUsage}). Verified reachable by a bare server fetch —
 *     no bot-wall, auth is the only gate.
 *
 * BILLING
 *   Subscription = $0 per call. Router records tokens for observability but
 *   sets costUsd = 0 and exempts Ollama from the catalog-priceability guard.
 *
 * SECRETS (both are Secret Store bindings, async `.get()`):
 *   OLLAMA_CLOUD_API_KEY   — inference + model list (Bearer)
 *   OLLAMA_SESSION_COOKIE  — dashboard scrape (__Secure-session cookie value).
 *                            Rotate when it expires (~6 months).
 */
import { Ollama } from "ollama";
import { z } from "zod";
import { getSecretStoreBinding } from "@/backend/utils/secrets";

// -----------------------------------------------------------------------------
// Schemas
// -----------------------------------------------------------------------------

const OllamaModelDetailsSchema = z.object({
  format: z.string().optional(),
  family: z.string().optional(),
  families: z.array(z.string()).nullable().optional(),
  parameter_size: z.string().optional(),
  quantization_level: z.string().optional(),
});

const OllamaModelSchema = z.object({
  name: z.string(),
  model: z.string(),
  modified_at: z.string(),
  size: z.number(),
  digest: z.string(),
  details: OllamaModelDetailsSchema.optional(),
});

const OllamaTagsResponseSchema = z.object({
  models: z.array(OllamaModelSchema),
});

const CachedOllamaModelsSchema = z.object({
  authoritative_timestamp: z.number(),
  models: z.array(OllamaModelSchema),
});

export type OllamaModel = z.infer<typeof OllamaModelSchema>;
export type OllamaTagsResponse = z.infer<typeof OllamaTagsResponseSchema>;
export type CachedOllamaModels = z.infer<typeof CachedOllamaModelsSchema>;

export interface OllamaUsageSegment {
  model: string;
  requests: number;
  widthPercent: number;
}

export interface OllamaUsagePeriod {
  percentageUsed: number;
  resetsAt: string;   // ISO 8601
  resetsIn: string;   // human label from the page e.g. "1 hour" / "2 days"
  segments: OllamaUsageSegment[];
}

export interface OllamaUsageMetrics {
  plan: string;        // "pro" | "free" | "max" | …
  scrapedAt: number;   // ms epoch
  session: OllamaUsagePeriod;
  weekly: OllamaUsagePeriod;
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const OLLAMA_HOST = "https://ollama.com";
const SETTINGS_URL = "https://ollama.com/settings"; // usage scrape (cookie-authed)
const MODELS_CACHE_KEY = "ollama:cloud:models:latest";
const CACHE_FRESHNESS_TTL_MS = 60 * 60 * 1000; // 1 hour

// -----------------------------------------------------------------------------
// Model cache + validation
// -----------------------------------------------------------------------------

/** Live model list from Ollama Cloud via the SDK (`.list()` → GET /api/tags). */
async function fetchModelsFromCloud(apiKey: string): Promise<OllamaModel[]> {
  const ollama = new Ollama({ host: OLLAMA_HOST, headers: { Authorization: `Bearer ${apiKey}` } });
  const response = await ollama.list();
  return OllamaTagsResponseSchema.parse(response).models;
}

/**
 * The authoritative model list, KV-cached for 1 hour. Returns the cached record
 * when it is fresh; otherwise re-fetches from Ollama Cloud, stamps it with the
 * fetch time, and overwrites the KV record.
 *
 * @param forceRefresh - skip the cache read and always re-fetch.
 * @throws if OLLAMA_CLOUD_API_KEY is unset or the SDK/fetch fails. Callers that
 *   must not fail closed (e.g. {@link validateOllamaModel}) catch this.
 */
export async function getAuthoritativeOllamaModels(env: Env, forceRefresh = false): Promise<CachedOllamaModels> {
  const now = Date.now();

  if (!forceRefresh) {
    const cached = await env.OLLAMA_KV.get(MODELS_CACHE_KEY, "text");
    if (cached) {
      try {
        const parsed = CachedOllamaModelsSchema.parse(JSON.parse(cached));
        if (now - parsed.authoritative_timestamp < CACHE_FRESHNESS_TTL_MS) return parsed;
      } catch {
        // stale/corrupt — fall through to refresh
      }
    }
  }

  const apiKey = await getSecretStoreBinding(env, "OLLAMA_CLOUD_API_KEY");
  if (!apiKey) throw new Error("OLLAMA_CLOUD_API_KEY not configured in the Secret Store.");

  const models = await fetchModelsFromCloud(apiKey);
  const record: CachedOllamaModels = { authoritative_timestamp: now, models };
  await env.OLLAMA_KV.put(MODELS_CACHE_KEY, JSON.stringify(record));
  return record;
}

/**
 * Real-time gate: is `model` servable by this Ollama Cloud account?
 *
 * Returns `null` when valid, or a human-readable error string when the model is
 * not in the account's list. Matches the exact name/model id, and also accepts a
 * bare base name against any tagged variant (e.g. "llama3" ⇒ "llama3:8b").
 *
 * FAILS OPEN: on any SDK/network/cache error it logs a WARN and returns `null`,
 * so a transient Ollama outage degrades to "allow" rather than blocking every
 * inference call. (`apiKey` is accepted for signature symmetry with the other
 * providers' resolveKey path; the model list is fetched via the KV cache.)
 */
export async function validateOllamaModel(env: Env, apiKey: string, model: string): Promise<string | null> {
  let record: CachedOllamaModels;
  try {
    record = await getAuthoritativeOllamaModels(env);
  } catch (err) {
    // ponytail: fail open — tags blip must not block inference
    console.warn(JSON.stringify({ level: "WARN", source: "ollama.validateModel", model, error: String(err) }));
    return null;
  }

  const names = new Set(record.models.flatMap((m) => [m.name, m.model]));
  if (names.has(model)) return null;

  // Accept base name without tag qualifier (e.g. "llama3" matches "llama3:8b").
  const base = model.split(":")[0];
  if ([...names].some((n) => n === base || n.startsWith(`${base}:`))) return null;

  return `Model "${model}" is not available on Ollama Cloud. Check https://ollama.com/library for available models.`;
}

// -----------------------------------------------------------------------------
// Usage scraping — https://ollama.com/settings (server-rendered HTML)
// -----------------------------------------------------------------------------
// The settings page has no JSON API. Usage data lives in data-* attributes on
// progress-bar <button> segments:
//   aria-label="Session usage 47.1% used"       ← percentage
//   data-time="2026-08-21T16:00:00Z"             ← reset ISO timestamp
//   Resets in 1 hour.                            ← human label
//   data-usage-segment data-model="x" data-requests="306" style="width:64.2%"

/** Extract all occurrences of one named HTML attribute from a substring. */
function attrAll(html: string, attr: string): string[] {
  const re = new RegExp(`${attr}="([^"]*)"`, "g");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

function attr(html: string, attr: string): string {
  return attrAll(html, attr)[0] ?? "";
}

/** Parse a `data-usage-track` section (session or weekly) from its HTML slice. */
function parsePeriod(html: string): OllamaUsagePeriod {
  // aria-label="Session usage 100% used" or "Weekly usage 47.1% used"
  const pctMatch = html.match(/aria-label="(?:Session|Weekly) usage ([\d.]+)% used"/);
  const percentageUsed = pctMatch ? parseFloat(pctMatch[1]) : 0;

  // <div class="... local-time" data-time="2026-08-21T16:00:00Z" ...>
  const resetsAt = attr(html, "data-time");

  // "Resets in 1 hour." / "Resets in 2 days."
  const resetsInMatch = html.match(/Resets in ([^.<]+)\./);
  const resetsIn = resetsInMatch ? resetsInMatch[1].trim() : "";

  // Segments: <button ... data-usage-segment ... data-model="x" data-requests="N" style="width:W%">
  const segRe = /<button[^>]+data-usage-segment[^>]*>/g;
  const segments: OllamaUsageSegment[] = [];
  let m: RegExpExecArray | null;
  while ((m = segRe.exec(html)) !== null) {
    const tag = m[0];
    const model = attr(tag, "data-model");
    const requests = parseInt(attr(tag, "data-requests") || "0", 10);
    const widthMatch = tag.match(/width:\s*([\d.]+)%/);
    const widthPercent = widthMatch ? parseFloat(widthMatch[1]) : 0;
    if (model) segments.push({ model, requests, widthPercent });
  }

  return { percentageUsed, resetsAt, resetsIn, segments };
}

/**
 * Current session + weekly quota usage, scraped from https://ollama.com/settings.
 *
 * There is no usage JSON API — the page renders the numbers server-side, so we
 * fetch the HTML with the dashboard cookie and parse it. The markup is split at
 * the "Weekly usage" marker so each period's segments are attributed correctly.
 *
 * @throws if OLLAMA_SESSION_COOKIE is unset, or the page returns non-2xx (e.g.
 *   303 → cookie expired; rotate it). This one fails CLOSED (no fallback) — it's
 *   an observability read, never on the inference hot path.
 */
export async function fetchOllamaUsage(env: Env): Promise<OllamaUsageMetrics> {
  const sessionCookie = await getSecretStoreBinding(env, "OLLAMA_SESSION_COOKIE");
  if (!sessionCookie) throw new Error("OLLAMA_SESSION_COOKIE not configured in the Secret Store.");

  const res = await fetch(SETTINGS_URL, {
    headers: {
      Cookie: `__Secure-session=${sessionCookie}`,
      Accept: "text/html",
      "User-Agent": "core-guardian/1.0 (usage-tracker)",
    },
  });

  if (!res.ok) throw new Error(`ollama.com/settings returned ${res.status}`);

  const html = await res.text();

  // Plan badge — appears in "Cloud usage <span ...>pro</span>"
  const planMatch = html.match(/Cloud usage[\s\S]{0,200}?<span[^>]*>([^<]+)<\/span>/);
  const plan = planMatch ? planMatch[1].trim().toLowerCase() : "unknown";

  // Split at "Weekly usage" to separate session vs weekly sections.
  const weeklyIdx = html.indexOf('aria-label="Weekly usage');
  const sessionHtml = weeklyIdx > 0 ? html.slice(0, weeklyIdx) : html;
  const weeklyHtml = weeklyIdx > 0 ? html.slice(weeklyIdx) : "";

  return {
    plan,
    scrapedAt: Date.now(),
    session: parsePeriod(sessionHtml),
    weekly: parsePeriod(weeklyHtml),
  };
}

// Self-check — verifies the HTML parser against a fixture mirroring the real
// /settings markup. Run with `bun src/backend/guardian/ai-router/ollama.ts`.
if (import.meta.main) {
  const eq = (a: unknown, b: unknown, m: string) => { if (a !== b) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); };
  const fixture = `
    <span>Cloud usage</span><span class="badge">Pro</span>
    <div data-usage-track aria-label="Session usage 4.3% used">
      <button data-usage-segment style="width: 100%; background:#3b82f6" data-model="kimi-k2.7-code" data-requests="40"></button>
    </div>
    <div class="local-time" data-time="2026-08-22T07:00:00Z">Resets in 2 hours.</div>
    <div data-usage-track aria-label="Weekly usage 48.3% used">
      <button data-usage-segment style="width: 41.4%" data-model="glm-5.2" data-requests="601"></button>
      <button data-usage-segment style="width: 54.8%" data-model="deepseek-v4-pro:0813" data-requests="1009"></button>
    </div>
    <div class="local-time" data-time="2026-08-24T00:00:00Z">Resets in 1 day.</div>`;

  const weeklyIdx = fixture.indexOf('aria-label="Weekly usage');
  const session = parsePeriod(fixture.slice(0, weeklyIdx));
  const weekly = parsePeriod(fixture.slice(weeklyIdx));

  eq(session.percentageUsed, 4.3, "session %");
  eq(session.resetsAt, "2026-08-22T07:00:00Z", "session resetsAt");
  eq(session.resetsIn, "2 hours", "session resetsIn");
  eq(session.segments.length, 1, "session segment count");
  eq(session.segments[0].model, "kimi-k2.7-code", "session model");
  eq(session.segments[0].requests, 40, "session requests");
  eq(weekly.percentageUsed, 48.3, "weekly %");
  eq(weekly.segments.length, 2, "weekly segment count");
  eq(weekly.segments[1].model, "deepseek-v4-pro:0813", "weekly model 2");
  eq(weekly.segments[1].widthPercent, 54.8, "weekly width 2");
  // Base-name match: "llama3" accepts a tagged "llama3:8b".
  const names = new Set(["llama3:8b", "gpt-oss:120b"]);
  const base = "llama3".split(":")[0];
  eq([...names].some((n) => n === base || n.startsWith(`${base}:`)), true, "base-name match");
  // eslint-disable-next-line no-console
  console.log("ok — ollama parser verified");
}
