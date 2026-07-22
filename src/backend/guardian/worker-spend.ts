/**
 * @fileoverview Per-worker spend monitor — one worker's Cloudflare usage plus
 * its AI-provider spend (when it routes through a same-named AI Gateway).
 *
 * Two independent signals over a window:
 *  - Cloudflare compute: requests, errors, subrequests, CPU-time quantiles from
 *    `workersInvocationsAdaptive` filtered to the script.
 *  - AI provider cost: real upstream USD + tokens from
 *    `aiGatewayRequestsAdaptiveGroups` filtered to the gateway, broken down by
 *    provider/model. This is $0 until the worker actually routes its AI calls
 *    through that gateway — the one honest way to see provider billing on the
 *    Cloudflare side (otherwise it lives only on the provider's own dashboard).
 *
 * First consumer: `codra` (the core-codra code-review worker that replaces the
 * deprecated Gemini Code Assist) — worker + gateway are both named `codra`.
 *
 * @see {@link file://src/backend/lib/cloudflare-graphql.ts} for queryAccountAnalytics.
 */

import { queryAccountAnalytics } from "@/backend/lib/cloudflare-graphql";

export type WorkerSpend = {
  worker: string;
  gateway: string;
  windowHours: number;
  cloudflare: {
    requests: number;
    errors: number;
    subrequests: number;
    cpuTimeP50Us: number | null;
    cpuTimeP99Us: number | null;
  };
  ai: {
    routed: boolean;
    upstreamCostUsd: number;
    requests: number;
    tokensIn: number;
    tokensOut: number;
    byModel: { provider: string; model: string; costUsd: number; tokensIn: number; tokensOut: number }[];
  };
};

const QUERY = `query WorkerSpend($accountTag: string!, $start: Time!, $end: Time!, $startHour: Time!, $endHour: Time!, $script: string!, $gateway: string!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      worker: workersInvocationsAdaptive(
        limit: 5
        filter: { scriptName: $script, datetime_geq: $start, datetime_leq: $end }
      ) {
        sum { requests errors subrequests }
        quantiles { cpuTimeP50 cpuTimeP99 }
        dimensions { scriptName }
      }
      gateway: aiGatewayRequestsAdaptiveGroups(
        limit: 100
        filter: { gateway: $gateway, datetimeHour_geq: $startHour, datetimeHour_leq: $endHour }
      ) {
        count
        sum { cost uncachedTokensIn uncachedTokensOut }
        dimensions { provider model }
      }
    }
  }
}`;

type WorkerRow = {
  sum: { requests: number; errors: number; subrequests: number };
  quantiles?: { cpuTimeP50?: number; cpuTimeP99?: number };
};
type GatewayRow = {
  count: number;
  sum: { cost: number; uncachedTokensIn: number; uncachedTokensOut: number };
  dimensions: { provider: string; model: string };
};

/**
 * @param workerName - the Worker script id (e.g. "codra")
 * @param gatewayName - the AI Gateway to attribute AI spend to (defaults to the
 *   worker name, matching the codra convention)
 * @param hours - lookback window (GraphQL retains 31 days)
 */
export async function getWorkerSpend(
  env: Env,
  workerName: string,
  gatewayName = workerName,
  hours = 720,
): Promise<WorkerSpend> {
  const end = new Date();
  const start = new Date(end.getTime() - hours * 3_600_000);
  start.setUTCMinutes(0, 0, 0);
  end.setUTCMinutes(0, 0, 0);
  const iso = (d: Date) => d.toISOString();

  const account = await queryAccountAnalytics<{ worker: WorkerRow[]; gateway: GatewayRow[] }>(env, QUERY, {
    start: iso(start),
    end: iso(end),
    startHour: iso(start),
    endHour: iso(end),
    script: workerName,
    gateway: gatewayName,
  });

  const w = account.worker?.[0];
  const gw = account.gateway ?? [];
  const cost = gw.reduce((s, r) => s + (r.sum.cost ?? 0), 0);

  return {
    worker: workerName,
    gateway: gatewayName,
    windowHours: hours,
    cloudflare: {
      requests: w?.sum.requests ?? 0,
      errors: w?.sum.errors ?? 0,
      subrequests: w?.sum.subrequests ?? 0,
      cpuTimeP50Us: w?.quantiles?.cpuTimeP50 ?? null,
      cpuTimeP99Us: w?.quantiles?.cpuTimeP99 ?? null,
    },
    ai: {
      routed: gw.length > 0,
      upstreamCostUsd: cost,
      requests: gw.reduce((s, r) => s + (r.count ?? 0), 0),
      tokensIn: gw.reduce((s, r) => s + (r.sum.uncachedTokensIn ?? 0), 0),
      tokensOut: gw.reduce((s, r) => s + (r.sum.uncachedTokensOut ?? 0), 0),
      byModel: gw
        .map((r) => ({
          provider: r.dimensions.provider,
          model: r.dimensions.model,
          costUsd: r.sum.cost ?? 0,
          tokensIn: r.sum.uncachedTokensIn ?? 0,
          tokensOut: r.sum.uncachedTokensOut ?? 0,
        }))
        .sort((a, b) => b.costUsd - a.costUsd),
    },
  };
}
