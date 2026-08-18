/**
 * @fileoverview Per-probe detail table — every binding on one screen.
 *
 * Replaces the previous stack of identical progress bars. Rows are ordered by
 * severity (surging first, then percent-of-threshold descending) so the thing
 * that needs attention is always the first row, and unmetered probes sink to
 * the bottom rather than being hidden in a separate card — a governance panel
 * that silently drops a binding is worse than one that admits it cannot see it.
 *
 * Rewired onto the ReUI DataGrid (TanStack Table v9): sortable headers and
 * client search over the same severity-first default order. Every binding stays
 * on one screen (manualPagination — the data is already the page), so nothing
 * is ever paged out of view. Clicking a metered row still re-charts the trend.
 */

"use client";

import { type ColumnDef, useTable } from "@tanstack/react-table";
import { AlertTriangleIcon, SearchIcon } from "lucide-react";
import { useMemo, useState } from "react";

import {
  DataGrid,
  DataGridContainer,
  dataGridFeatures,
  type DataGridFeatures,
} from "@/components/reui/data-grid/data-grid";
import { DataGridColumnHeader } from "@/components/reui/data-grid/data-grid-column-header";
import { DataGridScrollArea } from "@/components/reui/data-grid/data-grid-scroll-area";
import { DataGridTable } from "@/components/reui/data-grid/data-grid-table";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { compactNumber, formatRatio, humanSize } from "@/lib/format";

export type TableReading = {
  id: string;
  label: string;
  product: string;
  bindings: string[];
  unit: string;
  status: "ok" | "not_metered" | "unavailable";
  value: number;
  alertThreshold: number | null;
  surging: boolean;
  error?: string;
};

function fmt(value: number, unit: string): string {
  return unit.includes("bytes") ? humanSize(value) : compactNumber(value);
}

/** Percent of threshold, or null when the probe has no threshold to measure against. */
function ratio(r: TableReading): number | null {
  if (r.status !== "ok" || !r.alertThreshold || r.alertThreshold <= 0) return null;
  return r.value / r.alertThreshold;
}

/** Severity rank — drives the default row order. Higher sorts first. */
function severity(r: TableReading): number {
  if (r.surging) return 1000;
  if (r.status !== "ok") return -1;
  return ratio(r) ?? 0;
}

type UsageBucket = "surging" | "over-threshold" | "ok" | "not-metered" | "unavailable";

const BUCKET_OPTIONS: { value: UsageBucket | "all"; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "surging", label: "Surging" },
  { value: "over-threshold", label: "Over threshold" },
  { value: "ok", label: "Healthy" },
  { value: "unavailable", label: "Unavailable" },
  { value: "not-metered", label: "Not metered" },
];

/**
 * Coarse status bucket a row falls into — a partition, so the toolbar filter
 * always adds up to the full set. "Over threshold" is the elevated band the
 * StatusBadge already tints amber (>=70% of the alert threshold).
 */
function bucket(r: TableReading): UsageBucket {
  if (r.status === "unavailable") return "unavailable";
  if (r.status !== "ok") return "not-metered";
  if (r.surging) return "surging";
  const pct = ratio(r);
  if (pct != null && pct >= 0.7) return "over-threshold";
  return "ok";
}

function StatusBadge({ reading }: { reading: TableReading }) {
  if (reading.status === "not_metered") {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        not metered
      </Badge>
    );
  }
  if (reading.status === "unavailable") {
    return (
      <Badge variant="outline" className="border-amber-500/25 text-amber-600 dark:text-amber-400">
        unavailable
      </Badge>
    );
  }
  if (reading.surging) {
    return (
      <Badge
        variant="outline"
        className="gap-1 border-rose-500/25 bg-rose-500/10 text-rose-600 dark:text-rose-400"
      >
        <AlertTriangleIcon className="size-3" />
        surging
      </Badge>
    );
  }
  const pct = ratio(reading);
  if (pct != null && pct >= 0.7) {
    return (
      <Badge
        variant="outline"
        className="border-amber-500/25 bg-amber-500/10 text-amber-600 dark:text-amber-400"
      >
        elevated
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
    >
      healthy
    </Badge>
  );
}

function LoadCell({ reading }: { reading: TableReading }) {
  const pct = ratio(reading);
  if (pct == null) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-foreground/[0.08]">
        <div
          className={`h-full rounded-full ${
            reading.surging ? "bg-rose-500" : pct >= 0.7 ? "bg-amber-500" : "bg-foreground/60"
          }`}
          style={{ width: `${Math.min(100, pct * 100)}%` }}
        />
      </div>
      <span className="w-10 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
        {reading.alertThreshold
          ? formatRatio(reading.value, reading.alertThreshold)
          : `${Math.round(pct * 100)}%`}
      </span>
    </div>
  );
}

export function UsageTable({
  readings,
  selectedId,
  onSelect,
}: {
  readings: TableReading[];
  selectedId?: string;
  onSelect?: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<UsageBucket | "all">("all");
  const [density, setDensity] = useState<"compact" | "comfortable">("compact");

  // Severity-first default order. TanStack preserves data order until a header
  // is clicked, so this stays the resting sort while every column is sortable.
  const sorted = useMemo(
    () => [...readings].sort((a, b) => severity(b) - severity(a)),
    [readings],
  );

  // Client-side status + search filters run BEFORE the array enters useTable,
  // so the grid only ever sees the rows the toolbar admits.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sorted.filter((r) => {
      if (statusFilter !== "all" && bucket(r) !== statusFilter) return false;
      if (!q) return true;
      return `${r.label} ${r.product} ${r.bindings.join(" ")} ${r.unit} ${r.status}`
        .toLowerCase()
        .includes(q);
    });
  }, [sorted, query, statusFilter]);

  const columns = useMemo<ColumnDef<DataGridFeatures, TableReading>[]>(
    () => [
      {
        accessorKey: "label",
        header: ({ column }) => <DataGridColumnHeader column={column} title="Binding" />,
        cell: ({ row }) => {
          const reading = row.original;
          return (
            <div className="flex flex-col gap-0.5">
              <span className="font-medium">{reading.label}</span>
              <span className="truncate font-mono text-[11px] text-muted-foreground">
                {reading.bindings.length === 0 ? "—" : reading.bindings.slice(0, 2).join(", ")}
                {reading.bindings.length > 2 && (
                  <span className="text-muted-foreground/60"> +{reading.bindings.length - 2}</span>
                )}
              </span>
            </div>
          );
        },
      },
      {
        accessorKey: "product",
        header: ({ column }) => <DataGridColumnHeader column={column} title="Product" />,
        cell: ({ row }) => <span className="text-muted-foreground">{row.original.product}</span>,
      },
      {
        id: "usage",
        accessorFn: (r) => (r.status === "ok" ? r.value : -1),
        header: ({ column }) => (
          <DataGridColumnHeader column={column} title="Usage" className="justify-end" />
        ),
        cell: ({ row }) => {
          const reading = row.original;
          return reading.status === "ok" ? (
            <div className="flex flex-col gap-0.5 text-right">
              <span className="font-medium tabular-nums">{fmt(reading.value, reading.unit)}</span>
              <span className="text-[11px] text-muted-foreground">{reading.unit}</span>
            </div>
          ) : (
            <span className="block text-right text-xs text-muted-foreground">
              {reading.status === "not_metered"
                ? "no analytics dataset"
                : (reading.error ?? "probe failed")}
            </span>
          );
        },
      },
      {
        id: "threshold",
        accessorFn: (r) => r.alertThreshold ?? -1,
        header: ({ column }) => (
          <DataGridColumnHeader column={column} title="Threshold" className="justify-end" />
        ),
        cell: ({ row }) => (
          <span className="block text-right tabular-nums text-muted-foreground">
            {row.original.alertThreshold
              ? fmt(row.original.alertThreshold, row.original.unit)
              : "—"}
          </span>
        ),
      },
      {
        id: "load",
        accessorFn: (r) => ratio(r) ?? -1,
        header: ({ column }) => <DataGridColumnHeader column={column} title="Load" />,
        cell: ({ row }) => <LoadCell reading={row.original} />,
        size: 180,
      },
      {
        id: "status",
        accessorFn: (r) => severity(r),
        header: ({ column }) => (
          <DataGridColumnHeader column={column} title="Status" className="justify-end" />
        ),
        cell: ({ row }) => (
          <div className="flex justify-end">
            <StatusBadge reading={row.original} />
          </div>
        ),
      },
    ],
    [],
  );

  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useTable({
    features: dataGridFeatures,
    // manualPagination keeps every binding on one screen: the data is already
    // the page, so the grid never slices to pageSize and drops a probe.
    manualPagination: true,
    data: filtered,
    columns,
    getRowId: (row) => row.id,
    enableRowSelection: true,
    state: { rowSelection: selectedId ? { [selectedId]: true } : {} },
  });

  return (
    <div className="overflow-hidden rounded-xl border border-border/60 bg-background/40">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border/60 px-5 py-4">
        <div>
          <h3 className="text-sm font-semibold">All bindings</h3>
          <p className="text-xs text-muted-foreground">
            Ordered by severity. Click a row to chart it above.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Select
            value={statusFilter}
            onValueChange={(v) => setStatusFilter(v as UsageBucket | "all")}
          >
            <SelectTrigger size="sm" className="w-36" aria-label="Filter by status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {BUCKET_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <ToggleGroup
            multiple={false}
            value={[density]}
            onValueChange={(v) => {
              const next = v[0] as "compact" | "comfortable" | undefined;
              if (next) setDensity(next);
            }}
            variant="outline"
            size="sm"
            spacing={0}
            aria-label="Row density"
          >
            <ToggleGroupItem value="compact" aria-label="Compact rows">
              Compact
            </ToggleGroupItem>
            <ToggleGroupItem value="comfortable" aria-label="Comfortable rows">
              Comfortable
            </ToggleGroupItem>
          </ToggleGroup>

          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              placeholder="Search bindings…"
              className="h-8 w-44 pl-8 text-sm"
            />
          </div>
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            {readings.filter((r) => r.status === "ok").length}/{readings.length} metered
          </span>
        </div>
      </div>

      <DataGrid
        table={table}
        recordCount={filtered.length}
        emptyMessage="No bindings match this search."
        onRowClick={(reading) => {
          // Only metered probes have a trend to chart; unmetered rows are inert.
          if (reading.status === "ok") onSelect?.(reading.id);
        }}
        tableLayout={{ dense: density === "compact", headerBorder: true, rowBorder: true, columnsVisibility: false }}
      >
        <DataGridContainer>
          <DataGridScrollArea>
            <DataGridTable />
          </DataGridScrollArea>
        </DataGridContainer>
      </DataGrid>
    </div>
  );
}
