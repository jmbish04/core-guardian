/**
 * @fileoverview Allowances panel — per-binding included-allowance quota meters.
 *
 * Reads /api/guardian/allowances and renders an AllowanceBar per comparable
 * probe: a horizontal bullet bar with the included allowance as a reference line
 * at 100%, current usage filling to it (tone-graded), overage overflowing past
 * it in red, and a ghost marker at the projected run-rate. Non-comparable probes
 * (unit mismatch) show raw usage with the reason, never a fabricated percent.
 *
 * @param service - restrict to one probe (used on the per-binding page); omit
 *   for the account-wide grid.
 */

"use client";

import { Loader2Icon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { AllowanceBar } from "@/components/charts";
import { ApiError, apiGet } from "@/lib/api";
import { formatUsage } from "@/lib/format";

type Allowance = {
  service: string;
  displayName: string;
  binding?: string;
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

const PANEL = "rounded-xl bg-card p-6 ring-1 ring-border/40";

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
        {comparable.map((a) => (
          <AllowanceBar
            key={`${a.service}-${a.binding ?? a.unit}`}
            label={a.displayName}
            binding={a.binding}
            unit={a.unit}
            included={a.included}
            usedSoFar={a.usedSoFar}
            projected={a.projected}
            overageCostUsd={a.overageCostUsd}
            remaining={a.remaining}
            plan={data.plan}
          />
        ))}
      </div>

      {raw.length > 0 && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {raw.map((a) => (
            <div key={`${a.service}-${a.binding ?? a.unit}`} className={PANEL}>
              <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
                {a.displayName}
                {a.binding && <span className="ml-1 normal-case tracking-normal">· {a.binding}</span>}
              </div>
              <div className="mt-1 text-2xl font-semibold tabular-nums">
                {formatUsage(a.unit, a.usedSoFar)}
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">{a.unit} · not comparable</div>
              {a.note && <p className="mt-2 text-xs text-muted-foreground/80">{a.note}</p>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
