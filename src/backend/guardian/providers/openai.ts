/**
 * @fileoverview OpenAI org **costs** client.
 *
 * `GET /v1/organization/costs` returns charged amounts bucketed per day. Auth is
 * an org **Admin** key (`sk-admin-…`, Bearer) — NOT the inference key. Defensive
 * parse, paginates `next_page`, never fabricates.
 *
 * @see https://platform.openai.com/docs/api-reference/usage/costs
 */

import { getOpenAiAdminKey } from "@/backend/utils/secrets";

import { num, ProviderBillingError, ymd, type ProviderDailyCost } from "./types";

const BASE = "https://api.openai.com/v1/organization/costs";

type Bucket = {
  start_time?: number;
  results?: { amount?: { value?: number; currency?: string } }[];
};

/**
 * Fetch daily charged cost for `[from, to)` (YYYY-MM-DD, UTC). Returns [] when
 * no admin key is configured. Throws on API error.
 */
export async function fetchOpenAiCost(env: Env, from: string, to: string): Promise<ProviderDailyCost[]> {
  const key = await getOpenAiAdminKey(env);
  if (!key) return [];

  const startSec = Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000);
  const endSec = Math.floor(Date.parse(`${to}T00:00:00Z`) / 1000);

  const out: ProviderDailyCost[] = [];
  let page: string | undefined;
  for (let i = 0; i < 24; i++) {
    const url = new URL(BASE);
    url.searchParams.set("start_time", String(startSec));
    url.searchParams.set("end_time", String(endSec));
    url.searchParams.set("bucket_width", "1d");
    url.searchParams.set("limit", "180");
    if (page) url.searchParams.set("page", page);

    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    const body = (await res.json().catch(() => null)) as {
      data?: Bucket[];
      has_more?: boolean;
      next_page?: string | null;
      error?: { message?: string };
    } | null;
    if (!res.ok) {
      throw new ProviderBillingError("openai", body?.error?.message ?? `HTTP ${res.status}`);
    }

    for (const bucket of body?.data ?? []) {
      if (typeof bucket.start_time !== "number") continue;
      const results = bucket.results ?? [];
      if (results.length === 0) continue;
      const costUsd = results.reduce((s, r) => s + num(r.amount?.value), 0);
      out.push({
        day: ymd(bucket.start_time * 1000),
        dimension: "",
        metric: "spent",
        costUsd,
        currency: (results[0]?.amount?.currency ?? "usd").toUpperCase(),
        source: "openai-costs",
      });
    }

    if (!body?.has_more || !body?.next_page) break;
    page = body.next_page;
  }
  return out;
}
