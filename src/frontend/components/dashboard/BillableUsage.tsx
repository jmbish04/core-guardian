/**
 * @fileoverview Billable usage — the one cost surface backed by ground truth.
 *
 * Every other dollar on this dashboard is reconstructed: raw usage priced
 * against scraped overage rates ({@link ./DailyCost}). This panel reads
 * `GET /api/guardian/billable-usage`, sourced from Cloudflare's Billable Usage
 * API — the actual charged amount per product — and turns it into three reads:
 *
 *   - Reconciliation: the estimate and the real bill drawn on one axis, so the
 *     gap between the two lines is the drift you can see. A window accuracy
 *     figure grades every reconstructed number the rest of the panel shows.
 *   - Per-product table: what Cloudflare actually charged, largest first, with
 *     the day-over-day change and a cost trend per line.
 *
 * The estimate series is intentionally the quiet one (dashed, muted); the bill
 * is the authoritative one (solid, weighted). The design says which to trust.
 */

"use client";

import { type ColumnDef, type ExpandedState, useTable } from "@tanstack/react-table";
import { Loader2Icon, SearchIcon, TrendingDownIcon, TrendingUpIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, XAxis } from "recharts";

import { lookupBillable } from "@/shared/billable-catalog";

import {
  DataGrid,
  DataGridContainer,
  dataGridFeatures,
  type DataGridFeatures,
} from "@/components/reui/data-grid/data-grid";
import { DataGridScrollArea } from "@/components/reui/data-grid/data-grid-scroll-area";
import {
  DataGridTable,
  DataGridTableFootRow,
  DataGridTableFootRowCell,
  DataGridTableRowExpand,
} from "@/components/reui/data-grid/data-grid-table";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Input } from "@/components/ui/input";
import { ApiError, apiGet } from "@/lib/api";

// --- Response types (mirror BillableUsageReport) ----------------------------

type ServiceSeries = {
  service: string;
  family: string;
  unit: string;
  points: { day: string; quantity: number; costUsd: number }[];
  deltaUsd: number | null;
  totalUsd: number;
};
type ReconcileDay = {
  day: string;
  estimateUsd: number;
  actualUsd: number;
  deltaUsd: number;
  accuracy: number | null;
};
type Report = {
  currency: string;
  days: string[];
  services: ServiceSeries[];
  totalByDay: { day: string; costUsd: number }[];
  totalActualUsd: number;
  totalDeltaUsd: number | null;
  reconcile: ReconcileDay[];
  windowAccuracy: number | null;
};

// --- Grid row shapes (product parent → per-day child) -----------------------

type DayPoint = { day: string; quantity: number; costUsd: number };
type ServiceRow = { kind: "service"; id: string; service: ServiceSeries; subRows: BillRow[] };
type DayRow = { kind: "day"; id: string; unit: string; point: DayPoint };
type BillRow = ServiceRow | DayRow;

// --- Formatting (matches the DailyCost sibling so the two panels read alike) -

/** USD, cent-precise under $10, whole-dollar above — a table stays scannable. */
function usd(n: number): string {
  const abs = Math.abs(n);
  const digits = abs !== 0 && abs < 10 ? 2 : 0;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}
/** Short month+day tick, e.g. "Jul 28". */
function dayTick(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

const CHART_CONFIG = {
  actual: { label: "Billed", color: "oklch(0.6 0.145 181.2)" },
  estimate: { label: "Estimate", color: "oklch(0.68 0.02 250)" },
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
 * A series with no real movement (a product billed ~$0 all window) draws a
 * muted flat line: rose/emerald is a verdict on a trend, and $0 has none.
 */
function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <div className="h-6" />;
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const span = max - min;
  const w = 96;
  const h = 24;
  const flat = span < 0.005; // effectively $0 or unchanging across the window
  const pts = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = flat ? h - 1 : h - ((v - min) / span) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const rising = values[values.length - 1] >= values[0];
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="overflow-visible" aria-hidden="true">
      <polyline
        points={pts}
        fill="none"
        strokeWidth={1.5}
        className={
          flat ? "stroke-muted-foreground/25" : rising ? "stroke-rose-500/80" : "stroke-emerald-500/80"
        }
      />
    </svg>
  );
}

/**
 * Accuracy readout: the estimate's grade against the real bill. Tinted from the
 * value (near-perfect emerald → drifting amber → far-off rose), never a bare
 * gray percent — the color is the at-a-glance verdict.
 */
function accuracyTone(a: number): string {
  if (a >= 0.9) return "text-emerald-600 dark:text-emerald-400";
  if (a >= 0.75) return "text-amber-600 dark:text-amber-400";
  return "text-rose-600 dark:text-rose-400";
}

/** Right-aligned column header label (these columns are read-only, not sorted). */
function RightHeader({ children }: { children: React.ReactNode }) {
  return <span className="block text-right">{children}</span>;
}

const BILL_COLUMNS: ColumnDef<DataGridFeatures, BillRow>[] = [
  {
    id: "product",
    header: "Product",
    enableSorting: false,
    cell: ({ row }) => {
      const r = row.original;
      return (
        <div className="flex items-center gap-1">
          <DataGridTableRowExpand row={row} />
          {r.kind === "service" ? (
            <div className="min-w-0">
              <div className="truncate font-medium">{r.service.service}</div>
              {(() => {
                const cat = lookupBillable(r.service.service);
                if (cat) {
                  return (
                    <div
                      className="mt-0.5 max-w-md text-[11px] leading-4 text-muted-foreground"
                      title={`Reduce it: ${cat.lever}`}
                    >
                      <span className="text-foreground/70">Caused by:</span> {cat.action}
                    </div>
                  );
                }
                return (
                  r.service.family && (
                    <div className="font-mono text-[10px] text-muted-foreground">
                      {r.service.family}
                    </div>
                  )
                );
              })()}
            </div>
          ) : (
            <span className="font-mono text-xs text-muted-foreground">{dayTick(r.point.day)}</span>
          )}
        </div>
      );
    },
  },
  {
    id: "latest",
    header: () => <RightHeader>Latest / day</RightHeader>,
    enableSorting: false,
    cell: ({ row }) => {
      const r = row.original;
      const cost = r.kind === "service" ? (r.service.points.at(-1)?.costUsd ?? 0) : r.point.costUsd;
      return <span className="block text-right font-mono text-xs tabular-nums">{usd(cost)}</span>;
    },
  },
  {
    id: "delta",
    header: () => <RightHeader>Δ vs prior</RightHeader>,
    enableSorting: false,
    cell: ({ row }) => {
      const r = row.original;
      if (r.kind === "service") {
        return (
          <div className="flex justify-end">
            <DeltaChip delta={r.service.deltaUsd} />
          </div>
        );
      }
      return (
        <span className="block text-right font-mono text-[11px] tabular-nums text-muted-foreground">
          {r.point.quantity.toLocaleString("en-US")} {r.unit}
        </span>
      );
    },
  },
  {
    id: "trend",
    header: "Trend",
    enableSorting: false,
    size: 112,
    cell: ({ row }) =>
      row.original.kind === "service" ? (
        <Sparkline values={row.original.service.points.map((p) => p.costUsd)} />
      ) : null,
  },
  {
    id: "total",
    header: () => <RightHeader>Billed</RightHeader>,
    enableSorting: false,
    cell: ({ row }) => {
      const r = row.original;
      if (r.kind !== "service") return null;
      return (
        <span className="block text-right font-mono text-xs tabular-nums">
          {r.service.totalUsd > 0 ? (
            usd(r.service.totalUsd)
          ) : (
            <span className="text-muted-foreground/50">$0</span>
          )}
        </span>
      );
    },
  },
];

export function BillableUsage() {
  const [days, setDays] = useState(30);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<ExpandedState>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setReport(await apiGet<Report>("/guardian/billable-usage", { days }));
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "Sign in to view billed usage."
          : err instanceof ApiError
            ? err.message
            : "Failed to load billed usage.",
      );
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  // Merge the billed total and the reconstructed estimate onto one day axis so
  // the two lines share a scale and their gap reads as drift.
  const chartData = useMemo(() => {
    if (!report) return [];
    const est = new Map(report.reconcile.map((r) => [r.day, r.estimateUsd]));
    return report.totalByDay.map((d) => ({
      day: d.day,
      actual: d.costUsd,
      estimate: est.get(d.day) ?? null,
    }));
  }, [report]);

  const latestActual = report?.totalByDay.at(-1)?.costUsd ?? 0;
  const acc = report?.windowAccuracy ?? null;

  // Product rows carry their per-day points as expandable children, largest
  // billed first (the backend already orders services that way).
  const rows = useMemo<BillRow[]>(() => {
    if (!report) return [];
    const q = query.trim().toLowerCase();
    return report.services
      .filter((s) => !q || `${s.service} ${s.family}`.toLowerCase().includes(q))
      .map((s) => ({
        kind: "service" as const,
        id: s.service,
        service: s,
        subRows: s.points.map((point) => ({
          kind: "day" as const,
          id: `${s.service}:${point.day}`,
          unit: s.unit,
          point,
        })),
      }));
  }, [report, query]);

  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useTable({
    features: dataGridFeatures,
    // Every product on one screen; expansion adds the day rows in place.
    manualPagination: true,
    data: rows,
    columns: BILL_COLUMNS,
    getRowId: (row) => row.id,
    getSubRows: (row) => (row.kind === "service" ? row.subRows : undefined),
    getRowCanExpand: (row) =>
      row.original.kind === "service" && row.original.subRows.length > 0,
    state: { expanded },
    onExpandedChange: setExpanded,
  });

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Billable usage</h2>
          <p className="text-sm text-muted-foreground">
            What Cloudflare actually charged, per product — the ground truth every estimate on this
            page is measured against
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
          No billed usage synced yet. It fills in daily from the Billable Usage API, or POST
          <code className="mx-1 font-mono">/api/guardian/billable-usage/sync</code> to pull it now.
        </p>
      ) : (
        <>
          {/* --- Reconciliation: estimate vs the real bill ------------------- */}
          <div className="rounded-xl border border-border/60 bg-background/40 p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex items-baseline gap-3">
                <span className="text-2xl font-semibold tabular-nums">{usd(latestActual)}</span>
                <span className="text-xs text-muted-foreground">billed · latest day</span>
                <DeltaChip delta={report.totalDeltaUsd} />
              </div>
              {acc != null && (
                <div className="text-right">
                  <div className={`text-2xl font-semibold tabular-nums ${accuracyTone(acc)}`}>
                    {Math.round(acc * 100)}%
                  </div>
                  <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                    estimate accuracy · {days}d
                  </div>
                </div>
              )}
            </div>

            {chartData.length >= 2 && (
              <ChartContainer config={CHART_CONFIG} className="mt-4 h-[220px] w-full">
                <LineChart data={chartData} margin={{ left: 4, right: 4, top: 8, bottom: 0 }}>
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
                        formatter={(v, name) => (
                          <span className="flex w-full items-center justify-between gap-3">
                            <span className="text-muted-foreground">
                              {name === "actual" ? "Billed" : "Estimate"}
                            </span>
                            <span className="font-mono font-medium tabular-nums">
                              {usd(Number(v))}
                            </span>
                          </span>
                        )}
                      />
                    }
                  />
                  {/* Estimate first so the authoritative billed line draws on top. */}
                  <Line
                    type="monotone"
                    dataKey="estimate"
                    stroke="var(--color-estimate)"
                    strokeWidth={1.5}
                    strokeDasharray="4 4"
                    dot={false}
                    connectNulls
                  />
                  <Line
                    type="monotone"
                    dataKey="actual"
                    stroke="var(--color-actual)"
                    strokeWidth={2.5}
                    dot={false}
                  />
                </LineChart>
              </ChartContainer>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5">
              <span className="flex items-center gap-2 text-xs">
                <span aria-hidden="true" className="h-0.5 w-5 rounded-full bg-[var(--color-actual)]" />
                <span className="text-muted-foreground">Billed</span>
                <span className="font-medium tabular-nums">{usd(report.totalActualUsd)}</span>
              </span>
              <span className="flex items-center gap-2 text-xs">
                <span
                  aria-hidden="true"
                  className="h-0 w-5 border-t-2 border-dashed border-[var(--color-estimate)]"
                />
                <span className="text-muted-foreground">Reconstructed estimate</span>
              </span>
              <span className="ms-auto text-xs text-muted-foreground/70">
                {report.currency} · billed daily by Cloudflare
              </span>
            </div>
          </div>

          {/* --- Per-product billed table (expand a row for its daily points) - */}
          <div className="overflow-hidden rounded-xl border border-border/60 bg-background/40">
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border/60 px-4 py-3">
              <h3 className="text-sm font-semibold">
                Per-product · {days}d billed
                <span className="ms-2 font-normal text-muted-foreground">
                  expand a product for its daily points
                </span>
              </h3>
              <div className="relative">
                <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.currentTarget.value)}
                  placeholder="Search products…"
                  className="h-8 w-44 pl-8 text-sm"
                />
              </div>
            </div>

            <DataGrid
              table={table}
              recordCount={rows.length}
              emptyMessage="No products match this search."
              tableLayout={{ dense: true, headerBorder: true, rowBorder: true, columnsVisibility: false }}
              tableClassNames={{
                footer: "border-t border-border/60",
              }}
            >
              <DataGridContainer>
                <DataGridScrollArea>
                  <DataGridTable
                    footerContent={
                      <DataGridTableFootRow>
                        <DataGridTableFootRowCell>Total billed</DataGridTableFootRowCell>
                        <DataGridTableFootRowCell className="text-right font-mono text-xs tabular-nums">
                          {usd(latestActual)}
                        </DataGridTableFootRowCell>
                        <DataGridTableFootRowCell className="text-right">
                          <DeltaChip delta={report.totalDeltaUsd} />
                        </DataGridTableFootRowCell>
                        <DataGridTableFootRowCell />
                        <DataGridTableFootRowCell className="text-right font-mono text-xs tabular-nums">
                          {usd(report.totalActualUsd)}
                        </DataGridTableFootRowCell>
                      </DataGridTableFootRow>
                    }
                  />
                </DataGridScrollArea>
              </DataGridContainer>
            </DataGrid>
          </div>
        </>
      )}
    </section>
  );
}
