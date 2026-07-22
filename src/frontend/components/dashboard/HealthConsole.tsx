/**
 * @fileoverview Health console — run the diagnostic, see each check pass/fail, and
 * for any failure copy a ready-to-paste fix prompt for a coding agent.
 *
 * Uses the existing /api/health endpoints. Copy feedback is an inline toast, not
 * a browser alert (a modal dialog would freeze the extension's event loop).
 */

"use client";

import { CheckCircle2Icon, CircleAlertIcon, CopyIcon, Loader2Icon, PlayIcon, XCircleIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Gauge } from "@/components/charts";
import { Button } from "@/components/ui/button";
import { ApiError, apiGet, apiSend } from "@/lib/api";
import { relativeTime } from "@/lib/format";

type Result = {
  id: string;
  category: string;
  name: string;
  status: "ok" | "warn" | "fail" | "skipped" | "timeout";
  message: string | null;
  details: Record<string, unknown> | null;
  durationMs: number;
};
type Run = { id: string; status: string; trigger: string; durationMs: number; createdAt: number };
type Payload = { run: Run | null; results: Result[] };

const PANEL = "rounded-xl border border-border/60 bg-background/40 p-6";

const STATUS: Record<Result["status"], { icon: typeof CheckCircle2Icon; tone: string }> = {
  ok: { icon: CheckCircle2Icon, tone: "text-emerald-600 dark:text-emerald-400" },
  warn: { icon: CircleAlertIcon, tone: "text-amber-600 dark:text-amber-400" },
  skipped: { icon: CircleAlertIcon, tone: "text-muted-foreground" },
  fail: { icon: XCircleIcon, tone: "text-rose-600 dark:text-rose-400" },
  timeout: { icon: XCircleIcon, tone: "text-rose-600 dark:text-rose-400" },
};

/** A paste-ready prompt for a coding agent to fix one failed check. */
function fixPrompt(r: Result): string {
  return `Core Guardian health check "${r.name}" (category: ${r.category}) is failing with status "${r.status}".
Message: ${r.message ?? "(none)"}
${r.details ? `Details: ${JSON.stringify(r.details)}` : ""}
This runs in a Cloudflare Worker (Hono + D1, src/backend/api/routes/health.ts). Diagnose the root cause and propose a minimal fix. Likely culprits: a missing/expired Secrets Store token, a binding absent from wrangler.jsonc, or an API permission scope.`.trim();
}

export function HealthConsole() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await apiGet<Payload>("/health/latest"));
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "Sign in to view health."
          : err instanceof ApiError
            ? err.message
            : "Failed to load health.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Auto-dismiss the toast.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      setData(await apiSend<Payload>("POST", "/health/run"));
      setToast("Diagnostic complete.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Run failed.");
    } finally {
      setRunning(false);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setToast("Fix prompt copied.");
    } catch {
      setToast("Copy failed — select and copy manually.");
    }
  }

  if (error && !data) return <p className={`${PANEL} text-sm text-muted-foreground`}>{error}</p>;
  if (loading && !data)
    return (
      <div className={`${PANEL} flex items-center gap-2 text-sm text-muted-foreground`}>
        <Loader2Icon className="size-4 animate-spin" /> Loading health…
      </div>
    );

  const results = data?.results ?? [];
  const ok = results.filter((r) => r.status === "ok").length;
  const scorable = results.filter((r) => r.status !== "skipped").length;
  const score = scorable > 0 ? Math.round((ok / scorable) * 100) : null;
  const failures = results.filter((r) => r.status === "fail" || r.status === "timeout");

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-5">
          {score !== null && (
            <Gauge
              score={score}
              status={failures.length === 0 ? "Healthy" : `${failures.length} failing`}
              tone={score >= 90 ? "emerald" : score >= 70 ? "amber" : "rose"}
              size={140}
            />
          )}
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
              Guardian · Health
            </div>
            <h2 className="mt-1 text-2xl font-semibold tracking-tight">
              {score !== null ? `${score}% healthy` : "Health"}
            </h2>
            {data?.run && (
              <p className="mt-1 text-sm text-muted-foreground">
                {ok}/{scorable} checks passing · last run {relativeTime(data.run.createdAt)} ({data.run.durationMs}ms)
              </p>
            )}
          </div>
        </div>
        <Button onClick={() => void run()} disabled={running} className="gap-2">
          {running ? <Loader2Icon className="size-4 animate-spin" /> : <PlayIcon className="size-4" />}
          {running ? "Running…" : "Run diagnostic"}
        </Button>
      </header>

      {(error || toast) && (
        <p className={`${PANEL} text-sm ${error ? "text-destructive" : "text-muted-foreground"}`}>
          {error ?? toast}
        </p>
      )}

      {/* Check grid */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {results.map((r) => {
          const S = STATUS[r.status];
          const Icon = S.icon;
          return (
            <div key={r.id} className={`${PANEL} flex items-start gap-3 py-4`}>
              <Icon className={`mt-0.5 size-4 shrink-0 ${S.tone}`} />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm">{r.name}</span>
                  <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                    {r.category}
                  </span>
                </div>
                {r.message && <p className="mt-0.5 truncate text-xs text-muted-foreground">{r.message}</p>}
              </div>
              <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                {r.durationMs}ms
              </span>
            </div>
          );
        })}
        {results.length === 0 && (
          <p className={`${PANEL} text-sm text-muted-foreground`}>No results yet — run a diagnostic.</p>
        )}
      </div>

      {/* Failure fix prompts */}
      {failures.length > 0 && (
        <section className="flex flex-col gap-3">
          <h3 className="text-base font-medium text-rose-600 dark:text-rose-400">
            {failures.length} failing — fix prompts
          </h3>
          {failures.map((r) => (
            <div key={r.id} className={`${PANEL} ring-1 ring-rose-500/20`}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-sm">{r.name}</span>
                <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void copy(fixPrompt(r))}>
                  <CopyIcon className="size-3.5" /> Copy fix prompt
                </Button>
              </div>
              <pre className="mt-3 overflow-x-auto whitespace-pre-wrap rounded-lg bg-foreground/[0.03] p-3 font-mono text-xs text-muted-foreground">
                {fixPrompt(r)}
              </pre>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
