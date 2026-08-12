/**
 * @fileoverview The two spend charts for SpendOverview, kept out of the island
 * so the container stays under the size ceiling.
 *
 *   SpendTrendChart — billable spend over time (solid actual) + a dashed
 *     muted-red run-rate projection from today to month-end.
 *   SpendBarChart   — one bar per day = that day's priced cost, a $35 auto-break
 *     threshold reference line, and faint ghost bars for projected future days.
 *
 * Both are recharts wrapped in shadcn `<ChartContainer>` with the OKLCH palette;
 * axis text is forced to `hsl(var(--foreground))` per the Monolith rules.
 */

"use client";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  XAxis,
} from "recharts";

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

import type { SpendChartPoint } from "./spend-metrics";

/** USD, cent-precise under $10, whole-dollar above — matches the sibling panels. */
function usd(n: number): string {
  const abs = Math.abs(n);
  const digits = abs !== 0 && abs < 10 ? 2 : 0;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** Short month+day tick, e.g. "Aug 12". */
function dayTick(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

const CONFIG = {
  cost: { label: "Billed / day", color: "var(--chart-2)" },
  projected: { label: "Projected (run-rate)", color: "var(--destructive)" },
} satisfies ChartConfig;

/** The daily auto-break threshold, drawn as a reference line on the bar chart. */
export const DAILY_BREAK_THRESHOLD = 35;

function SpendTooltip() {
  return (
    <ChartTooltip
      content={
        <ChartTooltipContent
          labelFormatter={(_, p) => (p?.[0] ? dayTick(String(p[0].payload.day)) : "")}
          formatter={(v, name) => (
            <span className="flex w-full items-center justify-between gap-3">
              <span className="text-muted-foreground">
                {name === "cost" ? "Billed" : "Projected"}
              </span>
              <span className="font-mono font-medium tabular-nums">{usd(Number(v))}</span>
            </span>
          )}
        />
      }
    />
  );
}

/** Line/area: solid actual spend + dashed muted-red run-rate projection. */
export function SpendTrendChart({ data }: { data: SpendChartPoint[] }) {
  return (
    <ChartContainer config={CONFIG} className="h-[240px] w-full">
      <AreaChart data={data} margin={{ left: 4, right: 4, top: 8, bottom: 0 }}>
        <defs>
          <linearGradient id="spendActualFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-cost)" stopOpacity={0.25} />
            <stop offset="100%" stopColor="var(--color-cost)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
        <XAxis
          dataKey="day"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={28}
          tickFormatter={dayTick}
          tick={{ fill: "hsl(var(--foreground))", fontSize: 11 }}
        />
        <SpendTooltip />
        {/* Projected first so the authoritative actual line draws on top. */}
        <Area
          type="monotone"
          dataKey="projected"
          stroke="var(--color-projected)"
          strokeWidth={1.5}
          strokeDasharray="5 4"
          fill="none"
          dot={false}
          connectNulls
        />
        <Area
          type="monotone"
          dataKey="cost"
          stroke="var(--color-cost)"
          strokeWidth={2}
          fill="url(#spendActualFill)"
          dot={false}
        />
      </AreaChart>
    </ChartContainer>
  );
}

/** Bullet-style bars: per-day cost, $35 threshold marker, ghost projected bars. */
export function SpendBarChart({ data }: { data: SpendChartPoint[] }) {
  return (
    <ChartContainer config={CONFIG} className="h-[240px] w-full">
      <BarChart data={data} margin={{ left: 4, right: 4, top: 8, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
        <XAxis
          dataKey="day"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={28}
          tickFormatter={dayTick}
          tick={{ fill: "hsl(var(--foreground))", fontSize: 11 }}
        />
        <SpendTooltip />
        <ReferenceLine
          y={DAILY_BREAK_THRESHOLD}
          stroke="var(--color-projected)"
          strokeDasharray="4 4"
          strokeWidth={1.5}
          label={{
            value: `auto-break $${DAILY_BREAK_THRESHOLD}`,
            position: "insideTopLeft",
            fill: "hsl(var(--foreground))",
            fontSize: 10,
          }}
        />
        {/* Ghost projected bars sit behind; actual bars in front. */}
        <Bar dataKey="projected" fill="var(--color-projected)" fillOpacity={0.18} radius={2} />
        <Bar dataKey="cost" fill="var(--color-cost)" radius={2} />
      </BarChart>
    </ChartContainer>
  );
}
