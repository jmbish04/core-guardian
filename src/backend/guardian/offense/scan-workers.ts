/**
 * @fileoverview `scanWorkers` — the P2 zero-AI Cloudflare Worker scanner.
 *
 * Enumerates every Worker on the account, reads each one's cron triggers and
 * bindings, samples its invocation frequency, and scores its billable-risk with
 * the deterministic classifier. It then cross-checks each AI-using worker against
 * what core-guardian has actually logged: a worker that wields Workers AI but has
 * no rows in `ai_router_requests` / `ai_usage_registrations` is spending on AI
 * behind guardian's back — a **bypass**.
 *
 * NO AI is used anywhere in this file. Pure Cloudflare REST + GraphQL analytics +
 * arithmetic. Results are upserted into `scan_targets` (one row per worker,
 * keyed by name; re-scans preserve `first_seen`).
 *
 * @see {@link file://src/backend/guardian/offense/classify.ts} for the scorer.
 * @see {@link file://src/backend/guardian/resources.ts} for cfApi.
 * @see {@link file://src/backend/guardian/worker-spend.ts} for the analytics probe mirror.
 */

import { getDb } from "@/backend/db";
import {
  aiRouterRequests,
  aiUsageRegistrations,
  scanTargets,
  type BypassVerdict,
  type NewScanTargetRow,
  type RiskSignals,
} from "@/backend/db/schema";
import { cfApi, listWorkerScriptIds } from "@/backend/guardian/resources";
import { getWorkerSpend } from "@/backend/guardian/worker-spend";
import {
  classifyBindings,
  isScraping,
  scoreRisk,
  type WorkerBinding,
} from "@/backend/guardian/offense/classify";

/** Lookback window (hours) for the invocation-frequency sample. */
const FREQUENCY_WINDOW_HOURS = 168; // 7 days
/** Max concurrent per-worker probes (bindings + schedules + analytics). */
const FANOUT = 8;

/** One scanned worker, ready to upsert. */
type ScannedWorker = {
  name: string;
  cronSchedules: string[];
  signals: RiskSignals;
  riskScore: number;
  guardianRegistered: boolean;
  bypass: BypassVerdict;
};

/** Summary returned by {@link scanWorkers} and surfaced on `POST /scan`. */
export interface ScanSummary {
  scanned: number;
  upserted: number;
  aiWorkers: number;
  cronWorkers: number;
  bypasses: number;
  scannedAt: number;
  topRisk: {
    name: string;
    riskScore: number;
    guardianRegistered: boolean;
    isBypass: boolean;
    cronSchedules: string[];
    signals: RiskSignals;
  }[];
}

/** Bounded-concurrency map (mirrors resources.ts). */
async function mapLimit<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await work(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Builds the set of names core-guardian has already seen AI usage for.
 *
 * Two sources: `ai_router_requests.project` (calls routed through the AI Router)
 * and `ai_usage_registrations.worker` (manually-registered bypass-of-gateway
 * usage). Names are lowercased for case-insensitive matching against script ids.
 */
async function loadRegisteredNames(db: ReturnType<typeof getDb>): Promise<Set<string>> {
  const [projects, workers] = await Promise.all([
    db.selectDistinct({ name: aiRouterRequests.project }).from(aiRouterRequests),
    db.selectDistinct({ name: aiUsageRegistrations.worker }).from(aiUsageRegistrations),
  ]);
  const set = new Set<string>();
  for (const r of [...projects, ...workers]) {
    if (r.name) set.add(r.name.toLowerCase());
  }
  return set;
}

/** Reads a worker's cron trigger expressions (empty when it has none). */
async function readCron(env: Env, scriptId: string): Promise<string[]> {
  const { result } = await cfApi<{ schedules?: { cron?: string }[] }>(
    env,
    `/workers/scripts/${encodeURIComponent(scriptId)}/schedules`,
  );
  return (result?.schedules ?? [])
    .map((s) => s.cron)
    .filter((c): c is string => typeof c === "string" && c.length > 0);
}

/** Reads a worker's bindings (empty on any per-script read failure). */
async function readBindings(env: Env, scriptId: string): Promise<WorkerBinding[]> {
  const { result } = await cfApi<WorkerBinding[]>(
    env,
    `/workers/scripts/${encodeURIComponent(scriptId)}/bindings`,
  );
  return result ?? [];
}

/**
 * Scans one worker: cron + bindings + (conditionally) invocation frequency,
 * then classify, score, and decide bypass.
 *
 * Analytics is only sampled for workers that carry a cron trigger or a Workers
 * AI binding. ponytail: this bounds the GraphQL fan-out to the workers that can
 * actually cause AI spend — lift the gate if idle workers need frequency too.
 */
async function scanOne(
  env: Env,
  scriptId: string,
  registered: Set<string>,
): Promise<ScannedWorker> {
  const [cronSchedules, bindings] = await Promise.all([
    readCron(env, scriptId),
    readBindings(env, scriptId),
  ]);

  const bindingSignals = classifyBindings(bindings);
  const hasCron = cronSchedules.length > 0;

  let requests = 0;
  let subrequests = 0;
  if (hasCron || bindingSignals.ai) {
    try {
      const spend = await getWorkerSpend(env, scriptId, scriptId, FREQUENCY_WINDOW_HOURS);
      requests = spend.cloudflare.requests;
      subrequests = spend.cloudflare.subrequests;
    } catch {
      // Analytics unavailable for this script — treat as zero frequency, never
      // fabricate a number.
    }
  }
  const invocationsPerDay = requests / (FREQUENCY_WINDOW_HOURS / 24);

  const signals: RiskSignals = {
    ...bindingSignals,
    cron: hasCron,
    scraping: isScraping(bindingSignals.browser, requests, subrequests),
  };

  const riskScore = scoreRisk({ signals, cronExprs: cronSchedules, invocationsPerDay });
  const guardianRegistered = registered.has(scriptId.toLowerCase());

  // Bypass: uses AI but core-guardian has never logged usage for it.
  const bypass: BypassVerdict =
    signals.ai && !guardianRegistered
      ? {
          isBypass: true,
          why: `Worker "${scriptId}" binds Workers AI but has no rows in ai_router_requests/ai_usage_registrations — AI spend is not reported through core-guardian.`,
        }
      : { isBypass: false, why: "" };

  return { name: scriptId, cronSchedules, signals, riskScore, guardianRegistered, bypass };
}

/**
 * Enumerates and scores every Cloudflare Worker, upserts `scan_targets`, and
 * returns a summary (counts + top-risk list).
 *
 * @param env - Worker env carrying the Secrets Store CF credentials + `DB`
 */
export async function scanWorkers(env: Env): Promise<ScanSummary> {
  const db = getDb(env);
  const [{ ids: scriptIds }, registered] = await Promise.all([
    listWorkerScriptIds(env),
    loadRegisteredNames(db),
  ]);

  const scanned = await mapLimit(scriptIds, FANOUT, async (scriptId) => {
    try {
      return await scanOne(env, scriptId, registered);
    } catch {
      // A single unreadable script must not sink the whole scan.
      return null;
    }
  });
  const workers = scanned.filter((w): w is ScannedWorker => w !== null);

  const now = Date.now();
  let upserted = 0;
  for (const w of workers) {
    const row: NewScanTargetRow = {
      id: crypto.randomUUID(),
      kind: "worker",
      name: w.name,
      workerName: w.name,
      cronSchedules: w.cronSchedules,
      riskSignals: w.signals,
      riskScore: w.riskScore,
      guardianRegistered: w.guardianRegistered,
      bypass: w.bypass,
      firstSeen: now,
      lastScan: now,
    };
    // Upsert by (kind,name): refresh the risk profile + last_scan, keep first_seen.
    await db
      .insert(scanTargets)
      .values(row)
      .onConflictDoUpdate({
        target: [scanTargets.kind, scanTargets.name],
        set: {
          workerName: row.workerName,
          cronSchedules: row.cronSchedules,
          riskSignals: row.riskSignals,
          riskScore: row.riskScore,
          guardianRegistered: row.guardianRegistered,
          bypass: row.bypass,
          lastScan: now,
        },
      });
    upserted++;
  }

  const topRisk = [...workers]
    .sort((a, b) => b.riskScore - a.riskScore)
    .slice(0, 10)
    .map((w) => ({
      name: w.name,
      riskScore: w.riskScore,
      guardianRegistered: w.guardianRegistered,
      isBypass: w.bypass.isBypass,
      cronSchedules: w.cronSchedules,
      signals: w.signals,
    }));

  return {
    scanned: workers.length,
    upserted,
    aiWorkers: workers.filter((w) => w.signals.ai).length,
    cronWorkers: workers.filter((w) => w.signals.cron).length,
    bypasses: workers.filter((w) => w.bypass.isBypass).length,
    scannedAt: now,
    topRisk,
  };
}
