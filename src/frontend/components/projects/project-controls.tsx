/**
 * @fileoverview Budget/circuit controls + destructive danger zone for one
 * project. Kept out of ProjectDetail.tsx so each file stays small.
 *
 *  - CircuitPanel  → POST /api/guardian/billing/controls/project-circuit
 *  - DangerZone    → DELETE /{name}/worker · POST /{name}/disable-crons,
 *                    each gated behind a type-`delete <name>` AlertDialog.
 */

"use client";

import { LockIcon, PauseIcon, PlayIcon, ShieldAlertIcon, TrashIcon, WalletIcon } from "lucide-react";
import { useEffect, useState } from "react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
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
import { ApiError, apiSend } from "@/lib/api";
import { usd } from "@/lib/format";

import { StatusBanner, type Circuit, type Status } from "./shared";

const CARD = "rounded-md bg-card/40 p-5 ring-1 ring-border/40";

async function run(
  fn: () => Promise<unknown>,
  setBusy: (b: boolean) => void,
  setStatus: (s: Status) => void,
  successMsg: string,
  onDone?: () => void,
) {
  setBusy(true);
  setStatus(null);
  try {
    await fn();
    setStatus({ kind: "success", message: successMsg });
    onDone?.();
  } catch (e) {
    setStatus({ kind: "error", message: e instanceof ApiError ? e.message : "Request failed." });
  } finally {
    setBusy(false);
  }
}

// ---------------------------------------------------------------------------
// Budget & circuit
// ---------------------------------------------------------------------------

type CircuitAction = "set-budget" | "lock-month" | "freeze" | "unfreeze";

function circuitCall(project: string, action: CircuitAction, budgetUsd?: number) {
  return apiSend("POST", "/guardian/billing/controls/project-circuit", {
    project,
    action,
    ...(budgetUsd !== undefined ? { budgetUsd } : {}),
  });
}

export function CircuitPanel({
  project,
  circuit,
  onChanged,
}: {
  project: string;
  circuit: Circuit;
  onChanged: () => void;
}) {
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);
  const [budgetOpen, setBudgetOpen] = useState(false);
  const [budget, setBudget] = useState(circuit?.budgetUsd != null ? String(circuit.budgetUsd) : "");
  // Keep the input in sync when the circuit reloads from an external change.
  useEffect(() => {
    setBudget(circuit?.budgetUsd != null ? String(circuit.budgetUsd) : "");
  }, [circuit?.budgetUsd]);

  const enabled = circuit?.enabled ?? false;

  function act(action: CircuitAction, budgetUsd?: number, msg?: string) {
    void run(
      () => circuitCall(project, action, budgetUsd),
      setBusy,
      setStatus,
      msg ?? "Circuit updated.",
      onChanged,
    );
  }

  return (
    <div className={CARD}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-base font-medium">
            <WalletIcon className="size-4 text-muted-foreground" /> Budget &amp; circuit
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {circuit ? (
              <>
                Budget{" "}
                <span className="font-mono text-foreground">
                  {circuit.budgetUsd != null ? usd(circuit.budgetUsd) : "—"}
                </span>{" "}
                · window <span className="font-mono text-foreground">{circuit.window ?? "—"}</span> ·{" "}
                <span className={enabled ? "text-emerald-300" : "text-muted-foreground"}>
                  {enabled ? "armed" : "disarmed"}
                </span>
              </>
            ) : (
              "No circuit configured — set a budget to arm spend protection for this project."
            )}
          </p>
        </div>
      </div>

      <StatusBanner status={status} className="mt-4" />

      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setBudgetOpen(true)}>
          <WalletIcon className="size-4" /> Set budget
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => act("lock-month", undefined, "Month locked.")}
        >
          <LockIcon className="size-4" /> Lock month
        </Button>
        {enabled ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => act("unfreeze", undefined, "Circuit unfrozen.")}
          >
            <PlayIcon className="size-4" /> Unfreeze
          </Button>
        ) : (
          <Button
            size="sm"
            variant="destructive"
            disabled={busy}
            onClick={() => act("freeze", undefined, "Circuit frozen — project spend halted.")}
          >
            <PauseIcon className="size-4" /> Freeze
          </Button>
        )}
      </div>

      <Dialog open={budgetOpen} onOpenChange={setBudgetOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Set monthly budget</DialogTitle>
            <DialogDescription>
              The AI Router trips this project&rsquo;s circuit once monthly spend crosses this cap.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="budget-input">Budget (USD)</Label>
            <Input
              id="budget-input"
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              placeholder="e.g. 25.00"
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setBudgetOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={busy || budget.trim() === "" || Number.isNaN(parseFloat(budget))}
              onClick={() => {
                setBudgetOpen(false);
                act("set-budget", parseFloat(budget), `Budget set to ${usd(parseFloat(budget))}.`);
              }}
            >
              Save budget
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Danger zone — worker projects only
// ---------------------------------------------------------------------------

/** AlertDialog whose confirm unlocks only when the user types `delete <name>`. */
function ConfirmDelete({
  open,
  onOpenChange,
  name,
  title,
  description,
  actionLabel,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  name: string;
  title: string;
  description: React.ReactNode;
  actionLabel: string;
  busy: boolean;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState("");
  const phrase = `delete ${name}`;
  const matches = typed === phrase;
  // Reset whenever the dialog closes — the confirm button closes it programmatically
  // (bypassing onOpenChange), so a failed delete must not leave the input pre-filled
  // and the destructive button instantly re-enabled on reopen.
  useEffect(() => {
    if (!open) setTyped("");
  }, [open]);
  return (
    <AlertDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setTyped("");
        onOpenChange(o);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="confirm-input">
            Type <span className="font-mono text-foreground">{phrase}</span> to confirm
          </Label>
          <Input
            id="confirm-input"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            placeholder={phrase}
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button variant="destructive" disabled={!matches || busy} onClick={onConfirm}>
            {actionLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function DangerZone({ name, onChanged }: { name: string; onChanged: () => void }) {
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [cronsOpen, setCronsOpen] = useState(false);
  const confirm = `delete ${name}`;

  return (
    <div className="rounded-md bg-destructive/5 p-5 ring-1 ring-destructive/30">
      <h3 className="flex items-center gap-2 text-base font-medium text-destructive">
        <ShieldAlertIcon className="size-4" /> Danger zone
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">
        These act against the live Cloudflare account and are recorded in the audit trail. There is
        no undo.
      </p>

      <StatusBanner status={status} className="mt-4" />

      <div className="mt-4 flex flex-col gap-3 sm:flex-row">
        <div className="flex-1 rounded-md bg-background/40 p-4 ring-1 ring-border/40">
          <p className="text-sm font-medium">Delete worker</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Deletes the Cloudflare Worker script (force) and deactivates the project row.
          </p>
          <Button
            size="sm"
            variant="destructive"
            className="mt-3"
            disabled={busy}
            onClick={() => setDeleteOpen(true)}
          >
            <TrashIcon className="size-4" /> Delete worker
          </Button>
        </div>
        <div className="flex-1 rounded-md bg-background/40 p-4 ring-1 ring-border/40">
          <p className="text-sm font-medium">Disable crons</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Removes every cron trigger on the worker so its scheduled spend stops.
          </p>
          <Button
            size="sm"
            variant="destructive"
            className="mt-3"
            disabled={busy}
            onClick={() => setCronsOpen(true)}
          >
            <PauseIcon className="size-4" /> Disable crons
          </Button>
        </div>
      </div>

      <ConfirmDelete
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        name={name}
        title="Delete this Cloudflare Worker?"
        description={
          <>
            This permanently deletes the worker script{" "}
            <span className="font-mono text-foreground">{name}</span> and marks the project inactive.
          </>
        }
        actionLabel="Delete worker"
        busy={busy}
        onConfirm={() => {
          setDeleteOpen(false);
          void run(
            () => apiSend("DELETE", `/guardian/projects/${encodeURIComponent(name)}/worker`, { confirm }),
            setBusy,
            setStatus,
            `Worker ${name} deleted.`,
            onChanged,
          );
        }}
      />
      <ConfirmDelete
        open={cronsOpen}
        onOpenChange={setCronsOpen}
        name={name}
        title="Disable all cron triggers?"
        description={
          <>
            This removes every scheduled trigger on{" "}
            <span className="font-mono text-foreground">{name}</span>. The worker keeps serving
            fetch requests.
          </>
        }
        actionLabel="Disable crons"
        busy={busy}
        onConfirm={() => {
          setCronsOpen(false);
          void run(
            () =>
              apiSend("POST", `/guardian/projects/${encodeURIComponent(name)}/disable-crons`, {
                confirm,
              }),
            setBusy,
            setStatus,
            `Cron triggers on ${name} disabled.`,
            onChanged,
          );
        }}
      />
    </div>
  );
}
