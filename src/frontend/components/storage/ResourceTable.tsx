/**
 * @fileoverview Generic sortable + filterable resource table.
 *
 * Shared by every Data Storage page (R2, D1, KV, pipelines, catalogs) so
 * sorting, filtering, and the empty/loading states behave identically
 * everywhere. Columns declare how to render and how to sort themselves.
 */

"use client";

import { ArrowDownIcon, ArrowUpIcon, SearchIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export type Column<T> = {
  key: string;
  header: string;
  /** Cell renderer. */
  render: (row: T) => React.ReactNode;
  /** Sort value; omit to make the column unsortable. */
  sortValue?: (row: T) => number | string;
  className?: string;
  align?: "right";
};

export function ResourceTable<T>({
  rows,
  columns,
  /** Fields searched by the filter box. */
  searchText,
  initialSortKey,
  loading,
  empty = "Nothing here.",
  rowKey,
  onRowClick,
}: {
  rows: T[];
  columns: Column<T>[];
  searchText: (row: T) => string;
  initialSortKey?: string;
  loading?: boolean;
  empty?: string;
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
}) {
  const [filter, setFilter] = useState("");
  const [sortKey, setSortKey] = useState(initialSortKey ?? columns[0]?.key);
  const [descending, setDescending] = useState(true);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const filtered = needle
      ? rows.filter((row) => searchText(row).toLowerCase().includes(needle))
      : rows;

    const column = columns.find((c) => c.key === sortKey);
    if (!column?.sortValue) return filtered;

    return [...filtered].sort((a, b) => {
      const left = column.sortValue!(a);
      const right = column.sortValue!(b);
      const cmp =
        typeof left === "number" && typeof right === "number"
          ? left - right
          : String(left).localeCompare(String(right));
      return descending ? -cmp : cmp;
    });
  }, [rows, filter, sortKey, descending, columns, searchText]);

  return (
    <div className="flex flex-col gap-3">
      <div className="relative max-w-sm">
        <SearchIcon className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter…"
          className="pl-9"
        />
      </div>

      <div className="overflow-hidden rounded-xl border border-border/60 bg-background/40">
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((column) => {
                const sortable = Boolean(column.sortValue);
                const active = sortKey === column.key;
                return (
                  <TableHead
                    key={column.key}
                    className={`${column.className ?? ""} ${column.align === "right" ? "text-right" : ""}`}
                  >
                    {sortable ? (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 hover:text-foreground"
                        onClick={() => {
                          if (active) setDescending((d) => !d);
                          else {
                            setSortKey(column.key);
                            setDescending(true);
                          }
                        }}
                      >
                        {column.header}
                        {active &&
                          (descending ? (
                            <ArrowDownIcon className="size-3" />
                          ) : (
                            <ArrowUpIcon className="size-3" />
                          ))}
                      </button>
                    ) : (
                      column.header
                    )}
                  </TableHead>
                );
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((row) => (
              <TableRow
                key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={onRowClick ? "cursor-pointer" : undefined}
              >
                {columns.map((column) => (
                  <TableCell
                    key={column.key}
                    className={`${column.className ?? ""} ${column.align === "right" ? "text-right" : ""}`}
                  >
                    {column.render(row)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
            {visible.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="p-6 text-center text-sm text-muted-foreground"
                >
                  {loading ? "Loading…" : empty}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <p className="text-xs text-muted-foreground">
        {visible.length} of {rows.length} shown
      </p>
    </div>
  );
}

/** Renders the Workers bound to a resource, or an explicit "unbound" note. */
export function BoundWorkers({ workers }: { workers: { worker: string; binding: string }[] }) {
  if (workers.length === 0) {
    return <span className="text-xs text-muted-foreground/60">unbound</span>;
  }
  return (
    <div className="flex flex-col gap-0.5">
      {workers.slice(0, 3).map((w) => (
        <span key={`${w.worker}:${w.binding}`} className="font-mono text-xs">
          {w.worker}
          <span className="text-muted-foreground"> · {w.binding}</span>
        </span>
      ))}
      {workers.length > 3 && (
        <span className="text-xs text-muted-foreground">+{workers.length - 3} more</span>
      )}
    </div>
  );
}
