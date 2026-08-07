/**
 * @fileoverview Daily cost tracker — reconstructed USD per service per day with
 * a day-over-day delta, so a climbing cost line is visible against a flat one.
 *
 * Reads `GET /api/guardian/daily-cost`. Three surfaces:
 *   - Total reconstructed cost trend, with the latest day's change vs the prior.
 *   - Per-service table: latest cost, Δ vs yesterday, a cost sparkline, and the
 *     window total. Services with no known overage rate show raw usage only —
 *     never an invented dollar figure.
 *   - Workers AI attribution: the USD split gateway / registered / direct, where
 *     `direct` is inference that hit the raw Cloudflare AI API with no gateway
 *     and no registration — the endpoints still to migrate. Watching it fall is
 *     the migration progress bar. Plus the neuron split by model.
 *
 * Cloudflare has NO cost API; every dollar here is raw usage priced against the
 * scraped overage rates — an estimate, labelled as such, not a billed figure.
 */

"use client";

import { Loader2Icon, TrendingDownIcon, TrendingUpIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, XAxis } from "recharts";

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ApiError, apiGet } from "@/lib/api";
import { compactNumber } from "@/lib/format";

// --- Response types (mirror DailyCostReport) --------------------------------

type ServiceSeries = {
  service: string;
  product: string;
  unit: string;
  points: { day: string; rawUsage: number; costUsd: number | null }[];
  deltaUsd: number | null;
  totalUsd: number;
};
type AttributionDay = {
  day: string;
  reconstructedUsd: number;
  gatewayUsd: number;
  registeredUsd: number;
  directUsd: number;
  coverage: number | null;
};
type Report = {
  days: string[];
  services: ServiceSeries[];
  totalByDay: { day: string; costUsd: number }[];
  totalDeltaUsd: number | null;
  workersAiModels: {
    day: string;
    models: { model: string; neurons: number; costUsd: number | null }[];
  };
  workersAiAttribution: AttributionDay[];
};

// --- Formatting -------------------------------------------------------------

/** USD, cent-precise under $10, whole-dollar above — a table stays scannable. */
function usd(n: number): string {
  const abs = Math.abs(n);
  const digits = abs === 0 ? 0 : abs < 10 ? 2 : abs < 1000 ? 0 : 0;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}
/** Short weekday+day tick, e.g. "Jul 28". */
function dayTick(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

const CHART_CONFIG = {
  cost: { label: "Cost", color: "oklch(0.6 0.145 181.2)" },
} satisfies ChartConfig;

/** Colored ▲/▼ delta chip. Rising cost is bad (rose), falling is good (emerald). */
function DeltaChip({ delta }: { delta: number | null }) {
  if (delta == null) return <span className="text-muted-foreground/50">—</span>;
  if (Math.abs(delta) < 0.005) {
    return (
      <span className="font-mono text-[11px] tabular-nums text-muted-foreground/60">flat</span>
    );
  }
  const up = delta > 0;
  return (
    <span
      className={`inline-flex items-center gap-1 font-mono text-[11px] tabular-nums ${
        up ? "text-rose-600 dark:text-rose-400" : "text-emerald-600 dark:text-emerald-400"
      }`}
    >
      {up ? <TrendingUpIcon className="size-3" /> : <TrendingDownIcon className="size-3" />}
      {up ? "+" : "−"}
      {usd(Math.abs(delta))}
    </span>
  );
}

/**
 * Inline SVG cost sparkline — one lightweight polyline, no per-row chart.
 * A series with no real movement (a service that stayed ~$0 all window) draws a
 * muted flat line: rose/emerald is a verdict on a trend, and a flat $0 has none.
 */
function Sparkline({ values }: { values: (number | null)[] }) {
  const nums = values.map((v) => v ?? 0);
  if (nums.length < 2) return <div className="h-6" />;
  const max = Math.max(...nums, 0);
  const min = Math.min(...nums, 0);
  const span = max - min;
  const w = 96;
  const h = 24;
  const flat = span < 0.005; // effectively $0 or unchanging across the window
  const pts = nums
    .map((v, i) => {
      const x = (i / (nums.length - 1)) * w;
      const y = flat ? h - 1 : h - ((v - min) / span) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const rising = nums[nums.length - 1] >= nums[0];
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className="overflow-visible"
      aria-hidden="true"
    >
      <polyline
        points={pts}
        fill="none"
        strokeWidth={1.5}
        className={
          flat
            ? "stroke-muted-foreground/25"
            : rising
              ? "stroke-rose-500/80"
              : "stroke-emerald-500/80"
        }
      />
    </svg>
  );
}

export function DailyCost() {
  const [days, setDays] = useState(30);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setReport(await apiGet<Report>("/guardian/daily-cost", { days }));
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "Sign in to view daily cost."
          : err instanceof ApiError
            ? err.message
            : "Failed to load daily cost.",
      );
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalPoints = useMemo(
    () => report?.totalByDay.map((d) => ({ day: d.day, cost: d.costUsd })) ?? [],
    [report],
  );
  const latestTotal = totalPoints.length ? totalPoints[totalPoints.length - 1].cost : 0;
  const latestAttribution = report?.workersAiAttribution.at(-1);

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Daily cost tracker</h2>
          <p className="text-sm text-muted-foreground">
            Reconstructed USD per service per day · day-over-day change · estimate off scraped
            rates, not a billed figure
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-border/60 p-0.5">
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                days === d
                  ? "bg-foreground/[0.08] text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {d}d
            </button>
          ))}
        </div>
      </header>

      {error ? (
        <p className="rounded-xl border border-border/60 bg-background/40 p-4 text-sm text-muted-foreground">
          {error}
        </p>
      ) : loading && !report ? (
        <div className="flex h-40 items-center justify-center rounded-xl border border-border/60 bg-background/40">
          <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : !report || report.days.length === 0 ? (
        <p className="rounded-xl border border-border/60 bg-background/40 p-6 text-center text-sm text-muted-foreground">
          No daily cost recorded yet. It fills in as the hourly cron runs, or POST
          <code className="mx-1 font-mono">/api/guardian/daily-cost/snapshot</code> to backfill now.
        </p>
      ) : (
        <>
          {/* --- Total trend ------------------------------------------------- */}
          <div className="rounded-xl border border-border/60 bg-background/40 p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="flex items-baseline gap-3">
                <span className="text-2xl font-semibold tabular-nums">{usd(latestTotal)}</span>
                <span className="text-xs text-muted-foreground">latest day</span>
                <DeltaChip delta={report.totalDeltaUsd} />
              </div>
              <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                reconstructed / day
              </span>
            </div>
            {totalPoints.length >= 2 && (
              <ChartContainer config={CHART_CONFIG} className="mt-4 h-[200px] w-full">
                <AreaChart data={totalPoints} margin={{ left: 4, right: 4, top: 8, bottom: 0 }}>
                  <defs>
                    <linearGradient id="dailyCostFill" x1="0" y1="0" x2="0" y2="1">
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
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        labelFormatter={(_, p) => (p?.[0] ? dayTick(String(p[0].payload.day)) : "")}
                        formatter={(v) => usd(Number(v))}
                      />
                    }
                  />
                  <Area
                    type="monotone"
                    dataKey="cost"
                    stroke="var(--color-cost)"
                    strokeWidth={2}
                    fill="url(#dailyCostFill)"
                  />
                </AreaChart>
              </ChartContainer>
            )}
          </div>

          {/* --- Per-service table ------------------------------------------- */}
          <div className="overflow-hidden rounded-xl border border-border/60 bg-background/40">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="ps-4">Service</TableHead>
                  <TableHead className="text-right">Latest / day</TableHead>
                  <TableHead className="text-right">Δ vs prior</TableHead>
                  <TableHead className="w-28">Trend</TableHead>
                  <TableHead className="pe-4 text-right">{days}d total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.services.map((s) => {
                  const last = s.points.at(-1);
                  const priced = last?.costUsd != null;
                  return (
                    <TableRow key={s.service}>
                      <TableCell className="ps-4">
                        <div className="font-medium">{s.product}</div>
                        <div className="font-mono text-[10px] text-muted-foreground">
                          {s.service}
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {priced ? (
                          usd(last!.costUsd!)
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            {compactNumber(last?.rawUsage ?? 0)} {s.unit}
                            <span className="ms-1 text-muted-foreground/50">· no rate</span>
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <DeltaChip delta={s.deltaUsd} />
                      </TableCell>
                      <TableCell>
                        <Sparkline values={s.points.map((p) => p.costUsd)} />
                      </TableCell>
                      <TableCell className="pe-4 text-right tabular-nums">
                        {s.totalUsd > 0 ? (
                          usd(s.totalUsd)
                        ) : (
                          <span className="text-muted-foreground/50">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          {/* --- Workers AI attribution -------------------------------------- */}
          {latestAttribution && latestAttribution.reconstructedUsd > 0 && (
            <div className="rounded-xl border border-border/60 bg-background/40 p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-sm font-medium">Workers AI — where the spend originates</h3>
                <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                  latest day
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                <span className="font-semibold text-rose-600 dark:text-rose-400">
                  {usd(latestAttribution.directUsd)} direct
                </span>{" "}
                — inference hitting the raw Cloudflare API with no gateway and no registration.
                Route it through a gateway or this Worker&apos;s proxy to attribute it. Coverage:{" "}
                {latestAttribution.coverage != null
                  ? `${Math.round(latestAttribution.coverage * 100)}% attributed`
                  : "—"}
                .
              </p>
              {/* Stacked composition bar for the latest day */}
              <AttributionBar day={latestAttribution} />

              {/* Neuron split by model */}
              {report.workersAiModels.models.length > 0 && (
                <div className="mt-5">
                  <h4 className="text-xs font-medium text-muted-foreground">
                    Neuron burn by model · {dayTick(report.workersAiModels.day)}
                  </h4>
                  <ul className="mt-2 flex flex-col">
                    {report.workersAiModels.models.slice(0, 8).map((m) => (
                      <li
                        key={m.model}
                        className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-border/40 py-1.5 last:border-b-0"
                      >
                        <span className="truncate font-mono text-xs">{m.model}</span>
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {compactNumber(m.neurons)} neurons
                        </span>
                        <span className="w-16 text-right text-xs font-medium tabular-nums">
                          {m.costUsd != null ? usd(m.costUsd) : "—"}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** Stacked gateway / registered / direct bar for one day. */
function AttributionBar({ day }: { day: AttributionDay }) {
  const total = day.reconstructedUsd || 1;
  const segs = [
    { label: "Gateway", value: day.gatewayUsd, cls: "bg-emerald-500/70" },
    { label: "Registered / proxy", value: day.registeredUsd, cls: "bg-sky-500/70" },
    { label: "Direct / unattributed", value: day.directUsd, cls: "bg-rose-500/70" },
  ].filter((s) => s.value > 0);
  return (
    <div className="mt-4">
      <div className="flex h-3 overflow-hidden rounded-full bg-muted">
        {segs.map((s) => (
          <div
            key={s.label}
            className={s.cls}
            style={{ width: `${(s.value / total) * 100}%` }}
            title={`${s.label}: ${usd(s.value)}`}
          />
        ))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {segs.map((s) => (
          <li key={s.label} className="flex items-center gap-1.5 text-xs">
            <span aria-hidden="true" className={`size-2.5 rounded-full ${s.cls}`} />
            <span className="text-muted-foreground">{s.label}</span>
            <span className="font-medium tabular-nums">{usd(s.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
