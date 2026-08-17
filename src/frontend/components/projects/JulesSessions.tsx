/**
 * @fileoverview /dashboard/jules — Jules coding-session monitor.
 *
 * Every `jules_sessions` row (`GET /api/guardian/projects/jules/sessions`)
 * rendered on the ReUI "agent run queue" DataGrid (TanStack Table v9): rows are
 * grouped into collapsible status groups (running / stuck / pending / submitted
 * / failed / completed), with client search over the loaded page and jump-out
 * links to the live Jules session and its PR.
 *
 * The server-side status filter + offset pager are preserved as-is so the
 * poller's terminal/non-terminal split stays authoritative; grouping and search
 * operate on the page the endpoint returns.
 */

"use client";

import { useTable, type ColumnDef, type ExpandedState } from "@tanstack/react-table";
import {
  ChevronRightIcon,
  ExternalLinkIcon,
  GitPullRequestIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { Badge } from "@/components/reui/badge";
import {
  DataGrid,
  DataGridContainer,
  dataGridFeatures,
  type DataGridFeatures,
} from "@/components/reui/data-grid/data-grid";
import { DataGridColumnHeader } from "@/components/reui/data-grid/data-grid-column-header";
import { DataGridScrollArea } from "@/components/reui/data-grid/data-grid-scroll-area";
import { DataGridTable } from "@/components/reui/data-grid/data-grid-table";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiGet } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

import { InlineError } from "@/components/dashboard/shared";
import {
  JulesStatusBadge,
  LoadingRow,
  PAGE_SIZE,
  Pager,
  useResource,
  type JulesSession,
  type JulesStatus,
} from "./shared";

const STATUS_OPTIONS: { value: JulesStatus | "all"; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "pending", label: "Pending" },
  { value: "running", label: "Running" },
  { value: "stuck", label: "Stuck" },
  { value: "submitted", label: "Submitted" },
  { value: "failed", label: "Failed" },
  { value: "completed", label: "Completed" },
];

// Collapsible status groups, ordered by lifecycle urgency (active first).
const STATUS_GROUPS: { id: JulesStatus; label: string; dot: string }[] = [
  { id: "running", label: "Running", dot: "bg-sky-500" },
  { id: "stuck", label: "Stuck", dot: "bg-amber-500" },
  { id: "pending", label: "Pending", dot: "bg-muted-foreground/70" },
  { id: "submitted", label: "Submitted", dot: "bg-violet-500" },
  { id: "failed", label: "Failed", dot: "bg-destructive" },
  { id: "completed", label: "Completed", dot: "bg-emerald-500" },
];

type GroupRow = {
  kind: "group";
  id: string;
  group: (typeof STATUS_GROUPS)[number];
  subRows: SessionRow[];
};
type SessionRow = { kind: "session"; id: string; session: JulesSession };
type Row = GroupRow | SessionRow;

function isSessionRow(row: Row): row is SessionRow {
  return row.kind === "session";
}

function buildRows(sessions: JulesSession[]): GroupRow[] {
  return STATUS_GROUPS.map((group) => ({
    kind: "group" as const,
    id: group.id,
    group,
    subRows: sessions
      .filter((s) => s.status === group.id)
      .map((s) => ({ kind: "session" as const, id: s.id, session: s })),
  })).filter((row) => row.subRows.length > 0);
}

function expandAll(rows: GroupRow[]): ExpandedState {
  return rows.reduce<Record<string, boolean>>((acc, r) => {
    acc[r.id] = true;
    return acc;
  }, {});
}

function collapseAll(rows: GroupRow[]): ExpandedState {
  return rows.reduce<Record<string, boolean>>((acc, r) => {
    acc[r.id] = false;
    return acc;
  }, {});
}

/** Compact icon-link that renders a dash when the URL is absent. */
function LinkOut({
  href,
  label,
  icon: Icon,
}: {
  href: string | null;
  label: string;
  icon: typeof ExternalLinkIcon;
}) {
  if (!href) return <span className="text-muted-foreground">—</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={buttonVariants({ variant: "ghost", size: "sm" })}
    >
      <Icon className="size-3.5" />
      {label}
    </a>
  );
}

function GroupCell({
  row,
  expanded,
  onToggle,
}: {
  row: GroupRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div data-jules-row="group" className="flex min-w-0 items-center gap-2">
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label={expanded ? `Collapse ${row.group.label}` : `Expand ${row.group.label}`}
        aria-expanded={expanded}
        className="text-muted-foreground hover:text-foreground size-6 shrink-0 p-0 shadow-none"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onToggle();
        }}
      >
        <ChevronRightIcon
          className={cn("size-3.5 transition-transform duration-150", expanded && "rotate-90")}
          aria-hidden
        />
      </Button>
      <span className={cn("size-2.5 shrink-0 rounded-full", row.group.dot)} aria-hidden />
      <span className="text-foreground truncate text-sm font-medium">{row.group.label}</span>
      <Badge variant="outline" className="shrink-0">
        {row.subRows.length}
      </Badge>
    </div>
  );
}

function SessionCell({ session }: { session: JulesSession }) {
  return (
    <div data-jules-row="session" className="flex min-w-0 flex-col gap-0.5 ps-8">
      {session.project ? (
        <a
          href={`/dashboard/projects/${encodeURIComponent(session.project)}`}
          className="text-foreground hover:text-primary min-w-0 truncate text-sm font-medium transition-colors"
        >
          {session.project}
        </a>
      ) : (
        <span className="text-muted-foreground text-sm">—</span>
      )}
      <span className="text-muted-foreground truncate font-mono text-xs">{session.repo}</span>
    </div>
  );
}

function searchBlob(s: JulesSession) {
  return `${s.project ?? ""} ${s.repo} ${s.status}`.toLowerCase();
}

export function JulesSessions() {
  const [status, setStatus] = useState<JulesStatus | "all">("all");
  const [page, setPage] = useState(0);
  const [query, setQuery] = useState("");

  const fetcher = useCallback(() => {
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(page * PAGE_SIZE),
    });
    if (status !== "all") params.set("status", status);
    return apiGet<{ sessions: JulesSession[]; hasMore: boolean }>(
      `/guardian/projects/jules/sessions?${params}`,
    );
  }, [status, page]);
  const { data, loading, error, reload } = useResource(fetcher);

  const filtered = useMemo(() => {
    const sessions = data?.sessions ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => searchBlob(s).includes(q));
  }, [data, query]);

  const rows = useMemo(() => buildRows(filtered), [filtered]);
  const [expanded, setExpanded] = useState<ExpandedState>({});
  // Keep every group open by default as pages/filters change; only an explicit
  // collapse (recorded in `expanded`) overrides it.
  const effectiveExpanded = useMemo<ExpandedState>(() => {
    if (expanded === true || Object.keys(expanded).length > 0) return expanded;
    return expandAll(rows);
  }, [expanded, rows]);

  const allExpanded =
    rows.length > 0 &&
    rows.every((r) => effectiveExpanded === true || effectiveExpanded[r.id] === true);

  const columns = useMemo<ColumnDef<DataGridFeatures, Row>[]>(
    () => [
      {
        id: "session",
        accessorFn: (row) => (isSessionRow(row) ? (row.session.project ?? row.session.repo) : row.group.label),
        header: ({ column }) => <DataGridColumnHeader column={column} title="Session" />,
        enableSorting: false,
        enableHiding: false,
        minSize: 280,
        cell: ({ row }) =>
          isSessionRow(row.original) ? (
            <SessionCell session={row.original.session} />
          ) : (
            <GroupCell
              row={row.original}
              expanded={row.getIsExpanded()}
              onToggle={row.getToggleExpandedHandler()}
            />
          ),
      },
      {
        id: "created",
        accessorFn: (row) => (isSessionRow(row) ? row.session.createdAt : 0),
        header: ({ column }) => <DataGridColumnHeader column={column} title="Created" />,
        enableSorting: false,
        size: 120,
        cell: ({ row }) =>
          isSessionRow(row.original) ? (
            <span className="text-muted-foreground text-xs">
              {relativeTime(row.original.session.createdAt)}
            </span>
          ) : null,
      },
      {
        id: "updated",
        accessorFn: (row) => (isSessionRow(row) ? row.session.updatedAt : 0),
        header: ({ column }) => <DataGridColumnHeader column={column} title="Updated" />,
        enableSorting: false,
        size: 120,
        cell: ({ row }) =>
          isSessionRow(row.original) ? (
            <span className="text-muted-foreground text-xs">
              {relativeTime(row.original.session.updatedAt)}
            </span>
          ) : null,
      },
      {
        id: "status",
        accessorFn: (row) => (isSessionRow(row) ? row.session.status : row.group.id),
        header: ({ column }) => <DataGridColumnHeader column={column} title="Status" />,
        enableSorting: false,
        size: 120,
        cell: ({ row }) =>
          isSessionRow(row.original) ? <JulesStatusBadge status={row.original.session.status} /> : null,
      },
      {
        id: "links",
        header: "",
        enableSorting: false,
        size: 160,
        cell: ({ row }) =>
          isSessionRow(row.original) ? (
            <div className="flex items-center justify-end gap-1">
              <LinkOut href={row.original.session.sessionUrl} label="Session" icon={ExternalLinkIcon} />
              <LinkOut href={row.original.session.prUrl} label="PR" icon={GitPullRequestIcon} />
            </div>
          ) : null,
      },
    ],
    [],
  );

  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useTable({
    features: dataGridFeatures,
    // Grouped rows are already the whole page; manualPagination keeps the v9
    // pagination APIs happy while leaving the rows unsliced.
    manualPagination: true,
    data: rows,
    columns,
    getRowId: (row) => row.id,
    getSubRows: (row) => (row.kind === "group" ? row.subRows : undefined),
    getRowCanExpand: (row) => row.original.kind === "group" && row.original.subRows.length > 0,
    state: { expanded: effectiveExpanded },
    onExpandedChange: setExpanded,
  });

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-muted-foreground" htmlFor="jules-status">
            Status
          </label>
          <Select
            value={status}
            onValueChange={(v) => {
              setStatus(v as JulesStatus | "all");
              setPage(0);
            }}
          >
            <SelectTrigger id="jules-status" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <InputGroup className="w-full min-w-0 sm:max-w-xs">
          <InputGroupAddon align="inline-start">
            <SearchIcon className="text-muted-foreground size-4" aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search project, repo…"
            aria-label="Search Jules sessions"
          />
          {query.length > 0 ? (
            <InputGroupAddon align="inline-end">
              <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => setQuery("")}>
                <XIcon className="size-4" aria-hidden />
              </InputGroupButton>
            </InputGroupAddon>
          ) : null}
        </InputGroup>

        <div className="ml-auto flex items-center gap-2">
          {rows.length > 0 ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => setExpanded(allExpanded ? collapseAll(rows) : expandAll(rows))}
            >
              {allExpanded ? "Collapse groups" : "Expand groups"}
            </Button>
          ) : null}
          <Button variant="outline" onClick={reload}>
            Refresh
          </Button>
        </div>
      </div>

      {loading && !data ? (
        <LoadingRow label="Loading Jules sessions…" />
      ) : error ? (
        <InlineError message={error} onRetry={reload} />
      ) : (
        <DataGrid
          table={table}
          recordCount={filtered.length}
          isLoading={loading}
          emptyMessage="No Jules sessions match this filter."
          tableLayout={{
            dense: true,
            rowBorder: true,
            headerBorder: true,
            columnsVisibility: false,
            columnsResizable: false,
            columnsMovable: false,
            width: "fixed",
          }}
          tableClassNames={{
            bodyRow: cn(
              "[&:has([data-jules-row=group])>td]:h-11 [&:has([data-jules-row=group])>td]:bg-muted/40",
              "[&:has([data-jules-row=group])>td]:hover:bg-muted/40",
            ),
          }}
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
