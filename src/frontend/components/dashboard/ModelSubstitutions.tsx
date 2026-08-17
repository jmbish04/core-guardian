/**
 * @fileoverview Model substitution rules — AI Router dashboard panel. Rewired
 * onto the ReUI DataGrid (TanStack Table v9): sortable headers, client search,
 * pagination, with the Enabled column as an inline Switch.
 *
 * Reads/writes `GET|POST|DELETE /api/guardian/ai-router/substitutions`. Each
 * rule swaps the model the router uses for a project (fromModel → toModel) with
 * no code change in the caller. Rows load enabled-first then newest; disabled
 * rows render dimmed. The Enabled switch is optimistic with revert-on-error
 * (`POST .../{id}/toggle`); delete is guarded by an AlertDialog confirm; the Add
 * form surfaces the backend's 400 validation message inline without closing.
 */

"use client";

import { type ColumnDef, useTable } from "@tanstack/react-table";
import { Loader2Icon, PlusIcon, SearchIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  DataGrid,
  DataGridContainer,
  dataGridFeatures,
  type DataGridFeatures,
} from "@/components/reui/data-grid/data-grid";
import { DataGridColumnHeader } from "@/components/reui/data-grid/data-grid-column-header";
import { DataGridPagination } from "@/components/reui/data-grid/data-grid-pagination";
import { DataGridScrollArea } from "@/components/reui/data-grid/data-grid-scroll-area";
import { DataGridTable } from "@/components/reui/data-grid/data-grid-table";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ApiError, apiGet, apiSend } from "@/lib/api";
import { cn } from "@/lib/utils";

import { InlineError } from "./shared";

type Rule = {
  id: string;
  project: string;
  fromModel: string;
  toModel: string;
  enabled: boolean;
  note: string | null;
  createdAt: number;
};

const BASE = "/guardian/ai-router/substitutions";

/** Enabled first, then newest. */
function rank(a: Rule, b: Rule): number {
  if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
  return b.createdAt - a.createdAt;
}

// --- Add-rule dialog --------------------------------------------------------

function AddRuleDialog({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [project, setProject] = useState("");
  const [fromModel, setFromModel] = useState("");
  const [toModel, setToModel] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setProject("");
      setFromModel("");
      setToModel("");
      setNote("");
      setError(null);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiSend<Rule>("POST", BASE, {
        project: project.trim(),
        fromModel: fromModel.trim(),
        toModel: toModel.trim(),
        note: note.trim() || undefined,
      });
      setOpen(false);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save the substitution rule.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="gap-1.5">
          <PlusIcon className="size-3.5" />
          Add rule
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add substitution rule</DialogTitle>
          <DialogDescription>
            Route a project off <span className="font-mono">fromModel</span> onto{" "}
            <span className="font-mono">toModel</span> at the router. No caller change.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="sub-project">Project</Label>
            <Input
              id="sub-project"
              value={project}
              onChange={(e) => setProject(e.target.value)}
              placeholder="my-worker"
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="sub-from">From model</Label>
            <Input
              id="sub-from"
              value={fromModel}
              onChange={(e) => setFromModel(e.target.value)}
              placeholder="gpt-oss-120b"
              className="font-mono"
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="sub-to">To model</Label>
            <Input
              id="sub-to"
              value={toModel}
              onChange={(e) => setToModel(e.target.value)}
              placeholder="llama-3.3-70b"
              className="font-mono"
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="sub-note">Note (optional)</Label>
            <Input
              id="sub-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="cheaper, same capability"
            />
          </div>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="submit" disabled={submitting} className="gap-1.5">
              {submitting ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
              Save rule
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- Delete confirm ---------------------------------------------------------

function DeleteRuleButton({ rule, onDeleted }: { rule: Rule; onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setSubmitting(true);
    setError(null);
    try {
      await apiSend<{ ok: true }>("DELETE", `${BASE}/${rule.id}`);
      setOpen(false);
      onDeleted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to delete the rule.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button size="icon-sm" variant="ghost" aria-label="Delete rule">
          <Trash2Icon className="size-3.5 text-muted-foreground" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete substitution rule?</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="font-mono text-foreground">{rule.project}</span> will stop rewriting{" "}
            <span className="font-mono text-foreground">{rule.fromModel}</span> →{" "}
            <span className="font-mono text-foreground">{rule.toModel}</span>.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={(e) => {
              e.preventDefault();
              void confirm();
            }}
            disabled={submitting}
          >
            {submitting ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// --- The panel --------------------------------------------------------------

export function ModelSubstitutions() {
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mutError, setMutError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  // Request-id guard: a mutation-triggered refetch must not be overwritten by a
  // slower in-flight load.
  const reqId = useRef(0);
  const load = useCallback(async () => {
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    setMutError(null);
    try {
      const r = await apiGet<{ substitutions: Rule[] }>(BASE);
      // Freeze row order at load time so an optimistic toggle can flip `enabled`
      // in place without the row jumping. Order only re-derives on the next load.
      if (id === reqId.current) setRules(r.substitutions.slice().sort(rank));
    } catch (err) {
      if (id !== reqId.current) return;
      setError(
        err instanceof ApiError && err.status === 401
          ? "Sign in to manage substitutions."
          : err instanceof ApiError
            ? err.message
            : "Failed to load substitution rules.",
      );
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = useCallback(async (rule: Rule) => {
    setMutError(null);
    setPendingId(rule.id);
    // Optimistic flip in place — no reorder (see load()).
    setRules((prev) =>
      prev ? prev.map((r) => (r.id === rule.id ? { ...r, enabled: !r.enabled } : r)) : prev,
    );
    try {
      const res = await apiSend<{ id: string; enabled: boolean }>("POST", `${BASE}/${rule.id}/toggle`);
      // Trust the server's value over the optimistic guess (concurrent toggles).
      // ponytail: admin panel — narrow D1 read-after-write window; a stray refetch
      // mid-toggle self-heals on next load.
      setRules((prev) =>
        prev ? prev.map((r) => (r.id === res.id ? { ...r, enabled: res.enabled } : r)) : prev,
      );
    } catch (err) {
      setMutError(err instanceof ApiError ? err.message : "Failed to toggle the rule.");
      // Resync from the server rather than reverting via a stale closure.
      void load();
    } finally {
      setPendingId(null);
    }
  }, [load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = rules ?? [];
    if (!q) return list;
    return list.filter((r) =>
      `${r.project} ${r.fromModel} ${r.toModel} ${r.note ?? ""}`.toLowerCase().includes(q),
    );
  }, [rules, query]);

  const columns = useMemo<ColumnDef<DataGridFeatures, Rule>[]>(
    () => [
      {
        accessorKey: "project",
        header: ({ column }) => <DataGridColumnHeader column={column} title="Project" />,
        cell: ({ row }) => (
          <span className={cn("font-medium", !row.original.enabled && "opacity-50")}>
            {row.original.project}
          </span>
        ),
      },
      {
        id: "rule",
        accessorFn: (r) => `${r.fromModel} ${r.toModel}`,
        header: "Rule",
        enableSorting: false,
        cell: ({ row }) => (
          <span className={cn("font-mono text-xs", !row.original.enabled && "opacity-50")}>
            {row.original.fromModel}{" "}
            <span className="text-muted-foreground" aria-label="becomes">
              →
            </span>{" "}
            {row.original.toModel}
          </span>
        ),
      },
      {
        accessorKey: "note",
        header: "Note",
        enableSorting: false,
        cell: ({ row }) => (
          <span
            className={cn(
              "block max-w-[16rem] truncate text-muted-foreground",
              !row.original.enabled && "opacity-50",
            )}
            title={row.original.note ?? undefined}
          >
            {row.original.note ?? "—"}
          </span>
        ),
      },
      {
        accessorKey: "createdAt",
        header: ({ column }) => <DataGridColumnHeader column={column} title="Created" />,
        cell: ({ row }) => (
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {new Date(row.original.createdAt).toLocaleDateString()}
          </span>
        ),
      },
      {
        accessorKey: "enabled",
        header: ({ column }) => (
          <DataGridColumnHeader column={column} title="Enabled" className="justify-center" />
        ),
        cell: ({ row }) => (
          <div className="flex justify-center">
            <Switch
              checked={row.original.enabled}
              disabled={pendingId === row.original.id}
              onCheckedChange={() => void toggle(row.original)}
              aria-label={`Toggle ${row.original.project} substitution`}
            />
          </div>
        ),
        size: 96,
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex justify-end">
            <DeleteRuleButton rule={row.original} onDeleted={() => void load()} />
          </div>
        ),
        size: 56,
      },
    ],
    [toggle, load, pendingId],
  );

  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useTable({
    features: dataGridFeatures,
    data: filtered,
    columns,
    getRowId: (row) => row.id,
  });

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-border/60 bg-background/40 p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium">Model Substitutions</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Swap the model at the router for a project — no code change in the caller.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              placeholder="Search…"
              className="h-8 w-40 pl-8 text-sm"
            />
          </div>
          <AddRuleDialog onSaved={() => void load()} />
        </div>
      </header>

      {mutError ? <p className="text-xs text-destructive">{mutError}</p> : null}

      {error ? (
        <InlineError message={error} onRetry={() => void load()} />
      ) : (
        <DataGrid
          table={table}
          recordCount={filtered.length}
          isLoading={loading && !rules}
          emptyMessage="No substitution rules"
          tableLayout={{ dense: true, headerBorder: true, rowBorder: true, columnsVisibility: false }}
        >
          <DataGridContainer>
            <DataGridScrollArea>
              <DataGridTable />
            </DataGridScrollArea>
          </DataGridContainer>
          <DataGridPagination />
        </DataGrid>
      )}
    </section>
  );
}

export default ModelSubstitutions;
