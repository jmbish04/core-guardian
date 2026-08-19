/**
 * @fileoverview Pure story-math for the dashboard annotation layer (G7).
 *
 * Turns a finite value series into the handful of numbers the charts need to
 * *narrate* it rather than just plot it:
 *   - `baseline`     — the series mean, drawn as a muted ReferenceLine so every
 *                      point reads as above/below the norm;
 *   - `anomalyIndex` — the single outlier point (> mean + 2σ), marked with a
 *                      destructive ReferenceDot;
 *   - `paceFraction` — recent-tail mean vs the earlier remainder, the basis for
 *                      a one-line "pace up N%" takeaway caption.
 *
 * No DOM, no recharts, no clock. Every output is `Number.isFinite`-guarded and a
 * degenerate/empty series yields inert `null`s (never NaN), so a caption can
 * never render "NaN% above baseline" (G1). Self-checked at the bottom
 * (`npx tsx story.ts`).
 */

export interface SeriesStory {
  /** Series mean — the baseline ReferenceLine `y`. `null` when no finite data. */
  baseline: number | null;
  /** Index (into the input array) of the lone outlier point, else `null`. */
  anomalyIndex: number | null;
  /** (recent mean − earlier mean) / earlier mean; `null` when undefined. */
  paceFraction: number | null;
}

const finite = (xs: number[]): number[] => xs.filter((n) => Number.isFinite(n));
const mean = (xs: number[]): number => (xs.length ? xs.reduce((s, n) => s + n, 0) / xs.length : 0);

/**
 * Derive the story numbers for one ascending value series (oldest → newest).
 *
 * @param values  Raw values; non-finite entries are ignored for the stats but
 *                keep their positions so `anomalyIndex` maps back to the caller's
 *                chart data (pass the same array you plot).
 */
export function seriesStory(values: number[]): SeriesStory {
  const xs = finite(values);
  if (xs.length === 0) return { baseline: null, anomalyIndex: null, paceFraction: null };

  const baseline = mean(xs);

  // Anomaly: the max point, flagged only if it clears mean + 2σ. Needs ≥5 points
  // and real spread (σ > 0), else ordinary day-to-day jitter reads as an anomaly.
  let anomalyIndex: number | null = null;
  if (xs.length >= 5) {
    const std = Math.sqrt(mean(xs.map((n) => (n - baseline) ** 2)));
    if (std > 0) {
      let maxI = -1;
      for (let i = 0; i < values.length; i++) {
        if (!Number.isFinite(values[i])) continue;
        if (maxI < 0 || values[i] > values[maxI]) maxI = i;
      }
      if (maxI >= 0 && values[maxI] > baseline + 2 * std) anomalyIndex = maxI;
    }
  }

  // Pace: recent tail vs the earlier remainder. Needs ≥4 points to split.
  let paceFraction: number | null = null;
  if (xs.length >= 4) {
    const tail = Math.min(7, Math.floor(xs.length / 2));
    const recent = mean(xs.slice(-tail));
    const earlier = mean(xs.slice(0, xs.length - tail));
    if (Number.isFinite(earlier) && earlier !== 0) {
      const f = (recent - earlier) / earlier;
      if (Number.isFinite(f)) paceFraction = f;
    }
  }

  return { baseline, anomalyIndex, paceFraction };
}

// ---------------------------------------------------------------------------
// Self-check — `npx tsx story.ts`.
// ---------------------------------------------------------------------------
if (import.meta.main) {
  // Flat series: baseline = the value, no anomaly, zero pace.
  const flat = seriesStory([10, 10, 10, 10, 10, 10]);
  if (flat.baseline !== 10) throw new Error(`flat baseline ${flat.baseline}`);
  if (flat.anomalyIndex !== null) throw new Error(`flat anomaly ${flat.anomalyIndex}`);
  if (flat.paceFraction !== 0) throw new Error(`flat pace ${flat.paceFraction}`);

  // Lone spike well above mean+2σ → flagged at its index.
  const spike = seriesStory([10, 10, 10, 10, 60, 10, 10]);
  if (spike.anomalyIndex !== 4) throw new Error(`spike anomaly ${spike.anomalyIndex}`);

  // Climbing series → positive pace (recent tail 20 vs earlier 10 = +100%).
  const climbing = seriesStory([10, 10, 10, 20, 20, 20]);
  if (!climbing.paceFraction || Math.abs(climbing.paceFraction - 1) > 1e-9) {
    throw new Error(`climbing pace ${climbing.paceFraction}`);
  }

  // Empty / all-non-finite → inert nulls, never NaN.
  const empty = seriesStory([]);
  if (empty.baseline !== null || empty.anomalyIndex !== null || empty.paceFraction !== null) {
    throw new Error("empty series must be inert");
  }
  const nan = seriesStory([Number.NaN, Infinity]);
  if (nan.baseline !== null) throw new Error("non-finite series must be inert");

  // eslint-disable-next-line no-console
  console.log("story self-check ok");
}
