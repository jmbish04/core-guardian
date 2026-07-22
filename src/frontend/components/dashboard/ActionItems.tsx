/**
 * @fileoverview Action items — human-gated follow-ups (e.g. delete an archived
 * source). Renders as a compact dashboard widget (pending only, optionally
 * scoped to one binding) or a full page (pending + completed).
 *
 * Approving runs the destructive step server-side and then verifies it took
 * effect; the row moves pending → in_progress → complete|failed accordingly.
 */

"use client";

import { CheckCircle2Icon, ClockIcon, Loader2Icon, XCircleIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { ApiError, apiGet, apiSend } from "@/lib/api";
import { relativeTime } from "@/lib/format";

type Item = {
  id: string;
  kind: string;
  service: string;
  resourceType: string;
  resourceId: string;
  resourceName: string;
  title: string;
  description: string;
  audit: string | null;
  driveUrl: string | null;
  status: "pending" | "in_progress" | "complete" | "failed";
  verifyResult: string | null;
  error: string | null;
  createdAt: number;
  completedAt: number | null;
};

type Payload = {
  items: Item[];
  counts: { pending: number; inProgress: number; complete: number };
};

const PANEL = "rounded-xl border border-border/60 bg-background/40 p-5";

/**
 * @param service - restrict to one binding's items (e.g. "d1"); omit for all
 * @param mode - "widget" shows only pending; "full" shows pending + completed
 */
export function ActionItems({ service, mode = "full" }: { service?: string; mode?: "widget" | "full" }) {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const query = `${service ? `service=${encodeURIComponent(service)}&` : ""}status=all`;

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await apiGet<Payload>(`/guardian/action-items?${query}`));
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "Sign in to view action items."
          : err instanceof ApiError
            ? err.message
            : "Failed to load action items.",
      );
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);

  async function approve(id: string) {
    setBusy(id);
    setError(null);
    try {
      await apiSend("POST", `/guardian/action-items/${encodeURIComponent(id)}/approve`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Approve failed.");
    } finally {
      setBusy(null);
    }
  }

  if (loading && !data)
    return (
      <div className={`${PANEL} flex items-center gap-2 text-sm text-muted-foreground`}>
        <Loader2Icon className="size-4 animate-spin" /> Loading action items…
      </div>
    );
  if (!data) return error ? <p className={`${PANEL} text-sm text-muted-foreground`}>{error}</p> : null;

  const pending = data.items.filter((i) => i.status === "pending" || i.status === "in_progress");
  const done = data.items.filter((i) => i.status === "complete" || i.status === "failed");

  // Widget mode hides itself entirely when there is nothing to act on.
  if (mode === "widget" && pending.length === 0) return null;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className={mode === "widget" ? "text-base font-medium" : "text-2xl font-semibold tracking-tight"}>
          Action items{pending.length > 0 ? ` · ${pending.length} pending` : ""}
        </h2>
        {mode === "widget" && (
          <a href="/dashboard/action-items" className="text-xs text-muted-foreground hover:text-foreground">
            View all →
          </a>
        )}
      </div>

      {error && <p className={`${PANEL} text-sm text-destructive`}>{error}</p>}

      {pending.length === 0 && mode === "full" && (
        <p className={`${PANEL} text-sm text-muted-foreground`}>Nothing pending.</p>
      )}

      {pending.map((i) => (
        <ItemCard key={i.id} i={i} busy={busy === i.id} onApprove={approve} />
      ))}

      {mode === "full" && done.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
            {done.length} completed
          </summary>
          <div className="mt-3 flex flex-col gap-3">
            {done.map((i) => (
              <ItemCard key={i.id} i={i} busy={false} onApprove={approve} />
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

function ItemCard({
  i,
  busy,
  onApprove,
}: {
  i: Item;
  busy: boolean;
  onApprove: (id: string) => void;
}) {
  const audit = i.audit ? (JSON.parse(i.audit) as Record<string, unknown>) : null;
  const tone =
    i.status === "complete"
      ? "ring-emerald-500/25"
      : i.status === "failed"
        ? "ring-rose-500/25"
        : i.status === "in_progress"
          ? "ring-amber-500/25"
          : "ring-sky-500/25";
  return (
    <div className={`${PANEL} ring-1 ${tone}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <StatusIcon status={i.status} />
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              {i.service} · {i.status.replace("_", " ")}
            </span>
          </div>
          <h3 className="mt-1 text-base font-medium">{i.title}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{i.description}</p>
          {i.driveUrl && (
            <a
              href={i.driveUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="mt-1 inline-block text-xs text-sky-600 underline underline-offset-4 dark:text-sky-400"
            >
              View archive in Drive
            </a>
          )}
          {audit && (
            <p className="mt-1 font-mono text-[11px] text-muted-foreground">
              audit: {audit.rows as number} rows · {audit.driveBytes as number} bytes ·{" "}
              {audit.bytesMatch ? "verified ✓" : "MISMATCH ✗"}
            </p>
          )}
          {i.verifyResult && <p className="mt-1 text-xs text-muted-foreground">{i.verifyResult}</p>}
          {i.error && <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">{i.error}</p>}
        </div>
        <div className="shrink-0">
          {i.status === "pending" && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => onApprove(i.id)} className="gap-1.5">
              {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
              Approve delete
            </Button>
          )}
          <span className="ml-auto block text-right font-mono text-[10px] text-muted-foreground">
            {relativeTime(i.completedAt ?? i.createdAt)}
          </span>
        </div>
      </div>
    </div>
  );
}

function StatusIcon({ status }: { status: Item["status"] }) {
  if (status === "complete") return <CheckCircle2Icon className="size-4 text-emerald-600 dark:text-emerald-400" />;
  if (status === "failed") return <XCircleIcon className="size-4 text-rose-600 dark:text-rose-400" />;
  if (status === "in_progress") return <Loader2Icon className="size-4 animate-spin text-amber-600 dark:text-amber-400" />;
  return <ClockIcon className="size-4 text-sky-600 dark:text-sky-400" />;
}
