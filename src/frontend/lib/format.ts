/**
 * @fileoverview Small date/number formatting helpers shared across feature
 * pages. Timestamps from the API are epoch milliseconds (or ISO strings).
 */

/** Coerce a Date | number | string into epoch ms (or null). */
function toMs(value: Date | number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

/** Human relative time, e.g. "just now", "5m ago", "3d ago", "in 2h". */
export function relativeTime(value: Date | number | string | null | undefined): string {
  const ms = toMs(value);
  if (ms === null) return "";
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31536000000],
    ["month", 2592000000],
    ["week", 604800000],
    ["day", 86400000],
    ["hour", 3600000],
    ["minute", 60000],
    ["second", 1000],
  ];
  if (abs < 45000) return "just now";
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, unitMs] of units) {
    if (abs >= unitMs || unit === "second") {
      return rtf.format(Math.round(diff / unitMs), unit);
    }
  }
  return "just now";
}

/** Short absolute date, e.g. "Nov 28" or "Nov 28, 2026" if a different year. */
export function shortDate(value: Date | number | string | null | undefined): string {
  const ms = toMs(value);
  if (ms === null) return "";
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** Compact number, e.g. 1.2k, 3.4M. */
export function compactNumber(n: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

/**
 * Density count — the default for any metered quantity in a table cell, meter,
 * or chart axis where space is tight. `45,523,699` → `45.5M`. Optional unit is
 * appended with a thin space: `formatCount(45.5e6, "rows")` → `45.5M rows`.
 *
 * Use this, not bare `compactNumber`, at call sites so intent is legible.
 */
export function formatCount(n: number, unit?: string): string {
  const s = compactNumber(n);
  return unit ? `${s} ${unit}` : s;
}

/**
 * Exact figure with grouping separators — for a standout number the reader is
 * meant to dwell on (a headline total, an audit-log value). `1248879489` →
 * `1,248,879,489`; with a unit, `1,248,879,489 rows`. Reserve for emphasis;
 * everywhere else prefer {@link formatCount}.
 */
export function formatExact(n: number, unit?: string): string {
  const s = new Intl.NumberFormat("en").format(Math.round(n));
  return unit ? `${s} ${unit}` : s;
}

/**
 * A usage-vs-limit ratio as a legible token. Below 10× it reads as a percent
 * (`72%`); at or above 10× it flips to a multiplier (`258×`) because
 * `25768%` is unreadable. Returns `null` when there is no positive limit to
 * measure against, so callers render a dash rather than `Infinity%`.
 *
 * The helper returns only the magnitude token; the caller supplies wording
 * such as "of limit" / "over limit".
 */
export function formatRatio(value: number, limit: number): string | null {
  if (!Number.isFinite(limit) || limit <= 0) return null;
  const ratio = value / limit;
  if (ratio >= 10) return `${new Intl.NumberFormat("en").format(Math.round(ratio))}×`;
  return `${Math.round(ratio * 100)}%`;
}

/** Human-readable byte size, e.g. "0 B", "1.4 KB", "3.2 MB". */
export function humanSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 || value % 1 === 0 ? 0 : 1)} ${units[unitIndex]}`;
}
