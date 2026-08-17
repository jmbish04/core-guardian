/**
 * @fileoverview Client + rollup for Cloudflare's Billable Usage API.
 *
 * The Billable Usage API (launched Agents Week 2026) is the first Cloudflare
 * surface that returns *actual charged cost* per product — everything else in
 * Guardian estimates cost from usage. This module:
 *
 *  1. `fetchBillableUsage` — one REST GET to the account's `/billable-usage`
 *     endpoint, returning the raw charge rows for a date window.
 *  2. `syncBillableUsage` — fetch + idempotent upsert into `billable_usage`,
 *     so history survives past whatever window the API serves.
 *  3. `getBillableUsageReport` — read it back as per-service billed series with
 *     a day-over-day delta, PLUS a reconciliation against the reconstructed
 *     `daily_cost` estimate: how close Guardian's estimate is to the real bill.
 *
 * Auth reuses the same Secrets Store credentials as the GraphQL probes
 * (`CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_WRANGLER_API_TOKEN`). The token must
 * additionally carry the **Billing: Read** permission; without it the API
 * returns 403 and the sync fails loudly rather than writing fabricated numbers.
 * The report reads only what sync persisted, so a scope gap shows as no new
 * data, never as a wrong figure.
 *
 * @see https://blog.cloudflare.com/billable-usage-api/
 * @see {@link file://src/backend/db/schemas/governance/billable-usage.ts}
 */

import { and, gte, sql } from "drizzle-orm";

import type { NewBillableUsageRow } from "@/backend/db/schema";

import { getDb } from "@/backend/db";
import { billableUsage, dailyCost } from "@/backend/db/schema";
import { getCloudflareAccountId, getCloudflareApiToken } from "@/backend/utils/secrets";

const API_BASE = "https://api.cloudflare.com/client/v4";
const DAY_MS = 86_400_000;

/** Thrown when the Billable Usage endpoint rejects the request. */
export class BillableUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillableUsageError";
  }
}

/** One raw charge row as returned by the API (documented fields; optional-safe). */
type ApiRow = {
  BillingCurrency?: string;
  BillingPeriodStart?: string;
  ChargePeriodStart?: string;
  ChargePeriodEnd?: string;
  ServiceName?: string;
  ServiceFamilyName?: string;
  ConsumedQuantity?: number | string;
  ConsumedUnit?: string;
  PricingQuantity?: number | string;
  ContractedCost?: number | string;
  ZoneId?: string;
  ZoneName?: string;
};

/** `YYYY-MM-DD` in UTC for a Date/ms. */
function ymd(at: number | Date): string {
  const d = typeof at === "number" ? new Date(at) : at;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function num(v: number | string | undefined): number {
  const n = typeof v === "string" ? Number(v) : (v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Fetch raw billable-usage rows for a date window (inclusive, YYYY-MM-DD).
 * With no `from`/`to` the API serves its own default window. Never invents data
 * — throws on any non-success envelope so the caller can surface the real
 * failure (`syncBillableUsage` is the caller that pins an explicit window).
 */
export async function fetchBillableUsage(env: Env, from?: string, to?: string): Promise<ApiRow[]> {
  const [accountId, token] = await Promise.all([
    getCloudflareAccountId(env),
    getCloudflareApiToken(env),
  ]);
  if (!accountId || !token) {
    throw new BillableUsageError(
      "Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_WRANGLER_API_TOKEN in the Secrets Store.",
    );
  }

  const url = new URL(`${API_BASE}/accounts/${accountId}/billable-usage`);
  if (from) url.searchParams.set("from", from);
  if (to) url.searchParams.set("to", to);

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const body = (await res.json().catch(() => null)) as {
    result?: ApiRow[];
    success?: boolean;
    errors?: { message: string }[];
  } | null;

  if (!res.ok || !body?.success) {
    const detail = body?.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`;
    // 403 here almost always means the token lacks the "Billing: Read" scope.
    throw new BillableUsageError(`Billable Usage API failed: ${detail}`);
  }
  return body.result ?? [];
}

/** Map an API row to a deterministic table row, or null if it lacks a period. */
function toRow(r: ApiRow, capturedAt: number): NewBillableUsageRow | null {
  const start = r.ChargePeriodStart;
  const service = r.ServiceName;
  if (!start || !service) return null;
  const startMs = Date.parse(start);
  if (Number.isNaN(startMs)) return null;
  const zoneId = r.ZoneId ?? "";
  const day = ymd(startMs);
  return {
    id: `${start}:${service}:${zoneId}`,
    day,
    dayStart: Date.UTC(
      new Date(startMs).getUTCFullYear(),
      new Date(startMs).getUTCMonth(),
      new Date(startMs).getUTCDate(),
    ),
    chargePeriodStart: start,
    chargePeriodEnd: r.ChargePeriodEnd ?? "",
    billingPeriodStart: r.BillingPeriodStart ?? "",
    serviceName: service,
    serviceFamily: r.ServiceFamilyName ?? "",
    consumedQuantity: num(r.ConsumedQuantity),
    consumedUnit: r.ConsumedUnit ?? "",
    pricingQuantity: num(r.PricingQuantity),
    contractedCost: num(r.ContractedCost),
    currency: r.BillingCurrency ?? "USD",
    zoneId,
    zoneName: r.ZoneName ?? "",
    capturedAt,
  };
}

/**
 * Fetch the trailing `days` of billable usage and upsert into `billable_usage`.
 * Idempotent (deterministic PK), so safe to run daily on the cron.
 *
 * @returns number of rows written
 */
export async function syncBillableUsage(env: Env, days = 35): Promise<number> {
  return syncBillableUsageWindow(env, ymd(Date.now() - days * DAY_MS), ymd(Date.now()));
}

/**
 * Fetch + upsert an explicit `[from, to]` window (YYYY-MM-DD). Shared by the
 * trailing-window daily sync and the one-time historic backfill. Idempotent.
 *
 * @returns number of rows written
 */
export async function syncBillableUsageWindow(
  env: Env,
  from: string,
  to: string,
): Promise<number> {
  const raw = await fetchBillableUsage(env, from, to);
  const now = Date.now();
  const rows = raw.map((r) => toRow(r, now)).filter((r): r is NewBillableUsageRow => r !== null);
  const db = getDb(env);
  for (const r of rows) {
    await db
      .insert(billableUsage)
      .values(r)
      .onConflictDoUpdate({
        target: billableUsage.id,
        set: {
          chargePeriodEnd: r.chargePeriodEnd,
          consumedQuantity: r.consumedQuantity,
          pricingQuantity: r.pricingQuantity,
          contractedCost: r.contractedCost,
          currency: r.currency,
          capturedAt: now,
        },
      });
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export type BillableServiceSeries = {
  service: string;
  family: string;
  unit: string;
  points: { day: string; quantity: number; costUsd: number }[];
  deltaUsd: number | null;
  totalUsd: number;
};

/** Per-day estimate-vs-actual reconciliation (the estimate-accuracy signal). */
export type ReconcileDay = {
  day: string;
  estimateUsd: number;
  actualUsd: number;
  deltaUsd: number;
  /** 1 − |delta|/actual, clamped to [0,1]; null when actual is 0. */
  accuracy: number | null;
};

export type BillableUsageReport = {
  currency: string;
  days: string[];
  services: BillableServiceSeries[];
  totalByDay: { day: string; costUsd: number }[];
  totalActualUsd: number;
  totalDeltaUsd: number | null;
  reconcile: ReconcileDay[];
  /** Overall estimate accuracy over the window (1 − |Σest−Σact|/Σact). */
  windowAccuracy: number | null;
};

/**
 * Read `billable_usage` back as per-service billed series and reconcile the
 * daily totals against the reconstructed `daily_cost` estimate.
 *
 * @param days - trailing window size (default 30)
 */
export async function getBillableUsageReport(env: Env, days = 30): Promise<BillableUsageReport> {
  const db = getDb(env);
  const cutoff = Date.UTC(
    new Date(Date.now() - (days - 1) * DAY_MS).getUTCFullYear(),
    new Date(Date.now() - (days - 1) * DAY_MS).getUTCMonth(),
    new Date(Date.now() - (days - 1) * DAY_MS).getUTCDate(),
  );

  const rows = await db
    .select()
    .from(billableUsage)
    .where(gte(billableUsage.dayStart, cutoff))
    .orderBy(billableUsage.dayStart);

  const dayList = [...new Set(rows.map((r) => r.day))].sort();
  const currency = rows.find((r) => r.currency)?.currency ?? "USD";

  // Per-service series (sum across zones for the same service/day).
  const byService = new Map<string, BillableServiceSeries>();
  const perServiceDay = new Map<string, Map<string, { quantity: number; costUsd: number }>>();
  for (const r of rows) {
    let s = byService.get(r.serviceName);
    if (!s) {
      s = { service: r.serviceName, family: r.serviceFamily, unit: r.consumedUnit, points: [], deltaUsd: null, totalUsd: 0 };
      byService.set(r.serviceName, s);
      perServiceDay.set(r.serviceName, new Map());
    }
    const dayMap = perServiceDay.get(r.serviceName)!;
    const acc = dayMap.get(r.day) ?? { quantity: 0, costUsd: 0 };
    acc.quantity += r.consumedQuantity;
    acc.costUsd += r.contractedCost;
    dayMap.set(r.day, acc);
  }
  for (const [service, s] of byService) {
    const dayMap = perServiceDay.get(service)!;
    s.points = [...dayMap.entries()]
      .map(([day, v]) => ({ day, quantity: v.quantity, costUsd: v.costUsd }))
      .sort((a, b) => a.day.localeCompare(b.day));
    s.totalUsd = s.points.reduce((sum, p) => sum + p.costUsd, 0);
    const n = s.points.length;
    if (n >= 2) s.deltaUsd = s.points[n - 1].costUsd - s.points[n - 2].costUsd;
  }
  const services = [...byService.values()].sort((a, b) => b.totalUsd - a.totalUsd);

  // Actual billed total per day.
  const actualByDay = new Map<string, number>();
  for (const r of rows) actualByDay.set(r.day, (actualByDay.get(r.day) ?? 0) + r.contractedCost);
  const totalByDay = dayList.map((day) => ({ day, costUsd: actualByDay.get(day) ?? 0 }));
  const totalActualUsd = totalByDay.reduce((sum, d) => sum + d.costUsd, 0);
  const totalDeltaUsd =
    totalByDay.length >= 2
      ? totalByDay[totalByDay.length - 1].costUsd - totalByDay[totalByDay.length - 2].costUsd
      : null;

  // Reconstructed estimate total per day (daily_cost headline rows).
  // ponytail: reconcile at the day-total level only — per-service would need a
  // probe-id ↔ Cloudflare-ServiceName map; add that map if per-line drift matters.
  const estRows = await db
    .select({ day: dailyCost.day, cost: sql<number>`sum(${dailyCost.costUsd})` })
    .from(dailyCost)
    .where(and(gte(dailyCost.dayStart, cutoff), sql`${dailyCost.dimension} = ''`))
    .groupBy(dailyCost.day);
  const estByDay = new Map(estRows.map((e) => [e.day, e.cost ?? 0]));

  const reconcile: ReconcileDay[] = dayList.map((day) => {
    const estimateUsd = estByDay.get(day) ?? 0;
    const actualUsd = actualByDay.get(day) ?? 0;
    const deltaUsd = estimateUsd - actualUsd;
    return {
      day,
      estimateUsd,
      actualUsd,
      deltaUsd,
      accuracy: actualUsd > 0 ? Math.max(0, 1 - Math.abs(deltaUsd) / actualUsd) : null,
    };
  });

  const totalEst = reconcile.reduce((sum, d) => sum + d.estimateUsd, 0);
  const windowAccuracy =
    totalActualUsd > 0 ? Math.max(0, 1 - Math.abs(totalEst - totalActualUsd) / totalActualUsd) : null;

  return {
    currency,
    days: dayList,
    services,
    totalByDay,
    totalActualUsd,
    totalDeltaUsd,
    reconcile,
    windowAccuracy,
  };
}

// ---------------------------------------------------------------------------
// Self-check — pure mapping/reconciliation logic. Never runs in the Worker.
// ---------------------------------------------------------------------------
if (import.meta.main) {
  const assert = (cond: boolean, m: string) => {
    if (!cond) throw new Error(m);
  };
  // A row with a real charge period maps and buckets to the right UTC day.
  const r = toRow(
    {
      ChargePeriodStart: "2026-08-06T00:00:00Z",
      ServiceName: "Workers Paid",
      ContractedCost: "5.5",
      ConsumedQuantity: 1000,
      ConsumedUnit: "requests",
    },
    1,
  );
  assert(r !== null, "row should map");
  assert(r!.day === "2026-08-06", `day: ${r!.day}`);
  assert(r!.contractedCost === 5.5, "string cost parsed");
  assert(r!.id === "2026-08-06T00:00:00Z:Workers Paid:", "deterministic id");
  // Rows without a period or service are dropped (never guessed).
  assert(toRow({ ServiceName: "X" }, 1) === null, "no period → null");
  assert(toRow({ ChargePeriodStart: "2026-08-06T00:00:00Z" }, 1) === null, "no service → null");
  // eslint-disable-next-line no-console
  console.log("ok — billable-usage mapping verified");
}
