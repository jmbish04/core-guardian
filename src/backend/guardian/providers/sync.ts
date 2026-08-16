/**
 * @fileoverview External-provider billing: sync + report + threshold alerts.
 *
 *  1. `syncProviderCosts` — pull each provider's billing API (per-provider
 *     try/catch so one bad key never sinks the run) and idempotently upsert into
 *     `provider_cost`. A provider with no key/config is silently skipped.
 *  2. `getProviderCostReport` — read it back as per-provider daily series + MTD.
 *  3. `checkProviderSpendAlerts` — for each provider with a configured budget
 *     (`provider_budget_<provider>_usd` in `global_config`), fire ONE frontend
 *     notification per month when month-to-date spend crosses it. No breaker —
 *     we can't throttle an external provider, only warn.
 *
 * Zero AI. All arithmetic + queries.
 */

import { getAgentByName } from "agents";
import { gte } from "drizzle-orm";

import { NotificationsAgent } from "@/backend/ai/agents/NotificationsAgent";
import { getDb } from "@/backend/db";
import { providerCost, PROVIDERS, type NewProviderCostRow, type Provider } from "@/backend/db/schema";
import { monthPrefix, readConfigNumber, sumMonth } from "@/backend/guardian/offense/nuclear";

import { fetchAnthropicCost } from "./anthropic";
import { fetchCursorCost } from "./cursor";
import { fetchGeminiBudgets } from "./gemini";
import { fetchOpenAiCost } from "./openai";
import { dayStartMs, type ProviderDailyCost } from "./types";

const DAY_MS = 86_400_000;

/** Dispatch table: provider → its client for a [from,to) window. */
const CLIENTS: Record<Provider, (env: Env, from: string, to: string) => Promise<ProviderDailyCost[]>> = {
  anthropic: fetchAnthropicCost,
  openai: fetchOpenAiCost,
  cursor: fetchCursorCost,
  // Gemini ignores the window (budgets are point-in-time config).
  gemini: (env) => fetchGeminiBudgets(env),
};

/** `YYYY-MM-DD` in UTC for a ms instant. */
function ymd(at: number): string {
  const d = new Date(at);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** Per-provider outcome of a sync run. */
export type ProviderSyncSummary = Record<Provider, { rows: number; error?: string }>;

/**
 * Pull the trailing `days` of billing from every configured provider and upsert
 * into `provider_cost`. Idempotent (deterministic PK), safe to run daily.
 */
export async function syncProviderCosts(env: Env, days = 35): Promise<ProviderSyncSummary> {
  // `to` is tomorrow (UTC) so the exclusive `ending_at` window bounds the END of
  // today — otherwise the current day's spend is dropped and MTD lags 24h.
  const to = ymd(Date.now() + DAY_MS);
  const from = ymd(Date.now() - days * DAY_MS);
  const now = Date.now();
  const db = getDb(env);

  const summary = {} as ProviderSyncSummary;

  for (const provider of PROVIDERS) {
    try {
      const normalized = await CLIENTS[provider](env, from, to);
      const rows: NewProviderCostRow[] = normalized.map((r) => ({
        id: `${r.day}:${provider}:${r.dimension}`,
        day: r.day,
        dayStart: dayStartMs(r.day),
        provider,
        dimension: r.dimension,
        metric: r.metric,
        costUsd: r.costUsd,
        currency: r.currency,
        source: r.source,
        capturedAt: now,
      }));
      for (const row of rows) {
        await db
          .insert(providerCost)
          .values(row)
          .onConflictDoUpdate({
            target: providerCost.id,
            set: {
              metric: row.metric,
              costUsd: row.costUsd,
              currency: row.currency,
              source: row.source,
              capturedAt: now,
            },
          });
      }
      summary[provider] = { rows: rows.length };
    } catch (err) {
      summary[provider] = { rows: 0, error: String(err) };
      console.error(
        JSON.stringify({ level: "ERROR", source: "guardian.providers.sync", provider, error: String(err) }),
      );
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export type ProviderSeries = {
  provider: Provider;
  metric: "spent" | "budget";
  currency: string;
  points: { day: string; costUsd: number | null }[];
  mtdUsd: number;
  /** Latest-day − prior-day cost (spent providers only), else null. */
  deltaUsd: number | null;
};

export type ProviderCostReport = {
  month: string;
  totalSpentMtdUsd: number;
  providers: ProviderSeries[];
};

/**
 * Read `provider_cost` back as one series per (provider, metric) over the
 * trailing `days`, with month-to-date totals. "budget" series (Gemini) are the
 * ceiling, kept out of `totalSpentMtdUsd`.
 */
export async function getProviderCostReport(env: Env, days = 35): Promise<ProviderCostReport> {
  const cutoff = dayStartMs(Date.now() - (days - 1) * DAY_MS);
  const rows = await getDb(env)
    .select()
    .from(providerCost)
    .where(gte(providerCost.dayStart, cutoff))
    .orderBy(providerCost.dayStart);

  const month = monthPrefix();
  // Group by provider+metric, summing dimensions into a daily headline.
  const byKey = new Map<string, ProviderSeries>();
  const perDay = new Map<string, Map<string, number | null>>();
  for (const r of rows) {
    const key = `${r.provider}:${r.metric}`;
    let s = byKey.get(key);
    if (!s) {
      s = {
        provider: r.provider as Provider,
        metric: r.metric,
        currency: r.currency,
        points: [],
        mtdUsd: 0,
        deltaUsd: null,
      };
      byKey.set(key, s);
      perDay.set(key, new Map());
    }
    const dayMap = perDay.get(key)!;
    const prev = dayMap.get(r.day);
    // null + number → number; null stays null only if every row for the day is null.
    const add = r.costUsd;
    if (add == null) {
      if (!dayMap.has(r.day)) dayMap.set(r.day, null);
    } else {
      dayMap.set(r.day, (prev ?? 0) + add);
    }
  }

  const providers: ProviderSeries[] = [];
  for (const [key, s] of byKey) {
    const dayMap = perDay.get(key)!;
    s.points = [...dayMap.entries()]
      .map(([day, costUsd]) => ({ day, costUsd }))
      .sort((a, b) => a.day.localeCompare(b.day));
    s.mtdUsd = sumMonth(s.points, month);
    const n = s.points.length;
    if (s.metric === "spent" && n >= 2) {
      const last = s.points[n - 1].costUsd ?? 0;
      const prior = s.points[n - 2].costUsd ?? 0;
      s.deltaUsd = last - prior;
    }
    providers.push(s);
  }
  providers.sort((a, b) => b.mtdUsd - a.mtdUsd);

  const totalSpentMtdUsd = providers
    .filter((p) => p.metric === "spent")
    .reduce((sum, p) => sum + p.mtdUsd, 0);

  return { month, totalSpentMtdUsd, providers };
}

// ---------------------------------------------------------------------------
// Threshold alerts
// ---------------------------------------------------------------------------

/** Config key holding a provider's monthly USD budget. */
export function providerBudgetKey(provider: Provider): string {
  return `provider_budget_${provider}_usd`;
}

/** File the frontend notification for a provider spend breach (never throws). */
async function notify(env: Env, provider: Provider, title: string, body: string): Promise<void> {
  try {
    const ns = env.NOTIFICATIONS_AGENT as unknown as DurableObjectNamespace<NotificationsAgent>;
    const feed = await getAgentByName(ns, "global");
    await feed.add({
      type: "warning",
      title,
      body,
      severity: "warning",
      actor: "guardian.providers",
      entityType: "provider_cost",
      entityId: provider,
      href: "/api/guardian/providers/report",
    });
  } catch (err) {
    console.error(
      JSON.stringify({ level: "ERROR", source: "guardian.providers.notify", error: String(err) }),
    );
  }
}

export type ProviderAlertResult = { provider: Provider; mtdUsd: number; budgetUsd: number; fired: boolean }[];

/**
 * For each provider with a configured monthly budget, warn ONCE per month when
 * spent MTD crosses it. Dedupe flag lives in KV (`SESSIONS`) keyed by
 * provider+month, so the hourly cron doesn't re-fire.
 */
export async function checkProviderSpendAlerts(env: Env): Promise<ProviderAlertResult> {
  const report = await getProviderCostReport(env, 35);
  const spentByProvider = new Map(
    report.providers.filter((p) => p.metric === "spent").map((p) => [p.provider, p.mtdUsd]),
  );
  const month = report.month;
  const out: ProviderAlertResult = [];

  for (const provider of PROVIDERS) {
    const budgetUsd = await readConfigNumber(env, providerBudgetKey(provider), null);
    if (budgetUsd == null || budgetUsd <= 0) continue;
    const mtdUsd = spentByProvider.get(provider) ?? 0;
    const over = mtdUsd >= budgetUsd;
    if (!over) {
      out.push({ provider, mtdUsd, budgetUsd, fired: false });
      continue;
    }
    const flagKey = `provider-alert:${provider}:${month}`;
    const already = await env.SESSIONS.get(flagKey).catch(() => null);
    if (already) {
      out.push({ provider, mtdUsd, budgetUsd, fired: false });
      continue;
    }
    await notify(
      env,
      provider,
      `${provider} spend over budget`,
      `Month-to-date ${provider} spend $${mtdUsd.toFixed(2)} has reached the configured budget of $${budgetUsd}. External provider — no breaker; review usage directly.`,
    );
    // Flag expires after ~40 days so next month re-arms.
    await env.SESSIONS.put(flagKey, String(Date.now()), { expirationTtl: 40 * 24 * 3600 }).catch(() => {});
    out.push({ provider, mtdUsd, budgetUsd, fired: true });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Self-check — pure grouping/threshold logic. Never runs in the Worker.
// ---------------------------------------------------------------------------
if (import.meta.main) {
  const assert = (cond: boolean, m: string) => {
    if (!cond) throw new Error(m);
  };
  assert(providerBudgetKey("openai") === "provider_budget_openai_usd", "budget key");
  assert(ymd(Date.UTC(2026, 7, 6)) === "2026-08-06", `ymd: ${ymd(Date.UTC(2026, 7, 6))}`);
  assert(dayStartMs("2026-08-06") === Date.UTC(2026, 7, 6), "dayStartMs round-trips");
  // eslint-disable-next-line no-console
  console.log("ok — provider sync helpers verified");
}
