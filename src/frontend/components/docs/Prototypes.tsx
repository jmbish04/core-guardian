/**
 * @fileoverview Static prototypes for the Core Guardian redesign.
 *
 * These render REAL numbers pulled from the live account on 2026-07-19 (the
 * 1.25B D1 rows read, the 99.2% `jules-mcp` concentration) but they are NOT
 * wired to the API — they are design targets, deliberately frozen so the
 * layout can be argued about without a login or a working probe.
 *
 * Every prototype here is annotated with the specific defect it fixes in the
 * shipped panel, so the diff between "what exists" and "what we're building"
 * is legible at a glance.
 */

"use client";

import {
  AlertTriangleIcon,
  ArrowRightIcon,
  ChevronDownIcon,
  DatabaseIcon,
  ExternalLinkIcon,
  TrendingUpIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/** Frame that labels each prototype with the defect it replaces. */
export function ProtoFrame({
  label,
  fixes,
  children,
}: {
  label: string;
  fixes: string;
  children: React.ReactNode;
}) {
  return (
    <div className="my-6 flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Badge variant="outline" className="font-mono text-[10px] uppercase tracking-[0.2em]">
          Prototype
        </Badge>
        <span className="text-sm font-medium">{label}</span>
      </div>
      <div className="rounded-xl border border-dashed border-border/70 bg-background/20 p-4">
        {children}
      </div>
      <p className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Fixes: </span>
        {fixes}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1. Action-first alert card
// ---------------------------------------------------------------------------

export function AlertCardProto() {
  return (
    <div className="overflow-hidden rounded-xl border border-rose-500/30 bg-rose-500/[0.04]">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-rose-500/20 px-5 py-4">
        <div className="flex min-w-0 items-start gap-3">
          <AlertTriangleIcon className="mt-0.5 size-5 shrink-0 text-rose-500" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-semibold">D1 reads running 10× baseline</h3>
              <Badge
                variant="outline"
                className="border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400"
              >
                Act today
              </Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              <span className="font-mono text-foreground">jules-mcp</span> database, bound to worker{" "}
              <span className="font-mono text-foreground">jules-mcp</span> as{" "}
              <span className="font-mono text-foreground">DB</span> — 1.24B of 1.25B account rows
              read in 24h (99.2%).
            </p>
          </div>
        </div>
        <div className="text-right">
          <div className="text-2xl font-semibold tabular-nums">~$37</div>
          <div className="text-xs text-muted-foreground">/mo at this rate</div>
        </div>
      </div>

      <dl className="grid grid-cols-1 divide-y divide-border/50 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <div className="px-5 py-3">
          <dt className="text-xs text-muted-foreground">Likely cause</dt>
          <dd className="mt-1 text-sm">
            Repeated full-table scan — 0 indexes on a 1,008 MB database
          </dd>
        </div>
        <div className="px-5 py-3">
          <dt className="text-xs text-muted-foreground">If ignored</dt>
          <dd className="mt-1 text-sm">
            37.5B rows/30d, cost grows linearly with traffic
          </dd>
        </div>
        <div className="px-5 py-3">
          <dt className="text-xs text-muted-foreground">Recommended fix</dt>
          <dd className="mt-1 text-sm">
            Add an index on the filtered column — not a mitigation
          </dd>
        </div>
      </dl>

      <div className="flex flex-wrap items-center gap-2 border-t border-border/50 bg-background/40 px-5 py-3">
        <Button size="sm" className="gap-1.5">
          Inspect database
          <ArrowRightIcon className="size-3.5" />
        </Button>
        <Button size="sm" variant="outline">
          Retune threshold
        </Button>
        <Button size="sm" variant="ghost">
          Snooze 24h
        </Button>
        <Button size="sm" variant="ghost" className="ml-auto gap-1.5 text-muted-foreground">
          Cloudflare dashboard
          <ExternalLinkIcon className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 2. Worker-grouped bindings table
// ---------------------------------------------------------------------------

const WORKER_ROWS = [
  {
    worker: "jules-mcp",
    url: "jules-mcp.hacolby.workers.dev",
    health: "choking",
    healthNote: "5xx in logs, 3 bindings",
    top: [
      { name: "DB", kind: "D1", value: "1.24B rows", tone: "bad" },
      { name: "SESSIONS", kind: "KV", value: "1.2k reads", tone: "ok" },
      { name: "FILES", kind: "R2", value: "412 MB", tone: "ok" },
    ],
    more: 0,
  },
  {
    worker: "core-guardian",
    url: "core-guardian.hacolby.workers.dev",
    health: "healthy",
    healthNote: "cron on time, 14/14 probes",
    top: [
      { name: "R2_FILES_BUCKET", kind: "R2", value: "38.4 GB", tone: "warn" },
      { name: "DB", kind: "D1", value: "8.1M rows", tone: "ok" },
      { name: "SESSIONS", kind: "KV", value: "460 reads", tone: "ok" },
    ],
    more: 14,
  },
];

const TONE: Record<string, string> = {
  bad: "text-rose-600 dark:text-rose-400",
  warn: "text-amber-600 dark:text-amber-400",
  ok: "text-foreground",
};

export function WorkerGroupedTableProto() {
  return (
    <div className="overflow-hidden rounded-xl border border-border/60 bg-background/40">
      <div className="border-b border-border/60 px-5 py-3">
        <h3 className="text-sm font-semibold">Bindings by worker</h3>
        <p className="text-xs text-muted-foreground">
          Top 3 consumers per worker. Everything else collapses.
        </p>
      </div>

      {WORKER_ROWS.map((row) => (
        <div key={row.worker} className="border-b border-border/40 last:border-b-0">
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <span
                className={`size-2 shrink-0 rounded-full ${
                  row.health === "healthy" ? "bg-emerald-500" : "bg-rose-500"
                }`}
              />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-medium">{row.worker}</span>
                  <a
                    href="#"
                    className="text-muted-foreground transition-colors hover:text-foreground"
                    aria-label="Open deployed worker"
                  >
                    <ExternalLinkIcon className="size-3.5" />
                  </a>
                </div>
                <span className="text-xs text-muted-foreground">{row.healthNote}</span>
              </div>
            </div>
            <Badge
              variant="outline"
              className={
                row.health === "healthy"
                  ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : "border-rose-500/25 bg-rose-500/10 text-rose-600 dark:text-rose-400"
              }
            >
              {row.health === "healthy" ? "Healthy" : "Degraded"}
            </Badge>
          </div>

          {/* 3-per-row binding grid, as requested */}
          <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 px-5 pb-3 sm:grid-cols-3">
            {row.top.map((b) => (
              <div key={b.name} className="flex items-baseline justify-between gap-2 text-xs">
                <span className="truncate">
                  <span className="font-mono">{b.name}</span>
                  <span className="ml-1.5 text-muted-foreground">{b.kind}</span>
                </span>
                <span className={`shrink-0 tabular-nums ${TONE[b.tone]}`}>{b.value}</span>
              </div>
            ))}
          </div>

          {row.more > 0 && (
            <button
              type="button"
              className="flex w-full items-center gap-1.5 px-5 pb-3 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronDownIcon className="size-3.5" />
              …{row.more} more bindings
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3. Number formatting: before / after
// ---------------------------------------------------------------------------

const FORMAT_ROWS = [
  { ctx: "Alert body", before: "45523699 rows read in 1h", after: "45.5M rows read in 1h" },
  { ctx: "Alert threshold", before: "exceeds threshold 5000000", after: "exceeds threshold of 5M rows" },
  { ctx: "KPI headline", before: "25768% of limit", after: "258× over limit" },
  { ctx: "Standout figure", before: "1248879489", after: "1,248,879,489 rows" },
  { ctx: "Table cell", before: "42410432148", after: "39.5 GB" },
  { ctx: "Pie slice label", before: "c9537508-3089-4ce7…", after: "jules-mcp" },
];

export function FormattingProto() {
  return (
    <div className="overflow-hidden rounded-xl border border-border/60 bg-background/40">
      <div className="grid grid-cols-[auto_1fr_1fr] gap-x-4 border-b border-border/60 px-5 py-2.5 text-[10px] font-medium uppercase tracking-[0.15em] text-muted-foreground">
        <span>Context</span>
        <span>Today</span>
        <span>Target</span>
      </div>
      {FORMAT_ROWS.map((r) => (
        <div
          key={r.ctx}
          className="grid grid-cols-[auto_1fr_1fr] items-baseline gap-x-4 border-b border-border/40 px-5 py-2.5 text-xs last:border-b-0"
        >
          <span className="whitespace-nowrap text-muted-foreground">{r.ctx}</span>
          <span className="font-mono text-rose-600 line-through decoration-rose-500/40 dark:text-rose-400">
            {r.before}
          </span>
          <span className="font-mono text-emerald-600 dark:text-emerald-400">{r.after}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 4. Overview page skeleton
// ---------------------------------------------------------------------------

export function OverviewSkeletonProto() {
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg border border-rose-500/30 bg-rose-500/[0.06] px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <AlertTriangleIcon className="size-4 text-rose-500" />
          Needs attention — 1 critical, 2 elevated
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          Action cards. Always first. Empty state says &ldquo;nothing needs you right now&rdquo;.
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { l: "Projected spend", v: "$61", s: "/mo", d: "+12%" },
          { l: "Largest driver", v: "D1", s: "reads", d: "61%" },
          { l: "Storage footprint", v: "39.5", s: "GB", d: "+2%" },
          { l: "Workers monitored", v: "183", s: "", d: "14 probes" },
        ].map((c) => (
          <div key={c.l} className="rounded-lg border border-border/60 bg-background/40 px-4 py-3">
            <div className="text-xs text-muted-foreground">{c.l}</div>
            <div className="mt-1 flex items-baseline gap-1.5">
              <span className="text-xl font-semibold tabular-nums">{c.v}</span>
              <span className="text-sm text-muted-foreground/50">{c.s}</span>
            </div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">{c.d}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[2fr_1fr]">
        <div className="flex h-28 items-center justify-center rounded-lg border border-border/60 bg-background/40 text-xs text-muted-foreground">
          Spend trend — stacked by product, 30d
        </div>
        <div className="flex h-28 items-center justify-center rounded-lg border border-border/60 bg-background/40 text-xs text-muted-foreground">
          Spend mix — by product, $ normalized
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {["Data Storage", "AI & Inference", "Compute", "Networking"].map((l) => (
          <a
            key={l}
            href="#"
            className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-background/40 px-4 py-3 text-sm transition-colors hover:bg-foreground/[0.03]"
          >
            {l}
            <ArrowRightIcon className="size-3.5 text-muted-foreground" />
          </a>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 5. Combobox for emergency controls
// ---------------------------------------------------------------------------

export function ComboboxProto() {
  return (
    <div className="max-w-md rounded-xl border border-border/60 bg-background/40 p-4">
      <label className="text-sm font-medium">Bucket</label>
      <div className="mt-2 rounded-md border border-border bg-background px-3 py-2 font-mono text-sm">
        core-gu<span className="animate-pulse">|</span>
      </div>
      <div className="mt-1 overflow-hidden rounded-md border border-border bg-background">
        {[
          { n: "core-guardian-audio", s: "412 MB · 1,204 objects" },
          { n: "core-guardian-files", s: "38.4 GB · 91,022 objects" },
        ].map((b, i) => (
          <div
            key={b.n}
            className={`flex items-baseline justify-between gap-3 px-3 py-2 text-sm ${
              i === 0 ? "bg-foreground/[0.06]" : ""
            }`}
          >
            <span className="font-mono">{b.n}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{b.s}</span>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Options come from <span className="font-mono">GET /api/storage/r2/buckets</span>. No free
        text — you cannot typo a bucket name into a destructive call.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 7. Cost-basis page (pricing revisions)
// ---------------------------------------------------------------------------

const RATE_ROWS = [
  { product: "D1", metric: "rows read", rate: "$0.001 / M", changed: "unchanged", tone: "ok" },
  { product: "D1", metric: "storage", rate: "$0.75 / GB-mo", changed: "unchanged", tone: "ok" },
  { product: "R2", metric: "storage", rate: "$0.015 / GB-mo", changed: "unchanged", tone: "ok" },
  { product: "R2", metric: "Class A ops", rate: "$4.50 / M", changed: "↑ from $4.00", tone: "up" },
  { product: "Workers AI", metric: "llama-3.1-8b in", rate: "$0.045 / M tok", changed: "new", tone: "new" },
];

const RATE_TONE: Record<string, string> = {
  ok: "text-muted-foreground",
  up: "text-rose-600 dark:text-rose-400",
  new: "text-sky-600 dark:text-sky-400",
};

export function CostBasisProto() {
  return (
    <div className="overflow-hidden rounded-xl border border-border/60 bg-background/40">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-5 py-3">
        <div>
          <h3 className="text-sm font-semibold">Cost basis</h3>
          <p className="text-xs text-muted-foreground">
            Rates from the last scrape · 2026-07-01 · 6 doc pages
          </p>
        </div>
        <Badge
          variant="outline"
          className="gap-1 border-amber-500/25 bg-amber-500/10 text-amber-600 dark:text-amber-400"
        >
          <TrendingUpIcon className="size-3" />2 changes since June
        </Badge>
      </div>

      <div className="grid grid-cols-[auto_1fr_auto_auto] gap-x-4 border-b border-border/60 px-5 py-2 text-[10px] font-medium uppercase tracking-[0.15em] text-muted-foreground">
        <span>Product</span>
        <span>Metric</span>
        <span className="text-right">Rate</span>
        <span className="text-right">vs last scrape</span>
      </div>
      {RATE_ROWS.map((r) => (
        <div
          key={r.product + r.metric}
          className="grid grid-cols-[auto_1fr_auto_auto] items-baseline gap-x-4 border-b border-border/40 px-5 py-2.5 text-xs last:border-b-0"
        >
          <span className="font-medium">{r.product}</span>
          <span className="text-muted-foreground">{r.metric}</span>
          <span className="text-right font-mono tabular-nums">{r.rate}</span>
          <span className={`text-right font-mono ${RATE_TONE[r.tone]}`}>{r.changed}</span>
        </div>
      ))}

      <p className="px-5 py-3 text-xs text-muted-foreground">
        Every rate links to the <span className="font-mono">scrape_run</span> it came from — the
        exact page, markdown, and timestamp. Spend is calculated against these, never a hardcoded
        constant.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 6. Binding viewport header
// ---------------------------------------------------------------------------

export function BindingViewportProto() {
  return (
    <div className="overflow-hidden rounded-xl border border-border/60 bg-background/40">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border/60 px-5 py-4">
        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.06]">
            <DatabaseIcon className="size-5" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-mono text-base font-semibold">jules-mcp</h3>
              <Badge variant="outline" className="text-muted-foreground">
                D1
              </Badge>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              worker <span className="font-mono text-foreground">jules-mcp</span> · binding{" "}
              <span className="font-mono text-foreground">DB</span> · created 2026-03-11
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline">
            Archive to Drive
          </Button>
          <Button size="sm" variant="destructive">
            Delete
          </Button>
        </div>
      </div>

      <div className="flex items-start gap-3 border-b border-border/40 bg-amber-500/[0.05] px-5 py-3">
        <TrendingUpIcon className="mt-0.5 size-4 shrink-0 text-amber-500" />
        <div className="text-xs">
          <span className="font-medium">AI insight — </span>
          <span className="text-muted-foreground">
            1,008 MB across 0 declared tables suggests an undeclared schema or an orphaned
            database. Reads grew 21% week-over-week with no matching write growth, which is the
            signature of an unindexed read path rather than genuine data growth.
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 divide-x divide-border/40 sm:grid-cols-4">
        {[
          { l: "Rows read 24h", v: "1.24B" },
          { l: "Rows written 24h", v: "12.4k" },
          { l: "Size", v: "1,008 MB" },
          { l: "Est. cost", v: "$37/mo" },
        ].map((s) => (
          <div key={s.l} className="px-5 py-3">
            <div className="text-[11px] text-muted-foreground">{s.l}</div>
            <div className="mt-0.5 text-sm font-semibold tabular-nums">{s.v}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
