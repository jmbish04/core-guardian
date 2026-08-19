/**
 * @fileoverview Shared wiring for the Level-3 log pages.
 *
 * The six L3 islands (`L3Logs.tsx`) all do the same three things: fetch ONE real
 * `/api/...` endpoint, seed a filter from the `?query=` drill param, and render
 * token-based status/severity badges. That shared surface lives here so each
 * island stays a thin fetch-and-shape wrapper over `<LogTable>` (never a
 * re-implementation of the grid).
 *
 * L3 ONLY — same firewall as `LogTable`. L1/L2 must not import from here.
 */

"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";

import { createFilter, type Filter } from "@/components/reui/filters";
import { Badge } from "@/components/ui/badge";
import { ApiError, apiGet } from "@/lib/api";

import { type LogFilterValue } from "./LogTable";

/** G1-safe finite coercion for numeric cells. */
export const fin = (n: number | null | undefined): number =>
  Number.isFinite(n) ? (n as number) : 0;

/** Epoch-ms → `YYYY-MM-DD` (UTC day bucket) — matches L2 drill `day:` keys. */
export const dayKey = (ms: number): string => new Date(fin(ms)).toISOString().slice(0, 10);

/**
 * Parse a G5 drill param (`key:value`, e.g. `day:2026-08-15`, `project:foo`).
 * Splits on the FIRST colon so values may themselves contain colons.
 */
export function parseQuery(query?: string | null): { field: string; value: string } | null {
  if (!query) return null;
  const i = query.indexOf(":");
  if (i < 0) return null;
  const field = query.slice(0, i).trim();
  const value = query.slice(i + 1).trim();
  return field && value ? { field, value } : null;
}

/**
 * Turn the drill param into an initial `LogTable` filter, but only for a field
 * this page actually exposes — an unknown key (or no query) seeds nothing.
 */
export function seedFilters(
  query: string | null | undefined,
  allowedFields: string[],
): Filter<LogFilterValue>[] {
  const p = parseQuery(query);
  if (!p || !allowedFields.includes(p.field)) return [];
  return [createFilter<LogFilterValue>(p.field, "is", [p.value])];
}

/** Same G1-guarded single-endpoint fetch the L2 islands use. */
export function useFetch<T>(path: string, params?: Record<string, string | number>) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await apiGet<T>(path, params));
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "Sign in to view this detail."
          : err instanceof ApiError
            ? err.message
            : "Failed to load.",
      );
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, JSON.stringify(params)]);
  useEffect(() => {
    void load();
  }, [load]);
  return { data, loading, error, reload: load };
}

/** Inline error / loading chrome so an island never renders a bare grid mid-fetch. */
export function LogShell({
  loading,
  error,
  onRetry,
  empty,
  children,
}: {
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  empty: boolean;
  children: ReactNode;
}) {
  if (error) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-lg bg-card p-6 ring-1 ring-border/60">
        <p className="text-sm text-muted-foreground">{error}</p>
        <button
          type="button"
          onClick={onRetry}
          className="text-xs font-medium text-foreground underline underline-offset-4"
        >
          Retry
        </button>
      </div>
    );
  }
  if (loading && empty) {
    return <div className="h-64 w-full animate-pulse rounded-lg bg-muted/20" />;
  }
  return <>{children}</>;
}

// --- token-based status / severity badges -----------------------------------
// Mirrors the repo's existing GuardianAuditLog convention (outline + amber for
// the "warning" middle state; destructive/secondary for the poles).

/** Guardian alert severity → badge. */
export function SeverityBadge({ value }: { value: "info" | "warning" | "critical" | string }) {
  if (value === "critical") return <Badge variant="destructive" className="capitalize">critical</Badge>;
  if (value === "warning")
    return (
      <Badge variant="outline" className="capitalize border-amber-500/30 text-amber-700 dark:text-amber-400">
        warning
      </Badge>
    );
  return <Badge variant="secondary" className="capitalize">{value || "info"}</Badge>;
}

/** AI-Router request outcome → badge (error / circuit-broken / ok). */
export function OutcomeBadge({
  isError,
  isCircuitBreaker,
}: {
  isError?: boolean;
  isCircuitBreaker?: boolean;
}) {
  if (isCircuitBreaker)
    return (
      <Badge variant="outline" className="border-amber-500/30 text-amber-700 dark:text-amber-400">
        Circuit
      </Badge>
    );
  if (isError) return <Badge variant="destructive">Error</Badge>;
  return <Badge variant="secondary">OK</Badge>;
}

/** Generic status pill (alert lifecycle). */
export function StatusBadge({ value }: { value: string }) {
  const variant =
    value === "active" ? "outline" : value === "resolved" ? "secondary" : "secondary";
  return <Badge variant={variant} className="capitalize">{value}</Badge>;
}
