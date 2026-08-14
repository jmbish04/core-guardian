/**
 * @fileoverview The Accountant — `/dashboard/accountant`.
 *
 * Two layers on one screen, reading `GET /api/guardian/billing/accountant`:
 *   - Layer 1: the actual-billed Cloudflare SKU lines with the SAME dollars the
 *     owner sees in CF's own bill dashboard, ranked by actual $ desc (AI is the
 *     fire; D1 sits quietly — no equal-weight alarms on cheap lines).
 *   - Layer 2: guardian's value-add per line — est-vs-actual DISCREPANCY
 *     (dispute evidence), AI ATTRIBUTION (which model/project drove the neurons,
 *     which CF can't tell you), and the month-end projection.
 *
 * `attribution` is duplicated onto every AI SKU by the API — it's rendered once
 * per row inside that row's expand panel; it is never summed across SKUs.
 */

"use client";

import { ChevronRightIcon, Loader2Icon, TrendingDownIcon, TrendingUpIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ApiError, apiGet } from "@/lib/api";
import { formatCount, usd } from "@/lib/format";

import { InlineError } from "./shared";

// --- Response types (mirror AccountantReport in the backend) ----------------

type Category =
  | "ai"
  | "durable_objects"
  | "d1"
  | "r2"
  | "kv"
  | "vectorize"
  | "queues"
  | "other";
type Severity = "low" | "medium" | "high";

type SkuAttribution = {
  byModel: { model: string; usd: number; neurons: number }[];
  byProject: { project: string; usd: number; calls: number }[];
};
type AccountantSku = {
  sku: string;
  family: string;
  unit: string;
  actualUsd: number;
  estimateUsd: number | null;
  discrepancyUsd: number | null;
  discrepancyPct: number | null;
  category: Category;
  projectedMonthEnd: number;
  attribution: SkuAttribution | null;
};
type DiscrepancyFlag = {
  sku: string;
  actualUsd: number;
  estimateUsd: number | null;
  discrepancyUsd: number;
  discrepancyPct: number | null;
  severity: Severity;
};
type AccountantReport = {
  currency: string;
  days: number;
  totalActualUsd: number;
  windowAccuracy: number | null;
  skus: AccountantSku[];
  flags: DiscrepancyFlag[];
};

const CATEGORY_LABEL: Record<Category, string> = {
  ai: "AI",
  durable_objects: "Durable Objects",
  d1: "D1",
  r2: "R2",
  kv: "KV",
  vectorize: "Vectorize",
  queues: "Queues",
  other: "Other",
};

// --- Small presentational bits ----------------------------------------------

function CategoryBadge({ category }: { category: Category }) {
  return (
    <Badge variant={category === "ai" ? "default" : "secondary"} className="font-mono text-[10px]">
      {CATEGORY_LABEL[category]}
    </Badge>
  );
}

/**
 * Discrepancy chip: actual over estimate (we under-called it → the bill is
 * higher) reads rose ▲; actual under estimate reads emerald ▼. Shows the $ gap
 * and the %. A dash when there is no estimate to compare against.
 */
function DiscrepancyCell({ usd: gap, pct }: { usd: number | null; pct: number | null }) {
  if (gap == null) return <span className="text-muted-foreground/50">—</span>;
  if (Math.abs(gap) < 0.005) {
    return <span className="font-mono text-[11px] tabular-nums text-muted-foreground/60">flat</span>;
  }
  const up = gap > 0;
  return (
    <span
      className={`inline-flex items-center gap-1 font-mono text-[11px] tabular-nums ${
        up ? "text-rose-600 dark:text-rose-400" : "text-emerald-600 dark:text-emerald-400"
      }`}
    >
      {up ? <TrendingUpIcon className="size-3" /> : <TrendingDownIcon className="size-3" />}
      {up ? "+" : "−"}
      {usd(Math.abs(gap))}
      {pct != null ? (
        <span className="text-muted-foreground/70">({up ? "+" : "−"}{Math.abs(Math.round(pct))}%)</span>
      ) : null}
    </span>
  );
}

const SEVERITY_RING: Record<Severity, string> = {
  high: "ring-destructive/40 bg-destructive/10",
  medium: "ring-amber-500/40 bg-amber-500/[0.07]",
  low: "ring-border/40 bg-muted/20",
};
const SEVERITY_TEXT: Record<Severity, string> = {
  high: "text-destructive",
  medium: "text-amber-600 dark:text-amber-400",
  low: "text-muted-foreground",
};

/** One dispute-evidence card: the bill vs our estimate, the gap, the severity. */
function FlagCard({ flag }: { flag: DiscrepancyFlag }) {
  const up = flag.discrepancyUsd > 0;
  return (
    <div className={`flex flex-col gap-2 rounded-lg p-4 ring-1 ${SEVERITY_RING[flag.severity]}`}>
      <div className="flex items-start justify-between gap-3">
        <span className="font-mono text-xs text-foreground">{flag.sku}</span>
        <Badge
          variant={flag.severity === "high" ? "destructive" : "outline"}
          className="uppercase"
        >
          {flag.severity}
        </Badge>
      </div>
      <div className="flex items-baseline gap-2">
        <span className={`text-lg font-semibold tabular-nums ${SEVERITY_TEXT[flag.severity]}`}>
          {up ? "+" : "−"}
          {usd(Math.abs(flag.discrepancyUsd))}
        </span>
        {flag.discrepancyPct != null ? (
          <span className={`text-sm tabular-nums ${SEVERITY_TEXT[flag.severity]}`}>
            {up ? "+" : "−"}
            {Math.abs(Math.round(flag.discrepancyPct))}%
          </span>
        ) : null}
        <span className="text-xs text-muted-foreground">off estimate</span>
      </div>
      <div className="flex items-center gap-3 font-mono text-[11px] tabular-nums text-muted-foreground">
        <span>billed {usd(flag.actualUsd)}</span>
        <span aria-hidden>·</span>
        <span>estimate {flag.estimateUsd != null ? usd(flag.estimateUsd) : "—"}</span>
      </div>
    </div>
  );
}

/** AI attribution sub-panel — the who-drove-it breakdown, rendered once per row. */
function AttributionPanel({ attribution }: { attribution: SkuAttribution }) {
  const { byModel, byProject } = attribution;
  return (
    <div className="grid gap-6 rounded-lg bg-muted/20 p-4 ring-1 ring-border/40 sm:grid-cols-2">
      <div>
        <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          By model
        </h4>
        {byModel.length ? (
          <ul className="flex flex-col">
            {byModel.map((m) => (
              <li
                key={m.model}
                className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 py-1.5"
              >
                <span className="truncate font-mono text-xs">{m.model}</span>
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {formatCount(m.neurons, "neurons")}
                </span>
                <span className="w-16 text-right text-xs font-medium tabular-nums">
                  {usd(m.usd)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground/60">no model attribution</p>
        )}
      </div>
      <div>
        <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          By project
        </h4>
        {byProject.length ? (
          <ul className="flex flex-col">
            {byProject.map((p) => (
              <li
                key={p.project}
                className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 py-1.5"
              >
                <span className="truncate font-mono text-xs">{p.project}</span>
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {formatCount(p.calls, "calls")}
                </span>
                <span className="w-16 text-right text-xs font-medium tabular-nums">
                  {usd(p.usd)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground/60">no project attribution</p>
        )}
      </div>
    </div>
  );
}

/** One ledger row. AI rows with attribution expand to the who-drove-it panel. */
function SkuRow({ sku, emphasized }: { sku: AccountantSku; emphasized: boolean }) {
  const [open, setOpen] = useState(false);
  const expandable = sku.category === "ai" && sku.attribution != null;
  return (
    <>
      <TableRow
        className={`${emphasized ? "bg-primary/[0.04]" : ""} ${expandable ? "cursor-pointer" : ""}`}
        onClick={expandable ? () => setOpen((o) => !o) : undefined}
      >
        <TableCell className="ps-4">
          <div className="flex items-center gap-2">
            {expandable ? (
              <ChevronRightIcon
                className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
                aria-hidden
              />
            ) : (
              <span className="w-3.5 shrink-0" aria-hidden />
            )}
            <div className="min-w-0">
              <div className={`truncate ${emphasized ? "font-semibold" : "font-medium"}`}>
                {sku.sku}
              </div>
              <div className="truncate font-mono text-[10px] text-muted-foreground">
                {sku.family} · {sku.unit}
              </div>
            </div>
          </div>
        </TableCell>
        <TableCell>
          <CategoryBadge category={sku.category} />
        </TableCell>
        <TableCell className="text-right tabular-nums">
          <span className={emphasized ? "text-base font-semibold" : "font-medium"}>
            {usd(sku.actualUsd)}
          </span>
        </TableCell>
        <TableCell className="text-right tabular-nums text-muted-foreground">
          {sku.estimateUsd != null ? usd(sku.estimateUsd) : <span className="opacity-50">—</span>}
        </TableCell>
        <TableCell className="text-right">
          <DiscrepancyCell usd={sku.discrepancyUsd} pct={sku.discrepancyPct} />
        </TableCell>
        <TableCell className="pe-4 text-right tabular-nums text-muted-foreground">
          {sku.projectedMonthEnd > 0 ? usd(sku.projectedMonthEnd) : <span className="opacity-50">—</span>}
        </TableCell>
      </TableRow>
      {expandable && open ? (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={6} className="px-4 pb-4 pt-0">
            <AttributionPanel attribution={sku.attribution!} />
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

// --- The island -------------------------------------------------------------

export function AccountantView() {
  const [days, setDays] = useState(30);
  const [report, setReport] = useState<AccountantReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setReport(await apiGet<AccountantReport>("/guardian/billing/accountant", { days }));
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "Sign in to view the bill."
          : err instanceof ApiError
            ? err.message
            : "Failed to load the accountant.",
      );
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  const maxActual = report?.skus.reduce((m, s) => Math.max(m, s.actualUsd), 0) ?? 0;

  return (
    <section className="flex flex-col gap-8">
      {/* --- Header stat ----------------------------------------------------- */}
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-baseline gap-3">
            <span className="text-4xl font-semibold tabular-nums tracking-tight">
              {usd(report?.totalActualUsd ?? 0)}
            </span>
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              actual billed · {days}d
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Estimate accuracy{" "}
            <span className="font-medium text-foreground">
              {report?.windowAccuracy != null
                ? `${Math.round(report.windowAccuracy * 100)}%`
                : "—"}
            </span>{" "}
            — Layer 1 matches your Cloudflare bill; Layer 2 is what CF can&apos;t tell you.
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-lg p-0.5 ring-1 ring-border/40">
          {[30, 60, 90].map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                days === d
                  ? "bg-foreground/[0.08] text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {d}d
            </button>
          ))}
        </div>
      </header>

      {error ? (
        <InlineError message={error} onRetry={() => void load()} />
      ) : loading && !report ? (
        <div className="flex h-40 items-center justify-center rounded-xl bg-muted/20 ring-1 ring-border/40">
          <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : !report || report.skus.length === 0 ? (
        <div className="rounded-xl bg-muted/20 p-8 text-center text-sm text-muted-foreground ring-1 ring-border/40">
          No billed lines in this window yet.
        </div>
      ) : (
        <>
          {/* --- Discrepancy flags ------------------------------------------- */}
          {report.flags.length ? (
            <section className="flex flex-col gap-3">
              <div>
                <h2 className="text-sm font-semibold text-destructive">The math isn&apos;t mathing</h2>
                <p className="text-xs text-muted-foreground">
                  Lines where our estimate and the bill disagree — dispute evidence.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {report.flags.map((f) => (
                  <FlagCard key={f.sku} flag={f} />
                ))}
              </div>
            </section>
          ) : (
            <p className="rounded-lg bg-muted/20 px-4 py-3 text-xs text-muted-foreground ring-1 ring-border/40">
              Estimate reconciles with the bill — no discrepancies to dispute.
            </p>
          )}

          {/* --- The SKU ledger (Layer 1 + Layer 2) -------------------------- */}
          <section className="flex flex-col gap-3">
            <div>
              <h2 className="text-sm font-semibold">The ledger</h2>
              <p className="text-xs text-muted-foreground">
                Ranked by actual billed dollars. AI rows expand to the model/project breakdown.
              </p>
            </div>
            <div className="overflow-x-auto rounded-xl bg-card/40 ring-1 ring-border/40">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="ps-4">SKU</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead className="text-right">Actual billed</TableHead>
                    <TableHead className="text-right">Estimate</TableHead>
                    <TableHead className="text-right">Discrepancy</TableHead>
                    <TableHead className="pe-4 text-right">Proj. month-end</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.skus.map((s) => (
                    <SkuRow
                      key={s.sku}
                      sku={s}
                      emphasized={s.actualUsd > 0 && s.actualUsd === maxActual}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
            <p className="text-[11px] text-muted-foreground/70">
              Layer 1 matches your Cloudflare bill; Layer 2 is what CF can&apos;t tell you.
            </p>
          </section>
        </>
      )}
    </section>
  );
}
