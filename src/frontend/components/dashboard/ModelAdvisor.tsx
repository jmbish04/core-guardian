/**
 * @fileoverview Model advisor — proactive "switch to a cheaper, equally-capable
 * model" recommendations over the account's observed AI usage.
 *
 * Reads `GET /api/guardian/model-recommendations`. Two variants share one data
 * shape:
 *   - `widget` (dashboard): the total monthly saving on the table plus the top
 *     few swaps; clicking any row opens the full page anchored to that rec.
 *   - `full` (/dashboard/recommendations): every recommendation with its
 *     rationale, observed token mix, and current-vs-suggested pricing, plus a
 *     day-range control and the opt-in prompt-classification toggle. A `#rec-…`
 *     hash from the widget highlights and scrolls to the clicked row.
 */

"use client";

import { ArrowRightIcon, Loader2Icon, SparklesIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { ApiError, apiGet } from "@/lib/api";
import { compactNumber } from "@/lib/format";

type Tier = "small" | "mid" | "frontier";
type Recommendation = {
  id: string;
  currentModel: string;
  currentProvider: string;
  currentTier: Tier;
  observedRequests: number;
  avgInTokens: number;
  avgOutTokens: number;
  observedMonthlyUsd: number;
  suggestedModel: string;
  suggestedProvider: string;
  suggestedTier: Tier;
  suggestedMonthlyUsd: number;
  monthlySavingsUsd: number;
  savingsPct: number;
  rationale: string;
  basis: "tier" | "prompt-classified";
};
type Report = {
  days: number;
  classified: boolean;
  catalogSize: number;
  totalMonthlySavingsUsd: number;
  recommendations: Recommendation[];
};

const FULL_PAGE = "/dashboard/recommendations";

/** USD with grouping separators; cent-precise under $10, whole-dollar above. */
function usd(n: number): string {
  const digits = Math.abs(n) !== 0 && Math.abs(n) < 10 ? 2 : 0;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** Stable DOM id / hash target for one recommendation. */
function anchorId(id: string): string {
  return `rec-${id.replace(/[^a-zA-Z0-9]/g, "-")}`;
}

const TIER_LABEL: Record<Tier, string> = { small: "small", mid: "mid", frontier: "frontier" };
const TIER_CLASS: Record<Tier, string> = {
  small: "bg-slate-500/12 text-slate-600 dark:text-slate-300",
  mid: "bg-sky-500/12 text-sky-600 dark:text-sky-300",
  frontier: "bg-violet-500/12 text-violet-600 dark:text-violet-300",
};

function TierBadge({ tier }: { tier: Tier }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-medium ${TIER_CLASS[tier]}`}
    >
      {TIER_LABEL[tier]}
    </span>
  );
}

export function ModelAdvisor({ variant = "full" }: { variant?: "widget" | "full" }) {
  const isWidget = variant === "widget";
  const [days, setDays] = useState(30);
  const [classify, setClassify] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // The widget is a read-only teaser: never triggers the paid classify pass.
      setReport(
        await apiGet<Report>("/guardian/model-recommendations", {
          days,
          ...(isWidget ? {} : { classify }),
        }),
      );
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "Sign in to view model recommendations."
          : err instanceof ApiError
            ? err.message
            : "Failed to load model recommendations.",
      );
    } finally {
      setLoading(false);
    }
  }, [days, classify, isWidget]);

  useEffect(() => {
    void load();
  }, [load]);

  // On the full page, honor a #rec-… hash from the widget: highlight + scroll.
  useEffect(() => {
    if (isWidget || !report) return;
    const hash = window.location.hash.replace(/^#/, "");
    if (!hash) return;
    setFocus(hash);
    const el = document.getElementById(hash);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [isWidget, report]);

  const recs = report?.recommendations ?? [];
  const shown = isWidget ? recs.slice(0, 3) : recs;

  // -- Widget ----------------------------------------------------------------
  if (isWidget) {
    return (
      <section className="rounded-xl border border-border/60 bg-background/40 p-5">
        <header className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <SparklesIcon className="size-4 text-muted-foreground" />
            <h2 className="text-sm font-medium">Model advisor</h2>
          </div>
          <a
            href={FULL_PAGE}
            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            All recommendations →
          </a>
        </header>

        {loading && !report ? (
          <div className="flex h-20 items-center justify-center">
            <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <p className="mt-3 text-sm text-muted-foreground">{error}</p>
        ) : shown.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            No cheaper-but-capable swaps found — your models are well matched to their spend.
          </p>
        ) : (
          <>
            <p className="mt-1 text-xs text-muted-foreground">
              Up to{" "}
              <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                {usd(report!.totalMonthlySavingsUsd)}/mo
              </span>{" "}
              in potential savings across {recs.length}{" "}
              {recs.length === 1 ? "model" : "models"}
            </p>
            <ul className="mt-3 flex flex-col divide-y divide-border/40">
              {shown.map((r) => (
                <li key={r.id}>
                  <a
                    href={`${FULL_PAGE}#${anchorId(r.id)}`}
                    className="-mx-2 flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-foreground/[0.03]"
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                      <span className="truncate font-medium">{r.currentModel}</span>
                      <ArrowRightIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
                      <span className="truncate text-muted-foreground">{r.suggestedModel}</span>
                    </div>
                    <span className="shrink-0 font-mono text-xs font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                      −{usd(r.monthlySavingsUsd)}/mo
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    );
  }

  // -- Full page -------------------------------------------------------------
  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Model advisor</h1>
          <p className="text-sm text-muted-foreground">
            Cheaper models that are at least as capable for what you actually run — priced against
            your observed token mix over {days} days
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-border/60 px-3 py-1.5 text-xs">
            <input
              type="checkbox"
              checked={classify}
              onChange={(e) => setClassify(e.target.checked)}
              className="size-3.5 accent-foreground"
            />
            <span className={classify ? "text-foreground" : "text-muted-foreground"}>
              Analyze task prompts
            </span>
          </label>
          <div className="flex items-center gap-1 rounded-lg border border-border/60 p-0.5">
            {[7, 30, 90].map((d) => (
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
        </div>
      </header>

      {error ? (
        <p className="rounded-xl border border-border/60 bg-background/40 p-4 text-sm text-muted-foreground">
          {error}
        </p>
      ) : loading && !report ? (
        <div className="flex h-40 items-center justify-center rounded-xl border border-border/60 bg-background/40">
          <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : shown.length === 0 ? (
        <p className="rounded-xl border border-border/60 bg-background/40 p-6 text-center text-sm text-muted-foreground">
          No cheaper-but-capable swaps found across {report?.catalogSize ?? 0} catalog models. Your
          models are well matched to their spend.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-xl border border-border/60 bg-background/40 px-5 py-4">
            <span className="text-2xl font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
              {usd(report!.totalMonthlySavingsUsd)}/mo
            </span>
            <span className="text-sm text-muted-foreground">
              potential savings across {recs.length} {recs.length === 1 ? "model" : "models"} ·{" "}
              {report!.catalogSize.toLocaleString("en-US")} candidate models
              {report!.classified ? " · task-prompt analysis on" : ""}
            </span>
          </div>

          <ul className="flex flex-col gap-3">
            {shown.map((r) => {
              const focused = focus === anchorId(r.id);
              return (
                <li
                  key={r.id}
                  id={anchorId(r.id)}
                  className={`rounded-xl border bg-background/40 p-5 transition-colors ${
                    focused ? "border-foreground/30 ring-1 ring-foreground/15" : "border-border/60"
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{r.currentModel}</span>
                      <TierBadge tier={r.currentTier} />
                      <ArrowRightIcon className="size-4 text-muted-foreground/60" />
                      <span className="font-medium">{r.suggestedModel}</span>
                      <TierBadge tier={r.suggestedTier} />
                      {r.basis === "prompt-classified" && (
                        <span className="rounded bg-amber-500/12 px-1.5 py-0.5 font-mono text-[10px] text-amber-600 dark:text-amber-400">
                          prompt-analyzed
                        </span>
                      )}
                    </div>
                    <div className="text-right">
                      <div className="font-mono text-lg font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                        −{usd(r.monthlySavingsUsd)}/mo
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        {Math.round(r.savingsPct * 100)}% less · {usd(r.observedMonthlyUsd)} →{" "}
                        {usd(r.suggestedMonthlyUsd)}
                      </div>
                    </div>
                  </div>
                  <p className="mt-3 text-sm text-muted-foreground">{r.rationale}</p>
                  <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[11px] text-muted-foreground/80">
                    <span>{compactNumber(r.observedRequests)} req/{days}d</span>
                    <span>{compactNumber(r.avgInTokens)} in / {compactNumber(r.avgOutTokens)} out avg</span>
                    <span>
                      {r.currentProvider} → {r.suggestedProvider}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
