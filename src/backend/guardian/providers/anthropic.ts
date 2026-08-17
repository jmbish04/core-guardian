/**
 * @fileoverview Anthropic org **cost report** client.
 *
 * `GET /v1/organizations/cost_report` returns real charged USD per UTC day.
 * Auth is the org **Admin** key (`sk-ant-admin…`, header `x-api-key`) — NOT the
 * inference `ANTHROPIC_API_KEY`. Defensive parse (fields treated as optional),
 * paginates `next_page`, and never invents a number.
 *
 * @see https://docs.anthropic.com/en/api/administration-api
 */

import { getAnthropicAdminKey } from "@/backend/utils/secrets";

import { num, ProviderBillingError, ymd, type ProviderDailyCost } from "./types";

const BASE = "https://api.anthropic.com/v1/organizations/cost_report";
const VERSION = "2023-06-01";

type Bucket = {
  starting_at?: string;
  ending_at?: string;
  results?: { amount?: number | string; currency?: string }[];
};

/**
 * Fetch daily charged cost for `[from, to)` (YYYY-MM-DD, UTC). Returns [] when
 * no admin key is configured (the sync skips Anthropic). Throws on API error.
 */
export async function fetchAnthropicCost(env: Env, from: string, to: string): Promise<ProviderDailyCost[]> {
  const key = await getAnthropicAdminKey(env);
  if (!key) return [];

  const out: ProviderDailyCost[] = [];
  let page: string | undefined;
  // Cap page walks so a misbehaving cursor can't loop forever.
  for (let i = 0; i < 24; i++) {
    const url = new URL(BASE);
    url.searchParams.set("starting_at", `${from}T00:00:00Z`);
    url.searchParams.set("ending_at", `${to}T00:00:00Z`);
    url.searchParams.set("bucket_width", "1d");
    if (page) url.searchParams.set("page", page);

    const res = await fetch(url, {
      headers: { "x-api-key": key, "anthropic-version": VERSION },
    });
    const body = (await res.json().catch(() => null)) as {
      data?: Bucket[];
      has_more?: boolean;
      next_page?: string | null;
      error?: { message?: string };
    } | null;
    if (!res.ok) {
      throw new ProviderBillingError("anthropic", body?.error?.message ?? `HTTP ${res.status}`);
    }

    for (const bucket of body?.data ?? []) {
      const start = bucket.starting_at;
      if (!start) continue;
      const startMs = Date.parse(start);
      if (Number.isNaN(startMs)) continue;
      const results = bucket.results ?? [];
      if (results.length === 0) continue;
      const costUsd = results.reduce((s, r) => s + num(r.amount), 0);
      out.push({
        day: ymd(startMs),
        dimension: "",
        metric: "spent",
        costUsd,
        currency: results[0]?.currency ?? "USD",
        source: "anthropic-cost-report",
      });
    }

    if (!body?.has_more || !body?.next_page) break;
    page = body.next_page;
  }
  return out;
}
