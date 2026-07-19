/**
 * @fileoverview Runs the Guardian usage probes and evaluates them for surges.
 *
 * `collectUsage` fans out one GraphQL request per probe (isolating schema
 * failures) and returns a normalized reading per binding type. `evaluateUsage`
 * is the hourly cron path: it persists every reading to `usage_snapshots` and
 * appends a `billing_events` alert row for each probe whose headline value
 * crossed its threshold.
 *
 * @see {@link file://src/backend/guardian/probes.ts} for the probe registry.
 */

import { getDb } from "@/backend/db";
import { billingEvents, cronRuns, usageSnapshots } from "@/backend/db/schema";
import { queryAccountAnalytics } from "@/backend/lib/cloudflare-graphql";

import type { UsageGroup, UsageProbe } from "./probes";

import { USAGE_PROBES } from "./probes";
import { evaluateRules, type RuleOutcome } from "./rules";

/** One probe's reading over the requested window. */
export type UsageReading = {
  id: string;
  label: string;
  product: string;
  bindings: string[];
  unit: string;
  /** `ok` — queried; `not_metered` — no dataset; `unavailable` — probe failed. */
  status: "ok" | "not_metered" | "unavailable";
  value: number;
  breakdown: { label: string; value: number }[];
  alertThreshold: number | null;
  /** True when `value` crossed `alertThreshold`. */
  surging: boolean;
  error?: string;
};

/** Builds the per-probe GraphQL document. */
function probeQuery(probe: UsageProbe): string {
  return `query GuardianUsage($accountTag: string!, $start: Time!, $end: Time!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        result: ${probe.dataset}(
          filter: { datetimeHour_geq: $start, datetimeHour_leq: $end }
          limit: 10000
        ) { ${probe.selection} }
      }
    }
  }`;
}

/**
 * Runs a single probe.
 *
 * @param env - Worker env
 * @param probe - Registry entry to execute
 * @param start - ISO timestamp for the window start
 * @param end - ISO timestamp for the window end
 * @returns The reading; never throws — probe failures come back as
 *   `status: "unavailable"` with the GraphQL error attached
 */
async function runProbe(
  env: Env,
  probe: UsageProbe,
  start: string,
  end: string,
): Promise<UsageReading> {
  const base = {
    id: probe.id,
    label: probe.label,
    product: probe.product,
    bindings: probe.bindings,
    unit: probe.unit,
    breakdown: [] as { label: string; value: number }[],
    value: 0,
    surging: false,
  };

  if (!probe.dataset) {
    return { ...base, status: "not_metered", alertThreshold: null };
  }

  try {
    const account = await queryAccountAnalytics<{ result: UsageGroup[] }>(env, probeQuery(probe), {
      start,
      end,
    });
    const groups = account.result ?? [];
    const value = probe.value(groups);
    return {
      ...base,
      status: "ok",
      value,
      breakdown: probe.breakdown?.(groups) ?? [],
      alertThreshold: probe.alertThreshold,
      surging: value > probe.alertThreshold,
    };
  } catch (err) {
    return {
      ...base,
      status: "unavailable",
      alertThreshold: probe.alertThreshold,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Collects usage for every registered probe over the trailing `hours` window.
 *
 * @param env - Worker env
 * @param hours - Window size in hours (GraphQL retains 31 days)
 * @returns One reading per probe, in registry order
 *
 * @remarks Probes run concurrently; each is its own subrequest. The registry is
 * ~11 metered entries, well inside the Workers subrequest limit.
 */
export async function collectUsage(env: Env, hours = 24): Promise<UsageReading[]> {
  const end = new Date();
  const start = new Date(end.getTime() - hours * 3_600_000);
  // The analytics API buckets on the hour; truncate so the window aligns with
  // the buckets rather than slicing one in half.
  start.setUTCMinutes(0, 0, 0);
  end.setUTCMinutes(0, 0, 0);

  return await Promise.all(
    USAGE_PROBES.map((probe) => runProbe(env, probe, start.toISOString(), end.toISOString())),
  );
}

/**
 * Hourly cron path: snapshot every reading and alert on threshold crossings.
 *
 * @param env - Worker env
 * @returns The readings collected, plus the ids that triggered an alert
 */
export async function evaluateUsage(
  env: Env,
): Promise<{ readings: UsageReading[]; alerted: string[]; ruleOutcomes: RuleOutcome[] }> {
  const startedAt = Date.now();
  // One hour of data — matches the cron cadence and the analytics bucket size.
  const readings = await collectUsage(env, 1);
  const db = getDb(env);
  const timestamp = Date.now();

  const measured = readings.filter((r) => r.status === "ok");
  if (measured.length > 0) {
    // usage_snapshots has 6 columns; D1 caps bound parameters at 100 per query,
    // so chunk at 16 rows (96 params).
    const rows = measured.map((r) => ({
      id: crypto.randomUUID(),
      service: r.id,
      metric: r.unit,
      value: r.value,
      windowHours: 1,
      timestamp,
    }));
    for (let i = 0; i < rows.length; i += 16) {
      await db.insert(usageSnapshots).values(rows.slice(i, i + 16));
    }
  }

  const surging = measured.filter((r) => r.surging);
  for (const reading of surging) {
    await db.insert(billingEvents).values({
      id: crypto.randomUUID(),
      service: reading.id,
      actionTaken: `Surge detected: ${reading.value} ${reading.unit} in 1h exceeds threshold ${reading.alertThreshold}. No automatic mitigation applied.`,
      timestamp,
    });
  }

  // Declarative rules run after the static probe thresholds; a rule bound to a
  // service overrides that probe's built-in threshold as the operator's intent.
  const ruleOutcomes = await evaluateRules(env, readings);

  const unavailable = readings.filter((r) => r.status === "unavailable");

  // Heartbeat — proves the cron fired even when nothing was surging.
  await db.insert(cronRuns).values({
    id: crypto.randomUUID(),
    ranAt: startedAt,
    durationMs: Date.now() - startedAt,
    probesOk: measured.length,
    probesFailed: unavailable.length,
    alerts: surging.length + ruleOutcomes.length,
    status: unavailable.length === 0 ? "ok" : measured.length === 0 ? "error" : "partial",
    error: unavailable.length > 0 ? (unavailable[0].error ?? null) : null,
  });

  if (unavailable.length > 0) {
    console.warn(
      JSON.stringify({
        level: "WARN",
        source: "guardian.evaluateUsage",
        unavailable: unavailable.map((r) => ({ id: r.id, error: r.error })),
      }),
    );
  }

  return { readings, alerted: surging.map((r) => r.id), ruleOutcomes };
}
