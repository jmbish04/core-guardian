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
 * ranked anomalies to `<AnomaliesGrid>` rendered directly below. One fetch is
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

import { AnomaliesGrid, type Anomaly } from "./AnomaliesGrid";
import { InlineError } from "./shared";

interface Insights {
  mtdUsd: number;
  mtdSource: "actual" | "estimate";
  estimateUsd: number;
  projectedMonthEnd: number;
  sinceLastVisit: { deltaUsd: number | null; daysSince: number | null; at: number | null };
  anomalies: Anomaly[];
  periodStartMs: number | null;
  periodEndMs: number | null;
}

/** Human "N days ago" from a fractional day count; sub-day rounds to "today". */
function visitAgo(daysSince: number): string {
  const d = Math.round(daysSince);
  if (d <= 0) return "earlier today";
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Format epoch-ms as "Mon D" (UTC). */
function fmtDate(ms: number): string {
  const d = new Date(ms);
  return `${MONTH_SHORT[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** Whole days remaining until periodEndMs — floor, so N means at least N full
 * days left (0 on the final calendar day, before the cycle rolls at period end). */
function daysUntil(endMs: number, nowMs: number): number {
  return Math.floor((endMs - nowMs) / 86_400_000);
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
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
    );
  }
  if (error && !data) return <InlineError message={error} onRetry={load} />;
  if (!data) return null;

  const { mtdSource, estimateUsd, projectedMonthEnd, sinceLastVisit, anomalies, periodStartMs, periodEndMs } = data;
  const nowMs = Date.now();

  // If we're past the period end, show $0 — new cycle started, sync hasn't landed yet.
  const newCycleStarted = periodEndMs != null && nowMs >= periodEndMs;
  const mtdUsd = newCycleStarted ? 0 : data.mtdUsd;

  const delta = sinceLastVisit.deltaUsd;
  const up = delta !== null && delta > 0;
  const down = delta !== null && delta < 0;
  const hot = !newCycleStarted && projectedMonthEnd - mtdUsd > Math.max(5, mtdUsd * 0.5);

  // Billing period label: "Jul 19 – Aug 18" or "Billing period" when unknown.
  const periodLabel =
    periodStartMs && periodEndMs
      ? `${fmtDate(periodStartMs)} – ${fmtDate(periodEndMs - 1)}`
      : "Billing period";

  // Days remaining in the current billing period.
  const daysLeft = periodEndMs ? daysUntil(periodEndMs, nowMs) : null;
  const daysLeftLabel =
    newCycleStarted
      ? "New cycle started · syncing…"
      : daysLeft === 0
        ? "Invoice due today"
        : daysLeft === 1
          ? "Invoice expected tomorrow"
          : daysLeft !== null
            ? `Invoice expected in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`
            : null;

  return (
    <section className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 sm:gap-4">
        {/* Billing-period-to-date + since-last-visit, same card. */}
        <Card className="ring-1 ring-border/40">
          <CardContent className="flex flex-col gap-1.5 p-4">
            <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
              {periodLabel}
            </span>
            <span className="text-3xl font-semibold tabular-nums tracking-tight sm:text-4xl">
              {usd(mtdUsd, false)}
            </span>
            <span
              className={
                newCycleStarted
                  ? "font-mono text-[10px] uppercase tracking-wider text-blue-500"
                  : mtdSource === "actual"
                    ? "font-mono text-[10px] uppercase tracking-wider text-emerald-500"
                    : "font-mono text-[10px] uppercase tracking-wider text-amber-500"
              }
            >
              {newCycleStarted
                ? "new billing cycle · data syncing"
                : mtdSource === "actual"
                  ? `actual billed · est ${usd(estimateUsd, false)}`
                  : "estimate — actual billing lags ~24h (or not synced yet)"}
            </span>
            {!newCycleStarted &&
              (delta === null ? (
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
              ))}
            {daysLeftLabel && (
              <span className="text-xs text-muted-foreground">{daysLeftLabel}</span>
            )}
          </CardContent>
        </Card>

        {/* Projected period-end. */}
        <Card className={hot ? "ring-1 ring-destructive/40" : "ring-1 ring-border/40"}>
          <CardContent className="flex flex-col gap-1.5 p-4">
            <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
              {periodEndMs ? `Projected by ${fmtDate(periodEndMs - 1)}` : "Projected period-end"}
            </span>
            <span
              className={
                hot
                  ? "flex items-center gap-2 text-3xl font-semibold tabular-nums tracking-tight text-destructive sm:text-4xl"
                  : "flex items-center gap-2 text-3xl font-semibold tabular-nums tracking-tight sm:text-4xl"
              }
            >
              {hot ? <TrendingUp className="size-5" aria-hidden /> : null}
              {newCycleStarted ? usd(0, false) : usd(projectedMonthEnd, false)}
            </span>
            <span className={hot ? "text-xs font-medium text-destructive" : "text-xs text-muted-foreground"}>
              {newCycleStarted
                ? "new cycle — projection resets once data syncs"
                : `${usd(Math.max(0, projectedMonthEnd - mtdUsd))} more projected`}
            </span>
          </CardContent>
        </Card>
      </div>

      <AnomaliesGrid anomalies={anomalies} onActed={load} />
    </section>
  );
}
