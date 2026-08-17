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

import { Loader2Icon } from "lucide-react";

import { Card } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { apiGet } from "@/lib/api";
import { usd } from "@/lib/format";

import { InlineError } from "@/components/dashboard/shared";
import { useResource } from "@/components/projects/shared";

type Rollup = {
  totalActualUsd: number;
  totalProjectedUsd: number;
  estimateUsd: number;
  disputeUsd: number;
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
  const { data, loading, error, reload } = useResource<Rollup>(() =>
    apiGet<Rollup>("/guardian/spend-rollup"),
  );

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

  return (
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
  );
}
