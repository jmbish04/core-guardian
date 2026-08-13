/**
 * @fileoverview Row + cell visuals for {@link RiskTargetsPanel} — one
 * `scan_targets` player rendered as a table row, plus its weighted risk bar and
 * signal badges. Internal to the dashboard feature (not barrel-exported).
 *
 * Monolith: `bg-card` table, risk bar colour-weighted by score, loud BYPASS
 * badge for AI players spending behind core-guardian's back.
 */

"use client";

import { Loader2Icon, SendIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TableCell, TableRow } from "@/components/ui/table";
import { relativeTime } from "@/lib/format";

// --- Wire shapes (mirror routes/offense.ts targetSchema) --------------------

export interface RiskSignals {
  cron: boolean;
  browser: boolean;
  scraping: boolean;
  d1: boolean;
  vectorize: boolean;
  durableObject: boolean;
  ai: boolean;
}

export interface Target {
  id: string;
  kind: "worker" | "github_action" | "local" | "gas";
  name: string;
  workerName: string | null;
  cronSchedules: string[] | null;
  riskSignals: RiskSignals | null;
  riskScore: number;
  guardianRegistered: boolean;
  bypass: { isBypass: boolean; why: string } | null;
  firstSeen: number;
  lastScan: number;
}

/** Per-row Jules-dispatch lifecycle. `unavailable` = endpoint 404s pre-PR #22. */
export type DispatchState =
  | { status: "sending" }
  | { status: "sent" }
  | { status: "unavailable"; message: string }
  | { status: "error"; message: string };

// --- Static config ----------------------------------------------------------

const KIND_LABEL: Record<Target["kind"], string> = {
  worker: "Worker",
  github_action: "GitHub Action",
  local: "Local",
  gas: "Apps Script",
};

/** Ordered signal → label map; only truthy signals render a badge. */
const SIGNAL_LABELS: [keyof RiskSignals, string][] = [
  ["ai", "AI"],
  ["cron", "cron"],
  ["d1", "D1"],
  ["durableObject", "DurableObject"],
  ["vectorize", "Vectorize"],
  ["browser", "browser"],
  ["scraping", "scraping"],
];

// --- Risk bar ---------------------------------------------------------------

/** Colour-weight the score: hot (>=70) alarm-red, warm (>=40) amber, else muted. */
function riskTone(score: number): { bar: string; text: string } {
  if (score >= 70) return { bar: "bg-destructive", text: "text-destructive" };
  if (score >= 40) return { bar: "bg-amber-500", text: "text-amber-500 dark:text-amber-400" };
  return { bar: "bg-muted-foreground/50", text: "text-muted-foreground" };
}

function RiskBar({ score }: { score: number }) {
  const tone = riskTone(score);
  const pct = Math.max(0, Math.min(100, score));
  return (
    <div className="flex items-center gap-2" title={`risk ${pct} of 100`}>
      <div aria-hidden className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-muted/40">
        <div className={`h-full rounded-full ${tone.bar}`} style={{ width: `${pct}%` }} />
      </div>
      <span className={`w-8 text-right text-sm font-semibold tabular-nums ${tone.text}`}>
        {pct}
      </span>
    </div>
  );
}

function SignalBadges({ signals }: { signals: RiskSignals | null }) {
  if (!signals) return <span className="text-muted-foreground/60">—</span>;
  const on = SIGNAL_LABELS.filter(([k]) => signals[k]);
  if (on.length === 0) return <span className="text-muted-foreground/60">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {on.map(([k, label]) => (
        <Badge key={k} variant={k === "ai" ? "destructive" : "secondary"}>
          {label}
        </Badge>
      ))}
    </div>
  );
}

// --- Row --------------------------------------------------------------------

export function TargetRow({
  target,
  dispatchState,
  onDispatch,
}: {
  target: Target;
  dispatchState: DispatchState | undefined;
  onDispatch: (id: string) => void;
}) {
  const bypass = target.bypass?.isBypass === true;
  return (
    <TableRow className={bypass ? "bg-destructive/5" : undefined}>
      <TableCell>
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">{target.name}</span>
            {bypass && (
              <Badge variant="destructive" title={target.bypass?.why}>
                BYPASS
              </Badge>
            )}
          </div>
          {target.workerName && target.workerName !== target.name && (
            <span className="font-mono text-[11px] text-muted-foreground">
              {target.workerName}
            </span>
          )}
        </div>
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">{KIND_LABEL[target.kind]}</TableCell>
      <TableCell>
        <RiskBar score={target.riskScore} />
      </TableCell>
      <TableCell>
        <SignalBadges signals={target.riskSignals} />
      </TableCell>
      <TableCell>
        {target.cronSchedules?.length ? (
          <div className="flex flex-wrap gap-1">
            {target.cronSchedules.map((c) => (
              <code
                key={c}
                className="rounded bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
              >
                {c}
              </code>
            ))}
          </div>
        ) : (
          <span className="text-muted-foreground/60">—</span>
        )}
      </TableCell>
      <TableCell>
        {target.guardianRegistered ? (
          <Badge variant="secondary">registered</Badge>
        ) : (
          <Badge variant="outline">unseen</Badge>
        )}
      </TableCell>
      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
        {relativeTime(target.lastScan)}
      </TableCell>
      <TableCell className="text-right">
        {dispatchState?.status === "unavailable" ? (
          <span className="text-[11px] text-muted-foreground/70" title={dispatchState.message}>
            audit ships w/ PR #22
          </span>
        ) : dispatchState?.status === "sent" ? (
          <span className="text-[11px] text-emerald-500 dark:text-emerald-400">dispatched</span>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            disabled={dispatchState?.status === "sending"}
            onClick={() => onDispatch(target.id)}
            title={
              dispatchState?.status === "error" ? dispatchState.message : "Send to Jules audit"
            }
          >
            {dispatchState?.status === "sending" ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <>
                <SendIcon className="size-3.5" aria-hidden /> Jules
              </>
            )}
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}
