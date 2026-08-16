/**
 * @fileoverview Shared shapes + helpers for the external-provider billing pull.
 *
 * Each provider client normalizes its own billing API into {@link ProviderDailyCost}
 * rows; {@link file://src/backend/guardian/providers/sync.ts} upserts them into
 * `provider_cost`. Clients NEVER fabricate a dollar figure — a day the provider
 * reports usage for but no cost lands with `costUsd: null`.
 */

/** One normalized provider billing row before it becomes a `provider_cost` row. */
export type ProviderDailyCost = {
  /** UTC date bucket, YYYY-MM-DD. */
  day: string;
  /** Per-model / per-budget sub-line, or "" for the daily headline. */
  dimension: string;
  /** "spent" = real charged USD; "budget" = configured ceiling (Gemini). */
  metric: "spent" | "budget";
  /** Dollars charged (spent) or budget ceiling (budget); null when unknown. */
  costUsd: number | null;
  currency: string;
  /** Which API produced the row (audit/debug). */
  source: string;
};

/** Thrown when a provider billing endpoint rejects the request. */
export class ProviderBillingError extends Error {
  constructor(
    public provider: string,
    message: string,
  ) {
    super(`${provider} billing API failed: ${message}`);
    this.name = "ProviderBillingError";
  }
}

/** `YYYY-MM-DD` in UTC for a Date/ms. */
export function ymd(at: number | Date): string {
  const d = typeof at === "number" ? new Date(at) : at;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** Unix ms at UTC-midnight of a YYYY-MM-DD (or the day containing a ms). */
export function dayStartMs(at: number | string): number {
  if (typeof at === "string") {
    const [y, m, d] = at.split("-").map(Number);
    return Date.UTC(y, (m ?? 1) - 1, d ?? 1);
  }
  const d = new Date(at);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Coerce anything numeric-ish to a finite number, else 0. */
export function num(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : 0;
  return Number.isFinite(n) ? n : 0;
}
