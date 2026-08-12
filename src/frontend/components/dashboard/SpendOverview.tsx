/**
 * @fileoverview SpendOverview — the corrected headline for the Guardian spend
 * surface. Leads with **true MTD metered spend** (sum of priced daily cost),
 * not overage-above-allowance (the mislabel this replaces).
 *
 * Layout, top → bottom:
 *   1. Loud surge banner — any allowance projected over 100% (alarm-red).
 *   2. Stat tiles — MTD billables (hero), projected month-end (run-rate, red
 *      when surging), today so far, day-over-day delta.
 *   3. Spend-over-time line + per-day bar charts (see ./SpendCharts).
 *   4. Alerts panel — one date-stamped card per surging/overage service.
 *
 * Data: `GET /api/guardian/daily-cost?days=31` (headline + charts),
 * `GET /api/guardian/allowances` (surge + projected overage),
 * `GET /api/guardian/billable-usage?days=31` (actual billed context). All three
 * refetch on every mount, so alerts reflect the latest cron each load.
 *
 * Monolith: dark, `bg-card` + `ring-1 ring-border/40` (never a 1px border),
 * charts wrapped in `<ChartContainer>` with forced-foreground axis text.
 */

"use client";

import { AlertTriangleIcon, Loader2Icon, TrendingDownIcon, TrendingUpIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, apiGet } from "@/lib/api";

import { SpendBarChart, SpendTrendChart } from "./SpendCharts";
import { InlineError } from "./shared";
import { computeSpendMetrics, type DayPoint } from "./spend-metrics";

// --- API response shapes (subset of what we consume) ------------------------

type DailyCost = { totalByDay: DayPoint[]; totalDeltaUsd: number | null };

type Allowance = {
  service: string;
  unit: string;
  projectedFraction: number | null;
  overageCostUsd: number | null;
};
type Allowances = { plan: "free" | "paid"; allowances: Allowance[] };

type BillableService = { service: string; totalUsd: number };
type BillableUsage = { services: BillableService[]; days: string[] };

// --- Formatting -------------------------------------------------------------

/** USD, cent-precise under $10, whole-dollar above. */
function usd(n: number): string {
  const abs = Math.abs(n);
  const digits = abs !== 0 && abs < 10 ? 2 : 0;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}
/** Full absolute date for a "raised-at" stamp, e.g. "Aug 12, 2026". */
function stampDate(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}
/** A projected fraction as a percent string, e.g. "21471%". */
function pct(fraction: number): string {
  return `${Math.round(fraction * 100).toLocaleString("en-US")}%`;
}

const TILE = "rounded-xl bg-card p-4 ring-1 ring-border/40";

function StatTile({
  label,
  value,
  sub,
  alarm,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  alarm?: boolean;
}) {
  return (
    <div className={alarm ? `${TILE} ring-destructive/50 bg-destructive/10` : TILE}>
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </div>
      <div
        className={`mt-1.5 text-2xl font-semibold tabular-nums ${alarm ? "text-destructive" : ""}`}
      >
        {value}
      </div>
      {sub != null && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

function DeltaValue({ delta }: { delta: number | null }) {
  if (delta == null) return <span className="text-muted-foreground/60">—</span>;
  if (Math.abs(delta) < 0.005) return <span>flat</span>;
  const up = delta > 0;
  return (
    <span
      className={`inline-flex items-center gap-1 ${
        up ? "text-rose-500 dark:text-rose-400" : "text-emerald-500 dark:text-emerald-400"
      }`}
    >
      {up ? <TrendingUpIcon className="size-5" /> : <TrendingDownIcon className="size-5" />}
      {up ? "+" : "−"}
      {usd(Math.abs(delta))}
    </span>
  );
}

export function SpendOverview() {
  const [daily, setDaily] = useState<DailyCost | null>(null);
  const [allow, setAllow] = useState<Allowances | null>(null);
  const [billed, setBilled] = useState<BillableUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // billable-usage is context-only; a failure there must not blank the
      // headline, so it degrades to null rather than throwing.
      const [d, a, b] = await Promise.all([
        apiGet<DailyCost>("/guardian/daily-cost", { days: 31 }),
        apiGet<Allowances>("/guardian/allowances"),
        apiGet<BillableUsage>("/guardian/billable-usage", { days: 31 }).catch(() => null),
      ]);
      setDaily(d);
      setAllow(a);
      setBilled(b);
    } catch (err) {
      // Surface inline AND to the console for the global error console.
      console.error("SpendOverview load failed:", err);
      setError(
        err instanceof ApiError && err.status === 401
          ? "Sign in to view spend."
          : err instanceof ApiError
            ? err.message
            : "Failed to load spend.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const metrics = useMemo(
    () =>
      daily ? computeSpendMetrics(daily.totalByDay, daily.totalDeltaUsd, Date.now()) : null,
    [daily],
  );

  // Surging = projected over its included allowance. Loudest signal on the page.
  const surges = useMemo(
    () => (allow?.allowances ?? []).filter((a) => (a.projectedFraction ?? 0) > 1),
    [allow],
  );
  // Alert-worthy = surging OR carrying a projected overage cost.
  const alerts = useMemo(
    () =>
      (allow?.allowances ?? []).filter(
        (a) => (a.projectedFraction ?? 0) > 1 || (a.overageCostUsd ?? 0) > 0,
      ),
    [allow],
  );
  const billedByService = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of billed?.services ?? []) map.set(s.service.toLowerCase(), s.totalUsd);
    return map;
  }, [billed]);

  const asOf = daily?.totalByDay.at(-1)?.day ?? billed?.days.at(-1) ?? null;

  if (loading && !metrics) {
    return (
      <section className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
        <div className="flex h-60 items-center justify-center rounded-xl bg-card ring-1 ring-border/40">
          <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
        </div>
      </section>
    );
  }

  if (error && !metrics) return <InlineError message={error} onRetry={load} />;
  if (!metrics) return null;

  const surging = surges.length > 0;

  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-2xl font-semibold tracking-tight">Spend overview</h2>
        <span className="font-mono text-xs text-muted-foreground">
          true metered spend · {metrics.monthLabel} MTD
          {asOf ? ` · as of ${stampDate(asOf)}` : ""}
        </span>
      </div>

      {/* 1 — Loud surge banner */}
      {surging && (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-xl bg-destructive/15 p-4 ring-1 ring-destructive/50"
        >
          <div className="flex items-center gap-2 font-semibold text-destructive">
            <AlertTriangleIcon className="size-5" aria-hidden />
            Projected spend surge
          </div>
          <div className="flex flex-wrap gap-2">
            {surges.map((a) => (
              <span
                key={a.service}
                className="inline-flex items-center gap-1.5 rounded-full bg-destructive px-3 py-1 text-xs font-semibold text-destructive-foreground"
              >
                <AlertTriangleIcon className="size-3.5" aria-hidden />
                {a.service} · {a.projectedFraction != null ? pct(a.projectedFraction) : "over"}{" "}
                projected
              </span>
            ))}
          </div>
        </div>
      )}

      {/* 2 — Stat tiles */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label={`Billables · ${metrics.monthLabel} MTD`}
          value={usd(metrics.mtd)}
          sub={`${metrics.elapsedDays} of ${metrics.daysInMonth} days · metered spend`}
        />
        <StatTile
          label="Projected month-end"
          value={usd(metrics.projectedMonthEnd)}
          sub={`run-rate ${usd(metrics.runRatePerDay)}/day`}
          alarm={surging}
        />
        <StatTile
          label="Today so far"
          value={usd(metrics.today)}
          sub="latest priced day"
        />
        <StatTile
          label="Day over day"
          value={<DeltaValue delta={metrics.deltaUsd} />}
          sub="vs prior day"
        />
      </div>

      {/* 3 — Charts */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div className={TILE}>
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <h3 className="text-sm font-medium">Billable spend over time</h3>
            <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
              solid = billed · dashed = projected
            </span>
          </div>
          <SpendTrendChart data={metrics.chart} />
        </div>
        <div className={TILE}>
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <h3 className="text-sm font-medium">Billables added per day</h3>
            <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
              ghost = projected · line = auto-break
            </span>
          </div>
          <SpendBarChart data={metrics.chart} />
        </div>
      </div>

      {/* 4 — Alerts panel */}
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-sm font-medium">Overage alerts</h3>
          <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
            {allow?.plan === "paid" ? "over allowance = billable overage" : "over allowance = cap"}
          </span>
        </div>
        {alerts.length === 0 ? (
          <div className="rounded-xl bg-card p-6 text-center text-sm text-muted-foreground ring-1 ring-border/40">
            No projected overage this month — every binding is inside its included allowance.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {alerts.map((a) => {
              const hot = (a.projectedFraction ?? 0) > 1;
              const billedMtd = billedByService.get(a.service.toLowerCase()) ?? null;
              return (
                <div
                  key={a.service}
                  className={`rounded-xl bg-card p-4 ring-1 ${
                    hot ? "ring-destructive/50" : "ring-border/40"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{a.service}</span>
                    {a.projectedFraction != null && (
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                          hot
                            ? "bg-destructive text-destructive-foreground"
                            : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {hot && <AlertTriangleIcon className="size-3" aria-hidden />}
                        {pct(a.projectedFraction)} projected
                      </span>
                    )}
                  </div>
                  <dl className="mt-3 flex flex-col gap-1.5 text-sm">
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">Projected overage (month-end)</dt>
                      <dd className="font-medium tabular-nums">
                        {a.overageCostUsd != null ? usd(a.overageCostUsd) : "rate unknown"}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">Projected usage vs {a.unit} allowance</dt>
                      <dd className="font-medium tabular-nums">
                        {a.projectedFraction != null ? pct(a.projectedFraction) : "—"}
                      </dd>
                    </div>
                    {billedMtd != null && (
                      <div className="flex justify-between gap-3">
                        <dt className="text-muted-foreground">Billed this month (actual)</dt>
                        <dd className="font-medium tabular-nums">{usd(billedMtd)}</dd>
                      </div>
                    )}
                  </dl>
                  {asOf && (
                    <div className="mt-3 font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
                      raised as of {stampDate(asOf)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
