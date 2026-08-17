/**
 * @fileoverview SpendLanes — the three spend lanes, top of the cockpit.
 *
 * One cheap read of the cached `spend_rollup`. Keeps the three kinds of number
 * that must never be conflated visually separate:
 *   1. Billed     — the Cloudflare actual this cycle (ground truth, ties to the bill).
 *   2. Projected  — run-rate to cycle end (a forecast, not spend).
 *   3. Dispute    — billed vs our reconstructed estimate; a positive gap means the
 *                   bill exceeds what usage should cost → review on the Accountant.
 */

"use client";

import { Loader2Icon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { apiGet, apiSend } from "@/lib/api";
import { relativeTime, usd } from "@/lib/format";

import { InlineError } from "@/components/dashboard/shared";
import { useResource } from "@/components/projects/shared";

type Rollup = {
  totalActualUsd: number;
  totalProjectedUsd: number;
  estimateUsd: number;
  disputeUsd: number;
  reviewDelta?: { deltaUsd: number; sinceAt: number | null };
};

function Lane({
  label,
  value,
  tone,
  hint,
  footer,
}: {
  label: string;
  value: string;
  tone?: "default" | "muted" | "warn";
  hint: string;
  footer?: React.ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col gap-1.5 p-5">
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={`About ${label}`}
                className="inline-flex cursor-help items-center rounded-full text-muted-foreground/60 outline-none hover:text-foreground"
              >
                <span className="text-[11px]">ⓘ</span>
              </button>
            }
          />
          <TooltipContent className="max-w-xs">
            <p>{hint}</p>
          </TooltipContent>
        </Tooltip>
      </div>
      <div
        className={
          tone === "warn"
            ? "text-2xl font-bold tabular-nums text-amber-600 dark:text-amber-400"
            : tone === "muted"
              ? "text-2xl font-bold tabular-nums text-muted-foreground"
              : "text-2xl font-bold tabular-nums text-foreground"
        }
      >
        {value}
      </div>
      {footer && <div className="text-xs text-muted-foreground">{footer}</div>}
    </div>
  );
}

export function SpendLanes() {
  const { data, loading, error, reload, setData } = useResource<Rollup>(() =>
    apiGet<Rollup>("/guardian/spend-rollup"),
  );
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    try {
      // Use the POST response directly — re-GETting could read a stale KV-edge
      // baseline for up to ~60s and make the reset look like it didn't take.
      const fresh = await apiSend<Rollup>("POST", "guardian/spend-rollup/rebuild");
      setData(fresh);
    } catch {
      reload(); // surface the error through the normal resource path
    } finally {
      setRefreshing(false);
    }
  };

  if (loading) {
    return (
      <Card className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin" /> Loading spend…
      </Card>
    );
  }
  if (error) {
    return (
      <Card className="p-4">
        <InlineError message={error} onRetry={reload} />
      </Card>
    );
  }
  if (!data) return null;

  // Default the B3 fields — a rollup cached before this release lacks them until
  // the next cron rebuild; never render $NaN.
  const totalActualUsd = data.totalActualUsd ?? 0;
  const totalProjectedUsd = data.totalProjectedUsd ?? 0;
  // Positive dispute (billed above our estimate) is the only actionable direction.
  const gap = data.disputeUsd ?? 0;
  const overBilled = gap > 1;

  const rd = data.reviewDelta;
  const deltaUsd = rd?.deltaUsd ?? 0;
  // Only surface INCREASES since last review — the watchdog signal. A negative
  // delta is a billing correction or a new cycle (totalActual resets), not news.
  const showDelta = rd?.sinceAt != null && deltaUsd >= 0.01;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3 px-0.5">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Spend</span>
          {showDelta && rd?.sinceAt != null && (
            <span className="text-amber-600 dark:text-amber-400">
              ▲ +{usd(deltaUsd)} since you last reviewed ({relativeTime(rd.sinceAt)})
            </span>
          )}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void refresh()}
          disabled={refreshing}
        >
          <RefreshCwIcon className={refreshing ? "size-4 animate-spin" : "size-4"} />
          {refreshing ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      <Card className="grid grid-cols-1 gap-0 p-0 sm:grid-cols-3 sm:divide-x sm:divide-border/60">
      <Lane
        label="Billed this cycle"
        value={usd(totalActualUsd)}
        hint="Actual charges from Cloudflare's Billable Usage API — ties 1:1 to your Cloudflare bill."
        footer="Ground truth"
      />
      <Lane
        label="Projected"
        value={usd(totalProjectedUsd)}
        tone="muted"
        hint="Run-rate: this cycle's billed spend extrapolated to the cycle end. A forecast, not money spent."
        footer="At current run-rate"
      />
      <Lane
        label="Dispute"
        value={overBilled ? `+${usd(gap)}` : usd(Math.abs(gap))}
        tone={overBilled ? "warn" : "muted"}
        hint="Billed actual minus our reconstructed marginal-rate estimate. Positive = the bill exceeds what usage should cost — review the per-SKU discrepancies on the Accountant. Negative/zero = billed within estimate."
        footer={
          <a href="/dashboard/accountant" className="text-primary hover:underline">
            {overBilled ? "Review on Accountant →" : "Billed within estimate · Accountant →"}
          </a>
        }
      />
      </Card>
    </div>
  );
}
