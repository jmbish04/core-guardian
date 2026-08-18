/**
 * @fileoverview HeroMetricChart — the Level-2 "product hero metric" card.
 *
 * The reusable timeframe-tab hero pattern for the detail tier: one icon-badged
 * headline metric + a themed line chart + 5D/2W/1M-style period tabs. Derived
 * from the ReUI `@reui/chart-22` block (Card + Item media icon + Tabs +
 * ChartContainer LineChart), re-themed to the Monolith surface and made
 * data-driven — the original shipped hardcoded revenue data and a hand-rolled
 * dark-only tooltip; both are replaced here.
 *
 * Re-theme vs. the stock block:
 *   - series colour → `var(--color-<chartKey>)` (recolors on the ThemeToggle),
 *     not a fixed `violet-500`;
 *   - ring-1 ring-border/40, no 1px card border;
 *   - grid/axis/tooltip via the shared G0 `<ChartContainer>` token layer
 *     (`ChartTooltipContent`), not a bespoke `bg-zinc-900` popover.
 *
 * Data model: the caller passes ONE ascending series (`points`, oldest→newest).
 * The period tabs slice the tail (last N points) — one fetch, no per-tab round
 * trips. Clicking a point drills to Level-3 via `onPointClick` (the caller maps
 * it to `/dashboard/<product>/logs?query=…`).
 *
 * G1 guards: every value is `Number.isFinite`-coerced before it is summed or
 * fed to a formatter (no `$NaN` headline); an empty series renders an
 * `<EmptyState>`, never a blank chart.
 */

"use client";

import type { LucideIcon } from "lucide-react";
import { ArrowRight, Loader2Icon } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, XAxis } from "recharts";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

import type { ChartKey } from "./Sparkline";
import { EmptyState, InlineError } from "./shared";

/** One plotted point: a day/label key and its numeric value. */
export interface HeroPoint {
  /** X label — typically a `YYYY-MM-DD` day (used for the drill query too). */
  label: string;
  value: number;
}

interface Period {
  key: string;
  label: string;
  /** Tail length: how many trailing points this window shows. */
  count: number;
}

const DEFAULT_PERIODS: Period[] = [
  { key: "7D", label: "7D", count: 7 },
  { key: "14D", label: "14D", count: 14 },
  { key: "30D", label: "30D", count: 30 },
];

const AXIS_TICK = { fill: "var(--color-foreground)", fontSize: 12 } as const;

/** G1: coerce anything non-finite (NaN/Infinity/undefined) to 0. */
const fin = (n: number | null | undefined): number => (Number.isFinite(n) ? (n as number) : 0);

export interface HeroMetricChartProps {
  title: string;
  icon: LucideIcon;
  /** Full ascending series (oldest → newest). */
  points: HeroPoint[];
  /** Palette hue → `var(--color-<chartKey>)`. */
  chartKey?: ChartKey;
  /** Headline aggregate over the visible window. Default `"sum"`. */
  aggregate?: "sum" | "last" | "avg";
  /** Format the headline + tooltip + Y values. */
  valueFormatter: (n: number) => string;
  /** Legend/tooltip label for the series. */
  seriesLabel?: string;
  /** Format an X tick (e.g. `YYYY-MM-DD` → "Aug 12"). */
  xTickFormatter?: (label: string) => string;
  periods?: Period[];
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  /** Drill to Level-3: the clicked point → navigation. */
  onPointClick?: (point: HeroPoint) => void;
  /**
   * L3 logs page for this product. When set, renders a real keyboard-focusable
   * link so drill-down isn't mouse-only (the recharts click target is a
   * non-focusable svg) — WCAG 2.1.1.
   */
  logsHref?: string;
  /** Small caption under the headline (e.g. "billed, MTD"). */
  caption?: string;
  /**
   * Story layer (G7): recharts `<ReferenceLine>` / `<ReferenceDot>` rendered as
   * direct children of the LineChart (behind the plotted line) — e.g. a baseline
   * threshold and an anomaly marker. Optional.
   */
  annotations?: ReactNode;
  className?: string;
}

export function HeroMetricChart({
  title,
  icon: Icon,
  points,
  chartKey = "chart-1",
  aggregate = "sum",
  valueFormatter,
  seriesLabel = "Value",
  xTickFormatter,
  periods = DEFAULT_PERIODS,
  loading = false,
  error = null,
  onRetry,
  onPointClick,
  logsHref,
  caption,
  annotations,
  className,
}: HeroMetricChartProps) {
  const [period, setPeriod] = useState(periods[0].key);
  const active = periods.find((p) => p.key === period) ?? periods[0];

  // Slice the tail for the selected window; coerce every value finite (G1).
  const windowed = useMemo(
    () => points.slice(-active.count).map((p) => ({ label: p.label, value: fin(p.value) })),
    [points, active.count],
  );

  const headline = useMemo(() => {
    if (windowed.length === 0) return 0;
    if (aggregate === "last") return windowed[windowed.length - 1].value;
    const sum = windowed.reduce((s, p) => s + p.value, 0);
    return aggregate === "avg" ? sum / windowed.length : sum;
  }, [windowed, aggregate]);

  const config = useMemo<ChartConfig>(
    () => ({ value: { label: seriesLabel, color: `var(--color-${chartKey})` } }),
    [seriesLabel, chartKey],
  );

  return (
    <Card className={cn("ring-1 ring-border/40", className)}>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-3">
          <span
            className="flex size-10 shrink-0 items-center justify-center rounded-full ring-1 ring-border/40"
            style={{ backgroundColor: `color-mix(in oklch, var(--color-${chartKey}) 16%, transparent)` }}
          >
            <Icon className="size-5" style={{ color: `var(--color-${chartKey})` }} aria-hidden />
          </span>
          <div className="flex flex-col gap-0.5">
            <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
            <span className="font-mono text-2xl font-semibold tabular-nums tracking-tight">
              {valueFormatter(fin(headline))}
            </span>
            {caption ? (
              <span className="text-xs text-muted-foreground">{caption}</span>
            ) : null}
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <Tabs value={period} onValueChange={setPeriod} className="w-full">
          <TabsList className="w-full">
            {periods.map((p) => (
              <TabsTrigger key={p.key} value={p.key} className="flex-1">
                {p.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        {error ? (
          <InlineError message={error} onRetry={onRetry} />
        ) : loading && windowed.length === 0 ? (
          <div className="flex h-40 items-center justify-center">
            <Loader2Icon className="size-5 animate-spin text-muted-foreground" aria-hidden />
          </div>
        ) : windowed.length === 0 ? (
          <EmptyState label="No data for this window yet." />
        ) : (
          <ChartContainer config={config} className="aspect-[16/6] w-full">
            <LineChart
              data={windowed}
              margin={{ top: 8, right: 12, left: 4, bottom: 0 }}
              // Drill-to-L3: click anywhere on the plot → the active point.
              onClick={(state) => {
                if (!onPointClick) return;
                const idx = (state as { activeTooltipIndex?: number })?.activeTooltipIndex;
                if (idx == null || idx < 0 || idx >= windowed.length) return;
                onPointClick(windowed[idx]);
              }}
              className={onPointClick ? "cursor-pointer" : undefined}
            >
              <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                tick={AXIS_TICK}
                tickFormatter={xTickFormatter}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    labelFormatter={(v) => (xTickFormatter ? xTickFormatter(String(v)) : String(v))}
                    formatter={(value) => (
                      <span className="flex w-full items-center justify-between gap-3">
                        <span className="text-muted-foreground">{seriesLabel}</span>
                        <span className="font-mono font-medium tabular-nums text-foreground">
                          {valueFormatter(fin(Number(value)))}
                        </span>
                      </span>
                    )}
                  />
                }
              />
              {annotations}
              <Line
                dataKey="value"
                type="monotone"
                stroke="var(--color-value)"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, fill: "var(--color-value)", strokeWidth: 0 }}
              />
            </LineChart>
          </ChartContainer>
        )}

        {logsHref ? (
          <a
            href={logsHref}
            className="inline-flex w-fit items-center gap-1 rounded text-[11px] text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {onPointClick ? "Click a point, or view all logs" : "View all logs"}
            <ArrowRight className="size-3" aria-hidden />
          </a>
        ) : onPointClick ? (
          <p className="text-[11px] text-muted-foreground">Click a point to inspect its logs.</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
