/**
 * @fileoverview AI model-savings recommendations — `/dashboard/ai-recommendations`.
 *
 * Reads `GET /api/guardian/billing/ai-recommendations?days=…`: for each
 * (project, model) with real AI spend, the cheaper-but-at-least-as-capable
 * swaps and the dollars they'd save. The header shows the total addressable
 * saving loud; the table ranks rows by best per-row saving; each row expands to
 * the top-3 alternatives, and every alternative offers a one-click Jules switch.
 *
 * Rows with `topSavingsUsd == null` are already cost-optimal and render quietly.
 * Rows with `project == null` (direct Workers-AI, no repo) can't be switched.
 */

"use client";

import { ChevronRightIcon, SparklesIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, apiGet } from "@/lib/api";
import { usd } from "@/lib/format";

import { AiModelSwitchDialog } from "./AiModelSwitchDialog";
import { InlineError } from "./shared";

// --- Response types (mirror modelSavingsResponseSchema in the backend) -------

type Alternative = {
  model: string;
  provider: string;
  ratePerM: number;
  estimatedSavingsUsd: number;
  savingsPct: number;
};
type Recommendation = {
  project: string | null;
  currentModel: string;
  currentProvider: string;
  currentSpendUsd: number;
  alternatives: Alternative[];
  topSavingsUsd: number | null;
};
type ModelSavingsResponse = {
  days: number;
  totalPotentialSavingsUsd: number;
  recommendations: Recommendation[];
};

const NO_PROJECT_LABEL = "direct Workers-AI (no project)";

/** $/1M rate token. */
function ratePerMToken(rate: number) {
  return `${usd(rate)}/1M`;
}

/** One alternative line inside an expanded row. */
function AltRow({ rec, alt }: { rec: Recommendation; alt: Alternative }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <div className="truncate font-mono text-xs text-foreground">{alt.model}</div>
        <div className="truncate font-mono text-[10px] text-muted-foreground">
          {alt.provider} · {ratePerMToken(alt.ratePerM)}
        </div>
      </div>
      <div className="flex items-center gap-4">
        <div className="text-right">
          <div className="text-sm font-semibold tabular-nums text-emerald-500">
            {usd(alt.estimatedSavingsUsd)}
          </div>
          <div className="text-[10px] tabular-nums text-muted-foreground">
            −{Math.round(alt.savingsPct)}%
          </div>
        </div>
        {rec.project != null ? (
          <AiModelSwitchDialog
            project={rec.project}
            currentModel={rec.currentModel}
            altModel={alt.model}
            altProvider={alt.provider}
            savingsUsd={alt.estimatedSavingsUsd}
            usdFmt={usd}
          />
        ) : null}
      </div>
    </li>
  );
}

/** One recommendation row. Expands to the top-3 alternatives. */
function RecRow({ rec }: { rec: Recommendation }) {
  const [open, setOpen] = useState(false);
  const optimal = rec.topSavingsUsd == null;
  const label = rec.project ?? NO_PROJECT_LABEL;

  return (
    <div className={`rounded-xl ring-1 ring-border/40 ${optimal ? "bg-muted/10" : "bg-card/40"}`}>
      <button
        type="button"
        onClick={optimal ? undefined : () => setOpen((o) => !o)}
        disabled={optimal}
        className={`flex w-full items-center gap-3 px-4 py-3 text-left ${
          optimal ? "cursor-default" : "cursor-pointer"
        }`}
      >
        {optimal ? (
          <span className="w-4 shrink-0" aria-hidden />
        ) : (
          <ChevronRightIcon
            className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
            aria-hidden
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`truncate ${rec.project ? "font-medium" : "italic text-muted-foreground"}`}>
              {label}
            </span>
            {rec.project == null ? (
              <Badge variant="outline" className="font-mono text-[9px] uppercase">
                no repo
              </Badge>
            ) : null}
          </div>
          <div className="truncate font-mono text-[11px] text-muted-foreground">
            {rec.currentModel} · {rec.currentProvider} · {usd(rec.currentSpendUsd)} this window
          </div>
        </div>
        <div className="shrink-0 text-right">
          {optimal ? (
            <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70">
              already cost-optimal
            </span>
          ) : (
            <>
              <div className="text-lg font-semibold tabular-nums text-emerald-500">
                save {usd(rec.topSavingsUsd!)}
              </div>
              <div className="text-[10px] tabular-nums text-muted-foreground">
                −{Math.round(rec.alternatives[0]?.savingsPct ?? 0)}% · best of {rec.alternatives.length}
              </div>
            </>
          )}
        </div>
      </button>

      {!optimal && open ? (
        <div className="border-t border-border/40 px-4 pb-2 pt-1">
          {rec.project == null ? (
            <p className="py-2 text-[11px] text-muted-foreground">
              Route this traffic through core-guardian to enable one-click switch.
            </p>
          ) : null}
          <ul className="divide-y divide-border/40">
            {rec.alternatives.map((alt) => (
              <AltRow key={`${alt.provider}:${alt.model}`} rec={rec} alt={alt} />
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

// --- The island -------------------------------------------------------------

export function AiRecommendationsView() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<ModelSavingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Request-id guard: a slower older fetch (rapid days-selector clicks) must not
  // overwrite a newer one's result.
  const reqId = useRef(0);
  const load = useCallback(async () => {
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    try {
      const r = await apiGet<ModelSavingsResponse>("/guardian/billing/ai-recommendations", { days });
      if (id === reqId.current) setData(r);
    } catch (err) {
      if (id !== reqId.current) return;
      setError(
        err instanceof ApiError && err.status === 401
          ? "Sign in to view recommendations."
          : err instanceof ApiError
            ? err.message
            : "Failed to load recommendations.",
      );
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  const actionable = data?.recommendations.filter((r) => r.topSavingsUsd != null) ?? [];
  const optimal = data?.recommendations.filter((r) => r.topSavingsUsd == null) ?? [];

  return (
    <section className="flex flex-col gap-8">
      {/* --- Header stat ----------------------------------------------------- */}
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-baseline gap-3">
            <span className="text-4xl font-semibold tabular-nums tracking-tight text-emerald-500">
              {usd(data?.totalPotentialSavingsUsd ?? 0)}
            </span>
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              potential savings · {days}d
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Switch a project off an expensive model onto a cheaper one that&apos;s at least as
            capable — Jules opens the PR, you merge.
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
      ) : loading && !data ? (
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[68px] w-full rounded-xl" />
          ))}
        </div>
      ) : !data || data.recommendations.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl bg-muted/20 px-4 py-14 text-center ring-1 ring-border/40">
          <SparklesIcon className="size-6 text-muted-foreground" aria-hidden />
          <p className="text-sm text-muted-foreground">
            No cheaper models found — you&apos;re optimal.
          </p>
        </div>
      ) : (
        <>
          {/* --- Actionable savings ------------------------------------------ */}
          {actionable.length ? (
            <section className="flex flex-col gap-3">
              {actionable.map((rec) => (
                <RecRow key={`${rec.project ?? "∅"}:${rec.currentModel}`} rec={rec} />
              ))}
            </section>
          ) : (
            <p className="rounded-lg bg-muted/20 px-4 py-3 text-sm text-muted-foreground ring-1 ring-border/40">
              Every model in use is already cost-optimal — nothing cheaper is at least as capable.
            </p>
          )}

          {/* --- Already-optimal (quiet) ------------------------------------- */}
          {optimal.length ? (
            <section className="flex flex-col gap-2">
              <h2 className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                Already cost-optimal · {optimal.length}
              </h2>
              {optimal.map((rec) => (
                <RecRow key={`${rec.project ?? "∅"}:${rec.currentModel}`} rec={rec} />
              ))}
            </section>
          ) : null}
        </>
      )}
    </section>
  );
}
