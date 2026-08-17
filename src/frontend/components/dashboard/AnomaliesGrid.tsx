/**
 * @fileoverview Anomalies grid — the recurring-spend table, ReUI data-grid build.
 *
 * Replaces the old vertical card list (`AnomaliesPanel`) with one compact,
 * groupable row per anomaly. Row grouping toggles between cadence (default),
 * source, and project; every leaf row still carries all three as colour-coded
 * badges so the grouping choice never hides information. The one-click project
 * controls (Freeze / Lock month / Set budget / Unfreeze) collapse into a single
 * per-row action menu instead of a stack of buttons — that vertical compression
 * is the whole point.
 *
 * Presentational + control-owning, like the panel it replaces: the parent
 * (`SpendHeadline`) owns the single insights fetch and passes `onActed` so a
 * landed control refetches without this island double-recording "last visit".
 *
 * The free ReUI `data-grid` renders each column's `cell` for every row —
 * including grouped rows — so each column def branches on `row.getIsGrouped()`:
 * the leading summary column carries the group label + count + total, and the
 * rest blank out on group rows.
 */

"use client";

import {
  columnGroupingFeature,
  createGroupedRowModel,
  tableFeatures,
  useTable,
  type ColumnDef,
  type ExpandedState,
  type GroupingState,
  type Row,
  type SortingState,
} from "@tanstack/react-table";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2Icon,
  MoreHorizontal,
  ShieldOff,
} from "lucide-react";
import { useMemo, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DataGrid,
  DataGridContainer,
  dataGridFeatures,
} from "@/components/reui/data-grid/data-grid";
import { DataGridTable } from "@/components/reui/data-grid/data-grid-table";
import { ApiError, apiSend } from "@/lib/api";
import { formatCount, usd } from "@/lib/format";
import { cn } from "@/lib/utils";

import { SectionTitle } from "./shared";

/** One anomaly row from `GET /guardian/billing/insights`. */
export interface Anomaly {
  source: "router" | "workers-ai-neurons";
  model: string;
  provider: string | null;
  project: string | null;
  streakDays: number;
  streakTotalUsd: number;
  perDayUsd: number;
  cadence: "hourly" | "daily" | "weekly" | "sporadic";
  callCount: number | null;
  neuronsPerDay: number | null;
  lastDay: string;
}

type Action = "set-budget" | "lock-month" | "freeze" | "unfreeze";

/** Streak total at/above this reads LOUD — a recurring drip must not look static. */
const LOUD_USD = 50;

// Grouping the free data-grid needs on top of the base bundle.
const groupingFeatures = tableFeatures({
  ...dataGridFeatures,
  columnGroupingFeature,
  groupedRowModel: createGroupedRowModel(),
});

type GroupKey = "cadence" | "source" | "project";
const GROUP_OPTIONS: { value: GroupKey; label: string }[] = [
  { value: "cadence", label: "Cadence" },
  { value: "source", label: "Source" },
  { value: "project", label: "Project" },
];

// --- colour pills (ring-inset, Monolith palette) -----------------------------

function Pill({ tone, className, children }: { tone: string; className?: string; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset whitespace-nowrap",
        tone,
        className,
      )}
    >
      {children}
    </span>
  );
}

const CADENCE_TONE: Record<Anomaly["cadence"], string> = {
  hourly: "bg-red-500/15 text-red-300 ring-red-500/40",
  daily: "bg-amber-500/10 text-amber-300 ring-amber-500/30",
  weekly: "bg-sky-500/10 text-sky-300 ring-sky-500/30",
  sporadic: "bg-muted/40 text-muted-foreground ring-border/40",
};
const SOURCE_TONE: Record<Anomaly["source"], string> = {
  router: "bg-violet-500/10 text-violet-300 ring-violet-500/30",
  "workers-ai-neurons": "bg-cyan-500/10 text-cyan-300 ring-cyan-500/30",
};
const SOURCE_LABEL: Record<Anomaly["source"], string> = {
  router: "AI Router",
  "workers-ai-neurons": "direct Workers-AI",
};

function CadenceBadge({ cadence }: { cadence: Anomaly["cadence"] }) {
  return <Pill tone={CADENCE_TONE[cadence]}>{cadence}</Pill>;
}
function SourceBadge({ source }: { source: Anomaly["source"] }) {
  return <Pill tone={SOURCE_TONE[source]}>{SOURCE_LABEL[source]}</Pill>;
}
function ProjectBadge({ project }: { project: string | null }) {
  return project ? (
    <Pill tone="bg-emerald-500/10 text-emerald-300 ring-emerald-500/30">{project}</Pill>
  ) : (
    <span className="text-[11px] text-muted-foreground">no project</span>
  );
}

/** The value of the active grouping column for a grouped row, as a string. */
function groupValueOf(row: Row<typeof groupingFeatures, Anomaly>, key: GroupKey): string {
  const v = row.getGroupingValue(key);
  return v == null || v === "" ? "—" : String(v);
}

export function AnomaliesGrid({
  anomalies,
  onActed,
}: {
  anomalies: Anomaly[];
  onActed: () => void;
}) {
  const [grouping, setGrouping] = useState<GroupingState>(["cadence"]);
  const [expanded, setExpanded] = useState<ExpandedState>(true);
  const [sorting, setSorting] = useState<SortingState>([
    { id: "streakTotalUsd", desc: true },
  ]);
  const [query, setQuery] = useState("");

  // Action state keyed by project so every row sharing a project reflects the
  // same busy/result; survives the parent's post-action refetch (no remount).
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, { ok: boolean; msg: string }>>({});
  const [budgetFor, setBudgetFor] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ project: string; action: Action; title: string; body: string; label: string } | null>(null);

  async function runControl(project: string, action: Action, budgetUsd?: number) {
    setBusy(project);
    try {
      await apiSend("POST", "/guardian/billing/controls/project-circuit", {
        project,
        action,
        ...(budgetUsd !== undefined ? { budgetUsd } : {}),
      });
      const msg =
        action === "freeze"
          ? `${project} frozen — AI blocked until you unfreeze`
          : action === "lock-month"
            ? `${project} locked for the month — $0 cap`
            : action === "set-budget"
              ? `${project} capped at ${usd(budgetUsd ?? 0)}/month`
              : `${project} unfrozen — controls lifted`;
      setResults((r) => ({ ...r, [project]: { ok: true, msg } }));
      onActed();
    } catch (err) {
      setResults((r) => ({
        ...r,
        [project]: { ok: false, msg: err instanceof ApiError ? err.message : "Action failed." },
      }));
    } finally {
      setBusy(null);
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return anomalies;
    return anomalies.filter(
      (a) =>
        a.model.toLowerCase().includes(q) ||
        (a.project ?? "").toLowerCase().includes(q) ||
        a.cadence.includes(q),
    );
  }, [anomalies, query]);

  const columns = useMemo<ColumnDef<typeof groupingFeatures, Anomaly>[]>(() => {
    const groupKey = (grouping[0] as GroupKey | undefined) ?? "cadence";
    return [
      // Leading summary column: carries the group header (label + count + total)
      // on grouped rows; the model code + last-active line on leaf rows.
      {
        id: "summary",
        header: "Anomaly",
        enableGrouping: false,
        meta: { cellClassName: "min-w-[240px]" },
        cell: ({ row }) => {
          if (row.getIsGrouped()) {
            const total = row.subRows.reduce((s, r) => s + r.original.streakTotalUsd, 0);
            const loud = total >= LOUD_USD;
            return (
              <button
                type="button"
                onClick={row.getToggleExpandedHandler()}
                className="flex items-center gap-2 text-left"
              >
                {row.getIsExpanded() ? (
                  <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                ) : (
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                )}
                {groupKey === "cadence" ? (
                  <CadenceBadge cadence={groupValueOf(row, "cadence") as Anomaly["cadence"]} />
                ) : groupKey === "source" ? (
                  <SourceBadge source={groupValueOf(row, "source") as Anomaly["source"]} />
                ) : (
                  <ProjectBadge project={row.getGroupingValue("project") as string | null} />
                )}
                <span className="text-xs text-muted-foreground">
                  {row.subRows.length} {row.subRows.length === 1 ? "anomaly" : "anomalies"}
                </span>
                <span className={cn("text-xs font-semibold tabular-nums", loud ? "text-destructive" : "text-foreground")}>
                  · {usd(total)}
                </span>
              </button>
            );
          }
          const a = row.original;
          return (
            <div className="flex flex-col gap-0.5">
              <code className="w-fit rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                {a.model}
              </code>
              <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
                last active {a.lastDay}
              </span>
            </div>
          );
        },
      },
      {
        id: "source",
        accessorKey: "source",
        header: "Source",
        cell: ({ row }) => (row.getIsGrouped() ? null : <SourceBadge source={row.original.source} />),
      },
      {
        id: "cadence",
        accessorKey: "cadence",
        header: "Cadence",
        cell: ({ row }) => (row.getIsGrouped() ? null : <CadenceBadge cadence={row.original.cadence} />),
      },
      {
        id: "project",
        accessorFn: (a) => a.project ?? "",
        header: "Project",
        cell: ({ row }) => (row.getIsGrouped() ? null : <ProjectBadge project={row.original.project} />),
      },
      {
        id: "streakDays",
        accessorKey: "streakDays",
        header: "Running",
        cell: ({ row }) =>
          row.getIsGrouped() ? null : (
            <span className="tabular-nums text-foreground">
              {row.original.streakDays}d
            </span>
          ),
      },
      {
        id: "streakTotalUsd",
        accessorKey: "streakTotalUsd",
        header: "Total",
        meta: { cellClassName: "text-right", headerClassName: "text-right" },
        cell: ({ row }) => {
          if (row.getIsGrouped()) return null;
          const loud = row.original.streakTotalUsd >= LOUD_USD;
          return (
            <span
              className={cn(
                "flex items-center justify-end gap-1 tabular-nums font-semibold",
                loud ? "text-destructive" : "text-foreground",
              )}
            >
              {loud ? <AlertTriangle className="size-3.5" aria-hidden /> : null}
              {usd(row.original.streakTotalUsd)}
            </span>
          );
        },
      },
      {
        id: "perDayUsd",
        accessorKey: "perDayUsd",
        header: "Per day",
        meta: { cellClassName: "text-right", headerClassName: "text-right" },
        cell: ({ row }) =>
          row.getIsGrouped() ? null : (
            <span className="text-right tabular-nums text-muted-foreground">
              {usd(row.original.perDayUsd)}
              {row.original.neuronsPerDay ? (
                <span className="ml-1 text-[10px]">· {formatCount(row.original.neuronsPerDay)}n</span>
              ) : null}
            </span>
          ),
      },
      {
        id: "actions",
        header: "",
        enableGrouping: false,
        meta: { cellClassName: "w-10" },
        cell: ({ row }) => {
          if (row.getIsGrouped()) return null;
          const a = row.original;
          const result = a.project ? results[a.project] : undefined;
          if (!a.project) {
            return (
              <span className="text-[10px] text-muted-foreground" title="Route through core-guardian to enable controls">
                —
              </span>
            );
          }
          const project = a.project;
          const isBusy = busy === project;
          return (
            <div className="flex items-center justify-end gap-1">
              {result ? (
                result.ok ? (
                  <CheckCircle2 className="size-3.5 text-emerald-500" aria-hidden />
                ) : (
                  <AlertTriangle className="size-3.5 text-destructive" aria-hidden />
                )
              ) : null}
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button variant="ghost" size="icon" className="size-7" disabled={isBusy}>
                      {isBusy ? (
                        <Loader2Icon className="size-3.5 animate-spin" />
                      ) : (
                        <MoreHorizontal className="size-4" />
                      )}
                    </Button>
                  }
                />
                <DropdownMenuContent align="end" className="min-w-40">
                  <DropdownMenuItem
                    className="text-destructive"
                    onClick={() =>
                      setConfirm({
                        project,
                        action: "freeze",
                        title: `Freeze ${project}?`,
                        body: "Blocks this project's AI (sticky $0 all-time cap) until you unfreeze. In-flight calls fail closed.",
                        label: "Freeze — block AI",
                      })
                    }
                  >
                    <ShieldOff className="size-3.5" /> Freeze
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() =>
                      setConfirm({
                        project,
                        action: "lock-month",
                        title: `Lock ${project} for the month?`,
                        body: "Sets a $0 monthly cap — stops this project's AI spend for the rest of the month. Resets next month.",
                        label: "Lock for the month",
                      })
                    }
                  >
                    Lock month
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setBudgetFor(project)}>Set budget…</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => runControl(project, "unfreeze")}>Unfreeze</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        },
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grouping, busy, results]);

  const table = useTable({
    features: groupingFeatures,
    data: filtered,
    columns,
    state: { grouping, expanded, sorting, pagination: { pageIndex: 0, pageSize: 1000 } },
    onGroupingChange: setGrouping,
    onExpandedChange: setExpanded,
    onSortingChange: setSorting,
    getRowId: (a, i) => `${a.source}:${a.model}:${a.project ?? "none"}:${i}`,
    enableSortingRemoval: false,
  });

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <SectionTitle>Recurring spend anomalies</SectionTitle>
        <p className="text-sm text-muted-foreground">
          Ranked by accumulated total — a daily drip shows as days-running and a running sum, not a
          static per-day figure. Group, filter, and act inline.
        </p>
      </div>

      {anomalies.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-md bg-emerald-500/10 px-4 py-8 text-center ring-1 ring-emerald-500/30">
          <CheckCircle2 className="size-5 text-emerald-500" aria-hidden />
          <p className="text-sm text-emerald-600 dark:text-emerald-400">
            No recurring spend anomalies — nothing accumulating.
          </p>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-muted-foreground" htmlFor="anom-group">
                Group by
              </label>
              <Select
                value={(grouping[0] as string) ?? "none"}
                onValueChange={(v) => setGrouping(v && v !== "none" ? [v] : [])}
              >
                <SelectTrigger id="anom-group" className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {GROUP_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                  <SelectItem value="none">No grouping</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-muted-foreground" htmlFor="anom-search">
                Filter
              </label>
              <Input
                id="anom-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="model, project, cadence…"
                className="w-56"
              />
            </div>
          </div>

          <DataGrid
            table={table}
            recordCount={filtered.length}
            tableLayout={{ dense: true, rowBorder: true, headerBackground: true }}
          >
            <DataGridContainer>
              <DataGridTable />
            </DataGridContainer>
          </DataGrid>
        </>
      )}

      {/* Confirm dialog (Freeze / Lock month) driven by the row action menu. */}
      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirm?.body}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirm) runControl(confirm.project, confirm.action);
                setConfirm(null);
              }}
            >
              {confirm?.label}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Set-budget dialog. */}
      <SetBudgetDialog
        project={budgetFor}
        onClose={() => setBudgetFor(null)}
        onSet={(v) => {
          if (budgetFor) runControl(budgetFor, "set-budget", v);
          setBudgetFor(null);
        }}
      />
    </section>
  );
}

/** Single number input → set-budget, shared across rows. */
function SetBudgetDialog({
  project,
  onClose,
  onSet,
}: {
  project: string | null;
  onClose: () => void;
  onSet: (budgetUsd: number) => void;
}) {
  const [value, setValue] = useState("");
  const parsed = Number(value);
  const valid = value.trim() !== "" && Number.isFinite(parsed) && parsed >= 0;

  return (
    <Dialog open={project !== null} onOpenChange={(o) => !o && (setValue(""), onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set a monthly budget for {project}</DialogTitle>
          <DialogDescription>
            Caps this project's AI spend at the amount below for the current month. Spend past it
            fails closed until next month or you raise the cap.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 py-2">
          <Label htmlFor="anom-budget">Monthly cap (USD)</Label>
          <Input
            id="anom-budget"
            type="number"
            min={0}
            step="0.01"
            inputMode="decimal"
            placeholder="e.g. 25"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => {
              setValue("");
              onClose();
            }}
          >
            Cancel
          </Button>
          <Button
            disabled={!valid}
            onClick={() => {
              onSet(parsed);
              setValue("");
            }}
          >
            Set {valid ? usd(parsed) : ""} cap
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
