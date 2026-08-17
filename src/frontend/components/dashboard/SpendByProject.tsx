/**
 * @fileoverview SpendByProject — "who's eating the budget" card, billing-reconciled.
 *
 * Reads the cron-materialized `GET /api/guardian/spend-rollup` (one cheap D1
 * read — no compute on load). The headline is the Cloudflare **Billed** actual
 * with the run-rate **Projected** paired beside it; the composition bar mirrors
 * the bill by category; "Top spenders" is that actual *allocated* across
 * projects (sums to the bill), with unattributed/shared shown as honest pools.
 *
 * A ReUI stats-3 adaptation. Billed = ground truth (`billable_usage`), never a
 * raw estimate.
 */

"use client";

import { Loader2Icon } from "lucide-react";
import { useMemo } from "react";

import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { apiGet } from "@/lib/api";
import { usd } from "@/lib/format";

import { EmptyState, InlineError } from "@/components/dashboard/shared";
import { KindBadge, useResource, type Kind } from "@/components/projects/shared";

type Billed = { family: string; category: string; actualUsd: number; projectedUsd: number };
type ProjectSpend = { name: string; kind: string; totalUsd: number; byCategory: Record<string, number> };
type Pool = { name: string; totalUsd: number };
type Rollup = {
  window: { start: number; end: number; elapsedFraction: number };
  billed: Billed[];
  totalActualUsd: number;
  totalProjectedUsd: number;
  projects: ProjectSpend[];
  pools: Pool[];
};

/** category → label + stable chart-token color. */
const CATEGORY_META: Record<string, { label: string; color: string }> = {
  ai: { label: "AI", color: "var(--color-chart-1)" },
  do: { label: "Durable Objects", color: "var(--color-chart-2)" },
  d1: { label: "D1", color: "var(--color-chart-3)" },
  compute: { label: "Compute", color: "var(--color-chart-4)" },
  r2: { label: "R2", color: "var(--color-chart-5)" },
  vectorize: { label: "Vectorize", color: "var(--color-chart-1)" },
  other: { label: "Other", color: "var(--color-muted-foreground)" },
};
const metaFor = (cat: string) => CATEGORY_META[cat] ?? { label: cat, color: "var(--color-muted-foreground)" };

const POOL_HINT: Record<string, string> = {
  unattributed: "Billed to a product with no per-project basis (e.g. Durable Objects) — honestly not split.",
  shared: "A resource bound to several workers — Cloudflare can't split it per caller.",
};

const TOP_N = 6;

function pctLabel(fraction: number): string {
  if (!(fraction > 0)) return "0%";
  const p = fraction * 100;
  return p < 1 ? "<1%" : `${Math.round(p)}%`;
}

export function SpendByProject() {
  const { data, loading, error, reload } = useResource<Rollup>(() =>
    apiGet<Rollup>("/guardian/spend-rollup"),
  );

  const view = useMemo(() => {
    const total = data?.totalActualUsd ?? 0;
    // Composition bar: actual $ per category, summed across families.
    const byCat = new Map<string, number>();
    for (const b of data?.billed ?? []) byCat.set(b.category, (byCat.get(b.category) ?? 0) + b.actualUsd);
    const segments = [...byCat.entries()]
      .filter(([, usdv]) => usdv > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([cat, usdv]) => ({ cat, ...metaFor(cat), usd: usdv }));

    const projects = (data?.projects ?? []).filter((p) => p.totalUsd > 0);
    return {
      total,
      projected: data?.totalProjectedUsd ?? 0,
      segments,
      top: projects.slice(0, TOP_N),
      count: projects.length,
      pools: (data?.pools ?? []).filter((p) => p.totalUsd > 0),
    };
  }, [data]);

  return (
    <Card className="w-full gap-8">
      <CardHeader className="flex items-center justify-between gap-3">
        <CardTitle>Spend by Project</CardTitle>
        <CardAction>
          <span className="rounded-md border border-border/60 bg-muted/40 px-2.5 py-1 text-xs font-medium text-muted-foreground">
            This cycle
          </span>
        </CardAction>
      </CardHeader>

      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" />
            Loading…
          </div>
        ) : error ? (
          <InlineError message={error} onRetry={reload} />
        ) : view.total <= 0 ? (
          <EmptyState label="No billed spend yet this cycle — the reconciled ledger fills in on the next sync." />
        ) : (
          <>
            {/* Headline: Billed (truth) + Projected paired */}
            <div className="mb-1 flex items-center gap-2.5">
              <div className="flex flex-1 flex-col gap-1.5">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Billed this cycle
                </div>
                <div className="text-2xl font-bold tabular-nums text-foreground">
                  {usd(view.total)}
                </div>
              </div>
              <div className="flex flex-1 flex-col gap-1.5">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Projected
                </div>
                <div className="text-2xl font-bold tabular-nums text-muted-foreground">
                  {usd(view.projected)}
                </div>
              </div>
            </div>

            <p className="mb-4 text-[11px] leading-4 text-muted-foreground/70">
              Billed = your Cloudflare bill (actual). Per-project below is that actual allocated by
              estimated usage share — it sums to the bill.
            </p>

            {/* Category composition bar (of the actual bill) */}
            <div className="mb-3.5 flex h-2.5 w-full items-center gap-0.5 overflow-hidden rounded-full bg-muted">
              {view.segments.map((seg) => (
                <div
                  key={seg.cat}
                  className="h-full"
                  style={{ width: `${(seg.usd / view.total) * 100}%`, backgroundColor: seg.color }}
                  title={`${seg.label}: ${usd(seg.usd)} (${pctLabel(seg.usd / view.total)})`}
                />
              ))}
            </div>

            {/* Legend */}
            <div className="mb-6 flex flex-wrap items-center gap-x-5 gap-y-1.5">
              {view.segments.map((seg) => (
                <div key={seg.cat} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="inline-block size-2 rounded-full" style={{ backgroundColor: seg.color }} />
                  {seg.label}
                  <span className="font-semibold text-foreground">{pctLabel(seg.usd / view.total)}</span>
                </div>
              ))}
            </div>

            {/* Top spenders (reconciled allocation) */}
            <div className="mb-2.5 text-sm tracking-wide text-muted-foreground">Top spenders</div>
            {view.top.map((p) => (
              <div
                key={p.name}
                className="mb-2 flex items-center justify-between gap-2 rounded-md border border-border/40 bg-muted/40 px-3 py-2.5 last:mb-0"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="truncate text-sm font-medium text-foreground">{p.name}</span>
                  <KindBadge kind={p.kind as Kind} />
                </div>
                <div className="flex shrink-0 items-center gap-2.5">
                  <span className="text-xs tabular-nums text-muted-foreground">
                    <span className="font-semibold text-foreground">{usd(p.totalUsd)}</span>
                    {" · "}
                    {pctLabel(p.totalUsd / view.total)}
                  </span>
                  <Separator orientation="vertical" className="h-3 bg-accent-foreground/20" />
                  <a
                    href={`/dashboard/projects/${encodeURIComponent(p.name)}`}
                    className="text-xs font-medium text-primary hover:underline"
                  >
                    View
                  </a>
                </div>
              </div>
            ))}

            {/* Honest pools */}
            {view.pools.map((pool) => (
              <div
                key={pool.name}
                className="mb-2 flex items-center justify-between gap-2 rounded-md border border-dashed border-border/40 px-3 py-2.5 last:mb-0"
                title={POOL_HINT[pool.name]}
              >
                <span className="text-sm font-medium capitalize text-muted-foreground">{pool.name}</span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  <span className="font-semibold text-foreground/80">{usd(pool.totalUsd)}</span>
                  {" · "}
                  {pctLabel(pool.totalUsd / view.total)}
                </span>
              </div>
            ))}
          </>
        )}
      </CardContent>
    </Card>
  );
}
