/**
 * @fileoverview Minimal LogTable usage stub (L3).
 *
 * Reference wiring only — NOT a page. G6 builds the real log pages against live
 * `/api/...` data. This shows the three things a caller supplies: v9 columns
 * with sortable `DataGridColumnHeader`s, a faceted `filterFields` config, and
 * initial filters via `createFilter`. Hydrate it as a React island from an
 * Astro page with `client:visible`.
 */

"use client";

import { useMemo } from "react";
import { type ColumnDef } from "@tanstack/react-table";

import { type DataGridFeatures } from "@/components/reui/data-grid/data-grid";
import { DataGridColumnHeader } from "@/components/reui/data-grid/data-grid-column-header";
import {
  createFilter,
  type FilterFieldConfig,
} from "@/components/reui/filters";
import { Badge } from "@/components/ui/badge";
import { LogTable, type LogFilterValue } from "@/components/logs/LogTable";

type LogRow = {
  id: string;
  ts: string;
  level: "info" | "warn" | "error";
  source: string;
  message: string;
};

const LEVEL_VARIANT: Record<LogRow["level"], "secondary" | "warning" | "destructive"> = {
  info: "secondary",
  warn: "warning",
  error: "destructive",
};

// ponytail: static sample rows — this is a wiring stub, G6 swaps in `/api/logs`.
const SAMPLE: LogRow[] = [
  { id: "1", ts: "2026-08-17T09:01:12Z", level: "info", source: "ai-router", message: "route hit gpt-oss-120b" },
  { id: "2", ts: "2026-08-17T09:02:03Z", level: "warn", source: "d1", message: "query near 100-param limit" },
  { id: "3", ts: "2026-08-17T09:03:44Z", level: "error", source: "zones-sync", message: "empty /zones response" },
];

export function LogTableExample() {
  const columns = useMemo<ColumnDef<DataGridFeatures, LogRow>[]>(
    () => [
      {
        accessorKey: "ts",
        header: ({ column }) => <DataGridColumnHeader column={column} title="Time" />,
        cell: ({ row }) => (
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            {row.original.ts}
          </span>
        ),
      },
      {
        accessorKey: "level",
        header: ({ column }) => <DataGridColumnHeader column={column} title="Level" />,
        cell: ({ row }) => (
          <Badge variant={LEVEL_VARIANT[row.original.level]} className="capitalize">
            {row.original.level}
          </Badge>
        ),
      },
      {
        accessorKey: "source",
        header: ({ column }) => <DataGridColumnHeader column={column} title="Source" />,
        cell: ({ row }) => <span className="text-sm">{row.original.source}</span>,
      },
      {
        accessorKey: "message",
        header: ({ column }) => <DataGridColumnHeader column={column} title="Message" />,
        cell: ({ row }) => (
          <span className="truncate text-sm text-muted-foreground">{row.original.message}</span>
        ),
      },
    ],
    [],
  );

  const filterFields = useMemo<FilterFieldConfig<LogFilterValue>[]>(
    () => [
      {
        key: "level",
        label: "Level",
        type: "select",
        defaultOperator: "is",
        options: [
          { value: "info", label: "Info" },
          { value: "warn", label: "Warn" },
          { value: "error", label: "Error" },
        ],
      },
      {
        key: "source",
        label: "Source",
        type: "text",
        defaultOperator: "contains",
        placeholder: "Filter source…",
      },
      {
        key: "message",
        label: "Message",
        type: "text",
        defaultOperator: "contains",
        placeholder: "Search message…",
      },
    ],
    [],
  );

  return (
    <LogTable
      title="Raw logs"
      data={SAMPLE}
      columns={columns}
      filterFields={filterFields}
      initialFilters={[createFilter<LogFilterValue>("level", "is", [])]}
      getRowId={(row) => row.id}
      initialSorting={[{ id: "ts", desc: true }]}
    />
  );
}
