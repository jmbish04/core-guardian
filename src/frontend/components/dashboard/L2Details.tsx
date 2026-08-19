/**
 * @fileoverview Level-2 detail islands — the thin data-wiring layer that mounts
 * on the six product drill-down pages.
 *
 * Each island fetches ONE real Guardian/AI endpoint and renders a G2 primitive
 * (`HeroMetricChart` or `TimeSeriesChart`) — no chart chrome is re-authored
 * here, only the fetch + shape + drill wiring. These are the Astro-mountable
 * entry points (Astro can only pass serializable props, so the closures that
 * `HeroMetricChart`/`TimeSeriesChart` need — `load`, `onPointClick` — are
 * created inside these React islands, not in the `.astro` shell).
 *
 * Drill-to-L3: every detail chart routes a clicked point to
 * `/dashboard/<product>/logs?query=…` (those pages 404 until G6 lands — that is
 * expected). Navigation is a plain `window.location` assignment because the app
 * is Astro MPA, not a client router.
 *
 * G1 guards throughout: `Number.isFinite` coercion before any sum/format
 * (`fin`), empty series → `<EmptyState>` (handled inside the primitives), and no
 * `$NaN` can reach a headline.
 */

"use client";

import { Database, DollarSign, Zap } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { ReferenceDot, ReferenceLine } from "recharts";

import { ApiError, apiGet } from "@/lib/api";
import { compactNumber, usd } from "@/lib/format";

import { HeroMetricChart, type HeroPoint } from "./HeroMetricChart";
import { InsightsPanel } from "./InsightsPanel";
import { RecentActivity } from "./RecentActivity";
import { EmptyState, InlineError, SectionTitle } from "./shared";
import { seriesStory } from "./story";
import { TimeSeriesChart } from "./TimeSeriesChart";
import type { DashboardFilters } from "./types";
import { useActivity, useInsights } from "./useDashboardData";

// --- shared helpers ---------------------------------------------------------

/** G1: coerce anything non-finite to 0. */
const fin = (n: number | null | undefined): number => (Number.isFinite(n) ? (n as number) : 0);

/** `YYYY-MM-DD` → "Aug 12" (UTC, matches the rest of the dashboard). */
const dayTick = (day: string): string =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

/** Epoch-ms → `YYYY-MM-DD` (UTC day bucket). */
const dayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** MPA navigation to a Level-3 logs view (404s until G6 ships those routes). */
const drillTo = (product: string, query: string) => {
  window.location.href = `/dashboard/${product}/logs?query=${encodeURIComponent(query)}`;
};

/**
 * Story layer (G7) for a HeroMetricChart series: a muted baseline ReferenceLine
 * (the window mean) and a destructive ReferenceDot on the single outlier day.
 * Returns the `seriesStory` numbers (for the caller's caption) plus the ready
 * annotation node. G1: empty/degenerate series → inert `null`s, so nothing draws
 * and no caption can read "NaN".
 *
 * @param points  The full ascending series the chart plots.
 * @param fmt     The chart's value formatter (USD / compact) for the axis label.
 */
function heroStory(points: HeroPoint[], fmt: (n: number) => string) {
  const story = seriesStory(points.map((p) => fin(p.value)));
  const anomaly = story.anomalyIndex != null ? points[story.anomalyIndex] : undefined;
  const annotations: ReactNode = (
    <>
      {story.baseline != null && story.baseline > 0 ? (
        <ReferenceLine
          y={story.baseline}
          stroke="var(--color-muted-foreground)"
          strokeDasharray="4 4"
          strokeWidth={1.25}
          label={{
            value: `avg ${fmt(story.baseline)}`,
            position: "insideTopLeft",
            fill: "var(--color-muted-foreground)",
            fontSize: 10,
          }}
        />
      ) : null}
      {anomaly ? (
        <ReferenceDot
          x={anomaly.label}
          y={fin(anomaly.value)}
          r={4}
          fill="var(--color-destructive)"
          stroke="var(--color-background)"
          strokeWidth={1.5}
        />
      ) : null}
    </>
  );
  return { story, anomaly, annotations };
}

/** Signed "up/down N%" phrase from a pace fraction, or null when not meaningful. */
function pacePhrase(fraction: number | null): string | null {
  if (fraction == null || !Number.isFinite(fraction) || Math.abs(fraction) < 0.05) return null;
  return `${fraction > 0 ? "up" : "down"} ${Math.abs(Math.round(fraction * 100))}%`;
}

/** Generic single-endpoint fetch hook with G1-safe `{data,loading,error,reload}`. */
function useFetch<T>(path: string, params?: Record<string, string | number>) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await apiGet<T>(path, params));
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "Sign in to view this detail."
          : err instanceof ApiError
            ? err.message
            : "Failed to load.",
      );
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, JSON.stringify(params)]);
  useEffect(() => {
    void load();
  }, [load]);
  return { data, loading, error, reload: load };
}

// --- API shapes (subset consumed; validated by the guards) ------------------

type BillablePoint = { day: string; quantity: number; costUsd: number };
type BillableService = { service: string; family: string; unit: string; points: BillablePoint[]; totalUsd: number };
type BillableReport = {
  services: BillableService[];
  totalByDay: { day: string; costUsd: number }[];
  totalActualUsd: number;
};

const DEFAULT_FILTERS: DashboardFilters = { q: "", range: "30d", status: "all" };

// ---------------------------------------------------------------------------
// 1. Cost-basis — total billable spend trend hero.
// ---------------------------------------------------------------------------

export function SpendHero() {
  const { data, loading, error, reload } = useFetch<BillableReport>("/guardian/billable-usage", {
    days: 90,
  });
  const points: HeroPoint[] = useMemo(
    () => (data?.totalByDay ?? []).map((d) => ({ label: d.day, value: fin(d.costUsd) })),
    [data],
  );
  const fmt = (n: number) => usd(n, false);
  return (
    <HeroMetricChart
      title="Billable spend"
      icon={DollarSign}
      points={points}
      chartKey="chart-1"
      aggregate="sum"
      valueFormatter={fmt}
      seriesLabel="Billed"
      caption={
        points.length
          ? (w) => {
              const pace = pacePhrase(heroStory(w, fmt).story.paceFraction);
              return pace ? `Spend pace ${pace} vs earlier this window` : "Spend holding steady";
            }
          : "reconciled from Cloudflare's Billable Usage API"
      }
      annotate={(w) => heroStory(w, fmt).annotations}
      xTickFormatter={dayTick}
      loading={loading}
      error={error}
      onRetry={reload}
      onPointClick={(p) => drillTo("cost-basis", `day:${p.label}`)}
      logsHref="/dashboard/cost-basis/logs"
    />
  );
}

// ---------------------------------------------------------------------------
// 2. D1 — rows/queries volume + metered cost over time.
// ---------------------------------------------------------------------------

export function D1UsageDetail() {
  const { data, loading, error, reload } = useFetch<BillableReport>("/guardian/billable-usage", {
    days: 90,
  });

  const d1 = useMemo(
    () => (data?.services ?? []).find((s) => /d1/i.test(s.service) || /d1/i.test(s.family)),
    [data],
  );

  const costPoints: HeroPoint[] = useMemo(
    () => (d1?.points ?? []).map((p) => ({ label: p.day, value: fin(p.costUsd) })),
    [d1],
  );
  const volumeRows = useMemo(
    () => (d1?.points ?? []).map((p) => ({ day: p.day, rows: fin(p.quantity) })),
    [d1],
  );

  const d1Total = useMemo(() => costPoints.reduce((s, p) => s + fin(p.value), 0), [costPoints]);
  const d1Fmt = (n: number) => usd(n, false);
  const d1Caption =
    d1Total <= 0
      ? "D1 within free allowance — no metered spend this window"
      : (w: HeroPoint[]) => {
          const pace = pacePhrase(heroStory(w, d1Fmt).story.paceFraction);
          return `D1 metered ${usd(d1Total, false)} over 90d${pace ? ` · pace ${pace}` : ""}`;
        };

  if (error) return <InlineError message={error} onRetry={reload} />;
  if (!loading && !d1) {
    return (
      <EmptyState label="No metered D1 spend this window — usage is within the free allowance." />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <HeroMetricChart
        title="D1 metered cost"
        icon={Database}
        points={costPoints}
        chartKey="chart-3"
        aggregate="sum"
        valueFormatter={(n) => usd(n, false)}
        seriesLabel="D1 cost"
        caption={d1 ? d1Caption : undefined}
        annotate={(w) => heroStory(w, d1Fmt).annotations}
        xTickFormatter={dayTick}
        loading={loading}
        error={error}
        onRetry={reload}
        onPointClick={(p) => drillTo("storage/d1", `day:${p.label}`)}
        logsHref="/dashboard/storage/d1/logs"
      />

      <div className="flex flex-col gap-3 rounded-xl bg-card p-4 ring-1 ring-border/40">
        <SectionTitle>D1 rows processed · 90d</SectionTitle>
        {volumeRows.length === 0 ? (
          <EmptyState label="No D1 row-volume readings yet." />
        ) : (
          <TimeSeriesChart
            data={volumeRows}
            xKey="day"
            variant="bar"
            className="aspect-[24/7] w-full"
            xTickFormatter={dayTick}
            valueFormatter={(v) => compactNumber(fin(v))}
            series={[{ key: "rows", label: "Rows read + written", chartKey: "chart-3" }]}
            onPointClick={(row) => drillTo("storage/d1", `day:${(row as { day: string }).day}`)}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3. AI Gateway — metered usage over time.
// ---------------------------------------------------------------------------

type UsageHistory = { history: { id: string; value: number; startTime: number; endTime: number }[] };
type RequestSeriesPoint = {
  day: string;
  requests: number;
  tokensIn: number;
  tokensOut: number;
  latencyMsAvg?: number;
};

export function GatewayUsageDetail() {
  const { data, loading, error, reload } = useFetch<UsageHistory>(
    "/ai-gateway/billing/usage-history",
    { days: 90, window: "day" },
  );
  const series = useFetch<RequestSeriesPoint[]>("/ai-gateway/usage-series", {
    days: 90,
    window: "day",
  });

  // Bucket by UTC day (defensive: collapse any duplicate buckets), ascending.
  const points: HeroPoint[] = useMemo(() => {
    const byDay = new Map<string, number>();
    for (const h of data?.history ?? []) {
      const k = dayKey(fin(h.startTime));
      byDay.set(k, (byDay.get(k) ?? 0) + fin(h.value));
    }
    return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([label, value]) => ({ label, value }));
  }, [data]);

  const seriesRows = useMemo(
    () =>
      (series.data ?? []).map((p) => ({
        day: p.day,
        requests: fin(p.requests),
        tokensIn: fin(p.tokensIn),
        tokensOut: fin(p.tokensOut),
      })),
    [series.data],
  );
  const avgLatencyMs = useMemo(() => {
    const withLatency = (series.data ?? []).filter((p) => Number.isFinite(p.latencyMsAvg));
    if (!withLatency.length) return null;
    return Math.round(withLatency.reduce((s, p) => s + fin(p.latencyMsAvg), 0) / withLatency.length);
  }, [series.data]);

  const gwFmt = (n: number) => compactNumber(n);
  return (
    <div className="flex flex-col gap-6">
      <HeroMetricChart
        title="AI Gateway metered usage"
        icon={Zap}
        points={points}
        chartKey="chart-4"
        aggregate="sum"
        valueFormatter={gwFmt}
        seriesLabel="Metered units"
        caption={
          points.length
            ? (w) => {
                const pace = pacePhrase(heroStory(w, gwFmt).story.paceFraction);
                return pace ? `Gateway usage ${pace} vs earlier this window` : "Gateway usage holding steady";
              }
            : "requests metered through AI Gateway"
        }
        annotate={(w) => heroStory(w, gwFmt).annotations}
        xTickFormatter={dayTick}
        loading={loading}
        error={error}
        onRetry={reload}
        onPointClick={(p) => drillTo("ai-gateway", `day:${p.label}`)}
        logsHref="/dashboard/ai-gateway/logs"
      />

      <div className="flex flex-col gap-3 rounded-xl bg-card p-4 ring-1 ring-border/40">
        <div className="flex items-center justify-between gap-3">
          <SectionTitle>Requests + tokens · 90d</SectionTitle>
          {avgLatencyMs != null ? (
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              avg latency {compactNumber(avgLatencyMs)}ms
            </span>
          ) : null}
        </div>
        {series.error ? (
          <InlineError message={series.error} onRetry={series.reload} />
        ) : !series.loading && seriesRows.length === 0 ? (
          <EmptyState label="No AI Gateway request telemetry yet." />
        ) : (
          <TimeSeriesChart
            data={seriesRows}
            xKey="day"
            variant="line"
            className="aspect-[24/7] w-full"
            xTickFormatter={dayTick}
            valueFormatter={(v) => compactNumber(fin(v))}
            series={[
              { key: "requests", label: "Requests", chartKey: "chart-4" },
              { key: "tokensIn", label: "Tokens in", chartKey: "chart-1" },
              { key: "tokensOut", label: "Tokens out", chartKey: "chart-2" },
            ]}
            onPointClick={(row) => drillTo("ai-gateway", `day:${(row as { day: string }).day}`)}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 4. Alerts — new-alert volume by severity over time (grouped-severity trend).
// ---------------------------------------------------------------------------

type AlertRow = { severity: "info" | "warning" | "critical"; createdAt: number };
type AlertsPayload = { alerts: AlertRow[] };

export function AlertsSeverityTrend() {
  const { data, loading, error, reload } = useFetch<AlertsPayload>("/guardian/alerts", {
    status: "all",
  });

  const series = useMemo(() => {
    const byDay = new Map<string, { critical: number; warning: number; info: number }>();
    for (const a of data?.alerts ?? []) {
      const k = dayKey(fin(a.createdAt));
      const row = byDay.get(k) ?? { critical: 0, warning: 0, info: 0 };
      if (a.severity in row) row[a.severity] += 1;
      byDay.set(k, row);
    }
    return [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, counts]) => ({ day, ...counts }));
  }, [data]);

  if (error) return <InlineError message={error} onRetry={reload} />;

  return (
    <div className="flex flex-col gap-3 rounded-xl bg-card p-4 ring-1 ring-border/40">
      <div className="flex items-center justify-between gap-2">
        <SectionTitle>New alerts by severity · trend</SectionTitle>
        <a
          href="/dashboard/alerts/logs"
          className="inline-flex items-center gap-1 rounded text-[11px] text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          View alert logs
          <span aria-hidden>→</span>
        </a>
      </div>
      {loading && series.length === 0 ? (
        <div className="aspect-[24/7] w-full animate-pulse rounded-md bg-muted/20" />
      ) : series.length === 0 ? (
        <EmptyState label="No alerts recorded yet." />
      ) : (
        <TimeSeriesChart
          data={series}
          xKey="day"
          variant="bar"
          stacked
          className="aspect-[24/7] w-full"
          xTickFormatter={dayTick}
          valueFormatter={(v) => compactNumber(fin(v))}
          series={[
            { key: "critical", label: "Critical", chartKey: "chart-1" },
            { key: "warning", label: "Warning", chartKey: "chart-4" },
            { key: "info", label: "Info", chartKey: "chart-2" },
          ]}
          onPointClick={(row) => drillTo("alerts", `day:${(row as { day: string }).day}`)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 5. Alerts — rehomed headline AI insight + recent governance activity feed.
//    (Evicted from L1: InsightsPanel + RecentActivity, wired to their real
//    endpoints via the existing dashboard hooks.)
// ---------------------------------------------------------------------------

export function AlertsInsights() {
  const insights = useInsights(DEFAULT_FILTERS);
  const activity = useActivity(DEFAULT_FILTERS, 8);
  return (
    <section className="grid grid-cols-1 gap-6 xl:grid-cols-3">
      <div className="xl:col-span-2">
        <InsightsPanel resource={insights} />
      </div>
      <div className="xl:col-span-1">
        <RecentActivity resource={activity} />
      </div>
    </section>
  );
}
