/**
 * @fileoverview Billing telemetry — the Guardian cockpit's read surface.
 *
 * Composes three layers over `GET /api/guardian/usage`, `/guardian/history`
 * and `/guardian/cron`:
 *
 *   1. {@link UsageStats}  — four KPI cells: spend pressure, surges, cron health.
 *   2. {@link UsageTrend}  — probe picker + hourly trend + per-resource donut.
 *   3. {@link UsageTable}  — every binding, severity-ordered, unmetered included.
 *
 * The selected probe is shared state: clicking a table row re-charts the trend,
 * and the metric strip drives the same selection. Deltas come from the two
 * newest snapshots, so they are real hour-over-hour movement rather than a
 * synthetic baseline.
 */

"use client";

import { Loader2Icon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { ApiError, apiGet } from "@/lib/api";
import { compactNumber, formatRatio, humanSize, relativeTime } from "@/lib/format";

import { pctChange, UsageStats, type StatCell } from "./UsageStats";
import { UsageTable, type TableReading } from "./UsageTable";
import { UsageTrend, type TrendSeries } from "./UsageTrend";

type UsageReading = TableReading & {
  breakdown: { label: string; value: number }[];
};

type UsageResponse = { windowHours: number; readings: UsageReading[] };
type HistoryResponse = { windowHours: number; series: TrendSeries[] };

type CronRun = {
  id: string;
  ranAt: number;
  durationMs: number;
  probesOk: number;
  probesFailed: number;
  alerts: number;
  status: "ok" | "partial" | "error";
  error: string | null;
};
type CronResponse = { runs: CronRun[]; stale: boolean };

function fmt(value: number, unit: string): string {
  return unit.includes("bytes") ? humanSize(value) : compactNumber(value);
}

export function UsageGrid() {
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [history, setHistory] = useState<TrendSeries[]>([]);
  const [cron, setCron] = useState<CronResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setUnauthorized(false);
    try {
      // History and cron are supporting context — a failure there should not
      // blank the panel, so only the usage probe rejects the whole load.
      const [u, h, c] = await Promise.all([
        apiGet<UsageResponse>("/guardian/usage", { hours: 24 }),
        apiGet<HistoryResponse>("/guardian/history", { hours: 168 }).catch(() => null),
        apiGet<CronResponse>("/guardian/cron", { limit: 24 }).catch(() => null),
      ]);
      setUsage(u);
      setHistory(h?.series ?? []);
      setCron(c);
      setSelectedId((prev) => prev || (u.readings.find((r) => r.status === "ok")?.id ?? ""));
    } catch (err) {
      const is401 = err instanceof ApiError && err.status === 401;
      setUnauthorized(is401);
      setError(
        is401
          ? "The Guardian API requires an authenticated session."
          : err instanceof ApiError
            ? err.message
            : "Failed to load telemetry.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const readings = useMemo(() => usage?.readings ?? [], [usage]);
  const metered = useMemo(() => readings.filter((r) => r.status === "ok"), [readings]);

  const stats = useMemo<StatCell[]>(() => {
    const surging = metered.filter((r) => r.surging);
    const lastRun = cron?.runs[0];

    // Headline "pressure" = the probe closest to its own threshold. Summing raw
    // values across probes would add rows to requests to bytes, which is
    // meaningless; a ratio is comparable.
    const pressure = metered
      .map((r) => ({ r, pct: r.alertThreshold ? r.value / r.alertThreshold : 0 }))
      .sort((a, b) => b.pct - a.pct)[0];

    // Hour-over-hour delta for the hottest probe, from its two newest snapshots.
    const hotSeries = history.find((s) => s.service === pressure?.r.id)?.points ?? [];
    const hotDelta =
      hotSeries.length >= 2
        ? pctChange(hotSeries[hotSeries.length - 1].value, hotSeries[hotSeries.length - 2].value)
        : null;

    return [
      {
        label: "Highest load",
        value:
          pressure && pressure.r.alertThreshold
            ? (formatRatio(pressure.r.value, pressure.r.alertThreshold) ?? "—")
            : "—",
        suffix: pressure ? "of limit" : undefined,
        deltaPct: hotDelta,
        riseIsBad: true,
        context: pressure
          ? `${pressure.r.label} · ${fmt(pressure.r.value, pressure.r.unit)}`
          : "no metered probes",
        tone: pressure && pressure.pct >= 1 ? "danger" : pressure && pressure.pct >= 0.7 ? "warning" : "default",
      },
      {
        label: "Surging bindings",
        value: String(surging.length),
        suffix: `of ${metered.length}`,
        context: surging.length > 0 ? surging.map((r) => r.label).join(", ") : "all within threshold",
        tone: surging.length > 0 ? "danger" : "default",
      },
      {
        label: "Probe coverage",
        value: String(metered.length),
        suffix: `of ${readings.length}`,
        context: `${readings.length - metered.length} not measured by Cloudflare analytics`,
        tone: "default",
      },
      {
        label: "Cron heartbeat",
        value: cron?.stale ? "stale" : lastRun ? "ok" : "never",
        context: lastRun
          ? `${relativeTime(lastRun.ranAt)} · ${lastRun.probesOk}/${lastRun.probesOk + lastRun.probesFailed} probes · ${(lastRun.durationMs / 1000).toFixed(1)}s`
          : "the hourly trigger has not fired",
        tone: cron?.stale ? "danger" : lastRun?.status === "ok" ? "default" : "warning",
      },
    ];
  }, [metered, readings.length, cron, history]);

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
            Core Guardian · Billing Telemetry
          </div>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight">
            Trailing {usage?.windowHours ?? 24}h
          </h2>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void load()}
          disabled={loading}
          className="gap-2"
        >
          {loading ? (
            <Loader2Icon className="size-4 animate-spin" />
          ) : (
            <RefreshCwIcon className="size-4" />
          )}
          Refresh
        </Button>
      </header>

      {error && (
        <p className="rounded-xl border border-border/60 bg-background/40 p-4 text-sm text-muted-foreground">
          {error}{" "}
          {unauthorized && (
            <a
              href="/login?next=/dashboard/guardian"
              className="font-medium text-foreground underline underline-offset-4"
            >
              Sign in
            </a>
          )}
        </p>
      )}

      {!error && loading && !usage && (
        <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-background/40 p-6 text-sm text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" />
          Loading telemetry…
        </div>
      )}

      {!error && usage && (
        <>
          <UsageStats cells={stats} />

          {metered.length > 0 && (
            <UsageTrend
              probes={metered}
              series={history}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          )}

          <UsageTable readings={readings} selectedId={selectedId} onSelect={setSelectedId} />
        </>
      )}
    </section>
  );
}
