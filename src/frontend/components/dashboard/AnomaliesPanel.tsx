/**
 * @fileoverview Anomalies panel — the star of the Spend Offense dashboard and
 * the direct fix for the $600 miss.
 *
 * Renders the ranked recurrence anomalies from `GET /guardian/billing/insights`
 * (already sorted by `streakTotalUsd` desc) as one scannable sentence per row:
 *
 *   "gpt-oss-120b — 5 days running · $110.00 total · daily · project codex ·
 *    $22.00/day · 1.2k neurons/day · 340 calls"
 *
 * A recurring drip is meant to be UNMISSABLE, so a row whose accumulated streak
 * total is high goes LOUD (destructive ring + tint). Where an anomaly carries a
 * `project`, the fix sits one click away: Freeze / Lock month / Set budget /
 * Unfreeze, each POSTing to `/controls/project-circuit` and refetching the
 * insights on success. Anomalies with no project attribution show why controls
 * aren't available instead of a dead button.
 *
 * Presentational only — the parent (`SpendHeadline`) owns the single fetch so
 * the "since last visit" marker isn't double-recorded; `onActed` asks it to
 * refetch after a control lands.
 */

"use client";

import { AlertTriangle, CheckCircle2, Loader2Icon, ShieldOff } from "lucide-react";
import { useState } from "react";

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
import { Badge } from "@/components/ui/badge";
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
import { ApiError, apiSend } from "@/lib/api";
import { formatCount, usd } from "@/lib/format";

import { SectionTitle } from "./shared";

/** One anomaly row from `GET /guardian/billing/insights`. */
export interface Anomaly {
  source: "router" | "workers-ai-neurons";
  model: string;
  provider: string | null;
  project: string | null;
  streakDays: number;
  streakTotalUsd: number;
  perDayUsd: number;
  cadence: "hourly" | "daily" | "weekly" | "sporadic";
  callCount: number | null;
  neuronsPerDay: number | null;
  lastDay: string;
}

type Action = "set-budget" | "lock-month" | "freeze" | "unfreeze";

/** Streak total at/above this goes LOUD — the recurring drip must not read as a static bug. */
const LOUD_USD = 50;

/** Human success line shown inline after a control lands. */
function successLine(project: string, action: Action, budgetUsd?: number): string {
  switch (action) {
    case "freeze":
      return `${project} frozen — AI blocked until you unfreeze`;
    case "lock-month":
      return `${project} locked for the month — $0 cap`;
    case "set-budget":
      return `${project} capped at ${usd(budgetUsd ?? 0)}/month`;
    case "unfreeze":
      return `${project} unfrozen — controls lifted`;
  }
}

type Result = { ok: boolean; msg: string };

export function AnomaliesPanel({
  anomalies,
  onActed,
}: {
  anomalies: Anomaly[];
  onActed: () => void;
}) {
  // Action state is keyed by project (the control's scope), so every anomaly
  // row sharing that project reflects the same busy/result. Survives the
  // parent's post-action refetch because this component isn't remounted.
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, Result>>({});

  async function runControl(project: string, action: Action, budgetUsd?: number) {
    setBusy(project);
    try {
      await apiSend("POST", "/guardian/billing/controls/project-circuit", {
        project,
        action,
        ...(budgetUsd !== undefined ? { budgetUsd } : {}),
      });
      setResults((r) => ({ ...r, [project]: { ok: true, msg: successLine(project, action, budgetUsd) } }));
      onActed();
    } catch (err) {
      setResults((r) => ({
        ...r,
        [project]: { ok: false, msg: err instanceof ApiError ? err.message : "Action failed." },
      }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <SectionTitle>Recurring spend anomalies</SectionTitle>
        <p className="text-sm text-muted-foreground">
          Ranked by accumulated total. A daily drip shows as days-running and a running
          sum here — not a static per-day figure.
        </p>
      </div>

      {anomalies.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-md bg-emerald-500/10 px-4 py-10 text-center ring-1 ring-emerald-500/30">
          <CheckCircle2 className="size-5 text-emerald-500" aria-hidden />
          <p className="text-sm text-emerald-600 dark:text-emerald-400">
            No recurring spend anomalies — nothing accumulating.
          </p>
        </div>
      ) : (
        anomalies.map((a, i) => (
          <AnomalyCard
            key={`${a.source}:${a.model}:${a.project ?? "none"}:${i}`}
            a={a}
            busy={a.project ? busy === a.project : false}
            result={a.project ? results[a.project] : undefined}
            onRun={runControl}
          />
        ))
      )}
    </section>
  );
}

function AnomalyCard({
  a,
  busy,
  result,
  onRun,
}: {
  a: Anomaly;
  busy: boolean;
  result?: Result;
  onRun: (project: string, action: Action, budgetUsd?: number) => void;
}) {
  const loud = a.streakTotalUsd >= LOUD_USD;
  return (
    <div
      className={
        loud
          ? "rounded-xl bg-destructive/10 p-5 ring-1 ring-destructive/40"
          : "rounded-xl bg-card p-5 ring-1 ring-border/40"
      }
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {/* The sentence. */}
          <p className="text-sm leading-relaxed">
            {loud ? (
              <AlertTriangle className="mr-1 inline size-4 -translate-y-0.5 text-destructive" aria-hidden />
            ) : null}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-foreground">
              {a.model}
            </code>{" "}
            —{" "}
            <span className={loud ? "font-semibold text-destructive" : "font-semibold text-foreground"}>
              {a.streakDays} day{a.streakDays === 1 ? "" : "s"} running
            </span>{" "}
            ·{" "}
            <span className={loud ? "font-semibold text-destructive" : "font-semibold text-foreground"}>
              {usd(a.streakTotalUsd)} total
            </span>{" "}
            · {a.cadence} ·{" "}
            {a.project ? (
              <>
                project <span className="font-medium text-foreground">{a.project}</span>
              </>
            ) : (
              <span className="text-muted-foreground">no project attribution</span>
            )}{" "}
            · {usd(a.perDayUsd)}/day
            {a.neuronsPerDay ? <> · {formatCount(a.neuronsPerDay)} neurons/day</> : null}
            {a.callCount ? <> · {formatCount(a.callCount)} calls</> : null}
          </p>
          <p className="mt-1.5 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            <span>last active {a.lastDay}</span>
            <Badge variant="secondary" className="font-mono text-[10px]">
              {a.source === "router" ? "AI Router" : "direct Workers-AI"}
            </Badge>
          </p>
        </div>
      </div>

      {/* Fix, one click away — only where a project scopes the circuit. */}
      {a.project ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <ConfirmAction
            trigger={
              <Button variant="destructive" size="sm" disabled={busy}>
                {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : <ShieldOff className="size-3.5" />}
                Freeze
              </Button>
            }
            title={`Freeze ${a.project}?`}
            body={`Blocks this project's AI (sets a sticky $0 all-time cap) until you unfreeze. In-flight calls fail closed.`}
            confirmLabel="Freeze — block AI"
            onConfirm={() => onRun(a.project!, "freeze")}
          />
          <ConfirmAction
            trigger={
              <Button variant="outline" size="sm" disabled={busy}>
                Lock month
              </Button>
            }
            title={`Lock ${a.project} for the month?`}
            body="Sets a $0 monthly cap — stops this project's AI spend for the rest of the calendar month. Resets next month."
            confirmLabel="Lock for the month"
            onConfirm={() => onRun(a.project!, "lock-month")}
          />
          <SetBudgetDialog project={a.project} busy={busy} onSet={(v) => onRun(a.project!, "set-budget", v)} />
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => onRun(a.project!, "unfreeze")}>
            Unfreeze
          </Button>
        </div>
      ) : (
        <p className="mt-4 text-xs text-muted-foreground">
          No project attribution — route this through core-guardian to enable one-click controls.
        </p>
      )}

      {result ? (
        <p
          className={
            result.ok
              ? "mt-3 flex items-center gap-2 text-xs text-emerald-600 dark:text-emerald-400"
              : "mt-3 flex items-center gap-2 text-xs text-destructive"
          }
        >
          {result.ok ? (
            <CheckCircle2 className="size-3.5" aria-hidden />
          ) : (
            <AlertTriangle className="size-3.5" aria-hidden />
          )}
          {result.msg}
        </p>
      ) : null}
    </div>
  );
}

/** AlertDialog-gated one-click action (Freeze / Lock month). */
function ConfirmAction({
  trigger,
  title,
  body,
  confirmLabel,
  onConfirm,
}: {
  trigger: React.ReactNode;
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{confirmLabel}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Dialog with a single number input → set-budget. */
function SetBudgetDialog({
  project,
  busy,
  onSet,
}: {
  project: string;
  busy: boolean;
  onSet: (budgetUsd: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const parsed = Number(value);
  const valid = value.trim() !== "" && Number.isFinite(parsed) && parsed >= 0;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={busy}>
          Set budget
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set a monthly budget for {project}</DialogTitle>
          <DialogDescription>
            Caps this project's AI spend at the amount below for the current month. Spend
            past it fails closed until next month or you raise the cap.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 py-2">
          <Label htmlFor={`budget-${project}`}>Monthly cap (USD)</Label>
          <Input
            id={`budget-${project}`}
            type="number"
            min={0}
            step="0.01"
            inputMode="decimal"
            placeholder="e.g. 25"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            disabled={!valid}
            onClick={() => {
              setOpen(false);
              onSet(parsed);
            }}
          >
            Set {valid ? usd(parsed) : ""} cap
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
