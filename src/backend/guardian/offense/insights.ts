/**
 * @fileoverview P8 Actionable-Insights analysis — the accumulation + recurrence
 * math behind the Spend Offense dashboard. ZERO AI: pure queries + arithmetic.
 *
 * This is the fix for the failure that cost the owner $600. The v1 dashboard
 * showed a per-day model figure (`gpt-oss-120b $22`) with no date, no running
 * total, and no "since last visit" — so a recurring $22/day drip read as a
 * static bug instead of "5 days running = $110". This module turns the raw
 * per-day/per-call history into ranked, self-describing anomalies:
 *
 *   "model X · N days running · $Y total · daily · project Z · K calls · M neurons/day"
 *
 * Two independent sources feed one ranked list, each anomaly tagged with its
 * `source` so the two are never silently conflated:
 *
 *  - **router**  — `ai_router_requests`: every AI Router call carries a real
 *    timestamp, project, provider, model and split cost. This gives true
 *    project attribution, exact call counts, and timestamp-derived cadence
 *    (hourly/daily/weekly). Token-priced, so `neuronsPerDay` is null.
 *  - **workers-ai-neurons** — the `daily_cost` per-model rows (service
 *    `workers-ai`, dimension = modelId, rawUsage = neurons). This is the
 *    reconstructed *direct* Workers-AI neuron spend that never went through the
 *    router — exactly the gpt-oss-120b drip that hid the $600. No project
 *    attribution exists for it (that's why it looked static), and cadence can
 *    only be inferred from daily presence, never sub-day.
 *
 * The route layer ({@link file://src/backend/api/routes/billing-insights.ts})
 * stays thin; all recurrence/accumulation logic lives here so it can be unit
 * self-checked (`import.meta.main`).
 *
 * @see {@link file://src/backend/guardian/daily-cost.ts} MTD + projection source
 * @see {@link file://src/backend/db/schemas/governance/ai-router-requests.ts}
 */

import { and, gte, sql } from "drizzle-orm";

import { getDb } from "@/backend/db";
import { aiRouterRequests, dailyCost } from "@/backend/db/schema";
import { getDailyCostReport } from "@/backend/guardian/daily-cost";
import { getBillingPeriodSpend } from "@/backend/guardian/billable-usage";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Spend below this in a day doesn't count toward a streak — noise, not a drip. */
const NONTRIVIAL_USD = 0.01;

/** Max analysis window (days). Router history is capped in rows too, see below. */
const MAX_WINDOW_DAYS = 30;

export type Cadence = "hourly" | "daily" | "weekly" | "sporadic";

/** One ranked anomaly. Nullable fields are honest gaps, never invented. */
export interface Anomaly {
  /** Which history produced this row (see file overview). */
  source: "router" | "workers-ai-neurons";
  model: string;
  /** Upstream provider, or null for the project-less neuron rows. */
  provider: string | null;
  /** Attributed project, or null (direct Workers-AI usage carries no project). */
  project: string | null;
  /** Consecutive calendar days (ending at `lastDay`) with non-trivial spend. */
  streakDays: number;
  /** Accumulated USD over the streak — the number the v1 dashboard hid. */
  streakTotalUsd: number;
  /** The most recent streak day's spend (the "$22/day" figure). */
  perDayUsd: number;
  cadence: Cadence;
  /** Router call count over the window, or null when not routed. */
  callCount: number | null;
  /** Neurons on the most recent streak day, or null (non-Workers-AI). */
  neuronsPerDay: number | null;
  /** UTC `YYYY-MM-DD` of the newest streak day. */
  lastDay: string;
}

export interface SinceLastVisit {
  /** mtdUsd now minus mtdUsd at the previous visit, or null on first visit. */
  deltaUsd: number | null;
  /** Whole+fractional days since the previous visit, or null on first visit. */
  daysSince: number | null;
  /** Epoch-ms of the previous visit, or null on first visit. */
  at: number | null;
}

export interface InsightsReport {
  mtdUsd: number;
  /** Where mtdUsd came from: "actual" = CF Billable Usage; "estimate" = daily reconstruction fallback. */
  mtdSource: "actual" | "estimate";
  /** The reconstructed estimate, always included so the UI can reconcile est-vs-actual. */
  estimateUsd: number;
  projectedMonthEnd: number;
  sinceLastVisit: SinceLastVisit;
  anomalies: Anomaly[];
}

// ---------------------------------------------------------------------------
// Pure helpers (self-checked below)
// ---------------------------------------------------------------------------

/** `YYYY-MM-DD` for the UTC day containing `ms`. */
export function utcDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** Ordered UTC day keys from the day of `cutoffMs` through the day of `nowMs`. */
export function orderedDays(cutoffMs: number, nowMs: number): string[] {
  const startOfDay = (ms: number) => {
    const d = new Date(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  };
  const out: string[] = [];
  for (let d = startOfDay(cutoffMs); d <= startOfDay(nowMs); d += DAY_MS) out.push(utcDayKey(d));
  return out;
}

/**
 * Cadence from real call timestamps: the median inter-arrival gap. This is the
 * only source that can distinguish hourly from daily.
 */
export function cadenceFromGaps(timestampsMs: number[]): Cadence {
  if (timestampsMs.length < 2) return "sporadic";
  const sorted = [...timestampsMs].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i] - sorted[i - 1]);
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  if (median <= 2 * HOUR_MS) return "hourly";
  if (median <= 36 * HOUR_MS) return "daily";
  if (median <= 10 * DAY_MS) return "weekly";
  return "sporadic";
}

/**
 * Cadence from which calendar days had spend (no sub-day resolution, so never
 * "hourly"). Consecutive days → daily; ~weekly spacing → weekly; else sporadic.
 */
export function cadenceFromDays(presentDays: string[]): Cadence {
  if (presentDays.length < 2) return "sporadic";
  const ms = [...presentDays].sort().map((d) => Date.parse(`${d}T00:00:00Z`));
  const gaps: number[] = [];
  for (let i = 1; i < ms.length; i++) gaps.push(Math.round((ms[i] - ms[i - 1]) / DAY_MS));
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  if (median <= 1) return "daily";
  if (median <= 8) return "weekly";
  return "sporadic";
}

export interface Streak {
  streakDays: number;
  streakTotalUsd: number;
  perDayUsd: number;
  lastDay: string;
}

/**
 * Longest run of consecutive calendar days ending at the newest spend day, over
 * `days`, where each day's cost ≥ `threshold`. Missing days count as $0 and
 * break the run — that's the "consecutive days in a row" the streak measures.
 *
 * @param dayCost - day → USD spent that day (absent = $0)
 * @param days - ordered calendar day keys the run may span
 */
export function computeStreak(
  dayCost: Map<string, number>,
  days: string[],
  threshold = NONTRIVIAL_USD,
): Streak {
  // Skip trailing days with no spend so a drip that stopped yesterday still
  // reports the streak it ran (anchored at its last active day).
  let end = days.length - 1;
  while (end >= 0 && (dayCost.get(days[end]) ?? 0) < threshold) end--;
  if (end < 0) return { streakDays: 0, streakTotalUsd: 0, perDayUsd: 0, lastDay: "" };

  let total = 0;
  let n = 0;
  let i = end;
  while (i >= 0 && (dayCost.get(days[i]) ?? 0) >= threshold) {
    total += dayCost.get(days[i])!;
    n++;
    i--;
  }
  return {
    streakDays: n,
    streakTotalUsd: total,
    perDayUsd: dayCost.get(days[end])!,
    lastDay: days[end],
  };
}

/** Straight-line month-end projection from month-to-date spend. */
export function projectMonthEnd(mtdUsd: number, nowMs: number): number {
  const d = new Date(nowMs);
  const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  // Fractional elapsed days incl. the partial current day, floored at a small
  // value so early-month projections don't explode to Infinity.
  const elapsed = Math.max(
    0.5,
    d.getUTCDate() - 1 + (d.getUTCHours() * HOUR_MS + d.getUTCMinutes() * 60_000) / DAY_MS,
  );
  return (mtdUsd / elapsed) * daysInMonth;
}

/**
 * Straight-line projection to the end of the CURRENT BILLING PERIOD (the
 * anniversary window CF actually bills on), from period-to-date spend. The
 * period end is the same day-of-month one month after its start.
 */
export function projectPeriodEnd(ptdUsd: number, periodStartMs: number, nowMs: number): number {
  const start = new Date(periodStartMs);
  const endMs = Date.UTC(
    start.getUTCFullYear(),
    start.getUTCMonth() + 1,
    start.getUTCDate(),
  );
  const periodDays = Math.max(1, (endMs - periodStartMs) / DAY_MS);
  const elapsed = Math.max(0.5, (nowMs - periodStartMs) / DAY_MS);
  return (ptdUsd / Math.min(elapsed, periodDays)) * periodDays;
}

// ---------------------------------------------------------------------------
// Anomaly builders (pure — take already-fetched rows)
// ---------------------------------------------------------------------------

/**
 * One PRE-AGGREGATED (project, provider, model, day) row from `ai_router_requests`
 * — cost summed and calls counted in SQL. Aggregating in the DB rather than
 * capping raw rows keeps a high-traffic project's accumulation EXACT (a raw-row
 * cap drops the oldest days → computeStreak breaks early → undercounts the drip).
 */
export interface RouterRow {
  project: string;
  provider: string;
  model: string;
  day: string;
  costUsd: number;
  calls: number;
}

/**
 * Router anomalies: group calls by (project, provider, model), build a per-day
 * cost series + a timestamp list per group, then derive streak, cadence, and
 * call count. Attribution and cadence are exact here.
 */
export function buildRouterAnomalies(rows: RouterRow[], days: string[]): Anomaly[] {
  interface G {
    project: string;
    provider: string;
    model: string;
    dayCost: Map<string, number>;
    callCount: number;
  }
  const groups = new Map<string, G>();
  for (const r of rows) {
    // JSON key avoids delimiter collisions (e.g. a project name with spaces).
    const key = JSON.stringify([r.project, r.provider, r.model]);
    let g = groups.get(key);
    if (!g) {
      g = {
        project: r.project,
        provider: r.provider,
        model: r.model,
        dayCost: new Map(),
        callCount: 0,
      };
      groups.set(key, g);
    }
    g.dayCost.set(r.day, (g.dayCost.get(r.day) ?? 0) + (r.costUsd ?? 0));
    g.callCount += r.calls ?? 0;
  }

  const out: Anomaly[] = [];
  for (const g of groups.values()) {
    const s = computeStreak(g.dayCost, days);
    if (s.streakDays === 0) continue;
    out.push({
      source: "router",
      model: g.model,
      provider: g.provider,
      project: g.project,
      streakDays: s.streakDays,
      streakTotalUsd: s.streakTotalUsd,
      perDayUsd: s.perDayUsd,
      cadence: cadenceFromDays([...g.dayCost.keys()]),
      callCount: g.callCount,
      neuronsPerDay: null,
      lastDay: s.lastDay,
    });
  }
  return out;
}

/** Minimal shape pulled from `daily_cost` Workers-AI per-model rows. */
export interface NeuronRow {
  day: string;
  model: string;
  costUsd: number | null;
  neurons: number;
}

/**
 * Workers-AI neuron anomalies: group the reconstructed per-model daily rows by
 * model, build cost + neuron day series, derive streak, and infer cadence from
 * daily presence. No project attribution and no call count exist for direct
 * (non-routed) Workers-AI usage, so both are null — the honest gap that let the
 * original drip masquerade as static.
 */
export function buildNeuronAnomalies(rows: NeuronRow[], days: string[]): Anomaly[] {
  interface G {
    model: string;
    dayCost: Map<string, number>;
    dayNeurons: Map<string, number>;
  }
  const groups = new Map<string, G>();
  for (const r of rows) {
    let g = groups.get(r.model);
    if (!g) {
      g = { model: r.model, dayCost: new Map(), dayNeurons: new Map() };
      groups.set(r.model, g);
    }
    g.dayCost.set(r.day, (g.dayCost.get(r.day) ?? 0) + (r.costUsd ?? 0));
    g.dayNeurons.set(r.day, (g.dayNeurons.get(r.day) ?? 0) + r.neurons);
  }

  const out: Anomaly[] = [];
  for (const g of groups.values()) {
    const s = computeStreak(g.dayCost, days);
    if (s.streakDays === 0) continue;
    const presentDays = [...g.dayCost.entries()]
      .filter(([, v]) => v >= NONTRIVIAL_USD)
      .map(([d]) => d);
    out.push({
      source: "workers-ai-neurons",
      model: g.model,
      provider: "workers-ai",
      project: null,
      streakDays: s.streakDays,
      streakTotalUsd: s.streakTotalUsd,
      perDayUsd: s.perDayUsd,
      cadence: cadenceFromDays(presentDays),
      callCount: null,
      neuronsPerDay: g.dayNeurons.get(s.lastDay) ?? 0,
      lastDay: s.lastDay,
    });
  }
  return out;
}

/** Merge + rank the two anomaly sources by accumulated streak spend, desc. */
export function rankAnomalies(...lists: Anomaly[][]): Anomaly[] {
  return lists.flat().sort((a, b) => b.streakTotalUsd - a.streakTotalUsd);
}

// ---------------------------------------------------------------------------
// IO: fetch + assemble (not part of the self-check)
// ---------------------------------------------------------------------------

/** Sum `daily_cost` totalByDay for the current UTC month → month-to-date USD. */
function mtdFromReport(
  totalByDay: { day: string; costUsd: number }[],
  nowMs: number,
): number {
  const prefix = utcDayKey(nowMs).slice(0, 7); // "YYYY-MM"
  return totalByDay
    .filter((t) => t.day.startsWith(prefix))
    .reduce((sum, t) => sum + t.costUsd, 0);
}

/**
 * Assemble the full insights report: MTD + projection from the daily-cost
 * rollup, ranked anomalies from the router + neuron histories, and the
 * since-last-visit delta (which also *records* this visit in KV).
 *
 * Ordering matters: mtdUsd is computed before the KV read/write so the visit we
 * persist carries the current figure the next visit will diff against.
 *
 * @param env - Worker env (D1 + SESSIONS KV)
 * @param nowMs - clock (injectable for tests); defaults to Date.now()
 */
export async function getInsights(env: Env, nowMs = Date.now()): Promise<InsightsReport> {
  const windowDays = MAX_WINDOW_DAYS;
  const cutoff = nowMs - (windowDays - 1) * DAY_MS;
  const days = orderedDays(cutoff, nowMs);
  const db = getDb(env);

  // MTD headline: prefer the ACTUAL billed figure from the Cloudflare Billable
  // Usage API (the real ContractedCost). The reconstructed daily rollup is only
  // an estimate and undercounts (that's the "$9 when it's really $500" bug), so
  // it's the LABELED fallback used only when actuals aren't synced yet (missing
  // Billing:Read scope or a stale sync).
  const [estReport, period] = await Promise.all([
    getDailyCostReport(env, 31),
    // ACTUAL billed spend for the CURRENT BILLING PERIOD (anniversary-based, the
    // number the CF dashboard shows) — NOT the calendar month, which excludes
    // the pre-1st tail of the period and made the headline read far low.
    getBillingPeriodSpend(env).catch(() => ({ periodStartMs: null, actualUsd: 0 })),
  ]);
  const estimateUsd = mtdFromReport(estReport.totalByDay, nowMs);
  const actualUsd = period.actualUsd;
  // Show the HIGHER of billed-actual vs reconstructed-estimate. A spend guard
  // must never HIDE a spike: CF billing lags ~24h+, so a spike today lands in the
  // estimate before it lands in actuals — taking the max keeps it visible, while
  // still preferring actual in the normal case (where the estimate undercounts).
  const mtdUsd = Math.max(actualUsd, estimateUsd);
  const mtdSource: "actual" | "estimate" =
    actualUsd > 0 && actualUsd >= estimateUsd ? "actual" : "estimate";
  // Project over the billing period (anniversary → anniversary) when we know its
  // start; else fall back to the calendar-month straight-line.
  const projectedMonthEnd =
    period.periodStartMs && actualUsd >= estimateUsd
      ? projectPeriodEnd(mtdUsd, period.periodStartMs, nowMs)
      : projectMonthEnd(mtdUsd, nowMs);

  // Router history AGGREGATED per (project, provider, model, UTC day) in SQL —
  // exact totals with bounded output, no raw-row cap that could drop old days
  // and undercount a streak.
  const routerRows = (await db
    .select({
      project: aiRouterRequests.project,
      provider: aiRouterRequests.provider,
      model: aiRouterRequests.model,
      day: sql<string>`strftime('%Y-%m-%d', ${aiRouterRequests.at} / 1000, 'unixepoch')`,
      costUsd: sql<number>`coalesce(sum(${aiRouterRequests.costUsd}), 0)`,
      calls: sql<number>`count(*)`,
    })
    .from(aiRouterRequests)
    .where(gte(aiRouterRequests.at, cutoff))
    .groupBy(
      aiRouterRequests.project,
      aiRouterRequests.provider,
      aiRouterRequests.model,
      sql`strftime('%Y-%m-%d', ${aiRouterRequests.at} / 1000, 'unixepoch')`,
    )) as RouterRow[];

  // Workers-AI per-model neuron rows (dimension != "" is the per-model split).
  const cutoffDay = utcDayKey(cutoff);
  const neuronRows = (
    await db
      .select({
        day: dailyCost.day,
        model: dailyCost.dimension,
        costUsd: dailyCost.costUsd,
        neurons: dailyCost.rawUsage,
      })
      .from(dailyCost)
      .where(
        and(
          gte(dailyCost.day, cutoffDay),
          sql`${dailyCost.service} = 'workers-ai'`,
          sql`${dailyCost.dimension} != ''`,
        ),
      )
  ) as NeuronRow[];

  const anomalies = rankAnomalies(
    buildRouterAnomalies(routerRows, days),
    buildNeuronAnomalies(neuronRows, days),
  );

  const sinceLastVisit = await recordVisit(env, mtdUsd, nowMs);

  return { mtdUsd, mtdSource, estimateUsd, projectedMonthEnd, sinceLastVisit, anomalies };
}

const VISIT_KEY = "dashboard:last-visit";

/**
 * Read the previous visit, compute the delta, then persist this visit. The
 * write is what makes the *next* "since last visit" meaningful.
 */
async function recordVisit(env: Env, mtdUsd: number, nowMs: number): Promise<SinceLastVisit> {
  const prev = (await env.SESSIONS.get(VISIT_KEY, "json")) as {
    at: number;
    mtdUsd: number;
  } | null;

  await env.SESSIONS.put(VISIT_KEY, JSON.stringify({ at: nowMs, mtdUsd }));

  if (!prev) return { deltaUsd: null, daysSince: null, at: null };
  // Across a month boundary MTD resets to ~0, so a raw subtraction yields a bogus
  // negative. Same month → true delta; different month → this month's whole MTD
  // has accrued since the (last-month) visit.
  const prevDate = new Date(prev.at);
  const nowDate = new Date(nowMs);
  const sameMonth =
    prevDate.getUTCFullYear() === nowDate.getUTCFullYear() &&
    prevDate.getUTCMonth() === nowDate.getUTCMonth();
  return {
    deltaUsd: sameMonth ? mtdUsd - prev.mtdUsd : mtdUsd,
    daysSince: (nowMs - prev.at) / DAY_MS,
    at: prev.at,
  };
}

// ---------------------------------------------------------------------------
// Self-check — pure recurrence/accumulation math. Never runs in the Worker.
// ---------------------------------------------------------------------------
if (import.meta.main) {
  const near = (a: number, b: number, m: string) => {
    if (Math.abs(a - b) > 1e-6) throw new Error(`${m}: got ${a}, want ${b}`);
  };
  const eq = (a: unknown, b: unknown, m: string) => {
    if (a !== b) throw new Error(`${m}: got ${String(a)}, want ${String(b)}`);
  };

  // orderedDays inclusive of both ends.
  const days = orderedDays(Date.UTC(2026, 7, 1), Date.UTC(2026, 7, 5));
  eq(days.length, 5, "orderedDays length");
  eq(days[0], "2026-08-01", "orderedDays first");
  eq(days[4], "2026-08-05", "orderedDays last");

  // Streak: 5 consecutive days at $22 = $110, ending on the last active day,
  // even with a trailing gap day after it (the exact $600-drip shape).
  const win = orderedDays(Date.UTC(2026, 7, 1), Date.UTC(2026, 7, 8));
  const dc = new Map<string, number>([
    ["2026-08-03", 22],
    ["2026-08-04", 22],
    ["2026-08-05", 22],
    ["2026-08-06", 22],
    ["2026-08-07", 22],
    // 08-08 absent → trailing gap; streak anchors on 08-07.
  ]);
  const s = computeStreak(dc, win);
  eq(s.streakDays, 5, "streak days");
  near(s.streakTotalUsd, 110, "streak total");
  near(s.perDayUsd, 22, "streak perDay");
  eq(s.lastDay, "2026-08-07", "streak lastDay");

  // A single-day gap breaks the run: only the days after the gap count.
  const gap = new Map<string, number>([
    ["2026-08-02", 5],
    ["2026-08-04", 5],
    ["2026-08-05", 5],
  ]);
  eq(computeStreak(gap, win).streakDays, 2, "gap breaks streak");

  // Sub-threshold days don't count.
  eq(computeStreak(new Map([["2026-08-07", 0.001]]), win).streakDays, 0, "noise excluded");

  // Cadence from timestamps.
  const hourly = [0, HOUR_MS, 2 * HOUR_MS, 3 * HOUR_MS];
  eq(cadenceFromGaps(hourly), "hourly", "cadence hourly");
  const daily = [0, DAY_MS, 2 * DAY_MS];
  eq(cadenceFromGaps(daily), "daily", "cadence daily");
  const weekly = [0, 7 * DAY_MS, 14 * DAY_MS];
  eq(cadenceFromGaps(weekly), "weekly", "cadence weekly");
  eq(cadenceFromGaps([42]), "sporadic", "cadence single sporadic");

  // Cadence from daily presence never reports hourly.
  eq(cadenceFromDays(["2026-08-03", "2026-08-04", "2026-08-05"]), "daily", "presence daily");
  eq(cadenceFromDays(["2026-08-01", "2026-08-08", "2026-08-15"]), "weekly", "presence weekly");

  // Router anomaly end-to-end: one project/model, 3 daily calls.
  const rowAnoms = buildRouterAnomalies(
    [
      { project: "acre", provider: "openai", model: "gpt-5", day: "2026-08-05", costUsd: 3, calls: 1 },
      { project: "acre", provider: "openai", model: "gpt-5", day: "2026-08-06", costUsd: 4, calls: 1 },
      { project: "acre", provider: "openai", model: "gpt-5", day: "2026-08-07", costUsd: 5, calls: 1 },
    ],
    win,
  );
  eq(rowAnoms.length, 1, "router anomaly count");
  eq(rowAnoms[0].project, "acre", "router anomaly project");
  eq(rowAnoms[0].callCount, 3, "router anomaly callCount");
  eq(rowAnoms[0].streakDays, 3, "router anomaly streak");
  near(rowAnoms[0].streakTotalUsd, 12, "router anomaly total");

  // Neuron anomaly: no project, neurons carried, cadence from presence.
  const neuronAnoms = buildNeuronAnomalies(
    [
      { day: "2026-08-06", model: "gpt-oss-120b", costUsd: 22, neurons: 1_600_000 },
      { day: "2026-08-07", model: "gpt-oss-120b", costUsd: 22, neurons: 1_600_000 },
    ],
    win,
  );
  eq(neuronAnoms[0].project, null, "neuron anomaly project null");
  eq(neuronAnoms[0].callCount, null, "neuron anomaly callCount null");
  eq(neuronAnoms[0].neuronsPerDay, 1_600_000, "neuron anomaly neurons");
  eq(neuronAnoms[0].cadence, "daily", "neuron anomaly cadence");

  // Ranking: bigger streak total first.
  const ranked = rankAnomalies(rowAnoms, neuronAnoms);
  eq(ranked[0].source, "workers-ai-neurons", "ranked biggest first ($44 > $12)");

  // Projection: $110 over 5 elapsed days of a 31-day month ≈ $682.
  near(projectMonthEnd(110, Date.UTC(2026, 7, 6)), (110 / 5) * 31, "projection");

  // eslint-disable-next-line no-console
  console.log("ok — offense insights math verified");
}
