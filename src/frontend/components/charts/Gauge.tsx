/**
 * @fileoverview Gauge — a 180° semicircle score gauge.
 *
 * Global, reusable for health scores and "has a limit been reached" signals
 * (free-tier / usage-cap / system-limit). Adapted from the beste.co "dashboard14"
 * piece to this stack: pure SVG (no lib), theme-aware track via `--muted`,
 * tone-driven arc. Score is 0–100.
 *
 * @example
 * <Gauge label="System health" score={82} status="Healthy" tone="emerald" />
 */

import { cn } from "@/lib/utils";

import { TONE_RING, TONE_TEXT, type Tone } from "./ProgressCircle";

export type GaugeProps = {
  label?: string;
  /** 0–100 (clamped). */
  score: number;
  /** Short status word under the score (e.g. "Healthy", "At limit"). */
  status?: string;
  tone?: Tone;
  /** Gauge width in px (height is ~60% of this). Default 180. */
  size?: number;
  className?: string;
};

export function Gauge({ label, score, status, tone = "primary", size = 180, className }: GaugeProps) {
  const pct = Math.min(Math.max(score, 0), 100);
  const arc = TONE_RING[tone];

  // Semicircle geometry: a stroked arc from 180° → 0°, filled to `pct`.
  const stroke = size * 0.11;
  const r = (size - stroke) / 2;
  const cx = size / 2;
  const cy = size / 2;
  // Half-circumference is the full sweep; dashoffset reveals `pct` of it.
  const semi = Math.PI * r;
  const dash = `${(pct / 100) * semi} ${semi}`;

  return (
    <div className={cn("flex flex-col items-center", className)}>
      <svg width={size} height={size * 0.62} viewBox={`0 0 ${size} ${size * 0.62}`} role="img" aria-label={`${label ?? "Score"}: ${Math.round(pct)} of 100`}>
        {/* Track */}
        <path
          d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
          fill="none"
          stroke="var(--muted)"
          strokeWidth={stroke}
          strokeLinecap="round"
        />
        {/* Value arc */}
        <path
          d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
          fill="none"
          stroke={arc}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={dash}
        />
      </svg>
      <div className="-mt-6 flex flex-col items-center">
        <span className={cn("font-mono text-3xl font-semibold tabular-nums", TONE_TEXT[tone])}>
          {Math.round(pct)}
        </span>
        {status && <span className={cn("text-sm font-medium", TONE_TEXT[tone])}>{status}</span>}
        {label && <span className="mt-0.5 text-xs text-muted-foreground">{label}</span>}
      </div>
    </div>
  );
}
