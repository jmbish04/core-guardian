/**
 * @fileoverview AI Router admin console — circuit breakers, the global kill
 * switch, and the recent-request log.
 *
 * Everything here is a spend control, so every destructive direction is gated:
 * arming the kill switch is one click (blocking AI is always safe), disarming it
 * requires typing the confirmation phrase the API also re-checks server-side.
 * Circuit deletion and break-glass (a timed bypass of a budget) get the same
 * treatment. No `window.confirm` anywhere — shadcn dialogs only.
 */

"use client";

import { AlertTriangleIcon, Loader2Icon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { ConfirmDeleteDialog, ResourceTable, type Column } from "@/components/storage";
import { Badge } from "@/components/ui/badge";
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
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ApiError, apiGet, apiSend } from "@/lib/api";
import { relativeTime } from "@/lib/format";

import { InlineError } from "./shared";

/**
 * Budget reset cadence. Named `CircuitWindow` rather than `Window` so it cannot
 * shadow the DOM `Window` type inside this module.
 */
type CircuitWindow = "day" | "week" | "month" | "total";

interface Circuit {
  budgetUsd: number;
  window: CircuitWindow;
  enabled: boolean;
  breakGlassUntil?: number;
}

interface CircuitRow {
  scope: string;
  circuit: Circuit;
  spent: number;
}

interface CircuitsResponse {
  killSwitch: boolean;
  circuits: CircuitRow[];
}

interface RouterRequestRow {
  id: string;
  at: number;
  project: string;
  importance: string;
  provider: string;
  model: string;
  mode: string;
  gateway: string | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  isError: boolean;
  errorMessage: string | null;
  isCircuitBreaker: boolean;
  circuitBrokenMessage: string | null;
}

const PANEL = "rounded-xl border border-border/60 bg-background/40 p-6";

const WINDOWS: CircuitWindow[] = ["day", "week", "month", "total"];

type ScopeKind = "global" | "provider" | "model" | "project";

const SCOPE_KINDS: ScopeKind[] = ["global", "provider", "model", "project"];

const PROVIDERS = ["openai", "anthropic", "google", "workers-ai"] as const;

/** AI Router reports every money value in dollars. */
const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * Compose a circuit scope key from the builder fields. `:` is rejected because
 * the scope key itself is colon-delimited — a project named `a:b` would collide
 * with the `provider:`/`model:`/`project:` prefixes (the `/run` handler rejects
 * the same characters at the ingress).
 */
function buildScope(
  kind: ScopeKind,
  provider: string,
  model: string,
  project: string,
): { scope?: string; err?: string } {
  const bad = (s: string) => s.includes(":");
  if (kind === "global") return { scope: "global" };
  if (kind === "provider") {
    if (!provider) return { err: "Pick a provider." };
    if (bad(provider)) return { err: "Provider must not contain ':'." };
    return { scope: `provider:${provider}` };
  }
  if (kind === "model") {
    if (!provider || !model) return { err: "Provider and model required." };
    if (bad(model)) return { err: "Model must not contain ':'." };
    return { scope: `model:${provider}/${model}` };
  }
  if (!project) return { err: "Project required." };
  if (bad(project)) return { err: "Project must not contain ':'." };
  return { scope: `project:${project}` };
}

type EditorState = {
  /** Set when editing an existing circuit — the scope becomes read-only. */
  editScope: string | null;
  kind: ScopeKind;
  provider: string;
  model: string;
  project: string;
  budgetUsd: string;
  window: CircuitWindow;
  enabled: boolean;
};

const NEW_EDITOR: EditorState = {
  editScope: null,
  kind: "global",
  provider: "openai",
  model: "",
  project: "",
  budgetUsd: "",
  window: "month",
  enabled: true,
};

export function AiRouterConsole() {
  const [killSwitch, setKillSwitch] = useState(false);
  const [circuits, setCircuits] = useState<CircuitRow[]>([]);
  const [requests, setRequests] = useState<RouterRequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [confirmDisarm, setConfirmDisarm] = useState(false);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [breakGlassFor, setBreakGlassFor] = useState<CircuitRow | null>(null);
  const [breakGlassHours, setBreakGlassHours] = useState("1");
  const [deleteTarget, setDeleteTarget] = useState<CircuitRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [c, r] = await Promise.all([
        apiGet<CircuitsResponse>("/ai-router/circuits"),
        apiGet<{ requests: RouterRequestRow[] }>("/ai-router/requests", { limit: 50 }),
      ]);
      setKillSwitch(c.killSwitch);
      setCircuits(c.circuits);
      setRequests(r.requests);
      setReady(true);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "Sign in to manage the AI Router."
          : err instanceof ApiError
            ? err.message
            : "Failed to load AI Router state.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Run a mutation, reload, and surface any failure in the inline banner. */
  const mutate = useCallback(
    async (run: () => Promise<unknown>, fallback: string) => {
      setError(null);
      try {
        await run();
        await load();
      } catch (err) {
        setError(err instanceof ApiError ? err.message : fallback);
      }
    },
    [load],
  );

  function toggleKillSwitch(on: boolean) {
    // Arming blocks all AI and is always safe; disarming re-opens spend, so it
    // goes through the phrase barrier instead.
    if (!on) {
      setConfirmDisarm(true);
      return;
    }
    void mutate(
      () => apiSend("POST", "/ai-router/kill-switch", { on: true }),
      "Failed to arm the kill switch.",
    );
  }

  async function saveCircuit() {
    if (!editor) return;
    setEditorError(null);
    const budgetUsd = Number(editor.budgetUsd);
    if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
      setEditorError("Budget must be a positive dollar amount.");
      return;
    }
    const scope =
      editor.editScope ??
      (() => {
        const built = buildScope(editor.kind, editor.provider, editor.model, editor.project);
        if (built.err) setEditorError(built.err);
        return built.scope;
      })();
    if (!scope) return;

    await mutate(
      () =>
        apiSend("PUT", `/ai-router/circuits/${encodeURIComponent(scope)}`, {
          budgetUsd,
          window: editor.window,
          enabled: editor.enabled,
        }),
      "Failed to save the circuit.",
    );
    setEditor(null);
  }

  async function submitBreakGlass() {
    if (!breakGlassFor) return;
    const hours = Number(breakGlassHours);
    if (!Number.isFinite(hours) || hours < 1 || hours > 168) return;
    const scope = breakGlassFor.scope;
    await mutate(
      () =>
        apiSend("POST", `/ai-router/circuits/${encodeURIComponent(scope)}/break-glass`, { hours }),
      "Failed to set break-glass.",
    );
    setBreakGlassFor(null);
  }

  if (error && !ready) {
    return <InlineError message={error} onRetry={() => void load()} />;
  }

  if (!ready) {
    return (
      <div className={`${PANEL} flex items-center gap-2 text-sm text-muted-foreground`}>
        <Loader2Icon className="size-4 animate-spin" />
        Loading AI Router state…
      </div>
    );
  }

  const now = Date.now();

  const circuitColumns: Column<CircuitRow>[] = [
    {
      key: "scope",
      header: "Scope",
      sortValue: (r) => r.scope,
      render: (r) => {
        const tripped = r.spent >= r.circuit.budgetUsd;
        const bypassing = (r.circuit.breakGlassUntil ?? 0) > now;
        return (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-sm">{r.scope}</span>
            {tripped && (
              <Badge variant="destructive" className="text-[10px]">
                TRIPPED
              </Badge>
            )}
            {bypassing && (
              <Badge variant="outline" className="text-[10px]">
                BREAK-GLASS · {relativeTime(r.circuit.breakGlassUntil!)}
              </Badge>
            )}
          </div>
        );
      },
    },
    {
      key: "budget",
      header: "Budget",
      align: "right",
      sortValue: (r) => r.circuit.budgetUsd,
      render: (r) => (
        <span className="font-mono text-sm tabular-nums">{usd(r.circuit.budgetUsd)}</span>
      ),
    },
    {
      key: "window",
      header: "Window",
      sortValue: (r) => r.circuit.window,
      render: (r) => <span className="font-mono text-xs">{r.circuit.window}</span>,
    },
    {
      key: "spent",
      header: "Spent",
      sortValue: (r) => (r.circuit.budgetUsd > 0 ? r.spent / r.circuit.budgetUsd : r.spent),
      className: "min-w-[9rem]",
      render: (r) => {
        const ratio = r.circuit.budgetUsd > 0 ? r.spent / r.circuit.budgetUsd : 0;
        const pct = Math.min(100, Math.round(ratio * 100));
        const tint =
          ratio >= 1
            ? "[&_[data-slot=progress-indicator]]:bg-destructive"
            : ratio >= 0.8
              ? "[&_[data-slot=progress-indicator]]:bg-amber-500"
              : "";
        const text =
          ratio >= 1
            ? "text-destructive"
            : ratio >= 0.8
              ? "text-amber-600 dark:text-amber-400"
              : "";
        return (
          <div className="flex flex-col gap-1">
            <span className={`font-mono text-xs tabular-nums ${text}`}>
              {usd(r.spent)} · {pct}%
            </span>
            <Progress value={pct} className={tint} aria-label={`Spend for ${r.scope}`} />
          </div>
        );
      },
    },
    {
      key: "enabled",
      header: "Enabled",
      render: (r) => (
        <Switch
          aria-label={`Toggle circuit ${r.scope}`}
          checked={r.circuit.enabled}
          onCheckedChange={(next) =>
            void mutate(
              () =>
                apiSend("PUT", `/ai-router/circuits/${encodeURIComponent(r.scope)}`, {
                  budgetUsd: r.circuit.budgetUsd,
                  window: r.circuit.window,
                  enabled: next,
                }),
              "Failed to update the circuit.",
            )
          }
        />
      ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (r) => (
        <div className="flex justify-end gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => {
              setEditorError(null);
              setEditor({
                ...NEW_EDITOR,
                editScope: r.scope,
                budgetUsd: String(r.circuit.budgetUsd),
                window: r.circuit.window,
                enabled: r.circuit.enabled,
              });
            }}
          >
            Edit
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => {
              setBreakGlassHours("1");
              setBreakGlassFor(r);
            }}
          >
            Break-glass
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-destructive"
            onClick={() => setDeleteTarget(r)}
          >
            Delete
          </Button>
        </div>
      ),
    },
  ];

  const requestColumns: Column<RouterRequestRow>[] = [
    {
      key: "at",
      header: "Time",
      sortValue: (r) => r.at,
      render: (r) => (
        <span className="font-mono text-xs text-muted-foreground">{relativeTime(r.at)}</span>
      ),
    },
    {
      key: "project",
      header: "Project",
      sortValue: (r) => r.project,
      render: (r) => <span className="font-mono text-xs">{r.project}</span>,
    },
    {
      key: "importance",
      header: "Importance",
      sortValue: (r) => r.importance,
      render: (r) => (
        <Badge
          variant={
            r.importance === "high"
              ? "destructive"
              : r.importance === "medium"
                ? "secondary"
                : "outline"
          }
          className="text-[10px]"
        >
          {r.importance}
        </Badge>
      ),
    },
    {
      key: "model",
      header: "Provider / model",
      sortValue: (r) => `${r.provider}/${r.model}`,
      render: (r) => (
        <span className="font-mono text-xs">
          <span className="text-muted-foreground">{r.provider}/</span>
          {r.model}
        </span>
      ),
    },
    {
      key: "mode",
      header: "Mode",
      sortValue: (r) => r.mode,
      render: (r) => (
        <span className="font-mono text-xs text-muted-foreground">
          {r.mode}
          {r.gateway ? ` · ${r.gateway}` : ""}
        </span>
      ),
    },
    {
      key: "tokens",
      header: "Tokens",
      align: "right",
      sortValue: (r) => r.tokensIn + r.tokensOut,
      render: (r) => (
        <span className="font-mono text-xs tabular-nums">
          {r.tokensIn.toLocaleString()}
          <span className="text-muted-foreground"> / {r.tokensOut.toLocaleString()}</span>
        </span>
      ),
    },
    {
      key: "cost",
      header: "Cost",
      align: "right",
      sortValue: (r) => r.costUsd,
      render: (r) => (
        <span className="font-mono text-xs tabular-nums">${r.costUsd.toFixed(4)}</span>
      ),
    },
    {
      key: "status",
      header: "Status",
      sortValue: (r) => (r.isCircuitBreaker ? 2 : r.isError ? 1 : 0),
      render: (r) =>
        r.isCircuitBreaker ? (
          <span
            className="font-mono text-xs text-amber-600 dark:text-amber-400"
            title={r.circuitBrokenMessage ?? undefined}
          >
            TRIPPED
          </span>
        ) : r.isError ? (
          <span className="font-mono text-xs text-destructive" title={r.errorMessage ?? undefined}>
            ERROR
          </span>
        ) : (
          <span className="font-mono text-xs text-emerald-600 dark:text-emerald-400">OK</span>
        ),
    },
  ];

  const editorScopePreview = editor
    ? (editor.editScope ??
      buildScope(editor.kind, editor.provider, editor.model, editor.project).scope ??
      "—")
    : "—";

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
            AI Router · Controls
          </div>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight">Circuits and kill switch</h2>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void load()}
          disabled={loading}
          className="gap-2"
        >
          {loading ? (
            <Loader2Icon className="size-4 animate-spin" />
          ) : (
            <RefreshCwIcon className="size-4" />
          )}
          Refresh
        </Button>
      </header>

      {error && <p className={`${PANEL} text-sm text-destructive`}>{error}</p>}

      {/* --- A. Global kill switch -------------------------------------------- */}
      <section
        className={
          killSwitch
            ? "flex flex-wrap items-center justify-between gap-4 rounded-xl border border-destructive/60 bg-destructive/10 p-6"
            : `${PANEL} flex flex-wrap items-center justify-between gap-4`
        }
      >
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
            Global kill switch
          </div>
          <div
            className={`mt-1 flex items-center gap-2 text-2xl font-semibold tracking-tight ${
              killSwitch ? "text-destructive" : ""
            }`}
          >
            {killSwitch && <AlertTriangleIcon className="size-6" aria-hidden />}
            {killSwitch ? "KILL SWITCH ACTIVE" : "ARMED"}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {killSwitch
              ? "Every AI Router request is being rejected — no provider calls, no spend."
              : "All AI is flowing. Every request is metered and breaker-gated."}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Label htmlFor="ai-router-kill-switch" className="text-xs text-muted-foreground">
            Block all AI
          </Label>
          <Switch
            id="ai-router-kill-switch"
            checked={killSwitch}
            onCheckedChange={toggleKillSwitch}
          />
        </div>
      </section>

      {/* --- B. Circuit breakers ---------------------------------------------- */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-base font-medium">Circuit breakers ({circuits.length})</h3>
          <Button
            type="button"
            size="sm"
            className="gap-2"
            onClick={() => {
              setEditorError(null);
              setEditor({ ...NEW_EDITOR });
            }}
          >
            <PlusIcon className="size-4" />
            New circuit
          </Button>
        </div>
        <ResourceTable
          rows={circuits}
          columns={circuitColumns}
          loading={loading}
          rowKey={(r) => r.scope}
          searchText={(r) => `${r.scope} ${r.circuit.window}`}
          initialSortKey="spent"
          empty="No circuit breakers. AI Router spend is uncapped until you add one."
        />
      </section>

      {/* --- C. Recent requests ----------------------------------------------- */}
      <section className="flex flex-col gap-3">
        <h3 className="text-base font-medium">Recent requests</h3>
        <ResourceTable
          rows={requests}
          columns={requestColumns}
          loading={loading}
          rowKey={(r) => r.id}
          searchText={(r) => `${r.project} ${r.provider} ${r.model} ${r.mode} ${r.importance}`}
          initialSortKey="at"
          empty="No AI Router requests recorded yet."
        />
      </section>

      {/* --- Create / edit circuit -------------------------------------------- */}
      <Dialog
        open={editor !== null}
        onOpenChange={(open) => {
          if (!open) setEditor(null);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editor?.editScope ? "Edit circuit" : "New circuit"}</DialogTitle>
            <DialogDescription>
              A circuit rejects requests matching its scope once spend in the window reaches the
              budget. Scope: <span className="font-mono">{editorScopePreview}</span>
            </DialogDescription>
          </DialogHeader>

          {editor && (
            <div className="flex flex-col gap-4">
              {editor.editScope ? (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="circuit-scope">Scope</Label>
                  <Input
                    id="circuit-scope"
                    readOnly
                    value={editor.editScope}
                    className="font-mono"
                  />
                  <p className="text-xs text-muted-foreground">
                    Scope is immutable — delete and recreate the circuit to change it.
                  </p>
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  <fieldset className="flex flex-col gap-2">
                    <legend className="mb-2 text-sm font-medium leading-none">Scope kind</legend>
                    <div className="inline-flex w-fit gap-1 rounded-lg bg-muted/40 p-1">
                      {SCOPE_KINDS.map((kind) => (
                        <Button
                          key={kind}
                          type="button"
                          size="sm"
                          variant={editor.kind === kind ? "default" : "ghost"}
                          aria-pressed={editor.kind === kind}
                          className="h-7 px-3 text-xs"
                          onClick={() => setEditor((e) => (e ? { ...e, kind } : e))}
                        >
                          {kind}
                        </Button>
                      ))}
                    </div>
                  </fieldset>

                  {(editor.kind === "provider" || editor.kind === "model") && (
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="circuit-provider">Provider</Label>
                      <Select
                        value={editor.provider}
                        onValueChange={(v) =>
                          setEditor((e) => (e ? { ...e, provider: String(v) } : e))
                        }
                      >
                        <SelectTrigger id="circuit-provider" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {PROVIDERS.map((p) => (
                            <SelectItem key={p} value={p}>
                              {p}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  {editor.kind === "model" && (
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="circuit-model">Model</Label>
                      <Input
                        id="circuit-model"
                        value={editor.model}
                        onChange={(ev) =>
                          setEditor((e) => (e ? { ...e, model: ev.target.value } : e))
                        }
                        placeholder="gpt-4o-mini"
                        spellCheck={false}
                        className="font-mono"
                      />
                    </div>
                  )}

                  {editor.kind === "project" && (
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="circuit-project">Project</Label>
                      <Input
                        id="circuit-project"
                        value={editor.project}
                        onChange={(ev) =>
                          setEditor((e) => (e ? { ...e, project: ev.target.value } : e))
                        }
                        placeholder="core-guardian"
                        spellCheck={false}
                        className="font-mono"
                      />
                    </div>
                  )}
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="circuit-budget">Budget ($)</Label>
                  <Input
                    id="circuit-budget"
                    value={editor.budgetUsd}
                    onChange={(ev) =>
                      setEditor((e) => (e ? { ...e, budgetUsd: ev.target.value } : e))
                    }
                    inputMode="decimal"
                    placeholder="25.00"
                    className="font-mono"
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="circuit-window">Window</Label>
                  <Select
                    value={editor.window}
                    onValueChange={(v) =>
                      setEditor((e) => (e ? { ...e, window: v as CircuitWindow } : e))
                    }
                  >
                    <SelectTrigger id="circuit-window" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {WINDOWS.map((w) => (
                        <SelectItem key={w} value={w}>
                          {w}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="circuit-enabled">Enabled</Label>
                <Switch
                  id="circuit-enabled"
                  checked={editor.enabled}
                  onCheckedChange={(enabled) => setEditor((e) => (e ? { ...e, enabled } : e))}
                />
              </div>

              {editorError && <p className="text-sm text-destructive">{editorError}</p>}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setEditor(null)}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void saveCircuit()}>
              Save circuit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* --- Break-glass ------------------------------------------------------- */}
      <Dialog
        open={breakGlassFor !== null}
        onOpenChange={(open) => {
          if (!open) setBreakGlassFor(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Break-glass bypass</DialogTitle>
            <DialogDescription>
              Ignores the{" "}
              <span className="font-mono">{breakGlassFor?.scope ?? ""}</span> budget for a fixed
              window. Spend keeps being metered — it just stops being blocked.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2">
            <Label htmlFor="break-glass-hours">Hours (1–168)</Label>
            <Input
              id="break-glass-hours"
              value={breakGlassHours}
              onChange={(e) => setBreakGlassHours(e.target.value)}
              inputMode="numeric"
              className="font-mono"
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setBreakGlassFor(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void submitBreakGlass()}
              disabled={
                !Number.isFinite(Number(breakGlassHours)) ||
                Number(breakGlassHours) < 1 ||
                Number(breakGlassHours) > 168
              }
            >
              Bypass for {breakGlassHours || "0"}h
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* --- Disarm the kill switch (phrase barrier) --------------------------- */}
      <ConfirmDeleteDialog
        open={confirmDisarm}
        onOpenChange={setConfirmDisarm}
        phrase="disable kill switch"
        title="Disable the kill switch?"
        confirmLabel="Disable kill switch"
        description={
          <>
            AI Router will start accepting requests again immediately. Individual circuit breakers
            still apply, but nothing else stands between your apps and provider spend.
          </>
        }
        onConfirm={() =>
          mutate(
            () =>
              apiSend("POST", "/ai-router/kill-switch", {
                on: false,
                confirm: "disable kill switch",
              }),
            "Failed to disable the kill switch.",
          )
        }
      />

      {/* --- Delete a circuit -------------------------------------------------- */}
      <ConfirmDeleteDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        phrase={deleteTarget?.scope ?? ""}
        title="Delete this circuit breaker?"
        confirmLabel="Delete circuit"
        description={
          <>
            Spend matching <span className="font-mono">{deleteTarget?.scope ?? ""}</span> will no
            longer be capped at {usd(deleteTarget?.circuit.budgetUsd ?? 0)} per{" "}
            {deleteTarget?.circuit.window ?? "month"}. Recorded spend is not deleted.
          </>
        }
        onConfirm={async () => {
          const scope = deleteTarget?.scope;
          if (!scope) return;
          await mutate(
            () => apiSend("DELETE", `/ai-router/circuits/${encodeURIComponent(scope)}`),
            "Failed to delete the circuit.",
          );
          setDeleteTarget(null);
        }}
      />
    </div>
  );
}

export default AiRouterConsole;
