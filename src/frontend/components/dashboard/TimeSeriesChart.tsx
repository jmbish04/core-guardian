/**
 * @fileoverview TimeSeriesChart — the generic Level-2 detail chart wrapper.
 *
 * One data-agnostic component covering the three time-series shapes the detail
 * tier needs — `area` (gradient), `bar`, `line` — over N series. The existing
 * dashboard chart panels (`TimeSeriesCharts`, `SpendCharts`, `CategoryCharts`)
 * are each hardwired to one dataset; this is the reusable primitive G4/G5 point
 * at arbitrary `/api/...` payloads without re-authoring chart chrome.
 *
 * Everything themes off G0's token layer so it recolors on the ThemeToggle:
 *   - each series colour → `var(--color-<chartKey>)` via the ChartConfig
 *     `--color-<key>` variable,
 *   - axis ticks forced to `var(--color-foreground)` (high contrast),
 *   - grid + tooltip cursor → `var(--color-border)`,
 *   - tooltip via the shared `<ChartTooltipContent>`.
 *
 * recharts ONLY. Wrap it in `<ChartCard>` for title + LOADING/ERROR/EMPTY chrome.
 */

"use client";

import { type ReactNode, useId, useMemo } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "recharts";

import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

import type { ChartKey } from "./Sparkline";

const AXIS_TICK = { fill: "var(--color-foreground)", fontSize: 12 } as const;

/** One plotted series: which datum field, its label, and its palette colour. */
export interface TimeSeries {
  /** Key into each data row for this series' value. */
  key: string;
  /** Legend/tooltip label. Defaults to `key`. */
  label?: string;
  /** Palette key → `var(--color-<chartKey>)`. */
  chartKey?: ChartKey;
}

export interface TimeSeriesChartProps<Row extends Record<string, unknown>> {
  data: Row[];
  /** Datum field for the X axis (e.g. a `date` / `day` string). */
  xKey: keyof Row & string;
  /** Series to plot. */
  series: TimeSeries[];
  /** `area` (gradient), `bar`, or `line`. */
  variant?: "area" | "bar" | "line";
  /** Stack multiple series (area/bar). */
  stacked?: boolean;
  /** Format an X tick value (e.g. `YYYY-MM-DD` → "Aug 12"). */
  xTickFormatter?: (value: string) => string;
  /** Format a Y value / tooltip value (e.g. USD, compact). */
  valueFormatter?: (value: number) => string;
  /** Hide the Y axis (dense strips). */
  hideYAxis?: boolean;
  /** Show the legend (defaults on for >1 series). */
  showLegend?: boolean;
  /** Drill-to-L3: click a data point → the clicked row + its index. */
  onPointClick?: (row: Row, index: number) => void;
  /**
   * Story layer (G7): recharts `<ReferenceLine>` / `<ReferenceDot>` /
   * `<ReferenceArea>` rendered as direct children of the chart (they must be, so
   * recharts can read their axis binding). Sits behind the plotted series.
   * Optional — existing callers pass nothing and render unchanged.
   */
  annotations?: ReactNode;
  className?: string;
}

const FALLBACK_KEYS: ChartKey[] = ["chart-1", "chart-2", "chart-3", "chart-4", "chart-5"];

export function TimeSeriesChart<Row extends Record<string, unknown>>({
  data,
  xKey,
  series,
  variant = "area",
  stacked = false,
  xTickFormatter,
  valueFormatter,
  hideYAxis = false,
  showLegend,
  onPointClick,
  annotations,
  className = "aspect-[16/7] w-full",
}: TimeSeriesChartProps<Row>) {
  const gid = useId().replace(/:/g, "");

  // Chart-level drill: map the active tooltip index back to its data row.
  const handleClick = onPointClick
    ? (state: { activeTooltipIndex?: number }) => {
        const idx = state?.activeTooltipIndex;
        if (idx == null || idx < 0 || idx >= data.length) return;
        onPointClick(data[idx], idx);
      }
    : undefined;
  const chartClass = onPointClick ? "cursor-pointer" : undefined;

  const config = useMemo<ChartConfig>(() => {
    const cfg: ChartConfig = {};
    series.forEach((s, i) => {
      cfg[s.key] = {
        label: s.label ?? s.key,
        color: `var(--color-${s.chartKey ?? FALLBACK_KEYS[i % FALLBACK_KEYS.length]})`,
      };
    });
    return cfg;
  }, [series]);

  const legend = showLegend ?? series.length > 1;
  const stackId = stacked ? "stack" : undefined;

  const axes = (
    <>
      <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--color-border)" />
      <XAxis
        dataKey={xKey}
        tickLine={false}
        axisLine={false}
        tickMargin={8}
        tick={AXIS_TICK}
        tickFormatter={xTickFormatter}
      />
      {hideYAxis ? null : (
        <YAxis
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          width={44}
          tick={AXIS_TICK}
          tickFormatter={valueFormatter ? (v) => valueFormatter(Number(v)) : undefined}
        />
      )}
      <ChartTooltip
        content={
          <ChartTooltipContent
            formatter={
              valueFormatter
                ? (v, name, item) => (
                    <span className="flex w-full items-center justify-between gap-3">
                      <span className="text-muted-foreground">
                        {config[String(item?.dataKey ?? name)]?.label ?? name}
                      </span>
                      <span className="font-mono font-medium tabular-nums text-foreground">
                        {valueFormatter(Number(v))}
                      </span>
                    </span>
                  )
                : undefined
            }
          />
        }
      />
      {legend ? <ChartLegend content={<ChartLegendContent />} /> : null}
    </>
  );

  const margin = { top: 8, right: 12, left: hideYAxis ? -12 : 0, bottom: 0 };

  return (
    <ChartContainer config={config} className={className}>
      {variant === "bar" ? (
        <BarChart data={data} margin={margin} onClick={handleClick} className={chartClass}>
          {axes}
          {annotations}
          {series.map((s) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              stackId={stackId}
              fill={`var(--color-${s.key})`}
              radius={stacked ? 0 : [3, 3, 0, 0]}
            />
          ))}
        </BarChart>
      ) : variant === "line" ? (
        <LineChart data={data} margin={margin} onClick={handleClick} className={chartClass}>
          {axes}
          {annotations}
          {series.map((s) => (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              stroke={`var(--color-${s.key})`}
              strokeWidth={2}
              dot={false}
            />
          ))}
        </LineChart>
      ) : (
        <AreaChart data={data} margin={margin} onClick={handleClick} className={chartClass}>
          <defs>
            {series.map((s) => (
              <linearGradient key={s.key} id={`ts-${gid}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={`var(--color-${s.key})`} stopOpacity={0.45} />
                <stop offset="95%" stopColor={`var(--color-${s.key})`} stopOpacity={0.02} />
              </linearGradient>
            ))}
          </defs>
          {axes}
          {annotations}
          {series.map((s) => (
            <Area
              key={s.key}
              type="monotone"
              dataKey={s.key}
              stackId={stackId}
              stroke={`var(--color-${s.key})`}
              strokeWidth={2}
              fill={`url(#ts-${gid}-${s.key})`}
            />
          ))}
        </AreaChart>
      )}
    </ChartContainer>
  );
}
