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

import { allowanceStatus, periodStart, ALLOWANCES } from "./allowances";
import type { UsageReading } from "./collect";
import { getBindingIndex } from "./resources";

/** Bands on the projected fraction of the included allowance. */
function severityFor(fraction: number): "info" | "warning" | "critical" | null {
  if (fraction >= 1.0) return "critical";
  if (fraction >= 0.8) return "warning";
  if (fraction >= 0.6) return "info";
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

  let raised = 0;
  const activeIds = new Set<string>();

  for (const reading of readings) {
    const allowance = ALLOWANCES[reading.id];
    if (!allowance || !allowance.comparable) continue; // non-comparable → no fabricated percent
    if (reading.status !== "ok") continue;

    const start = periodStart(now, allowance.reset);
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
      const status = allowanceStatus(reading.id, total ?? 0, now);
      if (!status || status.projectedFraction === null) continue;
      projected = status.projected;
      projectedFraction = status.projectedFraction;
    } else {
      // Latest snapshot is the current stored level; the live reading is fresher.
      const level = reading.value;
      projected = level;
      projectedFraction = level / allowance.paidIncluded;
    }

    const severity = severityFor(projectedFraction);
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
    const overageUnits = Math.max(0, projected - allowance.paidIncluded);
    // Unit alignment: the scraped rate is per GB for storage, but the allowance
    // (and thus the overage) is in bytes. Convert before pricing, else a 32 GB
    // overage prices as if it were 32 billion GB.
    const overageForPricing = allowance.unit.includes("bytes")
      ? overageUnits / 1024 ** 3
      : overageUnits;
    // Price against the GB unit when the allowance is bytes, so the rate-metric
    // keyword match ("GB") lines up.
    const pricingUnit = allowance.unit.includes("bytes") ? "GB stored" : allowance.unit;
    const estCostDelta = priceOverage(rates, reading.id, pricingUnit, overageForPricing);

    const cause =
      `Projected to reach ${pct}% of the ${allowance.paidIncluded.toLocaleString()} ${allowance.unit}/` +
      `${allowance.reset === "daily" ? "day" : "mo"} included allowance` +
      (resource !== "(account)" ? `; ${resource} is the top consumer.` : ".");
    const recommendation =
      severity === "critical"
        ? `Projected overage${estCostDelta ? ` ≈ $${estCostDelta.toFixed(2)}` : ""}. Inspect ${resource}${worker ? ` (worker ${worker})` : ""} and cut usage or raise the plan.`
        : `Trending toward the allowance. Watch ${resource}${worker ? ` (worker ${worker})` : ""}; no action needed yet.`;

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
  eq(severityFor(1.55), "critical", "155% is critical");
  eq(severityFor(0.85), "warning", "85% is warning");
  eq(severityFor(0.65), "info", "65% is info");
  eq(severityFor(0.4), null, "40% raises nothing");
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
