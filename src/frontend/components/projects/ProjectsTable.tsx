/**
 * @fileoverview /dashboard/projects — the "who's costing what" index.
 *
 * Sortable, filterable table of the unified project registry
 * (`GET /api/guardian/projects`). Default view: active projects, sorted by this
 * month's spend descending — the money-first ordering the owner reads first.
 * "Sync now" runs the worker sync (`POST .../sync`) then refetches.
 */

"use client";

import { ArrowDownIcon, ArrowUpIcon, ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ApiError, apiGet, apiSend } from "@/lib/api";
import { relativeTime, usd } from "@/lib/format";
import { cn } from "@/lib/utils";

import { EmptyState, InlineError } from "@/components/dashboard/shared";
import {
  ActivePill,
  CriticalityBadge,
  KindBadge,
  LoadingRow,
  PAGE_SIZE,
  Pager,
  StatusBanner,
  useResource,
  type Kind,
  type Project,
  type Status,
} from "./shared";

type SortKey = "name" | "kind" | "spend" | "lastSeen" | "criticality";
const CRIT_RANK: Record<string, number> = { hobby: 0, normal: 1, important: 2, critical: 3 };

const KIND_OPTIONS: { value: Kind | "all"; label: string }[] = [
  { value: "all", label: "All kinds" },
  { value: "worker", label: "Workers" },
  { value: "ai_project", label: "AI projects" },
  { value: "py", label: "Python" },
  { value: "gas", label: "Apps Script" },
  { value: "other", label: "Other" },
];

function SortHeader({
  label,
  col,
  sort,
  dir,
  onSort,
  className,
}: {
  label: string;
  col: SortKey;
  sort: SortKey;
  dir: "asc" | "desc";
  onSort: (c: SortKey) => void;
  className?: string;
}) {
  const active = sort === col;
  return (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => onSort(col)}
        className={cn(
          "inline-flex items-center gap-1 hover:text-foreground",
          active ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {label}
        {active ? (
          dir === "asc" ? (
            <ArrowUpIcon className="size-3" />
          ) : (
            <ArrowDownIcon className="size-3" />
          )
        ) : null}
      </button>
    </TableHead>
  );
}

export function ProjectsTable() {
  const [activeOnly, setActiveOnly] = useState(true);
  const [kind, setKind] = useState<Kind | "all">("all");
  const [minSpend, setMinSpend] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("spend");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
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
  const { data, loading, error, reload } = useResource(fetcher);

  function onSort(col: SortKey) {
    if (col === sort) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSort(col);
      setDir(col === "name" ? "asc" : "desc");
    }
  }

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

  const rows = useMemo(() => {
    if (!data) return [];
    const min = parseFloat(minSpend);
    const q = search.trim().toLowerCase();
    const filtered = data.projects.filter((p) => {
      if (kind !== "all" && p.kind !== kind) return false;
      if (!Number.isNaN(min) && p.spendThisMonthUsd < min) return false;
      if (q && !p.name.toLowerCase().includes(q) && !(p.repo ?? "").toLowerCase().includes(q))
        return false;
      return true;
    });
    const mul = dir === "asc" ? 1 : -1;
    return filtered.sort((a, b) => {
      switch (sort) {
        case "name":
          return a.name.localeCompare(b.name) * mul;
        case "kind":
          return a.kind.localeCompare(b.kind) * mul;
        case "criticality":
          return (CRIT_RANK[a.criticality] - CRIT_RANK[b.criticality]) * mul;
        case "lastSeen":
          return (a.lastSeen - b.lastSeen) * mul;
        default:
          return (a.spendThisMonthUsd - b.spendThisMonthUsd) * mul;
      }
    });
  }, [data, kind, minSpend, search, sort, dir]);

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
              <SelectValue />
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
        <Button
          variant="outline"
          onClick={syncNow}
          disabled={syncing}
          className="ml-auto gap-2"
        >
          <RefreshCwIcon className={cn("size-4", syncing && "animate-spin")} />
          {syncing ? "Syncing…" : "Sync now"}
        </Button>
      </div>

      <StatusBanner status={status} />

      {/* Table */}
      {loading && !data ? (
        <LoadingRow label="Loading projects…" />
      ) : error ? (
        <InlineError message={error} onRetry={reload} />
      ) : rows.length === 0 ? (
        <EmptyState label={data && data.projects.length > 0 ? "No projects match these filters." : "No projects yet — run a sync to discover them."} />
      ) : (
        <div className="overflow-x-auto rounded-md ring-1 ring-border/40">
          <Table>
            <TableHeader>
              <TableRow>
                <SortHeader label="Project" col="name" sort={sort} dir={dir} onSort={onSort} />
                <SortHeader label="Kind" col="kind" sort={sort} dir={dir} onSort={onSort} />
                <TableHead>Repo</TableHead>
                <SortHeader
                  label="Criticality"
                  col="criticality"
                  sort={sort}
                  dir={dir}
                  onSort={onSort}
                />
                <SortHeader
                  label="Spend (mo)"
                  col="spend"
                  sort={sort}
                  dir={dir}
                  onSort={onSort}
                  className="text-right"
                />
                <SortHeader label="Last seen" col="lastSeen" sort={sort} dir={dir} onSort={onSort} />
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((p) => (
                <TableRow key={p.name}>
                  <TableCell>
                    <a
                      href={`/dashboard/projects/${encodeURIComponent(p.name)}`}
                      className="font-medium text-foreground hover:underline"
                    >
                      {p.name}
                    </a>
                    {p.note ? (
                      <div className="max-w-xs truncate text-xs text-muted-foreground">{p.note}</div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <KindBadge kind={p.kind} />
                  </TableCell>
                  <TableCell>
                    {p.repo ? (
                      <a
                        href={`https://github.com/${p.repo}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground"
                      >
                        {p.repo}
                        <ExternalLinkIcon className="size-3" />
                      </a>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <CriticalityBadge criticality={p.criticality} />
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {usd(p.spendThisMonthUsd)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{relativeTime(p.lastSeen)}</TableCell>
                  <TableCell>
                    <ActivePill active={p.isActive} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {data ? (
        <Pager page={page} hasMore={data.hasMore} onPage={setPage} disabled={loading} />
      ) : null}
    </section>
  );
}
