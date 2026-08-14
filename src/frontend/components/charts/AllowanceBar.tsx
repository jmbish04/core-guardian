/**
 * @fileoverview AllowanceBar — horizontal bullet bar for one included allowance.
 *
 * Unlike a clamped 0–100 meter, this shows over-allowance honestly: the
 * allowance sits as a reference line at 100% of the track, current usage fills
 * up to it (green→amber→red), and any overage overflows PAST the line in red. A
 * ghost marker sits at the projected (run-rate) fraction so a projection is
 * never mistaken for current usage. The track auto-scales (see
 * {@link barGeometry}) so the line, overflow, and marker stay on-screen.
 *
 * Monolith theme: rounded-xl bg-card ring-1 ring-border/40, no 1px borders.
 */

import { formatUsage, usd } from "@/lib/format";
import { cn } from "@/lib/utils";

import { TONE_RING, TONE_TEXT, toneForFraction } from "./ProgressCircle";

const OVER_COLOR = TONE_RING.rose;

export type BarGeometry = {
  /** usedSoFar / included (1 when there is no free tier but usage exists). */
  currentFraction: number;
  /** projected / included. */
  projectedFraction: number;
  /** Track scale — the fraction that maps to the right edge (100% width). */
  scaleMax: number;
  /** Allowance reference line, as % of track width. */
  linePct: number;
  /** Current-usage fill up to the line, as % of track width. */
  underPct: number;
  /** Over-allowance overflow beyond the line, as % of track width. */
  overPct: number;
  /** Projected ghost marker position, as % of track width. */
  ghostPct: number;
  /** Currently over the allowance. */
  over: boolean;
  /** included <= 0 while usedSoFar > 0 — every unit is billable, no free tier. */
  noFreeTier: boolean;
};

/**
 * Pure geometry for the bullet bar. All positions are percentages of the track
 * width. The track always keeps ~15% headroom past the largest of {current,
 * projected, the 100% line} so nothing renders flush against the right edge.
 */
export function barGeometry(included: number, usedSoFar: number, projected: number): BarGeometry {
  const noFreeTier = included <= 0 && usedSoFar > 0;
  const currentFraction = noFreeTier ? 1 : included > 0 ? usedSoFar / included : 0;
  const projectedFraction = noFreeTier ? 1 : included > 0 ? projected / included : 0;

  const maxFrac = Math.max(currentFraction, projectedFraction, 1);
  const scaleMax = Math.max(1.15, maxFrac * 1.15);
  const toPct = (f: number) => (f / scaleMax) * 100;

  const linePct = toPct(1);
  const fillPct = toPct(currentFraction);
  return {
    currentFraction,
    projectedFraction,
    scaleMax,
    linePct,
    underPct: Math.min(fillPct, linePct),
    overPct: Math.max(0, fillPct - linePct),
    ghostPct: toPct(projectedFraction),
    over: currentFraction > 1,
    noFreeTier,
  };
}

export type AllowanceBarProps = {
  label: string;
  binding?: string;
  unit: string;
  included: number;
  usedSoFar: number;
  projected: number;
  overageCostUsd: number | null;
  remaining: number | null;
  plan: "free" | "paid";
  className?: string;
};

export function AllowanceBar({
  label,
  binding,
  unit,
  included,
  usedSoFar,
  projected,
  overageCostUsd,
  remaining,
  plan,
  className,
}: AllowanceBarProps) {
  const g = barGeometry(included, usedSoFar, projected);
  const tone = g.noFreeTier || g.over ? "rose" : toneForFraction(g.currentFraction);
  const underColor = TONE_RING[tone];
  const currentPct = Math.round(g.currentFraction * 100);
  const projectedPct = Math.round(g.projectedFraction * 100);

  const overage = overageCostUsd !== null && overageCostUsd > 0;

  return (
    <div className={cn("rounded-xl bg-card p-5 ring-1 ring-border/40", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-base font-semibold tracking-tight">{label}</div>
          <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            {binding ?? unit}
          </div>
        </div>
        <div className="shrink-0 text-right font-mono text-xs tabular-nums">
          <span className={cn("font-semibold", TONE_TEXT[tone])}>{currentPct}% used</span>
          <span className="mx-1 text-muted-foreground">·</span>
          <span className="text-muted-foreground">{projectedPct}% projected</span>
        </div>
      </div>

      <div className="mt-3 flex items-baseline gap-2 font-mono tabular-nums">
        <span className="text-2xl font-semibold tracking-tight">{formatUsage(unit, usedSoFar)}</span>
        <span className="text-sm text-muted-foreground">
          / {g.noFreeTier ? "no free tier" : `${formatUsage(unit, included)} ${unit}`}
        </span>
      </div>

      {/* Bullet bar: track · fill · overflow · allowance line · projected ghost. */}
      <div className="relative mt-4 h-3">
        <div className="absolute inset-0 rounded-full bg-muted" />
        {g.underPct > 0 && (
          <div
            className="absolute inset-y-0 left-0 rounded-full"
            style={{ width: `${g.underPct}%`, background: underColor }}
          />
        )}
        {g.overPct > 0 && (
          <div
            className="absolute inset-y-0 rounded-r-full"
            style={{ left: `${g.linePct}%`, width: `${g.overPct}%`, background: OVER_COLOR }}
          />
        )}
        {/* Allowance reference line at 100%. */}
        <div
          className="absolute -inset-y-1 w-px bg-foreground/70"
          style={{ left: `${g.linePct}%` }}
          aria-hidden
        />
        {/* Projected (run-rate) ghost marker. */}
        <div
          className="absolute -inset-y-1 w-1.5 -translate-x-1/2 rounded-full ring-2 ring-card"
          style={{ left: `${g.ghostPct}%`, background: g.projectedFraction >= 1 ? OVER_COLOR : "var(--muted-foreground)" }}
          title={`Projected ${projectedPct}% of allowance`}
          aria-hidden
        />
      </div>
      <div className="mt-2 font-mono text-[10px] text-muted-foreground">
        line = 100% allowance · ◆ projected to {plan === "paid" ? "month-end" : "period-end"}
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-4 border-t border-border/40 pt-4">
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-muted-foreground">Projected</dt>
          <dd className="font-mono text-base font-semibold tabular-nums">
            {formatUsage(unit, projected)}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-muted-foreground">
            {overage ? (plan === "paid" ? "Est. overage" : "Over cap by") : "Remaining"}
          </dt>
          <dd
            className={cn(
              "font-mono text-base font-semibold tabular-nums",
              overage && TONE_TEXT.rose,
            )}
          >
            {overage
              ? usd(overageCostUsd as number)
              : remaining !== null
                ? formatUsage(unit, remaining)
                : "—"}
          </dd>
        </div>
      </dl>
    </div>
  );
}
