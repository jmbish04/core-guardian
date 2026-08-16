/**
 * @fileoverview Cursor Teams **daily usage** client.
 *
 * `POST /teams/daily-usage-data` returns per-day team metrics. Auth is the team
 * admin API key via HTTP Basic (`key` as username, empty password). Cursor's
 * dollar fields have varied by plan/version, so we scan each day record for a
 * cents/USD spend field and, when none is present, record the day with
 * `costUsd: null` rather than inventing a figure.
 *
 * @see https://docs.cursor.com/account/teams/admin-api
 */

import { getCursorApiKey } from "@/backend/utils/secrets";

import { dayStartMs, num, ProviderBillingError, ymd, type ProviderDailyCost } from "./types";

const BASE = "https://api.cursor.com/teams/daily-usage-data";

/** Cents fields Cursor has used for daily spend, in preference order. */
const CENTS_FIELDS = ["spendCents", "totalCents", "costCents", "usageCostCents"] as const;
/** Dollar fields, fallback. */
const USD_FIELDS = ["spendDollars", "totalDollars", "costUsd"] as const;

/** Pull a day's USD spend from an untyped record, or null if no field matches. */
function extractCostUsd(rec: Record<string, unknown>): number | null {
  for (const f of CENTS_FIELDS) {
    if (rec[f] != null) return num(rec[f]) / 100;
  }
  for (const f of USD_FIELDS) {
    if (rec[f] != null) return num(rec[f]);
  }
  return null;
}

/**
 * Fetch daily team spend for `[from, to)` (YYYY-MM-DD, UTC). Returns [] when no
 * key is configured. Throws on API error.
 */
export async function fetchCursorCost(env: Env, from: string, to: string): Promise<ProviderDailyCost[]> {
  const key = await getCursorApiKey(env);
  if (!key) return [];

  const res = await fetch(BASE, {
    method: "POST",
    headers: {
      // Basic auth: API key as username, empty password.
      Authorization: `Basic ${btoa(`${key}:`)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ startDate: dayStartMs(from), endDate: dayStartMs(to) }),
  });
  const body = (await res.json().catch(() => null)) as {
    data?: Record<string, unknown>[];
    error?: string;
    message?: string;
  } | null;
  if (!res.ok) {
    throw new ProviderBillingError("cursor", body?.error ?? body?.message ?? `HTTP ${res.status}`);
  }

  const out: ProviderDailyCost[] = [];
  for (const rec of body?.data ?? []) {
    const rawDate = rec.date ?? rec.day;
    if (rawDate == null) continue;
    // `date` is epoch ms (number) or a YYYY-MM-DD string.
    const day = typeof rawDate === "number" ? ymd(rawDate) : String(rawDate).slice(0, 10);
    out.push({
      day,
      dimension: "",
      metric: "spent",
      costUsd: extractCostUsd(rec),
      currency: "USD",
      source: "cursor-daily-usage",
    });
  }
  return out;
}
