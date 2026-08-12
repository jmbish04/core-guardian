/**
 * @fileoverview Pure spend-metrics math for the SpendOverview island.
 *
 * Fed the `GET /api/guardian/daily-cost` `totalByDay` series, it derives the
 * true MTD metered spend, a straight-line month-end projection (run-rate), and
 * a merged actual+projected chart series. No DOM, no fetch, no clock — `now` is
 * passed in so the cron and this self-check stay deterministic.
 *
 * The headline it produces is **true metered spend** (sum of priced daily cost),
 * NOT overage-above-allowance — the mislabel this whole surface exists to fix.
 *
 * Self-checked at the bottom (`npx tsx spend-metrics.ts`).
 */

export type DayPoint = { day: string; costUsd: number };

/** One point on the merged spend axis: actual `cost` for past days, `projected`
 *  run-rate for future days, with a single bridge day carrying both so the
 *  dashed projection visually connects to the solid actual line. */
export type SpendChartPoint = {
  day: string;
  cost: number | null;
  projected: number | null;
  future: boolean;
};

export type SpendMetrics = {
  /** Sum of priced daily cost for days in the current calendar month (UTC). */
  mtd: number;
  /** Latest day's priced cost — "today so far". */
  today: number;
  /** Day-over-day change, passed through from the API. */
  deltaUsd: number | null;
  /** Elapsed days of the current month with data (the run-rate denominator). */
  elapsedDays: number;
  /** Calendar days in the current month. */
  daysInMonth: number;
  /** MTD ÷ elapsed days — the average daily burn. */
  runRatePerDay: number;
  /** run-rate × days-in-month — where the bill lands if nothing changes. */
  projectedMonthEnd: number;
  /** Full month name, e.g. "August". */
  monthLabel: string;
  /** Merged actual + projected series for the line and bar charts. */
  chart: SpendChartPoint[];
};

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Derive spend metrics from the daily-cost total series.
 *
 * @param totalByDay  `daily-cost.totalByDay` — priced USD per UTC day, ascending.
 * @param deltaUsd    `daily-cost.totalDeltaUsd` — latest day-over-day change.
 * @param now         current epoch ms (pass in; never call Date.now here).
 */
export function computeSpendMetrics(
  totalByDay: DayPoint[],
  deltaUsd: number | null,
  now: number,
): SpendMetrics {
  const d = new Date(now);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth(); // 0-based
  const monthPrefix = `${year}-${pad2(month + 1)}`;
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const monthLabel = new Date(Date.UTC(year, month, 1)).toLocaleDateString("en-US", {
    month: "long",
    timeZone: "UTC",
  });

  const monthDays = totalByDay.filter((p) => p.day.startsWith(monthPrefix));
  const mtd = monthDays.reduce((s, p) => s + p.costUsd, 0);
  // "Today so far" = the latest day WITHIN the current month; 0 when the month
  // has no data yet (otherwise this leaks last month's final day at month start).
  const today = monthDays.length ? monthDays[monthDays.length - 1].costUsd : 0;

  // Elapsed days = the day-of-month of the latest day WITH data this month, so
  // the run-rate denominator and MTD numerator cover the same window.
  const latestMonthDay = monthDays.length ? monthDays[monthDays.length - 1].day : null;
  const elapsedDays = latestMonthDay ? new Date(`${latestMonthDay}T00:00:00Z`).getUTCDate() : 0;
  const runRatePerDay = elapsedDays > 0 ? mtd / elapsedDays : 0;
  const projectedMonthEnd = runRatePerDay * daysInMonth;

  // Merged chart series: every actual day (solid), then a projected run-rate
  // continuation from the day after the latest data day to month-end (dashed).
  const chart: SpendChartPoint[] = totalByDay.map((p) => ({
    day: p.day,
    cost: p.costUsd,
    projected: null,
    future: false,
  }));

  if (latestMonthDay && runRatePerDay > 0 && elapsedDays < daysInMonth) {
    // Bridge: the last actual point also carries the projected value so the
    // dashed line starts where the solid line ends (no visual gap).
    const bridge = chart.findLast((c) => c.day === latestMonthDay);
    if (bridge) bridge.projected = bridge.cost;
    for (let dom = elapsedDays + 1; dom <= daysInMonth; dom++) {
      chart.push({
        day: `${monthPrefix}-${pad2(dom)}`,
        cost: null,
        projected: runRatePerDay,
        future: true,
      });
    }
  }

  return {
    mtd,
    today,
    deltaUsd,
    elapsedDays,
    daysInMonth,
    runRatePerDay,
    projectedMonthEnd,
    monthLabel,
    chart,
  };
}

// ---------------------------------------------------------------------------
// Self-check — `npx tsx spend-metrics.ts`.
// ---------------------------------------------------------------------------
if (import.meta.main) {
  // 12 days into August (31-day month), flat $20/day → MTD $240, projected $620.
  const days: DayPoint[] = Array.from({ length: 12 }, (_, i) => ({
    day: `2026-08-${pad2(i + 1)}`,
    costUsd: 20,
  }));
  const now = Date.UTC(2026, 7, 12, 12, 0, 0); // Aug 12
  const m = computeSpendMetrics(days, 0, now);

  if (Math.abs(m.mtd - 240) > 1e-9) throw new Error(`mtd ${m.mtd}`);
  if (m.today !== 20) throw new Error(`today ${m.today}`);
  if (m.elapsedDays !== 12) throw new Error(`elapsedDays ${m.elapsedDays}`);
  if (m.daysInMonth !== 31) throw new Error(`daysInMonth ${m.daysInMonth}`);
  if (Math.abs(m.runRatePerDay - 20) > 1e-9) throw new Error(`runRate ${m.runRatePerDay}`);
  if (Math.abs(m.projectedMonthEnd - 620) > 1e-9) throw new Error(`projected ${m.projectedMonthEnd}`);
  if (m.monthLabel !== "August") throw new Error(`monthLabel ${m.monthLabel}`);

  // Chart: 12 actual + 19 projected future days = 31; bridge day carries both.
  const future = m.chart.filter((c) => c.future);
  if (future.length !== 19) throw new Error(`future days ${future.length}`);
  const bridge = m.chart.find((c) => c.day === "2026-08-12");
  if (!bridge || bridge.cost !== 20 || bridge.projected !== 20) {
    throw new Error("bridge day must carry both cost and projected");
  }
  if (future.some((c) => Math.abs((c.projected ?? 0) - 20) > 1e-9)) {
    throw new Error("projected days must be at run-rate");
  }

  // Prior-month days are excluded from MTD but stay on the chart line.
  const withPrior = computeSpendMetrics(
    [{ day: "2026-07-31", costUsd: 99 }, ...days],
    0,
    now,
  );
  if (Math.abs(withPrior.mtd - 240) > 1e-9) throw new Error("prior-month day leaked into MTD");
  if (!withPrior.chart.some((c) => c.day === "2026-07-31" && c.cost === 99)) {
    throw new Error("prior-month day must stay on the chart");
  }

  // Empty series must not divide by zero or project.
  const empty = computeSpendMetrics([], null, now);
  if (empty.mtd !== 0 || empty.runRatePerDay !== 0 || empty.chart.length !== 0) {
    throw new Error("empty series must be inert");
  }

  // eslint-disable-next-line no-console
  console.log("spend-metrics self-check ok");
}
