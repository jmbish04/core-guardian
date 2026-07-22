/**
 * @fileoverview Top-line KPI strip for the Guardian cockpit.
 *
 * Four cells in one bordered row (the ReUI `stats-7` shape): a headline number,
 * a delta badge, and a secondary line of context. Deltas compare the newest
 * usage snapshot against the previous one, so "+18%" means the last cron hour
 * versus the one before — not a fabricated baseline.
 */

"use client";

import {
  ActivityIcon,
  AlertTriangleIcon,
  GaugeIcon,
  TrendingDownIcon,
  TrendingUpIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { compactNumber, relativeTime } from "@/lib/format";

export type StatCell = {
  label: string;
  /** Already-formatted headline value. */
  value: string;
  /** Small grey suffix rendered next to the value (e.g. "of 14"). */
  suffix?: string;
  /** Percent change vs. the previous reading. Omit when there is no baseline. */
  deltaPct?: number | null;
  /** Text under the delta badge. */
  context: string;
  /** When true, a rising delta is bad (cost), not good (throughput). */
  riseIsBad?: boolean;
  tone?: "default" | "warning" | "danger";
};

const TONE_ICON = {
  default: ActivityIcon,
  warning: GaugeIcon,
  danger: AlertTriangleIcon,
} as const;

/** Delta badge — green/red is chosen by intent, not by sign. */
function DeltaBadge({ pct, riseIsBad }: { pct: number; riseIsBad?: boolean }) {
  const rising = pct >= 0;
  const bad = riseIsBad ? rising : !rising;
  const Icon = rising ? TrendingUpIcon : TrendingDownIcon;
  return (
    <Badge
      variant="outline"
      className={
        bad
          ? "gap-1 border-rose-500/25 bg-rose-500/10 text-rose-600 dark:text-rose-400"
          : "gap-1 border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
      }
    >
      <Icon className="size-3" />
      {rising ? "+" : ""}
      {pct.toFixed(1)}%
    </Badge>
  );
}

export function UsageStats({ cells }: { cells: StatCell[] }) {
  return (
    <div className="grid grid-cols-1 overflow-hidden rounded-xl border border-border/60 bg-background/40 sm:grid-cols-2 xl:grid-cols-4">
      {cells.map((cell) => {
        const Icon = TONE_ICON[cell.tone ?? "default"];
        return (
          <div
            key={cell.label}
            className="flex flex-col justify-between gap-4 border-b border-border/60 p-5 last:border-b-0 sm:[&:nth-child(-n+2)]:border-b sm:[&:nth-child(n+3)]:border-b-0 sm:odd:border-r xl:border-b-0 xl:border-r xl:last:border-r-0"
          >
            <div className="flex items-center gap-2">
              <Icon
                className={
                  cell.tone === "danger"
                    ? "size-4 text-rose-500"
                    : cell.tone === "warning"
                      ? "size-4 text-amber-500"
                      : "size-4 text-muted-foreground"
                }
              />
              <span className="text-sm font-medium text-muted-foreground">{cell.label}</span>
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-3xl font-semibold tracking-tight tabular-nums">
                  {cell.value}
                </span>
                {cell.suffix && (
                  <span className="text-lg font-medium text-muted-foreground/45">{cell.suffix}</span>
                )}
                {cell.deltaPct != null && Number.isFinite(cell.deltaPct) && (
                  <DeltaBadge pct={cell.deltaPct} riseIsBad={cell.riseIsBad} />
                )}
              </div>
              <span className="text-xs text-muted-foreground">{cell.context}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Percent change between two readings; null when there is no usable baseline. */
export function pctChange(current: number, previous: number): number | null {
  if (!Number.isFinite(previous) || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

/** "cron ok · 12m ago" style context line for the heartbeat cell. */
export function cronContext(ranAt: number | undefined, stale: boolean): string {
  if (ranAt == null) return "never run";
  return stale ? `stale — last ${relativeTime(ranAt)}` : `last run ${relativeTime(ranAt)}`;
}

export { compactNumber };
