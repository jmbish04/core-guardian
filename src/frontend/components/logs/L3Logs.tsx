/**
 * @fileoverview Level-3 log islands — the drill targets for the L2 detail charts.
 *
 * Each L2 point-click navigates to `/dashboard/<product>/logs?query=<key:value>`
 * (see `L2Details.tsx` / `AiRouterUsage.tsx` / `DailyCost.tsx`). These islands
 * are what those routes mount: fetch the ONE real endpoint that backs the L2
 * chart, shape its rows, seed the drilled filter, and hand it all to `<LogTable>`.
 * No grid/filter/pagination logic here — that is entirely `LogTable`'s job.
 *
 * Astro passes only the serializable `query` string; filter seeding happens
 * client-side via `seedFilters`.
 */

"use client";

import { useMemo } from "react";
import { type ColumnDef } from "@tanstack/react-table";

import { type DataGridFeatures } from "@/components/reui/data-grid/data-grid";
import { DataGridColumnHeader } from "@/components/reui/data-grid/data-grid-column-header";
import { type FilterFieldConfig } from "@/components/reui/filters";
import { LogTable, type LogFilterValue } from "@/components/logs/LogTable";
import {
  LogShell,
  OutcomeBadge,
  SeverityBadge,
  StatusBadge,
  dayKey,
  fin,
  seedFilters,
  useFetch,
} from "@/components/logs/l3";
import { compactNumber, relativeTime, shortDate, usd } from "@/lib/format";

type Cols<T extends object> = ColumnDef<DataGridFeatures, T>[];
type Fields = FilterFieldConfig<LogFilterValue>[];

const header = (title: string) =>
  function H({ column }: { column: any }) {
    return <DataGridColumnHeader column={column} title={title} />;
  };

const Mono = ({ children }: { children: React.ReactNode }) => (
  <span className="font-mono text-xs tabular-nums text-muted-foreground">{children}</span>
);

// --- backend response shapes (subset consumed) ------------------------------

type BillablePoint = { day: string; quantity: number; costUsd: number };
type BillableService = { service: string; family: string; unit: string; points: BillablePoint[] };
type BillableReport = { services: BillableService[] };

type DailyPoint = { day: string; rawUsage: number; costUsd: number | null };
type DailyService = { service: string; unit?: string; points: DailyPoint[] };
type DailyCostReport = { services: DailyService[] };

type UsageHistory = { history: { id: string; value: number; startTime: number; endTime: number }[] };

type RouterRequest = {
  id: string;
  at: number;
  project: string;
  importance: string;
  provider: string;
  model: string;
  mode: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  isError: boolean;
  isCircuitBreaker: boolean;
  errorMessage: string | null;
};

type AlertRow = {
  id: string;
  service: string;
  resource: string;
  severity: "info" | "warning" | "critical";
  cause: string;
  recommendation: string;
  status: "active" | "snoozed" | "resolved";
  createdAt: number;
};

// ---------------------------------------------------------------------------
// 1. D1 — per-day metered usage rows (drill: day:<YYYY-MM-DD>)
//    endpoint: /api/guardian/billable-usage → D1 service points
// ---------------------------------------------------------------------------

export function D1Logs({ query }: { query?: string }) {
  const { data, loading, error, reload } = useFetch<BillableReport>("/guardian/billable-usage", {
    days: 90,
  });
  const rows = useMemo(() => {
    const d1 = (data?.services ?? []).find((s) => /d1/i.test(s.service) || /d1/i.test(s.family));
    return (d1?.points ?? []).map((p) => ({
      day: p.day,
      unit: d1?.unit ?? "",
      quantity: fin(p.quantity),
      costUsd: fin(p.costUsd),
    }));
  }, [data]);

  const columns = useMemo<Cols<(typeof rows)[number]>>(
    () => [
      { accessorKey: "day", header: header("Day"), cell: ({ row }) => <Mono>{row.original.day}</Mono> },
      {
        accessorKey: "quantity",
        header: header("Rows (read + written)"),
        cell: ({ row }) => <span className="text-sm tabular-nums">{compactNumber(row.original.quantity)}</span>,
      },
      { accessorKey: "unit", header: header("Unit"), cell: ({ row }) => <span className="text-sm text-muted-foreground">{row.original.unit}</span> },
      {
        accessorKey: "costUsd",
        header: header("Metered cost"),
        cell: ({ row }) => <span className="text-sm tabular-nums">{usd(row.original.costUsd)}</span>,
      },
    ],
    [],
  );

  const fields: Fields = [{ key: "day", label: "Day", type: "text", defaultOperator: "is", placeholder: "YYYY-MM-DD" }];

  return (
    <LogShell loading={loading} error={error} onRetry={reload} empty={rows.length === 0}>
      <LogTable
        title="D1 metered usage · 90d"
        data={rows}
        columns={columns}
        filterFields={fields}
        initialFilters={seedFilters(query, ["day"])}
        getRowId={(r) => r.day}
        initialSorting={[{ id: "day", desc: true }]}
        emptyMessage="No metered D1 usage in this window — within the free allowance."
      />
    </LogShell>
  );
}

// ---------------------------------------------------------------------------
// 2. AI Gateway — request/usage log rows (drill: day:<YYYY-MM-DD>)
//    endpoint: /api/ai-gateway/billing/usage-history
// ---------------------------------------------------------------------------

export function AiGatewayLogs({ query }: { query?: string }) {
  const { data, loading, error, reload } = useFetch<UsageHistory>("/ai-gateway/billing/usage-history", {
    days: 90,
    window: "day",
  });
  const rows = useMemo(
    () =>
      (data?.history ?? []).map((h) => ({
        id: h.id,
        day: dayKey(h.startTime),
        startTime: fin(h.startTime),
        endTime: fin(h.endTime),
        value: fin(h.value),
      })),
    [data],
  );

  const columns = useMemo<Cols<(typeof rows)[number]>>(
    () => [
      { accessorKey: "day", header: header("Day"), cell: ({ row }) => <Mono>{row.original.day}</Mono> },
      {
        accessorKey: "startTime",
        header: header("Window start"),
        cell: ({ row }) => <Mono>{shortDate(row.original.startTime)}</Mono>,
      },
      {
        accessorKey: "value",
        header: header("Metered units"),
        cell: ({ row }) => <span className="text-sm tabular-nums">{compactNumber(row.original.value)}</span>,
      },
    ],
    [],
  );

  const fields: Fields = [{ key: "day", label: "Day", type: "text", defaultOperator: "is", placeholder: "YYYY-MM-DD" }];

  return (
    <LogShell loading={loading} error={error} onRetry={reload} empty={rows.length === 0}>
      <LogTable
        title="AI Gateway metered usage · 90d"
        data={rows}
        columns={columns}
        filterFields={fields}
        initialFilters={seedFilters(query, ["day"])}
        getRowId={(r) => r.id}
        initialSorting={[{ id: "startTime", desc: true }]}
        emptyMessage="No AI Gateway usage recorded in this window."
      />
    </LogShell>
  );
}

// ---------------------------------------------------------------------------
// 3. AI Router — per-request routing/substitution event log (drill: project:<p>)
//    endpoint: /api/ai-router/requests
// ---------------------------------------------------------------------------

export function AiRouterLogs({ query }: { query?: string }) {
  const { data, loading, error, reload } = useFetch<{ requests: RouterRequest[] }>("/ai-router/requests", {
    limit: 200,
  });
  const rows = data?.requests ?? [];

  const columns = useMemo<Cols<RouterRequest>>(
    () => [
      { accessorKey: "at", header: header("Time"), cell: ({ row }) => <Mono>{relativeTime(row.original.at)}</Mono> },
      { accessorKey: "project", header: header("Project"), cell: ({ row }) => <span className="font-mono text-xs">{row.original.project}</span> },
      { accessorKey: "provider", header: header("Provider"), cell: ({ row }) => <span className="text-sm">{row.original.provider}</span> },
      { accessorKey: "model", header: header("Model"), cell: ({ row }) => <span className="font-mono text-xs">{row.original.model}</span> },
      { accessorKey: "mode", header: header("Mode"), cell: ({ row }) => <span className="text-sm text-muted-foreground">{row.original.mode}</span> },
      {
        accessorKey: "tokensIn",
        header: header("Tokens (in / out)"),
        cell: ({ row }) => (
          <span className="text-sm tabular-nums text-muted-foreground">
            {compactNumber(fin(row.original.tokensIn))} / {compactNumber(fin(row.original.tokensOut))}
          </span>
        ),
      },
      { accessorKey: "costUsd", header: header("Cost"), cell: ({ row }) => <span className="text-sm tabular-nums">{usd(fin(row.original.costUsd))}</span> },
      {
        id: "outcome",
        accessorFn: (r) => (r.isCircuitBreaker ? "circuit" : r.isError ? "error" : "ok"),
        header: header("Outcome"),
        cell: ({ row }) => (
          <OutcomeBadge isError={row.original.isError} isCircuitBreaker={row.original.isCircuitBreaker} />
        ),
      },
    ],
    [],
  );

  const fields: Fields = [
    { key: "project", label: "Project", type: "text", defaultOperator: "is", placeholder: "Project…" },
    { key: "provider", label: "Provider", type: "text", defaultOperator: "contains", placeholder: "Provider…" },
    { key: "model", label: "Model", type: "text", defaultOperator: "contains", placeholder: "Model…" },
    {
      key: "outcome",
      label: "Outcome",
      type: "select",
      defaultOperator: "is",
      options: [
        { value: "ok", label: "OK" },
        { value: "error", label: "Error" },
        { value: "circuit", label: "Circuit broken" },
      ],
    },
  ];

  return (
    <LogShell loading={loading} error={error} onRetry={reload} empty={rows.length === 0}>
      <LogTable
        title="AI Router requests · latest 200"
        data={rows}
        columns={columns}
        filterFields={fields}
        filterAccessor={(r, f) =>
          f === "outcome"
            ? r.isCircuitBreaker
              ? "circuit"
              : r.isError
                ? "error"
                : "ok"
            : (r as Record<string, unknown>)[f]
        }
        initialFilters={seedFilters(query, ["project"])}
        getRowId={(r) => r.id}
        initialSorting={[{ id: "at", desc: true }]}
        emptyMessage="No AI Router requests recorded yet."
      />
    </LogShell>
  );
}

// ---------------------------------------------------------------------------
// 4. Cost basis — billable-usage rows across every service (drill: day:<d>)
//    endpoint: /api/guardian/billable-usage
// ---------------------------------------------------------------------------

export function CostBasisLogs({ query }: { query?: string }) {
  const { data, loading, error, reload } = useFetch<BillableReport>("/guardian/billable-usage", { days: 90 });
  const rows = useMemo(
    () =>
      (data?.services ?? []).flatMap((s) =>
        s.points.map((p, i) => ({
          id: `${s.service}-${p.day}-${i}`,
          day: p.day,
          service: s.service,
          family: s.family,
          unit: s.unit,
          quantity: fin(p.quantity),
          costUsd: fin(p.costUsd),
        })),
      ),
    [data],
  );

  const columns = useMemo<Cols<(typeof rows)[number]>>(
    () => [
      { accessorKey: "day", header: header("Day"), cell: ({ row }) => <Mono>{row.original.day}</Mono> },
      { accessorKey: "service", header: header("Service"), cell: ({ row }) => <span className="text-sm">{row.original.service}</span> },
      { accessorKey: "family", header: header("Family"), cell: ({ row }) => <span className="text-sm text-muted-foreground">{row.original.family}</span> },
      {
        accessorKey: "quantity",
        header: header("Quantity"),
        cell: ({ row }) => (
          <span className="text-sm tabular-nums text-muted-foreground">
            {compactNumber(row.original.quantity)} {row.original.unit}
          </span>
        ),
      },
      { accessorKey: "costUsd", header: header("Billed"), cell: ({ row }) => <span className="text-sm tabular-nums">{usd(row.original.costUsd)}</span> },
    ],
    [],
  );

  const fields: Fields = [
    { key: "day", label: "Day", type: "text", defaultOperator: "is", placeholder: "YYYY-MM-DD" },
    { key: "service", label: "Service", type: "text", defaultOperator: "contains", placeholder: "Service…" },
  ];

  return (
    <LogShell loading={loading} error={error} onRetry={reload} empty={rows.length === 0}>
      <LogTable
        title="Billable usage rows · 90d"
        data={rows}
        columns={columns}
        filterFields={fields}
        initialFilters={seedFilters(query, ["day"])}
        getRowId={(r) => r.id}
        initialSorting={[{ id: "day", desc: true }]}
        emptyMessage="No billable usage rows in this window."
      />
    </LogShell>
  );
}

// ---------------------------------------------------------------------------
// 5. Daily cost — reconstructed per-service cost rows (drill: day:<d>)
//    endpoint: /api/guardian/daily-cost
// ---------------------------------------------------------------------------

export function DailyCostLogs({ query }: { query?: string }) {
  const { data, loading, error, reload } = useFetch<DailyCostReport>("/guardian/daily-cost", { days: 90 });
  const rows = useMemo(
    () =>
      (data?.services ?? []).flatMap((s) =>
        s.points.map((p, i) => ({
          id: `${s.service}-${p.day}-${i}`,
          day: p.day,
          service: s.service,
          rawUsage: fin(p.rawUsage),
          costUsd: fin(p.costUsd),
        })),
      ),
    [data],
  );

  const columns = useMemo<Cols<(typeof rows)[number]>>(
    () => [
      { accessorKey: "day", header: header("Day"), cell: ({ row }) => <Mono>{row.original.day}</Mono> },
      { accessorKey: "service", header: header("Service"), cell: ({ row }) => <span className="text-sm">{row.original.service}</span> },
      {
        accessorKey: "rawUsage",
        header: header("Raw usage"),
        cell: ({ row }) => <span className="text-sm tabular-nums text-muted-foreground">{compactNumber(row.original.rawUsage)}</span>,
      },
      { accessorKey: "costUsd", header: header("Est. cost"), cell: ({ row }) => <span className="text-sm tabular-nums">{usd(row.original.costUsd)}</span> },
    ],
    [],
  );

  const fields: Fields = [
    { key: "day", label: "Day", type: "text", defaultOperator: "is", placeholder: "YYYY-MM-DD" },
    { key: "service", label: "Service", type: "text", defaultOperator: "contains", placeholder: "Service…" },
  ];

  return (
    <LogShell loading={loading} error={error} onRetry={reload} empty={rows.length === 0}>
      <LogTable
        title="Reconstructed daily cost rows · 90d"
        data={rows}
        columns={columns}
        filterFields={fields}
        initialFilters={seedFilters(query, ["day"])}
        getRowId={(r) => r.id}
        initialSorting={[{ id: "day", desc: true }]}
        emptyMessage="No reconstructed cost rows yet — run a daily-cost snapshot to backfill."
      />
    </LogShell>
  );
}

// ---------------------------------------------------------------------------
// 6. Alerts — the anomaly/advisory log (drill: day:<d>)
//    endpoint: /api/guardian/alerts  (the feed the L2 severity trend is built from)
// ---------------------------------------------------------------------------

export function AlertsLogs({ query }: { query?: string }) {
  const { data, loading, error, reload } = useFetch<{ alerts: AlertRow[] }>("/guardian/alerts", {
    status: "all",
  });
  const rows = useMemo(
    () => (data?.alerts ?? []).map((a) => ({ ...a, day: dayKey(a.createdAt) })),
    [data],
  );

  const columns = useMemo<Cols<(typeof rows)[number]>>(
    () => [
      {
        accessorKey: "createdAt",
        header: header("Time"),
        cell: ({ row }) => (
          <div className="font-mono text-xs tabular-nums text-muted-foreground">
            <div className="text-foreground/80">{relativeTime(row.original.createdAt)}</div>
            <div>{row.original.day}</div>
          </div>
        ),
      },
      { accessorKey: "severity", header: header("Severity"), cell: ({ row }) => <SeverityBadge value={row.original.severity} /> },
      { accessorKey: "service", header: header("Resource"), cell: ({ row }) => <span className="font-mono text-xs">{row.original.resource || row.original.service}</span> },
      { accessorKey: "cause", header: header("Cause"), cell: ({ row }) => <span className="text-sm text-muted-foreground">{row.original.cause}</span> },
      { accessorKey: "recommendation", header: header("Fix"), cell: ({ row }) => <span className="text-sm text-muted-foreground">{row.original.recommendation}</span> },
      { accessorKey: "status", header: header("Status"), cell: ({ row }) => <StatusBadge value={row.original.status} /> },
    ],
    [],
  );

  const fields: Fields = [
    { key: "day", label: "Day", type: "text", defaultOperator: "is", placeholder: "YYYY-MM-DD" },
    {
      key: "severity",
      label: "Severity",
      type: "select",
      defaultOperator: "is",
      options: [
        { value: "critical", label: "Critical" },
        { value: "warning", label: "Warning" },
        { value: "info", label: "Info" },
      ],
    },
    {
      key: "status",
      label: "Status",
      type: "select",
      defaultOperator: "is",
      options: [
        { value: "active", label: "Active" },
        { value: "snoozed", label: "Snoozed" },
        { value: "resolved", label: "Resolved" },
      ],
    },
  ];

  return (
    <LogShell loading={loading} error={error} onRetry={reload} empty={rows.length === 0}>
      <LogTable
        title="Guardian alerts · anomaly log"
        data={rows}
        columns={columns}
        filterFields={fields}
        initialFilters={seedFilters(query, ["day"])}
        getRowId={(r) => r.id}
        initialSorting={[{ id: "createdAt", desc: true }]}
        emptyMessage="No alerts recorded yet."
      />
    </LogShell>
  );
}
