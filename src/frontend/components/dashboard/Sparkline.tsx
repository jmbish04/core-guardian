/**
 * @fileoverview Sparkline — a minimal, axis-less trend primitive.
 *
 * A tiny recharts Area/Line drawn inside the G0 `<ChartContainer>` so it inherits
 * the theme-token axis/grid overrides and, more importantly, recolors on the
 * ThemeToggle: the single series colour is routed through the ChartConfig
 * `--color-<key>` variable pointed at the OKLCH `var(--color-chart-N)` palette.
 *
 * No axes, grid, tooltip, or legend — a sparkline is pure shape. It fills its
 * parent width and a fixed small height (default 40px), so it drops cleanly into
 * a KPI card, a table cell, or a list row.
 *
 * recharts ONLY (project rule); nothing here fabricates data.
 */

"use client";

import { useId } from "react";
import { Area, AreaChart, Line, LineChart } from "recharts";

import { ChartContainer, type ChartConfig } from "@/components/ui/chart";

/** Palette keys selecting the stroke/fill colour from the OKLCH Monolith chart palette. */
export type ChartKey = "chart-1" | "chart-2" | "chart-3" | "chart-4" | "chart-5";

export interface SparklineProps {
  /** The series values, oldest → newest. Objects are mapped to `{ value }`. */
  data: Array<number | { value: number }>;
  /** Palette key → `var(--color-<chartKey>)`. Recolors on theme toggle. */
  chartKey?: ChartKey;
  /** `area` (gradient fill) or `line` (stroke only). */
  variant?: "area" | "line";
  /** Pixel height of the strip. Width is always fluid. */
  height?: number;
  className?: string;
  /** Accessible label; falls back to a generic description. */
  ariaLabel?: string;
}

/**
 * A compact trend line. Reuses the shared ChartContainer purely for its
 * ResponsiveContainer + theme-token plumbing; all chart chrome is stripped.
 */
export function Sparkline({
  data,
  chartKey = "chart-1",
  variant = "area",
  height = 40,
  className,
  ariaLabel = "Trend sparkline",
}: SparklineProps) {
  const gradientId = useId().replace(/:/g, "");
  const rows = data.map((d) => (typeof d === "number" ? { value: d } : d));
  const config: ChartConfig = { value: { color: `var(--color-${chartKey})` } };

  return (
    <ChartContainer
      config={config}
      className={className ?? "aspect-auto w-full"}
      style={{ height }}
      role="img"
      aria-label={ariaLabel}
    >
      {variant === "line" ? (
        <LineChart data={rows} margin={{ top: 4, right: 2, bottom: 4, left: 2 }}>
          <Line
            type="monotone"
            dataKey="value"
            stroke="var(--color-value)"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      ) : (
        <AreaChart data={rows} margin={{ top: 4, right: 2, bottom: 0, left: 2 }}>
          <defs>
            <linearGradient id={`spark-${gradientId}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="var(--color-value)" stopOpacity={0.4} />
              <stop offset="95%" stopColor="var(--color-value)" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            dataKey="value"
            stroke="var(--color-value)"
            strokeWidth={2}
            fill={`url(#spark-${gradientId})`}
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      )}
    </ChartContainer>
  );
}
