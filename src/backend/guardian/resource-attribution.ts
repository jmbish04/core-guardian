/**
 * @fileoverview Per-resource cost attribution — turns two lumped Cloudflare bill
 * lines into "which resource drove it". Closes the trust gap where the dashboard
 * shows `$588 neurons / $25 DO` but never says WHAT caused it.
 *
 * Two independent attributions, both ZERO AI (cold CF GraphQL + arithmetic):
 *
 *  1. **Durable Objects compute by script** (the ~$25 "DO Compute Duration"
 *     line). CF bills DO wall-time under one SKU; only the GraphQL analytics
 *     dataset knows which *script* burned it. We rank scripts by `wallTime`
 *     share and flag any whose wallTime/requests ratio is a large outlier — the
 *     long-lived / stuck-DO smell (huge wall-time on few requests).
 *     Dataset: `durableObjectsInvocationsAdaptiveGroups`
 *     filter `{ date_geq, date_leq }`, dimensions `{ scriptName date }`,
 *     sum `{ requests wallTime }`.
 *
 *  2. **AI Gateway coverage** (the ~$588 "Regular Twitch Neurons" line). CF
 *     bills every Workers-AI model under ONE neuron SKU; only gateway-routed
 *     calls are attributable to a model. We read the per-model gateway mix
 *     (dataset `aiGatewayRequestsAdaptiveGroups`, snapshotted into
 *     `ai_gateway_costs` by {@link snapshotGatewayCosts} — filter
 *     `{ datetimeHour_geq, datetimeHour_leq }`, dimensions `{ model provider
 *     date }`, sum `{ cost tokensIn tokensOut }` + `count`) and hand it to the
 *     accountant, which apportions the REAL billed neuron total across that mix
 *     and surfaces the non-gateway remainder as unattributable direct-AI spend.
 *     The dollar math lives in the accountant (it needs the billed total) so it
 *     stays self-checkable; this module only fetches + shapes the mix.
 *
 * @see {@link file://src/backend/lib/cloudflare-graphql.ts}  the reused GraphQL client
 * @see {@link file://src/backend/guardian/ai-gateway-costs.ts}  the reused gateway snapshot
 * @see {@link file://src/backend/guardian/offense/accountant.ts}  where these wire in
 */

import { queryAccountAnalytics } from "@/backend/lib/cloudflare-graphql";

import { queryGatewayCosts } from "./ai-gateway-costs";

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// 1. Durable Objects compute by script
// ---------------------------------------------------------------------------

/** One script's share of the DO wall-time bill. */
export interface DoScriptDriver {
  scriptName: string;
  /** Raw wall-time over the window (the GB-s billing basis), in the dataset's units. */
  wallTime: number;
  requests: number;
  /** wallTime / total wallTime across all scripts, in [0,1]. */
  wallTimeShare: number;
  /** wallTime per request — a large outlier here is the long-lived-DO smell. */
  wallTimePerRequest: number;
  /**
   * True when this script's wallTime/requests ratio is a large outlier vs the
   * median AND it holds a non-trivial share — i.e. a DO that stays alive far
   * longer per request than its peers (a stuck / long-lived instance).
   */
  longLivedSmell: boolean;
}

/** Top DO scripts by wall-time, with the long-lived-DO smell flagged. */
export interface DoComputeDrivers {
  totalWallTime: number;
  totalRequests: number;
  scripts: DoScriptDriver[];
}

const DO_QUERY = `query DoCompute($accountTag: string!, $start: Date!, $end: Date!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      durableObjectsInvocationsAdaptiveGroups(
        limit: 10000
        filter: { date_geq: $start, date_leq: $end }
      ) {
        sum { requests wallTime }
        dimensions { scriptName date }
      }
    }
  }
}`;

type DoRow = {
  sum: { requests: number; wallTime: number };
  dimensions: { scriptName: string; date: string };
};

/**
 * Reduce raw per-(script, day) DO rows to the top-`topN` scripts by wall-time,
 * with shares and the long-lived-DO outlier flag. Pure, so the ranking + smell
 * logic is self-checkable below.
 *
 * The smell heuristic: a script is flagged when its wallTime/requests ratio is
 * ≥ `smellFactor`× the median ratio across all scripts AND it carries ≥ 5% of
 * total wall-time (so a tiny script with one slow call doesn't cry wolf).
 *
 * @param rows - raw dataset rows (already fetched)
 * @param topN - how many scripts to surface (default 8)
 * @param smellFactor - outlier multiple over the median ratio (default 3)
 */
export function buildDoDrivers(rows: DoRow[], topN = 8, smellFactor = 3): DoComputeDrivers {
  // Aggregate across days per script.
  const byScript = new Map<string, { wallTime: number; requests: number }>();
  for (const r of rows) {
    const name = r.dimensions.scriptName || "(unknown)";
    const acc = byScript.get(name) ?? { wallTime: 0, requests: 0 };
    acc.wallTime += r.sum.wallTime ?? 0;
    acc.requests += r.sum.requests ?? 0;
    byScript.set(name, acc);
  }

  const totalWallTime = [...byScript.values()].reduce((s, v) => s + v.wallTime, 0);
  const totalRequests = [...byScript.values()].reduce((s, v) => s + v.requests, 0);

  // Median wall-time-per-request across all scripts with traffic (the baseline
  // a healthy DO sits at; long-lived instances tower over it).
  const ratios = [...byScript.values()]
    .filter((v) => v.requests > 0)
    .map((v) => v.wallTime / v.requests)
    .sort((a, b) => a - b);
  const medianRatio = ratios.length ? ratios[Math.floor(ratios.length / 2)] : 0;

  const scripts: DoScriptDriver[] = [...byScript.entries()]
    .map(([scriptName, v]) => {
      const wallTimePerRequest = v.requests > 0 ? v.wallTime / v.requests : v.wallTime;
      const wallTimeShare = totalWallTime > 0 ? v.wallTime / totalWallTime : 0;
      const longLivedSmell =
        medianRatio > 0 &&
        wallTimePerRequest >= medianRatio * smellFactor &&
        wallTimeShare >= 0.05;
      return {
        scriptName,
        wallTime: v.wallTime,
        requests: v.requests,
        wallTimeShare,
        wallTimePerRequest,
        longLivedSmell,
      };
    })
    .sort((a, b) => b.wallTime - a.wallTime)
    .slice(0, topN);

  return { totalWallTime, totalRequests, scripts };
}

/** `YYYY-MM-DD` in UTC for a Date/ms (the DO dataset filters on `Date`, not `Time`). */
function ymd(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Fetch + shape the DO-compute-by-script drivers for the trailing `days`.
 * Reuses {@link queryAccountAnalytics} (same account token + auth as every other
 * Guardian probe). Returns null when the account has no DO traffic in the window
 * (so the caller renders nothing rather than an empty panel).
 *
 * @param env - Worker env carrying the Secrets Store bindings
 * @param days - trailing window (GraphQL retains ~31 days)
 */
export async function getDoComputeDrivers(env: Env, days = 30): Promise<DoComputeDrivers | null> {
  const now = Date.now();
  const account = await queryAccountAnalytics<{
    durableObjectsInvocationsAdaptiveGroups: DoRow[];
  }>(env, DO_QUERY, {
    start: ymd(now - days * DAY_MS),
    end: ymd(now),
  });
  const rows = account.durableObjectsInvocationsAdaptiveGroups ?? [];
  if (!rows.length) return null;
  const drivers = buildDoDrivers(rows);
  return drivers.scripts.length ? drivers : null;
}

// ---------------------------------------------------------------------------
// 2. AI Gateway coverage — per-model Workers-AI mix
// ---------------------------------------------------------------------------

/** One Workers-AI model's gateway-observed usage (the attributable mix). */
export interface GatewayModelUsage {
  model: string;
  provider: string;
  /** Gateway's dollar ESTIMATE for this model (undercounts neuron billing). */
  gatewayCostUsd: number;
  tokensIn: number;
  tokensOut: number;
  calls: number;
}

/**
 * Is this gateway row a Workers-AI (neuron-billed) model? Only these belong in
 * the "Regular Twitch Neurons" attribution — third-party models (openai,
 * anthropic, …) bill per token on their own invoice, not under the neuron SKU.
 */
function isWorkersAi(provider: string, model: string): boolean {
  return provider.toLowerCase() === "workers-ai" || model.startsWith("@cf/");
}

/**
 * Read the gateway-routed Workers-AI model mix over the trailing `days` from the
 * snapshotted `ai_gateway_costs` table (reuses {@link queryGatewayCosts}, which
 * reads the persisted `aiGatewayRequestsAdaptiveGroups` snapshot — survives the
 * 31-day analytics retention). Aggregated per model across gateways, filtered to
 * neuron-billed models, ranked by gateway cost desc.
 *
 * @param env - Worker env (D1)
 * @param days - trailing window
 */
export async function getGatewayWorkersAiMix(env: Env, days = 30): Promise<GatewayModelUsage[]> {
  const now = Date.now();
  const ranges = await queryGatewayCosts(env, now - days * DAY_MS, now);

  const byModel = new Map<string, GatewayModelUsage>();
  for (const r of ranges) {
    if (!isWorkersAi(r.provider, r.model)) continue;
    const cur =
      byModel.get(r.model) ??
      {
        model: r.model,
        provider: r.provider,
        gatewayCostUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
        calls: 0,
      };
    cur.gatewayCostUsd += r.costUsd;
    cur.tokensIn += r.tokensIn;
    cur.tokensOut += r.tokensOut;
    cur.calls += r.requests;
    byModel.set(r.model, cur);
  }
  return [...byModel.values()].sort((a, b) => b.gatewayCostUsd - a.gatewayCostUsd);
}

// ---------------------------------------------------------------------------
// Self-check — pure DO ranking + smell logic. Never runs in the Worker.
// ---------------------------------------------------------------------------
if (import.meta.main) {
  const assert = (cond: boolean, m: string) => {
    if (!cond) throw new Error(m);
  };
  const near = (a: number, b: number, m: string) => {
    if (Math.abs(a - b) > 1e-6) throw new Error(`${m}: got ${a}, want ${b}`);
  };

  // Three scripts: two healthy (low ms/req), one long-lived (huge wall-time on
  // few requests) that should trip the smell flag and rank first by wall-time.
  const drivers = buildDoDrivers([
    { sum: { requests: 1000, wallTime: 1000 }, dimensions: { scriptName: "core-geek", date: "2026-08-10" } },
    { sum: { requests: 500, wallTime: 500 }, dimensions: { scriptName: "sgd-hbd-data", date: "2026-08-10" } },
    { sum: { requests: 10, wallTime: 5000 }, dimensions: { scriptName: "dopamine", date: "2026-08-10" } },
    // second day for core-geek aggregates onto the first
    { sum: { requests: 1000, wallTime: 1000 }, dimensions: { scriptName: "core-geek", date: "2026-08-11" } },
  ]);

  assert(drivers.scripts[0].scriptName === "dopamine", "long-lived DO ranks first by wallTime");
  assert(drivers.scripts[0].longLivedSmell, "dopamine flagged: 500 ms/req vs ~1 median");
  assert(!drivers.scripts[1].longLivedSmell, "healthy script not flagged");
  near(drivers.totalWallTime, 7500, "total wallTime summed across days");
  near(drivers.totalRequests, 2510, "total requests summed across days");
  near(drivers.scripts[0].wallTimeShare, 5000 / 7500, "dopamine wallTime share");
  near(drivers.scripts.find((s) => s.scriptName === "core-geek")!.wallTime, 2000, "core-geek aggregated");

  // Empty input → empty drivers, no throw.
  const empty = buildDoDrivers([]);
  assert(empty.scripts.length === 0 && empty.totalWallTime === 0, "empty input is safe");

  // eslint-disable-next-line no-console
  console.log("ok — resource-attribution DO drivers verified");
}
