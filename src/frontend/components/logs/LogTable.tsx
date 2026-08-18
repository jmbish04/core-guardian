/**
 * @fileoverview LogTable — the Level-3 (raw logs / detail rows) data grid.
 *
 * L3 ONLY. This is the heavy, faceted, high-cardinality grid for the raw-data
 * tier (log lines, audit rows, per-event tables). L1 (headline KPIs) and L2
 * (charts / summary panels) must NEVER import this — they use StatCards /
 * charts. Keeping it in `components/logs/` (not `components/dashboard/`) is the
 * physical firewall: nothing in the dashboard barrel can reach it by accident.
 *
 * It wraps the ReUI DataGrid (TanStack Table v9) + ReUI Filters builder and
 * gives you, out of the box: faceted multi-field filters, column show/hide,
 * density toggle, sortable headers, and pagination. Feed it `columns` + `data`
 * + a `filterFields` config and it does the rest — do not re-implement any of
 * filtering/sorting/pagination, that is exactly what the grid provides.
 *
 * Theming: chrome consumes `var(--color-*)` tokens via Tailwind utility classes
 * (`bg-card`, `text-muted-foreground`, `ring-border`) so it is correct in both
 * Monolith dark and light. Per house rule we separate with `ring-1 ring-border`
 * and `<Separator/>` (token-driven), never a raw 1px `border`.
 */

"use client";

import { useCallback, useMemo, useState, type ReactNode } from "react";
import {
  type ColumnDef,
  type PaginationState,
  type SortingState,
  useTable,
} from "@tanstack/react-table";
import { Settings2Icon, SlidersHorizontalIcon } from "lucide-react";

import {
  DataGrid,
  dataGridFeatures,
  type DataGridFeatures,
} from "@/components/reui/data-grid/data-grid";
import { DataGridColumnVisibility } from "@/components/reui/data-grid/data-grid-column-visibility";
import { DataGridPagination } from "@/components/reui/data-grid/data-grid-pagination";
import { DataGridScrollArea } from "@/components/reui/data-grid/data-grid-scroll-area";
import { DataGridTable } from "@/components/reui/data-grid/data-grid-table";
import {
  Filters,
  type Filter,
  type FilterFieldConfig,
} from "@/components/reui/filters";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

/** Filter values are strings/numbers coming off the filter builder. */
export type LogFilterValue = string | number;

export type LogTableDensity = "compact" | "comfortable";

const DENSITY_OPTIONS: { value: LogTableDensity; label: string }[] = [
  { value: "compact", label: "Compact" },
  { value: "comfortable", label: "Comfortable" },
];

const DEFAULT_PAGE_SIZES = [25, 50, 100, 200];

export interface LogTableProps<TData extends object> {
  /** Row data. For client-side mode this is the full set; the grid pages it. */
  data: TData[];
  /** v9 column defs — build headers with `DataGridColumnHeader` for sorting. */
  columns: ColumnDef<DataGridFeatures, TData>[];
  /** Faceted filter fields (select/text). Build with the Filters field config. */
  filterFields?: FilterFieldConfig<LogFilterValue>[];
  /** Initial active filters — build each with `createFilter(field, op, values)`. */
  initialFilters?: Filter<LogFilterValue>[];
  /**
   * How to read a field off a row for client-side filtering. Defaults to
   * `row[field]`. Override when the filter key does not map 1:1 to a column
   * (e.g. a "keyword" field that searches a concatenated blob).
   */
  filterAccessor?: (row: TData, field: string) => unknown;
  /** Stable row id (dedupe / selection). Defaults to the row index. */
  getRowId?: (row: TData) => string;
  initialSorting?: SortingState;
  pageSize?: number;
  pageSizes?: number[];
  /** Left-hand title/label rendered in the toolbar. */
  title?: ReactNode;
  /** Extra toolbar actions on the right (export, refresh, …). */
  actions?: ReactNode;
  emptyMessage?: string;
  className?: string;
}

/** Filters that are actually constraining (have a value or an empty/not-empty op). */
function activeFilters<V>(filters: Filter<V>[]): Filter<V>[] {
  return filters.filter(({ operator, values }) => {
    if (operator === "empty" || operator === "not_empty") return true;
    if (!values || values.length === 0) return false;
    return !values.every((v) => typeof v === "string" && v.trim() === "");
  });
}

/** Apply the filter builder's operators over the rows, client-side. */
function applyFilters<TData extends object>(
  data: TData[],
  filters: Filter<LogFilterValue>[],
  accessor: (row: TData, field: string) => unknown,
): TData[] {
  return activeFilters(filters).reduce((rows, { field, operator, values }) => {
    return rows.filter((row) => {
      const raw = accessor(row, field);
      const asStr = String(raw ?? "").toLowerCase();
      const has = (v: LogFilterValue) => raw === v || String(raw) === String(v);

      switch (operator) {
        case "is":
        case "is_any_of":
          return values.some(has);
        case "is_not":
        case "is_not_any_of":
          return !values.some(has);
        case "contains":
          return values.some((v) => asStr.includes(String(v).toLowerCase()));
        case "not_contains":
          return !values.some((v) => asStr.includes(String(v).toLowerCase()));
        case "starts_with":
          return values.some((v) => asStr.startsWith(String(v).toLowerCase()));
        case "ends_with":
          return values.some((v) => asStr.endsWith(String(v).toLowerCase()));
        case "empty":
          return asStr.length === 0;
        case "not_empty":
          return asStr.length > 0;
        default:
          return true;
      }
    });
  }, data);
}

const defaultAccessor = (row: object, field: string): unknown =>
  (row as Record<string, unknown>)[field];

export function LogTable<TData extends object>({
  data,
  columns,
  filterFields,
  initialFilters,
  filterAccessor = defaultAccessor,
  getRowId,
  initialSorting = [],
  pageSize = 50,
  pageSizes = DEFAULT_PAGE_SIZES,
  title,
  actions,
  emptyMessage = "No records match this view.",
  className,
}: LogTableProps<TData>) {
  const [filters, setFilters] = useState<Filter<LogFilterValue>[]>(
    initialFilters ?? [],
  );
  const [density, setDensity] = useState<LogTableDensity>("compact");
  const [sorting, setSorting] = useState<SortingState>(initialSorting);
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize,
  });

  const resetPage = useCallback(
    () =>
      setPagination((p) => (p.pageIndex === 0 ? p : { ...p, pageIndex: 0 })),
    [],
  );

  const filtered = useMemo(
    () => applyFilters(data, filters, filterAccessor),
    [data, filters, filterAccessor],
  );

  const handleFiltersChange = useCallback(
    (next: Filter<LogFilterValue>[]) => {
      setFilters(next);
      resetPage();
    },
    [resetPage],
  );

  // ponytail: columnVisibility is left uncontrolled so DataGridColumnVisibility's
  // toggles work without extra wiring; add controlled state only if a page needs
  // to persist column layout.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useTable({
    features: dataGridFeatures,
    data: filtered,
    columns,
    state: { sorting, pagination },
    onSortingChange: setSorting,
    onPaginationChange: setPagination,
    ...(getRowId ? { getRowId } : {}),
  });

  const hasFilters = Boolean(filterFields?.length);

  return (
    <DataGrid
      table={table}
      recordCount={filtered.length}
      emptyMessage={emptyMessage}
      tableLayout={{
        dense: density === "compact",
        rowBorder: true,
        headerSticky: true,
        width: "fixed",
        columnsResizable: true,
      }}
    >
      <div
        className={cn(
          "bg-card flex w-full flex-col overflow-hidden rounded-lg ring-1 ring-border/60",
          className,
        )}
      >
        {/* Toolbar */}
        <div className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between lg:px-4">
          <div className="flex min-w-0 items-center gap-2">
            <SlidersHorizontalIcon
              className="text-muted-foreground size-4 shrink-0"
              aria-hidden="true"
            />
            {title ? (
              <div className="text-foreground truncate text-sm font-medium">
                {title}
              </div>
            ) : null}
          </div>

          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Select
              value={density}
              onValueChange={(v) => setDensity(v as LogTableDensity)}
            >
              <SelectTrigger size="sm" className="w-[130px]" aria-label="Density">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {DENSITY_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <DataGridColumnVisibility
              table={table}
              trigger={
                <Button type="button" size="sm" variant="outline">
                  <Settings2Icon className="size-4" aria-hidden="true" />
                  Columns
                </Button>
              }
            />

            {actions}
          </div>
        </div>

        {hasFilters ? (
          <>
            <Separator />
            <div className="bg-muted/40 flex flex-wrap items-center gap-2 px-3 py-2.5 lg:px-4">
              <Filters
                filters={filters}
                fields={filterFields ?? []}
                onChange={handleFiltersChange}
                size="default"
                radius="default"
                menuPopupClassName="w-56"
              />
              {activeFilters(filters).length > 0 ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground"
                  onClick={() => handleFiltersChange([])}
                >
                  Clear all
                </Button>
              ) : null}
            </div>
          </>
        ) : null}

        <Separator />

        <DataGridScrollArea>
          <DataGridTable />
        </DataGridScrollArea>

        <Separator />

        <div className="px-3 py-3 lg:px-4">
          <DataGridPagination sizes={pageSizes} info="{from} - {to} of {count}" />
        </div>
      </div>
    </DataGrid>
  );
}
