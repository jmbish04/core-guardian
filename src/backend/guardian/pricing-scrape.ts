/**
 * @fileoverview Monthly pricing-doc scrape — the only source of overage unit
 * rates, because Cloudflare has no pricing API.
 *
 * Cloudflare's pricing docs (developers.cloudflare.com) are static,
 * server-rendered pages: the full rate table is present in the HTML on a plain
 * `fetch()`, no browser required. So each doc is fetched, stripped to text, and
 * handed to Workers AI to extract the rate rows. (Browser Rendering was the
 * original plan, but it renders + runs an LLM server-side, which is both slower
 * and needs a Browser-Rendering-scoped token — pure overkill for static HTML.)
 *
 * Each scrape writes one `scrape_runs` row (keeping the stripped text for audit
 * and re-extraction) and appends the extracted rates to `pricing_revisions`,
 * append-only so a rate change is a new row, not a mutation.
 *
 * @see {@link file://src/backend/db/schemas/governance/pricing.ts} for the tables.
 */

import { getDb } from "@/backend/db";
import { pricingRevisions, scrapeRuns } from "@/backend/db/schema";

import { ALLOWANCES } from "./allowances";

/** One extracted rate row, product-agnostic. */
type Rate = {
  metric: string;
  unitPrice: number;
  perUnits: number;
  currency: string;
  included: number | null;
};

/** Products grouped by their pricing doc URL (several products share a doc). */
function docTargets(): { url: string; products: string[] }[] {
  const byUrl = new Map<string, string[]>();
  for (const a of Object.values(ALLOWANCES)) {
    (byUrl.get(a.docUrl) ?? byUrl.set(a.docUrl, []).get(a.docUrl)!).push(a.probeId);
  }
  return [...byUrl.entries()].map(([url, products]) => ({ url, products }));
}

/** Fetches a doc and strips it to readable text (scripts/styles/tags removed). */
async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "user-agent": "core-guardian-pricing-scrape" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
  return stripped;
}

/** Coerces an untrusted extracted rate array into clean Rate rows. */
function cleanRates(raw: unknown): Rate[] {
  const arr = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? (raw as { rates?: unknown }).rates
      : null;
  if (!Array.isArray(arr)) return [];
  const out: Rate[] = [];
  for (const r of arr) {
    if (!r || typeof r !== "object") continue;
    const metric = String((r as any).metric ?? "").trim();
    const unitPrice = Number((r as any).unitPrice);
    const perUnits = Number((r as any).perUnits);
    if (!metric || !Number.isFinite(unitPrice) || unitPrice < 0) continue;
    const includedRaw = (r as any).included;
    out.push({
      metric: metric.slice(0, 120),
      unitPrice,
      perUnits: Number.isFinite(perUnits) && perUnits > 0 ? perUnits : 1,
      currency: "USD",
      included: Number.isFinite(Number(includedRaw)) ? Number(includedRaw) : null,
    });
  }
  return out;
}

/** JSON schema forcing gpt-oss to emit clean, parseable rate rows. */
const RATE_RESPONSE_SCHEMA = {
  type: "json_schema",
  json_schema: {
    type: "object",
    properties: {
      rates: {
        type: "array",
        items: {
          type: "object",
          properties: {
            metric: { type: "string" },
            unitPrice: { type: "number" },
            perUnits: { type: "number" },
            included: { type: ["number", "null"] },
          },
          required: ["metric", "unitPrice", "perUnits"],
        },
      },
    },
    required: ["rates"],
  },
} as const;

/** Reads the text output across Workers AI shapes (gpt-oss uses OpenAI choices). */
function readAiText(res: any): string {
  return (
    res?.response ??
    res?.result?.response ??
    res?.choices?.[0]?.message?.content ??
    res?.result?.choices?.[0]?.message?.content ??
    ""
  );
}

/** Workers AI pulls the rate table out of the stripped page text. */
async function extractRates(env: Env, text: string): Promise<Rate[]> {
  const model = (env as any).MODEL_EXTRACT || "@cf/openai/gpt-oss-120b";
  const prompt = `Extract Cloudflare overage pricing rows from this pricing page text into the required JSON.
- metric: the metered dimension, e.g. "rows read", "GB stored per month", "requests".
- unitPrice: the USD overage price number, e.g. 0.001 for "$0.001 / million rows".
- perUnits: how many metric units unitPrice covers, e.g. 1000000 for a "/ million" rate, 1 for a per-single-unit rate.
- included: the free monthly allowance quantity stated for that metric as a plain number, or null.
Ignore flat plan fees ($5/month) and free-tier-only rows. One row per metered dimension.

Page text:
${text.slice(0, 14000)}`;
  let res: any;
  try {
    res = await env.AI.run(model, {
      messages: [{ role: "user", content: prompt }],
      max_tokens: 2048,
      response_format: RATE_RESPONSE_SCHEMA,
    });
  } catch {
    return [];
  }
  const raw: string = readAiText(res);
  if (!raw) return [];
  // With json_schema the whole response is the JSON object; still guard with a
  // brace-slice for models that prepend reasoning.
  try {
    return cleanRates(JSON.parse(raw));
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return [];
    try {
      return cleanRates(JSON.parse(match[0]));
    } catch {
      return [];
    }
  }
}

/**
 * Scrapes one pricing doc and persists the run + any extracted revisions.
 */
export async function scrapeDoc(
  env: Env,
  target: { url: string; products: string[] },
): Promise<{ status: string; revisions: number }> {
  const db = getDb(env);
  const runId = crypto.randomUUID();
  const product = target.products[0];
  const now = Date.now();

  let text = "";
  let rates: Rate[] = [];
  let error: string | null = null;

  try {
    text = await fetchText(target.url);
    rates = await extractRates(env, text);
    if (rates.length === 0) error = "extraction returned no rates";
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const status: "ok" | "partial" | "failed" =
    rates.length > 0 ? "ok" : text ? "partial" : "failed";

  await db.insert(scrapeRuns).values({
    id: runId,
    url: target.url,
    product,
    status,
    method: "markdown_ai",
    markdown: text ? text.slice(0, 20000) : null,
    rawJson: null,
    revisionsWritten: rates.length,
    error,
    ranAt: now,
  });

  if (rates.length > 0) {
    const rows = rates.map((r) => ({
      id: crypto.randomUUID(),
      scrapeRunId: runId,
      product,
      metric: r.metric,
      unitPrice: r.unitPrice,
      perUnits: r.perUnits,
      currency: r.currency,
      included: r.included,
      effectiveFrom: now,
    }));
    // pricing_revisions has 9 columns; chunk at 11 rows (99 params) under the
    // D1 100-bound-parameter cap.
    for (let i = 0; i < rows.length; i += 11) {
      await db.insert(pricingRevisions).values(rows.slice(i, i + 11));
    }
  }

  return { status, revisions: rates.length };
}

/** Scrapes the single doc that a product's allowance points at. */
export async function scrapeOneProduct(
  env: Env,
  product: string,
): Promise<{ status: string; revisions: number }> {
  const a = ALLOWANCES[product];
  if (!a) return { status: "unknown-product", revisions: 0 };
  const products = Object.values(ALLOWANCES)
    .filter((x) => x.docUrl === a.docUrl)
    .map((x) => x.probeId);
  return await scrapeDoc(env, { url: a.docUrl, products });
}

/**
 * Scrapes every distinct pricing doc. Sequential and cheap now that it is a
 * plain fetch + one AI call per doc; runs at most monthly.
 */
export async function scrapeAllPricing(env: Env): Promise<{ docs: number; revisions: number }> {
  const targets = docTargets();
  let revisions = 0;
  for (const target of targets) {
    const { revisions: n } = await scrapeDoc(env, target).catch(() => ({ revisions: 0 }));
    revisions += n;
  }
  return { docs: targets.length, revisions };
}
