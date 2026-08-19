/**
 * @fileoverview GuardianOverview — the Level-1 "1000-ft" overview island.
 *
 * The progressive-disclosure entry tier: 5 top-line Cloudflare-product KPIs +
 * one high-level spend chart, each a clear entry point into its Level-2 detail
 * page. Deliberately fits ONE desktop screen with ZERO vertical scroll — no log
 * tables, DataGrids, or long lists live here (those are rehomed on L2/L3).
 *
 * Data (all real, no mocks): a single `Promise.all` over four Guardian/AI-Router
 * endpoints. Only the spend hero (`/guardian/daily-cost`) is load-bearing — the
 * other three degrade to `null` so one 401/500 can't blank the whole overview.
 *
 * G1 data guards applied throughout (the API layer is a runtime-unchecked cast):
 *   H1 empty series → <EmptyState>, never a blank chart;
 *   H2 `Number.isFinite` coerce costUsd before summing (no `$NaN` tiles);
 *   H3 finite-clamp every value fed to a formatter / KPI.
 *
 * Monolith: dark, `bg-card` + `ring-1 ring-border/40`, charts recolor on the
 * ThemeToggle via `var(--color-chart-N)`.
 */

"use client";

import { ArrowRight, BellRing, Cpu, Database, DollarSign, Loader2Icon, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ReferenceLine } from "recharts";

import { Card } from "@/components/ui/card";
import { ApiError, apiGet } from "@/lib/api";
import { compactNumber, usd } from "@/lib/format";
import { cn } from "@/lib/utils";

import { KPIStatCard, KPIStatCardSkeleton, type KPIStatCardProps } from "./KPIStatCard";
import { EmptyState, InlineError } from "./shared";
import { computeSpendMetrics, type DayPoint } from "./spend-metrics";
import { seriesStory } from "./story";
import { TimeSeriesChart } from "./TimeSeriesChart";

// --- API shapes (subset we consume; validated by the guards below) ----------

type DailyCost = { totalByDay: DayPoint[]; totalDeltaUsd: number | null };
type BillableService = { service: string; totalUsd: number };
type BillableUsage = { services: BillableService[] };
type ProjectUsage = { requests: number; costUsd: number };
type AlertsPayload = { counts: { critical: number; warning: number; info: number } };

/** H2/H3 helper — coerce anything non-finite (NaN/Infinity/undefined) to 0. */
const fin = (n: number | null | undefined): number => (Number.isFinite(n) ? (n as number) : 0);

/** Day-over-day fraction from an absolute delta, guarded against /0 and NaN. */
function deltaFraction(latest: number, deltaUsd: number | null): number | null {
  if (deltaUsd == null || !Number.isFinite(deltaUsd)) return null;
  const prev = latest - deltaUsd;
  if (!Number.isFinite(prev) || prev === 0) return null;
  return deltaUsd / prev;
}

// --- CTA-linked KPI: whole card is an entry point into its L2 page -----------

function KpiLink({
  href,
  cta,
  ...kpi
}: { href: string; cta: string } & KPIStatCardProps) {
  return (
    <a
      href={href}
      className="group block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <KPIStatCard
        {...kpi}
        className={cn(
          "h-full ring-1 ring-border/40 transition-all group-hover:ring-primary/40",
          kpi.className,
        )}
      />
      <span className="mt-1.5 flex items-center gap-1 px-1 text-xs font-medium text-muted-foreground transition-colors group-hover:text-primary">
        {cta}
        <ArrowRight className="size-3 transition-transform group-hover:translate-x-0.5" aria-hidden />
      </span>
    </a>
  );
}

const XFMT = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

export function GuardianOverview() {
  const [daily, setDaily] = useState<DailyCost | null>(null);
  const [billable, setBillable] = useState<BillableUsage | null>(null);
  const [router, setRouter] = useState<ProjectUsage[] | null>(null);
  const [alerts, setAlerts] = useState<AlertsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const end = Math.floor(Date.now() / 60_000) * 60_000;
      const start = end - 30 * 86_400_000;
      // Only the spend hero rejects the load; supporting KPIs degrade to null.
      const [d, b, r, a] = await Promise.all([
        apiGet<DailyCost>("/guardian/daily-cost", { days: 31 }),
        apiGet<BillableUsage>("/guardian/billable-usage", { days: 31 }).catch(() => null),
        apiGet<{ projects: ProjectUsage[] }>("/ai-router/usage", { start, end }).catch(() => null),
        apiGet<AlertsPayload>("/guardian/alerts?status=all").catch(() => null),
      ]);
      setDaily(d);
      setBillable(b);
      setRouter(r?.projects ?? null);
      setAlerts(a);
    } catch (err) {
      console.error("GuardianOverview load failed:", err);
      setError(
        err instanceof ApiError && err.status === 401
          ? "Sign in to view the overview."
          : err instanceof ApiError
            ? err.message
            : "Failed to load overview.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // H2: coerce every costUsd finite BEFORE the metrics math sums them.
  const metrics = useMemo(() => {
    if (!daily) return null;
    const clean = daily.totalByDay.map((p) => ({ day: p.day, costUsd: fin(p.costUsd) }));
    return computeSpendMetrics(clean, fin(daily.totalDeltaUsd), Date.now());
  }, [daily]);

  const kpis = useMemo(() => {
    if (!metrics) return null;

    // Spend hero — MTD value, projection subtext, day-over-day delta, sparkline.
    const spendTrend = metrics.chart
      .filter((c) => c.cost != null)
      .slice(-14)
      .map((c) => fin(c.cost));

    // D1 billed MTD — match the billable-usage product row by name (case-insensitive).
    const d1 = (billable?.services ?? []).find((s) => /d1/i.test(s.service));
    const d1Usd = fin(d1?.totalUsd);

    // AI Gateway / Router rollup — one fetch, two KPIs (requests + spend).
    const aiRequests = (router ?? []).reduce((s, p) => s + fin(p.requests), 0);
    const aiSpend = (router ?? []).reduce((s, p) => s + fin(p.costUsd), 0);

    // Anomalies — active alert count, severity-weighted for the delta accent.
    const c = alerts?.counts;
    const alertCount = fin(c?.critical) + fin(c?.warning) + fin(c?.info);

    return { spendTrend, d1, d1Usd, aiRequests, aiSpend, c, alertCount };
  }, [metrics, billable, router, alerts]);

  // Spend story (G7): a baseline avg-per-day threshold + an "is the pace
  // climbing?" verdict, both from the real actual-cost days only (projected
  // days excluded). G1: seriesStory returns nulls on an empty/degenerate series,
  // so `over` is false and no threshold renders rather than a NaN line.
  const spendStory = useMemo(() => {
    if (!metrics) return { baseline: null as number | null, over: false, pacePct: 0 };
    const actuals = metrics.chart.filter((c) => !c.future && c.cost != null).map((c) => fin(c.cost));
    const s = seriesStory(actuals);
    const over = s.paceFraction != null && s.paceFraction > 0.1;
    return { baseline: s.baseline, over, pacePct: Math.round((s.paceFraction ?? 0) * 100) };
  }, [metrics]);

  if (loading && !metrics) {
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <KPIStatCardSkeleton key={i} />
        ))}
        <div className="col-span-2 flex h-56 items-center justify-center rounded-xl bg-card ring-1 ring-border/40 lg:col-span-5">
          <Loader2Icon className="size-5 animate-spin text-muted-foreground" aria-hidden />
        </div>
      </div>
    );
  }

  if (error && !metrics) return <InlineError message={error} onRetry={load} />;
  if (!metrics || !kpis) return null;

  return (
    <div className="flex flex-col gap-4">
      {/* 5 top-line KPIs — one row on desktop, each an entry point to its L2 page. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <KpiLink
          href="/dashboard/cost-basis"
          cta="View cost basis"
          label={`Spend · ${metrics.monthLabel} MTD`}
          value={usd(metrics.mtd, false)}
          subtext={`projected ${usd(metrics.projectedMonthEnd, false)} month-end${
            spendStory.over ? " · above avg pace" : ""
          }`}
          icon={DollarSign}
          chartKey="chart-1"
          delta={deltaFraction(metrics.today, metrics.deltaUsd)}
          invertDelta
          alert={spendStory.over}
          trend={kpis.spendTrend}
        />
        <KpiLink
          href="/dashboard/storage/d1"
          cta="View D1 metrics"
          label="D1 billed · MTD"
          value={usd(kpis.d1Usd, false)}
          subtext={kpis.d1 ? "metered database spend" : "within free allowance"}
          icon={Database}
          chartKey="chart-3"
        />
        <KpiLink
          href="/dashboard/ai-gateway"
          cta="View AI Gateway"
          label="AI requests · 30d"
          value={compactNumber(kpis.aiRequests)}
          subtext="routed through AI Gateway"
          icon={Zap}
          chartKey="chart-4"
        />
        <KpiLink
          href="/dashboard/ai-router"
          cta="View AI Router"
          label="AI model spend · 30d"
          value={usd(kpis.aiSpend)}
          subtext="across all routed models"
          icon={Cpu}
          chartKey="chart-2"
        />
        <KpiLink
          href="/dashboard/alerts"
          cta="View alerts"
          label="Active anomalies"
          value={compactNumber(kpis.alertCount)}
          subtext={
            kpis.c
              ? `${fin(kpis.c.critical)} critical · ${fin(kpis.c.warning)} warning`
              : "no data"
          }
          icon={BellRing}
          chartKey="chart-5"
        />
      </div>

      {/* One high-level chart — spend trend (actual + projected), an entry point. */}
      <Card className="p-4 ring-1 ring-border/40">
        <a
          href="/dashboard/daily-cost"
          className="group flex flex-col gap-3 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="text-sm font-medium">Billable spend · actual vs projected</h2>
            <span className="flex items-center gap-1 font-mono text-[11px] uppercase tracking-[0.15em] text-muted-foreground transition-colors group-hover:text-primary">
              Daily cost
              <ArrowRight className="size-3 transition-transform group-hover:translate-x-0.5" aria-hidden />
            </span>
          </div>
          {/* Takeaway caption — only when the pace is climbing, else the chart
              stays clean (over-annotation is worse than none). */}
          {spendStory.over ? (
            <p className="text-xs text-destructive">
              Spend pace {spendStory.pacePct}% above earlier this month — projected{" "}
              {usd(metrics.projectedMonthEnd, false)} month-end.
            </p>
          ) : null}
          {/* H1: empty series → EmptyState, never a blank chart. */}
          {metrics.chart.length === 0 ? (
            <EmptyState label="No priced spend yet — the daily-cost cron has no data for this month." />
          ) : (
            <TimeSeriesChart
              data={metrics.chart}
              xKey="day"
              variant="line"
              className="aspect-[24/5] w-full"
              xTickFormatter={XFMT}
              valueFormatter={(v) => usd(fin(v), false)}
              series={[
                { key: "cost", label: "Actual", chartKey: "chart-1" },
                { key: "projected", label: "Projected", chartKey: "chart-2" },
              ]}
              // ONE threshold line: the month's avg spend/day. Muted normally;
              // destructive when the pace is climbing so the overrun reads as an
              // alert, not a neutral line. Rendered only for a finite baseline.
              annotations={
                spendStory.baseline != null && spendStory.baseline > 0 ? (
                  <ReferenceLine
                    y={spendStory.baseline}
                    stroke={
                      spendStory.over
                        ? "var(--color-destructive)"
                        : "var(--color-muted-foreground)"
                    }
                    strokeDasharray="4 4"
                    strokeWidth={1.5}
                    label={{
                      value: spendStory.over
                        ? `avg ${usd(spendStory.baseline, false)}/day · pace climbing`
                        : `avg ${usd(spendStory.baseline, false)}/day`,
                      position: "insideTopLeft",
                      fill: spendStory.over
                        ? "var(--color-destructive)"
                        : "var(--color-muted-foreground)",
                      fontSize: 10,
                    }}
                  />
                ) : null
              }
            />
          )}
        </a>
      </Card>
    </div>
  );
}
