/**
 * @fileoverview /dashboard/projects — the "who's costing what" index.
 *
 * Sortable, filterable table of the unified project registry
 * (`GET /api/guardian/projects`), rewired onto the ReUI DataGrid (TanStack
 * Table v9). Default view: active projects, sorted by this month's spend
 * descending — the money-first ordering the owner reads first.
 *
 * The Criticality column is an INLINE editable dropdown: changing it POSTs
 * `{ criticality }` to `POST /api/guardian/projects/{name}/config` (the same
 * audited metadata endpoint the detail page uses) and updates the row in place.
 * "Sync now" runs the worker sync (`POST .../sync`) then refetches.
 */

"use client";

// eslint-disable-next-line react-hooks/incompatible-library
import { type ColumnDef, useTable } from "@tanstack/react-table";
import { ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import {
  DataGrid,
  DataGridContainer,
  dataGridFeatures,
  type DataGridFeatures,
} from "@/components/reui/data-grid/data-grid";
import { DataGridColumnHeader } from "@/components/reui/data-grid/data-grid-column-header";
import { DataGridScrollArea } from "@/components/reui/data-grid/data-grid-scroll-area";
import { DataGridTable } from "@/components/reui/data-grid/data-grid-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ApiError, apiGet, apiSend } from "@/lib/api";
import { relativeTime, usd } from "@/lib/format";
import { cn } from "@/lib/utils";

import { InlineError } from "@/components/dashboard/shared";
import {
  ActivePill,
  CriticalityBadge,
  KindBadge,
  LoadingRow,
  PAGE_SIZE,
  Pager,
  StatusBanner,
  useResource,
  type Criticality,
  type Kind,
  type Project,
  type Status,
} from "./shared";

const CRIT_RANK: Record<Criticality, number> = {
  hobby: 0,
  normal: 1,
  important: 2,
  critical: 3,
};
const CRIT_OPTIONS: Criticality[] = ["hobby", "normal", "important", "critical"];

const KIND_OPTIONS: { value: Kind | "all"; label: string }[] = [
  { value: "all", label: "All kinds" },
  { value: "worker", label: "Workers" },
  { value: "ai_project", label: "AI projects" },
  { value: "py", label: "Python" },
  { value: "gas", label: "Apps Script" },
  { value: "other", label: "Other" },
];

/**
 * Inline editable criticality — an unlabelled dropdown showing the coloured
 * pill. Changing it calls the metadata endpoint and only commits (via
 * `onSave`) once the write succeeds, so a failed request leaves the row on its
 * server value. Disabled while a write is in flight.
 */
function CriticalityCell({
  project,
  onSave,
}: {
  project: Project;
  onSave: (name: string, criticality: Criticality) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  return (
    <Select
      value={project.criticality}
      disabled={saving}
      onValueChange={(v) => {
        if (v === project.criticality) return;
        setSaving(true);
        void onSave(project.name, v as Criticality).finally(() => setSaving(false));
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label={`Criticality for ${project.name}`}
        className={cn("h-7 w-fit gap-1.5 border-0 bg-transparent px-1 shadow-none hover:bg-muted/40", saving && "opacity-60")}
      >
        <CriticalityBadge criticality={project.criticality} />
      </SelectTrigger>
      <SelectContent>
        {CRIT_OPTIONS.map((c) => (
          <SelectItem key={c} value={c}>
            <CriticalityBadge criticality={c} />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function ProjectsTable() {
  const [activeOnly, setActiveOnly] = useState(true);
  const [kind, setKind] = useState<Kind | "all">("all");
  const [minSpend, setMinSpend] = useState("");
  const [search, setSearch] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const [page, setPage] = useState(0);

  const fetcher = useCallback(() => {
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(page * PAGE_SIZE),
    });
    if (!activeOnly) params.set("all", "1");
    return apiGet<{ projects: Project[]; hasMore: boolean }>(
      `/guardian/projects?${params}`,
    );
  }, [activeOnly, page]);
  const { data, loading, error, reload, setData } = useResource(fetcher);

  async function syncNow() {
    setSyncing(true);
    setStatus(null);
    try {
      const r = await apiSend<Record<string, number>>("POST", "/guardian/projects/sync");
      const counts = Object.entries(r)
        .map(([k, v]) => `${v} ${k}`)
        .join(", ");
      setStatus({ kind: "success", message: `Sync complete${counts ? ` — ${counts}` : ""}.` });
      reload();
    } catch (e) {
      setStatus({
        kind: "error",
        message: e instanceof ApiError ? e.message : "Sync failed.",
      });
    } finally {
      setSyncing(false);
    }
  }

  // Inline criticality edit → POST /{name}/config, then patch the row in place.
  const saveCriticality = useCallback(
    async (name: string, criticality: Criticality) => {
      setStatus(null);
      try {
        await apiSend("POST", `/guardian/projects/${encodeURIComponent(name)}/config`, {
          criticality,
        });
        setData((d) =>
          d
            ? { ...d, projects: d.projects.map((p) => (p.name === name ? { ...p, criticality } : p)) }
            : d,
        );
        setStatus({ kind: "success", message: `${name} → ${criticality}.` });
      } catch (e) {
        setStatus({
          kind: "error",
          message: e instanceof ApiError ? e.message : `Failed to update ${name}.`,
        });
      }
    },
    [setData],
  );

  const rows = useMemo(() => {
    if (!data) return [];
    const min = parseFloat(minSpend);
    const q = search.trim().toLowerCase();
    return data.projects.filter((p) => {
      if (kind !== "all" && p.kind !== kind) return false;
      if (!Number.isNaN(min) && p.spendThisMonthUsd < min) return false;
      if (q && !p.name.toLowerCase().includes(q) && !(p.repo ?? "").toLowerCase().includes(q))
        return false;
      return true;
    });
  }, [data, kind, minSpend, search]);

  const columns = useMemo<ColumnDef<DataGridFeatures, Project>[]>(
    () => [
      {
        accessorKey: "name",
        header: ({ column }) => <DataGridColumnHeader column={column} title="Project" />,
        cell: ({ row }) => {
          const p = row.original;
          return (
            <div className="min-w-0">
              <a
                href={`/dashboard/projects/${encodeURIComponent(p.name)}`}
                className="font-medium text-foreground hover:underline"
              >
                {p.name}
              </a>
              {p.note ? (
                <div className="max-w-xs truncate text-xs text-muted-foreground">{p.note}</div>
              ) : null}
            </div>
          );
        },
      },
      {
        accessorKey: "kind",
        header: ({ column }) => <DataGridColumnHeader column={column} title="Kind" />,
        cell: ({ row }) => <KindBadge kind={row.original.kind} />,
      },
      {
        accessorKey: "repo",
        header: "Repo",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.repo ? (
            <a
              href={`https://github.com/${row.original.repo}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground"
            >
              {row.original.repo}
              <ExternalLinkIcon className="size-3" />
            </a>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "criticality",
        accessorFn: (p) => CRIT_RANK[p.criticality],
        header: ({ column }) => <DataGridColumnHeader column={column} title="Criticality" />,
        cell: ({ row }) => <CriticalityCell project={row.original} onSave={saveCriticality} />,
      },
      {
        accessorKey: "spendThisMonthUsd",
        header: ({ column }) => (
          <DataGridColumnHeader column={column} title="Spend (mo)" className="justify-end" />
        ),
        cell: ({ row }) => (
          <span className="block text-right font-mono tabular-nums">
            {usd(row.original.spendThisMonthUsd)}
          </span>
        ),
      },
      {
        accessorKey: "lastSeen",
        header: ({ column }) => <DataGridColumnHeader column={column} title="Last seen" />,
        cell: ({ row }) => (
          <span className="text-muted-foreground">{relativeTime(row.original.lastSeen)}</span>
        ),
      },
      {
        accessorKey: "isActive",
        header: "Status",
        enableSorting: false,
        cell: ({ row }) => <ActivePill active={row.original.isActive} />,
      },
    ],
    [saveCriticality],
  );

  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useTable({
    features: dataGridFeatures,
    data: rows,
    columns,
    getRowId: (row) => row.name,
    // Server paginates via offset/limit + <Pager>; render every fetched row.
    manualPagination: true,
    initialState: { sorting: [{ id: "spendThisMonthUsd", desc: true }] },
  });

  return (
    <section className="flex flex-col gap-4">
      {/* Filter bar */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-muted-foreground" htmlFor="proj-search">
            Search
          </label>
          <Input
            id="proj-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="name or repo…"
            className="w-56"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-muted-foreground" htmlFor="proj-kind">
            Kind
          </label>
          <Select value={kind} onValueChange={(v) => setKind(v as Kind | "all")}>
            <SelectTrigger id="proj-kind" className="w-40">
              {KIND_OPTIONS.find((o) => o.value === kind)?.label ?? "All kinds"}
            </SelectTrigger>
            <SelectContent>
              {KIND_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-muted-foreground" htmlFor="proj-minspend">
            Min spend ($)
          </label>
          <Input
            id="proj-minspend"
            type="number"
            inputMode="decimal"
            min="0"
            value={minSpend}
            onChange={(e) => setMinSpend(e.target.value)}
            placeholder="0"
            className="w-28"
          />
        </div>
        <label
          htmlFor="proj-active"
          className="flex h-9 items-center gap-2 text-sm text-muted-foreground"
        >
          <Switch
            id="proj-active"
            checked={activeOnly}
            onCheckedChange={(v) => {
              setActiveOnly(v);
              setPage(0);
            }}
          />
          Active only
        </label>
        <Button variant="outline" onClick={syncNow} disabled={syncing} className="ml-auto gap-2">
          <RefreshCwIcon className={cn("size-4", syncing && "animate-spin")} />
          {syncing ? "Syncing…" : "Sync now"}
        </Button>
      </div>

      <StatusBanner status={status} />

      {loading && !data ? (
        <LoadingRow label="Loading projects…" />
      ) : error ? (
        <InlineError message={error} onRetry={reload} />
      ) : (
        <DataGrid
          table={table}
          recordCount={rows.length}
          isLoading={loading}
          emptyMessage={
            data && data.projects.length > 0
              ? "No projects match these filters."
              : "No projects yet — run a sync to discover them."
          }
          tableLayout={{ dense: true, headerBorder: true, rowBorder: true, columnsVisibility: false }}
        >
          <DataGridContainer>
            <DataGridScrollArea>
              <DataGridTable />
            </DataGridScrollArea>
          </DataGridContainer>
        </DataGrid>
      )}

      {data ? (
        <Pager page={page} hasMore={data.hasMore} onPage={setPage} disabled={loading} />
      ) : null}
    </section>
  );
}
