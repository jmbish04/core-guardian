/**
 * @fileoverview Sustained-spend auto-breaker (Spend Offense, P1).
 *
 * The daily-cost rollup ({@link file://src/backend/guardian/daily-cost.ts})
 * already reconstructs total USD per UTC day. This module reads the last two
 * COMPLETE days off that report and, if both exceed the daily threshold, files
 * one `circuit_break_events` incident (source `auto_spend`) so the dashboard and
 * the local watchdog surface it.
 *
 * ## Safety (see docs/architecture/spend-offense.md → "Auto-break safety")
 * Sustained spend is account-wide, not project-scoped, so a false positive must
 * NOT take AI offline. The default behaviour is **recommend-only**: file an
 * active incident, audit it, notify — do not cut anything. Only if the operator
 * has explicitly configured `HARD_CEILING_USD` (default OFF) and both days clear
 * *that* higher bar does it additionally flip the AI kill switch.
 *
 * ## Idempotence
 * Runs at most once per day off the hourly cron. Even if called repeatedly it
 * dedupes: it will not file a second incident while an `active` `auto_spend`
 * incident already exists. The resolve flow (mark read / erroneous) is what
 * clears the way for the next one.
 *
 * Zero AI. This is a threshold comparison over data already in D1.
 */

import { and, desc, eq } from "drizzle-orm";

import { getDb } from "@/backend/db";
import {
  billingEvents,
  circuitBreakEvents,
  type CircuitBreakAction,
} from "@/backend/db/schema";
import { NotificationsAgent } from "@/backend/ai/agents/NotificationsAgent";
import { getDailyCostReport } from "@/backend/guardian/daily-cost";
import { setKillSwitch } from "@/backend/guardian/ai-router/circuits";
import { getAgentByName } from "agents";

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * Both of the last two complete days must exceed this reconstructed USD figure
 * to file an incident. Baseline is ~$20/day, so $35 catches a real spike, not
 * noise. Override per-deploy with the `OFFENSE_DAILY_THRESHOLD_USD` var.
 */
export const DAILY_THRESHOLD_USD = 35;

/**
 * If set (via `OFFENSE_HARD_CEILING_USD`) and both days exceed it, the incident
 * additionally flips the AI kill switch. Default `null` = auto-kill DISABLED —
 * the safe default that keeps a false positive from taking AI offline.
 */
export const HARD_CEILING_USD: number | null = null;

/**
 * Read a numeric override off `env` by name, falling back to `fallback`.
 * Worker vars arrive as strings; a blank/NaN/absent value keeps the default.
 * `null` is a valid fallback (hard ceiling), so only a parseable number wins.
 */
function numFromEnv(env: Env, key: string, fallback: number | null): number | null {
  const raw = (env as unknown as Record<string, unknown>)[key];
  if (typeof raw !== "string" || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

// ---------------------------------------------------------------------------
// Checker
// ---------------------------------------------------------------------------

/** Outcome of one {@link checkSustainedSpend} run. */
export interface SustainedSpendResult {
  /** True when a new incident was filed this run. */
  incidentFiled: boolean;
  /** The new incident id, when one was filed. */
  incidentId?: string;
  /** True when the AI kill switch was flipped (hard-ceiling breach). */
  killSwitchFlipped: boolean;
  /** The two complete days evaluated, oldest → newest. */
  days: { day: string; costUsd: number }[];
  /** The effective daily threshold used. */
  dailyThresholdUsd: number;
  /** The effective hard ceiling (null = disabled). */
  hardCeilingUsd: number | null;
  /** Short reason the run took (or skipped) its action — for logs. */
  note: string;
}

/**
 * Evaluate the last two complete days of reconstructed spend and, if both are
 * over the daily threshold with no existing active `auto_spend` incident, file
 * one. Recommend-only unless the hard ceiling is configured and breached.
 *
 * @param env - Worker env (D1, CIRCUITS KV, NotificationsAgent binding)
 * @returns a summary of what happened
 */
export async function checkSustainedSpend(env: Env): Promise<SustainedSpendResult> {
  const dailyThresholdUsd = numFromEnv(env, "OFFENSE_DAILY_THRESHOLD_USD", DAILY_THRESHOLD_USD) ??
    DAILY_THRESHOLD_USD;
  const hardCeilingUsd = numFromEnv(env, "OFFENSE_HARD_CEILING_USD", HARD_CEILING_USD);

  // Pull 3 days: today (incomplete, dropped) + the two complete days we score.
  const report = await getDailyCostReport(env, 3);
  const totals = report.totalByDay;

  const base = {
    killSwitchFlipped: false,
    dailyThresholdUsd,
    hardCeilingUsd,
  } as const;

  if (totals.length < 3) {
    // Fewer than 3 days of history → not enough to see the last two COMPLETE days.
    return {
      ...base,
      incidentFiled: false,
      days: totals,
      note: `insufficient history: ${totals.length} day(s)`,
    };
  }

  // Drop the last entry (today, still accumulating); score the two before it.
  const [dayA, dayB] = totals.slice(-3, -1);
  const days = [dayA, dayB];

  if (!(dayA.costUsd > dailyThresholdUsd && dayB.costUsd > dailyThresholdUsd)) {
    return {
      ...base,
      incidentFiled: false,
      days,
      note: `below threshold ($${dailyThresholdUsd}): ${dayA.costUsd.toFixed(2)}, ${dayB.costUsd.toFixed(2)}`,
    };
  }

  const db = getDb(env);

  // Dedupe: never spam a second active incident from the same source.
  const [existing] = await db
    .select({ id: circuitBreakEvents.id })
    .from(circuitBreakEvents)
    .where(
      and(eq(circuitBreakEvents.status, "active"), eq(circuitBreakEvents.source, "auto_spend")),
    )
    .orderBy(desc(circuitBreakEvents.createdAt))
    .limit(1);
  if (existing) {
    return {
      ...base,
      incidentFiled: false,
      days,
      note: `active auto_spend incident already open (${existing.id})`,
    };
  }

  const now = Date.now();
  const breachHardCeiling =
    hardCeilingUsd != null && dayA.costUsd > hardCeilingUsd && dayB.costUsd > hardCeilingUsd;

  // Hard-ceiling breach → flip the kill switch and record it. Otherwise recommend-only.
  const actionsTaken: CircuitBreakAction[] = [];
  let killSwitchFlipped = false;
  if (breachHardCeiling) {
    await setKillSwitch(env, true);
    killSwitchFlipped = true;
    actionsTaken.push({
      kind: "kill_switch",
      detail: `AI kill switch enabled: both days exceeded the hard ceiling ($${hardCeilingUsd}).`,
      at: now,
    });
  }

  const reason = breachHardCeiling
    ? `Sustained spend over the hard ceiling ($${hardCeilingUsd}) two days running (${dayA.day}: $${dayA.costUsd.toFixed(2)}, ${dayB.day}: $${dayB.costUsd.toFixed(2)}). AI kill switch engaged.`
    : `Sustained spend over the daily threshold ($${dailyThresholdUsd}) two days running (${dayA.day}: $${dayA.costUsd.toFixed(2)}, ${dayB.day}: $${dayB.costUsd.toFixed(2)}).`;

  const incidentId = crypto.randomUUID();
  await db.insert(circuitBreakEvents).values({
    id: incidentId,
    projectIdentification: null,
    scope: breachHardCeiling ? "global" : null,
    reason,
    source: "auto_spend",
    status: "active",
    actionsTaken: actionsTaken.length ? actionsTaken : null,
    recommendation: {
      summary: breachHardCeiling
        ? "Kill switch engaged. Confirm the spike is real, or mark erroneous to lift it."
        : "Investigate the two-day spend spike. Cut the offending workload or engage the kill switch.",
      details: {
        days,
        dailyThresholdUsd,
        hardCeilingUsd,
      },
    },
    createdAt: now,
  });

  // Audit row on the governance trail.
  await db.insert(billingEvents).values({
    id: crypto.randomUUID(),
    service: "offense",
    actionTaken: `Filed auto_spend incident ${incidentId}: ${reason}`,
    timestamp: now,
  });

  // Surface to the frontend notification feed.
  try {
    const ns = env.NOTIFICATIONS_AGENT as unknown as DurableObjectNamespace<NotificationsAgent>;
    const feed = await getAgentByName(ns, "global");
    await feed.add({
      type: breachHardCeiling ? "error" : "warning",
      title: breachHardCeiling ? "Spend ceiling breached — AI paused" : "Sustained spend spike",
      body: reason,
      severity: breachHardCeiling ? "error" : "warning",
      actor: "guardian.offense",
      entityType: "circuit_break_event",
      entityId: incidentId,
      href: "/api/guardian/offense/incidents?status=active",
    });
  } catch (err) {
    // The incident is already durable in D1; a notification failure must not
    // roll it back. Log and move on.
    console.error(
      JSON.stringify({ level: "ERROR", source: "guardian.offense.notify", error: String(err) }),
    );
  }

  return {
    ...base,
    incidentFiled: true,
    incidentId,
    killSwitchFlipped,
    days,
    note: breachHardCeiling ? "incident filed + kill switch flipped" : "incident filed (recommend-only)",
  };
}

// ---------------------------------------------------------------------------
// Self-check — the pure env-override parser. Never runs in the Worker.
// ---------------------------------------------------------------------------
if (import.meta.main) {
  const eq = (a: unknown, b: unknown, m: string) => {
    if (a !== b) throw new Error(`${m}: got ${a}, want ${b}`);
  };
  const mk = (v?: unknown) => ({ K: v }) as unknown as Env;
  eq(numFromEnv(mk("50"), "K", 35), 50, "parses numeric override");
  eq(numFromEnv(mk(), "K", 35), 35, "absent → number fallback");
  eq(numFromEnv(mk(""), "K", 35), 35, "blank → fallback");
  eq(numFromEnv(mk("nope"), "K", 35), 35, "NaN → fallback");
  eq(numFromEnv(mk(), "K", null), null, "absent → null fallback (hard ceiling off)");
  eq(numFromEnv(mk("60"), "K", null), 60, "override enables a null-default ceiling");
  // eslint-disable-next-line no-console
  console.log("ok — auto-break env-override parser verified");
}
