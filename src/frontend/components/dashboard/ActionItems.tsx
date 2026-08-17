/**
 * @fileoverview Action items — human-gated follow-ups (e.g. delete an archived
 * source). Approving runs the destructive step server-side and then verifies it
 * took effect; the row moves pending → in_progress → complete|failed.
 *
 * Two surfaces:
 *  - `widget` — compact card list of pending items only (dashboard corner);
 *    hides itself when nothing is pending.
 *  - `full`   — the whole log on the ReUI DataGrid (TanStack Table v9): sortable
 *    Status / Service / When columns, an expandable row that reveals the
 *    description, audit line, Drive link, verify result, and error.
 *
 * There is no backend mutation for an item's status/priority beyond the gated
 * `.../approve` step, and no persisted ordering — so Status stays a read-only
 * badge and there is no drag-reorder. Approve is the only write.
 */

"use client";

import { type ColumnDef, useTable } from "@tanstack/react-table";
import {
  CheckCircle2Icon,
  ChevronRightIcon,
  ClockIcon,
  Loader2Icon,
  XCircleIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

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
import { ApiError, apiGet, apiSend } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

type Item = {
  id: string;
  kind: string;
  service: string;
  resourceType: string;
  resourceId: string;
  resourceName: string;
  title: string;
  description: string;
  audit: string | null;
  driveUrl: string | null;
  status: "pending" | "in_progress" | "complete" | "failed";
  verifyResult: string | null;
  error: string | null;
  createdAt: number;
  completedAt: number | null;
};

type Payload = {
  items: Item[];
  counts: { pending: number; inProgress: number; complete: number };
};

const PANEL = "rounded-xl border border-border/60 bg-background/40 p-5";

// pending sorts first so the actionable rows lead the table.
const STATUS_RANK: Record<Item["status"], number> = {
  pending: 0,
  in_progress: 1,
  failed: 2,
  complete: 3,
};

/**
 * @param service - restrict to one binding's items (e.g. "d1"); omit for all
 * @param mode - "widget" shows only pending cards; "full" shows the DataGrid
 */
export function ActionItems({ service, mode = "full" }: { service?: string; mode?: "widget" | "full" }) {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const query = `${service ? `service=${encodeURIComponent(service)}&` : ""}status=all`;

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await apiGet<Payload>(`/guardian/action-items?${query}`));
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "Sign in to view action items."
          : err instanceof ApiError
            ? err.message
            : "Failed to load action items.",
      );
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);

  const approve = useCallback(
    async (id: string) => {
      setBusy(id);
      setError(null);
      try {
        await apiSend("POST", `/guardian/action-items/${encodeURIComponent(id)}/approve`);
        await load();
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Approve failed.");
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const columns = useMemo<ColumnDef<DataGridFeatures, Item>[]>(
    () => [
      {
        id: "expander",
        header: "",
        enableSorting: false,
        size: 40,
        cell: ({ row }) => (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={row.getIsExpanded() ? "Collapse details" : "Expand details"}
            onClick={() => row.toggleExpanded()}
          >
            <ChevronRightIcon
              className={cn("size-4 transition-transform", row.getIsExpanded() && "rotate-90")}
            />
          </Button>
        ),
        meta: { expandedContent: (item: Item) => <ItemDetail i={item} /> },
      },
      {
        id: "status",
        accessorFn: (i) => STATUS_RANK[i.status],
        header: ({ column }) => <DataGridColumnHeader column={column} title="Status" />,
        cell: ({ row }) => (
          <span className="flex items-center gap-2">
            <StatusIcon status={row.original.status} />
            <span className="text-sm">{row.original.status.replace("_", " ")}</span>
          </span>
        ),
      },
      {
        accessorKey: "service",
        header: ({ column }) => <DataGridColumnHeader column={column} title="Service" />,
        cell: ({ row }) => (
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            {row.original.service}
          </span>
        ),
      },
      {
        accessorKey: "title",
        header: ({ column }) => <DataGridColumnHeader column={column} title="Item" />,
        cell: ({ row }) => (
          <div className="min-w-0">
            <div className="font-medium">{row.original.title}</div>
            <div className="max-w-md truncate text-xs text-muted-foreground">
              {row.original.description}
            </div>
          </div>
        ),
      },
      {
        accessorFn: (i) => i.completedAt ?? i.createdAt,
        id: "when",
        header: ({ column }) => (
          <DataGridColumnHeader column={column} title="When" className="justify-end" />
        ),
        cell: ({ row }) => (
          <span className="block text-right font-mono text-[10px] text-muted-foreground">
            {relativeTime(row.original.completedAt ?? row.original.createdAt)}
          </span>
        ),
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.status === "pending" ? (
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="outline"
                disabled={busy === row.original.id}
                onClick={() => void approve(row.original.id)}
                className="gap-1.5"
              >
                {busy === row.original.id ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
                Approve delete
              </Button>
            </div>
          ) : null,
      },
    ],
    [busy, approve],
  );

  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useTable({
    features: dataGridFeatures,
    data: data?.items ?? [],
    columns,
    getRowId: (row) => row.id,
    // The list endpoint returns the full set uncapped; render every row.
    manualPagination: true,
    initialState: { sorting: [{ id: "status", desc: false }] },
  });

  if (loading && !data)
    return (
      <div className={`${PANEL} flex items-center gap-2 text-sm text-muted-foreground`}>
        <Loader2Icon className="size-4 animate-spin" /> Loading action items…
      </div>
    );
  if (!data) return error ? <p className={`${PANEL} text-sm text-muted-foreground`}>{error}</p> : null;

  const pending = data.items.filter((i) => i.status === "pending" || i.status === "in_progress");

  // ---- Widget: compact pending-only cards, hidden when nothing is pending ----
  if (mode === "widget") {
    if (pending.length === 0) return null;
    return (
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-medium">Action items · {pending.length} pending</h2>
          <a href="/dashboard/action-items" className="text-xs text-muted-foreground hover:text-foreground">
            View all →
          </a>
        </div>
        {error && <p className={`${PANEL} text-sm text-destructive`}>{error}</p>}
        {pending.map((i) => (
          <ItemCard key={i.id} i={i} busy={busy === i.id} onApprove={approve} />
        ))}
      </section>
    );
  }

  // ---- Full: the whole log on the DataGrid --------------------------------
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-2xl font-semibold tracking-tight">
        Action items{pending.length > 0 ? ` · ${pending.length} pending` : ""}
      </h2>

      {error && <p className={`${PANEL} text-sm text-destructive`}>{error}</p>}

      <DataGrid
        table={table}
        recordCount={data.items.length}
        isLoading={loading}
        emptyMessage="Nothing pending — completed items appear here too."
        tableLayout={{ dense: true, headerBorder: true, rowBorder: true, columnsVisibility: false }}
      >
        <DataGridContainer>
          <DataGridScrollArea>
            <DataGridTable />
          </DataGridScrollArea>
        </DataGridContainer>
      </DataGrid>
    </section>
  );
}

/** Expanded-row body: the detail that doesn't fit in the table columns. */
function ItemDetail({ i }: { i: Item }) {
  const audit = i.audit ? (JSON.parse(i.audit) as Record<string, unknown>) : null;
  return (
    <div className="flex flex-col gap-1 px-2 py-2 text-sm">
      <p className="text-muted-foreground">{i.description}</p>
      {i.driveUrl && (
        <a
          href={i.driveUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="text-xs text-sky-600 underline underline-offset-4 dark:text-sky-400"
        >
          View archive in Drive
        </a>
      )}
      {audit && (
        <p className="font-mono text-[11px] text-muted-foreground">
          audit: {audit.rows as number} rows · {audit.driveBytes as number} bytes ·{" "}
          {audit.bytesMatch ? "verified ✓" : "MISMATCH ✗"}
        </p>
      )}
      {i.verifyResult && <p className="text-xs text-muted-foreground">{i.verifyResult}</p>}
      {i.error && <p className="text-xs text-rose-600 dark:text-rose-400">{i.error}</p>}
    </div>
  );
}

function ItemCard({
  i,
  busy,
  onApprove,
}: {
  i: Item;
  busy: boolean;
  onApprove: (id: string) => void;
}) {
  const audit = i.audit ? (JSON.parse(i.audit) as Record<string, unknown>) : null;
  const tone =
    i.status === "complete"
      ? "ring-emerald-500/25"
      : i.status === "failed"
        ? "ring-rose-500/25"
        : i.status === "in_progress"
          ? "ring-amber-500/25"
          : "ring-sky-500/25";
  return (
    <div className={`${PANEL} ring-1 ${tone}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <StatusIcon status={i.status} />
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              {i.service} · {i.status.replace("_", " ")}
            </span>
          </div>
          <h3 className="mt-1 text-base font-medium">{i.title}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{i.description}</p>
          {i.driveUrl && (
            <a
              href={i.driveUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="mt-1 inline-block text-xs text-sky-600 underline underline-offset-4 dark:text-sky-400"
            >
              View archive in Drive
            </a>
          )}
          {audit && (
            <p className="mt-1 font-mono text-[11px] text-muted-foreground">
              audit: {audit.rows as number} rows · {audit.driveBytes as number} bytes ·{" "}
              {audit.bytesMatch ? "verified ✓" : "MISMATCH ✗"}
            </p>
          )}
          {i.verifyResult && <p className="mt-1 text-xs text-muted-foreground">{i.verifyResult}</p>}
          {i.error && <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">{i.error}</p>}
        </div>
        <div className="shrink-0">
          {i.status === "pending" && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => onApprove(i.id)} className="gap-1.5">
              {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
              Approve delete
            </Button>
          )}
          <span className="ml-auto block text-right font-mono text-[10px] text-muted-foreground">
            {relativeTime(i.completedAt ?? i.createdAt)}
          </span>
        </div>
      </div>
    </div>
  );
}

function StatusIcon({ status }: { status: Item["status"] }) {
  if (status === "complete") return <CheckCircle2Icon className="size-4 text-emerald-600 dark:text-emerald-400" />;
  if (status === "failed") return <XCircleIcon className="size-4 text-rose-600 dark:text-rose-400" />;
  if (status === "in_progress") return <Loader2Icon className="size-4 animate-spin text-amber-600 dark:text-amber-400" />;
  return <ClockIcon className="size-4 text-sky-600 dark:text-sky-400" />;
}
