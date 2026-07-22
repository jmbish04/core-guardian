/**
 * @fileoverview Allowances panel — per-binding included-allowance quota meters.
 *
 * Reads /api/guardian/allowances and renders a UsageQuotaMeter per comparable
 * probe (projected % of the monthly/daily included allowance, used / included,
 * remaining), tone-graded so "heading to red / on fire" reads at a glance. Non-
 * comparable probes (unit mismatch) show raw usage with the reason, never a
 * fabricated percent.
 *
 * @param service - restrict to one probe (used on the per-binding page); omit
 *   for the account-wide grid.
 */

"use client";

import { Loader2Icon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { UsageQuotaMeter, toneForFraction } from "@/components/charts";
import { ApiError, apiGet } from "@/lib/api";
import { formatCount, formatExact, humanSize } from "@/lib/format";

type Allowance = {
  service: string;
  unit: string;
  comparable: boolean;
  included: number;
  usedSoFar: number;
  projected: number;
  projectedFraction: number | null;
  remaining: number | null;
  note?: string;
};
type Payload = { period: { monthStart: number; elapsedFraction: number }; allowances: Allowance[] };

const PANEL = "rounded-xl border border-border/60 bg-background/40 p-6";

/** Bytes units get humanSize; everything else gets a compact count. */
function fmt(unit: string, n: number): string {
  return unit.includes("bytes") ? humanSize(n) : formatExact(Math.round(n));
}

export function AllowancesPanel({ service }: { service?: string }) {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await apiGet<Payload>("/guardian/allowances"));
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "Sign in to view allowances."
          : err instanceof ApiError
            ? err.message
            : "Failed to load allowances.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !data)
    return (
      <div className={`${PANEL} flex items-center gap-2 text-sm text-muted-foreground`}>
        <Loader2Icon className="size-4 animate-spin" /> Loading allowances…
      </div>
    );
  if (!data) return error ? <p className={`${PANEL} text-sm text-muted-foreground`}>{error}</p> : null;

  const rows = service ? data.allowances.filter((a) => a.service === service) : data.allowances;
  const comparable = rows.filter((a) => a.comparable && a.projectedFraction !== null);
  const raw = rows.filter((a) => !a.comparable || a.projectedFraction === null);

  return (
    <section className="flex flex-col gap-4">
      {!service && (
        <div className="flex items-baseline justify-between">
          <h2 className="text-2xl font-semibold tracking-tight">Included allowances</h2>
          <span className="font-mono text-xs text-muted-foreground">
            billing month · {Math.round(data.period.elapsedFraction * 100)}% elapsed
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {comparable.map((a) => {
          const pct = Math.round((a.projectedFraction ?? 0) * 100);
          return (
            <UsageQuotaMeter
              key={a.service}
              meterLabel={a.service}
              meterCaption={`${a.unit} · projected to period end`}
              percent={pct}
              used={fmt(a.unit, a.usedSoFar)}
              limit={fmt(a.unit, a.included)}
              unitLabel="projected"
              tone={toneForFraction(a.projectedFraction ?? 0)}
              facts={[
                { label: "Projected", value: fmt(a.unit, a.projected) },
                {
                  label: "Remaining",
                  value: a.remaining !== null ? fmt(a.unit, a.remaining) : "—",
                },
                { label: "Of allowance", value: `${pct}%` },
              ]}
            />
          );
        })}
      </div>

      {raw.length > 0 && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {raw.map((a) => (
            <div key={a.service} className={PANEL}>
              <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
                {a.service}
              </div>
              <div className="mt-1 text-2xl font-semibold tabular-nums">{formatCount(a.usedSoFar)}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{a.unit} · not comparable</div>
              {a.note && <p className="mt-2 text-xs text-muted-foreground/80">{a.note}</p>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
