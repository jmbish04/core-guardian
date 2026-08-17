/**
 * @fileoverview P9c "The Accountant" — the report that makes core-guardian the
 * owner's accountant instead of a pile of equal-weight alarms. ZERO AI: pure D1
 * queries + arithmetic (regex classify + subtraction + a run-rate).
 *
 * The screen this feeds has two layers over ONE ranked list:
 *
 *  - **Layer 1 — the official Cloudflare bill, line for line.** Every SKU the
 *    owner sees in Cloudflare's dashboard, with the SAME billed dollars: from
 *    the Billable Usage API (`ContractedCost` per `ServiceName`). Real 90d data:
 *    "Regular Twitch Neurons" $588.67, "Durable Objects Storage Rows Read"
 *    $24.24, "D1 - Rows Read (first 25B included)" $3.92. Workers AI is ~94% of
 *    the bill; D1 is a rounding error. So the list is **ranked by ACTUAL billed
 *    dollars, desc** — D1 sits quietly at $4 while Workers AI is the giant bar.
 *    That ranking IS the fix for the v1 failure (equal-weight alarms on lines
 *    that cost nothing).
 *
 *  - **Layer 2 — guardian's value-add per line.** Three things Cloudflare's bill
 *    can't give you:
 *      1. **Discrepancy** — our reconstructed estimate vs the actual billed
 *         dollars ("the math isn't mathing" — dispute evidence).
 *      2. **Attribution** — for the AI lines, WHICH model + WHICH project drove
 *         the spend (CF's bill only says "Workers AI $588").
 *      3. **Projection** — straight-line month-end run-rate on the billed series.
 *
 * Estimate → actual matching. The two sides are at different granularities: the
 * reconstructed `daily_cost` estimate has ONE total per product (one "workers-ai"
 * figure, one "d1" figure), while the CF bill splits each product into many SKU
 * lines (D1 → rows-read + rows-written + storage …). There is no per-SKU
 * estimate, so we {@link classify} both sides into a coarse product category and
 * attach the product's whole estimate to that category's **largest** billed SKU;
 * secondary SKUs in the same category get `estimateUsd: null` (honest — we can't
 * split the estimate finer than the product). For Workers AI this is exact: the
 * "Regular Twitch Neurons" line IS essentially the whole Workers-AI product.
 *
 * @see {@link file://src/backend/guardian/billable-usage.ts}  Layer 1 (actual)
 * @see {@link file://src/backend/guardian/daily-cost.ts}      the estimate side
 * @see {@link file://docs/architecture/spend-offense.md}      P9 / P10 thesis
 */

import { gte, sql } from "drizzle-orm";

import type { BillableUsageReport } from "@/backend/guardian/billable-usage";
import type { DailyCostReport } from "@/backend/guardian/daily-cost";

import { getDb } from "@/backend/db";
import { aiRouterRequests } from "@/backend/db/schema";
import { getBillableUsageReport } from "@/backend/guardian/billable-usage";
import { getDailyCostReport } from "@/backend/guardian/daily-cost";
import { projectMonthEnd, utcDayKey } from "@/backend/guardian/offense/insights";
import {
  type DoComputeDrivers,
  type GatewayModelUsage,
  getDoComputeDrivers,
  getGatewayWorkersAiMix,
} from "@/backend/guardian/resource-attribution";

const DAY_MS = 86_400_000;

/** A |discrepancyPct| at or above this (AND a >$1 gap) flags a "math isn't mathing" line. */
export const FLAG_PCT = 25;
/** Ignore percent misses on trivial dollar gaps — a 40% miss on $0.50 isn't a dispute. */
export const FLAG_USD = 1;

/** Coarse Cloudflare product buckets. `other` = anything we don't recognise. */
export type Category =
  | "ai"
  | "durable_objects"
  | "d1"
  | "r2"
  | "kv"
  | "vectorize"
  | "queues"
  | "other";

export type Severity = "low" | "medium" | "high";

/** Per-line AI attribution (null on non-AI lines — CF gives no per-resource split). */
export interface SkuAttribution {
  /** Workers-AI neuron spend split by model (from the reconstructed per-model rows). */
  byModel: { model: string; usd: number; neurons: number }[];
  /** All AI-Router-routed spend split by project + call count (CF's bill can't say who). */
  byProject: { project: string; usd: number; calls: number }[];
}

/** One Workers-AI model's slice of the neuron bill, seen through the gateway. */
export interface AiGatewayModelShare {
  model: string;
  provider: string;
  /** Gateway's own dollar estimate for this model (undercounts neuron billing). */
  gatewayCostUsd: number;
  /** Share of the attributable (gateway-covered) neuron spend, in [0,1]. */
  share: number;
  /** The covered billed dollars apportioned onto this model by its share. */
  apportionedUsd: number;
  tokensIn: number;
  tokensOut: number;
  calls: number;
}

/**
 * The AI-gateway coverage gap for the neuron SKU: how much of the billed neuron
 * total we can tie to a model (via the gateway) vs the direct-AI remainder that
 * bypassed the gateway and is model-unknown.
 *
 * Gateway dollar estimates UNDERCOUNT neuron billing, so we treat them as
 * attribution *shares*, not exact dollars: the gateway-covered slice
 * (`attributableUsd = min(gatewaySum, billed)`) is apportioned across the model
 * mix, and the non-gateway remainder (`unattributableUsd`) is surfaced loudly.
 * Because the gateway undercounts, `unattributableUsd` is an UPPER bound — it
 * folds together truly-bypassed calls and the gateway/neuron pricing gap.
 */
export interface AiGatewayGap {
  /** Actual billed neuron dollars for this SKU (the ranking/actualUsd value). */
  billedUsd: number;
  /** Sum of the gateway's per-model dollar estimate for Workers-AI models. */
  gatewayCostUsd: number;
  /** The billed dollars we can attribute to a model (min of the two above). */
  attributableUsd: number;
  /** billedUsd − attributableUsd — direct-AI spend that bypassed the gateway. */
  unattributableUsd: number;
  /** unattributableUsd as a % of the billed neuron total. */
  unattributablePct: number;
  /** Per-model attributable breakdown, ranked by gateway cost desc. */
  models: AiGatewayModelShare[];
}

/** One billed SKU line = Layer 1 (actual) + Layer 2 (value-add). */
export interface AccountantSku {
  /** The Cloudflare SKU name, verbatim (`ServiceName`). */
  sku: string;
  family: string;
  unit: string;
  /** ACTUAL billed dollars over the window (`ContractedCost` sum). The ranking key. */
  actualUsd: number;
  /** Our reconstructed estimate for this SKU's product, or null (see file overview). */
  estimateUsd: number | null;
  /** actualUsd − estimateUsd when both present, else null. */
  discrepancyUsd: number | null;
  /** discrepancyUsd as a % of the estimate (of the actual when estimate ≈ 0), else null. */
  discrepancyPct: number | null;
  category: Category;
  /** Straight-line month-end projection from this SKU's month-to-date billed series. */
  projectedMonthEnd: number;
  /** AI attribution on `ai` lines; null everywhere else. */
  attribution: SkuAttribution | null;
  /**
   * Per-script Durable Objects wall-time drivers — attached to the largest DO
   * SKU only (the compute/wall-time line the wall-time actually explains); null
   * everywhere else. Additive: consumers that don't know the field ignore it.
   */
  doDrivers: DoComputeDrivers | null;
  /**
   * AI-gateway coverage gap — attached to the neuron SKU (the largest `ai` line)
   * only; null everywhere else, including secondary AI SKUs.
   */
  gatewayGap: AiGatewayGap | null;
}

/** A flagged discrepancy — the dispute list ("the math isn't mathing"). */
export interface DiscrepancyFlag {
  sku: string;
  actualUsd: number;
  estimateUsd: number | null;
  discrepancyUsd: number;
  discrepancyPct: number | null;
  severity: Severity;
}

export interface AccountantReport {
  currency: string;
  /** Window size in days. */
  days: number;
  /** Sum of ACTUAL billed dollars across all SKUs over the window. */
  totalActualUsd: number;
  /** Overall estimate accuracy over the window (from the billable-usage reconcile). */
  windowAccuracy: number | null;
  /** SKU lines, ranked by `actualUsd` desc (Layer 1 order). */
  skus: AccountantSku[];
  /** The subset of SKUs whose estimate is materially off, ranked by |gap $| desc. */
  flags: DiscrepancyFlag[];
}

// ---------------------------------------------------------------------------
// Pure helpers (self-checked below)
// ---------------------------------------------------------------------------

/**
 * Classify any product/SKU string into a coarse category by keyword. Keyed off
 * the tokens Cloudflare actually uses on both the bill ("Regular Twitch
 * Neurons", "Durable Objects Storage Rows Read", "D1 - Rows Read") and our probe
 * ids ("workers-ai", "d1"). Order matters: the most specific product wins first.
 */
export function classify(name: string): Category {
  const s = name.toLowerCase();
  if (/neuron|twitch|workers ai|inference|ai gateway|\bai\b/.test(s)) return "ai";
  if (/durable object/.test(s)) return "durable_objects";
  if (/\bd1\b/.test(s)) return "d1";
  if (/\br2\b/.test(s)) return "r2";
  if (/workers kv|\bkv\b/.test(s)) return "kv";
  if (/vectorize/.test(s)) return "vectorize";
  if (/queue/.test(s)) return "queues";
  return "other";
}

/**
 * Estimate-vs-actual gap. Percent is taken against the estimate (the baseline we
 * are checking); when the estimate is ~0 but there IS actual spend, we fall back
 * to the actual as the base so an entirely-unestimated line reads as a ~100%
 * miss rather than a divide-by-zero. Null estimate → null gap (nothing to check).
 */
export function discrepancy(
  actualUsd: number,
  estimateUsd: number | null,
): { discrepancyUsd: number | null; discrepancyPct: number | null } {
  if (estimateUsd == null) return { discrepancyUsd: null, discrepancyPct: null };
  const discrepancyUsd = actualUsd - estimateUsd;
  const base = Math.abs(estimateUsd) > 1e-9 ? Math.abs(estimateUsd) : Math.abs(actualUsd);
  const discrepancyPct = base > 1e-9 ? (discrepancyUsd / base) * 100 : 0;
  return { discrepancyUsd, discrepancyPct };
}

/** Severity from the dollar gap (thesis: dollars, not percent, are what matter). */
export function severityOf(discrepancyUsd: number): Severity {
  const g = Math.abs(discrepancyUsd);
  if (g >= 25) return "high";
  if (g >= 5) return "medium";
  return "low";
}

/** Month-to-date sum of a billed SKU's daily points, then straight-line to month end. */
function projectFromPoints(
  points: { day: string; costUsd: number }[],
  nowMs: number,
): number {
  const prefix = utcDayKey(nowMs).slice(0, 7); // "YYYY-MM"
  const mtd = points
    .filter((p) => p.day.startsWith(prefix))
    .reduce((sum, p) => sum + p.costUsd, 0);
  return projectMonthEnd(mtd, nowMs);
}

/**
 * Compute the AI-gateway coverage gap for the neuron SKU. Pure so the apportion
 * + remainder math is self-checkable.
 *
 * We apportion the gateway-COVERED slice of the billed neuron total across the
 * gateway model mix (by each model's gateway-cost share), and surface the rest
 * as unattributable direct-AI spend. Gateway dollars undercount neuron billing,
 * so the covered slice is `min(gatewaySum, billed)` and the remainder is an
 * upper-bound estimate of what bypassed the gateway.
 *
 * @param billedUsd - the neuron SKU's ACTUAL billed dollars
 * @param mix - gateway-observed Workers-AI model usage
 */
export function buildAiGatewayGap(billedUsd: number, mix: GatewayModelUsage[]): AiGatewayGap {
  const gatewayCostUsd = mix.reduce((s, m) => s + m.gatewayCostUsd, 0);
  const attributableUsd = Math.min(gatewayCostUsd, billedUsd);
  const unattributableUsd = Math.max(0, billedUsd - attributableUsd);
  const unattributablePct = billedUsd > 0 ? (unattributableUsd / billedUsd) * 100 : 0;

  const models: AiGatewayModelShare[] = mix.map((m) => {
    const share = gatewayCostUsd > 0 ? m.gatewayCostUsd / gatewayCostUsd : 0;
    return {
      model: m.model,
      provider: m.provider,
      gatewayCostUsd: m.gatewayCostUsd,
      share,
      apportionedUsd: attributableUsd * share,
      tokensIn: m.tokensIn,
      tokensOut: m.tokensOut,
      calls: m.calls,
    };
  });

  return {
    billedUsd,
    gatewayCostUsd,
    attributableUsd,
    unattributableUsd,
    unattributablePct,
    models,
  };
}

/**
 * The whole report as a pure function of already-fetched inputs, so the ranking,
 * estimate-matching, discrepancy and flag logic is unit-self-checkable.
 *
 * @param actual - the Billable Usage report (Layer 1, actual billed)
 * @param estimate - the reconstructed daily-cost report (the estimate side)
 * @param byProject - AI-Router spend grouped by project (attribution)
 * @param days - window size (echoed into the report)
 * @param nowMs - clock (injectable) for the month-end projection
 */
export function buildAccountant(
  actual: Pick<
    BillableUsageReport,
    "currency" | "services" | "totalActualUsd" | "windowAccuracy"
  >,
  estimate: Pick<DailyCostReport, "services" | "workersAiModels">,
  byProject: { project: string; usd: number; calls: number }[],
  days: number,
  nowMs: number,
  doDrivers: DoComputeDrivers | null = null,
  gatewayMix: GatewayModelUsage[] = [],
): AccountantReport {
  // Estimate total per product category (usually one probe per category).
  const estByCategory = new Map<Category, number>();
  for (const s of estimate.services) {
    const cat = classify(`${s.service} ${s.product}`);
    estByCategory.set(cat, (estByCategory.get(cat) ?? 0) + s.totalUsd);
  }

  // AI attribution is shared across the (usually one) AI SKUs.
  const aiAttribution: SkuAttribution = {
    byModel: (estimate.workersAiModels?.models ?? []).map((m) => ({
      model: m.model,
      usd: m.costUsd ?? 0,
      neurons: m.neurons,
    })),
    byProject,
  };

  // Rank by ACTUAL billed dollars, desc (Layer 1 order). The top SKU in each
  // category claims that category's estimate; later SKUs in it get null.
  const ranked = [...actual.services].sort((a, b) => b.totalUsd - a.totalUsd);
  const estUsedBy = new Set<Category>();
  // Drivers attach to the FIRST (largest) SKU in their category only — the DO
  // wall-time split explains the compute line, not storage-row lines; the
  // gateway gap explains the neuron line, not secondary AI SKUs. Later SKUs in
  // the category get null (mirrors the estimate-matching rule above).
  let doDriversUsed = false;
  let gatewayGapUsed = false;

  const skus: AccountantSku[] = ranked.map((sv) => {
    const category = classify(sv.service);
    // "other" is a grab-bag of unrelated products — never attach a category-summed
    // estimate to a single SKU there, or it claims the others' estimates too.
    const hasEst =
      category !== "other" && estByCategory.has(category) && !estUsedBy.has(category);
    const estimateUsd = hasEst ? estByCategory.get(category)! : null;
    if (hasEst) estUsedBy.add(category);
    const { discrepancyUsd, discrepancyPct } = discrepancy(sv.totalUsd, estimateUsd);

    const attachDo = category === "durable_objects" && !doDriversUsed && doDrivers != null;
    if (attachDo) doDriversUsed = true;
    const attachGap = category === "ai" && !gatewayGapUsed;
    if (attachGap) gatewayGapUsed = true;

    return {
      sku: sv.service,
      family: sv.family,
      unit: sv.unit,
      actualUsd: sv.totalUsd,
      estimateUsd,
      discrepancyUsd,
      discrepancyPct,
      category,
      projectedMonthEnd: projectFromPoints(sv.points, nowMs),
      attribution: category === "ai" ? aiAttribution : null,
      doDrivers: attachDo ? doDrivers : null,
      gatewayGap: attachGap ? buildAiGatewayGap(sv.totalUsd, gatewayMix) : null,
    };
  });

  const flags: DiscrepancyFlag[] = skus
    .filter(
      (s) =>
        s.discrepancyUsd != null &&
        Math.abs(s.discrepancyUsd) > FLAG_USD &&
        s.discrepancyPct != null &&
        Math.abs(s.discrepancyPct) >= FLAG_PCT,
    )
    .map((s) => ({
      sku: s.sku,
      actualUsd: s.actualUsd,
      estimateUsd: s.estimateUsd,
      discrepancyUsd: s.discrepancyUsd!,
      discrepancyPct: s.discrepancyPct,
      severity: severityOf(s.discrepancyUsd!),
    }))
    .sort((a, b) => Math.abs(b.discrepancyUsd) - Math.abs(a.discrepancyUsd));

  return {
    currency: actual.currency,
    days,
    totalActualUsd: actual.totalActualUsd,
    windowAccuracy: actual.windowAccuracy,
    skus,
    flags,
  };
}

// ---------------------------------------------------------------------------
// IO: fetch + assemble
// ---------------------------------------------------------------------------

/**
 * The accountant report: pull the actual bill + the estimate + per-project AI
 * spend, then reduce them to the ranked two-layer view.
 *
 * @param env - Worker env (D1)
 * @param days - trailing window (default 30)
 * @param nowMs - clock (injectable); defaults to Date.now()
 */
export async function getAccountantReport(
  env: Env,
  days = 30,
  nowMs = Date.now(),
): Promise<AccountantReport> {
  const db = getDb(env);
  const cutoff = nowMs - days * DAY_MS;

  // DO wall-time is a live GraphQL read; if the analytics token can't serve it
  // (scope gap / retention), attribution degrades to null rather than failing
  // the whole bill view.
  const doDriversPromise = getDoComputeDrivers(env, days).catch(() => null);

  const [actual, estimate, routerRows, doDrivers, gatewayMix] = await Promise.all([
    getBillableUsageReport(env, days),
    getDailyCostReport(env, days),
    db
      .select({
        project: aiRouterRequests.project,
        usd: sql<number>`coalesce(sum(${aiRouterRequests.costUsd}), 0)`,
        calls: sql<number>`count(*)`,
      })
      .from(aiRouterRequests)
      .where(gte(aiRouterRequests.at, cutoff))
      .groupBy(aiRouterRequests.project),
    doDriversPromise,
    getGatewayWorkersAiMix(env, days),
  ]);

  const byProject = routerRows
    .map((r) => ({ project: r.project, usd: r.usd, calls: r.calls }))
    .sort((a, b) => b.usd - a.usd);

  return buildAccountant(actual, estimate, byProject, days, nowMs, doDrivers, gatewayMix);
}

// ---------------------------------------------------------------------------
// Self-check — pure classify / discrepancy / ranking / flag logic.
// ---------------------------------------------------------------------------
if (import.meta.main) {
  const eq = (a: unknown, b: unknown, m: string) => {
    if (a !== b) throw new Error(`${m}: got ${String(a)}, want ${String(b)}`);
  };
  const near = (a: number, b: number, m: string) => {
    if (Math.abs(a - b) > 1e-6) throw new Error(`${m}: got ${a}, want ${b}`);
  };

  // classify keys off real CF SKU + probe tokens.
  eq(classify("Regular Twitch Neurons"), "ai", "twitch → ai");
  eq(classify("workers-ai Workers AI"), "ai", "probe → ai");
  eq(classify("Durable Objects Storage Rows Read"), "durable_objects", "DO");
  eq(classify("D1 - Rows Read (first 25B included)"), "d1", "d1");
  eq(classify("R2 Class A Operations"), "r2", "r2");
  eq(classify("Workers KV read"), "kv", "kv");
  eq(classify("Vectorize queried dimensions"), "vectorize", "vectorize");
  eq(classify("Queues messages"), "queues", "queues");
  eq(classify("Something Else"), "other", "other");

  // discrepancy: normal, zero-estimate fallback, null.
  const d = discrepancy(588.67, 400);
  near(d.discrepancyUsd!, 188.67, "gap $");
  near(d.discrepancyPct!, (188.67 / 400) * 100, "gap %");
  eq(discrepancy(5, 0).discrepancyPct, 100, "zero-est → 100%");
  eq(discrepancy(5, null).discrepancyUsd, null, "null est → null gap");

  eq(severityOf(30), "high", "sev high");
  eq(severityOf(10), "medium", "sev medium");
  eq(severityOf(2), "low", "sev low");

  // End-to-end: AI line ranks first, claims the AI estimate + attribution; a
  // second AI SKU gets null estimate; D1 sits quietly; flags only the AI gap.
  const now = Date.UTC(2026, 7, 15);
  const rep = buildAccountant(
    {
      currency: "USD",
      totalActualUsd: 593.59,
      windowAccuracy: 0.68,
      services: [
        {
          service: "D1 - Rows Read",
          family: "D1",
          unit: "rows",
          totalUsd: 3.92,
          deltaUsd: null,
          points: [{ day: "2026-08-10", quantity: 1, costUsd: 3.92 }],
        },
        {
          service: "Regular Twitch Neurons",
          family: "Workers AI",
          unit: "neurons",
          totalUsd: 588.67,
          deltaUsd: null,
          points: [{ day: "2026-08-10", quantity: 1, costUsd: 588.67 }],
        },
        {
          service: "AI Gateway logs",
          family: "AI Gateway",
          unit: "logs",
          totalUsd: 1.0,
          deltaUsd: null,
          points: [{ day: "2026-08-10", quantity: 1, costUsd: 1.0 }],
        },
      ],
    },
    {
      services: [
        { service: "workers-ai", product: "Workers AI", unit: "neurons", points: [], deltaUsd: null, totalUsd: 400 },
        { service: "d1", product: "D1", unit: "rows", points: [], deltaUsd: null, totalUsd: 4 },
      ],
      workersAiModels: {
        day: "2026-08-10",
        models: [{ model: "gpt-oss-120b", neurons: 1_600_000, costUsd: 300 }],
      },
    },
    [{ project: "acre", usd: 250, calls: 10 }],
    30,
    now,
  );

  eq(rep.skus[0].sku, "Regular Twitch Neurons", "ranked by actual $ desc");
  eq(rep.skus[0].category, "ai", "top is ai");
  near(rep.skus[0].estimateUsd!, 400, "ai estimate matched");
  near(rep.skus[0].discrepancyUsd!, 188.67, "ai gap");
  eq(rep.skus[0].attribution!.byModel[0].model, "gpt-oss-120b", "byModel");
  eq(rep.skus[0].attribution!.byProject[0].project, "acre", "byProject");
  if (rep.skus[0].projectedMonthEnd <= 0) throw new Error("projection should be positive");

  const gw = rep.skus.find((s) => s.sku === "AI Gateway logs")!;
  eq(gw.estimateUsd, null, "second AI SKU gets no estimate");
  eq(gw.attribution === null, false, "AI SKU still carries attribution");

  const d1 = rep.skus.find((s) => s.sku === "D1 - Rows Read")!;
  eq(d1.category, "d1", "d1 category");
  near(d1.estimateUsd!, 4, "d1 estimate");
  eq(d1.attribution, null, "non-AI has no attribution");

  // Only the AI line is a flag ($188 gap, 47% > 25%); D1's $0.08 gap is trivial.
  eq(rep.flags.length, 1, "one flag");
  eq(rep.flags[0].sku, "Regular Twitch Neurons", "flag is the AI line");
  eq(rep.flags[0].severity, "high", "flag severity high");

  // --- AI-gateway coverage gap -------------------------------------------
  // Billed $588.67, gateway sees only $300 of Workers-AI → $288.67 (49%)
  // bypassed the gateway and is unattributable.
  const gap = buildAiGatewayGap(588.67, [
    { model: "@cf/meta/llama", provider: "workers-ai", gatewayCostUsd: 200, tokensIn: 10, tokensOut: 20, calls: 5 },
    { model: "gpt-oss-120b", provider: "workers-ai", gatewayCostUsd: 100, tokensIn: 5, tokensOut: 10, calls: 2 },
  ]);
  near(gap.gatewayCostUsd, 300, "gateway sum");
  near(gap.attributableUsd, 300, "attributable = min(gateway, billed)");
  near(gap.unattributableUsd, 288.67, "unattributable remainder");
  near(gap.unattributablePct, (288.67 / 588.67) * 100, "unattributable %");
  near(gap.models[0].share, 200 / 300, "top model share");
  near(gap.models[0].apportionedUsd, 300 * (200 / 300), "apportioned onto top model");
  // Gateway with no Workers-AI traffic → whole bill is unattributable.
  eq(buildAiGatewayGap(100, []).unattributablePct, 100, "no gateway → 100% unattributable");

  // --- Driver attachment (largest-in-category only) ----------------------
  const rep2 = buildAccountant(
    {
      currency: "USD",
      totalActualUsd: 638.67,
      windowAccuracy: null,
      services: [
        { service: "Regular Twitch Neurons", family: "Workers AI", unit: "neurons", totalUsd: 588.67, deltaUsd: null, points: [] },
        { service: "AI Gateway logs", family: "AI Gateway", unit: "logs", totalUsd: 1, deltaUsd: null, points: [] },
        { service: "Durable Objects Compute Duration", family: "Durable Objects", unit: "gb-s", totalUsd: 25, deltaUsd: null, points: [] },
        { service: "Durable Objects Storage Rows Read", family: "Durable Objects", unit: "rows", totalUsd: 24, deltaUsd: null, points: [] },
      ],
    },
    { services: [], workersAiModels: { day: "", models: [] } },
    [],
    30,
    now,
    { totalWallTime: 100, totalRequests: 10, scripts: [{ scriptName: "dopamine", wallTime: 100, requests: 10, wallTimeShare: 1, wallTimePerRequest: 10, longLivedSmell: true }] },
    [{ model: "gpt-oss-120b", provider: "workers-ai", gatewayCostUsd: 100, tokensIn: 1, tokensOut: 1, calls: 1 }],
  );
  eq(rep2.skus[0].gatewayGap != null, true, "neuron SKU carries the gateway gap");
  eq(rep2.skus.find((s) => s.sku === "AI Gateway logs")!.gatewayGap, null, "second AI SKU has no gap");
  eq(rep2.skus.find((s) => s.sku === "Durable Objects Compute Duration")!.doDrivers != null, true, "largest DO SKU carries drivers");
  eq(rep2.skus.find((s) => s.sku === "Durable Objects Storage Rows Read")!.doDrivers, null, "second DO SKU has no drivers");

  // eslint-disable-next-line no-console
  console.log("ok — accountant report verified");
}
