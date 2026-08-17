/**
 * @fileoverview One-time historic backfill of `billable_usage`.
 *
 * The daily cron only syncs a trailing 35-day window, so deltas ("since last
 * login") would be shallow on a fresh install. This pulls the fuller retention
 * window in <=31-day chunks (the Billable Usage API serves ~90 days), reusing
 * the existing fetch+upsert path — no duplicated mapping. Runs once, guarded by
 * a KV flag on the cron.
 */

import { syncBillableUsageWindow } from "./billable-usage";

const DAY = 86_400_000;

function ymd(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** Contiguous <=chunkDays windows covering [now-retentionDays, now], oldest first (UTC, YYYY-MM-DD). */
export function maxBackfillWindows(
  now: number,
  retentionDays = 90,
  chunkDays = 31,
): { from: string; to: string }[] {
  const start = now - retentionDays * DAY;
  const out: { from: string; to: string }[] = [];
  for (let cursor = start; cursor < now; cursor += chunkDays * DAY) {
    const to = Math.min(cursor + chunkDays * DAY, now);
    out.push({ from: ymd(cursor), to: ymd(to) });
  }
  return out;
}

/**
 * Pull every historic window and upsert via the shared path.
 *
 * @returns `{ chunks, rows, failures }` — `failures` counts windows that errored
 *   (rate-limit, scope). The caller must NOT mark the backfill done while
 *   `failures > 0`, or missing history is never retried.
 */
export async function backfillBillableUsage(
  env: Env,
): Promise<{ chunks: number; rows: number; failures: number }> {
  const windows = maxBackfillWindows(Date.now());
  let rows = 0;
  let failures = 0;
  for (const w of windows) {
    try {
      rows += await syncBillableUsageWindow(env, w.from, w.to);
    } catch {
      failures++;
    }
  }
  return { chunks: windows.length, rows, failures };
}
