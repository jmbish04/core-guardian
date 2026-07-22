/**
 * @fileoverview Probe trend explorer — the panel's main chart surface.
 *
 * Two halves, driven by one selected probe:
 *
 *   - Left: hourly trend from `GET /api/guardian/history` (the `usage_snapshots`
 *     the cron writes), drawn as a gradient area with the probe's alert
 *     threshold as a reference line. A point above that line is a surge.
 *   - Right: the current reading's per-resource breakdown as a donut. This is
 *     deliberately scoped to ONE probe — a donut mixing "rows read" against
 *     "requests" against "bytes stored" would be a chart of nothing.
 *
 * The metric strip along the top follows the ReUI `chart-6` shape: each probe
 * is a button showing its headline value and threshold ratio, and clicking one
 * swaps both panels.
 */

"use client";

import { useMemo } from "react";
import { Area, AreaChart, CartesianGrid, Cell, Pie, PieChart, ReferenceLine, XAxis } from "recharts";

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { compactNumber, formatRatio, humanSize } from "@/lib/format";

export type TrendSeries = { service: string; metric: string; points: { t: number; value: number }[] };

export type TrendProbe = {
  id: string;
  label: string;
  unit: string;
  value: number;
  alertThreshold: number | null;
  surging: boolean;
  breakdown: { label: string; value: number }[];
};

/** Donut slice palette — same OKLCH family the rest of the dashboard uses. */
const SLICE_COLORS = [
  "oklch(0.6 0.145 181.2)",
  "oklch(0.76 0.161 80.1)",
  "oklch(0.66 0.19 42.8)",
  "oklch(0.62 0.19 300)",
  "oklch(0.58 0.16 250)",
];

const CHART_CONFIG = {
  value: { label: "Usage", color: "oklch(0.6 0.145 181.2)" },
} satisfies ChartConfig;

function fmt(value: number, unit: string): string {
  return unit.includes("bytes") ? humanSize(value) : compactNumber(value);
}

/** Unix ms → "14:00" hour tick. */
function hourTick(t: number): string {
  return new Date(t).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

export function UsageTrend({
  probes,
  series,
  selectedId,
  onSelect,
}: {
  probes: TrendProbe[];
  series: TrendSeries[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const selected = probes.find((p) => p.id === selectedId) ?? probes[0];
  const points = useMemo(
    () => series.find((s) => s.service === selected?.id)?.points ?? [],
    [series, selected],
  );

  // Top five resources, with the tail folded into "other" so the donut stays
  // readable when a probe reports 300+ databases.
  const slices = useMemo(() => {
    if (!selected) return [];
    const sorted = [...selected.breakdown].sort((a, b) => b.value - a.value);
    const top = sorted.slice(0, 5);
    const rest = sorted.slice(5).reduce((sum, r) => sum + r.value, 0);
    return rest > 0 ? [...top, { label: `other (${sorted.length - 5})`, value: rest }] : top;
  }, [selected]);

  const sliceTotal = slices.reduce((sum, s) => sum + s.value, 0);

  if (!selected) return null;

  return (
    <div className="overflow-hidden rounded-xl border border-border/60 bg-background/40">
      {/* --- Metric strip ---------------------------------------------------- */}
      <div className="grid grid-cols-2 border-b border-border/60 md:grid-cols-4 xl:grid-cols-7">
        {probes.map((probe) => {
          const active = probe.id === selected.id;
          const ratio =
            probe.alertThreshold && probe.alertThreshold > 0
              ? probe.value / probe.alertThreshold
              : null;
          return (
            <button
              key={probe.id}
              type="button"
              aria-pressed={active}
              onClick={() => onSelect(probe.id)}
              className={`flex flex-col items-stretch gap-1 border-b border-r border-border/60 p-3 text-left transition-colors last:border-r-0 ${
                active ? "bg-foreground/[0.06]" : "hover:bg-foreground/[0.03]"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-xs font-medium text-muted-foreground">
                  {probe.label}
                </span>
                {ratio != null && (
                  <span
                    className={`shrink-0 font-mono text-[10px] tabular-nums ${
                      probe.surging
                        ? "text-rose-600 dark:text-rose-400"
                        : ratio >= 0.7
                          ? "text-amber-600 dark:text-amber-400"
                          : "text-muted-foreground/60"
                    }`}
                  >
                    {probe.alertThreshold
                      ? formatRatio(probe.value, probe.alertThreshold)
                      : `${Math.round(ratio * 100)}%`}
                  </span>
                )}
              </div>
              <span className="text-base font-semibold tabular-nums">
                {fmt(probe.value, probe.unit)}
              </span>
            </button>
          );
        })}
      </div>

      {/* --- Trend + composition --------------------------------------------- */}
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="border-b border-border/60 p-5 xl:border-b-0 xl:border-r">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-medium">{selected.label} — hourly trend</h3>
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              {selected.unit}
            </span>
          </div>

          {points.length < 2 ? (
            <p className="py-16 text-center text-sm text-muted-foreground">
              Not enough history yet. The cron writes one point per hour — this fills in as it runs.
            </p>
          ) : (
            <ChartContainer config={CHART_CONFIG} className="mt-4 h-[260px] w-full">
              <AreaChart data={points} margin={{ left: 4, right: 4, top: 8, bottom: 0 }}>
                <defs>
                  <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--color-value)" stopOpacity={0.25} />
                    <stop offset="100%" stopColor="var(--color-value)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
                <XAxis
                  dataKey="t"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  minTickGap={32}
                  tickFormatter={hourTick}
                  tick={{ fill: "hsl(var(--foreground))", fontSize: 11 }}
                />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      labelFormatter={(_, payload) =>
                        payload?.[0] ? new Date(payload[0].payload.t).toLocaleString() : ""
                      }
                      formatter={(value) => fmt(Number(value), selected.unit)}
                    />
                  }
                />
                {selected.alertThreshold != null && selected.alertThreshold > 0 && (
                  <ReferenceLine
                    y={selected.alertThreshold}
                    stroke="oklch(0.65 0.2 25)"
                    strokeDasharray="4 4"
                    label={{
                      value: "threshold",
                      position: "insideTopRight",
                      fill: "oklch(0.65 0.2 25)",
                      fontSize: 10,
                    }}
                  />
                )}
                <Area
                  type="monotone"
                  dataKey="value"
                  stroke="var(--color-value)"
                  strokeWidth={2}
                  fill="url(#trendFill)"
                />
              </AreaChart>
            </ChartContainer>
          )}
        </div>

        <div className="p-5">
          <h3 className="text-sm font-medium">Where it is going</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Top resources by {selected.unit}, current window.
          </p>

          {slices.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              No per-resource breakdown for this probe.
            </p>
          ) : (
            <>
              <div className="relative mx-auto mt-4 size-[150px]">
                <ChartContainer config={CHART_CONFIG} className="aspect-square size-[150px]">
                  <PieChart>
                    <Pie
                      data={slices}
                      dataKey="value"
                      nameKey="label"
                      innerRadius={48}
                      outerRadius={72}
                      paddingAngle={2}
                      strokeWidth={2}
                      stroke="var(--background)"
                    >
                      {slices.map((slice, i) => (
                        <Cell key={slice.label} fill={SLICE_COLORS[i % SLICE_COLORS.length]} />
                      ))}
                    </Pie>
                    <ChartTooltip
                      content={
                        <ChartTooltipContent formatter={(v) => fmt(Number(v), selected.unit)} />
                      }
                    />
                  </PieChart>
                </ChartContainer>
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-[10px] text-muted-foreground/70">total</span>
                  <span className="text-sm font-semibold tabular-nums">
                    {fmt(sliceTotal, selected.unit)}
                  </span>
                </div>
              </div>

              <ul className="mt-4 flex flex-col">
                {slices.map((slice, i) => (
                  <li
                    key={slice.label}
                    className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-border/40 py-2 last:border-b-0"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        aria-hidden="true"
                        className="size-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: SLICE_COLORS[i % SLICE_COLORS.length] }}
                      />
                      <span className="truncate font-mono text-xs">{slice.label}</span>
                    </div>
                    <span className="text-xs font-medium tabular-nums">
                      {fmt(slice.value, selected.unit)}
                    </span>
                    <span className="w-9 text-right text-[10px] tabular-nums text-muted-foreground/70">
                      {sliceTotal > 0 ? Math.round((slice.value / sliceTotal) * 100) : 0}%
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
