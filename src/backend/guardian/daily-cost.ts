/**
 * @fileoverview Daily reconstructed cost rollup + day-over-day report.
 *
 * Cloudflare has no cost API — the billing dashboard's dollar figures live only
 * in that UI. This module reconstructs them from usage:
 *
 *  1. `snapshotDailyCost` sums a UTC day's `usage_snapshots` per service and
 *     prices them against the curated overage rates in {@link allowances},
 *     writing one `daily_cost` headline row per service (dimension ""). For the
 *     Workers AI line — ~80% of a typical bill — it also queries the neuron
 *     dataset per `modelId` and writes a row per model so the spend can be
 *     attributed to a model.
 *  2. `getDailyCostReport` reads that history back as per-service series with a
 *     day-over-day delta (the "flat vs climbing" signal), plus a Workers AI
 *     ATTRIBUTION block that reconciles, in USD:
 *
 *        direct = reconstructedWorkersAiCost − (gatewayCost + registeredCost)
 *
 *     `gatewayCost` is real AI-Gateway-routed spend (from `ai_gateway_costs`);
 *     `registeredCost` is anything a caller self-reported through
 *     {@link file://src/backend/guardian/register-usage.ts} (the path this
 *     Worker's AI proxy uses, carrying a required origin field). Whatever is
 *     left — `direct` — is Workers AI inference that hit the raw Cloudflare API
 *     with no gateway and no registration: the endpoints still to be migrated.
 *     Watching `direct` fall day over day IS the migration progress bar.
 *
 * Why USD and not neurons for the reconciliation: the neuron dataset meters
 * neurons; the gateway/registration tables meter tokens+cost. USD is the one
 * unit all three share, so the split is honest (with the estimate caveat that
 * reconstructed cost is priced, not billed).
 *
 * @see {@link file://src/backend/db/schemas/governance/daily-cost.ts}
 */

import { and, gte, inArray, lte, sql } from "drizzle-orm";

import type { NewDailyCostRow } from "@/backend/db/schema";

import { getDb } from "@/backend/db";
import {
  aiGatewayCosts,
  aiUsageRegistrations,
  dailyCost,
  usageSnapshots,
} from "@/backend/db/schema";
import { queryAccountAnalytics } from "@/backend/lib/cloudflare-graphql";

import { ALLOWANCES, overageCostUsd } from "./allowances";
import { USAGE_PROBES } from "./probes";

/** Provider ids that mean "Cloudflare Workers AI" across the cost tables. */
const WORKERS_AI_PROVIDERS = ["workers-ai", "workersai", "cloudflare", "cloudflare-workers-ai"];
const DAY_MS = 86_400_000;

/** Probe id → its human product + unit, so a daily_cost row is self-describing. */
const PROBE_META = new Map(USAGE_PROBES.map((p) => [p.id, { product: p.product, unit: p.unit }]));

/** `YYYY-MM-DD` for a UTC day, and the epoch-ms at its start. */
function dayKey(atMs: number): { day: string; dayStart: number } {
  const d = new Date(atMs);
  const day = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  return { day, dayStart: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) };
}

/**
 * Reconstruct a service's USD cost for one day's usage, or null when no rate is
 * known (never invented). `basis` records the method so the UI can flag it.
 */
export function priceDay(
  probeId: string,
  rawUsage: number,
): { costUsd: number | null; basis: string } {
  const a = ALLOWANCES[probeId];
  if (!a || a.overageUsd === undefined || a.overagePer === undefined) {
    return { costUsd: null, basis: "no-rate" };
  }
  if (a.reset === "daily") {
    // Daily-reset allowance (e.g. Workers AI 10k neurons/day) prices exactly:
    // only usage past the day's included quantity is billable.
    const overage = Math.max(0, rawUsage - a.paidIncluded);
    return { costUsd: overageCostUsd(a, overage) ?? 0, basis: "overage@daily-reset" };
  }
  // ponytail: monthly-pooled allowance — a single day's marginal cost depends on
  // month-to-date consumption, which we don't thread here. Price at the flat
  // marginal rate (an upper bound that's exact once the month is over
  // allowance). Upgrade to month-to-date-aware pricing if the sub-allowance days
  // need to read $0 rather than marginal.
  return { costUsd: (rawUsage / a.overagePer) * a.overageUsd, basis: "marginal@monthly" };
}

type NeuronModel = { modelId: string; neurons: number; requests: number };

/** Query the Workers AI neuron dataset for one day, grouped by model. */
async function neuronsByModel(env: Env, startIso: string, endIso: string): Promise<NeuronModel[]> {
  const query = `query GuardianNeurons($accountTag: string!, $start: Time!, $end: Time!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        ai: aiInferenceAdaptiveGroups(
          filter: { datetimeHour_geq: $start, datetimeHour_leq: $end }
          limit: 10000
        ) { count sum { totalNeurons } dimensions { modelId } }
      }
    }
  }`;
  const account = await queryAccountAnalytics<{
    ai: { count: number; sum: { totalNeurons: number }; dimensions: { modelId: string } }[];
  }>(env, query, { start: startIso, end: endIso });
  const rows = account.ai ?? [];
  // Roll up in case the dataset returns per-hour rows per model.
  const byModel = new Map<string, NeuronModel>();
  for (const r of rows) {
    const id = r.dimensions.modelId || "unknown";
    const m = byModel.get(id) ?? { modelId: id, neurons: 0, requests: 0 };
    m.neurons += r.sum?.totalNeurons ?? 0;
    m.requests += r.count ?? 0;
    byModel.set(id, m);
  }
  return [...byModel.values()].sort((a, b) => b.neurons - a.neurons);
}

/**
 * Snapshot one UTC day's reconstructed cost into `daily_cost` (idempotent
 * upsert). Headline rows per service come from summing `usage_snapshots`;
 * when `breakdown` is set (and the day is inside GraphQL's ~31-day retention),
 * the Workers AI line is additionally split per model from the live dataset.
 *
 * @param env - Worker env
 * @param atMs - any epoch-ms inside the target UTC day (defaults to yesterday)
 * @param breakdown - also write per-model Workers AI rows (default true)
 * @returns number of rows written
 */
export async function snapshotDailyCost(
  env: Env,
  atMs = Date.now() - DAY_MS,
  breakdown = true,
): Promise<number> {
  const { day, dayStart } = dayKey(atMs);
  const dayEnd = dayStart + DAY_MS;
  const db = getDb(env);
  const now = Date.now();

  // Per-service headline from the hourly snapshots this day.
  const summed = await db
    .select({
      service: usageSnapshots.service,
      metric: usageSnapshots.metric,
      total: sql<number>`sum(${usageSnapshots.value})`,
    })
    .from(usageSnapshots)
    .where(and(gte(usageSnapshots.timestamp, dayStart), lte(usageSnapshots.timestamp, dayEnd - 1)))
    .groupBy(usageSnapshots.service, usageSnapshots.metric);

  const rows: NewDailyCostRow[] = summed.map((s) => {
    const meta = PROBE_META.get(s.service);
    const { costUsd, basis } = priceDay(s.service, s.total ?? 0);
    return {
      id: `${day}:${s.service}:`,
      day,
      dayStart,
      service: s.service,
      product: meta?.product ?? s.service,
      dimension: "",
      unit: meta?.unit ?? s.metric,
      rawUsage: s.total ?? 0,
      costUsd,
      basis,
      capturedAt: now,
    };
  });

  // Workers AI per-model split (live dataset — recent days only).
  if (breakdown) {
    try {
      const start = new Date(dayStart);
      const end = new Date(dayEnd - 3_600_000); // last full hour bucket of the day
      const models = await neuronsByModel(env, start.toISOString(), end.toISOString());
      for (const m of models) {
        // Per-model rows exclude the once-per-day free tier (it applies to the
        // service total, not each model), so price at the flat marginal rate.
        const a = ALLOWANCES["workers-ai"];
        const costUsd =
          a?.overageUsd !== undefined && a.overagePer !== undefined
            ? (m.neurons / a.overagePer) * a.overageUsd
            : null;
        rows.push({
          id: `${day}:workers-ai:${m.modelId}`,
          day,
          dayStart,
          service: "workers-ai",
          product: "Workers AI",
          dimension: m.modelId,
          unit: "neurons",
          rawUsage: m.neurons,
          costUsd,
          basis: "marginal@model",
          capturedAt: now,
        });
      }
    } catch (err) {
      console.warn(
        JSON.stringify({
          level: "WARN",
          source: "guardian.dailyCost.neurons",
          day,
          error: String(err),
        }),
      );
    }
  }

  for (const r of rows) {
    await db
      .insert(dailyCost)
      .values(r)
      .onConflictDoUpdate({
        target: dailyCost.id,
        set: { rawUsage: r.rawUsage, costUsd: r.costUsd, basis: r.basis, capturedAt: now },
      });
  }
  return rows.length;
}

/**
 * Backfill daily cost from existing `usage_snapshots` history (no GraphQL, so
 * safe for days past the 31-day analytics retention). Per-service only — no
 * per-model neuron split for old days. Idempotent.
 *
 * @param days - how many past UTC days to (re)build, ending yesterday
 */
export async function backfillDailyCost(env: Env, days = 30): Promise<number> {
  let written = 0;
  for (let i = 1; i <= days; i++) {
    written += await snapshotDailyCost(env, Date.now() - i * DAY_MS, false);
  }
  return written;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export type ServiceSeries = {
  service: string;
  product: string;
  unit: string;
  /** One point per day (oldest → newest). `costUsd` null = no rate known. */
  points: { day: string; rawUsage: number; costUsd: number | null }[];
  /** Latest day's cost minus the prior day's, or null if either is unknown. */
  deltaUsd: number | null;
  /** Sum of known daily costs over the window. */
  totalUsd: number;
};

export type WorkersAiAttributionDay = {
  day: string;
  reconstructedUsd: number;
  gatewayUsd: number;
  registeredUsd: number;
  directUsd: number;
  /** attributed / reconstructed, 0..1, or null when reconstructed is 0. */
  coverage: number | null;
};

export type DailyCostReport = {
  days: string[];
  services: ServiceSeries[];
  /** Total reconstructed cost per day (sum of service costUsd), with delta. */
  totalByDay: { day: string; costUsd: number }[];
  totalDeltaUsd: number | null;
  /** Workers AI neuron split for the most recent day that has model rows. */
  workersAiModels: {
    day: string;
    models: { model: string; neurons: number; costUsd: number | null }[];
  };
  /** USD reconciliation of Workers AI spend into gateway / registered / direct. */
  workersAiAttribution: WorkersAiAttributionDay[];
};

/**
 * Read the daily cost history back as per-service series with day-over-day
 * deltas, plus the Workers AI USD attribution reconciliation.
 *
 * @param days - trailing window size (default 30)
 */
export async function getDailyCostReport(env: Env, days = 30): Promise<DailyCostReport> {
  const db = getDb(env);
  const cutoff = dayKey(Date.now() - (days - 1) * DAY_MS).dayStart;

  const rows = await db
    .select()
    .from(dailyCost)
    .where(gte(dailyCost.dayStart, cutoff))
    .orderBy(dailyCost.dayStart);

  // Ordered unique day list.
  const dayList = [...new Set(rows.map((r) => r.day))].sort();

  // Per-service series (headline rows only: dimension "").
  const byService = new Map<string, ServiceSeries>();
  for (const r of rows) {
    if (r.dimension !== "") continue;
    let s = byService.get(r.service);
    if (!s) {
      s = {
        service: r.service,
        product: r.product,
        unit: r.unit,
        points: [],
        deltaUsd: null,
        totalUsd: 0,
      };
      byService.set(r.service, s);
    }
    s.points.push({ day: r.day, rawUsage: r.rawUsage, costUsd: r.costUsd });
    if (r.costUsd != null) s.totalUsd += r.costUsd;
  }
  for (const s of byService.values()) {
    s.points.sort((a, b) => a.day.localeCompare(b.day));
    const n = s.points.length;
    if (n >= 2) {
      const last = s.points[n - 1].costUsd;
      const prev = s.points[n - 2].costUsd;
      s.deltaUsd = last != null && prev != null ? last - prev : null;
    }
  }
  const services = [...byService.values()].sort((a, b) => b.totalUsd - a.totalUsd);

  // Total reconstructed cost per day.
  const totalMap = new Map<string, number>();
  for (const r of rows) {
    if (r.dimension !== "" || r.costUsd == null) continue;
    totalMap.set(r.day, (totalMap.get(r.day) ?? 0) + r.costUsd);
  }
  const totalByDay = dayList.map((day) => ({ day, costUsd: totalMap.get(day) ?? 0 }));
  const totalDeltaUsd =
    totalByDay.length >= 2
      ? totalByDay[totalByDay.length - 1].costUsd - totalByDay[totalByDay.length - 2].costUsd
      : null;

  // Workers AI per-model split for the newest day that has model rows.
  const modelRows = rows.filter((r) => r.service === "workers-ai" && r.dimension !== "");
  const modelDay = modelRows.length ? modelRows[modelRows.length - 1].day : "";
  const workersAiModels = {
    day: modelDay,
    models: modelRows
      .filter((r) => r.day === modelDay)
      .map((r) => ({ model: r.dimension, neurons: r.rawUsage, costUsd: r.costUsd }))
      .sort((a, b) => b.neurons - a.neurons),
  };

  // --- Workers AI USD attribution ------------------------------------------
  // reconstructed = the priced workers-ai headline; gateway = real gateway
  // spend; registered = self-reported (proxy / manual); direct = remainder.
  const wsHeadline = new Map<string, number>();
  for (const r of rows) {
    if (r.service === "workers-ai" && r.dimension === "" && r.costUsd != null)
      wsHeadline.set(r.day, r.costUsd);
  }

  const gatewayRows = await db
    .select({ day: aiGatewayCosts.day, cost: aiGatewayCosts.costUsd })
    .from(aiGatewayCosts)
    .where(
      and(
        gte(aiGatewayCosts.dayStart, cutoff),
        inArray(aiGatewayCosts.provider, WORKERS_AI_PROVIDERS),
      ),
    );
  const gatewayByDay = new Map<string, number>();
  for (const g of gatewayRows)
    gatewayByDay.set(g.day, (gatewayByDay.get(g.day) ?? 0) + (g.cost ?? 0));

  // Registrations are timestamped in ms (`at`), not day-bucketed — group here.
  const regRows = await db
    .select({ at: aiUsageRegistrations.at, cost: aiUsageRegistrations.costUsd })
    .from(aiUsageRegistrations)
    .where(
      and(
        gte(aiUsageRegistrations.at, cutoff),
        inArray(aiUsageRegistrations.provider, WORKERS_AI_PROVIDERS),
      ),
    );
  const regByDay = new Map<string, number>();
  for (const r of regRows) {
    const { day } = dayKey(r.at);
    regByDay.set(day, (regByDay.get(day) ?? 0) + (r.cost ?? 0));
  }

  const workersAiAttribution: WorkersAiAttributionDay[] = dayList.map((day) => {
    const reconstructedUsd = wsHeadline.get(day) ?? 0;
    const gatewayUsd = gatewayByDay.get(day) ?? 0;
    const registeredUsd = regByDay.get(day) ?? 0;
    const attributed = gatewayUsd + registeredUsd;
    const directUsd = Math.max(0, reconstructedUsd - attributed);
    return {
      day,
      reconstructedUsd,
      gatewayUsd,
      registeredUsd,
      directUsd,
      coverage: reconstructedUsd > 0 ? Math.min(1, attributed / reconstructedUsd) : null,
    };
  });

  return {
    days: dayList,
    services,
    totalByDay,
    totalDeltaUsd,
    workersAiModels,
    workersAiAttribution,
  };
}

// ---------------------------------------------------------------------------
// Self-check — pure pricing/reconciliation logic. Never runs in the Worker.
// ---------------------------------------------------------------------------
if (import.meta.main) {
  const near = (a: number, b: number, m: string) => {
    if (Math.abs(a - b) > 1e-9) throw new Error(`${m}: got ${a}, want ${b}`);
  };
  // Neurons are daily-reset: 10k/day free, $0.011 per 1000 over.
  // 1,010,000 neurons → 1,000,000 billable → 1000 × $0.011 = $11.00.
  const n = priceDay("workers-ai", 1_010_000);
  near(n.costUsd ?? -1, 11, "neuron daily overage");
  if (n.basis !== "overage@daily-reset") throw new Error(`basis: ${n.basis}`);
  // Under the free tier → $0.
  near(priceDay("workers-ai", 5_000).costUsd ?? -1, 0, "neurons under free tier");
  // A service with no rate stays null (never invented).
  if (priceDay("durable-objects-cpu", 9e9).costUsd !== null)
    throw new Error("no-rate must be null");
  // D1 rows are monthly, marginal rate $0.001 per 1M → 5M rows = $0.005.
  near(priceDay("d1", 5_000_000).costUsd ?? -1, 0.005, "d1 marginal");
  // eslint-disable-next-line no-console
  console.log("ok — daily-cost pricing verified");
}
