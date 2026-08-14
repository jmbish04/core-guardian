/**
 * @fileoverview Shared primitives for the Projects + Jules feature islands.
 *
 * Monolith-compliant colour pills (ring-inset, no 1px borders), a tiny
 * data-loading hook that centralises the LOADING / ERROR / reload dance, and an
 * inline status banner for POST feedback. Everything here is presentational or
 * a thin state helper — the API wiring lives in the island components.
 */

"use client";

import { Loader2Icon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { cn } from "@/lib/utils";
import { ApiError } from "@/lib/api";

export type Kind = "worker" | "ai_project" | "py" | "gas" | "other";
export type Criticality = "hobby" | "normal" | "important" | "critical";
export type JulesStatus =
  | "pending"
  | "running"
  | "stuck"
  | "submitted"
  | "failed"
  | "completed";

export type Project = {
  name: string;
  kind: Kind;
  repo: string | null;
  isActive: boolean;
  lastSeen: number;
  note: string | null;
  criticality: Criticality;
  createdAt: number;
  spendThisMonthUsd: number;
};

export type JulesSession = {
  id: string;
  sessionId: string | null;
  dispatchId?: string | null;
  project: string | null;
  repo: string;
  status: JulesStatus;
  sessionUrl: string | null;
  prUrl: string | null;
  createdAt: number;
  updatedAt: number;
};

/** Current AI Router circuit for a project (CIRCUITS KV). Loosely typed. */
export type Circuit = {
  budgetUsd?: number;
  window?: string;
  enabled?: boolean;
} | null;

// ---------------------------------------------------------------------------
// Colour pills — ring-inset, Monolith palette. One <Pill>, three lookup maps.
// ---------------------------------------------------------------------------

function Pill({ tone, children }: { tone: string; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
        tone,
      )}
    >
      {children}
    </span>
  );
}

const KIND_TONE: Record<Kind, string> = {
  worker: "bg-violet-500/10 text-violet-300 ring-violet-500/30",
  ai_project: "bg-cyan-500/10 text-cyan-300 ring-cyan-500/30",
  py: "bg-yellow-500/10 text-yellow-300 ring-yellow-500/30",
  gas: "bg-emerald-500/10 text-emerald-300 ring-emerald-500/30",
  other: "bg-muted/40 text-muted-foreground ring-border/40",
};
const KIND_LABEL: Record<Kind, string> = {
  worker: "worker",
  ai_project: "ai project",
  py: "python",
  gas: "apps script",
  other: "other",
};

export function KindBadge({ kind }: { kind: Kind }) {
  return <Pill tone={KIND_TONE[kind]}>{KIND_LABEL[kind]}</Pill>;
}

// hobby → critical, cool → hot.
const CRIT_TONE: Record<Criticality, string> = {
  hobby: "bg-muted/40 text-muted-foreground ring-border/40",
  normal: "bg-sky-500/10 text-sky-300 ring-sky-500/30",
  important: "bg-amber-500/10 text-amber-300 ring-amber-500/30",
  critical: "bg-red-500/15 text-red-300 ring-red-500/40",
};

export function CriticalityBadge({ criticality }: { criticality: Criticality }) {
  return <Pill tone={CRIT_TONE[criticality]}>{criticality}</Pill>;
}

const STATUS_TONE: Record<JulesStatus, string> = {
  pending: "bg-muted/40 text-muted-foreground ring-border/40",
  running: "bg-sky-500/10 text-sky-300 ring-sky-500/30",
  stuck: "bg-amber-500/10 text-amber-300 ring-amber-500/30",
  submitted: "bg-violet-500/10 text-violet-300 ring-violet-500/30",
  failed: "bg-red-500/15 text-red-300 ring-red-500/40",
  completed: "bg-emerald-500/10 text-emerald-300 ring-emerald-500/30",
};

export function JulesStatusBadge({ status }: { status: JulesStatus }) {
  return (
    <Pill tone={STATUS_TONE[status]}>
      {status === "running" ? (
        <span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden />
      ) : null}
      {status}
    </Pill>
  );
}

/** Active / inactive pill for a project. */
export function ActivePill({ active }: { active: boolean }) {
  return active ? (
    <Pill tone="bg-emerald-500/10 text-emerald-300 ring-emerald-500/30">active</Pill>
  ) : (
    <Pill tone="bg-muted/40 text-muted-foreground ring-border/40">inactive</Pill>
  );
}

// ---------------------------------------------------------------------------
// Inline status banner — POST feedback (success emerald / error destructive).
// ---------------------------------------------------------------------------

export type Status = { kind: "success" | "error"; message: string } | null;

export function StatusBanner({ status, className }: { status: Status; className?: string }) {
  if (!status) return null;
  const success = status.kind === "success";
  return (
    <output
      aria-live="polite"
      className={cn(
        "flex items-start gap-3 rounded-md p-3 text-sm ring-1 ring-inset",
        success
          ? "bg-emerald-500/10 text-emerald-300 ring-emerald-500/30"
          : "bg-destructive/10 text-destructive ring-destructive/30",
        className,
      )}
    >
      <span>{status.message}</span>
    </output>
  );
}

/** Centred spinner row for the LOADING state. */
export function LoadingRow({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-2 rounded-md bg-muted/20 px-4 py-10 text-sm text-muted-foreground ring-1 ring-border/40">
      <Loader2Icon className="size-4 animate-spin" aria-hidden /> {label}
    </div>
  );
}

// ---------------------------------------------------------------------------
// useResource — GET once, expose { data, loading, error, reload, setData }.
// Pass a `useCallback`-stable fetcher; reload re-runs it.
// ---------------------------------------------------------------------------

export function useResource<T>(fetcher: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    fetcher()
      .then(setData)
      .catch((e) =>
        setError(
          e instanceof ApiError && e.status === 401
            ? "Sign in to view this."
            : e instanceof ApiError
              ? e.message
              : "Failed to load.",
        ),
      )
      .finally(() => setLoading(false));
  }, [fetcher]);

  useEffect(() => reload(), [reload]);

  return { data, loading, error, reload, setData };
}
