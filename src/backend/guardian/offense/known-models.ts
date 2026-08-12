/**
 * @fileoverview `getKnownBilledModels` — the exact model-ID allowlist the text
 * scanners match against, drawn from what core-guardian ALREADY knows it bills.
 *
 * The Spend Offense text scanner regexes repo/CI text for AI usage. A bare
 * `@cf/…` regex is too broad — `@cf/kv-asset-handler`, `@cf/workers-types`, and
 * other non-model packages share the prefix and cause false positives. Instead
 * we match the EXACT model strings core-guardian sees in its own billing/catalog
 * data: a literal `@cf/openai/gpt-oss-120b` (or `claude-sonnet-4-5`, etc.) in the
 * scanned text is a definitive AI signal; a random `@cf/foo` is not.
 *
 * Two D1 sources, deduped (cheapest reliable columns — no GraphQL):
 *   - `ai_model_pricing.api_model_name` — the maintained multi-provider catalog;
 *     its column doc is literally "Exact id to pass to the API/SDK" (Workers AI,
 *     Anthropic, Google, OpenAI). Refreshed weekly.
 *   - `ai_gateway_costs.model` — model ids Cloudflare actually recorded for
 *     AI-Gateway traffic. Catches a provider model that's been billed but is not
 *     (yet) in the scraped catalog.
 *
 * A brand-new Workers AI model present in neither table is still caught by the
 * structural `@cf/<vendor>/<model>` shape fallback in `detectAiSignals` — this
 * list is the precise layer, the shape check is the safety net.
 *
 * @see {@link file://src/backend/guardian/offense/classify.ts} for the matcher.
 * @see {@link file://src/backend/db/schemas/governance/ai-model-pricing.ts}
 * @see {@link file://src/backend/db/schemas/governance/ai-gateway-costs.ts}
 */

import { getDb } from "@/backend/db";
import { aiGatewayCosts, aiModelPricing } from "@/backend/db/schema";

/**
 * Returns the deduped set of exact model-ID strings core-guardian has in its
 * billing/catalog data (e.g. `@cf/openai/gpt-oss-120b`, `claude-sonnet-4-5`).
 *
 * Fetched ONCE per scan and passed into every per-file `detectAiSignals` call —
 * never call this per file. Degrades to `[]` on empty/missing data or a query
 * error, so a cold catalog just falls back to the structural shape check rather
 * than throwing mid-scan.
 *
 * @param env - Worker env carrying the `DB` D1 binding
 * @returns Distinct non-empty model IDs from the catalog + observed gateway costs
 */
export async function getKnownBilledModels(env: Env): Promise<string[]> {
  const db = getDb(env);
  try {
    const [catalog, gateway] = await Promise.all([
      db.selectDistinct({ model: aiModelPricing.apiModelName }).from(aiModelPricing),
      db.selectDistinct({ model: aiGatewayCosts.model }).from(aiGatewayCosts),
    ]);
    const set = new Set<string>();
    for (const r of [...catalog, ...gateway]) {
      const m = r.model?.trim();
      if (m) set.add(m);
    }
    return [...set];
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: "WARN",
        source: "guardian.offense.knownModels",
        error: String(err),
      }),
    );
    return [];
  }
}
