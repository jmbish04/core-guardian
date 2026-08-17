/**
 * @fileoverview BudgetMeter — the nuclear breaker control, first thing on the
 * Guardian dashboard.
 *
 * This is a TOTAL-Cloudflare-spend guard. The nuclear budget is the "fire pool":
 * when total CF month-to-date spend reaches it, core-guardian throws the kill
 * switch and ALL AI stops through our APIs. This panel is that control surface:
 *   - a meter of MTD spend vs the nuclear budget (green < 70%, amber 70–99%,
 *     destructive at/over 100%),
 *   - a LOUD halted banner when the kill switch is engaged,
 *   - a setup/empty state when no budget is set ("set your nuke line"),
 *   - a Set-total-budget dialog (nuclear budget + infra threshold) → budget-config.
 *
 * It owns the single `GET /guardian/billing/budget-status` fetch for the page and
 * renders `<InfraSpikeFlags>` from the same payload (one request, no double read).
 *
 * API:
 *   - `GET  /guardian/billing/budget-status` → BudgetStatus.
 *   - `POST /guardian/billing/budget-config` `{ nuclearBudgetUsd?, infraThresholdUsd? }`.
 *
 * Monolith: dark, `bg-card` + `ring-1 ring-border/40` (never a 1px border), money
 * via `usd()`; errors route through the shared InlineError.
 */

"use client";

import { AlertOctagonIcon, Loader2Icon, TargetIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, apiGet, apiSend } from "@/lib/api";
import { usd } from "@/lib/format";

import { InfraSpikeFlags, type NonAiService } from "./InfraSpikeFlags";
import { InlineError } from "./shared";

interface BudgetStatus {
  mtdUsd: number;
  mtdSource: "billed" | "estimated";
  nuclearBudgetUsd: number | null;
  overBudget: boolean;
  killSwitchEngaged: boolean;
  infraThresholdUsd: number;
  nonAiServices: NonAiService[];
}

/** Meter fill colour by how close MTD is to the nuclear budget. */
function meterTone(pct: number): { bar: string; text: string } {
  if (pct >= 100) return { bar: "bg-destructive", text: "text-destructive" };
  if (pct >= 70) return { bar: "bg-amber-500", text: "text-amber-500" };
  return { bar: "bg-emerald-500", text: "text-emerald-500" };
}

export function BudgetMeter() {
  const [data, setData] = useState<BudgetStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await apiGet<BudgetStatus>("/guardian/billing/budget-status"));
    } catch (err) {
      console.error("BudgetMeter load failed:", err);
      setError(
        err instanceof ApiError && err.status === 401
          ? "Sign in to view the total-budget guard."
          : err instanceof ApiError
            ? err.message
            : "Failed to load the total-budget guard.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !data) {
    return (
      <div className="flex flex-col gap-3" aria-busy>
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-40" />
      </div>
    );
  }
  if (error && !data) return <InlineError message={error} onRetry={load} />;
  if (!data) return null;

  const { mtdUsd, mtdSource, nuclearBudgetUsd, killSwitchEngaged, infraThresholdUsd, nonAiServices } =
    data;
  const pct = nuclearBudgetUsd && nuclearBudgetUsd > 0 ? (mtdUsd / nuclearBudgetUsd) * 100 : 0;
  const tone = meterTone(pct);

  return (
    <section className="flex flex-col gap-4">
      {/* Non-AI infra spikes are the loudest emergency — render above the meter. */}
      <InfraSpikeFlags services={nonAiServices} thresholdUsd={infraThresholdUsd} />

      {/* Kill switch engaged — the single loudest state on the page. */}
      {killSwitchEngaged && (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-xl bg-destructive/20 p-5 ring-1 ring-destructive/60"
        >
          <div className="flex items-center gap-2">
            <AlertOctagonIcon className="size-6 shrink-0 text-destructive" aria-hidden />
            <span className="text-xl font-semibold tracking-tight text-destructive">
              AI HALTED — total budget reached
            </span>
          </div>
          <p className="text-sm text-destructive/90">
            Every AI call through core-guardian is blocked. The kill switch is lifted by resolving
            the triggering incident —{" "}
            <a href="#incidents" className="font-medium underline underline-offset-2">
              review incidents below
            </a>
            .
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-xl font-semibold tracking-tight">Total budget</h2>
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            nuclear breaker
          </span>
        </div>
        <Button size="sm" variant="outline" onClick={() => setDialogOpen(true)}>
          <TargetIcon className="size-3.5" aria-hidden />
          Set total budget
        </Button>
      </div>

      {nuclearBudgetUsd === null ? (
        // Empty / setup state — no nuke line drawn yet.
        <Card className="ring-1 ring-border/40">
          <CardContent className="flex flex-col items-start gap-3 p-6">
            <p className="text-sm text-muted-foreground">
              No total budget set — draw your nuke line. When total Cloudflare spend reaches it, all
              AI stops. Month-to-date so far: {usd(mtdUsd)}.
            </p>
            <Button size="sm" onClick={() => setDialogOpen(true)}>
              <TargetIcon className="size-3.5" aria-hidden />
              Set your nuke line
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card className={pct >= 100 ? "ring-1 ring-destructive/50" : "ring-1 ring-border/40"}>
          <CardContent className="flex flex-col gap-2.5 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-2xl font-semibold tabular-nums tracking-tight">
                {usd(mtdUsd)}{" "}
                <span className="text-base font-normal text-muted-foreground">
                  / {usd(nuclearBudgetUsd)}
                </span>
              </span>
              <span className={`text-xl font-semibold tabular-nums ${tone.text}`}>
                {Math.round(pct)}%
              </span>
            </div>
            {/* Decorative div bar — full colour control per threshold; the % is
                read from the adjacent text, so the bar itself is aria-hidden. */}
            <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
              <div
                className={`h-full rounded-full transition-all ${tone.bar}`}
                style={{ width: `${Math.min(100, pct)}%` }}
              />
            </div>
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              {mtdSource === "billed" ? "actual billed spend" : "estimate — billing lags ~24h"}
            </span>
          </CardContent>
        </Card>
      )}

      <BudgetDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        current={data}
        onSaved={() => {
          setDialogOpen(false);
          void load();
        }}
      />
    </section>
  );
}

/** Set-total-budget dialog — nuclear budget + infra threshold, POST budget-config. */
function BudgetDialog({
  open,
  onOpenChange,
  current,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current: BudgetStatus;
  onSaved: () => void;
}) {
  const [nuclear, setNuclear] = useState("");
  const [infra, setInfra] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Seed inputs from the live config each time the dialog opens.
  useEffect(() => {
    if (open) {
      setNuclear(current.nuclearBudgetUsd != null ? String(current.nuclearBudgetUsd) : "");
      setInfra(String(current.infraThresholdUsd));
      setSaveError(null);
    }
  }, [open, current]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const nuclearNum = nuclear.trim() === "" ? undefined : Number(nuclear);
    const infraNum = infra.trim() === "" ? undefined : Number(infra);
    if (
      (nuclearNum !== undefined && (!Number.isFinite(nuclearNum) || nuclearNum < 0)) ||
      (infraNum !== undefined && (!Number.isFinite(infraNum) || infraNum < 0))
    ) {
      setSaveError("Budgets must be zero or a positive dollar amount.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await apiSend("POST", "/guardian/billing/budget-config", {
        nuclearBudgetUsd: nuclearNum,
        infraThresholdUsd: infraNum,
      });
      onSaved();
    } catch (err) {
      console.error("BudgetMeter save failed:", err);
      setSaveError(err instanceof ApiError ? err.message : "Failed to save budget config.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Set total budget</DialogTitle>
            <DialogDescription>
              The nuclear budget is the fire pool: when total Cloudflare spend reaches it, all AI
              stops. The infra threshold flags any non-AI service that spends over it.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2">
            <Label htmlFor="nuclear-budget">Nuclear budget (total CF, USD / month)</Label>
            <Input
              id="nuclear-budget"
              type="number"
              min={0}
              step="0.01"
              inputMode="decimal"
              placeholder="e.g. 50"
              value={nuclear}
              onChange={(e) => setNuclear(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Set <span className="font-mono">0</span> to disable the nuke line; leave blank to keep
              the current value.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="infra-threshold">Non-AI infra threshold (USD / month)</Label>
            <Input
              id="infra-threshold"
              type="number"
              min={0}
              step="0.01"
              inputMode="decimal"
              placeholder="e.g. 1"
              value={infra}
              onChange={(e) => setInfra(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Owner expects ~$0 non-AI — keep this low so a Durable-Object alarm loop trips it fast.
            </p>
          </div>

          {saveError && <p className="text-sm text-destructive">{saveError}</p>}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? <Loader2Icon className="size-3.5 animate-spin" /> : "Save budget"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
