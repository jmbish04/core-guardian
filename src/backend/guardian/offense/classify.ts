/**
 * @fileoverview Deterministic risk classifier for Spend Offense — the zero-AI
 * signal library and 0–100 scorer shared by every scanner (P2 workers, later
 * P3 GitHub Actions).
 *
 * Everything here is pure: a Cloudflare binding list + cron expressions +
 * an invocation count go in, booleans and an integer come out. NO AI, no
 * network, no clock — same input always yields the same score, so a score can
 * be recomputed and audited offline.
 *
 * The score answers one question: "how much billable blast radius does this
 * player have?" AI is the dominant term (Workers AI is what actually runs up
 * the bill — `@cf/openai/gpt-oss-120b` ≈ $18/day), then heavy stateful bindings
 * (Browser Rendering, Vectorize, Durable Objects, D1), then how often it fires
 * (cron cadence + measured invocation frequency).
 *
 * @see {@link file://src/backend/guardian/offense/scan-workers.ts} for the caller.
 * @see {@link file://src/backend/db/schemas/governance/offense/scan-targets.ts} for RiskSignals.
 */

import type { RiskSignals } from "@/backend/db/schemas/governance/offense/scan-targets";

// ---------------------------------------------------------------------------
// Binding classifier
// ---------------------------------------------------------------------------

/** A raw Cloudflare Worker binding object (only `type` matters here). */
export interface WorkerBinding {
  type?: string;
  name?: string;
  [key: string]: unknown;
}

/** The subset of {@link RiskSignals} that is derivable from bindings alone. */
export type BindingSignals = Pick<
  RiskSignals,
  "ai" | "d1" | "vectorize" | "durableObject" | "browser"
>;

/**
 * Cloudflare binding `type` → the {@link RiskSignals} flag it raises.
 *
 * The API reports Workers AI as `ai`, Browser Rendering as `browser`, Durable
 * Objects as `durable_object_namespace`, and D1/Vectorize under their own names.
 * A couple of historical aliases are mapped too so an older binding shape does
 * not silently drop a signal.
 */
const BINDING_TYPE_TO_SIGNAL: Record<string, keyof BindingSignals> = {
  ai: "ai",
  workers_ai: "ai",
  browser: "browser",
  browser_rendering: "browser",
  d1: "d1",
  vectorize: "vectorize",
  durable_object_namespace: "durableObject",
};

/**
 * Reduces a Worker's binding list to its billable-capability signals.
 *
 * @param bindings - The array returned by `/workers/scripts/{id}/bindings`
 * @returns Which of {ai, d1, vectorize, durableObject, browser} the worker binds
 */
export function classifyBindings(bindings: WorkerBinding[]): BindingSignals {
  const signals: BindingSignals = {
    ai: false,
    d1: false,
    vectorize: false,
    durableObject: false,
    browser: false,
  };
  for (const binding of bindings ?? []) {
    const key = BINDING_TYPE_TO_SIGNAL[String(binding?.type ?? "")];
    if (key) signals[key] = true;
  }
  return signals;
}

/** A worker fanning out many subrequests per request looks like a scraper. */
export const SCRAPING_SUBREQUEST_RATIO = 3;

/**
 * Decides the `scraping` signal: a Browser Rendering binding is scraping by
 * definition; otherwise a high subrequest-to-request ratio betrays it (the
 * worker is fetching lots of upstream pages per invocation).
 *
 * @param browser - Whether a Browser Rendering binding is present
 * @param requests - Measured invocations over the analytics window
 * @param subrequests - Measured subrequests over the same window
 */
export function isScraping(browser: boolean, requests: number, subrequests: number): boolean {
  if (browser) return true;
  if (requests <= 0) return false;
  return subrequests / requests >= SCRAPING_SUBREQUEST_RATIO;
}

// ---------------------------------------------------------------------------
// Cron cadence
// ---------------------------------------------------------------------------

/**
 * Counts how many discrete values a single 5-field-cron field matches within
 * its `[min,max]` domain. Handles wildcard, step (star-slash-n), single value,
 * lists (`a,b,c`), ranges (`a-b`), and stepped ranges.
 *
 * This intentionally over-counts (it ignores day-of-month ∧ day-of-week
 * interaction) — for a *risk* estimate an upper bound on firing frequency is
 * the safe direction.
 *
 * @param field - One cron field, e.g. `"*\/5"` or `"0,30"`
 * @param min - Lowest legal value for the field (0 for minute/hour)
 * @param max - Highest legal value (59 minute, 23 hour)
 */
export function countCronField(field: string, min: number, max: number): number {
  const span = max - min + 1;
  let count = 0;
  for (const part of field.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart ? Math.max(1, Number.parseInt(stepPart, 10) || 1) : 1;
    let lo = min;
    let hi = max;
    if (rangePart !== "*" && rangePart !== "") {
      const [a, b] = rangePart.split("-");
      lo = Number.parseInt(a, 10);
      hi = b !== undefined ? Number.parseInt(b, 10) : lo;
      if (Number.isNaN(lo)) continue;
      if (Number.isNaN(hi)) hi = lo;
    }
    lo = Math.max(min, lo);
    hi = Math.min(max, hi);
    if (hi < lo) continue;
    count += Math.floor((hi - lo) / step) + 1;
  }
  // A field can never match more values than exist in its domain.
  return Math.min(count, span);
}

/**
 * Estimates how many times a 5-field cron expression fires per day.
 *
 * Cloudflare cron triggers are standard 5-field (`min hour dom month dow`). We
 * approximate `runs/day ≈ matched-minutes-per-hour × matched-hours-per-day`,
 * an upper bound that ignores the day-of-month/month/day-of-week narrowing.
 *
 * @param expr - A cron expression, e.g. `"*\/5 * * * *"`
 * @returns Estimated firings per day (0 if the expression is unparseable)
 */
export function cronRunsPerDay(expr: string): number {
  const fields = expr.trim().split(/\s+/);
  if (fields.length < 5) return 0;
  const minutesPerHour = countCronField(fields[0], 0, 59);
  const hoursPerDay = countCronField(fields[1], 0, 23);
  return minutesPerHour * hoursPerDay;
}

/** Highest runs/day over a set of cron expressions (0 when there are none). */
export function peakCronRunsPerDay(exprs: string[]): number {
  return (exprs ?? []).reduce((max, e) => Math.max(max, cronRunsPerDay(e)), 0);
}

// ---------------------------------------------------------------------------
// Risk scorer
// ---------------------------------------------------------------------------

/**
 * Per-signal point weights. AI dominates because Workers AI is the line item
 * that actually spikes the bill; stateful bindings are the next tier; cadence
 * and measured frequency are capped log-scaled contributions (see below).
 */
export const RISK_WEIGHTS = {
  ai: 35,
  browser: 15,
  vectorize: 10,
  durableObject: 10,
  d1: 8,
  scraping: 7,
  /** Max points from cron cadence (reached at ~every-minute firing). */
  cadenceMax: 25,
  /** Max points from measured invocation frequency. */
  frequencyMax: 20,
} as const;

/** Reference firings/day that earns the full cadence weight (every minute). */
const CADENCE_REFERENCE_RUNS_PER_DAY = 1440;
/** Reference invocations/day that earns the full frequency weight. */
const FREQUENCY_REFERENCE_PER_DAY = 100_000;

/** Log-scaled fraction in [0,1]: `log10(value+1) / log10(reference+1)`. */
function logFraction(value: number, reference: number): number {
  if (value <= 0) return 0;
  const f = Math.log10(value + 1) / Math.log10(reference + 1);
  return Math.max(0, Math.min(1, f));
}

/** Inputs to {@link scoreRisk}. */
export interface ScoreInput {
  signals: RiskSignals;
  /** The worker's cron expressions (drives the cadence term). */
  cronExprs: string[];
  /** Measured invocations per day from analytics (drives the frequency term). */
  invocationsPerDay: number;
}

/**
 * Computes the deterministic 0–100 billable-risk score.
 *
 * Raw points can exceed 100 (a worker that is AI + browser + every-minute cron +
 * heavily invoked); the score is clamped so 100 means "maximum blast radius".
 *
 * @returns An integer in [0,100]
 */
export function scoreRisk({ signals, cronExprs, invocationsPerDay }: ScoreInput): number {
  let score = 0;
  if (signals.ai) score += RISK_WEIGHTS.ai;
  if (signals.browser) score += RISK_WEIGHTS.browser;
  if (signals.vectorize) score += RISK_WEIGHTS.vectorize;
  if (signals.durableObject) score += RISK_WEIGHTS.durableObject;
  if (signals.d1) score += RISK_WEIGHTS.d1;
  if (signals.scraping) score += RISK_WEIGHTS.scraping;

  score +=
    RISK_WEIGHTS.cadenceMax *
    logFraction(peakCronRunsPerDay(cronExprs), CADENCE_REFERENCE_RUNS_PER_DAY);
  score +=
    RISK_WEIGHTS.frequencyMax * logFraction(invocationsPerDay, FREQUENCY_REFERENCE_PER_DAY);

  return Math.max(0, Math.min(100, Math.round(score)));
}

// ---------------------------------------------------------------------------
// Self-check — runs only under direct `node classify.ts` exec, never in the
// Worker. Asserts the scorer's ordering and edge behavior.
// ---------------------------------------------------------------------------
if (import.meta.main) {
  const noSignals: RiskSignals = {
    cron: false,
    browser: false,
    scraping: false,
    d1: false,
    vectorize: false,
    durableObject: false,
    ai: false,
  };

  // A static-asset worker: no bindings, no cron, no traffic → ~0.
  const staticScore = scoreRisk({ signals: noSignals, cronExprs: [], invocationsPerDay: 0 });
  if (staticScore > 5) throw new Error(`static worker should score ~0, got ${staticScore}`);

  // An AI worker on an every-minute cron → high.
  const hotScore = scoreRisk({
    signals: { ...noSignals, ai: true, cron: true, d1: true },
    cronExprs: ["* * * * *"],
    invocationsPerDay: 50_000,
  });
  if (hotScore < 70) throw new Error(`AI + frequent cron should score high, got ${hotScore}`);
  if (hotScore > staticScore === false) throw new Error("hot must outscore static");

  // Cron cadence parsing.
  if (cronRunsPerDay("* * * * *") !== 1440) throw new Error("every-minute must be 1440/day");
  if (cronRunsPerDay("*/5 * * * *") !== 288) throw new Error("*/5 must be 288/day");
  if (cronRunsPerDay("0 0 * * *") !== 1) throw new Error("daily must be 1/day");
  if (cronRunsPerDay("0 */6 * * *") !== 4) throw new Error("every-6h must be 4/day");
  if (cronRunsPerDay("garbage") !== 0) throw new Error("unparseable must be 0");

  // Cadence must rank a frequent cron above a daily one.
  const frequent = scoreRisk({ signals: noSignals, cronExprs: ["* * * * *"], invocationsPerDay: 0 });
  const daily = scoreRisk({ signals: noSignals, cronExprs: ["0 0 * * *"], invocationsPerDay: 0 });
  if (frequent <= daily) throw new Error("frequent cron must outscore daily cron");

  // Binding classifier + scraping heuristic.
  const b = classifyBindings([{ type: "ai" }, { type: "durable_object_namespace" }, { type: "kv_namespace" }]);
  if (!b.ai || !b.durableObject || b.d1) throw new Error("binding classifier mismatch");
  if (!isScraping(true, 0, 0)) throw new Error("browser binding must read as scraping");
  if (!isScraping(false, 10, 50)) throw new Error("high subrequest ratio must read as scraping");
  if (isScraping(false, 10, 10)) throw new Error("low subrequest ratio must not be scraping");

  // eslint-disable-next-line no-console
  console.log(`ok — static=${staticScore} hot=${hotScore} frequent=${frequent} daily=${daily}`);
}
