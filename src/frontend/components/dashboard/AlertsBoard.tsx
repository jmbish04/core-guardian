/**
 * @fileoverview Alerts board — the actionable advisory surface, severity-first.
 *
 * Reads `/api/guardian/alerts`: each alert names the resource, its owning
 * worker, the diagnosed cause, a recommendation, and the projected USD overage,
 * with snooze/resolve controls. Grouped under a severity summary card so the
 * one thing on fire is not buried under things merely trending.
 */

"use client";

import { Loader2Icon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { ProgressCircle, type Tone } from "@/components/charts";

/** Alert severity → chart tone. */
const SEV_TONE: Record<"info" | "warning" | "critical", Tone> = {
  info: "sky",
  warning: "amber",
  critical: "rose",
};
import { Button } from "@/components/ui/button";
import { ApiError, apiGet, apiSend } from "@/lib/api";
import { relativeTime } from "@/lib/format";

type Alert = {
  id: string;
  service: string;
  resource: string;
  worker: string | null;
  severity: "info" | "warning" | "critical";
  cause: string;
  recommendation: string;
  projectedFraction: number | null;
  estCostDelta: number | null;
  status: "active" | "snoozed" | "resolved";
  snoozedUntil: number | null;
  updatedAt: number;
};

type Payload = {
  alerts: Alert[];
  counts: { critical: number; warning: number; info: number };
};

const PANEL = "rounded-xl border border-border/60 bg-background/40 p-6";

const SEV: Record<Alert["severity"], { label: string; ring: string; text: string; dot: string }> = {
  critical: {
    label: "Critical",
    ring: "ring-rose-500/30",
    text: "text-rose-600 dark:text-rose-400",
    dot: "bg-rose-500",
  },
  warning: {
    label: "Warning",
    ring: "ring-amber-500/30",
    text: "text-amber-600 dark:text-amber-400",
    dot: "bg-amber-500",
  },
  info: {
    label: "Info",
    ring: "ring-sky-500/30",
    text: "text-sky-600 dark:text-sky-400",
    dot: "bg-sky-500",
  },
};

export function AlertsBoard() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await apiGet<Payload>("/guardian/alerts?status=all"));
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "Sign in to view alerts."
          : err instanceof ApiError
            ? err.message
            : "Failed to load alerts.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(id: string, action: "snooze" | "resolve" | "reactivate") {
    setBusy(id);
    try {
      await apiSend("POST", `/guardian/alerts/${encodeURIComponent(id)}/action`, {
        action,
        ...(action === "snooze" ? { hours: 24 } : {}),
      });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Action failed.");
    } finally {
      setBusy(null);
    }
  }

  if (error && !data) return <p className={`${PANEL} text-sm text-muted-foreground`}>{error}</p>;
  if (loading && !data)
    return (
      <div className={`${PANEL} flex items-center gap-2 text-sm text-muted-foreground`}>
        <Loader2Icon className="size-4 animate-spin" /> Loading alerts…
      </div>
    );
  if (!data) return null;

  const active = data.alerts.filter((a) => a.status === "active");
  const muted = data.alerts.filter((a) => a.status !== "active");
  const allClear = active.length === 0;

  return (
    <section className="flex flex-col gap-4">
      {/* Severity summary card */}
      <div className={`${PANEL} ring-1 ${allClear ? "ring-emerald-500/30" : SEV[active[0].severity].ring}`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
              Governance
            </div>
            <h2 className="mt-1 text-2xl font-semibold tracking-tight">
              {allClear ? "All clear" : `${active.length} active alert${active.length > 1 ? "s" : ""}`}
            </h2>
          </div>
          <div className="flex gap-4 text-sm">
            {(["critical", "warning", "info"] as const).map((sev) => (
              <div key={sev} className="flex items-center gap-2">
                <span className={`size-2 rounded-full ${SEV[sev].dot}`} />
                <span className="tabular-nums">{data.counts[sev]}</span>
                <span className="text-muted-foreground">{SEV[sev].label}</span>
              </div>
            ))}
          </div>
        </div>
        {allClear && (
          <p className="mt-2 text-sm text-muted-foreground">
            Nothing is projected to cross its included allowance this period.
          </p>
        )}
      </div>

      {error && <p className={`${PANEL} text-sm text-destructive`}>{error}</p>}

      {/* Active alerts, severity order (server-sorted) */}
      {active.map((a) => (
        <AlertCard key={a.id} a={a} busy={busy === a.id} onAct={act} />
      ))}

      {/* Snoozed / resolved, collapsed at the bottom */}
      {muted.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            {muted.length} snoozed / resolved
          </summary>
          <div className="mt-3 flex flex-col gap-3">
            {muted.map((a) => (
              <AlertCard key={a.id} a={a} busy={busy === a.id} onAct={act} />
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

function AlertCard({
  a,
  busy,
  onAct,
}: {
  a: Alert;
  busy: boolean;
  onAct: (id: string, action: "snooze" | "resolve" | "reactivate") => void;
}) {
  const sev = SEV[a.severity];
  const pct = a.projectedFraction !== null ? Math.round(a.projectedFraction * 100) : null;
  return (
    <div className={`${PANEL} ring-1 ${sev.ring} ${a.status !== "active" ? "opacity-60" : ""}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`size-2 rounded-full ${sev.dot}`} />
            <span className={`font-mono text-[10px] uppercase tracking-[0.2em] ${sev.text}`}>
              {sev.label}
            </span>
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              {a.service}
            </span>
            {a.status === "snoozed" && a.snoozedUntil && (
              <span className="font-mono text-[10px] text-muted-foreground">
                snoozed · {relativeTime(a.snoozedUntil)}
              </span>
            )}
          </div>
          <h3 className="mt-1 truncate text-base font-medium">{a.resource}</h3>
          {a.worker && (
            <p className="font-mono text-xs text-muted-foreground">worker: {a.worker}</p>
          )}
          <p className="mt-2 text-sm text-muted-foreground">{a.cause}</p>
          <p className="mt-1 text-sm">{a.recommendation}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          {pct !== null && (
            <ProgressCircle
              value={pct}
              centerLabel={pct >= 1000 ? `${(pct / 100).toFixed(0)}×` : `${pct}%`}
              tone={SEV_TONE[a.severity]}
              size={72}
              compact
            />
          )}
          {a.estCostDelta ? (
            <span className="font-mono text-xs text-muted-foreground">
              ≈ ${a.estCostDelta.toFixed(2)} overage
            </span>
          ) : null}
          <div className="mt-1 flex gap-1">
            {a.status === "active" ? (
              <>
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={busy} onClick={() => onAct(a.id, "snooze")}>
                  Snooze 24h
                </Button>
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={busy} onClick={() => onAct(a.id, "resolve")}>
                  Resolve
                </Button>
              </>
            ) : (
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={busy} onClick={() => onAct(a.id, "reactivate")}>
                Reactivate
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
