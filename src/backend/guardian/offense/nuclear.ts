/**
 * @fileoverview Nuclear total-Cloudflare-budget breaker + non-AI infra-spike
 * guard (Spend Offense, P9a).
 *
 * Reframe (see docs/architecture/spend-offense.md → "P9 — Budgets, Projects &
 * the Nuclear Breaker"): this is a **total Cloudflare spend** guard, NOT an
 * AI-only one. The owner expects ~$10/mo of infra; the prior $600 surprise was
 * **Durable Objects** (an alarm loop), not AI. So any non-AI billable line over
 * a low threshold is an EMERGENCY.
 *
 * Two independent checks, both zero-AI (pure D1 queries + arithmetic that wrap
 * existing Guardian helpers):
 *
 *  1. {@link checkNuclearBudget} — month-to-date TOTAL CF spend vs a configured
 *     budget (`nuclear_budget_usd` in `global_config`). At/over budget it engages
 *     the AI kill switch — which is the one lever core-guardian actually holds
 *     over spend, since it gates all AI through our APIs — and files a
 *     `budget_cap` incident. The dashboard still shows the per-project breakdown
 *     so the owner sees WHO overspent even after the nuke.
 *
 *  2. {@link checkInfraSpikes} — every non-AI reconstructed service line
 *     (`service !== "workers-ai"`) with MTD over `infra_spike_threshold_usd`.
 *     core-guardian can't gate non-AI spend directly, so this is **recommend
 *     only**: a loud `infra_spike` incident naming the remediation (kill-cron /
 *     archive-r2 / investigate).
 *
 * MTD "actual billed" comes from Cloudflare's Billable Usage API
 * ({@link getBillableUsageReport}, `totalByDay` = real charged cost); when that
 * table has no rows for the current month yet, it falls back to the
 * reconstructed `daily_cost` estimate ({@link getDailyCostReport}).
 *
 * Both checks are idempotent: they dedupe on an existing `active` incident of
 * their source (budget_cap is account-wide / scope "global"; infra_spike dedupes
 * per service scope). The resolve flow (mark read / erroneous) clears the way
 * for the next one.
 *
 * @see {@link file://src/backend/guardian/offense/auto-break.ts} the P1 sibling.
 */

import { and, eq } from "drizzle-orm";

import { getDb } from "@/backend/db";
import {
  billingEvents,
  circuitBreakEvents,
  globalConfig,
  type CircuitBreakAction,
} from "@/backend/db/schema";
import { NotificationsAgent } from "@/backend/ai/agents/NotificationsAgent";
import { getBillableUsageReport } from "@/backend/guardian/billable-usage";
import { getDailyCostReport, type DailyCostReport } from "@/backend/guardian/daily-cost";
import { getKillSwitch, setKillSwitch } from "@/backend/guardian/ai-router/circuits";
import { getAgentByName } from "agents";

// ---------------------------------------------------------------------------
// Config keys + defaults
// ---------------------------------------------------------------------------

/** `global_config` key: the total monthly CF spend budget that fires the nuke. */
export const NUCLEAR_BUDGET_KEY = "nuclear_budget_usd";
/** `global_config` key: per-service MTD ceiling for a non-AI infra spike. */
export const INFRA_SPIKE_KEY = "infra_spike_threshold_usd";

/**
 * Default non-AI infra-spike ceiling. The owner expects ~$0 non-AI, so a low
 * bar catches a runaway D1/DO/R2 line fast. Configurable via `POST
 * /budget-config`; there is intentionally NO default nuclear budget — it stays
 * a no-op until the operator sets one (see {@link checkNuclearBudget}).
 */
export const DEFAULT_INFRA_SPIKE_USD = 5;

/** The service id the daily-cost rollup uses for Workers AI (the AI line). */
const AI_SERVICE = "workers-ai";

// ---------------------------------------------------------------------------
// Pure decision helpers (unit-tested below)
// ---------------------------------------------------------------------------

/** `YYYY-MM` for a UTC instant — the prefix of every `daily_cost` day key. */
export function monthPrefix(at: number = Date.now()): string {
  const d = new Date(at);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Sum the `costUsd` of day points whose day falls in `month` (null → 0). */
export function sumMonth(
  points: { day: string; costUsd: number | null }[],
  month: string,
): number {
  let sum = 0;
  for (const p of points) if (p.day.startsWith(month) && p.costUsd != null) sum += p.costUsd;
  return sum;
}

/** Nuke condition: MTD has reached the budget. */
export function overBudget(mtdUsd: number, budgetUsd: number): boolean {
  return mtdUsd >= budgetUsd;
}

/** Spike condition: a single non-AI service's MTD is over the threshold. */
export function overThreshold(mtdUsd: number, thresholdUsd: number): boolean {
  return mtdUsd > thresholdUsd;
}

/**
 * Non-AI service MTDs from a daily-cost report: every service except the
 * Workers AI line, with a non-zero month-to-date cost (a $0 line is baseline,
 * not a spike). Sorted high → low. Shared by the spike check and the status
 * route so both agree on the breakdown.
 */
export function nonAiServiceMtds(
  report: DailyCostReport,
  month: string,
): { service: string; mtdUsd: number }[] {
  return report.services
    .filter((s) => s.service !== AI_SERVICE)
    .map((s) => ({ service: s.service, mtdUsd: sumMonth(s.points, month) }))
    .filter((s) => s.mtdUsd > 0)
    .sort((a, b) => b.mtdUsd - a.mtdUsd);
}

// ---------------------------------------------------------------------------
// Config + MTD readers
// ---------------------------------------------------------------------------

/**
 * Read a numeric `global_config` value, or `fallback` when unset / non-numeric.
 * Values are stored as JSON (the column is `mode: "json"`), so a number set via
 * `POST /budget-config` round-trips as a number here.
 */
export async function readConfigNumber(
  env: Env,
  key: string,
  fallback: number | null,
): Promise<number | null> {
  const [row] = await getDb(env)
    .select({ value: globalConfig.value })
    .from(globalConfig)
    .where(eq(globalConfig.key, key))
    .limit(1);
  const v = row?.value;
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/** MTD total, preferring actual-billed and falling back to the estimate. */
export interface MtdTotal {
  mtdUsd: number;
  /** "billed" = Billable Usage API; "estimated" = reconstructed daily_cost. */
  mtdSource: "billed" | "estimated";
}

/**
 * Month-to-date TOTAL Cloudflare spend. Prefers Cloudflare's actual billed
 * figures (`billable_usage.totalByDay`); if that table has no rows for the
 * current UTC month yet, falls back to the reconstructed `daily_cost` estimate
 * so the guard is never blind. 35-day windows guarantee the whole current month
 * is in range regardless of the day.
 */
export async function getMtdTotal(env: Env): Promise<MtdTotal> {
  const month = monthPrefix();
  const billed = await getBillableUsageReport(env, 35);
  const billedMtd = sumMonth(billed.totalByDay, month);
  if (billedMtd > 0) return { mtdUsd: billedMtd, mtdSource: "billed" };
  // No billed rows for this month yet (API lag / missing Billing:Read scope) →
  // reconstructed estimate rather than a false $0.
  const est = await getDailyCostReport(env, 35);
  return { mtdUsd: sumMonth(est.totalByDay, month), mtdSource: "estimated" };
}

/** Is there already an `active` incident of this source (+ optional scope)? */
async function hasActiveIncident(
  env: Env,
  source: "budget_cap" | "infra_spike",
  scope?: string,
): Promise<boolean> {
  const conds = [
    eq(circuitBreakEvents.source, source),
    eq(circuitBreakEvents.status, "active"),
  ];
  if (scope !== undefined) conds.push(eq(circuitBreakEvents.scope, scope));
  const [row] = await getDb(env)
    .select({ id: circuitBreakEvents.id })
    .from(circuitBreakEvents)
    .where(and(...conds))
    .limit(1);
  return row != null;
}

/** File the frontend notification for an incident (never rolls back the row). */
async function notify(
  env: Env,
  incidentId: string,
  type: "error" | "warning",
  title: string,
  body: string,
): Promise<void> {
  try {
    const ns = env.NOTIFICATIONS_AGENT as unknown as DurableObjectNamespace<NotificationsAgent>;
    const feed = await getAgentByName(ns, "global");
    await feed.add({
      type,
      title,
      body,
      severity: type,
      actor: "guardian.offense",
      entityType: "circuit_break_event",
      entityId: incidentId,
      href: "/api/guardian/offense/incidents?status=active",
    });
  } catch (err) {
    console.error(
      JSON.stringify({ level: "ERROR", source: "guardian.offense.notify", error: String(err) }),
    );
  }
}

// ---------------------------------------------------------------------------
// 1. Nuclear total-CF-budget breaker
// ---------------------------------------------------------------------------

export interface NuclearResult {
  incidentFiled: boolean;
  incidentId?: string;
  killSwitchEngaged: boolean;
  mtdUsd: number;
  mtdSource: "billed" | "estimated";
  budgetUsd: number | null;
  note: string;
}

/**
 * Compare MTD total CF spend to `nuclear_budget_usd`. At/over budget, with the
 * kill switch not already on and no active `budget_cap` incident, engage the AI
 * kill switch (blocks ALL AI through our APIs) and file the nuclear incident.
 *
 * No-op when the budget is unset — the nuke is opt-in by design.
 */
export async function checkNuclearBudget(env: Env): Promise<NuclearResult> {
  const budgetUsd = await readConfigNumber(env, NUCLEAR_BUDGET_KEY, null);
  const { mtdUsd, mtdSource } = await getMtdTotal(env);
  const base = { killSwitchEngaged: false, mtdUsd, mtdSource, budgetUsd } as const;

  if (budgetUsd == null || budgetUsd <= 0) {
    return { ...base, incidentFiled: false, note: "no nuclear_budget_usd configured — no-op" };
  }
  if (!overBudget(mtdUsd, budgetUsd)) {
    return {
      ...base,
      incidentFiled: false,
      note: `under budget: $${mtdUsd.toFixed(2)} < $${budgetUsd} (${mtdSource})`,
    };
  }
  // SAFETY: engage the kill switch whenever over budget and it isn't already on,
  // INDEPENDENT of incident dedupe — so a manual lift while still over budget
  // re-engages the nuke on the next check. The way to allow more spend is to
  // RAISE the budget, not lift the switch.
  const alreadyOn = await getKillSwitch(env);
  const killSwitchEngaged = !alreadyOn;
  if (killSwitchEngaged) await setKillSwitch(env, true);

  // Dedupe the INCIDENT only (the kill switch is already handled above): don't
  // file a second active budget_cap row.
  if (await hasActiveIncident(env, "budget_cap")) {
    return {
      ...base,
      killSwitchEngaged,
      incidentFiled: false,
      note: killSwitchEngaged
        ? "re-engaged kill switch; active budget_cap incident already on record"
        : "active budget_cap incident already on record",
    };
  }

  const db = getDb(env);
  const now = Date.now();

  const reason =
    `NUCLEAR: month-to-date total Cloudflare spend $${mtdUsd.toFixed(2)} (${mtdSource}) reached the ` +
    `configured budget of $${budgetUsd}. AI kill switch ${alreadyOn ? "already engaged" : "engaged"} — ` +
    `all AI through core-guardian is blocked.`;

  const actionsTaken: CircuitBreakAction[] = killSwitchEngaged
    ? [{ kind: "kill_switch", detail: `AI kill switch engaged: MTD $${mtdUsd.toFixed(2)} >= budget $${budgetUsd}.`, at: now }]
    : [];

  const incidentId = crypto.randomUUID();
  await db.insert(circuitBreakEvents).values({
    id: incidentId,
    projectIdentification: null,
    scope: "global",
    reason,
    source: "budget_cap",
    status: "active",
    actionsTaken: actionsTaken.length ? actionsTaken : null,
    recommendation: {
      summary: "Total CF budget reached — AI paused. Confirm the spend, cut the driver, then mark erroneous to lift the kill switch.",
      details: { mtdUsd, mtdSource, budgetUsd },
    },
    createdAt: now,
  });
  await db.insert(billingEvents).values({
    id: crypto.randomUUID(),
    service: "offense",
    actionTaken: `Filed budget_cap incident ${incidentId}: ${reason}`,
    timestamp: now,
  });
  await notify(env, incidentId, "error", "Total CF budget reached — AI paused", reason);

  return { ...base, incidentFiled: true, incidentId, killSwitchEngaged, note: "nuclear incident filed" };
}

// ---------------------------------------------------------------------------
// 2. Non-AI infra-spike guard
// ---------------------------------------------------------------------------

/** Remediation hint per non-AI service. Names the one-click fix (P9b action layer). */
function remediationFor(service: string): string {
  if (service === "r2") return "archive-r2";
  if (service.startsWith("durable-objects") || service === "d1") return "kill-cron";
  return "investigate";
}

export interface InfraSpikeResult {
  incidentsFiled: number;
  incidentIds: string[];
  thresholdUsd: number;
  /** Every non-AI service scanned, with its MTD and whether it tripped. */
  services: { service: string; mtdUsd: number; overThreshold: boolean }[];
  note: string;
}

/**
 * File a loud (recommend-only) `infra_spike` incident for each non-AI service
 * whose MTD exceeds `infra_spike_threshold_usd`, deduping per service scope so a
 * sustained spike files at most one active incident per service.
 */
export async function checkInfraSpikes(env: Env): Promise<InfraSpikeResult> {
  const thresholdUsd = (await readConfigNumber(env, INFRA_SPIKE_KEY, DEFAULT_INFRA_SPIKE_USD)) ??
    DEFAULT_INFRA_SPIKE_USD;
  const month = monthPrefix();
  const report = await getDailyCostReport(env, 35);
  const nonAi = nonAiServiceMtds(report, month);

  const services = nonAi.map((s) => ({
    service: s.service,
    mtdUsd: s.mtdUsd,
    overThreshold: overThreshold(s.mtdUsd, thresholdUsd),
  }));

  const db = getDb(env);
  const incidentIds: string[] = [];
  for (const s of services) {
    if (!s.overThreshold) continue;
    const scope = s.service;
    if (await hasActiveIncident(env, "infra_spike", scope)) continue;

    const now = Date.now();
    const remediation = remediationFor(s.service);
    const reason =
      `INFRA SPIKE: non-AI service "${s.service}" month-to-date spend $${s.mtdUsd.toFixed(2)} exceeds the ` +
      `$${thresholdUsd} threshold. Owner expects ~$0 non-AI — investigate immediately.`;
    const incidentId = crypto.randomUUID();
    await db.insert(circuitBreakEvents).values({
      id: incidentId,
      projectIdentification: null,
      scope,
      reason,
      source: "infra_spike",
      status: "active",
      actionsTaken: null, // recommend-only: core-guardian can't gate non-AI directly
      recommendation: {
        summary: `Non-AI infra spike on ${s.service}. Recommended remediation: ${remediation}.`,
        details: { service: s.service, mtdUsd: s.mtdUsd, thresholdUsd, remediation },
      },
      createdAt: now,
    });
    await db.insert(billingEvents).values({
      id: crypto.randomUUID(),
      service: "offense",
      actionTaken: `Filed infra_spike incident ${incidentId}: ${reason}`,
      timestamp: now,
    });
    await notify(env, incidentId, "error", `Non-AI infra spike: ${s.service}`, reason);
    incidentIds.push(incidentId);
  }

  return {
    incidentsFiled: incidentIds.length,
    incidentIds,
    thresholdUsd,
    services,
    note: incidentIds.length ? `${incidentIds.length} infra_spike incident(s) filed` : "no new spikes",
  };
}

// ---------------------------------------------------------------------------
// Self-check — pure threshold/dedupe decision helpers. Never runs in the Worker.
// ---------------------------------------------------------------------------
if (import.meta.main) {
  const assert = (cond: boolean, m: string) => {
    if (!cond) throw new Error(m);
  };
  // monthPrefix + sumMonth: only same-month, non-null points count.
  assert(monthPrefix(Date.UTC(2026, 7, 13)) === "2026-08", "month prefix");
  const pts = [
    { day: "2026-08-01", costUsd: 3 },
    { day: "2026-08-12", costUsd: 4 },
    { day: "2026-07-31", costUsd: 100 }, // prior month — excluded
    { day: "2026-08-13", costUsd: null }, // unpriced — excluded
  ];
  assert(sumMonth(pts, "2026-08") === 7, `sumMonth: ${sumMonth(pts, "2026-08")}`);
  // Nuke fires at/over budget, not under.
  assert(overBudget(500, 500), "at budget fires");
  assert(overBudget(501, 500), "over budget fires");
  assert(!overBudget(499.99, 500), "under budget holds");
  // Spike is strictly over the threshold (a $0 baseline never trips).
  assert(overThreshold(5.01, 5), "over threshold fires");
  assert(!overThreshold(5, 5), "at threshold holds (recommend-only guard is strict)");
  assert(!overThreshold(0, 5), "zero baseline holds");
  // nonAiServiceMtds drops the AI line and $0 baselines, sorts high→low.
  const rep = {
    services: [
      { service: "workers-ai", points: [{ day: "2026-08-01", costUsd: 200 }] },
      { service: "d1", points: [{ day: "2026-08-01", costUsd: 8 }] },
      { service: "r2", points: [{ day: "2026-08-01", costUsd: 12 }] },
      { service: "kv", points: [{ day: "2026-08-01", costUsd: 0 }] },
    ],
  } as unknown as DailyCostReport;
  const mtds = nonAiServiceMtds(rep, "2026-08");
  assert(mtds.length === 2, `non-ai count: ${mtds.length}`);
  assert(mtds[0].service === "r2" && mtds[0].mtdUsd === 12, "sorted high→low, AI excluded");
  assert(mtds[1].service === "d1", "d1 second");
  assert(remediationFor("r2") === "archive-r2", "r2 remediation");
  assert(remediationFor("durable-objects-cpu") === "kill-cron", "DO remediation");
  assert(remediationFor("images") === "investigate", "default remediation");
  // eslint-disable-next-line no-console
  console.log("ok — nuclear budget/spike decision helpers verified");
}
