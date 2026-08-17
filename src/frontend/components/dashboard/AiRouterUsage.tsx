/**
 * @fileoverview AI Router usage-by-project — cost-by-project bar chart plus a
 * cost-descending project rollup on the ReUI DataGrid (TanStack Table v9).
 *
 * Answers "why is AI spend high — which project?" `ai_router_requests` is the
 * only table carrying a `project` dimension, so this view is router-only —
 * correct for attribution, not a total-spend figure. Each project row expands
 * inline to its provider/model breakdown, lazy-loaded from
 * `/ai-router/usage/{project}` the first time it opens (the old drill dialog).
 * Mounted above `<AiRouterConsole>` on `/dashboard/ai-router` as its own island.
 */

"use client";

import {
  type ColumnDef,
  type ExpandedState,
  useTable,
} from "@tanstack/react-table";
import { Loader2Icon, RefreshCwIcon, SearchIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from "recharts";

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
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ApiError, apiGet } from "@/lib/api";
import { cn } from "@/lib/utils";

import { InlineError } from "./shared";

// --- Response types (mirror guardian/ai-router-usage.ts) -------------------

interface ProjectUsage {
  project: string;
  requests: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  errors: number;
  breakers: number;
}

interface ModelUsage {
  provider: string;
  model: string;
  requests: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

/** Lazily-fetched model breakdown for one project. */
type DrillEntry =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "loaded"; models: ModelUsage[] };

/** Discriminated tree row: a project parent, a model child, or a status child. */
type UsageRow =
  | { kind: "project"; id: string; project: ProjectUsage; subRows: UsageRow[] }
  | { kind: "model"; id: string; project: string; model: ModelUsage }
  | {
      kind: "status";
      id: string;
      project: string;
      status: "loading" | "error" | "empty";
      message?: string;
    };

const PANEL = "rounded-xl border border-border/60 bg-background/40 p-6";

const DAY_OPTIONS = [7, 30, 90] as const;

/** The five OKLCH palette hues exposed in global.css as `--chart-1..5`. */
const PALETTE = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
] as const;

const CHART_CONFIG = {
  costUsd: { label: "Cost" },
} satisfies ChartConfig;

const usd = (n: number) => `$${n.toFixed(2)}`;

function describeError(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.status === 401) return "Sign in to view usage.";
  if (err instanceof ApiError) return err.message;
  return fallback;
}

export function AiRouterUsage() {
  const [days, setDays] = useState(30);
  const [projects, setProjects] = useState<ProjectUsage[]>([]);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  // Per-project model breakdown, lazy-loaded on first expand.
  const [drill, setDrill] = useState<Record<string, DrillEntry>>({});
  const [expanded, setExpanded] = useState<ExpandedState>({});

  const reqSeq = useRef(0);
  // Bumped whenever the visible range changes; a stale drill fetch checks it
  // before committing so a slow response can't paint the wrong window.
  const epoch = useRef(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const seq = ++reqSeq.current;
    try {
      const end = Math.floor(Date.now() / 60_000) * 60_000;
      const start = end - days * 86_400_000;
      const res = await apiGet<{ projects: ProjectUsage[] }>("/ai-router/usage", { start, end });
      if (seq === reqSeq.current) {
        setProjects(res.projects);
        setReady(true);
      }
    } catch (err) {
      if (seq === reqSeq.current) setError(describeError(err, "Failed to load AI Router usage."));
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  // A range change invalidates every cached breakdown; collapse and drop them
  // so an expanded row can't show a stale range (old behavior closed the dialog).
  useEffect(() => {
    epoch.current += 1;
    setDrill({});
    setExpanded({});
  }, [days]);

  const ensureDrill = useCallback(
    async (project: string) => {
      // Already loading or loaded — nothing to do (errors are retried by re-expand).
      if (drill[project] && drill[project].state !== "error") return;
      const token = epoch.current;
      setDrill((prev) => ({ ...prev, [project]: { state: "loading" } }));
      try {
        const end = Math.floor(Date.now() / 60_000) * 60_000;
        const start = end - days * 86_400_000;
        const res = await apiGet<{ models: ModelUsage[] }>(
          "/ai-router/usage/" + encodeURIComponent(project),
          { start, end },
        );
        if (token === epoch.current) {
          setDrill((prev) => ({ ...prev, [project]: { state: "loaded", models: res.models } }));
        }
      } catch (err) {
        if (token === epoch.current) {
          setDrill((prev) => ({
            ...prev,
            [project]: { state: "error", message: describeError(err, "Failed to load model breakdown.") },
          }));
        }
      }
    },
    [days, drill],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) => p.project.toLowerCase().includes(q));
  }, [projects, query]);

  const rows = useMemo<UsageRow[]>(
    () =>
      filtered.map((p) => {
        const entry = drill[p.project];
        let subRows: UsageRow[];
        if (!entry || entry.state === "loading") {
          subRows = [{ kind: "status", id: `${p.project}::loading`, project: p.project, status: "loading" }];
        } else if (entry.state === "error") {
          subRows = [
            {
              kind: "status",
              id: `${p.project}::error`,
              project: p.project,
              status: "error",
              message: entry.message,
            },
          ];
        } else if (entry.models.length === 0) {
          subRows = [{ kind: "status", id: `${p.project}::empty`, project: p.project, status: "empty" }];
        } else {
          subRows = entry.models.map((m) => ({
            kind: "model" as const,
            id: `${p.project}::${m.provider}/${m.model}`,
            project: p.project,
            model: m,
          }));
        }
        return { kind: "project", id: p.project, project: p, subRows };
      }),
    [filtered, drill],
  );

  // Fires on chevron toggle (via row.getToggleExpandedHandler); newly-expanded
  // projects kick off their lazy breakdown fetch here.
  const handleExpandedChange = useCallback(
    (updater: ExpandedState | ((old: ExpandedState) => ExpandedState)) => {
      const next = typeof updater === "function" ? updater(expanded) : updater;
      if (next !== true && expanded !== true) {
        for (const id of Object.keys(next)) {
          if (next[id] && !expanded[id]) void ensureDrill(id);
        }
      }
      setExpanded(next);
    },
    [expanded, ensureDrill],
  );

  const columns = useMemo<ColumnDef<DataGridFeatures, UsageRow>[]>(
    () => [
      {
        id: "project",
        accessorFn: (r) =>
          r.kind === "project" ? r.project.project : r.kind === "model" ? `${r.model.provider}/${r.model.model}` : "",
        header: ({ column }) => <DataGridColumnHeader column={column} title="Project" />,
        cell: ({ row }) => {
          const r = row.original;
          if (r.kind === "project") {
            return (
              <div className="flex min-w-0 items-center gap-1.5">
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={row.getIsExpanded() ? `Collapse ${r.project.project}` : `Expand ${r.project.project}`}
                  aria-expanded={row.getIsExpanded()}
                  className="size-6 shrink-0 p-0 text-muted-foreground shadow-none hover:text-foreground"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    row.getToggleExpandedHandler()();
                  }}
                >
                  <svg
                    viewBox="0 0 24 24"
                    className={cn(
                      "size-3.5 shrink-0 transition-transform duration-150",
                      row.getIsExpanded() && "rotate-90",
                    )}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <path d="m9 18 6-6-6-6" />
                  </svg>
                </Button>
                <span className="truncate font-mono text-sm">{r.project.project}</span>
              </div>
            );
          }
          if (r.kind === "model") {
            return (
              <span className="block pl-8 font-mono text-xs">
                <span className="text-muted-foreground">{r.model.provider}/</span>
                {r.model.model}
              </span>
            );
          }
          // status row
          if (r.status === "loading") {
            return (
              <span className="flex items-center gap-2 pl-8 text-xs text-muted-foreground">
                <Loader2Icon className="size-3.5 animate-spin" />
                Loading models…
              </span>
            );
          }
          if (r.status === "error") {
            return (
              <span className="block pl-8 text-xs text-destructive">
                {r.message ?? "Failed to load model breakdown."}
              </span>
            );
          }
          return (
            <span className="block pl-8 text-xs text-muted-foreground">
              No requests for this project in this window.
            </span>
          );
        },
        enableHiding: false,
        minSize: 260,
        meta: { autoSize: true },
      },
      {
        id: "requests",
        accessorFn: (r) => (r.kind === "project" ? r.project.requests : r.kind === "model" ? r.model.requests : 0),
        header: ({ column }) => <DataGridColumnHeader column={column} title="Requests" className="justify-end" />,
        cell: ({ row }) => {
          const r = row.original;
          const val = r.kind === "project" ? r.project.requests : r.kind === "model" ? r.model.requests : null;
          if (val === null) return null;
          return <span className="block text-right font-mono text-xs tabular-nums">{val.toLocaleString()}</span>;
        },
        size: 110,
      },
      {
        id: "tokens",
        accessorFn: (r) =>
          r.kind === "project"
            ? r.project.tokensIn + r.project.tokensOut
            : r.kind === "model"
              ? r.model.tokensIn + r.model.tokensOut
              : 0,
        header: ({ column }) => <DataGridColumnHeader column={column} title="Tokens" className="justify-end" />,
        cell: ({ row }) => {
          const r = row.original;
          const t = r.kind === "project" ? r.project : r.kind === "model" ? r.model : null;
          if (!t) return null;
          return (
            <span className="block text-right font-mono text-xs tabular-nums">
              {t.tokensIn.toLocaleString()}
              <span className="text-muted-foreground"> / {t.tokensOut.toLocaleString()}</span>
            </span>
          );
        },
        size: 150,
        enableSorting: false,
      },
      {
        id: "cost",
        accessorFn: (r) => (r.kind === "project" ? r.project.costUsd : r.kind === "model" ? r.model.costUsd : 0),
        header: ({ column }) => <DataGridColumnHeader column={column} title="Cost" className="justify-end" />,
        cell: ({ row }) => {
          const r = row.original;
          const c = r.kind === "project" ? r.project.costUsd : r.kind === "model" ? r.model.costUsd : null;
          if (c === null) return null;
          return <span className="block text-right font-mono text-xs tabular-nums">{usd(c)}</span>;
        },
        size: 100,
      },
      {
        id: "errorRate",
        header: "Error %",
        enableSorting: false,
        cell: ({ row }) => {
          const r = row.original;
          if (r.kind !== "project") return null;
          const p = r.project;
          return (
            <span className="block text-right font-mono text-xs tabular-nums">
              {p.requests > 0 ? `${((p.errors / p.requests) * 100).toFixed(1)}%` : "—"}
            </span>
          );
        },
        size: 90,
      },
      {
        id: "breakers",
        header: "Breakers",
        enableSorting: false,
        cell: ({ row }) => {
          const r = row.original;
          if (r.kind !== "project") return null;
          return <span className="block text-right font-mono text-xs tabular-nums">{r.project.breakers}</span>;
        },
        size: 90,
      },
    ],
    [],
  );

  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useTable({
    features: dataGridFeatures,
    data: rows,
    columns,
    getRowId: (row) => row.id,
    getSubRows: (row) => (row.kind === "project" ? row.subRows : undefined),
    getRowCanExpand: (row) => row.original.kind === "project",
    state: { expanded },
    onExpandedChange: handleExpandedChange,
    // Render every row — the data is already the full page. Without this the
    // grid slices to pageSize 10 and expanded children vanish.
    manualPagination: true,
    initialState: { sorting: [{ id: "cost", desc: true }] },
  });

  if (error && !ready) {
    return <InlineError message={error} onRetry={() => void load()} />;
  }

  if (!ready) {
    return (
      <div className={`${PANEL} flex items-center gap-2 text-sm text-muted-foreground`}>
        <Loader2Icon className="size-4 animate-spin" />
        Loading AI Router usage…
      </div>
    );
  }

  const top = filtered.slice(0, 10);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
            AI Router · Usage
          </div>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight">Spend by project</h2>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              placeholder="Search…"
              className="h-8 w-40 pl-8 text-sm"
            />
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="ai-router-usage-range" className="text-xs text-muted-foreground">
              Range
            </Label>
            <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
              <SelectTrigger id="ai-router-usage-range" className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DAY_OPTIONS.map((d) => (
                  <SelectItem key={d} value={String(d)}>
                    {d} days
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void load()}
            disabled={loading}
            className="gap-2"
          >
            {loading ? <Loader2Icon className="size-4 animate-spin" /> : <RefreshCwIcon className="size-4" />}
            Refresh
          </Button>
        </div>
      </header>

      {error && <p className={`${PANEL} text-sm text-destructive`}>{error}</p>}

      {/* --- Cost-by-project bar chart ------------------------------------ */}
      <section className={PANEL}>
        <h3 className="text-base font-medium">Spend by project (last {days} days)</h3>
        {top.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">
            No AI Router requests recorded in this window.
          </p>
        ) : (
          <ChartContainer
            config={CHART_CONFIG}
            className="mt-4 aspect-auto h-[max(240px,theme(spacing.10)*var(--rows))] w-full"
            style={{ ["--rows" as string]: top.length }}
          >
            <BarChart data={top} layout="vertical" margin={{ left: 4, right: 16, top: 4, bottom: 4 }}>
              <CartesianGrid horizontal={false} strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis
                type="number"
                tickLine={false}
                axisLine={false}
                tick={{ fill: "hsl(var(--foreground))", fontSize: 11 }}
                tickFormatter={(v) => usd(Number(v))}
              />
              <YAxis
                type="category"
                dataKey="project"
                tickLine={false}
                axisLine={false}
                width={120}
                tick={{ fill: "hsl(var(--foreground))", fontSize: 11 }}
              />
              <ChartTooltip content={<ChartTooltipContent formatter={(v) => usd(Number(v))} />} />
              <Bar dataKey="costUsd" radius={[0, 4, 4, 0]}>
                {top.map((row, i) => (
                  <Cell key={row.project} fill={PALETTE[i % PALETTE.length]} />
                ))}
              </Bar>
            </BarChart>
          </ChartContainer>
        )}
      </section>

      {/* --- Project rollup grid (expand a row for its model breakdown) ---- */}
      <section className="flex flex-col gap-3">
        <h3 className="text-base font-medium">Projects ({projects.length})</h3>
        <DataGrid
          table={table}
          recordCount={filtered.length}
          isLoading={loading}
          emptyMessage="No AI Router requests recorded in this window."
          tableLayout={{ dense: true, headerBorder: true, rowBorder: true, columnsVisibility: false }}
        >
          <DataGridContainer>
            <DataGridScrollArea>
              <DataGridTable />
            </DataGridScrollArea>
          </DataGridContainer>
        </DataGrid>
      </section>
    </div>
  );
}

export default AiRouterUsage;
