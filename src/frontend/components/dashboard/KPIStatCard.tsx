/**
 * @fileoverview KPIStatCard — the Level-1 "1000-ft view" headline metric card.
 *
 * A single, data-agnostic KPI tile: label + big value, an optional period-over-
 * period delta (arrow + tone), an accent icon chip, and an optional inline
 * {@link Sparkline}. Deliberately NOT bound to any one API shape — the caller
 * passes formatted strings and a raw number series, so the same primitive serves
 * spend, usage, task, and infra dashboards (G4 feeds it real data).
 *
 * Monolith styling mirrors the numeric cards in `StatCards`: `bg-card` surface,
 * `ring-1 ring-border/40` separation (never a 1px border), uppercase muted label,
 * tabular-nums value. The accent + sparkline colours come from the OKLCH
 * `var(--color-chart-N)` palette so the whole card recolors on the ThemeToggle.
 */

"use client";

import { ArrowDownRight, ArrowRight, ArrowUpRight, type LucideIcon } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import { Sparkline, type ChartKey } from "./Sparkline";

export interface KPIStatCardProps {
  /** Short uppercase caption, e.g. "Month-to-date spend". */
  label: string;
  /** Pre-formatted headline value, e.g. "$1,204" or "312". */
  value: string;
  /** Optional secondary line under the value (e.g. "of $2,000 budget"). */
  subtext?: string;
  /** Optional accent icon (lucide). Chip tinted with the card accent colour. */
  icon?: LucideIcon;
  /** Palette key driving the icon chip + sparkline. Recolors on theme toggle. */
  chartKey?: ChartKey;
  /**
   * Period-over-period change as a fraction (0.12 = +12%). Rendered as an arrow
   * chip; sign sets direction. By default a rise is "good" (emerald) and a fall
   * "bad" (destructive) — flip with {@link KPIStatCardProps.invertDelta} for
   * cost-style metrics where down is good.
   */
  delta?: number | null;
  /** Treat a falling delta as good (green) — for spend/error/latency KPIs. */
  invertDelta?: boolean;
  /**
   * Render the tile as an alert (destructive ring + destructive subtext) — e.g.
   * spend projected over budget/pace. Theme-aware via the `destructive` token.
   */
  alert?: boolean;
  /** Raw trend series (oldest → newest) for the inline sparkline. */
  trend?: number[];
  /** Sparkline shape. */
  sparklineVariant?: "area" | "line";
  className?: string;
}

/** Colour + arrow for a signed delta, honouring {@link KPIStatCardProps.invertDelta}. */
function deltaVisual(delta: number, invert: boolean) {
  if (delta === 0) return { tone: "text-muted-foreground", Icon: ArrowRight };
  const isUp = delta > 0;
  const good = invert ? !isUp : isUp;
  return {
    tone: good ? "text-emerald-700 dark:text-emerald-500" : "text-destructive",
    Icon: isUp ? ArrowUpRight : ArrowDownRight,
  };
}

export function KPIStatCard({
  label,
  value,
  subtext,
  icon: Icon,
  chartKey = "chart-1",
  delta,
  invertDelta = false,
  alert = false,
  trend,
  sparklineVariant = "area",
  className,
}: KPIStatCardProps) {
  const accent = `var(--color-${chartKey})`;
  const hasDelta = delta !== null && delta !== undefined;
  const d = hasDelta ? deltaVisual(delta, invertDelta) : null;

  return (
    <Card
      className={cn(
        "transition-colors hover:bg-card/80",
        className,
        // Appended last so it wins the twMerge ring-colour conflict over a
        // caller-supplied `ring-border/40` when this tile is in alert state.
        alert && "ring-1 ring-destructive/50",
      )}
    >
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </span>
          {Icon ? (
            <span
              className="flex size-7 items-center justify-center rounded-md ring-1 ring-border/40"
              style={{ backgroundColor: `color-mix(in oklch, ${accent} 14%, transparent)` }}
            >
              <Icon className="size-3.5" style={{ color: accent }} aria-hidden />
            </span>
          ) : null}
        </div>

        <div className="flex items-end justify-between gap-2">
          <span className="text-2xl font-semibold tabular-nums tracking-tight text-foreground">
            {value}
          </span>
          {d ? (
            <span className={cn("flex items-center gap-0.5 text-xs font-medium", d.tone)}>
              <d.Icon className="size-3.5" aria-hidden />
              {Math.abs(delta! * 100).toFixed(1)}%
            </span>
          ) : null}
        </div>

        {trend && trend.length > 1 ? (
          <Sparkline
            data={trend}
            chartKey={chartKey}
            variant={sparklineVariant}
            height={40}
            ariaLabel={`${label} trend`}
          />
        ) : null}

        {subtext ? (
          <span className={cn("text-xs", alert ? "text-destructive" : "text-muted-foreground")}>
            {subtext}
          </span>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Matching skeleton so a grid of KPI cards has a coherent LOADING state. */
export function KPIStatCardSkeleton() {
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="size-7 rounded-md" />
        </div>
        <Skeleton className="h-7 w-20" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-3 w-28" />
      </CardContent>
    </Card>
  );
}
