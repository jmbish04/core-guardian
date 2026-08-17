/**
 * @fileoverview Model substitution rules — AI Router dashboard panel.
 *
 * Reads/writes `GET|POST|DELETE /api/guardian/ai-router/substitutions`. Each
 * rule swaps the model the router uses for a project (fromModel → toModel) with
 * no code change in the caller. Rows rank enabled-first then newest; disabled
 * rows render dimmed. The Enabled switch is optimistic with revert-on-error;
 * delete is guarded by an AlertDialog confirm; the Add form surfaces the
 * backend's 400 validation message inline (`:` in a field, whitespace-only, or
 * a dynamic-sentinel fromModel) without closing.
 */

"use client";

import { Loader2Icon, PlusIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

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
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ApiError, apiGet, apiSend } from "@/lib/api";

import { EmptyState, InlineError } from "./shared";

type Rule = {
  id: string;
  project: string;
  fromModel: string;
  toModel: string;
  enabled: boolean;
  note: string | null;
  createdAt: number;
};

const BASE = "/guardian/ai-router/substitutions";

/** Enabled first, then newest. */
function rank(a: Rule, b: Rule): number {
  if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
  return b.createdAt - a.createdAt;
}

// --- Add-rule dialog --------------------------------------------------------

function AddRuleDialog({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [project, setProject] = useState("");
  const [fromModel, setFromModel] = useState("");
  const [toModel, setToModel] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setProject("");
      setFromModel("");
      setToModel("");
      setNote("");
      setError(null);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await apiSend<Rule>("POST", BASE, {
        project: project.trim(),
        fromModel: fromModel.trim(),
        toModel: toModel.trim(),
        note: note.trim() || undefined,
      });
      setOpen(false);
      onSaved();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Failed to save the substitution rule.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="gap-1.5">
          <PlusIcon className="size-3.5" />
          Add rule
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add substitution rule</DialogTitle>
          <DialogDescription>
            Route a project off <span className="font-mono">fromModel</span> onto{" "}
            <span className="font-mono">toModel</span> at the router. No caller change.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="sub-project">Project</Label>
            <Input
              id="sub-project"
              value={project}
              onChange={(e) => setProject(e.target.value)}
              placeholder="my-worker"
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="sub-from">From model</Label>
            <Input
              id="sub-from"
              value={fromModel}
              onChange={(e) => setFromModel(e.target.value)}
              placeholder="gpt-oss-120b"
              className="font-mono"
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="sub-to">To model</Label>
            <Input
              id="sub-to"
              value={toModel}
              onChange={(e) => setToModel(e.target.value)}
              placeholder="llama-3.3-70b"
              className="font-mono"
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="sub-note">Note (optional)</Label>
            <Input
              id="sub-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="cheaper, same capability"
            />
          </div>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="submit" disabled={submitting} className="gap-1.5">
              {submitting ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
              Save rule
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- Delete confirm ---------------------------------------------------------

function DeleteRuleButton({ rule, onDeleted }: { rule: Rule; onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setSubmitting(true);
    setError(null);
    try {
      await apiSend<{ ok: true }>("DELETE", `${BASE}/${rule.id}`);
      setOpen(false);
      onDeleted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to delete the rule.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button size="icon-sm" variant="ghost" aria-label="Delete rule">
          <Trash2Icon className="size-3.5 text-muted-foreground" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete substitution rule?</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="font-mono text-foreground">{rule.project}</span> will stop rewriting{" "}
            <span className="font-mono text-foreground">{rule.fromModel}</span> →{" "}
            <span className="font-mono text-foreground">{rule.toModel}</span>.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={confirm} disabled={submitting}>
            {submitting ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// --- The panel --------------------------------------------------------------

export function ModelSubstitutions() {
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mutError, setMutError] = useState<string | null>(null);

  // Request-id guard: a mutation-triggered refetch must not be overwritten by a
  // slower in-flight load.
  const reqId = useRef(0);
  const load = useCallback(async () => {
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    try {
      const r = await apiGet<{ substitutions: Rule[] }>(BASE);
      if (id === reqId.current) setRules(r.substitutions);
    } catch (err) {
      if (id !== reqId.current) return;
      setError(
        err instanceof ApiError && err.status === 401
          ? "Sign in to manage substitutions."
          : err instanceof ApiError
            ? err.message
            : "Failed to load substitution rules.",
      );
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(rule: Rule) {
    setMutError(null);
    // Optimistic flip.
    setRules((prev) =>
      prev ? prev.map((r) => (r.id === rule.id ? { ...r, enabled: !r.enabled } : r)) : prev,
    );
    try {
      await apiSend<{ id: string; enabled: boolean }>("POST", `${BASE}/${rule.id}/toggle`);
    } catch (err) {
      // Revert.
      setRules((prev) =>
        prev ? prev.map((r) => (r.id === rule.id ? { ...r, enabled: rule.enabled } : r)) : prev,
      );
      setMutError(err instanceof ApiError ? err.message : "Failed to toggle the rule.");
    }
  }

  const sorted = rules ? [...rules].sort(rank) : [];

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-border/60 bg-background/40 p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium">Model Substitutions</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Swap the model at the router for a project — no code change in the caller.
          </p>
        </div>
        <AddRuleDialog onSaved={() => void load()} />
      </header>

      {mutError ? <p className="text-xs text-destructive">{mutError}</p> : null}

      {error ? (
        <InlineError message={error} onRetry={() => void load()} />
      ) : loading && !rules ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-11 w-full rounded-md" />
          ))}
        </div>
      ) : sorted.length === 0 ? (
        <EmptyState label="No substitution rules" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Project</TableHead>
              <TableHead>Rule</TableHead>
              <TableHead>Note</TableHead>
              <TableHead className="text-center">Enabled</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((rule) => (
              <TableRow key={rule.id} className={rule.enabled ? undefined : "opacity-50"}>
                <TableCell className="font-medium">{rule.project}</TableCell>
                <TableCell className="font-mono text-xs">
                  {rule.fromModel}{" "}
                  <span className="text-muted-foreground" aria-label="becomes">
                    →
                  </span>{" "}
                  {rule.toModel}
                </TableCell>
                <TableCell className="max-w-[16rem] truncate text-muted-foreground">
                  {rule.note ?? "—"}
                </TableCell>
                <TableCell className="text-center">
                  <Switch
                    checked={rule.enabled}
                    onCheckedChange={() => void toggle(rule)}
                    aria-label={`Toggle ${rule.project} substitution`}
                  />
                </TableCell>
                <TableCell>
                  <DeleteRuleButton rule={rule} onDeleted={() => void load()} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
