/**
 * @fileoverview Allowance-projection alerting — turns raw usage into actionable
 * findings.
 *
 * For every probe that has a comparable included allowance, we sum the usage
 * snapshots since the billing period started, straight-line project that to the
 * period end (`allowanceStatus`), and raise an alert when the projected fraction
 * of the included allowance crosses a band. The alert names the resource and its
 * owning worker (from the attribution graph), diagnoses the cause, recommends a
 * fix, and prices the projected overage against the scraped pricing catalog.
 *
 * This is the fix for "Surge detected: 45523699 rows read in 1h exceeds
 * threshold 5000000" — an unactionable raw integer with a guessed threshold.
 *
 * @see {@link file://src/backend/db/schemas/governance/alerts.ts}
 */

import { and, gte, sql } from "drizzle-orm";

import { getDb } from "@/backend/db";
import { alerts, pricingRevisions, usageSnapshots } from "@/backend/db/schema";

import {
  includedFor,
  overageCostUsd,
  periodElapsed,
  periodStart,
  resetFor,
  ALLOWANCES,
} from "./allowances";
import { getWorkersPlan } from "./plan";
import type { UsageReading } from "./collect";
import { getBindingIndex } from "./resources";

type Severity = "info" | "warning" | "critical";

/**
 * On the FREE plan, exceeding an included allowance means hitting a HARD CAP
 * (the service degrades/stops), so severity tracks how close to the cap the
 * projection is.
 */
function freeSeverity(fraction: number): Severity | null {
  if (fraction >= 1.0) return "critical";
  if (fraction >= 0.8) return "warning";
  if (fraction >= 0.6) return "info";
  return null;
}

/**
 * On the PAID plan, exceeding an included allowance is BILLABLE OVERAGE, not a
 * cap — so severity tracks the projected overage COST, not the raw percent. A
 * $0.45 overage is informational; a large monthly overage is what deserves
 * attention. When the overage cost is unknown we fall back to the fraction but
 * never escalate past "warning" without a dollar basis.
 */
function paidSeverity(overageUsd: number | null, fraction: number): Severity | null {
  if (overageUsd !== null) {
    if (overageUsd >= 50) return "critical";
    if (overageUsd >= 5) return "warning";
    if (overageUsd >= 0.5) return "info";
    return null; // projected overage under 50¢ — not worth an alert on paid
  }
  // No cost basis: only surface a genuine, sustained overshoot, capped at warning.
  if (fraction >= 1.5) return "warning";
  if (fraction >= 1.0) return "info";
  return null;
}

/** Stable id so re-evaluation updates one row per (service, resource). */
function alertId(service: string, resource: string): string {
  return `${service}::${resource}`;
}

type Rate = { product: string; metric: string; unitPrice: number; perUnits: number };

const STOPWORDS = new Set(["the", "per", "and", "of", "a", "in", "month", "day", "mo"]);

/** Words worth matching between an allowance unit and a scraped rate metric. */
function keywords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}

/**
 * Best-effort USD cost for `overageUnits` (already in the allowance's unit) of a
 * product. A product can carry several scraped rates (storage, ops, egress), so
 * we match the rate whose metric text best overlaps the allowance unit. With no
 * confident match we return null — a wrong dollar figure is worse than "$?".
 */
function priceOverage(
  rates: Rate[],
  product: string,
  allowanceUnit: string,
  overageUnits: number,
): number | null {
  if (overageUnits <= 0) return null;
  const candidates = rates.filter((r) => r.product === product);
  if (candidates.length === 0) return null;

  const want = new Set(keywords(allowanceUnit));
  let best: Rate | null = null;
  let bestScore = 0;
  for (const r of candidates) {
    const score = keywords(r.metric).filter((w) => want.has(w)).length;
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  if (!best || bestScore === 0) return null; // no metric clearly matches → no estimate
  return (overageUnits / best.perUnits) * best.unitPrice;
}

/**
 * Evaluate every comparable reading against its projected allowance and
 * upsert/resolve alerts. Returns the count raised or updated.
 */
export async function evaluateAlerts(env: Env, readings: UsageReading[], now: number): Promise<number> {
  const db = getDb(env);

  // Latest revision per (product, metric) from the scraped catalog. Rows arrive
  // newest-first, so the first time we see a (product, metric) pair wins; we keep
  // ALL metrics per product so priceOverage can match the right one.
  const rateRows = await db
    .select({
      product: pricingRevisions.product,
      metric: pricingRevisions.metric,
      unitPrice: pricingRevisions.unitPrice,
      perUnits: pricingRevisions.perUnits,
      effectiveFrom: pricingRevisions.effectiveFrom,
    })
    .from(pricingRevisions)
    .orderBy(sql`${pricingRevisions.effectiveFrom} DESC`);
  const seenRate = new Set<string>();
  const rates: Rate[] = rateRows.filter((r) => {
    const key = `${r.product}::${r.metric}`;
    if (seenRate.has(key)) return false;
    seenRate.add(key);
    return true;
  });

  const index = await getBindingIndex(env).catch(() => null);
  const plan = await getWorkersPlan(env); // "paid" by default

  let raised = 0;
  const activeIds = new Set<string>();

  for (const reading of readings) {
    const allowance = ALLOWANCES[reading.id];
    if (!allowance || !allowance.comparable) continue; // non-comparable → no fabricated percent
    if (reading.status !== "ok") continue;

    // Plan-aware: which included allowance + reset period apply.
    const included = includedFor(allowance, plan);
    const reset = resetFor(allowance, plan);
    const start = periodStart(now, reset);
    const isCumulative = allowance.cumulative !== false;

    // Flow metrics (rows read, requests) accumulate → SUM the hourly snapshots
    // and straight-line project. Level metrics (bytes stored) do NOT accumulate
    // → take the latest reading and treat it as the projected level (flat).
    let projected: number;
    let projectedFraction: number;
    if (isCumulative) {
      const [{ total }] = await db
        .select({ total: sql<number>`COALESCE(SUM(${usageSnapshots.value}), 0)` })
        .from(usageSnapshots)
        .where(
          and(gte(usageSnapshots.timestamp, start), sql`${usageSnapshots.service} = ${reading.id}`),
        );
      const elapsed = periodElapsed(now, reset);
      projected = (total ?? 0) / Math.max(0.01, elapsed);
      projectedFraction = projected / included;
    } else {
      // Latest snapshot is the current stored level; the live reading is fresher.
      const level = reading.value;
      projected = level;
      projectedFraction = level / included;
    }

    const overageUnits = Math.max(0, projected - included);
    // Overage cost: prefer the deterministic platform rate on the allowance
    // (correct units), fall back to the scraped catalog. Bytes → GB for scraped.
    const overageForScraped = allowance.unit.includes("bytes") ? overageUnits / 1024 ** 3 : overageUnits;
    const scrapedUnit = allowance.unit.includes("bytes") ? "GB stored" : allowance.unit;
    const estCostDelta =
      overageCostUsd(allowance, overageUnits) ??
      priceOverage(rates, reading.id, scrapedUnit, overageForScraped);

    // Severity depends on the plan: paid = cost of overage, free = closeness to cap.
    const severity =
      plan === "free" ? freeSeverity(projectedFraction) : paidSeverity(estCostDelta, projectedFraction);
    if (!severity) continue;

    // Name the worst resource + its worker where a breakdown exists.
    let resource = "(account)";
    let worker: string | null = null;
    if (reading.breakdown.length > 0) {
      const top = [...reading.breakdown].sort((a, b) => b.value - a.value)[0];
      resource = top.label;
      if (index) {
        // Try each key prefix that could carry this resource name/id.
        for (const prefix of ["d1", "kv", "r2", "vectorize", "queue"]) {
          const owners = index.byResource[`${prefix}:${top.label}`];
          if (owners?.length) {
            worker = owners.map((o) => o.worker).slice(0, 3).join(", ");
            break;
          }
        }
      }
    }

    const pct = Math.round(projectedFraction * 100);
    const per = reset === "daily" ? "day" : "mo";
    const costStr = estCostDelta !== null ? `$${estCostDelta.toFixed(2)}` : null;

    const cause =
      plan === "paid"
        ? `Projected to ${pct}% of the ${included.toLocaleString()} ${allowance.unit}/${per} included allowance` +
          (costStr ? ` — ~${costStr} in billable overage this ${per === "day" ? "day" : "month"}` : "") +
          (resource !== "(account)" ? `; ${resource} is the top consumer.` : ".")
        : `Projected to ${pct}% of the FREE ${included.toLocaleString()} ${allowance.unit}/${per} cap` +
          (resource !== "(account)" ? `; ${resource} is the top consumer.` : ".");
    const recommendation =
      plan === "free"
        ? `Free-plan cap — at 100% the service is throttled/stops. Cut ${resource}${worker ? ` (worker ${worker})` : ""} or upgrade to Workers Paid.`
        : severity === "critical"
          ? `Sizable projected overage${costStr ? ` (~${costStr})` : ""}. Inspect ${resource}${worker ? ` (worker ${worker})` : ""} and cut usage if the spend isn't intended.`
          : `Billable overage${costStr ? ` (~${costStr})` : ""} on your Paid plan — expected, not a cap. Watch ${resource}${worker ? ` (worker ${worker})` : ""}.`;

    const id = alertId(reading.id, resource);
    activeIds.add(id);

    // Upsert: preserve a snooze that is still in the future.
    const [existing] = await db.select().from(alerts).where(sql`${alerts.id} = ${id}`).limit(1);
    const stillSnoozed =
      existing?.status === "snoozed" && existing.snoozedUntil && existing.snoozedUntil > now;

    if (existing) {
      await db
        .update(alerts)
        .set({
          service: reading.id,
          resource,
          worker,
          severity,
          cause,
          recommendation,
          projectedFraction: projectedFraction,
          estCostDelta,
          status: stillSnoozed ? "snoozed" : "active",
          updatedAt: now,
        })
        .where(sql`${alerts.id} = ${id}`);
    } else {
      await db.insert(alerts).values({
        id,
        service: reading.id,
        resource,
        worker,
        severity,
        cause,
        recommendation,
        projectedFraction: projectedFraction,
        estCostDelta,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
    }
    raised++;
  }

  // Auto-resolve alerts that no longer project over their band this run.
  const active = await db.select({ id: alerts.id }).from(alerts).where(sql`${alerts.status} != 'resolved'`);
  for (const a of active) {
    if (!activeIds.has(a.id)) {
      await db.update(alerts).set({ status: "resolved", updatedAt: now }).where(sql`${alerts.id} = ${a.id}`);
    }
  }

  return raised;
}

// ---------------------------------------------------------------------------
// Self-check — pure severity + overage-pricing logic. Never runs in the Worker.
// ---------------------------------------------------------------------------
if (import.meta.main) {
  const eq = (a: unknown, b: unknown, m: string) => {
    if (a !== b) throw new Error(`${m}: got ${a}, want ${b}`);
  };
  // Free plan: fraction-based (hard cap).
  eq(freeSeverity(1.55), "critical", "free 155% is critical");
  eq(freeSeverity(0.85), "warning", "free 85% is warning");
  eq(freeSeverity(0.65), "info", "free 65% is info");
  eq(freeSeverity(0.4), null, "free 40% raises nothing");
  // Paid plan: cost-based (billable overage). A tiny overage is not a crisis.
  eq(paidSeverity(0.45, 3.99), null, "paid $0.45 overage → no alert");
  eq(paidSeverity(2, 3.99), "info", "paid $2 overage → info");
  eq(paidSeverity(20, 5), "warning", "paid $20 overage → warning");
  eq(paidSeverity(120, 5), "critical", "paid $120 overage → critical");
  eq(paidSeverity(null, 2.0), "warning", "paid no-cost 200% → capped at warning");
  eq(alertId("d1", "core-remodel"), "d1::core-remodel", "stable id");

  const rates = [
    { product: "d1", metric: "rows read", unitPrice: 0.001, perUnits: 1_000_000 },
    { product: "r2-storage", metric: "GB-month storage (Standard)", unitPrice: 0.015, perUnits: 1 },
    { product: "r2-storage", metric: "Class B operations", unitPrice: 0.36, perUnits: 1_000_000 },
  ];
  // 5B rows over allowance at $0.001 / 1M rows = $5.00
  eq(priceOverage(rates, "d1", "rows read", 5_000_000_000)?.toFixed(2), "5.00", "flow overage");
  // 30 GB over must match the storage rate, not Class B ops → $0.45
  eq(priceOverage(rates, "r2-storage", "GB stored", 30)?.toFixed(2), "0.45", "storage rate match");
  eq(priceOverage(rates, "d1", "rows read", 0), null, "no overage → no price");
  eq(priceOverage(rates, "kv", "operations", 1_000_000), null, "no rate → no price");

  // eslint-disable-next-line no-console
  console.log("ok — alert severity bands + overage pricing verified");
}
