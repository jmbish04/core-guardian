/**
 * @fileoverview ProgressCircle — a conic-gradient ring showing one percentage.
 *
 * Global, reusable across dashboards (storage used, quota consumed, allowance
 * projected). Adapted from the beste.co "dashboard21" piece to this stack:
 * base-ui + Astro islands, theme-aware CSS-var track, tone-driven ring color, no
 * Next.js. The ring track uses `--muted` so it reads in both light and dark.
 *
 * @example
 * <ProgressCircle label="Storage used" value={68} caption="34 GB of 50 GB" tone="rose" />
 */

import { cn } from "@/lib/utils";

export type Tone = "emerald" | "amber" | "rose" | "sky" | "violet" | "primary";

/** Ring color per tone (bare color for the conic-gradient sweep). */
export const TONE_RING: Record<Tone, string> = {
  emerald: "#10b981",
  amber: "#f59e0b",
  rose: "#f43f5e",
  sky: "#0ea5e9",
  violet: "#8b5cf6",
  primary: "var(--primary)",
};

/** Text color per tone (for the headline number). */
export const TONE_TEXT: Record<Tone, string> = {
  emerald: "text-emerald-600 dark:text-emerald-400",
  amber: "text-amber-600 dark:text-amber-400",
  rose: "text-rose-600 dark:text-rose-400",
  sky: "text-sky-600 dark:text-sky-400",
  violet: "text-violet-600 dark:text-violet-400",
  primary: "text-foreground",
};

/** Pick a tone from a fraction: <0.6 emerald, <0.85 amber, else rose. */
export function toneForFraction(fraction: number): Tone {
  if (fraction >= 1) return "rose";
  if (fraction >= 0.85) return "rose";
  if (fraction >= 0.6) return "amber";
  return "emerald";
}

export type ProgressCircleProps = {
  /** Small label above/beside the ring. */
  label?: string;
  /** 0–100 (clamped). Values are shown as a rounded integer percent. */
  value: number;
  /** Sub-line under the value (e.g. "34 GB of 50 GB"). */
  caption?: string;
  tone?: Tone;
  /** Ring diameter in px. Default 144. */
  size?: number;
  /** Render just the ring (no label/caption column) — for tight grids. */
  compact?: boolean;
  /**
   * Override the centered text. The ring still fills to (clamped) `value`, so
   * this is how an over-100% figure shows its true number ("399%", "3.9×") over
   * a maxed-out ring.
   */
  centerLabel?: string;
  className?: string;
};

export function ProgressCircle({
  label,
  value,
  caption,
  tone = "primary",
  size = 144,
  compact = false,
  centerLabel,
  className,
}: ProgressCircleProps) {
  const pct = Math.min(Math.max(Math.round(value), 0), 100);
  const ring = TONE_RING[tone];

  const ringEl = (
    <div
      className="relative flex shrink-0 items-center justify-center rounded-full"
      style={{
        width: size,
        height: size,
        background: `conic-gradient(${ring} ${pct * 3.6}deg, var(--muted) 0deg)`,
      }}
      role="img"
      aria-label={`${pct}%${label ? ` ${label}` : ""}`}
    >
      <div
        className="absolute flex flex-col items-center justify-center rounded-full bg-card"
        style={{ inset: Math.max(8, size * 0.09) }}
      >
        <span
          className={cn("font-mono font-semibold tabular-nums", TONE_TEXT[tone])}
          style={{ fontSize: (centerLabel ?? `${pct}%`).length > 4 ? size * 0.16 : size * 0.22 }}
        >
          {centerLabel ?? `${pct}%`}
        </span>
      </div>
    </div>
  );

  if (compact) return <div className={className}>{ringEl}</div>;

  return (
    <div className={cn("flex items-center gap-5", className)}>
      {ringEl}
      <div className="flex min-w-0 flex-col gap-1">
        {label && <span className="text-sm font-medium tracking-tight">{label}</span>}
        {caption && <span className="text-sm text-muted-foreground">{caption}</span>}
      </div>
    </div>
  );
}
