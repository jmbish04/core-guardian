/**
 * @fileoverview CostTraceIsland — Guardian's billables mind-map. Pulls the
 * live per-binding allowance/overage data and lays it out as a cost trace:
 *
 *   Account → Category (Compute/Storage/AI/…) → binding (with $ + surge flag)
 *
 * so the whole spend relationship — what is billable, which category/binding it
 * rolls up under, and where a surge is projected — reads at a glance on any page
 * that drops in `<CostTraceIsland client:visible />`.
 *
 * Data source is /api/guardian/allowances (account-level per binding). Per-worker
 * attribution and AI-Gateway per-model breakdown nest under here once the P1
 * attribution graph lands — the CostNode tree is already recursive for it.
 */
"use client";

import { Loader2Icon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { CostTraceMap, type CostNode } from "@/components/charts/CostTraceMap";
import { ApiError, apiGet } from "@/lib/api";

type Allowance = {
  service: string;
  projectedFraction: number | null;
  overageCostUsd: number | null;
  unit: string;
  comparable: boolean;
};
type Payload = { plan: "free" | "paid"; allowances: Allowance[] };

/** Which category each binding rolls up under. Unknown → "Other". */
const CATEGORY: Record<string, string> = {
  workers: "Compute",
  containers: "Compute",
  workflows: "Compute",
  d1: "Storage",
  kv: "Storage",
  "r2-storage": "Storage",
  queues: "Messaging",
  vectorize: "AI",
  "workers-ai": "AI",
};

/** Build the Account→Category→binding cost tree from the allowance rows. */
export function buildTree(plan: string, rows: Allowance[]): CostNode {
  const byCat = new Map<string, CostNode[]>();
  for (const a of rows) {
    const cat = CATEGORY[a.service] ?? "Other";
    const cost = a.overageCostUsd ?? 0;
    const surge = (a.projectedFraction ?? 0) > 1;
    // Skip bindings with no cost and no surge — keep the map to what's billable.
    if (cost === 0 && !surge) continue;
    const pct = a.projectedFraction !== null ? `${Math.round(a.projectedFraction * 100)}% projected` : a.unit;
    (byCat.get(cat) ?? byCat.set(cat, []).get(cat)!).push({
      label: a.service,
      costUsd: cost > 0 ? cost : undefined,
      surge,
      detail: pct,
    });
  }
  const categories: CostNode[] = [...byCat.entries()]
    .map(([label, children]) => {
      const costUsd = children.reduce((s, c) => s + (c.costUsd ?? 0), 0);
      return {
        label,
        costUsd: costUsd > 0 ? costUsd : undefined,
        surge: children.some((c) => c.surge),
        children: children.sort((x, y) => (y.costUsd ?? 0) - (x.costUsd ?? 0)),
      };
    })
    .sort((x, y) => (y.costUsd ?? 0) - (x.costUsd ?? 0));

  const total = categories.reduce((s, c) => s + (c.costUsd ?? 0), 0);
  return {
    label: "Account billables",
    costUsd: total > 0 ? total : undefined,
    detail: `${plan} plan`,
    children: categories,
  };
}

export function CostTraceIsland() {
  const [tree, setTree] = useState<CostNode | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await apiGet<Payload>("/guardian/allowances");
      setTree(buildTree(data.plan, data.allowances));
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "Sign in to view the cost trace."
          : err instanceof ApiError
            ? err.message
            : "Failed to load the cost trace.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const PANEL = "rounded-xl border border-border/60 bg-background/40 p-6 text-sm text-muted-foreground";
  if (loading && !tree)
    return (
      <div className={`${PANEL} flex items-center gap-2`}>
        <Loader2Icon className="size-4 animate-spin" /> Building cost trace…
      </div>
    );
  if (!tree) return error ? <p className={PANEL}>{error}</p> : null;
  if (!tree.children?.length)
    return <p className={PANEL}>No billable overage or surge to trace right now.</p>;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-2xl font-semibold tracking-tight">Cost trace</h2>
        <span className="font-mono text-xs text-muted-foreground">
          account → category → binding · red = projected surge
        </span>
      </div>
      <CostTraceMap root={tree} />
    </section>
  );
}
