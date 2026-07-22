/**
 * @fileoverview Cloudflare Workers Paid ($5/mo) included-allowance table.
 *
 * Cloudflare exposes NO API for plan tier allowances (verified against the
 * OpenAPI spec — there is no `/pricing` or `/plans/limits` path on any
 * product). The billing agent must therefore carry the static thresholds
 * in-repo and compare them against live GraphQL Analytics usage. This file is
 * that curated table.
 *
 * Numbers are the **Workers Paid** column (this account is a paid member); the
 * free column is kept for reference but not used for projection. Each entry
 * cites the pricing doc it was validated against so the cron can re-scrape and
 * flag drift (P2 in the architecture plan).
 *
 * IMPORTANT — the governance model this enables:
 *   The right question is NOT "did usage cross an arbitrary number this hour".
 *   It is "at the current rate, what fraction of the month's INCLUDED allowance
 *   will be consumed by the billing-period end". A probe at 40% of allowance on
 *   day 5 is fine; the same 40% on day 25 is a projected overage. `projectToEnd`
 *   turns a running total into that month-end projection.
 *
 * Keyed by probe id (see {@link file://src/backend/guardian/probes.ts}). Some
 * probes measure a unit that does NOT line up with how Cloudflare meters the
 * allowance — those are marked `comparable: false` with the reason, and the UI
 * must show the raw usage without a bogus percent rather than invent one.
 *
 * @see https://www.cloudflare.com/plans/developer-platform/
 */

/** How the included allowance resets. */
export type ResetPeriod = "monthly" | "daily";

export type Allowance = {
  /** Probe id this allowance grounds (matches USAGE_PROBES). */
  probeId: string;
  /** Included quantity on the Workers Paid plan, expressed in `unit`. */
  paidIncluded: number;
  /** Included quantity on the Workers Free plan (reference only). */
  freeIncluded: number;
  /** Unit the allowance is expressed in. MUST match the probe's measured unit
   *  when `comparable` is true. */
  unit: string;
  reset: ResetPeriod;
  /**
   * True when the probe's measured value can be divided by `paidIncluded` to
   * get a meaningful fraction. False when the probe measures a different
   * physical quantity than the allowance meters (see `note`).
   */
  comparable: boolean;
  /**
   * True (default) for flow metrics that accumulate over the period (rows read,
   * requests, operations) — period-to-date is the SUM of hourly snapshots and
   * projects straight-line. False for level/stock metrics (bytes stored), where
   * period-to-date is the LATEST snapshot and there is no straight-line
   * projection — a stored level does not "accumulate" hour over hour.
   */
  cumulative?: boolean;
  /** Why a probe is not directly comparable, or a caveat when it is. */
  note?: string;
  /** Pricing doc the allowance was validated against, for cron re-check. */
  docUrl: string;
};

/**
 * Workers Paid included allowances, keyed by probe id.
 *
 * Overage *dollar rates* are deliberately NOT in this table — Cloudflare has no
 * pricing API and fabricating half-remembered per-unit rates is exactly the
 * failure mode this rebuild exists to kill. Overage pricing is sourced
 * separately by the P2 pricing-doc scrape and stored in `pricing_rates`.
 */
export const ALLOWANCES: Record<string, Allowance> = {
  d1: {
    probeId: "d1",
    paidIncluded: 25_000_000_000, // 25B rows read / month
    freeIncluded: 5_000_000, // 5M rows read / day
    unit: "rows read",
    reset: "monthly",
    comparable: true,
    docUrl: "https://developers.cloudflare.com/d1/platform/pricing/",
  },
  "r2-storage": {
    probeId: "r2-storage",
    paidIncluded: 10 * 1024 ** 3, // 10 GB
    freeIncluded: 10 * 1024 ** 3,
    unit: "bytes stored",
    reset: "monthly",
    comparable: true,
    cumulative: false, // a stored level, not a flow — use the latest reading
    docUrl: "https://developers.cloudflare.com/r2/pricing/",
  },
  "r2-operations": {
    probeId: "r2-operations",
    // Class B (reads) dominate; the allowance actually SPLITS: Class A (mutate)
    // 1M/mo, Class B (read) 10M/mo. The probe carries an `actionType` dimension
    // that must be used to split before comparing — a single total vs 10M is
    // misleading when writes are the thing surging.
    paidIncluded: 10_000_000,
    freeIncluded: 10_000_000,
    unit: "requests",
    reset: "monthly",
    comparable: false,
    note: "Allowance splits by op class (Class A 1M/mo, Class B 10M/mo). Split by the actionType dimension before showing a percent.",
    docUrl: "https://developers.cloudflare.com/r2/pricing/",
  },
  workers: {
    probeId: "workers",
    paidIncluded: 10_000_000, // 10M requests / month
    freeIncluded: 3_000_000, // 100k/day ≈ 3M/mo
    unit: "requests",
    reset: "monthly",
    comparable: true,
    docUrl: "https://www.cloudflare.com/plans/developer-platform/",
  },
  kv: {
    probeId: "kv",
    // Splits: reads 10M/mo, writes+deletes+lists 1M/mo. Probe sums all ops.
    paidIncluded: 10_000_000,
    freeIncluded: 3_000_000,
    unit: "operations",
    reset: "monthly",
    comparable: false,
    note: "Allowance splits: reads 10M/mo, writes/deletes/lists 1M/mo. The probe sums all op types.",
    docUrl: "https://developers.cloudflare.com/kv/platform/pricing/",
  },
  "durable-objects-requests": {
    probeId: "durable-objects-requests",
    paidIncluded: 1_000_000, // 1M requests / month
    freeIncluded: 3_000_000,
    unit: "requests",
    reset: "monthly",
    comparable: true,
    docUrl: "https://developers.cloudflare.com/durable-objects/platform/pricing/",
  },
  "durable-objects-cpu": {
    probeId: "durable-objects-cpu",
    paidIncluded: 400_000, // 400,000 GB-seconds / month
    freeIncluded: 13_000, // GB-s / day
    unit: "GB-seconds",
    reset: "monthly",
    comparable: false,
    note: "Probe measures µs CPU; allowance meters GB-seconds (duration × memory). Needs the DO memory class to convert — cannot show a clean percent from CPU time alone.",
    docUrl: "https://developers.cloudflare.com/durable-objects/platform/pricing/",
  },
  vectorize: {
    probeId: "vectorize",
    paidIncluded: 50_000_000, // 50M queried dimensions / month
    freeIncluded: 30_000_000,
    unit: "queried vector dimensions",
    reset: "monthly",
    comparable: true,
    docUrl: "https://developers.cloudflare.com/vectorize/platform/pricing/",
  },
  queues: {
    probeId: "queues",
    paidIncluded: 1_000_000, // 1M operations / month
    freeIncluded: 300_000, // 10k/day ≈ 300k/mo
    unit: "billable operations",
    reset: "monthly",
    comparable: true,
    docUrl: "https://developers.cloudflare.com/queues/platform/pricing/",
  },
  "workers-ai": {
    probeId: "workers-ai",
    paidIncluded: 10_000, // 10k neurons / DAY on both tiers
    freeIncluded: 10_000,
    unit: "neurons",
    reset: "daily",
    comparable: true,
    note: "Resets DAILY, not monthly — the only metered probe that does. Project against end-of-day, not month-end.",
    docUrl: "https://developers.cloudflare.com/workers-ai/platform/pricing/",
  },
  "browser-rendering": {
    probeId: "browser-rendering",
    paidIncluded: 36_000_000, // 10 hours / month, in ms
    freeIncluded: 600_000, // 10 min / day, in ms
    unit: "ms browser time",
    reset: "monthly",
    comparable: true,
    note: "Existing probe threshold (10,800,000 ms = 3h) is below the 10h/mo included allowance — retune to allowance-relative.",
    docUrl: "https://developers.cloudflare.com/browser-rendering/platform/pricing/",
  },
  containers: {
    probeId: "containers",
    paidIncluded: 200, // 200 GB-hours disk / month
    freeIncluded: 0,
    unit: "GB-hours disk",
    reset: "monthly",
    comparable: false,
    note: "Probe measures CPU seconds; the included allowance quoted is 200 GB-hours of disk. Different physical metric — surface raw usage, not a percent.",
    docUrl: "https://developers.cloudflare.com/containers/pricing/",
  },
  workflows: {
    probeId: "workflows",
    paidIncluded: 30_000_000, // billed as Workers CPU: 30M ms/mo
    freeIncluded: 0,
    unit: "ms CPU",
    reset: "monthly",
    comparable: false,
    note: "Workflows bill as Workers compute (CPU ms). Probe reports µs CPU; convert before comparing.",
    docUrl: "https://www.cloudflare.com/plans/developer-platform/",
  },
  // ai-gateway is intentionally absent: it meters real upstream USD, not a
  // Cloudflare-included allowance. Its budget lives in the AI Gateway billing
  // spending-limit API, not this table.
};

/** Epoch ms at the start of the current billing period. */
export function periodStart(now: number, reset: ResetPeriod): number {
  const d = new Date(now);
  if (reset === "daily") {
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** Fraction of the current billing period elapsed (0..1). */
export function periodElapsed(now: number, reset: ResetPeriod): number {
  const d = new Date(now);
  if (reset === "daily") {
    const dayMs = 86_400_000;
    const startOfDay = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    return Math.min(1, Math.max(0, (now - startOfDay) / dayMs));
  }
  // ponytail: calendar month, not the account's billing anchor date. Cloudflare
  // bills on the signup-date cycle; using the calendar month over/under-shoots
  // the projection by at most a few days. Swap for the real cycle start when
  // the billing-profile endpoint is wired.
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const nextMonth = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return Math.min(1, Math.max(0, (now - start) / (nextMonth - start)));
}

export type AllowanceStatus = {
  probeId: string;
  comparable: boolean;
  /** Usage so far this billing period, in the allowance's unit. */
  usedSoFar: number;
  /** Included allowance for the period. */
  included: number;
  /** Straight-line projection of period-end usage. */
  projected: number;
  /** projected / included, 0..∞. >1 means projected overage. Null when not comparable. */
  projectedFraction: number | null;
  /** usedSoFar / included, 0..∞. Null when not comparable. */
  usedFraction: number | null;
  note?: string;
  docUrl: string;
};

/**
 * Project a running total to the billing-period end and express it against the
 * included allowance. This is the number the overview and alerts should lead
 * with — "on track for 150% of included D1 reads" beats "45.5M rows this hour".
 *
 * @param probeId    probe id (must exist in ALLOWANCES)
 * @param usedSoFar  usage accumulated since the start of the billing period,
 *                   already in the allowance's unit
 * @param now        current epoch ms (pass in; do not call Date.now here so the
 *                   cron and tests are deterministic)
 */
export function allowanceStatus(
  probeId: string,
  usedSoFar: number,
  now: number,
): AllowanceStatus | null {
  const a = ALLOWANCES[probeId];
  if (!a) return null;
  const elapsed = periodElapsed(now, a.reset);
  // Guard the first moments of a period where elapsed→0 would explode the
  // projection; clamp to at least 1% elapsed.
  const projected = usedSoFar / Math.max(0.01, elapsed);
  return {
    probeId,
    comparable: a.comparable,
    usedSoFar,
    included: a.paidIncluded,
    projected,
    projectedFraction: a.comparable ? projected / a.paidIncluded : null,
    usedFraction: a.comparable ? usedSoFar / a.paidIncluded : null,
    note: a.note,
    docUrl: a.docUrl,
  };
}

// ---------------------------------------------------------------------------
// Self-check — runs only under `node allowances.ts` style direct exec, never in
// the Worker. Verifies the projection math on the real D1 case.
// ---------------------------------------------------------------------------
if (import.meta.main) {
  // 5 days into a 30-day month, 6.25B rows read so far → ~37.5B projected.
  const fiveDaysIn = Date.UTC(2026, 6, 6, 0, 0, 0); // Jul 6, ~16.6% elapsed
  const s = allowanceStatus("d1", 6_250_000_000, fiveDaysIn);
  if (!s || s.projectedFraction === null) throw new Error("d1 must be comparable");
  const pct = Math.round(s.projectedFraction * 100);
  // 6.25B / 0.1667 ≈ 37.5B; 37.5B / 25B ≈ 150%
  if (pct < 140 || pct > 160) throw new Error(`projection off: got ${pct}%`);

  // Not-comparable probe must refuse to invent a fraction.
  const doCpu = allowanceStatus("durable-objects-cpu", 1_000_000, fiveDaysIn);
  if (doCpu?.projectedFraction !== null) throw new Error("non-comparable must be null");

  // eslint-disable-next-line no-console
  console.log(`ok — d1 projects to ${pct}% of the 25B/mo included allowance`);
}
