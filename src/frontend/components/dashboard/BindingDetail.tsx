/**
 * @fileoverview Per-binding detail — one resource's identity, owning workers,
 * usage against its allowance, and its own action items.
 *
 * The action-items widget is scoped to this binding's service, so a D1 page
 * shows only D1 items, an R2 page only R2 items, etc. — the per-binding view the
 * account dashboard drills into.
 */

"use client";

import { Loader2Icon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { ApiError, apiGet } from "@/lib/api";
import { formatExact, formatRatio } from "@/lib/format";

import { ActionItems } from "./ActionItems";
import { AllowancesPanel } from "./AllowancesPanel";

type AttrResource = {
  key: string;
  type: string;
  id: string;
  name: string;
  workers: { worker: string; binding: string }[];
};
type Attribution = { resources: AttrResource[] };

type Reading = {
  id: string;
  label: string;
  unit: string;
  value: number;
  status: string;
  alertThreshold: number | null;
  breakdown: { label: string; value: number }[];
};

const PANEL = "rounded-xl border border-border/60 bg-background/40 p-6";

/**
 * @param type - probe/binding service (d1, r2, kv, vectorize, queue)
 * @param id   - the specific resource name/id from the URL
 */
export function BindingDetail({ type, id }: { type: string; id: string }) {
  const [attr, setAttr] = useState<Attribution | null>(null);
  const [reading, setReading] = useState<Reading | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [a, usage] = await Promise.all([
        apiGet<Attribution>("/guardian/attribution"),
        apiGet<{ readings: Reading[] }>("/guardian/usage?hours=24"),
      ]);
      setAttr(a);
      setReading(usage.readings.find((r) => r.id === type) ?? null);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "Sign in to view this binding."
          : err instanceof ApiError
            ? err.message
            : "Failed to load.",
      );
    } finally {
      setLoading(false);
    }
  }, [type]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading)
    return (
      <div className={`${PANEL} flex items-center gap-2 text-sm text-muted-foreground`}>
        <Loader2Icon className="size-4 animate-spin" /> Loading binding…
      </div>
    );
  if (error) return <p className={`${PANEL} text-sm text-muted-foreground`}>{error}</p>;

  // Match the resource by id or name within this type.
  const resource =
    attr?.resources.find((r) => r.type === type && (r.id === id || r.name === id)) ?? null;
  // The service-level reading's breakdown row for this resource, if present.
  const myBreakdown = reading?.breakdown.find((b) => b.label === id || b.label === resource?.name);
  const ratio =
    reading && reading.alertThreshold ? formatRatio(reading.value, reading.alertThreshold) : null;

  return (
    <div className="flex flex-col gap-6">
      <header>
        <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
          {type} · binding
        </div>
        <h1 className="mt-1 text-3xl font-bold tracking-tight">{resource?.name ?? id}</h1>
        {resource && resource.name !== resource.id && (
          <p className="font-mono text-xs text-muted-foreground">id: {resource.id}</p>
        )}
      </header>

      {/* Usage + attribution */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className={PANEL}>
          <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
            Usage (24h) · {reading?.unit ?? "—"}
          </div>
          <div className="mt-1 text-3xl font-semibold tabular-nums">
            {myBreakdown ? formatExact(myBreakdown.value) : reading ? formatExact(reading.value) : "—"}
          </div>
          {myBreakdown && (
            <div className="mt-0.5 text-xs text-muted-foreground">
              this resource of {reading ? formatExact(reading.value) : "—"} {reading?.unit} service total
            </div>
          )}
          {ratio && <div className="mt-2 text-xs text-muted-foreground">service vs threshold: {ratio}</div>}
        </div>

        <div className={PANEL}>
          <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
            Owning workers
          </div>
          {resource && resource.workers.length > 0 ? (
            <ul className="mt-2 flex flex-col gap-1">
              {resource.workers.map((w) => (
                <li key={`${w.worker}:${w.binding}`} className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="truncate font-mono">{w.worker}</span>
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">{w.binding}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">
              No worker binds this resource (orphaned — a cleanup candidate).
            </p>
          )}
        </div>
      </div>

      {/* This binding's allowance quota */}
      <AllowancesPanel service={type} />

      {/* Action items scoped to this binding's service */}
      <ActionItems service={type} mode="widget" />
    </div>
  );
}
