/**
 * @fileoverview IncidentsPanel — "what got caught". The alarm surface of the
 * Spend Offense system: the live `circuit_break_events` the offense engine files
 * when something runs up (or is about to run up) the bill.
 *
 * Data:
 *   - `GET  /api/guardian/offense/incidents?status=active|read|erroneous|all`
 *          → `{ incidents: Incident[] }` (newest first).
 *   - `POST /api/guardian/offense/incidents/{id}/resolve` body
 *          `{ action:"read"|"erroneous" }`
 *          → `{ incident, killSwitchLifted, circuitLifted? }`.
 *
 * Behaviour:
 *   - Active incidents render LOUD (alarm-red ring + tint) — this is the thing a
 *     busy owner must not miss at a weekly glance.
 *   - "Mark read" acknowledges but leaves the breaker live (stays visible).
 *   - "Mark erroneous / restore" is a false-positive that LIFTS the breaker; it is
 *     gated behind a shadcn AlertDialog because it re-opens spend.
 *   - The resolve response's `killSwitchLifted` / `circuitLifted` (the latter
 *     ships with PR #22 and may be absent) surface as an inline confirmation.
 *   - Empty state is positive — no incidents means nothing runaway got caught.
 *
 * Monolith: dark, `bg-card` + `ring-1 ring-border/40` (never a 1px border);
 * errors route through the shared InlineError (which console.errors for the
 * global ErrorLogger).
 */

"use client";

import {
  AlertOctagonIcon,
  CheckCircle2Icon,
  ExternalLinkIcon,
  Loader2Icon,
  ShieldOffIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, apiGet, apiSend } from "@/lib/api";
import { relativeTime, shortDate } from "@/lib/format";

import { EmptyState, InlineError } from "./shared";

// --- Wire shapes (mirror routes/offense.ts incidentSchema) ------------------

type IncidentSource = "scanner" | "jules" | "auto_spend" | "budget_cap" | "infra_spike";
type IncidentStatus = "active" | "read" | "erroneous";
type StatusFilter = IncidentStatus | "all";

interface IncidentAction {
  kind: string;
  detail: string;
  at: number;
}

interface Incident {
  id: string;
  projectIdentification: Record<string, unknown> | null;
  scope: string | null;
  reason: string;
  source: IncidentSource;
  status: IncidentStatus;
  julesPr: string | null;
  actionsTaken: IncidentAction[] | null;
  recommendation: { summary?: string; details?: Record<string, unknown> } | null;
  createdAt: number;
  resolvedAt: number | null;
}

/** Resolve response. `circuitLifted` ships with PR #22 — treat as optional. */
interface ResolveResult {
  incident: Incident;
  killSwitchLifted: boolean;
  circuitLifted?: boolean;
}

// --- Static config ----------------------------------------------------------

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "read", label: "Acknowledged" },
  { value: "erroneous", label: "Dismissed" },
  { value: "all", label: "All" },
];

/** Human label for the incident source badge. */
const SOURCE_LABEL: Record<IncidentSource, string> = {
  auto_spend: "Auto-spend guard",
  budget_cap: "Budget cap",
  infra_spike: "Infra spike",
  jules: "Jules audit",
  scanner: "Scanner",
};

/** Human label for a recorded automated action's machine tag. */
function actionLabel(kind: string): string {
  switch (kind) {
    case "kill_switch":
      return "Kill switch";
    case "circuit_break":
      return "Circuit break";
    case "jules_action":
      return "Jules action";
    default:
      return kind.replace(/_/g, " ");
  }
}

// --- One incident card ------------------------------------------------------

function IncidentCard({
  incident,
  busy,
  onRead,
  onConfirmErroneous,
}: {
  incident: Incident;
  busy: boolean;
  onRead: (id: string) => void;
  onConfirmErroneous: (incident: Incident) => void;
}) {
  const active = incident.status === "active";
  const dismissed = incident.status === "erroneous";
  const prHref = incident.julesPr && /^https?:\/\//.test(incident.julesPr) ? incident.julesPr : null;

  return (
    <div
      role={active ? "alert" : undefined}
      className={[
        "flex flex-col gap-3 rounded-xl p-4 ring-1",
        active
          ? "bg-destructive/15 ring-destructive/50"
          : dismissed
            ? "bg-card/60 opacity-70 ring-border/40"
            : "bg-card ring-border/40",
      ].join(" ")}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {active && (
            <AlertOctagonIcon className="size-4 shrink-0 text-destructive" aria-hidden />
          )}
          <Badge variant={active ? "destructive" : "secondary"}>
            {SOURCE_LABEL[incident.source]}
          </Badge>
          {incident.scope && (
            <span className="font-mono text-[11px] text-muted-foreground">{incident.scope}</span>
          )}
          {incident.status !== "active" && (
            <Badge variant="outline" className="capitalize">
              {incident.status === "read" ? "acknowledged" : "dismissed"}
            </Badge>
          )}
        </div>
        <span
          className="font-mono text-[11px] text-muted-foreground"
          title={new Date(incident.createdAt).toISOString()}
        >
          {shortDate(incident.createdAt)} · {relativeTime(incident.createdAt)}
        </span>
      </div>

      <p className={active ? "text-sm font-medium text-destructive" : "text-sm font-medium"}>
        {incident.reason}
      </p>

      {incident.recommendation?.summary && (
        <p className="text-sm text-muted-foreground">→ {incident.recommendation.summary}</p>
      )}

      {(incident.actionsTaken?.length || prHref || incident.julesPr) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {incident.actionsTaken?.map((a, i) => (
            <Badge key={`${a.kind}-${i}`} variant="outline" title={a.detail}>
              {actionLabel(a.kind)}
            </Badge>
          ))}
          {prHref ? (
            <a
              href={prHref}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-4xl px-2 py-0.5 text-xs font-medium text-primary ring-1 ring-border/40 hover:bg-muted"
            >
              Jules PR <ExternalLinkIcon className="size-3" aria-hidden />
            </a>
          ) : (
            incident.julesPr && (
              <Badge variant="outline">Jules PR {incident.julesPr}</Badge>
            )
          )}
        </div>
      )}

      {/* Resolve actions — only while the breaker is still live (active/read). */}
      {incident.status !== "erroneous" && (
        <div className="flex flex-wrap gap-2 pt-1">
          {incident.status === "active" && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => onRead(incident.id)}
            >
              {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : "Mark read"}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            className="text-muted-foreground hover:text-foreground"
            onClick={() => onConfirmErroneous(incident)}
          >
            <ShieldOffIcon className="size-3.5" aria-hidden /> Mark erroneous / restore
          </Button>
        </div>
      )}
    </div>
  );
}

// --- Panel ------------------------------------------------------------------

export function IncidentsPanel() {
  const [status, setStatus] = useState<StatusFilter>("active");
  const [incidents, setIncidents] = useState<Incident[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<Incident | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiGet<{ incidents: Incident[] }>("/guardian/offense/incidents", {
        status,
      });
      setIncidents(res.incidents);
    } catch (err) {
      console.error("IncidentsPanel load failed:", err);
      setError(
        err instanceof ApiError && err.status === 401
          ? "Sign in to view incidents."
          : err instanceof ApiError
            ? err.message
            : "Failed to load incidents.",
      );
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  const resolve = useCallback(
    async (id: string, action: "read" | "erroneous") => {
      setBusyId(id);
      setNotice(null);
      try {
        const res = await apiSend<ResolveResult>(
          "POST",
          `/guardian/offense/incidents/${id}/resolve`,
          { action },
        );
        const lifted = [
          res.killSwitchLifted ? "kill switch lifted" : null,
          res.circuitLifted ? "circuit breaker lifted" : null,
        ].filter(Boolean);
        setNotice(
          action === "erroneous"
            ? `Incident dismissed as erroneous${lifted.length ? ` — ${lifted.join(", ")}` : ""}.`
            : "Incident acknowledged — breaker stays live.",
        );
        await load();
      } catch (err) {
        console.error("IncidentsPanel resolve failed:", err);
        setNotice(
          err instanceof ApiError ? `Resolve failed: ${err.message}` : "Resolve failed.",
        );
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  const activeCount = useMemo(
    () => (incidents ?? []).filter((i) => i.status === "active").length,
    [incidents],
  );

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-2xl font-semibold tracking-tight">Incidents</h2>
          {activeCount > 0 && status !== "erroneous" && (
            <Badge variant="destructive">{activeCount} active</Badge>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {STATUS_FILTERS.map((f) => (
            <Button
              key={f.value}
              size="sm"
              variant={status === f.value ? "default" : "outline"}
              onClick={() => setStatus(f.value)}
            >
              {f.label}
            </Button>
          ))}
        </div>
      </div>

      {notice && (
        <div className="flex items-center gap-2 rounded-lg bg-muted/30 px-3 py-2 text-xs text-muted-foreground ring-1 ring-border/40">
          <CheckCircle2Icon className="size-3.5" aria-hidden />
          {notice}
        </div>
      )}

      {loading && !incidents ? (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
      ) : error && !incidents ? (
        <InlineError message={error} onRetry={load} />
      ) : (incidents ?? []).length === 0 ? (
        <EmptyState
          label={
            status === "active"
              ? "No incidents — nothing runaway caught."
              : "No incidents in this view."
          }
        />
      ) : (
        <div className="flex flex-col gap-3">
          {incidents?.map((incident) => (
            <IncidentCard
              key={incident.id}
              incident={incident}
              busy={busyId === incident.id}
              onRead={(id) => void resolve(id, "read")}
              onConfirmErroneous={setConfirmTarget}
            />
          ))}
        </div>
      )}

      {/* Erroneous is a breaker-lifting action → confirm before re-opening spend. */}
      <AlertDialog
        open={confirmTarget != null}
        onOpenChange={(open) => !open && setConfirmTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mark incident erroneous?</AlertDialogTitle>
            <AlertDialogDescription>
              This flags the incident a false positive and lifts any breaker it
              engaged (kill switch / circuit), re-opening the affected spend path.
              {confirmTarget?.reason ? ` Incident: “${confirmTarget.reason}”.` : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmTarget) void resolve(confirmTarget.id, "erroneous");
                setConfirmTarget(null);
              }}
            >
              Mark erroneous & restore
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
