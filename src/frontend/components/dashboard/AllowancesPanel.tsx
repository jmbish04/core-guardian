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
  reset: "monthly" | "daily";
  included: number;
  usedSoFar: number;
  projected: number;
  projectedFraction: number | null;
  remaining: number | null;
  overageCostUsd: number | null;
  note?: string;
};
type Payload = {
  plan: "free" | "paid";
  period: { monthStart: number; elapsedFraction: number };
  allowances: Allowance[];
};

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
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-2xl font-semibold tracking-tight">Included allowances</h2>
            <span
              className={`rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.15em] ${
                data.plan === "paid"
                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : "bg-amber-500/10 text-amber-600 dark:text-amber-400"
              }`}
            >
              {data.plan} plan
            </span>
          </div>
          <span className="font-mono text-xs text-muted-foreground">
            {data.plan === "paid" ? "over allowance = billable overage" : "over allowance = hard cap"} ·{" "}
            {Math.round(data.period.elapsedFraction * 100)}% of month elapsed
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
                a.overageCostUsd !== null && a.overageCostUsd > 0
                  ? { label: data.plan === "paid" ? "Est. overage" : "Over cap by", value: `$${a.overageCostUsd.toFixed(2)}` }
                  : { label: "Remaining", value: a.remaining !== null ? fmt(a.unit, a.remaining) : "—" },
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
