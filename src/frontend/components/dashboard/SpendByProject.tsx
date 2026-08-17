/**
 * @fileoverview SpendByProject — "who's eating the budget" card for the cockpit.
 *
 * A ReUI `stats-3` adaptation. The upstream block shows subscription revenue
 * split by plan tier plus an expiring-soon list; here the same shape answers
 * the owner's real question: of this month's spend, which *categories* and
 * which *projects* are burning the most.
 *
 *   - segmented bar   → spend composition by CATEGORY (compute / R2 / D1 /
 *                       Vectorize / AI)
 *   - top-spenders    → the individual projects, largest share first, each
 *                       linking to its per-project detail page
 *
 * Data: `GET /api/guardian/projects/usage` — the binding-graph attribution
 * ledger. Spend on a resource bound to one worker is credited to that project;
 * a resource shared by many workers lands in a "Shared" pool and one bound to
 * no tracked worker in "Unattributed" — never a fabricated per-project split.
 */

"use client";

import { Loader2Icon } from "lucide-react";
import { useMemo } from "react";

import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { apiGet } from "@/lib/api";
import { usd } from "@/lib/format";

import { EmptyState, InlineError } from "@/components/dashboard/shared";
import { KindBadge, useResource, type Kind } from "@/components/projects/shared";

type Category = "compute" | "r2" | "d1" | "vectorize" | "ai";
type Bucket = Record<Category, number>;
type ProjectSpend = {
  name: string;
  kind: string;
  criticality: string | null;
  totalUsd: number;
  byCategory: Bucket;
};
type UsageLedger = {
  windowHours: number;
  builtAt: number;
  categories: Category[];
  totalUsd: number;
  byCategory: Bucket;
  projects: ProjectSpend[];
};

/** Category order + label + a stable chart-token color. */
const CATEGORY_META: Record<Category, { label: string; color: string }> = {
  compute: { label: "Compute", color: "var(--color-chart-1)" },
  r2: { label: "R2", color: "var(--color-chart-2)" },
  d1: { label: "D1", color: "var(--color-chart-3)" },
  vectorize: { label: "Vectorize", color: "var(--color-chart-4)" },
  ai: { label: "AI", color: "var(--color-chart-5)" },
};
const CATEGORY_ORDER: Category[] = ["compute", "r2", "d1", "vectorize", "ai"];

/** The two honest spend pools that aren't a real project. */
const POOL_KINDS = new Set(["shared", "unattributed"]);
const POOL_LABEL: Record<string, string> = { shared: "Shared", unattributed: "Unattributed" };
const POOL_HINT: Record<string, string> = {
  shared: "A resource bound to several workers — Cloudflare can't split it per caller, so it isn't credited to one project.",
  unattributed: "Usage on a resource not bound to any tracked worker.",
};

const TOP_N = 6;

function pctLabel(fraction: number): string {
  if (!(fraction > 0)) return "0%";
  const p = fraction * 100;
  return p < 1 ? "<1%" : `${Math.round(p)}%`;
}

export function SpendByProject() {
  const { data, loading, error, reload } = useResource<UsageLedger>(() =>
    apiGet<UsageLedger>("/guardian/projects/usage"),
  );

  const view = useMemo(() => {
    const total = data?.totalUsd ?? 0;
    const segments = CATEGORY_ORDER.map((cat) => ({
      cat,
      ...CATEGORY_META[cat],
      usd: data?.byCategory?.[cat] ?? 0,
    })).filter((s) => s.usd > 0);

    const all = (data?.projects ?? []).filter((p) => p.totalUsd > 0);
    const real = all.filter((p) => !POOL_KINDS.has(p.kind));
    const pools = all.filter((p) => POOL_KINDS.has(p.kind));

    return { total, segments, top: real.slice(0, TOP_N), realCount: real.length, pools };
  }, [data]);

  return (
    <Card className="w-full gap-8">
      <CardHeader className="flex items-center justify-between gap-3">
        <CardTitle>Spend by Project</CardTitle>
        <CardAction>
          <span className="rounded-md border border-border/60 bg-muted/40 px-2.5 py-1 text-xs font-medium text-muted-foreground">
            This month
          </span>
        </CardAction>
      </CardHeader>

      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" />
            Attributing spend…
          </div>
        ) : error ? (
          <InlineError message={error} onRetry={reload} />
        ) : view.total <= 0 ? (
          <EmptyState label="No attributed spend yet — per-project cost lands here once usage is recorded this month." />
        ) : (
          <>
            {/* Headline cells */}
            <div className="mb-1 flex items-center gap-2.5">
              <div className="flex flex-1 flex-col gap-1.5">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Projected spend · est.
                </div>
                <div className="text-2xl font-bold tabular-nums text-foreground">
                  {usd(view.total)}
                </div>
              </div>
              <div className="flex flex-1 flex-col gap-1.5">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Billing projects
                </div>
                <div className="text-2xl font-bold tabular-nums text-foreground">
                  {view.realCount}
                </div>
              </div>
            </div>

            <p className="mb-4 text-[11px] leading-4 text-muted-foreground/70">
              Upper-bound estimate from marginal overage rates — not your actual bill. Reconcile
              against Cloudflare billing before acting.
            </p>

            {/* Category composition bar */}
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
                  <span
                    className="inline-block size-2 rounded-full"
                    style={{ backgroundColor: seg.color }}
                  />
                  {seg.label}
                  <span className="font-semibold text-foreground">{pctLabel(seg.usd / view.total)}</span>
                </div>
              ))}
            </div>

            {/* Top spenders */}
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

            {/* Honest pools — spend that can't be pinned to one project */}
            {view.pools.map((pool) => (
              <div
                key={pool.name}
                className="mb-2 flex items-center justify-between gap-2 rounded-md border border-dashed border-border/40 px-3 py-2.5 last:mb-0"
              >
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-medium text-muted-foreground">
                    {POOL_LABEL[pool.kind] ?? pool.name}
                  </span>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          aria-label={`About ${POOL_LABEL[pool.kind] ?? pool.name} spend`}
                          className="inline-flex cursor-help items-center rounded-full text-muted-foreground outline-none hover:text-foreground"
                        >
                          <span className="text-xs">ⓘ</span>
                        </button>
                      }
                    />
                    <TooltipContent className="max-w-xs">
                      <p>{POOL_HINT[pool.kind]}</p>
                    </TooltipContent>
                  </Tooltip>
                </div>
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
