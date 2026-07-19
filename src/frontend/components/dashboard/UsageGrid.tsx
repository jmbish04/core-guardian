/**
 * @fileoverview Billing telemetry — per-binding usage against safety thresholds.
 *
 * Fetches `GET /api/guardian/usage`, which runs one Cloudflare GraphQL
 * Analytics probe per binding type, and renders each metered probe as a usage
 * meter (value vs. the probe's alert threshold). Probes with no analytics
 * dataset, or whose query failed, are listed separately rather than dropped —
 * a governance panel that silently hides a binding is worse than one that
 * admits it cannot see it.
 *
 * Layout follows the shadcn "usage" dashboard block, rebuilt on this repo's
 * local `@/components/ui` primitives.
 */

"use client";

import { AlertTriangleIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { ApiError, apiGet } from "@/lib/api";
import { compactNumber, humanSize, relativeTime } from "@/lib/format";

type UsageReading = {
  id: string;
  label: string;
  product: string;
  bindings: string[];
  unit: string;
  status: "ok" | "not_metered" | "unavailable";
  value: number;
  breakdown: { label: string; value: number }[];
  alertThreshold: number | null;
  surging: boolean;
  error?: string;
};

type UsageResponse = { windowHours: number; readings: UsageReading[] };

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

/**
 * Cron heartbeat — the panel's numbers are only as fresh as the last run, so
 * a stopped trigger has to be visible, not inferred from stale values.
 */
function CronHeartbeat() {
  const [data, setData] = useState<CronResponse | null>(null);

  useEffect(() => {
    apiGet<CronResponse>("/guardian/cron", { limit: 24 })
      .then(setData)
      .catch(() => setData(null));
  }, []);

  if (!data) return null;

  const last = data.runs[0];
  const tone = data.stale
    ? "bg-rose-500"
    : last?.status === "ok"
      ? "bg-emerald-500"
      : "bg-amber-500";

  return (
    <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
      <span className={`size-1.5 rounded-full ${tone} ${data.stale ? "" : "animate-pulse"}`} />
      {last
        ? data.stale
          ? `cron stale · last ${relativeTime(last.ranAt)}`
          : `cron ok · ${relativeTime(last.ranAt)} · ${last.probesOk}/${last.probesOk + last.probesFailed} probes`
        : "cron has never run"}
    </span>
  );
}

/** Byte-valued units render as sizes; everything else as compact counts. */
function formatValue(value: number, unit: string): string {
  return unit.includes("bytes") ? humanSize(value) : compactNumber(value);
}

/** One binding's consumption against its surge threshold. */
function UsageMeter({ reading }: { reading: UsageReading }) {
  const threshold = reading.alertThreshold ?? 0;
  const pct = threshold > 0 ? Math.min(100, (reading.value / threshold) * 100) : 0;
  // Amber well before the threshold — a governance panel should warn early.
  const warn = pct >= 70 && !reading.surging;

  return (
    <li>
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-sm font-medium">{reading.label}</div>
        <div className="font-mono text-xs">
          <span className="text-foreground">{formatValue(reading.value, reading.unit)}</span>
          <span className="text-muted-foreground">
            {" / "}
            {formatValue(threshold, reading.unit)}
          </span>
        </div>
      </div>

      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-foreground/[0.06]">
        <div
          className={`h-full rounded-full transition-all ${
            reading.surging ? "bg-rose-500" : warn ? "bg-amber-500" : "bg-foreground/70"
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="mt-1 flex items-center justify-between text-xs">
        <span className="text-muted-foreground">
          {reading.unit} · threshold {formatValue(threshold, reading.unit)}
        </span>
        <span
          className={`font-mono text-[10px] uppercase tracking-[0.25em] tabular-nums ${
            reading.surging
              ? "text-rose-600 dark:text-rose-400"
              : warn
                ? "text-amber-600 dark:text-amber-400"
                : "text-muted-foreground/70"
          }`}
        >
          {reading.surging && <AlertTriangleIcon className="mr-1 inline size-3" />}
          {Math.round(pct)}% of limit
        </span>
      </div>

      {reading.breakdown.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {reading.breakdown.slice(0, 3).map((row) => (
            <li
              key={row.label}
              className="flex items-center justify-between gap-2 text-xs text-muted-foreground"
            >
              <span className="truncate font-mono">{row.label}</span>
              <span className="tabular-nums">{formatValue(row.value, reading.unit)}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** Bindings Cloudflare does not meter, or whose probe failed. */
function CoverageGaps({ readings }: { readings: UsageReading[] }) {
  if (readings.length === 0) return null;
  return (
    <div className="rounded-xl border border-border/60 bg-background/40 p-6">
      <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
        Not measured
      </div>
      <ul className="mt-3 flex flex-col gap-2">
        {readings.map((r) => (
          <li key={r.id} className="flex items-baseline justify-between gap-3 text-xs">
            <span className="text-foreground/80">{r.label}</span>
            <span className="truncate text-right font-mono text-[10px] text-muted-foreground">
              {r.status === "not_metered" ? "no analytics dataset" : (r.error ?? "unavailable")}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function UsageGrid() {
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await apiGet<UsageResponse>("/guardian/usage", { hours: 24 }));
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "Sign in to view telemetry — the Guardian API requires an authenticated session."
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

  const readings = data?.readings ?? [];
  const metered = readings.filter((r) => r.status === "ok");
  const gaps = readings.filter((r) => r.status !== "ok");
  const surging = metered.filter((r) => r.surging).length;

  return (
    <section className="flex flex-col gap-3">
      <header className="flex items-end justify-between gap-4">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
            Core Guardian · Billing Telemetry
          </div>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight">
            Trailing {data?.windowHours ?? 24}h
          </h2>
          <div className="mt-1">
            <CronHeartbeat />
          </div>
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
          {error}
        </p>
      )}

      {!error && (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-[2fr_1fr]">
          <div className="rounded-xl border border-border/60 bg-background/40 p-6">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-medium">Consumption vs. safety thresholds</h3>
              {surging > 0 && (
                <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-rose-600 dark:text-rose-400">
                  {surging} surging
                </span>
              )}
            </div>
            <ul className="mt-4 flex flex-col gap-5">
              {metered.map((reading) => (
                <UsageMeter key={reading.id} reading={reading} />
              ))}
              {metered.length === 0 && !loading && (
                <li className="text-sm text-muted-foreground">
                  No metered readings returned. Check that the API token carries Account Analytics:
                  Read.
                </li>
              )}
            </ul>
          </div>

          <CoverageGaps readings={gaps} />
        </div>
      )}
    </section>
  );
}
