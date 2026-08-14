/**
 * @fileoverview InfraSpikeFlags — the DO-alarm-loop guard.
 *
 * The prior $600 bill was Durable Objects (an alarm loop), NOT AI. Owner expects
 * ~$0 non-AI infra spend, so ANY non-AI service over a low threshold is an
 * EMERGENCY and must be unmissable. Each breaching service renders as a LOUD red
 * flag naming the service, its month-to-date spend, and the remediation path
 * (investigate / archive / kill the cron). When nothing breaches, a single quiet
 * "non-AI infra clean" line — the calm state must not shout.
 *
 * Pure presentational: `<BudgetMeter>` owns the one budget-status fetch and hands
 * the `nonAiServices` array + threshold down, so the page makes a single request.
 *
 * Monolith: dark, `bg-destructive/15` + `ring-1 ring-destructive/50` for breaches
 * (never a 1px border).
 */

"use client";

import { AlertOctagonIcon, ShieldCheckIcon } from "lucide-react";

import { usd } from "@/lib/format";

export interface NonAiService {
  service: string;
  mtdUsd: number;
  overThreshold: boolean;
}

/**
 * Loud red flags for every non-AI service over the infra threshold; a quiet
 * one-liner when the surface is clean.
 */
export function InfraSpikeFlags({
  services,
  thresholdUsd,
}: {
  services: NonAiService[];
  thresholdUsd: number;
}) {
  const breaches = services.filter((s) => s.overThreshold);

  if (breaches.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-muted/20 px-3 py-2 text-xs text-muted-foreground ring-1 ring-border/40">
        <ShieldCheckIcon className="size-3.5 text-emerald-500" aria-hidden />
        Non-AI infra clean — every service under the {usd(thresholdUsd)} threshold.
      </div>
    );
  }

  return (
    <section role="alert" className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <AlertOctagonIcon className="size-5 shrink-0 text-destructive" aria-hidden />
        <h2 className="text-lg font-semibold tracking-tight text-destructive">
          {breaches.length} non-AI infra spike{breaches.length === 1 ? "" : "s"} — investigate now
        </h2>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {breaches.map((s) => (
          <div
            key={s.service}
            className="flex flex-col gap-1.5 rounded-xl bg-destructive/15 p-4 ring-1 ring-destructive/50"
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-mono text-sm font-semibold uppercase tracking-wide text-destructive">
                {s.service}
              </span>
              <span className="text-xl font-semibold tabular-nums text-destructive">
                {usd(s.mtdUsd)}
              </span>
            </div>
            <p className="text-sm text-destructive/90">
              this month — non-AI spend should be ~$0 (threshold {usd(thresholdUsd)}).
            </p>
            <p className="text-xs text-muted-foreground">
              Investigate / archive / kill the cron — this is the alarm-loop guard.
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
