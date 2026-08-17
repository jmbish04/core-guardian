/**
 * @fileoverview The one-click "switch to this model" action.
 *
 * A shadcn AlertDialog confirming a Jules dispatch that swaps a project's
 * (or every project's) AI model in code and opens a PR the owner reviews. The
 * owner picks a scope — just this project, or every project still on the
 * expensive model — then confirms. The dispatch result is surfaced inline
 * (each repo's ok/error) with a link to track the Jules session; no
 * window.confirm, no silent failure.
 */

"use client";

import { CheckCircle2Icon, Loader2Icon, XCircleIcon } from "lucide-react";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { ApiError, apiSend } from "@/lib/api";

type Scope = "project" | "global";

type SwitchDispatch = {
  repo: string;
  project: string | null;
  ok: boolean;
  dispatchId: string | null;
  julesSessionId: string | null;
  error?: string;
};
type SwitchResult = {
  scope: Scope;
  fromModel: string;
  toModel: string;
  dispatches: SwitchDispatch[];
  eventId: string;
  timestamp: number;
};

/** One dispatch outcome line: repo + ok/error. */
function DispatchLine({ d }: { d: SwitchDispatch }) {
  return (
    <li className="flex items-start gap-2 py-1.5 text-xs">
      {d.ok ? (
        <CheckCircle2Icon className="mt-0.5 size-3.5 shrink-0 text-emerald-500" aria-hidden />
      ) : (
        <XCircleIcon className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />
      )}
      <div className="min-w-0">
        <div className="truncate font-mono text-foreground">{d.repo}</div>
        {d.ok ? (
          <div className="text-muted-foreground">Jules session dispatched</div>
        ) : (
          <div className="text-destructive">{d.error ?? "dispatch failed"}</div>
        )}
      </div>
    </li>
  );
}

export function AiModelSwitchDialog({
  project,
  currentModel,
  altModel,
  altProvider,
  savingsUsd,
  usdFmt,
}: {
  project: string;
  currentModel: string;
  altModel: string;
  altProvider: string;
  savingsUsd: number;
  usdFmt: (n: number) => string;
}) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<Scope>("project");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SwitchResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reset transient state whenever the dialog opens fresh.
  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setScope("project");
      setResult(null);
      setError(null);
    }
  }

  async function confirm() {
    setSubmitting(true);
    setError(null);
    try {
      const r = await apiSend<SwitchResult>("POST", "/guardian/billing/ai-recommendations/switch", {
        project,
        fromModel: currentModel,
        toModel: altModel,
        scope,
      });
      setResult(r);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 400
          ? err.message
          : err instanceof ApiError
            ? err.message
            : "Failed to dispatch the switch.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  const okCount = result?.dispatches.filter((d) => d.ok).length ?? 0;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs">
          Switch to this model
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent className="max-w-md">
        {result ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {okCount}/{result.dispatches.length} Jules session
                {result.dispatches.length === 1 ? "" : "s"} dispatched
              </AlertDialogTitle>
              <AlertDialogDescription>
                Each opens a PR that swaps{" "}
                <span className="font-mono text-foreground">{result.fromModel}</span> →{" "}
                <span className="font-mono text-foreground">{result.toModel}</span>. You review and
                merge.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <ul className="max-h-56 divide-y divide-border/40 overflow-y-auto rounded-lg bg-muted/20 px-3 ring-1 ring-border/40">
              {result.dispatches.map((d) => (
                <DispatchLine key={`${d.repo}:${d.project ?? ""}`} d={d} />
              ))}
            </ul>
            <AlertDialogFooter>
              <a
                href="/dashboard/jules"
                className="inline-flex items-center text-xs font-medium text-emerald-500 hover:text-emerald-400"
              >
                Track the Jules session →
              </a>
              <AlertDialogCancel>Done</AlertDialogCancel>
            </AlertDialogFooter>
          </>
        ) : (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>Switch model with Jules?</AlertDialogTitle>
              <AlertDialogDescription>
                Dispatch Jules to change{" "}
                <span className="font-medium text-foreground">{project}</span>&apos;s code from{" "}
                <span className="font-mono text-foreground">{currentModel}</span> to{" "}
                <span className="font-mono text-foreground">{altModel}</span> (
                {altProvider}) and open a PR — you review and merge. Est. saving{" "}
                <span className="font-medium text-emerald-500">{usdFmt(savingsUsd)}</span>.
              </AlertDialogDescription>
            </AlertDialogHeader>

            {/* Scope choice */}
            <fieldset className="flex flex-col gap-1">
              <legend className="mb-1 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                Scope
              </legend>
              {(
                [
                  ["project", "This project", project],
                  ["global", "All projects on this model", currentModel],
                ] as const
              ).map(([value, label, sub]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setScope(value)}
                  className={`flex flex-col items-start rounded-lg px-3 py-2 text-left text-sm transition-colors ring-1 ${
                    scope === value
                      ? "bg-foreground/[0.06] ring-border/60"
                      : "bg-transparent ring-border/40 hover:bg-muted/30"
                  }`}
                >
                  <span className="font-medium text-foreground">{label}</span>
                  <span className="truncate font-mono text-[11px] text-muted-foreground">{sub}</span>
                </button>
              ))}
            </fieldset>

            {error ? <p className="text-xs text-destructive">{error}</p> : null}

            <AlertDialogFooter>
              <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
              <Button onClick={confirm} disabled={submitting} className="gap-1.5">
                {submitting ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
                Dispatch Jules
              </Button>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
