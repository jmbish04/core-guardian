/**
 * @fileoverview UsageQuotaMeter — conic ring + used/limit + facts (+ optional CTA).
 *
 * Global, reusable for any metered quota (monthly allowance used, AI budget
 * spent, plan runs). Adapted from the beste.co "workflow23" piece to this stack:
 * base-ui Button, theme-aware ring, tone-driven color, `<a>` instead of
 * next/link. Renders as a self-contained card (no outer <section> wrapper) so it
 * drops into any dashboard grid.
 *
 * @example
 * <UsageQuotaMeter meterLabel="Monthly runs" percent={84} used="84,231" limit="100,000"
 *   unitLabel="runs" facts={[{label:"Resets in", value:"12d 4h"}]} />
 */

import { ArrowUpRight } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { TONE_RING, TONE_TEXT, type Tone } from "./ProgressCircle";

export type MeterFact = { label: string; value: string };

export type UsageQuotaMeterProps = {
  meterLabel?: string;
  meterCaption?: string;
  /** 0–100 (clamped). */
  percent?: number;
  used?: string;
  limit?: string;
  unitLabel?: string;
  facts?: MeterFact[];
  tone?: Tone;
  /** Optional call-to-action link (e.g. "Upgrade plan"). */
  cta?: { label: string; href: string; external?: boolean };
  className?: string;
};

export function UsageQuotaMeter({
  meterLabel = "Usage",
  meterCaption,
  percent = 0,
  used,
  limit,
  unitLabel,
  facts = [],
  tone = "primary",
  cta,
  className,
}: UsageQuotaMeterProps) {
  const pct = Math.min(Math.max(Math.round(percent), 0), 100);
  const ring = TONE_RING[tone];

  return (
    <div className={cn("rounded-xl border border-border/60 bg-card p-6", className)}>
      <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-center sm:gap-8">
        <div
          className="relative flex size-32 shrink-0 items-center justify-center rounded-full"
          style={{ background: `conic-gradient(${ring} ${pct * 3.6}deg, var(--muted) 0deg)` }}
          role="img"
          aria-label={`${pct}% of ${meterLabel} used`}
        >
          <div className="absolute inset-3 flex flex-col items-center justify-center rounded-full bg-card">
            <span className={cn("font-mono text-3xl font-semibold tabular-nums", TONE_TEXT[tone])}>{pct}%</span>
            {unitLabel && <span className="text-xs text-muted-foreground">{unitLabel}</span>}
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-2 text-center sm:text-left">
          <span className="text-base font-semibold tracking-tight">{meterLabel}</span>
          {(used || limit) && (
            <div className="flex items-baseline justify-center gap-2 font-mono tabular-nums sm:justify-start">
              <span className="text-3xl font-semibold tracking-tight">{used}</span>
              {limit && <span className="text-base text-muted-foreground">/ {limit}</span>}
            </div>
          )}
          {meterCaption && <span className="text-sm text-muted-foreground">{meterCaption}</span>}
        </div>
      </div>

      {facts.length > 0 && (
        <dl className="mt-6 grid grid-cols-1 gap-4 border-t border-border/60 pt-6 sm:grid-cols-3">
          {facts.map((fact) => (
            <div key={fact.label} className="flex flex-col gap-0.5">
              <dt className="text-xs text-muted-foreground">{fact.label}</dt>
              <dd className="font-mono text-base font-semibold tabular-nums">{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {cta && (
        <div className="mt-6 flex justify-end border-t border-border/60 pt-5">
          <a
            href={cta.href}
            {...(cta.external ? { target: "_blank", rel: "noreferrer noopener" } : {})}
            className={cn(buttonVariants({ size: "sm" }), "gap-1.5")}
          >
            {cta.label}
            <ArrowUpRight className="size-4" />
          </a>
        </div>
      )}
    </div>
  );
}
