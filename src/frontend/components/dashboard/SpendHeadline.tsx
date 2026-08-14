/**
 * @fileoverview Spend headline — the first thing on the Guardian dashboard.
 *
 * The #1 v1 failure: a recurring $22/day drip read as a static bug because the
 * dashboard showed a per-day figure with no accumulation, no date, and no
 * "since last visit". This headline fixes the accumulation half:
 *   - big month-to-date running total (the period number),
 *   - the since-last-visit delta right under it in the same card,
 *   - a projected month-end figure, flagged when it towers over the run-rate.
 *
 * It owns the single `GET /guardian/billing/insights` fetch and hands the
 * ranked anomalies to `<AnomaliesPanel>` rendered directly below. One fetch is
 * deliberate: that endpoint records the "last visit" marker in KV on every read,
 * so a second island hitting it would zero out the very delta we're showing.
 */

"use client";

import { ArrowDownRight, ArrowUpRight, TrendingUp } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, apiGet } from "@/lib/api";
import { usd } from "@/lib/format";

import { AnomaliesPanel, type Anomaly } from "./AnomaliesPanel";
import { InlineError } from "./shared";

interface Insights {
  mtdUsd: number;
  mtdSource: "actual" | "estimate";
  estimateUsd: number;
  projectedMonthEnd: number;
  sinceLastVisit: { deltaUsd: number | null; daysSince: number | null; at: number | null };
  anomalies: Anomaly[];
}

/** Human "N days ago" from a fractional day count; sub-day rounds to "today". */
function visitAgo(daysSince: number): string {
  const d = Math.round(daysSince);
  if (d <= 0) return "earlier today";
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

export function SpendHeadline() {
  const [data, setData] = useState<Insights | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await apiGet<Insights>("/guardian/billing/insights"));
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "Sign in to view spend insights."
          : err instanceof ApiError
            ? err.message
            : "Failed to load spend insights.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !data) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:gap-4" aria-busy>
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
      </div>
    );
  }
  if (error && !data) return <InlineError message={error} onRetry={load} />;
  if (!data) return null;

  const { mtdUsd, mtdSource, estimateUsd, projectedMonthEnd, sinceLastVisit, anomalies } = data;
  const delta = sinceLastVisit.deltaUsd;
  const up = delta !== null && delta > 0;
  const down = delta !== null && delta < 0;
  // The projection towers over what's accrued: month isn't over and spend keeps
  // landing. Skip the flag for trivial early-month amounts.
  const hot = projectedMonthEnd - mtdUsd > Math.max(5, mtdUsd * 0.5);

  return (
    <section className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 sm:gap-4">
        {/* Month-to-date + since-last-visit, same card. */}
        <Card className="ring-1 ring-border/40">
          <CardContent className="flex flex-col gap-2 p-5">
            <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
              Month to date
            </span>
            <span className="text-4xl font-semibold tabular-nums tracking-tight sm:text-5xl">
              {usd(mtdUsd, false)}
            </span>
            <span
              className={
                mtdSource === "actual"
                  ? "font-mono text-[10px] uppercase tracking-wider text-emerald-500"
                  : "font-mono text-[10px] uppercase tracking-wider text-amber-500"
              }
            >
              {mtdSource === "actual"
                ? `actual billed · est ${usd(estimateUsd, false)}`
                : "estimate — actual billing lags ~24h (or not synced yet)"}
            </span>
            {delta === null ? (
              <span className="text-xs text-muted-foreground">
                First visit recorded — we'll track the change from here.
              </span>
            ) : (
              <span
                className={
                  up
                    ? "flex items-center gap-1 text-xs font-medium text-destructive"
                    : "flex items-center gap-1 text-xs text-muted-foreground"
                }
              >
                {up ? (
                  <ArrowUpRight className="size-3.5" aria-hidden />
                ) : down ? (
                  <ArrowDownRight className="size-3.5" aria-hidden />
                ) : null}
                {up ? "up " : down ? "down " : "no change · "}
                {delta !== 0 ? `${usd(Math.abs(delta))} ` : ""}
                since your last visit
                {sinceLastVisit.daysSince !== null ? ` ${visitAgo(sinceLastVisit.daysSince)}` : ""}
              </span>
            )}
          </CardContent>
        </Card>

        {/* Projected month-end. */}
        <Card className={hot ? "ring-1 ring-destructive/40" : "ring-1 ring-border/40"}>
          <CardContent className="flex flex-col gap-2 p-5">
            <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
              Projected month-end
            </span>
            <span
              className={
                hot
                  ? "flex items-center gap-2 text-4xl font-semibold tabular-nums tracking-tight text-destructive sm:text-5xl"
                  : "flex items-center gap-2 text-4xl font-semibold tabular-nums tracking-tight sm:text-5xl"
              }
            >
              {hot ? <TrendingUp className="size-6" aria-hidden /> : null}
              {usd(projectedMonthEnd, false)}
            </span>
            <span className={hot ? "text-xs font-medium text-destructive" : "text-xs text-muted-foreground"}>
              {usd(Math.max(0, projectedMonthEnd - mtdUsd))} more projected by month-end
            </span>
          </CardContent>
        </Card>
      </div>

      <AnomaliesPanel anomalies={anomalies} onActed={load} />
    </section>
  );
}
