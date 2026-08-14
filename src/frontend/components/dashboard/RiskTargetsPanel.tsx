/**
 * @fileoverview RiskTargetsPanel — the "welfare queens" view. A sortable,
 * filterable table of every enumerated spend player (`scan_targets`), so the
 * owner can see at a glance who is about to run up the bill.
 *
 * Data:
 *   - `GET  /api/guardian/offense/targets?bypass=true|false|all&minRisk=N`
 *          → `{ targets: Target[] }` (server orders by last_scan desc).
 *   - `POST /api/guardian/offense/dispatch/{targetId}` (forward-looking, ships
 *          with PR #22) — "Send to Jules audit"; degrades gracefully on 404.
 *
 * Filtering/sorting is done client-side (scan_targets is one row per worker, so
 * a single fetch + in-memory sort beats refetching on every toggle). Default
 * sort is risk_score desc — the loudest players float to the top. A "BYPASS"
 * badge marks AI players spending behind core-guardian's back.
 *
 * Monolith: dark, `bg-card` + `ring-1 ring-border/40`, `divide-y divide-border/40`
 * on the table body (never a 1px cell border). Risk renders as a weighted bar.
 */

"use client";

import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ApiError, apiSend, apiGet } from "@/lib/api";

import { TargetRow, type DispatchState, type Target } from "./RiskTargetRow";
import { EmptyState, InlineError } from "./shared";

type SortKey = "riskScore" | "name" | "lastScan";

// --- Panel ------------------------------------------------------------------

const COLUMNS: { key: SortKey | null; label: string; className?: string }[] = [
  { key: "name", label: "Target" },
  { key: null, label: "Kind" },
  { key: "riskScore", label: "Risk" },
  { key: null, label: "Signals" },
  { key: null, label: "Cron" },
  { key: null, label: "Guardian" },
  { key: "lastScan", label: "Last scan" },
  { key: null, label: "", className: "text-right" },
];

export function RiskTargetsPanel() {
  const [targets, setTargets] = useState<Target[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [bypassOnly, setBypassOnly] = useState(false);
  const [minRisk, setMinRisk] = useState(0);
  const [sortKey, setSortKey] = useState<SortKey>("riskScore");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [dispatch, setDispatch] = useState<Record<string, DispatchState>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Fetch everything once; filter/sort in-memory (small table, snappy toggles).
      const res = await apiGet<{ targets: Target[] }>("/guardian/offense/targets", {
        bypass: "all",
      });
      setTargets(res.targets);
    } catch (err) {
      console.error("RiskTargetsPanel load failed:", err);
      setError(
        err instanceof ApiError && err.status === 401
          ? "Sign in to view risk targets."
          : err instanceof ApiError
            ? err.message
            : "Failed to load risk targets.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const sendToJules = useCallback(async (id: string) => {
    setDispatch((d) => ({ ...d, [id]: { status: "sending" } }));
    try {
      await apiSend("POST", `/guardian/offense/dispatch/${id}`);
      setDispatch((d) => ({ ...d, [id]: { status: "sent" } }));
    } catch (err) {
      // Endpoint ships with PR #22 — a 404 is expected until then, degrade softly.
      if (err instanceof ApiError && err.status === 404) {
        setDispatch((d) => ({
          ...d,
          [id]: { status: "unavailable", message: "Jules dispatch ships with PR #22." },
        }));
        return;
      }
      console.error("RiskTargetsPanel dispatch failed:", err);
      setDispatch((d) => ({
        ...d,
        [id]: {
          status: "error",
          message: err instanceof ApiError ? err.message : "Dispatch failed.",
        },
      }));
    }
  }, []);

  const rows = useMemo(() => {
    let out = targets ?? [];
    if (bypassOnly) out = out.filter((t) => t.bypass?.isBypass === true);
    if (minRisk > 0) out = out.filter((t) => t.riskScore >= minRisk);
    const dir = sortDir === "asc" ? 1 : -1;
    return [...out].sort((a, b) => {
      if (sortKey === "name") return a.name.localeCompare(b.name) * dir;
      const av = sortKey === "riskScore" ? a.riskScore : a.lastScan;
      const bv = sortKey === "riskScore" ? b.riskScore : b.lastScan;
      return (av - bv) * dir;
    });
  }, [targets, bypassOnly, minRisk, sortKey, sortDir]);

  const toggleSort = useCallback(
    (key: SortKey) => {
      if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      else {
        setSortKey(key);
        setSortDir(key === "name" ? "asc" : "desc");
      }
    },
    [sortKey],
  );

  const bypassCount = useMemo(
    () => (targets ?? []).filter((t) => t.bypass?.isBypass === true).length,
    [targets],
  );

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-2xl font-semibold tracking-tight">Risk targets</h2>
          {bypassCount > 0 && <Badge variant="destructive">{bypassCount} bypass</Badge>}
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <label
            htmlFor="risk-bypass-only"
            className="flex items-center gap-2 text-sm text-muted-foreground"
          >
            <Switch
              id="risk-bypass-only"
              checked={bypassOnly}
              onCheckedChange={(c) => setBypassOnly(c)}
            />
            Bypass only
          </label>
          <label
            htmlFor="risk-min-risk"
            className="flex items-center gap-2 text-sm text-muted-foreground"
          >
            Min risk
            <Input
              id="risk-min-risk"
              type="number"
              min={0}
              max={100}
              value={minRisk}
              onChange={(e) =>
                setMinRisk(Math.max(0, Math.min(100, Number(e.target.value) || 0)))
              }
              className="h-8 w-16"
            />
          </label>
        </div>
      </div>

      {loading && !targets ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : error && !targets ? (
        <InlineError message={error} onRetry={load} />
      ) : rows.length === 0 ? (
        <EmptyState
          label={
            (targets ?? []).length === 0
              ? "No players scanned yet — run a scan to enumerate spend targets."
              : "No targets match these filters."
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-xl bg-card ring-1 ring-border/40">
          <Table>
            <TableHeader>
              <TableRow>
                {COLUMNS.map((col, i) => (
                  <TableHead key={col.label || i} className={col.className}>
                    {col.key ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(col.key as SortKey)}
                        className="inline-flex items-center gap-1 hover:text-foreground"
                      >
                        {col.label}
                        {sortKey === col.key &&
                          (sortDir === "asc" ? (
                            <ArrowUpIcon className="size-3" aria-hidden />
                          ) : (
                            <ArrowDownIcon className="size-3" aria-hidden />
                          ))}
                      </button>
                    ) : (
                      col.label
                    )}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody className="divide-y divide-border/40">
              {rows.map((t) => (
                <TargetRow
                  key={t.id}
                  target={t}
                  dispatchState={dispatch[t.id]}
                  onDispatch={(id) => void sendToJules(id)}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
